import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Importing the CLI module directly is only possible because its top-level
// statements are guarded behind isCliExecution() (#1210 pattern); an
// import-time CLI run would parse process.argv and abort this test process.
import {
  applySubstitutionPlan,
  buildSubstitutionPlan,
  deriveInstallDepsCommand,
  deriveMarkerPrefix,
  deriveValidateCommands,
  escapeJsonStringContent,
  MARKER_PREFIX_PATTERN,
  ONBOARDING_PLACEHOLDERS,
  parseRemoteRepoRef,
  resolvePlaceholderValues,
  scanPlaceholderTokens,
} from '../src/scripts/idd-onboard.mts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PLACEHOLDERS_DOC = join(
  REPO_ROOT,
  'idd-template',
  'docs',
  'onboarding',
  'placeholders.md',
);

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'idd-onboard-'));
}

const ALL_OVERRIDES = {
  REPO_NAME: 'my-app',
  PROJECT_MARKER_PREFIX: 'my-app',
  TRUSTED_MARKER_ACTOR: 'trusted-user-a',
  FIX_VALIDATE_COMMANDS: 'npm run lint:fix && npm run lint',
  PRE_PUSH_VALIDATE_COMMANDS: 'npm run lint && npm run test',
  POST_FIX_VALIDATE_COMMANDS: 'npm run lint:fix && npm run test',
  INSTALL_DEPS_COMMAND: 'npm install',
};

/** A minimal imported-template tree exercising every placeholder site. */
function writeTemplateFixture(root: string): void {
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    [
      '{',
      '  "markerPrefix": "{{PROJECT_MARKER_PREFIX}}",',
      '  "trustedMarkerActors": ["{{TRUSTED_MARKER_ACTOR}}"],',
      '  "commands": {',
      '    "install-deps": "{{INSTALL_DEPS_COMMAND}}",',
      '    "fix-validate": "{{FIX_VALIDATE_COMMANDS}}",',
      '    "pre-push-validate": "{{PRE_PUSH_VALIDATE_COMMANDS}}",',
      '    "post-fix-validate": "{{POST_FIX_VALIDATE_COMMANDS}}"',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'README.md'),
    '# {{REPO_NAME}}\n\nWorktree example: ../{{REPO_NAME}}.issue-1-fix\n',
  );
}

/** Snapshot every file's bytes so byte-identity can be asserted later. */
function snapshotTree(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        snapshot.set(absolute, readFileSync(absolute));
      }
    }
  };
  walk(root);
  return snapshot;
}

