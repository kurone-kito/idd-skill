import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  type NoFollowDeps,
  readNoFollowFile,
  writeExclusiveNoFollow,
} from '../src/scripts/windows-nofollow.mts';

const SCRIPT = fileURLToPath(
  new URL('../src/scripts/windows-nofollow.ps1', import.meta.url),
);

/** POSIX live tests need /proc/self/fd for descriptor-relative opens. */
function posixLiveDeps(): Record<string, never> | null {
  if (!hasPosixNoFollowFlags()) return null;
  if (!existsSync('/proc/self/fd')) return null;
  return {};
}

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
      O_DIRECTORY: 4,
    }),
    true,
  );
  assert.equal(
    hasPosixNoFollowFlags({
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_CREAT: 2,
      O_EXCL: 3,
      O_NOFOLLOW: 0,
      O_NONBLOCK: 0,
      O_DIRECTORY: undefined,
    }),
    false,
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
    if (deps === null) return;
    assert.throws(
      () => readNoFollowFile(link, deps),
      /refuse|symlink|symbolic links|reparse|ELOOP|not a regular file/i,
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
    if (deps === null) return;
    assert.throws(
      () => readNoFollowFile(target, deps),
      /refuse|intermediate|reparse|symlink|symbolic links|ELOOP|ENOTDIR|not a plain directory|not a directory/i,
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
    if (deps === null) return;
    writeExclusiveNoFollow(file, 'created', deps);
    assert.equal(readFileSync(file, 'utf8'), 'created');
    assert.throws(
      () => writeExclusiveNoFollow(file, 'again', deps),
      /refuse|exist|EEXIST|win32/i,
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
    if (deps === null) return;
    assert.throws(
      () => writeExclusiveNoFollow(link, 'overwrite', deps),
      /refuse|exist|symlink|reparse/i,
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
      process.platform === 'win32' ? { scriptPath: SCRIPT } : posixLiveDeps();
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
      /refuse|intermediate|reparse|symlink|symbolic links|ELOOP|ENOTDIR|not a plain directory|not a directory|escape/i,
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
  if (posixLiveDeps() === null) return;

  const dir = scratch();
  try {
    const file = join(dir, 'partial.txt');
    let writes = 0;
    assert.throws(
      () =>
        writeExclusiveNoFollow(file, 'data', {
          platform: 'linux',
          writeSync: ((
            fd: number,
            buffer: NodeJS.ArrayBufferView,
            offset?: number,
            length?: number,
          ) => {
            writes += 1;
            if (writes === 1) {
              throw new Error('simulated write failure');
            }
            return writeSync(
              fd,
              buffer,
              offset ?? 0,
              length ?? buffer.byteLength,
            );
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

test('Windows probe-relative opens the final via the held parent (#5292)', () => {
  // Deterministic seam: probe-relative holds the parent directory handle,
  // then opens the leaf only with NtCreateFile(RootDirectory, OBJ_DONT_REPARSE).
  // That is the production final-open path; a full concurrent FSCTL race is
  // not simulated here.
  if (process.platform !== 'win32') return;

  const dir = scratch();
  try {
    const mid = join(dir, 'mid');
    mkdirSync(mid);
    const file = join(mid, 'nested.txt');
    const payload = 'held-parent-relative';
    writeFileSync(file, payload);
    const powershell = join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const stdout = execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT,
        'probe-relative',
        file,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const result = JSON.parse(stdout.trim()) as {
      ok: boolean;
      via?: string;
      sha256?: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.via, 'relative');
    assert.equal(
      result.sha256,
      createHash('sha256').update(payload).digest('hex'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyNoFollow streams a multi-chunk file on Windows and reports the identity it read (issue #5326)', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-nofollow-stream-'));
  try {
    const source = join(dir, 'source.bin');
    const destination = join(dir, 'destination.bin');
    const payload = Buffer.alloc(3 * 65536 + 17, 0x5a);
    writeFileSync(source, payload);
    const identity = copyNoFollow(source, destination);
    assert.ok(identity !== null);
    assert.deepEqual(readFileSync(destination), payload);
    const measured = statSync(source, { bigint: true });
    assert.equal(identity.volume, measured.dev);
    assert.equal(identity.index, measured.ino);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyNoFollow bounds the helper deadline by the source size (issue #5326)', () => {
  // The deadline is checked through an injected helper, so it runs on any
  // platform: the base deadline, then one second per 4 MiB of source.
  const root = mkdtempSync(join(tmpdir(), 'idd-nofollow-deadline-'));
  try {
    const system32 = join(root, 'System32', 'WindowsPowerShell', 'v1.0');
    mkdirSync(system32, { recursive: true });
    writeFileSync(join(system32, 'powershell.exe'), '');
    const scriptPath = join(root, 'windows-nofollow.ps1');
    writeFileSync(scriptPath, '');
    const timeouts: number[] = [];
    const deps: NoFollowDeps = {
      platform: 'win32',
      env: { SystemRoot: root },
      scriptPath,
      execFile: ((
        _file: string,
        _args: readonly string[],
        options: { timeout: number },
      ) => {
        timeouts.push(options.timeout);
        return JSON.stringify({
          ok: true,
          created: true,
          sourceVolume: 1,
          sourceIndex: '2',
        });
      }) as never,
    };
    const source = join(root, 'source.bin');
    const destination = join(root, 'destination.bin');
    writeFileSync(source, '');
    copyNoFollow(source, destination, deps);
    copyNoFollow(source, destination, deps, 0);
    copyNoFollow(source, destination, deps, 1024 ** 3);
    copyNoFollow(source, destination, deps, -1);
    assert.deepEqual(timeouts, [30_000, 30_000, 286_000, 30_000]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyNoFollow copies through a hard link on Windows and reports the linked file identity (issue #5326)', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-nofollow-hardlink-'));
  try {
    const source = join(dir, 'source.bin');
    const link = join(dir, 'link.bin');
    const destination = join(dir, 'destination.bin');
    const payload = Buffer.alloc(65536 + 9, 0x2b);
    writeFileSync(source, payload);
    linkSync(source, link);
    const identity = copyNoFollow(link, destination);
    assert.ok(identity !== null);
    assert.deepEqual(readFileSync(destination), payload);
    const measured = statSync(link, { bigint: true });
    assert.equal(identity.volume, measured.dev);
    assert.equal(identity.index, measured.ino);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
