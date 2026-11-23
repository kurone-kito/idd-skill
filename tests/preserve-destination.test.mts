import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
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
  type WindowsIdentityStats,
} from '../src/scripts/preserve-destination.mts';
import type {
  WindowsAclReader,
  WindowsDirectoryTools,
} from '../src/scripts/windows-acl.mts';

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
    const created = createPreserveDestination(
      deps,
      destination,
      chainParents(fx, name),
    );
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

  test(`${name}: a destination outside the inspected preserve directory is refused`, {
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
    const outside = join(fx.root, `${ISSUE}-${TIMESTAMP}`);
    const created = createPreserveDestination(deps, outside, inspected.parents);
    assert.match(created.hold ?? '', /not a direct child/);
    assert.equal(realLstat(outside), 'absent');
  });

  test(`${name}: a created directory replaced before its final identity read is refused`, {
    skip: !POSIX,
  }, () => {
    const fx = fresh();
    const destination = destinationFor(name, fx.stateRoot);
    let reads = 0;
    const deps = depsFor(fx, {
      directoryIdentity: (path) => {
        if (path !== destination) return realIdentity(path);
        reads += 1;
        return reads === 1 ? realIdentity(path) : 'replaced-identity';
      },
    });
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
      destination,
      inspected.parents,
    );
    assert.match(created.hold ?? '', /changed after creation/);
  });
}

test('a non-integer issue number is refused at run time', {
  skip: !POSIX,
}, () => {
  const fx = fresh();
  for (const issue of ['../../escape', 0, -1, 1.5, Number.NaN]) {
    const result = inspectPreserveDestination(
      depsFor(fx),
      'f4-preserved',
      issue as number,
      fx.primary,
      [],
    );
    assert.match(result.hold ?? '', /is not a positive integer/);
    assert.equal(result.destination, '');
  }
});

test('an unknown preserved-data directory name is refused at run time', {
  skip: !POSIX,
}, () => {
  const fx = fresh();
  const result = inspectPreserveDestination(
    depsFor(fx),
    '../../escape' as PreserveDirectoryName,
    ISSUE,
    fx.primary,
    [],
  );
  assert.match(result.hold ?? '', /unknown preserved-data directory/);
  assert.equal(result.destination, '');
});

/** The parents of a complete chain, read after its directories exist. */
function chainParents(fixture: Fixture, name: PreserveDirectoryName) {
  return [
    fixture.stateRoot,
    join(fixture.stateRoot, 'idd-skill'),
    join(fixture.stateRoot, 'idd-skill', name),
  ].map((path) => ({ path, identity: realIdentity(path) }));
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

// Windows ACL tightening (kurone-kito/idd-skill#5318). The platform, the ACL
// reader, the owner reader, and the writer are injected, so these run on every
// host against real directories. The icacls and PowerShell argument lists are
// asserted against a fake process starter in windows-acl.test.mts, and the
// real calls are not run in CI; the pull request records a native Windows run.
const USER_SID = 'S-1-5-21-1000000001-2000000002-3000000003-1001';
const OTHER_USER_SID = 'S-1-5-21-1000000001-2000000002-3000000003-1002';

interface WindowsAclFixture {
  /** Real paths whose ACL reads as private; every other directory is permissive. */
  readonly privatePaths: Set<string>;
  readonly reader: WindowsAclReader;
  readonly tools: WindowsDirectoryTools;
  readonly owners: string[];
  readonly restricted: string[];
  setOwner: (owner: string | null | 'throw') => void;
  onRestrict: (hook: (path: string) => void) => void;
  /** Make the writer succeed without changing the ACL. */
  setRestrictEffective: (effective: boolean) => void;
}

function windowsAcl(withCurrentSid = true): WindowsAclFixture {
  const privatePaths = new Set<string>();
  const owners: string[] = [];
  const restricted: string[] = [];
  let owner: string | null | 'throw' = USER_SID;
  let hook: (path: string) => void = () => {};
  let effective = true;
  const reader: WindowsAclReader = (directory) => ({
    kind: 'entries',
    ...(withCurrentSid ? { currentSid: USER_SID } : {}),
    entries: privatePaths.has(directory)
      ? [
          { sid: USER_SID, allow: true },
          { sid: 'S-1-5-18', allow: true },
        ]
      : [
          { sid: USER_SID, allow: true },
          { sid: 'S-1-1-0', allow: true },
        ],
  });
  const tools: WindowsDirectoryTools = {
    readOwner: (directory) => {
      owners.push(directory);
      if (owner === 'throw') throw new Error('owner read failed');
      return owner;
    },
    // Like the real writer, it runs the caller's recheck before each step.
    restrict: (directory, currentSid, _readAcl, recheck) => {
      restricted.push(directory);
      assert.equal(currentSid, USER_SID);
      recheck?.();
      hook(directory);
      recheck?.();
      if (effective) privatePaths.add(directory);
    },
  };
  return {
    privatePaths,
    reader,
    tools,
    owners,
    restricted,
    setOwner: (value) => {
      owner = value;
    },
    onRestrict: (value) => {
      hook = value;
    },
    setRestrictEffective: (value) => {
      effective = value;
    },
  };
}

function windowsEnsure(path: string, acl: WindowsAclFixture): void {
  ensurePrivateStateDirectory(path, 'win32', acl.reader, acl.tools);
}

function permissiveDirectory(fixture: Fixture, name = 'victim'): string {
  const path = join(fixture.root, name);
  mkdirSync(path);
  return realResolve(path) as string;
}

test('windows: a permissive real directory is restricted, read again as private, and the helper continues', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const path = permissiveDirectory(fx);
  assert.equal(inspectDirectoryPrivacy(path, 'win32', acl.reader), 'unsafe');
  windowsEnsure(path, acl);
  assert.deepEqual(acl.restricted, [path]);
  assert.deepEqual(acl.owners, [path]);
  assert.equal(inspectDirectoryPrivacy(path, 'win32', acl.reader), 'private');
});

