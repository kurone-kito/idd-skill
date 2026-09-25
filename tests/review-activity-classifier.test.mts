import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildDispositionBody,
  buildSummaryDispositionBody,
} from '../src/scripts/disposition-non-review-notices.mts';
import * as markerHelpers from '../src/scripts/marker-helpers.mts';
import type { MarkerType } from '../src/scripts/post-idd-marker.mts';
import {
  buildMarkerBody,
  MARKER_TYPES,
} from '../src/scripts/post-idd-marker.mts';
import type { IddPrCommentClassification } from '../src/scripts/protocol-helpers.mts';
import {
  buildActivitySnapshotSummary,
  classifyIddPrComment,
  LIVE_STATUS_DIGEST_HISTORICAL_MARKER,
  LIVE_STATUS_DIGEST_MARKER,
  LIVE_STATUS_DIGEST_REPAIR_MARKER,
  PR_OPERATIONAL_COMMENT_PREFIXES,
  renderLiveStatusDigest,
  renderLiveStatusDigestRepairEvidence,
  retireLiveStatusDigestBody,
  summarizeDispositionEvidenceForGate,
  summarizeRegularCommentsForGate,
} from '../src/scripts/protocol-helpers.mts';

// kurone-kito/idd-skill#3267: shared fixtures for every body this file renders.
const TRUSTED_LOGIN = 'idd-agent';
const UNTRUSTED_LOGIN = 'some-human';
const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';
const TRUSTED = [TRUSTED_LOGIN];
const SHA = 'a'.repeat(40);
const TS = '2026-05-01T00:00:00Z';
const CLAIM = 'claim-test0001';

function classify(
  body: string,
  authorLogin: string,
  options: { trustedMarkerLogins?: string[]; iddAgentLogins?: string[] } = {},
): IddPrCommentClassification {
  return classifyIddPrComment(
    { body, author: { login: authorLogin } },
    {
      trustedMarkerLogins: options.trustedMarkerLogins ?? TRUSTED,
      iddAgentLogins: options.iddAgentLogins,
    },
  );
}

// ---------------------------------------------------------------------------
// Every exported `render*` function in marker-helpers.mts, apart from the
// listed exclusions, must be covered below -- this self-check fails when a
// new renderer is neither covered nor excluded, so a future marker family
// cannot silently skip the classifier.
// ---------------------------------------------------------------------------

/**
 * Renderers that never produce a whole, standalone PR comment on their own,
 * so classifying their raw output is meaningless:
 *  - `renderAuthoringOwnerMarker` / `renderAuthoringPublicationIntentMarker`:
 *    issue-authoring lifecycle markers (contract.md), deliberately kept out
 *    of `OPERATIONAL_MARKERS` -- see that array's own doc comment in
 *    marker-helpers.mts.
 *  - `renderReviewReplyStamp`: a suffix `appendReviewReplyStamp` appends to
 *    a disposition body, never a comment body of its own.
 *  - `renderForcedHandoffConsentNote`: the human-readable fragment
 *    `renderForcedHandoffComment` embeds AFTER its own `<!-- forced-handoff:
 *    ... -->` token; calling it directly returns that fragment alone, with
 *    no marker token at all (verified reading its source: it never emits
 *    the `<!-- forced-handoff:` prefix `renderForcedHandoffComment` adds).
 */
const EXCLUDED_RENDERERS = new Set([
  'renderAuthoringOwnerMarker',
  'renderAuthoringPublicationIntentMarker',
  'renderReviewReplyStamp',
  'renderForcedHandoffConsentNote',
]);

const ALL_RENDER_EXPORTS = Object.keys(markerHelpers).filter((name) =>
  name.startsWith('render'),
);

