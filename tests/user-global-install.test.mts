// Install and uninstall suite for issue #4243, covering
// src/scripts/user-global-install.mts and its receipt in
// src/scripts/user-global-receipt.mts.
//
// Every test runs against a sandbox HOME passed through `env` and `homedir`,
// so no test writes to the real home directory. Tests that use real symbolic
// links skip on Windows, where the no-follow opens are unavailable and the
// installer refuses before any write.
//
// The "links above the roots" tests (#4303) cover the chain from a declared
// root (HOME, or an XDG or CODEX root) down to each install root, and the
// components above that root. A link on the chain is refused by every entry
// point and changes nothing. A link above the declared root is refused too,
// unless root owns it: those tests stand in for the system with `ownedBy`, so
// they do not depend on who runs them.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import {
  assertHelperEntryClosureResolvable,
  readHelperExtraRuntimeFiles,
  resolveHelperEntryClosure,
} from '../src/scripts/helper-runtime-manifest.mts';
import { PAYLOAD_PLACEHOLDER_FIELDS } from '../src/scripts/payload-placeholders.mts';
import {
  discardPreparedCandidate,
  installPayload,
  type PrepareDistributionOptions,
  planInstall,
  planUninstall,
  prepareDistributionSet,
  type UserGlobalOptions,
  uninstallPayload,
} from '../src/scripts/user-global-install.mts';
import type { FsOps } from '../src/scripts/user-global-paths.mts';

const REPO = join(import.meta.dirname, '..');
const PACKAGE_VERSION: string = JSON.parse(
  nodeFs.readFileSync(join(REPO, 'package.json'), 'utf8'),
).version;
/** A version the package never ships, so an upgrade always targets a new directory. */
const UPGRADE_VERSION = '99.0.0';
const NO_LINKS =
  process.platform === 'win32'
    ? 'symbolic links need the no-follow opens, which Windows lacks'
    : false;
const ENTRY_RELATIVE = '.github/instructions/idd-overview-core.instructions.md';
const SKILL_RELATIVE = 'issue-authoring/SKILL.md';

/**
 * Every test here installs or uninstalls. The installer refuses on Windows
 * before any write, because the no-follow opens it needs are unavailable, so
 * each test skips there with this reason. A test that passes its own `skip`
 * option keeps it.
 */
const NO_INSTALL =
  process.platform === 'win32'
    ? 'the installer refuses on Windows before any write: no-follow opens are unavailable'
    : false;

const test = ((name: string, ...rest: unknown[]) => {
  const fn = rest[rest.length - 1] as () => void;
  const options =
    rest.length === 2 ? (rest[0] as { skip?: string | boolean }) : {};
  return nodeTest(name, { ...options, skip: NO_INSTALL || options.skip }, fn);
}) as unknown as typeof nodeTest;

const sandboxes: string[] = [];