function assertTreeUnchanged(root: string, before: Map<string, Buffer>): void {
  const after = snapshotTree(root);
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    'file set changed',
  );
  for (const [file, bytes] of before) {
    assert.ok(after.get(file)?.equals(bytes), `file changed: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Drift guard against idd-template/docs/onboarding/placeholders.md
// ---------------------------------------------------------------------------

test('the placeholder set matches the onboarding reference table exactly', () => {
  const doc = readFileSync(PLACEHOLDERS_DOC, 'utf8');
  const rows = [
    ...doc.matchAll(/^\| `\{\{([A-Z0-9_]+)\}\}`\s+\| (.+?)\s+\|/gmu),
  ];
  const documented = rows.map((row) => row[1]);
  assert.deepEqual(
    ONBOARDING_PLACEHOLDERS.map((entry) => entry.name),
    documented,
    'ONBOARDING_PLACEHOLDERS must match the "Final placeholder meanings" table order',
  );
  // No-op rule drift: exactly the placeholders whose documented meaning is
  // a command row may take the no-op value `true`.
  for (const row of rows) {
    const name = String(row[1] ?? '');
    const meaning = String(row[2] ?? '');
    const entry = ONBOARDING_PLACEHOLDERS.find((item) => item.name === name);
    assert.ok(entry, `undocumented placeholder ${name}`);
    assert.equal(
      entry.kind,
      /command/iu.test(meaning) ? 'command' : 'identity',
      `kind for ${name} must follow the documented meaning`,
    );
  }
});

test('the marker-prefix pattern matches the documented constraint', () => {
  const doc = readFileSync(PLACEHOLDERS_DOC, 'utf8');
  assert.ok(
    doc.includes(MARKER_PREFIX_PATTERN.source),
    'placeholders.md must document the same validation pattern',
  );
});

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

test('parseRemoteRepoRef handles https, ssh, and scp-like remote forms', () => {
  const expected = { owner: 'kurone-kito', repo: 'idd-skill' };
  assert.deepEqual(
    parseRemoteRepoRef('https://github.com/kurone-kito/idd-skill.git'),
    expected,
  );
  assert.deepEqual(
    parseRemoteRepoRef('https://github.com/kurone-kito/idd-skill'),
    expected,
  );
  assert.deepEqual(
    parseRemoteRepoRef('ssh://git@github.com/kurone-kito/idd-skill.git'),
    expected,
  );
  assert.deepEqual(
    parseRemoteRepoRef('git@github.com:kurone-kito/idd-skill.git'),
    expected,
  );
  // A trailing slash must not defeat the `.git` strip.
  assert.deepEqual(
    parseRemoteRepoRef('https://github.com/kurone-kito/idd-skill.git/'),
    expected,
  );
  // Deeper paths (GitLab subgroups, Azure `_git`) yield no owner rather
  // than guessing a wrong segment.
  assert.deepEqual(
    parseRemoteRepoRef('https://gitlab.com/group/sub/repo.git'),
    {
      owner: null,
      repo: 'repo',
    },
  );
  assert.deepEqual(
    parseRemoteRepoRef('https://dev.azure.com/org/project/_git/repo'),
    { owner: null, repo: 'repo' },
  );
  assert.equal(parseRemoteRepoRef('not a url'), null);
  assert.equal(parseRemoteRepoRef('https://github.com/idd-skill'), null);
  assert.equal(parseRemoteRepoRef(''), null);
  assert.equal(parseRemoteRepoRef(null), null);
});

test('deriveMarkerPrefix normalizes to the documented pattern or fails closed', () => {
  assert.equal(deriveMarkerPrefix('My_App.2024'), 'my-app-2024');
  assert.equal(deriveMarkerPrefix('idd-skill'), 'idd-skill');
  assert.equal(deriveMarkerPrefix('123-repo'), 'repo');
  assert.equal(
    deriveMarkerPrefix('a-very-long-repository-name-that-exceeds-limits'),
    'a-very-long-repository-name-that',
  );
  assert.equal(deriveMarkerPrefix('!!!'), null);
  assert.equal(deriveMarkerPrefix('a'), null);
  assert.equal(deriveMarkerPrefix(''), null);
  for (const derived of ['my-app-2024', 'repo']) {
    assert.match(derived, MARKER_PREFIX_PATTERN);
  }
});

test('deriveInstallDepsCommand follows the documented evidence table', () => {
  const cases: {
    files: Record<string, string>;
    expected: string | null;
  }[] = [
    {
      files: { 'pnpm-lock.yaml': '', 'package.json': '{}' },
      expected: 'pnpm install',
    },
    {
      files: { 'package.json': '{"packageManager":"npm@10.0.0"}' },
      expected: 'npm install',
    },
    // Bare package.json without signals: do not infer npm install.
    { files: { 'package.json': '{}' }, expected: null },
    {
      files: { 'requirements.txt': 'requests\n' },
      expected: 'pip install -r requirements.txt',
    },
    {
      files: { 'pyproject.toml': '[tool.poetry]\nname = "x"\n' },
      expected: 'poetry install',
    },
    // Dotted sub-tables are the common real-world pyproject shape.
    {
      files: { 'pyproject.toml': '[tool.hatch.envs.default]\ndeps = []\n' },
      expected: 'hatch env create',
    },
    // Exactly one supported lockfile counts even without a package.json.
    { files: { 'pnpm-lock.yaml': '' }, expected: 'pnpm install' },
    // Both Python workflows: confirm with the operator, do not guess.
    {
      files: { 'pyproject.toml': '[tool.pdm]\n', 'requirements.txt': '' },
      expected: null,
    },
    { files: { 'go.mod': 'module x\n' }, expected: 'go mod download' },
    {
      files: { Gemfile: 'source "https://rubygems.org"\n' },
      expected: 'bundle install',
    },
    // No standard dependency tooling at all: the documented no-op.
    { files: {}, expected: 'true' },
  ];
  for (const { files, expected } of cases) {
    const root = makeFixtureDir();
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, name), content);
    }
    assert.equal(
      deriveInstallDepsCommand(root),
      expected,
      `files: ${Object.keys(files).join(', ') || '(none)'}`,
    );
  }
});

test('deriveValidateCommands reads Node project scripts with the detected pm', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' },
    }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  // The post-fix superset deduplicates the shared `lint` step.
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: 'pnpm run lint:fix && pnpm run lint',
    prePushValidate: 'pnpm run lint && pnpm run test',
    postFixValidate: 'pnpm run lint:fix && pnpm run lint && pnpm run test',
  });
});

test('deriveValidateCommands fails closed when the package manager is unknown', () => {
  // Ambiguous evidence (two lockfiles) must not silently fall back to
  // npm — the same rule the install-command derivation applies.
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(join(root, 'yarn.lock'), '');
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: null,
    prePushValidate: null,
    postFixValidate: null,
  });
});

test('deriveValidateCommands uses fixed rows for go and the no-op for bare trees', () => {
  const goRoot = makeFixtureDir();
  writeFileSync(join(goRoot, 'go.mod'), 'module x\n');
  assert.deepEqual(deriveValidateCommands(goRoot), {
    fixValidate: 'go fmt ./...',
    prePushValidate: 'go vet ./... && go test ./...',
    postFixValidate: 'go fmt ./... && go vet ./... && go test ./...',
  });

  const bareRoot = makeFixtureDir();
  assert.deepEqual(deriveValidateCommands(bareRoot), {
    fixValidate: 'true',
    prePushValidate: 'true',
    postFixValidate: 'true',
  });

  // Recognized-but-unmapped tooling (plain pyproject) stays unresolved.
  const pyRoot = makeFixtureDir();
  writeFileSync(join(pyRoot, 'pyproject.toml'), '[project]\nname = "x"\n');
  assert.deepEqual(deriveValidateCommands(pyRoot), {
    fixValidate: null,
    prePushValidate: null,
    postFixValidate: null,
  });
});

// ---------------------------------------------------------------------------
// Resolution rules
// ---------------------------------------------------------------------------

test('resolvePlaceholderValues derives identity values from the git remote', () => {
  const root = makeFixtureDir();
  const resolution = resolvePlaceholderValues(
    root,
    {},
    { readRemoteUrl: () => 'git@github.com:trusted-user-a/My-App.git' },
  );
  // TRUSTED_MARKER_ACTOR is never auto-derived: the remote owner may be
  // an organization slug, not a login that posts markers.
  assert.deepEqual(resolution.unresolved, ['TRUSTED_MARKER_ACTOR']);
  assert.deepEqual(resolution.values.REPO_NAME, {
    value: 'My-App',
    source: 'derived',
  });
  assert.deepEqual(resolution.values.PROJECT_MARKER_PREFIX, {
    value: 'my-app',
    source: 'derived',
  });
  assert.equal(resolution.values.TRUSTED_MARKER_ACTOR, null);
  // Empty tree: command rows all take the documented no-op.
  assert.equal(resolution.values.INSTALL_DEPS_COMMAND?.value, 'true');
});

test('the marker prefix derives from an explicit --repo-name without a remote', () => {
  const root = makeFixtureDir();
  const resolution = resolvePlaceholderValues(
    root,
    { REPO_NAME: 'New_Name' },
    { readRemoteUrl: () => null },
  );
  assert.deepEqual(resolution.values.PROJECT_MARKER_PREFIX, {
    value: 'new-name',
    source: 'derived',
  });
  // ...and the flag also wins over a stale remote for the derivation.
  const renamed = resolvePlaceholderValues(
    root,
    { REPO_NAME: 'new-name' },
    { readRemoteUrl: () => 'git@github.com:owner/old-name.git' },
  );
  assert.equal(renamed.values.PROJECT_MARKER_PREFIX?.value, 'new-name');
});

test('unknown override keys are rejected instead of silently ignored', () => {
  const root = makeFixtureDir();
  assert.throws(
    () =>
      resolvePlaceholderValues(
        root,
        { REPONAME: 'typo' },
        {
          readRemoteUrl: () => null,
        },
      ),
    /unknown placeholder override: REPONAME/,
  );
});

test('resolvePlaceholderValues reports unresolved placeholders without evidence', () => {
  const root = makeFixtureDir();
  writeFileSync(join(root, 'package.json'), '{}');
  const resolution = resolvePlaceholderValues(
    root,
    {},
    { readRemoteUrl: () => null },
  );
  assert.deepEqual(resolution.unresolved, [
    'REPO_NAME',
    'PROJECT_MARKER_PREFIX',
    'TRUSTED_MARKER_ACTOR',
    'FIX_VALIDATE_COMMANDS',
    'PRE_PUSH_VALIDATE_COMMANDS',
    'POST_FIX_VALIDATE_COMMANDS',
    'INSTALL_DEPS_COMMAND',
  ]);
});

test('flag overrides win over derivation and are marked as flag-sourced', () => {
  const root = makeFixtureDir();
  const resolution = resolvePlaceholderValues(
    root,
    { REPO_NAME: 'renamed' },
    { readRemoteUrl: () => 'git@github.com:owner/original.git' },
  );
  assert.deepEqual(resolution.values.REPO_NAME, {
    value: 'renamed',
    source: 'flag',
  });
});

test('the no-op value true is rejected for identity placeholders', () => {
  const root = makeFixtureDir();
  assert.throws(
    () =>
      resolvePlaceholderValues(
        root,
        { REPO_NAME: 'true' },
        {
          readRemoteUrl: () => null,
        },
      ),
    /only valid for command placeholders/,
  );
  // ...and accepted for every command placeholder.
  const resolution = resolvePlaceholderValues(
    root,
    {
      ...ALL_OVERRIDES,
      FIX_VALIDATE_COMMANDS: 'true',
      PRE_PUSH_VALIDATE_COMMANDS: 'true',
      POST_FIX_VALIDATE_COMMANDS: 'true',
      INSTALL_DEPS_COMMAND: 'true',
    },
    { readRemoteUrl: () => null },
  );
  assert.deepEqual(resolution.unresolved, []);
});

test('an explicit marker prefix must satisfy the documented pattern', () => {
  const root = makeFixtureDir();
  assert.throws(
    () =>
      resolvePlaceholderValues(
        root,
        { PROJECT_MARKER_PREFIX: 'Bad_Prefix' },
        {
          readRemoteUrl: () => null,
        },
      ),
    /--marker-prefix must match/,
  );
});

test('values stay raw at resolution; JSON sites are escaped in the plan', () => {
  assert.equal(escapeJsonStringContent('trusted-user-a'), 'trusted-user-a');
  assert.equal(escapeJsonStringContent('a"b\\c'), 'a\\"b\\\\c');
  const root = makeFixtureDir();
  const resolution = resolvePlaceholderValues(
    root,
    { TRUSTED_MARKER_ACTOR: 'a"b' },
    { readRemoteUrl: () => null },
  );
  // Escaping is a property of the substitution site, applied per file in
  // buildSubstitutionPlan — the resolved value itself stays raw.
  assert.equal(resolution.values.TRUSTED_MARKER_ACTOR?.value, 'a"b');
});

test('command values containing quotes stay valid JSON and land raw in markdown', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  // A markdown command-table site next to the config.json site.
  writeFileSync(
    join(root, 'INSTALL.md'),
    '| **install-deps** | `{{INSTALL_DEPS_COMMAND}}` |\n',
  );
  const quotedCommand = 'npx cspell lint "**" --no-progress';
  const resolution = resolvePlaceholderValues(
    root,
    { ...ALL_OVERRIDES, INSTALL_DEPS_COMMAND: quotedCommand },
    { readRemoteUrl: () => null },
  );
  const plan = buildSubstitutionPlan(scanPlaceholderTokens(root), resolution);
  applySubstitutionPlan(root, plan);
  // The JSON site parses and round-trips the raw command...
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  assert.equal(config.commands['install-deps'], quotedCommand);
  // ...while the markdown site receives it unescaped.
  assert.equal(
    readFileSync(join(root, 'INSTALL.md'), 'utf8'),
    `| **install-deps** | \`${quotedCommand}\` |\n`,
  );
});

