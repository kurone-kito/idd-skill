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
//
// This helper never mutates GitHub state: it only reads PR/review/thread/
// comment data and prints a verdict.

import {
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
} from './advisory-wait-policy.mts';
import { ghApiJson, ghText, isCliExecution, safeGhText } from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import { isValidIsoTimestamp } from './marker-helpers.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import {
  isCopilotReviewerLogin,
  normalizeTrustedMarkerLogins,
  resolveAdvisoryBotLogins,
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
  const prHeadSha = String(inputs.prHeadSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a 40-character lowercase commit SHA');
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
  const claim = summarizeClaimValidation(claimEvents, { trustedMarkerLogins });
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
  node scripts/advisory-convergence.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--claim-issue <number>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--now <ISO8601>] [--assert]

Read-only: asserts whether the primary advisory bot's review has converged
on the current PR HEAD. Always prints the JSON verdict. Without --assert,
always exits 0 (report-only). With --assert, exits non-zero unless the
verdict is "ready" (converged, or validly waived past the configured
deadline).
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
  const viewerLogin = safeGhText([
    'api',
    'user',
    '--jq',
    '.login',
  ]).toLowerCase();
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
  // Deliberately NOT unioned with `advisoryBotLogins` here (unlike some
  // other locally-collected sets in this file that scope broader trust for
  // marker *parsing*): every sibling helper (advisory-wait-state.mts,
  // pre-merge-readiness.mts) keeps `trustedMarkerLogins` and
  // `advisoryBotLogins` disjoint, and this specific set also authorizes
  // `--assert`-gating external-check waivers (via `summarizeExternalCheck-
  // Waivers`, below) -- folding a configured advisory bot login in here
  // would let that bot's own comment count as a "maintainer-authorized"
  // waiver author.
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
  ]);

  const pr = JSON.parse(
    ghText([
      'pr',
      'view',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'headRefOid,closingIssuesReferences,author',
    ]),
  ) as {
    headRefOid?: unknown;
    closingIssuesReferences?: ClosingIssueRefPayload[] | null;
    author?: GhAuthorPayload | null;
  };
  const prHeadSha = String(pr.headRefOid ?? '').toLowerCase();
  const prAuthorLogin = String(pr.author?.login ?? '').toLowerCase();

  const { reviews, headCommittedAt } = fetchReviewsAndHeadCommit(
    owner,
    repo,
    Number(args.prNumber),
  );
  const threads = fetchReviewThreads(owner, repo, Number(args.prNumber));
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    {
      paginate: true,
    },
  ) as IssueCommentPayload[];

  const claimEvents = resolveClaimEvents(
    owner,
    repo,
    args.claimIssueNumber,
    pr.closingIssuesReferences,
    trustedMarkerLogins,
  );

  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const deadlineMinutes = readAdvisoryConvergenceDeadlineMinutes();
  // No manual cast: `normalizePolicyConfig`'s inferred return type already
  // carries `ciGate.externalCheckWaivers.{mode,maxValidity}` precisely (see
  // `external-check-waiver.mts`'s `NormalizedPolicy` alias for the same
  // pattern) -- re-declaring the shape here would silently stop tracking
  // that source of truth on drift.
  const policy = normalizePolicyConfig(rawConfig);

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
 * Resolve the linked (claim) issue's comment stream for waiver-claim
 * binding. When `explicitIssueNumber` (`--claim-issue`) is given, use it
 * directly -- no ambiguity to resolve. Otherwise a PR can close more than
 * one issue (`pr.closingIssuesReferences`), so fetch every candidate's
 * comments and keep only the one whose *active claim* actually resolves
 * (`summarizeClaimValidation`), mirroring how `external-check-waiver.mts`'s
 * own `selectLinkedIssueCandidate` disambiguates multiple linked issues by
 * active-claim presence rather than requiring a single closing reference.
 * Zero or multiple resolving candidates fail closed to `[]` (no waiver
 * claim can bind unambiguously), same as before.
 */
function resolveClaimEvents(
  owner: string,
  repo: string,
  explicitIssueNumber: number | null,
  refs: ClosingIssueRefPayload[] | null | undefined,
  trustedMarkerLogins: string[],
): IssueCommentPayload[] {
  if (explicitIssueNumber) {
    return fetchClaimComments(owner, repo, explicitIssueNumber);
  }
  const candidateNumbers = [
    ...new Set(
      (refs ?? [])
        .map((ref) => ref?.number)
        .filter((n): n is number => Number.isInteger(n)),
    ),
  ];
  const resolving = candidateNumbers
    .map((issueNumber) => {
      const comments = fetchClaimComments(owner, repo, issueNumber);
      return {
        comments,
        hasActiveClaim: Boolean(
          summarizeClaimValidation(comments, { trustedMarkerLogins })
            .activeClaimPresent,
        ),
      };
    })
    .filter((candidate) => candidate.hasActiveClaim);
  return resolving.length === 1 ? resolving[0].comments : [];
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
// Guarded behind isCliExecution(import.meta.url) (shared, see gh-exec.mts)
// so importing this module (for unit tests) never parses process.argv,
// prints usage, or makes a `gh` call.
if (isCliExecution(import.meta.url)) {
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
