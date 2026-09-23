import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

test("every manifest helper binName is exposed in package.json's bin map", () => {
  // Guard against a registered helper whose executable is never published for
  // package-manager-profile installs (the gap #1053 review caught for
  // idd-post-idd-marker): the manifest, package.json bin map, and bin shim file
  // must agree for every helper.
  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const bin = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    .bin as Record<string, string>;
  for (const command of commandCatalog) {
    assert.equal(
      bin[command.binName],
      `./bin/${command.binName}.mjs`,
      `package.json bin map must expose ${command.binName} as ./bin/${command.binName}.mjs`,
    );
  }
});

// idd-skill#3239: the guard above is one-way -- it only checks that
// every cataloged binName has a package.json bin entry, never the
// reverse. At fa49fb6c three bin keys had no HELPER_COMMANDS entry:
// idd-advisory-comment-debounce (the bug this issue fixes),
// idd-onboard, and idd-merged-pr-feedback-sweep. The latter two are
// genuinely maintainer/CI-only tools that must stay unregistered (see
// SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts and "the registration guard
// scopes out instruction-referenced libraries and dev tooling" above),
// so this guard allowlists exactly those two, each with its own
// one-line justification, rather than excluding the whole check.
//
// Both helpers below take `bin` and `allowlist` as plain data (never
// reading package.json internally), so the acceptance criteria's
// synthetic-map cases can be direct unit tests instead of fixture
// files.

/** Sorted `bin` keys that are neither a registered binName nor allowlisted. */
function findUnregisteredBinNames(
  bin: Record<string, string>,
  registeredBinNames: Set<string>,
  allowlist: Record<string, string>,
): string[] {
  return Object.keys(bin)
    .filter((name) => !registeredBinNames.has(name) && !(name in allowlist))
    .sort();
}

/** Sorted allowlist keys that are no longer present in `bin` (a stale entry). */
function findMissingAllowlistedBinNames(
  bin: Record<string, string>,
  allowlist: Record<string, string>,
): string[] {
  return Object.keys(allowlist)
    .filter((name) => !(name in bin))
    .sort();
}

const BIN_ALLOWLIST: Record<string, string> = {
  'idd-onboard':
    'Runs from a clone of this repository against a target via --source; already listed in SOURCE_REPO_INTERNAL_ENTRY_PATHS in tests/helper-invocation-profile.test.mts for that reason.',
  'idd-merged-pr-feedback-sweep':
    'Already pinned as the unregistered maintainer-only post-merge sweep by "the registration guard scopes out instruction-referenced libraries and dev tooling" in this same test file.',
};

test('findUnregisteredBinNames flags a synthetic bin key with no catalog entry and no allowlist entry', () => {
  const bin = {
    'idd-audit-pr-cleanup': './bin/idd-audit-pr-cleanup.mjs',
    'idd-not-a-real-helper': './bin/idd-not-a-real-helper.mjs',
  };
  const registeredBinNames = new Set(['idd-audit-pr-cleanup']);
  assert.deepEqual(findUnregisteredBinNames(bin, registeredBinNames, {}), [
    'idd-not-a-real-helper',
  ]);
});

test('findMissingAllowlistedBinNames flags an allowlisted name no longer present in bin', () => {
  const bin = {
    'idd-merged-pr-feedback-sweep': './bin/idd-merged-pr-feedback-sweep.mjs',
  };
  assert.deepEqual(findMissingAllowlistedBinNames(bin, BIN_ALLOWLIST), [
    'idd-onboard',
  ]);
});

test('every package.json bin key is a cataloged binName or an explicitly justified allowlist entry', () => {
  // The reverse of "every manifest helper binName is exposed in
  // package.json's bin map" above: every bin key must trace back to
  // either a HELPER_COMMANDS entry or a justified allowlist entry, so a
  // helper like advisory-comment-debounce (bin key present, catalog
  // entry missing) cannot silently ship unregistered again. The
  // allowlist itself is checked for staleness in the same assertion:
  // an allowlisted name that stops being a bin key must also fail, so
  // the allowlist cannot drift from reality unnoticed.
  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const registeredBinNames = new Set(
    commandCatalog.map((command) => command.binName),
  );
  const bin = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    .bin as Record<string, string>;

  assert.deepEqual(
    findUnregisteredBinNames(bin, registeredBinNames, BIN_ALLOWLIST),
    [],
    'package.json bin keys with no HELPER_COMMANDS entry and no allowlist justification',
  );
  assert.deepEqual(
    findMissingAllowlistedBinNames(bin, BIN_ALLOWLIST),
    [],
    'BIN_ALLOWLIST names that are no longer package.json bin keys -- remove the stale entry',
  );
});

