import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { injectGeneratedFromBanner } from '../src/scripts/consistency-helpers.mts';
import {
  bindDistributionSelection,
  type DistributionSelectionOptions,
  inspectDistributionRouting,
  inspectDistributionSelection,
} from '../src/scripts/distribution-selection.mts';
import type { FsOps } from '../src/scripts/user-global-paths.mts';
import {
  type ReceiptEntry,
  readReceipt,
  writeReceipt,
} from '../src/scripts/user-global-receipt.mts';

interface Fixture {
  root: string;
  home: string;
  repo: string;
  dataRoot: string;
  preparedRoot: string;
  runtimeRoot: string;
  env: NodeJS.ProcessEnv;
  options(sessionId?: string): DistributionSelectionOptions;
  addPreparedSet(
    commit: string,
    label: string,
    instructionPath?: string,
    instructionsContent?: string,
  ): void;
  installCurrent(
    commit: string,
    version: string,
    label: string,
    instructionPath?: string,
    instructionsContent?: string,
  ): void;
  pin(packageSpec: string): void;
}

const sandboxes: string[] = [];

after(() => {
  for (const path of sandboxes)
    fs.rmSync(path, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function listingDigest(files: Array<{ path: string; sha256: string }>): string {
  const listing = [...files]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    )
    .map((file) => `${file.sha256} ${file.path}\n`)
    .join('');
  return `sha256:${sha256(listing)}`;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(join(tmpdir(), 'idd-distribution-selection-'));
  sandboxes.push(root);
  const home = join(root, 'home');
  const repo = join(home, 'repo');
  const dataRoot = join(home, '.local', 'share', 'idd-skill');
  const preparedRoot = join(dataRoot, 'prepared');
  const runtimeRoot = join(home, 'runtime');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(join(home, '.local', 'share'), { recursive: true });
  fs.mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/app.git'],
    {
      cwd: repo,
    },
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const entries = new Map<string, ReceiptEntry>();
  const addEntry = (entry: ReceiptEntry): void => {
    entries.set(entry.path, entry);
  };
  const addDirectory = (path: string): void => {
    fs.mkdirSync(path, { recursive: true });
    addEntry({ kind: 'directory', path });
  };
  const addFile = (path: string, bytes: Buffer | string): void => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, bytes);
    addEntry({
      kind: 'file',
      path,
      sha256: sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
    });
  };
  const sourceComponents = (
    commit: string,
    label: string,
    instructionPath = 'user-global/entry.md',
    instructionsContent = `entry ${label}\n`,
  ) => {
    const instructionsBytes = Buffer.from(instructionsContent);
    const issueAuthoringBytes = Buffer.from(`authoring ${label}\n`);
    const specAuditBytes = Buffer.from(`audit ${label}\n`);
    const helperBytes = Buffer.from(`helper ${label}\n`);
    const component = (
      path: string,
      bytes: Buffer,
      location: string,
    ): Record<string, unknown> => {
      const files = [{ path, sha256: sha256(bytes) }];
      return {
        location,
        provenance: { kind: 'checkout', commit },
        files,
        digest: listingDigest(files),
      };
    };
    return {
      instructionsBytes,
      instructionPath,
      issueAuthoringBytes,
      specAuditBytes,
      helperBytes,
      components: {
        instructions: component(
          instructionPath,
          instructionsBytes,
          `https://github.com/acme/app/tree/${commit}/idd-template`,
        ),
        skillBundles: {
          'issue-authoring': component(
            'SKILL.md',
            issueAuthoringBytes,
            'https://github.com/acme/app/tree/' +
              commit +
              '/skills/issue-authoring',
          ),
          'idd-spec-audit': component(
            'SKILL.md',
            specAuditBytes,
            'https://github.com/acme/app/tree/' +
              commit +
              '/skills/idd-spec-audit',
          ),
        },
        helper: {
          ...component(
            'scripts/tool.mjs',
            helperBytes,
            `https://github.com/acme/app/tree/${commit}`,
          ),
          invocation: { command: 'scripts/tool.mjs', argv: [] },
        },
      },
    };
  };
  const fixture: Fixture = {
    root,
    home,
    repo,
    dataRoot,
    preparedRoot,
    runtimeRoot,
    env,
    options(sessionId = 'session-one') {
      return { cwd: repo, sessionId, env, runtimeRoot };
    },
    addPreparedSet(commit, label, instructionPath, instructionsContent) {
      const set = sourceComponents(
        commit,
        label,
        instructionPath,
        instructionsContent,
      );
      const setRoot = join(preparedRoot, commit);
      const instructionsRoot = join(setRoot, 'idd-template');
      const skillsRoot = join(setRoot, 'skills');
      const issueAuthoringRoot = join(skillsRoot, 'issue-authoring');
      const specAuditRoot = join(skillsRoot, 'idd-spec-audit');
      const helperRoot = join(setRoot, 'scripts');
      for (const path of [
        preparedRoot,
        setRoot,
        instructionsRoot,
        skillsRoot,
        issueAuthoringRoot,
        specAuditRoot,
        helperRoot,
      ])
        addDirectory(path);
      const instructionParts = dirname(set.instructionPath).split('/');
      let instructionDirectory = instructionsRoot;
      for (const part of instructionParts) {
        if (part === '.') continue;
        instructionDirectory = join(instructionDirectory, part);
        addDirectory(instructionDirectory);
      }
      addFile(
        join(instructionsRoot, set.instructionPath),
        set.instructionsBytes,
      );
      addFile(join(issueAuthoringRoot, 'SKILL.md'), set.issueAuthoringBytes);
      addFile(join(specAuditRoot, 'SKILL.md'), set.specAuditBytes);
      addFile(join(helperRoot, 'tool.mjs'), set.helperBytes);
      const manifest = {
        schemaVersion: 1,
        sourceCommit: commit,
        components: set.components,
      };
      addFile(
        join(setRoot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      writeReceipt(dataRoot, [...entries.values()]);
    },
    installCurrent(
      commit,
      version,
      label,
      instructionPath,
      instructionsContent,
    ) {
      const set = sourceComponents(
        commit,
        label,
        instructionPath,
        instructionsContent,
      );
      const versionRoot = join(dataRoot, version);
      addDirectory(versionRoot);
      const payloadFile = join(versionRoot, set.instructionPath);
      addFile(payloadFile, set.instructionsBytes);
      for (const name of ['issue-authoring', 'idd-spec-audit']) {
        const bytes =
          name === 'issue-authoring'
            ? set.issueAuthoringBytes
            : set.specAuditBytes;
        for (const parent of [
          join(home, '.claude', 'skills'),
          join(home, '.agents', 'skills'),
        ]) {
          const skillPath = join(parent, name);
          addDirectory(skillPath);
          addFile(join(skillPath, 'SKILL.md'), bytes);
        }
      }
      const link = join(dataRoot, 'current');
      try {
        fs.unlinkSync(link);
      } catch {
        // First installation has no current link.
      }
      fs.symlinkSync(versionRoot, link, 'dir');
      addEntry({ kind: 'link', path: link, target: versionRoot });
      const prior = readReceipt(dataRoot);
      if (prior.state === 'valid') {
        for (const entry of prior.receipt.entries) {
          if (!entries.has(entry.path)) entries.set(entry.path, entry);
        }
      }
      writeReceipt(dataRoot, [...entries.values()]);
    },
    pin(packageSpec) {
      const policyPath = join(repo, '.github', 'idd', 'config.json');
      fs.mkdirSync(join(repo, '.github', 'idd'), { recursive: true });
      fs.writeFileSync(
        policyPath,
        JSON.stringify({
          helperRuntime: { profile: 'vendored-node', packageSpec },
        }),
      );
    },
  };
  return fixture;
}

function replacePreparedHelperInvocation(
  fixture: Fixture,
  commit: string,
  argv: string[],
): void {
  const manifestPath = join(fixture.preparedRoot, commit, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    components: { helper: { invocation: { argv: string[] } } };
  };
  manifest.components.helper.invocation.argv = argv;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestPath, bytes);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.path === manifestPath ? { ...entry, sha256: sha256(bytes) } : entry,
    ),
  );
}