after(() => {
  for (const dir of sandboxes) {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSandbox(prefix: string): string {
  const dir = nodeFs.mkdtempSync(join(nodeFs.realpathSync(tmpdir()), prefix));
  sandboxes.push(dir);
  return dir;
}

/** A sandbox HOME with the directories a real user already has. */
function makeHome(): string {
  const home = makeSandbox('user-global-install-');
  for (const dir of ['.local/share', '.claude', '.agents']) {
    nodeFs.mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

function optionsFor(
  home: string,
  extra: Partial<UserGlobalOptions> = {},
): UserGlobalOptions {
  return { env: { HOME: home }, homedir: home, ...extra };
}

const dataRootOf = (home: string): string =>
  join(home, '.local', 'share', 'idd-skill');
const currentOf = (home: string): string => join(dataRootOf(home), 'current');
const versionDirOf = (home: string, version = PACKAGE_VERSION): string =>
  join(dataRootOf(home), version);
const skillFileOf = (home: string, root: '.claude' | '.agents'): string =>
  join(home, root, 'skills', SKILL_RELATIVE);
const receiptOf = (home: string): string =>
  join(dataRootOf(home), 'receipt.json');

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every path under `root` with its type and content hash, for no-write checks. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of nodeFs.readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = nodeFs.lstatSync(path);
      const rel = path.slice(root.length);
      if (stat.isSymbolicLink()) {
        out.push(`${rel} -> ${nodeFs.readlinkSync(path)}`);
      } else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        visit(path);
      } else {
        out.push(`${rel} ${sha256(nodeFs.readFileSync(path))}`);
      }
    }
  };
  if (nodeFs.existsSync(root)) visit(root);
  return out;
}

function readReceiptEntries(home: string): { path: string; kind: string }[] {
  const parsed = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8'));
  return parsed.entries;
}

/** A source tree copy, so a test can change a skill file or the version. */
function copySourceTree(): string {
  const dir = makeSandbox('user-global-source-');
  for (const part of ['audit', 'idd-template', 'skills']) {
    nodeFs.cpSync(join(REPO, part), join(dir, part), { recursive: true });
  }
  return dir;
}

interface PreparedFixtureOptions {
  runtimeFile?: string;
  runtimeBytes?: Buffer;
  authoringText?: string;
}

function makePreparedSource(extra: PreparedFixtureOptions = {}): string {
  const root = makeSandbox('user-global-prepared-source-');
  const write = (path: string, content: string): void => {
    const destination = join(root, path);
    nodeFs.mkdirSync(dirname(destination), { recursive: true });
    nodeFs.writeFileSync(destination, content);
  };
  const writeBytes = (path: string, content: Buffer): void => {
    const destination = join(root, path);
    nodeFs.mkdirSync(dirname(destination), { recursive: true });
    nodeFs.writeFileSync(destination, content);
  };
  const runtimeFile = extra.runtimeFile ?? 'data/one.json';
  write(
    'package.json',
    JSON.stringify({
      name: 'idd-skill',
      version: '0.17.0',
      repository: 'github:kurone-kito/idd-skill',
    }),
  );
  write(
    'audit/sync-manifest.json',
    JSON.stringify({
      generatedBlocks: [
        {
          id: 'idd-template-core-files',
          stripPrefix: 'idd-template/',
          paths: ['idd-template/.github/instructions/core.md'],
        },
      ],
    }),
  );
  write('idd-template/.github/instructions/core.md', '# Core instructions\n');
  write('idd-template/user-global/entry.md', '# User global entry\n');
  write(
    'skills/issue-authoring/SKILL.md',
    extra.authoringText ?? '# Authoring\n',
  );
  write('skills/idd-spec-audit/SKILL.md', '# Spec audit\n');
  write(
    'src/scripts/helper-runtime-manifest.mts',
    `const EXTRA_RUNTIME_FILES = new Map<string, string[]>([\n  ['scripts/sample.mjs', ['${runtimeFile}']],\n]);\n`,
  );
  write('scripts/sample.mjs', 'export const sample = true;\n');
  if (extra.runtimeBytes === undefined) {
    write(runtimeFile, '{"prepared":true}\n');
  } else {
    writeBytes(runtimeFile, extra.runtimeBytes);
  }
  nodeFs.mkdirSync(join(root, 'schemas'), { recursive: true });
  nodeFs.copyFileSync(
    join(REPO, 'schemas/distribution-manifest.schema.json'),
    join(root, 'schemas/distribution-manifest.schema.json'),
  );
  return root;
}

function prepareOptions(
  home: string,
  sourceRoot: string,
  sourceCommit: string,
  extra: Partial<PrepareDistributionOptions> = {},
): PrepareDistributionOptions {
  return {
    ...optionsFor(home),
    sourceRoot,
    sourceCommit,
    provenance: { kind: 'archive', commit: sourceCommit },
    invocation: { command: 'scripts/sample.mjs', argv: [] },
    ...extra,
  };
}

function commitPreparedSource(source: string): string {
  for (const args of [
    ['init', '--quiet', source],
    ['-C', source, 'config', 'user.name', 'IDD fixture'],
    ['-C', source, 'config', 'user.email', 'idd-fixture@example.invalid'],
    ['-C', source, 'add', '--all'],
    ['-C', source, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const revision = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  assert.equal(revision.status, 0, revision.stderr);
  return revision.stdout.trim();
}

function preparedManifest(path: string): {
  sourceCommit: string;
  components: {
    instructions: PreparedManifestComponent;
    skillBundles: Record<string, PreparedManifestComponent>;
    helper: PreparedManifestComponent;
  };
} {
  return JSON.parse(
    nodeFs.readFileSync(join(path, 'manifest.json'), 'utf8'),
  ) as ReturnType<typeof preparedManifest>;
}

interface PreparedManifestComponent {
  location: string;
  provenance: { kind: string; commit: string };
  files: { path: string; sha256: string }[];
  digest: string;
}

const WRITE_FLAGS =
  nodeFs.constants.O_WRONLY |
  nodeFs.constants.O_RDWR |
  nodeFs.constants.O_CREAT |
  nodeFs.constants.O_TRUNC;
const WRITE_OPS = new Set([
  'mkdirSync',
  'linkSync',
  'renameSync',
  'unlinkSync',
  'rmdirSync',
  'symlinkSync',
  'writeSync',
  'fchmodSync',
]);

type Hook = (op: string, args: unknown[]) => void;

/** An fs object that reports each call to `hook` before running it. */
function hookedFs(hook: Hook): FsOps {
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const wrapped: Record<string, unknown> = { ...nodeFs };
  for (const op of ['openSync', ...WRITE_OPS]) {
    wrapped[op] = (...args: unknown[]) => {
      hook(op, args);
      return real[op](...args);
    };
  }
  return wrapped as unknown as FsOps;
}

function isWriteCall(op: string, args: unknown[]): boolean {
  if (op === 'openSync') {
    return typeof args[1] === 'number' && (args[1] & WRITE_FLAGS) !== 0;
  }
  return WRITE_OPS.has(op);
}

test('preparation keeps equal-version commits separately and reuses verified bytes', () => {
  const home = makeHome();
  const firstSource = makePreparedSource({ authoringText: '# First commit\n' });
  const secondSource = makePreparedSource({
    authoringText: '# Second commit\n',
  });
  const firstCommit = 'a'.repeat(40);
  const secondCommit = 'b'.repeat(40);
  const first = prepareDistributionSet(
    prepareOptions(home, firstSource, firstCommit),
  );
  const firstBeforeReuse = snapshot(first.preparedPath);
  const reused = prepareDistributionSet(
    prepareOptions(home, firstSource, firstCommit),
  );
  const second = prepareDistributionSet(
    prepareOptions(home, secondSource, secondCommit),
  );

  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(second.reused, false);
  assert.notEqual(first.preparedPath, second.preparedPath);
  assert.deepEqual(snapshot(first.preparedPath), firstBeforeReuse);
  assert.equal(
    nodeFs.readFileSync(
      join(second.preparedPath, 'skills/issue-authoring/SKILL.md'),
      'utf8',
    ),
    '# Second commit\n',
  );
  assert.equal(nodeFs.existsSync(currentOf(home)), false);

  const manifest = preparedManifest(first.preparedPath);
  assert.equal(manifest.sourceCommit, firstCommit);
  const components = [
    [manifest.components.instructions, 'idd-template', 'idd-template'],
    [
      manifest.components.skillBundles['issue-authoring'],
      'skills/issue-authoring',
      'skills/issue-authoring',
    ],
    [
      manifest.components.skillBundles['idd-spec-audit'],
      'skills/idd-spec-audit',
      'skills/idd-spec-audit',
    ],
    [manifest.components.helper, '', ''],
  ] as const;
  for (const [component, root, locationPath] of components) {
    const listing = [...component.files]
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      )
      .map((file) => `${file.sha256} ${file.path}\n`)
      .join('');
    assert.equal(component.digest, `sha256:${sha256(listing)}`);
    assert.equal(
      component.location,
      `https://github.com/kurone-kito/idd-skill/tree/${firstCommit}${locationPath ? `/${locationPath}` : ''}`,
    );
    assert.deepEqual(component.provenance, {
      kind: 'archive',
      commit: firstCommit,
    });
    for (const file of component.files) {
      const path = join(first.preparedPath, root, file.path);
      const bytes = nodeFs.readFileSync(path);
      assert.equal(sha256(bytes), file.sha256);
    }
  }
  assert.deepEqual(
    manifest.components.instructions.files.map((file) => file.path),
    ['.github/instructions/core.md', 'user-global/entry.md'],
  );
  installPayload(optionsFor(home));
  assert.deepEqual(snapshot(first.preparedPath), firstBeforeReuse);
});

test('preparation derives each helper closure from that staged root runtime map', () => {
  const home = makeHome();
  const firstSource = makePreparedSource({ runtimeFile: 'data/one.json' });
  const secondSource = makePreparedSource({ runtimeFile: 'data/two.json' });
  const first = prepareDistributionSet(
    prepareOptions(home, firstSource, 'c'.repeat(40)),
  );
  const second = prepareDistributionSet(
    prepareOptions(home, secondSource, 'd'.repeat(40)),
  );
  const firstFiles = preparedManifest(first.preparedPath).components.helper
    .files;
  const secondFiles = preparedManifest(second.preparedPath).components.helper
    .files;
  const expectedFirst = resolveHelperEntryClosure('scripts/sample.mjs', {
    packageRoot: firstSource,
    extraRuntimeFiles: readHelperExtraRuntimeFiles(firstSource),
  });
  const expectedSecond = resolveHelperEntryClosure('scripts/sample.mjs', {
    packageRoot: secondSource,
    extraRuntimeFiles: readHelperExtraRuntimeFiles(secondSource),
  });
  assert.deepEqual(
    firstFiles.map((file) => file.path),
    expectedFirst,
  );
  assert.deepEqual(
    secondFiles.map((file) => file.path),
    expectedSecond,
  );
  assert.ok(expectedFirst.includes('data/one.json'));
  assert.ok(expectedSecond.includes('data/two.json'));
  assert.notDeepEqual(expectedFirst, expectedSecond);

  const binaryBytes = Buffer.from([0, 255, 1, 128, 10]);
  const binarySource = makePreparedSource({
    runtimeFile: 'data/blob.bin',
    runtimeBytes: binaryBytes,
  });
  const binary = prepareDistributionSet(
    prepareOptions(home, binarySource, '5'.repeat(40)),
  );
  assert.deepEqual(
    nodeFs.readFileSync(join(binary.preparedPath, 'data/blob.bin')),
    binaryBytes,
  );
});

test('checkout preparation refuses bytes that do not match the named commit', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const sourceCommit = commitPreparedSource(source);
  nodeFs.writeFileSync(
    join(source, 'skills/issue-authoring/SKILL.md'),
    '# Edited after commit\n',
  );

  assert.throws(
    () =>
      prepareDistributionSet({
        ...prepareOptions(home, source, sourceCommit),
        provenance: { kind: 'checkout', commit: sourceCommit },
      }),
    /differs from source commit/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('checkout preparation refuses a helper closure with a missing committed import', () => {
  const home = makeHome();
  const source = makePreparedSource();
  nodeFs.writeFileSync(
    join(source, 'scripts/sample.mjs'),
    "import './dependency.mjs';\nexport const sample = true;\n",
  );
  nodeFs.writeFileSync(
    join(source, 'scripts/dependency.mjs'),
    'export const dependency = true;\n',
  );
  const sourceCommit = commitPreparedSource(source);
  nodeFs.unlinkSync(join(source, 'scripts/dependency.mjs'));
  const before = snapshot(home);

  assert.throws(
    () =>
      prepareDistributionSet({
        ...prepareOptions(home, source, sourceCommit),
        provenance: { kind: 'checkout', commit: sourceCommit },
      }),
    /relative import \.\/dependency\.mjs from scripts\/sample\.mjs does not resolve to a file/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('helper closure validation ignores generated comments that mention source imports', () => {
  assert.doesNotThrow(() =>
    assertHelperEntryClosureResolvable('scripts/protocol-helpers.mjs', {
      packageRoot: REPO,
    }),
  );
});

/** A bin wrapper, a minimal run-helper that spawns its argument, and the script it runs. */
function writeWrapperFixture(source: string, delegatedCall: string): void {
  nodeFs.mkdirSync(join(source, 'bin'), { recursive: true });
  nodeFs.writeFileSync(
    join(source, 'bin/sample.mjs'),
    `import { runHelper } from './run-helper.mjs';\n\n${delegatedCall}\n`,
  );
  nodeFs.writeFileSync(
    join(source, 'bin/run-helper.mjs'),
    [
      "import { spawnSync } from 'node:child_process';",
      "import { resolve } from 'node:path';",
      'export function runHelper(relativeScriptPath) {',
      '  const result = spawnSync(',
      '    process.execPath,',
      '    [resolve(import.meta.dirname, relativeScriptPath)],',
      "    { stdio: 'inherit' },",
      '  );',
      '  process.exitCode = result.status ?? 1;',
      '}',
      '',
    ].join('\n'),
  );
  nodeFs.writeFileSync(
    join(source, 'scripts/sample.mjs'),
    "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(new URL('../data/one.json', import.meta.url), 'utf8'));\n",
  );
}

test('preparation includes the script a bin wrapper delegates to, and the prepared wrapper runs (#4917)', () => {
  const home = makeHome();
  const source = makePreparedSource();
  writeWrapperFixture(source, "runHelper('../scripts/sample.mjs');");
  const commit = 'a'.repeat(40);

  const prepared = prepareDistributionSet(
    prepareOptions(home, source, commit, {
      invocation: { command: 'bin/sample.mjs', argv: [] },
    }),
  );

  assert.deepEqual(
    preparedManifest(prepared.preparedPath)
      .components.helper.files.map((file) => file.path)
      .sort(),
    [
      'bin/run-helper.mjs',
      'bin/sample.mjs',
      'data/one.json',
      'scripts/sample.mjs',
    ],
  );
  const run = spawnSync(
    process.execPath,
    [join(prepared.preparedPath, 'bin/sample.mjs')],
    { cwd: home, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '{"prepared":true}\n');
});

test('preparation refuses a bin wrapper whose delegated script is missing or not a literal, before any write (#4917)', () => {
  for (const { call, error } of [
    {
      call: "runHelper('../scripts/missing.mjs');",
      error:
        /delegated helper \.\.\/scripts\/missing\.mjs run by bin\/sample\.mjs is not a regular file/,
    },
    {
      call: "const script = '../scripts/sample.mjs';\nrunHelper(script);",
      error:
        /bin\/sample\.mjs passes runHelper something other than one string literal/,
    },
  ]) {
    const home = makeHome();
    const source = makePreparedSource();
    writeWrapperFixture(source, call);
    const before = snapshot(home);

    assert.throws(
      () =>
        prepareDistributionSet(
          prepareOptions(home, source, 'b'.repeat(40), {
            invocation: { command: 'bin/sample.mjs', argv: [] },
          }),
        ),
      error,
    );
    assert.deepEqual(snapshot(home), before);
  }
});

test('a prepared set of the repository activation wrapper runs without a missing module (#4917)', () => {
  const home = makeHome();
  const prepared = prepareDistributionSet(
    prepareOptions(home, REPO, 'c'.repeat(40), {
      invocation: { command: 'bin/idd-activation.mjs', argv: [] },
    }),
  );
  const helperFiles = preparedManifest(
    prepared.preparedPath,
  ).components.helper.files.map((file) => file.path);
  assert.ok(helperFiles.includes('scripts/idd-activation.mjs'));

  const run = spawnSync(
    process.execPath,
    [join(prepared.preparedPath, 'bin/idd-activation.mjs')],
    { cwd: home, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});

test('preparation follows a dynamic import inside a template substitution and ignores import text in a string (#4917)', () => {
  const home = makeHome();
  const source = makePreparedSource();
  nodeFs.writeFileSync(
    join(source, 'scripts/sample.mjs'),
    [
      `export const note = "import './quoted-missing.mjs'";`,
      // `${import('./dependency.mjs')}` inside a template literal.
      ['export const loaded = `$', "{import('./dependency.mjs')}`;"].join(''),
      '',
    ].join('\n'),
  );
  nodeFs.writeFileSync(
    join(source, 'scripts/dependency.mjs'),
    'export const dependency = true;\n',
  );

  const prepared = prepareDistributionSet(
    prepareOptions(home, source, 'd'.repeat(40)),
  );

  const helperFiles = preparedManifest(
    prepared.preparedPath,
  ).components.helper.files.map((file) => file.path);
  assert.ok(helperFiles.includes('scripts/dependency.mjs'));
  assert.equal(
    helperFiles.some((path) => path.includes('quoted-missing')),
    false,
  );
  assert.ok(
    nodeFs.existsSync(join(prepared.preparedPath, 'scripts/dependency.mjs')),
  );
});

test('checkout preparation verifies helper blobs larger than the git default buffer', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const largeHelper = Buffer.concat([
    Buffer.from('export const sample = true;\n// '),
    Buffer.alloc(1024 * 1024 + 1, 0x78),
    Buffer.from('\n'),
  ]);
  nodeFs.writeFileSync(join(source, 'scripts/sample.mjs'), largeHelper);
  const sourceCommit = commitPreparedSource(source);

  const prepared = prepareDistributionSet({
    ...prepareOptions(home, source, sourceCommit),
    provenance: { kind: 'checkout', commit: sourceCommit },
  });

  assert.deepEqual(
    nodeFs.readFileSync(join(prepared.preparedPath, 'scripts/sample.mjs')),
    largeHelper,
  );
});

test('checkout preparation detects missing committed files in a skill bundle', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const extraPath = join(source, 'skills/issue-authoring/references/extra.md');
  nodeFs.mkdirSync(dirname(extraPath), { recursive: true });
  nodeFs.writeFileSync(extraPath, '# Tracked reference\n');
  const sourceCommit = commitPreparedSource(source);
  nodeFs.unlinkSync(extraPath);

  assert.throws(
    () =>
      prepareDistributionSet({
        ...prepareOptions(home, source, sourceCommit),
        provenance: { kind: 'checkout', commit: sourceCommit },
      }),
    /skills\/issue-authoring file inventory differs from source commit/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('checkout preparation preserves committed executable modes and verifies them on reuse', () => {
  const home = makeHome();
  const source = makePreparedSource();
  nodeFs.chmodSync(join(source, 'scripts/sample.mjs'), 0o755);
  const sourceCommit = commitPreparedSource(source);
  const options = {
    ...prepareOptions(home, source, sourceCommit),
    provenance: { kind: 'checkout' as const, commit: sourceCommit },
  };
  const prepared = prepareDistributionSet(options);
  const stagedHelper = join(prepared.preparedPath, 'scripts/sample.mjs');
  assert.equal(nodeFs.statSync(stagedHelper).mode & 0o777, 0o755);

  nodeFs.chmodSync(stagedHelper, 0o644);
  assert.throws(
    () => prepareDistributionSet(options),
    /mode that differs from the prepared source/,
  );
  assert.equal(nodeFs.statSync(stagedHelper).mode & 0o777, 0o644);
});

test('an interrupted preparation records stage paths and safely resumes without changing an older set', () => {
  const home = makeHome();
  const priorSource = makePreparedSource({ authoringText: '# Prior\n' });
  const candidateSource = makePreparedSource({
    authoringText: '# Candidate\n',
  });
  const prior = prepareDistributionSet(
    prepareOptions(home, priorSource, 'e'.repeat(40)),
  );
  const priorSnapshot = snapshot(prior.preparedPath);
  const candidateCommit = 'f'.repeat(40);
  const candidatePath = join(dataRootOf(home), 'prepared', candidateCommit);
  const failedPath = join(candidatePath, 'skills/issue-authoring/SKILL.md');
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'linkSync' && args[1] === failedPath && !failed) {
      failed = true;
      throw new Error('injected stage interruption');
    }
  });

  assert.throws(
    () =>
      prepareDistributionSet({
        ...prepareOptions(home, candidateSource, candidateCommit),
        fs,
      }),
    /completion manifest .* is absent; staged paths .*receipt state is valid; one safe retry/,
  );
  assert.equal(nodeFs.existsSync(join(candidatePath, 'manifest.json')), false);
  assert.deepEqual(snapshot(prior.preparedPath), priorSnapshot);
  const receipt = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8')) as {
    entries: { path: string; kind: string }[];
  };
  assert.ok(
    receipt.entries.some(
      (entry) => entry.path === failedPath && entry.kind === 'file',
    ),
  );

  const resumed = prepareDistributionSet(
    prepareOptions(home, candidateSource, candidateCommit),
  );
  assert.equal(resumed.reused, false);
  assert.ok(nodeFs.existsSync(join(candidatePath, 'manifest.json')));
  assert.deepEqual(snapshot(prior.preparedPath), priorSnapshot);
});

test('preparation refuses a stale receipt temporary before changing managed state', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const commit = '7'.repeat(40);
  const dataRoot = dataRootOf(home);
  nodeFs.mkdirSync(dataRoot);
  nodeFs.writeFileSync(
    receiptOf(home),
    `${JSON.stringify({
      version: 1,
      entries: [{ kind: 'directory', path: dataRoot }],
    })}\n`,
  );
  const staleTemp = join(dataRoot, 'receipt.json.tmp-123');
  nodeFs.writeFileSync(staleTemp, '{}\n');
  const before = snapshot(home);

  assert.throws(
    () => prepareDistributionSet(prepareOptions(home, source, commit)),
    /stale receipt temporary from an interrupted write/,
  );
  assert.deepEqual(snapshot(home), before);

  nodeFs.unlinkSync(staleTemp);
  const result = prepareDistributionSet(prepareOptions(home, source, commit));
  assert.equal(result.reused, false);
});

test('a receipt lock refuses concurrent preparation, install, and uninstall', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const firstSource = makePreparedSource();
  const secondSource = makePreparedSource({ authoringText: '# Concurrent\n' });
  const firstCommit = '8'.repeat(40);
  const secondCommit = '9'.repeat(40);
  let nestedAttempted = false;
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      String(args[0]).endsWith('/owner.json') &&
      !nestedAttempted
    ) {
      nestedAttempted = true;
      assert.throws(
        () => installPayload(optionsFor(home, { fs })),
        /prepared receipt lock .*refusing before receipt reads or writes/,
      );
      assert.throws(
        () => uninstallPayload(optionsFor(home, { fs })),
        /prepared receipt lock .*refusing before receipt reads or writes/,
      );
      assert.throws(
        () =>
          prepareDistributionSet(
            prepareOptions(home, secondSource, secondCommit),
          ),
        /prepared receipt lock .*another preparation may be active/,
      );
    }
  });

  const first = prepareDistributionSet({
    ...prepareOptions(home, firstSource, firstCommit),
    fs,
  });
  assert.equal(nestedAttempted, true);
  const second = prepareDistributionSet(
    prepareOptions(home, secondSource, secondCommit),
  );
  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  const receipt = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8')) as {
    entries: { path: string }[];
  };
  assert.ok(receipt.entries.some((entry) => entry.path === first.preparedPath));
  assert.ok(
    receipt.entries.some((entry) => entry.path === second.preparedPath),
  );
  assert.ok(receipt.entries.some((entry) => entry.path === versionDirOf(home)));
});

test('preparation refuses non-file receipt kinds under a prepared set', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const commit = 'a'.repeat(40);
  const dataRoot = dataRootOf(home);
  const preparedRoot = join(dataRoot, 'prepared');
  const setRoot = join(preparedRoot, commit);
  nodeFs.mkdirSync(dataRoot);
  nodeFs.writeFileSync(
    receiptOf(home),
    `${JSON.stringify({
      version: 1,
      entries: [
        { kind: 'directory', path: dataRoot },
        { kind: 'directory', path: preparedRoot },
        { kind: 'directory', path: setRoot },
        {
          kind: 'managed-block',
          path: join(setRoot, 'unexpected.md'),
          sha256: 'b'.repeat(64),
          separator: false,
        },
      ],
    })}\n`,
  );
  const before = snapshot(home);

  assert.throws(
    () => prepareDistributionSet(prepareOptions(home, source, commit)),
    /unexpected\.md is not a path the installer creates/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('preparation and uninstall refuse unlisted receipt paths under a published prepared set', () => {
  const home = makeHome();
  const firstSource = makePreparedSource();
  const first = prepareDistributionSet(
    prepareOptions(home, firstSource, 'a'.repeat(40)),
  );
  const unexpectedPath = join(first.preparedPath, 'unlisted.bin');
  const unexpectedBytes = 'unlisted prepared content';
  nodeFs.writeFileSync(unexpectedPath, unexpectedBytes);
  const receipt = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8')) as {
    entries: { kind: string; path: string; sha256?: string }[];
  };
  receipt.entries.push({
    kind: 'file',
    path: unexpectedPath,
    sha256: sha256(unexpectedBytes),
  });
  nodeFs.writeFileSync(receiptOf(home), `${JSON.stringify(receipt)}\n`);
  const before = snapshot(home);

  assert.throws(
    () =>
      prepareDistributionSet(
        prepareOptions(home, makePreparedSource(), 'b'.repeat(40)),
      ),
    /unlisted\.bin is an unexpected receipt entry for prepared set/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /unlisted\.bin is an unexpected receipt entry for prepared set/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('preparation refuses receipt conflicts and preserves edited prepared bytes', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const commit = '1'.repeat(40);
  const dataRoot = dataRootOf(home);
  nodeFs.mkdirSync(dataRoot);
  const conflictPath = join(
    dataRoot,
    'prepared',
    commit,
    'idd-template/.github/instructions/core.md',
  );
  nodeFs.writeFileSync(
    receiptOf(home),
    `${JSON.stringify({
      version: 1,
      entries: [
        { kind: 'directory', path: dataRoot },
        { kind: 'file', path: conflictPath, sha256: '0'.repeat(64) },
      ],
    })}\n`,
  );
  assert.throws(
    () => prepareDistributionSet(prepareOptions(home, source, commit)),
    /conflicts with a different existing receipt entry/,
  );
  assert.equal(nodeFs.existsSync(join(dataRoot, 'prepared')), false);

  const editedHome = makeHome();
  const edited = prepareDistributionSet(
    prepareOptions(editedHome, source, '2'.repeat(40)),
  );
  const editedPath = join(
    edited.preparedPath,
    'skills/idd-spec-audit/SKILL.md',
  );
  nodeFs.writeFileSync(editedPath, '# User edit\n');
  assert.throws(
    () =>
      prepareDistributionSet(
        prepareOptions(editedHome, source, '2'.repeat(40)),
      ),
    /differs from the source bytes/,
  );
  assert.equal(nodeFs.readFileSync(editedPath, 'utf8'), '# User edit\n');
});

test('preparation refuses an unsupported legacy receipt without changing it', () => {
  const home = makeHome();
  const source = makePreparedSource();
  const dataRoot = dataRootOf(home);
  nodeFs.mkdirSync(dataRoot);
  const legacyReceipt = '{"version":0,"entries":[]}\n';
  nodeFs.writeFileSync(receiptOf(home), legacyReceipt);

  assert.throws(
    () => prepareDistributionSet(prepareOptions(home, source, '6'.repeat(40))),
    /receipt .* is corrupt/,
  );
  assert.equal(nodeFs.readFileSync(receiptOf(home), 'utf8'), legacyReceipt);
  assert.equal(nodeFs.existsSync(join(dataRoot, 'prepared')), false);
});

test('preparation refuses linked roots and hard-linked managed files', () => {
  const linkedHome = makeHome();
  const linkedDataRoot = dataRootOf(linkedHome);
  const outside = makeSandbox('user-global-prepared-outside-');
  nodeFs.mkdirSync(linkedDataRoot);
  nodeFs.symlinkSync(outside, join(linkedDataRoot, 'prepared'));
  nodeFs.writeFileSync(
    receiptOf(linkedHome),
    `${JSON.stringify({
      version: 1,
      entries: [
        { kind: 'directory', path: linkedDataRoot },
        { kind: 'directory', path: join(linkedDataRoot, 'prepared') },
      ],
    })}\n`,
  );
  const outsideBefore = snapshot(outside);
  assert.throws(
    () =>
      prepareDistributionSet(
        prepareOptions(linkedHome, makePreparedSource(), '3'.repeat(40)),
      ),
    /symbolic link/,
  );
  assert.deepEqual(snapshot(outside), outsideBefore);

  const hardlinkHome = makeHome();
  const hardlinkSource = makePreparedSource();
  const prepared = prepareDistributionSet(
    prepareOptions(hardlinkHome, hardlinkSource, '4'.repeat(40)),
  );
  const managed = join(
    prepared.preparedPath,
    'skills/issue-authoring/SKILL.md',
  );
  const sentinel = join(hardlinkHome, 'user-file.txt');
  nodeFs.linkSync(managed, sentinel);
  assert.throws(
    () =>
      prepareDistributionSet(
        prepareOptions(hardlinkHome, hardlinkSource, '4'.repeat(40)),
      ),
    /more than one hard link/,
  );
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), '# Authoring\n');
});

interface InterruptedPreparedUninstall {
  source: string;
  setRoot: string;
  manifestPath: string;
  manifestBytes: Buffer;
  continuationPath: string;
  failedPath: string;
  sentinels: Map<string, string>;
}

/**
 * Install the payload, prepare one set, plant unlisted sentinel files, and
 * run an uninstall whose unlink of a helper file fails after `manifest.json`
 * was removed (#4917).
 */
function interruptPreparedUninstall(
  home: string,
  commit: string,
): InterruptedPreparedUninstall {
  installPayload(optionsFor(home));
  const source = makePreparedSource();
  const prepared = prepareDistributionSet(prepareOptions(home, source, commit));
  const setRoot = prepared.preparedPath;
  const manifestPath = join(setRoot, 'manifest.json');
  const manifestBytes = nodeFs.readFileSync(manifestPath);
  const continuationPath = join(
    dataRootOf(home),
    'prepared',
    `${commit}.uninstall.json`,
  );
  const failedPath = join(setRoot, 'scripts/sample.mjs');
  const sentinels = new Map([
    [join(home, '.local', 'share', 'user-note.txt'), 'user note\n'],
    [join(home, '.claude', 'user-file.md'), '# User file\n'],
  ]);
  for (const [path, text] of sentinels) nodeFs.writeFileSync(path, text);

  let continuationBeforeManifest = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op !== 'unlinkSync') return;
    if (args[0] === manifestPath) {
      continuationBeforeManifest = nodeFs.existsSync(continuationPath);
    }
    if (args[0] === failedPath && !failed) {
      failed = true;
      throw new Error('injected unlink failure');
    }
  });
  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /uninstall stopped at .*scripts\/sample\.mjs: .*injected unlink failure/,
  );
  assert.equal(continuationBeforeManifest, true);
  return {
    source,
    setRoot,
    manifestPath,
    manifestBytes,
    continuationPath,
    failedPath,
    sentinels,
  };
}

