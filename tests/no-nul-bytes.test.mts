import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { containsNulByte } from '../src/scripts/lint-source-boundaries.mts';

// Guards kurone-kito/idd-skill#3340: a raw U+0000 (NUL) byte embedded in a
// tracked `.mts`/`.mjs` source file hides the rest of that file from tools
// that skip binary files -- GNU `grep -I`, for example, reports no match at
// all for a file containing one, even when the file has plenty of matching
// text lines. A NUL byte belongs in `src/`, `scripts/`, `bin/` and `tests/`
// only as an escape sequence (`\0`, `\x00`, or `\u0000`), never as a literal
// byte. The scan of the tracked files is the NO-NUL-BYTES rule of
// scripts/lint-source-boundaries.mjs (#3748); this file keeps the detector
// case.

test('the NUL-byte guard actually detects an inserted NUL byte (self-check)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-no-nul-bytes-'));
  try {
    const cleanPath = join(dir, 'clean.mts');
    const dirtyPath = join(dir, 'dirty.mts');
    writeFileSync(cleanPath, 'export const ok = "no nul bytes here";\n');
    writeFileSync(dirtyPath, Buffer.from('export const bad = "a\0b";\n'));
    assert.equal(containsNulByte(readFileSync(cleanPath)), false);
    assert.equal(containsNulByte(readFileSync(dirtyPath)), true);
    // A NUL deep in a large file is found too, not only one in a header.
    const largePath = join(dir, 'large.mts');
    writeFileSync(
      largePath,
      Buffer.concat([
        Buffer.from('a'.repeat(20000)),
        Buffer.from([0]),
        Buffer.from('b'),
      ]),
    );
    assert.equal(containsNulByte(readFileSync(largePath)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
