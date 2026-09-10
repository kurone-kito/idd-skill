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

function acquireMarkerBody(
  bodySha256: string,
  overrides: Record<string, string> = {},
): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target: TARGET,
    anchor: TARGET,
    mode: 'acquire',
    owner: 'owner-token-1',
    set: 'set-1',
    session: 'session-1',
    bodySha256,
    snapshotSha256: 'none',
    supersedes: 'none',
    ...overrides,
  });
}

function heartbeatMarkerBody(
  bodySha256: string,
  overrides: Record<string, string> = {},
): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target: TARGET,
    anchor: TARGET,
    mode: 'heartbeat',
    owner: 'owner-token-1',
    set: 'set-1',
    session: 'session-1',
    bodySha256,
    snapshotSha256: 'none',
    supersedes: 'owner-token-1',
    ...overrides,
  });
}

test('unchanged body with a matching acquire-time hash reports pass', () => {
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
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
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(acquireTimeBody)),
        createdAt: '2026-09-10T16:48:44Z',
      },
      {
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

test('multiple acquire generations (re-acquisition) pick the most recent', () => {
  const firstGenerationBody = '# Draft\n\nFirst generation.\n';
  const secondGenerationBody = '# Draft\n\nSecond generation, re-acquired.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: secondGenerationBody,
    comments: [
      {
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(firstGenerationBody), {
          owner: 'owner-token-1',
        }),
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
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