test('windows: an already private directory is left alone with no owner read and no write', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const path = permissiveDirectory(fx);
  acl.privatePaths.add(path);
  windowsEnsure(path, acl);
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
});

test('windows: a symlink to a permissive target is refused and nothing is read or written', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const target = permissiveDirectory(fx, 'target');
  const link = join(fx.root, 'link');
  symlinkSync(target, link, 'junction');
  assert.throws(
    () => windowsEnsure(link, acl),
    /symlink target is not private/,
  );
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
  assert.equal(acl.privatePaths.has(target), false);
});

test('windows: a symlink to an already private target is still accepted unchanged', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const target = permissiveDirectory(fx, 'target');
  acl.privatePaths.add(target);
  const link = join(fx.root, 'link');
  symlinkSync(target, link, 'junction');
  windowsEnsure(link, acl);
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
});

test('windows: a file, a missing path, and a populated directory are refused before any write', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const file = join(fx.root, 'file');
  writeFileSync(file, 'x');
  const populated = permissiveDirectory(fx, 'populated');
  writeFileSync(join(populated, 'entry'), 'x');
  for (const path of [file, join(fx.root, 'missing'), populated]) {
    assert.throws(
      () => windowsEnsure(path, acl),
      /ownership or privacy could not be verified/,
      path,
    );
  }
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
});

test('windows: an unreadable ACL, or one without the current user SID, is refused before any owner read', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  const unreadable = windowsAcl();
  assert.throws(
    () =>
      ensurePrivateStateDirectory(
        path,
        'win32',
        () => ({ kind: 'unreadable' }),
        unreadable.tools,
      ),
    /ownership or privacy could not be verified/,
  );
  const throwing = windowsAcl();
  assert.throws(
    () =>
      ensurePrivateStateDirectory(
        path,
        'win32',
        () => {
          throw new Error('icacls failed');
        },
        throwing.tools,
      ),
    /ownership or privacy could not be verified/,
  );
  const noSid = windowsAcl(false);
  assert.throws(
    () => windowsEnsure(path, noSid),
    /ownership or privacy could not be verified/,
  );
  for (const acl of [unreadable, throwing, noSid]) {
    assert.deepEqual(acl.owners, []);
    assert.deepEqual(acl.restricted, []);
  }
});

test('windows: an owner other than the current user is refused with no write', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  for (const owner of [
    OTHER_USER_SID,
    // An elevated session owns new directories as Administrators.
    'S-1-5-32-544',
    'S-1-5-18',
  ] as const) {
    const acl = windowsAcl();
    acl.setOwner(owner);
    assert.throws(
      () => windowsEnsure(path, acl),
      /directory belongs to another user/,
      String(owner),
    );
    assert.deepEqual(acl.restricted, [], String(owner));
  }
  const matching = windowsAcl();
  matching.setOwner(USER_SID.toLowerCase());
  windowsEnsure(path, matching);
  assert.deepEqual(matching.restricted, [path]);
});

