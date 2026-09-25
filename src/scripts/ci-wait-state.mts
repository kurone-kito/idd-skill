#!/usr/bin/env node
// idd-generated-from: src/scripts/ci-wait-state.mts
//
// The scripts/ci-wait-state.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Single-shot, read-only D-phase CI snapshot helper (#1317). Unlike the
// E/F review-state steps, which each have a committed evidence-snapshot
// helper (advisory-wait-state, pre-merge-readiness, review-activity-snapshot),
// the D-phase CI wait has historically had no committed polling/snapshot
// helper: callers re-derive check status from raw `statusCheckRollup` JSON
// by hand every wait. Two concrete traps this helper closes:
//
// - Duplicate check names across triggering workflows: a single PR can carry
//   two check runs with the identical display `name` (e.g. the same job name
//   once under a "push as feature branch" workflow and again under a "merge
//   as main branch" workflow). This helper keys every check entry by
//   `(checkName, workflowName)` so a naive "first match by name" read never
//   silently picks the wrong workflow's status.
// - HEAD drift mid-wait: this helper always reports the live `headRefOid` at
//   read time, so a caller polling in a loop can detect the branch moving
//   out from under an in-flight wait.

import { parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { type IddConfig, loadTrustedIddConfig } from './idd-config.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';
import {
  CI_FAILURE_CONCLUSION_STATES,
  classifyCiChecks,
  isPreMergeCiAllPassing,
  resolvePresentRunConclusion,
  selectLatestCheckInstance,
  summarizeBranchReviewRequirements,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderGovernanceReadOutcome,
  ProviderPort,
} from './provider-port.mts';

/** Required-check entry from a branch ruleset rule or classic protection. */
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

/** Check-bearing parameters object shared by rules and classic protection. */
interface RequiredCheckParametersPayload {
  required_status_checks?: RawRequiredCheckPayload[] | null;
  required_checks?: RawRequiredCheckPayload[] | null;
  checks?: RawRequiredCheckPayload[] | null;
  contexts?: RawRequiredCheckPayload[] | null;
}

/** Branch rule entry from `repos/{owner}/{repo}/rules/branches/{branch}`. */
interface BranchRulePayload {
  type?: string | null;
  parameters?:
    | (RequiredCheckParametersPayload & {
        required_approving_review_count?: unknown;
        require_code_owner_review?: unknown;
        required_review_thread_resolution?: unknown;
        workflows?: unknown;
      })
    | null;
}

/** Classic branch-protection payload fields this helper reads. */
interface BranchProtectionPayload {
  required_pull_request_reviews?: {
    require_code_owner_reviews?: unknown;
    require_code_owner_review?: unknown;
    required_approving_review_count?: unknown;
  } | null;
  required_conversation_resolution?: { enabled?: unknown } | null;
  required_status_checks?: RequiredCheckParametersPayload | null;
}

/** Status-check rollup entry from `gh pr view --json statusCheckRollup`. */
interface StatusCheckRollupEntry {
  __typename?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  status?: string | null;
  conclusion?: string | null;
  name?: string | null;
  detailsUrl?: string | null;
  workflowName?: string | null;
  workflowPath?: string | null;
  appSlug?: string | null;
  workflowRunPresent?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** One normalized, disambiguated per-check entry. */
export interface CiWaitCheckEntry {
  checkName: string;
  workflowName: string;
  /** GitHub-owned workflow file path; null means producer identity is unresolved. */
  workflowPath?: string | null;
  /** GitHub App slug for a non-Actions check run. */
  appSlug?: string | null;
  /** Whether GitHub associated this check run with an Actions workflow run. */
  workflowRunPresent?: boolean;
  type: 'check-run' | 'status-context';
  state: string;
  status: 'success' | 'pending' | 'failure' | 'unknown';
  required: boolean;
  url: string;
  startedAt: string;
  completedAt: string;
}

/** Top-level required-checks rollup. */
export interface CiWaitRequiredChecksRollup {
  names: string[];
  missingNames: string[];
  allRequiredPresent: boolean;
  allRequiredPassing: boolean;
  anyRequiredPending: boolean;
  anyRequiredFailing: boolean;
  anyRequiredUnknown: boolean;
  /**
   * True when a ruleset `workflows` rule or an app/integration-pinned
   * classic required check is in force (mirrors
   * `summarizeBranchReviewRequirements`'s `requiredCheckSourcePinned`).
   * When this is true and `names` is empty, `status` is `source-pinned`,
   * not `no-required-checks` — required checks are still gating the
   * branch; this helper just cannot resolve them by name, so callers must
   * not treat it as a vacuous pass. When `names` is non-empty and every
   * named check passes, `status` is also `source-pinned` (not `success`)
   * unless the caller opts in via `ciGate.trustSourcePinnedRequiredChecks`
   * (#1689; see `buildRequiredChecksRollup`'s doc comment) — this helper
   * has no way to verify a green named check actually came from the
   * pinned integration.
   */
  requiredCheckSourcePinned: boolean;
  /**
   * True when at least one pinned source could not be attributed to a
   * resolved check name (a `workflows` rule, or a pinned classic entry with
   * no `context`/`name`/`check`) -- mirrors
   * `summarizeBranchReviewRequirements`'s `requiredCheckSourcePinnedUnresolved`
   * (#1689). The `ciGate.trustSourcePinnedRequiredChecks` opt-in must never
   * bypass the `source-pinned` status while this is true, even when a
   * SEPARATE, named-and-pinned check on the same required-check set would
   * itself qualify for the opt-in -- there is no check name to correlate
   * the unresolved pinning with a live run at all.
   */
  requiredCheckSourcePinnedUnresolved: boolean;
  /**
   * True when a branch-rules or classic branch-protection read came back
   * `not-found` and the repository has not opted in to trusting that as
   * genuinely empty (`ciGate.trustEmptyProtectionReads`, #3300; mirrors
   * the rationale behind `resume-route-selection.mts`'s own local
   * `protectionReadsUnreadable`, computed separately there rather than
   * through this rollup). GitHub can
   * mask a `403` permission denial as a `404` on these endpoints
   * (`idd-ci.instructions.md`'s Required-check discovery step 4), so an
   * unreadable read must never be reported as a vacuous "nothing
   * configured" pass. When this is `true`, `status` is `unreadable`
   * regardless of what the readable evidence alone would otherwise
   * suggest -- see `status`'s own doc comment. An explicit `403` is not
   * folded into this flag: the provider port already re-throws it
   * (`fetchGovernanceOutcome` in provider-adapter-github.mts), which
   * fails this helper's own process closed via a non-zero exit before a
   * summary is ever built.
   */
  protectionReadsUnreadable: boolean;
  status:
    | 'success'
    | 'pending'
    | 'failing'
    | 'missing'
    | 'no-required-checks'
    | 'source-pinned'
    /**
     * #3300: `protectionReadsUnreadable` is `true` -- a branch-rules or
     * classic branch-protection read could not be confirmed as either
     * present or genuinely absent. Takes precedence over every other
     * status, including `success`: the required-check set this rollup
     * computed may be incomplete, so a passing subset of it must never be
     * reported as settled (mirrors `isPreMergeCiAllPassing`'s
     * unconditional block on `pre-merge-readiness`'s own
     * `protectionReadsUnreadable` field in protocol-helpers.mts).
     */
    | 'unreadable';
}

/** Full snapshot document returned by {@link buildCiWaitStateSummary}. */
export interface CiWaitStateSummary {
  headRefOid: string;
  checks: CiWaitCheckEntry[];
  requiredChecks: CiWaitRequiredChecksRollup;
}

/** Parsed CLI arguments. */
interface CiWaitStateArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  help: boolean;
}

// Interpretation table this bucketing is based on: idd-ci.instructions.md's
// "Interpretation" section. Keep these three sets in sync with that table's
// normalized states, with one deliberate addition: FAILURE_STATES also
// includes StatusContext-only `ERROR` (see below), which that table does not
// list because it predates this StatusContext-specific case.
const SUCCESS_STATES = new Set([
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
  'NOT_APPLICABLE',
]);
const PENDING_STATES = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'PENDING',
  'EXPECTED',
  'REQUESTED',
]);
// Derived from the shared `CI_FAILURE_CONCLUSION_STATES` (protocol-helpers.mts)
// plus `CANCELLED`, rather than an independently hand-maintained literal
// (#1688): `CI_FAILURE_CONCLUSION_STATES` already carries `TIMED_OUT`,
// `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, and the commit-status-only
// `ERROR` (a StatusContext `error` state distinct from `failure`; bucket it
// as failure too, or a clearly failing required check would misleadingly
// read as "unknown"). `CANCELLED` is added locally because this file's own
// required-checks *bucketing* treats a cancelled run as failing for wait-gate
// purposes, even though `ciStateTieRank`'s same-instant tie-break (in
// `protocol-helpers.mts`) deliberately keeps `CANCELLED` at a lower rank
// than every other member here -- a cancelled run reached no real verdict,
// so it still loses a tie against a genuine success, but it must not be
// treated as passing outright once it is the sole/latest instance for a
// required check name. Deriving from the shared set (instead of maintaining
// a second, separately-updated literal) is what keeps this file's wider
// vocabulary from silently drifting away from `classifyCiChecks`'s again,
// which is exactly how #1504's local-only fix diverged from the shared
// `ciStateTieRank` in the first place.
const FAILURE_STATES = new Set([...CI_FAILURE_CONCLUSION_STATES, 'CANCELLED']);

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
const CI_WAIT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  // #3342: call main() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('ci-wait-state', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call. Returns 0 (success) or throws -- `runHelperCli` (#3342)
// classifies a thrown error and, when the opt-in JSON error envelope is
// enabled, reports it; with the envelope unset this is byte-identical to
// the pre-migration `main(): void` shape.
function main(): HelperCliResult {
  const summary = collectCiWaitState(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

/**
 * Collect the CI-wait-state snapshot for `--pr <number>`: resolve owner/
 * repo, fetch the PR's branch/checks and governance reads from `port`,
 * resolve the trusted `.github/idd/config.json` via `loadTrustedConfig`
 * against the PR's base ref (or the repository's live default branch when
 * `baseRefName` is empty), classify governance-read unreadability (#3300),
 * and build the final summary via {@link buildCiWaitStateSummary}.
 *
 * `createPort`/`loadTrustedConfig` are injectable (default: the real
 * GitHub adapter / trusted-ref loader) so a test can drive this whole
 * collection entry end to end against `createFakeProviderAdapter`
 * fixtures instead of a live `gh` process -- mirrors
 * `pre-merge-readiness.mts`'s `collectPreMergeReadiness` injectable-
 * parameter pattern. Before this, only the pure functions below
 * (`isProtectionReadUnreadable`, `buildCiWaitStateSummary`) had a test
 * seam; this orchestration itself -- choosing `trustedConfigRef`,
 * applying `ciGate.trustEmptyProtectionReads` -- had none (Copilot
 * review, PR #3350).
 */
export function collectCiWaitState(
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
): CiWaitStateSummary {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    // parseArgs normalizes both an absent --pr and an invalid one (e.g.
    // `--pr 0` or `--pr foo`) to null, so "missing" alone would misreport an
    // invalid value as absent.
    throw markCliUsageError(
      new Error('missing or invalid --pr <number> argument'),
    );
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createPort(owner, repo);

  const pr = port.getChangeRequestBranchAndChecks(args.prNumber);
  // Raw (unencoded) branch name: listBranchRules/getBranchProtection do
  // their own encodeURIComponent internally, matching pre-merge-readiness's
  // and #2267's other listBranchRules/getBranchProtection callers -- passing
  // an already-encoded ref here would double-encode it.
  const baseRefName = String(pr.baseRefName ?? '');

  const branchRulesOutcome = port.listBranchRules(owner, repo, baseRefName);
  const branchRules =
    branchRulesOutcome.outcome === 'ok'
      ? (branchRulesOutcome.value as BranchRulePayload[])
      : [];
  const branchProtectionOutcome = port.getBranchProtection(
    owner,
    repo,
    baseRefName,
  );
  const branchProtection =
    branchProtectionOutcome.outcome === 'ok'
      ? (branchProtectionOutcome.value as BranchProtectionPayload)
      : ({} as BranchProtectionPayload);

  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );

  // #2373/#3300: resolve `.github/idd/config.json` from the PR's TRUSTED
  // base ref, never this worktree's own local copy -- the same trust
  // boundary `pre-merge-readiness.mts` and `resume-route-selection.mts`
  // already apply to this exact config read. A PR branch that could edit
  // its own local copy could otherwise widen its own
  // `ciGate.trustEmptyProtectionReads`/`trustSourcePinnedRequiredChecks`
  // opt-ins. Falls back to the repository's live default branch when
  // `baseRefName` is empty (mirrors `collectPreMergeReadiness`'s
  // identical fallback), and fails closed -- rather than silently
  // defaulting the policy -- when neither resolves.
  const trustedConfigRef =
    baseRefName || port.getRepositoryDefaultBranch(owner, repo);
  if (!trustedConfigRef) {
    throw new Error(
      `cannot resolve a trusted ref for .github/idd/config.json: PR #${args.prNumber} has no baseRefName and the repository's live default branch could not be determined`,
    );
  }
  const iddConfig = loadTrustedConfig(owner, repo, trustedConfigRef);
  const ciGate = normalizePolicyConfig(iddConfig).ciGate;
  const trustEmptyProtectionReads = ciGate.trustEmptyProtectionReads === true;
  // #1689: `ciGate.trustSourcePinnedRequiredChecks` -- see
  // `buildRequiredChecksRollup`'s doc comment for the full rationale.
  const trustSourcePinnedRequiredChecks =
    ciGate.trustSourcePinnedRequiredChecks === true;

  // #3300: classify each governance read as readable or unreadable via the
  // exported, gh-free pure function below -- see its doc comment. A `403`
  // on either read is not handled here: the provider port already
  // re-throws it, which crashes this function (and the whole process)
  // before a summary is ever built, unchanged fail-closed behavior from
  // before this change.
  const protectionReadsUnreadable =
    isProtectionReadUnreadable(branchRulesOutcome, trustEmptyProtectionReads) ||
    isProtectionReadUnreadable(
      branchProtectionOutcome,
      trustEmptyProtectionReads,
    );

  const summary = buildCiWaitStateSummary(
    {
      headRefOid: pr.headSha,
      statusCheckRollup:
        (pr.statusCheckRollup as StatusCheckRollupEntry[] | null) ?? [],
    },
    {
      requiredCheckNames: branchReviewRequirements.requiredCheckNames,
      requiredCheckSourcePinned:
        branchReviewRequirements.requiredCheckSourcePinned,
      requiredCheckSourcePinnedUnresolved:
        branchReviewRequirements.requiredCheckSourcePinnedUnresolved,
      trustSourcePinnedRequiredChecks,
      protectionReadsUnreadable,
    },
  );

  return summary;
}

/**
 * Classify whether a branch-rules or classic branch-protection governance
 * read must be treated as unreadable rather than "nothing configured"
 * (#3300). A `not-found` outcome is GitHub's documented way of masking a
 * `403` permission denial on these two endpoints (`idd-ci.instructions.md`'s
 * Required-check discovery step 4 gathers the citations), so it is
 * unreadable by default -- unless the repository has opted in to trusting
 * it as genuinely empty via `ciGate.trustEmptyProtectionReads`, mirroring
 * the rationale behind `resume-route-selection.mts`'s own
 * `protectionReadsUnreadable` local. An `ok` outcome is always readable
 * regardless of the opt-in. Exported and pure (no `gh` call, no process
 * access) so this classification is directly unit-testable.
 */
export function isProtectionReadUnreadable(
  outcome: ProviderGovernanceReadOutcome<unknown>,
  trustEmptyProtectionReads: boolean,
): boolean {
  return outcome.outcome === 'not-found' && !trustEmptyProtectionReads;
}

/**
 * Build the read-only D-phase CI snapshot: every current check keyed by
 * `(checkName, workflowName)`, the live `headRefOid`, and the top-level
 * required-checks rollup. Pure and side-effect-free so it is directly unit
 * testable without a live `gh` call.
 */
export function buildCiWaitStateSummary(
  input: {
    headRefOid?: string | null;
    statusCheckRollup?: StatusCheckRollupEntry[] | null;
  },
  options: {
    requiredCheckNames?: string[] | null;
    requiredCheckSourcePinned?: boolean;
    // #1689: mirrors `summarizeBranchReviewRequirements`'s field of the same
    // name -- see `CiWaitRequiredChecksRollup`'s doc comment. Omitted by
    // unit callers (default `false`).
    requiredCheckSourcePinnedUnresolved?: boolean;
    // #1689: `ciGate.trustSourcePinnedRequiredChecks` opt-in, forwarded to
    // `buildRequiredChecksRollup`. Omitted by unit callers (default
    // `false`, unchanged pre-#1689 conservative behavior).
    trustSourcePinnedRequiredChecks?: boolean;
    // #3300: true when a branch-rules or classic branch-protection read
    // was masked-404-unreadable (see `isProtectionReadUnreadable`).
    // Omitted by unit callers and by the other caller of this function,
    // `resume-route-selection.mts` (default `false`, unchanged behavior --
    // that file already computes and checks its own
    // `protectionReadsUnreadable` separately rather than through this
    // option).
    protectionReadsUnreadable?: boolean;
  } = {},
): CiWaitStateSummary {
  const requiredCheckNameSet = new Set(
    (options.requiredCheckNames ?? [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  );

  const checks = (input.statusCheckRollup ?? [])
    .map((entry) => normalizeCheckEntry(entry, requiredCheckNameSet))
    .filter((entry) => entry.checkName);

  const requiredChecks = buildRequiredChecksRollup(
    checks,
    requiredCheckNameSet,
    options.requiredCheckSourcePinned === true,
    options.requiredCheckSourcePinnedUnresolved === true,
    options.trustSourcePinnedRequiredChecks === true,
    options.protectionReadsUnreadable === true,
  );

  return {
    headRefOid: String(input.headRefOid ?? ''),
    checks,
    requiredChecks,
  };
}

function normalizeCheckEntry(
  entry: StatusCheckRollupEntry,
  requiredCheckNameSet: Set<string>,
): CiWaitCheckEntry {
  if (entry?.__typename === 'StatusContext') {
    const checkName = String(entry.context ?? '').trim();
    const state = String(entry.state ?? '')
      .trim()
      .toUpperCase();
    return {
      checkName,
      workflowName: '',
      type: 'status-context',
      state,
      status: bucketState(state),
      required: requiredCheckNameSet.has(checkName),
      url: String(entry.targetUrl ?? ''),
      startedAt: String(entry.startedAt ?? ''),
      completedAt: String(entry.completedAt ?? ''),
    };
  }

  const checkName = String(entry?.name ?? '').trim();
  const status = String(entry?.status ?? '')
    .trim()
    .toUpperCase();
  const conclusion = String(entry?.conclusion ?? '')
    .trim()
    .toUpperCase();
  const state =
    status === 'COMPLETED' ? conclusion || 'UNKNOWN' : status || 'UNKNOWN';
  const workflowPath =
    entry?.workflowPath === undefined
      ? undefined
      : String(entry.workflowPath ?? '').trim() || null;
  const appSlug =
    entry?.appSlug === undefined
      ? undefined
      : String(entry.appSlug ?? '').trim() || null;
  const workflowRunPresent =
    entry?.workflowRunPresent === undefined
      ? undefined
      : entry.workflowRunPresent === true;
  return {
    checkName,
    // Trimmed like checkName: workflowName is part of the
    // (checkName, workflowName) disambiguation key, so untrimmed
    // whitespace-only differences could otherwise produce unstable keys
    // or spuriously "distinct" workflow entries.
    workflowName: String(entry?.workflowName ?? '').trim(),
    ...(workflowPath !== undefined ? { workflowPath } : {}),
    ...(appSlug !== undefined ? { appSlug } : {}),
    ...(workflowRunPresent !== undefined ? { workflowRunPresent } : {}),
    type: 'check-run',
    state,
    status: bucketState(state),
    required: requiredCheckNameSet.has(checkName),
    url: String(entry?.detailsUrl ?? ''),
    startedAt: String(entry?.startedAt ?? ''),
    completedAt: String(entry?.completedAt ?? ''),
  };
}

function bucketState(state: string): CiWaitCheckEntry['status'] {
  if (FAILURE_STATES.has(state)) return 'failure';
  if (PENDING_STATES.has(state)) return 'pending';
  if (SUCCESS_STATES.has(state)) return 'success';
  return 'unknown';
}

/**
 * Reduce `entries` to one representative per `checkName`, matching the
 * per-name dedup #1471 added to `classifyCiChecks` in
 * `protocol-helpers.mts`: GitHub can report several check-run instances
 * sharing one required check name (a manual or automatic rerun leaves the
 * earlier instance in the fetched rollup alongside the new one), and only
 * the latest instance per name should govern pass/fail/pending (#1478).
 * Reuses the exported `selectLatestCheckInstance` for the actual
 * same-name reduction (still-incomplete wins over completed; else latest
 * `completedAt` wins; a same-instant tie prefers any
 * `CI_FAILURE_CONCLUSION_STATES` member, then non-`CANCELLED`) so this file
 * does not maintain a second, independently-drifting copy of that
 * tie-break logic. Only the
 * name-keyed grouping below is local to this file, because
 * `CiWaitCheckEntry` uses `checkName` where `protocol-helpers.mts`'s
 * `CheckLike` uses `name`.
 *
 * `selectLatestCheckInstance`'s shared `ciStateTieRank` originally
 * special-cased only the two literal strings `'FAILURE'` and `'CANCELLED'`;
 * every other raw state -- including this file's own wider `FAILURE_STATES`
 * additions `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, and
 * `ERROR` -- fell into the shared tie-break's generic rank-1 bucket, where a
 * same-instant tie against a success-family state resolved by raw
 * lexicographic string comparison instead of "the failure should win"
 * (#1504). That was fixed locally only, in this file, at the time (a
 * tie-break-only state normalization applied by `selectLatestCheckEntry`
 * before calling `selectLatestCheckInstance`) -- widening `ciStateTieRank`
 * itself was left out of scope as "shared, upstream of `classifyCiChecks`".
 * #1688 closed that shared corner: `ciStateTieRank` now ranks every
 * `CI_FAILURE_CONCLUSION_STATES` member (which this file's `FAILURE_STATES`
 * is derived from) at 0 directly, so `selectLatestCheckEntry` no longer
 * needs a local normalization step at all -- see that function.
 *
 * Deliberately keyed by `checkName` alone, not the `(checkName,
 * workflowName)` pair this file otherwise disambiguates entries by (see
 * the module header): GitHub's own required-status-check gate matches by
 * check name alone, independent of which workflow produced a given
 * instance, so any rerun whose `workflowName` happens to differ from the
 * instance it supersedes would not be deduped under a workflow-qualified
 * key, leaving the defect only partially fixed. (The live PR #1434
 * reproduction this fix targets happens to share one `workflowName`
 * across every instance, so a composite key would also fix that specific
 * case -- but not the general one, and not as directly as matching
 * GitHub's own name-only semantics.) `required` itself is already
 * computed by `checkName` alone (see `normalizeCheckEntry`), so this
 * does not newly conflate anything the required-checks rollup did not
 * already conflate. Two genuinely independent, same-named required
 * checks that happen to complete in the same instant remain an accepted
 * limitation shared with `classifyCiChecks` (tracked in #1483).
 *
 * `entries` itself may be empty (e.g. no required check has been
 * reported yet), in which case `groups` simply ends up with zero
 * entries. What is guaranteed is that every group `selectLatestCheckEntry`
 * receives has at least one member: a group is only ever created by
 * pushing the entry that introduced its key (see the `Map` construction
 * below), so the seedless `reduce` inside `selectLatestCheckInstance`
 * never runs on an empty array.
 */
function selectLatestCheckEntryPerName(
  entries: CiWaitCheckEntry[],
): CiWaitCheckEntry[] {
  const groups = new Map<string, CiWaitCheckEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.checkName);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.checkName, [entry]);
    }
  }
  return [...groups.values()].map((group) => selectLatestCheckEntry(group));
}

