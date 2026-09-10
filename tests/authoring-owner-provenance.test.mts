import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { evaluateAuthoringOwnerProvenance } from '../src/scripts/authoring-owner-provenance.mts';
import { renderAuthoringOwnerMarker } from '../src/scripts/marker-helpers.mts';

const TARGET = 'kurone-kito/idd-skill#2891';
const MARKER_PREFIX = 'idd-skill';
const TRUSTED_LOGINS = ['kurone-kito'];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function ownerMarkerBody(
  mode: string,
  fields: {
    owner: string;
    bodySha256?: string;
    snapshotSha256?: string;
    supersedes?: string;
  },
): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target: TARGET,
    anchor: TARGET,
    mode,
    owner: fields.owner,
    set: 'set-1',
    session: 'session-1',
    bodySha256: fields.bodySha256 ?? 'none',
    snapshotSha256: fields.snapshotSha256 ?? 'none',
    supersedes: fields.supersedes ?? 'none',
  });
}

function acquireMarkerBody(
  bodySha256: string,
  overrides: { owner?: string } = {},
): string {
  return ownerMarkerBody('acquire', {
    owner: overrides.owner ?? 'owner-token-1',
    bodySha256,
    supersedes: 'none',
  });
}

function heartbeatMarkerBody(
  bodySha256: string,
  overrides: { owner?: string } = {},
): string {
  const owner = overrides.owner ?? 'owner-token-1';
  return ownerMarkerBody('heartbeat', {
    owner,
    bodySha256,
    supersedes: owner,
  });
}

test('unchanged body with a matching acquire-time hash reports pass', () => {
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody)),
        createdAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.computedBodySha256, sha256(liveBody));
  assert.equal(result.recordedBodySha256, sha256(liveBody));
  assert.ok(result.marker);
  assert.equal(
    result.checks.find((check) => check.id === 'body_sha256_match')?.result,
    'pass',
  );
});

test('a body edited after acquire fails closed with mismatch', () => {
  const acquireTimeBody = '# Draft\n\nOriginal content.\n';
  const editedLiveBody = '# Draft\n\nEdited content after acquire.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: editedLiveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(acquireTimeBody)),
        createdAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.computedBodySha256, sha256(editedLiveBody));
  assert.equal(result.recordedBodySha256, sha256(acquireTimeBody));
  assert.notEqual(result.computedBodySha256, result.recordedBodySha256);
});

test('no acquire marker for the target reports not-found, never pass', () => {
  const liveBody = 'plain issue body with no authoring marker at all';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: 'unrelated comment',
        createdAt: '2026-09-10T16:00:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.recordedBodySha256, null);
  assert.equal(result.marker, null);
});

test('an untrusted actor acquire marker is ignored, falling through to not-found', () => {
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'random-untrusted-user',
        body: acquireMarkerBody(sha256(liveBody)),
        createdAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
});

test('a later heartbeat marker never shadows the acquire marker digest', () => {
  // The realistic drift shape from this issue's own comment thread:
  // acquire -> release -> release-guard -> heartbeat -> release-complete,
  // all sharing one owner token. A heartbeat carries its own body-sha256
  // (re-hashed at heartbeat time) but must never substitute for the
  // acquire-time digest this comparison is specifically about.
  const acquireTimeBody = '# Draft\n\nOriginal content.\n';
  const laterBody = '# Draft\n\nContent as of the heartbeat.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: laterBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(acquireTimeBody)),
        createdAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: heartbeatMarkerBody(sha256(laterBody)),
        createdAt: '2026-09-10T17:07:59Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  // The heartbeat's digest (matching laterBody) must not be used -- only
  // the acquire marker's digest counts, so this must report mismatch
  // rather than pass.
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.recordedBodySha256, sha256(acquireTimeBody));
  assert.equal(result.marker?.session, 'session-1');
});

test('a legitimate re-acquisition after a full release cycle picks the new generation', () => {
  // A genuine second generation: the first generation is fully closed with
  // release -> release-guard -> release-complete before the second acquire
  // opens a new one (#2891 review, chatgpt-codex-connector: the prior
  // implementation picked the globally-last acquire regardless of whether
  // any generation ever closed in between).
  const firstGenerationBody = '# Draft\n\nFirst generation.\n';
  const secondGenerationBody = '# Draft\n\nSecond generation, re-acquired.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: secondGenerationBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(firstGenerationBody), {
          owner: 'owner-token-1',
        }),
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: ownerMarkerBody('release', {
          owner: 'owner-token-1',
          bodySha256: sha256(firstGenerationBody),
          supersedes: 'owner-token-1',
        }),
        createdAt: '2026-09-01T01:00:00Z',
      },
      {
        id: 3,
        authorLogin: 'kurone-kito',
        body: ownerMarkerBody('release-guard', {
          owner: 'owner-token-1',
          supersedes: 'owner-token-1',
        }),
        createdAt: '2026-09-01T01:00:05Z',
      },
      {
        id: 4,
        authorLogin: 'kurone-kito',
        body: ownerMarkerBody('release-complete', {
          owner: 'owner-token-1',
          snapshotSha256: sha256('snapshot-of-closed-set'),
          supersedes: 'owner-token-1',
        }),
        createdAt: '2026-09-01T01:00:10Z',
      },
      {
        id: 5,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(secondGenerationBody), {
          owner: 'owner-token-2',
        }),
        createdAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.marker?.owner, 'owner-token-2');
});

test('a same-generation acquire race resolves to the first acquire, never the last', () => {
  // The exact scenario chatgpt-codex-connector's PR #2901 review flagged:
  // two competing acquire markers post with no release-complete between
  // them (no generation ever closed), and the issue body is edited between
  // the two acquisitions so the SECOND (losing) acquire's digest happens to
  // match the live body. Picking "most recent" here would incorrectly
  // report pass and could authorize the auto-release exception against the
  // losing racer's edited-body snapshot; the protocol's own tie-break
  // (deterministic comment order) says the first acquire in an open
  // generation keeps ownership, so this must report mismatch against the
  // FIRST acquire's digest instead.
  const winningGenerationBody = '# Draft\n\nOriginal, before the edit.\n';
  const editedLiveBody = '# Draft\n\nEdited between the two acquisitions.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: editedLiveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(winningGenerationBody), {
          owner: 'owner-token-1',
        }),
        createdAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(editedLiveBody), {
          owner: 'owner-token-2',
        }),
        createdAt: '2026-09-10T16:49:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.marker?.owner, 'owner-token-1');
  assert.equal(result.recordedBodySha256, sha256(winningGenerationBody));
});
