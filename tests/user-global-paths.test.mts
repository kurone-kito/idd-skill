// Containment suite for issue #4242, covering the five exports of
// src/scripts/user-global-paths.mts.
//
// Open risks, stated here as in the module header: a symbolic link above the
// data root is not inspected, and a window remains between a containment
// check and the act that follows it.
//
// Tests that use a real symbolic link or the real no-follow opens skip on
// Windows, where `constants.O_NOFOLLOW` is undefined and every export refuses
// by design. Tests that inject fixed flag values run on every platform, as do
// the platform-refusal test and the export-list test.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { resolveInstalledPayloadRoot } from '../src/scripts/idd-activation.mts';
import type { FsOps } from '../src/scripts/user-global-paths.mts';
import * as userGlobalPaths from '../src/scripts/user-global-paths.mts';

const {
  checkContainment,
  removeSingleEntry,
  replaceFileByRename,
  repointCurrent,
  writeNewFile,
} = userGlobalPaths;

const POSIX_ONLY =
  process.platform === 'win32'
    ? 'symbolic links and no-follow opens are unavailable on Windows (O_NOFOLLOW is undefined)'
    : false;

/** Run a POSIX-only test everywhere else, with a named skip reason on Windows. */
function posixTest(name: string, run: () => void): void {
  test(name, { skip: POSIX_ONLY }, run);
}

interface Box {
  base: string;
  home: string;
  dataRoot: string;
  outside: string;
}

/**
 * A throwaway HOME inside a real (not symlinked) temporary directory. The
 * data root comes from the same resolver the installer uses, with HOME set
 * inside the sandbox, so the tests exercise the caller contract.
 */
function withBox(run: (box: Box) => void): void {
  const base = nodeFs.realpathSync(
    nodeFs.mkdtempSync(join(tmpdir(), 'user-global-paths-')),
  );
  try {
    const home = join(base, 'home');
    nodeFs.mkdirSync(home);
    const payload = resolveInstalledPayloadRoot({ env: { HOME: home } });
    assert.ok(payload, 'HOME inside the sandbox must resolve a payload root');
    run({
      base,
      home,
      dataRoot: dirname(payload),
      outside: join(base, 'outside'),
    });
  } finally {
    nodeFs.rmSync(base, { recursive: true, force: true });
  }
}

/** Create the data root and the directory that stands outside it. */
function makeRoot(box: Box): void {
  nodeFs.mkdirSync(box.dataRoot, { recursive: true });
  nodeFs.mkdirSync(box.outside, { recursive: true });
}

