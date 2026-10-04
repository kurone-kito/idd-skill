import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBareSpecifiers } from '../src/scripts/lint-source-boundaries.mts';
import { ONBOARDING_HEARING_CATALOG_RELATIVE_PATH } from '../src/scripts/onboarding-hearing.mts';
import { LIVE_INSTANCE_CASES } from '../src/scripts/validate-schemas.mts';

// #3751: `validate-schemas` owns the schema and live-instance validation that
// the schema suites used to run against the real checkout. These tests drive
// its CLI over scratch trees seeded with copies of a few real files, so a
// violation of each kind is proven by a fixture and the live enforcement stays
// in `audit:schemas`.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(REPO_ROOT, 'scripts', 'validate-schemas.mjs');

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The real files a minimal scratch tree is seeded from. */
const SEED_FILES = [
  'schemas/phase-graph.schema.json',
  'schemas/onboarding-hearing-catalog.schema.json',
  'schemas/policy.schema.json',
  'fixtures/schemas/phase-graph.valid.json',
  'fixtures/schemas/phase-graph.invalid.json',
  'fixtures/schemas/onboarding-hearing-catalog.valid.json',
  'fixtures/schemas/onboarding-hearing-catalog.invalid.json',
  'fixtures/schemas/policy.valid.json',
  'fixtures/schemas/policy.invalid.json',
  'schemas/phase-graph.json',
  'idd-template/docs/onboarding/hearing-catalog.json',
  '.github/idd/config.json',
] as const;

type TreeFiles = Map<string, string>;

function seedTree(): TreeFiles {
  return new Map(
    SEED_FILES.map((path) => [
      path,
      readFileSync(join(REPO_ROOT, path), 'utf8'),
    ]),
  );
}

