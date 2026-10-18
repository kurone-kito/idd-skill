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
//
// A second, body-item target (#4012) answers a review-body finding that has
// no inline thread (a Copilot "Previously missed" item): given the review id
// and the item's title, it posts one stamped top-level PR comment under the
// same claim checks and dry-run default, and resolves nothing.

import { writeSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import {
  extractPreviouslyMissedItemTitles,
  normalizePreviouslyMissedItemTitle,
} from './copilot-review-body.mts';
import type {
  HelperCliResult,
  IddHelperErrorKind,
} from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  buildHelperErrorEnvelope,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  appendReviewReplyStamp,
  renderReviewReplyStamp,
} from './marker-helpers.mts';
import {
  decideUrgencyDefer,
  formatTriageLine,
  normalizePolicyConfig,
  relaxStepForReviewCount,
  TRIAGE_LINE_BREAK_PATTERN,
  type TriageRecord,
} from './policy-helpers.mts';
import {
  classifyPrLoopMembership,
  DISPOSITION_ACCEPTED_PREFIX_RE,
  hasPendingDecisionMarker,
  isCopilotReviewerLogin,
  isDispositionComment,
  isRejectionConfirmedDisposition,
  normalizeTrustedMarkerLogins,
  type ParsedClaimMarker,
  type PrClosingIssueClaimState,
  readClaimStaleAgeMs,
  resolveActiveClaim,
  resolveActiveClaimForWriteGate,
  resolveClosingIssueNumbersForClassifier,
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
  mode: 'dry-run' | 'apply' | 'triage';
  prNumber: number;
  /**
   * The compute-only triage value (#4188): the `Triage:` line a reply with the
   * same flags would carry. Set only in `triage` mode, which posts nothing.
   */
  triage?: string;
  /** The thread target's review comment id; omitted for a body item. */
  commentId?: number;
  /** Omitted when no review thread owns the comment, and for a body item. */
  threadId?: string;
  /** The thread target's resolution state; omitted for a body item. */
  alreadyResolved?: boolean;
  /** The body-item target's review id (#4012); omitted for a thread. */
  reviewId?: number;
  /** The body-item target's title as matched (#4012); omitted for a thread. */
  itemTitle?: string;
  /** The answered item's 1-based position in the Previously missed section
   * (#4012); omitted for a thread and when the lookup fails. */
  itemIndex?: number;
  /**
   * Reply body that will be posted (dry-run) or was posted (apply),
   * including the injected reply-identity stamp. Omitted when `--body`
   * is empty.
   */
  body?: string;
  status?: 'applied' | 'failed';
  /** The posted reply's id; for a body item, the top-level comment's id. */
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

/** The forms the body-item target accepts, for use in error messages. */
export const ACCEPTED_BODY_ITEM_DISPOSITION_MARKERS =
  '**Accepted**, **Rejected**, or the recorded deferral **Rejected** — deferred to follow-up issue #<n> (<clause>): <reason>';

/**
 * True when `body` opens with a disposition the body-item target accepts
 * (#4012): `**Accepted**` or `**Rejected**`, the prefixes
 * `isDispositionComment` recognizes. The recorded-deferral form opens with
 * `**Rejected** —`, so it passes too. The `**Rejection confirmed by
 * maintainer**` marker does not: it closes an AMD on a review thread, and a
 * body item has none.
 */
export function hasBodyItemDispositionPrefix(body: string): boolean {
  return isDispositionComment({ body });
}

/**
 * The refusal for an `--apply --body` that carries the pending-decision marker
 * (#4306). Both targets open with the same prefix, so a caller or a test can
 * match one text for either. The tail differs (#4332): a thread target resolves
 * the thread, so it is told to post the reply by hand and leave the thread
 * open, while a body-item target posts a top-level reply and resolves no
 * thread, so it is told to wait for the maintainer and then post a settled
 * disposition.
 */
function pendingBodyRefusal(bodyItem: boolean): string {
  const prefix =
    '--apply refuses a --body that carries "**Awaiting maintainer decision**" at the start of a line: ';
  return bodyItem
    ? `${prefix}this helper posts a top-level reply that settles the item, and a pending decision settles nothing. Wait for the maintainer's decision, then post a settled disposition (E6)`
    : `${prefix}this helper resolves the thread, and a pending decision keeps it open. Post that reply by hand and leave the thread unresolved (E6)`;
}

/** Where a body item's title was looked for, and what was found. */
export type BodyItemLookup =
  | { found: true; title: string; index: number }
  | { found: false; error: string };

/**
 * Find the review whose REST id is `reviewId` among `reviews` (the raw
 * `pulls/{n}/reviews` rows) and confirm its Previously missed section lists an
 * item titled `itemTitle` (#4012). The body's titles lose their HTML markup,
 * and both sides then pass through `normalizePreviouslyMissedItemTitle`; the
 * caller's title keeps any literal angle-bracket text. The match is exact, so
 * a partial or misspelled title is refused. A review that is absent, or whose
 * body has no readable Previously missed section, is refused too (fail
 * closed).
 *
 * Two items can share a title (the PR #3925 corpus review lists two items
 * titled "Preserve reviewer type in bot removal-proof matching"), and the
 * merge gate counts dispositions rather than pairing them with items, so an
 * ambiguous title is refused unless `itemIndex` (the item's 1-based position
 * in the section) names one of them. A given `itemIndex` must point at an item
 * with that exact title. The found item's position is returned as `index`.
 */
export function findBodyItem(
  reviews: unknown[],
  reviewId: number,
  itemTitle: string,
  prNumber: number,
  itemIndex: number | null = null,
): BodyItemLookup {
  const review = (Array.isArray(reviews) ? reviews : []).find(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      Number((row as { id?: unknown }).id) === Number(reviewId),
  ) as { body?: unknown } | undefined;
  if (!review) {
    return {
      found: false,
      error: `no review ${reviewId} found on PR #${prNumber}`,
    };
  }
  const titles = extractPreviouslyMissedItemTitles(
    typeof review.body === 'string' ? review.body : null,
  );
  if (titles === null) {
    return {
      found: false,
      error: `review ${reviewId} on PR #${prNumber} has no readable Previously missed section`,
    };
  }
  const wanted = normalizePreviouslyMissedItemTitle(itemTitle);
  const positions = wanted
    ? titles.flatMap((title, i) => (title === wanted ? [i + 1] : []))
    : [];
  if (positions.length === 0) {
    return {
      found: false,
      error: `review ${reviewId} on PR #${prNumber} lists no Previously missed item titled "${wanted}"`,
    };
  }
  if (itemIndex !== null) {
    if (!positions.includes(itemIndex)) {
      return {
        found: false,
        error: `Previously missed item ${itemIndex} of review ${reviewId} on PR #${prNumber} is not titled "${wanted}" (that title is item ${positions.join(', ')})`,
      };
    }
    return { found: true, title: wanted, index: itemIndex };
  }
  if (positions.length > 1) {
    return {
      found: false,
      error: `review ${reviewId} on PR #${prNumber} lists ${positions.length} Previously missed items titled "${wanted}" (items ${positions.join(', ')}); pass --item-index to choose one`,
    };
  }
  return { found: true, title: wanted, index: positions[0] as number };
}

/**
 * Run the body-item target against a provider port (#4012). Looks the item
 * up first, so an unknown review or title never reaches a post. Dry-run
 * returns the stamped body and posts nothing. Apply revalidates the claim
 * through `assertClaim`, then posts exactly one top-level PR comment, and
 * never resolves a review thread. `exitCode` follows the thread target: a
 * lookup failure is informational (0) in dry-run and a failure (1) in apply.
 * An error thrown by `assertClaim` or the post propagates to the caller.
 */
export function runBodyItemDisposition(
  port: ProviderPort,
  input: {
    pr: number;
    reviewId: number;
    itemTitle: string;
    /** 1-based item position; required only when the title is ambiguous. */
    itemIndex?: number | null;
    stampedBody: string;
    apply: boolean;
    assertClaim: () => void;
    /**
     * Rebuilds the stamped body from a fresh read, called after the claim check
     * and right before the post (#4187). Required on an apply; a dry run never
     * calls it.
     */
    refreshBody?: () => string;
  },
): { report: ResolveReviewThreadReport; exitCode: 0 | 1 } {
  const report: ResolveReviewThreadReport = {
    mode: input.apply ? 'apply' : 'dry-run',
    prNumber: input.pr,
    reviewId: input.reviewId,
    itemTitle: normalizePreviouslyMissedItemTitle(input.itemTitle),
    ...(input.stampedBody ? { body: input.stampedBody } : {}),
  };
  const lookup = findBodyItem(
    port.listReviews(input.pr),
    input.reviewId,
    input.itemTitle,
    input.pr,
    input.itemIndex ?? null,
  );
  if (!lookup.found) {
    report.error = lookup.error;
    if (input.apply) {
      report.status = 'failed';
      // Nothing was posted, so the report carries no body (#4187).
      delete report.body;
    }
    return { report, exitCode: input.apply ? 1 : 0 };
  }
  report.itemTitle = lookup.title;
  report.itemIndex = lookup.index;
  if (!input.apply) {
    return { report, exitCode: 0 };
  }
  input.assertClaim();
  // An apply reads the verdict again right before the post (#4187). Posting
  // the early stamped body without that read would let a stale verdict through.
  if (!input.refreshBody) {
    throw new Error(
      'an apply needs refreshBody, so the verdict is read again before the post (#4187)',
    );
  }
  const body = input.refreshBody();
  // A claim handoff during the late read must not reach the post (#4187).
  input.assertClaim();
  report.body = body;
  const posted = port.postWorkItemComment(input.pr, body);
  report.status = 'applied';
  report.replyId = posted.id;
  return { report, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Triage line (#4186)
// ---------------------------------------------------------------------------

/**
 * The E4/E5 triage flags as the CLI passes them. Empty strings mean unset,
 * except `override`, where `null` means the flag is absent, so an explicit
 * empty reason stays distinguishable (#4187).
 */
export interface TriageFlags {
  tier: string;
  urgency: string;
  copilotLabel: string;
  safetyClass: boolean;
  lite: boolean;
  advisoryConverged: string;
  pathB: boolean;
  /** The finding is scope-fenced; blocks a deferral (#4187). */
  scopeFence: boolean;
  /** The reply's author is a CODEOWNER or required reviewer (#4187). */
  protectedAuthority: boolean;
  /** Accepted in an earlier E5 pass; the fix is still in progress (#4187). */
  acceptedMidFix: boolean;
  /** Adopt-now condition (d) holds; turns a defer verdict into keep (#4436). */
  adoptNow: boolean;
  /** Reason for an Accepted reply the defer matrix would refuse, or `null` (#4187). */
  override: string | null;
}

/** A refused triage input. The CLI exits 1 with kind `usage` and posts nothing. */
export class TriageUsageError extends Error {}

/**
 * The `enforce` refusal, raised by the late verdict check right before a post
 * (#4187). The CLI exits 1 with kind `gate` and the post is not made.
 */
export class TriageRefusedError extends Error {}

/** A failed read of the reviews or the head. The CLI reports kind `transport`. */
export class TriageReadError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('triage read failed');
    this.original = original;
  }
}

function readTriageInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new TriageReadError(error);
  }
}

