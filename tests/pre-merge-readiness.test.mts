import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  renderExternalCheckWaiverComment,
  renderReviewReplyStamp,
} from '../src/scripts/marker-helpers.mts';
import {
  fetchBranchRulesets,
  fetchGovernanceJson,
  normalizeStatusCheckRollupEntry,
  parseArgs,
  resolveDeclarationActiveSince,
  resolveEligibleCodeownerUserLogins,
  resolveToleratedGhFailure,
} from '../src/scripts/pre-merge-readiness.mts';
import {
  buildActivitySnapshotSummary,
  buildAdvisoryWaitSummary,
  buildPreMergeReadinessSummary,
  CODERABBIT_SUMMARY_MARKER,
  classifyCiChecks,
  classifyRegularBotComment,
  computePreMergeReadinessBlockers,
  deriveIddAgentLogins,
  findLastCopilotReviewCommit,
  hasFreshDisposition,
  indexLatestGatingReviewsByAuthor,
  isAdvisoryNonReviewNotice,
  isNonReviewNoticeDisposition,
  resolveActiveClaimForWriteGate,
  resolveCodeownersForFiles,
  resolveRulesetDetailPath,
  selectCodeownersText,
  summarizeAdvisoryWaitMarkers,
  summarizeBranchCurrency,
  summarizeClaimValidation,
  summarizeDispositionEvidenceForGate,
  summarizeExternalCheckWaivers,
  summarizeRegularCommentsForGate,
  summarizeRequiredChecks,
  summarizeReviewerStates,
  summarizeReviewThreadsForGate,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { readJson } from './test-utils.mts';

const readinessSchema = loadJson('schemas/pre-merge-readiness.schema.json');

for (const fixtureName of [
  'clean',
  'ack-only-current',
  'stale-watermark',
  'unresolved-thread',
  'changes-requested',
  'unreplied-comment',
  'ci-not-ready',
  'claim-lost',
]) {
  test(`pre-merge readiness fixture: ${fixtureName}`, () => {
    const fixture = readJson(
      `fixtures/pre-merge-readiness/${fixtureName}.json`,
    );
    const summary = buildPreMergeReadinessSummary(
      fixture.input,
      fixture.options,
    );

    assert.deepEqual(summary, fixture.expected, fixtureName);
    assert.deepEqual(validate(summary, readinessSchema), []);
  });
}

test('pre-merge readiness schema keeps UTC timestamps strict', () => {
  const cleanFixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const cleanSummary = buildPreMergeReadinessSummary(
    cleanFixture.input,
    cleanFixture.options,
  );
  const invalidNow = JSON.parse(JSON.stringify(cleanSummary));
  invalidNow.now = '2026-05-12T00:14:04+09:00';
  assert.ok(validate(invalidNow, readinessSchema).length > 0);

  const unrepliedFixture = readJson(
    'fixtures/pre-merge-readiness/unreplied-comment.json',
  );
  const unrepliedSummary = buildPreMergeReadinessSummary(
    unrepliedFixture.input,
    unrepliedFixture.options,
  );
  const invalidCommentTime = JSON.parse(JSON.stringify(unrepliedSummary));
  invalidCommentTime.unrepliedComments.items[0].createdAt =
    '2026-05-12T00:14:04+09:00';
  assert.ok(validate(invalidCommentTime, readinessSchema).length > 0);

  const invalidCommentId = JSON.parse(JSON.stringify(unrepliedSummary));
  invalidCommentId.unrepliedComments.items[0].id = '';
  assert.ok(validate(invalidCommentId, readinessSchema).length > 0);

  const invalidReviewerTime = JSON.parse(JSON.stringify(cleanSummary));
  invalidReviewerTime.reviewerStates.latestByAuthor[0].submittedAt =
    '2026-05-12T00:14:04+09:00';
  assert.ok(validate(invalidReviewerTime, readinessSchema).length > 0);
});

test('pre-merge readiness optionally emits disposition evidence', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });

  assert.equal(summary.dispositionEvidence?.route, 'proceed');
  assert.equal(summary.dispositionEvidence?.blockingCount, 0);
  assert.deepEqual(validate(summary, readinessSchema), []);
});

test('pre-merge readiness always carries waiverEvidence and the schema requires it', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: false,
  });

  // The summary literal always attaches waiverEvidence (unlike the gated
  // dispositionEvidence), so a normal output carries it and validates.
  assert.ok(
    Object.hasOwn(summary, 'waiverEvidence'),
    'waiverEvidence is always present',
  );
  assert.equal(Object.hasOwn(summary, 'dispositionEvidence'), false);
  assert.deepEqual(validate(summary, readinessSchema), []);

  // Dropping the always-present envelope must fail validation now that the
  // schema lists waiverEvidence in its root `required`.
  const withoutWaiver = JSON.parse(JSON.stringify(summary));
  delete withoutWaiver.waiverEvidence;
  assert.ok(validate(withoutWaiver, readinessSchema).length > 0);

  // dispositionEvidence stays optional: an output that never emits it still
  // validates (the clean summary above), and dropping it from an output that
  // did emit it also validates.
  const withDisposition = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  assert.ok(
    Object.hasOwn(withDisposition, 'dispositionEvidence'),
    'includeDispositionEvidence should emit dispositionEvidence',
  );
  const withoutDisposition = JSON.parse(JSON.stringify(withDisposition));
  delete withoutDisposition.dispositionEvidence;
  assert.deepEqual(validate(withoutDisposition, readinessSchema), []);
});

test('#2323: localValidationEvidence is informational only and never clears a required-check blocker', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/ci-not-ready.json');

  // A caller-supplied resolution reporting valid, present local evidence
  // covering the exact required check the fixture's own CI gate is missing
  // ("test") -- if this field could ever influence the merge gate, this is
  // the shape that would prove it.
  const localValidationEvidenceSummary = {
    present: true,
    reason: '',
    evidence: {
      actor: 'kurone-kito',
      headSha: fixture.input.prHeadSha,
      commandSet: 'pre-push-validate',
      covers: ['lint', 'test'],
      outcome: 'pass',
      createdAt: '2026-05-11T23:59:00Z',
    },
  };

  const baseline = buildPreMergeReadinessSummary(
    fixture.input,
    fixture.options,
  );
  const withEvidence = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    localValidationEvidenceSummary,
  });

  // Additive only: every other field is byte-for-byte identical.
  const withEvidenceMinusField = { ...withEvidence };
  delete (withEvidenceMinusField as { localValidationEvidence?: unknown })
    .localValidationEvidence;
  assert.deepEqual(withEvidenceMinusField, baseline);

  // The field itself carries exactly what was passed in.
  assert.deepEqual(
    (withEvidence as { localValidationEvidence?: unknown })
      .localValidationEvidence,
    localValidationEvidenceSummary,
  );

  // The required-check blocker for the still-missing "test" check survives
  // unchanged, and `ready` stays false: local evidence never derives a
  // merge.
  assert.equal(withEvidence.ready, false);
  assert.deepEqual(withEvidence.blockers, baseline.blockers);
  const withEvidenceBlockers = withEvidence.blockers as {
    gate: string;
    detail: string;
  }[];
  assert.ok(
    withEvidenceBlockers.some((blocker) => blocker.gate === 'ci'),
    'the ci blocker for the missing required check must survive',
  );
  const withEvidenceCi = withEvidence.ci as {
    requiredChecksPassing: boolean;
    missingRequiredCheckNames: string[];
  };
  assert.equal(withEvidenceCi.requiredChecksPassing, false);
  assert.deepEqual(withEvidenceCi.missingRequiredCheckNames, ['test']);

  // Baseline (no evidence supplied) never carries the field at all.
  assert.equal(Object.hasOwn(baseline, 'localValidationEvidence'), false);

  assert.deepEqual(validate(withEvidence, readinessSchema), []);
});

test('pre-merge readiness exposes effective advisory policy', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    requestCap: 12,
    pendingWindowMinutes: 45,
    settledWindowMinutes: 15,
    pollIntervalMinutes: 3,
    capExhaustedRoute: 'hold',
  });

  const advisoryWait = summary.advisoryWait as Record<string, unknown>;
  assert.equal(advisoryWait.requestCap, 12);
  assert.equal(advisoryWait.pendingWindowMinutes, 45);
  assert.equal(advisoryWait.settledWindowMinutes, 15);
  assert.equal(advisoryWait.pollIntervalMinutes, 3);
  assert.equal(advisoryWait.capExhaustedRoute, 'hold');
  assert.deepEqual(validate(summary, readinessSchema), []);
});

test('required check summaries block when no merge-gate policy evidence exists', () => {
  assert.deepEqual(summarizeRequiredChecks([], [], {}), {
    status: 'unknown',
    noRequiredChecksConfigured: true,
    protectionReadsUnreadable: false,
    presentRunConclusion: 'none',
    requiredCheckCount: 0,
    generatedRequiredCheckCount: 0,
    requiredChecksGenerated: false,
    requiredChecksPassing: false,
    requiredCheckNames: [],
    missingRequiredCheckNames: [],
    discardedNonPassingRequiredChecks: [],
    sourcePinnedRequiredCheckNames: [],
    sourcePinnedUnresolved: false,
    checks: [],
  });
});

test('classic branch protection check metadata keeps source-pinned checks conservative', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [],
    { required_status_checks: { checks: [{ context: 'lint', app_id: 1 }] } },
  );

  assert.equal(summary.status, 'unknown');
  assert.deepEqual(summary.requiredCheckNames, ['lint']);
  // #1689: names the specific source-pinned check(s) so a blocker detail can
  // cite the real cause instead of a generic CI message.
  assert.deepEqual(summary.sourcePinnedRequiredCheckNames, ['lint']);
});

test('classic branch protection app_id -1 does not force source-pinned status', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [],
    { required_status_checks: { checks: [{ context: 'lint', app_id: -1 }] } },
  );

  assert.equal(summary.status, 'success');
  assert.deepEqual(summary.requiredCheckNames, ['lint']);
  assert.deepEqual(summary.sourcePinnedRequiredCheckNames, []);
});

// #1689: the `ciGate.trustSourcePinnedRequiredChecks` opt-in lets a
// repository operator who has verified out-of-band that the pinned
// integration is the sole producer of a named required check treat its
// green state as trusted, instead of being permanently stuck at `unknown`
// with no passing path at all (the bug this option fixes).
test('trustSourcePinnedRequiredChecks opts a source-pinned but present-and-passing required check into success', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [],
    { required_status_checks: { checks: [{ context: 'lint', app_id: 1 }] } },
    { trustSourcePinnedRequiredChecks: true },
  );

  assert.equal(summary.status, 'success');
  assert.equal(summary.requiredChecksPassing, true);
  assert.deepEqual(summary.sourcePinnedRequiredCheckNames, []);
});

// The knob must not relax the fully-unnamed pinned case (a ruleset
// `workflows` rule with no enumerable check name): there is no check name
// to correlate with a live run at all, so `noRequiredChecksConfigured`
// stays false regardless of the opt-in.
test('trustSourcePinnedRequiredChecks does not relax an unnamed workflows-rule pin', () => {
  const summary = summarizeRequiredChecks(
    [],
    [{ type: 'workflows', parameters: {} }],
    {},
    { trustSourcePinnedRequiredChecks: true },
  );

  assert.equal(summary.noRequiredChecksConfigured, false);
});

test('required workflow rules keep CI conservative even when named checks pass', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [
      {
        type: 'workflows',
        parameters: {
          workflows: [{ repository_id: 1, path: '.github/workflows/ci.yml' }],
        },
      },
    ],
    { required_status_checks: { contexts: ['lint'] } },
  );

  assert.equal(summary.status, 'unknown');
  assert.equal(summary.requiredChecksPassing, false);
  // #1689: the `lint` context itself is not individually pinned (only the
  // sibling `workflows` rule is), so it never lands in
  // sourcePinnedRequiredCheckNames -- but the downgrade must still be
  // attributable via sourcePinnedUnresolved, so a blocker detail can name
  // the cause instead of falling through to the generic CI message.
  assert.deepEqual(summary.sourcePinnedRequiredCheckNames, []);
  assert.equal(summary.sourcePinnedUnresolved, true);
});

// #1689: the opt-in must not relax this mixed case even though the named
// `lint` check would itself qualify -- the sibling `workflows` rule has no
// check name to correlate with a live run at all, so it stays fail-closed
// regardless of trustSourcePinnedRequiredChecks.
test('trustSourcePinnedRequiredChecks does not relax a mixed named-check-plus-workflows-rule pin', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [
      {
        type: 'workflows',
        parameters: {
          workflows: [{ repository_id: 1, path: '.github/workflows/ci.yml' }],
        },
      },
    ],
    { required_status_checks: { contexts: ['lint'] } },
    { trustSourcePinnedRequiredChecks: true },
  );

  assert.equal(summary.status, 'unknown');
  assert.equal(summary.requiredChecksPassing, false);
  assert.equal(summary.sourcePinnedUnresolved, true);
});

test('CODEOWNERS patterns with slashes stay root anchored', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('docs/* @org/docs\n', [
      'docs/file.md',
      'src/docs/file.md',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: ['src/docs/file.md'],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/docs'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS **/ patterns match both root and nested files', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('**/README.md @org/docs\n', [
      'README.md',
      'docs/README.md',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/docs'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS middle **/ segments match zero or more directories', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('docs/**/README.md @org/docs\n', [
      'docs/README.md',
      'docs/guides/README.md',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/docs'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS trailing slash patterns match directories at any depth', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('apps/ @org/apps\n', [
      'apps/main.ts',
      'src/apps/main.ts',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/apps'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS directory-style patterns match descendants', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('**/logs @org/ops\n', ['build/logs/app.log']),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/ops'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS dot-prefixed directory patterns match descendants', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('.github @org/automation\n', [
      '.github/workflows/ci.yml',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/automation'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS dotted literal patterns match descendant paths', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('proto.v1 @org/api\n', [
      'proto.v1/service.proto',
      'src/proto.v1/service.proto',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/api'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS patterns preserve escaped spaces', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('docs/My\\ File.md @org/docs\n', [
      'docs/My File.md',
    ]),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ['org/docs'],
      codeownerEmailAddresses: [],
    },
  );
});

test('CODEOWNERS ownerless overrides clear inherited ownership', () => {
  assert.deepEqual(
    resolveCodeownersForFiles('/apps/ @org/apps\n/apps/github\n', [
      'apps/github/routes.ts',
    ]),
    {
      ruleCount: 2,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: [],
      codeownerEmailAddresses: [],
    },
  );
});

test('higher-priority empty CODEOWNERS files stop fallback to lower-priority locations', () => {
  assert.equal(
    selectCodeownersText([
      {},
      { content: '' },
      { content: Buffer.from('*.js @org/root\n').toString('base64') },
    ]),
    '',
  );
});

test('required reviewer rule objects stay blocking until GitHub marks approval satisfied', () => {
  const branchRules = [
    {
      type: 'pull_request',
      parameters: {
        required_reviewers: [
          {
            reviewer: { type: 'Team', id: 42 },
            minimum_approvals: 1,
          },
        ],
      },
    },
  ];

  const pending = summarizeReviewerStates([], {
    branchRules,
    reviewDecision: '',
  });
  assert.equal(pending.requiredApprovalsSatisfied, false);
  assert.deepEqual(pending.requiredReviewerTeams, ['team/42']);

  const approved = summarizeReviewerStates([], {
    branchRules,
    reviewDecision: 'APPROVED',
  });
  assert.equal(approved.requiredApprovalsSatisfied, true);
});

test('required reviewer file patterns only apply when changed files match', () => {
  const branchRules = [
    {
      type: 'pull_request',
      parameters: {
        required_reviewers: [
          {
            reviewer: { type: 'Team', id: 42 },
            minimum_approvals: 1,
            file_patterns: ['docs/**'],
          },
        ],
      },
    },
  ];

  const nonMatching = summarizeReviewerStates([], {
    branchRules,
    changedFiles: ['src/index.js'],
    reviewDecision: '',
  });
  assert.equal(nonMatching.requiredApprovalsSatisfied, true);

  const matching = summarizeReviewerStates([], {
    branchRules,
    changedFiles: ['docs/idd-workflow.md'],
    reviewDecision: '',
  });
  assert.equal(matching.requiredApprovalsSatisfied, false);
});

test('reviewDecision blocks approval-count fallback when GitHub still requires review', () => {
  const summary = summarizeReviewerStates(
    [
      {
        author: { login: 'reviewer' },
        state: 'APPROVED',
        submittedAt: '2026-05-12T00:25:11Z',
      },
    ],
    {
      branchRules: [
        {
          type: 'pull_request',
          parameters: { required_approving_review_count: 1 },
        },
      ],
      reviewDecision: 'REVIEW_REQUIRED',
    },
  );

  assert.equal(summary.requiredApprovalsSatisfied, false);
});

test('advisory bots do not block CHANGES_REQUESTED even when configured in policy', () => {
  const summary = summarizeReviewerStates(
    [
      {
        author: { login: 'copilot-pull-request-reviewer' },
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-05-12T00:25:11Z',
      },
    ],
    {
      advisoryBotLogins: ['copilot-pull-request-reviewer'],
      branchRules: [
        {
          type: 'pull_request',
          parameters: {
            required_reviewers: [
              { login: 'copilot-pull-request-reviewer', minimum_approvals: 1 },
            ],
            require_code_owner_review: true,
          },
        },
      ],
      codeownersText: '* @copilot-pull-request-reviewer',
      changedFiles: ['docs/idd-workflow.md'],
    },
  );

  assert.equal(summary.humanChangesRequestedCount, 0);
  assert.deepEqual(summary.blockingChangesRequestedLogins, []);
});

// #1818: buildPreMergeReadinessSummary threads options.primaryBotLogin to
// buildAdvisoryWaitSummary, but the summarizeReviewerStates(reviews, {...})
// call inside that same function only forwarded advisoryBotLogins -- a
// configured custom primaryBotLogin (not one of isKnownReviewBot's hardcoded
// Copilot forms, and not separately added to advisoryBotLogins) was silently
// counted as a human approval. Exercised end to end through
// buildPreMergeReadinessSummary, passing primaryBotLogin as its own option
// the way a real caller would -- not by adding the custom login to
// advisoryBotLogins in the test setup, which would validate the classifier
// without proving the wiring gap is closed.
test('buildPreMergeReadinessSummary: primaryBotLogin is excluded from human approval and codeowner-approval counting', () => {
  const prHeadSha = '4444444444444444444444444444444444444444';
  const customBotLogin = 'my-custom-review-bot[bot]';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: customBotLogin },
          state: 'APPROVED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: `* @${customBotLogin}\n`,
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      // Deliberately not 'APPROVED', so codeownerApprovalSatisfied cannot be
      // trivially satisfied by reviewDecision alone -- it must come from
      // codeownerApproved, the field this fix protects.
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      // The custom login is intentionally absent here -- proving the fix
      // works via primaryBotLogin alone.
      advisoryBotLogins: [],
      primaryBotLogin: customBotLogin,
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.humanApprovedCount, 0);
  assert.equal(reviewerStates.codeownerApprovalSatisfied, false);
});

// #2251 (Copilot review follow-up on PR #2387): detectMalformedReviewWatermarkComments
// has its own unit coverage in review-gate.test.mts, but nothing previously
// exercised buildPreMergeReadinessSummary's end-to-end wiring of it into
// reviewCurrency.comparisonReason -- a future refactor could silently break
// that wiring without a red test. This proves a review-watermark-shaped
// comment whose note is glued directly to the leading underscore (`_IDD ...`,
// no space, missing OPTIONAL_IDD_VISIBLE_NOTE_PATTERN's `\bIDD\b` boundary)
// surfaces as 'malformed-watermark', not the generic 'missing-watermark'.
test('buildPreMergeReadinessSummary: a malformed review-watermark comment surfaces a distinct comparisonReason', () => {
  const prHeadSha = '7777777777777777777777777777777777777777';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: [
            `<!-- review-watermark: claude-x claim-1 ${prHeadSha} none 0 none -->`,
            '_IDD note glued directly to the leading underscore, no space before it_',
          ].join('\n'),
          createdAt: '2026-08-02T00:00:00Z',
        },
      ],
    },
    {
      now: '2026-08-02T00:05:00Z',
      trustedMarkerLogins: ['kurone-kito'],
      expectedClaimId: 'claim-1',
    },
  );

  const reviewCurrency = summary.reviewCurrency as Record<string, unknown>;
  assert.equal(reviewCurrency.comparisonRoute, 'return-to-e1');
  assert.equal(reviewCurrency.comparisonReason, 'malformed-watermark');
});

test('buildPreMergeReadinessSummary: primaryBotLogin CHANGES_REQUESTED does not block via reviewer-approval counting', () => {
  const prHeadSha = '5555555555555555555555555555555555555555';
  const customBotLogin = 'my-custom-review-bot[bot]';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: customBotLogin },
          state: 'CHANGES_REQUESTED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: `* @${customBotLogin}\n`,
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      advisoryBotLogins: [],
      primaryBotLogin: customBotLogin,
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.deepEqual(reviewerStates.blockingChangesRequestedLogins, []);
});

// #1818 (C1 critique follow-up): the same wiring gap applied to the literal
// *default* primary bot login, not just a configured custom one --
// `isKnownReviewBot` never recognized the bare `copilot` form (only the
// `copilot-pull-request-reviewer*` forms), so a real caller like
// `collectPreMergeReadiness` (which always sources `primaryBotLogin`,
// defaulting to `'copilot'`) previously left a bare-`'copilot'` review
// uncounted as an advisory bot even under fully default/unconfigured policy.
// `isCopilotReviewerLogin` elsewhere in this file already treats `'copilot'`
// as a genuine Copilot login form, so excluding it here is the intended
// default-identity behavior, not a regression -- see the retroactive plan
// comment on the issue for the full record.
test('buildPreMergeReadinessSummary: the bare "copilot" default identity is excluded from human/codeowner approval counting under default primaryBotLogin', () => {
  const prHeadSha = '6666666666666666666666666666666666666666';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: 'copilot' },
          state: 'APPROVED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: '* @copilot\n',
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      // Mirrors collectPreMergeReadiness's real default: no advisoryBotLogins
      // configured, primaryBotLogin explicitly at its default value.
      advisoryBotLogins: [],
      primaryBotLogin: 'copilot',
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.humanApprovedCount, 0);
  assert.equal(reviewerStates.codeownerApprovalSatisfied, false);
});

// #1818 (Copilot review follow-up, PR #1826): unlike `buildAdvisoryWaitSummary`
// a few lines below in the same function (which normalizes and defaults
// `primaryBotLogin` to `DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN` when the option is
// omitted/blank), the initial `reviewerStateAdvisoryBotLogins` fix unioned
// `options.primaryBotLogin` directly -- an omitted option dropped out of the
// union entirely (`normalizeTrustedMarkerLogins` filters empty strings), so a
// caller that OMITS `primaryBotLogin` (relying on defaulting, unlike this
// file's own `collectPreMergeReadiness`, which always resolves a non-empty
// value) still would not classify a bare `'copilot'` review as advisory here.
// This test omits `primaryBotLogin` entirely (the previous test above passes
// it explicitly), proving the default-resolution path itself, not just the
// explicit-value path.
test('buildPreMergeReadinessSummary: bare "copilot" is excluded even when primaryBotLogin is omitted entirely (relies on default resolution)', () => {
  const prHeadSha = '8888888888888888888888888888888888888888';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: 'copilot' },
          state: 'APPROVED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: '* @copilot\n',
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      advisoryBotLogins: [],
      // primaryBotLogin intentionally omitted -- must still default.
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.humanApprovedCount, 0);
  assert.equal(reviewerStates.codeownerApprovalSatisfied, false);
});

// #1818 (C1 critique round 2 follow-up): the `codeownerApproved` narrowing
// (adding `review.isHuman` to its filter, see the change above) is a
// behavior change for EVERY advisory bot recognized as an "advisory bot"
// classification -- not just the primaryBotLogin cases covered above.
// `isKnownReviewBot` already recognized `coderabbitai[bot]` before this
// fix, so if such a bot is ever listed as a CODEOWNER, its own approval no
// longer satisfies `codeownerApprovalSatisfied` -- previously it did,
// since `codeownerApproved` never checked `isHuman`/`isAdvisoryBot` at all.
// Locking this in explicitly so the default-identity behavior change is
// covered by a named regression, not just inferred from the primaryBotLogin
// tests above.
test('buildPreMergeReadinessSummary: a default-recognized advisory bot (CodeRabbit) as sole CODEOWNER does not satisfy codeowner-approval', () => {
  const prHeadSha = '7777777777777777777777777777777777777777';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: 'coderabbitai[bot]' },
          state: 'APPROVED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: '* @coderabbitai[bot]\n',
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      reviewDecision: 'REVIEW_REQUIRED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      advisoryBotLogins: [],
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.humanApprovedCount, 0);
  assert.equal(reviewerStates.codeownerApprovalSatisfied, false);
});

// #1837: unlike the tests above (which all deliberately use
// `reviewDecision: 'REVIEW_REQUIRED'` so `codeownerApprovalSatisfied` cannot
// be trivially satisfied by the aggregate alone), this test uses the exact
// scenario the issue describes: GitHub's own `reviewDecision` resolves
// `APPROVED` purely because a bot's review carries `state: 'APPROVED'` (the
// 2026-08-01 GitHub rollout described in #1818's background), with a
// `required_approving_review_count: 1` repo config -- the scenario the issue
// itself names as the one that actually needs this fix. Full review data is
// available to the caller (the normal `collectPreMergeReadiness` path,
// `reviewsUnreadable` omitted/defaulted false), so the classified data
// (`humanApprovedCount: 0`) must still block both gates despite the
// `APPROVED` aggregate.
test('buildPreMergeReadinessSummary: a bot-only APPROVED review does not satisfy codeowner/required-approval gates via the reviewDecision aggregate bypass when review data is classifiable', () => {
  const prHeadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const botLogin = 'coderabbitai[bot]';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [
        {
          author: { login: botLogin },
          state: 'APPROVED',
          commitId: prHeadSha,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      ],
      changedFiles: ['README.md'],
      codeownersText: `* @${botLogin}\n`,
      branchRules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
          },
        },
      ],
      // GitHub's own aggregate says APPROVED, but the only review backing
      // it is the bot's -- this is the bug scenario, not a legitimate pass.
      reviewDecision: 'APPROVED',
    },
    {
      now: '2026-08-02T00:05:00Z',
      advisoryBotLogins: [],
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.humanApprovedCount, 0);
  assert.equal(reviewerStates.codeownerApprovalSatisfied, false);
  assert.equal(reviewerStates.requiredApprovalsSatisfied, false);
});

