// Containment suite for issue #4242, covering the exports of
// src/scripts/user-global-paths.mts.
//
// Open risks, stated here as in the module header: a symbolic link above a
// declared ceiling is trusted when root owns it, and a window remains between a
// containment check and the act that follows it. The ceiling tests (#4303)
// cover the chain from a declared root down to the walk root and the
// components above it. `ownedBy` stands in for the owner of a link, so those
// tests do not depend on who runs them; one test reads a real owner and skips
// when that owner is root.
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
  assertRealChain,
  checkContainment,
  createDirectory,
  removeSingleEntry,
  replaceFileByRename,
  repointCurrent,
  withCeilings,
  writeNewFileAtomically,
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

test('exports the containment entry points and the two ceiling helpers', () => {
  assert.deepEqual(Object.keys(userGlobalPaths).sort(), [
    'assertRealChain',
    'checkContainment',
    'createDirectory',
    'removeSingleEntry',
    'replaceFileByRename',
    'repointCurrent',
    'withCeilings',
    'writeNewFile',
    'writeNewFileAtomically',
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
      () => createDirectory(box.dataRoot, join(box.dataRoot, 'new-dir'), fs),
      () => writeNewFile(box.dataRoot, join(box.dataRoot, 'new.txt'), 'x', fs),
      () =>
        writeNewFileAtomically(
          box.dataRoot,
          join(box.dataRoot, 'new-atomic.txt'),
          'x',
          fs,
        ),
      () => replaceFileByRename(box.dataRoot, file, sha('old'), 'new', fs),
      () =>
        removeSingleEntry(
          box.dataRoot,
          file,
          { kind: 'file', sha256: sha('old') },
          fs,
        ),
      () => repointCurrent(box.dataRoot, '0.1.0', fs),
      () => assertRealChain(box.dataRoot, withCeilings(fs, [box.home])),
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
  'writeNewFileAtomically recovers complete and partial temporary files',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'sub', 'file.txt');
      nodeFs.mkdirSync(dirname(target), { recursive: true });
      const completeTemp = `${target}.idd-prepared-tmp-123`;
      writeFile(completeTemp, 'complete');
      nodeFs.linkSync(completeTemp, target);
      writeNewFileAtomically(box.dataRoot, target, 'complete');
      assert.equal(nodeFs.readFileSync(target, 'utf8'), 'complete');
      assert.equal(nodeFs.existsSync(completeTemp), false);
      assert.equal(nodeFs.lstatSync(target).nlink, 1);

      nodeFs.unlinkSync(target);
      const partialTemp = `${target}.idd-prepared-tmp-456`;
      writeFile(partialTemp, 'part');
      writeNewFileAtomically(box.dataRoot, target, 'partial payload');
      assert.equal(nodeFs.readFileSync(target, 'utf8'), 'partial payload');
      assert.equal(nodeFs.existsSync(partialTemp), false);
      assert.equal(nodeFs.lstatSync(target).nlink, 1);
    });
  },
);

posixTest(
  'writeNewFileAtomically replaces a complete temporary file with the wrong mode',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'sub', 'executable.mjs');
      const temporary = `${target}.idd-prepared-tmp-789`;
      writeFile(temporary, 'complete');
      nodeFs.chmodSync(temporary, 0o644);

      writeNewFileAtomically(box.dataRoot, target, 'complete', nodeFs, 0o755);

      assert.equal(nodeFs.readFileSync(target, 'utf8'), 'complete');
      assert.equal(nodeFs.lstatSync(target).mode & 0o777, 0o755);
      assert.equal(nodeFs.existsSync(temporary), false);
    });
  },
);

posixTest('writeNewFileAtomically preserves an existing different file', () => {
  withBox((box) => {
    makeRoot(box);
    const target = join(box.dataRoot, 'existing.txt');
    writeFile(target, 'user content');
    assertThrowsMatching(
      () => writeNewFileAtomically(box.dataRoot, target, 'installer content'),
      /different bytes/,
    );
    assert.equal(nodeFs.readFileSync(target, 'utf8'), 'user content');
  });
});

