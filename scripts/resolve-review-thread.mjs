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
import { writeSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  buildHelperErrorEnvelope,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { appendReviewReplyStamp } from './marker-helpers.mjs';
import {
  classifyPrLoopMembership,
  isDispositionComment,
  isRejectionConfirmedDisposition,
  normalizeTrustedMarkerLogins,
  readClaimStaleAgeMs,
  resolveActiveClaim,
  resolveActiveClaimForWriteGate,
  resolveClosingIssueNumbersForClassifier,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';
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
export function hasKnownDispositionMarkerPrefix(body) {
  const comment = { body };
  return (
    isDispositionComment(comment) || isRejectionConfirmedDisposition(comment)
  );
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
};
function splitList(value) {
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
function parseLenientIntegerOrNull(token) {
  return token === undefined ? null : Number.parseInt(token, 10);
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, RESOLVE_REVIEW_THREAD_FLAG_SPEC);
  return {
    pr: parseLenientIntegerOrNull(values.pr),
    commentId: parseLenientIntegerOrNull(values['comment-id']),
    body: values.body,
    owner: values.owner,
    repo: values.repo,
    claimIssue: parseLenientIntegerOrNull(values['claim-issue']),
    claimId: values['claim-id'],
    agentId: values['agent-id'],
    trustedMarkerLogins: splitList(values['trusted-marker-logins']),
    claimless: values.claimless,
    apply: values.apply,
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
  --claimless                    skip claim fetch/revalidation (#2616). For a PR with no
                                 closingIssuesReferences, or (#3328) one that carries a
                                 valid, trusted, unedited <!-- idd-out-of-loop: ...
                                 reason:bootstrap ... --> marker naming this PR and whose
                                 closing issue(s) have no active claim; cannot combine
                                 with --claim-issue / --claim-id
  --apply                        post the reply and resolve the thread (default: dry-run)
  -h, --help                     show this help
`;
/**
 * #2616: `--claimless` scoping rule (mirrors `pre-merge-readiness.mjs`'s
 * #2017 flag, and shares its `classifyPrLoopMembership` definition,
 * kurone-kito/idd-skill#3328) -- true when the PR has no
 * `closingIssuesReferences` at all (the unchanged #2017 fast path, no
 * viewer/trust resolution needed -- #2616's own Codex-review guarantee for
 * an installation-token credential that cannot resolve a viewer identity),
 * or when it does but carries a valid, trusted, unedited
 * `<!-- idd-out-of-loop: ... reason:bootstrap ... -->` marker naming this
 * PR and every closing issue has no active claim. Re-fetches live on every
 * call rather than caching a single snapshot: a caller (dry-run, then
 * again before each `--apply` mutation) must see a closing issue linked
 * in the window between checks, matching the existing per-mutation
 * claim-revalidation pattern (Codex review on this PR: a maintainer
 * linking an issue between checks must not let a `--claimless` mutation
 * still proceed).
 *
 * `options.trustedMarkerLogins` defaults to this session's own viewer
 * login (`port.resolveViewerLogin()`), mirroring the claimed path further
 * below in this file -- only reached on the non-empty-closing-refs branch,
 * never the fast path, so the #2616 no-viewer-identity guarantee above
 * still holds for the common (no closing references) case. Any failure
 * on this branch -- an unresolvable viewer identity, a closing-issue or
 * PR-comment read failure -- fails closed to "not eligible" (`false`),
 * per the fail-closed default
 * (`idd-overview-core.instructions.md#fail-closed-default`), rather than
 * letting a partial read manufacture a false accept. A tagged `gh`
 * transport or not-found error is rethrown so the CLI envelope keeps
 * that kind.
 */
export function isClaimlessEligible(port, pr, options = {}) {
  const closingRefs =
    port.getChangeRequestConvergenceView(pr).closingIssuesReferences;
  // Copilot review, PR #3421: only a PROVEN, genuinely empty array takes
  // the fast eligible-without-classification path -- a non-array
  // `closingRefs` (the field itself unreadable/malformed) must not
  // silently read as "no closing references" the way coercing straight
  // to `[]` and checking `.length === 0` would. It instead falls through
  // to the try block below, where `resolveClosingIssueNumbersForClassifier`
  // reports `null` for a non-array input, which the classifier fails
  // closed to `in-loop` for.
  if (Array.isArray(closingRefs) && closingRefs.length === 0) {
    return true;
  }
  try {
    // C1 critique pass (live-reproduced) + Copilot review, PR #3421: a
    // same-repo-only extraction fed straight to the classifier would
    // silently read a cross-repo-only, partially-unresolvable, or
    // unreadable closing reference as "no closing references", accepting
    // --claimless with NO marker required for a PR the pre-#3328 code
    // always refused (kurone-kito/idd-skill#3328).
    // resolveClosingIssueNumbersForClassifier reports `null` (unreadable)
    // for exactly those cases instead, which the classifier fails closed
    // to `in-loop` for -- reproducing the original refusal. Pass the RAW
    // `closingRefs` (not a pre-coerced array) so the function's own
    // `Array.isArray` check sees the real shape.
    const closingIssueNumbers = resolveClosingIssueNumbersForClassifier(
      closingRefs,
      options.owner ?? '',
      options.repo ?? '',
    );
    const trustedLogins = normalizeTrustedMarkerLogins(
      options.trustedMarkerLogins?.length
        ? options.trustedMarkerLogins
        : [port.resolveViewerLogin().toLowerCase()],
    );
    const isTrustedAuthor = (login) =>
      trustedLogins.includes(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      );
    let closingIssueClaimState = 'none';
    // No closing-issue reads needed when the classifier already fails
    // closed to in-loop regardless of claim state (closingIssueNumbers is
    // null).
    for (const issueNumber of closingIssueNumbers ?? []) {
      const events = port.listWorkItemComments(issueNumber).map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        author: { login: comment.authorLogin },
      }));
      if (resolveActiveClaim(events, isTrustedAuthor)) {
        closingIssueClaimState = 'present';
        break;
      }
    }
    // No need to read the PR's own comments when a closing issue already
    // makes this in-loop -- classifyPrLoopMembership never reaches the
    // marker check in that case either.
    const prComments =
      closingIssueClaimState === 'none'
        ? port.listWorkItemComments(pr, { includeEditState: true })
        : [];
    const result = classifyPrLoopMembership({
      prNumber: pr,
      closingIssueNumbers,
      closingIssueClaimState,
      prComments,
      trustedMarkerLogins: trustedLogins,
    });
    return result.membership !== 'in-loop';
  } catch (error) {
    const classified = classifyHelperError(error);
    // A gh failure is not an eligibility verdict. Rethrow so the CLI can
    // keep transport/not-found. Every other failure still fails closed.
    if (classified.kind === 'transport' || classified.kind === 'not-found') {
      throw error;
    }
    return false;
  }
}
/**
 * Throw when a GraphQL response carries top-level `errors`, so a bad
 * PR/repo/auth or any server-side GraphQL failure fails fast with a clear
 * message instead of being silently read as an empty result (which would
 * masquerade as "no review thread found").
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
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
 * Map {@link ProviderPort.listChangeRequestReviewThreadCommentIds}'s flat
 * `commentDatabaseIds` shape onto this file's existing, independently-tested
 * {@link ReviewThreadNode}/{@link findThreadForComment} contract, rather than
 * changing that pure function's signature.
 */
function toReviewThreadNodes(threads) {
  return threads.map((thread) => ({
    id: thread.threadId,
    isResolved: Boolean(thread.isResolved),
    comments: {
      nodes: thread.commentDatabaseIds.map((databaseId) => ({ databaseId })),
    },
  }));
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
 *
 * `staleAgeMs` (#3270) is the configured `claimTiming.staleAge` window (e.g.
 * via {@link readClaimStaleAgeMs}), threaded into the write-gate resolver so
 * a takeover claim inside that window is recognized instead of being
 * silently evaluated against the hardcoded 24h default. Exported so
 * `tests/resolve-review-thread.test.mts` can exercise it directly against a
 * fake `ProviderPort`.
 */
export function activeOwnedClaim(
  port,
  issue,
  agentId,
  claimId,
  isTrustedAuthor,
  forcedHandoffOptions,
  staleAgeMs,
) {
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
    staleAgeMs,
  });
  if (active?.claimId !== claimId) {
    return null;
  }
  if (agentId && active.agentId !== agentId) {
    return null;
  }
  return active;
}
function writeStderrSync(text) {
  const buffer = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(2, buffer, written, buffer.length - written);
  }
}
function exitClassified(code, kind, message, httpStatus = null) {
  if (code !== 0 && isHelperErrorEnvelopeEnabled()) {
    // Synchronous: process.exit drops a pending async stderr write, which
    // would truncate this envelope line.
    writeStderrSync(
      `${JSON.stringify(
        buildHelperErrorEnvelope('resolve-review-thread', code, {
          kind,
          message,
          httpStatus,
        }),
      )}\n`,
    );
  }
  process.exit(code);
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('resolve-review-thread', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.help ||
    !Number.isInteger(args.pr) ||
    (args.pr ?? 0) <= 0 ||
    !Number.isInteger(args.commentId) ||
    (args.commentId ?? 0) <= 0
  ) {
    process.stdout.write(USAGE);
    exitClassified(
      args.help ? 0 : 1,
      'usage',
      'missing required --pr <number> or --comment-id <id>',
    );
  }
  // #2616: --claimless (mirroring pre-merge-readiness.mjs's #2017 flag)
  // is mutually exclusive with --claim-issue / --claim-id -- both name
  // the same "which ownership check applies" decision, so combining
  // them is always a caller mistake, never a stricter intersection.
  // `args.claimIssue !== null` (not `Number.isInteger`) so a malformed
  // but still-supplied `--claim-issue nope` (parsed to NaN, not the
  // parseArgs default of null for an omitted flag) is still caught
  // here instead of silently falling through to the claimless path
  // (Codex review on this PR).
  if (args.claimless && (args.claimIssue !== null || args.claimId)) {
    writeStderrSync(
      '--claimless cannot be combined with --claim-issue or --claim-id\n',
    );
    exitClassified(
      1,
      'usage',
      '--claimless cannot be combined with --claim-issue or --claim-id',
    );
  }
  // Fail closed: --apply mutates PR state, so a reply body is always
  // mandatory, and the active-claim revalidation is mandatory unless
  // --claimless opts out of it. Missing inputs must abort before any
  // read or write rather than silently bypassing the gate.
  if (args.apply && !args.body) {
    writeStderrSync('--apply requires --body\n');
    exitClassified(1, 'usage', '--apply requires --body');
  }
  if (
    args.apply &&
    !args.claimless &&
    (!Number.isInteger(args.claimIssue) ||
      (args.claimIssue ?? 0) <= 0 ||
      !args.claimId)
  ) {
    writeStderrSync(
      '--apply requires the --claim-issue / --claim-id pair for the mandatory claim revalidation, or --claimless\n',
    );
    exitClassified(
      1,
      'usage',
      '--apply requires the --claim-issue / --claim-id pair for the mandatory claim revalidation, or --claimless',
    );
  }
  // Fail closed before any network call: --apply must never post a --body
  // the F2/F3 disposition-evidence gate (hasFreshDisposition) won't
  // recognize as a disposition (idd-skill#2005). See
  // hasKnownDispositionMarkerPrefix's own doc comment for why this does
  // not separately gate the "Rejection confirmed by maintainer" form on
  // the thread's pre-mutation resolution state.
  if (args.apply && !hasKnownDispositionMarkerPrefix(args.body)) {
    writeStderrSync(
      `--apply requires --body to start with one of the accepted disposition markers: ${ACCEPTED_DISPOSITION_MARKERS}\n`,
    );
    exitClassified(
      1,
      'usage',
      `--apply requires --body to start with one of the accepted disposition markers: ${ACCEPTED_DISPOSITION_MARKERS}`,
    );
  }
  const pr = args.pr;
  const commentId = args.commentId;
  // Loaded once (#3270): both `markerPrefixRaw` below and `staleAgeMs`
  // (near the forced-handoff options, once claim-scoped work below is known
  // to be needed) come from this single read.
  const iddConfig = loadIddConfig();
  const markerPrefixRaw = iddConfig?.markerPrefix;
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
  // #2616: fast fail-closed preview for both dry-run and --apply -- the
  // per-mutation re-check below (inside assertClaim) is the one that
  // actually gates the apply-mode mutations.
  if (args.claimless) {
    const claimlessMessage =
      '--claimless requires a PR with no closingIssuesReferences, or a valid out-of-loop marker; pass --claim-issue instead';
    try {
      if (
        !isClaimlessEligible(port, pr, {
          owner,
          repo,
          trustedMarkerLogins: args.trustedMarkerLogins,
        })
      ) {
        writeStderrSync(`${claimlessMessage}\n`);
        exitClassified(1, 'gate', claimlessMessage);
      }
    } catch (error) {
      const classified = classifyHelperError(error);
      writeStderrSync(`${claimlessMessage}\n`);
      exitClassified(
        1,
        classified.kind,
        classified.message,
        classified.httpStatus,
      );
    }
  }
  const match = findThreadForComment(
    toReviewThreadNodes(port.listChangeRequestReviewThreadCommentIds(pr)),
    commentId,
  );
  const report = {
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
    exitClassified(args.apply ? 1 : 0, 'gate', report.error);
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
    exitClassified(1, 'gate', report.error);
  }
  // #2616: this claim-only setup is unneeded (and un-skippable) network/
  // identity work for --claimless -- a credential that can read/update
  // PRs but cannot resolve a viewer identity (e.g. some GitHub App
  // installation-token setups) must not abort here when neither the
  // viewer nor the claimed branch is ever consulted in this mode (Codex
  // review on this PR).
  let prHeadRef = '';
  let isTrustedAuthor = () => false;
  let forcedHandoffOptions = {
    forcedHandoffEnabled: false,
    isAuthorizedForcedHandoff: () => false,
  };
  // #3270: only meaningful (and only read) inside the `assertClaim` closure
  // below when `!args.claimless` -- the `--claimless` path never calls
  // `activeOwnedClaim`, so this default is never exercised.
  let staleAgeMs = 0;
  if (!args.claimless) {
    // Bind the mutation to the claimed PR: the active claim's branch must be
    // the PR's head branch, so a valid claim on the issue cannot be used to
    // reply to and resolve a thread on some other PR passed as --pr.
    prHeadRef = port.getChangeRequestHeadRef(pr);
    // --apply: default the trusted claim authors to this gh login so the
    // revalidation recognizes the session's own claim markers.
    const viewerLogin = port.resolveViewerLogin().toLowerCase();
    const trustedAuthors = new Set(
      (args.trustedMarkerLogins.length > 0
        ? args.trustedMarkerLogins
        : [viewerLogin]
      ).map((login) => login.toLowerCase()),
    );
    isTrustedAuthor = (login) =>
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
    const forcedHandoffPermissionCache = new Map();
    staleAgeMs = readClaimStaleAgeMs(iddConfig);
    forcedHandoffOptions = {
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
  }
  // Retain the posted reply id across a later failure so a partial apply (reply
  // posted, resolve not confirmed) reports the reply id instead of looking like
  // nothing was posted — that distinguishes "retry the resolve" from "re-post".
  let postedReplyId;
  try {
    const result = applyResolveReviewThread({
      assertClaim: () => {
        // #2616: --claimless intentionally skips claim revalidation, but
        // re-checks eligibility fresh on every call (not just once,
        // up front) -- a closing issue linked in the window between
        // this mutation and the last one must still abort, mirroring
        // the non-claimless path's own per-mutation claim recheck.
        if (args.claimless) {
          if (
            !isClaimlessEligible(port, pr, {
              owner,
              repo,
              trustedMarkerLogins: args.trustedMarkerLogins,
            })
          ) {
            throw new Error(
              '--claimless requires a PR with no closingIssuesReferences, or a valid out-of-loop marker; pass --claim-issue instead',
            );
          }
          return;
        }
        const active = activeOwnedClaim(
          port,
          args.claimIssue,
          args.agentId,
          args.claimId,
          isTrustedAuthor,
          forcedHandoffOptions,
          staleAgeMs,
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
    const classified = classifyHelperError(error);
    const message = error.message;
    // Deliberate ownership denials are a completed gate. A tagged gh
    // failure keeps transport/not-found.
    const kind =
      classified.kind === 'transport' || classified.kind === 'not-found'
        ? classified.kind
        : message.startsWith('claim revalidation failed:') ||
            message.startsWith('claim/PR mismatch:') ||
            message.startsWith('--claimless requires a PR')
          ? 'gate'
          : classified.kind;
    report.error = message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    exitClassified(1, kind, classified.message, classified.httpStatus);
  }
}