test('an uninstall interrupted after the prepared manifest was removed resumes from its continuation record (#4917)', () => {
  const home = makeHome();
  const commit = 'e'.repeat(40);
  const state = interruptPreparedUninstall(home, commit);

  assert.equal(nodeFs.existsSync(state.manifestPath), false);
  assert.ok(nodeFs.existsSync(state.failedPath));
  assert.deepEqual(
    nodeFs.readFileSync(state.continuationPath),
    state.manifestBytes,
  );
  const listed = new Map(
    readReceiptEntries(home).map((entry) => [entry.path, entry]),
  );
  assert.equal(listed.has(state.manifestPath), false);
  assert.ok(listed.has(state.failedPath));
  assert.deepEqual(listed.get(state.continuationPath), {
    kind: 'file',
    path: state.continuationPath,
    sha256: sha256(state.manifestBytes),
  });

  const interrupted = snapshot(home);
  assert.throws(
    () => installPayload(optionsFor(home)),
    /has an interrupted uninstall recorded at .*run uninstall again to finish removing it/,
  );
  assert.throws(
    () => prepareDistributionSet(prepareOptions(home, state.source, commit)),
    /has an interrupted uninstall recorded at /,
  );
  planUninstall(optionsFor(home));
  assert.deepEqual(snapshot(home), interrupted);

  const result = uninstallPayload(optionsFor(home));
  assert.ok(result.lines.includes(`removed ${state.failedPath}`));
  assert.ok(result.lines.includes(`removed ${state.continuationPath}`));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  for (const [path, text] of state.sentinels) {
    assert.equal(nodeFs.readFileSync(path, 'utf8'), text);
  }
});

test('uninstall resumes from the published manifest when it stopped before writing its continuation record (#4917)', () => {
  const home = makeHome();
  const commit = 'f'.repeat(40);
  const prepared = prepareDistributionSet(
    prepareOptions(home, makePreparedSource(), commit),
  );
  const continuationPath = join(
    dataRootOf(home),
    'prepared',
    `${commit}.uninstall.json`,
  );
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'linkSync' && args[1] === continuationPath && !failed) {
      failed = true;
      throw new Error('injected publication failure');
    }
  });

  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /uninstall stopped at .*\.uninstall\.json: .*injected publication failure/,
  );
  assert.equal(nodeFs.existsSync(continuationPath), false);
  assert.ok(nodeFs.existsSync(join(prepared.preparedPath, 'manifest.json')));
  assert.ok(
    readReceiptEntries(home).some((entry) => entry.path === continuationPath),
  );

  uninstallPayload(optionsFor(home));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a retry finishes an uninstall that stopped while its continuation record still had a temporary link (#4917)', () => {
  const home = makeHome();
  const commit = '0'.repeat(40);
  prepareDistributionSet(prepareOptions(home, makePreparedSource(), commit));
  const continuationPath = join(
    dataRootOf(home),
    'prepared',
    `${commit}.uninstall.json`,
  );
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (
      op === 'unlinkSync' &&
      String(args[0]).startsWith(`${continuationPath}.idd-prepared-tmp-`) &&
      !failed
    ) {
      failed = true;
      throw new Error('injected temporary unlink failure');
    }
  });

  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /uninstall stopped at .*\.uninstall\.json: .*injected temporary unlink failure/,
  );
  assert.equal(nodeFs.statSync(continuationPath).nlink, 2);

  uninstallPayload(optionsFor(home));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('uninstall still refuses a prepared set whose manifest is missing without a continuation record (#4917)', () => {
  const home = makeHome();
  const prepared = prepareDistributionSet(
    prepareOptions(home, makePreparedSource(), '1'.repeat(40)),
  );
  const manifestPath = join(prepared.preparedPath, 'manifest.json');
  nodeFs.unlinkSync(manifestPath);
  const unlisted = snapshot(home);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /manifest\.json is not a regular published manifest; refusing/,
  );
  assert.deepEqual(snapshot(home), unlisted);

  const receipt = JSON.parse(nodeFs.readFileSync(receiptOf(home), 'utf8')) as {
    entries: { path: string }[];
  };
  receipt.entries = receipt.entries.filter(
    (entry) => entry.path !== manifestPath,
  );
  nodeFs.writeFileSync(receiptOf(home), `${JSON.stringify(receipt)}\n`);
  const unrecorded = snapshot(home);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /has no published manifest; refusing to trust its prepared receipt entries/,
  );
  assert.deepEqual(snapshot(home), unrecorded);
});

test('a resumed uninstall refuses an edited or missing continuation record and an entry outside its inventory (#4917)', () => {
  const home = makeHome();
  const state = interruptPreparedUninstall(home, '2'.repeat(40));
  const original = nodeFs.readFileSync(receiptOf(home));

  nodeFs.writeFileSync(state.continuationPath, '{"edited":true}\n');
  let before = snapshot(home);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /\.uninstall\.json does not match its receipt entry/,
  );
  assert.deepEqual(snapshot(home), before);
  nodeFs.writeFileSync(state.continuationPath, state.manifestBytes);

  const extraPath = join(state.setRoot, 'extra.txt');
  nodeFs.writeFileSync(extraPath, 'extra\n');
  const receipt = JSON.parse(original.toString('utf8')) as {
    entries: { kind: string; path: string; sha256?: string }[];
  };
  receipt.entries.push({
    kind: 'file',
    path: extraPath,
    sha256: sha256('extra\n'),
  });
  nodeFs.writeFileSync(receiptOf(home), `${JSON.stringify(receipt)}\n`);
  before = snapshot(home);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /extra\.txt is not in the inventory the uninstall continuation .* records/,
  );
  assert.deepEqual(snapshot(home), before);
  nodeFs.unlinkSync(extraPath);
  nodeFs.writeFileSync(receiptOf(home), original);

  nodeFs.unlinkSync(state.continuationPath);
  before = snapshot(home);
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /has no published manifest and its uninstall continuation .* is absent/,
  );
  assert.deepEqual(snapshot(home), before);
});

/**
 * Run a preparation whose publication of `failedRelative` fails, and return
 * the failure message and the candidate path (#4917). The failed publication
 * leaves a complete `.idd-prepared-tmp-<pid>` file beside that path.
 */
function interruptPreparation(
  home: string,
  source: string,
  commit: string,
  failedRelative = 'scripts/sample.mjs',
): { message: string; candidatePath: string } {
  const candidatePath = join(dataRootOf(home), 'prepared', commit);
  const failedPath = join(candidatePath, failedRelative);
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'linkSync' && args[1] === failedPath && !failed) {
      failed = true;
      throw new Error('injected stage interruption');
    }
  });
  let message = '';
  assert.throws(
    () =>
      prepareDistributionSet({ ...prepareOptions(home, source, commit), fs }),
    (error: Error) => {
      message = error.message;
      return true;
    },
  );
  assert.equal(failed, true);
  return { message, candidatePath };
}

test('discardPreparedCandidate removes an unavailable candidate with its receipt entries, so prepare, install, and uninstall proceed (#4917)', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const prior = prepareDistributionSet(
    prepareOptions(
      home,
      makePreparedSource({ authoringText: '# Prior\n' }),
      '3'.repeat(40),
    ),
  );
  const candidateCommit = '4'.repeat(40);
  const { message, candidatePath } = interruptPreparation(
    home,
    makePreparedSource({ authoringText: '# Candidate\n' }),
    candidateCommit,
  );
  assert.match(
    message,
    /if the source is unavailable, call discardPreparedCandidate with the same sourceCommit/,
  );
  assert.ok(
    nodeFs
      .readdirSync(join(candidatePath, 'scripts'))
      .some((name) => name.startsWith('sample.mjs.idd-prepared-tmp-')),
  );
  const otherSource = makePreparedSource({ authoringText: '# Other\n' });
  const otherCommit = '5'.repeat(40);
  assert.throws(
    () => installPayload(optionsFor(home)),
    /manifest\.json is not a regular published manifest/,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /manifest\.json is not a regular published manifest/,
  );
  assert.throws(
    () =>
      prepareDistributionSet(prepareOptions(home, otherSource, otherCommit)),
    /manifest\.json is not a regular published manifest/,
  );
  const sentinel = join(home, '.local', 'share', 'user-note.txt');
  nodeFs.writeFileSync(sentinel, 'user note\n');
  const priorSnapshot = snapshot(prior.preparedPath);
  const unrelatedEntries = readReceiptEntries(home).filter(
    (entry) =>
      entry.path !== candidatePath &&
      !entry.path.startsWith(`${candidatePath}/`),
  );

  const result = discardPreparedCandidate({
    ...optionsFor(home),
    sourceCommit: candidateCommit,
  });

  assert.ok(result.lines.includes(`removed ${candidatePath}`));
  assert.equal(nodeFs.existsSync(candidatePath), false);
  assert.deepEqual(readReceiptEntries(home), unrelatedEntries);
  assert.deepEqual(snapshot(prior.preparedPath), priorSnapshot);
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'user note\n');

  assert.equal(
    prepareDistributionSet(prepareOptions(home, otherSource, otherCommit))
      .reused,
    false,
  );
  installPayload(optionsFor(home));
  uninstallPayload(optionsFor(home));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'user note\n');
});