posixTest(
  'createDirectory creates only absent directories and refuses reuse',
  () => {
    withBox((box) => {
      makeRoot(box);
      const target = join(box.dataRoot, 'prepared', 'commit');
      assert.deepEqual(createDirectory(box.dataRoot, target), [
        join(box.dataRoot, 'prepared'),
        target,
      ]);
      assert.equal(nodeFs.statSync(target).isDirectory(), true);
      assertThrowsMatching(
        () => createDirectory(box.dataRoot, target),
        /already exists as directory/,
      );
    });
  },
);

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

posixTest(
  'a path that climbs out of a symbolic link is refused and nothing is written outside',
  () => {
    withBox((box) => {
      makeRoot(box);
      nodeFs.symlinkSync(box.outside, join(box.dataRoot, 'link'));
      // The kernel follows `link` before `..`, so this names base/escaped.txt.
      const traversal = `${box.dataRoot}/link/../escaped.txt`;
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, traversal, 'x'),
        /not in normalized form/,
      );
      assert.equal(nodeFs.existsSync(join(box.base, 'escaped.txt')), false);
    });
  },
);

posixTest(
  'a current link whose target climbs out of a symbolic link is refused and kept',
  () => {
    withBox((box) => {
      makeRoot(box);
      nodeFs.mkdirSync(join(box.dataRoot, '0.1.0'));
      nodeFs.mkdirSync(join(box.dataRoot, '0.2.0'));
      nodeFs.mkdirSync(join(box.outside, 'sub'), { recursive: true });
      nodeFs.mkdirSync(join(box.outside, '0.1.0'));
      nodeFs.symlinkSync(join(box.outside, 'sub'), join(box.dataRoot, 'link'));
      // Lexically this is root/0.1.0; the kernel resolves it to outside/0.1.0.
      nodeFs.symlinkSync('link/../0.1.0', join(box.dataRoot, 'current'));
      const before = snapshot(box.home);
      assertThrowsMatching(
        () => repointCurrent(box.dataRoot, '0.2.0'),
        /not in normalized form/,
      );
      assert.deepEqual(snapshot(box.home), before);
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

// --- Ceilings: links above and below a declared root (#4303) ------------------

/** The real `node:fs` declaring `ceilings`, as the installer declares them. */
function declaring(...ceilings: string[]): FsOps {
  return withCeilings(nodeFs, ceilings);
}

/** Records every lstat path, in call order, before answering with the real one. */
function lstatSpy(calls: string[], ceilings: string[]): FsOps {
  return withCeilings(
    fsWith({
      lstatSync: (path: string) => {
        calls.push(path);
        return nodeFs.lstatSync(path);
      },
    }),
    ceilings,
  );
}

/**
 * The real `node:fs` whose lstat reports `uid` as the owner of each listed
 * path, so a test does not depend on who runs it or who owns a link it made.
 */
function ownedBy(uid: number, ...paths: string[]): FsOps {
  const listed = new Set(paths);
  return fsWith({
    lstatSync: (path: string) => {
      const stat = nodeFs.lstatSync(path);
      return listed.has(path)
        ? Object.create(stat, { uid: { value: uid } })
        : stat;
    },
  });
}

/** The proper ancestors of `path`, outermost first, without the filesystem root. */
function ancestorsOf(path: string): string[] {
  const found: string[] = [];
  for (let up = dirname(path); up !== dirname(up); up = dirname(up)) {
    found.unshift(up);
  }
  return found;
}

test('withCeilings returns a copy that declares the ceilings and leaves the original alone', () => {
  withBox((box) => {
    const declared = declaring(box.home);
    assert.deepEqual(declared.ceilings, [box.home]);
    assert.notEqual(declared, nodeFs);
    assert.equal(
      (nodeFs as unknown as { ceilings?: unknown }).ceilings,
      undefined,
    );
  });
});

posixTest(
  'a plain directory chain is accepted and a write goes through it as before',
  () => {
    withBox((box) => {
      makeRoot(box);
      const fs = declaring(box.home);
      assertRealChain(box.dataRoot, fs);
      writeNewFile(
        box.dataRoot,
        join(box.dataRoot, 'sub', 'file.txt'),
        'payload',
        fs,
      );
      assert.equal(
        nodeFs.readFileSync(join(box.dataRoot, 'sub', 'file.txt'), 'utf8'),
        'payload',
      );
    });
  },
);

posixTest(
  'a link directly under the ceiling is refused although nothing exists beyond it',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(box.outside);
      nodeFs.symlinkSync(box.outside, join(box.home, '.local'));
      const before = snapshot(box.base);
      const fs = declaring(box.home);
      const file = join(box.dataRoot, 'a.txt');

      assertThrowsMatching(
        () => assertRealChain(box.dataRoot, fs),
        /symbolic link on the path/,
      );
      assertThrowsMatching(
        () => checkContainment(box.dataRoot, file, fs),
        /symbolic link on the path/,
      );
      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, file, 'x', fs),
        /symbolic link on the path/,
      );
      assert.deepEqual(snapshot(box.base), before);
      assert.deepEqual(nodeFs.readdirSync(box.outside), []);
      // Without a declared ceiling the walk sees only an absent root: this is
      // the limit the ceiling closes.
      assert.equal(checkContainment(box.dataRoot, file).finalKind, 'absent');
    });
  },
);