const INSTRUCTIONS_DIR = join(REPO_ROOT, '.github/instructions');

function readInstructionFiles(): { name: string; source: string }[] {
  return readdirSync(INSTRUCTIONS_DIR)
    .filter((name) => name.endsWith('.instructions.md'))
    .map((name) => ({
      name,
      source: readFileSync(join(INSTRUCTIONS_DIR, name), 'utf8'),
    }));
}

// Dev tools the instructions legitimately `node`-invoke with CONCRETE text
// that only ever appears in this repo's own dogfood
// `.github/instructions/` copies, never in what an idd-template adopter
// receives -- so they cannot be "documented CLI adopter helpers" and must
// be excluded explicitly:
//   - scripts/sync-docs.mjs: the generated-from banner tells maintainers to
//     run `node scripts/sync-docs.mjs --apply`. Adopters receive the
//     banner-free idd-template/ source, so they never see this invocation.
//   - scripts/verify-install-deps.mjs: the concreted Project commands
//     table's install-deps row invokes it directly (see
//     .github/idd/config.json / idd-overview-core.instructions.md).
//     idd-template's own row stays the generic `{{INSTALL_DEPS_COMMAND}}`
//     placeholder, so an idd-template adopter never sees this concrete
//     invocation either unless they deliberately choose to replicate it.
//   - scripts/audit-docs.mjs: the concreted Project commands table's
//     pre-push-validate and post-fix-validate rows invoke it directly
//     (see .github/idd/config.json / idd-overview-core.instructions.md)
//     to catch this repo's own mirror-copy drift against
//     audit/sync-manifest.json. idd-template's own rows stay the generic
//     `{{PRE_PUSH_VALIDATE_COMMANDS}}` / `{{POST_FIX_VALIDATE_COMMANDS}}`
//     placeholders, so an idd-template adopter never sees this concrete
//     invocation, and the check is scoped to this repo's own
//     idd-template/ pairing, not a tool an adopter repo could run as-is
//     (idd-skill#1726).
//   - scripts/audit-code-span-wrap.mjs: the concreted Project commands
//     table's pre-push-validate and post-fix-validate rows invoke it
//     directly (see .github/idd/config.json /
//     idd-overview-core.instructions.md) to flag mid-token line breaks
//     inside inline code spans. This is a repository-local authoring
//     guardrail (idd-skill#1677) with no lint configuration distributed
//     to idd-template/ at all, so idd-template's own rows stay the
//     generic `{{PRE_PUSH_VALIDATE_COMMANDS}}` /
//     `{{POST_FIX_VALIDATE_COMMANDS}}` placeholders and an idd-template
//     adopter never sees this concrete invocation.
// Every other dev tool (build-ts, verify-workshop-integrity, …) is excluded by
// ABSENCE — it is never `node`-invoked in the instructions — so it is NOT added
// here on purpose: adding it would let a future accidental `node scripts/X.mjs`
// mention slip past the guard silently. Only add a tool to this set when it is
// genuinely `node`-invoked in the dogfood instructions AND provably invisible
// to idd-template adopters, as justified above.
// token-cost-event.mjs (#2293) is also dogfood-only, but it is named only
// in the four root guideline files (CLAUDE.md / AGENTS.md / GEMINI.md /
// .github/copilot-instructions.md), never inside `.github/instructions/`
// -- so `readInstructionFiles()` below never scans it in and this set
// needs no entry for it. Kept out on purpose, mirroring the
// SOURCE_REPO_INTERNAL_ENTRY_PATHS comment in
// tests/helper-invocation-profile.test.mts, whose broader scan does
// register it (currently inert there for the identical reason) so a
// future guideline-file edit that duplicates the invocation into a
// scanned path finds the exemption already recorded in the set that
// would actually need it.
const DOGFOOD_ONLY_CONCRETE_TOOLS = new Set([
  'scripts/sync-docs.mjs',
  'scripts/verify-install-deps.mjs',
  'scripts/audit-docs.mjs',
  'scripts/audit-code-span-wrap.mjs',
  // token-cost-report.mjs (#2619): this repository's own dogfood
  // measurement reporter, now wired into the pre-push-validate row of
  // `.github/instructions/idd-overview-core.instructions.md` itself
  // (source: `audit/sync-manifest.json`'s `idd-overview-core-instructions`
  // syncPair, never `idd-template`'s `{{PRE_PUSH_VALIDATE_COMMANDS}}`
  // placeholder). Mirrors the identical exemption #2294 already added to
  // `tests/helper-invocation-profile.test.mts`.
  'scripts/token-cost-report.mjs',
]);

