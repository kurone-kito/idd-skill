#!/usr/bin/env node
// idd-generated-from: src/scripts/ci-wait-policy.mts
//
// The scripts/ci-wait-policy.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import { loadJson, validateConfigSection } from './validate-schemas.mts';

const DEFAULT_RUNNING_TIMEOUT = 'PT30M';
const DEFAULT_GENERATION_TIMEOUT = 'PT10M';
const DEFAULT_RERUN_POLICY = 'rerun-once';
const DEFAULT_POLICY_PATH = '.github/idd/config.json';
const RERUN_POLICIES = new Set(['rerun-once', 'hold']);
/** A conservative GitHub owner/repo identifier character class --
 * alphanumeric, hyphen, underscore, period. Mirrors
 * `rerun-advisory-convergence.mts`'s own `GITHUB_IDENTIFIER_PATTERN` for
 * the identical `--owner`/`--repo` flags: not GitHub's exact validation
 * rule, just a defensive CLI-input guard against whitespace or a shell
 * metacharacter reaching the `gh api repos/{owner}/{repo}/...` path this
 * file's `--run-id` resolution builds from these values. */
const GITHUB_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const ISO_DURATION_PATTERN =
  /^P(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');

interface CiWaitPolicy {
  runningTimeout: string;
  runningTimeoutMs: number | null;
  generationTimeout: string;
  generationTimeoutMs: number | null;
  rerunPolicy: string;
}

interface CiRerunDecision {
  action: string;
  reason: string;
  rerunPolicy: string;
  rerunCount: number;
  /** Present only when the #1997 hatch was evaluated. */
  hatch?: EvidenceGatedHatch;
}

export interface EvidenceGatedHatch {
  applied: boolean;
  failureClass: string;
  siblingSweep: SiblingSweepResult;
}

export interface SiblingRunLike {
  id: string | number;
  conclusion?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

export interface SiblingSweepResult {
  query: string;
  allOthersSucceeded: boolean;
  otherCount: number;
  otherConclusions: string[];
}

/** Actions run-payload fields this file reads for `--run-id` resolution. */
interface RawWorkflowRunPayload {
  run_attempt?: number | null;
  conclusion?: string | null;
  name?: string | null;
  created_at?: string | null;
}

/** Half-window on each side of the failed run's created_at (#1997). */
export const SIBLING_SWEEP_HALF_WINDOW_MS = 60 * 60 * 1000;
export const SIBLING_SWEEP_LIMIT = 15;

export const DEFAULT_CI_WAIT_POLICY = Object.freeze({
  runningTimeout: DEFAULT_RUNNING_TIMEOUT,
  runningTimeoutMs: 30 * 60 * 1000,
  generationTimeout: DEFAULT_GENERATION_TIMEOUT,
  generationTimeoutMs: 10 * 60 * 1000,
  rerunPolicy: DEFAULT_RERUN_POLICY,
});

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `policy:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --rerun-count spec
// key below. See cli-args.mts's module header for the full invariant.
// (Deliberately not written inside matching quote marks in this comment --
// see advisory-convergence.mts's identical note for why.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see #1177's entry-order TDZ hardening for the same class
// of bug in this file).
const CI_WAIT_POLICY_FLAG_SPEC = {
  '--policy': { type: 'string', default: DEFAULT_POLICY_PATH },
  '--rerun-count': { type: 'string' },
  '--run-id': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

export function parseDurationToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = ISO_DURATION_PATTERN.exec(text);
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const seconds = Number.parseInt(match[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function normalizeCiWaitPolicy(ciWait: unknown = {}): CiWaitPolicy {
  const c = (ciWait ?? {}) as {
    runningTimeout?: unknown;
    generationTimeout?: unknown;
    rerunPolicy?: unknown;
  };
  const runningTimeout = normalizeDuration(
    c.runningTimeout,
    DEFAULT_RUNNING_TIMEOUT,
  );
  const generationTimeout = normalizeDuration(
    c.generationTimeout,
    DEFAULT_GENERATION_TIMEOUT,
  );
  const rerunPolicy = normalizeRerunPolicy(c.rerunPolicy);

  return {
    runningTimeout,
    runningTimeoutMs: parseDurationToMs(runningTimeout),
    generationTimeout,
    generationTimeoutMs: parseDurationToMs(generationTimeout),
    rerunPolicy,
  };
}

export function readCiWaitPolicy(
  policyPath: string = DEFAULT_POLICY_PATH,
): CiWaitPolicy {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), DEFAULT_POLICY_PATH);

  try {
    const config = JSON.parse(readFileSync(source, 'utf8'));
    // Scoped to the ciWait subtree (#1359): an unrelated invalid field
    // elsewhere in the document (an unknown top-level key, a typo'd enum in
    // a sibling section, ...) must not zero out an otherwise-valid ciWait
    // section.
    if (validateConfigSection(config, POLICY_SCHEMA, 'ciWait').length > 0) {
      return { ...DEFAULT_CI_WAIT_POLICY };
    }
    return normalizeCiWaitPolicy(
      (config as { ciWait?: unknown } | null)?.ciWait,
    );
  } catch {
    return { ...DEFAULT_CI_WAIT_POLICY };
  }
}

export function resolveCiRerunDecision({
  rerunPolicy = DEFAULT_RERUN_POLICY,
  rerunCount = 0,
  failureClass,
  siblingSweep,
}: {
  rerunPolicy?: unknown;
  rerunCount?: unknown;
  failureClass?: unknown;
  siblingSweep?: SiblingSweepResult;
} = {}): CiRerunDecision {
  const normalizedPolicy = normalizeRerunPolicy(rerunPolicy);
  const normalizedCount =
    typeof rerunCount === 'number' &&
    Number.isInteger(rerunCount) &&
    rerunCount > 0
      ? rerunCount
      : 0;

  if (normalizedPolicy === 'hold') {
    return {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  if (normalizedCount === 0) {
    return {
      action: 'rerun',
      reason: 'rerun-budget-available',
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  const hatch = evaluateEvidenceGatedHatch({
    rerunCount: normalizedCount,
    failureClass,
    siblingSweep,
  });
  if (hatch?.applied === true) {
    return {
      action: 'rerun',
      reason: 'evidence-gated-extra-rerun',
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
      hatch,
    };
  }

  return {
    action: 'hold',
    reason: 'rerun-budget-exhausted',
    rerunPolicy: normalizedPolicy,
    rerunCount: normalizedCount,
    ...(hatch ? { hatch } : {}),
  };
}

export function normalizeFailureClass(value: unknown): string | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'timed_out' || text === 'timeout') {
    return 'timeout';
  }
  if (text === 'cancelled' || text === 'canceled') {
    return 'cancelled';
  }
  return null;
}

function evaluateEvidenceGatedHatch({
  rerunCount,
  failureClass,
  siblingSweep,
}: {
  rerunCount: number;
  failureClass?: unknown;
  siblingSweep?: SiblingSweepResult;
}): EvidenceGatedHatch | undefined {
  if (siblingSweep === undefined && failureClass === undefined) {
    return undefined;
  }
  const normalizedClass = normalizeFailureClass(failureClass);
  const sweep =
    siblingSweep ??
    ({
      query: '',
      allOthersSucceeded: false,
      otherCount: 0,
      otherConclusions: [],
    } satisfies SiblingSweepResult);
  const applied =
    rerunCount === 1 &&
    normalizedClass !== null &&
    sweep.allOthersSucceeded === true &&
    sweep.otherCount > 0;
  return {
    applied,
    failureClass: normalizedClass ?? String(failureClass ?? ''),
    siblingSweep: sweep,
  };
}

export function evaluateSiblingWorkflowSweep(
  runs: SiblingRunLike[],
  {
    currentRunId,
    windowStartMs,
    windowEndMs,
    query,
  }: {
    currentRunId: string;
    windowStartMs: number;
    windowEndMs: number;
    query: string;
  },
): SiblingSweepResult {
  const others: SiblingRunLike[] = [];
  for (const run of runs) {
    if (String(run.id) === currentRunId) {
      continue;
    }
    if (String(run.status ?? '').toLowerCase() !== 'completed') {
      continue;
    }
    const createdMs = Date.parse(String(run.createdAt ?? ''));
    if (
      !Number.isFinite(createdMs) ||
      createdMs < windowStartMs ||
      createdMs > windowEndMs
    ) {
      continue;
    }
    others.push(run);
  }
  const otherConclusions = others.map((run) =>
    String(run.conclusion ?? '').toLowerCase(),
  );
  return {
    query,
    allOthersSucceeded:
      others.length > 0 &&
      otherConclusions.every((conclusion) => conclusion === 'success'),
    otherCount: others.length,
    otherConclusions,
  };
}

/**
 * Derive the CI-wait rerun count mechanically from a live Actions run's
 * `run_attempt` field: `run_attempt` starts at `1` for the original run and
 * increments by one on every rerun (`gh run rerun`, regardless of which
 * session or actor issued it, including a human clicking "Re-run failed
 * jobs" in the GitHub UI), so `run_attempt - 1` is exactly "how many times
 * has this run already been rerun" -- the same quantity `--rerun-count`
 * otherwise requires the caller to track manually, session-locally (#1996).
 *
 * Mirrors `rerun-advisory-convergence.mts`'s `resolveInstanceRerunDecision`,
 * which treats a missing or non-numeric `run_attempt` as fail-closed
 * (`'run-attempt-unknown'`) rather than silently deriving `rerunCount: 0`
 * from a guess -- the same reasoning applies here: `resolveCiRerunDecision`
 * would otherwise resolve an invented `0` to `action: 'rerun'`, which is
 * never something this helper should decide from unreadable data. A
 * `run_attempt: 0` is rejected by the `>= 1` bound below for the same
 * reason -- letting it through would produce `rerunCount: -1`, which
 * `resolveCiRerunDecision`'s own non-negative-integer normalization
 * silently collapses back to `0`, reintroducing the exact silent-zero this
 * function exists to prevent.
 */
export function deriveRerunCountFromRunAttempt(runAttempt: unknown): number {
  if (
    typeof runAttempt === 'number' &&
    Number.isInteger(runAttempt) &&
    runAttempt >= 1
  ) {
    return runAttempt - 1;
  }
  throw new Error(
    `cannot derive --rerun-count from run_attempt: expected a positive integer, got ${JSON.stringify(runAttempt)}`,
  );
}

/**
 * Fetch the live Actions run `runId` (`GET
 * repos/{owner}/{repo}/actions/runs/{run_id}`) and derive its rerun count
 * via {@link deriveRerunCountFromRunAttempt}. Routed through
 * provider-port.mts's `getWorkflowRun` (#2267), which reuses the same
 * timeout-guarded `GH_TEXT_LOOP_TIMEOUT_OPTIONS` pattern
 * `rerun-advisory-convergence.mts`'s `collectFromGitHub` already uses for
 * the identical per-run `run_attempt` lookup, so a stalled or
 * unexpectedly-interactive `gh` call here fails closed within a bounded
 * timeout instead of hanging this policy resolver indefinitely.
 */
export function fetchRerunCountFromRunId(
  owner: string,
  repo: string,
  runId: string,
): number {
  return deriveRerunCountFromRunAttempt(
    fetchWorkflowRun(owner, repo, runId).run_attempt,
  );
}

export function fetchWorkflowRun(
  owner: string,
  repo: string,
  runId: string,
): RawWorkflowRunPayload {
  return createGithubProviderAdapter(owner, repo).getWorkflowRun(
    owner,
    repo,
    runId,
  ) as RawWorkflowRunPayload;
}

export function siblingSweepQuery(workflowName: string): string {
  return `gh run list --workflow=${JSON.stringify(workflowName)} --limit ${String(SIBLING_SWEEP_LIMIT)}`;
}

function normalizeDuration(value: unknown, fallback: string): string {
  if (parseDurationToMs(value) === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeRerunPolicy(value: unknown): string {
  const text = String(value ?? '').trim();
  return RERUN_POLICIES.has(text) ? text : DEFAULT_RERUN_POLICY;
}

// #1996: output shape when `--run-id` is not given must stay byte-for-byte
// identical to the pre-#1996 `{policy, rerunDecision?}` shape -- the
// existing `--rerun-count`-only CLI test asserts a `deepEqual` against
// exactly that shape, and the issue's own acceptance criteria requires
// `--rerun-count` to keep working "unchanged" when `--run-id` is absent.
// The three `--run-id`-derived fields below are therefore only ever added
// to `output` inside the `args.runId !== null` branch.
interface CiWaitPolicyOutput {
  policy: CiWaitPolicy;
  rerunDecision?: CiRerunDecision;
  /** Present only when `--run-id` was given: which source ultimately
   * supplied `rerunDecision`'s `rerunCount` -- the live `run_attempt`
   * lookup, or the `--rerun-count` fallback after that lookup failed. */
  rerunCountSource?: 'run-id' | 'rerun-count';
  /** Present only when `--run-id` was given and its live lookup succeeded:
   * the fetched run's raw `run_attempt` value, for caller-side auditing. */
  runAttempt?: number;
  /** Present only when `--run-id` was given and its live lookup failed but
   * a `--rerun-count` fallback was available -- the failure reason, so a
   * caller silently falling back to the offline value can still see why. */
  runIdLookupError?: string;
  /** Present when `--run-id` resolved a timeout/cancelled conclusion. */
  failureClass?: string;
  /** Present when a same-window sibling sweep was computed (#1997). */
  siblingSweep?: SiblingSweepResult;
}

function fetchSiblingWorkflowRuns(
  owner: string,
  repo: string,
  workflowName: string,
): SiblingRunLike[] {
  return createGithubProviderAdapter(owner, repo).listWorkflowRuns(
    owner,
    repo,
    workflowName,
    SIBLING_SWEEP_LIMIT,
  );
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const policy = readCiWaitPolicy(args.policy);
  const output: CiWaitPolicyOutput = { policy };

  let rerunCount = args.rerunCount;

  if (args.runId !== null) {
    // #1996: owner/repo auto-detection (`gh repo view`) lives INSIDE this
    // try block, not just the `fetchRerunCountFromRunId` call below -- a
    // caller can give `--run-id` with neither `--owner` nor `--repo`, and
    // a failure resolving either (same network/permission/transient class
    // as the run lookup itself) is just as much "the live lookup did not
    // yield a usable rerunCount" as a failure inside
    // fetchRerunCountFromRunId. Excluding it from the try would let that
    // one failure mode crash uncaught instead of falling back to an
    // explicitly-given --rerun-count, silently breaking the documented
    // fallback contract for exactly this path (caught by the C1 critique
    // pass; regression-guarded by the "resolves owner/repo INSIDE the
    // fallback" CLI test below).
    try {
      const currentRepo =
        args.owner && args.repo ? null : resolveCurrentGithubRepository();
      const owner = args.owner || currentRepo?.owner || '';
      const repo = args.repo || currentRepo?.repo || '';
      const run = fetchWorkflowRun(owner, repo, args.runId);
      rerunCount = deriveRerunCountFromRunAttempt(run.run_attempt);
      output.rerunCountSource = 'run-id';
      output.runAttempt = rerunCount + 1;
      const failureClass = normalizeFailureClass(run.conclusion);
      if (failureClass !== null) {
        output.failureClass = failureClass;
      }
      const workflowName = String(run.name ?? '').trim();
      const createdMs = Date.parse(String(run.created_at ?? ''));
      // #1997 hatch can change the decision only after the first
      // rerun-once attempt. Skip the sibling-list call otherwise.
      if (
        policy.rerunPolicy === 'rerun-once' &&
        rerunCount === 1 &&
        failureClass !== null &&
        workflowName &&
        Number.isFinite(createdMs)
      ) {
        const query = siblingSweepQuery(workflowName);
        const siblingRuns = fetchSiblingWorkflowRuns(owner, repo, workflowName);
        output.siblingSweep = evaluateSiblingWorkflowSweep(siblingRuns, {
          currentRunId: args.runId,
          windowStartMs: createdMs - SIBLING_SWEEP_HALF_WINDOW_MS,
          windowEndMs: createdMs + SIBLING_SWEEP_HALF_WINDOW_MS,
          query,
        });
      }
    } catch (error) {
      // #1996: unifies three distinct failure modes -- owner/repo
      // auto-detection failing, the `gh api` run lookup itself failing
      // (network/permission/transient), and the lookup succeeding but
      // returning a payload with a missing or non-numeric `run_attempt`
      // (deriveRerunCountFromRunAttempt's own throw) -- into one "the live
      // lookup did not yield a usable rerunCount" outcome, matching how
      // rerun-advisory-convergence.mts's own collection step unifies
      // several failure sources into the same `runAttempt: null` signal.
      // `--run-id` takes precedence over `--rerun-count` only when the
      // live lookup actually succeeds; on any of these failure modes, fall
      // back to an explicitly-given `--rerun-count` (the issue's own
      // "explicit override / offline path" language), or fail closed with
      // a clear, non-zero exit -- never a silent `rerunCount: 0`.
      if (args.rerunCount === null) {
        throw new Error(
          `--run-id ${args.runId} lookup failed and no --rerun-count fallback was given: ${(error as Error).message}`,
          { cause: error },
        );
      }
      output.rerunCountSource = 'rerun-count';
      output.runIdLookupError = (error as Error).message;
      rerunCount = args.rerunCount;
    }
  }

  if (rerunCount !== null) {
    output.rerunDecision = resolveCiRerunDecision({
      rerunPolicy: policy.rerunPolicy,
      rerunCount,
      failureClass: output.failureClass,
      siblingSweep: output.siblingSweep,
    });
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

/**
 * Validate `token` as a canonical positive-integer string (same format and
 * `min: 1` bound `--rerun-count`'s sibling validation uses), but return the
 * ORIGINAL string rather than `parseCanonicalIntegerOrThrow`'s numeric
 * return value. A GitHub Actions run id is used only as an opaque path
 * segment (`repos/{owner}/{repo}/actions/runs/{run-id}`) -- round-tripping
 * it through a JavaScript `number` risks silent precision loss above
 * `Number.MAX_SAFE_INTEGER` (Copilot review, PR #1998), which this
 * function avoids by discarding the parsed number and keeping the
 * caller-supplied digits verbatim once format/bound validation passes.
 */
function validateRunIdToken(token: string): string {
  parseCanonicalIntegerOrThrow(token, '--run-id', 1);
  return token;
}

function parseArgs(argv: string[]): {
  policy: string;
  rerunCount: number | null;
  runId: string | null;
  owner: string;
  repo: string;
  help: boolean;
} {
  const { values, help } = parseCliArgs(argv, CI_WAIT_POLICY_FLAG_SPEC);
  const rerunCountToken = values['rerun-count'] as string | undefined;
  const runIdToken = values['run-id'] as string | undefined;
  const owner = (values.owner as string).trim();
  const repo = (values.repo as string).trim();
  if (Boolean(owner) !== Boolean(repo)) {
    throw new Error(
      '--owner and --repo must be given together (both or neither)',
    );
  }
  if (owner && !GITHUB_IDENTIFIER_PATTERN.test(owner)) {
    throw new Error(
      '--owner must contain only letters, digits, hyphens, underscores, or periods',
    );
  }
  if (repo && !GITHUB_IDENTIFIER_PATTERN.test(repo)) {
    throw new Error(
      '--repo must contain only letters, digits, hyphens, underscores, or periods',
    );
  }
  return {
    policy: values.policy as string,
    // `min: 0`: --rerun-count is a non-negative counter (0 is a valid
    // "no reruns yet" value), unlike the positive-integer contracts
    // elsewhere in this file's siblings. Throws (rather than resolving to
    // null) on violation, preserving this flag's existing fail-fast
    // contract -- see tests/ci-wait-policy.test.mts.
    rerunCount:
      rerunCountToken === undefined
        ? null
        : parseCanonicalIntegerOrThrow(rerunCountToken, '--rerun-count', 0),
    // `min: 1`: a workflow run id is never `0` -- mirrors the positive-
    // integer contract this file's `--rerun-count` sibling deliberately
    // opts out of (see the `min: 0` note above). Deliberately keeps the
    // ORIGINAL string token, not `String(parseCanonicalIntegerOrThrow(...))`
    // -- a run id above `Number.MAX_SAFE_INTEGER` would silently round
    // through that number round-trip (e.g. `9007199254740993` becomes
    // `9007199254740992`), querying a different run than the caller
    // requested (Copilot review, PR #1998). `parseCanonicalIntegerOrThrow`
    // is still called for its format/bound validation and shaped-error
    // throw -- its numeric return value is discarded on purpose.
    runId: runIdToken === undefined ? null : validateRunIdToken(runIdToken),
    owner,
    repo,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/ci-wait-policy.mjs [--policy <path>] [--rerun-count <count>]
    [--run-id <run-id> [--owner <owner> --repo <repo>]]

Resolves the shared ciWait policy defaults from .github/idd/config.json.
Optionally emits the deterministic rerun decision for a current rerun count.

--run-id fetches the live Actions run via
'gh api repos/{owner}/{repo}/actions/runs/{run-id}' and derives
rerunCount = run_attempt - 1 mechanically, taking precedence over
--rerun-count when the lookup succeeds. --owner/--repo default to the
local checkout's own repository when omitted (gh repo view); pass both or
neither. --rerun-count keeps working unchanged when --run-id is omitted,
and serves as the explicit override/offline fallback when the --run-id
lookup fails (network/permission error, or a missing/non-numeric
run_attempt in the fetched payload) -- absent that fallback, the CLI exits
non-zero rather than silently emitting rerunCount: 0.

A --run-id lookup whose conclusion is timed_out or cancelled also
sweeps sibling runs of the same workflow (limit 15, ±1 h) and may
emit reason evidence-gated-extra-rerun after the first rerun-once
attempt, only when every other completed sibling succeeded.
`);
}