// ---------------------------------------------------------------------------
// Scan / plan / apply
// ---------------------------------------------------------------------------

test('substitution applies exactly the planned edits and keeps config.json valid', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const resolution = resolvePlaceholderValues(
    root,
    { ...ALL_OVERRIDES },
    {
      readRemoteUrl: () => null,
    },
  );
  const plan = buildSubstitutionPlan(scanPlaceholderTokens(root), resolution);
  assert.deepEqual(plan.residue, []);
  const readme = plan.entries.filter((entry) => entry.file === 'README.md');
  assert.deepEqual(readme, [
    {
      file: 'README.md',
      placeholder: 'REPO_NAME',
      occurrences: 2,
      from: '{{REPO_NAME}}',
      to: 'my-app',
    },
  ]);

  const filesChanged = applySubstitutionPlan(root, plan);
  assert.equal(filesChanged, 2);
  assert.equal(
    readFileSync(join(root, 'README.md'), 'utf8'),
    '# my-app\n\nWorktree example: ../my-app.issue-1-fix\n',
  );
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as {
    markerPrefix: string;
    trustedMarkerActors: string[];
    commands: Record<string, string>;
  };
  assert.equal(config.markerPrefix, 'my-app');
  assert.deepEqual(config.trustedMarkerActors, ['trusted-user-a']);
  assert.equal(config.commands['install-deps'], 'npm install');
  // The replacement pass converged: no {{...}} strings remain.
  assert.deepEqual(scanPlaceholderTokens(root), []);
});