test('windows: an owner read that throws or names no SID is refused as unverified, not as another owner', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  for (const owner of [null, 'throw', '', '   '] as const) {
    const acl = windowsAcl();
    acl.setOwner(owner);
    assert.throws(
      () => windowsEnsure(path, acl),
      /directory ownership or privacy could not be verified/,
      JSON.stringify(owner),
    );
    assert.deepEqual(acl.restricted, [], JSON.stringify(owner));
  }
});

test('windows: a directory whose identity has inode 0 is refused as unverified before any ACL read, owner read, or write', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  const acl = windowsAcl();
  // Every identity read reports inode 0, which a real directory does not do.
  const readIdentity = (target: string): WindowsIdentityStats => {
    const stat = lstatSync(target, { bigint: true });
    return {
      dev: stat.dev,
      ino: 0n,
      isDirectory: () => stat.isDirectory(),
      isSymbolicLink: () => stat.isSymbolicLink(),
    };
  };
  let aclReads = 0;
  const countingReader: WindowsAclReader = (directory) => {
    aclReads += 1;
    return acl.reader(directory);
  };
  // The identity is refused before the privacy inspection, so no ACL read of
  // any kind happens for this directory.
  assert.throws(
    () =>
      ensurePrivateStateDirectory(path, 'win32', countingReader, {
        ...acl.tools,
        readIdentity,
      }),
    /directory ownership or privacy could not be verified/,
  );
  assert.equal(aclReads, 0);
  assert.deepEqual(acl.owners, []);
  assert.deepEqual(acl.restricted, []);
});

test('windows: a re-read that is still permissive or unreadable is refused', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  const stillPermissive = windowsAcl();
  stillPermissive.setRestrictEffective(false);
  assert.throws(
    () => windowsEnsure(path, stillPermissive),
    /could not be restricted to its owner/,
  );
  assert.deepEqual(stillPermissive.restricted, [path]);

  const acl = windowsAcl();
  let reads = 0;
  assert.throws(
    () =>
      ensurePrivateStateDirectory(
        path,
        'win32',
        (directory) => {
          reads += 1;
          // The first two reads are the inspection and the pre-write read.
          return reads <= 2 ? acl.reader(directory) : { kind: 'unreadable' };
        },
        acl.tools,
      ),
    /could not be restricted to its owner/,
  );
  assert.deepEqual(acl.restricted, [path]);
});

test('windows: a failing writer is reported and the helper does not continue', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx);
  const acl = windowsAcl();
  acl.onRestrict(() => {
    throw new Error('Access is denied');
  });
  assert.throws(
    () => windowsEnsure(path, acl),
    /could not be restricted to its owner: Access is denied/,
  );
});

test('windows: a directory replaced before the write, or during it, is reported', () => {
  const fx = fresh();
  const swap = (path: string) => {
    renameSync(path, `${path}.old`);
    mkdirSync(path);
  };
  const before = permissiveDirectory(fx, 'before');
  const early = windowsAcl();
  const earlyTools: WindowsDirectoryTools = {
    ...early.tools,
    readOwner: (directory) => {
      swap(directory);
      return USER_SID;
    },
  };
  assert.throws(
    () =>
      ensurePrivateStateDirectory(before, 'win32', early.reader, earlyTools),
    /directory changed after inspection/,
  );
  assert.deepEqual(early.restricted, []);

  const during = permissiveDirectory(fx, 'during');
  const late = windowsAcl();
  late.onRestrict(swap);
  assert.throws(
    () => windowsEnsure(during, late),
    /directory changed while it was being restricted/,
  );
  // The swap was caught by the recheck, so the writer never marked it private.
  assert.equal(late.privatePaths.has(during), false);
});

test('windows: an entry added before a writer step stops that step', () => {
  const fx = fresh();
  const path = permissiveDirectory(fx, 'populated-late');
  const acl = windowsAcl();
  acl.onRestrict((directory) => {
    // Another process adds an entry after the pre-write checks passed.
    writeFileSync(join(directory, 'late-entry'), 'x');
  });
  assert.throws(
    () => windowsEnsure(path, acl),
    /directory changed while it was being restricted/,
  );
  // The fake writer reached its second step only through the recheck.
  assert.equal(acl.privatePaths.has(path), false);
});

