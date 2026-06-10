import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildHelperRuntimeManifest } from '../scripts/helper-runtime-manifest.mjs';
import { runDoctor } from '../scripts/idd-doctor.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_ROOT = new URL(
  './fixtures/helper-runtime-config/',
  import.meta.url,
);
const REQUIRED_INSTRUCTION_FILES = [
  '.github/instructions/idd-overview-core.instructions.md',
  '.github/instructions/idd-discover.instructions.md',
  '.github/instructions/idd-suitability.instructions.md',
  '.github/instructions/idd-claim.instructions.md',
  '.github/instructions/idd-work.instructions.md',
  '.github/instructions/idd-pr-submit.instructions.md',
  '.github/instructions/idd-ci.instructions.md',
  '.github/instructions/idd-review-snapshot.instructions.md',
  '.github/instructions/idd-review-triage.instructions.md',
  '.github/instructions/idd-review-fix.instructions.md',
  '.github/instructions/idd-pre-merge.instructions.md',
  '.github/instructions/idd-merge-handoff.instructions.md',
  '.github/instructions/idd-merge.instructions.md',
  '.github/instructions/idd-resume.instructions.md',
  '.github/instructions/idd-resume-stall.instructions.md',
  '.github/instructions/idd-advisory-wait.instructions.md',
];
const REQUIRED_DOC_FILES = [
  'docs/getting-started.md',
  'docs/concepts.md',
  'docs/customization.md',
  'docs/reference.md',
  'docs/idd-workflow.md',
  'docs/idd-review-policy-profiles.md',
  'docs/idd-helper-scripts.md',
  'docs/idd-comment-minimization.md',
  'docs/permissions.md',
  'docs/policy-constants.md',
];
const PROFILE_FIXTURE_FILES = [
  'profiles/README.md',
  'profiles/human-required/README.md',
  'profiles/no-advisory/README.md',
  'profiles/external-bot/README.md',
];
const DEFAULT_MARKER_PREFIX = 'helper-runtime-fixture';

test('idd-doctor accepts missing helperRuntime as instructions-only fallback fixture', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.deepEqual(report.errors, []);
  assert.ok(
    report.passes.includes(
      '.github/idd/config.json leaves helperRuntime unset (instructions-only fallback)',
    ),
  );
});

test('instructions-only fixture emits no helper commands or dependencies', (t) => {
  const root = createDoctorFixtureRepo('instructions-only.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildHelperRuntimeManifest({
    profile: 'instructions-only',
    targetRoot: root,
  });
  const profile = manifest.profiles['instructions-only'];

  assert.deepEqual(profile.managedDependencies, {
    devDependencies: {},
  });
  assert.deepEqual(profile.managedPackageJsonScripts, {});
  assert.deepEqual(profile.commands, {});
  assert.deepEqual(profile.managedFiles, []);
});

test('package-manager fixture can run idd-doctor through the helper bin', (t) => {
  const root = createDoctorFixtureRepo('package-manager.json', {
    packageJson: {
      name: 'fixture-package-manager',
      packageManager: 'npm@10.9.0',
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = buildHelperRuntimeManifest({
    profile: 'package-manager',
    targetRoot: root,
  });
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'bin/idd-doctor.mjs'), '--json', '--repo-root', root],
      { encoding: 'utf8' },
    ),
  );

  assert.equal(manifest.packageManager, 'npm');
  assert.ok(
    manifest.profiles['package-manager'].commands['idd:doctor'],
    'package-manager profile should emit a doctor command',
  );
  assert.deepEqual(report.errors, []);
  assert.ok(
    report.passes.includes(
      '.github/idd/config.json declares helper runtime profile "package-manager"',
    ),
  );
});

test('idd-doctor fixture rejects unsupported helperRuntime profiles', (t) => {
  const root = createDoctorFixtureRepo('invalid-profile.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.ok(
    report.errors.includes(
      '.github/idd/config.json: unsupported helperRuntime.profile "bun"',
    ),
  );
});

test('idd-doctor fixture rejects unsupported helperRuntime keys', (t) => {
  const root = createDoctorFixtureRepo('invalid-extra-key.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.ok(
    report.errors.includes(
      '.github/idd/config.json: unsupported helperRuntime keys: manager',
    ),
  );
});

test('idd-doctor warns when adopter marker prefix keeps source-repo lint toolchain commands', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      commands: {
        'fix-validate': 'npx dprint check "**/*.md"',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
    {
      markerPrefix: 'example-team',
    },
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.equal(report.errors.length, 0);
  assert.ok(
    report.warnings.some((warning) =>
      warning.includes(
        'toolchain residue detected for marker prefix "example-team"',
      ),
    ),
  );
});

test('idd-doctor still checks overview residue when policy config is missing', (t) => {
  const root = createDoctorFixtureRepoFromConfig(null, {
    markerPrefix: 'example-team',
    overviewCommands: {
      'fix-validate': 'npx dprint check "**/*.md"',
      'pre-push-validate': 'npm run lint',
      'post-fix-validate': 'npm run test',
      'install-deps': 'true',
    },
    writeConfig: false,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.equal(report.errors.length, 0);
  assert.ok(
    report.warnings.some((warning) =>
      warning.includes(
        'toolchain residue detected for marker prefix "example-team"',
      ),
    ),
  );
});

test('idd-doctor skips residue warnings for idd-skill marker prefix', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      commands: {
        'fix-validate': 'npx dprint check "**/*.md"',
        'pre-push-validate': 'npx markdownlint-cli2 "**/*.md"',
        'post-fix-validate': 'npx cspell lint "**" --no-progress',
        'install-deps': 'true',
      },
    },
    {
      markerPrefix: 'idd-skill',
    },
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.equal(report.errors.length, 0);
  assert.ok(
    report.warnings.every(
      (warning) => !warning.startsWith('toolchain residue detected'),
    ),
  );
});