// #1837: the mirror case -- when the caller genuinely could not
// fetch/classify individual reviews (`reviewsUnreadable: true`, `reviews`
// empty even though a bot approval exists server-side), GitHub's own
// aggregate `reviewDecision` remains the only available signal and must
// still satisfy both gates, exactly as it did before this fix. This proves
// the new signal is a real fallback, not a blanket removal of the bypass.
test('buildPreMergeReadinessSummary: reviewsUnreadable lets the reviewDecision aggregate satisfy codeowner/required-approval gates when the caller could not classify reviews', () => {
  const prHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const botLogin = 'coderabbitai[bot]';
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      reviews: [],
      changedFiles: ['README.md'],
      codeownersText: `* @${botLogin}\n`,
      branchRules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
          },
        },
      ],
      reviewDecision: 'APPROVED',
      reviewsUnreadable: true,
    },
    {
      now: '2026-08-02T00:05:00Z',
      advisoryBotLogins: [],
    },
  );

  const reviewerStates = summary.reviewerStates as Record<string, unknown>;
  assert.equal(reviewerStates.codeownerApprovalSatisfied, true);
  assert.equal(reviewerStates.requiredApprovalsSatisfied, true);
});

test('email-only CODEOWNERS rules still block codeowner approval', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: {
          require_code_owner_review: true,
        },
      },
    ],
    codeownersText: '*.js user@example.com\n',
    changedFiles: ['app.js'],
  });

  assert.equal(summary.codeownerApprovalSatisfied, false);
  assert.deepEqual(summary.unmatchedCodeownerFiles, []);
});

test('self-CODEOWNER diagnostic reports deadlock without bypass', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      { id: 1, current_user_can_bypass: 'never', bypass_actors: [] },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.deepEqual(summary.codeownerSelfApproval, {
    status: 'deadlock',
    reason: 'pr-author-is-only-direct-codeowner',
    prAuthorLogin: 'author',
    directCodeownerUserLogins: ['author'],
    codeownerTeamSlugs: [],
    requireCodeOwnerReview: true,
    codeownerApprovalSatisfied: false,
    bypassDetected: false,
    bypassMode: 'none',
    currentUserCanBypass: 'never',
    rulesetBypassUnreadable: false,
    prAuthorIsSoleEligibleCodeowner: true,
    codeownerEligibilityUnreadable: false,
  });
});

// #1380: when the sole-direct-codeowner-is-the-author ruleset's own detail
// read was masked-404 (unreadable), `bypass.detected` could not rule out an
// actual configured bypass -- asserting a *certain* `deadlock` would be an
// unjustified false-certainty diagnostic. Downgrade to the
// already-documented `possible_deadlock` instead.
test('self-CODEOWNER diagnostic downgrades a certain deadlock to possible_deadlock when the ruleset bypass detail is unreadable', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    // The one codeowner-requiring ruleset's own detail 404'd and was
    // dropped, so `branchRulesets` is empty even though a ruleset is
    // referenced by `branchRules`.
    branchRulesets: [],
    branchRulesetsUnreadable: true,
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.deepEqual(summary.codeownerSelfApproval, {
    status: 'possible_deadlock',
    reason: 'ruleset-bypass-unreadable',
    prAuthorLogin: 'author',
    directCodeownerUserLogins: ['author'],
    codeownerTeamSlugs: [],
    requireCodeOwnerReview: true,
    codeownerApprovalSatisfied: false,
    bypassDetected: false,
    bypassMode: 'none',
    currentUserCanBypass: 'unknown',
    rulesetBypassUnreadable: true,
    prAuthorIsSoleEligibleCodeowner: true,
    codeownerEligibilityUnreadable: false,
  });
});

// A globally unreadable ruleset detail that is *irrelevant* to this PR (no
// codeowner-requiring ruleset referenced at all) must not manufacture a
// diagnostic -- `rulesetBypassUnreadable` stays `false` and the existing
// deadlock-free `not_applicable` outcome is unaffected.
test('self-CODEOWNER diagnostic ignores an unreadable ruleset detail when no codeowner-requiring ruleset applies', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [],
    branchRulesets: [],
    branchRulesetsUnreadable: true,
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'not_applicable');
  assert.equal(summary.codeownerSelfApproval.rulesetBypassUnreadable, false);
});

// A relevant ruleset detail that *was* successfully read (bypass genuinely
// not detected, e.g. `current_user_can_bypass: 'never'`) must not be
// downgraded just because some *other*, unrelated ruleset in the same fetch
// was unreadable -- `detected` already ruling out this ruleset is real data,
// not an artifact of the drop.
test('self-CODEOWNER diagnostic keeps a certain deadlock when the relevant ruleset detail was actually read', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      { id: 1, current_user_can_bypass: 'never', bypass_actors: [] },
    ],
    // Some other, unrelated ruleset in the same fetch was unreadable, but
    // ruleset 1 (the only codeowner-requiring one) was fully read.
    branchRulesetsUnreadable: true,
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pr-author-is-only-direct-codeowner',
  );
  assert.equal(summary.codeownerSelfApproval.rulesetBypassUnreadable, false);
});

// #1380: two codeowner-requiring rulesets, only one of which 404'd on its
// detail read. `relevantRulesets.length` (1) falls short of
// `expectedRulesetCount` (2) -- the exact partial-drop shape the
// `relevantRulesets.length < expectedRulesetCount` formula (as opposed to a
// coarser `!detected` check) exists to detect.
test('self-CODEOWNER diagnostic reports unreadable when only one of several codeowner-requiring rulesets is missing', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
      {
        type: 'pull_request',
        ruleset_id: 2,
        parameters: { require_code_owner_review: true },
      },
    ],
    // Ruleset 2's detail 404'd and was dropped; ruleset 1 was fully read.
    branchRulesets: [
      { id: 1, current_user_can_bypass: 'never', bypass_actors: [] },
    ],
    branchRulesetsUnreadable: true,
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'possible_deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'ruleset-bypass-unreadable',
  );
  assert.equal(summary.codeownerSelfApproval.rulesetBypassUnreadable, true);
});

test('self-CODEOWNER diagnostic clears when another direct owner exists', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [{ current_user_can_bypass: 'never', bypass_actors: [] }],
    codeownersText: '* @author @reviewer\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'non-author-codeowner-available',
  );
  assert.deepEqual(summary.codeownerSelfApproval.directCodeownerUserLogins, [
    'author',
    'reviewer',
  ]);
});

test('self-CODEOWNER diagnostic requires eligible non-author direct owners when provided', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [{ current_user_can_bypass: 'never', bypass_actors: [] }],
    codeownersText: '* @author @outside-user\n',
    changedFiles: ['README.md'],
    eligibleCodeownerUserLogins: ['author'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pr-author-is-only-eligible-direct-codeowner',
  );
  assert.deepEqual(summary.codeownerSelfApproval.directCodeownerUserLogins, [
    'author',
    'outside-user',
  ]);
  assert.equal(summary.latestByAuthor.length, 0);
});

test('self-CODEOWNER diagnostic counts only eligible codeowner approvals when provided', () => {
  const summary = summarizeReviewerStates(
    [
      {
        author: { login: 'outside-user' },
        state: 'APPROVED',
        submittedAt: '2026-05-12T00:00:00Z',
      },
    ],
    {
      branchRules: [
        {
          type: 'pull_request',
          parameters: { require_code_owner_review: true },
        },
      ],
      codeownersText: '* @author @outside-user\n',
      changedFiles: ['README.md'],
      eligibleCodeownerUserLogins: ['author'],
      prAuthorLogin: 'author',
    },
  );

  assert.equal(summary.latestByAuthor[0].isCodeowner, false);
  assert.equal(summary.codeownerApprovalSatisfied, false);
  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
});

test('self-CODEOWNER diagnostic stays conservative when a team owner is present', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [{ current_user_can_bypass: 'never', bypass_actors: [] }],
    codeownersText: '* @author @org/reviewers\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'possible_deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'team-codeowner-ambiguous',
  );
  assert.deepEqual(summary.codeownerSelfApproval.codeownerTeamSlugs, [
    'org/reviewers',
  ]);
});

test('self-CODEOWNER diagnostic stays conservative when an email owner is present', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [{ current_user_can_bypass: 'never', bypass_actors: [] }],
    codeownersText: '* @author reviewer@example.com\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'possible_deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'email-codeowner-ambiguous',
  );
});

test('self-CODEOWNER diagnostic is not applicable when CODEOWNER review is disabled', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: false },
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'not_applicable');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'codeowner-review-not-required',
  );
});

test('self-CODEOWNER diagnostic clears when pull-request bypass is available', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'pull_request');
  // #1521: the genuine solo-CODEOWNER-deadlock topology -- the only shape
  // an F3 auto-`--admin` retry may key on.
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    true,
  );
});

// #1521 multi-CODEOWNER safety property (required by the issue's
// acceptance criteria before the auto-`--admin` retry may become the
// distributed default): a genuinely outstanding review from a DIFFERENT,
// non-author codeowner must never be indistinguishable from the solo-author
// self-approval deadlock, even though both report `status: 'clear'` here
// (the general gate intentionally keeps its existing shape -- see the
// `applicableBypassDetected` branch in `summarizeCodeownerSelfApproval`,
// which fires before the non-author-owner check runs and is unaffected by
// this test). `prAuthorIsSoleEligibleCodeowner` is the narrow, additive
// discriminator: it is `false` here specifically because a real non-author
// codeowner exists, so a caller gating the retry on this field (in addition
// to `status`/`reason`) never fires while that owner's review is
// genuinely outstanding.
test('#1521: a non-author codeowner is not folded into the self-CODEOWNER-deadlock topology even when a bypass actor is also configured', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author @reviewer\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  // Unchanged general-gate shape: the bypass-detected branch still resolves
  // first, exactly as it does in the solo-owner case above.
  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  // The safety-critical discriminator: a real non-author codeowner
  // (`reviewer`) exists, so this is NOT the self-approval deadlock.
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    false,
  );
});

test('#1521: a team codeowner alongside an author-only direct match is not a sole-eligible-codeowner topology', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author @org/reviewers\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    false,
  );
});

test('#1521: the sole-eligible-codeowner topology fact is exposed regardless of eligibility narrowing', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [{ current_user_can_bypass: 'never', bypass_actors: [] }],
    codeownersText: '* @author @outside-user\n',
    changedFiles: ['README.md'],
    eligibleCodeownerUserLogins: ['author'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    true,
  );
});

// #1521 (Codex review on PR #1537): a transient/auth/rate-limit failure
// while reading a non-author codeowner's collaborator permission must
// never silently narrow the eligible set the same way a genuine 404
// ("not a collaborator") does -- doing so would make the PR author look
// like the sole eligible codeowner while a real co-owner's eligibility
// simply could not be confirmed.
test('resolveEligibleCodeownerUserLogins excludes a login on a genuine 404 (not a collaborator)', () => {
  const result = resolveEligibleCodeownerUserLogins(
    'o',
    'r',
    ['author', 'reviewer'],
    (login) => {
      if (login === 'author') {
        return 'write';
      }
      throw Object.assign(new Error('Command failed'), {
        stderr: 'gh: Not Found (HTTP 404)',
      });
    },
  );
  assert.deepEqual(result.eligible, ['author']);
  assert.equal(result.unreadable, false);
});

test('resolveEligibleCodeownerUserLogins flags unreadable on a transient failure instead of silently excluding the login', () => {
  const result = resolveEligibleCodeownerUserLogins(
    'o',
    'r',
    ['author', 'reviewer'],
    (login) => {
      if (login === 'author') {
        return 'write';
      }
      // 403 (rate limit / permission), not 404 -- cannot be told apart
      // from "genuinely not a collaborator" by the caller.
      throw Object.assign(new Error('Command failed'), {
        stderr: 'gh: API rate limit exceeded (HTTP 403)',
      });
    },
  );
  // 'reviewer' is still excluded from the eligible list (the caller has
  // no proof it IS eligible), but `unreadable: true` distinguishes this
  // from the genuine-404 case above.
  assert.deepEqual(result.eligible, ['author']);
  assert.equal(result.unreadable, true);
});

test('resolveEligibleCodeownerUserLogins flags unreadable on a network/timeout failure with no HTTP status at all', () => {
  const result = resolveEligibleCodeownerUserLogins(
    'o',
    'r',
    ['author', 'reviewer'],
    (login) => {
      if (login === 'author') {
        return 'write';
      }
      throw Object.assign(new Error('Command failed'), {
        stderr: 'connect ETIMEDOUT 140.82.0.0:443',
      });
    },
  );
  assert.deepEqual(result.eligible, ['author']);
  assert.equal(result.unreadable, true);
});

test('resolveEligibleCodeownerUserLogins is readable (unreadable: false) when every lookup succeeds or 404s', () => {
  const result = resolveEligibleCodeownerUserLogins(
    'o',
    'r',
    ['author', 'former-owner'],
    (login) => {
      if (login === 'author') {
        return 'write';
      }
      throw Object.assign(new Error('Command failed'), {
        stderr: 'gh: Not Found (HTTP 404)',
      });
    },
  );
  assert.deepEqual(result.eligible, ['author']);
  assert.equal(result.unreadable, false);
});

// #1521 crux: even though a narrowed eligible set makes the author LOOK
// like the sole eligible codeowner (exactly the shape the earlier
// solo-owner test asserts `true` for), `eligibleCodeownerUserLoginsUnreadable`
// must force `prAuthorIsSoleEligibleCodeowner` to `false` -- the multi-
// CODEOWNER safety property must hold even when the reason a co-owner
// looks absent is an unreadable lookup, not a genuine absence.
test('#1521: prAuthorIsSoleEligibleCodeowner is false when eligibility narrowing was unreadable, even with an otherwise-solo-looking set', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author @reviewer\n',
    changedFiles: ['README.md'],
    // As far as the (incomplete) eligible set can tell, only 'author' is
    // eligible -- this is the exact shape that otherwise reads as the
    // genuine solo-owner deadlock.
    eligibleCodeownerUserLogins: ['author'],
    eligibleCodeownerUserLoginsUnreadable: true,
    prAuthorLogin: 'author',
  });

  // The general gate is unaffected -- still 'clear' via the bypass actor,
  // matching every adopter repo's existing behavior.
  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  // The safety-critical discriminator fails closed on the unreadable flag.
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    false,
  );
  assert.equal(
    summary.codeownerSelfApproval.codeownerEligibilityUnreadable,
    true,
  );
});

test('#1521: codeownerEligibilityUnreadable defaults to false and does not affect the true solo-owner case', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(
    summary.codeownerSelfApproval.codeownerEligibilityUnreadable,
    false,
  );
  assert.equal(
    summary.codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner,
    true,
  );
});

test('self-CODEOWNER diagnostic clears when an always ruleset bypass is available', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'always',
        bypass_actors: [
          { actor_id: 44661432, actor_type: 'User', bypass_mode: 'always' },
        ],
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'ruleset-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'always');
});

test('self-CODEOWNER diagnostic keeps classic protection outside ruleset bypass', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pr-author-is-only-direct-codeowner',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, false);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'none');
  assert.equal(
    summary.codeownerSelfApproval.currentUserCanBypass,
    'pull_requests_only',
  );
});

test('self-CODEOWNER diagnostic honors classic pull request bypass allowances', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        bypass_pull_request_allowances: {
          users: [{ login: 'author' }],
        },
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
    viewerLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'pull_request');
});

test('self-CODEOWNER diagnostic honors classic bypass without ruleset gates', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        bypass_pull_request_allowances: {
          users: [{ login: 'author' }],
        },
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
    viewerLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'pull_request');
});

test('self-CODEOWNER diagnostic honors classic team bypass allowances', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        bypass_pull_request_allowances: {
          teams: [{ slug: 'release-engineers' }],
        },
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
    viewerTeamSlugs: ['release-engineers'],
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'pull_request');
});

test('self-CODEOWNER diagnostic honors classic app bypass allowances', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        parameters: { require_code_owner_review: true },
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        bypass_pull_request_allowances: {
          apps: [{ slug: 'idd-helper' }],
        },
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
    viewerAppSlug: 'idd-helper',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pull-request-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'pull_request');
});

test('ruleset detail path uses the source-specific endpoint', () => {
  assert.equal(
    resolveRulesetDetailPath(
      'repo-owner',
      'example',
      {
        ruleset_source_type: 'Repository',
      },
      101,
    ),
    'repos/repo-owner/example/rulesets/101',
  );
  assert.equal(
    resolveRulesetDetailPath(
      'repo-owner',
      'example',
      {
        ruleset_source_type: 'Organization',
        ruleset_source: 'platform-org',
      },
      102,
    ),
    'orgs/platform-org/rulesets/102',
  );
  assert.equal(
    resolveRulesetDetailPath(
      'repo-owner',
      'example',
      {
        ruleset_source_type: 'Enterprise',
        ruleset_source: 'platform-enterprise',
      },
      103,
    ),
    'enterprises/platform-enterprise/rulesets/103',
  );
});

test('self-CODEOWNER diagnostic fails closed when ruleset details are missing', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchProtection: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        bypass_pull_request_allowances: {
          users: [{ login: 'author' }],
        },
      },
    },
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
    viewerLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pr-author-is-only-direct-codeowner',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, false);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'none');
});

test('self-CODEOWNER diagnostic ignores unrelated ruleset bypasses', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 2,
        current_user_can_bypass: 'pull_requests_only',
        bypass_actors: [
          {
            actor_id: 44661432,
            actor_type: 'User',
            bypass_mode: 'pull_request',
          },
        ],
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'deadlock');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'pr-author-is-only-direct-codeowner',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, false);
  assert.equal(summary.codeownerSelfApproval.currentUserCanBypass, 'unknown');
});

test('self-CODEOWNER diagnostic accepts GitHub exempt bypass token', () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: { require_code_owner_review: true },
      },
    ],
    branchRulesets: [
      {
        id: 1,
        current_user_can_bypass: 'exempt',
        bypass_actors: [
          { actor_id: 44661432, actor_type: 'User', bypass_mode: 'exempt' },
        ],
      },
    ],
    codeownersText: '* @author\n',
    changedFiles: ['README.md'],
    prAuthorLogin: 'author',
  });

  assert.equal(summary.codeownerSelfApproval.status, 'clear');
  assert.equal(
    summary.codeownerSelfApproval.reason,
    'ruleset-bypass-available',
  );
  assert.equal(summary.codeownerSelfApproval.bypassDetected, true);
  assert.equal(summary.codeownerSelfApproval.bypassMode, 'exempt');
  assert.equal(summary.codeownerSelfApproval.currentUserCanBypass, 'exempt');
});

test('mixed-precision timestamps compare by time instead of string order', () => {
  const headSha = 'a'.repeat(40);
  assert.equal(
    summarizeAdvisoryWaitMarkers(
      [
        {
          body: `advisory-wait: kurone-kito ${headSha} 2026-05-12T00:00:00Z`,
          createdAt: '2026-05-12T00:00:00Z',
          author: { login: 'kurone-kito' },
        },
        {
          body: `advisory-wait: kurone-kito ${headSha} 2026-05-12T00:00:00.100Z`,
          createdAt: '2026-05-12T00:00:00.100Z',
          author: { login: 'kurone-kito' },
        },
      ],
      headSha,
      ['kurone-kito'],
    ).earliestSameHeadAt,
    '2026-05-12T00:00:00Z',
  );

  assert.equal(
    buildActivitySnapshotSummary({
      comments: [
        {
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
          body: 'a',
          author: { login: 'reviewer' },
        },
        {
          createdAt: '2026-05-12T00:00:00.100Z',
          updatedAt: '2026-05-12T00:00:00.100Z',
          body: 'b',
          author: { login: 'reviewer' },
        },
      ],
      reviews: [],
      threads: [],
      checks: [],
    }).maxActivityUpdatedAt,
    '2026-05-12T00:00:00.100Z',
  );

  assert.equal(
    summarizeRegularCommentsForGate(
      [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'question',
          author: { login: 'reviewer' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:00.100Z',
          body: '**Accepted** — reply',
          author: { login: 'idd-bot' },
        },
      ],
      { iddAgentLogins: ['idd-bot'] },
    ).count,
    0,
  );

  assert.equal(
    findLastCopilotReviewCommit([
      {
        author: { login: 'copilot-pull-request-reviewer' },
        submittedAt: '2026-05-12T00:00:00Z',
        commitId: 'old',
      },
      {
        author: { login: 'copilot-pull-request-reviewer' },
        submittedAt: '2026-05-12T00:00:00.100Z',
        commitId: 'new',
      },
    ]),
    'new',
  );
});

test('summarizeAdvisoryWaitMarkers: an advisory-reroll: marker (#1511) is never counted -- separate marker family, distinct from REQUEST_CAP', () => {
  const headSha = 'a'.repeat(40);
  const summary = summarizeAdvisoryWaitMarkers(
    [
      {
        body: `advisory-reroll: kurone-kito ${headSha} 2026-05-12T00:00:00Z`,
        createdAt: '2026-05-12T00:00:00Z',
        author: { login: 'kurone-kito' },
      },
    ],
    headSha,
    ['kurone-kito'],
  );
  assert.equal(summary.sameHeadMarkerCount, 0);
  assert.equal(summary.sameHeadMarkerPresent, false);
  assert.equal(summary.requestMarkerCount, 0);
  assert.equal(summary.earliestSameHeadAt, '');
});

test('latest gating reviews compare timestamps by parsed time', () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: 'reviewer' },
      state: 'APPROVED',
      submittedAt: '2026-05-12T01:00:00Z',
    },
    {
      author: { login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-05-12T01:00:00.100Z',
    },
  ]);

  assert.equal(latest.get('reviewer')?.state, 'CHANGES_REQUESTED');
});

test('latest gating reviews ignore invalid timestamps when a valid review exists', () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: 'reviewer' },
      state: 'APPROVED',
      submittedAt: '2026-05-12T01:00:00Z',
    },
    {
      author: { login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '',
    },
  ]);

  assert.equal(latest.get('reviewer')?.state, 'APPROVED');
});

test('latest gating reviews keep blocking reviews when only updatedAt is valid', () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '',
      updatedAt: '2026-05-12T01:00:00Z',
    },
  ]);

  assert.equal(latest.get('reviewer')?.state, 'CHANGES_REQUESTED');
  assert.equal(latest.get('reviewer')?.submittedAt, '2026-05-12T01:00:00Z');
});

test('regular comment gate only keeps comments after the latest IDD reply', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: 'first',
        author: { login: 'reviewer-a' },
      },
      {
        id: 2,
        createdAt: '2026-05-12T00:00:01Z',
        body: 'second',
        author: { login: 'reviewer-b' },
      },
      {
        id: 3,
        createdAt: '2026-05-12T00:00:02Z',
        body: '**Accepted** — reply',
        author: { login: 'idd-bot' },
      },
      {
        id: 4,
        createdAt: '2026-05-12T00:00:03Z',
        body: 'third',
        author: { login: 'reviewer-c' },
      },
    ],
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['4'],
  );
});

test('regular comment gate keeps same-second comments when no strictly later IDD reply exists', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: 'first',
        author: { login: 'reviewer-a' },
      },
      {
        id: 2,
        createdAt: '2026-05-12T00:00:00Z',
        body: '**Accepted** — reply',
        author: { login: 'idd-bot' },
      },
    ],
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['1'],
  );
});

test('regular comment gate keeps comments later in the same second as the latest IDD reply', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: '**Accepted** — reply',
        author: { login: 'idd-bot' },
      },
      {
        id: 2,
        createdAt: '2026-05-12T00:00:00Z',
        body: 'follow-up',
        author: { login: 'reviewer-a' },
      },
    ],
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['2'],
  );
});

test('regular comment gate keeps advisory bot comments after the latest IDD reply', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: 'first',
        author: { login: 'reviewer-a' },
      },
      {
        id: 2,
        createdAt: '2026-05-12T00:00:01Z',
        body: '**Accepted** — reply',
        author: { login: 'idd-bot' },
      },
      {
        id: 3,
        createdAt: '2026-05-12T00:00:02Z',
        body: 'please address this bot finding',
        author: { login: 'chatgpt-codex-connector[bot]' },
      },
    ],
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['3'],
  );
});

test('regular comment gate reopens comments edited after the latest IDD reply', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        updatedAt: '2026-05-12T00:00:03Z',
        body: 'clarified feedback',
        author: { login: 'reviewer-a' },
      },
      {
        id: 2,
        createdAt: '2026-05-12T00:00:01Z',
        body: '**Accepted** — reply',
        author: { login: 'idd-bot' },
      },
    ],
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['1'],
  );
});

test('regular comment gate skips resolved CodeRabbit summary comments', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nNo actionable comments were generated.',
        author: { login: 'coderabbitai[bot]' },
      },
    ],
    { threads: [] },
  );

  assert.equal(summary.count, 0);
});

test('regular comment gate keeps untrusted forced-handoff marker-shaped comments', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: '<!-- forced-handoff: {} -->\n\nPlease verify this marker by a maintainer.',
        author: { login: 'external-user' },
      },
    ],
    {
      trustedMarkerLogins: ['idd-bot'],
    },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['1'],
  );
});

test('regular comment gate ignores trusted forced-handoff operational markers', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: [
          '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"maintainer","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
          '',
          'Forced handoff approved by maintainer.',
        ].join('\n'),
        author: { login: 'maintainer' },
      },
    ],
    {
      trustedMarkerLogins: ['maintainer'],
    },
  );

  assert.equal(summary.count, 0);
});

test('regular comment gate keeps forced-handoff markers visible without explicit trust', () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: '2026-05-12T00:00:00Z',
        body: [
          '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"maintainer","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
          '',
          'Forced handoff approved by maintainer.',
        ].join('\n'),
        author: { login: 'maintainer' },
      },
    ],
    {},
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(
    summary.items.map((item) => item.id),
    ['1'],
  );
});

test('disposition evidence accepts an unmarked IDD-agent reply to a regular human comment (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'please address',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: 'Thanks, updating now.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
  assert.equal(summary.missingRegularCommentCount, 0);
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence still requires a disposition for an advisory-bot regular comment with unmarked prose (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\nWalkthrough.',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: 'Thanks, updating now.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
});

test('disposition evidence treats PATH A and PATH B as complete when both have markers', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'human feedback',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: '**Accepted** — fixed in abc123',
          author: { login: 'idd-bot' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:02Z',
          body: 'advisory note',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 4,
          createdAt: '2026-05-12T00:00:03Z',
          body: '**Rejected** — advisory acknowledged',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
  assert.equal(summary.missingRegularCommentCount, 0);
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence IDD-scopes advisory-bot resolution at the gate', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\nWalkthrough.',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
      threads: [
        {
          id: 'BT-1',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T00:00:01Z',
                body: 'consider renaming this',
              },
              // Resolved only by a reviewer-authored marker — not an IDD agent.
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:02Z',
                body: '**Accepted** — done',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
    },
  );

  // The CodeRabbit summary is "resolved" only by a reviewer-authored marker,
  // which the IDD-scoped gate must not accept, so the summary is still flagged.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
});

