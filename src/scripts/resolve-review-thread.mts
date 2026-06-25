#!/usr/bin/env node
// idd-generated-from: src/scripts/resolve-review-thread.mts
//
// The scripts/resolve-review-thread.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Perform the common E13 review-thread disposition in one invocation: post the
// reply comment to the thread that owns a review comment AND resolve that
// thread. This is the write-side companion to the read-side review helpers
// (`review-activity-snapshot`, `review-disposition-verify`). It follows the
// write-side helper family conventions: dry-run by default, `--apply` mutates
// and requires `--claim-issue` / `--claim-id` so the active claim is
// revalidated immediately before the reply is posted (fail-closed). Reply
// first, resolve second — a failed reply never leaves a silently-resolved
// thread with no disposition.

import { execFileSync } from 'node:child_process';

import {
  parseForcedHandoffComment,
  resolveActiveClaim,
} from './protocol-helpers.mts';

/** A review thread node from the GraphQL `reviewThreads` connection. */
export interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments?: { nodes?: { databaseId?: number | null }[] | null } | null;
}

/** The thread that owns the requested review comment. */
export interface ThreadMatch {
  threadId: string;
  isResolved: boolean;
}

/** The CLI output envelope for both `dry-run` and `--apply` modes. */
export interface ResolveReviewThreadReport {
  mode: 'dry-run' | 'apply';
  prNumber: number;
  commentId: number;
  /** Omitted when no review thread owns the comment. */
  threadId?: string;
  alreadyResolved: boolean;
  status?: 'applied' | 'failed';
  replyId?: number;
  error?: string;
}

/**
 * Find the review thread that owns the review comment whose REST database id is
 * `commentId`. The GraphQL `PullRequestReviewComment.databaseId` equals the REST
 * comment id, so the lookup is exact. Pure: takes already-fetched thread nodes
 * and returns the owning thread's node id plus its current resolution state, or
 * `null` when no thread contains that comment.
 */
export function findThreadForComment(
  threads: ReviewThreadNode[],
  commentId: number,
): ThreadMatch | null {
  for (const thread of Array.isArray(threads) ? threads : []) {
    for (const comment of thread.comments?.nodes ?? []) {
      if (
        comment.databaseId !== null &&
        comment.databaseId !== undefined &&
        Number(comment.databaseId) === Number(commentId)
      ) {
        return { threadId: thread.id, isResolved: Boolean(thread.isResolved) };
      }
    }
  }
  return null;
}

/**
 * Orchestrate the apply-mode mutation with injected side effects so the
 * reply→resolve sequencing is testable without the network. Revalidate the
 * active claim first; a thrown claim check aborts before the reply is posted.
 * Resolve only after the reply lands, so a failed reply never leaves a
 * silently-resolved thread with no disposition.
 */
