import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCommandCatalog,
  buildHelperRuntimeManifest,
  collectHelperRuntimeEvidence,
  collectVendoredFiles,
  detectPackageManager,
  detectPnpmMajor,
  PNPM_DLX_MIN_MAJOR,
  readHelperExtraRuntimeFiles,
  recommendHelperRuntimeProfile,
  resolveHelperCommandForProfile,
  resolveHelperEntryClosure,
  resolveLauncher,
  resolveSourcePackageMetadata,
} from '../src/scripts/helper-runtime-manifest.mts';
import { trackTempDirectories } from './temp-fixtures.mts';

// #4049: every fixture directory below is removed when the file finishes.
const makeTempDir = trackTempDirectories();

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PACKAGE_SPEC =
  'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/refs/heads/main';

function makeRuntimePackageFixture(prefix: string) {
  const fixtureRoot = makeTempDir(join(tmpdir(), prefix));
  const packageRoot = join(fixtureRoot, 'package');
  mkdirSync(packageRoot, { recursive: true });
  return { fixtureRoot, packageRoot };
}

function writeRuntimePackageFile(
  packageRoot: string,
  relativePath: string,
  contents = '',
): string {
  const filePath = join(packageRoot, ...relativePath.split('/'));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  return filePath;
}

function writeRuntimeInitializer(
  packageRoot: string,
  initializer: string,
): void {
  writeRuntimePackageFile(
    packageRoot,
    'src/scripts/helper-runtime-manifest.mts',
    `const EXTRA_RUNTIME_FILES = new Map<string, string[]>(${initializer});\n`,
  );
}

function sortUtf8Paths(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

test('manifest records the package-manager-only verify-import-mirror exception', () => {
  const manifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  });

  assert.deepEqual(manifest.packageManagerOnlyHelpers, [
    {
      id: 'verify-import-mirror',
      sourceEntryPath: 'scripts/verify-import-mirror.mjs',
      installedEntryPath:
        'node_modules/@kurone-kito/idd-skill/scripts/verify-import-mirror.mjs',
      invocation:
        'node node_modules/@kurone-kito/idd-skill/scripts/verify-import-mirror.mjs',
    },
  ]);
  assert.equal(
    manifest.profiles['package-manager'].commands['idd:verify-import-mirror'],
    undefined,
  );
});

test('package-manager profile emits manager-specific install commands without hard-coded pnpm', () => {
  const expectedInstall: Record<string, string> = {
    npm: `npm install --save-dev ${DEFAULT_PACKAGE_SPEC}`,
    pnpm: `pnpm add -D ${DEFAULT_PACKAGE_SPEC}`,
    yarn: `yarn add --dev ${DEFAULT_PACKAGE_SPEC}`,
  };

  for (const packageManager of ['npm', 'pnpm', 'yarn']) {
    const manifest = buildHelperRuntimeManifest({
      profile: 'package-manager',
      packageManager,
      targetRoot: REPO_ROOT,
    });
    const profile = manifest.profiles['package-manager'];

    assert.equal(profile.packageManager, packageManager);
    assert.equal(profile.installCommand, expectedInstall[packageManager]);
    assert.deepEqual(profile.managedDependencies, {
      devDependencies: {
        '@kurone-kito/idd-skill': DEFAULT_PACKAGE_SPEC,
      },
    });
    if (packageManager !== 'pnpm') {
      assert.doesNotMatch(profile.installCommand, /\bpnpm\b/);
    }
    for (const command of Object.values(profile.managedPackageJsonScripts)) {
      assert.doesNotMatch(command, /\bpnpm\b/);
    }
  }
});

test('instructions-only profile omits helper files, scripts, and dependencies', () => {
  const manifest = buildHelperRuntimeManifest({
    profile: 'instructions-only',
    targetRoot: REPO_ROOT,
  });
  const profile = manifest.profiles['instructions-only'];

  assert.deepEqual(profile.managedFiles, []);
  assert.deepEqual(profile.managedPackageJsonScripts, {});
  assert.deepEqual(profile.managedDependencies, {
    devDependencies: {},
  });
  assert.deepEqual(profile.commands, {});
});

test('vendored-node managed files match the canonical helper import closure', () => {
  const manifest = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });
  const managedFiles = manifest.profiles['vendored-node'].managedFiles.map(
    (file) => file.targetPath,
  );
  const expectedFiles = collectVendoredFiles(REPO_ROOT).map(
    (file) => file.targetPath,
  );

  assert.deepEqual(managedFiles, expectedFiles);
  assert.ok(managedFiles.includes('scripts/external-check-waiver.mjs'));
  assert.ok(managedFiles.includes('scripts/forced-handoff-marker.mjs'));
  assert.ok(managedFiles.includes('scripts/protocol-helpers.mjs'));
  assert.ok(managedFiles.includes('scripts/idd-doctor.mjs'));
  assert.ok(managedFiles.includes('schemas/forced-handoff-marker.schema.json'));
  assert.ok(managedFiles.includes('schemas/pre-merge-readiness.schema.json'));
  assert.ok(managedFiles.includes('schemas/advisory-wait-state.schema.json'));
  assert.ok(managedFiles.includes('schemas/policy.schema.json'));
  for (const relativePath of managedFiles) {
    assert.equal(existsSync(join(REPO_ROOT, relativePath)), true, relativePath);
  }
});