test('disposition evidence pairs trailing markers 1:1 across regular comments', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'first concern',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: 'second concern',
          author: { login: 'reviewer-b' },
        },
        // A single trailing disposition can address only ONE of the two.
        {
          id: 3,
          createdAt: '2026-05-12T00:00:02Z',
          body: '**Accepted** — addressed',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
});

test('disposition evidence clears two regular comments when each has its own marker', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'first concern',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: 'second concern',
          author: { login: 'reviewer-b' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:02Z',
          body: '**Accepted** — first addressed',
          author: { login: 'idd-bot' },
        },
        {
          id: 4,
          createdAt: '2026-05-12T00:00:03Z',
          body: '**Rejected** — second declined',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingRegularCommentCount, 0);
});

test('disposition evidence blocks unresolved threads without fresh disposition markers', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-1',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'need change',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.blockingCount, 1);
  assert.equal(summary.missingRegularCommentCount, 0);
  assert.equal(summary.missingThreadCount, 1);
  assert.equal(
    summary.missingThreads[0].reason,
    'unresolved-without-fresh-disposition',
  );
});

test('disposition evidence treats a reviewer-authored Accepted marker on a human thread as presence-only (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-2',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please fix',
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:01Z',
                body: '**Accepted** — looks good now',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence treats unmarked human prose on a human-authored thread as presence-only (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-human-lgtm',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please fix the naming',
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:02Z',
                body: 'LGTM, the rename looks good',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'], trustedMarkerLogins: ['maintainer'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence still flags a human-authored thread with no reply (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-human-open',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please fix the naming',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreadCount, 1);
  assert.equal(
    summary.missingThreads[0].reason,
    'unresolved-without-fresh-disposition',
  );
});

test('disposition evidence still flags a Copilot thread whose only reply is unmarked human prose (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-copilot-ok',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'copilot' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'consider extracting this helper',
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:02Z',
                body: 'ok',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreadCount, 1);
  assert.equal(
    summary.missingThreads[0].reason,
    'unresolved-without-fresh-disposition',
  );
});

test('disposition evidence clears a Copilot thread with a stamped Accepted reply (#2139)', () => {
  const stamp = renderReviewReplyStamp();
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-copilot-stamped',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'copilot' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'consider extracting this helper',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:00:02Z',
                body: `**Accepted** — extracted in abc123\n\n${stamp}`,
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence clears a Copilot thread with a legacy trusted Accepted reply (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-copilot-legacy',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'copilot' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'consider extracting this helper',
              },
              {
                author: { login: 'maintainer' },
                createdAt: '2026-05-12T00:00:02Z',
                body: '**Accepted** — extracted in abc123',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      trustedMarkerLogins: ['maintainer'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence keeps freshness after an IDD reply even if later human prose arrives (#2139)', () => {
  const stamp = renderReviewReplyStamp();
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-stale-then-human',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please fix the naming',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:00:02Z',
                body: `**Accepted** — renamed in abc\n\n${stamp}`,
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:04Z',
                body: 'please reopen — still a problem',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(
    summary.missingThreads[0].reason,
    'unresolved-without-fresh-disposition',
  );
});

test('disposition evidence recognizes a stamped Accepted under a custom markerPrefix (#2139)', () => {
  const stamp = renderReviewReplyStamp('org-project');
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-custom-prefix',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'copilot' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'consider extracting this helper',
              },
              {
                author: { login: 'someone-else' },
                createdAt: '2026-05-12T00:00:02Z',
                body: `**Accepted** — extracted in abc123\n\n${stamp}`,
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'], markerPrefix: 'org-project' },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence classifies a trusted maintainer LGTM as a human reply (#2139)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-maintainer-lgtm',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please fix the naming',
              },
              {
                author: { login: 'maintainer' },
                createdAt: '2026-05-12T00:00:02Z',
                body: 'LGTM',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      trustedMarkerLogins: ['maintainer'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence accepts a resolved Rejection-confirmed-by-maintainer marker', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-amd',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'this is wrong',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:05:00Z',
                body: '**Rejection confirmed by maintainer** — out of scope; tracked separately.',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence rejects a Rejection-confirmed marker on an unresolved thread', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-amd-open',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'this is wrong',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:05:00Z',
                body: '**Rejection confirmed by maintainer** — out of scope.',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(
    summary.missingThreads[0].reason,
    'unresolved-without-fresh-disposition',
  );
});

test('disposition evidence skips a resolved out-of-snapshot thread before the boundary', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-old',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'old feedback resolved out of band',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'], snapshotBoundaryAt: '2026-05-12T01:00:00Z' },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.missingThreadCount, 0);
});

test('disposition evidence still blocks a resolved thread reopened after the boundary', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-reopened',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'new feedback after the snapshot',
              },
            ],
          },
        },
      ],
    },
    { iddAgentLogins: ['idd-bot'], snapshotBoundaryAt: '2026-05-12T01:00:00Z' },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].reason, 'missing-fresh-disposition');
});

test('disposition evidence flags an ack-only-post-disposition resolved thread without changing the route (#978)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-ack',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'Thanks for confirming.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  // The backstop verdict is unchanged: the thread still blocks.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.blockingCount, 1);
  assert.equal(summary.missingThreads[0].reason, 'missing-fresh-disposition');
  // The advisory-only diagnostic recognizes the post-disposition bot ack.
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, true);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
});

test('disposition evidence recognizes a post-disposition ack across the advisory-bot [bot] suffix (#1118)', () => {
  // A custom advisory bot configured suffixless whose courtesy ack arrives
  // suffixed (or vice-versa) must still be recognized as ack-only — the
  // pre-#1118 raw Set.has() lookup missed it and forced a needless
  // return-to-e1.
  const make = (configLogin: string, ackAuthorLogin: string) =>
    summarizeDispositionEvidenceForGate(
      {
        comments: [],
        threads: [
          {
            id: 'thread-ack',
            isResolved: true,
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  author: { login: 'reviewer-a' },
                  createdAt: '2026-05-12T00:00:00Z',
                  body: 'please reconsider this',
                },
                {
                  author: { login: 'idd-bot' },
                  createdAt: '2026-05-12T00:30:00Z',
                  body: '**Rejected** — verified: not applicable here',
                },
                {
                  author: { login: ackAuthorLogin },
                  createdAt: '2026-05-12T02:00:00Z',
                  body: 'Thanks for confirming.',
                },
              ],
            },
          },
        ],
      },
      {
        iddAgentLogins: ['idd-bot'],
        advisoryBotLogins: [configLogin],
        snapshotBoundaryAt: '2026-05-12T01:00:00Z',
      },
    );

  for (const [configLogin, ackAuthorLogin] of [
    ['advisory-bot', 'advisory-bot[bot]'],
    ['advisory-bot[bot]', 'advisory-bot'],
  ] as const) {
    const summary = make(configLogin, ackAuthorLogin);
    assert.equal(
      summary.missingThreads[0].ackOnlyPostDisposition,
      true,
      `config ${configLogin} should ack-classify ${ackAuthorLogin}`,
    );
    assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
  }
});

test('disposition evidence does not flag a resolved thread with substantive post-disposition feedback (#978)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-substantive',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'No, this is still wrong — please fix it.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, false);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, false);
});

// #1313 background: an advisory bot editing its own already-dispositioned
// thread finding in place (e.g. appending a cosmetic "addressed" badge)
// used to spuriously re-block `missing-fresh-disposition`. A first attempt
// taught `hasFreshDisposition` to date such edits by `createdAt`, but a
// maintainer-reviewed finding showed that mechanism cannot distinguish a
// cosmetic edit from the bot silently changing the substance of the
// finding (GitHub's API exposes no revision diff), which would let a
// genuinely new finding bypass the merge gate. The maintainer decision was
// to revert `hasFreshDisposition`/`effectiveThreadCommentActivityAt` to
// their original fail-closed, `updatedAt`-preferring behavior (any bot
// edit -- cosmetic or substantive -- still re-blocks mechanically), and
// instead surface "in-place-edit-only, no distinguishable new content" as
// a NARROWER advisory-only diagnostic alongside the existing #978
// `ackOnlyPostDisposition` / `soleCauseAckOnlyPostDisposition` signal, so
// an agent can verify the current comment body and deterministically
// override per-instance rather than the mechanism silently trusting it.

test('hasFreshDisposition still re-blocks when a bot edits its own thread finding in place after disposition (#1313)', () => {
  const thread = {
    id: 'thread-bot-edit',
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: 'coderabbitai[bot]' },
          createdAt: '2026-05-12T00:00:00Z',
          // In-place edit: updatedAt bumped past the disposition below by a
          // cosmetic self-edit (e.g. an "addressed" badge), createdAt unchanged.
          updatedAt: '2026-05-12T02:00:00Z',
          body: '**Potential issue**: this needs a null check.',
        },
        {
          author: { login: 'idd-bot' },
          createdAt: '2026-05-12T00:30:00Z',
          body: '**Rejected** — verified: not applicable here',
        },
      ],
    },
  };

  // No isAdvisoryBot option exists anymore: hasFreshDisposition always dates
  // by updatedAt (the original, fail-closed behavior), so this still blocks.
  const fresh = hasFreshDisposition(thread, {
    isDispositionAuthor: (login) => login === 'idd-bot',
  });

  assert.equal(fresh, false);
});

test('disposition evidence still blocks but flags in-place-edit-only when a bot thread finding is edited after disposition (#1313)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-edit',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T00:00:00Z',
                updatedAt: '2026-05-12T02:00:00Z',
                body: '**Potential issue**: this needs a null check.',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  // The mechanical gate still blocks -- no silent override.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.blockingCount, 1);
  assert.equal(summary.missingThreads[0].reason, 'missing-fresh-disposition');
  // The advisory-only diagnostics recognize the specific pattern: a pure
  // advisory-bot ack (#978) that is ALSO an edit of pre-existing content.
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, true);
  assert.equal(summary.missingThreads[0].inPlaceEditOnly, true);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
  assert.equal(summary.soleCauseInPlaceEditOnly, true);
});

test('disposition evidence does not flag in-place-edit-only for a genuinely new bot comment (#1313)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-bot-new',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T00:00:00Z',
                body: '**Potential issue**: this needs a null check.',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                // A genuinely new reply (its own fresh createdAt, not an
                // edit of the original finding) is still recognized as a
                // broad #978 ack-only courtesy comment, but must NOT be
                // classified as an in-place edit of pre-existing content.
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'Actually, see also this related spot.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, true);
  assert.equal(summary.missingThreads[0].inPlaceEditOnly, false);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
  assert.equal(summary.soleCauseInPlaceEditOnly, false);
});

test('disposition evidence does not flag ack-only or in-place-edit-only for a non-advisory-bot edit (#1313)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-human-edit',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                // A human reviewer's in-place edit is unaffected: still
                // dated by updatedAt (unchanged behavior), and never
                // eligible for either advisory-only diagnostic since the
                // author is not a configured advisory bot.
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                updatedAt: '2026-05-12T02:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, false);
  assert.equal(summary.missingThreads[0].inPlaceEditOnly, false);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, false);
  assert.equal(summary.soleCauseInPlaceEditOnly, false);
});

test('disposition evidence reports sole-cause false when a regular comment also blocks (#978)', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 99,
          createdAt: '2026-05-12T03:00:00Z',
          body: 'a separate unanswered reviewer note',
          author: { login: 'reviewer-b' },
        },
      ],
      threads: [
        {
          id: 'thread-ack',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'Thanks for confirming.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.ok(summary.blockingCount >= 2);
  // The ack-only thread is still individually flagged ...
  const ackThread = summary.missingThreads.find(
    (entry) => entry.id === 'thread-ack',
  );
  assert.equal(ackThread?.ackOnlyPostDisposition, true);
  // ... but a regular comment is a separate, non-ack blocking cause.
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, false);
});

test('disposition evidence flags an ack-only thread dispositioned via a rejection-confirmed marker (#978)', () => {
  // The thread-local disposition uses the terminal
  // `**Rejection confirmed by maintainer**` marker (recognized by
  // hasFreshDisposition on resolved threads), so the ack-only signal must
  // recognize it too — otherwise this genuine ack-only case goes unflagged.
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-rejection-confirmed',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejection confirmed by maintainer** — agreed, no change needed',
              },
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'Thanks for confirming.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, true);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
});

test('disposition evidence flags ack-only when the disposition lands after the snapshot boundary (#978)', () => {
  // The reviewer comment is post-boundary but pre-disposition (it was
  // dispositioned), so only the later advisory-bot ack is genuinely
  // post-disposition. The signal must isolate post-disposition activity and
  // still flag this as ack-only.
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-late-disposition',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T01:30:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T02:00:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T03:00:00Z',
                body: 'Thanks for confirming.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, true);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, true);
});

test('disposition evidence does not flag a thread with a post-disposition human reply (#978)', () => {
  // A bot ack AND a later human comment both post-date the disposition. The
  // human reply is genuine post-disposition feedback, so the post-disposition
  // set is not advisory-bot-ack-only and the thread stays unflagged.
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [],
      threads: [
        {
          id: 'thread-late-human',
          isResolved: true,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T00:00:00Z',
                body: 'please reconsider this',
              },
              {
                author: { login: 'idd-bot' },
                createdAt: '2026-05-12T00:30:00Z',
                body: '**Rejected** — verified: not applicable here',
              },
              {
                author: { login: 'coderabbitai[bot]' },
                createdAt: '2026-05-12T02:00:00Z',
                body: 'Thanks for confirming.',
              },
              {
                author: { login: 'reviewer-a' },
                createdAt: '2026-05-12T02:30:00Z',
                body: 'Actually, please reopen — still a problem.',
              },
            ],
          },
        },
      ],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreads[0].ackOnlyPostDisposition, false);
  assert.equal(summary.soleCauseAckOnlyPostDisposition, false);
});

test('disposition evidence accepts edited IDD disposition comments as fresh replies', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:01:00Z',
          body: 'please address this',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:30Z',
          updatedAt: '2026-05-12T00:02:00Z',
          body: '**Accepted** — updated after latest feedback',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    { iddAgentLogins: ['idd-bot'] },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
});

// #1018 — a persistent advisory non-review notice already dispositioned
// `**Rejected** — {bot} did not review HEAD …` carries that disposition forward
// across HEAD changes, so a Codex `updatedAt` bump does not re-flag it.
test('disposition evidence carries a persistent non-review notice forward across a bumped updatedAt', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          // The push re-triggered Codex, which re-stamped the same notice; its
          // updatedAt now post-dates the disposition below.
          updatedAt: '2026-05-12T03:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — chatgpt-codex-connector did not review HEAD abc1234 (usage limits); this is not a completed review',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
  assert.equal(summary.missingRegularCommentCount, 0);
});

// A re-posted CodeRabbit rate-limit summary (new createdAt, after the push) is
// carried forward by the existing non-review-notice disposition that predates it.
test('disposition evidence carries a re-posted CodeRabbit rate-limit notice forward', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — coderabbitai[bot] (CodeRabbit) did not review HEAD abc1234 (review limit reached); this is not a completed review',
          author: { login: 'idd-bot' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T03:00:00Z',
          body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n>\n> `@kurone-kito`, we could not start this review because the limit was reached.',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
});

// #2475 — a single trusted disposition reply that names TWO different advisory
// bots in one span (against convention, but structurally valid per
// `dispositionNamesAdvisoryBot`'s own "still matches each of them" contract)
// must credit BOTH bots' notices, not just the alphabetically-first bot login.
// Regression for a reported bug where `matchTrustedAdvisoryStickyDispositions`
// shared one `consumedDispositionIndexes` set across every bot login, so the
// second bot's notice was left stranded once the shared disposition was
// consumed while matching the first (alphabetically-first) bot it processed.
test('disposition evidence credits both bots when one trusted reply names both by login', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:10Z',
          body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n>\n> `@kurone-kito`, we could not start this review because the limit was reached.',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — chatgpt-codex-connector[bot] and coderabbitai[bot] did not review HEAD abc1234 (rate limited); this is not a completed review',
          author: { login: 'trusted-second-session' },
        },
      ],
      threads: [],
    },
    {
      advisoryBotLogins: ['chatgpt-codex-connector[bot]', 'coderabbitai[bot]'],
      trustedMarkerLogins: ['trusted-second-session'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
  assert.equal(summary.missingRegularCommentCount, 0);
  assert.deepEqual(summary.missingRegularComments, []);
});

// #2475 — the same multi-bot-naming bug also existed in the separate #1018
// notice carry-forward loop (the ordinary IDD-agent-authored disposition
// path, more common in practice than the trusted-machine-disposition path
// above): a single IDD-agent reply naming two configured bots must carry
// both bots' notices forward, not just the alphabetically-first bot. Uses a
// CodeRabbit notice body WITHOUT the `summarize by coderabbit.ai` marker
// (only the `rate limited by coderabbit.ai` one) to avoid a separate,
// unrelated carry-forward path (`classifyRegularBotComment`'s
// summary-marker recognition) that would otherwise mask this bug.
test('disposition evidence carries both notices forward when one agent reply names both bots', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:10Z',
          body: '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n>\n> `@kurone-kito`, we could not start this review because the limit was reached.',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — chatgpt-codex-connector[bot] and coderabbitai[bot] did not review HEAD abc1234 (rate limited); this is not a completed review',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]', 'coderabbitai[bot]'],
    },
  );

  assert.equal(summary.route, 'proceed');
  assert.equal(summary.blockingCount, 0);
  assert.equal(summary.missingRegularCommentCount, 0);
  assert.deepEqual(summary.missingRegularComments, []);
});

// No regression: when the bot later replaces the notice with a real review of
// the current HEAD, the carry-forward does not fire and a fresh disposition is
// still required.
test('disposition evidence still requires a fresh disposition when a notice becomes a real review', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — chatgpt-codex-connector did not review HEAD abc1234 (usage limits); this is not a completed review',
          author: { login: 'idd-bot' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T03:00:00Z',
          body: 'I found a potential off-by-one in `foo.mts` at line 42 — the loop bound should be `<=` to include the final element.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
});

// No regression: an undispositioned non-review notice still blocks even when its
// updatedAt is bumped (the carry-forward requires a matching disposition).
test('disposition evidence still blocks an undispositioned non-review notice', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T03:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
  // #1833: no wrong-phrase `**Rejected**` reply exists at all here, so no
  // hint is attached -- confirms the hint is not a blanket default on every
  // missing notice.
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});

// #1833: a disposition reply starting with `**Rejected**` but missing the
// required `did not review HEAD` phrase passes the generic `isDispositionComment`
// check (so the general 1:1 pairing accepts it as SOME disposition), but the
// notice-specific carry-forward still rejects it. When the bot later re-triggers
// (bumping `updatedAt` past the wrong-phrase reply -- the reported real-world
// shape, kurone-kito/idd-skill#1833), the notice is stranded in `missing`
// indefinitely with no diagnostic explaining why. The `hint` field names the
// exact required phrase instead of forcing a source-dive.
test('disposition evidence hints at the required phrase when a wrong-phrase **Rejected** reply exists', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          // Re-triggered after the wrong-phrase reply below, so the general
          // 1:1 pairing can no longer consume it either.
          updatedAt: '2026-05-12T03:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:30Z',
          // Starts with `**Rejected**` (a real disposition attempt, per the
          // issue's own example) but never says "did not review HEAD".
          body: '**Rejected** — CodeRabbit rate-limited, no findings to triage.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  // Existing pass/fail routing is unchanged -- only the diagnostic is added.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.reason, 'missing-disposition-evidence');
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.match(
    summary.missingRegularComments[0].hint ?? '',
    /did not review HEAD/,
  );
  assert.match(
    summary.missingRegularComments[0].hint ?? '',
    /\*\*Rejected\*\*/,
  );
});

// #1833: a wrong-phrase reply posted BEFORE the notice's own original
// `createdAt` cannot be the notice's disposition attempt (nothing can reply
// to a comment before it exists), so no hint is attached even though a
// wrong-phrase reply exists somewhere in the thread.
test('disposition evidence does not hint from a wrong-phrase reply that predates the notice', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — an unrelated earlier rejection, not this notice.',
          author: { login: 'idd-bot' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});

// #1833: `missingRegularComments[].hint` must validate against
// `schemas/pre-merge-readiness.schema.json` -- that schema's
// `dispositionEvidence.missingRegularComments[]` item shape is
// `additionalProperties: false`, so an unaccounted-for new field on the
// TypeScript side would be silently rejected by any schema-validating
// consumer even though `summarizeDispositionEvidenceForGate` itself is happy
// to emit it (caught by Copilot review on PR #1848 -- the schema was missed
// in the original change).
test('a hinted missingRegularComments entry validates against pre-merge-readiness.schema.json', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T03:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:30Z',
          body: '**Rejected** — CodeRabbit rate-limited, no findings to triage.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );
  assert.ok(summary.missingRegularComments[0].hint);

  const schema = loadJson('schemas/pre-merge-readiness.schema.json') as {
    properties: {
      dispositionEvidence: {
        properties: { missingRegularComments: { items: unknown } };
      };
    };
  };
  const itemSchema =
    schema.properties.dispositionEvidence.properties.missingRegularComments
      .items;
  assert.deepEqual(validate(summary.missingRegularComments[0], itemSchema), []);
});

// No regression (multi-bot): a disposition naming one advisory bot must NOT
// carry forward another bot's still-undispositioned notice. The repo can
// configure several advisory bots at once, so an order/count-only pairing would
// let a Codex rejection suppress a real CodeRabbit missing-disposition blocker.
test('disposition evidence does not carry one bot disposition onto another bot notice', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          // CodeRabbit rate-limit notice — never dispositioned.
          body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> ## Review limit reached',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:00:01Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:30Z',
          // Names only the Codex connector — must not carry the CodeRabbit notice.
          body: '**Rejected** — chatgpt-codex-connector did not review HEAD abc1234 (usage limits); this is not a completed review',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector[bot]'],
    },
  );

  // The Codex notice carries forward on its own disposition; the undispositioned
  // CodeRabbit notice still blocks (one missing regular comment).
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
});

test('isAdvisoryNonReviewNotice matches only machine-generated non-review notices', () => {
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews.',
    ),
    true,
  );
  // #1312: current Codex wording interposes "have been" between "usage
  // limits" and "reached" — must still classify as a non-review notice.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding credits.',
    ),
    true,
  );
  // #1326: the live current wording observed on this PR's own Codex review
  // appends a second administrative sentence beyond the one #1312 quoted —
  // must still classify as a non-review notice (verified against the exact
  // text Codex posted on PR #1329 while this fix was under review).
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding ' +
        'credits.\nCredits must be used to enable repository wide code reviews.',
    ),
    true,
  );
  assert.equal(
    isAdvisoryNonReviewNotice(
      '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> ## Review limit reached',
    ),
    true,
  );
  // A real CodeRabbit review summary must NOT be classified as a notice.
  assert.equal(
    isAdvisoryNonReviewNotice(
      '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\n## Walkthrough\n\nThe change adds a carry-forward carve-out.',
    ),
    false,
  );
  // An ordinary reviewer comment that merely mentions usage limits must not match.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This rate limit handling looks off — please cap the retries.',
    ),
    false,
  );
  // #1312: a genuine Codex review comment that merely mentions the phrase
  // "Codex usage limits" — with no nearby reach/exceed/hit verb — must not
  // be misclassified as a non-review notice.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This PR modifies the Codex usage limits configuration file; overall LGTM.',
    ),
    false,
  );
  // #1312 (review-fix): a genuine review comment with a reach/exceed/hit
  // verb near "Codex usage limits" but no "for code reviews" nearby must
  // not match either — this is the concrete false-positive scenario a
  // verb-only anchor would have caught (flagged in PR #1319 review).
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This code exceeds the Codex usage limits configured for the repo.',
    ),
    false,
  );
  // #1326: a genuine review comment that combines all three tokens
  // (verb + "Codex usage limits" + "for code reviews") close together in
  // ordinary prose must not match, even though the token-anchored pattern
  // alone finds a candidate span — this is the concrete false positive
  // flagged in PR #1319's own review of the #1312 fix.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This code hits the Codex usage limits for code reviews configured for the repo.',
    ),
    false,
  );
  // #1326: a narrative lead-in before an otherwise-bare match (empty
  // suffix) must also not match — the suffix alone is not a sufficient
  // signal; the prefix must be checked too.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This is what happens when you hit the Codex usage limits for code reviews.',
    ),
    false,
  );
  // #1326: a real notice immediately followed by unrelated prose (not the
  // known generated trailer) must not match — a false positive could hide
  // inside a longer bot comment that happens to lead with the notice text.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews. We should ' +
        'review our approach for code reviews going forward.',
    ),
    false,
  );
  // #1326 (review-fix): the known generated trailer itself followed by
  // MORE unrelated prose must still not match — the trailer-continuation
  // pattern must anchor the entire remainder, not just find the trailer as
  // a substring somewhere within it (flagged in this PR's own Copilot
  // review: a substring-only check would let extra content hide behind a
  // recognized trailer prefix).
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding ' +
        'credits. And by the way, I also noticed a bug in the retry logic.',
    ),
    false,
  );
  // #1326: the two-sentence live trailer followed by further unrelated
  // prose must still not match — extending the accepted closing shape to a
  // second sentence must not reopen the same substring-anchoring gap for
  // content past that second sentence either.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding ' +
        'credits.\nCredits must be used to enable repository wide code ' +
        'reviews. By the way I also noticed a bug in the retry logic.',
    ),
    false,
  );
  // #1326: a human sentence that deliberately reuses the second trailer
  // sentence's own vocabulary ("repository", "credits", "reviews") must
  // still not match — the trailer pattern's fixed token order and gap
  // bounds are shape-specific, not a bag-of-words check.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This code hits the Codex usage limits for code reviews. The ' +
        'repository credits check has a bug in the retry logic for reviews.',
    ),
    false,
  );
  // #1326 (review-fix round 3): even when the full SENTENCE_1 bot phrasing
  // is present (an unlikely but possible coincidence), loosely-worded
  // content that merely reuses SENTENCE_2's individual words ("credits",
  // "repository", "review") without its distinctive "credits must be used
  // ... enable" phrase must not match — closes a gap a critique pass found
  // in an earlier version of this same fix that anchored SENTENCE_2 on
  // single generic words instead of a distinctive multi-word phrase.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding ' +
        'credits. Credits are precious, track per repository, avoid ' +
        'wasting review!',
    ),
    false,
  );
  assert.equal(
    isAdvisoryNonReviewNotice(
      'Codex usage limits have been reached for code reviews. Please check ' +
        'with the admins of this repo to increase the limits by adding ' +
        'credits. credits repository reviews',
    ),
    false,
  );
  // #1326 (review-fix round 4): narrative content between the base match
  // and the trailer's core tokens must not match, even though it fits
  // within a short character budget — the lead-in before "check with the
  // admins" must be punctuation/whitespace plus the one known lead-in word
  // ("Please"), not an arbitrary-content character count (flagged by
  // Copilot on this PR's own merge-sync-triggered re-review).
  assert.equal(
    isAdvisoryNonReviewNotice(
      'This code exceeds the Codex usage limits for code reviews. We ' +
        'should check with the admins of this repo to increase the ' +
        'limits by adding credits.',
    ),
    false,
  );
  // #1326: trailing whitespace after a real notice must not defeat the
  // empty-suffix check (no regression from the added structural gate).
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews.\n\n',
    ),
    true,
  );
  // #1877: a third live trailer wording (observed on PR #1876,
  // 2026-08-05) points at the Codex usage dashboard instead of the
  // admin/credits sentence — must still classify as a non-review notice.
  // Literal text captured from
  // https://github.com/kurone-kito/idd-skill/pull/1876#issuecomment-5187108915.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews. You ' +
        'can see your limits in the [Codex usage dashboard]' +
        '(https://chatgpt.com/codex/cloud/settings/usage).',
    ),
    true,
  );
  // #1877: the same dashboard-pointer wording without markdown link syntax
  // (a plausible plain-text rendering) must also match — the markdown
  // link close is optional, not required.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews. You ' +
        'can see your limits in the Codex usage dashboard.',
    ),
    true,
  );
  // #1877: the dashboard-pointer trailer followed by further unrelated
  // prose must still not match — SENTENCE_3 anchors the entire remainder,
  // the same whole-remainder anchoring SENTENCE_1/SENTENCE_2 already
  // enforce.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews. You ' +
        'can see your limits in the [Codex usage dashboard]' +
        '(https://chatgpt.com/codex/cloud/settings/usage). By the way I ' +
        'also noticed a bug in the retry logic.',
    ),
    false,
  );
  // #1877: a narrative lead-in before "you can see your limits" must not
  // match either — mirrors the existing SENTENCE_1 narrative-lead-in
  // guard; the lead-in before the trailer's core tokens must stay
  // punctuation/whitespace plus the one known "Please" word, never
  // arbitrary narrative content.
  assert.equal(
    isAdvisoryNonReviewNotice(
      'You have reached your Codex usage limits for code reviews. We ' +
        'think you can see your limits in the Codex usage dashboard.',
    ),
    false,
  );
  assert.equal(isAdvisoryNonReviewNotice(''), false);
  assert.equal(isAdvisoryNonReviewNotice(null), false);
});

