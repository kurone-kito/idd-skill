import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  admitRequest,
  admitRequestSync,
  type GithubApiLoadControlRuntimePolicy,
} from '../src/scripts/github-api-load-control.mts';
import { findLoadControlRefusal } from '../src/scripts/github-api-refusal.mts';

// Subprocess fixture for github-api-load-control.test.mts. Each mode prints
// one JSON line so the parent can assert what a separate process saw.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const mode = required('IDD_LC_MODE');
const directory = required('IDD_LC_DIR');
const identity = {
  host: process.env.IDD_LC_HOST ?? 'github.com',
  credentialMaterial: process.env.IDD_LC_CREDENTIAL ?? 'credential-a',
};
const policy: GithubApiLoadControlRuntimePolicy = {
  enabled: true,
  maxConcurrent: Number(process.env.IDD_LC_MAX ?? '1'),
  maxWaitMs: Number(process.env.IDD_LC_WAIT_MS ?? '10000'),
};
const classification = (process.env.IDD_LC_CLASS ?? 'write') as
  | 'read'
  | 'write'
  | 'unclassified';
const resource = process.env.IDD_LC_RESOURCE || undefined;
const fixedNow = process.env.IDD_LC_NOW
  ? Number(process.env.IDD_LC_NOW)
  : undefined;

function waitFor(path: string, timeoutMs = 90_000): void {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function attemptSync(): { admitted: boolean; refusal?: unknown } {
  try {
    const gate = admitRequestSync(
      identity,
      policy,
      { classification, resource },
      { directory },
    );
    if (gate === null) return { admitted: false, refusal: 'uncoordinated' };
    return { admitted: true };
  } catch (error) {
    return {
      admitted: false,
      refusal: findLoadControlRefusal(error) ?? String(error),
    };
  }
}

if (mode === 'hold') {
  // Take the lease, announce it, hold it until the release file appears.
  const gate = admitRequestSync(
    identity,
    policy,
    { classification, resource },
    { directory },
  );
  if (gate === null) throw new Error('hold was not coordinated');
  writeFileSync(required('IDD_LC_HELD'), '1');
  waitFor(required('IDD_LC_RELEASE'));
  gate.release();
  print({ held: true });
} else if (mode === 'attempt') {
  print(attemptSync());
} else if (mode === 'throttle') {
  const gate = admitRequestSync(
    identity,
    policy,
    { classification: 'read', resource },
    { directory, ...(fixedNow ? { now: () => fixedNow } : {}) },
  );
  if (gate === null) throw new Error('throttle was not coordinated');
  gate.recordFailure({
    stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)',
    stdout: '',
  });
  gate.release();
  print({ recorded: true });
} else if (mode === 'record-only') {
  // Hold a lease, wait for every sibling to hold one too, then record one
  // throttle at a fixed clock: the requests are all in flight when it fires.
  const gate = admitRequestSync(
    identity,
    { ...policy, maxConcurrent: 8 },
    { classification: 'read', resource },
    { directory, now: () => fixedNow ?? Date.now() },
  );
  if (gate === null) throw new Error('record-only was not coordinated');
  writeFileSync(join(required('IDD_LC_READY'), String(process.pid)), '1');
  waitFor(required('IDD_LC_GO'));
  gate.recordFailure({
    stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)',
    stdout: '',
  });
  gate.release();
  print({ recorded: true });
} else if (mode === 'cycle') {
  // Repeatedly take the slot, prove exclusivity with marker files, release.
  const cycles = Number(process.env.IDD_LC_CYCLES ?? '10');
  const inside = required('IDD_LC_INSIDE');
  const limit = policy.maxConcurrent;
  let peak = 0;
  void (async () => {
    for (let index = 0; index < cycles; index += 1) {
      const gate = await admitRequest(
        identity,
        policy,
        { classification: 'read', resource, deadlineMs: 60_000 },
        { directory },
      );
      if (gate === null) throw new Error('cycle was not coordinated');
      const marker = join(inside, `${process.pid}-${index}`);
      writeFileSync(marker, '1');
      const concurrent = readdirSync(inside).length;
      peak = Math.max(peak, concurrent);
      if (concurrent > limit) {
        print({ violation: concurrent });
        process.exit(3);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      unlinkSync(marker);
      gate.release();
    }
    print({ peak });
  })();
} else {
  throw new Error(`unknown mode ${mode}`);
}