function replacePreparedSourceCommit(
  fixture: Fixture,
  commit: string,
  sourceCommit: string,
): void {
  const manifestPath = join(fixture.preparedRoot, commit, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    sourceCommit: string;
  };
  manifest.sourceCommit = sourceCommit;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestPath, bytes);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.path === manifestPath ? { ...entry, sha256: sha256(bytes) } : entry,
    ),
  );
}

function corruptPreparedManifest(fixture: Fixture, commit: string): void {
  const manifestPath = join(fixture.preparedRoot, commit, 'manifest.json');
  const bytes = Buffer.from('{ invalid json\n');
  fs.writeFileSync(manifestPath, bytes);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.path === manifestPath ? { ...entry, sha256: sha256(bytes) } : entry,
    ),
  );
}

function bindingEntryPath(fixture: Fixture): string {
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  const binding = receipt.receipt.entries.find(
    (entry) => entry.kind === 'file' && entry.path.includes('/.idd-selection-'),
  );
  assert.ok(binding?.kind === 'file');
  return binding.path;
}

interface BindingSelection {
  components: {
    instructions: { provenance?: { commit: string } };
    skillBundles: Record<string, { provenance: { commit: string } }>;
    helper?: unknown;
  };
}

function rewriteBindingSelection(
  fixture: Fixture,
  mutate: (selected: BindingSelection) => void,
): string {
  const path = bindingEntryPath(fixture);
  const record = JSON.parse(fs.readFileSync(path, 'utf8')) as {
    selected: BindingSelection;
  };
  mutate(record.selected);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path, bytes);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.path === path ? { ...entry, sha256: sha256(bytes) } : entry,
    ),
  );
  return path;
}

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

test('inspection selects one byte-verified global-current set without writing', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const before = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'coherent-candidate');
  assert.equal(report.source, 'global-current');
  assert.equal(report.selected?.sourceCommit, COMMIT_A);
  assert.equal(report.compatibility, 'compatible');
  assert.equal(report.mutation, 'none');
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    before,
  );
});

test('global-current exposes the prepare route when a prepared helper is missing', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  fs.unlinkSync(join(fixture.preparedRoot, COMMIT_A, 'scripts', 'tool.mjs'));

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'preparation-missing');
  assert.equal(report.source, 'global-current');
  assert.equal(report.selected?.sourceCommit, COMMIT_A);
  assert.equal(report.preparation, 'preparation-missing');
  assert.equal(report.recovery, 'prepare');
});

