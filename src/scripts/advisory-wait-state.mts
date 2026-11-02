#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-wait-state.mts
//
// The scripts/advisory-wait-state.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import {
  advisoryWaitSectionIsValid,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySecondaryBotLogins,
  readAdvisoryWaitPolicy,
  resolveEffectiveAdvisoryTerminalWindowMinutes,
  resolveProviderOutageTerminalWindowMinutes,
} from './advisory-wait-policy.mts';
import { parseCliArgs } from './cli-args.mts';
import {
  type AuthorityEvidence,
  normalizeAuthorityEvidence,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  advisoryWaitFamilyMarkerStart,
  buildAdvisoryWaitSummary,
  classifyCommentEditState,
  compareIsoTimestamps,
  computeCopilotPendingCoversHead,
  findLastCopilotDeclineCommit,
  findLastCopilotReviewCommit,
  isCopilotPending,
  isValidIsoTimestamp,
  NOW_FLAG_USAGE_MESSAGE,
  normalizeNowFlag,
  normalizeTrustedMarkerLogins,
  parseAdvisoryRecoveryComment,
  resolveTrustedMarkerActors,
  type TrustedMarkerActorResolution,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import { resolveProviderOutageDeclaration } from './provider-outage-declaration.mts';
import type { ProviderComment, ProviderPort } from './provider-port.mts';

/** One issue comment, in the shape `resolveProviderOutageDeclaration` expects. */
interface IssueCommentPayload {
  body?: string | null;
  created_at?: string | null;
  user?: { login?: string | null } | null;
  /** #3249: see `ProviderComment.lastEditedAt`'s doc comment (provider-
   * port.mts) for the three-state contract. */
  last_edited_at?: string | null;
}

function toIssueCommentPayload(comment: ProviderComment): IssueCommentPayload {
  return {
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.authorLogin },
    // #3249: carried through to the `CommentLike`-compatible shape
    // `resolveProviderOutageDeclaration` reads -- never derived from
    // `updatedAt`/`updated_at`. `undefined` unless the caller opted into
    // `includeEditState`.
    last_edited_at: comment.lastEditedAt,
  };
}

// #2554 (Copilot review, PR #2564 round 4): resolve whether a
// repository-scoped `providerOutage.declarationTarget` declaration is
// active for the `idd-advisory-convergence` selector, so this CLI's own
// terminal-unavailability verdict agrees with the SAME evidence
// `pre-merge-readiness.mts` and `advisory-convergence.mts` independently
// resolve for their own terminal-window gating -- without this, an active
// declaration could shorten the window in those two gates while this AW
// loop still measured against the full base window, disagreeing on
// terminal state and confusing the loop's next-action decision. Fails
// closed to `false` on ANY error (unset target, unreadable/unparseable
// comments, authority-lookup failure): a transient fetch failure must
// never shorten the terminal-unavailability window this gates.
function resolveOutageDeclarationActiveForConvergenceSelector({
  port,
  owner,
  repo,
  iddConfig,
  now,
}: {
  port: ProviderPort;
  owner: string;
  repo: string;
  iddConfig: unknown;
  now: string;
}): boolean {
  try {
    const policy = normalizePolicyConfig(iddConfig);
    const targetIssue = policy.providerOutage.declarationTarget;
    if (!targetIssue) return false;
    // #3249: `includeEditState` so `resolveProviderOutageDeclaration` can
    // reject a body-edited declaration marker. Safe inside this function's
    // existing fail-closed try/catch: a GraphQL failure here degrades to
    // `false` (declaration not active), never a crash.
    const declarationComments = port
      .listWorkItemComments(targetIssue, { includeEditState: true })
      .map(toIssueCommentPayload);
    const authorityOf = (actorLogin: string): AuthorityEvidence =>
      normalizeAuthorityEvidence(
        resolveCollaboratorAuthority({ owner, repo, actor: actorLogin }),
        actorLogin,
        owner,
        policy.ciGate.externalCheckWaivers.authorityPolicy,
      );
    return resolveProviderOutageDeclaration({
      declarationTargetConfigured: true,
      comments: declarationComments,
      service: DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      policy,
      authorityOf,
      now: new Date(now),
    }).active;
  } catch {
    return false;
  }
}

/** Author reference embedded in GitHub REST payloads. */
interface GhAuthorPayload {
  login?: string | null;
  /** REST `user.type` ("Bot"/"User"/...). `listReviews` returns the raw
   * payload, and `findLastCopilotReviewCommit` reads this field (#3262). */
  type?: string | null;
}

/** PR review payload fields consumed by the advisory-wait summary. */
interface ReviewPayload {
  state?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  commit_id?: string | null;
  /** #3015: consumed by `findLastCopilotReviewCommit`
   * (protocol-helpers.mts) to decide whether this review counts as
   * covering its `commit_id`. For a configured non-Copilot primary bot,
   * only the exact #3015 "encountered an error" template is excluded;
   * as of #3265, for the DEFAULT Copilot bot, only a body
   * `classifyCopilotReviewBody` recognizes as `overview-v2` or
   * `overview-legacy` counts at all. */
  body?: string | null;
}

/** Timeline event payload fields consumed by the Copilot coverage check. */
interface TimelineEventPayload {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: GhAuthorPayload | null;
}

/** Parsed CLI arguments. */
interface AdvisoryWaitStateArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  trustedMarkerLogins: string;
  claimId: string;
  agentId: string;
  now: string;
  /** `--wait` as typed, or `null` when the flag is absent (#4378). */
  wait: string | null;
  /** `--poll-interval` as typed, or `null` when the flag is absent. */
  pollInterval: string | null;
  help: boolean;
}

/** Minimal comment shape consumed by {@link buildCopilotRecoverySummary}. */
interface CopilotRecoveryCommentLike {
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
  /** #3249: see `classifyCommentEditState`'s doc comment (protocol-
   * helpers.mts) for the three-state contract. */
  lastEditedAt?: string | null;
}

/**
 * `#1572` terminal Copilot-unavailability state: the recovery-cycle cap
 * accounting, the trusted terminal clock anchor, and the fail-closed
 * `COPILOT_UNAVAILABLE` / `NOT_TERMINAL` determination. Deliberately a
 * standalone object -- the existing `outcome` / `f3Outcome` fields computed
 * by the untouched `buildAdvisoryWaitSummary` never read from it, and it
 * never reads from or feeds any advisory-satisfied field. Consumers may
 * treat `state: "COPILOT_UNAVAILABLE"` only as waiver *eligibility*
 * (idd-advisory-wait.instructions.md), never as advisory satisfaction on
 * its own.
 */