test('vendored-node managed files include every validate-schemas runtime data file', () => {
  const managedFiles = new Set(
    buildHelperRuntimeManifest({
      profile: 'vendored-node',
      targetRoot: REPO_ROOT,
    }).profiles['vendored-node'].managedFiles.map((file) => file.targetPath),
  );

  // validate-schemas reads its schema/fixture pairs directly (its CLI `cases`
  // table), not via `import`, so the import-graph walk cannot discover them.
  // Parse the source for every data path it references and assert the vendored
  // bundle ships all of them — a downstream that vendors exactly `managedFiles`
  // must be able to run the validator. Guards the kurone-kito/idd-skill#891 drift.
  const source = readFileSync(
    join(REPO_ROOT, 'src/scripts/validate-schemas.mts'),
    'utf8',
  );
  const referenced = [
    ...new Set(
      [
        // Match either quote style via a backreference so a future case
        // written with double quotes is still captured (biome enforces single
        // quotes today, but the guard must not silently depend on that).
        ...source.matchAll(
          /(['"])((?:schemas|fixtures\/schemas)\/[^'"]+\.json)\1/g,
        ),
      ].map((match) => match[2]),
    ),
  ].sort();

  assert.ok(
    referenced.length > 0,
    'expected validate-schemas to reference schema/fixture data files',
  );
  for (const dataFile of referenced) {
    assert.ok(
      managedFiles.has(dataFile),
      `vendored-node managedFiles omits ${dataFile}, which validate-schemas reads at runtime`,
    );
  }
});

test('resolveHelperEntryClosure follows in-root static and dynamic imports and sorts unique files by UTF-8 bytes', () => {
  const { fixtureRoot, packageRoot } = makeRuntimePackageFixture(
    'idd-helper-entry-closure-',
  );
  const bmpName = '\uE000.mjs';
  const supplementaryName = '\u{10000}.mjs';
  writeRuntimePackageFile(
    packageRoot,
    'scripts/entry.mjs',
    [
      "import './static.mjs';",
      "void import('./dynamic.mjs');",
      "import '../../outside.mjs';",
      "import './missing.mjs';",
      "import './directory';",
      "import './data.json';",
      `import './${bmpName}';`,
      `import './${supplementaryName}';`,
    ].join('\n'),
  );
  writeRuntimePackageFile(packageRoot, 'scripts/static.mjs', 'export {};');
  writeRuntimePackageFile(packageRoot, 'scripts/dynamic.mjs', 'export {};');
  writeRuntimePackageFile(packageRoot, 'scripts/data.json', '{}');
  writeRuntimePackageFile(packageRoot, `scripts/${bmpName}`, 'export {};');
  writeRuntimePackageFile(
    packageRoot,
    `scripts/${supplementaryName}`,
    'export {};',
  );
  writeRuntimePackageFile(packageRoot, 'scripts/unused.mjs', 'export {};');
  mkdirSync(join(packageRoot, 'scripts/directory'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'outside.mjs'), 'export {};');

  const closure = resolveHelperEntryClosure('scripts/entry.mjs', {
    packageRoot,
    extraRuntimeFiles: new Map([
      [
        'scripts/entry.mjs',
        ['scripts/data.json', 'scripts/static.mjs', 'scripts/data.json'],
      ],
    ]),
  });
  const expected = sortUtf8Paths([
    'scripts/entry.mjs',
    'scripts/static.mjs',
    'scripts/dynamic.mjs',
    'scripts/data.json',
    `scripts/${bmpName}`,
    `scripts/${supplementaryName}`,
  ]);

  assert.deepEqual(closure, expected);
  assert.equal(new Set(closure).size, closure.length);
  assert.notDeepEqual(closure, [...closure].sort());
  assert.equal(closure.includes('scripts/unused.mjs'), false);
  assert.equal(closure.includes('scripts/directory'), false);
  assert.equal(closure.includes('../outside.mjs'), false);
});

test('resolveHelperEntryClosure rejects absent, outside, and non-file entries and data paths', () => {
  const { fixtureRoot, packageRoot } = makeRuntimePackageFixture(
    'idd-helper-entry-invalid-',
  );
  writeRuntimePackageFile(packageRoot, 'scripts/entry.mjs', 'export {};');
  mkdirSync(join(packageRoot, 'scripts/directory'), { recursive: true });
  mkdirSync(join(packageRoot, 'scripts/data-directory'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'outside.mjs'), 'export {};');
  writeFileSync(join(fixtureRoot, 'outside-data.json'), '{}');

  assert.throws(
    () =>
      resolveHelperEntryClosure(undefined as unknown as string, {
        packageRoot,
      }),
    /entry path must be a slash-separated relative path/,
  );
  for (const { entryPath, error } of [
    {
      entryPath: '',
      error: /entry path must be a slash-separated relative path/,
    },
    {
      entryPath: 'scripts/missing.mjs',
      error: /entry path is missing or is not a regular file/,
    },
    {
      entryPath: 'scripts/directory',
      error: /entry path is missing or is not a regular file/,
    },
    {
      entryPath: '../outside.mjs',
      error: /entry path resolves outside the package root/,
    },
  ]) {
    assert.throws(
      () => resolveHelperEntryClosure(entryPath, { packageRoot }),
      error,
    );
  }
  for (const { dataPath, error } of [
    {
      dataPath: 'scripts/missing-data.json',
      error:
        /extra runtime file for scripts\/entry\.mjs is missing or is not a regular file/,
    },
    {
      dataPath: 'scripts/data-directory',
      error:
        /extra runtime file for scripts\/entry\.mjs is missing or is not a regular file/,
    },
    {
      dataPath: '../outside-data.json',
      error:
        /extra runtime file for scripts\/entry\.mjs resolves outside the package root/,
    },
  ]) {
    assert.throws(
      () =>
        resolveHelperEntryClosure('scripts/entry.mjs', {
          packageRoot,
          extraRuntimeFiles: new Map([['scripts/entry.mjs', [dataPath]]]),
        }),
      error,
    );
  }
});

test('resolveHelperEntryClosure defaults match the parsed extra runtime map and preserve aggregate closure parity', () => {
  const extraRuntimeFiles = readHelperExtraRuntimeFiles(REPO_ROOT);
  const defaultClosure = resolveHelperEntryClosure(
    'scripts/ci-wait-policy.mjs',
  );
  const customMapClosure = resolveHelperEntryClosure(
    'scripts/ci-wait-policy.mjs',
    { extraRuntimeFiles },
  );

  assert.deepEqual(defaultClosure, customMapClosure);
  assert.ok(defaultClosure.includes('scripts/validate-schemas.mjs'));
  assert.ok(defaultClosure.includes('schemas/policy.schema.json'));
  assert.deepEqual(defaultClosure, sortUtf8Paths(defaultClosure));
  assert.equal(new Set(defaultClosure).size, defaultClosure.length);
  for (const path of defaultClosure) {
    assert.equal(existsSync(join(REPO_ROOT, ...path.split('/'))), true, path);
  }

  const advisoryClosure = resolveHelperEntryClosure(
    'scripts/advisory-convergence.mjs',
  );
  assert.equal(
    advisoryClosure.includes('schemas/advisory-convergence.schema.json'),
    false,
  );

  const perEntryUnion = new Set(
    buildCommandCatalog().flatMap((command) => [
      ...resolveHelperEntryClosure(command.entryPath),
      ...command.contractPaths,
    ]),
  );
  const collected = collectVendoredFiles(REPO_ROOT).map(
    (file) => file.targetPath,
  );
  assert.deepEqual(sortUtf8Paths(perEntryUnion), sortUtf8Paths(collected));
});

test('readHelperExtraRuntimeFiles parses comments, trailing commas, and multiple keys without evaluating source', () => {
  const { packageRoot } = makeRuntimePackageFixture(
    'idd-helper-runtime-map-valid-',
  );
  writeRuntimePackageFile(packageRoot, 'scripts/one.mjs', 'export {};');
  writeRuntimePackageFile(packageRoot, 'scripts/two.mjs', 'export {};');
  writeRuntimePackageFile(packageRoot, 'data/one.json', '{}');
  writeRuntimePackageFile(packageRoot, 'data/two.json', '{}');
  writeRuntimeInitializer(
    packageRoot,
    `[
      // brackets in comments do not change the initializer span: [ ]
      ['scripts/one.mjs', ['data/one.json',],],
      ['scripts/two.mjs', ['data/two.json']] // trailing outer comma follows
      ,]`,
  );

  assert.deepEqual(
    readHelperExtraRuntimeFiles(packageRoot),
    new Map([
      ['scripts/one.mjs', ['data/one.json']],
      ['scripts/two.mjs', ['data/two.json']],
    ]),
  );
});

test('readHelperExtraRuntimeFiles normalizes paths without traversing mapped data files', () => {
  const { packageRoot } = makeRuntimePackageFixture(
    'idd-helper-runtime-map-normalized-paths-',
  );
  writeRuntimePackageFile(
    packageRoot,
    'scripts/one.mjs',
    "import './dependency.mjs';",
  );
  writeRuntimePackageFile(packageRoot, 'scripts/dependency.mjs', 'export {};');
  writeRuntimePackageFile(
    packageRoot,
    'data/one.json',
    `{"note":"import './not-traversed.mjs'"}`,
  );
  writeRuntimePackageFile(packageRoot, 'data/not-traversed.mjs', 'export {};');
  writeRuntimeInitializer(
    packageRoot,
    "[['scripts/../scripts/one.mjs', ['data/./one.json']]]",
  );

  const extraRuntimeFiles = readHelperExtraRuntimeFiles(packageRoot);
  assert.deepEqual(
    extraRuntimeFiles,
    new Map([['scripts/one.mjs', ['data/one.json']]]),
  );
  assert.deepEqual(
    resolveHelperEntryClosure('scripts/one.mjs', {
      packageRoot,
      extraRuntimeFiles,
    }),
    ['data/one.json', 'scripts/dependency.mjs', 'scripts/one.mjs'],
  );
});

test('readHelperExtraRuntimeFiles rejects missing, unclosed, unknown, malformed, and duplicate initializers', () => {
  const cases = [
    {
      name: 'missing initializer',
      source: 'export const OTHER = new Map([]);',
      error: /EXTRA_RUNTIME_FILES initializer was not found/,
    },
    {
      name: 'unclosed initializer',
      source:
        "const EXTRA_RUNTIME_FILES = new Map<string, string[]>([['scripts/one.mjs', []]",
      error: /EXTRA_RUNTIME_FILES initializer array is not closed/,
    },
    {
      name: 'unknown lexeme',
      initializer: '[[identifier, []]]',
      error: /EXTRA_RUNTIME_FILES initializer has an unsupported lexeme/,
    },
    {
      name: 'entry with no path',
      initializer: '[[, []]]',
      error: /EXTRA_RUNTIME_FILES initializer expected string/,
    },
    {
      name: 'entry with two paths',
      initializer: "[['scripts/one.mjs', 'scripts/two.mjs', []]]",
      error: /EXTRA_RUNTIME_FILES initializer expected open/,
    },
    {
      name: 'duplicate path',
      initializer: "[['scripts/one.mjs', []], ['scripts/one.mjs', []]]",
      error: /EXTRA_RUNTIME_FILES entry is duplicated: scripts\/one\.mjs/,
    },
    {
      name: 'duplicate normalized path',
      initializer: "[['scripts/one.mjs', []], ['scripts/./one.mjs', []]]",
      error:
        /EXTRA_RUNTIME_FILES entry is duplicated after path normalization: scripts\/one\.mjs/,
    },
  ];

  for (const { name, source, initializer, error } of cases) {
    const { packageRoot } = makeRuntimePackageFixture(
      `idd-helper-runtime-map-invalid-${name.replaceAll(' ', '-')}-`,
    );
    writeRuntimePackageFile(packageRoot, 'scripts/one.mjs', 'export {};');
    writeRuntimePackageFile(packageRoot, 'scripts/two.mjs', 'export {};');
    writeRuntimePackageFile(
      packageRoot,
      'src/scripts/helper-runtime-manifest.mts',
      source ??
        `const EXTRA_RUNTIME_FILES = new Map<string, string[]>(${initializer});\n`,
    );
    assert.throws(() => readHelperExtraRuntimeFiles(packageRoot), error, name);
  }
});

test('readHelperExtraRuntimeFiles rejects invalid entry and data file paths', () => {
  const { fixtureRoot } = makeRuntimePackageFixture(
    'idd-helper-runtime-map-paths-',
  );
  const cases = [
    {
      entryPath: 'scripts/missing.mjs',
      dataPaths: [],
      error: /EXTRA_RUNTIME_FILES entry is missing or is not a regular file/,
    },
    {
      entryPath: 'scripts/directory',
      dataPaths: [],
      error: /EXTRA_RUNTIME_FILES entry is missing or is not a regular file/,
    },
    {
      entryPath: '../outside.mjs',
      dataPaths: [],
      error: /EXTRA_RUNTIME_FILES entry resolves outside the package root/,
    },
    {
      entryPath: 'scripts/entry.mjs',
      dataPaths: ['data/missing.json'],
      error:
        /EXTRA_RUNTIME_FILES data file for scripts\/entry\.mjs is missing or is not a regular file/,
    },
    {
      entryPath: 'scripts/entry.mjs',
      dataPaths: ['data/directory'],
      error:
        /EXTRA_RUNTIME_FILES data file for scripts\/entry\.mjs is missing or is not a regular file/,
    },
    {
      entryPath: 'scripts/entry.mjs',
      dataPaths: ['../outside-data.json'],
      error:
        /EXTRA_RUNTIME_FILES data file for scripts\/entry\.mjs resolves outside the package root/,
    },
  ];

  for (const { entryPath, dataPaths, error } of cases) {
    const packageRoot = join(
      fixtureRoot,
      entryPath.includes('directory') ? 'dir-case' : 'case',
    );
    mkdirSync(packageRoot, { recursive: true });
    writeRuntimePackageFile(packageRoot, 'scripts/entry.mjs', 'export {};');
    if (entryPath === 'scripts/directory') {
      mkdirSync(join(packageRoot, 'scripts/directory'), { recursive: true });
    }
    if (dataPaths.includes('data/directory')) {
      mkdirSync(join(packageRoot, 'data/directory'), { recursive: true });
    }
    if (entryPath === '../outside.mjs') {
      writeFileSync(join(fixtureRoot, 'outside.mjs'), 'export {};');
    }
    if (dataPaths.includes('../outside-data.json')) {
      writeFileSync(join(fixtureRoot, 'outside-data.json'), '{}');
    }
    writeRuntimeInitializer(
      packageRoot,
      `[\n  [${JSON.stringify(entryPath)}, ${JSON.stringify(dataPaths)}],\n]`,
    );
    assert.throws(() => readHelperExtraRuntimeFiles(packageRoot), error);
  }
});

test('vendored-node recommends linguist-vendored per managed file; other profiles emit none', () => {
  const manifest = buildHelperRuntimeManifest({ targetRoot: REPO_ROOT });
  const vendored = manifest.profiles['vendored-node'];

  // Exactly one `<path> linguist-vendored` line per managed file, in the
  // same order, and nothing else. Adding a managed file without a matching
  // attribute line (or vice versa) fails this deepEqual.
  const expected = vendored.managedFiles.map(
    (file) => `${file.targetPath} linguist-vendored`,
  );
  assert.deepEqual(vendored.recommendedGitattributes, expected);
  assert.equal(
    vendored.recommendedGitattributes.length,
    vendored.managedFiles.length,
  );
  assert.ok(
    vendored.recommendedGitattributes.includes(
      'scripts/protocol-helpers.mjs linguist-vendored',
    ),
  );

  // Only the vendored-node profile vends files, so only it carries a
  // recommendation; the others omit the field entirely.
  for (const profileName of [
    'package-manager',
    'ephemeral-npx',
    'instructions-only',
  ]) {
    // Assert the key is genuinely absent, not merely `=== undefined`
    // (which would also pass for a present-but-undefined property).
    assert.equal(
      Object.hasOwn(manifest.profiles[profileName], 'recommendedGitattributes'),
      false,
      profileName,
    );
  }
});

test('detectPackageManager respects package metadata and lockfiles', () => {
  const packageJsonRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-package-json-'),
  );
  writeFileSync(
    join(packageJsonRoot, 'package.json'),
    JSON.stringify({ packageManager: 'npm@10.9.0' }),
  );
  assert.equal(detectPackageManager(packageJsonRoot), 'npm');

  const lockfileRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-lockfile-'),
  );
  writeFileSync(join(lockfileRoot, 'yarn.lock'), '# lockfile');
  assert.equal(detectPackageManager(lockfileRoot), 'yarn');

  const ambiguousRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-ambiguous-lockfile-'),
  );
  writeFileSync(join(ambiguousRoot, 'package-lock.json'), '{}');
  writeFileSync(join(ambiguousRoot, 'yarn.lock'), '# lockfile');
  assert.equal(detectPackageManager(ambiguousRoot), '');
});

