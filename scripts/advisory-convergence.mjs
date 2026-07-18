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
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisorySameHeadRerollCap,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mjs';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mjs';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mjs';
import {
  GH_TEXT_LOOP_OPTIONS,
  ghApiJson,
  ghText,
  safeGhText,
} from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { isValidIsoTimestamp } from './marker-helpers.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
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
} from './protocol-helpers.mjs';
/** The external-check-waiver selector this gate recognizes (documented in
 * docs/idd-helper-scripts.md and docs/policy-constants.md; #1341's required
 * check is expected to register under the same name). */
export const ADVISORY_CONVERGENCE_CHECK_SELECTOR = 'idd-advisory-convergence';
/**
 * Compute the deterministic advisory-convergence verdict from already-
 * fetched PR evidence. Pure (no I/O), so it is directly unit-testable with
 * fixtures -- mirrors `buildPreMergeReadinessSummary` /
 * `buildAdvisoryWaitSummary` in `protocol-helpers.mts`.
 */
export function computeAdvisoryConvergenceVerdict(inputs, options) {
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
  const reasons = [];
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
  const threadClause = {
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
  // --- Same-HEAD advisory reroll evidence (#1511) ------------------------
  // Purely additive: `converged` above is already final and is never
  // recomputed or referenced below this point -- see the module header and
  // the "sameHeadReroll never affects converged/ready" test.
  const sameHeadRerollEligible =
    !pending &&
    threadClause.satisfied &&
    review.itemCount !== null &&
    review.itemCount > 0;
  // Both guards require `> 0` (not merely `Number.isFinite`/`Number.is-
  // Integer`), matching `normalizePositiveInteger` / `normalizePositiveNumber`
  // (advisory-wait-policy.mts) exactly: this function is exported and pure,
  // so a direct caller (a test, or future code bypassing the CLI's own
  // schema-validated config read) could otherwise pass `0` or a negative
  // value and silently corrupt behavior -- `cap: 0` makes `exhausted`
  // trivially true (`count >= 0`), and `pendingWindowMinutes <= 0` breaks
  // the `inFlight` elapsed-time comparison (PR #1517 review).
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
  // A fresh primary-bot review submitted AFTER the latest reroll marker's
  // own GitHub `created_at` means that request has already been answered --
  // regardless of what the fresh review's itemCount turned out to be (a
  // "1 -> 3" surprise is still an answer; it is simply not a converging one,
  // and the normal E1/E4 triage path handles it, never this evidence). A
  // missing/invalid `submittedAt` fails closed toward "not yet answered"
  // (never toward a false "landed"), same direction as `isValidIsoTimestamp`
  // guards elsewhere in this file.
  const hasFreshReviewSinceLastReroll =
    rerollMarkers.latestAt !== '' &&
    isValidIsoTimestamp(review.submittedAt) &&
    Date.parse(review.submittedAt) > Date.parse(rerollMarkers.latestAt);
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
    rerollMarkers.latestAt !== '' &&
    !hasFreshReviewSinceLastReroll &&
    rerollElapsedMinutes < pendingWindowMinutesForReroll;
  const sameHeadRerollExhausted = rerollMarkers.count >= sameHeadRerollCap;
  const sameHeadReroll = {
    eligible: sameHeadRerollEligible,
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
  const deadline = {
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
  const waiver = {
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
    sameHeadReroll,
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
function resolveLatestCopilotReviewClause(reviews, prHeadSha, primaryBotLogin) {
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
export function classifyCopilotAuthoredThreadIds(threads, primaryBotLogin) {
  const ids = new Set();
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
  comments,
  prHeadSha,
  trustedMarkerLogins,
) {
  const trusted = new Set(trustedMarkerLogins);
  // prHeadSha is already validated to `^[0-9a-f]{40}$` by the caller (see
  // the top of computeAdvisoryConvergenceVerdict), so it is safe to embed
  // directly in a RegExp literal with no escaping -- a hex string has no
  // regex-special characters.
  const pattern = new RegExp(`^advisory-reroll: [^ ]+ ${prHeadSha}(?: |$)`);
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
function minutesBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 60000);
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
};
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, ADVISORY_CONVERGENCE_FLAG_SPEC);
  return {
    // Both resolve-to-null on an invalid/absent value (fails closed at the
    // caller) -- the established contract this migration must preserve;
    // see "an invalid --pr resolves to null" in tests/advisory-convergence.
    // test.mts.
    prNumber: parseCanonicalIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    claimIssueNumber: parseCanonicalIntegerOrNull(values['claim-issue']),
    trustedMarkerLogins: values['trusted-marker-logins'],
    advisoryBotLogins: values['advisory-bot-logins'],
    now: values.now,
    assert: values.assert,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/advisory-convergence.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--claim-issue <number>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--now <ISO8601>] [--assert] [--help]

Read-only: asserts whether the primary advisory bot's review has converged
on the current PR HEAD. Every invocation other than --help/-h prints the
JSON verdict to stdout. Without --assert, always exits 0 (report-only).
With --assert, exits non-zero unless the verdict is "ready" (converged, or
validly waived past the configured deadline).
`);
}
const defaultDeps = { collect: collectFromGitHub };
/**
 * Parse argv, collect evidence (via `deps.collect`, real `gh` calls by
 * default), compute the verdict, and derive the `--assert` exit code.
 * Mirrors `idd-merge-execute.mts`'s `runMergeExecute` DI pattern so tests
 * can substitute a fake `collect` instead of shelling out to `gh`.
 */
export function runAdvisoryConvergence(argv, deps = defaultDeps) {
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
export function viewerProbeGhOptions(env = process.env) {
  return {
    stdio:
      env.GITHUB_ACTIONS === 'true'
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'inherit'],
  };
}
function collectFromGitHub(args) {
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
  );
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
  );
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
  // #1511: bounded same-HEAD reroll cap, plus the existing pendingWindow
  // (reused, not a new duration knob) that bounds how long a reroll can
  // stay "in flight" before a caller may safely retry.
  const sameHeadRerollCap = readAdvisorySameHeadRerollCap();
  const { pendingWindowMinutes } = readAdvisoryWaitPolicy();
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
  const forcedHandoffPermissionCache = new Map();
  // Part B (#1058): an issue-only handoff that predates the PR is honored
  // even against a PR-backed claim. Resolved only when forced handoffs are
  // enabled, and fails closed to `null` (reject) on any lookup/parse error
  // so a transient commits-API failure never widens what this gate accepts.
  let prFirstCommitAt = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = ghApiJson(
        `repos/${owner}/${repo}/pulls/${args.prNumber}/commits`,
        { paginate: true },
      );
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
      sameHeadRerollCap,
      pendingWindowMinutes,
      forcedHandoffEnabled,
      isAuthorizedForcedHandoff: (forcedBy) =>
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
function fetchClaimComments(owner, repo, issueNumber) {
  const raw = ghApiJson(
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      paginate: true,
    },
  );
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
function fetchClaimEventCandidates(owner, repo, explicitIssueNumber, refs) {
  if (explicitIssueNumber) {
    return [fetchClaimComments(owner, repo, explicitIssueNumber)];
  }
  const candidateNumbers = [
    ...new Set(
      (refs ?? []).map((ref) => ref?.number).filter((n) => Number.isInteger(n)),
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
  candidates,
  trustedMarkerLogins,
  isExplicit,
) {
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
  owner,
  repo,
  commentLikeEvents,
) {
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
function ghGraphql(query, variables) {
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
function fetchReviewsAndHeadCommit(owner, repo, prNumber) {
  const nodes = [];
  let headCommittedAt = '';
  let cursor = null;
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
    );
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
function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;
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
    );
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
function fetchThreadCommentPages(threadId, afterCursor) {
  const nodes = [];
  let cursor = afterCursor;
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
    );
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
