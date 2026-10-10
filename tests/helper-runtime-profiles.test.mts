import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildHelperRuntimeManifest,
  listHelperBinNames,
} from '../src/scripts/helper-runtime-manifest.mts';
import {
  DOCUMENTED_TOOLCHAIN_SEGMENTS,
  inspectUserGlobalHelperBins,
  runDoctor,
} from '../src/scripts/idd-doctor.mts';

import { type FixtureGhRule, useFixtureGh } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_ROOT = new URL(
  './fixtures/helper-runtime-config/',
  import.meta.url,
);
const REQUIRED_INSTRUCTION_FILES = [
  '.github/instructions/idd-overview-core.instructions.md',
  '.github/instructions/idd-discover.instructions.md',
  '.github/instructions/idd-suitability.instructions.md',
  '.github/instructions/idd-orchestrator.instructions.md',
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
// The eight fields policy.schema.json's top-level `required` array
// demands. Inline test configs below only set the fields their own
// scenario cares about (commands, helperRuntime, ...); this base keeps
// every inline fixture schema-valid so checkLiveConfigSchema (#1359) does
// not add an unrelated finding to tests exercising other doctor checks.
const REQUIRED_CONFIG_BASE = {
  iddVersion: '0.1.0',
  markerPrefix: DEFAULT_MARKER_PREFIX,
  mergePolicy: 'fully_autonomous_merge',
  reviewPolicy: 'copilot-advisory',
  threadResolutionPolicy: 'fast-agent-resolve',
  claimTiming: {
    staleAge: 'PT24H',
    heartbeatInterval: 'PT12H',
  },
  trustedMarkerActors: ['fixture-actor'],
};

const DOCTOR_REPO = { owner: 'fixture-owner', name: 'fixture-repo' };
const REPO_SLUG = `${DOCTOR_REPO.owner}/${DOCTOR_REPO.name}`;
const REPO_API = `repos/${REPO_SLUG}`;

// Network isolation (#3745): `runDoctor` has no `gh` seam and `requireGithub`
// only changes how a failed read is classified, so every doctor run here used to
// make real GitHub reads (plus the child `bin/idd-doctor.mjs` run). The fixture
// `gh` answers every read a successful run makes. Load-control pinning
// is a separate concern and is not needed here: the doctor shells out directly.
const DOCTOR_REPO_VIEW = {
  args: ['repo', 'view', '--json', 'owner,name'],
  stdout: JSON.stringify({
    owner: { login: DOCTOR_REPO.owner },
    name: DOCTOR_REPO.name,
  }),
};
const DOCTOR_RESPONSES: FixtureGhRule[] = [
  DOCTOR_REPO_VIEW,
  {
    args: ['repo', 'view', '--json', 'owner,name,defaultBranchRef,url'],
    stdout: JSON.stringify({
      owner: { login: DOCTOR_REPO.owner },
      name: DOCTOR_REPO.name,
      defaultBranchRef: { name: 'main' },
      url: `https://github.com/${REPO_SLUG}`,
    }),
  },
  {
    args: [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number,labels,body',
      '--limit',
      '1000',
    ],
    stdout: '[]',
  },
  // The merged-PR list carries a timestamp that changes on every call, so it is
  // matched as a prefix that ends at `--search`.
  {
    args: ['pr', 'list', '--repo', REPO_SLUG, '--state', 'merged', '--search'],
    match: 'prefix',
    stdout: '[]',
  },
  // The governance reads `checkGithubReadiness` makes once the repo read
  // succeeds: no Rulesets, and a classic protection with one required check and
  // a required review.
  {
    args: [
      'api',
      `${REPO_API}/rules/branches/main`,
      '--paginate',
      '--jq',
      '.[]',
    ],
    stdout: '',
  },
  {
    args: ['api', `${REPO_API}/branches/main/protection`],
    stdout: JSON.stringify({
      required_status_checks: { strict: true, contexts: ['lint'] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    }),
  },
];
const fixtureGh = useFixtureGh({ responses: DOCTOR_RESPONSES });

/** Run `body` with `rules` consulted before the default doctor answers. */
function withDoctorRules<T>(rules: FixtureGhRule[], body: () => T): T {
  fixtureGh.setResponses([...rules, ...DOCTOR_RESPONSES]);
  try {
    return body();
  } finally {
    fixtureGh.setResponses(DOCTOR_RESPONSES);
  }
}

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
      ...REQUIRED_CONFIG_BASE,
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

  // config.json is required (idd-doctor reports its absence as an error);
  // the residue check still runs and must report its warning as before.
  assert.ok(
    report.errors.every((error) =>
      error.includes('.github/idd/config.json is missing'),
    ),
    `unexpected errors: ${report.errors.join(' | ')}`,
  );
  assert.ok(
    report.errors.some((error) =>
      error.includes('.github/idd/config.json is missing'),
    ),
  );
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
      ...REQUIRED_CONFIG_BASE,
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

test('idd-doctor does not warn when commands match the documented worked-example chain', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate':
          'npx dprint fmt "**/*.md" && npx markdownlint-cli2 --fix "**/*.md" && npx markdownlint-cli2 "**/*.md"',
        'pre-push-validate':
          'npx dprint check "**/*.md" && npx markdownlint-cli2 "**/*.md" && npx cspell lint "**" --no-progress',
        'post-fix-validate':
          'npx dprint fmt "**/*.md" && npx markdownlint-cli2 --fix "**/*.md" && npx markdownlint-cli2 "**/*.md" && npx cspell lint "**" --no-progress',
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
    report.warnings.every(
      (warning) => !warning.startsWith('toolchain residue detected'),
    ),
  );
});

