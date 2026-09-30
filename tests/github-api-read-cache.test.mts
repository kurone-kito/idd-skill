import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type GithubApiCacheFetchRequest,
  type GithubApiCacheFetchResult,
  type GithubApiReadClassification,
  type ReadThroughGithubApiCacheAsyncInput,
  type ReadThroughGithubApiCacheInput,
  readThroughGithubApiCache,
  readThroughGithubApiCacheAsync,
  resolveCanonicalPath,
} from '../src/scripts/github-api-read-cache.mts';

const MARKER = '.idd-github-api-read-cache';
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
const WORKER = fileURLToPath(
  new URL('./github-api-read-cache-worker.mts', import.meta.url),
);

function tempRoot(): { root: string; cacheDir: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'idd-read-cache-'));
  const cacheDir = join(root, 'cache');
  const workspace = join(root, 'workspace');
  mkdirSync(cacheDir);
  mkdirSync(workspace);
  return { root, cacheDir, workspace };
}

function policy(
  directory: string,
  overrides: Record<string, unknown> = {},
): ReadThroughGithubApiCacheInput['policy'] {
  return {
    enabled: true,
    maxAgeMs: 300_000,
    maxBytes: 104857600,
    retentionMs: 86_400_000,
    directory,
    ...overrides,
  };
}

function readThrough(
  paths: { cacheDir: string; workspace: string },
  fetch: ReadThroughGithubApiCacheInput['fetch'],
  overrides: Partial<ReadThroughGithubApiCacheInput> = {},
) {
  return readThroughGithubApiCache({
    classification: 'read',
    mode: 'hint',
    policy: policy(paths.cacheDir),
    host: 'github.com',
    repository: 'o/r',
    credentialMaterial: 'credential-material-token',
    requestShape: { path: '/repos/o/r' },
    workspaceRoot: paths.workspace,
    cwd: paths.workspace,
    fetch,
    ...overrides,
  });
}

function okBody(
  body: unknown,
  etag?: string,
): (request: GithubApiCacheFetchRequest) => GithubApiCacheFetchResult {
  return () => ({ status: 200, body, ...(etag ? { etag } : {}) });
}

function entryNames(cacheDir: string): string[] {
  const entries = join(cacheDir, 'entries');
  if (!existsSync(entries)) return [];
  return readdirSync(entries).filter((name) => ENTRY_NAME.test(name));
}

function readEntry(cacheDir: string, entryId: string): unknown {
  return JSON.parse(
    readFileSync(join(cacheDir, 'entries', `${entryId}.json`), 'utf8'),
  );
}

