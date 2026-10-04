import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractImportSpecifiers } from '../src/scripts/lint-source-boundaries.mts';
import {
  detectJournalPatternDrift,
  detectOutputCoverageDrift,
  detectPhaseGraphNormalizationDrift,
  detectPlaceholderDocDrift,
  detectResumeRouteDrift,
  detectSchemaCatalogDrift,
  detectStep1bCompanionDrift,
  extractDocumentedPlaceholders,
  extractH2Section,
  extractRegexLiteralSource,
  extractResumeDecisionRoutes,
  extractResumeRouteEnum,
  ONBOARDING_STEP1B_COMPANIONS,
  type PhaseResolver,
  SCHEMA_OUTPUT_COVERAGE,
  SCHEMA_TYPE_CATALOG,
} from '../src/scripts/repository-schema-audit.mts';
import { fixtureEnv } from './test-utils.mts';

// #3751: the schema and onboarding catalog agreements that five suites used to
// check against the real checkout now run as the repository schema audit
// (`audit-docs --check`, or this CLI). The CLI tests below drive scratch trees
// built from the shared catalog; the detector tests keep every matcher edge
// case without reading the real repository.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(REPO_ROOT, 'scripts', 'repository-schema-audit.mjs');

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

type TreeFiles = Map<string, string>;

const PLACEHOLDER_NAMES = ['REPO_NAME', 'PROJECT_MARKER_PREFIX'] as const;
const JOURNAL_PATTERN = '^[\\w.-]+/[\\w.-]+#[1-9][0-9]*$';

/** A tree that satisfies every rule, keyed by repository-relative path. */
function cleanTree(): TreeFiles {
  const files: TreeFiles = new Map();
  for (const { schemaFile } of SCHEMA_TYPE_CATALOG) {
    files.set(`schemas/${schemaFile}`, '{}');
  }
  files.set(
    'schemas/policy.schema.json',
    JSON.stringify({
      properties: {
        issueAuthoring: {
          properties: { journalIssue: { pattern: JOURNAL_PATTERN } },
        },
      },
    }),
  );
  files.set(
    'schemas/phase-graph.json',
    JSON.stringify({
      nodes: [
        { id: 'D1', next: ['D4'] },
        { id: 'D4', next: ['E1'] },
        { id: 'E1', next: [] },
      ],
    }),
  );
  files.set(
    'src/scripts/audit-authored-issue.mts',
    `export const REAL_ISSUE_REFERENCE_PATTERN = ${`/^[\\w.-]+\\/[\\w.-]+#[1-9][0-9]*$/`};\n`,
  );
  files.set(
    'idd-template/docs/onboarding/hearing-catalog.json',
    JSON.stringify({
      items: [
        { id: 'gh-cli', kind: 'check' },
        ...PLACEHOLDER_NAMES.map((name) => ({
          id: name,
          kind: 'placeholder',
          mapsToPlaceholder: name,
        })),
      ],
    }),
  );
  files.set(
    'idd-template/docs/onboarding/placeholders.md',
    [
      '## Final placeholder meanings',
      '',
      '| Placeholder | Meaning | Example |',
      '| --- | --- | --- |',
      ...PLACEHOLDER_NAMES.map(
        (name) => `| \`{{${name}}}\` | meaning of ${name} | \`value\` |`,
      ),
      '',
    ].join('\n'),
  );
  files.set('idd-template/docs/onboarding/policy-decisions.md', policyDoc());
  files.set(
    'src/scripts/resume-route-selection.mts',
    [
      'const HELP = `{ "route": "D1|E1|Esync|stop" }`;',
      "const table = [{ route: 'D1' }, { route: 'E1' }, { route: 'Esync' }, { route: 'stop' }];",
      '',
    ].join('\n'),
  );
  return files;
}

