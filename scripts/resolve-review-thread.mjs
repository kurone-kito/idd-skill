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
} from './protocol-helpers.mjs';
/**
 * Find the review thread that owns the review comment whose REST database id is
 * `commentId`. The GraphQL `PullRequestReviewComment.databaseId` equals the REST
 * comment id, so the lookup is exact. Pure: takes already-fetched thread nodes
 * and returns the owning thread's node id plus its current resolution state, or
 * `null` when no thread contains that comment.
 */
export function findThreadForComment(threads, commentId) {
  for (const thread of Array.isArray(threads) ? threads : []) {
    const nodes = thread.comments?.nodes ?? [];
    for (const comment of nodes) {
      if (
        comment.databaseId !== null &&
        comment.databaseId !== undefined &&
        Number(comment.databaseId) === Number(commentId)
      ) {
        // The top-level review comment is the first node in the thread's
        // comments connection; the reply must target it, even when the request
        // named a later reply in the thread.
        const rootDatabaseId = nodes[0]?.databaseId;
        return {
          threadId: thread.id,
          isResolved: Boolean(thread.isResolved),
          rootCommentId:
            rootDatabaseId !== null && rootDatabaseId !== undefined
              ? Number(rootDatabaseId)
              : null,
        };
      }
    }
  }
  return null;
}
/**
 * Orchestrate the apply-mode mutation with injected side effects so the
 * reply→resolve sequencing is testable without the network. Revalidate the
 * active claim before **each** GitHub-side mutation (E13 requires a claim
 * revalidation before every reply/resolve side effect): the first check aborts
 * before the reply is posted, and the second aborts before the resolve if the
 * claim was released or handed off in the window between the two mutations.
 * Resolve only after the reply lands, so a failed reply never leaves a
 * silently-resolved thread with no disposition.
 */
export function applyResolveReviewThread(deps) {
  deps.assertClaim();
  const reply = deps.postReply();
  deps.assertClaim();
  deps.resolveThread();
  return { replyId: reply.id };
}
export function parseArgs(argv) {
  const args = {
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
  const splitList = (value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
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
function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}
function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}
/**
 * Fetch a paginated list endpoint as an array. `gh api --paginate` concatenates
 * one JSON array per page; `--jq '.[]'` flattens each page to one JSON value per
 * line (NDJSON), which we parse line-by-line (mirrors the sibling helpers).
 */
function ghJsonPaginated(args) {
  const out = execFileSync('gh', [...args, '--paginate', '--jq', '.[]'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
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
  return JSON.parse(
    execFileSync('gh', args, { encoding: 'utf8' }).trim() || '{}',
  );
}
/**
 * Throw when a GraphQL response carries top-level `errors`, so a bad
 * PR/repo/auth or any server-side GraphQL failure fails fast with a clear
 * message instead of being silently read as an empty result (which would
 * masquerade as "no review thread found").
 */
export function assertNoGraphqlErrors(payload, context) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(
      `${context} failed: ${errors
        .map((entry) => String(entry.message ?? ''))
        .filter(Boolean)
        .join('; ')
        .slice(0, 200)}`,
    );
  }
}
/**
 * Fetch every review thread of a PR (paginated), each with its node id,
 * resolution state, and member comment database ids — enough to map a REST
 * comment id to its owning thread. Both the threads connection **and** each
 * thread's nested comments connection are paginated to completion, so a target
 * comment buried past the first 100 replies in a deep thread still resolves.
 */
function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;
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
                comments(first: 100) {
                  pageInfo { hasNextPage endCursor }
                  nodes { databaseId }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, number: prNumber, cursor },
    );
    assertNoGraphqlErrors(payload, 'review thread lookup');
    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        if (!thread.id || !thread.comments.pageInfo.endCursor) {
          throw new Error(
            'review thread comment pagination payload is missing id or endCursor',
          );
        }
        thread.comments.nodes = [
          ...(thread.comments.nodes ?? []),
          ...fetchThreadCommentIds(
            thread.id,
            thread.comments.pageInfo.endCursor,
          ),
        ];
        thread.comments.pageInfo.hasNextPage = false;
      }
    }
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
/**
 * Page the remaining comment-id nodes of one review thread, starting after
 * `afterCursor`, until the connection is exhausted. Mirrors the sibling
 * snapshot helper's nested-comment pagination.
 */
