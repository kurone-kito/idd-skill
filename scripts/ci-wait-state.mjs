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
import { ghText, isCliExecution } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { summarizeBranchReviewRequirements } from './protocol-helpers.mjs';

// Interpretation table this bucketing mirrors exactly:
// idd-ci.instructions.md's "Interpretation" section. Keep these three sets in
// sync with that table's normalized states.
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
function main() {
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
  );
  const encodedBaseRefName = encodeURIComponent(String(pr.baseRefName ?? ''));
  const branchRules = ghApiJsonOr404Empty(
    `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
    true,
  );
  const branchProtection = ghApiJsonOr404Empty(
    `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
    false,
  );
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
export function buildCiWaitStateSummary(input, options = {}) {
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
function normalizeCheckEntry(entry, requiredCheckNameSet) {
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
function bucketState(state) {
  if (FAILURE_STATES.has(state)) return 'failure';
  if (PENDING_STATES.has(state)) return 'pending';
  if (SUCCESS_STATES.has(state)) return 'success';
  return 'unknown';
}
function buildRequiredChecksRollup(
  checks,
  requiredCheckNameSet,
  requiredCheckSourcePinned,
) {
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
  let status;
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
function parseArgs(argv) {
  const parsed = {
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
function ghApiJsonOr404Empty(path, paginate) {
  const args = paginate
    ? ['api', path, '--paginate', '--jq', '.']
    : ['api', path];
  try {
    const raw = execFileSync('gh', args, { encoding: 'utf8' }).trim();
    if (!raw) {
      return paginate ? [] : {};
    }
    if (!paginate) {
      return JSON.parse(raw);
    }
    // `gh api --paginate --jq '.'` on an array-shaped endpoint emits one
    // JSON array per page; flatten instead of assuming a single page.
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      });
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return paginate ? [] : {};
    }
    throw error;
  }
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/ci-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]

Single-shot, read-only D-phase CI snapshot: per-check status keyed by
(checkName, workflowName), the live headRefOid, and a top-level
required-checks rollup. Performs no writes or reruns.
`);
}