test('unresolved placeholders block as residue; unknown tokens stay informational', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  writeFileSync(join(root, 'NOTES.md'), 'Leftover {{UNKNOWN_TOKEN}} here\n');
  const { REPO_NAME: _omitted, ...withoutRepoName } = ALL_OVERRIDES;
  const resolution = resolvePlaceholderValues(root, withoutRepoName, {
    readRemoteUrl: () => null,
  });
  const plan = buildSubstitutionPlan(scanPlaceholderTokens(root), resolution);
  assert.deepEqual(
    plan.residue.map((entry) => [entry.file, entry.token]),
    [['README.md', '{{REPO_NAME}}']],
  );
  // An adopter's own {{UPPER_SNAKE}} template token must not make the
  // run permanently non-convergent — wave 1 cannot know the copied set.
  assert.deepEqual(
    plan.unknownTokens.map((entry) => [entry.file, entry.token]),
    [['NOTES.md', '{{UNKNOWN_TOKEN}}']],
  );
});

test('a substitution value containing another token is never re-substituted', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const resolution = resolvePlaceholderValues(
    root,
    {
      ...ALL_OVERRIDES,
      FIX_VALIDATE_COMMANDS: 'echo {{PRE_PUSH_VALIDATE_COMMANDS}}',
    },
    { readRemoteUrl: () => null },
  );
  const plan = buildSubstitutionPlan(scanPlaceholderTokens(root), resolution);
  applySubstitutionPlan(root, plan);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  // Single-pass replacement keeps the operator's literal flag value.
  assert.equal(
    config.commands['fix-validate'],
    'echo {{PRE_PUSH_VALIDATE_COMMANDS}}',
  );
  assert.equal(
    config.commands['pre-push-validate'],
    'npm run lint && npm run test',
  );
});