// Collect every helper the instruction files tell adopters to RUN as
// `node scripts/<name>.mjs`. That runnable-invocation form is the scoped signal
// for a "documented CLI adopter helper": it deliberately excludes shared
// libraries that appear only as bare `scripts/<name>.mjs` import/function
// mentions (protocol-helpers, policy-helpers) and the single banner-invoked dev
// tool above.
function collectDocumentedCliAdopterHelpers(): Set<string> {
  const referenced = new Set<string>();
  for (const { source } of readInstructionFiles()) {
    // Tolerate any inter-token whitespace (tabs, runs of spaces, a wrapped
    // line) between `node` and the script path so a harmless reformat of an
    // instruction snippet cannot silently shrink the guard's domain.
    for (const match of source.matchAll(
      /\bnode\s+(scripts\/[a-z0-9-]+\.mjs)\b/g,
    )) {
      if (!DOGFOOD_ONLY_CONCRETE_TOOLS.has(match[1])) {
        referenced.add(match[1]);
      }
    }
  }
  return referenced;
}

test('every documented CLI adopter helper (node scripts/<name>.mjs in instructions) is registered', () => {
  // A documented CLI adopter helper that is neither registered in HELPER_COMMANDS
  // nor imported by a registered helper is silently absent from vendored-node
  // `managedFiles`, so an adopter copying that list never receives it and the
  // documented `node scripts/<name>.mjs` invocation fails. Guards the
  // kurone-kito/idd-skill#1084 gap where minimize-superseded-markers was a real
  // invocable, instruction-documented CLI yet unregistered (it imports only node
  // builtins, so nothing pulled it into the import closure either).
  const referenced = collectDocumentedCliAdopterHelpers();

  // Sanity: the scan still finds the documented-helper surface, so this guard
  // cannot silently pass if the instruction invocation form is restructured.
  assert.ok(
    referenced.size > 0,
    'expected the instruction files to document at least one `node scripts/<name>.mjs` adopter helper',
  );
  // Anchor on the #1084 subject helper so the guard stays bound to the regression
  // it closes; idd-claim / idd-review-snapshot / idd-advisory-wait document it.
  assert.ok(
    referenced.has('scripts/minimize-superseded-markers.mjs'),
    'expected the instruction files to document `node scripts/minimize-superseded-markers.mjs`',
  );

  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const registeredEntryPaths = new Set(
    commandCatalog.map((command) => command.entryPath),
  );
  const unregistered = [...referenced]
    .filter((entryPath) => !registeredEntryPaths.has(entryPath))
    .sort();

  assert.deepEqual(
    unregistered,
    [],
    `documented CLI adopter helpers missing from HELPER_COMMANDS: ${unregistered.join(', ')}`,
  );
});

