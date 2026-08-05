#!/usr/bin/env node
// idd-generated-from: src/scripts/advisory-convergence.mts
//
// The scripts/advisory-convergence.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Read-only policy-engine helper (#1340): deterministically asserts whether
// the primary advisory bot's ("Copilot's") review has *converged* on the
// current PR HEAD -- see issue #1340 and roadmap #1342. This closes a gap
// where the existing evidence collectors (`pre-merge-readiness.mjs`,
// `review-disposition-verify.mjs`, `advisory-wait-state.mjs`) report JSON
// for the model to interpret, but no single helper asserts the invariant
// with a hard exit code.
//
// Reuse map (no duplicated review-parsing logic):
//   - `readAdvisoryPrimaryBotLogin` / `resolveAdvisoryPrimaryBotLogin` --
//     Copilot identity resolution.
//   - `resolveAdvisoryBotLogins`, `resolveTrustedMarkerActors` -- the same
//     trust/identity resolution every other helper uses.
//   - `resolveLatestCopilotReviewClause`, `fetchReviewsAndHeadCommit`,
//     `isVerifiedCopilotAuthor` (which itself reuses
//     `isCopilotReviewerLogin`'s login-string check) -- the latest-review
//     Clause 1 evidence, extracted to `review-clause.mts` (#1806) so
//     `rerun-advisory-convergence.mts` can reuse the exact same evidence
//     for its own live-coverage recovery signal, without importing this
//     whole file.
//   - `summarizeDispositionEvidenceForGate` -- reused UNFILTERED for
//     per-thread disposition-marker validity; this file only adds a thin
//     Copilot-authorship filter on top of its `missingThreads` output.
//   - `summarizeClaimValidation`, `summarizeExternalCheckWaivers` -- reused
//     verbatim for the deadline/waiver escape hatch, auto-discovering the
//     PR's linked issue exactly as `external-check-waiver.mts`'s own
//     `--apply` path already does, so no claim flag is required to call
//     this helper (`--pr <n> --assert` is sufficient -- see docs).
//   - `resolveCollaboratorMarkerTrust`, `isAuthorizedForcedHandoffActor`,
//     `operationalMarkerPrefix` -- reused, matching `pre-merge-readiness.mts`
//     exactly (#1344), to thread forced-handoff-aware claim resolution and
//     collaborator-marker trust into the same `summarizeClaimValidation`
//     call above, so this gate does not disagree with the sibling F2/F3
//     helpers when a repository opts into either (both stay no-ops
//     otherwise).
//
// This helper never mutates GitHub state: it only reads PR/review/thread/
// comment data and prints a verdict.
//
// #1511: bounded same-HEAD advisory reroll evidence. `itemCount` (Clause 1
// above) is a STATIC snapshot of the primary bot's review comment count at
// submission time -- rejecting/resolving those items in triage never
// changes it, so `converged` can stay false PERMANENTLY on a HEAD the bot
// has already reviewed, even once every one of its findings has a valid
// disposition. The `sameHeadReroll` field group below surfaces exactly
// when that residual is the ONLY thing blocking convergence, plus a
// bounded counter (backed by a distinct `advisory-reroll:` marker, kept
// separate from the advisory-wait `REQUEST_CAP`) so instructions (AW6 in
// idd-advisory-wait.instructions.md, invoked only from F2) can request a
// few fresh same-HEAD re-reviews before falling through to the existing
// deadline+waiver/hold backstop. This is PURELY ADDITIVE evidence:
// `converged`/`waived`/`ready` below are computed with ZERO reference to
// `sameHeadReroll.*` (see the tests asserting this), so the carve-out can
// never let the gate pass on anything other than the primary bot's own
// real signal -- it only tells a caller when requesting a reroll is safe
// and how much budget remains.

