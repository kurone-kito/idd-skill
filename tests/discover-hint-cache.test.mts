import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type DiscoverHintDeps,
  type DiscoverHintRequest,
  invalidateDiscoverHints,
  noteDiscoveryIncomplete,
  parseRemoteUrl,
  purgeDiscoverHints,
  readDiscoverHint,
} from '../src/scripts/discover-hint-cache.mts';
import { readThroughGithubApiCache } from '../src/scripts/github-api-read-cache.mts';

interface Report {
  leaves: number[];
}

interface Fixture {
  root: string;
  cacheDir: string;
  workspace: string;
  clock: { now: number };
  deps: DiscoverHintDeps;
}

function fixture(overrides: Partial<DiscoverHintDeps> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'idd-discover-hint-'));
  const cacheDir = join(root, 'cache');
  const workspace = join(root, 'workspace');
  mkdirSync(cacheDir);
  mkdirSync(workspace);
  const clock = { now: 1_800_000_000_000 };
  return {
    root,
    cacheDir,
    workspace,
    clock,
    deps: {
      env: {},
      cwd: workspace,
      policy: {
        enabled: true,
        maxAgeMs: 300_000,
        maxBytes: 104857600,
        retentionMs: 86_400_000,
        directory: cacheDir,
      },
      originUrl: () => 'https://github.com/o/r.git',
      credential: () => 'hint-credential-token',
      now: () => clock.now,
      ...overrides,
    },
  };
}

function request(
  fx: Fixture,
  compute: () => Promise<Report>,
  overrides: Partial<DiscoverHintRequest<Report>> = {},
): DiscoverHintRequest<Report> {
  return {
    helper: 'discover-roadmap-graph',
    args: { allRoadmaps: true },
    policy: { floor: 3 },
    compute,
    hasCandidate: (report) => report.leaves.length > 0,
    deps: fx.deps,
    ...overrides,
  };
}

function counter(reports: Report[]): {
  compute: () => Promise<Report>;
  calls: () => number;
} {
  let calls = 0;
  return {
    compute: async () => {
      const report = reports[Math.min(calls, reports.length - 1)] as Report;
      calls += 1;
      return structuredClone(report);
    },
    calls: () => calls,
  };
}

test('remote URLs parse locally across https, ssh, scp-like, and git forms', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/o/r.git'), {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
  });
  assert.deepEqual(parseRemoteUrl('git@ghe.example.com:acme/tool.git'), {
    host: 'ghe.example.com',
    owner: 'acme',
    repo: 'tool',
  });
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com:22/o/r'), {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
  });
  assert.equal(parseRemoteUrl('/local/path/repo'), null);
  assert.equal(parseRemoteUrl(''), null);
});

