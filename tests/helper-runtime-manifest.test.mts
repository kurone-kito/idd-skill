import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  resolveSourcePackageMetadata,
} from '../src/scripts/helper-runtime-manifest.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PACKAGE_SPEC =
  'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/refs/heads/main';

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
    nodeEngines: '^22.22.2 || >=24',
  });

  const missingRoot = mkdtempSync(
    join(tmpdir(), 'idd-helper-runtime-missing-root-'),
  );
  assert.deepEqual(resolveSourcePackageMetadata(missingRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'github:kurone-kito/idd-skill',
    nodeEngines: '^22.22.2 || >=24',
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
        node: '^22.22.2 || >=24',
      },
    }),
  );

  assert.deepEqual(resolveSourcePackageMetadata(sourceRoot), {
    name: '@kurone-kito/idd-skill',
    repository: 'https://github.com/kurone-kito/idd-skill.git',
    nodeEngines: '^22.22.2 || >=24',
  });
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
