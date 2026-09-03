import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectPreMergeReadiness,
  normalizeClaimComment,
  normalizeComment,
  normalizeReview,
  normalizeThread,
} from '../src/scripts/pre-merge-readiness.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// Normalizer field-mapping unit tests (#1708 item 2).
//
// Each normalizer maps a raw REST/GraphQL payload's snake_case/nested field
// names onto the flat camelCase `*Like` shape `buildPreMergeReadinessSummary`
// (protocol-helpers.mts) expects. Previously unreferenced by any test.
// ---------------------------------------------------------------------------

test('normalizeComment maps REST issue-comment fields, falling back to createdAt when updated_at is absent', () => {
  assert.deepEqual(
    normalizeComment({
      id: 123,
      body: 'looks good',
      created_at: '2026-07-31T11:00:00Z',
      user: { login: 'Commenter-User' },
    }),
    {
      id: '123',
      author: { login: 'Commenter-User' },
      body: 'looks good',
      createdAt: '2026-07-31T11:00:00Z',
      updatedAt: '2026-07-31T11:00:00Z',
    },
  );
  assert.equal(
    normalizeComment({
      created_at: '2026-07-31T11:00:00Z',
      updated_at: '2026-07-31T12:00:00Z',
    }).updatedAt,
    '2026-07-31T12:00:00Z',
  );
});

test('normalizeClaimComment maps only body/createdAt/author.login, dropping id/updatedAt', () => {
  assert.deepEqual(
    normalizeClaimComment({
      id: 999,
      body: '<!-- claimed-by: agent -->',
      created_at: '2026-07-30T10:00:00Z',
      updated_at: '2026-07-30T11:00:00Z',
      user: { login: 'claimant-user' },
    }),
    {
      body: '<!-- claimed-by: agent -->',
      createdAt: '2026-07-30T10:00:00Z',
      author: { login: 'claimant-user' },
    },
  );
});

test('normalizeReview maps REST review fields, deriving createdAt from submitted_at and falling back updatedAt to it', () => {
  assert.deepEqual(
    normalizeReview({
      state: 'APPROVED',
      user: { login: 'reviewer-user' },
      submitted_at: '2026-07-31T12:00:00Z',
      commit_id: 'abc123',
    }),
    {
      author: { login: 'reviewer-user' },
      state: 'APPROVED',
      commitId: 'abc123',
      submittedAt: '2026-07-31T12:00:00Z',
      createdAt: '2026-07-31T12:00:00Z',
      updatedAt: '2026-07-31T12:00:00Z',
    },
  );
  assert.equal(
    normalizeReview({
      submitted_at: '2026-07-31T12:00:00Z',
      updated_at: '2026-07-31T13:00:00Z',
    }).updatedAt,
    '2026-07-31T13:00:00Z',
  );
});

test('normalizeThread maps a ProviderPort review-thread node, including nested comments', () => {
  assert.deepEqual(
    normalizeThread({
      isResolved: false,
      comments: [
        {
          body: 'nit: rename this',
          createdAt: '2026-07-31T09:00:00Z',
          updatedAt: '',
          authorLogin: 'reviewer-user',
          pullRequestReviewId: 'PRR_1',
        },
      ],
    }),
    {
      isResolved: false,
      updatedAt: '',
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            author: { login: 'reviewer-user' },
            body: 'nit: rename this',
            createdAt: '2026-07-31T09:00:00Z',
            updatedAt: '2026-07-31T09:00:00Z',
            pullRequestReview: { id: 'PRR_1' },
          },
        ],
      },
    },
  );
});

