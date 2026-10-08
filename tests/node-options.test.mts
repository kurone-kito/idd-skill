import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const nodeOptions = createRequire(import.meta.url)('./node-options.cjs') as {
  appendNodeOptionsPreload: (
    source: string,
    flag: string,
    value: string,
    cwd: string,
    knownFlags?: string[],
  ) => string;
  hasNodeOptionsPreload: (
    source: string | string[],
    expected: string,
    cwd: string,
    flags: string[],
  ) => boolean;
  normalizeNodeOptionsImports: (source: string, cwd: string) => string;
  removeNodeOptionsPreload: (
    source: string,
    expected: string,
    cwd: string,
    flags: string[],
  ) => string;
  tokenizeNodeOptions: (source: string) => string[];
};

test('NODE_OPTIONS preload matching accepts exact separate and equals forms', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-node-options-match-'));
  try {
    const preload = join(cwd, 'guard.mjs');
    const options = `--trace-warnings --import "${preload}"`;
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(options, preload, cwd, ['--import']),
      true,
    );
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(`--import=${preload}`, preload, cwd, [
        '--import',
      ]),
      true,
    );
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(
        `--import=${preload}-shadow.mjs`,
        preload,
        cwd,
        ['--import'],
      ),
      false,
    );
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(
        `--require=${preload}.shadow`,
        preload,
        cwd,
        ['--require'],
      ),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('relative NODE_OPTIONS imports are resolved against the child cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-node-options-cwd-'));
  try {
    const expected = pathToFileURL(resolve(cwd, 'preloads/relative.mjs')).href;
    const normalized = nodeOptions.normalizeNodeOptionsImports(
      '--trace-warnings --import ./preloads/relative.mjs --import=../shared.mjs',
      cwd,
    );
    assert.deepEqual(nodeOptions.tokenizeNodeOptions(normalized), [
      '--trace-warnings',
      '--import',
      expected,
      `--import=${pathToFileURL(resolve(cwd, '../shared.mjs')).href}`,
    ]);
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(normalized, expected, cwd, [
        '--import',
      ]),
      true,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('appending and removing preloads preserve quoted paths with spaces', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-node-options-space-'));
  try {
    const preload = join(cwd, 'a directory', 'guard.cjs');
    const appended = nodeOptions.appendNodeOptionsPreload(
      '--trace-warnings',
      '--require',
      preload,
      cwd,
      ['--require', '--import'],
    );
    assert.deepEqual(nodeOptions.tokenizeNodeOptions(appended), [
      '--trace-warnings',
      '--require',
      preload,
    ]);
    assert.equal(
      nodeOptions.hasNodeOptionsPreload(appended, preload, cwd, [
        '--require',
        '--import',
      ]),
      true,
    );
    assert.equal(
      nodeOptions.removeNodeOptionsPreload(appended, preload, cwd, [
        '--require',
      ]),
      '--trace-warnings',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