import {
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP,
  DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySameHeadRerollCap,
  readAdvisoryTerminalWindowMinutes,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mts';
import type { CopilotRecoverySummary } from './advisory-wait-state.mts';
import { buildCopilotRecoverySummary } from './advisory-wait-state.mts';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mts';
import {
  GH_TEXT_LOOP_OPTIONS,
  type GhTextOptions,
  ghApiJson,
  ghGraphql,
  ghText,
  safeGhText,
} from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import { isValidIsoTimestamp, parseClaimComment } from './marker-helpers.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mts';
import type { PrCommitPayload } from './protocol-helpers.mts';
import {
  DEFAULT_STALE_AGE_MS,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
  summarizeDispositionEvidenceForGate,
  summarizeExternalCheckWaivers,
} from './protocol-helpers.mts';
// #1806: the latest-review Clause 1 evidence (types + pure evaluator + the
// GraphQL fetch behind it) moved to `review-clause.mts` so
// `rerun-advisory-convergence.mts` can reuse the SAME evidence this gate
// uses, without importing this whole file's claim/waiver/disposition
// machinery. Re-imported here verbatim -- no behavior change to this file.
import type {
  AdvisoryConvergenceReviewClause,
  GhAuthorPayload,
  ReviewPayload,
} from './review-clause.mts';
import {
  fetchReviewsAndHeadCommit,
  isVerifiedCopilotAuthor,
  resolveLatestCopilotReviewClause,
} from './review-clause.mts';

/** The external-check-waiver selector this gate recognizes (documented in
 * docs/idd-helper-scripts.md and docs/policy-constants.md; #1341's required
 * check is expected to register under the same name). #1570: re-exported
 * from the shared `advisory-wait-policy.mts` constant (rather than declared
 * standalone) so `protocol-helpers.mts`'s `buildPreMergeReadinessSummary`
 * can filter terminal-unavailability waiver evidence by the identical
 * selector string without importing this module (which would create an
 * import cycle back through `advisory-wait-state.mts`). The exported name
 * and value are unchanged for existing consumers. */
export const ADVISORY_CONVERGENCE_CHECK_SELECTOR =
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR;

/** #1719: stable, machine-readable tokens for
 * `sameHeadReroll.ineligibleReasons` -- one per boolean term of the
 * `eligible` conjunction, in the same order the conjunction is written in
 * `computeAdvisoryConvergenceVerdict` below, so a report-mode caller can
 * self-diagnose a stuck AW6 reroll without re-deriving the eligibility rule
 * from `idd-advisory-wait.instructions.md` by hand. Exported (rather than
 * inlined as string literals at each call site) so tests reference the same
 * single source of truth the implementation does. */
export const SAME_HEAD_REROLL_INELIGIBLE_REASON = {
  SCOPE_NOT_APPLICABLE: 'scope-not-applicable',
  REVIEW_PENDING: 'review-pending',
  UNRESOLVED_COPILOT_THREADS: 'unresolved-copilot-threads',
  MISSING_REGULAR_COMMENT_DISPOSITION: 'missing-regular-comment-disposition',
  REVIEW_ITEM_COUNT_UNKNOWN: 'review-item-count-unknown',
  REVIEW_ITEM_COUNT_NOT_POSITIVE: 'review-item-count-not-positive',
} as const;

/** The exact token union `sameHeadReroll.ineligibleReasons` may contain
 * (#1719 PR review). Narrowing the field from a bare `string[]` to this
 * union at the type level, and the schema's `items` to the matching
 * `enum`, makes the "stable, machine-readable token" contract
 * self-documenting and catches an accidental new/typo'd token at compile
 * time or schema-validation time instead of silently widening the
 * contract. */
export type SameHeadRerollIneligibleReasonToken =
  (typeof SAME_HEAD_REROLL_INELIGIBLE_REASON)[keyof typeof SAME_HEAD_REROLL_INELIGIBLE_REASON];

// `GhAuthorPayload` (author reference embedded in GitHub REST/GraphQL
// payloads) now lives in `review-clause.mts` and is imported above --
// `__typename` (#1686) is GraphQL-only; this file's own `reviewThreads` /
// thread-comment-page queries request it explicitly (see
// `fetchReviewThreads` / `fetchThreadCommentPages`, and
// `fetchReviewsAndHeadCommit` in `review-clause.mts`), so every LIVE
// payload this gate evaluates carries it; a fixture/test payload that
// omits it is treated as "unknown", never as a rejection -- see
// {@link isVerifiedCopilotAuthor} (also in `review-clause.mts`).

/** Issue/PR comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  id?: string | number | null;
  body?: string | null;
  author?: GhAuthorPayload | null;
  user?: GhAuthorPayload | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
}

// `ReviewPayload` (PR review payload, normalized from the GraphQL
// `reviews` connection) now lives in `review-clause.mts` and is imported
// above.

/** Review-thread reply node (GraphQL `reviewThreads` comment). */
interface ThreadCommentPayload {
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: GhAuthorPayload | null;
  pullRequestReview?: { id?: string | null } | null;
}

/** Review thread (GraphQL `reviewThreads` node). */
interface ReviewThreadPayload {
  id?: string | null;
  isResolved?: boolean | null;
  comments?: {
    pageInfo?: {
      hasNextPage?: boolean | null;
      endCursor?: string | null;
    } | null;
    nodes: ThreadCommentPayload[];
  } | null;
}

/** GraphQL pagination cursor block. */
interface PageInfoPayload {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

/** GraphQL `reviewThreads` connection payload. */
interface ReviewThreadsConnectionPayload {
  pageInfo?: PageInfoPayload | null;
  nodes?: ReviewThreadPayload[] | null;
}

/** `gh pr view --json closingIssuesReferences` entry. */
interface ClosingIssueRefPayload {
  number?: number | null;
}

// `AdvisoryConvergenceReviewClause` (latest-review clause evidence,
// Clause 1 of the `converged` definition below) now lives in
// `review-clause.mts`; re-exported here so this file's existing public
// export surface stays unchanged for any consumer importing it from here.
export type { AdvisoryConvergenceReviewClause } from './review-clause.mts';

/** Thread clause evidence (Clause 2 of the `converged` definition). A
 * Copilot-authored thread satisfies this clause when it is resolved
 * (regardless of marker) or, if unresolved, carries a fresh disposition
 * marker -- see the `converged` computation for the exact rule. */
export interface AdvisoryConvergenceThreadClause {
  copilotThreadCount: number;
  blockingIds: string[];
  blockingCount: number;
  satisfied: boolean;
}

/** Deadline-clock evidence. */
export interface AdvisoryConvergenceDeadline {
  minutes: number;
  headCommittedAt: string;
  elapsedMinutes: number | null;
  passed: boolean;
}

/** Waiver escape-hatch evidence. */
export interface AdvisoryConvergenceWaiver {
  mode: string;
  checkSelector: string;
  activeClaimId: string;
  validCount: number;
}

/** Scope gate evidence for the advisory-convergence verdict.
 *
 * `status: 'indeterminate'` (#1686) is a third, deliberately distinct
 * outcome from `not_applicable`: it means this PR carries real evidence of
 * IDD claim activity (a trusted `claimed-by` marker exists somewhere in its
 * candidate claim-issue history, or its closing references are ambiguous
 * between two or more actively-claimed issues, or its linked issue has an
 * active claim whose recorded branch does not match the PR's own head
 * branch) but the claim linkage the `idd-claimed` scope needs cannot be
 * resolved cleanly right now. Unlike `not_applicable`, `indeterminate`
 * NEVER makes the verdict `ready` on its own (see `converged`/`ready`
 * below) -- it still falls through the existing deadline+maintainer-waiver
 * escape hatch like any other non-converged verdict, so a human can either
 * repair the claim linkage or explicitly waive this check, but the
 * executing session cannot manufacture readiness by omitting, duplicating,
 * or letting its own claim linkage go missing. `not_applicable` stays
 * reserved for a PR with NO such evidence at all -- a genuine non-IDD
 * contribution this scope must not block. */
export interface AdvisoryConvergenceApplicability {
  scope: 'all-prs' | 'idd-claimed';
  status: 'applicable' | 'not_applicable' | 'indeterminate';
  reason: string;
}

/** #1719: eligibility-relevant `dispositionEvidence` counters, exposed so
 * the numeric input behind `sameHeadReroll`'s
 * `missing-regular-comment-disposition` term is visible on the report
 * object and not only its pass/fail verdict. A narrow, counters-only
 * projection of `DispositionEvidenceSummary` (protocol-helpers.mts) --
 * deliberately NOT the same shape as `pre-merge-readiness.mjs`'s own
 * `dispositionEvidence` field (which additionally carries `route` /
 * `blockingCount` / full missing-item lists for the F2 merge gate); this
 * gate's `dispositionEvidence` never gates anything by itself and has no
 * `route` field. */
export interface AdvisoryConvergenceDispositionEvidence {
  /** Outstanding non-thread regular PR comments (from a non-agent author)
   * lacking a fresh disposition marker. The exact counter
   * `sameHeadReroll.eligible`'s `missing-regular-comment-disposition`
   * term reads. */
  missingRegularCommentCount: number;
  /** Review threads (resolved or unresolved, any authorship) still lacking
   * a fresh disposition marker. Adjacent evidence -- not itself one of the
   * six `sameHeadReroll.eligible` terms (Clause 2's Copilot-scoped subset
   * is `threads.blockingCount` above), but cheap to expose alongside its
   * sibling counter since both come from the same already-computed
   * `dispositionEvidence` summary. */
  missingThreadCount: number;
}

/** Bounded same-HEAD advisory reroll evidence (#1511) -- see the module
 * header for the full rationale. Purely additive: never referenced by the
 * `converged` / `waived` / `ready` computation. */
export interface AdvisoryConvergenceSameHeadReroll {
  /** `matchesHead: true`, `itemCount > 0`, every Copilot-authored thread
   * resolved or validly dispositioned, AND no outstanding regular-comment
   * disposition evidence (`dispositionEvidence.missingRegularCommentCount
   * === 0`) -- the static item count is the ONLY thing keeping `converged`
   * false for this HEAD, with no other triage work still outstanding. */
  eligible: boolean;
  /** #1719: one stable, machine-readable token per failing term of the
   * six-term `eligible` conjunction above
   * (`SAME_HEAD_REROLL_INELIGIBLE_REASON`), in conjunction order; empty
   * exactly when `eligible` is `true`. Computed from the SAME six terms
   * `eligible` itself reduces from (see the computation below), so the
   * two can never disagree -- a report-mode caller no longer has to
   * re-derive the eligibility rule by hand to self-diagnose a stuck AW6
   * reroll. */
  ineligibleReasons: SameHeadRerollIneligibleReasonToken[];
  /** Trusted `advisory-reroll:` marker count whose embedded HEAD SHA
   * matches the current HEAD (resets naturally on a new push, since a new
   * HEAD's markers start over). */
  count: number;
  /** Configured bounded budget (`advisoryWait.sameHeadRerollCap`, default
   * {@link DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP}). */
  cap: number;
  /** `count >= cap`: stop rerolling: fall through to the existing
   * non-converged path (deadline+waiver backstop, or hold). */
  exhausted: boolean;
  /** GitHub `created_at` of the latest trusted same-HEAD reroll marker, or
   * `''` if none exists yet. Deliberately the comment's server timestamp,
   * never the embedded (agent-supplied) one -- the same "clock anchor is
   * marker `created_at`, not embedded text" invariant AW2 already states
   * for `advisory-wait:`. */
  latestAt: string;
  /** `true` while a reroll marker exists, no primary-bot review has been
   * submitted after it yet, AND the configured `advisoryWait.pendingWindow`
   * has not yet elapsed since it was posted -- i.e. a reroll request is
   * still awaiting the bot's response. Recomputed fresh from GitHub state
   * on every call (never in-session memory), so it is resume/restart-safe:
   * a crash mid-poll cannot cause a duplicate reroll request. */
  inFlight: boolean;
  /** `eligible && !exhausted && !inFlight` -- the exact instant it is safe
   * to request a fresh same-HEAD reroll. Precomputed so callers never need
   * to hand-compare ISO-8601 timestamps themselves. */
  requestable: boolean;
}

/** Full JSON verdict document printed by this CLI. */
export interface AdvisoryConvergenceVerdict {
  protocolVersion: '1';
  decisionAuthority: 'instructions';
  prNumber: number;
  prHeadSha: string;
  now: string;
  primaryBotLogin: string;
  applicability: AdvisoryConvergenceApplicability;
  review: AdvisoryConvergenceReviewClause;
  threads: AdvisoryConvergenceThreadClause;
  pending: boolean;
  deadline: AdvisoryConvergenceDeadline;
  waiver: AdvisoryConvergenceWaiver;
  /** #1719: see {@link AdvisoryConvergenceDispositionEvidence}. */
  dispositionEvidence: AdvisoryConvergenceDispositionEvidence;
  sameHeadReroll: AdvisoryConvergenceSameHeadReroll;
  /** #1570: `#1572`'s terminal Copilot stall-recovery state
   * (`buildCopilotRecoverySummary`, advisory-wait-state.mts), reported here
   * SEPARATELY from `deadline` above -- this gate's own review/thread/
   * deadline clauses are entirely unmodified by this field's presence. A
   * `state: "COPILOT_UNAVAILABLE"` verdict is waiver *eligibility* only; it
   * never sets `converged`/`ready` by itself (see the `waiver` /
   * `converged`/`ready` computation below). */
  terminal: CopilotRecoverySummary;
  converged: boolean;
  waived: boolean;
  ready: boolean;
  reasons: string[];
}

/** Pure inputs to {@link computeAdvisoryConvergenceVerdict} (already fetched;
 * this function performs no I/O). */
export interface AdvisoryConvergenceInputs {
  prNumber: number;
  prHeadSha: string;
  reviews?: ReviewPayload[];
  threads?: ReviewThreadPayload[];
  comments?: IssueCommentPayload[];
  /** The linked (claim) issue's own comment stream, or `[]` when no linked
   * issue could be resolved -- see module header. Used only to resolve the
   * active claim for waiver validation; the `converged` computation itself
   * never depends on a claim. */
  claimEvents?: IssueCommentPayload[];
  /** #1686: true when at least one trusted, syntactically valid
   * `claimed-by` marker was ever posted on ANY of the PR's candidate claim
   * issues -- computed by the CLI-collection layer over the union of every
   * candidate's raw comment stream, independent of whether that history
   * currently resolves to an ACTIVE claim. `claimEvents` above can be `[]`
   * even when this is `true`: `pickResolvingClaimEvents` fails closed to
   * `[]` both when zero candidates resolve and when the linkage is
   * ambiguous, collapsing exactly the distinction this field restores (see
   * the module header's path 2 and path 4). Distinguishes a genuinely
   * non-IDD PR (no linked issue, no claim history ever -- `false`, stays
   * `not_applicable`) from an IDD-shaped PR whose claim linkage is
   * currently broken (a stale or released claim -- `true`, becomes
   * `indeterminate`). Required: every construction site must state the
   * value explicitly (`false` for a PR with no claim history to report) --
   * `collectFromGitHub` always computes and forwards it via
   * `resolveClaimEvidence`, so an omitted field on this typed interface
   * would signal a broken forwarding path, not a legitimate "no history"
   * case (kurone-kito/idd-skill#1814). An untyped JS caller of the emitted
   * `.mjs` that omits it (or passes a non-boolean) is rejected at runtime
   * with a thrown `Error` instead of silently coercing to `false`
   * (kurone-kito/idd-skill#1821). */
  claimMarkerHistoryPresent: boolean;
  /** #1686: true when two or more of the PR's candidate claim issues each
   * independently resolve an ACTIVE trusted claim -- the disambiguation
   * failure `pickResolvingClaimEvents` already fails closed to `[]` for
   * (module header path 2). An explicit `--claim-issue` target has no
   * ambiguity to resolve, so the CLI-collection layer always reports
   * `false` for it (see `classifyClaimCandidateAmbiguity`). Required for the
   * same reason as `claimMarkerHistoryPresent` above (kurone-kito/idd-skill#1814).
   * Checked BEFORE `claimMarkerHistoryPresent` in the
   * applicability computation so the more specific "which failure mode"
   * reason wins -- an ambiguous set of candidates trivially also has claim
   * history (an active claim cannot exist without a valid marker), so the
   * two fields are not mutually exclusive; the check order is what makes
   * the reported `reason` precise. Validated the same way
   * `claimMarkerHistoryPresent` is -- an untyped `.mjs` caller that omits
   * it (or passes a non-boolean) is rejected at runtime with a thrown
   * `Error` instead of silently coercing to `false`
   * (kurone-kito/idd-skill#1821). */
  claimCandidateAmbiguous: boolean;
}

/** Pure options accepted by {@link computeAdvisoryConvergenceVerdict}. */
export interface AdvisoryConvergenceOptions {
  now: string;
  primaryBotLogin?: string;
  trustedMarkerLogins?: unknown[] | null;
  advisoryBotLogins?: unknown[] | null;
  convergenceScope?: 'all-prs' | 'idd-claimed';
  prHeadRefName?: string | null;
  /** The PR author's login, excluded from "external feedback" the same way
   * `summarizeDispositionEvidenceForGate` excludes it elsewhere. */
  prAuthorLogin?: string | null;
  /** ISO-8601 timestamp for the current HEAD commit; anchors the deadline
   * clock independent of any IDD-specific marker (see module header). */
  headCommittedAt?: string | null;
  deadlineMinutes?: number;
  waiverMode?: string;
  waiverMaxValidity?: string;
  waiverCheckSelector?: string;
  /** Bounded same-HEAD advisory reroll cap (#1511), `advisoryWait.same-
   * HeadRerollCap`. Defaults to {@link DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP}
   * when omitted or non-finite. */
  sameHeadRerollCap?: number;
  /** `advisoryWait.pendingWindow` in minutes, reused (not a new duration
   * knob) to bound how long a same-HEAD reroll request can stay "in
   * flight" before a caller may safely try again -- the same "bot is
   * pending a re-request" semantics AW3 already uses elsewhere. Defaults
   * to `DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES` (advisory-wait-policy.mts)
   * when omitted or non-finite. */
  pendingWindowMinutes?: number;
  /** The configured `ciGate.externalChecks.waivable` selector list. A
   * waiver only counts when its own selector overlaps one of these
   * entries -- see the waiver escape-hatch computation below. */
  waivableSelectors?:
    | readonly { selector: string; matchMode?: string }[]
    | null;
  /** #1570/#1572: bounded per-PR-HEAD Copilot stall-recovery cycle cap,
   * threaded into `buildCopilotRecoverySummary`. Defaults to
   * {@link DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP} when omitted or non-finite. */
  recoveryCycleCap?: number;
  /** #1570/#1572: 12h terminal-unavailability window in minutes, threaded
   * into `buildCopilotRecoverySummary`. Defaults to
   * {@link DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES} when omitted or
   * non-finite. */
  terminalWindowMinutes?: number;
  // --- Forced-handoff / collaborator-marker-trust claim-resolution
  // parity (#1344) -- threaded straight into the `summarizeClaimValidation`
  // call below, matching `pre-merge-readiness.mts`'s own options exactly.
  // The first four gate an opt-in, off-by-default repository feature: each
  // is a no-op (today's exact behavior) when the caller omits it.
  /** `forcedHandoff.mode === "human-gated"` (default `disabled`, i.e.
   * `false`). Off by default; when on, a trusted forced-handoff marker on
   * the claim issue can transfer `activeClaim` to its successor. */
  forcedHandoffEnabled?: boolean;
  /** Authorizes a forced-handoff marker's `forced-by` actor -- mirrors
   * `pre-merge-readiness.mts`'s `isAuthorizedForcedHandoffActor`-backed
   * callback. Omitted/absent means every handoff is treated as
   * unauthorized (fail closed), same as `summarizeClaimValidation`'s own
   * default. */
  isAuthorizedForcedHandoff?: (forcedBy: string) => boolean;
  /** The current PR's own reference forms (`["1234", prUrl]`, typically),
   * so an `issue-plus-pr`-scoped handoff marker must name *this* PR to
   * transfer the claim. An empty/omitted list accepts any linked-PR
   * reference. */
  expectedLinkedPrs?: unknown[] | null;
  /** ISO timestamp of the PR's earliest commit -- the Part B (#1058)
   * allowance that still honors an `issue-only`-scoped handoff (no
   * `linked-pr` field) predating the PR, matching
   * `pre-merge-readiness.mts` exactly. `null`/omitted rejects every
   * `issue-only` handoff once `expectedLinkedPrs` is non-empty (fail
   * closed), same as `buildForcedHandoffEnableGate`'s own default. */
  prFirstCommitAt?: string | null;
  /** Configured `claimTiming.staleAge` (#1310), pre-parsed to milliseconds.
   * Unlike the four fields above, this is not gated behind an opt-in
   * feature flag -- it is an unconditional parity fix for an already-live,
   * orthogonal config value `pre-merge-readiness.mts` already applies.
   * Omitted keeps `summarizeClaimValidation`'s hardcoded 24h default,
   * which is also what a repository on the (also 24h) configured default
   * observes -- so this is only a behavior change for a repository that
   * has configured a non-default `claimTiming.staleAge`. */
  staleAgeMs?: number;
}

/**
 * Compute the deterministic advisory-convergence verdict from already-
 * fetched PR evidence. Pure (no I/O), so it is directly unit-testable with
 * fixtures -- mirrors `buildPreMergeReadinessSummary` /
 * `buildAdvisoryWaitSummary` in `protocol-helpers.mts`.
 */
export function computeAdvisoryConvergenceVerdict(
  inputs: AdvisoryConvergenceInputs,
  options: AdvisoryConvergenceOptions,
): AdvisoryConvergenceVerdict {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  // Lowercased before validating, so a mixed-/upper-case 40-hex SHA is
  // accepted (normalized), not rejected -- the error message below
  // describes the post-normalization shape, not a case restriction on the
  // input.
  const prHeadSha = String(inputs.prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a 40-character hexadecimal commit SHA');
  }

  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const reviews = inputs.reviews ?? [];
  const threads = inputs.threads ?? [];
  const comments = inputs.comments ?? [];
  const claimEvents = inputs.claimEvents ?? [];
  const reasons: string[] = [];
  const claim = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins,
    // #1344: parity with `pre-merge-readiness.mts`'s own
    // `summarizeClaimValidation` call -- see `AdvisoryConvergenceOptions`
    // for why each field is a no-op when the caller omits it.
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    prFirstCommitAt: options.prFirstCommitAt ?? null,
    staleAgeMs: options.staleAgeMs,
  });
  const activeClaimId = claim.activeClaim?.claimId ?? '';

  // `idd-claimed` narrows this gate to verified IDD-owned PRs; the default
  // `all-prs` behavior keeps the gate applicable everywhere else.
  const convergenceScope =
    options.convergenceScope === 'idd-claimed' ? 'idd-claimed' : 'all-prs';
  const prHeadRefName = String(options.prHeadRefName ?? '').trim();
  const activeClaimBranch = String(claim.activeClaim?.branch ?? '').trim();
  // #1686: evidence the CLI-collection layer computes over EVERY candidate
  // claim issue (not just whichever one -- if any -- ended up "active"), so
  // the applicability gate can tell a genuinely non-IDD PR apart from an
  // IDD-shaped PR whose claim linkage is currently broken. See each field's
  // own doc comment on `AdvisoryConvergenceInputs` for the full rationale.
  //
  // #1821: the TS type already requires both fields at compile time, but
  // that guard is erased at emit -- an untyped caller of the exported
  // `.mjs` (or a hand-written JS caller) can still pass `undefined` or a
  // non-boolean value through. Reject that here instead of silently
  // coercing it to `false`, matching this function's existing
  // error-handling convention for invalid inputs (see the `now` /
  // `prHeadSha` validation above).
  if (typeof inputs.claimMarkerHistoryPresent !== 'boolean') {
    throw new Error('claimMarkerHistoryPresent must be a boolean');
  }
  if (typeof inputs.claimCandidateAmbiguous !== 'boolean') {
    throw new Error('claimCandidateAmbiguous must be a boolean');
  }
  const claimMarkerHistoryPresent = inputs.claimMarkerHistoryPresent;
  const claimCandidateAmbiguous = inputs.claimCandidateAmbiguous;
  const applicability: AdvisoryConvergenceApplicability =
    convergenceScope === 'idd-claimed'
      ? !claim.activeClaimPresent
        ? claimCandidateAmbiguous
          ? {
              scope: convergenceScope,
              status: 'indeterminate',
              reason: 'idd-claimed-multiple-resolving-claim-candidates',
            }
          : claimMarkerHistoryPresent
            ? {
                scope: convergenceScope,
                status: 'indeterminate',
                reason: 'idd-claimed-claim-history-without-active-claim',
              }
            : {
                scope: convergenceScope,
                status: 'not_applicable',
                reason: 'idd-claimed-no-verified-linked-issue-claim',
              }
        : !prHeadRefName
          ? {
              scope: convergenceScope,
              status: 'applicable',
              reason: 'idd-claimed-head-branch-unavailable',
            }
          : !activeClaimBranch
            ? {
                scope: convergenceScope,
                status: 'applicable',
                reason: 'idd-claimed-linked-claim-branch-unavailable',
              }
            : activeClaimBranch !== prHeadRefName
              ? {
                  scope: convergenceScope,
                  status: 'indeterminate',
                  reason: 'idd-claimed-branch-mismatch',
                }
              : {
                  scope: convergenceScope,
                  status: 'applicable',
                  reason: 'idd-claimed-branch-matched',
                }
      : {
          scope: convergenceScope,
          status: 'applicable',
          reason: 'all-prs',
        };
  // `scopeNotApplicable` keeps its pre-#1686 meaning EXACTLY -- `status ===
  // 'not_applicable'` only -- since it still gates the waiver-evidence
  // bookkeeping (`waived` below) and the unconditional `ready` pass for a
  // genuinely non-IDD PR. `scopeIndeterminate` is the new third state:
  // unlike `not_applicable`, it must NEVER let `ready` become true through
  // the ordinary convergence path (`converged` below is forced `false` for
  // it, same as `not_applicable` blocks evaluating convergence at all) --
  // only the existing deadline/terminal-plus-maintainer-waiver escape hatch
  // can still clear it (`waived` stays gated by `scopeNotApplicable` alone,
  // deliberately NOT `scopeBlocksConvergenceEval`, so a trusted maintainer
  // marker can still resolve an indeterminate verdict same as any other
  // non-converged one -- see the module header and PR discussion for why
  // hard-blocking indeterminate with no waiver escape at all would leave a
  // required check with no recovery path for a repository under
  // `required_approving_review_count: 0`).
  const scopeNotApplicable = applicability.status === 'not_applicable';
  const scopeIndeterminate = applicability.status === 'indeterminate';
  const scopeBlocksConvergenceEval = scopeNotApplicable || scopeIndeterminate;
  if (scopeIndeterminate) {
    reasons.push(
      `applicability is indeterminate (${applicability.reason}): this PR carries evidence of IDD claim activity but its claim linkage cannot be resolved cleanly -- repair the claim/PR-body linkage (or, for a confirmed benign case, have a trusted maintainer post an idd-external-check-waiver marker) before this check can converge`,
    );
  }

  // --- Clause 1: latest Copilot review is clean on the current HEAD -----
  const review = resolveLatestCopilotReviewClause(
    reviews,
    prHeadSha,
    primaryBotLogin,
  );
  const pending = scopeBlocksConvergenceEval ? false : !review.matchesHead;
  if (!scopeBlocksConvergenceEval && pending) {
    reasons.push(
      review.found
        ? `latest ${primaryBotLogin} review (commit ${review.commitId || '<unknown>'}) does not cover current HEAD ${prHeadSha}`
        : `${primaryBotLogin} has not reviewed this pull request yet`,
    );
  }

  // --- Clause 2: every current Copilot-authored thread is resolved or ---
  // --- validly dispositioned (reusing summarizeDispositionEvidenceForGate)
  const copilotThreadIds = classifyCopilotAuthoredThreadIds(
    threads,
    primaryBotLogin,
  );
  const dispositionEvidence = summarizeDispositionEvidenceForGate(
    { comments, threads },
    {
      // `summarizeDispositionEvidenceForGate` requires a recognized
      // "IDD agent" login to accept an Accept/Reject/AMD marker as a fresh
      // disposition (see `hasFreshDisposition`). This gate has no separate
      // notion of "IDD agent" from "trusted marker actor" -- both mean the
      // same thing here (whoever is authorized to post operational markers
      // on this repo) -- so the trusted set is reused for both, avoiding an
      // extra CLI flag / config surface the issue does not ask for.
      iddAgentLogins: trustedMarkerLogins,
      trustedMarkerLogins,
      advisoryBotLogins: normalizeTrustedMarkerLogins(
        options.advisoryBotLogins ?? [],
      ),
      prAuthorLogin: String(options.prAuthorLogin ?? '')
        .trim()
        .toLowerCase(),
      // Deliberately no `snapshotBoundaryAt`: this claim-independent gate has
      // no F2 review-watermark to anchor one to, and threading a sentinel
      // (e.g. `now`) through would make every resolved thread's feedback
      // trivially predate it -- silently turning the boundary-gated
      // ack-only-post-disposition classification (`classifyThreadAckOnly-
      // PostDisposition`, protocol-helpers.mts) into permanent dead code
      // instead of the deliberate carve-out it looks like. "Resolved is
      // sufficient" (below) is handled directly, without relying on that
      // classification at all.
    },
  );
  // Clause 2 per the issue: "resolved OR carries a valid disposition
  // marker." `missingThreads` (computed without a boundary, above) flags
  // BOTH an unresolved thread lacking a fresh marker AND a resolved thread
  // lacking one (`reason: 'missing-fresh-disposition'`) -- the latter is not
  // a Clause-2 blocker here, since resolution alone already satisfies it, so
  // only the genuinely unresolved entries count.
  const copilotBlocking = dispositionEvidence.missingThreads.filter(
    (thread) =>
      copilotThreadIds.has(String(thread.id ?? '')) &&
      thread.isResolved === false,
  );
  const threadClause: AdvisoryConvergenceThreadClause = {
    copilotThreadCount: copilotThreadIds.size,
    blockingIds: copilotBlocking.map((thread) => String(thread.id ?? '')),
    blockingCount: copilotBlocking.length,
    satisfied: copilotBlocking.length === 0,
  };

  // Clause 1's "review is not clean" reason is pushed here, after Clause 2's
  // `threadClause` is available -- deliberately deferred from the `pending`
  // check above (whose own `if` already exhausts the pending case, so
  // `reasons` order is unaffected: pending and not-satisfied are mutually
  // exclusive, and this still precedes Clause 2's own thread-blocking
  // reason below).
  //
  // #1719: reported adopter incident -- the primary bot's review on current
  // HEAD carried `itemCount: 1` while every visible GraphQL review thread
  // was already `isResolved: true`; the actual cause was a "Comments
  // suppressed due to low confidence" item embedded in the review's
  // top-level BODY TEXT rather than posted as a review thread -- it
  // contributes to `itemCount` but is invisible to any `reviewThreads`
  // query, so it can never be resolved the normal way, and nothing in this
  // gate's output pointed there. When every visible Copilot-authored thread
  // is already resolved and `itemCount` is still positive, no thread query
  // can explain it -- point directly at the review body instead of leaving
  // an agent to re-derive this by hand a second time.
  //
  // #1880: a related but distinct incident shape -- the primary bot's
  // review on current HEAD carries `itemCount: 0` (zero POSTED comments)
  // while its top-level body still embeds a `Suppressed comments (N)`
  // block for a finding it chose not to post as a comment at all. The
  // #1719 branch above only fires when `itemCount > 0`, so this case fell
  // through to full convergence with an empty `reasons[]` until now (PR
  // #1875 commit 9711d404). `review.satisfied` (review-clause.mts) is
  // already gated on `suppressedCount === 0`, so `converged` is already
  // correctly `false` here -- this branch only supplies the explanation.
  if (!scopeBlocksConvergenceEval && !pending && !review.satisfied) {
    if (review.itemCount === 0 && review.suppressedCount > 0) {
      reasons.push(
        `latest ${primaryBotLogin} review on current HEAD carries ${review.suppressedCount} suppressed comment(s) not reflected in itemCount (posted comment count is 0) -- check the review body directly, since a suppressed finding is never posted as a comment or review thread`,
      );
    } else {
      const itemCountReason =
        review.itemCount === null
          ? `latest ${primaryBotLogin} review on current HEAD carries an unknown number of actionable items (comment count unavailable)`
          : `latest ${primaryBotLogin} review on current HEAD carries ${review.itemCount} actionable item(s)`;
      // A review can carry both posted comments (itemCount > 0) AND a
      // suppressed-comments section at once; append a pointer to the
      // latter rather than silently dropping it from the reported reason.
      const suppressedSuffix =
        review.suppressedCount > 0
          ? ` (plus ${review.suppressedCount} suppressed comment(s) in the review body, not counted in itemCount)`
          : '';
      reasons.push(
        threadClause.satisfied &&
          review.itemCount !== null &&
          review.itemCount > 0
          ? `${itemCountReason}${suppressedSuffix} -- no unresolved ${primaryBotLogin}-authored thread accounts for them; check the review body directly for an item suppressed due to low confidence, which counts toward itemCount but never appears in reviewThreads`
          : `${itemCountReason}${suppressedSuffix}`,
      );
    }
  }
  if (!scopeBlocksConvergenceEval && !threadClause.satisfied) {
    reasons.push(
      `${threadClause.blockingCount} ${primaryBotLogin}-authored review thread(s) are neither resolved nor validly dispositioned: ${threadClause.blockingIds.join(', ')}`,
    );
  }

  // #1719: eligibility-relevant `dispositionEvidence` counters, exposed on
  // the report object -- see `AdvisoryConvergenceDispositionEvidence`'s doc
  // comment for why this is a narrow counters-only projection, not the same
  // shape as `pre-merge-readiness.mjs`'s own `dispositionEvidence` field.
  const dispositionEvidenceReport: AdvisoryConvergenceDispositionEvidence = {
    missingRegularCommentCount: dispositionEvidence.missingRegularCommentCount,
    missingThreadCount: dispositionEvidence.missingThreadCount,
  };

  const converged =
    !scopeBlocksConvergenceEval &&
    !pending &&
    review.satisfied &&
    threadClause.satisfied;

  // --- Same-HEAD advisory reroll evidence (#1511) ------------------------
  // Purely additive: `converged` above is already final and is never
  // recomputed or referenced below this point -- see the module header and
  // the "sameHeadReroll never affects converged/ready" test.
  // `dispositionEvidence.missingRegularCommentCount` reuses the SAME
  // evidence F2's own separate "missingRegularComments.length == 0"
  // condition already reads -- an ad hoc regular PR comment (not part of
  // a review thread) can still be an unaddressed, possibly-PATH-A item
  // even when every Copilot-authored THREAD is resolved/dispositioned.
  // Without this, `eligible` could fire while genuine triage work is
  // still outstanding, spending a bounded reroll attempt on a HEAD that
  // was not actually done yet -- and if the bot does not answer quickly,
  // that attempt is permanently consumed before the real blocker is even
  // cleared (PR #1517 review).
  //
  // #1719: each of the six eligibility terms above is ALSO computed as its
  // own named boolean, paired with a stable token in `sameHeadRerollTerms` --
  // `sameHeadRerollEligible` (`.every()`) and
  // `sameHeadRerollIneligibleReasons` (`.filter().map()`) are BOTH derived
  // from that one array, so they cannot disagree; a term added to the
  // conjunction without a paired token here would be a compile-time
  // array-literal edit, not a
  // hand-maintained parallel expression. `reviewItemCountPositiveTerm` is
  // deliberately written as "unknown counts as satisfied"
  // (`itemCount === null || itemCount > 0`), not the bare `itemCount > 0`
  // the original two-line conjunct implied standalone: this keeps the two
  // item-count terms mutually exclusive in `ineligibleReasons` (an unknown
  // count reports ONLY `review-item-count-unknown`, never also
  // `review-item-count-not-positive`), while `reviewItemCountKnownTerm &&
  // reviewItemCountPositiveTerm` together still reduce to exactly the
  // original `itemCount !== null && itemCount > 0` conjunct.
  // #1880: `reviewItemCountPositiveTerm` ALSO counts `suppressedCount > 0`
  // as "positive" -- `itemCount` and `suppressedCount` are both read from
  // the SAME static review snapshot (never updated by later disposition
  // activity, same as `itemCount`'s own doc comment on
  // `AdvisoryConvergenceReviewClause`), so a suppressed-only block is the
  // identical "nothing else can clear this except a fresh review" shape
  // #1511's reroll exists for. The token's FAILURE condition stays exactly
  // as precise as before: `REVIEW_ITEM_COUNT_NOT_POSITIVE` now fires only
  // when itemCount is a known 0 AND suppressedCount is also 0 -- i.e.
  // genuinely nothing (posted or suppressed) to reroll for, still an
  // accurate reading of the existing token name/doc row.
  // #1686: `indeterminate` now also disqualifies a same-HEAD reroll --
  // offering to reroll Copilot is pointless while the underlying claim
  // linkage itself is broken/ambiguous, so this term (and its
  // `SCOPE_NOT_APPLICABLE` token; see that token's doc row in
  // docs/idd-helper-scripts.md) fires for either non-`applicable` status.
  const scopeApplicableTerm = !scopeBlocksConvergenceEval;
  const reviewNotPendingTerm = !pending;
  const threadsSatisfiedTerm = threadClause.satisfied;
  const noMissingRegularCommentsTerm =
    dispositionEvidence.missingRegularCommentCount === 0;
  const reviewItemCountKnownTerm = review.itemCount !== null;
  const reviewItemCountPositiveTerm =
    review.itemCount === null ||
    review.itemCount > 0 ||
    review.suppressedCount > 0;
  const sameHeadRerollTerms: {
    token: SameHeadRerollIneligibleReasonToken;
    satisfied: boolean;
  }[] = [
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.SCOPE_NOT_APPLICABLE,
      satisfied: scopeApplicableTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_PENDING,
      satisfied: reviewNotPendingTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.UNRESOLVED_COPILOT_THREADS,
      satisfied: threadsSatisfiedTerm,
    },
    {
      token:
        SAME_HEAD_REROLL_INELIGIBLE_REASON.MISSING_REGULAR_COMMENT_DISPOSITION,
      satisfied: noMissingRegularCommentsTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_UNKNOWN,
      satisfied: reviewItemCountKnownTerm,
    },
    {
      token: SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_NOT_POSITIVE,
      satisfied: reviewItemCountPositiveTerm,
    },
  ];
  const sameHeadRerollEligible = sameHeadRerollTerms.every(
    (term) => term.satisfied,
  );
  const sameHeadRerollIneligibleReasons = sameHeadRerollTerms
    .filter((term) => !term.satisfied)
    .map((term) => term.token);
  const sameHeadRerollCap =
    Number.isInteger(options.sameHeadRerollCap) &&
    Number(options.sameHeadRerollCap) > 0
      ? Number(options.sameHeadRerollCap)
      : DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP;
  const pendingWindowMinutesForReroll =
    Number.isFinite(options.pendingWindowMinutes) &&
    Number(options.pendingWindowMinutes) > 0
      ? Number(options.pendingWindowMinutes)
      : DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES;
  const rerollMarkers = summarizeSameHeadRerollMarkers(
    comments,
    prHeadSha,
    trustedMarkerLogins,
  );
  // A fresh primary-bot review submitted AT OR AFTER the latest reroll
  // marker's own GitHub `created_at` means that request has already been
  // answered -- regardless of what the fresh review's itemCount turned out
  // to be (a "1 -> 3" surprise is still an answer; it is simply not a
  // converging one, and the normal E1/E4 triage path handles it, never this
  // evidence). `>=`, not `>`: the marker's `created_at` comes from the REST
  // comments endpoint while the review's `submittedAt` is fetched
  // separately via GraphQL, so an equal recorded server timestamp (e.g.
  // both landing in the same second) must still count as answered -- a
  // strict `>` would otherwise wait out the full pending window on a tie
  // that already represents a genuine response (PR #1517 review). A
  // missing/invalid `submittedAt` fails closed toward "not yet answered"
  // (never toward a false "landed"), same direction as `isValidIsoTimestamp`
  // guards elsewhere in this file.
  const hasFreshReviewSinceLastReroll =
    rerollMarkers.latestAt !== '' &&
    isValidIsoTimestamp(review.submittedAt) &&
    Date.parse(review.submittedAt) >= Date.parse(rerollMarkers.latestAt);
  const rerollElapsedMinutes =
    rerollMarkers.latestAt !== ''
      ? minutesBetween(rerollMarkers.latestAt, now)
      : 0;
  // Bounding "in flight" by the same advisoryWait.pendingWindow the AW3
  // decision table already uses for "bot is pending a re-request" (no new
  // duration knob) is what makes resume/restart exact: an old, never-
  // answered reroll self-describes as no-longer-in-flight once the window
  // elapses, instead of blocking a retry forever if the bot goes silent.
  const sameHeadRerollInFlight =
    !scopeBlocksConvergenceEval &&
    rerollMarkers.latestAt !== '' &&
    !hasFreshReviewSinceLastReroll &&
    rerollElapsedMinutes < pendingWindowMinutesForReroll;
  const sameHeadRerollExhausted = rerollMarkers.count >= sameHeadRerollCap;
  const sameHeadReroll: AdvisoryConvergenceSameHeadReroll = {
    eligible: sameHeadRerollEligible,
    ineligibleReasons: sameHeadRerollIneligibleReasons,
    count: rerollMarkers.count,
    cap: sameHeadRerollCap,
    exhausted: sameHeadRerollExhausted,
    latestAt: rerollMarkers.latestAt,
    inFlight: sameHeadRerollInFlight,
    requestable:
      sameHeadRerollEligible &&
      !sameHeadRerollExhausted &&
      !sameHeadRerollInFlight,
  };

  // --- Deadline clock, anchored on the current HEAD commit's own --------
  // --- timestamp (not an IDD marker -- see module header for why) -------
  const deadlineMinutes = Number.isFinite(options.deadlineMinutes)
    ? Number(options.deadlineMinutes)
    : DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES;
  const headCommittedAt = String(options.headCommittedAt ?? '');
  const elapsedMinutes = isValidIsoTimestamp(headCommittedAt)
    ? minutesBetween(headCommittedAt, now)
    : null;
  const deadlinePassed =
    elapsedMinutes !== null && elapsedMinutes >= deadlineMinutes;
  const deadline: AdvisoryConvergenceDeadline = {
    minutes: deadlineMinutes,
    headCommittedAt,
    elapsedMinutes,
    passed: deadlinePassed,
  };

  // --- Terminal Copilot-unavailability evidence (#1570/#1572) ------------
  // Reuses `review.commitId` (Clause 1's absolute-latest Copilot review, `''`
  // when none exists) as the `lastCopilotCommit` input -- the same fetched
  // evidence, no separate lookup. Purely additive: computed unconditionally,
  // reported in its own `terminal` field (never merged into `deadline`
  // above), and -- per `buildCopilotRecoverySummary`'s own contract --
  // `state: "COPILOT_UNAVAILABLE"` is waiver *eligibility* only. It is
  // structurally impossible for `terminal` alone to set `converged`/`ready`:
  // see the waiver-gate and `ready` computation below, both of which require
  // a valid waiver in addition to `terminalUnavailable`.
  // Note: `pre-merge-readiness.mts` resolves `lastCopilotCommit` differently
  // (submittedAt-sorted via `findLastCopilotReviewCommit`, not fetch-order
  // `.at(-1)`), so under a force-push/revert ordering the two gates could
  // disagree on terminal state. Tolerable by construction: both gates must
  // independently pass to merge, so any disagreement fails closed (the
  // stricter side blocks; a waiver resolves it) -- never an unsafe merge.
  const recoveryCycleCap =
    Number.isFinite(options.recoveryCycleCap) &&
    Number(options.recoveryCycleCap) > 0
      ? Number(options.recoveryCycleCap)
      : DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP;
  const terminalWindowMinutesOption =
    Number.isFinite(options.terminalWindowMinutes) &&
    Number(options.terminalWindowMinutes) > 0
      ? Number(options.terminalWindowMinutes)
      : DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES;
  const terminal = buildCopilotRecoverySummary(
    { comments, prHeadSha, lastCopilotCommit: review.commitId },
    {
      now,
      trustedMarkerLogins,
      claimId: activeClaimId,
      agentId: claim.activeClaim?.agentId ?? '',
      recoveryCycleCap,
      terminalWindowMinutes: terminalWindowMinutesOption,
    },
  );
  const terminalUnavailable = terminal.state === 'COPILOT_UNAVAILABLE';

  // --- Waiver escape hatch (reachable once the deadline has passed, or ---
  // --- once terminal Copilot unavailability is proven -- either one ------
  // --- independently opens the SAME waiver-evidence check below) ---------
  const waiverMode = String(options.waiverMode ?? 'disabled');
  const waiverCheckSelector =
    String(options.waiverCheckSelector ?? '').trim() ||
    ADVISORY_CONVERGENCE_CHECK_SELECTOR;
  let validWaiverCount = 0;
  if (
    !converged &&
    (deadlinePassed || terminalUnavailable) &&
    waiverMode === 'maintainer-authorized'
  ) {
    const waiverEvidence = summarizeExternalCheckWaivers(comments, {
      prHeadSha,
      activeClaimId,
      trustedMarkerLogins,
      now,
      // The REAL configured `ciGate.externalChecks.waivable` list (not a
      // hardcoded single-entry override for this gate's own selector):
      // respects the existing two-dimensional waiver opt-in
      // (`externalCheckWaivers.mode` AND a per-check `waivable`
      // registration) instead of silently making this gate waivable the
      // moment ANY external check is opted into waiver mode (see PR #1343
      // review). An absent/empty list waives nothing, matching
      // `summarizeExternalCheckWaivers`'s own "empty list waives nothing"
      // contract.
      waivableSelectors: [...(options.waivableSelectors ?? [])],
      maxValidity: String(options.waiverMaxValidity ?? 'PT24H'),
    });
    // Even when the configured list makes SOME check waivable, only count a
    // waiver whose own marker selector is THIS gate's selector -- a valid
    // waiver for an unrelated external check must never satisfy this one.
    // The SAME evidence collection satisfies either precondition above: a
    // maintainer posts one waiver marker for this selector/HEAD/claim, and
    // whichever precondition (ordinary deadline, or terminal eligibility)
    // is currently open consumes it -- see the `ready` computation below,
    // which still requires the precondition it corresponds to.
    validWaiverCount = waiverEvidence.valid.filter(
      (entry) => entry.checkSelector === waiverCheckSelector,
    ).length;
  }
  const waiver: AdvisoryConvergenceWaiver = {
    mode: waiverMode,
    checkSelector: waiverCheckSelector,
    activeClaimId,
    validCount: validWaiverCount,
  };
  const waived = !scopeNotApplicable && validWaiverCount > 0;
  if (!scopeNotApplicable && !converged && terminalUnavailable && !waived) {
    reasons.push(
      waiverMode === 'maintainer-authorized'
        ? `Copilot is terminally unavailable (recovery cap exhausted and terminal window elapsed with no current-HEAD review) with no valid maintainer external-check waiver for selector "${waiverCheckSelector}" on current HEAD`
        : `Copilot is terminally unavailable (recovery cap exhausted and terminal window elapsed with no current-HEAD review) and no waiver is available (ciGate.externalCheckWaivers.mode is "${waiverMode}", not "maintainer-authorized")`,
    );
  } else if (!scopeNotApplicable && !converged && deadlinePassed && !waived) {
    reasons.push(
      waiverMode === 'maintainer-authorized'
        ? `deadline (${deadlineMinutes}m) passed with no valid maintainer external-check waiver for selector "${waiverCheckSelector}" on current HEAD`
        : `deadline (${deadlineMinutes}m) passed and no waiver is available (ciGate.externalCheckWaivers.mode is "${waiverMode}", not "maintainer-authorized")`,
    );
  }

  const ready =
    scopeNotApplicable ||
    converged ||
    ((deadlinePassed || terminalUnavailable) && waived);

  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prNumber: inputs.prNumber,
    prHeadSha,
    now,
    primaryBotLogin,
    applicability,
    review,
    threads: threadClause,
    pending,
    deadline,
    waiver,
    dispositionEvidence: dispositionEvidenceReport,
    sameHeadReroll,
    terminal,
    converged,
    waived,
    ready,
    reasons,
  };
}

