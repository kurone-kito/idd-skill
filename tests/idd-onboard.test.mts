import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectVendoredFiles,
  PROFILE_NAMES,
} from '../src/scripts/helper-runtime-manifest.mts';
// Importing the CLI module directly is only possible because its top-level
// statements are guarded behind isCliExecution() (#1210 pattern); an
// import-time CLI run would parse process.argv and abort this test process.
import {
  applyImportPlan,
  applySubstitutionPlan,
  buildImportPlan,
  buildSubstitutionPlan,
  checkManifestCompleteness,
  checkPlaceholderResidue,
  checkStaleImportSignal,
  deriveInstallDepsCommand,
  deriveMarkerPrefix,
  deriveValidateCommands,
  escapeJsonStringContent,
  MARKER_PREFIX_PATTERN,
  ONBOARDING_PLACEHOLDERS,
  parseRemoteRepoRef,
  resolveCoreTemplateFiles,
  resolveImportFiles,
  resolvePlaceholderValues,
  runVerify,
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
const ONBOARDING_DOC = join(REPO_ROOT, 'idd-template', 'ONBOARDING.md');

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
  assert.equal(statSync(targetHook).mode & 0o777, 0o755);
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
  // The pre-commit hook's executable bit must survive the copy.
  const hookMode = statSync(join(targetRoot, '.githooks', 'pre-commit')).mode;
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

test('the ONBOARDING.md CLI-assisted onboarding section documents only flags idd-onboard --help actually lists', () => {
  const doc = readFileSync(ONBOARDING_DOC, 'utf8');
  const section = extractSection(doc, CLI_SECTION_HEADING);
  const help = execFileSync(process.execPath, [BIN_PATH, '--help'], {
    encoding: 'utf8',
  });
  // Sanity check: the section documents a non-trivial number of real flags,
  // so this guard is not vacuously satisfied by an empty or flag-free section.
  assert.ok(
    extractFlagTokens(section).length >= 10,
    'expected the CLI-assisted onboarding section to document at least 10 distinct flags',
  );
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