test('binary files and excluded directories are not scanned', () => {
  const root = makeFixtureDir();
  writeFileSync(join(root, 'blob.bin'), Buffer.from('{{REPO_NAME}}\0tail'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'x.md'), '{{REPO_NAME}}');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '{{REPO_NAME}}');
  assert.deepEqual(scanPlaceholderTokens(root), []);
});

// ---------------------------------------------------------------------------
// CLI (acceptance criteria) through the committed bin artifact
// ---------------------------------------------------------------------------

const BIN_PATH = join(REPO_ROOT, 'bin', 'idd-onboard.mjs');

function runCliBin(args: string[]): {
  status: number;
  verdict: Record<string, unknown>;
} {
  try {
    const stdout = execFileSync(process.execPath, [BIN_PATH, ...args], {
      encoding: 'utf8',
    });
    return {
      status: 0,
      verdict: JSON.parse(stdout) as Record<string, unknown>,
    };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return {
      status: failed.status ?? -1,
      verdict: JSON.parse(String(failed.stdout ?? '{}')) as Record<
        string,
        unknown
      >,
    };
  }
}

const CLI_OVERRIDE_FLAGS = [
  '--repo-name',
  'my-app',
  '--marker-prefix',
  'my-app',
  '--trusted-marker-actor',
  'trusted-user-a',
  '--fix-validate-commands',
  'npm run lint:fix && npm run lint',
  '--pre-push-validate-commands',
  'npm run lint && npm run test',
  '--post-fix-validate-commands',
  'npm run lint:fix && npm run test',
  '--install-deps-command',
  'npm install',
];

