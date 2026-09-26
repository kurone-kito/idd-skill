#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-merge-readiness.mts
//
// The scripts/pre-merge-readiness.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import {
  ADVISORY_CONVERGENCE_WORKFLOW_PATH,
  resolveSelfReferentialTriggerFiles,
  verifySelfReferentialBootstrapWaiverRun,
} from './advisory-convergence.mts';
import { resolveAdvisoryConvergenceIdentitySignals } from './advisory-convergence-identity.mts';
import {
  advisoryWaitSectionIsValid,
  DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
  resolveAdvisoryConvergenceDeadlineMinutes,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisoryRecoveryCycleCap,
  resolveAdvisorySecondaryBotLogins,
  resolveAdvisorySecondaryQuietWindowMinutes,
  resolveAdvisoryWaitPolicy,
  resolveEffectiveAdvisoryTerminalWindowMinutes,
  resolveProviderOutageTerminalWindowMinutes,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from './advisory-wait-policy.mts';
import { buildCopilotRecoverySummary } from './advisory-wait-state.mts';
import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import { isAuthorizedForcedHandoffActor } from './collaborator-permission.mts';
import {
  type AuthorityEvidence,
  normalizeAuthorityEvidence,
  resolveCollaboratorAuthority,
} from './external-check-waiver.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { type IddConfig, loadTrustedIddConfig } from './idd-config.mts';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
  resolveCollaboratorMarkerTrust,
  resolveEffectiveDevelopmentBranch,
} from './policy-helpers.mts';
import type {
  ExternalCheckWaiverAuthorityLookup,
  PrClosingIssueClaimState,
  PrCommitPayload,
  PrLoopMembershipResult,
  TrustedMarkerActorResolution,
} from './protocol-helpers.mts';
import {
  attachReviewThreadCommentEditHistories,
  buildEffectiveTrustedMarkerLogins,
  buildPreMergeReadinessSummary,
  classifyPrLoopMembership,
  deriveIddAgentLogins,
  extractSameRepoClosingIssueNumbers,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  parseExternalCheckWaiverComment,
  readClaimStaleAgeMs,
  resolveActiveClaim,
  resolveAdvisoryBotLogins,
  resolveClosingIssueNumbersForClassifier,
  resolveCodeownersForFiles,
  resolvePrFirstCommitAt,
  resolveRulesetDetailPath,
  resolveTrustedMarkerActors,
  selectAdvisoryThreadCommentIdsEditedAfterDisposition,
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
  ProviderReviewThreadCommentEditHistory,
  ProviderReviewThreadWithComments,
} from './provider-port.mts';
import {
  fetchHeadObservedAt,
  fetchReviewsAndHeadCommit,
  resolveLatestCopilotReviewClause,
} from './review-clause.mts';
// #3298: this file's only consumer of supersession-detection.mts --
// protocol-helpers.mts must never import from it (supersession-detection.mts
// already transitively depends on protocol-helpers.mts via
// discover-shared-file-overlap.mts, so the reverse edge would cycle), so the
// closing-set evidence computation itself stays here rather than moving into
// protocol-helpers.mts's computePreMergeReadinessBlockers, which only reads
// the already-computed record.
import { computeClosingSetEvidence } from './supersession-detection.mts';

/** Author reference embedded in GitHub REST/GraphQL payloads. */
interface GhAuthorPayload {
  login?: string | null;
  /** REST `user.type` ("Bot"/"User"/...). Preserved by
   * {@link normalizeReview} so `findLastCopilotReviewCommit` can apply
   * the #3262 suffix match. GraphQL `__typename` is a different field. */
  type?: string | null;
}

/** Issue comment payload fields consumed by this helper. */
interface IssueCommentPayload {
  id?: string | number | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: GhAuthorPayload | null;
  /** #3246: see `ProviderComment.lastEditedAt`'s doc comment
   * (provider-port.mts) for the three-state contract. Only populated when
   * the fetch that produced this row requested `includeEditState`. */
  last_edited_at?: string | null;
}