export interface CopilotRecoverySummary {
  /** Configured per-PR-HEAD recovery-cycle cap (default 2). */
  cap: number;
  /**
   * Count of structurally valid, trusted-author, active-claim-bound,
   * current-HEAD-bound `advisory-recovery` markers with a valid server
   * `created_at`. A completed cycle is counted by marker *presence*, never
   * by the largest embedded `attempt` number (that field is a diagnostic
   * only). Edited or unresolved edit state still consumes this restrictive
   * budget, but only explicitly unedited markers may anchor the clock.
   */
  completedCycleCount: number;
  /** `max(cap - completedCycleCount, 0)`. */
  remainingBudget: number;
  /** `completedCycleCount >= cap`. */
  capExhausted: boolean;
  /** Configured terminal-unavailability window in minutes (default 720). */
  terminalWindowMinutes: number;
  /**
   * GitHub `created_at` of the *earliest* explicitly unedited, trusted,
   * bound, current-HEAD `advisory-recovery` marker; `''` when none exists.
   * Embedded marker timestamps are diagnostics only and never move this
   * anchor -- only the GitHub-assigned comment `created_at` counts,
   * mirroring the `review-watermark` / claim-heartbeat clock rule elsewhere
   * in this protocol.
   */
  clockAnchor: string;
  /** Minutes between `clockAnchor` and `now`; `0` when there is no anchor. */
  elapsedMinutes: number;
  /** `clockAnchor !== '' && elapsedMinutes >= terminalWindowMinutes`. */
  windowElapsed: boolean;
  /**
   * `true` only when both a claim id and an agent id were supplied to bind
   * the active claim. Without both, no marker can be proven to belong to
   * the current claim, so evidence is incomplete and the state fails closed
   * to `NOT_TERMINAL`.
   */
  activeClaimProvided: boolean;
  /** `COPILOT_UNAVAILABLE` only when every proof condition holds; else `NOT_TERMINAL`. */
  state: 'NOT_TERMINAL' | 'COPILOT_UNAVAILABLE';
  /** Machine-readable reason for the current `state`. */
  reason: string;
}

const COPILOT_RECOVERY_REASONS = {
  activeClaimNotProvided: 'active-claim-not-provided',
  noTrustedRecoveryMarkers: 'no-trusted-recovery-markers',
  capNotExhausted: 'recovery-cap-not-exhausted',
  windowNotElapsed: 'terminal-window-not-elapsed',
  currentHeadReviewExists: 'current-head-review-exists',
  copilotDeclinedNoReviewableFiles: 'copilot-declined-no-reviewable-files',
  copilotUnavailable:
    'recovery-cap-exhausted-and-terminal-window-elapsed-and-no-current-head-review',
} as const;

