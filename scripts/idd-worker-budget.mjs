#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-worker-budget.mts
//
// The scripts/idd-worker-budget.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
// Read-only dispatch budget for one orchestrator session (#3835).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mjs';
import { ghApiJson } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadPolicyConfig } from './idd-config.mjs';
import { sanitizedGitEnvironment } from './local-worktree-occupancy.mjs';
import {
  inspectDevelopmentBranch,
  normalizePolicyConfig,
} from './policy-helpers.mjs';

const WORKER_BUDGET_FLAG_SPEC = {
  '--running': { type: 'string' },
  '--startable': { type: 'string' },
  '--harness-limit': { type: 'string' },
  '--policy': { type: 'string' },
  '--instructions-since': { type: 'string' },
  '--no-network': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
const HOST_MEMORY_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
const API_REMAINING_FLOOR = 500;
/** A well-formed `--instructions-since` value: 7 to 40 hex digits, any case. */
const INSTRUCTIONS_SINCE_PATTERN = /^[0-9a-fA-F]{7,40}$/;
/**
 * The files an orchestrator session reads as instructions, as top-level
 * literal pathspecs so the list does not depend on the working directory or
 * on glob characters.
 */
const INSTRUCTION_PATHSPECS = [
  ':(top,literal).github/instructions/',
  ':(top,literal)docs/idd-workflow.md',
];
/**
 * Git variables that change how a pathspec is read. A literal-pathspecs
 * setting in particular would make the `:(top,literal)` prefix match nothing
 * and report "no change" with no error, so they are removed for the call.
 */
const PATHSPEC_ENVIRONMENT_VARIABLES = [
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
];
const REMOTE_REF_PREFIX = 'refs/remotes/origin/';
/** A full object name (SHA-1 or SHA-256) as `git rev-parse` prints it. */
const FULL_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_READERS = {
  load1m: () => readOneMinuteLoad(os.loadavg()),
  coreCount: () => os.cpus().length,
  procMemAvailableBytes: () => {
    const contents = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(contents);
    return match ? Number(match[1]) * 1024 : null;
  },
  freeMemoryBytes: () => os.freemem(),
  rateLimit: () => ghApiJson('rate_limit'),
};
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-worker-budget', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}
/**
 * Parse a worker count, rejecting values beyond the safe integer range. The
 * shared canonical parser accepts any digit string, and an unsafe value would
 * be silently rounded before the budget arithmetic runs.
 */
function parseWorkerCountOrThrow(token, flagName) {
  const value = parseCanonicalIntegerOrThrow(token, flagName, 0);
  if (!Number.isSafeInteger(value)) {
    throw markCliUsageError(
      new Error(`invalid value for argument: ${flagName}`),
    );
  }
  return value;
}
function runCli() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    WORKER_BUDGET_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const runningToken = values.running;
  const startableToken = values.startable;
  if (runningToken === undefined) {
    throw markCliUsageError(new Error('--running is required'));
  }
  if (startableToken === undefined) {
    throw markCliUsageError(new Error('--startable is required'));
  }
  const running = parseWorkerCountOrThrow(runningToken, '--running');
  const startable = parseWorkerCountOrThrow(startableToken, '--startable');
  const harnessToken = values['harness-limit'];
  const harnessLimit =
    harnessToken === undefined
      ? null
      : parseWorkerCountOrThrow(harnessToken, '--harness-limit');
  const sinceToken = values['instructions-since'];
  const since =
    sinceToken === undefined
      ? undefined
      : parseInstructionsSinceOrThrow(sinceToken);
  const policyPath = values.policy;
  const policy = loadPolicyConfig(policyPath).config;
  const { maxWorkers } = normalizePolicyConfig(policy).orchestrator;
  const result = computeWorkerBudget(
    {
      maxWorkers,
      running,
      startable,
      harnessLimit,
      noNetwork: values['no-network'] === true,
    },
    DEFAULT_READERS,
  );
  const output =
    since === undefined
      ? result
      : { ...result, ...readInstructionsReport({ since, policy }) };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}