/** PR review payload fields consumed by this helper. */
interface ReviewPayload {
  state?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  commit_id?: string | null;
  /** #3015: threaded through `normalizeReview` so
   * `findLastCopilotReviewCommit` (protocol-helpers.mts, reached via
   * `buildPreMergeReadinessSummary`'s call into `buildAdvisoryWaitSummary`)
   * can decide whether this review counts as covering its `commit_id`.
   * For a configured non-Copilot primary bot, only the exact #3015
   * "encountered an error" template is excluded; as of #3265, for the
   * DEFAULT Copilot bot, only a body `classifyCopilotReviewBody`
   * recognizes as `overview-v2` or `overview-legacy` counts at all. */
  body?: string | null;
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
  // #2919: a stronger producer-identity discriminator than
  // `workflowName` -- see `CheckLike` in `protocol-helpers.mts` for why.
  // NEVER set by `normalizeStatusCheckRollupEntry` itself (that function
  // stays pure, no Actions API access inside a `.map()`); populated, when
  // at all, by a bounded post-processing enrichment step below that
  // resolves it via `listCheckRunWorkflowPaths`'s `checkSuite.workflowRun`
  // provenance (kurone-kito/idd-skill#2926 -- previously `getWorkflowRun`
  // on a run id parsed from the check-run's own `detailsUrl`, which #2926
  // found forgeable) for the one check name this issue's Background
  // documents a real same-display-name-different-file collision scenario
  // for. Absent for every other check, which stays permissive through
  // `groupChecksByProducer`'s own key computation, identical to the
  // pre-#1483 absent-`type`/`workflowName` convention.
  workflowPath?: string | null;
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
  // #2919: a `CheckRun` entry's own permalink
  // (`https://github.com/{owner}/{repo}/actions/runs/{run-id}/job/{job-id}`)
  // -- already returned by `gh pr view --json statusCheckRollup` (not a
  // new fetch), just newly read here to resolve the owning workflow
  // run's id for the bounded `workflowPath` enrichment below.
  detailsUrl?: string | null;
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
  /** #3298: the deliberate multi-issue closing set (`--closing-issues
   * <n>[,<n>...]`), when given. `null` means "not given" -- the caller
   * falls back to `[claimIssueNumber]`, or `[]` under `--claimless`. */
  closingIssueNumbers: number[] | null;
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
  '--closing-issues': { type: 'string' },
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
  loadTrustedConfig: (
    owner: string,
    repo: string,
    ref: string,
  ) => IddConfig | null = loadTrustedIddConfig,
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
    throw markCliUsageError(
      new Error('missing required --pr <number> argument'),
    );
  }
  if (!args.claimless && !args.claimIssueNumber) {
    throw markCliUsageError(
      new Error('missing required --claim-issue <number> argument'),
    );
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createPort(owner, repo);
  const viewerLogin = port.resolveViewerLoginSafe().viewerLogin;
  const viewerAppSlug = port.resolveViewerAppSlugSafe().appSlug.toLowerCase();

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
  // kurone-kito/idd-skill#3328: the immediate "no closingIssuesReferences"
  // refusal below moved to AFTER `comments`/`trustedMarkerLogins` resolve
  // (search "Out-of-loop membership" below) -- deciding whether a
  // non-empty closing-reference set is still eligible now needs
  // `classifyPrLoopMembership`, which needs the PR's own comments (with
  // edit state) and the resolved trusted-marker-login set, neither of
  // which exists yet at this point in collection. `closingRefsAtEntry`
  // captures the raw, as-fetched value for that later check.
  //
  // Copilot review, PR #3421: `closingRefsReadable` is tracked
  // SEPARATELY from the coerced-to-array `closingRefsAtEntry` -- a
  // non-array `closingIssuesReferences` (the field itself unreadable or
  // malformed) must not silently read as "genuinely no closing
  // references" (the ordinary #2017 claimless case) the way coercing
  // straight to `[]` and gating on its `.length` would. The out-of-loop
  // block below gates on `closingRefsReadable` too, so an unreadable
  // field still reaches `resolveClosingIssueNumbersForClassifier` (which
  // itself now fails closed to `null` for a non-array input) instead of
  // skipping classification entirely.
  const closingRefsReadable = Array.isArray(snapshot.closingIssuesReferences);
  const closingRefsAtEntry = closingRefsReadable
    ? (snapshot.closingIssuesReferences as unknown[])
    : [];

  // #2373: EVERY config-driven gate below resolves `.github/idd/config.json`
  // from this ONE trusted-ref read, never a local worktree read -- the F3
  // merge-gate helper normally runs from the claimed PR's own worktree
  // (B1 creates it from the PR's branch), so a local read would return the
  // PR branch's own possibly-edited copy of its policy file, letting a PR
  // widen its own trustedMarkerActors, loosen a ciGate setting, or disguise
  // its developmentBranchTarget check against itself. `baseRefName` -- the
  // PR's base branch -- is the trust boundary; when a PR context cannot
  // supply one (defensive only, `--pr` is required so this is normally
  // non-empty), this falls back to the repository's live default branch,
  // matching `developmentBranchTarget`'s own `liveDefaultBranch` fallback
  // below. `--pr <number>` is a required argument on every path, including
  // `--claimless` (checked above) -- confirmed no call site of this file
  // (nor `idd-doctor.mts`, whose own `readTrustEmptyProtectionReads` is a
  // distinct, root-scoped local reader unrelated to this one) invokes
  // `collectPreMergeReadiness` without `--pr`, so this fallback is
  // defensive-only, not a documented "no PR at all" entry point.
  const trustedConfigRef =
    baseRefName || port.getRepositoryDefaultBranch(owner, repo);
  if (!trustedConfigRef) {
    throw new Error(
      `cannot resolve a trusted ref for .github/idd/config.json: PR #${args.prNumber} has no baseRefName and the repository's live default branch could not be determined`,
    );
  }
  const iddConfig = loadTrustedConfig(owner, repo, trustedConfigRef);
  // Schema-validated once here, matching every `advisoryWait.*` resolver's
  // own individual `read*` wrapper (advisory-wait-policy.mts) validating
  // before it resolves -- an invalid `advisoryWait` section falls back to
  // schema defaults for the WHOLE section rather than leaving a malformed
  // field to whichever resolver reads it next.
  const advisoryWaitConfig = advisoryWaitSectionIsValid(iddConfig)
    ? iddConfig
    : {};

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

  // #2272: fail-closed development-branch invariant. Only reads the live
  // repository default branch when the policy is silent (`'absent'`) --
  // a configured or malformed value never needs it, so a repo with an
  // explicit `developmentBranch` never pays this extra `gh api` call. Kept
  // as its own lazy `getRepositoryDefaultBranch` call rather than reusing
  // `trustedConfigRef` above: that value is eagerly resolved for every PR
  // (`baseRefName` is normally non-empty), so merging the two would pay
  // this call unconditionally instead of only on the rare-in-practice
  // policy-silent path.
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
  const rawStatusCheckRollup =
    (snapshot.statusCheckRollup as StatusCheckRollupPayload[] | null) ?? [];
  // kurone-kito/idd-skill#2919: `checks` stays index-aligned 1:1 with
  // `rawStatusCheckRollup` (a bare `.map`, never filtered) so the
  // workflow-path enrichment immediately below can zip back into
  // `rawStatusCheckRollup[index].detailsUrl` by plain array index --
  // inserting a `.filter()`/`.slice()` between this line and that
  // enrichment would silently break that invariant. `let`, not `const`:
  // the enrichment step below reassigns it.
  let checks = rawStatusCheckRollup.map(normalizeStatusCheckRollupEntry);

  // kurone-kito/idd-skill#2919: resolve each LIVE `idd-advisory-convergence`
  // check-run instance's own owning workflow FILE path -- distinct from its
  // display name, which a different workflow file can share (see
  // `CheckPayload.workflowPath`'s own doc comment and this issue's
  // Background). Scoped to this ONE check name deliberately: it is the
  // only one with a documented same-display-name-different-file collision
  // scenario in this repository today (a same-repository PR that
  // reintroduces a `pull_request` trigger to its own copy of
  // `.github/workflows/idd-advisory-convergence.yml` post-#2764 Phase 2,
  // per kurone-kito/idd-skill#3256). The producer-identity
  // KEY widens for every `groupChecksByProducer` consumer regardless (see
  // `protocol-helpers.mts`); only the SOURCING of real `workflowPath` data
  // stays this narrow, so any other check name still benefits the moment a
  // future caller populates its own `workflowPath` -- Residual (documented,
  // not fixed here): this collector does not resolve `workflowPath` for
  // any check name other than `idd-advisory-convergence`.
  //
  // Deliberately UNCONDITIONAL (not gated on `touchesSelfReferentialAllowlist`
  // like the marker-run-verification block further below): that gate exists
  // there because the stale-waiver computation it feeds is ITSELF gated on
  // the same flag, so an unconditional lookup would be pure waste. This
  // enrichment instead feeds `summarizeRequiredChecks`/`classifyCiChecks` --
  // the PRIMARY required-check gate, which runs on every PR regardless. Cost
  // stays small on its own: this repository's own live PR rollups show
  // exactly one `idd-advisory-convergence` check-run entry per PR in the
  // ordinary case (the `-self-waiver` check is a different name, not
  // matched here), two-to-three in the documented same-file dedup case
  // above -- never the up-to-20 budget the marker-verification block below
  // spends.
  //
  // kurone-kito/idd-skill#2919 (round 2 -- Codex + Copilot review on PR
  // #2921, six new findings against a prior cap+excess-sentinel design):
  // that design let a check name's own EARLIER, budget-excess instance
  // become its own permanent, unmergeable producer group even when
  // later, in-budget reruns of the SAME real workflow file superseded
  // it -- a self-inflicted stuck-PR risk under this repo's own
  // `fully_autonomous_merge` + `rerun-advisory-convergence.mjs`
  // automation (E10 critique finding, confirmed by that design's own
  // regression test asserting the stuck outcome as "working correctly").
  // Separately, an in-budget resolution failure still left `workflowPath`
  // ABSENT (permissive) for that check name, which can still let a
  // genuinely different decoy workflow file's SUCCESS merge with the
  // real workflow's FAILURE at the PRIMARY required-check gate under
  // exactly that failure (Codex finding); and a real checker instance
  // that itself landed in the excess bucket silently dropped out of
  // stale-waiver candidacy (a second Codex finding). All four traced to
  // the same root cause: PARTIAL resolution (mixing resolved-real-path,
  // unresolved-permissive, and sentinel-excluded instances within one
  // check name) is unsafe in every direction at once -- a uniform
  // PERMISSIVE fallback re-admits a decoy (the original #2921 P1), and a
  // uniform FAIL-CLOSED-BUT-PARTIAL fallback can permanently split a
  // legitimate group (the round-2 findings).
  //
  // Replaced the cap/excess/sentinel machinery with the only design safe
  // under both constraints at once: resolve EVERY unique run id this
  // check name's live instances cite (no excess bucket, so a genuinely-
  // superseded same-file failure always gets the chance to dedupe with
  // its own later reruns), and treat anything short of full, clean
  // resolution -- a parse failure on some (but not all) instances, a
  // thrown/erroring `listCheckRunWorkflowPaths` call (kurone-kito/idd-skill#2926;
  // formerly `getWorkflowRun`), an empty resolved `path`, a `detailsUrl`
  // that repeats (#2926 -- unresolvable to one instance either way), or
  // the run-id count exceeding the (now generous, DoS-only) ceiling below
  // -- as ONE uniform, whole-check-name "identity unresolved" outcome:
  // `workflowPath` stays absent on every instance (matching this check
  // name's own pre-#2919 behavior, so `groupChecksByProducer` still
  // dedupes them together exactly as before), and
  // `advisoryConvergenceIdentityUnresolved` is reported to
  // `buildPreMergeReadinessSummary`, which downgrades the PRIMARY
  // required-check gate's `status` to `'unknown'` for this check name
  // specifically (mirroring the existing `sourcePinnedRequiredCheckNames`
  // downgrade convention in `summarizeRequiredChecks`) whenever it would
  // otherwise report `'success'`. This can never merge a decoy (an
  // unresolved identity is never reported passing), and can never
  // permanently strand a legitimate same-file rerun sequence (every run
  // id is always attempted, every attempt shares the SAME verdict for
  // the whole check name, and a transient failure degrades to a
  // blocked-but-recoverable "unknown" -- the same shape every other wait
  // in this gate already has -- rather than a silent false pass OR an
  // unrecoverable false block).
  //
  // A ZERO-parseable-run-id check name (every live instance's own
  // `detailsUrl` is missing/malformed) stays fully permissive/unchanged
  // rather than "identity unresolved": it never had resolvable evidence
  // to begin with, matching the pre-#1483 absent-discriminator
  // convention every other `type`/`workflowName`-absent check already
  // gets. As of kurone-kito/idd-skill#3256 (live Copilot review, PR
  // #3425, rejected -- see that PR's own review thread), this also
  // leaves the new `event` gate below unresolved for this branch: the
  // genuine checker instance always has a parseable `detailsUrl`, so this
  // branch only fires when NO genuine instance is present at all (a
  // forged-only-instance window #2919/#2926's own producer-identity
  // provenance already targets, not a `pull_request`-vs-
  // `pull_request_target` problem this issue's own scope covers), and a
  // genuine instance alongside a `detailsUrl`-less forged one already
  // routes through the MIXED branch below instead, which fails closed
  // regardless. Same accepted zero-evidence posture, deliberately not
  // widened or narrowed by this issue. A MIXED check name (some instances
  // parseable, some not) is NOT given this same pass -- the parseable
  // instances DO have resolvable identity evidence, so treating the
  // whole name as "no evidence" could mask a genuine decoy hiding behind
  // one malformed `detailsUrl`
  // (Copilot finding, round 2); it is instead folded into "identity
  // unresolved" like any other partial-resolution case.
  // #3465: the watermark gate calls this same resolver. The two flags
  // stay distinct: identity-unresolved (#2919) and a resolved pass that
  // is not pull_request_target (#3256).
  const advisoryIdentity = resolveAdvisoryConvergenceIdentitySignals(
    checks.map((check, index) => ({
      name: String(check.name ?? ''),
      type: String(check.type ?? ''),
      state: String(check.state ?? ''),
      workflowName: String(check.workflowName ?? ''),
      completedAt: check.completedAt ?? null,
      detailsUrl: String(rawStatusCheckRollup[index]?.detailsUrl ?? ''),
    })),
    () =>
      port.listCheckRunWorkflowPaths(
        owner,
        repo,
        prHeadSha,
        DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR,
      ),
  );
  const advisoryConvergenceIdentityUnresolved =
    advisoryIdentity.identityUnresolved;
  const advisoryConvergenceNonTargetEventOnly =
    advisoryIdentity.nonTargetEventOnly;
  if (advisoryIdentity.workflowPathByIndex.size > 0) {
    checks = checks.map((check, index) => {
      const path = advisoryIdentity.workflowPathByIndex.get(index);
      return path === undefined ? check : { ...check, workflowPath: path };
    });
  }

  const trustEmptyProtectionReads = readTrustEmptyProtectionReads(iddConfig);
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
  // #3246: `includeEditState` resolves each comment's GraphQL
  // `lastEditedAt` -- needed so `waiverEvidence` (fed by these PR
  // comments) can reject a body-edited external-check-waiver marker.
  // `claimComments` below deliberately does NOT opt in: the claim-marker
  // family's own edit-state consumer is a separate, sibling issue.
  const comments = port
    .listWorkItemComments(args.prNumber, { includeEditState: true })
    .map(toIssueCommentPayload);
  const claimComments = args.claimless
    ? []
    : port
        // Non-null: the earlier `!args.claimless && !args.claimIssueNumber`
        // guard already rejected this branch with a missing claim issue.
        .listWorkItemComments(args.claimIssueNumber as number)
        .map(toIssueCommentPayload);
  // kurone-kito/idd-skill#3328: hoisted from further below (it used to sit
  // just before `normalizedReviews`) -- `classifyPrLoopMembership` below
  // needs the `CommentLike`-shaped comments too, and this derivation has no
  // dependency on anything defined between the old and new positions.
  const normalizedComments = comments.map(normalizeComment);
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
    // Reuses the collector's own injected port instead of the default's
    // fresh createGithubProviderAdapter(owner, repo) -- otherwise a
    // fake/non-GitHub-provider caller with a matching CODEOWNER user
    // unexpectedly spawns a live gh process (Codex review, PR #2429).
    (login) => {
      const result = port.getCollaboratorPermission(login);
      if (result.outcome === 'not-collaborator') {
        throwSyntheticGhNotFound();
      }
      if (result.outcome === 'error') {
        throw new Error(result.error.message);
      }
      return result.permission;
    },
  );
  const viewerTeamSlugs = resolveViewerClassicBypassTeamSlugs(
    port,
    owner,
    viewerLogin,
    branchProtection,
  );

  const collaboratorTrustEnabled = readCollaboratorTrustEnabled(iddConfig);
  // kurone-kito/idd-skill#3250: the shared composition -- see
  // `buildEffectiveTrustedMarkerLogins`'s own doc comment for why the
  // collaborator-marker-trust discovery itself stays file-local
  // (`resolveTrustedCollaboratorMarkerLogins`, loop-safety wrapped) while
  // only the final combine step is shared.
  const trustedMarkerLogins = buildEffectiveTrustedMarkerLogins({
    viewerLogin,
    configuredTrustedActors,
    collaboratorMarkerLogins: collaboratorTrustEnabled
      ? resolveTrustedCollaboratorMarkerLogins(port, [
          ...comments,
          ...claimComments,
        ])
      : [],
  });

  // kurone-kito/idd-skill#3328: out-of-loop membership check. Only
  // evaluated when claimless AND (the PR actually has closing references
  // OR the field itself could not be read) -- the common claimless case
  // (a genuinely empty closing-reference array) keeps the unchanged #2017
  // fast path below (`out-of-loop-claimless`, deriving
  // `closingIssueNumbers: []` the same way `classifyPrLoopMembership`
  // itself does). `closingRefsAtEntry` is the raw, as-fetched
  // `closingIssuesReferences` this file recorded at collection entry,
  // before `comments`/`trustedMarkerLogins` existed to classify against;
  // `closingRefsReadable` is checked here too (Copilot review, PR #3421)
  // so an unreadable field reaches the classifier (as `null`, fail-closed)
  // instead of silently skipping classification via the coerced array's
  // now-vacuous `.length > 0`.
  let outOfLoopMembership: PrLoopMembershipResult | null = null;
  if (
    args.claimless &&
    (!closingRefsReadable || closingRefsAtEntry.length > 0)
  ) {
    // C1 critique pass (live-reproduced) + Copilot review, PR #3421: a
    // same-repo-only extraction fed straight to the classifier would
    // silently read a cross-repo-only, partially-unresolvable, or
    // unreadable closing reference as "no closing references", accepting
    // --claimless with NO marker required for a PR the pre-#3328 code
    // always refused. resolveClosingIssueNumbersForClassifier reports
    // `null` (unreadable) for exactly those cases instead, which the
    // classifier fails closed to `in-loop` for -- reproducing the
    // original refusal. Pass the RAW value (not the coerced
    // `closingRefsAtEntry`) so the function's own `Array.isArray` check
    // sees the real shape.
    const closingIssueNumbers = resolveClosingIssueNumbersForClassifier(
      snapshot.closingIssuesReferences,
      owner,
      repo,
    );
    // kurone-kito/idd-skill#3328 (C1 critique pass, round 2): the claimed
    // path's own collaborator-trust auto-discovery scans BOTH the PR's
    // comments and the claimed issue's comments (`claimComments` above) --
    // but under --claimless, `claimComments` is always `[]`, so a
    // collaborator whose only claim comment lives on the CLOSING issue
    // (never the PR) was invisible to `trustedMarkerLogins`, silently
    // reading their real active claim as untrusted noise and letting a
    // marker wrongly override it. Read each closing issue's comments once
    // here, and when collaborator trust is enabled, fold the same
    // discovery over them too before resolving claim state -- restoring
    // the "an active claim always wins over a marker" invariant this file
    // documents. Any read failure fails the whole check closed to
    // `'unknown'`, the same way a single-issue read failure already did.
    const closingIssueCommentsByNumber = new Map<
      number,
      IssueCommentPayload[]
    >();
    let closingIssueReadFailed = false;
    for (const issueNumber of closingIssueNumbers ?? []) {
      try {
        closingIssueCommentsByNumber.set(
          issueNumber,
          port.listWorkItemComments(issueNumber).map(toIssueCommentPayload),
        );
      } catch {
        closingIssueReadFailed = true;
        break;
      }
    }
    const closingIssueTrustedMarkerLogins =
      !closingIssueReadFailed && collaboratorTrustEnabled
        ? normalizeTrustedMarkerLogins([
            ...trustedMarkerLogins,
            ...resolveTrustedCollaboratorMarkerLogins(
              port,
              [...closingIssueCommentsByNumber.values()].flat(),
            ),
          ])
        : trustedMarkerLogins;
    const isTrustedIssueAuthor = (login: string): boolean =>
      closingIssueTrustedMarkerLogins.includes(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      );
    let closingIssueClaimState: PrClosingIssueClaimState =
      closingIssueReadFailed ? 'unknown' : 'none';
    if (!closingIssueReadFailed) {
      for (const issueComments of closingIssueCommentsByNumber.values()) {
        if (
          resolveActiveClaim(
            issueComments.map(normalizeComment),
            isTrustedIssueAuthor,
          )
        ) {
          closingIssueClaimState = 'present';
          break;
        }
      }
    }
    outOfLoopMembership = classifyPrLoopMembership({
      prNumber: args.prNumber,
      closingIssueNumbers,
      closingIssueClaimState,
      prComments: normalizedComments,
      // The extended set (folding in any closing-issue-comment-discovered
      // collaborator) is a strict superset of `trustedMarkerLogins` -- safe
      // to reuse here too: it only ever widens who is trusted, never
      // narrows, and using one consistent trust set for both the claim
      // check above and this marker check avoids the two sub-decisions
      // silently disagreeing on who counts as trusted.
      trustedMarkerLogins: closingIssueTrustedMarkerLogins,
    });
    if (outOfLoopMembership.membership === 'in-loop') {
      throw new Error(
        `--claimless requires a PR with no closingIssuesReferences, or a ` +
          `valid out-of-loop marker; pass --claim-issue instead (${outOfLoopMembership.reason})`,
      );
    }
  }

  const iddAgentLogins = deriveIddAgentLogins({
    viewerLogin,
    iddAgentLogins: splitCsv(args.iddAgentLogins),
    trustedMarkerLogins,
    operationalComments: [...comments, ...claimComments],
  });
  // #3269: bounded second-pass GraphQL fetch, scoped to only advisory-bot
  // thread comments edited after their thread's latest IDD disposition
  // (see `selectAdvisoryThreadCommentIdsEditedAfterDisposition`'s own doc
  // comment) -- so `dispositionEvidence` below can verify a cosmetic edit
  // (e.g. CodeRabbit's own comment-to-reply marker rewrite) and date it by
  // content activity instead of `updatedAt`, which also moves on IDD's
  // own hide-on-supersede minimization (kurone-kito/idd-skill#3173). The
  // `isDispositionAuthor` predicate here MUST match
  // `summarizeDispositionEvidenceForGate`'s own (via
  // `buildPreMergeReadinessSummary`'s `iddAgentLogins`/`trustedMarkerLogins`
  // options), or candidate selection and freshness evaluation could
  // disagree about which comment anchors "the disposition". A fetch
  // failure degrades to no enrichment (today's `updatedAt` dating)
  // rather than failing this whole collector.
  const baseNormalizedThreads = threads.map(normalizeThread);
  const dispositionAuthorLoginSet = new Set([
    ...iddAgentLogins,
    ...trustedMarkerLogins,
  ]);
  const editHistoryCandidateIds =
    selectAdvisoryThreadCommentIdsEditedAfterDisposition(
      baseNormalizedThreads,
      {
        isDispositionAuthor: (login) => dispositionAuthorLoginSet.has(login),
        advisoryBotLogins,
      },
    );
  let editHistories: ProviderReviewThreadCommentEditHistory[] = [];
  if (editHistoryCandidateIds.length > 0) {
    try {
      editHistories = port.getReviewThreadCommentUserContentEdits(
        editHistoryCandidateIds,
      );
    } catch {
      // Fail closed to no enrichment -- every affected comment keeps
      // today's `updatedAt` dating (see
      // `resolveThreadCommentRevisionDatingOutcome`'s own "unverifiable"
      // outcome for an absent/incomplete history, protocol-helpers.mts).
    }
  }
  // Called unconditionally (even with an empty `editHistories`): returns
  // `baseNormalizedThreads` UNCHANGED (same reference) when there is
  // nothing to attach, so this is never more than a no-op enrichment pass
  // in that case, and keeps `normalizedThreads`'s inferred type the same
  // (structurally `ThreadLike[]`) regardless of which branch above ran.
  const normalizedThreads = attachReviewThreadCommentEditHistories(
    baseNormalizedThreads,
    editHistories,
  );
  const advisoryWaitPolicy = resolveAdvisoryWaitPolicy(advisoryWaitConfig);
  const primaryBotLogin = resolveAdvisoryPrimaryBotLogin(advisoryWaitConfig);
  const forcedHandoffPolicy = normalizePolicyConfig(iddConfig).forcedHandoff;
  const forcedHandoffAuthorityPolicy = forcedHandoffPolicy.authorityPolicy;
  const forcedHandoffEnabled = forcedHandoffPolicy.mode === 'human-gated';
  // #3298: fetched unconditionally now (previously only under
  // forcedHandoffEnabled below) -- the closing-set gate's stray-commit-close
  // scan needs this same `pulls/{pr}/commits` listing on every call, not
  // only when forced handoffs are enabled, so this one read backs both
  // prFirstCommitAt and closingSet.strayCommitCloses instead of each
  // resolving its own copy. `null` means the read failed; both downstream
  // consumers already have their own fail-closed handling for that.
  let prCommits: PrCommitPayload[] | null = null;
  try {
    const rawCommits = port.listChangeRequestCommits(args.prNumber);
    // Copilot review, PR #3353: `listChangeRequestCommits` is declared
    // `unknown[]` on the provider port, but nothing enforces that at
    // runtime -- a malformed/non-array successful response would silently
    // pass the `as PrCommitPayload[]` cast (a compile-time-only promise),
    // then crash `computeClosingSetEvidence`'s own `.length`/iteration
    // (uncaught, outside this try/catch) instead of producing the
    // documented `closingSet.status: "unavailable"`. Validate the shape
    // here so any non-array response fails closed the same way a thrown
    // read already does.
    prCommits = Array.isArray(rawCommits)
      ? (rawCommits as PrCommitPayload[])
      : null;
  } catch {
    prCommits = null;
  }
  // The PR's first-commit time backs the Part B forced-handoff rule (#1058):
  // a legitimate issue-only handoff that predates the PR is honored even
  // against a PR-backed claim. This allowance is applied on the merge side
  // only; resume-claim-routing.mts intentionally never passes prFirstCommitAt
  // (an issue-only handoff against a PR-backed claim stays rejected there) —
  // the merge-only half of the documented strict-resume vs. lenient-relay-merge
  // split (see docs/idd-design-rationale.md, "Claim resolution"). Resolve it
  // only when forced handoffs are enabled and the commit list actually read,
  // and fail closed to `null` (reject) otherwise so a transient commits-API
  // failure never aborts the readiness gate.
  const prFirstCommitAt: string | null =
    forcedHandoffEnabled && prCommits
      ? resolvePrFirstCommitAt(prCommits)
      : null;
  // #3298: the *live* repository default branch, matching D3.5's own
  // non-default-branch exemption -- distinct from developmentBranchTarget's
  // *configured* development-branch value above (a configured
  // developmentBranch implies nothing about GitHub's own default branch,
  // which is what closingIssuesReferences actually keys its population on).
  // Reuses `liveDefaultBranch` when it already resolved this exact call
  // (developmentBranchInspection status 'absent'); otherwise a fresh,
  // fail-closed-to-null read (unlike developmentBranchTarget's own
  // uncaught-throw contract) since closingSet needs an 'unavailable' status
  // here instead of crashing the whole collector.
  let closingSetLiveDefaultBranch: string | null = liveDefaultBranch;
  if (closingSetLiveDefaultBranch === null) {
    try {
      const rawDefaultBranch = port.getRepositoryDefaultBranch(owner, repo);
      // Copilot review, PR #3353: the port's declared `string | null`
      // return type is a compile-time promise only -- validate it here too
      // (same rationale as the commits-array guard above), so a
      // non-conforming provider implementation fails closed instead of
      // handing a non-string value to the `baseRefName !==
      // liveDefaultBranch` comparison below.
      closingSetLiveDefaultBranch =
        typeof rawDefaultBranch === 'string' ? rawDefaultBranch : null;
    } catch {
      closingSetLiveDefaultBranch = null;
    }
  }
  // #3298: the deliberate closing set -- --closing-issues when given
  // (parseArgs already validated it includes the claimed issue and does
  // not combine with --claimless), else the single claimed issue, else
  // empty under --claimless. kurone-kito/idd-skill#3328: an
  // `out-of-loop-authorized` PR is the one exception to the plain
  // --claimless "[]" default -- it carries no claim-derived deliberate
  // set to diff against, so the valid marker authorizes exactly the PR's
  // own live `closingIssuesReferences` instead (the same same-repo
  // extraction the membership check above already ran). A malformed or
  // cross-repo entry still fails `computeClosingSetEvidence` closed to
  // `'unavailable'`/`'mismatch'` regardless of this expected set (its own
  // malformed-entry and cross-repo-`extra` checks run unconditionally), and
  // `missing` is structurally empty on this path since `expected` is
  // always a subset of the same-repo `actual` numbers by construction --
  // there is no separate "should have closed but didn't" question left to
  // ask once a marker authorizes the PR's own declared closing set.
  const expectedClosingIssues =
    args.closingIssueNumbers ??
    (args.claimless
      ? outOfLoopMembership?.membership === 'out-of-loop-authorized'
        ? extractSameRepoClosingIssueNumbers(closingRefsAtEntry, owner, repo)
        : []
      : [args.claimIssueNumber as number]);
  const closingSetEvidence = computeClosingSetEvidence({
    expected: expectedClosingIssues,
    closingIssuesReferences: snapshot.closingIssuesReferences,
    owner,
    repo,
    baseRefName,
    liveDefaultBranch: closingSetLiveDefaultBranch,
    commits: prCommits,
  });
  const forcedHandoffPermissionCache: CollaboratorPermissionCache = new Map();
  const waivableCheckSelectors = readWaivableCheckSelectors(iddConfig);
  const externalCheckWaiverMaxValidity =
    readExternalCheckWaiverMaxValidity(iddConfig);
  const externalCheckWaiverMode = readExternalCheckWaiverMode(iddConfig);
  const externalCheckWaiverAuthorityPolicy =
    readExternalCheckWaiverAuthorityPolicy(iddConfig);
  const trustSourcePinnedRequiredChecks =
    readTrustSourcePinnedRequiredChecks(iddConfig);
  const staleAgeMs = readClaimStaleAgeMs(iddConfig);
  const now = args.now || new Date().toISOString().replace('.000Z', 'Z');
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
  // kurone-kito/idd-skill#3253: a sibling fetch, not an extension of the one
  // above -- fail-closed to `''` on any failure, never throws (see
  // `fetchHeadObservedAt`'s own doc comment), so unlike the sibling fetch
  // above this one is safe to leave uncaught without masking a fetch
  // failure as an empty anchor.
  const advisoryConvergenceHeadObservedAt = fetchHeadObservedAt(
    owner,
    repo,
    args.prNumber,
    port,
  );
  const advisoryConvergenceDeadlineMinutes =
    resolveAdvisoryConvergenceDeadlineMinutes(advisoryWaitConfig);
  const secondaryQuietWindowMinutes =
    resolveAdvisorySecondaryQuietWindowMinutes(advisoryWaitConfig);
  const secondaryBotLogins =
    resolveAdvisorySecondaryBotLogins(advisoryWaitConfig);

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
  // #2554: shortens the terminal-unavailability window below to
  // `advisoryWait.providerOutage.terminalWindow` only while an active
  // repository-scoped outage declaration covers the SAME
  // `idd-advisory-convergence` selector that
  // `resolveAdvisoryConvergenceOutageRelief` (further below) independently
  // re-resolves for its own waiver-relief purpose. A second, independent
  // fetch here -- rather than sharing that function's result -- matches
  // this file's own established tolerance for independent per-consumer
  // evidence collection (see `lastCopilotCommit`'s doc comment above:
  // "tolerable by construction ... any disagreement fails closed"). Fails
  // closed to `false` on ANY error, exactly like
  // `resolveAdvisoryConvergenceOutageRelief`: a transient fetch failure
  // must never shorten the terminal-unavailability window this gates.
  //
  // Skipped entirely when no override is configured (Copilot review, PR
  // #2564 round 3): `resolveEffectiveAdvisoryTerminalWindowMinutes` returns
  // the base window regardless of `declarationActive` when
  // `advisoryWait.providerOutage.terminalWindow` is unset, so the live
  // fetch would be pure overhead -- and an avoidable failure/rate-limit
  // surface -- on every readiness run for a repository that never
  // configured this feature.
  const providerOutageTerminalWindowOverrideMinutes =
    resolveProviderOutageTerminalWindowMinutes(advisoryWaitConfig);
  const outageDeclarationActiveForTerminalWindow =
    providerOutageTerminalWindowOverrideMinutes !== null
      ? resolveOutageDeclarationActiveForConvergenceSelector({
          port,
          owner,
          repo,
          iddConfig,
          now,
        })
      : false;
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments: normalizedComments, prHeadSha, lastCopilotCommit },
    {
      now,
      trustedMarkerLogins,
      claimId: args.expectedClaimId,
      agentId: args.expectedAgentId,
      recoveryCycleCap: resolveAdvisoryRecoveryCycleCap(advisoryWaitConfig),
      terminalWindowMinutes: resolveEffectiveAdvisoryTerminalWindowMinutes({
        config: advisoryWaitConfig,
        declarationActive: outageDeclarationActiveForTerminalWindow,
      }),
    },
  );
  const copilotUnavailable = copilotRecovery.state === 'COPILOT_UNAVAILABLE';
  const advisoryConvergenceOutageRelief =
    resolveAdvisoryConvergenceOutageRelief({
      port,
      owner,
      repo,
      iddConfig,
      copilotUnavailable,
      waivableCheckSelectors,
      now,
    });

  // kurone-kito/idd-skill#2911: independent evidence for
  // `buildPreMergeReadinessSummary`'s `staleSelfWaiver` blocker
  // (protocol-helpers.mts) -- see that computation's own doc comment for
  // the full rationale. Performed here (the I/O collector), not inside
  // that pure function, mirroring this file's own established precedent
  // for `copilotUnavailable` above ("precompute here rather than inside
  // `buildPreMergeReadinessSummary`, which cannot import X without an
  // import cycle" -- `advisory-convergence.mts` already imports FROM
  // `protocol-helpers.mts`, so the reverse would cycle).
  //
  // A local, independently-valued bound rather than importing
  // `advisory-convergence.mts`'s own `MAX_AUTO_WAIVER_RUN_LOOKUPS`: that
  // constant is declared inside `collectFromGitHub`'s own function body --
  // exactly the area kurone-kito/idd-skill#2912 (open now, claimed by a
  // different session) is expected to rewrite for the same-repository
  // bearer-evidence provenance gap. Keeping this bound independent avoids
  // a rebase collision there; the two files must already agree on the
  // same value by convention, not by import.
  const MAX_PRE_MERGE_AUTO_WAIVER_RUN_LOOKUPS = 20;

  // #2657/#2911: the same raw `helperRuntime.profile` config field
  // `advisory-convergence.mts`'s own `collectFromGitHub` reads directly --
  // `normalizePolicyConfig` does not carry `helperRuntime` through its
  // normalized shape (that section is validated, not defaulted,
  // elsewhere), and `IddConfig`'s index signature already types this
  // access as `unknown` with no cast needed.
  const rawHelperRuntime = iddConfig?.helperRuntime;
  const helperRuntimeProfile =
    rawHelperRuntime &&
    typeof rawHelperRuntime === 'object' &&
    typeof (rawHelperRuntime as { profile?: unknown }).profile === 'string'
      ? (rawHelperRuntime as { profile: string }).profile
      : undefined;
  const repositoryFullName = owner && repo ? `${owner}/${repo}` : '';

  // The load-bearing security boundary (kurone-kito/idd-skill#2911's
  // decisive finding): fetched independently from THIS PR's own live
  // diff, never from any comment body, so a forged marker can only ever
  // affect a PR that already, genuinely touches the checker allowlist --
  // same mitigation `autoWaiverValid` (advisory-convergence.mts) already
  // relies on for the identical bearer-evidence gap. Reuses the
  // ALREADY-FETCHED `changedFiles` above (no extra round-trip) plus a
  // renamed-from-paths fetch, mirroring `collectFromGitHub`'s own merge
  // of both sources exactly (a rename-shaped checker repair away from an
  // allowlisted path must still be recognized).
  const selfReferentialTriggerFiles = resolveSelfReferentialTriggerFiles(
    helperRuntimeProfile,
    repositoryFullName,
  );
  const changedFilesTouchSelfReferentialAllowlist = changedFiles.some((path) =>
    selfReferentialTriggerFiles.includes(String(path)),
  );
  // kurone-kito/idd-skill#2911 (Codex + CodeRabbit review, PR #2915): the
  // renamed-from-paths lookup is a separate paginated `pulls/.../files`
  // request that duplicates the `changedFiles` fetch above, and its
  // result can only ever matter for a PR that (a) doesn't already prove
  // the allowlist touch via `changedFiles` alone AND (b) carries at
  // least one self-referential-bootstrap-auto marker candidate -- if
  // neither the ordinary case (no marker at all) nor this case applies,
  // `touchesSelfReferentialAllowlist`'s value can never affect the
  // report either way, so skip the extra round-trip entirely. Cheap: the
  // candidate scan below only re-uses `normalizedComments`, already
  // fetched, no extra call. Wrapped in try/catch -- unlike every OTHER
  // unguarded port call earlier in this collector, this one specifically
  // sits behind an opt-in security gate that most PRs never need at all,
  // so a transient failure here must not abort report generation for
  // PRs the gate was never going to affect; fails to `[]` (never widens
  // trust, matches `getWorkflowRun`'s own fail-closed-to-untrusted
  // direction below).
  const hasAnySelfReferentialMarkerCandidate = normalizedComments.some(
    (comment) =>
      /^<!--\s*idd-external-check-waiver:/i.test(comment.body) &&
      comment.author.login.trim().toLowerCase() === 'github-actions[bot]',
  );
  let selfReferentialRenamedFromPaths: string[] = [];
  if (
    !changedFilesTouchSelfReferentialAllowlist &&
    hasAnySelfReferentialMarkerCandidate
  ) {
    try {
      selfReferentialRenamedFromPaths = port
        .listChangeRequestRenamedFromPaths(args.prNumber)
        .filter(Boolean);
    } catch {
      selfReferentialRenamedFromPaths = [];
    }
  }
  const touchesSelfReferentialAllowlist =
    changedFilesTouchSelfReferentialAllowlist ||
    selfReferentialRenamedFromPaths.some((path) =>
      selfReferentialTriggerFiles.includes(String(path)),
    );

  // Bounded scan for self-referential-bootstrap-auto candidate markers
  // bound to this PR's own HEAD, mirroring `collectFromGitHub`'s own
  // anti-flood budget (20, capped) but NOT its earliest-first tie-break:
  // no selection order fully closes the flood problem, and
  // `verifySelfReferentialBootstrapWaiverRun` below still requires
  // independent Actions-run verification regardless of what this
  // prefilter selects, but the two call sites correlate against
  // different moments in time, so the same tie-break direction is wrong
  // for this one. `collectFromGitHub` evaluates the marker for the
  // checker's OWN in-flight run (implicitly "now"); this call site
  // instead correlates against `passingCompletedAtMs` -- the ALREADY-
  // SELECTED newest required-check instance's own `completedAt`, itself
  // already the most recent of however many reruns exist for this HEAD
  // (kurone-kito/idd-skill#2911, Codex review on PR #2915, P1): on a
  // checker-touching PR that sits on one HEAD long enough to accumulate
  // more than this 20-candidate budget's worth of bootstrap-auto
  // markers, an earliest-first cap would keep only the OLDEST
  // candidates -- exactly the ones LEAST likely to correlate with the
  // most-recent-required-check-instance's `completedAt` -- starving
  // `autoWaiverRunVerified` of the one marker that actually needs
  // checking and letting the report incorrectly stay `ready`. Newest-
  // first keeps the candidates most likely to cover that recent
  // instance instead.
  const autoWaiverRunVerified: Record<string, boolean> = {};
  // kurone-kito/idd-skill#2911 (Copilot review, PR #2915): the scan below
  // and its up-to-20 `getWorkflowRun` lookups are pure overhead whenever
  // `touchesSelfReferentialAllowlist` is false -- `buildPreMergeReadinessSummary`
  // never even reaches this evidence in that case (its own `staleSelfWaiver`
  // computation is unconditionally gated on the identical flag). Skipping
  // the whole block here means an ordinary PR (the overwhelming majority,
  // which never touches the checker allowlist at all) can never have a
  // flood of bot-authored comments force wasted provider round-trips no
  // matter how many it posts. This does not also gate on the mode-open/
  // selector-waivable preconditions `buildPreMergeReadinessSummary` checks
  // (those live behind private matching helpers in `protocol-helpers.mts`
  // this file deliberately avoids importing, to keep this file's footprint
  // minimal where kurone-kito/idd-skill#2912 is concurrently working) --
  // the residual is bounded and harmless: at most 20 avoidable
  // `getWorkflowRun` calls, only on the narrower set of PRs that already,
  // genuinely touch the allowlist.
  if (touchesSelfReferentialAllowlist) {
    // kurone-kito/idd-skill#2911 (Copilot review, PR #2915): keyed by
    // `runId` (a Map, not an array + Set) so a SECOND comment citing an
    // already-seen run id UPDATES that candidate's `createdAt` to the
    // newer value instead of being silently dropped -- the same run can
    // legitimately post more than one marker comment over its own
    // lifetime (e.g. a retry within the run), and comments are typically
    // returned oldest-first, so keeping only the first occurrence would
    // anchor that candidate to a stale timestamp and could wrongly push
    // it out of the newest-first bounded window under a flood.
    const autoWaiverRunIdCandidates = new Map<string, string>();
    const prHeadShaLower = prHeadSha.toLowerCase();
    for (const comment of normalizedComments) {
      const body = comment.body;
      if (!/^<!--\s*idd-external-check-waiver:/i.test(body)) continue;
      const authorLogin = comment.author.login.trim().toLowerCase();
      if (authorLogin !== 'github-actions[bot]') continue;
      const parsed = parseExternalCheckWaiverComment(body, comment.createdAt);
      // kurone-kito/idd-skill#2911: mirrors `collectFromGitHub`'s own
      // prefilter conditions verbatim -- a canonical positive-integer
      // run-id (never percent-decoded/sanitized attacker text reaching
      // `getWorkflowRun`'s REST path unvalidated), an EXACT (never glob)
      // checkSelector match, and this PR's own current HEAD -- before a
      // candidate is ever eligible to spend part of the bounded lookup
      // budget.
      if (
        parsed &&
        parsed.reason === SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON &&
        parsed.checkSelector === DEFAULT_ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
        parsed.runId &&
        parseCanonicalIntegerOrNull(parsed.runId) !== null &&
        String(parsed.headSha ?? '')
          .trim()
          .toLowerCase() === prHeadShaLower
      ) {
        const existingCreatedAt = autoWaiverRunIdCandidates.get(parsed.runId);
        if (
          existingCreatedAt === undefined ||
          comment.createdAt.localeCompare(existingCreatedAt) > 0
        ) {
          autoWaiverRunIdCandidates.set(parsed.runId, comment.createdAt);
        }
      }
    }
    const boundedAutoWaiverRunIds = [...autoWaiverRunIdCandidates]
      .map(([runId, createdAt]) => ({ runId, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_PRE_MERGE_AUTO_WAIVER_RUN_LOOKUPS)
      .map((candidate) => candidate.runId);
    for (const runId of boundedAutoWaiverRunIds) {
      try {
        const raw = port.getWorkflowRun(owner, repo, runId) as {
          path?: string | null;
          head_sha?: string | null;
          head_repository?: { full_name?: string | null } | null;
          event?: string | null;
        };
        autoWaiverRunVerified[runId] = verifySelfReferentialBootstrapWaiverRun(
          {
            path: raw?.path ?? null,
            headSha: raw?.head_sha ?? null,
            repositoryFullName: raw?.head_repository?.full_name ?? null,
            event: raw?.event ?? null,
          },
          {
            path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
            headSha: prHeadSha,
            repositoryFullName,
          },
        );
      } catch {
        // Fail closed per run id -- untrusted: a lookup failure (unknown
        // run, transient API error) must never widen trust, and must
        // never crash this whole evidence collector either. This is the
        // deliberate fail-open-for-staleness direction documented on
        // `buildPreMergeReadinessSummary`'s `staleSelfWaiver` computation:
        // an unverified run suppresses the blocker rather than firing it.
        autoWaiverRunVerified[runId] = false;
      }
    }
  }

  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      comments: normalizedComments,
      reviews: normalizedReviews,
      threads: normalizedThreads,
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
      // kurone-kito/idd-skill#3330: the empty-closing-refs fast path is
      // out-of-loop-claimless. A classified run forwards that verdict.
      // Every other run omits it, so the consumer fails closed to in-loop.
      loopMembership: args.claimless
        ? (outOfLoopMembership?.membership ?? 'out-of-loop-claimless')
        : undefined,
      includeDispositionEvidence: true,
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      developmentBranchTarget,
      closingSet: closingSetEvidence,
      copilotUnavailable,
      // kurone-kito/idd-skill#2919: caller-precomputed by the enrichment
      // block above -- see its doc comment for the full rationale.
      advisoryConvergenceIdentityUnresolved,
      // kurone-kito/idd-skill#3256: caller-precomputed by the same
      // enrichment block above -- see its doc comment for the full
      // rationale.
      advisoryConvergenceNonTargetEventOnly,
      advisoryConvergenceOutageRelieved:
        advisoryConvergenceOutageRelief.relieved,
      advisoryConvergenceOutageRelievedSince:
        advisoryConvergenceOutageRelief.since,
      advisoryConvergenceHeadCommittedAt,
      advisoryConvergenceHeadObservedAt,
      advisoryConvergenceDeadlineMinutes,
      secondaryQuietWindowMinutes,
      secondaryBotLogins,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity,
      externalCheckWaiverMode,
      externalCheckWaiverAuthorityPolicy,
      resolveWaiverAuthority: (
        login: string,
      ): ExternalCheckWaiverAuthorityLookup =>
        port.getCollaboratorPermission(login),
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
      touchesSelfReferentialAllowlist,
      autoWaiverRunVerified,
    },
  );

  return {
    ...summary,
    trustedMarkerActors: configuredTrustedActors,
    trustedMarkerActorsSource,
  } as PreMergeReadinessReport;
}

