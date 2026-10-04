import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertSucceeded,
  buildArtifacts,
  chunkByArgumentLength,
  normalizeWithBiome,
  type ProcessRunner,
  parseEmittedFiles,
  type RunResult,
  rewriteGitattributesBlock,
  runTsc,
  StageError,
  spawnRunner,
} from '../src/scripts/build-ts.mts';

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

// ---------------------------------------------------------------------------
// The tsc emit and Biome normalization shared with check-build-artifacts.mts.
// Everything below drives the real functions through a fake ProcessRunner and
// a fake bin resolver, so it needs neither node_modules (the bare-node lane)
// nor a real tsc/Biome.
// ---------------------------------------------------------------------------

const FAKE_TSC = '/fake/node_modules/typescript/bin/tsc';
const FAKE_BIOME = '/fake/node_modules/@biomejs/biome/bin/biome';

const resolveBin = (packageName: string): string =>
  packageName === 'typescript' ? FAKE_TSC : FAKE_BIOME;

const ok = (stdout = ''): RunResult => ({
  signal: null,
  status: 0,
  stderr: Buffer.alloc(0),
  stdout: Buffer.from(stdout),
});

interface Call {
  args: readonly string[];
  command: string;
  options: { cwd: string; input?: Buffer };
}

function recordingRunner(results: RunResult[]): {
  calls: Call[];
  run: ProcessRunner;
} {
  const calls: Call[] = [];
  const queue = [...results];
  return {
    calls,
    run: (command, args, options) => {
      calls.push({ args, command, options });
      return queue.shift() ?? ok();
    },
  };
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'idd build ts test '));
  try {
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('parseEmittedFiles keeps only TSFILE .mjs lines and tolerates CRLF', () => {
  assert.deepEqual(
    parseEmittedFiles(
      'TSFILE: /a b/scripts/x.mjs\r\nTSFILE: /a b/scripts/x.d.mts\r\nnoise\r\nTSFILE: /a b/bin/y.mjs\n',
    ),
    ['/a b/scripts/x.mjs', '/a b/bin/y.mjs'],
  );
});

test('chunkByArgumentLength splits in order, bounds every chunk, and never drops an item', () => {
  assert.deepEqual(chunkByArgumentLength([]), []);
  const items = Array.from(
    { length: 5000 },
    (_, index) =>
      `C:\\Users\\runner admin\\Temp\\idd-build-check-${index}\\scripts\\a-long-helper-name-${index}.mjs`,
  );
  const chunks = chunkByArgumentLength(items);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), items);
  for (const chunk of chunks) {
    // Far below the ~32 767 character native Windows process-line cap.
    assert.ok(chunk.join(' ').length < 8_000, `${chunk.join(' ').length}`);
  }
  assert.deepEqual(chunkByArgumentLength(['x'.repeat(50), 'y'], 10), [
    ['x'.repeat(50)],
    ['y'],
  ]);
});

test('runTsc runs the resolved JS entry through process.execPath, never a shell', () => {
  const { calls, run } = recordingRunner([ok('TSFILE: /o/scripts/a.mjs\n')]);
  const output = runTsc('/repo with spaces', {
    outDir: '/tmp/out dir',
    resolveBin,
    run,
  });
  assert.equal(output, 'TSFILE: /o/scripts/a.mjs\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, process.execPath);
  assert.deepEqual(calls[0]?.args, [
    FAKE_TSC,
    '-p',
    'tsconfig.build.json',
    '--listEmittedFiles',
    '--outDir',
    '/tmp/out dir',
  ]);
  assert.deepEqual(calls[0]?.options, { cwd: '/repo with spaces' });
});

test('runTsc without an outDir emits in place (no --outDir)', () => {
  const { calls, run } = recordingRunner([ok()]);
  runTsc('/repo', { resolveBin, run });
  assert.ok(!calls[0]?.args.includes('--outDir'));
});

test('normalizeWithBiome batches argv, runs from the root, and skips an empty list', () => {
  const files = Array.from(
    { length: 1500 },
    (_, index) => `/tmp/idd-build-check-x/scripts/helper-${index}.mjs`,
  );
  const { calls, run } = recordingRunner([]);
  normalizeWithBiome(files, '/repo', { resolveBin, run });
  assert.ok(calls.length > 1);
  assert.deepEqual(
    calls.flatMap((call) => call.args.slice(4)),
    files,
  );
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args.slice(0, 4), [
      FAKE_BIOME,
      'check',
      '--write',
      '--vcs-enabled=false',
    ]);
    assert.deepEqual(call.options, { cwd: '/repo' });
    assert.ok(call.args.join(' ').length < 9_000);
  }
  const none = recordingRunner([]);
  assert.equal(
    normalizeWithBiome([], '/repo', { resolveBin, run: none.run }),
    '',
  );
  assert.equal(none.calls.length, 0);
});

test('assertSucceeded rejects a spawn error, a signal, and a non-zero exit with the tool output', () => {
  const failed = (extra: Partial<RunResult>): RunResult => ({
    ...ok(),
    ...extra,
  });
  assert.throws(
    () =>
      assertSucceeded(
        'tsc',
        'tsc emit',
        failed({ error: new Error('spawn ENOENT'), status: null }),
      ),
    /failed to start: spawn ENOENT/,
  );
  assert.throws(
    () =>
      assertSucceeded(
        'tsc',
        'tsc emit',
        failed({ signal: 'SIGKILL', status: null }),
      ),
    /killed by SIGKILL/,
  );
  try {
    assertSucceeded(
      'tsc',
      'tsc emit',
      failed({
        status: 1,
        stderr: Buffer.from('err\n'),
        stdout: Buffer.from('src/a.mts(1,1): error TS2322\n'),
      }),
    );
    assert.fail('expected a StageError');
  } catch (error) {
    assert.ok(error instanceof StageError);
    assert.equal(error.stage, 'tsc');
    assert.match(error.message, /exited 1/);
    assert.equal(error.output, 'src/a.mts(1,1): error TS2322\nerr\n');
  }
  assertSucceeded('tsc', 'tsc emit', ok());
});