/** Reject anything but 7 to 40 hexadecimal characters as a usage error. */
function parseInstructionsSinceOrThrow(token) {
  if (!INSTRUCTIONS_SINCE_PATTERN.test(token)) {
    throw markCliUsageError(
      new Error('invalid value for argument: --instructions-since'),
    );
  }
  return token;
}
/** Read host and optional API signals, then calculate the session's slots. */
export function computeWorkerBudget(request, readers = DEFAULT_READERS) {
  const load1m = safeNonNegativeNumber(readers.load1m);
  const coreCount = safePositiveInteger(readers.coreCount);
  const availableMemoryBytes = readAvailableMemoryBytes(readers);
  let restRemaining = null;
  let graphqlRemaining = null;
  let apiUnavailable = false;
  if (!request.noNetwork) {
    try {
      const rateLimit = readers.rateLimit();
      const resources = asRecord(asRecord(rateLimit)?.resources);
      restRemaining = readRemaining(asRecord(resources?.core)?.remaining);
      graphqlRemaining = readRemaining(asRecord(resources?.graphql)?.remaining);
      apiUnavailable = restRemaining === null || graphqlRemaining === null;
    } catch {
      apiUnavailable = true;
    }
  }
  const limits = [
    request.maxWorkers - request.running,
    ...(request.harnessLimit === null
      ? []
      : [request.harnessLimit - request.running]),
    request.startable,
  ];
  const slots = Math.max(0, Math.min(...limits));
  let limitingFactor;
  if (load1m === null || coreCount === null || load1m > coreCount) {
    limitingFactor = 'host-load';
  } else if (
    availableMemoryBytes === null ||
    availableMemoryBytes < HOST_MEMORY_FLOOR_BYTES
  ) {
    limitingFactor = 'host-memory';
  } else if (apiUnavailable) {
    limitingFactor = 'api-unavailable';
  } else if (
    !request.noNetwork &&
    (restRemaining === null ||
      graphqlRemaining === null ||
      restRemaining < API_REMAINING_FLOOR ||
      graphqlRemaining < API_REMAINING_FLOOR)
  ) {
    limitingFactor = 'api-rate-limit';
  } else {
    const capRemaining = request.maxWorkers - request.running;
    const harnessRemaining =
      request.harnessLimit === null
        ? Number.POSITIVE_INFINITY
        : request.harnessLimit - request.running;
    const bindingLimit = Math.min(
      capRemaining,
      harnessRemaining,
      request.startable,
    );
    if (capRemaining === bindingLimit) {
      limitingFactor = 'cap';
    } else if (harnessRemaining === bindingLimit) {
      limitingFactor = 'harness-limit';
    } else {
      limitingFactor = 'candidates';
    }
  }
  if (
    limitingFactor === 'host-load' ||
    limitingFactor === 'host-memory' ||
    limitingFactor === 'api-unavailable' ||
    limitingFactor === 'api-rate-limit'
  ) {
    return {
      slots: 0,
      limitingFactor,
      maxWorkers: request.maxWorkers,
      harnessLimit: request.harnessLimit,
      running: request.running,
      startable: request.startable,
      load1m,
      coreCount,
      availableMemoryBytes,
      restRemaining,
      graphqlRemaining,
    };
  }
  return {
    slots,
    limitingFactor,
    maxWorkers: request.maxWorkers,
    harnessLimit: request.harnessLimit,
    running: request.running,
    startable: request.startable,
    load1m,
    coreCount,
    availableMemoryBytes,
    restRemaining,
    graphqlRemaining,
  };
}
/**
 * Report which instruction files differ between `request.since` and the tip of
 * the local base ref (issue #4376). Read-only and network-free: it never
 * fetches, so the tip is as fresh as the caller's last `git fetch`. Every
 * failure is returned as `instructionsChangedError`, never thrown, so the
 * budget fields are unaffected.
 */
