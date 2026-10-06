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

import { buildCommandCatalog } from '../src/scripts/helper-runtime-manifest.mts';
import {
  type AuditFile,
  CHECK_FAMILIES,
  COVERED_HELPERS,
  checkUnpointedSourceFormFile,
  collectHelperInvocationViolations,
  EXCLUDED_HELPERS,
  scanTemplateWorkflowRegistrations,
} from '../src/scripts/repository-inventory-audit.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO_ROOT, 'scripts/repository-inventory-audit.mjs');
const ROOT_MARKDOWN = [
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'GEMINI.md',
  'README.ja.md',
  'README.md',
  'SECURITY.md',
];
const REQUIRED_BUDGETS = [
  '.github/instructions/idd-*.instructions.md',
  'idd-template/.github/instructions/idd-*.instructions.md',
];

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'idd-repository-inventory-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runAudit(root: string, family: string): CliResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI, '--root', root, '--check', family],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const result = error as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  }
}

interface FixtureCatalogEntry {
  id: string;
  scriptName: string;
  binName: string;
  entryPath: string;
}

function catalogFor(): FixtureCatalogEntry[] {
  return buildCommandCatalog().map(
    ({ id, scriptName, binName, entryPath }) => ({
      id,
      scriptName,
      binName,
      entryPath,
    }),
  );
}

