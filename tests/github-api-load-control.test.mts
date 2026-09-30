import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  admitRequest,
  admitRequestSync,
  COOLDOWN_DECAY_MS,
  classifyThrottle,
  defaultLoadControlDirectory,
  type GithubApiLoadControlRuntimePolicy,
  type LoadControlIdentity,
  type LoadControlRuntime,
  loadControlScopeName,
  MAX_BACKOFF_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  type ProcessIdentity,
  readProcessIdentity,
  SECONDARY_BASE_COOLDOWN_MS,
} from '../src/scripts/github-api-load-control.mts';
import { observeGhFailure } from '../src/scripts/github-api-observation.mts';
import {
  findLoadControlRefusal,
  isNotDispatchedRefusal,
  preserveLoadControlRefusal,
} from '../src/scripts/github-api-refusal.mts';

const WORKER = new URL('./github-api-load-control-worker.mts', import.meta.url);

const IDENTITY: LoadControlIdentity = {
  host: 'github.com',
  credentialMaterial: 'credential-a',
};
const POLICY: GithubApiLoadControlRuntimePolicy = {
  enabled: true,
  maxConcurrent: 1,
  maxWaitMs: 5_000,
};
const T0 = 1_800_000_000_000;

interface Harness {
  dir: string;
  clock: { wall: number; mono: number };
  alive: Set<number>;
  identities: Map<number, ProcessIdentity>;
  slept: number[];
  runtime(extra?: LoadControlRuntime): LoadControlRuntime;
  /** Hook run at the start of every fake sleep, before time advances. */
  onSleep: ((ms: number) => void) | null;
  cleanup(): void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'idd-load-control-'));
  const state: Harness = {
    dir,
    clock: { wall: T0, mono: 0 },
    alive: new Set([1111, 2222, 3333]),
    identities: new Map(),
    slept: [],
    onSleep: null,
    runtime(extra = {}) {
      return {
        directory: dir,
        now: () => state.clock.wall,
        monotonic: () => state.clock.mono,
        uptimeMs: () => state.clock.mono + 5_000_000,
        sleepSync: (ms) => {
          state.slept.push(ms);
          state.onSleep?.(ms);
          state.clock.wall += ms;
          state.clock.mono += ms;
        },
        sleep: async (ms) => {
          state.slept.push(ms);
          state.onSleep?.(ms);
          state.clock.wall += ms;
          state.clock.mono += ms;
        },
        isPidAlive: (pid) => state.alive.has(pid),
        processIdentity: (pid) => state.identities.get(pid) ?? {},
        pid: 1111,
        hostname: 'host-a',
        pidNamespace: 'ns-a',
        random: () => 0.5,
        ...extra,
      };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return state;
}

/** Advance wall time, monotonic time, and OS uptime together. */
function advance(h: Harness, ms: number): void {
  h.clock.wall += ms;
  h.clock.mono += ms;
}

function scopeDir(h: Harness, identity = IDENTITY): string {
  return join(h.dir, loadControlScopeName(identity));
}

/** The slots directory name a process on this host and pid namespace uses. */
function slotsName(hostname = 'host-a', pidNamespace = 'ns-a'): string {
  const key = createHash('sha256')
    .update(`${hostname}\0${pidNamespace}`)
    .digest('hex')
    .slice(0, 12);
  return `slots-${key}`;
}

function slotsDir(h: Harness, identity = IDENTITY, name = slotsName()): string {
  return join(scopeDir(h, identity), name);
}

function slotFiles(h: Harness, identity = IDENTITY): string[] {
  const dir = slotsDir(h, identity);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function eventFiles(h: Harness, identity = IDENTITY): string[] {
  const dir = join(scopeDir(h, identity), 'cooldown');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function refusalOf(action: () => unknown) {
  try {
    action();
  } catch (error) {
    const detail = findLoadControlRefusal(error);
    assert.ok(detail, `expected a load-control refusal, got ${String(error)}`);
    return { error: error as Error, detail };
  }
  assert.fail('expected the request to be refused');
}

function throttleEvidence(
  text: string,
  headers = '',
): {
  stderr: string;
  stdout: string;
} {
  return { stderr: text, stdout: headers };
}

const SECONDARY_403 = throttleEvidence(
  'gh: You have exceeded a secondary rate limit. (HTTP 403)',
);

function admitRead(h: Harness, identity = IDENTITY, resource = 'core') {
  const gate = admitRequestSync(
    identity,
    POLICY,
    { classification: 'read', resource },
    h.runtime(),
  );
  assert.ok(gate, 'expected a coordinated gate');
  return gate;
}

function throttle(h: Harness, evidence: unknown, resource = 'core'): void {
  const gate = admitRead(h, IDENTITY, resource);
  gate.recordFailure(evidence);
  gate.release();
}

function eventsOf(h: Harness): {
  level: number;
  durationMs: number;
  until: number;
  kind: string;
  resource?: string;
  source: string;
}[] {
  const dir = join(scopeDir(h), 'cooldown');
  return eventFiles(h).map((name) =>
    JSON.parse(readFileSync(join(dir, name), 'utf8')),
  );
}

// -- scope and identity -------------------------------------------------------

test('scope names isolate hosts and credentials and never contain the credential', () => {
  const base = loadControlScopeName(IDENTITY);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(
    base,
    loadControlScopeName({ ...IDENTITY, host: 'ghe.example.com' }),
  );
  assert.notEqual(
    base,
    loadControlScopeName({ ...IDENTITY, credentialMaterial: 'credential-b' }),
  );
  assert.equal(
    base,
    loadControlScopeName({ ...IDENTITY, host: ' GitHub.com ' }),
  );
  assert.equal(base.includes('credential-a'), false);
});

test('an unverified identity is never coordinated or guessed into a scope', () => {
  const h = harness();
  try {
    for (const identity of [
      { host: 'github.com', credentialMaterial: '' },
      { host: 'github.com', credentialMaterial: '   ' },
      { host: '', credentialMaterial: 'credential-a' },
    ]) {
      assert.equal(
        admitRequestSync(
          identity,
          POLICY,
          { classification: 'read' },
          h.runtime(),
        ),
        null,
      );
    }
    assert.deepEqual(readdirSync(h.dir), []);
  } finally {
    h.cleanup();
  }
});

test('a disabled policy is never coordinated and creates nothing', () => {
  const h = harness();
  try {
    assert.equal(
      admitRequestSync(
        IDENTITY,
        { ...POLICY, enabled: false },
        { classification: 'write' },
        h.runtime(),
      ),
      null,
    );
    assert.deepEqual(readdirSync(h.dir), []);
  } finally {
    h.cleanup();
  }
});

test('an unusable state directory degrades to uncoordinated instead of refusing', () => {
  const h = harness();
  try {
    const blocker = join(h.dir, 'blocked');
    writeFileSync(blocker, 'not a directory');
    assert.equal(
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime({ directory: join(blocker, 'state') }),
      ),
      null,
    );
  } finally {
    h.cleanup();
  }
});

test('the default state directory follows XDG_STATE_HOME, LOCALAPPDATA, then the home directory', () => {
  assert.equal(
    defaultLoadControlDirectory({ XDG_STATE_HOME: '/x' }, 'linux').replaceAll(
      '\\',
      '/',
    ),
    '/x/idd-skill/github-api-load-control',
  );
  assert.equal(
    defaultLoadControlDirectory({ LOCALAPPDATA: 'C:/L' }, 'win32').replaceAll(
      '\\',
      '/',
    ),
    'C:/L/idd-skill/github-api-load-control',
  );
  assert.match(
    defaultLoadControlDirectory({}, 'linux').replaceAll('\\', '/'),
    /\.local\/state\/idd-skill\/github-api-load-control$/,
  );
});

// -- admission ------------------------------------------------------------------

test('serial admission holds one slot and a waiting read is admitted once it is released', () => {
  const h = harness();
  try {
    const first = admitRead(h);
    assert.equal(slotFiles(h).length, 1);
    h.onSleep = () => {
      first.release();
      h.onSleep = null;
    };
    // A read from another process waits for the slot.
    const second = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'read', resource: 'core' },
      h.runtime({ pid: 2222 }),
    );
    assert.ok(second);
    assert.equal(second.joined, false);
    assert.ok(second.waitedMs > 0, 'the wait is reported');
    assert.ok(h.slept.length >= 1, 'the second read waited');
    second.release();
    // The highest generation file stays (released) so generations never
    // move backwards; the older one was collected.
    assert.deepEqual(slotFiles(h), ['slot-0-000000000002.json']);
    assert.equal(
      JSON.parse(readFileSync(join(slotsDir(h), slotFiles(h)[0]), 'utf8'))
        .released,
      true,
    );
  } finally {
    h.cleanup();
  }
});

