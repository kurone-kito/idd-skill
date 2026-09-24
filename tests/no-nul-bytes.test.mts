import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards kurone-kito/idd-skill#3340: a raw U+0000 (NUL) byte embedded in a
// tracked `.mts`/`.mjs` source file hides the rest of that file from tools
// that skip binary files -- GNU `grep -I`, for example, reports no match at
// all for a file containing one, even when the file has plenty of matching
// text lines. `src/`, `scripts/`, `bin/`, and `tests/` are the directories
// this repository's own helper sources and their generated/test companions
// live in (see docs/typescript-sources.md); a NUL byte belongs there only as
// an escape sequence (`\0`, `\x00`, or `\u0000`), never as a literal byte.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const COVERED_DIRS = ['src', 'scripts', 'bin', 'tests'];

/** True when `buffer` contains a literal U+0000 (NUL) byte. */
function containsNulByte(buffer: Buffer): boolean {
  return buffer.includes(0x00);
}

/** Tracked `.mts`/`.mjs` file paths (repo-root-relative) under the covered
 * directories, via `git ls-files` (matches this file's own tracked-file
 * enumeration convention; see src/scripts/check-untracked-artifacts.mts). */
function listCoveredFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '--', ...COVERED_DIRS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `no-nul-bytes: git ls-files exited ${String(result.status)}: ${result.stderr}`,
    );
  }
  return result.stdout
    .split('\n')
    .filter((path) => path.endsWith('.mts') || path.endsWith('.mjs'));
}

test('no tracked src/scripts/bin/tests source file contains a literal NUL byte', () => {
  const files = listCoveredFiles();
  assert.ok(files.length > 0, 'expected at least one covered source file');
  const offenders = files.filter((path) =>
    containsNulByte(readFileSync(join(REPO_ROOT, path))),
  );
  assert.deepEqual(
    offenders,
    [],
    `found a literal NUL byte in: ${offenders.join(', ')} -- escape it as ` +
      '\\0 (or \\x00/\\u0000) instead of embedding a raw U+0000 byte; see ' +
      'kurone-kito/idd-skill#3340.',
  );
});

test('the NUL-byte guard actually detects an inserted NUL byte (self-check)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-no-nul-bytes-'));
  try {
    const cleanPath = join(dir, 'clean.mts');
    const dirtyPath = join(dir, 'dirty.mts');
    writeFileSync(cleanPath, 'export const ok = "no nul bytes here";\n');
    writeFileSync(dirtyPath, Buffer.from('export const bad = "a\0b";\n'));
    assert.equal(containsNulByte(readFileSync(cleanPath)), false);
    assert.equal(containsNulByte(readFileSync(dirtyPath)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
