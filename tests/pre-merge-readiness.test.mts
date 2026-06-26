import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  fetchBranchRulesets,
  parseArgs,
} from '../src/scripts/pre-merge-readiness.mts';
import {
  buildActivitySnapshotSummary,
  buildAdvisoryWaitSummary,
  buildPreMergeReadinessSummary,
  deriveIddAgentLogins,
  findLastCopilotReviewCommit,
  indexLatestGatingReviewsByAuthor,
  isAdvisoryNonReviewNotice,
  isNonReviewNoticeDisposition,
  resolveActiveClaimForWriteGate,
  resolveCodeownersForFiles,
  resolveRulesetDetailPath,
  selectCodeownersText,
  summarizeAdvisoryWaitMarkers,
  summarizeClaimValidation,
  summarizeDispositionEvidenceForGate,
  summarizeExternalCheckWaivers,
  summarizeRegularCommentsForGate,
  summarizeRequiredChecks,
  summarizeReviewerStates,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

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
    presentRunConclusion: 'none',
    requiredCheckCount: 0,
    generatedRequiredCheckCount: 0,
    requiredChecksGenerated: false,
    requiredChecksPassing: false,
    requiredCheckNames: [],
    missingRequiredCheckNames: [],
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
});

test('classic branch protection app_id -1 does not force source-pinned status', () => {
  const summary = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS', completedAt: '2026-05-12T00:32:10Z' }],
    [],
    { required_status_checks: { checks: [{ context: 'lint', app_id: -1 }] } },
  );

  assert.equal(summary.status, 'success');
  assert.deepEqual(summary.requiredCheckNames, ['lint']);
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
  });
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

test('disposition evidence blocks when a regular comment has no disposition marker reply', () => {
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

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.blockingCount, 1);
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingThreadCount, 0);
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

test('disposition evidence rejects reviewer-authored Accepted marker in threads', () => {
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

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingThreadCount, 1);
  assert.equal(summary.missingThreads[0].reason, 'missing-fresh-disposition');
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
  const result = fetchBranchRulesets('o', 'r', oneRulesetRule, (path) => {
    seen.push(path);
    throw ghHttpError(404, 'Not Found');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /\/rulesets\/1$/);
  assert.deepEqual(result, []);
});

test('fetchBranchRulesets keeps real rulesets and drops empty results', () => {
  const rules = [{ ruleset_id: 1 }, { ruleset_id: 2 }] as Parameters<
    typeof fetchBranchRulesets
  >[2];
  const result = fetchBranchRulesets('o', 'r', rules, (path) =>
    path.endsWith('/1') ? { id: 1, current_user_can_bypass: 'always' } : {},
  );
  assert.deepEqual(result, [{ id: 1, current_user_can_bypass: 'always' }]);
});

test('fetchBranchRulesets propagates a non-404 fetch error instead of coercing to "no ruleset"', () => {
  const boom = ghHttpError(403, 'API rate limit exceeded');
  assert.throws(
    () =>
      fetchBranchRulesets('o', 'r', oneRulesetRule, () => {
        throw boom;
      }),
    (error: unknown) => error === boom,
  );
});

test('parseArgs: valid --pr / --claim-issue parse to positive integers', () => {
  const args = parseArgs(['--pr', '1082', '--claim-issue', '1076']);
  assert.equal(args.prNumber, 1082);
  assert.equal(args.claimIssueNumber, 1076);
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

function readJson(relativePath: string) {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  );
}