test('idd-doctor does not warn when config and overview concrete commands agree', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      commands: {
        'fix-validate': 'npm run fix',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
    {
      markerPrefix: 'example-team',
      overviewCommands: {
        'fix-validate': 'npm run fix',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.equal(report.errors.length, 0);
  assert.ok(
    report.warnings.every(
      (warning) =>
        !warning.startsWith(
          'command mismatch between .github/idd/config.json and overview table',
        ),
    ),
  );
});

test('idd-doctor warns when config and overview concrete commands differ', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      commands: {
        'fix-validate': 'npm run fix && npm test',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
    {
      markerPrefix: 'example-team',
      overviewCommands: {
        'fix-validate': 'npm run fix',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.equal(report.errors.length, 0);
  assert.ok(
    report.warnings.some((warning) =>
      warning.includes(
        'command mismatch between .github/idd/config.json and overview table for "fix-validate"',
      ),
    ),
  );
});

test('helper script docs keep the discover viability gate helper in sync', () => {
  const live = readFileSync(
    new URL('../docs/idd-helper-scripts.md', import.meta.url),
    'utf8',
  );
  const template = readFileSync(
    new URL('../idd-template/docs/idd-helper-scripts.md', import.meta.url),
    'utf8',
  );

  assert.equal(template, live);
  assert.match(live, /discover-roadmap-graph\.mjs/);
  assert.match(live, /Discover Roadmap Graph Contract/);
  assert.match(live, /discover-viability-gate\.mjs/);
  assert.match(live, /suitability-triage\.mjs/);
});

function createDoctorFixtureRepo(
  configFixtureName,
  { packageJson = null } = {},
) {
  const configText = readFileSync(
    new URL(configFixtureName, FIXTURE_ROOT),
    'utf8',
  );
  return createDoctorFixtureRepoFromConfig(configText, { packageJson });
}

function createDoctorFixtureRepoFromConfig(
  config,
  {
    packageJson = null,
    markerPrefix = DEFAULT_MARKER_PREFIX,
    overviewCommands = {},
    writeConfig = true,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'idd-helper-runtime-profile-'));
  const configText =
    typeof config === 'string'
      ? config
      : config === null
        ? ''
        : `${JSON.stringify(config, null, 2)}\n`;
  const overviewText = buildOverviewText(markerPrefix, overviewCommands);
  const discoverText = buildDiscoverText(markerPrefix);

  for (const file of REQUIRED_INSTRUCTION_FILES) {
    const contents = file.endsWith('idd-overview-core.instructions.md')
      ? overviewText
      : file.endsWith('idd-discover.instructions.md')
        ? discoverText
        : `# ${file}\n`;
    writeFixtureFile(root, file, contents);
  }
  for (const file of REQUIRED_DOC_FILES) {
    writeFixtureFile(root, file, `# ${file}\n`);
  }
  for (const file of PROFILE_FIXTURE_FILES) {
    writeFixtureFile(root, file, `# ${file}\n`);
  }

  writeFixtureFile(
    root,
    '.github/copilot-instructions.md',
    'This fixture uses fully_autonomous_merge and copilot advisory.\n',
  );
  if (writeConfig) {
    writeFixtureFile(root, '.github/idd/config.json', configText);
  }
  writeFixtureFile(root, 'AGENTS.md', 'See docs/idd-workflow.md.\n');
  writeFixtureFile(root, 'CLAUDE.md', 'See docs/idd-workflow.md.\n');
  writeFixtureFile(root, 'GEMINI.md', 'See docs/idd-workflow.md.\n');
  if (packageJson) {
    writeFixtureFile(
      root,
      'package.json',
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  }

  return root;
}

function buildOverviewText(markerPrefix, commands) {
  const rows = {
    'fix-validate': 'node --test tests/*.mjs',
    'pre-push-validate': 'node --test tests/*.mjs',
    'post-fix-validate': 'node --test tests/*.mjs',
    'install-deps': 'true',
    'issue-scope': 'roadmap',
    'orphan-first-policy': 'none',
    ...commands,
  };
  return `# IDD overview

<!-- ${markerPrefix}-roadmap-id: value -->
<!-- ${markerPrefix}-blocked-by: value -->

| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`${rows['fix-validate']}\` |
| **pre-push-validate** | \`${rows['pre-push-validate']}\` |
| **post-fix-validate** | \`${rows['post-fix-validate']}\` |
| **install-deps** | \`${rows['install-deps']}\` |
| **issue-scope** | \`${rows['issue-scope']}\` |
| **orphan-first-policy** | \`${rows['orphan-first-policy']}\` |
`;
}

function buildDiscoverText(markerPrefix) {
  return `# IDD discover

<!-- ${markerPrefix}-roadmap-id: value -->
<!-- ${markerPrefix}-blocked-by: value -->
`;
}

function writeFixtureFile(root, relativePath, contents) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}