/** A policy guide whose two decision sections carry every companion needle. */
function policyDoc(omit: readonly string[] = []): string {
  const needles = Object.values(ONBOARDING_STEP1B_COMPANIONS).filter(
    (needle) => !omit.includes(needle),
  );
  return [
    '# Policy decisions',
    '',
    '## Decisions that require explicit operator confirmation',
    '',
    ...needles.slice(0, 8),
    '',
    '## Related default policies to confirm',
    '',
    ...needles.slice(8),
    '',
    '## Something else',
    '',
    ...omit,
    '',
  ].join('\n');
}

function writeTree(files: TreeFiles): string {
  const root = scratchDir('idd-schema-audit-');
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

/** `<RULE-ID> <path>` pairs the CLI printed on stderr. */
function reportedRules(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => /^(\S+) (\S+): /.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]} ${match[2]}`);
}

test('a tree that satisfies every rule passes read-only and reports what each rule inspected', () => {
  const root = writeTree(cleanTree());
  const before = snapshot(root);
  const { status, stdout, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  const expected = new Map([
    ['SCHEMA-TYPE-CATALOG', SCHEMA_TYPE_CATALOG.length],
    ['SCHEMA-OUTPUT-COVERAGE', SCHEMA_TYPE_CATALOG.length],
    ['SCHEMA-JOURNAL-PATTERN', 1],
    ['HEARING-PLACEHOLDER-DOC', PLACEHOLDER_NAMES.length],
    [
      'HEARING-STEP1B-COMPANION',
      Object.keys(ONBOARDING_STEP1B_COMPANIONS).length,
    ],
    ['PHASE-GRAPH-NORMALIZED', 3],
    ['RESUME-ROUTE-ENUM', 4],
  ]);
  for (const [ruleId, count] of expected) {
    assert.ok(
      stdout.includes(
        `repository-schema-audit: ${ruleId} inspected ${count}\n`,
      ),
      `${ruleId} should have inspected ${count}:\n${stdout}`,
    );
  }
  assert.match(stdout, /all schema agreements passed/);
  assert.deepEqual(snapshot(root), before);
});

function snapshot(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(result, snapshot(root, path));
    } else {
      result[path] = readFileSync(join(root, path), 'utf8');
    }
  }
  return result;
}

interface ViolationCase {
  name: string;
  edit: (files: TreeFiles) => void;
  /** Every `<RULE-ID> <path>` the CLI must report, in order. */
  expected: string[];
}

const VIOLATION_CASES: ViolationCase[] = [
  {
    name: 'a schema file that no catalog or ledger names',
    edit: (files) => files.set('schemas/brand-new.schema.json', '{}'),
    expected: [
      'SCHEMA-OUTPUT-COVERAGE schemas/brand-new.schema.json',
      'SCHEMA-TYPE-CATALOG schemas/brand-new.schema.json',
    ],
  },
  {
    name: 'a stray non-schema file in schemas',
    edit: (files) => files.set('schemas/notes.txt', 'stray'),
    expected: ['SCHEMA-TYPE-CATALOG schemas/notes.txt'],
  },
  {
    name: 'a catalog schema file that is missing from schemas',
    edit: (files) => files.delete('schemas/claim-marker.schema.json'),
    expected: [
      'SCHEMA-OUTPUT-COVERAGE schemas/claim-marker.schema.json',
      'SCHEMA-TYPE-CATALOG schemas/claim-marker.schema.json',
    ],
  },
  {
    name: 'the phase graph data file missing from schemas',
    edit: (files) => files.delete('schemas/phase-graph.json'),
    expected: [
      'PHASE-GRAPH-NORMALIZED-INSPECTION schemas/phase-graph.json',
      'SCHEMA-TYPE-CATALOG schemas/phase-graph.json',
    ],
  },
  {
    name: 'a journal pattern that drifted from the policy schema',
    edit: (files) =>
      files.set(
        'src/scripts/audit-authored-issue.mts',
        `export const REAL_ISSUE_REFERENCE_PATTERN = ${`/^[\\w.-]+\\/[\\w.-]+#[0-9]+$/`};\n`,
      ),
    expected: ['SCHEMA-JOURNAL-PATTERN src/scripts/audit-authored-issue.mts'],
  },
  {
    name: 'a placeholder row removed from the documented table',
    edit: (files) =>
      files.set(
        'idd-template/docs/onboarding/placeholders.md',
        (files.get('idd-template/docs/onboarding/placeholders.md') as string)
          .split('\n')
          .filter((line) => !line.includes('PROJECT_MARKER_PREFIX'))
          .join('\n'),
      ),
    expected: [
      'HEARING-PLACEHOLDER-DOC idd-template/docs/onboarding/placeholders.md',
    ],
  },
  {
    name: 'a Step 1B companion heading removed from the guide',
    edit: (files) =>
      files.set(
        'idd-template/docs/onboarding/policy-decisions.md',
        policyDoc(['### Merge policy']),
      ),
    expected: [
      'HEARING-STEP1B-COMPANION idd-template/docs/onboarding/policy-decisions.md',
    ],
  },
  {
    name: 'phase ids that collide once normalized',
    edit: (files) =>
      files.set(
        'schemas/phase-graph.json',
        JSON.stringify({
          nodes: [
            { id: 'D1', next: ['D4'] },
            { id: 'D4', next: [] },
            { id: 'd4', next: [] },
          ],
        }),
      ),
    expected: ['PHASE-GRAPH-NORMALIZED schemas/phase-graph.json'],
  },
  {
    name: 'a phase graph edge that names no node',
    edit: (files) =>
      files.set(
        'schemas/phase-graph.json',
        JSON.stringify({ nodes: [{ id: 'D1', next: ['Z9'] }] }),
      ),
    expected: ['PHASE-GRAPH-NORMALIZED schemas/phase-graph.json'],
  },
  {
    name: 'a documented resume route that the decision table lacks',
    edit: (files) =>
      files.set(
        'src/scripts/resume-route-selection.mts',
        [
          'const HELP = `{ "route": "D1|E1|Esync|F1|stop" }`;',
          "const table = [{ route: 'D1' }, { route: 'E1' }, { route: 'Esync' }, { route: 'stop' }];",
        ].join('\n'),
      ),
    expected: ['RESUME-ROUTE-ENUM src/scripts/resume-route-selection.mts'],
  },
  {
    name: 'a resume route that is only a legacy alias of a phase (two findings)',
    edit: (files) =>
      files.set(
        'src/scripts/resume-route-selection.mts',
        [
          'const HELP = `{ "route": "D1|E1|Esync|A4.5|stop" }`;',
          "const table = [{ route: 'D1' }, { route: 'E1' }, { route: 'Esync' }, { route: 'A4.5' }, { route: 'stop' }];",
        ].join('\n'),
      ),
    expected: [
      'RESUME-ROUTE-ENUM src/scripts/resume-route-selection.mts',
      'RESUME-ROUTE-ENUM src/scripts/resume-route-selection.mts',
    ],
  },
];

for (const { name, edit, expected } of VIOLATION_CASES) {
  test(`the CLI fails with the rule ID and relative path for ${name}`, () => {
    const files = cleanTree();
    edit(files);
    const { status, stderr } = runCli(['--root', writeTree(files)]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), expected, stderr);
    assert.match(
      stderr,
      new RegExp(
        `repository-schema-audit: ${expected.length} violation\\(s\\)`,
      ),
    );
  });
}

interface InspectionCase {
  name: string;
  edit: (files: TreeFiles) => void;
  /** The `<RULE-ID> <path>:` prefix of an expected stderr line. */
  expected: string;
}

const INSPECTION_CASES: InspectionCase[] = [
  {
    name: 'a missing schemas directory',
    edit: (files) => {
      for (const path of [...files.keys()]) {
        if (path.startsWith('schemas/')) {
          files.delete(path);
        }
      }
    },
    expected: 'SCHEMA-TYPE-CATALOG-INSPECTION schemas:',
  },
  {
    name: 'a schemas directory with no schema file (an empty inventory)',
    edit: (files) => {
      for (const path of [...files.keys()]) {
        if (path.endsWith('.schema.json')) {
          files.delete(path);
        }
      }
    },
    expected: 'SCHEMA-OUTPUT-COVERAGE-INSPECTION schemas:',
  },
  {
    name: 'a schemas directory with no schema file (the type catalog rule too)',
    edit: (files) => {
      for (const path of [...files.keys()]) {
        if (path.endsWith('.schema.json')) {
          files.delete(path);
        }
      }
    },
    expected: 'SCHEMA-TYPE-CATALOG-INSPECTION schemas:',
  },
  {
    name: 'a policy schema that is not JSON',
    edit: (files) => files.set('schemas/policy.schema.json', '{ not json'),
    expected: 'SCHEMA-JOURNAL-PATTERN-INSPECTION schemas/policy.schema.json:',
  },
  {
    name: 'a policy schema without the journal pattern',
    edit: (files) => files.set('schemas/policy.schema.json', '{}'),
    expected: 'SCHEMA-JOURNAL-PATTERN-INSPECTION schemas/policy.schema.json:',
  },
  {
    name: 'a source file without the reference pattern literal',
    edit: (files) =>
      files.set('src/scripts/audit-authored-issue.mts', 'export {};\n'),
    expected:
      'SCHEMA-JOURNAL-PATTERN-INSPECTION src/scripts/audit-authored-issue.mts:',
  },
  {
    name: 'a hearing catalog with no placeholder item',
    edit: (files) =>
      files.set(
        'idd-template/docs/onboarding/hearing-catalog.json',
        JSON.stringify({ items: [{ id: 'gh-cli', kind: 'check' }] }),
      ),
    expected:
      'HEARING-PLACEHOLDER-DOC-INSPECTION idd-template/docs/onboarding/hearing-catalog.json:',
  },
  {
    name: 'a hearing catalog that is missing',
    edit: (files) =>
      files.delete('idd-template/docs/onboarding/hearing-catalog.json'),
    expected:
      'HEARING-PLACEHOLDER-DOC-INSPECTION idd-template/docs/onboarding/hearing-catalog.json:',
  },
  {
    name: 'a policy guide that is missing',
    edit: (files) =>
      files.delete('idd-template/docs/onboarding/policy-decisions.md'),
    expected:
      'HEARING-STEP1B-COMPANION-INSPECTION idd-template/docs/onboarding/policy-decisions.md:',
  },
  {
    name: 'a phase graph with no nodes',
    edit: (files) =>
      files.set('schemas/phase-graph.json', JSON.stringify({ nodes: [] })),
    expected: 'PHASE-GRAPH-NORMALIZED-INSPECTION schemas/phase-graph.json:',
  },
  {
    name: 'a resume helper that documents no route enum',
    edit: (files) =>
      files.set('src/scripts/resume-route-selection.mts', 'export {};\n'),
    expected:
      'RESUME-ROUTE-ENUM-INSPECTION src/scripts/resume-route-selection.mts:',
  },
  {
    name: 'a resume helper that documents routes but lists no decision table literal',
    edit: (files) =>
      files.set(
        'src/scripts/resume-route-selection.mts',
        'const HELP = `{ "route": "D1|E1|Esync|stop" }`;\n',
      ),
    expected:
      'RESUME-ROUTE-ENUM-INSPECTION src/scripts/resume-route-selection.mts:',
  },
  {
    name: 'a resume helper that is missing',
    edit: (files) => files.delete('src/scripts/resume-route-selection.mts'),
    expected:
      'RESUME-ROUTE-ENUM-INSPECTION src/scripts/resume-route-selection.mts:',
  },
];

for (const { name, edit, expected } of INSPECTION_CASES) {
  test(`an incomplete inspection fails closed for ${name}`, () => {
    const files = cleanTree();
    edit(files);
    const { status, stderr } = runCli(['--root', writeTree(files)]);
    assert.equal(status, 1, stderr);
    assert.ok(
      stderr.split('\n').some((line) => line.startsWith(expected)),
      stderr,
    );
  });
}

test('--help prints usage, and a usage error exits 2 without inspecting anything', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /^usage: node scripts\/repository-schema-audit\.mjs/,
  );

  const unknown = runCli(['--no-such-flag']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --no-such-flag/);

  for (const args of [['--root'], ['--root', '--help']]) {
    const missing = runCli(args);
    assert.equal(missing.status, 2, args.join(' '));
    assert.match(missing.stderr, /--root requires a directory path/);
  }
});

/** Every generated script reachable from `entry` through relative imports. */
function scriptClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const text = readFileSync(join(REPO_ROOT, 'scripts', name), 'utf8');
    for (const specifier of extractImportSpecifiers(text)) {
      if (specifier.startsWith('./')) {
        queue.push(specifier.slice(2));
      } else {
        // Only `node:` builtins may leave the closure.
        assert.ok(
          specifier.startsWith('node:'),
          `${name} imports ${specifier}`,
        );
      }
    }
  }
  return [...seen].sort();
}

test('the CLI runs with bare Node from a copy that has no node_modules', () => {
  const bare = scratchDir('idd-schema-audit-bare-');
  const scripts = join(bare, 'scripts');
  mkdirSync(scripts);
  const closure = scriptClosure('repository-schema-audit.mjs');
  assert.ok(closure.includes('phase-id-resolver.mjs'), closure.join(', '));
  for (const name of closure) {
    copyFileSync(join(REPO_ROOT, 'scripts', name), join(scripts, name));
  }
  const env = { ...process.env };
  delete env.NODE_PATH;
  const script = join(scripts, 'repository-schema-audit.mjs');
  const run = (root: string) => {
    const result = spawnSync(process.execPath, [script, '--root', root], {
      cwd: bare,
      env,
      encoding: 'utf8',
    });
    return { status: result.status, stderr: result.stderr };
  };
  const clean = run(writeTree(cleanTree()));
  assert.equal(clean.status, 0, clean.stderr);
  const files = cleanTree();
  files.set('schemas/notes.txt', 'stray');
  const failing = run(writeTree(files));
  assert.equal(failing.status, 1, failing.stderr);
  assert.deepEqual(reportedRules(failing.stderr), [
    'SCHEMA-TYPE-CATALOG schemas/notes.txt',
  ]);
});

// ---------------------------------------------------------------------------
// Detector cases (no repository reads): every edge case the replaced
// assertions covered, plus the pure matchers they relied on.
// ---------------------------------------------------------------------------

const catalogOf = (...files: string[]) =>
  files.map((schemaFile) => ({ schemaFile }));

test('detectSchemaCatalogDrift flags unmapped, stale, duplicated and stray entries, and accepts an exact mapping', () => {
  assert.deepEqual(
    detectSchemaCatalogDrift(
      ['a.schema.json', 'b.schema.json', 'phase-graph.json'],
      catalogOf('a.schema.json', 'b.schema.json'),
    ),
    [],
  );
  const rules = detectSchemaCatalogDrift(
    ['a.schema.json', 'c.schema.json', 'readme.txt'],
    catalogOf('a.schema.json', 'a.schema.json', 'gone.schema.json'),
  ).map((item) => `${item.path}: ${item.message.split(';')[0]}`);
  assert.deepEqual(rules, [
    'schemas/c.schema.json: is not mapped to an exported type',
    'schemas/a.schema.json: SCHEMA_TYPE_CATALOG lists this schema file more than once',
    'schemas/gone.schema.json: SCHEMA_TYPE_CATALOG references a schema file that does not exist',
    'schemas/readme.txt: is not a schema',
    'schemas/phase-graph.json: the phase-graph.json data file is missing from schemas/',
  ]);
});

test('detectOutputCoverageDrift flags a missing, stale or duplicated ledger entry and empty builder or reason text', () => {
  const covered = (schema: string, builder = 'build (x.mts)') =>
    ({ schema, status: 'covered', builder }) as const;
  const uncovered = (schema: string, reason = 'why not') =>
    ({ schema, status: 'uncovered', reason }) as const;
  assert.deepEqual(
    detectOutputCoverageDrift(
      ['a.schema.json', 'b.schema.json'],
      [covered('a.schema.json'), uncovered('b.schema.json')],
    ),
    [],
  );
  const messages = detectOutputCoverageDrift(
    ['a.schema.json', 'b.schema.json', 'c.schema.json'],
    [
      covered('a.schema.json', '  '),
      uncovered('b.schema.json', ''),
      covered('b.schema.json'),
      covered('gone.schema.json'),
    ],
  ).map((item) => `${item.path}: ${item.message.split(';')[0]}`);
  assert.deepEqual(messages, [
    'schemas/c.schema.json: has no SCHEMA_OUTPUT_COVERAGE entry',
    'schemas/a.schema.json: a covered entry must name a builder',
    'schemas/b.schema.json: an uncovered entry must give a one-line reason',
    'schemas/b.schema.json: SCHEMA_OUTPUT_COVERAGE must not list the same schema twice',
    'schemas/gone.schema.json: SCHEMA_OUTPUT_COVERAGE names a schema file that does not exist',
  ]);
});

test('the shipped ledger is non-empty, unique, and every covered entry names a builder', () => {
  const names = SCHEMA_OUTPUT_COVERAGE.map((entry) => entry.schema);
  assert.ok(names.length > 0);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    detectOutputCoverageDrift(names, SCHEMA_OUTPUT_COVERAGE),
    [],
  );
});

test('extractRegexLiteralSource reads a regex literal with escaped slashes, classes and flags', () => {
  const source = [
    'const OTHER = /x/;',
    'export const PATTERN = /^[\\w.-]+\\/[\\w.-]+#[1-9][0-9]*$/u;',
    'export const WITH_SLASH_CLASS: RegExp = /a[/]b\\/c/;',
  ].join('\n');
  assert.equal(
    extractRegexLiteralSource(source, 'PATTERN'),
    '^[\\w.-]+\\/[\\w.-]+#[1-9][0-9]*$',
  );
  assert.equal(
    extractRegexLiteralSource(source, 'WITH_SLASH_CLASS'),
    'a[/]b\\/c',
  );
  assert.equal(extractRegexLiteralSource(source, 'MISSING'), null);
});

test('detectJournalPatternDrift compares after normalizing the escaped slash only', () => {
  assert.deepEqual(
    detectJournalPatternDrift('^[\\w.-]+\\/x$', '^[\\w.-]+/x$'),
    [],
  );
  assert.equal(
    detectJournalPatternDrift('^[\\w.-]+\\/x$', '^[\\w.-]+/y$').length,
    1,
  );
});

test('extractDocumentedPlaceholders reads only table rows of the placeholder form', () => {
  const doc = [
    '| Placeholder | Meaning |',
    '| `{{REPO_NAME}}` | the name |',
    '| `{{PRE_PUSH_VALIDATE_COMMANDS}}`   | a row |',
    '| `{{lower}}` | not a placeholder name |',
    'prose `{{REPO_NAME}}` | not a row',
  ].join('\n');
  assert.deepEqual(extractDocumentedPlaceholders(doc), [
    'REPO_NAME',
    'PRE_PUSH_VALIDATE_COMMANDS',
  ]);
});

test('detectPlaceholderDocDrift requires the same names in the same order', () => {
  assert.deepEqual(detectPlaceholderDocDrift(['A', 'B'], ['A', 'B']), []);
  assert.equal(detectPlaceholderDocDrift(['A', 'B'], ['B', 'A']).length, 1);
  assert.equal(detectPlaceholderDocDrift(['A'], ['A', 'B']).length, 1);
});

test('extractH2Section stops at the next level-two heading and is null for a missing one', () => {
  const doc = '## One\nfirst\n### Sub\nnested\n## Two\nsecond\n';
  assert.equal(extractH2Section(doc, 'One'), '\nfirst\n### Sub\nnested\n');
  assert.equal(extractH2Section(doc, 'Two'), '\nsecond\n');
  assert.equal(extractH2Section(doc, 'Three'), null);
});

test('detectStep1bCompanionDrift reports a missing section and a missing needle', () => {
  const companions = { 'merge-policy': '### Merge policy' };
  const doc = (body: string) =>
    [
      '## Decisions that require explicit operator confirmation',
      body,
      '## Related default policies to confirm',
      'nothing here',
    ].join('\n');
  assert.deepEqual(
    detectStep1bCompanionDrift(doc('### Merge policy'), companions),
    [],
  );
  assert.equal(
    detectStep1bCompanionDrift(doc('no heading'), companions).length,
    1,
  );
  // The needle only counts inside the two decision sections.
  assert.equal(
    detectStep1bCompanionDrift(
      `${doc('x')}\n## Elsewhere\n### Merge policy\n`,
      companions,
    ).length,
    1,
  );
  assert.equal(
    detectStep1bCompanionDrift('## Elsewhere\n', companions).length,
    3,
  );
});