test('isNonReviewNoticeDisposition matches only a rejected non-review-notice reply', () => {
  assert.equal(
    isNonReviewNoticeDisposition({
      body: '**Rejected** — CodeRabbit did not review HEAD abc1234 (review limit reached); this is not a completed review',
    }),
    true,
  );
  // An ordinary rejection of reviewer feedback is not a non-review-notice reply.
  assert.equal(
    isNonReviewNoticeDisposition({
      body: '**Rejected** — verified: the flagged path is already covered by a test',
    }),
    false,
  );
  // An acceptance is never a non-review-notice disposition.
  assert.equal(
    isNonReviewNoticeDisposition({
      body: '**Accepted** — the bot did not review HEAD, noting for context',
    }),
    false,
  );
  assert.equal(isNonReviewNoticeDisposition({ body: null }), false);
});

test('deriveIddAgentLogins keeps prior trusted operational actors but not generic maintainer comments', () => {
  assert.deepEqual(
    deriveIddAgentLogins({
      viewerLogin: 'current-agent',
      iddAgentLogins: ['explicit-agent'],
      trustedMarkerLogins: ['current-agent', 'prior-agent', 'maintainer'],
      operationalComments: [
        {
          author: { login: 'prior-agent' },
          body: '<!-- review-baseline: github-copilot-cli claim-123 abcdefabcdefabcdefabcdefabcdefabcdefabcd -->\n\n_github-copilot-cli: critique baseline — IDD automation marker. Do not edit._',
        },
        {
          author: { login: 'maintainer' },
          body: 'Please double-check the merge gate before landing this.',
        },
      ],
    }),
    ['current-agent', 'explicit-agent', 'prior-agent'],
  );
});

test('deriveIddAgentLogins excludes trusted forced-handoff marker authors', () => {
  const forcedHandoffBody = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"maintainer","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
    '',
    'Forced handoff approved by maintainer. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');

  assert.deepEqual(
    deriveIddAgentLogins({
      viewerLogin: 'current-agent',
      trustedMarkerLogins: ['current-agent', 'maintainer'],
      operationalComments: [
        {
          author: { login: 'maintainer' },
          body: forcedHandoffBody,
        },
      ],
    }),
    ['current-agent'],
  );
});

test('summarizeClaimValidation follows trusted forced-handoff transitions', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
        '',
        'Forced handoff approved by kurone-kito. I verified that the current',
        'owning session or agent is unavailable. This transfers ownership away',
        'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.',
        'If the prior session resumes, it must stop immediately and must not',
        'push, comment, resolve review state, or merge until a maintainer',
        'reassigns ownership.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [
      'github-copilot-cli-old',
      'github-copilot-cli-new',
      'kurone-kito',
    ],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedClaimId: 'claim-20260512T110000Z-337-new',
    expectedAgentId: 'github-copilot-cli-new',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T110000Z-337-new');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-new');
});

test('summarizeClaimValidation rejects forced handoff from unauthorized approver', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"trusted-relay[bot]","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
        '',
        'Forced handoff approved by trusted-relay[bot]. I verified that the current',
        'owning session or agent is unavailable. This transfers ownership away',
        'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.',
        'If the prior session resumes, it must stop immediately and must not',
        'push, comment, resolve review state, or merge until a maintainer',
        'reassigns ownership.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'trusted-relay[bot]' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['github-copilot-cli-old', 'trusted-relay[bot]'],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'github-copilot-cli-old',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-old');
});

test('summarizeClaimValidation ignores forced handoff when policy is disabled', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
        '',
        'Forced handoff approved by kurone-kito.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['github-copilot-cli-old', 'kurone-kito'],
    forcedHandoffEnabled: false,
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'github-copilot-cli-old',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
});

test('summarizeClaimValidation does not trust all authors when trusted marker set is empty', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [],
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'github-copilot-cli-old',
  });

  assert.equal(summary.activeClaimPresent, false);
  assert.equal(summary.claimLost, true);
  assert.equal(summary.reason, 'missing-active-claim');
});

// #1528: the F2/F3 merge-time write-gate's activation-nonce collision
// check, mirroring evaluateResumeClaimRouting's own activation-nonce
// coverage in tests/resume-claim-routing.test.mts (same shared
// findActivationNonceWinner primitive, same #1522 marker format).
test('summarizeClaimValidation: matching nonce keeps match (no collision)', () => {
  const claimEvents = [
    {
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
    },
    {
      body: '<!-- activation-nonce: copilot claim-abc nonce-mine 2026-05-12T09:00:05Z -->',
      createdAt: '2026-05-12T09:00:05Z',
      author: { login: 'maintainer' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['maintainer'],
    expectedClaimId: 'claim-abc',
    expectedAgentId: 'copilot',
    expectedNonce: 'nonce-mine',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
});

test('summarizeClaimValidation: mismatched nonce routes to the contested/stop path', () => {
  const claimEvents = [
    {
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
    },
    {
      body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
      createdAt: '2026-05-12T09:00:05Z',
      author: { login: 'maintainer' },
    },
    {
      body: '<!-- activation-nonce: copilot claim-abc nonce-zzz 2026-05-12T09:00:07Z -->',
      createdAt: '2026-05-12T09:00:07Z',
      author: { login: 'maintainer' },
    },
  ];

  // "nonce-aaa" sorts first ASCII and wins; the displaced session's own
  // recorded nonce ("nonce-zzz") loses, the same second-activation
  // collision resume-claim-routing.mts already catches at claim time.
  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['maintainer'],
    expectedClaimId: 'claim-abc',
    expectedAgentId: 'copilot',
    expectedNonce: 'nonce-zzz',
  });

  assert.equal(summary.claimLost, true);
  assert.equal(summary.reason, 'activation-nonce-mismatch');
  assert.equal(summary.matchesExpectedClaim, false);
});

test('summarizeClaimValidation: no activation-nonce marker skips the comparison (AC3 backward compatibility)', () => {
  const claimEvents = [
    {
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['maintainer'],
    expectedClaimId: 'claim-abc',
    expectedAgentId: 'copilot',
    expectedNonce: 'nonce-mine',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
});

test('summarizeClaimValidation: omitting expectedNonce opts out of the comparison entirely', () => {
  const claimEvents = [
    {
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
    },
    {
      body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
      createdAt: '2026-05-12T09:00:05Z',
      author: { login: 'maintainer' },
    },
    {
      body: '<!-- activation-nonce: copilot claim-abc nonce-zzz 2026-05-12T09:00:07Z -->',
      createdAt: '2026-05-12T09:00:07Z',
      author: { login: 'maintainer' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ['maintainer'],
    expectedClaimId: 'claim-abc',
    expectedAgentId: 'copilot',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
});

test('summarizeClaimValidation requires linked-pr match for issue-plus-pr handoff', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"359","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
        '',
        'Forced handoff approved by kurone-kito.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [
      'github-copilot-cli-old',
      'github-copilot-cli-new',
      'kurone-kito',
    ],
    forcedHandoffEnabled: true,
    expectedLinkedPrs: ['#1000', 'https://github.com/octo/repo/pull/1000'],
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'github-copilot-cli-old',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-old');
});

test('summarizeClaimValidation accepts issue-plus-pr handoff with matching linked-pr', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"359","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
        '',
        'Forced handoff approved by kurone-kito.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [
      'github-copilot-cli-old',
      'github-copilot-cli-new',
      'kurone-kito',
    ],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedLinkedPrs: [
      '#359',
      'https://github.com/kurone-kito/idd-skill/pull/359',
    ],
    expectedClaimId: 'claim-20260512T110000Z-337-new',
    expectedAgentId: 'github-copilot-cli-new',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T110000Z-337-new');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-new');
});

test('summarizeClaimValidation normalizes linked-pr URL variants for matching', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"http://github.com/kurone-kito/idd-skill/pull/359/","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
        '',
        'Forced handoff approved by kurone-kito.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [
      'github-copilot-cli-old',
      'github-copilot-cli-new',
      'kurone-kito',
    ],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedLinkedPrs: [
      '#359',
      'https://github.com/kurone-kito/idd-skill/pull/359',
    ],
    expectedClaimId: 'claim-20260512T110000Z-337-new',
    expectedAgentId: 'github-copilot-cli-new',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T110000Z-337-new');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-new');
});

test('summarizeClaimValidation rejects issue-only handoff for PR-scoped checks', () => {
  const claimEvents = [
    {
      body: [
        '<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->',
        '',
        '_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._',
      ].join('\n'),
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'github-copilot-cli-old' },
    },
    {
      body: [
        '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-only"} -->',
        '',
        'Forced handoff approved by kurone-kito.',
      ].join('\n'),
      createdAt: '2026-05-12T11:00:05Z',
      author: { login: 'kurone-kito' },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: [
      'github-copilot-cli-old',
      'github-copilot-cli-new',
      'kurone-kito',
    ],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedLinkedPrs: [
      '359',
      '#359',
      'https://github.com/kurone-kito/idd-skill/pull/359',
    ],
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'github-copilot-cli-old',
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(summary.activeClaim.agentId, 'github-copilot-cli-old');
});

test('advisory wait summary keeps F2 and F3 outcomes distinct when Copilot is no longer pending', () => {
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: 'a'.repeat(40),
      reviews: [
        {
          author: { login: 'copilot-pull-request-reviewer' },
          submittedAt: '2026-05-12T00:00:00Z',
          commitId: 'b'.repeat(40),
        },
      ],
      requestedReviewers: [],
      timelineEvents: [],
      comments: [],
    },
    {
      now: '2026-05-12T00:10:00Z',
      trustedMarkerLogins: ['idd-bot'],
    },
  );

  assert.equal(summary.outcome, 'REQUEST_NEEDED');
  assert.equal(summary.f3Outcome, 'SATISFIED');
});

function makeWaiverComment(fields: Record<string, string>) {
  const {
    agentId = 'a',
    claimId = 'c',
    headSha = 'a'.repeat(40),
    checkSelector = 'CodeRabbit',
    reason = 'rate-limit',
    expiresAt = '2099-01-01T00:00:00Z',
  } = fields;
  const enc = (s: string) => encodeURIComponent(s);
  return `<!-- idd-external-check-waiver: ${agentId} ${claimId} ${headSha} check:${enc(checkSelector)} reason:${enc(reason)} expires:${expiresAt} -->\n\n_${agentId}: external check waiver for IDD F phase on \`${checkSelector}\`_`;
}

test('summarizeExternalCheckWaivers: empty comments returns all-empty evidence', () => {
  const result = summarizeExternalCheckWaivers([], {
    prHeadSha: 'a'.repeat(40),
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.deepEqual(result, {
    valid: [],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
  });
});

test('summarizeExternalCheckWaivers: valid waiver is placed in valid bucket', () => {
  const head = 'b'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].checkSelector, 'CodeRabbit');
  assert.equal(result.valid[0].authorLogin, 'kurone-kito');
});

test('summarizeExternalCheckWaivers: an odd-cased marker is still recognized', () => {
  const head = 'b'.repeat(40);
  // Uppercase the marker token only; parseExternalCheckWaiverComment is
  // case-insensitive, so the prefilter must not skip it.
  const body = makeWaiverComment({
    claimId: 'claim-123',
    headSha: head,
  }).replace(
    '<!-- idd-external-check-waiver:',
    '<!-- IDD-EXTERNAL-CHECK-WAIVER:',
  );
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.malformed.length, 0);
});

test('summarizeExternalCheckWaivers: a prose mention of the marker name is ignored', () => {
  const comment = {
    body: 'We should document the idd-external-check-waiver flow for maintainers.',
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: 'b'.repeat(40),
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  // Not a marker at the start of the body — must not be counted as malformed.
  assert.equal(result.malformed.length, 0);
  assert.equal(result.valid.length, 0);
});

test('summarizeExternalCheckWaivers: expired waiver goes to expired bucket', () => {
  const head = 'c'.repeat(40);
  const body = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    expiresAt: '2020-01-01T00:00:00Z',
  });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.expired.length, 1);
  assert.equal(result.valid.length, 0);
});

test('summarizeExternalCheckWaivers: wrong head SHA goes to wrongHead bucket', () => {
  const body = makeWaiverComment({
    headSha: 'a'.repeat(40),
    claimId: 'claim-123',
  });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: 'b'.repeat(40),
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.wrongHead.length, 1);
});

test('summarizeExternalCheckWaivers: wrong claim ID goes to wrongClaim bucket', () => {
  const head = 'd'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-wrong' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.wrongClaim.length, 1);
});

test('summarizeExternalCheckWaivers: unauthorized actor goes to unauthorized bucket', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-123' });
  const comment = {
    body,
    author: { login: 'unknown-actor' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.unauthorized.length, 1);
});

test('summarizeExternalCheckWaivers: malformed waiver comment goes to malformed bucket', () => {
  const comment = {
    body: '<!-- idd-external-check-waiver: bad-format -->',
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: 'a'.repeat(40),
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.malformed.length, 1);
});

test('summarizeRequiredChecks: waiver covers failing required check', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'CodeRabbit',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
  };
  const result = summarizeRequiredChecks(
    [
      {
        name: 'CodeRabbit',
        state: 'PENDING',
        completedAt: '2026-05-17T00:00:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    { waivers },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: a check with no live run at all is never covered by waiver, even a valid one (#2034 fail-closed)', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'CodeRabbit',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
  };
  const result = summarizeRequiredChecks(
    [{ name: 'CodeRabbit', state: 'PENDING', completedAt: '' }],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    { waivers },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// #2353: `treatAsCoveredByWaiver` covers a check through a mechanism OTHER
// than a matched `waivers.valid` entry (a provider-outage declaration) --
// with no waiver entry at all, and deliberately bypassing
// `excludeFromWaiverCoverage`'s own veto, since that callback's purpose
// (withholding coverage a matched waiver entry would otherwise grant) does
// not apply to this independent positive path.
test('summarizeRequiredChecks: treatAsCoveredByWaiver covers a failing required check with zero waiver entries', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-17T00:00:00Z',
        completedAt: '2026-05-17T00:03:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: treatAsCoveredByWaiver bypasses excludeFromWaiverCoverage for the same check name', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-17T00:00:00Z',
        completedAt: '2026-05-17T00:03:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      excludeFromWaiverCoverage: () => true, // vetoes every check, as advisory-convergence.mts's own callback does when not genuinely covered
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: treatAsCoveredByWaiver has nothing to cover on an already-passing check', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'SUCCESS',
        startedAt: '2026-05-17T00:00:00Z',
        completedAt: '2026-05-17T00:03:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: omitted treatAsCoveredByWaiver never covers anything (unchanged pre-#2353 behavior)', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-17T00:00:00Z',
        completedAt: '2026-05-17T00:03:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {},
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// Codex review (PR #2370): `resolveAdvisoryConvergenceOutageRelief` (the
// CLI-layer function that fetches/resolves the declaration for
// pre-merge-readiness.mts) is not exported and does live `gh api` calls,
// so it is pinned by source text -- same "pin the call site" spirit as
// advisory-convergence.test.mts's #1810/#1906/#2137/#2353 tests. Without
// this gate, an adopter that leaves `ciGate.externalCheckWaivers.mode` at
// its `disabled` default but configures the waivable selector and posts a
// declaration would relieve here while `computeAdvisoryConvergenceVerdict`
// -- gated on the SAME check -- still rejects it, disagreeing with the CI
// check's own verdict for the same pull request and HEAD.
test('resolveAdvisoryConvergenceOutageRelief requires ciGate.externalCheckWaivers.mode to be maintainer-authorized (#2353, Codex review on PR #2370)', () => {
  const source = readFileSync(
    new URL('../src/scripts/pre-merge-readiness.mts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /function resolveAdvisoryConvergenceOutageRelief\([\s\S]*?if \(policy\.ciGate\.externalCheckWaivers\.mode !== 'maintainer-authorized'\) \{\s*\n\s*return notRelieved;\s*\n\s*\}/,
  );
});

// Copilot + Codex review (PR #2370): `treatAsCoveredByWaiver` returning
// `true` must never cover a check whose live run has not actually
// completed (QUEUED/IN_PROGRESS/PENDING with an empty/unparseable
// `completedAt`) -- the same #2034 fail-closed live-run requirement the
// direct-waiver path already enforces via `hasFreshWaiverCoverage`.
// Reporting `success` here while GitHub's own required-check state is
// still pending would recreate the exact "ready but merge blocked"
// failure mode #2021 fixed.
test('summarizeRequiredChecks: treatAsCoveredByWaiver never covers a check with no live run at all, even when it returns true', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'PENDING',
        startedAt: '',
        completedAt: '',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// Copilot + Codex + CodeRabbit review (PR #2370, round 5): GitHub's
// non-nullable `DateTime` scalar reports the `0001-01-01T00:00:00Z`
// zero-value sentinel for a `completedAt` that hasn't happened yet
// (`normalizeStatusCheckRollupEntry` supplies it for a still-running
// CheckRun) -- and `isValidIsoTimestamp` alone accepts that value as a
// technically-well-formed, merely very-old timestamp. Before this fix,
// that meant `completedAtMs !== null` did NOT actually reject an
// in-progress run: an IN_PROGRESS check with a genuine, fresh `startedAt`
// would pass every gate and report `coveredByWaiver: true` while GitHub's
// own required check had not even finished running.
test('summarizeRequiredChecks: treatAsCoveredByWaiver never covers a still-running check even with a fresh startedAt (zero-value completedAt sentinel)', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'IN_PROGRESS',
        startedAt: '2026-05-12T00:25:00Z', // fresh, after the cutoff below
        completedAt: '0001-01-01T00:00:00Z', // GitHub's not-yet-completed sentinel
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
      treatAsCoveredByWaiverSince: () => '2026-05-12T00:00:00Z',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// Same sentinel gap, mirrored for `startedAt`: a not-yet-started (QUEUED)
// run's `startedAt` also reports the zero-value sentinel, which must not
// be accepted as a genuine "observed the declaration" moment either.
test('summarizeRequiredChecks: treatAsCoveredByWaiver never covers a not-yet-started check (zero-value startedAt sentinel)', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'QUEUED',
        startedAt: '0001-01-01T00:00:00Z', // GitHub's not-yet-started sentinel
        completedAt: '0001-01-01T00:00:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// Codex review (PR #2370): a run whose live `completedAt` is parseable but
// whose `startedAt` is not (an inconsistent/malformed entry) must also be
// withheld -- the same fail-closed posture `completedAtMs !== null` already
// enforces, mirrored for `startedAtMs`.
test('summarizeRequiredChecks: treatAsCoveredByWaiver never covers a check with a parseable completedAt but no parseable startedAt', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '',
        completedAt: '2026-05-17T00:03:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

// Codex review (PR #2370, follow-up finding after the first fix round): a
// live run existing (completedAt parseable) is not enough -- it must ALSO
// have completed AT OR AFTER the moment `treatAsCoveredByWaiverSince`
// names. A failed run that completed BEFORE an outage declaration's own
// window opened was never actually rerun during the declared outage;
// treating it covered would report `success` while GitHub's own
// required-check state still shows the stale failure.
test('summarizeRequiredChecks: treatAsCoveredByWaiverSince withholds coverage from a run that completed before the cutoff', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-10T23:57:00Z', // before the declaration opened
        completedAt: '2026-05-11T00:00:00Z', // before the declaration opened
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
      treatAsCoveredByWaiverSince: () => '2026-05-12T00:00:00Z',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

test('summarizeRequiredChecks: treatAsCoveredByWaiverSince covers a run that started at or after the cutoff', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-12T00:25:00Z', // after the declaration opened
        completedAt: '2026-05-12T00:30:00Z', // after the declaration opened
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
      treatAsCoveredByWaiverSince: () => '2026-05-12T00:00:00Z',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

// Codex review (PR #2370, second follow-up finding, round 4): the
// freshness cutoff must anchor on `startedAt`, not `completedAt`. A run
// that BEGAN evaluating state before the declaration's own window opened
// never observed it, even though this particular run happens to finish
// (and post `completedAt`) a few minutes after the cutoff passes -- its
// verdict was already decided using stale, pre-declaration state by then.
test('summarizeRequiredChecks: treatAsCoveredByWaiverSince withholds coverage from a run that started before the cutoff but completed after it', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-11T23:58:00Z', // started before the declaration opened
        completedAt: '2026-05-12T00:05:00Z', // finished after the declaration opened
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
      treatAsCoveredByWaiverSince: () => '2026-05-12T00:00:00Z',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

test('summarizeRequiredChecks: omitted treatAsCoveredByWaiverSince applies no cutoff (unchanged pre-fix behavior)', () => {
  const result = summarizeRequiredChecks(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        startedAt: '2026-05-10T23:57:00Z',
        completedAt: '2026-05-11T00:00:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['idd-advisory-convergence'] } },
    {
      treatAsCoveredByWaiver: (name) => name === 'idd-advisory-convergence',
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: waiver does not affect already-passing check', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'lint',
        reason: 'test',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
  };
  const result = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-17T00:00:00Z' }],
    [],
    { required_status_checks: { contexts: ['lint'] } },
    { waivers },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.equal(result.status, 'success');
});

test('summarizeExternalCheckWaivers: multiple valid waivers for different checks both land in valid bucket', () => {
  const head = 'b'.repeat(40);
  const comment1 = {
    body: makeWaiverComment({
      headSha: head,
      claimId: 'claim-123',
      checkSelector: 'CodeRabbit',
    }),
    user: { login: 'owner' },
    created_at: '2026-05-17T10:00:00Z',
  };
  const comment2 = {
    body: makeWaiverComment({
      headSha: head,
      claimId: 'claim-123',
      checkSelector: 'Copilot*',
    }),
    user: { login: 'owner' },
    created_at: '2026-05-17T10:01:00Z',
  };

  const result = summarizeExternalCheckWaivers([comment1, comment2], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['owner'],
    now: '2026-05-17T12:00:00Z',
  });

  assert.equal(result.valid.length, 2);
  assert.equal(result.expired.length, 0);
  assert.ok(result.valid.some((w) => w.checkSelector === 'CodeRabbit'));
  assert.ok(result.valid.some((w) => w.checkSelector === 'Copilot*'));
});

test('summarizeExternalCheckWaivers: suspicious marker-shaped comment from untrusted actor never becomes valid', () => {
  const head = 'c'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-123' });
  const comment = {
    body,
    user: { login: 'untrusted-actor' },
    created_at: '2026-05-17T10:00:00Z',
  };

  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['trusted-only'],
    now: '2026-05-17T12:00:00Z',
  });

  assert.equal(result.valid.length, 0);
  assert.equal(result.unauthorized.length, 1);
  assert.equal(result.unauthorized[0].authorLogin, 'untrusted-actor');
});

test('summarizeExternalCheckWaivers: mixed valid, expired, and wrongClaim in separate buckets', () => {
  const head = 'd'.repeat(40);
  const validBody = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    checkSelector: 'CodeRabbit',
  });
  const expiredBody = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    checkSelector: 'lint',
    expiresAt: '2020-01-01T00:00:00Z',
  });
  const wrongClaimBody = makeWaiverComment({
    headSha: head,
    claimId: 'claim-other',
    checkSelector: 'Analyze',
  });
  const comments = [
    {
      body: validBody,
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:00:00Z',
    },
    {
      body: expiredBody,
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:01:00Z',
    },
    {
      body: wrongClaimBody,
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:02:00Z',
    },
  ];
  const result = summarizeExternalCheckWaivers(comments, {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:10:00Z',
  });
  assert.equal(result.valid.length, 1, 'only one valid waiver');
  assert.equal(result.expired.length, 1, 'one expired waiver');
  assert.equal(result.wrongClaim.length, 1, 'one wrong-claim waiver');
});

test('summarizeExternalCheckWaivers: an empty active claim fails closed to wrongClaim', () => {
  const head = 'a'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-123' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  // No active claim resolves at the gate (`activeClaimId === ''`); the
  // otherwise-matching waiver must be rejected, not pass unbound.
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: '',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0, 'unbound waiver must not be valid');
  assert.equal(result.wrongClaim.length, 1);
});

// --- #1905: claimless waiver (claim-id "none") sentinel ---------------------

test('summarizeExternalCheckWaivers: claim-id "none" on an unclaimed PR is valid (claimless-accept)', () => {
  const head = 'f'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'none' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  // No active claim resolves at the gate -- the literal `none` sentinel
  // explicitly declares this a claimless waiver, satisfying the
  // claim-binding check only because the gate independently confirms no
  // claim exists.
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: '',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 1);
  assert.equal(result.wrongClaim.length, 0);
});

test('summarizeExternalCheckWaivers: "NONE"/"None" (any case) on an unclaimed PR is valid', () => {
  const head = 'f'.repeat(40);
  for (const sentinel of ['NONE', 'None', 'nOnE']) {
    const body = makeWaiverComment({ headSha: head, claimId: sentinel });
    const comment = {
      body,
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:00:00Z',
    };
    const result = summarizeExternalCheckWaivers([comment], {
      prHeadSha: head,
      activeClaimId: '',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
    });
    assert.equal(result.valid.length, 1, `sentinel ${sentinel} must validate`);
  }
});

test('summarizeExternalCheckWaivers: a non-none, non-matching claim id on an unclaimed PR still fails to wrongClaim (regression #1077, claimless-reject-wrong-sentinel)', () => {
  const head = 'f'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-123' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: '',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0, 'unbound waiver must not be valid');
  assert.equal(result.wrongClaim.length, 1);
});

test('summarizeExternalCheckWaivers: claim-id "none" on a claimed PR is rejected to wrongClaim (claimed-PR-rejects-none)', () => {
  const head = 'f'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'none' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  // A real claim resolves at the gate -- the `none` sentinel only applies
  // when the gate independently confirms no claim exists, so it must never
  // route around a genuine claim mismatch.
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0, 'none must not bind to a real claim');
  assert.equal(result.wrongClaim.length, 1);
});

test('summarizeExternalCheckWaivers: a none-sentinel waiver still fails on a claimed PR whose supersedes is also none (#2080)', () => {
  // Fresh claim: activeClaim.supersedes is the literal 'none' sentinel.
  // Treating that as a bindable predecessor would make every claimless
  // waiver validate on every freshly claimed PR.
  const head = 'f'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'none' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    activeClaimSupersedes: 'none',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0);
  assert.equal(result.wrongClaim.length, 1);
});

test('summarizeExternalCheckWaivers: a waiver bound to the immediate supersedes predecessor stays valid after takeover (#2080)', () => {
  const head = 'a'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-A' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-B',
    activeClaimSupersedes: 'claim-A',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 1);
  assert.equal(result.wrongClaim.length, 0);
});

test('summarizeExternalCheckWaivers: a two-hop-old claim id stays in wrongClaim (#2080)', () => {
  const head = 'a'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-A' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-C',
    activeClaimSupersedes: 'claim-B',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0);
  assert.equal(result.wrongClaim.length, 1);
});