/**
 * Reduce one name-keyed group to its representative instance via the
 * shared `selectLatestCheckInstance`, comparing each entry's own real
 * `state` directly -- no local tie-break-only normalization needed
 * (#1688; pre-#1688 this wrapped every entry through a *tie-break-only*
 * normalized state before calling `selectLatestCheckInstance`, since the
 * shared `ciStateTieRank` only recognized the literal `'FAILURE'` string;
 * now that `ciStateTieRank` itself ranks every `CI_FAILURE_CONCLUSION_STATES`
 * member -- which is exactly this file's `FAILURE_STATES` minus `CANCELLED`
 * -- at 0, this file's own wider vocabulary already wins a same-instant tie
 * against a success-family state with no local help).
 *
 * A same-instant tie between two *distinct* raw failure states (e.g.
 * `TIMED_OUT` and `STARTUP_FAILURE`, both now rank 0) still resolves
 * deterministically regardless of input order, because
 * `isNewerCheckInstance`'s residual same-rank fallback
 * (`candidate.state !== current.state && candidate.state < current.state`)
 * is a genuine lexicographic argmin over the two *distinct* raw state
 * strings -- symmetric and order-independent by construction, unlike the
 * pre-#1688 wrapped comparison (which needed an explicit pre-sort, Copilot
 * review PR #1530, because two distinct raw states could normalize to the
 * *same* wrapped string and make the residual comparison see a false tie).
 * With no normalization step left, that failure mode no longer exists, so
 * the pre-sort is gone too.
 *
 * Exported (like `protocol-helpers.mts`'s own `selectLatestCheckInstance`)
 * so the determinism property above is directly unit-testable: the winning
 * *raw* instance's identity is not observable through
 * `buildCiWaitStateSummary`'s public return shape at all -- `checks` there
 * is the raw, not-deduped list, and `requiredChecks` only exposes aggregate
 * pass/fail booleans that stay identical regardless of which same-rank
 * instance wins a tie.
 */
