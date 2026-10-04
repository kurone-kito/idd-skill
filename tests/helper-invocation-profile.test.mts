import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AuditFile as FileInput,
  CatalogEntry as ManifestCommand,
  SyncManifestShape as SyncManifest,
} from '../src/scripts/repository-inventory-audit.mts';
import {
  collectHelperInvocationViolations,
  resolveDistributedFiles,
} from '../src/scripts/repository-inventory-audit.mts';

test('resolveDistributedFiles classifies idd-template sources, their generated copies, and source-repo-only docs correctly', () => {
  const repoFiles = [
    'idd-template/docs/permissions.md',
    'docs/permissions.md',
    'docs/weak-model-authoring-lite-profile-design.md',
    'idd-template/docs/idd-helper-scripts.md',
    'docs/idd-helper-scripts.md',
  ];
  const manifest: SyncManifest = {
    fileSets: [
      {
        sourceGlob: 'idd-template/docs/idd-*.md',
        targetGlob: 'docs/idd-*.md',
      },
    ],
    syncPairs: [
      {
        source: 'idd-template/docs/permissions.md',
        target: 'docs/permissions.md',
      },
    ],
  };

  const distributed = resolveDistributedFiles(repoFiles, manifest);

  assert.equal(distributed.has('idd-template/docs/permissions.md'), true);
  assert.equal(distributed.has('docs/permissions.md'), true);
  assert.equal(
    distributed.has('idd-template/docs/idd-helper-scripts.md'),
    true,
  );
  assert.equal(distributed.has('docs/idd-helper-scripts.md'), true);
  assert.equal(
    distributed.has('docs/weak-model-authoring-lite-profile-design.md'),
    false,
  );
});

test('fails on a helper invocation naming no HELPER_COMMANDS entry and no allowlist entry (rule 2)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/real-helper.mjs',
      binName: 'idd-real-helper',
      scriptName: 'idd:real-helper',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/example.md',
      content:
        'Run `node scripts/totally-fake-helper.mjs --apply` before merging.',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(),
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.ruleId, 'unbacked-helper');
  assert.equal(violations[0]?.name, 'scripts/totally-fake-helper.mjs');
});

test('rejects an adopter-root invocation of a source-repository helper', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/example.md',
        content: 'Run `node ./scripts/verify-import-mirror.mjs`.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.form, 'node-scripts');
  assert.equal(violations[0]?.name, 'scripts/verify-import-mirror.mjs');
});

test('does not fail on a backed or allowlisted helper invocation (rule 2 negative case)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/real-helper.mjs',
      binName: 'idd-real-helper',
      scriptName: 'idd:real-helper',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/example.md',
      content:
        'Run `node scripts/real-helper.mjs` (backed), or `node scripts/sync-docs.mjs` (allowlisted).',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(),
  });

  assert.deepEqual(violations, []);
});

test('accepts a registered package-manager-only helper path', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/idd-helper-scripts.md',
        content:
          'Run `node node_modules/@kurone-kito/idd-skill/scripts/verify-import-mirror.mjs` for the package-manager exception.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.deepEqual(violations, []);
});

test('rejects an unregistered package-manager-only helper path', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/example.md',
        content:
          'Run `node ./node_modules/@kurone-kito/idd-skill/scripts/not-a-helper.mjs`.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.form, 'package-manager-entry');
  assert.equal(
    violations[0]?.name,
    'node_modules/@kurone-kito/idd-skill/scripts/not-a-helper.mjs',
  );
});

test('accepts the registered source-checkout helper path', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/onboarding/agent-entry-and-verification.md',
        content:
          'Run `node <idd-skill>/scripts/verify-import-mirror.mjs` from a source checkout.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.deepEqual(violations, []);
});

test('rejects the source-checkout helper without its checkout prefix', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/example.md',
        content:
          'Run `node scripts/verify-import-mirror.mjs` from the adopter root.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.form, 'node-scripts');
  assert.equal(violations[0]?.name, 'scripts/verify-import-mirror.mjs');
});

test('rejects an unregistered source-checkout helper path', () => {
  const violations = collectHelperInvocationViolations(
    [
      {
        path: 'idd-template/docs/example.md',
        content: 'Run `node <idd-skill>/scripts/not-a-helper.mjs`.',
      },
    ],
    {
      commandCatalog: [],
      distributedFiles: new Set(),
    },
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.form, 'node-scripts');
  assert.equal(violations[0]?.name, 'scripts/not-a-helper.mjs');
});

test('fails on a bin/idd-* path prescribed in a distributed file, and not in a source-repo-only file (rule 3)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/idd-merge-execute.mjs',
      binName: 'idd-merge-execute',
      scriptName: 'idd:merge-execute',
    },
  ];
  const content =
    'Run `node bin/idd-merge-execute.mjs --apply` to execute the merge.';
  const files: FileInput[] = [
    { path: 'idd-template/docs/example.md', content },
    { path: 'docs/source-repo-only-design-note.md', content },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(['idd-template/docs/example.md']),
  });

  assert.deepEqual(
    violations.map((v) => ({ file: v.path, rule: v.ruleId })),
    [{ file: 'idd-template/docs/example.md', rule: 'distributed-bin-path' }],
  );
});

test('does not fail on a bin/idd-* path in an explicitly exempted distributed file (permissions.md)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/idd-merge-execute.mjs',
      binName: 'idd-merge-execute',
      scriptName: 'idd:merge-execute',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/permissions.md',
      content:
        'The opt-in template counterpart denies `bin/idd-merge-execute.mjs*` for exactly this reason.',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(['docs/permissions.md']),
  });

  assert.deepEqual(violations, []);
});