posixTest(
  'a link in the middle of the chain is refused when the data root exists beyond it',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(join(box.home, '.local'));
      const beyond = join(box.outside, 'idd-skill');
      nodeFs.mkdirSync(beyond, { recursive: true });
      writeFile(join(beyond, 'sentinel.txt'), 'keep');
      nodeFs.symlinkSync(box.outside, join(box.home, '.local', 'share'));
      const before = snapshot(box.outside);
      const fs = declaring(box.home);
      const file = join(box.dataRoot, 'new.txt');

      assertThrowsMatching(
        () => writeNewFile(box.dataRoot, file, 'x', fs),
        /symbolic link on the path/,
      );
      assert.deepEqual(snapshot(box.outside), before);
      // Without a declared ceiling the root looks like an ordinary directory.
      assert.equal(checkContainment(box.dataRoot, file).finalKind, 'absent');
    });
  },
);

posixTest(
  'the chain is read top-down, the ancestors of the ceiling first, and stops at the first absent component',
  () => {
    withBox((box) => {
      const absent: string[] = [];
      assertRealChain(box.dataRoot, lstatSpy(absent, [box.home]));
      assert.deepEqual(absent, [
        ...ancestorsOf(box.home),
        box.home,
        join(box.home, '.local'),
      ]);

      nodeFs.mkdirSync(join(box.home, '.local', 'share'), { recursive: true });
      const present: string[] = [];
      assertRealChain(box.dataRoot, lstatSpy(present, [box.home]));
      assert.deepEqual(present, [
        ...ancestorsOf(box.home),
        box.home,
        join(box.home, '.local'),
        join(box.home, '.local', 'share'),
        box.dataRoot,
      ]);
    });
  },
);

posixTest(
  'an absent component ends the chain without an error and creates nothing',
  () => {
    withBox((box) => {
      const before = snapshot(box.base);
      const fs = declaring(box.home);
      assertRealChain(box.dataRoot, fs);
      const result = checkContainment(
        box.dataRoot,
        join(box.dataRoot, 'x'),
        fs,
      );
      assert.equal(result.finalKind, 'absent');
      assert.deepEqual(result.missingDirs, [box.dataRoot]);
      assert.deepEqual(snapshot(box.base), before);
    });
  },
);

posixTest(
  'a dangling link on the chain is a link, not an absent component',
  () => {
    withBox((box) => {
      nodeFs.symlinkSync(join(box.base, 'nowhere'), join(box.home, '.local'));
      assertThrowsMatching(
        () => assertRealChain(box.dataRoot, declaring(box.home)),
        /symbolic link on the path/,
      );
    });
  },
);

posixTest('a regular file on the chain is refused', () => {
  withBox((box) => {
    writeFile(join(box.home, '.local'), 'not a directory');
    assertThrowsMatching(
      () => assertRealChain(box.dataRoot, declaring(box.home)),
      /is not a directory on the path/,
    );
  });
});

test('a FIFO or an lstat error on the chain is refused', () => {
  withBox((box) => {
    const component = join(box.home, '.local');
    assertThrowsMatching(
      () =>
        assertRealChain(
          box.dataRoot,
          withCeilings(lstatReplacing(component, fakeStat('fifo')), [box.home]),
        ),
      /is not a directory on the path/,
    );
    const denied = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    assertThrowsMatching(
      () =>
        assertRealChain(
          box.dataRoot,
          withCeilings(lstatReplacing(component, denied), [box.home]),
        ),
      /cannot inspect/,
    );
  });
});

