import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildArtifacts,
  normalizeWithBiome,
  type ProcessRunner,
  type RunResult,
  StageError,
} from '../src/scripts/build-ts.mts';
import {
  type ArtifactSnapshot,
  compareArtifacts,
  expectedArtifactPaths,
  type FileKind,
  type Finding,
  formatFindings,
  listHeadEntries,
  parseCatFileBatch,
  readHeadSnapshot,
  removeTempDir,
  TEMP_REMOVE_OPTIONS,
  verifyBuildArtifacts,
} from '../src/scripts/check-build-artifacts.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(REPO_ROOT, 'src', 'scripts', 'check-build-artifacts.mts');

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
const map = (entries: Record<string, string>): ReadonlyMap<string, Buffer> =>
  new Map(Object.entries(entries).map(([path, text]) => [path, bytes(text)]));

const kindsByPath = (findings: readonly Finding[]): string[] =>
  findings.map((finding) => `${finding.path}=${finding.kind}`);

// ---------------------------------------------------------------------------
// compareArtifacts: every failure mode as a pure input -> findings table.
// ---------------------------------------------------------------------------

const CLEAN: ArtifactSnapshot = {
  committed: map({
    '.gitattributes': 'a\n',
    'bin/b.mjs': 'b\n',
    'scripts/a.mjs': 'a\n',
  }),
  emitted: map({
    '.gitattributes': 'a\n',
    'bin/b.mjs': 'b\n',
    'scripts/a.mjs': 'a\n',
  }),
  expectedPaths: ['bin/b.mjs', 'scripts/a.mjs'],
  working: map({
    '.gitattributes': 'a\n',
    'bin/b.mjs': 'b\n',
    'scripts/a.mjs': 'a\n',
  }),
};

test('compareArtifacts: a fresh emit equal to HEAD and the working tree has no findings', () => {
  assert.deepEqual(compareArtifacts(CLEAN), []);
});

test('compareArtifacts: committed drift names the path and the first differing line', () => {
  const findings = compareArtifacts({
    ...CLEAN,
    committed: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'one\ntwo\nold\n',
    }),
    emitted: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'one\ntwo\nnew\n',
    }),
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/a.mjs=drift']);
  assert.match(findings[0]?.detail ?? '', /first difference at line 3/);
  assert.match(findings[0]?.detail ?? '', /committed: old/);
  assert.match(findings[0]?.detail ?? '', /fresh:\s+new/);
});

test('compareArtifacts: a regenerated but uncommitted artifact says to commit it', () => {
  const findings = compareArtifacts({
    ...CLEAN,
    emitted: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'regenerated\n',
    }),
    working: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'regenerated\n',
    }),
  });
  assert.match(
    findings[0]?.detail ?? '',
    /already matches a fresh build: commit it/,
  );
});

test('compareArtifacts: a new source with no committed output, a missing output and a stale artifact', () => {
  const findings = compareArtifacts({
    committed: map({
      '.gitattributes': 'a\n',
      'scripts/gone.mjs': 'gone\n',
    }),
    emitted: map({ '.gitattributes': 'a\n', 'scripts/new.mjs': 'new\n' }),
    expectedPaths: ['scripts/missing.mjs', 'scripts/new.mjs'],
    working: map({ '.gitattributes': 'a\n', 'scripts/gone.mjs': 'gone\n' }),
  });
  assert.deepEqual(kindsByPath(findings), [
    'scripts/gone.mjs=not-emitted',
    'scripts/missing.mjs=no-output',
    'scripts/new.mjs=not-committed',
  ]);
});

test('compareArtifacts: an artifact only in the working tree (untracked or staged) with no source is flagged', () => {
  const findings = compareArtifacts({
    ...CLEAN,
    working: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
      'scripts/orphan.mjs': 'x\n',
    }),
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/orphan.mjs=not-emitted']);
  assert.match(findings[0]?.detail ?? '', /untracked or only staged/);
});

test('compareArtifacts: an artifact whose name holds a newline is still an artifact', () => {
  const name = 'scripts/foo\n.mjs';
  const committedOnly = compareArtifacts({
    ...CLEAN,
    committed: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
      [name]: 'x\n',
    }),
    working: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
      [name]: 'x\n',
    }),
  });
  // Pins the committed-side path only; the on-disk half below carries the
  // dot-all fix, because the committed side is never pattern-filtered here.
  assert.deepEqual(kindsByPath(committedOnly), [`${name}=not-emitted`]);
  const workingOnly = compareArtifacts({
    ...CLEAN,
    working: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
      [name]: 'x\n',
    }),
  });
  assert.deepEqual(kindsByPath(workingOnly), [`${name}=not-emitted`]);
  // The report keeps each finding on one line.
  assert.match(
    formatFindings(workingOnly),
    /scripts\/foo\\n\.mjs: \[not-emitted\]/,
  );
});

test('compareArtifacts: a stale .gitattributes block lists the missing and unexpected lines', () => {
  const findings = compareArtifacts({
    ...CLEAN,
    committed: map({
      '.gitattributes': 'scripts/old.mjs linguist-generated=true\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
    }),
    emitted: map({
      '.gitattributes': 'scripts/a.mjs linguist-generated=true\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
    }),
    working: map({
      '.gitattributes': 'scripts/old.mjs linguist-generated=true\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'a\n',
    }),
  });
  assert.deepEqual(kindsByPath(findings), ['.gitattributes=drift']);
  assert.match(findings[0]?.detail ?? '', /missing:\s+scripts\/a\.mjs/);
  assert.match(findings[0]?.detail ?? '', /unexpected: scripts\/old\.mjs/);
});

