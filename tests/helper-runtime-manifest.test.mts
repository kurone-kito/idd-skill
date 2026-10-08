import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildHelperRuntimeManifest,
  collectHelperRuntimeEvidence,
  collectVendoredFiles,
  detectPackageManager,
  recommendHelperRuntimeProfile,
  resolveHelperCommandForProfile,
  resolveSourcePackageMetadata,
} from '../src/scripts/helper-runtime-manifest.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PACKAGE_SPEC =
  'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/refs/heads/main';

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
  const packageJsonRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-package-json-'),
  );
  writeFileSync(
    join(packageJsonRoot, 'package.json'),
    JSON.stringify({ packageManager: 'npm@10.9.0' }),
  );
  assert.equal(detectPackageManager(packageJsonRoot), 'npm');

  const lockfileRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-lockfile-'),
  );
  writeFileSync(join(lockfileRoot, 'yarn.lock'), '# lockfile');
  assert.equal(detectPackageManager(lockfileRoot), 'yarn');

  const ambiguousRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-ambiguous-lockfile-'),
  );
  writeFileSync(join(ambiguousRoot, 'package-lock.json'), '{}');
  writeFileSync(join(ambiguousRoot, 'yarn.lock'), '# lockfile');
  assert.equal(detectPackageManager(ambiguousRoot), '');
});

test('helper runtime evidence and recommendation stay fail-closed around package-manager detection', () => {
  const packageJsonRoot = mkdtempSync(
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

  const lockfileRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-recommend-lockfile-'),
  );
  writeFileSync(join(lockfileRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'");
  assert.deepEqual(recommendHelperRuntimeProfile(lockfileRoot), {
    profile: 'package-manager',
    packageManager: 'pnpm',
    reason: 'Detected exactly one supported package-manager lockfile.',
    evidence: {
      hasPackageJson: false,
      declaredPackageManager: '',
      lockfileMatches: [{ filename: 'pnpm-lock.yaml', manager: 'pnpm' }],
      detectedPackageManager: 'pnpm',
      packageJsonOnly: false,
      ambiguousPackageManager: false,
    },
  });

  const packageJsonOnlyRoot = mkdtempSync(
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

  const ambiguousRoot = mkdtempSync(
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

  const emptyRoot = mkdtempSync(
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
  const foreignRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-foreign-root-'),
  );
  writeFileSync(
    join(foreignRoot, 'package.json'),
    JSON.stringify({ name: 'target-app' }),
  );
  assert.deepEqual(resolveSourcePackageMetadata(foreignRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.23.2 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });

  const missingRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-missing-root-'),
  );
  assert.deepEqual(resolveSourcePackageMetadata(missingRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.23.2 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });
});

test('source package metadata accepts repository objects with url', () => {
  const sourceRoot = mkdtempSync(
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
        node: '^22.23.2 || ^24.2.0 || >=26.0.0',
      },
      version: '9.9.9-test',
    }),
  );

  assert.deepEqual(resolveSourcePackageMetadata(sourceRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'https://github.com/kurone-kito/idd-skill.git',
    nodeEngines: '^22.23.2 || ^24.2.0 || >=26.0.0',
    version: '9.9.9-test',
  });
});

// idd-skill#1947 review finding: a non-string version (malformed
// package.json) must fall back to the sentinel rather than stringify to a
// misleading value like "[object Object]".
test('source package metadata falls back on a non-string version field', () => {
  const nonStringVersionRoot = mkdtempSync(
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
    nodeEngines: '^22.23.2 || ^24.2.0 || >=26.0.0',
    version: 'unknown',
  });

  const emptyStringVersionRoot = mkdtempSync(
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
  const dir = mkdtempSync(
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
  const dir = mkdtempSync(
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
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-manifest-no-pin-'),
  );
  const manifest = buildHelperRuntimeManifest({ targetRoot: dir });
  assert.equal(manifest.packageSpec, DEFAULT_PACKAGE_SPEC);
});

test('buildHelperRuntimeManifest also reads a configured packageSpec from the legacy idd-policy.json path', () => {
  const dir = mkdtempSync(
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
  const root = mkdtempSync(join(tmpdir(), prefix));
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