// `isVerifiedCopilotAuthor` (#1686 defense-in-depth on top of
// `isCopilotReviewerLogin`'s login-string check) and
// `resolveLatestCopilotReviewClause` (Clause 1 evaluation against the
// single, absolute-latest Copilot review) now live in `review-clause.mts`
// and are imported above -- both used here unchanged, with
// `isVerifiedCopilotAuthor` also reused directly by
// `classifyCopilotAuthoredThreadIds` below.

/** Thread IDs whose *originating* (first) comment is Copilot-authored.
 * `summarizeReviewThreadsForGate` classifies by latest-commenter identity
 * for a different purpose (backlog gating) and is not bot-scoped, so this
 * is new, narrow logic -- the disposition-marker validity it feeds into
 * still comes entirely from the reused `summarizeDispositionEvidenceForGate`
 * output. */
export function classifyCopilotAuthoredThreadIds(
  threads: ReviewThreadPayload[],
  primaryBotLogin: string,
): Set<string> {
  const ids = new Set<string>();
  threads.forEach((thread, index) => {
    // GitHub's GraphQL `comments` connection on a review thread returns
    // comments in creation order -- the same assumption `fetchReviewThreads`
    // / `fetchThreadCommentPages` already rely on when appending paginated
    // results without re-sorting -- so the thread-opening comment is always
    // `nodes[0]`. Deliberately not timestamp-sorted: `compareIsoTimestamps`
    // sorts a missing/invalid `createdAt` BEFORE any valid one (by design,
    // for existing "pick the latest, ignore garbage" call sites elsewhere),
    // which would let a later reply with a bad timestamp silently usurp
    // "originating" status and make a genuinely Copilot-opened thread
    // invisible to this gate.
    const originating = (thread.comments?.nodes ?? [])[0];
    if (
      originating &&
      isVerifiedCopilotAuthor(originating.author, primaryBotLogin)
    ) {
      // Match `summarizeDispositionEvidenceForGate`'s own
      // `missingThreads[].id` fallback exactly (protocol-helpers.mts) so a
      // thread with an empty/missing GraphQL id still round-trips through
      // the `.has()` lookup in the caller instead of silently diverging.
      ids.add(String(thread.id ?? '') || `thread-${index + 1}`);
    }
  });
  return ids;
}

