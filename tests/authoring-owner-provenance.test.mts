import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateAuthoringOwnerProvenance } from '../src/scripts/authoring-owner-provenance.mts';
import { renderAuthoringOwnerMarker } from '../src/scripts/marker-helpers.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const TARGET = 'kurone-kito/idd-skill#2891';
const MARKER_PREFIX = 'idd-skill';
const TRUSTED_LOGINS = ['kurone-kito'];

// Stub `gh` on PATH (the tests/gh-exec.test.mts / ci-wait-policy.test.mts
// pattern) so the CLI tests below exercise the real execFileSync + child
// process contract -- including the comments-before-body fetch ordering
// and the provider/policy wiring -- without network access (#2901 review,
// Copilot round 6: the pure-function tests above never invoke the emitted
// CLI or its bin wrapper).
function stubGh(scriptBody: string): () => void {
  return stubExecutable('gh', scriptBody);
}

/** Build a stub `gh` script answering both calls `runCli` makes: `gh api
 * repos/<owner>/<repo>/issues/<n>/comments --paginate --jq .[]` (NDJSON,
 * one comment object per line) and `gh api repos/<owner>/<repo>/issues/<n>`
 * (a single JSON issue object). `process.argv.slice(2)` inside the stub is
 * `['api', <path>, ...]` (`stubExecutable`'s own documented contract).
 *
 * When `callLogPath` is given, each invocation appends its own `<path>`
 * argument as one line -- since the two calls are separate `gh` child
 * processes with no state shared between them (kurone-kito/idd-skill#2901
 * review, Copilot round 7: a stub that only branches on the current
 * call's own path proves nothing about which call the CLI made *first*,
 * so it cannot actually catch a regression that swaps the documented
 * comments-before-body fetch order). Reading this file back is what lets
 * a test assert the real call order the CLI made, not just that both
 * calls eventually happened. */