export function selectLatestCheckEntry(
  group: CiWaitCheckEntry[],
): CiWaitCheckEntry {
  const winner = selectLatestCheckInstance(
    group.map((entry) => ({
      entry,
      state: entry.state,
      completedAt: entry.completedAt,
    })),
  );
  return winner.entry;
}

function buildRequiredChecksRollup(
  checks: CiWaitCheckEntry[],
  requiredCheckNameSet: Set<string>,
  requiredCheckSourcePinned: boolean,
  // #1689: true when at least one pinned source has no resolved check name
  // (a `workflows` rule, or a pinned classic entry with no `context`/
  // `name`/`check`) -- see `CiWaitRequiredChecksRollup`'s doc comment. The
  // opt-in below must never bypass the downgrade while this is true, even
  // when a separate, named-and-pinned check on the same required-check set
  // would itself qualify.
  requiredCheckSourcePinnedUnresolved: boolean,
  // #1689: `ciGate.trustSourcePinnedRequiredChecks` opt-in, mirroring
  // `summarizeRequiredChecks`'s option of the same name in
  // protocol-helpers.mts -- see that function's doc comment for the full
  // rationale. Only widens the named/present/passing mixed case below;
  // the fully-unnamed case above (`names.length === 0`) stays
  // unconditionally conservative regardless of this flag, since there is
  // no check name to correlate with a live run at all in that case.
  trustSourcePinnedRequiredChecks: boolean,
  // #3300: true when a branch-rules or classic branch-protection read came
  // back masked-404-unreadable (see `isProtectionReadUnreadable`). Checked
  // first, before every other classification below -- see `status`'s own
  // doc comment on `CiWaitRequiredChecksRollup` for why this must win
  // unconditionally, including over an otherwise-"success" read.
  protectionReadsUnreadable: boolean,
): CiWaitRequiredChecksRollup {
  const names = [...requiredCheckNameSet].sort();
  if (names.length === 0) {
    return {
      names,
      missingNames: [],
      // A source-pinned required check (ruleset `workflows` rule, or an
      // app/integration-pinned classic check with no enumerable context)
      // is still gating the branch even though it cannot be resolved by
      // name here — fail closed (`allRequiredPresent: false`) instead of
      // reporting the vacuous "no required checks" pass.
      allRequiredPresent: !requiredCheckSourcePinned,
      allRequiredPassing: false,
      anyRequiredPending: false,
      anyRequiredFailing: false,
      anyRequiredUnknown: false,
      requiredCheckSourcePinned,
      requiredCheckSourcePinnedUnresolved,
      protectionReadsUnreadable,
      status: protectionReadsUnreadable
        ? 'unreadable'
        : requiredCheckSourcePinned
          ? 'source-pinned'
          : 'no-required-checks',
    };
  }

  const requiredEntries = checks.filter((check) => check.required);
  const presentNames = new Set(requiredEntries.map((check) => check.checkName));
  const missingNames = names.filter((name) => !presentNames.has(name));
  const allRequiredPresent = missingNames.length === 0;

  // #1478: dedupe multiple check-run instances sharing one required check
  // name down to the latest instance before classifying, so a stale
  // CANCELLED/FAILURE instance never outvotes a later SUCCESS for the
  // same name (the identical defect shape #1471 fixed in
  // classifyCiChecks). presentNames/missingNames/allRequiredPresent above
  // are unaffected: they only test *presence* by name via a Set, which is
  // already naturally deduped.
  const dedupedRequiredEntries = selectLatestCheckEntryPerName(requiredEntries);

  const anyRequiredFailing = dedupedRequiredEntries.some(
    (check) => check.status === 'failure',
  );
  const anyRequiredPending = dedupedRequiredEntries.some(
    (check) => check.status === 'pending',
  );
  const anyRequiredUnknown = dedupedRequiredEntries.some(
    (check) => check.status === 'unknown',
  );
  const namedChecksPassing =
    allRequiredPresent &&
    dedupedRequiredEntries.every((check) => check.status === 'success');

  let status: CiWaitRequiredChecksRollup['status'];
  if (protectionReadsUnreadable) {
    status = 'unreadable';
  } else if (!allRequiredPresent) {
    status = 'missing';
  } else if (anyRequiredFailing) {
    status = 'failing';
  } else if (anyRequiredPending || anyRequiredUnknown) {
    status = 'pending';
  } else if (
    requiredCheckSourcePinned &&
    (!trustSourcePinnedRequiredChecks || requiredCheckSourcePinnedUnresolved)
  ) {
    // Mixed case: enumerable required checks all pass, but a ruleset
    // `workflows` rule or an app-pinned classic check is ALSO in force and
    // not name-enumerable, so it is not covered by requiredEntries at all.
    // Mirrors summarizeRequiredChecks in protocol-helpers.mts, which
    // downgrades an otherwise-"success" classification (absent the #1689
    // `trustSourcePinnedRequiredChecks` opt-in checked above) under the
    // same condition — never report a vacuous success while an unverified
    // source-pinned requirement could still be gating the branch. The
    // opt-in itself never overrides an unresolved pinned source (no check
    // name to correlate with a live run at all), even when a separate,
    // named-and-pinned check on the same required-check set would itself
    // qualify.
    status = 'source-pinned';
  } else {
    status = 'success';
  }
  const allRequiredPassing = namedChecksPassing && status === 'success';

  return {
    names,
    missingNames,
    allRequiredPresent,
    allRequiredPassing,
    anyRequiredPending,
    anyRequiredFailing,
    anyRequiredUnknown,
    requiredCheckSourcePinned,
    requiredCheckSourcePinnedUnresolved,
    protectionReadsUnreadable,
    status,
  };
}