test('compareArtifacts: local dirt is a finding even when the fresh emit matches HEAD', () => {
  const edited = compareArtifacts({
    ...CLEAN,
    working: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'scripts/a.mjs': 'hand edit\n',
    }),
  });
  assert.deepEqual(kindsByPath(edited), ['scripts/a.mjs=local-edit']);
  const deleted = compareArtifacts({
    ...CLEAN,
    working: map({ '.gitattributes': 'a\n', 'bin/b.mjs': 'b\n' }),
  });
  assert.deepEqual(kindsByPath(deleted), ['scripts/a.mjs=local-edit']);
  assert.match(deleted[0]?.detail ?? '', /nothing was restored/);
});

test('compareArtifacts: dirt in bin/ and in .gitattributes is local-edit too, edited or missing', () => {
  const withWorking = (entries: Record<string, string>): ArtifactSnapshot => ({
    ...CLEAN,
    working: map(entries),
  });
  assert.deepEqual(
    kindsByPath(
      compareArtifacts(
        withWorking({
          '.gitattributes': 'a\n',
          'bin/b.mjs': 'edited\n',
          'scripts/a.mjs': 'a\n',
        }),
      ),
    ),
    ['bin/b.mjs=local-edit'],
  );
  assert.deepEqual(
    kindsByPath(
      compareArtifacts(
        withWorking({
          '.gitattributes': 'edited\n',
          'bin/b.mjs': 'b\n',
          'scripts/a.mjs': 'a\n',
        }),
      ),
    ),
    ['.gitattributes=local-edit'],
  );
  assert.deepEqual(
    kindsByPath(
      compareArtifacts(
        withWorking({ 'bin/b.mjs': 'b\n', 'scripts/a.mjs': 'a\n' }),
      ),
    ),
    ['.gitattributes=local-edit'],
  );
});

test('compareArtifacts: a different executable bit or a symlink is local dirt even when the bytes match', () => {
  const kinds = (
    committed: Record<string, FileKind>,
    working: Record<string, FileKind>,
  ): ArtifactSnapshot['kinds'] => ({
    committed: new Map(Object.entries(committed)),
    working: new Map(Object.entries(working)),
  });
  const same = compareArtifacts({
    ...CLEAN,
    kinds: kinds({ 'bin/b.mjs': 'executable' }, { 'bin/b.mjs': 'executable' }),
  });
  assert.deepEqual(same, []);
  const bit = compareArtifacts({
    ...CLEAN,
    kinds: kinds({ 'bin/b.mjs': 'executable' }, { 'bin/b.mjs': 'file' }),
  });
  assert.deepEqual(kindsByPath(bit), ['bin/b.mjs=local-edit']);
  assert.match(bit[0]?.detail ?? '', /is file but HEAD records executable/);
  const link = compareArtifacts({
    ...CLEAN,
    kinds: kinds({ 'scripts/a.mjs': 'file' }, { 'scripts/a.mjs': 'symlink' }),
  });
  assert.deepEqual(kindsByPath(link), ['scripts/a.mjs=local-edit']);
});

test('compareArtifacts: the comparison is byte for byte (line endings and trailing spaces count)', () => {
  const differing = (fresh: string): Finding[] =>
    compareArtifacts({
      ...CLEAN,
      emitted: map({
        '.gitattributes': 'a\n',
        'bin/b.mjs': 'b\n',
        'scripts/a.mjs': fresh,
      }),
      working: CLEAN.working,
    });
  assert.deepEqual(kindsByPath(differing('a\r\n')), ['scripts/a.mjs=drift']);
  assert.deepEqual(kindsByPath(differing('a \n')), ['scripts/a.mjs=drift']);
  assert.deepEqual(kindsByPath(differing('a')), ['scripts/a.mjs=drift']);
});

test('compareArtifacts: an output outside scripts/ and bin/ is flagged, not silently skipped', () => {
  const findings = compareArtifacts({
    ...CLEAN,
    emitted: map({
      '.gitattributes': 'a\n',
      'bin/b.mjs': 'b\n',
      'lib/x.mjs': 'x\n',
      'scripts/a.mjs': 'a\n',
    }),
  });
  assert.deepEqual(kindsByPath(findings), ['lib/x.mjs=out-of-scope']);
});

test('formatFindings prints every path, its kind, and one fix hint', () => {
  const report = formatFindings([
    { detail: 'broken', kind: 'drift', path: 'scripts/a.mjs' },
  ]);
  assert.match(report, /nothing was rewritten/);
  assert.match(report, /scripts\/a\.mjs: \[drift\] broken/);
  assert.match(report, /pnpm run build/);
});

// ---------------------------------------------------------------------------
// The git side: `ls-tree` + `cat-file --batch`, parsed from bytes.
// ---------------------------------------------------------------------------

const blobHeader = (oid: string, size: number): Buffer =>
  bytes(`${oid} blob ${size}\n`);

test('parseCatFileBatch keeps newlines, empty blobs and non-UTF-8 bytes intact', () => {
  const binary = Buffer.from([0xff, 0xfe, 0x0a, 0x00, 0x80]);
  const output = Buffer.concat([
    blobHeader('a1', 6),
    bytes('x\ny\nz\n'),
    bytes('\n'),
    blobHeader('b2', 0),
    bytes('\n'),
    blobHeader('c3', binary.length),
    binary,
    bytes('\n'),
  ]);
  const blobs = parseCatFileBatch(output, 3);
  assert.equal(blobs[0]?.toString('utf8'), 'x\ny\nz\n');
  assert.equal(blobs[1]?.length, 0);
  assert.ok(blobs[2]?.equals(binary));
});