/**
 * Same-HEAD advisory reroll marker evidence (#1511): count and latest
 * GitHub `created_at` of trusted `advisory-reroll:` comments whose embedded
 * HEAD SHA matches the current HEAD. Mirrors `summarizeAdvisoryWaitMarkers`
 * (protocol-helpers.mts)'s same-head-scoped half, but kept local to this
 * file rather than added there -- matching the `classifyCopilotAuthored-
 * ThreadIds` precedent above (new, gate-specific logic that no other
 * helper needs). Deliberately does NOT feed `advisory-wait:`'s unscoped
 * REQUEST_CAP counting: separateness from that cap is a named #1511
 * acceptance criterion, achieved simply by using a distinct marker prefix
 * that `summarizeAdvisoryWaitMarkers`'s own regexes never match.
 */
function summarizeSameHeadRerollMarkers(
  comments: IssueCommentPayload[],
  prHeadSha: string,
  trustedMarkerLogins: string[],
): { count: number; latestAt: string } {
  const trusted = new Set(trustedMarkerLogins);
  // prHeadSha is already validated to `^[0-9a-f]{40}$` by the caller (see
  // the top of computeAdvisoryConvergenceVerdict), so it is safe to embed
  // directly in a RegExp literal with no escaping -- a hex string has no
  // regex-special characters. Requires the FULL canonical marker shape --
  // a valid trailing ISO-8601 timestamp, end-anchored -- matching the
  // `advisory-reroll:` entry in `OPERATIONAL_MARKERS` (marker-helpers.mts)
  // exactly, not merely a loose prefix+SHA check: an accidental or
  // malformed trusted comment (a typo'd timestamp, or appended prose after
  // the SHA) must never consume one of the bounded reroll attempts, since
  // that budget is small (default 2) and a false increment costs much more
  // proportionally than it would against the much larger REQUEST_CAP
  // (PR #1517 review).
  const pattern = new RegExp(
    `^advisory-reroll:\\s+\\S+\\s+${prHeadSha}\\s+\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z\\s*$`,
  );
  let count = 0;
  let latestAt = '';
  for (const comment of comments) {
    const body = String(comment.body ?? '').trimEnd();
    if (!pattern.test(body)) continue;
    const login = String(comment.author?.login ?? comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trusted.has(login)) continue;
    count += 1;
    // GitHub server `createdAt`/`created_at` ONLY -- never an embedded,
    // agent-supplied timestamp. Same "clock anchor is marker created_at,
    // not embedded text" invariant AW2 already states for advisory-wait:,
    // load-bearing here since `inFlight` compares this against
    // `review.submittedAt`, another GitHub server timestamp.
    const createdAt = String(comment.createdAt ?? comment.created_at ?? '');
    if (
      isValidIsoTimestamp(createdAt) &&
      (!latestAt || Date.parse(createdAt) > Date.parse(latestAt))
    ) {
      latestAt = createdAt;
    }
  }
  return { count, latestAt };
}