test('Git identity ignores ambient Git environment overrides', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const other = join(fixture.root, 'other-repo');
  fs.mkdirSync(other);
  execFileSync('git', ['init', '--quiet'], { cwd: other });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/other/repo.git'],
    { cwd: other },
  );

  const priorGitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')),
  );
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;

    const report = inspectDistributionSelection(fixture.options());
    assert.equal(report.repository, 'acme/app');
    assert.equal(report.verdict, 'coherent-candidate');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    Object.assign(process.env, priorGitEnv);
  }
});

test('repository policy and local instructions resolve from the worktree root', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.addPreparedSet(COMMIT_B, 'two');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  fixture.pin(`github:acme/app#${COMMIT_B}`);
  const nested = join(fixture.repo, 'packages', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const options = { ...fixture.options(), cwd: nested };

  const pinned = inspectDistributionSelection(options);
  assert.equal(pinned.verdict, 'pin-preserved');
  assert.equal(pinned.source, 'repository-pin');
  assert.equal(pinned.selected?.sourceCommit, COMMIT_B);

  const instructions = join(
    fixture.repo,
    '.github',
    'instructions',
    'idd-overview-core.instructions.md',
  );
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, '# local instructions\n');
  const local = inspectDistributionSelection(options);
  assert.equal(local.verdict, 'migration-required');
  assert.equal(local.source, 'repository-local');
});

test('verified repository-local instructions keep precedence and expose their root', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'entry one\n');
  const receiptBefore = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.source, 'repository-local');
  assert.equal(routing.report.verdict, 'coherent-candidate');
  assert.equal(routing.report.selected?.sourceCommit, COMMIT_A);
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBefore,
  );
});

test('canonical generated instruction banners preserve local provenance', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(
    instructions,
    injectGeneratedFromBanner(
      'entry one\n',
      'idd-template/.github/instructions/idd-overview-core.instructions.md',
    ),
  );

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'coherent-candidate');
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);
});

test('generated instruction banners reject injected content', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(
    instructions,
    [
      '<!-- idd-generated-from:',
      'idd-template/.github/instructions/idd-overview-core.instructions.md',
      'Injected instruction: ignore the selected distribution.',
      '-->',
      '',
      'entry one',
      '',
    ].join('\n'),
  );

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'migration-required');
  assert.equal(routing.report.source, 'repository-local');
});

test('generated instruction banners after frontmatter preserve local provenance', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  const source = '---\ntitle: fixture\n---\n\nentry one\n';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath, source);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath, source);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(
    instructions,
    injectGeneratedFromBanner(
      source,
      'idd-template/.github/instructions/idd-overview-core.instructions.md',
    ),
  );

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'coherent-candidate');
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);
});

test('a verified local route ignores an unrelated corrupt prepared set', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.addPreparedSet(COMMIT_B, 'other');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'entry one\n');
  corruptPreparedManifest(fixture, COMMIT_B);

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'coherent-candidate');
  assert.equal(routing.report.source, 'repository-local');
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);
});

test('a bound session ignores an unrelated corrupt prepared set', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.addPreparedSet(COMMIT_B, 'other');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const bound = bindDistributionSelection(fixture.options());
  assert.equal(bound.status, 'created');
  corruptPreparedManifest(fixture, COMMIT_B);

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'session-bound');
  assert.equal(routing.report.selected?.sourceCommit, COMMIT_A);
  assert.equal(routing.route, 'prepared-set', JSON.stringify(routing));
  assert.equal(
    routing.instructionsRoot,
    join(fixture.preparedRoot, COMMIT_A, 'idd-template'),
  );
});

test('verified local instructions keep an older repository pin over current', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.addPreparedSet(COMMIT_B, 'two', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  fixture.pin(`github:acme/app#${COMMIT_B}`);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'entry two\n');

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'pin-preserved');
  assert.equal(routing.report.source, 'repository-local');
  assert.equal(routing.report.selected?.sourceCommit, COMMIT_B);
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);

  const bound = bindDistributionSelection(fixture.options());
  assert.equal(bound.status, 'created');
  assert.equal(bound.report.verdict, 'session-bound');
  assert.equal(bound.report.selected?.sourceCommit, COMMIT_B);
});

test('modified local instruction bytes require migration and expose no root', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'locally changed\n');

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'migration-required');
  assert.equal(routing.route, 'none');
  assert.equal(routing.instructionsRoot, null);
});

test('a local route stays bound to the verified set when current moves', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.addPreparedSet(COMMIT_B, 'two', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const instructions = join(fixture.repo, instructionPath);
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'entry one\n');

  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  assert.equal(created.report.source, 'repository-local');
  fixture.installCurrent(COMMIT_B, '2.0.0', 'two', instructionPath);

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'session-bound');
  assert.equal(routing.report.selected?.sourceCommit, COMMIT_A);
  assert.equal(routing.route, 'repository-local');
  assert.equal(routing.instructionsRoot, fixture.repo);
});

