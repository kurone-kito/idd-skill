import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderOutOfLoopMarker } from '../src/scripts/marker-helpers.mts';
import {
  classifyPrLoopMembership,
  resolveClosingIssueNumbersForClassifier,
} from '../src/scripts/protocol-helpers.mts';

// kurone-kito/idd-skill#3328: `classifyPrLoopMembership` is the single
// shared definition of "does this PR run outside the IDD claim loop",
// replacing the pre-existing divergent `pre-merge-readiness.mts`
// (`--claimless`, #2017) and `resolve-review-thread.mts`
// (`isClaimlessEligible`, #2616) definitions. Every test below exercises
// the pure classifier directly -- no network, no fixture provider.

const PR_NUMBER = 42;
const TRUSTED_LOGIN = 'kurone-kito';

function validMarkerComment(overrides: Record<string, unknown> = {}) {
  const body = renderOutOfLoopMarker({
    agentId: 'claude-ad242b1f',
    prNumber: PR_NUMBER,
    reason: 'bootstrap',
    at: '2026-09-24T00:00:00Z',
  });
  return {
    body,
    author: { login: TRUSTED_LOGIN },
    createdAt: '2026-09-24T00:00:01Z',
    lastEditedAt: null,
    ...overrides,
  };
}

test('closing issue references unreadable (null) -> in-loop, fail closed', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: null,
    closingIssueClaimState: 'none',
    prComments: [],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.deepStrictEqual(result, {
    membership: 'in-loop',
    reason: 'closing issue references are unreadable (fail closed)',
  });
});

test('no closing issue references -> out-of-loop-claimless (#2017)', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [],
    closingIssueClaimState: 'none',
    prComments: [],
    trustedMarkerLogins: [],
  });
  assert.strictEqual(result.membership, 'out-of-loop-claimless');
});

test('closing issue has an active claim (present) -> in-loop, even with a valid marker', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'present',
    prComments: [validMarkerComment()],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
  assert.match(result.reason, /active claim state is present/);
});

test('closing issue claim state unknown -> in-loop, even with a valid marker (fail closed)', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'unknown',
    prComments: [validMarkerComment()],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
  assert.match(result.reason, /active claim state is unknown/);
});

test('closing issue has no active claim, no marker -> in-loop (ordinary unclaimed)', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('closing issue has no active claim, valid trusted unedited marker -> out-of-loop-authorized', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [validMarkerComment()],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'out-of-loop-authorized');
  assert.match(result.reason, /reason:bootstrap/);
});

// --- Invalid-marker cases (acceptance criteria) ---

test('marker from an untrusted author -> in-loop', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [validMarkerComment({ author: { login: 'untrusted-actor' } })],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('a reason: token other than bootstrap -> not a valid marker, in-loop', () => {
  const body =
    '<!-- idd-out-of-loop: claude-ad242b1f pr:42 reason:other at:2026-09-24T00:00:00Z -->\n\n' +
    '_claude-ad242b1f: this PR runs outside the IDD claim loop -- IDD automation marker. Do not edit._';
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [
      {
        body,
        author: { login: TRUSTED_LOGIN },
        createdAt: '2026-09-24T00:00:01Z',
        lastEditedAt: null,
      },
    ],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('a pr: value naming another PR -> not a match for this PR, in-loop', () => {
  const otherPrComment = validMarkerComment();
  // Re-render for a different PR number instead of hand-editing the body,
  // so the marker stays byte-exact canonical.
  const body = renderOutOfLoopMarker({
    agentId: 'claude-ad242b1f',
    prNumber: 999,
    reason: 'bootstrap',
    at: '2026-09-24T00:00:00Z',
  });
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [{ ...otherPrComment, body }],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('an edited comment (lastEditedAt set) -> fails isTrustEvidenceComment, in-loop', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [validMarkerComment({ lastEditedAt: '2026-09-24T01:00:00Z' })],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('a comment whose edit state is unknown (no lastEditedAt field) -> fail closed, in-loop', () => {
  const marker = validMarkerComment();
  const { lastEditedAt: _omit, ...withoutEditState } = marker;
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [withoutEditState],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('a malformed first line -> does not parse as a marker, in-loop', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [
      validMarkerComment({
        body: '<!-- idd-out-of-loop: claude-ad242b1f pr:42 reason:bootstrap -->',
      }),
    ],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

test('a preamble before the marker token defeats detection entirely -> in-loop', () => {
  const marker = validMarkerComment();
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: [7],
    closingIssueClaimState: 'none',
    prComments: [{ ...marker, body: `note: see below\n${marker.body}` }],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
});

// --- resolveClosingIssueNumbersForClassifier (C1 critique pass finding) ---
//
// A same-repo-only filter fed straight to classifyPrLoopMembership would
// silently read a cross-repo-only (or all-malformed) closing reference as
// "no closing references" -- the classifier's own out-of-loop-claimless
// row -- accepting --claimless with NO marker required for a PR the
// pre-#3328 code always refused (both prior definitions refused ANY
// non-empty raw closingIssuesReferences regardless of repo).
// resolveClosingIssueNumbersForClassifier exists to prevent that
// regression: see the two integration-level tests in
// pre-merge-readiness.test.mts / resolve-review-thread.test.mts for the
// end-to-end reproduction this unit-level coverage backs.

test('resolveClosingIssueNumbersForClassifier: an empty array stays [] (unchanged #2017 claimless case)', () => {
  assert.deepStrictEqual(
    resolveClosingIssueNumbersForClassifier([], 'o', 'r'),
    [],
  );
});

test('resolveClosingIssueNumbersForClassifier: same-repo entries pass through unchanged', () => {
  assert.deepStrictEqual(
    resolveClosingIssueNumbersForClassifier([{ number: 7 }], 'o', 'r'),
    [7],
  );
});

test('resolveClosingIssueNumbersForClassifier: a cross-repo-only closing reference reports null, not [] (regression guard)', () => {
  const crossRepoOnly = [
    {
      number: 5,
      repository: { name: 'other-repo', owner: { login: 'other-owner' } },
    },
  ];
  assert.strictEqual(
    resolveClosingIssueNumbersForClassifier(crossRepoOnly, 'o', 'r'),
    null,
  );
});

test('resolveClosingIssueNumbersForClassifier: an all-malformed non-empty array reports null', () => {
  assert.strictEqual(
    resolveClosingIssueNumbersForClassifier([{}, { number: -1 }], 'o', 'r'),
    null,
  );
});

test('resolveClosingIssueNumbersForClassifier: a mix of same-repo and cross-repo entries returns only the same-repo numbers', () => {
  const mixed = [
    { number: 7 },
    {
      number: 5,
      repository: { name: 'other-repo', owner: { login: 'other-owner' } },
    },
  ];
  assert.deepStrictEqual(
    resolveClosingIssueNumbersForClassifier(mixed, 'o', 'r'),
    [7],
  );
});

test('classifyPrLoopMembership: null closingIssueNumbers (unreadable) is in-loop even with a valid marker', () => {
  const result = classifyPrLoopMembership({
    prNumber: PR_NUMBER,
    closingIssueNumbers: null,
    closingIssueClaimState: 'none',
    prComments: [validMarkerComment()],
    trustedMarkerLogins: [TRUSTED_LOGIN],
  });
  assert.strictEqual(result.membership, 'in-loop');
  assert.match(result.reason, /unreadable/);
});
