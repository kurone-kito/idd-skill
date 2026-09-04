import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectVendoredFiles,
  PROFILE_NAMES,
} from '../src/scripts/helper-runtime-manifest.mts';
// Importing the CLI module directly is only possible because its top-level
// statements are guarded behind `import.meta.main` (#1210 pattern, migrated
// from isCliExecution() by #1447); an import-time CLI run would parse
// process.argv and abort this test process.
import {
  applyImportPlan,
  applySubstitutionPlan,
  buildImportPlan,
  buildSubstitutionPlan,
  checkGitRemoteBranchExists,
  checkManifestCompleteness,
  checkPlaceholderResidue,
  checkStaleImportSignal,
  deriveDevelopmentBranchCandidate,
  deriveInstallDepsCommand,
  deriveMarkerPrefix,
  deriveValidateCommands,
  escapeJsonStringContent,
  HEAR_NON_TTY_ERROR,
  listSkippedPlaceholderPaths,
  MARKER_PREFIX_PATTERN,
  ONBOARDING_PLACEHOLDERS,
  parseRemoteRepoRef,
  readExistingCommandsTable,
  resolveConfinedDirectory,
  resolveCoreTemplateFiles,
  resolveImportFiles,
  resolvePlaceholderValues,
  restoreExistingCommandsTable,
  runHearWizard,
  runRecordPolicyCli,
  runVerify,
  SCAN_EXCLUDED_PATHS,
  scanPlaceholderTokens,
} from '../src/scripts/idd-onboard.mts';
import { loadOnboardingHearingCatalog } from '../src/scripts/onboarding-hearing.mts';
import type { PromptFn } from '../src/scripts/readline-prompt.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PLACEHOLDERS_DOC = join(
  REPO_ROOT,
  'idd-template',
  'docs',
  'onboarding',
  'placeholders.md',
);
const ONBOARDING_DOC = join(REPO_ROOT, 'idd-template', 'ONBOARDING.md');

const createdFixtureDirs: string[] = [];

/**
 * `mkdtempSync` under `tmpdir()`, tracked for teardown in the `after()` hook
 * below. Rejects a `prefix` containing a path separator and verifies the
 * created directory is a direct child of `tmpdir()`, so the recursive,
 * forced teardown below can never reach outside `tmpdir()` even if a future
 * call site passes a qualified or traversal-shaped prefix.
 */
function trackedMkdtemp(prefix: string): string {
  if (
    prefix.includes('/') ||
    prefix.includes('\\') ||
    prefix === '' ||
    prefix === '.' ||
    prefix === '..'
  ) {
    throw new Error(
      `trackedMkdtemp: prefix must be a plain, non-empty, non-dot-segment string: ${prefix}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (dirname(dir) !== resolve(tmpdir())) {
    // Unreachable given the prefix guard above; kept as defense-in-depth
    // for a future change to the guard or to Node's join() behavior.
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `trackedMkdtemp: refusing to track a directory outside tmpdir(): ${dir}`,
    );
  }
  createdFixtureDirs.push(dir);
  return dir;
}

function makeFixtureDir(): string {
  return trackedMkdtemp('idd-onboard-');
}

after(() => {
  for (const dir of createdFixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function writeExistingCommandsConfig(
  root: string,
  commands: Record<string, string>,
): void {
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    JSON.stringify({ commands }),
  );
}

test('deriveValidateCommands prefers an existing populated commands table on re-import (#2222)', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeExistingCommandsConfig(root, {
    'fix-validate': 'npx biome check --write',
    'pre-push-validate': 'npx biome check',
    'post-fix-validate': 'npx biome check --write',
  });
  // The heuristic would derive pnpm lint:fix/lint/test rows; the existing
  // deliberately customized table wins for every row it sets.
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: 'npx biome check --write',
    prePushValidate: 'npx biome check',
    postFixValidate: 'npx biome check --write',
  });
});

test('deriveValidateCommands falls back to the heuristic only for rows the existing table leaves unset', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeExistingCommandsConfig(root, {
    'fix-validate': 'npx biome check --write',
  });
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: 'npx biome check --write',
    prePushValidate: 'pnpm run lint && pnpm run test',
    postFixValidate: 'pnpm run lint:fix && pnpm run lint && pnpm run test',
  });
});

test('deriveValidateCommands treats an unsubstituted placeholder row as unset, not as an existing value', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  // A freshly imported tree before --substitute has run still carries the
  // raw template tokens — those must not be read back as real commands.
  writeExistingCommandsConfig(root, {
    'fix-validate': '{{FIX_VALIDATE_COMMANDS}}',
    'pre-push-validate': '{{PRE_PUSH_VALIDATE_COMMANDS}}',
    'post-fix-validate': '{{POST_FIX_VALIDATE_COMMANDS}}',
  });
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: 'pnpm run lint:fix && pnpm run lint',
    prePushValidate: 'pnpm run lint && pnpm run test',
    postFixValidate: 'pnpm run lint:fix && pnpm run lint && pnpm run test',
  });
});

test('deriveValidateCommands preserves a row that merely has the same doubled-brace shape as an onboarding token but is not one of ours (#2254 review)', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  // An adopter's own downstream template syntax, unrelated to this
  // onboarding flow's seven known placeholder tokens -- must survive
  // as a real existing value, not be discarded as unresolved residue.
  writeExistingCommandsConfig(root, {
    'fix-validate': '{{CI_COMMAND}}',
  });
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: '{{CI_COMMAND}}',
    prePushValidate: 'pnpm run lint && pnpm run test',
    postFixValidate: 'pnpm run lint:fix && pnpm run lint && pnpm run test',
  });
});

test('deriveValidateCommands ignores a missing, empty, or unparseable commands table', () => {
  const goRoot = makeFixtureDir();
  writeFileSync(join(goRoot, 'go.mod'), 'module x\n');
  writeExistingCommandsConfig(goRoot, {});
  assert.deepEqual(deriveValidateCommands(goRoot), {
    fixValidate: 'go fmt ./...',
    prePushValidate: 'go vet ./... && go test ./...',
    postFixValidate: 'go fmt ./... && go vet ./... && go test ./...',
  });

  const malformedRoot = makeFixtureDir();
  writeFileSync(join(malformedRoot, 'go.mod'), 'module x\n');
  mkdirSync(join(malformedRoot, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(malformedRoot, '.github', 'idd', 'config.json'),
    '{ not valid json',
  );
  assert.deepEqual(deriveValidateCommands(malformedRoot), {
    fixValidate: 'go fmt ./...',
    prePushValidate: 'go vet ./... && go test ./...',
    postFixValidate: 'go fmt ./... && go vet ./... && go test ./...',
  });

  // A valid JSON document can still parse to a non-object root (`null`, a
  // bare number/string, or an array) -- must not throw on property access.
  for (const nonObjectRoot of ['null', '42', '"just a string"', '[1, 2]']) {
    const root = makeFixtureDir();
    writeFileSync(join(root, 'go.mod'), 'module x\n');
    mkdirSync(join(root, '.github', 'idd'), { recursive: true });
    writeFileSync(join(root, '.github', 'idd', 'config.json'), nonObjectRoot);
    assert.deepEqual(
      deriveValidateCommands(root),
      {
        fixValidate: 'go fmt ./...',
        prePushValidate: 'go vet ./... && go test ./...',
        postFixValidate: 'go fmt ./... && go vet ./... && go test ./...',
      },
      `config.json root: ${nonObjectRoot}`,
    );
  }
});

test('a first-time onboarding (no existing commands table) still derives from package.json exactly as before', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  assert.deepEqual(deriveValidateCommands(root), {
    fixValidate: 'pnpm run lint:fix && pnpm run lint',
    prePushValidate: 'pnpm run lint && pnpm run test',
    postFixValidate: 'pnpm run lint:fix && pnpm run lint && pnpm run test',
  });
});

test('resolvePlaceholderValues re-import: existing config commands win, an explicit flag still overrides them', () => {
  const root = makeFixtureDir();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'lint:fix': 'x', lint: 'x', test: 'x' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeExistingCommandsConfig(root, {
    'fix-validate': 'npx biome check --write',
    'pre-push-validate': 'npx biome check',
    'post-fix-validate': 'npx biome check --write',
  });
  const resolution = resolvePlaceholderValues(
    root,
    { PRE_PUSH_VALIDATE_COMMANDS: 'npm run ci' },
    { readRemoteUrl: () => null },
  );
  assert.deepEqual(resolution.values.FIX_VALIDATE_COMMANDS, {
    value: 'npx biome check --write',
    source: 'derived',
  });
  assert.deepEqual(resolution.values.PRE_PUSH_VALIDATE_COMMANDS, {
    value: 'npm run ci',
    source: 'flag',
  });
  assert.deepEqual(resolution.values.POST_FIX_VALIDATE_COMMANDS, {
    value: 'npx biome check --write',
    source: 'derived',
  });
});

test('readExistingCommandsTable is a generic commands-table reader (not scoped to the three validate rows)', () => {
  const root = makeFixtureDir();
  writeExistingCommandsConfig(root, {
    'install-deps': 'npm install',
    'fix-validate': 'npx biome check --write',
  });
  // deriveValidateCommands only reads the three keys it needs from this;
  // the #2222 restore-scope boundary is enforced in
  // restoreExistingCommandsTable below, not here.
  assert.deepEqual(readExistingCommandsTable(root), {
    'install-deps': 'npm install',
    'fix-validate': 'npx biome check --write',
  });
});

test('restoreExistingCommandsTable never restores install-deps, even when the snapshot includes it (#2222 scope)', () => {
  const root = makeFixtureDir();
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    JSON.stringify({
      commands: {
        'install-deps': '{{INSTALL_DEPS_COMMAND}}',
        'fix-validate': '{{FIX_VALIDATE_COMMANDS}}',
      },
    }),
  );
  restoreExistingCommandsTable(root, {
    'install-deps': 'npm install',
    'fix-validate': 'npx biome check --write',
  });
  const restored = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  assert.equal(restored.commands['fix-validate'], 'npx biome check --write');
  // install-deps is out of #2222's scope: the placeholder token is left
  // exactly as --import wrote it, for the normal --substitute flow to
  // resolve independently via deriveInstallDepsCommand.
  assert.equal(restored.commands['install-deps'], '{{INSTALL_DEPS_COMMAND}}');
});

test('restoreExistingCommandsTable only rewrites a row still holding the raw placeholder token', () => {
  const root = makeFixtureDir();
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    JSON.stringify({
      commands: {
        // Source already provided a real value for this key (no
        // placeholder site) — restoring must not clobber it.
        'fix-validate': 'go fmt ./...',
        'pre-push-validate': '{{PRE_PUSH_VALIDATE_COMMANDS}}',
      },
    }),
  );
  restoreExistingCommandsTable(root, {
    'fix-validate': 'npx biome check --write',
    'pre-push-validate': 'npx biome check',
  });
  const result = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  assert.equal(result.commands['fix-validate'], 'go fmt ./...');
  assert.equal(result.commands['pre-push-validate'], 'npx biome check');
});

test('restoreExistingCommandsTable is a no-op for a null/empty snapshot or a missing config.json', () => {
  const root = makeFixtureDir();
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  const configPath = join(root, '.github', 'idd', 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      commands: { 'fix-validate': '{{FIX_VALIDATE_COMMANDS}}' },
    }),
  );
  const before = readFileSync(configPath, 'utf8');
  restoreExistingCommandsTable(root, null);
  restoreExistingCommandsTable(root, {});
  assert.equal(readFileSync(configPath, 'utf8'), before);

  const noConfigRoot = makeFixtureDir();
  // Must not throw when .github/idd/config.json does not exist at all.
  restoreExistingCommandsTable(noConfigRoot, { 'fix-validate': 'x' });
  assert.equal(existsSync(join(noConfigRoot, '.github', 'idd')), false);
});

test('readExistingCommandsTable and restoreExistingCommandsTable never follow a symlinked config.json out of the target (#2254 review)', () => {
  const outsideRoot = makeFixtureDir();
  const outsideConfigPath = join(outsideRoot, 'secret-config.json');
  writeFileSync(
    outsideConfigPath,
    JSON.stringify({ commands: { 'fix-validate': 'leaked-secret-command' } }),
  );

  const targetRoot = makeFixtureDir();
  mkdirSync(join(targetRoot, '.github', 'idd'), { recursive: true });
  const symlinkPath = join(targetRoot, '.github', 'idd', 'config.json');
  symlinkSync(outsideConfigPath, symlinkPath);

  // A symlinked config.json is treated as absent, never followed to read
  // content from outside the target tree.
  assert.equal(readExistingCommandsTable(targetRoot), null);

  // Nor written through: restoring must not touch the outside file, and
  // must leave the symlink itself untouched too.
  restoreExistingCommandsTable(targetRoot, { 'fix-validate': 'restored' });
  assert.equal(
    readFileSync(outsideConfigPath, 'utf8'),
    JSON.stringify({ commands: { 'fix-validate': 'leaked-secret-command' } }),
  );
  assert.ok(lstatSync(symlinkPath).isSymbolicLink());
});

test('readExistingCommandsTable and restoreExistingCommandsTable never follow a symlinked ancestor directory either (#2254 review)', () => {
  const outsideRoot = makeFixtureDir();
  writeFileSync(
    join(outsideRoot, 'config.json'),
    JSON.stringify({ commands: { 'fix-validate': 'leaked-secret-command' } }),
  );

  const targetRoot = makeFixtureDir();
  mkdirSync(join(targetRoot, '.github'), { recursive: true });
  // .github/idd itself is a symlink to an external directory -- a plain
  // fileExists lstat on the leaf config.json alone would not catch this,
  // since the leaf lstat follows the symlinked parent to resolve its path.
  symlinkSync(outsideRoot, join(targetRoot, '.github', 'idd'));

  assert.equal(readExistingCommandsTable(targetRoot), null);

  restoreExistingCommandsTable(targetRoot, { 'fix-validate': 'restored' });
  assert.equal(
    readFileSync(join(outsideRoot, 'config.json'), 'utf8'),
    JSON.stringify({ commands: { 'fix-validate': 'leaked-secret-command' } }),
  );
  assert.ok(lstatSync(join(targetRoot, '.github', 'idd')).isSymbolicLink());
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
// #1924 — meta-docs that document the placeholders stay literal
// ---------------------------------------------------------------------------

/** Write a token-bearing copy of each `SCAN_EXCLUDED_PATHS` doc into `root`. */
function writeExcludedMetaDocs(root: string): void {
  for (const relativePath of SCAN_EXCLUDED_PATHS) {
    const absolute = join(root, ...relativePath.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      `# Reference\n\n\`{{REPO_NAME}}\` names the repository.\n`,
    );
  }
}