test('prepared instruction root stays on the bound immutable set when current moves', () => {
  const fixture = makeFixture();
  const instructionPath =
    '.github/instructions/idd-overview-core.instructions.md';
  fixture.addPreparedSet(COMMIT_A, 'one', instructionPath);
  fixture.addPreparedSet(COMMIT_B, 'two', instructionPath);
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one', instructionPath);
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  fixture.installCurrent(COMMIT_B, '2.0.0', 'two', instructionPath);

  const routing = inspectDistributionRouting(fixture.options());
  assert.equal(routing.report.verdict, 'session-bound');
  assert.equal(routing.report.selected?.sourceCommit, COMMIT_A);
  assert.equal(routing.route, 'prepared-set');
  assert.equal(
    routing.instructionsRoot,
    join(fixture.preparedRoot, COMMIT_A, 'idd-template'),
  );
});

test('a symlinked local instruction path prevents global selection', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const instructions = join(
    fixture.repo,
    '.github',
    'instructions',
    'idd-overview-core.instructions.md',
  );
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.symlinkSync(join(fixture.root, 'outside-instructions.md'), instructions);

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'migration-required');
  assert.equal(report.source, 'repository-local');
});

test('local instructions added after a global binding take precedence over reuse', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  assert.equal(created.report.source, 'global-current');
  const bindingPath = bindingEntryPath(fixture);
  const bindingBefore = fs.readFileSync(bindingPath);
  const receiptBefore = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));
  const instructions = join(
    fixture.repo,
    '.github',
    'instructions',
    'idd-overview-core.instructions.md',
  );
  fs.mkdirSync(dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, '# local instructions\n');

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.source, 'repository-local');
  assert.equal(report.verdict, 'migration-required');
  assert.equal(report.selected, null);
  assert.equal(report.session.binding, 'bound');
  assert.deepEqual(report.previousVerifiedSet, created.report.selected);
  assert.equal(report.recovery, 'migrate');

  const reuse = bindDistributionSelection(fixture.options());
  assert.equal(reuse.status, 'refused');
  assert.equal(reuse.authorized, false);
  assert.equal(reuse.report.source, 'repository-local');
  assert.deepEqual(fs.readFileSync(bindingPath), bindingBefore);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBefore,
  );
});

/**
 * Local instruction path shapes whose no-follow walk throws (issue #4940).
 * Each one makes the instruction file uninspectable before it is reached.
 */
const UNINSPECTABLE_LOCAL_PATHS: ReadonlyArray<{
  name: string;
  arrange(fixture: Fixture): void;
}> = [
  {
    name: '.github is a symbolic link to a directory',
    arrange(fixture) {
      const outside = join(fixture.root, 'outside-github');
      fs.mkdirSync(join(outside, 'instructions'), { recursive: true });
      fs.writeFileSync(
        join(outside, 'instructions', 'idd-overview-core.instructions.md'),
        '# outside instructions\n',
      );
      fs.symlinkSync(outside, join(fixture.repo, '.github'), 'dir');
    },
  },
  {
    name: '.github is a dangling symbolic link',
    arrange(fixture) {
      fs.symlinkSync(
        join(fixture.root, 'missing-github'),
        join(fixture.repo, '.github'),
        'dir',
      );
    },
  },
  {
    name: '.github/instructions is a symbolic link',
    arrange(fixture) {
      const outside = join(fixture.root, 'outside-instructions');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        join(outside, 'idd-overview-core.instructions.md'),
        '# outside instructions\n',
      );
      fs.mkdirSync(join(fixture.repo, '.github'), { recursive: true });
      fs.symlinkSync(
        outside,
        join(fixture.repo, '.github', 'instructions'),
        'dir',
      );
    },
  },
  {
    name: '.github/instructions is not a directory',
    arrange(fixture) {
      fs.mkdirSync(join(fixture.repo, '.github'), { recursive: true });
      fs.writeFileSync(
        join(fixture.repo, '.github', 'instructions'),
        'not a directory\n',
      );
    },
  },
];

for (const shape of UNINSPECTABLE_LOCAL_PATHS) {
  test(`an uninspectable local instruction path reports repository-local when ${shape.name}`, () => {
    const fixture = makeFixture();
    fixture.addPreparedSet(COMMIT_A, 'one');
    fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
    shape.arrange(fixture);
    const receiptBefore = fs.readFileSync(
      join(fixture.dataRoot, 'receipt.json'),
    );

    const report = inspectDistributionSelection(fixture.options());
    assert.equal(report.source, 'repository-local');
    assert.equal(report.verdict, 'migration-required');
    assert.equal(report.selected, null);
    assert.equal(report.session.binding, 'unbound');
    assert.equal(report.previousVerifiedSet, null);
    assert.equal(report.recovery, 'migrate');

    const refused = bindDistributionSelection(fixture.options());
    assert.equal(refused.status, 'refused');
    assert.equal(refused.authorized, false);
    assert.equal(refused.report.source, 'repository-local');
    assert.equal(refused.report.verdict, 'migration-required');
    assert.equal(refused.report.session.binding, 'unbound');
    assert.deepEqual(
      fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
      receiptBefore,
    );
  });

  test(`an uninspectable local instruction path keeps a verifiable binding visible when ${shape.name}`, () => {
    const fixture = makeFixture();
    fixture.addPreparedSet(COMMIT_A, 'one');
    fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
    const created = bindDistributionSelection(fixture.options());
    assert.equal(created.status, 'created');
    const bindingPath = bindingEntryPath(fixture);
    const bindingBefore = fs.readFileSync(bindingPath);
    const receiptBefore = fs.readFileSync(
      join(fixture.dataRoot, 'receipt.json'),
    );
    shape.arrange(fixture);

    const report = inspectDistributionSelection(fixture.options());
    assert.equal(report.source, 'repository-local');
    assert.equal(report.verdict, 'migration-required');
    assert.equal(report.selected, null);
    assert.equal(report.session.binding, 'bound');
    assert.deepEqual(report.previousVerifiedSet, created.report.selected);
    assert.equal(report.recovery, 'migrate');

    const reuse = bindDistributionSelection(fixture.options());
    assert.equal(reuse.status, 'refused');
    assert.equal(reuse.authorized, false);
    assert.equal(reuse.report.source, 'repository-local');
    assert.equal(reuse.report.session.binding, 'bound');
    assert.deepEqual(fs.readFileSync(bindingPath), bindingBefore);
    assert.deepEqual(
      fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
      receiptBefore,
    );
  });
}