function minutesBetweenIso(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

/**
 * Compute the `#1572` terminal Copilot stall-recovery state from
 * already-fetched PR comments plus the already-computed
 * `buildAdvisoryWaitSummary` evidence (`prHeadSha`, `lastCopilotCommit`).
 * Pure and network-free -- issues no `gh` calls of its own, so calling it
 * twice with the same input is trivially idempotent, and its output is a
 * deterministic function of the observed marker *set* (order-independent),
 * matching `findActivationNonceWinner`'s and `summarizeAdvisoryWaitMarkers`'s
 * shared "re-read must reconverge" design.
 *
 * A structurally valid, claim- and HEAD-bound `advisory-wait-recovery:`
 * comment counts as one completed recovery cycle after the server-created
 * timestamp validates. Edit state is split deliberately: an edited or
 * unresolved marker still consumes the restrictive cycle budget so editing
 * an old marker cannot reopen an exhausted cap, but it never contributes to
 * the trusted `clockAnchor` (fail closed; never a whole-computation abort):
 *  - the comment author is a trusted marker actor (else: untrusted);
 *  - the body parses as the BOUND form via `parseAdvisoryRecoveryComment`
 *    (a malformed body, or the legacy unbound 3-field form, both parse to
 *    `null`: malformed / unbound);
 *  - the marker's `agentId` equals the supplied `agentId` (else:
 *    foreign-agent);
 *  - the marker's `claimId` equals the supplied `claimId` (else:
 *    mismatched-claim);
 *  - the marker's `headSha` equals `prHeadSha` (else: mismatched-HEAD,
 *    including both an earlier and a later HEAD than the current one);
 *  - the comment's GitHub `created_at` validates as an ISO 8601 UTC
 *    timestamp (else: ambiguous-created-at -- excluded from BOTH counting
 *    and anchoring, never counted with a missing anchor contribution);
 *  - `lastEditedAt` is explicitly `null` to contribute the trusted clock
 *    anchor (otherwise it still consumes budget but contributes no anchor).
 */
export function buildCopilotRecoverySummary(
  {
    comments = [],
    prHeadSha,
    lastCopilotCommit,
    copilotDeclinedHead = false,
  }: {
    comments?: CopilotRecoveryCommentLike[];
    prHeadSha: string;
    lastCopilotCommit: string;
    /**
     * True when the latest default-Copilot review names the current head with
     * the "wasn't able to review any files" decline (see
     * `findLastCopilotDeclineCommit`). Copilot can only decline a head whose
     * changed files are all excluded, so later runs on that head cannot
     * change the outcome.
     */
    copilotDeclinedHead?: boolean;
  },
  options: {
    now: string;
    trustedMarkerLogins?: unknown[] | null;
    claimId?: string | null;
    agentId?: string | null;
    recoveryCycleCap?: number;
    terminalWindowMinutes?: number;
  },
): CopilotRecoverySummary {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  // Validate the raw string WITHOUT lowercasing first, matching
  // buildAdvisoryWaitSummary's convention (protocol-helpers.mts): callers
  // are expected to already supply a canonical lowercase SHA (e.g. from
  // buildAdvisoryWaitSummary's own output), and an uppercase SHA is
  // rejected rather than silently normalized -- lowercasing before
  // validation would accept input the error message claims is rejected.
  const normalizedPrHeadSha = String(prHeadSha ?? '');
  if (!/^[0-9a-f]{40}$/.test(normalizedPrHeadSha)) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const cap = normalizePositiveIntegerOption(
    options.recoveryCycleCap,
    DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  );
  const terminalWindowMinutes = normalizePositiveNumberOption(
    options.terminalWindowMinutes,
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const claimId = String(options.claimId ?? '').trim();
  const agentId = String(options.agentId ?? '').trim();
  const activeClaimProvided = claimId !== '' && agentId !== '';

  let completedCycleCount = 0;
  let clockAnchor = '';

  if (activeClaimProvided) {
    for (const comment of comments) {
      const login = String(comment?.author?.login ?? '')
        .trim()
        .toLowerCase();
      if (!trustedLogins.has(login)) {
        continue; // untrusted
      }
      const marker = parseAdvisoryRecoveryComment(
        String(comment?.body ?? ''),
        String(comment?.createdAt ?? ''),
      );
      if (!marker) {
        continue; // malformed or the legacy unbound form
      }
      if (marker.agentId !== agentId) {
        continue; // foreign-agent
      }
      if (marker.claimId !== claimId) {
        continue; // mismatched-claim
      }
      if (marker.headSha !== normalizedPrHeadSha) {
        continue; // mismatched-HEAD (earlier or later)
      }
      if (!isValidIsoTimestamp(marker.createdAt)) {
        // Ambiguous server createdAt (parse helpers set this to 'none' when
        // the caller-supplied timestamp did not validate): exclude from
        // BOTH cycle counting and clock anchoring, not anchoring alone.
        // Otherwise an evidence gap could still consume recovery-cycle
        // budget without ever contributing a trustworthy clock anchor,
        // contradicting the "both counting and anchoring must be derived
        // from trusted server-created_at evidence" fail-closed contract.
        continue;
      }
      completedCycleCount += 1;
      // #3249: editing a structurally valid marker must not reopen the
      // bounded recovery budget, but edited or unresolved content cannot
      // provide the terminal clock evidence.
      if (classifyCommentEditState(comment) !== 'unedited') {
        continue;
      }
      if (
        !clockAnchor ||
        compareIsoTimestamps(marker.createdAt, clockAnchor) < 0
      ) {
        clockAnchor = marker.createdAt;
      }
    }
  }

  const remainingBudget = Math.max(cap - completedCycleCount, 0);
  const capExhausted = completedCycleCount >= cap;
  const elapsedMinutes = clockAnchor ? minutesBetweenIso(clockAnchor, now) : 0;
  const windowElapsed =
    clockAnchor !== '' && elapsedMinutes >= terminalWindowMinutes;
  const currentHeadReviewExists =
    String(lastCopilotCommit ?? '').toLowerCase() === normalizedPrHeadSha;

  let state: CopilotRecoverySummary['state'] = 'NOT_TERMINAL';
  let reason: string;
  // The decline is terminal at once, so it is checked before the clock and
  // cap gates. It is placed after the active-claim check so a caller that
  // cannot bind the claim still fails closed to NOT_TERMINAL, the same as
  // every other terminal route. The decline is a GitHub-authored review body,
  // not a marker, so no trust filter applies to it.
  if (!activeClaimProvided) {
    reason = COPILOT_RECOVERY_REASONS.activeClaimNotProvided;
  } else if (copilotDeclinedHead) {
    state = 'COPILOT_UNAVAILABLE';
    reason = COPILOT_RECOVERY_REASONS.copilotDeclinedNoReviewableFiles;
  } else if (clockAnchor === '') {
    reason = COPILOT_RECOVERY_REASONS.noTrustedRecoveryMarkers;
  } else if (!capExhausted) {
    reason = COPILOT_RECOVERY_REASONS.capNotExhausted;
  } else if (!windowElapsed) {
    reason = COPILOT_RECOVERY_REASONS.windowNotElapsed;
  } else if (currentHeadReviewExists) {
    reason = COPILOT_RECOVERY_REASONS.currentHeadReviewExists;
  } else {
    state = 'COPILOT_UNAVAILABLE';
    reason = COPILOT_RECOVERY_REASONS.copilotUnavailable;
  }

  return {
    cap,
    completedCycleCount,
    remainingBudget,
    capExhausted,
    terminalWindowMinutes,
    clockAnchor,
    elapsedMinutes,
    windowElapsed,
    activeClaimProvided,
    state,
    reason,
  };
}

/**
 * `#1571` bounded stale-request recovery classification: whether the current
 * Copilot request should be recovered by an E14/F2 caller right now. Pure and
 * network-free -- takes already-computed evidence (the shared AW1-AW3 fields
 * plus the `#1572` recovery-cycle budget) and returns a decision only; it
 * performs no `gh` mutation itself. Deliberately distinct from the
 * pre-existing `RECOVERY_NEEDED` outcome (`AW3-R` in
 * idd-advisory-wait.instructions.md), which anchors a missing same-head marker
 * for a request the timeline already PROVES covers the current HEAD.
 *
 * Two independent unproven-coverage entry conditions feed the same bounded
 * cycle (`copilotPendingCoversHead: false` in both):
 *  - the original pending case (PR #1562) -- a request is currently pending
 *    but the timeline never proved it covers this HEAD, so the pending
 *    request itself may be stale and mutating it (remove + re-request) is the
 *    correct recovery;
 *  - the non-pending "failed to register" case (`#2327`) -- a same-head
 *    `advisory-wait:` request marker already exists, Copilot never shows
 *    pending at all, and the existing `SETTLED_WINDOW_MINUTES` re-check
 *    budget has elapsed with no `review_requested` event ever proving the
 *    request reached Copilot, and no completed Copilot review names the current
 *    HEAD (#4718). Below that budget the gap reads as ordinary
 *    lag, not failure.
 */
export interface StaleRequestRecoveryAction {
  /**
   * `'attempt'` -- an unproven request for the current HEAD (pending, or
   * non-pending with the re-check budget spent) and recovery-cycle budget
   * remains: an E14/F2 caller may run the bounded cycle (`AW3-S`).
   * `'cap-exhausted'` -- the same unproven condition holds, but the
   * independent recovery-cycle cap (`#1572`) is already exhausted for this
   * HEAD: do not mutate; fall back to the ordinary `CAP_EXHAUSTED_ROUTE`
   * handling instead.
   * `'not-applicable'` -- no stale-request recovery decision applies (no
   * claim-bound evidence, nothing was ever requested, the request is already
   * proven to cover HEAD (a `review_requested` event, or a completed Copilot
   * review of the current HEAD), a pending same-head marker already anchors
   * the clock, or a non-pending re-check budget has not yet elapsed).
   */
  action: 'attempt' | 'cap-exhausted' | 'not-applicable';
  /** Machine-readable reason for `action`. */
  reason: string;
}

const STALE_REQUEST_RECOVERY_REASONS = {
  copilotDeclinedNoReviewableFiles: 'copilot-declined-no-reviewable-files',
  activeClaimNotProvided: 'active-claim-not-provided',
  notPending: 'not-pending',
  sameHeadMarkerPresent: 'same-head-marker-present',
  // A review_requested event or a completed Copilot review (#4718) proves the
  // request reached the reviewer for the current HEAD.
  provenCoversHead: 'proven-covers-head',
  capExhausted: 'recovery-cap-exhausted',
  attemptEligible: 'recovery-attempt-eligible',
  recheckBudgetUnspent: 'recheck-budget-unspent',
  nonPendingAttemptEligible: 'non-pending-recovery-attempt-eligible',
  recoveryMarkerOnly: 'recovery-marker-only-no-request-marker',
} as const;

/**
 * #4877: true when a completed Copilot review names `prHeadSha`. The review
 * list is narrowed to that head before the latest review is chosen, so a
 * later review of an older commit cannot hide an earlier review of the
 * current head. The pending path uses this; the non-pending path keeps
 * comparing the latest review's commit.
 */
export function hasCurrentHeadCopilotReview(
  reviews: ReviewPayload[],
  prHeadSha: string,
  primaryBotLogin: string,
): boolean {
  const headSha = prHeadSha.toLowerCase();
  return (
    findLastCopilotReviewCommit(
      reviews.filter(
        (review) => String(review.commit_id ?? '').toLowerCase() === headSha,
      ),
      primaryBotLogin,
    ) !== ''
  );
}

export function evaluateStaleRequestRecoveryAction(input: {
  copilotPending: boolean;
  copilotPendingCoversHead: boolean;
  sameHeadMarkerPresent: boolean;
  remainingBudget: number;
  /**
   * True when the head carries Copilot's terminal "wasn't able to review any
   * files" decline. A recovery cycle cannot change that outcome, so this
   * never returns `attempt`.
   */
  copilotDeclinedHead?: boolean;
  /**
   * Mirrors {@link CopilotRecoverySummary.activeClaimProvided}: `true` only
   * when the caller supplied both `--claim-id` and `--agent-id` so the
   * recovery-cycle budget in `remainingBudget` is actually derived from
   * claim-bound marker evidence, not just defaulted to the full cap. AW3-S
   * requires claim binding to authorize a mutation (kurone-kito/idd-skill#1645
   * review); omitting this check would let an unbound `remainingBudget`
   * (which reads as the full cap when no evidence was ever counted) produce
   * `"attempt"` without proof no cycle has already run.
   */
  activeClaimProvided: boolean;
  /**
   * `#2327`: true only when a trusted same-HEAD marker is specifically the
   * plain request form (`advisory-wait:`), excluding
   * `advisory-wait-recovery:` (mirrors
   * `AdvisoryWaitMarkerSummary.sameHeadRequestMarkerPresent`). Only consulted
   * on the non-pending path below -- `sameHeadMarkerPresent` alone cannot
   * distinguish "a request was actually made for this HEAD" from "only a
   * prior recovery cycle's own marker exists," and the non-pending entry must
   * never treat recovery-marker-only evidence as proof a request was
   * requested. Omitted/missing fails closed to `false` (no request marker).
   */
  sameHeadRequestMarkerPresent?: boolean;
  /**
   * `#2327`: minutes since the earliest same-head advisory-wait marker
   * (mirrors `buildAdvisoryWaitSummary`'s own `elapsedMinutes`). Only
   * consulted on the non-pending path below; omitted or non-finite fails
   * closed to "budget not yet spent" -- ambiguous elapsed evidence must never
   * read as failure.
   */
  elapsedMinutes?: number;
  /**
   * `#2327`: the configured `SETTLED_WINDOW_MINUTES` re-check budget reused
   * (not a new config value) as the non-pending entry's failed-to-register
   * threshold. Same fail-closed-on-ambiguous treatment as `elapsedMinutes`.
   */
  settledWindowMinutes?: number;
  /**
   * True when a completed Copilot review names the current PR HEAD. On the
   * non-pending path this is the latest review (the caller's
   * `lastCopilotCommit`, after the #3265 overview-body filter). On the
   * pending path it is any such review, found by
   * {@link hasCurrentHeadCopilotReview} (#4877). Such a review proves the
   * request reached the reviewer, so the path returns `not-applicable`
   * (`proven-covers-head`) before the cap check: on the pending path after
   * its same-head and covers-head checks, and on the non-pending path before
   * the elapsed and cap checks. Omitted or `false` keeps the existing routing.
   */
  currentHeadReviewExists?: boolean;
}): StaleRequestRecoveryAction {
  if (!input.activeClaimProvided) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.activeClaimNotProvided,
    };
  }

  if (input.copilotDeclinedHead === true) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.copilotDeclinedNoReviewableFiles,
    };
  }

  if (input.copilotPending) {
    // A same-head marker (ordinary `advisory-wait:` OR a prior recovery
    // cycle's `advisory-wait-recovery:`) already anchors this HEAD's clock --
    // mirrors evaluateAdvisoryWaitOutcome's own `!sameHeadMarkerPresent` gate
    // for both its RECOVERY_NEEDED and REQUEST_NEEDED/CAP_EXHAUSTED branches,
    // so this classifier never contradicts the shared outcome machine's
    // routing.
    if (input.sameHeadMarkerPresent) {
      return {
        action: 'not-applicable',
        reason: STALE_REQUEST_RECOVERY_REASONS.sameHeadMarkerPresent,
      };
    }
    if (input.copilotPendingCoversHead) {
      return {
        action: 'not-applicable',
        reason: STALE_REQUEST_RECOVERY_REASONS.provenCoversHead,
      };
    }
    // A completed Copilot review of this HEAD is the same proof the
    // non-pending path uses below (#4718): the pending request reached the
    // reviewer. Checked before the cap, so an exhausted budget still yields
    // proven-covers-head when that review exists (#4877).
    if (input.currentHeadReviewExists === true) {
      return {
        action: 'not-applicable',
        reason: STALE_REQUEST_RECOVERY_REASONS.provenCoversHead,
      };
    }
    if (input.remainingBudget <= 0) {
      return {
        action: 'cap-exhausted',
        reason: STALE_REQUEST_RECOVERY_REASONS.capExhausted,
      };
    }
    return {
      action: 'attempt',
      reason: STALE_REQUEST_RECOVERY_REASONS.attemptEligible,
    };
  }

  // Non-pending (`#2327`): nothing was ever requested for this HEAD yet --
  // preserves the pre-#2327 behavior exactly, routing to E14's ordinary
  // REQUEST_NEEDED path rather than a recovery cycle.
  if (!input.sameHeadMarkerPresent) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.notPending,
    };
  }
  // A same-head marker exists, but not specifically a plain request marker --
  // only a prior recovery cycle's own `advisory-wait-recovery:` marker
  // anchors this HEAD. That marker is not proof an ordinary request was
  // requested for this HEAD, so it must never itself unlock a further cycle;
  // the recovery-cycle counter (not this predicate) is what already bounds
  // repeated recovery attempts.
  if (!input.sameHeadRequestMarkerPresent) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.recoveryMarkerOnly,
    };
  }
  // A `review_requested` event for the bot DID eventually follow this HEAD's
  // commit -- Copilot genuinely received the request and is simply no longer
  // pending (completed or silently declined), not a failed-to-register case.
  if (input.copilotPendingCoversHead) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.provenCoversHead,
    };
  }
  // A completed Copilot review of this HEAD is the same kind of proof: the
  // request reached the reviewer, so the same-head marker's elapsed budget
  // cannot mean a failed registration. Checked before the elapsed and cap
  // checks below, and only on this non-pending path (#4718).
  if (input.currentHeadReviewExists === true) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.provenCoversHead,
    };
  }
  const elapsedMinutes = Number(input.elapsedMinutes);
  const settledWindowMinutes = Number(input.settledWindowMinutes);
  if (
    !Number.isFinite(elapsedMinutes) ||
    !Number.isFinite(settledWindowMinutes) ||
    elapsedMinutes < settledWindowMinutes
  ) {
    return {
      action: 'not-applicable',
      reason: STALE_REQUEST_RECOVERY_REASONS.recheckBudgetUnspent,
    };
  }
  if (input.remainingBudget <= 0) {
    return {
      action: 'cap-exhausted',
      reason: STALE_REQUEST_RECOVERY_REASONS.capExhausted,
    };
  }
  return {
    action: 'attempt',
    reason: STALE_REQUEST_RECOVERY_REASONS.nonPendingAttemptEligible,
  };
}

