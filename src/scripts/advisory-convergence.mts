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
//   - `isCopilotReviewerLogin` / `readAdvisoryPrimaryBotLogin` /
//     `resolveAdvisoryPrimaryBotLogin` -- Copilot identity resolution.
//   - `resolveAdvisoryBotLogins`, `resolveTrustedMarkerActors` -- the same
//     trust/identity resolution every other helper uses.
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

import {
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
} from './advisory-wait-policy.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mts';
import {
  GH_TEXT_LOOP_OPTIONS,
  type GhTextOptions,
  ghApiJson,
  ghText,
  safeGhText,
} from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import { isValidIsoTimestamp } from './marker-helpers.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mts';
import type { PrCommitPayload } from './protocol-helpers.mts';
import {
  DEFAULT_STALE_AGE_MS,
  isCopilotReviewerLogin,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
  resolvePrFirstCommitAt,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
  summarizeDispositionEvidenceForGate,
  summarizeExternalCheckWaivers,
} from './protocol-helpers.mts';

/** The external-check-waiver selector this gate recognizes (documented in
 * docs/idd-helper-scripts.md and docs/policy-constants.md; #1341's required
 * check is expected to register under the same name). */
export const ADVISORY_CONVERGENCE_CHECK_SELECTOR = 'idd-advisory-convergence';

/** Author reference embedded in GitHub REST/GraphQL payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

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

/** PR review payload, normalized from the GraphQL `reviews` connection. */
interface ReviewPayload {
  author?: GhAuthorPayload | null;
  submittedAt?: string | null;
  commitId?: string | null;
  itemCount?: number | null;
}

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

/** Latest-review clause evidence (Clause 1 of the `converged` definition). */
export interface AdvisoryConvergenceReviewClause {
  found: boolean;
  commitId: string;
  matchesHead: boolean;
  itemCount: number | null;
  submittedAt: string;
  satisfied: boolean;
}

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

/** Full JSON verdict document printed by this CLI. */
export interface AdvisoryConvergenceVerdict {
  protocolVersion: '1';
  decisionAuthority: 'instructions';
  prNumber: number;
  prHeadSha: string;
  now: string;
  primaryBotLogin: string;
  review: AdvisoryConvergenceReviewClause;
  threads: AdvisoryConvergenceThreadClause;
  pending: boolean;
  deadline: AdvisoryConvergenceDeadline;
  waiver: AdvisoryConvergenceWaiver;
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
}

/** Pure options accepted by {@link computeAdvisoryConvergenceVerdict}. */
export interface AdvisoryConvergenceOptions {
  now: string;
  primaryBotLogin?: string;
  trustedMarkerLogins?: unknown[] | null;
  advisoryBotLogins?: unknown[] | null;
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
  /** The configured `ciGate.externalChecks.waivable` selector list. A
   * waiver only counts when its own selector overlaps one of these
   * entries -- see the waiver escape-hatch computation below. */
  waivableSelectors?:
    | readonly { selector: string; matchMode?: string }[]
    | null;
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