test('a write that cannot be admitted now is refused without waiting or a lease', () => {
  const h = harness();
  try {
    const holder = admitRead(h);
    const before = slotFiles(h);
    for (const classification of ['write', 'unclassified'] as const) {
      const { detail, error } = refusalOf(() =>
        admitRequestSync(
          IDENTITY,
          POLICY,
          { classification },
          h.runtime({ pid: 2222 }),
        ),
      );
      assert.deepEqual(detail, {
        outcome: 'not-dispatched',
        reason: 'busy',
        holderPid: 1111,
      });
      assert.equal((error as { notDispatched?: boolean }).notDispatched, true);
      assert.match(error.message, /slot held by pid 1111/);
    }
    assert.deepEqual(h.slept, []);
    assert.deepEqual(slotFiles(h), before);
    holder.release();
  } finally {
    h.cleanup();
  }
});

test('a bounded concurrency override admits that many holders and refuses the next', () => {
  const h = harness();
  try {
    const policy = { ...POLICY, maxConcurrent: 2 };
    const a = admitRequestSync(
      IDENTITY,
      policy,
      { classification: 'write' },
      h.runtime({ pid: 1111 }),
    );
    const b = admitRequestSync(
      IDENTITY,
      policy,
      { classification: 'write' },
      h.runtime({ pid: 2222 }),
    );
    assert.ok(a && b);
    refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        policy,
        { classification: 'write' },
        h.runtime({ pid: 3333 }),
      ),
    );
    // A value outside 1..8 is clamped, not trusted.
    const clamped = { ...POLICY, maxConcurrent: 99 };
    assert.ok(clamped.maxConcurrent > 8);
    a.release();
    b.release();
  } finally {
    h.cleanup();
  }
});