test('detectPhaseGraphNormalizationDrift flags a collision after normalization and an edge that names no node', () => {
  const normalize = (token: string) =>
    token.toUpperCase().replace(/[.-]/g, '_');
  assert.deepEqual(
    detectPhaseGraphNormalizationDrift(
      [
        { id: 'A4_5', next: ['A4.5'] },
        { id: 'B', next: [] },
      ],
      normalize,
    ),
    [],
  );
  const collision = detectPhaseGraphNormalizationDrift(
    [
      { id: 'A4_5', next: [] },
      { id: 'a4.5', next: [] },
    ],
    normalize,
  );
  assert.equal(collision.length, 1);
  const dangling = detectPhaseGraphNormalizationDrift(
    [{ id: 'A', next: ['Z'] }],
    normalize,
  );
  assert.match(dangling[0]?.message ?? '', /normalized edge Z -> Z/);
});

test('resume route extraction takes the first documented enum and every table literal', () => {
  const source =
    'help: { "route": "D1|E1|stop" } and later { "route": "X" }\n' +
    "table: { route: 'D1' }, { route: 'E1' }\n";
  assert.deepEqual(extractResumeRouteEnum(source), ['D1', 'E1', 'stop']);
  assert.deepEqual(extractResumeDecisionRoutes(source), ['D1', 'E1']);
  assert.equal(extractResumeRouteEnum('nothing'), null);
});