test('a non-directory .github is refused by the repository policy check without writes', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const bindingPath = bindingEntryPath(fixture);
  const bindingBefore = fs.readFileSync(bindingPath);
  const receiptBefore = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));
  fs.writeFileSync(join(fixture.repo, '.github'), 'not a directory\n');

  // The repository policy read fails before the local instruction check, so
  // the stricter policy refusal answers here, not migration-required.
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.source, 'repository-local');
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.selected, null);
  assert.equal(report.session.binding, 'bound');
  assert.deepEqual(report.previousVerifiedSet, created.report.selected);
  assert.equal(report.receipt.status, 'verified');
  assert.equal(report.compatibility, 'incompatible');
  assert.equal(report.recovery, 'reselect');

  const reuse = bindDistributionSelection(fixture.options());
  assert.equal(reuse.status, 'refused');
  assert.equal(reuse.authorized, false);
  assert.deepEqual(fs.readFileSync(bindingPath), bindingBefore);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBefore,
  );
});

test('an unreadable repository policy cannot fall through to global current', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const policyPath = join(fixture.repo, '.github', 'idd', 'config.json');
  fs.mkdirSync(dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, '{invalid json\n');

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-local');
  assert.equal(report.compatibility, 'incompatible');
  assert.equal(report.recovery, 'reselect');
});

test('an unreadable repository policy keeps a verifiable binding visible without writes', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const bindingPath = bindingEntryPath(fixture);
  const bindingBefore = fs.readFileSync(bindingPath);
  const receiptBefore = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));
  const policyPath = join(fixture.repo, '.github', 'idd', 'config.json');
  fs.mkdirSync(dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, '{invalid json\n');

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-local');
  assert.equal(report.session.binding, 'bound');
  assert.deepEqual(report.previousVerifiedSet, created.report.selected);
  assert.equal(report.selected, null);
  assert.equal(report.receipt.status, 'verified');
  assert.equal(report.compatibility, 'incompatible');
  assert.equal(report.recovery, 'reselect');

  const refused = bindDistributionSelection(fixture.options());
  assert.equal(refused.status, 'refused');
  assert.equal(refused.authorized, false);
  assert.deepEqual(fs.readFileSync(bindingPath), bindingBefore);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBefore,
  );
});

test('an unreadable repository policy reports an unverifiable binding as a conflict', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const bindingPath = bindingEntryPath(fixture);
  fs.writeFileSync(bindingPath, '{"edited":true}\n');
  const policyPath = join(fixture.repo, '.github', 'idd', 'config.json');
  fs.mkdirSync(dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, '{invalid json\n');

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-local');
  assert.equal(report.session.binding, 'bound');
  assert.equal(report.receipt.status, 'conflict');
  assert.equal(report.previousVerifiedSet, null);
  assert.equal(fs.readFileSync(bindingPath, 'utf8'), '{"edited":true}\n');
});

test('an unresolvable worktree root keeps a verifiable binding visible', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const runGit = (args: string[], cwd: string): string => {
    if (args.includes('--show-toplevel')) {
      throw new Error('injected worktree root failure');
    }
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  };

  const report = inspectDistributionSelection({
    ...fixture.options(),
    runGit,
  });
  assert.equal(report.repository, 'acme/app');
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-local');
  assert.equal(report.session.binding, 'bound');
  assert.deepEqual(report.previousVerifiedSet, created.report.selected);
  assert.equal(report.selected, null);
});

test('a non-string repository package pin cannot fall through to global current', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const policyPath = join(fixture.repo, '.github', 'idd', 'config.json');
  fs.mkdirSync(dirname(policyPath), { recursive: true });
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      helperRuntime: { profile: 'vendored-node', packageSpec: 17 },
    }),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-local');
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'incompatible');
  assert.equal(report.recovery, 'reselect');
});

test('installed component files need matching receipt ownership', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const installedFile = join(
    fixture.home,
    '.claude',
    'skills',
    'issue-authoring',
    'SKILL.md',
  );
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.filter((entry) => entry.path !== installedFile),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'migration-required');
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'unknown');
});

test('a no-repository inspection selects the verified installed bundle', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');

  const report = inspectDistributionSelection({
    ...fixture.options(),
    cwd: fixture.root,
  });
  assert.equal(report.repository, null);
  assert.equal(report.verdict, 'coherent-candidate');
  assert.equal(report.source, 'installed-bundle');
  assert.equal(report.selected?.sourceCommit, COMMIT_A);
  assert.equal(report.compatibility, 'compatible');
});