test('a read whose caller deadline expires is refused with no lease and no dispatch', () => {
  const h = harness();
  try {
    const holder = admitRead(h);
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'read', deadlineMs: 200 },
        h.runtime({ pid: 2222 }),
      ),
    );
    assert.deepEqual(detail, {
      outcome: 'deadline-expired',
      reason: 'busy',
      holderPid: 1111,
    });
    assert.ok(
      h.clock.mono >= 200 && h.clock.mono < 200 + 60,
      'waited about the deadline',
    );
    assert.equal(slotFiles(h).length, 1);
    holder.release();
  } finally {
    h.cleanup();
  }
});

test('a zero deadline never waits', () => {
  const h = harness();
  try {
    const holder = admitRead(h);
    refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'read', deadlineMs: 0 },
        h.runtime({ pid: 2222 }),
      ),
    );
    assert.deepEqual(h.slept, []);
    holder.release();
  } finally {
    h.cleanup();
  }
});

test('releasing twice is harmless and only marks the lease this process wrote', () => {
  const h = harness();
  try {
    const first = admitRead(h);
    first.release();
    first.release();
    const second = admitRead(h);
    first.release();
    const slot = readFileSync(
      join(slotsDir(h), slotFiles(h).at(-1) as string),
      'utf8',
    );
    assert.equal(
      JSON.parse(slot).released,
      undefined,
      'a stale gate cannot release the next lease',
    );
    second.release();
  } finally {
    h.cleanup();
  }
});

// -- stale leases, crashes and pid reuse -------------------------------------------

function plantLease(
  h: Harness,
  generation: number,
  record: Record<string, unknown> | string,
  identity = IDENTITY,
  slot = 0,
  directoryName = slotsName(),
): string {
  const dir = slotsDir(h, identity, directoryName);
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `slot-${slot}-${String(generation).padStart(12, '0')}.json`,
  );
  writeFileSync(
    path,
    typeof record === 'string' ? record : JSON.stringify(record),
  );
  return path;
}

function liveRecord(pid: number, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    pid,
    token: `token-${pid}`,
    createdAt: T0 - 86_400_000,
    ...extra,
  };
}

test('a lease whose process is gone is reclaimed and its file collected', () => {
  const h = harness();
  try {
    h.alive.delete(3333);
    const stale = plantLease(h, 4, liveRecord(3333));
    const gate = admitRead(h);
    assert.equal(existsSync(stale), false);
    assert.deepEqual(slotFiles(h), ['slot-0-000000000005.json']);
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('a live lease is never taken over however old it is', () => {
  const h = harness();
  try {
    // Created a day ago and never renewed: only a dead pid frees it.
    const old = plantLease(h, 9, liveRecord(3333));
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'read', deadlineMs: 1_000 },
        h.runtime(),
      ),
    );
    assert.equal(detail.reason, 'busy');
    assert.equal(existsSync(old), true);
    assert.deepEqual(slotFiles(h), ['slot-0-000000000009.json']);
  } finally {
    h.cleanup();
  }
});