test('a warm repeat within max age performs zero enumerations', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [3588, 3598] }]);
  try {
    const cold = await readDiscoverHint(request(fx, compute));
    fx.clock.now += 60_000;
    const warm = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 1);
    assert.deepEqual(warm.report, cold.report);
    assert.equal(cold.cache?.source, 'live');
    assert.equal(cold.cache?.enumerations, 1);
    assert.equal(warm.cache?.mode, 'hint');
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(warm.cache?.ageMs, 60_000);
    assert.equal(warm.cache?.maxAgeMs, 300_000);
    assert.equal(warm.cache?.enumerations, 0);
    assert.equal(warm.cache?.complete, true);
    assert.equal(warm.cache?.exhaustionRefresh, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a hint older than max age is recomputed', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }, { leaves: [1, 2] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    fx.clock.now += 300_001;
    const stale = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 2);
    assert.equal(stale.cache?.source, 'live');
    assert.deepEqual(stale.report.leaves, [1, 2]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the identity resolves without invoking any gh process', async () => {
  const fx = fixture({
    originUrl: () => 'git@github.com:o/r.git',
    credential: (host) => (host === 'github.com' ? 'tok-123' : undefined),
  });
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const warm = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 1);
    assert.equal(warm.cache?.source, 'hint');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('--no-cache computes live and stores nothing', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    const off = await readDiscoverHint(request(fx, compute, { noCache: true }));
    assert.equal(off.cache?.mode, 'off');
    assert.equal(off.cache?.source, 'live');
    assert.equal(calls(), 1);
    const next = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 2);
    assert.equal(next.cache?.source, 'live');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('--refresh-cache recomputes strict-fresh and the next hint sees it', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }, { leaves: [1, 9] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const refreshed = await readDiscoverHint(
      request(fx, compute, { refreshCache: true }),
    );
    assert.equal(calls(), 2);
    assert.equal(refreshed.cache?.mode, 'refresh');
    assert.equal(refreshed.cache?.source, 'live');
    assert.deepEqual(refreshed.report.leaves, [1, 9]);
    const next = await readDiscoverHint(request(fx, compute));
    assert.equal(next.cache?.source, 'hint');
    assert.deepEqual(next.report.leaves, [1, 9]);
    assert.equal(calls(), 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('--purge-cache removes stored hints so the next read recomputes', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const purged = purgeDiscoverHints(fx.deps);
    assert.equal(purged.cache, 'purged');
    assert.ok(purged.removed >= 1);
    await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('any change to args, policy, IDD env, or worktree is a miss', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    await readDiscoverHint(
      request(fx, compute, { args: { allRoadmaps: false, issue: 7 } }),
    );
    await readDiscoverHint(request(fx, compute, { policy: { floor: 4 } }));
    await readDiscoverHint(
      request(fx, compute, {
        deps: {
          ...fx.deps,
          env: { IDD_TRUSTED_MARKER_ACTORS: 'ci-bot[bot]' },
        },
      }),
    );
    const otherWorktree = join(fx.root, 'other');
    mkdirSync(otherWorktree);
    await readDiscoverHint(
      request(fx, compute, { deps: { ...fx.deps, cwd: otherWorktree } }),
    );
    assert.equal(calls(), 5);
    const again = await readDiscoverHint(request(fx, compute));
    assert.equal(again.cache?.source, 'hint');
    assert.equal(calls(), 5);
    const otherHelper = await readDiscoverHint(
      request(fx, compute, { helper: 'discover-orphan-filter' }),
    );
    assert.equal(otherHelper.cache?.source, 'live');
    assert.equal(calls(), 6);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a different credential or repository never shares a hint', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    await readDiscoverHint(
      request(fx, compute, {
        deps: { ...fx.deps, credential: () => 'someone-elses-token' },
      }),
    );
    await readDiscoverHint(
      request(fx, compute, {
        deps: { ...fx.deps, originUrl: () => 'https://github.com/o/other' },
      }),
    );
    await readDiscoverHint(request(fx, compute, { owner: 'x', repo: 'y' }));
    assert.equal(calls(), 4);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('invalidation forgets discover hints only, not other cache entries', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const unrelated = readThroughGithubApiCache({
      classification: 'read',
      mode: 'hint',
      policy: fx.deps.policy as NonNullable<DiscoverHintDeps['policy']>,
      host: 'github.com',
      repository: 'o/r',
      credentialMaterial: 'hint-credential-token',
      requestShape: { path: '/repos/o/r/issues/1' },
      workspaceRoot: fx.workspace,
      cwd: fx.workspace,
      now: () => fx.clock.now,
      fetch: () => ({ status: 200, body: { n: 1 } }),
    });
    assert.equal(unrelated.cache, 'miss');
    assert.equal(invalidateDiscoverHints({}, fx.deps), true);
    const after = await readDiscoverHint(request(fx, compute));
    assert.equal(after.cache?.source, 'live');
    assert.equal(calls(), 2);
    const still = readThroughGithubApiCache({
      classification: 'read',
      mode: 'hint',
      policy: fx.deps.policy as NonNullable<DiscoverHintDeps['policy']>,
      host: 'github.com',
      repository: 'o/r',
      credentialMaterial: 'hint-credential-token',
      requestShape: { path: '/repos/o/r/issues/1' },
      workspaceRoot: fx.workspace,
      cwd: fx.workspace,
      now: () => fx.clock.now,
      fetch: () => {
        throw new Error('the unrelated entry must still be cached');
      },
    });
    assert.equal(still.cache, 'hit');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('invalidation is a silent no-op when the feature is off or unidentified', () => {
  const off = fixture();
  const noIdentity = fixture({ credential: () => undefined });
  try {
    assert.equal(
      invalidateDiscoverHints(
        {},
        {
          ...off.deps,
          policy: {
            ...(off.deps.policy as NonNullable<DiscoverHintDeps['policy']>),
            enabled: false,
          },
        },
      ),
      false,
    );
    assert.equal(invalidateDiscoverHints({}, noIdentity.deps), false);
    assert.equal(readdirSync(off.cacheDir).length, 0);
    assert.equal(readdirSync(noIdentity.cacheDir).length, 0);
    assert.equal(
      invalidateDiscoverHints(
        {},
        {
          ...off.deps,
          storage: {
            writeAtomic: () => {
              throw new Error('disk full');
            },
          },
        },
      ),
      false,
    );
  } finally {
    rmSync(off.root, { recursive: true, force: true });
    rmSync(noIdentity.root, { recursive: true, force: true });
  }
});

test('an incomplete computation is returned but never stored', async () => {
  const fx = fixture();
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    noteDiscoveryIncomplete('root search hit the result cap');
    return { leaves: [1] };
  };
  try {
    const first = await readDiscoverHint(request(fx, compute));
    const second = await readDiscoverHint(request(fx, compute));
    assert.equal(first.cache?.complete, false);
    assert.equal(first.cache?.source, 'live');
    assert.equal(second.cache?.complete, false);
    assert.equal(calls, 2);
    // A later complete run stores normally: the collector was restored.
    const clean = counter([{ leaves: [1] }]);
    await readDiscoverHint(request(fx, clean.compute));
    const warm = await readDiscoverHint(request(fx, clean.compute));
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(clean.calls(), 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('cached exhaustion triggers exactly one strict-fresh refresh that finds a new leaf', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [] }, { leaves: [4242] }]);
  try {
    const cold = await readDiscoverHint(request(fx, compute));
    // A live empty result is already fresh: no refresh is owed.
    assert.equal(cold.cache?.exhaustionRefresh, false);
    assert.equal(calls(), 1);
    const refreshed = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 2);
    assert.deepEqual(refreshed.report.leaves, [4242]);
    assert.equal(refreshed.cache?.exhaustionRefresh, true);
    assert.equal(refreshed.cache?.source, 'live');
    assert.equal(refreshed.cache?.enumerations, 1);
    const warm = await readDiscoverHint(request(fx, compute));
    assert.equal(warm.cache?.source, 'hint');
    assert.equal(warm.cache?.exhaustionRefresh, false);
    assert.equal(calls(), 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a failed exhaustion refresh throws instead of reporting exhaustion', async () => {
  const fx = fixture();
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    if (calls === 1) return { leaves: [] };
    throw new Error('secondary rate limit');
  };
  try {
    await readDiscoverHint(request(fx, compute));
    await assert.rejects(
      readDiscoverHint(request(fx, compute)),
      /secondary rate limit/,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a partial exhaustion refresh is reported incomplete, not exhausted', async () => {
  const fx = fixture();
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    if (calls > 1) noteDiscoveryIncomplete('skipped root');
    return { leaves: [] };
  };
  try {
    await readDiscoverHint(request(fx, compute));
    const refreshed = await readDiscoverHint(request(fx, compute));
    assert.equal(refreshed.cache?.exhaustionRefresh, true);
    assert.equal(refreshed.cache?.complete, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an explicit refresh does not owe a second exhaustion refresh', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [] }]);
  try {
    const refreshed = await readDiscoverHint(
      request(fx, compute, { refreshCache: true }),
    );
    assert.equal(calls(), 1);
    assert.equal(refreshed.cache?.exhaustionRefresh, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('two concurrent in-process reads coalesce onto one enumeration', async () => {
  const fx = fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    await gate;
    return { leaves: [1] };
  };
  try {
    const first = readDiscoverHint(request(fx, compute));
    const second = readDiscoverHint(request(fx, compute));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(a.report, b.report);
    assert.equal(
      [a.cache?.source, b.cache?.source].sort().join(','),
      'hint,live',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the feature off leaves output untouched and touches no cache directory', async () => {
  const fx = fixture();
  const off = {
    ...fx.deps,
    policy: {
      ...(fx.deps.policy as NonNullable<DiscoverHintDeps['policy']>),
      enabled: false,
    },
  };
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    const plain = await readDiscoverHint(request(fx, compute, { deps: off }));
    assert.equal('cache' in plain, false);
    assert.equal(calls(), 1);
    const flagged = await readDiscoverHint(
      request(fx, compute, { deps: off, refreshCache: true }),
    );
    assert.equal(flagged.cache?.mode, 'bypass');
    assert.equal(readdirSync(fx.cacheDir).length, 0);
    const explicit = await readDiscoverHint(
      request(fx, compute, { deps: off, noCache: true }),
    );
    assert.equal(explicit.cache?.mode, 'off');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an unidentified caller bypasses the cache rather than guessing a key', async () => {
  const noCredential = fixture({ credential: () => undefined });
  const noRemote = fixture({ originUrl: () => undefined });
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    // Without a cache flag the run reports nothing: output stays identical.
    const a = await readDiscoverHint(request(noCredential, compute));
    const b = await readDiscoverHint(request(noRemote, compute));
    assert.equal('cache' in a, false);
    assert.equal('cache' in b, false);
    // A cache flag asks about the run, so the bypass is reported.
    const flagged = await readDiscoverHint(
      request(noCredential, compute, { refreshCache: true }),
    );
    assert.equal(flagged.cache?.mode, 'bypass');
    assert.equal(calls(), 3);
    assert.equal(existsSync(join(noCredential.cacheDir, 'entries')), false);
    assert.equal(existsSync(join(noRemote.cacheDir, 'entries')), false);
  } finally {
    rmSync(noCredential.root, { recursive: true, force: true });
    rmSync(noRemote.root, { recursive: true, force: true });
  }
});

test('per-session IDD plumbing does not split hints but trust variables do', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const sameAnswer = await readDiscoverHint(
      request(fx, compute, {
        deps: {
          ...fx.deps,
          env: {
            IDD_CLONE_LOCK_TOKEN: 'another-session',
            IDD_HELPER_ERROR_ENVELOPE: '1',
          },
        },
      }),
    );
    assert.equal(sameAnswer.cache?.source, 'hint');
    const trustChanged = await readDiscoverHint(
      request(fx, compute, {
        deps: { ...fx.deps, env: { IDD_TRUST_COLLABORATOR_MARKERS: 'true' } },
      }),
    );
    assert.equal(trustChanged.cache?.source, 'live');
    assert.equal(calls(), 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('overlapping computations keep their completeness signals apart', async () => {
  const fx = fixture();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((done) => {
    releaseFirst = done;
  });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((done) => {
    releaseSecond = done;
  });
  const incomplete = async (): Promise<Report> => {
    await firstGate;
    noteDiscoveryIncomplete('a capped search');
    return { leaves: [1] };
  };
  const complete = async (): Promise<Report> => {
    await secondGate;
    return { leaves: [2] };
  };
  try {
    // Different args keep the two reads from coalescing onto one lease.
    const a = readDiscoverHint(request(fx, incomplete, { args: { n: 'a' } }));
    const b = readDiscoverHint(request(fx, complete, { args: { n: 'b' } }));
    releaseFirst();
    const resultA = await a;
    releaseSecond();
    const resultB = await b;
    assert.equal(resultA.cache?.complete, false);
    assert.equal(resultB.cache?.complete, true);
    const warm = await readDiscoverHint(
      request(fx, complete, { args: { n: 'b' } }),
    );
    assert.equal(warm.cache?.source, 'hint');
    const notStored = await readDiscoverHint(
      request(fx, incomplete, { args: { n: 'a' } }),
    );
    assert.equal(notStored.cache?.source, 'live');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("concurrent exhausted sessions coalesce and owe no refresh to a peer's fresh result", async () => {
  const fx = fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    await gate;
    return { leaves: [] };
  };
  try {
    const all = [1, 2, 3].map(() => readDiscoverHint(request(fx, compute)));
    release();
    const results = await Promise.all(all);
    assert.equal(calls, 1);
    for (const result of results) {
      assert.equal(result.cache?.exhaustionRefresh, false);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a hint is aged from the start of its enumeration, not its publication', async () => {
  const fx = fixture();
  let calls = 0;
  const compute = async (): Promise<Report> => {
    calls += 1;
    // The enumeration itself outlives the freshness window.
    fx.clock.now += 400_000;
    return { leaves: [calls] };
  };
  try {
    const first = await readDiscoverHint(request(fx, compute));
    assert.deepEqual(first.report.leaves, [1]);
    const second = await readDiscoverHint(request(fx, compute));
    assert.equal(calls, 2);
    assert.deepEqual(second.report.leaves, [2]);
    assert.equal(second.cache?.source, 'live');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a stored body this layer did not write is replaced, not served', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    const entries = join(fx.cacheDir, 'entries');
    for (const name of readdirSync(entries)) {
      const path = join(entries, name);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof record.body === 'object' && record.body !== null) {
        record.body = { unexpected: true };
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      }
    }
    const repaired = await readDiscoverHint(request(fx, compute));
    assert.equal(calls(), 2);
    assert.equal(repaired.cache?.source, 'live');
    const warm = await readDiscoverHint(request(fx, compute));
    assert.equal(warm.cache?.source, 'hint');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an invalidation names the repository it was given and no other', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  try {
    await readDiscoverHint(request(fx, compute));
    // A different explicit repository leaves this repository's hints alone.
    assert.equal(
      invalidateDiscoverHints({ owner: 'someone', repo: 'else' }, fx.deps),
      true,
    );
    const still = await readDiscoverHint(request(fx, compute));
    assert.equal(still.cache?.source, 'hint');
    // The same repository in a different case is the same identity.
    assert.equal(
      invalidateDiscoverHints({ owner: 'O', repo: 'R' }, fx.deps),
      true,
    );
    const dropped = await readDiscoverHint(request(fx, compute));
    assert.equal(dropped.cache?.source, 'live');
    assert.equal(calls(), 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('concurrent readers of a hint that is stale from its start still coalesce', async () => {
  const fx = fixture();
  let calls = 0;
  let release: (() => void) | null = null;
  const compute = async (): Promise<Report> => {
    calls += 1;
    if (calls === 1) {
      // The first enumeration outlives part of the freshness window.
      fx.clock.now += 100_000;
      return { leaves: [1] };
    }
    await new Promise<void>((done) => {
      release = done;
    });
    return { leaves: [2] };
  };
  try {
    await readDiscoverHint(request(fx, compute));
    // Stored 250 s ago, but its enumeration began 350 s ago (maxAge 300 s).
    fx.clock.now += 250_000;
    const first = readDiscoverHint(request(fx, compute));
    const second = readDiscoverHint(request(fx, compute));
    // Let both reach the lease before the leader finishes.
    await new Promise<void>((done) => setTimeout(done, 60));
    (release as (() => void) | null)?.();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.deepEqual(a.report.leaves, [2]);
    assert.deepEqual(b.report.leaves, [2]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an invalidation without an explicit repository falls back to origin', async () => {
  const fx = fixture();
  const { compute, calls } = counter([{ leaves: [1] }]);
  const partial = [
    {},
    { owner: 'o' },
    { repo: 'r' },
    { owner: undefined, repo: undefined },
    { owner: '', repo: '' },
  ];
  try {
    for (const identity of partial) {
      await readDiscoverHint(request(fx, compute));
      assert.equal(invalidateDiscoverHints(identity, fx.deps), true);
      const after = await readDiscoverHint(request(fx, compute));
      assert.equal(
        after.cache?.source,
        'live',
        `identity ${JSON.stringify(identity)} should drop the origin hint`,
      );
    }
    assert.equal(calls(), partial.length + 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
