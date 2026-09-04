import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// #1692: stub-gh CLI subprocess smokes proving each of the three helpers
// correctly parses multi-page `gh api --paginate` output.
//
// Before this fix, each helper's local pagination handling broke once a
// paginated endpoint's stub response spanned more than one NDJSON line:
// `stalled-session-quiet-check.mjs` and `claim-approval-gate.mjs` both did a
// single whole-stdout `JSON.parse`, which throws on any 2+-line output;
// `review-activity-snapshot.mjs` split on '\n' without requesting `--jq
// '.[]'`, which is only reliably newline-delimited on modern gh. All three
// now request `--jq '.[]'`-shaped NDJSON and parse it via the shared
// `parsePaginatedGhNdjson`, so a 2-line stub response (simulating output
// spanning more than one page) is the right regression shape regardless of
// which of the two prior bugs a given file had.
//
// Reuses the cli-entry-smoke.test.mts pattern: stub `gh` on PATH matched by
// exact argv, unmatched calls fail loudly instead of hanging.
// ---------------------------------------------------------------------------

function ndjson(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

/**
 * Build a stub `gh` Node script matching each call in `responses` (keyed by
 * `JSON.stringify(argv)`) exactly. An unmatched call fails loudly. The one
 * exception: when `graphqlResponse` is given, `api graphql` calls match on
 * `args[0]`/`args[1]` alone (checked before the exact-argv table), returning
 * the same canned response regardless of the GraphQL query/variables --
 * `fetchReviewThreads`'s query text is unrelated to this file's pagination
 * fix and reproducing it byte-for-byte here would be needlessly brittle.
 */
function buildStubGh(
  responses: Map<string, string>,
  graphqlResponse?: string,
): string {
  const table = JSON.stringify([...responses.entries()]);
  const graphqlLine =
    graphqlResponse === undefined
      ? ''
      : `if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(${JSON.stringify(graphqlResponse)});
  process.exit(0);
}
`;
  return `const args = process.argv.slice(2);
${graphqlLine}const table = new Map(${table});
const key = JSON.stringify(args);
if (table.has(key)) {
  process.stdout.write(table.get(key));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`;
}

function runStubbedCli(
  scriptRelPath: string,
  cliArgs: string[],
  responses: Map<string, string>,
  graphqlResponse?: string,
): string {
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-gh-pagination-cwd-'));
  const restore = stubExecutable('gh', buildStubGh(responses, graphqlResponse));
  try {
    return execFileSync(
      process.execPath,
      [join(REPO_ROOT, scriptRelPath), ...cliArgs],
      {
        cwd: cwdRoot,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 60_000,
      },
    );
  } finally {
    restore();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

const OWNER = 'o';
const REPO = 'r';
const REPO_REF = `${OWNER}/${REPO}`;
const HEAD_SHA = 'a'.repeat(40);

test('stalled-session-quiet-check.mjs CLI: parses multi-line NDJSON output from every paginated endpoint', () => {
  const responses = new Map<string, string>([
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/pulls/42`,
        '--jq',
        '{head_sha: .head.sha, merged_at: .merged_at}',
      ]),
      JSON.stringify({ head_sha: HEAD_SHA, merged_at: null }),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/commits/${HEAD_SHA}`,
        '--jq',
        '{commit_timestamp: .commit.committer.date}',
      ]),
      JSON.stringify({ commit_timestamp: '2026-07-31T00:00:00Z' }),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/issues/42/comments`,
        '--paginate',
        '--jq',
        '.[] | {timestamp: .created_at}',
      ]),
      ndjson([
        { timestamp: '2026-07-31T12:05:00Z' },
        { timestamp: '2026-07-31T12:10:00Z' },
      ]),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/pulls/42/reviews`,
        '--paginate',
        '--jq',
        '.[] | {timestamp: .submitted_at}',
      ]),
      '',
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/pulls/42/comments`,
        '--paginate',
        '--jq',
        '.[] | {timestamp: .created_at}',
      ]),
      '',
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/commits/${HEAD_SHA}/check-runs`,
        '--paginate',
        '--jq',
        '.check_runs[] | {status: .status, started_at: .started_at, completed_at: .completed_at}',
      ]),
      ndjson([
        { status: 'completed', completed_at: '2026-07-31T12:15:00Z' },
        { status: 'completed', completed_at: '2026-07-31T12:20:00Z' },
      ]),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/pulls/42`,
        '--jq',
        '{number: .number, title: .title, head_sha: .head.sha, html_url: .html_url}',
      ]),
      JSON.stringify({
        number: 42,
        title: 'sample',
        head_sha: HEAD_SHA,
        html_url: `https://github.com/${REPO_REF}/pull/42`,
      }),
    ],
  ]);

  const output = runStubbedCli(
    'scripts/stalled-session-quiet-check.mjs',
    [
      '--pr',
      '42',
      '--owner',
      OWNER,
      '--repo',
      REPO,
      '--now',
      '2026-07-31T12:30:00Z',
    ],
    responses,
  );

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  const report = JSON.parse(output) as {
    evidence: { activity_count_in_window: number };
  };
  // Both paginated comments (2) and both paginated check-runs (2) landed as
  // distinct activities, each from a 2-line NDJSON stub response with every
  // timestamp comfortably inside the quiet window (not boundary-adjacent) --
  // the pre-fix whole-stdout JSON.parse would have thrown on either 2-line
  // response before reaching this point.
  assert.equal(report.evidence.activity_count_in_window, 4);
});