// #2707: a caller that repeats this invocation until F2 is ready (directly,
// or via a delegated worker's polling loop) must be able to distinguish a
// call-time argument/usage error from an ordinary "not ready yet" readiness
// report -- both used to be indistinguishable-by-default (an uncaught
// exception left an unhandled stack trace on stderr and a non-JSON stdout,
// easy to conflate with a transient not-ready state if the caller only
// checks the exit code). `hint` is populated only for the specific error
// this arose from (the missing --claim-issue/--claimless case); other
// thrown errors surface with `error` alone.
export function renderCliUsageError(error: unknown): {
  error: string;
  hint?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('missing required --claim-issue')) {
    return {
      error: message,
      hint:
        'pass --claim-issue <issue-number> (with --claim-id), or --claimless ' +
        'for a PR with no closingIssuesReferences',
    };
  }
  return { error: message };
}

// CLI: emit the readiness report as JSON when invoked directly.
if (import.meta.main) {
  // #3342: call main() directly when the envelope is disabled, for the
  // same uniform pattern every migrated helper's own trigger uses -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment. Moot in
  // practice for this file specifically: main()'s own try/catch below
  // never lets an exception escape uncaught, so there is no raw crash
  // text for the runHelperCli-added-frame concern to affect here.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('pre-merge-readiness', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

// #3342: this file already had a top-level catch that renders its own
// `{"error": ...}` stdout JSON and exits 1 on any failure -- unlike the
// other five migrated helpers, which have no existing catch and let
// `runHelperCli` classify a thrown error itself. Classifying the SAME
// error here (via `classifyHelperError`) and reporting it as an outcome
// object keeps that exact existing rendering unchanged while still
// giving `runHelperCli` a real `kind` (e.g. `transport` for a `gh: HTTP
// 503` failure, the #2806 ambiguity this whole issue exists to remove)
// instead of the generic `gate` it would otherwise assign to any
// returned non-zero exit code.
function main(): HelperCliResult {
  try {
    process.stdout.write(
      `${JSON.stringify(collectPreMergeReadiness(process.argv.slice(2)), null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(renderCliUsageError(error), null, 2)}\n`,
    );
    const classified = classifyHelperError(error);
    return {
      exitCode: 1,
      kind: classified.kind,
      message: classified.message,
      httpStatus: classified.httpStatus,
    };
  }
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
      throw markCliUsageError(new Error(`invalid ${flagName} value: ${token}`));
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
    throw markCliUsageError(
      new Error('--claimless cannot be combined with --claim-issue'),
    );
  }
  if (claimless && claimId) {
    throw markCliUsageError(
      new Error('--claimless cannot be combined with --claim-id'),
    );
  }

  // #3298: --closing-issues declares the deliberate multi-issue closing set
  // (idd-pr-submit.instructions.md's "Multiple closing issues" case) for
  // the closing-set merge gate. A usage error here (not a fail-closed
  // blocker) since it is a call-time contract violation, matching the
  // --claimless combination checks immediately above.
  const closingIssuesToken = values['closing-issues'] as string | undefined;
  let closingIssueNumbers: number[] | null = null;
  if (closingIssuesToken !== undefined) {
    if (claimless) {
      throw markCliUsageError(
        new Error('--closing-issues cannot be combined with --claimless'),
      );
    }
    closingIssueNumbers = closingIssuesToken.split(',').map((token) => {
      const trimmed = token.trim();
      if (!/^[1-9]\d*$/.test(trimmed)) {
        throw markCliUsageError(
          new Error(`invalid --closing-issues value: ${closingIssuesToken}`),
        );
      }
      return Number(trimmed);
    });
    const claimIssueNumber = requirePositiveInteger(
      values['claim-issue'] as string | undefined,
      '--claim-issue',
    );
    if (
      claimIssueNumber !== null &&
      !closingIssueNumbers.includes(claimIssueNumber)
    ) {
      throw markCliUsageError(
        new Error(
          `--closing-issues must include the claimed issue number ${claimIssueNumber}`,
        ),
      );
    }
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
    closingIssueNumbers,
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
  --claimless      skip claim fetch/revalidation (#2017). For a PR whose
                    closingIssuesReferences is empty, or (#3328) one that
                    carries a valid, trusted, unedited <!-- idd-out-of-loop:
                    ... reason:bootstrap ... --> marker naming this PR and
                    whose closing issue(s) have no active claim; cannot
                    combine with --claim-issue or --claim-id.
                    Claim-ownership in the report is the not-applicable /
                    unclaimed shape.
  --closing-issues <n>[,<n>...]  (#3298) the deliberate multi-issue closing
                    set for the closing-set merge gate; must include
                    --claim-issue's own number. Cannot combine with
                    --claimless. Omit to use the single claimed issue (or
                    the empty set under --claimless) as the deliberate set.
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
    // #3246: passthrough only -- `undefined` for every caller that did not
    // request `includeEditState` from the port, unchanged from before this
    // field existed.
    last_edited_at: comment.lastEditedAt,
  };
}

export function normalizeComment(comment: IssueCommentPayload) {
  return {
    id: String(comment.id ?? ''),
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    updatedAt: comment.updated_at ?? comment.created_at ?? '',
    // #3246: carried through to the `CommentLike` shape
    // `summarizeExternalCheckWaivers` reads (protocol-helpers.mts) --
    // never derived from `updatedAt`/`updated_at`.
    lastEditedAt: comment.last_edited_at,
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
    author: {
      login: review.user?.login ?? '',
      // #3262: `findLastCopilotReviewCommit` reads `author.type` for the
      // bare-login vs `[bot]`-suffix match. Dropping it here made a
      // configured `[bot]` login fail closed on this REST path.
      type: review.user?.type ?? null,
    },
    state: review.state ?? '',
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
    body: review.body ?? '',
  };
}

/**
 * Normalize a `ProviderPort.listChangeRequestReviewThreadsWithComments`
 * node into the summarizer-shape `ThreadLike`. Exported for direct unit
 * testing (#1708), see {@link normalizeComment}'s doc comment.
 * `reviewerReopenedAt` is omitted (`ThreadLike`'s field is optional): the
 * pre-migration GraphQL query never selected it at all
 * (`inferReviewerReopenedAt` always returned `''`). `id` (#2696) is
 * threaded through -- it feeds `dispositionEvidence.missingThreads[].id`,
 * which a caller reads to identify which live thread to reply to; dropping
 * it forced a separate positional lookup to recover the real thread.
 * Each comment's own `id` and `lastEditedAt` (#3269) are threaded through
 * too -- `id` lets `selectAdvisoryThreadCommentIdsEditedAfterDisposition`
 * name a candidate comment for the bounded `userContentEdits` fetch, and
 * `lastEditedAt` (already returned by the port since #3246, but never
 * mapped into this shape until #3269) is what
 * `effectiveThreadCommentActivityAt` reads to tell a genuinely unedited
 * comment from an edited one at all.
 */
export function normalizeThread(thread: ProviderReviewThreadWithComments) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: thread.comments.map((comment) => ({
        id: comment.id,
        author: { login: comment.authorLogin },
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt || comment.createdAt,
        pullRequestReview: { id: comment.pullRequestReviewId ?? null },
        lastEditedAt: comment.lastEditedAt,
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
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
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

// #2373: takes the already-resolved trusted-ref config (see
// `collectPreMergeReadiness`'s own `iddConfig` resolution) instead of
// reading `.github/idd/config.json` locally -- `normalizePolicyConfig`/
// `resolveCollaboratorMarkerTrust` already treat `null` (and a malformed
// shape within a valid object) as "unconfigured", so no try/catch is
// needed here now that the fetch itself owns the fail-closed contract.
function readCollaboratorTrustEnabled(iddConfig: IddConfig | null): boolean {
  return resolveCollaboratorMarkerTrust(
    iddConfig,
    process.env.IDD_TRUST_COLLABORATOR_MARKERS,
  );
}

// Configured waivable external-check selectors (`ciGate.externalChecks.
// waivable`). The F2 gate only lets a valid waiver fold a check into
// `requiredChecksPassing` when that check sits on this surface; an absent
// config yields an empty list (nothing waivable).
function readWaivableCheckSelectors(iddConfig: IddConfig | null): {
  selector?: unknown;
  matchMode?: unknown;
}[] {
  return [...normalizePolicyConfig(iddConfig).ciGate.externalChecks.waivable];
}

// Configured external-check waiver validity window (`ciGate.
// externalCheckWaivers.maxValidity`). The consume side re-enforces it so a
// waiver whose `expiresAt - createdAt` outlives the policy window cannot count
// as valid. `normalizePolicyConfig` already defaults this to `PT24H`; an
// absent config falls back to the same authoring default.
function readExternalCheckWaiverMaxValidity(
  iddConfig: IddConfig | null,
): string {
  return normalizePolicyConfig(iddConfig).ciGate.externalCheckWaivers
    .maxValidity;
}

// Configured external-check waiver mode (`ciGate.externalCheckWaivers.mode`,
// #2046). `mode` gates the WHOLE waiver mechanism independent of the
// `waivable` selector list -- an absent config falls back to
// `normalizePolicyConfig`'s own schema default (`disabled`), the fail-closed
// choice: an unconfigured repository can never make this check wrongly
// report an otherwise-valid waiver as covered when the real required check
// would not honor it, mirroring `advisory-convergence.mts`'s own
// fail-closed guard.
function readExternalCheckWaiverMode(iddConfig: IddConfig | null): string {
  return normalizePolicyConfig(iddConfig).ciGate.externalCheckWaivers.mode;
}

// kurone-kito/idd-skill#3250: configured external-check waiver authority
// policy (`ciGate.externalCheckWaivers.authorityPolicy`), threaded to the
// consume-side authority check. `normalizePolicyConfig` already defaults
// this to `owners-and-maintainers-only`, so an absent config resolves to
// the same fail-closed default `summarizeExternalCheckWaivers` itself
// falls back to.
function readExternalCheckWaiverAuthorityPolicy(
  iddConfig: IddConfig | null,
): string {
  return normalizePolicyConfig(iddConfig).ciGate.externalCheckWaivers
    .authorityPolicy;
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
// #2554: resolve whether a repository-scoped `providerOutage.
// declarationTarget` declaration is active for the `idd-advisory-convergence`
// selector, used ONLY to gate the declaration-scoped terminal-window
// override (`resolveEffectiveAdvisoryTerminalWindowMinutes`'s
// `declarationActive` input, above). Deliberately independent of
// `resolveAdvisoryConvergenceOutageRelief` below rather than sharing its
// result: this file already tolerates independent per-consumer evidence
// collection (see `lastCopilotCommit`'s doc comment further up). Fails
// closed to `false` on ANY error (unset target, unreadable/unparseable
// comments, authority-lookup failure) -- a transient fetch failure must
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
  iddConfig: IddConfig | null;
  now: string;
}): boolean {
  try {
    const policy = normalizePolicyConfig(iddConfig);
    const targetIssue = policy.providerOutage.declarationTarget;
    if (!targetIssue) return false;
    // #3249: `includeEditState` so `resolveProviderOutageDeclaration` can
    // reject a body-edited declaration marker. Safe inside this function's
    // existing fail-closed try/catch: a GraphQL failure here degrades to
    // `false`, never a crash.
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
  iddConfig,
  copilotUnavailable,
  waivableCheckSelectors,
  now,
}: {
  port: ProviderPort;
  owner: string;
  repo: string;
  iddConfig: IddConfig | null;
  copilotUnavailable: boolean;
  waivableCheckSelectors: { selector?: unknown; matchMode?: unknown }[];
  now: string;
}): { relieved: boolean; since: string } {
  const notRelieved = { relieved: false, since: '' };
  try {
    const policy = normalizePolicyConfig(iddConfig);
    if (policy.ciGate.externalCheckWaivers.mode !== 'maintainer-authorized') {
      return notRelieved;
    }
    const targetIssue = policy.providerOutage.declarationTarget;
    if (!targetIssue) return notRelieved;
    // #3249: `includeEditState` so `resolveProviderOutageDeclaration` can
    // reject a body-edited declaration marker. Safe inside this function's
    // existing fail-closed try/catch: a GraphQL failure here degrades to
    // `notRelieved`, never a crash.
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

// Configured governance-read trust opt-in (`ciGate.trustEmptyProtectionReads`,
// #1377). Takes the caller's already-resolved trusted-ref config (#2373);
// an absent or unparseable config fails safe to the `false` default via
// `normalizePolicyConfig(null)`, matching `readClaimStaleAgeMs`'s pattern
// above.
function readTrustEmptyProtectionReads(iddConfig: IddConfig | null): boolean {
  return (
    normalizePolicyConfig(iddConfig).ciGate.trustEmptyProtectionReads === true
  );
}

// Configured source-pinned required-check trust opt-in
// (`ciGate.trustSourcePinnedRequiredChecks`, #1689). Same pattern as
// `readTrustEmptyProtectionReads` above; see `summarizeRequiredChecks`'s
// (protocol-helpers.mts) doc comment on the option of the same name for the
// full rationale.
function readTrustSourcePinnedRequiredChecks(
  iddConfig: IddConfig | null,
): boolean {
  return (
    normalizePolicyConfig(iddConfig).ciGate.trustSourcePinnedRequiredChecks ===
    true
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