/**
 * `#1571` head-race guard: a pure, string-normalized comparison an E14/F2
 * caller must re-run immediately before every mutating step of the bounded
 * recovery cycle (removal, re-request, association verification, marker
 * post) -- see `idd-advisory-wait.instructions.md`'s `AW3-S`. A `true` result
 * means either the branch moved between the last-known HEAD and this check,
 * or a comparison side is missing or not a full 40-hex commit SHA (fails
 * closed on ambiguous evidence the same way an equal-but-abbreviated or
 * equal-but-empty pair would otherwise misread as "unchanged"): the caller
 * must abort the current attempt without mutating or counting a cycle, and
 * restart evaluation fresh (return to E1) against the new HEAD.
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
export function detectRecoveryHeadRace(
  expectedHeadSha: string,
  currentHeadSha: string,
): boolean {
  const expected = String(expectedHeadSha ?? '')
    .trim()
    .toLowerCase();
  const current = String(currentHeadSha ?? '')
    .trim()
    .toLowerCase();
  // Fail closed on missing OR ambiguous evidence: a comparison side that is
  // empty, or that is not a full 40-hex commit SHA (e.g. an abbreviated
  // SHA), is not proof HEAD is stable -- even when both sides are identical
  // non-full-SHA strings, so a naive equality would misread it as
  // "unchanged". Treating either case as "no race" would let a recovery
  // mutation proceed on an unresolved or ambiguous HEAD value
  // (kurone-kito/idd-skill#1645 review).
  const fullShaPattern = /^[0-9a-f]{40}$/;
  if (!fullShaPattern.test(expected) || !fullShaPattern.test(current)) {
    return true;
  }
  return expected !== current;
}

/** Minimal timeline event shape consumed by {@link verifyRecoveryRequestCoversHead}. */
interface RecoveryTimelineEventLike {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: { login?: string | null } | null;
}