test('review-activity-snapshot.mjs CLI: parses multi-line NDJSON output from paginated review/comment endpoints', () => {
  const responses = new Map<string, string>([
    [
      // #1833: review-activity-snapshot.mts now reads `author.login`
      // alongside `headRefOid` in this same call (no `--jq`, so the
      // response is the whole JSON object, not a bare SHA string).
      JSON.stringify([
        'pr',
        'view',
        '42',
        '-R',
        REPO_REF,
        '--json',
        'headRefOid,author',
      ]),
      JSON.stringify({ headRefOid: HEAD_SHA, author: { login: 'pr-author' } }),
    ],
    [
      // #2267: routed through provider-port.mts's listChangeRequestChecks
      // now -- `--repo` (not `-R`) and no trailing `--jq '.'` (a no-op
      // identity filter on the already-JSON `--json` array), but the same
      // underlying `gh pr checks` call.
      JSON.stringify([
        'pr',
        'checks',
        '42',
        '--repo',
        REPO_REF,
        '--json',
        'name,state,completedAt',
      ]),
      '[]',
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/pulls/42/reviews`,
        '--paginate',
        '--jq',
        '.[]',
      ]),
      ndjson([
        {
          user: { login: 'reviewer-one' },
          state: 'APPROVED',
          submitted_at: '2026-07-31T10:00:00Z',
        },
        {
          user: { login: 'reviewer-two' },
          state: 'COMMENTED',
          submitted_at: '2026-07-31T11:00:00Z',
        },
      ]),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/issues/42/comments`,
        '--paginate',
        '--jq',
        '.[]',
      ]),
      ndjson([
        {
          user: { login: 'commenter-one' },
          body: 'first',
          created_at: '2026-07-31T09:00:00Z',
        },
        {
          user: { login: 'commenter-two' },
          body: 'second',
          created_at: '2026-07-31T09:30:00Z',
        },
      ]),
    ],
  ]);

  const graphqlResponse = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  });

  const output = runStubbedCli(
    'scripts/review-activity-snapshot.mjs',
    ['--pr', '42', '--owner', OWNER, '--repo', REPO],
    responses,
    graphqlResponse,
  );

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  const report = JSON.parse(output) as {
    counts: { reviews: number; comments: number };
  };
  // Two reviews and two comments landed -- the pre-fix bare `--paginate`
  // (no `--jq '.[]'`) plus split('\n') is exactly this shape's failure
  // mode on gh versions where multi-page output isn't newline-separated.
  assert.equal(report.counts.reviews, 2);
  assert.equal(report.counts.comments, 2);
});

function claimApprovalGateResponses(timelineBody: string): Map<string, string> {
  return new Map<string, string>([
    [
      JSON.stringify(['api', `repos/${REPO_REF}/issues/7`]),
      JSON.stringify({
        number: 7,
        title: 'sample issue',
        state: 'open',
        html_url: `https://github.com/${REPO_REF}/issues/7`,
        user: { login: 'author-user' },
      }),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/issues/7/comments`,
        '--paginate',
        '--jq',
        '.[]',
      ]),
      ndjson([
        {
          user: { login: 'commenter-one' },
          body: 'first',
          created_at: '2026-07-31T09:00:00Z',
        },
        {
          user: { login: 'commenter-two' },
          body: 'second',
          created_at: '2026-07-31T09:30:00Z',
        },
      ]),
    ],
    [
      JSON.stringify([
        'api',
        `repos/${REPO_REF}/issues/7/timeline`,
        '-H',
        'Accept: application/vnd.github+json',
        '--paginate',
        '--jq',
        '.[]',
      ]),
      timelineBody,
    ],
  ]);
}

test('claim-approval-gate.mjs CLI: parses multi-line NDJSON comments and a clean timeline without a parse diagnostic', () => {
  const output = runStubbedCli(
    'scripts/claim-approval-gate.mjs',
    ['--issue', '7', '--owner', OWNER, '--repo', REPO],
    claimApprovalGateResponses(
      ndjson([{ event: 'labeled', created_at: '2026-07-31T08:00:00Z' }]),
    ),
  );

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  const report = JSON.parse(output) as {
    timelineAvailable: boolean;
    timelineParseError: string;
  };
  assert.equal(report.timelineAvailable, true);
  assert.equal(report.timelineParseError, '');
});

test('claim-approval-gate.mjs CLI: surfaces a malformed timeline response as a visible parseError instead of silently degrading', () => {
  const output = runStubbedCli(
    'scripts/claim-approval-gate.mjs',
    ['--issue', '7', '--owner', OWNER, '--repo', REPO],
    claimApprovalGateResponses('{not valid json'),
  );

  assert.doesNotMatch(output, /ReferenceError|before initialization/);
  const report = JSON.parse(output) as {
    timelineAvailable: boolean;
    timelineParseError: string;
  };
  assert.equal(report.timelineAvailable, false);
  assert.notEqual(report.timelineParseError, '');
});