test('parseCatFileBatch rejects a missing object and truncated or malformed output', () => {
  assert.throws(
    () => parseCatFileBatch(bytes('deadbeef missing\n'), 1),
    (error: unknown) =>
      error instanceof StageError && /deadbeef is missing/.test(error.message),
  );
  assert.throws(
    () => parseCatFileBatch(bytes('a1 blob 10\nshort'), 1),
    StageError,
  );
  assert.throws(
    () => parseCatFileBatch(bytes('a1 blob nope\n'), 1),
    StageError,
  );
  assert.throws(() => parseCatFileBatch(Buffer.alloc(0), 1), StageError);
});

const ok = (stdout: string | Buffer = ''): RunResult => ({
  signal: null,
  status: 0,
  stderr: Buffer.alloc(0),
  stdout: Buffer.isBuffer(stdout) ? stdout : bytes(stdout),
});

interface Call {
  args: readonly string[];
  command: string;
  options: { cwd: string; input?: Buffer };
}

test('readHeadSnapshot reads the object database through git with no shell and no index access', () => {
  const calls: Call[] = [];
  const listing = [
    '100644 blob a1\tscripts/with space.mjs',
    '100755 blob b2\tbin/run.mjs',
    '100644 blob c3\tscripts/README.md',
    '160000 commit d4\tscripts/submodule.mjs',
    '100644 blob e5\t.gitattributes',
    '',
  ].join('\0');
  const run: ProcessRunner = (command, args, options) => {
    calls.push({ args, command, options });
    return args[0] === 'ls-tree'
      ? ok(listing)
      : ok(
          Buffer.concat([
            blobHeader('a1', 2),
            bytes('A\n\n'),
            blobHeader('b2', 2),
            bytes('B\n\n'),
            blobHeader('e5', 2),
            bytes('E\n\n'),
          ]),
        );
  };
  const snapshot = readHeadSnapshot('/repo with spaces', run);
  assert.deepEqual(
    [...snapshot].map(([path, blob]) => [path, blob.toString('utf8')]),
    [
      ['scripts/with space.mjs', 'A\n'],
      ['bin/run.mjs', 'B\n'],
      ['.gitattributes', 'E\n'],
    ],
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.equal(call.options.cwd, '/repo with spaces');
  }
  assert.deepEqual(calls[0]?.args, [
    'ls-tree',
    '-r',
    '-z',
    'HEAD',
    '--',
    'scripts',
    'bin',
    '.gitattributes',
  ]);
  assert.deepEqual(calls[1]?.args, ['cat-file', '--batch']);
  assert.equal(calls[1]?.options.input?.toString('utf8'), 'a1\nb2\ne5\n');
});

test('readHeadSnapshot keeps a tracked path that contains a newline', () => {
  const run: ProcessRunner = (_command, args) =>
    args[0] === 'ls-tree'
      ? ok('100644 blob a1\tscripts/foo\n.mjs\0')
      : ok(Buffer.concat([blobHeader('a1', 2), bytes('X\n'), bytes('\n')]));
  assert.deepEqual(
    [...readHeadSnapshot('/repo', run).keys()],
    ['scripts/foo\n.mjs'],
  );
});

test('listHeadEntries records the executable bit and symlinks from the tree mode', () => {
  const run: ProcessRunner = () =>
    ok(
      [
        '100644 blob a1\tscripts/plain.mjs',
        '100755 blob b2\tbin/shim.mjs',
        '120000 blob c3\tscripts/link.mjs',
        '',
      ].join('\0'),
    );
  assert.deepEqual(
    listHeadEntries('/repo', run).map((entry) => [entry.path, entry.kind]),
    [
      ['scripts/plain.mjs', 'file'],
      ['bin/shim.mjs', 'executable'],
      ['scripts/link.mjs', 'symlink'],
    ],
  );
});

test('readHeadSnapshot surfaces an unborn HEAD as a git stage error', () => {
  const run: ProcessRunner = () => ({
    ...ok(),
    status: 128,
    stderr: bytes('fatal: Not a valid object name HEAD\n'),
  });
  assert.throws(
    () => readHeadSnapshot('/repo', run),
    (error: unknown) =>
      error instanceof StageError &&
      error.stage === 'git' &&
      /Not a valid object name HEAD/.test(error.output),
  );
});

test('readHeadSnapshot fails loudly when git cat-file fails', () => {
  const run: ProcessRunner = (_command, args) =>
    args[0] === 'ls-tree'
      ? ok('100644 blob a1\tscripts/a.mjs\0')
      : { ...ok(), status: 1, stderr: bytes('fatal: bad object\n') };
  assert.throws(
    () => readHeadSnapshot('/repo', run),
    (error: unknown) =>
      error instanceof StageError &&
      error.stage === 'git' &&
      /bad object/.test(error.output),
  );
});

