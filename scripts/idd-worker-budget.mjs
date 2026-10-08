#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-worker-budget.mts
//
// The scripts/idd-worker-budget.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
// Read-only dispatch budget for one orchestrator session (#3835).
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
import { normalizePolicyConfig } from './policy-helpers.mjs';

const WORKER_BUDGET_FLAG_SPEC = {
  '--running': { type: 'string' },
  '--startable': { type: 'string' },
  '--harness-limit': { type: 'string' },
  '--policy': { type: 'string' },
  '--no-network': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
const HOST_MEMORY_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
const API_REMAINING_FLOOR = 500;
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
  const running = parseCanonicalIntegerOrThrow(runningToken, '--running', 0);
  const startable = parseCanonicalIntegerOrThrow(
    startableToken,
    '--startable',
    0,
  );
  const harnessToken = values['harness-limit'];
  const harnessLimit =
    harnessToken === undefined
      ? null
      : parseCanonicalIntegerOrThrow(harnessToken, '--harness-limit', 0);
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
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
  --no-network         Skip the GitHub rate-limit read without blocking
  --help, -h           Show this help

Counts must be non-negative integers. Output is one JSON object.\n`);
}