/** Whole minutes elapsed from `start` to `end`, clamped to 0 and floored --
 * matching `minutesBetweenIso` (protocol-helpers.mts) exactly, so a clock-
 * skew or malformed-timestamp edge case can never make `deadline.elapsed-
 * Minutes` negative or fractional. Not reused directly since that helper is
 * not exported. */
function minutesBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

/** Parsed CLI arguments. */
interface AdvisoryConvergenceArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  claimIssueNumber: number | null;
  trustedMarkerLogins: string;
  advisoryBotLogins: string;
  now: string;
  assert: boolean;
  help: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
const ADVISORY_CONVERGENCE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--claim-issue': { type: 'string' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--advisory-bot-logins': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--assert': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

export function parseArgs(argv: string[]): AdvisoryConvergenceArgs {
  const { values, help } = parseCliArgs(argv, ADVISORY_CONVERGENCE_FLAG_SPEC);
  return {
    // Both resolve-to-null on an invalid/absent value (fails closed at the
    // caller) -- the established contract this migration must preserve;
    // see "an invalid --pr resolves to null" in tests/advisory-convergence.
    // test.mts.
    prNumber: parseCanonicalIntegerOrNull(values.pr as string | undefined),
    owner: values.owner as string,
    repo: values.repo as string,
    claimIssueNumber: parseCanonicalIntegerOrNull(
      values['claim-issue'] as string | undefined,
    ),
    trustedMarkerLogins: values['trusted-marker-logins'] as string,
    advisoryBotLogins: values['advisory-bot-logins'] as string,
    now: values.now as string,
    assert: values.assert as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/advisory-convergence.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--claim-issue <number>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--now <ISO8601>] [--assert] [--help]

Read-only: asserts whether the primary advisory bot's review has converged
on the current PR HEAD. Every invocation other than --help/-h prints the
JSON verdict to stdout. Without --assert, always exits 0 (report-only).
With --assert, exits non-zero unless the verdict is "ready" (converged, or
validly waived past the configured deadline).
`);
}

/** Dependencies injected by tests; production defaults perform real I/O. */
export interface AdvisoryConvergenceDeps {
  collect: (args: AdvisoryConvergenceArgs) => {
    inputs: AdvisoryConvergenceInputs;
    options: AdvisoryConvergenceOptions;
  };
}

const defaultDeps: AdvisoryConvergenceDeps = { collect: collectFromGitHub };

/**
 * Parse argv, collect evidence (via `deps.collect`, real `gh` calls by
 * default), compute the verdict, and derive the `--assert` exit code.
 * Mirrors `idd-merge-execute.mts`'s `runMergeExecute` DI pattern so tests
 * can substitute a fake `collect` instead of shelling out to `gh`.
 */
export function runAdvisoryConvergence(
  argv: string[],
  deps: AdvisoryConvergenceDeps = defaultDeps,
): {
  verdict: AdvisoryConvergenceVerdict | null;
  exitCode: number;
  help: boolean;
} {
  const args = parseArgs(argv);
  if (args.help) {
    return { verdict: null, exitCode: 0, help: true };
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const { inputs, options } = deps.collect(args);
  const verdict = computeAdvisoryConvergenceVerdict(inputs, options);
  const exitCode = args.assert ? (verdict.ready ? 0 : 1) : 0;
  return { verdict, exitCode, help: false };
}

// --- Production I/O: fetch PR/review/thread/comment evidence via `gh` ----

/**
 * `gh` options for the viewer-login probe (`gh api user`).
 *
 * Under GitHub Actions the workflow token is a GitHub App installation token
 * with no authenticated user, so `gh api user` always returns 403 ("Resource
 * not accessible by integration"). That is expected and harmless here:
 * {@link safeGhText} swallows it and `viewerLogin === ''` is the correct value
 * in CI (there is no runner "self" whose markers should be trusted). Only the
 * inherited stderr leaks the confusing 403 line into the run log, so under
 * Actions we capture that run's stderr (`stdio` pipe) to keep the log clean.
 *
 * Outside Actions (a local/interactive run) the probe normally succeeds; if it
 * genuinely fails we deliberately **inherit** stderr so the failure stays
 * visible — a silently-empty `viewerLogin` narrows self-marker trust, the same
 * fail-noisy concern #1396 hardens for the roadmap-audit helper.
 *
 * Both branches set `stdio` **explicitly** rather than leaning on
 * `execFileSync`'s default: that default already writes the child's stderr to
 * the parent (so a bare call would leak the 403), but relying on it is
 * non-obvious. `pipe` captures stderr (silent); `inherit` forwards it to the
 * parent (visible). stdin is `ignore` on both, matching `GH_TEXT_LOOP_OPTIONS`'
 * stdin-safety.
 */
export function viewerProbeGhOptions(
  env: NodeJS.ProcessEnv = process.env,
): GhTextOptions {
  return {
    stdio:
      env.GITHUB_ACTIONS === 'true'
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'inherit'],
  };
}

function collectFromGitHub(args: AdvisoryConvergenceArgs): {
  inputs: AdvisoryConvergenceInputs;
  options: AdvisoryConvergenceOptions;
} {
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const viewerLogin = safeGhText(
    ['api', 'user', '--jq', '.login'],
    viewerProbeGhOptions(),
  ).toLowerCase();
  const rawConfig = loadIddConfig();
  const { actors: configuredTrustedActors } = resolveTrustedMarkerActors({
    flagValue: args.trustedMarkerLogins,
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: rawConfig,
  });
  const { logins: advisoryBotLogins } = resolveAdvisoryBotLogins({
    flagValue: args.advisoryBotLogins,
    envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
    config: rawConfig,
  });
  const pr = JSON.parse(
    ghText([
      'pr',
      'view',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'headRefOid,headRefName,closingIssuesReferences,author,url',
    ]),
  ) as {
    headRefOid?: unknown;
    headRefName?: unknown;
    closingIssuesReferences?: ClosingIssueRefPayload[] | null;
    author?: GhAuthorPayload | null;
    url?: unknown;
  };
  const prHeadSha = String(pr.headRefOid ?? '').toLowerCase();
  const prHeadRefName = String(pr.headRefName ?? '').trim();
  const prAuthorLogin = String(pr.author?.login ?? '').toLowerCase();
  const prUrl = String(pr.url ?? '');

  // Fetched here (ahead of `trustedMarkerLogins` below) so a collaborator's
  // marker-shaped PR comment can be detected before that set is used to
  // resolve `claimEvents` -- see `resolveTrustedCollaboratorMarkerLogins`.
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    {
      paginate: true,
    },
  ) as IssueCommentPayload[];

  // #1344: collaborator-marker trust, matching `pre-merge-readiness.mts`'s
  // `readCollaboratorTrustEnabled` exactly, except reusing the already-
  // loaded `rawConfig` instead of a second `.github/idd/config.json` read
  // (`resolveCollaboratorMarkerTrust` and `loadIddConfig` are both already
  // null-safe, so no extra try/catch is needed for that simplification).
  const collaboratorTrustEnabled = resolveCollaboratorMarkerTrust(
    rawConfig,
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );

  const { reviews, headCommittedAt } = fetchReviewsAndHeadCommit(
    owner,
    repo,
    Number(args.prNumber),
  );
  const threads = fetchReviewThreads(owner, repo, Number(args.prNumber));

  // #1347: fetch every claim-issue candidate's raw comments (pure I/O)
  // BEFORE computing `trustedMarkerLogins`, so collaborator-marker trust
  // can be resolved from ALL candidates' comments -- not just whichever
  // one the presence-check below eventually picks. Folding trust only
  // from the already-picked candidate is circular: a lone candidate's
  // claim-establishing marker, authored by a login trusted only via
  // collaborator-marker trust, would never register as "active" for the
  // presence check to pick it in the first place, discarding the real
  // claim data before that trust is ever computed. See
  // `pickResolvingClaimEvents`'s doc comment for the full history.
  const claimCandidates = fetchClaimEventCandidates(
    owner,
    repo,
    args.claimIssueNumber,
    pr.closingIssuesReferences,
  );

  // Deliberately NOT unioned with `advisoryBotLogins` here (unlike some
  // other locally-collected sets in this file that scope broader trust for
  // marker *parsing*): every sibling helper (advisory-wait-state.mts,
  // pre-merge-readiness.mts) keeps `trustedMarkerLogins` and
  // `advisoryBotLogins` disjoint, and this specific set also authorizes
  // `--assert`-gating external-check waivers (via `summarizeExternalCheck-
  // Waivers`, below) -- folding a configured advisory bot login in here
  // would let that bot's own comment count as a "maintainer-authorized"
  // waiver author.
  //
  // #1344/#1347: folds collaborator-marker trust over the UNION of PR
  // comments and EVERY claim-issue candidate's comments, matching
  // `pre-merge-readiness.mts`'s `[...comments, ...claimComments]` union in
  // spirit (extended here to all candidates, since this gate -- unlike
  // pre-merge-readiness.mts -- auto-discovers among several linked issues
  // rather than requiring a single explicit one). Scanning `comments`
  // alone would make `collaboratorTrustEnabled` a no-op for claim and
  // forced-handoff markers: those are always posted to the claim ISSUE,
  // never the PR (see `forced-handoff-marker.mts`), and
  // `applyClaimEvent`'s `isTrustedAuthor` gate runs before any
  // claim/forced-handoff parsing -- an untrusted-author's marker never
  // even reaches the authorization check.
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(owner, repo, [
          ...comments,
          ...claimCandidates.flat(),
        ])
      : []),
  ]);

  // #1810: delegates to `resolveClaimEvidence` (below `hasTrustedClaimMarker-
  // History`'s definition) instead of calling `pickResolvingClaimEvents` /
  // `classifyClaimCandidateAmbiguity` / `hasTrustedClaimMarkerHistory`
  // separately here -- see that function's doc comment for why this call
  // site's own compute-and-forward wiring needed a direct test, not just
  // the three underlying helpers.
  const { claimEvents, claimCandidateAmbiguous, claimMarkerHistoryPresent } =
    resolveClaimEvidence(
      claimCandidates,
      trustedMarkerLogins,
      Boolean(args.claimIssueNumber),
    );

  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const deadlineMinutes = readAdvisoryConvergenceDeadlineMinutes();
  // #1511: bounded same-HEAD reroll cap, plus the existing pendingWindow
  // (reused, not a new duration knob) that bounds how long a reroll can
  // stay "in flight" before a caller may safely retry.
  const sameHeadRerollCap = readAdvisorySameHeadRerollCap();
  const { pendingWindowMinutes } = readAdvisoryWaitPolicy();
  // #1570/#1572: bounded per-PR-HEAD Copilot stall-recovery cycle cap and
  // 12h terminal-unavailability window, read independently of the five-key
  // `AdvisoryWaitPolicy` shape above for the same reason `sameHeadRerollCap`
  // is (see advisory-wait-policy.mts's own doc comments on each resolver).
  const recoveryCycleCap = readAdvisoryRecoveryCycleCap();
  const terminalWindowMinutes = readAdvisoryTerminalWindowMinutes();
  // No manual cast: `normalizePolicyConfig`'s inferred return type already
  // carries `ciGate.externalCheckWaivers.{mode,maxValidity}` precisely (see
  // `external-check-waiver.mts`'s `NormalizedPolicy` alias for the same
  // pattern) -- re-declaring the shape here would silently stop tracking
  // that source of truth on drift.
  const policy = normalizePolicyConfig(rawConfig);

  // #1344: forced-handoff-aware claim resolution, matching
  // `pre-merge-readiness.mts` exactly, except reading `forcedHandoff.mode`/
  // `authorityPolicy` off the already-loaded/normalized `policy` above
  // instead of `readForcedHandoffMode()`/`readForcedHandoffAuthorityPolicy()`
  // (each of which independently re-reads and re-parses
  // `.github/idd/config.json`) -- `readForcedHandoffPolicy`
  // (collaborator-permission.mts) computes those two fields via the exact
  // same `normalizePolicyConfig` call, so `policy.forcedHandoff.*` is
  // identical, not an approximation.
  const forcedHandoffAuthorityPolicy = policy.forcedHandoff.authorityPolicy;
  const forcedHandoffEnabled = policy.forcedHandoff.mode === 'human-gated';
  const forcedHandoffPermissionCache: CollaboratorPermissionCache = new Map();
  // Part B (#1058): an issue-only handoff that predates the PR is honored
  // even against a PR-backed claim. Resolved only when forced handoffs are
  // enabled, and fails closed to `null` (reject) on any lookup/parse error
  // so a transient commits-API failure never widens what this gate accepts.
  let prFirstCommitAt: string | null = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = ghApiJson(
        `repos/${owner}/${repo}/pulls/${args.prNumber}/commits`,
        { paginate: true },
      ) as PrCommitPayload[];
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const staleAgeMs =
    parseIsoDurationToMs(policy.claimTiming.staleAge) ?? DEFAULT_STALE_AGE_MS;

  return {
    inputs: {
      prNumber: Number(args.prNumber),
      prHeadSha,
      reviews,
      threads,
      comments,
      claimEvents,
      claimMarkerHistoryPresent,
      claimCandidateAmbiguous,
    },
    options: {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      primaryBotLogin,
      trustedMarkerLogins,
      advisoryBotLogins,
      convergenceScope:
        policy?.advisoryWait?.convergenceScope === 'idd-claimed'
          ? 'idd-claimed'
          : 'all-prs',
      prHeadRefName,
      prAuthorLogin,
      headCommittedAt,
      deadlineMinutes,
      waiverMode: String(
        policy?.ciGate?.externalCheckWaivers?.mode ?? 'disabled',
      ),
      waiverMaxValidity: String(
        policy?.ciGate?.externalCheckWaivers?.maxValidity ?? 'PT24H',
      ),
      waiverCheckSelector: ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      waivableSelectors: policy?.ciGate?.externalChecks?.waivable ?? [],
      sameHeadRerollCap,
      pendingWindowMinutes,
      recoveryCycleCap,
      terminalWindowMinutes,
      forcedHandoffEnabled,
      isAuthorizedForcedHandoff: (forcedBy: string) =>
        isAuthorizedForcedHandoffActor(
          owner,
          repo,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          forcedHandoffPermissionCache,
        ),
      expectedLinkedPrs: [String(args.prNumber), prUrl].filter(Boolean),
      prFirstCommitAt,
      staleAgeMs,
    },
  };
}