test('summarizeExternalCheckWaivers: an empty head SHA fails closed to wrongHead', () => {
  const head = 'a'.repeat(40);
  const body = makeWaiverComment({ headSha: head, claimId: 'claim-123' });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  // No head SHA is known at the gate; the waiver cannot be bound to the
  // current PR HEAD and must be rejected.
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: '',
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:00:00Z',
  });
  assert.equal(result.valid.length, 0, 'unbound waiver must not be valid');
  assert.equal(result.wrongHead.length, 1);
});

test('summarizeExternalCheckWaivers: a window longer than maxValidity is rejected as expired', () => {
  const head = 'a'.repeat(40);
  // 48h validity window (created → expires), still in the future vs `now` so
  // the ordinary already-expired check passes and the new window check fires.
  const body = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    expiresAt: '2026-05-19T00:00:00Z',
  });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const opts = {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T01:00:00Z',
  };
  // Off by default: the window check does not fire, so the waiver is valid.
  assert.equal(
    summarizeExternalCheckWaivers([comment], opts).valid.length,
    1,
    'window check stays off when maxValidity is omitted',
  );
  // On: the 48h window exceeds PT24H, so the same waiver is now rejected.
  const gated = summarizeExternalCheckWaivers([comment], {
    ...opts,
    maxValidity: 'PT24H',
  });
  assert.equal(gated.valid.length, 0, 'over-long window must not be valid');
  assert.equal(gated.expired.length, 1);
});

test('summarizeExternalCheckWaivers: a window within maxValidity stays valid', () => {
  const head = 'a'.repeat(40);
  // 12h window, under the PT24H policy ceiling.
  const body = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    expiresAt: '2026-05-17T12:00:00Z',
  });
  const comment = {
    body,
    author: { login: 'kurone-kito' },
    createdAt: '2026-05-17T00:00:00Z',
  };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T01:00:00Z',
    maxValidity: 'PT24H',
  });
  assert.equal(result.valid.length, 1);
  assert.equal(result.expired.length, 0);
});

test('summarizeExternalCheckWaivers: an unknown creation time fails closed to expired when maxValidity is set', () => {
  const head = 'a'.repeat(40);
  const body = makeWaiverComment({
    headSha: head,
    claimId: 'claim-123',
    expiresAt: '2026-05-19T00:00:00Z',
  });
  // No created_at / createdAt on the comment → parsed.createdAt resolves to
  // 'none', so the window cannot be measured and the gate fails closed.
  const comment = { body, author: { login: 'kurone-kito' } };
  const result = summarizeExternalCheckWaivers([comment], {
    prHeadSha: head,
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T01:00:00Z',
    maxValidity: 'PT24H',
  });
  assert.equal(
    result.valid.length,
    0,
    'unknown creation time must not be valid',
  );
  assert.equal(result.expired.length, 1);
});

test('summarizeExternalCheckWaivers: non-waiver comments are skipped without error', () => {
  const comments = [
    {
      body: 'This is a regular PR comment',
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:00:00Z',
    },
    {
      body:
        '<!-- review-watermark: claude-code c ' +
        'a'.repeat(40) +
        ' 2026-05-17T00:00:00Z 1 none -->',
      author: { login: 'kurone-kito' },
      createdAt: '2026-05-17T00:01:00Z',
    },
  ];
  const result = summarizeExternalCheckWaivers(comments, {
    prHeadSha: 'a'.repeat(40),
    activeClaimId: 'claim-123',
    trustedMarkerLogins: ['kurone-kito'],
    now: '2026-05-17T00:10:00Z',
  });
  assert.deepEqual(result, {
    valid: [],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
    modeDisabled: [],
  });
});

test('summarizeRequiredChecks: waiver with glob selector covers matching failing check', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'Code*',
        reason: 'test',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
  };
  const result = summarizeRequiredChecks(
    [
      { name: 'CodeQL', state: 'FAILURE', completedAt: '2026-05-17T00:00:00Z' },
      { name: 'lint', state: 'FAILURE', completedAt: '2026-05-17T00:00:00Z' },
    ],
    [],
    { required_status_checks: { contexts: ['CodeQL', 'lint'] } },
    { waivers },
  );
  const codeQL = result.checks.find((c) => c.name === 'CodeQL');
  const lint = result.checks.find((c) => c.name === 'lint');
  assert.equal(codeQL?.coveredByWaiver, true, 'CodeQL matched by Code* glob');
  assert.ok(lint);
  assert.equal(
    lint.coveredByWaiver,
    undefined,
    'lint not matched by Code* glob',
  );
});

test('summarizeExternalCheckWaivers: validity-passing waiver for a non-waivable check goes to notConfigured', () => {
  const head = 'e'.repeat(40);
  // The waiver names "CodeRabbit" but the policy only declares "deploy/prod"
  // waivable, so it is reported but must not count as valid.
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'deploy/prod', matchMode: 'exact' }],
    },
  );
  assert.equal(result.valid.length, 0);
  assert.equal(result.notConfigured.length, 1);
  assert.equal(result.notConfigured[0].checkSelector, 'CodeRabbit');
  assert.equal(result.notConfigured[0].authorLogin, 'kurone-kito');
});

test('summarizeExternalCheckWaivers: an otherwise-valid, configured-waivable waiver goes to modeDisabled when mode is not maintainer-authorized (#2046)', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
      mode: 'disabled',
    },
  );
  assert.equal(result.valid.length, 0);
  assert.equal(result.notConfigured.length, 0);
  assert.equal(result.modeDisabled.length, 1);
  assert.equal(result.modeDisabled[0].checkSelector, 'CodeRabbit');
  assert.equal(result.modeDisabled[0].authorLogin, 'kurone-kito');
});

test('summarizeExternalCheckWaivers: an empty mode leaves the mode gate off (legacy behavior for unmigrated callers)', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.modeDisabled.length, 0);
});

test('summarizeExternalCheckWaivers: waiver naming a configured-waivable check stays valid', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.notConfigured.length, 0);
});

test('summarizeExternalCheckWaivers: a glob waivable selector admits a matching waiver', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'Code*', matchMode: 'glob' }],
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.notConfigured.length, 0);
});

test('summarizeExternalCheckWaivers: omitting waivableSelectors keeps the legacy no-gate path', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.notConfigured.length, 0);
});

test('summarizeExternalCheckWaivers: an empty waivable list waives nothing', () => {
  const head = 'e'.repeat(40);
  const body = makeWaiverComment({ claimId: 'claim-123', headSha: head });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [],
    },
  );
  assert.equal(result.valid.length, 0);
  assert.equal(result.notConfigured.length, 1);
});

test('summarizeRequiredChecks: a configured-waivable check still folds in', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'CodeRabbit',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
  };
  const result = summarizeRequiredChecks(
    [
      {
        name: 'CodeRabbit',
        state: 'FAILURE',
        completedAt: '2026-05-17T00:00:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    {
      waivers,
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('summarizeRequiredChecks: a waived but non-waivable check is not covered', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'CodeRabbit',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
  };
  const result = summarizeRequiredChecks(
    [{ name: 'CodeRabbit', state: 'FAILURE', completedAt: '' }],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    {
      waivers,
      waivableSelectors: [{ selector: 'deploy/prod', matchMode: 'exact' }],
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

test('summarizeRequiredChecks: an empty waivable list covers nothing', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'CodeRabbit',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
  };
  const result = summarizeRequiredChecks(
    [{ name: 'CodeRabbit', state: 'FAILURE', completedAt: '' }],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    { waivers, waivableSelectors: [] },
  );
  assert.equal(result.checks[0].coveredByWaiver, undefined);
  assert.notEqual(result.status, 'success');
});

test('summarizeExternalCheckWaivers: a glob waiver selector overlaps an exact waivable surface', () => {
  const head = 'f'.repeat(40);
  // A glob waiver "Code*" against an exact waivable "CodeRabbit" must stay
  // valid: planExternalCheckWaiver creates such globs, so misbucketing them as
  // notConfigured would silently drop a legitimate waiver.
  const body = makeWaiverComment({
    claimId: 'claim-123',
    headSha: head,
    checkSelector: 'Code*',
  });
  const result = summarizeExternalCheckWaivers(
    [
      {
        body,
        author: { login: 'kurone-kito' },
        createdAt: '2026-05-17T00:00:00Z',
      },
    ],
    {
      prHeadSha: head,
      activeClaimId: 'claim-123',
      trustedMarkerLogins: ['kurone-kito'],
      now: '2026-05-17T00:00:00Z',
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
    },
  );
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].checkSelector, 'Code*');
  assert.equal(result.notConfigured.length, 0);
});

test('summarizeRequiredChecks: a glob waiver folds in an exact-configured-waivable check', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'Code*',
        reason: 'rate-limit',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-05-16T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
    notConfigured: [],
  };
  const result = summarizeRequiredChecks(
    [
      {
        name: 'CodeRabbit',
        state: 'FAILURE',
        completedAt: '2026-05-17T00:00:00Z',
      },
    ],
    [],
    { required_status_checks: { contexts: ['CodeRabbit'] } },
    {
      waivers,
      waivableSelectors: [{ selector: 'CodeRabbit', matchMode: 'exact' }],
    },
  );
  assert.equal(result.checks[0].coveredByWaiver, true);
  assert.equal(result.status, 'success');
});

test('buildPreMergeReadinessSummary: waiverEvidence always present and validates against schema', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, fixture.options);
  assert.ok(
    Object.hasOwn(summary, 'waiverEvidence'),
    'waiverEvidence must be present',
  );
  const waiverEvidence = summary.waiverEvidence as Record<string, unknown>;
  assert.ok(Array.isArray(waiverEvidence.valid));
  assert.ok(Array.isArray(waiverEvidence.expired));
  assert.ok(Array.isArray(waiverEvidence.wrongHead));
  assert.ok(Array.isArray(waiverEvidence.wrongClaim));
  assert.ok(Array.isArray(waiverEvidence.unauthorized));
  assert.ok(Array.isArray(waiverEvidence.malformed));
  assert.ok(Array.isArray(waiverEvidence.notConfigured));
  assert.deepEqual(validate(summary, readinessSchema), []);
});

test('waiverEvidence with wrong-shape valid item fails schema validation', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, fixture.options);
  const bad = JSON.parse(JSON.stringify(summary));
  bad.waiverEvidence.valid = [{ wrong: 'shape', missing: 'required fields' }];
  assert.ok(
    validate(bad, readinessSchema).length > 0,
    'invalid waiverEvidence.valid shape must fail schema',
  );
});

// ---------------------------------------------------------------------------
// resolveActiveClaimForWriteGate (#1058): the write-side merge-gate revalidator
// must recognize an operator-approved forced-handoff successor's claim while
// failing closed on unauthorized/forged markers exactly as Resume routing does.
// ---------------------------------------------------------------------------

const WG_OLD_CLAIM =
  '<!-- claimed-by: cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat -->';

function wgClaimEvent() {
  return {
    body: [WG_OLD_CLAIM, '', '_cli-old: issue claim - IDD marker._'].join('\n'),
    createdAt: '2026-05-12T09:00:00Z',
    author: { login: 'cli-old' },
  };
}

function wgHandoffEvent(
  overrides: {
    contextScope?: string;
    linkedPr?: string;
    forcedBy?: string;
    author?: string;
    oldClaimId?: string;
    branch?: string;
    createdAt?: string;
    timestamp?: string;
  } = {},
) {
  const payload: Record<string, string> = {
    'old-agent-id': 'cli-old',
    'old-claim-id': overrides.oldClaimId ?? 'claim-20260512T090000Z-337-old',
    'new-agent-id': 'cli-new',
    'new-claim-id': 'claim-20260512T110000Z-337-new',
    branch: overrides.branch ?? 'issue/337-feat',
    'forced-by': overrides.forcedBy ?? 'kurone-kito',
    reason: 'operator-approved-recovery',
    timestamp: overrides.timestamp ?? '2026-05-12T11:00:00Z',
    'context-scope': overrides.contextScope ?? 'issue-only',
  };
  if (overrides.linkedPr) {
    payload['linked-pr'] = overrides.linkedPr;
  }
  return {
    body: [
      `<!-- forced-handoff: ${JSON.stringify(payload)} -->`,
      '',
      `Forced handoff approved by ${overrides.forcedBy ?? 'kurone-kito'}.`,
    ].join('\n'),
    createdAt: overrides.createdAt ?? '2026-05-12T11:00:05Z',
    author: { login: overrides.author ?? overrides.forcedBy ?? 'kurone-kito' },
  };
}

const wgTrusted = (login: string): boolean =>
  ['cli-old', 'cli-new', 'kurone-kito', 'attacker'].includes(login);

test('resolveActiveClaimForWriteGate recognizes an authorized issue-only handoff', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T110000Z-337-new');
  assert.equal(active?.agentId, 'cli-new');
});

test('resolveActiveClaimForWriteGate keeps the original on an unauthorized approver', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent({ forcedBy: 'attacker' })],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(active?.agentId, 'cli-old');
});

test('resolveActiveClaimForWriteGate keeps the original on a self-signed handoff', () => {
  // Author (cli-old) does not match forced-by (kurone-kito): the strict
  // requireAuthorMatchesForcedBy default rejects this self-attested handoff.
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent({ author: 'cli-old' })],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveActiveClaimForWriteGate keeps the original when mode is disabled', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: false,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveActiveClaimForWriteGate is inert on an old-claim-id mismatch', () => {
  const active = resolveActiveClaimForWriteGate(
    [
      wgClaimEvent(),
      wgHandoffEvent({ oldClaimId: 'claim-does-not-match-active' }),
    ],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveActiveClaimForWriteGate is inert on a branch mismatch', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent({ branch: 'issue/999-other' })],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveActiveClaimForWriteGate defaults isAuthorizedForcedHandoff to fail closed', () => {
  // No isAuthorizedForcedHandoff supplied → allowlist ∅ → every handoff is
  // treated as unauthorized, so the original claim stays active.
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: null,
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('resolveActiveClaimForWriteGate resolves a plain claim like a bare predicate call', () => {
  const events = [wgClaimEvent()];
  const writeGate = resolveActiveClaimForWriteGate(events, {
    isTrustedAuthor: wgTrusted,
  });
  // A non-FH repo (no handoff marker) must resolve identically to the bare
  // resolveActiveClaim(events, predicate) path.
  assert.equal(writeGate?.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(writeGate?.agentId, 'cli-old');
});

test('Part B: PR-backed claim accepts an issue-only handoff that predates the PR', () => {
  // Handoff createdAt 2026-05-12T11:00:05Z is strictly before the PR first
  // commit at 2026-05-12T12:00:00Z → accepted even though it is issue-only.
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: ['#359'],
      prFirstCommitAt: '2026-05-12T12:00:00Z',
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T110000Z-337-new');
});

test('Part B: PR-backed claim rejects an issue-only handoff at/after the PR first commit', () => {
  // Handoff createdAt 2026-05-12T11:00:05Z is NOT before the PR first commit
  // at 2026-05-12T10:00:00Z → rejected; the original claim stays active.
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: ['#359'],
      prFirstCommitAt: '2026-05-12T10:00:00Z',
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('Part B: PR-backed claim rejects an issue-only handoff with no prFirstCommitAt', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgHandoffEvent()],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: ['#359'],
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('Part B: PR-backed claim accepts an issue-plus-pr handoff with a matching linked-pr', () => {
  const active = resolveActiveClaimForWriteGate(
    [
      wgClaimEvent(),
      wgHandoffEvent({ contextScope: 'issue-plus-pr', linkedPr: '359' }),
    ],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: ['#359'],
      // prFirstCommitAt before the handoff: proves issue-plus-pr is honored
      // by the linked-pr match, not by the predates-PR rule.
      prFirstCommitAt: '2026-05-12T10:00:00Z',
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T110000Z-337-new');
});

test('Part B: PR-backed claim rejects an issue-plus-pr handoff with a mismatching linked-pr', () => {
  const active = resolveActiveClaimForWriteGate(
    [
      wgClaimEvent(),
      wgHandoffEvent({ contextScope: 'issue-plus-pr', linkedPr: '999' }),
    ],
    {
      isTrustedAuthor: wgTrusted,
      forcedHandoffEnabled: true,
      expectedLinkedPrs: ['#359'],
      prFirstCommitAt: '2026-05-12T12:00:00Z',
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
});

test('Part B: summarizeClaimValidation accepts an issue-only handoff predating the PR', () => {
  const summary = summarizeClaimValidation([wgClaimEvent(), wgHandoffEvent()], {
    trustedMarkerLogins: ['cli-old', 'cli-new', 'kurone-kito'],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedLinkedPrs: ['#359'],
    prFirstCommitAt: '2026-05-12T12:00:00Z',
    expectedClaimId: 'claim-20260512T110000Z-337-new',
    expectedAgentId: 'cli-new',
  });
  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
});

test('Part B: summarizeClaimValidation rejects an issue-only handoff after the PR first commit', () => {
  const summary = summarizeClaimValidation([wgClaimEvent(), wgHandoffEvent()], {
    trustedMarkerLogins: ['cli-old', 'cli-new', 'kurone-kito'],
    forcedHandoffEnabled: true,
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'kurone-kito',
    expectedLinkedPrs: ['#359'],
    prFirstCommitAt: '2026-05-12T10:00:00Z',
    expectedClaimId: 'claim-20260512T090000Z-337-old',
    expectedAgentId: 'cli-old',
  });
  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
});

// ---------------------------------------------------------------------------
// #1310: the write-gate resolvers must honor a configured claimTiming.staleAge
// instead of being locked to the hardcoded 24h default. WG_OLD_CLAIM is
// created at 2026-05-12T09:00:00Z; the takeover claim below lands 20h later
// (2026-05-13T05:00:00Z) — squarely in the 18-24h gap the issue describes:
// stale under an 18h configured age, not stale under the old hardcoded 24h.
// ---------------------------------------------------------------------------

const WG_TAKEOVER_CLAIM_ID = 'claim-20260513T050000Z-337-new';
const EIGHTEEN_HOURS_MS = 18 * 60 * 60 * 1000;

function wgTakeoverEvent() {
  const body = `<!-- claimed-by: cli-new ${WG_TAKEOVER_CLAIM_ID} supersedes: claim-20260512T090000Z-337-old 2026-05-13T05:00:00Z branch: issue/337-feat -->`;
  return {
    body: [body, '', '_cli-new: issue claim — IDD automation marker._'].join(
      '\n',
    ),
    createdAt: '2026-05-13T05:00:00Z',
    author: { login: 'cli-new' },
  };
}

test('resolveActiveClaimForWriteGate recognizes a takeover claim inside a configured 18h staleAge', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgTakeoverEvent()],
    {
      isTrustedAuthor: wgTrusted,
      staleAgeMs: EIGHTEEN_HOURS_MS,
    },
  );
  assert.equal(active?.claimId, WG_TAKEOVER_CLAIM_ID);
  assert.equal(active?.agentId, 'cli-new');
});

test('resolveActiveClaimForWriteGate keeps the old claim active for the same 20h gap without staleAgeMs (old hardcoded 24h)', () => {
  const active = resolveActiveClaimForWriteGate(
    [wgClaimEvent(), wgTakeoverEvent()],
    {
      isTrustedAuthor: wgTrusted,
    },
  );
  assert.equal(active?.claimId, 'claim-20260512T090000Z-337-old');
  assert.equal(active?.agentId, 'cli-old');
});

test('summarizeClaimValidation reports no claimLost for a takeover inside a configured 18h staleAge', () => {
  const summary = summarizeClaimValidation(
    [wgClaimEvent(), wgTakeoverEvent()],
    {
      trustedMarkerLogins: ['cli-old', 'cli-new'],
      expectedClaimId: WG_TAKEOVER_CLAIM_ID,
      expectedAgentId: 'cli-new',
      staleAgeMs: EIGHTEEN_HOURS_MS,
    },
  );
  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
  assert.equal(summary.activeClaim.claimId, WG_TAKEOVER_CLAIM_ID);
});

test('summarizeClaimValidation falsely reports claimLost for the same takeover without staleAgeMs (the #1310 bug, pinned)', () => {
  // Documents the exact production symptom from the issue: the legitimate
  // successor's session recorded WG_TAKEOVER_CLAIM_ID as its expected claim,
  // but the write gate — with no staleAgeMs override — still resolves the
  // hardcoded-stale old claim as active, so a live successor reads as
  // claimLost. Fixed by passing staleAgeMs from the resolved policy.
  const summary = summarizeClaimValidation(
    [wgClaimEvent(), wgTakeoverEvent()],
    {
      trustedMarkerLogins: ['cli-old', 'cli-new'],
      expectedClaimId: WG_TAKEOVER_CLAIM_ID,
      expectedAgentId: 'cli-new',
    },
  );
  assert.equal(summary.claimLost, true);
  assert.equal(summary.reason, 'claim-id-mismatch');
  assert.equal(summary.activeClaim.claimId, 'claim-20260512T090000Z-337-old');
});

test('buildPreMergeReadinessSummary threads staleAgeMs to the F2/F3 claim gate (#1310)', () => {
  // End-to-end proof that the merge-gate aggregator itself (not just the
  // underlying write-gate resolvers) honors a configured claimTiming.staleAge:
  // the same 20h-gap takeover from the tests above, driven through the full
  // buildPreMergeReadinessSummary entry point pre-merge-readiness.mts calls.
  const prHeadSha = '1111111111111111111111111111111111111111';
  const now = '2026-05-14T00:00:00Z';
  const claimEvents = [wgClaimEvent(), wgTakeoverEvent()];

  const withConfiguredStaleAge = buildPreMergeReadinessSummary(
    { prHeadSha, claimEvents },
    {
      now,
      trustedMarkerLogins: ['cli-old', 'cli-new'],
      staleAgeMs: EIGHTEEN_HOURS_MS,
    },
  );
  const claimWithConfiguredStaleAge = withConfiguredStaleAge.claim as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    claimWithConfiguredStaleAge.activeClaim.claimId,
    WG_TAKEOVER_CLAIM_ID,
  );

  const withoutStaleAgeOverride = buildPreMergeReadinessSummary(
    { prHeadSha, claimEvents },
    { now, trustedMarkerLogins: ['cli-old', 'cli-new'] },
  );
  const claimWithoutStaleAgeOverride = withoutStaleAgeOverride.claim as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    claimWithoutStaleAgeOverride.activeClaim.claimId,
    'claim-20260512T090000Z-337-old',
  );
});

// Shape of a real execFileSync('gh', ...) failure: exit code 1 with the true
// HTTP status carried in stderr (mirrors gh-http-status.test.mts). gh writes a
// 404 response body to stdout, so fetchBranchRulesets must discriminate on the
// thrown status rather than on an empty body.
const ghHttpError = (httpStatus: number, label: string) =>
  Object.assign(new Error('Command failed'), {
    status: 1,
    stderr: `gh: ${label} (HTTP ${httpStatus})`,
  });

const oneRulesetRule = [{ ruleset_id: 1 }] as Parameters<
  typeof fetchBranchRulesets
>[2];

test('fetchBranchRulesets skips a 404 ruleset detail without throwing', () => {
  const seen: string[] = [];
  const result = fetchBranchRulesets(
    'o',
    'r',
    oneRulesetRule,
    false,
    (path) => {
      seen.push(path);
      throw ghHttpError(404, 'Not Found');
    },
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /\/rulesets\/1$/);
  assert.deepEqual(result.value, []);
});

test('fetchBranchRulesets keeps real rulesets and drops empty results', () => {
  const rules = [{ ruleset_id: 1 }, { ruleset_id: 2 }] as Parameters<
    typeof fetchBranchRulesets
  >[2];
  const result = fetchBranchRulesets('o', 'r', rules, false, (path) =>
    path.endsWith('/1') ? { id: 1, current_user_can_bypass: 'always' } : {},
  );
  assert.deepEqual(result.value, [
    { id: 1, current_user_can_bypass: 'always' },
  ]);
  assert.equal(result.unreadable, false);
});

test('fetchBranchRulesets propagates a non-404 fetch error instead of coercing to "no ruleset"', () => {
  const boom = ghHttpError(403, 'API rate limit exceeded');
  assert.throws(
    () =>
      fetchBranchRulesets('o', 'r', oneRulesetRule, false, () => {
        throw boom;
      }),
    (error: unknown) => error === boom,
  );
});

// #1380: GitHub's "Get a repository ruleset" reference documents only
// `200`/`404`/`500` for this endpoint -- no `403` -- so a `404` here is
// structurally ambiguous the same way #1377 established for the other two
// governance reads (see `fetchGovernanceJson`'s doc comment for the full
// citation set).
test('fetchBranchRulesets marks a masked-404 ruleset detail as unreadable by default (fail closed)', () => {
  const result = fetchBranchRulesets('o', 'r', oneRulesetRule, false, () => {
    throw ghHttpError(404, 'Not Found');
  });
  assert.deepEqual(result, { value: [], unreadable: true });
});

test('fetchBranchRulesets trusts a masked-404 ruleset detail as genuinely empty when ciGate.trustEmptyProtectionReads opts in', () => {
  const result = fetchBranchRulesets('o', 'r', oneRulesetRule, true, () => {
    throw ghHttpError(404, 'Not Found');
  });
  assert.deepEqual(result, { value: [], unreadable: false });
});

// #1377: neither `branches/{branch}/protection` nor `rules/branches/{branch}`
// documents a `403` response at all (only `200`/`404`), so a `404` is
// structurally ambiguous between "genuinely nothing configured" and "the
// token cannot read this" (see idd-ci.instructions.md's Required-check
// discovery step 4 for the citations). fetchGovernanceJson is the shared
// helper that both reads go through.
test('fetchGovernanceJson passes a successful fetch through unchanged', () => {
  const result = fetchGovernanceJson(
    'repos/o/r/branches/main/protection',
    false,
    false,
    {},
    () => ({ required_status_checks: { contexts: ['lint'] } }),
  );
  assert.deepEqual(result, {
    value: { required_status_checks: { contexts: ['lint'] } },
    unreadable: false,
  });
});

test('fetchGovernanceJson treats a 404 as unreadable by default (fail closed)', () => {
  const result = fetchGovernanceJson(
    'repos/o/r/branches/main/protection',
    false,
    false,
    {},
    () => {
      throw ghHttpError(404, 'Branch not protected');
    },
  );
  assert.deepEqual(result, { value: {}, unreadable: true });
});

test('fetchGovernanceJson trusts a 404 as genuinely empty when ciGate.trustEmptyProtectionReads opts in', () => {
  const result = fetchGovernanceJson(
    'repos/o/r/branches/main/protection',
    false,
    true,
    {},
    () => {
      throw ghHttpError(404, 'Branch not protected');
    },
  );
  assert.deepEqual(result, { value: {}, unreadable: false });
});

test('fetchGovernanceJson propagates a non-404 fetch error instead of coercing to "unreadable"', () => {
  const boom = ghHttpError(403, 'Forbidden');
  assert.throws(
    () =>
      fetchGovernanceJson(
        'repos/o/r/rules/branches/main',
        true,
        false,
        [],
        () => {
          throw boom;
        },
      ),
    (error: unknown) => error === boom,
  );
});

// gh api writes the JSON error body to stdout on a non-2xx response, so an
// allowed HTTP status must yield an empty result rather than that error object.
const ghHttpErrorWithStdout = (
  httpStatus: number,
  label: string,
  stdout: string,
) => Object.assign(ghHttpError(httpStatus, label), { stdout });

test('resolveToleratedGhFailure yields empty for an allowed HTTP status, not the gh error body on stdout', () => {
  const error = ghHttpErrorWithStdout(
    404,
    'Not Found',
    '{"message":"Not Found","documentation_url":"https://docs","status":"404"}',
  );
  // Empty (not the 3-key error object) is what ghApiJson coerces to {} / []
  // for an allowed 404 — see its `if (!raw) return paginate ? [] : {}` branch.
  assert.equal(
    resolveToleratedGhFailure(error, { allowHttpStatuses: [404] }),
    '',
  );
});

test('resolveToleratedGhFailure prefers an allowed HTTP status over a tolerated exit code', () => {
  // Both options set on the same failure: a tolerated 404 whose JSON error body
  // also lands on stdout under a tolerated exit code must still yield empty — the
  // allowHttpStatuses branch wins so the error body never leaks through.
  const error = ghHttpErrorWithStdout(
    404,
    'Not Found',
    '{"message":"Not Found","status":"404"}',
  );
  assert.equal(
    resolveToleratedGhFailure(error, {
      allowStatuses: [1],
      allowHttpStatuses: [404],
    }),
    '',
  );
});

test('resolveToleratedGhFailure derives an allowed status from a JSON error body when stderr lacks (HTTP nnn)', () => {
  // deriveGhHttpStatus also reads a JSON "status" field, so a 404 whose status
  // appears only in the body (not in an stderr `(HTTP 404)` suffix) still
  // resolves to empty for an allowed 404 — robustness the local regex lacked.
  const error = Object.assign(new Error('Command failed'), {
    status: 1,
    stdout: '{"message":"Not Found","status":"404"}',
  });
  assert.equal(
    resolveToleratedGhFailure(error, { allowHttpStatuses: [404] }),
    '',
  );
});

test('resolveToleratedGhFailure re-throws (returns undefined) for a non-allowed HTTP status', () => {
  const error = ghHttpErrorWithStdout(
    403,
    'API rate limit exceeded',
    '{"message":"API rate limit exceeded"}',
  );
  assert.equal(
    resolveToleratedGhFailure(error, { allowHttpStatuses: [404] }),
    undefined,
  );
});

test('resolveToleratedGhFailure keeps the allowStatuses path returning JSON stdout', () => {
  // The exit-code path is unchanged: it returns stdout when the body is the
  // wanted JSON (e.g. the checks rollup exits non-zero but still prints data).
  const error = Object.assign(new Error('Command failed'), {
    status: 8,
    stdout: '[{"state":"SUCCESS"}]',
  });
  assert.equal(
    resolveToleratedGhFailure(error, { allowStatuses: [1, 8] }),
    '[{"state":"SUCCESS"}]',
  );
});

test('resolveToleratedGhFailure ignores non-JSON allowStatuses stdout and falls through', () => {
  // A tolerated exit code whose stdout is not JSON is not a usable result; with
  // no matching HTTP status it returns undefined so runGh re-throws.
  const error = Object.assign(new Error('Command failed'), {
    status: 1,
    stdout: 'some plain log line',
    stderr: 'gh: boom',
  });
  assert.equal(
    resolveToleratedGhFailure(error, { allowStatuses: [1] }),
    undefined,
  );
});

// #2353 (Codex review on PR #2370, second follow-up): a declaration's own
// `startedAt` is generated before the `--declare --apply` interactive
// confirmation prompt, while the GitHub comment's `createdAt` is stamped
// only once the maintainer confirms posting. Use the LATER of the two as
// the "declaration became a real, postable fact" cutoff.
test('resolveDeclarationActiveSince uses createdAt when it is later than startedAt (the pause-at-prompt case)', () => {
  assert.equal(
    resolveDeclarationActiveSince({
      startedAt: '2026-05-12T00:00:00Z',
      createdAt: '2026-05-12T00:05:00Z', // maintainer paused 5 minutes at the prompt
    }),
    '2026-05-12T00:05:00.000Z',
  );
});

test('resolveDeclarationActiveSince uses startedAt when it is later than createdAt (the ordinary case)', () => {
  assert.equal(
    resolveDeclarationActiveSince({
      startedAt: '2026-05-12T00:05:00Z',
      createdAt: '2026-05-12T00:00:00Z',
    }),
    '2026-05-12T00:05:00.000Z',
  );
});

test('resolveDeclarationActiveSince falls back to startedAt alone when createdAt is the schema-documented "none" sentinel', () => {
  assert.equal(
    resolveDeclarationActiveSince({
      startedAt: '2026-05-12T00:00:00Z',
      createdAt: 'none',
    }),
    '2026-05-12T00:00:00.000Z',
  );
});

test('resolveDeclarationActiveSince returns empty when both timestamps are unparseable', () => {
  assert.equal(
    resolveDeclarationActiveSince({ startedAt: '', createdAt: 'none' }),
    '',
  );
});

test('resolveDeclarationActiveSince returns empty for a null declaration', () => {
  assert.equal(resolveDeclarationActiveSince(null), '');
});

// #1483: normalizeStatusCheckRollupEntry replaced the old `gh pr checks`
// data source with `statusCheckRollup`, so its output must stay behaviorally
// identical to what `gh pr checks --json name,state,completedAt` reported
// for the same underlying data (verified empirically against this
// repository's own live PRs before this change shipped) while also
// surfacing the new `type` / `workflowName` producer-identity fields.
test('normalizeStatusCheckRollupEntry: a completed CheckRun reports its conclusion as state', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'CheckRun',
    name: 'idd-advisory-convergence',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    completedAt: '2026-07-18T03:47:01Z',
    startedAt: '2026-07-18T03:44:12Z',
    workflowName: 'IDD advisory-convergence gate',
  });
  assert.deepEqual(result, {
    name: 'idd-advisory-convergence',
    state: 'SUCCESS',
    completedAt: '2026-07-18T03:47:01Z',
    startedAt: '2026-07-18T03:44:12Z',
    type: 'check-run',
    workflowName: 'IDD advisory-convergence gate',
  });
});

test('normalizeStatusCheckRollupEntry: an in-progress CheckRun reports its raw status as state, not a stale conclusion', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'CheckRun',
    name: 'lint',
    status: 'IN_PROGRESS',
    conclusion: '',
    completedAt: '0001-01-01T00:00:00Z',
    workflowName: 'Linting workflow',
  });
  assert.equal(result.state, 'IN_PROGRESS');
  assert.equal(result.completedAt, '0001-01-01T00:00:00Z');
  assert.equal(result.type, 'check-run');
});

