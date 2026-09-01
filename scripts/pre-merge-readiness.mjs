#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-merge-readiness.mts
//
// The scripts/pre-merge-readiness.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySecondaryQuietWindowMinutes,
  readAdvisoryTerminalWindowMinutes,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mjs';
import { buildCopilotRecoverySummary } from './advisory-wait-state.mjs';
import { parseCliArgs } from './cli-args.mjs';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mjs';
import {
  normalizeAuthorityEvidence,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mjs';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  GH_TEXT_LOOP_OPTIONS,
  ghText,
  safeGhText,
} from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';
import {
  buildPreMergeReadinessSummary,
  DEFAULT_STALE_AGE_MS,
  deriveIddAgentLogins,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  parsePaginatedGhNdjson,
  resolveAdvisoryBotLogins,
  resolveCodeownersForFiles,
  resolvePrFirstCommitAt,
  resolveRulesetDetailPath,
  resolveTrustedMarkerActors,
  selectCodeownersText,
} from './protocol-helpers.mjs';
import {
  evaluateProviderOutageRelief,
  resolveProviderOutageDeclaration,
} from './provider-outage-declaration.mjs';
import {
  fetchReviewsAndHeadCommit,
  resolveLatestCopilotReviewClause,
} from './review-clause.mjs';

// GitHub's GraphQL `DateTime` scalar can't be null, so a `CheckRun` that
// has not completed yet (and a `StatusContext`, which has no completedAt
// field at all) reports this zero-value sentinel instead -- the same
// convention `gh pr checks` already surfaces and `isCompletedCiTimestamp`
// (protocol-helpers.mts) already treats as "not completed".
const ZERO_SENTINEL_TIMESTAMP = '0001-01-01T00:00:00Z';
// The commit-status `state` GraphQL enum (`StatusState`) has its own
// 5-value vocabulary (`EXPECTED`, `ERROR`, `FAILURE`, `PENDING`,
// `SUCCESS`; confirmed via schema introspection -- an earlier version of
// this comment underclaimed 4, missing `EXPECTED`) that only partly
// overlaps the check-run vocabulary `classifyCiChecks` understands
// (`FAILURE`, `CANCELLED`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `SUCCESS`,
// `SKIPPED`, `NEUTRAL`, `NOT_APPLICABLE`, ...). `SUCCESS` and `FAILURE`
// already coincide, but the other three have no direct match -- left
// unmapped, each would silently fall into `classifyCiChecks`'s `unknown`
// bucket instead of the `failed` / `pending` bucket a caller actually
// needs (PR review finding, #1483: `gh pr checks`'s prior flattened read
// normalized both vocabularies into one `state` field; this
// data-source swap makes normalizing them this module's own
// responsibility). Map every divergent token onto its check-run
// equivalent before classification ever sees it: `ERROR` (a distinct
// "reporting error" state, not `FAILURE`) maps to `FAILURE`; `PENDING`
// (still running) and `EXPECTED` (a required status check configured for
// this ref but not yet reported at all -- also still "not done", not a
// failure) both map to `IN_PROGRESS`. This is always a "still failing" /
// "still running" outcome, never a false pass, so even an unmapped
// future commit-status token would only ever fail closed into `unknown`,
// not `success`.
const STATUS_CONTEXT_STATE_ALIASES = {
  ERROR: 'FAILURE',
  PENDING: 'IN_PROGRESS',
  EXPECTED: 'IN_PROGRESS',
};
/**
 * Normalize one raw `statusCheckRollup` entry into the `CheckPayload`
 * shape `classifyCiChecks` / `summarizeRequiredChecks` expect (#1483).
 *
 * `state` is derived to match what `gh pr checks --json state` already
 * reported for the same underlying data (verified empirically against
 * this repository's own live PRs across `SUCCESS` / `FAILURE` /
 * `IN_PROGRESS`): a completed check-run reports its `conclusion` (falling
 * back to `UNKNOWN` if absent); an incomplete one reports its raw `status`
 * (`QUEUED` / `IN_PROGRESS` / `WAITING`, also falling back to `UNKNOWN` if
 * absent -- a missing status is never silently coerced to an empty
 * string, which `classifyCiChecks` would not recognize as any known
 * bucket); a legacy commit-status reports its `state`, translated through
 * `STATUS_CONTEXT_STATE_ALIASES` for the three tokens with no direct
 * check-run equivalent. This keeps classification behavior identical to
 * before #1483 for every single-producer case that existed pre-#1483 --
 * only the producer-identity discriminator (`type` / `workflowName`) and
 * the commit-status vocabulary mapping are new.
 */
export function normalizeStatusCheckRollupEntry(entry) {
  if (String(entry?.__typename ?? '').trim() === 'StatusContext') {
    const rawState = String(entry?.state ?? '')
      .trim()
      .toUpperCase();
    return {
      name: String(entry?.context ?? '').trim(),
      state: STATUS_CONTEXT_STATE_ALIASES[rawState] ?? rawState,
      completedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
      type: 'status-context',
      workflowName: '',
    };
  }
  const status = String(entry?.status ?? '')
    .trim()
    .toUpperCase();
  const conclusion = String(entry?.conclusion ?? '')
    .trim()
    .toUpperCase();
  return {
    name: String(entry?.name ?? '').trim(),
    state:
      status === 'COMPLETED' ? conclusion || 'UNKNOWN' : status || 'UNKNOWN',
    completedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
    type: 'check-run',
    workflowName: String(entry?.workflowName ?? '').trim(),
  };
}
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. Both the
// canonical and deprecated spellings of the claim/agent-id flags are
// declared as separate spec entries (strict parseArgs requires every
// accepted flag to be declared) -- flag-name-matrix.test.mts's deprecated-
// alias tests scan for exactly these quoted literals.
const PRE_MERGE_READINESS_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--claim-issue': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--trusted-marker-logins': { type: 'string' },
  '--idd-agent-logins': { type: 'string' },
  '--advisory-bot-logins': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--expected-claim-id': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--expected-agent-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--now': { type: 'string' },
  '--claimless': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