test('discardPreparedCandidate refuses edited, unlisted, unverifiable, published, and uninstalling paths and removes nothing (#4917)', () => {
  const home = makeHome();
  const commit = '6'.repeat(40);
  const { candidatePath } = interruptPreparation(
    home,
    makePreparedSource(),
    commit,
  );
  const discard = () =>
    discardPreparedCandidate({ ...optionsFor(home), sourceCommit: commit });
  const editedPath = join(
    candidatePath,
    'idd-template/.github/instructions/core.md',
  );
  const original = nodeFs.readFileSync(editedPath);
  const refusals: [() => void, () => void, RegExp][] = [
    [
      () => nodeFs.writeFileSync(editedPath, '# Edited\n'),
      () => nodeFs.writeFileSync(editedPath, original),
      /core\.md differs from its receipt hash/,
    ],
    [
      () => nodeFs.writeFileSync(join(candidatePath, 'extra.txt'), 'extra\n'),
      () => nodeFs.unlinkSync(join(candidatePath, 'extra.txt')),
      /extra\.txt is a file the receipt does not list/,
    ],
    [
      () =>
        nodeFs.writeFileSync(
          `${editedPath}.idd-prepared-tmp-999`,
          original.subarray(0, 3),
        ),
      () => nodeFs.unlinkSync(`${editedPath}.idd-prepared-tmp-999`),
      /core\.md\.idd-prepared-tmp-999 is a preparation temporary file that does not hold the complete bytes/,
    ],
  ];
  for (const [change, restore, error] of refusals) {
    change();
    const before = snapshot(home);
    assert.throws(
      discard,
      (caught: Error) =>
        error.test(caught.message) &&
        /refused before any removal; nothing was removed/.test(caught.message),
    );
    assert.deepEqual(snapshot(home), before);
    restore();
  }
  assert.throws(
    () => discardPreparedCandidate({ ...optionsFor(home), sourceCommit: 'x' }),
    /sourceCommit must be a full lowercase 40-character commit ID/,
  );
  discard();
  assert.equal(nodeFs.existsSync(candidatePath), false);

  const publishedHome = makeHome();
  const published = prepareDistributionSet(
    prepareOptions(publishedHome, makePreparedSource(), '7'.repeat(40)),
  );
  const publishedBefore = snapshot(publishedHome);
  assert.throws(
    () =>
      discardPreparedCandidate({
        ...optionsFor(publishedHome),
        sourceCommit: '7'.repeat(40),
      }),
    /manifest\.json is published, so .* is a complete set; use uninstall to remove it/,
  );
  assert.deepEqual(snapshot(publishedHome), publishedBefore);
  assert.ok(nodeFs.existsSync(published.preparedPath));

  const uninstallingHome = makeHome();
  interruptPreparedUninstall(uninstallingHome, '8'.repeat(40));
  const uninstallingBefore = snapshot(uninstallingHome);
  assert.throws(
    () =>
      discardPreparedCandidate({
        ...optionsFor(uninstallingHome),
        sourceCommit: '8'.repeat(40),
      }),
    /records an interrupted uninstall of .*run uninstall again/,
  );
  assert.deepEqual(snapshot(uninstallingHome), uninstallingBefore);
});

test('discardPreparedCandidate refuses an unlisted candidate directory instead of reporting nothing to discard (#4917)', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const commit = '9'.repeat(40);
  const discard = () =>
    discardPreparedCandidate({ ...optionsFor(home), sourceCommit: commit });
  assert.deepEqual(discard().lines, [
    `no receipt entries for ${join(dataRootOf(home), 'prepared', commit)}; nothing to discard`,
  ]);

  const unlisted = join(dataRootOf(home), 'prepared', commit);
  nodeFs.mkdirSync(join(unlisted, 'idd-template'), { recursive: true });
  nodeFs.writeFileSync(join(unlisted, 'manifest.json'), '{}\n');
  const before = snapshot(home);
  assert.throws(
    discard,
    /refused before any removal; nothing was removed: .* exists as a directory, but the receipt lists nothing under it/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('discardPreparedCandidate removes a publication interrupted between its link and unlink, and refuses another hard link (#4917)', () => {
  const home = makeHome();
  const commit = 'a'.repeat(40);
  const candidatePath = join(dataRootOf(home), 'prepared', commit);
  const failedPath = join(candidatePath, 'scripts/sample.mjs');
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (
      op === 'unlinkSync' &&
      String(args[0]).startsWith(`${failedPath}.idd-prepared-tmp-`) &&
      !failed
    ) {
      failed = true;
      throw new Error('injected interruption after the link');
    }
  });
  assert.throws(
    () =>
      prepareDistributionSet({
        ...prepareOptions(home, makePreparedSource(), commit),
        fs,
      }),
    /injected interruption after the link/,
  );
  assert.equal(nodeFs.statSync(failedPath).nlink, 2);

  const pairedBytes = nodeFs.readFileSync(failedPath);
  nodeFs.writeFileSync(failedPath, 'export const edited = true;\n');
  const editedPair = snapshot(home);
  assert.throws(
    () =>
      discardPreparedCandidate({ ...optionsFor(home), sourceCommit: commit }),
    /sample\.mjs\.idd-prepared-tmp-[0-9]+ has more than one hard link/,
  );
  assert.deepEqual(snapshot(home), editedPair);
  nodeFs.writeFileSync(failedPath, pairedBytes);
  assert.equal(nodeFs.statSync(failedPath).nlink, 2);

  const userLink = join(home, 'user-copy.mjs');
  const editedTarget = join(
    candidatePath,
    'idd-template/.github/instructions/core.md',
  );
  nodeFs.linkSync(editedTarget, userLink);
  const before = snapshot(home);
  assert.throws(
    () =>
      discardPreparedCandidate({ ...optionsFor(home), sourceCommit: commit }),
    /core\.md has more than one hard link; remove the extra link by hand after confirming no preparation is running, then retry/,
  );
  assert.deepEqual(snapshot(home), before);
  nodeFs.unlinkSync(userLink);

  const result = discardPreparedCandidate({
    ...optionsFor(home),
    sourceCommit: commit,
  });
  assert.ok(result.lines.includes(`removed ${failedPath}`));
  assert.equal(nodeFs.existsSync(candidatePath), false);
  assert.equal(
    readReceiptEntries(home).some(
      (entry) =>
        entry.path === candidatePath ||
        entry.path.startsWith(`${candidatePath}/`),
    ),
    false,
  );
});

test('a fresh install lays down the payload, skills, and receipt, and uninstall removes them', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const result = installPayload(options);
  const vdir = versionDirOf(home);

  assert.equal(result.priorCurrentTarget, null);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), vdir);
  assert.equal(
    nodeFs.readFileSync(join(vdir, ENTRY_RELATIVE), 'utf8'),
    nodeFs.readFileSync(join(REPO, 'idd-template', ENTRY_RELATIVE), 'utf8'),
  );
  assert.equal(
    nodeFs.readFileSync(join(vdir, 'user-global/entry.md'), 'utf8'),
    nodeFs.readFileSync(
      join(REPO, 'idd-template/user-global/entry.md'),
      'utf8',
    ),
  );
  for (const root of ['.claude', '.agents'] as const) {
    assert.equal(
      nodeFs.readFileSync(skillFileOf(home, root), 'utf8'),
      nodeFs.readFileSync(join(REPO, 'skills', SKILL_RELATIVE), 'utf8'),
    );
  }
  const entries = readReceiptEntries(home);
  assert.ok(
    entries.some(
      (entry) => entry.kind === 'link' && entry.path === currentOf(home),
    ),
    'the receipt lists the current link',
  );

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
  assert.deepEqual(nodeFs.readdirSync(join(home, '.claude')), []);
});

test('the installed entry uses the separately deployed activation command', () => {
  const home = makeHome();
  const localBin = join(home, '.local/bin');
  const activationCommand = join(localBin, 'idd-activation');
  const windowsActivationCommand = join(localBin, 'idd-activation.cmd');
  nodeFs.mkdirSync(localBin, { recursive: true });
  nodeFs.symlinkSync(join(REPO, 'bin/idd-activation.mjs'), activationCommand);
  nodeFs.writeFileSync(windowsActivationCommand, '@echo off\r\nexit /b 0\r\n');

  installPayload(optionsFor(home));

  const installedEntry = nodeFs.readFileSync(
    join(currentOf(home), 'user-global/entry.md'),
    'utf8',
  );
  assert.match(installedEntry, /~\/.local\/bin\/idd-activation/);
  assert.ok(
    installedEntry.includes('"%USERPROFILE%\\.local\\bin\\idd-activation.cmd"'),
  );
  assert.doesNotMatch(
    installedEntry,
    /\$PAYLOAD\/scripts\/idd-activation\.mjs/,
  );
  assert.ok(nodeFs.existsSync(activationCommand));
  assert.ok(nodeFs.existsSync(windowsActivationCommand));

  const help = spawnSync(activationCommand, ['--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
});

test('a second install of the same version leaves files unchanged', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const before = snapshot(home);

  const result = installPayload(options);

  assert.deepEqual(snapshot(home), before);
  assert.ok(result.lines.every((line) => line.startsWith('keep ')));
});

test('plan and install report the version the payload is installed under (#4245)', () => {
  const home = makeHome();

  // The default is the package.json version of the bundle being installed.
  assert.equal(planInstall(optionsFor(home)).version, PACKAGE_VERSION);
  assert.equal(installPayload(optionsFor(home)).version, PACKAGE_VERSION);
  assert.ok(nodeFs.existsSync(versionDirOf(home)));

  // An explicit version is what is reported, and what the directory is named.
  const upgraded = optionsFor(home, { version: UPGRADE_VERSION });
  assert.equal(planInstall(upgraded).version, UPGRADE_VERSION);
  assert.equal(installPayload(upgraded).version, UPGRADE_VERSION);
  assert.ok(nodeFs.existsSync(versionDirOf(home, UPGRADE_VERSION)));
});

test('plan functions write nothing and create no directory', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const beforeInstall = snapshot(home);

  const installPlan = planInstall(options);
  assert.ok(installPlan.lines.length > 0);
  assert.deepEqual(snapshot(home), beforeInstall);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);

  installPayload(options);
  const beforeUninstall = snapshot(home);
  const uninstallPlan = planUninstall(options);
  assert.ok(uninstallPlan.lines.length > 0);
  assert.deepEqual(snapshot(home), beforeUninstall);
});

test('an edited payload file makes uninstall refuse before any removal', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.appendFileSync(join(versionDirOf(home), ENTRY_RELATIVE), 'edit\n');
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /edited after install/);
  assert.deepEqual(snapshot(home), before);
});

test('a file added beside managed files survives, and its directory with it', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const extra = join(versionDirOf(home), '.github/instructions/notes.md');
  nodeFs.writeFileSync(extra, 'mine\n');

  const result = uninstallPayload(options);

  assert.equal(nodeFs.readFileSync(extra, 'utf8'), 'mine\n');
  assert.equal(
    nodeFs.existsSync(join(versionDirOf(home), ENTRY_RELATIVE)),
    false,
  );
  assert.ok(
    result.lines.some(
      (line) =>
        line.includes('.github/instructions') && line.includes('not empty'),
    ),
  );
  assert.ok(nodeFs.existsSync(receiptOf(home)));
});

test('an edited skill file makes uninstall refuse, and nothing is removed', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.appendFileSync(skillFileOf(home, '.agents'), 'edit\n');
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /edited after install/);
  assert.deepEqual(snapshot(home), before);
});

test('an unlisted file with the same bytes is left in place and not recorded', () => {
  const home = makeHome();
  const options = optionsFor(home);
  const dest = skillFileOf(home, '.claude');
  nodeFs.mkdirSync(dirname(dest), { recursive: true });
  nodeFs.copyFileSync(join(REPO, 'skills', SKILL_RELATIVE), dest);

  installPayload(options);
  assert.ok(
    readReceiptEntries(home).every((entry) => entry.path !== dest),
    'the receipt does not list the identical file',
  );
  uninstallPayload(options);
  assert.equal(
    nodeFs.readFileSync(dest, 'utf8'),
    nodeFs.readFileSync(join(REPO, 'skills', SKILL_RELATIVE), 'utf8'),
  );
});

test('an unlisted file with different bytes makes install refuse and write nothing', () => {
  const home = makeHome();
  const dest = skillFileOf(home, '.claude');
  nodeFs.mkdirSync(dirname(dest), { recursive: true });
  nodeFs.writeFileSync(dest, 'different\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home)),
    new RegExp(
      `${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*different bytes`,
    ),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a pre-existing current link is repointed, its prior target printed, and left in place on uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  const oldVersion = join(dataRootOf(home), '0.0.1');
  nodeFs.mkdirSync(oldVersion, { recursive: true });
  nodeFs.symlinkSync(oldVersion, currentOf(home));

  const result = installPayload(options);
  assert.equal(result.priorCurrentTarget, oldVersion);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.ok(
    readReceiptEntries(home).every((entry) => entry.path !== currentOf(home)),
    'an unlisted current link is not recorded',
  );

  const uninstall = uninstallPayload(options);
  assert.ok(nodeFs.lstatSync(currentOf(home)).isSymbolicLink());
  assert.ok(uninstall.lines.some((line) => line.includes('dangles')));
});

test('a listed link whose target changed makes uninstall refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(join(dataRootOf(home), '0.0.1'), currentOf(home));
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /points somewhere else now/);
  assert.deepEqual(snapshot(home), before);
});

