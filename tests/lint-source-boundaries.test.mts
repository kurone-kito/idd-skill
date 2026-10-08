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
    name: 'a regex after an arrow function block',
    source: (specifier) =>
      `const f = () => {}
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
    name: 'division inside an arrow function expression body',
    source: (specifier) =>
      `const value = () => ({}) / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow function type assertion',
    source: (specifier) =>
      `const value = maybe as () => { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a multiline comment on an arrow function type',
    source: (specifier) =>
      `const value = maybe as () => { a: number } / /*\nimport('__SPECIFIER__')\n*/ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow type with a parameter list',
    source: (specifier) =>
      `const value = maybe as (x: string, y: number) => { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow type with a type argument',
    source: (specifier) =>
      `const value = maybe as <T>(x: T) => { a: T } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow type with a comment before the arrow',
    source: (specifier) =>
      `const value = maybe as () /* note */ => { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a nested arrow function type',
    source: (specifier) =>
      `const value = maybe as () => () => { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow type broken before the arrow',
    source: (specifier) =>
      `const value = maybe as ()\n  => { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an arrow type with a comment before the brace',
    source: (specifier) =>
      `const value = maybe as () => /* note */ { a: number } / /* import('__SPECIFIER__') */ 2;\n`.replace(
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
    name: 'division after a generic instantiation',
    source: (specifier) =>
      `const value = identity<number> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation with a block comment',
    source: (specifier) =>
      `const value = identity<Foo /* note */> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a mapped type with a block comment',
    source: (specifier) =>
      `const value = identity<({ [K in /* note */ T]: boolean })> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation with a closer inside a comment',
    source: (specifier) =>
      `const value = identity<Foo /* > */> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a function type whose comment mentions an opener',
    source: (specifier) =>
      `const value = identity</* was foo() /* now */ (x: string) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after keyof whose comment mentions an opener',
    source: (specifier) =>
      `const value = identity<keyof /* was foo() /* now */ (A | B)> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a return type whose comment mentions an opener',
    source: (specifier) =>
      `const value = identity<{ m(): /* returns (T) /* docs */ { a: number } }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a brace that follows the later of two comments',
    source: (specifier) =>
      `const value = identity<{ m(i) /* was ) */ T /* now */ { a: number } }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a brace that follows a comment ending in a slash',
    source: (specifier) =>
      `const value = identity<{ m(i) /* was ) */ T /*/*/ { a: number } }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a brace that follows a comment after one ending in a slash',
    source: (specifier) =>
      `const value = identity<{ m(i) /*see)/*/ T /*/*/ { a: number } }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an array type',
    source: (specifier) =>
      `const value = identity<number[]> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation with a nested comma',
    source: (specifier) =>
      `const value = identity<Record<string, number>> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a tuple',
    source: (specifier) =>
      `const value = identity<[string, number]> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an object type',
    source: (specifier) =>
      `const value = identity<{ a: number, b: number }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a function type',
    source: (specifier) =>
      `const value = identity<() => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a parameterized function type',
    source: (specifier) =>
      `const value = identity<(x: string, y: number) => boolean> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a nested function type',
    source: (specifier) =>
      `const value = identity<() => () => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a generic function type',
    source: (specifier) =>
      `const value = identity<Promise<() => void>> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a function type with a union return',
    source: (specifier) =>
      `const value = identity<(x: string) => string | number> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an intersection type',
    source: (specifier) =>
      `const value = identity<(string) & number> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a method signature',
    source: (specifier) =>
      `const value = identity<{ m(x: string): void }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a generic function type parameter',
    source: (specifier) =>
      `const value = identity<<T>(x: T) => T> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an abstract constructor type',
    source: (specifier) =>
      `const value = identity<abstract new () => Object> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a keyof parenthesized type',
    source: (specifier) =>
      `const value = identity<keyof (A | B)> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a conditional type',
    source: (specifier) =>
      `const value = identity<(T extends (A | B) ? C : D)> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a method with an object return',
    source: (specifier) =>
      `const value = identity<{ m(): { a: number } }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a generic method signature',
    source: (specifier) =>
      `const value = identity<{ m<T>(x: T): void }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a generic constructor type',
    source: (specifier) =>
      `const value = identity<new <T>() => Object> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an abstract generic constructor',
    source: (specifier) =>
      `const value = identity<abstract new <T>() => Object> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a generic construct signature',
    source: (specifier) =>
      `const value = identity<{ new <T>(x: T): T }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a parenthesized function return',
    source: (specifier) =>
      `const value = identity<Foo<() => (string)>> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a default that uses equality',
    source: (specifier) =>
      `const value = identity<(x = a == b) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a default that uses inequality',
    source: (specifier) =>
      `const value = identity<(x = a != b) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a default that uses in',
    source: (specifier) =>
      `const value = identity<(x = a in b) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of two parameter defaults',
    source: (specifier) =>
      `const value = identity<(x = 1, y = a == b) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a mapped type in a parameter',
    source: (specifier) =>
      `const value = identity<(x: { [K in T]: boolean }) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a parenthesized mapped type',
    source: (specifier) =>
      `const value = identity<({ [K in T]: boolean })> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a method named in',
    source: (specifier) =>
      `const value = identity<(x: { in(y: string): void }) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a parameter named await',
    source: (specifier) =>
      `const value = identity<(await: string) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an optional parameter',
    source: (specifier) =>
      `const value = identity<(x?: string) => void> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a parenthesized void type',
    source: (specifier) =>
      `const value = identity<(void)> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a typeof query',
    source: (specifier) =>
      `const value = identity<(typeof a)> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an optional property',
    source: (specifier) =>
      `const value = identity<{ m?: string }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an optional method',
    source: (specifier) =>
      `const value = identity<{ m?(x: string): void }> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of an optional tuple element',
    source: (specifier) =>
      `const value = identity<readonly [string, number?]> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a constructor type',
    source: (specifier) =>
      `const value = identity<new () => Object> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a satisfies type',
    source: (specifier) =>
      `const value = input satisfies Array<number> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a nested function return type',
    source: (specifier) =>
      `const value = function (): Promise<{ value: number }> { return { value: 1 }; } / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after an object literal on a binary-operator right side',
    source: (specifier) =>
      `const value = condition && {} / /* import('__SPECIFIER__') */ 2;\n`.replace(
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
  {
    name: 'division after a trailing-dot numeric literal',
    source: (specifier) =>
      `const value = 1. / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a plain single-quoted literal type',
    source: (specifier) =>
      `const value = identity<'a'> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a literal type with an escaped quote',
    source: (specifier) =>
      `const value = identity<'a\\'b,c'> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a string literal type with a comma',
    source: (specifier) =>
      `const value = identity<"a,b"> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a single-quoted literal type with an angle bracket',
    source: (specifier) =>
      `const value = identity<'a<b,c'> / /* import('__SPECIFIER__') */ 2;\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'division after a generic instantiation of a template literal type',
    source: (specifier) =>
      `const value = identity<\`a,${'$'}{string}\`> / /* import('__SPECIFIER__') */ 2;\n`.replace(
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
  {
    name: 'a hashbang whose flag text contains a block-comment marker',
    source: (specifier) =>
      `#!/usr/bin/env -S node --flag=/*\nimport bare from '__SPECIFIER__';\n*/\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a comparison inside an index before a greater-than regex',
    source: (specifier) =>
      `const value = items[count < limit] > /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a comparison before a comma and a greater-than regex',
    source: (specifier) =>
      `check(count < limit, total > /[/*]/);\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call in a comparison',
    source: (specifier) =>
      `const value = count<limit(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a member call in a comparison',
    source: (specifier) =>
      `const value = count<obj.limit(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized comparison joined with &&',
    source: (specifier) =>
      `const value = count<(limit) && flag> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a property named new called in a comparison',
    source: (specifier) =>
      `const value = count<obj.new(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call of a parenthesized comparison operand',
    source: (specifier) =>
      `const value = count<(limit)(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized comparison joined with ||',
    source: (specifier) =>
      `const value = count<(limit) || flag> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a generic call in a comparison',
    source: (specifier) =>
      `const value = count<m<T>(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a generic member call in a comparison',
    source: (specifier) =>
      `const value = count<obj.m<T>(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a generic call of a property named new in a comparison',
    source: (specifier) =>
      `const value = count<obj.new<T>(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a spaced generic call in a comparison',
    source: (specifier) =>
      `const value = count<m<T> (i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call of a generic function type in a comparison',
    source: (specifier) =>
      `const value = count<m<<T>(x: T) => T>(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body in a comparison',
    source: (specifier) =>
      `const value = count<{ m(i) { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'an async method body in a comparison',
    source: (specifier) =>
      `const value = count<{ async m() { return 1 } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a generic method body in a comparison',
    source: (specifier) =>
      `const value = count<{ m<T>(i) { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a bare extends call in a comparison',
    source: (specifier) =>
      `const value = count<extends(i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized equality comparison',
    source: (specifier) =>
      `const value = count<(a == b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized strict equality comparison',
    source: (specifier) =>
      `const value = count<(a === b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized or-assignment',
    source: (specifier) =>
      `const value = count<(a |= b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized and-assignment',
    source: (specifier) =>
      `const value = count<(a &= b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized nullish coalescing comparison',
    source: (specifier) =>
      `const value = count<(a ?? b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized nullish assignment',
    source: (specifier) =>
      `const value = count<(a ??= b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized optional chain',
    source: (specifier) =>
      `const value = count<(a?.b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized in comparison',
    source: (specifier) =>
      `const value = count<(a in b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized instanceof comparison',
    source: (specifier) =>
      `const value = count<(a instanceof b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized void operator',
    source: (specifier) =>
      `const value = count<(void 0)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized delete operator',
    source: (specifier) =>
      `const value = count<(delete obj.a)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized await operator',
    source: (specifier) =>
      `const value = count<(await a)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a comparison after a parameter default',
    source: (specifier) =>
      `const value = count<(x = 1, a != b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'an equality comparison after a parameter default',
    source: (specifier) =>
      `const value = count<(x = 1, a == b)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized void operator on an object',
    source: (specifier) =>
      `const value = count<(void {a:1})> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a spaced comparison through the in operator',
    source: (specifier) =>
      `const value = count < limit in items > /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after division by a trailing-dot numeric literal',
    source: (specifier) =>
      `const value = 1. / /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after a signed exponent and a member dot',
    source: (specifier) =>
      `const value = 1e+2. /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after a fraction exponent and a member dot',
    source: (specifier) =>
      `const value = 1.5e-2. /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after a spaced member dot',
    source: (specifier) =>
      `const value = 1 . /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after a comment before a member dot',
    source: (specifier) =>
      `const value = 1/*c*/. /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a regex after division following a comment inside type arguments',
    source: (specifier) =>
      `const value = identity<Foo /* note */> / /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call separated from its type arguments by a block comment',
    source: (specifier) =>
      `const value = count<m<T> /* note */ (i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body separated from its parameter list by a block comment',
    source: (specifier) =>
      `const value = count<{ m(i) /* note */ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a block comment that mentions an opener',
    source: (specifier) =>
      `const value = count<{ m(i) /* note /* still */ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a block comment that starts with a slash',
    source: (specifier) =>
      `const value = count<{ m(i) /*/ note */ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call after a block comment that starts with a slash',
    source: (specifier) =>
      `const value = count<m<T> /*/ note */ (i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after an empty block comment',
    source: (specifier) =>
      `const value = count<{ m(i) /**/ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a block comment that ends with a slash',
    source: (specifier) =>
      `const value = count<{ m(i) /*/*/ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a call after a block comment that ends with a slash',
    source: (specifier) =>
      `const value = count<m<T> /*/*/ (i)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a slash-start comment with no space before its closer',
    source: (specifier) =>
      `const value = count<{ m(i) /*/ note*/ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a block comment that contains an opener',
    source: (specifier) =>
      `const value = count<{ m(i) /*/**/ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a method body after a comment that ends with a slash',
    source: (specifier) =>
      `const value = count<{ m(i) /*see)/*/ { return i } }> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a parenthesized void operator with a flush block comment',
    source: (specifier) =>
      `const value = count<(void/* note */0)> /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a comparison with a block comment through the in operator',
    source: (specifier) =>
      `const value = count < limit /* note */ in items > /[/*]/;\nimport bare from '__SPECIFIER__'; /* closes any misread regex comment */\n`.replace(
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

const ambiguousTypeArguments = [
  {
    name: 'a top-level union',
    source:
      "const value = identity<string | number> / /* import('left-pad') */ 2;\n",
  },
  {
    name: 'a top-level comma',
    source: "const value = identity<A, B> / /* import('left-pad') */ 2;\n",
  },
];

for (const { name, source } of ambiguousTypeArguments) {
  test(`a commented import stays visible after ${name} in a type-argument position`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', source));
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 1, stderr);
    assert.deepEqual(reportedRules(stderr), [
      'NODE-IMPORT-BOUNDARY src/main.mts',
    ]);
    assert.match(stderr, /left-pad/);
  });
}

test('a string literal type argument with a comma does not hide a later bare import', () => {
  const source =
    'const value = identity<"a,b"> / /[/*]/;\nimport bare from \'yaml\';\n';
  const root = buildFixture((files) => files.set('src/main.mts', source));
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.deepEqual(reportedRules(stderr), [
    'NODE-IMPORT-BOUNDARY src/main.mts',
  ]);
  assert.match(stderr, /yaml/);
});

test('a string still open at a line break in a would-be type argument list stays a comparison', () => {
  const source =
    "const v = count<'abc\nT> /[/*]/.test(s);\nimport bare from 'yaml';\n";
  const root = buildFixture((files) => files.set('src/main.mts', source));
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /yaml/);
});

test('a template literal spanning a line break in a would-be type argument list stays a comparison', () => {
  const source =
    "const v = count<`abc\nx`> /[/*]/.test(s);\nimport bare from 'yaml';\n";
  const root = buildFixture((files) => files.set('src/main.mts', source));
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /yaml/);
});

test('a line continuation carries a literal type over a line break', () => {
  const source = "const v = identity<'a\\\nb'> / /* import('left-pad') */ 2;\n";
  const root = buildFixture((files) => files.set('src/main.mts', source));
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
});

test('division after an arrow type in a TypeScript assertion leaves comments hidden', () => {
  const root = buildFixture((files) =>
    files.set(
      'src/main.mts',
      `const value = maybe as Array<(s: string) => boolean> / /* import('left-pad') */ 2;\n`,
    ),
  );
  const { status, stderr } = runCli(['--root', root]);
  assert.equal(status, 0, stderr);
});

test('a multiline TypeScript assertion does not hide a later bare import', () => {
  const source = [
    'const n = value as number',
    'if (n < limit) items.map((s) => /[/*]/.test(s));',
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
});

const laterHashbangMarkers: {
  name: string;
  source: (specifier: string) => string;
}[] = [
  {
    name: 'a hashbang-like line after other code',
    source: (specifier) =>
      `const flag = 1;\n#!/usr/bin/env -S node --flag=/*\nimport bare from '__SPECIFIER__';\n*/\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
  {
    name: 'a hashbang-like line inside a template interpolation',
    source: (specifier) =>
      `const value = ${backtick}\${#!/usr/bin/env -S node --flag=/*\nimport bare from '__SPECIFIER__';\n*/}${backtick};\n`.replace(
        '__SPECIFIER__',
        specifier,
      ),
  },
];

for (const { name, source } of laterHashbangMarkers) {
  test(`the node-import rule keeps a real comment after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', source('yaml')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 0, stderr);
  });

  test(`the standalone-mirror rule keeps a real comment after ${name}`, () => {
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', source('./helper.mjs')),
    );
    const { status, stderr } = runCli(['--root', root]);
    assert.equal(status, 0, stderr);
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

// #3852: the import scan misread these shapes. Rows marked `yaml` must still
// report their import. Rows marked `clean` must not hide the import that
// follows them: each one also runs with `import bare from 'yaml';` appended,
// which must be the single report line. The negative controls (ctl1 to ctl12)
// keep a regular expression after a construct that could be a division.
const lexerRows: { name: string; source: string; expect: 'clean' | 'yaml' }[] =
  [
    {
      name: '1a: a byte-order mark before a hashbang that opens a block comment',
      source: "﻿#!/usr/bin/env node /*\nimport bare from 'yaml';\n*/\n",
      expect: 'yaml',
    },
    {
      name: '1b: a byte-order mark before a first-line import',
      source: "﻿import bare from 'yaml';\n",
      expect: 'yaml',
    },
    {
      name: '2a: an object literal after the colon of a conditional',
      source: "const value = ok ? 1 : {} / /* import('left-pad') */ 2;\n",
      expect: 'clean',
    },
    {
      name: '2b: an object literal after a conditional colon, then division',
      source: 'const v = c ? 1 : {} / 2; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '2c: an object literal after a less-than comparison',
      source: 'const v = a < {} / 2; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '2d: an object literal after a greater-than comparison',
      source: 'const v = a > {} / 2; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '2e: a regular expression after an object literal division',
      source: 'const v = c ? 1 : {} / /}/.source; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '2f: an object literal in a template interpolation',
      source: 'const t = `' + '$' + '{c ? 1 : {} / 2}`; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '3a: a line break after a non-null assertion, then a yaml import',
      source:
        "const ratio = total!\n  / count; // reads schemas/*.json\nimport bare from 'yaml';\n// end */\n",
      expect: 'yaml',
    },
    {
      name: '3b: a line break after a non-null assertion, then division',
      source: "const q = a!\n  / 2; // import('left-pad')\n",
      expect: 'clean',
    },
    {
      name: '3c: a line break after a non-null assertion, then a backtick',
      source: 'const share = done!\n  / total; // a single ` backtick\n',
      expect: 'clean',
    },
    {
      name: '4: a variable named of before a division',
      source: 'const of = 4;\nconst q = of / 2; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '5a: a plus sign separated from the next plus sign',
      source: 'const v = b + +/}/.source.length; // a ` b\n',
      expect: 'clean',
    },
    {
      name: '5b: a minus sign separated from the next minus sign',
      source: 'const v = (u)- -/`/.source.length;\n',
      expect: 'clean',
    },
    {
      name: '5c: a decrement on the next line is a prefix operator',
      source: 'let i = 0;\ni\n--/`/.lastIndex;\n',
      expect: 'clean',
    },
    {
      name: 'ctl1: an arrow body followed by a regular expression',
      source: 'const f = () => {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl2: a generic class followed by a regular expression',
      source: 'class A<T> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl3: a case block followed by a regular expression',
      source: 'switch (x) {\n  case 1: {} /`/.test(y);\n}\n',
      expect: 'clean',
    },
    {
      name: 'ctl4: a label block followed by a regular expression',
      source: 'lbl: {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl5: a class extending a generic followed by a regular expression',
      source: 'class A extends B<T> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl6: a generic interface followed by a regular expression',
      source: 'interface A<T> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl7: a generic return type followed by a regular expression',
      source: 'function f(): Array<T> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl8: a multi-line generic interface followed by a regular expression',
      source: 'interface A<\n  T\n> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl9: a multi-line generic class followed by a regular expression',
      source: 'class A<\n  T,\n  U\n> {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl10: a multi-line generic type followed by a regular expression',
      source: 'type X = Array<\n  T\n>\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl11: a multi-line generic function followed by a regular expression',
      source: 'function f<\n  T\n>() {}\n/`/.test(x);\n',
      expect: 'clean',
    },
    {
      name: 'ctl12: a case colon after a ternary followed by a regular expression',
      source: 'switch (x) {\n  case a ? 1 : 2: {} /`/.test(y);\n}\n',
      expect: 'clean',
    },
  ];

/** The node-import rule's report and inspection lines on stderr. */
function nodeImportLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('NODE-IMPORT-BOUNDARY ') ||
        line.startsWith('NODE-IMPORT-BOUNDARY-INSPECTION '),
    );
}

/** The standalone-mirror rule's report and inspection lines on stderr. */
function mirrorImportLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('STANDALONE-MIRROR-IMPORTS ') ||
        line.startsWith('STANDALONE-MIRROR-IMPORTS-INSPECTION '),
    );
}

for (const row of lexerRows) {
  test(`the node-import rule reads ${row.name}`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', row.source));
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    if (row.expect === 'clean') {
      assert.deepEqual(lines, []);
    } else {
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
    }
  });

  test(`the node-import rule sees an import after ${row.name}`, () => {
    if (row.expect !== 'clean') {
      return;
    }
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
    assert.doesNotMatch(lines[0], /-INSPECTION/);
  });

  test(`the standalone-mirror rule reads ${row.name}`, () => {
    const mirror = row.source
      .replaceAll("'yaml'", "'./helper.mjs'")
      .replaceAll("'left-pad'", "'./helper.mjs'");
    const root = buildFixture((files) =>
      files.set('scripts/mirror.mjs', mirror),
    );
    const lines = mirrorImportLines(runCli(['--root', root]).stderr);
    if (row.expect === 'clean') {
      assert.deepEqual(lines, []);
    } else {
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /found: \.\/helper\.mjs$/);
    }
  });

  test(`the standalone-mirror rule sees an import after ${row.name}`, () => {
    if (row.expect !== 'clean') {
      return;
    }
    const mirror = row.source
      .replaceAll("'yaml'", "'./helper.mjs'")
      .replaceAll("'left-pad'", "'./helper.mjs'");
    const root = buildFixture((files) =>
      files.set(
        'scripts/mirror.mjs',
        `${mirror}import bare from './helper.mjs';\n`,
      ),
    );
    const lines = mirrorImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /found: \.\/helper\.mjs$/);
    assert.doesNotMatch(lines[0], /-INSPECTION/);
  });
}

test('a file nested deeply enough to exhaust the scan stack is reported without a crash', () => {
  const nested = `${'`${'.repeat(20000)}x${'}`'.repeat(20000)};\n`;
  const root = buildFixture((files) =>
    files.set('src/main.mts', `${nested}import bare from 'yaml';\n`),
  );
  const { stderr } = runCli(['--root', root]);
  const lines = nodeImportLines(stderr);
  assert.ok(
    lines.includes(
      'NODE-IMPORT-BOUNDARY-INSPECTION src/main.mts: nesting too deep to scan',
    ),
    lines.join('\n'),
  );
  assert.doesNotMatch(stderr, /^\s+at /m);
  assert.doesNotMatch(stderr, /file:\/\//);
});

for (const [label, unit] of [
  ['a<', 'a<'],
  ['a<b ', 'a<b '],
] as const) {
  test(`a same-line ${label} run of 40,000 repetitions finishes quickly and still reports the import`, () => {
    const root = buildFixture((files) =>
      files.set(
        'src/main.mts',
        `${unit.repeat(40000)}\nimport bare from 'yaml';\n`,
      ),
    );
    const started = Date.now();
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.ok(Date.now() - started < 15000, 'scan took too long');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /yaml$/);
  });
}

// Review follow-ups on #3852: a spaced comparison must not open a multi-line
// type-parameter list for a later `>`, a statement end must clear any pending
// opener, and `??` must not leave a conditional colon pending.
const reviewFollowUpRows: { name: string; source: string }[] = [
  {
    name: 'a spaced comparison followed by a line break, then a comparison with an object literal',
    source: "const v = a < b ||\n  c > {} / /* import('left-pad') */ 2;\n",
  },
  {
    name: 'a spaced comparison before a multi-line type-parameter list and a later comparison',
    source:
      'const x = a < b;\ninterface A<\n  T\n> {}\nconst y = c > {} / 2; // a ` b\n',
  },
  {
    name: 'a nullish coalescing operator before a label block',
    source: 'const v = a ?? b;\nlbl: {}\n/`/.test(x);\n',
  },
];

for (const row of reviewFollowUpRows) {
  test(`the node-import rule reads ${row.name}`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', row.source));
    assert.deepEqual(nodeImportLines(runCli(['--root', root]).stderr), []);
  });

  test(`the node-import rule sees an import after ${row.name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
  });

  test(`the standalone-mirror rule reads ${row.name}`, () => {
    const mirror = row.source.replaceAll("'left-pad'", "'./helper.mjs'");
    const root = buildFixture((files) =>
      files.set(
        'scripts/mirror.mjs',
        `${mirror}import bare from './helper.mjs';\n`,
      ),
    );
    const lines = mirrorImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /found: \.\/helper\.mjs$/);
  });
}

test('a deeply nested mirror source is reported through the standalone-mirror rule without a stack trace', () => {
  const nested = `${'`${'.repeat(20000)}x${'}`'.repeat(20000)};\n`;
  const root = buildFixture((files) =>
    files.set(
      'scripts/mirror.mjs',
      `${nested}import bare from './helper.mjs';\n`,
    ),
  );
  const { stderr } = runCli(['--root', root]);
  assert.ok(
    mirrorImportLines(stderr).includes(
      'STANDALONE-MIRROR-IMPORTS-INSPECTION scripts/mirror.mjs: nesting too deep to scan',
    ),
    mirrorImportLines(stderr).join('\n'),
  );
  assert.doesNotMatch(stderr, /^\s+at /m);
  assert.doesNotMatch(stderr, /file:\/\//);
});

// Second review pass on #3852: `of` is a for-of operator only after a binding,
// so an identifier named `of` in a for header keeps its division; a real for-of
// regular expression still works; and the multi-line type-list opener has no
// fixed whitespace cutoff.
const reviewSecondRows: { name: string; source: string }[] = [
  {
    name: 'an identifier named of in a for header before a division',
    source: "for (const q = of / /* import('left-pad') */ 2; ; ) {}\n",
  },
  {
    name: 'a for-of header whose right side is a regular expression containing a backtick',
    source: 'for (const m of /`/.source) {}\n/`/.test(x);\n',
  },
  {
    name: 'a multi-line type-parameter list opened after more than sixty-four spaces',
    source: `class A<${' '.repeat(80)}\n  T\n> {}\n/\`/.test(x);\n`,
  },
];

for (const row of reviewSecondRows) {
  test(`the node-import rule reads ${row.name}`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', row.source));
    assert.deepEqual(nodeImportLines(runCli(['--root', root]).stderr), []);
  });

  test(`the node-import rule sees an import after ${row.name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
  });
}

// Third review pass on #3852: a for-of operator after a Unicode binding.
const reviewThirdRows: { name: string; source: string }[] = [
  {
    name: 'a for-of regular expression after a Unicode binding',
    source: 'for (const é of /a`b/) {}\n/`/.test(x);\n',
  },
];

for (const row of reviewThirdRows) {
  test(`the node-import rule reads ${row.name}`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', row.source));
    assert.deepEqual(nodeImportLines(runCli(['--root', root]).stderr), []);
  });

  test(`the node-import rule sees an import after ${row.name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
  });
}

// Fourth review pass on #3852: the backward search for a block comment's opener
// must skip string and template literals, so a `/*` inside a literal is text.
const commentMarkerInLiteralShapes: { name: string; source: string }[] = [
  {
    name: 'a comment marker inside a string literal in a type-argument lookahead',
    source: "const v = a<[ '/*', (b) /* c */ (y)] > /[/*]/.test(s);\n",
  },
  {
    name: 'a comment marker inside a template literal in a type-argument lookahead',
    source: 'const v = a<[ `/*`, (b) /* c */ (y)] > /[/*]/.test(s);\n',
  },
];

for (const row of commentMarkerInLiteralShapes) {
  test(`the node-import rule sees an import after ${row.name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
  });
}

// Fifth review pass on #3852: a comparison chain whose `<` ends a line is not a
// multi-line type-parameter list, because its `>` does not start its own line.
const multilineComparisonShapes: { name: string; source: string }[] = [
  {
    name: 'a comparison chain whose less-than sign ends a line',
    source: "const v = a<\n  b > {} / /* import('left-pad') */ 2;\n",
  },
];

for (const row of multilineComparisonShapes) {
  test(`the node-import rule reads ${row.name}`, () => {
    const root = buildFixture((files) => files.set('src/main.mts', row.source));
    assert.deepEqual(nodeImportLines(runCli(['--root', root]).stderr), []);
  });

  test(`the node-import rule sees an import after ${row.name}`, () => {
    const root = buildFixture((files) =>
      files.set('src/main.mts', `${row.source}import bare from 'yaml';\n`),
    );
    const lines = nodeImportLines(runCli(['--root', root]).stderr);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^NODE-IMPORT-BOUNDARY src\/main\.mts: .*yaml$/);
  });
}