function writeCatalogPackage(
  root: string,
  catalog: FixtureCatalogEntry[] = catalogFor(),
): void {
  const bin: Record<string, string> = Object.fromEntries(
    catalog.map((entry) => [entry.binName, `./bin/${entry.binName}.mjs`]),
  );
  bin['idd-onboard'] = './bin/idd-onboard.mjs';
  bin['idd-merged-pr-feedback-sweep'] =
    './bin/idd-merged-pr-feedback-sweep.mjs';
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'fixture', bin }, null, 2)}\n`,
  );
  const commandEntries = catalog
    .map(
      ({ id, scriptName, binName, entryPath }) =>
        `  {\n    id: '${id}',\n    scriptName: '${scriptName}',\n    binName: '${binName}',\n    entryPath: '${entryPath}',\n  },`,
    )
    .join('\n');
  write(
    root,
    'src/scripts/helper-runtime-manifest.mts',
    `const HELPER_COMMANDS: HelperCommand[] = [\n${commandEntries}\n];\nexport const PACKAGE_MANAGER_ONLY_HELPERS = [] as const;\n`,
  );
}

function assertPass(result: CliResult): void {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repository inventory audit passed/);
}

function ruleMessages(
  result: CliResult,
  ruleId: string,
  path: string,
): string[] {
  const prefix = `repository-inventory-audit/${ruleId}: ${path}: `;
  return result.stderr
    .split(/\r?\n/)
    .filter((line) => line.includes(prefix))
    .map((line) => line.slice(line.indexOf(prefix) + prefix.length));
}

function assertFailure(
  result: CliResult,
  ruleId: string,
  path: string,
  message?: string,
): void {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(`repository-inventory-audit/${ruleId}: ${path}:`),
    result.stderr,
  );
  if (message !== undefined) {
    assert.ok(
      ruleMessages(result, ruleId, path).includes(message),
      result.stderr,
    );
  }
}

function editPackageBin(
  root: string,
  edit: (bin: Record<string, string>) => void,
): void {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  edit(packageJson.bin);
  write(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
}

test('CLI audit passes a complete scratch inventory fixture', () => {
  const temp = fixture();
  try {
    write(
      temp.root,
      'package.json',
      `${JSON.stringify({ bin: {} }, null, 2)}\n`,
    );
    write(
      temp.root,
      '.gitattributes',
      'scripts/example.mjs linguist-generated=true\n',
    );
    write(
      temp.root,
      'scripts/example.mjs',
      '#!/usr/bin/env node\n// idd-generated-from: src/scripts/example.mts\n',
    );
    write(temp.root, 'src/scripts/example.mts', 'export {};\n');
    write(temp.root, 'bin/idd-example.mjs', '#!/usr/bin/env node\n');
    write(temp.root, 'src/bin/idd-example.mts', 'export {};\n');
    write(
      temp.root,
      'src/scripts/helper-runtime-manifest.mts',
      "const HELPER_COMMANDS: HelperCommand[] = [\n    id: 'alpha',\n    id: 'beta',\n];\n",
    );
    write(
      temp.root,
      'audit/sync-manifest.json',
      JSON.stringify({
        syncPairs: [{ id: 'alpha' }, { id: 'beta' }],
        bundleBudgets: [{ id: 'one', files: ['a.md', 'b.md'] }],
      }),
    );

    assertPass(runAudit(temp.root, 'repository-inventory'));

    write(temp.root, '.gitattributes', '');
    assertFailure(
      runAudit(temp.root, 'repository-inventory'),
      'generated-script-ledger',
      '.gitattributes',
    );
    write(
      temp.root,
      '.gitattributes',
      'scripts/example.mjs linguist-generated=true\n',
    );
    write(temp.root, 'scripts/orphan.mjs', 'export {};\n');
    assertFailure(
      runAudit(temp.root, 'repository-inventory'),
      'helper-source-pair',
      'scripts/orphan.mjs',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit checks runtime bin registration from a scratch package map', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root);
    assertPass(runAudit(temp.root, 'runtime-registration'));

    const packageJson = JSON.parse(
      readFileSync(join(temp.root, 'package.json'), 'utf8'),
    );
    const first = Object.keys(packageJson.bin)[0];
    delete packageJson.bin[first];
    write(
      temp.root,
      'package.json',
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    assertFailure(
      runAudit(temp.root, 'runtime-registration'),
      'runtime-bin-forward',
      'package.json',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit rejects a package bin with no catalog entry or exception', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root);
    assertPass(runAudit(temp.root, 'runtime-registration'));

    editPackageBin(temp.root, (bin) => {
      bin['idd-unregistered'] = './bin/idd-unregistered.mjs';
    });
    const result = runAudit(temp.root, 'runtime-registration');
    assertFailure(result, 'runtime-bin-reverse', 'package.json');
    assert.ok(
      ruleMessages(result, 'runtime-bin-reverse', 'package.json').some(
        (message) => message.endsWith(': idd-unregistered'),
      ),
      result.stderr,
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit flags each allowlisted bin that is no longer present', () => {
  const temp = fixture();
  try {
    // The two allowlisted bins that writeCatalogPackage adds to the package.
    for (const name of ['idd-onboard', 'idd-merged-pr-feedback-sweep']) {
      writeCatalogPackage(temp.root);
      assertPass(runAudit(temp.root, 'runtime-registration'));

      editPackageBin(temp.root, (bin) => {
        delete bin[name];
      });
      const result = runAudit(temp.root, 'runtime-registration');
      const path = 'src/scripts/repository-inventory-audit.mts';
      assertFailure(result, 'runtime-bin-allowlist', path);
      assert.deepEqual(
        ruleMessages(result, 'runtime-bin-allowlist', path).map((message) =>
          message.slice(message.lastIndexOf(': ') + 2),
        ),
        [name],
        result.stderr,
      );
    }
  } finally {
    temp.cleanup();
  }
});

test('CLI audit reports a package.json that is not a JSON object', () => {
  const temp = fixture();
  try {
    for (const [content, message] of [
      ['{ not json\n', 'invalid JSON'],
      ['[]\n', 'expected a JSON object'],
    ]) {
      writeCatalogPackage(temp.root);
      assertPass(runAudit(temp.root, 'runtime-registration'));

      write(temp.root, 'package.json', content);
      assertFailure(
        runAudit(temp.root, 'runtime-registration'),
        'runtime-bin-map',
        'package.json',
        message,
      );
    }
  } finally {
    temp.cleanup();
  }
});

test('CLI audit reads the runtime catalog from its explicit root', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root, [
      {
        id: 'fixture-command',
        scriptName: 'idd:fixture-command',
        binName: 'idd-fixture-command',
        entryPath: 'scripts/fixture-command.mjs',
      },
    ]);
    assertPass(runAudit(temp.root, 'runtime-registration'));
  } finally {
    temp.cleanup();
  }
});

test('CLI audit checks documented helper invocations against a scratch corpus', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root);
    const packageJson = JSON.parse(
      readFileSync(join(temp.root, 'package.json'), 'utf8'),
    );
    packageJson.bin = {};
    write(
      temp.root,
      'package.json',
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    write(
      temp.root,
      'audit/sync-manifest.json',
      JSON.stringify({ fileSets: [], syncPairs: [] }),
    );
    write(
      temp.root,
      '.github/instructions/main.instructions.md',
      'Use the profile-selected form from docs/idd-helper-scripts.md.\nRun node scripts/minimize-superseded-markers.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
    );
    write(
      temp.root,
      'idd-template/.github/instructions/main.instructions.md',
      '# Template\n',
    );
    write(temp.root, 'idd-template/docs/README.md', '# Template docs\n');
    for (let index = 0; index < 51; index += 1) {
      write(temp.root, `docs/page-${index}.md`, '# Fixture\n');
    }
    assertPass(runAudit(temp.root, 'instruction-invocations'));

    write(
      temp.root,
      '.github/instructions/main.instructions.md',
      'Run node scripts/minimize-superseded-markers.mjs, node scripts/not-registered.mjs, and node scripts/also-not-registered.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
    );
    const result = runAudit(temp.root, 'instruction-invocations');
    assertFailure(
      result,
      'unbacked-helper',
      '.github/instructions/main.instructions.md',
    );
    assert.match(result.stderr, /scripts\/not-registered\.mjs/);
    assert.match(result.stderr, /scripts\/also-not-registered\.mjs/);
  } finally {
    temp.cleanup();
  }
});

test('CLI reports malformed manifest inventory entries without throwing', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root);
    write(
      temp.root,
      'audit/sync-manifest.json',
      JSON.stringify({
        fileSets: [null],
        syncPairs: [null],
      }),
    );
    write(
      temp.root,
      '.github/instructions/main.instructions.md',
      'Use the profile-selected form from docs/idd-helper-scripts.md.\nRun node scripts/minimize-superseded-markers.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
    );
    write(
      temp.root,
      'idd-template/.github/instructions/main.instructions.md',
      '# Template\n',
    );
    write(temp.root, 'idd-template/docs/README.md', '# Template docs\n');
    for (let index = 0; index < 51; index += 1) {
      write(temp.root, `docs/page-${index}.md`, '# Fixture\n');
    }

    assertFailure(
      runAudit(temp.root, 'instruction-invocations'),
      'instruction-invocation-scope',
      'audit/sync-manifest.json',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit checks template workflow invocations against the scratch catalog', () => {
  const temp = fixture();
  try {
    writeCatalogPackage(temp.root);
    const packageJson = JSON.parse(
      readFileSync(join(temp.root, 'package.json'), 'utf8'),
    );
    packageJson.bin = {};
    write(
      temp.root,
      'package.json',
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    write(
      temp.root,
      'idd-template/.github/workflows/one.yml',
      [
        '# node scripts/not-registered.mjs',
        'run: node scripts/rerun-advisory-convergence.mjs',
        'run: node scripts/audit-pr-cleanup.mjs',
        'run: pnpm exec idd-rerun-advisory-convergence',
        'run: npm exec idd-audit-pr-cleanup',
      ].join('\n'),
    );
    write(temp.root, 'idd-template/.github/workflows/two.yml', 'name: two\n');
    write(
      temp.root,
      'idd-template/.github/workflows/three.yml',
      'name: three\n',
    );
    assertPass(runAudit(temp.root, 'template-workflows'));

    write(
      temp.root,
      'idd-template/.github/workflows/one.yml',
      'run: node scripts/not-registered.mjs\nrun: pnpm exec idd-not-registered\n',
    );
    assertFailure(
      runAudit(temp.root, 'template-workflows'),
      'template-workflow-registration',
      'idd-template/.github/workflows/one.yml',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit checks helper wrapper migration using scratch sources', () => {
  const temp = fixture();
  try {
    write(temp.root, 'bin/idd-example.mjs', '#!/usr/bin/env node\n');
    write(
      temp.root,
      'src/bin/idd-example.mts',
      "runHelper('../scripts/example.mjs');\n",
    );
    write(temp.root, 'src/scripts/example.mts', 'runHelperCli();\n');
    assertPass(runAudit(temp.root, 'helper-cli-migration'));

    write(temp.root, 'src/scripts/example.mts', 'export {};\n');
    assertFailure(
      runAudit(temp.root, 'helper-cli-migration'),
      'helper-cli-migration',
      'src/scripts/example.mts',
    );
  } finally {
    temp.cleanup();
  }
});

function writeHelpFlagSources(root: string): void {
  for (const helper of COVERED_HELPERS) {
    write(root, `src/scripts/${helper}.mts`, 'const HELPER_FLAG_SPEC = {};\n');
  }
  for (const { helper } of EXCLUDED_HELPERS) {
    write(root, `src/scripts/${helper}.mts`, 'export {};\n');
  }
}

test('CLI audit checks help-flag coverage against scratch source fixtures', () => {
  const temp = fixture();
  try {
    writeHelpFlagSources(temp.root);
    assertPass(runAudit(temp.root, 'help-flag-coverage'));

    const excluded = EXCLUDED_HELPERS[0];
    assert.ok(excluded);
    rmSync(join(temp.root, 'src/scripts', `${excluded.helper}.mts`));
    assertFailure(
      runAudit(temp.root, 'help-flag-coverage'),
      'help-flag-coverage',
      `src/scripts/${excluded.helper}.mts`,
    );
    write(temp.root, `src/scripts/${excluded.helper}.mts`, 'export {};\n');

    write(
      temp.root,
      'src/scripts/new-helper.mts',
      'const HELPER_FLAG_SPEC = {};\n',
    );
    assertFailure(
      runAudit(temp.root, 'help-flag-coverage'),
      'help-flag-coverage',
      'src/scripts/new-helper.mts',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit flags a covered helper that no longer declares a flag spec', () => {
  const temp = fixture();
  try {
    writeHelpFlagSources(temp.root);
    assertPass(runAudit(temp.root, 'help-flag-coverage'));

    const covered = COVERED_HELPERS[0];
    assert.ok(covered);
    write(temp.root, `src/scripts/${covered}.mts`, 'export {};\n');
    assertFailure(
      runAudit(temp.root, 'help-flag-coverage'),
      'help-flag-coverage',
      `src/scripts/${covered}.mts`,
      'covered helper no longer declares FLAG_SPEC',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit flags an excluded helper that now declares a flag spec', () => {
  const temp = fixture();
  try {
    writeHelpFlagSources(temp.root);
    assertPass(runAudit(temp.root, 'help-flag-coverage'));

    const excluded = EXCLUDED_HELPERS[0];
    assert.ok(excluded);
    write(
      temp.root,
      `src/scripts/${excluded.helper}.mts`,
      'const HELPER_FLAG_SPEC = {};\n',
    );
    assertFailure(
      runAudit(temp.root, 'help-flag-coverage'),
      'help-flag-coverage',
      `src/scripts/${excluded.helper}.mts`,
      'excluded helper now declares FLAG_SPEC',
    );
  } finally {
    temp.cleanup();
  }
});

test('CLI audit checks required manifest ledgers using a scratch manifest', () => {
  const temp = fixture();
  try {
    write(
      temp.root,
      'audit/sync-manifest.json',
      JSON.stringify({
        rootMarkdownAllowlist: { allowed: ROOT_MARKDOWN },
        instructionSizeBudgets: REQUIRED_BUDGETS.map((glob, index) => ({
          id: `budget-${index}`,
          glob,
        })),
      }),
    );
    assertPass(runAudit(temp.root, 'manifest-ledgers'));

    write(
      temp.root,
      'audit/sync-manifest.json',
      JSON.stringify({
        rootMarkdownAllowlist: { allowed: ROOT_MARKDOWN },
        instructionSizeBudgets: [{ id: 'budget', glob: REQUIRED_BUDGETS[0] }],
      }),
    );
    assertFailure(
      runAudit(temp.root, 'manifest-ledgers'),
      'instruction-size-budget-ledger',
      'audit/sync-manifest.json',
    );
  } finally {
    temp.cleanup();
  }
});

test('pure invocation detectors report stable rule ids and relative paths', () => {
  const files: AuditFile[] = [
    {
      path: 'idd-template/docs/example.md',
      content: 'Run node scripts/not-registered.mjs and bin/idd-example.mjs.',
    },
  ];
  const violations = collectHelperInvocationViolations(files, {
    commandCatalog: [
      {
        entryPath: 'scripts/example.mjs',
        binName: 'idd-example',
        scriptName: 'idd:example',
      },
    ],
    distributedFiles: new Set(['idd-template/docs/example.md']),
  });
  assert.deepEqual(
    violations.map(({ ruleId, path }) => ({ ruleId, path })),
    [
      { ruleId: 'unbacked-helper', path: 'idd-template/docs/example.md' },
      { ruleId: 'distributed-bin-path', path: 'idd-template/docs/example.md' },
    ],
  );

  const workflow = scanTemplateWorkflowRegistrations(
    [
      {
        path: 'idd-template/.github/workflows/example.yml',
        content:
          'run: node scripts/advisory-comment-debounce.mjs\nrun: pnpm exec idd-advisory-comment-debounce',
      },
    ],
    [],
  );
  assert.deepEqual(
    workflow.violations.map(({ message }) => message),
    [
      'workflow invokes an unregistered node helper: scripts/advisory-comment-debounce.mjs',
      'workflow invokes an unregistered package helper: idd-advisory-comment-debounce',
    ],
  );
});

test('CLI usage lists check families and requires no installed package dependency', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '' },
  });
  for (const family of CHECK_FAMILIES) assert.ok(help.includes(family));
});

test('CLI fails closed when a selected inventory directory cannot be inspected', () => {
  const temp = fixture();
  try {
    assertFailure(
      runAudit(temp.root, 'helper-cli-migration'),
      'inspection',
      'bin',
    );
  } finally {
    temp.cleanup();
  }
});

test('unpointed-source-form unit test checks bare invocations and pointer positioning', () => {
  const violations: { ruleId: string; path: string; message: string }[] = [];

  // 1. Bare use with no pointer is a violation
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.ruleId, 'unpointed-source-form');
  assert.match(violations[0]?.message ?? '', /\bat line 1\b/);

  // 2. Pointer earlier in the file passes
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Use the profile-selected form from docs/idd-helper-scripts.md.\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 3. Pointer later in the same fenced block passes
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '```sh\nnode scripts/minimize-superseded-markers.mjs\n# profile-selected form\n```',
    violations,
  );
  assert.equal(violations.length, 0);

  // 4. Pointer later in the same paragraph passes
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node scripts/minimize-superseded-markers.mjs using its profile-selected form.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 5. Pointer later in a different block is a violation
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node scripts/minimize-superseded-markers.mjs.\n\nUse profile-selected helpers later.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 1\b/);

  // 6. profile-selected inside an HTML comment does not count
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '<!-- profile-selected -->\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 3\b/);

  // 7. <!-- opener inside an inline code span does not hide the text after it
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Check `<!-- review-watermark:` markers. Use profile-selected form.\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 8. <!-- opener inside a fenced block does not hide text after it
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '```sh\n# <!--\n```\n\nUse profile-selected form.\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 9. Use of a source-only tool listed in exemption ledgers is not a violation
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node scripts/sync-docs.mjs --apply.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 10. An invocation wrapped across two lines is detected
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node\nscripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 1\b/);

  // 11. Prefix `./scripts/` is detected
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node ./scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 1\b/);

  // 12. Prefix `<idd-skill>/scripts/` is detected
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Run node <idd-skill>/scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 1\b/);

  // 13. Case-insensitive pointer matching passes
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    'Use the Profile-Selected form from docs/idd-helper-scripts.md.\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 0);

  // 14. Offending source line is accurately reported on later lines
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '# Heading\n\nSome paragraph text.\n\nMore intro text.\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 7\b/);

  // 15. Multiline HTML comment spanning blank lines does not leak pointer
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '<!--\ncomment\n\nprofile-selected\n-->\n\nRun node scripts/minimize-superseded-markers.mjs.',
    violations,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /\bat line 7\b/);

  // 16. Tilde fence recognizes pointer inside the same fence
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '~~~sh\nnode scripts/minimize-superseded-markers.mjs\n# profile-selected form\n~~~',
    violations,
  );
  assert.equal(violations.length, 0);

  // 17. Commented-out bare invocation inside HTML comment is ignored
  violations.length = 0;
  checkUnpointedSourceFormFile(
    'test.md',
    '<!--\nRun node scripts/minimize-superseded-markers.mjs.\n-->',
    violations,
  );
  assert.equal(violations.length, 0);
});