test('the registration guard scopes out instruction-referenced libraries and dev tooling', () => {
  // Pins why the guard above does not false-positive: shared libraries are
  // referenced in the instructions as bare `scripts/<name>.mjs` paths (import /
  // function sources) but are never `node`-invoked, so they stay out of the
  // documented-CLI domain and out of HELPER_COMMANDS — they reach vendored
  // `managedFiles` transitively through the registered helpers that import them.
  const allInstructions = readInstructionFiles()
    .map((file) => file.source)
    .join('\n');
  const documentedCliHelpers = collectDocumentedCliAdopterHelpers();
  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const registeredEntryPaths = new Set(
    commandCatalog.map((command) => command.entryPath),
  );

  for (const library of [
    'scripts/protocol-helpers.mjs',
    'scripts/policy-helpers.mjs',
  ]) {
    assert.ok(
      allInstructions.includes(library),
      `expected the instruction files to reference the ${library} library`,
    );
    // The shared scan uses the same whitespace-tolerant `node\s+scripts/...`
    // regex, so this also proves the library is never written as a runnable
    // node command (only as a bare import/function-source path).
    assert.equal(
      documentedCliHelpers.has(library),
      false,
      `${library} must not be treated as a documented CLI adopter helper`,
    );
    assert.equal(
      registeredEntryPaths.has(library),
      false,
      `${library} is a library and must not be registered in HELPER_COMMANDS`,
    );
  }

  // Dev/CI tooling and the maintainer-only post-merge sweep are likewise never
  // adopter-run commands, so they stay unregistered too. build-ts /
  // verify-workshop-integrity / merged-pr-feedback-sweep are excluded by
  // absence (never `node`-invoked in the instructions); sync-docs,
  // verify-install-deps, audit-docs, and audit-code-span-wrap are
  // `node`-invoked in the dogfood instructions (banner / concreted
  // install-deps row / concreted pre-push-validate+post-fix-validate rows,
  // respectively) but excluded via DOGFOOD_ONLY_CONCRETE_TOOLS, so the
  // guard still scopes all four out.
  for (const nonAdopterTool of [
    'scripts/build-ts.mjs',
    'scripts/sync-docs.mjs',
    'scripts/verify-workshop-integrity.mjs',
    'scripts/verify-install-deps.mjs',
    'scripts/merged-pr-feedback-sweep.mjs',
    'scripts/audit-docs.mjs',
    'scripts/audit-code-span-wrap.mjs',
  ]) {
    assert.equal(
      documentedCliHelpers.has(nonAdopterTool),
      false,
      `${nonAdopterTool} is not an adopter CLI helper and must not be in the documented domain`,
    );
    assert.equal(
      registeredEntryPaths.has(nonAdopterTool),
      false,
      `${nonAdopterTool} is not an adopter CLI helper and must not be registered in HELPER_COMMANDS`,
    );
  }
});

// idd-skill#3239: the guard above scans `.github/instructions/**` only,
// which never caught advisory-comment-debounce -- the template's own
// comment-refresh workflow invokes it directly, with no matching
// instruction-file mention. This guard scans the distributed
// `idd-template/.github/workflows/*.yml` files instead, for every
// invocation form a real workflow step uses: `node scripts/<name>.mjs`,
// and the four package-runner forms `pnpm exec idd-<name>`, `yarn
// [--silent] idd-<name>` (the optional `--silent` flag is a real form at
// idd-advisory-convergence.yml's Yarn-1-detection branch),
// `npm exec idd-<name>`, and `npx --yes --package <spec> idd-<name>`.
// Deliberately keyed on these invocation forms only, not a bare `idd-`
// token scan, which would also match job ids, config file names, and
// marker names (e.g. the `idd-advisory-convergence` check-run context
// literal, or the `ALLOWLIST=( "scripts/rerun-advisory-convergence.mjs"
// ... )` bash array in idd-advisory-convergence.yml, a bare path with no
// `node` prefix).

const TEMPLATE_WORKFLOWS_DIR = join(
  REPO_ROOT,
  'idd-template/.github/workflows',
);

function readTemplateWorkflowFiles(): { name: string; source: string }[] {
  return readdirSync(TEMPLATE_WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({
      name,
      source: readFileSync(join(TEMPLATE_WORKFLOWS_DIR, name), 'utf8'),
    }));
}

interface TemplateWorkflowViolation {
  file: string;
  form: 'node' | 'package-runner';
  name: string;
  message: string;
}

interface TemplateWorkflowScan {
  violations: TemplateWorkflowViolation[];
  nodeEntryPaths: string[];
  packageRunnerBinNames: string[];
}

const TEMPLATE_WORKFLOW_NODE_PATTERN = /\bnode\s+(scripts\/[a-z0-9-]+\.mjs)\b/g;
const TEMPLATE_WORKFLOW_PACKAGE_RUNNER_PATTERNS = [
  /\bpnpm\s+exec\s+(idd-[a-z0-9-]+)\b/g,
  /\byarn\s+(?:--silent\s+)?(idd-[a-z0-9-]+)\b/g,
  /\bnpm\s+exec\s+(idd-[a-z0-9-]+)\b/g,
  /\bnpx\s+--yes\s+--package\s+\S+\s+(idd-[a-z0-9-]+)\b/g,
];

/**
 * Strip any line whose trimmed text starts with `#` -- drops YAML
 * comments and shell `# ...` lines inside `run:` blocks, including
 * module-header prose that mentions a helper name or flag without a
 * real invocation (e.g. this file's own header paragraphs quoting
 * `rerun-advisory-convergence.mjs --apply` in prose).
 */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Pure function over (workflow texts, command catalog): scans every
 * workflow's non-comment text for the node and package-runner
 * invocation forms above, and flags any invocation whose target is not
 * a cataloged `entryPath`/`binName`. Also returns the full found-sets
 * (not just violations), so a caller can assert sanity anchors -- a
 * restructured `run:` block that accidentally stops matching anything
 * would otherwise let this guard pass vacuously with an empty
 * violation list.
 */
