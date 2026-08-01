import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeClaimComment,
  normalizeComment,
  normalizeReview,
  normalizeThread,
} from '../src/scripts/pre-merge-readiness.mts';

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

test('normalizeThread maps GraphQL review-thread fields, including nested comment nodes', () => {
  assert.deepEqual(
    normalizeThread({
      id: 'RT_1',
      isResolved: false,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            body: 'nit: rename this',
            createdAt: '2026-07-31T09:00:00Z',
            author: { login: 'reviewer-user' },
            pullRequestReview: { id: 'PRR_1' },
          },
        ],
      },
    }),
    {
      id: 'RT_1',
      isResolved: false,
      updatedAt: '',
      reviewerReopenedAt: '',
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

/**
 * Build a stub `gh` Node script answering every call
 * `collectPreMergeReadiness` makes for the fixed OWNER/REPO/PR_NUMBER/
 * CLAIM_ISSUE/BASE_REF above, matching on `args[0]`/`args[1]` the same way
 * `cli-entry-smoke.test.mts`'s `discover-readiness-check.mjs` stub does.
 * `threadResolved` is the one field that differs between the clean and
 * blocked scenarios (see the two tests below).
 */
function buildStubGhScript(threadResolved: boolean): string {
  const prView = {
    headRefOid: 'a'.repeat(40),
    baseRefName: BASE_REF,
    url: `https://github.com/${REPO_REF}/pull/${PR_NUMBER}`,
    author: { login: 'author-user' },
    reviewDecision: 'APPROVED',
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
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/rules/branches/${BASE_REF}`}') out('');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/branches/${BASE_REF}/protection`}') out('{}');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/reviews`}') out(${JSON.stringify(ndjson(reviews))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/requested_reviewers`}') out('{"users":[]}');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${PR_NUMBER}/timeline`}') out('');
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${PR_NUMBER}/comments`}') out(${JSON.stringify(ndjson(prComments))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/issues/${CLAIM_ISSUE}/comments`}') out(${JSON.stringify(ndjson(claimComments))});
if (a(0) === 'api' && a(1) === 'graphql') out(${JSON.stringify(JSON.stringify(reviewThreadsPayload))});
if (a(0) === 'api' && a(1) === '${`repos/${REPO_REF}/pulls/${PR_NUMBER}/files`}') out(${JSON.stringify(ndjson(changedFiles))});
if (a(0) === 'api' && String(a(1)).startsWith('${`repos/${REPO_REF}/contents/`}')) notFound();
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runPreMergeReadinessSmoke(
  threadResolved: boolean,
): Record<string, unknown> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-readiness-cli-'));
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-pre-merge-readiness-cwd-'));
  try {
    const ghPath = join(tempRoot, 'gh');
    writeFileSync(ghPath, buildStubGhScript(threadResolved));
    chmodSync(ghPath, 0o755);

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

  // normalizeThread: id/isResolved flow into dispositionEvidence.missingThreads.
  const threads = report.threads as { unresolvedCount: number };
  assert.equal(threads.unresolvedCount, 0);
  const dispositionEvidence = report.dispositionEvidence as {
    missingThreads: { id: string; isResolved: boolean }[];
  };
  assert.equal(dispositionEvidence.missingThreads[0]?.id, 'RT_1');
  assert.equal(dispositionEvidence.missingThreads[0]?.isResolved, true);
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