test('CLI inventory audit unpointed-source-form checks instruction scopes and ignores docs', () => {
  const temp = fixture();
  try {
    // Instruction file without pointer fails
    write(
      temp.root,
      '.github/instructions/main.instructions.md',
      'Run node scripts/minimize-superseded-markers.mjs.\n',
    );
    write(
      temp.root,
      'idd-template/.github/instructions/template.md',
      '# Template\n',
    );
    assertFailure(
      runAudit(temp.root, 'unpointed-source-form'),
      'unpointed-source-form',
      '.github/instructions/main.instructions.md',
    );

    // File under lite/ is checked
    write(
      temp.root,
      '.github/instructions/main.instructions.md',
      'Use profile-selected form.\n\nRun node scripts/minimize-superseded-markers.mjs.\n',
    );
    write(
      temp.root,
      '.github/instructions/lite/test-lite.instructions.md',
      'Run node scripts/minimize-superseded-markers.mjs.\n',
    );
    assertFailure(
      runAudit(temp.root, 'unpointed-source-form'),
      'unpointed-source-form',
      '.github/instructions/lite/test-lite.instructions.md',
    );

    // Bare use under docs/ is NOT flagged
    write(
      temp.root,
      '.github/instructions/lite/test-lite.instructions.md',
      'Use profile-selected form.\n\nRun node scripts/minimize-superseded-markers.mjs.\n',
    );
    write(
      temp.root,
      'docs/guide.md',
      'Run node scripts/minimize-superseded-markers.mjs.\n',
    );
    write(
      temp.root,
      'idd-template/docs/guide.md',
      'Run node scripts/minimize-superseded-markers.mjs.\n',
    );
    assertPass(runAudit(temp.root, 'unpointed-source-form'));
  } finally {
    temp.cleanup();
  }
});

