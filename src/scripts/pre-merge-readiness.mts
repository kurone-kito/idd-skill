#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-merge-readiness.mts
//
// The scripts/pre-merge-readiness.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  readAdvisoryPrimaryBotLogin,
  readAdvisoryWaitPolicy,
} from './advisory-wait-policy.mts';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { GH_TEXT_LOOP_OPTIONS, ghText, safeGhText } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveCollaboratorMarkerTrust,
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
  parsePaginatedGhNdjson,
  resolveAdvisoryBotLogins,
  resolveCodeownersForFiles,
  resolvePrFirstCommitAt,
  resolveRulesetDetailPath,
  resolveTrustedMarkerActors,
  selectCodeownersText,
} from './protocol-helpers.mts';

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
  workflowName?: string | null;
}

// GitHub's GraphQL `DateTime` scalar can't be null, so a `CheckRun` that
// has not completed yet (and a `StatusContext`, which has no completedAt
// field at all) reports this zero-value sentinel instead -- the same
// convention `gh pr checks` already surfaces and `isCompletedCiTimestamp`
// (protocol-helpers.mts) already treats as "not completed".
const ZERO_SENTINEL_TIMESTAMP = '0001-01-01T00:00:00Z';

/**
 * Normalize one raw `statusCheckRollup` entry into the `CheckPayload`
 * shape `classifyCiChecks` / `summarizeRequiredChecks` expect (#1483).
 *
 * `state` is derived to match what `gh pr checks --json state` already
 * reported for the same underlying data (verified empirically against
 * this repository's own live PRs across `SUCCESS` / `FAILURE` /
 * `IN_PROGRESS`): a completed check-run reports its `conclusion`; an
 * incomplete one reports its raw `status` (`QUEUED` / `IN_PROGRESS` /
 * `WAITING`); a legacy commit-status reports its `state` unchanged. This
 * keeps classification behavior identical to before #1483 for every
 * single-producer case -- only the producer-identity discriminator
 * (`type` / `workflowName`) is new.
 */