function writeTree(files: TreeFiles): string {
  const root = mkdtempSync(join(tmpdir(), 'idd-validate-schemas-'));
  createdDirs.push(root);
  for (const [path, content] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function runCli(
  args: string[],
  options: { cwd?: string; script?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [options.script ?? CLI, ...args], {
    cwd: options.cwd ?? tmpdir(),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function snapshot(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(result, snapshot(root, relative));
    } else {
      result[relative] = readFileSync(join(root, relative), 'utf8');
    }
  }
  return result;
}

function mutateJson(
  files: TreeFiles,
  path: string,
  change: (document: Record<string, unknown>) => void,
): void {
  const document = JSON.parse(files.get(path) as string) as Record<
    string,
    unknown
  >;
  change(document);
  files.set(path, JSON.stringify(document));
}

test('a tree with valid schemas, fixture pairs and live instances passes read-only', () => {
  const root = writeTree(seedTree());
  const before = snapshot(root);
  const { status, stdout, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
  for (const { fixturePath } of LIVE_INSTANCE_CASES) {
    assert.ok(stdout.includes(`✓  ${fixturePath} (valid)`), stdout);
  }
  assert.match(stdout, /All cases passed\./);
  assert.deepEqual(snapshot(root), before);
});

test('the live instance list names the policy config, the phase graph data and the live hearing catalog', () => {
  assert.deepEqual(
    LIVE_INSTANCE_CASES.map(({ schemaPath, fixturePath, expectValid }) => [
      schemaPath,
      fixturePath,
      expectValid,
    ]),
    [
      ['schemas/phase-graph.schema.json', 'schemas/phase-graph.json', true],
      [
        'schemas/onboarding-hearing-catalog.schema.json',
        ONBOARDING_HEARING_CATALOG_RELATIVE_PATH,
        true,
      ],
      ['schemas/policy.schema.json', '.github/idd/config.json', true],
    ],
  );
});

interface FailureCase {
  name: string;
  edit: (files: TreeFiles) => void;
  /** A fragment the failing line must carry (the path and what failed). */
  expected: RegExp;
}

const FAILURE_CASES: FailureCase[] = [
  {
    name: 'a policy config that the policy schema rejects',
    edit: (files) =>
      mutateJson(files, '.github/idd/config.json', (config) => {
        config.unknownTopLevelKey = true;
      }),
    expected: /^✗ {2}\.github\/idd\/config\.json \(valid\): /m,
  },
  {
    name: 'a phase graph whose next target does not exist',
    edit: (files) =>
      mutateJson(files, 'schemas/phase-graph.json', (graph) => {
        const nodes = graph.nodes as { next: string[] }[];
        (nodes[0] as { next: string[] }).next = ['Z9'];
      }),
    expected: /^✗ {2}schemas\/phase-graph\.json \(valid\): .*Z9/m,
  },
  {
    name: 'a live hearing catalog that its schema rejects',
    edit: (files) =>
      mutateJson(
        files,
        'idd-template/docs/onboarding/hearing-catalog.json',
        (catalog) => {
          delete catalog.version;
        },
      ),
    expected:
      /^✗ {2}idd-template\/docs\/onboarding\/hearing-catalog\.json \(valid\): /m,
  },
  {
    name: 'a hearing schema that uses a keyword the validator does not enforce',
    edit: (files) =>
      mutateJson(
        files,
        'schemas/onboarding-hearing-catalog.schema.json',
        (schema) => {
          schema.oneOf = [];
        },
      ),
    expected: /^✗ {2}\S+ \(valid\): Schema has unsupported keywords: .*oneOf/m,
  },
  {
    name: 'an invalid fixture that unexpectedly passes validation',
    edit: (files) =>
      files.set(
        'fixtures/schemas/policy.invalid.json',
        files.get('fixtures/schemas/policy.valid.json') as string,
      ),
    expected:
      /^✗ {2}fixtures\/schemas\/policy\.invalid\.json \(invalid\): Expected validation failure/m,
  },
  {
    name: 'a live instance file that is missing',
    edit: (files) => files.delete('.github/idd/config.json'),
    expected: /^✗ {2}\.github\/idd\/config\.json \(valid\): cannot read /m,
  },
  {
    name: 'a live instance file that is not JSON',
    edit: (files) => files.set('schemas/phase-graph.json', '{ not json'),
    expected: /^✗ {2}schemas\/phase-graph\.json \(valid\): cannot read /m,
  },
  {
    name: 'a schema that has no fixture pair',
    edit: (files) =>
      files.set('schemas/extra.schema.json', '{"type":"object"}'),
    expected: /^✗ {2}schemas\/extra\.schema\.json: missing fixture\(s\) /m,
  },
  {
    name: 'a schema inventory with no schema at all (an empty inventory)',
    edit: (files) => {
      for (const path of [...files.keys()]) {
        if (path.endsWith('.schema.json')) {
          files.delete(path);
        }
      }
      files.set('schemas/README.md', 'nothing to validate\n');
    },
    expected: /^✗ {2}schemas: no \*\.schema\.json file to validate/m,
  },
];

for (const { name, edit, expected } of FAILURE_CASES) {
  test(`the CLI fails with the path and reason for ${name}`, () => {
    const files = seedTree();
    edit(files);
    const { status, stderr } = runCli(['--root', writeTree(files)]);
    assert.equal(status, 1, stderr);
    assert.match(stderr, expected);
  });
}

test('a missing schemas directory fails closed instead of crashing', () => {
  const files = seedTree();
  for (const path of [...files.keys()]) {
    if (path.startsWith('schemas/')) {
      files.delete(path);
    }
  }
  const { status, stderr } = runCli(['--root', writeTree(files)]);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /^✗ {2}schemas: cannot list the schema inventory/m);
});

test('--help prints usage, and a usage error exits 2 without validating anything', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node scripts\/validate-schemas\.mjs/);

  const unknown = runCli(['--no-such-flag']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --no-such-flag/);

  for (const args of [['--root'], ['--root', '--help']]) {
    const missing = runCli(args);
    assert.equal(missing.status, 2, args.join(' '));
    assert.match(missing.stderr, /--root requires a directory path/);
  }
});

test('the CLI runs with bare Node from a tree that has no node_modules', () => {
  // The scratch tree carries its own copy of the CLI and its two sibling
  // modules, plus the policy schema as the bundle-root marker, so the CLI's
  // default root resolves to the scratch tree itself.
  const files = seedTree();
  const root = writeTree(files);
  mkdirSync(join(root, 'scripts'));
  for (const name of [
    'validate-schemas.mjs',
    'node-runtime-guard.mjs',
    'bundle-root.mjs',
  ]) {
    copyFileSync(join(REPO_ROOT, 'scripts', name), join(root, 'scripts', name));
    // The whole closure imports only `node:` builtins and its own siblings.
    assert.deepEqual(
      findBareSpecifiers(readFileSync(join(root, 'scripts', name), 'utf8')),
      [],
      name,
    );
  }
  const env = { ...process.env };
  delete env.NODE_PATH;
  const run = (): { status: number | null; stderr: string } => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'validate-schemas.mjs')],
      { cwd: root, env, encoding: 'utf8' },
    );
    return { status: result.status, stderr: result.stderr };
  };
  assert.equal(run().status, 0);

  writeFileSync(
    join(root, 'schemas', 'phase-graph.json'),
    JSON.stringify({ nodes: [{ id: 'x', next: ['missing'] }] }),
  );
  const failing = run();
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stderr, /schemas\/phase-graph\.json \(valid\)/);
});
