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

import { execFileSync } from 'node:child_process';

import { ghText, isCliExecution } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import {
  parsePaginatedGhNdjson,
  summarizeBranchReviewRequirements,
} from './protocol-helpers.mts';

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
  startedAt?: string | null;
  completedAt?: string | null;
}

/** PR payload fields consumed by this helper. */
interface PrPayload {
  headRefOid?: string | null;
  baseRefName?: string | null;
  statusCheckRollup?: StatusCheckRollupEntry[] | null;
}

/** One normalized, disambiguated per-check entry. */
export interface CiWaitCheckEntry {
  checkName: string;
  workflowName: string;
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
   * classic required check is in force but cannot be enumerated by name
   * (mirrors `summarizeBranchReviewRequirements`'s
   * `requiredCheckSourcePinned`). When this is true and `names` is empty,
   * `status` is `source-pinned`, not `no-required-checks` — required
   * checks are still gating the branch; this helper just cannot resolve
   * them by name, so callers must not treat it as a vacuous pass.
   */
  requiredCheckSourcePinned: boolean;
  status:
    | 'success'
    | 'pending'
    | 'failing'
    | 'missing'
    | 'no-required-checks'
    | 'source-pinned';
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
const FAILURE_STATES = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  // Commit-status contexts (StatusContext) report `error` as a state
  // distinct from `failure`; bucket it as failure too, or a clearly
  // failing required check would misleadingly read as "unknown".
  'ERROR',
]);

if (isCliExecution(import.meta.url)) {
  main();
}

// The CLI body. Guarded behind isCliExecution(import.meta.url) (shared, see
// gh-exec.mts) so importing this module (for unit tests) does not parse
// process.argv, fail, or make a `gh` call.
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;

  const pr = JSON.parse(
    ghText([
      'pr',
      'view',
      String(args.prNumber),
      '-R',
      repoRef,
      '--json',
      'headRefOid,baseRefName,statusCheckRollup',
    ]),
  ) as PrPayload;
  const encodedBaseRefName = encodeURIComponent(String(pr.baseRefName ?? ''));

  const branchRules = ghApiJsonOr404Empty(
    `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
    true,
  ) as BranchRulePayload[];
  const branchProtection = ghApiJsonOr404Empty(
    `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
    false,
  ) as BranchProtectionPayload;

  const branchReviewRequirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );

  const summary = buildCiWaitStateSummary(
    {
      headRefOid: pr.headRefOid ?? '',
      statusCheckRollup: pr.statusCheckRollup ?? [],
    },
    {
      requiredCheckNames: branchReviewRequirements.requiredCheckNames,
      requiredCheckSourcePinned:
        branchReviewRequirements.requiredCheckSourcePinned,
    },
  );

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
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
  return {
    checkName,
    // Trimmed like checkName: workflowName is part of the
    // (checkName, workflowName) disambiguation key, so untrimmed
    // whitespace-only differences could otherwise produce unstable keys
    // or spuriously "distinct" workflow entries.
    workflowName: String(entry?.workflowName ?? '').trim(),
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

function buildRequiredChecksRollup(
  checks: CiWaitCheckEntry[],
  requiredCheckNameSet: Set<string>,
  requiredCheckSourcePinned: boolean,
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
      status: requiredCheckSourcePinned
        ? 'source-pinned'
        : 'no-required-checks',
    };
  }

  const requiredEntries = checks.filter((check) => check.required);
  const presentNames = new Set(requiredEntries.map((check) => check.checkName));
  const missingNames = names.filter((name) => !presentNames.has(name));
  const allRequiredPresent = missingNames.length === 0;

  const anyRequiredFailing = requiredEntries.some(
    (check) => check.status === 'failure',
  );
  const anyRequiredPending = requiredEntries.some(
    (check) => check.status === 'pending',
  );
  const anyRequiredUnknown = requiredEntries.some(
    (check) => check.status === 'unknown',
  );
  const allRequiredPassing =
    allRequiredPresent &&
    requiredEntries.every((check) => check.status === 'success');

  let status: CiWaitRequiredChecksRollup['status'];
  if (!allRequiredPresent) {
    status = 'missing';
  } else if (anyRequiredFailing) {
    status = 'failing';
  } else if (anyRequiredPending || anyRequiredUnknown) {
    status = 'pending';
  } else {
    status = 'success';
  }

  return {
    names,
    missingNames,
    allRequiredPresent,
    allRequiredPassing,
    anyRequiredPending,
    anyRequiredFailing,
    anyRequiredUnknown,
    requiredCheckSourcePinned,
    status,
  };
}

function parseArgs(argv: string[]): CiWaitStateArgs {
  const parsed: CiWaitStateArgs = {
    prNumber: null,
    owner: '',
    repo: '',
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
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.prNumber) || (parsed.prNumber ?? 0) < 1) {
    parsed.prNumber = null;
  }

  return parsed;
}

/**
 * `gh api <path>`, tolerating a genuine 404 (unprotected branch / no active
 * rules) as an empty result. `gh` exits 1 for every HTTP error alike, so the
 * real status is derived from the error text via the shared
 * {@link deriveGhHttpStatus} rather than the useless process exit code —
 * the same discrimination `pre-merge-readiness.mts` and the A3/A4 discovery
 * helpers already rely on. Any other status (403, rate limit, transient
 * failure) propagates so this snapshot fails closed instead of silently
 * treating an auth/network failure as "no required checks configured".
 */
function ghApiJsonOr404Empty(path: string, paginate: boolean): unknown {
  // `--jq '.[]'` (NDJSON, one array element per line) is the repo-standard
  // paginate form — see gh-exec.mts and protocol-helpers.mts's
  // parsePaginatedGhNdjson, reused here rather than hand-rolling a second
  // parser. Unlike `--jq '.'`, it does not depend on gh's jq implementation
  // staying compact-per-page; `--slurp` (a single JSON array) landed in gh
  // v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0 via apt, so NDJSON stays
  // the compatible default.
  const args = paginate
    ? ['api', path, '--paginate', '--jq', '.[]']
    : ['api', path];
  try {
    const raw = execFileSync('gh', args, { encoding: 'utf8' });
    if (!paginate) {
      const trimmed = raw.trim();
      return trimmed ? JSON.parse(trimmed) : {};
    }
    return parsePaginatedGhNdjson(raw);
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return paginate ? [] : {};
    }
    throw error;
  }
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/ci-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]

Single-shot, read-only D-phase CI snapshot: per-check status keyed by
(checkName, workflowName), the live headRefOid, and a top-level
required-checks rollup. Performs no writes or reruns.
`);
}