test('scanPlaceholderTokens skips SCAN_EXCLUDED_PATHS meta-docs entirely', () => {
  const root = makeFixtureDir();
  writeExcludedMetaDocs(root);
  writeFileSync(join(root, 'README.md'), '# {{REPO_NAME}}\n');
  const scans = scanPlaceholderTokens(root);
  assert.deepEqual(scans.map((scan) => scan.file).sort(), ['README.md']);
});

test('--substitute leaves the meta-docs byte-identical, including on a second re-sync run', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  writeExcludedMetaDocs(root);
  const before = new Map(
    [...SCAN_EXCLUDED_PATHS].map((relativePath) => [
      relativePath,
      readFileSync(join(root, ...relativePath.split('/'))),
    ]),
  );
  const resolution = resolvePlaceholderValues(root, ALL_OVERRIDES, {
    readRemoteUrl: () => null,
  });
  for (let run = 0; run < 2; run += 1) {
    const plan = buildSubstitutionPlan(scanPlaceholderTokens(root), resolution);
    // The meta-docs never contribute a plan entry.
    assert.ok(
      plan.entries.every((entry) => !SCAN_EXCLUDED_PATHS.has(entry.file)),
    );
    applySubstitutionPlan(root, plan);
  }
  for (const [relativePath, original] of before) {
    const after = readFileSync(join(root, ...relativePath.split('/')));
    assert.ok(original.equals(after), `byte mismatch: ${relativePath}`);
  }
  // Every non-excluded site still converges normally in the same run.
  assert.equal(
    readFileSync(join(root, 'README.md'), 'utf8'),
    '# my-app\n\nWorktree example: ../my-app.issue-1-fix\n',
  );
});

test('applySubstitutionPlan refuses to rewrite a SCAN_EXCLUDED_PATHS entry even from a hand-built plan', () => {
  const root = makeFixtureDir();
  writeExcludedMetaDocs(root);
  const [excludedPath] = SCAN_EXCLUDED_PATHS;
  const before = readFileSync(join(root, ...excludedPath.split('/')));
  const filesChanged = applySubstitutionPlan(root, {
    entries: [
      {
        file: excludedPath,
        placeholder: 'REPO_NAME',
        occurrences: 1,
        from: '{{REPO_NAME}}',
        to: 'my-app',
      },
    ],
    residue: [],
    unknownTokens: [],
  });
  assert.equal(filesChanged, 0);
  assert.ok(
    before.equals(readFileSync(join(root, ...excludedPath.split('/')))),
  );
});

test('checkPlaceholderResidue does not report the meta-docs as unresolved residue', () => {
  const root = makeFixtureDir();
  writeExcludedMetaDocs(root);
  const result = checkPlaceholderResidue(root);
  assert.deepEqual(result.residue, []);
  assert.deepEqual(result.unknownTokens, []);
});

test('listSkippedPlaceholderPaths reports only the meta-docs present in the target, sorted', () => {
  const root = makeFixtureDir();
  const [firstPath] = [...SCAN_EXCLUDED_PATHS].sort();
  mkdirSync(dirname(join(root, ...firstPath.split('/'))), {
    recursive: true,
  });
  writeFileSync(join(root, ...firstPath.split('/')), '# ref\n');
  assert.deepEqual(listSkippedPlaceholderPaths(root), [firstPath]);
});

// ---------------------------------------------------------------------------
// Wave 2: --import (manifest-driven fetch/copy)
// ---------------------------------------------------------------------------

const CORE_FILES_BLOCK_MARKER =
  '<!-- audit:generated id=idd-template-core-files -->';

test('resolveCoreTemplateFiles matches the ONBOARDING.md idd-template-core-files generated block', () => {
  const onboardingPath = join(REPO_ROOT, 'idd-template', 'ONBOARDING.md');
  const text = readFileSync(onboardingPath, 'utf8');
  const markerIndex = text.indexOf(CORE_FILES_BLOCK_MARKER);
  assert.ok(markerIndex !== -1, 'core-files generated block marker not found');
  const fenceStart = text.indexOf('```text\n', markerIndex);
  assert.ok(fenceStart !== -1, 'core-files code fence not found');
  const contentStart = fenceStart + '```text\n'.length;
  const fenceEnd = text.indexOf('\n```', contentStart);
  assert.ok(fenceEnd !== -1, 'core-files code fence not closed');
  const documented = text
    .slice(contentStart, fenceEnd)
    .split('\n')
    .filter((line) => line.length > 0);

  const resolved = resolveCoreTemplateFiles(REPO_ROOT).map(
    (file) => file.targetPath,
  );
  assert.deepEqual(
    resolved,
    documented,
    "audit/sync-manifest.json's idd-template-core-files paths must match the rendered ONBOARDING.md block exactly",
  );
});

test('resolveCoreTemplateFiles includes post-merge-cleanup.yml in the core (auto-imported) file set (idd-skill#1832)', () => {
  const resolved = resolveCoreTemplateFiles(REPO_ROOT);
  const workflowFile = resolved.find(
    (file) => file.targetPath === '.github/workflows/post-merge-cleanup.yml',
  );
  assert.ok(
    workflowFile,
    'expected .github/workflows/post-merge-cleanup.yml in the core template file set, so a fresh `idd-onboard.mjs --import` copies it without a separate opt-in step',
  );
  assert.equal(
    workflowFile?.sourcePath,
    'idd-template/.github/workflows/post-merge-cleanup.yml',
  );

  // resolveImportFiles vends the same core set for every profile
  // (including no profile at all) -- unlike the vendored-node-only
  // helper bundle, this file is not profile-conditional.
  for (const profile of [undefined, ...PROFILE_NAMES]) {
    const files = resolveImportFiles(REPO_ROOT, profile).files;
    assert.ok(
      files.some(
        (file) =>
          file.targetPath === '.github/workflows/post-merge-cleanup.yml',
      ),
      `expected post-merge-cleanup.yml in resolveImportFiles output for profile ${String(profile)}`,
    );
  }
});

test('resolveCoreTemplateFiles rejects a source tree without a readable manifest', () => {
  assert.throws(
    () => resolveCoreTemplateFiles(makeFixtureDir()),
    /audit\/sync-manifest\.json/u,
  );
});

/** Write a minimal sync-manifest.json declaring exactly the given paths. */
function writeCoreFilesManifest(
  root: string,
  paths: string[],
  stripPrefix = 'idd-template/',
): void {
  mkdirSync(join(root, 'audit'), { recursive: true });
  writeFileSync(
    join(root, 'audit', 'sync-manifest.json'),
    JSON.stringify({
      generatedBlocks: [
        {
          id: 'idd-template-core-files',
          file: 'idd-template/ONBOARDING.md',
          stripPrefix,
          paths,
        },
      ],
    }),
  );
}

test('resolveCoreTemplateFiles rejects a manifest path that parent-traverses out of the source root', () => {
  const root = makeFixtureDir();
  writeCoreFilesManifest(root, ['idd-template/../../../etc/passwd']);
  assert.throws(() => resolveCoreTemplateFiles(root), /unsafe manifest path/u);
});

test('resolveCoreTemplateFiles rejects an absolute manifest path', () => {
  const root = makeFixtureDir();
  writeCoreFilesManifest(root, ['/etc/passwd'], '');
  assert.throws(() => resolveCoreTemplateFiles(root), /unsafe manifest path/u);
});

/** Write an arbitrary (possibly malformed) sync-manifest.json body. */
function writeRawManifest(root: string, body: unknown): void {
  mkdirSync(join(root, 'audit'), { recursive: true });
  writeFileSync(
    join(root, 'audit', 'sync-manifest.json'),
    JSON.stringify(body),
  );
}

test('resolveCoreTemplateFiles rejects a malformed generatedBlocks instead of throwing a raw TypeError', () => {
  const root = makeFixtureDir();
  writeRawManifest(root, { generatedBlocks: 'not-an-array' });
  assert.throws(
    () => resolveCoreTemplateFiles(root),
    /malformed generatedBlocks/u,
  );
});

test('resolveCoreTemplateFiles rejects a non-array paths field instead of throwing a raw TypeError', () => {
  const root = makeFixtureDir();
  writeRawManifest(root, {
    generatedBlocks: [{ id: 'idd-template-core-files', paths: 'not-an-array' }],
  });
  assert.throws(
    () => resolveCoreTemplateFiles(root),
    /valid paths: string\[\]/u,
  );
});

test('resolveCoreTemplateFiles rejects a paths array containing a non-string entry', () => {
  const root = makeFixtureDir();
  writeRawManifest(root, {
    generatedBlocks: [
      { id: 'idd-template-core-files', paths: ['idd-template/a.md', 42] },
    ],
  });
  assert.throws(
    () => resolveCoreTemplateFiles(root),
    /valid paths: string\[\]/u,
  );
});

test('resolveCoreTemplateFiles rejects a non-string stripPrefix', () => {
  const root = makeFixtureDir();
  writeRawManifest(root, {
    generatedBlocks: [
      {
        id: 'idd-template-core-files',
        paths: ['idd-template/a.md'],
        stripPrefix: 42,
      },
    ],
  });
  assert.throws(
    () => resolveCoreTemplateFiles(root),
    /valid paths: string\[\]/u,
  );
});

test('resolveImportFiles vends no extra files for a non-vendored-node profile', () => {
  const withoutProfile = resolveImportFiles(REPO_ROOT);
  const packageManagerProfile = resolveImportFiles(
    REPO_ROOT,
    'package-manager',
  );
  const coreTargets = resolveCoreTemplateFiles(REPO_ROOT).map(
    (f) => f.targetPath,
  );
  assert.deepEqual(
    withoutProfile.files.map((f) => f.targetPath),
    coreTargets,
  );
  assert.deepEqual(withoutProfile.missingSource, []);
  assert.deepEqual(
    packageManagerProfile.files.map((f) => f.targetPath),
    coreTargets,
  );
  assert.deepEqual(packageManagerProfile.missingSource, []);
});

test('resolveImportFiles includes the helper bundle only for the vendored-node profile', () => {
  const resolved = resolveImportFiles(REPO_ROOT, 'vendored-node');
  assert.deepEqual(resolved.missingSource, []);
  const coreTargets = new Set(
    resolveCoreTemplateFiles(REPO_ROOT).map((f) => f.targetPath),
  );
  const helperTargets = new Set(
    collectVendoredFiles(REPO_ROOT).map((f) => f.targetPath),
  );
  const resultTargets = new Set(resolved.files.map((f) => f.targetPath));
  assert.equal(resultTargets.size, coreTargets.size + helperTargets.size);
  for (const target of coreTargets) {
    assert.ok(resultTargets.has(target), `missing core file: ${target}`);
  }
  for (const target of helperTargets) {
    assert.ok(resultTargets.has(target), `missing helper file: ${target}`);
  }
});

test('resolveImportFiles rejects an unknown --profile value', () => {
  assert.throws(
    () => resolveImportFiles(REPO_ROOT, 'bogus-profile'),
    /unknown --profile/u,
  );
});

/**
 * A real idd-skill tree copy with one vendored helper entry deleted, so
 * collectVendoredFiles's import-graph walk hits that missing file.
 * Excludes node_modules and other heavy/irrelevant directories to keep
 * the copy cheap.
 */
function makeIncompleteVendoredSourceFixture(
  missingRelativePath: string,
): string {
  const root = makeFixtureDir();
  for (const dir of [
    'idd-template',
    'audit',
    'scripts',
    'schemas',
    'fixtures',
  ]) {
    const source = join(REPO_ROOT, dir);
    if (existsSync(source)) {
      cpSync(source, join(root, dir), { recursive: true });
    }
  }
  rmSync(join(root, missingRelativePath), { force: true });
  return root;
}

test('resolveImportFiles reports a missing vendored helper file via missingSource instead of crashing', () => {
  const sourceRoot = makeIncompleteVendoredSourceFixture(
    'scripts/branch-name.mjs',
  );
  const resolved = resolveImportFiles(sourceRoot, 'vendored-node');
  assert.deepEqual(resolved.missingSource, ['scripts/branch-name.mjs']);
  // The core file set still resolves even though the vendored bundle
  // walk was interrupted by the missing helper file.
  assert.ok(resolved.files.length > 0);
  assert.ok(
    resolved.files.every(
      (file) => file.targetPath !== 'scripts/branch-name.mjs',
    ),
  );
});

test('buildImportPlan blocks a non-directory ancestor collision, not just a leaf collision', () => {
  const sourceRoot = makeImportSourceFixture({ 'nested/a.md': 'alpha\n' });
  const targetRoot = makeFixtureDir();
  // A plain file occupies "nested", the ancestor directory the manifest
  // path "nested/a.md" needs to be created under.
  writeFileSync(join(targetRoot, 'nested'), 'not a directory\n');

  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'blocked-non-file');
  assert.deepEqual(plan.nonFileTargetCollisions, ['nested/a.md']);

  // applyImportPlan must never attempt the impossible mkdirSync/copy, even
  // if a caller applied the plan without checking the blocking arrays.
  assert.equal(applyImportPlan(sourceRoot, targetRoot, plan), 0);
  assert.ok(statSync(join(targetRoot, 'nested')).isFile());
});