function ghStubScriptForIssue(
  issueBody: string,
  comments: readonly {
    id: number;
    user: { login: string };
    body: string;
    created_at: string;
    updated_at: string;
  }[],
  callLogPath?: string,
): string {
  return `
const path = process.argv[3];
${
  callLogPath
    ? `require('node:fs').appendFileSync(${JSON.stringify(callLogPath)}, path + '\\n');`
    : ''
}
if (path && path.endsWith('/comments')) {
  const comments = ${JSON.stringify(comments)};
  process.stdout.write(comments.map((c) => JSON.stringify(c)).join('\\n') + '\\n');
} else {
  process.stdout.write(JSON.stringify({
    number: 2891,
    title: 'CLI test issue',
    body: ${JSON.stringify(issueBody)},
    html_url: 'https://github.com/kurone-kito/idd-skill/issues/2891',
  }));
}
`;
}

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
    target?: string;
    anchor?: string;
  },
): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target: fields.target ?? TARGET,
    anchor: fields.anchor ?? TARGET,
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
  overrides: {
    owner?: string;
    target?: string;
    anchor?: string;
    supersedes?: string;
  } = {},
): string {
  return ownerMarkerBody('acquire', {
    owner: overrides.owner ?? 'owner-token-1',
    bodySha256,
    supersedes: overrides.supersedes ?? 'none',
    target: overrides.target,
    anchor: overrides.anchor,
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

function bootstrapMarkerBody(
  bodySha256: string,
  overrides: { owner?: string } = {},
): string {
  return ownerMarkerBody('bootstrap', {
    owner: overrides.owner ?? 'owner-token-1',
    bodySha256,
    supersedes: 'none',
  });
}

function resumeMarkerBody(
  bodySha256: string,
  overrides: { owner?: string; supersedes?: string } = {},
): string {
  return ownerMarkerBody('resume', {
    owner: overrides.owner ?? 'owner-token-1',
    bodySha256,
    supersedes: overrides.supersedes ?? 'prior-owner-token',
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
        updatedAt: '2026-09-10T16:48:44Z',
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
        updatedAt: '2026-09-10T16:48:44Z',
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
        updatedAt: '2026-09-10T16:00:00Z',
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
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
});

test('a later heartbeat marker never shadows the Stage 1 acquire marker digest', () => {
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
        updatedAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: heartbeatMarkerBody(sha256(laterBody)),
        createdAt: '2026-09-10T17:07:59Z',
        updatedAt: '2026-09-10T17:07:59Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  // The heartbeat's digest (matching laterBody) must not be used -- only
  // the Stage 1 acquire marker's digest counts, so this must report
  // mismatch rather than pass.
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.recordedBodySha256, sha256(acquireTimeBody));
  assert.equal(result.marker?.session, 'session-1');
});

test('a same-generation acquire race resolves to the first acquire, never the last', () => {
  // The exact scenario chatgpt-codex-connector's PR #2901 review flagged:
  // two competing acquire markers post with no release-complete between
  // them, and the issue body is edited between the two acquisitions so
  // the SECOND (losing) acquire's digest happens to match the live body.
  // Picking "most recent" here would incorrectly report pass and could
  // authorize the auto-release exception against the losing racer's
  // edited-body snapshot; the protocol's own tie-break (deterministic
  // comment order) says the first acquire wins, so this must report
  // mismatch against the FIRST acquire's digest instead.
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
        updatedAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(editedLiveBody), {
          owner: 'owner-token-2',
        }),
        createdAt: '2026-09-10T16:49:00Z',
        updatedAt: '2026-09-10T16:49:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.marker?.owner, 'owner-token-1');
  assert.equal(result.recordedBodySha256, sha256(winningGenerationBody));
});

test('a re-acquisition after a full release cycle still compares against the Stage 1 acquire, not the new one', () => {
  // The exact scenario kurone-kito/idd-skill#2901 review's fourth round
  // (chatgpt-codex-connector) flagged: acquire(A) -> release-complete ->
  // body edit -> acquire(B). B's own body-sha256 was hashed from the
  // EDITED body at B's own posting time, so comparing against B would
  // report pass regardless of the edit -- exactly the silent bypass the
  // provenance check exists to catch. contract.md's own wording ("that
  // same target's own mode=acquire owner marker's body-sha256 ...
  // already reflects the published body") and this issue's own
  // acceptance criteria name a single acquire marker, not "whichever
  // generation currently owns the target" -- so this must always
  // anchor on the target's first trusted acquire and report mismatch
  // here, never pass.
  const firstGenerationBody = '# Draft\n\nFirst generation, as published.\n';
  const secondGenerationBody =
    '# Draft\n\nEdited, then re-acquired as a new generation.\n';
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
        updatedAt: '2026-09-01T00:00:00Z',
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
        updatedAt: '2026-09-01T01:00:00Z',
      },
      {
        id: 3,
        authorLogin: 'kurone-kito',
        body: ownerMarkerBody('release-guard', {
          owner: 'owner-token-1',
          supersedes: 'owner-token-1',
        }),
        createdAt: '2026-09-01T01:00:05Z',
        updatedAt: '2026-09-01T01:00:05Z',
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
        updatedAt: '2026-09-01T01:00:10Z',
      },
      {
        id: 5,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(secondGenerationBody), {
          owner: 'owner-token-2',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.marker?.owner, 'owner-token-1');
  assert.equal(result.recordedBodySha256, sha256(firstGenerationBody));
});

test('a target whose trusted marker log opens with bootstrap, not acquire, reports not-found', () => {
  // Every mode other than acquire presupposes a prior acquire (bootstrap
  // recovers a stale hold, resume recovers an interrupted set, heartbeat
  // and release/release-complete all operate on an already-open
  // generation) -- a well-formed history never opens with one of them.
  // Fail closed (not-found) rather than accepting a non-acquire first
  // marker's own digest as if it were the Stage 1 acquire.
  const bootstrapBody = '# Draft\n\nRecovered via bootstrap.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: bootstrapBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: bootstrapMarkerBody(sha256(bootstrapBody), {
          owner: 'owner-token-bootstrap',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.equal(result.recordedBodySha256, null);
});

test('a target whose trusted marker log opens with resume, not acquire, reports not-found', () => {
  // Same reasoning as the bootstrap case, for an interrupted-set recovery.
  const resumeBody = '# Draft\n\nRecovered via resume.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody: resumeBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: resumeMarkerBody(sha256(resumeBody), {
          owner: 'owner-token-resume',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.equal(result.recordedBodySha256, null);
});

test('an acquire marker whose target differs only by capitalization still wins', () => {
  // GitHub owner/repo names are case-insensitive (PR #2901 review,
  // Copilot round 4): a marker's own `target` field may preserve
  // whatever casing an actor or URL happened to use, so the filter that
  // matches a marker's `target` against the CLI's own `owner/repo#n`
  // string must fold case rather than compare bytes -- a byte
  // comparison would drop this marker and fall through to `not-found`
  // even though it names the same issue.
  const liveBody = '# Draft\n\nSome content.\n';
  const differentlyCasedTarget = 'Kurone-Kito/IDD-Skill#2891';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), {
          target: differentlyCasedTarget,
          anchor: differentlyCasedTarget,
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'pass');
  assert.ok(result.marker);
  assert.equal(result.recordedBodySha256, sha256(liveBody));
});

test('an acquire marker comment edited after posting fails closed with not-found', () => {
  // contract.md: "Owner comments are append-only and must not be edited
  // or deleted." An edited comment's own createdAt is unchanged, so the
  // deterministic-comment-order replay would still treat it as the
  // Stage 1 acquire -- but its body-sha256 field could have been
  // silently rewritten to match a body modified after Stage 1
  // (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector
  // round 5). Detect the edit via updatedAt !== createdAt and fail
  // closed instead of trusting an editable field.
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
        updatedAt: '2026-09-10T17:00:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /edited after posting/,
  );
});

