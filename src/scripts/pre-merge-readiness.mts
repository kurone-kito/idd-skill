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
} from './advisory-wait-policy.mts';
import { buildCopilotRecoverySummary } from './advisory-wait-state.mts';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import {
  type AuthorityEvidence,
  normalizeAuthorityEvidence,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mts';
import type {
  PrCommitPayload,
  TrustedMarkerActorResolution,
} from './protocol-helpers.mts';
import {
  buildPreMergeReadinessSummary,
  DEFAULT_STALE_AGE_MS,
  deriveIddAgentLogins,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
  resolveCodeownersForFiles,
  resolvePrFirstCommitAt,
  resolveRulesetDetailPath,
  resolveTrustedMarkerActors,
  selectCodeownersText,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import {
  evaluateProviderOutageRelief,
  resolveProviderOutageDeclaration,
} from './provider-outage-declaration.mts';
import type {
  ProviderComment,
  ProviderPort,
  ProviderReviewThreadWithComments,
} from './provider-port.mts';
import {
  fetchReviewsAndHeadCommit,
  resolveLatestCopilotReviewClause,
} from './review-clause.mts';

/** Author reference embedded in GitHub REST/GraphQL payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  id?: string | number | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: GhAuthorPayload | null;
}

/** PR review payload fields consumed by this helper. */
interface ReviewPayload {
  state?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  commit_id?: string | null;
}

/**
 * Normalized CI status-check entry fed to `classifyCiChecks` /
 * `summarizeRequiredChecks`. Produced by `normalizeStatusCheckRollupEntry`
 * from a raw `statusCheckRollup` entry (see `StatusCheckRollupPayload`
 * below), not fetched directly. `type` and `workflowName` are the
 * producer-identity discriminator #1483 added so a check-run is never
 * conflated with a same-named legacy commit-status (or a check-run from a
 * different Actions workflow) -- see `CheckLike` in `protocol-helpers.mts`.
 */
interface CheckPayload {
  name?: string | null;
  state?: string | null;
  completedAt?: string | null;
  // #2353 (Codex review on PR #2370): see `CheckLike` in
  // `protocol-helpers.mts` for why this is threaded through separately
  // from `completedAt`.
  startedAt?: string | null;
  type?: string | null;
  workflowName?: string | null;
}

/**
 * Raw `statusCheckRollup` entry as returned by
 * `gh pr view --json statusCheckRollup` (a GraphQL union of `CheckRun` and
 * `StatusContext`, discriminated by `__typename`). Mirrors the shape
 * `ci-wait-state.mts` also derives this same GraphQL field from -- this
 * type and `normalizeStatusCheckRollupEntry` below are declared
 * independently rather than imported from that file, since the two
 * modules are maintained separately (see #1478's own tracked dedup gap in
 * that file).
 */
interface StatusCheckRollupPayload {
  __typename?: string | null;
  name?: string | null;
  context?: string | null;
  state?: string | null;
  status?: string | null;
  conclusion?: string | null;
  completedAt?: string | null;
  startedAt?: string | null;
  workflowName?: string | null;
}

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
const STATUS_CONTEXT_STATE_ALIASES: Record<string, string> = {
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
export function normalizeStatusCheckRollupEntry(
  entry: StatusCheckRollupPayload,
): CheckPayload {
  if (String(entry?.__typename ?? '').trim() === 'StatusContext') {
    const rawState = String(entry?.state ?? '')
      .trim()
      .toUpperCase();
    return {
      name: String(entry?.context ?? '').trim(),
      state: STATUS_CONTEXT_STATE_ALIASES[rawState] ?? rawState,
      completedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
      // A legacy commit status has no separate start/complete lifecycle --
      // it is reported as a single instant -- so `startedAt` reuses the
      // same `completedAt` value rather than exposing a fabricated one.
      startedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
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
    startedAt: String(entry?.startedAt ?? ZERO_SENTINEL_TIMESTAMP),
    type: 'check-run',
    workflowName: String(entry?.workflowName ?? '').trim(),
  };
}

/** Timeline event payload fields consumed by the Copilot coverage check. */
interface TimelineEventPayload {
  event?: string | null;
  sha?: string | null;
  commit_id?: string | null;
  requested_reviewer?: GhAuthorPayload | null;
}

/** Branch rule entry from the rules API. */
interface BranchRulePayload {
  type?: string | null;
  ruleset_id?: unknown;
  ruleset_source_type?: unknown;
  source_type?: unknown;
  ruleset_source?: unknown;
  source?: unknown;
}

/** Required status-check entry in classic protection payloads. */
type RawRequiredCheckPayload =
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

/** Classic branch-protection bypass team entry. */
interface ClassicBypassTeamPayload {
  slug?: unknown;
  organization?: { login?: unknown } | null;
  html_url?: unknown;
}

/** Classic branch-protection payload. */
interface BranchProtectionPayload {
  required_pull_request_reviews?: {
    require_code_owner_reviews?: unknown;
    require_code_owner_review?: unknown;
    required_approving_review_count?: unknown;
    bypass_pull_request_allowances?: {
      users?: (string | { login?: unknown } | null)[] | null;
      teams?: (ClassicBypassTeamPayload | null)[] | null;
      apps?: (string | { slug?: unknown; app_slug?: unknown } | null)[] | null;
    } | null;
  } | null;
  required_conversation_resolution?: { enabled?: unknown } | null;
  required_status_checks?: {
    required_status_checks?: RawRequiredCheckPayload[] | null;
    required_checks?: RawRequiredCheckPayload[] | null;
    checks?: RawRequiredCheckPayload[] | null;
    contexts?: RawRequiredCheckPayload[] | null;
  } | null;
}

/** gh subprocess failure-tolerance options. */
interface RunGhOptions {
  allowStatuses?: number[];
  allowHttpStatuses?: number[];
}

/** Parsed CLI arguments. */
interface PreMergeReadinessArgs {
  prNumber: number | null;
  claimIssueNumber: number | null;
  owner: string;
  repo: string;
  trustedMarkerLogins: string;
  iddAgentLogins: string;
  advisoryBotLogins: string;
  expectedClaimId: string;
  expectedAgentId: string;
  // #1528: this caller's own recorded activation-nonce (#1522), forwarded
  // to buildPreMergeReadinessSummary's activation-nonce collision check.
  // Empty when omitted, which skips that check entirely (backward
  // compatible).
  nonce: string;
  now: string;
  help: boolean;
  /** #2017: skip claim fetch/revalidation on a PR with no closing issues. */
  claimless: boolean;
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
} as const;

/**
 * JSON state document printed by this CLI: the pre-merge readiness
 * gate summary plus the trusted-marker actor provenance fields.
 */
export type PreMergeReadinessReport = ReturnType<
  typeof buildPreMergeReadinessSummary
> & {
  trustedMarkerActors: string[];
  trustedMarkerActorsSource: TrustedMarkerActorResolution['source'];
};

/**
 * Fetch live GitHub state for the PR + claim issue and build the
 * read-only pre-merge readiness report. Shared by this CLI and the
 * `idd-merge-execute` helper so the F2/F3 gate logic is collected from
 * exactly one place (no duplicated gh plumbing or gate evaluation).
 */
/**
 * `createPort` is injectable (defaults to the real GitHub adapter) so a test
 * can drive this collection entry end to end against
 * `createFakeProviderAdapter` fixtures instead of a live `gh` process
 * (#2267 AC4's "unit tests exercise the PR-facing state machine with a fake
 * provider" -- see `pre-merge-readiness-collection-smoke.test.mts`). Neither
 * production caller (this file's own CLI entry, `idd-merge-execute.mts`)
 * passes a second argument, so both keep using the real adapter unchanged.
 */
export function collectPreMergeReadiness(
  argv: string[],
  createPort: (
    owner: string,
    repo: string,
  ) => ProviderPort = createGithubProviderAdapter,
): PreMergeReadinessReport {
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

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createPort(owner, repo);
  const viewerLogin = port.resolveViewerLoginSafe().viewerLogin;
  const viewerAppSlug = port.resolveViewerAppSlugSafe().appSlug.toLowerCase();
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

  // #1513: `mergeable`/`mergeStateStatus` are part of this same richest
  // single `pr view` call (no extra network round-trip) so the branch-
  // currency gate below can pair a live `BEHIND` state with the up-to-date-
  // head requirement resolved from `branchRules`/`branchProtection`.
  const snapshot = port.getChangeRequestReadinessSnapshot(args.prNumber);
  const prHeadSha = snapshot.headSha;
  const baseRefName = snapshot.baseRefName;
  const prUrl = snapshot.url;
  const prAuthorLogin = snapshot.authorLogin.toLowerCase();
  const reviewDecision = snapshot.reviewDecision ?? '';
  const mergeable = snapshot.mergeable;
  const mergeStateStatus = snapshot.mergeStateStatus;
  if (args.claimless) {
    const closingRefs = Array.isArray(snapshot.closingIssuesReferences)
      ? snapshot.closingIssuesReferences
      : [];
    if (closingRefs.length > 0) {
      throw new Error(
        '--claimless requires a PR with no closingIssuesReferences; pass --claim-issue instead',
      );
    }
  }
  // #2272: fail-closed development-branch invariant. Only reads the live
  // repository default branch when the policy is silent (`'absent'`) --
  // a configured or malformed value never needs it, so a repo with an
  // explicit `developmentBranch` never pays this extra `gh api` call.
  const developmentBranchInspection = inspectDevelopmentBranch(iddConfig);
  const liveDefaultBranch =
    developmentBranchInspection.status === 'absent'
      ? port.getRepositoryDefaultBranch(owner, repo)
      : null;
  const developmentBranchTarget = {
    ...resolveEffectiveDevelopmentBranch(iddConfig, liveDefaultBranch),
    baseRefName,
  };
  const encodedBaseRefName = encodeURIComponent(baseRefName);

  // #1483: sourced from the same `pr view` snapshot above (the
  // `statusCheckRollup` field), not a separate `gh pr checks` call --
  // `statusCheckRollup`'s GraphQL union already tags each entry with a
  // real producer identity (`__typename`: `CheckRun` vs. `StatusContext`,
  // plus `workflowName` for check-runs), which a flattened `gh pr checks`
  // read cannot expose. Joining two separately-fetched lists by name would
  // reintroduce the exact ambiguity this fix removes (confirmed live: two
  // successive calls a few seconds apart returned different check-run
  // counts for the same PR), so this is the single source of truth for
  // both the check identity and its dedup discriminator.
  const checks = (
    (snapshot.statusCheckRollup as StatusCheckRollupPayload[] | null) ?? []
  ).map(normalizeStatusCheckRollupEntry);
  const trustEmptyProtectionReads = readTrustEmptyProtectionReads();
  const branchRulesRead = fetchGovernanceJson<BranchRulePayload[]>(
    `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
    true,
    trustEmptyProtectionReads,
    [],
    () =>
      unwrapGovernanceOutcome(port.listBranchRules(owner, repo, baseRefName)),
  );
  const branchRules = branchRulesRead.value;
  const branchRulesetsRead = fetchBranchRulesets(
    owner,
    repo,
    branchRules,
    trustEmptyProtectionReads,
    (path) =>
      unwrapGovernanceOutcome(port.getRepositoryRulesetDetail(path)) as Record<
        string,
        unknown
      >,
  );
  const branchRulesets = branchRulesetsRead.value;
  const branchProtectionRead = fetchGovernanceJson<BranchProtectionPayload>(
    `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
    false,
    trustEmptyProtectionReads,
    {},
    () =>
      unwrapGovernanceOutcome(
        port.getBranchProtection(owner, repo, baseRefName),
      ),
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
  const reviews = port.listReviews(args.prNumber) as ReviewPayload[];
  const requestedReviewerLogins = port.getChangeRequestRequestedReviewerLogins(
    args.prNumber,
  );
  const timelineEvents = port.getWorkItemTimeline(
    args.prNumber,
  ) as TimelineEventPayload[];
  const comments = port
    .listWorkItemComments(args.prNumber)
    .map(toIssueCommentPayload);
  const claimComments = args.claimless
    ? []
    : port
        // Non-null: the earlier `!args.claimless && !args.claimIssueNumber`
        // guard already rejected this branch with a missing claim issue.
        .listWorkItemComments(args.claimIssueNumber as number)
        .map(toIssueCommentPayload);
  const threads = port.listChangeRequestReviewThreadsWithComments(
    args.prNumber,
  );
  const changedFiles = port
    .listChangeRequestChangedFiles(args.prNumber)
    .filter(Boolean);
  const codeownersText = fetchCodeownersText(port, owner, repo, baseRefName);
  const {
    eligible: eligibleCodeownerUserLogins,
    unreadable: eligibleCodeownerUserLoginsUnreadable,
  } = resolveEligibleCodeownerUserLogins(
    owner,
    repo,
    resolveCodeownersForFiles(codeownersText, changedFiles).codeownerUserLogins,
  );
  const viewerTeamSlugs = resolveViewerClassicBypassTeamSlugs(
    port,
    owner,
    viewerLogin,
    branchProtection,
  );

  const collaboratorTrustEnabled = readCollaboratorTrustEnabled();
  const trustedMarkerLogins = normalizeTrustedMarkerLogins([
    viewerLogin,
    ...configuredTrustedActors,
    ...(collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(port, [
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
  let prFirstCommitAt: string | null = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = port.listChangeRequestCommits(
        args.prNumber,
      ) as PrCommitPayload[];
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const forcedHandoffPermissionCache: CollaboratorPermissionCache = new Map();
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
  } = fetchReviewsAndHeadCommit(owner, repo, args.prNumber, port);
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
      port,
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
      requestedReviewers: requestedReviewerLogins,
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
      developmentBranchTarget,
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
  } as PreMergeReadinessReport;
}

// CLI: emit the readiness report as JSON when invoked directly.
if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(collectPreMergeReadiness(process.argv.slice(2)), null, 2)}\n`,
  );
}

function warnDeprecatedFlag(deprecated: string, canonical: string): void {
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
function findLastFlagOccurrenceIndex(
  argv: readonly string[],
  flag: string,
): number {
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
  argv: readonly string[],
  canonicalFlag: string,
  canonicalValue: string | undefined,
  deprecatedFlag: string,
  deprecatedValue: string | undefined,
): string | undefined {
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

export function parseArgs(argv: string[]): PreMergeReadinessArgs {
  const { values, help } = parseCliArgs(argv, PRE_MERGE_READINESS_FLAG_SPEC);

  // Positive-integer guard shared by both numeric flags, preserving each
  // flag's own custom "invalid <flag> value: <raw>" message (test-locked
  // in tests/pre-merge-readiness.test.mts) rather than the wrapper's
  // generic message.
  const requirePositiveInteger = (
    token: string | undefined,
    flagName: string,
  ): number | null => {
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
    values['claim-id'] as string | undefined,
    '--expected-claim-id',
    values['expected-claim-id'] as string | undefined,
  );
  const expectedClaimIdToken = values['expected-claim-id'] as
    | string
    | undefined;
  if (expectedClaimIdToken !== undefined) {
    warnDeprecatedFlag('--expected-claim-id', '--claim-id');
  }
  const agentId = resolveLastGivenAlias(
    argv,
    '--agent-id',
    values['agent-id'] as string | undefined,
    '--expected-agent-id',
    values['expected-agent-id'] as string | undefined,
  );
  const expectedAgentIdToken = values['expected-agent-id'] as
    | string
    | undefined;
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
    prNumber: requirePositiveInteger(values.pr as string | undefined, '--pr'),
    claimIssueNumber: requirePositiveInteger(
      values['claim-issue'] as string | undefined,
      '--claim-issue',
    ),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    trustedMarkerLogins:
      (values['trusted-marker-logins'] as string | undefined) ?? '',
    iddAgentLogins: (values['idd-agent-logins'] as string | undefined) ?? '',
    advisoryBotLogins:
      (values['advisory-bot-logins'] as string | undefined) ?? '',
    expectedClaimId: claimId ?? '',
    expectedAgentId: agentId ?? '',
    nonce: (values.nonce as string | undefined) ?? '',
    now: (values.now as string | undefined) ?? '',
    help,
    claimless: Boolean(values.claimless),
  };
}

function printHelp(): void {
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
/**
 * Map a `ProviderPort.listWorkItemComments` result back onto the REST
 * `issues/{n}/comments` shape this file's `normalizeComment`/
 * `normalizeClaimComment`/`resolveTrustedCollaboratorMarkerLogins`/
 * `deriveIddAgentLogins` call already expect -- keeps every one of those
 * unchanged rather than reshaping them for the port's flat `authorLogin`
 * field, which `provider-outage-declaration.mts`'s own `CommentLike` (fed
 * the same shim output for `resolveAdvisoryConvergenceOutageRelief`'s
 * declaration comments) does not recognize either.
 */
function toIssueCommentPayload(comment: ProviderComment): IssueCommentPayload {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    user: { login: comment.authorLogin },
  };
}

export function normalizeComment(comment: IssueCommentPayload) {
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
export function normalizeClaimComment(comment: IssueCommentPayload) {
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
export function normalizeReview(review: ReviewPayload) {
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
 * Normalize a `ProviderPort.listChangeRequestReviewThreadsWithComments`
 * node into the summarizer-shape `ThreadLike`. Exported for direct unit
 * testing (#1708), see {@link normalizeComment}'s doc comment. `id` and
 * `reviewerReopenedAt` are omitted (both `ThreadLike` fields are optional):
 * the pre-migration GraphQL query never selected `reviewerReopenedAt` at
 * all (`inferReviewerReopenedAt` always returned `''`), and the outer
 * thread `id` fed only `ThreadLike`'s own optional diagnostic fields, not
 * any gating decision -- `review-activity-snapshot.mts`'s own
 * `normalizeThread` already dropped both for the identical shared
 * GraphQL query, reviewed and merged without incident.
 */
export function normalizeThread(thread: ProviderReviewThreadWithComments) {
  return {
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: thread.comments.map((comment) => ({
        author: { login: comment.authorLogin },
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt || comment.createdAt,
        pullRequestReview: { id: comment.pullRequestReviewId ?? null },
      })),
    },
  };
}

function resolveTrustedCollaboratorMarkerLogins(
  port: ProviderPort,
  comments: IssueCommentPayload[],
): string[] {
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
    const result = port.getCollaboratorPermission(login);
    const permission = result.outcome === 'found' ? result.permission : '';
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}

/** Result of {@link resolveEligibleCodeownerUserLogins}. */
export interface EligibleCodeownerResolution {
  eligible: string[];
  /**
   * #1521 (Codex review on PR #1537): true when at least one login's
   * collaborator-permission lookup failed for a reason OTHER than "not a
   * collaborator" (403/5xx/network/timeout). The prior `safeGhText`-based
   * implementation swallowed every failure into an empty string, making a
   * transient lookup failure for a genuinely eligible non-author codeowner
   * (e.g. `@reviewer` in `* @author @reviewer`) indistinguishable from that
   * codeowner never having write access at all -- silently narrowing the
   * eligible set and making the PR author look like the sole eligible
   * codeowner. Threaded through to
   * `codeownerSelfApproval.prAuthorIsSoleEligibleCodeowner` (protocol-helpers.mts),
   * which fails closed (`false`) whenever this is `true`, regardless of
   * what the (possibly incomplete) `eligible` list below contains.
   */
  unreadable: boolean;
}

/**
 * Exported for direct unit testing (matching this file's established
 * `fetchBranchRulesets`/`fetchGovernanceJson` injectable-fetch pattern) --
 * `fetchPermission` defaults to the real `ProviderPort.getCollaboratorPermission`
 * read and is overridden in tests to simulate a 404 vs. a transient failure
 * without a live adapter. The default maps the port's never-throwing
 * `{outcome}` result back onto this function's own throw-based contract
 * (a synthetic `(HTTP 404)` error on `not-collaborator`, matching
 * `idd-merge-execute.mts`'s `resolveRemoteSoloCodeownerAdminFallbackMode`
 * default) so the `catch` block below -- and its existing tests -- stay
 * byte-identical.
 */
export function resolveEligibleCodeownerUserLogins(
  owner: string,
  repo: string,
  logins: unknown[],
  fetchPermission: (login: string) => string = (login) => {
    const result = createGithubProviderAdapter(
      owner,
      repo,
    ).getCollaboratorPermission(login);
    if (result.outcome === 'not-collaborator') {
      throwSyntheticGhNotFound();
    }
    if (result.outcome === 'error') {
      throw new Error(result.error.message);
    }
    return result.permission;
  },
): EligibleCodeownerResolution {
  let unreadable = false;
  const eligible = normalizeTrustedMarkerLogins(logins).filter((login) => {
    let permission: string;
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

function fetchCodeownersText(
  port: ProviderPort,
  owner: string,
  repo: string,
  ref: string,
): string {
  const payloads = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].map(
    (path) => port.getRepositoryContentAtRef(owner, repo, path, ref),
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
 * `ProviderPort.getRepositoryRulesetDetail` read, mapped back onto this
 * function's throw-based contract the same way
 * {@link resolveEligibleCodeownerUserLogins}'s default does.
 */
export function fetchBranchRulesets(
  owner: string,
  repo: string,
  branchRules: BranchRulePayload[],
  trustEmptyReads = false,
  fetchRulesetDetail: (path: string) => Record<string, unknown> = (path) => {
    const outcome = createGithubProviderAdapter(
      owner,
      repo,
    ).getRepositoryRulesetDetail(path);
    if (outcome.outcome === 'not-found') {
      throwSyntheticGhNotFound();
    }
    return outcome.value as Record<string, unknown>;
  },
): GovernanceReadResult<Record<string, unknown>[]> {
  const rulesetPaths: string[] = [];
  const seenPaths = new Set<string>();
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
  port: ProviderPort,
  owner: string,
  viewerLogin: string,
  branchProtection: BranchProtectionPayload,
): string[] {
  if (!viewerLogin) {
    return [];
  }
  const teams =
    branchProtection.required_pull_request_reviews
      ?.bypass_pull_request_allowances?.teams ?? [];
  const viewerTeams = new Set<string>();
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
    const state = port
      .getTeamMembershipStateSafe(org, slug, viewerLogin)
      .toLowerCase();
    if (state === 'active') {
      viewerTeams.add(slug);
    }
  }
  return [...viewerTeams].sort();
}

function extractTeamOrgFromHtmlUrl(htmlUrl: unknown): string {
  const match = String(htmlUrl ?? '').match(/\/orgs\/([^/]+)\/teams\//);
  return match?.[1] ?? '';
}

/**
 * Synthesize the same `(HTTP 404)`-in-`stderr` error shape a thrown `gh`
 * failure would have carried, so a caller's existing `deriveGhHttpStatus(error)
 * === 404` classification (unchanged by this migration) still recognizes a
 * port `{outcome:'not-found'}`/`{outcome:'not-collaborator'}` result --
 * mirrors `idd-merge-execute.mts`'s `resolveRemoteSoloCodeownerAdminFallbackMode`
 * default.
 */
function throwSyntheticGhNotFound(): never {
  const notFound = new Error('Not Found (HTTP 404)') as Error & {
    stderr?: string;
  };
  notFound.stderr = 'Not Found (HTTP 404)';
  throw notFound;
}

/** Unwrap a `ProviderGovernanceReadOutcome`, throwing the same synthetic
 * 404 {@link throwSyntheticGhNotFound} does on `not-found` so a caller
 * passing this as `fetchGovernanceJson`'s `fetchJson` thunk preserves that
 * function's existing `deriveGhHttpStatus(error) === 404` catch. */
function unwrapGovernanceOutcome<T>(
  outcome: { outcome: 'ok'; value: T } | { outcome: 'not-found' },
): T {
  if (outcome.outcome === 'not-found') {
    throwSyntheticGhNotFound();
  }
  return outcome.value;
}

/**
 * Decide how a thrown `gh` failure is tolerated, returning the string result to
 * use or `undefined` when the caller must re-throw. No longer called by this
 * file's own collection path (#2267 routed every call site onto the provider
 * port, which classifies its own failures), but kept -- pure, no `gh`
 * invocation of its own -- for `idd-doctor.mts`'s own `fetchGhApiJsonAt`
 * (an independent, un-migrated `gh api` caller) and its direct tests below.
 *
 * - `allowHttpStatuses` matches the HTTP status derived from the gh error via
 *   the shared `deriveGhHttpStatus` and yields an **empty** string. `gh api`
 *   writes the JSON error body to stdout on a non-2xx response (a 404 prints
 *   `{"message":"Not Found",…}`), so returning that body would make the
 *   caller parse the error object instead of `{}` / `[]`. An allowed status
 *   never carries useful data, so the empty result resolves cleanly to an
 *   empty object / array instead.
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
export function resolveToleratedGhFailure(
  error: unknown,
  options: RunGhOptions = {},
): string | undefined {
  const httpStatus = deriveGhHttpStatus(error);
  if (
    httpStatus !== null &&
    (options.allowHttpStatuses ?? []).includes(httpStatus)
  ) {
    return '';
  }
  const status = Number((error as { status?: unknown } | null)?.status ?? -1);
  if ((options.allowStatuses ?? []).includes(status)) {
    const stdout = String((error as { stdout?: unknown } | null)?.stdout ?? '');
    if (/^\s*[[{]/.test(stdout)) {
      return stdout;
    }
  }
  return undefined;
}

function splitCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function readCollaboratorTrustEnabled(): boolean {
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
function readWaivableCheckSelectors(): {
  selector?: unknown;
  matchMode?: unknown;
}[] {
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
function readExternalCheckWaiverMaxValidity(): string {
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
function readExternalCheckWaiverMode(): string {
  try {
    return normalizePolicyConfig(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
    ).ciGate.externalCheckWaivers.mode;
  } catch {
    return 'disabled';
  }
}

// #2353 (Codex review on PR #2370, second follow-up): a declaration's own
// `startedAt` is generated before the `--declare --apply` interactive
// confirmation prompt, while the GitHub comment's `createdAt` is stamped
// only once the maintainer actually confirms posting it. A failed check
// that completes during that pause satisfies a `startedAt`-only cutoff
// even though the declaration did not verifiably exist on GitHub yet and
// the check never reran under it. Use the LATER of the two timestamps as
// the true "this declaration became a real, postable fact" moment.
// `createdAt` may be the literal string `"none"` (schema-documented) or
// otherwise unparseable; in that case this falls back to `startedAt`
// alone, unchanged from before this fix -- never widening the cutoff.
export function resolveDeclarationActiveSince(
  declaration: { startedAt?: unknown; createdAt?: unknown } | null,
): string {
  const startedAtMs = Date.parse(String(declaration?.startedAt ?? ''));
  const createdAtMs = Date.parse(String(declaration?.createdAt ?? ''));
  const candidates = [startedAtMs, createdAtMs].filter((ms) =>
    Number.isFinite(ms),
  );
  if (candidates.length === 0) return '';
  return new Date(Math.max(...candidates)).toISOString();
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
// active-since moment (Codex review on PR #2370): a required check's live
// run must have STARTED (Copilot review, round 5: not "completed" --
// `summarizeRequiredChecks`'s `treatAsCoveredByWaiver` cutoff anchors on
// `startedAt`) AT OR AFTER this moment to count as covered -- otherwise
// the check was never actually rerun during the declared outage window,
// and GitHub's own required-check state stays whatever a stale
// pre-declaration run left it at while this gate reports covered,
// reproducing #2021's "ready but merge blocked" class one layer deeper.
function resolveAdvisoryConvergenceOutageRelief({
  port,
  owner,
  repo,
  copilotUnavailable,
  waivableCheckSelectors,
  now,
}: {
  port: ProviderPort;
  owner: string;
  repo: string;
  copilotUnavailable: boolean;
  waivableCheckSelectors: { selector?: unknown; matchMode?: unknown }[];
  now: string;
}): { relieved: boolean; since: string } {
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
    const declarationComments = port
      .listWorkItemComments(targetIssue)
      .map(toIssueCommentPayload);
    const authorityOf = (actorLogin: string): AuthorityEvidence =>
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
      since: relieved
        ? resolveDeclarationActiveSince(declaration.declaration)
        : '',
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
function readClaimStaleAgeMs(): number {
  const staleAge = normalizePolicyConfig(loadIddConfig()).claimTiming.staleAge;
  return parseIsoDurationToMs(staleAge) ?? DEFAULT_STALE_AGE_MS;
}

// Configured governance-read trust opt-in (`ciGate.trustEmptyProtectionReads`,
// #1377). Reuses the shared `loadIddConfig` loader (already imported by this
// file); an absent, unreadable, or unparseable config fails safe to the
// `false` default via `normalizePolicyConfig(null)`, matching
// `readClaimStaleAgeMs`'s pattern above.
function readTrustEmptyProtectionReads(): boolean {
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
function readTrustSourcePinnedRequiredChecks(): boolean {
  return (
    normalizePolicyConfig(loadIddConfig()).ciGate
      .trustSourcePinnedRequiredChecks === true
  );
}

/** Result of a governance-read fetch that discriminates a masked 404. */
interface GovernanceReadResult<T> {
  value: T;
  /**
   * `true` only when the read threw a `404` and the repository has not
   * opted in to trusting it as genuinely empty (`trustEmptyReads`).
   */
  unreadable: boolean;
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
 * `fetchRulesetDetail` parameter). No generic default transport: unlike
 * `fetchBranchRulesets`/`resolveEligibleCodeownerUserLogins`, this helper
 * has no owner/repo/ref of its own to construct a port-backed read from --
 * every real caller (this file's own two governance reads, plus
 * `idd-doctor.mts`'s independent `fetchGhApiJsonAt`-backed caller) already
 * passes an explicit `fetchJson`.
 */
export function fetchGovernanceJson<T>(
  path: string,
  paginate: boolean,
  trustEmptyReads: boolean,
  emptyValue: T,
  fetchJson: (path: string, paginate: boolean) => unknown = () => {
    throw new Error(
      'fetchGovernanceJson: no default transport; pass an explicit fetchJson',
    );
  },
): GovernanceReadResult<T> {
  try {
    return { value: fetchJson(path, paginate) as T, unreadable: false };
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return { value: emptyValue, unreadable: !trustEmptyReads };
    }
    throw error;
  }
}