/**
 * `#1571` post-mutation association proof: after a recovery cycle's
 * remove-then-re-request completes, re-fetch the PR timeline for the current
 * HEAD and call this to verify the fresh request is provably associated with
 * it (a `review_requested` event for the configured primary bot strictly
 * after the current HEAD's `committed` event) before posting the bound
 * `advisory-recovery` marker. Delegates to the same proof
 * {@link evaluateStaleRequestRecoveryAction}'s caller uses to detect
 * staleness in the first place (`computeCopilotPendingCoversHead`) -- reusing
 * one proof for both directions keeps them from silently diverging. Returns
 * `false` (fails closed, do not post the marker or count a cycle) on missing
 * or ambiguous timeline evidence, exactly like the staleness check.
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
export function verifyRecoveryRequestCoversHead(
  timelineEvents: RecoveryTimelineEventLike[],
  prHeadSha: string,
  primaryBotLogin?: string,
): boolean {
  return computeCopilotPendingCoversHead(
    timelineEvents,
    prHeadSha,
    primaryBotLogin,
  );
}

function normalizePositiveIntegerOption(
  value: unknown,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizePositiveNumberOption(
  value: unknown,
  fallback: number,
): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * JSON state document printed by this CLI: the advisory-wait gate
 * evidence summary plus the trusted-marker actor provenance fields.
 */
export type AdvisoryWaitStateReport = ReturnType<
  typeof buildAdvisoryWaitSummary
> & {
  trustedMarkerActors: string[];
  trustedMarkerActorsSource: TrustedMarkerActorResolution['source'];
  copilotRecovery: CopilotRecoverySummary;
  staleRequestRecovery: StaleRequestRecoveryAction;
  /**
   * `--wait` only (#4378): whole seconds the call spent waiting, rounded
   * down. Absent without `--wait`.
   */
  waitedSeconds?: number;
  /** `--wait` only: why the wait ended. Absent without `--wait`. */
  waitEnded?: AdvisoryWaitEnded;
};

/**
 * Why a `--wait` call returned. The precedence is `head-changed`, then
 * `settled`, then `bound-elapsed`.
 */
export type AdvisoryWaitEnded = 'settled' | 'bound-elapsed' | 'head-changed';

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
const ADVISORY_WAIT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  // #1572: OPTIONAL. When both --claim-id and --agent-id are supplied, the
  // `copilotRecovery` section binds to the active claim; when either is
  // absent, `copilotRecovery` fails closed to NOT_TERMINAL with
  // reason: active-claim-not-provided, and every other field this CLI
  // already prints is unaffected.
  '--claim-id': { type: 'string', default: '' },
  '--agent-id': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  // #4378: no `default` on purpose -- an explicit empty value must stay
  // distinguishable from an absent flag, so `--wait ''` is a malformed
  // duration (usage error) and not a silent no-wait run.
  '--wait': { type: 'string' },
  '--poll-interval': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

// #4378: declared here, above the import.meta.main trigger, for the same
// temporal-dead-zone reason as the flag spec above -- main() reads both while
// the module is still being evaluated.
/**
 * The longest `--wait`: one call, start-up and the last read included, ends
 * before the 600000 ms foreground limit of a tool call.
 */
const MAX_WAIT_MS = 8 * 60 * 1000;
/** The shortest explicit `--poll-interval`, and the fallback interval. */
const MIN_POLL_INTERVAL_MS = 60 * 1000;
const WAIT_FLAG_USAGE_MESSAGE =
  '--wait must be an ISO 8601 duration of at least one second and at most PT8M (for example PT5M)';
const POLL_INTERVAL_FLAG_USAGE_MESSAGE =
  '--poll-interval must be an ISO 8601 duration of at least PT60S and at most --wait (for example PT2M)';