test('a local package pin cannot fall through without a Git worktree', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const policyPath = join(fixture.root, '.github', 'idd', 'config.json');
  fs.mkdirSync(dirname(policyPath), { recursive: true });
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      helperRuntime: {
        profile: 'vendored-node',
        packageSpec: `github:acme/app#${COMMIT_B}`,
      },
    }),
  );

  const report = inspectDistributionSelection({
    ...fixture.options(),
    cwd: fixture.root,
  });
  assert.equal(report.repository, null);
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'unknown');
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'unknown');
  assert.equal(report.recovery, 'reselect');
});

test('a local pin cannot fall through when GitHub identity is unavailable', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'same');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'same');
  fixture.pin('@acme/idd-skill@1.0.0');
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: fixture.repo });

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.repository, null);
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'unknown');
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'unknown');
  assert.equal(report.recovery, 'reselect');
});

test('an exact repository commit pin wins over a different global current', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.addPreparedSet(COMMIT_B, 'two');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  fixture.pin(`github:acme/app#${COMMIT_B}`);
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'pin-preserved');
  assert.equal(report.source, 'repository-pin');
  assert.equal(report.selected?.sourceCommit, COMMIT_B);
  assert.equal(report.packageVersion, null);
});

test('same-version prepared commits with matching bytes remain distinct', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'same');
  fixture.addPreparedSet(COMMIT_B, 'same');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'same');
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'distinct-builds');
  assert.equal(report.packageVersion, '1.0.0');
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'unknown');
});

test('explicit binding preserves its invocation after current moves and pin changes require migration', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.addPreparedSet(COMMIT_B, 'two');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const bound = bindDistributionSelection(fixture.options());
  assert.equal(bound.status, 'created');
  assert.equal(bound.authorized, true);
  assert.equal(bound.report.session.binding, 'bound');
  assert.equal(bound.report.verdict, 'session-bound');
  const receiptBeforeReuse = fs.readFileSync(
    join(fixture.dataRoot, 'receipt.json'),
  );
  const reused = bindDistributionSelection(fixture.options());
  assert.equal(reused.status, 'reused');
  assert.equal(reused.authorized, true);
  assert.equal(reused.report.verdict, 'session-bound');
  assert.deepEqual(reused.report.selected, bound.report.selected);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBeforeReuse,
  );

  fixture.installCurrent(COMMIT_B, '2.0.0', 'two');
  replacePreparedHelperInvocation(fixture, COMMIT_A, ['--changed-flag']);

  const afterMove = inspectDistributionSelection(fixture.options());
  assert.equal(afterMove.verdict, 'session-bound');
  assert.equal(afterMove.selected?.sourceCommit, COMMIT_A);
  assert.ok(afterMove.selected);
  assert.deepEqual(
    (
      afterMove.selected.components as {
        helper: { invocation: { argv: string[] } };
      }
    ).helper.invocation.argv,
    [],
  );
  assert.ok(afterMove.previousVerifiedSet);
  assert.deepEqual(
    (
      afterMove.previousVerifiedSet.components as {
        helper: { invocation: { argv: string[] } };
      }
    ).helper.invocation.argv,
    [],
  );

  fixture.pin(`github:acme/app#${COMMIT_B}`);
  const afterPinChange = inspectDistributionSelection(fixture.options());
  assert.equal(afterPinChange.verdict, 'migration-required');
  assert.equal(afterPinChange.previousVerifiedSet?.sourceCommit, COMMIT_A);
});

test('binding reuse refuses while the shared receipt lock is held', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');

  const lockPath = join(
    dirname(fixture.dataRoot),
    `.idd-user-global-${sha256(fixture.dataRoot)}.lock`,
  );
  fs.mkdirSync(lockPath);
  const result = bindDistributionSelection(fixture.options());
  assert.equal(result.status, 'refused');
  assert.equal(result.authorized, false);
  assert.match(result.reason ?? '', /prepared receipt lock exists/u);
});

test('bindings are distinct for separate sessions and repository clones', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.addPreparedSet(COMMIT_B, 'two');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  fixture.pin(`github:acme/app#${COMMIT_B}`);

  const first = bindDistributionSelection(fixture.options('session-one'));
  const second = bindDistributionSelection(fixture.options('session-two'));
  assert.equal(first.status, 'created');
  assert.equal(first.report.selected?.sourceCommit, COMMIT_B);
  assert.equal(second.status, 'created');
  assert.equal(second.report.selected?.sourceCommit, COMMIT_B);
  assert.equal(second.report.session.id, 'session-two');

  const clone = join(fixture.home, 'repo-clone');
  fs.mkdirSync(clone);
  execFileSync('git', ['init', '--quiet'], { cwd: clone });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/app.git'],
    {
      cwd: clone,
    },
  );
  fs.mkdirSync(join(clone, '.github', 'idd'), { recursive: true });
  fs.writeFileSync(
    join(clone, '.github', 'idd', 'config.json'),
    JSON.stringify({
      helperRuntime: {
        profile: 'vendored-node',
        packageSpec: `github:acme/app#${COMMIT_A}`,
      },
    }),
  );
  const cloneResult = bindDistributionSelection({
    ...fixture.options('session-one'),
    cwd: clone,
  });
  assert.equal(cloneResult.status, 'created');
  assert.equal(cloneResult.report.repository, 'acme/app');
  assert.equal(cloneResult.report.selected?.sourceCommit, COMMIT_A);
  assert.equal(cloneResult.report.session.binding, 'bound');

  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  const bindings = receipt.receipt.entries.filter(
    (entry) => entry.kind === 'file' && entry.path.includes('/.idd-selection-'),
  );
  assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings.map((entry) => entry.path)).size, 3);
});

