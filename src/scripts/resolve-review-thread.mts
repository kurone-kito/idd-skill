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
// revalidated immediately before the reply is posted (fail-closed) --
// unless `--claimless` (#2616) opts out for a PR with no linked issue to
// claim against, mirroring `pre-merge-readiness.mjs`'s identical `--claimless`
// (#2017). Reply first, resolve second — a failed reply never leaves a
// silently-resolved thread with no disposition.

import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { loadIddConfig } from './idd-config.mts';
import { appendReviewReplyStamp } from './marker-helpers.mts';
import {
  isDispositionComment,
  isRejectionConfirmedDisposition,
  type ParsedClaimMarker,
  resolveActiveClaimForWriteGate,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderPort,
  ProviderReviewThreadCommentIds,
} from './provider-port.mts';

/** A comment-id page within a review thread's `comments` connection. */
interface ThreadCommentsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: { databaseId?: number | null }[] | null;
}

/** A review thread node from the GraphQL `reviewThreads` connection. */
export interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments?: ThreadCommentsConnection | null;
}

/** The thread that owns the requested review comment. */
export interface ThreadMatch {
  threadId: string;
  isResolved: boolean;
  /**
   * REST database id of the thread's **top-level** review comment. The reply is
   * posted against this id (not the requested `--comment-id`), because GitHub's
   * create-reply endpoint requires a top-level review comment — replies to
   * replies are unsupported. `null` when the thread exposes no comment id.
   */
  rootCommentId: number | null;
}