test('expectedArtifactPaths maps every src/**/*.mts to its generated .mjs', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd expected paths '));
  try {
    mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
    mkdirSync(join(root, 'src', 'bin'), { recursive: true });
    for (const file of [
      'src/scripts/a.mts',
      'src/bin/b.mts',
      'src/scripts/types.d.mts',
      'src/scripts/notes.txt',
    ]) {
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(expectedArtifactPaths(root), [
      'bin/b.mjs',
      'scripts/a.mjs',
    ]);
    assert.deepEqual(expectedArtifactPaths(join(root, 'absent')), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Orchestration through a fake runner: no tsc, Biome or real git needed, so
// this also runs in the toolless bare-node lane.
// ---------------------------------------------------------------------------

const BANNER = '// idd-generated-from: src/scripts/a.mts\n';
const FAKE_BIN = (name: string): string => `/fake/${name}.js`;

function fakeToolchain(options: {
  /** The HEAD `.gitattributes`; `null` leaves it out of HEAD entirely. */
  attributes?: string | null;
  committed: string;
  emitted: string;
}): {
  calls: Call[];
  run: ProcessRunner;
} {
  const calls: Call[] = [];
  const run: ProcessRunner = (command, args, callOptions) => {
    calls.push({ args, command, options: callOptions });
    if (command === process.execPath && args[0] === FAKE_BIN('typescript')) {
      const outDir = args[args.indexOf('--outDir') + 1] ?? '';
      mkdirSync(join(outDir, 'scripts'), { recursive: true });
      writeFileSync(join(outDir, 'scripts', 'a.mjs'), options.emitted);
      return ok();
    }
    if (command === process.execPath) {
      return ok('Checked 1 file\n');
    }
    const attributes =
      options.attributes === undefined
        ? 'scripts/a.mjs linguist-generated=true\n'
        : options.attributes;
    if (args[0] === 'ls-tree') {
      return ok(
        [
          '100644 blob h1\tscripts/a.mjs',
          ...(attributes === null ? [] : ['100644 blob h2\t.gitattributes']),
          '',
        ].join('\0'),
      );
    }
    return ok(
      Buffer.concat([
        blobHeader('h1', Buffer.byteLength(options.committed)),
        bytes(options.committed),
        bytes('\n'),
        ...(attributes === null
          ? []
          : [
              blobHeader('h2', Buffer.byteLength(attributes)),
              bytes(attributes),
              bytes('\n'),
            ]),
      ]),
    );
  };
  return { calls, run };
}

function withFakeRoot(
  verify: (root: string, tmpRoot: string) => void,
  workingCopy: string,
): void {
  const parent = mkdtempSync(join(tmpdir(), 'idd verify fake '));
  const root = join(parent, 'repo');
  const tmpRoot = join(parent, 'tmp');
  try {
    mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    mkdirSync(tmpRoot);
    writeFileSync(join(root, 'src', 'scripts', 'a.mts'), BANNER);
    writeFileSync(join(root, 'scripts', 'a.mjs'), workingCopy);
    writeFileSync(
      join(root, '.gitattributes'),
      'scripts/a.mjs linguist-generated=true\n',
    );
    verify(root, tmpRoot);
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
}

test('verifyBuildArtifacts emits to a temp dir outside the checkout and removes it', () => {
  const text = `${BANNER}export {};\n`;
  withFakeRoot((root, tmpRoot) => {
    const { calls, run } = fakeToolchain({ committed: text, emitted: text });
    const result = verifyBuildArtifacts({
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(result, { findings: [], warnings: [] });
    assert.deepEqual(readdirSync(tmpRoot), []);
    const tsc = calls.find((call) => call.args.includes('--outDir'));
    const outDir = tsc?.args[tsc.args.indexOf('--outDir') + 1] ?? '';
    assert.ok(outDir.startsWith(tmpRoot));
    assert.ok(!outDir.startsWith(root));
    // The only writes under the root would come from the tools; none ran there.
    assert.equal(readFileSync(join(root, 'scripts', 'a.mjs'), 'utf8'), text);
    // Every process is `process.execPath` or `git` (the real runner never
    // sets `shell`; see tests/build-ts.test.mts).
    for (const call of calls) {
      assert.ok(call.command === process.execPath || call.command === 'git');
    }
  }, text);
});

test('verifyBuildArtifacts reports drift and local dirt without touching the checkout', () => {
  const committed = `${BANNER}export const v = 1;\n`;
  const emitted = `${BANNER}export const v = 2;\n`;
  withFakeRoot((root, tmpRoot) => {
    const { run } = fakeToolchain({ committed, emitted });
    const { findings } = verifyBuildArtifacts({
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(kindsByPath(findings), ['scripts/a.mjs=drift']);
    assert.equal(
      readFileSync(join(root, 'scripts', 'a.mjs'), 'utf8'),
      committed,
    );
    assert.deepEqual(readdirSync(tmpRoot), []);
  }, committed);
  const text = `${BANNER}export {};\n`;
  withFakeRoot((root, tmpRoot) => {
    const { run } = fakeToolchain({ committed: text, emitted: text });
    const { findings } = verifyBuildArtifacts({
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(kindsByPath(findings), ['scripts/a.mjs=local-edit']);
    assert.equal(
      readFileSync(join(root, 'scripts', 'a.mjs'), 'utf8'),
      'hand edit\n',
    );
  }, 'hand edit\n');
});

test('a HEAD without .gitattributes, or without the generated block, is a finding, not a pass', () => {
  const text = `${BANNER}export {};\n`;
  withFakeRoot((root, tmpRoot) => {
    const { run } = fakeToolchain({
      attributes: null,
      committed: text,
      emitted: text,
    });
    const { findings } = verifyBuildArtifacts({
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(kindsByPath(findings), ['.gitattributes=not-committed']);
  }, text);
  withFakeRoot((root, tmpRoot) => {
    const { run } = fakeToolchain({
      attributes: '* text=auto eol=lf\n',
      committed: text,
      emitted: text,
    });
    const { findings } = verifyBuildArtifacts({
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(kindsByPath(findings), ['.gitattributes=drift']);
    assert.match(
      findings[0]?.detail ?? '',
      /no scripts\/\*\.mjs linguist-generated block/,
    );
  }, text);
});

test('a tool failure keeps the cleanup warning instead of dropping it with the error', () => {
  withFakeRoot((root, tmpRoot) => {
    const run: ProcessRunner = () => ({
      ...ok('src/a.mts(1,1): error TS2322\n'),
      status: 1,
    });
    assert.throws(
      () =>
        verifyBuildArtifacts({
          remove: () => {
            throw new Error('EBUSY: resource busy');
          },
          resolveBin: FAKE_BIN,
          root,
          run,
          tmpRoot,
        }),
      (error: unknown) =>
        error instanceof StageError &&
        error.stage === 'tsc' &&
        error.output.includes('TS2322') &&
        /warning: could not remove the temporary directory .*EBUSY/.test(
          error.output,
        ),
    );
  }, 'x\n');
});

test('a tool failure stops the verifier with a stage error and still removes the temp dir', () => {
  withFakeRoot((root, tmpRoot) => {
    const run: ProcessRunner = () => ({
      ...ok('src/a.mts(1,1): error TS2322\n'),
      status: 1,
    });
    assert.throws(
      () => verifyBuildArtifacts({ resolveBin: FAKE_BIN, root, run, tmpRoot }),
      (error: unknown) =>
        error instanceof StageError &&
        error.stage === 'tsc' &&
        error.output.includes('TS2322'),
    );
    assert.deepEqual(readdirSync(tmpRoot), []);
  }, 'x\n');
});

test('removeTempDir is a bounded best effort: a failure is a warning, never a throw', () => {
  assert.equal(
    removeTempDir('/x', () => undefined),
    undefined,
  );
  const warning = removeTempDir('/x', () => {
    throw new Error('EBUSY: resource busy');
  });
  assert.match(warning ?? '', /could not remove the temporary directory \/x/);
  assert.match(warning ?? '', /EBUSY/);
  withFakeRoot((root, tmpRoot) => {
    const text = `${BANNER}export {};\n`;
    const { run } = fakeToolchain({ committed: text, emitted: text });
    const result = verifyBuildArtifacts({
      remove: () => {
        throw new Error('EPERM');
      },
      resolveBin: FAKE_BIN,
      root,
      run,
      tmpRoot,
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.warnings.length, 1);
  }, `${BANNER}export {};\n`);
});

test('the default temp removal retries a bounded number of times', () => {
  assert.ok(TEMP_REMOVE_OPTIONS.recursive && TEMP_REMOVE_OPTIONS.force);
  assert.ok(TEMP_REMOVE_OPTIONS.maxRetries >= 1);
  assert.ok(TEMP_REMOVE_OPTIONS.maxRetries <= 10);
  assert.ok(TEMP_REMOVE_OPTIONS.retryDelay <= 1000);
});

test('build:check runs both checks from their .mts sources and never builds', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const steps = (scripts['build:check'] ?? '').split(' && ');
  assert.deepEqual(steps, [
    'node src/scripts/check-build-artifacts.mts',
    'node src/scripts/check-untracked-artifacts.mts',
  ]);
  for (const step of steps) {
    assert.ok(!step.includes('pnpm run build'));
    assert.ok(!/scripts\/[^/]+\.mjs/.test(step.replace('src/scripts/', '')));
  }
});

// ---------------------------------------------------------------------------
// Real git + real tsc + real Biome against throwaway fixture repositories.
// Skipped when the tools are not installed (the toolless bare-node lane).
// ---------------------------------------------------------------------------

const requireFromHere = createRequire(import.meta.url);
function toolsInstalled(): boolean {
  try {
    requireFromHere.resolve('typescript/package.json');
    requireFromHere.resolve('@biomejs/biome/package.json');
    return true;
  } catch {
    return false;
  }
}
const SKIP = toolsInstalled()
  ? false
  : 'typescript and @biomejs/biome are not installed (bare-node lane)';

// `node:os`'s `devNull` is `\\.\nul` on win32, which Git for Windows rejects as
// a GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM value; the bare `NUL` is what it
// accepts (same constant as tests/test-utils.mts, kurone-kito/idd-skill#2570).
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

// Fixture git processes must never read the developer's config or an ambient
// GIT_DIR from a hook. The verifier spawns `git` with this process's env, so
// scrub it here; each test file runs in its own process.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_CONFIG')) {
    delete process.env[key];
  }
}
for (const key of [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
]) {
  delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
process.env.GIT_CONFIG_SYSTEM = GIT_NULL_DEVICE;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message,
  );
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'idd check build artifacts '));
after(() => {
  rmSync(SCRATCH, { force: true, recursive: true });
});

const STANDALONE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    lib: ['esnext'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    noEmit: true,
    rewriteRelativeImportExtensions: true,
    skipLibCheck: true,
    strict: true,
    target: 'esnext',
    types: [],
    verbatimModuleSyntax: true,
  },
  include: ['src/**/*.mts'],
});
// `maxSize` is raised because big.mjs below is deliberately over Biome's 1 MiB
// default, above which it skips a file instead of normalizing it.
// No `extends`, no `vcs`: the repository's own config would drag in the npm
// package and its ignore-file handling, which a throwaway repo lacks.
const STANDALONE_BIOME = JSON.stringify({
  files: { includes: ['**'], maxSize: 4 * 1024 * 1024 },
  formatter: { indentStyle: 'space', indentWidth: 2 },
  javascript: { formatter: { quoteStyle: 'single' } },
});

const banner = (name: string): string =>
  `// idd-generated-from: src/${name}.mts\n`;

let template: string | undefined;
function templateRoot(): string {
  if (template !== undefined) {
    return template;
  }
  const root = join(SCRATCH, 'template repo');
  mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'bin'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  const files: Record<string, string> = {
    '.gitattributes':
      '* text=auto eol=lf\n# Generated.\nscripts/placeholder.mjs linguist-generated=true\n',
    'biome.json': STANDALONE_BIOME,
    'src/bin/beta.mts': `${banner('bin/beta')}import { alpha } from '../scripts/alpha.mts';\nexport const beta: number = alpha + 1;\n`,
    // The double-quoted literal is rewritten to single quotes by Biome, so a
    // verifier that skipped normalization would see drift on this file.
    'src/scripts/alpha.mts': `${banner('scripts/alpha')}export const alpha: number = 1;\nexport const quoted: string = "double";\n`,
    'src/scripts/bannerless.mts': 'export const bannerless: number = 3;\n',
    // Bigger than spawnSync's 1 MiB default maxBuffer, so a runner without an
    // explicit ceiling would fail here but not on small fixtures.
    'src/scripts/big.mts': `${banner('scripts/big')}// ${'x'.repeat(1_200_000)}\nexport const big: number = 2;\n`,
    'src/scripts/check-build-artifacts.mts': `${banner('scripts/check-build-artifacts')}export const verifier: number = 4;\n`,
    'tsconfig.build.json': readFileSync(
      join(REPO_ROOT, 'tsconfig.build.json'),
      'utf8',
    ),
    'tsconfig.json': STANDALONE_TSCONFIG,
  };
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(root, path), text);
  }
  git(root, 'init', '-q');
  buildArtifacts(root);
  commitAll(root, 'initial');
  template = root;
  return root;
}

let caseCounter = 0;
interface Fixture {
  readonly root: string;
  readonly tmpRoot: string;
}
function fixture(): Fixture {
  caseCounter += 1;
  const parent = join(SCRATCH, `case ${caseCounter}`);
  const root = join(parent, 'repo with spaces');
  const tmpRoot = join(parent, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  cpSync(templateRoot(), root, { recursive: true });
  return { root, tmpRoot };
}

function digest(path: string): string {
  if (!existsSync(path)) {
    return 'absent';
  }
  return statSync(path).isDirectory()
    ? 'directory'
    : createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Tracked bytes plus the raw `.git/index` bytes, taken without running git. */
function checkoutState(root: string): Record<string, string> {
  const state: Record<string, string> = {
    index: digest(join(root, '.git', 'index')),
  };
  for (const dir of ['scripts', 'bin', 'src']) {
    for (const path of readdirSync(join(root, dir), {
      recursive: true,
      encoding: 'utf8',
    })) {
      state[`${dir}/${path}`] = digest(join(root, dir, path));
    }
  }
  for (const path of ['.gitattributes', 'biome.json', 'tsconfig.json']) {
    state[path] = digest(join(root, path));
  }
  return state;
}

/**
 * Make every index entry stat-dirty without changing a byte, so a command
 * that refreshes the index (git diff, git status) would visibly rewrite it.
 */
function touchTracked(root: string): void {
  const later = new Date(Date.now() + 10_000);
  for (const path of ['scripts/alpha.mjs', 'bin/beta.mjs', '.gitattributes']) {
    utimesSync(join(root, path), later, later);
  }
}

function assertUntouched(
  { root, tmpRoot }: Fixture,
  before: Record<string, string>,
): void {
  assert.deepEqual(checkoutState(root), before);
  assert.deepEqual(readdirSync(tmpRoot), []);
}

test('real tools: a clean fixture passes, leaves the checkout and index untouched, and cleans up', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  assert.ok(existsSync(join(fx.root, 'scripts', 'big.mjs')));
  assert.ok(
    readFileSync(join(fx.root, 'scripts', 'big.mjs')).length > 1024 * 1024,
  );
  // Biome rewrote tsc's double-quoted literal, so the clean verdict below also
  // proves the verifier normalizes its temporary emit the same way.
  assert.ok(
    readFileSync(join(fx.root, 'scripts', 'alpha.mjs'), 'utf8').includes(
      "'double'",
    ),
  );
  touchTracked(fx.root);
  const before = checkoutState(fx.root);
  const result = verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot });
  assert.deepEqual(result, { findings: [], warnings: [] });
  assertUntouched(fx, before);
  assert.equal(git(fx.root, 'status', '--porcelain'), '');
});

test('real tools: build and the verifier agree that a bannerless source is not in the .gitattributes block', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  const attributes = readFileSync(join(fx.root, '.gitattributes'), 'utf8');
  assert.ok(attributes.includes('scripts/alpha.mjs linguist-generated=true'));
  assert.ok(!attributes.includes('bannerless'));
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    [],
  );
});

test('real tools: committed artifact drift fails with the path and is not repaired', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  const target = join(fx.root, 'scripts', 'alpha.mjs');
  writeFileSync(target, `${readFileSync(target, 'utf8')}// tampered\n`);
  commitAll(fx.root, 'drift');
  const before = checkoutState(fx.root);
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/alpha.mjs=drift']);
  assert.match(findings[0]?.detail ?? '', /first difference at line/);
  assertUntouched(fx, before);
});

test('real tools: a new source with no committed output fails and writes nothing', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'src', 'scripts', 'gamma.mts'),
    `${banner('scripts/gamma')}export const gamma: number = 5;\n`,
  );
  commitAll(fx.root, 'new source only');
  const before = checkoutState(fx.root);
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), [
    '.gitattributes=drift',
    'scripts/gamma.mjs=not-committed',
  ]);
  assert.ok(!existsSync(join(fx.root, 'scripts', 'gamma.mjs')));
  assertUntouched(fx, before);
});