const TRIAGE_TIER_VALUES: readonly string[] = ['low', 'medium', 'high'];
const TRIAGE_URGENCY_VALUES: readonly string[] = [
  'very-low',
  'low',
  'medium',
  'high',
];

/**
 * Refuse an empty, whitespace-only, or multi-line `--override` reason (#4187).
 * A usage error, so nothing is posted and the reason never reaches
 * `formatTriageLine`, which would throw a plain `Error` instead.
 */
function checkOverrideReason(reason: string): void {
  if (reason.trim() === '') {
    throw new TriageUsageError('--override requires a non-empty reason');
  }
  if (TRIAGE_LINE_BREAK_PATTERN.test(reason)) {
    throw new TriageUsageError('--override reason must be on one line');
  }
}

/**
 * Refuse a triage flag combination before any network call (#4186): the enum
 * values, the `--tier`/`--urgency` pair, `--path-b` exclusivity, the
 * `record`/`enforce` requirement on an Accepted or Rejected reply, and the
 * `--advisory-converged` reviewPolicy check. A valid triage flag with no line
 * to carry it is a no-op, not an error, except under `--path-b`, which refuses
 * every verdict input (#4187). An invalid value is always a usage error. The
 * static `--override` conditions are checked here too (#4187); the verdict
 * condition needs the relax step, so `buildTriageReplyBody` checks it. The
 * `--adopt-now` conditions are all static, so they are checked here (#4436).
 */