test('ten instruction files carry verified profile-selected pointers with docs paths', () => {
  const TEN_FILES = [
    'idd-template/.github/instructions/idd-merge.instructions.md',
    'idd-template/.github/instructions/idd-overview-appendix.instructions.md',
    'idd-template/.github/instructions/idd-resume.instructions.md',
    'idd-template/.github/instructions/idd-resume-stall.instructions.md',
    'idd-template/.github/instructions/idd-suitability.instructions.md',
    'idd-template/.github/instructions/idd-review-snapshot.instructions.md',
    'idd-template/.github/instructions/lite/idd-ci-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-advisory-wait-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-resume-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-resume-stall-lite.instructions.md',
  ];
  const LITE_FILES = new Set([
    'idd-template/.github/instructions/lite/idd-ci-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-advisory-wait-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-resume-lite.instructions.md',
    'idd-template/.github/instructions/lite/idd-resume-stall-lite.instructions.md',
  ]);

  const SECTION_SUFFICIENT_FILES = new Map<string, string>([
    [
      'idd-template/.github/instructions/idd-review-snapshot.instructions.md',
      '## E1 — Fetch review items into ReviewItems_snapshot',
    ],
  ]);

  function validateFilePointer(path: string, content: string): boolean {
    const blocks = content.split(/\n\s*\n/);
    const pointerBlock = blocks.find((b) => b.includes('profile-selected'));
    if (!pointerBlock) return false;

    if (LITE_FILES.has(path)) {
      const instructsToResolve =
        /resolve\s+each\s+`node scripts\/<h>\.mjs`\s+to\s+its\s+profile-selected\s+form/i.test(
          pointerBlock,
        );
      if (!instructsToResolve) return false;
    }

    if (pointerBlock.includes('docs/idd-helper-scripts.md')) {
      return true;
    }

    const allowedSection = SECTION_SUFFICIENT_FILES.get(path);
    if (allowedSection) {
      const sectionStart = content.indexOf(allowedSection);
      if (sectionStart !== -1) {
        const nextSectionMatch = content
          .slice(sectionStart + allowedSection.length)
          .search(/\n## /);
        const sectionContent =
          nextSectionMatch === -1
            ? content.slice(sectionStart)
            : content.slice(
                sectionStart,
                sectionStart + allowedSection.length + nextSectionMatch,
              );
        if (
          sectionContent.includes('profile-selected') &&
          sectionContent.includes('docs/idd-helper-scripts.md')
        ) {
          return true;
        }
      }
    }
    return false;
  }

  for (const relPath of TEN_FILES) {
    const fullPath = join(REPO_ROOT, relPath);
    const content = readFileSync(fullPath, 'utf8');
    assert.ok(
      validateFilePointer(relPath, content),
      `Pointer validation failed on real file ${relPath}`,
    );

    const genPath = join(REPO_ROOT, relPath.replace('idd-template/', ''));
    const genContent = readFileSync(genPath, 'utf8');
    assert.ok(
      validateFilePointer(relPath, genContent),
      `Pointer validation failed on generated file ${genPath}`,
    );
  }

  const dummyParenthetical =
    'Run node scripts/foo.mjs (profile-selected form).';
  assert.equal(
    validateFilePointer('dummy.md', dummyParenthetical),
    false,
    'Parenthetical without path should not pass',
  );

  const dummyNextToCommand = 'Run profile-selected node scripts/foo.mjs here.';
  assert.equal(
    validateFilePointer('dummy.md', dummyNextToCommand),
    false,
    'profile-selected next to command without path should not pass',
  );
});