export function applyResolveReviewThread(deps: {
  assertClaim: () => void;
  postReply: () => { id: number };
  resolveThread: () => void;
}): { replyId: number } {
  deps.assertClaim();
  const reply = deps.postReply();
  deps.resolveThread();
  return { replyId: reply.id };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  pr: number | null;
  commentId: number | null;
  body: string;
  owner: string;
  repo: string;
  claimIssue: number | null;
  claimId: string;
  agentId: string;
  trustedMarkerLogins: string[];
  apply: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    pr: null,
    commentId: null,
    body: '',
    owner: '',
    repo: '',
    claimIssue: null,
    claimId: '',
    agentId: '',
    trustedMarkerLogins: [],
    apply: false,
    help: false,
  };
  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      index += 1;
      return argv[index] ?? '';
    };
    switch (flag) {
      case '--pr':
        args.pr = Number.parseInt(next(), 10);
        break;
      case '--comment-id':
        args.commentId = Number.parseInt(next(), 10);
        break;
      case '--body':
        args.body = next();
        break;
      case '--owner':
        args.owner = next();
        break;
      case '--repo':
        args.repo = next();
        break;
      case '--claim-issue':
        args.claimIssue = Number.parseInt(next(), 10);
        break;
      case '--claim-id':
        args.claimId = next();
        break;
      case '--agent-id':
        args.agentId = next();
        break;
      case '--trusted-marker-logins':
        args.trustedMarkerLogins = splitList(next());
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const USAGE = `usage: node scripts/resolve-review-thread.mjs --pr <number> --comment-id <id> [options]

Post a reply to the review thread that owns <comment-id> and resolve that
thread in one invocation (E13). Dry-run by default; --apply mutates.

  --pr <number>                  PR number (required)
  --comment-id <id>              review comment REST id whose thread to resolve (required)
  --body <text>                  reply body (required with --apply)
  --owner <owner>                repo owner (default: gh repo view)
  --repo <repo>                  repo name (default: gh repo view)
  --claim-issue <number>         issue carrying the active claim (required with --apply)
  --claim-id <claim-id>          active claim id to re-validate (required with --apply)
  --agent-id <agent-id>          current session agent id (optional, tightens the claim check)
  --trusted-marker-logins a,b    logins whose claim markers are trusted
                                 (default: your gh login)
  --apply                        post the reply and resolve the thread (default: dry-run)
  -h, --help                     show this help
`;

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function ghJson(args: string[]): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

/**
 * Fetch a paginated list endpoint as an array. `gh api --paginate` concatenates
 * one JSON array per page; `--jq '.[]'` flattens each page to one JSON value per
 * line (NDJSON), which we parse line-by-line (mirrors the sibling helpers).
 */
function ghJsonPaginated(args: string[]): unknown[] {
  const out = execFileSync('gh', [...args, '--paginate', '--jq', '.[]'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

function ghGraphql(
  query: string,
  variables: Record<string, string | number | null | undefined>,
): unknown {
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
  return JSON.parse(
    execFileSync('gh', args, { encoding: 'utf8' }).trim() || '{}',
  );
}

interface ReviewThreadsConnectionPayload {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: ReviewThreadNode[] | null;
}

/**
 * Fetch every review thread of a PR (paginated), each with its node id,
 * resolution state, and member comment database ids — enough to map a REST
 * comment id to its owning thread. Each thread's comments are read up to the
 * first 100, which covers the disposition target (the thread's root or an early
 * reply) in practice; a comment buried past 100 in one thread would not match.
 */
function fetchReviewThreads(
  owner: string,
  repo: string,
  prNumber: number,
): ReviewThreadNode[] {
  const nodes: ReviewThreadNode[] = [];
  let cursor: string | null | undefined = null;
  while (true) {
    const payload = ghGraphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                comments(first: 100) { nodes { databaseId } }
              }
            }
          }
        }
      }`,
      { owner, repo, number: prNumber, cursor },
    ) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: ReviewThreadsConnectionPayload | null;
          } | null;
        } | null;
      } | null;
    };
    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    nodes.push(...(reviewThreads?.nodes ?? []));
    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    if (!reviewThreads.pageInfo.endCursor) {
      throw new Error('review thread pagination payload is missing endCursor');
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }
  return nodes;
}

/** Post a reply to the review thread that owns `commentId` (REST). */
function postReply(
  owner: string,
  repo: string,
  pr: number,
  commentId: number,
  body: string,
): { id: number } {
  return ghJson([
    'api',
    '--method',
    'POST',
    `repos/${owner}/${repo}/pulls/${pr}/comments/${commentId}/replies`,
    '-f',
    `body=${body}`,
  ]) as { id: number };
}

/** Resolve a review thread by its GraphQL node id, confirming the result. */
function resolveThread(threadId: string): void {
  const payload = ghGraphql(
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  ) as {
    errors?: { message?: unknown }[];
    data?: { resolveReviewThread?: { thread?: { isResolved?: unknown } } };
  };
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `resolveReviewThread failed: ${payload.errors
        .map((entry) => String(entry.message ?? ''))
        .filter(Boolean)
        .join('; ')
        .slice(0, 200)}`,
    );
  }
  if (payload?.data?.resolveReviewThread?.thread?.isResolved !== true) {
    throw new Error(
      'resolveReviewThread returned without confirming thread.isResolved',
    );
  }
}

/**
 * Re-fetch the claim issue and decide whether `claimId` is still the active
 * claim. Scoped to trusted marker authors via the shared `resolveActiveClaim`
 * state machine, and fails closed on any `forced-handoff` marker that targets
 * this claim. Aborting on a contested claim is always safe (the manual E13 path
 * remains).
 */
function claimStillActive(
  owner: string,
  repo: string,
  issue: number,
  agentId: string,
  claimId: string,
  isTrustedAuthor: (login: string) => boolean,
): boolean {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]) as { body?: string; created_at?: string; user?: { login?: string } }[];
  for (const comment of comments) {
    const forcedHandoff = parseForcedHandoffComment(
      comment.body ?? '',
      comment.created_at ?? '',
    );
    if (forcedHandoff && forcedHandoff.oldClaimId === claimId) {
      return false;
    }
  }
  const events = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  const active = resolveActiveClaim(events, isTrustedAuthor);
  if (active?.claimId !== claimId) {
    return false;
  }
  return agentId ? active.agentId === agentId : true;
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return moduleUrl === `file://${entry}` || moduleUrl.endsWith(entry);
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.help ||
    !Number.isInteger(args.pr) ||
    (args.pr ?? 0) <= 0 ||
    !Number.isInteger(args.commentId) ||
    (args.commentId ?? 0) <= 0
  ) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  // Fail closed: --apply mutates PR state, so the active-claim revalidation and
  // a reply body are mandatory. Missing inputs must abort before any read or
  // write rather than silently bypassing the gate.
  if (
    args.apply &&
    (!Number.isInteger(args.claimIssue) ||
      (args.claimIssue ?? 0) <= 0 ||
      !args.claimId ||
      !args.body)
  ) {
    process.stderr.write(
      '--apply requires --body and the --claim-issue / --claim-id pair for the mandatory claim revalidation\n',
    );
    process.exit(1);
  }
  const pr = args.pr as number;
  const commentId = args.commentId as number;
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  const match = findThreadForComment(
    fetchReviewThreads(owner, repo, pr),
    commentId,
  );

  const report: ResolveReviewThreadReport = {
    mode: args.apply ? 'apply' : 'dry-run',
    prNumber: pr,
    commentId,
    ...(match ? { threadId: match.threadId } : {}),
    alreadyResolved: match?.isResolved ?? false,
  };

  if (!match) {
    report.error = `no review thread found for comment ${commentId} on PR #${pr}`;
    if (args.apply) {
      report.status = 'failed';
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // A missing thread is informational in dry-run but a hard failure in apply.
    process.exit(args.apply ? 1 : 0);
  }

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }

  // --apply: default the trusted claim authors to this gh login so the
  // revalidation recognizes the session's own claim markers.
  const viewerLogin = ghText(['api', 'user', '--jq', '.login']).toLowerCase();
  const trustedAuthors = new Set(
    (args.trustedMarkerLogins.length > 0
      ? args.trustedMarkerLogins
      : [viewerLogin]
    ).map((login) => login.toLowerCase()),
  );
  const isTrustedAuthor = (login: string): boolean =>
    trustedAuthors.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );

  try {
    const result = applyResolveReviewThread({
      assertClaim: () => {
        if (
          !claimStillActive(
            owner,
            repo,
            args.claimIssue as number,
            args.agentId,
            args.claimId,
            isTrustedAuthor,
          )
        ) {
          throw new Error(
            `claim revalidation failed: "${args.claimId}" is no longer the active claim on issue #${args.claimIssue}`,
          );
        }
      },
      postReply: () => postReply(owner, repo, pr, commentId, args.body),
      resolveThread: () => resolveThread(match.threadId),
    });
    report.status = 'applied';
    report.replyId = result.replyId;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    report.status = 'failed';
    report.error = (error as Error).message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
}