/**
 * Fetch one issue's comments and normalize them to the `author.login` /
 * `createdAt` shape `resolveActiveClaim`/`applyClaimEvent`
 * (`protocol-helpers.mts`) require. Unlike `summarizeDispositionEvidence-
 * ForGate` / `summarizeExternalCheckWaivers`, the claim resolver has NO
 * `user.login` / `created_at` REST fallback (`event.author?.login ?? ''`,
 * `event.createdAt ?? ''`, verbatim) -- passing raw `gh api` REST comments
 * through unnormalized silently resolves `activeClaimPresent: false` for
 * every real claim, breaking the entire waiver escape hatch without any
 * error. `pre-merge-readiness.mts`'s own `normalizeClaimComment` does the
 * same normalization for the identical reason; mirrored here rather than
 * imported since it is not exported.
 */
function fetchClaimComments(
  owner: string,
  repo: string,
  issueNumber: number,
): IssueCommentPayload[] {
  const raw = ghApiJson(
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      paginate: true,
    },
  ) as IssueCommentPayload[];
  return raw.map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? comment.created_at ?? '',
    author: { login: comment.author?.login ?? comment.user?.login ?? '' },
  }));
}

/**
 * Fetch the claim-issue candidate(s)' raw comment streams -- pure I/O, no
 * trust judgment. When `explicitIssueNumber` (`--claim-issue`) is given,
 * fetch it alone -- no ambiguity to resolve. Otherwise a PR can close more
 * than one issue (`pr.closingIssuesReferences`), so fetch every candidate's
 * comments; {@link pickResolvingClaimEvents} disambiguates them afterward.
 *
 * Split out from a single `resolveClaimEvents` (#1344) so the
 * `trustedMarkerLogins` used for disambiguation can be computed from ALL
 * candidates' comments first (see the `collectFromGitHub` call site) --
 * #1347 found that resolving trust from only the eventually-picked
 * candidate is circular: a lone candidate's claim-establishing marker,
 * authored by a login trusted only via collaborator-marker trust, would
 * never be recognized as "active" long enough to be picked in the first
 * place, discarding the real claim data before that trust is ever folded
 * in.
 */