posixTest(
  'a ceiling that is itself a link is refused, also when spelled with a trailing separator',
  () => {
    withBox((box) => {
      const real = join(box.base, 'real-home');
      nodeFs.mkdirSync(join(real, '.local', 'share'), { recursive: true });
      const link = join(box.base, 'home-link');
      nodeFs.symlinkSync(real, link);
      const root = join(link, '.local', 'share', 'idd-skill');
      for (const ceiling of [link, `${link}/`]) {
        assertThrowsMatching(
          () => assertRealChain(root, declaring(ceiling)),
          /symbolic link on the path/,
        );
        assertThrowsMatching(
          () =>
            writeNewFile(root, join(root, 'f.txt'), 'x', declaring(ceiling)),
          /symbolic link on the path/,
        );
      }
      assert.deepEqual(nodeFs.readdirSync(join(real, '.local', 'share')), []);
      // A link at the ceiling itself offers the other remedy, and the message
      // does not say "on the path to" the same link.
      assertThrowsMatching(
        () => assertRealChain(link, declaring(link)),
        /^[^\n]*home-link is a symbolic link \(the chain from [^)]*\); refusing to write through it; to continue, name the real path instead of the link/,
      );
    });
  },
);

posixTest(
  'a link above the ceiling that root owns is tolerated and the walk behaves as before',
  () => {
    withBox((box) => {
      const real = join(box.base, 'real-parent');
      nodeFs.mkdirSync(join(real, 'home', '.local', 'share'), {
        recursive: true,
      });
      const linked = join(box.base, 'linked-parent');
      nodeFs.symlinkSync(real, linked);
      const home = join(linked, 'home');
      const root = join(home, '.local', 'share', 'idd-skill');
      // The macOS shape: a system link such as /var -> /private/var is root-owned.
      const fs = withCeilings(ownedBy(0, linked), [home]);

      assertRealChain(root, fs);
      writeNewFile(root, join(root, 'f.txt'), 'ok', fs);
      assert.equal(
        nodeFs.readFileSync(
          join(real, 'home', '.local', 'share', 'idd-skill', 'f.txt'),
          'utf8',
        ),
        'ok',
      );
    });
  },
);

posixTest(
  'a link above the ceiling that a user owns is refused and nothing is written',
  () => {
    withBox((box) => {
      const real = join(box.base, 'real-parent');
      nodeFs.mkdirSync(join(real, 'home', '.local', 'share'), {
        recursive: true,
      });
      const linked = join(box.base, 'linked-parent');
      nodeFs.symlinkSync(real, linked);
      const home = join(linked, 'home');
      const root = join(home, '.local', 'share', 'idd-skill');
      const before = snapshot(box.base);
      const fs = withCeilings(ownedBy(1234, linked), [home]);

      assertThrowsMatching(
        () => assertRealChain(root, fs),
        /linked-parent is a symbolic link above .* that the system does not own \(owner uid 1234\)/,
      );
      assertThrowsMatching(
        () => checkContainment(root, join(root, 'f.txt'), fs),
        /symbolic link above/,
      );
      assertThrowsMatching(
        () => writeNewFile(root, join(root, 'f.txt'), 'x', fs),
        /symbolic link above/,
      );
      assert.deepEqual(snapshot(box.base), before);
    });
  },
);

test('a link the running user made above the ceiling is refused with the owner the filesystem reports, no stand-in', {
  skip: process.platform === 'win32',
}, (t) => {
  withBox((box) => {
    const real = join(box.base, 'real-parent');
    nodeFs.mkdirSync(join(real, 'home'), { recursive: true });
    const linked = join(box.base, 'linked-parent');
    nodeFs.symlinkSync(real, linked);
    const owner = nodeFs.lstatSync(linked).uid;
    if (owner === 0) {
      // Running as root, or on a filesystem that reports every file as root's:
      // the link looks like the system's and is tolerated by design.
      t.skip('the filesystem reports the new link as root-owned');
      return;
    }
    const home = join(linked, 'home');
    assertThrowsMatching(
      () => assertRealChain(join(home, 'x'), declaring(home)),
      new RegExp(
        `linked-parent is a symbolic link above .*\\(owner uid ${owner}\\)`,
      ),
    );
  });
});