test('real tools: a committed artifact with no source fails', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'scripts', 'orphan.mjs'), 'export {};\n');
  commitAll(fx.root, 'orphan artifact');
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/orphan.mjs=not-emitted']);
});

test('real tools: a stale .gitattributes generated block fails', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  const path = join(fx.root, '.gitattributes');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      'scripts/alpha.mjs linguist-generated=true\n',
      '',
    ),
  );
  commitAll(fx.root, 'stale block');
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['.gitattributes=drift']);
  assert.match(findings[0]?.detail ?? '', /missing:\s+scripts\/alpha\.mjs/);
});

test('real tools: a corrupted committed copy of the verifier is reported as drift, never trusted', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'scripts', 'check-build-artifacts.mjs'),
    'process.exit(0);\n',
  );
  commitAll(fx.root, 'corrupt the committed verifier');
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), [
    'scripts/check-build-artifacts.mjs=drift',
  ]);
});

test('real tools: local generated-file dirt is reported and left exactly as it was', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  const target = join(fx.root, 'scripts', 'alpha.mjs');
  writeFileSync(target, 'export const hand = 1;\n');
  const before = checkoutState(fx.root);
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/alpha.mjs=local-edit']);
  assertUntouched(fx, before);
  assert.equal(readFileSync(target, 'utf8'), 'export const hand = 1;\n');
});