function scanTemplateWorkflowRegistrations(
  workflowFiles: { name: string; source: string }[],
  commandCatalog: { entryPath: string; binName: string }[],
): TemplateWorkflowScan {
  const registeredEntryPaths = new Set(
    commandCatalog.map((command) => command.entryPath),
  );
  const registeredBinNames = new Set(
    commandCatalog.map((command) => command.binName),
  );
  const violations: TemplateWorkflowViolation[] = [];
  const nodeEntryPaths = new Set<string>();
  const packageRunnerBinNames = new Set<string>();

  for (const { name, source } of workflowFiles) {
    const scannable = stripCommentLines(source);

    for (const match of scannable.matchAll(TEMPLATE_WORKFLOW_NODE_PATTERN)) {
      const entryPath = match[1];
      nodeEntryPaths.add(entryPath);
      if (!registeredEntryPaths.has(entryPath)) {
        violations.push({
          file: name,
          form: 'node',
          name: entryPath,
          message: `${name} invokes \`node ${entryPath}\`, which is not a cataloged HELPER_COMMANDS entryPath`,
        });
      }
    }

    for (const pattern of TEMPLATE_WORKFLOW_PACKAGE_RUNNER_PATTERNS) {
      for (const match of scannable.matchAll(pattern)) {
        const binName = match[1];
        packageRunnerBinNames.add(binName);
        if (!registeredBinNames.has(binName)) {
          violations.push({
            file: name,
            form: 'package-runner',
            name: binName,
            message: `${name} invokes ${binName} via a package-runner form, which is not a cataloged HELPER_COMMANDS binName`,
          });
        }
      }
    }
  }

  return {
    violations,
    nodeEntryPaths: [...nodeEntryPaths].sort(),
    packageRunnerBinNames: [...packageRunnerBinNames].sort(),
  };
}

test('every helper invocation in idd-template workflow files is registered', () => {
  const workflowFiles = readTemplateWorkflowFiles();
  // Vacuity guard: a moved/renamed workflow directory must not make this
  // test silently pass with nothing scanned.
  assert.ok(
    workflowFiles.length >= 3,
    'expected at least 3 idd-template/.github/workflows/*.yml files',
  );

  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const scan = scanTemplateWorkflowRegistrations(workflowFiles, commandCatalog);

  // Sanity anchors (idd-skill#3239): the scan must find both of these
  // known-registered helpers in BOTH the node form and a package-runner
  // form, so a restructured `run:` block that stops matching anything
  // cannot make the guard above pass vacuously.
  assert.ok(
    scan.nodeEntryPaths.includes('scripts/rerun-advisory-convergence.mjs'),
  );
  assert.ok(scan.nodeEntryPaths.includes('scripts/audit-pr-cleanup.mjs'));
  assert.ok(
    scan.packageRunnerBinNames.includes('idd-rerun-advisory-convergence'),
  );
  assert.ok(scan.packageRunnerBinNames.includes('idd-audit-pr-cleanup'));

  assert.deepEqual(scan.violations, []);
});

test('the template-workflow guard flags advisory-comment-debounce when the catalog lacks its entry', () => {
  // Regression reproduction for idd-skill#3239: with
  // advisory-comment-debounce removed from the catalog, the real
  // idd-advisory-convergence-comment.yml invocations (its `node` form
  // under vendored-node, and its `pnpm exec`/`yarn`/`npm exec`/`npx`
  // forms under package-manager/ephemeral-npx) must be flagged, naming
  // both identifiers.
  const workflowFiles = readTemplateWorkflowFiles();
  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const catalogWithoutDebounce = commandCatalog.filter(
    (command) => command.id !== 'advisory-comment-debounce',
  );
  const scan = scanTemplateWorkflowRegistrations(
    workflowFiles,
    catalogWithoutDebounce,
  );

  assert.ok(
    scan.violations.some(
      (violation) =>
        violation.form === 'node' &&
        violation.name === 'scripts/advisory-comment-debounce.mjs',
    ),
    'expected a node-form violation naming scripts/advisory-comment-debounce.mjs',
  );
  assert.ok(
    scan.violations.some(
      (violation) =>
        violation.form === 'package-runner' &&
        violation.name === 'idd-advisory-comment-debounce',
    ),
    'expected a package-runner-form violation naming idd-advisory-comment-debounce',
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