test('npm-shrinkwrap.json is npm lockfile evidence, counted by manager (issue #4720)', () => {
  const shrinkwrapRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-shrinkwrap-'),
  );
  writeFileSync(
    join(shrinkwrapRoot, 'package.json'),
    JSON.stringify({ name: 'target-app' }),
  );
  writeFileSync(join(shrinkwrapRoot, 'npm-shrinkwrap.json'), '{}');
  assert.equal(detectPackageManager(shrinkwrapRoot), 'npm');
  assert.deepEqual(recommendHelperRuntimeProfile(shrinkwrapRoot), {
    profile: 'package-manager',
    packageManager: 'npm',
    reason:
      'Detected exactly one supported package manager from lockfile evidence.',
    evidence: {
      hasPackageJson: true,
      declaredPackageManager: '',
      lockfileMatches: [{ filename: 'npm-shrinkwrap.json', manager: 'npm' }],
      detectedPackageManager: 'npm',
      packageJsonOnly: false,
      ambiguousPackageManager: false,
    },
  });

  // package-lock.json and npm-shrinkwrap.json together are one npm manager.
  const bothNpmRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-both-npm-'),
  );
  writeFileSync(join(bothNpmRoot, 'package-lock.json'), '{}');
  writeFileSync(join(bothNpmRoot, 'npm-shrinkwrap.json'), '{}');
  assert.deepEqual(collectHelperRuntimeEvidence(bothNpmRoot), {
    hasPackageJson: false,
    declaredPackageManager: '',
    lockfileMatches: [
      { filename: 'package-lock.json', manager: 'npm' },
      { filename: 'npm-shrinkwrap.json', manager: 'npm' },
    ],
    detectedPackageManager: 'npm',
    packageJsonOnly: false,
    ambiguousPackageManager: false,
  });

  // A supported declaration still wins over a shrinkwrap and another lockfile.
  const declaredRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-declared-shrinkwrap-'),
  );
  writeFileSync(
    join(declaredRoot, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@9.15.0' }),
  );
  writeFileSync(join(declaredRoot, 'npm-shrinkwrap.json'), '{}');
  writeFileSync(join(declaredRoot, 'yarn.lock'), '# lockfile');
  assert.equal(detectPackageManager(declaredRoot), 'pnpm');
  assert.equal(
    collectHelperRuntimeEvidence(declaredRoot).ambiguousPackageManager,
    false,
  );

  // An undeclared shrinkwrap plus a different manager's lockfile is ambiguous.
  const ambiguousLockfiles = [
    { filename: 'yarn.lock', content: '# lockfile' },
    { filename: 'pnpm-lock.yaml', content: "lockfileVersion: '9.0'" },
  ];
  for (const { filename, content } of ambiguousLockfiles) {
    const ambiguousRoot = makeTempDir(
      join(tmpdir(), 'idd-helper-runtime-shrinkwrap-ambiguous-'),
    );
    writeFileSync(join(ambiguousRoot, 'npm-shrinkwrap.json'), '{}');
    writeFileSync(join(ambiguousRoot, filename), content);
    assert.equal(detectPackageManager(ambiguousRoot), '');
    assert.equal(
      recommendHelperRuntimeProfile(ambiguousRoot).profile,
      'vendored-node',
    );
    assert.equal(
      collectHelperRuntimeEvidence(ambiguousRoot).ambiguousPackageManager,
      true,
    );
  }
});