function fetchThreadCommentIds(threadId, afterCursor) {
  const nodes = [];
  let cursor = afterCursor;
  while (cursor) {
    const payload = ghGraphql(
      `query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on PullRequestReviewThread {
            comments(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { databaseId }
            }
          }
        }
      }`,
      { id: threadId, cursor },
    );
    assertNoGraphqlErrors(payload, 'review thread comment pagination');
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
/** Post a reply to the review thread that owns `commentId` (REST). */
function postReply(owner, repo, pr, commentId, body) {
  return ghJson([
    'api',
    '--method',
    'POST',
    `repos/${owner}/${repo}/pulls/${pr}/comments/${commentId}/replies`,
    '-f',
    `body=${body}`,
  ]);
}
/** Resolve a review thread by its GraphQL node id, confirming the result. */
function resolveThread(threadId) {
  const payload = ghGraphql(
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  );
  assertNoGraphqlErrors(payload, 'resolveReviewThread');
  if (payload?.data?.resolveReviewThread?.thread?.isResolved !== true) {
    throw new Error(
      'resolveReviewThread returned without confirming thread.isResolved',
    );
  }
}
/**
 * Re-fetch the claim issue and return the active claim **owned by this session**
 * (its `claimId`, and `agentId` when supplied, match), or `null` when the claim
 * was lost. Scoped to trusted marker authors via the shared `resolveActiveClaim`
 * state machine, and fails closed (returns `null`) on any `forced-handoff`
 * marker that targets this claim. Aborting on a contested claim is always safe
 * (the manual E13 path remains). The returned `branch` lets the caller bind the
 * mutation to the PR whose head is that branch.
 */
function activeOwnedClaim(
  owner,
  repo,
  issue,
  agentId,
  claimId,
  isTrustedAuthor,
) {
  const comments = ghJsonPaginated([
    'api',
    `repos/${owner}/${repo}/issues/${issue}/comments`,
  ]);
  for (const comment of comments) {
    const forcedHandoff = parseForcedHandoffComment(
      comment.body ?? '',
      comment.created_at ?? '',
    );
    if (forcedHandoff && forcedHandoff.oldClaimId === claimId) {
      return null;
    }
  }
  const events = comments.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  }));
  const active = resolveActiveClaim(events, isTrustedAuthor);
  if (active?.claimId !== claimId) {
    return null;
  }
  if (agentId && active.agentId !== agentId) {
    return null;
  }
  return active;
}
function isMainModule(moduleUrl) {
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
  const pr = args.pr;
  const commentId = args.commentId;
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const match = findThreadForComment(
    fetchReviewThreads(owner, repo, pr),
    commentId,
  );
  const report = {
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
  // The reply targets the thread's top-level review comment, so a thread with
  // no exposed comment id cannot be replied to — fail closed before mutating.
  const rootCommentId = match.rootCommentId;
  if (rootCommentId === null) {
    report.status = 'failed';
    report.error = `review thread ${match.threadId} exposes no top-level comment id to reply to`;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
  // Bind the mutation to the claimed PR: the active claim's branch must be the
  // PR's head branch, so a valid claim on the issue cannot be used to reply to
  // and resolve a thread on some other PR passed as --pr.
  const prHeadRef = ghText([
    'api',
    `repos/${owner}/${repo}/pulls/${pr}`,
    '--jq',
    '.head.ref',
  ]);
  // --apply: default the trusted claim authors to this gh login so the
  // revalidation recognizes the session's own claim markers.
  const viewerLogin = ghText(['api', 'user', '--jq', '.login']).toLowerCase();
  const trustedAuthors = new Set(
    (args.trustedMarkerLogins.length > 0
      ? args.trustedMarkerLogins
      : [viewerLogin]
    ).map((login) => login.toLowerCase()),
  );
  const isTrustedAuthor = (login) =>
    trustedAuthors.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  // Retain the posted reply id across a later failure so a partial apply (reply
  // posted, resolve not confirmed) reports the reply id instead of looking like
  // nothing was posted — that distinguishes "retry the resolve" from "re-post".
  let postedReplyId;
  try {
    const result = applyResolveReviewThread({
      assertClaim: () => {
        const active = activeOwnedClaim(
          owner,
          repo,
          args.claimIssue,
          args.agentId,
          args.claimId,
          isTrustedAuthor,
        );
        if (!active) {
          throw new Error(
            `claim revalidation failed: "${args.claimId}" is no longer the active claim on issue #${args.claimIssue}`,
          );
        }
        if (active.branch !== prHeadRef) {
          throw new Error(
            `claim/PR mismatch: active claim branch "${active.branch}" does not match PR #${pr} head branch "${prHeadRef}"`,
          );
        }
      },
      postReply: () => {
        const posted = postReply(owner, repo, pr, rootCommentId, args.body);
        postedReplyId = posted.id;
        return posted;
      },
      resolveThread: () => resolveThread(match.threadId),
    });
    report.status = 'applied';
    report.replyId = result.replyId;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    report.status = 'failed';
    if (postedReplyId !== undefined) {
      report.replyId = postedReplyId;
    }
    report.error = error.message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
}