/** A resolver whose canonical ids are `canonical` and whose alias map is `aliases`. */
function fakeResolver(
  canonical: readonly string[],
  aliases: Record<string, string> = {},
): PhaseResolver {
  return (input) => {
    if (canonical.includes(input)) {
      return { canonicalPhaseId: input, matchedBy: 'canonical' };
    }
    const alias = aliases[input];
    if (alias !== undefined) {
      return { canonicalPhaseId: alias, matchedBy: 'legacy-alias' };
    }
    throw Object.assign(new Error(`unknown ${input}`), {
      code: 'unknown_phase_id',
    });
  };
}

test('detectResumeRouteDrift accepts canonical routes with the stop sentinel and an unknown bare A', () => {
  assert.deepEqual(
    detectResumeRouteDrift(
      ['D1', 'Esync', 'stop'],
      ['stop', 'D1', 'Esync'],
      fakeResolver(['D1', 'Esync']),
    ),
    [],
  );
});

test('detectResumeRouteDrift requires the unknown_phase_id code from the stop sentinel and the bare A', () => {
  const brokenResolver: PhaseResolver = (input) => {
    if (input === 'stop' || input === 'A') {
      // Throws, but not the documented unknown-phase error.
      throw new Error('boom');
    }
    return { canonicalPhaseId: input, matchedBy: 'canonical' };
  };
  const messages = detectResumeRouteDrift(
    ['D1', 'Esync', 'stop'],
    ['D1', 'Esync', 'stop'],
    brokenResolver,
  ).map((item) => item.message);
  assert.equal(messages.length, 2, messages.join('|'));
  assert.match(messages.join('|'), /stop must not resolve/);
  assert.match(messages.join('|'), /A must not resolve/);
});