test('real tools: dirt in bin/ and .gitattributes is reported, staged or not, and left as it was', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  const beta = join(fx.root, 'bin', 'beta.mjs');
  const attributes = join(fx.root, '.gitattributes');
  writeFileSync(beta, 'export const hand = 1;\n');
  writeFileSync(attributes, `${readFileSync(attributes, 'utf8')}# local\n`);
  const unstaged = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(kindsByPath(unstaged), [
    '.gitattributes=local-edit',
    'bin/beta.mjs=local-edit',
  ]);
  git(fx.root, 'add', '-A');
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    unstaged,
  );
  assert.equal(readFileSync(beta, 'utf8'), 'export const hand = 1;\n');
});

test('real tools: a source the build emits nothing for is reported as no-output', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'src', 'scripts', 'gamma.mts'),
    `${banner('scripts/gamma')}export const gamma: number = 5;\n`,
  );
  const buildConfig = join(fx.root, 'tsconfig.build.json');
  const text = readFileSync(buildConfig, 'utf8');
  assert.ok(text.includes('"node_modules"'));
  writeFileSync(
    buildConfig,
    text.replace('"node_modules"', '"src/scripts/gamma.mts", "node_modules"'),
  );
  commitAll(fx.root, 'a source the build config excludes');
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/gamma.mjs=no-output']);
});