test('an acquire marker whose anchor differs from its own target reports not-found', () => {
  // This helper is built for the single-target orphan case; contract.md:
  // "the anchor's own marker uses its target as the anchor." A marker
  // whose anchor differs from its target declares itself a multi-target
  // set's non-anchor child, out of scope here (kurone-kito/idd-skill#2901
  // review, Copilot round 5) -- fail closed rather than silently
  // comparing against a child marker's digest.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), {
          anchor: 'kurone-kito/idd-skill#1',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /anchor/,
  );
});

test('an acquire marker with a non-none supersedes reports not-found', () => {
  // contract.md: "supersedes=none for acquire and bootstrap, while
  // resume names the prior owner token." An acquire carrying a non-none
  // supersedes is malformed and must not authorize the exception
  // (kurone-kito/idd-skill#2901 review, chatgpt-codex-connector
  // round 5).
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), {
          supersedes: 'owner-token-stale',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /supersedes/,
  );
});

test('an acquire marker with body-sha256=none reports not-found, never pass', () => {
  // "none" is a shape-valid sentinel for other modes (release-guard's
  // body-sha256=none, for example) but a genuine Stage 1 acquire's whole
  // purpose is recording the published body's digest -- "none" here is
  // malformed, not merely a coincidental miss.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody('none'),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /body-sha256/,
  );
});

test('a Stage 1 acquire edited into unparseable garbage fails closed, not the next acquire', () => {
  // Copilot round 5 caught an edited marker that still PARSES with the
  // same target -- this is the deeper variant Copilot round 6 found: the
  // edit breaks parsing entirely (or could equally retarget the marker),
  // so the old target-match filter silently dropped it from `events`
  // before any validity check ever saw it, letting a later, unedited
  // acquire become events[0] and report pass. The pre-pass in
  // findStageOneAcquire now catches this by scanning every trusted
  // owner-marker-shaped comment for an edit BEFORE selecting a winner,
  // not just the one that would otherwise be selected.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        // Still recognizable as marker-shaped (contains the token) but
        // no longer parses as a well-formed marker at all.
        body: `<!-- idd-skill-authoring-owner: target=${TARGET}; corrupted`,
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T17:00:00Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), { owner: 'owner-token-2' }),
        createdAt: '2026-09-10T16:50:00Z',
        updatedAt: '2026-09-10T16:50:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /edited after posting/,
  );
});

test('a Stage 1 acquire retargeted by an edit fails closed, not the next acquire', () => {
  // Same underlying bug, via a different corruption shape: the edit keeps
  // the marker well-formed but changes its own `target` field to a
  // different issue, so the old target-match filter dropped it before
  // the anchor/validity checks could ever see it.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), {
          target: 'kurone-kito/idd-skill#1',
          anchor: 'kurone-kito/idd-skill#1',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T17:00:00Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), { owner: 'owner-token-2' }),
        createdAt: '2026-09-10T16:50:00Z',
        updatedAt: '2026-09-10T16:50:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /edited after posting/,
  );
});

test('CLI: pass -- an unchanged body reports pass end to end, comments fetched before the body', () => {
  const liveBody = '# Draft\n\nSome content.\n';
  const callLogDir = mkdtempSync(join(tmpdir(), 'idd-authoring-owner-cli-'));
  const callLogPath = join(callLogDir, 'calls.log');
  const restore = stubGh(
    ghStubScriptForIssue(
      liveBody,
      [
        {
          id: 1,
          user: { login: 'kurone-kito' },
          body: acquireMarkerBody(sha256(liveBody)),
          created_at: '2026-09-10T16:48:44Z',
          updated_at: '2026-09-10T16:48:44Z',
        },
      ],
      callLogPath,
    ),
  );
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-owner-provenance.mjs'),
          '--issue',
          '2891',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--trusted-marker-logins',
          'kurone-kito',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.verdict, 'pass');
    assert.equal(output.target, TARGET);
    assert.equal(output.recordedBodySha256, sha256(liveBody));
    // The actual regression this proves: the comments call happens
    // before the issue-body call (kurone-kito/idd-skill#2901 review,
    // Copilot round 7 -- the prior stub had no memory across the two
    // separate `gh` child processes, so it could not tell which call
    // came first and this ordering was never really exercised).
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'repos/kurone-kito/idd-skill/issues/2891/comments',
      'repos/kurone-kito/idd-skill/issues/2891',
    ]);
  } finally {
    restore();
    rmSync(callLogDir, { recursive: true, force: true });
  }
});

