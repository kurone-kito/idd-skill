import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  checkPreservationParents,
  createPreserveDestination,
  ensurePrivateStateDirectory,
  inspectDirectoryPrivacy,
  inspectPreserveDestination,
  isWithinRoot,
  type PreserveDirectoryName,
  type PreserveGuardDeps,
} from '../src/scripts/preserve-destination.mts';

// The guards check owner, mode, and symlinks, so they run on POSIX only. The
// Windows ACL branch has its own tests in windows-acl.test.mts.
const POSIX = process.platform !== 'win32';
const DIRECTORY_NAMES: readonly PreserveDirectoryName[] = [
  'f4-preserved',
  'lwr-preserved',
  'b1-preserved',
];
const ISSUE = 4957;
const NOW = new Date('2026-11-03T04:00:00.000Z');
const TIMESTAMP = '20261103T040000Z';

const noAcl = (): never => {
  throw new Error('the ACL reader is not used on POSIX');
};

const realPrivacy = (path: string) =>
  inspectDirectoryPrivacy(path, 'linux', noAcl);

const realLstat = (path: string) => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink' as const;
    if (stat.isDirectory()) return 'directory' as const;
    if (stat.isFile()) return 'file' as const;
    return 'other' as const;
  } catch {
    return 'absent' as const;
  }
};

const realIdentity = (path: string): string | null => {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
};

const realResolve = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

interface Fixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly primary: string;
  readonly commonDirectory: string;
}

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fresh(): Fixture {
  // Canonical paths, so the realpath comparisons see the same spelling.
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'preserve-destination-')),
  );
  roots.push(root);
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot);
  chmodSync(stateRoot, 0o700);
  const primary = join(root, 'primary');
  mkdirSync(primary);
  const commonDirectory = join(root, 'common');
  mkdirSync(commonDirectory);
  return { root, stateRoot, primary, commonDirectory };
}

