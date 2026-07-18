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
import { parseCliArgs } from './cli-args.mjs';
import { ghText } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import {
  parsePaginatedGhNdjson,
  selectLatestCheckInstance,
  summarizeBranchReviewRequirements,
} from './protocol-helpers.mjs';

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
};
if (import.meta.main) {
  main();
}
// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    // parseArgs normalizes both an absent --pr and an invalid one (e.g.
    // `--pr 0` or `--pr foo`) to null, so "missing" alone would misreport an
    // invalid value as absent.
    throw new Error('missing or invalid --pr <number> argument');
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
/**
 * Reduce `entries` to one representative per `checkName`, matching the
 * per-name dedup #1471 added to `classifyCiChecks` in
 * `protocol-helpers.mts`: GitHub can report several check-run instances
 * sharing one required check name (a manual or automatic rerun leaves the
 * earlier instance in the fetched rollup alongside the new one), and only
 * the latest instance per name should govern pass/fail/pending (#1478).
 * Reuses the exported `selectLatestCheckInstance` for the actual
 * same-name reduction (still-incomplete wins over completed; else latest
 * `completedAt` wins; a same-instant tie prefers `FAILURE`, then
 * non-`CANCELLED`) so this file does not maintain a second,
 * independently-drifting copy of that tie-break logic. Only the
 * name-keyed grouping below is local to this file, because
 * `CiWaitCheckEntry` uses `checkName` where `protocol-helpers.mts`'s
 * `CheckLike` uses `name`.
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
 * entries. What is guaranteed is that every group `selectLatestCheckInstance`
 * receives has at least one member: a group is only ever created by
 * pushing the entry that introduced its key (see the `Map` construction
 * below), so the seedless `reduce` inside `selectLatestCheckInstance`
 * never runs on an empty array.
 */
function selectLatestCheckEntryPerName(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.checkName);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.checkName, [entry]);
    }
  }
  return [...groups.values()].map((group) => selectLatestCheckInstance(group));
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
  let status;
  if (!allRequiredPresent) {
    status = 'missing';
  } else if (anyRequiredFailing) {
    status = 'failing';
  } else if (anyRequiredPending || anyRequiredUnknown) {
    status = 'pending';
  } else if (requiredCheckSourcePinned) {
    // Mixed case: enumerable required checks all pass, but a ruleset
    // `workflows` rule or an app-pinned classic check is ALSO in force and
    // not name-enumerable, so it is not covered by requiredEntries at all.
    // Mirrors summarizeRequiredChecks in protocol-helpers.mts, which
    // downgrades an otherwise-"success" classification to unresolved under
    // the same condition — never report a vacuous success while an
    // unverified source-pinned requirement could still be gating the branch.
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
    status,
  };
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
function parseLenientPositiveIntegerOrNull(token) {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, CI_WAIT_STATE_FLAG_SPEC);
  return {
    prNumber: parseLenientPositiveIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    help,
  };
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
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/ci-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--help]

Single-shot, read-only D-phase CI snapshot: per-check status keyed by
(checkName, workflowName), the live headRefOid, and a top-level
required-checks rollup. Performs no writes or reruns.
`);
}