test('helper runtime evidence and recommendation stay fail-closed around package-manager detection', () => {
  const packageJsonRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-recommend-package-json-'),
  );
  writeFileSync(
    join(packageJsonRoot, 'package.json'),
    JSON.stringify({ packageManager: 'npm@10.9.0' }),
  );
  assert.deepEqual(recommendHelperRuntimeProfile(packageJsonRoot), {
    profile: 'package-manager',
    packageManager: 'npm',
    reason: 'Detected supported packageManager metadata.',
    evidence: {
      hasPackageJson: true,
      declaredPackageManager: 'npm',
      lockfileMatches: [],
      detectedPackageManager: 'npm',
      packageJsonOnly: false,
      ambiguousPackageManager: false,
    },
  });

  const lockfileRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-recommend-lockfile-'),
  );
  writeFileSync(join(lockfileRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'");
  assert.deepEqual(recommendHelperRuntimeProfile(lockfileRoot), {
    profile: 'package-manager',
    packageManager: 'pnpm',
    reason:
      'Detected exactly one supported package manager from lockfile evidence.',
    evidence: {
      hasPackageJson: false,
      declaredPackageManager: '',
      lockfileMatches: [{ filename: 'pnpm-lock.yaml', manager: 'pnpm' }],
      detectedPackageManager: 'pnpm',
      packageJsonOnly: false,
      ambiguousPackageManager: false,
    },
  });

  const packageJsonOnlyRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-recommend-package-json-only-'),
  );
  writeFileSync(
    join(packageJsonOnlyRoot, 'package.json'),
    JSON.stringify({ name: 'target-app' }),
  );
  assert.deepEqual(collectHelperRuntimeEvidence(packageJsonOnlyRoot), {
    hasPackageJson: true,
    declaredPackageManager: '',
    lockfileMatches: [],
    detectedPackageManager: '',
    packageJsonOnly: true,
    ambiguousPackageManager: false,
  });
  assert.deepEqual(recommendHelperRuntimeProfile(packageJsonOnlyRoot), {
    profile: 'instructions-only',
    packageManager: '',
    reason:
      'package.json alone is not enough evidence to assume npm, another package manager, or a real Node.js helper path. Keep instructions-only unless separate repository evidence confirms a real Node.js helper path; if helper support is still desired then, prefer vendored-node before ephemeral-npx.',
    evidence: {
      hasPackageJson: true,
      declaredPackageManager: '',
      lockfileMatches: [],
      detectedPackageManager: '',
      packageJsonOnly: true,
      ambiguousPackageManager: false,
    },
  });

  const ambiguousRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-recommend-ambiguous-'),
  );
  writeFileSync(join(ambiguousRoot, 'package-lock.json'), '{}');
  writeFileSync(join(ambiguousRoot, 'yarn.lock'), '# lockfile');
  assert.deepEqual(recommendHelperRuntimeProfile(ambiguousRoot), {
    profile: 'vendored-node',
    packageManager: '',
    reason:
      'Multiple supported package-manager signals were detected; do not guess an install path. Prefer vendored-node before ephemeral-npx when helper support is still desired.',
    evidence: {
      hasPackageJson: false,
      declaredPackageManager: '',
      lockfileMatches: [
        { filename: 'package-lock.json', manager: 'npm' },
        { filename: 'yarn.lock', manager: 'yarn' },
      ],
      detectedPackageManager: '',
      packageJsonOnly: false,
      ambiguousPackageManager: true,
    },
  });

  const emptyRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-recommend-empty-'),
  );
  assert.deepEqual(recommendHelperRuntimeProfile(emptyRoot), {
    profile: 'instructions-only',
    packageManager: '',
    reason:
      'No supported package-manager evidence was detected. Keep instructions-only unless separate repository evidence confirms a real Node.js helper path; if helper support is still desired then, prefer vendored-node before ephemeral-npx.',
    evidence: {
      hasPackageJson: false,
      declaredPackageManager: '',
      lockfileMatches: [],
      detectedPackageManager: '',
      packageJsonOnly: false,
      ambiguousPackageManager: false,
    },
  });
});

