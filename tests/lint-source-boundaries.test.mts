import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

import {
  containsNulByte,
  DIRECT_GH_SPAWN_PATTERN,
  findBareSpecifiers,
  MIGRATED_HELPERS,
} from '../src/scripts/lint-source-boundaries.mts';
import { fixtureEnv } from './test-utils.mts';

// #3748: the whole-tree source boundary rules run through the bare-node CLI
// (`scripts/lint-source-boundaries.mjs`). These tests drive that CLI against
// temporary `git init` fixture trees -- never the real checkout -- so the
// detectors are proven by positive and negative fixtures, and the live
// enforcement stays in lint.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(REPO_ROOT, 'scripts', 'lint-source-boundaries.mjs');
const CLI_SOURCE = join(
  REPO_ROOT,
  'src',
  'scripts',
  'lint-source-boundaries.mts',
);

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

type FixtureFiles = Map<string, string | Buffer>;

const MANIFEST = JSON.stringify({
  syncPairs: [
    {
      id: 'mirror',
      mode: 'exact',
      source: 'scripts/mirror.mjs',
      target: 'idd-template/scripts/mirror.mjs',
    },
    // Neither of these is an exact `idd-template/scripts/` mirror.
    {
      id: 'doc',
      mode: 'exact',
      source: 'docs/a.md',
      target: 'idd-template/docs/a.md',
    },
    {
      id: 'concreted',
      mode: 'concreted',
      source: 'scripts/other.mjs',
      target: 'idd-template/scripts/other.mjs',
    },
  ],
});

/** A tree that satisfies every rule, keyed by repository-relative path. */
function cleanFiles(): FixtureFiles {
  const files: FixtureFiles = new Map<string, string | Buffer>([
    [
      'src/main.mts',
      "import { readFileSync } from 'node:fs';\nimport { helper } from './scripts/helper.mts';\nexport const main = [readFileSync, helper];\n",
    ],
    ['src/scripts/helper.mts', 'export const helper = 1;\n'],
    // The two documented spawn exemptions may spawn the gh executable.
    [
      'src/scripts/gh-exec.mts',
      "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('gh', ['--version']);\n",
    ],
    [
      'src/scripts/minimize-superseded-markers.mts',
      "import { spawnSync } from 'node:child_process';\nexport const run = () => spawnSync('gh', []);\n",
    ],
    ['src/scripts/provider-port.mts', 'export const port = 1;\n'],
    ['src/scripts/provider-adapter-github.mts', 'export const github = 1;\n'],
    ['src/scripts/provider-adapter-fake.mts', 'export const fake = 1;\n'],
    [
      'scripts/mirror.mjs',
      "import { readFileSync } from 'node:fs';\nexport const mirror = readFileSync;\n",
    ],
    ['audit/sync-manifest.json', MANIFEST],
    ['bin/run.mjs', 'export const run = 1;\n'],
    ['tests/unit.test.mts', 'export const unit = 1;\n'],
  ]);
  for (const name of MIGRATED_HELPERS) {
    files.set(`src/scripts/${name}`, 'export const migrated = 1;\n');
    files.set(
      `scripts/${name.replace(/\.mts$/, '.mjs')}`,
      'export const migrated = 1;\n',
    );
  }
  return files;
}

/**
 * Writes `files` under a fresh scratch directory and, unless `git` is false,
 * turns it into a git repository with everything staged (the NUL rule reads
 * the tracked file list, which the index provides without a commit).
 */