test('real tools: staging the regenerated files does not change the HEAD-relative verdict', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'src', 'scripts', 'alpha.mts'),
    `${banner('scripts/alpha')}export const alpha: number = 7;\n`,
  );
  buildArtifacts(fx.root);
  const unstaged = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(kindsByPath(unstaged), ['scripts/alpha.mjs=drift']);
  git(fx.root, 'add', '-A');
  const staged = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(staged, unstaged);
  git(fx.root, 'reset', '-q');
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    unstaged,
  );
});

test('real tools: an artifact with no source gives the same verdict untracked and staged', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'scripts', 'orphan.mjs'), 'export {};\n');
  const untracked = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(kindsByPath(untracked), ['scripts/orphan.mjs=not-emitted']);
  git(fx.root, 'add', '-A');
  const staged = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(staged, untracked);
});

test('real tools: a committed artifact with a newline in its name and no source fails', {
  skip:
    SKIP ||
    (process.platform === 'win32'
      ? 'win32 forbids a newline in a file name'
      : false),
}, () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'scripts', 'odd\nname.mjs'), 'export {};\n');
  commitAll(fx.root, 'newline-named artifact');
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), [
    'scripts/odd\nname.mjs=not-emitted',
  ]);
});

test('real tools: an untracked or staged artifact whose name holds a backslash is reported the same', {
  skip:
    SKIP ||
    (process.platform === 'win32'
      ? 'a backslash is a path separator on win32'
      : false),
}, () => {
  const fx = fixture();
  writeFileSync(join(fx.root, 'scripts', 'back\\slash.mjs'), 'export {};\n');
  const untracked = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(kindsByPath(untracked), [
    'scripts/back\\slash.mjs=not-emitted',
  ]);
  git(fx.root, 'add', '-A');
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    untracked,
  );
});

test('real tools: a changed executable bit is reported where git tracks it and ignored when core.fileMode is off', {
  skip:
    SKIP ||
    (process.platform === 'win32' ? 'no executable bit on win32' : false),
}, (t) => {
  const fx = fixture();
  // `git init` records core.fileMode=false on a filesystem without an
  // executable bit (FAT, some mounts); there is nothing to test there.
  if (git(fx.root, 'config', '--bool', 'core.fileMode').trim() === 'false') {
    t.skip('this filesystem does not support the executable bit');
    return;
  }
  const shim = join(fx.root, 'bin', 'beta.mjs');
  chmodSync(shim, 0o755);
  commitAll(fx.root, 'record the bin shim as executable');
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    [],
  );
  chmodSync(shim, 0o644);
  const lost = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  }).findings;
  assert.deepEqual(kindsByPath(lost), ['bin/beta.mjs=local-edit']);
  assert.match(lost[0]?.detail ?? '', /is file but HEAD records executable/);
  // git reads only the owner execute bit: group/other execute alone is plain.
  chmodSync(shim, 0o611);
  assert.deepEqual(
    kindsByPath(
      verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    ),
    ['bin/beta.mjs=local-edit'],
  );
  chmodSync(shim, 0o755);
  const gained = join(fx.root, 'scripts', 'alpha.mjs');
  chmodSync(gained, 0o755);
  assert.deepEqual(
    kindsByPath(
      verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    ),
    ['scripts/alpha.mjs=local-edit'],
  );
  git(fx.root, 'config', 'core.fileMode', 'false');
  chmodSync(shim, 0o644);
  assert.deepEqual(
    verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }).findings,
    [],
  );
});