function depsFor(
  fixture: Fixture,
  overrides: Partial<PreserveGuardDeps> = {},
): PreserveGuardDeps {
  return {
    lstat: realLstat,
    directoryIdentity: realIdentity,
    realpath: realResolve,
    stateRoot: fixture.stateRoot,
    now: () => NOW,
    inspectDirectoryPrivacy: realPrivacy,
    ensurePrivateDirectory: (path) =>
      ensurePrivateStateDirectory(path, 'linux', noAcl),
    mkdir: (path, mode) => mkdirSync(path, { mode }),
    git: (args) =>
      args[0] === 'rev-parse'
        ? { status: 0, stdout: `${fixture.commonDirectory}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'unexpected git call' },
    ...overrides,
  };
}

function destinationFor(name: PreserveDirectoryName, stateRoot: string) {
  return join(stateRoot, 'idd-skill', name, `${ISSUE}-${TIMESTAMP}`);
}

test('isWithinRoot accepts the root and its children, and refuses escapes', () => {
  assert.equal(isWithinRoot('/a', '/a'), true);
  assert.equal(isWithinRoot('/a', '/a/b/c'), true);
  assert.equal(isWithinRoot('/a', '/ab'), false);
  assert.equal(isWithinRoot('/a', '/a/../b'), false);
});

for (const name of DIRECTORY_NAMES) {
  test(`${name}: a private state root returns a fresh destination`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const result = inspectPreserveDestination(
      depsFor(fx),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.equal(result.hold, null);
    assert.equal(result.destination, destinationFor(name, fx.stateRoot));
    assert.equal(
      statSync(fx.stateRoot).mode & 0o777,
      0o700,
      'inspection does not change a mode',
    );
  });

  test(`${name}: a missing state root is refused and nothing is created`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const missing = join(fx.root, 'missing');
    const result = inspectPreserveDestination(
      depsFor(fx, { stateRoot: missing }),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /state root does not exist/);
    assert.equal(realLstat(missing), 'absent');
  });

  test(`${name}: a state-root symlink to a non-private target is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const open = join(fx.root, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    const link = join(fx.root, 'link-open');
    symlinkSync(open, link);
    const result = inspectPreserveDestination(
      depsFor(fx, { stateRoot: link }),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /state root is not owned and private/);
    assert.equal(
      statSync(open).mode & 0o777,
      0o755,
      'no tightening through the link',
    );
  });

  test(`${name}: a state-root symlink to a private target is accepted`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const link = join(fx.root, 'link-private');
    symlinkSync(fx.stateRoot, link);
    const result = inspectPreserveDestination(
      depsFor(fx, { stateRoot: link }),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.equal(result.hold, null);
    assert.equal(result.destination, destinationFor(name, fx.stateRoot));
  });

  test(`${name}: a non-private owned state root is accepted in a dry run and unchanged`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const loose = join(fx.root, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const result = inspectPreserveDestination(
      depsFor(fx, { stateRoot: loose }),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.equal(result.hold, null);
    assert.equal(statSync(loose).mode & 0o777, 0o755);
  });

  test(`${name}: applying tightens an owned non-private state root to 0700`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const loose = join(fx.root, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    ensurePrivateStateDirectory(loose, 'linux', noAcl);
    assert.equal(statSync(loose).mode & 0o777, 0o700);
  });

  test(`${name}: a symlink below the state root is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const elsewhere = join(fx.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(fx.stateRoot, 'idd-skill'));
    const result = inspectPreserveDestination(
      depsFor(fx),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /is a symlink/);
  });

  test(`${name}: a destination parent that is not owned and private is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const directory = join(fx.stateRoot, 'idd-skill', name);
    mkdirSync(directory, { recursive: true });
    const result = inspectPreserveDestination(
      depsFor(fx, {
        inspectDirectoryPrivacy: (path) =>
          path === directory ? 'unsafe' : realPrivacy(path),
      }),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /is not owned and private/);
  });

  test(`${name}: a destination inside a protected worktree is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const result = inspectPreserveDestination(
      depsFor(fx),
      name,
      ISSUE,
      fx.stateRoot,
      [],
    );
    assert.match(result.hold ?? '', /inside protected worktree/);
  });

  test(`${name}: an existing destination is refused`, { skip: !POSIX }, () => {
    const fx = fresh();
    const destination = destinationFor(name, fx.stateRoot);
    mkdirSync(destination, { recursive: true });
    const result = inspectPreserveDestination(
      depsFor(fx),
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /already exists/);
  });

  test(`${name}: a parent whose identity changed is reported by the recheck`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const deps = depsFor(fx);
    const current = realIdentity(fx.stateRoot);
    assert.notEqual(current, null);
    assert.equal(
      checkPreservationParents(deps, new Map([[fx.stateRoot, current]])),
      null,
    );
    assert.match(
      checkPreservationParents(
        deps,
        new Map([[fx.stateRoot, 'stale-identity']]),
      ) ?? '',
      /changed after inspection/,
    );
  });

  test(`${name}: creation makes a private directory and records its identity`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const deps = depsFor(fx);
    const inspected = inspectPreserveDestination(
      deps,
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.equal(inspected.hold, null);
    const created = createPreserveDestination(
      deps,
      inspected.destination,
      inspected.parents,
    );
    assert.equal(created.hold, null);
    assert.equal(statSync(inspected.destination).mode & 0o777, 0o700);
    const last = created.parents[created.parents.length - 1];
    assert.equal(last?.path, inspected.destination);
    assert.equal(last?.identity, realIdentity(inspected.destination));
  });

  test(`${name}: creation refuses an existing destination and writes nothing`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const deps = depsFor(fx);
    const destination = destinationFor(name, fx.stateRoot);
    mkdirSync(destination, { recursive: true });
    const created = createPreserveDestination(deps, destination, []);
    assert.match(created.hold ?? '', /already exists/);
    assert.equal(realLstat(destination), 'directory');
  });

  test(`${name}: a created directory that fails the privacy check stays and its path is reported`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const destination = destinationFor(name, fx.stateRoot);
    const deps = depsFor(fx, {
      inspectDirectoryPrivacy: (path) =>
        path === destination ? 'tightenable' : realPrivacy(path),
    });
    const inspected = inspectPreserveDestination(
      deps,
      name,
      ISSUE,
      fx.primary,
      [],
    );
    const created = createPreserveDestination(
      deps,
      destination,
      inspected.parents,
    );
    assert.match(created.hold ?? '', /not owned and private/);
    assert.match(
      created.hold ?? '',
      new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(realLstat(destination), 'directory');
  });

  test(`${name}: a created directory without a verified identity is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const destination = destinationFor(name, fx.stateRoot);
    const deps = depsFor(fx, {
      directoryIdentity: (path) =>
        path === destination ? null : realIdentity(path),
    });
    const inspected = inspectPreserveDestination(
      deps,
      name,
      ISSUE,
      fx.primary,
      [],
    );
    const created = createPreserveDestination(
      deps,
      destination,
      inspected.parents,
    );
    assert.match(created.hold ?? '', /no verified directory identity/);
  });

  test(`${name}: creation refuses when a recorded parent changed and creates nothing`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const destination = destinationFor(name, fx.stateRoot);
    const created = createPreserveDestination(depsFor(fx), destination, [
      { path: fx.stateRoot, identity: 'stale-identity' },
    ]);
    assert.match(created.hold ?? '', /changed after inspection/);
    assert.equal(realLstat(destination), 'absent');
  });

  test(`${name}: a destination identity changed before the consumer's recheck is reported`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const deps = depsFor(fx);
    const inspected = inspectPreserveDestination(
      deps,
      name,
      ISSUE,
      fx.primary,
      [],
    );
    const created = createPreserveDestination(
      deps,
      inspected.destination,
      inspected.parents,
    );
    assert.equal(created.hold, null);
    const recorded = new Map(
      created.parents.map(({ path, identity }) => [path, identity]),
    );
    recorded.set(inspected.destination, 'replaced-identity');
    assert.match(
      checkPreservationParents(deps, recorded) ?? '',
      /changed after inspection/,
    );
  });

  test(`${name}: a parent created after inspection is refused as changed`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const deps = depsFor(fx);
    const inspected = inspectPreserveDestination(
      deps,
      name,
      ISSUE,
      fx.primary,
      [],
    );
    assert.equal(inspected.hold, null);
    // Something creates the absent idd-skill/ parent before the creation step.
    // The recheck at the top of the step refuses it as a changed parent.
    mkdirSync(join(fx.stateRoot, 'idd-skill'));
    const created = createPreserveDestination(
      deps,
      inspected.destination,
      inspected.parents,
    );
    assert.match(created.hold ?? '', /changed after inspection/);
    assert.equal(realLstat(inspected.destination), 'absent');
  });

  for (const [label, fromCall] of [
    ['a parent replaced before the parent loop is refused', 2],
    ['a parent replaced before the final recheck is refused', 3],
  ] as const) {
    test(`${name}: ${label}`, { skip: !POSIX }, () => {
      const fx = fresh();
      const swap = swappingIdentity(fx, fromCall);
      const deps = depsFor(fx, { directoryIdentity: swap.identity });
      const inspected = inspectPreserveDestination(
        deps,
        name,
        ISSUE,
        fx.primary,
        [],
      );
      assert.equal(inspected.hold, null);
      swap.arm();
      const created = createPreserveDestination(
        deps,
        inspected.destination,
        inspected.parents,
      );
      assert.match(created.hold ?? '', /changed after inspection/);
      assert.equal(realLstat(inspected.destination), 'absent');
    });
  }
}

/**
 * Reports a different identity for the state root from its `fromCall`-th read
 * after `arm()`, to simulate a replacement made by another process. Reads before
 * `arm()` are not counted.
 */
function swappingIdentity(fixture: Fixture, fromCall: number) {
  let armed = false;
  let calls = 0;
  return {
    arm: () => {
      armed = true;
    },
    identity: (path: string): string | null => {
      if (armed && path === fixture.stateRoot) {
        calls += 1;
        if (calls >= fromCall) return 'swapped-identity';
      }
      return realIdentity(path);
    },
  };
}