test('buildImportPlan blocks a symlink at the leaf target path instead of following it', () => {
  const sourceRoot = makeImportSourceFixture({ 'a.md': 'alpha\n' });
  const targetRoot = makeFixtureDir();
  const linkTarget = join(targetRoot, 'real.md');
  writeFileSync(linkTarget, 'alpha\n');
  symlinkSync(linkTarget, join(targetRoot, 'a.md'));

  const plan = buildImportPlan(sourceRoot, targetRoot);
  const entry = plan.entries.find((e) => e.targetPath === 'a.md');
  assert.equal(entry?.classification, 'blocked-non-file');
  assert.deepEqual(plan.nonFileTargetCollisions, ['a.md']);

  // Even with --force, applyImportPlan must never write through the
  // symlink (force overrides a differing *file*, not a type collision).
  const forcedPlan = buildImportPlan(sourceRoot, targetRoot, { force: true });
  assert.equal(applyImportPlan(sourceRoot, targetRoot, forcedPlan), 0);
  assert.ok(lstatSync(join(targetRoot, 'a.md')).isSymbolicLink());
});

test('buildImportPlan blocks a symlinked ancestor directory in the target tree', () => {
  const sourceRoot = makeImportSourceFixture({ 'nested/a.md': 'alpha\n' });
  const targetRoot = makeFixtureDir();
  const realDir = join(targetRoot, 'real-dir');
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, join(targetRoot, 'nested'));

  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'blocked-non-file');
  assert.deepEqual(plan.nonFileTargetCollisions, ['nested/a.md']);
  assert.equal(applyImportPlan(sourceRoot, targetRoot, plan), 0);
  // The symlink itself must survive untouched — no write escaped through
  // it into realDir.
  assert.ok(lstatSync(join(targetRoot, 'nested')).isSymbolicLink());
  assert.deepEqual(readdirSync(realDir), []);
});

test('buildImportPlan blocks a symlinked ancestor even when the leaf already exists under it', () => {
  // The more dangerous variant of the previous test: fileExists() on the
  // joined target path would report "exists" here (the leaf resolves,
  // through the symlinked ancestor, to a real file), so the ancestor
  // check must run unconditionally rather than only when the leaf is
  // absent -- otherwise this case would fall through to unchanged /
  // overwrite and applyImportPlan would read or write straight through
  // the symlinked ancestor.
  const sourceRoot = makeImportSourceFixture({ 'nested/a.md': 'alpha\n' });
  const targetRoot = makeFixtureDir();
  const realDir = join(targetRoot, 'real-dir');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, 'a.md'), 'alpha\n'); // byte-identical to source
  symlinkSync(realDir, join(targetRoot, 'nested'));

  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'blocked-non-file');
  assert.deepEqual(plan.nonFileTargetCollisions, ['nested/a.md']);

  // Even with --force (which only overrides a differing *file*), the
  // symlinked ancestor must still block.
  const forcedPlan = buildImportPlan(sourceRoot, targetRoot, { force: true });
  assert.equal(forcedPlan.entries[0]?.classification, 'blocked-non-file');
  assert.equal(applyImportPlan(sourceRoot, targetRoot, forcedPlan), 0);
  assert.ok(lstatSync(join(targetRoot, 'nested')).isSymbolicLink());
});

test('buildImportPlan reports a symlinked source file as missing rather than reading through it', () => {
  const sourceRoot = makeFixtureDir();
  writeCoreFilesManifest(sourceRoot, ['idd-template/a.md']);
  mkdirSync(join(sourceRoot, 'idd-template'), { recursive: true });
  const realFile = join(sourceRoot, 'real.md');
  writeFileSync(realFile, 'alpha\n');
  symlinkSync(realFile, join(sourceRoot, 'idd-template', 'a.md'));

  const plan = buildImportPlan(sourceRoot, makeFixtureDir());
  assert.deepEqual(plan.missingSource, ['idd-template/a.md']);
  assert.equal(plan.entries.length, 0);
});