function buildFixture(
  edit: (files: FixtureFiles) => void = () => undefined,
  {
    git = true,
    afterTrack = () => undefined,
  }: { git?: boolean; afterTrack?: (root: string) => void } = {},
): string {
  const root = scratchDir('idd-lint-boundaries-');
  const files = cleanFiles();
  edit(files);
  for (const [path, content] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (git) {
    execFileSync('git', ['init', '-q', root], {
      env: fixtureEnv(),
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', root, 'add', '-A'], {
      env: fixtureEnv(),
      stdio: 'ignore',
    });
  }
  afterTrack(root);
  return root;
}

function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [options.script ?? CLI, ...args], {
    cwd: options.cwd ?? tmpdir(),
    env: options.env ?? fixtureEnv(),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** `<RULE-ID> <path>:` lines the CLI printed on stderr. */
function reportedRules(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => /^(\S+) (\S+): /.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]} ${match[2]}`);
}

test('a tree that satisfies every rule passes and reports what each rule inspected', () => {
  const root = buildFixture();
  const { status, stdout, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  const helpers = MIGRATED_HELPERS.length;
  // Counted from `cleanFiles()`: 7 non-helper `src` files (6 of them under
  // src/scripts, 2 of those exempt from the spawn rule), the enrolled helpers'
  // sources and generated copies, one mirror, and the bin/tests files.
  const inspected = new Map([
    ['NODE-IMPORT-BOUNDARY', 7 + helpers],
    ['STANDALONE-MIRROR-IMPORTS', 1],
    ['GH-SPAWN-DIRECT', 6 + helpers - 2],
    ['PROVIDER-PORT-MIGRATED', helpers * 2],
    ['NO-NUL-BYTES', 7 + helpers + 1 + helpers + 1 + 1],
  ]);
  for (const [ruleId, count] of inspected) {
    assert.ok(
      stdout.includes(`lint-source-boundaries: ${ruleId} inspected ${count}\n`),
      `${ruleId} should have inspected ${count}:\n${stdout}`,
    );
  }
  assert.match(stdout, /all source boundaries passed/);
});

interface ViolationCase {
  name: string;
  edit: (files: FixtureFiles) => void;
  /** `<RULE-ID> <path>` the CLI must report. */
  expected: string;
}

const VIOLATION_CASES: ViolationCase[] = [
  {
    name: 'a bare third-party import under src',
    edit: (files) =>
      files.set(
        'src/main.mts',
        "import { parse } from 'yaml';\nexport const main = parse;\n",
      ),
    expected: 'NODE-IMPORT-BOUNDARY src/main.mts',
  },
  {
    name: 'a dynamic bare import under src',
    edit: (files) =>
      files.set(
        'src/scripts/helper.mts',
        "export const load = () => import('left-pad');\n",
      ),
    expected: 'NODE-IMPORT-BOUNDARY src/scripts/helper.mts',
  },
  {
    name: 'a relative import in a standalone mirror source',
    edit: (files) =>
      files.set(
        'scripts/mirror.mjs',
        "import { helper } from './helper.mjs';\nexport const mirror = helper;\n",
      ),
    expected: 'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
  },
  {
    name: 'a direct gh spawn in a script',
    edit: (files) =>
      files.set(
        'src/scripts/helper.mts',
        "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('gh', []);\n",
      ),
    expected: 'GH-SPAWN-DIRECT src/scripts/helper.mts',
  },
  {
    name: 'a namespace-qualified direct gh spawn in a script',
    edit: (files) =>
      files.set(
        'src/scripts/helper.mts',
        'import * as cp from \'node:child_process\';\nexport const run = () => cp.spawnSync("gh", []);\n',
      ),
    expected: 'GH-SPAWN-DIRECT src/scripts/helper.mts',
  },
  {
    name: 'a bare ghText call in a migrated helper source',
    edit: (files) =>
      files.set(
        'src/scripts/review-clause.mts',
        "export const run = () => ghText(['api']);\n",
      ),
    expected: 'PROVIDER-PORT-MIGRATED src/scripts/review-clause.mts',
  },
  {
    name: 'a gh-exec import in a migrated helper generated copy',
    edit: (files) =>
      files.set(
        'scripts/review-clause.mjs',
        "import { ghText } from './gh-exec.mjs';\nexport const run = ghText;\n",
      ),
    expected: 'PROVIDER-PORT-MIGRATED scripts/review-clause.mjs',
  },
  {
    name: 'a literal NUL byte in a tracked test source',
    edit: (files) =>
      files.set('tests/dirty.mts', Buffer.from('export const bad = "a\0b";\n')),
    expected: 'NO-NUL-BYTES tests/dirty.mts',
  },
];

for (const { name, edit, expected } of VIOLATION_CASES) {
  test(`the CLI fails with the rule ID and relative path for ${name}`, () => {
    const root = buildFixture(edit);
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [expected], stderr);
    assert.match(stderr, /lint-source-boundaries: 1 violation\(s\)/);
  });
}

const backtick = String.fromCharCode(96);
const hiddenImportShapes: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'a glob in a line comment followed by a later block-comment end',
    source: (specifier) =>
      `// schemas/*.schema.json\nimport value from '${specifier}';\n/** end */\n`,
  },
  {
    name: 'a line-comment marker in a quoted string',
    source: (specifier) =>
      `const value = 'x//y'; const load = () => import('${specifier}');\n`,
  },
  {
    name: 'a block-comment marker in a quoted string',
    source: (specifier) =>
      `const value = 'schemas/*.json';\nimport value from '${specifier}';\n/** end */\n`,
  },
  {
    name: 'a block-comment marker in template text',
    source: (specifier) =>
      `const value = ${backtick}schemas/*.json${backtick};\nimport value from '${specifier}';\n/** end */\n`,
  },
];

