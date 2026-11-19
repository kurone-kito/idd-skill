import assert from 'node:assert/strict';
import {
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  copyNoFollow,
  hasPosixNoFollowFlags,
  readNoFollowFile,
  writeExclusiveNoFollow,
} from '../src/scripts/windows-nofollow.mts';

const SCRIPT = fileURLToPath(
  new URL('../src/scripts/windows-nofollow.ps1', import.meta.url),
);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'idd-nofollow-'));
}

function trySymlink(
  target: string,
  path: string,
  type?: 'file' | 'dir',
): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

test('hasPosixNoFollowFlags refuses a missing constant without substituting zero', () => {
  assert.equal(
    hasPosixNoFollowFlags({
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 2,
      O_EXCL: 3,
      O_NOFOLLOW: undefined,
      O_NONBLOCK: 4,
    }),
    false,
  );
  assert.equal(
    hasPosixNoFollowFlags({
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 2,
      O_EXCL: 3,
      O_NOFOLLOW: 0,
      O_NONBLOCK: 0,
    }),
    true,
  );
});

test('POSIX path refuses when O_NOFOLLOW is undefined (no || 0)', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    assert.throws(
      () =>
        readNoFollowFile(file, {
          platform: 'linux',
          constants: {
            O_RDONLY: constants.O_RDONLY,
            O_WRONLY: constants.O_WRONLY,
            O_CREAT: constants.O_CREAT,
            O_EXCL: constants.O_EXCL,
            O_NOFOLLOW: undefined,
            O_NONBLOCK: constants.O_NONBLOCK ?? 0x800,
          },
        }),
      /does not support the no-follow/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readNoFollowFile returns bytes for a regular file', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'payload-bytes');
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) {
      assert.ok(
        true,
        'platform lacks no-follow flags; covered by the refuse test',
      );
      return;
    }
    const bytes = readNoFollowFile(file, deps);
    assert.equal(bytes.toString('utf8'), 'payload-bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readNoFollowFile refuses a final symlink or junction', () => {
  const dir = scratch();
  try {
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'secret');
    if (!trySymlink(real, link, 'file')) {
      assert.ok(true, 'symlink creation unavailable; skip link refusal');
      return;
    }
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    assert.throws(
      () => readNoFollowFile(link, deps),
      /refus|symlink|reparse|not a regular file/i,
    );
    assert.equal(readFileSync(real, 'utf8'), 'secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readNoFollowFile refuses an intermediate reparse point', () => {
  const dir = scratch();
  try {
    const realDir = join(dir, 'real-dir');
    const linkDir = join(dir, 'link-dir');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'inside.txt'), 'inside');
    if (!trySymlink(realDir, linkDir, 'dir')) {
      assert.ok(true, 'directory symlink creation unavailable');
      return;
    }
    const target = join(linkDir, 'inside.txt');
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    assert.throws(
      () => readNoFollowFile(target, deps),
      /refus|intermediate|reparse|symlink|not a plain directory/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readNoFollowFile refuses a non-regular final component', () => {
  const dir = scratch();
  try {
    const nested = join(dir, 'subdir');
    mkdirSync(nested);
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    assert.throws(
      () => readNoFollowFile(nested, deps),
      /not a regular file|directory/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readNoFollowFile refuses a multi-hard-link file', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'a.txt');
    const alias = join(dir, 'b.txt');
    writeFileSync(file, 'shared');
    try {
      linkSync(file, alias);
    } catch {
      assert.ok(true, 'hard links unavailable on this volume');
      return;
    }
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    assert.throws(() => readNoFollowFile(file, deps), /hard link/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeExclusiveNoFollow creates a new file and refuses an existing final component', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'new.txt');
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    writeExclusiveNoFollow(file, 'created', deps);
    assert.equal(readFileSync(file, 'utf8'), 'created');
    assert.throws(
      () => writeExclusiveNoFollow(file, 'again', deps),
      /refus|exist|EEXIST|win32/i,
    );
    assert.equal(readFileSync(file, 'utf8'), 'created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeExclusiveNoFollow refuses a final symlink before the first write', () => {
  const dir = scratch();
  try {
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'keep');
    if (!trySymlink(real, link, 'file')) {
      assert.ok(true, 'symlink creation unavailable');
      return;
    }
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    assert.throws(
      () => writeExclusiveNoFollow(link, 'overwrite', deps),
      /refus|exist|symlink|reparse/i,
    );
    assert.equal(readFileSync(real, 'utf8'), 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyNoFollow copies bytes and refuses a destination under a directory link', () => {
  const dir = scratch();
  try {
    const source = join(dir, 'src.txt');
    writeFileSync(source, 'copy-me');
    const realParent = join(dir, 'real-parent');
    const linkParent = join(dir, 'link-parent');
    mkdirSync(realParent);
    const destOk = join(realParent, 'dst.txt');
    const deps =
      process.platform === 'win32'
        ? { scriptPath: SCRIPT }
        : hasPosixNoFollowFlags()
          ? {}
          : null;
    if (deps === null) return;
    copyNoFollow(source, destOk, deps);
    assert.equal(readFileSync(destOk, 'utf8'), 'copy-me');

    if (!trySymlink(realParent, linkParent, 'dir')) {
      assert.ok(true, 'directory symlink creation unavailable');
      return;
    }
    const destBad = join(linkParent, 'escaped.txt');
    assert.throws(
      () => copyNoFollow(source, destBad, deps),
      /refus|intermediate|reparse|symlink|not a plain directory|escape/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeExclusiveNoFollow leaves the new file when a later write fails', () => {
  // Injectable POSIX open that succeeds, then writeSync throws once.
  if (process.platform === 'win32') {
    assert.ok(
      true,
      'POSIX inject path; Windows create+write is atomic in the helper',
    );
    return;
  }
  if (!hasPosixNoFollowFlags()) return;

  const dir = scratch();
  try {
    const file = join(dir, 'partial.txt');
    let writes = 0;
    assert.throws(
      () =>
        writeExclusiveNoFollow(file, 'data', {
          platform: 'linux',
          writeSync: ((fd, buffer, offset, length) => {
            writes += 1;
            if (writes === 1) {
              throw new Error('simulated write failure');
            }
            return writeSync(fd, buffer, offset, length);
          }) as typeof writeSync,
        }),
      /simulated write failure|leftover path/,
    );
    // The exclusive create succeeded; the leftover path must remain.
    assert.equal(readFileSync(file).length >= 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relative or non-normalized paths are refused before any open', () => {
  assert.throws(() => readNoFollowFile('relative.txt'), /absolute/);
  const dir = scratch();
  try {
    // Build a non-normalized absolute path by hand; path.join would collapse it.
    const abs = `${dir}${sep}.${sep}y.txt`;
    assert.throws(() => readNoFollowFile(abs), /normalized/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows missing open capability still refuses without || 0', () => {
  // On Windows the real constants are undefined; force the POSIX branch with
  // undefined flags to prove the refuse path never substitutes zero.
  const dir = scratch();
  try {
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'x');
    assert.throws(
      () =>
        readNoFollowFile(file, {
          platform: 'linux',
          constants: {
            O_RDONLY: 0,
            O_WRONLY: 1,
            O_CREAT: 2,
            O_EXCL: 3,
            // Intentionally undefined — must not become 0.
            O_NOFOLLOW: undefined,
            O_NONBLOCK: undefined,
          },
        }),
      /does not support the no-follow/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