test('source package metadata falls back when vendored into another repository', () => {
  const foreignRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-foreign-root-'),
  );
  writeFileSync(
    join(foreignRoot, 'package.json'),
    JSON.stringify({ name: 'target-app' }),
  );
  assert.deepEqual(resolveSourcePackageMetadata(foreignRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.23.4 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });

  const missingRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-missing-root-'),
  );
  assert.deepEqual(resolveSourcePackageMetadata(missingRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.23.4 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });
});

test('source package metadata accepts repository objects with url', () => {
  const sourceRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-source-root-'),
  );
  writeFileSync(
    join(sourceRoot, 'package.json'),
    JSON.stringify({
      name: '@kurone-kito/idd-skill',
      repository: {
        type: 'git',
        url: 'https://github.com/kurone-kito/idd-skill.git',
      },
      engines: {
        node: '^22.23.4 || ^24.2.0 || >=26.0.0',
      },
      version: '9.9.9-test',
    }),
  );

  assert.deepEqual(resolveSourcePackageMetadata(sourceRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'https://github.com/kurone-kito/idd-skill.git',
    nodeEngines: '^22.23.4 || ^24.2.0 || >=26.0.0',
    version: '9.9.9-test',
  });
});

// idd-skill#1947 review finding: a non-string version (malformed
// package.json) must fall back to the sentinel rather than stringify to a
// misleading value like "[object Object]".
test('source package metadata falls back on a non-string version field', () => {
  const nonStringVersionRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-non-string-version-'),
  );
  writeFileSync(
    join(nonStringVersionRoot, 'package.json'),
    JSON.stringify({
      name: '@kurone-kito/idd-skill',
      version: { not: 'a string' },
    }),
  );
  assert.deepEqual(resolveSourcePackageMetadata(nonStringVersionRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.23.4 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });

  const emptyStringVersionRoot = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-empty-version-'),
  );
  writeFileSync(
    join(emptyStringVersionRoot, 'package.json'),
    JSON.stringify({ name: '@kurone-kito/idd-skill', version: '' }),
  );
  assert.equal(
    resolveSourcePackageMetadata(emptyStringVersionRoot).version,
    'unknown',
  );
});

// idd-skill#1923: the manifest previously let HELPER_COMMANDS's fixed
// command list be misread as describing whatever --package-spec target
// was passed, when it always described only this executing build. The
// running-build version is read dynamically from this repo's own
// package.json (never a hardcoded literal) so a release-version bump
// can't break this suite.
const REPO_PACKAGE_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).version;

test('runningBuild discloses the running build version and command-list scope for every profile', () => {
  for (const profile of [
    'package-manager',
    'vendored-node',
    'ephemeral-npx',
    'instructions-only',
  ]) {
    const manifest = buildHelperRuntimeManifest({
      profile,
      packageManager: profile === 'package-manager' ? 'pnpm' : '',
      targetRoot: REPO_ROOT,
    });
    assert.deepEqual(
      manifest.runningBuild,
      { version: REPO_PACKAGE_VERSION, commandListScope: 'running-build' },
      `profile ${profile}`,
    );
  }
});

test('a supplied --package-spec never changes the reported command list', () => {
  const withDefaultSpec = buildHelperRuntimeManifest({
    profile: 'ephemeral-npx',
    targetRoot: REPO_ROOT,
  });
  const withCustomSpec = buildHelperRuntimeManifest({
    profile: 'ephemeral-npx',
    packageSpec: 'https://example.test/custom-tarball.tgz',
    targetRoot: REPO_ROOT,
  });

  // The command catalog and running-build disclosure are identical --
  // only composed install/invocation strings (which embed packageSpec)
  // differ between the two manifests.
  assert.deepEqual(
    withDefaultSpec.commandCatalog,
    withCustomSpec.commandCatalog,
  );
  assert.deepEqual(withDefaultSpec.runningBuild, withCustomSpec.runningBuild);
  assert.notEqual(withDefaultSpec.packageSpec, withCustomSpec.packageSpec);
  assert.notDeepEqual(
    withDefaultSpec.profiles['ephemeral-npx'].commands,
    withCustomSpec.profiles['ephemeral-npx'].commands,
  );
});

test('empty targetRoot falls back to the current working directory', () => {
  const emptyTarget = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: '',
  });
  const defaultTarget = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
  });

  assert.deepEqual(emptyTarget, defaultTarget);
});

test('switching away from vendored-node enumerates removal paths', () => {
  const manifest = buildHelperRuntimeManifest({
    profile: 'instructions-only',
    fromProfile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });

  assert.ok((manifest.switching?.removeFiles.length ?? 0) > 0);
  assert.deepEqual(manifest.switching?.removePackageJsonScripts, []);
});

test('helper bundle manifest bin wrapper produces JSON output', () => {
  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'bin/idd-helper-bundle-manifest.mjs'),
      '--profile',
      'instructions-only',
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);

  assert.equal(parsed.packageSpec, DEFAULT_PACKAGE_SPEC);
  assert.ok(parsed.profiles['instructions-only']);

  const launcher = readFileSync(
    join(REPO_ROOT, 'bin/idd-helper-bundle-manifest.mjs'),
    'utf8',
  );
  assert.ok(launcher.startsWith('#!/usr/bin/env node'));
});

test('helper bundle manifest publishes the forced handoff helper command', () => {
  const packageManagerManifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  });
  const vendoredManifest = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });

  assert.equal(
    packageManagerManifest.profiles['package-manager'].commands[
      'idd:forced-handoff-marker'
    ],
    'idd-forced-handoff-marker',
  );
  assert.equal(
    vendoredManifest.profiles['vendored-node'].commands[
      'idd:forced-handoff-marker'
    ],
    'node scripts/forced-handoff-marker.mjs',
  );
  assert.equal(
    existsSync(join(REPO_ROOT, 'bin/idd-forced-handoff-marker.mjs')),
    true,
  );
});

test('helper bundle manifest publishes the discover roadmap graph helper command', () => {
  const packageManagerManifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  });
  const vendoredManifest = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });

  assert.equal(
    packageManagerManifest.profiles['package-manager'].commands[
      'idd:discover-roadmap-graph'
    ],
    'idd-discover-roadmap-graph',
  );
  assert.equal(
    vendoredManifest.profiles['vendored-node'].commands[
      'idd:discover-roadmap-graph'
    ],
    'node scripts/discover-roadmap-graph.mjs',
  );
  assert.equal(
    existsSync(join(REPO_ROOT, 'bin/idd-discover-roadmap-graph.mjs')),
    true,
  );
});

test('helper bundle manifest publishes the external-check waiver helper command', () => {
  const packageManagerManifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  });
  const vendoredManifest = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });

  assert.equal(
    packageManagerManifest.profiles['package-manager'].commands[
      'idd:external-check-waiver'
    ],
    'idd-external-check-waiver',
  );
  assert.equal(
    vendoredManifest.profiles['vendored-node'].commands[
      'idd:external-check-waiver'
    ],
    'node scripts/external-check-waiver.mjs',
  );
  assert.equal(
    existsSync(join(REPO_ROOT, 'bin/idd-external-check-waiver.mjs')),
    true,
  );
});