test('real tools: a regular artifact replaced by a symlink with the same bytes is reported', {
  skip:
    SKIP ||
    (process.platform === 'win32'
      ? 'symlinks need privileges on win32'
      : false),
}, () => {
  const fx = fixture();
  const target = join(fx.root, 'scripts', 'alpha.mjs');
  const copy = join(fx.root, 'alpha-copy.mjs');
  writeFileSync(copy, readFileSync(target));
  rmSync(target);
  symlinkSync(copy, target);
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: fx.tmpRoot,
  });
  assert.deepEqual(kindsByPath(findings), ['scripts/alpha.mjs=local-edit']);
  assert.match(findings[0]?.detail ?? '', /is symlink but HEAD records file/);
});

// Pins the assumption the first review round doubted: the repository's own
// biome.json (whose files.includes lists project-relative globs) still
// normalizes files that are passed explicitly from OUTSIDE the project, which
// is how the temporary emit reaches Biome. The standalone fixture config used
// elsewhere ('**') cannot show this.
test('real tools: the repository biome.json normalizes an explicit file outside the project', {
  skip: SKIP,
}, () => {
  const outside = mkdtempSync(join(SCRATCH, 'outside the project '));
  const file = join(outside, 'scripts', 'probe.mjs');
  mkdirSync(join(outside, 'scripts'));
  writeFileSync(file, 'const   probe =   "double";\nexport {probe};\n');
  normalizeWithBiome([file], REPO_ROOT);
  const normalized = readFileSync(file, 'utf8');
  assert.match(normalized, /const probe = 'double';/);
  assert.notEqual(normalized, 'const   probe =   "double";\nexport {probe};\n');
});

test('real tools: a TypeScript error is a tsc stage error and leaves the checkout untouched', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'src', 'scripts', 'alpha.mts'),
    `${banner('scripts/alpha')}export const alpha: number = 'not a number';\n`,
  );
  const before = checkoutState(fx.root);
  assert.throws(
    () => verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }),
    (error: unknown) =>
      error instanceof StageError &&
      error.stage === 'tsc' &&
      error.output.includes('TS2322'),
  );
  assertUntouched(fx, before);
});

test('real tools: a Biome failure is a biome stage error and leaves the checkout untouched', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  // A configuration error makes Biome exit non-zero (unlike a lenient parse
  // of broken JSON, which it quietly tolerates).
  writeFileSync(join(fx.root, 'biome.json'), '{"unknownKey": 1}');
  const before = checkoutState(fx.root);
  assert.throws(
    () => verifyBuildArtifacts({ root: fx.root, tmpRoot: fx.tmpRoot }),
    (error: unknown) => error instanceof StageError && error.stage === 'biome',
  );
  assertUntouched(fx, before);
});

test('real tools: a gitignored temp dir inside the checkout still verifies under Biome VCS ignore rules', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(join(fx.root, '.gitignore'), 'inside-tmp/\n');
  writeFileSync(
    join(fx.root, 'biome.json'),
    JSON.stringify({
      files: { includes: ['**'], maxSize: 4 * 1024 * 1024 },
      formatter: { indentStyle: 'space', indentWidth: 2 },
      javascript: { formatter: { quoteStyle: 'single' } },
      vcs: { clientKind: 'git', enabled: true, useIgnoreFile: true },
    }),
  );
  commitAll(fx.root, 'enable vcs integration');
  const insideTmp = join(fx.root, 'inside-tmp');
  mkdirSync(insideTmp);
  const { findings } = verifyBuildArtifacts({
    root: fx.root,
    tmpRoot: insideTmp,
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(readdirSync(insideTmp), []);
});

test('real tools: the CLI exits 1 with the tsc diagnostics on a TypeScript error', {
  skip: SKIP,
}, () => {
  const fx = fixture();
  writeFileSync(
    join(fx.root, 'src', 'scripts', 'alpha.mts'),
    `${banner('scripts/alpha')}export const alpha: number = 'not a number';\n`,
  );
  const env = {
    ...process.env,
    TEMP: fx.tmpRoot,
    TMP: fx.tmpRoot,
    TMPDIR: fx.tmpRoot,
  };
  const result = spawnSync(process.execPath, [ENTRY], {
    cwd: fx.root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build:check: tsc emit: exited/);
  assert.match(result.stderr, /TS2322/);
  assert.deepEqual(readdirSync(fx.tmpRoot), []);
});

test('real tools: the CLI exits 0 when clean and 1 on a corrupted committed verifier, which it never runs', {
  skip: SKIP,
}, () => {
  const clean = fixture();
  const env = {
    ...process.env,
    TEMP: clean.tmpRoot,
    TMP: clean.tmpRoot,
    TMPDIR: clean.tmpRoot,
  };
  const run = (cwd: string): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [ENTRY], { cwd, encoding: 'utf8', env });
  const passed = run(clean.root);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(readdirSync(clean.tmpRoot), []);

  // The committed generated verifier is corrupted to write a sentinel and
  // exit 0. The real entry (the .mts source) must still fail on it, and the
  // corrupted copy must never be executed.
  const sentinel = join(clean.root, 'sentinel-ran');
  writeFileSync(
    join(clean.root, 'scripts', 'check-build-artifacts.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran');\nprocess.exit(0);\n`,
  );
  commitAll(clean.root, 'corrupt the committed verifier');
  const failed = run(clean.root);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /scripts\/check-build-artifacts\.mjs: \[drift\]/);
  assert.match(failed.stderr, /nothing was rewritten/);
  assert.ok(!existsSync(sentinel));
  assert.deepEqual(readdirSync(clean.tmpRoot), []);
});