test('a second same-scope hint read is a hit and does not fetch again', () => {
  const paths = tempRoot();
  const requests: GithubApiCacheFetchRequest[] = [];
  const fetch = (request: GithubApiCacheFetchRequest) => {
    requests.push(request);
    return { status: 200, body: { n: 1 }, etag: '"n"' };
  };
  try {
    const first = readThrough(paths, fetch);
    const second = readThrough(paths, fetch);
    assert.equal(requests.length, 1);
    assert.equal(first.cache, 'miss');
    assert.equal(second.cache, 'hit');
    assert.equal(second.fetched, false);
    assert.deepEqual(second.body, { n: 1 });
    const stored = readFileSync(
      join(paths.cacheDir, 'entries', `${first.entryId}.json`),
      'utf8',
    );
    assert.equal(stored.includes('credential-material-token'), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('different credential, host, repository, request, or derived inputs do not share an entry', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { n: fetches } };
  };
  try {
    const base = readThrough(paths, fetch);
    const variants: Partial<ReadThroughGithubApiCacheInput>[] = [
      { credentialMaterial: 'other-credential-token' },
      { host: 'ghe.example' },
      { repository: 'o/other' },
      { requestShape: { path: '/repos/o/r/issues' } },
      { derivedInputs: { policy: 'other' } },
    ];
    const ids = variants.map(
      (variant) => readThrough(paths, fetch, variant).entryId,
    );
    assert.equal(fetches, 1 + variants.length);
    assert.equal(new Set([base.entryId, ...ids]).size, 1 + variants.length);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a blank credential or host bypasses the cache instead of sharing a context', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { ok: true } };
  };
  try {
    for (const overrides of [
      { credentialMaterial: '' },
      { credentialMaterial: '   ' },
      { host: '' },
      { host: '  ' },
    ]) {
      const result = readThrough(paths, fetch, overrides);
      assert.equal(result.cache, 'bypass');
      assert.equal(result.entryId, undefined);
    }
    assert.equal(fetches, 4);
    assert.equal(existsSync(join(paths.cacheDir, MARKER)), false);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a request shape plain JSON cannot represent bypasses the cache', () => {
  const paths = tempRoot();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { ok: true } };
  };
  const unrepresentable: unknown[] = [
    new Date(0),
    1n,
    new Map([['a', 1]]),
    new Set([1]),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => 1,
    Symbol('s'),
    [undefined],
    new Array(1),
    Object.assign(new Array(3), { 0: 1, 2: 2 }),
    cycle,
  ];
  try {
    for (const requestShape of unrepresentable) {
      const result = readThrough(paths, fetch, { requestShape });
      assert.equal(result.cache, 'bypass', String(requestShape));
    }
    const derived = readThrough(paths, fetch, {
      derivedInputs: { at: new Date(0) },
    });
    assert.equal(derived.cache, 'bypass');
    assert.equal(fetches, unrepresentable.length + 1);
    assert.deepEqual(entryNames(paths.cacheDir), []);
    // Two different dates must never collapse into one shared entry.
    const first = readThrough(paths, okBody({ n: 1 }), {
      requestShape: { since: new Date(1) },
    });
    const second = readThrough(paths, okBody({ n: 2 }), {
      requestShape: { since: new Date(2) },
    });
    assert.equal(first.cache, 'bypass');
    assert.equal(second.cache, 'bypass');
    assert.deepEqual(second.body, { n: 2 });
    // Plain JSON still keys deterministically; undefined properties drop.
    readThrough(paths, okBody({ n: 3 }), {
      requestShape: { b: [1, { c: null }], a: 'x', u: undefined },
    });
    const same = readThrough(paths, okBody({ n: 4 }), {
      requestShape: { a: 'x', b: [1, { c: null }] },
    });
    assert.equal(same.cache, 'hit');
    assert.deepEqual(same.body, { n: 3 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('non-read classifications and a disabled policy do not touch the cache', () => {
  const paths = tempRoot();
  const classifications: GithubApiReadClassification[] = [
    'write',
    'graphql-mutation',
    'ambiguous-write',
    'authority',
  ];
  try {
    for (const classification of classifications) {
      let fetches = 0;
      const fetch = () => {
        fetches += 1;
        return { status: 200, body: { classification } };
      };
      readThrough(paths, fetch, { classification });
      readThrough(paths, fetch, { classification, mode: 'strict-fresh' });
      assert.equal(fetches, 2, classification);
    }
    let disabledFetches = 0;
    readThrough(
      paths,
      () => {
        disabledFetches += 1;
        return { status: 200, body: { disabled: true } };
      },
      { policy: { ...policy(paths.cacheDir), enabled: false } },
    );
    assert.equal(disabledFetches, 1);
    assert.equal(existsSync(join(paths.cacheDir, MARKER)), false);
    assert.equal(existsSync(join(paths.cacheDir, 'entries')), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('hint expiry refetches while conditional revalidation reuses a 304 base', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const requests: GithubApiCacheFetchRequest[] = [];
  let step = 0;
  const fetch = (request: GithubApiCacheFetchRequest) => {
    requests.push(request);
    step += 1;
    if (step === 1) return { status: 200, body: { v: 1 }, etag: '"v1"' };
    return { status: 304, body: null, etag: '"v1"' };
  };
  try {
    readThrough(paths, fetch, {
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000, retentionMs: 10_000 }),
      now: () => now,
    });
    now += 1_001;
    const hint = readThrough(paths, fetch, {
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000, retentionMs: 10_000 }),
      now: () => now,
    });
    assert.equal(hint.cache, 'miss');
    assert.equal(requests[1]?.etag, undefined);
    const conditional = readThrough(paths, fetch, {
      mode: 'conditional',
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000, retentionMs: 10_000 }),
      now: () => now,
    });
    assert.equal(conditional.cache, 'revalidated');
    assert.deepEqual(conditional.body, { v: 1 });
    assert.equal(requests[2]?.etag, '"v1"');
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a 304 refresh honors maxBytes and runs eviction like publish', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const big = 'x'.repeat(600);
  const conditional = (bytes: number) =>
    readThrough(paths, () => ({ status: 304, body: null, etag: '"a"' }), {
      mode: 'conditional',
      requestShape: { path: '/a' },
      policy: policy(paths.cacheDir, { maxBytes: bytes }),
      now: () => now,
    });
  try {
    const seed = (path: string, etag: string) => {
      now += 10;
      readThrough(paths, okBody({ big }, etag), {
        requestShape: { path },
        now: () => now,
      });
    };
    seed('/b', '"b"');
    seed('/a', '"a"');
    assert.equal(entryNames(paths.cacheDir).length, 2);
    now += 10;
    // Each entry fits alone, but both together exceed the bound: the
    // refresh must evict the older /b entry like publish does.
    const refreshed = conditional(1_000);
    assert.equal(refreshed.cache, 'revalidated');
    assert.equal(entryNames(paths.cacheDir).length, 1);
    assert.deepEqual(readEntry(paths.cacheDir, refreshed.entryId ?? ''), {
      schemaVersion: 1,
      storedAt: now,
      startedAt: now,
      status: 200,
      body: { big },
      complete: true,
      etag: '"a"',
    });
    // A bound below the record's own size drops it instead of rewriting.
    now += 10;
    const shrunk = conditional(200);
    assert.equal(shrunk.cache, 'revalidated');
    assert.deepEqual(shrunk.body, { big });
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a 304 refresh never overwrites a newer entry or resurrects a purged one', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    readThrough(paths, okBody({ v: 1 }, '"v1"'), { now: clock });
    now += 10;
    const superseded = readThrough(
      paths,
      (request) => {
        if (request.etag === undefined) {
          return { status: 200, body: { v: 1 }, etag: '"v1"' };
        }
        // A strict-fresh read (which takes no lease) stores v2 while this
        // conditional request for v1 is still in flight.
        now += 10;
        readThrough(paths, okBody({ v: 2 }, '"v2"'), {
          mode: 'strict-fresh',
          now: clock,
        });
        now += 10;
        return { status: 304, body: null, etag: '"v1"' };
      },
      { mode: 'conditional', now: clock },
    );
    assert.equal(superseded.cache, 'revalidated');
    const hint = readThrough(paths, okBody({ v: 3 }), { now: clock });
    assert.equal(hint.cache, 'hit');
    assert.deepEqual(hint.body, { v: 2 });

    now += 10;
    const purged = readThrough(
      paths,
      () => {
        readThrough(paths, okBody(null), {
          operation: 'purge',
          now: clock,
        });
        return { status: 304, body: null, etag: '"v2"' };
      },
      { mode: 'conditional', now: clock },
    );
    assert.equal(purged.cache, 'revalidated');
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a failing eviction after a 304 refresh does not trigger a second fetch', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  let failEviction = false;
  let fetches = 0;
  try {
    const run = (mode: 'hint' | 'conditional') =>
      readThrough(
        paths,
        () => {
          fetches += 1;
          return fetches === 1
            ? { status: 200, body: { v: 1 }, etag: '"v1"' }
            : { status: 304, body: null, etag: '"v1"' };
        },
        {
          mode,
          now: () => now,
          storage: {
            readdir(path: string): string[] {
              // Only the entries listing eviction reads; prepareRoot's
              // root listing must keep working so the 304 is reached.
              if (failEviction && path.endsWith(`${sep}entries`)) {
                throw new Error('readdir failed');
              }
              return readdirSync(path);
            },
          },
        },
      );
    run('hint');
    failEviction = true;
    now += 10;
    const result = run('conditional');
    assert.equal(result.cache, 'revalidated');
    assert.equal(fetches, 2);
    assert.deepEqual(result.body, { v: 1 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a 304 without a trusted base performs one real fetch', () => {
  const paths = tempRoot();
  let step = 0;
  const fetch = () => {
    step += 1;
    if (step === 1) return { status: 304, body: null, etag: '"missing"' };
    return { status: 200, body: { v: 2 }, etag: '"v2"' };
  };
  try {
    const result = readThrough(paths, fetch, { mode: 'conditional' });
    assert.equal(step, 2);
    assert.deepEqual(result.body, { v: 2 });
    assert.equal(entryNames(paths.cacheDir).length, 1);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a repeated 304 without a base throws and stores nothing', () => {
  const paths = tempRoot();
  let calls = 0;
  try {
    assert.throws(
      () =>
        readThrough(
          paths,
          () => {
            calls += 1;
            return { status: 304, body: {}, etag: '"x"' };
          },
          { mode: 'conditional' },
        ),
      /without a trusted representation/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('clock rollback does not trust a future entry as a 304 base', () => {
  const paths = tempRoot();
  let now = 5_000;
  const requests: GithubApiCacheFetchRequest[] = [];
  let step = 0;
  const fetch = (request: GithubApiCacheFetchRequest) => {
    requests.push(request);
    step += 1;
    return { status: 200, body: { step }, etag: `"${step}"` };
  };
  try {
    readThrough(paths, fetch, { mode: 'conditional', now: () => now });
    now = 4_000;
    const result = readThrough(paths, fetch, {
      mode: 'conditional',
      now: () => now,
    });
    assert.equal(result.fetched, true);
    assert.equal(requests[1]?.etag, undefined);
    assert.deepEqual(result.body, { step: 2 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('corrupt and wrong-version entries are discarded and refetched', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { fetches } };
  };
  try {
    const first = readThrough(paths, fetch);
    const file = join(paths.cacheDir, 'entries', `${first.entryId}.json`);
    writeFileSync(file, '{not json');
    const second = readThrough(paths, fetch);
    assert.equal(fetches, 2);
    assert.deepEqual(second.body, { fetches: 2 });
    const stored = readEntry(paths.cacheDir, String(second.entryId)) as {
      schemaVersion: number;
    };
    stored.schemaVersion = 0;
    writeFileSync(file, JSON.stringify(stored));
    const third = readThrough(paths, fetch);
    assert.equal(fetches, 3);
    assert.deepEqual(third.body, { fetches: 3 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('errors, throttles, and incomplete collections are not stored', () => {
  const paths = tempRoot();
  const results: GithubApiCacheFetchResult[] = [
    { status: 500, body: { message: 'boom' } },
    { status: 429, body: { message: 'slow' }, throttled: true },
    { status: 200, body: { pages: 1 }, incomplete: true },
    { status: 403, body: { message: 'limited' }, throttled: true },
  ];
  try {
    for (const result of results) {
      let fetches = 0;
      const fetch = () => {
        fetches += 1;
        return result;
      };
      readThrough(paths, fetch);
      readThrough(paths, fetch);
      assert.equal(fetches, 2, JSON.stringify(result));
    }
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a response naming its own host and repository is stored', () => {
  const paths = tempRoot();
  const body = {
    full_name: 'o/r',
    html_url: 'https://github.com/o/r',
    url: 'https://api.github.com/repos/o/r',
  };
  try {
    const first = readThrough(paths, okBody(body));
    assert.equal(first.cache, 'miss');
    assert.equal(entryNames(paths.cacheDir).length, 1);
    // The secret scan looks for the credential inside the scope identifiers
    // and body, never for the identifiers inside the body.
    const second = readThrough(paths, okBody({ other: true }));
    assert.equal(second.cache, 'hit');
    assert.deepEqual(second.body, body);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a response echoing the credential material is never stored, even without secretMaterial', () => {
  const paths = tempRoot();
  const credentialMaterial = 'ghp_credential_material_sentinel';
  let fetches = 0;
  try {
    const result = readThrough(
      paths,
      () => {
        fetches += 1;
        return { status: 200, body: { echoed: credentialMaterial } };
      },
      { credentialMaterial },
    );
    assert.equal(result.cache, 'miss');
    assert.deepEqual(entryNames(paths.cacheDir), []);
    readThrough(
      paths,
      () => {
        fetches += 1;
        return { status: 200, body: { echoed: credentialMaterial } };
      },
      { credentialMaterial },
    );
    assert.equal(fetches, 2);
    const onDisk = existsSync(join(paths.cacheDir, 'entries'))
      ? readdirSync(join(paths.cacheDir, 'entries')).map((name) =>
          readFileSync(join(paths.cacheDir, 'entries', name), 'utf8'),
        )
      : [];
    assert.equal(onDisk.join('').includes(credentialMaterial), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a response containing declared secret material is not stored', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { token: 'super-secret-token' } };
  };
  try {
    readThrough(paths, fetch, { secretMaterial: ['super-secret-token'] });
    readThrough(paths, fetch, { secretMaterial: ['super-secret-token'] });
    assert.equal(fetches, 2);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an entry larger than maxBytes is not retained', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { data: 'x'.repeat(500) } };
  };
  try {
    readThrough(paths, fetch, {
      policy: policy(paths.cacheDir, { maxBytes: 80 }),
    });
    readThrough(paths, fetch, {
      policy: policy(paths.cacheDir, { maxBytes: 80 }),
    });
    assert.equal(fetches, 2);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('retention and size eviction drop the oldest stored response', () => {
  const paths = tempRoot();
  let now = 10_000;
  const fetch = (body: unknown) => () => ({ status: 200, body });
  try {
    const first = readThrough(paths, fetch({ id: 'old' }), {
      policy: policy(paths.cacheDir, { retentionMs: 1_000 }),
      now: () => now,
    });
    now += 1_001;
    const second = readThrough(paths, fetch({ id: 'new' }), {
      requestShape: { path: '/other' },
      policy: policy(paths.cacheDir, { retentionMs: 1_000 }),
      now: () => now,
    });
    assert.deepEqual(entryNames(paths.cacheDir), [`${second.entryId}.json`]);
    assert.equal(
      existsSync(join(paths.cacheDir, 'entries', `${first.entryId}.json`)),
      false,
    );

    const sized = tempRoot();
    const kept = readThrough(sized, fetch({ id: 'a' }));
    const size = lstatSync(
      join(sized.cacheDir, 'entries', `${kept.entryId}.json`),
    ).size;
    const newer = readThrough(sized, fetch({ id: 'b' }), {
      requestShape: { path: '/newer' },
      policy: policy(sized.cacheDir, { maxBytes: size }),
    });
    assert.deepEqual(entryNames(sized.cacheDir), [`${newer.entryId}.json`]);
    rmSync(sized.root, { recursive: true, force: true });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a definitive 404 or 410 invalidates the stored 200, other failures keep it', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    for (const status of [404, 410]) {
      readThrough(paths, okBody({ exists: true }), { now: clock });
      assert.equal(entryNames(paths.cacheDir).length, 1);
      now += 10;
      const gone = readThrough(
        paths,
        () => ({ status, body: { gone: true } }),
        {
          mode: 'strict-fresh',
          now: clock,
        },
      );
      assert.equal(gone.status, status);
      assert.deepEqual(entryNames(paths.cacheDir), []);
      // The stale 200 is no longer served to a hint read.
      now += 10;
      const next = readThrough(paths, okBody({ exists: false }), {
        now: clock,
      });
      assert.equal(next.cache, 'miss');
      assert.deepEqual(next.body, { exists: false });
      readThrough(paths, () => ({ status: 200, body: {} }), {
        mode: 'strict-fresh',
        now: clock,
      });
      now += 10;
    }
    // An expired hint whose refetch is a definitive 404 drops the entry too.
    readThrough(paths, okBody({ exists: true }), {
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000 }),
      now: clock,
    });
    now += 1_001;
    readThrough(paths, () => ({ status: 404, body: null }), {
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000 }),
      now: clock,
    });
    assert.deepEqual(entryNames(paths.cacheDir), []);
    // 401, 403, 429 and 5xx say nothing about the resource.
    for (const status of [401, 403, 429, 500, 503]) {
      const requestShape = { path: `/status-${status}` };
      readThrough(paths, okBody({ keep: status }), {
        requestShape,
        now: clock,
      });
      now += 10;
      readThrough(paths, () => ({ status, body: null }), {
        mode: 'strict-fresh',
        requestShape,
        now: clock,
      });
      const kept = readThrough(paths, okBody({ other: true }), {
        requestShape,
        now: clock,
      });
      assert.equal(kept.cache, 'hit', `${status}`);
      assert.deepEqual(kept.body, { keep: status });
      now += 10;
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a 404 seen after a failed 304 refresh still drops the stored 200', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    readThrough(paths, okBody({ v: 1 }, '"v1"'), { now: clock });
    assert.equal(entryNames(paths.cacheDir).length, 1);
    now += 10;
    let calls = 0;
    const result = readThrough(
      paths,
      () => {
        calls += 1;
        return calls === 1
          ? { status: 304, body: null, etag: '"v1"' }
          : { status: 404, body: { gone: true } };
      },
      {
        mode: 'conditional',
        now: clock,
        storage: {
          writeAtomic(): void {
            throw Object.assign(new Error('read-only'), { code: 'EACCES' });
          },
        },
      },
    );
    assert.equal(result.cache, 'degraded');
    assert.equal(result.status, 404);
    assert.equal(calls, 2);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an older strict-fresh read never overwrites or removes a newer one', () => {
  for (const older of [
    { status: 200, body: { v: 'older' } },
    { status: 404, body: null },
  ]) {
    const paths = tempRoot();
    let now = 1_000_000;
    const clock = () => now;
    try {
      const result = readThrough(
        paths,
        () => {
          // A newer strict-fresh read (no lease) starts and finishes while
          // this older one is still in flight.
          now += 10;
          readThrough(paths, okBody({ v: 'newer' }), {
            mode: 'strict-fresh',
            now: clock,
          });
          now += 10;
          return older;
        },
        { mode: 'strict-fresh', now: clock },
      );
      assert.equal(result.status, older.status);
      now += 10;
      const hint = readThrough(paths, okBody({ v: 'hint' }), { now: clock });
      assert.equal(hint.cache, 'hit', String(older.status));
      assert.deepEqual(hint.body, { v: 'newer' }, String(older.status));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }
});

test('a legacy entry without startedAt orders by storedAt against strict-fresh reads', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    const first = readThrough(paths, okBody({ v: 1 }), { now: clock });
    // A record written before startedAt existed carries only storedAt.
    const entryFile = join(
      paths.cacheDir,
      'entries',
      `${String(first.entryId)}.json`,
    );
    const legacy = JSON.parse(readFileSync(entryFile, 'utf8')) as Record<
      string,
      unknown
    >;
    delete legacy.startedAt;
    unlinkSync(entryFile);
    writeFileSync(entryFile, JSON.stringify(legacy), { mode: 0o600 });
    const stored = () =>
      readEntry(paths.cacheDir, String(first.entryId)) as { body: unknown };
    // A strict-fresh read that started before the legacy record was stored
    // (its generation is the older storedAt) must not overwrite it.
    now = 999_990;
    readThrough(
      paths,
      () => {
        now = 1_000_020;
        return { status: 200, body: { v: 'older' } };
      },
      { mode: 'strict-fresh', now: clock },
    );
    assert.deepEqual(stored().body, { v: 1 });
    // One that starts after it replaces it.
    now = 1_000_030;
    readThrough(paths, okBody({ v: 2 }), { mode: 'strict-fresh', now: clock });
    assert.deepEqual(stored().body, { v: 2 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an older in-flight hint 200 does not overwrite a newer strict-fresh entry', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    const result = readThrough(
      paths,
      () => {
        now += 10;
        readThrough(paths, okBody({ v: 'newer' }), {
          mode: 'strict-fresh',
          now: clock,
        });
        now += 10;
        return { status: 200, body: { v: 'older' } };
      },
      { now: clock },
    );
    assert.deepEqual(result.body, { v: 'older' });
    const hint = readThrough(paths, okBody({ v: 'hint' }), { now: clock });
    assert.equal(hint.cache, 'hit');
    assert.deepEqual(hint.body, { v: 'newer' });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an older in-flight 404 does not remove a newer stored entry', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  const clock = () => now;
  try {
    const result = readThrough(
      paths,
      () => {
        now += 10;
        readThrough(paths, okBody({ v: 2 }), {
          mode: 'strict-fresh',
          now: clock,
        });
        now += 10;
        return { status: 404, body: null };
      },
      { now: clock },
    );
    assert.equal(result.status, 404);
    const hint = readThrough(paths, okBody({ v: 3 }), { now: clock });
    assert.equal(hint.cache, 'hit');
    assert.deepEqual(hint.body, { v: 2 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('strict-fresh bypasses a stored response', () => {
  const paths = tempRoot();
  let fetches = 0;
  const fetch = () => {
    fetches += 1;
    return { status: 200, body: { fetches } };
  };
  try {
    readThrough(paths, fetch);
    const fresh = readThrough(paths, fetch, { mode: 'strict-fresh' });
    assert.equal(fetches, 2);
    assert.deepEqual(fresh.body, { fetches: 2 });
    assert.equal(fresh.cache, 'miss');
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a fetch failure is not stored and releases the lease', () => {
  const paths = tempRoot();
  try {
    assert.throws(
      () =>
        readThrough(paths, () => {
          throw new Error('transport down');
        }),
      /transport down/,
    );
    const leases = join(paths.cacheDir, 'leases');
    const names = existsSync(leases) ? readdirSync(leases) : [];
    assert.deepEqual(names, []);
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a failed replacement leaves the previous complete entry in place', () => {
  const paths = tempRoot();
  let step = 0;
  const fetch = () => {
    step += 1;
    if (step === 1) return { status: 200, body: { v: 'a' } };
    throw new Error('later failure');
  };
  try {
    const first = readThrough(paths, fetch);
    assert.throws(
      () => readThrough(paths, fetch, { mode: 'strict-fresh' }),
      /later failure/,
    );
    assert.deepEqual(readEntry(paths.cacheDir, String(first.entryId)), {
      schemaVersion: 1,
      storedAt: JSON.parse(
        readFileSync(
          join(paths.cacheDir, 'entries', `${first.entryId}.json`),
          'utf8',
        ),
      ).storedAt,
      startedAt: JSON.parse(
        readFileSync(
          join(paths.cacheDir, 'entries', `${first.entryId}.json`),
          'utf8',
        ),
      ).startedAt,
      status: 200,
      body: { v: 'a' },
      complete: true,
    });
    const replaced = readThrough(
      paths,
      () => ({
        status: 200,
        body: { v: 'b' },
      }),
      { mode: 'strict-fresh' },
    );
    const parsed = readEntry(paths.cacheDir, String(replaced.entryId)) as {
      body: { v: string };
    };
    assert.deepEqual(parsed.body, { v: 'b' });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a crash before atomic replacement keeps the previous entry', () => {
  const paths = tempRoot();
  try {
    const first = readThrough(paths, okBody({ v: 'a' }));
    const file = join(paths.cacheDir, 'entries', `${first.entryId}.json`);
    const before = readFileSync(file, 'utf8');
    const result = readThrough(paths, okBody({ v: 'b' }), {
      mode: 'strict-fresh',
      storage: {
        writeAtomic() {
          throw Object.assign(new Error('crash before rename'), {
            code: 'EIO',
          });
        },
      },
    });
    assert.deepEqual(result.body, { v: 'b' });
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('orphaned atomic-write temp files are evicted and purged, live writers are not', () => {
  const paths = tempRoot();
  const stem = 'a'.repeat(64);
  const dead = 999_999_001;
  const alive = process.pid;
  const orphan = `${stem}.json.${dead}.0123456789ab.tmp`;
  const inFlight = `${stem}.json.${alive}.ba9876543210.tmp`;
  const isPidAlive = (pid: number) => pid === alive;
  try {
    readThrough(paths, okBody({ seed: true }), { isPidAlive });
    const entries = join(paths.cacheDir, 'entries');
    writeFileSync(join(entries, orphan), 'x'.repeat(2_000), { mode: 0o600 });
    writeFileSync(join(entries, inFlight), 'y', { mode: 0o600 });
    // A later publish runs eviction, which sweeps the crashed writer's file.
    readThrough(paths, okBody({ other: true }), {
      requestShape: { path: '/other' },
      isPidAlive,
    });
    assert.equal(existsSync(join(entries, orphan)), false);
    assert.equal(existsSync(join(entries, inFlight)), true);

    writeFileSync(join(entries, orphan), 'x'.repeat(2_000), { mode: 0o600 });
    const purged = readThrough(paths, okBody(null), {
      operation: 'purge',
      isPidAlive,
    });
    assert.equal(purged.cache, 'purged');
    assert.equal(purged.removed, 3);
    assert.deepEqual(readdirSync(entries), [inFlight]);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('unwritable storage and loose permissions degrade to the live response', () => {
  const paths = tempRoot();
  try {
    const seeded = readThrough(paths, okBody({ cached: true }));
    const loose = readThrough(paths, okBody({ live: true }), {
      storage: {
        lstat: (path: string) => {
          const real = lstatSync(path);
          return {
            isFile: () => real.isFile(),
            isDirectory: () => real.isDirectory(),
            isSymbolicLink: () => real.isSymbolicLink(),
            mode: real.mode | 0o022,
            size: real.size,
          };
        },
      },
    });
    assert.equal(loose.cache, 'degraded');
    assert.deepEqual(loose.body, { live: true });
    assert.notDeepEqual(loose.body, { cached: true });

    const denied = readThrough(paths, okBody({ live: true }), {
      storage: {
        chmod() {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
      },
    });
    assert.equal(denied.cache, 'degraded');
    assert.deepEqual(denied.body, { live: true });

    const unwritable = readThrough(paths, okBody({ wrote: false }), {
      storage: {
        writeAtomic() {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      },
      requestShape: { path: '/unwritable' },
    });
    assert.deepEqual(unwritable.body, { wrote: false });
    assert.equal(
      existsSync(join(paths.cacheDir, 'entries', `${unwritable.entryId}.json`)),
      false,
    );
    assert.ok(seeded.entryId);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a symlinked entry is not followed', () => {
  const paths = tempRoot();
  const outside = join(paths.workspace, 'outside.json');
  writeFileSync(outside, '{"evil":true}\n');
  try {
    const first = readThrough(paths, okBody({ ok: 1 }));
    const link = join(paths.cacheDir, 'entries', `${first.entryId}.json`);
    unlinkSync(link);
    symlinkSync(outside, link);
    const second = readThrough(paths, okBody({ ok: 2 }));
    assert.deepEqual(second.body, { ok: 2 });
    assert.equal(readFileSync(outside, 'utf8'), '{"evil":true}\n');
    assert.equal(lstatSync(link).isSymbolicLink(), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('purge removes only regular entry files and refuses unsafe roots', () => {
  const paths = tempRoot();
  const outside = join(paths.workspace, 'outside.json');
  writeFileSync(outside, 'keep-outside');
  try {
    const stored = readThrough(paths, okBody({ ok: true }));
    writeFileSync(join(paths.cacheDir, 'entries', 'notes.txt'), 'keep');
    const symlinkName = `${'ab'.repeat(32)}.json`;
    symlinkSync(outside, join(paths.cacheDir, 'entries', symlinkName));
    const purged = readThrough(paths, okBody({ unused: true }), {
      operation: 'purge',
    });
    assert.equal(purged.cache, 'purged');
    assert.equal(purged.removed, 1);
    assert.equal(
      existsSync(join(paths.cacheDir, 'entries', `${stored.entryId}.json`)),
      false,
    );
    assert.equal(
      readFileSync(join(paths.cacheDir, 'entries', 'notes.txt'), 'utf8'),
      'keep',
    );
    assert.equal(readFileSync(outside, 'utf8'), 'keep-outside');
    assert.equal(
      existsSync(join(paths.cacheDir, 'entries', symlinkName)),
      true,
    );

    const parent = mkdtempSync(join(tmpdir(), 'idd-read-cache-parent-'));
    const workspace = join(parent, 'repo');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'important.txt'), 'keep');
    mkdirSync(join(parent, 'entries'));
    writeFileSync(join(parent, MARKER), 'marker\n');
    const decoy = `${'cd'.repeat(32)}.json`;
    writeFileSync(join(parent, 'entries', decoy), '{"decoy":true}');
    const refused = readThroughGithubApiCache({
      classification: 'read',
      operation: 'purge',
      policy: policy(parent),
      host: 'github.com',
      repository: 'o/r',
      credentialMaterial: 'credential-material-token',
      requestShape: { path: '/repos/o/r' },
      workspaceRoot: workspace,
      cwd: workspace,
      fetch: () => ({ status: 200, body: {} }),
    });
    assert.equal(refused.cache, 'refused');
    assert.equal(refused.removed, 0);
    assert.equal(
      readFileSync(join(workspace, 'important.txt'), 'utf8'),
      'keep',
    );
    assert.equal(
      readFileSync(join(parent, 'entries', decoy), 'utf8'),
      '{"decoy":true}',
    );

    const missingMarker = mkdtempSync(
      join(tmpdir(), 'idd-read-cache-missing-marker-'),
    );
    mkdirSync(join(missingMarker, 'entries'));
    const orphan = `${'ef'.repeat(32)}.json`;
    writeFileSync(join(missingMarker, 'entries', orphan), '{"orphan":true}');
    const unmarked = readThroughGithubApiCache({
      classification: 'read',
      operation: 'purge',
      policy: policy(missingMarker),
      host: 'github.com',
      repository: 'o/r',
      credentialMaterial: 'credential-material-token',
      requestShape: { path: '/repos/o/r' },
      workspaceRoot: paths.workspace,
      cwd: paths.workspace,
      fetch: () => ({ status: 200, body: {} }),
    });
    assert.equal(unmarked.cache, 'refused');
    assert.equal(
      readFileSync(join(missingMarker, 'entries', orphan), 'utf8'),
      '{"orphan":true}',
    );

    const rooted = readThroughGithubApiCache({
      classification: 'read',
      operation: 'purge',
      policy: policy('/'),
      host: 'github.com',
      repository: 'o/r',
      credentialMaterial: 'credential-material-token',
      requestShape: { path: '/repos/o/r' },
      workspaceRoot: paths.workspace,
      cwd: paths.workspace,
      fetch: () => ({ status: 200, body: {} }),
    });
    assert.equal(rooted.cache, 'refused');
    assert.equal(rooted.fetched, false);

    rmSync(parent, { recursive: true, force: true });
    rmSync(missingMarker, { recursive: true, force: true });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('purge without an override targets the default directory, never a fallback for a refused one', () => {
  const paths = tempRoot();
  const fallback = join(paths.root, 'default');
  mkdirSync(fallback);
  try {
    const read = readThrough(paths, okBody({ ok: true }), {
      policy: policy(''),
      defaultDirectory: fallback,
    });
    assert.equal(read.cache, 'miss');
    assert.equal(entryNames(fallback).length, 1);
    const purged = readThrough(paths, okBody(null), {
      operation: 'purge',
      policy: policy(''),
      defaultDirectory: fallback,
    });
    assert.equal(purged.cache, 'purged');
    assert.equal(purged.removed, 1);
    assert.deepEqual(entryNames(fallback), []);

    readThrough(paths, okBody({ ok: true }), {
      policy: policy(''),
      defaultDirectory: fallback,
    });
    // An explicit override that is refused purges nothing and does not
    // fall back to the default directory.
    const refused = readThrough(paths, okBody(null), {
      operation: 'purge',
      policy: policy(paths.workspace),
      defaultDirectory: fallback,
    });
    assert.equal(refused.cache, 'refused');
    assert.equal(entryNames(fallback).length, 1);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an unsafe directory override falls back instead of writing the workspace', () => {
  const paths = tempRoot();
  const fallback = join(paths.root, 'fallback');
  mkdirSync(fallback);
  writeFileSync(join(paths.workspace, 'important.txt'), 'keep');
  try {
    const result = readThrough(paths, okBody({ ok: true }), {
      policy: policy(paths.workspace),
      defaultDirectory: fallback,
    });
    assert.equal(result.cache, 'miss');
    assert.equal(existsSync(join(paths.workspace, MARKER)), false);
    assert.equal(
      existsSync(join(fallback, 'entries', `${result.entryId}.json`)),
      true,
    );
    assert.equal(
      readFileSync(join(paths.workspace, 'important.txt'), 'utf8'),
      'keep',
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a dot-dot after a symlink is judged where the OS resolves it', {
  skip: process.platform === 'win32',
}, () => {
  const paths = tempRoot();
  const wsParent = join(paths.root, 'ws-parent');
  const repo = join(wsParent, 'repo');
  mkdirSync(repo, { recursive: true });
  chmodSync(wsParent, 0o755);
  const other = join(paths.root, 'other');
  mkdirSync(other);
  symlinkSync(repo, join(other, 'link'));
  const fallback = join(paths.root, 'fallback');
  mkdirSync(fallback);
  try {
    // Lexically this is `other`; physically `link/..` is the workspace's
    // ancestor `ws-parent`, which must never be chmod'ed or adopted.
    const result = readThrough(
      { cacheDir: fallback, workspace: repo },
      okBody({ ok: true }),
      {
        policy: policy(`${join(other, 'link')}${sep}..`),
        defaultDirectory: fallback,
      },
    );
    // `other` holds only the symlink, so it is a foreign directory and
    // the read degrades to a live fetch instead of adopting it.
    assert.equal(result.cache, 'degraded');
    assert.equal(statSync(wsParent).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(wsParent), ['repo']);
    assert.deepEqual(readdirSync(other), ['link']);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('losing the cold marker race still contends for the lease', () => {
  const paths = tempRoot();
  let fetches = 0;
  let lostRace = false;
  try {
    const result = readThrough(
      paths,
      () => {
        fetches += 1;
        return { status: 200, body: { ok: true } };
      },
      {
        storage: {
          writeExclusive(path: string, data: string): void {
            if (path.endsWith(MARKER) && !lostRace) {
              lostRace = true;
              // Another cold process wins the marker between lstat and wx.
              writeFileSync(path, 'idd-github-api-read-cache\n', {
                mode: 0o600,
              });
            }
            writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
          },
        },
      },
    );
    assert.equal(lostRace, true);
    assert.equal(result.cache, 'miss');
    assert.equal(fetches, 1);
    assert.equal(entryNames(paths.cacheDir).length, 1);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a non-empty foreign directory is not adopted or chmod-ed', {
  skip: process.platform === 'win32',
}, () => {
  const paths = tempRoot();
  const foreign = join(paths.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'user-file.txt'), 'keep');
  chmodSync(foreign, 0o755);
  let fetches = 0;
  try {
    const result = readThrough(
      paths,
      () => {
        fetches += 1;
        return { status: 200, body: { ok: true } };
      },
      { policy: policy(foreign) },
    );
    assert.equal(result.cache, 'degraded');
    assert.equal(fetches, 1);
    assert.equal(statSync(foreign).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(foreign), ['user-file.txt']);
    // An empty directory and this cache's own layout stay adoptable.
    const first = readThrough(paths, okBody({ ok: 1 }));
    assert.equal(first.cache, 'miss');
    const again = readThrough(paths, okBody({ ok: 2 }));
    assert.equal(again.cache, 'hit');
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a component a concurrent cold start creates is retried, not treated as dangling', () => {
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const target = resolve(sep, 'cache-root', 'new-cache');
  let realpathCalls = 0;
  // The first realpath misses, then a peer creates the directory before
  // the lstat: a real directory, so the second realpath succeeds.
  const raced = resolveCanonicalPath(target, {
    realpathSync(path: string): string {
      realpathCalls += 1;
      if (realpathCalls === 1) throw enoent();
      return path;
    },
    lstatSync: () => ({ isSymbolicLink: () => false }),
  });
  assert.equal(raced, target);
  assert.equal(realpathCalls, 2);
  // A component that exists as a symlink but does not resolve is dangling.
  assert.equal(
    resolveCanonicalPath(target, {
      realpathSync(): string {
        throw enoent();
      },
      lstatSync: () => ({ isSymbolicLink: () => true }),
    }),
    null,
  );
  // A create/delete loop cannot spin forever.
  let spins = 0;
  assert.equal(
    resolveCanonicalPath(target, {
      realpathSync(): string {
        spins += 1;
        throw enoent();
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
    }),
    null,
  );
  assert.ok(spins > 1 && spins < 32);
  // A genuinely missing suffix is appended to the nearest existing ancestor.
  const existingRoot = resolve(sep, 'exists');
  assert.equal(
    resolveCanonicalPath(join(existingRoot, 'a', 'b'), {
      realpathSync(path: string): string {
        if (path === existingRoot) return existingRoot;
        throw enoent();
      },
      lstatSync(): never {
        throw enoent();
      },
    }),
    join(existingRoot, 'a', 'b'),
  );
});

test('a cache path under a dangling symlink is unsafe, not followed', {
  skip: process.platform === 'win32',
}, () => {
  const paths = tempRoot();
  const nowhere = join(paths.root, 'nowhere');
  symlinkSync(nowhere, join(paths.root, 'dangling'));
  const fallback = join(paths.root, 'fallback');
  mkdirSync(fallback);
  try {
    const result = readThrough(paths, okBody({ ok: true }), {
      policy: policy(join(paths.root, 'dangling', 'cache')),
      defaultDirectory: fallback,
    });
    assert.equal(result.cache, 'miss');
    assert.equal(existsSync(nowhere), false);
    assert.equal(
      existsSync(join(fallback, 'entries', `${result.entryId}.json`)),
      true,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('the default directory follows the OS cache home', () => {
  const paths = tempRoot();
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CACHE_HOME;
  const previousLocal = process.env.LOCALAPPDATA;
  const home = join(paths.root, 'home');
  mkdirSync(home);
  let expected: string;
  if (process.platform === 'win32') {
    process.env.LOCALAPPDATA = join(paths.root, 'local');
    expected = join(paths.root, 'local', 'idd-skill', 'github-api-read-cache');
  } else if (process.platform === 'darwin') {
    process.env.HOME = home;
    expected = join(
      home,
      'Library',
      'Caches',
      'idd-skill',
      'github-api-read-cache',
    );
  } else {
    process.env.XDG_CACHE_HOME = join(paths.root, 'xdg');
    expected = join(paths.root, 'xdg', 'idd-skill', 'github-api-read-cache');
  }
  try {
    const result = readThrough(paths, okBody({ os: true }), {
      policy: {
        enabled: true,
        maxAgeMs: 300_000,
        maxBytes: 104857600,
        retentionMs: 86_400_000,
      },
    });
    assert.equal(
      existsSync(join(expected, 'entries', `${result.entryId}.json`)),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousXdg;
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a dead or future lease is recovered without waiting out the ttl', async () => {
  const paths = tempRoot();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  try {
    const first = readThrough(paths, okBody({ n: 1 }));
    unlinkSync(join(paths.cacheDir, 'entries', `${first.entryId}.json`));
    const lease = join(paths.cacheDir, 'leases', `${first.entryId}.json`);
    writeFileSync(
      lease,
      JSON.stringify({ pid: deadPid, createdAt: Date.now(), mode: 'hint' }),
    );
    const started = Date.now();
    const recovered = readThrough(paths, okBody({ n: 2 }));
    assert.ok(Date.now() - started < 500);
    assert.equal(recovered.fetched, true);
    assert.deepEqual(recovered.body, { n: 2 });

    unlinkSync(join(paths.cacheDir, 'entries', `${first.entryId}.json`));
    writeFileSync(
      lease,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() + 60_000,
        mode: 'hint',
      }),
    );
    const futureStarted = Date.now();
    const future = readThrough(paths, okBody({ n: 3 }));
    assert.ok(Date.now() - futureStarted < 500);
    assert.deepEqual(future.body, { n: 3 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('strict-fresh does not wait on a live hint lease', async () => {
  const paths = tempRoot();
  const sleeper = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  try {
    const first = readThrough(paths, okBody({ cached: true }));
    unlinkSync(join(paths.cacheDir, 'entries', `${first.entryId}.json`));
    writeFileSync(
      join(paths.cacheDir, 'leases', `${first.entryId}.json`),
      JSON.stringify({ pid: sleeper.pid, createdAt: Date.now(), mode: 'hint' }),
    );
    const started = Date.now();
    const result = readThrough(paths, okBody({ live: true }), {
      mode: 'strict-fresh',
      leaseTtlMs: 5_000,
    });
    assert.ok(Date.now() - started < 400);
    assert.deepEqual(result.body, { live: true });
  } finally {
    sleeper.kill();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('hint waits out a live foreign lease before fetching', async () => {
  const paths = tempRoot();
  const sleeper = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  try {
    const first = readThrough(paths, okBody({ cached: true }));
    unlinkSync(join(paths.cacheDir, 'entries', `${first.entryId}.json`));
    writeFileSync(
      join(paths.cacheDir, 'leases', `${first.entryId}.json`),
      JSON.stringify({ pid: sleeper.pid, createdAt: Date.now(), mode: 'hint' }),
    );
    const started = Date.now();
    const result = readThrough(paths, okBody({ after: true }), {
      leaseTtlMs: 500,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 450, `elapsed ${elapsed}`);
    assert.deepEqual(result.body, { after: true });
  } finally {
    sleeper.kill();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('two processes coalesce a cold hint read onto one fetch', async () => {
  const paths = tempRoot();
  const leaderCount = join(paths.root, 'leader-count');
  const followerCount = join(paths.root, 'follower-count');
  const release = join(paths.root, 'release');
  const leaderBoot = join(paths.root, 'leader-boot');
  const followerBoot = join(paths.root, 'follower-boot');
  const leaderStarted = join(paths.root, 'leader-started');
  const flags = process.execArgv.filter(
    (arg) => arg !== '--test' && !arg.startsWith('--test-'),
  );
  function start(role: 'leader' | 'follower') {
    const boot = role === 'leader' ? leaderBoot : followerBoot;
    const count = role === 'leader' ? leaderCount : followerCount;
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [...flags, WORKER], {
      env: {
        ...process.env,
        IDD_CACHE_ROLE: role,
        IDD_CACHE_DIR: paths.cacheDir,
        IDD_CACHE_WORKSPACE: paths.workspace,
        IDD_CACHE_BOOTED: boot,
        IDD_CACHE_STARTED: leaderStarted,
        IDD_CACHE_RELEASE: release,
        IDD_CACHE_COUNT: count,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? -1));
    });
    return {
      child,
      exited,
      output: () => ({ stdout, stderr }),
    };
  }
  async function waitFor(path: string): Promise<void> {
    const started = Date.now();
    while (!existsSync(path)) {
      if (Date.now() - started > 5_000) {
        throw new Error(`timed out waiting for ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const leader = start('leader');
  try {
    await waitFor(leaderStarted);
    const follower = start('follower');
    try {
      await waitFor(followerBoot);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(follower.child.exitCode, null);
      assert.equal(existsSync(followerCount), false);
      writeFileSync(release, '1');
      assert.equal(await leader.exited, 0, leader.output().stderr);
      assert.equal(await follower.exited, 0, follower.output().stderr);
      assert.equal(existsSync(followerCount), false);
      assert.equal(readFileSync(leaderCount, 'utf8'), '1');
      const leaderBody = JSON.parse(leader.output().stdout) as {
        body: unknown;
      };
      const followerBody = JSON.parse(follower.output().stdout) as {
        body: unknown;
      };
      assert.deepEqual(leaderBody.body, { source: 'leader' });
      assert.deepEqual(followerBody.body, leaderBody.body);
    } finally {
      if (follower.child.exitCode === null) follower.child.kill();
    }
  } finally {
    if (leader.child.exitCode === null) leader.child.kill();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('strict-fresh treats a 304 as one unpersisted miss', () => {
  const paths = tempRoot();
  let calls = 0;
  try {
    const result = readThrough(
      paths,
      () => {
        calls += 1;
        return { status: 304, body: null };
      },
      { mode: 'strict-fresh' },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 304);
    assert.equal(result.cache, 'miss');
    assert.deepEqual(entryNames(paths.cacheDir), []);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a loose rewritten base is not returned or kept', () => {
  const paths = tempRoot();
  let step = 0;
  try {
    readThrough(paths, () => ({ status: 200, body: { v: 1 }, etag: '"v1"' }));
    let loosen = false;
    const result = readThrough(
      paths,
      () => {
        step += 1;
        if (step === 1) return { status: 304, body: null, etag: '"v1"' };
        return { status: 200, body: { v: 2 }, etag: '"v2"' };
      },
      {
        mode: 'conditional',
        storage: {
          writeAtomic(destination: string, data: string) {
            writeFileSync(destination, data, { mode: 0o600 });
            loosen = true;
          },
          lstat(path: string) {
            const real = lstatSync(path);
            const loose =
              loosen && real.isFile() && path.includes(`${sep}entries${sep}`);
            return {
              isFile: () => real.isFile(),
              isDirectory: () => real.isDirectory(),
              isSymbolicLink: () => real.isSymbolicLink(),
              mode: loose ? real.mode | 0o044 : real.mode,
              size: real.size,
            };
          },
        },
      },
    );
    assert.deepEqual(result.body, { v: 2 });
    assert.equal(result.cache, 'degraded');
    for (const name of entryNames(paths.cacheDir)) {
      const mode = lstatSync(join(paths.cacheDir, 'entries', name)).mode;
      assert.equal(mode & 0o077, 0);
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('releasing a lease leaves a successor lease in place', () => {
  const paths = tempRoot();
  try {
    readThrough(paths, () => {
      const leases = join(paths.cacheDir, 'leases');
      const names = readdirSync(leases);
      const lease = join(leases, names[0] ?? '');
      writeFileSync(
        lease,
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          token: 'successor-token',
          mode: 'hint',
        }),
      );
      return { status: 200, body: { ok: true } };
    });
    const names = readdirSync(join(paths.cacheDir, 'leases'));
    assert.deepEqual(names.length, 1);
    assert.match(
      readFileSync(join(paths.cacheDir, 'leases', names[0] ?? ''), 'utf8'),
      /successor-token/,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('a transient entry read does not delete the stored body', () => {
  const paths = tempRoot();
  let now = 1_000_000;
  let entryReads = 0;
  try {
    const first = readThrough(paths, okBody({ v: 'kept' }), {
      now: () => now,
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000 }),
    });
    const file = join(paths.cacheDir, 'entries', `${first.entryId}.json`);
    const before = readFileSync(file, 'utf8');
    now += 1_001;
    const result = readThrough(paths, okBody({ v: 'live' }), {
      now: () => now,
      policy: policy(paths.cacheDir, { maxAgeMs: 1_000 }),
      storage: {
        readFile(path: string) {
          const text = readFileSync(path, 'utf8');
          if (path.includes(`${sep}entries${sep}`)) {
            entryReads += 1;
            if (entryReads >= 3) {
              throw Object.assign(new Error('transient read'), { code: 'EIO' });
            }
          }
          return text;
        },
      },
    });
    assert.deepEqual(result.body, { v: 'live' });
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('purge refuses a symlinked cache root', () => {
  const paths = tempRoot();
  const real = mkdtempSync(join(tmpdir(), 'idd-read-cache-real-'));
  const link = join(paths.root, 'cache-link');
  try {
    mkdirSync(join(real, 'entries'));
    writeFileSync(join(real, MARKER), 'idd-github-api-read-cache\n');
    const name = `${'ab'.repeat(32)}.json`;
    writeFileSync(join(real, 'entries', name), '{"keep":true}\n');
    symlinkSync(real, link);
    const purged = readThrough(paths, okBody({ unused: true }), {
      operation: 'purge',
      policy: policy(link),
    });
    assert.equal(purged.cache, 'refused');
    assert.equal(purged.removed, 0);
    assert.equal(
      readFileSync(join(real, 'entries', name), 'utf8'),
      '{"keep":true}\n',
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

function readThroughAsync(
  paths: { cacheDir: string; workspace: string },
  fetch: ReadThroughGithubApiCacheAsyncInput['fetch'],
  overrides: Partial<ReadThroughGithubApiCacheAsyncInput> = {},
) {
  return readThroughGithubApiCacheAsync({
    classification: 'read',
    policy: policy(paths.cacheDir),
    host: 'github.com',
    repository: 'o/r',
    credentialMaterial: 'credential-material-token',
    requestShape: { unit: 'async-report' },
    workspaceRoot: paths.workspace,
    cwd: paths.workspace,
    fetch,
    ...overrides,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolvePromise = done;
    rejectPromise = fail;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function leaseNames(cacheDir: string): string[] {
  const leases = join(cacheDir, 'leases');
  return existsSync(leases) ? readdirSync(leases) : [];
}

test('an async hint read stores a report and the next read is a hit', async () => {
  const paths = tempRoot();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 200, body: { report: 'r' } };
  };
  try {
    const first = await readThroughAsync(paths, fetch);
    const second = await readThroughAsync(paths, fetch);
    assert.equal(calls, 1);
    assert.equal(first.cache, 'miss');
    assert.equal(second.cache, 'hit');
    assert.equal(second.fetched, false);
    assert.equal(second.coalesced, undefined);
    assert.deepEqual(second.body, { report: 'r' });
    assert.equal(leaseNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('two concurrent in-process async reads coalesce onto one fetch', async () => {
  const paths = tempRoot();
  const gate = deferred<GithubApiCacheFetchResult>();
  let calls = 0;
  const fetch = () => {
    calls += 1;
    return gate.promise;
  };
  try {
    const leader = readThroughAsync(paths, fetch);
    const waiter = readThroughAsync(paths, fetch);
    // The leader holds the lease before its first await, so the waiter
    // cannot also lead.
    assert.equal(leaseNames(paths.cacheDir).length, 1);
    gate.resolve({ status: 200, body: { report: 'shared' } });
    const [led, waited] = await Promise.all([leader, waiter]);
    assert.equal(calls, 1);
    assert.equal(led.cache, 'miss');
    assert.equal(waited.cache, 'hit');
    // Only the waiter is served a peer's just-finished computation.
    assert.equal(waited.coalesced, true);
    assert.equal(led.coalesced, undefined);
    assert.deepEqual(waited.body, { report: 'shared' });
    assert.equal(leaseNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async waiter never steals a lease from a live leader', async () => {
  const paths = tempRoot();
  const gate = deferred<GithubApiCacheFetchResult>();
  let leaderCalls = 0;
  let waiterCalls = 0;
  try {
    const leader = readThroughAsync(paths, () => {
      leaderCalls += 1;
      return gate.promise;
    });
    const waited = await readThroughAsync(
      paths,
      async () => {
        waiterCalls += 1;
        return { status: 200, body: { report: 'own' } };
      },
      { leaseMaxWaitMs: 60 },
    );
    assert.equal(waited.cache, 'degraded');
    assert.equal(waiterCalls, 1);
    assert.equal(leaseNames(paths.cacheDir).length, 1);
    gate.resolve({ status: 200, body: { report: 'lead' } });
    const led = await leader;
    assert.equal(led.cache, 'miss');
    assert.equal(leaderCalls, 1);
    assert.equal(leaseNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async read takes over a lease whose leader died', async () => {
  const paths = tempRoot();
  try {
    const seeded = await readThroughAsync(
      paths,
      async () => ({ status: 200, body: { report: 'old' } }),
      { mode: 'strict-fresh' },
    );
    const entry = join(paths.cacheDir, 'entries', `${seeded.entryId}.json`);
    unlinkSync(entry);
    writeFileSync(
      join(paths.cacheDir, 'leases', `${seeded.entryId}.json`),
      JSON.stringify({ pid: 999_999, createdAt: Date.now(), token: 'dead' }),
      { mode: 0o600 },
    );
    let calls = 0;
    const taken = await readThroughAsync(
      paths,
      async () => {
        calls += 1;
        return { status: 200, body: { report: 'new' } };
      },
      { isPidAlive: (pid) => pid !== 999_999 },
    );
    assert.equal(calls, 1);
    assert.equal(taken.cache, 'miss');
    assert.deepEqual(taken.body, { report: 'new' });
    assert.equal(leaseNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async strict-fresh read always fetches and refreshes the entry', async () => {
  const paths = tempRoot();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 200, body: { n: calls } };
  };
  try {
    await readThroughAsync(paths, fetch);
    const fresh = await readThroughAsync(paths, fetch, {
      mode: 'strict-fresh',
    });
    assert.equal(calls, 2);
    assert.equal(fresh.cache, 'miss');
    const hit = await readThroughAsync(paths, fetch);
    assert.equal(hit.cache, 'hit');
    assert.deepEqual(hit.body, { n: 2 });
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async incomplete or oversized result is returned but never stored', async () => {
  const paths = tempRoot();
  let calls = 0;
  try {
    const incomplete = () => async () => {
      calls += 1;
      return { status: 200, body: { part: true }, incomplete: true };
    };
    await readThroughAsync(paths, incomplete());
    await readThroughAsync(paths, incomplete());
    assert.equal(calls, 2);
    assert.equal(entryNames(paths.cacheDir).length, 0);

    const oversize = await readThroughAsync(
      paths,
      async () => ({ status: 200, body: { blob: 'x'.repeat(4096) } }),
      { policy: policy(paths.cacheDir, { maxBytes: 512 }) },
    );
    assert.equal(oversize.cache, 'miss');
    assert.equal(entryNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async fetch failure propagates, is not stored, and frees the lease', async () => {
  const paths = tempRoot();
  try {
    await assert.rejects(
      readThroughAsync(paths, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(leaseNames(paths.cacheDir).length, 0);
    assert.equal(entryNames(paths.cacheDir).length, 0);
    const recovered = await readThroughAsync(paths, async () => ({
      status: 200,
      body: { ok: true },
    }));
    assert.equal(recovered.cache, 'miss');
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async read bypasses a disabled policy and a blank credential', async () => {
  const paths = tempRoot();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { status: 200, body: { n: calls } };
  };
  try {
    const disabled = await readThroughAsync(paths, fetch, {
      policy: policy(paths.cacheDir, { enabled: false }),
    });
    const blank = await readThroughAsync(paths, fetch, {
      credentialMaterial: '  ',
    });
    assert.equal(disabled.cache, 'bypass');
    assert.equal(blank.cache, 'bypass');
    assert.equal(calls, 2);
    assert.equal(entryNames(paths.cacheDir).length, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('an async hint ages from the start of its fetch, the sync read from its storage', async () => {
  const paths = tempRoot();
  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  try {
    // The fetch itself takes 100 s, so the record is stored at t+100 s.
    await readThroughAsync(
      paths,
      async () => {
        clock.now += 100_000;
        return { status: 200, body: { report: 'slow' } };
      },
      { now },
    );
    // 250 s after storage but 350 s after the fetch began; maxAge is 300 s.
    clock.now += 250_000;
    let calls = 0;
    const again = await readThroughAsync(
      paths,
      async () => {
        calls += 1;
        return { status: 200, body: { report: 'fresh' } };
      },
      { now },
    );
    assert.equal(calls, 1);
    assert.equal(again.cache, 'miss');
    // The sync path still measures from storage: its own record is fresh.
    const syncPaths = tempRoot();
    try {
      readThrough(
        syncPaths,
        () => {
          clock.now += 100_000;
          return { status: 200, body: { n: 1 } };
        },
        { now },
      );
      clock.now += 250_000;
      const hit = readThrough(
        syncPaths,
        () => ({ status: 200, body: { n: 2 } }),
        { now },
      );
      assert.equal(hit.cache, 'hit');
    } finally {
      rmSync(syncPaths.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

/**
 * A leader whose fetch outlives the stale threshold, and a second caller that
 * arrives once that threshold has passed since the lease was created. The
 * clock, the poll sleep, and the heartbeat are all injected, so the timeline
 * is exact.
 */
async function longLeaderScenario(renew: boolean) {
  const paths = tempRoot();
  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  const gate = deferred<GithubApiCacheFetchResult>();
  let heartbeat: (() => void) | null = null;
  let stopped = 0;
  try {
    const leader = readThroughAsync(paths, () => gate.promise, {
      now,
      leaseTtlMs: 1_000,
      startLeaseHeartbeat: (fn) => {
        heartbeat = fn;
        return () => {
          stopped += 1;
        };
      },
    });
    clock.now += 800;
    if (renew) (heartbeat as (() => void) | null)?.();
    clock.now += 800;
    let waiterCalls = 0;
    const waiter = await readThroughAsync(
      paths,
      async () => {
        waiterCalls += 1;
        return { status: 200, body: { report: 'waiter' } };
      },
      {
        now,
        leaseTtlMs: 1_000,
        leaseMaxWaitMs: 100,
        sleep: async (ms) => {
          clock.now += ms;
        },
        startLeaseHeartbeat: () => () => {},
      },
    );
    const leaseStillHeld =
      leaseNames(paths.cacheDir).filter((name) => name.endsWith('.json'))
        .length === 1;
    gate.resolve({ status: 200, body: { report: 'leader' } });
    await leader;
    return { waiter, waiterCalls, leaseStillHeld, stopped };
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

test('a live async leader renews its lease and is not stolen from past the stale threshold', async () => {
  const kept = await longLeaderScenario(true);
  assert.equal(kept.waiter.cache, 'degraded');
  assert.equal(kept.waiterCalls, 1);
  assert.equal(kept.leaseStillHeld, true);
  assert.equal(kept.stopped, 1);
});

test('without a heartbeat the same async lease ages out and is taken over', async () => {
  const stolen = await longLeaderScenario(false);
  assert.equal(stolen.waiter.cache, 'miss');
  assert.equal(stolen.waiterCalls, 1);
});

test("a stale leader's heartbeat never overwrites a lease taken over since", async () => {
  const paths = tempRoot();
  const gate = deferred<GithubApiCacheFetchResult>();
  let heartbeat: (() => void) | null = null;
  try {
    const leader = readThroughAsync(paths, () => gate.promise, {
      startLeaseHeartbeat: (fn) => {
        heartbeat = fn;
        return () => {};
      },
    });
    const leases = join(paths.cacheDir, 'leases');
    const leaseFile = readdirSync(leases).find((name) =>
      name.endsWith('.json'),
    ) as string;
    // A waiter judged the leader dead and took the lease over.
    const takeover = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      mode: 'hint',
      token: 'takeover-token',
    });
    writeFileSync(join(leases, leaseFile), takeover, { mode: 0o600 });
    // The old leader's heartbeat fires late.
    (heartbeat as (() => void) | null)?.();
    assert.equal(readFileSync(join(leases, leaseFile), 'utf8'), takeover);
    assert.equal(
      readdirSync(leases).filter((name) => name.endsWith('.hb')).length,
      1,
    );
    gate.resolve({ status: 200, body: { report: 'late' } });
    await leader;
    // Releasing removes the old leader's own heartbeat and leaves the new
    // leader's lease alone.
    assert.equal(readFileSync(join(leases, leaseFile), 'utf8'), takeover);
    assert.equal(
      readdirSync(leases).filter((name) => name.endsWith('.hb')).length,
      0,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