  // --- Clause 1: latest Copilot review is clean on the current HEAD -----
  const review = resolveLatestCopilotReviewClause(
    reviews,
    prHeadSha,
    primaryBotLogin,
  );
  const pending = !review.matchesHead;
  if (pending) {
    reasons.push(
      review.found
        ? `latest ${primaryBotLogin} review (commit ${review.commitId || '<unknown>'}) does not cover current HEAD ${prHeadSha}`
        : `${primaryBotLogin} has not reviewed this pull request yet`,
    );
  } else if (!review.satisfied) {
    reasons.push(
      review.itemCount === null
        ? `latest ${primaryBotLogin} review on current HEAD carries an unknown number of actionable items (comment count unavailable)`
        : `latest ${primaryBotLogin} review on current HEAD carries ${review.itemCount} actionable item(s)`,
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
  if (!threadClause.satisfied) {
    reasons.push(
      `${threadClause.blockingCount} ${primaryBotLogin}-authored review thread(s) are neither resolved nor validly dispositioned: ${threadClause.blockingIds.join(', ')}`,
    );
  }

  const converged = !pending && review.satisfied && threadClause.satisfied;

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

  // --- Waiver escape hatch (only reachable once the deadline has passed) -
  const waiverMode = String(options.waiverMode ?? 'disabled');
  const waiverCheckSelector =
    String(options.waiverCheckSelector ?? '').trim() ||
    ADVISORY_CONVERGENCE_CHECK_SELECTOR;
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
  let validWaiverCount = 0;
  if (!converged && deadlinePassed && waiverMode === 'maintainer-authorized') {
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
  const waived = validWaiverCount > 0;
  if (!converged && deadlinePassed && !waived) {
    reasons.push(
      waiverMode === 'maintainer-authorized'
        ? `deadline (${deadlineMinutes}m) passed with no valid maintainer external-check waiver for selector "${waiverCheckSelector}" on current HEAD`
        : `deadline (${deadlineMinutes}m) passed and no waiver is available (ciGate.externalCheckWaivers.mode is "${waiverMode}", not "maintainer-authorized")`,
    );
  }

  const ready = converged || (deadlinePassed && waived);

  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    prNumber: inputs.prNumber,
    prHeadSha,
    now,
    primaryBotLogin,
    review,
    threads: threadClause,
    pending,
    deadline,
    waiver,
    converged,
    waived,
    ready,
    reasons,
  };
}

/** Evaluate Clause 1 against the single, absolute-latest Copilot review --
 * per the issue's literal wording ("the latest Copilot review's commit_id
 * equals current HEAD"), not "the latest review among those that happen to
 * target current HEAD". Those two differ when Copilot's most recent
 * activity targets a commit other than the current HEAD (e.g. an unusual
 * force-push/revert ordering, see PR #1343 review): only looking within
 * on-HEAD reviews could report `matchesHead: true` off a stale earlier
 * review while ignoring what Copilot's true latest signal actually says.
 * This simpler form still correctly handles a legitimate re-request
 * without a new push (this repo's own AW3 `REQUEST_NEEDED` flow, where a
 * later review supersedes an earlier dirty one on the *same* commit): the
 * absolute latest naturally IS that later, superseding review when both
 * target the current HEAD. "Latest" is fetch order, not `submittedAt`:
 * GitHub's GraphQL `reviews` connection returns reviews in submission
 * order, the same assumption this file's own `fetchThreadCommentPages` /
 * `fetchReviewThreads` already rely on (they append paginated results
 * without ever re-sorting). This deliberately does NOT sort by
 * `submittedAt` the way `findLastCopilotReviewCommit` does elsewhere in
 * this codebase (protocol-helpers.mts) -- that timestamp-sort approach is
 * exactly the footgun being avoided here: `submittedAt` can be missing or
 * invalid on a real payload (the field is nullable) and would otherwise
 * let an earlier, differently-ordered review win by comparator accident. */
function resolveLatestCopilotReviewClause(
  reviews: ReviewPayload[],
  prHeadSha: string,
  primaryBotLogin: string,
): AdvisoryConvergenceReviewClause {
  const latest = reviews
    .filter((review) =>
      isCopilotReviewerLogin(review.author?.login ?? '', primaryBotLogin),
    )
    .at(-1);
  if (!latest) {
    return {
      found: false,
      commitId: '',
      matchesHead: false,
      itemCount: null,
      submittedAt: '',
      satisfied: false,
    };
  }
  const commitId = String(latest.commitId ?? '').toLowerCase();
  const matchesHead = commitId === prHeadSha;
  const itemCount = matchesHead
    ? Number.isFinite(latest.itemCount)
      ? Number(latest.itemCount)
      : null
    : null;
  return {
    found: true,
    commitId,
    matchesHead,
    itemCount,
    submittedAt: String(latest.submittedAt ?? ''),
    satisfied: matchesHead && itemCount === 0,
  };
}

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
      isCopilotReviewerLogin(originating.author?.login ?? '', primaryBotLogin)
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

export function parseArgs(argv: string[]): AdvisoryConvergenceArgs {
  const parsed: AdvisoryConvergenceArgs = {
    prNumber: null,
    owner: '',
    repo: '',
    claimIssueNumber: null,
    trustedMarkerLogins: '',
    advisoryBotLogins: '',
    now: '',
    assert: false,
    help: false,
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
    if (token === '--claim-issue') {
      parsed.claimIssueNumber = Number.parseInt(value ?? '', 10);
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
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--assert') {
      parsed.assert = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }
  if (
    !Number.isInteger(parsed.claimIssueNumber) ||
    (parsed.claimIssueNumber ?? 0) < 1
  ) {
    parsed.claimIssueNumber = null;
  }

  return parsed;
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
      'headRefOid,closingIssuesReferences,author,url',
    ]),
  ) as {
    headRefOid?: unknown;
    closingIssuesReferences?: ClosingIssueRefPayload[] | null;
    author?: GhAuthorPayload | null;
    url?: unknown;
  };
  const prHeadSha = String(pr.headRefOid ?? '').toLowerCase();
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