function fetchClaimEventCandidates(
  owner: string,
  repo: string,
  explicitIssueNumber: number | null,
  refs: ClosingIssueRefPayload[] | null | undefined,
): IssueCommentPayload[][] {
  if (explicitIssueNumber) {
    return [fetchClaimComments(owner, repo, explicitIssueNumber)];
  }
  const candidateNumbers = [
    ...new Set(
      (refs ?? [])
        .map((ref) => ref?.number)
        .filter((n): n is number => Number.isInteger(n)),
    ),
  ];
  return candidateNumbers.map((issueNumber) =>
    fetchClaimComments(owner, repo, issueNumber),
  );
}

/** Candidate claim-issue comment streams whose *active claim* actually
 * resolves (`summarizeClaimValidation`). Shared by
 * {@link pickResolvingClaimEvents} and {@link classifyClaimCandidateAmbiguity}
 * (#1686) so both read the identical disambiguation result instead of two
 * independently-maintained filters that could drift. */
function filterResolvingClaimCandidates(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
): IssueCommentPayload[][] {
  return candidates.filter((comments) =>
    Boolean(
      summarizeClaimValidation(comments, { trustedMarkerLogins })
        .activeClaimPresent,
    ),
  );
}

/**
 * Resolve the linked (claim) issue's comment stream for waiver-claim
 * binding, given already-fetched candidate comment streams
 * ({@link fetchClaimEventCandidates}) and a `trustedMarkerLogins` already
 * fully resolved (including any collaborator-marker-trust fold) over ALL
 * candidates' comments. Pure -- no I/O -- so it is directly unit-testable.
 *
 * `isExplicit` mirrors `fetchClaimEventCandidates`'s own
 * `explicitIssueNumber` check: an explicit `--claim-issue` candidate is
 * returned unconditionally, no ambiguity to resolve. Otherwise, keep only
 * the candidate whose *active claim* actually resolves
 * (`summarizeClaimValidation`), mirroring how `external-check-waiver.mts`'s
 * own `selectLinkedIssueCandidate` disambiguates multiple linked issues by
 * active-claim presence rather than requiring a single closing reference.
 * Zero or multiple resolving candidates fail closed to `[]` (no waiver
 * claim can bind unambiguously), same as before #1344/#1347 -- and
 * unchanged by #1686: {@link classifyClaimCandidateAmbiguity} below is the
 * new, separate signal that lets a caller tell the "zero resolving" and
 * "multiple resolving" cases apart without touching this function's own
 * fail-closed-to-`[]` contract (pinned by
 * "pickResolvingClaimEvents: zero or multiple resolving candidates still
 * fail closed to [] (unchanged from pre-#1344/#1347 behavior)" in
 * tests/advisory-convergence.test.mts).
 */