test('helper bundle manifest publishes the phase ID resolver helper command', () => {
  const packageManagerManifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  });
  const vendoredManifest = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    targetRoot: REPO_ROOT,
  });

  assert.equal(
    packageManagerManifest.profiles['package-manager'].commands[
      'idd:phase-id-resolver'
    ],
    'idd-phase-id-resolver',
  );
  assert.equal(
    vendoredManifest.profiles['vendored-node'].commands[
      'idd:phase-id-resolver'
    ],
    'node scripts/phase-id-resolver.mjs',
  );
  assert.equal(
    existsSync(join(REPO_ROOT, 'bin/idd-phase-id-resolver.mjs')),
    true,
  );
});

test('manifest accepts an explicit package spec override', () => {
  const packageSpec =
    'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/0123456789abcdef0123456789abcdef01234567';
  const manifest = buildHelperRuntimeManifest({
    profile: 'ephemeral-npx',
    packageSpec,
  });

  assert.equal(manifest.packageSpec, packageSpec);
  assert.equal(
    manifest.profiles['ephemeral-npx'].commands['idd:helper-bundle-manifest'],
    `npx --yes --package ${packageSpec} idd-helper-bundle-manifest`,
  );
});

test('manifest CLI rejects flags that are missing required values', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/helper-runtime-manifest.mjs'), '--profile'],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    /missing value for argument: --profile/,
  );
});

test('resolveHelperCommandForProfile resolves the audit-pr-cleanup invocation for every profile (idd-skill#1718)', () => {
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'vendored-node',
    }),
    'node scripts/audit-pr-cleanup.mjs',
  );
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'package-manager',
    }),
    'idd-audit-pr-cleanup',
  );
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'ephemeral-npx',
    }),
    `npx --yes --package ${DEFAULT_PACKAGE_SPEC} idd-audit-pr-cleanup`,
  );
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'instructions-only',
    }),
    null,
  );
});

test('resolveHelperCommandForProfile honors an explicit --package-spec pin under ephemeral-npx', () => {
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'ephemeral-npx',
      packageSpec: 'https://example.com/pinned-idd-skill.tgz',
    }),
    'npx --yes --package https://example.com/pinned-idd-skill.tgz idd-audit-pr-cleanup',
  );
});

test('resolveHelperCommandForProfile returns null for an unknown helper id or profile', () => {
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'not-a-real-helper',
      profile: 'vendored-node',
    }),
    null,
  );
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'audit-pr-cleanup',
      profile: 'not-a-real-profile',
    }),
    null,
  );
});

test('buildHelperRuntimeManifest falls back to a configured helperRuntime.packageSpec when no --package-spec is passed (idd-skill#1731)', () => {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-manifest-configured-spec-'),
  );
  mkdirSync(join(dir, '.github/idd'), { recursive: true });
  writeFileSync(
    join(dir, '.github/idd/config.json'),
    JSON.stringify({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://example.com/pinned-idd-skill.tgz',
      },
    }),
  );

  const manifest = buildHelperRuntimeManifest({ targetRoot: dir });
  assert.equal(
    manifest.packageSpec,
    'https://example.com/pinned-idd-skill.tgz',
  );
  assert.equal(
    manifest.profiles['ephemeral-npx'].commands['idd:audit-pr-cleanup'],
    'npx --yes --package https://example.com/pinned-idd-skill.tgz idd-audit-pr-cleanup',
  );
});

test('buildHelperRuntimeManifest lets an explicit --package-spec win over a configured one', () => {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-manifest-explicit-wins-'),
  );
  mkdirSync(join(dir, '.github/idd'), { recursive: true });
  writeFileSync(
    join(dir, '.github/idd/config.json'),
    JSON.stringify({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://example.com/pinned-idd-skill.tgz',
      },
    }),
  );

  const manifest = buildHelperRuntimeManifest({
    targetRoot: dir,
    packageSpec: 'https://example.com/cli-flag-wins.tgz',
  });
  assert.equal(manifest.packageSpec, 'https://example.com/cli-flag-wins.tgz');
});

test('buildHelperRuntimeManifest falls back to the default package spec when no config or flag pins one', () => {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-manifest-no-pin-'),
  );
  const manifest = buildHelperRuntimeManifest({ targetRoot: dir });
  assert.equal(manifest.packageSpec, DEFAULT_PACKAGE_SPEC);
});

test('buildHelperRuntimeManifest also reads a configured packageSpec from the legacy idd-policy.json path', () => {
  const dir = makeTempDir(
    join(tmpdir(), 'idd-helper-runtime-manifest-legacy-spec-'),
  );
  writeFileSync(
    join(dir, 'idd-policy.json'),
    JSON.stringify({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://mirror.example/idd-skill.tgz',
      },
    }),
  );
  const manifest = buildHelperRuntimeManifest({ targetRoot: dir });
  assert.equal(manifest.packageSpec, 'https://mirror.example/idd-skill.tgz');
});

// The user-global tests assert command strings only. None of them runs a real
// global install, which would change the machine running the suite.
const USER_GLOBAL_SPEC = 'https://mirror.example/idd-skill-user-global.tgz';

function makeTargetRoot(prefix: string, files: Record<string, string>) {
  const root = makeTempDir(join(tmpdir(), prefix));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test('user-global profile emits operator-level install and uninstall commands for npm and pnpm', () => {
  const cases = [
    {
      packageManager: 'npm',
      install: `npm install -g ${USER_GLOBAL_SPEC}`,
      uninstall: 'npm uninstall -g @kurone-kito/idd-skill',
    },
    {
      packageManager: 'pnpm',
      install: `pnpm add -g ${USER_GLOBAL_SPEC}`,
      uninstall: 'pnpm remove -g @kurone-kito/idd-skill',
    },
  ];
  for (const { packageManager, install, uninstall } of cases) {
    const entry = buildHelperRuntimeManifest({
      profile: 'user-global',
      packageManager,
      packageSpec: USER_GLOBAL_SPEC,
      targetRoot: REPO_ROOT,
    }).profiles['user-global'];

    assert.equal(entry.installCommand, install);
    assert.equal(entry.uninstallCommand, uninstall);
    assert.equal(entry.installUnavailableReason, undefined);
    assert.deepEqual(entry.managedFiles, []);
    assert.deepEqual(entry.managedDependencies.devDependencies, {});
  }
});

test('user-global profile installs through Yarn Classic and reports Yarn Berry as unsupported', (t) => {
  const classicRoot = makeTargetRoot('idd-user-global-yarn-classic-', {
    'package.json': JSON.stringify({ packageManager: 'yarn@1.22.22' }),
  });
  const berryPinRoot = makeTargetRoot('idd-user-global-yarn-berry-pin-', {
    'package.json': JSON.stringify({ packageManager: 'yarn@4.5.0' }),
  });
  const berryConfigRoot = makeTargetRoot('idd-user-global-yarn-berry-rc-', {
    'package.json': JSON.stringify({}),
    '.yarnrc.yml': 'nodeLinker: node-modules\n',
  });
  for (const root of [classicRoot, berryPinRoot, berryConfigRoot]) {
    t.after(() => rmSync(root, { recursive: true, force: true }));
  }

  const classic = buildHelperRuntimeManifest({
    profile: 'user-global',
    packageManager: 'yarn',
    packageSpec: USER_GLOBAL_SPEC,
    targetRoot: classicRoot,
  }).profiles['user-global'];
  assert.equal(classic.installCommand, `yarn global add ${USER_GLOBAL_SPEC}`);
  assert.equal(
    classic.uninstallCommand,
    'yarn global remove @kurone-kito/idd-skill',
  );
  assert.equal(classic.installUnavailableReason, undefined);

  for (const root of [berryPinRoot, berryConfigRoot]) {
    const berry = buildHelperRuntimeManifest({
      profile: 'user-global',
      packageManager: 'yarn',
      packageSpec: USER_GLOBAL_SPEC,
      targetRoot: root,
    }).profiles['user-global'];
    assert.equal(berry.installCommand, '');
    assert.equal(berry.uninstallCommand, '');
    assert.match(berry.installUnavailableReason ?? '', /Yarn Berry/u);
  }
});

test('user-global profile withholds the Yarn command when package.json cannot be read', (t) => {
  const brokenRoot = makeTargetRoot('idd-user-global-yarn-broken-', {
    'package.json': '{ not json',
  });
  t.after(() => rmSync(brokenRoot, { recursive: true, force: true }));

  const entry = buildHelperRuntimeManifest({
    profile: 'user-global',
    packageManager: 'yarn',
    packageSpec: USER_GLOBAL_SPEC,
    targetRoot: brokenRoot,
  }).profiles['user-global'];
  assert.equal(entry.installCommand, '');
  assert.match(entry.installUnavailableReason ?? '', /not valid JSON/u);
});

test('user-global profile explains a missing package manager instead of guessing one', (t) => {
  const emptyRoot = makeTargetRoot('idd-user-global-none-', {});
  t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));

  const entry = buildHelperRuntimeManifest({
    profile: 'user-global',
    targetRoot: emptyRoot,
  }).profiles['user-global'];
  assert.equal(entry.installCommand, '');
  assert.match(entry.installUnavailableReason ?? '', /--package-manager/u);
});