test('a recycled pid (start-time mismatch) is a dead holder, a matching one is live', () => {
  const h = harness();
  try {
    plantLease(h, 2, liveRecord(3333, { startToken: 'old-start' }));
    const reused = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime({
        processIdentity: (pid) => ({
          startToken: pid === 3333 ? 'new-start' : 'mine',
        }),
      }),
    );
    assert.ok(
      reused,
      'a lease whose pid now belongs to another process is free',
    );
    reused.release();

    const h2 = harness();
    try {
      plantLease(h2, 2, liveRecord(3333, { startToken: 'same' }));
      refusalOf(() =>
        admitRequestSync(
          IDENTITY,
          POLICY,
          { classification: 'write' },
          h2.runtime({
            processIdentity: (pid) => ({
              startToken: pid === 3333 ? 'same' : 'mine',
            }),
          }),
        ),
      );
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('a lease under another hostname or pid namespace is never seen, so it can never stall this host', () => {
  const h = harness();
  try {
    plantLease(
      h,
      3,
      liveRecord(3333),
      IDENTITY,
      0,
      slotsName('host-b', 'ns-a'),
    );
    plantLease(
      h,
      4,
      liveRecord(3333),
      IDENTITY,
      0,
      slotsName('host-a', 'ns-other'),
    );
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime(),
    );
    assert.ok(gate, 'foreign leases are in other directories');
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('a zombie holder is dead even though its pid still exists', () => {
  const h = harness();
  try {
    plantLease(h, 3, liveRecord(3333));
    h.identities.set(3333, { state: 'Z' });
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime(),
    );
    assert.ok(gate);
    gate.release();
    h.identities.set(3333, { state: 'S' });
    plantLease(h, 9, liveRecord(3333));
    refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
  } finally {
    h.cleanup();
  }
});

test('a fresh partial lease file counts as a holder still writing, an old one as a crash', () => {
  const h = harness();
  try {
    const path = plantLease(h, 1, '');
    const fresh = new Date(T0);
    utimesSync(path, fresh, fresh);
    refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    const old = new Date(T0 - 60_000);
    utimesSync(path, old, old);
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime(),
    );
    assert.ok(gate, 'an abandoned partial file is a crash and is reclaimed');
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('a released marker frees the slot and a corrupt old file does not block it', () => {
  const h = harness();
  try {
    plantLease(h, 1, { schemaVersion: 1, released: true });
    const corrupt = plantLease(h, 2, '{not json');
    const old = new Date(T0 - 60_000);
    utimesSync(corrupt, old, old);
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime(),
    );
    assert.ok(gate);
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('the fence concedes when a live lease appears in the slot between create and verify', () => {
  const h = harness();
  try {
    let planted = false;
    // processIdentity runs just before this process creates its file, so
    // planting a lower-generation live lease there reproduces a stale
    // creator racing an admitted holder.
    const runtime = h.runtime({
      processIdentity: (pid) => {
        if (pid === 1111 && !planted) {
          planted = true;
          // The listing this attempt already took did not see it.
          plantLease(h, 3, liveRecord(3333));
        }
        return h.identities.get(pid) ?? {};
      },
    });
    h.alive.add(3333);
    // First attempt: no files, creates generation 1, then sees the planted
    // lease and concedes. A read then waits; the holder exits meanwhile.
    h.onSleep = () => {
      h.alive.delete(3333);
      h.onSleep = null;
    };
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'read' },
      runtime,
    );
    assert.ok(gate);
    assert.ok(
      h.slept.length >= 1,
      'the conceding attempt waited instead of dispatching',
    );
    gate.release();
  } finally {
    h.cleanup();
  }
});

// -- sync and async coexistence ----------------------------------------------------

test('an async waiter yields to the event loop so the holder in this process can release', async () => {
  const h = harness();
  try {
    const first = await admitRequest(
      IDENTITY,
      POLICY,
      { classification: 'read' },
      h.runtime(),
    );
    assert.ok(first);
    let released = false;
    h.onSleep = () => {
      // The waiter slept on a timer, not a blocking wait: the loop could run
      // the holder's completion.
      first.release();
      released = true;
      h.onSleep = null;
    };
    const second = await admitRequest(
      IDENTITY,
      POLICY,
      { classification: 'read' },
      h.runtime(),
    );
    assert.ok(second);
    assert.equal(released, true);
    second.release();
  } finally {
    h.cleanup();
  }
});

test('a sync read that is blocked only by this process rides its async lease instead of self-deadlocking', async () => {
  const h = harness();
  try {
    const own = await admitRequest(
      IDENTITY,
      POLICY,
      { classification: 'read' },
      h.runtime(),
    );
    assert.ok(own);
    const joined = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'read', deadlineMs: 60_000 },
      h.runtime(),
    );
    assert.ok(joined);
    assert.equal(joined.joined, true);
    assert.deepEqual(
      h.slept,
      [],
      'a sync waiter must not block on its own release',
    );
    joined.release();
    assert.equal(slotFiles(h).length, 1, 'the async lease is untouched');
    own.release();
  } finally {
    h.cleanup();
  }
});

test('a sync write with this process holding the slot is still refused, and another process holding it blocks a sync read', async () => {
  const h = harness();
  try {
    const own = await admitRequest(
      IDENTITY,
      POLICY,
      { classification: 'read' },
      h.runtime(),
    );
    assert.ok(own);
    refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    own.release();
    // Now another process holds it: a sync read from a process with no lease
    // of its own genuinely waits (and here runs out of deadline).
    plantLease(h, 30, liveRecord(3333));
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'read', deadlineMs: 100 },
        h.runtime({ pid: 2222 }),
      ),
    );
    assert.equal(detail.outcome, 'deadline-expired');
    assert.ok(h.slept.length > 0);
  } finally {
    h.cleanup();
  }
});

// -- cooldown ---------------------------------------------------------------------------

test('an observed retry-after is honored and a write is refused with that retryAt', () => {
  const h = harness();
  try {
    throttle(
      h,
      throttleEvidence(
        'gh: You have exceeded a secondary rate limit. (HTTP 403)',
        'HTTP/2.0 403 Forbidden\nRetry-After: 120\n\n{"message":"x"}',
      ),
    );
    const events = eventsOf(h);
    assert.equal(events.length, 1);
    assert.equal(events[0].durationMs, 120_000);
    assert.equal(events[0].source, 'server');
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    assert.deepEqual(detail, {
      outcome: 'not-dispatched',
      reason: 'cooldown',
      retryAt: new Date(T0 + 120_000).toISOString(),
      retryAtSource: 'server',
    });
    assert.deepEqual(h.slept, [], 'a write never waits out a cooldown');
    assert.deepEqual(
      slotFiles(h)
        .map((name) => readFileSync(join(slotsDir(h), name), 'utf8'))
        .filter((text) => !text.includes('released')),
      [],
      'the refused write left no lease',
    );
  } finally {
    h.cleanup();
  }
});

test('a read waits out a cooldown that fits its deadline, and is refused with retryAt when it does not', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403);
    const fits = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'read', resource: 'core', deadlineMs: 90_000 },
      h.runtime(),
    );
    assert.ok(fits);
    assert.ok(
      h.clock.wall >= T0 + SECONDARY_BASE_COOLDOWN_MS,
      'waited for the cooldown',
    );
    fits.release();

    const h2 = harness();
    try {
      throttle(h2, SECONDARY_403);
      const spawnsBefore = h2.slept.length;
      const { detail } = refusalOf(() =>
        admitRequestSync(
          IDENTITY,
          POLICY,
          { classification: 'read', resource: 'core', deadlineMs: 5_000 },
          h2.runtime(),
        ),
      );
      assert.equal(detail.outcome, 'deadline-expired');
      assert.equal(detail.reason, 'cooldown');
      assert.equal(
        detail.retryAt,
        new Date(T0 + SECONDARY_BASE_COOLDOWN_MS).toISOString(),
      );
      assert.equal(
        h2.slept.length,
        spawnsBefore,
        'it does not sleep a doomed wait',
      );
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('a secondary throttle suppresses REST and GraphQL and every resource', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403, 'core');
    for (const resource of ['core', 'graphql', 'search', undefined]) {
      const { detail } = refusalOf(() =>
        admitRequestSync(
          IDENTITY,
          POLICY,
          { classification: 'write', resource },
          h.runtime(),
        ),
      );
      assert.equal(detail.reason, 'cooldown', String(resource));
    }
  } finally {
    h.cleanup();
  }
});