test('windows: a path swapped for a junction after the checks is reported and its target is not written', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const path = permissiveDirectory(fx, 'victim-path');
  const target = permissiveDirectory(fx, 'junction-target');
  const swapped: WindowsDirectoryTools = {
    ...acl.tools,
    readOwner: (directory) => {
      // Here the path and its resolved name are the same string, so both now
      // lead to the junction.
      renameSync(path, `${path}.old`);
      symlinkSync(target, path, 'junction');
      assert.equal(directory, path);
      return USER_SID;
    },
  };
  assert.throws(
    () => ensurePrivateStateDirectory(path, 'win32', acl.reader, swapped),
    /directory changed after inspection/,
  );
  assert.deepEqual(acl.restricted, []);
  assert.equal(acl.privatePaths.has(target), false);
});

test('windows: a parent link retargeted after the checks is reported through the original path', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const first = join(fx.root, 'first');
  const second = join(fx.root, 'second');
  mkdirSync(join(first, 'victim'), { recursive: true });
  mkdirSync(join(second, 'victim'), { recursive: true });
  const via = join(fx.root, 'via');
  symlinkSync(first, via, 'junction');
  // The path goes through a link, so it differs from its resolved name; the
  // resolved name stays put while the link now leads to another directory.
  const path = join(via, 'victim');
  const retargeted: WindowsDirectoryTools = {
    ...acl.tools,
    readOwner: () => {
      unlinkSync(via);
      symlinkSync(second, via, 'junction');
      return USER_SID;
    },
  };
  assert.throws(
    () => ensurePrivateStateDirectory(path, 'win32', acl.reader, retargeted),
    /directory changed after inspection/,
  );
  assert.deepEqual(acl.restricted, []);
});

test('windows: inspection and a dry run never write an ACL', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    ensurePrivateDirectory: (path) => windowsEnsure(path, acl),
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
    ISSUE,
    fx.primary,
    [],
  );
  assert.equal(inspected.hold, null);
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
});

test('windows: creation restricts the parents and the leaf it creates, and records them', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    ensurePrivateDirectory: (path) => windowsEnsure(path, acl),
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
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
  const iddDirectory = join(fx.stateRoot, 'idd-skill');
  const preserveDirectory = join(iddDirectory, 'b1-preserved');
  assert.deepEqual(acl.restricted, [
    iddDirectory,
    preserveDirectory,
    inspected.destination,
  ]);
  for (const path of [iddDirectory, preserveDirectory, inspected.destination]) {
    assert.equal(
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
      'private',
      path,
    );
  }
  assert.equal(
    created.parents[created.parents.length - 1]?.path,
    inspected.destination,
  );
});

test('windows: a created leaf that still is not private stays in place and is reported', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const iddDirectory = join(fx.stateRoot, 'idd-skill');
  const preserveDirectory = join(iddDirectory, 'b1-preserved');
  mkdirSync(preserveDirectory, { recursive: true });
  acl.privatePaths.add(iddDirectory);
  acl.privatePaths.add(preserveDirectory);
  const destination = destinationFor('b1-preserved', fx.stateRoot);
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    ensurePrivateDirectory: (path) => windowsEnsure(path, acl),
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
    ISSUE,
    fx.primary,
    [],
  );
  assert.equal(inspected.hold, null);
  // The writer succeeds but the ACL stays permissive.
  acl.setRestrictEffective(false);
  const created = createPreserveDestination(
    deps,
    destination,
    inspected.parents,
  );
  assert.match(created.hold ?? '', /was created but is not owned and private/);
  assert.match(created.hold ?? '', /could not be restricted to its owner/);
  assert.equal(realLstat(destination), 'directory');
  assert.deepEqual(acl.restricted, [realResolve(destination)]);

  // A leaf whose owner is another user is refused with the reason and no write.
  const other = windowsAcl();
  other.privatePaths.add(fx.stateRoot);
  other.privatePaths.add(iddDirectory);
  other.privatePaths.add(preserveDirectory);
  other.setOwner(OTHER_USER_SID);
  const otherDeps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', other.reader),
    ensurePrivateDirectory: (path) => windowsEnsure(path, other),
    now: () => new Date('2026-11-04T04:00:00.000Z'),
  });
  const otherInspected = inspectPreserveDestination(
    otherDeps,
    'b1-preserved',
    ISSUE,
    fx.primary,
    [],
  );
  const otherCreated = createPreserveDestination(
    otherDeps,
    otherInspected.destination,
    otherInspected.parents,
  );
  assert.match(
    otherCreated.hold ?? '',
    /was created but is not owned and private/,
  );
  assert.match(otherCreated.hold ?? '', /directory belongs to another user/);
  assert.deepEqual(other.restricted, []);
  assert.equal(realLstat(otherInspected.destination), 'directory');
});