  const claimEvents = pickResolvingClaimEvents(
    claimCandidates,
    trustedMarkerLogins,
    Boolean(args.claimIssueNumber),
  );

  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const deadlineMinutes = readAdvisoryConvergenceDeadlineMinutes();
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
    },
    options: {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      primaryBotLogin,
      trustedMarkerLogins,
      advisoryBotLogins,
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
 * claim can bind unambiguously), same as before #1344/#1347.
 */
export function pickResolvingClaimEvents(
  candidates: IssueCommentPayload[][],
  trustedMarkerLogins: string[],
  isExplicit: boolean,
): IssueCommentPayload[] {
  if (isExplicit) {
    return candidates[0] ?? [];
  }
  const resolving = candidates.filter((comments) =>
    Boolean(
      summarizeClaimValidation(comments, { trustedMarkerLogins })
        .activeClaimPresent,
    ),
  );
  return resolving.length === 1 ? resolving[0] : [];
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

function ghGraphql(
  query: string,
  variables: Record<string, string | number | null | undefined>,
): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      args.push('-F', `${key}=${value}`);
      continue;
    }
    args.push('-f', `${key}=${value}`);
  }
  return JSON.parse(ghText(args).trim() || '{}');
}

interface RawReviewNode {
  commit?: { oid?: string | null } | null;
  submittedAt?: string | null;
  author?: GhAuthorPayload | null;
  comments?: { totalCount?: number | null } | null;
}

function fetchReviewsAndHeadCommit(
  owner: string,
  repo: string,
  prNumber: number,
): { reviews: ReviewPayload[]; headCommittedAt: string } {
  const nodes: RawReviewNode[] = [];
  let headCommittedAt = '';
  let cursor: string | null | undefined = null;

  // Paginate `reviews` the same way `fetchReviewThreads` paginates
  // `reviewThreads` below: a PR with more than one page of reviews would
  // otherwise silently evaluate Clause 1 against only the first 100,
  // potentially missing a later, dirty, current-HEAD review (see PR #1343
  // review). `commits(last: 1)` is fetched once, on the first page, since
  // it never changes across pages.
  while (true) {
    const payload = ghGraphql(
      `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  commit { oid }
                  submittedAt
                  author { login }
                  comments { totalCount }
                }
              }
              commits(last: 1) {
                nodes { commit { committedDate } }
              }
            }
          }
        }`,
      { owner, repo, number: prNumber, cursor },
    ) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviews?: {
              pageInfo?: PageInfoPayload | null;
              nodes?: RawReviewNode[] | null;
            } | null;
            commits?: {
              nodes?: { commit?: { committedDate?: string | null } | null }[];
            } | null;
          } | null;
        } | null;
      } | null;
    };

    const pullRequest = payload?.data?.repository?.pullRequest;
    nodes.push(...(pullRequest?.reviews?.nodes ?? []));
    if (!headCommittedAt) {
      headCommittedAt = String(
        pullRequest?.commits?.nodes?.[0]?.commit?.committedDate ?? '',
      );
    }

    if (!pullRequest?.reviews?.pageInfo?.hasNextPage) break;
    if (!pullRequest.reviews.pageInfo.endCursor) {
      throw new Error('review pagination payload is missing endCursor');
    }
    cursor = pullRequest.reviews.pageInfo.endCursor;
  }

  const reviews = nodes.map((node) => ({
    author: node.author ?? null,
    submittedAt: node.submittedAt ?? null,
    commitId: node.commit?.oid ?? null,
    itemCount: node.comments?.totalCount ?? null,
  }));
  return { reviews, headCommittedAt };
}

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
                      author { login }
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
                  author { login }
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