for (const { name, source } of hiddenImportShapes) {
  test(`the node-import rule sees an import after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('yaml')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
  });

  test(`the standalone-mirror rule sees an import after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
    ]);
    assert.match(stderr, /\.\/helper\.mjs/);
  });
}

const markerImportSources: [string, string][] = [
  [
    'a quoted string',
    `const marker = "x//y /* ' ${backtick}"; const load = () => import('left-pad');\nimport value from 'yaml';\n`,
  ],
  [
    'template text',
    [
      'const marker = ',
      backtick,
      'x //y /* \' " ' + '\\',
      backtick,
      ' text',
      backtick,
      "; const load = () => import('left-pad');\nimport value from 'yaml';\n",
    ].join(''),
  ],
  [
    'a regular-expression literal',
    [
      'const marker = /[',
      backtick,
      "\"']/; const escaped = /[\\/\\\\]/; const load = () => import('left-pad');\nimport value from 'yaml';\n",
    ].join(''),
  ],
];

for (const [name, source] of markerImportSources) {
  test(`comment markers and delimiters in ${name} leave later imports visible`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', source));
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
    assert.match(stderr, /left-pad/);
  });
}

const lexicalBoundarySources: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'a regex after of with an escaped slash and quantifier',
    source: (specifier) =>
      String.raw`for (const m of /\/*x/g) {}
import value from '__SPECIFIER__';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after throw with a comment-like character-class member',
    source: (specifier) =>
      `throw /[/*]/;
import value from '__SPECIFIER__';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after a control-flow condition',
    source: (specifier) =>
      `if (ok) /[/*]/.test(value);
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after a control-flow block',
    source: (specifier) =>
      `if (ok) {}
/[/*]/.test(value);
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an else block',
    source: (specifier) =>
      `if (ok) {} else {}
/[/*]/.test(value);
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after a labeled block',
    source: (specifier) =>
      `label: {}
/[/*]/.test(value);
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after export default',
    source: (specifier) =>
      `export default /[/*]/;
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after extends',
    source: (specifier) =>
      `class Example extends /[/*]/ {}
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an ASI-terminated break',
    source: (specifier) =>
      `while (true) {
  break
  /[/*]/.test(value);
}
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an ASI-terminated continue',
    source: (specifier) =>
      `while (true) {
  continue
  /[/*]/.test(value);
}
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an ASI-terminated labeled break',
    source: (specifier) =>
      `outer: while (true) {
  break outer
  /[/*]/.test(value);
}
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an ASI-terminated labeled continue',
    source: (specifier) =>
      `outer: while (true) {
  continue outer
  /[/*]/.test(value);
}
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a regex after an ASI-terminated debugger statement',
    source: (specifier) =>
      `debugger
/[/*]/.test(value);
import value from '__SPECIFIER__';
const marker = '*/';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a dynamic import after division following a property named if',
    source: (specifier) =>
      `const result = obj.if(value) / import('__SPECIFIER__') / 2;
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a line comment ending at U+2028',
    source: (specifier) =>
      `// comment\u2028import value from '__SPECIFIER__';
`.replace('__SPECIFIER__', specifier),
  },
  {
    name: 'a line comment ending at U+2029',
    source: (specifier) =>
      `// comment\u2029import value from '__SPECIFIER__';
`.replace('__SPECIFIER__', specifier),
  },
];

for (const { name, source } of lexicalBoundarySources) {
  test(`the node-import rule sees imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('yaml')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
  });

  test(`the standalone-mirror rule sees imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
    ]);
    assert.match(stderr, /\.\/helper\.mjs/);
  });
}

const divisionWithCommentedImports: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'division after a property named return',
    source: (specifier) =>
      `const value = obj.return / 1 /* import('__SPECIFIER__') */;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an object literal',
    source: (specifier) =>
      `const value = {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow function expression',
    source: (specifier) =>
      `const value = () => {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a postfix increment',
    source: (specifier) =>
      `let value = 1;\nvalue++ / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a postfix decrement',
    source: (specifier) =>
      `let value = 1;\nvalue-- / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a TypeScript non-null assertion',
    source: (specifier) =>
      `declare const maybe: number | undefined;\nmaybe! / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a class expression body',
    source: (specifier) =>
      `const value = class {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a function expression body',
    source: (specifier) =>
      `const value = function() {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a function expression with an object return type',
    source: (specifier) =>
      `const value = function (): { value: number } { return { value: 1 }; } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic type assertion',
    source: (specifier) =>
      `const value = maybe as Array<number> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an async function expression body',
    source: (specifier) =>
      `const value = async function() {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a function expression at interpolation start',
    source: (specifier) =>
      `const value = ${backtick}\${function() {} / /* import('__SPECIFIER__') */ 2}${backtick};\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an object literal at interpolation start',
    source: (specifier) =>
      `const value = ${backtick}\${{} / /* import('__SPECIFIER__') */ 2}${backtick};\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a function expression on a binary-operator right side',
    source: (specifier) =>
      `const value = condition && function() {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a private property named return',
    source: (specifier) =>
      `class Example { #return = 1; read() { return this.#return / /* import('__SPECIFIER__') */ 2; } }\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a Unicode identifier',
    source: (specifier) =>
      `const π = 1;\nπ / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an astral Unicode identifier',
    source: (specifier) =>
      `const 𐐀 = 1;\n𐐀 / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a Unicode-escaped identifier',
    source: (specifier) =>
      `const \\u{03c0} = 1;\n\\u{03c0} / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a regular-expression literal',
    source: (specifier) =>
      `const value = /x/ / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
];

for (const { name, source } of divisionWithCommentedImports) {
  test(`the node-import rule ignores commented imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('left-pad')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 0, stderr);
  });

  test(`the standalone-mirror rule ignores commented imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 0, stderr);
  });
}

const prefixNotRegexSources: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'a prefix negation after return',
    source: (specifier) =>
      `function read() { return !/[/*]/; }\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a prefix negation after a control-flow condition',
    source: (specifier) =>
      `if (condition) !/[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a prefix negation after a statement block',
    source: (specifier) =>
      `{}\n!/[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
];

for (const { name, source } of prefixNotRegexSources) {
  test(`the node-import rule preserves imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('yaml')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
  });

  test(`the standalone-mirror rule preserves imports after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
    ]);
    assert.match(stderr, /\.\/helper\.mjs/);
  });
}

const identifierKeywordPrefixes: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'classify',
    source: (specifier) =>
      `declare const input: string;\nconst value = classify(input);\nif (condition) {}\n/[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'functionName',
    source: (specifier) =>
      `declare const input: string;\nconst value = functionName(input);\nif (condition) {}\n/[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
];

for (const { name, source } of identifierKeywordPrefixes) {
  test(`the node-import rule sees imports after the ${name} identifier`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('yaml')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
  });

  test(`the standalone-mirror rule sees imports after the ${name} identifier`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
    ]);
    assert.match(stderr, /\.\/helper\.mjs/);
  });
}

test('a block comment preserves the break-label context before a regex statement', () => {
  const source = [
    'outer: {',
    '  break/**/outer',
    '  /[/*]/;',
    '}',
    "import bare from 'yaml'; /* closes any misread regex comment */",
    '',
  ].join('\n');
  const root = buildFixture((files) => files.set('src/main.mts', source));
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
  assert.match(stderr, /yaml/);

  const mirrorRoot = buildFixture((files) =>
    files.set(
      'scripts/mirror.mjs',
      source.replace("from 'yaml'", "from './helper.mjs'"),
    ),
  );
  const mirrorResult = runCli(['--root', mirrorRoot]);
  assert.equal(mirrorResult.status, 1, mirrorResult.stderr);
  assert.deepEqual(reportedRules(mirrorResult.stderr), [
    'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
  ]);
  assert.match(mirrorResult.stderr, /\.\/helper\.mjs/);
});

for (const [rule, filePath, specifier] of [
  ['node-import rule', 'src/main.mts', 'yaml'],
  ['standalone-mirror rule', 'scripts/mirror.mjs', './helper.mjs'],
] as const) {
  test(`${rule} preserves restricted-statement context after a Unicode break label`, () => {
    const source = [
      'π: {',
      '  break π',
      '  /[/*]/;',
      '}',
      `import bare from '${specifier}'; /* closes any misread regex comment */`,
      '',
    ].join('\n');
    const root = buildFixture((files) => files.set(filePath, source));
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.match(
      stderr,
      rule === 'node-import rule' ? /yaml/ : /\.\/helper\.mjs/,
    );
  });
}

for (const [name, specifier] of [
  ['node-import rule', 'yaml'],
  ['standalone-mirror rule', './helper.mjs'],
] as const) {
  test(`${name} recognizes a regex statement after a leading function declaration`, () => {
    const source =
      `function read() {}\n/[/*]/.test(value);\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      );
    const root = buildFixture((files) =>
      files.set(
        name === 'node-import rule' ? 'src/main.mts' : 'scripts/mirror.mjs',
        source,
      ),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.ok(stderr.includes(specifier), stderr);
  });
}

test('an import-looking line inside template text remains visible to the detector', () => {
  const root = buildFixture((files) =>
    files.set(
      'src/main.mts',
      `const value = ${backtick}text\nimport bare from 'yaml';\n${backtick};\n`,
    ),
  );
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
  assert.match(stderr, /yaml/);
});

test('line and block comments still hide import-looking text', () => {
  const root = buildFixture((files) =>
    files.set(
      'src/main.mts',
      "/* import bare from 'yaml'; */\n// import bare from 'left-pad';\n",
    ),
  );
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
});