/** A minimal idd-skill-shaped source tree: just enough for resolveImportFiles. */
function makeImportSourceFixture(files: Record<string, string>): string {
  const root = makeFixtureDir();
  const paths = Object.keys(files).map((rel) => `idd-template/${rel}`);
  mkdirSync(join(root, 'audit'), { recursive: true });
  writeFileSync(
    join(root, 'audit', 'sync-manifest.json'),
    JSON.stringify(
      {
        generatedBlocks: [
          {
            id: 'idd-template-core-files',
            file: 'idd-template/ONBOARDING.md',
            stripPrefix: 'idd-template/',
            paths,
          },
        ],
      },
      null,
      2,
    ),
  );
  for (const [rel, content] of Object.entries(files)) {
    const absolute = join(root, 'idd-template', rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

test('buildImportPlan classifies new, unchanged, and blocked-overwrite target files', () => {
  const sourceRoot = makeImportSourceFixture({
    'a.md': 'alpha\n',
    'b.md': 'bravo\n',
    'c.md': 'charlie\n',
  });
  const targetRoot = makeFixtureDir();
  writeFileSync(join(targetRoot, 'a.md'), 'alpha\n'); // byte-identical
  writeFileSync(join(targetRoot, 'b.md'), 'DIFFERENT\n'); // differs
  // c.md is absent from the target -> new

  const plan = buildImportPlan(sourceRoot, targetRoot);
  const byTarget = new Map(plan.entries.map((e) => [e.targetPath, e]));
  assert.equal(byTarget.get('a.md')?.classification, 'unchanged');
  assert.equal(byTarget.get('b.md')?.classification, 'overwrite');
  assert.equal(byTarget.get('c.md')?.classification, 'new');
  assert.deepEqual(plan.blockedOverwrites, ['b.md']);
  assert.deepEqual(plan.missingSource, []);
});

test('buildImportPlan reports missing declared source files and plans nothing for them', () => {
  const sourceRoot = makeImportSourceFixture({ 'a.md': 'alpha\n' });
  // Simulate a stale/shallow --source checkout missing a declared file.
  rmSync(join(sourceRoot, 'idd-template', 'a.md'));
  const plan = buildImportPlan(sourceRoot, makeFixtureDir());
  assert.deepEqual(plan.missingSource, ['idd-template/a.md']);
  assert.equal(plan.entries.length, 0);
});

test('buildImportPlan blocks a non-file target collision even with --force, and applyImportPlan never attempts it', () => {
  const sourceRoot = makeImportSourceFixture({ 'a.md': 'alpha\n' });
  const targetRoot = makeFixtureDir();
  // A directory already occupies the declared target path.
  mkdirSync(join(targetRoot, 'a.md'), { recursive: true });

  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'blocked-non-file');
  assert.deepEqual(plan.nonFileTargetCollisions, ['a.md']);
  assert.deepEqual(plan.blockedOverwrites, []);

  // --force overrides a differing *file*, but must not paper over a
  // fundamental type collision it cannot copyFileSync onto.
  const forcedPlan = buildImportPlan(sourceRoot, targetRoot, { force: true });
  assert.equal(forcedPlan.entries[0]?.classification, 'blocked-non-file');
  assert.deepEqual(forcedPlan.nonFileTargetCollisions, ['a.md']);

  // Even if a caller applied the plan without gating on the blocking
  // finding, applyImportPlan itself must never attempt the impossible
  // copy (which would throw EISDIR/ENOTDIR).
  assert.equal(applyImportPlan(sourceRoot, targetRoot, forcedPlan), 0);
  assert.ok(statSync(join(targetRoot, 'a.md')).isDirectory());
});

test('applyImportPlan copies new nested files byte-identically and preserves the source mode bit', () => {
  const sourceRoot = makeImportSourceFixture({
    'hooks/pre-commit': '#!/bin/sh\necho hook\n',
  });
  chmodSync(join(sourceRoot, 'idd-template', 'hooks', 'pre-commit'), 0o755);
  const targetRoot = makeFixtureDir();
  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'new');
  const filesChanged = applyImportPlan(sourceRoot, targetRoot, plan);
  assert.equal(filesChanged, 1);
  const targetHook = join(targetRoot, 'hooks', 'pre-commit');
  assert.equal(readFileSync(targetHook, 'utf8'), '#!/bin/sh\necho hook\n');
  // `chmodSync` on native Windows cannot set the granular POSIX mode this
  // fixture requests (`0o755`): it only toggles the read-only attribute, so
  // a "writable" request always collapses to `0o666` regardless of which
  // specific bits were asked for (see the root-cause note on the
  // `.githooks/pre-commit` copy test below, issue #2577). `applyImportPlan`
  // still preserves whatever `statSync(source).mode` actually is -- which
  // is the only thing this test can verify on this platform.
  const expectedMode =
    process.platform === 'win32'
      ? statSync(join(sourceRoot, 'idd-template', 'hooks', 'pre-commit')).mode &
        0o777
      : 0o755;
  assert.equal(statSync(targetHook).mode & 0o777, expectedMode);
});

test('applyImportPlan skips unchanged files without rewriting them', () => {
  const sourceRoot = makeImportSourceFixture({ 'a.md': 'same\n' });
  const targetRoot = makeFixtureDir();
  writeFileSync(join(targetRoot, 'a.md'), 'same\n');
  const plan = buildImportPlan(sourceRoot, targetRoot);
  assert.equal(plan.entries[0]?.classification, 'unchanged');
  assert.equal(applyImportPlan(sourceRoot, targetRoot, plan), 0);
});

test('applyImportPlan only overwrites a differing target when the plan was built with force', () => {
  const sourceRoot = makeImportSourceFixture({ 'a.md': 'new content\n' });
  const targetRoot = makeFixtureDir();
  writeFileSync(join(targetRoot, 'a.md'), 'old content\n');

  const forcedPlan = buildImportPlan(sourceRoot, targetRoot, { force: true });
  assert.deepEqual(forcedPlan.blockedOverwrites, []);
  assert.equal(forcedPlan.entries[0]?.classification, 'overwrite');
  assert.equal(applyImportPlan(sourceRoot, targetRoot, forcedPlan), 1);
  assert.equal(readFileSync(join(targetRoot, 'a.md'), 'utf8'), 'new content\n');
});

test('a real idd-skill source tree imports the full core file set byte-identically into an empty target', () => {
  const targetRoot = makeFixtureDir();
  const plan = buildImportPlan(REPO_ROOT, targetRoot);
  assert.deepEqual(plan.missingSource, []);
  assert.deepEqual(plan.blockedOverwrites, []);
  assert.ok(plan.entries.length > 0);
  assert.ok(plan.entries.every((entry) => entry.classification === 'new'));

  const filesChanged = applyImportPlan(REPO_ROOT, targetRoot, plan);
  assert.equal(filesChanged, plan.entries.length);
  for (const entry of plan.entries) {
    const sourceBytes = readFileSync(join(REPO_ROOT, entry.sourcePath));
    const targetBytes = readFileSync(join(targetRoot, entry.targetPath));
    assert.ok(
      sourceBytes.equals(targetBytes),
      `byte mismatch: ${entry.targetPath}`,
    );
  }
  // The pre-commit hook's executable bit must survive the copy -- but only
  // where the source checkout can carry that bit at all. On native Windows,
  // `fs.statSync().mode` never reports a POSIX execute bit for a git
  // checkout in the first place (NTFS has no such bit, and this repo's
  // common Windows git config `core.fileMode=false` means the index's
  // recorded 100755 mode is never applied on checkout either), so
  // `REPO_ROOT`'s own on-disk `.githooks/pre-commit` already has mode
  // 100666 before `applyImportPlan` ever runs -- there is nothing for
  // `chmodSync(target, statSync(source).mode)` to preserve, and asserting
  // `0o111` here would fail regardless of whether the copy step is correct
  // (issue #2577: this predictable Windows chmod/stat limitation, not a
  // bug in `applyImportPlan`, is what a prior investigation session
  // misdiagnosed as `applyImportPlan` returning 0 -- `0o111` in octal is
  // `73` decimal, matching this fixture's own entry count by coincidence,
  // which pointed the investigation at the wrong assertion).
  const hookMode = statSync(join(targetRoot, '.githooks', 'pre-commit')).mode;
  if (process.platform === 'win32') {
    // Compare against the source's own live execute bits (observed `0` on
    // this platform per the note above) rather than hardcoding `0`: the
    // actual contract under test is "target execute bits match source
    // execute bits", so this still catches a real regression even in an
    // unusual Windows environment that does surface exec bits (Copilot
    // review, PR #2583).
    const sourceMode = statSync(
      join(REPO_ROOT, '.githooks', 'pre-commit'),
    ).mode;
    assert.equal(hookMode & 0o111, sourceMode & 0o111);
    return;
  }
  assert.equal(hookMode & 0o111, 0o111);
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
    // #2216: every makeFixtureDir() root lives under the OS tmpdir, outside
    // this test process's own cwd (REPO_ROOT) -- widen the confined root so
    // existing fixture-based invocations keep working unchanged. A test
    // exercising the confinement rejection itself spawns the CLI directly,
    // bypassing this helper.
    const stdout = execFileSync(
      process.execPath,
      [BIN_PATH, ...args, '--allow-root', tmpdir()],
      {
        encoding: 'utf8',
      },
    );
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

test('bin/idd-onboard.mjs --substitute summary lists the skipped meta-doc paths', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  writeExcludedMetaDocs(root);
  const before = new Map(
    [...SCAN_EXCLUDED_PATHS].map((relativePath) => [
      relativePath,
      readFileSync(join(root, ...relativePath.split('/'))),
    ]),
  );
  const { status, verdict } = runCliBin([
    '--substitute',
    '--target',
    root,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(status, 0);
  assert.deepEqual(verdict.skippedPaths, [...SCAN_EXCLUDED_PATHS].sort());
  for (const [relativePath, original] of before) {
    assert.ok(
      original.equals(readFileSync(join(root, ...relativePath.split('/')))),
      `byte mismatch: ${relativePath}`,
    );
  }
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

test('bin/idd-onboard.mjs --import --dry-run prints the plan and writes nothing', () => {
  const targetRoot = makeFixtureDir();
  const before = snapshotTree(targetRoot);
  const { status, verdict } = runCliBin([
    '--import',
    '--dry-run',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.written, false);
  assert.ok(Array.isArray(verdict.plan) && verdict.plan.length > 0);
  assert.deepEqual(verdict.missingSource, []);
  assert.deepEqual(verdict.blockedOverwrites, []);
  assertTreeUnchanged(targetRoot, before);
});

test('bin/idd-onboard.mjs --import without --dry-run copies exactly the planned set', () => {
  const targetRoot = makeFixtureDir();
  const { status, verdict } = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.written, true);
  const plan = verdict.plan as { targetPath: string }[];
  assert.equal(verdict.filesChanged, plan.length);
  for (const entry of plan) {
    assert.ok(
      existsSync(join(targetRoot, entry.targetPath)),
      `not copied: ${entry.targetPath}`,
    );
  }
});

test('bin/idd-onboard.mjs --import blocks on a differing existing target file without --force', () => {
  const targetRoot = makeFixtureDir();
  mkdirSync(join(targetRoot, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(targetRoot, '.github', 'idd', 'config.json'),
    '{"stale": true}\n',
  );
  const before = snapshotTree(targetRoot);
  const { status, verdict } = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.written, false);
  assert.ok(
    (verdict.blockedOverwrites as string[]).includes('.github/idd/config.json'),
  );
  assertTreeUnchanged(targetRoot, before);
});

test('bin/idd-onboard.mjs --import blocks on a pre-existing, differing doc-lint config instead of silently replacing it (idd-skill#1860)', () => {
  const targetRoot = makeFixtureDir();
  // Simulate a target repository that already has its own documentation
  // lint configuration, differing from the template's copy.
  writeFileSync(
    join(targetRoot, '.cspell.config.yml'),
    'words:\n  - preexisting\n',
  );
  writeFileSync(join(targetRoot, '.markdownlint.yml'), 'default: false\n');
  writeFileSync(
    join(targetRoot, '.markdownlint-cli2.yaml'),
    'ignores:\n  - vendor/**\n',
  );
  const before = snapshotTree(targetRoot);

  const { status, verdict } = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.written, false);
  const blocked = verdict.blockedOverwrites as string[];
  for (const target of [
    '.cspell.config.yml',
    '.markdownlint.yml',
    '.markdownlint-cli2.yaml',
  ]) {
    assert.ok(
      blocked.includes(target),
      `expected ${target} to be reported as a blocked overwrite instead of silently replaced`,
    );
  }
  // The whole apply is fail-closed on any blocking finding (idd-onboard.mts
  // writes nothing when blockedOverwrites is non-empty), so the adopter's
  // pre-existing config is untouched, not just the 3 doc-lint files.
  assertTreeUnchanged(targetRoot, before);
});

test('bin/idd-onboard.mjs --import --force overwrites a differing existing target file', () => {
  const targetRoot = makeFixtureDir();
  mkdirSync(join(targetRoot, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(targetRoot, '.github', 'idd', 'config.json'),
    '{"stale": true}\n',
  );
  const { status, verdict } = runCliBin([
    '--import',
    '--force',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.written, true);
  assert.equal(
    readFileSync(join(targetRoot, '.github', 'idd', 'config.json'), 'utf8'),
    readFileSync(
      join(REPO_ROOT, 'idd-template', '.github', 'idd', 'config.json'),
      'utf8',
    ),
  );
});

test('bin/idd-onboard.mjs --import --force preserves a customized commands table across a real re-import (#2222)', () => {
  // Reproduces the actual re-import workflow end to end: fresh import,
  // substitute with customized validate commands, then re-import with
  // --force (the only way a real re-import can proceed once any template
  // file differs) must not silently discard those customized rows even
  // though --import always copies .github/idd/config.json byte-for-byte
  // from source.
  const targetRoot = makeFixtureDir();
  execFileSync(process.execPath, [
    BIN_PATH,
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--allow-root',
    tmpdir(),
  ]);
  execFileSync(process.execPath, [
    BIN_PATH,
    '--substitute',
    '--target',
    targetRoot,
    '--repo-name',
    'my-app',
    '--marker-prefix',
    'my-app',
    '--trusted-marker-actor',
    'trusted-user-a',
    '--fix-validate-commands',
    'npx biome check --write (customized)',
    '--pre-push-validate-commands',
    'npx biome check (customized)',
    '--post-fix-validate-commands',
    'npx biome check --write (customized)',
    '--install-deps-command',
    'npm install',
    '--allow-root',
    tmpdir(),
  ]);

  const { status, verdict } = runCliBin([
    '--import',
    '--force',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.written, true);

  const config = JSON.parse(
    readFileSync(join(targetRoot, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  // The three validate-command rows survive the re-import unchanged...
  assert.equal(
    config.commands['fix-validate'],
    'npx biome check --write (customized)',
  );
  assert.equal(
    config.commands['pre-push-validate'],
    'npx biome check (customized)',
  );
  assert.equal(
    config.commands['post-fix-validate'],
    'npx biome check --write (customized)',
  );
  // ...while install-deps (out of #2222's scope) reverts to the raw
  // template placeholder token exactly like every other re-imported file,
  // ready for the next --substitute to re-resolve it normally.
  assert.equal(config.commands['install-deps'], '{{INSTALL_DEPS_COMMAND}}');

  // A follow-up --substitute converges cleanly: install-deps takes its new
  // override, and the three preserved rows need no override at all.
  const followUp = runCliBin([
    '--substitute',
    '--target',
    targetRoot,
    '--repo-name',
    'my-app',
    '--marker-prefix',
    'my-app',
    '--trusted-marker-actor',
    'trusted-user-a',
    '--install-deps-command',
    'npm ci',
  ]);
  assert.equal(followUp.status, 0);
  assert.deepEqual(followUp.verdict.residue, []);
  const finalConfig = JSON.parse(
    readFileSync(join(targetRoot, '.github', 'idd', 'config.json'), 'utf8'),
  ) as { commands: Record<string, string> };
  assert.equal(finalConfig.commands['install-deps'], 'npm ci');
  assert.equal(
    finalConfig.commands['fix-validate'],
    'npx biome check --write (customized)',
  );
});

test('bin/idd-onboard.mjs --import blocks a non-file target collision even with --force', () => {
  const targetRoot = makeFixtureDir();
  // A directory occupies a declared core-file target path.
  mkdirSync(join(targetRoot, '.github', 'idd', 'config.json'), {
    recursive: true,
  });
  const before = snapshotTree(targetRoot);
  const { status, verdict } = runCliBin([
    '--import',
    '--force',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.written, false);
  assert.ok(
    (verdict.nonFileTargetCollisions as string[]).includes(
      '.github/idd/config.json',
    ),
  );
  assertTreeUnchanged(targetRoot, before);
  // The directory itself must survive untouched (not replaced by a file).
  assert.ok(
    statSync(join(targetRoot, '.github', 'idd', 'config.json')).isDirectory(),
  );
});

test('bin/idd-onboard.mjs --import exits 2 when --source is missing', () => {
  const targetRoot = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--import', '--target', targetRoot],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /--source/);
  }
});

test('bin/idd-onboard.mjs exits 2 when both --substitute and --import are passed', () => {
  const targetRoot = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--substitute', '--import', '--target', targetRoot],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /mutually exclusive/);
  }
});

test('bin/idd-onboard.mjs --help lists --profile values sourced from PROFILE_NAMES, not a second hardcoded list', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  for (const profile of PROFILE_NAMES) {
    assert.ok(help.includes(profile), `--help is missing profile: ${profile}`);
  }
});

test('bin/idd-onboard.mjs exits 2 when --import is combined with a substitute-only placeholder override', () => {
  const targetRoot = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [
        BIN_PATH,
        '--import',
        '--source',
        REPO_ROOT,
        '--target',
        targetRoot,
        '--repo-name',
        'my-app',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /substitute-only flag/);
    assert.match(String(failed.stderr), /--repo-name/);
  }
});

test('bin/idd-onboard.mjs exits 2 when --substitute is combined with an import-only flag', () => {
  const targetRoot = makeFixtureDir();
  writeTemplateFixture(targetRoot);
  try {
    execFileSync(
      process.execPath,
      [
        BIN_PATH,
        '--substitute',
        '--target',
        targetRoot,
        '--force',
        ...CLI_OVERRIDE_FLAGS,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /import-only flag/);
    assert.match(String(failed.stderr), /--force/);
  }
});

// ---------------------------------------------------------------------------
// Wave 3: --verify (post-import verification, reusing doctor drift checks)
// ---------------------------------------------------------------------------

/**
 * Import the real core file set from REPO_ROOT into `targetRoot`, then
 * substitute every placeholder with `ALL_OVERRIDES`, producing a target
 * tree that should pass `--verify` cleanly (the same two-stage flow
 * `idd-template/ONBOARDING.md` documents).
 */
function importAndSubstitute(targetRoot: string): void {
  const importPlan = buildImportPlan(REPO_ROOT, targetRoot);
  applyImportPlan(REPO_ROOT, targetRoot, importPlan);
  const resolution = resolvePlaceholderValues(targetRoot, ALL_OVERRIDES);
  const subPlan = buildSubstitutionPlan(
    scanPlaceholderTokens(targetRoot),
    resolution,
  );
  applySubstitutionPlan(targetRoot, subPlan);
}

test('checkManifestCompleteness reports no gap for a fully imported target', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const result = checkManifestCompleteness(REPO_ROOT, targetRoot);
  assert.deepEqual(result.missingSource, []);
  assert.deepEqual(result.missingTarget, []);
});

test('checkManifestCompleteness reports a deleted manifest file as missingTarget', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  rmSync(
    join(targetRoot, '.github', 'instructions', 'idd-work.instructions.md'),
  );
  const result = checkManifestCompleteness(REPO_ROOT, targetRoot);
  assert.deepEqual(result.missingSource, []);
  assert.ok(
    result.missingTarget.includes(
      '.github/instructions/idd-work.instructions.md',
    ),
  );
});

test('checkManifestCompleteness reports a manifest file missing from a corrupt --source tree', () => {
  // A `--source` idd-skill tree that is itself incomplete: resolveImportFiles's
  // own missingSource only ever surfaces a vendored-node bundle resolution
  // failure, so this must check every declared sourcePath directly against
  // sourceRoot (the same fileExists check buildImportPlan already performs)
  // rather than trusting resolveImportFiles's missingSource alone. Build a
  // minimal source tree (the manifest plus every declared file, not a full
  // repo copy) so the test stays fast.
  const corruptSourceRoot = makeFixtureDir();
  mkdirSync(join(corruptSourceRoot, 'audit'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'audit', 'sync-manifest.json'),
    join(corruptSourceRoot, 'audit', 'sync-manifest.json'),
  );
  const resolved = resolveImportFiles(REPO_ROOT);
  for (const file of resolved.files) {
    const dest = join(corruptSourceRoot, file.sourcePath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO_ROOT, file.sourcePath), dest);
  }
  const missingFile = resolved.files[0];
  assert.ok(missingFile, 'resolveImportFiles must declare at least one file');
  rmSync(join(corruptSourceRoot, missingFile.sourcePath));

  const targetRoot = makeFixtureDir();
  const result = checkManifestCompleteness(corruptSourceRoot, targetRoot);
  assert.ok(result.missingSource.includes(missingFile.sourcePath));
});

test('checkManifestCompleteness checks every file resolveImportFiles declares, not a forked subset', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const resolved = resolveImportFiles(REPO_ROOT);
  // Delete every declared file's target one at a time is too slow; instead
  // assert the check surfaces a real declared file as missing (proving it
  // is drawn from the same list resolveImportFiles produces, not a second,
  // possibly incomplete, hardcoded one).
  const sample = resolved.files[0];
  assert.ok(sample, 'resolveImportFiles must declare at least one file');
  rmSync(join(targetRoot, sample.targetPath));
  const result = checkManifestCompleteness(REPO_ROOT, targetRoot);
  assert.ok(result.missingTarget.includes(sample.targetPath));
});

test('checkManifestCompleteness forwards --profile to resolveImportFiles, covering the larger vendored-node file set', () => {
  const targetRoot = makeFixtureDir();
  const importPlan = buildImportPlan(REPO_ROOT, targetRoot, {
    profile: 'vendored-node',
  });
  applyImportPlan(REPO_ROOT, targetRoot, importPlan);
  const resolution = resolvePlaceholderValues(targetRoot, ALL_OVERRIDES);
  const subPlan = buildSubstitutionPlan(
    scanPlaceholderTokens(targetRoot),
    resolution,
  );
  applySubstitutionPlan(targetRoot, subPlan);

  const defaultFileCount = resolveImportFiles(REPO_ROOT).files.length;
  const vendoredFileCount = resolveImportFiles(REPO_ROOT, 'vendored-node').files
    .length;
  assert.ok(
    vendoredFileCount > defaultFileCount,
    'the vendored-node profile must declare more files than the default profile',
  );

  // Passing the same --profile the target was actually imported with must
  // check the larger declared set, not silently fall back to the default.
  const result = checkManifestCompleteness(
    REPO_ROOT,
    targetRoot,
    'vendored-node',
  );
  assert.deepEqual(result.missingTarget, []);
});

test('checkPlaceholderResidue classifies a leftover onboarding placeholder as blocking residue', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  writeFileSync(
    join(targetRoot, 'LEFTOVER.md'),
    '{{REPO_NAME}} and {{SOME_ADOPTER_TOKEN}} remain\n',
  );
  const result = checkPlaceholderResidue(targetRoot);
  assert.ok(
    result.residue.some(
      (entry) =>
        entry.file === 'LEFTOVER.md' && entry.token === '{{REPO_NAME}}',
    ),
  );
  assert.ok(
    result.unknownTokens.some(
      (entry) =>
        entry.file === 'LEFTOVER.md' &&
        entry.token === '{{SOME_ADOPTER_TOKEN}}',
    ),
  );
});

test('checkPlaceholderResidue reports nothing for a fully substituted target', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const result = checkPlaceholderResidue(targetRoot);
  assert.deepEqual(result.residue, []);
});

test('#1924 regression: importing the real template keeps the meta-docs literal', () => {
  // The three real idd-template/docs meta-docs carry live {{TOKEN}}
  // worked examples today (the field-reported corruption source), so this
  // exercises the actual distributed files rather than a synthetic
  // fixture.
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  for (const relativePath of SCAN_EXCLUDED_PATHS) {
    const sourceBytes = readFileSync(
      join(REPO_ROOT, 'idd-template', ...relativePath.split('/')),
    );
    const targetBytes = readFileSync(
      join(targetRoot, ...relativePath.split('/')),
    );
    assert.ok(
      sourceBytes.equals(targetBytes),
      `byte mismatch after import+substitute: ${relativePath}`,
    );
  }
  // --verify's residue check must not read their surviving tokens as
  // unresolved placeholders.
  const result = checkPlaceholderResidue(targetRoot);
  assert.deepEqual(result.residue, []);
});

test('checkStaleImportSignal reuses idd-doctor findMissingWorktreeHardening and reports nothing for an up-to-date import', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const result = checkStaleImportSignal(targetRoot);
  assert.deepEqual(result.missing, []);
});

test('checkStaleImportSignal reports a missing B1 self-check section', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const workPath = join(
    targetRoot,
    '.github',
    'instructions',
    'idd-work.instructions.md',
  );
  const withoutSelfCheck = readFileSync(workPath, 'utf8').replace(
    /^### B1 self-check\b[\s\S]*?(?=\n## )/m,
    '',
  );
  assert.notEqual(withoutSelfCheck, readFileSync(workPath, 'utf8'));
  writeFileSync(workPath, withoutSelfCheck);
  const result = checkStaleImportSignal(targetRoot);
  assert.ok(
    result.missing.includes('idd-work B1 self-check section'),
    `expected the missing self-check section to be reported, got: ${JSON.stringify(result.missing)}`,
  );
});

test('runVerify never lets the stale-import signal contribute to blocking', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const workPath = join(
    targetRoot,
    '.github',
    'instructions',
    'idd-work.instructions.md',
  );
  writeFileSync(workPath, 'stale content with no recognized sections\n');
  const result = runVerify(REPO_ROOT, targetRoot);
  assert.ok(result.staleImportSignal.missing.length > 0);
  assert.equal(result.blocking, false);
});