/**
 * #3465: map this helper's required-check rollup onto
 * {@link isPreMergeCiAllPassing}, the predicate pre-merge readiness
 * already uses. A rollup `status` of `success` is the only value that
 * means every enumerated required check is present and passing with no
 * source-pinned or unreadable downgrade. `no-required-checks` falls
 * through to that predicate's present-run clause. A failing check that
 * is not in the required set does not change a `success` rollup.
 * The no-required-checks fallback calls {@link resolvePresentRunConclusion}
 * so a success from a different workflow cannot hide another producer's
 * failure. Waiver coverage is not an input: `collectCiWaitState` does
 * not read external-check waivers, so a required check that is failing
 * in the rollup stays non-passing here even when pre-merge readiness
 * would treat a valid waiver as covered. This command does not
 * re-validate waivers.
 */
export function ciWaitSummaryIsPreMergeCiPassing(
  summary: CiWaitStateSummary,
): boolean {
  const rollup = summary.requiredChecks;
  // The required rollup dedupes by check name, which matches GitHub's
  // required-status-check gate. Pre-merge readiness classifies by producer
  // instead, so a failure from one workflow can remain blocking beside a
  // later success from another workflow that shares the display name.
  // Require both: the rollup's own success (missing names, source-pinned,
  // and unreadable stay on that status) and a producer-aware success.
  const requiredNames = new Set(rollup.names);
  const producerStatus = classifyCiChecks(
    summary.checks
      .filter((check) => requiredNames.has(check.checkName))
      .map((check) => ({
        name: check.checkName,
        state: check.state,
        completedAt: check.completedAt,
        type: check.type,
        workflowName: check.workflowName,
        workflowPath: check.workflowPath ?? '',
      })),
  ).status;
  const presentRunConclusion = resolvePresentRunConclusion(
    summary.checks.map((check) => ({
      name: check.checkName,
      state: check.state,
      completedAt: check.completedAt,
      coveredByWaiver: false,
      type: check.type,
      workflowName: check.workflowName,
      workflowPath: check.workflowPath ?? '',
    })),
  );
  const requiredChecksPassing =
    rollup.names.length > 0 &&
    rollup.status === 'success' &&
    producerStatus === 'success';
  return isPreMergeCiAllPassing({
    protectionReadsUnreadable:
      rollup.protectionReadsUnreadable || rollup.status === 'unreadable',
    requiredChecksPassing,
    // `isPreMergeCiAllPassing` treats `status === 'success'` as passing on
    // its own, so this must stay failed whenever the producer-aware check
    // disagrees with the name-only rollup.
    status: requiredChecksPassing ? 'success' : 'failed',
    noRequiredChecksConfigured: rollup.status === 'no-required-checks',
    presentRunConclusion,
  });
}