test('bin/idd-onboard.mjs --substitute --dry-run prints the plan and writes nothing', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const before = snapshotTree(root);
  const { status, verdict } = runCliBin([
    '--substitute',
    '--dry-run',
    '--target',
    root,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.written, false);
  assert.ok(Array.isArray(verdict.plan) && verdict.plan.length > 0);
  assert.deepEqual(verdict.residue, []);
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs without --dry-run applies exactly the planned edits', () => {
  const dryRoot = makeFixtureDir();
  writeTemplateFixture(dryRoot);
  const planned = runCliBin([
    '--substitute',
    '--dry-run',
    '--target',
    dryRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]).verdict.plan;

  const applyRoot = makeFixtureDir();
  writeTemplateFixture(applyRoot);
  const { status, verdict } = runCliBin([
    '--substitute',
    '--target',
    applyRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.written, true);
  assert.deepEqual(verdict.plan, planned);
  assert.equal(
    readFileSync(join(applyRoot, 'README.md'), 'utf8'),
    '# my-app\n\nWorktree example: ../my-app.issue-1-fix\n',
  );
});

test('bin/idd-onboard.mjs exits 1, reports residue, and writes nothing when unresolved', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const before = snapshotTree(root);
  // Apply mode (no --dry-run): the fail-closed gate must refuse to write
  // a half-substituted tree when any placeholder stays unresolved.
  const { status, verdict } = runCliBin(['--substitute', '--target', root]);
  assert.equal(status, 1);
  assert.equal(verdict.written, false);
  assert.equal(verdict.filesChanged, 0);
  const residue = verdict.residue as { token: string }[];
  assert.ok(residue.length > 0);
  assert.ok(residue.every((entry) => entry.token.startsWith('{{')));
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs exits 2 on usage errors, distinct from residue', () => {
  const root = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--substitute', '--target', root, '--no-such-flag'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /unknown argument/);
  }
});

test('importing idd-onboard.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(import('../src/scripts/idd-onboard.mts'));
  } finally {
    process.env.PATH = originalPath;
  }
});