if (import.meta.main) {
  // #3344: call main() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('advisory-wait-state', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

/**
 * Resolve the CLI's own `--now` flag at the argument-handling boundary
 * (#3541), before it ever reaches {@link buildAdvisoryWaitSummary}'s
 * `isValidIsoTimestamp` gate (that gate, and its existing test fixtures,
 * stay unchanged). A non-empty value normalizes through
 * {@link normalizeNowFlag}, returning `now: ''` plus a one-line `error`
 * naming `--now` and its accepted shapes instead of forwarding a malformed
 * value into the pure summary builder.
 *
 * An empty `rawNow` (the flag omitted) returns `now: ''` too, WITHOUT
 * sampling the real current time here (Codex review, PR #3551): this
 * file's pre-existing behavior samples `new Date()` immediately before
 * `buildAdvisoryWaitSummary` -- AFTER every `gh`/GraphQL evidence-collection
 * call below has already completed -- so the summary evaluates against a
 * clock as fresh as possible relative to that evidence. Sampling it here
 * instead, before collection even starts, would let a slow collection
 * evaluate against a stale start time and could incorrectly keep the
 * advisory wait blocked until another invocation. Callers must apply the
 * same late-sampling fallback this file's own call site does:
 * `resolvedNow || new Date().toISOString().replace('.000Z', 'Z')`.
 */
export function resolveNowFlag(rawNow: string): {
  now: string;
  error: string | null;
} {
  if (!rawNow) {
    return { now: '', error: null };
  }
  const normalized = normalizeNowFlag(rawNow);
  if (normalized === null) {
    return { now: '', error: NOW_FLAG_USAGE_MESSAGE };
  }
  return { now: normalized, error: null };
}

/** What {@link resolveWaitFlags} decided about `--wait` and `--poll-interval`. */
export type WaitFlagsResolution =
  | { error: string }
  | { error: null; waitMs: number | null; pollIntervalMs: number | null };

/**
 * Resolve `--wait` and `--poll-interval` at the argument-handling boundary
 * (#4378), before any `gh` call, to milliseconds or one usage message. An
 * absent `--wait` (and no `--poll-interval`) resolves to `null` and leaves the
 * helper a single read. Each of these is a usage error: a `--wait` that is
 * empty, malformed, zero, or above `PT8M`; a `--poll-interval` below `PT60S`,
 * above `--wait`, malformed, or given without `--wait`; and `--now` combined
 * with `--wait`, because a fixed clock cannot elapse.
 */
export function resolveWaitFlags(
  args: Pick<AdvisoryWaitStateArgs, 'wait' | 'pollInterval' | 'now'>,
): WaitFlagsResolution {
  if (args.wait === null) {
    return args.pollInterval === null
      ? { error: null, waitMs: null, pollIntervalMs: null }
      : { error: '--poll-interval requires --wait' };
  }
  const waitMs = parseIsoDurationToMs(args.wait);
  if (waitMs === null || waitMs > MAX_WAIT_MS) {
    return { error: WAIT_FLAG_USAGE_MESSAGE };
  }
  if (args.now !== '') {
    return {
      error:
        '--now cannot be combined with --wait: a fixed clock cannot elapse',
    };
  }
  if (args.pollInterval === null) {
    return { error: null, waitMs, pollIntervalMs: null };
  }
  const pollIntervalMs = parseIsoDurationToMs(args.pollInterval);
  if (
    pollIntervalMs === null ||
    pollIntervalMs < MIN_POLL_INTERVAL_MS ||
    pollIntervalMs > waitMs
  ) {
    return { error: POLL_INTERVAL_FLAG_USAGE_MESSAGE };
  }
  return { error: null, waitMs, pollIntervalMs };
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call. Returns 0 or throws -- `runHelperCli` (#3344) classifies a
// thrown error when the opt-in JSON error envelope is enabled.
function main(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw markCliUsageError(
      new Error('missing required --pr <number> argument'),
    );
  }
  // #3541: validated before any `gh`/GraphQL call below -- a malformed
  // --now must exit cleanly (one line, no stack trace) without spending
  // any network round-trip first.
  const { now: resolvedNow, error: nowFlagError } = resolveNowFlag(args.now);
  if (nowFlagError) {
    return usageFailure(nowFlagError);
  }
  // #4378: the same pre-network rule for --wait / --poll-interval.
  const waitFlags = resolveWaitFlags(args);
  if (waitFlags.error !== null) {
    return usageFailure(waitFlags.error);
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const input = {
    prNumber: args.prNumber,
    owner,
    repo,
    trustedMarkerLogins: args.trustedMarkerLogins,
    claimId: args.claimId,
    agentId: args.agentId,
  };
  // Without --wait the helper makes one read, exactly as before (#4378).
  const report =
    waitFlags.waitMs === null
      ? readAdvisoryWaitState(port, {
          ...input,
          now: resolvedNow,
          clock: Date.now,
        })
      : waitForAdvisoryWaitState(port, input, {
          waitMs: waitFlags.waitMs,
          pollIntervalMs: waitFlags.pollIntervalMs,
          sleep: sleepSync,
          now: Date.now,
        });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

/**
 * A classified `usage` outcome (Codex review, PR #3551) rather than a bare
 * `1` -- see advisory-convergence.mts's identical comment for why a plain
 * number misclassifies as `kind: 'gate'` under `IDD_HELPER_ERROR_ENVELOPE=1`.
 * One line on stderr, nothing on stdout.
 */
function usageFailure(message: string): HelperCliResult {
  process.stderr.write(`${message}\n`);
  return { exitCode: 1, kind: 'usage', message, httpStatus: null };
}

/** Everything one read of the advisory-wait state needs. */
export interface AdvisoryWaitStateReadInput {
  prNumber: number;
  owner: string;
  repo: string;
  /** The `--trusted-marker-logins` flag value (`''` when absent). */
  trustedMarkerLogins: string;
  claimId: string;
  agentId: string;
  /**
   * The normalized `--now` value, or `''` to sample the clock after the
   * evidence is collected (see {@link resolveNowFlag}).
   */
  now: string;
  /** Wall clock in epoch milliseconds; sampled late when `now` is `''`. */
  clock: () => number;
}

/**
 * One full read of the advisory-wait state: every provider read the helper
 * makes, then the summary, the terminal-recovery state and the stale-request
 * recovery verdict. Read-only; the CLI prints its result once.
 */
export function readAdvisoryWaitState(
  port: ProviderPort,
  input: AdvisoryWaitStateReadInput,
): AdvisoryWaitStateReport {
  const viewerLogin = port.resolveViewerLoginSafe().viewerLogin;
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: input.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: loadIddConfig(),
    });

  const prHeadSha = port.getChangeRequestHeadSha(input.prNumber);

  const reviews = port.listReviews(input.prNumber) as ReviewPayload[];
  const restRequestedReviewers: GhAuthorPayload[] = port
    .getChangeRequestRequestedReviewerLogins(input.prNumber)
    .map((login) => ({ login }));
  const timelineEvents = port.getWorkItemTimeline(
    input.prNumber,
  ) as TimelineEventPayload[];
  // #3249: `includeEditState` resolves each comment's GraphQL `lastEditedAt`
  // -- needed so `summarizeAdvisoryWaitMarkers` and
  // `buildCopilotRecoverySummary` below (fed via `normalizeComment`) can
  // reject a body-edited `advisory-wait:` / `advisory-wait-recovery:`
  // marker. A GraphQL failure now throws where this call previously could
  // not; see this issue's PR description for that tradeoff.
  const comments = port.listWorkItemComments(input.prNumber, {
    includeEditState: true,
  });

  const collaboratorTrustEnabled = isTruthy(
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(port, comments)
      : []),
  ]);
  const advisoryWaitPolicy = readAdvisoryWaitPolicy();
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const secondaryBotLogins = readAdvisorySecondaryBotLogins();

  // #2167: only pay for the optional GraphQL reviewRequests call when the
  // cheaper REST + timeline signals are both inconclusive -- mirrors
  // resolveCopilotPending's own precedence (protocol-helpers.mts) so this
  // pre-check and the pure function it feeds never disagree on when a
  // GraphQL fallback is actually needed.
  const restCopilotPending = isCopilotPending(
    restRequestedReviewers,
    primaryBotLogin,
  );
  const lastCopilotCommitForGraphqlGate = findLastCopilotReviewCommit(
    reviews,
    primaryBotLogin,
  );
  const copilotPendingCoversHeadForGraphqlGate =
    computeCopilotPendingCoversHead(timelineEvents, prHeadSha, primaryBotLogin);
  const graphqlRequestedReviewerLogins =
    !restCopilotPending &&
    !(
      copilotPendingCoversHeadForGraphqlGate &&
      lastCopilotCommitForGraphqlGate !== prHeadSha
    )
      ? port.getChangeRequestRequestedReviewerLoginsGraphql(input.prNumber)
      : null;

  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers: restRequestedReviewers,
      timelineEvents,
      comments: comments.map(normalizeComment),
      graphqlRequestedReviewerLogins,
    },
    {
      // #3551 Codex review: sampled here (immediately before this call),
      // AFTER every evidence-collection call above has completed -- not
      // inside resolveNowFlag, which would sample it before collection
      // even starts. See resolveNowFlag's own doc comment for why.
      now:
        input.now ||
        new Date(input.clock()).toISOString().replace('.000Z', 'Z'),
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      secondaryBotLogins,
      viewerLogin,
      configuredTrustedActors,
      collaboratorTrustEnabled,
      trustedMarkerLogins,
    },
  );

  // #2554: skipped entirely when no `advisoryWait.providerOutage.
  // terminalWindow` override is configured. With no override, the
  // effective-window resolver below returns the base window regardless of
  // declarationActive, so the live outage-declaration fetch would be pure
  // overhead for a repository that never configured this feature
  // (matching pre-merge-readiness.mts's own skip-when-unconfigured guard).
  // Schema-validated first, matching pre-merge-readiness.mts's and
  // advisory-convergence.mts's own validate-or-default gate: an
  // `advisoryWait` section invalid for an unrelated reason must fall back
  // to every distributed default, not just this one key.
  const iddConfigForTerminalWindow = loadIddConfig();
  const validatedAdvisoryWaitConfigForTerminalWindow =
    advisoryWaitSectionIsValid(iddConfigForTerminalWindow)
      ? iddConfigForTerminalWindow
      : {};
  const providerOutageTerminalWindowOverrideMinutes =
    resolveProviderOutageTerminalWindowMinutes(
      validatedAdvisoryWaitConfigForTerminalWindow,
    );
  const outageDeclarationActiveForTerminalWindow =
    providerOutageTerminalWindowOverrideMinutes !== null
      ? resolveOutageDeclarationActiveForConvergenceSelector({
          port,
          owner: input.owner,
          repo: input.repo,
          iddConfig: iddConfigForTerminalWindow,
          now: summary.now,
        })
      : false;

  // Reuse summary.now (not a fresh new Date() call) so both computations
  // agree on the exact same instant.
  const copilotDeclinedHead =
    findLastCopilotDeclineCommit(reviews, primaryBotLogin) === prHeadSha;
  const copilotRecovery = buildCopilotRecoverySummary(
    {
      comments: comments.map(normalizeComment),
      prHeadSha,
      lastCopilotCommit: summary.lastCopilotCommit,
      copilotDeclinedHead,
    },
    {
      now: summary.now,
      trustedMarkerLogins,
      claimId: input.claimId,
      agentId: input.agentId,
      recoveryCycleCap: readAdvisoryRecoveryCycleCap(),
      terminalWindowMinutes: resolveEffectiveAdvisoryTerminalWindowMinutes({
        config: validatedAdvisoryWaitConfigForTerminalWindow,
        declarationActive: outageDeclarationActiveForTerminalWindow,
      }),
    },
  );

  // #1571: bounded stale-request recovery eligibility, derived from the
  // already-computed AW1-AW3 evidence (summary) plus the #1572 recovery-cycle
  // budget (copilotRecovery). See evaluateStaleRequestRecoveryAction's own
  // doc comment for why this is independent of RECOVERY_NEEDED/AW3-R.
  const staleRequestRecovery = evaluateStaleRequestRecoveryAction({
    copilotPending: summary.copilotPending,
    copilotPendingCoversHead: summary.copilotPendingCoversHead,
    sameHeadMarkerPresent: summary.sameHeadMarkerPresent,
    sameHeadRequestMarkerPresent: summary.sameHeadRequestMarkerPresent,
    copilotDeclinedHead,
    remainingBudget: copilotRecovery.remainingBudget,
    activeClaimProvided: copilotRecovery.activeClaimProvided,
    elapsedMinutes: summary.elapsedMinutes,
    settledWindowMinutes: summary.settledWindowMinutes,
    // #4718: findLastCopilotReviewCommit returns the raw commit_id, so the
    // comparison lowercases it, the same normalization
    // buildCopilotRecoverySummary applies. Unlike the copilotDeclinedHead
    // comparison above, this one does not rely on the caller's casing.
    // #4877: on the pending path, any completed review of this head counts,
    // not only the latest review, which may name an older commit.
    currentHeadReviewExists: summary.copilotPending
      ? hasCurrentHeadCopilotReview(reviews, prHeadSha, primaryBotLogin)
      : String(summary.lastCopilotCommit ?? '').toLowerCase() === prHeadSha,
  });

  return {
    ...summary,
    trustedMarkerActors: configuredTrustedActors,
    trustedMarkerActorsSource,
    copilotRecovery,
    staleRequestRecovery,
  };
}