// ---------------------------------------------------------------------------
// Raw-payload stub-gh CLI smoke (#1708 item 1).
//
// `collectPreMergeReadiness` orchestrates 15+ distinct `gh` calls before
// handing normalized data to the pure `buildPreMergeReadinessSummary`. That
// seam runs only in production -- `tests/pre-merge-readiness.test.mts`
// imports and exercises only the pure summarizers, never this collector.
// This spawns the real built `pre-merge-readiness.mjs` against a stub `gh`
// on PATH (reusing the `cli-entry-smoke.test.mts` pattern) with RAW
// REST/GraphQL payload shapes, covering one clean and one blocked scenario
// that differ in exactly one field (a review thread's `isResolved`), so a
// normalizer or collection-wiring regression changes the final verdict.
//
// Run with `cwd: <empty temp dir>` (not REPO_ROOT): every policy read in
// `collectPreMergeReadiness` (`loadIddConfig`, `readForcedHandoffMode`,
// `readCollaboratorTrustEnabled`, etc.) resolves `.github/idd/config.json`
// relative to `process.cwd()`, not the script's own location. An empty cwd
// makes every one of those reads fail closed to schema defaults, which
// keeps this fixture hermetic (independent of this repository's own live
// config) and -- since `forcedHandoff.mode` defaults to `disabled` and
// `collaboratorTrust` defaults to off -- skips the two gh calls that are
// conditional on those policies, keeping the stub's call inventory to
// exactly what a default-policy adopter repository would trigger.
// ---------------------------------------------------------------------------

const OWNER = 'o';
const REPO = 'r';
const REPO_REF = `${OWNER}/${REPO}`;
const PR_NUMBER = 42;
const CLAIM_ISSUE = 7;
const BASE_REF = 'main';

function ndjson(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

// #2042: `fetchReviewsAndHeadCommit`'s fixture `committedDate`, hoisted to
// module scope so the stub script (which embeds it) and the end-to-end
// assertion below (which checks the parsed value round-tripped correctly)
// share one source of truth instead of two independently-typed literals.
// 1h before this suite's fixed `--now` (2026-08-01T00:00:00Z), well inside
// the 24h default deadline, so `advisoryConvergenceDeadlinePassed` stays
// `false` and this fixture does not perturb either scenario's existing
// `ready`/blockers assertions.
const REVIEWS_AND_HEAD_COMMIT_COMMITTED_DATE = '2026-07-31T23:00:00Z';

/**
 * Build a stub `gh` Node script answering every call
 * `collectPreMergeReadiness` makes for the fixed OWNER/REPO/PR_NUMBER/
 * CLAIM_ISSUE/BASE_REF above, matching on `args[0]`/`args[1]` the same way
 * `cli-entry-smoke.test.mts`'s `discover-readiness-check.mjs` stub does.
 * `threadResolved` is the one field that differs between the clean and
 * blocked scenarios (see the two tests below).
 */
function buildStubGhScript(
  threadResolved: boolean,
  options: {
    closingIssuesReferences?: unknown[];
    failOnClaimComments?: boolean;
  } = {},
): string {
  const prView = {
    headRefOid: 'a'.repeat(40),
    baseRefName: BASE_REF,
    url: `https://github.com/${REPO_REF}/pull/${PR_NUMBER}`,
    author: { login: 'author-user' },
    reviewDecision: 'APPROVED',
    closingIssuesReferences: options.closingIssuesReferences ?? [],
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'lint',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        completedAt: '2026-08-01T00:00:00Z',
        workflowName: 'CI',
      },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  };
  const reviews = [
    {
      state: 'APPROVED',
      user: { login: 'reviewer-user' },
      submitted_at: '2026-07-31T12:00:00Z',
      commit_id: prView.headRefOid,
    },
  ];
  const prComments = [
    {
      id: 1,
      body: 'looks good',
      created_at: '2026-07-31T11:00:00Z',
      user: { login: 'commenter-user' },
    },
  ];
  const claimComments = [
    {
      id: 2,
      body: '<!-- claimed-by: {"claimId":"c1","agentId":"a1"} -->',
      created_at: '2026-07-30T10:00:00Z',
      user: { login: 'claimant-user' },
    },
  ];
  const changedFiles = [{ filename: 'src/scripts/example.mts' }];
  const reviewThreadsPayload = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'RT_1',
                isResolved: threadResolved,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      body: 'nit: rename this',
                      createdAt: '2026-07-31T09:00:00Z',
                      author: { login: 'reviewer-user' },
                      pullRequestReview: { id: 'PRR_1' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  // #2042: `fetchReviewsAndHeadCommit` (review-clause.mts) issues its OWN
  // `gh api graphql` call, distinct from the review-threads query above.
  // The stub script below matches each query on a field name unique to it
  // (`reviewThreads` here, `committedDate` for this payload) rather than
  // "the other query didn't match" -- so a third, genuinely unexpected
  // GraphQL call falls through to the script's final `unexpected gh
  // invocation` failure instead of silently receiving whichever fixture
  // happened to be the catch-all.
  const reviewsAndHeadCommitPayload = {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                commit: { oid: prView.headRefOid },
                submittedAt: '2026-07-31T12:00:00Z',
                author: { login: 'reviewer-user', __typename: 'User' },
                comments: { totalCount: 0 },
                body: '',
              },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  committedDate: REVIEWS_AND_HEAD_COMMIT_COMMITTED_DATE,
                },
              },
            ],
          },
        },
      },
    },
  };

  // Each branch below matches one distinct call `collectPreMergeReadiness`
  // makes. An unmatched call falls through to the final handler, which
  // fails loudly instead of hanging (mirrors cli-entry-smoke.test.mts) --
  // except the `api user`/`api app` reads, which go through `safeGhText`
  // (gh-exec.mts) and so degrade silently to `''` on any failure, including
  // this stub's own "unexpected invocation" exit; harmless here since none
  // of this suite's assertions depend on viewerLogin/viewerAppSlug, but an
  // arg-shape drift on those two specific calls alone would not turn red.
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const a = (i) => args[i];
function out(text) { process.stdout.write(text); process.exit(0); }
function notFound() { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }

if (a(0) === 'api' && a(1) === 'user') out(${JSON.stringify('viewer-user')});
if (a(0) === 'api' && a(1) === 'app') out('');
if (a(0) === 'pr' && a(1) === 'view' && a(2) === '${String(PR_NUMBER)}') out(${JSON.stringify(JSON.stringify(prView))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}`}') out(${JSON.stringify(BASE_REF)});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/rules/branches/${BASE_REF}`}') out('');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/branches/${BASE_REF}/protection`}') out('{}');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/reviews`}') out(${JSON.stringify(ndjson(reviews))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/requested_reviewers`}') out('{"users":[]}');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${PR_NUMBER}/timeline`}') out('');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${PR_NUMBER}/comments`}') out(${JSON.stringify(ndjson(prComments))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${CLAIM_ISSUE}/comments`}') {
  ${options.failOnClaimComments ? "process.stderr.write('claim comments must not be fetched under --claimless\\\\n'); process.exit(1);" : `out(${JSON.stringify(ndjson(claimComments))});`}
}
if (a(0) === 'api' && a(1) === 'graphql' && args.join(' ').includes('reviewThreads')) out(${JSON.stringify(JSON.stringify(reviewThreadsPayload))});
if (a(0) === 'api' && a(1) === 'graphql' && args.join(' ').includes('committedDate')) out(${JSON.stringify(JSON.stringify(reviewsAndHeadCommitPayload))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/files`}') out(${JSON.stringify(ndjson(changedFiles))});
if (a(0) === 'api' && String(a(1)).startsWith('${`repos/${REPO_REF}/contents/`}')) notFound();
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runPreMergeReadinessSmoke(
  threadResolved: boolean,
  options: { configJson?: string } = {},
): Record<string, unknown> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-readiness-cli-'));
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-readiness-cwd-'));
  try {
    const ghPath = join(tempRoot, 'gh');
    writeFileSync(ghPath, buildStubGhScript(threadResolved));
    chmodSync(ghPath, 0o755);

    if (options.configJson !== undefined) {
      const configDir = join(cwdRoot, '.github', 'idd');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), options.configJson);
    }

    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/pre-merge-readiness.mjs'),
        '--pr',
        String(PR_NUMBER),
        '--claim-issue',
        String(CLAIM_ISSUE),
        '--owner',
        OWNER,
        '--repo',
        REPO,
        '--now',
        '2026-08-01T00:00:00Z',
      ],
      {
        cwd: cwdRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
        timeout: 60_000,
      },
    );

    assert.doesNotMatch(
      output,
      /ReferenceError|before initialization/,
      'CLI output must not carry a load-time ReferenceError',
    );
    return JSON.parse(output) as Record<string, unknown>;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

// Full "ready: true" would additionally require faithfully replicating this
// repo's review-watermark and claim-marker comment grammar (their own
// protocols, already covered by buildPreMergeReadinessSummary's own pure
// unit tests in tests/pre-merge-readiness.test.mts) -- out of scope here.
// These assertions instead target report fields that are direct,
// observable passthroughs of one specific normalizer's output, so a
// mutated field mapping in normalizeComment, normalizeReview, or
// normalizeThread changes a concrete assertion below (verified manually
// against a mutated build; see the PR description).
test('pre-merge-readiness.mjs CLI: clean scenario collects and normalizes raw gh payloads end-to-end', () => {
  const report = runPreMergeReadinessSmoke(true);

  // normalizeComment: id/author.login/createdAt/body flow into
  // unrepliedComments.
  assert.deepEqual(report.unrepliedComments, {
    count: 1,
    items: [
      {
        id: '1',
        authorLogin: 'commenter-user',
        createdAt: '2026-07-31T11:00:00Z',
        bodyPreview: 'looks good',
      },
    ],
  });

  // normalizeReview: author.login/state/submittedAt flow into
  // reviewerStates.latestByAuthor.
  const reviewerStates = report.reviewerStates as {
    latestByAuthor: { login: string; state: string; submittedAt: string }[];
  };
  assert.deepEqual(reviewerStates.latestByAuthor, [
    {
      login: 'reviewer-user',
      state: 'APPROVED',
      submittedAt: '2026-07-31T12:00:00Z',
      isHuman: true,
      isAdvisoryBot: false,
      isCodeowner: false,
      isRequiredReviewer: false,
    },
  ]);

  // normalizeThread: isResolved flows into dispositionEvidence.missingThreads.
  // #2267: `id` is now the `thread-${index+1}` fallback, not the raw GraphQL
  // node id -- `ProviderPort.listChangeRequestReviewThreadsWithComments`
  // (byte-identical query, shared with the already-migrated
  // review-activity-snapshot.mts) does not surface it, matching that file's
  // own already-reviewed `normalizeThread`. This id is diagnostic-only in
  // this report: `advisory-convergence.mts` (the one real id-matching
  // consumer, `copilotThreadIds.has(thread.id)`) fetches its own,
  // independent `threads` array via its own port method and never reads
  // this file's output.
  const threads = report.threads as { unresolvedCount: number };
  assert.equal(threads.unresolvedCount, 0);
  const dispositionEvidence = report.dispositionEvidence as {
    missingThreads: { id: string; isResolved: boolean }[];
  };
  assert.equal(dispositionEvidence.missingThreads[0]?.id, 'thread-1');
  assert.equal(dispositionEvidence.missingThreads[0]?.isResolved, true);

  // #2042: `fetchReviewsAndHeadCommit`'s own `gh api graphql` call must
  // receive `reviewsAndHeadCommitPayload`, not `reviewThreadsPayload` --
  // asserting the parsed `headCommittedAt` end-to-end catches a stub (or
  // production query) drift that would otherwise silently leave this call
  // site fed the wrong payload shape (it would parse to `''`/"none"
  // without failing this test, the exact gap #2042 closes).
  const precondition = report.advisoryConvergenceWaiverPrecondition as {
    headCommittedAt: string;
  };
  assert.equal(
    precondition.headCommittedAt,
    REVIEWS_AND_HEAD_COMMIT_COMMITTED_DATE,
  );
});

// #2319's isolation acceptance criterion: the read-only provider-health
// classifier's `providerHealth` policy object must change no existing
// merge-readiness output. Runs the identical clean-scenario stub twice --
// once with no config.json (the baseline every other test in this file
// already exercises), once with a config.json that both satisfies the
// policy schema's required fields and configures a non-default
// `providerHealth` value -- and asserts the parsed reports are byte-
// identical, since `pre-merge-readiness.mts` never reads this key.
test('pre-merge-readiness.mjs CLI: a configured providerHealth policy changes no existing output field (#2319 isolation)', () => {
  const baseline = runPreMergeReadinessSmoke(true);
  const withProviderHealth = runPreMergeReadinessSmoke(true, {
    configJson: JSON.stringify({
      iddVersion: '1.0.0',
      markerPrefix: 'idd-skill',
      mergePolicy: 'fully_autonomous_merge',
      reviewPolicy: 'copilot-advisory',
      threadResolutionPolicy: 'fast-agent-resolve',
      claimTiming: { staleAge: 'PT24H', heartbeatInterval: 'PT12H' },
      trustedMarkerActors: [],
      commands: {
        'install-deps': 'true',
        'fix-validate': 'npx dprint fmt',
        'pre-push-validate': 'npx dprint check',
        'post-fix-validate': 'npx dprint fmt && npx markdownlint-cli2',
      },
      providerHealth: { minCorroboratingPrs: 5, samplingWindow: 'PT6H' },
    }),
  });
  assert.deepEqual(withProviderHealth, baseline);
});

test('pre-merge-readiness.mjs CLI: --claimless on an empty-references PR skips claim fetch (#2017)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-claimless-cli-'));
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-claimless-cwd-'));
  try {
    const ghPath = join(tempRoot, 'gh');
    writeFileSync(
      ghPath,
      buildStubGhScript(true, { failOnClaimComments: true }),
    );
    chmodSync(ghPath, 0o755);
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/pre-merge-readiness.mjs'),
        '--pr',
        String(PR_NUMBER),
        '--claimless',
        '--owner',
        OWNER,
        '--repo',
        REPO,
        '--now',
        '2026-08-01T00:00:00Z',
      ],
      {
        cwd: cwdRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
        timeout: 60_000,
      },
    );
    const report = JSON.parse(output) as {
      claim: {
        reason: string;
        claimLost: boolean;
        expectedClaimId: string;
        activeClaim: { claimId: string };
      };
      ci: unknown;
      reviewCurrency: unknown;
      advisoryWait: unknown;
      threads: unknown;
      branchCurrency: unknown;
    };
    assert.equal(report.claim.reason, 'not-applicable');
    assert.equal(report.claim.claimLost, false);
    assert.equal(report.claim.expectedClaimId, 'none');
    assert.equal(report.claim.activeClaim.claimId, 'none');
    assert.ok(report.ci);
    assert.ok(report.reviewCurrency);
    assert.ok(report.advisoryWait);
    assert.ok(report.threads);
    assert.ok(report.branchCurrency);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

test('pre-merge-readiness.mjs CLI: --claimless fails closed when closingIssuesReferences is non-empty (#2017)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-claimless-fail-'));
  const cwdRoot = mkdtempSync(
    join(tmpdir(), 'idd-pre-merge-claimless-fail-cwd-'),
  );
  try {
    const ghPath = join(tempRoot, 'gh');
    writeFileSync(
      ghPath,
      buildStubGhScript(true, {
        closingIssuesReferences: [{ number: 99 }],
        failOnClaimComments: true,
      }),
    );
    chmodSync(ghPath, 0o755);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(REPO_ROOT, 'scripts/pre-merge-readiness.mjs'),
            '--pr',
            String(PR_NUMBER),
            '--claimless',
            '--owner',
            OWNER,
            '--repo',
            REPO,
            '--now',
            '2026-08-01T00:00:00Z',
          ],
          {
            cwd: cwdRoot,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
            },
            timeout: 60_000,
          },
        ),
      /closingIssuesReferences/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

test('pre-merge-readiness.mjs CLI: blocked scenario (one unresolved review thread) surfaces it end-to-end', () => {
  const report = runPreMergeReadinessSmoke(false);

  const threads = report.threads as { unresolvedCount: number };
  assert.equal(threads.unresolvedCount, 1);
  const dispositionEvidence = report.dispositionEvidence as {
    missingThreads: { id: string; isResolved: boolean }[];
  };
  assert.equal(dispositionEvidence.missingThreads[0]?.isResolved, false);

  // The clean scenario is *also* `ready: false` here (replicating the
  // review-watermark/claim-marker grammar needed for a full ready:true is
  // out of scope, see the block comment above), so asserting `ready` alone
  // would not discriminate between the two scenarios. Assert the ONE gate
  // this scenario's flipped field should add instead.
  const blockers = report.blockers as { gate: string }[];
  assert.ok(
    blockers.some((blocker) => blocker.gate === 'unresolved-threads'),
    `expected an "unresolved-threads" blocker, got: ${JSON.stringify(blockers)}`,
  );
});

// ---------------------------------------------------------------------------
// Fake-provider collection wiring (#2267 AC4: "unit tests exercise the
// PR-facing state machine with a fake provider ... without network access").
// The stub-gh CLI tests above already exercise the real, built .mjs process
// end to end; this test instead drives collectPreMergeReadiness IN-PROCESS
// against createFakeProviderAdapter -- proving createPort's injection seam
// actually wires every port call this file makes through to a fake, with
// zero gh subprocess and zero live network access. Deliberately narrow (one
// blocked scenario covering the two AC4-named conditions this file's own
// state machine can produce: an unreadable CI/branch-governance read and an
// unresolved review thread) -- the pure summarizer's exhaustive gate matrix
// is already covered by buildPreMergeReadinessSummary's own direct unit
// tests above in tests/pre-merge-readiness.test.mts.
// ---------------------------------------------------------------------------

test('collectPreMergeReadiness against a fake provider: unreadable CI governance + an unresolved thread block, with no gh process spawned', () => {
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-fake-provider-'));
  const originalCwd = process.cwd();
  try {
    // Hermetic: an unpatched cwd would read THIS repo's own live
    // .github/idd/config.json (mergePolicy: fully_autonomous_merge, etc.)
    // during collection, since collectPreMergeReadiness resolves every
    // policy read relative to process.cwd(), not this script's location
    // (same rationale as runPreMergeReadinessSmoke's empty cwdRoot above).
    process.chdir(cwdRoot);

    const port = createFakeProviderAdapter({
      changeRequestReadinessSnapshots: {
        42: {
          headSha: 'a'.repeat(40),
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/42',
          authorLogin: 'author-user',
          reviewDecision: null,
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              name: 'lint',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              completedAt: '2026-08-01T00:00:00Z',
              workflowName: 'CI',
            },
          ],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: [],
        },
      },
      // listBranchRules/getBranchProtection deliberately absent -- the fake
      // resolves both to {outcome:'not-found'}, which fetchGovernanceJson
      // (trustEmptyProtectionReads defaults to false with no config.json)
      // classifies as unreadable, producing a real "ci" blocker without
      // needing to replicate a required-check-mismatch fixture.
      reviewThreadsWithComments: {
        42: [
          {
            isResolved: false,
            comments: [
              {
                body: 'please address this',
                createdAt: '2026-07-31T09:00:00Z',
                updatedAt: '2026-07-31T09:00:00Z',
                authorLogin: 'reviewer-user',
                pullRequestReviewId: null,
              },
            ],
          },
        ],
      },
      reviewsWithHeadCommitDate: {
        42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
      },
    });

    const report = collectPreMergeReadiness(
      [
        '--pr',
        '42',
        '--claimless',
        '--owner',
        'o',
        '--repo',
        'r',
        '--now',
        '2026-08-01T00:00:00Z',
      ],
      () => port,
    );

    const ciReport = report.ci as { protectionReadsUnreadable: boolean };
    assert.equal(ciReport.protectionReadsUnreadable, true);
    const threadsReport = report.threads as { unresolvedCount: number };
    assert.equal(threadsReport.unresolvedCount, 1);
    const blockers = report.blockers as { gate: string }[];
    assert.ok(
      blockers.some((blocker) => blocker.gate === 'ci'),
      `expected a "ci" blocker, got: ${JSON.stringify(blockers)}`,
    );
    assert.ok(
      blockers.some((blocker) => blocker.gate === 'unresolved-threads'),
      `expected an "unresolved-threads" blocker, got: ${JSON.stringify(blockers)}`,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

test('collectPreMergeReadiness against a fake provider: a required check reporting FAILURE blocks readiness, with readable governance and no gh process spawned', () => {
  // Complements the "unreadable CI governance" fake-provider test above
  // (#2267 AC4 review): that test's protectionReadsUnreadable: true short-
  // circuits the CI gate before any individual check's conclusion is ever
  // classified, so it cannot exercise summarizeRequiredChecks's own
  // pending/failing-check path. This test instead supplies a readable
  // branchRules fixture naming "lint" as required, then reports a
  // COMPLETED/FAILURE check-run for it -- classifyCiChecks
  // (protocol-helpers.mts) buckets that as status: 'failed', which is
  // distinct from the unreadable-governance case's own generic "not all
  // passing" cause.
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-fake-ci-failed-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(cwdRoot);

    const port = createFakeProviderAdapter({
      changeRequestReadinessSnapshots: {
        42: {
          headSha: 'a'.repeat(40),
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/42',
          authorLogin: 'author-user',
          reviewDecision: null,
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              name: 'lint',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              completedAt: '2026-08-01T00:00:00Z',
              workflowName: 'CI',
            },
          ],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: [],
        },
      },
      branchRules: {
        'o/r/main': [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'lint' }] },
          },
        ],
      },
      branchProtection: { 'o/r/main': {} },
      reviewThreadsWithComments: { 42: [] },
      reviewsWithHeadCommitDate: {
        42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
      },
    });

    const report = collectPreMergeReadiness(
      [
        '--pr',
        '42',
        '--claimless',
        '--owner',
        'o',
        '--repo',
        'r',
        '--now',
        '2026-08-01T00:00:00Z',
      ],
      () => port,
    );

    const ciReport = report.ci as {
      protectionReadsUnreadable: boolean;
      status: string;
      requiredChecksPassing: boolean;
    };
    assert.equal(ciReport.protectionReadsUnreadable, false);
    assert.equal(ciReport.status, 'failed');
    assert.equal(ciReport.requiredChecksPassing, false);
    const blockers = report.blockers as { gate: string }[];
    assert.ok(
      blockers.some((blocker) => blocker.gate === 'ci'),
      `expected a "ci" blocker, got: ${JSON.stringify(blockers)}`,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

test('collectPreMergeReadiness against a fake provider: a matching CODEOWNER resolves via the injected port, not a fresh live adapter (Codex review, PR #2429)', () => {
  // resolveEligibleCodeownerUserLogins's default fetchPermission
  // constructed its own createGithubProviderAdapter(owner, repo) instead
  // of reusing this collector's own injected port -- invisible to every
  // other fake-provider test in this file because none of them exercise a
  // changed file that actually matches a CODEOWNERS rule. Strips `gh` from
  // PATH so a live-adapter fallback resolves to getCollaboratorPermission's
  // own {outcome:'error'} catch-all (a spawn ENOENT has no HTTP status),
  // which resolveEligibleCodeownerUserLogins classifies as `unreadable`
  // (excluded, not rethrown -- so a bare doesNotThrow would not catch the
  // regression) -- assert codeownerEligibilityUnreadable stays false
  // instead, which only holds when the fixture's own 'write' permission was
  // actually read.
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-fake-codeowner-'));
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  try {
    process.chdir(cwdRoot);
    process.env.PATH = '';

    const codeownersContent = Buffer.from('* @reviewer-user\n', 'utf8')
      .toString('base64')
      .replace(/=+$/, '');
    const port = createFakeProviderAdapter({
      changeRequestReadinessSnapshots: {
        42: {
          headSha: 'a'.repeat(40),
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/42',
          authorLogin: 'author-user',
          reviewDecision: null,
          statusCheckRollup: [],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: [],
        },
      },
      branchRules: { 'o/r/main': [] },
      branchProtection: { 'o/r/main': {} },
      reviewThreadsWithComments: { 42: [] },
      reviewsWithHeadCommitDate: {
        42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
      },
      repositoryContentAtRef: {
        'o/r/.github/CODEOWNERS@main': { content: codeownersContent },
      },
      changedFiles: { 42: ['src/index.ts'] },
      collaboratorPermissions: {
        'reviewer-user': {
          outcome: 'found',
          permission: 'write',
          roleName: 'write',
        },
      },
    });

    const report = collectPreMergeReadiness(
      [
        '--pr',
        '42',
        '--claimless',
        '--owner',
        'o',
        '--repo',
        'r',
        '--now',
        '2026-08-01T00:00:00Z',
      ],
      () => port,
    );
    const reviewerStates = report.reviewerStates as {
      codeownerSelfApproval: { codeownerEligibilityUnreadable: boolean };
    };
    assert.equal(
      reviewerStates.codeownerSelfApproval.codeownerEligibilityUnreadable,
      false,
      'expected the fixture-provided write permission to resolve cleanly via the injected port',
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    process.chdir(originalCwd);
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #2544: secondaryQuietWindow settled-buffer end-to-end wiring. Proves
// collectPreMergeReadiness's own readAdvisorySecondaryBotLogin() call
// (pre-merge-readiness.mts) actually reaches buildPreMergeReadinessSummary
// and computeSecondaryAdvisoryReviewSettlement (protocol-helpers.mts), not
// just the unit-level buildSecondaryQuietWindowStatus tests in
// tests/advisory-wait-policy.test.mts.
// ---------------------------------------------------------------------------

function runSecondaryQuietWindowFixture(
  comments: Array<{ body: string; createdAt: string; authorLogin: string }>,
  now: string,
): { elapsed: boolean; remainingMinutes: number | null } {
  const cwdRoot = mkdtempSync(
    join(tmpdir(), 'idd-pre-merge-secondary-quiet-window-'),
  );
  const originalCwd = process.cwd();
  try {
    process.chdir(cwdRoot);
    const configDir = join(cwdRoot, '.github', 'idd');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        advisoryWait: {
          secondaryBotLogin: 'coderabbitai[bot]',
          secondaryQuietWindow: 'PT1H',
        },
      }),
    );

    const port = createFakeProviderAdapter({
      changeRequestReadinessSnapshots: {
        42: {
          headSha: 'a'.repeat(40),
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/42',
          authorLogin: 'author-user',
          reviewDecision: null,
          statusCheckRollup: [],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: [],
        },
      },
      branchRules: { 'o/r/main': [] },
      branchProtection: { 'o/r/main': {} },
      reviewThreadsWithComments: { 42: [] },
      reviewsWithHeadCommitDate: {
        42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
      },
      changedFiles: { 42: [] },
      comments: {
        42: comments.map((entry, index) => ({
          id: index + 1,
          body: entry.body,
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          authorLogin: entry.authorLogin,
        })),
      },
    });

    const report = collectPreMergeReadiness(
      [
        '--pr',
        '42',
        '--claimless',
        '--owner',
        'o',
        '--repo',
        'r',
        '--now',
        now,
      ],
      () => port,
    );
    return report.secondaryQuietWindow as {
      elapsed: boolean;
      remainingMinutes: number | null;
    };
  } finally {
    process.chdir(originalCwd);
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

test('collectPreMergeReadiness: secondaryQuietWindow settles quickly once CodeRabbit posts a genuine review for HEAD, well before the configured 1h window would elapse', () => {
  const status = runSecondaryQuietWindowFixture(
    [
      {
        body:
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
          '## Walkthrough\nSome walkthrough text.',
        createdAt: '2026-07-31T23:02:00Z',
        authorLogin: 'coderabbitai[bot]',
      },
    ],
    // 5 minutes after the review -- exactly the #2544 settled buffer, but
    // nowhere near the configured PT1H window.
    '2026-07-31T23:07:00Z',
  );
  assert.equal(status.elapsed, true);
});

// #2547: a rate-limit notice for the current HEAD is a definitive decline,
// not "still might be mid-review" -- the wait is skipped entirely (zero
// remaining minutes), unlike the pre-#2547 behavior this test used to
// assert (full window, `elapsed: false`, `remainingMinutes: 56`).
test('collectPreMergeReadiness: secondaryQuietWindow skips the wait entirely once CodeRabbit has posted a rate-limit notice for HEAD (#2547 decline, not #2335 mid-review)', () => {
  const status = runSecondaryQuietWindowFixture(
    [
      {
        body:
          '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n' +
          '> ## Review limit reached',
        createdAt: '2026-07-31T23:02:00Z',
        authorLogin: 'coderabbitai[bot]',
      },
    ],
    '2026-07-31T23:06:00Z',
  );
  assert.equal(status.elapsed, true);
  assert.equal(status.remainingMinutes, 0);
});

test('collectPreMergeReadiness: secondaryQuietWindow still blocks for the full window when CodeRabbit has said nothing, even though other PR activity exists', () => {
  const status = runSecondaryQuietWindowFixture(
    [
      {
        body: 'looks good to me',
        createdAt: '2026-07-31T23:02:00Z',
        authorLogin: 'human-reviewer',
      },
    ],
    '2026-07-31T23:06:00Z',
  );
  assert.equal(status.elapsed, false);
  assert.equal(status.remainingMinutes, 56);
});
