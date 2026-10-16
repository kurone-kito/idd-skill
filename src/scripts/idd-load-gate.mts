#!/usr/bin/env node

// idd-generated-from: src/scripts/idd-load-gate.mts
//
// The scripts/idd-load-gate.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
//
// Load gate for heavy steps (issue #4441, from #4439).
//
// The gate runs no command. It waits until the one-minute load average is
// below the limit, then exits 0 so a `&&` chain continues. If the timeout ends
// with the load still at or above the limit, it exits 3 so the chain stops.
// An unreadable load fails closed, counting as at or above the limit.

import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { readOneMinuteLoad } from './idd-worker-budget.mts';

const IDD_LOAD_GATE_FLAG_SPEC = {
  '--max-load': { type: 'string' },
  '--timeout-ms': { type: 'string' },
  '--poll-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

export const DEFAULT_TIMEOUT_MS = 600000;
export const DEFAULT_POLL_MS = 30000;

const USAGE = `Usage:
  node scripts/idd-load-gate.mjs [--max-load <n>] [--timeout-ms <ms>] [--poll-ms <ms>]

Wait until the 1-minute load average is below --max-load (default: the CPU
count). Check it every --poll-ms (default ${DEFAULT_POLL_MS}) until --timeout-ms
(default ${DEFAULT_TIMEOUT_MS}) elapses.

Exits 0 when the load passes, 3 when the timeout ends at or above the limit,
and 2 on a usage error. Prints one JSON line on stdout for a pass or a
timeout. Runs no command itself: place it first in a && chain.

Options:
  --max-load <n>      positive decimal limit (default: CPU count)
  --timeout-ms <ms>   non-negative integer (default: ${DEFAULT_TIMEOUT_MS})
  --poll-ms <ms>      positive integer poll interval (default: ${DEFAULT_POLL_MS})
  --help, -h          Show this help
`;

/** Parsed gate options. `maxLoad` stays undefined until the CPU count is known. */
export interface LoadGateArgs {
  maxLoad: number | undefined;
  timeoutMs: number;
  pollMs: number;
  help: boolean;
}

/** The injectable readers, so tests never touch real load or wall time. */
export interface LoadGateReaders {
  /** The 1-minute load average, or null when the platform reports none. */
  load1m: () => number | null;
  coreCount: () => number;
  /** A monotonic clock, in milliseconds. */
  now: () => number;
  /** Blocks the caller for `ms` milliseconds. */
  sleep: (ms: number) => void;
}

/** One gate verdict, printed as the single JSON line on stdout. */
export interface LoadGateVerdict {
  load1m: number | null;
  maxLoad: number;
  waitedMs: number;
  passed: boolean;
}

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function usageError(flagName: string): Error {
  return markCliUsageError(
    new Error(`invalid value for argument: ${flagName}`),
  );
}

/**
 * A positive finite decimal. A token that is syntactically valid but too large
 * for a JavaScript number parses to Infinity, which must not pass as a limit.
 */
function parseMaxLoadOrThrow(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const value = DECIMAL_PATTERN.test(token) ? Number(token) : Number.NaN;
  if (!(Number.isFinite(value) && value > 0)) {
    throw usageError('--max-load');
  }
  return value;
}

/**
 * A canonical integer within the safe range. Beyond it the parser rounds, so
 * the wait arithmetic and the Atomics.wait timeout would not match the request.
 */
function parseSafeIntegerOrThrow(
  token: string,
  flagName: string,
  min: number,
): number {
  const value = parseCanonicalIntegerOrThrow(token, flagName, min);
  if (!Number.isSafeInteger(value)) throw usageError(flagName);
  return value;
}

/** Parse the gate's argv. A bad value or an unknown flag throws a usage error. */
export function parseLoadGateArgs(argv: readonly string[]): LoadGateArgs {
  const { values, help } = parseCliArgs(argv, IDD_LOAD_GATE_FLAG_SPEC);
  const timeoutToken = values['timeout-ms'] as string | undefined;
  const pollToken = values['poll-ms'] as string | undefined;
  return {
    maxLoad: parseMaxLoadOrThrow(values['max-load'] as string | undefined),
    timeoutMs:
      timeoutToken === undefined
        ? DEFAULT_TIMEOUT_MS
        : parseSafeIntegerOrThrow(timeoutToken, '--timeout-ms', 0),
    pollMs:
      pollToken === undefined
        ? DEFAULT_POLL_MS
        : parseSafeIntegerOrThrow(pollToken, '--poll-ms', 1),
    help,
  };
}

/**
 * Wait for the load to fall below the limit, or give up at the timeout.
 *
 * Each pass reads the load first. A pass ends the wait; a read at or past the
 * deadline is the final sample, so the timeout verdict never rests on a stale
 * reading. Otherwise the loop sleeps the shorter of one poll interval and the
 * time left before the deadline. A null load never passes (fail closed).
 */
export function waitForLoad(
  args: { maxLoad?: number | undefined; timeoutMs: number; pollMs: number },
  readers: LoadGateReaders,
): LoadGateVerdict {
  const maxLoad = args.maxLoad ?? readers.coreCount();
  const start = readers.now();
  for (;;) {
    const load1m = readers.load1m();
    const elapsed = readers.now() - start;
    const waitedMs = Math.max(0, Math.round(elapsed));
    if (load1m !== null && load1m < maxLoad) {
      return { load1m, maxLoad, waitedMs, passed: true };
    }
    if (elapsed >= args.timeoutMs) {
      return { load1m, maxLoad, waitedMs, passed: false };
    }
    readers.sleep(Math.min(args.pollMs, args.timeoutMs - elapsed));
  }
}

// One shared cell, never notified, so Atomics.wait blocks for the full timeout.
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** The production readers; exported so a test can pin the CPU-count default. */
export const LOAD_GATE_DEFAULT_READERS: LoadGateReaders = {
  load1m: () => readOneMinuteLoad(os.loadavg()),
  coreCount: () => os.cpus().length,
  now: () => performance.now(),
  sleep: (ms) => {
    Atomics.wait(SLEEP_CELL, 0, 0, ms);
  },
};

/**
 * Run the gate. A usage error is returned as exit 2 with the `usage` kind, on
 * both the envelope and the envelope-unset path, so the exit code is 2 either
 * way; any other error keeps the shared runner's own handling.
 */
function runCli(): HelperCliResult {
  let args: LoadGateArgs;
  try {
    args = parseLoadGateArgs(process.argv.slice(2));
  } catch (error) {
    const classified = classifyHelperError(error);
    if (classified.kind !== 'usage') throw error;
    return { exitCode: 2, kind: 'usage', message: classified.message };
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const verdict = waitForLoad(args, LOAD_GATE_DEFAULT_READERS);
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (verdict.passed) return 0;
  return {
    exitCode: 3,
    kind: 'gate',
    message: 'load stayed at or above the limit until the timeout',
  };
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-load-gate', runCli);
  } else {
    const outcome = runCli();
    if (typeof outcome !== 'number' && outcome.kind === 'usage') {
      process.stderr.write(`idd-load-gate: ${outcome.message ?? 'usage'}\n`);
    }
    applyHelperCliOutcomeWhenDisabled(outcome);
  }
}