test('user-global commands are bare bin names resolved from PATH', () => {
  const entry = buildHelperRuntimeManifest({
    profile: 'user-global',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).profiles['user-global'];

  const values = Object.values(entry.commands);
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.match(value, /^idd-[a-z0-9-]+$/u);
  }
  assert.equal(
    resolveHelperCommandForProfile({
      helperId: 'advisory-convergence',
      profile: 'user-global',
    }),
    'idd-advisory-convergence',
  );
});

test('switching to and from user-global lists the add, remove, and global-uninstall steps', () => {
  const leaveForVendored = buildHelperRuntimeManifest({
    profile: 'vendored-node',
    fromProfile: 'user-global',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).switching;
  // The operator's install manager is not knowable from the repository, so
  // every global uninstall is listed.
  assert.deepEqual(leaveForVendored?.removeGlobalInstallCommands, [
    'npm uninstall -g @kurone-kito/idd-skill',
    'pnpm remove -g @kurone-kito/idd-skill',
    'yarn global remove @kurone-kito/idd-skill',
  ]);
  assert.deepEqual(leaveForVendored?.removeFiles, []);
  assert.ok((leaveForVendored?.addFiles.length ?? 0) > 0);

  const enterFromVendored = buildHelperRuntimeManifest({
    profile: 'user-global',
    fromProfile: 'vendored-node',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).switching;
  assert.equal(
    'removeGlobalInstallCommands' in (enterFromVendored ?? {}),
    false,
  );
  assert.deepEqual(enterFromVendored?.addFiles, []);
  assert.ok((enterFromVendored?.removeFiles.length ?? 0) > 0);

  const packageManagerToUserGlobal = buildHelperRuntimeManifest({
    profile: 'user-global',
    fromProfile: 'package-manager',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).switching;
  assert.deepEqual(packageManagerToUserGlobal?.removeDevDependencies, [
    '@kurone-kito/idd-skill',
  ]);
  assert.deepEqual(packageManagerToUserGlobal?.addDevDependencies, {});

  const userGlobalToPackageManager = buildHelperRuntimeManifest({
    profile: 'package-manager',
    fromProfile: 'user-global',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).switching;
  assert.deepEqual(userGlobalToPackageManager?.removeGlobalInstallCommands, [
    'npm uninstall -g @kurone-kito/idd-skill',
    'pnpm remove -g @kurone-kito/idd-skill',
    'yarn global remove @kurone-kito/idd-skill',
  ]);
  assert.deepEqual(
    Object.keys(userGlobalToPackageManager?.addDevDependencies ?? {}),
    ['@kurone-kito/idd-skill'],
  );
});

test('a user-global to user-global switch removes nothing and lists no uninstall commands', () => {
  const noOp = buildHelperRuntimeManifest({
    profile: 'user-global',
    fromProfile: 'user-global',
    packageManager: 'pnpm',
    targetRoot: REPO_ROOT,
  }).switching;
  assert.equal('removeGlobalInstallCommands' in (noOp ?? {}), false);
  assert.deepEqual(noOp?.removeFiles, []);
  assert.deepEqual(noOp?.addFiles, []);
});

// #3830: the ephemeral-npx launcher, the pnpm probe and the --launcher flag.
function targetRootWithLauncher(launcher: string | undefined): string {
  const dir = makeTempDir(join(tmpdir(), 'idd-launcher-target-'));
  if (launcher !== undefined) {
    mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'idd', 'config.json'),
      JSON.stringify({
        helperRuntime: { profile: 'ephemeral-npx', launcher },
      }),
    );
  }
  return dir;
}

test('resolveLauncher keeps npx unless auto meets the pnpm floor (idd-skill#3830)', () => {
  assert.deepEqual(resolveLauncher(undefined, 12), {
    configured: null,
    resolved: 'npx',
    reason: 'no launcher is configured; npx is the default',
  });
  assert.equal(resolveLauncher('npx', 12).resolved, 'npx');
  assert.equal(resolveLauncher('pnpm-dlx', null).resolved, 'pnpm-dlx');
  // The expectations follow the exported floor, so moving it moves them too.
  const expected = (major: number | null) =>
    major !== null && major >= PNPM_DLX_MIN_MAJOR ? 'pnpm-dlx' : 'npx';
  for (const major of [null, 9, PNPM_DLX_MIN_MAJOR, 12]) {
    const result = resolveLauncher('auto', major);
    assert.equal(
      result.resolved,
      expected(major),
      `auto with pnpm ${String(major)}`,
    );
    assert.ok(result.reason.length > 0);
  }
});

test('detectPnpmMajor reads the leading major and returns null on every failure without throwing (idd-skill#3830)', () => {
  const seen: Array<{ cwd: string; timeoutMs: number }> = [];
  assert.equal(
    detectPnpmMajor({
      cwd: '/target',
      timeoutMs: 1234,
      probe: (cwd, timeoutMs) => {
        seen.push({ cwd, timeoutMs });
        return '12.4.1\n';
      },
    }),
    12,
  );
  assert.deepEqual(seen, [{ cwd: '/target', timeoutMs: 1234 }]);
  assert.equal(detectPnpmMajor({ cwd: '/target', probe: () => '12' }), 12);
  let defaultTimeout = 0;
  detectPnpmMajor({
    cwd: '/target',
    probe: (_cwd, timeoutMs) => {
      defaultTimeout = timeoutMs;
      return '10.0.0';
    },
  });
  assert.equal(defaultTimeout, 5000, 'the probe timeout defaults to 5000 ms');
  assert.equal(
    detectPnpmMajor({
      cwd: '/target',
      probe: () => {
        throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' });
      },
    }),
    null,
  );
  assert.equal(
    detectPnpmMajor({
      cwd: '/target',
      probe: () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      },
    }),
    null,
  );
  assert.equal(
    detectPnpmMajor({ cwd: '/target', probe: () => 'garbage' }),
    null,
  );
  assert.equal(detectPnpmMajor({ cwd: '/target', probe: () => '' }), null);
});

test('ephemeral-npx emits npx by default and pnpm dlx only when the launcher resolves to it (idd-skill#3830)', () => {
  const packageSpec = 'git+https://example.com/idd-skill.git#abc1234';
  const root = targetRootWithLauncher(undefined);
  try {
    const defaults = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      packageSpec,
      targetRoot: root,
    });
    const entry = defaults.profiles['ephemeral-npx'];
    assert.ok(entry);
    assert.ok(Object.keys(entry.commands).length > 0);
    // Exactly the pre-launcher shape: `npx --yes --package <spec> <bin>`.
    for (const command of Object.values(entry.commands)) {
      const tokens = command.split(' ');
      assert.equal(tokens.length, 5, command);
      assert.deepEqual(
        tokens.slice(0, 4),
        ['npx', '--yes', '--package', packageSpec],
        command,
      );
    }
    assert.equal(entry.launcher?.configured, null);
    assert.equal(entry.launcher?.resolved, 'npx');

    const dlx = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      packageSpec,
      targetRoot: root,
      launcher: 'pnpm-dlx',
    });
    const dlxEntry = dlx.profiles['ephemeral-npx'];
    assert.ok(dlxEntry);
    for (const command of Object.values(dlxEntry.commands)) {
      const tokens = command.split(' ');
      assert.equal(tokens.length, 5, command);
      assert.deepEqual(
        tokens.slice(0, 4),
        ['pnpm', 'dlx', '--package', packageSpec],
        command,
      );
    }
    assert.equal(dlxEntry.launcher?.resolved, 'pnpm-dlx');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildHelperRuntimeManifest probes pnpm only when auto would change the emitted output (idd-skill#3830)', () => {
  const root = targetRootWithLauncher('auto');
  let probes = 0;
  const probe = () => {
    probes += 1;
    return '10.0.0';
  };
  try {
    buildHelperRuntimeManifest({
      profile: 'package-manager',
      packageManager: 'pnpm',
      targetRoot: root,
      probe,
    });
    assert.equal(
      probes,
      0,
      'package-manager output does not depend on the launcher',
    );

    const manifest = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      targetRoot: root,
      probe,
    });
    assert.equal(probes, 1);
    assert.equal(
      manifest.profiles['ephemeral-npx']?.launcher?.resolved,
      'pnpm-dlx',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the --launcher flag overrides the configured value and an invalid flag exits non-zero (idd-skill#3830)', () => {
  const root = targetRootWithLauncher('npx');
  try {
    const overridden = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      targetRoot: root,
      launcher: 'pnpm-dlx',
    });
    assert.equal(
      overridden.profiles['ephemeral-npx']?.launcher?.resolved,
      'pnpm-dlx',
    );

    const invalid = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/helper-runtime-manifest.mjs'),
        '--launcher',
        'pnpm',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /unsupported launcher: pnpm/);
    assert.throws(
      () => buildHelperRuntimeManifest({ targetRoot: root, launcher: 'bogus' }),
      /unsupported launcher: bogus/,
    );
    // An explicit empty value is invalid, not an absent flag.
    const explicitEmpty = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/helper-runtime-manifest.mjs'), '--launcher='],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(explicitEmpty.status, 0);
    assert.match(explicitEmpty.stderr, /unsupported launcher: /);
    assert.throws(
      () => buildHelperRuntimeManifest({ targetRoot: root, launcher: '' }),
      /unsupported launcher: /,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auto probes pnpm in the target root and falls back to npx when the probe throws (idd-skill#3830)', () => {
  const root = targetRootWithLauncher(undefined);
  try {
    const seen: Array<{ cwd: string; timeoutMs: number }> = [];
    const probed = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      targetRoot: root,
      launcher: 'auto',
      probe: (cwd, timeoutMs) => {
        seen.push({ cwd, timeoutMs });
        return '10.0.0';
      },
    });
    assert.deepEqual(seen, [{ cwd: root, timeoutMs: 5000 }]);
    assert.equal(
      probed.profiles['ephemeral-npx']?.launcher?.resolved,
      'pnpm-dlx',
    );

    const failed = buildHelperRuntimeManifest({
      profile: 'ephemeral-npx',
      targetRoot: root,
      launcher: 'auto',
      probe: () => {
        throw Object.assign(new Error('spawn pnpm ENOENT'), {
          code: 'ENOENT',
        });
      },
    });
    const entry = failed.profiles['ephemeral-npx'];
    assert.equal(entry?.launcher?.resolved, 'npx');
    for (const command of Object.values(entry?.commands ?? {})) {
      assert.match(command, /^npx --yes --package /);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pnpm dlx commands mirror the npx commands for the default and an explicit spec (idd-skill#3830)', () => {
  const root = targetRootWithLauncher(undefined);
  try {
    for (const packageSpec of [
      '',
      'git+https://example.com/idd-skill.git#abc1234',
    ]) {
      const npx = buildHelperRuntimeManifest({
        profile: 'ephemeral-npx',
        packageSpec,
        targetRoot: root,
      }).profiles['ephemeral-npx'];
      const dlx = buildHelperRuntimeManifest({
        profile: 'ephemeral-npx',
        packageSpec,
        targetRoot: root,
        launcher: 'pnpm-dlx',
      }).profiles['ephemeral-npx'];
      assert.ok(npx && dlx);
      assert.deepEqual(Object.keys(dlx.commands), Object.keys(npx.commands));
      for (const [name, command] of Object.entries(npx.commands)) {
        assert.equal(
          dlx.commands[name],
          command.replace('npx --yes --package ', 'pnpm dlx --package '),
          name,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launcher values leave the other profile entries unchanged and add the launcher object to ephemeral-npx only (idd-skill#3830)', () => {
  const root = targetRootWithLauncher(undefined);
  try {
    const build = (launcher?: string) =>
      buildHelperRuntimeManifest({
        packageManager: 'pnpm',
        targetRoot: root,
        launcher,
      }).profiles;
    const unset = build();
    const npx = build('npx');
    const dlx = build('pnpm-dlx');
    for (const profile of Object.keys(unset)) {
      if (profile === 'ephemeral-npx') {
        continue;
      }
      const entry = unset[profile];
      assert.ok(entry);
      assert.equal('launcher' in entry, false, `${profile} has no launcher`);
      assert.deepEqual(npx[profile], entry, profile);
      assert.deepEqual(dlx[profile], entry, profile);
    }
    const ephemeral = unset['ephemeral-npx'];
    assert.ok(ephemeral && 'launcher' in ephemeral);
    const npxEntry = npx['ephemeral-npx'];
    assert.deepEqual(
      {
        commands: npxEntry?.commands,
        description: npxEntry?.description,
        notes: npxEntry?.notes,
      },
      {
        commands: ephemeral.commands,
        description: ephemeral.description,
        notes: ephemeral.notes,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