test('normalizeStatusCheckRollupEntry: a StatusContext reports its own state and name from context, with no workflowName', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'CodeRabbit',
    state: 'success',
  });
  assert.deepEqual(result, {
    name: 'CodeRabbit',
    state: 'SUCCESS',
    completedAt: '0001-01-01T00:00:00Z',
    startedAt: '0001-01-01T00:00:00Z',
    type: 'status-context',
    workflowName: '',
  });
});

test('normalizeStatusCheckRollupEntry: a StatusContext with no completedAt field defaults to the zero-value sentinel', () => {
  // StatusContext has no completedAt in the GraphQL schema at all (only
  // CheckRun does); the entry omits the field entirely rather than sending
  // an empty string, so this covers the `?? ZERO_SENTINEL_TIMESTAMP`
  // fallback path distinctly from an entry that sends `completedAt: ''`.
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'some-legacy-status',
    state: 'PENDING',
  });
  assert.equal(result.completedAt, '0001-01-01T00:00:00Z');
});

// PR #1506 review findings (Copilot, on #1483's implementation): the
// commit-status vocabulary (`error`/`failure`/`pending`/`success`) only
// partly overlaps the check-run vocabulary `classifyCiChecks` understands.
// `gh pr checks`'s prior flattened read normalized both vocabularies into
// one `state` field; this data-source swap makes that this module's own
// responsibility, so cover the two divergent tokens explicitly.
test('normalizeStatusCheckRollupEntry: a StatusContext ERROR normalizes to FAILURE, not an unrecognized state', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'legacy-ci',
    state: 'error',
  });
  assert.equal(result.state, 'FAILURE');
});

test('normalizeStatusCheckRollupEntry: a StatusContext PENDING normalizes to IN_PROGRESS, not an unrecognized state', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'legacy-ci',
    state: 'pending',
  });
  assert.equal(result.state, 'IN_PROGRESS');
});

// E10 follow-up (this PR's own critique pass): the commit-status `state`
// GraphQL enum (`StatusState`) actually has 5 members, not the 4 the
// original fix accounted for -- `EXPECTED` (a required status check
// configured for this ref but not yet reported at all) is also still
// "not done", not a failure, so it maps the same way PENDING does.
test('normalizeStatusCheckRollupEntry: a StatusContext EXPECTED normalizes to IN_PROGRESS, not an unrecognized state', () => {
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'legacy-ci',
    state: 'expected',
  });
  assert.equal(result.state, 'IN_PROGRESS');
});

test('normalizeStatusCheckRollupEntry: a StatusContext ERROR reaches classifyCiChecks as a genuine failure, end to end', () => {
  // The isolated mapping test above only proves the translation table
  // works; this proves the translated value actually makes
  // classifyCiChecks treat it as failing rather than silently landing in
  // its 'unknown' bucket (unrecognized state literals fall through every
  // bucket check).
  const normalized = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: 'legacy-ci',
    state: 'error',
  });
  assert.equal(classifyCiChecks([normalized]).status, 'failed');
});

test('normalizeStatusCheckRollupEntry: a CheckRun with no status field at all defaults to UNKNOWN, not an empty string', () => {
  // Distinct from the existing "in-progress" test: this entry omits
  // `status` entirely (a malformed/unexpected entry), which previously
  // fell through to state: '' -- a value classifyCiChecks does not
  // recognize as any bucket, unlike the explicit 'UNKNOWN' fallback the
  // completed-with-no-conclusion branch already had.
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'CheckRun',
    name: 'malformed-entry',
  });
  assert.equal(result.state, 'UNKNOWN');
});

test('normalizeStatusCheckRollupEntry: whitespace-padded fields are trimmed consistently', () => {
  const checkRun = normalizeStatusCheckRollupEntry({
    __typename: 'CheckRun',
    name: '  padded-name  ',
    status: '  COMPLETED  ',
    conclusion: '  SUCCESS  ',
    workflowName: '  Some Workflow  ',
  });
  assert.equal(checkRun.name, 'padded-name');
  assert.equal(checkRun.state, 'SUCCESS');
  assert.equal(checkRun.workflowName, 'Some Workflow');

  const statusContext = normalizeStatusCheckRollupEntry({
    __typename: 'StatusContext',
    context: '  padded-context  ',
    state: '  success  ',
  });
  assert.equal(statusContext.name, 'padded-context');
  assert.equal(statusContext.state, 'SUCCESS');
});

test('normalizeStatusCheckRollupEntry: an unrecognized __typename falls back to the CheckRun shape', () => {
  // Mirrors ci-wait-state.mts's own "StatusContext, else check-run" branch
  // structure: any future GraphQL union member normalizes as a check-run
  // rather than being silently dropped.
  const result = normalizeStatusCheckRollupEntry({
    __typename: 'SomeFutureUnionMember',
    name: 'future-check',
    status: 'COMPLETED',
    conclusion: 'NEUTRAL',
    completedAt: '2026-07-18T00:00:00Z',
  });
  assert.equal(result.type, 'check-run');
  assert.equal(result.state, 'NEUTRAL');
});

test('parseArgs: valid --pr / --claim-issue parse to positive integers', () => {
  const args = parseArgs(['--pr', '1082', '--claim-issue', '1076']);
  assert.equal(args.prNumber, 1082);
  assert.equal(args.claimIssueNumber, 1076);
  assert.equal(args.claimless, false);
});

test('parseArgs: --claimless is accepted alone and rejects claim flags (#2017)', () => {
  const args = parseArgs(['--pr', '1082', '--claimless']);
  assert.equal(args.prNumber, 1082);
  assert.equal(args.claimIssueNumber, null);
  assert.equal(args.claimless, true);
  assert.throws(
    () => parseArgs(['--pr', '1082', '--claimless', '--claim-issue', '1076']),
    /--claimless cannot be combined with --claim-issue/,
  );
  assert.throws(
    () => parseArgs(['--pr', '1082', '--claimless', '--claim-id', 'abc']),
    /--claimless cannot be combined with --claim-id/,
  );
});

test('parseArgs: --nonce (#1528) defaults to empty and round-trips when given', () => {
  const withoutNonce = parseArgs(['--pr', '1082', '--claim-issue', '1076']);
  assert.equal(withoutNonce.nonce, '');

  const withNonce = parseArgs([
    '--pr',
    '1082',
    '--claim-issue',
    '1076',
    '--nonce',
    'nonce-mine',
  ]);
  assert.equal(withNonce.nonce, 'nonce-mine');
});

test('parseArgs: a flag-shaped value throws instead of consuming the flag', () => {
  // `--pr --json` must fail fast, not parse `--json` into the PR number.
  assert.throws(() => parseArgs(['--pr', '--json']), /missing value/);
  assert.throws(
    () => parseArgs(['--pr', '1082', '--claim-issue', '--owner']),
    /missing value/,
  );
  assert.throws(() => parseArgs(['--pr']), /missing value/);
});

test('parseArgs: an unknown argument throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['1082']), /unknown argument/);
});

test('parseArgs: a non-positive / non-integer number throws a clear message', () => {
  assert.throws(() => parseArgs(['--pr', '0']), /invalid --pr value/);
  assert.throws(() => parseArgs(['--pr', '-5']), /invalid --pr value/);
  assert.throws(() => parseArgs(['--pr', '12abc']), /invalid --pr value/);
  assert.throws(
    () => parseArgs(['--claim-issue', '0']),
    /invalid --claim-issue value/,
  );
});

test('buildPreMergeReadinessSummary: claimless emits not-applicable ownership (#2017)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    claimless: true,
  });
  const claim = summary.claim as {
    reason: string;
    claimLost: boolean;
    expectedClaimId: string;
    activeClaimPresent: boolean;
    activeClaim: { claimId: string };
  };
  assert.equal(claim.reason, 'not-applicable');
  assert.equal(claim.claimLost, false);
  assert.equal(claim.expectedClaimId, 'none');
  assert.equal(claim.activeClaimPresent, false);
  assert.equal(claim.activeClaim.claimId, 'none');
  const blockers = summary.blockers as { gate: string }[];
  assert.equal(
    blockers.some((blocker) => blocker.gate === 'claim-ownership'),
    false,
  );
});

test('buildPreMergeReadinessSummary embeds a strict ready/blockers rollup', () => {
  // A clean fixture built WITHOUT dispositionEvidence fails closed on that
  // gate (it is absent), matching the executor's fail-closed behavior.
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, fixture.options);

  // `ready` is exactly `blockers.length === 0`, and `blockers` is the shared
  // rollup applied to the summary itself (single source of the merge-gate AND).
  const blockers = summary.blockers as { gate: string }[];
  assert.equal(summary.ready, blockers.length === 0);
  assert.deepEqual(summary.blockers, computePreMergeReadinessBlockers(summary));
  assert.deepEqual(
    blockers.map((blocker) => blocker.gate),
    ['disposition-evidence'],
  );

  // With every gate satisfied (including a proceed disposition), the collector
  // rolls up to ready:true / blockers:[].
  const ready = buildPreMergeReadinessSummary(
    { ...fixture.input },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const readyBlockers = ready.blockers as { gate: string }[];
  assert.deepEqual(ready.blockers, computePreMergeReadinessBlockers(ready));
  assert.equal(ready.ready, readyBlockers.length === 0);
});

// #1570: a caller-supplied terminal-unavailability verdict (computed
// upstream from buildCopilotRecoverySummary, advisory-wait-state.mts, since
// this file cannot import it without an import cycle) must add a dedicated
// `copilot-terminal-unavailable` blocker -- distinct from, and additive to,
// the existing `advisory-wait` gate above -- unless a valid maintainer
// external-check waiver for the `idd-advisory-convergence` selector exists
// on current HEAD, bound to the expected claim.
function advisoryWaitOf(summary: unknown): {
  copilotUnavailable: boolean;
  copilotUnavailableWaived: boolean;
} {
  return (summary as { advisoryWait: Record<string, unknown> })
    .advisoryWait as {
    copilotUnavailable: boolean;
    copilotUnavailableWaived: boolean;
  };
}

test('#1570: buildPreMergeReadinessSummary blocks on copilot-terminal-unavailable, and a valid maintainer waiver for idd-advisory-convergence clears it', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const blocked = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    copilotUnavailable: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
  });
  assert.equal(advisoryWaitOf(blocked).copilotUnavailable, true);
  assert.equal(advisoryWaitOf(blocked).copilotUnavailableWaived, false);
  const blockedGates = (blocked.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(blockedGates.includes('copilot-terminal-unavailable'));
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));

  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason:
      'Copilot review API confirmed unavailable; recovery cycles exhausted',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });
  const waived = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      comments: [
        ...fixture.input.comments,
        {
          id: 'terminal-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      copilotUnavailable: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
    },
  );
  assert.equal(advisoryWaitOf(waived).copilotUnavailable, true);
  assert.equal(advisoryWaitOf(waived).copilotUnavailableWaived, true);
  const waivedGates = (waived.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!waivedGates.includes('copilot-terminal-unavailable'));
  assert.deepEqual(waived.blockers, computePreMergeReadinessBlockers(waived));

  // Backward compatible: omitting copilotUnavailable entirely never adds
  // the blocker (unmigrated callers see unchanged behavior).
  const unmigrated = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  assert.equal(advisoryWaitOf(unmigrated).copilotUnavailable, false);
  assert.equal(advisoryWaitOf(unmigrated).copilotUnavailableWaived, false);
  assert.ok(
    !(unmigrated.blockers as { gate: string }[])
      .map((blocker) => blocker.gate)
      .includes('copilot-terminal-unavailable'),
  );
});

// #2021: a posted, otherwise-valid `idd-advisory-convergence` waiver must
// only make the REQUIRED CHECK itself `coveredByWaiver` once the SAME
// deadline/terminal precondition `advisory-convergence.mts`'s own gate
// enforces has also opened -- a 24h deadline anchored on the current HEAD
// commit's own committedDate, or proven terminal Copilot unavailability.
// Before this fix, `pre-merge-readiness.mjs` reported `coveredByWaiver: true`
// (and therefore `ready: true`) the moment a valid waiver marker existed,
// regardless of whether either precondition had opened -- sending a session
// into a `gh pr merge` GitHub rejects outright (root cause of #2021).
function ciCheckByName(
  summary: unknown,
  name: string,
): Record<string, unknown> | undefined {
  const checks = (summary as { ci: { checks: Record<string, unknown>[] } }).ci
    .checks;
  return checks.find((check) => check.name === name);
}

// Typed from `buildPreMergeReadinessSummary`'s own first-parameter shape
// (not `Record<string, unknown>`, which carries no NAMED properties and
// would make a later `{ ...input, comments: [...] }` spread silently drop
// required fields like `prHeadSha` from the inferred type) so this helper
// stays real-input-shape-checked without reaching for `any`.
type PreMergeReadinessInput = Parameters<
  typeof buildPreMergeReadinessSummary
>[0];

function withAdvisoryConvergenceRequiredCheck(fixture: {
  input: PreMergeReadinessInput;
}): PreMergeReadinessInput {
  const branchRules = (fixture.input.branchRules ?? []).map((rule) =>
    rule.type === 'required_status_checks'
      ? {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'lint' },
              { context: 'idd-advisory-convergence' },
            ],
          },
        }
      : rule,
  );
  const checks = [
    ...(fixture.input.checks ?? []),
    {
      name: 'idd-advisory-convergence',
      state: 'FAILURE',
      // #2034: after every waiver `createdAt` (`2026-05-12T00:00:00Z`) this
      // helper's callers post, so the rerun-freshness gate does not withhold
      // coverage in the "should be covered" cases below -- those tests cover
      // #2021's precondition and #2046's mode gating specifically, not #2034.
      // `startedAt` is also after that same moment (Codex review round 4 on
      // PR #2370: the #2353 `treatAsCoveredByWaiver` cutoff anchors on
      // `startedAt`, not `completedAt`).
      startedAt: '2026-05-12T00:15:00Z',
      completedAt: '2026-05-12T00:30:00Z',
    },
  ];
  return { ...fixture.input, branchRules, checks };
}

test('#2021: idd-advisory-convergence waiver posted but precondition window not yet open leaves the check blocked', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const blocked = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'deadline-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // HEAD committed 1h before `now` (2026-05-12T00:00:00Z): only 60
      // elapsed minutes against the 1440-minute (24h) default deadline, so
      // the deadline has not passed. copilotUnavailable is omitted (false),
      // so terminal unavailability is not proven either -- neither
      // precondition is open.
      advisoryConvergenceHeadCommittedAt: '2026-05-11T23:00:00Z',
    },
  );

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.deadlineMinutes, 1440);
  assert.equal(precondition.elapsedMinutes, 60);
  assert.equal(precondition.deadlinePassed, false);
  assert.equal(precondition.terminalUnavailable, false);
  assert.equal(precondition.open, false);

  // The raw waiver evidence still reports the marker as valid (it is a real,
  // otherwise-valid waiver) -- only ci.coveredByWaiver is withheld.
  const waiverEvidence = (blocked.waiverEvidence as { valid: unknown[] }).valid;
  assert.equal(waiverEvidence.length, 1);

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.equal(
    (blocked.ci as Record<string, unknown>).requiredChecksPassing,
    false,
  );
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
  const ciBlocker = (
    blocked.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.ok(ciBlocker, 'expected a ci blocker');
  assert.match(
    ciBlocker?.detail ?? '',
    /not yet covering "idd-advisory-convergence"/,
  );
  assert.match(
    ciBlocker?.detail ?? '',
    /deadline\/terminal precondition has not opened/,
  );
  assert.match(ciBlocker?.detail ?? '', /remainingMinutes=1380/);
});

// #2021: the precondition gate must also close a GLOB-selector waiver that
// would otherwise cover the check by name (e.g. `idd-*`), not just a
// literal `idd-advisory-convergence` selector -- `summarizeRequiredChecks`'s
// own `coveredByWaiver` matches via `matchCheckSelectorLocal` (glob-aware),
// so a strict `===` precondition filter would let a glob waiver slip
// through uncontrolled while `advisory-convergence.mts`'s own exact-match
// gate would never count it, reproducing the exact false-`ready` class
// this issue exists to close.
test('#2021: a glob-selector waiver (e.g. idd-*) is also withheld from coveredByWaiver while the precondition is closed', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [{ selector: 'idd-*', matchMode: 'glob' }];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-*',
    reason: 'blanket idd-* waiver posted by mistake',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const blocked = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'glob-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // Precondition closed: deadline not passed, terminal not proven.
      advisoryConvergenceHeadCommittedAt: '2026-05-11T23:00:00Z',
    },
  );

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.open, false);

  // The raw waiver evidence still reports the glob marker as valid.
  const waiverEvidence = (blocked.waiverEvidence as { valid: unknown[] }).valid;
  assert.equal(waiverEvidence.length, 1);

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(
    check?.coveredByWaiver,
    undefined,
    'a glob waiver must not cover the check while the precondition is closed',
  );
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
});