test('runVerify blocks when manifest completeness or placeholder residue fails', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  rmSync(join(targetRoot, '.github', 'idd', 'config.json'));
  const missingManifestFile = runVerify(REPO_ROOT, targetRoot);
  assert.equal(missingManifestFile.blocking, true);

  const residueRoot = makeFixtureDir();
  importAndSubstitute(residueRoot);
  writeFileSync(join(residueRoot, 'LEFTOVER.md'), '{{REPO_NAME}}\n');
  const residueResult = runVerify(REPO_ROOT, residueRoot);
  assert.equal(residueResult.blocking, true);
});

// ---------------------------------------------------------------------------
// CLI (acceptance criteria) — --verify
// ---------------------------------------------------------------------------

test('bin/idd-onboard.mjs --verify exits 0 with no blocking finding for a fully onboarded target', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  const { status, verdict } = runCliBin([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'verify');
  assert.equal(verdict.blocking, false);
  assert.deepEqual(
    (verdict.manifestCompleteness as { missingTarget: string[] }).missingTarget,
    [],
  );
  assert.deepEqual(
    (verdict.placeholderResidue as { residue: unknown[] }).residue,
    [],
  );
});

test('bin/idd-onboard.mjs --verify exits 1 and names the missing file when the manifest is incomplete', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  rmSync(join(targetRoot, '.github', 'idd', 'config.json'));
  const { status, verdict } = runCliBin([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.blocking, true);
  assert.ok(
    (
      verdict.manifestCompleteness as { missingTarget: string[] }
    ).missingTarget.includes('.github/idd/config.json'),
  );
});

test('bin/idd-onboard.mjs --verify exits 1 and names the file when an onboarding placeholder is unresolved', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  writeFileSync(join(targetRoot, 'LEFTOVER.md'), '{{REPO_NAME}}\n');
  const { status, verdict } = runCliBin([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.blocking, true);
  const residue = (
    verdict.placeholderResidue as { residue: { file: string }[] }
  ).residue;
  assert.ok(residue.some((entry) => entry.file === 'LEFTOVER.md'));
});

test('bin/idd-onboard.mjs --verify exits 0 even when the stale-import signal fires (informational only)', () => {
  const targetRoot = makeFixtureDir();
  importAndSubstitute(targetRoot);
  writeFileSync(
    join(targetRoot, '.github', 'instructions', 'idd-work.instructions.md'),
    'stale content with no recognized sections\n',
  );
  const { status, verdict } = runCliBin([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.blocking, false);
  assert.ok(
    (verdict.staleImportSignal as { missing: string[] }).missing.length > 0,
  );
});

test('bin/idd-onboard.mjs --verify exits 2 when --source is missing', () => {
  const targetRoot = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--verify', '--target', targetRoot],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /--source/);
  }
});

test('bin/idd-onboard.mjs --verify --profile vendored-node passes for a target imported with that profile', () => {
  const targetRoot = makeFixtureDir();
  const { status: importStatus } = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(importStatus, 0);
  runCliBin(['--substitute', '--target', targetRoot, ...CLI_OVERRIDE_FLAGS]);

  const { status, verdict } = runCliBin([
    '--verify',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
    '--profile',
    'vendored-node',
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.blocking, false);
});

test('bin/idd-onboard.mjs --verify exits 2 on an unknown --profile value', () => {
  const targetRoot = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [
        BIN_PATH,
        '--verify',
        '--source',
        REPO_ROOT,
        '--target',
        targetRoot,
        '--profile',
        'not-a-real-profile',
        '--allow-root',
        tmpdir(),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /unknown --profile/);
  }
});

test('bin/idd-onboard.mjs exits 2 when --verify is combined with --import or --substitute', () => {
  const targetRoot = makeFixtureDir();
  const combos = [
    ['--verify', '--import', '--source', REPO_ROOT, '--target', targetRoot],
    ['--verify', '--substitute', '--target', targetRoot],
  ];
  for (const args of combos) {
    try {
      execFileSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail(`expected a non-zero exit for ${args.join(' ')}`);
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      assert.equal(failed.status, 2);
      assert.match(String(failed.stderr), /mutually exclusive/);
    }
  }
});

test('bin/idd-onboard.mjs --verify exits 2 when combined with --force or --dry-run', () => {
  const targetRoot = makeFixtureDir();
  for (const foreignFlag of ['--force', '--dry-run']) {
    try {
      execFileSync(
        process.execPath,
        [
          BIN_PATH,
          '--verify',
          '--source',
          REPO_ROOT,
          '--target',
          targetRoot,
          foreignFlag,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.fail(`expected a non-zero exit for ${foreignFlag}`);
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      assert.equal(failed.status, 2);
      assert.match(String(failed.stderr), /does not accept flag\(s\)/);
      assert.match(String(failed.stderr), new RegExp(`\\${foreignFlag}`));
    }
  }
});

test('bin/idd-onboard.mjs --help documents --verify and lists --profile values sourced from PROFILE_NAMES', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /--verify/);
  assert.match(help, /manifestCompleteness/);
  assert.match(help, /placeholderResidue/);
  assert.match(help, /staleImportSignal/);
});

// ---------------------------------------------------------------------------
// --hear (#2281)
// ---------------------------------------------------------------------------