export function pickResolvingClaimEvents(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
  isExplicit: boolean,
): IssueCommentPayload[] {
  if (isExplicit) {
    return candidates[0] ?? [];
  }
  const resolving = filterResolvingClaimCandidates(
    candidates,
    trustedMarkerLogins,
  );
  return resolving.length === 1 ? resolving[0] : [];
}

/**
 * #1686: true when two or more claim-issue candidates each independently
 * resolve an active trusted claim -- the specific disambiguation-failure
 * case {@link pickResolvingClaimEvents} already fails closed to `[]` for
 * (see its own doc comment above and the module header's path 2). Surfaced
 * as an explicit signal so the `idd-claimed` applicability gate
 * (`computeAdvisoryConvergenceVerdict`) can distinguish "this PR's closing
 * references are ambiguous between two actively-claimed issues" from the
 * ordinary "no candidate resolves at all" case, which
 * `pickResolvingClaimEvents`'s own collapsed `[]` output cannot
 * distinguish by itself. An explicit `--claim-issue` target has no
 * ambiguity to resolve -- always `false`, mirroring
 * `pickResolvingClaimEvents`'s own `isExplicit` short-circuit.
 */
export function classifyClaimCandidateAmbiguity(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
  isExplicit: boolean,
): boolean {
  if (isExplicit) {
    return false;
  }
  return (
    filterResolvingClaimCandidates(candidates, trustedMarkerLogins).length > 1
  );
}

/**
 * #1686: true when at least one TRUSTED, syntactically valid `claimed-by`
 * marker exists anywhere in `candidates`' raw comment streams -- regardless
 * of whether it currently resolves to an ACTIVE claim. A released
 * (`unclaimed-by`), superseded-without-a-qualifying-takeover, or otherwise
 * no-longer-current claim still counts: this function answers "did real IDD
 * claim activity ever happen here", not "is a claim active right now" (that
 * question is `summarizeClaimValidation(...).activeClaimPresent`, already
 * computed elsewhere).
 *
 * Note on *why* this function is needed rather than an age comparison:
 * `resolveActiveClaim` (protocol-helpers.mts) has no `now` parameter and
 * never expires a claim by elapsed time alone -- staleness there only
 * matters when a LATER claim event attempts to supersede the active one
 * (`claim.supersedes === activeClaim.claimId && isStale(...)`). A claim
 * that goes stale on a long-open PR with no subsequent takeover event stays
 * `activeClaimPresent: true` forever in this codebase; time by itself never
 * clears it. So the concrete way `activeClaimPresent` becomes `false` while
 * genuine claim history exists is an explicit release/handoff event (or a
 * disambiguation failure -- see {@link classifyClaimCandidateAmbiguity}
 * instead), not a bare age computation -- this function's own test fixtures
 * demonstrate that shape rather than asserting on elapsed time. See the
 * module header's path 4 and `AdvisoryConvergenceInputs.claimMarkerHistoryPresent`'s
 * doc comment.
 */
export function hasTrustedClaimMarkerHistory(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
): boolean {
  const trusted = new Set(trustedMarkerLogins);
  return candidates.some((candidateComments) =>
    candidateComments.some((event) => {
      const login = String(event.author?.login ?? event.user?.login ?? '')
        .trim()
        .toLowerCase();
      if (!trusted.has(login)) {
        return false;
      }
      return (
        parseClaimComment(
          event.body ?? '',
          event.createdAt ?? event.created_at ?? '',
        ) !== null
      );
    }),
  );
}

/**
 * Resolve all three claim-evidence fields `collectFromGitHub` forwards into
 * {@link AdvisoryConvergenceInputs} from already-fetched claim candidates and
 * resolved trust -- pure (no I/O), so it is directly unit-testable, mirroring
 * {@link filterResolvingClaimCandidates}'s existing shared-helper extraction
 * pattern. `collectFromGitHub` previously called
 * {@link pickResolvingClaimEvents}, {@link classifyClaimCandidateAmbiguity},
 * and {@link hasTrustedClaimMarkerHistory} separately and forwarded their
 * results inline; that compute-and-forward wiring is itself the #1810 gap --
 * each of the three helpers has direct unit tests, but nothing proved the
 * real call site actually threads their outputs into the verdict inputs.
 * Collapsing all three into one exported step makes the call site a trivial,
 * visually obvious delegation and gives the wiring itself a direct test.
 */
export function resolveClaimEvidence(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
  isExplicit: boolean,
): {
  claimEvents: IssueCommentPayload[];
  claimCandidateAmbiguous: boolean;
  claimMarkerHistoryPresent: boolean;
} {
  const claimEvents = pickResolvingClaimEvents(
    candidates,
    trustedMarkerLogins,
    isExplicit,
  );
  // #1686: ambiguity is a distinct signal from `claimEvents` above --
  // `pickResolvingClaimEvents` deliberately collapses BOTH "zero candidates
  // resolve" and "two or more candidates resolve" to `[]` (see its own doc
  // comment), so this must be computed separately over the same
  // `candidates`/`trustedMarkerLogins` inputs rather than re-derived from the
  // already-collapsed `claimEvents`.
  const claimCandidateAmbiguous = classifyClaimCandidateAmbiguity(
    candidates,
    trustedMarkerLogins,
    isExplicit,
  );
  // #1686: true when ANY candidate claim issue ever carried a trusted,
  // syntactically valid `claimed-by` marker -- computed over the union of
  // every candidate's RAW comment stream (`candidates`, not the
  // resolved-and-possibly-emptied `claimEvents`), so a stale, released, or
  // otherwise no-longer-active claim still counts as genuine IDD claim
  // history. See `hasTrustedClaimMarkerHistory`'s doc comment for the full
  // rationale and the module header's path 4.
  const claimMarkerHistoryPresent = hasTrustedClaimMarkerHistory(
    candidates,
    trustedMarkerLogins,
  );
  return { claimEvents, claimCandidateAmbiguous, claimMarkerHistoryPresent };
}

/**
 * Candidate collaborator-marker-trust logins: comment authors whose comment
 * matches a recognized operational-marker prefix (claim, waiver,
 * forced-handoff, etc. -- `operationalMarkerPrefix`), permission-checked
 * and kept only when Write/Maintain/Admin. Mirrors
 * `pre-merge-readiness.mts`'s function of the same name exactly. The
 * `collectFromGitHub` call site passes the UNION of PR comments and the
 * resolved claim issue's own comments (matching `pre-merge-readiness.mts`'s
 * `[...comments, ...claimComments]` union) -- PR comments alone are not
 * enough, since forced-handoff and claim markers are always posted to the
 * claim issue, never the PR (see `forced-handoff-marker.mts`). Only called
 * when `markerTrust.allowCollaboratorMarkers` / `IDD_TRUST_COLLABORATOR_MARKERS`
 * is enabled -- a no-op repository never pays for these lookups.
 */
function resolveTrustedCollaboratorMarkerLogins(
  owner: string,
  repo: string,
  commentLikeEvents: IssueCommentPayload[],
): string[] {
  const markerAuthors = [
    ...new Set(
      commentLikeEvents
        .filter(
          (comment) => operationalMarkerPrefix(comment.body ?? '') !== null,
        )
        .map((comment) => comment.author?.login ?? comment.user?.login ?? '')
        .filter(Boolean),
    ),
  ];

  return markerAuthors.filter((login) => {
    const permission = safeGhText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ).toLowerCase();

    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}

// `ghGraphql` now lives in `gh-exec.mts` (imported above) and
// `fetchReviewsAndHeadCommit` (+ its local `RawReviewNode` shape) now
// lives in `review-clause.mts` (imported above) -- both used here
// unchanged. The other two `ghGraphql(...)` call sites in this file
// (`fetchReviewThreads` and the claim-candidate fetch below) keep calling
// the same function via the new import.

function fetchReviewThreads(
  owner: string,
  repo: string,
  prNumber: number,
): ReviewThreadPayload[] {
  const nodes: ReviewThreadPayload[] = [];
  let cursor: string | null | undefined = null;

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
                      author { login __typename }
                      pullRequestReview { id }
                    }
                  }
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
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
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

    if (!reviewThreads?.pageInfo?.hasNextPage) break;
    if (!reviewThreads.pageInfo.endCursor) {
      throw new Error('review thread pagination payload is missing endCursor');
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return nodes;
}

function fetchThreadCommentPages(
  threadId: string,
  afterCursor: string,
): ThreadCommentPayload[] {
  const nodes: ThreadCommentPayload[] = [];
  let cursor: string | null | undefined = afterCursor;

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
                  author { login __typename }
                  pullRequestReview { id }
                }
              }
            }
          }
        }`,
      { id: threadId, cursor },
    ) as {
      data?: {
        node?: {
          comments?: {
            pageInfo?: PageInfoPayload | null;
            nodes?: ThreadCommentPayload[] | null;
          } | null;
        } | null;
      } | null;
    };

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

// CLI: emit the verdict as JSON and set the exit code when invoked directly.
// Guarded behind `import.meta.main` so importing this module (for unit
// tests) never parses process.argv, prints usage, or makes a `gh` call.
if (import.meta.main) {
  const { verdict, exitCode, help } = runAdvisoryConvergence(
    process.argv.slice(2),
  );
  if (help) {
    printHelp();
  } else if (verdict) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  }
  process.exit(exitCode);
}