test('idd-doctor does not warn on a fix-validate that documents the markdownlint-only subset', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate':
          'npx markdownlint-cli2 --fix "**/*.md" && npx markdownlint-cli2 "**/*.md"',
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
    report.warnings.every(
      (warning) => !warning.startsWith('toolchain residue detected'),
    ),
  );
});

test('idd-doctor does not warn on a fix-validate that documents the cspell-only subset', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate': 'npx cspell lint "**" --no-progress',
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
    report.warnings.every(
      (warning) => !warning.startsWith('toolchain residue detected'),
    ),
  );
});

test('idd-doctor still warns when a documented segment appears under the wrong command key', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate': 'npm run lint',
        'pre-push-validate': 'npx dprint fmt "**/*.md"',
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

test('idd-doctor documented toolchain segments cover the config commands', () => {
  // The customization table holds references, not command text, so the
  // guard now reads the source of truth: each config segment that uses a
  // toolchain token must be a documented segment for its key.
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, '.github/idd/config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  for (const key of Object.keys(DOCUMENTED_TOOLCHAIN_SEGMENTS)) {
    const documented = DOCUMENTED_TOOLCHAIN_SEGMENTS[key] ?? [];
    const segments = (config.commands[key] ?? '')
      .split('&&')
      .map((segment) => segment.trim());
    for (const segment of segments) {
      if (!/\b(?:dprint|markdownlint-cli2|cspell)\b/i.test(segment)) {
        continue;
      }
      assert.ok(
        documented.includes(segment),
        `config.json commands.${key} segment "${segment}" is missing from idd-doctor's DOCUMENTED_TOOLCHAIN_SEGMENTS`,
      );
    }
  }
});

test('customization.md command rows reference config entries, not command text', () => {
  const customizationDoc = readFileSync(
    join(REPO_ROOT, 'idd-template/docs/customization.md'),
    'utf8',
  );
  const keys = [
    'fix-validate',
    'pre-push-validate',
    'post-fix-validate',
    'install-deps',
  ];
  for (const key of keys) {
    const rowMatch = customizationDoc
      .split('\n')
      .find((line) => line.includes(`| **${key}**`));
    assert.ok(rowMatch, `expected a customization.md table row for ${key}`);
    assert.match(
      rowMatch ?? '',
      new RegExp(
        `\\| \`commands\\.${key}\` in \`\\.github/idd/config\\.json\`\\s*\\|\\s*$`,
      ),
      `the ${key} row must reference commands.${key} in config.json: ${rowMatch}`,
    );
  }
});