export function validateTriageFlags(input: {
  flags: TriageFlags;
  apply: boolean;
  body: string;
  triageRecord: 'off' | 'record' | 'enforce';
  reviewPolicy: unknown;
  /** The effective `critiqueLoop.deferByUrgency` (#4187). */
  deferByUrgency?: 'off' | 'low' | 'low-and-medium' | 'severity-tiered';
}): void {
  const { flags } = input;
  if (flags.tier !== '' && !TRIAGE_TIER_VALUES.includes(flags.tier)) {
    throw new TriageUsageError(
      `--tier must be one of ${TRIAGE_TIER_VALUES.join(', ')}`,
    );
  }
  if (
    flags.copilotLabel !== '' &&
    !TRIAGE_TIER_VALUES.includes(flags.copilotLabel)
  ) {
    throw new TriageUsageError(
      `--copilot-label must be one of ${TRIAGE_TIER_VALUES.join(', ')}`,
    );
  }
  if (flags.urgency !== '' && !TRIAGE_URGENCY_VALUES.includes(flags.urgency)) {
    throw new TriageUsageError(
      `--urgency must be one of ${TRIAGE_URGENCY_VALUES.join(', ')}`,
    );
  }
  const scoringFlags =
    flags.copilotLabel !== '' ||
    flags.safetyClass ||
    flags.lite ||
    flags.advisoryConverged !== '' ||
    flags.scopeFence ||
    flags.protectedAuthority ||
    flags.acceptedMidFix ||
    flags.adoptNow ||
    flags.override !== null;
  // Checked before the pair, so `--path-b` with a lone score names `--path-b`.
  if (
    flags.pathB &&
    (flags.tier !== '' || flags.urgency !== '' || scoringFlags)
  ) {
    throw new TriageUsageError(
      '--path-b cannot be combined with --tier, --urgency, --copilot-label, --safety-class, --scope-fence, --protected-authority, --accepted-mid-fix, --adopt-now, --override, --lite, or --advisory-converged',
    );
  }
  // Checked before the pair, unlike `--override` below, so a lone score with
  // `--adopt-now` names `--adopt-now` rather than the pair (#4436).
  if (flags.adoptNow) {
    if (input.deferByUrgency !== 'severity-tiered') {
      throw new TriageUsageError(
        '--adopt-now requires critiqueLoop.deferByUrgency severity-tiered',
      );
    }
    if (flags.lite) {
      throw new TriageUsageError('--adopt-now cannot be combined with --lite');
    }
    if (flags.tier === '' || flags.urgency === '') {
      throw new TriageUsageError('--adopt-now requires --tier and --urgency');
    }
  }
  if ((flags.tier === '') !== (flags.urgency === '')) {
    throw new TriageUsageError('--tier and --urgency must be given together');
  }
  // A body that already carries a Triage line would hold two, and the audit
  // reads the first one. Refuse before any read, so the record stays
  // unambiguous: the fail-closed default for ambiguous state (#4187).
  if (flags.tier !== '' && /^Triage:/mu.test(input.body)) {
    throw new TriageUsageError(
      'the body already carries a Triage line; the helper writes one from --tier and --urgency',
    );
  }
  // The same prefix test the apply gate uses, so a body that gate admits (for
  // example `**Accepted:**`) cannot skip the requirement. A `**Rejection
  // confirmed by maintainer**` body does not match it, which keeps that
  // exemption.
  const dispositionReply = isDispositionComment({ body: input.body });
  if (
    input.apply &&
    (input.triageRecord === 'record' || input.triageRecord === 'enforce') &&
    !flags.pathB &&
    dispositionReply &&
    flags.tier === ''
  ) {
    throw new TriageUsageError(
      `triageRecord ${input.triageRecord} requires --tier and --urgency on an Accepted or Rejected reply`,
    );
  }
  const reviewPolicy = input.reviewPolicy;
  if (
    flags.advisoryConverged !== '' &&
    flags.tier !== '' &&
    reviewPolicy !== undefined &&
    reviewPolicy !== null &&
    reviewPolicy !== 'copilot-advisory'
  ) {
    throw new TriageUsageError(
      `--advisory-converged requires reviewPolicy copilot-advisory, but reviewPolicy is ${JSON.stringify(reviewPolicy)}`,
    );
  }
  if (flags.override !== null) {
    checkOverrideReason(flags.override);
    if (input.triageRecord !== 'record' && input.triageRecord !== 'enforce') {
      throw new TriageUsageError(
        '--override requires triageRecord record or enforce',
      );
    }
    if (input.deferByUrgency !== 'severity-tiered') {
      throw new TriageUsageError(
        '--override requires critiqueLoop.deferByUrgency severity-tiered',
      );
    }
    if (flags.tier === '' || flags.urgency === '') {
      throw new TriageUsageError('--override requires --tier and --urgency');
    }
    if (!DISPOSITION_ACCEPTED_PREFIX_RE.test(input.body.trimEnd())) {
      throw new TriageUsageError('--override requires an Accepted reply body');
    }
  }
}

function reviewAuthorLogin(review: unknown): unknown {
  return (review as { user?: { login?: unknown } } | null)?.user?.login;
}

/**
 * Build the stamped reply body, with the `Triage:` line when `--tier` and
 * `--urgency` are both set (#4186). Without both, the body is what it was
 * before this change. The relax step reads the pull request's reviews only
 * under `severity-tiered` without `--lite`, and reads the head only when
 * `--advisory-converged` is also set on that path. A SHA that does not match
 * the head throws a `TriageUsageError`. A failed read throws a
 * `TriageReadError` that wraps the original error. The caller passes the
 * normalized policy, so this function loads no config.
 *
 * Under `severity-tiered` the line also carries the E5 verdict (#4187). An
 * `--override` must match a defer verdict, or this throws a `TriageUsageError`.
 */
export function buildTriageReplyBody(input: {
  port: ProviderPort;
  pr: number;
  rawBody: string;
  markerPrefix: string | undefined;
  deferByUrgency: 'off' | 'low' | 'low-and-medium' | 'severity-tiered';
  deferRelaxAtRounds: readonly number[];
  flags: TriageFlags;
}): {
  body: string;
  record: TriageRecord | null;
  verdict: TriageVerdict | null;
} {
  const { flags, rawBody, markerPrefix } = input;
  if (rawBody.trim() === '') {
    return { body: '', record: null, verdict: null };
  }
  if (flags.tier === '' || flags.urgency === '') {
    // An override needs a Triage line to carry it (#4187).
    if (flags.override !== null) {
      throw new TriageUsageError('--override requires --tier and --urgency');
    }
    return {
      body: appendReviewReplyStamp(rawBody, markerPrefix),
      record: null,
      verdict: null,
    };
  }
  const { record, verdict } = scoreTriageRecord(input);
  if (flags.override !== null) {
    checkOverrideReason(flags.override);
    if (verdict === null) {
      throw new TriageUsageError(
        '--override requires critiqueLoop.deferByUrgency severity-tiered',
      );
    }
    if (verdict.verdict !== 'defer') {
      throw new TriageUsageError(
        "--override requires a defer verdict, but this reply's verdict is keep",
      );
    }
    record.override = flags.override.trim();
  }
  return {
    body: placeTriageLine(rawBody, markerPrefix, formatTriageLine(record)),
    record,
    verdict,
  };
}

/**
 * Score one E4/E5 triage record (#4188). A reply and the compute-only mode both
 * call this, so the same flags give the same triage value. The reviews are read
 * only under `severity-tiered` without `--lite`, and the head only with
 * `--advisory-converged`. The verdict comes from the same record the line
 * carries, so the dry run and the apply path cannot disagree (#4187).
 */