const GITATTRIBUTES_BODY = [
  '* text=auto eol=lf',
  'scripts/stale.mjs linguist-generated=true',
  '',
].join('\n');

function seedRoot(root: string): void {
  mkdirSync(join(root, 'scripts'));
  writeFileSync(
    join(root, 'scripts', 'fresh.mjs'),
    '// idd-generated-from: src/scripts/fresh.mts\n',
  );
  writeFileSync(join(root, '.gitattributes'), GITATTRIBUTES_BODY);
}

test('buildArtifacts emits in place, normalizes only the listed files, then syncs .gitattributes', () => {
  withTempRoot((root) => {
    seedRoot(root);
    const { calls, run } = recordingRunner([
      ok(`TSFILE: ${join(root, 'scripts', 'fresh.mjs')}\n`),
      ok('Checked 1 file\n'),
    ]);
    assert.equal(buildArtifacts(root, { resolveBin, run }), 'Checked 1 file\n');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.args.at(-1), join(root, 'scripts', 'fresh.mjs'));
    assert.equal(
      readFileSync(join(root, '.gitattributes'), 'utf8'),
      '* text=auto eol=lf\nscripts/fresh.mjs linguist-generated=true\n',
    );
  });
});

test('a tsc failure stops build() before Biome and before .gitattributes is touched', () => {
  withTempRoot((root) => {
    seedRoot(root);
    const { calls, run } = recordingRunner([
      { ...ok('src/a.mts(1,1): error TS2322\n'), status: 1 },
    ]);
    assert.throws(
      () => buildArtifacts(root, { resolveBin, run }),
      (error: unknown) =>
        error instanceof StageError &&
        error.stage === 'tsc' &&
        error.output.includes('TS2322'),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      readFileSync(join(root, '.gitattributes'), 'utf8'),
      GITATTRIBUTES_BODY,
    );
  });
});

test('a Biome failure stops build() before .gitattributes is touched', () => {
  withTempRoot((root) => {
    seedRoot(root);
    const { run } = recordingRunner([
      ok(`TSFILE: ${join(root, 'scripts', 'fresh.mjs')}\n`),
      { ...ok(), status: 1, stderr: Buffer.from('lint error\n') },
    ]);
    assert.throws(
      () => buildArtifacts(root, { resolveBin, run }),
      (error: unknown) =>
        error instanceof StageError &&
        error.stage === 'biome' &&
        error.output === 'lint error\n',
    );
    assert.equal(
      readFileSync(join(root, '.gitattributes'), 'utf8'),
      GITATTRIBUTES_BODY,
    );
  });
});

test('a failing Biome chunk does not stop the later chunks, and the error carries every chunk output', () => {
  const files = Array.from(
    { length: 1500 },
    (_, index) => `/tmp/idd-build-check-x/scripts/helper-${index}.mjs`,
  );
  const failing = (text: string): RunResult => ({
    ...ok(),
    status: 1,
    stdout: Buffer.from(text),
  });
  const { calls, run } = recordingRunner([
    failing('first chunk failed\n'),
    ok('second chunk fine\n'),
    ok('third chunk fine\n'),
    ok('fourth chunk fine\n'),
    ok('fifth chunk fine\n'),
    ok('sixth chunk fine\n'),
    ok('seventh chunk fine\n'),
    ok('eighth chunk fine\n'),
  ]);
  assert.throws(
    () => normalizeWithBiome(files, '/repo', { resolveBin, run }),
    (error: unknown) =>
      error instanceof StageError &&
      error.stage === 'biome' &&
      /exited 1/.test(error.message) &&
      error.output.includes('first chunk failed') &&
      error.output.includes('second chunk fine'),
  );
  assert.equal(calls.length, chunkByArgumentLength(files).length);
  assert.ok(calls.length > 1);
});

test('a Biome spawn error stops at once instead of repeating for every chunk', () => {
  const files = Array.from(
    { length: 1500 },
    (_, index) => `/tmp/x/${index}.mjs`,
  );
  const { calls, run } = recordingRunner([
    { ...ok(), error: new Error('spawn ENOENT'), status: null },
  ]);
  assert.throws(
    () => normalizeWithBiome(files, '/repo', { resolveBin, run }),
    /failed to start/,
  );
  assert.equal(calls.length, 1);
});

// The real runner, not a fake: it must pass argv through untouched (a shell
// would mangle `&`, quotes and spaces, and on Windows `.CMD` lookup would
// differ) and must not die on output past spawnSync's 1 MiB default.
test('spawnRunner passes argv without a shell and survives output over 1 MiB', () => {
  const argument = 'a & "b" c|d %PATH% $HOME';
  const echoed = spawnRunner(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', argument],
    { cwd: tmpdir() },
  );
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout.toString('utf8'), argument);
  const big = spawnRunner(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024))"],
    { cwd: tmpdir() },
  );
  assert.equal(big.status, 0);
  assert.equal(big.error, undefined);
  assert.equal(big.stdout.length, 3 * 1024 * 1024);
  const failed = spawnRunner(process.execPath, ['-e', 'process.exit(3)'], {
    cwd: tmpdir(),
  });
  assert.equal(failed.status, 3);
});
