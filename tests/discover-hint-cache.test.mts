import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
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