function scoreTriageRecord(input: {
  port: ProviderPort;
  pr: number;
  deferByUrgency: 'off' | 'low' | 'low-and-medium' | 'severity-tiered';
  deferRelaxAtRounds: readonly number[];
  flags: TriageFlags;
}): { record: TriageRecord; verdict: TriageVerdict | null } {
  const { flags } = input;
  let step: TriageRecord['step'] = 0;
  let convergedHead: string | null = null;
  if (input.deferByUrgency === 'severity-tiered' && !flags.lite) {
    const reviews = readTriageInput(() => input.port.listReviews(input.pr));
    const copilotReviews = reviews.filter((review) =>
      isCopilotReviewerLogin(reviewAuthorLogin(review)),
    ).length;
    let converged = false;
    let head = '';
    if (flags.advisoryConverged !== '') {
      head = readTriageInput(() =>
        input.port.getChangeRequestHeadSha(input.pr),
      );
      if (flags.advisoryConverged !== head) {
        throw new TriageUsageError(
          `--advisory-converged ${flags.advisoryConverged} does not match the pull request head ${head}`,
        );
      }
      converged = true;
    }
    const relax = relaxStepForReviewCount(
      copilotReviews,
      input.deferRelaxAtRounds,
      converged,
    );
    step = relax.step;
    convergedHead = relax.raisedByConvergence ? head.slice(0, 7) : null;
  }
  const record: TriageRecord = {
    tier: flags.tier as TriageRecord['tier'],
    urgency: flags.urgency as TriageRecord['urgency'],
    step,
    convergedHead,
    copilotLabel:
      flags.copilotLabel === ''
        ? null
        : (flags.copilotLabel as TriageRecord['copilotLabel']),
    safety: flags.safetyClass,
    verdict: null,
    blocked: null,
    override: null,
  };
  const verdict =
    input.deferByUrgency === 'severity-tiered'
      ? computeTriageVerdict(record, flags)
      : null;
  if (verdict !== null) {
    record.verdict = verdict.verdict;
    record.blocked = verdict.blocked;
  }
  return { record, verdict };
}

/** The E5 defer-matrix verdict for one Triage record (#4187). */
export interface TriageVerdict {
  verdict: 'defer' | 'keep';
  /** The eligibility tier, or `null` when an early check blocked the defer. */
  eligibility: TriageRecord['tier'] | null;
  /** The matrix's block reason, or `null` when the verdict is `defer`. */
  blocked: string | null;
}

/**
 * Compute the E5 defer-matrix verdict for one Triage record under
 * `severity-tiered` (#4187). Pure: it reads and prints nothing, so the dry
 * run, the apply path, and any later compute-only mode share one answer.
 * `decideUrgencyDefer` does the matrix work; this maps its output onto the
 * fields the `Triage:` line carries. The inputs are the issue's: path A and no
 * awaiting-decision hold. `decideUrgencyDefer` ignores `adoptNow` under
 * `severity-tiered`, so adopt-now condition (d) is applied here, after the
 * matrix: `--adopt-now` turns a defer into `keep` blocked by `adopt-now`, and
 * every other verdict keeps its own eligibility and reason (#4436).
 */
export function computeTriageVerdict(
  record: Pick<
    TriageRecord,
    'tier' | 'urgency' | 'step' | 'copilotLabel' | 'safety'
  >,
  flags: Pick<
    TriageFlags,
    'scopeFence' | 'protectedAuthority' | 'acceptedMidFix' | 'adoptNow'
  >,
): TriageVerdict {
  const decision = decideUrgencyDefer({
    mode: 'severity-tiered',
    path: 'A',
    e4Severity: record.tier,
    copilotLabel: record.copilotLabel,
    urgency: record.urgency,
    relaxStep: record.step,
    safetyClass: record.safety,
    scopeFence: flags.scopeFence,
    protectedAuthority: flags.protectedAuthority,
    acceptedMidFix: flags.acceptedMidFix,
    awaitingMaintainerDecision: false,
    // Ignored under `severity-tiered`; condition (d) is applied below (#4436).
    adoptNow: false,
  });
  if (decision.defer && flags.adoptNow) {
    return {
      verdict: 'keep',
      eligibility: decision.eligibility,
      blocked: 'adopt-now',
    };
  }
  return {
    verdict: decision.defer ? 'defer' : 'keep',
    eligibility: decision.eligibility,
    blocked: decision.blockedBy,
  };
}

/**
 * The one stderr line a verdict prints: the verdict, its eligibility tier, and
 * its block reason (#4187). The refusal text is built from it.
 */
function verdictLine(verdict: TriageVerdict): string {
  return `triage verdict: ${verdict.verdict} (eligibility ${verdict.eligibility ?? 'none'}, blocked by ${verdict.blocked ?? 'none'})`;
}

/**
 * Put `line` on its own line directly before an existing reply-identity
 * stamp, or, with no stamp, append it and then the stamp (#4186). The
 * appended form leaves one blank line before the stamp, as
 * `appendReviewReplyStamp` always does.
 */
function placeTriageLine(
  rawBody: string,
  markerPrefix: string | undefined,
  line: string,
): string {
  const stampAt = findReviewReplyStamp(rawBody, markerPrefix);
  if (stampAt !== -1) {
    const before = rawBody.slice(0, stampAt);
    const separator = before === '' || before.endsWith('\n') ? '' : '\n';
    return `${before}${separator}${line}\n${rawBody.slice(stampAt)}`;
  }
  return appendReviewReplyStamp(
    `${rawBody.replace(/\s+$/u, '')}\n${line}`,
    markerPrefix,
  );
}

/**
 * The index of the first reply-identity stamp in `body`, or -1. The search
 * accepts the same whitespace and case variants `hasReviewReplyStamp` does.
 */