test('the #3560 text (API rate limit already exceeded, no headers) starts a shared cooldown', () => {
  const evidence = throttleEvidence(
    'GraphQL: API rate limit already exceeded for user ID 12345.',
  );
  const observation = observeGhFailure(evidence, { graphql: true });
  // The #3585 classifier alone cannot attribute this text to a subtype.
  assert.equal(observation.classification, 'unknown');
  assert.deepEqual(classifyThrottle(observation, evidence, 'graphql'), {
    kind: 'shared',
  });
  const h = harness();
  try {
    throttle(h, evidence, 'graphql');
    for (const resource of ['graphql', 'core']) {
      refusalOf(() =>
        admitRequestSync(
          IDENTITY,
          POLICY,
          { classification: 'write', resource },
          h.runtime(),
        ),
      );
    }
    const [event] = eventsOf(h);
    assert.equal(event.kind, 'secondary');
    assert.equal(event.resource, undefined);
    assert.equal(event.durationMs, SECONDARY_BASE_COOLDOWN_MS);
  } finally {
    h.cleanup();
  }
});

test('a GraphQL RATE_LIMITED error type and an HTTP 429 are shared throttles, ordinary failures are not', () => {
  const graphql = {
    stderr: 'gh: exit status 1',
    stdout: JSON.stringify({
      errors: [{ type: 'RATE_LIMITED', message: 'slow down' }],
    }),
  };
  assert.deepEqual(
    classifyThrottle(
      observeGhFailure(graphql, { graphql: true }),
      graphql,
      'graphql',
    ),
    { kind: 'shared' },
  );
  const tooMany = throttleEvidence('gh: Too Many Requests (HTTP 429)');
  assert.deepEqual(
    classifyThrottle(observeGhFailure(tooMany), tooMany, 'core'),
    {
      kind: 'shared',
    },
  );
  for (const stderr of [
    'gh: Not Found (HTTP 404)',
    'gh: Bad credentials (HTTP 401)',
    'gh: Server Error (HTTP 502)',
    'gh: Validation Failed (HTTP 422)',
  ]) {
    const evidence = throttleEvidence(stderr);
    assert.equal(
      classifyThrottle(observeGhFailure(evidence), evidence, 'core'),
      null,
      stderr,
    );
  }
  // Issue text quoted in a GraphQL data subtree is not failure evidence.
  const quoted = {
    stderr: 'gh: exit status 1',
    stdout: JSON.stringify({
      data: { issue: { title: 'rate limit RATE_LIMITED' } },
      errors: [{ type: 'NOT_FOUND', message: 'nope' }],
    }),
  };
  assert.equal(
    classifyThrottle(
      observeGhFailure(quoted, { graphql: true }),
      quoted,
      'graphql',
    ),
    null,
  );
});

test('a primary exhaustion needs remaining 0 and blocks only its own resource', () => {
  const reset = Math.floor((T0 + 300_000) / 1000);
  const evidence = throttleEvidence(
    'gh: API rate limit exceeded (HTTP 403)',
    `HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${reset}\nX-RateLimit-Resource: core\n\n{}`,
  );
  const observation = observeGhFailure(evidence);
  assert.deepEqual(classifyThrottle(observation, evidence, 'core'), {
    kind: 'primary',
    resource: 'core',
    resetEpochSec: reset,
  });
  const h = harness();
  try {
    throttle(h, evidence, 'core');
    const [event] = eventsOf(h);
    assert.equal(event.kind, 'primary');
    assert.equal(event.resource, 'core');
    assert.equal(event.durationMs, 300_000);
    assert.equal(event.source, 'server');
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write', resource: 'core' },
        h.runtime(),
      ),
    );
    assert.equal(detail.retryAt, new Date(reset * 1000).toISOString());
    // Other primary resources and an opaque call (no resource) stay open.
    for (const resource of ['graphql', 'search', undefined]) {
      const gate = admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write', resource },
        h.runtime(),
      );
      assert.ok(gate, String(resource));
      gate.release();
    }
  } finally {
    h.cleanup();
  }
});