test('detectResumeRouteDrift flags enum and table drift, a missing Esync, an alias route, a resolvable stop or bare A, and a throwing resolver', () => {
  const messages = (
    documented: string[],
    table: string[],
    resolver: PhaseResolver,
  ) =>
    detectResumeRouteDrift(documented, table, resolver).map((v) => v.message);

  assert.match(
    messages(['D1', 'Esync'], ['D1'], fakeResolver(['D1', 'Esync']))[0] ?? '',
    /must list the same routes/,
  );
  assert.match(
    messages(['D1'], ['D1'], fakeResolver(['D1']))[0] ?? '',
    /must include Esync/,
  );
  assert.match(
    messages(
      ['D1', 'Esync', 'A4.5'],
      ['D1', 'Esync', 'A4.5'],
      fakeResolver(['D1', 'Esync'], { 'A4.5': 'A4_5' }),
    ).join('|'),
    /A4\.5 must stay canonical.*A4\.5 must resolve to itself/,
  );
  assert.match(
    messages(
      ['D1', 'Esync', 'stop'],
      ['D1', 'Esync', 'stop'],
      fakeResolver(['D1', 'Esync', 'stop']),
    )[0] ?? '',
    /stop must not resolve as a canonical phase id/,
  );
  assert.match(
    messages(
      ['D1', 'Esync'],
      ['D1', 'Esync'],
      fakeResolver(['D1', 'Esync', 'A']),
    )[0] ?? '',
    /A must not resolve as a canonical phase id/,
  );
  assert.match(
    messages(
      ['Gone', 'Esync'],
      ['Gone', 'Esync'],
      fakeResolver(['Esync']),
    )[0] ?? '',
    /resume route Gone must resolve through the phase-id resolver/,
  );
});