test('a listed file replaced by a symbolic link makes uninstall refuse, and the sentinel is unchanged', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  const options = optionsFor(home);
  installPayload(options);
  const managed = skillFileOf(home, '.claude');
  nodeFs.unlinkSync(managed);
  nodeFs.symlinkSync(sentinel, managed);
  const before = snapshot(home);

  assert.throws(() => uninstallPayload(options), /now a symlink/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
});

test('an unlisted symbolic link inside a listed directory is not followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinelDir = makeSandbox('user-global-sentinel-');
  const sentinel = join(sentinelDir, 'keep.txt');
  nodeFs.writeFileSync(sentinel, 'keep\n');
  const options = optionsFor(home);
  installPayload(options);
  const trap = join(versionDirOf(home), '.github/instructions/trap');
  nodeFs.symlinkSync(sentinelDir, trap);

  const result = uninstallPayload(options);

  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'keep\n');
  assert.ok(nodeFs.lstatSync(trap).isSymbolicLink());
  assert.ok(result.lines.some((line) => line.includes('not empty')));
});

test('a listed path whose parent is a symbolic link out of the root is refused by install', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeSandbox('user-global-outside-');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.symlinkSync(outside, versionDirOf(home));
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(nodeFs.readdirSync(outside), []);
});

test('a hand-written receipt that lists a path under no root is refused by install and uninstall', () => {
  const home = makeHome();
  const outsideFile = join(home, 'outside', 'x.txt');
  nodeFs.mkdirSync(dirname(outsideFile), { recursive: true });
  nodeFs.writeFileSync(outsideFile, 'x\n');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [{ kind: 'file', path: outsideFile, sha256: sha256('x\n') }],
    }),
  );
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home)),
    /under no root|not a path the installer creates/,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /under no root|not a path the installer creates/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(outsideFile, 'utf8'), 'x\n');
});

test('a data root that is itself a symbolic link is refused by install and uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const target = join(home, 'elsewhere');
  nodeFs.mkdirSync(target, { recursive: true });
  nodeFs.symlinkSync(target, dataRootOf(home));
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(snapshot(home), before);
});

test('a symbolic link at a skill root makes install refuse before any write', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeSandbox('user-global-outside-');
  nodeFs.symlinkSync(outside, join(home, '.claude', 'skills'));

  assert.throws(() => installPayload(optionsFor(home)), /symbolic link/);
  assert.deepEqual(nodeFs.readdirSync(outside), []);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('uninstall reports a path under an absent ancestor as already absent and creates nothing', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.rmSync(join(home, '.claude', 'skills'), {
    recursive: true,
    force: true,
  });

  const result = uninstallPayload(options);

  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.ok(result.lines.some((line) => line.startsWith('absent ')));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('uninstall with XDG_DATA_HOME under missing ancestors and no receipt exits quietly', () => {
  const home = makeHome();
  const xdg = join(home, 'missing', 'xdg');
  const result = uninstallPayload({
    env: { HOME: home, XDG_DATA_HOME: xdg },
    homedir: home,
  });

  assert.equal(result.lines.length, 1);
  assert.equal(nodeFs.existsSync(join(home, 'missing')), false);
});

test('a corrupt receipt makes install and uninstall refuse, and nothing changes', () => {
  for (const body of [
    '{ not json',
    JSON.stringify({
      version: 1,
      entries: [{ kind: 'socket', path: join(dataRootOf(makeHome()), 'x') }],
    }),
  ]) {
    const home = makeHome();
    nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
    nodeFs.writeFileSync(receiptOf(home), body);
    const before = snapshot(home);

    assert.throws(() => installPayload(optionsFor(home)), /corrupt/);
    assert.throws(() => uninstallPayload(optionsFor(home)), /corrupt/);
    assert.deepEqual(snapshot(home), before);
  }
});

test('a stale receipt temporary file makes install and uninstall refuse', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  nodeFs.writeFileSync(join(dataRootOf(home), 'receipt.json.tmp-4242'), '{}');
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /crashed run/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /crashed run/);
  assert.deepEqual(snapshot(home), before);
});

test('a failed receipt rewrite does not roll back and names the created paths it does not list', () => {
  const home = makeHome();
  let receiptRenames = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target.endsWith('receipt.json')) {
      receiptRenames += 1;
      if (receiptRenames === 3) throw new Error('injected rename failure');
    }
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs })),
    /receipt rewrite failed.*not listed in the receipt/s,
  );
  const entries = readReceiptEntries(home);
  assert.equal(entries.length, 2, 'the receipt keeps its last valid state');
  assert.equal(
    nodeFs.readdirSync(dataRootOf(home)).some((name) => name.includes('.tmp-')),
    false,
    'the failed rename removes its temporary file',
  );
});

test('a failure in a later write rolls back this run and leaves nothing behind', () => {
  const home = makeHome();
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]).includes('/.agents/skills/')
    ) {
      throw new Error('injected write failure');
    }
  });

  assert.throws(() => installPayload(optionsFor(home, { fs })), /rolled back/);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('a failed upgrade restores the replaced skill file and the prior current target', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const v1Claude = nodeFs.readFileSync(skillFileOf(home, '.claude'));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const fs = hookedFs((op, args) => {
    if (
      op === 'renameSync' &&
      String(args[1]).endsWith(`/.agents/skills/${SKILL_RELATIVE}`)
    ) {
      throw new Error('injected replacement failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION, fs }),
      ),
    /rolled back/,
  );
  assert.deepEqual(nodeFs.readFileSync(skillFileOf(home, '.claude')), v1Claude);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.equal(nodeFs.existsSync(versionDirOf(home, UPGRADE_VERSION)), false);
});

test('an upgrade replaces the listed skill file, re-records its hash, and repoints current', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const newBytes = nodeFs.readFileSync(join(source, 'skills', SKILL_RELATIVE));

  const result = installPayload(
    optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
  );

  assert.equal(
    nodeFs.readFileSync(skillFileOf(home, '.claude')).toString('utf8'),
    newBytes.toString('utf8'),
  );
  assert.equal(result.priorCurrentTarget, versionDirOf(home));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  const claude = readReceiptEntries(home).find(
    (entry) => entry.path === skillFileOf(home, '.claude'),
  ) as { sha256?: string } | undefined;
  assert.equal(claude?.sha256, sha256(newBytes));
  assert.ok(
    readReceiptEntries(home).some((entry) => entry.path === versionDirOf(home)),
    'the older version stays listed',
  );

  uninstallPayload(
    optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
  );
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('an upgrade refuses a listed skill file that was edited after the last install', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  nodeFs.appendFileSync(skillFileOf(home, '.claude'), 'edit\n');
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /edited after install/,
  );
});

test('an interrupted uninstall leaves the entries not yet removed, and a second run removes them', () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const total = readReceiptEntries(home).length;
  let unlinks = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'unlinkSync') return;
    if (String(args[0]).endsWith('receipt.json')) return;
    unlinks += 1;
    if (unlinks === 3) throw new Error('injected unlink failure');
  });

  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /uninstall stopped at/,
  );
  assert.equal(readReceiptEntries(home).length, total - 2);

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a missing parent of a skill root makes install refuse before any write', () => {
  const home = makeHome();
  nodeFs.rmSync(join(home, '.agents'), { recursive: true, force: true });
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /does not exist/);
  assert.deepEqual(snapshot(home), before);
});

test('a version outside the required pattern makes install refuse before any write', () => {
  const home = makeHome();
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home, { version: '../escape' })),
    /does not match the required pattern/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a directory that existed before install is not listed and survives uninstall', () => {
  const home = makeHome();
  nodeFs.mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const options = optionsFor(home);
  installPayload(options);

  assert.ok(
    readReceiptEntries(home).every(
      (entry) => entry.path !== join(home, '.claude', 'skills'),
    ),
  );
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), true);
});

test('a retry after the receipt write failed on a repoint is refused and named', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  let repointed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target === currentOf(home)) repointed = true;
    if (repointed && !failed && target.endsWith('receipt.json')) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs, version: UPGRADE_VERSION })),
    (error: Error) =>
      /receipt rewrite failed/.test(error.message) &&
      error.message.includes(currentOf(home)),
  );
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home, { version: UPGRADE_VERSION })),
    /receipt records/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a receipt-owned link rewritten with a relative target is repointed to the recorded path', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(PACKAGE_VERSION, currentOf(home));

  installPayload(options);
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));

  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a retry after the receipt write failed on a replaced skill file refuses it as user-edited', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const claudeSkill = skillFileOf(home, '.claude');
  let replaced = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op !== 'renameSync') return;
    const target = String(args[1]);
    if (target === claudeSkill) replaced = true;
    if (replaced && !failed && target.endsWith('receipt.json')) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION, fs }),
      ),
    /receipt rewrite failed/,
  );
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /edited after install/,
  );
  assert.deepEqual(snapshot(home), before);
});
test('a listed link retargeted by someone else makes install refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const options = optionsFor(home);
  installPayload(options);
  const other = join(dataRootOf(home), '0.0.3');
  nodeFs.mkdirSync(other);
  nodeFs.unlinkSync(currentOf(home));
  nodeFs.symlinkSync(other, currentOf(home));
  const before = snapshot(home);

  assert.throws(
    () => installPayload(options),
    /retargeted or its receipt write lagged/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a manifest path that escapes the payload directory makes install refuse before any write', () => {
  const home = makeHome();
  const source = copySourceTree();
  const manifestPath = join(source, 'audit', 'sync-manifest.json');
  const manifest = JSON.parse(nodeFs.readFileSync(manifestPath, 'utf8'));
  const block = manifest.generatedBlocks.find(
    (candidate: { id: string }) => candidate.id === 'idd-template-core-files',
  );
  block.paths.push('idd-template/../escape.md');
  nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest));
  nodeFs.writeFileSync(join(source, 'escape.md'), 'outside\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: PACKAGE_VERSION }),
      ),
    /escapes the payload directory/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a stale temporary file beside a listed skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  nodeFs.writeFileSync(`${skillFileOf(home, '.claude')}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /crashed run/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a listed skill file with a second hard link makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  nodeFs.linkSync(skillFileOf(home, '.claude'), join(home, 'alias.md'));
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION }),
      ),
    /more than one hard link/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('a rollback keeps a listed path listed when this run recreated it and then failed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const claude = skillFileOf(home, '.claude');
  nodeFs.rmSync(claude);
  nodeFs.rmSync(skillFileOf(home, '.agents'));
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]).includes('/.agents/skills/')
    ) {
      throw new Error('injected write failure');
    }
  });

  assert.throws(() => installPayload(optionsFor(home, { fs })), /rolled back/);
  assert.equal(nodeFs.existsSync(claude), false);
  assert.ok(
    readReceiptEntries(home).some((entry) => entry.path === claude),
    'the receipt still lists the path the rollback removed',
  );
});

test('a symbolic-link data root is refused as a link, not as a stale temporary file', () => {
  const home = makeHome();
  const target = join(home, 'elsewhere');
  nodeFs.mkdirSync(target, { recursive: true });
  nodeFs.writeFileSync(join(target, 'receipt.json.tmp-3'), '{}');
  nodeFs.symlinkSync(target, dataRootOf(home));

  assert.throws(
    () => installPayload(optionsFor(home)),
    (error: Error) =>
      /symbolic link/.test(error.message) && !/crashed run/.test(error.message),
  );
});

test('a receipt that lists a user symbolic link as a link entry is corrupt for install and uninstall', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const userLink = join(home, '.claude', 'skills', 'user-link');
  nodeFs.mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  nodeFs.symlinkSync('/elsewhere/user-owned', userLink);
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [
        { kind: 'link', path: userLink, target: '/elsewhere/user-owned' },
      ],
    }),
  );
  const before = snapshot(home);

  assert.throws(() => installPayload(optionsFor(home)), /corrupt/);
  assert.throws(() => uninstallPayload(optionsFor(home)), /corrupt/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readlinkSync(userLink), '/elsewhere/user-owned');
});

test('a receipt that lists a path the installer never creates is refused by install and uninstall', () => {
  const home = makeHome();
  const userFile = join(home, '.claude', 'notes.md');
  nodeFs.writeFileSync(userFile, 'mine\n');
  nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
  nodeFs.writeFileSync(
    receiptOf(home),
    JSON.stringify({
      version: 1,
      entries: [
        { kind: 'directory', path: join(home, '.claude') },
        { kind: 'file', path: userFile, sha256: sha256('mine\n') },
      ],
    }),
  );
  const before = snapshot(home);

  assert.throws(
    () => installPayload(optionsFor(home)),
    /not a path the installer creates/,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /not a path the installer creates/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.equal(nodeFs.readFileSync(userFile, 'utf8'), 'mine\n');
});

test('every placeholder in the installed payload has a mapping', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const pattern = /\{\{([A-Z_]+)\}\}/g;
  const names = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        for (const match of nodeFs
          .readFileSync(path, 'utf8')
          .matchAll(pattern)) {
          names.add(match[1]);
        }
      }
    }
  };
  visit(versionDirOf(home));
  for (const name of names) {
    assert.ok(
      Object.hasOwn(PAYLOAD_PLACEHOLDER_FIELDS, name),
      `placeholder ${name} has no mapping`,
    );
  }
});

// ---------------------------------------------------------------------------
// An upgrade prunes the skill files the new package no longer ships (#4302)
// ---------------------------------------------------------------------------

const DROPPED_RELATIVE = 'issue-authoring/references/draft-patterns.md';
const SPEC_DROPPED_RELATIVE = 'idd-spec-audit/references/report-template.md';

const droppedOf = (home: string, root: '.claude' | '.agents'): string =>
  join(home, root, 'skills', DROPPED_RELATIVE);

/** A source tree copy that no longer ships the named files under `skills/`. */
function copySourceWithout(...relatives: string[]): string {
  const dir = copySourceTree();
  for (const relative of relatives) {
    nodeFs.rmSync(join(dir, 'skills', relative));
  }
  return dir;
}

/** Options that install `source` as the upgrade version. */
function upgradeOptions(
  home: string,
  source: string,
  extra: Partial<UserGlobalOptions> = {},
): UserGlobalOptions {
  return optionsFor(home, {
    sourceRoot: source,
    version: UPGRADE_VERSION,
    ...extra,
  });
}

type ReceiptRow = { path: string; kind: string; sha256?: string };

const receiptRows = (home: string): ReceiptRow[] =>
  readReceiptEntries(home) as ReceiptRow[];

const isListed = (home: string, path: string): boolean =>
  receiptRows(home).some((entry) => entry.path === path);

/** Every listed file exists and still has the hash the receipt records. */
function assertListedFilesMatchDisk(home: string): void {
  for (const entry of receiptRows(home)) {
    if (entry.kind !== 'file') continue;
    assert.equal(
      sha256(nodeFs.readFileSync(entry.path)),
      entry.sha256,
      `${entry.path} matches the receipt`,
    );
  }
}

/** The path a refusal is expected to name, as a literal pattern. */
const literal = (value: string): RegExp =>
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * An fs whose bigint `lstatSync` reports one fixed device and inode for each
 * named path. A filesystem that folds case or Unicode form reports one file for
 * two spellings; real inodes cannot show that here, so the fs reports it.
 */
function fsReportingIdentity(paths: string[], dev: bigint, ino: bigint): FsOps {
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  return {
    ...nodeFs,
    lstatSync: (path: string, options?: { bigint?: boolean }) => {
      const stat = real.lstatSync(path, options) as object;
      return paths.includes(path) && options?.bigint
        ? Object.create(stat, { dev: { value: dev }, ino: { value: ino } })
        : stat;
    },
  } as unknown as FsOps;
}

test('an upgrade that drops an unchanged skill file removes it and its receipt entry', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  for (const path of dropped) {
    assert.ok(nodeFs.existsSync(path), 'the file is installed first');
    assert.ok(isListed(home, path), 'the receipt lists it first');
  }

  const result = installPayload(upgradeOptions(home, source));

  for (const path of dropped) {
    assert.equal(nodeFs.existsSync(path), false);
    assert.equal(isListed(home, path), false);
    assert.ok(result.lines.includes(`remove ${path}`));
  }
  const kept = join(home, '.claude', 'skills', 'issue-authoring', 'references');
  assert.ok(
    nodeFs.existsSync(join(kept, 'contract.md')),
    'a shipped file stays',
  );
  assert.ok(isListed(home, join(kept, 'contract.md')));
  assert.ok(isListed(home, kept), 'the directory stays listed');
  const olderFile = join(versionDirOf(home), ENTRY_RELATIVE);
  assert.ok(nodeFs.existsSync(olderFile), 'the older version stays on disk');
  assert.ok(isListed(home, olderFile), 'the older version stays listed');
  assertListedFilesMatchDisk(home);

  // The prune is finished, so a repeat install leaves no persistent changes.
  const beforeRepeat = snapshot(home);
  installPayload(upgradeOptions(home, source));
  assert.deepEqual(snapshot(home), beforeRepeat);

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('a dropped skill file that was edited after install is refused, named, and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const edited = droppedOf(home, '.claude');
  nodeFs.appendFileSync(edited, 'my own notes\n');
  const before = snapshot(home);

  for (const run of [
    () => installPayload(upgradeOptions(home, source)),
    () => planInstall(upgradeOptions(home, source)),
  ]) {
    assert.throws(
      run,
      (error: Error) =>
        literal(edited).test(error.message) &&
        /edited after install/.test(error.message) &&
        /nothing was written/.test(error.message),
    );
  }
  assert.deepEqual(snapshot(home), before);
  assert.ok(nodeFs.readFileSync(edited, 'utf8').endsWith('my own notes\n'));
  assert.ok(
    nodeFs.existsSync(droppedOf(home, '.agents')),
    'the unedited copy is not removed either',
  );
  assert.ok(isListed(home, edited));
});

test('a dropped skill file that is now a symbolic link is refused and nothing is followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.unlinkSync(dropped);
  nodeFs.symlinkSync(sentinel, dropped);
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /is now a symlink/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
  assert.ok(nodeFs.lstatSync(dropped).isSymbolicLink());
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
});

test('a dropped skill file that is now a directory is refused and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.unlinkSync(dropped);
  nodeFs.mkdirSync(dropped);
  nodeFs.writeFileSync(join(dropped, 'mine.txt'), 'mine\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /is now a directory/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file with a second hard link is refused and left in place', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  nodeFs.linkSync(dropped, join(home, 'alias.md'));
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /more than one hard link/.test(error.message) &&
      /move or delete it, then install again/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file that is already absent is unlisted and not recreated', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(SPEC_DROPPED_RELATIVE);
  const claudeCopy = join(home, '.claude', 'skills', SPEC_DROPPED_RELATIVE);
  const agentsCopy = join(home, '.agents', 'skills', SPEC_DROPPED_RELATIVE);
  // One copy loses its whole directory, the other only the file.
  nodeFs.rmSync(dirname(claudeCopy), { recursive: true });
  nodeFs.rmSync(agentsCopy);

  const result = installPayload(upgradeOptions(home, source));

  for (const path of [claudeCopy, agentsCopy]) {
    assert.equal(nodeFs.existsSync(path), false, `${path} is not recreated`);
    assert.equal(isListed(home, path), false);
    assert.ok(result.lines.includes(`absent ${path}`));
  }

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
});

test('a stale temporary file beside an already-absent dropped skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const absent = droppedOf(home, '.claude');
  nodeFs.rmSync(absent);
  nodeFs.writeFileSync(`${absent}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  for (const run of [
    () => installPayload(upgradeOptions(home, source)),
    () => planInstall(upgradeOptions(home, source)),
  ]) {
    assert.throws(
      run,
      (error: Error) =>
        literal(`${absent}.tmp-7`).test(error.message) &&
        /crashed run/.test(error.message) &&
        literal(`refusing to drop the receipt entry for ${absent}`).test(
          error.message,
        ) &&
        /nothing was written/.test(error.message),
    );
  }
  assert.deepEqual(snapshot(home), before);
  assert.ok(isListed(home, absent), 'the entry stays listed');
});

