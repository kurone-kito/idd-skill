#!/usr/bin/env node
// idd-generated-from: src/scripts/review-activity-snapshot.mts
//
// The scripts/review-activity-snapshot.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { parseCliArgs } from './cli-args.mjs';
import { ghText } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  buildActivitySnapshotSummary,
  resolveAdvisoryBotLogins,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls main() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const REVIEW_ACTIVITY_SNAPSHOT_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--advisory-bot-logins': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  main();
}
// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const iddConfig = loadIddConfig();
  const { actors: trustedMarkerLogins, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: iddConfig,
    });
  const { logins: advisoryBotLogins, source: advisoryBotLoginsSource } =
    resolveAdvisoryBotLogins({
      flagValue: args.advisoryBotLogins,
      envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
      config: iddConfig,
    });
  const headSha = ghText([
    'pr',
    'view',
    String(args.prNumber),
    '-R',
    repoRef,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]);
  const checks = ghJson(
    [
      'pr',
      'checks',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'name,state,completedAt',
      '--jq',
      '.',
    ],
    { allowStatuses: [1, 8] },
  );
  const reviews = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
    true,
  );
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  );
  const threads = fetchReviewThreads(owner, repo, args.prNumber);
  const summary = buildActivitySnapshotSummary(
    {
      comments: comments.map(normalizeComment),
      reviews: reviews.map(normalizeReview),
      threads: threads.map(normalizeThread),
      checks,
    },
    {
      trustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      // Advisory bots are excluded from disposition authorship inside the
      // summary builder, so the trusted-marker set is a safe default here.
      dispositionAuthorLogins: trustedMarkerLogins,
    },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        headSha,
        trustedMarkerActors: trustedMarkerLogins,
        trustedMarkerActorsSource,
        totalItemCount: summary.totalItemCount,
        maxActivityUpdatedAt: summary.maxActivityUpdatedAt,
        latestCiCompletedAt: summary.latestCiCompletedAt,
        latestPassingCiCompletedAt: summary.latestPassingCiCompletedAt,
        counts: summary.counts,
        ackOnly: summary.ackOnly,
        effective: summary.effective,
      },
      null,
      2,
    )}\n`,
  );
}
/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * `Number.parseInt` accepts trailing-garbage ("42abc" -> 42) and
 * leading-zero ("007" -> 7) tokens the same way the original hand-rolled
 * `Number.parseInt(value ?? '', 10)` always did, then the original's own
 * `!Number.isInteger(...) || (... ?? 0) < 1` post-check collapses an
 * invalid or absent value to `null`. `cli-args.mts`'s
 * `parseCanonicalIntegerOrNull` is a poor substitute: its canonical-pattern
 * regex rejects those same permissive tokens outright, which is a real
 * contract change a CodeRabbit review on PR #1466 caught -- #1450's
 * acceptance criteria protect the post-parse integer contract as-is, only
 * flag *syntax* (missing/flag-shaped values, unknown flags) is meant to
 * tighten.
 */
function parseLenientPositiveIntegerOrNull(token) {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    REVIEW_ACTIVITY_SNAPSHOT_FLAG_SPEC,
  );
  return {
    prNumber: parseLenientPositiveIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    trustedMarkerLogins: values['trusted-marker-logins'],
    advisoryBotLogins: values['advisory-bot-logins'],
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/review-activity-snapshot.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>]
`);
}
function normalizeComment(comment) {
  return {
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    updatedAt: comment.updated_at ?? comment.created_at ?? '',
  };
}
function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}
function normalizeThread(thread) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    comments: {
      pageInfo: {
        hasNextPage: Boolean(thread.comments?.pageInfo?.hasNextPage),
      },
      nodes: (thread.comments?.nodes ?? []).map((comment) => ({
        author: { login: comment.author?.login ?? '' },
        body: comment.body ?? '',
        createdAt: comment.createdAt ?? '',
        updatedAt: comment.updatedAt ?? comment.createdAt ?? '',
        pullRequestReview: { id: comment.pullRequestReview?.id ?? null },
      })),
    },
  };
}
function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;
  while (true) {
    const payload = ghGraphql(
      `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      body
                      createdAt
                      updatedAt
                      author { login }
                      pullRequestReview { id }
                    }
                  }
                }
              }
            }
          }
        }`,
      {
        owner,
        repo,
        number: Number.parseInt(String(prNumber), 10),
        cursor,
      },
    );
    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        // hasNextPage with a missing thread id or cursor is a malformed
        // payload; fail fast with a clear message instead of a confusing
        // GraphQL error or a silently truncated thread.
        if (!thread.id || !thread.comments.pageInfo.endCursor) {
          throw new Error(
            'review thread pagination payload is missing id or endCursor',
          );
        }
        thread.comments.nodes.push(
          ...fetchThreadCommentPages(
            thread.id,
            thread.comments.pageInfo.endCursor,
          ),
        );
        thread.comments.pageInfo.hasNextPage = false;
      }
    }
    nodes.push(...(reviewThreads?.nodes ?? []));
    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    // hasNextPage with a missing cursor would re-fetch the first page
    // forever; fail fast on the malformed payload instead.
    if (!reviewThreads.pageInfo.endCursor) {
      throw new Error('review thread pagination payload is missing endCursor');
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }
  return nodes;
}
function fetchThreadCommentPages(threadId, afterCursor) {
  const nodes = [];
  let cursor = afterCursor;
  while (cursor) {
    const payload = ghGraphql(
      `
        query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  body
                  createdAt
                  updatedAt
                  author { login }
                  pullRequestReview { id }
                }
              }
            }
          }
        }`,
      { id: threadId, cursor },
    );
    const comments = payload?.data?.node?.comments;
    nodes.push(...(comments?.nodes ?? []));
    if (comments?.pageInfo?.hasNextPage && !comments.pageInfo.endCursor) {
      throw new Error('thread comment pagination payload is missing endCursor');
    }
    cursor = comments?.pageInfo?.hasNextPage
      ? comments.pageInfo.endCursor
      : null;
  }
  return nodes;
}
function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'number') {
      args.push('-F', `${key}=${value}`);
      continue;
    }
    args.push('-f', `${key}=${value}`);
  }
  return JSON.parse(runGh(args).trim() || '{}');
}
function ghJson(args, options = {}) {
  return JSON.parse(runGh(args, options).trim() || '[]');
}
function ghApiJson(path, paginate = false, fields = null) {
  const args = ['api', path];
  if (paginate) {
    args.push('--paginate');
  }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      args.push(
        '-f',
        `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
      );
    }
  }
  const raw = runGh(args).trim();
  if (!raw) {
    return [];
  }
  if (paginate) {
    const chunks = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return chunks.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]));
  }
  return JSON.parse(raw);
}
function runGh(args, options = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' });
  } catch (error) {
    const status = Number(error?.status ?? -1);
    if ((options.allowStatuses ?? []).includes(status)) {
      const stdout = String(error?.stdout ?? '');
      if (/^\s*[[{]/.test(stdout)) {
        return stdout;
      }
    }
    throw error;
  }
}