test('idd-doctor does not warn when config and overview concrete commands agree', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
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
      ...REQUIRED_CONFIG_BASE,
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

test('idd-doctor accepts a command row that references its own config key (#3959)', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
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
        'fix-validate': 'commands.fix-validate',
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
        !warning.includes('command mismatch between .github/idd/config.json'),
    ),
  );
});

test('idd-doctor reports a command row that references a different config key (#3959)', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
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
        'fix-validate': 'commands.pre-push-validate',
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

test('idd-doctor reports a config entry that refers to its own key (#3959)', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate': 'commands.fix-validate',
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
        'command entry "fix-validate" in .github/idd/config.json refers to itself',
      ),
    ),
  );
});

test('idd-doctor reports a config entry that refers to another entry (#3959)', (t) => {
  const root = createDoctorFixtureRepoFromConfig(
    {
      ...REQUIRED_CONFIG_BASE,
      commands: {
        'fix-validate': 'commands.pre-push-validate',
        'pre-push-validate': 'npm run lint',
        'post-fix-validate': 'npm run test',
        'install-deps': 'true',
      },
    },
    {
      markerPrefix: 'example-team',
      overviewCommands: {
        'fix-validate': 'commands.fix-validate',
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
        'command entry "fix-validate" in .github/idd/config.json refers to another entry (commands.pre-push-validate)',
      ),
    ),
  );
});

function createDoctorFixtureRepo(
  configFixtureName: string,
  { packageJson = null }: FixtureRepoOptions = {},
) {
  const configText = readFileSync(
    new URL(configFixtureName, FIXTURE_ROOT),
    'utf8',
  );
  return createDoctorFixtureRepoFromConfig(configText, { packageJson });
}

interface FixtureRepoOptions {
  packageJson?: Record<string, unknown> | null;
  markerPrefix?: string;
  overviewCommands?: Record<string, string>;
  writeConfig?: boolean;
}

function createDoctorFixtureRepoFromConfig(
  config: unknown,
  {
    packageJson = null,
    markerPrefix = DEFAULT_MARKER_PREFIX,
    overviewCommands = {},
    writeConfig = true,
  }: FixtureRepoOptions = {},
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

function buildOverviewText(
  markerPrefix: string,
  commands: Record<string, string>,
) {
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

function buildDiscoverText(markerPrefix: string) {
  return `# IDD discover

<!-- ${markerPrefix}-roadmap-id: value -->
<!-- ${markerPrefix}-blocked-by: value -->
`;
}

function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

// --- #3745: the doctor's GitHub reads, answered by the fixture ---------------

test('idd-doctor with served GitHub reads reports the required-check and review-policy passes and no errors', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = runDoctor({ root, requireGithub: false });

  assert.deepEqual(report.errors, []);
  assert.ok(
    report.passes.includes(
      'required status checks configured on main (1, strict=true)',
    ),
    report.passes.join('\n'),
  );
  assert.ok(
    report.passes.includes('required pull request review policy is configured'),
  );
  assert.ok(
    !report.warnings.some((warning) =>
      warning.startsWith('github checks skipped'),
    ),
    report.warnings.join('\n'),
  );
});

test('idd-doctor: a failing repo read is a warning without requireGithub and an error with it', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const failingRepoRead: FixtureGhRule[] = [
    {
      args: ['repo', 'view', '--json', 'owner,name,defaultBranchRef,url'],
      status: 1,
      stderr: 'fixture: repository not reachable\n',
    },
  ];
  const message = 'github checks skipped: gh repo view unavailable';

  const lenient = withDoctorRules(failingRepoRead, () =>
    runDoctor({ root, requireGithub: false }),
  );
  assert.ok(lenient.warnings.includes(message), lenient.warnings.join('\n'));
  assert.ok(!lenient.errors.includes(message));

  const strict = withDoctorRules(failingRepoRead, () =>
    runDoctor({ root, requireGithub: true }),
  );
  assert.ok(strict.errors.includes(message), strict.errors.join('\n'));
});