/**
 * Fetch live GitHub state for the PR + claim issue and build the
 * read-only pre-merge readiness report. Shared by this CLI and the
 * `idd-merge-execute` helper so the F2/F3 gate logic is collected from
 * exactly one place (no duplicated gh plumbing or gate evaluation).
 */
export function collectPreMergeReadiness(argv) {
  const args = parseArgs(argv);
  // --help used to exit from inside the parseArgs token loop; relocated
  // here (the wrapper's help path) per #1451. Same external contract: the
  // sole caller (idd-merge-execute.mts) never passes --help, so this is a
  // pure relocation, not a behavior change.
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }
  if (!args.claimless && !args.claimIssueNumber) {
    throw new Error('missing required --claim-issue <number> argument');
  }
  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;
  const viewerLogin = safeGhText(
    ['api', 'user', '--jq', '.login'],
    GH_TEXT_LOOP_OPTIONS,
  ).toLowerCase();
  const viewerAppSlug = safeGhText(
    ['api', 'app', '--jq', '.slug // .app_slug // empty'],
    GH_TEXT_LOOP_OPTIONS,
  ).toLowerCase();
  const iddConfig = loadIddConfig();
  const { actors: configuredTrustedActors, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: iddConfig,
    });
  const { logins: advisoryBotLogins, source: advisoryBotLoginsSource } =
    resolveAdvisoryBotLogins({
      flagValue: args.advisoryBotLogins,
      envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
      config: iddConfig,
    });
  const pr = ghJson([
    'pr',
    'view',
    String(args.prNumber),
    '-R',
    repoRef,
    '--json',
    // #1513: `mergeable,mergeStateStatus` added to this existing call (no
    // new network round-trip) so the branch-currency gate below can pair a
    // live `BEHIND` state with the up-to-date-head requirement resolved
    // from `branchRules`/`branchProtection`.
    'headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,closingIssuesReferences',
    '--jq',
    '.',
  ]);
  const prHeadSha = String(pr.headRefOid ?? '');
  const baseRefName = String(pr.baseRefName ?? '');
  const prUrl = String(pr.url ?? '');
  const prAuthorLogin = String(pr.author?.login ?? '').toLowerCase();
  const reviewDecision = String(pr.reviewDecision ?? '');
  const mergeable = String(pr.mergeable ?? '');
  const mergeStateStatus = String(pr.mergeStateStatus ?? '');
  if (args.claimless) {
    const closingRefs = Array.isArray(pr.closingIssuesReferences)
      ? pr.closingIssuesReferences
      : [];
    if (closingRefs.length > 0) {
      throw new Error(
        '--claimless requires a PR with no closingIssuesReferences; pass --claim-issue instead',
      );
    }
  }
  const encodedBaseRefName = encodeURIComponent(baseRefName);
  // #1483: sourced from the same `gh pr view` call above (the
  // `statusCheckRollup` field), not a separate `gh pr checks` call --
  // `statusCheckRollup`'s GraphQL union already tags each entry with a
  // real producer identity (`__typename`: `CheckRun` vs. `StatusContext`,
  // plus `workflowName` for check-runs), which a flattened `gh pr checks`
  // read cannot expose. Joining two separately-fetched lists by name would
  // reintroduce the exact ambiguity this fix removes (confirmed live: two
  // successive calls a few seconds apart returned different check-run
  // counts for the same PR), so this is the single source of truth for
  // both the check identity and its dedup discriminator.
  const checks = (pr.statusCheckRollup ?? []).map(
    normalizeStatusCheckRollupEntry,
  );
  const trustEmptyProtectionReads = readTrustEmptyProtectionReads();
  const branchRulesRead = fetchGovernanceJson(
    `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
    true,
    trustEmptyProtectionReads,
    [],
  );
  const branchRules = branchRulesRead.value;
  const branchRulesetsRead = fetchBranchRulesets(
    owner,
    repo,
    branchRules,
    trustEmptyProtectionReads,
  );
  const branchRulesets = branchRulesetsRead.value;
  const branchProtectionRead = fetchGovernanceJson(
    `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
    false,
    trustEmptyProtectionReads,
    {},
  );
  const branchProtection = branchProtectionRead.value;
  // #1377: a masked-403-as-404 on either read means the required-check set
  // this call collected cannot be trusted as complete, so the F2/F3 CI gate
  // must not fall through to `noRequiredChecksConfigured` on it (see
  // `summarizeRequiredChecks` in protocol-helpers.mts).
  const protectionReadsUnreadable =
    branchRulesRead.unreadable || branchProtectionRead.unreadable;
  // #1380: a masked-403-as-404 on a ruleset's *detail* read is a distinct
  // surface from the required-check reads above -- `branchRulesets` only
  // feeds `summarizeReviewerStates`'s ruleset-bypass/CODEOWNER detection,
  // never `summarizeRequiredChecks` (see `summarizeBranchReviewRequirements`
  // in protocol-helpers.mts, which reads only `branchRules` /
  // `branchProtection`) -- so it is threaded separately rather than folded
  // into `protectionReadsUnreadable`.
  const branchRulesetsUnreadable = branchRulesetsRead.unreadable;
  const reviews = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
    true,
  );
  const requestedReviewers = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
    false,
  );
  const timelineEvents = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
    true,
    ['-H', 'Accept: application/vnd.github+json'],
  );
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  );
  const claimComments = args.claimless
    ? []
    : ghApiJson(
        `repos/${owner}/${repo}/issues/${args.claimIssueNumber}/comments`,
        true,
      );
  const threads = fetchReviewThreads(owner, repo, args.prNumber);
  const changedFiles = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/files`,
    true,
  )
    .map((file) => String(file.filename ?? ''))
    .filter(Boolean);
  const codeownersText = fetchCodeownersText(owner, repo, baseRefName);
  const {
    eligible: eligibleCodeownerUserLogins,
    unreadable: eligibleCodeownerUserLoginsUnreadable,
  } = resolveEligibleCodeownerUserLogins(
    owner,
    repo,
    resolveCodeownersForFiles(codeownersText, changedFiles).codeownerUserLogins,
  );
  const viewerTeamSlugs = resolveViewerClassicBypassTeamSlugs(
    owner,
    viewerLogin,
    branchProtection,
  );
  const collaboratorTrustEnabled = readCollaboratorTrustEnabled();
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(owner, repo, [
          ...comments,
          ...claimComments,
        ])
      : []),
  ]);
  const iddAgentLogins = deriveIddAgentLogins({
    viewerLogin,
    iddAgentLogins: splitCsv(args.iddAgentLogins),
    trustedMarkerLogins,
    operationalComments: [...comments, ...claimComments],
  });
  const advisoryWaitPolicy = readAdvisoryWaitPolicy();
  const primaryBotLogin = readAdvisoryPrimaryBotLogin();
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const forcedHandoffEnabled = readForcedHandoffMode() === 'human-gated';
  // The PR's first-commit time backs the Part B forced-handoff rule (#1058):
  // a legitimate issue-only handoff that predates the PR is honored even
  // against a PR-backed claim. This allowance is applied on the merge side
  // only; resume-claim-routing.mts intentionally never passes prFirstCommitAt
  // (an issue-only handoff against a PR-backed claim stays rejected there) —
  // the merge-only half of the documented strict-resume vs. lenient-relay-merge
  // split (see docs/idd-design-rationale.md, "Claim resolution"). Resolve it
  // only when forced handoffs are enabled, and fail closed to `null` (reject)
  // on any lookup/parse error so a transient commits-API failure never aborts
  // the readiness gate.
  let prFirstCommitAt = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = ghApiJson(
        `repos/${owner}/${repo}/pulls/${args.prNumber}/commits`,
        true,
      );
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const forcedHandoffPermissionCache = new Map();
  const waivableCheckSelectors = readWaivableCheckSelectors();
  const externalCheckWaiverMaxValidity = readExternalCheckWaiverMaxValidity();
  const externalCheckWaiverMode = readExternalCheckWaiverMode();
  const trustSourcePinnedRequiredChecks = readTrustSourcePinnedRequiredChecks();
  const staleAgeMs = readClaimStaleAgeMs();
  const now = args.now || new Date().toISOString().replace('.000Z', 'Z');
  const normalizedComments = comments.map(normalizeComment);
  const normalizedReviews = reviews.map(normalizeReview);
  // #2021: fetch the current HEAD commit's own `committedDate`, plus every
  // PR review, via the SAME GraphQL query `advisory-convergence.mts`'s own
  // deadline clock and Clause-1 review evidence both read
  // (`fetchReviewsAndHeadCommit`, extracted to `review-clause.mts` precisely
  // so a second, independent caller can reuse this exact evidence instead of
  // a second ad-hoc GraphQL path that could drift out of sync with it -- see
  // that module's header). Deliberately uncaught, same rationale as
  // `copilotUnavailable` below: a lookup failure must crash this evidence
  // collector rather than silently resolve to an empty `headCommittedAt`,
  // which would make `advisoryConvergenceDeadlinePassed` fail closed to
  // `false` for the wrong reason (masking a genuinely-open deadline as
  // unreadable evidence instead of surfacing the fetch failure).
  const {
    reviews: advisoryConvergenceReviews,
    headCommittedAt: advisoryConvergenceHeadCommittedAt,
  } = fetchReviewsAndHeadCommit(owner, repo, args.prNumber);
  const advisoryConvergenceDeadlineMinutes =
    readAdvisoryConvergenceDeadlineMinutes();
  const secondaryQuietWindowMinutes = readAdvisorySecondaryQuietWindowMinutes();
  // #1570: precompute the `#1572` terminal Copilot-unavailability verdict
  // here (the CLI/orchestration layer) rather than inside
  // `buildPreMergeReadinessSummary` (protocol-helpers.mts), which cannot
  // import `buildCopilotRecoverySummary` without an import cycle back
  // through advisory-wait-state.mts (see that function's own module notes).
  // Bound to the SAME expected claim already threaded to
  // `summarizeClaimValidation` below (`--expected-claim-id`/
  // `--expected-agent-id`), matching the active claim that would have
  // posted any `advisory-wait-recovery:` cycle markers. Deliberately
  // uncaught: an unexpected error here must not silently collapse to
  // `copilotUnavailable: false` (a permissive default that could mask a
  // real terminal-unavailable condition behind an ancillary-evidence bug
  // -- flagged by CodeRabbit on PR #1646). Letting it throw matches this
  // repo's documented helper-failure contract (see
  // `idd-review-snapshot.instructions.md`'s "Helpers remain evidence
  // collectors only"): a crash here is evidence collection failing
  // loudly, and callers already know to fall back to the portable
  // gh/jq/API procedure rather than trust a helper that could not run.
  //
  // #2042: `lastCopilotCommit` now resolves via
  // `resolveLatestCopilotReviewClause` against the SAME GraphQL review
  // evidence (`advisoryConvergenceReviews`, absolute-latest by fetch order)
  // `advisory-convergence.mts`'s own required check uses for its identical
  // `review.commitId` input (advisory-convergence.mts ~line 1087) -- not
  // the separate REST/`submittedAt`-sorted `findLastCopilotReviewCommit`
  // path this caller used before. That prior REST path is a second,
  // independently-timed fetch that can disagree with the GraphQL evidence
  // under a force-push/revert reordering (advisory-convergence.mts's own
  // comment on this exact gap, ~line 1070); `copilotUnavailable` computed
  // here is the sole evidence source for BOTH the `idd-advisory-convergence`
  // waiver precondition below AND the dedicated `copilot-terminal-unavailable`
  // blocker (`buildPreMergeReadinessSummary`'s `options.copilotUnavailable`,
  // reported back as `advisoryWait.copilotUnavailable` -- there is no
  // separate source to preserve for that second consumer; both already
  // shared this single value before this fix, so unifying the evidence
  // source here fixes both at once).
  const lastCopilotCommit = resolveLatestCopilotReviewClause(
    advisoryConvergenceReviews,
    prHeadSha,
    primaryBotLogin,
  ).commitId;
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments: normalizedComments, prHeadSha, lastCopilotCommit },
    {
      now,
      trustedMarkerLogins,
      claimId: args.expectedClaimId,
      agentId: args.expectedAgentId,
      recoveryCycleCap: readAdvisoryRecoveryCycleCap(),
      terminalWindowMinutes: readAdvisoryTerminalWindowMinutes(),
    },
  );
  const copilotUnavailable = copilotRecovery.state === 'COPILOT_UNAVAILABLE';
  const advisoryConvergenceOutageRelief =
    resolveAdvisoryConvergenceOutageRelief({
      owner,
      repo,
      copilotUnavailable,
      waivableCheckSelectors,
      now,
    });
  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      comments: normalizedComments,
      reviews: normalizedReviews,
      threads: threads.map(normalizeThread),
      checks,
      branchRules,
      branchRulesets,
      branchProtection,
      protectionReadsUnreadable,
      branchRulesetsUnreadable,
      requestedReviewers: requestedReviewers.users ?? [],
      timelineEvents,
      claimEvents: claimComments.map(normalizeClaimComment),
      changedFiles,
      codeownersText,
      eligibleCodeownerUserLogins,
      eligibleCodeownerUserLoginsUnreadable,
      // #1837: `reviews` above is fetched by the uncaught `ghApiJson` call
      // a few lines up (no `fetchGovernanceJson`-style tolerance) -- a
      // fetch failure throws and crashes this whole CLI invocation rather
      // than reaching `buildPreMergeReadinessSummary` with partial data.
      // This caller therefore never has genuinely-unclassifiable review
      // data; pass `false` explicitly (rather than relying on the default)
      // so the reason is documented at the one real call site instead of
      // only in protocol-helpers.mts's option comment.
      reviewsUnreadable: false,
      reviewDecision,
      mergeStateStatus,
      mergeable,
    },
    {
      now,
      trustedMarkerLogins,
      iddAgentLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      prAuthorLogin,
      expectedClaimId: args.expectedClaimId,
      expectedAgentId: args.expectedAgentId,
      expectedNonce: args.nonce,
      claimless: args.claimless,
      includeDispositionEvidence: true,
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      copilotUnavailable,
      advisoryConvergenceOutageRelieved:
        advisoryConvergenceOutageRelief.relieved,
      advisoryConvergenceOutageRelievedSince:
        advisoryConvergenceOutageRelief.since,
      advisoryConvergenceHeadCommittedAt,
      advisoryConvergenceDeadlineMinutes,
      secondaryQuietWindowMinutes,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity,
      externalCheckWaiverMode,
      trustSourcePinnedRequiredChecks,
      staleAgeMs,
      forcedHandoffEnabled,
      expectedLinkedPrs: [String(args.prNumber), prUrl].filter(Boolean),
      prFirstCommitAt,
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(
          owner,
          repo,
          forcedBy,
          forcedHandoffAuthorityPolicy,
          forcedHandoffPermissionCache,
        ),
      viewerLogin,
      viewerTeamSlugs,
      viewerAppSlug,
      configuredTrustedActors,
      collaboratorTrustEnabled,
    },
  );
  return {
    ...summary,
    trustedMarkerActors: configuredTrustedActors,
    trustedMarkerActorsSource,
  };
}
// CLI: emit the readiness report as JSON when invoked directly.
if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(collectPreMergeReadiness(process.argv.slice(2)), null, 2)}\n`,
  );
}
function warnDeprecatedFlag(deprecated, canonical) {
  process.stderr.write(
    `warning: ${deprecated} is deprecated; use ${canonical} instead.\n`,
  );
}
/**
 * Find `flag`'s last occurrence in `argv`, recognizing both the
 * two-token form (`--flag value`) and the single-token `--flag=value`
 * form `parseCliArgs` also accepts. A plain `argv.lastIndexOf(flag)`
 * only matches the exact bare token, so `--claim-id=1` would silently
 * fail to count as an occurrence of `--claim-id` (Copilot review
 * finding on this PR) -- checked here via an exact match OR a
 * `${flag}=` prefix match, scanning from the end so the first hit is
 * the true last occurrence.
 */
function findLastFlagOccurrenceIndex(argv, flag) {
  const equalsPrefix = `${flag}=`;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag || argv[index].startsWith(equalsPrefix)) {
      return index;
    }
  }
  return -1;
}
/**
 * Resolve a canonical/deprecated flag pair using the pre-migration
 * token-loop's exact assignment-order semantics: each occurrence
 * overwrote the same field as the loop walked argv left to right, so
 * whichever flag's LAST occurrence comes later in argv wins -- not
 * "canonical always wins" -- when both spellings are given together.
 * `-1` (never given) sorts before any real index, so an absent flag
 * never wins against one that was actually passed.
 */
function resolveLastGivenAlias(
  argv,
  canonicalFlag,
  canonicalValue,
  deprecatedFlag,
  deprecatedValue,
) {
  if (canonicalValue === undefined) {
    return deprecatedValue;
  }
  if (deprecatedValue === undefined) {
    return canonicalValue;
  }
  const lastCanonicalIndex = findLastFlagOccurrenceIndex(argv, canonicalFlag);
  const lastDeprecatedIndex = findLastFlagOccurrenceIndex(argv, deprecatedFlag);
  return lastDeprecatedIndex > lastCanonicalIndex
    ? deprecatedValue
    : canonicalValue;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, PRE_MERGE_READINESS_FLAG_SPEC);
  // Positive-integer guard shared by both numeric flags, preserving each
  // flag's own custom "invalid <flag> value: <raw>" message (test-locked
  // in tests/pre-merge-readiness.test.mts) rather than the wrapper's
  // generic message.
  const requirePositiveInteger = (token, flagName) => {
    if (token === undefined) {
      return null;
    }
    if (!/^[1-9]\d*$/.test(token)) {
      throw new Error(`invalid ${flagName} value: ${token}`);
    }
    return Number(token);
  };
  // Deprecated aliases: both spellings are declared flags (see the spec
  // above). warnDeprecatedFlag fires whenever the deprecated spelling is
  // present at all, matching the pre-migration per-token loop exactly
  // (which warned unconditionally the moment the deprecated token was
  // seen, regardless of whether the canonical spelling also appeared).
  // When BOTH spellings are given together, resolveLastGivenAlias below
  // replicates the pre-migration token-loop's assignment-order semantics
  // exactly: whichever flag's token appears LAST in argv wins (Codex
  // review finding on this PR -- an earlier draft always preferred the
  // canonical spelling here, which silently diverged from the original
  // "last write wins" contract for this specific double-flag case).
  const claimId = resolveLastGivenAlias(
    argv,
    '--claim-id',
    values['claim-id'],
    '--expected-claim-id',
    values['expected-claim-id'],
  );
  const expectedClaimIdToken = values['expected-claim-id'];
  if (expectedClaimIdToken !== undefined) {
    warnDeprecatedFlag('--expected-claim-id', '--claim-id');
  }
  const agentId = resolveLastGivenAlias(
    argv,
    '--agent-id',
    values['agent-id'],
    '--expected-agent-id',
    values['expected-agent-id'],
  );
  const expectedAgentIdToken = values['expected-agent-id'];
  if (expectedAgentIdToken !== undefined) {
    warnDeprecatedFlag('--expected-agent-id', '--agent-id');
  }
  const claimless = Boolean(values.claimless);
  if (claimless && values['claim-issue'] !== undefined) {
    throw new Error('--claimless cannot be combined with --claim-issue');
  }
  if (claimless && claimId) {
    throw new Error('--claimless cannot be combined with --claim-id');
  }
  return {
    prNumber: requirePositiveInteger(values.pr, '--pr'),
    claimIssueNumber: requirePositiveInteger(
      values['claim-issue'],
      '--claim-issue',
    ),
    owner: values.owner ?? '',
    repo: values.repo ?? '',
    trustedMarkerLogins: values['trusted-marker-logins'] ?? '',
    iddAgentLogins: values['idd-agent-logins'] ?? '',
    advisoryBotLogins: values['advisory-bot-logins'] ?? '',
    expectedClaimId: claimId ?? '',
    expectedAgentId: agentId ?? '',
    nonce: values.nonce ?? '',
    now: values.now ?? '',
    help,
    claimless: Boolean(values.claimless),
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/pre-merge-readiness.mjs --pr <number> --claim-issue <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--idd-agent-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--claim-id <claim-id>] [--agent-id <agent-id>] [--nonce <token>] [--now <ISO8601>]
  node scripts/pre-merge-readiness.mjs --pr <number> --claimless [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--idd-agent-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--now <ISO8601>]
  Deprecated aliases (one release): --expected-claim-id -> --claim-id, --expected-agent-id -> --agent-id

  --nonce <token>  this session's own recorded activation-nonce (#1522): when
                    given alongside --claim-id, the merge-time write-gate also
                    requires it to equal the winning trusted
                    <!-- activation-nonce: ... --> marker for that claim-id,
                    catching a second, independent activation of the same
                    claim-id as a collision. Omit --nonce, or leave it empty,
                    to skip this comparison entirely (backward compatible).
  --claimless      skip claim fetch/revalidation (#2017). Only for a PR
                    whose closingIssuesReferences is empty; cannot combine
                    with --claim-issue or --claim-id. Claim-ownership in
                    the report is the not-applicable / unclaimed shape.
`);
}
/**
 * Normalize a raw `gh api .../issues/{n}/comments` entry into the
 * summarizer-shape `CommentLike` `buildPreMergeReadinessSummary`
 * (protocol-helpers.mts) expects. Exported for direct unit testing (#1708):
 * previously local-only and unreferenced by any test, so a REST
 * field-mapping drift (e.g. `user.login` -> `author.login`) would surface
 * only in production.
 */