test('a stale temporary file beside a dropped skill file that is the same file as a shipped one still refuses', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');
  nodeFs.writeFileSync(`${dropped}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () =>
      installPayload(
        upgradeOptions(home, source, {
          fs: fsReportingIdentity([dropped, shipped], 7n, 7n),
        }),
      ),
    /crashed run/,
  );
  assert.deepEqual(snapshot(home), before);
});

test('an edited dropped file of the second shipped skill is refused too', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(SPEC_DROPPED_RELATIVE);
  const edited = join(home, '.agents', 'skills', SPEC_DROPPED_RELATIVE);
  nodeFs.appendFileSync(edited, 'my own notes\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      literal(edited).test(error.message) &&
      /edited after install/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a hard link made to a dropped skill file after the plan stops the prune and removes nothing', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const alias = join(home, 'alias.md');
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.linkSync(dropped, alias);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /more than one hard link/.test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.ok(nodeFs.existsSync(dropped));
  assert.ok(nodeFs.existsSync(alias));
  assert.ok(isListed(home, dropped));
  const second = droppedOf(home, '.agents');
  assert.ok(
    nodeFs.existsSync(second),
    'the prune stopped before the second copy',
  );
  assert.ok(isListed(home, second));
});

test('a file the user added beside a dropped skill file survives the prune', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const mine = join(dirname(droppedOf(home, '.claude')), 'mine.md');
  nodeFs.writeFileSync(mine, 'mine\n');

  installPayload(upgradeOptions(home, source));

  assert.equal(nodeFs.existsSync(droppedOf(home, '.claude')), false);
  assert.equal(nodeFs.readFileSync(mine, 'utf8'), 'mine\n');
  assert.equal(isListed(home, mine), false);
});

test('a receipt entry that is not a path the prune may touch is refused and the file is untouched', () => {
  const user = 'mine\n';
  const cases = [
    {
      name: 'a path that climbs out of the skill tree',
      path: (home: string) =>
        `${home}/.claude/skills/issue-authoring/../../notes.md`,
      file: (home: string) => join(home, '.claude', 'notes.md'),
      message: /not a path the installer creates|under no root/,
    },
    {
      name: 'a non-normalized path that stays inside another skill',
      path: (home: string) =>
        `${home}/.claude/skills/issue-authoring/../idd-spec-audit/SKILL.md`,
      file: (home: string) =>
        join(home, '.claude', 'skills', 'idd-spec-audit', 'SKILL.md'),
      message: /not in normalized form/,
    },
    {
      name: 'a skill the package does not ship',
      path: (home: string) =>
        join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'),
      file: (home: string) =>
        join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'),
      message: /not a path the installer creates/,
    },
  ];
  for (const { name, path, file, message } of cases) {
    const home = makeHome();
    nodeFs.mkdirSync(dirname(file(home)), { recursive: true });
    nodeFs.writeFileSync(file(home), user);
    nodeFs.mkdirSync(dataRootOf(home), { recursive: true });
    nodeFs.writeFileSync(
      receiptOf(home),
      JSON.stringify({
        version: 1,
        entries: [{ kind: 'file', path: path(home), sha256: sha256(user) }],
      }),
    );
    const before = snapshot(home);

    assert.throws(() => installPayload(optionsFor(home)), message, name);
    assert.deepEqual(snapshot(home), before, name);
    assert.equal(nodeFs.readFileSync(file(home), 'utf8'), user, name);
  }
});

test('a dropped skill file under a directory that was swapped for a link is refused and nothing is followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const references = dirname(droppedOf(home, '.claude'));
  const outside = join(makeSandbox('user-global-outside-'), 'references');
  nodeFs.cpSync(references, outside, { recursive: true });
  nodeFs.rmSync(references, { recursive: true });
  nodeFs.symlinkSync(outside, references);
  const outsideBefore = snapshot(outside);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /symbolic link/,
  );
  assert.deepEqual(snapshot(outside), outsideBefore);
  assert.ok(nodeFs.existsSync(join(outside, 'draft-patterns.md')));
});

test('a dropped skill file that is the same file as a shipped one is kept, not removed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');

  const result = installPayload(
    upgradeOptions(home, source, {
      fs: fsReportingIdentity([dropped, shipped], 7n, 7n),
    }),
  );

  assert.ok(
    result.lines.includes(`keep ${dropped} (the same file as ${shipped})`),
  );
  assert.ok(nodeFs.existsSync(dropped), 'the aliased file is not removed');
  assert.ok(isListed(home, dropped), 'its entry stays listed');
  assert.equal(
    nodeFs.existsSync(droppedOf(home, '.agents')),
    false,
    'the other copy is a different file and is removed',
  );
  assertListedFilesMatchDisk(home);

  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
});

test('a filesystem that reports no inode number does not turn every dropped skill file into an alias', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');

  installPayload(
    upgradeOptions(home, source, {
      fs: fsReportingIdentity([dropped, shipped], 0n, 0n),
    }),
  );

  assert.equal(nodeFs.existsSync(dropped), false);
  assert.equal(isListed(home, dropped), false);
});

test('two skill files with the same inode number on different devices are not the same file', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const shipped = join(dirname(dropped), 'contract.md');
  const real = nodeFs as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const fs = {
    ...nodeFs,
    lstatSync: (path: string, options?: { bigint?: boolean }) => {
      const stat = real.lstatSync(path, options) as object;
      if (!options?.bigint) return stat;
      if (path === dropped) {
        return Object.create(stat, { dev: { value: 7n }, ino: { value: 5n } });
      }
      if (path === shipped) {
        return Object.create(stat, { dev: { value: 8n }, ino: { value: 5n } });
      }
      return stat;
    },
  } as unknown as FsOps;

  installPayload(upgradeOptions(home, source, { fs }));

  assert.equal(nodeFs.existsSync(dropped), false);
  assert.equal(isListed(home, dropped), false);
});

test('a byte-identical file that was there before install is never listed, so the prune never touches it', () => {
  const home = makeHome();
  for (const root of ['.claude', '.agents'] as const) {
    const path = droppedOf(home, root);
    nodeFs.mkdirSync(dirname(path), { recursive: true });
    nodeFs.copyFileSync(join(REPO, 'skills', DROPPED_RELATIVE), path);
  }
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);

  const result = installPayload(upgradeOptions(home, source));

  for (const root of ['.claude', '.agents'] as const) {
    const path = droppedOf(home, root);
    assert.ok(nodeFs.existsSync(path), `${path} is left in place`);
    assert.equal(isListed(home, path), false);
    assert.equal(result.lines.includes(`remove ${path}`), false);
  }
});

test('a stale temporary file beside a dropped skill file makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  nodeFs.writeFileSync(`${droppedOf(home, '.claude')}.tmp-7`, 'stale\n');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    (error: Error) =>
      /crashed run/.test(error.message) &&
      /refusing to remove/.test(error.message),
  );
  assert.deepEqual(snapshot(home), before);
});

test('a dropped skill file edited after the plan stops the prune, keeps the edit, and a retry refuses it', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const racing = droppedOf(home, '.claude');
  let opens = 0;
  const fs = hookedFs((op, args) => {
    if (op !== 'openSync' || String(args[0]) !== racing) return;
    opens += 1;
    // The first open is the plan's hash read; the second is the removal's.
    if (opens === 2) nodeFs.appendFileSync(racing, 'edited late\n');
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(racing).test(error.message) &&
      literal(droppedOf(home, '.agents')).test(error.message) &&
      /payload is installed/.test(error.message) &&
      /install again/.test(error.message),
  );
  assert.equal(opens, 2, 'the removal opened the file once after the plan');
  assert.ok(nodeFs.readFileSync(racing, 'utf8').endsWith('edited late\n'));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
    'the new version stays installed',
  );
  assert.ok(isListed(home, racing), 'the edited file stays listed');
  assert.ok(nodeFs.existsSync(droppedOf(home, '.agents')));

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /edited after install/,
  );
});

test('a failed removal leaves the new version installed and a consistent receipt, and a retry finishes the prune', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const first = droppedOf(home, '.claude');
  const second = droppedOf(home, '.agents');
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === second) {
      throw new Error('injected unlink failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      /payload is installed/.test(error.message) &&
      /injected unlink failure/.test(error.message) &&
      literal(second).test(error.message) &&
      literal(`current used to point at ${versionDirOf(home)}`).test(
        error.message,
      ) &&
      /install again/.test(error.message),
  );
  assert.equal(nodeFs.existsSync(first), false);
  assert.equal(isListed(home, first), false);
  assert.ok(nodeFs.existsSync(second));
  assert.ok(isListed(home, second));
  assert.equal(
    nodeFs.readlinkSync(currentOf(home)),
    versionDirOf(home, UPGRADE_VERSION),
  );
  assertListedFilesMatchDisk(home);

  installPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(second), false);
  assert.equal(isListed(home, second), false);
  assertListedFilesMatchDisk(home);
});

test('a failed receipt rewrite after a removal names the path, and a retry drops it as absent', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const first = droppedOf(home, '.claude');
  const second = droppedOf(home, '.agents');
  let removed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === first) removed = true;
    if (
      op === 'renameSync' &&
      removed &&
      !failed &&
      String(args[1]).endsWith('receipt.json')
    ) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      /receipt rewrite failed/.test(error.message) &&
      literal(first).test(error.message) &&
      /gone from disk but still listed/.test(error.message),
  );
  assert.equal(nodeFs.existsSync(first), false);
  assert.ok(isListed(home, first), 'the receipt still lists the removed file');
  assert.ok(nodeFs.existsSync(second));
  assert.equal(
    nodeFs.readdirSync(dataRootOf(home)).some((name) => name.includes('.tmp-')),
    false,
    'the failed rename removes its temporary file',
  );
  assert.ok(
    planUninstall(upgradeOptions(home, source)).lines.includes(
      `absent ${first}`,
    ),
    'uninstall reports the removed file as absent',
  );

  const retry = installPayload(upgradeOptions(home, source));
  assert.ok(retry.lines.includes(`absent ${first}`));
  assert.ok(retry.lines.includes(`remove ${second}`));
  assert.equal(isListed(home, first), false);
  assert.equal(isListed(home, second), false);
  assertListedFilesMatchDisk(home);
});

test('a failed receipt rewrite after the last removal says that nothing else is left', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const last = droppedOf(home, '.agents');
  nodeFs.rmSync(droppedOf(home, '.claude'));
  let removed = false;
  let failed = false;
  const fs = hookedFs((op, args) => {
    if (op === 'unlinkSync' && String(args[0]) === last) removed = true;
    if (
      op === 'renameSync' &&
      removed &&
      !failed &&
      String(args[1]).endsWith('receipt.json')
    ) {
      failed = true;
      throw new Error('injected receipt failure');
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(last).test(error.message) &&
      /not yet handled: none/.test(error.message),
  );
  assert.ok(failed);
});

test('an absent dropped skill file whose name the new version uses for a directory stays listed as that directory', () => {
  const home = makeHome();
  const oldSource = copySourceTree();
  nodeFs.writeFileSync(
    join(oldSource, 'skills', 'issue-authoring', 'notes'),
    'old\n',
  );
  installPayload(
    optionsFor(home, { sourceRoot: oldSource, version: '98.0.0' }),
  );
  const names = ['.claude', '.agents'].map((root) =>
    join(home, root, 'skills', 'issue-authoring', 'notes'),
  );
  for (const name of names) {
    assert.ok(isListed(home, name));
    nodeFs.rmSync(name);
  }
  const source = copySourceTree();
  nodeFs.mkdirSync(join(source, 'skills', 'issue-authoring', 'notes'));
  nodeFs.writeFileSync(
    join(source, 'skills', 'issue-authoring', 'notes', 'x.md'),
    'new\n',
  );

  installPayload(upgradeOptions(home, source));

  for (const name of names) {
    assert.ok(nodeFs.statSync(name).isDirectory());
    assert.equal(
      receiptRows(home).find((entry) => entry.path === name)?.kind,
      'directory',
      `${name} is listed as the directory it now is`,
    );
  }
  assertListedFilesMatchDisk(home);
  uninstallPayload(upgradeOptions(home, source));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('an upgrade that replaces one skill file, drops another, and keeps an entry file lists all of it', () => {
  const home = makeHome();
  const harnesses = ['claude'] as const;
  installPayload(optionsFor(home, { harnesses }));
  const source = copySourceWithout(DROPPED_RELATIVE);
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  const newBytes = nodeFs.readFileSync(join(source, 'skills', SKILL_RELATIVE));
  const entryFile = join(home, '.claude', 'CLAUDE.md');
  const entryBefore = nodeFs.readFileSync(entryFile);

  installPayload(upgradeOptions(home, source, { harnesses }));

  const replaced = skillFileOf(home, '.claude');
  assert.deepEqual(nodeFs.readFileSync(replaced), newBytes);
  assert.equal(
    receiptRows(home).find((entry) => entry.path === replaced)?.sha256,
    sha256(newBytes),
  );
  assert.equal(nodeFs.existsSync(droppedOf(home, '.claude')), false);
  assert.equal(isListed(home, droppedOf(home, '.claude')), false);
  assert.deepEqual(nodeFs.readFileSync(entryFile), entryBefore);
  assert.ok(isListed(home, entryFile));
  assertListedFilesMatchDisk(home);

  uninstallPayload(upgradeOptions(home, source, { harnesses }));
  assert.equal(nodeFs.existsSync(dataRootOf(home)), false);
  assert.deepEqual(nodeFs.readdirSync(join(home, '.claude')), []);
});

test('a dropped skill file that vanishes between the plan and the prune is only unlisted', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      for (const path of dropped) nodeFs.rmSync(path);
    }
  });

  installPayload(upgradeOptions(home, source, { fs }));

  assert.ok(fired, 'the files were removed between the plan and the prune');

  for (const path of dropped) {
    assert.equal(isListed(home, path), false);
    assert.equal(nodeFs.existsSync(path), false);
  }
  assertListedFilesMatchDisk(home);
});

test('a dropped skill file swapped for a symbolic link after the plan is not followed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const sentinel = join(makeSandbox('user-global-sentinel-'), 'sentinel.txt');
  nodeFs.writeFileSync(sentinel, 'sentinel\n');
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  let fired = false;
  const fs = hookedFs((op, args) => {
    // The repoint comes after planning and before the prune.
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.unlinkSync(dropped);
      nodeFs.symlinkSync(sentinel, dropped);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.ok(nodeFs.lstatSync(dropped).isSymbolicLink());
  assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
  assert.ok(isListed(home, dropped));
});

test('a skill directory swapped for a symbolic link after the plan is not followed by the prune', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = droppedOf(home, '.claude');
  const references = dirname(dropped);
  const outside = join(makeSandbox('user-global-outside-'), 'references');
  nodeFs.cpSync(references, outside, { recursive: true });
  const outsideBefore = snapshot(outside);
  let fired = false;
  const fs = hookedFs((op, args) => {
    if (op === 'renameSync' && String(args[1]) === currentOf(home)) {
      fired = true;
      nodeFs.rmSync(references, { recursive: true });
      nodeFs.symlinkSync(outside, references);
    }
  });

  assert.throws(
    () => installPayload(upgradeOptions(home, source, { fs })),
    (error: Error) =>
      literal(dropped).test(error.message) &&
      /symbolic link/.test(error.message) &&
      /payload is installed/.test(error.message),
  );
  assert.ok(fired);
  assert.deepEqual(snapshot(outside), outsideBefore);
  assert.ok(nodeFs.existsSync(join(outside, 'draft-patterns.md')));
});

test('a failure in a late install step leaves the dropped skill files in place and listed', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const dropped = [droppedOf(home, '.claude'), droppedOf(home, '.agents')];
  let fired = false;
  const fs = hookedFs((op, args) => {
    if (
      op === 'openSync' &&
      isWriteCall(op, args) &&
      String(args[0]) === join(home, '.claude', 'CLAUDE.md')
    ) {
      fired = true;
      throw new Error('injected entry-file write failure');
    }
  });

  assert.throws(
    () =>
      installPayload(
        upgradeOptions(home, source, { fs, harnesses: ['claude'] }),
      ),
    /rolled back/,
  );
  assert.ok(fired);
  for (const path of dropped) {
    assert.ok(nodeFs.existsSync(path), `${path} is untouched`);
    assert.ok(isListed(home, path), `${path} is still listed`);
  }
  assert.equal(nodeFs.readlinkSync(currentOf(home)), versionDirOf(home));
  assert.equal(nodeFs.existsSync(versionDirOf(home, UPGRADE_VERSION)), false);
  assertListedFilesMatchDisk(home);
});

test('an older version directory inside a skill directory is not taken for a skill file', () => {
  const home = makeHome();
  const xdg = join(home, '.claude', 'skills', 'issue-authoring', 'xdg');
  nodeFs.mkdirSync(xdg, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: xdg };
  installPayload({ env, homedir: home });
  const olderFile = join(xdg, 'idd-skill', PACKAGE_VERSION, ENTRY_RELATIVE);
  assert.ok(nodeFs.existsSync(olderFile));

  installPayload({
    env,
    homedir: home,
    sourceRoot: copySourceTree(),
    version: UPGRADE_VERSION,
  });

  assert.ok(nodeFs.existsSync(olderFile), 'the older version stays on disk');
  assert.ok(
    (
      JSON.parse(
        nodeFs.readFileSync(join(xdg, 'idd-skill', 'receipt.json'), 'utf8'),
      ).entries as ReceiptRow[]
    ).some((entry) => entry.path === olderFile),
    'the older version stays listed',
  );
});

test('a source skill with no SKILL.md makes install refuse before any write', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout('idd-spec-audit/SKILL.md');
  const before = snapshot(home);

  assert.throws(
    () => installPayload(upgradeOptions(home, source)),
    /has no SKILL\.md/,
  );
  assert.deepEqual(snapshot(home), before);
  assert.ok(
    nodeFs.existsSync(
      join(home, '.claude', 'skills', 'idd-spec-audit', 'SKILL.md'),
    ),
  );

  const fresh = makeHome();
  assert.throws(
    () => installPayload(upgradeOptions(fresh, source)),
    /has no SKILL\.md/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(fresh)), false);
});

test('an upgrade that drops nothing reports no removal and keeps every listed entry', () => {
  for (const harnesses of [[], ['claude']] as const) {
    const home = makeHome();
    installPayload(optionsFor(home, { harnesses }));
    const before = receiptRows(home);
    const skillsBefore = [
      ...snapshot(join(home, '.claude', 'skills')),
      ...snapshot(join(home, '.agents', 'skills')),
    ];
    const source = copySourceTree();

    const result = installPayload(upgradeOptions(home, source, { harnesses }));

    assert.ok(
      result.lines.every(
        (line) => !line.startsWith('remove ') && !line.startsWith('absent '),
      ),
      'no removal is reported',
    );
    const after = receiptRows(home);
    // The upgrade adds entries for the new version and updates the link, and
    // keeps every earlier entry listed, in its original order.
    const earlier = after.filter((entry) =>
      before.some((prior) => prior.path === entry.path),
    );
    assert.deepEqual(
      earlier.map((entry) => [entry.path, entry.kind, entry.sha256]),
      before.map((entry) => [entry.path, entry.kind, entry.sha256]),
    );
    assert.deepEqual(
      [
        ...snapshot(join(home, '.claude', 'skills')),
        ...snapshot(join(home, '.agents', 'skills')),
      ],
      skillsBefore,
      'the skill trees keep their bytes',
    );
  }
});

test('planInstall reports the removals an upgrade would make and writes nothing', () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceWithout(DROPPED_RELATIVE);
  const before = snapshot(home);

  const plan = planInstall(upgradeOptions(home, source));

  for (const root of ['.claude', '.agents'] as const) {
    assert.ok(plan.lines.includes(`remove ${droppedOf(home, root)}`));
  }
  assert.deepEqual(snapshot(home), before);
});

// --- Links above the roots (#4303) --------------------------------------------

/**
 * The real `node:fs` whose lstat reports `uid` as the owner of each listed
 * path, so a test does not depend on who runs it or who owns a link it made.
 * Root (uid 0) stands for the system, whose links are tolerated above a root.
 */
function ownedBy(uid: number, ...paths: string[]): FsOps {
  const listed = new Set(paths);
  return {
    ...nodeFs,
    lstatSync: (path: string) => {
      const stat = nodeFs.lstatSync(path);
      return listed.has(path)
        ? Object.create(stat, { uid: { value: uid } })
        : stat;
    },
  } as unknown as FsOps;
}

/** A directory outside the sandbox HOME, holding one sentinel file. */
function makeOutside(): string {
  const outside = makeSandbox('user-global-outside-');
  nodeFs.writeFileSync(join(outside, 'sentinel.txt'), 'keep\n');
  return outside;
}

/** Plan, install, plan an uninstall, and uninstall: each must refuse as a link. */
function assertRefusedEverywhere(
  options: UserGlobalOptions,
  trees: string[],
): void {
  const before = trees.map((tree) => snapshot(tree));
  for (const run of [
    planInstall,
    installPayload,
    planUninstall,
    uninstallPayload,
  ]) {
    assert.throws(() => run(options), /symbolic link/);
  }
  assert.deepEqual(
    trees.map((tree) => snapshot(tree)),
    before,
    'a refusal changes neither the home tree nor the directory outside it',
  );
}

/** A HOME with the usual directories, inside its own parent directory. */
function seedHomeIn(parent: string): string {
  const home = join(parent, 'home');
  for (const dir of ['.local/share', '.claude', '.agents']) {
    nodeFs.mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

test('a link at HOME/.local with nothing beyond it makes every entry point refuse, with HOME spelled either way', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.rmSync(join(home, '.local'), { recursive: true });
  nodeFs.symlinkSync(outside, join(home, '.local'));

  assertRefusedEverywhere(optionsFor(home), [home, outside]);
  assertRefusedEverywhere(optionsFor(`${home}/`), [home, outside]);
});

test('a link at HOME/.local/share with the data root beyond it makes every entry point refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.mkdirSync(join(outside, 'idd-skill'));
  nodeFs.rmSync(join(home, '.local', 'share'), { recursive: true });
  nodeFs.symlinkSync(outside, join(home, '.local', 'share'));

  assertRefusedEverywhere(optionsFor(home), [home, outside]);
});

test('a link at HOME/.claude or HOME/.agents with the skills directory beyond it makes install and plan refuse', {
  skip: NO_LINKS,
}, () => {
  for (const name of ['.claude', '.agents']) {
    const home = makeHome();
    const outside = makeOutside();
    nodeFs.mkdirSync(join(outside, 'skills'));
    nodeFs.rmSync(join(home, name), { recursive: true });
    nodeFs.symlinkSync(outside, join(home, name));
    const before = [snapshot(home), snapshot(outside)];

    for (const run of [planInstall, installPayload]) {
      assert.throws(() => run(optionsFor(home)), /symbolic link/);
    }
    assert.deepEqual([snapshot(home), snapshot(outside)], before);
    assert.equal(nodeFs.existsSync(dataRootOf(home)), false, name);
  }
});

test('a symbolic-link HOME is refused by every entry point, with HOME spelled either way', {
  skip: NO_LINKS,
}, () => {
  const real = makeHome();
  const link = join(makeSandbox('user-global-linkparent-'), 'home-link');
  nodeFs.symlinkSync(real, link);

  assertRefusedEverywhere(optionsFor(link), [real]);
  assertRefusedEverywhere(optionsFor(`${link}/`), [real]);
});

test('uninstall refuses a link that appeared above the data root or above a skill root after install', {
  skip: NO_LINKS,
}, () => {
  for (const name of ['.local', '.claude']) {
    const home = makeHome();
    installPayload(optionsFor(home));
    nodeFs.renameSync(join(home, name), join(home, `${name}-real`));
    nodeFs.symlinkSync(join(home, `${name}-real`), join(home, name));
    const before = snapshot(home);

    assert.throws(
      () => uninstallPayload(optionsFor(home)),
      /symbolic link/,
      name,
    );
    assert.deepEqual(snapshot(home), before, name);
  }
});

test('a symbolic-link XDG_DATA_HOME is refused by every entry point', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const real = makeSandbox('user-global-xdg-');
  nodeFs.mkdirSync(join(real, 'idd-skill'));
  const link = join(makeSandbox('user-global-linkparent-'), 'xdg-link');
  nodeFs.symlinkSync(real, link);
  const options = optionsFor(home, {
    env: { HOME: home, XDG_DATA_HOME: link },
  });

  assertRefusedEverywhere(options, [home, real]);
});

test('a root-owned link above XDG_DATA_HOME is tolerated, and a link at HOME/.local is irrelevant when XDG_DATA_HOME points elsewhere', {
  skip: NO_LINKS,
}, () => {
  const parentReal = makeSandbox('user-global-xdg-parent-');
  nodeFs.mkdirSync(join(parentReal, 'xdg'));
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const xdg = join(parentLink, 'xdg');
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.rmSync(join(home, '.local'), { recursive: true });
  nodeFs.symlinkSync(outside, join(home, '.local'));
  const before = snapshot(outside);
  const options = optionsFor(home, {
    env: { HOME: home, XDG_DATA_HOME: xdg },
    fs: ownedBy(0, parentLink),
  });

  installPayload(options);
  assert.equal(
    nodeFs.existsSync(join(parentReal, 'xdg', 'idd-skill', 'receipt.json')),
    true,
  );
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(join(parentReal, 'xdg', 'idd-skill')), false);
  assert.deepEqual(snapshot(outside), before);
});

test('a HOME reached through a root-owned linked parent installs and uninstalls as before', {
  skip: NO_LINKS,
}, () => {
  const parentReal = makeSandbox('user-global-realparent-');
  seedHomeIn(parentReal);
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const home = join(parentLink, 'home');
  const options = optionsFor(home, { fs: ownedBy(0, parentLink) });

  installPayload(options);
  assert.equal(
    nodeFs.readFileSync(
      skillFileOf(join(parentReal, 'home'), '.claude'),
      'utf8',
    ),
    nodeFs.readFileSync(join(REPO, 'skills', SKILL_RELATIVE), 'utf8'),
  );
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(dataRootOf(join(parentReal, 'home'))), false);
});

test('a link at HOME/.config does not block an install that edits no opencode file', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.symlinkSync(outside, join(home, '.config'));
  const before = snapshot(outside);

  installPayload(optionsFor(home, { harnesses: ['claude'] }));
  assert.deepEqual(snapshot(outside), before);
  uninstallPayload(optionsFor(home, { harnesses: ['claude'] }));
});

test('a link planted above the data root during an install makes the next step refuse and no payload lands', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  let planted = false;
  const fs = hookedFs((op, args) => {
    if (planted || op !== 'renameSync') return;
    if (!String(args[1]).endsWith('receipt.json')) return;
    planted = true;
    nodeFs.renameSync(join(home, '.local'), join(home, '.local-real'));
    nodeFs.symlinkSync(join(home, '.local-real'), join(home, '.local'));
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs })),
    (error: Error) =>
      /symbolic link/.test(error.message) &&
      /rollback left these paths in place/.test(error.message),
    'the rollback refuses through the link too, and names what it left',
  );
  assert.equal(planted, true);
  assert.equal(
    nodeFs.existsSync(
      join(home, '.local-real', 'share', 'idd-skill', PACKAGE_VERSION),
    ),
    false,
    'no payload version directory landed after the link appeared',
  );
  assert.equal(nodeFs.existsSync(join(home, '.claude', 'skills')), false);
  assert.equal(nodeFs.existsSync(join(home, '.agents', 'skills')), false);
});

test('a link planted above the data root during an uninstall stops it and leaves the payload version in place', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  let planted = false;
  const fs = hookedFs((op) => {
    if (planted || op !== 'unlinkSync') return;
    planted = true;
    nodeFs.renameSync(join(home, '.local'), join(home, '.local-real'));
    nodeFs.symlinkSync(join(home, '.local-real'), join(home, '.local'));
  });

  assert.throws(
    () => uninstallPayload(optionsFor(home, { fs })),
    /symbolic link/,
  );
  assert.equal(planted, true);
  assert.equal(
    nodeFs.existsSync(
      join(home, '.local-real', 'share', 'idd-skill', PACKAGE_VERSION),
    ),
    true,
    'the payload version directory is still in place',
  );
});

test('XDG_DATA_HOME exported as the default location does not hide a link above it', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.mkdirSync(join(outside, 'share'));
  nodeFs.rmSync(join(home, '.local'), { recursive: true });
  nodeFs.symlinkSync(outside, join(home, '.local'));
  const options = optionsFor(home, {
    env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') },
  });

  assertRefusedEverywhere(options, [home, outside]);
});

test('a CODEX_HOME outside HOME is declared by its parent: a root-owned link above the parent is tolerated, a link at the parent is refused', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const parentReal = makeSandbox('user-global-codexparent-');
  nodeFs.mkdirSync(join(parentReal, 'roots', 'codex'), { recursive: true });
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const options = optionsFor(home, {
    env: { HOME: home, CODEX_HOME: join(parentLink, 'roots', 'codex') },
    harnesses: ['codex'],
    fs: ownedBy(0, parentLink),
  });

  installPayload(options);
  const agents = join(parentReal, 'roots', 'codex', 'AGENTS.md');
  assert.equal(nodeFs.existsSync(agents), true);
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(agents), false);

  const real = makeSandbox('user-global-codexreal-');
  nodeFs.mkdirSync(join(real, 'codex'));
  const link = join(makeSandbox('user-global-linkparent-'), 'codex-parent');
  nodeFs.symlinkSync(real, link);
  const refused = optionsFor(home, {
    env: { HOME: home, CODEX_HOME: join(link, 'codex') },
    harnesses: ['codex'],
  });
  assert.throws(() => installPayload(refused), /symbolic link/);
  assert.deepEqual(nodeFs.readdirSync(join(real, 'codex')), []);
});

test('an XDG_CONFIG_HOME outside HOME is a declared root: a root-owned link above it is tolerated', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const parentReal = makeSandbox('user-global-cfgparent-');
  nodeFs.mkdirSync(join(parentReal, 'cfg'));
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const options = optionsFor(home, {
    env: { HOME: home, XDG_CONFIG_HOME: join(parentLink, 'cfg') },
    harnesses: ['opencode'],
    fs: ownedBy(0, parentLink),
  });

  installPayload(options);
  const config = join(parentReal, 'cfg', 'opencode', 'opencode.json');
  assert.equal(nodeFs.existsSync(config), true);
  uninstallPayload(options);
  assert.equal(nodeFs.existsSync(config), false);
});

test('a link planted above an entry-file directory during an install makes the entry step refuse', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  nodeFs.mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  let planted = false;
  const fs = hookedFs((op, args) => {
    if (planted || op !== 'renameSync') return;
    if (!String(args[1]).endsWith('receipt.json')) return;
    planted = true;
    nodeFs.renameSync(join(home, '.config'), join(home, '.config-real'));
    nodeFs.symlinkSync(join(home, '.config-real'), join(home, '.config'));
  });

  assert.throws(
    () => installPayload(optionsFor(home, { fs, harnesses: ['opencode'] })),
    /symbolic link/,
  );
  assert.equal(planted, true);
  assert.equal(
    nodeFs.existsSync(join(home, '.config-real', 'opencode', 'opencode.json')),
    false,
    'the entry file did not land through the link',
  );
});

test('a CODEX_HOME beside HOME under a root-owned linked ancestor does not make the other roots stricter', {
  skip: NO_LINKS,
}, () => {
  const parentReal = makeSandbox('user-global-sharedparent-');
  seedHomeIn(parentReal);
  nodeFs.mkdirSync(join(parentReal, 'codex'));
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const home = join(parentLink, 'home');
  const env = { HOME: home, CODEX_HOME: join(parentLink, 'codex') };
  const fs = ownedBy(0, parentLink);

  // No codex harness is selected, so the declared parent is never walked.
  installPayload(optionsFor(home, { env, fs }));
  uninstallPayload(optionsFor(home, { env, fs }));
  // The entry-file walk starts at that parent, which must be a real directory.
  assert.throws(
    () => installPayload(optionsFor(home, { env, fs, harnesses: ['codex'] })),
    /symbolic link/,
  );
  assert.equal(
    nodeFs.existsSync(join(parentReal, 'codex', 'AGENTS.md')),
    false,
  );
});

test('a symbolic-link XDG_CONFIG_HOME is refused when the opencode harness is selected', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const real = makeSandbox('user-global-cfgreal-');
  const link = join(makeSandbox('user-global-linkparent-'), 'cfg-link');
  nodeFs.symlinkSync(real, link);
  const options = optionsFor(home, {
    env: { HOME: home, XDG_CONFIG_HOME: link },
    harnesses: ['opencode'],
  });
  const before = snapshot(real);

  assert.throws(() => installPayload(options), /symbolic link/);
  assert.deepEqual(snapshot(real), before);
});

test('a link planted above the data root during an upgrade refuses and keeps the prior current target', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  installPayload(optionsFor(home));
  const source = copySourceTree();
  nodeFs.appendFileSync(join(source, 'skills', SKILL_RELATIVE), '\nupgrade\n');
  let planted = false;
  const fs = hookedFs((op, args) => {
    if (planted || op !== 'renameSync') return;
    if (!String(args[1]).endsWith('receipt.json')) return;
    planted = true;
    nodeFs.renameSync(join(home, '.local'), join(home, '.local-real'));
    nodeFs.symlinkSync(join(home, '.local-real'), join(home, '.local'));
  });

  assert.throws(
    () =>
      installPayload(
        optionsFor(home, { sourceRoot: source, version: UPGRADE_VERSION, fs }),
      ),
    /symbolic link/,
  );
  assert.equal(planted, true);
  const moved = join(home, '.local-real', 'share', 'idd-skill');
  assert.equal(nodeFs.readlinkSync(join(moved, 'current')), versionDirOf(home));
  assert.deepEqual(
    nodeFs.readdirSync(join(moved, UPGRADE_VERSION)),
    [],
    'only the directory made before the link appeared exists, and it is empty',
  );
});

test('the refusal for a link above the data root names the remedy and says nothing changed', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  const outside = makeOutside();
  nodeFs.mkdirSync(join(outside, 'idd-skill'));
  nodeFs.rmSync(join(home, '.local', 'share'), { recursive: true });
  nodeFs.symlinkSync(outside, join(home, '.local', 'share'));

  assert.throws(
    () => installPayload(optionsFor(home)),
    /nothing was written.*symbolic link.*move the real directory into the link's place/s,
  );
  assert.throws(
    () => uninstallPayload(optionsFor(home)),
    /nothing was removed.*symbolic link.*move the real directory into the link's place/s,
  );
});

test('a regular file on the chain is refused without the link remedy, once per run', {
  skip: NO_LINKS,
}, () => {
  const home = makeHome();
  nodeFs.rmSync(join(home, '.local'), { recursive: true });
  nodeFs.writeFileSync(join(home, '.local'), 'not a directory\n');

  for (const run of [installPayload, uninstallPayload]) {
    assert.throws(
      () => run(optionsFor(home)),
      (error: Error) =>
        /is not a directory/.test(error.message) &&
        !/move the real directory/.test(error.message),
    );
  }
});

test('a platform without the no-follow opens is refused once by install and uninstall, writing nothing', () => {
  const home = makeHome();
  const noFollow = {
    ...nodeFs,
    constants: {
      ...nodeFs.constants,
      O_NOFOLLOW: undefined,
      O_NONBLOCK: undefined,
    },
  } as unknown as FsOps;
  const before = snapshot(home);

  for (const run of [installPayload, uninstallPayload]) {
    assert.throws(
      () => run(optionsFor(home, { fs: noFollow })),
      (error: Error) =>
        error.message.split('does not support').length === 2 &&
        !/move the real directory/.test(error.message),
    );
  }
  assert.deepEqual(snapshot(home), before);
});

test('a HOME reached through a linked parent that root does not own is refused by every entry point, and nothing is written', {
  skip: NO_LINKS,
}, () => {
  const parentReal = makeSandbox('user-global-realparent-');
  seedHomeIn(parentReal);
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const home = join(parentLink, 'home');
  const options = optionsFor(home, { fs: ownedBy(1234, parentLink) });

  assertRefusedEverywhere(options, [parentReal]);
  assert.throws(
    () => installPayload(options),
    /linked is a symbolic link above .* that the system does not own \(owner uid 1234\)/,
  );
  assert.equal(nodeFs.existsSync(dataRootOf(join(parentReal, 'home'))), false);
});

test('a link above XDG_DATA_HOME that a user owns is refused by every entry point', {
  skip: NO_LINKS,
}, () => {
  const parentReal = makeSandbox('user-global-xdg-parent-');
  nodeFs.mkdirSync(join(parentReal, 'xdg'));
  const parentLink = join(makeSandbox('user-global-linkparent-'), 'linked');
  nodeFs.symlinkSync(parentReal, parentLink);
  const home = makeHome();
  const options = optionsFor(home, {
    env: { HOME: home, XDG_DATA_HOME: join(parentLink, 'xdg') },
    fs: ownedBy(1234, parentLink),
  });

  assertRefusedEverywhere(options, [home, parentReal]);
});