test('the URL separator in a string does not hide a same-line dynamic import', () => {
  const root = buildFixture((files) =>
    files.set(
      'src/main.mts',
      'const url = "https://example.test/path"; const load = () => import("left-pad");\n',
    ),
  );
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
  assert.match(stderr, /left-pad/);
});

const unterminatedSources: [string, string][] = [
  ['a block comment', '/* never closes'],
  ['a template literal', 'const value = `never closes'],
  ['a template interpolation', `const value = \`open \${ { nested: true }`],
];

for (const [name, unfinished] of unterminatedSources) {
  test(`an unterminated ${name} reports partial node-import findings`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `import value from 'yaml';\n${unfinished}`),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr).sort(), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
      'NODE-IMPORT-BOUNDARY-INSPECTION src/main.mts',
    ]);
    assert.match(stderr, /yaml/);
    assert.match(stderr, /unterminated/);
  });

  test(`an unterminated ${name} reports partial standalone-mirror findings`, () => {
    const root = buildFixture((files) =>
      files.set(
        'scripts/mirror.mjs',
        `import value from './helper.mjs';\n${unfinished}`,
      ),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr).sort(), [
      'STANDALONE-MIRROR-IMPORTS scripts/mirror.mjs',
      'STANDALONE-MIRROR-IMPORTS-INSPECTION scripts/mirror.mjs',
    ]);
    assert.match(stderr, /\.\/helper\.mjs/);
    assert.match(stderr, /unterminated/);
  });
}

