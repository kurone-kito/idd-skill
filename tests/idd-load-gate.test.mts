import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyHelperError } from '../src/scripts/helper-cli-runner.mts';
import {
  LOAD_GATE_DEFAULT_READERS,
  type LoadGateReaders,
  parseLoadGateArgs,
  waitForLoad,
} from '../src/scripts/idd-load-gate.mts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Readers driven by a load series (the last value repeats once exhausted)
 * and a fake clock that advances only when the gate sleeps.
 */
function fakeReaders(
  loads: readonly (number | null)[],
  cores = 24,
): { readers: LoadGateReaders; sleeps: number[]; reads: () => number } {
  let clock = 0;
  let reads = 0;
  const sleeps: number[] = [];
  const readers: LoadGateReaders = {
    load1m: () => {
      const value = loads[Math.min(reads, loads.length - 1)] ?? null;
      reads += 1;
      return value;
    },
    coreCount: () => cores,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { readers, sleeps, reads: () => reads };
}

function isUsageError(error: unknown): boolean {
  return classifyHelperError(error).kind === 'usage';
}

test('passes at once with waitedMs 0 when the load is below the limit', () => {
  const { readers, sleeps, reads } = fakeReaders([1.5]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 600000, pollMs: 30000 },
    readers,
  );
  assert.deepEqual(verdict, {
    load1m: 1.5,
    maxLoad: 24,
    waitedMs: 0,
    passed: true,
  });
  assert.deepEqual(sleeps, []);
  assert.equal(reads(), 1);
});

test('passes after waiting once the load falls below the limit before the timeout', () => {
  const { readers, sleeps } = fakeReaders([30, 30, 9]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 600000, pollMs: 30000 },
    readers,
  );
  assert.deepEqual(verdict, {
    load1m: 9,
    maxLoad: 24,
    waitedMs: 60000,
    passed: true,
  });
  assert.deepEqual(sleeps, [30000, 30000]);
});

test('exits with passed false when the timeout ends with the load still above the limit', () => {
  const { readers, sleeps, reads } = fakeReaders([30]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 90000, pollMs: 30000 },
    readers,
  );
  assert.deepEqual(verdict, {
    load1m: 30,
    maxLoad: 24,
    waitedMs: 90000,
    passed: false,
  });
  assert.deepEqual(sleeps, [30000, 30000, 30000]);
  // The read at the deadline is the final sample, so the verdict is current.
  assert.equal(reads(), 4);
});

test('a load exactly at the limit counts as at or above it', () => {
  const { readers } = fakeReaders([24]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 0, pollMs: 30000 },
    readers,
  );
  assert.equal(verdict.passed, false);
});

test('a zero timeout is a single check and never sleeps', () => {
  const { readers, sleeps, reads } = fakeReaders([30]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 0, pollMs: 30000 },
    readers,
  );
  assert.deepEqual(verdict, {
    load1m: 30,
    maxLoad: 24,
    waitedMs: 0,
    passed: false,
  });
  assert.deepEqual(sleeps, []);
  assert.equal(reads(), 1);
});

test('the last sleep is shortened to the deadline', () => {
  const { readers, sleeps } = fakeReaders([30]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 45000, pollMs: 30000 },
    readers,
  );
  assert.equal(verdict.waitedMs, 45000);
  assert.deepEqual(sleeps, [30000, 15000]);
});

test('an unreadable load fails closed and waits out the timeout', () => {
  const { readers, sleeps } = fakeReaders([null]);
  const verdict = waitForLoad(
    { maxLoad: 24, timeoutMs: 60000, pollMs: 30000 },
    readers,
  );
  assert.deepEqual(verdict, {
    load1m: null,
    maxLoad: 24,
    waitedMs: 60000,
    passed: false,
  });
  assert.deepEqual(sleeps, [30000, 30000]);
});

test('the default limit is the CPU count, read from the readers', () => {
  const below = fakeReaders([7.9], 8);
  assert.deepEqual(waitForLoad({ timeoutMs: 0, pollMs: 1 }, below.readers), {
    load1m: 7.9,
    maxLoad: 8,
    waitedMs: 0,
    passed: true,
  });
  const atLimit = fakeReaders([8], 8);
  assert.equal(
    waitForLoad({ timeoutMs: 0, pollMs: 1 }, atLimit.readers).maxLoad,
    8,
  );
  assert.equal(
    waitForLoad({ timeoutMs: 0, pollMs: 1 }, atLimit.readers).passed,
    false,
  );
});

test('the production readers take the CPU count from os.cpus', () => {
  assert.equal(LOAD_GATE_DEFAULT_READERS.coreCount(), os.cpus().length);
});

test('parseLoadGateArgs applies the documented defaults', () => {
  assert.deepEqual(parseLoadGateArgs([]), {
    maxLoad: undefined,
    timeoutMs: 600000,
    pollMs: 30000,
    help: false,
  });
});

test('parseLoadGateArgs accepts a decimal --max-load and canonical integers', () => {
  const parsed = parseLoadGateArgs([
    '--max-load',
    '1.5',
    '--timeout-ms',
    '0',
    '--poll-ms',
    '5',
  ]);
  assert.equal(parsed.maxLoad, 1.5);
  assert.equal(parsed.timeoutMs, 0);
  assert.equal(parsed.pollMs, 5);
});

test('parseLoadGateArgs rejects a malformed or non-positive --max-load as usage', () => {
  for (const token of ['0', '0.0', '-1', 'abc', '.5', '1.', '1e3']) {
    assert.throws(
      () => parseLoadGateArgs(['--max-load', token]),
      (error: unknown) => isUsageError(error),
      `--max-load ${token}`,
    );
  }
});

test('parseLoadGateArgs rejects a non-canonical --timeout-ms or --poll-ms as usage', () => {
  for (const args of [
    ['--timeout-ms', '1.5'],
    ['--timeout-ms', '-1'],
    ['--poll-ms', '0'],
    ['--poll-ms', 'soon'],
  ]) {
    assert.throws(
      () => parseLoadGateArgs(args),
      (error: unknown) => isUsageError(error),
      args.join(' '),
    );
  }
});

test('parseLoadGateArgs rejects an unknown flag and a positional as usage', () => {
  assert.throws(
    () => parseLoadGateArgs(['--bogus']),
    (error: unknown) => isUsageError(error),
  );
  assert.throws(
    () => parseLoadGateArgs(['stray']),
    (error: unknown) => isUsageError(error),
  );
});

test('the bin exits 2 on an unknown option with the envelope unset', () => {
  const env = { ...process.env };
  delete env.IDD_HELPER_ERROR_ENVELOPE;
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'idd-load-gate.mjs'), '--bogus'],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /idd-load-gate: .*--bogus/u);
  assert.equal(result.stdout, '');
});

test('the bin prints usage and exits 0 for --help without reading load', () => {
  const env = { ...process.env };
  delete env.IDD_HELPER_ERROR_ENVELOPE;
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'idd-load-gate.mjs'), '--help'],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:/u);
  assert.match(result.stdout, /--max-load/u);
});
