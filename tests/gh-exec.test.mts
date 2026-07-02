import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ghApiJson,
  ghText,
  isCliExecution,
  safeGhText,
} from '../src/scripts/gh-exec.mts';

// Stub `gh` on PATH (the discover-roadmap-graph.test.mts / post-idd-marker.test.mts
// pattern) so every scenario below exercises the real execFileSync + child-process
// contract without network access. Returns a cleanup callback that restores PATH;
// callers must invoke it (ideally in a `finally`) even when the assertion throws.
function stubGh(scriptBody: string): () => void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempRoot}:${originalPath ?? ''}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

test('ghText trims stdout and forwards argv to gh', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('  hello world  \\n');
`);
  try {
    const result = ghText(['repo', 'view', '--json', 'name']);
    assert.equal(result, 'hello world');
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'repo',
      'view',
      '--json',
      'name',
    ]);
  } finally {
    restore();
  }
});

test('ghText accepts a stdio override without changing the trimmed result', () => {
  const restore = stubGh(`process.stdout.write('  ok  \\n');`);
  try {
    const result = ghText(['repo', 'view'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result, 'ok');
  } finally {
    restore();
  }
});

test('ghText throws on a non-zero gh exit', () => {
  const restore = stubGh(`
process.stderr.write('boom');
process.exit(1);
`);
  try {
    assert.throws(() => ghText(['repo', 'view']));
  } finally {
    restore();
  }
});

test('safeGhText returns the trimmed value on success', () => {
  const restore = stubGh(`process.stdout.write('fine\\n');`);
  try {
    assert.equal(safeGhText(['repo', 'view']), 'fine');
  } finally {
    restore();
  }
});

test('safeGhText swallows a gh failure and returns an empty string', () => {
  const restore = stubGh(`process.exit(1);`);
  try {
    assert.equal(safeGhText(['repo', 'view']), '');
  } finally {
    restore();
  }
});

test('ghApiJson (non-paginated) parses the raw JSON object', () => {
  const restore = stubGh(`process.stdout.write(JSON.stringify({ id: 42 }));`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1'), { id: 42 });
  } finally {
    restore();
  }
});

test('ghApiJson (non-paginated) falls back to {} on empty stdout', () => {
  const restore = stubGh(`process.stdout.write('');`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1'), {});
  } finally {
    restore();
  }
});

test('ghApiJson forwards extraArgs after the API path', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{}');
`);
  try {
    ghApiJson('repos/o/r/issues/1', { extraArgs: ['--jq', '.title'] });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'repos/o/r/issues/1',
      '--jq',
      '.title',
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) parses NDJSON output, flattening array lines', () => {
  const restore = stubGh(`
process.stdout.write([JSON.stringify([{ id: 1 }, { id: 2 }]), JSON.stringify({ id: 3 })].join('\\n'));
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) forwards --paginate --jq .[] and returns [] on empty output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('');
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), []);
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'repos/o/r/issues',
      '--paginate',
      '--jq',
      '.[]',
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson tolerates an allow-listed failure status and parses its stdout', () => {
  const restore = stubGh(`
process.stdout.write(JSON.stringify({ tolerated: true }));
process.exit(1);
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }), {
      tolerated: true,
    });
  } finally {
    restore();
  }
});

test('ghApiJson rethrows a failure status that is not in allowStatuses', () => {
  const restore = stubGh(`
process.stdout.write(JSON.stringify({ tolerated: true }));
process.exit(2);
`);
  try {
    assert.throws(() =>
      ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }),
    );
  } finally {
    restore();
  }
});

test('ghApiJson rethrows an allow-listed failure whose stdout is not JSON-shaped', () => {
  const restore = stubGh(`
process.stdout.write('not json');
process.exit(1);
`);
  try {
    assert.throws(() =>
      ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }),
    );
  } finally {
    restore();
  }
});

test('isCliExecution is true when moduleUrl resolves to the live process entry point', () => {
  const originalArgv1 = process.argv[1];
  process.argv[1] = '/tmp/example/entry.mjs';
  try {
    assert.equal(isCliExecution('file:///tmp/example/entry.mjs'), true);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test('isCliExecution is false for an unrelated moduleUrl or a missing argv[1]', () => {
  const originalArgv1 = process.argv[1];
  process.argv[1] = '/tmp/example/entry.mjs';
  try {
    assert.equal(isCliExecution('file:///tmp/example/other.mjs'), false);
    process.argv[1] = undefined as unknown as string;
    assert.equal(isCliExecution('file:///tmp/example/entry.mjs'), false);
  } finally {
    process.argv[1] = originalArgv1;
  }
});