test('the gh-spawn exemptions stay narrow: only the two documented files may spawn gh', () => {
  const root = buildFixture((files) => {
    files.set(
      'src/scripts/provider-adapter-github.mts',
      "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('gh', []);\n",
    );
  });
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'GH-SPAWN-DIRECT src/scripts/provider-adapter-github.mts',
  ]);
});

interface InspectionCase {
  name: string;
  edit: (files: FixtureFiles) => void;
  git?: boolean;
  /** Runs after the files are tracked, e.g. to delete one from disk. */
  afterTrack?: (root: string) => void;
  /** The `<RULE-ID> <path>:` prefix of the expected stderr line. */
  expected: string;
  /** What that line's message says, to tell failure causes apart. */
  message?: RegExp;
}

const INSPECTION_CASES: InspectionCase[] = [
  {
    name: 'a missing sync manifest',
    edit: (files) => files.delete('audit/sync-manifest.json'),
    expected: 'STANDALONE-MIRROR-IMPORTS-INSPECTION audit/sync-manifest.json',
  },
  {
    name: 'a manifest that is not JSON',
    edit: (files) => files.set('audit/sync-manifest.json', '{ not json'),
    expected: 'STANDALONE-MIRROR-IMPORTS-INSPECTION audit/sync-manifest.json',
  },
  {
    name: 'a manifest with no exact script mirror (an empty derivation)',
    edit: (files) =>
      files.set('audit/sync-manifest.json', JSON.stringify({ syncPairs: [] })),
    expected: 'STANDALONE-MIRROR-IMPORTS-INSPECTION audit/sync-manifest.json',
  },
  {
    name: 'a mirror source that cannot be read',
    edit: (files) => files.delete('scripts/mirror.mjs'),
    expected: 'STANDALONE-MIRROR-IMPORTS-INSPECTION scripts/mirror.mjs',
  },
  {
    name: 'a src directory with no .mts file (an empty inventory)',
    edit: (files) => {
      for (const path of [...files.keys()]) {
        if (path.startsWith('src/')) {
          files.delete(path);
        }
      }
      files.set('src/README.md', 'nothing to scan\n');
    },
    expected: 'NODE-IMPORT-BOUNDARY-INSPECTION src',
  },
  {
    name: 'an enrolled migrated helper whose generated copy is missing',
    edit: (files) => files.delete('scripts/review-clause.mjs'),
    expected: 'PROVIDER-PORT-MIGRATED-INSPECTION scripts/review-clause.mjs',
  },
  {
    name: 'a missing provider adapter module',
    edit: (files) => files.delete('src/scripts/provider-adapter-fake.mts'),
    expected:
      'PROVIDER-PORT-MIGRATED-INSPECTION src/scripts/provider-adapter-fake.mts',
  },
  {
    name: 'a tree that is not a git repository',
    edit: () => undefined,
    git: false,
    expected: 'NO-NUL-BYTES-INSPECTION src, scripts, bin, tests',
    message: /cannot enumerate tracked sources/,
  },
  {
    name: 'a repository with no tracked .mts/.mjs source (an empty inventory)',
    edit: (files) => {
      files.clear();
      files.set('src/README.md', 'nothing to scan\n');
    },
    expected: 'NO-NUL-BYTES-INSPECTION src, scripts, bin, tests',
    message: /no tracked \.mts\/\.mjs source to inspect/,
  },
  {
    name: 'a tracked source that is missing from the working tree',
    edit: () => undefined,
    afterTrack: (root) => rmSync(join(root, 'bin', 'run.mjs')),
    expected: 'NO-NUL-BYTES-INSPECTION bin/run.mjs',
    message: /cannot read the file/,
  },
];

