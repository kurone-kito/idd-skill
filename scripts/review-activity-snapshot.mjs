#!/usr/bin/env node
// idd-generated-from: src/scripts/review-activity-snapshot.mts
//
// The scripts/review-activity-snapshot.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { ghText, isCliExecution } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  buildActivitySnapshotSummary,
  resolveAdvisoryBotLogins,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mjs';

if (isCliExecution(import.meta.url)) {
  main();
}
// The CLI body. Guarded behind isCliExecution(import.meta.url) (shared,
// see gh-exec.mts) so importing this module (for unit tests) does not
// parse process.argv, fail, or make a `gh` call.
function main() {
  const args = parseArgs(process.argv.slice(2));
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
function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    owner: '',
    repo: '',
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--pr') {
      parsed.prNumber = Number.parseInt(value ?? '', 10);
      index += 1;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--trusted-marker-logins') {
      parsed.trustedMarkerLogins = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--advisory-bot-logins') {
      parsed.advisoryBotLogins = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }
  return parsed;
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