export function normalizeComment(comment) {
  return {
    id: String(comment.id ?? ''),
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    updatedAt: comment.updated_at ?? comment.created_at ?? '',
  };
}
/**
 * Normalize a raw claim-issue comment entry into the `CommentLike` shape
 * the claim-validation gate expects. Deliberately narrower than
 * {@link normalizeComment} (no `id`/`updatedAt`): the claim gate only ever
 * reads `body`/`createdAt`/`author.login`. Exported for direct unit
 * testing (#1708), see {@link normalizeComment}'s doc comment.
 */
export function normalizeClaimComment(comment) {
  return {
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  };
}
/**
 * Normalize a raw `gh api .../pulls/{n}/reviews` entry into the
 * summarizer-shape `ReviewLike`. Exported for direct unit testing (#1708),
 * see {@link normalizeComment}'s doc comment.
 */
export function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}
/**
 * Normalize a raw GraphQL `reviewThreads` node into the summarizer-shape
 * `ThreadLike`. Exported for direct unit testing (#1708), see
 * {@link normalizeComment}'s doc comment.
 */
export function normalizeThread(thread) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    reviewerReopenedAt: inferReviewerReopenedAt(thread),
    comments: {
      pageInfo: {
        hasNextPage: Boolean(thread.comments?.pageInfo?.hasNextPage),
      },
      nodes: (thread.comments?.nodes ?? []).map((comment) => ({
        author: { login: comment.author?.login ?? '' },
        body: comment.body ?? '',
        createdAt: comment.createdAt ?? '',
        updatedAt: comment.updatedAt ?? comment.createdAt ?? '',
        pullRequestReview: { id: comment.pullRequestReview?.id ?? null },
      })),
    },
  };
}
function inferReviewerReopenedAt(thread) {
  return thread.reviewerReopenedAt ?? '';
}
function resolveTrustedCollaboratorMarkerLogins(owner, repo, comments) {
  const markerAuthors = [
    ...new Set(
      comments
        .filter(
          (comment) => operationalMarkerPrefix(comment.body ?? '') !== null,
        )
        .map((comment) => comment.user?.login ?? '')
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
/**
 * Exported for direct unit testing (matching this file's established
 * `fetchBranchRulesets`/`fetchGovernanceJson` injectable-fetch pattern) --
 * `fetchPermission` defaults to the real live `gh api .../permission` call
 * and is overridden in tests to simulate a 404 vs. a transient failure
 * without mocking `execFileSync`.
 */
export function resolveEligibleCodeownerUserLogins(
  owner,
  repo,
  logins,
  fetchPermission = (login) =>
    ghText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ),
) {
  let unreadable = false;
  const eligible = normalizeTrustedMarkerLogins(logins).filter((login) => {
    let permission;
    try {
      permission = fetchPermission(login).toLowerCase();
    } catch (error) {
      // A 404 means this login genuinely has no collaborator record on
      // this repository (e.g. a stale CODEOWNERS entry for someone who
      // was removed) -- the pre-#1521 behavior of excluding it is correct
      // and unchanged. Any OTHER failure (403 permission denial, 5xx,
      // timeout, network) cannot be told apart from "genuinely not a
      // collaborator" by the caller, so it must not silently narrow the
      // eligible set the same way -- flag `unreadable` instead.
      if (deriveGhHttpStatus(error) === 404) {
        return false;
      }
      unreadable = true;
      return false;
    }
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
  return { eligible, unreadable };
}
function fetchCodeownersText(owner, repo, ref) {
  const payloads = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].map(
    (path) => {
      return ghApiJson(
        `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        false,
        [],
        { allowHttpStatuses: [404] },
      );
    },
  );
  return selectCodeownersText(payloads);
}
/**
 * Fetch each referenced ruleset's detail, discriminating a masked `404`
 * (unreadable) from a genuine deletion race.
 *
 * Every `ruleset_id` passed in via `branchRules` was already confirmed to
 * exist moments earlier by the `rules/branches/{base}` list read in the same
 * call (see `collectPreMergeReadiness`), so a genuine deletion between that
 * read and this one is possible but unlikely. That timing alone would not
 * justify treating every `404` as unreadable -- the real justification is
 * that the response itself cannot distinguish the two cases. GitHub's "Get a
 * repository ruleset" reference documents only `200`/`404`/`500` for this
 * endpoint -- no `403` --
 * (<https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset>),
 * the same masked-403-as-404 pattern `#1377` documented for the other two
 * governance reads (see `fetchGovernanceJson`'s doc comment for the full
 * citation set, including GitHub's REST troubleshooting guide). A `404`
 * here is therefore **unreadable** by default: the ruleset is still dropped
 * from the returned array (the caller has no usable detail either way, so
 * `#1380` cannot invent one), but `unreadable` is set so
 * `summarizeReviewerStates` can distinguish "no bypass configured" from
 * "could not determine" instead of asserting an unjustified certain
 * `deadlock`. `trustEmptyReads` (`ciGate.trustEmptyProtectionReads`, the
 * same policy key `fetchGovernanceJson` reads) restores the pre-`#1380`
 * trusting behavior.
 *
 * Any other thrown status (`403`, rate limit, transient failure, …) is
 * still re-thrown unchanged, preserving the existing fail-closed behavior
 * for an explicit permission error (`#1371`) instead of fabricating a "no
 * ruleset" result that would silently over-block a legitimately configured
 * bypass.
 *
 * The 404 must be discriminated on the *thrown* status: `gh api` writes a 404
 * response body to stdout, so `allowHttpStatuses: [404]` would return that
 * non-empty error object and the `Object.keys(...).length > 0` filter would
 * keep it as a junk ruleset. Letting the 404 throw and matching it here yields
 * the empty/skipped result the gate expects.
 *
 * `fetchRulesetDetail` is injectable for tests; production uses the default
 * `gh api` call.
 */
export function fetchBranchRulesets(
  owner,
  repo,
  branchRules,
  trustEmptyReads = false,
  fetchRulesetDetail = (path) =>
    ghApiJson(path, false, ['-H', 'Accept: application/vnd.github+json']),
) {
  const rulesetPaths = [];
  const seenPaths = new Set();
  for (const rule of branchRules ?? []) {
    const rulesetId = Number.parseInt(String(rule?.ruleset_id ?? ''), 10);
    if (!Number.isInteger(rulesetId)) {
      continue;
    }
    const path = resolveRulesetDetailPath(owner, repo, rule, rulesetId);
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    rulesetPaths.push(path);
  }
  let unreadable = false;
  const value = rulesetPaths
    .map((path) => {
      try {
        return fetchRulesetDetail(path);
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          if (!trustEmptyReads) {
            unreadable = true;
          }
          return {};
        }
        throw error;
      }
    })
    .filter((ruleset) => Object.keys(ruleset).length > 0);
  return { value, unreadable };
}
function resolveViewerClassicBypassTeamSlugs(
  owner,
  viewerLogin,
  branchProtection,
) {
  if (!viewerLogin) {
    return [];
  }
  const teams =
    branchProtection.required_pull_request_reviews
      ?.bypass_pull_request_allowances?.teams ?? [];
  const viewerTeams = new Set();
  for (const team of teams) {
    const slug = String(team?.slug ?? '')
      .trim()
      .toLowerCase();
    if (!slug) {
      continue;
    }
    const org = String(
      team?.organization?.login ??
        extractTeamOrgFromHtmlUrl(team?.html_url) ??
        owner,
    ).trim();
    const state = safeGhText(
      [
        'api',
        `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(viewerLogin)}`,
        '--jq',
        '.state',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ).toLowerCase();
    if (state === 'active') {
      viewerTeams.add(slug);
    }
  }
  return [...viewerTeams].sort();
}
function extractTeamOrgFromHtmlUrl(htmlUrl) {
  const match = String(htmlUrl ?? '').match(/\/orgs\/([^/]+)\/teams\//);
  return match?.[1] ?? '';
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
      {
        owner,
        repo,
        number: Number.parseInt(String(prNumber), 10),
        cursor,
      },
    );
    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        // hasNextPage with a missing thread id or cursor is a malformed
        // payload; fail fast with a clear message instead of a confusing
        // GraphQL error or a silently truncated thread.
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
    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    // hasNextPage with a missing cursor would re-fetch the first page
    // forever; fail fast on the malformed payload instead.
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
  return JSON.parse(runGh(args).trim() || '{}');
}
function ghJson(args, options = {}) {
  return JSON.parse(runGh(args, options).trim() || '[]');
}
function ghApiJson(path, paginate = false, extraArgs = [], options = {}) {
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.push('--paginate', '--jq', '.[]');
  }
  const raw = runGh(args, options).trim();
  if (!raw) {
    return paginate ? [] : {};
  }
  if (paginate) {
    return parsePaginatedGhNdjson(raw);
  }
  return JSON.parse(raw);
}
/**
 * Decide how a thrown `gh` failure is tolerated, returning the string result to
 * use or `undefined` when the caller must re-throw.
 *
 * - `allowHttpStatuses` matches the HTTP status derived from the gh error via
 *   the shared `deriveGhHttpStatus` (the same extractor `fetchBranchRulesets`
 *   uses) and yields an **empty** string. `gh api` writes the JSON error body to
 *   stdout on a non-2xx response (a 404 prints `{"message":"Not Found",…}`), so
 *   returning that body would make `ghApiJson` parse the error object instead of
 *   `{}` / `[]`. An allowed status never carries useful data, so the empty
 *   result lets `ghApiJson` resolve it to an empty object / array.
 * - `allowStatuses` matches the process exit code and returns stdout **only**
 *   when the body is genuinely the wanted JSON (`gh` commands that exit non-zero
 *   yet still print the data, e.g. the checks rollup).
 *
 * The HTTP-status branch is checked **first**: an explicitly tolerated HTTP
 * status must always yield empty, even when the exit code is also tolerated and
 * the error body on stdout happens to be JSON. Checking `allowStatuses` first
 * would return that error body and reintroduce the very parsing bug this guards
 * against. No current caller sets both options, so the order is behavior-neutral
 * today; it keeps the resolver correct for any future combined call.
 */
export function resolveToleratedGhFailure(error, options = {}) {
  const httpStatus = deriveGhHttpStatus(error);
  if (
    httpStatus !== null &&
    (options.allowHttpStatuses ?? []).includes(httpStatus)
  ) {
    return '';
  }
  const status = Number(error?.status ?? -1);
  if ((options.allowStatuses ?? []).includes(status)) {
    const stdout = String(error?.stdout ?? '');
    if (/^\s*[[{]/.test(stdout)) {
      return stdout;
    }
  }
  return undefined;
}
function runGh(args, options = {}) {
  try {
    return ghText(args, {
      ...GH_TEXT_LOOP_OPTIONS,
      ...(args.includes('--paginate')
        ? { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS }
        : {}),
    });
  } catch (error) {
    const tolerated = resolveToleratedGhFailure(error, options);
    if (tolerated !== undefined) {
      return tolerated;
    }
    throw error;
  }
}
function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}
function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}
function readCollaboratorTrustEnabled() {
  try {
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}
// Configured waivable external-check selectors (`ciGate.externalChecks.
// waivable`). The F2 gate only lets a valid waiver fold a check into
// `requiredChecksPassing` when that check sits on this surface; an absent or
// unreadable config yields an empty list (nothing waivable).
function readWaivableCheckSelectors() {
  try {
    return [
      ...normalizePolicyConfig(
        JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      ).ciGate.externalChecks.waivable,
    ];
  } catch {
    return [];
  }
}
// Configured external-check waiver validity window (`ciGate.
// externalCheckWaivers.maxValidity`). The consume side re-enforces it so a
// waiver whose `expiresAt - createdAt` outlives the policy window cannot count
// as valid. `normalizePolicyConfig` already defaults this to `PT24H`; an absent
// or unreadable config falls back to the same authoring default.
function readExternalCheckWaiverMaxValidity() {
  try {
    return normalizePolicyConfig(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
    ).ciGate.externalCheckWaivers.maxValidity;
  } catch {
    return 'PT24H';
  }
}
// Configured external-check waiver mode (`ciGate.externalCheckWaivers.mode`,
// #2046). `mode` gates the WHOLE waiver mechanism independent of the
// `waivable` selector list -- an absent or unreadable config falls back to
// `normalizePolicyConfig`'s own schema default (`disabled`), the fail-closed
// choice: an unreadable config can never make this check wrongly report an
// otherwise-valid waiver as covered when the real required check would not
// honor it, mirroring `advisory-convergence.mts`'s own fail-closed guard.
function readExternalCheckWaiverMode() {
  try {
    return normalizePolicyConfig(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
    ).ciGate.externalCheckWaivers.mode;
  } catch {
    return 'disabled';
  }
}
// #2353: resolve whether a repository-scoped `providerOutage.
// declarationTarget` declaration relieves the `idd-advisory-convergence`
// selector for this pull request -- the SAME selector
// `advisory-convergence.mts`'s own gate relieves via its own,
// independently-fetched declaration (see that file's `collectFromGitHub`).
// Fails closed to `{ relieved: false, since: '' }` on ANY error (unset
// target, unreadable/unparseable declaration-target comments, authority-
// lookup failure) -- a transient fetch failure must never widen what this
// gate accepts, matching `prFirstCommitAt`'s own fail-closed contract
// above. `copilotUnavailable` is the caller-supplied `prTerminalUnavailable`
// evidence `evaluateProviderOutageRelief` requires independently of the
// declaration itself (never itself sufficient) -- the same terminal-
// unavailability verdict this file's own `copilot-terminal-unavailable`
// blocker already consumes. Requires `ciGate.externalCheckWaivers.mode`
// to be `maintainer-authorized` (Codex review on PR #2370): without this,
// an adopter that leaves `mode` at its `disabled` default but configures
// the waivable selector and posts a declaration would relieve here while
// `computeAdvisoryConvergenceVerdict`'s own gate -- gated on the SAME
// `waiverMode === 'maintainer-authorized'` check -- still rejects it,
// exactly the two-gate disagreement #2021 already fixed for the direct
// per-pull-request waiver path. `since` is the declaration's own
// `startedAt` (Codex review on PR #2370): a required check's live run
// must have completed AT OR AFTER this moment to count as covered --
// otherwise the check was never actually rerun during the declared
// outage window, and GitHub's own required-check state stays whatever a
// stale pre-declaration run left it at while this gate reports covered,
// reproducing #2021's "ready but merge blocked" class one layer deeper.
function resolveAdvisoryConvergenceOutageRelief({
  owner,
  repo,
  copilotUnavailable,
  waivableCheckSelectors,
  now,
}) {
  const notRelieved = { relieved: false, since: '' };
  try {
    const policy = normalizePolicyConfig(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
    );
    if (policy.ciGate.externalCheckWaivers.mode !== 'maintainer-authorized') {
      return notRelieved;
    }
    const targetIssue = policy.providerOutage.declarationTarget;
    if (!targetIssue) return notRelieved;
    const declarationComments = ghApiJson(
      `repos/${owner}/${repo}/issues/${targetIssue}/comments`,
      true,
    );
    const authorityOf = (actorLogin) =>
      normalizeAuthorityEvidence(
        resolveCollaboratorAuthority({ owner, repo, actor: actorLogin }),
        actorLogin,
        owner,
        policy.ciGate.externalCheckWaivers.authorityPolicy,
      );
    const declaration = resolveProviderOutageDeclaration({
      declarationTargetConfigured: true,
      comments: declarationComments,
      service: DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      policy,
      authorityOf,
      now: new Date(now),
    });
    const relieved = evaluateProviderOutageRelief({
      declarationActive: declaration.active,
      prTerminalUnavailable: copilotUnavailable,
      requestedSelector: DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      waivableSelectors: waivableCheckSelectors
        .map((entry) => ({
          selector: String(entry.selector ?? ''),
          matchMode:
            typeof entry.matchMode === 'string' ? entry.matchMode : undefined,
        }))
        .filter((entry) => entry.selector.length > 0),
    }).relieved;
    return {
      relieved,
      since: relieved ? String(declaration.declaration?.startedAt ?? '') : '',
    };
  } catch {
    return notRelieved;
  }
}
// Configured claim-staleness window (`claimTiming.staleAge`, #1310), parsed
// to milliseconds so the write-gate claim resolver honors it instead of the
// hardcoded 24h `isStaleAt` default. Reuses the shared `loadIddConfig`
// loader (already imported by this file) instead of a per-helper
// `readFileSync + JSON.parse` copy; `loadIddConfig` already fails safe to
// `null` and `normalizePolicyConfig(null)` already defaults to `PT24H`, so
// no separate try/catch is needed here. An absent, unreadable, or
// unparseable config falls back to the shared `DEFAULT_STALE_AGE_MS`
// (protocol-helpers.mts) rather than a second local 24h literal, so
// behavior is unchanged for repos on the default and there is exactly one
// hardcoded-24h source of truth.
function readClaimStaleAgeMs() {
  const staleAge = normalizePolicyConfig(loadIddConfig()).claimTiming.staleAge;
  return parseIsoDurationToMs(staleAge) ?? DEFAULT_STALE_AGE_MS;
}
// Configured governance-read trust opt-in (`ciGate.trustEmptyProtectionReads`,
// #1377). Reuses the shared `loadIddConfig` loader (already imported by this
// file); an absent, unreadable, or unparseable config fails safe to the
// `false` default via `normalizePolicyConfig(null)`, matching
// `readClaimStaleAgeMs`'s pattern above.
function readTrustEmptyProtectionReads() {
  return (
    normalizePolicyConfig(loadIddConfig()).ciGate.trustEmptyProtectionReads ===
    true
  );
}
// Configured source-pinned required-check trust opt-in
// (`ciGate.trustSourcePinnedRequiredChecks`, #1689). Same pattern as
// `readTrustEmptyProtectionReads` above; see `summarizeRequiredChecks`'s
// (protocol-helpers.mts) doc comment on the option of the same name for the
// full rationale.
function readTrustSourcePinnedRequiredChecks() {
  return (
    normalizePolicyConfig(loadIddConfig()).ciGate
      .trustSourcePinnedRequiredChecks === true
  );
}
/**
 * Fetch a branch-governance read that GitHub's documented status-code
 * contracts never pair with `403` — `branches/{branch}/protection`
 * documents only `200`/`404`, and `rules/branches/{branch}` can also
 * surface a permission failure as `404` per GitHub's REST troubleshooting
 * guide (see `idd-ci.instructions.md`'s Required-check discovery step 4
 * for the citations `#1377` gathered). Because the response body cannot
 * distinguish "genuinely nothing configured" from "the token cannot read
 * this," a `404` here is **unreadable** by default: the caller still gets
 * a valid empty shape (`emptyValue`) to keep working with, but
 * `unreadable` is set so the CI gate can fail closed instead of silently
 * accepting a vacuous "no required checks" result. `trustEmptyReads`
 * (from `ciGate.trustEmptyProtectionReads`) restores the pre-`#1377`
 * trusting behavior for a repository whose operator has git-committed
 * that its automation token is known to carry full read access to these
 * endpoints — an explicit, auditable policy decision, not a runtime
 * signal a narrower-scoped token could spoof. Any other thrown status
 * (`403`, `500`, a transient failure, …) still re-throws unchanged,
 * preserving `#1363`'s existing fail-closed behavior for an explicit
 * permission error.
 *
 * `fetchJson` is injectable for tests (mirrors `fetchBranchRulesets`'s
 * `fetchRulesetDetail` parameter); production uses the default `gh api` call.
 */
export function fetchGovernanceJson(
  path,
  paginate,
  trustEmptyReads,
  emptyValue,
  fetchJson = (p, pg) => ghApiJson(p, pg, []),
) {
  try {
    return { value: fetchJson(path, paginate), unreadable: false };
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return { value: emptyValue, unreadable: !trustEmptyReads };
    }
    throw error;
  }
}