function writeFile(path: string, text: string): void {
  nodeFs.mkdirSync(dirname(path), { recursive: true });
  nodeFs.writeFileSync(path, text);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The real `node:fs` with some replacements; tests inject failures this way. */
function fsWith(overrides: Record<string, unknown>): FsOps {
  return { ...nodeFs, ...overrides } as unknown as FsOps;
}

/** The same `node:fs` with both no-follow constants reported as undefined. */
function withoutNoFollow(): FsOps {
  return fsWith({
    constants: {
      ...nodeFs.constants,
      O_NOFOLLOW: undefined,
      O_NONBLOCK: undefined,
    },
  });
}

/**
 * Fixed flag values, so the refusal under test rather than the host platform
 * decides the outcome. Used only where the flags are checked before any open.
 */
function withFixedFlags(overrides: Record<string, unknown> = {}): FsOps {
  return fsWith({
    constants: { O_NOFOLLOW: 0, O_NONBLOCK: 0 },
    ...overrides,
  });
}

/** `lstat` that answers one path with `replacement` (or throws it). */
function lstatReplacing(path: string, replacement: unknown): FsOps {
  return withFixedFlags({
    lstatSync: (p: string) => {
      if (p === path) {
        if (replacement instanceof Error) throw replacement;
        return replacement;
      }
      return nodeFs.lstatSync(p);
    },
  });
}

function fakeStat(kind: 'fifo' | 'socket' | 'device'): unknown {
  return {
    isSymbolicLink: () => false,
    isFile: () => false,
    isDirectory: () => false,
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
    isCharacterDevice: () => kind === 'device',
    nlink: 1,
    mode: 0o600,
  };
}

/** A sorted listing of a tree: links with targets, files with hashes. */
function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const visit = (path: string): void => {
    for (const name of nodeFs.readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = nodeFs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push(`${full} -> ${nodeFs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        entries.push(`${full}/`);
        visit(full);
      } else {
        entries.push(`${full} ${sha(nodeFs.readFileSync(full, 'utf8'))}`);
      }
    }
  };
  visit(dir);
  return entries;
}

function assertThrowsMatching(run: () => void, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

// --- Exports and platform (every platform) ---------------------------------

test('exports exactly the five containment entry points', () => {
  assert.deepEqual(Object.keys(userGlobalPaths).sort(), [
    'checkContainment',
    'removeSingleEntry',
    'replaceFileByRename',
    'repointCurrent',
    'writeNewFile',
  ]);
});

test('every export refuses before any mutation when no-follow is unavailable', () => {
  withBox((box) => {
    makeRoot(box);
    const file = join(box.dataRoot, 'f.txt');
    writeFile(file, 'old');
    nodeFs.mkdirSync(join(box.dataRoot, '0.1.0'));
    const fs = withoutNoFollow();
    const before = snapshot(box.home);
    const refusals: Array<() => void> = [
      () => checkContainment(box.dataRoot, join(box.dataRoot, 'x'), fs),
      () => writeNewFile(box.dataRoot, join(box.dataRoot, 'new.txt'), 'x', fs),
      () => replaceFileByRename(box.dataRoot, file, sha('old'), 'new', fs),
      () =>
        removeSingleEntry(
          box.dataRoot,
          file,
          { kind: 'file', sha256: sha('old') },
          fs,
        ),
      () => repointCurrent(box.dataRoot, '0.1.0', fs),
    ];
    for (const refuse of refusals) {
      assertThrowsMatching(refuse, /does not support the no-follow/);
    }
    assert.deepEqual(snapshot(box.home), before);
  });
});

test('a version outside the required pattern is refused', () => {
  withBox((box) => {
    makeRoot(box);
    assertThrowsMatching(
      () => repointCurrent(box.dataRoot, '../escape', withFixedFlags()),
      /does not match the required pattern/,
    );
  });
});

// --- Positive paths ----------------------------------------------------------

posixTest(
  'checkContainment reports kind and missing directories and creates nothing',
  () => {
    withBox((box) => {
      makeRoot(box);
      const before = snapshot(box.home);
      const result = checkContainment(
        box.dataRoot,
        join(box.dataRoot, 'a', 'b', 'file.txt'),
      );
      assert.equal(result.finalKind, 'absent');
      assert.deepEqual(result.missingDirs, [
        join(box.dataRoot, 'a'),
        join(box.dataRoot, 'a', 'b'),
      ]);
      assert.deepEqual(snapshot(box.home), before);
    });
  },
);

posixTest('writeNewFile creates missing directories and the file', () => {
  withBox((box) => {
    makeRoot(box);
    writeNewFile(
      box.dataRoot,
      join(box.dataRoot, 'sub', 'file.txt'),
      'payload',
    );
    assert.equal(
      nodeFs.readFileSync(join(box.dataRoot, 'sub', 'file.txt'), 'utf8'),
      'payload',
    );
  });
});

posixTest(
  'replaceFileByRename replaces a file whose hash matches and leaves no temporary file',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'old');
      replaceFileByRename(box.dataRoot, file, sha('old'), 'new');
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'new');
      assert.deepEqual(
        nodeFs
          .readdirSync(box.dataRoot)
          .filter((name) => name.includes('.tmp-')),
        [],
      );
    });
  },
);

posixTest('removeSingleEntry removes an empty directory', () => {
  withBox((box) => {
    makeRoot(box);
    const dir = join(box.dataRoot, 'empty');
    nodeFs.mkdirSync(dir);
    removeSingleEntry(box.dataRoot, dir, { kind: 'directory' });
    assert.equal(nodeFs.existsSync(dir), false);
  });
});

// --- Case 1 (ownership): repoint records nothing else ------------------------

posixTest(
  'case 1: a current link to a valid version directory is repointed and nothing else changes',
  () => {
    withBox((box) => {
      const root = box.dataRoot;
      nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
      nodeFs.mkdirSync(join(root, '0.2.0'));
      nodeFs.symlinkSync(join(root, '0.1.0'), join(root, 'current'));
      const before = snapshot(box.home);
      repointCurrent(root, '0.2.0');
      assert.equal(
        nodeFs.readlinkSync(join(root, 'current')),
        join(root, '0.2.0'),
      );
      const repointed = before.map((line) =>
        line.replace(
          `${join(root, 'current')} -> ${join(root, '0.1.0')}`,
          `${join(root, 'current')} -> ${join(root, '0.2.0')}`,
        ),
      );
      assert.deepEqual(snapshot(box.home), repointed);
    });
  },
);

posixTest('repointCurrent creates current when it is absent', () => {
  withBox((box) => {
    const root = box.dataRoot;
    nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
    repointCurrent(root, '0.1.0');
    assert.equal(
      nodeFs.readlinkSync(join(root, 'current')),
      join(root, '0.1.0'),
    );
  });
});

posixTest(
  'repointCurrent accepts a relative current target that resolves under the root',
  () => {
    withBox((box) => {
      const root = box.dataRoot;
      nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
      nodeFs.mkdirSync(join(root, '0.2.0'));
      nodeFs.symlinkSync('0.1.0', join(root, 'current'));
      repointCurrent(root, '0.2.0');
      assert.equal(
        nodeFs.readlinkSync(join(root, 'current')),
        join(root, '0.2.0'),
      );
    });
  },
);

// --- Case 2 (user edits) -----------------------------------------------------

posixTest(
  'case 2: removeSingleEntry refuses a file whose hash differs and leaves it in place',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'edited by the user');
      assertThrowsMatching(
        () =>
          removeSingleEntry(box.dataRoot, file, {
            kind: 'file',
            sha256: sha('original'),
          }),
        /does not match/,
      );
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'edited by the user');
    });
  },
);

posixTest(
  'case 2: removeSingleEntry refuses a regular file with two hard links',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'shared');
      nodeFs.linkSync(file, join(box.dataRoot, 'second.txt'));
      assertThrowsMatching(
        () =>
          removeSingleEntry(box.dataRoot, file, {
            kind: 'file',
            sha256: sha('shared'),
          }),
        /more than one hard link/,
      );
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'shared');
      assert.equal(nodeFs.existsSync(join(box.dataRoot, 'second.txt')), true);
    });
  },
);

posixTest(
  'case 2: replaceFileByRename refuses a hash mismatch and leaves the file unchanged',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'edited');
      assertThrowsMatching(
        () => replaceFileByRename(box.dataRoot, file, sha('original'), 'new'),
        /does not match/,
      );
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'edited');
    });
  },
);

posixTest(
  'case 2: a stale temporary file refuses a replacement and is never removed',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      const stale = `${file}.tmp-4242`;
      writeFile(file, 'old');
      writeFile(stale, 'leftover');
      assertThrowsMatching(
        () => replaceFileByRename(box.dataRoot, file, sha('old'), 'new'),
        /exists; refusing to replace/,
      );
      assert.equal(nodeFs.readFileSync(stale, 'utf8'), 'leftover');
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'old');
    });
  },
);

posixTest(
  'case 2: removeSingleEntry refuses a directory that is no longer empty and keeps its children',
  () => {
    withBox((box) => {
      makeRoot(box);
      const dir = join(box.dataRoot, 'dir');
      writeFile(join(dir, 'child.txt'), 'child');
      assertThrowsMatching(
        () => removeSingleEntry(box.dataRoot, dir, { kind: 'directory' }),
        /no longer empty/,
      );
      assert.equal(
        nodeFs.readFileSync(join(dir, 'child.txt'), 'utf8'),
        'child',
      );
    });
  },
);

posixTest(
  'case 2: removeSingleEntry refuses a link whose target changed',
  () => {
    withBox((box) => {
      makeRoot(box);
      const link = join(box.dataRoot, 'link');
      nodeFs.symlinkSync(join(box.outside, 'a'), link);
      assertThrowsMatching(
        () =>
          removeSingleEntry(box.dataRoot, link, {
            kind: 'symlink',
            target: join(box.outside, 'b'),
          }),
        /points somewhere else/,
      );
      assert.equal(nodeFs.readlinkSync(link), join(box.outside, 'a'));
    });
  },
);

// --- Case 3 (overwrite) ------------------------------------------------------

posixTest(
  'case 3: writeNewFile refuses any existing final component and leaves it unchanged',
  () => {
    const existing: Array<{
      name: string;
      make: (path: string, box: Box) => void;
    }> = [
      {
        name: 'regular file',
        make: (path) => writeFile(path, 'kept'),
      },
      {
        name: 'symbolic link',
        make: (path, box) => {
          writeFile(join(box.outside, 'target.txt'), 'outside');
          nodeFs.symlinkSync(join(box.outside, 'target.txt'), path);
        },
      },
      {
        name: 'regular file with a second hard link',
        make: (path) => {
          writeFile(path, 'kept');
          nodeFs.linkSync(path, `${path}.second`);
        },
      },
      {
        name: 'directory',
        make: (path) => nodeFs.mkdirSync(path),
      },
    ];
    for (const { name, make } of existing) {
      withBox((box) => {
        makeRoot(box);
        const target = join(box.dataRoot, 'final.txt');
        make(target, box);
        const before = snapshot(box.home);
        assertThrowsMatching(
          () => writeNewFile(box.dataRoot, target, 'new'),
          /already exists/,
        );
        assert.deepEqual(snapshot(box.home), before, name);
      });
    }
  },
);

posixTest(
  'case 3: repointCurrent refuses each unsafe current and keeps its previous target',
  () => {
    // Each case names the refusal it must hit, so a refusal for some other
    // reason cannot satisfy it.
    const unsafe: Array<{
      name: string;
      make: (box: Box) => void;
      reason: RegExp;
    }> = [
      {
        name: 'regular file',
        make: (box) => writeFile(join(box.dataRoot, 'current'), 'x'),
        reason: /is not a symbolic link/,
      },
      {
        name: 'directory',
        make: (box) => nodeFs.mkdirSync(join(box.dataRoot, 'current')),
        reason: /is not a symbolic link/,
      },
      {
        name: 'dangling link',
        make: (box) =>
          nodeFs.symlinkSync(
            join(box.dataRoot, '9.9.9'),
            join(box.dataRoot, 'current'),
          ),
        reason: /dangling link/,
      },
      {
        name: 'link outside the data root',
        make: (box) => {
          nodeFs.mkdirSync(join(box.outside, '0.1.0'));
          nodeFs.symlinkSync(
            join(box.outside, '0.1.0'),
            join(box.dataRoot, 'current'),
          );
        },
        reason: /not directly under the data root/,
      },
      {
        name: 'link to a directory that is not a version name',
        make: (box) => {
          nodeFs.mkdirSync(join(box.dataRoot, 'notes'));
          nodeFs.symlinkSync(
            join(box.dataRoot, 'notes'),
            join(box.dataRoot, 'current'),
          );
        },
        reason: /not a version directory name/,
      },
      {
        name: 'link whose target is itself a symbolic link',
        make: (box) => {
          nodeFs.mkdirSync(join(box.dataRoot, '0.1.0'));
          nodeFs.symlinkSync(join(box.outside), join(box.dataRoot, '0.2.0'));
          nodeFs.symlinkSync(
            join(box.dataRoot, '0.2.0'),
            join(box.dataRoot, 'current'),
          );
        },
        reason: /which is a symbolic link/,
      },
    ];
    for (const { name, make, reason } of unsafe) {
      withBox((box) => {
        makeRoot(box);
        nodeFs.mkdirSync(join(box.dataRoot, '0.3.0'));
        make(box);
        const before = snapshot(box.home);
        assertThrowsMatching(
          () => repointCurrent(box.dataRoot, '0.3.0'),
          reason,
        );
        assert.deepEqual(snapshot(box.home), before, name);
      });
    }
  },
);

// --- Case 4 (links) ----------------------------------------------------------

posixTest(
  'case 4: an intermediate link leading to an existing directory is refused on write',
  () => {
    withBox((box) => {
      makeRoot(box);
      nodeFs.mkdirSync(join(box.outside, 'real'));
      nodeFs.symlinkSync(box.outside, join(box.dataRoot, 'link'));
      assertThrowsMatching(
        () =>
          writeNewFile(
            box.dataRoot,
            join(box.dataRoot, 'link', 'real', 'file.txt'),
            'x',
          ),
        /symbolic link on the path/,
      );
      assert.deepEqual(nodeFs.readdirSync(join(box.outside, 'real')), []);
    });
  },
);

posixTest(
  'case 4: an intermediate link with a missing directory below it creates nothing below the link',
  () => {
    withBox((box) => {
      makeRoot(box);
      nodeFs.symlinkSync(box.outside, join(box.dataRoot, 'link'));
      const before = snapshot(box.outside);
      const target = join(box.dataRoot, 'link', 'missing', 'file.txt');
      assertThrowsMatching(
        () => checkContainment(box.dataRoot, target),
        /symbolic link on the path/,
      );
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, target, 'x'),
        /symbolic link on the path/,
      );
      assert.deepEqual(snapshot(box.outside), before);
      assert.equal(nodeFs.existsSync(join(box.outside, 'missing')), false);
    });
  },
);

posixTest(
  'case 4: writeNewFile refuses a final symbolic link without following it',
  () => {
    withBox((box) => {
      makeRoot(box);
      const outsideFile = join(box.outside, 'target.txt');
      writeFile(outsideFile, 'outside');
      const link = join(box.dataRoot, 'linked');
      nodeFs.symlinkSync(outsideFile, link);
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, link, 'overwritten'),
        /already exists as symlink/,
      );
      assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'outside');
    });
  },
);

posixTest(
  'case 4: removeSingleEntry removes a link and leaves its target in place',
  () => {
    withBox((box) => {
      makeRoot(box);
      const outsideFile = join(box.outside, 'target.txt');
      writeFile(outsideFile, 'outside');
      const link = join(box.dataRoot, 'linked');
      nodeFs.symlinkSync(outsideFile, link);
      removeSingleEntry(box.dataRoot, link, {
        kind: 'symlink',
        target: outsideFile,
      });
      assert.equal(nodeFs.existsSync(link), false);
      assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'outside');
    });
  },
);

posixTest('replaceFileByRename refuses to replace a symbolic link', () => {
  withBox((box) => {
    makeRoot(box);
    const outsideFile = join(box.outside, 'target.txt');
    writeFile(outsideFile, 'outside');
    const link = join(box.dataRoot, 'linked');
    nodeFs.symlinkSync(outsideFile, link);
    assertThrowsMatching(
      () => replaceFileByRename(box.dataRoot, link, sha('outside'), 'x'),
      /must be an existing regular file/,
    );
    assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'outside');
  });
});

posixTest(
  'replaceFileByRename refuses a regular file with two hard links',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'shared');
      nodeFs.linkSync(file, join(box.dataRoot, 'second.txt'));
      assertThrowsMatching(
        () => replaceFileByRename(box.dataRoot, file, sha('shared'), 'new'),
        /more than one hard link/,
      );
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'shared');
    });
  },
);

// --- Case 6 (root containment) and the S2 sentinel ---------------------------

posixTest(
  'case 6: a symbolic link as the data root is refused and the HOME tree is unchanged',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(box.outside, { recursive: true });
      nodeFs.mkdirSync(dirname(box.dataRoot), { recursive: true });
      nodeFs.symlinkSync(box.outside, box.dataRoot);
      const sentinel = join(box.outside, 'sentinel.txt');
      writeFile(sentinel, 'sentinel');
      const before = snapshot(box.home);
      const sentinelBefore = snapshot(box.outside);
      const target = join(box.dataRoot, 'x.txt');
      assertThrowsMatching(
        () => checkContainment(box.dataRoot, target),
        /symbolic link/,
      );
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, target, 'x'),
        /symbolic link/,
      );
      assertThrowsMatching(
        () => repointCurrent(box.dataRoot, '0.1.0'),
        /symbolic link/,
      );
      assert.deepEqual(snapshot(box.home), before);
      assert.deepEqual(snapshot(box.outside), sentinelBefore);
    });
  },
);

// --- Stale repoint path and repoint failure injection ------------------------

posixTest(
  'repointCurrent refuses a stale current temporary link, names it, and keeps the previous target',
  () => {
    withBox((box) => {
      const root = box.dataRoot;
      nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
      nodeFs.mkdirSync(join(root, '0.2.0'));
      nodeFs.symlinkSync(join(root, '0.1.0'), join(root, 'current'));
      const stale = join(root, 'current.tmp-99');
      nodeFs.symlinkSync(join(root, '0.2.0'), stale);
      assertThrowsMatching(
        () => repointCurrent(root, '0.2.0'),
        new RegExp(`${stale.replaceAll('.', '\\.')}.*remove it by hand`),
      );
      assert.equal(
        nodeFs.readlinkSync(join(root, 'current')),
        join(root, '0.1.0'),
      );
      assert.equal(nodeFs.readlinkSync(stale), join(root, '0.2.0'));
    });
  },
);

posixTest(
  'repointCurrent with a failed rename leaves no temporary link and keeps the previous target',
  () => {
    withBox((box) => {
      const root = box.dataRoot;
      nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
      nodeFs.mkdirSync(join(root, '0.2.0'));
      nodeFs.symlinkSync(join(root, '0.1.0'), join(root, 'current'));
      const fs = fsWith({
        renameSync: () => {
          throw new Error('injected rename failure');
        },
      });
      assertThrowsMatching(
        () => repointCurrent(root, '0.2.0', fs),
        /injected rename failure/,
      );
      assert.equal(
        nodeFs.readlinkSync(join(root, 'current')),
        join(root, '0.1.0'),
      );
      assert.deepEqual(
        nodeFs
          .readdirSync(root)
          .filter((name) => name.startsWith('current.tmp-')),
        [],
      );
    });
  },
);

posixTest(
  'repointCurrent with a failed rename and a failed temporary removal names the leftover path',
  () => {
    withBox((box) => {
      const root = box.dataRoot;
      nodeFs.mkdirSync(join(root, '0.1.0'), { recursive: true });
      nodeFs.mkdirSync(join(root, '0.2.0'));
      nodeFs.symlinkSync(join(root, '0.1.0'), join(root, 'current'));
      const leftover = join(root, `current.tmp-${process.pid}`);
      const fs = fsWith({
        renameSync: () => {
          throw new Error('injected rename failure');
        },
        unlinkSync: (path: string) => {
          if (path === leftover) throw new Error('injected unlink failure');
          return nodeFs.unlinkSync(path);
        },
      });
      assertThrowsMatching(
        () => repointCurrent(root, '0.2.0', fs),
        new RegExp(`leftover path: ${leftover.replaceAll('.', '\\.')}`),
      );
    });
  },
);

// --- Write failure injection -------------------------------------------------

posixTest(
  'a failed content write removes the file the create-only write made',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'new.txt');
      const fs = fsWith({
        writeSync: () => {
          throw new Error('injected write failure');
        },
      });
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, target, 'x', fs),
        /write to .* failed: injected write failure/,
      );
      assert.equal(nodeFs.existsSync(target), false);
    });
  },
);

posixTest(
  'a failed content write whose removal also fails names the leftover path',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'new.txt');
      const fs = fsWith({
        writeSync: () => {
          throw new Error('injected write failure');
        },
        unlinkSync: () => {
          throw new Error('injected unlink failure');
        },
      });
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, target, 'x', fs),
        new RegExp(`leftover path: ${target.replaceAll('.', '\\.')}`),
      );
    });
  },
);

posixTest(
  'a failed close is retried once and the created file is removed',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'new.txt');
      let closeCalls = 0;
      const fs = fsWith({
        closeSync: (fd: number) => {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error('injected close failure');
          return nodeFs.closeSync(fd);
        },
      });
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, target, 'x', fs),
        /write to .* failed: injected close failure/,
      );
      assert.equal(closeCalls, 2);
      assert.equal(nodeFs.existsSync(target), false);
    });
  },
);

posixTest(
  'a failed close during replacement is retried once and leaves the file unchanged',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'old');
      // Close call 1 is the hash read; call 2 closes the temporary file.
      let closeCalls = 0;
      const fs = fsWith({
        closeSync: (fd: number) => {
          closeCalls += 1;
          if (closeCalls === 2) throw new Error('injected close failure');
          return nodeFs.closeSync(fd);
        },
      });
      assertThrowsMatching(
        () => replaceFileByRename(box.dataRoot, file, sha('old'), 'new', fs),
        /replacement of .* failed: injected close failure/,
      );
      assert.equal(closeCalls, 3);
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'old');
      assert.deepEqual(
        nodeFs
          .readdirSync(box.dataRoot)
          .filter((name) => name.includes('.tmp-')),
        [],
      );
    });
  },
);

posixTest(
  'replaceFileByRename keeps the original permission bits under a restrictive umask',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'old');
      nodeFs.chmodSync(file, 0o664);
      const previous = process.umask(0o077);
      try {
        replaceFileByRename(box.dataRoot, file, sha('old'), 'new');
      } finally {
        process.umask(previous);
      }
      assert.equal(nodeFs.readFileSync(file, 'utf8'), 'new');
      assert.equal(nodeFs.statSync(file).mode & 0o777, 0o664);
    });
  },
);

// --- Root creation -----------------------------------------------------------

posixTest(
  'a missing data root is created with one mkdir per missing component below the parent',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(dirname(box.dataRoot), { recursive: true });
      const result = checkContainment(
        box.dataRoot,
        join(box.dataRoot, 'sub', 'file.txt'),
      );
      assert.deepEqual(result.missingDirs, [
        box.dataRoot,
        join(box.dataRoot, 'sub'),
      ]);
      writeNewFile(box.dataRoot, join(box.dataRoot, 'sub', 'file.txt'), 'x');
      assert.equal(
        nodeFs.readFileSync(join(box.dataRoot, 'sub', 'file.txt'), 'utf8'),
        'x',
      );
    });
  },
);

posixTest(
  'a missing data root whose parent is missing creates nothing and names the root',
  () => {
    withBox((box) => {
      const before = snapshot(box.home);
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, join(box.dataRoot, 'x.txt'), 'x'),
        new RegExp(`could not create ${box.dataRoot.replaceAll('.', '\\.')}`),
      );
      assert.deepEqual(snapshot(box.home), before);
    });
  },
);

posixTest(
  'a failed second mkdir keeps the first component and names the path',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(dirname(box.dataRoot), { recursive: true });
      let calls = 0;
      const fs = fsWith({
        mkdirSync: (path: string) => {
          calls += 1;
          if (calls === 2) throw new Error('injected mkdir failure');
          return nodeFs.mkdirSync(path);
        },
      });
      const second = join(box.dataRoot, 'sub');
      assertThrowsMatching(
        () =>
          writeNewFile(
            box.dataRoot,
            join(second, 'deeper', 'file.txt'),
            'x',
            fs,
          ),
        new RegExp(`could not create ${second.replaceAll('.', '\\.')}`),
      );
      assert.equal(nodeFs.existsSync(box.dataRoot), true);
      assert.equal(nodeFs.existsSync(second), false);
      assert.equal(nodeFs.existsSync(dirname(box.dataRoot)), true);
    });
  },
);

// --- Special files and lstat errors (injected) -------------------------------

test('a FIFO on an intermediate component is refused', () => {
  withBox((box) => {
    makeRoot(box);
    const fifoDir = join(box.dataRoot, 'fifo-dir');
    const fs = lstatReplacing(fifoDir, fakeStat('fifo'));
    assertThrowsMatching(
      () => writeNewFile(box.dataRoot, join(fifoDir, 'f.txt'), 'x', fs),
      /is not a directory on the path/,
    );
  });
});

test('a socket on the final component is refused', () => {
  withBox((box) => {
    makeRoot(box);
    const sock = join(box.dataRoot, 'sock');
    const fs = lstatReplacing(sock, fakeStat('socket'));
    assertThrowsMatching(
      () => writeNewFile(box.dataRoot, sock, 'x', fs),
      /special file/,
    );
  });
});

test('a character device on an intermediate component is refused', () => {
  withBox((box) => {
    makeRoot(box);
    const device = join(box.dataRoot, 'dev');
    const fs = lstatReplacing(device, fakeStat('device'));
    assertThrowsMatching(
      () => checkContainment(box.dataRoot, join(device, 'f.txt'), fs),
      /is not a directory on the path/,
    );
  });
});

test('an lstat error other than does not exist is refused', () => {
  withBox((box) => {
    makeRoot(box);
    const target = join(box.dataRoot, 'x.txt');
    const denied = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    const fs = lstatReplacing(target, denied);
    assertThrowsMatching(
      () => checkContainment(box.dataRoot, target, fs),
      /cannot inspect/,
    );
  });
});