const PASS_EQUIVALENT_STATES = new Set([
  'SUCCESS',
  'SKIPPED',
  'NEUTRAL',
  'NOT_APPLICABLE',
]);

/**
 * Latest completion among pass-equivalent checks, or `none`. Mirrors the
 * snapshot field `latestPassingCiCompletedAt` so a `--from-pr` watermark
 * can refuse when the live read has moved past the snapshot it is about
 * to record.
 */
export function latestPassingCompletedAt(summary: CiWaitStateSummary): string {
  let latest = '';
  for (const check of summary.checks) {
    if (!PASS_EQUIVALENT_STATES.has(check.state.toUpperCase())) {
      continue;
    }
    if (!check.completedAt || check.completedAt <= latest) {
      continue;
    }
    latest = check.completedAt;
  }
  return latest || 'none';
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

export function parseArgs(argv: string[]): CiWaitStateArgs {
  const { values, help } = parseCliArgs(argv, CI_WAIT_STATE_FLAG_SPEC);
  return {
    prNumber: parseLenientPositiveIntegerOrNull(
      values.pr as string | undefined,
    ),
    owner: values.owner as string,
    repo: values.repo as string,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/ci-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--help]

Single-shot, read-only D-phase CI snapshot: per-check status keyed by
(checkName, workflowName), the live headRefOid, and a top-level
required-checks rollup. Performs no writes or reruns.
`);
}