posixTest(
  'a dangling or owner-less link above the ceiling is refused, and a file above it too',
  () => {
    withBox((box) => {
      const dangling = join(box.base, 'dangling');
      nodeFs.symlinkSync(join(box.base, 'nowhere'), dangling);
      const root = join(dangling, 'home');
      assertThrowsMatching(
        () =>
          assertRealChain(root, withCeilings(ownedBy(1234, dangling), [root])),
        /dangling is a symbolic link above/,
      );

      const noOwner = lstatReplacing(join(box.base, 'ownerless'), {
        ...(fakeStat('fifo') as object),
        isSymbolicLink: () => true,
      });
      assertThrowsMatching(
        () =>
          assertRealChain(
            join(box.base, 'ownerless', 'home'),
            withCeilings(noOwner, [join(box.base, 'ownerless', 'home')]),
          ),
        /ownerless is a symbolic link above .*\(owner unknown\)/,
      );

      writeFile(join(box.base, 'plain-file'), 'x');
      assertThrowsMatching(
        () =>
          assertRealChain(
            join(box.base, 'plain-file', 'home'),
            declaring(join(box.base, 'plain-file', 'home')),
          ),
        /plain-file is not a directory above/,
      );
    });
  },
);

posixTest(
  'an absent component above the ceiling ends the walk without an error',
  () => {
    withBox((box) => {
      const home = join(box.base, 'missing-parent', 'home');
      const calls: string[] = [];
      assertRealChain(join(home, '.local'), lstatSpy(calls, [home]));
      assert.deepEqual(calls, [
        ...ancestorsOf(box.base),
        box.base,
        join(box.base, 'missing-parent'),
      ]);
    });
  },
);

posixTest(
  'a custom XDG ceiling is refused when it is a link, and a link above it is refused unless root owns it',
  () => {
    withBox((box) => {
      const real = join(box.base, 'real-xdg');
      nodeFs.mkdirSync(join(real, 'idd-skill'), { recursive: true });
      const link = join(box.base, 'xdg-link');
      nodeFs.symlinkSync(real, link);
      assertThrowsMatching(
        () => assertRealChain(join(link, 'idd-skill'), declaring(link)),
        /symbolic link on the path/,
      );
      assert.deepEqual(nodeFs.readdirSync(join(real, 'idd-skill')), []);

      const parentReal = join(box.base, 'real-parent');
      nodeFs.mkdirSync(join(parentReal, 'xdg', 'idd-skill'), {
        recursive: true,
      });
      const parentLink = join(box.base, 'linked-parent');
      nodeFs.symlinkSync(parentReal, parentLink);
      const xdg = join(parentLink, 'xdg');
      const root = join(xdg, 'idd-skill');
      assertRealChain(root, withCeilings(ownedBy(0, parentLink), [xdg]));
      assertThrowsMatching(
        () =>
          assertRealChain(root, withCeilings(ownedBy(1234, parentLink), [xdg])),
        /linked-parent is a symbolic link above/,
      );
    });
  },
);

posixTest(
  'a base equal to the ceiling reads its ancestors then one component, and the first covering ceiling wins',
  () => {
    withBox((box) => {
      const expected = [...ancestorsOf(box.home), box.home];
      const equal: string[] = [];
      assertRealChain(box.home, lstatSpy(equal, [box.home]));
      assert.deepEqual(equal, expected);

      // Order is the contract: the primary root is declared first.
      const primaryFirst: string[] = [];
      assertRealChain(box.home, lstatSpy(primaryFirst, [box.home, '/']));
      assert.deepEqual(primaryFirst, expected);
      const outerFirst: string[] = [];
      assertRealChain(box.home, lstatSpy(outerFirst, ['/', box.home]));
      assert.equal(outerFirst[0], '/');
      assert.equal(outerFirst.at(-1), box.home);

      // A ceiling of "/" is a whole path with nothing above it.
      assertRealChain(box.home, declaring('/'));
    });
  },
);