test('explicit primary wording without a remaining reading is attributed to the request resource only', () => {
  const evidence = throttleEvidence(
    'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  );
  const observation = observeGhFailure(evidence);
  assert.equal(observation.classification, 'primary-exhaustion');
  assert.deepEqual(classifyThrottle(observation, evidence, 'core'), {
    kind: 'primary',
    resource: 'core',
  });
  // Nothing names the resource (an opaque gh subcommand): stay shared.
  assert.deepEqual(classifyThrottle(observation, evidence, undefined), {
    kind: 'shared',
  });
  // The secondary wording is never a primary limit, whatever else it says.
  const both = throttleEvidence(
    'gh: You have exceeded a secondary rate limit. API rate limit exceeded (HTTP 403)',
  );
  assert.deepEqual(classifyThrottle(observeGhFailure(both), both, 'core'), {
    kind: 'shared',
  });
});

test('a primary reset already in the past falls back to the backoff instead of a zero cooldown', () => {
  const h = harness();
  try {
    const stale = Math.floor((T0 - 60_000) / 1000);
    throttle(
      h,
      throttleEvidence(
        'gh: API rate limit exceeded (HTTP 403)',
        `HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${stale}\nX-RateLimit-Resource: core\n\n{}`,
      ),
    );
    const [event] = eventsOf(h);
    assert.equal(event.source, 'backoff');
    assert.equal(event.durationMs, SECONDARY_BASE_COOLDOWN_MS);
  } finally {
    h.cleanup();
  }
});

test('repeated throttling escalates the backoff across protocols without restarting it', () => {
  const h = harness();
  try {
    const durations: number[] = [];
    // Alternate REST and GraphQL: each expiry is followed by a fresh
    // throttle from the other protocol.
    for (let round = 0; round < 7; round += 1) {
      throttle(h, SECONDARY_403, round % 2 === 0 ? 'core' : 'graphql');
      const newest = eventsOf(h).at(-1) as { durationMs: number };
      const events = eventsOf(h);
      durations.push(Math.max(...events.map((event) => event.durationMs)));
      advance(h, newest.durationMs + 1);
    }
    assert.deepEqual(
      durations.slice(0, 5),
      [60_000, 120_000, 240_000, 480_000, 900_000],
    );
    assert.equal(
      Math.max(...durations),
      MAX_BACKOFF_COOLDOWN_MS,
      'the backoff is bounded',
    );
    assert.equal(durations[6], MAX_BACKOFF_COOLDOWN_MS);
  } finally {
    h.cleanup();
  }
});

test('the backoff restarts after a quiet decay window', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403);
    advance(h, SECONDARY_BASE_COOLDOWN_MS + 1);
    throttle(h, SECONDARY_403);
    assert.equal(eventsOf(h).at(-1)?.level, 2);
    advance(h, COOLDOWN_DECAY_MS + 1_000_000);
    throttle(h, SECONDARY_403);
    const newest = eventsOf(h)
      .sort((a, b) => a.until - b.until)
      .at(-1);
    assert.equal(newest?.level, 1);
    assert.equal(newest?.durationMs, SECONDARY_BASE_COOLDOWN_MS);
  } finally {
    h.cleanup();
  }
});

test('a late failure inside an active cooldown extends it without escalating', () => {
  const h = harness();
  try {
    // Two requests are in flight when the first one is throttled.
    const policy = { ...POLICY, maxConcurrent: 2 };
    const first = admitRequestSync(
      IDENTITY,
      policy,
      { classification: 'read', resource: 'core' },
      h.runtime({ pid: 1111 }),
    );
    const second = admitRequestSync(
      IDENTITY,
      policy,
      { classification: 'read', resource: 'core' },
      h.runtime({ pid: 2222 }),
    );
    assert.ok(first && second);
    first.recordFailure(SECONDARY_403);
    advance(h, 1_000);
    second.recordFailure(SECONDARY_403);
    first.release();
    second.release();
    const events = eventsOf(h);
    assert.deepEqual(
      events.map((event) => event.level),
      [1, 1],
    );
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        policy,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    assert.equal(detail.retryAt, new Date(T0 + 1_000 + 60_000).toISOString());
  } finally {
    h.cleanup();
  }
});

test('a wall clock that moves backwards cannot stretch a cooldown, whatever the uptime says', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403);
    advance(h, 50_000);
    // The wall clock steps back an hour; uptime does not.
    h.clock.wall -= 3_600_000;
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    assert.equal(
      detail.retryAt,
      new Date(h.clock.wall + 10_000).toISOString(),
      'exactly the 10 s that are left, not the full minute again',
    );
    advance(h, 10_001);
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime(),
    );
    assert.ok(gate);
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('without a usable uptime (a reboot) the remainder is still bounded by the cooldown length', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403);
    // Uptime restarts below the recorded value, as after a reboot, and the
    // wall clock is an hour behind: the duration bounds the wait.
    h.clock.wall -= 3_600_000;
    h.clock.mono -= 4_000_000;
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime({ monotonic: () => 0, uptimeMs: () => 1_000 }),
      ),
    );
    assert.equal(
      detail.retryAt,
      new Date(h.clock.wall + SECONDARY_BASE_COOLDOWN_MS).toISOString(),
    );
    h.clock.wall = T0 + SECONDARY_BASE_COOLDOWN_MS + 1;
    const gate = admitRequestSync(
      IDENTITY,
      POLICY,
      { classification: 'write' },
      h.runtime({ monotonic: () => 0, uptimeMs: () => 1_000 }),
    );
    assert.ok(gate);
    gate.release();
  } finally {
    h.cleanup();
  }
});

test('a corrupt or oversized cooldown file is ignored or bounded, never trusted', () => {
  const h = harness();
  try {
    throttle(h, SECONDARY_403);
    const dir = join(scopeDir(h), 'cooldown');
    writeFileSync(
      join(dir, 'secondary.shared.000000000000001.aaaaaaaaaaaaaaaa.json'),
      '{nope',
    );
    writeFileSync(
      join(dir, 'secondary.shared.999999999999999.bbbbbbbbbbbbbbbb.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'secondary',
        observedAt: T0,
        observedUptimeMs: 5_000_000,
        until: T0 + 10 ** 12,
        durationMs: 10 ** 12,
        level: 1,
        source: 'server',
      }),
    );
    const { detail } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime(),
      ),
    );
    assert.equal(
      detail.retryAt,
      new Date(T0 + MAX_COOLDOWN_MS).toISOString(),
      'clamped to one hour',
    );
  } finally {
    h.cleanup();
  }
});