export function normalizeStatusCheckRollupEntry(
  entry: StatusCheckRollupPayload,
): CheckPayload {
  if (String(entry?.__typename ?? '') === 'StatusContext') {
    return {
      name: String(entry?.context ?? ''),
      state: String(entry?.state ?? '').toUpperCase(),
      completedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
      type: 'status-context',
      workflowName: '',
    };
  }
  const status = String(entry?.status ?? '').toUpperCase();
  const conclusion = String(entry?.conclusion ?? '').toUpperCase();
  return {
    name: String(entry?.name ?? ''),
    state: status === 'COMPLETED' ? conclusion || 'UNKNOWN' : status,
    completedAt: String(entry?.completedAt ?? ZERO_SENTINEL_TIMESTAMP),
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

/** GraphQL pagination cursor block. */
interface PageInfoPayload {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
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
  reviewerReopenedAt?: string | null;
  comments?: {
    pageInfo?: PageInfoPayload | null;
    nodes: ThreadCommentPayload[];
  } | null;
}

/** GraphQL `reviewThreads` connection payload. */
interface ReviewThreadsConnectionPayload {
  pageInfo?: PageInfoPayload | null;
  nodes?: ReviewThreadPayload[] | null;
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
  now: string;
  help: boolean;
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
  '--now': { type: 'string' },
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
export function collectPreMergeReadiness(
  argv: string[],
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
  if (!args.claimIssueNumber) {
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
    'headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup',
    '--jq',
    '.',
  ]) as {
    headRefOid?: unknown;
    baseRefName?: unknown;
    url?: unknown;
    author?: { login?: unknown } | null;
    reviewDecision?: unknown;
    statusCheckRollup?: StatusCheckRollupPayload[] | null;
  };
  const prHeadSha = String(pr.headRefOid ?? '');
  const baseRefName = String(pr.baseRefName ?? '');
  const prUrl = String(pr.url ?? '');
  const prAuthorLogin = String(pr.author?.login ?? '').toLowerCase();
  const reviewDecision = String(pr.reviewDecision ?? '');
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
  const branchRulesRead = fetchGovernanceJson<BranchRulePayload[]>(
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
  const branchProtectionRead = fetchGovernanceJson<BranchProtectionPayload>(
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
  ) as ReviewPayload[];
  const requestedReviewers = ghApiJson(
    `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
    false,
  ) as { users?: GhAuthorPayload[] | null };
  const timelineEvents = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
    true,
    ['-H', 'Accept: application/vnd.github+json'],
  ) as TimelineEventPayload[];
  const comments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
    true,
  ) as IssueCommentPayload[];
  const claimComments = ghApiJson(
    `repos/${owner}/${repo}/issues/${args.claimIssueNumber}/comments`,
    true,
  ) as IssueCommentPayload[];
  const threads = fetchReviewThreads(owner, repo, args.prNumber);
  const changedFiles = (
    ghApiJson(`repos/${owner}/${repo}/pulls/${args.prNumber}/files`, true) as {
      filename?: unknown;
    }[]
  )
    .map((file) => String(file.filename ?? ''))
    .filter(Boolean);
  const codeownersText = fetchCodeownersText(owner, repo, baseRefName);
  const eligibleCodeownerUserLogins = resolveEligibleCodeownerUserLogins(
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
  let prFirstCommitAt: string | null = null;
  if (forcedHandoffEnabled) {
    try {
      const prCommits = ghApiJson(
        `repos/${owner}/${repo}/pulls/${args.prNumber}/commits`,
        true,
      ) as PrCommitPayload[];
      prFirstCommitAt = resolvePrFirstCommitAt(prCommits);
    } catch {
      prFirstCommitAt = null;
    }
  }
  const forcedHandoffPermissionCache: CollaboratorPermissionCache = new Map();
  const waivableCheckSelectors = readWaivableCheckSelectors();
  const externalCheckWaiverMaxValidity = readExternalCheckWaiverMaxValidity();
  const staleAgeMs = readClaimStaleAgeMs();

  const summary = buildPreMergeReadinessSummary(
    {
      prHeadSha,
      comments: comments.map(normalizeComment),
      reviews: reviews.map(normalizeReview),
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
      reviewDecision,
    },
    {
      now: args.now || new Date().toISOString().replace('.000Z', 'Z'),
      trustedMarkerLogins,
      iddAgentLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      prAuthorLogin,
      expectedClaimId: args.expectedClaimId,
      expectedAgentId: args.expectedAgentId,
      includeDispositionEvidence: true,
      requestCap: advisoryWaitPolicy.requestCap,
      pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
      settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
      pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
      capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
      primaryBotLogin,
      waivableCheckSelectors,
      externalCheckWaiverMaxValidity,
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
    now: (values.now as string | undefined) ?? '',
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/pre-merge-readiness.mjs --pr <number> --claim-issue <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--idd-agent-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--claim-id <claim-id>] [--agent-id <agent-id>] [--now <ISO8601>]
  Deprecated aliases (one release): --expected-claim-id -> --claim-id, --expected-agent-id -> --agent-id
`);
}

function normalizeComment(comment: IssueCommentPayload) {
  return {
    id: String(comment.id ?? ''),
    author: { login: comment.user?.login ?? '' },
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    updatedAt: comment.updated_at ?? comment.created_at ?? '',
  };
}

function normalizeClaimComment(comment: IssueCommentPayload) {
  return {
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    author: { login: comment.user?.login ?? '' },
  };
}

function normalizeReview(review: ReviewPayload) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}

function normalizeThread(thread: ReviewThreadPayload) {
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

function inferReviewerReopenedAt(thread: ReviewThreadPayload): string {
  return thread.reviewerReopenedAt ?? '';
}

function resolveTrustedCollaboratorMarkerLogins(
  owner: string,
  repo: string,
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

function resolveEligibleCodeownerUserLogins(
  owner: string,
  repo: string,
  logins: unknown[],
): string[] {
  return normalizeTrustedMarkerLogins(logins).filter((login) => {
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

function fetchCodeownersText(owner: string, repo: string, ref: string): string {
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
  owner: string,
  repo: string,
  branchRules: BranchRulePayload[],
  trustEmptyReads = false,
  fetchRulesetDetail: (path: string) => Record<string, unknown> = (path) =>
    ghApiJson(path, false, [
      '-H',
      'Accept: application/vnd.github+json',
    ]) as Record<string, unknown>,
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
    const state = safeGhText(
      [
        'api',
        `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(
          viewerLogin,
        )}`,
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

function extractTeamOrgFromHtmlUrl(htmlUrl: unknown): string {
  const match = String(htmlUrl ?? '').match(/\/orgs\/([^/]+)\/teams\//);
  return match?.[1] ?? '';
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
      {
        owner,
        repo,
        number: Number.parseInt(String(prNumber), 10),
        cursor,
      },
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

function ghGraphql(
  query: string,
  variables: Record<string, string | number | null | undefined>,
): unknown {
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

function ghJson(args: string[], options: RunGhOptions = {}): unknown {
  return JSON.parse(runGh(args, options).trim() || '[]');
}

function ghApiJson(
  path: string,
  paginate = false,
  extraArgs: string[] = [],
  options: RunGhOptions = {},
): unknown {
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

function runGh(args: string[], options: RunGhOptions = {}): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const tolerated = resolveToleratedGhFailure(error, options);
    if (tolerated !== undefined) {
      return tolerated;
    }
    throw error;
  }
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
 * `fetchRulesetDetail` parameter); production uses the default `gh api` call.
 */
export function fetchGovernanceJson<T>(
  path: string,
  paginate: boolean,
  trustEmptyReads: boolean,
  emptyValue: T,
  fetchJson: (path: string, paginate: boolean) => unknown = (p, pg) =>
    ghApiJson(p, pg, []),
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