// #2021 (Codex review finding 1 on PR #2033): a glob-selector waiver must
// stay withheld from `coveredByWaiver` even AFTER the deadline/terminal
// precondition opens -- `advisory-convergence.mts`'s own `waived`
// computation only counts an EXACT selector match
// (`entry.checkSelector === waiverCheckSelector`), never a glob, so a
// glob-only waiver never converges that gate no matter how long the
// deadline waits. Distinct from the sibling test above, which covers the
// precondition-CLOSED case for the same glob selector.
test('#2021: a glob-selector waiver (e.g. idd-*) still does not cover coveredByWaiver once the precondition opens (only an exact selector match does)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [{ selector: 'idd-*', matchMode: 'glob' }];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-*',
    reason: 'blanket idd-* waiver posted by mistake',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const blocked = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'glob-waiver-open',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // Precondition OPEN this time: deadline has passed.
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(
    precondition.open,
    true,
    'sanity check: the precondition is open',
  );

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(
    check?.coveredByWaiver,
    undefined,
    'a glob-only waiver must never cover this check, even once the precondition opens',
  );
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
  const ciBlocker = (
    blocked.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.match(
    ciBlocker?.detail ?? '',
    /no posted waiver has a selector that EXACTLY equals/,
  );
});

// #2021 (Codex review finding 2 on PR #2033): withholding coveredByWaiver
// for idd-advisory-convergence must not strip the SAME glob waiver's
// coverage of a completely unrelated check it also names -- the exclusion
// must be surgical, per check name, not a removal of the whole waiver
// entry.
test('#2021: withholding coverage from idd-advisory-convergence does not remove the same glob waiver from an unrelated check', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (
    fixture.input.branchRules as Record<string, unknown>[]
  ).map((rule) =>
    rule.type === 'required_status_checks'
      ? {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'lint' },
              { context: 'idd-advisory-convergence' },
              { context: 'idd-security' },
            ],
          },
        }
      : rule,
  );
  const checks = [
    ...(fixture.input.checks as Record<string, unknown>[]),
    {
      name: 'idd-advisory-convergence',
      state: 'FAILURE',
      // #2034: after the glob waiver's own `createdAt` (`2026-05-12T00:00:00Z`
      // below) so the unrelated idd-security assertion below is not entangled
      // with the rerun-freshness gate this issue adds -- idd-advisory-convergence
      // itself still stays uncovered here regardless, via the precondition-closed
      // exclusion this test targets.
      completedAt: '2026-05-12T00:30:00Z',
    },
    {
      name: 'idd-security',
      state: 'FAILURE',
      completedAt: '2026-05-12T00:30:00Z',
    },
  ];
  const waivableCheckSelectors = [{ selector: 'idd-*', matchMode: 'glob' }];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-*',
    reason: 'blanket idd-* waiver covering multiple checks',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const summary = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      branchRules,
      checks,
      comments: [
        ...fixture.input.comments,
        {
          id: 'glob-waiver-multi',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // Precondition closed -- idd-advisory-convergence must stay
      // uncovered, but idd-security must still be covered by the same
      // glob waiver entry.
      advisoryConvergenceHeadCommittedAt: '2026-05-11T23:00:00Z',
    },
  );

  const convergenceCheck = ciCheckByName(summary, 'idd-advisory-convergence');
  assert.equal(
    convergenceCheck?.coveredByWaiver,
    undefined,
    'idd-advisory-convergence stays uncovered while its precondition is closed',
  );
  const securityCheck = ciCheckByName(summary, 'idd-security');
  assert.equal(
    securityCheck?.coveredByWaiver,
    true,
    'an unrelated check matched by the same glob waiver must remain covered',
  );
});

test('#2021: idd-advisory-convergence waiver posted and the 24h deadline has passed is covered (unchanged coveredByWaiver behavior)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const waived = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'deadline-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // HEAD committed 25h before `now`: 1500 elapsed minutes >= the
      // 1440-minute default deadline -- the deadline HAS passed.
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const precondition = (
    waived as { advisoryConvergenceWaiverPrecondition: Record<string, unknown> }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.elapsedMinutes, 1500);
  assert.equal(precondition.deadlinePassed, true);
  assert.equal(precondition.terminalUnavailable, false);
  assert.equal(precondition.open, true);

  const check = ciCheckByName(waived, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((waived.ci as Record<string, unknown>).status, 'success');
  assert.equal(
    (waived.ci as Record<string, unknown>).requiredChecksPassing,
    true,
  );
  const waivedGates = (waived.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!waivedGates.includes('ci'));
  assert.deepEqual(waived.blockers, computePreMergeReadinessBlockers(waived));
});

test('#2021: idd-advisory-convergence waiver posted and terminal Copilot unavailability is proven is covered even before the deadline passes', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason:
      'Copilot review API confirmed unavailable; recovery cycles exhausted',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const waived = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'terminal-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      // The deadline has NOT passed (same 1h-before-now HEAD as the
      // still-blocked case above) -- only the terminal precondition is met.
      advisoryConvergenceHeadCommittedAt: '2026-05-11T23:00:00Z',
      copilotUnavailable: true,
    },
  );

  const precondition = (
    waived as { advisoryConvergenceWaiverPrecondition: Record<string, unknown> }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.deadlinePassed, false);
  assert.equal(precondition.terminalUnavailable, true);
  assert.equal(precondition.open, true);

  const check = ciCheckByName(waived, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((waived.ci as Record<string, unknown>).status, 'success');
  const waivedGates = (waived.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!waivedGates.includes('ci'));
  // The dedicated copilot-terminal-unavailable blocker is also cleared by
  // the same waiver (#1570's pre-existing behavior, unaffected by #2021).
  assert.ok(!waivedGates.includes('copilot-terminal-unavailable'));
  assert.deepEqual(waived.blockers, computePreMergeReadinessBlockers(waived));
});

// #2353: a repository-scoped provider-outage declaration relieves the
// idd-advisory-convergence required check and the dedicated
// copilot-terminal-unavailable blocker the SAME way a direct maintainer
// waiver does (#2021/#1570 above), but via the caller-precomputed
// `advisoryConvergenceOutageRelieved` boolean instead of a posted waiver
// comment -- no `idd-external-check-waiver:` marker exists in either
// fixture below. Mirrors AC2: F2's blocker/disposition evidence must
// reflect the same declaration-based relief the CI check's own verdict
// (advisory-convergence.mts) reports for the same HEAD.
test('#2353: an active provider-outage declaration covers idd-advisory-convergence with no waiver marker posted (AC1/AC2)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const relieved = buildPreMergeReadinessSummary(input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
    copilotUnavailable: true,
    advisoryConvergenceOutageRelieved: true,
  });

  const precondition = (
    relieved as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.terminalUnavailable, true);
  assert.equal(precondition.open, true);

  const check = ciCheckByName(relieved, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((relieved.ci as Record<string, unknown>).status, 'success');
  assert.equal(advisoryWaitOf(relieved).copilotUnavailableWaived, true);
  const relievedGates = (relieved.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!relievedGates.includes('ci'));
  assert.ok(!relievedGates.includes('copilot-terminal-unavailable'));
  assert.deepEqual(
    relieved.blockers,
    computePreMergeReadinessBlockers(relieved),
  );
});

test('#2353: advisoryConvergenceOutageRelieved is re-gated on the precondition being open (AC4 -- cheap insurance against a caller passing relief without proof)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const blocked = buildPreMergeReadinessSummary(input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
    // Neither opener is proven: copilotUnavailable is false and the
    // fixture's own headCommittedAt keeps the ordinary deadline open.
    copilotUnavailable: false,
    advisoryConvergenceOutageRelieved: true,
  });

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.open, false);

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.equal(advisoryWaitOf(blocked).copilotUnavailableWaived, false);
});

// Codex review (PR #2370, follow-up finding): the required check's live
// run must have completed AT OR AFTER the declaration's own `startedAt`
// -- a stale run that failed BEFORE the declaration's window opened was
// never actually rerun under the outage, and reporting it covered would
// diverge from GitHub's own required-check state (the same #2021 "ready
// but merge blocked" class one layer deeper).
test('#2353: advisoryConvergenceOutageRelievedSince withholds coverage from a stale pre-declaration run', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  // withAdvisoryConvergenceRequiredCheck's injected check completes at
  // 2026-05-12T00:30:00Z -- anchor the declaration's own window AFTER
  // that moment, so the run predates it.
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const stillBlocked = buildPreMergeReadinessSummary(input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
    copilotUnavailable: true,
    advisoryConvergenceOutageRelieved: true,
    advisoryConvergenceOutageRelievedSince: '2026-05-13T00:00:00Z',
  });

  const check = ciCheckByName(stillBlocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.notEqual(
    (stillBlocked.ci as Record<string, unknown>).status,
    'success',
  );
});

test('#2353: advisoryConvergenceOutageRelievedSince covers a run that completed after the declaration opened', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const relieved = buildPreMergeReadinessSummary(input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
    copilotUnavailable: true,
    advisoryConvergenceOutageRelieved: true,
    advisoryConvergenceOutageRelievedSince: '2026-05-12T00:00:00Z',
  });

  const check = ciCheckByName(relieved, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((relieved.ci as Record<string, unknown>).status, 'success');
});

// Codex review (PR #2370, second follow-up, round 4): a run that STARTED
// before the declaration's window opened but happened to COMPLETE after it
// must still be withheld -- it never observed the declaration during its
// own evaluation, even though `completedAt` alone would suggest freshness.
test('#2353: advisoryConvergenceOutageRelievedSince withholds coverage from a run that started before the declaration but completed after it', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (fixture.input.branchRules ?? []).map(
    (rule: { type?: string }) =>
      rule.type === 'required_status_checks'
        ? {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [
                { context: 'lint' },
                { context: 'idd-advisory-convergence' },
              ],
            },
          }
        : rule,
  );
  const input = {
    ...fixture.input,
    branchRules,
    checks: [
      ...(fixture.input.checks ?? []),
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        // Started before the declaration's window opens below
        // (2026-05-12T00:00:00Z) but finishes after it.
        startedAt: '2026-05-11T23:58:00Z',
        completedAt: '2026-05-12T00:05:00Z',
      },
    ],
  };
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];

  const stillBlocked = buildPreMergeReadinessSummary(input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    waivableCheckSelectors,
    externalCheckWaiverMaxValidity: 'PT24H',
    copilotUnavailable: true,
    advisoryConvergenceOutageRelieved: true,
    advisoryConvergenceOutageRelievedSince: '2026-05-12T00:00:00Z',
  });

  const check = ciCheckByName(stillBlocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.notEqual(
    (stillBlocked.ci as Record<string, unknown>).status,
    'success',
  );
});

// #2046: a waiver that is otherwise valid, precondition-open, and
// configured-waivable must still never cover a check while
// ciGate.externalCheckWaivers.mode is not maintainer-authorized (schema
// default: disabled) -- mirroring advisory-convergence.mts's own mode
// guard. Before this fix, pre-merge-readiness.mjs never read `mode` at
// all, so a `waivable` list left over from a prior maintainer-authorized
// configuration (or copy-pasted from another repository's config without
// also copying `mode`) would report coveredByWaiver: true /
// advisoryConvergenceGenuinelyCovered: true for such a waiver, while
// advisory-convergence.mts's own required check would never honor it.
test('#2046: idd-advisory-convergence waiver posted with the deadline passed but mode not maintainer-authorized leaves the check blocked', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const blocked = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'mode-disabled-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      externalCheckWaiverMode: 'disabled',
      // HEAD committed 25h before `now`: the 24h deadline has already
      // passed, so the precondition is open -- isolating that mode
      // gating, not the precondition, is what withholds coverage here.
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.deadlinePassed, true);
  assert.equal(precondition.open, true);

  // The raw waiver evidence reports the marker as modeDisabled, not valid.
  const waiverEvidence = blocked.waiverEvidence as {
    valid: unknown[];
    modeDisabled: unknown[];
  };
  assert.equal(waiverEvidence.valid.length, 0);
  assert.equal(waiverEvidence.modeDisabled.length, 1);

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
});

// #2046: the same precondition-open waiver, with mode correctly set to
// maintainer-authorized, still covers the check -- confirming the mode
// gate does not regress the intended-working configuration.
test('#2046: idd-advisory-convergence waiver posted with the deadline passed and mode maintainer-authorized still covers the check', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const covered = buildPreMergeReadinessSummary(
    {
      ...input,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'mode-enabled-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      externalCheckWaiverMode: 'maintainer-authorized',
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const check = ciCheckByName(covered, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((covered.ci as Record<string, unknown>).status, 'success');
  const coveredGates = (covered.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!coveredGates.includes('ci'));
});

// #2034: a valid, precondition-satisfied, mode-enabled waiver still never
// covers a check whose own live run last completed BEFORE the waiver became
// genuinely active -- the check was never actually re-run since, so
// reporting it covered would diverge from what the real required check (and
// GitHub's branch protection) still shows.
test('#2034: idd-advisory-convergence waiver posted, precondition open, but the check last completed before the waiver took effect stays blocked, evidence names the stale run', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const staleChecks = (input.checks ?? []).map((check) =>
    check.name === 'idd-advisory-convergence'
      ? { ...check, completedAt: '2026-05-11T23:30:00Z' }
      : check,
  );
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const blocked = buildPreMergeReadinessSummary(
    {
      ...input,
      checks: staleChecks,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'stale-run-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      externalCheckWaiverMode: 'maintainer-authorized',
      // Deadline opens at 2026-05-11T23:00:00Z (24h after HEAD committed);
      // the check's own live run last completed before both that moment
      // AND the waiver's own createdAt (2026-05-12T00:00:00Z).
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const precondition = (
    blocked as {
      advisoryConvergenceWaiverPrecondition: Record<string, unknown>;
    }
  ).advisoryConvergenceWaiverPrecondition;
  assert.equal(precondition.open, true);

  const waiverEvidence = blocked.waiverEvidence as {
    valid: Record<string, unknown>[];
  };
  assert.equal(waiverEvidence.valid.length, 1);
  assert.equal(
    waiverEvidence.valid[0].checkSelector,
    'idd-advisory-convergence',
  );

  const check = ciCheckByName(blocked, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, undefined);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
  const ciBlocker = (
    blocked.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.ok(ciBlocker, 'expected a ci blocker');
  assert.match(
    ciBlocker?.detail ?? '',
    /its live run last completed at "2026-05-11T23:30:00Z"/,
  );
});

// #2034: the same waiver covers the check once its live run completes AFTER
// the waiver became genuinely active -- confirming the freshness gate does
// not regress the intended-working, actually-rerun case.
test('#2034: the same idd-advisory-convergence waiver is covered once the check completes a fresh run after the waiver took effect', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const input = withAdvisoryConvergenceRequiredCheck(fixture);
  const freshChecks = (input.checks ?? []).map((check) =>
    check.name === 'idd-advisory-convergence'
      ? { ...check, completedAt: '2026-05-12T00:15:00Z' }
      : check,
  );
  const waivableCheckSelectors = [
    { selector: 'idd-advisory-convergence', matchMode: 'exact' },
  ];
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: fixture.options.expectedAgentId,
    claimId: fixture.options.expectedClaimId,
    headSha: fixture.input.prHeadSha,
    checkSelector: 'idd-advisory-convergence',
    reason: 'idd-advisory-convergence would not converge across 3 rounds',
    expiresAt: '2026-05-13T00:00:00Z',
    actor: 'kurone-kito',
  });

  const covered = buildPreMergeReadinessSummary(
    {
      ...input,
      checks: freshChecks,
      comments: [
        ...(input.comments ?? []),
        {
          id: 'fresh-run-waiver',
          author: { login: 'kurone-kito' },
          body: waiverBody,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity: 'PT24H',
      externalCheckWaiverMode: 'maintainer-authorized',
      advisoryConvergenceHeadCommittedAt: '2026-05-10T23:00:00Z',
    },
  );

  const check = ciCheckByName(covered, 'idd-advisory-convergence');
  assert.equal(check?.coveredByWaiver, true);
  assert.equal((covered.ci as Record<string, unknown>).status, 'success');
  const coveredGates = (covered.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(!coveredGates.includes('ci'));
});

// #1377: a masked-403-as-404 on the branch-protection or ruleset reads must
// block the ci gate with a specific, actionable detail instead of silently
// falling through to noRequiredChecksConfigured, even in the exact "all
// present runs are green and no required-check rule was found" shape that
// would otherwise vacuously pass (isPreMergeCiAllPassing's
// noRequiredChecksConfigured && presentRunConclusion === 'all-passing'
// branch).
test('buildPreMergeReadinessSummary blocks on the ci gate with a specific detail when protection reads are unreadable', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  // Drop the `required_status_checks` rule so the (fallback-empty) reads
  // alone would otherwise report noRequiredChecksConfigured: true, matching
  // the "unprotected repo" shape this vulnerability is indistinguishable
  // from at the response level.
  const branchRules = (fixture.input.branchRules as { type: string }[]).filter(
    (rule) => rule.type !== 'required_status_checks',
  );

  const withoutOverride = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  assert.equal(
    (withoutOverride.ci as Record<string, unknown>).noRequiredChecksConfigured,
    true,
    'sanity check: dropping the rule alone reproduces the vacuous-pass shape',
  );
  assert.equal(withoutOverride.ready, true);

  const unreadable = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules, protectionReadsUnreadable: true },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  assert.equal(
    (unreadable.ci as Record<string, unknown>).noRequiredChecksConfigured,
    false,
  );
  assert.equal(
    (unreadable.ci as Record<string, unknown>).protectionReadsUnreadable,
    true,
  );
  assert.deepEqual(
    unreadable.blockers,
    computePreMergeReadinessBlockers(unreadable),
  );
  const ciBlocker = (
    unreadable.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.equal(
    ciBlocker?.detail,
    'cannot determine required checks: protection/ruleset unreadable',
  );
  assert.equal(unreadable.ready, false);
});

// #1689: a required check whose ruleset entry carries an `app_id` (source-
// pinned) must block the ci gate with a detail naming that specific cause
// -- not the generic "CI is not all-passing" message -- and the
// `ciGate.trustSourcePinnedRequiredChecks` opt-in must clear it once the
// operator has verified the pinned integration out-of-band.
test('buildPreMergeReadinessSummary blocks on the ci gate with a specific detail when a required check is source-pinned, and the opt-in clears it', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (
    fixture.input.branchRules as Record<string, unknown>[]
  ).map((rule) =>
    rule.type === 'required_status_checks'
      ? {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'lint', app_id: 1 }],
          },
        }
      : rule,
  );

  const pinned = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  assert.equal((pinned.ci as Record<string, unknown>).status, 'unknown');
  assert.deepEqual(
    (pinned.ci as Record<string, unknown>).sourcePinnedRequiredCheckNames,
    ['lint'],
  );
  assert.deepEqual(pinned.blockers, computePreMergeReadinessBlockers(pinned));
  const ciBlocker = (
    pinned.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.equal(
    ciBlocker?.detail,
    'required check lint is source-pinned; producer verification unavailable (set ciGate.trustSourcePinnedRequiredChecks to opt in once the pinned integration is verified)',
  );
  assert.equal(pinned.ready, false);

  const trusted = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      trustSourcePinnedRequiredChecks: true,
    },
  );
  assert.equal((trusted.ci as Record<string, unknown>).status, 'success');
  assert.deepEqual(
    (trusted.ci as Record<string, unknown>).sourcePinnedRequiredCheckNames,
    [],
  );
  assert.deepEqual(trusted.blockers, computePreMergeReadinessBlockers(trusted));
  assert.equal(trusted.ready, true);
});

// #1689: an unresolvable pinned source (a ruleset `workflows` rule with no
// enumerable check name) coexisting with a separate, named-and-unpinned
// required check must still name the source-pinned cause in the ci blocker
// detail -- not fall through to the generic "CI is not all-passing"
// message -- and the opt-in must not clear it (there is no check name to
// correlate the pinning with a live run).
test('buildPreMergeReadinessSummary blocks on the ci gate with a specific detail for an unresolvable mixed source-pinned requirement, and the opt-in does not clear it', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = [
    ...(fixture.input.branchRules as Record<string, unknown>[]),
    {
      type: 'workflows',
      parameters: {
        workflows: [{ repository_id: 1, path: '.github/workflows/ci.yml' }],
      },
    },
  ];

  const pinned = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  assert.equal((pinned.ci as Record<string, unknown>).status, 'unknown');
  assert.deepEqual(
    (pinned.ci as Record<string, unknown>).sourcePinnedRequiredCheckNames,
    [],
  );
  assert.equal(
    (pinned.ci as Record<string, unknown>).sourcePinnedUnresolved,
    true,
  );
  assert.deepEqual(pinned.blockers, computePreMergeReadinessBlockers(pinned));
  const ciBlocker = (
    pinned.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'ci');
  assert.equal(
    ciBlocker?.detail,
    'an unresolvable source-pinned required-check requirement is in force (e.g. a ruleset `workflows` rule); producer verification unavailable, and this cause is never covered by the ciGate.trustSourcePinnedRequiredChecks opt-in',
  );
  assert.equal(pinned.ready, false);

  const trusted = buildPreMergeReadinessSummary(
    { ...fixture.input, branchRules },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      trustSourcePinnedRequiredChecks: true,
    },
  );
  assert.equal((trusted.ci as Record<string, unknown>).status, 'unknown');
  assert.equal(
    (trusted.ci as Record<string, unknown>).sourcePinnedUnresolved,
    true,
  );
  assert.deepEqual(trusted.blockers, computePreMergeReadinessBlockers(trusted));
  assert.equal(trusted.ready, false);
});

// #1380: a masked-403-as-404 on a codeowner-requiring ruleset's *detail*
// read must block the required-reviews gate with a specific, actionable
// detail (mirroring #1377's ci-gate detail above) instead of the generic
// status dump, when that unreadable ruleset is why the gate cannot resolve.
test('buildPreMergeReadinessSummary blocks on the required-reviews gate with a specific detail when the ruleset bypass detail is unreadable', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  // The PR author is the sole codeowner (no non-author eligible codeowner,
  // no actual codeowner approval yet, and the aggregate reviewDecision is
  // not APPROVED), and the one codeowner-requiring rule references a
  // ruleset whose detail read was masked-404 and dropped.
  const branchRules = (
    fixture.input.branchRules as Record<string, unknown>[]
  ).map((rule) =>
    rule.type === 'pull_request' ? { ...rule, ruleset_id: 1 } : rule,
  );
  const baseInput = {
    ...fixture.input,
    branchRules,
    branchRulesets: [],
    reviewDecision: '',
    codeownersText: '* @contributor\n',
    reviews: [],
  };

  const withoutOverride = buildPreMergeReadinessSummary(baseInput, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  const reviewerStatesWithout = withoutOverride.reviewerStates as Record<
    string,
    unknown
  >;
  const selfApprovalWithout =
    reviewerStatesWithout.codeownerSelfApproval as Record<string, unknown>;
  assert.equal(selfApprovalWithout.status, 'deadlock');
  assert.equal(selfApprovalWithout.rulesetBypassUnreadable, false);

  const unreadable = buildPreMergeReadinessSummary(
    { ...baseInput, branchRulesetsUnreadable: true },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const reviewerStates = unreadable.reviewerStates as Record<string, unknown>;
  const selfApproval = reviewerStates.codeownerSelfApproval as Record<
    string,
    unknown
  >;
  assert.equal(selfApproval.status, 'possible_deadlock');
  assert.equal(selfApproval.rulesetBypassUnreadable, true);
  assert.deepEqual(
    unreadable.blockers,
    computePreMergeReadinessBlockers(unreadable),
  );
  const reviewBlocker = (
    unreadable.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'required-reviews');
  assert.equal(
    reviewBlocker?.detail,
    'cannot determine CODEOWNER ruleset bypass: ruleset detail unreadable',
  );
  assert.equal(unreadable.ready, false);
});

// #1380: `rulesetBypassUnreadable` lives on `base` in
// `summarizeCodeownerSelfApproval` and is therefore present on *every*
// returned branch, not just the one that names it as the reason. When some
// other escape path resolves first (here: an ambiguous team-only CODEOWNERS
// entry, unrelated to ruleset bypass), the required-reviews blocker detail
// must report the *actual* blocking cause instead of the unreadable-ruleset
// message, even though the ruleset detail genuinely was unreadable too.
test('buildPreMergeReadinessSummary reports the real blocking cause, not the unreadable-ruleset message, when a different codeowner escape path resolves first', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (
    fixture.input.branchRules as Record<string, unknown>[]
  ).map((rule) =>
    rule.type === 'pull_request' ? { ...rule, ruleset_id: 1 } : rule,
  );
  const unreadable = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      branchRules,
      branchRulesets: [],
      branchRulesetsUnreadable: true,
      reviewDecision: '',
      // Team-only CODEOWNERS entry: no direct codeowner user at all, so the
      // team-ambiguous escape path resolves before the sole-direct-codeowner
      // (ruleset-bypass-unreadable) branch is ever reached.
      codeownersText: '* @org/team\n',
      reviews: [],
    },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const reviewerStates = unreadable.reviewerStates as Record<string, unknown>;
  const selfApproval = reviewerStates.codeownerSelfApproval as Record<
    string,
    unknown
  >;
  assert.equal(selfApproval.status, 'possible_deadlock');
  assert.equal(selfApproval.reason, 'team-codeowner-ambiguous');
  // The underlying fetch genuinely was unreadable -- this field must still
  // reflect that -- but it must not drive the blocker message below.
  assert.equal(selfApproval.rulesetBypassUnreadable, true);
  assert.deepEqual(
    unreadable.blockers,
    computePreMergeReadinessBlockers(unreadable),
  );
  const reviewBlocker = (
    unreadable.blockers as { gate: string; detail: string }[]
  ).find((blocker) => blocker.gate === 'required-reviews');
  assert.match(
    reviewBlocker?.detail ?? '',
    /codeownerSelfApproval\.status="possible_deadlock"/,
  );
  assert.doesNotMatch(reviewBlocker?.detail ?? '', /ruleset detail unreadable/);
});

// #1513: branch-currency (up-to-date-head) evidence and gate.
test('summarizeBranchCurrency: a ruleset strict_required_status_checks_policy resolves requiresUpToDateHead via "ruleset"', () => {
  const result = summarizeBranchCurrency(
    [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'lint' }],
        },
      },
    ],
    {},
    { mergeStateStatus: 'behind', mergeable: 'mergeable' },
  );
  assert.equal(result.requiresUpToDateHead, true);
  assert.equal(result.requiresUpToDateHeadSource, 'ruleset');
  // Raw GitHub enum values are normalized to uppercase.
  assert.equal(result.mergeStateStatus, 'BEHIND');
  assert.equal(result.mergeable, 'MERGEABLE');
});

// #1513 (Copilot/Codex review on PR #1538): GitHub's ruleset docs state
// strict_required_status_checks_policy "will not take effect unless at
// least one status check is enabled" -- an empty required-check list must
// not resolve requiresUpToDateHead via the ruleset path even when the
// strict flag itself is true, or a BEHIND PR under that empty-check
// ruleset would be falsely blocked when GitHub would actually allow it.
test('summarizeBranchCurrency: a ruleset strict flag with an EMPTY required-check list does not set requiresUpToDateHead', () => {
  const result = summarizeBranchCurrency(
    [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [],
        },
      },
    ],
    {},
    { protectionReadsUnreadable: false },
  );
  assert.equal(result.requiresUpToDateHead, false);
  assert.equal(result.requiresUpToDateHeadSource, 'none');
});