test('an unowned linked binding destination is refused without replacement', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const key = sha256(
    JSON.stringify({
      repository: 'acme/app',
      mainWorktreeRoot: resolve(fixture.repo),
      sessionId: 'session-one',
    }),
  );
  const target = join(fixture.dataRoot, '1.0.0', `.idd-selection-${key}.json`);
  const outside = join(fixture.root, 'outside.json');
  fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, target);
  const result = bindDistributionSelection(fixture.options());
  assert.equal(result.authorized, false);
  assert.equal(result.status, 'refused');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});

test('an existing binding with an extra hard link is not trusted or rewritten', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  const binding = receipt.receipt.entries.find(
    (entry) => entry.kind === 'file' && entry.path.includes('/.idd-selection-'),
  );
  assert.ok(binding?.kind === 'file');
  const outside = join(fixture.root, 'hard-link-copy.json');
  fs.linkSync(binding.path, outside);

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  const refused = bindDistributionSelection(fixture.options());
  assert.equal(refused.status, 'refused');
  assert.equal(refused.authorized, false);
  assert.equal(
    fs.readFileSync(binding.path, 'utf8').includes('session-one'),
    true,
  );
});

test('edited binding bytes are preserved and make the selection unusable', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  const binding = receipt.receipt.entries.find(
    (entry) => entry.kind === 'file' && entry.path.includes('/.idd-selection-'),
  );
  assert.ok(binding?.kind === 'file');
  fs.writeFileSync(binding.path, '{"edited":true}\n');

  const before = fs.readFileSync(binding.path);
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  const refused = bindDistributionSelection(fixture.options());
  assert.equal(refused.status, 'refused');
  assert.deepEqual(fs.readFileSync(binding.path), before);
});

for (const [label, mutate] of [
  [
    'missing a component identity',
    (selected: BindingSelection) => {
      delete selected.components.helper;
    },
  ],
  [
    'missing a component provenance',
    (selected: BindingSelection) => {
      delete selected.components.instructions.provenance;
    },
  ],
  [
    'with a component provenance from another commit',
    (selected: BindingSelection) => {
      selected.components.skillBundles['idd-spec-audit'].provenance.commit =
        COMMIT_B;
    },
  ],
] as const) {
  test(`a receipt-owned binding selection ${label} is refused without an exception`, () => {
    const fixture = makeFixture();
    fixture.addPreparedSet(COMMIT_A, 'one');
    fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
    const created = bindDistributionSelection(fixture.options());
    assert.equal(created.status, 'created');
    const path = rewriteBindingSelection(fixture, mutate);
    const bindingBefore = fs.readFileSync(path);
    const receiptBefore = fs.readFileSync(
      join(fixture.dataRoot, 'receipt.json'),
    );

    const report = inspectDistributionSelection(fixture.options());
    assert.equal(report.session.binding, 'bound');
    assert.equal(report.verdict, 'not-verified-usable');
    assert.equal(report.receipt.status, 'conflict');
    assert.equal(report.selected, null);
    assert.equal(report.previousVerifiedSet, null);
    assert.equal(report.compatibility, 'incompatible');
    assert.equal(report.recovery, 'reselect');

    const refused = bindDistributionSelection(fixture.options());
    assert.equal(refused.status, 'refused');
    assert.equal(refused.authorized, false);
    assert.deepEqual(fs.readFileSync(path), bindingBefore);
    assert.deepEqual(
      fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
      receiptBefore,
    );
  });
}

test('a receipt binding path cannot traverse a symlink before opening', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const created = bindDistributionSelection(fixture.options());
  assert.equal(created.status, 'created');
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  const binding = receipt.receipt.entries.find(
    (entry) => entry.kind === 'file' && entry.path.includes('/.idd-selection-'),
  );
  assert.ok(binding?.kind === 'file');
  const bytes = fs.readFileSync(binding.path);
  const versionRoot = dirname(binding.path);
  const bindingName = binding.path.slice(versionRoot.length + 1);
  const outside = join(fixture.root, 'outside');
  const outsideNested = join(outside, 'nested');
  fs.mkdirSync(outsideNested, { recursive: true });
  fs.symlinkSync(outsideNested, join(versionRoot, 'link'), 'dir');
  fs.writeFileSync(join(outside, bindingName), bytes);
  fs.unlinkSync(binding.path);
  const traversingPath = `${versionRoot}/link/../${bindingName}`;
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.path === binding.path ? { ...entry, path: traversingPath } : entry,
    ),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  assert.equal(fs.readFileSync(join(outside, bindingName)).equals(bytes), true);
});