const MERGED_IDD_PRS = [
  {
    number: 901,
    headRefName: 'issue/901-fixture-a',
    mergedAt: '2999-01-01T00:00:00Z',
  },
  {
    number: 902,
    headRefName: 'issue/902-fixture-b',
    mergedAt: '2999-01-01T00:00:00Z',
  },
  // A non-IDD merge never counts toward the backlog.
  {
    number: 903,
    headRefName: 'dependabot/npm/fixture',
    mergedAt: '2999-01-01T00:00:00Z',
  },
];

/** Rules serving the merged-PR list and each IDD PR's cleanup-evidence rows. */
function backlogRules(
  evidenceRow: string,
  evidenceAnswer: Partial<FixtureGhRule> = {},
): FixtureGhRule[] {
  return [
    {
      args: [
        'pr',
        'list',
        '--repo',
        REPO_SLUG,
        '--state',
        'merged',
        '--search',
      ],
      match: 'prefix',
      stdout: JSON.stringify(MERGED_IDD_PRS),
    },
    ...[901, 902].map(
      (number): FixtureGhRule => ({
        args: [
          'api',
          '--paginate',
          `${REPO_API}/issues/${number}/comments`,
          '--jq',
        ],
        match: 'prefix',
        stdout: evidenceRow,
        ...evidenceAnswer,
      }),
    ),
  ];
}

// The backlog warns only when the count exceeds the threshold (default 2), so
// a threshold of 0 makes any PR without converged cleanup evidence visible.
test('idd-doctor warns about merged IDD-branch PRs that lack cleanup evidence, from fixture merged-PR data', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsBefore = fixtureGh.calls().length;
  const report = withDoctorRules(backlogRules(''), () =>
    runDoctor({ root, requireGithub: false, cleanupBacklogWarnThreshold: 0 }),
  );
  // Evidence is read for each IDD-branch PR and never for the non-IDD one.
  const reads = fixtureGh
    .calls()
    .slice(callsBefore)
    .map((call) => call.join(' '));
  for (const number of [901, 902]) {
    assert.ok(
      reads.some((read) => read.includes(`issues/${number}/comments`)),
      reads.join('\n'),
    );
  }
  assert.ok(
    !reads.some((read) => read.includes('issues/903/comments')),
    reads.join('\n'),
  );
  const backlog = report.warnings.find((warning) =>
    warning.startsWith('post-merge cleanup backlog:'),
  );
  assert.ok(backlog, report.warnings.join('\n'));
  assert.match(backlog, /2 merged PRs/);
  assert.match(backlog, /#901/);
  assert.doesNotMatch(backlog, /#903/);
});

test('idd-doctor reports no cleanup backlog when a trusted applied evidence row is served for each merged IDD PR', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = withDoctorRules(
    backlogRules('5001\tgithub-actions[bot]\tapplied\n'),
    () =>
      runDoctor({ root, requireGithub: false, cleanupBacklogWarnThreshold: 0 }),
  );
  assert.ok(
    !report.warnings.some(
      (warning) =>
        warning.startsWith('post-merge cleanup backlog:') ||
        warning.startsWith('post-merge cleanup evidence query failed'),
    ),
    report.warnings.join('\n'),
  );
  // An untrusted author's row does not suppress the warning.
  const untrusted = withDoctorRules(
    backlogRules('5001\tsomeone-else\tapplied\n'),
    () =>
      runDoctor({ root, requireGithub: false, cleanupBacklogWarnThreshold: 0 }),
  );
  assert.ok(
    untrusted.warnings.some((warning) =>
      warning.startsWith('post-merge cleanup backlog:'),
    ),
  );
});

test('idd-doctor reports a failed cleanup-evidence read as a warning without requireGithub and an error with it', (t) => {
  const root = createDoctorFixtureRepo('absent.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const failingEvidence = backlogRules('', {
    status: 1,
    stderr: 'HTTP 502: Bad Gateway\n',
  });
  const message =
    'post-merge cleanup evidence query failed for 2 merged PR(s) (examples: #901, #902). Backlog count below may be undercounted.';

  const lenient = withDoctorRules(failingEvidence, () =>
    runDoctor({ root, requireGithub: false, cleanupBacklogWarnThreshold: 0 }),
  );
  assert.ok(lenient.warnings.includes(message), lenient.warnings.join('\n'));
  assert.ok(!lenient.errors.includes(message));

  const strict = withDoctorRules(failingEvidence, () =>
    runDoctor({ root, requireGithub: true, cleanupBacklogWarnThreshold: 0 }),
  );
  assert.ok(strict.errors.includes(message), strict.errors.join('\n'));
});