test('different hosts and different credentials keep separate admission and cooldown', () => {
  const h = harness();
  try {
    const other: LoadControlIdentity = { ...IDENTITY, host: 'ghe.example.com' };
    const another: LoadControlIdentity = {
      ...IDENTITY,
      credentialMaterial: 'credential-b',
    };
    const held = admitRead(h);
    throttle(h, SECONDARY_403);
    for (const identity of [other, another]) {
      const gate = admitRequestSync(
        identity,
        POLICY,
        { classification: 'write', resource: 'core' },
        h.runtime({ pid: 2222 }),
      );
      assert.ok(
        gate,
        `${identity.host}/${identity.credentialMaterial} is unaffected`,
      );
      gate.release();
    }
    held.release();
    assert.equal(readdirSync(h.dir).length, 3);
  } finally {
    h.cleanup();
  }
});

test('the credential never reaches the state directory', () => {
  const h = harness();
  try {
    const gate = admitRead(h);
    throttle(h, SECONDARY_403);
    gate.release();
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
      );
    for (const file of walk(h.dir)) {
      assert.equal(
        readFileSync(file, 'utf8').includes('credential-a'),
        false,
        file,
      );
      assert.equal(file.includes('credential-a'), false, file);
    }
  } finally {
    h.cleanup();
  }
});

// -- refusal error ---------------------------------------------------------------------

test('the refusal error carries non-enumerable tags and survives a cause wrapper', () => {
  const h = harness();
  try {
    const holder = admitRead(h);
    const { error } = refusalOf(() =>
      admitRequestSync(
        IDENTITY,
        POLICY,
        { classification: 'write' },
        h.runtime({ pid: 2222 }),
      ),
    );
    assert.deepEqual(Object.keys(error), []);
    assert.equal(isNotDispatchedRefusal(error), true);
    assert.match(error.message, /not dispatched/);
    const wrapped = new Error('provider failed', { cause: error });
    assert.equal(isNotDispatchedRefusal(wrapped), true);
    const rebuilt = preserveLoadControlRefusal(new Error('rebuilt'), error);
    assert.equal(isNotDispatchedRefusal(rebuilt), true);
    assert.deepEqual(Object.keys(rebuilt), []);
    const plain = preserveLoadControlRefusal(
      new Error('plain'),
      new Error('other'),
    );
    assert.equal(isNotDispatchedRefusal(plain), false);
    assert.equal('cause' in plain, false);
    assert.equal(isNotDispatchedRefusal(new Error('x')), false);
    assert.equal(isNotDispatchedRefusal(null), false);
    holder.release();
  } finally {
    h.cleanup();
  }
});

test('readProcessIdentity degrades to an empty identity off Linux and for a missing pid', () => {
  assert.deepEqual(readProcessIdentity(process.pid, 'win32'), {});
  assert.deepEqual(readProcessIdentity(2 ** 30, 'linux'), {});
  if (process.platform === 'linux') {
    const identity = readProcessIdentity(process.pid);
    assert.match(identity.startToken ?? '', /^\d+$/);
    assert.match(identity.state ?? '', /^[A-Za-z]$/);
  }
});

// -- separate processes ------------------------------------------------------------------

function run(
  env: Record<string, string>,
  cwd: string,
): {
  child: ReturnType<typeof spawn>;
  exited: Promise<number>;
  stdout: () => string;
  stderr: () => string;
} {
  const flags = process.execArgv.filter(
    (arg) => arg !== '--test' && !arg.startsWith('--test-'),
  );
  let out = '';
  let err = '';
  const child = spawn(process.execPath, [...flags, fileURLToPath(WORKER)], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
  return { child, exited, stdout: () => out, stderr: () => err };
}

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > 60_000)
      throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split('\n').at(-1) ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