for (const {
  name,
  edit,
  git,
  afterTrack,
  expected,
  message,
} of INSPECTION_CASES) {
  test(`an incomplete inspection fails closed for ${name}`, () => {
    const root = buildFixture(edit, { git, afterTrack });
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    // The path column of an inspection line may hold a comma-separated list.
    const line = stderr
      .split('\n')
      .find((candidate) => candidate.startsWith(`${expected}:`));
    assert.ok(line, stderr);
    if (message) {
      assert.match(line, message);
    }
  });
}

test('an inherited git location variable cannot redirect the NUL scan to another repository', () => {
  const root = buildFixture();
  const other = buildFixture((files) => {
    files.set('tests/dirty.mts', Buffer.from('export const bad = "a\0b";\n'));
  });
  const env = fixtureEnv();
  env.GIT_DIR = join(other, '.git');
  env.GIT_COMMON_DIR = join(other, '.git');
  env.GIT_INDEX_FILE = join(other, '.git', 'index');
  env.GIT_OBJECT_DIRECTORY = join(other, '.git', 'objects');
  env.GIT_WORK_TREE = other;
  const { status, stderr } = runCli(['--root', root], { env });
  assert.equal(status, 0, stderr);
});

test('an inherited git configuration override cannot make the NUL scan fail', () => {
  const root = buildFixture();
  const env = fixtureEnv();
  // A config count with no matching key makes every git command abort.
  env.GIT_CONFIG_COUNT = '1';
  delete env.GIT_CONFIG_KEY_0;
  delete env.GIT_CONFIG_VALUE_0;
  const broken = spawnSync('git', ['-C', root, 'ls-files'], {
    env,
    encoding: 'utf8',
  });
  assert.notEqual(broken.status, 0, 'the override should break plain git');
  const { status, stderr } = runCli(['--root', root], { env });
  assert.equal(status, 0, stderr);
});