// The user-global bin check takes the PATH string directly, so these tests
// never mutate process.env. The fake install mirrors what `npm install -g`
// produces: a package root with real bin files, and a PATH directory whose
// entries are symlinks into it. The symlink and executable-bit fixtures are
// POSIX-only.
const USER_GLOBAL_TEST_VERSION = '9.9.9';

function createFakeGlobalInstall(
  binNames: readonly string[],
  {
    owner = '@kurone-kito/idd-skill',
    version = USER_GLOBAL_TEST_VERSION,
  }: { owner?: string; version?: string } = {},
) {
  const base = mkdtempSync(join(tmpdir(), 'idd-user-global-install-'));
  const packageRoot = join(base, 'lib', 'node_modules', ...owner.split('/'));
  const binDir = join(packageRoot, 'bin');
  const pathDir = join(base, 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: owner, version }),
  );
  for (const bin of binNames) {
    const target = join(binDir, `${bin}.mjs`);
    writeFileSync(target, '#!/usr/bin/env node\n');
    chmodSync(target, 0o755);
    symlinkSync(target, join(pathDir, bin));
  }
  return { base, pathDir };
}

test('user-global bin inspection resolves bins over PATH and reads the owning package version', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink and executable-bit fixtures are POSIX-only');
    return;
  }
  const { base, pathDir } = createFakeGlobalInstall([
    'idd-advisory-convergence',
  ]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const [entry] = inspectUserGlobalHelperBins({
    pathValue: pathDir,
    binNames: ['idd-advisory-convergence'],
  });
  assert.equal(entry.resolvedPath, join(pathDir, 'idd-advisory-convergence'));
  assert.equal(entry.version, USER_GLOBAL_TEST_VERSION);
});

test('user-global bin inspection withholds the version when another package owns the bin', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink and executable-bit fixtures are POSIX-only');
    return;
  }
  const { base, pathDir } = createFakeGlobalInstall(['idd-doctor'], {
    owner: 'some-other-package',
  });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const [entry] = inspectUserGlobalHelperBins({
    pathValue: pathDir,
    binNames: ['idd-doctor'],
  });
  assert.equal(entry.resolvedPath, join(pathDir, 'idd-doctor'));
  assert.equal(entry.version, null);
});

test('user-global bin inspection reports absent bins and skips empty PATH entries', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'idd-user-global-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const absent = { bin: 'idd-doctor', resolvedPath: null, version: null };

  assert.deepEqual(
    inspectUserGlobalHelperBins({
      pathValue: ['', empty].join(delimiter),
      binNames: ['idd-doctor'],
    }),
    [absent],
  );
  assert.deepEqual(
    inspectUserGlobalHelperBins({ pathValue: '', binNames: ['idd-doctor'] }),
    [absent],
  );
});

