// idd-generated-from: src/scripts/protocol-helpers.mts
//
// The scripts/protocol-helpers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  buildAdvisoryConvergenceWaiverPrecondition,
  buildSecondaryQuietWindowStatus,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  normalizeAdvisoryWaitRuntimeOptions,
  normalizeSecondaryBotLoginList,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from './advisory-wait-policy.mts';

// Re-exported so callers that already import advisory-bot-identity helpers
// from this façade (merged-pr-feedback-sweep.mts,
// disposition-non-review-notices.mts) can get the shared default-logins list
// from the same module instead of reaching into advisory-wait-policy.mts
// directly.
export { DEFAULT_ADVISORY_BOT_LOGINS } from './advisory-wait-policy.mts';
// Façade re-export (kurone-kito/idd-skill#3258): `isCopilotErrorReviewBody`
// now lives in the leaf `copilot-review-body.mts` module (alongside the new
// review-body shape classifier `review-clause.mts` also imports), so that
// module can be imported here -- rather than the reverse -- with no cycle.
// Re-exporting it keeps every existing call site importing it from
// protocol-helpers.mts (e.g. tests/pre-merge-readiness.test.mts) unchanged;
// the separate named import below is this module's own internal use in
// `findLastCopilotReviewCommit`, mirroring the `marker-helpers.mts` pattern
// immediately above.
export { isCopilotErrorReviewBody } from './copilot-review-body.mts';
// Façade re-export (wave 1 of the protocol-helpers split; see #1209): every
// marker render/parse primitive now lives in the marker-helpers module.
// Re-exporting it here keeps every existing call site importing from
// protocol-helpers unchanged. The named imports below are this module's own
// internal uses of those moved names; see marker-helpers for the layering
// rule (it must never import back from this file).
export * from './marker-helpers.mts';

import {
  classifyCopilotReviewBody,
  isCopilotErrorReviewBody,
} from './copilot-review-body.mts';
import { loadIddConfig } from './idd-config.mts';
import type {
  ParsedClaimMarker,
  ParsedForcedHandoffMarker,
  ParsedReviewWatermark,
} from './marker-helpers.mts';
import {
  advisoryWaitFamilyMarkerStart,
  detectMalformedOperationalMarker,
  findActivationNonceWinner,
  IDD_AGENT_DERIVED_MARKERS,
  isIddOriginatedReply,
  isValidIsoTimestamp,
  operationalMarkerPrefix,
  operationalMarkerPrefixByStart,
  parseAdvisoryWaitFamilyMarker,
  parseClaimComment,
  parseExternalCheckWaiverComment,
  parseForcedHandoffComment,
  parseOutOfLoopMarker,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from './marker-helpers.mts';
import {
  getReviewEscalationChangesRequestedPolicy,
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';

// ---------------------------------------------------------------------------
// Structural input shapes (GitHub REST/GraphQL payloads as consumed here).
// ---------------------------------------------------------------------------

/** Author reference embedded in GitHub comment/review payloads. */
interface AuthorRef {
  login?: string | null;
  /** REST `user.type` ("Bot"/"User"/...) -- GraphQL's equivalent
   * discriminator is `__typename`, carried separately by callers that read
   * it (see {@link isCopilotReviewerLogin}'s `authorType` parameter). */
  type?: string | null;
}

/** Issue/PR comment as consumed by the protocol helpers. */
interface CommentLike {
  id?: string | number | null;
  body?: string | null;
  author?: AuthorRef | null;
  user?: AuthorRef | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  url?: string | null;
  /** #3246: GraphQL `IssueComment.lastEditedAt`, or its snake_case
   * `last_edited_at` equivalent -- see `classifyCommentEditState`'s doc
   * comment for the three-state contract this reads. */
  lastEditedAt?: string | null;
  last_edited_at?: string | null;
  /** #3246 (Copilot review, PR #3403, round 3): the flat author-login shape
   * `provider-port.mts`'s `ProviderComment` and its review-thread comment
   * types actually carry -- distinct from this interface's own nested
   * `author.login`/`user.login` REST/GraphQL shapes. `isTrustEvidenceComment`
   * below reads this as a third fallback so a genuine provider-port comment
   * object (as the sibling claim-marker and review/merge-evidence/
   * disposition tracks this predicate exists for will pass it) doesn't
   * silently compute an empty login and fail closed for every trusted
   * caller. */
  authorLogin?: string | null;
}

/** Review-thread reply node (GraphQL `reviewThreads` comment). */
interface ThreadCommentLike {
  id?: string | number | null;
  body?: string | null;
  author?: AuthorRef | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  pullRequestReview?: { id?: string | null } | null;
  /** #3269: GraphQL `PullRequestReviewComment.lastEditedAt` -- see
   * `classifyCommentEditState`'s three-state contract. Populated only by
   * the two merge-gate collectors' own thread normalizers
   * (`pre-merge-readiness.mts`, `advisory-convergence.mts`); every other
   * consumer's thread comment leaves this `undefined` ('unknown' edit
   * state), which keeps `effectiveThreadCommentActivityAt`'s pre-#3269
   * `updatedAt` dating unchanged there. */
  lastEditedAt?: string | null;
  last_edited_at?: string | null;
  /** #3269: this comment's bounded `userContentEdits` revision history,
   * populated ONLY by the two merge-gate collectors, and only for
   * advisory-bot thread comments whose `lastEditedAt` postdates their
   * thread's latest IDD disposition -- see
   * `selectAdvisoryThreadCommentIdsEditedAfterDisposition` and
   * `attachReviewThreadCommentEditHistories`. Every other thread comment
   * (including an edited one at any other consumer) leaves this
   * `undefined`, which keeps `updatedAt` dating for it. */
  userContentEdits?: {
    totalCount: number;
    edits: {
      editedAt?: string | null;
      diff?: string | null;
      editorLogin?: string | null;
      deletedAt?: string | null;
    }[];
  } | null;
}

/** #3269: one entry {@link ProviderPort.getReviewThreadCommentUserContentEdits}
 * (provider-port.mts) returns -- declared structurally here (never
 * importing from provider-port.mts, matching this file's existing
 * generic-shape convention for every other `*Like` interface) so
 * {@link attachReviewThreadCommentEditHistories} stays a pure function a
 * collector can call with its own port-shaped result array. */
interface ReviewThreadCommentEditHistoryLike {
  commentId?: string | null;
  totalCount?: number | null;
  edits?:
    | {
        editedAt?: string | null;
        diff?: string | null;
        editorLogin?: string | null;
        deletedAt?: string | null;
      }[]
    | null;
}

/** Review thread (GraphQL `reviewThreads` node). */
interface ThreadLike {
  id?: string | null;
  isResolved?: boolean | null;
  updatedAt?: string | null;
  reviewerReopenedAt?: string | null;
  comments?: {
    nodes?: ThreadCommentLike[] | null;
    pageInfo?: { hasNextPage?: boolean | null } | null;
  } | null;
}

/** PR review object (REST or GraphQL shape). */
interface ReviewLike {
  state?: string | null;
  author?: AuthorRef | null;
  user?: AuthorRef | null;
  submittedAt?: string | null;
  submitted_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  createdAt?: string | null;
  commitId?: string | null;
  commit_id?: string | null;
  /** #3015: the review's own top-level body text -- both REST
   * (`GET /pulls/{n}/reviews`) and GraphQL already return this field under
   * the same `body` name, so no snake_case alias is needed here unlike
   * `submitted_at`/`commit_id` above. Consumed by
   * {@link isCopilotErrorReviewBody} (a configured non-Copilot primary bot)
   * and, as of #3265, by {@link classifyCopilotReviewBody} (the default
   * Copilot bot) to decide whether `findLastCopilotReviewCommit` counts
   * this review as covering its `commit_id`. */
  body?: string | null;
}

/**
 * CI status-check entry. `type` and `workflowName` are an optional
 * producer-identity discriminator (see #1483): `type` distinguishes a
 * GitHub Actions check-run from a legacy commit-status context (or any
 * other producer), and `workflowName` further distinguishes two
 * check-runs of the same name from different Actions workflows. Both are
 * optional so existing callers/fixtures that predate this discriminator
 * (only `name`/`state`/`completedAt`) remain valid -- see
 * `selectLatestCheckPerName` for how an absent discriminator is treated.
 *
 * `workflowPath` (#2919) strengthens `workflowName` further: `workflowName`
 * is only the workflow YAML's top-level `name:` display string, which two
 * DIFFERENT workflow files can declare identically (this repository's own
 * `.github/workflows/idd-advisory-convergence.yml` can still produce a
 * `pull_request` instance alongside its genuine `pull_request_target` one
 * from the SAME file whenever a same-repository PR reintroduces that
 * trigger to its own copy post-#2764 Phase 2 -- a legitimate same-file
 * case, not the gap this field closes; kurone-kito/idd-skill#3256 gates
 * that instance's own triggering event separately, at the collector
 * level, rather than here). `workflowPath` is the
 * check-run's owning workflow FILE path instead, sourced from the GitHub
 * Actions runs API's own `path` field (`GET
 * /repos/{owner}/{repo}/actions/runs/{run_id}`), which two genuinely
 * different workflow files can never share. Optional, absent-permissive
 * exactly like `type`/`workflowName`: a caller that never resolves it
 * (most callers -- resolving it costs an extra Actions API call per
 * distinct run) leaves every producer-key computation unchanged from
 * before this field existed. See `pre-merge-readiness.mts`'s collector for
 * the one caller that currently populates it, and that call site's own
 * comment for why population is scoped narrowly rather than universally.
 */
interface CheckLike {
  name?: string | null;
  state?: string | null;
  completedAt?: string | null;
  // #2353 (Codex review on PR #2370): when the live run itself began, as
  // opposed to when it finished. `treatAsCoveredByWaiver`'s freshness
  // cutoff anchors on this instead of `completedAt` -- a run that starts
  // evaluating state before a provider-outage declaration is posted never
  // observed it, even if the run doesn't finish (and post `completedAt`)
  // until moments after the declaration lands.
  startedAt?: string | null;
  type?: string | null;
  workflowName?: string | null;
  workflowPath?: string | null;
}

/** PR timeline event as consumed by the Copilot-coverage helpers. */
interface TimelineEventLike {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: AuthorRef | null;
}

/** Requested reviewer entry (login string or reviewer object). */
type RequestedReviewerLike =
  | string
  | { login?: string | null; user?: AuthorRef | null }
  | null
  | undefined;

/** Identity fields shared by required-reviewer references. */
interface RequiredReviewerRef {
  type?: unknown;
  id?: unknown;
  login?: unknown;
  slug?: unknown;
  team?: unknown;
  name?: unknown;
}

/** Required-reviewer rule entry (string or nested reviewer object). */
type RequiredReviewerLike =
  | string
  | (RequiredReviewerRef & {
      reviewer?: RequiredReviewerRef | null;
      minimum_approvals?: unknown;
      min_approvals?: unknown;
      file_patterns?: unknown[] | null;
      filePatterns?: unknown[] | null;
    })
  | null
  | undefined;

/** Required status-check entry in rules or classic protection payloads. */
type RawRequiredCheckLike =
  | string
  | {
      app_id?: unknown;
      integration_id?: unknown;
      source?: unknown;
      context?: unknown;
      name?: unknown;
      check?: unknown;
    }
  | null
  | undefined;

/** Check-bearing parameters object (rules or classic protection). */
interface RequiredCheckParametersLike {
  required_status_checks?: RawRequiredCheckLike[] | null;
  required_checks?: RawRequiredCheckLike[] | null;
  checks?: RawRequiredCheckLike[] | null;
  contexts?: RawRequiredCheckLike[] | null;
  // #1513: classic branch-protection's up-to-date-head flag (lives on
  // `branchProtection.required_status_checks.strict`).
  strict?: unknown;
  // #1513: a repository ruleset's up-to-date-head flag -- a sibling of the
  // check-list fields above within a `required_status_checks` rule's own
  // `parameters` (confirmed empirically against this repository's live
  // `main` ruleset: `gh api repos/{owner}/{repo}/rules/branches/main`).
  strict_required_status_checks_policy?: unknown;
}

/** Branch rule entry from the rules API. */
interface BranchRuleLike {
  type?: string | null;
  ruleset_id?: unknown;
  ruleset_source_type?: unknown;
  source_type?: unknown;
  ruleset_source?: unknown;
  source?: unknown;
  parameters?:
    | (RequiredCheckParametersLike & {
        required_approving_review_count?: unknown;
        require_code_owner_review?: unknown;
        required_review_thread_resolution?: unknown;
        required_reviewers?: RequiredReviewerLike[] | null;
        workflows?: unknown;
      })
    | null;
}

/** Branch ruleset entry from the rulesets API. */
interface BranchRulesetLike {
  id?: unknown;
  ruleset_id?: unknown;
  current_user_can_bypass?: unknown;
  bypass_actors?: unknown;
}

/** Classic branch-protection payload. */
interface BranchProtectionLike {
  required_pull_request_reviews?: {
    require_code_owner_reviews?: unknown;
    require_code_owner_review?: unknown;
    required_approving_review_count?: unknown;
    bypass_pull_request_allowances?: {
      users?: (string | { login?: unknown } | null)[] | null;
      teams?: (string | { slug?: unknown } | null)[] | null;
      apps?: (string | { slug?: unknown; app_slug?: unknown } | null)[] | null;
    } | null;
  } | null;
  required_conversation_resolution?: { enabled?: unknown } | null;
  required_status_checks?: RequiredCheckParametersLike | null;
}

/** Parsed CODEOWNERS rule line. */
interface CodeownersRule {
  pattern: string;
  users: string[];
  teams: string[];
  emails: string[];
}

/** Live-status digest field inputs (validated at render time). */
export interface LiveStatusDigestFields {
  phase?: unknown;
  claim?: unknown;
  branch?: unknown;
  lastChecked?: unknown;
  openBlockers?: unknown;
  nextAction?: unknown;
  authoritativeBy?: unknown;
}

/** Inputs for the advisory-wait outcome state machine. */
interface AdvisoryWaitOutcomeInput {
  lastCopilotCommit?: string | null;
  prHeadSha?: string | null;
  copilotPending?: boolean;
  copilotPendingCoversHead?: boolean;
  sameHeadMarkerPresent?: boolean;
  requestMarkerCount: number;
  elapsedMinutes: number;
  requestCap?: number;
  pendingWindowMinutes?: number;
  settledWindowMinutes?: number;
}

/** Normalized required-reviewer requirement row. */
interface ReviewerRequirement {
  identity: string;
  minimumApprovals: number;
  filePatterns: string[];
}

// ---------------------------------------------------------------------------
// Protocol data shapes crossing module boundaries.
// ---------------------------------------------------------------------------

/** Classification of a standalone advisory-bot comment. */
export interface CommentClassification {
  classifier: 'RESOLVED' | 'OUTDATED';
  reason: string;
}

/** Generic route decision returned by the gate evaluators. */
export interface RouteDecision {
  route: string;
  reason: string;
}

/** Trusted-marker actor resolution with its provenance. */
export interface TrustedMarkerActorResolution {
  actors: string[];
  source: 'flag' | 'env' | 'config' | 'none';
}

/** Union of trusted-marker actors collected across sources. */
export interface TrustedMarkerActorSourceMix {
  actors: string[];
  sources: string[];
}

/** Advisory-bot login resolution with its provenance. */
export interface AdvisoryBotLoginResolution {
  logins: string[];
  source: 'flag' | 'env' | 'config' | 'none';
}

/**
 * kurone-kito/idd-skill#3250: authority-lookup outcome the
 * `summarizeExternalCheckWaivers` caller's injected `resolveAuthority`
 * callback returns for one waiver author. Structurally mirrors
 * `provider-port.mts`'s `ProviderCollaboratorPermissionResult` (duck-typed
 * here rather than imported, so this façade file never pulls in the live
 * GitHub adapter that module's real implementation depends on) -- a gate
 * caller passes `(login) => port.getCollaboratorPermission(login)` directly.
 */
export type ExternalCheckWaiverAuthorityLookup =
  | { outcome: 'found'; permission?: string; roleName?: string }
  | { outcome: 'not-collaborator' }
  | { outcome: 'error' };

/** External-check waiver evidence grouped by validity bucket. */
export interface ExternalCheckWaiverEvidence {
  valid: {
    authorLogin: string;
    checkSelector: string;
    reason: string;
    expiresAt: string;
    // #2034: the waiver comment's own `createdAt` -- the moment a generic
    // waivable check's waiver became genuinely active. `summarizeRequiredChecks`
    // compares a matched check's `completedAt` against this (or a per-check
    // override, e.g. `idd-advisory-convergence`'s deadline-open moment) before
    // reporting `coveredByWaiver: true`, so a stale pre-waiver run stays
    // blocked. `'none'` when the comment's `createdAt` was unparseable --
    // fails closed (never covers).
    createdAt: string;
    /** kurone-kito/idd-skill#2657: the marker's optional `run-id:` field,
     * verbatim (`''` when absent). Only the `self-referential-bootstrap-auto`
     * consumer in `advisory-convergence.mts` reads this -- every other caller
     * of this function is unaffected by its presence. */
    runId: string;
  }[];
  expired: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
    /** kurone-kito/idd-skill#2911: the marker's `reason:` field,
     * verbatim -- needed to identify a `self-referential-bootstrap-auto`
     * marker even after it has expired (the `valid` bucket's own `reason`
     * field, added for #2657, is unreachable once a marker expires out of
     * that bucket). Every other caller of this function is unaffected by
     * its presence. */
    reason: string;
    /** kurone-kito/idd-skill#2911: the marker's optional `run-id:` field,
     * verbatim (`''` when absent) -- mirrors the `valid` bucket's own
     * `runId` field (#2657), needed so a stale-self-waiver consumer can
     * still run the same run-bound trust verification on an EXPIRED
     * marker. */
    runId: string;
    /** kurone-kito/idd-skill#2911 (Copilot review, PR #2915): the marker
     * comment's own `createdAt` (server timestamp, never the marker's
     * `created-at:` body field, mirroring how `parsed.createdAt` is
     * already sourced elsewhere in this function) -- a stale-self-waiver
     * consumer needs this as the LOWER bound of the marker's validity
     * window (paired with `expiresAt` as the upper bound): a marker
     * created AFTER a required check already completed could not
     * possibly have justified that earlier pass, no matter how far in
     * the future its `expiresAt` reaches. */
    createdAt: string;
  }[];
  wrongHead: {
    authorLogin: string;
    checkSelector: string;
    waiverHeadSha: string;
  }[];
  wrongClaim: {
    authorLogin: string;
    checkSelector: string;
    waiverClaimId: string;
    /** kurone-kito/idd-skill#2911: see `expired[].reason`'s doc comment
     * above -- the identical need applies to a `wrongClaim`-classified
     * marker, which likewise never reaches the `valid` bucket. */
    reason: string;
    /** kurone-kito/idd-skill#2911: see `expired[].runId`'s doc comment
     * above. */
    runId: string;
    /** kurone-kito/idd-skill#2911 (Copilot review, PR #2915): see
     * `expired[].createdAt`'s doc comment above -- the identical
     * lower-bound need applies to a `wrongClaim`-classified marker. */
    createdAt: string;
    /** kurone-kito/idd-skill#2911 (Codex review, PR #2915, P2): the
     * marker's `expiresAt` field, verbatim -- `wrongClaim` classification
     * happens BEFORE the expiry check in this function's own pipeline
     * (see that check's own comment below), so a marker can be BOTH
     * wrong-claim AND already-expired yet only ever reach the
     * `wrongClaim` bucket, never `expired`. Without this field, a
     * stale-self-waiver consumer has no way to exclude a wrong-claim
     * marker that expired before the check it's being checked against
     * ever completed -- see that consumer's own upper-bound check. */
    expiresAt: string;
  }[];
  unauthorized: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
  }[];
  /**
   * kurone-kito/idd-skill#3250: waivers whose author IS in the trusted
   * marker-actor set (so they pass `unauthorized` above) but whose live
   * collaborator-permission outcome does not satisfy the configured
   * `ciGate.externalCheckWaivers.authorityPolicy` -- for example a
   * Write-only collaborator under the default `owners-and-maintainers-only`
   * policy, admitted to the trusted set only through collaborator-marker
   * trust. `authority` is the observed `roleName`/`permission` (lowercased,
   * whichever is non-empty, `roleName` preferred), `'none'` for a resolved
   * non-collaborator, or `'unknown'` when the lookup errored or no
   * `resolveAuthority` callback was supplied at all. Excluded from `valid`
   * and never folds a check into `requiredChecksPassing`. Never populated
   * for the #2657 self-referential-bootstrap-auto marker, whose trust comes
   * from run-id/event-type/HEAD verification, not a collaborator role.
   */
  insufficientAuthority: {
    authorLogin: string;
    checkSelector: string;
    authority: string;
  }[];
  malformed: { authorLogin: string; bodyPreview: string }[];
  /**
   * Waivers that passed every validity check but name a check the policy
   * never declared waivable (`ciGate.externalChecks.waivable`); they are
   * excluded from `valid` and never fold a check into `requiredChecksPassing`.
   */
  notConfigured: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
  }[];
  /**
   * Waivers that passed every validity and waivable-selector check but the
   * policy's `ciGate.externalCheckWaivers.mode` is not `maintainer-authorized`
   * (#2046); they are excluded from `valid` and never fold a check into
   * `requiredChecksPassing`, mirroring `advisory-convergence.mts`'s own
   * mode guard.
   */
  modeDisabled: {
    authorLogin: string;
    checkSelector: string;
    expiresAt: string;
  }[];
  /**
   * #3246: waivers whose marker-shaped comment is body-edited
   * (`editState: 'edited'`) or whose edit state could not be determined
   * (`editState: 'unknown'`) -- checked right after the #2657
   * reason-token exclusion and before every other classification, so a
   * body-edited or edit-state-unresolved marker never reaches `valid`
   * (or any other bucket) regardless of author, HEAD, claim, or expiry.
   * GitHub lets any Write-role collaborator or App rewrite an existing
   * comment's body in place while keeping its `id`, author, and
   * `created_at`, so those alone are not proof the body is still the one
   * that was posted -- see `classifyCommentEditState`'s doc comment for
   * the three-state contract this reads.
   */
  edited: {
    authorLogin: string;
    checkSelector: string;
    editState: 'edited' | 'unknown';
  }[];
}

/** Classification outcome for a single review thread at the gate. */
export interface ReviewThreadGateClassification {
  classification:
    | 'resolved'
    | 'actionable-blocking'
    | 'amd-blocking'
    | 'awaiting-reviewer'
    | 'conversation-resolve-agent'
    | 'conversation-resolve-author';
}

/** Aggregated review-thread gate counts. */
export interface ReviewThreadsGateSummary {
  actionableCount: number;
  awaitingReviewerCount: number;
  amdBlockingCount: number;
  conversationResolveAgentCount: number;
  conversationResolveAuthorCount: number;
  classifications: {
    id: string | null | undefined;
    classification: ReviewThreadGateClassification['classification'];
  }[];
}

/** Unreplied regular-comment summary for the merge gate. */
export interface RegularCommentsGateSummary {
  count: number;
  items: {
    id: string;
    authorLogin: string;
    createdAt: string;
    bodyPreview: string;
  }[];
}

/** Disposition-evidence gate outcome (E7 evidence at F2/F3). */
export interface DispositionEvidenceSummary {
  route: 'return-to-e1' | 'proceed';
  reason: string;
  blockingCount: number;
  missingRegularCommentCount: number;
  missingThreadCount: number;
  // Advisory-only (#978): true when there is at least one blocking item and
  // every blocking item is an ack-only-post-disposition resolved thread (no
  // missing regular comments, no non-ack thread). Lets autopilot deterministically
  // override a `return-to-e1` whose sole cause is post-disposition advisory-bot
  // acks. Never changes `route`; never relaxes the backstop for any other cause.
  soleCauseAckOnlyPostDisposition: boolean;
  // Advisory-only, narrower sibling of `soleCauseAckOnlyPostDisposition`
  // (#1313): true only when every blocking item is ALSO an in-place edit of
  // content that already existed at-or-before its thread's disposition (an
  // edited pre-existing comment, not a brand-new post-disposition comment).
  // This is a strict subset of the ack-only signal -- see
  // `missingThreads[].inPlaceEditOnly` for the per-thread detail and why this
  // still never changes `route` by itself: this helper's OWN heuristic here
  // (createdAt-at-or-before-disposition plus a later updatedAt, computed by
  // `classifyThreadAckOnlyPostDisposition`) still cannot mechanically verify
  // that an in-place edit only added cosmetic content (e.g. an "addressed"
  // badge) rather than changing the substance of the finding -- an agent
  // that wants to trust THIS signal must still read the comment's current
  // body before overriding. GitHub's API does expose a revision diff for an
  // edited comment (GraphQL `userContentEdits`, #3269 corrects an earlier,
  // broader claim that it does not): `hasFreshDisposition`'s own dating (via
  // `effectiveThreadCommentActivityAt`) now verifies a bounded set of such
  // edits directly, in the two merge-gate collectors that fetch that
  // history, so a thread whose sole blocker is a VERIFIED cosmetic edit
  // clears through `missingThreadCount`/`route` itself rather than needing
  // this advisory override at all.
  soleCauseInPlaceEditOnly: boolean;
  missingRegularComments: {
    id: string;
    authorLogin: string;
    createdAt: string;
    bodyPreview: string;
    // Diagnostic-only (present only when applicable), fail-open in favor of
    // the more specific case when both could apply:
    // - #1833: set when this missing comment is itself a recognized
    //   advisory non-review notice (`isAdvisoryNonReviewNotice`) AND a
    //   later IDD-agent reply starting with `**Rejected**` exists but does
    //   not match `isNonReviewNoticeDisposition` -- an attempted
    //   disposition that used the wrong phrase.
    // - #2249: otherwise, set when a later IDD-agent reply starts with
    //   `Accepted`/`Rejected`/`**Accepted`/`**Rejected` but does not
    //   satisfy `isDispositionComment` -- e.g. a plain `Accepted — ...`
    //   reply with no bold markdown at all.
    // Either way the generic 1:1 disposition pairing accepted the reply as
    // SOME disposition while the stricter check behind it still rejects it
    // and the item stays blocking. Names the exact required phrase/prefix
    // so an agent does not have to source-dive this file to discover it.
    // Never changes `route`, `reason`, or any count above.
    hint?: string;
  }[];
  // `ackOnlyPostDisposition` is advisory-only: true when this blocking resolved
  // thread blocks solely because of post-disposition advisory-bot ack-only
  // activity newer than the snapshot boundary. It never changes the entry's
  // `reason` or the summary `route`.
  missingThreads: {
    id: string;
    isResolved: boolean;
    reason: string;
    ackOnlyPostDisposition: boolean;
    // Advisory-only (#1313): true when `ackOnlyPostDisposition` is true AND
    // every qualifying comment is an in-place edit of a comment that already
    // existed at-or-before the thread's disposition (its own `createdAt` is
    // not newer than the disposition, and its `updatedAt` is strictly newer
    // than its own `createdAt`) -- distinguishing "the bot edited its own
    // already-dispositioned finding in place" from a generically ack-shaped
    // but genuinely new post-disposition comment. Still advisory-only: it
    // never changes `reason` or the summary `route` by itself. This raw-
    // timestamp heuristic is unrelated to, and unchanged by, #3269's
    // separate revision-content verification (see `soleCauseInPlaceEditOnly`'s
    // doc comment above) -- it stays a coarser, content-blind signal on
    // purpose, for the (non-advisory-bot, or unbounded-fetch-scope) cases
    // that verification never covers.
    inPlaceEditOnly: boolean;
  }[];
}

/** Advisory-wait marker counts split by marker-author trust. */
export interface AdvisoryWaitMarkerSummary {
  sameHeadMarkerPresent: boolean;
  /**
   * `#2327`: true only when a trusted same-HEAD marker is specifically the
   * plain request form (`advisory-wait:`), excluding `advisory-wait-recovery:`.
   * `sameHeadMarkerPresent` alone cannot distinguish "a request was actually
   * made for this HEAD" from "only a prior recovery cycle's own marker exists" --
   * AW3-S's non-pending failed-to-register entry must never treat
   * recovery-marker-only evidence as proof a request was requested.
   */
  sameHeadRequestMarkerPresent: boolean;
  earliestSameHeadAt: string;
  sameHeadMarkerCount: number;
  requestMarkerCount: number;
  trustedSameHeadMarkerCount: number;
  untrustedSameHeadMarkerCount: number;
  trustedRequestMarkerCount: number;
  untrustedRequestMarkerCount: number;
}

/** Claim-validation outcome for the merge gate. */
export interface ClaimValidationSummary {
  expectedClaimId: string;
  expectedAgentId: string;
  activeClaimPresent: boolean;
  activeClaim: {
    agentId: string;
    claimId: string;
    supersedes: string;
    branch: string;
    createdAt: string;
  };
  matchesExpectedClaim: boolean;
  claimLost: boolean;
  reason: string;
}

/** Claim-stream resolution callbacks and policies. */
interface ClaimResolutionOptions {
  isTrustedAuthor?: (login: string) => boolean;
  isForcedHandoffEnabled?: (
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentLike,
  ) => boolean;
  isAuthorizedForcedHandoff?: (
    forcedBy: string,
    forcedHandoff: ParsedForcedHandoffMarker,
    event: CommentLike,
  ) => boolean;
  isStale?: (activeCreatedAt: string, nextCreatedAt: string) => boolean;
  requireAuthorMatchesForcedBy?: boolean;
  onAnomalousHeartbeat?: (info: {
    agentId: string;
    claimId: string;
    activeBranch: string;
    heartbeatBranch: string;
    createdAt: string | null | undefined;
  }) => void;
  onIgnoredForcedHandoff?: (info: {
    reason: string;
    forcedHandoff: ParsedForcedHandoffMarker;
    event: CommentLike;
  }) => void;
}

/** Fully-defaulted form of {@link ClaimResolutionOptions}. */
type NormalizedClaimResolutionOptions = Required<ClaimResolutionOptions>;

export const LIVE_STATUS_DIGEST_MARKER = '<!-- idd-live-status: current -->';
export const LIVE_STATUS_DIGEST_HISTORICAL_MARKER =
  '<!-- idd-live-status: historical -->';
export const LIVE_STATUS_DIGEST_REPAIR_MARKER =
  '<!-- idd-live-status-repair: v1 -->';

/**
 * PR-scoped subset of `OPERATIONAL_MARKERS` (marker-helpers.mts) that can
 * legitimately appear as a comment on a PULL REQUEST -- the population
 * {@link classifyIddPrComment}'s marker-prefix branch draws from, and the
 * exact PREFIX set the two E1 exclusion lists
 * (`idd-review-snapshot(-lite).instructions.md`) name
 * (kurone-kito/idd-skill#3267). The two E1 lists also separately name the
 * three live-status digest forms (current/historical/repair-evidence,
 * exported as `LIVE_STATUS_DIGEST_MARKER` and friends) --
 * `classifyIddPrComment` recognizes those by first-line, not prefix, so
 * they are deliberately NOT part of this set; only the marker-PREFIX
 * portion of each E1 list is this export's parity target. Deliberately
 * narrower than the full `OPERATIONAL_MARKERS` array -- every excluded
 * entry is excluded for a specific, checked reason, not by omission.
 * `<!-- forced-handoff:` is NOT excluded by omission either: it genuinely
 * is PR-scoped (a `context-scope: issue-plus-pr` payload names an open
 * PR, per `idd-resume.instructions.md`'s forced-handoff evidence table),
 * so `classifyIddPrComment` recognizes it directly (still trust-gated,
 * same as every entry in this set) rather than through this array --
 * kept out of the E1-doc-parity target because the two written E1 lists
 * have never named it and this issue's own enumerated additions don't
 * either; adding it would cost doc-budget bytes neither near-ceiling
 * bundle can currently spare. `tests/pre-merge-readiness.test.mts`'s
 * "regular comment gate ignores/keeps forced-handoff markers" pair pins
 * this behavior.
 *  - `<!-- activation-nonce:` is posted only to the claiming ISSUE
 *    (idd-claim.instructions.md), never to a PR.
 *  - `<!-- idd-provider-outage-declaration:` and
 *    `<!-- idd-provider-outage-advanced:` are posted to the configured
 *    `providerOutage.declarationTarget` ISSUE, not the PR under review
 *    (see their own doc comments in marker-helpers.mts).
 *  - `<!-- idd-provider-outage-park:` and `<!-- idd-out-of-loop:` ARE
 *    posted on the PR itself, but each already has its own dedicated,
 *    non-review-activity consumer (`provider-outage-park.mts`'s resume
 *    logic, and `classifyPrLoopMembership` respectively) -- folding them
 *    into this review-activity exclusion set is out of this issue's
 *    scope, and the issue's own enumerated E1 doc additions omit both.
 */
export const PR_OPERATIONAL_COMMENT_PREFIXES: readonly string[] = Object.freeze(
  [
    '<!-- review-watermark:',
    '<!-- review-baseline:',
    '<!-- zero-accepted-path-a-gate:',
    '<!-- claimed-by:',
    '<!-- unclaimed-by:',
    'advisory-wait:',
    'advisory-wait-recovery:',
    '<!-- advisory-wait:',
    'advisory-reroll:',
    'review-ack:',
    'copilot-unavailable:',
    '<!-- idd-external-check-waiver:',
    '<!-- idd-local-validation-evidence:',
  ],
);

/**
 * The post-merge F4 cleanup evidence marker (kurone-kito/idd-skill#3267):
 * `post-merge-cleanup.yml` posts it under the `github-actions[bot]` identity
 * via `GITHUB_TOKEN`. Deliberately NOT part of `OPERATIONAL_MARKERS` /
 * `PR_OPERATIONAL_COMMENT_PREFIXES` -- unlike that array's entries, this
 * marker's own trust source (`idd-doctor.mts`'s
 * `readCleanupEvidenceTrustedLogins`) is the repository's configured
 * `trustedMarkerActors` PLUS `github-actions[bot]`, so it is checked
 * separately below under both the general trusted-union branch and the
 * `github-actions[bot]`-narrow branch, rather than folded into the
 * single OPERATIONAL_MARKERS-keyed check the trusted-union branch already
 * runs for every other prefix.
 */
const IDD_CLEANUP_EVIDENCE_PREFIX = '<!-- idd-cleanup-evidence:';

/**
 * The exact PR-comment marker prefix a same-repository GitHub Actions
 * workflow posts under the `github-actions[bot]` identity via `GITHUB_TOKEN`
 * with NO general trusted-actor requirement (kurone-kito/idd-skill#2657 /
 * #3267) -- confirmed against `advisory-convergence.mts`'s
 * self-referential-bootstrap-auto path, the only such workflow this
 * repository's own workflows post. `IDD_CLEANUP_EVIDENCE_PREFIX` above is
 * ALSO trusted from this same actor (checked separately, since it is also
 * trusted from a configured trustedMarkerActor, unlike this one). Deliberately
 * NOT `PR_OPERATIONAL_COMMENT_PREFIXES` or `OPERATIONAL_MARKERS` -- this is
 * narrow trust for this ONE actor, for exactly this one shape, never a
 * blanket trust grant for every operational marker that actor's login
 * could theoretically post (a `github-actions[bot]` comment starting with
 * any OTHER operational prefix, e.g. `<!-- claimed-by:`, is not trusted by
 * this path and counts as ordinary activity).
 */
const GITHUB_ACTIONS_BOT_ONLY_TRUSTED_PR_PREFIX =
  '<!-- idd-external-check-waiver:';

/** The GitHub Actions bot identity the two constants above scope trust to. */
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]';

export type IddPrCommentClassification =
  | 'idd-operational'
  | 'idd-disposition'
  | 'review';

/**
 * Classify one PR comment as IDD's own operational bookkeeping, an IDD
 * disposition reply, or genuine review activity -- the single decision
 * point kurone-kito/idd-skill#3267 unifies across the consumers that used
 * to apply their own, slightly different rule: `buildActivitySnapshotSummary`,
 * the shared `summarizeRegularCommentsForGate` /
 * `summarizeDispositionEvidenceForGate` gate helpers, `buildDispositionPlan`'s
 * `markerCouldBeStolen` (disposition-non-review-notices.mts),
 * `isIddBookkeeping` (merged-pr-feedback-sweep.mts), and
 * `audit-pr-cleanup.mts`'s own operational-marker check.
 *
 * The trusted set for this rule is the union of `trustedMarkerLogins` and
 * `iddAgentLogins` (normalized, case-insensitive) -- kept as two distinct
 * input fields rather than one, so a caller stays explicit about which
 * configured policy set supplies which login; see the acceptance criteria
 * on #3267 for why excluding only `trustedMarkerLogins` fails open (an IDD
 * agent's own digest refresh, posted under a login recorded only in
 * `iddAgentLogins`, would otherwise count as genuine activity and clear
 * earlier human feedback).
 *
 * Returns `idd-operational` in either of two cases:
 *  - the author is in the trusted union AND (the body starts with a
 *    `PR_OPERATIONAL_COMMENT_PREFIXES` entry OR `<!-- forced-handoff:`,
 *    matched via the lenient `operationalMarkerPrefixByStart` "begins
 *    with" check E1's written rule uses -- a malformed marker from a
 *    trusted actor is still their own bookkeeping, never someone else's
 *    review feedback -- OR its first line is one of the three
 *    live-status digest forms (current/historical/repair-evidence) OR it
 *    starts with `IDD_CLEANUP_EVIDENCE_PREFIX`);
 *  - the author is exactly `github-actions[bot]` and the body starts with
 *    `IDD_CLEANUP_EVIDENCE_PREFIX` or
 *    `GITHUB_ACTIONS_BOT_ONLY_TRUSTED_PR_PREFIX` -- independent of
 *    `trustedMarkerLogins`/`iddAgentLogins` membership.
 *
 * Returns `idd-disposition` when neither of the above matched but the
 * body is a recognized disposition shape (`isDispositionComment` /
 * `isNonReviewNoticeDisposition` / `isReviewSummaryDisposition`), gated on
 * the SAME trusted union -- an untrusted look-alike `**Accepted**` is
 * `review`, matching E1's "anything else, including marker-shaped
 * comments from untrusted authors" contract.
 *
 * Returns `review` otherwise. Consumers that only care about excluding
 * IDD's own bookkeeping from review-activity/disposition-evidence
 * accounting branch on `=== 'idd-operational'` alone; `idd-disposition`
 * is informational classification that intentionally keeps counting as
 * activity/reply evidence where the caller already relies on that
 * (E1's watermark ordering, kurone-kito/idd-skill#2590).
 */
export function classifyIddPrComment(
  comment: {
    body?: string | null;
    author?: AuthorRef | null;
    user?: AuthorRef | null;
  },
  options: {
    trustedMarkerLogins?: unknown[] | null;
    iddAgentLogins?: unknown[] | null;
  } = {},
): IddPrCommentClassification {
  const body = String(comment?.body ?? '');
  const authorLogin = String(
    comment?.author?.login ?? comment?.user?.login ?? '',
  )
    .trim()
    .toLowerCase();
  const trustedLogins = new Set([
    ...normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
    ...normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  ]);
  const isTrustedAuthor = trustedLogins.has(authorLogin);

  // #3267 (Copilot review, PR #3437): dispatch the github-actions[bot]
  // narrow-trust check FIRST, unconditionally -- never fold into the
  // `isTrustedAuthor` branch below. That account can be posted as by ANY
  // same-repository GitHub Actions workflow via `GITHUB_TOKEN`, so it must
  // never gain the FULL trusted-marker-actor grant just because some
  // caller's `trustedMarkerLogins`/`iddAgentLogins` set happens to also
  // include it for an unrelated reason (for example,
  // `idd-doctor.mts`'s `readCleanupEvidenceTrustedLogins` always unions it
  // in for its own cleanup-evidence check). Checking `isTrustedAuthor`
  // first here would let a general-purpose marker (e.g. `<!-- claimed-by:`)
  // slip through as `idd-operational` from that shared identity, contrary
  // to the issue's "no other operational-marker family is trusted from
  // github-actions[bot]" rule -- true regardless of trust configuration.
  if (authorLogin === GITHUB_ACTIONS_BOT_LOGIN) {
    const trimmedBody = body.trimStart();
    if (
      trimmedBody.startsWith(IDD_CLEANUP_EVIDENCE_PREFIX) ||
      trimmedBody.startsWith(GITHUB_ACTIONS_BOT_ONLY_TRUSTED_PR_PREFIX)
    ) {
      return 'idd-operational';
    }
  } else if (isTrustedAuthor) {
    const markerPrefix = operationalMarkerPrefixByStart(body);
    if (
      markerPrefix !== null &&
      (markerPrefix === '<!-- forced-handoff:' ||
        PR_OPERATIONAL_COMMENT_PREFIXES.includes(markerPrefix))
    ) {
      return 'idd-operational';
    }
    const bodyFirstLine = firstLine(body);
    if (
      bodyFirstLine === LIVE_STATUS_DIGEST_MARKER ||
      bodyFirstLine === LIVE_STATUS_DIGEST_HISTORICAL_MARKER ||
      bodyFirstLine === LIVE_STATUS_DIGEST_REPAIR_MARKER
    ) {
      return 'idd-operational';
    }
    if (body.trimStart().startsWith(IDD_CLEANUP_EVIDENCE_PREFIX)) {
      return 'idd-operational';
    }
  }

  if (
    isTrustedAuthor &&
    (isDispositionComment({ body }) ||
      isNonReviewNoticeDisposition({ body }) ||
      isReviewSummaryDisposition({ body }))
  ) {
    return 'idd-disposition';
  }

  return 'review';
}

export interface LiveStatusDigestSnapshotEntry {
  id: string;
  bodySha256: string;
}

export interface LiveStatusDigestSnapshot {
  targetState: string;
  entries: LiveStatusDigestSnapshotEntry[];
  sha256: string;
}

export interface LiveStatusDigestSnapshotComparison {
  matches: boolean;
  reason:
    | 'snapshot-matches'
    | 'digest-set-drift'
    | 'snapshot-drift'
    | 'invalid-expected-snapshot';
  snapshot: LiveStatusDigestSnapshot;
}

export interface LiveStatusDigestRepairRetirement {
  id: string;
  originalBody: string;
  originalBodySha256: string;
  retiredBody: string;
}

export interface LiveStatusDigestRepairPlan {
  action: 'ready' | 'invalid' | 'drift';
  canApply: boolean;
  reason: string;
  snapshot: LiveStatusDigestSnapshot;
  retainedCommentId: string;
  retirements: LiveStatusDigestRepairRetirement[];
}

export interface LiveStatusDigestRepairEvidenceFields {
  target: string;
  status: 'complete' | 'recovery-hold';
  actor: string;
  retainedCommentId: string;
  retiredCommentIds: string[];
  preflight: LiveStatusDigestSnapshot;
  postflight: LiveStatusDigestSnapshot | null;
  reason?: string;
}

const REVIEW_BOT_LOGINS = new Set([
  'coderabbitai',
  'coderabbitai[bot]',
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);

const UNSAFE_TEXT_RULES = [
  {
    pattern: /\*\*Awaiting maintainer decision\*\*/i,
    reason: 'contains an awaiting-maintainer-decision marker',
  },
  {
    pattern: /\bactive hold\b/i,
    reason: 'contains active hold context',
  },
  {
    pattern:
      /\bfailed[- ]ci\b|\bfailing ci\b|\bci failure\b|\bci failed\b|\bfailed checks?\b/i,
    reason: 'contains failed-CI context',
  },
];
// Exported (kurone-kito/idd-skill#3223) so copilot-review-wave-audit.mts can
// classify a reply as a recognized-but-non-accept/reject disposition using
// the exact same loose, no-em-dash-required marker this file's own
// `isDispositionComment`-adjacent checks use -- see that helper's own doc
// comment for why it reuses this pattern instead of
// review-disposition-verify.mts's stricter, em-dash-requiring MARKER_AMD_RE.
export const AMD_MARKER_PATTERN = /^\*\*Awaiting maintainer decision\*\*/i;

export function parsePaginatedGhNdjson(raw: unknown): unknown[] {
  const text = String(raw ?? '').trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const value: unknown = JSON.parse(line);
      return Array.isArray(value) ? value : [value];
    });
}

/** Check-run states treated as pass-equivalent for the CI required-check
 * gate: a check in one of these states is never eligible for waiver
 * coverage (already passing, or intentionally not run) and never counts as
 * a genuinely non-passing cause. Hoisted to module scope (#2021) so both
 * {@link summarizeRequiredChecks} and {@link computePreMergeReadinessBlockers}
 * share one definition instead of two independently-maintained copies.
 * Exported (kurone-kito/idd-skill#3256) for a third consumer,
 * `pre-merge-readiness.mts`'s collector, which needs the identical
 * pass-equivalent test to decide whether a resolved `idd-advisory-
 * convergence` check-run instance's SUCCESS-shaped state would otherwise
 * satisfy the required check before it can gate that on the instance's own
 * triggering event. */
export const CHECK_PASS_EQUIVALENT_STATES = new Set([
  'SUCCESS',
  'SKIPPED',
  'NEUTRAL',
  'NOT_APPLICABLE',
]);

function matchCheckSelectorLocal(
  name: unknown,
  selector: unknown,
  matchMode?: 'exact' | 'glob',
): boolean {
  const n = String(name ?? '').trim();
  const s = String(selector ?? '').trim();
  if (!n || !s) return false;
  // An explicit matchMode wins; otherwise infer glob from a `*` in the
  // selector (the legacy behavior every existing two-argument caller relies
  // on, e.g. waiver-selector vs check-name coverage matching).
  const useGlob =
    matchMode === undefined ? s.includes('*') : matchMode === 'glob';
  if (useGlob) {
    const source = s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${source}$`).test(n);
  }
  return n === s;
}

/**
 * True when a concrete check `name` matches any configured waivable selector,
 * honoring each selector's own `matchMode`. Used to gate whether a present
 * check sits on the policy's waivable surface.
 */
function isCheckNameConfiguredWaivable(
  name: unknown,
  waivableSelectors: { selector?: unknown; matchMode?: unknown }[],
): boolean {
  return waivableSelectors.some((sel) =>
    matchCheckSelectorLocal(
      name,
      sel?.selector,
      sel?.matchMode === 'glob' ? 'glob' : 'exact',
    ),
  );
}

/**
 * True when a waiver's `checkSelector` can name a check that the policy
 * declared waivable. Unlike a concrete check name, a waiver selector may
 * itself be a glob, so this tests both directions: the waiver selector
 * against each configured pattern, and each configured selector against the
 * waiver pattern (glob inferred from `*`). Either direction means the two
 * selectors can resolve to a common check — e.g. a glob waiver `Code*`
 * overlaps an exact waivable `CodeRabbit`. This mirrors the creation-path
 * gate in `planExternalCheckWaiver`, which validates glob waivers against the
 * actual matched checks, so a legitimately created waiver is not wrongly
 * bucketed as `notConfigured` at consumption.
 */
function waiverSelectorOverlapsConfiguredWaivable(
  waiverSelector: unknown,
  waivableSelectors: { selector?: unknown; matchMode?: unknown }[],
): boolean {
  return waivableSelectors.some(
    (sel) =>
      matchCheckSelectorLocal(
        waiverSelector,
        sel?.selector,
        sel?.matchMode === 'glob' ? 'glob' : 'exact',
      ) || matchCheckSelectorLocal(sel?.selector, waiverSelector),
  );
}

/**
 * #3246: `true` when `value` is a parseable ISO-8601 timestamp GitHub
 * DateTime fields use. Mirrors `authoring-owner-provenance.mts`'s own
 * `isParseableTimestamp` (the issue #3173 precedent this feature copies)
 * rather than the stricter round-trip check `isValidIsoTimestamp`
 * (marker-helpers.mts) uses for hand-authored marker fields -- a
 * GraphQL-emitted timestamp is trusted server output, not
 * operator-typed input.
 */
function isParseableGraphqlTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * #3246: classify one comment's edit state from its GraphQL
 * `lastEditedAt` (or a snake_case `last_edited_at`, whichever key the
 * caller's shape carries -- {@link CommentLike} declares both). Reads
 * nothing else off the comment: never `updatedAt`/`updated_at`, since
 * GitHub's `minimizeComment` mutation (IDD's own hide-on-supersede
 * sweeps call it) advances `updatedAt` while leaving `lastEditedAt`
 * `null` (kurone-kito/idd-skill#3173).
 *
 * - `'unedited'`: `lastEditedAt` is an explicit JSON `null` -- GitHub
 *   reports the comment was never body-edited.
 * - `'edited'`: `lastEditedAt` is a parseable timestamp -- the comment
 *   was body-edited after posting.
 * - `'unknown'`: `lastEditedAt` is absent, empty, or unparseable -- the
 *   caller never resolved edit state for this comment (or the read came
 *   back incomplete). Never coerced to `'unedited'`: an unresolved edit
 *   state must fail closed the same way a genuine edit does.
 */
export function classifyCommentEditState(
  comment: CommentLike | null | undefined,
): 'unedited' | 'edited' | 'unknown' {
  if (comment == null) {
    return 'unknown';
  }
  const raw =
    comment.lastEditedAt !== undefined
      ? comment.lastEditedAt
      : comment.last_edited_at;
  if (raw === null) {
    return 'unedited';
  }
  if (isParseableGraphqlTimestamp(raw)) {
    return 'edited';
  }
  return 'unknown';
}

/**
 * #3246: `true` only when `comment`'s author passes the caller's own
 * trust check AND its edit state is `'unedited'`. The shared per-comment
 * trust predicate every trust-bearing-marker consumer (this file's own
 * waiver classification below, and the sibling claim-marker and
 * review/merge-evidence/disposition tracks) can build on so neither
 * sibling has to re-derive edit-state trust independently.
 */
export function isTrustEvidenceComment(
  comment: CommentLike | null | undefined,
  isTrustedAuthor: (login: string) => boolean,
): boolean {
  if (comment == null) {
    return false;
  }
  // Normalized the same way summarizeExternalCheckWaivers' own inline
  // authorLogin computation is (#3246 C1 review): a caller-supplied
  // isTrustedAuthor typically checks a lowercased trusted-login set, so
  // an unnormalized mixed-case GitHub login would silently read as
  // untrusted. #3246 (Copilot review, PR #3403, round 3): also falls back
  // to the flat `authorLogin` field -- the shape `ProviderComment` and its
  // review-thread comment siblings actually carry -- so a genuine
  // provider-port comment object never computes an empty login here.
  const authorLogin = String(
    comment.author?.login ?? comment.user?.login ?? comment.authorLogin ?? '',
  )
    .trim()
    .toLowerCase();
  return (
    isTrustedAuthor(authorLogin) &&
    classifyCommentEditState(comment) === 'unedited'
  );
}

/**
 * kurone-kito/idd-skill#3328: whether active claim state is known for a
 * closing issue -- `'present'` (a resolvable active claim exists),
 * `'none'` (the issue's comments read cleanly and resolve to no active
 * claim), or `'unknown'` (the read failed or was never attempted for at
 * least one closing issue). An active claim always wins over a marker
 * (see {@link classifyPrLoopMembership}), so `'unknown'` must fail the
 * same way `'present'` does -- never optimistically treated as `'none'`.
 */
export type PrClosingIssueClaimState = 'present' | 'none' | 'unknown';

/** PR loop-membership verdict returned by {@link classifyPrLoopMembership}. */
export type PrLoopMembership =
  | 'in-loop'
  | 'out-of-loop-claimless'
  | 'out-of-loop-authorized';

/** {@link classifyPrLoopMembership}'s result: the verdict plus a
 * human-readable reason, suitable to surface verbatim in a `--claimless`
 * refusal message or a merge-gate blocker. */
export interface PrLoopMembershipResult {
  membership: PrLoopMembership;
  reason: string;
}

/**
 * kurone-kito/idd-skill#3328: the single shared definition of "does this PR
 * run outside the IDD claim loop" -- replaces the pre-existing divergent
 * `pre-merge-readiness.mts` (`--claimless` #2017) and
 * `resolve-review-thread.mts` (`isClaimlessEligible` #2616) definitions,
 * both of which now delegate here. Pure and network-free: every input is
 * already-fetched data, so a caller collects the closing-issue claim state
 * and PR comments once and reuses this function for every downstream
 * decision.
 *
 * Evaluated top-to-bottom, first match wins (mirrors the Groom-hearing
 * ruling recorded on the issue):
 *
 * 1. `closingIssueNumbers === null` (closing references unreadable) ->
 *    `'in-loop'`, fail closed -- mirrors the
 *    [fail-closed default](../../.github/instructions/idd-overview-core.instructions.md#fail-closed-default).
 * 2. `closingIssueNumbers` is empty -> `'out-of-loop-claimless'` (#2017,
 *    unchanged: a PR with nothing to claim against was never IDD-claimed).
 * 3. `closingIssueClaimState` is `'present'` or `'unknown'` -> `'in-loop'`
 *    -- an active (or unresolvable) claim always wins over a marker; a
 *    marker only ever matters once every closing issue is confirmed to
 *    have no active claim.
 * 4. `prComments` contains a comment that parses via
 *    {@link parseOutOfLoopMarker}, whose `prNumber` equals `prNumber`, and
 *    that passes {@link isTrustEvidenceComment} (trusted author AND
 *    unedited) -> `'out-of-loop-authorized'`. Trust is decided by the
 *    comment's GitHub author login (via `isTrustedAuthor`), never the
 *    marker's own embedded `{agent-id}` text.
 * 5. Otherwise -> `'in-loop'` (no active claim and no valid marker: still
 *    ordinary claimed-loop territory, just presently unclaimed).
 */
export function classifyPrLoopMembership({
  prNumber,
  closingIssueNumbers,
  closingIssueClaimState,
  prComments,
  trustedMarkerLogins,
}: {
  prNumber: number;
  closingIssueNumbers: number[] | null;
  closingIssueClaimState: PrClosingIssueClaimState;
  prComments: CommentLike[] | null | undefined;
  trustedMarkerLogins: unknown[] | null | undefined;
}): PrLoopMembershipResult {
  if (closingIssueNumbers === null) {
    return {
      membership: 'in-loop',
      reason: 'closing issue references are unreadable (fail closed)',
    };
  }
  if (closingIssueNumbers.length === 0) {
    return {
      membership: 'out-of-loop-claimless',
      reason: 'no closing issue references (#2017)',
    };
  }
  if (
    closingIssueClaimState === 'present' ||
    closingIssueClaimState === 'unknown'
  ) {
    return {
      membership: 'in-loop',
      reason: `a closing issue's active claim state is ${closingIssueClaimState}`,
    };
  }
  const normalizedTrustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  const isTrustedAuthor = (login: string): boolean =>
    normalizedTrustedLogins.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  for (const comment of prComments ?? []) {
    const marker = parseOutOfLoopMarker(
      String(comment?.body ?? ''),
      String(comment?.createdAt ?? comment?.created_at ?? ''),
    );
    if (
      marker &&
      marker.prNumber === prNumber &&
      isTrustEvidenceComment(comment, isTrustedAuthor)
    ) {
      return {
        membership: 'out-of-loop-authorized',
        reason: `valid out-of-loop marker (reason:${marker.reason}) from ${marker.agentId}`,
      };
    }
  }
  return {
    membership: 'in-loop',
    reason:
      'no closing issue has an active claim, and no valid out-of-loop marker was found',
  };
}

/**
 * kurone-kito/idd-skill#3328: same-repo positive-integer issue numbers
 * extracted from a raw `closingIssuesReferences` passthrough, applying the
 * identical repository-matching rules `computeClosingSetEvidence`
 * (`supersession-detection.mts`) uses internally for its own
 * `sameRepoNumbers` set. Shared by both `--claimless` consumers
 * (`pre-merge-readiness.mts`'s `classifyPrLoopMembership` input and its
 * `expectedClosingIssues` closing-set fix, `resolve-review-thread.mts`'s
 * `isClaimlessEligible`) so neither re-derives its own copy. Deliberately
 * best-effort rather than fail-closed the way `computeClosingSetEvidence`
 * itself is: a malformed or unusable entry is simply skipped here, never
 * aborting the whole extraction, because `computeClosingSetEvidence`'s OWN
 * malformed-entry checks already fail the real merge gate closed to
 * `'unavailable'` regardless of what this function returns for that same
 * input -- this extraction only ever feeds a *candidate* expected/input
 * set, never a gate's own pass/fail decision.
 */
export function extractSameRepoClosingIssueNumbers(
  closingIssuesReferences: unknown,
  owner: string,
  repo: string,
): number[] {
  if (!Array.isArray(closingIssuesReferences)) {
    return [];
  }
  const ownerLower = owner.toLowerCase();
  const repoLower = repo.toLowerCase();
  const numbers: number[] = [];
  for (const entry of closingIssuesReferences) {
    const record =
      entry !== null && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : null;
    const rawNumber = record && 'number' in record ? record.number : entry;
    const number = typeof rawNumber === 'number' ? rawNumber : Number.NaN;
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const repository = record?.repository;
    if (repository !== null && repository !== undefined) {
      if (typeof repository !== 'object') {
        continue;
      }
      const repoRecord = repository as {
        name?: unknown;
        owner?: { login?: unknown } | null;
      };
      const entryOwner = String(repoRecord.owner?.login ?? '').toLowerCase();
      const entryRepo = String(repoRecord.name ?? '').toLowerCase();
      if (entryOwner !== ownerLower || entryRepo !== repoLower) {
        continue;
      }
    }
    numbers.push(number);
  }
  return numbers;
}

/**
 * kurone-kito/idd-skill#3328 (C1 critique pass, live-reproduced against
 * both `--claimless` consumers, then further tightened per Copilot review
 * on PR #3421): derive `classifyPrLoopMembership`'s own
 * `closingIssueNumbers` input from a raw `closingIssuesReferences`
 * passthrough, distinguishing three cases that must NOT collapse into
 * each other:
 *
 * 1. **Genuinely no closing references** (a real, empty array) ->
 *    `[]`, the unchanged `#2017` claimless case.
 * 2. **The field itself is unreadable** (not an array at all -- a
 *    malformed provider response, or a value this function was never
 *    meant to see) -> `null`.
 * 3. **Every entry resolves to a same-repo issue number** -> those
 *    numbers.
 *
 * Any entry that does NOT resolve to a same-repo number -- cross-repo,
 * or otherwise unparseable by
 * {@link extractSameRepoClosingIssueNumbers} -- makes the WHOLE result
 * `null`, even when other entries in the same array did resolve. Before
 * #3328, both consumers refused `--claimless` outright whenever the raw
 * `closingIssuesReferences` was non-empty, regardless of repo; a
 * same-repo-only filter that silently drops an unresolved entry and
 * returns the resolved subset would let the classifier -- and each
 * consumer's own claim-state check -- run against an INCOMPLETE closing
 * set, never checking the dropped entry's own claim state at all.
 * `resolve-review-thread.mts` has no later closing-set gate to catch
 * that gap the way `pre-merge-readiness.mts`'s own gate does, so this
 * function fails the WHOLE result closed instead of accepting a partial
 * one. `null` reproduces the pre-#3328 refusal either way: the
 * classifier's own `null` row fails closed to `'in-loop'`.
 */
export function resolveClosingIssueNumbersForClassifier(
  closingIssuesReferences: unknown,
  owner: string,
  repo: string,
): number[] | null {
  if (!Array.isArray(closingIssuesReferences)) {
    return null;
  }
  if (closingIssuesReferences.length === 0) {
    return [];
  }
  const sameRepoNumbers = extractSameRepoClosingIssueNumbers(
    closingIssuesReferences,
    owner,
    repo,
  );
  return sameRepoNumbers.length === closingIssuesReferences.length
    ? sameRepoNumbers
    : null;
}

export function summarizeExternalCheckWaivers(
  comments: CommentLike[] | null | undefined,
  {
    prHeadSha = '',
    activeClaimId = '',
    activeClaimSupersedes = '',
    trustedMarkerLogins = [],
    now = '',
    waivableSelectors = null,
    maxValidity = '',
    mode = '',
    allowSelfReferentialBootstrapAuto = false,
    authorityPolicy = '',
    resolveAuthority = null,
    loopMembership = undefined,
  }: {
    prHeadSha?: string;
    activeClaimId?: unknown;
    /** Immediate predecessor claim id (`ParsedClaimMarker.supersedes`).
     * Used only for the one-hop takeover exception below; `none`/empty
     * never bind. */
    activeClaimSupersedes?: unknown;
    trustedMarkerLogins?: unknown[];
    now?: string;
    waivableSelectors?: { selector?: unknown; matchMode?: unknown }[] | null;
    // Configured `ciGate.externalCheckWaivers.maxValidity` (ISO-8601 duration).
    // An empty/unparseable value leaves the consume-side window check off, so
    // direct callers that omit it keep the legacy behavior; the F2/F3 gate
    // always threads the policy value (default `PT24H`).
    maxValidity?: string;
    // Configured `ciGate.externalCheckWaivers.mode` (#2046). An empty value
    // (direct callers that omit it) leaves the mode gate off, matching the
    // pre-#2046 legacy behavior; the F2/F3 gate always threads the policy
    // value so an otherwise-valid waiver never counts while the schema
    // default (`disabled`) is in effect, mirroring
    // `advisory-convergence.mts`'s own `waiverMode === 'maintainer-authorized'`
    // guard.
    mode?: string;
    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): a
    // `self-referential-bootstrap-auto`-reasoned marker's `reason`/`runId`
    // are attacker-shaped input from a `github-actions[bot]`-authored
    // comment body -- trusting one as an ORDINARY valid waiver here (which
    // happens whenever an adopter's own `trustedMarkerLogins` includes
    // that login, a plausible choice unrelated to this feature) would
    // let it satisfy the deadline/terminal-gated waiver escape hatch, or
    // an F2/F3 pre-merge-readiness consumer's own generic waiver check,
    // WITHOUT ever running the run-id/event-type/HEAD/repository/
    // changed-file verification `advisory-convergence.mts`'s dedicated,
    // isolated auto-waiver evidence call performs. Default `false` (fail
    // closed): such a marker is excluded from every bucket entirely,
    // never merely `unauthorized`/`wrongHead`/etc., since the reason
    // itself disqualifies it regardless of any other field.
    //
    // Exactly three call sites may set this `true` -- every other caller
    // (this function's own ordinary-waiver callers, including
    // `buildPreMergeReadinessSummary`'s own PRIMARY `waiverEvidence` call
    // below) must leave it unset:
    // 1. `advisory-convergence.mts`'s dedicated, isolated auto-waiver
    //    evidence call, whose `valid` classification directly feeds
    //    `autoWaiverValid` -- a GATE decision -- so it is paired with the
    //    run-id/event-type/HEAD/repository/changed-file verification
    //    above before anything is trusted.
    // 2. `external-check-waiver.mts`'s `runExternalCheckWaiver` POST-WRITE
    //    reconcile (Copilot review, PR #2895): its own `evidence.valid` is
    //    consulted only by `collectValidWaiverComments` to print a
    //    concurrent-duplicate WARNING and pick which comment id to keep --
    //    never to authorize, satisfy, or apply anything -- so there is no
    //    gate to smuggle past. Its PRE-WRITE reuse-scan sibling call site
    //    does NOT set this: reuse-scanning is disabled entirely for
    //    `--auto-bootstrap` (that call site's own doc comment explains
    //    why a `reason`-only filter is not a sufficient trust check for a
    //    decision that skips posting), so leaving it unset there costs
    //    nothing and keeps the exception as narrow as the decision it
    //    actually affects requires.
    // 3. `buildPreMergeReadinessSummary`'s (this file's) own DEDICATED
    //    `autoWaiverEvidence` call (kurone-kito/idd-skill#2911, replacing
    //    the reverted kurone-kito/idd-skill#2657-era attempt at
    //    commit 9ecc9954, which this issue's own findings list retired
    //    across three further review rounds): read-only, feeding only a
    //    stale-self-waiver merge BLOCKER -- it can add a blocker
    //    `computePreMergeReadinessBlockers` would not otherwise report,
    //    never satisfy one or make `ready` true, the opposite direction
    //    from the gate-bypass risk this option otherwise guards against.
    //    Trusts a marker as blocker evidence only after the SAME
    //    run-id/event-type/HEAD/repository verification site 1 performs
    //    (`verifySelfReferentialBootstrapWaiverRun`, reused verbatim from
    //    `advisory-convergence.mts`) AND an independently-fetched
    //    `touchesSelfReferentialAllowlist` precondition -- both computed
    //    by the collector (`pre-merge-readiness.mts`) and threaded in as
    //    `options.autoWaiverRunVerified`/`options.touchesSelfReferential-
    //    Allowlist`, since a bearer-evidence-only citation of a real,
    //    unrelated run (kurone-kito/idd-skill#2912's own residual gap)
    //    would otherwise let a forged marker block an unrelated PR's
    //    merge (the decisive Copilot finding that retired the original
    //    attempt).
    allowSelfReferentialBootstrapAuto?: boolean;
    // kurone-kito/idd-skill#3250: `ciGate.externalCheckWaivers.authorityPolicy`
    // ('owners-and-maintainers-only' | 'all-write-permission-actors'). Unlike
    // `mode`/`maxValidity`/`waivableSelectors` above, an empty value does
    // NOT leave this check off -- it resolves to the schema default
    // (`owners-and-maintainers-only`), matching `normalizePolicyConfig`'s
    // own default for every real caller. Authority is not a policy opt-in;
    // it is the trust predicate on the waiver's author, so this check
    // always runs once a marker survives every check above it.
    authorityPolicy?: string;
    // kurone-kito/idd-skill#3250: resolves one waiver author's live
    // collaborator-permission outcome for the authority check. No default:
    // a caller that omits this gets `insufficientAuthority` for every
    // waiver that reaches the check (see the check's own comment below) --
    // the fail-closed contract this option exists to enforce.
    resolveAuthority?:
      | ((authorLogin: string) => ExternalCheckWaiverAuthorityLookup | null)
      | null;
    // kurone-kito/idd-skill#3330: a `none` claim id is a real binding only
    // for an out-of-loop PR. Omitted, or any other value, is `in-loop`
    // (fail closed). The synthetic claimless id `none` counts as no real
    // active claim, same as an empty id.
    loopMembership?: PrLoopMembership;
  } = {},
): ExternalCheckWaiverEvidence {
  const trustedSet = new Set(normalizeTrustedMarkerLogins(trustedMarkerLogins));
  const nowMs = isValidIsoTimestamp(now) ? new Date(now).getTime() : Date.now();
  const headShaLower = String(prHeadSha).toLowerCase();
  const activeClaimLower = String(activeClaimId);
  const maxValidityMs = parseIsoDurationToMs(maxValidity);
  const effectiveAuthorityPolicy =
    authorityPolicy === 'all-write-permission-actors'
      ? authorityPolicy
      : 'owners-and-maintainers-only';

  const valid: ExternalCheckWaiverEvidence['valid'] = [];
  const expired: ExternalCheckWaiverEvidence['expired'] = [];
  const wrongHead: ExternalCheckWaiverEvidence['wrongHead'] = [];
  const wrongClaim: ExternalCheckWaiverEvidence['wrongClaim'] = [];
  const unauthorized: ExternalCheckWaiverEvidence['unauthorized'] = [];
  const insufficientAuthority: ExternalCheckWaiverEvidence['insufficientAuthority'] =
    [];
  const malformed: ExternalCheckWaiverEvidence['malformed'] = [];
  const notConfigured: ExternalCheckWaiverEvidence['notConfigured'] = [];
  const modeDisabled: ExternalCheckWaiverEvidence['modeDisabled'] = [];
  const edited: ExternalCheckWaiverEvidence['edited'] = [];
  // An empty `mode` leaves this gate off (legacy/unit-caller default); a
  // non-empty value must equal `maintainer-authorized` exactly, mirroring
  // `advisory-convergence.mts`'s own guard.
  const modeGateOpen = mode === '' || mode === 'maintainer-authorized';

  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? '');
    // Prefilter on a marker-start, case-insensitive match aligned with
    // parseExternalCheckWaiverComment's anchor — a case-sensitive substring
    // skipped odd-cased markers and misclassified prose mentions as malformed.
    if (!/^<!--\s*idd-external-check-waiver:/i.test(body)) continue;

    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const createdAt = String(comment?.created_at ?? comment?.createdAt ?? '');
    const parsed = parseExternalCheckWaiverComment(body, createdAt);

    if (!parsed) {
      malformed.push({ authorLogin, bodyPreview: body.slice(0, 120) });
      continue;
    }

    // kurone-kito/idd-skill#2657 (Codex review, PR #2895): excluded
    // entirely, before any other classification, for every caller except
    // the one dedicated auto-waiver evidence call that opts in -- see
    // `allowSelfReferentialBootstrapAuto`'s own doc comment above for why
    // author/head/claim/expiry classification must never even run for
    // this reason token otherwise.
    if (
      !allowSelfReferentialBootstrapAuto &&
      parsed.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON
    ) {
      continue;
    }
    // kurone-kito/idd-skill#3250: the consume-time authority check below is
    // exempt for this same reason token (only reachable here when
    // `allowSelfReferentialBootstrapAuto` is true) -- that marker's trust
    // comes from the run-id/event-type/HEAD/repository verification the
    // dedicated auto-waiver evidence caller performs separately, not from a
    // human collaborator's role, so there is no authority to check.
    const isSelfReferentialBootstrapAuto =
      parsed.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON;

    // kurone-kito/idd-skill#3246: a body-edited (or edit-state-unresolved)
    // marker is never trust evidence, regardless of author, HEAD, claim,
    // or expiry -- GitHub lets any Write-role collaborator or App rewrite
    // an existing comment's body in place while keeping its `id`, author,
    // and `created_at`, so those alone are not proof the body is still
    // the one that was posted. Checked before every other classification
    // (only the #2657 reason-token exclusion above runs first) so an
    // edited marker can never land in `valid` via any other path either.
    const editState = classifyCommentEditState(comment);
    if (editState !== 'unedited') {
      edited.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        editState,
      });
      continue;
    }

    if (!trustedSet.has(authorLogin)) {
      unauthorized.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    // Fail closed on an empty head SHA: an unbound waiver must never ride
    // along when the gate cannot prove it targets the current PR HEAD.
    if (!headShaLower || parsed.headSha !== headShaLower) {
      wrongHead.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverHeadSha: parsed.headSha,
      });
      continue;
    }

    // Fail closed on an empty active claim: when no real claim resolves at
    // the gate, a waiver cannot be bound to an owner and is rejected rather
    // than passing unbound. #1905's sentinel `none` is that claimless
    // binding, and kurone-kito/idd-skill#3330 restricts it further: the
    // synthetic id `none` (including `buildPreMergeReadinessSummary`'s
    // claimless branch) is not a real claim, and a `none` waiver binds only
    // when `loopMembership` is out of loop. An omitted verdict is in-loop,
    // so a released-claim window cannot keep a `none` waiver. A real claim
    // id still requires an exact match; `none` is never accepted there.
    // Every other combination is unchanged: a non-`none` claimId on an
    // unclaimed PR still falls into `wrongClaim` -- the exact regression
    // #1077 fixed.
    //
    // #2080: one-hop takeover exception. A waiver bound to claim A remains
    // valid after an in-policy takeover installs claim B whose
    // `supersedes` field is A -- the waiver authorizes the PR, not the
    // current session. The predecessor value is accepted only when it is
    // non-empty and is NOT a case-insensitive `none` sentinel: a freshly
    // claimed PR carries `supersedes: 'none'`, and treating that as a
    // bindable predecessor would make every claimless waiver validate on
    // every fresh claim (reopening #1077/#1905). A two-hop-old claim id
    // (neither B nor B.supersedes) stays rejected; walking a full lineage
    // is out of scope.
    const claimIdIsNoneSentinel = parsed.claimId.toLowerCase() === 'none';
    const predecessorClaimId = String(activeClaimSupersedes ?? '').trim();
    const predecessorIsBindable =
      predecessorClaimId !== '' && predecessorClaimId.toLowerCase() !== 'none';
    // kurone-kito/idd-skill#3330: the claimless synthetic id `none` is not
    // a real claim. A `none` waiver binds only when no real claim is
    // passed and the PR is out of loop. An omitted verdict is in-loop.
    const activeClaimToken = String(activeClaimLower ?? '').trim();
    const activeClaimIsReal =
      activeClaimToken !== '' && activeClaimToken.toLowerCase() !== 'none';
    const noneBindingAllowed =
      loopMembership === 'out-of-loop-claimless' ||
      loopMembership === 'out-of-loop-authorized';
    const claimBindingSatisfied = activeClaimIsReal
      ? parsed.claimId === activeClaimLower ||
        (predecessorIsBindable && parsed.claimId === predecessorClaimId)
      : claimIdIsNoneSentinel && noneBindingAllowed;
    if (!claimBindingSatisfied) {
      wrongClaim.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        waiverClaimId: parsed.claimId,
        reason: parsed.reason,
        runId: parsed.runId,
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    const expiresMs = new Date(parsed.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      expired.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
        reason: parsed.reason,
        runId: parsed.runId,
        createdAt: parsed.createdAt,
      });
      continue;
    }

    // Re-enforce the configured maxValidity window at consume time. Authoring
    // already clamps `expiresAt - createdAt` (planExternalCheckWaiver's
    // withinMaxValidity), but a hand-edited or policy-drifted marker can still
    // carry an over-long window, so the shared merge gate re-checks it and
    // fails closed when the creation timestamp is unknown (`createdAt: 'none'`).
    if (typeof maxValidityMs === 'number' && Number.isFinite(maxValidityMs)) {
      const createdMs = new Date(parsed.createdAt).getTime();
      if (
        !Number.isFinite(createdMs) ||
        expiresMs - createdMs > maxValidityMs
      ) {
        expired.push({
          authorLogin,
          checkSelector: parsed.checkSelector,
          expiresAt: parsed.expiresAt,
          reason: parsed.reason,
          runId: parsed.runId,
          createdAt: parsed.createdAt,
        });
        continue;
      }
    }

    // When the policy declares its waivable surface, a valid waiver still only
    // counts when its selector can name a configured-waivable check; otherwise
    // it is reported but never folds a check in. The overlap test treats the
    // waiver selector as a possible glob so a `Code*` waiver still matches an
    // exact `CodeRabbit` surface. A null/undefined list disables the gate
    // (legacy callers), an empty list waives nothing.
    if (
      Array.isArray(waivableSelectors) &&
      !waiverSelectorOverlapsConfiguredWaivable(
        parsed.checkSelector,
        waivableSelectors,
      )
    ) {
      notConfigured.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    // #2046: `mode` gates the whole waiver mechanism, independent of the
    // `waivable` selector list -- an otherwise-valid, correctly-configured
    // waiver must never count while the policy's
    // `ciGate.externalCheckWaivers.mode` is not `maintainer-authorized`
    // (schema default: `disabled`), matching `advisory-convergence.mts`'s
    // own required check, which never even evaluates waiver evidence
    // outside that mode.
    if (!modeGateOpen) {
      modeDisabled.push({
        authorLogin,
        checkSelector: parsed.checkSelector,
        expiresAt: parsed.expiresAt,
      });
      continue;
    }

    // kurone-kito/idd-skill#3250: consume-time authority check. Every
    // check above proves the author is on the TRUSTED-SET list
    // (`unauthorized`) and that the marker itself is otherwise fully
    // valid; it says nothing about whether that author's actual GitHub
    // collaborator role satisfies the configured
    // `ciGate.externalCheckWaivers.authorityPolicy` -- under the default
    // `owners-and-maintainers-only`, a Write-only collaborator admitted to
    // the trusted set only via collaborator-marker trust must still not
    // author a binding waiver. Placed last (after the cheaper
    // selector/mode checks) so a marker rejected on those grounds never
    // triggers a live permission lookup. Skipped for the #2657
    // self-referential-bootstrap-auto marker (see
    // `isSelfReferentialBootstrapAuto` above).
    if (!isSelfReferentialBootstrapAuto) {
      const lookup = resolveAuthority ? resolveAuthority(authorLogin) : null;
      const roleName =
        lookup?.outcome === 'found'
          ? String(lookup.roleName ?? '')
              .trim()
              .toLowerCase()
          : '';
      const permission =
        lookup?.outcome === 'found'
          ? String(lookup.permission ?? '')
              .trim()
              .toLowerCase()
          : '';
      // Same rules `isAuthorizedForcedHandoffActor`
      // (`collaborator-permission.mts`) applies -- duplicated here (rather
      // than imported) so this pure façade file never pulls in that
      // module's live GitHub adapter dependency.
      const authorized =
        lookup?.outcome === 'found' &&
        (effectiveAuthorityPolicy === 'all-write-permission-actors'
          ? roleName === 'admin' ||
            roleName === 'maintain' ||
            roleName === 'write' ||
            permission === 'admin' ||
            permission === 'write'
          : roleName === 'admin' ||
            roleName === 'maintain' ||
            permission === 'admin');
      if (!authorized) {
        insufficientAuthority.push({
          authorLogin,
          checkSelector: parsed.checkSelector,
          authority:
            lookup?.outcome === 'found'
              ? roleName || permission || 'unknown'
              : lookup?.outcome === 'not-collaborator'
                ? 'none'
                : 'unknown',
        });
        continue;
      }
    }

    valid.push({
      authorLogin,
      checkSelector: parsed.checkSelector,
      reason: parsed.reason,
      expiresAt: parsed.expiresAt,
      createdAt: parsed.createdAt,
      runId: parsed.runId,
    });
  }

  return {
    valid,
    expired,
    wrongHead,
    wrongClaim,
    unauthorized,
    insufficientAuthority,
    malformed,
    notConfigured,
    modeDisabled,
    edited,
  };
}

export function findLiveStatusDigestComments(
  comments: CommentLike[],
  options: { isTrustedAuthor?: (login: string) => boolean } = {},
): CommentLike[] {
  const matches = comments.filter((comment) => {
    return firstLine(comment.body ?? '') === LIVE_STATUS_DIGEST_MARKER;
  });
  // Issue #3337: the ordinary create/update/duplicate-detection callers pass
  // `isTrustedAuthor` so a digest-marker comment from an untrusted actor is
  // neither selected for update nor counted toward the duplicate check --
  // the helper then creates or updates its own digest alongside it instead
  // of rewriting a stranger's comment. The maintainer repair path
  // (`planLiveStatusDigestRepair`, `createLiveStatusDigestSnapshot`, and
  // `runDuplicateDigestRepair`'s own call sites) never passes this option,
  // so it keeps seeing every author -- a maintainer can still retire a
  // stranger's current-marker comment.
  if (!options.isTrustedAuthor) {
    return matches;
  }
  const { isTrustedAuthor } = options;
  return matches.filter((comment) =>
    isTrustedAuthor(String(comment.author?.login ?? comment.user?.login ?? '')),
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSnapshotTargetState(targetState: unknown): string {
  const normalized = String(targetState ?? '').trim();
  return normalized || 'unknown';
}

function normalizeSnapshotEntries(
  entries: LiveStatusDigestSnapshotEntry[],
): LiveStatusDigestSnapshotEntry[] {
  const normalized = entries.map((entry) => {
    const id = String(entry.id ?? '').trim();
    const bodySha256 = String(entry.bodySha256 ?? '')
      .trim()
      .toLowerCase();
    if (!/^[1-9]\d*$/.test(id)) {
      throw new Error(
        `live-status digest comment id is invalid: ${id || '(empty)'}`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(bodySha256)) {
      throw new Error(
        `live-status digest body sha256 is invalid for comment ${id}`,
      );
    }
    return { id, bodySha256 };
  });

  const seen = new Set<string>();
  for (const entry of normalized) {
    if (seen.has(entry.id)) {
      throw new Error(`duplicate live-status digest comment id: ${entry.id}`);
    }
    seen.add(entry.id);
  }

  normalized.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return normalized;
}

export function normalizeLiveStatusDigestIds(
  ids: readonly unknown[],
): string[] {
  const normalized = ids.map((id) => String(id ?? '').trim());
  if (normalized.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error('live-status digest ids must be positive integer strings');
  }
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new Error('live-status digest ids must be unique');
  }
  return [...unique].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function createLiveStatusDigestSnapshotFromEntries(
  targetState: unknown,
  entries: LiveStatusDigestSnapshotEntry[],
): LiveStatusDigestSnapshot {
  const normalizedTargetState = normalizeSnapshotTargetState(targetState);
  const normalizedEntries = normalizeSnapshotEntries(entries);
  const canonical = JSON.stringify({
    version: 1,
    targetState: normalizedTargetState,
    entries: normalizedEntries,
  });
  return {
    targetState: normalizedTargetState,
    entries: normalizedEntries,
    sha256: sha256Hex(canonical),
  };
}

export function createLiveStatusDigestSnapshot(
  comments: CommentLike[],
  targetState: unknown = 'unknown',
): LiveStatusDigestSnapshot {
  const entries = findLiveStatusDigestComments(comments).map((comment) => {
    const rawId = String(comment.id ?? '').trim();
    if (!/^[1-9]\d*$/.test(rawId)) {
      throw new Error(
        `current live-status digest comment has no stable numeric id: ${rawId || '(empty)'}`,
      );
    }
    return {
      id: rawId,
      bodySha256: sha256Hex(String(comment.body ?? '')),
    };
  });
  return createLiveStatusDigestSnapshotFromEntries(targetState, entries);
}

export function compareLiveStatusDigestSnapshot(
  comments: CommentLike[],
  targetState: unknown,
  expectedIds: readonly unknown[],
  expectedSha256: unknown,
): LiveStatusDigestSnapshotComparison {
  const snapshot = createLiveStatusDigestSnapshot(comments, targetState);
  let normalizedExpectedIds: string[];
  const normalizedExpectedSha256 = String(expectedSha256 ?? '')
    .trim()
    .toLowerCase();
  try {
    normalizedExpectedIds = normalizeLiveStatusDigestIds(expectedIds);
  } catch {
    return {
      matches: false,
      reason: 'invalid-expected-snapshot',
      snapshot,
    };
  }
  if (!/^[a-f0-9]{64}$/.test(normalizedExpectedSha256)) {
    return {
      matches: false,
      reason: 'invalid-expected-snapshot',
      snapshot,
    };
  }
  const currentIds = snapshot.entries.map((entry) => entry.id);
  if (
    currentIds.length !== normalizedExpectedIds.length ||
    currentIds.some((id, index) => id !== normalizedExpectedIds[index])
  ) {
    return { matches: false, reason: 'digest-set-drift', snapshot };
  }
  if (snapshot.sha256 !== normalizedExpectedSha256) {
    return { matches: false, reason: 'snapshot-drift', snapshot };
  }
  return { matches: true, reason: 'snapshot-matches', snapshot };
}

export function retireLiveStatusDigestBody(body: string): string {
  const original = String(body ?? '');
  const bomOffset = original.startsWith('\uFEFF') ? 1 : 0;
  if (firstLine(original) !== LIVE_STATUS_DIGEST_MARKER) {
    throw new Error(
      'cannot retire a comment that does not have the exact current live-status marker',
    );
  }
  return `${original.slice(0, bomOffset)}${LIVE_STATUS_DIGEST_HISTORICAL_MARKER}${original.slice(bomOffset + LIVE_STATUS_DIGEST_MARKER.length)}`;
}

export function isHistoricalLiveStatusDigestBody(body: unknown): boolean {
  return firstLine(body) === LIVE_STATUS_DIGEST_HISTORICAL_MARKER;
}

export function planLiveStatusDigestRepair(options: {
  comments: CommentLike[];
  targetState?: unknown;
  retainedCommentId: unknown;
  expectedCurrentDigestIds?: readonly unknown[];
  expectedCurrentDigestSha256?: unknown;
}): LiveStatusDigestRepairPlan {
  const snapshot = createLiveStatusDigestSnapshot(
    options.comments,
    options.targetState,
  );
  const retainedCommentId = String(options.retainedCommentId ?? '').trim();
  const basePlan = {
    snapshot,
    retainedCommentId,
    retirements: [] as LiveStatusDigestRepairRetirement[],
  };
  const current = findLiveStatusDigestComments(options.comments);
  if (current.length < 2) {
    return {
      action: 'invalid',
      canApply: false,
      reason: 'duplicate-set-too-small',
      ...basePlan,
    };
  }
  const expectedIdsProvided = options.expectedCurrentDigestIds !== undefined;
  const expectedShaProvided = options.expectedCurrentDigestSha256 !== undefined;
  if (expectedIdsProvided !== expectedShaProvided) {
    return {
      action: 'invalid',
      canApply: false,
      reason: 'expected-snapshot-incomplete',
      ...basePlan,
    };
  }
  if (expectedIdsProvided && expectedShaProvided) {
    const comparison = compareLiveStatusDigestSnapshot(
      options.comments,
      options.targetState,
      options.expectedCurrentDigestIds ?? [],
      options.expectedCurrentDigestSha256,
    );
    if (!comparison.matches) {
      return {
        action: 'drift',
        canApply: false,
        reason: comparison.reason,
        ...basePlan,
      };
    }
  }
  if (!/^[1-9]\d*$/.test(retainedCommentId)) {
    return {
      action: 'invalid',
      canApply: false,
      reason: 'retained-comment-id-invalid',
      ...basePlan,
    };
  }
  const retained = current.find(
    (comment) => String(comment.id ?? '').trim() === retainedCommentId,
  );
  if (!retained) {
    return {
      action: 'invalid',
      canApply: false,
      reason: 'retained-comment-is-not-current',
      ...basePlan,
    };
  }
  const retirements = current
    .filter((comment) => String(comment.id ?? '').trim() !== retainedCommentId)
    .map((comment) => {
      const id = String(comment.id ?? '').trim();
      const originalBody = String(comment.body ?? '');
      return {
        id,
        originalBody,
        originalBodySha256: sha256Hex(originalBody),
        retiredBody: retireLiveStatusDigestBody(originalBody),
      };
    });
  return {
    action: 'ready',
    canApply: true,
    reason: 'explicit-retained-digest-selected',
    snapshot,
    retainedCommentId,
    retirements,
  };
}

export function renderLiveStatusDigestRepairEvidence(
  fields: LiveStatusDigestRepairEvidenceFields,
): string {
  const renderEntries = (snapshot: LiveStatusDigestSnapshot | null): string =>
    snapshot?.entries.length
      ? snapshot.entries
          .map((entry) => `${entry.id}:${entry.bodySha256}`)
          .join(', ')
      : 'none';
  const retired = fields.retiredCommentIds.length
    ? fields.retiredCommentIds.join(', ')
    : 'none';
  const reason = fields.reason ?? 'none';
  const postflight = fields.postflight;
  return `${LIVE_STATUS_DIGEST_REPAIR_MARKER}

| Field | Value |
| --- | --- |
| Status | ${escapeMarkdownTableCell(fields.status)} |
| Target | ${escapeMarkdownTableCell(fields.target)} |
| Actor | ${escapeMarkdownTableCell(fields.actor)} |
| Retained digest comment | ${escapeMarkdownTableCell(fields.retainedCommentId)} |
| Retired digest comments | ${escapeMarkdownTableCell(retired)} |
| Pre-repair current digest comments | ${escapeMarkdownTableCell(fields.preflight.entries.map((entry) => entry.id).join(', ') || 'none')} |
| Post-repair current digest comments | ${escapeMarkdownTableCell(postflight?.entries.map((entry) => entry.id).join(', ') || 'none')} |
| Pre-repair digest entries | ${escapeMarkdownTableCell(renderEntries(fields.preflight))} |
| Post-repair digest entries | ${escapeMarkdownTableCell(renderEntries(postflight))} |
| Pre-repair target state | ${escapeMarkdownTableCell(fields.preflight.targetState)} |
| Post-repair target state | ${escapeMarkdownTableCell(postflight?.targetState ?? 'none')} |
| Pre-repair snapshot SHA-256 | ${escapeMarkdownTableCell(fields.preflight.sha256)} |
| Post-repair snapshot SHA-256 | ${escapeMarkdownTableCell(postflight?.sha256 ?? 'none')} |
| Recovery detail | ${escapeMarkdownTableCell(reason)} |
`;
}

export function renderLiveStatusDigest(fields: LiveStatusDigestFields): string {
  const normalized = normalizeLiveStatusDigestFields(fields);
  return `${LIVE_STATUS_DIGEST_MARKER}

| Field | Value |
| --- | --- |
| Phase | ${escapeMarkdownTableCell(normalized.phase)} |
| Claim | ${escapeMarkdownTableCell(normalized.claim)} |
| Branch | ${escapeMarkdownTableCell(normalized.branch)} |
| Last checked | ${escapeMarkdownTableCell(normalized.lastChecked)} |
| Open blockers | ${escapeMarkdownTableCell(normalized.openBlockers)} |
| Next action | ${escapeMarkdownTableCell(normalized.nextAction)} |
| Authoritative by | ${escapeMarkdownTableCell(normalized.authoritativeBy)} |
`;
}

export function planLiveStatusDigestUpsert(
  comments: CommentLike[],
  fields: LiveStatusDigestFields,
  options: { isTrustedAuthor?: (login: string) => boolean } = {},
) {
  const matches = findLiveStatusDigestComments(comments, options);
  const nextBody = renderLiveStatusDigest(fields);

  if (matches.length > 1) {
    return {
      action: 'duplicate',
      canApply: false,
      body: null,
      duplicates: matches.map((comment) => ({
        id: comment.id ?? null,
        url: comment.html_url ?? comment.url ?? null,
        createdAt: comment.created_at ?? comment.createdAt ?? null,
        updatedAt: comment.updated_at ?? comment.updatedAt ?? null,
      })),
      repairPath: [
        'Multiple current live status digest comments were found.',
        'Do not delete or minimize any audit history during unattended execution.',
        'Use trusted markers and GitHub state for workflow decisions until a maintainer selects one current digest and converts stale duplicate markers to non-current digest text.',
      ].join(' '),
    };
  }

  if (matches.length === 0) {
    return {
      action: 'create',
      canApply: true,
      body: nextBody,
      duplicates: [],
    };
  }

  const [current] = matches;
  if (sameDigestBody(current.body ?? '', nextBody)) {
    return {
      action: 'noop',
      canApply: true,
      body: nextBody,
      commentId: current.id ?? null,
      url: current.html_url ?? current.url ?? null,
      duplicates: [],
    };
  }

  return {
    action: 'update',
    canApply: true,
    body: nextBody,
    commentId: current.id ?? null,
    url: current.html_url ?? current.url ?? null,
    duplicates: [],
  };
}

/** Minimal upsert-plan shape consumed by {@link applyDigestUpsert}. */
export interface DigestUpsertPlanLike {
  action: string;
  body: string | null;
  commentId?: string | number | null;
  url?: string | null;
}

/** Result of a comment create/update GitHub mutation. */
export interface DigestCommentMutationResult {
  id?: string | number | null;
  html_url?: string | null;
  url?: string | null;
}

/** Injected side effects for {@link applyDigestUpsert}. */
export interface DigestUpsertIo<P extends DigestUpsertPlanLike> {
  skipClaimCheck: boolean;
  refetchAndPlan: () => P;
  assertClaim: () => void;
  createComment: (body: string | null) => DigestCommentMutationResult;
  updateComment: (
    commentId: string | number,
    body: string | null,
  ) => DigestCommentMutationResult;
}

/** Outcome of {@link applyDigestUpsert}. */
export interface DigestUpsertOutcome<P extends DigestUpsertPlanLike> {
  planned: P;
  outcome: 'duplicate' | 'created' | 'updated' | 'noop';
  commentId?: string | number | null;
  url?: string | null;
}

/**
 * Orchestrate the apply-time live-status-digest upsert: re-fetch and
 * re-plan against the latest comments, then revalidate the active claim
 * immediately before the create/update mutation, so a claim release or
 * takeover that lands during the replan's network fetch is caught before
 * the write. The side-effecting I/O is injected so the ordering invariant
 * — replan, then claim check, then mutation, and no write when the claim
 * check throws — is unit-testable apart from the live `gh` calls.
 */
export function applyDigestUpsert<P extends DigestUpsertPlanLike>(
  io: DigestUpsertIo<P>,
): DigestUpsertOutcome<P> {
  const planned = io.refetchAndPlan();
  if (planned.action === 'duplicate') {
    return { planned, outcome: 'duplicate' };
  }
  if (!io.skipClaimCheck) {
    io.assertClaim();
  }
  if (planned.action === 'create') {
    const created = io.createComment(planned.body);
    return {
      planned,
      outcome: 'created',
      commentId: created.id ?? null,
      url: created.html_url ?? created.url ?? null,
    };
  }
  if (planned.action === 'update') {
    if (planned.commentId === undefined || planned.commentId === null) {
      throw new Error(
        'cannot update digest because the current comment id is missing',
      );
    }
    const updated = io.updateComment(planned.commentId, planned.body);
    return {
      planned,
      outcome: 'updated',
      commentId: updated.id ?? planned.commentId,
      url: updated.html_url ?? updated.url ?? planned.url ?? null,
    };
  }
  return { planned, outcome: 'noop' };
}

export function unsafeTextReason(body: string): string | null {
  for (const rule of UNSAFE_TEXT_RULES) {
    if (rule.pattern.test(body)) {
      return rule.reason;
    }
  }
  return null;
}

// #2473: Copilot's PR-level review object reports a `[bot]`-suffixed slug
// login (`copilot-pull-request-reviewer[bot]`), but its inline
// review-comment replies report a bare, capitalized display-name login
// (`Copilot`, normalized here to `copilot`) with no suffix. The former
// prefix check (`normalized.startsWith('copilot-pull-request-reviewer')`)
// never matched that bare form, so a caller filtering comments by
// `isKnownReviewBot` silently treated a genuine Copilot reply as unknown.
// Delegating to `isCopilotReviewerLogin` (the #1686 exact-set matcher,
// already reused by the advisory-wait pending-coverage path) recognizes
// all three genuine login forms via `EXACT_COPILOT_REVIEWER_LOGINS`,
// including the bare `copilot` form, and narrows the old unbounded prefix
// match to that exact set -- closing the #1686 lookalike-username gap
// here too as a side effect of reuse, not a separately-designed change.
export function isKnownReviewBot(login: string): boolean {
  const normalized = login.toLowerCase();
  // `isCopilotReviewerLogin` also trims `login`, unlike the plain
  // `.toLowerCase()` above -- a benign widening (a GitHub API `login` field
  // never carries surrounding whitespace) rather than a deliberate choice.
  return REVIEW_BOT_LOGINS.has(normalized) || isCopilotReviewerLogin(login);
}

export function isCodeRabbitLogin(login: string): boolean {
  const normalized = login.toLowerCase();
  return normalized === 'coderabbitai' || normalized === 'coderabbitai[bot]';
}

// The exact CodeRabbit summary-walkthrough marker. CodeRabbit prefixes its
// auto-generated review summary with this HTML comment (distinct from the
// `rate limited by coderabbit.ai` notice marker). Single-sourced here so the
// comment-minimization classifier (`classifyRegularBotComment`) and the
// disposition-evidence summary predicate (`isReviewSummaryComment`) recognize
// byte-for-byte the same marker and cannot drift.
export const CODERABBIT_SUMMARY_MARKER =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';

// #2161: CodeRabbit nests this inner marker inside a comment that also
// starts with `CODERABBIT_SUMMARY_MARKER` when no review content exists
// (billing failure, or a repository below the star-count manual-trigger
// gate) -- the outer wrapper is byte-for-byte identical to a genuine
// summary walkthrough, so this inner marker is the only signal
// distinguishing the two. Single-sourced here so `isAdvisoryNonReviewNotice`
// and `isReviewSummaryComment` agree on the same marker and cannot drift.
export const CODERABBIT_SKIP_REVIEW_MARKER =
  '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->';

// Case-insensitive, matching CodeRabbit's own outer-marker patterns
// elsewhere in this file (see the rate-limit marker above) -- a
// case-sensitive `includes()` check here previously let
// `isReviewSummaryComment` and `isAdvisoryNonReviewNotice` disagree on a
// casing-only marker variation (kurone-kito/idd-skill#2161 review).
// Single-sourced so both predicates share the exact same test.
const CODERABBIT_SKIP_REVIEW_MARKER_RE = new RegExp(
  escapeRegExp(CODERABBIT_SKIP_REVIEW_MARKER),
  'i',
);

// #3260: CodeRabbit edits its summary comment IN PLACE when it starts
// reviewing new commits, nesting this inner marker (plus a "Currently
// processing new changes in this PR" note) next to the previous review's
// own content inside the same outer `CODERABBIT_SUMMARY_MARKER` wrapper --
// so an in-progress revision is byte-for-byte indistinguishable from a
// genuine walkthrough at the outer-wrapper level. Unlike
// `CODERABBIT_SKIP_REVIEW_MARKER`, this marker deliberately does NOT
// exclude a comment from `isReviewSummaryComment` -- it mirrors Codex's
// own in-progress "Running" state (`isCodexReviewSummaryCompleteForHeadSha`,
// below): the comment is still summary-shaped, but a separate completeness
// gate (`isCodeRabbitReviewInProgressSummary`, below) decides settlement/
// auto-accept eligibility. Single-sourced so the settlement classifier,
// `buildDispositionPlan`'s completeness gate, and
// `classifyRegularBotComment`'s RESOLVED guard all recognize
// byte-for-byte the same marker and cannot drift.
export const CODERABBIT_REVIEW_IN_PROGRESS_MARKER =
  '<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->';

const CODERABBIT_REVIEW_IN_PROGRESS_MARKER_RE = new RegExp(
  escapeRegExp(CODERABBIT_REVIEW_IN_PROGRESS_MARKER),
  'i',
);

// #3260: CodeRabbit's paused-review marker ("Reviews paused"): like
// `CODERABBIT_SKIP_REVIEW_MARKER`, this means the bot will not review new
// commits until someone resumes it, so it is a terminal non-review notice
// (declined), never a completed review -- added to
// `ADVISORY_NON_REVIEW_NOTICE_PATTERNS` below and excluded from
// `isReviewSummaryComment` the same way #2161 excludes the skip-review
// marker.
export const CODERABBIT_REVIEW_PAUSED_MARKER =
  '<!-- This is an auto-generated comment: review paused by coderabbit.ai -->';

const CODERABBIT_REVIEW_PAUSED_MARKER_RE = new RegExp(
  escapeRegExp(CODERABBIT_REVIEW_PAUSED_MARKER),
  'i',
);

/**
 * True when `body` carries CodeRabbit's #3260 in-progress marker anywhere in
 * its text -- the caller is expected to have already confirmed the body is
 * CodeRabbit's summary shape (`isReviewSummaryComment`, which deliberately
 * still returns `true` for this marker) before treating this as a
 * completeness signal. Consumed by
 * {@link computeSecondaryAdvisoryReviewSettlement} (reports pending, not
 * settled), `disposition-non-review-notices.mts`'s `buildDispositionPlan`
 * (skips with reason `coderabbit-review-in-progress`, mirroring Codex's own
 * `codex-review-running`), and `classifyRegularBotComment` (never RESOLVED
 * for it, even when an older "No actionable comments were generated"
 * sentence is still present in the body).
 */
export function isCodeRabbitReviewInProgressSummary(body: unknown): boolean {
  return CODERABBIT_REVIEW_IN_PROGRESS_MARKER_RE.test(String(body ?? ''));
}

// The exact marker `chatgpt-codex-connector[bot]` prefixes its own recurring
// PR-level review-status comment with: a single issue-level comment it edits
// in place (not reposts) on every push, showing a "Running"/"Completed"
// status table against the current commit. The Codex analog of
// `CODERABBIT_SUMMARY_MARKER` (#2695).
export const CODEX_SUMMARY_MARKER =
  '<!-- codex-pull-request-review-summary -->';

// Every recognized advisory-bot review-summary marker, keyed by the bot's
// suffix-insensitive identity token (see `advisoryBotIdentityToken`) so
// `isReviewSummaryComment` recognizes each configured advisory bot's own
// review-summary comment instead of only CodeRabbit's (#2695). Recognizing
// the marker does NOT by itself mean the review is complete -- Codex's
// summary can also appear while its own status table still reads "Running"
// for the current HEAD; `isCodexReviewSummaryCompleteForHeadSha` (below)
// gates the actual auto-accept / settlement on that separately.
// Single-sourced here so adding a future bot's summary marker means adding
// one map entry, not touching the recognizer function itself.
const REVIEW_SUMMARY_MARKERS_BY_BOT_IDENTITY: ReadonlyMap<string, string> =
  new Map([
    ['coderabbitai', CODERABBIT_SUMMARY_MARKER],
    ['chatgpt-codex-connector', CODEX_SUMMARY_MARKER],
  ]);

// The exact marker CodeRabbit appends to a reply it generates on an
// existing review thread (distinct from `CODERABBIT_SUMMARY_MARKER`,
// which opens a fresh review-summary walkthrough). Single-sourced here
// (#2641 review) so `classifyRegularBotComment`'s stale review-trigger
// check and `CODERABBIT_ACK_OPENING_RE`'s marker-first tolerance
// recognize byte-for-byte the same marker and cannot drift.
export const CODERABBIT_AUTO_GENERATED_REPLY_MARKER =
  '<!-- This is an auto-generated reply by CodeRabbit -->';

// #3146: CodeRabbit's incremental-review refusal is a regular top-level
// comment, not a review. Require the complete observed structure so ordinary
// review prose that mentions the same phrases cannot become a sticky notice:
// the reply marker, invocation marker, warning summary, exact already-reviewed
// statement, full-review remedy, and the explanatory note that no incremental
// review is run. Keep this anchored to the whole comment; under-matching a
// vendor wording change is safer than carrying a disposition onto a real
// review.
const CODERABBIT_ALREADY_REVIEWED_ACK_RE = new RegExp(
  `^${escapeRegExp(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)}\\s*` +
    '<!--\\s*CodeRabbit review command invocation:\\s*[^>\\r\\n]+-->\\s*' +
    '<details>\\s*<summary>\\s*⚠️\\s*Action not completed\\s*</summary>\\s*' +
    'Already reviewed the last commit\\.\\s*Use\\s+`@coderabbitai\\s+full\\s+review`' +
    '\\s+to rerun a\\s+review of the entire changeset\\.\\s*' +
    '>\\s*Note:\\s*CodeRabbit is an incremental review system and does not ' +
    're-review already reviewed commits\\.\\s*' +
    'This command is applicable only when automatic reviews are paused\\.\\s*' +
    '</details>\\s*$',
  'i',
);

export function isCodeRabbitAlreadyReviewedAcknowledgement(
  body: unknown,
): boolean {
  return CODERABBIT_ALREADY_REVIEWED_ACK_RE.test(
    String(body ?? '').trimStart(),
  );
}

// #3261: identity-pinned "genuinely complete" recognizer for CodeRabbit's
// OWN summary marker specifically -- unlike `isReviewSummaryComment` (which
// matches ANY configured bot's marker by design, since every existing call
// site already filters comments by author login before calling it), this is
// used to decide SETTLEMENT for one specific configured identity
// (`computeSecondaryAdvisoryReviewSettlement`, below), so it must not credit
// a `coderabbitai`-authored comment as complete merely because its body
// happens to start with a different bot's byte-identical marker text. Excludes
// the same three non-complete shapes the settlement classifier already
// distinguishes: the skip-review notice, the paused-review notice (both also
// classified as terminal declines elsewhere), and the #3260 in-progress
// revision (a genuine walkthrough that has not finished processing new
// commits yet). Mirrors the existing `token === 'coderabbitai'` gate already
// used for the in-progress check.
export function isCodeRabbitCompletedReviewSummary(body: unknown): boolean {
  const text = String(body ?? '').trimStart();
  return (
    text.startsWith(CODERABBIT_SUMMARY_MARKER) &&
    !CODERABBIT_SKIP_REVIEW_MARKER_RE.test(text) &&
    !CODERABBIT_REVIEW_PAUSED_MARKER_RE.test(text) &&
    !isCodeRabbitReviewInProgressSummary(text)
  );
}

// #2695 (Codex review, P1): chatgpt-codex-connector[bot] edits its own
// review-status comment IN PLACE across its whole lifecycle -- including
// while its own table still reads "Running" for the current HEAD.
// Auto-accepting it at that point (before Codex has posted its actual
// findings as their own review threads) would let the disposition-evidence
// gate treat the review as settled ahead of findings that arrive later --
// "a false positive is a false merge", the same hazard the CodeRabbit
// per-HEAD re-disposition above guards against. #3260 corrects this
// comment's prior claim that "CodeRabbit's own summary marker has no
// analogous in-progress state": CodeRabbit edits its OWN summary comment in
// place too, nesting a "review in progress by coderabbit.ai" marker next to
// the previous review's content while it processes new commits (live
// evidence: kurone-kito/idd-skill#3260, PR #3196 comment `5789875341`).
// `disposition-non-review-notices.mts`'s `buildDispositionPlan` own
// summary-walkthrough loop gates on that state via
// `isCodeRabbitReviewInProgressSummary` before this function ever runs --
// this table-parsing gate itself still applies to Codex only, because
// Codex's own in-progress signal is this status table, not a
// CodeRabbit-shaped marker. Parses the comment's own status table (columns
// identified by header text, so a reordered or renamed non-Status/Commit
// column does not break it) and requires the row for the current HEAD's
// (possibly-abbreviated) commit to read "Completed" (case-insensitively,
// tolerating the emoji/bold markup Codex wraps it in); any other outcome --
// Running, no matching row, or an unparseable table -- is treated as
// not-yet-complete so the caller must not disposition it (or, per #3261,
// treat it as a settled secondary-bot review) yet.
//
// #3261: moved here from `disposition-non-review-notices.mts` so
// `computeSecondaryAdvisoryReviewSettlement` (below) can use it directly
// without an import cycle (that file already imports from this one); it is
// re-exported unchanged from `disposition-non-review-notices.mts` so its
// two existing call sites there, and every external import, keep working.
export function isCodexReviewSummaryCompleteForHeadSha(
  body: string,
  headSha: string,
): boolean {
  const fullHeadSha = String(headSha ?? '')
    .trim()
    .toLowerCase();
  if (!fullHeadSha) {
    return false;
  }
  const rows = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  if (rows.length === 0) {
    return false;
  }
  const header = rows[0].map((cell) => cell.toLowerCase());
  const statusColumn = header.findIndex((cell) => cell.includes('status'));
  const commitColumn = header.findIndex((cell) => cell.includes('commit'));
  if (statusColumn === -1 || commitColumn === -1) {
    return false;
  }
  // Last matching row wins in case the table ever lists a commit more than
  // once, mirroring the "current state" semantics of an in-place edit.
  let latestStatus: string | null = null;
  for (const row of rows.slice(1)) {
    const commitCell = (row[commitColumn] ?? '')
      .replace(/`/g, '')
      .trim()
      .toLowerCase();
    if (!commitCell || !fullHeadSha.startsWith(commitCell)) {
      continue;
    }
    latestStatus = row[statusColumn] ?? '';
  }
  // Copilot review (PR #3422, two rounds): a bare `/completed/i` substring
  // test accepts a hypothetical "Not Completed" / "Uncompleted" status
  // cell (both contain the substring "completed"). An unanchored
  // `/\*\*\s*completed\s*\*\*/i.test()` first-round fix was still not
  // enough: `.test()` searches anywhere in the string, so a malformed cell
  // like "**Not **Completed**" (a separately bolded "Completed" segment
  // embedded after other bolded text) would still match. Extract ONLY the
  // first Markdown-bolded segment -- the actual status word every observed
  // real cell wraps in bold (`**Completed**`, `**Running**`), with
  // whatever follows (Codex's real fixture trails a `<relative-time>` HTML
  // span in the same cell) left out of the comparison -- and require THAT
  // extracted segment, trimmed, to equal "completed" exactly. Fail-closed
  // for any other shape, including no bold markup at all.
  if (latestStatus === null) {
    return false;
  }
  const boldStatusWord = /\*\*(.+?)\*\*/.exec(latestStatus)?.[1] ?? '';
  return boldStatusWord.trim().toLowerCase() === 'completed';
}

// #3193 (gist round 35): a second whole-comment CodeRabbit acknowledgement,
// sibling to CODERABBIT_ALREADY_REVIEWED_ACK_RE above -- the same reply
// marker, invocation marker, and "Action not completed" wrapper, but a
// promise-to-review sentence instead of "Already reviewed the last
// commit.", and the wrapper's body is the single line "Review rate
// limited." followed by the same incremental-review-system note. Unlike
// the sibling above, this is a CONCLUSIVE decline for the current commit
// (no retryable "run a full review" remedy is offered), so it is folded
// into `isTerminalAdvisoryNonReviewNotice` below, not
// `isCodeRabbitAlreadyReviewedAcknowledgement`.
//
// The field report (gist round 35) never captured the promise sentence's
// exact wording verbatim -- unlike every other anchor here, which is
// matched exactly. Guessing a specific literal phrase risks a regex that
// silently never matches the real comment (worse than the status quo), so
// that one sentence is matched structurally instead: a bounded run of
// plain text with no nested HTML, so it cannot cross into the following
// `<details>` tag. An earlier draft also required the literal word
// "review" inside that span; a CodeRabbit CLI delegate review of this
// same change (C1, #3193) found that requirement itself too strict --
// a real CodeRabbit acknowledgement sentence need not contain that exact
// token -- so it was dropped. The surrounding anchors (reply marker,
// invocation marker, "Action not completed" summary, the exact "Review
// rate limited." line, and the exact incremental-review note) are
// already specific enough on their own that a genuine review comment
// which merely mentions "rate limited" in prose still cannot match,
// mirroring CODERABBIT_ALREADY_REVIEWED_ACK_RE's own fail-closed
// anchoring discipline.
const CODERABBIT_RATE_LIMITED_ACK_RE = new RegExp(
  `^${escapeRegExp(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)}\\s*` +
    '<!--\\s*CodeRabbit review command invocation:\\s*[^>\\r\\n]+-->\\s*' +
    '[^<]{1,200}' +
    '<details>\\s*<summary>\\s*⚠️\\s*Action not completed\\s*</summary>\\s*' +
    'Review rate limited\\.\\s*' +
    '>\\s*Note:\\s*CodeRabbit is an incremental review system and does not ' +
    're-review already reviewed commits\\.\\s*' +
    'This command is applicable only when automatic reviews are paused\\.\\s*' +
    '</details>\\s*$',
  'i',
);

export function isCodeRabbitRateLimitedAcknowledgement(body: unknown): boolean {
  return CODERABBIT_RATE_LIMITED_ACK_RE.test(String(body ?? '').trimStart());
}

/**
 * One finding embedded in a CodeRabbit review body's older "🧹 Nitpick
 * comments" / "⚠️ Outside diff range comments" collapsible-section format
 * (#2559), extracted by {@link extractCodeRabbitEmbeddedFindings}.
 */
export interface CodeRabbitEmbeddedFinding {
  file: string;
  lineRange: string;
  severity: string | null;
  description: string;
}

// Matches the two section headings this older CodeRabbit format nests
// per-file findings under (kurone-kito/idd-skill#2197, kurone-kito/idd-skill#2559): a review whose finding has no
// threaded comment of its own. A newer-format review ("Actionable comments
// posted: N", individually threaded) never emits either heading, so this
// gate alone already satisfies the "newer format stays unaffected"
// acceptance criterion.
const CODERABBIT_EMBEDDED_SECTION_HEADING_RE =
  /<summary>(?:🧹 Nitpick comments|⚠️ Outside diff range comments) \(\d+\)<\/summary>/g;

// A per-file grouping inside one of the sections above: `<summary>{file}
// (N)</summary>`. Accepts an extensionless, separator-less filename (e.g.
// `Dockerfile`, `Makefile`, `LICENSE`) -- an earlier version required a
// `.` extension or `/` separator to avoid matching an unrelated
// `<summary>` heading that also carries a parenthesized count, e.g. the
// review's own "📒 Files selected for processing (N)" section, but that
// also dropped every finding for a real extensionless file (Copilot
// review, PR #2563). The real defense against that unrelated heading is
// {@link CODERABBIT_EMBEDDED_SECTION_END_RE} bounding the section's own
// span below, not this pattern.
const CODERABBIT_EMBEDDED_FILE_HEADING_RE =
  /<summary>([^<]+?) \(\d+\)<\/summary>/g;

// Marks the natural end of a Nitpick/Outside-diff section's own content in
// every review body sampled for #2197/#2559: CodeRabbit always follows the
// per-file findings with this footer before any unrelated section (e.g.
// "ℹ️ Review info" > "📒 Files selected for processing"). Bounding the
// section span here -- not just at the next same-kind section heading --
// keeps the relaxed file-heading pattern above from matching a later,
// unrelated `<summary>{text} (N)</summary>` several sections down (Copilot
// review, PR #2563).
const CODERABBIT_EMBEDDED_SECTION_END_RE =
  /<summary>🤖 Prompt for all review comments with AI agents<\/summary>/;

// One finding's header line inside a file grouping: a backtick-quoted line
// or line range, a colon, then 1-3 pipe-separated italic metadata segments
// (category, severity, effort -- CodeRabbit does not document this shape
// itself; it is inferred from every review body sampled for #2197/#2559).
// Deliberately confined to same-line whitespace (`[ \t]`, never `\s`, which
// includes newlines) in both the per-segment content and the separator
// between segments: an earlier `\s`-based version could absorb an entirely
// separate later `_italic_` phrase from the finding's own prose into this
// same metadata capture once a blank line intervened, corrupting the
// severity/title boundary (Copilot review, PR #2563).
const CODERABBIT_EMBEDDED_FINDING_HEADER_RE =
  /`(\d+(?:-\d+)?)`:[ \t]*((?:_[^_\n]*_[ \t]*\|?[ \t]*)+)/g;

// No `\b` before/after the word: each segment is markdown-italic-wrapped
// (`_..._`), and `_` is itself a `\w` character, so a trailing `\b` would
// never match immediately before the closing underscore.
const CODERABBIT_SEVERITY_WORD_RE = /(Trivial|Minor|Major|Critical)/i;

/** Bold title line (`**...**`) directly introducing a finding's prose. */
const CODERABBIT_EMBEDDED_FINDING_TITLE_RE = /\*\*(.+?)\*\*/;

/**
 * Extract each finding embedded in a CodeRabbit review body's older
 * "🧹 Nitpick comments" / "⚠️ Outside diff range comments" collapsible
 * format (#2197, #2559) -- a specific, file/line-cited finding that this
 * format never gives its own threaded review comment, unlike CodeRabbit's
 * newer per-comment format. Returns `[]` when `body` carries neither
 * section heading (including every newer-format review) or is not a
 * string.
 *
 * Best-effort, not a full HTML/Markdown parser: scoped to one section at a
 * time by heading-to-next-heading text slicing, then one file grouping at a
 * time the same way, then one finding header line at a time within that
 * slice. A finding whose bold title cannot be found before the next
 * boundary still contributes an entry with `description: ''` rather than
 * being silently dropped -- an uncovered finding this parser cannot
 * describe is still an uncovered finding.
 */
export function extractCodeRabbitEmbeddedFindings(
  body: unknown,
): CodeRabbitEmbeddedFinding[] {
  if (typeof body !== 'string' || body.length === 0) {
    return [];
  }
  const sectionHeadings = [
    ...body.matchAll(CODERABBIT_EMBEDDED_SECTION_HEADING_RE),
  ];
  if (sectionHeadings.length === 0) {
    return [];
  }
  const findings: CodeRabbitEmbeddedFinding[] = [];
  for (let i = 0; i < sectionHeadings.length; i += 1) {
    const start = sectionHeadings[i].index + sectionHeadings[i][0].length;
    const nextSectionStart = sectionHeadings[i + 1]?.index ?? body.length;
    const footerMatch = body
      .slice(start, nextSectionStart)
      .match(CODERABBIT_EMBEDDED_SECTION_END_RE);
    const end =
      footerMatch?.index !== undefined
        ? start + footerMatch.index
        : nextSectionStart;
    findings.push(
      ...extractCodeRabbitEmbeddedFindingsFromSection(body.slice(start, end)),
    );
  }
  return findings;
}

function extractCodeRabbitEmbeddedFindingsFromSection(
  section: string,
): CodeRabbitEmbeddedFinding[] {
  const fileHeadings = [
    ...section.matchAll(CODERABBIT_EMBEDDED_FILE_HEADING_RE),
  ];
  const findings: CodeRabbitEmbeddedFinding[] = [];
  for (let i = 0; i < fileHeadings.length; i += 1) {
    const file = fileHeadings[i][1].trim();
    const start = fileHeadings[i].index + fileHeadings[i][0].length;
    const end = fileHeadings[i + 1]?.index ?? section.length;
    const zone = section.slice(start, end);
    // Collected up front (not iterated via a live matchAll) so each
    // finding's own title search below can be bounded by the NEXT
    // finding's header position -- searching the zone's unbounded
    // remainder let a finding with no bold title of its own "steal" a
    // later finding's title instead of reporting an empty description
    // (Copilot review, PR #2563).
    const headers = [...zone.matchAll(CODERABBIT_EMBEDDED_FINDING_HEADER_RE)];
    for (let j = 0; j < headers.length; j += 1) {
      const header = headers[j];
      const lineRange = header[1];
      const severityMatch = header[2].match(CODERABBIT_SEVERITY_WORD_RE);
      const contentStart = header.index + header[0].length;
      const contentEnd = headers[j + 1]?.index ?? zone.length;
      const findingContent = zone.slice(contentStart, contentEnd);
      const titleMatch = findingContent.match(
        CODERABBIT_EMBEDDED_FINDING_TITLE_RE,
      );
      findings.push({
        file,
        lineRange,
        severity: severityMatch ? severityMatch[0] : null,
        description: titleMatch ? titleMatch[1].trim() : '',
      });
    }
  }
  return findings;
}

/**
 * Compare {@link extractCodeRabbitEmbeddedFindings}'s count for `body`
 * against `threadedCommentCount` -- the number of `coderabbitai[bot]`
 * threaded review comments already present for this review/PR -- so a
 * caller gets the uncovered-finding gap (#2559) without re-deriving the
 * comparison. Never negative: a review whose threaded comments already
 * meet or exceed its embedded-finding count reports `0`.
 */
// audit:ignore-dead-export: pending #3341's own expose-via-CLI decision for this export; do not duplicate that fix here
export function countUncoveredCodeRabbitEmbeddedFindings(
  body: unknown,
  threadedCommentCount: number,
): number {
  const embeddedFindingCount = extractCodeRabbitEmbeddedFindings(body).length;
  return Math.max(0, embeddedFindingCount - threadedCommentCount);
}

// #3466: unlike `hasExplicitDispositionAfter` (the CodeRabbit
// summary-walkthrough branch below), notice/disposition attribution must
// never fall back to a bare product-word match. That fallback's
// `\bCodeRabbit\b` test only makes sense there because a CodeRabbit summary
// sticky is itself CodeRabbit-specific, so any disposition mentioning
// "CodeRabbit" is safely attributable to it. A Codex usage-limit notice has
// no such single-bot context -- in a multi-advisory-bot repository, a
// differently-worded disposition that merely happens to name a DIFFERENT
// configured bot (e.g. "**Rejected** -- CodeRabbit rate-limited, no findings
// to triage.") must never resolve it. Match strictly on the production
// non-review-notice template instead (`isNonReviewNoticeDisposition`, the
// same "**Rejected** ... did not review HEAD ..." shape
// `disposition-non-review-notices.mts` posts) plus per-bot login attribution
// (`dispositionNamesAdvisoryBot`).
//
// A Codex usage-limit notice (`isCodexUsageLimitNotice`) is a flat,
// single-shot notice, not an editable review a later revision could still
// add threads to -- unlike the CodeRabbit summary-walkthrough branch below,
// it never resolves on its own. It becomes a minimization candidate only
// once a LATER trusted IDD disposition is paired to THIS exact notice.
//
// #3466 review history (PR #3470) tried three progressively stricter
// order-based pairing schemes here -- a bare "any qualifying disposition
// exists after me" check, a count cap mirroring the #1018 carry-forward,
// then a greedy chronological match -- and each one drew a new, genuine
// correctness finding from a fresh review round (order-based reassignment
// can always misattribute a disposition to an unrelated notice it never
// named). Per this project's own E10 round-count heuristic ("after several
// consecutive rounds each finding something new in the same area... prefer
// removing or substantially simplifying the fragile mechanism"), this now
// binds a notice to a disposition ONLY via the disposition's own explicit,
// unambiguous `(source: #issuecomment-{id})` reference -- never by order,
// count, or any other guess. This is not a narrowing of the accepted
// contract: the issue's own acceptance criteria requires a disposition
// that "attributes that same comment", and both the production
// `buildDispositionBody` template and this repository's own E6 instruction
// ALWAYS include that exact reference -- there is no documented,
// real-world disposition shape this simplification stops recognizing.
const DISPOSITION_SOURCE_ISSUECOMMENT_RE = /\(source:\s*#issuecomment-(\d+)\)/;
const ISSUECOMMENT_URL_ID_RE = /#issuecomment-(\d+)/;

/** The REST (numeric) comment id for `comment`, however this caller's
 * `CommentLike` happens to carry it -- a plain/numeric-string `id` (the
 * shape `disposition-non-review-notices.mts` and this file's own test
 * fixtures use), or extracted from a GraphQL-shaped `url`/`html_url`
 * (`audit-pr-cleanup.mts`'s real GraphQL node ids aren't REST ids
 * themselves, but the comment's own web URL still ends in
 * `#issuecomment-{REST id}` either way). `null` when neither yields one. */
function restCommentId(comment: CommentLike): string | null {
  const rawId = comment.id;
  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    return String(rawId);
  }
  // Defensive, not currently exercised by any known caller: a REST id
  // that already arrived pre-stringified (e.g. round-tripped through
  // JSON) rather than as a `number` or a GraphQL node id.
  if (typeof rawId === 'string' && /^\d+$/.test(rawId)) {
    return rawId;
  }
  const url = String(comment.html_url ?? comment.url ?? '');
  return ISSUECOMMENT_URL_ID_RE.exec(url)?.[1] ?? null;
}

function dispositionSourceCommentId(body: unknown): string | null {
  return (
    DISPOSITION_SOURCE_ISSUECOMMENT_RE.exec(String(body ?? ''))?.[1] ?? null
  );
}

function resolvedCodexUsageLimitNotices(
  comments: CommentLike[],
  targetBotLogin: string,
  isDispositionAuthor: (login: string) => boolean,
): Set<CommentLike> {
  const noticeByRestId = new Map<string, CommentLike>();
  for (const candidate of comments) {
    if (
      advisoryBotIdentityToken(candidate.author?.login ?? '') !==
        'chatgpt-codex-connector' ||
      !isCodexUsageLimitNotice(candidate.body ?? '')
    ) {
      continue;
    }
    const restId = restCommentId(candidate);
    if (restId) {
      noticeByRestId.set(restId, candidate);
    }
  }

  const resolved = new Set<CommentLike>();
  for (const candidate of comments) {
    const author = String(candidate.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (
      !isDispositionAuthor(author) ||
      !isNonReviewNoticeDisposition({ body: candidate.body }) ||
      !dispositionNamesAdvisoryBot(candidate.body ?? '', targetBotLogin)
    ) {
      continue;
    }
    const sourceId = dispositionSourceCommentId(candidate.body);
    if (!sourceId) {
      continue;
    }
    const notice = noticeByRestId.get(sourceId);
    if (!notice) {
      continue;
    }
    const noticeTime = Date.parse(notice.createdAt ?? '');
    const dispositionTime = Date.parse(candidate.createdAt ?? '');
    if (
      !Number.isFinite(noticeTime) ||
      !Number.isFinite(dispositionTime) ||
      !(dispositionTime > noticeTime)
    ) {
      // A binding that names a real, present notice but predates it is
      // internally inconsistent -- nothing can genuinely disposition a
      // comment that has not been posted yet -- so it is discarded rather
      // than resolving anything.
      continue;
    }
    resolved.add(notice);
  }
  return resolved;
}

function classifyCodexUsageLimitNotice(
  comment: CommentLike,
  comments: CommentLike[],
  options: { isDispositionAuthor?: (login: string) => boolean },
): CommentClassification | null {
  const author = comment.author?.login ?? '';
  if (advisoryBotIdentityToken(author) !== 'chatgpt-codex-connector') {
    return null;
  }
  if (!isCodexUsageLimitNotice(comment.body ?? '')) {
    return null;
  }
  const isDispositionAuthor =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const resolved = resolvedCodexUsageLimitNotices(
    comments,
    author,
    isDispositionAuthor,
  );
  if (!resolved.has(comment)) {
    return null;
  }
  return {
    classifier: 'RESOLVED',
    reason: 'Codex usage-limit notice has matched IDD disposition evidence',
  };
}

export function classifyRegularBotComment(
  comment: CommentLike,
  comments: CommentLike[],
  threads: ThreadLike[],
  options: {
    isDispositionAuthor?: (login: string) => boolean;
    // #3466: opt-in only. `summarizeDispositionEvidenceForGate` and
    // `summarizeRegularCommentsForGate` (the F2/F3 merge-gate consumers of
    // this classifier) each already carry their OWN multi-bot-safe
    // carry-forward for a dispositioned Codex notice (the #1018 loop and
    // `matchTrustedAdvisoryStickyDispositions`, respectively), including
    // bookkeeping that marks the matched disposition consumed so it can
    // never leak into a generic 1:1 pairing pool and falsely resolve a
    // DIFFERENT bot's still-undispositioned notice. Recognizing the notice
    // here too, unconditionally, would let this classifier's own result
    // bypass that bookkeeping and reopen exactly that leak. Only
    // `audit-pr-cleanup.mts`'s F4 cleanup caller -- which has no such
    // separate mechanism of its own -- opts in.
    includeCodexUsageLimitNotice?: boolean;
  } = {},
): CommentClassification | null {
  const author = comment.author?.login ?? '';
  if (!isCodeRabbitLogin(author)) {
    if (!options.includeCodexUsageLimitNotice) {
      return null;
    }
    return classifyCodexUsageLimitNotice(comment, comments, options);
  }

  if (hasUnresolvedKnownBotThreads(threads)) {
    return null;
  }

  const body = (comment.body ?? '').trimStart();

  if (body.startsWith(CODERABBIT_SUMMARY_MARKER)) {
    // #3260: an in-progress or paused revision must never resolve, even
    // when an older "No actionable comments were generated" sentence (or a
    // stale matching disposition) is still present from the review this
    // revision superseded -- both checks below are un-reachable for either
    // marker.
    if (
      isCodeRabbitReviewInProgressSummary(body) ||
      CODERABBIT_REVIEW_PAUSED_MARKER_RE.test(body)
    ) {
      return null;
    }
    if (/No actionable comments were generated/i.test(body)) {
      return {
        classifier: 'RESOLVED',
        reason: 'CodeRabbit completed summary reported no actionable comments',
      };
    }
    if (
      hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      }) ||
      hasCompletedBotThreadDispositions(threads, isCodeRabbitLogin, {
        isDispositionAuthor: options.isDispositionAuthor,
      })
    ) {
      return {
        classifier: 'RESOLVED',
        reason:
          'CodeRabbit completed summary has matched IDD disposition evidence',
      };
    }
    return null;
  }

  if (body.startsWith(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)) {
    // Keep the retryable already-reviewed acknowledgement in the outstanding
    // pool. `summarizeDispositionEvidenceForGate` consumes its
    // notice-specific dispositions one-to-one; classifying it here from the
    // mere existence of a later disposition would let one reply clear repeated
    // acknowledgements (#3153, Copilot review on PR #3153).
    if (/\b(Review triggered|Sure! I'll review|I'll review)\b/i.test(body)) {
      const hasDisposition = hasExplicitDispositionAfter(comment, comments, {
        isDispositionAuthor: options.isDispositionAuthor,
      });
      if (!hasDisposition) {
        return null;
      }
      return {
        classifier: 'OUTDATED',
        reason:
          'stale CodeRabbit review-trigger acknowledgement after completed review',
      };
    }
  }

  return null;
}

export function indexLatestGatingReviewsByAuthor(reviews: ReviewLike[]) {
  const index = new Map<
    string,
    ReviewLike & { submittedAt: string; submitted_at: string }
  >();
  for (const review of reviews) {
    const state = String(review.state ?? '');
    if (state === 'COMMENTED' || state === 'PENDING') {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const effectiveSubmittedAt = normalizeGatingReviewTimestamp(review, state);
    if (!effectiveSubmittedAt) {
      continue;
    }
    const current = index.get(author);
    const currentTime = current
      ? Date.parse(current.submittedAt ?? current.submitted_at ?? '')
      : Number.NEGATIVE_INFINITY;
    const reviewTime = Date.parse(effectiveSubmittedAt);
    if (!current || reviewTime >= currentTime) {
      index.set(author, {
        ...review,
        submittedAt: effectiveSubmittedAt,
        submitted_at: effectiveSubmittedAt,
      });
    }
  }
  return index;
}

export function indexThreadsByReview(
  threads: ThreadLike[],
  options: {
    isDispositionAuthor?: (login: string) => boolean;
    // #2618: F4's ack-only-post-disposition carve-out, matching F2/F3's
    // `summarizeDispositionEvidenceForGate` (`classifyThreadAckOnlyPostDisposition`).
    // Both are optional: omitting either keeps the pre-#2618 behavior
    // exactly (a thread without a fresh disposition always counts as
    // missing).
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
  } = {},
) {
  const index = new Map<
    string,
    {
      total: number;
      unresolved: number;
      missingDisposition: number;
      incomplete: boolean;
      threadIds: (string | null | undefined)[];
    }
  >();

  for (const thread of threads) {
    const reviewIds = new Set(
      (thread.comments?.nodes ?? [])
        .map((comment) => comment.pullRequestReview?.id)
        .filter(Boolean) as string[],
    );

    for (const reviewId of reviewIds) {
      const current = index.get(reviewId) ?? {
        total: 0,
        unresolved: 0,
        missingDisposition: 0,
        incomplete: false,
        threadIds: [],
      };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      if (
        !hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
          advisoryBotLogins: options.advisoryBotLogins,
        }) &&
        !classifyThreadAckOnlyPostDisposition(thread, {
          iddAgentLogins: options.iddAgentLogins,
          advisoryBotLogins: options.advisoryBotLogins,
          prAuthorLogin: options.prAuthorLogin,
        }).ackOnlyPostDisposition
      ) {
        current.missingDisposition += 1;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        current.incomplete = true;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }

  return index;
}

// audit:ignore-dead-export: pending #3341's own delete decision for this export; do not duplicate that fix here
export function routeRejectedChangesRequestedReview(input: {
  policyConfig?: unknown;
  reviewState?: string | null;
  reviewerDisposition?: string | null;
  maintainerDisposition?: string | null;
  now?: string | null;
  rejectionCommentCreatedAt?: string | null;
  escalationCommentCreatedAt?: string | null;
}): RouteDecision {
  const escalationPolicy = getReviewEscalationChangesRequestedPolicy(
    input?.policyConfig ?? {},
  );
  const firstEscalationWindowMs = escalationPolicy.escalateAfterMs;
  const postEscalationWindowMs = escalationPolicy.releaseAfterEscalationMs;
  const totalWindowLabel = formatDurationLabel(
    firstEscalationWindowMs + postEscalationWindowMs,
  );
  const firstWindowLabel = formatDurationLabel(firstEscalationWindowMs);

  const reviewState = String(input.reviewState ?? '');
  if (reviewState !== 'CHANGES_REQUESTED') {
    return {
      route: 'proceed',
      reason: 'changes-requested state already cleared',
    };
  }

  const reviewerDisposition = String(input.reviewerDisposition ?? 'none');
  if (reviewerDisposition === 'disagreed') {
    return {
      route: 'return-to-e1',
      reason:
        'reviewer disagreed with the rejection and the feedback must return to triage',
    };
  }
  if (reviewerDisposition === 'agreed-state-cleared') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }
  if (reviewerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'reviewer agreement alone does not clear a changes-requested state',
    };
  }

  const maintainerDisposition = String(input.maintainerDisposition ?? 'none');
  if (maintainerDisposition === 'agreed-state-unchanged') {
    return {
      route: 'hold-await-state-clear',
      reason:
        'maintainer agreement does not clear the original changes-requested state',
    };
  }

  const elapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.rejectionCommentCreatedAt ?? '');
  if (!Number.isFinite(elapsedMs)) {
    return {
      route: 'hold-for-evidence',
      reason:
        'elapsed time cannot be computed for the rejected changes-requested review',
    };
  }

  if (elapsedMs < firstEscalationWindowMs) {
    return {
      route: 'hold-before-escalation',
      reason: `still within the first ${firstWindowLabel} after the rejection reply`,
    };
  }

  const escalationElapsedMs =
    Date.parse(input.now ?? '') -
    Date.parse(input.escalationCommentCreatedAt ?? '');
  if (!Number.isFinite(escalationElapsedMs)) {
    return {
      route: 'escalate-maintainer',
      reason: `the changes-requested review is still blocking after ${firstWindowLabel} with no reviewer response`,
    };
  }
  if (escalationElapsedMs < postEscalationWindowMs) {
    return {
      route: 'hold-after-escalation',
      reason: `still within ${formatDurationLabel(postEscalationWindowMs)} of the maintainer escalation comment`,
    };
  }
  return {
    route: 'label-and-release',
    reason: `the changes-requested review is still blocking after ${totalWindowLabel} with no escalation response`,
  };
}

function formatDurationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0 minutes';
  }
  if (milliseconds % (60 * 60 * 1000) === 0) {
    const hours = milliseconds / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (milliseconds % (60 * 1000) === 0) {
    const minutes = milliseconds / (60 * 1000);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = milliseconds / 1000;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function diffReviewSnapshot(
  snapshot: {
    headSha?: string | null;
    maxActivityUpdatedAt?: string | null;
    totalItemCount?: number | string | null;
    latestPassingCiCompletedAt?: string | null;
    latestCiCompletedAt?: string | null;
  },
  live: {
    headSha?: string | null;
    maxActivityUpdatedAt?: string | null;
    totalItemCount?: number | string | null;
    latestPassingCiCompletedAt?: string | null;
    latestCiCompletedAt?: string | null;
    ackOnly?: {
      items?: { kind?: string | null; activityAt?: string | null }[] | null;
      dispositionsPresent?: boolean | null;
    } | null;
    effective?: {
      maxActivityUpdatedAt?: string | null;
      totalItemCount?: number | null;
    } | null;
  },
): RouteDecision {
  if (String(live.headSha ?? '') !== String(snapshot.headSha ?? '')) {
    return { route: 'return-to-e1', reason: 'head-changed' };
  }

  const snapshotMax = normalizeComparableTimestamp(
    snapshot.maxActivityUpdatedAt,
  );
  const liveMax = normalizeComparableTimestamp(live.maxActivityUpdatedAt);
  const snapshotCount = Number(snapshot.totalItemCount ?? 0);
  const liveCount = Number(live.totalItemCount ?? 0);
  // Structural ack-only carve-out (#858): when the only activity newer
  // than the snapshot is post-disposition advisory-bot acknowledgement
  // evidence, fall back to the effective values instead of re-opening.
  // Absent evidence keeps the legacy behavior unchanged (fail-closed).
  const ackItems = Array.isArray(live.ackOnly?.items) ? live.ackOnly.items : [];
  const ackEvidencePresent =
    live.ackOnly?.dispositionsPresent === true && ackItems.length > 0;
  const effectiveMax = normalizeComparableTimestamp(
    live.effective?.maxActivityUpdatedAt ?? 'none',
  );
  let ackOnlyApplied = false;
  if (snapshotMax === 'none' && liveCount > 0) {
    return { route: 'return-to-e1', reason: 'snapshot-was-empty-now-nonempty' };
  }
  if (
    typeof snapshotMax === 'number' &&
    liveCount > 0 &&
    (liveMax === null || liveMax === 'none')
  ) {
    return { route: 'return-to-e1', reason: 'missing-live-activity-evidence' };
  }
  if (
    typeof snapshotMax === 'number' &&
    typeof liveMax === 'number' &&
    liveMax > snapshotMax
  ) {
    const effectiveCurrent =
      ackEvidencePresent &&
      typeof live.effective === 'object' &&
      live.effective !== null &&
      (effectiveMax === 'none' ||
        (typeof effectiveMax === 'number' && effectiveMax <= snapshotMax));
    if (!effectiveCurrent) {
      return { route: 'return-to-e1', reason: 'newer-activity' };
    }
    ackOnlyApplied = true;
  }
  if (liveCount > snapshotCount) {
    // Only ack comments newer than the snapshot max may explain count
    // growth; older acks were already inside the snapshot's count.
    const ackNewerCount = ackItems.filter(
      (item) =>
        item.kind === 'comment' &&
        isValidIsoTimestamp(item.activityAt) &&
        typeof snapshotMax === 'number' &&
        compareIsoTimestamps(item.activityAt, snapshot.maxActivityUpdatedAt) >
          0,
    ).length;
    if (!(ackEvidencePresent && liveCount - ackNewerCount <= snapshotCount)) {
      return { route: 'return-to-e1', reason: 'same-timestamp-count-growth' };
    }
    ackOnlyApplied = true;
  }

  const snapshotCi = normalizeComparableTimestamp(
    snapshot.latestPassingCiCompletedAt ?? snapshot.latestCiCompletedAt,
  );
  const liveCi = normalizeComparableTimestamp(
    live.latestPassingCiCompletedAt ?? live.latestCiCompletedAt,
  );
  if (snapshotCi === null || liveCi === null) {
    return { route: 'return-to-e1', reason: 'missing-ci-evidence' };
  }
  if (snapshotCi !== liveCi) {
    return { route: 'return-to-e1', reason: 'ci-pass-drift' };
  }

  return {
    route: 'proceed',
    reason: ackOnlyApplied ? 'ack-only-post-disposition' : 'snapshot-current',
  };
}

export function classifyReviewThreadForGate(
  thread: ThreadLike,
  options: {
    iddAgentLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    requiresConversationResolution?: boolean;
  } = {},
): ReviewThreadGateClassification {
  if (thread.isResolved) {
    return { classification: 'resolved' };
  }
  if (thread.comments?.pageInfo?.hasNextPage) {
    return { classification: 'actionable-blocking' };
  }

  const comments = thread.comments?.nodes ?? [];
  const latestComment = comments.at(-1) ?? null;
  const latestCommentAt = normalizeComparableTimestamp(
    latestComment?.createdAt,
  );
  const latestAuthor = String(latestComment?.author?.login ?? '').toLowerCase();
  const iddAgentLogins = new Set(
    (options.iddAgentLogins ?? [])
      .map((login) => String(login ?? '').toLowerCase())
      .filter(Boolean),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '').toLowerCase();
  const latestIsIddAgent = iddAgentLogins.has(latestAuthor);
  const latestIsPrAuthor =
    Boolean(prAuthorLogin) && latestAuthor === prAuthorLogin;
  let latestAmdIndex = -1;
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const authorLogin = String(comment.author?.login ?? '').toLowerCase();
    if (
      iddAgentLogins.has(authorLogin) &&
      AMD_MARKER_PATTERN.test(String(comment.body ?? '').trimStart())
    ) {
      latestAmdIndex = index;
    }
  }
  const reviewerReopenedAt = normalizeComparableTimestamp(
    inferReviewerReopenedAt(thread),
  );
  const reopenedAfterLatestComment =
    typeof reviewerReopenedAt === 'number' &&
    (typeof latestCommentAt !== 'number' ||
      reviewerReopenedAt > latestCommentAt);
  const amdAwaitsMaintainer =
    latestAmdIndex >= 0 &&
    !reopenedAfterLatestComment &&
    !comments.slice(latestAmdIndex + 1).some((comment) => {
      const authorLogin = String(comment.author?.login ?? '').toLowerCase();
      return !iddAgentLogins.has(authorLogin) && authorLogin !== prAuthorLogin;
    });

  if (amdAwaitsMaintainer) {
    return { classification: 'amd-blocking' };
  }

  if (!(latestIsIddAgent || latestIsPrAuthor)) {
    return { classification: 'actionable-blocking' };
  }

  if (reopenedAfterLatestComment) {
    return { classification: 'actionable-blocking' };
  }

  if (options.requiresConversationResolution) {
    if (latestIsIddAgent) {
      return { classification: 'conversation-resolve-agent' };
    }
    return { classification: 'conversation-resolve-author' };
  }

  return { classification: 'awaiting-reviewer' };
}

// Pre-merge gate invariant (review threads -> `threads.actionableCount`):
// MERGE-BLOCKING. `computePreMergeReadinessBlockers` fails closed unless
// `actionableCount === 0`. An IDD agent's (or the PR author's) latest thread
// comment classifies `awaiting-reviewer`, which does NOT add to
// `actionableCount`, so a recognition error here can fail OPEN: globally
// promoting a non-agent into `iddAgentLogins` makes that actor's genuine
// unresolved feedback classify `awaiting-reviewer` and stop blocking (when
// conversation resolution is not required; otherwise it stays a blocking
// `conversation-resolve-*`). This gate classifies each thread by its own
// latest-author identity (IDD agent / PR author), not by disposition
// recognition; never globally promote a non-agent into `iddAgentLogins`. See
// the consolidated invariants above `summarizeDispositionEvidenceForGate`
// (#1182 / PR #1184).
export function summarizeReviewThreadsForGate(
  threads: ThreadLike[],
  options: {
    iddAgentLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    requiresConversationResolution?: boolean;
  } = {},
): ReviewThreadsGateSummary {
  const summary: ReviewThreadsGateSummary = {
    actionableCount: 0,
    awaitingReviewerCount: 0,
    amdBlockingCount: 0,
    conversationResolveAgentCount: 0,
    conversationResolveAuthorCount: 0,
    classifications: [],
  };

  for (const thread of threads) {
    const result = classifyReviewThreadForGate(thread, options);
    if (result.classification === 'resolved') {
      continue;
    }

    summary.classifications.push({
      id: thread.id,
      classification: result.classification,
    });

    if (result.classification === 'actionable-blocking') {
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'amd-blocking') {
      summary.amdBlockingCount += 1;
      summary.actionableCount += 1;
      continue;
    }
    if (result.classification === 'awaiting-reviewer') {
      summary.awaitingReviewerCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-agent') {
      summary.actionableCount += 1;
      summary.conversationResolveAgentCount += 1;
      continue;
    }
    if (result.classification === 'conversation-resolve-author') {
      summary.actionableCount += 1;
      summary.conversationResolveAuthorCount += 1;
    }
  }

  return summary;
}

function inferReviewerReopenedAt(thread: ThreadLike): string {
  const explicit = String(thread.reviewerReopenedAt ?? '');
  if (isValidIsoTimestamp(explicit)) {
    return explicit;
  }
  return '';
}

export function hasFreshDisposition(
  thread: ThreadLike,
  options: {
    isDispositionAuthor?: (login: string) => boolean;
    // #3269: forwarded to `effectiveThreadCommentActivityAt`'s own
    // verified-cosmetic-edit dating -- see that function's doc comment.
    // Omitted (the default) by every caller outside the F2/F3
    // disposition-evidence path, which never verifies an edited comment
    // as cosmetic regardless of any attached `userContentEdits`,
    // unchanged pre-#3269 `updatedAt` dating.
    advisoryBotLogins?: unknown[] | null;
  } = {},
): boolean {
  // IMPORTANT: The default disposition-author predicate rejects known bots but accepts any human.
  // For F2/F3 merge-gate contexts (E7 disposition evidence), callers MUST pass
  // options.isDispositionAuthor with an IDD-scoped predicate (e.g., via summarizeDispositionEvidenceForGate).
  // Callers that require IDD-only dispositions (e.g., audit-pr-cleanup) should pass:
  //   { isDispositionAuthor: (login) => iddAgentLogins.has(login) }
  // This design trades stricter default behavior for backward compatibility with utility functions.
  // #2135's own design intent is that a spoofed/copied review-reply stamp
  // "only makes the gate stricter for that comment" -- the stamp is
  // utterance identity among already-trusted accounts (#2139), never an
  // independent trust signal on its own. Honoring it regardless of author
  // login (as an earlier revision of #2139 did) let an untrusted account's
  // stamped `**Accepted**`/`**Rejected**` reply satisfy this gate (#3244).
  // The stamp therefore only ever narrows who counts as an IDD disposition
  // author -- it can never widen `dispositionAuthorPredicate` -- so honoring
  // it is folded into that same predicate check below rather than kept as a
  // separate, author-blind fallback.
  const dispositionAuthorPredicate =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const comments = thread.comments?.nodes ?? [];
  // A resolved thread may be terminally dispositioned with the documented
  // `**Rejection confirmed by maintainer**` marker instead of a fresh
  // `**Rejected**` re-post; recognize it as a disposition ONLY when the thread
  // is resolved (an unresolved thread still needs an explicit disposition).
  const threadResolved = Boolean(thread.isResolved);
  const isDisposition = (comment: { body?: string | null }): boolean =>
    isDispositionComment(comment) ||
    (threadResolved && isRejectionConfirmedDisposition(comment));
  const isIddDisposition = (comment: ThreadCommentLike): boolean => {
    if (!isDisposition(comment)) {
      return false;
    }
    // #3249: an edited (or edit-state-unresolved) disposition reply never
    // counts as a fresh disposition -- it falls through to the
    // `latestFeedbackAt` computation below as ordinary external feedback
    // instead (the existing `!isIddDisposition(comment)` filter there
    // already does this once this function returns `false` for it; no
    // second mechanism is needed).
    if (classifyCommentEditState(comment) !== 'unedited') {
      return false;
    }
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    return dispositionAuthorPredicate(authorLogin);
  };
  const latestFeedbackAt = maxIsoTimestamp(
    comments
      .filter((comment) => !isIddDisposition(comment))
      .map((comment) =>
        effectiveThreadCommentActivityAt(comment, advisoryBotLogins),
      )
      .filter(isValidIsoTimestamp),
  );

  return comments.some((comment) => {
    if (!isIddDisposition(comment)) {
      return false;
    }
    const dispositionActivityAt = effectiveThreadCommentActivityAt(
      comment,
      advisoryBotLogins,
    );
    if (!isValidIsoTimestamp(dispositionActivityAt)) {
      return false;
    }
    return (
      !latestFeedbackAt ||
      compareIsoTimestamps(dispositionActivityAt, latestFeedbackAt) > 0
    );
  });
}

/**
 * #3269: for each thread, finds the maximum content-activity timestamp
 * among comments `hasFreshDisposition` would accept as a disposition on
 * it (the SAME recognition: `isDispositionComment`, or -- only on an
 * already-resolved thread -- the terminal `isRejectionConfirmedDisposition`
 * marker, authored by `isDispositionAuthor`), then returns the GraphQL
 * node id of every thread comment that is authored by a configured
 * advisory bot, reports a parseable `lastEditedAt`
 * (`classifyCommentEditState` === `'edited'`), and whose `lastEditedAt`
 * postdates that thread's own disposition anchor.
 *
 * The two merge-gate collectors (`pre-merge-readiness.mts`'s F2 evidence
 * collector, `advisory-convergence.mts`'s required-check collector) call
 * this BEFORE `hasFreshDisposition`/`summarizeDispositionEvidenceForGate`
 * itself, to build the bounded candidate list for
 * `ProviderPort.getReviewThreadCommentUserContentEdits` (its own doc
 * comment has the fetch's full contract), then thread the result through
 * {@link attachReviewThreadCommentEditHistories} before calling either.
 * A thread with no recognized disposition at all contributes no
 * candidates: nothing yet anchors "after the disposition" for it, and
 * `hasFreshDisposition` will report it missing regardless of how any
 * individual comment is dated.
 *
 * `isDispositionAuthor` defaults to `hasFreshDisposition`'s own default
 * (reject known bots, accept any human). A caller SHOULD pass the SAME
 * predicate it will later pass to `hasFreshDisposition`/
 * `summarizeDispositionEvidenceForGate` for this same evaluation, or
 * candidate selection and freshness evaluation can disagree about which
 * comment anchors "the disposition".
 */
export function selectAdvisoryThreadCommentIdsEditedAfterDisposition(
  threads: ThreadLike[],
  options: {
    isDispositionAuthor?: (login: string) => boolean;
    advisoryBotLogins?: unknown[] | null;
  } = {},
): string[] {
  const dispositionAuthorPredicate =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const ids = new Set<string>();
  for (const thread of threads ?? []) {
    const nodes = thread.comments?.nodes ?? [];
    const threadResolved = Boolean(thread.isResolved);
    const isDisposition = (comment: { body?: string | null }): boolean =>
      isDispositionComment(comment) ||
      (threadResolved && isRejectionConfirmedDisposition(comment));
    const dispositionAt = maxIsoTimestamp(
      nodes
        .filter((comment) => {
          if (!isDisposition(comment)) {
            return false;
          }
          const authorLogin = String(comment.author?.login ?? '')
            .trim()
            .toLowerCase();
          return dispositionAuthorPredicate(authorLogin);
        })
        // Dating the disposition comment itself never needs cosmetic-edit
        // verification -- it is IDD-agent/human-authored, never a
        // configured advisory bot -- so an empty advisoryBotLogins set
        // here (this file's own default) is deliberate and safe.
        .map((comment) => effectiveThreadCommentActivityAt(comment))
        .filter(isValidIsoTimestamp),
    );
    if (!dispositionAt) {
      continue;
    }
    for (const comment of nodes) {
      const authorLogin = String(comment.author?.login ?? '')
        .trim()
        .toLowerCase();
      if (!isConfiguredAdvisoryBotLogin(authorLogin, advisoryBotLogins)) {
        continue;
      }
      if (classifyCommentEditState(comment) !== 'edited') {
        continue;
      }
      const lastEditedAt = String(
        comment.lastEditedAt ?? comment.last_edited_at ?? '',
      );
      if (!isValidIsoTimestamp(lastEditedAt)) {
        continue;
      }
      if (compareIsoTimestamps(lastEditedAt, dispositionAt) <= 0) {
        continue;
      }
      const id = String(comment.id ?? '').trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * #3269: pure enrichment step -- returns a NEW `threads` array where each
 * thread comment whose id matches an entry in `histories` (by
 * `commentId`) carries that entry's `userContentEdits`. A comment with no
 * matching entry, or a thread with no matching comment, is returned
 * UNCHANGED (same object identity), so a caller can cheaply tell whether
 * anything changed. The two merge-gate collectors call this with the
 * result of `ProviderPort.getReviewThreadCommentUserContentEdits`, keyed
 * on the SAME node ids
 * {@link selectAdvisoryThreadCommentIdsEditedAfterDisposition} returned.
 */
export function attachReviewThreadCommentEditHistories(
  threads: ThreadLike[],
  histories: ReviewThreadCommentEditHistoryLike[] | null | undefined,
): ThreadLike[] {
  const byId = new Map<string, ReviewThreadCommentEditHistoryLike>();
  for (const history of histories ?? []) {
    const id = String(history?.commentId ?? '').trim();
    if (id) {
      byId.set(id, history);
    }
  }
  if (byId.size === 0) {
    return threads;
  }
  // `Array.prototype.map` always allocates a new OUTER array, even when
  // every element it returns is unchanged -- `byId` being non-empty does
  // not by itself mean any `threads` comment actually matched one of its
  // ids (e.g. every requested id came back with no matching comment).
  // Track that explicitly so a genuinely-no-op call (matching the
  // `byId.size === 0` short-circuit just above) still returns `threads`
  // by the SAME reference, honoring this function's own doc comment.
  let anyChanged = false;
  const nextThreads = threads.map((thread) => {
    const nodes = thread.comments?.nodes ?? [];
    if (nodes.length === 0) {
      return thread;
    }
    let changed = false;
    const nextNodes = nodes.map((comment) => {
      const id = String(comment.id ?? '').trim();
      const history = id ? byId.get(id) : undefined;
      if (!history) {
        return comment;
      }
      changed = true;
      return {
        ...comment,
        userContentEdits: {
          totalCount:
            typeof history.totalCount === 'number' ? history.totalCount : 0,
          edits: (history.edits ?? []).map((edit) => ({
            editedAt: edit?.editedAt ?? null,
            diff: edit?.diff ?? null,
            editorLogin: edit?.editorLogin ?? null,
            deletedAt: edit?.deletedAt ?? null,
          })),
        },
      };
    });
    if (!changed) {
      return thread;
    }
    anyChanged = true;
    return {
      ...thread,
      comments: {
        pageInfo: thread.comments?.pageInfo,
        nodes: nextNodes,
      },
    };
  });
  return anyChanged ? nextThreads : threads;
}

// A disposition marker may carry a single interior punctuation char `[.!:]`
// immediately before the closing `**` — `**Accepted.**` (natural English
// "Accepted. Fixed in…"), `**Accepted:**`, `**Accepted!**`, and the `Rejected`
// equivalents — so a reply that punctuates the marker is still recognized. The
// tolerance is bounded to that one char before `**`, so an interior-text body
// like `**Accepted by reviewer, but…**` is NOT matched (fail-closed: a false
// positive is a false merge). Start-anchored (`^`), so the marker must be the
// first bytes of the body each caller passes: `isDispositionComment` uses
// `trimEnd()` only, so leading whitespace is NOT stripped (preserving the
// marker-first-bytes contract), while the notice / summary predicates below
// `trimStart()` first.
//
// Exported (kurone-kito/idd-skill#3223) so copilot-review-wave-audit.mts can
// classify a review-comment reply's disposition using the exact same
// gate-credited marker shape `isDispositionComment` checks, rather than the
// stricter, em-dash-requiring MARKER_ACCEPTED_RE/MARKER_REJECTED_RE in
// review-disposition-verify.mts's `classifyMarker` (which are designed for a
// different, gate-authority use).
export const DISPOSITION_ACCEPTED_PREFIX_RE = /^\*\*Accepted[.!:]?\*\*/;
export const DISPOSITION_REJECTED_PREFIX_RE = /^\*\*Rejected[.!:]?\*\*/;

// #2249: loose "close but not exact" detector for `missingRegularComments[].hint`
// (`MALFORMED_DISPOSITION_PREFIX_HINT`) -- deliberately laxer than the two
// exact-match regexes above, matching only the four literal prefixes a
// near-miss reply typically starts with: bare `Accepted`/`Rejected`
// (no bold markdown) or `**Accepted`/`**Rejected` (bold markdown present
// but the marker still fails `isDispositionComment`, e.g. interior text
// before the closing `**`). The leading `**` is optional but must be
// exactly zero or two chars (not one, e.g. `*Accepted`), and the
// trailing `\b` stops a longer word like `Acceptedness` from matching --
// Copilot review on PR #2383 caught both gaps in an earlier draft.
// Always paired with `!isDispositionComment` at each call site so an
// already-valid disposition never matches.
const MALFORMED_DISPOSITION_PREFIX_RE = /^(?:\*\*)?(?:Accepted|Rejected)\b/;

export function isDispositionComment(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimEnd();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) ||
    DISPOSITION_REJECTED_PREFIX_RE.test(body)
  );
}

// Terminal AMD-rejection marker. When a maintainer agrees with a rejection the
// agent replies `**Rejection confirmed by maintainer** — {summary}` and resolves
// the thread, with no separate `**Rejected**` re-post (per
// idd-review-triage.instructions.md). Mirrors the regex in
// review-disposition-verify so the F2/F3 gate recognizes the same marker.
const REJECTION_CONFIRMED_BY_MAINTAINER_RE =
  /^\*\*Rejection confirmed by maintainer\*\*\s+—/;

export function isRejectionConfirmedDisposition(comment: {
  body?: string | null;
}): boolean {
  return REJECTION_CONFIRMED_BY_MAINTAINER_RE.test(
    (comment.body ?? '').trimStart(),
  );
}

// audit:ignore-dead-export: pending #3341's own delete decision for this export; do not duplicate that fix here
export function isIddDispositionComment(comment: CommentLike): boolean {
  const author = comment.author?.login ?? '';
  return isDispositionComment(comment) && !isKnownReviewBot(author);
}

// #1018 non-review-notice carry-forward classifiers.
//
// An advisory **non-review notice** — an advisory bot reporting it did not
// review the current HEAD (rate-limit / usage-quota exhaustion / review-limit) —
// carries no review result and is always dispositioned `**Rejected** — {bot} did
// not review HEAD …` per the E6 non-review-notice rule. The gate uses the two
// tight, fail-closed predicates below to let such a disposition carry forward
// across HEAD changes (see `summarizeDispositionEvidenceForGate`), so a Codex
// `updatedAt` bump or a re-posted CodeRabbit rate-limit summary does not re-flag
// `missing-disposition-evidence` for a notice the agent already rejected.
//
// Both intentionally **under-match**: an unrecognized notice merely keeps the
// existing per-push re-disposition churn (safe), while a false positive could
// carry a stale disposition onto a real review (a false merge). Only
// machine-generated, bot-specific signals match, and the notice predicate is
// evaluated solely on advisory-bot-authored comments at the gate, so a human
// reviewer comment is never reclassified as a notice.
const ADVISORY_NON_REVIEW_NOTICE_PATTERNS: RegExp[] = [
  // CodeRabbit rate-limit notice: the machine-generated marker (distinct from
  // the `summarize by coderabbit.ai` review marker) and its warning heading.
  /<!--\s*This is an auto-generated comment:\s*rate limited by coderabbit\.ai\s*-->/i,
  /^[>\s]*#{1,6}\s*Review limit reached\b/im,
  // #2161: CodeRabbit skip-review notice, nested inside the same outer
  // `summarize by coderabbit.ai` wrapper as a genuine walkthrough (see
  // CODERABBIT_SKIP_REVIEW_MARKER above) -- carries no review content even
  // though the outer wrapper alone cannot tell it apart from a real summary.
  CODERABBIT_SKIP_REVIEW_MARKER_RE,
  // #3260: CodeRabbit's paused-review marker ("Reviews paused") -- like the
  // skip-review notice above, it will not review new commits until someone
  // resumes it, so it is a terminal decline rather than a completed review.
  CODERABBIT_REVIEW_PAUSED_MARKER_RE,
];

// #2641: CodeRabbit's own courtesy-acknowledgment reply shape, mirroring
// the notice patterns above (real observed structure, not an invented
// template). Derived from this repository's own merged-PR review-thread
// history: 18/18 sampled CodeRabbit replies that followed an existing
// disposition on a resolved thread were confirmation-only (agreeing with
// or withdrawing the finding, never a new substantive concern), and all 18
// shared both structural signals below (a false positive here could carry
// a stale disposition onto a real review -- a false merge, so this
// deliberately under-matches like the notice patterns above).
//
// Opening: an `` `@{login}` `` mention immediately followed by a
// confirmation/dismissal verb -- the consistent lead-in across every
// sampled reply (e.g. "`@kurone-kito`, confirmed. ...",
// "`@kurone-kito` Thanks for the fix. ...", "`@kurone-kito`, agreed. ...",
// "`@kurone-kito`, acknowledged. ..." -- kurone-kito/idd-skill#2657, PR
// #2895 round 17: a freshly observed CodeRabbit reply used this verb,
// which the original 18-sample derivation never happened to include;
// added as one more member of the SAME already-covered class (a
// confirmation/dismissal opener), not a new open-ended category).
// An optional leading `CODERABBIT_AUTO_GENERATED_REPLY_MARKER` is tolerated
// before the mention (Copilot review, #2649): CodeRabbit's other marker-led
// reply form (`classifyRegularBotComment`'s stale review-trigger check
// above) places the marker first, so a courtesy ack using the same
// ordering must not be missed just because `^` otherwise anchors on the
// mention.
const CODERABBIT_ACK_OPENING_RE = new RegExp(
  `^(?:${escapeRegExp(CODERABBIT_AUTO_GENERATED_REPLY_MARKER)}\\s*)?` +
    '`@[\\w.-]+`[,:]?\\s+(?:thanks?(?:\\s+you)?|confirmed|agreed|acknowledged)\\b',
  'i',
);

// Closure (Codex review, PR #2649, round 3): matching the opening plus ANY
// CodeRabbit-generated text -- an auto-generated-reply marker, a skip
// marker, even the bare 🐇 emoji -- is not enough. All of those mark "this
// reply came from CodeRabbit," not "CodeRabbit is done with this finding":
// the bare auto-generated-reply marker alone also appears on 19/48 of
// CodeRabbit's *initial* (non-ack) findings in the same sample. An
// enumerated blocklist of "new concern" phrasing (tried and reverted here)
// is a losing battle -- natural language has unbounded ways to raise a
// concern, as two rounds of adversarial review examples demonstrated.
//
// What IS a reliable signal: CodeRabbit only attempts (or reports failing)
// to mark the review thread itself resolved when it considers the finding
// closed. It never does this on a reply that raises a new concern. This is
// CodeRabbit's own resolution DECISION, not a fingerprint of its output
// format -- exactly the "complete known acknowledgment template" the
// original issue asked for, not a fragment of one. Matches either of the
// two closure forms observed across all 18 sampled trailing acks: "✅
// Review thread resolved." (the thread-resolve API call succeeded) or its
// "I couldn't resolve this review thread on the repository platform..."
// fallback trailer (the same API call failed, so CodeRabbit reports the
// attempt instead).
//
// #2858: a THIRD, weaker-in-kind shape -- observed on
// kurone-kito/idd-skill#2853's review thread on the issue-reference
// template link (2 samples from that one already-agent-resolved thread,
// not the 18/18 sample above): "...addresses the template
// link-resolution concern." /
// "...addresses the template issue-reference finding." Unlike the two
// forms above, this is prose describing an outcome, not CodeRabbit's own
// resolve-attempt decision: CodeRabbit never attempted (or reported
// failing) to resolve this thread, because it was already resolved
// independently (e.g. by the IDD agent's own resolve-review-thread.mjs)
// before CodeRabbit replied, so it had no attempt of its own to report.
// Kept as its own regex (`CODERABBIT_ACK_ADDRESSES_CLOSURE_RE`, below,
// tested only after the two strong forms above fail) rather than folded
// into one `|`-alternation, specifically so its own guards -- narrowed
// across three rounds of Codex/Copilot review on this same PR (#2858,
// PR #2868) -- never apply to the two strong, structurally-safe forms:
//
// #2927: a FOURTH shape, weaker-in-kind the same way -- "The fix
// matches the requested behavior." rather than "addresses the ...
// concern/finding" -- documented separately, below the lead-in
// whitelist, as `CODERABBIT_ACK_MATCHES_BEHAVIOR_CLOSURE_RE`, tried
// after this third form in `isKnownAdvisoryAckTemplate` below --
// including when this third form's own regex DOES structurally match
// but that match's own lead-in then fails, not only when this third
// form's regex fails to match at all (Copilot review, #2927, round 2,
// on an earlier revision of this sentence that understated it). Each
// form is checked against its own lead-in independently; see that
// function's own comment for why. Mentioned here only as an index
// pointer so this comment block's forward references stay coherent;
// its own reasoning lives with its own regex, not duplicated into this
// third form's guard history below.
//
// Guard history below reflects the CURRENT implementation as of round 7
// (Codex/CodeRabbit review on PR #2868) -- Copilot's round-8 review
// flagged an earlier revision of this comment block for still describing
// the pre-round-7 `{0,80}`/`[^.!?]` mechanism after the code had already
// moved on, which is exactly the kind of drift this file's own extensive
// documentation is meant to prevent. Each guard below states what it
// does NOW, with the specific round/finding that shaped it for
// traceability, not a literal transcript of an earlier regex.
//
// 1. **Locality bound, tokenized** (originally a `{0,80}` character
//    count; replaced by a `{0,3}` modifier-TOKEN count, round 7, Codex):
//    the gap between "addresses the" and "concern"/"finding" is capped
//    so an incidental "concern"/"finding" mention far away in the same
//    reply's trailing Learnings-used block can't retroactively create a
//    false closure signal. Both real observed replies use a 2-token
//    noun-phrase modifier ("template link-resolution", "template
//    issue-reference"); the cap allows one token of headroom beyond
//    that, since a coherent conjunction-based topic change realistically
//    needs 4+ words (round 7's own adversarial example needed 5).
// 2. **Word/hyphen-only tokens, no sentence-boundary or comma crossing**
//    (originally `[^.!?]` exclusion, round 1, Codex; superseded by the
//    `[\w-]+` token grammar, round 7): restricting each gap token to
//    word and hyphen characters, separated only by whitespace, means
//    neither a comma nor a sentence terminator (`.`/`!`/`?`) can appear
//    inside the gap at all -- either one breaks the token chain outright.
//    This subsumes the original round-1 finding ("This addresses the
//    requested change. However, I still have a concern." must not reach
//    the second sentence's "concern") without a separate exclusion rule.
// 3. **Mandatory boilerplate tail, no bare end-of-body fallback**
//    (round 1, Codex; tail shape fully anchored to end-of-body, round 6,
//    Codex): the closure sentence must end in a period immediately
//    followed by the complete recognized boilerplate shape (see
//    `CODERABBIT_ACK_CLOSURE_TAIL_SOURCE` below), not merely start with
//    one of its markers. Every sampled reply (all 21: the original 18,
//    these 2, plus #2927's own sample below) carries real trailing
//    boilerplate, so requiring it
//    unconditionally costs no real match; this also rejects a single-
//    sentence reply with nothing following it at all, such as "`@user`,
//    confirmed. This partially addresses the concern." with no footer --
//    a hedged, non-committal acknowledgment that would otherwise pass on
//    structure alone.
// 4. **No backtracking past an earlier same-sentence "concern"/"finding"**
//    (round 3, Codex; largely a consequence of guards 1-2's token
//    grammar rather than a separate per-character lookahead, but not
//    unconditionally so -- see the precise bound stated below): "`@user`,
//    confirmed. This addresses the original concern but reveals another
//    finding.\n\n🐇 ✓" has a genuinely new finding joined by "but" in the
//    SAME sentence. Reaching the later "finding" would require consuming
//    "concern", "but", and "reveals" as modifier tokens first -- 3 tokens
//    before even reaching "another finding", already past the `{0,3}`
//    cap guard 1 enforces -- so no valid parse reaches the second
//    occurrence; the match fails at the first "concern" instead, exactly
//    as guard 3's tail check requires. This holds whenever reaching the
//    second occurrence needs MORE than 3 modifier tokens; a short,
//    non-contrastive conjunctive bridge can still consume an earlier
//    occurrence as a plain token within budget and reach a second one --
//    "addresses the concern and finding.\n\n🐇 ✓" matches by treating
//    "concern" as modifier-token #1 (self-critique, E2 pass on this PR).
//    Not treated as a precision bug: "X addresses the concern and
//    finding" reads as a benign compound object (both were addressed),
//    not a hidden new concern, unlike the "but"-joined case above.
// 5. **Hedge-adverb guard, both before "addresses" and inside the gap**
//    (round 2, Codex; scoping fixed round 3, Copilot; extended into the
//    gap itself, round 7, Codex): "`@user`, confirmed. This partially
//    addresses the concern.\n\n🐇 ✓" has genuine boilerplate immediately
//    following, crosses no sentence boundary, and "concern" is the first
//    and only candidate, so guards 1-4 don't catch it. A small, closed
//    set of English degree adverbs immediately before "addresses" -- the
//    same narrow-enumeration style `CODERABBIT_ACK_OPENING_RE` already
//    uses for its own confirmation verbs (thanks/confirmed/agreed) -- is
//    materially different from the open-ended "new concern" blocklist
//    already tried and reverted above: that attempt tried to recognize
//    arbitrarily-phrased new substantive content (unbounded), while this
//    is a small, well-known closed class of adverbs modifying
//    "addresses" itself. Implemented as a negative lookbehind directly on
//    this alternative (not a separate whole-body check) so it can never
//    reject the two strong forms merely because unrelated hedge-shaped
//    wording happens to appear elsewhere in the same reply's boilerplate
//    (e.g. a Learnings-used block quoting a past PR's discussion) --
//    Copilot's round-3 finding on the round-2 fix. Round 7 additionally
//    checks each gap token against the same enumeration, since a hedge
//    word can also hide INSIDE the gap ("addresses the partially
//    resolved concern") where the lookbehind never looks. Given this
//    repository's `fully_autonomous_merge` policy (AGENTS.md), a hedged
//    "addresses" is exactly the shape most likely to hide real
//    outstanding feedback behind an ack-shaped reply, so closing this
//    demonstrated case outweighs leaving it as stated residual risk the
//    way the new-concern class above still is.
//
// Residual risk, stated rather than papered over -- NOT the same class as
// the two strong forms: those report CodeRabbit's own resolve-attempt
// DECISION, which by this file's own reasoning cannot co-occur with a new
// substantive concern in the same reply. This third form reads prose with
// no such structural barrier, so it is strictly weaker. Two residual gaps
// remain, both raised as a design question on issue #2858 rather than
// chased further here:
//
// (a) **Contrastive/evaluative adjectives within the `{0,3}` token
//     window** (Codex round 8, PR #2868): degree adverbs (guard 5) are a
//     closed, enumerable class -- English has roughly a dozen. A
//     CONTRASTIVE adjective is not: "wrong", "different", "other",
//     "unrelated", "remaining", "outstanding", "unaddressed" all read as
//     coherent, grammatically ordinary English inside the gap --
//     "`@user`, thanks. This addresses the wrong security
//     concern.\n\n🐇 ✓" is a coherent sentence stating the fix missed the
//     mark, yet matches structurally. Enumerating this class would be
//     the exact open-ended "new concern" blocklist this file's own
//     history already tried and reverted (guard 5's comment above); it
//     is not the same shape as a short, closed adverb list. This is the
//     third form's irreducible limit for recognizing a prose closure via
//     structure rather than genuine language understanding, not a gap
//     guards 1-5 failed to close. Both real observed samples use plain
//     noun-attributive modifiers naming the topic ("template",
//     "link-resolution"), never an evaluative adjective -- no sampled
//     reply has used this shape to hide misclassified feedback.
// (b) The `<details>` block's interior (see
//     `CODERABBIT_ACK_CLOSURE_DETAILS_SOURCE` below) is intentionally
//     opaque, quoted text; a concern hidden there rather than as sibling
//     prose would also still misclassify, for the same reason.
const CODERABBIT_ACK_STRONG_CLOSURE_RE =
  /✅\s*Review thread resolved\.|I couldn't resolve this review thread on the repository platform/i;

// Widened to add `almost`/`nearly` (Copilot review, #2927, round 4): a
// proximity adverb -- "close to, but short of, complete" -- is the same
// hedged/non-committal degree semantic this enumeration already covers
// ("partially", "mostly", "largely"), just a different lexical subclass
// (proximity rather than partiality). "`@user`, thanks. The fix almost
// matches the requested behavior.\n\n🐇 ✅" states an explicitly
// INCOMPLETE fix -- the same class of risk guard 5's own reasoning
// already established for this whole enumeration -- and previously
// passed the pre-"matches" lookbehind unnoticed, wired into this shared
// constant so both the third and fourth shapes benefit without
// duplication.
const CODERABBIT_ACK_HEDGE_WORDS_SOURCE =
  'partially|partly|somewhat|mostly|largely|barely|slightly|arguably|almost|nearly|in\\s+part|to\\s+some\\s+extent|not\\s+(?:fully|entirely|completely|really)';

// Sibling enumeration to the degree-adverb list above, for the SAME
// hedged/non-committal semantic class but the ADJECTIVE part of speech
// (self-critique, E2 pass on this PR, PR #2868): the adverb list above
// modifies a VERB ("partially addresses"); a lead-in noun phrase instead
// takes an ADJECTIVE modifying its noun ("The partial workaround
// addresses...", "The temporary fix addresses..."). Grammatically
// distinct from the adverb list, so it is its own enumeration rather
// than folded in, but the SAME bounded philosophy: a small, closed set
// of English words describing partial/provisional completeness -- not
// the open-ended CONTRASTIVE-adjective class (residual gap (a) above,
// "wrong", "different", "unrelated") that states something was done
// incorrectly rather than only partially or temporarily.
const CODERABBIT_ACK_HEDGE_ADJECTIVES_SOURCE =
  'partial|temporary|interim|provisional|tentative|preliminary|stopgap|incomplete';

// A THIRD, semantically distinct closed enumeration (Codex review, PR
// #2868, round 10; widened round 12): hedge words (adverb and adjective
// forms above) say something was done to a DEGREE; negation words say
// it was NOT done at all -- a strictly stronger, more severe inversion,
// not a variant of hedging. "The fix never addresses the security
// concern.\n\n🐇 ✓" matched: "never" sits immediately before "addresses"
// the same way a hedge adverb would, but neither hedge enumeration
// includes it (hedging and negating are different speech acts), so the
// lookbehind below passed it through untouched. English negation
// adverbs occurring directly before a verb are a small, well-known
// closed class -- the same narrow-enumeration standard as the two hedge
// lists above, not the open-ended contrastive-adjective problem
// (residual gap (a)): negation is a grammatical function word category,
// not free descriptive vocabulary. `no\s+longer` is included as a
// two-word negation idiom; `barely` is deliberately NOT duplicated here
// since it is already in the hedge-adverb list above (a "small degree,"
// not "zero," semantic). Round 12 (Codex) found the initial enumeration
// still omitted `seldom` (a negative-frequency adverb, the same class as
// `rarely`/`hardly`); widened the same pass to also cover the two
// negation IDIOMS `in\s+no\s+way` and `by\s+no\s+means`, completing the
// small set of common English negation function words/idioms rather
// than waiting for each to surface as its own review round -- see the
// closing statement below `CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE` for
// where further membership widening of this closed class belongs.
const CODERABBIT_ACK_NEGATION_WORDS_SOURCE =
  'never|not|nor|hardly|scarcely|rarely|seldom|no\\s+longer|in\\s+no\\s+way|by\\s+no\\s+means';

// A FOURTH closed enumeration, added proactively in the same pass as the
// round-12 negation widening above rather than waiting for its own
// review round: EPISTEMIC adverbs, which cast doubt on whether a claimed
// action genuinely happened at all, distinct from both hedging (a
// partial degree) and negation (an outright denial). "`@user`,
// confirmed. This supposedly addresses the concern.\n\n🐇 ✓" reads as
// the acknowledgment itself casting doubt on its own claim -- CodeRabbit
// (or a reply mimicking its template) questioning whether the fix
// really works, not confirming that it does. A small, well-known closed
// class of English evidentiality adverbs, the same bounded standard as
// the three enumerations above.
//
// **Closing statement for this whole family of enumerations**: degree
// (hedge), adjectival-degree, negation, and epistemic are the closed
// SEMANTIC function-word classes this guard enumerates, each
// independently motivated by a distinct relationship to the
// acknowledgment ("to what degree," "was it done at all," "should the
// claim itself be trusted"). A fifth, GRAMMATICAL (not semantic) class
// -- coordinating conjunctions -- is enumerated separately below
// (`CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE`) for a structural reason,
// not a meaning-based one. A further member surfacing within one of
// these five existing classes (a synonym for an adverb already covered,
// an idiomatic variant) is a bounded widening, fixed in place the same
// way round 12 fixed `seldom` and round 13 fixed `perhaps`/`possibly`/
// `maybe`/`presumably` below. A genuinely NEW class -- distinct from all
// five, and from the coordinating-conjunction structural fix -- is a
// design question for issue #2858, the same escalation path residual
// gap (a) already used -- not something to keep discovering ad hoc
// inside this PR's review-fix loop.
const CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE =
  'supposedly|allegedly|ostensibly|nominally|purportedly|seemingly|apparently|perhaps|possibly|maybe|presumably';

// A GRAMMATICAL (not semantic) closed class (Codex review, PR #2868,
// round 13): the seven English coordinating conjunctions ("FANBOYS":
// for/and/nor/but/or/yet/so) are excluded from the internal gap's
// modifier tokens, closing a compact variant of the round-7 "but
// reveals another finding" bypass that fits within the `{0,3}` token
// cap: "`@user`, confirmed. This addresses the concern but raises
// concerns.\n\n🐇 ✓" consumes "concern", "but", "raises" as three
// modifier tokens (all within budget, unlike round 7's 5-token example)
// and reaches the second, plural "concerns" as the closure target.
// Tightening the token CAP further cannot close this in general: real
// samples already need up to 2 tokens, and a 2-token variant of the same
// bypass exists ("concern yet concerns"), so no finite cap excludes the
// attack while still admitting real noun phrases. Excluding coordinating
// conjunctions specifically is the right bound instead, because English
// has EXACTLY seven of them -- a closed set fixed by the language's
// grammar, not an open-ended vocabulary list -- and a genuine noun-phrase
// modifier never needs one (neither real observed sample does).
const CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE = 'for|and|nor|but|or|yet|so';

// CodeRabbit review, PR #2868, round 4: two mechanical bypasses in the
// pattern below, both closed by widening two sub-patterns from singular-
// only to also accept the plural/multi-space form, exactly the same
// narrow-enumeration style as every other guard here:
// 1. The gap's negative lookahead and the final anchor only recognized
//    the SINGULAR "concern"/"finding". A plural first occurrence
//    ("concerns"/"findings") does not satisfy `\b(?:concern|finding)\b`
//    (no word boundary between "concern" and its trailing "s"), so the
//    lookahead's `(?!...)` trivially succeeds there and the engine keeps
//    consuming characters as if no candidate occurrence existed --
//    resurfacing guard 4's own "backtrack past the first occurrence"
//    class of bug, but for plural nouns specifically. Both sub-patterns
//    now accept an optional trailing "s".
// 2. The hedge lookbehind ended in a single `\s`, so "partially  addresses"
//    (two spaces) fell outside the lookbehind's fixed one-character gap
//    and bypassed the guard entirely. Widened to `\s+`; V8's lookbehind
//    supports variable-length alternatives (confirmed empirically on
//    this exact Node floor after Copilot's round-5 finding to the
//    contrary was rejected, above), so this is a safe, narrow widening.
//
// Tail grammar, anchored to end-of-body (Codex review, PR #2868, round 6):
// the boilerplate-tail alternation used to validate only the FIRST
// recognized token (`🐇`, `---`, `<details`, `<!--`, or
// `_You are interacting`) and accept whatever followed unexamined --
// itself a prefix match, the same "validated a fragment, not the whole
// shape" bug rounds 4-5 already closed on the opening side. Demonstrated:
// "`@user`, confirmed. This addresses the wording concern.\n\n---\n\n
// However, the null-check remains unresolved." matched, because "---"
// satisfies the alternation even though genuine new feedback follows it.
// Every one of the four alternatives had the same flaw.
//
// Fixed by replacing the prefix alternation with the fixed-order,
// fully-optional tail grammar the two real observed samples
// (kurone-kito/idd-skill#2853) actually have -- sign-off, then a
// `---`-delimited `<details>...</details>` block (the Learnings-used
// container; its interior is opaque quoted text and is NOT re-validated,
// see residual risk below), then the AI-system disclaimer, then the
// auto-generated-reply marker (single-sourced via
// `CODERABBIT_AUTO_GENERATED_REPLY_MARKER` so it cannot drift from
// `CODERABBIT_ACK_OPENING_RE`'s own use of the same literal) -- anchored
// to `$` so nothing can follow any of them unexamined.
//
// Residual risk, stated rather than papered over: the `<details>` block's
// interior is intentionally NOT validated -- real templates quote
// arbitrary past-PR text there (see the two real fixtures below), so
// requiring it to match a known shape is not feasible. A genuinely new
// concern hidden INSIDE a collapsed Learnings-used block, rather than as
// plain sibling prose, would still misclassify. This is a structural
// container CodeRabbit uses for inert quotation, not a shape any sampled
// reply has used to hide substantive feedback -- the same "no sampled
// reply has done this" standard the hedge-adverb guard's own residual
// risk above already applies.
//
// Note on the four-branch alternation below: each of the four elements
// (sign-off, details block, disclaimer, marker) is individually optional
// -- no single one is present in every sample -- but making all four
// optional independently would let an empty tail (nothing at all after
// the closure period) match too, reopening exactly the "hedged reply with
// no footer" gap guard 3 already closed. The alternation instead
// enumerates the four valid ENTRY points (start at the sign-off, or skip
// straight to the details block, or the disclaimer, or the bare marker),
// each requiring at least that one element to be genuinely present, with
// everything after it in the fixed real-sample order still optional.
//
// The details block's interior uses the same no-backtrack-past-the-
// first-occurrence technique as guard 4's `concern`/`finding` gap above,
// not a plain lazy `[\s\S]*?`: a lazy quantifier still backtracks FORWARD
// past the first "</details>" to a later one if the rest of the pattern
// fails at the first (regression test added alongside this fix,
// self-caught before this ever reached review) -- a second, unrelated
// details block later in the tail let a lazy match swallow genuine prose
// sandwiched between the two as if it were all one details block's
// content. The per-character negative lookahead forbids consuming past
// the first "</details>" at all, so no such backtrack is possible.
// Widened to also accept the ✅ (U+2705, "white heavy check mark")
// emoji alongside the existing ✓ (U+2713, "check mark") (#2927): the
// fourth ack shape's real observed sample, documented below
// `CODERABBIT_ACK_CLOSURE_LEADIN_RE`, signs off with "🐇 ✅" rather
// than "🐇 ✓" (confirmed byte-exact via the REST comments API, no
// variation selector). Purely additive -- the ✓ alternative, and every
// existing regression sample that uses it, still matches unchanged, so
// this costs nothing against the unchanged-regression requirement
// (AC2, #2927).
const CODERABBIT_ACK_CLOSURE_SIGNOFF_SOURCE = '🐇(?:\\s*(?:✓|✅))?';
const CODERABBIT_ACK_CLOSURE_DETAILS_SOURCE =
  '---\\s*<details>(?:(?!<\\/details>)[\\s\\S])*<\\/details>';
const CODERABBIT_ACK_CLOSURE_DISCLAIMER_SOURCE =
  '_You are interacting with an AI system\\._';
const CODERABBIT_ACK_CLOSURE_MARKER_SOURCE = escapeRegExp(
  CODERABBIT_AUTO_GENERATED_REPLY_MARKER,
);
const CODERABBIT_ACK_CLOSURE_TAIL_SOURCE =
  `(?:${CODERABBIT_ACK_CLOSURE_SIGNOFF_SOURCE}` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_DETAILS_SOURCE})?` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_DISCLAIMER_SOURCE})?` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_MARKER_SOURCE})?` +
  `|${CODERABBIT_ACK_CLOSURE_DETAILS_SOURCE}` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_DISCLAIMER_SOURCE})?` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_MARKER_SOURCE})?` +
  `|${CODERABBIT_ACK_CLOSURE_DISCLAIMER_SOURCE}` +
  `(?:\\s*${CODERABBIT_ACK_CLOSURE_MARKER_SOURCE})?` +
  `|${CODERABBIT_ACK_CLOSURE_MARKER_SOURCE})` +
  '\\s*$';
// Internal gap tokenized, capped at 3 modifier words, hedge words
// excluded per token (Codex review, PR #2868, round 7): the previous
// `(?:(?!\b(?:concerns?|findings?)\b)[^.!?]){0,80}` gap was a NEGATIVE
// bound again -- any non-period, non-concern/finding character was
// allowed, for up to 80 of them -- and Codex demonstrated it accepts a
// coordinating conjunction that silently swaps in a genuinely different,
// unaddressed concern: "confirmed. This addresses the documentation
// issue but leaves a security concern.\n\n🐇 ✓" has only ONE "concern"
// occurrence (so guard 4's no-backtrack protection never engages), and
// it is immediately followed by the required boilerplate, so the old
// gap matched it as a clean acknowledgment even though "but leaves a"
// means the opposite.
//
// Both real observed samples (kurone-kito/idd-skill#2853) show the gap
// is a SHORT, plain noun-phrase modifier with no verbs or conjunctions
// at all: "template link-resolution" and "template issue-reference" (2
// tokens each). The fix flips this gap to the same positive-shape style
// as guard 6's lead-in whitelist: the gap may consist of at most 3
// space-separated `[\w-]+` tokens (one more than either real sample
// needs, since a coherent conjunction-based "flip" needs a verb plus a
// new subject -- realistically 4 or more words -- to read as a genuine
// change of topic; Codex's own example needs 5). Restricting tokens to
// `[\w-]+` also subsumes guards 2 and 4 for free: neither a comma nor a
// sentence-terminating `.`/`!`/`?` is a word character or whitespace, so
// either one breaks the token chain outright, and reaching a SECOND,
// later "concern"/"finding" now requires consuming more modifier tokens
// than the cap allows (verified against round 3's own "addresses the
// original concern but reveals another finding" fixture below, still
// rejected under the new grammar with no separate backtrack guard
// needed).
//
// Each token is additionally checked against the same closed hedge-word
// enumeration as the lookbehind below, via a per-token negative
// lookahead: without this, "addresses the partially resolved concern"
// would let a hedge word hide INSIDE the gap rather than immediately
// before "addresses", bypassing the lookbehind (which only inspects the
// text immediately preceding "addresses") entirely.
//
// Residual risk, stated rather than papered over, the same standard as
// every guard above -- and corrected here after an earlier revision of
// this paragraph understated it (Codex round 8, PR #2868, below): within
// the 3-token cap, the token content itself is not semantically
// restricted beyond the closed hedge-adverb enumeration. This is not
// limited to ungrammatical "word salad" like "addresses the concern
// finding." -- a CONTRASTIVE adjective reads as perfectly ordinary
// English while still meaning the opposite of an acknowledgment:
// "addresses the wrong security concern" is coherent and structurally
// matches. See residual gap (a) in the comment above
// `CODERABBIT_ACK_STRONG_CLOSURE_RE` for why this class (contrastive
// adjectives: "wrong", "different", "unrelated", "remaining", and
// similar) is NOT enumerable the way the degree-adverb hedge list is,
// and is raised as a design question on issue #2858 rather than chased
// with an open-ended list here.
const CODERABBIT_ACK_ADDRESSES_CLOSURE_RE = new RegExp(
  `(?<!\\b(?:${CODERABBIT_ACK_HEDGE_WORDS_SOURCE}|${CODERABBIT_ACK_NEGATION_WORDS_SOURCE}|${CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE})\\s+)` +
    '\\baddresses\\s+the\\b' +
    `(?:\\s+(?!(?:${CODERABBIT_ACK_HEDGE_WORDS_SOURCE}|${CODERABBIT_ACK_NEGATION_WORDS_SOURCE}|${CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE}|${CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE})\\b)[\\w-]+){0,3}` +
    '\\s+\\b(?:concerns?|findings?)\\b\\.\\s*' +
    CODERABBIT_ACK_CLOSURE_TAIL_SOURCE,
  'i',
);

// Explicit `isCodeRabbitLogin` author check (Copilot review, #2649,
// round 4): the closure phrase is CodeRabbit's own resolution decision in
// practice, but it is still literal text a differently-configured
// advisory bot could in principle also emit. The caller
// (`classifyThreadAckOnlyPostDisposition`) already restricts to
// `isConfiguredAdvisoryBotLogin` (any configured advisory bot, not just
// CodeRabbit), so this check is the cheap, defense-in-depth narrowing
// down to CodeRabbit specifically, on top of (not instead of) the
// content-based signals below. #2641's own research found
// `chatgpt-codex-connector` posted zero post-disposition trailing replies
// across this repository's sampled merged-PR history -- with no observed
// template to derive, it now fails closed both by construction (no
// observed shape) and by this explicit author gate.
//
// Residual risk, stated rather than papered over: CodeRabbit itself
// emitting a closure signal on a reply that is NOT actually a pure
// acknowledgment (a CodeRabbit-side defect) would still misclassify here.
// This helper matches CodeRabbit's own stated decision; it cannot second-
// guess a wrong decision CodeRabbit reports about itself.
//
// 6. **Opening-to-closure lead-in whitelist, scoped to the weaker
//    "addresses the ..." form only** (Codex review, PR #2868, rounds 4
//    and 5): every guard above narrows what counts as a closure WITHIN a
//    matched span, but neither closure regex was ever anchored to where
//    the opening ends -- `.test(body)` searches the WHOLE body, so an
//    entirely separate sentence carrying genuinely new, unresolved
//    feedback between the opening and the closure was invisible to it.
//    Round 4 tried a NEGATIVE bound: at most one sentence terminator
//    (`.`/`!`/`?`) between the opening and the closure match, on the
//    theory that a second terminator means a second, independent
//    sentence sits in between. Round 5 disproved it: natural language
//    can join an unresolved clause to the closure without ANY second
//    terminator at all -- "`@user`, confirmed. The null-check remains
//    unresolved; this update addresses the wording concern.\n\n🐇 ✓"
//    joins with a semicolon and leaves the terminator count at exactly
//    one. An em dash or a bare coordinating conjunction ("and") work
//    the same way. Any guard defined by what the gap must NOT contain is
//    probeable forever against open-ended prose -- guard 5's own
//    reasoning already said so; the round-4 terminator count was the one
//    guard in this file that violated it anyway.
//
//    The fix flips to a POSITIVE whitelist, the same style as
//    `CODERABBIT_ACK_OPENING_RE`'s own closed verb list and guard 5's
//    closed adverb list: instead of asking "does the gap avoid
//    disallowed punctuation," ask "does the gap match one of the small
//    number of lead-in shapes the real observed samples actually use."
//    Both observed samples (kurone-kito/idd-skill#2853, tests above) are
//    a bare, short noun-phrase subject referring back to the fix -- "The
//    repository-qualified reference", "Commit `80c936a7`" -- never a
//    clause with its own verb describing outstanding status.
//    `CODERABBIT_ACK_CLOSURE_LEADIN_RE`, below, requires the ENTIRE gap
//    (the opening's own terminating `.`/`!`, then this lead-in, then
//    nothing else) to match one of: a bare pronoun ("this"/"that"/"it"),
//    "the" plus one or two more words, or "commit" plus a short hex
//    SHA -- deliberately not a free `[^...]` class anywhere.
//
//    This intentionally FAILS CLOSED on any lead-in shape not in the
//    list, including a legitimate one not yet observed: given this
//    repository's `fully_autonomous_merge` policy, an unrecognized
//    lead-in should route to a human-authored disposition rather than
//    risk silently accepting hidden feedback behind an ack-shaped reply.
//    That is the intended failure mode, not a defect to widen away the
//    next time a real reply is rejected -- widen the enumeration
//    (bounded, reviewable) rather than reopening a `[^...]` gap
//    (unbounded, the class of bug this guard exists to close).
//
//    Scoped to `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE` only, not the two
//    strong forms: those report CodeRabbit's own resolve-attempt
//    DECISION, which this file's own reasoning above already treats as
//    unable to co-occur with a new concern in the same reply, so they
//    keep the whole-body `.test()` they always had.
//
// 7. **Hedge words excluded from the lead-in's own noun-phrase tokens
//    too** (self-critique, E2 pass on this PR): guard 5's hedge-adverb
//    enumeration reaches the internal "addresses the ... concern" gap
//    (guard 5 above) but never reached the LEAD-IN's own "the" plus
//    1-2 word slots, since that whitelist was designed purely as a
//    structural check (pronoun / short noun phrase / commit SHA), not a
//    semantic filter. "`@user`, confirmed. The partial workaround
//    addresses the wording concern.\n\n🐇 ✓" matched despite "partial"
//    being exactly the hedged, non-committal shape guard 5 exists to
//    reject elsewhere. Applying the same per-token negative lookahead
//    used in the internal gap closes this location too. Excludes BOTH
//    enumerations (adverb and adjective forms), since a lead-in noun
//    phrase's modifier is grammatically an adjective ("partial",
//    "temporary") even though the internal gap's is an adverb
//    ("partially") -- the first attempt at this fix reused only the
//    adverb list and still let "partial"/"temporary" straight through,
//    caught empirically before this ever reached review.
// 8. **Negation words excluded everywhere a free token or a hedge
//    lookbehind already exists** (Codex review, PR #2868, round 10,
//    widened round 12): hedge words (guards 5 and 7) say something was
//    done to a DEGREE; negation words say it was NOT done at all -- a
//    stronger, more severe inversion, not a hedging variant, so it is
//    its own enumeration (`CODERABBIT_ACK_NEGATION_WORDS_SOURCE` above)
//    rather than folded into either hedge list. "`@user`, confirmed.
//    The fix never addresses the security concern.\n\n🐇 ✓" matched:
//    "never" sits immediately before "addresses" the same way a hedge
//    adverb would, but neither hedge enumeration includes negation
//    words, so every guard passed it through untouched. Round 12 found
//    the initial enumeration still omitted `seldom`; widened in the same
//    pass to also cover `in no way` / `by no means`. Wired into all
//    three locations a hedge check already exists -- the lookbehind
//    immediately before "addresses" (guard 5), the internal gap's
//    per-token exclusion (guard 5), and the lead-in's per-token
//    exclusion (guard 7) -- for the same defense-in-depth reasoning as
//    guard 7's own dual adverb/adjective exclusion above.
// 9. **Epistemic-adverb enumeration, added proactively rather than
//    waiting for a review round** (self-critique, same pass as round
//    12's negation widening; widened round 13):
//    `CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE` above closes a fourth,
//    distinct semantic relationship -- casting doubt on whether the
//    claimed fix genuinely happened at all ("supposedly", "allegedly")
//    -- neither a degree (hedge) nor an outright denial (negation).
//    Wired into the same three locations as guards 5, 7, and 8. Round
//    13 (Codex) found the initial enumeration omitted "perhaps"; widened
//    the same pass to also cover "possibly"/"maybe"/"presumably". See
//    the closing statement in that constant's own doc comment for why
//    this is treated as the natural end of the SEMANTIC enumeration
//    family (guard 10 below is a separate, GRAMMATICAL closed class, not
//    a sixth semantic one).
// 10. **Coordinating-conjunction exclusion, a grammatical rather than
//     semantic closed class** (Codex review, PR #2868, round 13): the
//     `{0,3}` token cap alone cannot close every conjunction-joined
//     bypass, because a COMPACT one fits within budget where round 7's
//     original 5-token example did not -- "confirmed. This addresses
//     the concern but raises concerns.\n\n🐇 ✓" consumes "concern",
//     "but", "raises" as three modifier tokens (within the cap) and
//     reaches the second, plural "concerns" as the closure target.
//     Tightening the cap further cannot close this in general: a
//     2-token variant of the same bypass exists ("concern yet
//     concerns"), and real samples already need up to 2 tokens, so no
//     finite cap excludes the attack while still admitting real noun
//     phrases. `CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE` excludes
//     English's seven coordinating conjunctions ("FANBOYS") instead --
//     a set fixed by the language's grammar, not open-ended vocabulary,
//     so this is not the same class of fix as the semantic
//     enumerations above and does not reopen the open-ended
//     new-concern-blocklist problem. Wired into the internal gap (the
//     demonstrated bypass) and the lead-in (defense-in-depth,
//     consistent with guards 7-9); not the immediate pre-"addresses"
//     lookbehind, since a bare conjunction directly before "addresses"
//     ("confirmed. But addresses...") is not a coherent English
//     sentence in the first place.
const CODERABBIT_ACK_CLOSURE_LEADIN_RE = new RegExp(
  '^[.!]\\s+(?:' +
    'this|that|it|' +
    `the\\s+(?!(?:${CODERABBIT_ACK_HEDGE_WORDS_SOURCE}|${CODERABBIT_ACK_HEDGE_ADJECTIVES_SOURCE}|${CODERABBIT_ACK_NEGATION_WORDS_SOURCE}|${CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE}|${CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE})\\b)[\\w-]+` +
    `(?:\\s+(?!(?:${CODERABBIT_ACK_HEDGE_WORDS_SOURCE}|${CODERABBIT_ACK_HEDGE_ADJECTIVES_SOURCE}|${CODERABBIT_ACK_NEGATION_WORDS_SOURCE}|${CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE}|${CODERABBIT_ACK_CONJUNCTION_WORDS_SOURCE})\\b)[\\w-]+){0,1}|` +
    'commit\\s+`[0-9a-f]{7,40}`' +
    ')\\s+$',
  'i',
);

// #2927: a FOURTH ack shape, observed on kurone-kito/idd-skill#2921's
// review thread `discussion_r3989223825`
// (<https://github.com/kurone-kito/idd-skill/pull/2921#discussion_r3989223825>),
// fetched byte-exact via the pulls/comments REST API (the same
// byte-exact-fixture discipline #2858's own comment above already
// established for its two samples):
//
//   `@kurone-kito`, thanks. The fix matches the requested behavior. The
//   default fixture now uses the permissive zero-parseable-run-ID path.
//
//   🐇 ✅
//
//   _You are interacting with an AI system._
//
//   <!-- This is an auto-generated reply by CodeRabbit -->
//
// Same root cause as the third shape above: this thread was already
// resolved independently (by this repository's own
// resolve-review-thread.mjs) before CodeRabbit replied, so it had no
// resolve-attempt of its own to report -- neither
// `CODERABBIT_ACK_STRONG_CLOSURE_RE` nor
// `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE` match it: no "Review thread
// resolved" trailer, and its verb phrase is "matches the requested
// behavior" rather than "addresses the ... concern/finding".
//
// Structurally SIMPLER than the third shape in one respect: "matches
// the requested behavior" is a fixed, closed phrase with no internal
// noun-phrase gap to police, unlike "addresses the [1-3 modifier
// tokens] concern/finding". Guards 1, 2, 4, and 10 above exist only to
// bound that internal gap, so none of them apply here -- a contrastive
// insertion such as "matches a different requested behavior" (AC3,
// #2927's own contrastive example) simply fails to match the fixed
// phrase at all, rather than needing its own guard.
//
// What DOES transfer, for the identical reason guards 5/8/9 exist on
// the third shape: AC3 (#2927) requires "This partially matches...",
// "This never matches...", and "This supposedly matches..." to still
// read as withheld/uncertain, not confirmed. The same closed hedge/
// negation/epistemic enumerations are reused via an identical negative
// lookbehind immediately before "matches".
//
// A first attempt reused `CODERABBIT_ACK_CLOSURE_LEADIN_RE` unchanged
// for the opening-to-closure gap, on the theory that the real sample's
// lead-in, "The fix", already fits that regex's existing "the" + one-
// word alternative. Copilot review (#2927, round 2) found this reuse
// carries over a pre-existing gap in that shared regex's OWN "the ..."
// branch: it excludes hedge/negation/epistemic words (guard 7) but not
// CONTRASTIVE adjectives, the same residual gap (a) documented above
// `CODERABBIT_ACK_STRONG_CLOSURE_RE` for the third shape's internal
// gap. "`@user`, thanks. The wrong fix matches the requested
// behavior.\n\n🐇 ✅" passes that branch ("the" + "wrong" + "fix", two
// words, within budget) even though "wrong fix" plausibly signals a
// substantive problem. For the third shape this gap was accepted as
// residual risk (no sampled reply has used it); reusing the same
// broad "the" + 1-2 arbitrary words shape here would import that same
// risk into a SECOND caller with no sample-based justification of its
// own. With only ONE real sample and no evidence this shape needs
// anything broader than the exact phrase actually observed,
// `CODERABBIT_ACK_MATCHES_LEADIN_RE` below gives this fourth shape its
// OWN, much narrower lead-in check instead of reusing the shared one:
// a bare pronoun (`this`/`that`/`it`, the same closed, modifier-free
// words the shared regex also uses, so no NEW gap there) or the exact
// literal phrase "the fix" -- not "the" plus any word. This closes the
// contrastive-adjective gap completely for this shape ("the wrong
// fix" no longer matches "the fix" literally) without touching the
// shared regex or the third shape's own established behavior.
//
// New wrinkle this shape introduces: the real sample above has ONE
// more free-text sentence ("The default fixture now uses...") between
// the closure verb phrase and the boilerplate tail. The third shape's
// guard 3 requires the boilerplate immediately after its closure
// sentence, with no bare trailing content allowed at all; reusing that
// requirement unchanged here would reject the real sample and fail AC1
// (#2927).
//
// A first attempt permitted this trailing sentence via a token-capped,
// positive-shape grammar (10 `[\w-]+` tokens, closed-class-excluded,
// determiner-first-token restricted) -- the same STYLE as guard 1's
// internal "addresses the ... concern" gap. Copilot review (#2927)
// correctly rejected this as still too permissive: the grammar's own
// documented residual risk -- a syntactically clean, unhedged,
// determiner-led sentence with no excluded vocabulary, e.g. "The
// null-check still remains unresolved in the other branch." (9 tokens,
// "The" opener, no excluded word) -- structurally satisfies ANY such
// bounded-but-general grammar while stating a genuine new blocker, and
// would suppress the merge gate exactly the way this file's fail-closed
// philosophy exists to prevent. Unlike gap (a) above (contrastive
// adjectives inside an already-narrow noun-phrase slot, genuinely
// irreducible without recreating the open-ended "new concern"
// blocklist), an open determiner-led sentence is not a narrow residual
// edge -- it is most of the risk surface a "positive-shape grammar"
// was supposed to close in the first place. The SAME review also found
// this permissive grammar could absorb the third shape's own "addresses
// the ... concern/finding" vocabulary as innocuous filler, which could
// then interact badly with `isKnownAdvisoryAckTemplate`'s own
// closure-form selection (see that function's own comment for the
// control-flow half of that fix).
//
// With only ONE real observed sample and no broader pattern to derive a
// general grammar FROM, the trailing sentence is instead permitted only
// as an EXACT literal match of that one sample's own continuation text
// -- the same resolution guard 6's lead-in whitelist already applies
// (enumerate the exact observed shape(s), fail closed on everything
// else, widen later only when a new real sample demonstrates a genuine
// second shape) -- rather than a grammar general enough to also accept
// prose no sample has ever produced. This has no residual risk in this
// slot at all (a fixed string cannot admit arbitrary new content), and
// incidentally also closes the cross-shape-vocabulary concern above for
// free: the literal sample text contains neither "addresses" nor
// "concern"/"finding".
const CODERABBIT_ACK_MATCHES_TRAILING_OBSERVED_SENTENCE_SOURCE = escapeRegExp(
  'The default fixture now uses the permissive zero-parseable-run-ID path.',
);
const CODERABBIT_ACK_MATCHES_BEHAVIOR_CLOSURE_RE = new RegExp(
  `(?<!\\b(?:${CODERABBIT_ACK_HEDGE_WORDS_SOURCE}|${CODERABBIT_ACK_NEGATION_WORDS_SOURCE}|${CODERABBIT_ACK_EPISTEMIC_WORDS_SOURCE})\\s+)` +
    '\\bmatches\\s+the\\s+requested\\s+behavior\\b\\.\\s*' +
    `(?:${CODERABBIT_ACK_MATCHES_TRAILING_OBSERVED_SENTENCE_SOURCE}\\s*)?` +
    CODERABBIT_ACK_CLOSURE_TAIL_SOURCE,
  'i',
);

// This fourth shape's own opening-to-closure lead-in check (Copilot
// review, #2927, round 2) -- deliberately NOT `CODERABBIT_ACK_CLOSURE_
// LEADIN_RE`; see the doc comment above `CODERABBIT_ACK_MATCHES_
// BEHAVIOR_CLOSURE_RE` for why reusing that shared regex's broader
// "the" + 1-2 arbitrary words branch would import its known
// contrastive-adjective gap into a second caller with no sample-based
// justification. A bare pronoun or the exact literal phrase "the fix"
// -- the only lead-in actually observed -- and nothing else.
const CODERABBIT_ACK_MATCHES_LEADIN_RE =
  /^[.!]\s+(?:this|that|it|the\s+fix)\s+$/i;

// Exported (kurone-kito/idd-skill#3263) so the bot-comment corpus contract
// test can call this wording classifier directly, the same way it calls
// every other exported classifier in `BOT_WORDING_CLASSIFIERS` below --
// previously module-private, reachable only through
// `classifyThreadAckOnlyPostDisposition`'s own author+shape+snapshot-
// boundary gate, which needs a whole thread fixture rather than a single
// comment body.
export function isKnownAdvisoryAckTemplate(comment: {
  author?: { login?: string | null } | null;
  body?: string | null;
}): boolean {
  const authorLogin = String(comment.author?.login ?? '');
  const body = String(comment.body ?? '');
  if (!authorLogin || !isCodeRabbitLogin(authorLogin) || !body) {
    return false;
  }
  const openingMatch = CODERABBIT_ACK_OPENING_RE.exec(body);
  if (!openingMatch) {
    return false;
  }
  // The two strong forms (CodeRabbit's own resolve-attempt decision) are
  // checked on the whole body with no further guard -- see the comment
  // above `CODERABBIT_ACK_STRONG_CLOSURE_RE` for why the weaker third
  // and fourth forms' guards (locality, sentence-boundary, hedge-adverb,
  // opening-to-closure lead-in whitelist) must never apply here, even
  // when unrelated hedge-shaped wording happens to appear elsewhere in
  // the same reply (e.g. a Learnings-used block).
  if (CODERABBIT_ACK_STRONG_CLOSURE_RE.test(body)) {
    return true;
  }
  // The third (#2858) and fourth (#2927) forms are tried in the order
  // they were introduced, each independently and each against its OWN
  // lead-in check (the third shape's shared `CODERABBIT_ACK_CLOSURE_
  // LEADIN_RE`; the fourth shape's own, narrower `CODERABBIT_ACK_
  // MATCHES_LEADIN_RE` -- see that constant's doc comment for why it is
  // not the shared one). A structural match whose own lead-in fails
  // does NOT disqualify a later form from also being tried, since a
  // lead-in check is a per-match verdict, not a whole-body one.
  // Committing to the first structural match regardless of its own
  // lead-in outcome was a real bug (Copilot review, #2927, round 1): an
  // unrelated `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE` match elsewhere in
  // the body, with its own lead-in failing, used to short-circuit this
  // whole function to `false` without ever trying this fourth shape's
  // own, separately valid, match -- not only when the third shape's
  // regex fails to match at all, contrary to an earlier revision of the
  // index comment above `CODERABBIT_ACK_STRONG_CLOSURE_RE` (Copilot
  // review, #2927, round 2). See the doc comment above `CODERABBIT_ACK_
  // MATCHES_BEHAVIOR_CLOSURE_RE` for why its trailing-sentence slot is
  // ALSO narrowed to an exact literal match rather than relying on this
  // loop fix alone.
  const openingEnd = openingMatch.index + openingMatch[0].length;
  for (const { closureRe, leadinRe } of [
    {
      closureRe: CODERABBIT_ACK_ADDRESSES_CLOSURE_RE,
      leadinRe: CODERABBIT_ACK_CLOSURE_LEADIN_RE,
    },
    {
      closureRe: CODERABBIT_ACK_MATCHES_BEHAVIOR_CLOSURE_RE,
      leadinRe: CODERABBIT_ACK_MATCHES_LEADIN_RE,
    },
  ]) {
    const closureMatch = closureRe.exec(body);
    if (!closureMatch) {
      continue;
    }
    const gapToClosure = body.slice(openingEnd, closureMatch.index);
    if (leadinRe.test(gapToClosure)) {
      return true;
    }
  }
  return false;
}

// Codex usage / quota exhaustion for code reviews. Token-anchored on all
// three of "Codex usage limit(s)", a reach/exceed/hit-family verb, and "for
// code reviews", each tolerant of interposed wording drift, in the two known
// real orderings (#1312: the two prior exact-phrase regexes broke when
// Codex's wording interposed "have been" between "usage limits" and
// "reached"). Requiring "for code reviews" too (not just the verb) keeps the
// match narrow: a bare "Codex usage limits exceeded" mention with no "for
// code reviews" nearby must not match.
const CODEX_USAGE_LIMIT_TOKEN_PATTERN =
  /\b(?:reach|exceed|hit)\w*[\s\S]{0,40}?\bCodex usage limits?\b[\s\S]{0,40}?\bfor code reviews\b|\bCodex usage limits?\b[\s\S]{0,40}?\b(?:reach|exceed|hit)\w*[\s\S]{0,40}?\bfor code reviews\b/i;

// #1326: the token pattern above, by itself, is a structural false positive —
// a genuine review comment that discusses "Codex", a reach/exceed/hit verb,
// and "for code reviews" in ordinary prose (a live risk specifically on PRs
// that touch this detector, as #1319's own review demonstrated) matches it
// too. Tightening the interposed-word gap cannot separate the two cases: the
// words sit just as close together in a real sentence as in the generated
// notice, and no gap bound keeps both known real wordings matching while
// rejecting the false positive (verified empirically while fixing #1326).
//
// Instead, gate the token match on the notice's known SHAPE: a genuine
// Codex/CodeRabbit quota notice is short and is effectively the *entire*
// comment — nothing of substance precedes or follows it (the current wording
// adds one recognizable generated trailer sentence). A genuine review embeds
// the phrase mid-document, with a narrative lead-in, trailing prose, or both.
// Three structural checks apply together, only once the token pattern above
// already matched:
//
// 1. Whole-comment length ≤ CODEX_NOTICE_MAX_LENGTH — defends against a long
//    structured review whose *last* sentence happens to coincidentally
//    match (the longest known real wording — current wording plus its
//    two-sentence trailer, see below — is 199 characters).
// 2. Text before the matched span ≤ CODEX_NOTICE_MAX_PREFIX_LENGTH once
//    trimmed — defends against a narrative lead-in preceding an otherwise
//    bare match (known real prefixes are 0 and 9 characters).
// 3. Text after the matched span is empty/punctuation-only, or matches the
//    tolerant (bounded-gap, token-anchored — not exact-phrase, so a future
//    trailer reword does not reintroduce the #1312 brittleness) generated
//    trailer-continuation pattern below.
//
// This does not achieve perfect semantic disambiguation (a sufficiently
// short human sentence with a trivial lead-in and nothing trailing is
// inherently indistinguishable from the real notice without exact-phrase
// matching, which the #1312 fix deliberately avoids), but it substantially
// narrows the matching surface in the safe direction the block comment above
// already documents: under-match is safe, over-match risks a false merge.
// Anchored to the *entire* trimmed remainder (start `^` through end `$`,
// not a bare substring `.test()`), so "known trailer, then more unrelated
// prose" is still correctly rejected — a substring-only match would let
// extra content after the trailer hide behind a recognized prefix.
//
// Every connector in this pattern (lead-in, inter-sentence, and trailing)
// is bounded to punctuation/whitespace plus, where needed, one specific
// known word — never an arbitrary-content character budget. An earlier
// version of this fix allowed an arbitrary `[\s\S]{0,20}?` lead-in before
// the core trailer tokens (reasoning that the real wording's ". Please "
// connector needed *some* tolerance), but a bounded *character count* still
// admits arbitrary *words* within that budget — a critique pass on this PR
// found that narrative content like "We should " fits the same budget and
// would still reach the trailer tokens. `CODEX_NOTICE_TRAILER_LEAD_IN`
// closes that class by allowing only punctuation/whitespace and the
// literal word "Please" (the only lead-in word in any known real wording),
// so no other word can occupy that position regardless of length.
//
// The live wording observed on this very PR's own Codex review (#1326)
// appends a SECOND administrative sentence after the one #1312 quoted
// ("Credits must be used to enable repository wide code reviews."), so the
// accepted closing shape is two sentences, each independently
// token-anchored and gap-tolerant (not exact-phrase — the same #1312
// wording-drift tolerance applies within each sentence), with the second
// sentence optional so the shorter single-sentence wording still matches.
// SENTENCE_2 anchors the distinctive multi-word phrases "credits must be
// used" and "enable" (not the single generic words "credits" / "repository"
// / "reviews" alone) — matching the same specificity SENTENCE_1 already
// uses, so a comment that merely reuses those individual words near
// SENTENCE_1's exact bot phrasing cannot piggyback a false accept (a gap
// found and closed during this PR's own review-fix rounds).
//
// #1877: a THIRD, structurally distinct wording observed live on PR #1876
// replaces the admin/credits sentence entirely with a dashboard pointer
// ("You can see your limits in the [Codex usage dashboard](url).") — it is
// an alternative closing sentence, not a continuation appended after
// SENTENCE_1/SENTENCE_2, so it is a separate alternation branch
// (SENTENCE_3) rather than a third optional suffix on the admin/credits
// shape. SENTENCE_3 anchors the distinctive multi-word phrase "you can see
// your limits" plus "Codex usage dashboard", with the same bounded,
// gap-tolerant, non-exact-phrase approach as SENTENCE_1/SENTENCE_2. The
// trailing markdown-link close `](url)` is matched structurally (bracket,
// parens, non-`)` URL body) rather than an arbitrary-content character
// budget, and is optional so a future plain-text rendering (no markdown
// link) still matches.
const CODEX_NOTICE_TRAILER_LEAD_IN =
  '[.!,;:\\s]{0,3}(?:\\bPlease\\b[.!,;:\\s]{0,3})?';
const CODEX_NOTICE_TRAILER_SENTENCE_1 =
  '\\bcheck with the admins\\b[\\s\\S]{0,60}?\\bincrease the limits\\b[\\s\\S]{0,60}?\\badding credits\\b';
const CODEX_NOTICE_TRAILER_SENTENCE_2 =
  '\\bcredits must be used\\b[\\s\\S]{0,40}?\\benable\\b[\\s\\S]{0,40}?\\brepository\\b[\\s\\S]{0,40}?\\b(?:code )?reviews?\\b';
const CODEX_NOTICE_TRAILER_SENTENCE_3 =
  '\\byou can see your limits\\b[\\s\\S]{0,60}?\\bCodex usage dashboard\\b(?:\\]\\([^)]*\\))?';
const CODEX_NOTICE_TRAILER_CONTINUATION_PATTERN = new RegExp(
  `^${CODEX_NOTICE_TRAILER_LEAD_IN}(?:${CODEX_NOTICE_TRAILER_SENTENCE_1}(?:[.!,;:\\s]{0,5}${CODEX_NOTICE_TRAILER_SENTENCE_2})?|${CODEX_NOTICE_TRAILER_SENTENCE_3})[.!,;:\\s]*$`,
  'i',
);
const CODEX_NOTICE_MAX_LENGTH = 220;
const CODEX_NOTICE_MAX_PREFIX_LENGTH = 20;
// Anchored to the *entire* trimmed remainder (not a starts-with check), so
// trailing prose that happens to begin with a comma or period is still
// correctly rejected.
const CODEX_NOTICE_SUFFIX_PUNCTUATION_ONLY_RE = /^[.!,;:]*$/;

function isCodexUsageLimitNotice(text: string): boolean {
  if (!text.trim() || text.trim().length > CODEX_NOTICE_MAX_LENGTH) {
    return false;
  }
  const match = CODEX_USAGE_LIMIT_TOKEN_PATTERN.exec(text);
  if (!match) {
    return false;
  }
  const prefix = text.slice(0, match.index).trim();
  if (prefix.length > CODEX_NOTICE_MAX_PREFIX_LENGTH) {
    return false;
  }
  const remainder = text.slice(match.index + match[0].length).trim();
  return (
    remainder === '' ||
    CODEX_NOTICE_SUFFIX_PUNCTUATION_ONLY_RE.test(remainder) ||
    CODEX_NOTICE_TRAILER_CONTINUATION_PATTERN.test(remainder)
  );
}

/**
 * Classify notices that conclusively mean the secondary advisory bot will not
 * review this HEAD. The already-reviewed acknowledgement is intentionally
 * excluded: it is dispositionable non-review activity, but it offers a
 * retryable full-review path (#3146, Copilot/Codex review on PR #3153).
 */
export function isTerminalAdvisoryNonReviewNotice(body: unknown): boolean {
  const text = String(body ?? '');
  if (!text) {
    return false;
  }
  return (
    ADVISORY_NON_REVIEW_NOTICE_PATTERNS.some((pattern) => pattern.test(text)) ||
    isCodexUsageLimitNotice(text) ||
    isCodeRabbitRateLimitedAcknowledgement(body)
  );
}

export function isAdvisoryNonReviewNotice(body: unknown): boolean {
  const text = String(body ?? '');
  return (
    isCodeRabbitAlreadyReviewedAcknowledgement(text) ||
    isTerminalAdvisoryNonReviewNotice(text)
  );
}

// See "Bot-comment wording matchers need a real-sample evidence bar" in
// docs/idd-design-rationale.md for why every wording-based classifier
// below is registered in one place and pinned against a real corpus.

/** A single bot-comment fixture's own login + body -- {@link
 * BOT_WORDING_CLASSIFIERS}' uniform input shape, normalizing each
 * classifier's own distinct call signature (most take a bare body string;
 * {@link isKnownAdvisoryAckTemplate} additionally needs the author login)
 * to one `(fixture) => label` shape. */
export interface BotCommentFixtureInput {
  login: string;
  body: string;
}

/** One registered wording-based bot-comment classifier -- `id` is the
 * stable key the bot-comment corpus (kurone-kito/idd-skill#3263) uses to
 * link each fixture entry to the classifier(s) it exercises, and to name
 * a grandfathered id in the corpus contract test's own pinned exception
 * list when fewer than 3 real samples from 2 distinct PRs exist for it. */
export interface BotWordingClassifierEntry {
  id: string;
  apply: (fixture: BotCommentFixtureInput) => unknown;
}

/**
 * Every wording-based bot-comment classifier this module (and its leaf
 * `copilot-review-body.mts` dependency) exports, registered once so the
 * bot-comment corpus contract test (#3263) can run each fixture entry
 * through the classifier(s) it names without hand-wiring a new import and
 * call for every id. A matcher not registered here is out of the corpus
 * evidence bar entirely -- adding one is a deliberate, reviewable edit to
 * this list, the same visibility the corpus's own grandfather list gets
 * from being test-pinned.
 *
 * `coderabbit-embedded-findings` reports {@link
 * extractCodeRabbitEmbeddedFindings}'s own finding COUNT for the body
 * alone, not {@link countUncoveredCodeRabbitEmbeddedFindings}'s
 * body-minus-already-threaded-comments difference -- that comparison
 * needs a second, non-body input (the PR's already-threaded comment
 * count) with no natural per-fixture source, breaking the uniform
 * one-argument shape every other entry shares.
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
export const BOT_WORDING_CLASSIFIERS: BotWordingClassifierEntry[] = [
  {
    id: 'copilot-review-body',
    apply: (fixture) => classifyCopilotReviewBody(fixture.body),
  },
  {
    id: 'coderabbit-review-in-progress',
    apply: (fixture) => isCodeRabbitReviewInProgressSummary(fixture.body),
  },
  {
    id: 'coderabbit-already-reviewed-ack',
    apply: (fixture) =>
      isCodeRabbitAlreadyReviewedAcknowledgement(fixture.body),
  },
  {
    id: 'coderabbit-rate-limited-ack',
    apply: (fixture) => isCodeRabbitRateLimitedAcknowledgement(fixture.body),
  },
  {
    id: 'coderabbit-courtesy-ack',
    apply: (fixture) =>
      isKnownAdvisoryAckTemplate({
        author: { login: fixture.login },
        body: fixture.body,
      }),
  },
  {
    id: 'coderabbit-embedded-findings',
    apply: (fixture) => extractCodeRabbitEmbeddedFindings(fixture.body).length,
  },
  {
    id: 'advisory-non-review-notice',
    apply: (fixture) => isAdvisoryNonReviewNotice(fixture.body),
  },
  {
    id: 'advisory-terminal-notice',
    apply: (fixture) => isTerminalAdvisoryNonReviewNotice(fixture.body),
  },
];

// A trusted IDD disposition of a non-review notice: the canonical
// `**Rejected** — {bot} did not review HEAD {sha} ({reason}); this is not a
// completed review` reply. Requires the `**Rejected**` prefix (via
// `DISPOSITION_REJECTED_PREFIX_RE`, so the bounded trailing-punctuation variants
// like `**Rejected.**` also count; a notice is always rejected, never accepted)
// and the `did not review HEAD` phrase that names the notice, so an ordinary
// rejection of reviewer feedback is excluded.
export function isNonReviewNoticeDisposition(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_REJECTED_PREFIX_RE.test(body) &&
    /\bdid not review HEAD\b/i.test(body)
  );
}

// #1833 diagnostic-only hint text: single-sourced so
// `summarizeDispositionEvidenceForGate`'s `missingRegularComments[].hint`
// names the exact phrase `isNonReviewNoticeDisposition` requires, instead of
// forcing an agent to source-dive this file to discover it. Never consumed by
// any routing decision -- see the `hint` field's own doc comment on
// `DispositionEvidenceSummary`.
export const NON_REVIEW_NOTICE_DISPOSITION_HINT =
  'disposition reply is missing the required non-review-notice phrase: it ' +
  'must start with "**Rejected**" and match /\\bdid not review HEAD\\b/i -- ' +
  'canonical form: "**Rejected** — {bot} did not review HEAD {sha} ' +
  '({reason}); this is not a completed review"';

// #2249 diagnostic-only hint text, single-sourced like
// `NON_REVIEW_NOTICE_DISPOSITION_HINT` above: names the exact literal
// prefix `isDispositionComment` requires, for the far more common
// plain-text mistake -- a reply written as `Accepted — ...` or
// `Rejected — ...` with no bold markdown at all, so it never satisfies
// `isDispositionComment` even though it is clearly an attempted
// disposition. Never consumed by any routing decision -- see the `hint`
// field's own doc comment on `DispositionEvidenceSummary`.
export const MALFORMED_DISPOSITION_PREFIX_HINT =
  'disposition reply is missing the required literal prefix: it must ' +
  'start with exactly "**Accepted**" or "**Rejected**" (bold markdown, ' +
  'optionally followed by one of . ! : before the closing **) -- a plain ' +
  '"Accepted" / "Rejected" without the bold markdown is not recognized';

// #2491 diagnostic-only hint text, single-sourced like the two hints above:
// unlike those (a MIS-PHRASED disposition attempt), this fires when a
// correctly-phrased disposition already exists but the bot later live-edited
// the SAME comment id in place into a non-review notice, bumping its
// `updatedAt` past the disposition's own timestamp -- so the disposition no
// longer postdates the comment and the comment re-appears as missing with no
// indication a reply was ever posted. Never consumed by any routing decision
// -- see the `hint` field's own doc comment on `DispositionEvidenceSummary`.
export const EDITED_AFTER_DISPOSITION_HINT =
  'comment may have already been dispositioned before the bot live-edited ' +
  'this same comment id into a non-review notice -- if so, that disposition ' +
  'now predates the edit and no longer counts; post a fresh disposition ' +
  'reply in the non-review-notice shape';

// #1122 CodeRabbit summary-walkthrough auto-disposition classifiers.
//
// The CodeRabbit summary walkthrough is a regular comment whose body starts with
// `CODERABBIT_SUMMARY_MARKER`. Unlike a non-review notice it IS a completed
// review, so it is dispositioned `**Accepted**` (never `**Rejected**`). The gate
// scores it through its general updatedAt-aware 1:1 pairing, and CodeRabbit edits
// the summary on each re-review, so the disposition-non-review-notices helper
// re-dispositions the CURRENT summary per HEAD rather than carrying an old
// acceptance forward (a stale carry-forward could mask a finding folded into a
// later summary body — the "a false positive is a false merge" hazard).

// True when a regular comment is a configured advisory bot's review-summary
// comment (CodeRabbit's summary walkthrough, Codex's review-status comment, or
// any future bot in `REVIEW_SUMMARY_MARKERS_BY_BOT_IDENTITY`). Detection is
// start-anchored on the exact single-sourced marker (after trimming leading
// whitespace) so a comment that merely quotes a marker in prose is not
// matched. The caller is expected to have already filtered by advisory-bot
// login (as every call site in this file and in
// `disposition-non-review-notices.mts` does) -- this function only tells
// apart a summary body from every other body. It does NOT imply the review
// is complete: Codex edits the same comment in place across its own
// lifecycle, so this can match while its status table still reads "Running"
// for the current HEAD -- callers that decide whether to AUTO-ACCEPT (as
// opposed to merely classifying a comment as needing some disposition) must
// gate on completion separately, as `isCodexReviewSummaryCompleteForHeadSha`
// (above) does.
// #2161: a comment that also nests CODERABBIT_SKIP_REVIEW_MARKER carries no
// review content despite starting with the CodeRabbit summary marker, so it
// is excluded here too -- never a summary walkthrough, always a non-review
// notice (see isAdvisoryNonReviewNotice / ADVISORY_NON_REVIEW_NOTICE_PATTERNS).
// #3260: the paused-review marker (CODERABBIT_REVIEW_PAUSED_MARKER) gets the
// same exclusion for the same reason -- a paused revision is a terminal
// decline, never a walkthrough. The in-progress marker
// (CODERABBIT_REVIEW_IN_PROGRESS_MARKER) is deliberately NOT excluded here --
// see isCodeRabbitReviewInProgressSummary's own doc comment for why. No other
// configured bot currently has an analogous inner exclusion marker.
export function isReviewSummaryComment(body: unknown): boolean {
  const text = String(body ?? '').trimStart();
  for (const [identity, marker] of REVIEW_SUMMARY_MARKERS_BY_BOT_IDENTITY) {
    if (!text.startsWith(marker)) {
      continue;
    }
    if (
      identity === 'coderabbitai' &&
      (CODERABBIT_SKIP_REVIEW_MARKER_RE.test(text) ||
        CODERABBIT_REVIEW_PAUSED_MARKER_RE.test(text))
    ) {
      return false;
    }
    return true;
  }
  return false;
}

// A trusted IDD disposition of any configured advisory bot's review-summary
// comment (CodeRabbit's summary walkthrough, Codex's review-status comment,
// or a future bot): the canonical `**Accepted** — {bot} summary walkthrough
// …` reply the helper posts. Requires the `**Accepted**` prefix (via
// `DISPOSITION_ACCEPTED_PREFIX_RE`, so the bounded trailing-punctuation
// variants like `**Accepted.**` also count; a summary is a completed review,
// so it is accepted, never rejected) AND the `summary walkthrough` phrase, so
// an ordinary acceptance of reviewer feedback is excluded. Already
// bot-agnostic -- the `{bot}` login is free text inside the body, not part of
// this predicate -- so recognizing a new bot's summary here needs no change,
// only a new `isReviewSummaryComment` marker entry (#2695). Tightly matched
// to `buildSummaryDispositionBody` so a loose acceptance can never be
// miscredited (which would under-post and strand the gate).
export function isReviewSummaryDisposition(comment: {
  body?: string | null;
}): boolean {
  const body = (comment.body ?? '').trimStart();
  return (
    DISPOSITION_ACCEPTED_PREFIX_RE.test(body) &&
    /\bsummary walkthrough\b/i.test(body)
  );
}

// The stable identity token of an advisory bot, used to attribute a non-review
// notice disposition to the bot it rejected. The `[bot]` suffix GitHub appends
// is dropped so the token matches whether a login is stored as `coderabbitai`
// or `coderabbitai[bot]`.
export function advisoryBotIdentityToken(login: unknown): string {
  return String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}

// Captures the span where a bot login structurally appears in each canonical
// disposition template `dispositionNamesAdvisoryBot` recognizes -- between the
// marker (tolerating the same single interior-punctuation variant as
// `DISPOSITION_REJECTED_PREFIX_RE` / `DISPOSITION_ACCEPTED_PREFIX_RE`) and the
// phrase that names the template. Non-greedy so a body with the phrase
// appearing once still captures the shortest, correct span. The `^` anchor
// applies after the caller's `trimStart()` below, so it tolerates leading
// whitespace the same way `isNonReviewNoticeDisposition` /
// `isReviewSummaryDisposition` already do -- not the stricter, untrimmed
// marker-first-bytes contract `isDispositionComment` enforces -- so this
// never matches a marker quoted mid-prose, but a leading blank line or space
// before the marker does not defeat it either.
const REJECTED_NOTICE_LOGIN_SPAN_RE =
  /^\*\*Rejected[.!:]?\*\*\s+—\s+([\s\S]*?)\s+did not review HEAD\b/i;
const ACCEPTED_SUMMARY_LOGIN_SPAN_RE =
  /^\*\*Accepted[.!:]?\*\*\s+—\s+([\s\S]*?)\s+summary walkthrough\b/i;

// True when a non-review-notice or summary-walkthrough disposition body names
// the given advisory bot's GitHub login, so the gate can attribute a
// carry-forward to exactly one bot even when several advisory bots are
// configured. Matches only within the anchored span where a canonical
// template places the bot login -- never a whole-body substring search --
// so a bot whose identity token equals a word from the template's own fixed
// text (e.g. "review", "head", or the #1482 "issuecomment" suffix) cannot
// falsely match a disposition naming a different bot. A body naming several
// bots in one span (a disposition that improperly covers more than one
// notice) still matches each of them, matching the existing 1:1 consumption
// contract at the call sites. Fail-closed: an empty token, or a disposition
// body that does not structurally match either canonical template, names no
// bot.
// Splits a `dispositionNamesAdvisoryBot` login span into its individual
// bot-login tokens. The span normally names exactly one bot, but #2475
// established that a single disposition may structurally name several at
// once, joined by `and` and/or a comma (`"A[bot] and B[bot]"`,
// `"A[bot], B[bot], and C[bot]"`) -- this must keep splitting that shape
// apart rather than treating it as one opaque string.
//
// #3466 (Copilot review, PR #3470): the Oxford-comma three-plus-bot form
// (`"A[bot], B[bot], and C[bot]"`) needs its trailing `, and ` collapsed to
// a plain `, ` FIRST -- splitting directly on the alternation below would
// otherwise stop the comma-separator match right after the comma (its
// trailing `\s*` only consumes the single space before "and"), leaving
// "and C[bot]" as one segment and making the leading-token extraction see
// "and" instead of "C[bot]".
const DISPOSITION_LOGIN_SPAN_OXFORD_AND_RE = /,\s+and\s+/gi;
const DISPOSITION_LOGIN_SPAN_SPLIT_RE = /\s*,\s*|\s+and\s+/i;

// A GitHub login itself never contains whitespace or `(` -- so the LEADING
// run of non-space, non-`(` characters in a (post-split) span segment is
// exactly its login, whether or not a human-readable parenthetical product
// name follows it (`"coderabbitai[bot] (CodeRabbit)"`, still a single
// segment after the `and`/`,` split above).
const DISPOSITION_LOGIN_TOKEN_RE = /^[^\s(]+/;

export function dispositionNamesAdvisoryBot(
  dispositionBody: unknown,
  noticeAuthorLogin: string,
): boolean {
  const token = advisoryBotIdentityToken(noticeAuthorLogin);
  if (!token) {
    return false;
  }
  const body = String(dispositionBody ?? '').trimStart();
  const span =
    REJECTED_NOTICE_LOGIN_SPAN_RE.exec(body)?.[1] ??
    ACCEPTED_SUMMARY_LOGIN_SPAN_RE.exec(body)?.[1];
  if (span === undefined) {
    return false;
  }
  // #3466 (Copilot review, PR #3470): exact per-login match, not a
  // substring/`.includes()` check on the whole span -- a lookalike or
  // fork bot login that merely CONTAINS this bot's identity token as a
  // substring (e.g. a configured `chatgpt-codex-connector-fork[bot]`
  // alongside the real `chatgpt-codex-connector[bot]`) must never match
  // it. Split the span into its individual per-bot segments (#2475's
  // multi-bot shape), extract just the leading login token from each
  // (tolerating a trailing human-readable parenthetical, as above), and
  // require an exact match after the same `[bot]`-suffix normalization.
  return span
    .replace(DISPOSITION_LOGIN_SPAN_OXFORD_AND_RE, ', ')
    .split(DISPOSITION_LOGIN_SPAN_SPLIT_RE)
    .some(
      (part) =>
        advisoryBotIdentityToken(
          DISPOSITION_LOGIN_TOKEN_RE.exec(part.trim())?.[0] ?? '',
        ) === token,
    );
}

// #2544/#2547: classifies the configured secondary advisory bot's current
// standing for the CURRENT HEAD into exactly one of three outcomes --
// still pending, definitively declined, or genuinely settled -- so
// `buildSecondaryQuietWindowStatus` can give each its own wait treatment
// (full window / zero-wait / short settled buffer respectively) instead of
// #2544's original two-way `settled: boolean` collapsing "no evidence yet"
// and "the bot already, conclusively, declined this exact commit" into the
// same slow path.
//
// - `settled: true` -- the LATEST matching comment for this HEAD is a
//   genuine (non-notice) comment: #2335's "might still be mid-review"
//   concern no longer applies, only the narrower "second/later finding"
//   risk `buildSecondaryQuietWindowStatus`'s settled-buffer branch still
//   protects against.
// - `declined: true` -- the LATEST matching comment for this HEAD is a
//   rate-limit / skip-review notice (`isAdvisoryNonReviewNotice`), which
//   since #3260 also covers CodeRabbit's paused-review marker ("Reviews
//   paused"): the bot will not review new commits until someone resumes
//   it, so it is exactly as terminal as a rate-limit decline. #2547's
//   live investigation (`gh api .../commits/{sha}/statuses` across several
//   PRs' head commits, corroborated by hours of subsequent silence on the
//   oldest sampled PR) found every sampled rate-limit decline reaches its
//   terminal commit-status entry within ~6-16 seconds of being queued and
//   is never observed to change afterward, even 15+ hours later -- so a
//   notice for the CURRENT HEAD is itself sufficient, corroborating
//   commit-status data is not required to treat it as definitive. (An
//   implementer's judgment call the issue explicitly left open: a notice
//   with no separately-fetched corroborating commit status still reports
//   `declined: true` here, not the ambiguous/pending case.)
// - Neither `settled` nor `declined` -- still pending: no comment from the
//   bot at or after `headCommittedAt` at all, an unparseable
//   `headCommittedAt`/unconfigured `secondaryBotLogin`, (#3260) the LATEST
//   matching comment is CodeRabbit's own in-progress revision
//   (`isCodeRabbitReviewInProgressSummary`) -- CodeRabbit edits its summary
//   comment in place when it starts reviewing new commits, so the outer
//   `summarize by coderabbit.ai` wrapper alone cannot tell an in-progress
//   revision apart from a genuine completed walkthrough; #2335's original
//   full-window protection is unchanged for this case -- or (#3261) the
//   LATEST matching comment is a NON-TERMINAL, non-notice body that simply
//   is not a RECOGNIZED COMPLETED shape for this identity: a CodeRabbit
//   reply that is not a summary walkthrough at all (e.g. a bare
//   review-trigger acknowledgement), a Codex review-status comment whose
//   own table still reads "Running" for this HEAD (the settlement
//   classifier had no matching exclusion for this before #3261, even
//   though #2695 already excludes it from AUTO-ACCEPT in
//   `disposition-non-review-notices.mts`), or any other non-terminal
//   comment at all from a secondary-bot identity this file has no
//   completion recognizer for -- only `coderabbitai` and
//   `chatgpt-codex-connector` have one. This is "non-terminal" specifically
//   because a TERMINAL notice (rate-limit/skip/paused,
//   `isTerminalAdvisoryNonReviewNotice` above) is checked first,
//   identity-agnostically, before any of this dispatch runs -- an
//   unrecognized identity's terminal notice still correctly reports
//   `declined: true`, not pending. Fail-closed by design (Background of
//   #3261): an unrecognized identity or shape costs its siblings the full
//   quiet window rather than the short settled buffer, which is safer than
//   crediting a review this classifier cannot actually verify is finished.
//
// Only the single latest matching comment is examined -- a notice posted
// BEFORE a later genuine comment (rate-limited, then recovered) reports
// `settled: true`, not `declined`, while a notice posted AFTER the latest
// genuine comment reports `declined: true` as a fresh, terminal decline
// for this HEAD -- not "might still produce another review" -- purely as
// a side effect of always picking the latest.
//
// Deliberately reuses `comments` only, not `reviews`: this file's existing
// notice-vs-genuine classification for the secondary bot
// (`isAdvisoryNonReviewNotice`, `isReviewSummaryComment`,
// `classifyRegularBotComment`) already operates purely on top-level PR
// comments. `ReviewLike` gained an optional `body` field (#3015, consumed
// by `isCopilotErrorReviewBody`/`findLastCopilotReviewCommit` for the
// primary Copilot review-coverage classification only), so a PR review
// object CAN carry marker-shaped text now -- restricting this secondary-bot
// settlement classifier to `comments` is a deliberate scope choice, not a
// type limitation: the secondary bot's rate-limit/skip-review notices and
// summary walkthroughs are observed live only as top-level PR comments, so
// there is no known review-body shape this classifier would need to catch.
//
// Falls back to `user.login`/`created_at`/`updated_at` alongside
// `author.login`/`createdAt`/`updatedAt`, matching every other
// `CommentLike` reader in this file (Copilot review, #2546): a caller that
// ever passes REST-raw comments straight through, without the CLI layer's
// own `normalizeComment` pass, must not silently fail-closed here just
// because it used the other field-name form.
//
// kurone-kito/idd-skill#3253: the `headCommittedAt` parameter here names a
// ROLE (the cutoff timestamp this function compares comments against), not
// a SOURCE -- this pure function is anchor-agnostic and never itself reads
// or knows about committedDate vs. an observed check-suite time, so it is
// not renamed. Every LIVE caller now passes the GitHub-observed anchor
// (`headObservedAt`: the earliest check-suite `createdAt` for the current
// HEAD) here, not the committer-supplied `committedDate` -- see
// `buildPreMergeReadinessSummary`'s own call site below.
//
// #3261: `headSha` is the current PR HEAD's own commit SHA (as opposed to
// `headCommittedAt`'s timestamp role above), needed only for the Codex
// completion check (`isCodexReviewSummaryCompleteForHeadSha` matches a
// specific commit, not a point in time). Optional because every existing
// direct caller in this file's own test suite predates it and only
// exercises the `coderabbitai` identity, which never reads it; a missing
// or empty value simply fails the Codex branch closed (pending), never
// throws.
export function computeSecondaryAdvisoryReviewSettlement(
  comments: CommentLike[],
  {
    secondaryBotLogin,
    headCommittedAt,
    headSha,
  }: {
    secondaryBotLogin: string;
    headCommittedAt?: string | null;
    headSha?: string | null;
  },
): { settled: boolean; settledAt: string | null; declined: boolean } {
  const token = advisoryBotIdentityToken(secondaryBotLogin);
  const headAt = String(headCommittedAt ?? '');
  if (!token || !isValidIsoTimestamp(headAt)) {
    return { settled: false, settledAt: null, declined: false };
  }

  const matches = comments
    .filter(
      (comment) =>
        advisoryBotIdentityToken(
          comment.author?.login ?? comment.user?.login ?? '',
        ) === token,
    )
    .map((comment) => ({
      body: comment.body ?? '',
      at: effectiveRegularCommentActivityAt({
        updatedAt: comment.updatedAt ?? comment.updated_at,
        createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      }),
    }))
    .filter(
      (entry) =>
        isValidIsoTimestamp(entry.at) &&
        compareIsoTimestamps(entry.at, headAt) >= 0,
    )
    .sort((left, right) => compareIsoTimestamps(left.at, right.at));

  const latest = matches[matches.length - 1];
  if (!latest) {
    return { settled: false, settledAt: null, declined: false };
  }
  if (isTerminalAdvisoryNonReviewNotice(latest.body)) {
    return { settled: false, settledAt: null, declined: true };
  }
  if (isCodeRabbitAlreadyReviewedAcknowledgement(latest.body)) {
    // This is a retryable non-review notice, not a completed review. Keep the
    // secondary bot in the ordinary pending path so a later full review or
    // finding cannot arrive after a short settled buffer (#3146).
    return { settled: false, settledAt: null, declined: false };
  }
  if (
    token === 'coderabbitai' &&
    isCodeRabbitReviewInProgressSummary(latest.body)
  ) {
    // #3260: CodeRabbit is still processing new commits -- the outer summary
    // wrapper is byte-for-byte identical to a genuine walkthrough, but this
    // revision carries no review result yet. Keep the secondary bot in the
    // ordinary pending path (full window) rather than settling on a
    // revision that will be overwritten once the review actually finishes.
    // Gated on `token` (Copilot review, PR #3412): this marker predicate is
    // CodeRabbit-specific, so it must never fire for a differently
    // configured secondary bot whose own comment happens to contain the
    // same literal marker text -- `matches`/`latest` are already filtered
    // to `secondaryBotLogin`'s own comments, not necessarily CodeRabbit's.
    return { settled: false, settledAt: null, declined: false };
  }
  // #3261: fail-closed dispatch -- settlement requires a RECOGNIZED
  // COMPLETED shape for THIS identity, not merely "not a known notice".
  // Only two identities have any completion recognizer at all; every other
  // identity always reports pending (see the function's own doc comment
  // above).
  if (token === 'coderabbitai') {
    if (isCodeRabbitCompletedReviewSummary(latest.body)) {
      return { settled: true, settledAt: latest.at, declined: false };
    }
    return { settled: false, settledAt: null, declined: false };
  }
  if (token === 'chatgpt-codex-connector') {
    // Copilot review (PR #3422): `isCodexReviewSummaryCompleteForHeadSha`
    // is a pure table parser with no identity check of its own -- it
    // requires only Status/Commit columns and a Completed row, so calling
    // it directly on ANY comment body would credit an ordinary
    // Codex-authored comment that merely happens to embed a
    // matching-shaped Markdown table. Pin to the identity's own
    // `CODEX_SUMMARY_MARKER` first, the same way the `coderabbitai` branch
    // above is pinned to `CODERABBIT_SUMMARY_MARKER` via
    // `isCodeRabbitCompletedReviewSummary`.
    const fullHeadSha = String(headSha ?? '').trim();
    if (
      fullHeadSha &&
      String(latest.body ?? '')
        .trimStart()
        .startsWith(CODEX_SUMMARY_MARKER) &&
      isCodexReviewSummaryCompleteForHeadSha(latest.body, fullHeadSha)
    ) {
      return { settled: true, settledAt: latest.at, declined: false };
    }
    return { settled: false, settledAt: null, declined: false };
  }
  // No recognized completion shape exists for this identity at all.
  return { settled: false, settledAt: null, declined: false };
}

// #3186: folds each configured secondary advisory bot login's own
// independent {@link computeSecondaryAdvisoryReviewSettlement} classification
// into the single `{ settledAt, declined }` shape
// `buildSecondaryQuietWindowStatus` consumes, so a repository that configures
// more than one secondary login still gets exactly one quiet-window status.
//
// - Any login still pending (neither settled nor declined for this HEAD)
//   keeps the caller on the full configured window: reports
//   `{ settledAt: null, declined: false }`, the same shape
//   `buildSecondaryQuietWindowStatus` already treats as "fall through to the
//   ordinary unsettled-anchor path" when no settlement evidence exists.
// - Otherwise, once every configured login has declined, reports
//   `{ settledAt: null, declined: true }` -- the zero-wait branch.
// - Otherwise (no login pending, at least one settled), reports the LATEST
//   `settledAt` among the settled logins. A declined sibling never extends
//   this wait -- only a still-PENDING sibling does, via the first bullet.
//
// An empty `secondaryBotLogins` list reports the pre-existing unconfigured
// shape (`{ settledAt: null, declined: false }`), matching
// `computeSecondaryAdvisoryReviewSettlement`'s own unconfigured default.
//
// kurone-kito/idd-skill#3253: same parameter-name-kept-value-changed note as
// `computeSecondaryAdvisoryReviewSettlement` above -- `headCommittedAt` here
// is fed the GitHub-observed anchor by every live caller.
//
// #3261: `headSha` is passed straight through to every per-login
// `computeSecondaryAdvisoryReviewSettlement` call -- see that function's own
// doc comment for its role. Every login shares the same current PR HEAD, so
// one value covers the whole fold.
export function foldSecondaryAdvisoryReviewSettlements(
  comments: CommentLike[],
  {
    secondaryBotLogins,
    headCommittedAt,
    headSha,
  }: {
    secondaryBotLogins: readonly string[];
    headCommittedAt?: string | null;
    headSha?: string | null;
  },
): { settledAt: string | null; declined: boolean } {
  if (secondaryBotLogins.length === 0) {
    return { settledAt: null, declined: false };
  }
  const settlements = secondaryBotLogins.map((secondaryBotLogin) =>
    computeSecondaryAdvisoryReviewSettlement(comments, {
      secondaryBotLogin,
      headCommittedAt,
      headSha,
    }),
  );
  if (settlements.some((entry) => !entry.settled && !entry.declined)) {
    return { settledAt: null, declined: false };
  }
  const settledAts = settlements
    .filter((entry) => entry.settled && entry.settledAt !== null)
    .map((entry) => entry.settledAt as string);
  if (settledAts.length === 0) {
    return { settledAt: null, declined: true };
  }
  const latestSettledAt = settledAts.reduce((latest, current) =>
    compareIsoTimestamps(current, latest) > 0 ? current : latest,
  );
  return { settledAt: latestSettledAt, declined: false };
}

// #1182 Match trusted machine advisory dispositions to the advisory-bot stickies
// they address, so a disposition posted by a trusted-marker actor who is NOT a
// resolved IDD agent (e.g. a second trusted session) is honored without being
// promoted into a global IDD-agent identity. Matching is strict on FOUR axes:
//   - bot: the disposition body must name the sticky author's bot login
//     (`dispositionNamesAdvisoryBot`);
//   - type: a `**Rejected** — {bot} did not review HEAD …` notice disposition
//     clears only a non-review-notice sticky, and an `**Accepted** — {bot}
//     summary walkthrough …` disposition clears only a CodeRabbit summary
//     sticky — the notice/summary paths are disjoint in the helper that posts
//     them, so a notice rejection must never hide a summary that still needs its
//     own acceptance (or vice versa);
//   - count: consumed 1:1, so one disposition cannot clear several stickies.
//   - recency (summary only): a CodeRabbit summary walkthrough IS a completed
//     review that CodeRabbit edits on each re-review (bumping the sticky's
//     `activityAt`), so a summary disposition clears a summary sticky only when
//     the disposition is strictly NEWER than the sticky — a stale `**Accepted**`
//     can never clear a summary edited after it (the #1122 "a false positive is
//     a false merge" hazard). Non-review notices intentionally skip this: a
//     notice disposition carries forward across HEAD changes while the bot still
//     has not reviewed (the #1018 carry-forward), so it need not post-date a
//     re-posted notice.
// IDD-agent-authored dispositions are excluded here — they are already scored by
// the caller's own disposition pool / watermark — which also prevents a
// viewer-authored (agent AND trusted) disposition from being double-counted. A
// trusted disposition matched here is bound to its advisory item and NEVER flows
// into any generic disposition pool, so an absent or already-resolved sticky
// leaves the disposition unused: it can never clear an unrelated human comment.
// Returns the set of `sortedIndex` values of the stickies that are dispositioned.
function matchTrustedAdvisoryStickyDispositions<
  T extends {
    authorLogin: string;
    body: string;
    activityAt: string;
    sortedIndex: number;
    lastEditedAt?: string | null;
  },
>(
  comments: T[],
  advisoryBotLogins: Set<string>,
  trustedMarkerLogins: Set<string>,
  iddAgentLogins: Set<string>,
): Set<number> {
  const dispositionedStickyIndexes = new Set<number>();
  // #3249: an edited (or edit-state-unresolved) trusted disposition must
  // never clear an advisory sticky -- clearing one relaxes the gate the
  // same way satisfying it would.
  const trustedDispositions = comments.filter(
    (comment) =>
      trustedMarkerLogins.has(comment.authorLogin) &&
      !iddAgentLogins.has(comment.authorLogin) &&
      classifyCommentEditState({ lastEditedAt: comment.lastEditedAt }) ===
        'unedited',
  );
  const byActivityThenIndex = (left: T, right: T) => {
    const leftTime = Date.parse(left.activityAt);
    const rightTime = Date.parse(right.activityAt);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.sortedIndex - right.sortedIndex;
  };
  const kinds = [
    {
      isSticky: (body: string) => isAdvisoryNonReviewNotice(body),
      isDisposition: (body: string) => isNonReviewNoticeDisposition({ body }),
      requireNewerDisposition: false,
    },
    {
      isSticky: (body: string) => isReviewSummaryComment(body),
      isDisposition: (body: string) => isReviewSummaryDisposition({ body }),
      requireNewerDisposition: true,
    },
  ];
  for (const kind of kinds) {
    const stickiesByBot = new Map<string, T[]>();
    for (const comment of comments) {
      if (
        !isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) ||
        !kind.isSticky(comment.body)
      ) {
        continue;
      }
      const list = stickiesByBot.get(comment.authorLogin) ?? [];
      list.push(comment);
      stickiesByBot.set(comment.authorLogin, list);
    }
    // Sort bot logins for deterministic iteration order only. Consumption is
    // tracked per bot login (`consumedDispositionIndexes` below, reset on
    // each iteration of this loop) rather than shared across bots: a single
    // disposition naming several configured bots (`dispositionNamesAdvisoryBot`
    // matches each one it names) must be able to clear one sticky per bot it
    // names, not just the first bot processed. #2475 -- a shared,
    // loop-wide consumption set previously let only the alphabetically-first
    // named bot's sticky be credited, stranding the others.
    for (const botLogin of [...stickiesByBot.keys()].sort()) {
      const consumedDispositionIndexes = new Set<number>();
      const stickies = [...(stickiesByBot.get(botLogin) ?? [])].sort(
        byActivityThenIndex,
      );
      const candidates = trustedDispositions
        .filter(
          (disposition) =>
            kind.isDisposition(disposition.body) &&
            dispositionNamesAdvisoryBot(disposition.body, botLogin),
        )
        .sort(byActivityThenIndex);
      // Greedy oldest-first pairing: match each sticky to the earliest unconsumed
      // matching disposition (that is strictly newer, when the kind requires it),
      // so one disposition never clears several stickies and — for summaries — a
      // disposition only clears a sticky it post-dates.
      for (const sticky of stickies) {
        const match = candidates.find(
          (disposition) =>
            !consumedDispositionIndexes.has(disposition.sortedIndex) &&
            (!kind.requireNewerDisposition ||
              compareIsoTimestamps(disposition.activityAt, sticky.activityAt) >
                0),
        );
        if (match) {
          dispositionedStickyIndexes.add(sticky.sortedIndex);
          consumedDispositionIndexes.add(match.sortedIndex);
        }
      }
    }
  }
  return dispositionedStickyIndexes;
}

/**
 * Parse a check's `completedAt` into epoch milliseconds, or `null` when it
 * is missing, not a valid ISO 8601 timestamp, or the `0001-01-01T00:00:00Z`
 * zero-value sentinel some GitHub API surfaces (e.g. `gh pr checks`) report
 * for a check that has not actually completed — see `isCompletedCiTimestamp`,
 * this file's existing convention for the same sentinel. A still-running
 * instance's `completedAt` reads as one of these three "not completed"
 * shapes until it finishes.
 */
function parseCompletedAt(value: string | null | undefined): number | null {
  const timestamp = String(value ?? '');
  return isCompletedCiTimestamp(timestamp) ? Date.parse(timestamp) : null;
}

/**
 * Failure-family *conclusion* states that must win a same-instant
 * tie-break and classify as a genuine `classifyCiChecks` failure (#1688).
 * Deliberately excludes `CANCELLED`: a cancelled run reached no real
 * verdict at all (unlike these six, which are all concrete failure
 * conclusions), so it keeps its own separate, lower tie-break rank in
 * `ciStateTieRank` below and stays out of `classifyCiChecks`'s `failed`
 * bucket — see that function and `ci-wait-state.mts`'s `FAILURE_STATES`
 * (which is deliberately *derived from* this set plus `CANCELLED`, not
 * independently maintained, so the two files cannot silently drift apart
 * again the way #1504's local-only fix did).
 *
 * `ERROR` is StatusContext-only (a CheckRun conclusion never reports it);
 * included here so a caller that feeds a raw, un-translated commit-status
 * state directly into `classifyCiChecks` or `ciStateTieRank` still gets
 * failure-family treatment, matching `normalizeStatusCheckRollupEntry`'s
 * translation of StatusContext `error` to the literal `'FAILURE'` for the
 * one call path that already normalizes it upstream.
 */
export const CI_FAILURE_CONCLUSION_STATES = new Set([
  'FAILURE',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  'ERROR',
]);

/**
 * Tie-break precedence for two check-run instances that complete at the
 * same (or an equally unusable) instant. Every `CI_FAILURE_CONCLUSION_STATES`
 * member always wins (rank 0): a same-instant tie must never hide a real
 * failure behind ordering happenstance (the exact regression
 * `classifyCiChecks`'s unconditional "any FAILURE anywhere" rule existed
 * to prevent, and not a case a rerun can plausibly land in — GitHub
 * `completedAt` has only second resolution, and a rerun must trigger,
 * queue, and execute before it can complete, which practically never
 * lands in the exact same recorded second as the run it supersedes).
 * Pre-#1688, only the literal `'FAILURE'` string won this way; `TIMED_OUT`,
 * `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, and `ERROR` fell into the
 * generic rank-1 bucket below and could lose a tie to `SUCCESS` by
 * lexicographic happenstance (#1688's reproduction: `SUCCESS` vs
 * `TIMED_OUT`, `'SUCCESS' < 'TIMED_OUT'`). `CANCELLED` always loses (rank
 * 2): a cancelled run reached no real verdict, so it defers to any
 * conclusion that did. Every other state — including pending states,
 * which practically never reach this tie path since they have no
 * completed timestamp to tie on — shares the middle rank (1).
 */
function ciStateTieRank(state: string): number {
  if (state === 'CANCELLED') return 2;
  if (CI_FAILURE_CONCLUSION_STATES.has(state)) return 0;
  return 1;
}

/**
 * True when `candidate` should replace `current` as the representative
 * instance for one check name. A still-incomplete instance (per
 * `parseCompletedAt`) always wins over an already-completed one:
 * completion can only happen after creation, so a live rerun can never be
 * older than the finished run it supersedes — this mirrors GitHub's own
 * latest-per-context semantics, under which an in-progress required check
 * leaves the branch not-clean rather than falling back to a stale
 * completed verdict. Once both sides have completed, the most recently
 * completed one wins.
 *
 * A tie (equal completedAt, or both sides missing/unparseable) never
 * resolves by input order — two independent runs can genuinely complete
 * within the same recorded second. It resolves by `ciStateTieRank`
 * instead; a residual tie within the same rank (e.g. `SUCCESS` vs.
 * `NEUTRAL`, both rank 1) falls back to comparing the state strings
 * themselves, which depends only on the two values being compared, never
 * on which one the caller happened to list first — so the whole
 * selection is fully deterministic regardless of input order.
 */
function isNewerCheckInstance<
  T extends { state: string; completedAt?: string | null },
>(candidate: T, current: T): boolean {
  const candidateAt = parseCompletedAt(candidate.completedAt);
  const currentAt = parseCompletedAt(current.completedAt);
  if (candidateAt !== null && currentAt !== null && candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  if ((candidateAt !== null) !== (currentAt !== null)) {
    // Exactly one side has a usable timestamp. The side still missing one
    // is never older than a completed side — a live rerun cannot have
    // started before the finished run it supersedes — so the incomplete
    // side always wins here.
    return candidateAt === null;
  }
  const candidateRank = ciStateTieRank(candidate.state);
  const currentRank = ciStateTieRank(current.state);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank;
  }
  return candidate.state !== current.state && candidate.state < current.state;
}

/**
 * Reduce a group of check-run instances that share one grouping key
 * (typically a check name) to the single instance that represents the
 * current truth for that key. See `isNewerCheckInstance` for the
 * selection rule. Exported so other same-name dedup call sites (e.g.
 * `ci-wait-state.mts`'s `buildCiWaitStateSummary`, #1478) can reuse this
 * tie-break instead of maintaining an independent copy. `group` is
 * always non-empty in every current caller (each group comes from
 * bucketing a non-empty input list by key), so the seedless `reduce`
 * below never hits its empty-array throw path.
 */
export function selectLatestCheckInstance<
  T extends { state: string; completedAt?: string | null },
>(group: T[]): T {
  return group.reduce((latest, candidate) =>
    isNewerCheckInstance(candidate, latest) ? candidate : latest,
  );
}

/**
 * Reduce a check-run list to a single representative instance per
 * `(name, type, workflowName)` group, matching GitHub's own
 * required-status-check semantics: only the latest run for a given
 * producer governs, so a stale instance (e.g. a cancelled or failed run
 * superseded by a later successful rerun) can never outvote the current,
 * authoritative one from the *same* producer.
 *
 * A missing or empty `name` carries no identity to dedupe against, so
 * each such entry gets its own singleton group instead of collapsing
 * every unnamed check together — otherwise an unrelated unnamed failure
 * could be discarded in favor of an unrelated unnamed success that
 * merely happens to also lack a name.
 *
 * `type` (e.g. `'check-run'` vs. `'status-context'`) and `workflowName`
 * are an optional producer-identity discriminator (#1483): two entries
 * that share a `name` but differ on either one are never assumed to be
 * reruns of each other (e.g. a check-run and a legacy commit-status, or
 * two check-runs from different Actions workflows, that happen to share
 * a display name both survive instead of one discarding the other). When
 * `type`/`workflowName` are absent on every entry sharing a `name` (the
 * pre-#1483 data shape, still produced by hand-built fixtures and any
 * caller that predates the discriminator), there is no conflicting
 * signal to split on, so the group dedupes by `name` alone exactly as
 * #1471 established -- this keeps every pre-#1483 caller and test
 * behavior-identical.
 *
 * Residual known limitation: two genuinely independent producers that
 * share a `name`, a `type`, and (when populated) a `workflowName` AND a
 * `workflowPath` (e.g. two different non-Actions GitHub Apps that each
 * post a check-run directly, rather than through a workflow -- neither
 * has a `workflowPath` to disambiguate with) remain indistinguishable
 * here and will still be grouped together. Closing that fully needs a
 * stronger producer identity (e.g. the owning GitHub App) than
 * `gh`/GraphQL's `statusCheckRollup` exposes today; `ci-wait-state.mts`'s
 * own `(checkName, workflowName)` key has the identical accepted gap.
 */
/**
 * Group check-run instances by the same `(name, type, workflowName,
 * workflowPath)` producer-identity key (#2919 added `workflowPath`, see
 * `CheckLike`'s own doc comment for why `workflowName` alone is
 * insufficient) `selectLatestCheckPerName` reduces to one representative
 * -- shared here so a caller that needs to inspect the DISCARDED
 * siblings, not just the survivor (see
 * {@link findDiscardedNonPassingSiblings}), can never drift out of sync
 * with that grouping.
 */
function groupChecksByProducer<
  T extends {
    name?: string | null;
    type?: string | null;
    workflowName?: string | null;
    workflowPath?: string | null;
  },
>(checks: T[]): Map<string, T[]> {
  // A Map already iterates in first-insertion order, so grouping into one
  // is enough to preserve stable output order with no separate order array
  // (see the same pattern in `findDuplicateBasenames` in audit-docs.mts).
  const groups = new Map<string, T[]>();
  let unnamedCount = 0;
  for (const check of checks) {
    if (!check.name) {
      groups.set(`\0unnamed:${unnamedCount++}`, [check]);
      continue;
    }
    const type = check.type ? String(check.type).trim() : '';
    const workflowName = check.workflowName
      ? String(check.workflowName).trim()
      : '';
    const workflowPath = check.workflowPath
      ? String(check.workflowPath).trim()
      : '';
    const key = `${String(check.name)}\0${type}\0${workflowName}\0${workflowPath}`;
    const group = groups.get(key);
    if (group) {
      group.push(check);
    } else {
      groups.set(key, [check]);
    }
  }
  return groups;
}

function selectLatestCheckPerName<
  T extends {
    name?: string | null;
    state: string;
    completedAt?: string | null;
    type?: string | null;
    workflowName?: string | null;
    workflowPath?: string | null;
  },
>(checks: T[]): T[] {
  return [...groupChecksByProducer(checks).values()].map((group) =>
    selectLatestCheckInstance(group),
  );
}

/** Check-run states {@link findDiscardedNonPassingSiblings} treats as
 * "genuinely non-passing": every `CI_FAILURE_CONCLUSION_STATES` member plus
 * `CANCELLED` (deliberately excluded from that set itself -- see its own
 * doc comment -- but still evidence-worthy here: a discarded `CANCELLED`
 * sibling is exactly the #1745 finding, a stale/gated instance masked by a
 * same-name `SUCCESS`). Pending states are excluded on purpose: a discarded
 * still-running sibling in favor of an already-completed one is ordinary,
 * expected dedup behavior, not a discrepancy worth flagging. */
const GENUINELY_NON_PASSING_STATES = new Set([
  ...CI_FAILURE_CONCLUSION_STATES,
  'CANCELLED',
]);

/** One divergence {@link classifyCiChecks} reports on its
 * `discardedNonPassingInstances` field. */
export interface CiCheckDiscardedSibling {
  name: string;
  type: string;
  workflowName: string;
  selectedState: string;
  selectedCompletedAt: string | null;
  discardedState: string;
  discardedCompletedAt: string | null;
}

/**
 * Detect same-producer `(name, type, workflowName, workflowPath)` groups
 * (kurone-kito/idd-skill#2919 widened this key from the original 3-tuple
 * `(name, type, workflowName)` -- see `groupChecksByProducer`'s own doc
 * comment) whose dedup-selected "latest" instance
 * (`selectLatestCheckInstance`) is pass-equivalent (SUCCESS/SKIPPED/
 * NEUTRAL/NOT_APPLICABLE) while a DISCARDED sibling in that same group is
 * genuinely non-passing (see {@link GENUINELY_NON_PASSING_STATES}) -- the
 * live discrepancy PR #1741 exhibited (#1745): `classifyCiChecks` reported
 * `success` for a commit whose GitHub `statusCheckRollup.state` was
 * `FAILURE`, because a `CANCELLED` bot-triggered `idd-advisory-convergence`
 * instance existed alongside the `SUCCESS` instance this dedup selected as
 * "latest". Confirming the exact internal GitHub selection is not possible
 * after the fact (see #1745's evidence-durability note), so this reports
 * the discarded-sibling FACT itself -- a same-name non-passing instance
 * existed and was NOT counted -- rather than asserting why GitHub's own
 * rollup disagreed. Pure and read-only: never changes which instance
 * `selectLatestCheckPerName` selects, only reports when a discarded sibling
 * makes that selection's "success" verdict less certain than it looks.
 */
function findDiscardedNonPassingSiblings<
  T extends {
    name?: string | null;
    state: string;
    completedAt?: string | null;
    type?: string | null;
    workflowName?: string | null;
    // kurone-kito/idd-skill#2919: matches `groupChecksByProducer`'s own
    // generic constraint -- this function calls that one internally
    // (via `groupChecksByProducer(checks).values()` below), so its own
    // type signature must document the SAME 4-tuple key, not the
    // pre-#2919 3-tuple one.
    workflowPath?: string | null;
  },
>(checks: T[]): CiCheckDiscardedSibling[] {
  const divergences: CiCheckDiscardedSibling[] = [];
  for (const group of groupChecksByProducer(checks).values()) {
    if (group.length < 2) continue;
    const selected = selectLatestCheckInstance(group);
    if (
      !['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
        selected.state,
      )
    ) {
      continue;
    }
    for (const sibling of group) {
      if (sibling === selected) continue;
      if (!GENUINELY_NON_PASSING_STATES.has(sibling.state)) continue;
      divergences.push({
        name: String(selected.name ?? ''),
        type: selected.type ? String(selected.type) : '',
        workflowName: selected.workflowName
          ? String(selected.workflowName)
          : '',
        selectedState: selected.state,
        selectedCompletedAt: selected.completedAt ?? null,
        discardedState: sibling.state,
        discardedCompletedAt: sibling.completedAt ?? null,
      });
    }
  }
  return divergences;
}

export function classifyCiChecks(checks: CheckLike[]) {
  const normalized = checks.map((check) => ({
    name: check.name,
    state: String(check.state ?? '').toUpperCase(),
    completedAt: check.completedAt ?? null,
    type: check.type ?? null,
    workflowName: check.workflowName ?? null,
    // #2919: carried through so a caller that populates it gets the
    // stronger producer-identity split at this shared dedup/grouping
    // layer too, not just at the one call site that originally
    // motivated it -- see `CheckLike`'s own doc comment.
    workflowPath: check.workflowPath ?? null,
  }));
  // GitHub can report several check-run instances that share the same
  // check `name` (a manual or automatic re-run leaves the earlier instance
  // in the fetched list alongside the new one). Reduce to one instance per
  // name before classifying pass/fail/pending, so a stale instance never
  // outvotes the current one for the same name (see #1471).
  const deduped = selectLatestCheckPerName(normalized);

  // #1745: computed unconditionally (not just for the 'success' path) so
  // every returned shape below carries the same field -- a discarded
  // non-passing sibling is evidence worth surfacing even when the overall
  // status already reads 'failed'/'pending' for an unrelated check name.
  const discardedNonPassingInstances =
    findDiscardedNonPassingSiblings(normalized);

  // #1688: widened from a literal 'FAILURE' match to every
  // CI_FAILURE_CONCLUSION_STATES member, so a TIMED_OUT/ACTION_REQUIRED/
  // STARTUP_FAILURE/STALE/ERROR conclusion classifies as a genuine failure
  // here too, matching ci-wait-state.mts's own bucketing for the same
  // conclusion states instead of silently falling through to 'unknown'.
  // CANCELLED is deliberately not included -- see CI_FAILURE_CONCLUSION_STATES.
  const failed = deduped.filter((check) =>
    CI_FAILURE_CONCLUSION_STATES.has(check.state),
  );
  if (failed.length > 0) {
    return { status: 'failed', failed, discardedNonPassingInstances };
  }

  const pending = deduped.filter((check) => {
    return (
      check.state === 'QUEUED' ||
      check.state === 'IN_PROGRESS' ||
      check.state === 'WAITING'
    );
  });
  if (pending.length > 0) {
    return { status: 'pending', pending, discardedNonPassingInstances };
  }

  const passing = deduped.filter((check) => {
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
      check.state,
    );
  });

  return {
    status: passing.length === deduped.length ? 'success' : 'unknown',
    passing,
    unknown: deduped.filter((check) => !passing.includes(check)),
    discardedNonPassingInstances,
  };
}

/**
 * #1686: the exact, closed set of logins recognized for the *default*
 * Copilot primary advisory bot -- the human-facing `copilot` slash-command
 * actor plus the two known GitHub-App review-bot login forms. Previously
 * matched via `normalized.startsWith('copilot-pull-request-reviewer')`,
 * which a *registrable* GitHub username lookalike (for example
 * `copilot-pull-request-reviewer1`) could also satisfy on a public
 * repository: any account can submit a PR review, so a lookalike login
 * could post an empty review of the current HEAD and masquerade as the
 * real bot's convergence signal (Clause 1 of `advisory-convergence.mts`'s
 * verdict: `matchesHead: true, itemCount: 0`). An exact set closes that
 * gap without narrowing the two genuine login forms GitHub actually uses.
 */
const EXACT_COPILOT_REVIEWER_LOGINS: ReadonlySet<string> = new Set([
  'copilot',
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);

/**
 * Normalize a configured `primaryBotLogin` for comparison against
 * {@link DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN}: trim, lower-case, and fall
 * back to the default when blank. Shared by {@link isCopilotReviewerLogin}
 * and `findLastCopilotReviewCommit` (kurone-kito/idd-skill#3265 E2 review)
 * so the two "is this the default Copilot bot, or a configured non-Copilot
 * one" decisions cannot drift apart.
 */
function normalizePrimaryBotLogin(primaryBotLogin: string): string {
  return (
    String(primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN
  );
}

/**
 * Match a review/reviewer login against the configured primary advisory bot.
 *
 * `primaryBotLogin` defaults to Copilot so existing callers stay behavior-
 * preserving. For the Copilot default, the login must be an exact member of
 * {@link EXACT_COPILOT_REVIEWER_LOGINS} (#1686 -- previously a broader
 * `copilot-pull-request-reviewer*` prefix match; see that constant's doc
 * comment for why it was narrowed); `authorType` is not consulted on this
 * path.
 *
 * A non-Copilot configured login matches on exact normalized (trimmed,
 * lower-cased) equality first. Otherwise (#3262), GitHub reports a GitHub
 * App's login in two spellings -- GraphQL `author.login` bare
 * (`coderabbitai`) vs. REST `user.login` `[bot]`-suffixed
 * (`coderabbitai[bot]`) -- so also compare via
 * {@link advisoryBotIdentityToken}, which strips the trailing `[bot]`
 * suffix from both sides:
 * - an observed `[bot]`-suffixed login matches a bare configured login
 *   unconditionally once the tokens agree, since a genuine user login
 *   cannot contain `[`;
 * - an observed bare login matches a `[bot]`-suffixed configured login
 *   only when `authorType` is exactly `'Bot'` -- a missing or non-`'Bot'`
 *   type fails closed, since a bare login alone could otherwise be a
 *   same-named user account.
 *
 * A look-alike login whose token does not match the configured token
 * (e.g. `coderabbitai1` against `coderabbitai[bot]`) never matches,
 * regardless of `authorType`.
 */
export function isCopilotReviewerLogin(
  login: unknown,
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  authorType?: string | null,
): boolean {
  const normalized = String(login ?? '')
    .trim()
    .toLowerCase();
  const configured = normalizePrimaryBotLogin(primaryBotLogin);
  if (configured === DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN) {
    return EXACT_COPILOT_REVIEWER_LOGINS.has(normalized);
  }
  if (normalized === configured) {
    return true;
  }
  if (
    advisoryBotIdentityToken(normalized) !==
    advisoryBotIdentityToken(configured)
  ) {
    return false;
  }
  const normalizedIsBotSuffixed = normalized.endsWith('[bot]');
  const configuredIsBotSuffixed = configured.endsWith('[bot]');
  if (normalizedIsBotSuffixed && !configuredIsBotSuffixed) {
    return true;
  }
  if (!normalizedIsBotSuffixed && configuredIsBotSuffixed) {
    return authorType === 'Bot';
  }
  return false;
}

// `isCopilotErrorReviewBody` (kurone-kito/idd-skill#3258) now lives in
// `copilot-review-body.mts` -- a leaf module `review-clause.mts` also
// imports -- and is re-exported/imported above (see the façade re-export
// beside `export * from './marker-helpers.mts'` near the top of this
// file) so this module's own `findLastCopilotReviewCommit` below and every
// existing external importer keep working unchanged.

/**
 * kurone-kito/idd-skill#3265: for the DEFAULT Copilot bot, coverage is now a
 * positive-signature decision instead of the #3015 error-template denylist
 * alone -- only a review body {@link classifyCopilotReviewBody} recognizes as
 * `overview-v2` or `overview-legacy` counts as covering its `commit_id`. A
 * body classified `error` (the exact #3015 template) or `unrecognized`
 * (including any FUTURE Copilot error wording the old denylist would not
 * know about) no longer wins the `LAST_COPILOT_COMMIT == PR_HEAD_SHA`
 * short-circuit, closing the same class of false-empty-review gap
 * #3015/#1880 fixed for the exact known template, this time for shape drift
 * too. The real PR #3045 review bodies that only QUOTE the error sentence
 * amid ordinary review prose classify `overview-legacy` (a genuine
 * `<details><summary>...</summary>` anchor elsewhere in the body), not
 * `error` or `unrecognized`, so those two still count -- the classifier's
 * code-region stripping and structural anchoring (not a broad substring
 * search) is what keeps that prose-quoting case from being misread as the
 * error template.
 *
 * A CONFIGURED NON-COPILOT primary bot keeps the pre-#3265 behavior
 * unchanged (only the exact #3015 error template is excluded; a body-less
 * or otherwise unrecognized-shaped review still counts) -- no shape
 * signatures are known for an arbitrary bot, so a positive-signature
 * requirement would silently break every existing non-Copilot caller.
 */
export function findLastCopilotReviewCommit(
  reviews: ReviewLike[],
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): string {
  const isDefaultCopilotBot =
    normalizePrimaryBotLogin(primaryBotLogin) ===
    DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const latest = reviews
    .filter((review) => {
      if (
        !isCopilotReviewerLogin(
          review.user?.login ?? review.author?.login ?? '',
          primaryBotLogin,
          review.user?.type ?? review.author?.type ?? null,
        )
      ) {
        return false;
      }
      if (!isDefaultCopilotBot) {
        return !isCopilotErrorReviewBody(review.body);
      }
      const { shape } = classifyCopilotReviewBody(review.body);
      return shape === 'overview-v2' || shape === 'overview-legacy';
    })
    .map((review) => ({
      submittedAt: review.submitted_at ?? review.submittedAt ?? '',
      commitId: review.commit_id ?? review.commitId ?? '',
    }))
    .sort((left, right) =>
      compareIsoTimestamps(left.submittedAt, right.submittedAt),
    )
    .at(-1);

  return latest?.commitId ?? '';
}

export function isCopilotPending(
  requestedReviewers: RequestedReviewerLike[],
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  return requestedReviewers.some((reviewer) => {
    if (typeof reviewer === 'string') {
      return isCopilotReviewerLogin(reviewer, primaryBotLogin);
    }
    return isCopilotReviewerLogin(
      reviewer?.login ?? reviewer?.user?.login ?? '',
      primaryBotLogin,
    );
  });
}

export function computeCopilotPendingCoversHead(
  timelineEvents: TimelineEventLike[],
  prHeadSha: string,
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  let headIndex = -1;
  let requestIndex = -1;

  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }

    if (eventName === 'review_requested') {
      const reviewerLogin = event?.requested_reviewer?.login ?? '';
      if (isCopilotReviewerLogin(reviewerLogin, primaryBotLogin)) {
        requestIndex = index;
      }
    }
  });

  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}

/**
 * #2167: REST `requested_reviewers` can report empty (`{"users":[]}`) even
 * when Copilot review is still genuinely outstanding for the current HEAD --
 * observed on this source repository during PR #2158, where REST returned
 * an empty list (HTTP 200, not a 5xx) while GraphQL `reviewRequests` still
 * listed the primary bot and `computeCopilotPendingCoversHead` was already
 * `true`. `isCopilotPending` alone is REST-only and misses that case;
 * `evaluateAdvisoryWaitOutcome` / `evaluateAdvisoryWaitF3Outcome` and the
 * AW3 table are unchanged -- callers pass this corrected boolean into
 * `outcomeInput` exactly where the uncorrected `isCopilotPending` result
 * used to go, so the corrected pending bit flows through the existing
 * formulas unmodified.
 *
 * Precedence, cheapest signal first:
 * 1. REST `requestedReviewers` already lists the primary bot -> `true`.
 * 2. Already-fetched timeline evidence (`copilotPendingCoversHead`) shows
 *    the primary bot is still requested as of a HEAD the latest Copilot
 *    review does not cover -> `true`, no extra HTTP call needed.
 * 3. `graphqlRequestedReviewerLogins` -- an optional, already-fetched
 *    GraphQL `reviewRequests` login list; `null`/`undefined` means "not
 *    attempted, or the attempt failed" -- lists the primary bot -> `true`.
 * 4. Otherwise -> `false`, including when the optional GraphQL check was
 *    skipped or failed: an absent or failed GraphQL result keeps the
 *    REST-derived result rather than assuming pending.
 */
export function resolveCopilotPending(
  requestedReviewers: RequestedReviewerLike[],
  copilotPendingCoversHead: boolean,
  lastCopilotCommit: string,
  prHeadSha: string,
  graphqlRequestedReviewerLogins?: readonly string[] | null,
  primaryBotLogin: string = DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
): boolean {
  if (isCopilotPending(requestedReviewers, primaryBotLogin)) {
    return true;
  }
  if (copilotPendingCoversHead && lastCopilotCommit !== prHeadSha) {
    return true;
  }
  if (graphqlRequestedReviewerLogins) {
    return isCopilotPending(
      [...graphqlRequestedReviewerLogins],
      primaryBotLogin,
    );
  }
  return false;
}

/**
 * True when the OPTIONAL secondary advisory bot has already been requested for
 * the current HEAD — i.e. a `review_requested` event for `secondaryBotLogin`
 * follows the current HEAD's `committed` event in the PR timeline. This is the
 * once-per-HEAD guard for the non-gating secondary supplement (issue #1099),
 * reusing the same timeline evidence as {@link computeCopilotPendingCoversHead}
 * so no new marker is needed: when HEAD advances, the new `committed` event
 * sits after the prior secondary request and the guard resets to `false`.
 *
 * The secondary is matched by exact normalized login equality (NOT the Copilot
 * family). An empty `secondaryBotLogin` short-circuits to `false` so an
 * unconfigured secondary never matches anything.
 */
export function computeSecondaryRequestedForHead(
  timelineEvents: TimelineEventLike[],
  prHeadSha: string,
  secondaryBotLogin: string,
): boolean {
  const configured = String(secondaryBotLogin ?? '')
    .trim()
    .toLowerCase();
  if (configured === '') {
    return false;
  }

  let headIndex = -1;
  let requestIndex = -1;

  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? '');
    if (eventName === 'committed') {
      const sha = String(event?.sha ?? event?.commit_id ?? '');
      if (sha === prHeadSha) {
        headIndex = index;
      }
      return;
    }

    if (eventName === 'review_requested') {
      const reviewerLogin = String(event?.requested_reviewer?.login ?? '')
        .trim()
        .toLowerCase();
      if (reviewerLogin === configured) {
        requestIndex = index;
      }
    }
  });

  return headIndex !== -1 && requestIndex !== -1 && requestIndex > headIndex;
}

export function normalizeTrustedMarkerLogins(
  logins: unknown[] | null | undefined,
): string[] {
  return [
    ...new Set(
      (logins ?? [])
        .map((login) =>
          String(login ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Resolve the trusted marker actors for a read-only evidence helper.
 *
 * Precedence is strict: an explicit `--trusted-marker-logins` flag wins over
 * the `IDD_TRUSTED_MARKER_ACTORS` env var, which wins over the
 * `trustedMarkerActors` array declared in `.github/idd/config.json`. The flag
 * and env var are CSV strings (or arrays); `config` is the parsed policy
 * object. The returned `source` records which input supplied the value so the
 * helper can emit it as auditable JSON evidence.
 */
export function resolveTrustedMarkerActors({
  flagValue = '',
  envValue = '',
  config = null,
}: {
  flagValue?: string | string[];
  envValue?: string | string[];
  config?: { trustedMarkerActors?: unknown } | null;
} = {}): TrustedMarkerActorResolution {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { actors: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { actors: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    return { actors: fromConfig, source: 'config' };
  }
  return { actors: [], source: 'none' };
}

/**
 * kurone-kito/idd-skill#3250: the single trusted-marker-login composition
 * every waiver-authority-consuming caller (`pre-merge-readiness.mts`,
 * `advisory-convergence.mts`, `external-check-waiver.mts`'s waiver reuse
 * scan and post-write reconcile) must build its
 * `summarizeExternalCheckWaivers` `trustedMarkerLogins` from, so the set is
 * computed in exactly one place instead of three near-identical inline
 * compositions. Combines the viewer login, the already flag/env/config-
 * resolved actors (`resolveTrustedMarkerActors`), and an already-resolved
 * collaborator-marker-trust login list. Each caller still resolves that
 * last list itself -- `resolveTrustedCollaboratorMarkerLogins` stays
 * file-local per its own doc comment (different files apply different
 * `gh`-call loop-safety wrappers) -- and passes the result in here rather
 * than this function reaching for a port/comments itself.
 *
 * Adds no implicit repository-owner entry. An owner who authors these
 * markers must be explicitly listed in `trustedMarkerActors`, exactly as
 * the gates already required before kurone-kito/idd-skill#3250. #3251
 * moved the remaining consumers (`resolveLinkedIssueCandidates`,
 * `local-validation-evidence` resolve mode, and
 * `provider-outage-declaration` `list-advanced`) onto this same
 * composition via {@link composeGateTrustedMarkerLogins}.
 */
export function buildEffectiveTrustedMarkerLogins({
  viewerLogin,
  configuredTrustedActors,
  collaboratorMarkerLogins = [],
}: {
  viewerLogin: string;
  configuredTrustedActors: readonly unknown[];
  collaboratorMarkerLogins?: readonly unknown[];
}): string[] {
  return normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...collaboratorMarkerLogins,
  ]);
}

/**
 * kurone-kito/idd-skill#3251: the flag/env/config ladder plus
 * {@link buildEffectiveTrustedMarkerLogins}, so a helper's trusted set
 * for a given viewer, flag, env, config, and collaborator-login list
 * equals the set `pre-merge-readiness` builds for those same inputs.
 * Adds no implicit repository owner. Callers still resolve collaborator
 * logins themselves (and pass `[]` when collaborator-marker trust is
 * off) and still load `config` from a trusted ref, never the local
 * worktree.
 */
export function composeGateTrustedMarkerLogins({
  viewerLogin,
  flagValue = '',
  envValue = '',
  config = null,
  collaboratorMarkerLogins = [],
}: {
  viewerLogin: string;
  flagValue?: string | string[];
  envValue?: string | string[];
  config?: { trustedMarkerActors?: unknown } | null;
  collaboratorMarkerLogins?: readonly unknown[];
}): string[] {
  const { actors: configuredTrustedActors } = resolveTrustedMarkerActors({
    flagValue,
    envValue,
    config,
  });
  return buildEffectiveTrustedMarkerLogins({
    viewerLogin,
    configuredTrustedActors,
    collaboratorMarkerLogins,
  });
}

function trustedMarkerActorTokens(value: unknown): unknown[] {
  return Array.isArray(value) ? value : String(value ?? '').split(',');
}

export function unionTrustedMarkerActorSources({
  envValue = '',
  config = null,
  extraActors = [],
  extraSource = '',
}: {
  envValue?: string | string[];
  config?: { trustedMarkerActors?: unknown } | null;
  extraActors?: unknown[];
  extraSource?: string;
} = {}): TrustedMarkerActorSourceMix {
  const sources: string[] = [];
  const actors: string[] = [];
  const extras = normalizeTrustedMarkerLogins(extraActors);
  if (extras.length > 0) {
    actors.push(...extras);
    if (extraSource) {
      sources.push(extraSource);
    }
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    actors.push(...fromEnv);
    sources.push('env');
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.trustedMarkerActors)
      ? config.trustedMarkerActors
      : [],
  );
  if (fromConfig.length > 0) {
    actors.push(...fromConfig);
    sources.push('config');
  }
  return { actors: normalizeTrustedMarkerLogins(actors), sources };
}

export function resolveAdvisoryBotLogins({
  flagValue = '',
  envValue = '',
  config = null,
}: {
  flagValue?: string | string[];
  envValue?: string | string[];
  config?: { advisoryBotLogins?: unknown } | null;
} = {}): AdvisoryBotLoginResolution {
  const fromFlag = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(flagValue),
  );
  if (fromFlag.length > 0) {
    return { logins: fromFlag, source: 'flag' };
  }
  const fromEnv = normalizeTrustedMarkerLogins(
    trustedMarkerActorTokens(envValue),
  );
  if (fromEnv.length > 0) {
    return { logins: fromEnv, source: 'env' };
  }
  const fromConfig = normalizeTrustedMarkerLogins(
    Array.isArray(config?.advisoryBotLogins) ? config.advisoryBotLogins : [],
  );
  if (fromConfig.length > 0) {
    return { logins: fromConfig, source: 'config' };
  }
  return { logins: [], source: 'none' };
}

export function deriveIddAgentLogins({
  viewerLogin = '',
  iddAgentLogins = [],
  trustedMarkerLogins = [],
  operationalComments = [],
}: {
  viewerLogin?: string;
  iddAgentLogins?: unknown[] | null;
  trustedMarkerLogins?: unknown[] | null;
  operationalComments?: CommentLike[] | null;
} = {}): string[] {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  const derivedLogins = [viewerLogin, ...(iddAgentLogins ?? [])];

  for (const comment of operationalComments ?? []) {
    const authorLogin = String(
      comment?.author?.login ?? comment?.user?.login ?? '',
    )
      .trim()
      .toLowerCase();
    const body = String(comment?.body ?? '');
    const markerPrefix = operationalMarkerPrefix(body);
    if (
      !trustedLogins.has(authorLogin) ||
      !markerPrefix ||
      !IDD_AGENT_DERIVED_MARKERS.has(markerPrefix)
    ) {
      continue;
    }
    derivedLogins.push(authorLogin);
  }

  return normalizeTrustedMarkerLogins(derivedLogins);
}

export function summarizeAdvisoryWaitMarkers(
  comments: CommentLike[],
  prHeadSha: string,
  trustedMarkerLogins: unknown[] | null | undefined,
): AdvisoryWaitMarkerSummary {
  const trustedLogins = new Set(
    normalizeTrustedMarkerLogins(trustedMarkerLogins),
  );
  let earliestSameHeadAt = '';
  let trustedSameHeadMarkerCount = 0;
  let trustedSameHeadRequestMarkerCount = 0;
  let trustedRequestMarkerCount = 0;
  let untrustedSameHeadMarkerCount = 0;
  let untrustedRequestMarkerCount = 0;

  for (const comment of comments) {
    const body = String(comment?.body ?? '').trimEnd();
    const login = String(comment?.author?.login ?? comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    // #3249: a trusted login alone is not enough -- an edited (or
    // edit-state-unresolved) `advisory-wait:` marker must never satisfy or
    // relax this gate.
    const trusted =
      trustedLogins.has(login) &&
      classifyCommentEditState(comment) === 'unedited';
    const isSameHeadMarker = advisoryWaitMarkerMatchesHead(body, prHeadSha);
    const isRequestMarker = advisoryWaitRequestMarker(body);

    if (isSameHeadMarker) {
      if (trusted) {
        trustedSameHeadMarkerCount += 1;
        if (isRequestMarker) {
          trustedSameHeadRequestMarkerCount += 1;
        }
        const createdAt = String(
          comment?.createdAt ?? comment?.created_at ?? '',
        );
        if (
          isValidIsoTimestamp(createdAt) &&
          (!earliestSameHeadAt ||
            compareIsoTimestamps(createdAt, earliestSameHeadAt) < 0)
        ) {
          earliestSameHeadAt = createdAt;
        }
      } else {
        untrustedSameHeadMarkerCount += 1;
      }
    }

    if (isRequestMarker) {
      if (trusted) {
        trustedRequestMarkerCount += 1;
      } else {
        untrustedRequestMarkerCount += 1;
      }
    }
  }

  return {
    sameHeadMarkerPresent: trustedSameHeadMarkerCount > 0,
    sameHeadRequestMarkerPresent: trustedSameHeadRequestMarkerCount > 0,
    earliestSameHeadAt,
    sameHeadMarkerCount: trustedSameHeadMarkerCount,
    requestMarkerCount: trustedRequestMarkerCount,
    trustedSameHeadMarkerCount,
    untrustedSameHeadMarkerCount,
    trustedRequestMarkerCount,
    untrustedRequestMarkerCount,
  };
}

export function evaluateAdvisoryWaitOutcome(
  input: AdvisoryWaitOutcomeInput,
): string {
  const { requestCap, pendingWindowMinutes, settledWindowMinutes } =
    normalizeAdvisoryWaitRuntimeOptions(input);

  if (input.lastCopilotCommit === input.prHeadSha) {
    return 'SATISFIED';
  }

  if (input.copilotPending) {
    if (!input.sameHeadMarkerPresent) {
      return input.copilotPendingCoversHead
        ? 'RECOVERY_NEEDED'
        : input.requestMarkerCount >= requestCap
          ? 'CAP_EXHAUSTED'
          : 'REQUEST_NEEDED';
    }
    return input.elapsedMinutes >= pendingWindowMinutes ? 'SATISFIED' : 'WAIT';
  }

  if (!input.sameHeadMarkerPresent) {
    return input.requestMarkerCount >= requestCap
      ? 'CAP_EXHAUSTED'
      : 'REQUEST_NEEDED';
  }

  return input.elapsedMinutes >= settledWindowMinutes ? 'SATISFIED' : 'WAIT';
}

// F3 deliberately has a separate outcome from evaluateAdvisoryWaitOutcome:
// once Copilot is no longer pending (review submitted or cancelled), F3
// treats the advisory wait as SATISFIED so a settled-but-not-re-reviewed
// HEAD can merge, even while the shared `outcome` still routes E14/F2 to
// REQUEST_NEEDED. F3 reads f3Outcome exclusively when helper output is
// valid; see idd-advisory-wait.instructions.md §1 (F3-specific interpretation).
export function evaluateAdvisoryWaitF3Outcome(
  input: AdvisoryWaitOutcomeInput,
): string {
  if (input.lastCopilotCommit === input.prHeadSha || !input.copilotPending) {
    return 'SATISFIED';
  }
  return evaluateAdvisoryWaitOutcome(input);
}

export function buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews = [],
    requestedReviewers = [],
    timelineEvents = [],
    comments = [],
    graphqlRequestedReviewerLogins = null,
  }: {
    prHeadSha: string;
    reviews?: ReviewLike[];
    requestedReviewers?: RequestedReviewerLike[];
    timelineEvents?: TimelineEventLike[];
    comments?: CommentLike[];
    /** #2167: optional, already-fetched GraphQL `reviewRequests` login
     * list, consulted only when REST and timeline evidence are both
     * inconclusive; `null` (the default) means "not attempted, or the
     * attempt failed" -- see {@link resolveCopilotPending}. */
    graphqlRequestedReviewerLogins?: readonly string[] | null;
  },
  options: {
    now?: string;
    trustedMarkerLogins?: unknown[] | null;
    configuredTrustedActors?: unknown[] | null;
    viewerLogin?: string | null;
    collaboratorTrustEnabled?: boolean;
    requestCap?: number;
    pendingWindowMinutes?: number;
    settledWindowMinutes?: number;
    pollIntervalMinutes?: number;
    capExhaustedRoute?: string;
    primaryBotLogin?: string;
    // Legacy single-login form (#1099), kept for existing callers. #3186's
    // `secondaryBotLogins` (plural) is preferred and wins when both are
    // present -- see the secondary-bot section below.
    secondaryBotLogin?: string;
    secondaryBotLogins?: unknown;
  } = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const configuredTrustedActors = normalizeTrustedMarkerLogins(
    options.configuredTrustedActors ?? [],
  );
  const primaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const markerSummary = summarizeAdvisoryWaitMarkers(
    comments,
    prHeadSha,
    trustedMarkerLogins,
  );
  const elapsedMinutes = markerSummary.sameHeadMarkerPresent
    ? minutesBetweenIso(markerSummary.earliestSameHeadAt, now)
    : 0;
  const lastCopilotCommit = findLastCopilotReviewCommit(
    reviews,
    primaryBotLogin,
  );
  const copilotPendingCoversHead = computeCopilotPendingCoversHead(
    timelineEvents,
    prHeadSha,
    primaryBotLogin,
  );
  const copilotPending = resolveCopilotPending(
    requestedReviewers,
    copilotPendingCoversHead,
    lastCopilotCommit,
    prHeadSha,
    graphqlRequestedReviewerLogins,
    primaryBotLogin,
  );
  const {
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
  } = normalizeAdvisoryWaitRuntimeOptions(options);

  const outcomeInput = {
    lastCopilotCommit,
    prHeadSha,
    copilotPending,
    copilotPendingCoversHead,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    requestMarkerCount: markerSummary.requestMarkerCount,
    elapsedMinutes,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
  };
  const outcome = evaluateAdvisoryWaitOutcome(outcomeInput);
  const f3Outcome = evaluateAdvisoryWaitF3Outcome(outcomeInput);

  // Optional NON-GATING secondary advisory bot(s) (issue #1099; #3186 for the
  // list form). Resolved AFTER `outcome` and never fed into `outcomeInput`,
  // so it/they can never satisfy or alter the primary advisory-wait gate
  // (contract a). The plural `secondaryBotLogins` option wins when present;
  // the legacy singular `secondaryBotLogin` is treated as its one-element
  // form for existing callers. Any entry equal to the primary is dropped
  // (misconfiguration guard) by `normalizeSecondaryBotLoginList`.
  const secondaryBotLogins = normalizeSecondaryBotLoginList(
    options.secondaryBotLogins ?? options.secondaryBotLogin,
    primaryBotLogin,
  );
  // Request each resolved login once per HEAD only when a follow-up pass is
  // genuinely needed (the primary has not reviewed HEAD) AND the primary is
  // cap-exhausted, or stalled/rate-limited (the wait was closed by the elapsed
  // settle/pending window rather than by a HEAD review). REQUEST_NEEDED (primary
  // still requestable), WAIT (still in-window), and RECOVERY_NEEDED (active
  // recovery) deliberately do not trigger the supplement.
  const secondaryTriggerMet =
    lastCopilotCommit !== prHeadSha &&
    (outcome === 'CAP_EXHAUSTED' ||
      (outcome === 'SATISFIED' && markerSummary.sameHeadMarkerPresent));
  // Once per HEAD per login, read from the GitHub timeline (a
  // `review_requested` for that login after the current HEAD's `committed`
  // event) — no marker is posted for any secondary, so none of them ever
  // receive a primary `advisory-wait` marker or burn the primary cap
  // (contract b).
  const secondaryRequestLogins = secondaryTriggerMet
    ? secondaryBotLogins.filter(
        (login) =>
          !computeSecondaryRequestedForHead(timelineEvents, prHeadSha, login),
      )
    : [];
  const secondaryRequestNeeded = secondaryRequestLogins.length > 0;

  return {
    protocolVersion: '1',
    prHeadSha,
    lastCopilotCommit,
    copilotPending,
    copilotPendingCoversHead,
    outcome,
    f3Outcome,
    // #3186: authoritative only when exactly one login is configured; '' on
    // both 0 (unconfigured) and >1 (use secondaryBotLogins instead).
    secondaryBotLogin:
      secondaryBotLogins.length === 1 ? secondaryBotLogins[0] : '',
    secondaryBotLogins,
    secondaryRequestLogins,
    secondaryRequestNeeded,
    now,
    requestCap,
    pendingWindowMinutes,
    settledWindowMinutes,
    pollIntervalMinutes,
    capExhaustedRoute,
    elapsedMinutes,
    sameHeadMarkerPresent: markerSummary.sameHeadMarkerPresent,
    sameHeadRequestMarkerPresent: markerSummary.sameHeadRequestMarkerPresent,
    earliestSameHeadAt: markerSummary.earliestSameHeadAt,
    sameHeadMarkerCount: markerSummary.sameHeadMarkerCount,
    requestMarkerCount: markerSummary.requestMarkerCount,
    trustedMarkerSummary: {
      viewerLogin: String(options.viewerLogin ?? '')
        .trim()
        .toLowerCase(),
      configuredTrustedActors,
      collaboratorTrustEnabled: Boolean(options.collaboratorTrustEnabled),
      trustedMarkerLogins,
      trustedSameHeadMarkerCount: markerSummary.trustedSameHeadMarkerCount,
      untrustedSameHeadMarkerCount: markerSummary.untrustedSameHeadMarkerCount,
      trustedRequestMarkerCount: markerSummary.trustedRequestMarkerCount,
      untrustedRequestMarkerCount: markerSummary.untrustedRequestMarkerCount,
    },
  };
}

export function buildActivitySnapshotSummary(
  {
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
  }: {
    comments?: CommentLike[];
    reviews?: ReviewLike[];
    threads?: ThreadLike[];
    checks?: CheckLike[];
  },
  options: {
    trustedMarkerLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    dispositionAuthorLogins?: unknown[] | null;
    advisoryBotLoginsSource?: unknown;
  } = {},
) {
  const trustedMarkerLogins = new Set(
    (options.trustedMarkerLogins ?? [])
      .map((login) =>
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const dispositionAuthorLogins = new Set(
    normalizeTrustedMarkerLogins(options.dispositionAuthorLogins ?? []),
  );
  // An advisory bot can never anchor "dispositions exist": its own
  // **Accepted**/**Rejected**-shaped replies must not start the
  // post-disposition window that classifies its later acks. Excludes via
  // `isConfiguredAdvisoryBotLogin`, not a plain `Set.has`/`.delete`, so a
  // `[bot]`-suffix mismatch between `dispositionAuthorLogins` and
  // `advisoryBotLogins` (e.g. one storing GitHub's suffixed `dual-bot[bot]`
  // author-login form, the other the supported suffixless `dual-bot` form,
  // #2014) still excludes the shared login -- the same normalized identity
  // every other advisory-bot recognition in this file already uses.
  for (const login of [...dispositionAuthorLogins]) {
    if (isConfiguredAdvisoryBotLogin(login, advisoryBotLogins)) {
      dispositionAuthorLogins.delete(login);
    }
  }
  const isAdvisoryBot = (login: unknown) =>
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins);
  const isDispositionAuthor = (login: unknown) =>
    dispositionAuthorLogins.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  // #2014: `isDispositionComment` alone (the `**Accepted**`/`**Rejected**`
  // prefixes) misses the terminal `**Rejection confirmed by maintainer**`
  // marker (`isRejectionConfirmedDisposition`) that E6
  // (idd-review-triage.instructions.md) posts instead of a fresh
  // `**Rejected**` re-post once a maintainer agrees an
  // `**Awaiting maintainer decision**` item needs no action -- a disposition
  // is a disposition regardless of which of the two terminal shapes it took.
  // `classifyThreadAckOnlyPostDisposition` already recognizes both, but ONLY
  // as a reply on a resolved review thread
  // (the marker's own contract, `isRejectionConfirmedDisposition`'s doc
  // comment above). `filteredComments` below are plain top-level PR
  // comments with no thread/resolved concept at all, so they must keep
  // using plain `isDispositionComment` -- recognizing the terminal marker
  // there would accept it as a disposition anchor with no resolved-thread
  // context to validate it against (Copilot review, #2014 PR #2029).
  // Thread-scoped variant: recognizes the terminal rejection-confirmed
  // marker only while its own thread is still resolved, mirroring
  // `hasFreshDisposition`'s identical `threadResolved` gate above -- once a
  // thread is reopened, the marker's "nothing more to do here" claim is
  // stale for that thread. Needed specifically for the cross-thread global
  // scan below (`dispositionCreatedAts`'s `threads.flatMap`), which pools
  // every thread's replies into one PR-wide anchor: without this gate, a
  // stale rejection-confirmed reply on a since-reopened thread could still
  // anchor the window that misclassifies an unrelated, brand-new
  // advisory-bot comment elsewhere on the PR as ack-only. This is the ONLY
  // place the combined (`isDispositionComment` OR
  // `isRejectionConfirmedDisposition`) recognition applies outside a
  // thread whose `isResolved` is already independently confirmed true.
  const isDispositionMarkerComment = (comment: { body?: string | null }) =>
    isDispositionComment(comment) || isRejectionConfirmedDisposition(comment);
  const isDispositionMarkerCommentForThread = (
    comment: { body?: string | null },
    threadResolved: boolean,
  ) =>
    isDispositionComment(comment) ||
    (threadResolved && isRejectionConfirmedDisposition(comment));

  // #3194 (round 36 field feedback): a live-status digest edit must never
  // perturb review-currency (idd-overview-appendix.instructions.md's "Live
  // status digest" section). #3267 routes this exclusion through the
  // shared `classifyIddPrComment` -- the same decision
  // `summarizeRegularCommentsForGate` / `summarizeDispositionEvidenceForGate`
  // use -- which additionally recognizes the historical and repair-evidence
  // digest forms (not just the current one #3194/#3337 originally covered)
  // and the narrow `github-actions[bot]` external-check-waiver /
  // cleanup-evidence shapes. Only a trusted author's operational-marker or
  // digest-marker comment is excluded here; an untrusted actor's
  // marker-shaped comment counts as ordinary activity requiring
  // disposition, matching the documented digest contract
  // (`idd-comment-minimization.md`'s "Live Status Digest Contract"). This
  // function does not pass `iddAgentLogins` -- only
  // `summarizeRegularCommentsForGate` / `summarizeDispositionEvidenceForGate`
  // need that extra trust source (see `classifyIddPrComment`'s own doc
  // comment).
  const filteredComments = comments.filter(
    (comment) =>
      classifyIddPrComment(comment, {
        trustedMarkerLogins: [...trustedMarkerLogins],
      }) !== 'idd-operational',
  );

  // Structural ack-only evidence (#858): the posting moment of the latest
  // disposition by a configured disposition author opens the window;
  // comments and resolved-thread replies are classified per item below.
  // Dispositions are not SHA-bound here — the head-changed check in
  // diffReviewSnapshot plus the unchanged disposition-evidence and
  // unreplied-comment gates backstop that residual.
  const dispositionCreatedAts = [
    ...filteredComments
      .filter(
        (comment) =>
          isDispositionAuthor(comment.author?.login) &&
          classifyCommentEditState(comment) === 'unedited' &&
          isDispositionComment(comment),
      )
      .map((comment) => comment.createdAt),
    ...threads.flatMap((thread) =>
      (thread.comments?.nodes ?? [])
        .filter(
          (comment) =>
            isDispositionAuthor(comment.author?.login) &&
            classifyCommentEditState(comment) === 'unedited' &&
            isDispositionMarkerCommentForThread(
              comment,
              Boolean(thread.isResolved),
            ),
        )
        .map((comment) =>
          // An unedited **Rejection confirmed by maintainer** marker anchors
          // by its effective (updatedAt-preferring) activity, matching
          // classifyThreadAckOnlyPostDisposition's choice for the same
          // marker (#2045). Edited or edit-state-unknown markers never anchor
          // this window (#3249); ordinary unedited Accepted/Rejected markers
          // keep the pre-existing createdAt anchor.
          isRejectionConfirmedDisposition(comment)
            ? effectiveThreadCommentActivityAt(comment, advisoryBotLogins)
            : comment.createdAt,
        ),
    ),
  ].filter(isValidIsoTimestamp);
  const latestDispositionAt = maxIsoTimestamp(dispositionCreatedAts) ?? null;

  const isAckOnlyComment = (comment: CommentLike) => {
    if (!latestDispositionAt) {
      return false;
    }
    if (!isAdvisoryBot(comment.author?.login)) {
      return false;
    }
    if (isDispositionComment(comment)) {
      return false;
    }
    const activityAt = comment.updatedAt ?? comment.createdAt;
    if (!isValidIsoTimestamp(activityAt)) {
      return false;
    }
    return compareIsoTimestamps(activityAt, latestDispositionAt) > 0;
  };
  const ackOnlyComments = filteredComments.filter(isAckOnlyComment);
  const ackOnlyCommentSet = new Set(ackOnlyComments);

  // On a resolved thread whose latest reply chain contains a disposition,
  // later advisory-bot replies are structurally ack-only; the effective
  // thread activity is recomputed from the remaining replies. Reopened
  // (unresolved) threads always keep their raw activity.
  const threadEffective = threads.map((thread) => {
    const nodes = thread.comments?.nodes ?? [];
    const threadDispositionAt =
      maxIsoTimestamp(
        nodes
          .filter(
            (comment) =>
              isDispositionAuthor(comment.author?.login) &&
              classifyCommentEditState(comment) === 'unedited' &&
              isDispositionMarkerCommentForThread(
                comment,
                Boolean(thread.isResolved),
              ),
          )
          .map((comment) =>
            isRejectionConfirmedDisposition(comment)
              ? effectiveThreadCommentActivityAt(comment, advisoryBotLogins)
              : comment.createdAt,
          )
          .filter(isValidIsoTimestamp),
      ) ?? null;
    // Per-reply attribution needs the reply timeline: when a caller
    // populates thread.updatedAt we cannot tell whether it reflects an
    // ack or substantive activity, so fail closed and keep raw activity
    // (production normalizers blank thread.updatedAt to opt in).
    if (
      !thread.isResolved ||
      !threadDispositionAt ||
      isValidIsoTimestamp(thread.updatedAt ?? '')
    ) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplies = nodes.filter((comment) => {
      if (!isAdvisoryBot(comment.author?.login)) {
        return false;
      }
      if (isDispositionMarkerComment(comment)) {
        return false;
      }
      const activityAt = effectiveThreadCommentActivityAt(
        comment,
        advisoryBotLogins,
      );
      return (
        isValidIsoTimestamp(activityAt) &&
        compareIsoTimestamps(activityAt, threadDispositionAt) > 0
      );
    });
    if (ackReplies.length === 0) {
      return { activityAt: threadActivityAt(thread), ackReplies: [] };
    }
    const ackReplySet = new Set(ackReplies);
    const keptActivities = nodes
      .filter((comment) => !ackReplySet.has(comment))
      .flatMap((comment) => [comment.updatedAt, comment.createdAt])
      .filter(isValidIsoTimestamp);
    return { activityAt: maxIsoTimestamp(keptActivities), ackReplies };
  });
  const ackOnlyThreadReplies = threadEffective.flatMap(
    (entry) => entry.ackReplies,
  );

  const commentActivities = filteredComments
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const reviewActivities = reviews
    .map((review) => review.updatedAt ?? review.submittedAt ?? review.createdAt)
    .filter(isValidIsoTimestamp);
  const threadActivities = threads
    .map((thread) => threadActivityAt(thread))
    .filter(isValidIsoTimestamp);

  const latestCiCompletedAt =
    maxIsoTimestamp(
      checks.map((check) => check.completedAt).filter(isCompletedCiTimestamp),
    ) ?? 'none';

  const latestPassingCiCompletedAt =
    maxIsoTimestamp(
      checks
        .filter((check) => {
          const state = String(check.state ?? '').toUpperCase();
          return ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(
            state,
          );
        })
        .map((check) => check.completedAt)
        .filter(isCompletedCiTimestamp),
    ) ?? 'none';

  const maxActivityUpdatedAt =
    maxIsoTimestamp([
      ...commentActivities,
      ...reviewActivities,
      ...threadActivities,
    ]) ?? 'none';

  const effectiveCommentActivities = filteredComments
    .filter((comment) => !ackOnlyCommentSet.has(comment))
    .map((comment) => comment.updatedAt ?? comment.createdAt)
    .filter(isValidIsoTimestamp);
  const effectiveThreadActivities = threadEffective
    .map((entry) => entry.activityAt)
    .filter(isValidIsoTimestamp);
  const effectiveMaxActivityUpdatedAt =
    maxIsoTimestamp([
      ...effectiveCommentActivities,
      ...reviewActivities,
      ...effectiveThreadActivities,
    ]) ?? 'none';

  const describeAckItem = (
    kind: string,
    comment: CommentLike | ThreadCommentLike,
    activityAt: unknown,
  ) => ({
    kind,
    id: String(comment.id ?? ''),
    author: String(comment.author?.login ?? '')
      .trim()
      .toLowerCase(),
    activityAt: isValidIsoTimestamp(activityAt) ? activityAt : 'none',
    bodyPreview: String(comment.body ?? '').slice(0, 120),
  });

  return {
    totalItemCount: filteredComments.length + reviews.length + threads.length,
    maxActivityUpdatedAt,
    latestCiCompletedAt,
    latestPassingCiCompletedAt,
    counts: {
      comments: filteredComments.length,
      reviews: reviews.length,
      threads: threads.length,
    },
    ackOnly: {
      advisoryBotLogins: [...advisoryBotLogins].sort(),
      source: String(options.advisoryBotLoginsSource ?? 'none'),
      dispositionsPresent: Boolean(latestDispositionAt),
      latestDispositionAt: latestDispositionAt ?? 'none',
      items: [
        ...ackOnlyComments.map((comment) =>
          describeAckItem(
            'comment',
            comment,
            comment.updatedAt ?? comment.createdAt,
          ),
        ),
        ...ackOnlyThreadReplies.map((comment) =>
          describeAckItem(
            'thread-reply',
            comment,
            effectiveThreadCommentActivityAt(comment, advisoryBotLogins),
          ),
        ),
      ],
    },
    effective: {
      maxActivityUpdatedAt: effectiveMaxActivityUpdatedAt,
      totalItemCount:
        filteredComments.length -
        ackOnlyComments.length +
        reviews.length +
        threads.length,
    },
  };
}

export function resolveLatestReviewWatermark(
  comments: CommentLike[],
  options: {
    expectedClaimId?: unknown;
    isTrustedAuthor?: (login: string) => boolean;
  } = {},
): ParsedReviewWatermark | null {
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);

  let latest: ParsedReviewWatermark | null = null;
  for (const comment of comments) {
    // #3249: a trusted author alone is not enough -- an edited (or
    // edit-state-unresolved) comment must never satisfy this gate, even
    // when its author is trusted. `isTrustEvidenceComment` folds the
    // author-trust check and the `unedited` requirement into one predicate.
    if (!isTrustEvidenceComment(comment, isTrustedAuthor)) {
      continue;
    }

    const parsed = parseReviewWatermarkComment(
      comment.body ?? '',
      comment.createdAt ?? comment.created_at ?? '',
    );
    if (!parsed) {
      continue;
    }
    // Exact claim-id match is intentional (#2080): a watermark records
    // what THIS claim-holder verified. A takeover starts a new restore
    // scope (`idd-review-snapshot.instructions.md`); do not treat the
    // predecessor `supersedes` id as a match the way
    // `summarizeExternalCheckWaivers` does for maintainer waivers.
    if (expectedClaimId && parsed.claimId !== expectedClaimId) {
      continue;
    }
    const parsedCreatedAt = normalizeComparableTimestamp(parsed.createdAt);
    if (parsedCreatedAt === null || parsedCreatedAt === 'none') {
      continue;
    }
    const latestCreatedAt = normalizeComparableTimestamp(
      latest?.createdAt ?? 'none',
    );
    if (
      latestCreatedAt === null ||
      latestCreatedAt === 'none' ||
      parsedCreatedAt > latestCreatedAt
    ) {
      latest = parsed;
    }
  }

  return latest;
}

/**
 * Scans the same trusted-author comment stream `resolveLatestReviewWatermark`
 * consumes for a `review-watermark`/`review-baseline`-shaped comment that is
 * malformed in either of two ways: (1) the body fails the strict canonical
 * `pattern` (e.g. a hand-authored note glued directly to the leading
 * underscore, `_IDD ...` with no space, missing
 * `OPTIONAL_IDD_VISIBLE_NOTE_PATTERN`'s `\bIDD\b` boundary), or (2) for
 * `review-watermark` specifically, the loose shape `pattern` accepts the
 * body (so `operationalMarkerPrefix` recognizes it) but the stricter
 * field-level `parseReviewWatermarkComment` rejects it -- e.g. a head SHA
 * shorter than the required 40 hex characters, or a timestamp field that is
 * neither a valid ISO-8601 string nor the literal `none` sentinel (#3339).
 * Either way, such a comment already reads as absent to
 * `resolveLatestReviewWatermark` (#2251) -- this gives the F2 caller a way
 * to tell "malformed marker found" apart from "no watermark-shaped comment
 * at all" without changing `resolveLatestReviewWatermark`'s own return
 * shape or selection behavior.
 *
 * `options.expectedClaimId`, when set, restricts the scan to a malformed
 * comment whose own claim-id token (the second token after the marker
 * label -- both `review-watermark` and `review-baseline` share that
 * position) matches, mirroring `resolveLatestReviewWatermark`'s own
 * exact claim-id filtering (#2080). Without this, a different claim's
 * malformed marker would flip `comparisonReason` to `'malformed-watermark'`
 * for a claim whose watermark is simply, genuinely absent (#2251 review
 * follow-up on PR #2387). The claim-id token is pulled directly from the
 * raw body (not via the full canonical parser, since a malformed comment
 * by definition fails that parse) -- both marker shapes' `malformedPrefixPattern`
 * guarantee `\S+\s+\S+` (agent, then claim id) immediately after the label.
 */
const MALFORMED_REVIEW_WATERMARK_CLAIM_ID_RE =
  /^<!--\s*(?:review-watermark|review-baseline):\s+\S+\s+(\S+)/i;

export function detectMalformedReviewWatermarkComments(
  comments: CommentLike[],
  options: {
    isTrustedAuthor?: (login: string) => boolean;
    expectedClaimId?: unknown;
  } = {},
): boolean {
  const isTrustedAuthor = options.isTrustedAuthor ?? (() => true);
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  return comments.some((comment) => {
    // #3249: same edit-state requirement as `resolveLatestReviewWatermark` --
    // an edited malformed-shaped comment must not be treated as evidence of
    // a genuinely malformed live watermark either.
    if (!isTrustEvidenceComment(comment, isTrustedAuthor)) {
      return false;
    }
    const body = comment.body ?? '';
    const label = detectMalformedOperationalMarker(body);
    const isShapeMalformed =
      label === '<!-- review-watermark:' || label === '<!-- review-baseline:';
    // #3339: OPERATIONAL_MARKER_ENTRIES' review-watermark shape `pattern`
    // uses `\S+` for the head-SHA and both timestamp fields, so
    // `operationalMarkerPrefix` already recognizes a body with e.g. a
    // 12-hex-char SHA or a non-ISO/non-`none` timestamp as a well-formed
    // marker -- `detectMalformedOperationalMarker` above then returns
    // `null` for it (already recognized, so "not malformed" from that
    // function's own point of view). `parseReviewWatermarkComment` then
    // separately rejects it (`[0-9a-f]{40}` / `isValidIsoTimestamp`), so
    // without this second check the comment silently reads as a genuinely
    // absent watermark instead of a malformed one. Scoped to
    // `review-watermark` only: no equivalent strict field parser exists
    // for `review-baseline`.
    const isFieldInvalidWatermark =
      !isShapeMalformed &&
      operationalMarkerPrefix(body) === '<!-- review-watermark:' &&
      parseReviewWatermarkComment(
        body,
        comment.createdAt ?? comment.created_at ?? '',
      ) === null;
    if (!isShapeMalformed && !isFieldInvalidWatermark) {
      return false;
    }
    if (!expectedClaimId) {
      return true;
    }
    // No trimStart: detectMalformedOperationalMarker already matched this
    // body's raw (untrimmed) bytes against the label's `^`-anchored
    // malformedPrefixPattern by this point (no leading-whitespace
    // tolerance, by design -- see that pattern's anti-spoofing note), so
    // matching raw `body` here stays consistent with that same anchor.
    const claimId = body.match(MALFORMED_REVIEW_WATERMARK_CLAIM_ID_RE)?.[1];
    return claimId === expectedClaimId;
  });
}

// Pre-merge gate invariant (unreplied regular comments -> `unrepliedComments`):
// does NOT feed `computePreMergeReadinessBlockers` (no code-rollup blocker), but
// it is NOT harmless -- the written F2 gate "Unreplied comments = 0" in
// `idd-pre-merge.instructions.md` routes any non-IDD regular comment without a
// later IDD reply back to review triage. So globally promoting a non-agent into
// `iddAgentLogins` filters that actor's genuine unreplied feedback out of the F2
// gate (fail-OPEN at the process level; its comments are excluded and its reply
// advances the watermark), while missing a real agent over-counts. See the
// consolidated invariants above `summarizeDispositionEvidenceForGate`
// (#1182 / PR #1184).
export function summarizeRegularCommentsForGate(
  comments: CommentLike[],
  options: {
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    trustedMarkerLogins?: unknown[] | null;
    threads?: ThreadLike[] | null;
  } = {},
): RegularCommentsGateSummary {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const threads = Array.isArray(options.threads) ? options.threads : [];
  // #3267: trusted set is the union of trustedMarkerLogins and
  // iddAgentLogins -- see classifyIddPrComment's own doc comment for why
  // excluding only trustedMarkerLogins fails open for an IDD agent's own
  // digest refresh posted under a login recorded only in iddAgentLogins.
  const isIddOperationalComment = (comment: {
    body: string;
    authorLogin: string;
  }) =>
    classifyIddPrComment(
      { body: comment.body, author: { login: comment.authorLogin } },
      {
        trustedMarkerLogins: [...trustedMarkerLogins],
        iddAgentLogins: [...iddAgentLogins],
      },
    ) === 'idd-operational';

  const normalized = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      // #3249: carried through so `isTrustedMachineDisposition` below can
      // require `unedited` -- never derived from `updatedAt`/`updated_at`.
      // Preserves `undefined` when neither source field was populated
      // (matches `classifyCommentEditState`'s own three-state contract: a
      // caller that never fetched edit state must read as `unknown`, not
      // silently coerce to `unedited` via a `null` default).
      lastEditedAt:
        comment.lastEditedAt !== undefined
          ? comment.lastEditedAt
          : comment.last_edited_at,
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const lastIddReplyAt = normalized.reduce((latestTimestamp, comment) => {
    if (
      isIddOperationalComment(comment) ||
      !iddAgentLogins.has(comment.authorLogin)
    ) {
      return latestTimestamp;
    }
    if (
      !latestTimestamp ||
      compareIsoTimestamps(comment.createdAt, latestTimestamp) > 0
    ) {
      return comment.createdAt;
    }
    return latestTimestamp;
  }, '');

  const classificationComments = normalized.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
  }));

  // #1182 A trusted-marker actor's machine-generated advisory disposition — and
  // the advisory-bot sticky it names, matched by bot + type + consumed 1:1 via
  // `matchTrustedAdvisoryStickyDispositions` — is not an unreplied comment.
  // Recognized per item, NOT by promoting the author to a global IDD agent (which
  // would fail the thread gate open) and NOT by advancing the `lastIddReplyAt`
  // watermark (which would clear unrelated earlier feedback). Keyed on the two
  // machine forms only, so a trusted human's ordinary `**Accepted**` /
  // `**Rejected**` review disposition stays a genuine comment.
  const isTrustedMachineDisposition = (
    authorLogin: string,
    body: string,
    lastEditedAt?: string | null,
  ) =>
    trustedMarkerLogins.has(authorLogin) &&
    classifyCommentEditState({ lastEditedAt }) === 'unedited' &&
    (isNonReviewNoticeDisposition({ body }) ||
      isReviewSummaryDisposition({ body }));
  const dispositionedStickyIndexes = matchTrustedAdvisoryStickyDispositions(
    normalized,
    advisoryBotLogins,
    trustedMarkerLogins,
    iddAgentLogins,
  );

  const items = normalized
    .filter((comment) => !isIddOperationalComment(comment))
    .filter((comment) => !iddAgentLogins.has(comment.authorLogin))
    .filter(
      (comment) =>
        !isTrustedMachineDisposition(
          comment.authorLogin,
          comment.body,
          comment.lastEditedAt,
        ) && !dispositionedStickyIndexes.has(comment.sortedIndex),
    )
    .filter(
      (comment) =>
        !lastIddReplyAt ||
        compareIsoTimestamps(lastIddReplyAt, comment.activityAt) <= 0,
    )
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
          },
        ) === null
      );
    })
    .map((comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
    }));

  return {
    count: items.length,
    items,
  };
}

// Pre-merge gate invariants -- READ BEFORE MODIFYING ANY `iddAgentLogins`-KEYED
// GATE HELPER. Three functions key disposition, reply, and thread-author
// recognition on `iddAgentLogins`, and each reacts DIFFERENTLY when that
// recognition is wrong:
//   1. `summarizeDispositionEvidenceForGate` (this fn) -- MERGE-BLOCKING (feeds
//      `computePreMergeReadinessBlockers` via `dispositionEvidence`). Both
//      recognition-error directions matter: FAILING to recognize a real agent
//      leaves its own disposition/reply in the outstanding set -> over-block
//      (fail-closed); GLOBALLY promoting a non-agent instead drops that actor's
//      genuine outstanding feedback (this fn excludes `iddAgentLogins` authors
//      from `outstandingComments`), so `blockingCount` can fall to 0 ->
//      fail-OPEN.
//   2. `summarizeReviewThreadsForGate` (`actionableCount`) -- MERGE-BLOCKING.
//      Without required conversation resolution, an IDD agent's latest thread
//      comment is `awaiting-reviewer` (non-blocking), so GLOBALLY promoting a
//      non-agent into `iddAgentLogins` makes that actor's genuine unresolved
//      feedback stop blocking -> fail-OPEN. This gate keys on latest-author
//      identity, not disposition recognition.
//   3. `summarizeRegularCommentsForGate` (`unrepliedComments`) -- does NOT feed
//      `computePreMergeReadinessBlockers`, but the written F2 gate "Unreplied
//      comments = 0" (`idd-pre-merge.instructions.md`) still consumes it, so
//      promoting a non-agent filters that actor's unreplied feedback out of
//      that gate -> fail-OPEN at the process level (not harmless).
// Across all three: never globally promote a non-agent into `iddAgentLogins` --
// recognize each item by its own author.
// Notice vs summary matching asymmetry (implemented and documented in detail on
// `matchTrustedAdvisoryStickyDispositions`): a non-review NOTICE disposition
// matches time-agnostically -- it carries forward across a re-posted notice
// while the bot still has not reviewed (the #1018 carry-forward) -- while a
// SUMMARY disposition must be STRICTLY NEWER than the sticky, so a stale
// `**Accepted**` cannot clear a summary re-edited after it (the #1122 "a false
// positive is a false merge" hazard).
// Working rule: verify every advisory finding on this code with a byte-exact
// repro before accepting it. #1182 / PR #1184 cycled through five advisory
// rounds, each surfacing a distinct fail mode of exactly these gates.
function isAdvisoryAuthoredThread(
  thread: ThreadLike,
  advisoryBotLogins: Set<string>,
): boolean {
  const originating = (thread.comments?.nodes ?? [])[0];
  return (
    isCopilotReviewerLogin(originating?.author?.login) ||
    isGateAdvisoryBotLogin(originating?.author?.login, advisoryBotLogins)
  );
}

function isIddOriginatedThreadReply(
  comment: { author?: AuthorRef | null; body?: string | null },
  options: {
    iddAgentLogins: Set<string>;
    trustedMarkerLogins: Set<string>;
    markerPrefix?: string;
  },
): boolean {
  const body = String(comment.body ?? '');
  if (isIddOriginatedReply(body, options.markerPrefix)) {
    return true;
  }
  const authorLogin = String(comment.author?.login ?? '')
    .trim()
    .toLowerCase();
  if (
    !authorLogin ||
    !(
      options.iddAgentLogins.has(authorLogin) ||
      options.trustedMarkerLogins.has(authorLogin)
    )
  ) {
    return false;
  }
  return (
    isDispositionComment({ body }) || isRejectionConfirmedDisposition({ body })
  );
}

// #978 advisory-only diagnostic, extracted from `summarizeDispositionEvidenceForGate`
// (#2618) so both the F2/F3 merge gate and F4's `audit-pr-cleanup` disposition
// checks share one implementation. A blocking resolved thread is
// "ack-only-post-disposition" when a thread-local IDD disposition exists and
// EVERY external comment newer than the disposition (and, when
// `snapshotBoundaryAt` is supplied, also newer than that boundary) is an
// advisory-bot, non-disposition courtesy ack. `snapshotBoundaryAt` is
// optional: F2/F3 passes the review-snapshot watermark so only feedback that
// re-blocks the gate counts; F4 has no such watermark and omits it, so every
// post-disposition external comment counts. Fails closed (false) without a
// thread-local disposition or for an unresolved thread, and never changes
// any caller's route by itself.
//
// #1313: also computes the narrower `inPlaceEditOnly` sibling signal in the
// same pass (it needs the identical `threadDispositionAt` /
// `postDispositionBlockingFeedback` groundwork, so folding it into one
// function avoids recomputing that twice). `inPlaceEditOnly` additionally
// requires every qualifying comment to be an in-place edit of content that
// already existed at-or-before the disposition (its own `createdAt` is not
// newer than the disposition, and its `updatedAt` is strictly newer than its
// own `createdAt`) rather than a brand-new post-disposition comment.
// Deliberately advisory-only, like its sibling: this heuristic itself
// (createdAt-at-or-before-disposition plus a later updatedAt) still
// cannot tell a cosmetic append from a substantive edit to the finding --
// #3269 corrects a related but narrower premise, that GitHub's API
// exposes no revision diff for an edited comment at all. It does
// (GraphQL `userContentEdits`), and `hasFreshDisposition`'s own dating
// (via `effectiveThreadCommentActivityAt`) now uses it, bounded to the
// two merge-gate collectors that fetch it; `inPlaceEditOnly` here keeps
// its own, separate, revision-content-blind heuristic unchanged.
export function classifyThreadAckOnlyPostDisposition(
  thread: ThreadLike,
  options: {
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    snapshotBoundaryAt?: string | null;
  } = {},
): { ackOnlyPostDisposition: boolean; inPlaceEditOnly: boolean } {
  const none = { ackOnlyPostDisposition: false, inPlaceEditOnly: false };
  if (!thread.isResolved) {
    return none;
  }
  const snapshotBoundaryAt = isValidIsoTimestamp(options.snapshotBoundaryAt)
    ? String(options.snapshotBoundaryAt)
    : null;
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  // #2014: an advisory bot can never anchor "a disposition exists" -- see
  // `summarizeDispositionEvidenceForGate`'s identical subtraction (this
  // file, "An advisory bot can never anchor..."). Scoped to only this
  // anchor set; the raw `iddAgentLogins` set above stays unchanged
  // everywhere else, since each caller reacts differently (fail-open vs.
  // fail-closed) to a global change.
  const ackAnchorAuthorLogins = new Set(
    [...iddAgentLogins].filter(
      (login) => !isConfiguredAdvisoryBotLogin(login, advisoryBotLogins),
    ),
  );
  const nodes = thread.comments?.nodes ?? [];
  // Recognize the same unedited dispositions `hasFreshDisposition` accepts
  // on a resolved thread (the gate that already decided this thread blocks):
  // a `**Accepted**`/`**Rejected**` marker OR the terminal
  // `**Rejection confirmed by maintainer**` marker. Edited or edit-state-
  // unknown markers cannot establish the ack-only window (#3249). The thread
  // is already known resolved here.
  const threadDispositionAt = maxIsoTimestamp(
    nodes
      .filter(
        (comment) =>
          ackAnchorAuthorLogins.has(
            String(comment.author?.login ?? '')
              .trim()
              .toLowerCase(),
          ) &&
          classifyCommentEditState(comment) === 'unedited' &&
          (isDispositionComment({ body: String(comment.body ?? '') }) ||
            isRejectionConfirmedDisposition({
              body: String(comment.body ?? ''),
            })),
      )
      .map((comment) =>
        effectiveThreadCommentActivityAt(comment, advisoryBotLogins),
      )
      .filter(isValidIsoTimestamp),
  );
  if (!threadDispositionAt) {
    return none;
  }
  // The blocking activity is external feedback newer than the thread
  // disposition (so already-dispositioned feedback predating the ack does
  // not disqualify the signal) and, when a snapshot boundary is supplied,
  // also newer than it (so it actually re-blocks that gate). Without a
  // boundary, every post-disposition external comment counts.
  const postDispositionBlockingFeedback = nodes.filter((comment) => {
    const authorLogin = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (
      !authorLogin ||
      iddAgentLogins.has(authorLogin) ||
      authorLogin === prAuthorLogin
    ) {
      return false;
    }
    const activityAt = effectiveThreadCommentActivityAt(
      comment,
      advisoryBotLogins,
    );
    return (
      isValidIsoTimestamp(activityAt) &&
      (!snapshotBoundaryAt ||
        compareIsoTimestamps(activityAt, snapshotBoundaryAt) > 0) &&
      compareIsoTimestamps(activityAt, threadDispositionAt) > 0
    );
  });
  if (postDispositionBlockingFeedback.length === 0) {
    return none;
  }
  // Each remaining item must be a pure advisory-bot courtesy ack: an
  // advisory-bot author whose body is neither a `**Accepted**`/`**Rejected**`
  // marker nor the terminal `**Rejection confirmed by maintainer**` marker,
  // AND (#2641) matches a known courtesy-acknowledgment template -- author +
  // shape alone no longer suffice, since a novel substantive comment that
  // merely doesn't use disposition phrasing must not misclassify as ack-only.
  const ackOnlyPostDisposition = postDispositionBlockingFeedback.every(
    (comment) =>
      isConfiguredAdvisoryBotLogin(comment.author?.login, advisoryBotLogins) &&
      !isDispositionComment({ body: String(comment.body ?? '') }) &&
      !isRejectionConfirmedDisposition({ body: String(comment.body ?? '') }) &&
      isKnownAdvisoryAckTemplate(comment),
  );
  if (!ackOnlyPostDisposition) {
    return none;
  }
  const inPlaceEditOnly = postDispositionBlockingFeedback.every((comment) => {
    const createdAt = String(comment.createdAt ?? '');
    const updatedAt = String(comment.updatedAt ?? '');
    return (
      isValidIsoTimestamp(createdAt) &&
      compareIsoTimestamps(createdAt, threadDispositionAt) <= 0 &&
      isValidIsoTimestamp(updatedAt) &&
      compareIsoTimestamps(updatedAt, createdAt) > 0
    );
  });
  return { ackOnlyPostDisposition, inPlaceEditOnly };
}

export function summarizeDispositionEvidenceForGate(
  {
    comments = [],
    threads = [],
  }: { comments?: CommentLike[]; threads?: ThreadLike[] },
  options: {
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    trustedMarkerLogins?: unknown[] | null;
    prAuthorLogin?: string | null;
    snapshotBoundaryAt?: string | null;
    markerPrefix?: string;
  } = {},
): DispositionEvidenceSummary {
  const iddAgentLogins = new Set(
    normalizeTrustedMarkerLogins(options.iddAgentLogins ?? []),
  );
  // The review-snapshot boundary (the active watermark's
  // max-activity-updatedAt). A resolved thread whose newest external feedback
  // predates it was settled before the snapshot and is out of E7 scope.
  const snapshotBoundaryAt = isValidIsoTimestamp(options.snapshotBoundaryAt)
    ? String(options.snapshotBoundaryAt)
    : null;
  const advisoryBotLogins = new Set(
    normalizeTrustedMarkerLogins(options.advisoryBotLogins ?? []),
  );
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  // #3267: trusted set is the union of trustedMarkerLogins and
  // iddAgentLogins -- see classifyIddPrComment's own doc comment.
  const isIddOperationalComment = (comment: {
    body: string;
    authorLogin: string;
  }) =>
    classifyIddPrComment(
      { body: comment.body, author: { login: comment.authorLogin } },
      {
        trustedMarkerLogins: [...trustedMarkerLogins],
        iddAgentLogins: [...iddAgentLogins],
      },
    ) === 'idd-operational';
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const explicitMarkerPrefix =
    typeof options.markerPrefix === 'string' ? options.markerPrefix.trim() : '';
  const configuredMarkerPrefix = String(
    loadIddConfig()?.markerPrefix ?? '',
  ).trim();
  const markerPrefix =
    explicitMarkerPrefix || configuredMarkerPrefix || undefined;

  const normalizedComments = comments
    .map((comment, inputIndex) => ({
      id: String(comment.id ?? ''),
      authorLogin: String(comment.author?.login ?? comment.user?.login ?? '')
        .trim()
        .toLowerCase(),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      updatedAt: String(comment.updatedAt ?? comment.updated_at ?? ''),
      // #3249: carried through for the edit-state checks below -- preserves
      // `undefined` when neither source field was populated (see the
      // matching comment in `summarizeRegularCommentsForGate`).
      lastEditedAt:
        comment.lastEditedAt !== undefined
          ? comment.lastEditedAt
          : comment.last_edited_at,
      inputIndex,
    }))
    .filter((comment) => isValidIsoTimestamp(comment.createdAt))
    .map((comment) => ({
      ...comment,
      activityAt: effectiveRegularCommentActivityAt(comment),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.activityAt);
      const rightTime = Date.parse(right.activityAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.inputIndex - right.inputIndex;
    })
    .map((comment, sortedIndex) => ({ ...comment, sortedIndex }));

  const classificationComments = normalizedComments.map((comment) => ({
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
  }));

  // #1182 trusted machine-disposition recognition, scoped to this gate. A
  // trusted-marker actor who authored one of the two machine-generated advisory
  // disposition forms `disposition-non-review-notices` emits — `**Rejected** —
  // {bot} did not review HEAD …` (`isNonReviewNoticeDisposition`) or
  // `**Accepted** — {bot} summary walkthrough …` (`isReviewSummaryDisposition`)
  // — must have that disposition honored even when the author was not resolved
  // into `iddAgentLogins` (e.g. a second trusted session posted it). It is
  // deliberately NOT promoted into a global IDD-agent identity: that same set is
  // passed to `summarizeReviewThreadsForGate`, where an IDD-agent's latest
  // thread comment is `awaiting-reviewer` rather than `actionable-blocking`, so
  // a global promotion would let the actor's genuine unresolved review feedback
  // stop blocking. Recognition stays HERE and covers ONLY the two machine forms
  // — never the general `**Accepted**` / `**Rejected**` prefix — so a trusted
  // human's ordinary review disposition is not swallowed. The disposition itself
  // is dropped from the outstanding set (below); the advisory sticky it clears is
  // matched by bot + type + 1:1 and bound to that item by
  // `matchTrustedAdvisoryStickyDispositions` — never joining the generic 1:1
  // pool, so a trusted disposition whose sticky is absent/already-resolved cannot
  // clear an unrelated human comment.
  const isTrustedMachineDisposition = (
    authorLogin: string,
    body: string,
    lastEditedAt?: string | null,
  ) =>
    trustedMarkerLogins.has(authorLogin) &&
    classifyCommentEditState({ lastEditedAt }) === 'unedited' &&
    (isNonReviewNoticeDisposition({ body }) ||
      isReviewSummaryDisposition({ body }));
  const trustedDispositionedStickyIndexes =
    matchTrustedAdvisoryStickyDispositions(
      normalizedComments,
      advisoryBotLogins,
      trustedMarkerLogins,
      iddAgentLogins,
    );

  const outstandingComments = normalizedComments
    .filter((comment) => !isIddOperationalComment(comment))
    .filter(
      (comment) =>
        !iddAgentLogins.has(comment.authorLogin) &&
        !isTrustedMachineDisposition(
          comment.authorLogin,
          comment.body,
          comment.lastEditedAt,
        ),
    )
    .filter((comment) => {
      if (!isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins)) {
        return true;
      }
      return (
        classifyRegularBotComment(
          {
            author: { login: comment.authorLogin },
            body: comment.body,
            createdAt: comment.createdAt,
          },
          classificationComments,
          threads,
          {
            isDispositionAuthor: (login) =>
              iddAgentLogins.has(
                String(login ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            // #3466: this gate has its own multi-bot-safe carry-forward for
            // a dispositioned Codex notice below (the #1018 loop, matched
            // per author via `dispositionNamesAdvisoryBot`), including
            // bookkeeping that marks the matched disposition consumed so it
            // can never leak into the generic 1:1 pairing pool. Do not opt
            // in here -- `includeCodexUsageLimitNotice` is for the
            // F4-cleanup caller only (`audit-pr-cleanup.mts`), which has no
            // such separate mechanism.
          },
        ) === null
      );
    });

  // Only IDD-agent dispositions feed the generic 1:1 pool. Trusted machine
  // dispositions are handled solely by `trustedDispositionedStickyIndexes`
  // (bot + type matched), so they can never clear an unrelated regular comment.
  // #3249: an edited (or edit-state-unresolved) disposition reply never
  // clears a regular comment -- it falls through to `outstandingComments`
  // above as ordinary external feedback instead, advancing freshness the
  // same way an edited thread disposition does in `hasFreshDisposition`.
  const dispositionComments = normalizedComments.filter(
    (comment) =>
      iddAgentLogins.has(comment.authorLogin) &&
      isDispositionComment({ body: comment.body }) &&
      classifyCommentEditState({ lastEditedAt: comment.lastEditedAt }) ===
        'unedited',
  );

  // #1018 non-review-notice carry-forward (fail-closed, author-scoped). A
  // persistent advisory non-review notice already dispositioned `**Rejected** —
  // {bot-login} did not review HEAD …` keeps that disposition across HEAD changes
  // while the bot still has not reviewed any HEAD: a Codex `updatedAt` bump or a
  // re-posted CodeRabbit rate-limit summary must not re-flag
  // `missing-disposition-evidence` for a notice the agent already rejected.
  //
  // Each carry-forward is matched strictly WITHIN one advisory-bot identity: a
  // notice carries forward only against a notice-disposition whose body names
  // that same bot's GitHub login. This repository can configure several advisory
  // bots at once (CodeRabbit + a Codex connector), so a count/order-only pairing
  // could credit bot A's disposition to bot B's still-undispositioned notice and
  // suppress a real blocker. An unattributable disposition (one that names no
  // configured bot login) carries nothing forward — the original re-disposition
  // churn, which is safe. Matched notices leave the outstanding set and the
  // matched notice-dispositions leave the general disposition pool, so a notice
  // disposition never also clears an unrelated regular comment and the notice's
  // bumped activity can never strand its disposition. The guard re-checks the
  // current notice body, so a notice the bot later replaces with a real review no
  // longer matches and still needs a fresh disposition. Any unmatched notice or
  // disposition falls through to the unchanged 1:1 pairing.
  const noticeDispositions = dispositionComments.filter((comment) =>
    isNonReviewNoticeDisposition({ body: comment.body }),
  );
  // #1833 diagnostic-only (see `NON_REVIEW_NOTICE_DISPOSITION_HINT` /
  // `DispositionEvidenceSummary.missingRegularComments[].hint`): IDD-agent
  // replies that start with `**Rejected**` -- so `isDispositionComment` and
  // the generic 1:1 pairing both accept them as SOME disposition -- but that
  // do not match `isNonReviewNoticeDisposition`'s stricter `did not review
  // HEAD` phrase requirement, so they can never satisfy the notice-specific
  // carry-forward above. Kept separate from `noticeDispositions` (its exact
  // complement within `**Rejected**`-prefixed replies) purely to power the
  // hint; never feeds `carriedNoticeIndexes`, `dispositionTimes`, or any
  // other routing input.
  //
  // Deliberately NOT attributed per-bot: `dispositionNamesAdvisoryBot`
  // (the carry-forward's own bot-attribution helper) can only anchor on the
  // canonical `did not review HEAD` template's span, so a wrong-phrase
  // reply -- missing that exact phrase by definition -- can never be
  // attributed to one bot over another by construction. In a multi-bot
  // scenario (e.g. CodeRabbit's notice correctly dispositioned, Codex's
  // still missing) the hint below attaches to every still-missing notice
  // that ANY wrong-phrase reply postdates, not just the one it may have
  // been intended for. Advisory-only, so this is a diagnostic false
  // positive at worst, never a routing change.
  const wrongPhraseRejectedDispositions = dispositionComments.filter(
    (comment) =>
      DISPOSITION_REJECTED_PREFIX_RE.test(comment.body.trimStart()) &&
      !isNonReviewNoticeDisposition({ body: comment.body }),
  );
  // #2249: a broader "close but not exact" pool, independent of the
  // #1833 non-review-notice pairing above. Sourced from ALL IDD-agent
  // comments (not just `dispositionComments`, which already requires
  // `isDispositionComment` to be true) because the motivating mistake --
  // a plain `Accepted — ...` / `Rejected — ...` reply with no bold
  // markdown at all -- never satisfies `isDispositionComment` in the
  // first place, so it would never appear in `dispositionComments`.
  // `!isDispositionComment` excludes any comment that is ALREADY a valid
  // disposition (e.g. `**Accepted**` is well-formed and needs no hint),
  // so this pool and `wrongPhraseRejectedDispositions` are disjoint by
  // construction: the latter's members all satisfy `isDispositionComment`.
  const malformedPrefixDispositions = normalizedComments.filter(
    (comment) =>
      iddAgentLogins.has(comment.authorLogin) &&
      MALFORMED_DISPOSITION_PREFIX_RE.test(comment.body.trimStart()) &&
      !isDispositionComment({ body: comment.body }),
  );
  const outstandingNotices = outstandingComments.filter(
    (comment) =>
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body),
  );
  const carriedNoticeIndexes = new Set<number>();
  const consumedNoticeDispositionIndexes = new Set<number>();
  const noticesByAuthor = new Map<string, typeof outstandingNotices>();
  for (const notice of outstandingNotices) {
    const list = noticesByAuthor.get(notice.authorLogin) ?? [];
    list.push(notice);
    noticesByAuthor.set(notice.authorLogin, list);
  }
  // Sort the bot logins for deterministic iteration order only. Each
  // author's own `matchingDispositions` is computed independently from the
  // full `noticeDispositions` pool -- never filtered by another author's
  // carry -- so a single disposition naming several configured bots
  // (`dispositionNamesAdvisoryBot` matches each one it names) can carry
  // forward one notice per bot it names, not just the alphabetically-first
  // bot processed (#2475). `matchingDispositions.length` still bounds
  // `carry` per author, so this author's own notices are never
  // over-credited from a single matching disposition.
  // `consumedNoticeDispositionIndexes` still accumulates the union of every
  // disposition consumed across every author -- read again below to
  // exclude those same comments from the separate generic 1:1 pool, so a
  // disposition that already carried a notice forward can never also clear
  // an unrelated regular comment there.
  for (const authorLogin of [...noticesByAuthor.keys()].sort()) {
    const notices = noticesByAuthor.get(authorLogin) ?? [];
    const matchingDispositions = noticeDispositions.filter((disposition) =>
      dispositionNamesAdvisoryBot(disposition.body, authorLogin),
    );
    const carry = Math.min(notices.length, matchingDispositions.length);
    for (let index = 0; index < carry; index += 1) {
      carriedNoticeIndexes.add(notices[index].sortedIndex);
      consumedNoticeDispositionIndexes.add(
        matchingDispositions[index].sortedIndex,
      );
    }
  }

  // Count-based 1:1 pairing for the trailing-marker rule: a single later IDD
  // disposition marker addresses at most ONE earlier regular comment, so one
  // trailing marker cannot clear several distinct comments that each still
  // lack a disposition.
  // Walk the outstanding comments oldest-first and greedily consume the
  // earliest disposition marker strictly newer than each (markers that are not
  // newer than the current comment cannot address it or any later comment).
  // 1:1 pairing of later IDD-agent replies. Advisory-bot outstanding
  // comments still require a real disposition prefix. Human outstanding
  // comments also accept an unmarked later IDD-agent reply (presence-only,
  // #2139) so "thanks, fixed" clears the human item without hollowing out
  // Copilot / CodeRabbit pairing.
  const agentReplyComments = normalizedComments
    .filter(
      (comment) =>
        iddAgentLogins.has(comment.authorLogin) &&
        !consumedNoticeDispositionIndexes.has(comment.sortedIndex) &&
        isValidIsoTimestamp(comment.activityAt) &&
        !isIddOperationalComment(comment) &&
        (!isDispositionComment({ body: comment.body }) ||
          classifyCommentEditState({ lastEditedAt: comment.lastEditedAt }) ===
            'unedited'),
    )
    .sort((left, right) => {
      const byTime = compareIsoTimestamps(left.activityAt, right.activityAt);
      return byTime !== 0 ? byTime : left.sortedIndex - right.sortedIndex;
    });

  const usedReplyIndexes = new Set<number>();
  const missing: typeof outstandingComments = [];
  for (const comment of outstandingComments) {
    if (
      carriedNoticeIndexes.has(comment.sortedIndex) ||
      trustedDispositionedStickyIndexes.has(comment.sortedIndex)
    ) {
      continue;
    }
    const requiresDispositionPrefix = isGateAdvisoryBotLogin(
      comment.authorLogin,
      advisoryBotLogins,
    );
    const reply = agentReplyComments.find((candidate) => {
      if (usedReplyIndexes.has(candidate.sortedIndex)) {
        return false;
      }
      if (compareIsoTimestamps(candidate.activityAt, comment.activityAt) <= 0) {
        return false;
      }
      if (
        requiresDispositionPrefix &&
        !isDispositionComment({ body: candidate.body })
      ) {
        return false;
      }
      return true;
    });
    if (reply) {
      usedReplyIndexes.add(reply.sortedIndex);
    } else {
      missing.push(comment);
    }
  }

  const missingRegularComments = missing.map((comment) => {
    // #1833: only hint when this missing item is itself a recognized
    // advisory non-review notice AND a wrong-phrase `**Rejected**` attempt
    // exists that postdates the notice's original `createdAt` -- so the hint
    // targets the specific comment a human/agent plausibly already tried
    // (and mis-phrased) rather than every unrelated missing item whenever any
    // wrong-phrase reply exists anywhere. Deliberately compares against
    // `createdAt`, not the notice's (possibly bumped) `activityAt`: the
    // motivating scenario is a wrong-phrase reply posted right after the
    // notice first appeared, followed by a re-triggered bot bumping
    // `updatedAt` past that reply -- which is exactly what strands the item
    // in `missing` in the first place (see the `activityAt`-based general 1:1
    // pairing above), so requiring the attempt to postdate the bumped
    // `activityAt` would always be false in the one case this hint exists
    // for.
    const isNoticeComment =
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body);
    const hasWrongPhraseAttempt =
      isNoticeComment &&
      wrongPhraseRejectedDispositions.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    // #2249: generalizes the diagnostic above beyond the notice-specific
    // wrong-phrase case. Checked only when `hasWrongPhraseAttempt` is
    // false so the more specific #1833 hint always wins when both could
    // apply (they cannot in practice -- see `malformedPrefixDispositions`'
    // disjointness note -- but the precedence keeps the more actionable
    // hint on top if that ever changes).
    //
    // Gated on `isGateAdvisoryBotLogin`, mirroring `isNoticeComment` above
    // (Copilot review on PR #2383): `requiresDispositionPrefix` in the 1:1
    // pairing loop above is the ONLY thing that ever requires the exact
    // `**Accepted**`/`**Rejected**` bold prefix -- a human's outstanding
    // comment accepts any later IDD-agent reply, presence-only (#2139).
    // Without this gate, a single malformed reply that legitimately
    // cleared an earlier human comment (consumed via `usedReplyIndexes`
    // in that loop, invisible to this global `malformedPrefixDispositions`
    // pool) could still misleadingly hint a LATER, still-missing human
    // comment that it needs bold markdown it never required.
    const hasMalformedPrefixAttempt =
      !hasWrongPhraseAttempt &&
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      malformedPrefixDispositions.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    // #2491: neither hint above fires when the existing disposition reply
    // was itself well-formed and correctly timed -- both look for a
    // MIS-PHRASED attempt, and this is not one. Instead the bot live-edited
    // this same comment id in place into a non-review notice afterward,
    // bumping its `activityAt` past the disposition's own timestamp: the
    // disposition `<= comment.activityAt` bound is exactly the complement of
    // the general 1:1 pairing's own success condition above
    // (`candidate.activityAt > comment.activityAt`), so a disposition
    // satisfying it is exactly one that FAILS that pairing. Like the two
    // hints above, this is a plausible-timing heuristic, not a proven
    // causal link to this specific comment -- `dispositionComments.some`
    // matches any well-formed disposition in the window, including one a
    // human/agent posted for a different comment entirely or one already
    // consumed elsewhere via `usedReplyIndexes`; a false-positive hint here
    // is a diagnostic inaccuracy at worst, never a routing change. The
    // `> comment.createdAt` lower bound (mirroring the two hints above)
    // additionally requires the disposition to postdate the comment's
    // original appearance. Gated on `isGateAdvisoryBotLogin` +
    // `isAdvisoryNonReviewNotice`, mirroring `isNoticeComment` above: only a
    // comment whose CURRENT body is itself a non-review notice from a
    // configured advisory bot fits the scenario the issue describes.
    const hasEditedAfterDispositionAttempt =
      !hasWrongPhraseAttempt &&
      !hasMalformedPrefixAttempt &&
      isGateAdvisoryBotLogin(comment.authorLogin, advisoryBotLogins) &&
      isAdvisoryNonReviewNotice(comment.body) &&
      dispositionComments.some(
        (disposition) =>
          compareIsoTimestamps(disposition.activityAt, comment.activityAt) <=
            0 &&
          compareIsoTimestamps(disposition.activityAt, comment.createdAt) > 0,
      );
    return {
      id: comment.id || `comment-${comment.sortedIndex + 1}`,
      authorLogin: comment.authorLogin || 'unknown',
      createdAt: comment.createdAt,
      bodyPreview: buildBodyPreview(comment.body),
      ...(hasWrongPhraseAttempt
        ? { hint: NON_REVIEW_NOTICE_DISPOSITION_HINT }
        : hasMalformedPrefixAttempt
          ? { hint: MALFORMED_DISPOSITION_PREFIX_HINT }
          : hasEditedAfterDispositionAttempt
            ? { hint: EDITED_AFTER_DISPOSITION_HINT }
            : {}),
    };
  });

  const missingThreads = (threads ?? [])
    .map((thread, index) => {
      const commentsInThread = thread.comments?.nodes ?? [];
      const hasExternalFeedback = commentsInThread.some((comment) => {
        const authorLogin = String(comment.author?.login ?? '')
          .trim()
          .toLowerCase();
        return (
          authorLogin &&
          !iddAgentLogins.has(authorLogin) &&
          authorLogin !== prAuthorLogin
        );
      });
      if (!hasExternalFeedback) {
        return null;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        return {
          id: String(thread.id ?? '') || `thread-${index + 1}`,
          isResolved: Boolean(thread.isResolved),
          reason: 'incomplete-thread-comments',
          ackOnlyPostDisposition: false,
          inPlaceEditOnly: false,
        };
      }
      if (
        hasFreshDisposition(thread, {
          isDispositionAuthor: (login) =>
            iddAgentLogins.has(
              String(login ?? '')
                .trim()
                .toLowerCase(),
            ) ||
            trustedMarkerLogins.has(
              String(login ?? '')
                .trim()
                .toLowerCase(),
            ),
          // #3269: threaded through so a verified-cosmetic advisory-bot
          // edit (e.g. CodeRabbit's own comment-to-reply marker rewrite)
          // dates by its content activity, not `updatedAt` -- see
          // `effectiveThreadCommentActivityAt`'s doc comment.
          advisoryBotLogins: options.advisoryBotLogins,
        })
      ) {
        return null;
      }
      // #2139: unmarked later replies on a *human-authored* thread are
      // presence-only only when no IDD-originated reply exists in the
      // thread. After a stamped or legacy trusted disposition, later
      // human feedback still re-opens freshness (#978). Advisory-authored
      // threads keep marker-first so an unmarked `ok` cannot satisfy
      // Clause 2.
      if (!isAdvisoryAuthoredThread(thread, advisoryBotLogins)) {
        const laterReplies = commentsInThread.slice(1);
        const hasUnmarkedHumanPresence =
          laterReplies.length > 0 &&
          !laterReplies.some((comment) =>
            isIddOriginatedThreadReply(comment, {
              iddAgentLogins,
              trustedMarkerLogins,
              markerPrefix,
            }),
          );
        if (hasUnmarkedHumanPresence) {
          return null;
        }
      }
      // E1 only snapshots UNRESOLVED non-awaiting threads, and E7 only requires
      // dispositions for snapshot items. A thread that is already resolved and
      // whose newest external feedback predates the review-snapshot boundary was
      // settled out-of-band (or resolved by the reviewer) and must not block; a
      // resolved thread with external feedback newer than the boundary (e.g.
      // freshly reopened) still requires a disposition.
      if (thread.isResolved && snapshotBoundaryAt) {
        const newestFeedbackAt = maxIsoTimestamp(
          commentsInThread
            .filter((comment) => {
              const authorLogin = String(comment.author?.login ?? '')
                .trim()
                .toLowerCase();
              return (
                authorLogin &&
                !iddAgentLogins.has(authorLogin) &&
                authorLogin !== prAuthorLogin
              );
            })
            .map((comment) =>
              effectiveThreadCommentActivityAt(comment, advisoryBotLogins),
            )
            .filter(isValidIsoTimestamp),
        );
        if (
          !newestFeedbackAt ||
          compareIsoTimestamps(newestFeedbackAt, snapshotBoundaryAt) <= 0
        ) {
          return null;
        }
      }
      const classification = classifyThreadAckOnlyPostDisposition(thread, {
        iddAgentLogins: options.iddAgentLogins,
        advisoryBotLogins: options.advisoryBotLogins,
        prAuthorLogin: options.prAuthorLogin,
        snapshotBoundaryAt: options.snapshotBoundaryAt,
      });
      return {
        id: String(thread.id ?? '') || `thread-${index + 1}`,
        isResolved: Boolean(thread.isResolved),
        reason: thread.isResolved
          ? 'missing-fresh-disposition'
          : 'unresolved-without-fresh-disposition',
        ackOnlyPostDisposition: classification.ackOnlyPostDisposition,
        inPlaceEditOnly: classification.inPlaceEditOnly,
      };
    })
    .filter(Boolean) as DispositionEvidenceSummary['missingThreads'];

  const blockingCount = missingRegularComments.length + missingThreads.length;
  // #978: the sole blocking cause is post-disposition advisory-bot ack-only
  // activity. True only when something blocks AND every blocking item is an
  // ack-only-post-disposition resolved thread (no missing regular comments, no
  // non-ack thread). The guard implies missingThreads is non-empty, so `.every`
  // is never vacuously true.
  const soleCauseAckOnlyPostDisposition =
    blockingCount > 0 &&
    missingRegularComments.length === 0 &&
    missingThreads.every((entry) => entry.ackOnlyPostDisposition === true);
  // #1313: narrower sibling -- true only when every blocking item is ALSO an
  // in-place edit of pre-existing content (see `inPlaceEditOnly` above). A
  // strict subset of `soleCauseAckOnlyPostDisposition`.
  const soleCauseInPlaceEditOnly =
    blockingCount > 0 &&
    missingRegularComments.length === 0 &&
    missingThreads.every((entry) => entry.inPlaceEditOnly === true);
  return {
    route: blockingCount > 0 ? 'return-to-e1' : 'proceed',
    reason: blockingCount > 0 ? 'missing-disposition-evidence' : 'complete',
    blockingCount,
    missingRegularCommentCount: missingRegularComments.length,
    missingThreadCount: missingThreads.length,
    soleCauseAckOnlyPostDisposition,
    soleCauseInPlaceEditOnly,
    missingRegularComments,
    missingThreads,
  };
}

export function summarizeBranchReviewRequirements(
  branchRules: BranchRuleLike[] = [],
  branchProtection: BranchProtectionLike = {},
) {
  const requiredCheckNames = new Set<string>();
  // #1689: the subset of requiredCheckNames whose ruleset/classic-protection
  // entry is source-pinned (see `summarizeRequiredCheckMetadata`'s
  // `pinnedNames`) -- lets `summarizeRequiredChecks` name the specific
  // pinned check(s) in a blocker detail instead of a generic message.
  const requiredCheckSourcePinnedNames = new Set<string>();
  const requiredReviewerLogins = new Set<string>();
  const requiredReviewerTeams = new Set<string>();
  const requiredReviewerRequirements: ReviewerRequirement[] = [];
  const classicBypassPullRequestUserLogins = new Set<string>();
  const classicBypassPullRequestTeamSlugs = new Set<string>();
  const classicBypassPullRequestAppSlugs = new Set<string>();

  let requiredApprovingReviewCount = 0;
  let requireCodeOwnerReview = false;
  let classicRequireCodeOwnerReview = false;
  let requiresConversationResolution = false;
  let requiredCheckSourcePinned = false;
  // #1689: true when at least one pinned source cannot be attributed to a
  // resolved check name (a `workflows` rule, or a pinned entry with no
  // `context`/`name`/`check`) -- independent of whether OTHER, named-and-
  // pinned entries also exist. `trustSourcePinnedRequiredChecks` must never
  // bypass the downgrade while this is true, even when
  // `requiredCheckSourcePinnedNames` is non-empty from a separate entry.
  let requiredCheckSourcePinnedUnresolved = false;

  for (const rule of branchRules) {
    if (rule?.type === 'pull_request') {
      const parameters = rule.parameters ?? {};
      requiredApprovingReviewCount = Math.max(
        requiredApprovingReviewCount,
        Number(parameters.required_approving_review_count ?? 0) || 0,
      );
      requireCodeOwnerReview =
        requireCodeOwnerReview || Boolean(parameters.require_code_owner_review);
      requiresConversationResolution =
        requiresConversationResolution ||
        Boolean(parameters.required_review_thread_resolution);

      for (const reviewer of parameters.required_reviewers ?? []) {
        const requirement = extractRequiredReviewerRequirement(reviewer);
        if (!requirement.identity) {
          continue;
        }
        requiredReviewerRequirements.push(requirement);
        if (requirement.identity.includes('/')) {
          requiredReviewerTeams.add(requirement.identity);
        } else {
          requiredReviewerLogins.add(requirement.identity);
        }
      }
      continue;
    }

    if (rule?.type === 'required_status_checks') {
      const checkMetadata = summarizeRequiredCheckMetadata(
        rule.parameters ?? {},
      );
      requiredCheckSourcePinned =
        requiredCheckSourcePinned || checkMetadata.sourcePinned;
      requiredCheckSourcePinnedUnresolved =
        requiredCheckSourcePinnedUnresolved || checkMetadata.unresolvedPinned;
      for (const name of checkMetadata.names) {
        requiredCheckNames.add(name);
      }
      for (const name of checkMetadata.pinnedNames) {
        requiredCheckSourcePinnedNames.add(name);
      }
      continue;
    }

    if (rule?.type === 'workflows') {
      requiredCheckSourcePinned = true;
      requiredCheckSourcePinnedUnresolved = true;
    }
  }

  const protectionReviews =
    branchProtection.required_pull_request_reviews ?? {};
  classicRequireCodeOwnerReview =
    Boolean(protectionReviews.require_code_owner_reviews) ||
    Boolean(protectionReviews.require_code_owner_review);
  for (const user of protectionReviews.bypass_pull_request_allowances?.users ??
    []) {
    const login = typeof user === 'string' ? user : user?.login;
    for (const normalizedLogin of normalizeTrustedMarkerLogins([login])) {
      classicBypassPullRequestUserLogins.add(normalizedLogin);
    }
  }
  for (const team of protectionReviews.bypass_pull_request_allowances?.teams ??
    []) {
    const slug = typeof team === 'string' ? team : team?.slug;
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestTeamSlugs.add(normalizedSlug);
    }
  }
  for (const app of protectionReviews.bypass_pull_request_allowances?.apps ??
    []) {
    const slug = typeof app === 'string' ? app : (app?.slug ?? app?.app_slug);
    for (const normalizedSlug of normalizeTrustedMarkerLogins([slug])) {
      classicBypassPullRequestAppSlugs.add(normalizedSlug);
    }
  }
  requiredApprovingReviewCount = Math.max(
    requiredApprovingReviewCount,
    Number(protectionReviews.required_approving_review_count ?? 0) || 0,
  );
  requireCodeOwnerReview =
    requireCodeOwnerReview || classicRequireCodeOwnerReview;
  requiresConversationResolution =
    requiresConversationResolution ||
    Boolean(branchProtection.required_conversation_resolution?.enabled);

  const protectionCheckMetadata = summarizeRequiredCheckMetadata(
    branchProtection.required_status_checks ?? {},
  );
  requiredCheckSourcePinned =
    requiredCheckSourcePinned || protectionCheckMetadata.sourcePinned;
  requiredCheckSourcePinnedUnresolved =
    requiredCheckSourcePinnedUnresolved ||
    protectionCheckMetadata.unresolvedPinned;
  for (const name of protectionCheckMetadata.names) {
    requiredCheckNames.add(name);
  }
  for (const name of protectionCheckMetadata.pinnedNames) {
    requiredCheckSourcePinnedNames.add(name);
  }

  return {
    requiredApprovingReviewCount,
    requireCodeOwnerReview,
    classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins: [
      ...classicBypassPullRequestUserLogins,
    ].sort(),
    classicBypassPullRequestTeamSlugs: [
      ...classicBypassPullRequestTeamSlugs,
    ].sort(),
    classicBypassPullRequestAppSlugs: [
      ...classicBypassPullRequestAppSlugs,
    ].sort(),
    requiresConversationResolution,
    requiredCheckSourcePinned,
    requiredCheckSourcePinnedNames: [...requiredCheckSourcePinnedNames].sort(),
    requiredCheckSourcePinnedUnresolved,
    requiredReviewerLogins: [...requiredReviewerLogins].sort(),
    requiredReviewerTeams: [...requiredReviewerTeams].sort(),
    requiredReviewerRequirements,
    requiredCheckNames: [...requiredCheckNames].sort(),
  };
}

/** Provenance of the resolved up-to-date-head requirement. */
export type BranchCurrencyRequirementSource =
  | 'ruleset'
  | 'classic-protection'
  | 'unreadable-fail-closed'
  | 'none';

/** Branch-currency (up-to-date-head) evidence for the F2/F3 merge gate. */
export interface BranchCurrencySummary {
  mergeStateStatus: string;
  mergeable: string;
  requiresUpToDateHead: boolean;
  requiresUpToDateHeadSource: BranchCurrencyRequirementSource;
}

/**
 * #1513: resolve whether the base branch's protection or ruleset requires
 * an up-to-date head before merge, and pair that with the PR's live
 * `mergeStateStatus` / `mergeable`. Neither `pre-merge-readiness.mts` nor
 * `idd-merge-execute.mts` previously read this at all -- a live `BEHIND`
 * PR could report `ready: true` right up to the uncaught `gh pr merge`
 * rejection (the field incident this issue documents).
 *
 * Resolution order mirrors `summarizeRequiredChecks`'s existing
 * ruleset-then-classic precedence: a ruleset's `required_status_checks`
 * rule carries `strict_required_status_checks_policy` (confirmed
 * empirically against this repository's own `main`: classic protection
 * returns a genuine 404 "Branch not protected", while
 * `rules/branches/main` returns this field as `true`); classic
 * protection's equivalent field is `required_status_checks.strict`. When
 * neither source resolves `true` AND the branch-protection/ruleset reads
 * were unreadable (a masked 403-as-404, see `protectionReadsUnreadable`
 * in `pre-merge-readiness.mts`), fail closed per
 * `idd-overview-core.instructions.md`'s fail-closed default: assume the
 * requirement is present rather than silently reporting "no requirement."
 * Only a genuinely readable "no rule found" resolves to `none`.
 *
 * Strict `=== true` checks throughout (not `Boolean(...)` coercion) per
 * the write-side mutation-helper critique lens
 * (`idd-overview-appendix.instructions.md`): a non-boolean or missing
 * value must never be silently coerced into "requirement satisfied."
 */
export function summarizeBranchCurrency(
  branchRules: BranchRuleLike[] = [],
  branchProtection: BranchProtectionLike = {},
  options: {
    mergeStateStatus?: string | null;
    mergeable?: string | null;
    protectionReadsUnreadable?: boolean;
  } = {},
): BranchCurrencySummary {
  // #1513 (Copilot/Codex review on PR #1538): GitHub's ruleset docs state
  // `strict_required_status_checks_policy` "will not take effect unless at
  // least one status check is enabled" -- confirmed against
  // https://docs.github.com/en/rest/repos/rules. Treating the flag alone as
  // authoritative would false-positive block a BEHIND PR under an
  // empty-required-check ruleset that GitHub itself would allow to merge, so
  // also require a non-empty required-check list (reusing the same
  // extraction `summarizeRequiredChecks` already uses for check names).
  // Classic branch protection's `required_status_checks.strict` carries no
  // equivalent documented caveat, so it is left unconditional.
  const rulesetRequires = (branchRules ?? []).some(
    (rule) =>
      rule?.type === 'required_status_checks' &&
      rule.parameters?.strict_required_status_checks_policy === true &&
      summarizeRequiredCheckMetadata(rule.parameters ?? {}).names.length > 0,
  );
  const classicRequires =
    branchProtection.required_status_checks?.strict === true;

  let requiresUpToDateHead: boolean;
  let requiresUpToDateHeadSource: BranchCurrencyRequirementSource;
  if (rulesetRequires) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'ruleset';
  } else if (classicRequires) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'classic-protection';
  } else if (options.protectionReadsUnreadable === true) {
    requiresUpToDateHead = true;
    requiresUpToDateHeadSource = 'unreadable-fail-closed';
  } else {
    requiresUpToDateHead = false;
    requiresUpToDateHeadSource = 'none';
  }

  return {
    mergeStateStatus: String(options.mergeStateStatus ?? '').toUpperCase(),
    mergeable: String(options.mergeable ?? '').toUpperCase(),
    requiresUpToDateHead,
    requiresUpToDateHeadSource,
  };
}

export function summarizeRequiredChecks(
  checks: CheckLike[] = [],
  branchRules: BranchRuleLike[] = [],
  branchProtection: BranchProtectionLike = {},
  {
    waivers = null,
    waivableSelectors = null,
    protectionReadsUnreadable = false,
    trustSourcePinnedRequiredChecks = false,
    excludeFromWaiverCoverage = null,
    waiverActiveSinceOverride = null,
    treatAsCoveredByWaiver = null,
    treatAsCoveredByWaiverSince = null,
    identityUnresolvedCheckNames = null,
    nonTargetEventCheckNames = null,
  }: {
    waivers?: {
      valid?: { checkSelector?: unknown; createdAt?: unknown }[] | null;
    } | null;
    waivableSelectors?: { selector?: unknown; matchMode?: unknown }[] | null;
    // #1377: see `buildPreMergeReadinessSummary`'s option of the same name.
    protectionReadsUnreadable?: boolean;
    // #2021 (Codex review on PR #2033): surgical per-CHECK-NAME override that
    // withholds `coveredByWaiver` for one specific check regardless of which
    // `waivers.valid` entry would otherwise match it -- WITHOUT filtering
    // that entry out of `waivers.valid` itself, so any OTHER check the same
    // (e.g. glob) waiver entry also covers is completely unaffected. Exists
    // because `buildPreMergeReadinessSummary`'s `idd-advisory-convergence`
    // precondition gate (#2021) must withhold coverage for THAT one check
    // when the precondition hasn't opened or only a glob (non-exact)
    // selector matches it, but a caller-side pre-filter of `waivers.valid`
    // would incorrectly also strip that same waiver's coverage of an
    // unrelated check the glob also names. `null`/omitted (the default)
    // never excludes anything -- unchanged pre-#2021 behavior for every
    // caller that doesn't pass it.
    excludeFromWaiverCoverage?: ((checkName: string) => boolean) | null;
    // #2034: per-CHECK-NAME override of the moment a matched waiver became
    // genuinely active, superseding the waiver's own `createdAt` when later.
    // A matched check only counts as `coveredByWaiver` once its live run's
    // `completedAt` is at or after this moment -- otherwise the check was
    // never actually re-run since the waiver took effect, and reporting it
    // covered would diverge from what the real required check (and GitHub's
    // branch protection) still shows. Returning `null` (the default, and
    // every caller that omits this option) leaves the waiver's own
    // `createdAt` as the sole cutoff -- this is the ONLY cutoff source for a
    // generic waivable check; #2034 changes that check's behavior too (a
    // valid waiver no longer covers it unconditionally). `buildPreMergeReadinessSummary`
    // passes an override for `idd-advisory-convergence` specifically: that
    // check's waiver only becomes genuinely active once the #2021 deadline
    // precondition opens, and the deadline-open moment is a real, computable
    // timestamp later than the waiver's own `createdAt` could be. The
    // terminal-unavailability precondition path has no equivalent timestamp
    // to invent, so no override is applied there either, and it falls back
    // to the waiver's own `createdAt`, same as the generic path.
    waiverActiveSinceOverride?: ((checkName: string) => string | null) | null;
    // #1689: `ciGate.trustSourcePinnedRequiredChecks` opt-in (mirrors
    // `ciGate.trustEmptyProtectionReads`'s shape). Default `false` keeps the
    // pre-#1689 conservative behavior: a required check whose ruleset entry
    // carries an `app_id`/`integration_id` (source-pinned) downgrades an
    // otherwise-`success` classification to `unknown` unconditionally,
    // because this helper has no way to verify the live check-run instance
    // actually came from the pinned integration (no producer app identity is
    // fetched anywhere in this codebase's `statusCheckRollup` reads -- see
    // `CheckLike`'s doc comment). Setting this `true` is a git-committed,
    // human-authorized decision that the repository operator has verified
    // out-of-band that the pinned integration is the sole producer of the
    // named required check(s), not a runtime check of actual producer
    // identity -- the same trust model `trustEmptyProtectionReads` already
    // uses for a different unverifiable read. It only widens the NAMED,
    // present-and-matched case handled below; a fully unnamed pinned
    // requirement (e.g. a ruleset `workflows` rule with no enumerable
    // context) stays unconditionally conservative via
    // `noRequiredChecksConfigured`'s own `!sourcePinned` guard, since there
    // is no check name to correlate with a live run at all in that case.
    trustSourcePinnedRequiredChecks?: boolean;
    // #2353: surgical per-CHECK-NAME positive override treating a check as
    // covered-by-waiver through a mechanism OTHER than a matched
    // `waivers.valid` entry -- a repository-scoped provider-outage
    // declaration. No `waivableSelectors` re-check is performed here: the
    // caller, `evaluateProviderOutageRelief`, already independently
    // required both the PR's own proven terminal-unavailable state and a
    // `ciGate.externalChecks.waivable` match before ever returning `true`.
    // Deliberately bypasses `excludeFromWaiverCoverage` too: that
    // callback's own purpose is to withhold coverage a matched
    // `waivers.valid` entry would otherwise grant when its OWN
    // precondition/selector-exactness/freshness requirements are unmet --
    // a declaration-relief case never reaches `excludeFromWaiverCoverage`'s
    // reasoning at all, so vetoing it there too would just reproduce this
    // same relief gap one layer down. Still subject to the
    // pass-equivalent-state check, the #2034 live-run requirement, AND
    // `treatAsCoveredByWaiverSince` below (Copilot + Codex review on PR
    // #2370): a check with no parseable `completedAt` -- still QUEUED/
    // IN_PROGRESS/PENDING, never actually produced a verdict -- must never
    // be reported covered by EITHER mechanism, or this gate would report
    // `success` while GitHub's own required-check state is still pending.
    // `null`/omitted (the default) never covers anything, unchanged
    // pre-#2353 behavior for every caller that doesn't pass it.
    treatAsCoveredByWaiver?: ((checkName: string) => boolean) | null;
    // #2353 (Codex review on PR #2370): per-CHECK-NAME freshness cutoff
    // paired with `treatAsCoveredByWaiver` above -- a check only counts as
    // covered through that positive path once its live run's `startedAt`
    // (Codex review, second follow-up: NOT `completedAt` -- a run that
    // started evaluating state before the cutoff never observed whatever
    // made the check relieved, even if it finished afterward) is at or
    // after this moment, mirroring `waiverActiveSinceOverride`'s freshness
    // role for the direct-waiver path but evaluated as a standalone cutoff
    // (no waiver-entry `createdAt` to `Math.max` against). A stale run that
    // started before a declaration's own window opened was never actually
    // rerun during the declared outage; treating it covered would diverge
    // from GitHub's own required-check state. `null`/omitted (the default,
    // and every caller that doesn't pass it) applies no cutoff -- unchanged
    // pre-fix behavior.
    treatAsCoveredByWaiverSince?: ((checkName: string) => string | null) | null;
    // kurone-kito/idd-skill#2919 (round 2 -- E10 critique + Codex/Copilot
    // review on PR #2921): check NAMES the caller could not fully resolve
    // real `workflowPath` producer-identity for on this collection pass
    // (a parse failure on some, but not all, live instances; a thrown
    // `listCheckRunWorkflowPaths` call [kurone-kito/idd-skill#2926;
    // formerly `getWorkflowRun`]; an empty resolved path; a `detailsUrl`
    // that repeats -- either among the resolved `checkSuite.workflowRun`
    // associations or among the live rollup's own matching instances, and
    // so cannot be joined back to a single instance safely
    // [kurone-kito/idd-skill#2926]; or a run-id count exceeding the
    // caller's own lookup ceiling) -- see `pre-merge-readiness.mts`'s
    // `advisoryConvergenceIdentityUnresolved` doc comment for the full
    // rationale this mirrors. Mirrors
    // `trustSourcePinnedRequiredChecks`'s downgrade shape below: a NAMED
    // check that would otherwise report `'success'` downgrades to
    // `'unknown'` instead, because an unresolved producer identity means
    // this helper cannot rule out that the `'success'` verdict actually
    // came from a decoy workflow file sharing the same display name (see
    // `CheckLike`'s own doc comment) -- the exact gap #2919 exists to
    // close. `null`/omitted (the default, and every caller that predates
    // this option) downgrades nothing, unchanged pre-#2919-round-2
    // behavior.
    identityUnresolvedCheckNames?: string[] | null;
    // kurone-kito/idd-skill#3256: check NAMES whose dedup-selected latest
    // instance is pass-equivalent, but this collection pass found no
    // qualifying `pull_request_target`-triggered pass among their live
    // instances -- see `pre-merge-readiness.mts`'s
    // `advisoryConvergenceNonTargetEventOnly` doc comment for the full
    // rationale. Mirrors `identityUnresolvedCheckNames`'s downgrade shape
    // exactly (a NAMED check that would otherwise report `'success'`
    // downgrades to `'unknown'` instead) but is a DISTINCT cause reported
    // under its own field, never folded into
    // `identityUnresolvedRequiredCheckNames`: that field's own detail text
    // ("unresolved workflow-file producer identity") would misdescribe
    // this cause, where the producer identity resolved cleanly and only
    // its triggering event disqualified the pass. Deliberately
    // unconditional with respect to waiver coverage, matching
    // `identityUnresolvedCheckNames`'s own precedent -- see that
    // collector-side doc comment for why this is accepted as practically
    // harmless post-#3256 rather than needing its own waiver-interaction
    // logic. `null`/omitted (the default, and every caller that predates
    // this option) downgrades nothing.
    nonTargetEventCheckNames?: string[] | null;
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredCheckNames = branchReviewRequirements.requiredCheckNames;
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const validWaivers = waivers?.valid ?? [];

  const normalizedChecks = checks.map((check) => {
    const name = String(check.name ?? '');
    const state = String(check.state ?? '').toUpperCase();
    const completedAt = String(check.completedAt ?? '');
    // #2353 (Copilot + Codex + CodeRabbit review on PR #2370, round 5):
    // `isValidIsoTimestamp` alone accepts GitHub's `0001-01-01T00:00:00Z`
    // zero-value sentinel -- `normalizeStatusCheckRollupEntry` substitutes
    // it for BOTH an absent `completedAt` (still QUEUED/IN_PROGRESS) and an
    // absent `startedAt` (not yet started), the same non-nullable-DateTime
    // convention `isCompletedCiTimestamp` already exists to reject (see its
    // doc comment / `parseCompletedAt` above). Reusing it here -- despite
    // its "completed" name -- because the sentinel isn't completion-
    // specific: it is GitHub's stand-in for "this lifecycle moment hasn't
    // happened yet," which applies equally to `startedAt`. Without this, an
    // IN_PROGRESS run (sentinel `completedAt`, but a genuine, fresh
    // `startedAt`) would pass BOTH `completedAtMs !== null` (the sentinel
    // parses as a valid, merely very-old, timestamp) and the `startedAt`
    // freshness cutoff below, reporting a still-running required check
    // `coveredByWaiver: true` while GitHub's own check is neither passed
    // nor even finished.
    const completedAtMs = isCompletedCiTimestamp(completedAt)
      ? Date.parse(completedAt)
      : null;
    const startedAt = String(check.startedAt ?? '');
    const startedAtMs = isCompletedCiTimestamp(startedAt)
      ? Date.parse(startedAt)
      : null;
    const matchingWaivers = validWaivers.filter((w) =>
      matchCheckSelectorLocal(name, w.checkSelector),
    );
    const activeSinceOverride =
      typeof waiverActiveSinceOverride === 'function'
        ? waiverActiveSinceOverride(name)
        : null;
    const activeSinceOverrideMs = isValidIsoTimestamp(activeSinceOverride)
      ? new Date(activeSinceOverride).getTime()
      : null;
    // #2034: a matched waiver only covers a check whose live run's
    // `completedAt` is at or after the moment the waiver became genuinely
    // active -- otherwise the check was never actually re-run since the
    // waiver took effect, so reporting it covered here would diverge from
    // what the real required check (and GitHub's branch protection) still
    // shows. Fails closed on a missing/unparseable `completedAt` (never run,
    // still pending) or waiver `createdAt` (`'none'`).
    const hasFreshWaiverCoverage =
      completedAtMs !== null &&
      matchingWaivers.some((w) => {
        const waiverCreatedAtMs = isValidIsoTimestamp(w.createdAt)
          ? new Date(w.createdAt).getTime()
          : null;
        if (waiverCreatedAtMs === null) return false;
        const activeSinceMs =
          activeSinceOverrideMs !== null
            ? Math.max(waiverCreatedAtMs, activeSinceOverrideMs)
            : waiverCreatedAtMs;
        return completedAtMs >= activeSinceMs;
      });
    // #2353: an independent positive path -- see `treatAsCoveredByWaiver`'s
    // own doc comment for why it deliberately bypasses
    // `excludeFromWaiverCoverage`/`hasFreshWaiverCoverage`/`waivableSelectors`
    // below rather than feeding into the same conjunction. Still requires
    // `completedAtMs !== null` (Copilot + Codex review on PR #2370): the
    // SAME #2034 fail-closed live-run requirement `hasFreshWaiverCoverage`
    // already enforces -- a check that is still QUEUED/IN_PROGRESS/PENDING
    // with no parseable `completedAt` has never actually produced a verdict
    // at all, and treating it as covered would report `success` while
    // GitHub's own required-check state is still pending, reproducing the
    // exact "ready but merge blocked" failure mode #2021 fixed for the
    // direct-waiver path. Also requires the live run to be fresh relative
    // to `treatAsCoveredByWaiverSince` when the caller supplies one, and
    // (Codex review on PR #2370, second follow-up) anchors that freshness
    // check on `startedAt` rather than `completedAt`: a run that began
    // evaluating state before the cutoff never observed whatever made this
    // check relieved, even if it happens to finish (and post `completedAt`)
    // moments after the cutoff passes -- the run's own verdict was already
    // decided using stale state by then. Requires `startedAtMs !== null`
    // for the same fail-closed reason as `completedAtMs !== null` above: a
    // run with no parseable `startedAt` has no evidence it observed
    // anything at all.
    const treatAsCoveredByWaiverSinceOverride =
      typeof treatAsCoveredByWaiverSince === 'function'
        ? treatAsCoveredByWaiverSince(name)
        : null;
    const treatAsCoveredByWaiverSinceMs = isValidIsoTimestamp(
      treatAsCoveredByWaiverSinceOverride,
    )
      ? new Date(treatAsCoveredByWaiverSinceOverride).getTime()
      : null;
    const treatedAsCoveredByWaiver =
      completedAtMs !== null &&
      startedAtMs !== null &&
      typeof treatAsCoveredByWaiver === 'function' &&
      treatAsCoveredByWaiver(name) &&
      (treatAsCoveredByWaiverSinceMs === null ||
        startedAtMs >= treatAsCoveredByWaiverSinceMs);
    const coveredByWaiver =
      !CHECK_PASS_EQUIVALENT_STATES.has(state) &&
      (treatedAsCoveredByWaiver ||
        (!(
          typeof excludeFromWaiverCoverage === 'function' &&
          excludeFromWaiverCoverage(name)
        ) &&
          hasFreshWaiverCoverage &&
          // The check must also sit on the policy's waivable surface. A
          // null/undefined list keeps the legacy behavior with no gate; an
          // empty configured list covers nothing.
          (!Array.isArray(waivableSelectors) ||
            isCheckNameConfiguredWaivable(name, waivableSelectors))));
    return {
      name,
      state,
      completedAt,
      coveredByWaiver,
      // Producer-identity discriminator (#1483); see `CheckLike` and
      // `selectLatestCheckPerName` for how it disambiguates a same-name
      // rerun from a genuinely independent, differently-sourced check.
      type: check.type ? String(check.type) : '',
      workflowName: check.workflowName ? String(check.workflowName).trim() : '',
      // #2919: carried through so the PRIMARY required-check gate below
      // (`classifyCiChecks(effectiveChecks)`) shares the same widened
      // producer key as every other consumer -- see `CheckLike`'s doc
      // comment. Absent (`''`) for every check this collector doesn't
      // resolve a path for, which stays permissive/unchanged.
      workflowPath: check.workflowPath ? String(check.workflowPath).trim() : '',
    };
  });

  const matchedRequiredChecks = normalizedChecks.filter((check) =>
    requiredCheckNameSet.has(check.name),
  );
  const presentNames = new Set(
    matchedRequiredChecks.map((check) => check.name),
  );
  const missingRequiredCheckNames = requiredCheckNames.filter(
    (name) => !presentNames.has(name),
  );

  let status = 'unknown';
  // kurone-kito/idd-skill#2919 (round 5 -- advisor review ahead of PR #2921
  // round 5's push): `status` right after the missing/`classifyCiChecks`
  // computation below, BEFORE either the source-pinned or identity-
  // unresolved downgrade can narrow it. `classifyCiChecks` is called on
  // `effectiveChecks` -- already waiver-adjusted (`coveredByWaiver` ->
  // `SKIPPED`) and already deduped per producer via
  // `selectLatestCheckPerName` -- so this is the EXACT answer to "is there
  // a genuinely separate, concurrent CI failure reason (an unrelated
  // required check that is missing/pending/failed/waived) independent of
  // the two named downgrades below?" `computePreMergeReadinessBlockers`
  // uses this instead of re-deriving per-check-name pass/fail evidence
  // from the already-non-deduped, waiver-unaware `checks` array -- an
  // earlier revision of that blocker-detail fix did exactly that, and
  // could spuriously append the generic detail for a required check whose
  // OLDER same-name instance happened to sort after its own already-
  // superseding SUCCESS in raw array order, or for a genuinely WAIVED
  // required check (raw state FAILURE, `coveredByWaiver: true`) -- both
  // cases `classifyCiChecks`'s own dedup+waiver-adjustment already
  // correctly resolves, so reusing its verdict here is exact by
  // construction rather than a second, drift-prone reimplementation.
  let preDowngradeStatus = 'unknown';
  // #1745: discarded non-passing same-name siblings among the REQUIRED
  // checks, e.g. a CANCELLED idd-advisory-convergence instance sitting
  // alongside the SUCCESS instance selectLatestCheckPerName picked as
  // "latest" -- surfaced regardless of the final `status` below so a
  // 'success' verdict here is never silently opaque about a discarded
  // non-passing sibling GitHub's own statusCheckRollup may have weighed
  // differently (the live PR #1741 divergence this field exists to make
  // visible; see classifyCiChecks's own findDiscardedNonPassingSiblings
  // doc comment for the full rationale). Empty (never omitted) when no
  // required checks are configured.
  let discardedNonPassingRequiredChecks: CiCheckDiscardedSibling[] = [];
  // #1689: the pinned required-check names that caused the downgrade below
  // (empty unless that downgrade actually fired). Lets a caller's blocker
  // detail name the source-pinned cause explicitly instead of a generic
  // "CI is not all-passing" message -- see `computePreMergeReadinessBlockers`.
  let sourcePinnedRequiredCheckNames: string[] = [];
  // #1689: true when the downgrade below fired at least partly because of a
  // pinned source that could not be attributed to any check name (a
  // ruleset `workflows` rule, or a pinned entry with no `context`/`name`/
  // `check`) -- distinct from `sourcePinnedRequiredCheckNames` being empty,
  // which alone would be ambiguous between "no pinning" and "pinning
  // exists but is unnamed." Lets a blocker detail name the cause even when
  // no specific check name can be cited.
  let sourcePinnedUnresolved = false;
  // kurone-kito/idd-skill#2919 (round 2): the required-check names the
  // downgrade below actually fired for (empty unless it fired). See
  // `identityUnresolvedCheckNames`'s own doc comment above.
  let identityUnresolvedRequiredCheckNames: string[] = [];
  // kurone-kito/idd-skill#2919 (round 4 -- Copilot review on PR #2921):
  // computed unconditionally (not nested inside the `requiredCheckNames.length
  // > 0` block below) because `resolvePresentRunConclusion` below needs it
  // too, and that fallback conclusion is consulted precisely when NO
  // required checks are configured at all -- see its own doc comment for
  // why an identity-unresolved check name must never let THAT fallback
  // read 'all-passing' either, closing the alternate route Copilot found
  // for reopening the same decoy-masking gap on an unprotected branch.
  const identityUnresolvedNameSet = new Set(
    Array.isArray(identityUnresolvedCheckNames)
      ? identityUnresolvedCheckNames.map((name) => String(name ?? '').trim())
      : [],
  );
  // kurone-kito/idd-skill#3256 (round 2 -- advisor review, mirroring
  // #2919 round 4's identical reasoning for `identityUnresolvedNameSet`
  // just above): the required-check names the downgrade below actually
  // fired for (empty unless it fired). See `nonTargetEventCheckNames`'s
  // own doc comment above.
  let nonTargetEventRequiredCheckNames: string[] = [];
  const nonTargetEventNameSet = new Set(
    Array.isArray(nonTargetEventCheckNames)
      ? nonTargetEventCheckNames.map((name) => String(name ?? '').trim())
      : [],
  );
  if (requiredCheckNames.length > 0) {
    const effectiveChecks = matchedRequiredChecks.map((c) =>
      c.coveredByWaiver ? { ...c, state: 'SKIPPED' } : c,
    );
    const ciClassification = classifyCiChecks(effectiveChecks);
    status =
      missingRequiredCheckNames.length > 0
        ? 'missing'
        : ciClassification.status;
    preDowngradeStatus = status;
    // #1689: the `trustSourcePinnedRequiredChecks` opt-in only widens the
    // named/resolved case -- an unresolved pinned source (no check name to
    // correlate with a live run at all) always still forces the downgrade,
    // even when a SEPARATE, named-and-pinned entry also exists and the
    // operator has opted in for that one.
    if (
      status === 'success' &&
      branchReviewRequirements.requiredCheckSourcePinned &&
      (!trustSourcePinnedRequiredChecks ||
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved)
    ) {
      status = 'unknown';
      sourcePinnedRequiredCheckNames = [
        ...branchReviewRequirements.requiredCheckSourcePinnedNames,
      ];
      sourcePinnedUnresolved =
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved;
    }
    // kurone-kito/idd-skill#2919 (round 3 -- Codex review on PR #2921, P2):
    // the affected NAMES are computed from `requiredCheckNames` -- the
    // original classification -- INDEPENDENTLY of whatever `status`
    // already became from the source-pinned downgrade above, not gated
    // on `status === 'success'`. An earlier revision gated this whole
    // block on that condition, so a check that was BOTH source-pinned AND
    // identity-unresolved silently lost the identity-unresolved evidence
    // the moment the source-pinned branch above had already downgraded
    // `status` to `'unknown'` first -- the blocker detail then named only
    // the source-pinned cause, and once an operator opted into
    // `ciGate.trustSourcePinnedRequiredChecks` to clear THAT cause, a
    // later pass would stay blocked with no evidence explaining why.
    // Mirrors `discardedNonPassingRequiredChecks`'s own "computed
    // unconditionally ... evidence worth surfacing even when the overall
    // status already reads non-success for an unrelated cause" precedent
    // above. The numeric `status` field itself is still only ever
    // NARROWED when it is currently `'success'` -- this never overrides a
    // status that is already `'missing'`/`'pending'`/`'failed'`, and
    // reassigning an already-`'unknown'` status to `'unknown'` again is a
    // harmless no-op.
    if (identityUnresolvedNameSet.size > 0) {
      const affected = requiredCheckNames.filter((name) =>
        identityUnresolvedNameSet.has(name),
      );
      if (affected.length > 0) {
        identityUnresolvedRequiredCheckNames = affected;
        if (status === 'success') {
          status = 'unknown';
        }
      }
    }
    // kurone-kito/idd-skill#3256: independent of, and checked alongside
    // (never exclusively with), the source-pinned and identity-unresolved
    // causes above -- mirrors identityUnresolvedNameSet's own block
    // exactly, same "computed from requiredCheckNames independently of
    // status" reasoning.
    if (nonTargetEventNameSet.size > 0) {
      const affected = requiredCheckNames.filter((name) =>
        nonTargetEventNameSet.has(name),
      );
      if (affected.length > 0) {
        nonTargetEventRequiredCheckNames = affected;
        if (status === 'success') {
          status = 'unknown';
        }
      }
    }
    // #1753: computed from the RAW matchedRequiredChecks -- deliberately
    // NOT ciClassification.discardedNonPassingInstances above, which is
    // derived from the waiver-adjusted effectiveChecks. A valid waiver
    // rewrites a waived non-passing instance's `state` to 'SKIPPED' (pass-
    // equivalent, outside GENUINELY_NON_PASSING_STATES), so computing this
    // evidence field from effectiveChecks would let a waived CANCELLED
    // sibling silently drop out of this field the moment it is waived --
    // exactly the divergence-masking scenario #1745 exists to surface, and
    // exactly the check this repo's own `idd-advisory-convergence` waivable
    // policy can trigger. `status` above intentionally keeps using the
    // waiver-adjusted effectiveChecks -- a valid waiver legitimately makes
    // a check pass for merge-gate purposes; only this evidence-only
    // computation needs the pre-waiver truth.
    discardedNonPassingRequiredChecks = findDiscardedNonPassingSiblings(
      matchedRequiredChecks,
    );
  }

  return {
    status,
    noRequiredChecksConfigured:
      !protectionReadsUnreadable &&
      requiredCheckNames.length === 0 &&
      !branchReviewRequirements.requiredCheckSourcePinned,
    // #1377: surfaced separately from `noRequiredChecksConfigured` so a hold
    // message can name the unreadable-read cause specifically instead of a
    // generic "CI is not all-passing".
    protectionReadsUnreadable,
    presentRunConclusion: resolvePresentRunConclusion(
      normalizedChecks,
      // kurone-kito/idd-skill#3256: unioned with `nonTargetEventNameSet` --
      // `resolvePresentRunConclusion` treats any name in this set
      // identically (fail closed into 'some-failing'), so a single
      // combined set covers both causes without adding a third
      // parameter. See that function's own doc comment.
      new Set([...identityUnresolvedNameSet, ...nonTargetEventNameSet]),
    ),
    requiredCheckCount: requiredCheckNames.length,
    generatedRequiredCheckCount: matchedRequiredChecks.length,
    requiredChecksGenerated:
      requiredCheckNames.length > 0 && missingRequiredCheckNames.length === 0,
    requiredChecksPassing:
      requiredCheckNames.length > 0 && status === 'success',
    requiredCheckNames,
    missingRequiredCheckNames,
    // #1745: see the field's own inline comment above -- reported
    // unconditionally (empty array, never omitted) so a consumer never has
    // to special-case "field absent" vs. "field empty".
    discardedNonPassingRequiredChecks,
    // #1689: see the field's own inline comment above -- reported
    // unconditionally (empty array, never omitted), populated only when the
    // source-pinned downgrade actually fired for this call.
    sourcePinnedRequiredCheckNames,
    // #1689: see the field's own inline comment above -- `false` unless the
    // downgrade fired AND at least one pinned source was unnamed.
    sourcePinnedUnresolved,
    // kurone-kito/idd-skill#2919 (round 2): see the field's own inline
    // comment above -- empty unless the identity-unresolved downgrade
    // actually fired for this call.
    identityUnresolvedRequiredCheckNames,
    // kurone-kito/idd-skill#3256: see the field's own inline comment
    // above -- empty unless the non-target-event downgrade actually
    // fired for this call.
    nonTargetEventRequiredCheckNames,
    // kurone-kito/idd-skill#2919 (round 5; kurone-kito/idd-skill#3256
    // added the third downgrade): see the field's own inline comment
    // above -- the dedup+waiver-adjusted classification `status` BEFORE
    // the source-pinned/identity-unresolved/non-target-event downgrades
    // could narrow it. Lets a caller determine, exactly, whether a
    // genuinely separate concurrent CI cause exists alongside those three
    // named downgrades, without re-deriving per-check pass/fail evidence
    // itself. `'unknown'` when no required checks are configured (mirrors
    // `status`'s own initial default in that case).
    preDowngradeStatus,
    checks: normalizedChecks.map((check) => ({
      name: check.name,
      state: check.state,
      completedAt: isValidIsoTimestamp(check.completedAt)
        ? check.completedAt
        : '',
      required: requiredCheckNameSet.has(check.name),
      ...(check.coveredByWaiver ? { coveredByWaiver: true } : {}),
    })),
  };
}

// Conclusion over *all* present check runs (waiver-covered runs count as
// skipped), used for the F2 fallback when no required checks are configured:
// an unprotected branch must not satisfy CI vacuously, so the gate inspects the
// real run conclusions instead.
export function resolvePresentRunConclusion(
  normalizedChecks: {
    name: string;
    state: string;
    completedAt: string;
    coveredByWaiver: boolean;
    type: string;
    workflowName: string;
    workflowPath: string;
  }[],
  // kurone-kito/idd-skill#2919 (round 4 -- Copilot review on PR #2921):
  // check NAMES this collection pass could not fully resolve real
  // `workflowPath` producer identity for -- see `identityUnresolvedCheckNames`
  // on `summarizeRequiredChecks` for the full rationale this mirrors. This
  // fallback conclusion is consulted precisely when NO required checks are
  // configured at all (`noRequiredChecksConfigured`), so an unresolved
  // identity here must fail closed too: without this, a decoy workflow
  // file sharing the checker's display name could still dedupe with (and
  // mask) the real workflow's FAILURE through the unchanged, absent-
  // `workflowPath` producer key -- reopening the exact bypass #2919 exists
  // to close, on an unprotected branch, even though the PRIMARY
  // required-check gate (`summarizeRequiredChecks`'s own `status`) is
  // already fixed. Default empty set is backward compatible: every caller
  // that omits it (none of them do after this fix, but a future direct
  // caller might) sees unchanged pre-#2919 behavior.
  identityUnresolvedCheckNames: ReadonlySet<string> = new Set(),
): string {
  if (normalizedChecks.length === 0) {
    return 'none';
  }
  if (
    identityUnresolvedCheckNames.size > 0 &&
    normalizedChecks.some((check) =>
      identityUnresolvedCheckNames.has(check.name),
    )
  ) {
    // `'some-failing'`, not `'pending'`: the `#2714` comment above maps a
    // lone CANCELLED-with-no-successor instance to `'pending'` because
    // that shape is a plausible rerun-in-progress candidate that can
    // reasonably resolve on its own without operator action. An
    // unresolved producer identity has no such self-resolving path -- a
    // malformed `detailsUrl` or a genuine decoy workflow file will not
    // become parseable or stop being a decoy on a later poll -- so this
    // follows the conservative `'some-failing'` default every other
    // genuinely unrecognized-state `unknown` cause already gets, not the
    // narrower CANCELLED carve-out.
    return 'some-failing';
  }
  const effective = normalizedChecks.map((check) =>
    check.coveredByWaiver ? { ...check, state: 'SKIPPED' } : check,
  );
  const classification = classifyCiChecks(effective);
  if (classification.status === 'success') {
    return 'all-passing';
  }
  if (classification.status === 'pending') {
    return 'pending';
  }
  // #2714: a lone CANCELLED instance with no same-producer successor to
  // dedup against lands in classifyCiChecks's residual `unknown` bucket --
  // CANCELLED is deliberately excluded from both `failed` and `passing`
  // (see CI_FAILURE_CONCLUSION_STATES's own doc comment). Map that exact
  // shape to 'pending' -- a cancelled-with-no-successor run is a plausible
  // rerun candidate -- rather than folding it into 'some-failing', which
  // reads as terminal/actionable and reproduces through this fallback
  // exactly the outcome classifyCiChecks's own CANCELLED exclusion exists
  // to avoid. Scoped to CANCELLED-only `unknown` entries: an `unknown`
  // bucket containing any other, genuinely unrecognized state stays
  // 'some-failing', the conservative default.
  const unknownChecks = classification.unknown ?? [];
  if (
    classification.status === 'unknown' &&
    unknownChecks.every((check) => check.state === 'CANCELLED')
  ) {
    return 'pending';
  }
  return 'some-failing';
}

export function resolveCodeownersForFiles(
  codeownersText: unknown,
  changedFiles: unknown[] = [],
) {
  const rules = parseCodeownersRules(codeownersText);
  return collectCodeownersForFiles(rules, changedFiles);
}

export function selectCodeownersText(payloads: unknown[] = []): string {
  for (const payload of payloads) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Object.hasOwn(payload, 'content')
    ) {
      continue;
    }
    const content = String(
      (payload as { content?: unknown }).content ?? '',
    ).replace(/\n/g, '');
    return Buffer.from(content, 'base64').toString('utf8');
  }
  return '';
}

function collectCodeownersForFiles(
  rules: CodeownersRule[],
  changedFiles: unknown[] = [],
) {
  const codeownerUsers = new Set<string>();
  const codeownerTeams = new Set<string>();
  const codeownerEmails = new Set<string>();
  const unmatchedFiles: string[] = [];

  for (const filePath of changedFiles) {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      continue;
    }

    const owners = findCodeownersForPath(rules, normalizedPath);
    if (!owners) {
      unmatchedFiles.push(normalizedPath);
      continue;
    }
    if (!hasCodeownerOwners(owners)) {
      continue;
    }

    for (const owner of owners.users) {
      codeownerUsers.add(owner);
    }
    for (const owner of owners.teams) {
      codeownerTeams.add(owner);
    }
    for (const owner of owners.emails) {
      codeownerEmails.add(owner);
    }
  }

  return {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
    unmatchedFiles,
    codeownerUserLogins: [...codeownerUsers].sort(),
    codeownerTeamSlugs: [...codeownerTeams].sort(),
    codeownerEmailAddresses: [...codeownerEmails].sort(),
  };
}

export function summarizeReviewerStates(
  reviews: ReviewLike[] = [],
  {
    reviewDecision = '',
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    branchRulesetsUnreadable = false,
    codeownersText = '',
    changedFiles = [],
    eligibleCodeownerUserLogins = null,
    eligibleCodeownerUserLoginsUnreadable = false,
    reviewsUnreadable = false,
    advisoryBotLogins = [],
    prAuthorLogin = '',
    viewerLogin = '',
    viewerTeamSlugs = [],
    viewerAppSlug = '',
  }: {
    reviewDecision?: string | null;
    branchRules?: BranchRuleLike[];
    branchRulesets?: BranchRulesetLike[];
    branchProtection?: BranchProtectionLike;
    // #1380: see `buildPreMergeReadinessSummary`'s option of the same name.
    branchRulesetsUnreadable?: boolean;
    codeownersText?: string;
    changedFiles?: unknown[];
    eligibleCodeownerUserLogins?: unknown[] | null;
    // #1521: see `buildPreMergeReadinessSummary`'s option of the same name.
    eligibleCodeownerUserLoginsUnreadable?: boolean;
    // #1837: see `buildPreMergeReadinessSummary`'s option of the same name.
    reviewsUnreadable?: boolean;
    advisoryBotLogins?: unknown[];
    prAuthorLogin?: string | null;
    viewerLogin?: string | null;
    viewerTeamSlugs?: unknown[];
    viewerAppSlug?: string | null;
  } = {},
) {
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const requiredReviewerLogins = new Set(
    branchReviewRequirements.requiredReviewerLogins,
  );
  const advisoryBotLoginSet = new Set(
    normalizeTrustedMarkerLogins(advisoryBotLogins),
  );
  const codeownerRules = parseCodeownersRules(codeownersText);
  const codeowners = collectCodeownersForFiles(codeownerRules, changedFiles);
  const codeownerUsers = new Set(codeowners.codeownerUserLogins);
  const eligibleCodeownerUsers =
    eligibleCodeownerUserLogins === null
      ? codeownerUsers
      : new Set(
          normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
            (login) => codeownerUsers.has(login),
          ),
        );
  const normalizedReviewDecision = String(reviewDecision ?? '');

  const latestByAuthor = [...indexLatestGatingReviewsByAuthor(reviews).values()]
    .map((review) => {
      const login = String(review.author?.login ?? '')
        .trim()
        .toLowerCase();
      const isAdvisoryBot = isGateAdvisoryBotLogin(login, advisoryBotLoginSet);
      const isCodeowner = eligibleCodeownerUsers.has(login);
      const isRequiredReviewer = requiredReviewerLogins.has(login);
      return {
        login,
        state: String(review.state ?? ''),
        submittedAt: String(review.submittedAt ?? review.submitted_at ?? ''),
        isHuman: !isAdvisoryBot,
        isAdvisoryBot,
        isCodeowner,
        isRequiredReviewer,
      };
    })
    .sort((left, right) => left.login.localeCompare(right.login));

  const blockingChangesRequestedLogins = latestByAuthor
    .filter((review) => {
      return review.state === 'CHANGES_REQUESTED' && !review.isAdvisoryBot;
    })
    .map((review) => review.login);

  const humanApprovedCount = latestByAuthor.filter((review) => {
    return review.isHuman && review.state === 'APPROVED';
  }).length;
  // #1818: also require `isHuman` here, mirroring `humanApprovedCount` above.
  // Without it, any advisory bot (default-recognized or configured) that is
  // also listed as a CODEOWNER for the changed files would satisfy the
  // codeowner-approval gate on its own review -- the same fail-open shape
  // `humanApprovedCount` already guarded against. This intentionally
  // diverges from GitHub's own CODEOWNERS gate (which would count a bot
  // codeowner's approval); the stricter, fail-closed reading is deliberate,
  // not a gap to "fix" back.
  const codeownerApproved = latestByAuthor.some((review) => {
    return review.isCodeowner && review.isHuman && review.state === 'APPROVED';
  });
  const hasExplicitCodeownerMatches = changedFiles.some((filePath) => {
    const normalizedPath = String(filePath ?? '').replace(/^\/+/, '');
    if (!normalizedPath) {
      return false;
    }
    const owners = findCodeownersForPath(codeownerRules, normalizedPath);
    return !!owners && hasCodeownerOwners(owners);
  });
  const latestByLogin = new Map(
    latestByAuthor.map((review) => [review.login, review]),
  );
  const requiredReviewerApprovalsSatisfied =
    branchReviewRequirements.requiredReviewerRequirements.every(
      (requirement) => {
        if (
          requirement.filePatterns.length > 0 &&
          !changedFiles.some((filePath) => {
            return requirement.filePatterns.some((pattern) =>
              matchesCodeownersPattern(pattern, filePath),
            );
          })
        ) {
          return true;
        }
        if ((requirement.minimumApprovals ?? 0) <= 0) {
          return true;
        }
        // #1837: deliberately NOT gated by `reviewsUnreadable` (unlike the
        // `codeownerApprovalSatisfied`/`requiredApprovalsSatisfied` bypasses
        // fixed below). A team-identity requirement (`requirement.identity`
        // contains `/`, checked immediately below) can never be resolved to
        // a reviewing login from `reviews` data -- this code has no team
        // membership lookup at all -- so GitHub's own aggregate decision is
        // the only signal available for it regardless of whether the caller
        // fetched full review data. See "required reviewer rule objects
        // stay blocking until GitHub marks approval satisfied" in
        // tests/pre-merge-readiness.test.mts, which locks this in.
        if (normalizedReviewDecision === 'APPROVED') {
          return true;
        }
        if (requirement.identity.includes('/')) {
          return false;
        }
        return latestByLogin.get(requirement.identity)?.state === 'APPROVED';
      },
    );
  // #1837: `normalizedReviewDecision === 'APPROVED'` alone used to be an
  // unconditional bypass here, letting GitHub's own aggregate `reviewDecision`
  // (which can resolve APPROVED from a bot-only review -- GitHub shipped
  // bot-review-state support 2026-08-01, see #1818's background) satisfy this
  // gate even when the classified data this function already computed
  // (`codeownerApproved`) shows the approval came only from a bot. When the
  // caller genuinely could not fetch/classify individual reviews
  // (`reviewsUnreadable`), GitHub's aggregate is still the only available
  // signal and stays a bypass. When review data IS available (the normal
  // `collectPreMergeReadiness` path, which fails closed by throwing rather
  // than ever reaching this function with partial data), the classified
  // `codeownerApproved` check must also agree -- GitHub's `APPROVED` decision
  // no longer overrides it on its own.
  const codeownerSelfApproval = summarizeCodeownerSelfApproval({
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      (reviewsUnreadable && normalizedReviewDecision === 'APPROVED'),
    hasExplicitCodeownerMatches,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    eligibleCodeownerUserLogins:
      eligibleCodeownerUserLogins === null
        ? null
        : [...eligibleCodeownerUsers].sort(),
    eligibleCodeownerUserLoginsUnreadable,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    codeownerEmailAddresses: codeowners.codeownerEmailAddresses,
    prAuthorLogin,
    viewerLogin,
    viewerTeamSlugs,
    viewerAppSlug,
    branchRules,
    branchRulesets,
    branchRulesetsUnreadable,
    classicRequireCodeOwnerReview:
      branchReviewRequirements.classicRequireCodeOwnerReview,
    classicBypassPullRequestUserLogins:
      branchReviewRequirements.classicBypassPullRequestUserLogins,
    classicBypassPullRequestTeamSlugs:
      branchReviewRequirements.classicBypassPullRequestTeamSlugs,
    classicBypassPullRequestAppSlugs:
      branchReviewRequirements.classicBypassPullRequestAppSlugs,
  });

  return {
    reviewDecision: normalizedReviewDecision,
    requiredApprovingReviewCount:
      branchReviewRequirements.requiredApprovingReviewCount,
    requireCodeOwnerReview: branchReviewRequirements.requireCodeOwnerReview,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
    requiredReviewerLogins: branchReviewRequirements.requiredReviewerLogins,
    requiredReviewerTeams: branchReviewRequirements.requiredReviewerTeams,
    codeownerUserLogins: codeowners.codeownerUserLogins,
    codeownerTeamSlugs: codeowners.codeownerTeamSlugs,
    unmatchedCodeownerFiles: codeowners.unmatchedFiles,
    latestByAuthor,
    humanApprovedCount,
    // #1837: see the comment above `codeownerSelfApproval` for the shared
    // rationale. `reviewsUnreadable` keeps the pre-fix blanket-trust bypass
    // (first disjunct) only when review data genuinely could not be
    // classified. Otherwise (the normal, classifiable path -- the second
    // disjunct), an `APPROVED` aggregate is treated the same as an empty
    // one: it still must be corroborated by the classified
    // `humanApprovedCount` reaching the required threshold (or the
    // threshold being `0`, i.e. no approvals required at all -- nothing is
    // missing, so this stays a pass by design, not a gap).
    requiredApprovalsSatisfied:
      requiredReviewerApprovalsSatisfied &&
      ((reviewsUnreadable && normalizedReviewDecision === 'APPROVED') ||
        (!reviewsUnreadable &&
          (normalizedReviewDecision === 'APPROVED' ||
            !normalizedReviewDecision) &&
          (branchReviewRequirements.requiredApprovingReviewCount === 0 ||
            humanApprovedCount >=
              branchReviewRequirements.requiredApprovingReviewCount))),
    codeownerApprovalSatisfied:
      !branchReviewRequirements.requireCodeOwnerReview ||
      !hasExplicitCodeownerMatches ||
      codeownerApproved ||
      (reviewsUnreadable && normalizedReviewDecision === 'APPROVED'),
    codeownerSelfApproval,
    humanChangesRequestedCount: blockingChangesRequestedLogins.length,
    blockingChangesRequestedLogins,
  };
}

function summarizeCodeownerSelfApproval({
  requireCodeOwnerReview,
  codeownerApprovalSatisfied,
  hasExplicitCodeownerMatches,
  codeownerUserLogins = [],
  eligibleCodeownerUserLogins = null,
  eligibleCodeownerUserLoginsUnreadable = false,
  codeownerTeamSlugs = [],
  codeownerEmailAddresses = [],
  prAuthorLogin = '',
  viewerLogin = '',
  viewerTeamSlugs = [],
  viewerAppSlug = '',
  branchRules = [],
  branchRulesets = [],
  branchRulesetsUnreadable = false,
  classicRequireCodeOwnerReview = false,
  classicBypassPullRequestUserLogins = [],
  classicBypassPullRequestTeamSlugs = [],
  classicBypassPullRequestAppSlugs = [],
}: {
  requireCodeOwnerReview: boolean;
  codeownerApprovalSatisfied: boolean;
  hasExplicitCodeownerMatches: boolean;
  codeownerUserLogins?: unknown[];
  eligibleCodeownerUserLogins?: unknown[] | null;
  // #1521 (Codex review): true when at least one direct-user codeowner's
  // collaborator-permission lookup failed for a reason OTHER than "not a
  // collaborator" (403/5xx/network/timeout). A narrowed
  // `eligibleCodeownerUserLogins` built while this is true cannot be
  // trusted to prove the PR author is the sole eligible codeowner --
  // forces `prAuthorIsSoleEligibleCodeowner` to `false` below.
  eligibleCodeownerUserLoginsUnreadable?: boolean;
  codeownerTeamSlugs?: unknown[];
  codeownerEmailAddresses?: unknown[];
  prAuthorLogin?: string | null;
  viewerLogin?: string | null;
  viewerTeamSlugs?: unknown[];
  viewerAppSlug?: string | null;
  branchRules?: BranchRuleLike[];
  branchRulesets?: BranchRulesetLike[];
  // #1380: see `buildPreMergeReadinessSummary`'s option of the same name.
  branchRulesetsUnreadable?: boolean;
  classicRequireCodeOwnerReview?: boolean;
  classicBypassPullRequestUserLogins?: unknown[];
  classicBypassPullRequestTeamSlugs?: unknown[];
  classicBypassPullRequestAppSlugs?: unknown[];
}) {
  const normalizedAuthor = String(prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewer = String(viewerLogin ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerAppSlug = String(viewerAppSlug ?? '')
    .trim()
    .toLowerCase();
  const normalizedViewerTeamSlugs =
    normalizeTrustedMarkerLogins(viewerTeamSlugs);
  const directCodeownerUserLogins =
    normalizeTrustedMarkerLogins(codeownerUserLogins);
  const eligibleDirectCodeownerUserLogins =
    eligibleCodeownerUserLogins === null
      ? directCodeownerUserLogins
      : normalizeTrustedMarkerLogins(eligibleCodeownerUserLogins).filter(
          (login) => directCodeownerUserLogins.includes(login),
        );
  const normalizedCodeownerTeamSlugs =
    normalizeTrustedMarkerLogins(codeownerTeamSlugs);
  const normalizedCodeownerEmailAddresses = normalizeTrustedMarkerLogins(
    codeownerEmailAddresses,
  );
  const classicBypassDetected = Boolean(
    Boolean(classicRequireCodeOwnerReview) &&
      ((normalizedViewer &&
        normalizeTrustedMarkerLogins(
          classicBypassPullRequestUserLogins,
        ).includes(normalizedViewer)) ||
        normalizedViewerTeamSlugs.some((slug) => {
          return normalizeTrustedMarkerLogins(
            classicBypassPullRequestTeamSlugs,
          ).includes(slug);
        }) ||
        (normalizedViewerAppSlug &&
          normalizeTrustedMarkerLogins(
            classicBypassPullRequestAppSlugs,
          ).includes(normalizedViewerAppSlug))),
  );
  const bypass = summarizeRulesetPullRequestBypass(
    branchRulesets,
    branchRules,
    branchRulesetsUnreadable,
  );
  const rulesetGateSatisfiedByBypass =
    bypass.relevantRulesetCount === 0 || bypass.detected;
  const classicGateSatisfiedByBypass =
    !classicRequireCodeOwnerReview || classicBypassDetected;
  const applicableBypassDetected =
    (bypass.detected || classicBypassDetected) &&
    rulesetGateSatisfiedByBypass &&
    classicGateSatisfiedByBypass;
  const applicableBypassMode = applicableBypassDetected
    ? bypass.detected
      ? bypass.mode
      : 'pull_request'
    : 'none';
  // Hoisted above `base` (moved up from its original position further down,
  // right before the `deadlock` branch that also consumes it) so the #1521
  // `prAuthorIsSoleEligibleCodeowner` field below can reuse this exact
  // expression instead of recomputing an equivalent one. Pure and
  // side-effect-free, so hoisting it earlier changes nothing about the
  // later branches that also read it.
  const allDirectUsersAreAuthor =
    eligibleDirectCodeownerUserLogins.length > 0 &&
    eligibleDirectCodeownerUserLogins.every(
      (login) => login === normalizedAuthor,
    );
  // #1521: additive topology fact, computed independently of `status` /
  // `applicableBypassDetected` below and exposed on every branch (not just
  // the `deadlock` one). This is the ONLY safe discriminator an F3 caller
  // may use to gate an automatic `--admin` retry: `status: 'clear'` alone
  // (whether via `applicableBypassDetected` or `hasNonAuthorDirectUser`
  // further down) does NOT prove the PR author is the sole codeowner --
  // `applicableBypassDetected` fires whenever a bypass actor is configured
  // for the viewer, regardless of whether a genuinely distinct non-author
  // codeowner's review is separately outstanding. Deliberately NOT folded
  // into `status`/`reason` themselves (that general gate intentionally
  // keeps its existing pass/fail shape for every adopter repo -- see the
  // #1521 review discussion); a caller that needs the narrow self-deadlock
  // fact must check this field explicitly alongside `status`/`reason`.
  //
  // Requires `!eligibleCodeownerUserLoginsUnreadable` (Codex review, #1521):
  // `eligibleDirectCodeownerUserLogins` can be silently NARROWED by a
  // transient permission-lookup failure for some OTHER direct codeowner
  // (see `resolveEligibleCodeownerUserLogins` in pre-merge-readiness.mts),
  // which would make the author look like the sole eligible codeowner even
  // though a real co-owner's eligibility simply could not be confirmed.
  // Fail closed rather than trust a possibly-incomplete narrowed set.
  const prAuthorIsSoleEligibleCodeowner =
    Boolean(normalizedAuthor) &&
    normalizedCodeownerTeamSlugs.length === 0 &&
    normalizedCodeownerEmailAddresses.length === 0 &&
    !eligibleCodeownerUserLoginsUnreadable &&
    allDirectUsersAreAuthor;
  const base = {
    status: 'not_applicable',
    reason: 'codeowner-review-not-required',
    prAuthorLogin: normalizedAuthor,
    directCodeownerUserLogins,
    codeownerTeamSlugs: normalizedCodeownerTeamSlugs,
    requireCodeOwnerReview: Boolean(requireCodeOwnerReview),
    codeownerApprovalSatisfied: Boolean(codeownerApprovalSatisfied),
    bypassDetected: applicableBypassDetected,
    bypassMode: applicableBypassMode,
    currentUserCanBypass: bypass.currentUserCanBypass,
    // #1380: true when a codeowner-requiring ruleset's *detail* read was
    // masked-404 unreadable, so `bypass.detected` could not rule out an
    // actual configured bypass. Diagnostic only -- never flips a `status`
    // to `clear` on its own -- but downgrades a would-be certain `deadlock`
    // below to the already-documented `possible_deadlock`.
    rulesetBypassUnreadable: bypass.unreadable,
    prAuthorIsSoleEligibleCodeowner,
    // #1521: true when at least one direct-user codeowner's
    // collaborator-permission lookup was unreadable (see
    // `prAuthorIsSoleEligibleCodeowner` above). Diagnostic only, mirroring
    // `rulesetBypassUnreadable`'s shape -- never flips `status` on its own.
    codeownerEligibilityUnreadable: Boolean(
      eligibleCodeownerUserLoginsUnreadable,
    ),
  };

  if (!requireCodeOwnerReview) {
    return base;
  }
  if (!hasExplicitCodeownerMatches) {
    return {
      ...base,
      reason: 'no-explicit-codeowner-match',
    };
  }
  if (codeownerApprovalSatisfied) {
    return {
      ...base,
      reason: 'codeowner-approval-satisfied',
    };
  }
  if (applicableBypassDetected) {
    return {
      ...base,
      status: 'clear',
      reason:
        applicableBypassMode === 'pull_request'
          ? 'pull-request-bypass-available'
          : 'ruleset-bypass-available',
    };
  }
  if (!normalizedAuthor) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'pr-author-unknown',
    };
  }

  // `allDirectUsersAreAuthor` is computed above (hoisted next to
  // `prAuthorIsSoleEligibleCodeowner` in `base`); reused here unchanged.
  const hasNonAuthorDirectUser = eligibleDirectCodeownerUserLogins.some(
    (login) => login !== normalizedAuthor,
  );

  if (hasNonAuthorDirectUser) {
    return {
      ...base,
      status: 'clear',
      reason: 'non-author-codeowner-available',
    };
  }
  if (normalizedCodeownerTeamSlugs.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'team-codeowner-ambiguous',
    };
  }
  if (normalizedCodeownerEmailAddresses.length > 0) {
    return {
      ...base,
      status: 'possible_deadlock',
      reason: 'email-codeowner-ambiguous',
    };
  }
  if (allDirectUsersAreAuthor) {
    // #1380: a masked-404 on a relevant ruleset's detail read means
    // `bypass.detected` could not rule out an actual configured bypass for
    // this PR author -- asserting a *certain* `deadlock` here would be an
    // unjustified false-certainty diagnostic. Downgrade to the
    // already-documented `possible_deadlock` (idd-pre-merge.instructions.md:
    // "could not prove ... applicable pull-request bypass, so fail closed")
    // instead of inventing a new status value.
    if (bypass.unreadable) {
      return {
        ...base,
        status: 'possible_deadlock',
        reason: 'ruleset-bypass-unreadable',
      };
    }
    return {
      ...base,
      status: 'deadlock',
      reason:
        eligibleCodeownerUserLogins === null
          ? 'pr-author-is-only-direct-codeowner'
          : 'pr-author-is-only-eligible-direct-codeowner',
    };
  }

  return {
    ...base,
    status: 'possible_deadlock',
    reason: 'no-reviewable-codeowner-identity',
  };
}

function summarizeRulesetPullRequestBypass(
  branchRulesets: BranchRulesetLike[] = [],
  branchRules: BranchRuleLike[] = [],
  branchRulesetsUnreadable = false,
) {
  const codeownerRulesetIds = new Set(
    (branchRules ?? [])
      .filter((rule) => {
        return (
          rule?.type === 'pull_request' &&
          Boolean(rule?.parameters?.require_code_owner_review)
        );
      })
      .map((rule) => Number.parseInt(String(rule?.ruleset_id ?? ''), 10))
      .filter(Number.isInteger),
  );
  const expectedRulesetCount = codeownerRulesetIds.size;
  const relevantRulesets = (branchRulesets ?? []).filter((ruleset) => {
    const rulesetId = Number.parseInt(
      String(ruleset?.id ?? ruleset?.ruleset_id ?? ''),
      10,
    );
    return codeownerRulesetIds.has(rulesetId);
  });
  const values = relevantRulesets
    .map((ruleset) => String(ruleset?.current_user_can_bypass ?? '').trim())
    .map((value) => {
      return ['always', 'exempt', 'never', 'pull_requests_only'].includes(value)
        ? value
        : 'unknown';
    })
    .filter(Boolean);
  let currentUserCanBypass = 'unknown';
  if (values.length > 1 && new Set(values).size > 1) {
    currentUserCanBypass = 'mixed';
  } else if (values.includes('exempt')) {
    currentUserCanBypass = 'exempt';
  } else if (values.includes('pull_requests_only')) {
    currentUserCanBypass = 'pull_requests_only';
  } else if (values.includes('always')) {
    currentUserCanBypass = 'always';
  } else if (values.includes('never')) {
    currentUserCanBypass = 'never';
  }
  const bypassValues = new Set(['always', 'exempt', 'pull_requests_only']);
  const detected =
    expectedRulesetCount > 0 &&
    relevantRulesets.length === expectedRulesetCount &&
    values.length === relevantRulesets.length &&
    values.every((value) => bypassValues.has(value));
  let mode = 'none';
  if (detected) {
    if (new Set(values).size > 1) {
      mode = 'mixed';
    } else if (values.includes('pull_requests_only')) {
      mode = 'pull_request';
    } else if (values.includes('always')) {
      mode = 'always';
    } else if (values.includes('exempt')) {
      mode = 'exempt';
    }
  }
  // #1380: only report `unreadable` when a *relevant* (codeowner-requiring)
  // ruleset is actually missing from `relevantRulesets` -- not merely
  // whenever `detected` is `false`, since a fully-read ruleset can
  // legitimately report a real, non-bypass value (e.g. `never`) that also
  // makes `detected` false. That is genuine data, not a masked-404 gap, and
  // must not be relabeled as "could not determine". A masked-404 on a
  // relevant ruleset's detail read only ever *prevents* `detected` from
  // becoming `true` (the count check above requires every expected
  // ruleset's detail to be present), so this can never cause a false
  // `detected: true`.
  const unreadable =
    branchRulesetsUnreadable &&
    expectedRulesetCount > 0 &&
    relevantRulesets.length < expectedRulesetCount;
  return {
    detected,
    mode,
    currentUserCanBypass,
    relevantRulesetCount: expectedRulesetCount,
    unreadable,
  };
}

export function resolveRulesetDetailPath(
  owner: string,
  repo: string,
  rule: BranchRuleLike | null | undefined,
  rulesetId: unknown,
): string {
  const sourceType = String(
    rule?.ruleset_source_type ?? rule?.source_type ?? '',
  )
    .trim()
    .toLowerCase();
  if (sourceType === 'organization') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? owner).trim();
    const org = source.split('/')[0] || owner;
    return `orgs/${encodeURIComponent(org)}/rulesets/${rulesetId}`;
  }
  if (sourceType === 'enterprise') {
    const source = String(rule?.ruleset_source ?? rule?.source ?? '').trim();
    const enterprise = source.split('/')[0];
    if (enterprise) {
      return `enterprises/${encodeURIComponent(enterprise)}/rulesets/${rulesetId}`;
    }
  }
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${rulesetId}`;
}

/** GitHub `pulls/{pr}/commits` REST payload fields `resolvePrFirstCommitAt`
 * consumes, plus `sha` and `commit.message` (#3298): neither is read by
 * `resolvePrFirstCommitAt` itself, but `pre-merge-readiness.mts` reuses this
 * same fetched list for `closingSet.strayCommitCloses`
 * (`supersession-detection.mts`'s `findStrayCommitCloses`), which needs
 * both. */
export interface PrCommitPayload {
  sha?: string | null;
  commit?: {
    message?: string | null;
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  } | null;
}

/**
 * Resolve a PR's first-commit time as an ISO string -- the minimum across all
 * commits of each commit's committer date, falling back to author date. A
 * GitHub `pulls/{pr}/commits` listing is chronological, but compute the
 * minimum defensively rather than relying on order. Returns `null` when no
 * commit carries a parseable date, which makes the Part B gate below fail
 * closed (an `issue-only` handoff against a PR-backed claim stays rejected).
 *
 * Shared by every `prFirstCommitAt` resolver (`pre-merge-readiness.mts`,
 * `advisory-convergence.mts`, `live-status-digest.mts`) so the Part B
 * allowance's date computation has one implementation, not three.
 */
export function resolvePrFirstCommitAt(
  commits: PrCommitPayload[],
): string | null {
  let earliestMs: number | null = null;
  let earliestIso: string | null = null;
  for (const commit of commits) {
    const date =
      String(commit?.commit?.committer?.date ?? '').trim() ||
      String(commit?.commit?.author?.date ?? '').trim();
    if (!date) {
      continue;
    }
    const ms = Date.parse(date);
    if (!Number.isFinite(ms)) {
      continue;
    }
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
      earliestIso = date;
    }
  }
  return earliestIso;
}

/**
 * Build the `isForcedHandoffEnabled` gate shared by every claim-revalidation
 * path (resume routing, the merge-gate, and the write-side helpers).
 *
 * Semantics:
 *
 * - forced-handoff mode disabled → never honor;
 * - no open linked PR backs the claim (`expectedLinkedPrReferences` empty) →
 *   honor an `issue-only` (or any) handoff as before;
 * - an open linked PR backs the claim:
 *   - `issue-plus-pr` handoff → require `linkedPr` to match one of the
 *     expected PRs (unchanged behavior);
 *   - `issue-only` handoff → accept it IFF a `prFirstCommitAt` is supplied
 *     AND the handoff's `createdAt` is a valid ISO timestamp strictly before
 *     it (the handoff predates the PR, so the successor created the PR after
 *     taking over the issue). Any other `issue-only` handoff is rejected.
 *
 * The `prFirstCommitAt` parameter is the Part B extension (#1058). Callers
 * that do not pass it keep the original behavior byte-identical: an
 * `issue-only` handoff against a PR-backed claim is rejected.
 */
export function buildForcedHandoffEnableGate(options: {
  forcedHandoffEnabled: boolean;
  expectedLinkedPrReferences: Set<string>;
  prFirstCommitAt?: string | null;
}): (forcedHandoff: ParsedForcedHandoffMarker) => boolean {
  const { forcedHandoffEnabled, expectedLinkedPrReferences } = options;
  const prFirstCommitAt =
    typeof options.prFirstCommitAt === 'string' ? options.prFirstCommitAt : '';
  return (forcedHandoff: ParsedForcedHandoffMarker) => {
    if (!forcedHandoffEnabled) {
      return false;
    }
    if (expectedLinkedPrReferences.size === 0) {
      return true;
    }
    if (forcedHandoff.contextScope === 'issue-plus-pr') {
      return expectedLinkedPrReferences.has(
        normalizeLinkedPrReference(forcedHandoff.linkedPr),
      );
    }
    // issue-only handoff against a PR-backed claim: accept only when it
    // predates the PR's first commit (a robust ISO compare; either side
    // unparseable → fail closed = reject).
    return isStrictlyBeforeIso(forcedHandoff.createdAt, prFirstCommitAt);
  };
}

/**
 * Resolve the active claim for a write-side merge-gate revalidation, honoring
 * an operator-approved forced handoff while failing closed on
 * unauthorized/forged markers exactly as the Resume routing path does.
 *
 * This is the centralized, pure (no I/O) helper used by the write-side
 * helpers (disposition-non-review-notices, resolve-review-thread) so they no
 * longer ignore forced handoffs. It builds the same forced-handoff enable
 * gate as `summarizeClaimValidation` / `buildForcedHandoffEnabledGate`
 * (extended with the Part B time rule) and delegates the rest of the
 * fail-closed enforcement to `applyClaimEvent` rule 7.
 *
 * - `forcedHandoffEnabled` defaults to `false` (forced handoffs ignored).
 * - `expectedLinkedPrs` of `null`/empty marks an issue-scoped revalidation:
 *   an `issue-only` handoff is accepted (issue takeover). A non-empty set
 *   marks a PR-backed claim and applies the `issue-plus-pr` / `prFirstCommitAt`
 *   rules.
 * - `isAuthorizedForcedHandoff` defaults to an allowlist of ∅ ⇒ always false
 *   (every handoff is treated as unauthorized) when not supplied, so callers
 *   that forget to wire it fail closed.
 * - `requireAuthorMatchesForcedBy` defaults to `true` (the strict
 *   self-signed-hijack block used by Resume routing).
 * - `staleAgeMs` (#1310) is the config-aware claim-staleness window, in
 *   milliseconds (a parsed `claimTiming.staleAge`, e.g. via
 *   {@link readClaimStaleAgeMs}) -- REQUIRED (#3270) so the type checker
 *   catches a future write-gate caller that forgets it, instead of it
 *   silently falling back to the hardcoded 24h `isStaleAt` default the way
 *   every pre-#3270 caller did. A caller that deliberately wants the
 *   distributed 24h default passes {@link DEFAULT_STALE_AGE_MS} explicitly.
 *   Invalid (non-numeric/non-finite) or non-positive values still fall back
 *   to {@link isStaleAt} via `resolveStalePredicate`. See `isStaleByAge`.
 */
export function resolveActiveClaimForWriteGate(
  events: CommentLike[],
  options: {
    isTrustedAuthor: (login: string) => boolean;
    forcedHandoffEnabled?: boolean;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    requireAuthorMatchesForcedBy?: boolean;
    staleAgeMs: number;
  },
): ParsedClaimMarker | null {
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const isForcedHandoffEnabled = buildForcedHandoffEnableGate({
    forcedHandoffEnabled: options.forcedHandoffEnabled === true,
    expectedLinkedPrReferences,
    prFirstCommitAt: options.prFirstCommitAt ?? null,
  });
  return resolveActiveClaim(events, {
    isTrustedAuthor: options.isTrustedAuthor,
    isForcedHandoffEnabled,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    requireAuthorMatchesForcedBy: options.requireAuthorMatchesForcedBy ?? true,
    isStale: resolveStalePredicate(options.staleAgeMs),
  });
}

export function summarizeClaimValidation(
  claimEvents: CommentLike[] = [],
  options: {
    trustedMarkerLogins?: unknown[] | null;
    authorizedForcedHandoffLogins?: unknown[] | null;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    expectedClaimId?: unknown;
    expectedAgentId?: unknown;
    // #1528: this session's own recorded activation-nonce (#1522), so the
    // merge-time write-gate can detect a second, independent activation of
    // the same claim-id -- the sticky forced-handoff adopt-verbatim
    // collision -- the same way resume-claim-routing.mts's A5(c) resume
    // check already does. Omitted (or no trusted activation-nonce marker
    // exists for the active claim-id) skips the comparison entirely,
    // keeping the claim-id/agent-id-only outcome (#1522 AC3, backward
    // compatible with every caller that predates this option).
    expectedNonce?: unknown;
    isTrustedAuthor?: (login: string) => boolean;
    forcedHandoffEnabled?: boolean;
    isForcedHandoffEnabled?: (
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    staleAgeMs?: number;
  } = {},
  /**
   * kurone-kito/idd-skill#2911: optional out-parameter this function
   * mutates in place with `resolveActiveClaimWithForcedHandoffTrace`'s
   * `activeSince` (the non-mutable claim-identity-transition anchor --
   * see that interface's own doc comment for why `ClaimValidationSummary
   * .activeClaim.createdAt` is unsuitable for this). Deliberately NOT a
   * new field on `ClaimValidationSummary` itself: that type's shape is
   * embedded in multiple schemas beyond `pre-merge-readiness.schema.json`
   * (e.g. `discover-roadmap-union.schema.json`), so widening it would
   * ripple into unrelated consumers. Every existing caller passes no 3rd
   * argument and is completely unaffected; `buildPreMergeReadinessSummary`
   * is the sole caller that supplies one today.
   */
  captureTraceInto?: { activeSince?: string },
): ClaimValidationSummary {
  const trustedMarkerLogins = new Set(
    normalizeTrustedMarkerLogins(options.trustedMarkerLogins ?? []),
  );
  const authorizedForcedHandoffLogins = new Set(
    normalizeTrustedMarkerLogins(options.authorizedForcedHandoffLogins ?? []),
  );
  const expectedLinkedPrReferences = new Set(
    (options.expectedLinkedPrs ?? [])
      .map((value) => normalizeLinkedPrReference(value))
      .filter(Boolean),
  );
  const expectedClaimId = String(options.expectedClaimId ?? '').trim();
  const expectedAgentId = String(options.expectedAgentId ?? '').trim();
  const trustedAuthorPredicate =
    typeof options.isTrustedAuthor === 'function'
      ? options.isTrustedAuthor
      : (login: string) =>
          trustedMarkerLogins.has(
            String(login ?? '')
              .trim()
              .toLowerCase(),
          );

  // Merge-side write-gate forced-handoff strictness — intentionally the
  // lenient half of the strict-resume vs. lenient-relay-merge split (see
  // docs/idd-design-rationale.md, "Claim resolution"). This call leaves
  // `requireAuthorMatchesForcedBy` at its lenient default (off) so a
  // maintainer-authorized handoff relayed by a separate automation actor is
  // still honored — authorization rests on `isAuthorizedForcedHandoff` alone —
  // and it passes `prFirstCommitAt` so the Part-B allowance (#1058, an
  // issue-only handoff predating the PR) applies. resume-claim-routing.mts
  // deliberately does the opposite (`requireAuthorMatchesForcedBy: true`, no
  // `prFirstCommitAt`) because a takeover decision must block the same-identity
  // self-signed hijack. The two callers can therefore return different verdicts
  // for the same corrected-handoff state (resume `already_owned` vs. merge
  // `claimLost`) by design; both still funnel through the single
  // resolveActiveClaim resolver.
  // kurone-kito/idd-skill#2911: switched from the thin `resolveActiveClaim`
  // wrapper to the full trace, so `captureTraceInto` (when the caller
  // supplies it) can recover `activeSince` -- the same single-pass
  // reduction, just no longer discarding the extra field. Every existing
  // caller only ever read `.activeClaim` off `resolveActiveClaim`'s own
  // return, so this is behavior-identical for that value.
  const { activeClaim, activeSince } = resolveActiveClaimWithForcedHandoffTrace(
    claimEvents,
    {
      isTrustedAuthor: trustedAuthorPredicate,
      isForcedHandoffEnabled:
        typeof options.isForcedHandoffEnabled === 'function'
          ? options.isForcedHandoffEnabled
          : buildForcedHandoffEnableGate({
              forcedHandoffEnabled: options.forcedHandoffEnabled === true,
              expectedLinkedPrReferences,
              prFirstCommitAt: options.prFirstCommitAt ?? null,
            }),
      isAuthorizedForcedHandoff:
        typeof options.isAuthorizedForcedHandoff === 'function'
          ? options.isAuthorizedForcedHandoff
          : (forcedBy: string) => {
              if (authorizedForcedHandoffLogins.size === 0) {
                return false;
              }
              return authorizedForcedHandoffLogins.has(
                String(forcedBy ?? '')
                  .trim()
                  .toLowerCase(),
              );
            },
      isStale: resolveStalePredicate(options.staleAgeMs),
    },
  );
  if (captureTraceInto) {
    captureTraceInto.activeSince = activeSince;
  }

  const expectedNonce = String(options.expectedNonce ?? '').trim();

  let reason = 'match';
  if (!activeClaim) {
    reason = 'missing-active-claim';
  } else if (expectedClaimId && activeClaim.claimId !== expectedClaimId) {
    reason = 'claim-id-mismatch';
  } else if (expectedAgentId && activeClaim.agentId !== expectedAgentId) {
    reason = 'agent-id-mismatch';
  } else if (expectedClaimId && expectedNonce) {
    // #1528: mirrors evaluateResumeClaimRouting's activation-nonce-mismatch
    // check (resume-claim-routing.mts) -- only meaningful once claim-id and
    // agent-id already match, since claim-id alone cannot distinguish a
    // second, independent activation of the same id. Computed lazily, here,
    // so every pre-#1528 caller that never passes expectedNonce (the
    // default) pays no parsing/sorting cost for it. Trust-filter first
    // (findActivationNonceWinner does no author checks of its own), matching
    // how the resume-side caller pre-filters before calling the same shared
    // primitive.
    const activationNonceWinner = findActivationNonceWinner(
      claimEvents.filter((event) =>
        trustedAuthorPredicate(event.author?.login ?? event.user?.login ?? ''),
      ),
      activeClaim.claimId,
    );
    if (
      activationNonceWinner !== null &&
      activationNonceWinner !== expectedNonce
    ) {
      reason = 'activation-nonce-mismatch';
    }
  }

  return {
    expectedClaimId,
    expectedAgentId,
    activeClaimPresent: Boolean(activeClaim),
    activeClaim: {
      agentId: activeClaim?.agentId ?? '',
      claimId: activeClaim?.claimId ?? '',
      supersedes: activeClaim?.supersedes ?? '',
      branch: activeClaim?.branch ?? '',
      createdAt: activeClaim?.createdAt ?? '',
    },
    matchesExpectedClaim: reason === 'match',
    claimLost: reason !== 'match',
    reason,
  };
}

/**
 * Write-gate wrapper around {@link summarizeClaimValidation} with a
 * REQUIRED `staleAgeMs` (#1310/#3270). `summarizeClaimValidation` itself
 * keeps `staleAgeMs` optional because it also has non-write-gate callers
 * (status/summary building such as `buildPreMergeReadinessSummary`, and
 * tests exercising unrelated forced-handoff/nonce behavior) that must not
 * be forced to thread a claim-staleness window they do not care about.
 * Every claim-OWNERSHIP write-gate caller (a helper that decides whether
 * THIS session may still mutate GitHub state) should call this wrapper
 * instead, so the type checker catches a future write-gate caller that
 * forgets to resolve and pass the configured window -- the exact class of
 * bug #3270 fixes for the eight callers that previously omitted it.
 */
export function summarizeClaimValidationForWriteGate(
  claimEvents: CommentLike[] = [],
  options: Omit<
    NonNullable<Parameters<typeof summarizeClaimValidation>[1]>,
    'staleAgeMs'
  > & { staleAgeMs: number },
  captureTraceInto?: { activeSince?: string },
): ClaimValidationSummary {
  return summarizeClaimValidation(claimEvents, options, captureTraceInto);
}

/** One unmet pre-merge gate: the gate id plus a human-readable detail. */
export interface PreMergeBlocker {
  gate: string;
  detail: string;
}

function preMergeAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether pre-merge readiness treats this CI summary as all-passing.
 * #3465: the `--from-pr` watermark gate calls this function rather than
 * growing a second definition of green. `protectionReadsUnreadable` and
 * a source-pinned downgrade (status other than `success`,
 * `requiredChecksPassing` false) already decide the result here.
 */
export function isPreMergeCiAllPassing(ci: Record<string, unknown>): boolean {
  // #1377: an unreadable protection/ruleset read means the required-check
  // set this report computed may be incomplete -- a masked 404 can hide
  // additional required checks the readable source(s) never surfaced. Block
  // unconditionally here, before either shortcut below, so a passing
  // subset of (possibly incomplete) required checks can never mark the
  // report ready.
  if (ci.protectionReadsUnreadable === true) {
    return false;
  }
  if (ci.requiredChecksPassing === true || ci.status === 'success') {
    return true;
  }
  return (
    ci.noRequiredChecksConfigured === true &&
    String(ci.presentRunConclusion ?? '') === 'all-passing'
  );
}

function isPreMergeReviewSatisfied(
  reviewerStates: Record<string, unknown>,
): boolean {
  if (reviewerStates.requiredApprovalsSatisfied !== true) {
    return false;
  }
  if (reviewerStates.codeownerApprovalSatisfied === true) {
    return true;
  }
  const selfApproval = preMergeAsRecord(reviewerStates.codeownerSelfApproval);
  return String(selfApproval.status ?? '') === 'clear';
}

/**
 * Roll up the F2/F3 merge gates from a pre-merge-readiness report into the
 * ordered blocker list. This is the single source of the merge-gate AND:
 * `buildPreMergeReadinessSummary` embeds `{ ready, blockers }` computed from it,
 * and `idd-merge-execute.evaluateMergeGates` delegates to it, so no caller
 * re-implements the conjunction. Fail-closed on missing or garbled
 * evidence. Applies the written F2 ack-only overrides (#2125) so a
 * `fully_autonomous_merge` F3 session can complete when courtesy
 * advisory-bot acks are the sole remaining currency or disposition
 * blocker; any other cause still blocks. A live `BLOCKED` merge state
 * plus a non-empty discarded required-check sibling list is its own
 * gate (#2127) and does not take the `--admin` path.
 */
export function computePreMergeReadinessBlockers(
  report: Record<string, unknown>,
): PreMergeBlocker[] {
  const blockers: PreMergeBlocker[] = [];

  // Fail closed on a missing/invalid head: `prHeadSha` binds
  // `--match-head-commit`, so a non-40-hex value must never yield a "ready"
  // verdict with an unsafe merge binding.
  const prHeadSha = String(report.prHeadSha ?? '');
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    blockers.push({
      gate: 'head-sha',
      detail: `prHeadSha "${prHeadSha}" is not a 40-hex commit SHA; cannot bind a safe merge`,
    });
  }

  const reviewCurrency = preMergeAsRecord(report.reviewCurrency);
  const comparisonRoute = String(reviewCurrency.comparisonRoute ?? '');
  const comparisonReason = String(reviewCurrency.comparisonReason ?? '');
  // #2125: F2's ack-only-post-disposition carve-out is now applied here
  // too, so F3 merge-execute does not livelock on CodeRabbit courtesy acks.
  if (
    comparisonRoute !== 'proceed' &&
    !(
      comparisonRoute === 'return-to-e1' &&
      comparisonReason === 'ack-only-post-disposition'
    )
  ) {
    blockers.push({
      gate: 'review-currency',
      detail: `comparisonRoute is "${comparisonRoute}" (expected "proceed"): ${
        comparisonReason || 'unknown'
      }`,
    });
  }

  const threads = preMergeAsRecord(report.threads);
  const actionableCount = Number(threads.actionableCount ?? -1);
  if (actionableCount !== 0) {
    blockers.push({
      gate: 'unresolved-threads',
      detail: `actionableCount is ${actionableCount} (expected 0)`,
    });
  }

  // #2335: optional caller-computed evidence -- an entirely absent
  // `report.secondaryQuietWindow` (a caller that predates this gate, or a
  // hand-built fixture) never blocks, the same backward-compat precedent
  // the `copilotUnavailable` gate below uses. A present evidence object
  // with `elapsed !== true` blocks; `buildSecondaryQuietWindowStatus`
  // itself already reports `elapsed: true` unconditionally when the
  // window is off (`0`/absent) or has no activity to anchor on, so this
  // never fires for an adopter that has not configured
  // `advisoryWait.secondaryQuietWindow`.
  if (report.secondaryQuietWindow !== undefined) {
    const secondaryQuietWindow = preMergeAsRecord(report.secondaryQuietWindow);
    if (secondaryQuietWindow.elapsed !== true) {
      const appliedMinutes = secondaryQuietWindow.minutes ?? 0;
      const configuredMinutes = secondaryQuietWindow.configuredMinutes;
      // #3485: `minutes` is the applied gate length. On the #2544
      // settled-buffer path it is the clamped buffer, not the configured
      // window. Name both when they differ so "(5 min)" is not read as
      // the configured window itself.
      const windowPhrase =
        typeof configuredMinutes === 'number' &&
        Number.isFinite(configuredMinutes) &&
        configuredMinutes !== appliedMinutes
          ? `${String(appliedMinutes)} min settled-buffer of a ${String(configuredMinutes)} min configured window`
          : `${String(appliedMinutes)} min`;
      blockers.push({
        gate: 'secondary-quiet-window',
        detail: `advisoryWait.secondaryQuietWindow (${windowPhrase}) has not elapsed since the last substantive activity at "${String(
          secondaryQuietWindow.anchorAt ?? 'none',
        )}" -- ${String(
          secondaryQuietWindow.remainingMinutes ?? 'unknown',
        )} minute(s) remaining`,
      });
    }
  }

  const advisoryWait = preMergeAsRecord(report.advisoryWait);
  const f3Outcome = String(advisoryWait.f3Outcome ?? '');
  if (f3Outcome !== 'SATISFIED') {
    blockers.push({
      gate: 'advisory-wait',
      detail: `f3Outcome is "${f3Outcome}" (expected "SATISFIED")`,
    });
  }

  // #1570: a settled-but-unreviewed Copilot request (`f3Outcome:
  // "SATISFIED"` once `copilotPending` goes `false`, per
  // `evaluateAdvisoryWaitF3Outcome`'s deliberate settled-path shortcut) must
  // NOT merge unattended when the terminal `#1572` recovery contract has
  // separately proven Copilot unavailable on this HEAD -- `f3Outcome` itself
  // is intentionally left untouched (see `buildPreMergeReadinessSummary`'s
  // module notes) so this is a DEDICATED, additive blocker rather than a
  // change to the `advisory-wait` gate above. Only fires when the caller
  // supplied `copilotUnavailable: true` (computed from
  // `buildCopilotRecoverySummary`); omitted/false never fires, so a caller
  // that has not wired this evidence sees unchanged behavior. A valid
  // maintainer waiver for the `idd-advisory-convergence` selector (the same
  // evidence the CI gate consumes, see advisory-convergence.mts) clears it.
  if (
    advisoryWait.copilotUnavailable === true &&
    advisoryWait.copilotUnavailableWaived !== true
  ) {
    blockers.push({
      gate: 'copilot-terminal-unavailable',
      detail:
        'Copilot is terminally unavailable on current HEAD (recovery cap exhausted and terminal window elapsed with no current-HEAD review) with no valid maintainer external-check waiver and no active provider-outage declaration relief for selector ' +
        `"${DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR}"`,
    });
  }

  const ci = preMergeAsRecord(report.ci);
  if (!isPreMergeCiAllPassing(ci)) {
    // #1689: name the source-pinned cause explicitly when a required check
    // is otherwise green but its ruleset entry carries an
    // `app_id`/`integration_id` this helper cannot verify -- see
    // `summarizeRequiredChecks`'s `sourcePinnedRequiredCheckNames` doc
    // comment. Checked before the masked-403-as-404 detail below since the
    // two causes are mutually exclusive (the source-pinned downgrade only
    // fires on a genuinely readable required-check set).
    const sourcePinnedNames = Array.isArray(ci.sourcePinnedRequiredCheckNames)
      ? (ci.sourcePinnedRequiredCheckNames as unknown[]).map((name) =>
          String(name ?? ''),
        )
      : [];
    // #1689: a pinned source that could not be attributed to any check name
    // (a ruleset `workflows` rule, or a pinned entry with no `context`/
    // `name`/`check`) -- see `sourcePinnedRequiredCheckNames`'s doc comment.
    // Checked so the detail still names the source-pinned cause even when
    // `sourcePinnedNames` above is empty (or only partially covers the
    // pinning, in the mixed case), and so the opt-in caveat only appears
    // when it is actually relevant (an unresolvable source is never
    // covered by `trustSourcePinnedRequiredChecks`).
    const sourcePinnedUnresolved = ci.sourcePinnedUnresolved === true;
    let sourcePinnedDetail = '';
    if (sourcePinnedNames.length > 0 && sourcePinnedUnresolved) {
      sourcePinnedDetail = `required ${sourcePinnedNames.length > 1 ? 'checks' : 'check'} ${sourcePinnedNames.join(
        ', ',
      )}, plus an unresolvable source-pinned required-check requirement (e.g. a ruleset \`workflows\` rule), are source-pinned; producer verification unavailable (set ciGate.trustSourcePinnedRequiredChecks to opt in for the named check(s); the unresolvable source is never covered by this opt-in)`;
    } else if (sourcePinnedNames.length > 0) {
      sourcePinnedDetail = `required ${sourcePinnedNames.length > 1 ? 'checks' : 'check'} ${sourcePinnedNames.join(
        ', ',
      )} ${
        sourcePinnedNames.length > 1 ? 'are' : 'is'
      } source-pinned; producer verification unavailable (set ciGate.trustSourcePinnedRequiredChecks to opt in once the pinned integration is verified)`;
    } else if (sourcePinnedUnresolved) {
      sourcePinnedDetail =
        'an unresolvable source-pinned required-check requirement is in force (e.g. a ruleset `workflows` rule); producer verification unavailable, and this cause is never covered by the ciGate.trustSourcePinnedRequiredChecks opt-in';
    }
    // kurone-kito/idd-skill#2919 (round 2): name the identity-unresolved
    // cause explicitly -- see `summarizeRequiredChecks`'s
    // `identityUnresolvedRequiredCheckNames` doc comment. Independent of
    // (and checked alongside, never exclusively with) the source-pinned
    // cause above: the two downgrades can fire together.
    const identityUnresolvedNames = Array.isArray(
      ci.identityUnresolvedRequiredCheckNames,
    )
      ? (ci.identityUnresolvedRequiredCheckNames as unknown[]).map((name) =>
          String(name ?? ''),
        )
      : [];
    const identityUnresolvedDetail =
      identityUnresolvedNames.length > 0
        ? `required ${identityUnresolvedNames.length > 1 ? 'checks' : 'check'} ${identityUnresolvedNames.join(
            ', ',
          )} ${
            identityUnresolvedNames.length > 1 ? 'have' : 'has'
          } an unresolved workflow-file producer identity (a transient lookup failure, a malformed run reference, or too many distinct reruns to verify this pass); cannot rule out a same-display-name decoy workflow, so this required check cannot be trusted as passing until it resolves cleanly on a later pass`
        : '';
    // kurone-kito/idd-skill#3256: name the non-target-event cause
    // explicitly -- see `summarizeRequiredChecks`'s
    // `nonTargetEventRequiredCheckNames` doc comment. Independent of (and
    // checked alongside, never exclusively with) the two causes above.
    const nonTargetEventNames = Array.isArray(
      ci.nonTargetEventRequiredCheckNames,
    )
      ? (ci.nonTargetEventRequiredCheckNames as unknown[]).map((name) =>
          String(name ?? ''),
        )
      : [];
    const nonTargetEventDetail =
      nonTargetEventNames.length > 0
        ? `required ${nonTargetEventNames.length > 1 ? 'checks' : 'check'} ${nonTargetEventNames.join(
            ', ',
          )} ${
            nonTargetEventNames.length > 1 ? 'have' : 'has'
          } no \`pull_request_target\`-triggered pass among their live instances (only a non-target event, e.g. \`pull_request\`); a same-repository PR could edit that event's own copy of the workflow, so this required check cannot be trusted as passing until a \`pull_request_target\`-triggered instance passes`
        : '';
    // kurone-kito/idd-skill#2919 (round 4 -- Codex review on PR #2921, P2;
    // round 5 -- advisor review, replacing an earlier per-check-name
    // reconstruction here): the specific pinned/identity-unresolved causes
    // above must never SILENTLY suppress a genuinely separate, concurrent
    // CI failure reason for a DIFFERENT required check -- e.g. one
    // required check is source-pinned/identity-unresolved while an
    // UNRELATED required check is actually FAILING/PENDING/MISSING.
    // Without this, an operator reading only "check X is identity-
    // unresolved" would retry expecting that alone to unblock the gate,
    // when a clean retry would still be blocked by the separate failure.
    //
    // Uses `ci.preDowngradeStatus` -- `summarizeRequiredChecks`'s own
    // dedup+waiver-adjusted classification BEFORE either downgrade could
    // narrow it -- rather than re-deriving per-check pass/fail evidence
    // from `ci.checks` here. An earlier revision built a `Map` keyed by
    // check name from the RAW (non-deduped) `ci.checks` array and read
    // each entry's raw `state`, which is wrong two ways: `Map` keeps
    // whichever same-name instance happens to appear LAST in rollup
    // order, not the dedup-selected latest one (a superseded FAILURE
    // sorted after its own later SUCCESS would spuriously read as the
    // "current" state), and it ignored `coveredByWaiver` entirely (a
    // genuinely WAIVED required check, raw state FAILURE, would
    // spuriously count as an unexplained concurrent cause). Reusing
    // `preDowngradeStatus` is exact by construction: `success` there
    // means every OTHER required check was already fully resolved as
    // passing (through the SAME dedup/waiver logic `classifyCiChecks`
    // always applies) before either downgrade ran, so any non-success
    // `status` can only be attributed to the named causes below.
    // Every PRE-#2919 caller (no pinned/identity cause at all) and every
    // pinned-ONLY caller (that downgrade only ever fires when
    // `preDowngradeStatus` was already `'success'`, so no concurrent
    // cause can exist) sees byte-identical detail text to before -- this
    // only widens the detail for the new combined shape.
    // kurone-kito/idd-skill#2919 (round 5 -- E10 critique, latent-trap
    // note, not a bug today; kurone-kito/idd-skill#3256 added the third
    // cause below): on a branch with NO required checks configured at
    // all (`ci.noRequiredChecksConfigured: true`),
    // `sourcePinnedNames`/`identityUnresolvedNames`/`nonTargetEventNames`
    // are always empty (all three downgrades live entirely inside
    // `summarizeRequiredChecks`'s `requiredCheckNames.length > 0` block)
    // and `preDowngradeStatus` stays its unset `'unknown'` default -- so
    // `hasUnexplainedConcurrentCause` is spuriously `true` here, but
    // harmlessly: `sourcePinnedDetail`, `identityUnresolvedDetail`, and
    // `nonTargetEventDetail` below are ALSO all empty in this case, so
    // the `[...].filter(Boolean).join('; ') || genericStatusDetail`
    // expression reduces to `genericStatusDetail` either way (identical to
    // pre-#2919 behavior for the unprotected-branch path; the gate itself
    // still correctly blocks via `resolvePresentRunConclusion` above,
    // which IS called unconditionally). If a future change adds an
    // identity-unresolved-specific detail sentence for THIS
    // no-required-checks path too, it must also gate
    // `hasUnexplainedConcurrentCause` on `ci.requiredCheckCount > 0` (or
    // equivalent) first, or it will reintroduce the exact spurious-
    // generic-suffix bug this round fixed for the required-checks-
    // configured path, just on the opposite branch.
    const hasUnexplainedConcurrentCause =
      String(ci.preDowngradeStatus ?? 'unknown') !== 'success';
    // #1377: name the masked-403-as-404 cause explicitly when that is why the
    // gate is not all-passing, matching idd-ci.instructions.md's wording,
    // instead of the generic status/noRequiredChecksConfigured detail below.
    const genericStatusDetail = `CI is not all-passing (status="${String(
      ci.status ?? '',
    )}", noRequiredChecksConfigured=${Boolean(
      ci.noRequiredChecksConfigured,
    )}, presentRunConclusion="${String(ci.presentRunConclusion ?? '')}")`;
    let detail =
      ci.protectionReadsUnreadable === true
        ? 'cannot determine required checks: protection/ruleset unreadable'
        : [
            sourcePinnedDetail,
            identityUnresolvedDetail,
            nonTargetEventDetail,
            hasUnexplainedConcurrentCause ? genericStatusDetail : '',
          ]
            .filter(Boolean)
            .join('; ') || genericStatusDetail;

    // #2021: when the `idd-advisory-convergence` check itself is present,
    // required, and non-passing, and a posted otherwise-valid waiver exists
    // for it but is not yet covering the check because its deadline/
    // terminal precondition has not opened (see
    // `advisoryConvergenceWaiverPrecondition` in
    // `buildPreMergeReadinessSummary`), append that evidence -- including
    // the remaining time-to-deadline -- so an agent reading this blocker
    // does not have to independently re-derive it or mistake "waiver
    // posted" for "check covered". Scoped to that specific check (not just
    // "some ci blocker exists") so an unrelated failing check (e.g. lint)
    // never gets this note appended.
    const advisoryConvergencePrecondition = preMergeAsRecord(
      report.advisoryConvergenceWaiverPrecondition,
    );
    const advisoryConvergenceCheckSelector = String(
      advisoryConvergencePrecondition.checkSelector ?? '',
    );
    const advisoryConvergenceCheckNonPassing =
      advisoryConvergenceCheckSelector &&
      Array.isArray(ci.checks) &&
      (ci.checks as Record<string, unknown>[]).some(
        (check) =>
          check?.required === true &&
          check?.coveredByWaiver !== true &&
          !CHECK_PASS_EQUIVALENT_STATES.has(String(check?.state ?? '')) &&
          matchCheckSelectorLocal(
            check?.name,
            advisoryConvergenceCheckSelector,
          ),
      );
    const waiverEvidenceForDetail = preMergeAsRecord(report.waiverEvidence);
    const waiverEvidenceValidList = Array.isArray(waiverEvidenceForDetail.valid)
      ? (waiverEvidenceForDetail.valid as Record<string, unknown>[])
      : [];
    // #2021 (Codex review on PR #2033): distinguish an EXACT-selector waiver
    // (the only kind `advisory-convergence.mts`'s own gate ever counts, see
    // `advisoryConvergenceExactWaiverValid` in `buildPreMergeReadinessSummary`)
    // from a broader glob-only match, so this detail never implies "posting
    // an exact waiver and waiting out the deadline is sufficient" when the
    // real cause is that only a glob selector (e.g. `idd-*`) targets this
    // check -- that never converges no matter how long the deadline waits.
    const advisoryConvergenceExactWaiverEntries =
      waiverEvidenceValidList.filter(
        (entry) =>
          String(entry?.checkSelector ?? '') ===
          advisoryConvergenceCheckSelector,
      );
    const advisoryConvergenceExactWaiverCount =
      advisoryConvergenceExactWaiverEntries.length;
    const advisoryConvergenceAnyWaiverCount = waiverEvidenceValidList.filter(
      (entry) =>
        matchCheckSelectorLocal(
          advisoryConvergenceCheckSelector,
          entry?.checkSelector,
        ),
    ).length;
    const advisoryConvergencePreconditionOpenForDetail =
      advisoryConvergencePrecondition.open === true;
    if (
      advisoryConvergenceCheckNonPassing &&
      advisoryConvergenceAnyWaiverCount > 0
    ) {
      const deadlineMinutes = Number(
        advisoryConvergencePrecondition.deadlineMinutes ?? 0,
      );
      const elapsedMinutes = advisoryConvergencePrecondition.elapsedMinutes;
      const remainingMinutes =
        typeof elapsedMinutes === 'number'
          ? Math.max(0, deadlineMinutes - elapsedMinutes)
          : null;
      const reasons: string[] = [];
      if (!advisoryConvergencePreconditionOpenForDetail) {
        reasons.push(
          'its deadline/terminal precondition has not opened -- ' +
            `deadlineMinutes=${deadlineMinutes}, ` +
            `elapsedMinutes=${elapsedMinutes ?? 'unknown'}, ` +
            `remainingMinutes=${remainingMinutes ?? 'unknown'}, ` +
            `terminalUnavailable=${Boolean(
              advisoryConvergencePrecondition.terminalUnavailable,
            )}`,
        );
      }
      if (advisoryConvergenceExactWaiverCount === 0) {
        reasons.push(
          'no posted waiver has a selector that EXACTLY equals ' +
            `"${advisoryConvergenceCheckSelector}" (only a broader/glob ` +
            "selector matches this check by name); advisory-convergence.mts's " +
            'own gate never counts a glob match for its own selector, so ' +
            'this check cannot converge via that waiver regardless of the ' +
            'precondition',
        );
      }
      // #2034: precondition open AND an exact-match waiver exists, yet the
      // check is still reported non-passing -- the only remaining cause is
      // the rerun-freshness gate: the check's own live run last completed
      // before the waiver became genuinely active. Name the stale run's
      // `completedAt` and the waiver's own `createdAt` explicitly, mirroring
      // the other two reasons, instead of leaving an agent to re-derive why
      // an apparently-satisfied waiver still left the check blocked.
      if (
        advisoryConvergencePreconditionOpenForDetail &&
        advisoryConvergenceExactWaiverCount > 0 &&
        reasons.length === 0
      ) {
        const staleCheck = Array.isArray(ci.checks)
          ? (ci.checks as Record<string, unknown>[]).find(
              (check) =>
                check?.required === true &&
                check?.coveredByWaiver !== true &&
                !CHECK_PASS_EQUIVALENT_STATES.has(String(check?.state ?? '')) &&
                matchCheckSelectorLocal(
                  check?.name,
                  advisoryConvergenceCheckSelector,
                ),
            )
          : undefined;
        const staleCompletedAt =
          String(staleCheck?.completedAt ?? '') || 'none';
        const waiverCreatedAts = advisoryConvergenceExactWaiverEntries
          .map((entry) => String(entry?.createdAt ?? 'none'))
          .join(', ');
        // The deadline path has a real, computable activation override (the
        // deadline-open moment); the terminal-unavailability path does not,
        // so the cutoff there is the waiver's own createdAt alone -- naming
        // both unconditionally would misstate the terminal case.
        const activeSinceDescription =
          advisoryConvergencePrecondition.deadlinePassed === true
            ? `not at or after the waiver's own createdAt (${waiverCreatedAts}) ` +
              'or the #2021 deadline precondition-open moment, whichever is later'
            : `not at or after the waiver's own createdAt (${waiverCreatedAts})`;
        reasons.push(
          `its live run last completed at "${staleCompletedAt}", which is ` +
            `${activeSinceDescription} -- rerun the check so its live run ` +
            'reflects the waiver before trusting this as covered',
        );
      }
      if (reasons.length > 0) {
        detail +=
          ` (a posted external-check waiver exists for current HEAD but is ` +
          `not yet covering "${advisoryConvergenceCheckSelector}": ${reasons.join('; ')})`;
      }
    }
    blockers.push({ gate: 'ci', detail });
  }

  // kurone-kito/idd-skill#2911: the OPPOSITE direction from the block
  // above -- CI may currently report `idd-advisory-convergence` PASSING,
  // but `buildPreMergeReadinessSummary`'s own `staleSelfWaiver` evidence
  // (see its computation for the full rationale and the six findings this
  // closes) may show that pass rests on a self-referential-bootstrap-auto
  // waiver that has since gone stale, with no rerun since. Independent of
  // (and not gated by) `isPreMergeCiAllPassing` above, since the whole
  // point is to catch a check that currently LOOKS all-passing.
  const staleSelfWaiver = preMergeAsRecord(report.staleSelfWaiver);
  if (staleSelfWaiver.stale === true) {
    const staleSelfWaiverCheckSelector = String(
      staleSelfWaiver.checkSelector ?? '',
    );
    const staleReasonDetail =
      staleSelfWaiver.reason === 'wrong-claim'
        ? `was bound to claim "${String(
            staleSelfWaiver.waiverClaimId ?? 'unknown',
          )}", which the current claim identity (installed at "${
            String(report.claimIdentityInstalledAt ?? '') || 'unknown'
          }") no longer matches, with no rerun since`
        : `expired at "${String(
            staleSelfWaiver.expiresAt ?? 'unknown',
          )}" with no rerun since`;
    blockers.push({
      gate: 'ci',
      detail:
        `"${staleSelfWaiverCheckSelector}" currently reports a passing ` +
        `conclusion, but the self-referential-bootstrap-auto waiver ` +
        `posted by github-actions[bot] that may have justified it ` +
        `${staleReasonDetail} -- GitHub does not automatically ` +
        're-evaluate a passing check when its supporting waiver comment ' +
        `stops being valid. Rerun "${staleSelfWaiverCheckSelector}" for ` +
        'the current HEAD before merging so it reflects the current, ' +
        'unwaived state.',
    });
  }

  const reviewerStates = preMergeAsRecord(report.reviewerStates);
  if (!isPreMergeReviewSatisfied(reviewerStates)) {
    const selfApproval = preMergeAsRecord(reviewerStates.codeownerSelfApproval);
    // #1380: name the masked-403-as-404 ruleset-detail cause explicitly when
    // that is *why* the required-reviews gate is unmet, mirroring the CI
    // gate's `protectionReadsUnreadable`-specific detail above, instead of
    // the generic status detail below. Gate on the specific `reason` (set
    // only by the one branch in `summarizeCodeownerSelfApproval` that
    // actually resolved to this cause), not the bare
    // `rulesetBypassUnreadable` boolean: that flag is present on every
    // returned branch (it lives on `base`), so an unrelated resolution --
    // e.g. `possible_deadlock`/`team-codeowner-ambiguous` -- could also
    // carry `rulesetBypassUnreadable: true` (the same fetch that flagged
    // the ruleset unreadable) while the real blocking cause is the
    // ambiguous team, not the unreadable ruleset. Naming the wrong cause
    // would misdirect an operator's remediation.
    const detail =
      selfApproval.reason === 'ruleset-bypass-unreadable'
        ? 'cannot determine CODEOWNER ruleset bypass: ruleset detail unreadable'
        : `required/CODEOWNER reviews not satisfied (requiredApprovalsSatisfied=${Boolean(
            reviewerStates.requiredApprovalsSatisfied,
          )}, codeownerApprovalSatisfied=${Boolean(
            reviewerStates.codeownerApprovalSatisfied,
          )}, codeownerSelfApproval.status="${String(selfApproval.status ?? '')}")`;
    blockers.push({ gate: 'required-reviews', detail });
  }

  const claim = preMergeAsRecord(report.claim);
  if (claim.matchesExpectedClaim !== true) {
    blockers.push({
      gate: 'claim-ownership',
      detail: `claim ownership does not match (reason="${String(
        claim.reason ?? 'unknown',
      )}")`,
    });
  }

  const dispositionEvidence = preMergeAsRecord(report.dispositionEvidence);
  // The written F2/F3 gate requires BOTH `route === 'proceed'` AND
  // `blockingCount === 0`, except the documented F2 override when
  // `soleCauseAckOnlyPostDisposition` is exactly true (#2125). Fail
  // closed on a non-zero or non-numeric blockingCount otherwise.
  const dispositionRoute = String(dispositionEvidence.route ?? '');
  const dispositionBlockingCount = Number(
    dispositionEvidence.blockingCount ?? -1,
  );
  const soleCauseAckOnlyPostDisposition =
    dispositionEvidence.soleCauseAckOnlyPostDisposition === true &&
    dispositionRoute === 'return-to-e1' &&
    Number.isInteger(dispositionBlockingCount) &&
    dispositionBlockingCount > 0;
  if (
    !soleCauseAckOnlyPostDisposition &&
    (dispositionRoute !== 'proceed' || dispositionBlockingCount !== 0)
  ) {
    blockers.push({
      gate: 'disposition-evidence',
      detail: `dispositionEvidence.route is "${
        dispositionRoute || 'missing'
      }" (expected "proceed"), blockingCount=${dispositionBlockingCount} (expected 0)`,
    });
  }

  // #1513: fail closed on a missing/garbled `requiresUpToDateHead` -- only
  // an explicit `false` counts as "not required" (matching every gate
  // above's fail-closed promise); an absent/non-boolean value defaults to
  // "required." Scoped to the literal `BEHIND` value only: `UNKNOWN`/null
  // is the async-still-computing state that `idd-pre-merge.instructions.md`
  // F1 and `idd-review-triage.instructions.md`'s E-phase branch-sync check
  // already re-poll as transient, not terminal -- out of this gate's scope.
  // Every other non-BEHIND `gh pr merge` rejection is caught by
  // `idd-merge-execute.mts`'s `deps.mergePr` try/catch instead.
  const branchCurrency = preMergeAsRecord(report.branchCurrency);
  const requiresUpToDateHead = branchCurrency.requiresUpToDateHead !== false;
  const mergeStateStatus = String(
    branchCurrency.mergeStateStatus ?? '',
  ).toUpperCase();
  if (requiresUpToDateHead && mergeStateStatus === 'BEHIND') {
    blockers.push({
      gate: 'branch-currency',
      detail: `mergeStateStatus is "BEHIND" and the base branch requires an up-to-date head before merge (requiresUpToDateHeadSource="${String(
        branchCurrency.requiresUpToDateHeadSource ?? 'unknown',
      )}")`,
    });
  }

  // #2127: discarded same-named required-check siblings stay evidence-only
  // while GitHub is CLEAN/BEHIND (#1745). Combined with live BLOCKED they
  // are the Rulesets all-instances split (helper latest-wins is green,
  // GitHub still refuses merge). A non-array or missing list is treated
  // as absent so a CODEOWNER-only BLOCKED path (#1663) stays silent here.
  const discardedSiblings = ci.discardedNonPassingRequiredChecks;
  if (
    mergeStateStatus === 'BLOCKED' &&
    Array.isArray(discardedSiblings) &&
    discardedSiblings.length > 0
  ) {
    blockers.push({
      gate: 'discarded-required-check-siblings',
      detail: `mergeStateStatus is "BLOCKED" and ci.discardedNonPassingRequiredChecks has ${String(
        discardedSiblings.length,
      )} discarded same-named required-check sibling(s); recover via rerun-advisory-convergence, do not merge or --admin`,
    });
  }

  // #2272: fail-closed development-branch invariant. Absent entirely
  // (unmigrated caller / unit fixture) means no gate at all -- distinct
  // from a present-but-empty-`status` value, which this treats as
  // `'unavailable'` (fail closed) rather than silently skipping.
  if (report.developmentBranchTarget) {
    const developmentBranchTarget = preMergeAsRecord(
      report.developmentBranchTarget,
    );
    // `||`, not `??`: an empty-string status (garbled/absent field) must
    // fail closed to 'unavailable' too, not pass '' through unmatched.
    const status = String(developmentBranchTarget.status || 'unavailable');
    const baseRefName = String(developmentBranchTarget.baseRefName ?? '');
    if (status === 'invalid') {
      blockers.push({
        gate: 'development-branch-target',
        detail: `configured developmentBranch is invalid: ${String(
          developmentBranchTarget.reason ?? 'unknown reason',
        )}`,
      });
    } else if (status === 'unavailable') {
      blockers.push({
        gate: 'development-branch-target',
        detail:
          'effective development branch could not be resolved (no developmentBranch policy value and the live repository default branch could not be read)',
      });
    } else if (status === 'configured' || status === 'default') {
      const effectiveBranch = String(developmentBranchTarget.branch ?? '');
      if (effectiveBranch === '' || effectiveBranch !== baseRefName) {
        blockers.push({
          gate: 'development-branch-target',
          detail: `PR base branch "${baseRefName}" does not match the effective development branch "${effectiveBranch}" (status="${status}")`,
        });
      }
    } else {
      // Whitelist, not a denylist: an unrecognized status (a typo, a
      // future enum value this file does not know about yet, or any
      // other coerced-`String(...)` garbage) must fail closed rather
      // than fall through to the branch comparison, where a coincidental
      // `branch === baseRefName` (including both empty) would otherwise
      // silently pass an invariant this file cannot actually vouch for.
      blockers.push({
        gate: 'development-branch-target',
        detail: `unrecognized developmentBranchTarget.status "${status}" (expected "configured", "default", "invalid", or "unavailable")`,
      });
    }
  }

  // #3298: fail-closed closing-set / stray-commit-close invariant, mirroring
  // #2272's developmentBranchTarget precedent immediately above -- absent
  // entirely (unmigrated caller / unit fixture) adds no blocker, while
  // `collectPreMergeReadiness` always emits a `closingSet` section. Whitelist
  // of recognized non-blocking statuses, not a denylist, matching
  // developmentBranchTarget's own convention: an unrecognized status must
  // fail closed rather than silently pass. Tested with `!== undefined`, not
  // truthiness (Copilot review, PR #3353): since the schema requires this
  // section, only a genuinely absent key (the unmigrated-caller case above)
  // skips the gate -- a present `closingSet: null` (or any other falsy,
  // non-object value) is malformed evidence and must still reach
  // `preMergeAsRecord`'s own `{}` fallback below, which resolves to
  // `status: "unavailable"` and blocks, rather than silently passing.
  if (report.closingSet !== undefined) {
    const closingSet = preMergeAsRecord(report.closingSet);
    const status = String(closingSet.status || 'unavailable');
    if (status === 'skipped-non-default-branch' || status === 'match') {
      // D3.5's own non-default-branch exemption, or a clean comparison --
      // neither blocks.
    } else if (status === 'unavailable') {
      blockers.push({
        gate: 'closing-set',
        detail:
          'closing-set evidence unavailable: the live default branch or the PR commit list could not be read, or the commit list hit the REST API’s 250-commit pagination cap',
      });
    } else if (status === 'mismatch') {
      const extra = Array.isArray(closingSet.extra) ? closingSet.extra : [];
      const missing = Array.isArray(closingSet.missing)
        ? closingSet.missing
        : [];
      const strayCommitCloses = Array.isArray(closingSet.strayCommitCloses)
        ? closingSet.strayCommitCloses
        : [];
      const detailParts: string[] = [];
      if (extra.length > 0) {
        detailParts.push(
          `extra closing reference(s) ${extra.join(', ')} outside the deliberate closing set (pass --closing-issues to declare a deliberate multi-issue close)`,
        );
      }
      if (missing.length > 0) {
        detailParts.push(
          `deliberate closing reference(s) ${missing.join(', ')} missing from closingIssuesReferences`,
        );
      }
      for (const entry of strayCommitCloses) {
        const strayEntry = preMergeAsRecord(entry);
        detailParts.push(
          `commit ${String(strayEntry.sha ?? 'unknown')} carries a stray closing keyword for #${String(strayEntry.issue ?? '?')}`,
        );
      }
      blockers.push({
        gate: 'closing-set',
        detail:
          detailParts.length > 0
            ? detailParts.join('; ')
            : 'closingSet.status is "mismatch" with no further detail available',
      });
    } else {
      blockers.push({
        gate: 'closing-set',
        detail: `unrecognized closingSet.status "${status}" (expected "match", "mismatch", "skipped-non-default-branch", or "unavailable")`,
      });
    }
  }

  return blockers;
}

export function buildPreMergeReadinessSummary(
  {
    prHeadSha,
    comments = [],
    reviews = [],
    threads = [],
    checks = [],
    branchRules = [],
    branchRulesets = [],
    branchProtection = {},
    protectionReadsUnreadable = false,
    branchRulesetsUnreadable = false,
    requestedReviewers = [],
    timelineEvents = [],
    claimEvents = [],
    changedFiles = [],
    codeownersText = '',
    eligibleCodeownerUserLogins = null,
    eligibleCodeownerUserLoginsUnreadable = false,
    reviewsUnreadable = false,
    reviewDecision = '',
    mergeStateStatus = '',
    mergeable = '',
  }: {
    prHeadSha: string;
    comments?: CommentLike[];
    reviews?: ReviewLike[];
    threads?: ThreadLike[];
    checks?: CheckLike[];
    branchRules?: BranchRuleLike[];
    branchRulesets?: BranchRulesetLike[];
    branchProtection?: BranchProtectionLike;
    // #1377: true when a branch-protection or ruleset read threw a `404`
    // that was not trusted as genuinely empty (see `fetchGovernanceJson`
    // in pre-merge-readiness.mts). Forces `ci.noRequiredChecksConfigured`
    // to `false` regardless of what the (fallback-empty) reads above
    // computed, so the F2/F3 CI gate cannot vacuously pass on an unread
    // state. Omitted by unit callers (default `false`, unchanged
    // pre-`#1377` behavior).
    protectionReadsUnreadable?: boolean;
    // #1380: true when a ruleset-*detail* read threw a `404` that was not
    // trusted as genuinely empty (see `fetchBranchRulesets` in
    // pre-merge-readiness.mts). Distinct from `protectionReadsUnreadable`
    // above: `branchRulesets` never feeds `summarizeRequiredChecks`, only
    // `summarizeReviewerStates`'s ruleset-bypass/CODEOWNER detection below.
    // Omitted by unit callers (default `false`, unchanged pre-`#1380`
    // behavior).
    branchRulesetsUnreadable?: boolean;
    requestedReviewers?: RequestedReviewerLike[];
    timelineEvents?: TimelineEventLike[];
    claimEvents?: CommentLike[];
    changedFiles?: unknown[];
    codeownersText?: string;
    eligibleCodeownerUserLogins?: unknown[] | null;
    // #1521: true when at least one direct-user codeowner's
    // collaborator-permission lookup failed for a reason other than "not a
    // collaborator" (see `resolveEligibleCodeownerUserLogins` in
    // pre-merge-readiness.mts). Forces
    // `codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner` to `false`
    // regardless of what the (possibly narrowed) eligible set below
    // computed, so the F3 solo-CODEOWNER `--admin` fallback cannot
    // vacuously fire on an unread co-owner. Omitted by unit callers
    // (default `false`, unchanged pre-`#1521` behavior).
    eligibleCodeownerUserLoginsUnreadable?: boolean;
    // #1837: true when the caller genuinely could not fetch/classify
    // individual reviews (see `summarizeReviewerStates`'s option of the
    // same name for the full rationale). `collectPreMergeReadiness` always
    // passes `false` explicitly: its `reviews` fetch is an uncaught
    // `ghApiJson` call, so a genuine failure crashes the whole CLI
    // invocation rather than reaching here with partial data. Omitted by
    // unit callers (default `false`, unchanged pre-`#1837` classified-data
    // behavior).
    reviewsUnreadable?: boolean;
    reviewDecision?: string | null;
    // #1513: live `gh pr view --json mergeable,mergeStateStatus` values for
    // the PR HEAD, paired with `branchRules`/`branchProtection` above to
    // resolve `branchCurrency` below. Omitted by unit callers (defaults to
    // `''`, which never equals the literal `'BEHIND'` the gate checks for).
    mergeStateStatus?: string | null;
    mergeable?: string | null;
  },
  options: {
    now?: string;
    trustedMarkerLogins?: unknown[] | null;
    iddAgentLogins?: unknown[] | null;
    advisoryBotLogins?: unknown[] | null;
    advisoryBotLoginsSource?: unknown;
    prAuthorLogin?: string | null;
    expectedClaimId?: unknown;
    expectedAgentId?: unknown;
    // #1528: forwarded to summarizeClaimValidation's activation-nonce
    // collision check below. Omitted by every caller that predates this
    // option (unchanged pre-#1528 behavior).
    expectedNonce?: unknown;
    // #2017: skip claim-marker fetch/revalidation and emit the
    // not-applicable / unclaimed ownership shape (claim-id `none`).
    claimless?: boolean;
    // kurone-kito/idd-skill#3330: forwarded to both
    // `summarizeExternalCheckWaivers` calls. Omitted is in-loop.
    loopMembership?: PrLoopMembership;
    viewerLogin?: string | null;
    viewerTeamSlugs?: unknown[];
    viewerAppSlug?: string | null;
    collaboratorTrustEnabled?: boolean;
    configuredTrustedActors?: unknown[] | null;
    forcedHandoffEnabled?: boolean;
    expectedLinkedPrs?: unknown[] | null;
    prFirstCommitAt?: string | null;
    authorizedForcedHandoffLogins?: unknown[] | null;
    isAuthorizedForcedHandoff?: (
      forcedBy: string,
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    isForcedHandoffEnabled?: (
      forcedHandoff: ParsedForcedHandoffMarker,
      event: CommentLike,
    ) => boolean;
    activeClaimId?: unknown;
    includeDispositionEvidence?: boolean;
    requestCap?: number;
    pendingWindowMinutes?: number;
    settledWindowMinutes?: number;
    pollIntervalMinutes?: number;
    capExhaustedRoute?: string;
    primaryBotLogin?: string;
    waivableCheckSelectors?:
      | { selector?: unknown; matchMode?: unknown }[]
      | null;
    // #1689: configured `ciGate.trustSourcePinnedRequiredChecks`, forwarded
    // to `summarizeRequiredChecks` unchanged. Omitted by unit callers
    // (default `false`, unchanged pre-#1689 conservative behavior).
    trustSourcePinnedRequiredChecks?: boolean;
    // #1570: the caller-precomputed `#1572` terminal Copilot-unavailability
    // verdict (`buildCopilotRecoverySummary(...).state === 'COPILOT_UNAVAILABLE'`
    // in advisory-wait-state.mts). Computed by the CALLER, not here: this
    // file cannot import `buildCopilotRecoverySummary` directly without an
    // import cycle (advisory-wait-state.mts already imports FROM this file).
    // Omitted/false (the default) never adds the `copilot-terminal-
    // unavailable` blocker below, so an unmigrated caller sees unchanged
    // behavior.
    copilotUnavailable?: boolean;
    // kurone-kito/idd-skill#2919 (round 2): the caller-precomputed verdict
    // that this collection pass could NOT fully resolve real
    // `workflowPath` producer-identity for the `idd-advisory-convergence`
    // check name -- see `pre-merge-readiness.mts`'s option of the same
    // name for the full rationale, and `summarizeRequiredChecks`'s
    // `identityUnresolvedCheckNames` for how it is consumed below.
    // Computed by the CALLER (the `getWorkflowRun` I/O lives in
    // `pre-merge-readiness.mts`, mirroring `copilotUnavailable`'s own
    // caller-precomputed pattern). Omitted/false (the default) never
    // downgrades anything, unchanged pre-#2919-round-2 behavior.
    advisoryConvergenceIdentityUnresolved?: boolean;
    // kurone-kito/idd-skill#3256: the caller-precomputed verdict that
    // among this collection pass's resolved `idd-advisory-convergence`
    // live instances, at least one has a pass-equivalent state but NONE
    // of the pass-equivalent ones was triggered by `pull_request_target`
    // -- see `pre-merge-readiness.mts`'s
    // `advisoryConvergenceNonTargetEventOnly` option of the same name for
    // the full rationale, and `summarizeRequiredChecks`'s
    // `nonTargetEventCheckNames` for how it is consumed below. A DISTINCT
    // cause from `advisoryConvergenceIdentityUnresolved` above: this one
    // fires only once the producer identity resolved cleanly, so the two
    // are mutually exclusive in practice (an unresolved identity already
    // downgrades via the other flag first) but are still wired as two
    // independent options rather than one, so a future caller that can
    // tell them apart is not forced to conflate them. Omitted/false (the
    // default) never downgrades anything.
    advisoryConvergenceNonTargetEventOnly?: boolean;
    // #2353: the caller-precomputed provider-outage-declaration relief
    // verdict for the `idd-advisory-convergence` selector (fetch,
    // `resolveProviderOutageDeclaration`, `evaluateProviderOutageRelief`,
    // ALL already gated on `copilotUnavailable` above as the PR's own
    // proven terminal-unavailable state). Computed by the CALLER, not
    // here: `provider-outage-declaration.mts` already imports FROM this
    // file, so importing it back here would be a cycle. Omitted/false (the
    // default) never relieves anything, unchanged pre-#2353 behavior.
    advisoryConvergenceOutageRelieved?: boolean;
    // #2353 (Codex review on PR #2370): the caller-resolved outage
    // declaration's own active-since moment when
    // `advisoryConvergenceOutageRelieved` is true, empty otherwise. A
    // required check's live run must have STARTED (not merely completed --
    // second follow-up review, round 4) AT OR AFTER this moment to count as
    // covered -- a run that began evaluating state before the declaration's
    // window opened never actually observed it, even if the run happens to
    // finish afterward, and reporting it covered would diverge from what
    // GitHub's own required-check state still shows, reproducing #2021's
    // "ready but merge blocked" class one layer deeper. Omitted/empty
    // applies no cutoff (unchanged pre-fix behavior for a caller that
    // doesn't pass it).
    advisoryConvergenceOutageRelievedSince?: string;
    // #2021: the current HEAD commit's own `committedDate` (GraphQL),
    // informational only (kurone-kito/idd-skill#3253) -- see
    // `advisoryConvergenceHeadObservedAt` below for the actual deadline
    // clock. Sourced by the CALLER (`pre-merge-readiness.mts`, via the
    // identical GraphQL field `review-clause.mts`'s `fetchReviewsAndHeadCommit`
    // reads), mirroring how `copilotUnavailable` above is caller-precomputed.
    advisoryConvergenceHeadCommittedAt?: string | null;
    // kurone-kito/idd-skill#3253: the earliest GitHub-recorded check-suite
    // `createdAt` for the current HEAD commit (`review-clause.mts`'s
    // `fetchHeadObservedAt`) -- the GitHub-observed anchor for the SAME 24h
    // deadline clock `advisory-convergence.mts`'s own gate uses before
    // treating a posted `idd-advisory-convergence` waiver as active, and for
    // the secondary-bot settlement cutoff below. Unlike
    // `advisoryConvergenceHeadCommittedAt` above (committer-supplied, never
    // verified by GitHub), this is what GitHub itself first observed.
    // Omitted/invalid (the default) resolves `elapsedMinutes` to `null` and
    // `deadlinePassed` to `false` -- the safer default, never falsely
    // treating a still-open deadline as passed.
    advisoryConvergenceHeadObservedAt?: string | null;
    // Configured `advisoryWait.convergenceDeadline` in minutes (#2021),
    // resolved by the caller, mirroring `externalCheckWaiverMaxValidity`
    // below's "policy value resolved by the CLI layer" pattern. Omitted by
    // unit callers (falls back to the same 24h
    // `DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES` default
    // `advisory-convergence.mts` itself uses).
    advisoryConvergenceDeadlineMinutes?: number;
    // Configured `ciGate.externalCheckWaivers.maxValidity` (ISO-8601 duration),
    // threaded to the consume-side waiver window check. Omitted by unit callers
    // (window check off); `collectPreMergeReadiness` always sources the policy
    // value (default `PT24H`).
    externalCheckWaiverMaxValidity?: string;
    // Configured `ciGate.externalCheckWaivers.mode` (#2046), threaded to the
    // consume-side mode gate. Omitted by unit callers (gate off, unchanged
    // pre-#2046 behavior); `collectPreMergeReadiness` always sources the
    // policy value (default `disabled`).
    externalCheckWaiverMode?: string;
    // kurone-kito/idd-skill#3250: `ciGate.externalCheckWaivers.authorityPolicy`,
    // threaded to the consume-side authority check. Omitted by unit callers
    // resolves to the check's own schema default
    // (`owners-and-maintainers-only`) -- unlike `externalCheckWaiverMode`
    // above, there is no "off" state; `collectPreMergeReadiness` always
    // sources the real policy value.
    externalCheckWaiverAuthorityPolicy?: string;
    // kurone-kito/idd-skill#3250: resolves one waiver author's live
    // collaborator-permission outcome for the authority check above.
    // Omitted by unit callers (every waiver reaching the check fails
    // closed to `insufficientAuthority`); `collectPreMergeReadiness`
    // always supplies `(login) => port.getCollaboratorPermission(login)`.
    resolveWaiverAuthority?: (
      authorLogin: string,
    ) => ExternalCheckWaiverAuthorityLookup | null;
    // kurone-kito/idd-skill#2911: caller-precomputed evidence for the
    // `staleSelfWaiver` blocker above -- see that computation's own doc
    // comment for the full rationale. Both fields default to the no-op/
    // suppressed state, so every existing caller/fixture (which omits
    // them) is unaffected; `collectPreMergeReadiness` is the sole caller
    // that populates them.
    //
    // Independently fetched from THIS PR's own live diff (never from any
    // comment body) -- whether it touches
    // `resolveSelfReferentialTriggerFiles`'s allowlist. The load-bearing
    // security boundary: without this, a forged self-referential-
    // bootstrap-auto marker citing a real, unrelated run could block a
    // completely unrelated PR's merge (see the decisive Copilot finding
    // cited above).
    touchesSelfReferentialAllowlist?: boolean;
    // Keyed by the candidate marker's own `run-id:` field; `true` only
    // when `verifySelfReferentialBootstrapWaiverRun` (reused verbatim from
    // `advisory-convergence.mts`) confirmed that run id's own
    // `GET .../actions/runs/{run-id}` lookup matches the expected
    // workflow path, this PR's own HEAD SHA, this repository, and the
    // `pull_request_target` event. A run id absent from this map (an
    // unbounded/unlooked-up id, or a lookup that errored) is treated as
    // unverified, never as verified.
    autoWaiverRunVerified?: Record<string, boolean>;
    // Configured `claimTiming.staleAge` (#1310), parsed to milliseconds and
    // threaded to the write-gate claim resolver below so the F2/F3 merge gate
    // honors it instead of the hardcoded 24h `isStaleAt` default. Omitted by
    // unit callers (default 24h behavior preserved).
    // `collectPreMergeReadiness` always sources the policy value.
    staleAgeMs?: number;
    // #2323: the caller-precomputed `resolveLocalValidationEvidence`
    // result (local-validation-evidence.mts), reported verbatim as its own
    // top-level field -- purely informational. `computePreMergeReadinessBlockers`
    // never reads this field, so it can never derive a blocker (or remove
    // one) from local evidence; the required checks it references stay
    // exactly as unresolved/unavailable as `ci` independently computed them.
    // Omitted by unit callers and every caller that predates this option
    // (field is omitted entirely -- not even `null` -- unchanged
    // pre-#2323 behavior).
    localValidationEvidenceSummary?: Record<string, unknown> | null;
    // #2272: caller-precomputed effective development-branch resolution
    // (`resolveEffectiveDevelopmentBranch` in policy-helpers.mts) paired
    // with the live PR `baseRefName`. This file never resolves policy or
    // shells out to `gh` itself, mirroring `copilotUnavailable`'s
    // caller-precomputed pattern -- it only rolls the caller's evidence
    // into the blocker list below. Unlike `localValidationEvidenceSummary`
    // above, this DOES feed `computePreMergeReadinessBlockers`: an
    // `'invalid'`/`'unavailable'` status, or a `branch` that differs from
    // `baseRefName`, blocks. Omitted (the default) skips this gate
    // entirely, so every pre-#2272 fixture/caller is unaffected;
    // `collectPreMergeReadiness` always resolves and passes a value.
    developmentBranchTarget?: {
      status: string;
      branch?: string;
      reason?: string;
      baseRefName: string;
    } | null;
    // #3298: caller-precomputed closing-set / stray-commit-close evidence
    // (`computeClosingSetEvidence` in supersession-detection.mts), reported
    // verbatim -- mirrors `developmentBranchTarget` immediately above:
    // omitted (the default) skips this gate entirely, so every pre-#3298
    // fixture/caller is unaffected; `collectPreMergeReadiness` always
    // resolves and passes a value. Unlike `developmentBranchTarget`, the
    // schema marks `closingSet` required once emitted by a real collector
    // run -- see the schema's own doc comment for why.
    closingSet?: {
      status: string;
      expected: number[];
      actual: number[];
      extra: number[];
      missing: number[];
      strayCommitCloses: { sha: string; issue: number }[];
    } | null;
    // Configured `advisoryWait.secondaryQuietWindow` in minutes (#2335),
    // resolved by the caller, mirroring `advisoryConvergenceDeadlineMinutes`
    // above's "policy value resolved by the CLI layer" pattern. Omitted or
    // `0` (the default) makes `secondaryQuietWindow` below report
    // `elapsed: true` unconditionally, so an unmigrated caller or an
    // adopter that never sets this key sees unchanged behavior.
    secondaryQuietWindowMinutes?: number;
    // #2544: the configured `advisoryWait.secondaryBotLogin`(s), resolved by
    // the caller (mirroring `secondaryQuietWindowMinutes` above). Consulted
    // together with `advisoryConvergenceHeadObservedAt` above to detect
    // whether each configured secondary bot has already posted a genuine
    // review for the current HEAD, so the quiet window can shorten to a
    // settled buffer instead of always requiring the full configured
    // duration. Omitted or empty disables the settled-buffer branch
    // entirely -- unchanged, pre-#2544 behavior. #3186: accepts a single
    // string or an array of strings, normalized the same way
    // `buildAdvisoryWaitSummary`'s `secondaryBotLogins` option is.
    secondaryBotLogins?: unknown;
    // Legacy single-login form (#2544), kept for existing direct callers of
    // this exported function that predate #3186's plural option -- a call
    // such as `buildPreMergeReadinessSummary(..., { secondaryBotLogin:
    // 'coderabbitai[bot]', secondaryQuietWindowMinutes: 10 })` must keep
    // folding that one login's settlement into the quiet-window status, not
    // silently fall back to the unconfigured (always-full-window) shape.
    // `secondaryBotLogins` wins when both are present, mirroring
    // `buildAdvisoryWaitSummary`'s own precedence (Copilot review, PR #3196).
    secondaryBotLogin?: string;
  } = {},
) {
  const now = String(options.now ?? '');
  if (!isValidIsoTimestamp(now)) {
    throw new Error('now must be an ISO 8601 UTC timestamp');
  }
  if (!/^[0-9a-f]{40}$/.test(String(prHeadSha ?? ''))) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
  }

  const trustedMarkerLogins = normalizeTrustedMarkerLogins(
    options.trustedMarkerLogins ?? [],
  );
  const iddAgentLogins = normalizeTrustedMarkerLogins(
    options.iddAgentLogins ?? [],
  );
  const advisoryBotLogins = normalizeTrustedMarkerLogins(
    options.advisoryBotLogins ?? [],
  );
  const prAuthorLogin = String(options.prAuthorLogin ?? '')
    .trim()
    .toLowerCase();
  // Normalize + default `options.primaryBotLogin` the same way
  // `buildAdvisoryWaitSummary` does (`primaryBotLogin` local const there) --
  // an omitted/blank option must still resolve to the Copilot default, not
  // silently drop out of the reviewer-state union below or the secondary
  // login exclusion just below it. Hoisted above `branchReviewRequirements`
  // (rather than declared only where `reviewerStateAdvisoryBotLogins` uses
  // it) so the secondary-bot-login resolution above the review-currency
  // section can reuse it too, instead of an independent second copy of this
  // one-liner drifting out of sync with it.
  const resolvedPrimaryBotLogin =
    String(options.primaryBotLogin ?? '')
      .trim()
      .toLowerCase() || DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const branchCurrency = summarizeBranchCurrency(
    branchRules,
    branchProtection,
    {
      mergeStateStatus,
      mergeable,
      protectionReadsUnreadable,
    },
  );
  const liveSnapshot = buildActivitySnapshotSummary(
    {
      comments,
      reviews,
      threads,
      checks,
    },
    {
      trustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource: options.advisoryBotLoginsSource,
      dispositionAuthorLogins: iddAgentLogins,
    },
  );
  // #2544/#3186: whether the configured secondary bot(s) have already
  // posted a genuine (non-notice) comment for the CURRENT HEAD -- reuses
  // `options.advisoryConvergenceHeadObservedAt` (the earliest GitHub-recorded
  // check-suite `createdAt` for the current HEAD, already resolved by the
  // caller for the unrelated advisory-convergence-deadline precondition
  // below) rather than a second fetch (kurone-kito/idd-skill#3253: this used
  // to reuse `advisoryConvergenceHeadCommittedAt`, since it was "exactly
  // 'when did this HEAD land' either way" -- the committer-supplied
  // `committedDate` can lag the actual push, so both readers now share the
  // GitHub-observed anchor instead).
  // `foldSecondaryAdvisoryReviewSettlements` combines every configured
  // login's own independent classification into the single shape
  // `buildSecondaryQuietWindowStatus` consumes -- see its own doc comment
  // for the exact fold rule (any pending keeps the full window; all
  // declined completes immediately; otherwise anchor on the latest genuine
  // review).
  const secondaryBotLogins = normalizeSecondaryBotLoginList(
    options.secondaryBotLogins ?? options.secondaryBotLogin,
    resolvedPrimaryBotLogin,
  );
  const secondaryReviewSettlement = foldSecondaryAdvisoryReviewSettlements(
    comments,
    {
      secondaryBotLogins,
      headCommittedAt: options.advisoryConvergenceHeadObservedAt,
      // #3261: needed for the Codex identity's Completed-at-HEAD check.
      headSha: prHeadSha,
    },
  );
  // #2335: stateless secondary-quiet-window gate, anchored on the same
  // non-ack-only activity ceiling `liveSnapshot.effective` already computes
  // for the review-currency ack-only carve-out below -- see
  // `buildSecondaryQuietWindowStatus`'s own doc comment for why this anchor
  // needs no separate persisted "convergence first observed" timestamp.
  // #2544: `secondaryBotSettledAt` shortens the required wait to a settled
  // buffer once that evidence exists. #2547: `secondaryBotDeclined` skips
  // the wait entirely once the bot has definitively declined this exact
  // HEAD; see `computeSecondaryAdvisoryReviewSettlement` above for how
  // both are derived.
  const secondaryQuietWindow = buildSecondaryQuietWindowStatus({
    minutes: options.secondaryQuietWindowMinutes,
    effectiveMaxActivityUpdatedAt: liveSnapshot.effective?.maxActivityUpdatedAt,
    secondaryBotSettledAt: secondaryReviewSettlement.settledAt,
    secondaryBotDeclined: secondaryReviewSettlement.declined,
    now,
  });
  const isTrustedWatermarkAuthor = (login: string) =>
    trustedMarkerLogins.includes(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: options.expectedClaimId,
    isTrustedAuthor: isTrustedWatermarkAuthor,
  });
  const reviewCurrency = watermark
    ? diffReviewSnapshot(
        {
          headSha: watermark.headSha,
          maxActivityUpdatedAt: watermark.maxActivityUpdatedAt,
          totalItemCount: watermark.totalItemCount,
          latestPassingCiCompletedAt: watermark.latestCiCompletedAt,
        },
        {
          headSha: prHeadSha,
          ...liveSnapshot,
        },
      )
    : detectMalformedReviewWatermarkComments(comments, {
          isTrustedAuthor: isTrustedWatermarkAuthor,
          expectedClaimId: options.expectedClaimId,
        })
      ? { route: 'return-to-e1', reason: 'malformed-watermark' }
      : { route: 'return-to-e1', reason: 'missing-watermark' };
  const threadSummary = summarizeReviewThreadsForGate(threads, {
    iddAgentLogins,
    prAuthorLogin,
    requiresConversationResolution:
      branchReviewRequirements.requiresConversationResolution,
  });
  const unrepliedComments = summarizeRegularCommentsForGate(comments, {
    iddAgentLogins,
    advisoryBotLogins,
    trustedMarkerLogins,
    threads,
  });
  // #1818: `options.primaryBotLogin` (the configured advisory-wait primary
  // bot, e.g. a non-default Copilot form or a wholly different bot) must be
  // treated as an advisory bot by `summarizeReviewerStates`'s review-approval
  // counting specifically -- `isKnownReviewBot` only recognizes the literal
  // default bot identities, and a repo that configures a custom
  // `primaryBotLogin` without separately adding it to `advisoryBotLogins`
  // would otherwise have that bot's `APPROVED`/`CHANGES_REQUESTED` review
  // counted as a human's. Union it into a call-site-local set instead of
  // widening the shared `advisoryBotLogins` above, which also feeds
  // `buildActivitySnapshotSummary` and `summarizeRegularCommentsForGate`
  // (unrelated classification needs that must not change as a side effect).
  //
  // `resolvedPrimaryBotLogin` is hoisted above (near `prAuthorLogin`) so the
  // secondary-bot-login resolution earlier in this function can reuse it too.
  // Without this default, a caller that relies on defaulting (any caller
  // other than this file's own `collectPreMergeReadiness`, which always
  // resolves a non-empty value) would leave the bare `copilot` login
  // unclassified here even though `isCopilotReviewerLogin` elsewhere already
  // treats it as a genuine Copilot form (Copilot review, PR #1826).
  const reviewerStateAdvisoryBotLogins = normalizeTrustedMarkerLogins([
    ...advisoryBotLogins,
    resolvedPrimaryBotLogin,
  ]);
  const reviewerStates = summarizeReviewerStates(reviews, {
    reviewDecision,
    branchRules,
    branchRulesets,
    branchProtection,
    branchRulesetsUnreadable,
    codeownersText,
    changedFiles,
    eligibleCodeownerUserLogins,
    eligibleCodeownerUserLoginsUnreadable,
    reviewsUnreadable,
    advisoryBotLogins: reviewerStateAdvisoryBotLogins,
    prAuthorLogin,
    viewerLogin: options.viewerLogin,
    viewerTeamSlugs: options.viewerTeamSlugs,
    viewerAppSlug: options.viewerAppSlug,
  });
  const advisoryWaitOptions = normalizeAdvisoryWaitRuntimeOptions(options);
  const advisoryWait = buildAdvisoryWaitSummary(
    {
      prHeadSha,
      reviews,
      requestedReviewers,
      timelineEvents,
      comments,
    },
    {
      now,
      ...advisoryWaitOptions,
      viewerLogin: options.viewerLogin,
      configuredTrustedActors: options.configuredTrustedActors,
      collaboratorTrustEnabled: options.collaboratorTrustEnabled,
      trustedMarkerLogins,
      primaryBotLogin: options.primaryBotLogin,
    },
  );
  // kurone-kito/idd-skill#2911: captures `resolveActiveClaimWithForcedHandoff
  // Trace`'s `activeSince` (the non-mutable claim-identity-transition
  // anchor `summarizeClaimValidation`'s own `captureTraceInto` parameter
  // exposes) without widening `ClaimValidationSummary` -- see that
  // parameter's own doc comment. Left `{}` (never populated) on the
  // `claimless` branch below, matching that branch's own synthetic,
  // not-applicable claim shape.
  const claimTrace: { activeSince?: string } = {};
  const claim = options.claimless
    ? {
        expectedClaimId: 'none',
        expectedAgentId: '',
        activeClaimPresent: false,
        activeClaim: {
          agentId: '',
          claimId: 'none',
          supersedes: '',
          branch: '',
          createdAt: '',
        },
        matchesExpectedClaim: true,
        claimLost: false,
        reason: 'not-applicable',
      }
    : summarizeClaimValidation(
        claimEvents,
        {
          trustedMarkerLogins,
          forcedHandoffEnabled: options.forcedHandoffEnabled === true,
          expectedLinkedPrs: options.expectedLinkedPrs ?? [],
          prFirstCommitAt: options.prFirstCommitAt ?? null,
          authorizedForcedHandoffLogins: options.authorizedForcedHandoffLogins,
          isAuthorizedForcedHandoff: options.isAuthorizedForcedHandoff,
          isForcedHandoffEnabled: options.isForcedHandoffEnabled,
          expectedClaimId: options.expectedClaimId,
          expectedAgentId: options.expectedAgentId,
          expectedNonce: options.expectedNonce,
          staleAgeMs: options.staleAgeMs,
        },
        claimTrace,
      );
  // kurone-kito/idd-skill#2911: `''` when no event ever produced an active
  // claim (including the `claimless` branch above) -- every consumer of
  // this field must treat that the same as "no anchor available" and fail
  // closed (never treat an empty string as "installed at the epoch").
  const claimIdentityInstalledAt = claimTrace.activeSince ?? '';
  const waivableCheckSelectors = options.waivableCheckSelectors ?? null;
  const waiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId: claim.activeClaim?.claimId ?? options.activeClaimId ?? '',
    activeClaimSupersedes: claim.activeClaim?.supersedes ?? '',
    trustedMarkerLogins,
    now,
    waivableSelectors: waivableCheckSelectors,
    maxValidity: options.externalCheckWaiverMaxValidity ?? '',
    mode: options.externalCheckWaiverMode ?? '',
    authorityPolicy: options.externalCheckWaiverAuthorityPolicy ?? '',
    resolveAuthority: options.resolveWaiverAuthority,
    loopMembership: options.loopMembership,
  });
  // kurone-kito/idd-skill#2911: a THIRD authorized `allowSelfReferential-
  // BootstrapAuto` call site -- see that option's own doc comment in this
  // file (`summarizeExternalCheckWaivers`) for the full list and why every
  // other caller must leave it unset. Read-only, feeding only the
  // `staleSelfWaiver` blocker evidence below; never satisfies a gate or
  // makes `ready` true. `trustedMarkerLogins` extended with
  // `github-actions[bot]` identically to `advisory-convergence.mts`'s own
  // gate-decision call, so a self-referential-bootstrap-auto marker this
  // repository's own posting job creates is visible to both.
  const autoWaiverEvidence = summarizeExternalCheckWaivers(comments, {
    prHeadSha,
    activeClaimId: claim.activeClaim?.claimId ?? options.activeClaimId ?? '',
    activeClaimSupersedes: claim.activeClaim?.supersedes ?? '',
    trustedMarkerLogins: [...trustedMarkerLogins, 'github-actions[bot]'],
    now,
    waivableSelectors: waivableCheckSelectors,
    maxValidity: options.externalCheckWaiverMaxValidity ?? '',
    mode: options.externalCheckWaiverMode ?? '',
    allowSelfReferentialBootstrapAuto: true,
    loopMembership: options.loopMembership,
  });

  // #1570: the caller-supplied terminal-unavailability verdict, reused below
  // both for the dedicated `copilot-terminal-unavailable` blocker and (#2021)
  // as one of the two preconditions that must open before an
  // `idd-advisory-convergence` waiver counts toward `ci.coveredByWaiver`.
  const copilotUnavailable = options.copilotUnavailable === true;

  // #2021: `advisory-convergence.mts`'s own gate never treats a posted
  // `idd-advisory-convergence` waiver as active until ONE of two independent
  // preconditions is ALSO true -- a 24h deadline anchored on the earliest
  // GitHub-recorded check-suite for the current HEAD commit
  // (kurone-kito/idd-skill#3253; `headCommittedAt` stays informational
  // only), or proven terminal Copilot unavailability (`copilotUnavailable`
  // above). Reported truthfully in `waiverEvidence` itself either way (the
  // marker is real and otherwise valid), but a check only becomes
  // `coveredByWaiver` here once this SAME precondition has opened --
  // otherwise this helper reports `coveredByWaiver: true` before
  // `advisory-convergence.mts` itself would ever call the waiver `waived`,
  // sending an otherwise-correct session into a `gh pr merge` GitHub rejects
  // outright (root cause: kurone-kito/idd-skill#2021).
  const advisoryConvergencePreconditionResult =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: options.advisoryConvergenceHeadCommittedAt,
      headObservedAt: options.advisoryConvergenceHeadObservedAt,
      deadlineMinutes: options.advisoryConvergenceDeadlineMinutes,
      terminalUnavailable: copilotUnavailable,
      now,
    });
  const advisoryConvergenceWaiverPrecondition =
    advisoryConvergencePreconditionResult.precondition;
  const advisoryConvergencePreconditionOpen =
    advisoryConvergenceWaiverPrecondition.open;
  const advisoryConvergenceDeadlineOpensAt =
    advisoryConvergencePreconditionResult.deadlineOpensAt;

  // #2021 (Codex review on PR #2033, two findings): `advisory-convergence.mts`'s
  // own `waived` computation only counts a waiver whose `checkSelector` is an
  // EXACT match to its selector constant (`entry.checkSelector ===
  // waiverCheckSelector`, advisory-convergence.mts line ~1108) -- never a
  // glob. A glob waiver such as `idd-*` (permitted when
  // `waivableCheckSelectors` allows it) would still glob-match the
  // `idd-advisory-convergence` CHECK NAME via `summarizeRequiredChecks`'s
  // `matchCheckSelectorLocal`, so treating "precondition open" as sufficient
  // to fall back to the raw, unfiltered `waiverEvidence` (as an earlier
  // revision of this fix did) would report `coveredByWaiver: true` for a
  // selector that gate would never itself accept -- reproducing this same
  // issue's false-`ready` class for a different trigger. `genuinelyCovered`
  // requires BOTH the precondition open AND an EXACT-match valid entry.
  const advisoryConvergenceExactWaiverValid = waiverEvidence.valid.some(
    (entry) =>
      entry.checkSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  );
  const advisoryConvergenceGenuinelyCovered =
    advisoryConvergencePreconditionOpen && advisoryConvergenceExactWaiverValid;

  // #2353: the caller-precomputed provider-outage-declaration relief
  // verdict, re-ANDed here with the SAME precondition-open evidence the
  // direct-waiver path above requires -- cheap insurance against a future
  // caller passing a relief verdict that was somehow computed without the
  // precondition it logically implies (evaluateProviderOutageRelief's own
  // `prTerminalUnavailable` requirement already implies `terminalUnavailable`,
  // which already implies `advisoryConvergencePreconditionOpen` via the OR,
  // so this is redundant today, not a new gate).
  const advisoryConvergenceOutageRelieved =
    advisoryConvergencePreconditionOpen &&
    options.advisoryConvergenceOutageRelieved === true;

  const ci = summarizeRequiredChecks(checks, branchRules, branchProtection, {
    // Raw, UNFILTERED `waiverEvidence` -- deliberately not a caller-side
    // pre-filtered copy. A pre-filter that removed a whole `valid` entry
    // (e.g. every occurrence of a glob waiver covering
    // `idd-advisory-convergence`) would also strip that SAME entry's
    // coverage of any OTHER check it glob-matches (e.g. a configured
    // `idd-security`), turning a convergence-specific restriction into an
    // unintended block on unrelated checks (Codex review finding on PR
    // #2033). `excludeFromWaiverCoverage` below applies the restriction
    // surgically, per check name, instead.
    waivers: waiverEvidence,
    waivableSelectors: waivableCheckSelectors,
    protectionReadsUnreadable,
    trustSourcePinnedRequiredChecks:
      options.trustSourcePinnedRequiredChecks === true,
    excludeFromWaiverCoverage: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      !advisoryConvergenceGenuinelyCovered,
    // #2034: only override the cutoff for `idd-advisory-convergence` itself,
    // and only on the deadline path -- an unrelated check's waiver stays
    // anchored on its own comment's `createdAt`.
    waiverActiveSinceOverride: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      advisoryConvergenceDeadlineOpensAt
        ? advisoryConvergenceDeadlineOpensAt
        : null,
    // #2353: a repository-scoped provider-outage declaration relieves
    // `idd-advisory-convergence` specifically, through a positive path
    // that bypasses `excludeFromWaiverCoverage` above entirely -- see
    // `treatAsCoveredByWaiver`'s own doc comment for why.
    treatAsCoveredByWaiver: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      advisoryConvergenceOutageRelieved,
    // #2353 (Codex review on PR #2370): the declaration's own `startedAt`
    // -- a required check's live run must have completed at or after this
    // moment, or a stale pre-declaration failed run would be reported
    // covered without ever having actually rerun under the outage window.
    treatAsCoveredByWaiverSince: (name) =>
      name === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
      options.advisoryConvergenceOutageRelievedSince
        ? options.advisoryConvergenceOutageRelievedSince
        : null,
    // kurone-kito/idd-skill#2919 (round 2): only `idd-advisory-convergence`
    // is a candidate -- it is the sole check name this collector ever
    // attempts `workflowPath` resolution for (see `pre-merge-readiness.mts`).
    identityUnresolvedCheckNames:
      options.advisoryConvergenceIdentityUnresolved === true
        ? [DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR]
        : null,
    // kurone-kito/idd-skill#3256: only `idd-advisory-convergence` is a
    // candidate -- it is the sole check name this collector ever resolves
    // per-instance triggering events for (see `pre-merge-readiness.mts`).
    nonTargetEventCheckNames:
      options.advisoryConvergenceNonTargetEventOnly === true
        ? [DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR]
        : null,
  });

  // kurone-kito/idd-skill#2911: the OPPOSITE direction from the CI blocker
  // below -- CI may currently report `idd-advisory-convergence` PASSING,
  // but that pass may rest on a self-referential-bootstrap-auto marker
  // that has since gone stale (expired, or claim-invalid across a genuine
  // claim transition) with no rerun since. GitHub never reruns an
  // already-successful check merely because its supporting comment stops
  // being valid, so without this a PR could merge on a stale pass with no
  // genuine advisory review (or fresh waiver) ever having covered it.
  // Consumed by `computePreMergeReadinessBlockers` via
  // `report.staleSelfWaiver` -- independent of, and never gated by,
  // `isPreMergeCiAllPassing` there, since the whole point is to catch a
  // check that currently LOOKS all-passing.
  //
  // This re-implements the blocker `9ecc9954`/`863c5249`/`337f4369`
  // introduced and PR #2895's own review then retired across three more
  // rounds (kurone-kito/idd-skill#2911's own "Findings" history), fixing
  // every root cause in one pass rather than live-patching this call site
  // again:
  // - Deduplicated newest check instance (`selectLatestCheckInstance`),
  //   not a raw `.find()` over the full (possibly multi-instance)
  //   `ci.checks` list (round 15, Codex P1).
  // - Scans BOTH `expired` and `wrongClaim` (round 14, Codex P1) --
  //   `wrongClaim` never carries a comparable expiry, so it needs the
  //   claim-identity-transition anchor below instead.
  // - Correlates `wrongClaim` against `claimIdentityInstalledAt` (a
  //   non-mutable claim-identity-transition anchor -- see that field's own
  //   doc comment), never the mutable `claim.activeClaim.createdAt`
  //   heartbeat clock (round 15, Codex P2).
  // - Trusts a candidate marker only after `options.autoWaiverRunVerified`
  //   confirms the SAME run-bound trust conditions
  //   `verifySelfReferentialBootstrapWaiverRun` already applies (reused
  //   verbatim, not reimplemented) AND `options.touchesSelfReferential-
  //   Allowlist` independently confirms this PR's own diff touches the
  //   checker allowlist (round 15, Copilot -- the decisive finding: a
  //   same-repository `pull_request`-triggered workflow with
  //   `issues: write` could otherwise cite a real, unrelated run (e.g.
  //   this PR's own required-check instance of `idd-advisory-
  //   convergence.yml`, which runs for EVERY PR regardless of allowlist
  //   touch) to forge a marker that blocks a completely unrelated PR's
  //   merge). Both booleans are precomputed by the collector
  //   (`pre-merge-readiness.mts`), which does the actual `getWorkflowRun`/
  //   changed-file I/O -- this function cannot perform it directly without
  //   an import cycle back through `advisory-convergence.mts` (which
  //   already imports FROM this file).
  //
  // Fail-closed/fail-open asymmetry, by design: an unverified run
  // (`autoWaiverRunVerified[runId]` false/absent, including a transient
  // `getWorkflowRun` failure) makes the candidate marker untrusted and
  // therefore SUPPRESSES this blocker -- the safe direction for the
  // decisive finding above (a forged-or-unresolvable citation must never
  // become a merge-denial vector), even though it is the opposite of this
  // file's usual fail-closed default elsewhere. `touchesSelfReferential-
  // Allowlist` not `true` (including simply omitted by an older caller)
  // suppresses the blocker unconditionally, for the identical reason.
  //
  // `autoWaiverEvidence` itself (computed just above, alongside the
  // ordinary `waiverEvidence`) is deliberately NOT added to the returned
  // `summary`: only this derived `staleSelfWaiver` verdict is schema-
  // locked, so the raw per-marker bucket shape stays free to evolve
  // (kurone-kito/idd-skill#2912's own bearer-evidence-vs-provenance work
  // is a plausible future consumer) without forcing a fixture cascade
  // across every `fixtures/pre-merge-readiness/*.json` file.
  //
  // Residual (documented, not fixed here): the run-id trust check above
  // proves the cited run has the right shape, never that it actually
  // posted the marker citing it (kurone-kito/idd-skill#2912 tracks
  // closing that bearer-evidence gap -- see the identical residual note
  // on `SELF_REFERENTIAL_WAIVER_TRIGGER_FILES` in advisory-convergence.mts,
  // ~L277-303). `touchesSelfReferentialAllowlist` bounds the blast radius
  // to PRs that already, genuinely touch the checker allowlist -- it does
  // not fully close repeated same-repository forgery against ONE such PR
  // (each round costs that PR one avoidable rerun, never a bypass).
  const staleSelfWaiverCheckSelector =
    DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR;
  let staleSelfWaiver: {
    stale: boolean;
    checkSelector: string;
    reason: 'expired' | 'wrong-claim' | null;
    expiresAt: string;
    waiverClaimId: string;
  } = {
    stale: false,
    checkSelector: staleSelfWaiverCheckSelector,
    reason: null,
    expiresAt: '',
    waiverClaimId: '',
  };
  // kurone-kito/idd-skill#2911 (Medium, self-critique against the merged
  // #2657 gate decision): `summarizeExternalCheckWaivers` classifies a
  // marker into `expired`/`wrongClaim` BEFORE its own `notConfigured`/
  // `modeDisabled` checks ever run (both come later in that function's own
  // pipeline), so those two buckets are populated regardless of
  // `ciGate.externalCheckWaivers.mode`/`waivableSelectors` policy --
  // unlike `valid`, which `autoWaiverValid` (advisory-convergence.mts) can
  // only ever reach once mode/waivable ALREADY gated it. Gate this
  // blocker on the identical precondition, so an adopter whose policy
  // (the schema default: `mode: "disabled"`) could never have made this
  // mechanism's waiver `valid` in the first place never sees a blocker
  // from its `expired`/`wrongClaim` shadow either.
  const staleSelfWaiverModeOpen =
    (options.externalCheckWaiverMode ?? '') === '' ||
    options.externalCheckWaiverMode === 'maintainer-authorized';
  const staleSelfWaiverSelectorWaivable =
    !Array.isArray(waivableCheckSelectors) ||
    isCheckNameConfiguredWaivable(
      staleSelfWaiverCheckSelector,
      waivableCheckSelectors,
    );
  if (
    options.touchesSelfReferentialAllowlist === true &&
    staleSelfWaiverModeOpen &&
    staleSelfWaiverSelectorWaivable
  ) {
    // kurone-kito/idd-skill#2911 (Codex review on PR #2915, P1): the
    // pre-fix version filtered `ci.checks` -- already reduced by
    // `summarizeRequiredChecks` and stripped of its `type`/`workflowName`
    // producer-identity fields -- and picked a single "latest" instance
    // with `selectLatestCheckInstance` directly over that flattened list.
    // When two distinct PRODUCERS (e.g. an Actions check-run and a legacy
    // status context) share the `idd-advisory-convergence` name, that
    // flattening could let a later, genuinely-passing instance from an
    // UNRELATED producer mask an earlier instance from the checker's own
    // producer that is still resting on a stale waiver, since only the
    // single most-recent-across-all-producers instance was ever
    // inspected. Group by producer instead, over the RAW `checks`
    // parameter (which still carries `type`/`workflowName`, unlike
    // `ci.checks`), using `selectLatestCheckPerName` -- the identical
    // producer-identity grouping `classifyCiChecks`/
    // `findDiscardedNonPassingSiblings` already establish for the same
    // reason (#1483) -- then evaluate EACH producer's own latest instance
    // independently below (loop, `break` on the first stale match), so a
    // fresh pass from one producer can never hide a stale pass from
    // another.
    const selfConvergenceRawInstances = checks
      .filter((check) =>
        matchCheckSelectorLocal(check.name, staleSelfWaiverCheckSelector),
      )
      .map((check) => ({
        name: String(check.name ?? ''),
        // Also observed (Copilot, PR #2915, kurone-kito/idd-skill#2919):
        // case-normalized here (matching `summarizeRequiredChecks`'s own
        // normalization, which has not run yet at this raw `checks`
        // read) so a lowercase live `state` can never make the
        // `CHECK_PASS_EQUIVALENT_STATES` filter below (populated with
        // uppercase literals) find zero candidates and silently skip
        // this blocker even while `ci.status` reads passing. Real
        // GitHub GraphQL enums are already uppercase, so this is
        // defensive rather than a live behavior change.
        state: String(check.state ?? '').toUpperCase(),
        completedAt: check.completedAt ?? null,
        // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P1): also
        // carried through for the wrongClaim claim-installation
        // comparison below, which anchors on this instead of
        // `completedAt` -- see that comparison's own doc comment.
        startedAt: check.startedAt ?? null,
        type: check.type ?? null,
        workflowName: check.workflowName ?? null,
        // kurone-kito/idd-skill#2919: carried through for the
        // workflow-FILE-path filter below, which closes the gap
        // `workflowName` alone leaves open -- two different workflow
        // FILES can declare the identical `name:` display string (see
        // `CheckLike`'s own doc comment).
        workflowPath: check.workflowPath ?? null,
      }))
      .filter((check) => ci.requiredCheckNames.includes(check.name));
    // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P1, fresh
    // evidence against THIS revision's own new per-producer loop): the
    // producer grouping above intentionally keeps every distinct
    // producer separate, but a non-Actions producer sharing this name
    // (e.g. a legacy status context) can never legitimately be covered
    // by a self-referential-bootstrap-auto marker in the first place --
    // that marker only ever cites a workflow RUN
    // (`verifySelfReferentialBootstrapWaiverRun` checks `path`/`event`
    // against an Actions run), which a status-context producer has none
    // of. Worse, such a producer typically has no parseable
    // `completedAt`, which would otherwise hit this loop's stale-leaning
    // `passingCompletedAtMs === null` branch below and flag a false
    // positive even while the REAL convergence workflow's own instance
    // is genuinely fresh. Exclude any producer whose `type` is populated
    // and is not `'check-run'` before it ever becomes a candidate -- an
    // absent `type` (the pre-#1483 data shape, including this fixture's
    // own base checker instance) still passes through unaffected, same
    // as `groupChecksByProducer`'s own no-conflicting-signal fallback.
    // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P1, fresh
    // evidence against the type-only filter immediately above): a check
    // is `type: 'check-run'` for ANY Actions workflow, not only the real
    // checker -- a second, unrelated workflow file that happens to
    // publish a check-run under the identical `idd-advisory-convergence`
    // name would still pass the type filter alone. Declared independently
    // here (mirroring `MAX_PRE_MERGE_AUTO_WAIVER_RUN_LOOKUPS`'s own
    // rationale above) rather than importing a shared constant from
    // `advisory-convergence.mts`, to avoid a rebase collision with
    // #2912's concurrent work there; a dedicated test pins this literal
    // against the workflow file's own `name:` field so the two can never
    // silently drift apart. `workflowName` absent (`''`, the pre-#1483
    // data shape most fixtures in this suite still use) still passes
    // through unaffected, same as the type filter's own fallback --
    // narrowing further only excludes a POSITIVELY different workflow
    // identity, never an unlabeled one.
    const ADVISORY_CONVERGENCE_WORKFLOW_DISPLAY_NAME =
      'IDD advisory-convergence gate';
    // kurone-kito/idd-skill#2919: this issue's own motivating gap --
    // `ADVISORY_CONVERGENCE_WORKFLOW_DISPLAY_NAME` above is only the
    // workflow YAML's top-level `name:` string, which a DIFFERENT
    // workflow file can declare identically (Copilot review, PR #2915:
    // this repository's own `idd-advisory-convergence.yml` can still
    // produce a `pull_request` instance alongside its genuine
    // `pull_request_target` one from the SAME file whenever a
    // same-repository PR reintroduces that trigger to its own copy
    // post-#2764 Phase 2 -- a legitimate same-file case this filter must
    // keep passing, not the gap this constant closes; this candidate
    // filter deliberately does not itself gate on triggering event --
    // kurone-kito/idd-skill#3256's own event gate lives in
    // `pre-merge-readiness.mts`'s collector for the PRIMARY required-check
    // path, while this self-waiver path is independently protected by
    // condition 4 of the self-waiver marker's own trust model, which
    // already rejects a non-`pull_request_target` cited run -- see
    // `docs/idd-helper-scripts.md`'s "External-check waiver contract").
    // Declared as an
    // independent local literal rather than importing
    // `ADVISORY_CONVERGENCE_WORKFLOW_PATH` from `advisory-convergence.mts`
    // -- that file already imports FROM this one (`protocol-helpers.mts`),
    // so the reverse import would cycle -- mirroring
    // `ADVISORY_CONVERGENCE_WORKFLOW_DISPLAY_NAME`'s own documented
    // rationale for doing the same thing just above. A dedicated test
    // (`tests/pre-merge-readiness.test.mts`) imports the real constant
    // and pins this literal against it so the two can never silently
    // drift apart.
    const ADVISORY_CONVERGENCE_WORKFLOW_FILE_PATH =
      '.github/workflows/idd-advisory-convergence.yml';
    const selfConvergenceProducerCandidates = selectLatestCheckPerName(
      selfConvergenceRawInstances,
    ).filter(
      (check) =>
        CHECK_PASS_EQUIVALENT_STATES.has(check.state) &&
        (!check.type || check.type === 'check-run') &&
        (!check.workflowName ||
          check.workflowName === ADVISORY_CONVERGENCE_WORKFLOW_DISPLAY_NAME) &&
        // #2919: `workflowName` alone lets a decoy workflow FILE that
        // happens to share the real checker's display name masquerade
        // as a genuine candidate (this issue's own Background). Absent
        // `workflowPath` (every caller/fixture that doesn't resolve it)
        // stays permissive, identical to the `workflowName` fallback
        // just above -- only a POSITIVELY different, resolved path is
        // ever excluded.
        (!check.workflowPath ||
          check.workflowPath === ADVISORY_CONVERGENCE_WORKFLOW_FILE_PATH),
    );
    for (const latestSelfConvergenceCheck of selfConvergenceProducerCandidates) {
      const autoWaiverRunVerified = options.autoWaiverRunVerified ?? {};
      // kurone-kito/idd-skill#2911 (CodeRabbit + Copilot review, PR #2915,
      // Major): `autoWaiverRunVerified` is keyed by `runId` alone. Without
      // also requiring `checkSelector === staleSelfWaiverCheckSelector`
      // here, a DIFFERENT-selector marker (this function's own
      // `autoWaiverEvidence` is never filtered to one selector -- see its
      // own call site above) that happens to reuse an already-verified
      // `idd-advisory-convergence` run-id would be accepted as if it were
      // evidence about THIS check, letting an unrelated check's waiver
      // wrongly set `staleSelfWaiver` (`hasCoveringValidMarker` is already
      // selector-scoped and cannot compensate for this gap on its own).
      const isRunVerifiedSelfWaiverMarker = (entry: {
        authorLogin: string;
        checkSelector: string;
        reason: string;
        runId: string;
      }) =>
        entry.authorLogin === 'github-actions[bot]' &&
        entry.checkSelector === staleSelfWaiverCheckSelector &&
        entry.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON &&
        entry.runId !== '' &&
        autoWaiverRunVerified[entry.runId] === true;
      // A missing/unparseable `completedAt` on the SELECTED instance
      // fails closed (treated as stale) here, same as the pre-#2911
      // attempt: a real rerun always posts a parseable `completedAt`, so
      // this only ever costs one extra, avoidable rerun on malformed
      // evidence, never a false "not stale".
      const passingCompletedAtMs = parseCompletedAt(
        latestSelfConvergenceCheck.completedAt,
      );
      // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P1): a
      // long-running check job observes state (fetches comments/waiver
      // evidence) starting near its OWN `startedAt`, not its later
      // `completedAt` -- a claim handoff that lands strictly between
      // those two moments means the run still evaluated the OLD claim's
      // waiver even though its `completedAt` now reads after the
      // handoff. Used only by the wrongClaim claim-installation
      // comparison below (never the createdAt/expiresAt window checks,
      // which are about the marker's own lifecycle relative to when the
      // check's result was finalized, a different question). Falls back
      // to `passingCompletedAtMs` when `startedAt` is missing/unparseable
      // (legacy data shape) rather than weakening the comparison.
      const passingStartedAtMs =
        parseCompletedAt(latestSelfConvergenceCheck.startedAt) ??
        passingCompletedAtMs;
      // kurone-kito/idd-skill#2911 (acceptance criterion 2, self-critique
      // against round 13's own commit message -- `git show 863c5249`
      // promised "correlation to the passing check's own completedAt OR
      // to a newer valid marker" but its diff only ever implemented the
      // first half): a candidate `expired`/`wrongClaim` marker proves
      // nothing when a DIFFERENT, currently-valid, run-verified
      // self-referential marker's own `[createdAt, expiresAt]` window
      // already covers the moment the check last completed -- that is
      // exactly "a fresh rerun under a new valid marker...has already
      // superseded a stale marker." This is a time-window correlation
      // over evidence this SAME call site's own `autoWaiverEvidence`
      // already computed, not a use of `valid` to satisfy or relax the
      // OVERALL gate (that direction stays exclusively `autoWaiverValid`'s,
      // per `allowSelfReferentialBootstrapAuto`'s own ADD-only contract) --
      // it only ever prevents THIS blocker from mis-firing on a pass that
      // a fresh marker already, genuinely covers; it can never clear a
      // blocker any OTHER evidence in this file raised.
      //
      // kurone-kito/idd-skill#2911 (design model, stated once here so a
      // future review pass reads it instead of re-deriving it): the
      // underlying question for ALL THREE finders below is interval
      // overlap -- could this marker's own validity window,
      // `[createdAt, expiresAt]`, have overlapped the run's observation
      // window, `[startedAt, completedAt]`? That is
      // `createdAt <= completedAt && expiresAt >= startedAt`. The LOWER
      // bound stays anchored on `completedAt` (not `startedAt`)
      // deliberately: the marker is posted BY the run itself, so its
      // `createdAt` falls somewhere mid-run, between the run's own
      // `startedAt` and `completedAt` -- anchoring the lower bound on
      // `startedAt` instead would make a run's own marker unable to
      // cover its own pass, breaking acceptance criterion 2 outright.
      // The UPPER bound anchors on `startedAt` (via `passingStartedAtMs`,
      // falling back to `passingCompletedAtMs` when unparseable): the run
      // reads waiver evidence near its own start, so a marker that was
      // still valid then, but expires before the run's slower
      // `completedAt`, must not be misread as "expired before this pass"
      // (Codex review, PR #2915, round 7, P2) -- the accepted residual is
      // that a marker which expired early in the run, strictly before the
      // run's own evidence-fetch instant (which this code cannot observe
      // directly), still gets flagged and costs one avoidable rerun,
      // never a false "not stale": the alternative of anchoring on
      // `completedAt` instead risks the false negative Codex identified,
      // which is the worse failure for a security-relevant blocker.
      const hasCoveringValidMarker =
        passingCompletedAtMs !== null &&
        autoWaiverEvidence.valid.some((entry) => {
          if (
            entry.authorLogin !== 'github-actions[bot]' ||
            entry.reason !== SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON ||
            entry.checkSelector !== staleSelfWaiverCheckSelector ||
            entry.runId === '' ||
            autoWaiverRunVerified[entry.runId] !== true
          ) {
            return false;
          }
          const createdAtMs = Date.parse(entry.createdAt);
          const expiresAtMs = Date.parse(entry.expiresAt);
          return (
            !Number.isNaN(createdAtMs) &&
            !Number.isNaN(expiresAtMs) &&
            createdAtMs <= passingCompletedAtMs &&
            passingCompletedAtMs <= expiresAtMs
          );
        });
      // kurone-kito/idd-skill#2911 (Copilot review, PR #2915): checking
      // only `expiresAt >= ...` (the upper bound) is not enough on its
      // own -- a marker CREATED after the check already completed could
      // not possibly have justified that earlier pass no matter how far
      // its `expiresAt` reaches, so the LOWER bound
      // (`createdAt <= passingCompletedAtMs`) must also hold before an
      // entry counts as having plausibly covered the pass. An unparseable
      // boundary on either side still counts (stale-leaning, matching this
      // blocker's established fail-toward-flagging asymmetry) -- only a
      // POSITIVE, parseable `createdAt` strictly after the pass excludes
      // an entry.
      //
      // kurone-kito/idd-skill#2911 (Codex review, PR #2915, round 7, P2):
      // the UPPER bound anchors on `passingStartedAtMs` (falling back to
      // `passingCompletedAtMs`), not `passingCompletedAtMs` directly --
      // see the interval-overlap model documented above
      // `hasCoveringValidMarker`. A marker that was still valid when the
      // run observed it near its own start, but expires before the run's
      // slower `completedAt`, must not be misread as having expired
      // before the pass it actually covered.
      const staleExpiredEntry = hasCoveringValidMarker
        ? undefined
        : autoWaiverEvidence.expired.find((entry) => {
            if (!isRunVerifiedSelfWaiverMarker(entry)) return false;
            if (passingCompletedAtMs === null) return true;
            const entryExpiresAtMs = Date.parse(entry.expiresAt);
            const entryCreatedAtMs = Date.parse(entry.createdAt);
            const runObservationBoundMs =
              passingStartedAtMs ?? passingCompletedAtMs;
            return (
              (Number.isNaN(entryExpiresAtMs) ||
                entryExpiresAtMs >= runObservationBoundMs) &&
              (Number.isNaN(entryCreatedAtMs) ||
                entryCreatedAtMs <= passingCompletedAtMs)
            );
          });
      // kurone-kito/idd-skill#2911 (Copilot review, PR #2915): the
      // identical lower-bound reasoning as `staleExpiredEntry` above --
      // a `wrongClaim` marker created AFTER the check already completed
      // could not have justified that pass either, regardless of the
      // claim-installation comparison below. Same stale-leaning
      // treatment of an unparseable `createdAt`.
      //
      // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P2): ALSO
      // requires the upper bound, mirroring `staleExpiredEntry`'s own
      // two-sided window check -- without it, a marker that had ALREADY
      // expired before the check even completed (a real scenario here
      // specifically: this function's own `wrongClaim` classification
      // runs BEFORE the expiry check, so a marker can be both
      // wrong-claim AND already-expired yet only ever reach this bucket,
      // never `expired`) gets treated as if it could have justified a
      // LATER, genuinely unrelated pass, purely because the claim
      // identity also happened to change again even later -- an
      // unnecessary blocker with no real evidence behind it.
      //
      // kurone-kito/idd-skill#2911 (Codex review, PR #2915, round 7, P2):
      // the upper-bound comparison anchors on `passingStartedAtMs`
      // (falling back to `passingCompletedAtMs`), the same
      // run-observation-bound reasoning as `staleExpiredEntry` above --
      // see the interval-overlap model documented above
      // `hasCoveringValidMarker`.
      const staleWrongClaimEntry =
        staleExpiredEntry || hasCoveringValidMarker
          ? undefined
          : autoWaiverEvidence.wrongClaim.find((entry) => {
              if (!isRunVerifiedSelfWaiverMarker(entry)) return false;
              if (passingCompletedAtMs === null) return true;
              const entryCreatedAtMs = Date.parse(entry.createdAt);
              const entryExpiresAtMs = Date.parse(entry.expiresAt);
              const runObservationBoundMs =
                passingStartedAtMs ?? passingCompletedAtMs;
              if (
                !Number.isNaN(entryCreatedAtMs) &&
                entryCreatedAtMs > passingCompletedAtMs
              ) {
                return false;
              }
              if (
                !Number.isNaN(entryExpiresAtMs) &&
                entryExpiresAtMs < runObservationBoundMs
              ) {
                return false;
              }
              if (!claimIdentityInstalledAt) return true;
              const installedAtMs = Date.parse(claimIdentityInstalledAt);
              // kurone-kito/idd-skill#2911 (Codex review, PR #2915, P1):
              // anchors on `passingStartedAtMs`, not `passingCompletedAtMs`
              // -- see that variable's own doc comment. A claim handoff
              // landing strictly between the run's start and its
              // completion still means the run's own evidence-fetch
              // observed the OLD claim, so this must flag stale even
              // though the check's `completedAt` now reads after the
              // handoff.
              //
              // kurone-kito/idd-skill#2911 (Codex review, PR #2915,
              // round 7, P1): uses `<=`, not `<` -- when the run's own
              // observation bound and the claim-installation instant
              // serialize to the EXACT same timestamp, there is no
              // positive evidence the run's evidence-fetch actually
              // happened after the handoff (a run can begin and read the
              // old claim immediately before a handoff inside the same
              // timestamp interval), so a tie must be treated as stale,
              // not fresh.
              return (
                Number.isNaN(installedAtMs) ||
                runObservationBoundMs <= installedAtMs
              );
            });
      if (staleExpiredEntry) {
        staleSelfWaiver = {
          stale: true,
          checkSelector: staleSelfWaiverCheckSelector,
          reason: 'expired',
          expiresAt: staleExpiredEntry.expiresAt,
          waiverClaimId: '',
        };
        break;
      } else if (staleWrongClaimEntry) {
        staleSelfWaiver = {
          stale: true,
          checkSelector: staleSelfWaiverCheckSelector,
          reason: 'wrong-claim',
          expiresAt: '',
          waiverClaimId: staleWrongClaimEntry.waiverClaimId,
        };
        break;
      }
    }
  }

  // #1570: reuse the SAME raw waiver evidence above (already validated for
  // selector/HEAD/claim/authority/expiry) to decide whether the caller-
  // supplied terminal-unavailability verdict is also validly waived, filtered
  // to the `idd-advisory-convergence` selector -- the identical selector
  // advisory-convergence.mts's own terminal-waiver path consumes, so a single
  // maintainer-posted waiver marker satisfies whichever gate (the CI
  // required-check, or this direct F2/F3 evidence collector) is currently
  // asking. Deliberately reads the RAW `waiverEvidence`, not
  // `ciWaiverEvidence`: this blocker is itself gated on
  // `copilotUnavailable === true` (the terminal precondition already proven),
  // so the deadline-vs-terminal precondition split above would be redundant
  // here.
  const copilotUnavailableWaived =
    copilotUnavailable &&
    (waiverEvidence.valid.some(
      (entry) =>
        entry.checkSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
    ) ||
      // #2353: a repository-scoped provider-outage declaration also clears
      // this dedicated blocker, same as a direct maintainer waiver.
      advisoryConvergenceOutageRelieved);

  const dispositionEvidence = options.includeDispositionEvidence
    ? summarizeDispositionEvidenceForGate(
        { comments, threads },
        {
          iddAgentLogins,
          advisoryBotLogins,
          trustedMarkerLogins,
          prAuthorLogin,
          snapshotBoundaryAt: watermark?.maxActivityUpdatedAt ?? null,
        },
      )
    : null;

  const summary: { dispositionEvidence?: DispositionEvidenceSummary } & Record<
    string,
    unknown
  > = {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prHeadSha,
    now,
    reviewCurrency: {
      watermarkPresent: Boolean(watermark),
      watermark: {
        agentId: watermark?.agentId ?? '',
        claimId: watermark?.claimId ?? '',
        headSha: watermark?.headSha ?? '',
        maxActivityUpdatedAt: watermark?.maxActivityUpdatedAt ?? 'none',
        totalItemCount: watermark?.totalItemCount ?? 0,
        latestCiCompletedAt: watermark?.latestCiCompletedAt ?? 'none',
        createdAt: watermark?.createdAt ?? 'none',
      },
      live: {
        totalItemCount: liveSnapshot.totalItemCount,
        maxActivityUpdatedAt: liveSnapshot.maxActivityUpdatedAt,
        latestCiCompletedAt: liveSnapshot.latestCiCompletedAt,
        latestPassingCiCompletedAt: liveSnapshot.latestPassingCiCompletedAt,
        counts: liveSnapshot.counts,
        ackOnly: liveSnapshot.ackOnly,
        effective: liveSnapshot.effective,
      },
      comparisonRoute: reviewCurrency.route,
      comparisonReason: reviewCurrency.reason,
    },
    secondaryQuietWindow,
    threads: {
      unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
      actionableCount: threadSummary.actionableCount,
      awaitingReviewerCount: threadSummary.awaitingReviewerCount,
      amdBlockingCount: threadSummary.amdBlockingCount,
      conversationResolveAgentCount:
        threadSummary.conversationResolveAgentCount,
      conversationResolveAuthorCount:
        threadSummary.conversationResolveAuthorCount,
      classifications: threadSummary.classifications,
    },
    unrepliedComments,
    reviewerStates,
    advisoryWait: {
      outcome: advisoryWait.outcome,
      f3Outcome: advisoryWait.f3Outcome,
      lastCopilotCommit: advisoryWait.lastCopilotCommit,
      copilotPending: advisoryWait.copilotPending,
      copilotPendingCoversHead: advisoryWait.copilotPendingCoversHead,
      sameHeadMarkerPresent: advisoryWait.sameHeadMarkerPresent,
      earliestSameHeadAt: advisoryWait.earliestSameHeadAt,
      sameHeadMarkerCount: advisoryWait.sameHeadMarkerCount,
      requestMarkerCount: advisoryWait.requestMarkerCount,
      requestCap: advisoryWait.requestCap,
      pendingWindowMinutes: advisoryWait.pendingWindowMinutes,
      settledWindowMinutes: advisoryWait.settledWindowMinutes,
      pollIntervalMinutes: advisoryWait.pollIntervalMinutes,
      capExhaustedRoute: advisoryWait.capExhaustedRoute,
      elapsedMinutes: advisoryWait.elapsedMinutes,
      copilotUnavailable,
      copilotUnavailableWaived,
    },
    ci,
    claim,
    waiverEvidence,
    // #2021: the deadline/terminal precondition evaluated above, reported
    // unconditionally as its own field (never folded into `waiverEvidence`,
    // whose shape is the schema-locked `ExternalCheckWaiverEvidence`) so a
    // blocker detail or a resuming agent can cite the remaining
    // time-to-deadline without re-deriving it.
    advisoryConvergenceWaiverPrecondition,
    // kurone-kito/idd-skill#2911: reported unconditionally (never omitted),
    // matching this file's own convention for evidence fields
    // `computePreMergeReadinessBlockers` consumes -- see `staleSelfWaiver`'s
    // own computation above for the full contract. Deliberately outside
    // `claim` (not `claim.activeClaimInstalledAt`): `ClaimValidationSummary`'s
    // shape is embedded in schemas beyond this one (e.g.
    // `discover-roadmap-union.schema.json`), so this stays a top-level,
    // pre-merge-readiness-only field instead.
    claimIdentityInstalledAt,
    staleSelfWaiver,
    branchCurrency,
  };

  if (dispositionEvidence) {
    summary.dispositionEvidence = dispositionEvidence;
  }

  // #2323: informational only -- never a blocker input, and omitted
  // entirely (not even `null`) when the caller does not pass it, mirroring
  // `dispositionEvidence` above so every pre-#2323 fixture/caller output is
  // byte-for-byte unchanged. See the option's doc comment above for why
  // this can never change `ready`/`blockers`.
  if (options.localValidationEvidenceSummary) {
    summary.localValidationEvidence = options.localValidationEvidenceSummary;
  }

  // #2272: omitted entirely (not even `null`) when the caller does not
  // pass it, so `computePreMergeReadinessBlockers` below can distinguish
  // "no gate" from "gate present" -- see the option's doc comment above.
  if (options.developmentBranchTarget) {
    summary.developmentBranchTarget = options.developmentBranchTarget;
  }

  // #3298: omitted entirely (not even `null`) when the caller does not pass
  // it, mirroring developmentBranchTarget's own omission contract
  // immediately above -- see that option's doc comment for why
  // `computePreMergeReadinessBlockers` treats an absent section as "no
  // gate" (unmigrated caller / unit fixture) while the real collector
  // always emits one.
  if (options.closingSet) {
    summary.closingSet = options.closingSet;
  }

  // Top-level rollup so a consumer reads one `ready` boolean + `blockers[]`
  // instead of hand-ANDing ~8 nested gates (a dropped clause would fail open).
  // Includes the F2 ack-only overrides (#2125) so a fully-autonomous F3
  // session does not livelock on courtesy advisory-bot acks.
  const blockers = computePreMergeReadinessBlockers(summary);
  summary.ready = blockers.length === 0;
  summary.blockers = blockers;

  return summary;
}

function normalizeLiveStatusDigestFields(fields: LiveStatusDigestFields) {
  const normalized = {
    phase: normalizeDigestField(fields.phase, 'Phase'),
    claim: normalizeDigestField(fields.claim, 'Claim'),
    branch: normalizeDigestField(fields.branch, 'Branch'),
    lastChecked: normalizeDigestField(fields.lastChecked, 'Last checked'),
    openBlockers: normalizeDigestField(fields.openBlockers, 'Open blockers'),
    nextAction: normalizeDigestField(fields.nextAction, 'Next action'),
    authoritativeBy: normalizeDigestField(
      fields.authoritativeBy,
      'Authoritative by',
    ),
  };

  if (!isValidIsoTimestamp(normalized.lastChecked)) {
    throw new Error('Last checked must be an ISO 8601 UTC timestamp');
  }

  return normalized;
}

function normalizeDigestField(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');
}

function firstLine(value: unknown): string {
  return String(value)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/, 1)[0]
    .trimEnd();
}

function sameDigestBody(currentBody: string, nextBody: string): boolean {
  return currentBody.trimEnd() === nextBody.trimEnd();
}

/**
 * The distributed default claim-staleness window (`claimTiming.staleAge`
 * `PT24H`), in milliseconds. Exported so config-aware callers can compare
 * a parsed `claimTiming.staleAge` against "no override configured" and so
 * {@link isStaleByAge} can fast-path to {@link isStaleAt} when the two
 * agree.
 */
export const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export function isStaleAt(
  activeCreatedAt: string,
  nextCreatedAt: string,
): boolean {
  return (
    new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >=
    DEFAULT_STALE_AGE_MS
  );
}

/**
 * Config-aware claim-staleness primitive: true when `nextCreatedAt` is at
 * least `staleAgeMs` after `activeCreatedAt`. This is the single shared
 * primitive promoted out of the staleness-window comparison that was
 * independently duplicated across the resume and discover paths (each of
 * which already reads `claimTiming.staleAge` from policy correctly) so a
 * write-gate caller can reuse the exact same algorithm instead of adding
 * yet another copy. Delegates to {@link isStaleAt} when `staleAgeMs` equals
 * {@link DEFAULT_STALE_AGE_MS}, so behavior stays byte-identical for
 * repositories on the default. Fails closed to `false` (not stale) when
 * either timestamp is unparseable.
 */
export function isStaleByAge(
  activeCreatedAt: string,
  nextCreatedAt: string,
  staleAgeMs: number,
): boolean {
  if (staleAgeMs === DEFAULT_STALE_AGE_MS) {
    return isStaleAt(activeCreatedAt, nextCreatedAt);
  }
  const start = Date.parse(activeCreatedAt ?? '');
  const end = Date.parse(nextCreatedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return false;
  }
  return end - start >= staleAgeMs;
}

/**
 * Resolve the `isStale` predicate for the write-gate resolvers below from an
 * optional caller-supplied `staleAgeMs` (a parsed `claimTiming.staleAge` in
 * milliseconds). A valid positive finite value routes through the
 * config-aware {@link isStaleByAge}; an omitted, non-numeric, non-finite, or
 * non-positive value falls back to {@link isStaleAt} unchanged, so callers
 * that do not pass `staleAgeMs` keep today's exact 24h behavior.
 */
function resolveStalePredicate(
  staleAgeMs: number | undefined,
): (activeCreatedAt: string, nextCreatedAt: string) => boolean {
  if (
    typeof staleAgeMs !== 'number' ||
    !Number.isFinite(staleAgeMs) ||
    staleAgeMs <= 0
  ) {
    return isStaleAt;
  }
  return (activeCreatedAt: string, nextCreatedAt: string) =>
    isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs);
}

/**
 * Resolve the configured claim-staleness window (`claimTiming.staleAge`,
 * #1310) in milliseconds from an already-loaded `.github/idd/config.json`
 * object (or `null`) -- e.g. `loadIddConfig()`'s or `loadTrustedIddConfig()`'s
 * return value directly, or a raw untyped config object a caller already
 * parsed itself. The single shared config-read point every write-gate
 * caller of {@link resolveActiveClaimForWriteGate} /
 * {@link summarizeClaimValidationForWriteGate} should use, so a caller that
 * already has its config in hand needs no second local copy of this
 * parse-with-fallback (#3270 hoists this out of `pre-merge-readiness.mts`,
 * its sole pre-#3270 home, to a shared façade every caller across the
 * codebase can import). `normalizePolicyConfig(config).claimTiming.staleAge`
 * is already fail-safe-normalized (a valid ISO-8601 duration, or the
 * distributed `PT24H` default when the configured value is missing or
 * malformed), so `parseIsoDurationToMs` only needs its own `?? fallback` for
 * belt-and-suspenders defense, not as the primary fallback path.
 *
 * Deliberately defined here, not in `policy-helpers.mts` (the issue's own
 * proposed location): `policy-helpers.mts` -> `protocol-helpers.mts` ->
 * `idd-config.mts` -> `policy-helpers.mts` would be a real import cycle,
 * since `idd-config.mts` already imports the critique-loop resolvers from
 * `policy-helpers.mts` and this file already imports `loadIddConfig` from
 * `idd-config.mts`. This file already imports `normalizePolicyConfig` /
 * `parseIsoDurationToMs` FROM `policy-helpers.mts` with no cycle (that file
 * has no dependency back on this one), so co-locating this reader beside
 * {@link DEFAULT_STALE_AGE_MS} / {@link isStaleAt} / {@link isStaleByAge} —
 * the other claim-staleness primitives it composes — avoids the cycle
 * entirely while keeping every claim-staleness primitive in one module.
 */
export function readClaimStaleAgeMs(config: unknown): number {
  return (
    parseIsoDurationToMs(normalizePolicyConfig(config).claimTiming.staleAge) ??
    DEFAULT_STALE_AGE_MS
  );
}

/**
 * Ascending, case-sensitive ASCII compare of two claim-ids -- the
 * lexicographic tie-break `idd-claim.instructions.md` documents for
 * same-second competing claims. A plain string comparator over a single
 * key, so it is trivially transitive for every triple. Exported so
 * `orderClaimEvents` below and its tests share and can directly assert
 * against the identical primitive.
 */
export function compareClaimIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function createdAtToTime(createdAt: string | null | undefined): number | null {
  const time = new Date(createdAt ?? '').getTime();
  return Number.isFinite(time) ? time : null;
}

function createdAtToSecond(
  createdAt: string | null | undefined,
): number | null {
  const time = createdAtToTime(createdAt);
  if (time === null) {
    return null;
  }
  return Math.floor(time / 1000);
}

/**
 * Robust ISO timestamp comparison: returns true only when both `left` and
 * `right` parse to valid instants and `left` is strictly before `right`. If
 * either side is missing or unparseable, returns false (fail closed). Used by
 * the forced-handoff enable gate to decide whether an `issue-only` handoff
 * predates a PR's first commit.
 */
function isStrictlyBeforeIso(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftTime = createdAtToTime(left);
  const rightTime = createdAtToTime(right);
  if (leftTime === null || rightTime === null) {
    return false;
  }
  return leftTime < rightTime;
}

/** {@link orderClaimEvents}'s per-event decoration; also the shape
 * {@link compareClaimEventOrder} compares directly. */
interface DecoratedClaimEvent {
  event: CommentLike;
  index: number;
  time: number | null;
  second: number | null;
  claimId: string | null;
}

/**
 * Base chronological comparator: by GitHub `created_at` second (`null`
 * sorts last), then by sub-second time (`null` sorts last), then by
 * original array index. Deliberately excludes any claim-id comparison --
 * a single comparator that conditionally switched to comparing claim-id
 * only when both sides happened to parse as a claim (the pre-#3266
 * `sortClaimEvents`) is not transitive: a claim/non-claim/claim triple in
 * the same second can cycle (`kurone-kito/idd-skill#3266`). This
 * comparator alone is a plain lexicographic order over a 3-tuple and is
 * transitive for every triple; {@link orderClaimEvents} applies the
 * claim-id tie-break as a separate, second pass instead of folding it in
 * here. Exported so a test can assert this comparator's own transitivity
 * directly.
 */
export function compareClaimEventOrder(
  left: Pick<DecoratedClaimEvent, 'second' | 'time' | 'index'>,
  right: Pick<DecoratedClaimEvent, 'second' | 'time' | 'index'>,
): number {
  if (
    left.second !== null &&
    right.second !== null &&
    left.second !== right.second
  ) {
    return left.second - right.second;
  }
  if (left.second !== null && right.second === null) {
    return -1;
  }
  if (left.second === null && right.second !== null) {
    return 1;
  }

  if (left.time !== null && right.time !== null && left.time !== right.time) {
    return left.time - right.time;
  }

  return left.index - right.index;
}

/**
 * Total, deterministic ordering over an ALREADY trust-filtered set of
 * claim-lifecycle comment events -- the single ordering primitive
 * `resolveActiveClaimWithForcedHandoffTrace` (which performs the trust
 * filtering, once, before calling this) and `resume-claim-routing.mts`'s
 * legacy-only path both use, replacing the former `sortClaimEvents`
 * (renamed/exported here) and the near-duplicate `compareEvents` that
 * used to live in `resume-claim-routing.mts` (kurone-kito/idd-skill#3266).
 *
 * Two-step algorithm, chosen specifically to keep every comparator it
 * uses transitive (see {@link compareClaimEventOrder}'s own doc comment
 * for why a single mixed comparator is not):
 *
 * 1. A stable base sort by {@link compareClaimEventOrder} --
 *    `(second, sub-second time, original index)`.
 * 2. Within each maximal run of equal, non-null `second`, the *positions*
 *    (not the events) that parsed as a `claimed-by` marker are collected
 *    and their occupants re-sorted, ascending, by
 *    {@link compareClaimIds} -- the lexicographic tie-break
 *    `idd-claim.instructions.md` documents for same-second competing
 *    claims. Every other position in that run (an activation-nonce, an
 *    `unclaimed-by`, a forced-handoff marker, or a plain comment) keeps
 *    exactly the slot the base sort gave it -- its "fetch order" within
 *    the second is never disturbed by which claim-ids happen to be
 *    interleaved with it.
 *
 * A run with a null `second` (an unparseable `createdAt`) never groups
 * with any other event for step 2 -- each such event is its own
 * single-element run, so no claim-id reordering applies to it; it simply
 * keeps its step-1 position, same as `sortClaimEvents` before it.
 */
export function orderClaimEvents(events: CommentLike[]): CommentLike[] {
  const decorated: DecoratedClaimEvent[] = events.map((event, index) => {
    const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
    return {
      event,
      index,
      claimId: claim?.claimId ?? null,
      time: createdAtToTime(event.createdAt),
      second: createdAtToSecond(event.createdAt),
    };
  });

  const base = [...decorated].sort(compareClaimEventOrder);

  let i = 0;
  while (i < base.length) {
    const second = base[i].second;
    let j = i + 1;
    if (second !== null) {
      while (j < base.length && base[j].second === second) {
        j += 1;
      }
    }
    const slots: number[] = [];
    for (let k = i; k < j; k += 1) {
      if (base[k].claimId !== null) {
        slots.push(k);
      }
    }
    if (slots.length > 1) {
      const claimants = slots.map((slot) => base[slot]);
      claimants.sort((left, right) =>
        compareClaimIds(left.claimId as string, right.claimId as string),
      );
      for (let m = 0; m < slots.length; m += 1) {
        base[slots[m]] = claimants[m];
      }
    }
    i = j;
  }

  return base.map(({ event }) => event);
}

/** Result of {@link resolveActiveClaimWithForcedHandoffTrace}. */
export interface ActiveClaimResolution {
  activeClaim: ParsedClaimMarker | null;
  /**
   * The claim that was most recently released when no claim is active.
   * Callers use this only to keep a released branch subject to the local
   * worktree collision check; a release clears remote ownership, not the
   * filesystem lock represented by a live worktree.
   */
  releasedClaim: ParsedClaimMarker | null;
  /**
   * The specific trusted, rule-7-valid `forced-handoff` marker whose
   * application produced `activeClaim`'s current identity, or `null` when
   * the latest claim-identity change was not a forced handoff (fresh
   * claim, stale takeover) or no claim-identity change occurred at all
   * (e.g. only heartbeats followed the last transition).
   */
  appliedForcedHandoff: ParsedForcedHandoffMarker | null;
  /**
   * kurone-kito/idd-skill#2911: the GitHub `createdAt` of the event that
   * most recently changed `activeClaim`'s `(agentId, claimId)` identity --
   * a fresh claim, a stale takeover, or a forced handoff -- as opposed to
   * `activeClaim.createdAt` itself, which `applyClaimEvent`'s heartbeat
   * branch deliberately overwrites on every SAME-claim heartbeat (that
   * field is the correct "stale clock" anchor for `idd-claim.instructions.md`'s
   * staleness rule, but it is NOT a stable "this identity became active
   * at" anchor -- a long-lived claim's `createdAt` keeps moving forward
   * with every 12h heartbeat even though its identity never changes).
   * `''` when no event ever produced a non-null active claim. A release
   * with no later re-claim leaves this holding the release event's own
   * `createdAt` (the "identity" transitioned to null then), which is
   * harmless: callers that care about this field only ever consult it
   * alongside a non-null `activeClaim`/`activeClaimPresent`.
   */
  activeSince: string;
}

/**
 * Same reduction as {@link resolveActiveClaim}, but also tracks which
 * specific forced-handoff marker (if any) produced the final active
 * claim's identity. `resolveActiveClaim`'s state machine has no memory of
 * *why* the active claim changed, so a caller that needs forced-handoff
 * provenance (`resume-claim-routing.mts`'s `evidence.forced_handoff`,
 * kurone-kito/idd-skill#2178) cannot reconstruct it safely by
 * independently re-scanning events for a `new*`-field match against the
 * final active claim: a stale or never-applied forced-handoff marker
 * whose `new*` fields merely coincide with the real active claim's
 * identity (for example a duplicate/retried handoff attempt posted after
 * a first one already succeeded) would misattribute the wrong `old*`
 * fields as evidence. Replaying the identical single-pass reduction here
 * -- the one place that already knows the true before/after state at each
 * step -- is what answers "which marker actually caused this transition"
 * correctly.
 */
export function resolveActiveClaimWithForcedHandoffTrace(
  events: CommentLike[],
  isTrustedAuthor: ClaimResolutionOptions | ((login: string) => boolean) = () =>
    true,
): ActiveClaimResolution {
  const options = normalizeClaimResolutionOptions(isTrustedAuthor);
  // kurone-kito/idd-skill#3266: filter to trusted authors ONCE, here,
  // before ordering -- not only inside applyClaimEvent's later per-event
  // check. Before this fix, an untrusted comment (claim-shaped or not)
  // still occupied a slot `sortClaimEvents` itself reasoned about (its
  // claim-id, if any, still participated in the same-second tie-break),
  // which could shift the relative order of two genuinely trusted
  // same-second claims around it -- part of the reported non-transitive
  // same-second cycle, and the reason `resolveActiveClaimForWriteGate` /
  // `summarizeClaimValidation` (both feed this function the full,
  // unfiltered stream) could disagree with `evaluateResumeClaimRouting`
  // (which already filtered before calling this). Filtering first means
  // every caller -- resume routing, the write-gate, and any direct
  // caller such as `discover-roadmap-graph.mts` /
  // `discover-shared-file-overlap.mts` -- orders and reduces over the
  // identical trusted event set. `applyClaimEvent`'s own per-event
  // trust check below stays as defense in depth (always true in
  // practice now, since every event it sees already passed this filter).
  const trustedEvents = events.filter((event) =>
    options.isTrustedAuthor(event.author?.login ?? ''),
  );
  const orderedEvents = orderClaimEvents(trustedEvents);

  let active: ParsedClaimMarker | null = null;
  let releasedClaim: ParsedClaimMarker | null = null;
  let appliedForcedHandoff: ParsedForcedHandoffMarker | null = null;
  let activeSince = '';
  for (const event of orderedEvents) {
    const previous = active;
    const next = applyClaimEvent(previous, event, options);
    const identityChanged =
      (next?.claimId ?? null) !== (previous?.claimId ?? null) ||
      (next?.agentId ?? null) !== (previous?.agentId ?? null);
    if (identityChanged) {
      if (previous && !next) {
        releasedClaim = previous;
      } else if (next) {
        releasedClaim = null;
      }
      const candidate = previous
        ? parseForcedHandoffComment(event.body ?? '', event.createdAt ?? '')
        : null;
      appliedForcedHandoff =
        candidate &&
        next &&
        previous &&
        candidate.oldAgentId === previous.agentId &&
        candidate.oldClaimId === previous.claimId &&
        candidate.branch === previous.branch &&
        candidate.newAgentId === next.agentId &&
        candidate.newClaimId === next.claimId
          ? candidate
          : null;
      // kurone-kito/idd-skill#2911: record the transition's own event
      // timestamp -- see `ActiveClaimResolution.activeSince`'s doc comment
      // for why this must be captured here (at the identity-changing step
      // itself) rather than read back from `next.createdAt`, which a LATER
      // same-claim heartbeat mutates in place.
      activeSince = String(event.createdAt ?? '');
    }
    active = next;
  }
  return {
    activeClaim: active,
    releasedClaim,
    appliedForcedHandoff,
    activeSince,
  };
}

export function resolveActiveClaim(
  events: CommentLike[],
  isTrustedAuthor: ClaimResolutionOptions | ((login: string) => boolean) = () =>
    true,
): ParsedClaimMarker | null {
  return resolveActiveClaimWithForcedHandoffTrace(events, isTrustedAuthor)
    .activeClaim;
}

export function applyClaimEvent(
  activeClaim: ParsedClaimMarker | null,
  event: CommentLike,
  options: ClaimResolutionOptions | ((login: string) => boolean) = {},
): ParsedClaimMarker | null {
  const normalizedOptions = normalizeClaimResolutionOptions(options);
  const authorLogin = event.author?.login ?? '';
  if (!normalizedOptions.isTrustedAuthor(authorLogin)) {
    return activeClaim;
  }

  const claim = parseClaimComment(event.body ?? '', event.createdAt ?? '');
  if (claim) {
    if (!activeClaim) {
      return claim.supersedes === 'none' ? claim : null;
    }

    if (
      claim.agentId === activeClaim.agentId &&
      claim.claimId === activeClaim.claimId
    ) {
      // Enforce the heartbeat branch invariant (idd-claim.instructions.md
      // rule 3.5): a heartbeat candidate whose {branch} does not exactly
      // match the active claim's {branch} is anomalous and must not
      // refresh the stale clock. Without this guard, a spurious heartbeat
      // could extend the stale clock indefinitely and block the 24h
      // stale-takeover recovery path that audit-pr-cleanup depends on.
      if (claim.branch !== activeClaim.branch) {
        normalizedOptions.onAnomalousHeartbeat({
          agentId: claim.agentId,
          claimId: claim.claimId,
          activeBranch: activeClaim.branch,
          heartbeatBranch: claim.branch,
          createdAt: event.createdAt,
        });
        return activeClaim;
      }
      return {
        ...activeClaim,
        createdAt: event.createdAt ?? activeClaim.createdAt,
      };
    }

    if (
      claim.supersedes === activeClaim.claimId &&
      normalizedOptions.isStale(activeClaim.createdAt, event.createdAt ?? '')
    ) {
      return claim;
    }

    return activeClaim;
  }

  const release = parseReleaseComment(event.body ?? '');
  if (
    release &&
    activeClaim &&
    release.agentId === activeClaim.agentId &&
    release.claimId === activeClaim.claimId
  ) {
    return null;
  }

  const forcedHandoff = parseForcedHandoffComment(
    event.body ?? '',
    event.createdAt ?? '',
  );
  if (
    forcedHandoff &&
    activeClaim &&
    forcedHandoff.oldAgentId === activeClaim.agentId &&
    forcedHandoff.oldClaimId === activeClaim.claimId &&
    forcedHandoff.branch === activeClaim.branch
  ) {
    if (!normalizedOptions.isForcedHandoffEnabled(forcedHandoff, event)) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'mode-disabled',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    // Optional: bind the asserted forcedBy identity to the comment
    // author so a trusted-marker actor cannot self-attest a handoff by
    // naming an unrelated maintainer in the payload. This is the
    // strict mode used by the Resume routing path (idd-claim.instructions.md
    // rule 7). The default is off because production forced-handoff
    // markers can be posted on behalf of a maintainer by a separate
    // automation account; callers that want the strict binding (e.g.
    // resume-claim-routing.mjs) opt in via `requireAuthorMatchesForcedBy`.
    if (normalizedOptions.requireAuthorMatchesForcedBy) {
      const authorLoginLower = String(authorLogin).trim().toLowerCase();
      const forcedByLower = String(forcedHandoff.forcedBy ?? '')
        .trim()
        .toLowerCase();
      if (!authorLoginLower || authorLoginLower !== forcedByLower) {
        normalizedOptions.onIgnoredForcedHandoff({
          reason: 'author-forced-by-mismatch',
          forcedHandoff,
          event,
        });
        return activeClaim;
      }
    }
    if (
      !normalizedOptions.isAuthorizedForcedHandoff(
        forcedHandoff.forcedBy,
        forcedHandoff,
        event,
      )
    ) {
      normalizedOptions.onIgnoredForcedHandoff({
        reason: 'forced-by-unauthorized',
        forcedHandoff,
        event,
      });
      return activeClaim;
    }
    return {
      agentId: forcedHandoff.newAgentId,
      claimId: forcedHandoff.newClaimId,
      supersedes: forcedHandoff.oldClaimId,
      branch: forcedHandoff.branch,
      createdAt: forcedHandoff.createdAt ?? activeClaim.createdAt,
    };
  }

  return activeClaim;
}

function normalizeClaimResolutionOptions(
  optionsOrPredicate:
    | ClaimResolutionOptions
    | ((login: string) => boolean)
    | null
    | undefined,
): NormalizedClaimResolutionOptions {
  if (typeof optionsOrPredicate === 'function') {
    return {
      isTrustedAuthor: optionsOrPredicate,
      isForcedHandoffEnabled: () => false,
      isAuthorizedForcedHandoff: () => false,
      isStale: isStaleAt,
      requireAuthorMatchesForcedBy: false,
      onAnomalousHeartbeat: () => {},
      onIgnoredForcedHandoff: () => {},
    };
  }

  const options = optionsOrPredicate ?? {};
  return {
    isTrustedAuthor:
      typeof options.isTrustedAuthor === 'function'
        ? options.isTrustedAuthor
        : () => true,
    isForcedHandoffEnabled:
      typeof options.isForcedHandoffEnabled === 'function'
        ? options.isForcedHandoffEnabled
        : () => false,
    isAuthorizedForcedHandoff:
      typeof options.isAuthorizedForcedHandoff === 'function'
        ? options.isAuthorizedForcedHandoff
        : () => false,
    isStale:
      typeof options.isStale === 'function' ? options.isStale : isStaleAt,
    requireAuthorMatchesForcedBy: Boolean(options.requireAuthorMatchesForcedBy),
    onAnomalousHeartbeat:
      typeof options.onAnomalousHeartbeat === 'function'
        ? options.onAnomalousHeartbeat
        : () => {},
    onIgnoredForcedHandoff:
      typeof options.onIgnoredForcedHandoff === 'function'
        ? options.onIgnoredForcedHandoff
        : () => {},
  };
}

export function normalizeLinkedPrReference(value: unknown): string {
  const token = String(value ?? '').trim();
  if (!token) {
    return '';
  }
  if (/^#?[1-9]\d*$/.test(token)) {
    return token.replace(/^#/, '');
  }
  try {
    const parsed = new URL(token);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return token.toLowerCase();
    }
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
      return token.toLowerCase();
    }
    const pathMatch = parsed.pathname.match(
      /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/i,
    );
    if (pathMatch) {
      return pathMatch[1];
    }
  } catch {
    // Not a URL-form linked-pr reference.
  }
  return token.toLowerCase();
}

// audit:ignore-dead-export: pending #3341's own delete decision for this export; do not duplicate that fix here
export function classifyResumeRoutingCase(
  input: {
    displacedByForcedHandoff?: boolean;
    hasActiveClaim?: boolean;
    claimOwnedBySession?: boolean;
    rebaseInProgress?: boolean;
    worktreeDirty?: boolean;
    hasUsableForcedHandoffEvidence?: boolean;
    claimAgeHours: number;
    latestActivityAgeMinutes: number;
    ciState?: string | null;
  },
  options: {
    staleHours?: number;
    stallMinutes?: number;
    pendingCiStates?: string[] | null;
    terminalSafeCiStates?: string[] | null;
  } = {},
): RouteDecision {
  const staleHours = Number.isFinite(options.staleHours)
    ? (options.staleHours as number)
    : 24;
  const stallMinutes = Number.isFinite(options.stallMinutes)
    ? (options.stallMinutes as number)
    : 30;
  const pendingCiStates = new Set(
    options.pendingCiStates ?? ['queued', 'in_progress', 'waiting', 'pending'],
  );
  const terminalSafeCiStates = new Set(
    options.terminalSafeCiStates ?? ['success', 'none'],
  );

  if (input.displacedByForcedHandoff) {
    return {
      route: 'claim-lost-stop',
      reason: 'session was displaced by trusted forced-handoff evidence',
    };
  }

  if (!input.hasActiveClaim) {
    return {
      route: 'unclaimed-reclaim-required',
      reason: 'resume requires a fresh claim before continuation',
    };
  }

  if (input.claimOwnedBySession) {
    if (input.rebaseInProgress || input.worktreeDirty) {
      return {
        route: 'crash-recovery',
        reason: 'owned claim with interrupted local state',
      };
    }
    return {
      route: 'ordinary-continuation',
      reason: 'owned claim with clean local state',
    };
  }

  if (input.hasUsableForcedHandoffEvidence) {
    return {
      route: 'forced-handoff-recovery',
      reason:
        'trusted forced-handoff evidence takes precedence over stalled-session takeover',
    };
  }

  if (!Number.isFinite(input.claimAgeHours)) {
    return {
      route: 'hold-for-evidence',
      reason: 'claim age is missing for a non-owned claim',
    };
  }

  if (!Number.isFinite(input.latestActivityAgeMinutes)) {
    return {
      route: 'hold-for-evidence',
      reason: 'activity age is missing for a non-owned active claim',
    };
  }

  const ciState = String(input.ciState ?? 'none').toLowerCase();
  if (pendingCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is still pending for the active non-owned claim',
    };
  }
  if (!terminalSafeCiStates.has(ciState)) {
    return {
      route: 'hold-for-evidence',
      reason: 'CI is not in a terminal-safe state for stalled-claim recovery',
    };
  }

  if (input.claimAgeHours < staleHours) {
    if (input.latestActivityAgeMinutes >= stallMinutes) {
      return {
        route: 'hold-for-evidence',
        reason: `non-owned claim is fresh and idle for >= ${stallMinutes}m, but still non-inheritable`,
      };
    }
    return {
      route: 'hold-for-evidence',
      reason: 'non-owned claim remains non-inheritable until stale',
    };
  }

  if (input.latestActivityAgeMinutes < stallMinutes) {
    return {
      route: 'hold-for-evidence',
      reason: `non-owned claim is stale but quiet-window evidence is < ${stallMinutes}m`,
    };
  }

  return {
    route: 'stale-claim-takeover',
    reason: `non-owned claim is stale at >= ${staleHours}h with quiet-window evidence >= ${stallMinutes}m`,
  };
}

function hasExplicitDispositionAfter(
  targetComment: CommentLike,
  comments: CommentLike[],
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): boolean {
  // Default accepts any non-bot human; an IDD-scoped predicate (when supplied)
  // restricts the disposition author so a reviewer-authored marker does not
  // count as a completed IDD disposition.
  const isDispositionAuthor =
    typeof options.isDispositionAuthor === 'function'
      ? options.isDispositionAuthor
      : (login: string) => !isKnownReviewBot(login);
  const targetTime = Date.parse(targetComment.createdAt ?? '');
  // The disposition must attribute itself to this sticky's advisory bot. Accept
  // either the product word (`CodeRabbit`) or the bot **login**
  // (`coderabbitai[bot]`) — the canonical disposition-non-review-notices output
  // names the login, which `\bCodeRabbit\b` misses (no word boundary before the
  // trailing `ai`). Naming the login reuses the same `advisoryBotIdentityToken`
  // attribution the rest of the gate relies on. Fail-closed: an unattributable
  // disposition still matches nothing.
  const targetBotLogin = String(targetComment.author?.login ?? '');
  return comments.some((comment) => {
    const author = String(comment.author?.login ?? '')
      .trim()
      .toLowerCase();
    if (
      !isDispositionAuthor(author) ||
      !isDispositionComment(comment) ||
      // #3249: an edited (or edit-state-unresolved) disposition reply never
      // counts as a completed IDD disposition here either.
      classifyCommentEditState(comment) !== 'unedited'
    ) {
      return false;
    }
    if (
      !/\bCodeRabbit\b/i.test(comment.body ?? '') &&
      !dispositionNamesAdvisoryBot(comment.body ?? '', targetBotLogin)
    ) {
      return false;
    }
    const dispositionTime = Date.parse(comment.createdAt ?? '');
    return (
      Number.isFinite(targetTime) &&
      Number.isFinite(dispositionTime) &&
      dispositionTime > targetTime
    );
  });
}

function normalizeGatingReviewTimestamp(
  review: ReviewLike,
  state: string,
): string | null {
  const submittedAt = String(review.submittedAt ?? review.submitted_at ?? '');
  if (isValidIsoTimestamp(submittedAt)) {
    return submittedAt;
  }
  if (
    state !== 'APPROVED' &&
    state !== 'CHANGES_REQUESTED' &&
    state !== 'DISMISSED'
  ) {
    return null;
  }
  const updatedAt = String(review.updatedAt ?? review.updated_at ?? '');
  if (isValidIsoTimestamp(updatedAt)) {
    return updatedAt;
  }
  return null;
}

function maxIsoTimestamp(values: unknown[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    const normalized = String(value);
    if (!isValidIsoTimestamp(normalized)) {
      continue;
    }
    if (!latest || compareIsoTimestamps(normalized, latest) > 0) {
      latest = normalized;
    }
  }
  return latest;
}

export function summarizeRequiredCheckMetadata(
  parameters: RequiredCheckParametersLike,
) {
  const names = new Set<string>();
  // #1689: the SPECIFIC subset of `names` whose rule entry is itself
  // source-pinned -- distinct from the aggregate `sourcePinned` flag below,
  // which only says "at least one pinned entry exists somewhere in this
  // parameters object." `summarizeRequiredChecks` needs the actual pinned
  // names to name the source-pinned cause in a blocker detail instead of a
  // generic "CI is not all-passing" message.
  const pinnedNames = new Set<string>();
  let sourcePinned = false;
  // #1689: true when at least one pinned entry could NOT be attributed to a
  // resolved name (no `context`/`name`/`check` at all) -- distinct from
  // `pinnedNames` being merely empty, which could also mean "no pinned
  // entry exists." A caller must fail closed on this regardless of the
  // `trustSourcePinnedRequiredChecks` opt-in: there is nothing to verify or
  // trust when there is no check name to correlate with a live run.
  let unresolvedPinned = false;
  const rawChecks = [
    ...(parameters.required_status_checks ?? []),
    ...(parameters.required_checks ?? []),
    ...(parameters.checks ?? []),
    ...(parameters.contexts ?? []),
  ];

  for (const rawCheck of rawChecks) {
    if (typeof rawCheck === 'string') {
      if (rawCheck.trim()) {
        names.add(rawCheck.trim());
      }
      continue;
    }

    const isPinned =
      isSourcePinnedRequirementId(rawCheck?.app_id) ||
      isSourcePinnedRequirementId(rawCheck?.integration_id) ||
      Boolean(rawCheck?.source);
    if (isPinned) {
      sourcePinned = true;
    }

    let resolvedName = '';
    for (const candidate of [
      rawCheck?.context,
      rawCheck?.name,
      rawCheck?.check,
      rawCheck?.integration_id ? rawCheck?.name : '',
    ]) {
      const normalized = String(candidate ?? '').trim();
      if (normalized) {
        resolvedName = normalized;
        break;
      }
    }
    if (resolvedName) {
      names.add(resolvedName);
      if (isPinned) {
        pinnedNames.add(resolvedName);
      }
    } else if (isPinned) {
      unresolvedPinned = true;
    }
  }

  return {
    names: [...names].sort(),
    sourcePinned,
    pinnedNames: [...pinnedNames].sort(),
    unresolvedPinned,
  };
}

function extractRequiredReviewerRequirement(
  reviewer: RequiredReviewerLike,
): ReviewerRequirement {
  const record = typeof reviewer === 'string' ? undefined : reviewer;
  const reviewerRef = record?.reviewer ?? {};
  const reviewerType = String(reviewerRef.type ?? record?.type ?? '')
    .trim()
    .toLowerCase();
  const reviewerId = String(reviewerRef.id ?? record?.id ?? '').trim();
  let candidate =
    typeof reviewer === 'string'
      ? reviewer
      : (record?.login ??
        reviewerRef.login ??
        record?.slug ??
        record?.team ??
        reviewerRef.slug ??
        reviewerRef.team ??
        reviewerRef.name ??
        '');
  if (!candidate && reviewerType && reviewerId) {
    candidate = `${reviewerType}/${reviewerId}`;
  }
  return {
    identity: String(candidate ?? '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase(),
    minimumApprovals:
      Number(record?.minimum_approvals ?? record?.min_approvals ?? 1) || 0,
    filePatterns: (record?.file_patterns ?? record?.filePatterns ?? [])
      .map((pattern) => String(pattern ?? '').trim())
      .filter(Boolean),
  };
}

function parseCodeownersRules(codeownersText: unknown): CodeownersRule[] {
  return String(codeownersText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const tokens = tokenizeCodeownersLine(line);
      const pattern = tokens.shift() ?? '';
      const ownerTokens: string[] = [];
      for (const token of tokens) {
        if (token.startsWith('#')) {
          break;
        }
        ownerTokens.push(token);
      }
      const users = ownerTokens
        .filter((token) => /^@[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const teams = ownerTokens
        .filter((token) => /^@[^/\s#]+\/[^/\s#]+$/.test(token))
        .map((token) => token.slice(1).toLowerCase());
      const emails = ownerTokens
        .filter((token) => /^[^@\s#][^\s#]*@[^\s#]+$/.test(token))
        .map((token) => token.toLowerCase());
      if (!pattern) {
        return null;
      }
      return { pattern, users, teams, emails };
    })
    .filter(Boolean) as CodeownersRule[];
}

function findCodeownersForPath(
  rules: CodeownersRule[],
  path: string,
): CodeownersRule | null {
  let latest: CodeownersRule | null = null;
  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, path)) {
      latest = rule;
    }
  }
  return latest;
}

function matchesCodeownersPattern(pattern: unknown, path: unknown): boolean {
  const normalizedPattern = String(pattern ?? '').trim();
  const normalizedPath = String(path ?? '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }

  let body = normalizedPattern;
  const anchored = body.startsWith('/');
  if (anchored) {
    body = body.slice(1);
  }
  const rawBody = body;
  const trailingSlashPattern = rawBody.endsWith('/');
  const lastSegment = rawBody.split('/').at(-1) ?? '';
  const anyDepthFromRoot = rawBody.startsWith('**/');
  const directoryLikePattern =
    !trailingSlashPattern &&
    !lastSegment.includes('*') &&
    !lastSegment.includes('?');

  if (trailingSlashPattern) {
    body = `${body}**`;
  }

  if (anyDepthFromRoot) {
    body = body.slice(3);
  }

  const slashAnchored =
    anchored ||
    (rawBody.includes('/') && !anyDepthFromRoot && !trailingSlashPattern);
  let source = anyDepthFromRoot || !slashAnchored ? '^(?:|.*\\/)' : '^';
  for (let index = 0; index < body.length; index += 1) {
    const triplet = body.slice(index, index + 3);
    const pair = body.slice(index, index + 2);
    if (triplet === '**/') {
      source += '(?:[^/]+/)*';
      index += 2;
      continue;
    }
    if (pair === '**') {
      source += '.*';
      index += 1;
      continue;
    }
    const character = body[index];
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(character);
  }
  if (directoryLikePattern) {
    source += '(?:/.*)?';
  }
  source += '$';

  return new RegExp(source).test(normalizedPath);
}

export function effectiveRegularCommentActivityAt(comment: {
  updatedAt?: unknown;
  createdAt: string;
}): string {
  const updatedAt = String(comment.updatedAt ?? '');
  if (
    isValidIsoTimestamp(updatedAt) &&
    compareIsoTimestamps(updatedAt, comment.createdAt) > 0
  ) {
    return updatedAt;
  }
  return comment.createdAt;
}

function isSourcePinnedRequirementId(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0;
}

function tokenizeCodeownersLine(line: unknown): string[] {
  const tokens: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of String(line ?? '')) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (escaped) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function hasCodeownerOwners(rule: CodeownersRule | null | undefined): boolean {
  return (
    (rule?.users?.length ?? 0) > 0 ||
    (rule?.teams?.length ?? 0) > 0 ||
    (rule?.emails?.length ?? 0) > 0
  );
}

// True when a PR-author login belongs to a gate-relevant advisory bot — a known
// review bot (CodeRabbit/Codex/Copilot defaults) or a configured
// `advisoryBotLogins` entry. The GitHub `[bot]` suffix is normalized
// symmetrically via `advisoryBotIdentityToken` on both the incoming login and
// each configured entry, so a custom bot matches whether the config or the
// author login stores the suffixed (`my-bot[bot]`) or suffixless (`my-bot`)
// form. Fail-closed on an empty token.
export function isGateAdvisoryBotLogin(
  login: unknown,
  advisoryBotLogins: Set<string>,
): boolean {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  return (
    isKnownReviewBot(token) ||
    isConfiguredAdvisoryBotLogin(login, advisoryBotLogins)
  );
}

// True when a login matches a **configured** `advisoryBotLogins` entry, with the
// GitHub `[bot]` suffix normalized symmetrically via `advisoryBotIdentityToken`
// on both the incoming login and each configured entry — so a custom bot matches
// whether either side stores the suffixed (`my-bot[bot]`) or suffixless
// (`my-bot`) form. Unlike `isGateAdvisoryBotLogin`, this does **not** also match
// `isKnownReviewBot`: the advisory courtesy-ack carve-outs must recognize only
// configured advisory bots, so a Copilot/known-review-bot ack is never
// reclassified as a configured-advisory-bot ack. Fail-closed on an empty token.
export function isConfiguredAdvisoryBotLogin(
  login: unknown,
  advisoryBotLogins: Set<string>,
): boolean {
  const token = advisoryBotIdentityToken(login);
  if (!token) {
    return false;
  }
  for (const configured of advisoryBotLogins) {
    if (advisoryBotIdentityToken(configured) === token) {
      return true;
    }
  }
  return false;
}

// #3267: the former `_isOperationalOrDigestComment` (unused) and
// `isOperationalOrDigestCommentForGate` (used by
// `summarizeRegularCommentsForGate` / `summarizeDispositionEvidenceForGate`)
// are replaced by the shared `classifyIddPrComment` -- see its doc comment
// for the unified rule, including the historical/repair-evidence digest
// forms and the narrow `github-actions[bot]` recognition neither of these
// two functions had.

function buildBodyPreview(body: unknown): string {
  return firstLine(String(body ?? '')).slice(0, 120);
}

// #3338: delegates to the shared `parseAdvisoryWaitFamilyMarker` grammar
// (marker-helpers.mts) instead of a hand-copied `[^ ]`-spaced regex trio,
// so a canonical-but-differently-spaced marker (double space, tab,
// trailing whitespace, fractional seconds, `<!--advisory-wait:`) is
// recognized the same way `OPERATIONAL_MARKERS` recognizes it.
// `advisory-reroll:` is deliberately excluded from same-HEAD detection --
// unchanged from this function's pre-#3338 behavior, which never matched
// that prefix either.
function advisoryWaitMarkerMatchesHead(
  body: string,
  prHeadSha: string,
): boolean {
  const parsed = parseAdvisoryWaitFamilyMarker(body);
  return (
    parsed !== null &&
    parsed.family !== 'advisory-reroll' &&
    parsed.headSha === String(prHeadSha).trim().toLowerCase()
  );
}

// #3338: prefix-only (not full-grammar-valid), matching this function's
// pre-#3338 behavior -- a field-invalid body (e.g. a `pending` timestamp
// placeholder) still counts toward `requestMarkerCount`, which bounds the
// re-request cap regardless of whether the rest of the marker parses.
// Delegates to the shared `advisoryWaitFamilyMarkerStart` byte-0-anchored
// predicate (marker-helpers.mts) instead of its own `<!-- advisory-wait:`
// exact-single-space literal, so the HTML spacing variants count too.
function advisoryWaitRequestMarker(body: string): boolean {
  const family = advisoryWaitFamilyMarkerStart(body);
  return family === 'advisory-wait' || family === 'advisory-wait-html';
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function minutesBetweenIso(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
}

export function compareIsoTimestamps(left: unknown, right: unknown): number {
  const leftComparable = normalizeComparableTimestamp(left);
  const rightComparable = normalizeComparableTimestamp(right);
  if (
    typeof leftComparable === 'number' &&
    typeof rightComparable === 'number'
  ) {
    if (leftComparable !== rightComparable) {
      return leftComparable - rightComparable;
    }
    return String(left ?? '').localeCompare(String(right ?? ''));
  }
  if (typeof leftComparable === 'number') {
    return 1;
  }
  if (typeof rightComparable === 'number') {
    return -1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''));
}

// kurone-kito/idd-skill#3259: requires the FULL canonical `review-ack:`
// marker shape -- a valid trailing ISO-8601 timestamp, end-anchored --
// matching the `review-ack:` entry in `OPERATIONAL_MARKERS`
// (marker-helpers.mts) exactly, so a malformed or truncated comment never
// counts as a valid ack. Moved here verbatim from `advisory-convergence.mts`
// (originally #2050 / #2056) so a second caller
// (`merged-pr-feedback-sweep.mts`) can reuse the SAME `review-ack:`
// validity check the real `idd-advisory-convergence` gate already uses,
// instead of a second ad-hoc marker-matching implementation that could
// drift out of sync with it; `advisory-convergence.mts` now delegates to
// {@link hasTrustedReviewAckAfter} below. Group 1 is the embedded commit
// SHA (compared against the caller-supplied `commitSha`) and group 2 is
// the embedded timestamp (validated with `isValidIsoTimestamp` -- the bare
// digit-shape match alone accepts a syntactically-digit-shaped but
// semantically invalid calendar date/time, e.g. `2026-99-99T99:99:99Z`).
const REVIEW_ACK_MARKER_PATTERN =
  /^review-ack:\s+\S+\s+([0-9a-f]{40})\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/;

/**
 * kurone-kito/idd-skill#3259 (moved verbatim from `advisory-convergence.mts`,
 * originally #2050 / #2056): `true` when a trusted `review-ack:` marker
 * exists among `comments` whose OWN GitHub-assigned `created_at` (never an
 * embedded, agent-supplied timestamp -- the same "clock anchor is marker
 * created_at, not embedded text" trust boundary `hasFreshDisposition`
 * above and `summarizeSameHeadRerollMarkers` (advisory-convergence.mts)
 * both already apply) is strictly after `reviewSubmittedAt`, AND whose
 * embedded commit SHA equals `commitSha` (the same same-commit filter
 * `summarizeSameHeadRerollMarkers` already applies to `advisory-reroll`
 * markers against the PR's current HEAD -- callers needing that exact
 * semantics pass the PR's HEAD sha here; a caller acknowledging a
 * SPECIFIC review's own reviewed commit, such as
 * `merged-pr-feedback-sweep.mts`, passes that review's own commit sha
 * instead).
 *
 * The `createdAt > reviewSubmittedAt` ordering still invalidates a
 * pre-existing ack when a later review lands (same commit or not, e.g. an
 * AW6 same-HEAD reroll). The SHA check closes the delayed-POST race the
 * ordering check cannot: a marker that embedded commit A can still
 * receive a GitHub `createdAt` after review B's `submittedAt` if the PR
 * advanced between render and POST.
 *
 * Fails closed (returns `false`) when `reviewSubmittedAt` is missing or
 * invalid, or when `commitSha` is empty, since there is then no anchor to
 * compare an ack against -- the safe direction for every known caller: an
 * unresolved anchor means the finding stays reported / the clause stays
 * unsatisfied, never silently cleared.
 *
 * `trustedMarkerLogins` must already be normalized (trimmed, lower-cased)
 * by the caller, matching every other trusted-login-set consumer in this
 * file.
 */
export function hasTrustedReviewAckAfter(
  comments: CommentLike[],
  trustedMarkerLogins: string[],
  reviewSubmittedAt: string,
  commitSha: string,
): boolean {
  if (!isValidIsoTimestamp(reviewSubmittedAt) || !commitSha) {
    return false;
  }
  const trusted = new Set(trustedMarkerLogins);
  return comments.some((comment) => {
    const body = String(comment.body ?? '').trimEnd();
    const match = body.match(REVIEW_ACK_MARKER_PATTERN);
    // Group 1 = embedded commit SHA, group 2 = embedded timestamp. The
    // timestamp is otherwise never trusted for the createdAt-vs-
    // reviewSubmittedAt comparison below, but a marker whose OWN
    // digit-shaped field is not a real calendar date/time is malformed --
    // reject it here the same way `detectMalformedOperationalMarker`
    // (marker-helpers.mts) rejects other structurally-invalid markers.
    if (!match || match[1] !== commitSha || !isValidIsoTimestamp(match[2])) {
      return false;
    }
    const login = String(comment.author?.login ?? comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    // #3249: an edited (or edit-state-unresolved) `review-ack:` marker must
    // never satisfy this gate, even from a trusted login.
    if (
      !trusted.has(login) ||
      classifyCommentEditState(comment) !== 'unedited'
    ) {
      return false;
    }
    // GitHub server `createdAt`/`created_at` ONLY -- never the marker's own
    // embedded (agent-supplied) timestamp field, same anchor rule AW2
    // already states for `advisory-wait:`.
    const createdAt = String(comment.createdAt ?? comment.created_at ?? '');
    return (
      isValidIsoTimestamp(createdAt) &&
      compareIsoTimestamps(createdAt, reviewSubmittedAt) > 0
    );
  });
}

function threadActivityAt(thread: ThreadLike): string | null | undefined {
  if (isValidIsoTimestamp(thread.updatedAt ?? '')) {
    return thread.updatedAt;
  }

  const commentTimes = (thread.comments?.nodes ?? [])
    .flatMap((comment) => [comment.updatedAt, comment.createdAt])
    .filter(isValidIsoTimestamp);

  return maxIsoTimestamp(commentTimes);
}

// #3269: matches any HTML comment, including a multi-line one (e.g. the
// `<!--\n<consolidated_sites>...\n-->` block real CodeRabbit review-thread
// replies carry) -- `[\s\S]*?` (not `.*?`) so `.` crossing a newline is not
// needed, and non-greedy so consecutive comments extract as separate
// entries rather than one span from the first `<!--` to the last `-->`.
const THREAD_COMMENT_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// #3269: the ONLY allowlisted append onto an otherwise-unchanged visible
// text -- CodeRabbit's own resolve-attempt line, singular or plural
// commit-range form (real samples: kurone-kito/idd-skill PR #3160 comment
// `4056226337` appends "Addressed in commit 28c18a9"; PR #3154 comment
// `4053784487` appends "Addressed in commits aa13fb1 to fda04e3"). Allows
// leading/trailing blank lines (CRLF-tolerant) around the one resolution
// line, but nothing else.
const APPENDED_RESOLUTION_SUFFIX_RE =
  /^(?:\r?\n)*✅ Addressed in commits? [0-9a-f]{7,40}(?: to [0-9a-f]{7,40})?(?:\r?\n)*$/;

// #3269 (Copilot review, PR #3430): a single-byte placeholder standing in
// for one whole HTML comment, used by `commentPositionSkeleton` below.
// Fully REMOVING each comment (an earlier revision of this function did)
// loses WHERE each comment sat relative to the surrounding visible text
// and to every other comment; replacing each with this fixed token
// instead preserves that position while still hiding the comment's own
// (allowlisted-substitutable) content. `\u0000` cannot appear in a real
// GitHub comment body, so it can never collide with genuine content.
const HTML_COMMENT_POSITION_PLACEHOLDER = '\u0000';

/** #3269: `body` with each HTML comment replaced by
 * {@link HTML_COMMENT_POSITION_PLACEHOLDER} -- see
 * {@link commentPositionSkeleton}'s own doc comment for why position is
 * preserved rather than the comment being removed outright.
 *
 * Not an HTML/output sanitizer (CodeQL's `js/incomplete-sanitization`
 * flagged an earlier, fully-removing revision of this function on PR
 * #3430; the same reasoning applies to this replace-with-placeholder
 * form): the result is compared with `===` / `String.prototype.
 * startsWith` inside {@link isVisibleTextAppendOnly} below and never
 * rendered, concatenated into markup, or otherwise reaches an HTML/DOM
 * sink, so an unclosed `<!--` surviving a single pass carries no
 * injection risk here -- it only ever changes which internal dating
 * branch a GraphQL-fetched bot comment's revision history takes. */
function commentPositionSkeleton(body: string): string {
  return String(body ?? '').replace(
    THREAD_COMMENT_HTML_COMMENT_RE,
    HTML_COMMENT_POSITION_PLACEHOLDER,
  );
}

/**
 * #3269: `true` when `currBody`'s visible text either equals `prevBody`'s,
 * or extends it with nothing but the allowlisted resolution line above.
 * Deliberately an exact-prefix (`startsWith`) check, not a trimmed/
 * normalized comparison: the issue's own condition is "equals the
 * previous revision's visible text, optionally followed by ... one
 * appended resolution line", and comparing anything less exact would
 * also accept a substantive mid-body edit that happens to leave the same
 * trailing bytes. Compares {@link commentPositionSkeleton} (HTML
 * comments placeholder'd, not removed) rather than the fully-stripped
 * text (Copilot review, PR #3430): a plain "strip everything" comparison
 * cannot tell a comment that moved to a different position from one that
 * did not, since removing every comment collapses both to the same
 * result -- the placeholder preserves that position as part of THIS
 * check, so {@link isOnlyAllowlistedMarkerCommentDiff}'s own by-position
 * comment-content comparison can safely assume position alignment once
 * this check has already passed.
 */
function isVisibleTextAppendOnly(prevBody: string, currBody: string): boolean {
  const prevSkeleton = commentPositionSkeleton(prevBody);
  const currSkeleton = commentPositionSkeleton(currBody);
  if (currSkeleton === prevSkeleton) {
    return true;
  }
  if (!currSkeleton.startsWith(prevSkeleton)) {
    return false;
  }
  const remainder = currSkeleton.slice(prevSkeleton.length);
  return APPENDED_RESOLUTION_SUFFIX_RE.test(remainder);
}

// #3269: CodeRabbit's own hidden reply-vs-comment marker, exactly as
// observed live (kurone-kito/idd-skill PR #3160/#3154/#3196) -- an
// original finding's marker HTML comment is rewritten from this exact
// "comment" form to this exact "reply" form once CodeRabbit treats the
// finding as replied-to, with no other change to that one HTML comment.
// Deliberately directional (never normalize both forms to one before
// comparing): a hypothetical reply-to-comment rewrite is NOT the same
// allowlisted, one-way substitution the issue names.
const CODERABBIT_COMMENT_MARKER =
  '<!-- This is an auto-generated comment by CodeRabbit -->';
const CODERABBIT_REPLY_MARKER =
  '<!-- This is an auto-generated reply by CodeRabbit -->';

/**
 * #3269: `true` when every HTML comment in `prevBody` and `currBody`
 * matches 1:1 by position, except that any differing pair is EXACTLY the
 * allowlisted CodeRabbit comment-to-reply marker substitution above.
 * Comparing extracted comments in isolation (not just stripping them
 * before comparing visible text, as {@link isVisibleTextAppendOnly}
 * already does) matters here: stripping hides ANY comment-content change,
 * so relying on visible-text equality alone would also treat an
 * arbitrary hidden-comment rewrite as cosmetic. A comment COUNT mismatch
 * (one added or removed) is never allowlisted.
 */
function isOnlyAllowlistedMarkerCommentDiff(
  prevBody: string,
  currBody: string,
): boolean {
  const prevComments =
    String(prevBody ?? '').match(THREAD_COMMENT_HTML_COMMENT_RE) ?? [];
  const currComments =
    String(currBody ?? '').match(THREAD_COMMENT_HTML_COMMENT_RE) ?? [];
  if (prevComments.length !== currComments.length) {
    return false;
  }
  for (let index = 0; index < prevComments.length; index += 1) {
    if (prevComments[index] === currComments[index]) {
      continue;
    }
    if (
      prevComments[index] === CODERABBIT_COMMENT_MARKER &&
      currComments[index] === CODERABBIT_REPLY_MARKER
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** #3269: outcome of {@link resolveThreadCommentRevisionDatingOutcome}. */
type ThreadCommentRevisionDatingOutcome =
  | { kind: 'unverifiable' }
  | { kind: 'all-cosmetic' }
  | { kind: 'dated'; at: string };

/**
 * #3269: walks `comment.userContentEdits.edits` in chronological
 * (oldest-first) order and classifies each transition against its
 * immediately preceding revision as "verified cosmetic" per the issue's
 * exact three-condition definition:
 * - the transition's editor equals `authorLogin` (the comment's own
 *   author -- the caller already confirmed that author is a configured
 *   advisory bot before calling this, since only a bot's OWN edit of its
 *   OWN comment can ever be cosmetic in this sense);
 * - {@link isVisibleTextAppendOnly} between the two revisions;
 * - {@link isOnlyAllowlistedMarkerCommentDiff} between the two revisions.
 *
 * Returns `'all-cosmetic'` when every transition qualifies (dating stays
 * `createdAt`), `'dated'` with the LAST transition that failed
 * (dating is that revision's own `editedAt`), or `'unverifiable'` when
 * the history itself cannot be trusted -- absent/empty, `totalCount`
 * disagreeing with the fetched page (an incomplete history), fewer than
 * two revisions for a comment GitHub reports as edited, ANY revision's
 * `editedAt` failing to parse, a deleted or `null`-body revision anywhere
 * in the chain, or the chronologically newest revision's own body not
 * exactly matching the separately-fetched `comment.body` (the two reads
 * can observe different instants -- Copilot review, PR #3430).
 * `'unverifiable'` always means "keep today's `updatedAt` dating" to the
 * caller -- never treated as `'all-cosmetic'`, the same fail-closed
 * direction `classifyCommentEditState` documents for its own `'unknown'`
 * state.
 */
function resolveThreadCommentRevisionDatingOutcome(
  comment: ThreadCommentLike,
  authorLogin: string,
): ThreadCommentRevisionDatingOutcome {
  const history = comment.userContentEdits;
  const edits = history?.edits;
  if (!history || !Array.isArray(edits) || edits.length < 2) {
    return { kind: 'unverifiable' };
  }
  const totalCount = history.totalCount;
  if (typeof totalCount !== 'number' || totalCount !== edits.length) {
    return { kind: 'unverifiable' };
  }
  // Copilot review, PR #3430: every revision's `editedAt` must be a
  // parseable timestamp BEFORE sorting/classifying, not only checked
  // opportunistically inside the loop below when a transition happens to
  // be classified non-cosmetic. A malformed/null `editedAt` on a
  // revision whose transition happens to LOOK cosmetic (same body,
  // editor, marker as its predecessor) would otherwise never be
  // rejected at all, and could also corrupt the chronological sort
  // order used to evaluate every other transition -- fail closed here
  // instead of trusting a partially-malformed history.
  if (edits.some((edit) => !isValidIsoTimestamp(edit?.editedAt ?? ''))) {
    return { kind: 'unverifiable' };
  }
  // Connection order is newest-edit-first by convention
  // (`ProviderPort.getReviewThreadCommentUserContentEdits`'s own doc
  // comment), but a caller (a hand-built test fixture, in particular)
  // must never be trusted to preserve that order -- sort explicitly by
  // `editedAt` ascending (oldest/creation revision first). Every
  // `editedAt` is already confirmed parseable above.
  const chronological = [...edits].sort(
    (left, right) =>
      Date.parse(String(left.editedAt)) - Date.parse(String(right.editedAt)),
  );
  // Copilot review, PR #3430: `comment.body` and `comment.userContentEdits`
  // come from two SEPARATE fetches (the thread-comments read and the
  // bounded edit-history read) that are never guaranteed to observe the
  // exact same instant -- if the comment was edited again between them,
  // the fetched history's own newest revision could be stale relative to
  // the CURRENT body this dating decision is actually about. Classifying
  // a stale-but-internally-consistent history as all-cosmetic would then
  // silently ignore a real edit neither fetch's snapshot alone reveals.
  // Require the chronologically newest revision's own `diff` to exactly
  // match the fetched `comment.body` before trusting the history at all.
  const newestRevision = chronological[chronological.length - 1];
  if (
    typeof newestRevision?.diff !== 'string' ||
    newestRevision.diff !== String(comment.body ?? '')
  ) {
    return { kind: 'unverifiable' };
  }
  let prevBody: string | null = null;
  let lastNonCosmeticAt: string | null = null;
  for (const edit of chronological) {
    if (edit == null || edit.deletedAt != null) {
      return { kind: 'unverifiable' };
    }
    if (typeof edit.diff !== 'string') {
      return { kind: 'unverifiable' };
    }
    if (prevBody !== null) {
      // Copilot review, PR #3430: normalize through the same
      // `[bot]`-suffix-tolerant identity token every other
      // advisory-bot-login comparison in this file already uses
      // (`isConfiguredAdvisoryBotLogin` above) -- a raw lowercase
      // comparison would silently reject every otherwise-valid
      // cosmetic revision if GraphQL ever returns `editor.login` and
      // `author.login` in different spellings for the same bot
      // identity.
      const editorToken = advisoryBotIdentityToken(edit.editorLogin);
      const cosmetic =
        editorToken !== '' &&
        editorToken === advisoryBotIdentityToken(authorLogin) &&
        isVisibleTextAppendOnly(prevBody, edit.diff) &&
        isOnlyAllowlistedMarkerCommentDiff(prevBody, edit.diff);
      if (!cosmetic) {
        // `edit.editedAt` was already confirmed parseable above.
        lastNonCosmeticAt = String(edit.editedAt);
      }
    }
    prevBody = edit.diff;
  }
  return lastNonCosmeticAt
    ? { kind: 'dated', at: lastNonCosmeticAt }
    : { kind: 'all-cosmetic' };
}

/**
 * Content-activity dating for one review-thread comment, shared by
 * `hasFreshDisposition` and every diagnostic below it. Pre-#3269, this
 * always preferred `updatedAt` (falling back to `createdAt`) -- but
 * `updatedAt` also moves without any content edit (e.g. IDD's own
 * hide-on-supersede minimization, kurone-kito/idd-skill#3173). #3269
 * dates by content activity instead, using `classifyCommentEditState`'s
 * three-state `lastEditedAt` contract:
 * - `'unedited'` (an explicit `lastEditedAt: null`): `createdAt` -- the
 *   comment was never body-edited, so `updatedAt` cannot reflect a real
 *   content change;
 * - `'edited'`: the time of the comment's own last revision that was NOT
 *   a verified cosmetic edit (`resolveThreadCommentRevisionDatingOutcome`
 *   above), which is `createdAt` when every revision was cosmetic --
 *   ONLY when `comment.userContentEdits` is populated AND `comment`'s
 *   author is a configured advisory bot (`advisoryBotLogins`); otherwise
 *   falls back to `updatedAt`, unchanged from today;
 * - `'unknown'` (absent/unparseable `lastEditedAt`): `updatedAt`,
 *   unchanged from today.
 *
 * `advisoryBotLogins` defaults to an empty set, so a caller that omits it
 * (every caller outside the two merge-gate collectors' own
 * disposition-evidence path) never verifies an edited comment as
 * cosmetic, regardless of what `userContentEdits` data happens to be
 * attached -- fail-closed defense in depth, matching the issue's own
 * negative test for "an allowlisted append on a comment by an author who
 * is not an advisory bot".
 */
function effectiveThreadCommentActivityAt(
  comment: ThreadCommentLike | null | undefined,
  advisoryBotLogins: Set<string> = new Set(),
): string {
  if (comment == null) {
    return '';
  }
  const updatedAt = String(comment.updatedAt ?? '');
  const validUpdatedAt = isValidIsoTimestamp(updatedAt) ? updatedAt : '';
  const createdAt = String(comment.createdAt ?? '');
  const validCreatedAt = isValidIsoTimestamp(createdAt) ? createdAt : '';
  const fallback = validUpdatedAt || validCreatedAt;
  const editState = classifyCommentEditState(comment);
  if (editState === 'unedited') {
    return validCreatedAt || validUpdatedAt;
  }
  if (editState !== 'edited') {
    // 'unknown': lastEditedAt absent/unparseable -- keep today's dating.
    return fallback;
  }
  const authorLogin = String(comment.author?.login ?? '')
    .trim()
    .toLowerCase();
  if (!isConfiguredAdvisoryBotLogin(authorLogin, advisoryBotLogins)) {
    return fallback;
  }
  const outcome = resolveThreadCommentRevisionDatingOutcome(
    comment,
    authorLogin,
  );
  if (outcome.kind === 'all-cosmetic') {
    return validCreatedAt || validUpdatedAt;
  }
  if (outcome.kind === 'dated' && isValidIsoTimestamp(outcome.at)) {
    return outcome.at;
  }
  return fallback;
}

function hasCompletedBotThreadDispositions(
  threads: ThreadLike[],
  loginPredicate: (login: string) => boolean,
  options: { isDispositionAuthor?: (login: string) => boolean } = {},
): boolean {
  const botThreads = threads.filter((thread) => {
    return (thread.comments?.nodes ?? []).some((comment) => {
      return (
        loginPredicate(comment.author?.login ?? '') &&
        !isDispositionComment(comment)
      );
    });
  });

  return (
    botThreads.length > 0 &&
    botThreads.every((thread) => {
      return (
        thread.isResolved &&
        !thread.comments?.pageInfo?.hasNextPage &&
        hasFreshDisposition(thread, {
          isDispositionAuthor: options.isDispositionAuthor,
        })
      );
    })
  );
}

function hasUnresolvedKnownBotThreads(threads: ThreadLike[]): boolean {
  return threads.some((thread) => {
    if (thread.isResolved) {
      return false;
    }
    if (thread.comments?.pageInfo?.hasNextPage) {
      return true;
    }
    return (thread.comments?.nodes ?? []).some((comment) => {
      return isKnownReviewBot(comment.author?.login ?? '');
    });
  });
}

export function isCompletedCiTimestamp(value: unknown): boolean {
  const timestamp = String(value ?? '');
  return timestamp !== '0001-01-01T00:00:00Z' && isValidIsoTimestamp(timestamp);
}

function normalizeComparableTimestamp(value: unknown): number | 'none' | null {
  const normalized = String(value ?? 'none');
  if (normalized === 'none') {
    return 'none';
  }
  if (!isValidIsoTimestamp(normalized)) {
    return null;
  }
  return Date.parse(normalized);
}