/** A target tree with the evidence deriveInstallDepsCommand / a git remote need. */
function writeHearFixture(root: string): void {
  execFileSync('git', ['init', '--initial-branch=main', root], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-C',
      root,
      'remote',
      'add',
      'origin',
      'git@github.com:trusted-user-a/hear-fixture.git',
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(
    join(root, 'package.json'),
    '{"packageManager":"pnpm@9.0.0"}\n',
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
}

/** One valid, complete answers map: documented default per option-bearing item, a fixture value otherwise. */
function buildValidHearAnswers(): Record<string, string> {
  const catalog = loadOnboardingHearingCatalog();
  const answers: Record<string, string> = {};
  for (const item of catalog.items) {
    if (item.kind === 'check') {
      continue;
    }
    const documentedDefault = item.options?.find(
      (option) => option.isDefault,
    )?.value;
    answers[item.id] = documentedDefault ?? `fixture-${item.id}`;
  }
  return answers;
}

test('bin/idd-onboard.mjs --hear --propose lists every catalog item id, derives PROJECT_MARKER_PREFIX and the install-deps candidate, and reports helper-runtime evidence', () => {
  const root = makeFixtureDir();
  writeHearFixture(root);
  const { status, verdict } = runCliBin([
    '--hear',
    '--propose',
    '--target',
    root,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'propose');
  const catalog = loadOnboardingHearingCatalog();
  const items = verdict.items as {
    id: string;
    derived: string | null;
  }[];
  assert.deepEqual(
    items.map((item) => item.id).sort(),
    catalog.items.map((item) => item.id).sort(),
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get('PROJECT_MARKER_PREFIX')?.derived, 'hear-fixture');
  assert.equal(byId.get('INSTALL_DEPS_COMMAND')?.derived, 'pnpm install');
  assert.ok(verdict.helperRuntimeEvidence);
  assert.equal(
    (verdict.helperRuntimeEvidence as { detectedPackageManager: string })
      .detectedPackageManager,
    'pnpm',
  );
  assert.ok(verdict.stepZeroEvidence);
});

test('bin/idd-onboard.mjs --hear --apply confirms a complete, valid answers map into a schema-valid transcript', () => {
  const root = makeFixtureDir();
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(buildValidHearAnswers()));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(status, 0);
  // The success output IS the transcript document -- no wrapper --
  // matching the interactive --hear wizard's own output.
  const transcript = verdict as unknown as {
    answers: { id: string; value: string }[];
  };
  const schema = loadJson('schemas/onboarding-hearing-transcript.schema.json');
  assert.deepEqual(validate(transcript, schema), []);
  const catalog = loadOnboardingHearingCatalog();
  const answerableIds = catalog.items
    .filter((item) => item.kind !== 'check')
    .map((item) => item.id)
    .sort();
  assert.deepEqual(
    transcript.answers.map((answer) => answer.id).sort(),
    answerableIds,
  );
});

test('bin/idd-onboard.mjs --hear --apply exits 1 and names a missing answerable id, writing nothing', () => {
  const root = makeFixtureDir();
  const answers = buildValidHearAnswers();
  delete answers['merge-policy'];
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.valid, false);
  assert.ok((verdict.unresolved as string[]).includes('merge-policy'));
});

test('bin/idd-onboard.mjs --hear --apply exits 1 on an unknown answer key', () => {
  const root = makeFixtureDir();
  const answers = buildValidHearAnswers();
  answers['not-a-real-catalog-id'] = 'x';
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(status, 1);
  assert.ok((verdict.unresolved as string[]).includes('not-a-real-catalog-id'));
});

test('bin/idd-onboard.mjs --hear --apply exits 1 when a value is outside the item enum', () => {
  const root = makeFixtureDir();
  const answers = buildValidHearAnswers();
  answers['merge-policy'] = 'not-a-real-option';
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(status, 1);
  assert.ok((verdict.unresolved as string[]).includes('merge-policy'));
});

test('bin/idd-onboard.mjs --hear --apply trims a whitespace-only answer, same as the TTY wizard, so it fails validation rather than passing as a real value', () => {
  const root = makeFixtureDir();
  const answers = buildValidHearAnswers();
  answers.TRUSTED_MARKER_ACTOR = '   ';
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(status, 1);
  assert.ok((verdict.unresolved as string[]).includes('TRUSTED_MARKER_ACTOR'));
});

test("bin/idd-onboard.mjs --hear rejects import/substitute-only flags (--source, --force, --profile, a placeholder override), matching the other stages' own foreign-flag guards", () => {
  const root = makeFixtureDir();
  for (const foreignArgs of [
    ['--source', root],
    ['--force'],
    ['--profile', 'package-manager'],
    ['--repo-name', 'x'],
  ]) {
    try {
      execFileSync(
        process.execPath,
        [BIN_PATH, '--hear', '--propose', '--target', root, ...foreignArgs],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.fail(`expected a non-zero exit for --hear + ${foreignArgs[0]}`);
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      assert.equal(failed.status, 2);
      assert.match(String(failed.stderr), /does not accept/);
    }
  }
});

test('bin/idd-onboard.mjs rejects --hear-only flags (--propose, --apply, --answers) when --hear is not selected', () => {
  const root = makeFixtureDir();
  for (const [stage, extra] of [
    ['--substitute', ['--propose']],
    ['--import', ['--apply']],
    ['--verify', ['--answers', 'answers.json']],
  ] as const) {
    try {
      execFileSync(
        process.execPath,
        [BIN_PATH, stage, '--target', root, ...extra],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.fail(`expected a non-zero exit for ${stage} + ${extra[0]}`);
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      assert.equal(failed.status, 2);
      assert.match(String(failed.stderr), /does not accept/);
    }
  }
});

test('bin/idd-onboard.mjs --hear exits 2 in a non-TTY context, without --propose or --apply', () => {
  const root = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--hear', '--target', root, '--allow-root', tmpdir()],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(String(failed.stderr), /interactive TTY/);
  }
});

test('bin/idd-onboard.mjs exits 2 when --hear is combined with --import, --substitute, or --verify', () => {
  for (const other of ['--import', '--substitute', '--verify']) {
    try {
      execFileSync(
        process.execPath,
        [BIN_PATH, '--hear', '--propose', other, '--target', makeFixtureDir()],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.fail(`expected a non-zero exit for --hear + ${other}`);
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      assert.equal(failed.status, 2);
      assert.match(String(failed.stderr), /mutually exclusive/);
    }
  }
});

test('bin/idd-onboard.mjs --help documents --hear, --propose, --apply, and --answers', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /--hear/);
  assert.match(help, /--propose/);
  assert.match(help, /--apply/);
  assert.match(help, /--answers/);
});

test('runHearWizard rejects a non-TTY context with HEAR_NON_TTY_ERROR', async () => {
  const root = makeFixtureDir();
  const catalog = loadOnboardingHearingCatalog();
  await assert.rejects(
    runHearWizard(catalog, root, { isTTY: false }),
    new RegExp(HEAR_NON_TTY_ERROR.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
  );
});

test('runHearWizard shows each explanation, confirms the shown default on empty input, and produces a schema-valid transcript', async () => {
  const root = makeFixtureDir();
  writeHearFixture(root);
  const catalog = loadOnboardingHearingCatalog();
  const noDefaultAnswers: Record<string, string> = {
    TRUSTED_MARKER_ACTOR: 'trusted-user-a',
    'credential-scope': 'repository-scoped-pat',
  };
  const seenQuestions: string[] = [];
  const prompt: PromptFn = async (question: string) => {
    seenQuestions.push(question);
    // A shown "[default]" suffix confirms via empty input; an item with
    // no default (no derivation and no documented default -- currently
    // TRUSTED_MARKER_ACTOR and credential-scope, plus the three command
    // placeholders when this fixture's package.json declares no
    // lint/build/test scripts) needs an explicit fallback so this mock
    // always terminates within runHearWizard's bounded retry.
    const hasShownDefault = / \[/.test(question);
    if (hasShownDefault) {
      return '';
    }
    const id = question.split(/ \[|: /)[0] ?? '';
    return noDefaultAnswers[id] ?? `fixture-${id}`;
  };
  const stdoutChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let answers: Awaited<ReturnType<typeof runHearWizard>>;
  try {
    answers = await runHearWizard(catalog, root, { isTTY: true, prompt });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  const answerableIds = catalog.items
    .filter((item) => item.kind !== 'check')
    .map((item) => item.id)
    .sort();
  assert.deepEqual(answers.map((answer) => answer.id).sort(), answerableIds);
  assert.equal(seenQuestions.length, answerableIds.length);
  // Every answerable item's explanation (not just its terse prompt) was
  // actually printed to stdout, not merely relied on inside the mock.
  const mergePolicyItem = catalog.items.find(
    (item) => item.id === 'merge-policy',
  );
  assert.ok(mergePolicyItem);
  assert.ok(
    stdoutChunks.some((chunk) => chunk.includes(mergePolicyItem.explanation)),
    'expected the merge-policy explanation to be printed to stdout',
  );
  // merge-policy has no derivation hook, so empty input confirms its
  // documented default.
  assert.equal(
    answers.find((answer) => answer.id === 'merge-policy')?.value,
    'human_merge',
  );
  // PROJECT_MARKER_PREFIX has no documented default but does derive from
  // the fixture's git remote, so empty input confirms that instead.
  assert.equal(
    answers.find((answer) => answer.id === 'PROJECT_MARKER_PREFIX')?.value,
    'hear-fixture',
  );
  const transcript = {
    version: '1.0.0',
    confirmedAt: new Date().toISOString(),
    answers,
  };
  const schema = loadJson('schemas/onboarding-hearing-transcript.schema.json');
  assert.deepEqual(validate(transcript, schema), []);
});

// ---------------------------------------------------------------------------
// #2271: developmentBranch onboarding hearing item
// ---------------------------------------------------------------------------

test('deriveDevelopmentBranchCandidate returns the injected default-branch reader value, or null when undetermined', () => {
  assert.equal(
    deriveDevelopmentBranchCandidate('/unused', {
      readDefaultBranch: () => 'develop',
    }),
    'develop',
  );
  assert.equal(
    deriveDevelopmentBranchCandidate('/unused', {
      readDefaultBranch: () => null,
    }),
    null,
  );
  // No injected reader and no real `gh` evidence for this bogus path:
  // falls back to the real readGithubDefaultBranch, which fails closed to
  // null rather than throwing.
  assert.equal(
    deriveDevelopmentBranchCandidate(
      join(tmpdir(), 'idd-onboard-nonexistent-path'),
    ),
    null,
  );
});

/** A git repo with a local `origin` remote whose only branch is `main`. */
function makeGitRemoteFixture(): { root: string; remoteRoot: string } {
  const remoteRoot = trackedMkdtemp('idd-onboard-remote-');
  execFileSync('git', ['init', '--initial-branch=main', remoteRoot], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    ['-C', remoteRoot, 'config', 'user.email', 'fixture@example.com'],
    { stdio: 'ignore' },
  );
  execFileSync('git', ['-C', remoteRoot, 'config', 'user.name', 'Fixture'], {
    stdio: 'ignore',
  });
  writeFileSync(join(remoteRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', remoteRoot, 'add', 'README.md'], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    ['-C', remoteRoot, 'commit', '--no-gpg-sign', '-m', 'fixture'],
    { stdio: 'ignore' },
  );
  const root = makeFixtureDir();
  execFileSync('git', ['init', '--initial-branch=main', root], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remoteRoot], {
    stdio: 'ignore',
  });
  return { root, remoteRoot };
}

test('checkGitRemoteBranchExists is true for a branch present on origin, false otherwise -- purely local, no credentials', () => {
  const { root } = makeGitRemoteFixture();
  assert.equal(checkGitRemoteBranchExists(root, 'main'), true);
  assert.equal(checkGitRemoteBranchExists(root, 'no-such-branch'), false);
});

test("runHearWizard offers the injected default-branch candidate as development-branch's effective default", async () => {
  const root = makeFixtureDir();
  writeHearFixture(root);
  const catalog = loadOnboardingHearingCatalog();
  const prompt: PromptFn = async (question: string) => {
    if (question.startsWith('development-branch')) {
      // Confirm the shown default via empty input, same convention as the
      // broader wizard test above.
      assert.match(question, /\[develop\]/);
      return '';
    }
    const hasShownDefault = / \[/.test(question);
    if (hasShownDefault) {
      return '';
    }
    const id = question.split(/ \[|: /)[0] ?? '';
    return id === 'TRUSTED_MARKER_ACTOR'
      ? 'trusted-user-a'
      : id === 'credential-scope'
        ? 'repository-scoped-pat'
        : `fixture-${id}`;
  };
  const answers = await runHearWizard(catalog, root, {
    isTTY: true,
    prompt,
    readers: { readDefaultBranch: () => 'develop' },
  });
  assert.equal(
    answers.find((answer) => answer.id === 'development-branch')?.value,
    'develop',
  );
});

test('bin/idd-onboard.mjs --record-policy exits 1 and writes nothing when developmentBranch names a branch absent from origin (#2271)', () => {
  const { root } = makeGitRemoteFixture();
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
  const answers = buildValidHearAnswers();
  answers['development-branch'] = 'no-such-branch';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.valid, false);
  assert.ok(
    (verdict.unresolved as string[]).some((message) =>
      message.includes('no-such-branch'),
    ),
  );
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal('developmentBranch' in config, false);
});

test('bin/idd-onboard.mjs --record-policy exits 1 on a malformed developmentBranch before ever checking the remote (#2271 review)', () => {
  const { root } = makeGitRemoteFixture();
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
  // Non-empty (passes --hear --apply's generic non-empty check) but
  // contains whitespace, so only inspectDevelopmentBranch's stricter
  // shape check rejects it -- a hand-edited-transcript scenario.
  const answers = buildValidHearAnswers();
  answers['development-branch'] = 'my branch';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.valid, false);
  assert.ok(
    (verdict.unresolved as string[]).some(
      (message) =>
        message.includes('development-branch') &&
        message.includes('letters, digits') &&
        !message.includes('not found on the configured origin remote'),
    ),
    `expected a shape-validation message, got: ${JSON.stringify(verdict.unresolved)}`,
  );
});

test('runRecordPolicyCli uses the injected readRemoteBranchExists reader instead of a real git ls-remote (#2271 review)', () => {
  const root = makeFixtureDir();
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    '{"markerPrefix":"m","trustedMarkerActors":[],"commands":{"install-deps":"x","fix-validate":"x","pre-push-validate":"x","post-fix-validate":"x"}}\n',
  );
  const answers = buildValidHearAnswers();
  answers['development-branch'] = 'develop';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  let calledWith: [string, string] | null = null;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  try {
    runRecordPolicyCli(
      {
        substitute: false,
        importMode: false,
        verify: false,
        hear: false,
        recordPolicy: true,
        propose: false,
        apply: true,
        answers: undefined,
        fromTranscript: undefined,
        transcript: transcriptPath,
        writePolicyDoc: undefined,
        source: undefined,
        target: root,
        dryRun: false,
        force: false,
        profile: undefined,
        overrides: {},
        help: false,
        allowRoots: [tmpdir()],
      },
      {
        readRemoteBranchExists: (targetDir, branch) => {
          calledWith = [targetDir, branch];
          return true;
        },
      },
    );
  } catch (error) {
    assert.match(String(error), /process\.exit\(0\)/);
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(calledWith, [root, 'develop']);
  const verdict = JSON.parse(chunks.join('')) as Record<string, unknown>;
  assert.equal(verdict.written, true);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(config.developmentBranch, 'develop');
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

// ---------------------------------------------------------------------------
// #1294: ONBOARDING.md "CLI-assisted onboarding" section drift guard
// ---------------------------------------------------------------------------
//
// The section documents idd-onboard as the automated alternative for Steps
// 2, 4, and 6. Two mechanical properties must hold so the doc cannot drift
// from the shipped CLI: every flag it mentions must actually exist in the
// CLI's own --help surface, and its description of what --import copies
// must anchor to the shared idd-template-core-files generated block
// (Step 2's own file list) rather than hand-copying a second file list.

const CLI_SECTION_HEADING = '## CLI-assisted onboarding';

/** Slice out the named section: from its heading up to the next `## `. */
function extractSection(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `ONBOARDING.md is missing heading: ${heading}`);
  const nextHeading = doc.indexOf('\n## ', start + heading.length);
  return nextHeading === -1 ? doc.slice(start) : doc.slice(start, nextHeading);
}

/** Every long-form `--flag` token in `text`, deduped, in first-seen order. */
function extractFlagTokens(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/gu) ?? [])];
}

/**
 * Assert every flag token in `section` appears in `helpText`. Shared by the
 * real-section pass test and the seeded-mismatch fail test below so both
 * exercise the identical guard logic.
 */
function assertFlagsDocumentedInHelp(section: string, helpText: string): void {
  for (const flag of extractFlagTokens(section)) {
    assert.ok(
      helpText.includes(flag),
      `ONBOARDING.md's CLI-assisted onboarding section documents ${flag}, which idd-onboard --help does not list`,
    );
  }
}

/**
 * The stage-selector and shared-argument flags every mode of the section
 * discusses. Used as the "guard is not vacuous" sanity check below: rather
 * than an arbitrary flag-count threshold (which would make the guard fragile
 * to a legitimate future simplification of the section's prose), assert the
 * section still names the specific flags the guard exists to keep honest.
 */
const CLI_SECTION_CORE_FLAGS = [
  '--import',
  '--substitute',
  '--verify',
  '--hear',
  '--record-policy',
  '--source',
  '--target',
  '--profile',
  '--dry-run',
  '--force',
];

test('the ONBOARDING.md CLI-assisted onboarding section documents only flags idd-onboard --help actually lists', () => {
  const doc = readFileSync(ONBOARDING_DOC, 'utf8');
  const section = extractSection(doc, CLI_SECTION_HEADING);
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  // Sanity check: the section still names the core stage/argument flags it
  // exists to document, so this guard is not vacuously satisfied by an
  // empty or flag-free section.
  const documented = extractFlagTokens(section);
  for (const flag of CLI_SECTION_CORE_FLAGS) {
    assert.ok(
      documented.includes(flag),
      `expected the CLI-assisted onboarding section to document ${flag}`,
    );
  }
  assertFlagsDocumentedInHelp(section, help);
});

test('a seeded unknown flag in the CLI-assisted onboarding section is caught by the drift guard', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  const seededSection = `${CLI_SECTION_HEADING}\n\nRun \`idd-onboard --nonexistent-flag\`.\n`;
  assert.throws(
    () => assertFlagsDocumentedInHelp(seededSection, help),
    /--nonexistent-flag/,
    'a flag not in --help must fail the guard, proving it does not vacuously pass',
  );
});

test('the ONBOARDING.md CLI-assisted onboarding section anchors its --import file set to the shared generated block, not a hand-copied list', () => {
  const doc = readFileSync(ONBOARDING_DOC, 'utf8');
  const section = extractSection(doc, CLI_SECTION_HEADING);
  // The section must name the same generated block Step 2's file list
  // renders from, rather than re-deriving or re-describing the file set on
  // its own terms.
  assert.match(section, /idd-template-core-files/u);
  // The generated-block start marker must still appear exactly once in the
  // whole document: sync-docs.mjs / audit-docs.mjs locate it with a single
  // indexOf, so a second copy of the marker would silently go stale forever
  // (never regenerated, never checked) instead of failing loudly.
  const markerCount = (
    doc.match(/<!-- audit:generated id=idd-template-core-files -->/gu) ?? []
  ).length;
  assert.equal(
    markerCount,
    1,
    'the idd-template-core-files generated block must appear exactly once in ONBOARDING.md',
  );
});

// ---------------------------------------------------------------------------
// Documentation-lint compatibility (idd-skill#1860)
//
// A Tier A adopter-repository validation imported this template into a
// minimal repo with no pre-existing lint config and found real markdownlint
// findings (line length, table-column style, single-title, duplicate-heading)
// and cspell findings (unrecognized IDD/tooling vocabulary and upstream
// kurone-kito/idd-skill cross-references) against the imported files alone.
// The end-to-end test below exercises the real
// import -> substitute -> documented-lint-command path against this repo's
// own installed markdownlint-cli2/cspell binaries, so a future documentation
// change that reintroduces incompatible vocabulary or formatting fails here
// instead of on an adopter's first CI run.
//
// This repo's `lint.yml` CI job deliberately dogfoods a toolless bare-node
// adopter path -- it runs `node --test tests/*.test.mts` with NO
// package-manager install, so node_modules/.bin/* is absent there by
// design (dprint/cspell/markdownlint-cli2 run separately, once, in
// pnpm-boundary.yml). The end-to-end test below self-skips when the
// binaries it needs are not installed, instead of failing that lane.
// ---------------------------------------------------------------------------

// Resolve markdownlint-cli2/cspell by their own package.json `bin` entry and
// run them directly through `process.execPath`, rather than by
// `spawnSync('.../node_modules/.bin/markdownlint-cli2' | '.../cspell', ...)`.
// On native Windows, `node_modules/.bin/markdownlint-cli2` and
// `node_modules/.bin/cspell` are POSIX shell shims; the executable form
// Windows actually resolves for a bare command is `.CMD` (or `.ps1`) via
// `PATHEXT`. `spawnSync`/`execFileSync` without `shell: true` never apply
// `PATHEXT` resolution, so invoking the bare `.bin` path fails with `ENOENT`
// there even though the shim is genuinely on PATH -- the same root cause
// #2569 fixed for tsc/biome in `src/scripts/build-ts.mts`'s
// `resolveBinScript`. Resolving the package's real JS entry point and
// running it through `process.execPath` sidesteps PATH/`PATHEXT` lookup
// entirely, so it behaves identically on every platform.
//
// Unlike `typescript`/`@biomejs/biome`, both `markdownlint-cli2` and
// `cspell` declare a package.json `exports` map with no `./package.json`
// subpath, so `require.resolve(`${packageName}/package.json`)` throws
// `ERR_PACKAGE_PATH_NOT_EXPORTED` for either -- this reads `node_modules/
// <packageName>/package.json` directly instead of through `require.resolve`.
function resolveBinScript(
  packageName: string,
  binName: string,
): string | undefined {
  const packageJsonPath = join(
    REPO_ROOT,
    'node_modules',
    packageName,
    'package.json',
  );
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  const { bin } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const relativePath = typeof bin === 'string' ? bin : bin?.[binName];
  return relativePath === undefined
    ? undefined
    : join(dirname(packageJsonPath), relativePath);
}

const MARKDOWNLINT_BIN = resolveBinScript(
  'markdownlint-cli2',
  'markdownlint-cli2',
);
const CSPELL_BIN = resolveBinScript('cspell', 'cspell');
const LINT_BINARIES_INSTALLED =
  MARKDOWNLINT_BIN !== undefined && CSPELL_BIN !== undefined;

test('a real import + substitute produces a doc tree that passes the documented markdownlint/cspell commands with full file coverage (idd-skill#1860)', (t) => {
  if (!LINT_BINARIES_INSTALLED || !MARKDOWNLINT_BIN || !CSPELL_BIN) {
    // Expected on the bare-node lane (lint.yml), which runs this suite with
    // no package-manager install by design -- see the block comment above.
    t.skip('markdownlint-cli2/cspell are not installed in this environment');
    return;
  }
  const targetRoot = makeFixtureDir();

  const imported = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    targetRoot,
  ]);
  assert.equal(imported.status, 0, JSON.stringify(imported.verdict));
  assert.equal(imported.verdict.written, true);

  // The 3 doc-lint compatibility files must actually be part of what a
  // plain --import copies, not something this test seeds by hand.
  for (const compatibilityFile of [
    '.cspell.config.yml',
    '.markdownlint.yml',
    '.markdownlint-cli2.yaml',
  ]) {
    assert.ok(
      existsSync(join(targetRoot, compatibilityFile)),
      `expected --import to copy ${compatibilityFile}`,
    );
  }

  const substituted = runCliBin([
    '--substitute',
    '--target',
    targetRoot,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(substituted.status, 0, JSON.stringify(substituted.verdict));
  assert.equal(substituted.verdict.written, true);
  assert.deepEqual(substituted.verdict.residue, []);

  const markdownlintResult = spawnSync(
    process.execPath,
    [MARKDOWNLINT_BIN, '**/*.md'],
    {
      cwd: targetRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(
    markdownlintResult.status,
    0,
    `markdownlint-cli2 findings against the imported docs:\n${markdownlintResult.stdout}${markdownlintResult.stderr}`,
  );

  const cspellResult = spawnSync(
    process.execPath,
    [CSPELL_BIN, 'lint', '**', '--no-progress'],
    {
      cwd: targetRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(
    cspellResult.status,
    0,
    `cspell findings against the imported docs:\n${cspellResult.stdout}${cspellResult.stderr}`,
  );

  // Scope assertion, not just exit-0: cspell skips dot-directories by
  // default, so a config regression that silently drops
  // `enableGlobDot: true` would still exit 0 while quietly no longer
  // scanning .github/instructions/** -- assert real coverage instead of
  // trusting the exit code alone. cspell prints its summary line to
  // stderr, not stdout.
  //
  // Compare against the import plan's own entry count, not a Markdown-only
  // file count (idd-skill#1875 review): `cspell lint "**"` scans every
  // file type, not just `*.md`, so a Markdown-only count could still pass
  // this assertion even with .github/instructions/**'s Markdown files
  // silently never scanned, as long as enough non-Markdown files padded the
  // total. The import plan's entry count has no such gap -- it is exactly
  // the file count cspell should see if it examined everything --import
  // wrote.
  const cspellOutput = `${cspellResult.stdout}${cspellResult.stderr}`;
  const filesCheckedMatch = /Files checked:\s*(\d+)/u.exec(cspellOutput);
  assert.ok(
    filesCheckedMatch,
    `could not find a "Files checked" count in cspell output:\n${cspellOutput}`,
  );
  const filesChecked = Number(filesCheckedMatch[1]);
  const { plan } = imported.verdict;
  assert.ok(
    Array.isArray(plan),
    `expected imported.verdict.plan to be an array, got: ${JSON.stringify(plan)}`,
  );
  const importedFileCount = plan.length;
  assert.ok(
    filesChecked >= importedFileCount,
    `cspell only checked ${filesChecked} files, fewer than the ${importedFileCount} files --import wrote -- enableGlobDot may have regressed`,
  );
});

// ---------------------------------------------------------------------------
// --substitute --from-transcript / --record-policy (#2282)
// ---------------------------------------------------------------------------

/** Confirms a valid answers map into a transcript via the real --hear --apply CLI path. */
function confirmTranscript(
  root: string,
  answers: Record<string, string>,
): Record<string, unknown> {
  const answersPath = join(root, 'hear-answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const { status, verdict } = runCliBin([
    '--hear',
    '--apply',
    '--answers',
    answersPath,
  ]);
  assert.equal(
    status,
    0,
    `expected a valid transcript, got: ${JSON.stringify(verdict)}`,
  );
  return verdict;
}

test('bin/idd-onboard.mjs --substitute --from-transcript resolves placeholders from a confirmed transcript', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const answers = buildValidHearAnswers();
  for (const [key, value] of Object.entries(ALL_OVERRIDES)) {
    answers[key] = value;
  }
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { status, verdict } = runCliBin([
    '--substitute',
    '--from-transcript',
    transcriptPath,
    '--target',
    root,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.written, true);
  assert.deepEqual(verdict.residue, []);
  const values = verdict.values as Record<
    string,
    { value: string; source: string }
  >;
  assert.equal(values.REPO_NAME.value, ALL_OVERRIDES.REPO_NAME);
  assert.equal(values.REPO_NAME.source, 'flag');
  const config = readFileSync(
    join(root, '.github', 'idd', 'config.json'),
    'utf8',
  );
  assert.match(config, /"markerPrefix": "my-app"/);
});

test('bin/idd-onboard.mjs --substitute --from-transcript: an explicit placeholder flag still wins over the transcript', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const answers = buildValidHearAnswers();
  for (const [key, value] of Object.entries(ALL_OVERRIDES)) {
    answers[key] = value;
  }
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { status, verdict } = runCliBin([
    '--substitute',
    '--from-transcript',
    transcriptPath,
    '--target',
    root,
    '--repo-name',
    'explicit-wins',
  ]);
  assert.equal(status, 0);
  const values = verdict.values as Record<
    string,
    { value: string; source: string }
  >;
  assert.equal(values.REPO_NAME.value, 'explicit-wins');
  assert.equal(values.REPO_NAME.source, 'flag');
});

test('bin/idd-onboard.mjs --substitute --from-transcript exits 1, no writes, when the transcript omits a placeholder answer entirely', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const answers = buildValidHearAnswers();
  // Every OTHER placeholder gets a pattern-valid value so the only
  // remaining unresolved token after trimming is TRUSTED_MARKER_ACTOR
  // (which has no automatic derivation).
  for (const [key, value] of Object.entries(ALL_OVERRIDES)) {
    answers[key] = value;
  }
  const transcript = confirmTranscript(root, answers);
  const trimmed = {
    ...transcript,
    answers: (transcript.answers as { id: string; value: string }[]).filter(
      (answer) => answer.id !== 'TRUSTED_MARKER_ACTOR',
    ),
  };
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(trimmed));
  const before = snapshotTree(root);

  const { status, verdict } = runCliBin([
    '--substitute',
    '--from-transcript',
    transcriptPath,
    '--target',
    root,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.written, false);
  assert.ok(
    (verdict.residue as unknown[]).length > 0 ||
      (verdict.unresolved as unknown[])?.includes('TRUSTED_MARKER_ACTOR'),
  );
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs --substitute --from-transcript exits 1 on a malformed transcript, without touching the tree', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify({ version: '1.0.0' }));
  const before = snapshotTree(root);

  const { status, verdict } = runCliBin([
    '--substitute',
    '--from-transcript',
    transcriptPath,
    '--target',
    root,
    ...CLI_OVERRIDE_FLAGS,
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.valid, false);
  assert.ok(Array.isArray(verdict.unresolved) && verdict.unresolved.length > 0);
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs --substitute rejects --record-policy-only flags (--transcript, --write-policy-doc)', () => {
  const root = makeFixtureDir();
  writeTemplateFixture(root);
  const result = spawnSync(
    process.execPath,
    [
      BIN_PATH,
      '--substitute',
      '--target',
      root,
      '--transcript',
      'x.json',
      ...CLI_OVERRIDE_FLAGS,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

/** A pristine, post-import config.json (unsubstituted placeholders, as --record-policy expects). */
/**
 * `buildValidHearAnswers()` synthesizes `fixture-development-branch` for
 * the `development-branch` item (no documented default). Kept in sync
 * with that helper by name, not by import, the same way the two already
 * cooperate through the fixed `fixture-${item.id}` convention.
 */
const RECORD_POLICY_FIXTURE_DEVELOPMENT_BRANCH = 'fixture-development-branch';

function writeRecordPolicyFixture(root: string): void {
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
  // #2271: --record-policy verifies developmentBranch against the
  // configured remote via local `git ls-remote` (no GitHub CLI, no
  // network) -- give the fixture a real local `origin` carrying the
  // exact branch buildValidHearAnswers() answers with, so every existing
  // record-policy scenario below satisfies that gate the same way a real
  // onboarded repository would, without any credentials or egress.
  const remoteRoot = trackedMkdtemp('idd-onboard-remote-');
  execFileSync(
    'git',
    [
      'init',
      `--initial-branch=${RECORD_POLICY_FIXTURE_DEVELOPMENT_BRANCH}`,
      remoteRoot,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'git',
    ['-C', remoteRoot, 'config', 'user.email', 'fixture@example.com'],
    {
      stdio: 'ignore',
    },
  );
  execFileSync('git', ['-C', remoteRoot, 'config', 'user.name', 'Fixture'], {
    stdio: 'ignore',
  });
  writeFileSync(join(remoteRoot, 'README.md'), '# fixture remote\n');
  execFileSync('git', ['-C', remoteRoot, 'add', 'README.md'], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    ['-C', remoteRoot, 'commit', '--no-gpg-sign', '-m', 'fixture'],
    { stdio: 'ignore' },
  );
  execFileSync('git', ['init', '--initial-branch=main', root], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remoteRoot], {
    stdio: 'ignore',
  });
}

test('bin/idd-onboard.mjs --record-policy dry-run prints the config patch and filled template, writing nothing', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));
  const before = snapshotTree(root);

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.written, false);
  const patch = verdict.configPatch as Record<string, unknown>;
  assert.equal(patch.mergePolicy, answers['merge-policy']);
  assert.match(verdict.policyDocument as string, /## IDD Policy Configuration/);
  assert.match(verdict.policyDocument as string, /### Merge Policy/);
  // Claim Timing / CI Wait Policy render as the template's own bulleted
  // sub-fields, not one flattened line, when the catalog's meta answer
  // is the distributed-defaults choice (#2282 review follow-up).
  assert.match(
    verdict.policyDocument as string,
    /### Claim Timing\n\n- \*\*claim-stale-age\*\*: 24 h \(distributed default\)\n- \*\*claim-heartbeat-interval\*\*: 12 h \(distributed default\)/,
  );
  assert.match(
    verdict.policyDocument as string,
    /### CI Wait Policy\n\n- \*\*running timeout\*\*: `PT30M` \/ 30 min \(distributed default, not confirmed by this hearing item\)\n- \*\*generation timeout\*\*: `PT10M` \/ 10 min \(distributed default, not confirmed by this hearing item\)\n- \*\*rerun policy\*\*: `rerun-once`/,
  );
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs --record-policy fills a Claim Timing override with the confirmed selection, not invented sub-values, and carries a confirmed CI Wait rerun policy into its bullet', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  answers['claim-timing'] = 'repository-override';
  answers['ci-wait-policy'] = 'hold';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
  ]);
  const doc = verdict.policyDocument as string;
  assert.match(
    doc,
    /### Claim Timing\n\n\*\*Selection\*\*: `repository-override` \(override values not captured by this hearing item -- record them manually\)/,
  );
  assert.doesNotMatch(doc, /claim-stale-age/);
  assert.match(
    doc,
    /### CI Wait Policy\n\n- \*\*running timeout\*\*[\s\S]*?\n- \*\*generation timeout\*\*[\s\S]*?\n- \*\*rerun policy\*\*: `hold`/,
  );
});

test('bin/idd-onboard.mjs --record-policy --apply merges only mapsToConfig fields into config.json', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  answers['merge-policy'] = 'fully_autonomous_merge';
  answers['review-policy'] = 'human-required';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.written, true);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(config.mergePolicy, 'fully_autonomous_merge');
  assert.equal(config.reviewPolicy, 'human-required');
  // The pristine placeholder fields survive untouched.
  assert.equal(config.markerPrefix, '{{PROJECT_MARKER_PREFIX}}');
});

test('bin/idd-onboard.mjs --record-policy --dry-run --apply does not write: --dry-run always wins', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));
  const before = snapshotTree(root);

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--dry-run',
    '--apply',
  ]);
  assert.equal(status, 0);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.written, false);
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs --record-policy leaves no helperRuntime key when the confirmed profile is instructions-only and none pre-existed', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  answers['helper-runtime-profile'] = 'instructions-only';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  const patch = verdict.configPatch as Record<string, unknown>;
  assert.equal(
    patch.helperRuntime,
    '(reset to distributed default: key removed)',
  );
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal('helperRuntime' in config, false);
});

