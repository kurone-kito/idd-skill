import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewriteGitattributesBlock } from '../src/scripts/build-ts.mts';

// A representative .gitattributes body: a header comment, a two-entry
// scripts/*.mjs block, then the entries the build must NOT touch — the
// idd-template/scripts/* line, the bin/**/*.mjs glob (with its own comment),
// and unrelated binary rules. The trailing '' preserves the final newline.
const FIXTURE = [
  '# Normalize line endings',
  '* text=auto eol=lf',
  '',
  '# Generated from TypeScript sources.',
  'scripts/alpha.mjs linguist-generated=true',
  'scripts/gamma.mjs linguist-generated=true',
  'idd-template/scripts/keep-me.mjs linguist-generated=true',
  '# Every bin/ shim is generated from src/bin/*.mts (whole directory).',
  'bin/**/*.mjs linguist-generated=true',
  '',
  '*.gif binary',
  '',
].join('\n');

const blockLinesOf = (body: string): string[] =>
  body
    .split('\n')
    .filter((line) =>
      /^scripts\/[^/]+\.mjs linguist-generated=true$/.test(line),
    );

const nonBlockLinesOf = (body: string): string[] =>
  body
    .split('\n')
    .filter(
      (line) => !/^scripts\/[^/]+\.mjs linguist-generated=true$/.test(line),
    );

test('rewriteGitattributesBlock is idempotent on an already-correct body', () => {
  assert.equal(
    rewriteGitattributesBlock(FIXTURE, ['alpha.mjs', 'gamma.mjs']),
    FIXTURE,
  );
});

test('rewriteGitattributesBlock inserts a newly generated script in sorted position', () => {
  const updated = rewriteGitattributesBlock(FIXTURE, [
    'alpha.mjs',
    'beta.mjs',
    'gamma.mjs',
  ]);
  assert.deepEqual(blockLinesOf(updated), [
    'scripts/alpha.mjs linguist-generated=true',
    'scripts/beta.mjs linguist-generated=true',
    'scripts/gamma.mjs linguist-generated=true',
  ]);
});

test('rewriteGitattributesBlock leaves every non-block line byte-identical', () => {
  const updated = rewriteGitattributesBlock(FIXTURE, [
    'alpha.mjs',
    'beta.mjs',
    'gamma.mjs',
  ]);
  // The header, the idd-template/scripts/* entry, the bin glob + its comment,
  // and the binary rule / trailing newline are all preserved verbatim.
  assert.deepEqual(nonBlockLinesOf(updated), [
    '# Normalize line endings',
    '* text=auto eol=lf',
    '',
    '# Generated from TypeScript sources.',
    'idd-template/scripts/keep-me.mjs linguist-generated=true',
    '# Every bin/ shim is generated from src/bin/*.mts (whole directory).',
    'bin/**/*.mjs linguist-generated=true',
    '',
    '*.gif binary',
    '',
  ]);
});

test('rewriteGitattributesBlock drops a stale entry whose script no longer exists', () => {
  const updated = rewriteGitattributesBlock(FIXTURE, ['alpha.mjs']);
  assert.deepEqual(blockLinesOf(updated), [
    'scripts/alpha.mjs linguist-generated=true',
  ]);
});

test('rewriteGitattributesBlock throws when no scripts/*.mjs block is present', () => {
  assert.throws(
    () => rewriteGitattributesBlock('* text=auto eol=lf\n', ['alpha.mjs']),
    /no scripts\/\*\.mjs linguist-generated block/,
  );
});