test('idd-doctor warns about user-global helper bins missing from the operator PATH', (t) => {
  const root = createDoctorFixtureRepoFromConfig({
    ...REQUIRED_CONFIG_BASE,
    helperRuntime: { profile: 'user-global' },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const empty = mkdtempSync(join(tmpdir(), 'idd-user-global-doctor-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));

  const report = runDoctor({ root, requireGithub: false, pathValue: empty });
  const missing = report.warnings.find(
    (warning) =>
      warning.startsWith('user-global helper runtime: ') &&
      warning.includes('not found on PATH'),
  );
  assert.ok(missing, report.warnings.join('\n'));
  assert.ok(missing.includes(`${listHelperBinNames().length} helper bin(s)`));
});

test('idd-doctor passes the user-global check when every helper bin resolves to one version', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink and executable-bit fixtures are POSIX-only');
    return;
  }
  const binNames = listHelperBinNames();
  const { base, pathDir } = createFakeGlobalInstall(binNames);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = createDoctorFixtureRepoFromConfig({
    ...REQUIRED_CONFIG_BASE,
    helperRuntime: { profile: 'user-global' },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = runDoctor({ root, requireGithub: false, pathValue: pathDir });
  assert.ok(
    report.passes.includes(
      `user-global helper runtime: all ${binNames.length} helper bins resolve on PATH at version ${USER_GLOBAL_TEST_VERSION}`,
    ),
    report.passes.join('\n'),
  );
  assert.ok(
    !report.warnings.some((warning) =>
      warning.startsWith('user-global helper runtime: '),
    ),
    report.warnings.join('\n'),
  );
});

test('idd-doctor leaves the user-global bin check out of other helper runtime profiles', (t) => {
  const root = createDoctorFixtureRepo('package-manager.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = runDoctor({ root, requireGithub: false, pathValue: '' });
  assert.ok(
    !report.warnings.some((warning) =>
      warning.includes('user-global helper runtime'),
    ),
  );
  assert.ok(
    !report.passes.some((pass) => pass.includes('user-global helper runtime')),
  );
});

test('user-global bin inspection reads the owning package through a pnpm shim', (t) => {
  if (process.platform === 'win32') {
    // Windows resolves bins through PATHEXT extensions, and this fixture is a
    // POSIX shell script with no extension.
    t.skip('the shim fixture is a POSIX shell script');
    return;
  }
  // pnpm writes a regular shell shim, not a symlink, and names the real bin on
  // a cmd-shim-target line. Nothing about the shim itself is package metadata.
  const base = mkdtempSync(join(tmpdir(), 'idd-user-global-shim-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const packageRoot = join(
    base,
    'global',
    'node_modules',
    '@kurone-kito',
    'idd-skill',
  );
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@kurone-kito/idd-skill',
      version: USER_GLOBAL_TEST_VERSION,
    }),
  );
  const realBin = join(packageRoot, 'bin', 'idd-doctor.mjs');
  writeFileSync(realBin, '#!/usr/bin/env node\n');
  const pathDir = join(base, 'bin');
  mkdirSync(pathDir, { recursive: true });
  const shim = join(pathDir, 'idd-doctor');
  writeFileSync(
    shim,
    `#!/bin/sh\n# cmd-shim-target=${realBin}\nexec node "${realBin}" "$@"\n`,
  );
  chmodSync(shim, 0o755);

  const [entry] = inspectUserGlobalHelperBins({
    pathValue: pathDir,
    binNames: ['idd-doctor'],
  });
  assert.equal(entry.resolvedPath, shim);
  assert.equal(entry.version, USER_GLOBAL_TEST_VERSION);
});

test('idd-doctor warns instead of passing when user-global helper bins report different versions', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink and executable-bit fixtures are POSIX-only');
    return;
  }
  // Each bin gets its own package root, and the roots carry different versions.
  const base = mkdtempSync(join(tmpdir(), 'idd-user-global-mixed-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const pathDir = join(base, 'bin');
  mkdirSync(pathDir, { recursive: true });
  listHelperBinNames().forEach((bin, index) => {
    const packageRoot = join(
      base,
      `install-${index}`,
      'lib',
      'node_modules',
      '@kurone-kito',
      'idd-skill',
    );
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@kurone-kito/idd-skill',
        version: index === 0 ? '1.0.0' : '2.0.0',
      }),
    );
    const target = join(packageRoot, 'bin', `${bin}.mjs`);
    writeFileSync(target, '#!/usr/bin/env node\n');
    chmodSync(target, 0o755);
    symlinkSync(target, join(pathDir, bin));
  });
  const root = createDoctorFixtureRepoFromConfig({
    ...REQUIRED_CONFIG_BASE,
    helperRuntime: { profile: 'user-global' },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = runDoctor({ root, requireGithub: false, pathValue: pathDir });
  assert.ok(
    report.warnings.some((warning) =>
      warning.includes('helper bins report different versions (1.0.0, 2.0.0)'),
    ),
    report.warnings.join('\n'),
  );
  assert.ok(
    !report.passes.some((pass) =>
      pass.startsWith('user-global helper runtime: all '),
    ),
    report.passes.join('\n'),
  );
});