test('bin/idd-onboard.mjs --record-policy removes a pre-existing non-default helperRuntime when the transcript reconfirms instructions-only (#2282 review follow-up)', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const existing = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  existing.helperRuntime = { profile: 'package-manager' };
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    `${JSON.stringify(existing, null, 2)}\n`,
  );
  const answers = buildValidHearAnswers();
  answers['helper-runtime-profile'] = 'instructions-only';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal('helperRuntime' in config, false);
});

test('bin/idd-onboard.mjs --record-policy writes helperRuntime.profile for a non-default confirmed profile, preserving sibling ciWait keys', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const existing = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  existing.ciWait = { runningTimeout: 'PT30M' };
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    `${JSON.stringify(existing, null, 2)}\n`,
  );
  const answers = buildValidHearAnswers();
  answers['helper-runtime-profile'] = 'package-manager';
  answers['ci-wait-policy'] = 'hold';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(config.helperRuntime, { profile: 'package-manager' });
  assert.deepEqual(config.ciWait, {
    runningTimeout: 'PT30M',
    rerunPolicy: 'hold',
  });
});

test('bin/idd-onboard.mjs --record-policy writes skipIssueAuthorApprovalGate true only when the operator opted out', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  answers['issue-author-approval-gate'] = 'skip-gate';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  const patch = verdict.configPatch as Record<string, unknown>;
  assert.equal(patch.skipIssueAuthorApprovalGate, true);

  const root2 = makeFixtureDir();
  writeRecordPolicyFixture(root2);
  const answers2 = buildValidHearAnswers();
  answers2['issue-author-approval-gate'] = 'enabled-by-default';
  const transcript2 = confirmTranscript(root2, answers2);
  const transcriptPath2 = join(root2, 'transcript.json');
  writeFileSync(transcriptPath2, JSON.stringify(transcript2));
  const { verdict: verdict2 } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath2,
    '--target',
    root2,
    '--apply',
  ]);
  const patch2 = verdict2.configPatch as Record<string, unknown>;
  assert.equal(
    patch2.skipIssueAuthorApprovalGate,
    '(reset to distributed default: key removed)',
  );
});