/**
 * Options for {@link waitForAdvisoryWaitState}, in the style of
 * `AdvisoryConvergencePollOptions` (advisory-convergence.mts): `sleep` and
 * `now` exist so a test can inject a deterministic, instant clock; production
 * passes the real `sleepSync` and `Date.now`. The injected `sleep` is the only
 * thing that should advance the injected `now`.
 */
export interface AdvisoryWaitStateWaitOptions {
  /** Wall-clock bound in milliseconds, measured from before the first read. */
  waitMs: number;
  /**
   * An explicit poll interval in milliseconds. Absent or `null`, the interval
   * is the effective policy interval (`pollIntervalMinutes` of the first
   * read), and in both cases it is capped at `waitMs`.
   */
  pollIntervalMs?: number | null;
  sleep: (ms: number) => void;
  now: () => number;
}

/**
 * `true` when waiting cannot change the answer: `outcome` is not `WAIT`, or
 * the terminal Copilot-unavailable state holds (which needs the claim and
 * agent ids; without them it stays `NOT_TERMINAL`). The loop follows
 * `outcome` only -- `f3Outcome`, which F3 reads instead, is not consulted.
 */
function advisoryWaitStateIsSettled(report: AdvisoryWaitStateReport): boolean {
  return (
    report.outcome !== 'WAIT' ||
    report.copilotRecovery.state === 'COPILOT_UNAVAILABLE'
  );
}