test('a receipt-write interruption reports the staged binding and never authorizes it', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const receiptBefore = fs.readFileSync(join(fixture.dataRoot, 'receipt.json'));
  const failingFs = {
    ...fs,
    renameSync: (() => {
      throw new Error('injected receipt replacement failure');
    }) as typeof fs.renameSync,
  } as FsOps;

  const result = bindDistributionSelection({
    ...fixture.options(),
    fs: failingFs,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.authorized, false);
  assert.equal(result.stagedPath?.includes('.idd-selection-'), true);
  assert.equal(fs.existsSync(result.stagedPath as string), true);
  assert.deepEqual(
    fs.readFileSync(join(fixture.dataRoot, 'receipt.json')),
    receiptBefore,
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  const retry = bindDistributionSelection(fixture.options());
  assert.equal(retry.status, 'refused');
  assert.equal(retry.authorized, false);
  assert.equal(fs.existsSync(result.stagedPath as string), true);
});

test('an unsafe version-directory parent prevents binding', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const versionRoot = join(fixture.dataRoot, '1.0.0');
  const outsideVersion = join(fixture.root, 'outside-version');
  fs.renameSync(versionRoot, outsideVersion);
  fs.symlinkSync(outsideVersion, versionRoot, 'dir');

  const result = bindDistributionSelection(fixture.options());
  assert.equal(result.status, 'refused');
  assert.equal(result.authorized, false);
  assert.equal(fs.lstatSync(versionRoot).isSymbolicLink(), true);
  assert.equal(
    fs.existsSync(
      join(
        outsideVersion,
        '.idd-selection-' +
          sha256(
            JSON.stringify({
              repository: 'acme/app',
              mainWorktreeRoot: resolve(fixture.repo),
              sessionId: 'session-one',
            }),
          ) +
          '.json',
      ),
    ),
    false,
  );
});

test('a corrupt helper invocation makes its prepared set unusable', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const manifestPath = join(fixture.preparedRoot, COMMIT_A, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    components: { helper: { invocation: { command: string } } };
  };
  manifest.components.helper.invocation.command = 'scripts/missing.mjs';
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, bytes);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.map((entry) =>
      entry.kind === 'file' && entry.path === manifestPath
        ? { ...entry, sha256: sha256(bytes) }
        : entry,
    ),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  assert.equal(report.preparation, 'not-applicable');
  assert.equal(report.recovery, 'reselect');
  assert.equal(report.selected, null);
});

test('a pinned identity with absent prepared files reports preparation-missing', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  fixture.pin(`github:acme/app#${COMMIT_A}`);
  const missingPath = join(
    fixture.preparedRoot,
    COMMIT_A,
    'skills',
    'issue-authoring',
    'SKILL.md',
  );
  fs.unlinkSync(missingPath);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.filter((entry) => entry.path !== missingPath),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'preparation-missing');
  assert.equal(report.source, 'repository-pin');
  assert.equal(report.selected?.sourceCommit, COMMIT_A);
  assert.equal(report.preparation, 'preparation-missing');
  assert.equal(report.recovery, 'prepare');
  const bind = bindDistributionSelection(fixture.options());
  assert.equal(bind.status, 'refused');
  assert.equal(bind.authorized, false);
});

test('a bound identity stays visible when its prepared files go missing', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const bound = bindDistributionSelection(fixture.options());
  assert.equal(bound.status, 'created');
  replacePreparedHelperInvocation(fixture, COMMIT_A, ['--changed-flag']);
  const missingPath = join(
    fixture.preparedRoot,
    COMMIT_A,
    'skills',
    'idd-spec-audit',
    'SKILL.md',
  );
  fs.unlinkSync(missingPath);
  const receipt = readReceipt(fixture.dataRoot);
  assert.equal(receipt.state, 'valid');
  writeReceipt(
    fixture.dataRoot,
    receipt.receipt.entries.filter((entry) => entry.path !== missingPath),
  );

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.session.binding, 'bound');
  assert.equal(report.verdict, 'preparation-missing');
  assert.equal(report.selected?.sourceCommit, COMMIT_A);
  assert.equal(report.previousVerifiedSet?.sourceCommit, COMMIT_A);
  assert.ok(report.selected);
  assert.deepEqual(
    (
      report.selected.components as {
        helper: { invocation: { argv: string[] } };
      }
    ).helper.invocation.argv,
    [],
  );
  assert.ok(report.previousVerifiedSet);
  assert.deepEqual(
    (
      report.previousVerifiedSet.components as {
        helper: { invocation: { argv: string[] } };
      }
    ).helper.invocation.argv,
    [],
  );
  assert.equal(report.recovery, 'prepare');
});

test('an invalid bound manifest is not reported as a migration requirement', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'one');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'one');
  const bound = bindDistributionSelection(fixture.options());
  assert.equal(bound.status, 'created');
  replacePreparedSourceCommit(fixture, COMMIT_A, COMMIT_B);

  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.session.binding, 'bound');
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.receipt.status, 'conflict');
  assert.equal(report.previousVerifiedSet?.sourceCommit, COMMIT_A);
  assert.equal(report.selected, null);
  assert.equal(report.compatibility, 'incompatible');
  assert.equal(report.recovery, 'reselect');
});

test('a version-only pin cannot preserve one matching prepared commit', () => {
  const fixture = makeFixture();
  fixture.addPreparedSet(COMMIT_A, 'same');
  fixture.installCurrent(COMMIT_A, '1.0.0', 'same');
  fixture.pin('@acme/idd-skill@1.0.0');
  const report = inspectDistributionSelection(fixture.options());
  assert.equal(report.verdict, 'not-verified-usable');
  assert.equal(report.source, 'repository-pin');
  assert.equal(report.selected, null);
});