export function readInstructionsReport(request) {
  let tip = null;
  const fail = (reason) => ({
    instructionsTip: tip,
    instructionsChanged: null,
    instructionsChangedError: reason,
  });
  try {
    const developmentBranch = inspectDevelopmentBranch(request.policy);
    if (developmentBranch.status === 'invalid') {
      return fail(`invalid developmentBranch: ${developmentBranch.reason}`);
    }
    const env = {
      ...sanitizedGitEnvironment(request.environment ?? process.env),
      GIT_OPTIONAL_LOCKS: '0',
    };
    for (const name of PATHSPEC_ENVIRONMENT_VARIABLES) {
      delete env[name];
    }
    // `--quiet` queries and `--is-ancestor` answer "no" with status 1; every
    // other non-zero status is a failure that carries git's own explanation.
    const git = (args, okStatuses = [0, 1]) =>
      runGit(args, request.cwd, env, okStatuses);
    let baseRef;
    if (developmentBranch.status === 'configured') {
      baseRef = `${REMOTE_REF_PREFIX}${developmentBranch.branch}`;
    } else {
      const head = git(['symbolic-ref', '--quiet', `${REMOTE_REF_PREFIX}HEAD`]);
      if (head.failure !== null) return fail(head.failure);
      if (head.status === 1) {
        return fail(
          `${REMOTE_REF_PREFIX}HEAD is not a symbolic ref and developmentBranch is not configured`,
        );
      }
      baseRef = head.text;
      if (
        !baseRef.startsWith(REMOTE_REF_PREFIX) ||
        baseRef.length === REMOTE_REF_PREFIX.length
      ) {
        return fail(`${REMOTE_REF_PREFIX}HEAD does not name an origin branch`);
      }
    }
    const baseName = baseRef.slice('refs/remotes/'.length);
    const tipOutcome = git([
      'rev-parse',
      '--verify',
      '--quiet',
      `${baseRef}^{commit}`,
    ]);
    if (tipOutcome.failure !== null) return fail(tipOutcome.failure);
    if (
      tipOutcome.status !== 0 ||
      !FULL_OBJECT_ID_PATTERN.test(tipOutcome.text)
    ) {
      return fail(`${baseName} does not resolve to a commit`);
    }
    tip = tipOutcome.text;
    const since = request.since.toLowerCase();
    const sinceOutcome = git([
      'rev-parse',
      '--verify',
      '--quiet',
      `${since}^{commit}`,
    ]);
    if (sinceOutcome.failure !== null) return fail(sinceOutcome.failure);
    // A ref named like a hex string would resolve to an unrelated commit, so
    // the result must still start with the digits the caller gave.
    if (
      sinceOutcome.status !== 0 ||
      !FULL_OBJECT_ID_PATTERN.test(sinceOutcome.text) ||
      !sinceOutcome.text.startsWith(since)
    ) {
      return fail(`${request.since} is not a commit in this repository`);
    }
    const ancestor = git([
      'merge-base',
      '--is-ancestor',
      sinceOutcome.text,
      tip,
    ]);
    if (ancestor.failure !== null) return fail(ancestor.failure);
    if (ancestor.status === 1) {
      return fail(`${request.since} is not an ancestor of ${baseName}`);
    }
    const diff = git(
      [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-relative',
        sinceOutcome.text,
        tip,
        '--',
        ...INSTRUCTION_PATHSPECS,
      ],
      [0],
    );
    if (diff.failure !== null) return fail(diff.failure);
    return {
      instructionsTip: tip,
      instructionsChanged: sortPathsInByteOrder(
        diff.stdout
          .toString('utf8')
          .split('\0')
          .filter((path) => path !== ''),
      ),
    };
  } catch (error) {
    return fail(
      `unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
/** Sort paths by their UTF-8 bytes, which is how git orders them. */
export function sortPathsInByteOrder(paths) {
  return paths
    .map((path) => ({ path, bytes: Buffer.from(path, 'utf8') }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
    .map((entry) => entry.path);
}
function runGit(args, cwd, env, okStatuses) {
  const result = spawnSync('git', [...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    killSignal: 'SIGKILL',
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const text = stdout.toString('utf8').trim();
  if (result.error) {
    return {
      failure: `git could not run: ${result.error.message}`,
      status: null,
      stdout,
      text,
    };
  }
  if (result.status === null || !okStatuses.includes(result.status)) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    const explanation =
      stderr.split(/\r?\n/)[0] || `exited with status ${result.status}`;
    return {
      failure: `git ${args[0]} failed: ${explanation}`,
      status: result.status,
      stdout,
      text,
    };
  }
  return { failure: null, status: result.status, stdout, text };
}
function readAvailableMemoryBytes(readers) {
  try {
    const procValue = readers.procMemAvailableBytes();
    const parsedProcValue = nonNegativeSafeInteger(procValue);
    if (parsedProcValue !== null) {
      return parsedProcValue;
    }
  } catch {
    // Fall back to the portable os reader when /proc is absent or unreadable.
  }
  return safeNonNegativeInteger(readers.freeMemoryBytes);
}
/** Return the one-minute load, treating Windows' unsupported zero as absent. */
export function readOneMinuteLoad(loadAverages, platform = process.platform) {
  if (platform === 'win32') return null;
  const value = loadAverages[0];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function safeNonNegativeNumber(read) {
  try {
    const value = read();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  } catch {
    return null;
  }
}
function safePositiveInteger(read) {
  try {
    const value = read();
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
function safeNonNegativeInteger(read) {
  try {
    return nonNegativeSafeInteger(read());
  } catch {
    return null;
  }
}
function nonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}
function readRemaining(value) {
  return nonNegativeSafeInteger(value);
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-worker-budget.mjs --running <n> --startable <n> [options]

Read-only worker-dispatch budget for one orchestrator session (#3835).

Options:
  --harness-limit <n>  Optional worker harness concurrency limit
  --policy <path>      Policy JSON path (defaults to .github/idd/config.json)
  --instructions-since <sha>
                       Also report instructionsTip and instructionsChanged:
                       the instruction files that differ between <sha> (7 to 40
                       hexadecimal characters) and the local origin tip. Reads
                       local refs only and never fetches
  --no-network         Skip the GitHub rate-limit read without blocking
  --help, -h           Show this help

Counts must be non-negative integers. Output is one JSON object.\n`);
}