/**
 * `--wait` (#4378): read the full state, and while it is unsettled sleep and
 * read the full state again, until it settles, the PR head changes, or the
 * wall-clock bound elapses. Read-only: it makes no POST, writes no marker and
 * requests no review in any mode, and every poll makes exactly the reads one
 * run without `--wait` makes, so a call performs at most
 * `1 + ceil(waitMs / pollIntervalMs)` of them. A read that throws propagates
 * unchanged.
 *
 * The bound is a deadline measured from before the first read. Before a sleep
 * that would pass it, only the remaining time is slept and one last full read
 * is taken -- that read is what catches a `WAIT` the passing of time turns
 * into `SATISFIED`. The read after such a clamped sleep is final whatever the
 * clock says, so a wake a millisecond early cannot add a read. After every
 * read the end states apply in this order: `head-changed` (the `prHeadSha`
 * differs from the first read's, so the caller acts on the new head),
 * `settled`, then `bound-elapsed`. The returned report is the last read plus
 * `waitedSeconds` and `waitEnded`.
 *
 * The 8-minute cap on `waitMs` and the 60-second floor on an explicit
 * interval are the CLI's rules, enforced by {@link resolveWaitFlags} before
 * any provider call; `main()` is this function's only production caller.
 */
export function waitForAdvisoryWaitState(
  port: ProviderPort,
  input: Omit<AdvisoryWaitStateReadInput, 'now' | 'clock'>,
  options: AdvisoryWaitStateWaitOptions,
): AdvisoryWaitStateReport {
  const { waitMs, sleep, now } = options;
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw new Error('waitMs must be a positive number of milliseconds');
  }
  // `--now` cannot be combined with `--wait`, so every read samples the
  // injected clock after its own evidence is collected.
  const read = (): AdvisoryWaitStateReport =>
    readAdvisoryWaitState(port, { ...input, now: '', clock: now });
  const startedAt = now();
  const deadline = startedAt + waitMs;
  let report = read();
  const firstHeadSha = report.prHeadSha;
  const policyIntervalMs = report.pollIntervalMinutes * 60 * 1000;
  const requestedIntervalMs = options.pollIntervalMs ?? policyIntervalMs;
  const intervalMs = Math.min(
    Number.isFinite(requestedIntervalMs) && requestedIntervalMs > 0
      ? requestedIntervalMs
      : MIN_POLL_INTERVAL_MS,
    waitMs,
  );
  let lastReadIsFinal = false;
  for (;;) {
    const at = now();
    let waitEnded: AdvisoryWaitEnded | null = null;
    if (report.prHeadSha !== firstHeadSha) {
      waitEnded = 'head-changed';
    } else if (advisoryWaitStateIsSettled(report)) {
      waitEnded = 'settled';
    } else if (lastReadIsFinal || at >= deadline) {
      waitEnded = 'bound-elapsed';
    }
    if (waitEnded !== null) {
      return {
        ...report,
        waitedSeconds: Math.max(0, Math.floor((at - startedAt) / 1000)),
        waitEnded,
      };
    }
    const remainingMs = deadline - at;
    const pauseMs = Math.min(intervalMs, remainingMs);
    lastReadIsFinal = pauseMs >= remainingMs;
    sleep(pauseMs);
    report = read();
  }
}

/**
 * Synchronous bounded sleep via `Atomics.wait` on a throwaway
 * `SharedArrayBuffer`, kept synchronous so `main()` stays a plain
 * `() => HelperCliResult` (the `import.meta.main` trigger above does not
 * await it). Duplicated rather than imported, like the same one-line function
 * in `advisory-convergence.mts` and `clone-lock.mts`.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
function parseLenientPositiveIntegerOrNull(
  token: string | undefined,
): number | null {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function parseArgs(argv: string[]): AdvisoryWaitStateArgs {
  const { values, help } = parseCliArgs(argv, ADVISORY_WAIT_STATE_FLAG_SPEC);
  return {
    prNumber: parseLenientPositiveIntegerOrNull(
      values.pr as string | undefined,
    ),
    owner: values.owner as string,
    repo: values.repo as string,
    trustedMarkerLogins: values['trusted-marker-logins'] as string,
    claimId: values['claim-id'] as string,
    agentId: values['agent-id'] as string,
    now: values.now as string,
    wait: (values.wait as string | undefined) ?? null,
    pollInterval: (values['poll-interval'] as string | undefined) ?? null,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--claim-id <id> --agent-id <id>] [--now <ISO8601>] [--wait <ISO8601-duration> [--poll-interval <ISO8601-duration>]]

--claim-id / --agent-id are OPTIONAL (#1572): when both are supplied, the
copilotRecovery section in the output binds recovery-cycle accounting and the
terminal clock to that active claim. When either is absent, copilotRecovery
fails closed to NOT_TERMINAL with reason: active-claim-not-provided.

--wait is OPTIONAL (#4378): a duration of at most PT8M. The helper reads the
state, and while outcome is WAIT it sleeps and reads again, until outcome is
not WAIT (or copilotRecovery.state is COPILOT_UNAVAILABLE), the PR head
changes, or the bound elapses. The output then adds waitedSeconds and
waitEnded (settled, bound-elapsed, or head-changed). --poll-interval is
OPTIONAL, needs --wait, and is at least PT60S and at most --wait; it defaults
to the policy poll interval (pollIntervalMinutes). --now cannot be combined
with --wait. Read-only in every mode.
`);
}

function normalizeComment(comment: ProviderComment) {
  return {
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    // #3249: carried through so `summarizeAdvisoryWaitMarkers` and
    // `buildCopilotRecoverySummary` can require `unedited` -- passthrough
    // only, `undefined` unless the caller opted into `includeEditState`.
    lastEditedAt: comment.lastEditedAt,
  };
}

function resolveTrustedCollaboratorMarkerLogins(
  port: ProviderPort,
  comments: ProviderComment[],
): string[] {
  const advisoryAuthors = [
    ...new Set(
      comments
        .filter((comment) => advisoryMarkerComment(comment.body))
        .map((comment) => comment.authorLogin)
        .filter(Boolean),
    ),
  ];

  return advisoryAuthors.filter((login) => {
    const outcome = port.getCollaboratorPermission(login);
    const permission =
      outcome.outcome === 'found' ? outcome.permission.toLowerCase() : '';

    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}

// #3338: delegates to the shared, byte-0-anchored family-start predicate
// (marker-helpers.mts, re-exported via protocol-helpers.mts) instead of
// four hand-copied `startsWith` literals. Keeps the deliberately narrow
// four-prefix scope from #1693 unchanged -- only the HTML form's spacing
// tolerance (`<!--\s*advisory-wait:` instead of the exact single space
// `<!-- advisory-wait:`) widens.
export function advisoryMarkerComment(body: string): boolean {
  return advisoryWaitFamilyMarkerStart(body) !== null;
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}
