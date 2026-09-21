import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AuthoringMarkerCandidateInput,
  classifyAuthoringMarkerFamily,
  renderAuthoringOwnerMarker,
  renderAuthoringPublicationIntentMarker,
} from '../src/scripts/marker-helpers.mts';

const MARKER_PREFIX = 'idd-skill';

function ownerMarker(mode: string, target: string, owner = 'owner-1'): string {
  return renderAuthoringOwnerMarker({
    markerPrefix: MARKER_PREFIX,
    target,
    anchor: 'kurone-kito/idd-skill#1',
    mode,
    owner,
    set: 'set-1',
    session: 'session-1',
    bodySha256: 'none',
    snapshotSha256: 'none',
    supersedes: 'none',
  });
}

function intentMarker(
  state: string,
  target: string,
  token: string,
  issue = 'none',
): string {
  return renderAuthoringPublicationIntentMarker({
    markerPrefix: MARKER_PREFIX,
    target,
    anchor: 'kurone-kito/idd-skill#1',
    set: 'set-1',
    session: 'session-1',
    token,
    journal: 'kurone-kito/idd-skill#900',
    issue,
    actor: 'kurone-kito',
    state,
  });
}

function candidate(
  body: string,
  author = 'trusted-bot',
  isMinimized = false,
): AuthoringMarkerCandidateInput {
  return { body, author, isMinimized };
}

test('classifyAuthoringMarkerFamily protects the newest match when every candidate shares one target (baseline, single continuity chain)', () => {
  const comments = [
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#100')),
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#100')),
    candidate(ownerMarker('release', 'kurone-kito/idd-skill#100')),
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.matchIndexes, [0, 1, 2]);
  assert.deepEqual(result.trustedMatchIndexes, [0, 1, 2]);
  assert.deepEqual(result.newestTrustedIndexes, [2]);
  assert.deepEqual(result.eligibleIndexes, [0, 1]);
  assert.deepEqual(result.alreadyMinimizedIndexes, []);
});

test('classifyAuthoringMarkerFamily (#3167) never treats a DIFFERENT target as superseding this one: each target protects its own newest independently', () => {
  const comments = [
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#100')), // target A stale
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#200')), // target B stale
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#100')), // target A newest
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#200')), // target B newest
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  // Pre-#3167 behavior would have reported newestTrustedIndex: 3 only, and
  // eligibleIndexes: [0, 1, 2] -- wrongly flagging index 2 (target A's own
  // current record) as superseded by index 3 (an unrelated target B
  // record). The fix protects BOTH targets' own newest.
  assert.deepEqual(result.newestTrustedIndexes, [2, 3]);
  assert.deepEqual(result.eligibleIndexes, [0, 1]);
});

test('classifyAuthoringMarkerFamily (#3167) scopes authoring-publication-intent identity to target+token, including two targets from the SAME set on a shared journal issue', () => {
  const comments = [
    candidate(intentMarker('pending', 'kurone-kito/idd-skill#301', 'pub-a')), // target A stale
    candidate(intentMarker('pending', 'kurone-kito/idd-skill#302', 'pub-b')), // target B stale
    candidate(
      intentMarker('member', 'kurone-kito/idd-skill#301', 'pub-a', '301'),
    ), // target A newest
    candidate(
      intentMarker('member', 'kurone-kito/idd-skill#302', 'pub-b', '302'),
    ), // target B newest
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-publication-intent',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.newestTrustedIndexes, [2, 3]);
  assert.deepEqual(result.eligibleIndexes, [0, 1]);
});

test('classifyAuthoringMarkerFamily excludes an already-minimized superseded match from eligibleIndexes but still counts it as alreadyMinimizedIndexes, per target', () => {
  const comments = [
    candidate(
      ownerMarker('acquire', 'kurone-kito/idd-skill#100'),
      'trusted-bot',
      true,
    ), // target A stale, already minimized
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#200')), // target B stale, not yet minimized
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#100')), // target A newest
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#200')), // target B newest
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.alreadyMinimizedIndexes, [0]);
  assert.deepEqual(result.eligibleIndexes, [1]);
  assert.deepEqual(result.newestTrustedIndexes, [2, 3]);
});

test("classifyAuthoringMarkerFamily excludes an untrusted author from every group, even when it would otherwise be that target's own newest match", () => {
  const comments = [
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#100')), // target A stale, trusted
    candidate(
      ownerMarker('release', 'kurone-kito/idd-skill#100'),
      'untrusted-user',
    ), // target A newest by position, but untrusted
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.matchIndexes, [0, 1]);
  assert.deepEqual(result.untrustedIndexes, [1]);
  assert.deepEqual(result.trustedMatchIndexes, [0]);
  // Fewer than two TRUSTED matches in this target's own group: nothing is
  // "superseded" -- index 0 is neither protected-as-newest nor eligible.
  assert.deepEqual(result.newestTrustedIndexes, []);
  assert.deepEqual(result.eligibleIndexes, []);
});

test('classifyAuthoringMarkerFamily leaves a solitary target (only one trusted match) neither eligible nor protected -- nothing exists yet to supersede it', () => {
  const comments = [
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#100')),
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#200')),
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.newestTrustedIndexes, []);
  assert.deepEqual(result.eligibleIndexes, []);
  assert.deepEqual(result.alreadyMinimizedIndexes, []);
});

test('classifyAuthoringMarkerFamily restores ascending index order across interleaved identity groups (proves the post-grouping sort is load-bearing, not incidental)', () => {
  // Two targets' comments interleave in chronological (input) order:
  // A, B, A, B, A, B -- so each group's own members are NOT contiguous.
  // Group A = indexes [0, 2, 4] (eligible [0, 2], newest 4); group B =
  // indexes [1, 3, 5] (eligible [1, 3], newest 5). Processing groups in
  // Map insertion order (A first, since it is seen first at index 0)
  // would push eligibleIndexes as [0, 2, 1, 3] -- NOT ascending -- unless
  // the final `.sort()` call actually runs.
  const comments = [
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#100')), // 0: A stale
    candidate(ownerMarker('acquire', 'kurone-kito/idd-skill#200')), // 1: B stale
    candidate(ownerMarker('resume', 'kurone-kito/idd-skill#100')), // 2: A stale
    candidate(ownerMarker('resume', 'kurone-kito/idd-skill#200')), // 3: B stale
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#100')), // 4: A newest
    candidate(ownerMarker('heartbeat', 'kurone-kito/idd-skill#200')), // 5: B newest
  ];
  const result = classifyAuthoringMarkerFamily(
    comments,
    MARKER_PREFIX,
    'authoring-owner',
    new Set(['trusted-bot']),
  );
  assert.deepEqual(result.newestTrustedIndexes, [4, 5]);
  assert.deepEqual(result.eligibleIndexes, [0, 1, 2, 3]);
});