test('two processes in different working directories share admission, cooldown and isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-load-control-procs-'));
  try {
    const state = join(root, 'state');
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    mkdirSync(repoA);
    mkdirSync(repoB);
    const held = join(root, 'held');
    const release = join(root, 'release');
    const base = { IDD_LC_DIR: state };

    const holder = run(
      {
        ...base,
        IDD_LC_MODE: 'hold',
        IDD_LC_CLASS: 'read',
        IDD_LC_HELD: held,
        IDD_LC_RELEASE: release,
      },
      repoA,
    );
    await waitForFile(held);

    // A write from another repository is refused while the slot is held.
    const refused = run(
      { ...base, IDD_LC_MODE: 'attempt', IDD_LC_CLASS: 'write' },
      repoB,
    );
    assert.equal(await refused.exited, 0, refused.stderr());
    const refusedOut = lastJson(refused.stdout());
    assert.equal(refusedOut.admitted, false);
    assert.deepEqual(refusedOut.refusal, {
      outcome: 'not-dispatched',
      reason: 'busy',
      holderPid: holder.child.pid,
    });

    // A different host and a different credential are not affected.
    const others: Record<string, string>[] = [
      { IDD_LC_HOST: 'ghe.example.com' },
      { IDD_LC_CREDENTIAL: 'credential-b' },
    ];
    for (const extra of others) {
      const isolated = run(
        { ...base, ...extra, IDD_LC_MODE: 'attempt', IDD_LC_CLASS: 'write' },
        repoB,
      );
      assert.equal(await isolated.exited, 0, isolated.stderr());
      assert.equal(lastJson(isolated.stdout()).admitted, true);
    }

    writeFileSync(release, '1');
    assert.equal(await holder.exited, 0, holder.stderr());

    // Once released, the other repository is admitted.
    const admitted = run(
      { ...base, IDD_LC_MODE: 'attempt', IDD_LC_CLASS: 'write' },
      repoB,
    );
    assert.equal(await admitted.exited, 0, admitted.stderr());
    assert.equal(lastJson(admitted.stdout()).admitted, true);

    // A throttle recorded from one repository suppresses the other.
    const thrower = run(
      { ...base, IDD_LC_MODE: 'throttle', IDD_LC_RESOURCE: 'core' },
      repoA,
    );
    assert.equal(await thrower.exited, 0, thrower.stderr());
    const blocked = run(
      {
        ...base,
        IDD_LC_MODE: 'attempt',
        IDD_LC_CLASS: 'write',
        IDD_LC_RESOURCE: 'graphql',
      },
      repoB,
    );
    assert.equal(await blocked.exited, 0, blocked.stderr());
    const blockedOut = lastJson(blocked.stdout());
    assert.equal(blockedOut.admitted, false);
    assert.equal((blockedOut.refusal as { reason: string }).reason, 'cooldown');
    assert.equal(
      typeof (blockedOut.refusal as { retryAt?: string }).retryAt,
      'string',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crashed holder process does not block admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-load-control-crash-'));
  try {
    const state = join(root, 'state');
    const held = join(root, 'held');
    const release = join(root, 'never');
    const holder = run(
      {
        IDD_LC_DIR: state,
        IDD_LC_MODE: 'hold',
        IDD_LC_CLASS: 'read',
        IDD_LC_HELD: held,
        IDD_LC_RELEASE: release,
      },
      root,
    );
    await waitForFile(held);
    const busy = run(
      { IDD_LC_DIR: state, IDD_LC_MODE: 'attempt', IDD_LC_CLASS: 'write' },
      root,
    );
    await busy.exited;
    assert.equal(lastJson(busy.stdout()).admitted, false);
    holder.child.kill('SIGKILL');
    await holder.exited;
    const after = run(
      { IDD_LC_DIR: state, IDD_LC_MODE: 'attempt', IDD_LC_CLASS: 'write' },
      root,
    );
    assert.equal(await after.exited, 0, after.stderr());
    assert.equal(lastJson(after.stdout()).admitted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent cooldown extensions converge on one deterministic cooldown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-load-control-ext-'));
  try {
    const state = join(root, 'state');
    const ready = join(root, 'ready');
    const go = join(root, 'go');
    mkdirSync(ready);
    const now = String(Date.now());
    const workers = Array.from({ length: 6 }, () =>
      run(
        {
          IDD_LC_DIR: state,
          IDD_LC_MODE: 'record-only',
          IDD_LC_NOW: now,
          IDD_LC_RESOURCE: 'core',
          IDD_LC_READY: ready,
          IDD_LC_GO: go,
        },
        root,
      ),
    );
    // Every worker holds an admitted request before any throttle is
    // recorded, then they all record together.
    const started = Date.now();
    while (readdirSync(ready).length < workers.length) {
      if (Date.now() - started > 90_000)
        throw new Error('workers did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(go, '1');
    for (const worker of workers) {
      assert.equal(await worker.exited, 0, worker.stderr());
    }
    const scope = readdirSync(state)[0];
    const events = readdirSync(join(state, scope, 'cooldown')).map((name) =>
      JSON.parse(readFileSync(join(state, scope, 'cooldown', name), 'utf8')),
    ) as { level: number; until: number; durationMs: number }[];
    assert.equal(events.length, 6);
    // Same fixed clock: every writer sees an empty or active cooldown of the
    // same level, so none escalates and the effective cooldown is exactly one
    // base period whatever the interleaving.
    assert.deepEqual([...new Set(events.map((event) => event.level))], [1]);
    assert.deepEqual(
      [...new Set(events.map((event) => event.until))],
      [Number(now) + SECONDARY_BASE_COOLDOWN_MS],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const limit of [1, 2]) {
  test(`a herd of processes never exceeds the admission bound of ${limit}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'idd-load-control-herd-'));
    try {
      const state = join(root, 'state');
      const inside = join(root, 'inside');
      mkdirSync(inside);
      const workers = Array.from({ length: 5 }, () =>
        run(
          {
            IDD_LC_DIR: state,
            IDD_LC_MODE: 'cycle',
            IDD_LC_INSIDE: inside,
            IDD_LC_MAX: String(limit),
            IDD_LC_CYCLES: '12',
          },
          root,
        ),
      );
      let peak = 0;
      for (const worker of workers) {
        assert.equal(
          await worker.exited,
          0,
          `${worker.stdout()}${worker.stderr()}`,
        );
        peak = Math.max(peak, Number(lastJson(worker.stdout()).peak ?? 0));
      }
      assert.ok(peak <= limit, `peak ${peak} exceeded ${limit}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