function findReviewReplyStamp(
  body: string,
  markerPrefix: string | undefined,
): number {
  const literal = renderReviewReplyStamp(markerPrefix);
  const pattern = literal
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/ /gu, '\\s*');
  const match = new RegExp(pattern, 'iu').exec(body);
  return match === null ? -1 : match.index;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  pr: number | null;
  commentId: number | null;
  reviewId: number | null;
  itemTitle: string;
  itemIndex: number | null;
  body: string;
  owner: string;
  repo: string;
  claimIssue: number | null;
  claimId: string;
  agentId: string;
  trustedMarkerLogins: string[];
  claimless: boolean;
  tier: string;
  urgency: string;
  copilotLabel: string;
  safetyClass: boolean;
  lite: boolean;
  advisoryConverged: string;
  pathB: boolean;
  scopeFence: boolean;
  protectedAuthority: boolean;
  acceptedMidFix: boolean;
  adoptNow: boolean;
  /** `null` when `--override` is absent, so `--override ""` stays visible (#4187). */
  override: string | null;
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
  '--review-id': { type: 'string' },
  '--item-title': { type: 'string', default: '' },
  '--item-index': { type: 'string' },
  '--body': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--claim-issue': { type: 'string' },
  '--claim-id': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--claimless': { type: 'boolean', default: false },
  '--tier': { type: 'string', default: '' },
  '--urgency': { type: 'string', default: '' },
  '--copilot-label': { type: 'string', default: '' },
  '--safety-class': { type: 'boolean', default: false },
  '--lite': { type: 'boolean', default: false },
  '--advisory-converged': { type: 'string', default: '' },
  '--path-b': { type: 'boolean', default: false },
  '--scope-fence': { type: 'boolean', default: false },
  '--protected-authority': { type: 'boolean', default: false },
  '--accepted-mid-fix': { type: 'boolean', default: false },
  '--adopt-now': { type: 'boolean', default: false },
  // No default: an absent flag is `undefined`, so `--override ""` (an empty
  // reason, refused later) is still visible (#4187).
  '--override': { type: 'string' },
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
    reviewId: parseLenientIntegerOrNull(
      values['review-id'] as string | undefined,
    ),
    itemTitle: values['item-title'] as string,
    itemIndex: parseLenientIntegerOrNull(
      values['item-index'] as string | undefined,
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
    tier: values.tier as string,
    urgency: values.urgency as string,
    copilotLabel: values['copilot-label'] as string,
    safetyClass: values['safety-class'] as boolean,
    lite: values.lite as boolean,
    advisoryConverged: values['advisory-converged'] as string,
    pathB: values['path-b'] as boolean,
    scopeFence: values['scope-fence'] as boolean,
    protectedAuthority: values['protected-authority'] as boolean,
    acceptedMidFix: values['accepted-mid-fix'] as boolean,
    adoptNow: values['adopt-now'] as boolean,
    override: (values.override as string | undefined) ?? null,
    apply: values.apply as boolean,
    help,
  };
}