test('violations of several rules are reported in rule then path order, and counted', () => {
  const root = buildFixture((files) => {
    files.set(
      'src/main.mts',
      "import { parse } from 'yaml';\nexport const main = parse;\n",
    );
    files.set('tests/dirty.mts', Buffer.from('export const bad = "a\0b";\n'));
    files.set(
      'src/scripts/helper.mts',
      "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('gh', []);\n",
    );
  });
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'GH-SPAWN-DIRECT src/scripts/helper.mts',
    'NO-NUL-BYTES tests/dirty.mts',
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
  assert.match(stderr, /lint-source-boundaries: 3 violation\(s\)/);
});

test('--help prints usage, and a usage error exits 2 without inspecting anything', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /^Usage: node scripts\/lint-source-boundaries\.mjs/,
  );

  const unknown = runCli(['--no-such-flag']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --no-such-flag/);

  const missing = runCli(['--root']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--root requires a directory path/);

  // A flag is not a directory value for --root.
  const flagValue = runCli(['--root', '--help']);
  assert.equal(flagValue.status, 2);
  assert.match(flagValue.stderr, /--root requires a directory path/);
});

test('the CLI runs with bare Node from a copy that has no node_modules or package marker', () => {
  const bare = scratchDir('idd-lint-boundaries-bare-');
  const scripts = join(bare, 'scripts');
  mkdirSync(scripts);
  const closure = [
    'lint-source-boundaries.mjs',
    'node-runtime-guard.mjs',
    'bundle-root.mjs',
  ];
  for (const name of closure) {
    copyFileSync(join(REPO_ROOT, 'scripts', name), join(scripts, name));
    // The whole closure imports only `node:` builtins and its own siblings.
    assert.deepEqual(
      findBareSpecifiers(readFileSync(join(scripts, name), 'utf8')),
      [],
      name,
    );
  }
  const env = fixtureEnv();
  delete env.NODE_PATH;
  const script = join(scripts, 'lint-source-boundaries.mjs');

  const clean = runCli(['--root', buildFixture()], {
    cwd: bare,
    env,
    script,
  });
  assert.equal(clean.status, 0, clean.stderr);

  const malformed = runCli(
    [
      '--root',
      buildFixture((files) =>
        files.set(
          'src/main.mts',
          "import { parse } from 'yaml';\nexport const main = parse;\n",
        ),
      ),
    ],
    { cwd: bare, env, script },
  );
  assert.equal(malformed.status, 1, malformed.stderr);
  assert.deepEqual(reportedRules(malformed.stderr), [
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
});

/** sha256 of every file under `dir`, keyed by relative path, `.git` included. */
function snapshotTree(dir: string, prefix = ''): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(snapshot, snapshotTree(dir, relative));
    } else {
      snapshot[relative] = createHash('sha256')
        .update(readFileSync(join(dir, relative)))
        .digest('hex');
    }
  }
  return snapshot;
}

test('a run leaves every tracked byte and the git index unchanged, clean or not', () => {
  for (const edit of [
    () => undefined,
    (files: FixtureFiles) =>
      files.set('tests/dirty.mts', Buffer.from('export const bad = "a\0b";\n')),
  ]) {
    const root = buildFixture(edit);
    const before = snapshotTree(root);
    runCli(['--root', root]);
    assert.deepEqual(snapshotTree(root), before);
  }
});

test('the module and its generated copy satisfy their own rules', () => {
  for (const path of [CLI_SOURCE, CLI]) {
    const bytes = readFileSync(path);
    assert.equal(containsNulByte(bytes), false, path);
    const text = bytes.toString('utf8');
    // No comment or message may spell the direct-spawn shape the rule scans for.
    assert.equal(DIRECT_GH_SPAWN_PATTERN.test(text), false, path);
    assert.deepEqual(findBareSpecifiers(text), [], path);
  }
});