/** The CLI output envelope for both `dry-run` and `--apply` modes. */
export interface ResolveReviewThreadReport {
  mode: 'dry-run' | 'apply';
  prNumber: number;
  commentId: number;
  /** Omitted when no review thread owns the comment. */
  threadId?: string;
  alreadyResolved: boolean;
  /**
   * Reply body that will be posted (dry-run) or was posted (apply),
   * including the injected reply-identity stamp. Omitted when `--body`
   * is empty.
   */
  body?: string;
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
export function applyResolveReviewThread(deps: {
  assertClaim: () => void;
  postReply: () => { id: number };
  resolveThread: () => void;
}): { replyId: number } {
  deps.assertClaim();
  const reply = deps.postReply();
  deps.assertClaim();
  deps.resolveThread();
  return { replyId: reply.id };
}

/** The three marker forms `--apply` accepts, for use in error messages. */
export const ACCEPTED_DISPOSITION_MARKERS =
  '**Accepted**, **Rejected**, or **Rejection confirmed by maintainer** —';

/**
 * True when `body` starts with one of the marker prefixes
 * `hasFreshDisposition` (`protocol-helpers.mts`) recognizes as a
 * disposition. Reuses `isDispositionComment` /
 * `isRejectionConfirmedDisposition` directly so this posting-time check
 * and the later merge-gate check can never drift out of sync
 * (idd-skill#2005). Has no network dependency, so the CLI can call it
 * before resolving `owner`/`repo` or looking up the thread — a malformed
 * `--body` then fails closed without posting anything.
 *
 * Deliberately does NOT gate the `**Rejection confirmed by maintainer**`
 * form on the target thread's *pre*-mutation resolution state.
 * `isRejectionConfirmedDisposition`'s resolved-thread scoping inside
 * `hasFreshDisposition` is evaluated later, by a downstream gate, against
 * the thread's state *at that later evaluation time* — and
 * `applyResolveReviewThread` below unconditionally resolves whatever
 * thread it replies to, so a successful `--apply` call always leaves the
 * thread resolved by the time any downstream gate looks at it, regardless
 * of whether it was already resolved beforehand. The primary documented
 * use of this exact marker (`idd-review-triage.instructions.md`'s AMD
 * "maintainer agrees" transition) posts it on a thread that is still
 * *unresolved* at call time by design, precisely because this call is
 * what resolves it — an earlier revision of this check required
 * pre-mutation resolution and would have rejected that call outright
 * (caught by a Codex review on this PR).
 */
export function hasKnownDispositionMarkerPrefix(body: string): boolean {
  const comment = { body };
  return (
    isDispositionComment(comment) || isRejectionConfirmedDisposition(comment)
  );
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
  claimless: boolean;
  apply: boolean;
  help: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const RESOLVE_REVIEW_THREAD_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--comment-id': { type: 'string' },
  '--body': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--claim-issue': { type: 'string' },
  '--claim-id': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--claimless': { type: 'boolean', default: false },
  '--apply': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * absent resolves to `null` (the original `pr: null` / `claimIssue: null`
 * default, never overwritten when the flag is absent); present feeds the
 * raw token straight to `Number.parseInt`, which accepts trailing-garbage
 * ("42abc" -> 42) and leading-zero ("007" -> 7) tokens the same way the
 * original hand-rolled `Number.parseInt(next(), 10)` always did.
 * `cli-args.mts`'s `parseCanonicalIntegerOrNull` is a poor substitute here:
 * its canonical-pattern regex rejects those same tokens outright, which is
 * a real contract change a CodeRabbit review on PR #1466 caught -- #1450's
 * acceptance criteria protect the post-parse integer contract as-is, only
 * flag *syntax* (missing/flag-shaped values, unknown flags) is meant to
 * tighten. The downstream `!Number.isInteger(...) || (... ?? 0) <= 0`
 * guards below already treat `NaN` (an invalid parseInt result) the same
 * as `null`, so this restores the exact original resolved value, not just
 * an equivalent downstream verdict.
 */
function parseLenientIntegerOrNull(token: string | undefined): number | null {
  return token === undefined ? null : Number.parseInt(token, 10);
}

export function parseArgs(argv: string[]): CliArgs {
  const { values, help } = parseCliArgs(argv, RESOLVE_REVIEW_THREAD_FLAG_SPEC);
  return {
    pr: parseLenientIntegerOrNull(values.pr as string | undefined),
    commentId: parseLenientIntegerOrNull(
      values['comment-id'] as string | undefined,
    ),
    body: values.body as string,
    owner: values.owner as string,
    repo: values.repo as string,
    claimIssue: parseLenientIntegerOrNull(
      values['claim-issue'] as string | undefined,
    ),
    claimId: values['claim-id'] as string,
    agentId: values['agent-id'] as string,
    trustedMarkerLogins: splitList(values['trusted-marker-logins'] as string),
    claimless: values.claimless as boolean,
    apply: values.apply as boolean,
    help,
  };
}

const USAGE = `usage: node scripts/resolve-review-thread.mjs --pr <number> --comment-id <id> [options]

Post a reply to the review thread that owns <comment-id> and resolve that
thread in one invocation (E13). Dry-run by default; --apply mutates.

  --pr <number>                  PR number (required)
  --comment-id <id>              review comment REST id whose thread to resolve (required)
  --body <text>                  reply body (required with --apply; with --apply, must start
                                 with **Accepted**, **Rejected**, or
                                 **Rejection confirmed by maintainer** —; the helper
                                 appends the reply-identity stamp)
  --owner <owner>                repo owner (default: gh repo view)
  --repo <repo>                  repo name (default: gh repo view)
  --claim-issue <number>         issue carrying the active claim (required with --apply, unless --claimless)
  --claim-id <claim-id>          active claim id to re-validate (required with --apply, unless --claimless)
  --agent-id <agent-id>          current session agent id (optional, tightens the claim check)
  --trusted-marker-logins a,b    logins whose claim markers are trusted
                                 (default: your gh login)
  --claimless                    skip claim fetch/revalidation (#2616). Only for a PR with
                                 no closingIssuesReferences; cannot combine with
                                 --claim-issue / --claim-id
  --apply                        post the reply and resolve the thread (default: dry-run)
  -h, --help                     show this help
`;

/**
 * Throw when a GraphQL response carries top-level `errors`, so a bad
 * PR/repo/auth or any server-side GraphQL failure fails fast with a clear
 * message instead of being silently read as an empty result (which would
 * masquerade as "no review thread found").
 */
export function assertNoGraphqlErrors(payload: unknown, context: string): void {
  const errors = (payload as { errors?: { message?: unknown }[] } | null)
    ?.errors;
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
 * Map {@link ProviderPort.listChangeRequestReviewThreadCommentIds}'s flat
 * `commentDatabaseIds` shape onto this file's existing, independently-tested
 * {@link ReviewThreadNode}/{@link findThreadForComment} contract, rather than
 * changing that pure function's signature.
 */
function toReviewThreadNodes(
  threads: ProviderReviewThreadCommentIds[],
): ReviewThreadNode[] {
  return threads.map((thread) => ({
    id: thread.threadId,
    isResolved: Boolean(thread.isResolved),
    comments: {
      nodes: thread.commentDatabaseIds.map((databaseId) => ({ databaseId })),
    },
  }));
}

/** Forced-handoff revalidation inputs, resolved once per CLI invocation. */
interface ForcedHandoffGateOptions {
  forcedHandoffEnabled: boolean;
  isAuthorizedForcedHandoff: (forcedBy: string) => boolean;
}

/**
 * Re-fetch the claim issue and return the active claim **owned by this session**
 * (its `claimId`, and `agentId` when supplied, match), or `null` when the claim
 * was lost. Scoped to trusted marker authors via the shared
 * `resolveActiveClaimForWriteGate` state machine. A forced-handoff marker is
 * honored only when it is an operator-approved, authorized handoff
 * (forced-handoff mode enabled, `forced-by` is an authorized maintainer, and
 * the comment author matches `forced-by`); otherwise the original claim stays
 * active and an unauthorized/forged successor's `--claim-id` still fails the
 * ownership comparison below. This is an issue-scoped revalidation
 * (`expectedLinkedPrs: null`), so a legitimate issue-only handoff is accepted.
 * Aborting on a contested claim is always safe (the manual E13 path remains).
 * The returned `branch` lets the caller bind the mutation to the PR whose head
 * is that branch.
 */
function activeOwnedClaim(
  port: ProviderPort,
  issue: number,
  agentId: string,
  claimId: string,
  isTrustedAuthor: (login: string) => boolean,
  forcedHandoffOptions: ForcedHandoffGateOptions,
): ParsedClaimMarker | null {
  const comments = port.listWorkItemComments(issue);
  const events = comments.map((comment) => ({
    body: comment.body,
    createdAt: comment.createdAt,
    author: { login: comment.authorLogin },
  }));
  const active = resolveActiveClaimForWriteGate(events, {
    isTrustedAuthor,
    forcedHandoffEnabled: forcedHandoffOptions.forcedHandoffEnabled,
    // Issue-scoped revalidation: accept a legitimate issue-only handoff.
    expectedLinkedPrs: null,
    isAuthorizedForcedHandoff: (forcedBy) =>
      forcedHandoffOptions.isAuthorizedForcedHandoff(forcedBy),
    requireAuthorMatchesForcedBy: true,
  });
  if (active?.claimId !== claimId) {
    return null;
  }
  if (agentId && active.agentId !== agentId) {
    return null;
  }
  return active;
}

if (import.meta.main) {
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
  // #2616: --claimless (mirroring pre-merge-readiness.mjs's #2017 flag)
  // is mutually exclusive with --claim-issue / --claim-id -- both name
  // the same "which ownership check applies" decision, so combining
  // them is always a caller mistake, never a stricter intersection.
  if (args.claimless && (Number.isInteger(args.claimIssue) || args.claimId)) {
    process.stderr.write(
      '--claimless cannot be combined with --claim-issue or --claim-id\n',
    );
    process.exit(1);
  }
  // Fail closed: --apply mutates PR state, so a reply body is always
  // mandatory, and the active-claim revalidation is mandatory unless
  // --claimless opts out of it. Missing inputs must abort before any
  // read or write rather than silently bypassing the gate.
  if (args.apply && !args.body) {
    process.stderr.write('--apply requires --body\n');
    process.exit(1);
  }
  if (
    args.apply &&
    !args.claimless &&
    (!Number.isInteger(args.claimIssue) ||
      (args.claimIssue ?? 0) <= 0 ||
      !args.claimId)
  ) {
    process.stderr.write(
      '--apply requires the --claim-issue / --claim-id pair for the mandatory claim revalidation, or --claimless\n',
    );
    process.exit(1);
  }
  // Fail closed before any network call: --apply must never post a --body
  // the F2/F3 disposition-evidence gate (hasFreshDisposition) won't
  // recognize as a disposition (idd-skill#2005). See
  // hasKnownDispositionMarkerPrefix's own doc comment for why this does
  // not separately gate the "Rejection confirmed by maintainer" form on
  // the thread's pre-mutation resolution state.
  if (args.apply && !hasKnownDispositionMarkerPrefix(args.body)) {
    process.stderr.write(
      `--apply requires --body to start with one of the accepted disposition markers: ${ACCEPTED_DISPOSITION_MARKERS}\n`,
    );
    process.exit(1);
  }
  const pr = args.pr as number;
  const commentId = args.commentId as number;
  const markerPrefixRaw = loadIddConfig()?.markerPrefix;
  // `--body` is optional in dry-run. `parseCliArgs` defaults it to '', but
  // coerce anyway so a missing value cannot throw on `.trim()` before the
  // report is written.
  const rawBody = typeof args.body === 'string' ? args.body : '';
  const stampedBody = rawBody.trim()
    ? appendReviewReplyStamp(
        rawBody,
        typeof markerPrefixRaw === 'string' ? markerPrefixRaw : undefined,
      )
    : '';
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);

  // #2616: mirror pre-merge-readiness.mjs's #2017 scoping rule --
  // --claimless is only for a PR with no linked issue to claim against.
  // A PR with closingIssuesReferences has one (or more): use
  // --claim-issue instead so the claim revalidation gate still applies.
  if (args.claimless) {
    const closingRefs =
      port.getChangeRequestConvergenceView(pr).closingIssuesReferences;
    if (Array.isArray(closingRefs) && closingRefs.length > 0) {
      process.stderr.write(
        '--claimless requires a PR with no closingIssuesReferences; pass --claim-issue instead\n',
      );
      process.exit(1);
    }
  }

  const match = findThreadForComment(
    toReviewThreadNodes(port.listChangeRequestReviewThreadCommentIds(pr)),
    commentId,
  );

  const report: ResolveReviewThreadReport = {
    mode: args.apply ? 'apply' : 'dry-run',
    prNumber: pr,
    commentId,
    ...(match ? { threadId: match.threadId } : {}),
    alreadyResolved: match?.isResolved ?? false,
    ...(stampedBody ? { body: stampedBody } : {}),
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
  const prHeadRef = port.getChangeRequestHeadRef(pr);

  // --apply: default the trusted claim authors to this gh login so the
  // revalidation recognizes the session's own claim markers.
  const viewerLogin = port.resolveViewerLogin().toLowerCase();
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

  // Resolve the forced-handoff policy and build the collaborator-permission
  // cache ONCE per CLI invocation (not on each assertClaim retry): re-reading
  // .github/idd/config.json and re-hitting the collaborators API would be a
  // needless I/O hot path. Mirrors force-handoff.mjs and the audit-pr-cleanup
  // readActiveClaim comment.
  const forcedHandoffEnabled = readForcedHandoffMode() === 'human-gated';
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const forcedHandoffPermissionCache: CollaboratorPermissionCache = new Map();
  const forcedHandoffOptions: ForcedHandoffGateOptions = {
    forcedHandoffEnabled,
    isAuthorizedForcedHandoff: (forcedBy) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        forcedHandoffPermissionCache,
      ),
  };

  // Retain the posted reply id across a later failure so a partial apply (reply
  // posted, resolve not confirmed) reports the reply id instead of looking like
  // nothing was posted — that distinguishes "retry the resolve" from "re-post".
  let postedReplyId: number | undefined;
  try {
    const result = applyResolveReviewThread({
      assertClaim: () => {
        // #2616: --claimless intentionally skips claim revalidation --
        // the scoping check above already confirmed this PR has no
        // linked issue to own a claim.
        if (args.claimless) {
          return;
        }
        const active = activeOwnedClaim(
          port,
          args.claimIssue as number,
          args.agentId,
          args.claimId,
          isTrustedAuthor,
          forcedHandoffOptions,
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
        const posted = port.postReviewCommentReply(
          pr,
          rootCommentId,
          stampedBody,
        );
        postedReplyId = posted.id;
        return posted;
      },
      resolveThread: () =>
        port.resolveChangeRequestReviewThread(match.threadId),
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
    report.error = (error as Error).message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
}