const USAGE = `usage: node scripts/resolve-review-thread.mjs --pr <number> --comment-id <id> [options]
       node scripts/resolve-review-thread.mjs --pr <number> --review-id <id> --item-title <title> [options]
       node scripts/resolve-review-thread.mjs --pr <number> --tier <tier> --urgency <urgency> [options]

Post a reply to the review thread that owns <comment-id> and resolve that
thread in one invocation (E13). With --review-id / --item-title instead,
post one stamped top-level PR comment answering a review-body item that has
no thread (a Copilot "Previously missed" item); no thread is resolved.
Dry-run by default; --apply mutates.

With --pr, --tier, and --urgency and no target, prints the triage value a
reply with the same flags would carry, and posts nothing. For example:
  node scripts/resolve-review-thread.mjs --pr 42 --tier low --urgency medium

  --pr <number>                  PR number (required)
  --comment-id <id>              review comment REST id whose thread to resolve
                                 (required unless --review-id is given)
  --review-id <id>               review REST id whose body lists the item (body-item target;
                                 requires --item-title; cannot combine with --comment-id)
  --item-title <title>           the Previously missed item's title, matched exactly
  --item-index <n>               the item's 1-based position in the Previously missed
                                 section; required when two items share the title
  --body <text>                  reply body (required with --apply; with --apply, must start
                                 with **Accepted**, **Rejected**, or
                                 **Rejection confirmed by maintainer** — on a thread, and
                                 with **Accepted** or **Rejected** (the recorded deferral
                                 included) on a body item; the helper appends the
                                 reply-identity stamp)
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
  --tier <low|medium|high>       E4 tier of the finding; needs --urgency. With both,
                                 the reply carries a Triage line (#4186)
  --urgency <very-low|low|medium|high>
                                 E4 urgency score; needs --tier
  --copilot-label <low|medium|high>
                                 Copilot's own severity label for the finding (optional)
  --safety-class                 the finding is in the safety class (optional)
  --lite                         the caller follows the lite profile: relax step 0
  --advisory-converged <sha>     head commit the advisory-convergence verdict was for
  --path-b                       the reply answers a PATH B item; no triage flags
  --scope-fence                  the finding is scope-fenced; blocks a deferral (optional)
  --protected-authority          the reply's author is a CODEOWNER or required reviewer;
                                 blocks a deferral (optional)
  --accepted-mid-fix             Accepted in an earlier E5 pass, fix still in progress;
                                 blocks a deferral (optional)
  --adopt-now                    adopt-now condition (d) holds: turns a defer verdict into
                                 keep (severity-tiered only; needs --tier and --urgency;
                                 not with --lite or --path-b)
  --override <reason>            post an Accepted reply the defer matrix refuses, with the
                                 reason recorded on its Triage line (needs a defer verdict)
  --apply                        post the reply and resolve the thread, or post the
                                 body-item comment (default: dry-run)
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
export function isClaimlessEligible(
  port: ProviderPort,
  pr: number,
  options: {
    owner?: string;
    repo?: string;
    trustedMarkerLogins?: string[];
  } = {},
): boolean {
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
    const isTrustedAuthor = (login: string): boolean =>
      trustedLogins.includes(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      );
    let closingIssueClaimState: PrClosingIssueClaimState = 'none';
    // No closing-issue reads needed when the classifier already fails
    // closed to in-loop regardless of claim state (closingIssueNumbers is
    // null).
    for (const issueNumber of closingIssueNumbers ?? []) {
      const events = port
        .listWorkItemComments(issueNumber, { includeEditState: true })
        .map((comment) => ({
          body: comment.body,
          createdAt: comment.createdAt,
          author: { login: comment.authorLogin },
          lastEditedAt: comment.lastEditedAt,
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
 *
 * `staleAgeMs` (#3270) is the configured `claimTiming.staleAge` window (e.g.
 * via {@link readClaimStaleAgeMs}), threaded into the write-gate resolver so
 * a takeover claim inside that window is recognized instead of being
 * silently evaluated against the hardcoded 24h default. Exported so
 * `tests/resolve-review-thread.test.mts` can exercise it directly against a
 * fake `ProviderPort`.
 */
export function activeOwnedClaim(
  port: ProviderPort,
  issue: number,
  agentId: string,
  claimId: string,
  isTrustedAuthor: (login: string) => boolean,
  forcedHandoffOptions: ForcedHandoffGateOptions,
  staleAgeMs: number,
): ParsedClaimMarker | null {
  const comments = port.listWorkItemComments(issue, {
    includeEditState: true,
  });
  const events = comments.map((comment) => ({
    body: comment.body,
    createdAt: comment.createdAt,
    author: { login: comment.authorLogin },
    lastEditedAt: comment.lastEditedAt,
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

function writeStderrSync(text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(2, buffer, written, buffer.length - written);
  }
}

function exitClassified(
  code: number,
  kind: IddHelperErrorKind,
  message: string,
  httpStatus: number | null = null,
): never {
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

/**
 * The compute-only triage mode (#4188): a valid `--pr` with `--tier` or
 * `--urgency`, and no target, no `--body`, and no `--apply`. A lone score flag
 * still takes this path, so `validateTriageFlags` names the missing pair. With
 * neither score flag, the existing paths run unchanged.
 */
function isComputeOnlyTriage(args: CliArgs): boolean {
  return (
    !args.help &&
    args.pr !== null &&
    Number.isInteger(args.pr) &&
    args.pr > 0 &&
    (args.tier !== '' || args.urgency !== '') &&
    args.commentId === null &&
    args.reviewId === null &&
    args.itemTitle === '' &&
    args.itemIndex === null &&
    args.body === '' &&
    !args.apply
  );
}

function triageFlagsFromArgs(args: CliArgs): TriageFlags {
  return {
    tier: args.tier,
    urgency: args.urgency,
    copilotLabel: args.copilotLabel,
    safetyClass: args.safetyClass,
    lite: args.lite,
    advisoryConverged: args.advisoryConverged,
    pathB: args.pathB,
    scopeFence: args.scopeFence,
    protectedAuthority: args.protectedAuthority,
    acceptedMidFix: args.acceptedMidFix,
    adoptNow: args.adoptNow,
    override: args.override,
  };
}

/**
 * Run the compute-only triage mode (#4188). The flags pass the same checks a
 * reply's flags pass, and the value comes from `scoreTriageRecord`, so it is the
 * `Triage:` line a reply with the same flags would carry. Nothing is posted,
 * and no claim is read. The verdict is not repeated on stderr, because the
 * stdout object already carries it. A success returns 0 instead of calling
 * `process.exit`, so the CLI runner sets the exit code after stdout drains
 * (Copilot review on #4266).
 */
function runComputeOnlyTriage(args: CliArgs, pr: number): number {
  if (args.override !== null) {
    const message =
      '--override cannot be combined with a triage-only run: no reply is posted';
    writeStderrSync(`${message}\n`);
    exitClassified(1, 'usage', message);
  }
  const iddConfig = loadIddConfig();
  const triagePolicy = normalizePolicyConfig(iddConfig ?? {}).critiqueLoop;
  const flags = triageFlagsFromArgs(args);
  try {
    validateTriageFlags({
      flags,
      apply: false,
      body: '',
      triageRecord: triagePolicy.triageRecord,
      reviewPolicy: iddConfig?.reviewPolicy,
      deferByUrgency: triagePolicy.deferByUrgency,
    });
  } catch (error) {
    if (!(error instanceof TriageUsageError)) {
      throw error;
    }
    writeStderrSync(`${error.message}\n`);
    exitClassified(1, 'usage', error.message);
  }
  // Scoring reads GitHub only under `severity-tiered` without `--lite`, so the
  // repository lookup runs only then. A failed `gh repo view` cannot block a
  // result that needs no GitHub data (Copilot review on #4266).
  const readsGithub =
    triagePolicy.deferByUrgency === 'severity-tiered' && !args.lite;
  const currentRepo =
    readsGithub && !(args.owner && args.repo)
      ? resolveCurrentGithubRepository()
      : null;
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  let triage: string;
  try {
    const { record } = scoreTriageRecord({
      port,
      pr,
      deferByUrgency: triagePolicy.deferByUrgency,
      deferRelaxAtRounds: triagePolicy.deferRelaxAtRounds,
      flags,
    });
    triage = formatTriageLine(record);
  } catch (error) {
    if (error instanceof TriageUsageError) {
      writeStderrSync(`${error.message}\n`);
      exitClassified(1, 'usage', error.message);
    }
    const source = error instanceof TriageReadError ? error.original : error;
    const classified = classifyHelperError(source);
    writeStderrSync(`triage not computed: ${classified.message}\n`);
    exitClassified(
      1,
      error instanceof TriageReadError ? 'transport' : classified.kind,
      classified.message,
      classified.httpStatus,
    );
  }
  const report: ResolveReviewThreadReport = {
    mode: 'triage',
    prNumber: pr,
    triage,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function main(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  // #4188: the compute-only triage mode takes no target and posts nothing.
  if (isComputeOnlyTriage(args)) {
    return runComputeOnlyTriage(args, args.pr as number);
  }
  // #4012: --review-id selects the body-item target. `!== null` (not
  // `Number.isInteger`) so a malformed but supplied value still selects it
  // and is then refused, rather than falling back to the thread target.
  const bodyItem = args.reviewId !== null;
  if (
    !args.help &&
    (bodyItem || args.itemTitle !== '' || args.itemIndex !== null) &&
    args.commentId !== null
  ) {
    writeStderrSync(
      '--comment-id cannot be combined with --review-id, --item-title, or --item-index\n',
    );
    exitClassified(
      1,
      'usage',
      '--comment-id cannot be combined with --review-id, --item-title, or --item-index',
    );
  }
  const targetValid = bodyItem
    ? Number.isInteger(args.reviewId) &&
      (args.reviewId ?? 0) > 0 &&
      args.itemTitle.trim() !== '' &&
      (args.itemIndex === null ||
        (Number.isInteger(args.itemIndex) && args.itemIndex > 0))
    : Number.isInteger(args.commentId) && (args.commentId ?? 0) > 0;
  if (
    args.help ||
    !Number.isInteger(args.pr) ||
    (args.pr ?? 0) <= 0 ||
    !targetValid
  ) {
    process.stdout.write(USAGE);
    exitClassified(
      args.help ? 0 : 1,
      'usage',
      bodyItem
        ? 'missing or invalid --pr <number>, --review-id <id>, --item-title <title>, or --item-index <n>'
        : 'missing required --pr <number> or --comment-id <id>',
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
  // #4012: a body item has no thread, so the AMD-closing
  // "Rejection confirmed by maintainer" marker is refused there.
  if (bodyItem && args.apply && !hasBodyItemDispositionPrefix(args.body)) {
    writeStderrSync(
      `--apply requires --body to start with one of the accepted body-item disposition markers: ${ACCEPTED_BODY_ITEM_DISPOSITION_MARKERS}\n`,
    );
    exitClassified(
      1,
      'usage',
      `--apply requires --body to start with one of the accepted body-item disposition markers: ${ACCEPTED_BODY_ITEM_DISPOSITION_MARKERS}`,
    );
  }
  if (!bodyItem && args.apply && !hasKnownDispositionMarkerPrefix(args.body)) {
    writeStderrSync(
      `--apply requires --body to start with one of the accepted disposition markers: ${ACCEPTED_DISPOSITION_MARKERS}\n`,
    );
    exitClassified(
      1,
      'usage',
      `--apply requires --body to start with one of the accepted disposition markers: ${ACCEPTED_DISPOSITION_MARKERS}`,
    );
  }
  // #4306: this helper posts a settled reply and, for a thread, resolves it.
  // A body that carries the pending-decision marker is an open question: it
  // settles nothing, and resolving the thread would settle it for the gates
  // that count a resolved thread as done. Fail closed before any network call.
  // #4332: a body item posts a top-level reply and resolves no thread, so its
  // refusal tells the caller how to finish the item, not to leave a thread open.
  if (args.apply && hasPendingDecisionMarker(args.body)) {
    const refusal = pendingBodyRefusal(bodyItem);
    writeStderrSync(`${refusal}\n`);
    exitClassified(1, 'usage', refusal);
  }
  const pr = args.pr as number;
  // Loaded once (#3270): both `markerPrefixRaw` below and `staleAgeMs`
  // (near the forced-handoff options, once claim-scoped work below is known
  // to be needed) come from this single read.
  const iddConfig = loadIddConfig();
  const markerPrefixRaw = iddConfig?.markerPrefix;
  // #4186: the triage flags are refused before the port is created and before
  // any read or gh call. A flag with no line to carry it is a no-op.
  const triagePolicy = normalizePolicyConfig(iddConfig ?? {}).critiqueLoop;
  // #4187: `enforce` refuses only under `severity-tiered`. Under any other mode
  // it behaves as `record` for this call, and the call says so once on stderr.
  const enforceInert =
    triagePolicy.triageRecord === 'enforce' &&
    triagePolicy.deferByUrgency !== 'severity-tiered';
  if (enforceInert) {
    writeStderrSync(
      'warning: triageRecord enforce refuses only under deferByUrgency severity-tiered; treating it as record\n',
    );
  }
  const effectiveTriageRecord = enforceInert
    ? 'record'
    : triagePolicy.triageRecord;
  const triageFlags = triageFlagsFromArgs(args);
  try {
    validateTriageFlags({
      flags: triageFlags,
      apply: args.apply,
      body: args.body,
      triageRecord: effectiveTriageRecord,
      reviewPolicy: iddConfig?.reviewPolicy,
      deferByUrgency: triagePolicy.deferByUrgency,
    });
  } catch (error) {
    if (!(error instanceof TriageUsageError)) {
      throw error;
    }
    writeStderrSync(`${error.message}\n`);
    exitClassified(1, 'usage', error.message);
  }
  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  // `--body` is optional in dry-run. `parseCliArgs` defaults it to '', but
  // coerce anyway so a missing value cannot throw on `.trim()` before the
  // report is written.
  const rawBody = typeof args.body === 'string' ? args.body : '';

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

  // #4186: the Triage line is built once the port exists, because the relax
  // step may read the pull request's reviews and head. A usage error or a
  // failed read exits here, before any mutation.
  let built: ReturnType<typeof buildTriageReplyBody>;
  try {
    built = buildTriageReplyBody({
      port,
      pr,
      rawBody,
      markerPrefix:
        typeof markerPrefixRaw === 'string' ? markerPrefixRaw : undefined,
      deferByUrgency: triagePolicy.deferByUrgency,
      deferRelaxAtRounds: triagePolicy.deferRelaxAtRounds,
      flags: triageFlags,
    });
  } catch (error) {
    if (error instanceof TriageUsageError) {
      writeStderrSync(`${error.message}\n`);
      exitClassified(1, 'usage', error.message);
    }
    // #4186: a failed read of the reviews or the head is kind `transport`, the
    // issue's contract. Any other error keeps the kind the classifier gives it.
    const source = error instanceof TriageReadError ? error.original : error;
    const classified = classifyHelperError(source);
    writeStderrSync(`reply not posted: ${classified.message}\n`);
    exitClassified(
      1,
      error instanceof TriageReadError ? 'transport' : classified.kind,
      classified.message,
      classified.httpStatus,
    );
  }
  const stampedBody = built.body;
  // #4187: an apply judges the verdict twice, and only `enforce` refuses. The
  // early read prints the one verdict line in dry run and apply alike, and it
  // can refuse before any claim or thread read. Under `enforce`,
  // `freshBodyForApply` reads again right before the post, so the review count
  // the post lands under decides. That late read prints a line only when the
  // verdict line changed (its verdict, eligibility, or block), or the call
  // refuses.
  const refusalFor = (verdict: TriageVerdict): string | null =>
    effectiveTriageRecord === 'enforce' &&
    verdict.verdict === 'defer' &&
    DISPOSITION_ACCEPTED_PREFIX_RE.test(args.body.trimEnd()) &&
    triageFlags.override === null
      ? `${verdictLine(verdict)}; pass --override "<reason>" to post anyway`
      : null;
  if (built.verdict !== null) {
    const earlyRefusal = args.apply ? refusalFor(built.verdict) : null;
    if (earlyRefusal !== null) {
      writeStderrSync(`${earlyRefusal}\n`);
      exitClassified(1, 'gate', earlyRefusal);
    }
    writeStderrSync(`${verdictLine(built.verdict)}\n`);
  }
  const freshBodyForApply = (): string => {
    const early = built.verdict;
    // Outside `enforce` nothing refuses, so the early body stands, as in #4186.
    if (effectiveTriageRecord !== 'enforce' || early === null) {
      return built.body;
    }
    const fresh = buildTriageReplyBody({
      port,
      pr,
      rawBody,
      markerPrefix:
        typeof markerPrefixRaw === 'string' ? markerPrefixRaw : undefined,
      deferByUrgency: triagePolicy.deferByUrgency,
      deferRelaxAtRounds: triagePolicy.deferRelaxAtRounds,
      flags: triageFlags,
    });
    if (fresh.verdict !== null) {
      const refusal = refusalFor(fresh.verdict);
      if (refusal !== null) {
        writeStderrSync(`${refusal}\n`);
        throw new TriageRefusedError(refusal);
      }
      const line = verdictLine(fresh.verdict);
      if (line !== verdictLine(early)) {
        writeStderrSync(`${line}\n`);
      }
    }
    return fresh.body;
  };
  if (bodyItem) {
    runBodyItemCli(port, args, {
      pr,
      owner,
      repo,
      iddConfig,
      stampedBody,
      refreshBody: freshBodyForApply,
    });
  }

  const commentId = args.commentId as number;
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
      // Nothing was posted, so the report carries no body (#4187).
      delete report.body;
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
    // Nothing was posted, so the report carries no body (#4187).
    delete report.body;
    report.error = `review thread ${match.threadId} exposes no top-level comment id to reply to`;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    exitClassified(1, 'gate', report.error);
  }

  // Eager: the claim-only setup runs here, before the mutations, as it
  // always has on the thread target.
  const assertClaim = buildClaimAssertion(
    port,
    args,
    { pr, owner, repo, iddConfig },
    { eager: true },
  );

  // Retain the posted reply id across a later failure so a partial apply (reply
  // posted, resolve not confirmed) reports the reply id instead of looking like
  // nothing was posted — that distinguishes "retry the resolve" from "re-post".
  let postedReplyId: number | undefined;
  let postedBody: string | undefined;
  try {
    const result = applyResolveReviewThread({
      assertClaim,
      postReply: () => {
        // The verdict is judged again right before the post (#4187).
        const body = freshBodyForApply();
        // A claim handoff during the late read must not reach the post (#4187).
        assertClaim();
        const posted = port.postReviewCommentReply(pr, rootCommentId, body);
        postedBody = body;
        postedReplyId = posted.id;
        return posted;
      },
      resolveThread: () =>
        port.resolveChangeRequestReviewThread(match.threadId),
    });
    report.status = 'applied';
    report.replyId = result.replyId;
    if (postedBody !== undefined) {
      report.body = postedBody;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    report.status = 'failed';
    if (postedReplyId !== undefined) {
      report.replyId = postedReplyId;
    }
    // Report only the body that reached GitHub, so a refusal shows none (#4187).
    if (postedBody !== undefined) {
      report.body = postedBody;
    } else {
      delete report.body;
    }
    const classified = classifyHelperError(mutationCause(error));
    report.error = (mutationCause(error) as Error).message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    exitClassified(
      1,
      classifyMutationErrorKind(error),
      classified.message,
      classified.httpStatus,
    );
  }
}

/** The error a failed mutation reports: a late triage read reports its own cause (#4187). */
function mutationCause(error: unknown): unknown {
  return error instanceof TriageReadError ? error.original : error;
}

/**
 * Deliberate ownership denials are a completed gate. A tagged gh failure
 * keeps transport/not-found.
 */
function classifyMutationErrorKind(error: unknown): IddHelperErrorKind {
  // The late verdict check keeps the early path's kinds: a refusal is a gate,
  // a refused input is usage, and a failed read is transport (#4187).
  if (error instanceof TriageRefusedError) {
    return 'gate';
  }
  if (error instanceof TriageUsageError) {
    return 'usage';
  }
  if (error instanceof TriageReadError) {
    return 'transport';
  }
  const classified = classifyHelperError(error);
  const message = (error as Error)?.message ?? '';
  return classified.kind === 'transport' || classified.kind === 'not-found'
    ? classified.kind
    : message.startsWith('claim revalidation failed:') ||
        message.startsWith('claim/PR mismatch:') ||
        message.startsWith('--claimless requires a PR')
      ? 'gate'
      : classified.kind;
}

/**
 * Build the per-mutation claim check shared by both targets. With
 * `--claimless` it re-checks eligibility on every call. Otherwise it
 * revalidates the active claim and binds it to the PR's head branch. The
 * claim-only setup (head ref, viewer login, forced-handoff policy) runs once:
 * at build time when `eager`, otherwise on the first call, so a body-item
 * dry-run or a refused lookup never pays for it.
 */
function buildClaimAssertion(
  port: ProviderPort,
  args: CliArgs,
  context: {
    pr: number;
    owner: string;
    repo: string;
    iddConfig: ReturnType<typeof loadIddConfig>;
  },
  options: { eager?: boolean } = {},
): () => void {
  const { pr, owner, repo, iddConfig } = context;
  // #2616: this claim-only setup is unneeded (and un-skippable) network/
  // identity work for --claimless -- a credential that can read/update
  // PRs but cannot resolve a viewer identity (e.g. some GitHub App
  // installation-token setups) must not abort here when neither the
  // viewer nor the claimed branch is ever consulted in this mode (Codex
  // review on this PR).
  let setup: {
    prHeadRef: string;
    isTrustedAuthor: (login: string) => boolean;
    forcedHandoffOptions: ForcedHandoffGateOptions;
    staleAgeMs: number;
  } | null = null;
  const claimSetup = (): NonNullable<typeof setup> => {
    if (setup) {
      return setup;
    }
    // Bind the mutation to the claimed PR: the active claim's branch must be
    // the PR's head branch, so a valid claim on the issue cannot be used to
    // reply on some other PR passed as --pr.
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
    setup = {
      prHeadRef,
      isTrustedAuthor,
      forcedHandoffOptions: {
        forcedHandoffEnabled,
        isAuthorizedForcedHandoff: (forcedBy) =>
          isAuthorizedForcedHandoffActor(
            owner,
            repo,
            forcedBy,
            forcedHandoffAuthorityPolicy,
            forcedHandoffPermissionCache,
          ),
      },
      // #3270: the configured claimTiming.staleAge window.
      staleAgeMs: readClaimStaleAgeMs(iddConfig),
    };
    return setup;
  };
  if (options.eager && !args.claimless) {
    claimSetup();
  }
  return () => {
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
    const { prHeadRef, isTrustedAuthor, forcedHandoffOptions, staleAgeMs } =
      claimSetup();
    const active = activeOwnedClaim(
      port,
      args.claimIssue as number,
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
  };
}

/**
 * The body-item CLI path (#4012): look the item up, then print the dry-run
 * plan or post the stamped top-level comment. Always exits.
 */
function runBodyItemCli(
  port: ProviderPort,
  args: CliArgs,
  context: {
    pr: number;
    owner: string;
    repo: string;
    iddConfig: ReturnType<typeof loadIddConfig>;
    stampedBody: string;
    /** The late verdict check's body builder, for an apply (#4187). */
    refreshBody: () => string;
  },
): never {
  const { pr, stampedBody } = context;
  const report: ResolveReviewThreadReport = {
    mode: args.apply ? 'apply' : 'dry-run',
    prNumber: pr,
    reviewId: args.reviewId as number,
    itemTitle: normalizePreviouslyMissedItemTitle(args.itemTitle),
    ...(stampedBody ? { body: stampedBody } : {}),
  };
  try {
    const result = runBodyItemDisposition(port, {
      pr,
      reviewId: args.reviewId as number,
      itemTitle: args.itemTitle,
      itemIndex: args.itemIndex,
      stampedBody,
      apply: args.apply,
      assertClaim: buildClaimAssertion(port, args, context),
      refreshBody: context.refreshBody,
    });
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    if (result.exitCode === 0) {
      process.exit(0);
    }
    exitClassified(1, 'gate', result.report.error ?? 'body item not found');
  } catch (error) {
    const classified = classifyHelperError(mutationCause(error));
    if (args.apply) {
      report.status = 'failed';
      // Nothing reached GitHub when the late check fails or refuses (#4187).
      delete report.body;
    }
    report.error = (mutationCause(error) as Error).message;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    exitClassified(
      1,
      classifyMutationErrorKind(error),
      classified.message,
      classified.httpStatus,
    );
  }
}