posixTest(
  'a ceiling above the primary root does not make the primary root stricter',
  () => {
    withBox((box) => {
      const real = join(box.base, 'real-parent');
      nodeFs.mkdirSync(join(real, 'home', '.local', 'share'), {
        recursive: true,
      });
      const linked = join(box.base, 'linked-parent');
      nodeFs.symlinkSync(real, linked);
      const home = join(linked, 'home');
      const root = join(home, '.local', 'share', 'idd-skill');
      const fs = withCeilings(ownedBy(0, linked), [home, linked]);

      // The primary root covers its own paths, so the link above it is only
      // the tolerated kind, not a link at or below a ceiling.
      assertRealChain(root, fs);
      // A path only the outer ceiling covers is read from it, where a link
      // is refused whoever owns it.
      assertThrowsMatching(() => assertRealChain(linked, fs), /symbolic link/);
    });
  },
);

posixTest(
  'a ceiling declared inside another is bounded by the outer one',
  () => {
    withBox((box) => {
      nodeFs.mkdirSync(box.outside);
      nodeFs.mkdirSync(join(box.outside, 'share'));
      nodeFs.symlinkSync(box.outside, join(box.home, '.local'));
      const inner = join(box.home, '.local', 'share');
      const owned = ownedBy(0, join(box.home, '.local'));
      // The inner ceiling alone sees the link only from above, where a link
      // that root owns is tolerated.
      assertRealChain(box.dataRoot, withCeilings(owned, [inner]));
      assertThrowsMatching(
        () =>
          assertRealChain(box.dataRoot, withCeilings(owned, [box.home, inner])),
        /symbolic link on the path/,
      );
    });
  },
);

test('a hand-built ceilings list is validated by every walk', () => {
  withBox((box) => {
    const bypass = withFixedFlags({ ceilings: ['relative/home'] });
    assertThrowsMatching(
      () => assertRealChain(box.dataRoot, bypass),
      /a ceiling must be absolute/,
    );
    assertThrowsMatching(
      () => checkContainment(box.dataRoot, join(box.dataRoot, 'x'), bypass),
      /a ceiling must be absolute/,
    );
  });
});

posixTest(
  'a base that no declared ceiling covers is refused, a name prefix included',
  () => {
    withBox((box) => {
      const ceiling = join(box.base, 'ceil');
      nodeFs.mkdirSync(ceiling);
      nodeFs.mkdirSync(join(box.base, 'ceilX'));
      const fs = declaring(ceiling);
      for (const base of [
        join(box.base, 'ceilX', 'a'),
        box.base,
        join(box.base, 'elsewhere'),
      ]) {
        assertThrowsMatching(
          () => assertRealChain(base, fs),
          /not at or below any declared ceiling/,
        );
        assertThrowsMatching(
          () => checkContainment(base, join(base, 'f'), fs),
          /not at or below any declared ceiling/,
        );
      }
    });
  },
);

posixTest('ceilings and bases must be absolute and normalized', () => {
  withBox((box) => {
    assertThrowsMatching(
      () => withCeilings(nodeFs, []),
      /at least one ceiling/,
    );
    const bad = [
      'relative/home',
      './home',
      `${box.home}/../home`,
      `${box.home}//x`,
      `${box.home}/./x`,
    ];
    for (const path of bad) {
      assert.throws(() => withCeilings(nodeFs, [path]), /absolute|normalized/);
      assert.throws(
        () => assertRealChain(path, declaring(box.home)),
        /absolute|normalized/,
      );
    }
  });
});

posixTest(
  'every walk-based primitive refuses a link on the chain and changes nothing',
  () => {
    withBox((box) => {
      makeRoot(box);
      const file = join(box.dataRoot, 'f.txt');
      writeFile(file, 'old');
      nodeFs.mkdirSync(join(box.dataRoot, '0.1.0'));
      const moved = join(box.home, '.local-real');
      nodeFs.renameSync(join(box.home, '.local'), moved);
      nodeFs.symlinkSync(moved, join(box.home, '.local'));
      const before = snapshot(box.home);
      const fs = declaring(box.home);
      const refusals: Array<() => void> = [
        () => checkContainment(box.dataRoot, join(box.dataRoot, 'x'), fs),
        () =>
          writeNewFile(box.dataRoot, join(box.dataRoot, 'new.txt'), 'x', fs),
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
        assertThrowsMatching(refuse, /symbolic link on the path/);
      }
      assert.deepEqual(snapshot(box.home), before);
    });
  },
);

test('assertRealChain refuses a plain fs handle that declares no ceilings', () => {
  withBox((box) => {
    assertThrowsMatching(
      () => assertRealChain(box.dataRoot, withFixedFlags()),
      /no ceilings are declared/,
    );
  });
});
