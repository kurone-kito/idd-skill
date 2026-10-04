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

function assertFailure(result: CliResult, ruleId: string, path: string): void {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(`repository-inventory-audit/${ruleId}: ${path}:`),
    result.stderr,
  );
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
      'Run node scripts/minimize-superseded-markers.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
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
      'Run node scripts/minimize-superseded-markers.mjs and node scripts/not-registered.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
    );
    assertFailure(
      runAudit(temp.root, 'instruction-invocations'),
      'unbacked-helper',
      '.github/instructions/main.instructions.md',
    );
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
      'Run node scripts/minimize-superseded-markers.mjs.\nShared libraries include scripts/protocol-helpers.mjs and scripts/policy-helpers.mjs.\n',
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

test('CLI audit checks help-flag coverage against scratch source fixtures', () => {
  const temp = fixture();
  try {
    for (const helper of COVERED_HELPERS) {
      write(
        temp.root,
        `src/scripts/${helper}.mts`,
        'const HELPER_FLAG_SPEC = {};\n',
      );
    }
    for (const { helper } of EXCLUDED_HELPERS) {
      write(temp.root, `src/scripts/${helper}.mts`, 'export {};\n');
    }
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