test('CLI: mismatch -- a body edited since acquire reports mismatch end to end', () => {
  const acquireTimeBody = '# Draft\n\nOriginal.\n';
  const editedLiveBody = '# Draft\n\nEdited after acquire.\n';
  const restore = stubGh(
    ghStubScriptForIssue(editedLiveBody, [
      {
        id: 1,
        user: { login: 'kurone-kito' },
        body: acquireMarkerBody(sha256(acquireTimeBody)),
        created_at: '2026-09-10T16:48:44Z',
        updated_at: '2026-09-10T16:48:44Z',
      },
    ]),
  );
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-owner-provenance.mjs'),
          '--issue',
          '2891',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--trusted-marker-logins',
          'kurone-kito',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.verdict, 'mismatch');
    assert.equal(output.recordedBodySha256, sha256(acquireTimeBody));
    assert.equal(output.computedBodySha256, sha256(editedLiveBody));
  } finally {
    restore();
  }
});

test('CLI: not-found -- no acquire marker reports not-found end to end', () => {
  const liveBody = 'plain issue body with no authoring marker at all';
  const restore = stubGh(ghStubScriptForIssue(liveBody, []));
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-owner-provenance.mjs'),
          '--issue',
          '2891',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--trusted-marker-logins',
          'kurone-kito',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.verdict, 'not-found');
    assert.equal(output.marker, null);
    assert.equal(output.recordedBodySha256, null);
  } finally {
    restore();
  }
});

test('CLI: --issue rejects a token with trailing garbage instead of truncating it', () => {
  const restore = stubGh(ghStubScriptForIssue('unused', []));
  try {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/authoring-owner-provenance.mjs'),
          '--issue',
          '2891junk',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }, /must be a positive integer/);
  } finally {
    restore();
  }
});

test('an edited marker with a differently cased prefix token still fails closed', () => {
  // Copilot round 7: parseAuthoringOwnerComment matches the marker
  // prefix/suffix case-insensitively, so looksLikeOwnerMarker's own
  // token check must too -- an edit that broke the <!-- opener while
  // also changing the prefix's casing must not evade the edit-detection
  // pre-pass.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: 'IDD-SKILL-authoring-owner: broken, no opener',
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T17:00:00Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), { owner: 'owner-token-2' }),
        createdAt: '2026-09-10T16:50:00Z',
        updatedAt: '2026-09-10T16:50:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /edited after posting/,
  );
});

test('an unedited but unparseable first owner-marker-shaped comment fails closed, not the next acquire', () => {
  // Copilot round 7: the earlier form filtered the candidate pool down
  // to parsing, target-matching comments BEFORE picking the first one,
  // so a first comment that carried the owner-marker token but never
  // parsed at all (a genuine posting error, not tampering -- its own
  // updatedAt equals its createdAt) silently vanished from
  // consideration, letting a later, validly-parsing acquire win. The
  // log's first candidate must itself be the valid marker, not merely
  // whichever later comment happens to parse.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        // Never edited (updatedAt === createdAt) -- just malformed from
        // the start, e.g. a botched initial post.
        body: 'idd-skill-authoring-owner: this was never a well-formed marker',
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), { owner: 'owner-token-2' }),
        createdAt: '2026-09-10T16:50:00Z',
        updatedAt: '2026-09-10T16:50:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /does not parse/,
  );
});

test('an unedited first marker for a different target fails closed, not the next acquire', () => {
  // Same restructuring, via the target-mismatch branch: an unedited
  // first owner-marker-shaped comment whose own target names a
  // different issue is now a reject, not a silent skip in favor of a
  // later, matching acquire.
  const liveBody = '# Draft\n\nSome content.\n';
  const result = evaluateAuthoringOwnerProvenance({
    target: TARGET,
    liveBody,
    comments: [
      {
        id: 1,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), {
          target: 'kurone-kito/idd-skill#1',
          anchor: 'kurone-kito/idd-skill#1',
        }),
        createdAt: '2026-09-10T16:48:44Z',
        updatedAt: '2026-09-10T16:48:44Z',
      },
      {
        id: 2,
        authorLogin: 'kurone-kito',
        body: acquireMarkerBody(sha256(liveBody), { owner: 'owner-token-2' }),
        createdAt: '2026-09-10T16:50:00Z',
        updatedAt: '2026-09-10T16:50:00Z',
      },
    ],
    markerPrefix: MARKER_PREFIX,
    trustedMarkerLogins: TRUSTED_LOGINS,
  });
  assert.equal(result.verdict, 'not-found');
  assert.equal(result.marker, null);
  assert.match(
    result.checks.find((check) => check.id === 'acquire_marker_found')
      ?.evidence ?? '',
    /different target/,
  );
});