test('summarizeBranchCurrency: classic protection required_status_checks.strict resolves via "classic-protection"', () => {
  const result = summarizeBranchCurrency(
    [],
    { required_status_checks: { strict: true } },
    {},
  );
  assert.equal(result.requiresUpToDateHead, true);
  assert.equal(result.requiresUpToDateHeadSource, 'classic-protection');
});

test('summarizeBranchCurrency: a readable "no rule found" resolves requiresUpToDateHead to false, source "none"', () => {
  const result = summarizeBranchCurrency(
    [{ type: 'required_status_checks', parameters: {} }],
    { required_status_checks: {} },
    { protectionReadsUnreadable: false },
  );
  assert.equal(result.requiresUpToDateHead, false);
  assert.equal(result.requiresUpToDateHeadSource, 'none');
});

test('summarizeBranchCurrency: an unreadable protection/ruleset read fails closed to requiresUpToDateHead=true', () => {
  const result = summarizeBranchCurrency(
    [],
    {},
    {
      protectionReadsUnreadable: true,
    },
  );
  assert.equal(result.requiresUpToDateHead, true);
  assert.equal(result.requiresUpToDateHeadSource, 'unreadable-fail-closed');
});

test('summarizeBranchCurrency: a non-boolean strict-flag value is never coerced true (strict === true check)', () => {
  const result = summarizeBranchCurrency(
    [
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: 'true' },
      },
    ],
    { required_status_checks: { strict: 1 } },
    { protectionReadsUnreadable: false },
  );
  assert.equal(result.requiresUpToDateHead, false);
  assert.equal(result.requiresUpToDateHeadSource, 'none');
});

// End-to-end regression, confirmed-ruleset path: this repository's own live
// `main` (verified via `gh api repos/kurone-kito/idd-skill/rules/branches/main`)
// resolves via this exact branch -- a readable ruleset carrying
// `strict_required_status_checks_policy: true` -- not the unreadable-fail-closed
// path below. Covering both end to end (not just summarizeBranchCurrency in
// isolation) guards against a wiring slip where branchRules/mergeStateStatus
// never actually reach summarizeBranchCurrency inside buildPreMergeReadinessSummary.
test('buildPreMergeReadinessSummary: a confirmed ruleset requirement + live BEHIND blocks on branch-currency', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (
    fixture.input.branchRules as Record<string, unknown>[]
  ).map((rule) =>
    rule.type === 'required_status_checks'
      ? {
          ...rule,
          parameters: {
            ...(rule.parameters as Record<string, unknown>),
            strict_required_status_checks_policy: true,
          },
        }
      : rule,
  );
  const summary = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      branchRules,
      mergeStateStatus: 'BEHIND',
      mergeable: 'MERGEABLE',
    },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const branchCurrency = summary.branchCurrency as Record<string, unknown>;
  assert.equal(branchCurrency.requiresUpToDateHead, true);
  assert.equal(branchCurrency.requiresUpToDateHeadSource, 'ruleset');
  assert.deepEqual(summary.blockers, computePreMergeReadinessBlockers(summary));
  assert.deepEqual(
    (summary.blockers as { gate: string }[]).map((b) => b.gate),
    ['branch-currency'],
  );
  assert.equal(summary.ready, false);
});

// End-to-end regression, unreadable-fail-closed path: this is the exact
// field-evidence shape from the issue -- `mergeStateStatus: BEHIND`,
// `mergeable: MERGEABLE`, and a protection/ruleset read that could not be
// confirmed at all (not merely a rule that was read but found absent).
test('buildPreMergeReadinessSummary: BEHIND + unreadable protection/ruleset reads fails closed to a branch-currency blocker', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const branchRules = (fixture.input.branchRules as { type: string }[]).filter(
    (rule) => rule.type !== 'required_status_checks',
  );
  const summary = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      branchRules,
      protectionReadsUnreadable: true,
      mergeStateStatus: 'BEHIND',
      mergeable: 'MERGEABLE',
    },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const branchCurrency = summary.branchCurrency as Record<string, unknown>;
  assert.equal(branchCurrency.requiresUpToDateHead, true);
  assert.equal(
    branchCurrency.requiresUpToDateHeadSource,
    'unreadable-fail-closed',
  );
  assert.deepEqual(summary.blockers, computePreMergeReadinessBlockers(summary));
  const blockerGates = (summary.blockers as { gate: string }[]).map(
    (b) => b.gate,
  );
  assert.ok(blockerGates.includes('branch-currency'));
  assert.equal(summary.ready, false);
});

test('buildPreMergeReadinessSummary: BEHIND with no up-to-date-head requirement does not block on branch-currency', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      mergeStateStatus: 'BEHIND',
      mergeable: 'MERGEABLE',
    },
    { ...fixture.options, includeDispositionEvidence: true },
  );
  const branchCurrency = summary.branchCurrency as Record<string, unknown>;
  assert.equal(branchCurrency.requiresUpToDateHead, false);
  const blockerGates = (summary.blockers as { gate: string }[]).map(
    (b) => b.gate,
  );
  assert.ok(!blockerGates.includes('branch-currency'));
});

test('a trusted machine-disposition clears the notice/summary in both merge gates without promoting the author to a global IDD agent (#1182)', () => {
  const opts = {
    trustedMarkerLogins: ['kurone-kito'],
    advisoryBotLogins: ['coderabbitai[bot]'],
    prAuthorLogin: 'pr-author',
  };
  // Distinct, REAL advisory stickies — a CodeRabbit summary walkthrough and a
  // CodeRabbit rate-limit non-review notice — and their matching machine
  // dispositions.
  const summarySticky = (id: number, at = '2026-07-01T11:00:00Z') => ({
    id,
    createdAt: at,
    body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\n## Walkthrough',
    author: { login: 'coderabbitai[bot]' },
  });
  const noticeSticky = (id: number, at = '2026-07-01T11:00:00Z') => ({
    id,
    createdAt: at,
    body: '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->',
    author: { login: 'coderabbitai[bot]' },
  });
  const summaryDisp = (author: string, at = '2026-07-01T12:00:00Z') => ({
    id: 10,
    createdAt: at,
    body: '**Accepted** — coderabbitai[bot] summary walkthrough; no action required',
    author: { login: author },
  });
  const noticeDisp = (author: string, at = '2026-07-01T12:00:00Z') => ({
    id: 11,
    createdAt: at,
    body: '**Rejected** — coderabbitai[bot] did not review HEAD abc (rate limited); this is not a completed review',
    author: { login: author },
  });
  const human = (id: number, body: string, at: string) => ({
    id,
    createdAt: at,
    body,
    author: { login: 'some-human' },
  });
  const proceeds = (comments: unknown[]) =>
    summarizeDispositionEvidenceForGate(
      { comments: comments as never, threads: [] },
      opts,
    ).route === 'proceed';
  const unreplied = (comments: unknown[]) =>
    summarizeRegularCommentsForGate(comments as never, opts).count;

  // Core #1182: a trusted-marker actor's machine disposition — notice OR summary
  // — is honored per item in BOTH gates even without iddAgentLogins. Each is
  // matched to the sticky OF THE SAME TYPE.
  assert.equal(proceeds([summarySticky(1), summaryDisp('kurone-kito')]), true);
  assert.equal(unreplied([summarySticky(1), summaryDisp('kurone-kito')]), 0);
  assert.equal(proceeds([noticeSticky(1), noticeDisp('kurone-kito')]), true);
  assert.equal(unreplied([noticeSticky(1), noticeDisp('kurone-kito')]), 0);

  // Fail-open guard (the disposition never joins the generic pool): a trusted
  // disposition whose sticky is absent must NOT clear an unrelated human comment.
  const olderHuman = human(
    2,
    'Please fix this before merge.',
    '2026-07-01T10:00:00Z',
  );
  assert.equal(proceeds([olderHuman, summaryDisp('kurone-kito')]), false);
  assert.equal(proceeds([olderHuman, noticeDisp('kurone-kito')]), false);

  // Type-matched: a notice disposition must NOT clear a summary sticky, and a
  // summary disposition must NOT clear a notice sticky (the paths are disjoint).
  assert.equal(proceeds([summarySticky(1), noticeDisp('kurone-kito')]), false);
  assert.equal(unreplied([summarySticky(1), noticeDisp('kurone-kito')]), 1);
  assert.equal(proceeds([noticeSticky(1), summaryDisp('kurone-kito')]), false);

  // 1:1 consumption: two summary stickies and one disposition leave one blocking.
  const twoSummaries = [
    summarySticky(1, '2026-07-01T11:00:00Z'),
    summarySticky(2, '2026-07-01T11:30:00Z'),
    summaryDisp('kurone-kito'),
  ];
  assert.equal(proceeds(twoSummaries), false);
  assert.equal(unreplied(twoSummaries), 1);

  // #1122 stale-summary guard: a summary sticky EDITED after the disposition
  // (its `updatedAt` post-dates the `**Accepted**`) is not cleared by that stale
  // acceptance — a finding folded into the newer summary body must still block.
  const editedSummary = {
    id: 20,
    createdAt: '2026-07-01T11:00:00Z',
    updatedAt: '2026-07-01T13:00:00Z',
    body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\n## Walkthrough (revised)',
    author: { login: 'coderabbitai[bot]' },
  };
  const staleAccepted = [
    editedSummary,
    summaryDisp('kurone-kito', '2026-07-01T12:00:00Z'),
  ];
  assert.equal(proceeds(staleAccepted), false);
  assert.equal(unreplied(staleAccepted), 1);
  // A non-review notice, by contrast, carries its disposition forward across a
  // later re-post (the #1018 carry-forward is intentionally time-agnostic).
  const repostedNotice = {
    id: 21,
    createdAt: '2026-07-01T11:00:00Z',
    updatedAt: '2026-07-01T13:00:00Z',
    body: '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->',
    author: { login: 'coderabbitai[bot]' },
  };
  assert.equal(
    proceeds([
      repostedNotice,
      noticeDisp('kurone-kito', '2026-07-01T12:00:00Z'),
    ]),
    true,
  );

  // A cleared sticky does not clear an unrelated still-unaddressed human comment.
  const summaryPlusHuman = [
    human(3, 'Rename this variable.', '2026-07-01T10:00:00Z'),
    summarySticky(1),
    summaryDisp('kurone-kito'),
  ];
  assert.equal(proceeds(summaryPlusHuman), false);
  assert.equal(
    summarizeDispositionEvidenceForGate(
      { comments: summaryPlusHuman as never, threads: [] },
      opts,
    ).blockingCount,
    1,
  );

  // Scoped, NOT a global identity: the disposition author is never promoted into
  // iddAgentLogins (deriveIddAgentLogins derives only operational-marker
  // authors), so the review-threads gate still treats that same actor's
  // unresolved feedback as actionable-blocking — a global promotion would fail
  // that merge gate open.
  assert.deepEqual(
    deriveIddAgentLogins({
      trustedMarkerLogins: ['kurone-kito'],
      operationalComments: [summaryDisp('kurone-kito')],
    }),
    [],
  );
  assert.ok(
    summarizeReviewThreadsForGate(
      [
        {
          id: 'T1',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: 'kurone-kito' },
                body: 'This logic is wrong; fix before merge.',
                createdAt: '2026-07-01T18:00:00Z',
              },
            ],
          },
        },
      ],
      { ...opts, iddAgentLogins: [] },
    ).actionableCount >= 1,
  );

  // Fail-closed: a NON-trusted author's machine disposition is not honored, and a
  // trusted actor's GENERAL `**Rejected**` review feedback is not a machine
  // disposition, so it stays a real comment in both gates.
  assert.equal(proceeds([summarySticky(1), summaryDisp('random-user')]), false);
  const general = [
    summarySticky(1),
    {
      id: 12,
      createdAt: '2026-07-01T12:00:00Z',
      body: '**Rejected** — I disagree with this',
      author: { login: 'kurone-kito' },
    },
  ];
  assert.equal(proceeds(general), false);
  assert.equal(unreplied(general), 2);
});

// #1191: classifyRegularBotComment → hasExplicitDispositionAfter must accept a
// disposition that names the advisory bot LOGIN (`coderabbitai[bot]`) — the
// canonical disposition-non-review-notices form — not only the `\bCodeRabbit\b`
// product word, which the login never matches (no boundary before the `ai`).
{
  const summarySticky = {
    id: 1,
    createdAt: '2026-07-01T00:00:00Z',
    body: `${CODERABBIT_SUMMARY_MARKER}\n\nSummary of changes.`,
    author: { login: 'coderabbitai[bot]' },
  };
  const laterDisposition = (body: string) => ({
    id: 2,
    createdAt: '2026-07-01T01:00:00Z',
    body,
    author: { login: 'kurone-kito' },
  });
  const classify = (dispositionBody: string) =>
    classifyRegularBotComment(
      summarySticky,
      [summarySticky, laterDisposition(dispositionBody)],
      [],
      { isDispositionAuthor: (login: string) => login === 'kurone-kito' },
    );

  test('#1191: a login-named disposition resolves a CodeRabbit summary sticky', () => {
    const result = classify(
      '**Accepted** — coderabbitai[bot] summary walkthrough confirmed; no action required.',
    );
    assert.equal(result?.classifier, 'RESOLVED');
  });

  test('#1191: the product-word disposition form still resolves the sticky', () => {
    const result = classify(
      "**Accepted** — CodeRabbit's summary reviewed; no action required.",
    );
    assert.equal(result?.classifier, 'RESOLVED');
  });

  test('#1191: a disposition naming neither login nor product word does not resolve (fail-closed)', () => {
    const result = classify('**Accepted** — reviewed; no action required.');
    assert.equal(result, null);
  });

  test('#1191: an IDD-scoped disposition author still excludes a reviewer-authored marker', () => {
    const result = classifyRegularBotComment(
      summarySticky,
      [
        summarySticky,
        {
          id: 3,
          createdAt: '2026-07-01T01:00:00Z',
          body: '**Accepted** — coderabbitai[bot] summary walkthrough looks fine.',
          author: { login: 'some-reviewer' },
        },
      ],
      [],
      { isDispositionAuthor: (login: string) => login === 'kurone-kito' },
    );
    assert.equal(result, null);
  });
}

// #1313: classifyRegularBotComment -> hasCompletedBotThreadDispositions ->
// hasFreshDisposition still requires a fresh disposition for a CodeRabbit
// thread finding that was edited in place after its disposition (updatedAt
// bumped past createdAt) -- the mechanical gate stays fail-closed (see the
// #1313 background comment above): it cannot tell a cosmetic edit from a
// substantive one, so it must not silently resolve the summary sticky. The
// advisory-only in-place-edit diagnostic (summarizeDispositionEvidenceForGate)
// is the intended place for an agent to recognize and verify this pattern,
// not this mechanical completion check.
test('#1313: a CodeRabbit summary sticky stays unresolved when its own thread finding was edited in place after disposition', () => {
  const summarySticky = {
    id: 1,
    createdAt: '2026-07-01T00:00:00Z',
    body: `${CODERABBIT_SUMMARY_MARKER}\n\nSummary of changes.`,
    author: { login: 'coderabbitai[bot]' },
  };

  const result = classifyRegularBotComment(
    summarySticky,
    [summarySticky],
    [
      {
        id: 'thread-1',
        isResolved: true,
        comments: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              author: { login: 'coderabbitai[bot]' },
              createdAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-07-01T02:00:00Z',
              body: '**Potential issue**: this needs a null check.',
            },
            {
              author: { login: 'kurone-kito' },
              createdAt: '2026-07-01T00:30:00Z',
              body: '**Rejected** — verified: not applicable here',
            },
          ],
        },
      },
    ],
    { isDispositionAuthor: (login: string) => login === 'kurone-kito' },
  );

  assert.equal(result, null);
});

// #2335: buildPreMergeReadinessSummary/computePreMergeReadinessBlockers --
// advisoryWait.secondaryQuietWindow.
function secondaryQuietWindowOf(summary: unknown): {
  minutes: number;
  anchorAt: string;
  elapsedMinutes: number | null;
  elapsed: boolean;
  remainingMinutes: number | null;
} {
  return (summary as { secondaryQuietWindow: Record<string, unknown> })
    .secondaryQuietWindow as {
    minutes: number;
    anchorAt: string;
    elapsedMinutes: number | null;
    elapsed: boolean;
    remainingMinutes: number | null;
  };
}

test('#2335: secondaryQuietWindowMinutes omitted/0 never adds a secondary-quiet-window blocker (default off, unchanged behavior)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const ready = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  assert.equal(secondaryQuietWindowOf(ready).elapsed, true);
  assert.deepEqual(ready.blockers, computePreMergeReadinessBlockers(ready));
  assert.ok(
    !(ready.blockers as { gate: string }[]).some(
      (blocker) => blocker.gate === 'secondary-quiet-window',
    ),
  );

  const explicitZero = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 0,
  });
  assert.deepEqual(explicitZero, ready);
});

test('#2335: a positive secondaryQuietWindowMinutes blocks when the window has not yet elapsed since the last substantive activity', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  // The clean fixture's own effective activity ceiling is 2026-05-11T23:56:00Z
  // and options.now is 2026-05-12T00:00:00Z -- 4 minutes elapsed.
  const blocked = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 10,
  });
  const status = secondaryQuietWindowOf(blocked);
  assert.equal(status.minutes, 10);
  assert.equal(status.elapsedMinutes, 4);
  assert.equal(status.remainingMinutes, 6);
  assert.equal(status.elapsed, false);
  assert.equal(blocked.ready, false);
  const gates = (blocked.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.deepEqual(gates, ['secondary-quiet-window']);
  assert.deepEqual(blocked.blockers, computePreMergeReadinessBlockers(blocked));
});

test('#2335: the same window elapsing with nothing new clears the blocker', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const cleared = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 2,
  });
  const status = secondaryQuietWindowOf(cleared);
  assert.equal(status.elapsedMinutes, 4);
  assert.equal(status.elapsed, true);
  assert.equal(status.remainingMinutes, 0);
  assert.ok(
    !(cleared.blockers as { gate: string }[]).some(
      (blocker) => blocker.gate === 'secondary-quiet-window',
    ),
  );
  assert.deepEqual(cleared.blockers, computePreMergeReadinessBlockers(cleared));
});

test('#2335: a genuinely unresolved thread keeps the anchor fresh, so the window never elapses while real work is pending', () => {
  const fixture = readJson(
    'fixtures/pre-merge-readiness/unresolved-thread.json',
  );
  const blocked = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 1440,
  });
  const status = secondaryQuietWindowOf(blocked);
  // The unresolved thread's own raw activity is the effective ceiling, same
  // value already asserted in the fixture's own expected.reviewCurrency.
  assert.equal(
    status.anchorAt,
    (
      fixture.expected.reviewCurrency.live.effective as {
        maxActivityUpdatedAt: string;
      }
    ).maxActivityUpdatedAt,
  );
  assert.equal(status.elapsed, false);
  const gates = (blocked.blockers as { gate: string }[]).map(
    (blocker) => blocker.gate,
  );
  assert.ok(gates.includes('secondary-quiet-window'));
});

test('#2335: a disposition reply, a watermark, and an ack-only bot comment never reopen the window (reuses the ack-only-current fixture)', () => {
  const fixture = readJson(
    'fixtures/pre-merge-readiness/ack-only-current.json',
  );
  const withWindow = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 2,
  });
  // ack-only-current's live.effective ceiling already excludes the
  // post-disposition bot ack (protocol-helpers.mts's ackOnlyPostDisposition
  // classification, exercised by the review-currency gate in the same
  // fixture); the window anchors on that same ceiling and therefore already
  // elapsed at options.now, exactly like the review-currency gate already
  // proceeds on this fixture.
  assert.equal(secondaryQuietWindowOf(withWindow).elapsed, true);
  assert.ok(
    !(withWindow.blockers as { gate: string }[]).some(
      (blocker) => blocker.gate === 'secondary-quiet-window',
    ),
  );
});

test('#2335: a disposition reply with nothing after it but an ack legitimately anchors the window (it is the moment convergence was reached, per the same ackOnlyPostDisposition classification the issue names)', () => {
  const fixture = readJson(
    'fixtures/pre-merge-readiness/disposition-reply-latest.json',
  );
  const status = secondaryQuietWindowOf(
    buildPreMergeReadinessSummary(fixture.input, {
      ...fixture.options,
      includeDispositionEvidence: true,
      secondaryQuietWindowMinutes: 2,
    }),
  );
  // The disposition reply (23:55:00) is the effective activity ceiling --
  // the trailing bot comment is excluded as ack-only, same classification
  // as the review-currency gate. now (23:59:00) is 4min past that anchor,
  // so a 2min window has already elapsed from the disposition itself.
  assert.equal(status.anchorAt, '2026-05-11T23:55:00Z');
  assert.equal(status.elapsedMinutes, 4);
  assert.equal(status.elapsed, true);
  assert.equal(status.remainingMinutes, 0);
});

test('#2335: computePreMergeReadinessBlockers never blocks on an entirely absent secondaryQuietWindow evidence field (backward compatible with a hand-built or unmigrated report)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const ready = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  const { secondaryQuietWindow: _omitted, ...withoutField } = ready as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    computePreMergeReadinessBlockers(withoutField),
    computePreMergeReadinessBlockers(ready),
  );
});

test('#2335: a new unresolved finding arriving inside an already-elapsed window reopens it (acceptance criterion: a new finding returns the loop to E1)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  // Baseline: with the fixture's own anchor (23:56) and now (00:00), a 2min
  // window has already elapsed (4min >= 2min) -- same as the "elapsing with
  // nothing new" test above.
  const alreadyElapsed = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    secondaryQuietWindowMinutes: 2,
  });
  assert.equal(secondaryQuietWindowOf(alreadyElapsed).elapsed, true);

  // A late secondary-bot finding lands as a new unresolved thread, one
  // minute before `now` -- the exact scenario #2335 measured on PR #2330.
  // It pushes the effective activity ceiling forward, so the same 2min
  // window has NOT elapsed against this new anchor: the window reopens.
  const reopened = buildPreMergeReadinessSummary(
    {
      ...fixture.input,
      threads: [
        ...fixture.input.threads,
        {
          id: 'thread-late-secondary-finding',
          isResolved: false,
          updatedAt: '',
          reviewerReopenedAt: '',
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: 'coderabbitai[bot]' },
                body: 'This still needs a null check.',
                createdAt: '2026-05-11T23:59:00Z',
                updatedAt: '2026-05-11T23:59:00Z',
                pullRequestReview: { id: 'review-late' },
              },
            ],
          },
        },
      ],
    },
    {
      ...fixture.options,
      includeDispositionEvidence: true,
      secondaryQuietWindowMinutes: 2,
    },
  );
  const status = secondaryQuietWindowOf(reopened);
  assert.equal(status.anchorAt, '2026-05-11T23:59:00Z');
  assert.equal(status.elapsedMinutes, 1);
  assert.equal(status.elapsed, false);
  assert.ok(
    (reopened.blockers as { gate: string }[]).some(
      (blocker) => blocker.gate === 'secondary-quiet-window',
    ),
  );
});

// #2272: the development-branch-target gate is a fail-closed invariant
// distinct from every other pre-merge gate above -- absent entirely
// (unmigrated caller / every fixture above) adds no blocker at all,
// matching this file's own "every pre-#2272 caller unaffected" contract.
test('#2272: developmentBranchTarget omitted never adds a development-branch-target blocker (unmigrated caller, unchanged behavior)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const ready = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
  });
  assert.deepEqual(ready.blockers, computePreMergeReadinessBlockers(ready));
  assert.ok(
    !(ready.blockers as { gate: string }[]).some(
      (blocker) => blocker.gate === 'development-branch-target',
    ),
  );
  assert.equal('developmentBranchTarget' in ready, false);
});

test('#2272: a matching baseRefName never blocks (configured or default status)', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  for (const status of ['configured', 'default']) {
    const summary = buildPreMergeReadinessSummary(fixture.input, {
      ...fixture.options,
      includeDispositionEvidence: true,
      developmentBranchTarget: {
        status,
        branch: 'develop',
        baseRefName: 'develop',
      },
    });
    assert.deepEqual(
      summary.blockers,
      computePreMergeReadinessBlockers(summary),
    );
    assert.ok(
      !(summary.blockers as { gate: string }[]).some(
        (blocker) => blocker.gate === 'development-branch-target',
      ),
    );
  }
});

test('#2272: a PR base branch that differs from the effective development branch blocks, even with every other gate green', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    developmentBranchTarget: {
      status: 'configured',
      branch: 'develop',
      baseRefName: 'main',
    },
  });
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.blockers, computePreMergeReadinessBlockers(summary));
  const blocker = (summary.blockers as { gate: string; detail: string }[]).find(
    (item) => item.gate === 'development-branch-target',
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /"main".*"develop"/);
});

test('#2272: an invalid developmentBranch policy value fails closed, ignoring any live default branch', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    developmentBranchTarget: {
      status: 'invalid',
      reason: 'developmentBranch must be a string',
      baseRefName: 'main',
    },
  });
  assert.equal(summary.ready, false);
  const blocker = (summary.blockers as { gate: string; detail: string }[]).find(
    (item) => item.gate === 'development-branch-target',
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /invalid/);
});

test('#2272: an unavailable effective development branch (no policy, unread live default) fails closed', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    developmentBranchTarget: {
      status: 'unavailable',
      baseRefName: 'main',
    },
  });
  assert.equal(summary.ready, false);
  const blocker = (summary.blockers as { gate: string; detail: string }[]).find(
    (item) => item.gate === 'development-branch-target',
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /could not be resolved/);
});

test('#2272: an empty-string developmentBranchTarget.status fails closed to unavailable, not a silent passthrough', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    developmentBranchTarget: {
      status: '',
      baseRefName: 'main',
    },
  });
  assert.equal(summary.ready, false);
  const blocker = (summary.blockers as { gate: string; detail: string }[]).find(
    (item) => item.gate === 'development-branch-target',
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /could not be resolved/);
});

test('#2272: an unrecognized developmentBranchTarget.status fails closed even when branch coincidentally matches baseRefName', () => {
  const fixture = readJson('fixtures/pre-merge-readiness/clean.json');
  const summary = buildPreMergeReadinessSummary(fixture.input, {
    ...fixture.options,
    includeDispositionEvidence: true,
    developmentBranchTarget: {
      status: 'bogus',
      branch: 'main',
      baseRefName: 'main',
    },
  });
  assert.equal(summary.ready, false);
  const blocker = (summary.blockers as { gate: string; detail: string }[]).find(
    (item) => item.gate === 'development-branch-target',
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /unrecognized/);
});