// ---------------------------------------------------------------------------
// Aggregate: `audit-docs --check` runs the audit for the source repository.
// ---------------------------------------------------------------------------

function copySourceTree(): string {
  const root = scratchDir('idd-schema-audit-source-');
  cpSync(REPO_ROOT, root, {
    recursive: true,
    filter: (source) => {
      const parts = relative(REPO_ROOT, source).split(/[\\/]/u);
      return !parts.includes('.git') && !parts.includes('node_modules');
    },
  });
  execFileSync('git', ['init', '--quiet'], { cwd: root, env: fixtureEnv() });
  execFileSync('git', ['add', '-A'], { cwd: root, env: fixtureEnv() });
  return root;
}

test('audit-docs --check runs the schema audit and reports its violations with the rule ID', () => {
  const root = copySourceTree();
  const run = () =>
    spawnSync(
      process.execPath,
      [join(root, 'scripts', 'audit-docs.mjs'), '--check'],
      {
        cwd: root,
        env: fixtureEnv(),
        encoding: 'utf8',
      },
    );
  const clean = run();
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

  writeFileSync(join(root, 'schemas', 'brand-new.schema.json'), '{}');
  execFileSync('git', ['add', '-A'], { cwd: root, env: fixtureEnv() });
  const failing = run();
  assert.equal(failing.status, 1, `${failing.stdout}\n${failing.stderr}`);
  assert.match(
    failing.stderr,
    /repository-schema-audit\/SCHEMA-TYPE-CATALOG: schemas\/brand-new\.schema\.json: is not mapped/,
  );
  assert.match(
    failing.stderr,
    /repository-schema-audit\/SCHEMA-OUTPUT-COVERAGE: schemas\/brand-new\.schema\.json: has no SCHEMA_OUTPUT_COVERAGE entry/,
  );
});