test('bin/idd-onboard.mjs --record-policy removes a pre-existing skipIssueAuthorApprovalGate:true when the transcript reconfirms enabled-by-default (#2282 review follow-up)', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const existing = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  existing.skipIssueAuthorApprovalGate = true;
  writeFileSync(
    join(root, '.github', 'idd', 'config.json'),
    `${JSON.stringify(existing, null, 2)}\n`,
  );
  const answers = buildValidHearAnswers();
  answers['issue-author-approval-gate'] = 'enabled-by-default';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
  ]);
  const config = JSON.parse(
    readFileSync(join(root, '.github', 'idd', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal('skipIssueAuthorApprovalGate' in config, false);
});

test('bin/idd-onboard.mjs --record-policy never turns a docs-only or meta-choice answer into a config key', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  answers['claim-timing'] = 'repository-override';
  answers['idd-label-names'] = 'custom-taxonomy';
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));

  const { verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
  ]);
  const patch = verdict.configPatch as Record<string, unknown>;
  const docsOnlyIds = [
    'critique-loop-profile',
    'credential-scope',
    'issue-authoring-companion',
    'up-to-date-head-ruleset',
    'bootstrap-execution-mode',
  ];
  for (const id of docsOnlyIds) {
    const item = loadOnboardingHearingCatalog().items.find(
      (entry) => entry.id === id,
    );
    assert.ok(item, `catalog missing ${id}`);
    const topLevelKey = item?.mapsToConfig?.split('/').filter(Boolean)[0];
    if (topLevelKey !== undefined) {
      assert.equal(topLevelKey in patch, false, `${id} leaked into the patch`);
    }
  }
  assert.equal('claimTiming' in patch, false);
  assert.equal('labels' in patch, false);
  // Still surfaced for a human, just never as an invented config key.
  assert.match(verdict.policyDocument as string, /### Claim Timing/);
  assert.match(verdict.policyDocument as string, /repository-override/);
  assert.match(verdict.policyDocument as string, /### IDD Label Names/);
  assert.match(verdict.policyDocument as string, /custom-taxonomy/);
  assert.doesNotMatch(
    verdict.policyDocument as string,
    /### Merge Policy[\s\S]*### Merge Policy/,
  );
});

test('bin/idd-onboard.mjs --record-policy --write-policy-doc writes the template only under --apply, never without it', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const answers = buildValidHearAnswers();
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));
  const docPath = join(root, 'policy-doc.md');

  const dryRun = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--write-policy-doc',
    docPath,
  ]);
  assert.equal(dryRun.status, 0);
  assert.equal(existsSync(docPath), false);

  const applied = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--apply',
    '--write-policy-doc',
    docPath,
  ]);
  assert.equal(applied.status, 0);
  assert.equal(existsSync(docPath), true);
  assert.equal(applied.verdict.writtenPolicyDocPath, resolve(docPath));

  const root2 = makeFixtureDir();
  writeRecordPolicyFixture(root2);
  const transcript2 = confirmTranscript(root2, buildValidHearAnswers());
  const transcriptPath2 = join(root2, 'transcript.json');
  writeFileSync(transcriptPath2, JSON.stringify(transcript2));
  const appliedNoDocFlag = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath2,
    '--target',
    root2,
    '--apply',
  ]);
  assert.equal(appliedNoDocFlag.status, 0);
  assert.equal(appliedNoDocFlag.verdict.writtenPolicyDocPath, null);
});

test('bin/idd-onboard.mjs --record-policy exits 2 when config.json does not already exist (post-import only)', () => {
  const root = makeFixtureDir();
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      version: '1.0.0',
      confirmedAt: new Date().toISOString(),
      answers: [],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      BIN_PATH,
      '--record-policy',
      '--transcript',
      transcriptPath,
      '--target',
      root,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

test('bin/idd-onboard.mjs --record-policy exits 2 and writes nothing when config.json parses to a non-object root (#2282 review follow-up)', () => {
  const root = makeFixtureDir();
  mkdirSync(join(root, '.github', 'idd'), { recursive: true });
  writeFileSync(join(root, '.github', 'idd', 'config.json'), 'null\n');
  const answers = buildValidHearAnswers();
  const transcript = confirmTranscript(root, answers);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(transcript));
  const before = snapshotTree(root);

  const result = spawnSync(
    process.execPath,
    [
      BIN_PATH,
      '--record-policy',
      '--transcript',
      transcriptPath,
      '--target',
      root,
      '--apply',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs --record-policy requires --transcript', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const result = spawnSync(
    process.execPath,
    [BIN_PATH, '--record-policy', '--target', root],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

test('bin/idd-onboard.mjs --record-policy exits 1 on a malformed transcript, mode reflects --dry-run even with --apply also passed (#2282 review follow-up)', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const transcriptPath = join(root, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify({ version: '1.0.0' }));
  const before = snapshotTree(root);

  const { status, verdict } = runCliBin([
    '--record-policy',
    '--transcript',
    transcriptPath,
    '--target',
    root,
    '--dry-run',
    '--apply',
  ]);
  assert.equal(status, 1);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.mode, 'dry-run');
  assert.ok(Array.isArray(verdict.unresolved) && verdict.unresolved.length > 0);
  assertTreeUnchanged(root, before);
});

test('bin/idd-onboard.mjs exits 2 when --record-policy is combined with --import, --substitute, --verify, or --hear', () => {
  const root = makeFixtureDir();
  writeRecordPolicyFixture(root);
  const combos = [
    ['--record-policy', '--import', '--target', root],
    ['--record-policy', '--substitute', '--target', root],
    ['--record-policy', '--verify', '--target', root],
    ['--record-policy', '--hear', '--target', root],
  ];
  for (const args of combos) {
    const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `expected exit 2 for: ${args.join(' ')}`);
  }
});

test('bin/idd-onboard.mjs --hear rejects --record-policy-only flags (--transcript, --write-policy-doc)', () => {
  const root = makeFixtureDir();
  const result = spawnSync(
    process.execPath,
    [
      BIN_PATH,
      '--hear',
      '--propose',
      '--target',
      root,
      '--transcript',
      'x.json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

test('bin/idd-onboard.mjs --help documents --record-policy, --transcript, and --write-policy-doc', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /--record-policy/);
  assert.match(help, /--transcript/);
  assert.match(help, /--write-policy-doc/);
  assert.match(help, /--from-transcript/);
});

// ---------------------------------------------------------------------------
// #2216: resolveConfinedDirectory (--source / --target path confinement)
// ---------------------------------------------------------------------------

// Every scenario runs with cwd temporarily pointed at a freshly
// mkdtempSync-created sandbox (never the real repo cwd), mirroring the
// sandboxing idd-config.test.mts's withSandboxCwd already uses.
function withSandboxCwd<T>(run: (sandbox: string) => T): T {
  const originalCwd = process.cwd();
  const sandbox = trackedMkdtemp('idd-onboard-confine-');
  process.chdir(sandbox);
  try {
    return run(sandbox);
  } finally {
    process.chdir(originalCwd);
  }
}

test('resolveConfinedDirectory accepts a relative path that resolves inside the working directory', () => {
  withSandboxCwd((sandbox) => {
    mkdirSync(join(sandbox, 'nested'));
    const resolved = resolveConfinedDirectory('nested', '--target', []);
    assert.equal(resolved, join(sandbox, 'nested'));
  });
});

test('resolveConfinedDirectory accepts the working directory itself', () => {
  withSandboxCwd((sandbox) => {
    assert.equal(resolveConfinedDirectory('.', '--target', []), sandbox);
  });
});

test('resolveConfinedDirectory accepts a real child directory whose name happens to start with ".." (#2357 review: relative() false positive)', () => {
  withSandboxCwd((sandbox) => {
    mkdirSync(join(sandbox, '..foo'));
    const resolved = resolveConfinedDirectory('..foo', '--target', []);
    assert.equal(resolved, join(sandbox, '..foo'));
  });
});

test('resolveConfinedDirectory rejects a --target using ../ traversal that escapes the working directory', () => {
  withSandboxCwd((sandbox) => {
    const outside = trackedMkdtemp('idd-onboard-outside-');
    const traversal = relative(sandbox, outside);
    assert.throws(
      () => resolveConfinedDirectory(traversal, '--target', []),
      /--target resolves outside the confined root/,
    );
  });
});

test('resolveConfinedDirectory rejects an absolute path outside the confined root', () => {
  withSandboxCwd(() => {
    const outside = trackedMkdtemp('idd-onboard-outside-');
    assert.throws(
      () => resolveConfinedDirectory(outside, '--source', []),
      /--source resolves outside the confined root/,
    );
  });
});

test('resolveConfinedDirectory rejects a symlink that resolves outside the confined root', () => {
  withSandboxCwd((sandbox) => {
    const outside = trackedMkdtemp('idd-onboard-outside-');
    const link = join(sandbox, 'link-out');
    symlinkSync(outside, link, 'dir');
    assert.throws(
      () => resolveConfinedDirectory('link-out', '--target', []),
      /--target resolves outside the confined root/,
    );
  });
});

test('resolveConfinedDirectory accepts a path outside the working directory when covered by --allow-root', () => {
  withSandboxCwd(() => {
    const outside = trackedMkdtemp('idd-onboard-outside-');
    const resolved = resolveConfinedDirectory(outside, '--target', [outside]);
    assert.equal(resolved, resolve(outside));
  });
});

test('resolveConfinedDirectory accepts a nested path under an --allow-root root', () => {
  withSandboxCwd(() => {
    const outside = trackedMkdtemp('idd-onboard-outside-');
    const nested = join(outside, 'nested');
    mkdirSync(nested);
    const resolved = resolveConfinedDirectory(nested, '--target', [outside]);
    assert.equal(resolved, nested);
  });
});

test('resolveConfinedDirectory rejects a nonexistent --allow-root with a clear error', () => {
  withSandboxCwd((sandbox) => {
    const missing = join(sandbox, 'does-not-exist');
    assert.throws(
      () => resolveConfinedDirectory('.', '--target', [missing]),
      /--allow-root does not exist/,
    );
  });
});

test('resolveConfinedDirectory still rejects a --target that is not a directory at all', () => {
  withSandboxCwd((sandbox) => {
    const file = join(sandbox, 'not-a-dir');
    writeFileSync(file, 'x');
    assert.throws(
      () => resolveConfinedDirectory(file, '--target', []),
      /--target is not a directory/,
    );
  });
});

test('bin/idd-onboard.mjs --import rejects a --target outside the confined root, with a clear error and exit 2', () => {
  const outside = makeFixtureDir();
  try {
    execFileSync(
      process.execPath,
      [BIN_PATH, '--import', '--source', REPO_ROOT, '--target', outside],
      { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    assert.equal(failed.status, 2);
    assert.match(
      String(failed.stderr),
      /--target resolves outside the confined root/,
    );
  }
});

test('bin/idd-onboard.mjs --import accepts a --target outside cwd once covered by --allow-root', () => {
  const { status, verdict } = runCliBin([
    '--import',
    '--source',
    REPO_ROOT,
    '--target',
    makeFixtureDir(),
  ]);
  assert.equal(status, 0);
  assert.equal(typeof verdict.target, 'string');
});

test('bin/idd-onboard.mjs --help documents --allow-root', () => {
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /--allow-root <dir>/);
});