test('windows: a leaf replaced after it was created is refused before any write', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const destination = destinationFor('b1-preserved', fx.stateRoot);
  let swapped = false;
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) => {
      if (path === destination && !swapped) {
        // Another process replaces the just-created leaf with a different
        // empty directory, after its identity was captured.
        swapped = true;
        renameSync(destination, `${destination}.old`);
        mkdirSync(destination);
      }
      return inspectDirectoryPrivacy(path, 'win32', acl.reader);
    },
    ensurePrivateDirectory: (path) => windowsEnsure(path, acl),
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
    ISSUE,
    fx.primary,
    [],
  );
  assert.equal(inspected.hold, null);
  const created = createPreserveDestination(
    deps,
    destination,
    inspected.parents,
  );
  assert.match(created.hold ?? '', /changed after creation/);
  assert.equal(swapped, true);
  // The replacement was never written to: only the parents were restricted.
  assert.equal(
    acl.restricted.includes(realResolve(destination) as string),
    false,
  );
});

test('windows: a parent made by this run and replaced before it is restricted is reported', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const iddDirectory = join(fx.stateRoot, 'idd-skill');
  let swapped = false;
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    ensurePrivateDirectory: (path) => {
      if (path === iddDirectory && !swapped) {
        // Another process replaces the directory this run just made.
        swapped = true;
        renameSync(iddDirectory, `${iddDirectory}.old`);
        mkdirSync(iddDirectory);
      }
      windowsEnsure(path, acl);
    },
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
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
  assert.equal(swapped, true);
  assert.match(created.hold ?? '', /idd-skill changed after creation/);
  assert.equal(realLstat(inspected.destination), 'absent');
});

test('windows: an existing permissive state root is refused at inspection with no tool call', () => {
  const fx = fresh();
  const acl = windowsAcl();
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    ensurePrivateDirectory: (path) => windowsEnsure(path, acl),
  });
  const inspected = inspectPreserveDestination(
    deps,
    'f4-preserved',
    ISSUE,
    fx.primary,
    [],
  );
  assert.match(inspected.hold ?? '', /state root is not owned and private/);
  assert.deepEqual(acl.restricted, []);
  assert.deepEqual(acl.owners, []);
});

test('windows: a populated parent whose ACL turns permissive after inspection is never rewritten', () => {
  const fx = fresh();
  const acl = windowsAcl();
  acl.privatePaths.add(fx.stateRoot);
  const iddDirectory = join(fx.stateRoot, 'idd-skill');
  mkdirSync(iddDirectory);
  writeFileSync(join(iddDirectory, 'other-tool-state'), 'x');
  acl.privatePaths.add(iddDirectory);
  const deps = depsFor(fx, {
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, 'win32', acl.reader),
    // Another process loosens the shared directory after the parents were
    // checked and before the helper restricts it: the state root is the first
    // parent restricted.
    ensurePrivateDirectory: (path) => {
      if (path === fx.stateRoot) acl.privatePaths.delete(iddDirectory);
      windowsEnsure(path, acl);
    },
  });
  const inspected = inspectPreserveDestination(
    deps,
    'b1-preserved',
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
  assert.match(created.hold ?? '', /could not prepare .*idd-skill/);
  assert.deepEqual(acl.restricted, []);
  assert.equal(acl.privatePaths.has(iddDirectory), false);
});

test('windows: the shared read paths cannot reach the ACL writer', () => {
  // The GitHub API read cache, the discover hint cache, and gh-exec read an
  // ACL through windows-acl.mts and must never write one (issue #5318). They
  // may not import the preserve helper or any writer symbol.
  for (const name of [
    'github-api-read-cache',
    'discover-hint-cache',
    'gh-exec',
  ]) {
    const source = readFileSync(
      new URL(`../src/scripts/${name}.mts`, import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'preserve-destination',
      'ensurePrivateStateDirectory',
      'restrictWindowsDirectory',
      'defaultWindowsDirectoryTools',
      'WindowsDirectoryTools',
      'readWindowsOwner',
    ]) {
      assert.equal(source.includes(forbidden), false, `${name}: ${forbidden}`);
    }
  }
});