/**
 * Expected {@link classifyIddPrComment} result for a TRUSTED author's body
 * from each covered renderer. A renderer's own family may be a genuine
 * `OPERATIONAL_MARKERS` / `PR_OPERATIONAL_COMMENT_PREFIXES` entry
 * (`idd-operational`), or one this classifier deliberately does NOT
 * recognize as PR-scoped review-activity exclusion (`review`) -- see
 * `PR_OPERATIONAL_COMMENT_PREFIXES`'s own doc comment in protocol-helpers.mts
 * for exactly which `OPERATIONAL_MARKERS` entries fall into the second
 * bucket and why (activation-nonce and the two declaration-target-scoped
 * provider-outage markers are issue-scoped, never posted to a PR at all;
 * provider-outage-park and out-of-loop ARE posted to a PR but each has its
 * own dedicated non-review-activity consumer). A renderer in the second
 * bucket still renders a well-formed `OPERATIONAL_MARKERS`-recognized body
 * -- this table asserts the classifier's deliberate narrower PR-scoped
 * exclusion, not a claim that the body is unrecognizable.
 */
const RENDERER_CASES: Array<{
  name: string;
  render: () => string;
  expected: IddPrCommentClassification;
}> = [
  {
    name: 'renderClaimedByMarker',
    render: () =>
      markerHelpers.renderClaimedByMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        supersedes: 'none',
        timestamp: TS,
        branch: 'issue/1-test',
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderActivationNonceMarker',
    render: () =>
      markerHelpers.renderActivationNonceMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        nonce: 'nonce-test0001',
        timestamp: TS,
      }),
    // Issue-scoped only (idd-claim.instructions.md) -- never a PR comment.
    expected: 'review',
  },
  {
    name: 'renderReviewWatermarkMarker',
    render: () =>
      markerHelpers.renderReviewWatermarkMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        headSha: SHA,
        maxActivityAt: 'none',
        totalItemCount: 0,
        ciCompletedAt: 'none',
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderReviewBaselineMarker',
    render: () =>
      markerHelpers.renderReviewBaselineMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        sha: SHA,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderUnclaimedByMarker',
    render: () =>
      markerHelpers.renderUnclaimedByMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderAdvisoryWaitMarker',
    render: () =>
      markerHelpers.renderAdvisoryWaitMarker({
        agentId: TRUSTED_LOGIN,
        headSha: SHA,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderAdvisoryWaitRecoveryMarker',
    render: () =>
      markerHelpers.renderAdvisoryWaitRecoveryMarker({
        agentId: TRUSTED_LOGIN,
        headSha: SHA,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderCopilotUnavailableMarker',
    render: () =>
      markerHelpers.renderCopilotUnavailableMarker({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        headSha: SHA,
        attempt: 1,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderAdvisoryRerollMarker',
    render: () =>
      markerHelpers.renderAdvisoryRerollMarker({
        agentId: TRUSTED_LOGIN,
        headSha: SHA,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderReviewAckMarker',
    render: () =>
      markerHelpers.renderReviewAckMarker({
        agentId: TRUSTED_LOGIN,
        headSha: SHA,
        timestamp: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderForcedHandoffComment',
    render: () =>
      markerHelpers.renderForcedHandoffComment({
        oldAgentId: 'old-agent',
        oldClaimId: 'claim-old0001',
        newAgentId: TRUSTED_LOGIN,
        newClaimId: CLAIM,
        branch: 'issue/1-test',
        forcedBy: 'maintainer',
        reason: 'operator-approved-recovery',
        timestamp: TS,
        contextScope: 'issue-only',
      }),
    // Not in PR_OPERATIONAL_COMMENT_PREFIXES (parity-tested doc set), but
    // recognized directly by classifyIddPrComment -- it genuinely is
    // PR-scoped (context-scope: issue-plus-pr names an open PR) per
    // idd-resume.instructions.md's forced-handoff evidence table.
    expected: 'idd-operational',
  },
  {
    name: 'renderExternalCheckWaiverComment',
    render: () =>
      markerHelpers.renderExternalCheckWaiverComment({
        agentId: TRUSTED_LOGIN,
        claimId: CLAIM,
        headSha: SHA,
        checkSelector: 'idd-advisory-convergence',
        reason: 'test-waiver',
        expiresAt: TS,
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderProviderOutageDeclarationComment',
    render: () =>
      markerHelpers.renderProviderOutageDeclarationComment({
        actor: TRUSTED_LOGIN,
        service: 'anthropic',
        startedAt: TS,
        expiresAt: TS,
      }),
    // Posted to the declaration-target ISSUE, never the PR under review.
    expected: 'review',
  },
  {
    name: 'renderProviderOutageAdvancedComment',
    render: () =>
      markerHelpers.renderProviderOutageAdvancedComment({
        actor: TRUSTED_LOGIN,
        prNumber: 1,
        headSha: SHA,
        declaredAt: TS,
      }),
    // Posted to the declaration-target ISSUE, never the PR under review.
    expected: 'review',
  },
  {
    name: 'renderProviderOutageParkComment',
    render: () =>
      markerHelpers.renderProviderOutageParkComment({
        actor: TRUSTED_LOGIN,
        issueNumber: 1,
        service: 'anthropic',
        headSha: SHA,
        claimId: CLAIM,
        parkedAt: TS,
        blockers: ['pre-merge-readiness'],
      }),
    // PR-scoped, but owned by provider-outage-park.mts's own resume logic.
    expected: 'review',
  },
  {
    name: 'renderLocalValidationEvidenceComment',
    render: () =>
      markerHelpers.renderLocalValidationEvidenceComment({
        actor: TRUSTED_LOGIN,
        headSha: SHA,
        commandSet: 'pre-push-validate',
        covers: ['ci'],
        outcome: 'pass',
      }),
    expected: 'idd-operational',
  },
  {
    name: 'renderOutOfLoopMarker',
    render: () =>
      markerHelpers.renderOutOfLoopMarker({
        agentId: TRUSTED_LOGIN,
        prNumber: 1,
        reason: 'bootstrap',
        at: TS,
      }),
    // PR-scoped, but owned by classifyPrLoopMembership's own dedicated path.
    expected: 'review',
  },
];

test('every exported render* name in marker-helpers.mts is covered or excluded', () => {
  const covered = new Set(RENDERER_CASES.map((entry) => entry.name));
  const uncovered = ALL_RENDER_EXPORTS.filter(
    (name) => !covered.has(name) && !EXCLUDED_RENDERERS.has(name),
  );
  assert.deepEqual(
    uncovered,
    [],
    `marker-helpers.mts exports a render* function this test neither covers nor excludes: ${uncovered.join(', ')}`,
  );
  // Also guard the reverse: an excluded or covered name that no longer
  // exists would silently narrow this coverage without failing anything
  // else.
  for (const name of [...covered, ...EXCLUDED_RENDERERS]) {
    assert.ok(
      ALL_RENDER_EXPORTS.includes(name),
      `${name} is listed as covered/excluded but marker-helpers.mts no longer exports it`,
    );
  }
});

test('classifyIddPrComment classifies every covered render* function correctly for a trusted author', () => {
  for (const { name, render, expected } of RENDERER_CASES) {
    const body = render();
    const actual = classify(body, TRUSTED_LOGIN);
    assert.equal(
      actual,
      expected,
      `${name}: expected ${expected}, got ${actual} for body:\n${body}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Every MARKER_TYPES entry in post-idd-marker.mts, via buildMarkerBody.
// ---------------------------------------------------------------------------

const FIELDS_BY_MARKER_TYPE: Record<MarkerType, Record<string, string>> = {
  claim: {
    'agent-id': TRUSTED_LOGIN,
    'claim-id': CLAIM,
    supersedes: 'none',
    timestamp: TS,
    branch: 'issue/1-test',
  },
  unclaim: { 'agent-id': TRUSTED_LOGIN, 'claim-id': CLAIM, timestamp: TS },
  'activation-nonce': {
    'agent-id': TRUSTED_LOGIN,
    'claim-id': CLAIM,
    nonce: 'nonce-test0001',
    timestamp: TS,
  },
  watermark: {
    'agent-id': TRUSTED_LOGIN,
    'claim-id': CLAIM,
    'head-sha': SHA,
    'max-activity-at': 'none',
    'total-item-count': '0',
    'ci-completed-at': 'none',
  },
  baseline: { 'agent-id': TRUSTED_LOGIN, 'claim-id': CLAIM, sha: SHA },
  advisory: { 'agent-id': TRUSTED_LOGIN, 'head-sha': SHA, timestamp: TS },
  'advisory-recovery': {
    'agent-id': TRUSTED_LOGIN,
    'head-sha': SHA,
    timestamp: TS,
  },
  'advisory-reroll': {
    'agent-id': TRUSTED_LOGIN,
    'head-sha': SHA,
    timestamp: TS,
  },
  'review-ack': { 'agent-id': TRUSTED_LOGIN, 'head-sha': SHA, timestamp: TS },
  'copilot-unavailable': {
    'agent-id': TRUSTED_LOGIN,
    'claim-id': CLAIM,
    'head-sha': SHA,
    attempt: '1',
    timestamp: TS,
  },
  'out-of-loop': { 'agent-id': TRUSTED_LOGIN, pr: '1', timestamp: TS },
  'authoring-owner': {
    'agent-id': TRUSTED_LOGIN,
    'marker-prefix': 'idd-skill',
    'marker-target': 'kurone-kito/idd-skill#1',
    anchor: 'kurone-kito/idd-skill#1',
    mode: 'acquire',
    'marker-owner': TRUSTED_LOGIN,
    set: 'set-test0001',
    session: 'session-test0001',
    'body-sha256': 'a'.repeat(64),
    'snapshot-sha256': 'b'.repeat(64),
    supersedes: 'none',
  },
  'authoring-publication-intent': {
    'agent-id': TRUSTED_LOGIN,
    'marker-prefix': 'idd-skill',
    'marker-target': 'set-test0001',
    anchor: 'set-test0001',
    set: 'set-test0001',
    session: 'session-test0001',
    token: 'token-test0001',
    journal: 'kurone-kito/idd-skill#1',
    issue: 'kurone-kito/idd-skill#2',
    actor: TRUSTED_LOGIN,
    state: 'pending',
  },
};

/** Expected classification per MARKER_TYPES entry, same rationale table as RENDERER_CASES. */
const EXPECTED_BY_MARKER_TYPE: Record<MarkerType, IddPrCommentClassification> =
  {
    claim: 'idd-operational',
    unclaim: 'idd-operational',
    'activation-nonce': 'review',
    watermark: 'idd-operational',
    baseline: 'idd-operational',
    advisory: 'idd-operational',
    'advisory-recovery': 'idd-operational',
    'advisory-reroll': 'idd-operational',
    'review-ack': 'idd-operational',
    'copilot-unavailable': 'idd-operational',
    'out-of-loop': 'review',
    // Not part of OPERATIONAL_MARKERS at all (issue-authoring lifecycle
    // markers, contract.md) -- never recognized as PR review-activity.
    'authoring-owner': 'review',
    'authoring-publication-intent': 'review',
  };

test('every MARKER_TYPES entry is covered by buildMarkerBody + classifyIddPrComment', () => {
  const coveredTypes = Object.keys(FIELDS_BY_MARKER_TYPE);
  const uncoveredTypes = MARKER_TYPES.filter(
    (type) => !coveredTypes.includes(type),
  );
  assert.deepEqual(
    uncoveredTypes,
    [],
    `post-idd-marker.mts exports a MARKER_TYPES entry this test doesn't cover: ${uncoveredTypes.join(', ')}`,
  );

  for (const type of MARKER_TYPES) {
    const body = buildMarkerBody(type, FIELDS_BY_MARKER_TYPE[type]);
    const expected = EXPECTED_BY_MARKER_TYPE[type];
    const actual = classify(body, TRUSTED_LOGIN);
    assert.equal(
      actual,
      expected,
      `MARKER_TYPES '${type}': expected ${expected}, got ${actual} for body:\n${body}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The three live-status digest forms.
// ---------------------------------------------------------------------------

const CURRENT_DIGEST_BODY = renderLiveStatusDigest({
  phase: 'E1 snapshot',
  claim: CLAIM,
  branch: 'issue/1-test',
  lastChecked: TS,
  openBlockers: 'none',
  nextAction: 'E2 critique',
  authoritativeBy: 'this comment',
});
const HISTORICAL_DIGEST_BODY = retireLiveStatusDigestBody(CURRENT_DIGEST_BODY);
const REPAIR_EVIDENCE_BODY = renderLiveStatusDigestRepairEvidence({
  target: 'kurone-kito/idd-skill#1',
  status: 'complete',
  actor: TRUSTED_LOGIN,
  retainedCommentId: '1001',
  retiredCommentIds: ['1002'],
  preflight: { targetState: 'issue', entries: [], sha256: 'c'.repeat(64) },
  postflight: { targetState: 'issue', entries: [], sha256: 'd'.repeat(64) },
  reason: 'duplicate-set-resolved',
});

test('classifyIddPrComment recognizes all three live-status digest forms for a trusted author', () => {
  assert.equal(classify(CURRENT_DIGEST_BODY, TRUSTED_LOGIN), 'idd-operational');
  assert.equal(
    classify(HISTORICAL_DIGEST_BODY, TRUSTED_LOGIN),
    'idd-operational',
  );
  assert.equal(
    classify(REPAIR_EVIDENCE_BODY, TRUSTED_LOGIN),
    'idd-operational',
  );
});

test('classifyIddPrComment treats all three live-status digest forms as review from an untrusted author', () => {
  assert.equal(classify(CURRENT_DIGEST_BODY, UNTRUSTED_LOGIN), 'review');
  assert.equal(classify(HISTORICAL_DIGEST_BODY, UNTRUSTED_LOGIN), 'review');
  assert.equal(classify(REPAIR_EVIDENCE_BODY, UNTRUSTED_LOGIN), 'review');
});

test('sanity: the three digest bodies actually use the three distinct digest markers', () => {
  assert.equal(CURRENT_DIGEST_BODY.startsWith(LIVE_STATUS_DIGEST_MARKER), true);
  assert.equal(
    HISTORICAL_DIGEST_BODY.startsWith(LIVE_STATUS_DIGEST_HISTORICAL_MARKER),
    true,
  );
  assert.equal(
    REPAIR_EVIDENCE_BODY.startsWith(LIVE_STATUS_DIGEST_REPAIR_MARKER),
    true,
  );
});

// ---------------------------------------------------------------------------
// The two E6 disposition bodies.
// ---------------------------------------------------------------------------

test('classifyIddPrComment classifies E6 disposition bodies as idd-disposition for a trusted author', () => {
  const noticeBody = buildDispositionBody(
    'coderabbitai[bot]',
    SHA,
    'rate-limited',
    12345,
  );
  const summaryBody = buildSummaryDispositionBody('coderabbitai[bot]', SHA);
  assert.equal(classify(noticeBody, TRUSTED_LOGIN), 'idd-disposition');
  assert.equal(classify(summaryBody, TRUSTED_LOGIN), 'idd-disposition');
});

test('classifyIddPrComment classifies a disposition-shaped body from an untrusted author as review', () => {
  const noticeBody = buildDispositionBody(
    'coderabbitai[bot]',
    SHA,
    'rate-limited',
    12345,
  );
  assert.equal(classify(noticeBody, UNTRUSTED_LOGIN), 'review');
});

// ---------------------------------------------------------------------------
// github-actions[bot] narrow trust.
// ---------------------------------------------------------------------------

test('classifyIddPrComment trusts github-actions[bot] only for the two named CI-bookkeeping prefixes', () => {
  // #2657 auto-waiver shape, PR #3196-like: github-actions[bot], not itself
  // named in trustedMarkerLogins.
  const waiverBody = markerHelpers.renderExternalCheckWaiverComment({
    agentId: GITHUB_ACTIONS_LOGIN,
    claimId: 'none',
    headSha: SHA,
    checkSelector: 'idd-advisory-convergence',
    reason: 'self-referential-bootstrap-auto',
    expiresAt: TS,
    runId: '123456789',
  });
  assert.equal(
    classify(waiverBody, GITHUB_ACTIONS_LOGIN, { trustedMarkerLogins: [] }),
    'idd-operational',
  );

  const cleanupEvidenceBody =
    '<!-- idd-cleanup-evidence: complete applied:1 failed:0 skipped:0 viewer-cannot-minimize:0 retry-attempts:0 retry-bound-exhausted:false -->';
  assert.equal(
    classify(cleanupEvidenceBody, GITHUB_ACTIONS_LOGIN, {
      trustedMarkerLogins: [],
    }),
    'idd-operational',
  );

  // Any OTHER operational prefix from github-actions[bot] is NOT trusted by
  // this narrow path -- counts as ordinary activity.
  const claimedByBody = markerHelpers.renderClaimedByMarker({
    agentId: GITHUB_ACTIONS_LOGIN,
    claimId: CLAIM,
    supersedes: 'none',
    timestamp: TS,
    branch: 'issue/1-test',
  });
  assert.equal(
    classify(claimedByBody, GITHUB_ACTIONS_LOGIN, { trustedMarkerLogins: [] }),
    'review',
  );
});

// ---------------------------------------------------------------------------
// buildActivitySnapshotSummary (acceptance criteria bullet 2).
// ---------------------------------------------------------------------------

test('buildActivitySnapshotSummary excludes trusted historical/repair digests and the #3196-shaped waiver', () => {
  for (const body of [HISTORICAL_DIGEST_BODY, REPAIR_EVIDENCE_BODY]) {
    const summary = buildActivitySnapshotSummary(
      {
        comments: [
          { id: '1', body, author: { login: TRUSTED_LOGIN }, createdAt: TS },
        ],
      },
      { trustedMarkerLogins: TRUSTED },
    );
    assert.equal(summary.maxActivityUpdatedAt, 'none');
    assert.equal(summary.totalItemCount, 0);
  }

  const waiverBody = markerHelpers.renderExternalCheckWaiverComment({
    agentId: GITHUB_ACTIONS_LOGIN,
    claimId: 'none',
    headSha: SHA,
    checkSelector: 'idd-advisory-convergence',
    reason: 'self-referential-bootstrap-auto',
    expiresAt: TS,
    runId: '123456789',
  });
  const waiverSummary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          id: '2',
          body: waiverBody,
          author: { login: GITHUB_ACTIONS_LOGIN },
          createdAt: TS,
        },
      ],
    },
    // Trusted list does NOT name github-actions[bot] -- the classifier's own
    // narrow trust must still recognize it.
    { trustedMarkerLogins: TRUSTED },
  );
  assert.equal(waiverSummary.maxActivityUpdatedAt, 'none');
  assert.equal(waiverSummary.totalItemCount, 0);
});

test('buildActivitySnapshotSummary counts the same bodies from an untrusted author', () => {
  for (const body of [HISTORICAL_DIGEST_BODY, REPAIR_EVIDENCE_BODY]) {
    const summary = buildActivitySnapshotSummary(
      {
        comments: [
          {
            id: '1',
            body,
            author: { login: UNTRUSTED_LOGIN },
            createdAt: TS,
          },
        ],
      },
      { trustedMarkerLogins: TRUSTED },
    );
    assert.equal(summary.totalItemCount, 1);
    assert.equal(summary.maxActivityUpdatedAt, TS);
  }
});

test('buildActivitySnapshotSummary counts a github-actions[bot] comment with an unrelated operational prefix', () => {
  const claimedByBody = markerHelpers.renderClaimedByMarker({
    agentId: GITHUB_ACTIONS_LOGIN,
    claimId: CLAIM,
    supersedes: 'none',
    timestamp: TS,
    branch: 'issue/1-test',
  });
  const summary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          id: '1',
          body: claimedByBody,
          author: { login: GITHUB_ACTIONS_LOGIN },
          createdAt: TS,
        },
      ],
    },
    { trustedMarkerLogins: TRUSTED },
  );
  assert.equal(summary.totalItemCount, 1);
  assert.equal(summary.maxActivityUpdatedAt, TS);
});

// ---------------------------------------------------------------------------
// summarizeRegularCommentsForGate (acceptance criteria bullet 3).
// ---------------------------------------------------------------------------

test('summarizeRegularCommentsForGate counts an untrusted marker-shaped comment as regular', () => {
  const body = markerHelpers.renderClaimedByMarker({
    agentId: UNTRUSTED_LOGIN,
    claimId: CLAIM,
    supersedes: 'none',
    timestamp: TS,
    branch: 'issue/1-test',
  });
  const summary = summarizeRegularCommentsForGate(
    [{ id: '1', body, author: { login: UNTRUSTED_LOGIN }, createdAt: TS }],
    { trustedMarkerLogins: TRUSTED },
  );
  assert.equal(summary.count, 1);
});

test('summarizeRegularCommentsForGate excludes a trusted historical digest', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: '1',
        body: HISTORICAL_DIGEST_BODY,
        author: { login: TRUSTED_LOGIN },
        createdAt: TS,
      },
    ],
    { trustedMarkerLogins: TRUSTED },
  );
  assert.equal(summary.count, 0);
});

// ---------------------------------------------------------------------------
// iddAgentLogins vs trustedMarkerLogins non-conflation (last acceptance
// criteria bullet).
// ---------------------------------------------------------------------------

test('a digest from a login present only in iddAgentLogins neither advances lastIddReplyAt nor pairs as a reply', () => {
  const AGENT_ONLY_LOGIN = 'idd-worker-only';
  const humanCommentAt = '2026-05-01T00:00:00Z';
  const digestAt = '2026-05-01T01:00:00Z';

  const regularSummary = summarizeRegularCommentsForGate(
    [
      {
        id: '1',
        body: 'Please fix the typo on line 12.',
        author: { login: 'human-reviewer' },
        createdAt: humanCommentAt,
      },
      {
        id: '2',
        body: CURRENT_DIGEST_BODY,
        author: { login: AGENT_ONLY_LOGIN },
        createdAt: digestAt,
      },
    ],
    {
      // AGENT_ONLY_LOGIN is in iddAgentLogins only, NOT trustedMarkerLogins.
      trustedMarkerLogins: TRUSTED,
      iddAgentLogins: [AGENT_ONLY_LOGIN],
    },
  );
  // The digest must not count as a genuine IDD reply: the human comment
  // stays outstanding (not cleared by lastIddReplyAt advancing past it).
  assert.equal(regularSummary.count, 1);
  assert.equal(regularSummary.items[0]?.id, '1');

  const dispositionSummary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: '1',
          body: 'Please fix the typo on line 12.',
          author: { login: 'human-reviewer' },
          createdAt: humanCommentAt,
        },
        {
          id: '2',
          body: CURRENT_DIGEST_BODY,
          author: { login: AGENT_ONLY_LOGIN },
          createdAt: digestAt,
        },
      ],
    },
    {
      trustedMarkerLogins: TRUSTED,
      iddAgentLogins: [AGENT_ONLY_LOGIN],
    },
  );
  // The digest must not pair as an agent reply clearing the human comment.
  assert.equal(dispositionSummary.missingRegularComments.length, 1);
  assert.equal(dispositionSummary.missingRegularComments[0]?.id, '1');
});

// ---------------------------------------------------------------------------
// E1 doc-list parity: both idd-review-snapshot(-lite).instructions.md
// exclusion lists must name exactly PR_OPERATIONAL_COMMENT_PREFIXES, plus
// `<!-- zero-accepted-path-a-gate:` in the lite list only.
// ---------------------------------------------------------------------------

/**
 * Extracts every backtick-wrapped MARKER PREFIX token from an E1 exclusion
 * bullet-list section: a prefix always ends in a literal `:` (the whole
 * point of a "starts with" match). This deliberately excludes a fully-closed
 * HTML comment literal (e.g. a live-status digest form, which ends in
 * `-->`, not `:` -- a different, non-prefix concept this parity check does
 * not cover, see PR_OPERATIONAL_COMMENT_PREFIXES's own doc comment) and any
 * unrelated backtick-wrapped reference elsewhere in the section (e.g. a
 * filename in the intro sentence).
 */
function extractPrefixTokens(section: string): string[] {
  const spans = [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return spans.filter((span) => span.endsWith(':'));
}

test('the standard E1 exclusion list names exactly PR_OPERATIONAL_COMMENT_PREFIXES', () => {
  const text = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-review-snapshot.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const start = text.indexOf('Exclude **trusted agent operational comments**');
  assert.notEqual(start, -1, 'missing the E1 exclusion intro sentence');
  const end = text.indexOf('Never exclude an untrusted-author', start);
  assert.notEqual(end, -1, 'missing the E1 exclusion list end marker');
  const section = text.slice(start, end);
  const found = extractPrefixTokens(section).sort();
  const expected = [...PR_OPERATIONAL_COMMENT_PREFIXES].sort();
  assert.deepEqual(found, expected);
});

test('the lite E1 exclusion list names exactly PR_OPERATIONAL_COMMENT_PREFIXES (which already includes zero-accepted-path-a-gate)', () => {
  // #3267: zero-accepted-path-a-gate was already present in the STANDARD
  // list (and so already in PR_OPERATIONAL_COMMENT_PREFIXES) before this
  // issue -- only the lite list was missing it. Both lists now name the
  // same 13-entry set; there is no lite-only addition on top of the
  // exported constant, only a lite-only catch-up to parity with it.
  const text = readFileSync(
    new URL(
      '../idd-template/.github/instructions/lite/idd-review-snapshot-lite.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const start = text.indexOf(
    '4. From that raw set, exclude trusted-agent operational marker comments',
  );
  assert.notEqual(start, -1, 'missing the lite E1 exclusion intro sentence');
  const end = text.indexOf('Never exclude an untrusted-author', start);
  assert.notEqual(end, -1, 'missing the lite E1 exclusion list end marker');
  const section = text.slice(start, end);
  const found = extractPrefixTokens(section).sort();
  const expected = [...PR_OPERATIONAL_COMMENT_PREFIXES].sort();
  assert.deepEqual(found, expected);
});

test('sanity: PR_OPERATIONAL_COMMENT_PREFIXES itself omits the digest, forced-handoff, and non-PR-scoped markers', () => {
  for (const excluded of [
    '<!-- activation-nonce:',
    '<!-- forced-handoff:',
    '<!-- idd-provider-outage-declaration:',
    '<!-- idd-provider-outage-advanced:',
    '<!-- idd-provider-outage-park:',
    '<!-- idd-out-of-loop:',
  ]) {
    assert.equal(
      PR_OPERATIONAL_COMMENT_PREFIXES.includes(excluded),
      false,
      `${excluded} must not be in PR_OPERATIONAL_COMMENT_PREFIXES`,
    );
  }
  assert.equal(
    PR_OPERATIONAL_COMMENT_PREFIXES.includes('<!-- zero-accepted-path-a-gate:'),
    true,
    'zero-accepted-path-a-gate is genuinely PR-scoped and must stay included',
  );
});
