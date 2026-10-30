import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOkfIndexRows,
  collectBinExecutableModeViolations,
  collectDocBudgetDriftViolations,
  collectDuplicateSyncPairTargets,
  collectEnginesRangeMirrorViolations,
  collectGeneratedFromBannerViolations,
  collectInstructionSizeBudgetViolations,
  collectOkfFrontmatterViolations,
  collectPolicyConfigDrift,
  escapeMarkdownTableCell,
  extractOkfIndexFields,
  generatedFromBanner,
  injectGeneratedFromBanner,
  inspectHelperRuntimeConfig,
  isBannerScopedInstructionTarget,
  normalizePolicyConfig,
  parseGeneratedFromBannerSource,
  renderOkfIndexMarkdownTable,
  resolveCollaboratorMarkerTrust,
  resolveGeneratedBlockFiles,
  stripGeneratedFromBanner,
} from '../src/scripts/consistency-helpers.mts';
import { findPlaceholders } from '../src/scripts/idd-doctor.mts';
import {
  extractSection,
  normalizeWhitespace,
  readJson,
  readText,
} from './test-utils.mts';

test('placeholder scenarios detect clean and dirty post-onboarding fixtures', () => {
  const clean = collectPlaceholderHits(
    new URL('./fixtures/consistency/placeholders/clean', import.meta.url),
  );
  const dirty = collectPlaceholderHits(
    new URL('./fixtures/consistency/placeholders/dirty', import.meta.url),
  );

  assert.deepEqual(clean, []);
  assert.deepEqual(dirty, [
    '.github/idd/config.json: {{PROJECT_MARKER_PREFIX}}, {{TRUSTED_MARKER_ACTOR}}',
    'README.md: {{REPO_NAME}}',
  ]);
});

test('instruction size budget skips with a notice when no git comparison base resolves', () => {
  let listed = false;
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', phaseLimitBytes: 1 },
    null,
    () => {
      listed = true;
      return ['idd-x.instructions.md'];
    },
    () => {
      throw new Error('must not read files on the null-base skip path');
    },
  );
  assert.equal(listed, false, 'must not list files on the null-base skip path');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notices, [
    'instruction-size-budgets: skipped instruction size budget check because no git comparison base was available',
  ]);
});

// #3028 refactor-ordering regression: resolveInstructionSizeBudgetConfig
// validation must stay strictly behind the changedFiles === null skip, so
// an invalid config in a checkout with no resolvable comparison base still
// degrades to the skip notice above rather than newly surfacing as a hard
// validation error.
test('instruction size budget still just skips with a notice when no git comparison base resolves, even with an invalid config', () => {
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', alwaysLoadedLimitBytes: 'not-a-number' },
    null,
    () => {
      throw new Error('must not list files on the null-base skip path');
    },
    () => {
      throw new Error('must not read files on the null-base skip path');
    },
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notices, [
    'instruction-size-budgets: skipped instruction size budget check because no git comparison base was available',
  ]);
});

test('instruction size budget reads and audits only changed files, honoring both limits', () => {
  const texts: Record<string, string> = {
    'idd-phase.instructions.md': 'p'.repeat(120),
    'idd-core.instructions.md': `---\napplyTo: "**"\n---\n${'c'.repeat(120)}`,
    'idd-untouched.instructions.md': 'u'.repeat(10_000),
  };
  const readPaths: string[] = [];
  const result = collectInstructionSizeBudgetViolations(
    {
      id: 'instruction-size-budgets',
      alwaysLoadedLimitBytes: 50,
      phaseLimitBytes: 100,
    },
    new Set(['idd-phase.instructions.md', 'idd-core.instructions.md']),
    () => Object.keys(texts),
    (path) => {
      readPaths.push(path);
      return texts[path];
    },
  );
  // The unchanged file is never read (no wasted disk I/O on large repos).
  assert.deepEqual(readPaths.sort(), [
    'idd-core.instructions.md',
    'idd-phase.instructions.md',
  ]);
  assert.deepEqual(result.notices, []);
  assert.equal(result.errors.length, 2);
  assert.ok(
    result.errors.some((e) =>
      /idd-phase\.instructions\.md is 120 bytes .*phase/.test(e),
    ),
  );
  assert.ok(
    result.errors.some((e) =>
      /idd-core\.instructions\.md is \d+ bytes .*always-loaded/.test(e),
    ),
  );
});

test('instruction size budget returns nothing for absent config', () => {
  const result = collectInstructionSizeBudgetViolations(
    null,
    new Set(),
    () => {
      throw new Error('must not list files when config is absent');
    },
    () => {
      throw new Error('must not read files when config is absent');
    },
  );
  assert.deepEqual(result, { errors: [], notices: [] });
});

// #1721: `??` only substitutes on null/undefined, so a non-numeric budget
// limit used to coerce every size comparison to NaN (always false),
// silently passing the guard (fail-open) instead of being rejected.
test('instruction size budget rejects a non-numeric alwaysLoadedLimitBytes instead of silently passing (fail-open regression)', () => {
  const result = collectInstructionSizeBudgetViolations(
    {
      id: 'instruction-size-budgets',
      alwaysLoadedLimitBytes: 'not-a-number',
    },
    new Set(['idd-core.instructions.md']),
    () => {
      throw new Error('must not list files once validation rejects config');
    },
    () => {
      throw new Error('must not read files once validation rejects config');
    },
  );
  assert.deepEqual(result.notices, []);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /alwaysLoadedLimitBytes must be a positive integer \(got "not-a-number"\)/,
  );
});

test('instruction size budget rejects a non-positive phaseLimitBytes', () => {
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', phaseLimitBytes: 0 },
    new Set(),
    () => [],
    () => '',
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /phaseLimitBytes must be a positive integer \(got 0\)/,
  );
});

test('instruction size budget rejects a non-string alwaysLoadedPattern', () => {
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', alwaysLoadedPattern: 42 },
    new Set(),
    () => [],
    () => '',
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /alwaysLoadedPattern must be a string \(got 42\)/,
  );
});

// Regression coverage for a Copilot review finding on PR #1776: `??` only
// substitutes on `undefined`, not `null`, but the two are not the same
// authoring intent -- an explicit `null` in the manifest is a malformed
// value that must be rejected, not silently treated the same as "field
// omitted" and defaulted.
test('instruction size budget rejects an explicit null alwaysLoadedPattern instead of silently defaulting it', () => {
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', alwaysLoadedPattern: null },
    new Set(),
    () => [],
    () => '',
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /alwaysLoadedPattern must be a string \(got null\)/,
  );
});

test('instruction size budget rejects an alwaysLoadedPattern that does not compile as a regular expression', () => {
  const result = collectInstructionSizeBudgetViolations(
    { id: 'instruction-size-budgets', alwaysLoadedPattern: '(' },
    new Set(),
    () => [],
    () => '',
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /alwaysLoadedPattern "\(" does not compile as a regular expression/,
  );
});

const BANNER_SOURCE =
  'idd-template/.github/instructions/idd-claim.instructions.md';

test('generated-from banner injects after frontmatter and round-trips', () => {
  const withFrontmatter = `---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\n\n# Heading\n\nBody.\n`;
  const injected = injectGeneratedFromBanner(withFrontmatter, BANNER_SOURCE);
  // Banner sits after the closing frontmatter fence, before the heading.
  assert.match(
    injected,
    /---\n\n<!-- idd-generated-from:\n.+\nGenerated by sync-docs\..*\n.*-->\n\n# Heading/,
  );
  // Exact inverse restores the original byte-for-byte.
  assert.equal(stripGeneratedFromBanner(injected), withFrontmatter);
  assert.equal(parseGeneratedFromBannerSource(injected), BANNER_SOURCE);
});

test('generated-from banner injects at the top when there is no frontmatter and round-trips', () => {
  const noFrontmatter = '# Heading\n\nBody text.\n';
  const injected = injectGeneratedFromBanner(noFrontmatter, BANNER_SOURCE);
  assert.ok(injected.startsWith(`${generatedFromBanner(BANNER_SOURCE)}\n\n`));
  assert.ok(injected.endsWith(noFrontmatter));
  assert.equal(stripGeneratedFromBanner(injected), noFrontmatter);
  assert.equal(parseGeneratedFromBannerSource(injected), BANNER_SOURCE);
});

test('every generated-from banner line stays within the 80-char MD013 limit', () => {
  // Exercise the longest in-scope source path too — the banner's source line is
  // the only variable-length line, so a longer target would surface here.
  const longestSource =
    'idd-template/.github/instructions/idd-overview-appendix.instructions.md';
  for (const source of [BANNER_SOURCE, longestSource]) {
    for (const line of generatedFromBanner(source).split('\n')) {
      assert.ok(line.length <= 80, `banner line too long (${source}): ${line}`);
    }
  }
});

test('generated-from banner round-trips even without a blank line after frontmatter', () => {
  // A frontmatter block with no blank line before the heading is an edge shape
  // dprint/markdownlint would normally normalize, but strip must still be an
  // exact inverse of inject for it.
  const noBlank = '---\napplyTo: "**"\n---\n# Heading\n\nBody.\n';
  const injected = injectGeneratedFromBanner(noBlank, BANNER_SOURCE);
  assert.equal(stripGeneratedFromBanner(injected), noBlank);
  assert.equal(parseGeneratedFromBannerSource(injected), BANNER_SOURCE);
});

test('banner scope predicate covers only exact/concreted instruction targets', () => {
  assert.equal(
    isBannerScopedInstructionTarget(
      '.github/instructions/idd-claim.instructions.md',
      'exact',
    ),
    true,
  );
  assert.equal(
    isBannerScopedInstructionTarget(
      '.github/instructions/idd-work.instructions.md',
      'concreted',
    ),
    true,
  );
  // structure targets are validated structurally, not byte-generated.
  assert.equal(
    isBannerScopedInstructionTarget(
      '.github/instructions/idd-discover.instructions.md',
      'structure',
    ),
    false,
  );
  // generated docs / skills targets are a deliberate follow-up, out of scope.
  assert.equal(
    isBannerScopedInstructionTarget('docs/concepts.md', 'exact'),
    false,
  );
});

test('parseGeneratedFromBannerSource returns null without a banner', () => {
  assert.equal(parseGeneratedFromBannerSource('# Heading\n\nBody.\n'), null);
});

test('parseGeneratedFromBannerSource ignores a banner-shaped comment out of position', () => {
  // A banner is only recognized at the top or immediately after frontmatter; a
  // copy pasted mid-body must not be accepted as the generated-from banner.
  const midBody = `# Heading\n\nSome text.\n\n${generatedFromBanner(
    BANNER_SOURCE,
  )}\n\nMore text.\n`;
  assert.equal(parseGeneratedFromBannerSource(midBody), null);
});

test('collectGeneratedFromBannerViolations passes when the banner matches, fails on missing/wrong', () => {
  const target = '.github/instructions/idd-claim.instructions.md';
  const pairs = [
    { id: 'idd-claim', source: BANNER_SOURCE, target, mode: 'exact' },
    // A structure target must be ignored even if it has no banner.
    {
      id: 'idd-discover',
      source: 'idd-template/.github/instructions/idd-discover.instructions.md',
      target: '.github/instructions/idd-discover.instructions.md',
      mode: 'structure',
    },
  ];
  const good = injectGeneratedFromBanner('# Heading\n\nBody.\n', BANNER_SOURCE);

  // Passing case: correct banner, structure target skipped.
  assert.deepEqual(
    collectGeneratedFromBannerViolations(pairs, (path) =>
      path === target ? good : '# discover\n',
    ),
    [],
  );

  // Missing-marker case: the target carries no banner.
  const missing = collectGeneratedFromBannerViolations(pairs, (path) =>
    path === target ? '# Heading\n\nBody.\n' : '# discover\n',
  );
  assert.equal(missing.length, 1);
  assert.match(
    missing[0],
    /idd-claim:.*missing a well-formed idd-generated-from banner/,
  );

  // Wrong-source case: banner names a different source.
  const wrong = collectGeneratedFromBannerViolations(pairs, (path) =>
    path === target
      ? injectGeneratedFromBanner(
          '# Heading\n\nBody.\n',
          'idd-template/.github/instructions/idd-merge.instructions.md',
        )
      : '# discover\n',
  );
  assert.equal(wrong.length, 1);
  assert.match(
    wrong[0],
    /banner names .*idd-merge.*but its source is .*idd-claim/,
  );
});

test('collectGeneratedFromBannerViolations is not fooled by a canonical banner copy-pasted elsewhere', () => {
  const target = '.github/instructions/idd-claim.instructions.md';
  const pairs = [
    { id: 'idd-claim', source: BANNER_SOURCE, target, mode: 'exact' },
  ];
  // The in-position banner is malformed (tampered note line), but a correct
  // canonical banner is copy-pasted lower in the file. The check must still fail
  // on the in-position banner rather than matching the pasted copy.
  const tamperedInPosition = [
    '<!-- idd-generated-from:',
    BANNER_SOURCE,
    'TAMPERED note line that is not the canonical text',
    '`node scripts/sync-docs.mjs --apply`; do not edit this file. -->',
  ].join('\n');
  const text = `${tamperedInPosition}\n\n# Heading\n\nExample:\n\n${generatedFromBanner(
    BANNER_SOURCE,
  )}\n\nBody.\n`;
  const result = collectGeneratedFromBannerViolations(pairs, () => text);
  assert.equal(result.length, 1);
  assert.match(result[0], /idd-claim:.*generated-from banner is malformed/);
});

test('instruction size budget excludes the generated-from banner from the measured size', () => {
  const target = 'idd-claim.instructions.md';
  const source = BANNER_SOURCE;
  const contentUnderBudget = `# Heading\n\n${'x'.repeat(60)}\n`;
  const withBanner = injectGeneratedFromBanner(contentUnderBudget, source);
  // The banner inflates the raw bytes over the limit, but the measured size
  // (banner stripped) is the content size, which is under budget.
  assert.ok(Buffer.byteLength(withBanner, 'utf8') > 100);
  const result = collectInstructionSizeBudgetViolations(
    {
      id: 'instruction-size-budgets',
      alwaysLoadedLimitBytes: 50,
      phaseLimitBytes: 100,
    },
    new Set([target]),
    () => [target],
    () => withBanner,
  );
  assert.deepEqual(result.errors, []);
});

// Keep representative of live audit/sync-manifest.json
// instructionSizeBudgets (currently on main).
const DOC_BUDGET_SIZE = {
  alwaysLoadedLimitBytes: 20_000,
  phaseLimitBytes: 40_000,
};
// Keep representative of live audit/sync-manifest.json bundleBudgets
// (standard + lite independent ceilings currently on main).
const DOC_BUDGET_BUNDLES = [
  { limitBytes: 104_000 },
  { limitBytes: 45_000 },
  { limitBytes: 24_000 },
  { limitBytes: 16_000 },
  { limitBytes: 26_000 },
];

test('doc budget guard passes when documented values match the manifest', () => {
  const texts: Record<string, string> = {
    'README.md': '| Phase | 40,000 bytes |\n| Always | 20,000 bytes |',
    // a hardcoded bundle value that still matches the manifest is allowed
    'strategy.md': 'discovery bundle is 104,000 bytes',
    // a doc that reads limits live via jq carries no number → never flagged
    'jq.md':
      "read the live values with jq '.bundleBudgets' audit/sync-manifest.json",
  };
  const result = collectDocBudgetDriftViolations(
    { files: ['README.md', 'strategy.md', 'jq.md'] },
    DOC_BUDGET_SIZE,
    DOC_BUDGET_BUNDLES,
    (path) => texts[path],
  );
  assert.deepEqual(result, { errors: [], notices: [] });
});

test('doc budget guard flags a value that drifted from every manifest budget', () => {
  const result = collectDocBudgetDriftViolations(
    { id: 'doc-budget-drift', files: ['README.md'] },
    DOC_BUDGET_SIZE,
    DOC_BUDGET_BUNDLES,
    () => '| Phase instruction file | 30,000 bytes |',
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /doc-budget-drift: README\.md states 30,000 bytes, which is not a current sync-manifest budget value \(valid: 16000, 20000, 24000, 26000, 40000, 45000, 104000\)/,
  );
});

test('doc budget guard is a no-op without config and notices on empty budgets', () => {
  assert.deepEqual(
    collectDocBudgetDriftViolations(
      null,
      DOC_BUDGET_SIZE,
      DOC_BUDGET_BUNDLES,
      () => {
        throw new Error('must not read files when config is absent');
      },
    ),
    { errors: [], notices: [] },
  );
  const noBudgets = collectDocBudgetDriftViolations(
    { id: 'doc-budget-drift', files: ['README.md'] },
    null,
    [],
    () => '32,200 bytes',
  );
  assert.deepEqual(noBudgets.errors, []);
  assert.equal(noBudgets.notices.length, 1);
  assert.match(noBudgets.notices[0], /skipped doc budget guard/);
});

test('doc budget guard unions size budgets across an array of per-glob entries', () => {
  // instructionSizeBudgets in audit/sync-manifest.json is an array — one
  // entry per audited glob (#1667) — so the drift guard must union every
  // entry's limits into the same valid-value set instead of only reading
  // a single object's fields.
  const arrayBudgets = [
    { id: 'instruction-size-budgets-dogfood', ...DOC_BUDGET_SIZE },
    {
      id: 'instruction-size-budgets-idd-template',
      alwaysLoadedLimitBytes: 20_000,
      phaseLimitBytes: 33_000,
    },
  ];
  const passing = collectDocBudgetDriftViolations(
    { id: 'doc-budget-drift', files: ['README.md'] },
    arrayBudgets,
    DOC_BUDGET_BUNDLES,
    () => '| Phase instruction file | 33,000 bytes |',
  );
  assert.deepEqual(passing, { errors: [], notices: [] });

  const drifted = collectDocBudgetDriftViolations(
    { id: 'doc-budget-drift', files: ['README.md'] },
    arrayBudgets,
    DOC_BUDGET_BUNDLES,
    () => '| Phase instruction file | 30,000 bytes |',
  );
  assert.equal(drifted.errors.length, 1);
  assert.match(
    drifted.errors[0],
    /doc-budget-drift: README\.md states 30,000 bytes/,
  );
});

test('config drift scenarios detect mismatches between config and overview defaults', () => {
  const overview = readText('tests/fixtures/consistency/config/overview.txt');
  const missingRowOverview = readText(
    'tests/fixtures/consistency/config/overview-missing-policy-row.txt',
  );
  const aligned = readJson(
    'tests/fixtures/consistency/config/aligned-config.json',
  );
  const drifted = readJson(
    'tests/fixtures/consistency/config/drifted-config.json',
  );

  assert.deepEqual(collectPolicyConfigDrift(aligned, overview), []);
  assert.deepEqual(collectPolicyConfigDrift(drifted, overview), [
    {
      path: 'commands.fix-validate',
      expected: 'npm run fix',
      actual: 'npm run fix && npm test',
    },
    {
      path: 'issueScope',
      expected: 'roadmap',
      actual: 'orphan-first',
    },
  ]);
  assert.deepEqual(collectPolicyConfigDrift(aligned, missingRowOverview), [
    {
      path: 'orphanFirstPolicy',
      expected: null,
      actual: null,
      reason: 'missing instruction row orphan-first-policy',
    },
  ]);
});

test('config drift resolves command rows that reference config keys', () => {
  const overviewRows = (fixValidate: string, prePushValidate: string) =>
    [
      '| **install-deps** | `node scripts/verify-install-deps.mjs` |',
      `| **fix-validate** | \`${fixValidate}\` |`,
      `| **pre-push-validate** | \`${prePushValidate}\` |`,
      '| **post-fix-validate** | `commands.post-fix-validate` |',
      '| **issue-scope** | `roadmap-first` |',
      '| **orphan-first-policy** | `none` |',
    ].join('\n');
  const config = {
    commands: {
      'install-deps': 'node scripts/verify-install-deps.mjs',
      'fix-validate': 'npx biome check --write',
      'pre-push-validate': 'pnpm test:scripts',
      'post-fix-validate': 'npx biome check',
    },
    issueScope: 'roadmap-first',
    orphanFirstPolicy: 'none',
  };
  const referenceOverview = overviewRows(
    'commands.fix-validate',
    'commands.pre-push-validate',
  );

  assert.deepEqual(collectPolicyConfigDrift(config, referenceOverview), []);

  const missingTarget = {
    ...config,
    commands: { ...config.commands, 'pre-push-validate': '' },
  };
  assert.deepEqual(collectPolicyConfigDrift(missingTarget, referenceOverview), [
    {
      path: 'commands.pre-push-validate',
      expected: 'commands.pre-push-validate',
      actual: '',
      reason: 'reference target commands.pre-push-validate is missing or empty',
    },
  ]);

  const selfReference = {
    ...config,
    commands: { ...config.commands, 'fix-validate': 'commands.fix-validate' },
  };
  assert.deepEqual(collectPolicyConfigDrift(selfReference, referenceOverview), [
    {
      path: 'commands.fix-validate',
      expected: 'commands.fix-validate',
      actual: 'commands.fix-validate',
      reason:
        'reference target commands.fix-validate refers to itself instead of holding a command',
    },
  ]);

  const crossReference = {
    ...config,
    commands: {
      ...config.commands,
      'fix-validate': 'commands.pre-push-validate',
    },
  };
  assert.deepEqual(
    collectPolicyConfigDrift(crossReference, referenceOverview),
    [
      {
        path: 'commands.fix-validate',
        expected: 'commands.fix-validate',
        actual: 'commands.pre-push-validate',
        reason:
          'reference target commands.fix-validate holds another reference (commands.pre-push-validate) instead of a command',
      },
    ],
  );

  const mixedOverview = overviewRows(
    'commands.fix-validate && npx cspell lint',
    'commands.pre-push-validate',
  );
  assert.deepEqual(collectPolicyConfigDrift(config, mixedOverview), [
    {
      path: 'commands.fix-validate',
      expected: 'commands.fix-validate && npx cspell lint',
      actual: 'npx biome check --write',
    },
  ]);
});

test('helper runtime inspection accepts absent and supported profiles, rejects unsupported values', () => {
  assert.deepEqual(inspectHelperRuntimeConfig({}), {
    status: 'absent',
  });
  assert.deepEqual(inspectHelperRuntimeConfig('invalid'), {
    status: 'invalid',
    reason: 'config must be a non-null object',
  });
  assert.deepEqual(inspectHelperRuntimeConfig([]), {
    status: 'invalid',
    reason: 'config must be a non-null object',
  });
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'instructions-only',
      },
    }),
    {
      status: 'ok',
      profile: 'instructions-only',
    },
  );
  for (const profile of [
    'package-manager',
    'vendored-node',
    'ephemeral-npx',
    'user-global',
  ]) {
    assert.deepEqual(
      inspectHelperRuntimeConfig({
        helperRuntime: {
          profile,
        },
      }),
      {
        status: 'ok',
        profile,
      },
    );
  }
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'bun',
      },
    }),
    {
      status: 'invalid',
      reason: 'unsupported helperRuntime.profile "bun"',
    },
  );
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'package-manager',
        manager: 'pnpm',
      },
    }),
    {
      status: 'invalid',
      reason: 'unsupported helperRuntime keys: manager',
    },
  );
});

test('helper runtime inspection accepts an optional launcher and returns it only when configured (idd-skill#3830)', () => {
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: { profile: 'ephemeral-npx', launcher: 'pnpm-dlx' },
    }),
    { status: 'ok', profile: 'ephemeral-npx', launcher: 'pnpm-dlx' },
  );
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://example.com/pinned-idd-skill.tgz',
        launcher: 'auto',
      },
    }),
    {
      status: 'ok',
      profile: 'ephemeral-npx',
      packageSpec: 'https://example.com/pinned-idd-skill.tgz',
      launcher: 'auto',
    },
  );
  // Absent launcher keeps the exact result shape: no launcher key at all.
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: { profile: 'instructions-only' },
    }),
    { status: 'ok', profile: 'instructions-only' },
  );
  for (const launcher of ['pnpm', 'npm', '', 42]) {
    assert.deepEqual(
      inspectHelperRuntimeConfig({
        helperRuntime: { profile: 'ephemeral-npx', launcher },
      }),
      {
        status: 'invalid',
        reason:
          'helperRuntime.launcher must be one of "auto", "npx", or "pnpm-dlx"',
      },
    );
  }
  // A bad launcher is rejected even alongside a valid packageSpec, and a
  // bad packageSpec is still rejected alongside a valid launcher.
  assert.equal(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://example.com/pinned-idd-skill.tgz',
        launcher: 'bogus',
      },
    }).status,
    'invalid',
  );
  assert.equal(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'has a space',
        launcher: 'npx',
      },
    }).status,
    'invalid',
  );
});

test('helper runtime inspection accepts an optional pinned packageSpec and rejects a malformed one (idd-skill#1731)', () => {
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'https://example.com/pinned-idd-skill.tgz',
      },
    }),
    {
      status: 'ok',
      profile: 'ephemeral-npx',
      packageSpec: 'https://example.com/pinned-idd-skill.tgz',
    },
  );
  // Absent packageSpec keeps the exact pre-#1731 result shape -- no
  // packageSpec key at all, not an empty string -- so every existing
  // profile-only assert.deepEqual case above is unaffected.
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'instructions-only',
      },
    }),
    {
      status: 'ok',
      profile: 'instructions-only',
    },
  );
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: '',
      },
    }),
    {
      status: 'invalid',
      reason:
        'helperRuntime.packageSpec must be a non-empty string using only shell-safe characters (letters, digits, and @:/_.+^#%-)',
    },
  );
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 'has a space',
      },
    }),
    {
      status: 'invalid',
      reason:
        'helperRuntime.packageSpec must be a non-empty string using only shell-safe characters (letters, digits, and @:/_.+^#%-)',
    },
  );
  assert.deepEqual(
    inspectHelperRuntimeConfig({
      helperRuntime: {
        profile: 'ephemeral-npx',
        packageSpec: 42,
      },
    }),
    {
      status: 'invalid',
      reason:
        'helperRuntime.packageSpec must be a non-empty string using only shell-safe characters (letters, digits, and @:/_.+^#%-)',
    },
  );
});

test('helper runtime inspection rejects a shell-metacharacter packageSpec and accepts realistic npm/github/URL specs (idd-skill#1803)', () => {
  // A whitespace-free but shell-unsafe spec must still be rejected -- a
  // bare "no whitespace" check would have let this through, but the value
  // is embedded raw/unquoted into copy-pasteable shell command text
  // (`npx --package <spec> ...`), so `;`, `&`, `|`, `$`, backticks,
  // quotes, and parens must all be rejected too.
  for (const maliciousSpec of [
    'pkg;touch /tmp/pwned',
    'pkg&&touch',
    'pkg|touch',
    'pkg`touch`',
    'pkg$(touch)',
    "pkg'touch'",
    'pkg"touch"',
    'pkg(touch)',
  ]) {
    assert.deepEqual(
      inspectHelperRuntimeConfig({
        helperRuntime: { profile: 'ephemeral-npx', packageSpec: maliciousSpec },
      }),
      {
        status: 'invalid',
        reason:
          'helperRuntime.packageSpec must be a non-empty string using only shell-safe characters (letters, digits, and @:/_.+^#%-)',
      },
      `expected ${JSON.stringify(maliciousSpec)} to be rejected`,
    );
  }

  // Realistic specs stay accepted: npm scoped package + version, npm
  // github-shorthand with a tag/ref, and an HTTPS tarball URL.
  for (const realisticSpec of [
    '@kurone-kito/idd-skill@1.2.3',
    'github:kurone-kito/idd-skill#v1.0.0',
    'https://codeload.github.com/kurone-kito/idd-skill/tar.gz/refs/heads/main',
  ]) {
    assert.deepEqual(
      inspectHelperRuntimeConfig({
        helperRuntime: { profile: 'ephemeral-npx', packageSpec: realisticSpec },
      }),
      { status: 'ok', profile: 'ephemeral-npx', packageSpec: realisticSpec },
      `expected ${JSON.stringify(realisticSpec)} to be accepted`,
    );
  }
});

test('policy normalization provides default-safe values and supports aliases', () => {
  assert.deepEqual(normalizePolicyConfig(null), {
    issueScope: 'roadmap-first',
    orchestrator: {
      maxWorkers: 2,
      hostLoadClearStreak: 3,
      hostLoadWaitCeiling: 'PT30M',
    },
    orphanFirstPolicy: 'none',
    skipIssueAuthorApprovalGate: false,
    dangerouslyAutoDecide: false,
    maintainerApprovalActorPolicy: 'owners-and-maintainers-only',
    stallRecovery: {
      quietWindow: 'PT30M',
    },
    claimTiming: {
      staleAge: 'PT24H',
    },
    forcedHandoff: {
      mode: 'disabled',
      authorityPolicy: 'owners-and-maintainers-only',
    },
    markerTrust: {
      allowCollaboratorMarkers: false,
    },
    advisoryWait: {
      convergenceScope: 'all-prs',
      requestCap: 30,
      pendingWindow: 'PT30M',
      settledWindow: 'PT10M',
      pollInterval: 'PT2M',
      capExhaustedRoute: 'phase-specific',
      exemptBotAuthoredPrs: false,
    },
    ciWait: {
      runningTimeout: 'PT30M',
      generationTimeout: 'PT10M',
      rerunPolicy: 'rerun-once',
    },
    ciGate: {
      externalChecks: {
        advisory: [],
        waivable: [],
      },
      externalCheckWaivers: {
        mode: 'disabled',
        authorityPolicy: 'owners-and-maintainers-only',
        maxValidity: 'PT24H',
      },
      trustEmptyProtectionReads: false,
      trustSourcePinnedRequiredChecks: false,
      allowNoRequiredChecksInGlobalOnly: false,
    },
    discover: {
      activeClaimPreScanBatchSize: 10,
      selectionDesync: 'off',
      legacyRoots: [],
      milestoneScope: '',
    },
    claim: {
      verifySettleDelay: 'PT5S',
    },
    critiqueLoop: {
      cPhaseLowSeveritySkipAfter: 2,
      e10NoProgressHoldAfter: 3,
      e10MaxPasses: 2,
      deferAfterRounds: 12,
      deferByUrgency: 'off',
      triageRecord: 'off',
      deferRelaxAtRounds: [],
      deferNeedsDecision: 'on',
      subagentWaitCeiling: 'PT20M',
    },
    reviewEscalation: {
      changesRequestedFirstEscalation: 'PT24H',
      changesRequestedSecondEscalation: 'PT48H',
    },
    approvalSignals: {
      readyLabelName: 'idd:ready',
      labelFreshnessMode: 'presence-only',
    },
    issueAuthoring: {
      maxClarificationRounds: 3,
      authoringLabelName: 'status:authoring',
      authoringStaleAge: 'PT4H',
      adversarialReview: {
        waitCeiling: 'PT20M',
      },
    },
    labels: {
      roadmapLabelName: 'roadmap',
      blockedByHumanLabelName: 'status:blocked-by-human',
      needsDecisionLabelName: 'status:needs-decision',
      authoringOnlyLabelName: 'status:authoring-only',
      untrustedLabelerLogins: [],
    },
    mergeGate: {
      soloCodeownerAdminFallback: 'auto-admin-retry',
    },
    providerOutage: {
      maxValidity: 'PT24H',
      maxParkedChanges: 10,
    },
    localValidationEvidence: {
      maxAge: 'PT4H',
    },
    providerHealth: {
      minCorroboratingPrs: 2,
      samplingWindow: 'PT24H',
    },
    githubApi: {
      telemetry: {
        enabled: false,
        maxRecords: 100,
        path: null,
      },
      readCache: {
        enabled: false,
        maxAge: 'PT5M',
        maxBytes: 104857600,
        retention: 'PT24H',
      },
      loadControl: {
        enabled: false,
        maxConcurrent: 1,
        maxWait: 'PT30S',
      },
    },
    localExec: {
      admission: {
        enabled: true,
        maxConcurrent: 1,
        maxWait: 'PT2H',
        backend: 'flock',
        pueueGroup: 'idd-validate',
      },
    },
  });

  const defaultPolicy = normalizePolicyConfig(null);
  for (const key of [
    'claimRevalidationGate',
    'untrustedMarkerAuthority',
    'forcedHandoffInitiator',
    'approvalNeededFallbackAutoClaim',
  ]) {
    assert.equal(
      Object.hasOwn(defaultPolicy, key),
      false,
      `${key} must stay non-configurable`,
    );
  }

  assert.deepEqual(
    normalizePolicyConfig({
      issueScope: 'orphan-first',
      orphanFirstPolicy: 'maintainer-approved',
      skipIssueAuthorApprovalGate: true,
      maintainerApprovalActorPolicy: 'all-write-permission-actors',
      stallRecovery: {
        quietWindow: 'PT45M',
      },
      claimTiming: {
        staleAge: 'PT18H',
      },
      forcedHandoffMode: 'human-gated',
      'forced-handoff-authority': 'all-write-permission-actors',
      markerTrustAllowCollaboratorMarkers: true,
      advisoryWait: {
        convergenceScope: 'all-prs',
        requestCap: 5,
        pendingWindow: 'PT40M',
        settledWindow: 'PT11M',
        pollInterval: 'PT3M',
        capExhaustedRoute: 'hold',
        exemptBotAuthoredPrs: true,
      },
      ciWait: {
        runningTimeout: 'PT35M',
        generationTimeout: 'PT15M',
        rerunPolicy: 'rerun-once',
      },
      ciGate: {
        externalChecks: {
          advisory: [{ selector: 'Copilot code review', matchMode: 'exact' }],
          waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob' }],
        },
        externalCheckWaivers: {
          mode: 'maintainer-authorized',
          authorityPolicy: 'all-write-permission-actors',
          maxValidity: 'PT12H',
        },
        trustEmptyProtectionReads: true,
        trustSourcePinnedRequiredChecks: true,
        allowNoRequiredChecksInGlobalOnly: false,
      },
      discover: {
        activeClaimPreScanBatchSize: 11,
        selectionDesync: 'session-offset',
        legacyRoots: [42, 7],
        milestoneScope: 'v0.8.0',
      },
      claim: {
        verifySettleDelay: 'PT7S',
      },
      critiqueLoop: {
        cPhaseLowSeveritySkipAfter: 4,
        e10NoProgressHoldAfter: 2,
        deferAfterRounds: 20,
        deferByUrgency: 'low-and-medium',
        deferRelaxAtRounds: [4, 7],
        deferNeedsDecision: 'off',
        subagentWaitCeiling: 'PT45M',
        telemetryHook: { command: 'notify-hook' },
      },
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT18H',
        changesRequestedSecondEscalation: 'PT36H',
      },
      approvalSignals: {
        readyLabelName: 'custom:ready',
        labelFreshnessMode: 'event-freshness',
      },
      issueAuthoring: {
        maxClarificationRounds: 4,
        authoringLabelName: 'status:drafting',
        authoringStaleAge: 'PT3H',
      },
      labels: {
        roadmapLabelName: 'epic',
        blockedByHumanLabelName: 'blocked:human',
        needsDecisionLabelName: 'needs:decision',
        untrustedLabelerLogins: ['triage-bot'],
      },
      mergeGate: {
        soloCodeownerAdminFallback: 'hold-and-report',
      },
    }),
    {
      issueScope: 'orphan-first',
      orchestrator: {
        maxWorkers: 2,
        hostLoadClearStreak: 3,
        hostLoadWaitCeiling: 'PT30M',
      },
      orphanFirstPolicy: 'maintainer-approved',
      skipIssueAuthorApprovalGate: true,
      dangerouslyAutoDecide: false,
      maintainerApprovalActorPolicy: 'all-write-permission-actors',
      stallRecovery: {
        quietWindow: 'PT45M',
      },
      claimTiming: {
        staleAge: 'PT18H',
      },
      forcedHandoff: {
        mode: 'human-gated',
        authorityPolicy: 'all-write-permission-actors',
      },
      markerTrust: {
        allowCollaboratorMarkers: true,
      },
      advisoryWait: {
        convergenceScope: 'all-prs',
        requestCap: 5,
        pendingWindow: 'PT40M',
        settledWindow: 'PT11M',
        pollInterval: 'PT3M',
        capExhaustedRoute: 'hold',
        exemptBotAuthoredPrs: true,
      },
      ciWait: {
        runningTimeout: 'PT35M',
        generationTimeout: 'PT15M',
        rerunPolicy: 'rerun-once',
      },
      ciGate: {
        externalChecks: {
          advisory: [{ selector: 'Copilot code review', matchMode: 'exact' }],
          waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob' }],
        },
        externalCheckWaivers: {
          mode: 'maintainer-authorized',
          authorityPolicy: 'all-write-permission-actors',
          maxValidity: 'PT12H',
        },
        trustEmptyProtectionReads: true,
        trustSourcePinnedRequiredChecks: true,
        allowNoRequiredChecksInGlobalOnly: false,
      },
      discover: {
        activeClaimPreScanBatchSize: 11,
        selectionDesync: 'session-offset',
        legacyRoots: [42, 7],
        milestoneScope: 'v0.8.0',
      },
      claim: {
        verifySettleDelay: 'PT7S',
      },
      // telemetryHook (#2678) is schema-only in this track and must not
      // leak into the normalized output -- see the input object above.
      critiqueLoop: {
        cPhaseLowSeveritySkipAfter: 4,
        e10NoProgressHoldAfter: 2,
        e10MaxPasses: 2,
        deferAfterRounds: 20,
        deferByUrgency: 'low-and-medium',
        triageRecord: 'off',
        deferRelaxAtRounds: [4, 7],
        deferNeedsDecision: 'off',
        subagentWaitCeiling: 'PT45M',
      },
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT18H',
        changesRequestedSecondEscalation: 'PT36H',
      },
      approvalSignals: {
        readyLabelName: 'custom:ready',
        labelFreshnessMode: 'event-freshness',
      },
      issueAuthoring: {
        maxClarificationRounds: 4,
        authoringLabelName: 'status:drafting',
        authoringStaleAge: 'PT3H',
        adversarialReview: {
          waitCeiling: 'PT20M',
        },
      },
      labels: {
        roadmapLabelName: 'epic',
        blockedByHumanLabelName: 'blocked:human',
        needsDecisionLabelName: 'needs:decision',
        authoringOnlyLabelName: 'status:authoring-only',
        untrustedLabelerLogins: ['triage-bot'],
      },
      mergeGate: {
        soloCodeownerAdminFallback: 'hold-and-report',
      },
      providerOutage: {
        maxValidity: 'PT24H',
        maxParkedChanges: 10,
      },
      localValidationEvidence: {
        maxAge: 'PT4H',
      },
      providerHealth: {
        minCorroboratingPrs: 2,
        samplingWindow: 'PT24H',
      },
      githubApi: {
        telemetry: {
          enabled: false,
          maxRecords: 100,
          path: null,
        },
        readCache: {
          enabled: false,
          maxAge: 'PT5M',
          maxBytes: 104857600,
          retention: 'PT24H',
        },
        loadControl: {
          enabled: false,
          maxConcurrent: 1,
          maxWait: 'PT30S',
        },
      },
      localExec: {
        admission: {
          enabled: true,
          maxConcurrent: 1,
          maxWait: 'PT2H',
          backend: 'flock',
          pueueGroup: 'idd-validate',
        },
      },
    },
  );

  assert.deepEqual(
    normalizePolicyConfig({
      forcedHandoff: {
        mode: 'human-gated',
        authorityPolicy: 'owners-and-maintainers-only',
      },
      'forced-handoff-authority': 'all-write-permission-actors',
    }).forcedHandoff,
    {
      mode: 'human-gated',
      authorityPolicy: 'owners-and-maintainers-only',
    },
  );

  assert.deepEqual(
    normalizePolicyConfig({
      forcedHandoff: {
        mode: 'human-gated-invalid',
        authorityPolicy: 'owners-and-maintainers-invalid',
      },
      forcedHandoffMode: 'human-gated',
      'forced-handoff-authority': 'all-write-permission-actors',
    }).forcedHandoff,
    {
      mode: 'human-gated',
      authorityPolicy: 'all-write-permission-actors',
    },
  );

  assert.deepEqual(
    normalizePolicyConfig({
      advisoryWait: {
        pendingWindow: 'PT60S',
        settledWindow: 'PT0M',
        pollInterval: 'PT90S',
        capExhaustedRoute: 'phase-default',
      },
    }).advisoryWait,
    {
      convergenceScope: 'all-prs',
      requestCap: 30,
      pendingWindow: 'PT30M',
      settledWindow: 'PT10M',
      pollInterval: 'PT2M',
      capExhaustedRoute: 'phase-specific',
      exemptBotAuthoredPrs: false,
    },
  );

  assert.deepEqual(
    normalizePolicyConfig({
      advisoryWait: {
        capExhaustedRoute: 'strict-hold',
      },
    }).advisoryWait.capExhaustedRoute,
    'hold',
  );

  assert.deepEqual(
    normalizePolicyConfig({
      ciGate: {
        externalChecks: {
          advisory: [{ selector: '', matchMode: 'regex' }],
        },
        externalCheckWaivers: {
          mode: 'always-on',
          authorityPolicy: 'owners-only',
          maxValidity: 'PT',
        },
      },
    }).ciGate,
    {
      externalChecks: {
        advisory: [],
        waivable: [],
      },
      externalCheckWaivers: {
        mode: 'disabled',
        authorityPolicy: 'owners-and-maintainers-only',
        maxValidity: 'PT24H',
      },
      trustEmptyProtectionReads: false,
      trustSourcePinnedRequiredChecks: false,
      allowNoRequiredChecksInGlobalOnly: false,
    },
  );

  assert.deepEqual(
    normalizePolicyConfig({
      ciGate: {
        externalChecks: {
          waivable: [
            { selector: 'CodeRabbit*', matchMode: 'glob', extra: true },
          ],
        },
      },
    }).ciGate.externalChecks,
    {
      advisory: [],
      waivable: [],
    },
  );

  // #1377: a non-boolean value fails closed to `false` (the safe default),
  // matching every other `=== true` boolean field in this normalizer.
  assert.equal(
    normalizePolicyConfig({
      ciGate: { trustEmptyProtectionReads: 'true' },
    }).ciGate.trustEmptyProtectionReads,
    false,
  );
  assert.equal(
    normalizePolicyConfig({
      ciGate: { trustEmptyProtectionReads: true },
    }).ciGate.trustEmptyProtectionReads,
    true,
  );

  // #1689: same fail-closed coercion contract as trustEmptyProtectionReads
  // above, for the sibling ciGate.trustSourcePinnedRequiredChecks opt-in.
  assert.equal(
    normalizePolicyConfig({
      ciGate: { trustSourcePinnedRequiredChecks: 'true' },
    }).ciGate.trustSourcePinnedRequiredChecks,
    false,
  );
  assert.equal(
    normalizePolicyConfig({
      ciGate: { trustSourcePinnedRequiredChecks: true },
    }).ciGate.trustSourcePinnedRequiredChecks,
    true,
  );

  // #4011: the global-only zero-required-check opt-in uses the same
  // fail-closed coercion: only a literal boolean `true` enables it.
  assert.equal(
    normalizePolicyConfig({
      ciGate: { allowNoRequiredChecksInGlobalOnly: 'true' },
    }).ciGate.allowNoRequiredChecksInGlobalOnly,
    false,
  );
  assert.equal(
    normalizePolicyConfig({
      ciGate: { allowNoRequiredChecksInGlobalOnly: true },
    }).ciGate.allowNoRequiredChecksInGlobalOnly,
    true,
  );
});

test('collaborator trust resolution honors aliases and env fallback', () => {
  assert.equal(resolveCollaboratorMarkerTrust({}, 'true'), true);
  assert.equal(
    resolveCollaboratorMarkerTrust(
      {
        markerTrustAllowCollaboratorMarkers: true,
      },
      '',
    ),
    true,
  );
  assert.equal(
    resolveCollaboratorMarkerTrust(
      {
        allowCollaboratorMarkers: false,
      },
      'true',
    ),
    false,
  );
  assert.equal(
    resolveCollaboratorMarkerTrust(
      {
        markerTrust: {
          allowCollaboratorMarkers: 'invalid',
        },
      },
      'true',
    ),
    true,
  );
});

function collectPlaceholderHits(url: URL): string[] {
  const root = fileURLToPath(url);
  const hits: string[] = [];

  walk(root, (fullPath) => {
    const placeholders = [
      ...new Set(findPlaceholders(readFileSync(fullPath, 'utf8'))),
    ];
    if (placeholders.length === 0) {
      return;
    }
    const relativePath = relative(root, fullPath).replaceAll('\\', '/');
    hits.push(`${relativePath}: ${placeholders.join(', ')}`);
  });

  return hits.sort();
}

function walk(directory: string, visit: (fullPath: string) => void): void {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, visit);
      continue;
    }
    visit(fullPath);
  }
}

test('collectDuplicateSyncPairTargets flags repeated targets and ignores unique ones', () => {
  assert.deepEqual(
    collectDuplicateSyncPairTargets([
      { id: 'a', target: 'x.md' },
      { id: 'b', target: 'y.md' },
    ]),
    [],
  );
  // Non-array / empty / missing / non-string targets are not violations:
  // invalid entries are ignored rather than coerced into a fake duplicate.
  assert.deepEqual(collectDuplicateSyncPairTargets(undefined), []);
  assert.deepEqual(collectDuplicateSyncPairTargets([{ id: 'a' }]), []);
  assert.deepEqual(
    collectDuplicateSyncPairTargets([
      { id: 'a', target: {} },
      { id: 'b', target: {} },
    ]),
    [],
  );

  const dupes = collectDuplicateSyncPairTargets([
    { id: 'first', target: 'shared.md' },
    { id: 'other', target: 'unique.md' },
    { id: 'second', target: 'shared.md' },
  ]);
  assert.equal(dupes.length, 1);
  assert.match(dupes[0], /duplicate target "shared\.md"/);
  assert.match(dupes[0], /pair "second"/);
});

test('audit/sync-manifest.json has no duplicate syncPairs targets', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../audit/sync-manifest.json', import.meta.url),
      'utf8',
    ),
  ) as { syncPairs?: { id?: string; target?: string }[] };
  assert.deepEqual(collectDuplicateSyncPairTargets(manifest.syncPairs), []);
});

test('audit/sync-manifest.json guards the .claude issue-authoring markdown mirror with a fileSet', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../audit/sync-manifest.json', import.meta.url),
      'utf8',
    ),
  ) as {
    fileSets?: {
      id?: string;
      sourceGlob?: string;
      targetGlob?: string;
      match?: string;
      requireSyncPairs?: boolean;
    }[];
  };
  const fileSet = manifest.fileSets?.find(
    (entry) => entry.id === 'claude-skills-issue-authoring-markdown-set',
  );
  assert.deepEqual(fileSet, {
    id: 'claude-skills-issue-authoring-markdown-set',
    sourceGlob: 'skills/issue-authoring/**/*.md',
    targetGlob: '.claude/skills/issue-authoring/**/*.md',
    match: 'basename',
    requireSyncPairs: true,
  });
});

// =============================================================================
// collectEnginesRangeMirrorViolations (#1706) -- the engines.node range
// mirror guard shared by audit-docs.mts's checkEnginesRangeMirrors.
// =============================================================================

const ENGINES_NODE = '^22.22.2 || >=24.2.0';

test('collectEnginesRangeMirrorViolations: passes when every mirror matches', () => {
  const files: Record<string, string> = {
    '.nvmrc': '22.22.2\n',
    'workflow.yml': `some yaml\n${ENGINES_NODE}\nmore yaml`,
    'prose.md':
      'Requires 22.22.2 or newer on the 22.x line, or 24.2.0 or newer',
  };
  const violations = collectEnginesRangeMirrorViolations(
    ENGINES_NODE,
    [
      { file: '.nvmrc', mode: 'low-bound-line' },
      { file: 'workflow.yml', mode: 'full-range' },
      { file: 'prose.md', mode: 'components' },
    ],
    (file) => files[file],
  );
  assert.deepEqual(violations, []);
});

test('collectEnginesRangeMirrorViolations: catches a stale low-bound pin', () => {
  const violations = collectEnginesRangeMirrorViolations(
    ENGINES_NODE,
    [{ file: '.nvmrc', mode: 'low-bound-line' }],
    () => '22.20.0\n',
  );
  assert.deepEqual(violations, [
    'engines-range-mirrors: .nvmrc pins "22.20.0", expected the engines.node low bound "22.22.2"',
  ]);
});

test('collectEnginesRangeMirrorViolations: catches a stale full-range mention', () => {
  const violations = collectEnginesRangeMirrorViolations(
    ENGINES_NODE,
    [{ file: 'workflow.yml', mode: 'full-range' }],
    () => 'const ok = ... ^22.22.1 || >=24.2.0 ...',
  );
  assert.deepEqual(violations, [
    `engines-range-mirrors: workflow.yml does not contain the current engines.node range "${ENGINES_NODE}"`,
  ]);
});

test('collectEnginesRangeMirrorViolations: components mode requires every clause, naming only what is missing', () => {
  const violations = collectEnginesRangeMirrorViolations(
    ENGINES_NODE,
    [{ file: 'prose.md', mode: 'components' }],
    // Only mentions the low bound, not the high one.
    () => 'Node.js 22.22.2 or newer',
  );
  assert.deepEqual(violations, [
    `engines-range-mirrors: prose.md does not mention all engines.node clause versions "24.2.0"`,
  ]);
});

test('collectEnginesRangeMirrorViolations: fails closed on a missing or non-string engines.node', () => {
  assert.deepEqual(
    collectEnginesRangeMirrorViolations(undefined, [], () => ''),
    [
      'engines-range-mirrors: package.json engines.node is missing or not a string',
    ],
  );
  assert.deepEqual(
    collectEnginesRangeMirrorViolations(42, [], () => ''),
    [
      'engines-range-mirrors: package.json engines.node is missing or not a string',
    ],
  );
});

test('collectEnginesRangeMirrorViolations: fails closed on an unrecognized range shape', () => {
  const violations = collectEnginesRangeMirrorViolations('>=18', [], () => '');
  assert.deepEqual(violations, [
    'engines-range-mirrors: engines.node ">=18" does not match the expected "^<v1> (|| ^<vN>)* || >=<high>" shape; cannot verify mirrors',
  ]);
});

test('collectEnginesRangeMirrorViolations: parses a three-clause range and requires all three components', () => {
  const threeClause = '^22.23.2 || ^24.2.0 || >=26.0.0';
  const passing = collectEnginesRangeMirrorViolations(
    threeClause,
    [{ file: 'prose.md', mode: 'components' }],
    () => 'Requires 22.23.2, 24.2.0, or 26.0.0 or newer',
  );
  assert.deepEqual(passing, []);

  const missingMiddle = collectEnginesRangeMirrorViolations(
    threeClause,
    [{ file: 'prose.md', mode: 'components' }],
    () => 'Requires 22.23.2 or 26.0.0 or newer',
  );
  assert.deepEqual(missingMiddle, [
    'engines-range-mirrors: prose.md does not mention all engines.node clause versions "24.2.0"',
  ]);

  // low-bound modes still resolve to the first (leftmost) clause with more
  // than two clauses present.
  const lowBoundViolations = collectEnginesRangeMirrorViolations(
    threeClause,
    [{ file: '.nvmrc', mode: 'low-bound-line' }],
    () => '22.20.0\n',
  );
  assert.deepEqual(lowBoundViolations, [
    'engines-range-mirrors: .nvmrc pins "22.20.0", expected the engines.node low bound "22.23.2"',
  ]);
});

test('collectEnginesRangeMirrorViolations: fails closed when a >= clause is not last', () => {
  const violations = collectEnginesRangeMirrorViolations(
    '^22.23.2 || >=24.2.0 || ^26.0.0',
    [],
    () => '',
  );
  assert.deepEqual(violations, [
    'engines-range-mirrors: engines.node "^22.23.2 || >=24.2.0 || ^26.0.0" does not match the expected "^<v1> (|| ^<vN>)* || >=<high>" shape; cannot verify mirrors',
  ]);
});

test('collectEnginesRangeMirrorViolations: fails closed on content after the trailing >= clause', () => {
  const violations = collectEnginesRangeMirrorViolations(
    '^22.23.2 || >=24.2.0 || extra',
    [],
    () => '',
  );
  assert.deepEqual(violations, [
    'engines-range-mirrors: engines.node "^22.23.2 || >=24.2.0 || extra" does not match the expected "^<v1> (|| ^<vN>)* || >=<high>" shape; cannot verify mirrors',
  ]);
});

test('collectEnginesRangeMirrorViolations: fails closed on a bare ^ clause with no trailing >= clause', () => {
  const violations = collectEnginesRangeMirrorViolations(
    '^22.22.2',
    [],
    () => '',
  );
  assert.deepEqual(violations, [
    'engines-range-mirrors: engines.node "^22.22.2" does not match the expected "^<v1> (|| ^<vN>)* || >=<high>" shape; cannot verify mirrors',
  ]);
});

test('collectEnginesRangeMirrorViolations: reports an unreadable mirror file instead of throwing', () => {
  const violations = collectEnginesRangeMirrorViolations(
    ENGINES_NODE,
    [{ file: 'missing.yml', mode: 'full-range' }],
    () => {
      throw new Error('ENOENT');
    },
  );
  assert.deepEqual(violations, [
    'engines-range-mirrors: missing.yml: could not be read',
  ]);
});

// =============================================================================
// collectBinExecutableModeViolations (#1971) -- the bin/*.mjs shebang vs.
// tracked-executable-mode guard shared by audit-docs.mts's
// checkBinExecutableMode.
// =============================================================================

test('collectBinExecutableModeViolations: passes when every shebanged file is tracked executable', () => {
  const files: Record<string, string> = {
    'bin/idd-example.mjs': '#!/usr/bin/env node\nconsole.log("hi");\n',
    'bin/idd-helper.mjs': 'export const x = 1;\n', // no shebang, out of scope
  };
  const modes: Record<string, string> = {
    'bin/idd-example.mjs': '100755',
    'bin/idd-helper.mjs': '100644',
  };
  const violations = collectBinExecutableModeViolations(
    Object.keys(files),
    (file) => files[file],
    (file) => modes[file] ?? null,
  );
  assert.deepEqual(violations, []);
});

test('collectBinExecutableModeViolations: reports a shebanged file tracked non-executable', () => {
  const files: Record<string, string> = {
    'bin/idd-broken.mjs': '#!/usr/bin/env node\nconsole.log("hi");\n',
  };
  const violations = collectBinExecutableModeViolations(
    Object.keys(files),
    (file) => files[file],
    () => '100644',
  );
  assert.deepEqual(violations, [
    "bin-executable-mode: bin/idd-broken.mjs has a #! shebang but is tracked 100644 in git; run `git update-index --chmod=+x -- 'bin/idd-broken.mjs'` and commit",
  ]);
});

test('collectBinExecutableModeViolations: reports an untracked shebanged file', () => {
  const violations = collectBinExecutableModeViolations(
    ['bin/idd-new.mjs'],
    () => '#!/usr/bin/env node\n',
    () => null,
  );
  assert.deepEqual(violations, [
    "bin-executable-mode: bin/idd-new.mjs has a #! shebang but is not tracked by git; run `chmod +x -- 'bin/idd-new.mjs' && git add -- 'bin/idd-new.mjs'` and commit",
  ]);
});

test('collectBinExecutableModeViolations: shell-quotes a path containing shell-special characters', () => {
  // A path with a single quote and a command substitution must stay one
  // literal argument in the copy-pasteable remediation command instead
  // of letting a shell interpret it (CodeRabbit finding on PR #1972).
  const dollarPath = 'bin/idd-$(rm -rf ~).mjs';
  const quotePath = "bin/idd-it's-weird.mjs";
  const violations = collectBinExecutableModeViolations(
    [dollarPath, quotePath],
    () => '#!/usr/bin/env node\n',
    () => '100644',
  );
  assert.deepEqual(violations, [
    `bin-executable-mode: ${dollarPath} has a #! shebang but is tracked 100644 in git; run \`git update-index --chmod=+x -- '${dollarPath}'\` and commit`,
    `bin-executable-mode: ${quotePath} has a #! shebang but is tracked 100644 in git; run \`git update-index --chmod=+x -- 'bin/idd-it'"'"'s-weird.mjs'\` and commit`,
  ]);
});

test('collectBinExecutableModeViolations: ignores a non-shebang file even when tracked non-executable', () => {
  const violations = collectBinExecutableModeViolations(
    ['bin/idd-data.mjs'],
    () => 'export const data = {};\n',
    () => '100644',
  );
  assert.deepEqual(violations, []);
});

test('collectBinExecutableModeViolations: reports an unreadable file instead of throwing', () => {
  const violations = collectBinExecutableModeViolations(
    ['bin/idd-missing.mjs'],
    () => {
      throw new Error('ENOENT');
    },
    () => '100755',
  );
  assert.deepEqual(violations, [
    'bin-executable-mode: bin/idd-missing.mjs: could not be read',
  ]);
});

// =============================================================================
// resolveGeneratedBlockFiles (#1703) -- the shared paths-first,
// sourceGlobs-fallback resolution rule for a generatedBlocks manifest
// entry, previously duplicated (and drifted) between sync-docs.mts and
// audit-docs.mts.
// =============================================================================

// =============================================================================
// OKF index table renderer (#1683)
// =============================================================================

test('extractOkfIndexFields reads type/title/description from OKF frontmatter', () => {
  const fields = extractOkfIndexFields(
    '---\ntype: guide\ntitle: Hello\ndescription: One sentence.\n---\n\n# Hello\n',
  );
  assert.deepEqual(fields, {
    type: 'guide',
    title: 'Hello',
    description: 'One sentence.',
  });
  assert.equal(extractOkfIndexFields('# no frontmatter\n'), null);
});

test('buildOkfIndexRows groups by typeOrder then path and excludes reserved paths', () => {
  const files: Record<string, string> = {
    'docs/b.md':
      '---\ntype: guide\ntitle: B\ndescription: B page.\n---\n\n# B\n',
    'docs/a.md':
      '---\ntype: guide\ntitle: A\ndescription: A page.\n---\n\n# A\n',
    'docs/z.md':
      '---\ntype: concept\ntitle: Z\ndescription: Z page.\n---\n\n# Z\n',
    'docs/index.md':
      '---\ntype: index\ntitle: Index\ndescription: Index page.\n---\n\n# Index\n',
  };
  const rows = buildOkfIndexRows(Object.keys(files), (p) => files[p] ?? '', {
    typeOrder: ['guide', 'concept'],
    excludePaths: ['docs/index.md'],
  });
  assert.deepEqual(
    rows.map((r) => r.path),
    ['docs/a.md', 'docs/b.md', 'docs/z.md'],
  );
  assert.equal(rows[0]?.type, 'guide');
  assert.equal(rows[2]?.type, 'concept');
});

test('renderOkfIndexMarkdownTable links relative to linkBase', () => {
  const table = renderOkfIndexMarkdownTable(
    [
      {
        path: 'docs/foo.md',
        type: 'guide',
        title: 'Foo',
        description: 'Foo page.',
      },
    ],
    'docs',
  );
  assert.match(table, /dprint-ignore-start/);
  assert.match(table, /\| Type \| Page \| Description \|/);
  assert.match(table, /\| guide \| \[Foo\]\(foo\.md\) \| Foo page\. \|/);
  assert.match(table, /dprint-ignore-end/);
});

test('escapeMarkdownTableCell escapes backslashes before pipes', () => {
  assert.equal(escapeMarkdownTableCell('a|b'), 'a\\|b');
  assert.equal(escapeMarkdownTableCell('a\\b'), 'a\\\\b');
  assert.equal(escapeMarkdownTableCell('a\\|b'), 'a\\\\\\|b');
});

test('resolveGeneratedBlockFiles: paths present takes precedence, globFilesFn is never called', () => {
  const files = resolveGeneratedBlockFiles(
    { paths: ['b.md', 'a.md'], sourceGlobs: ['ignored/**'] },
    () => {
      throw new Error('globFilesFn must not be invoked when paths is set');
    },
  );
  // paths is returned verbatim (not sorted) -- only the sourceGlobs
  // fallback dedupes/sorts.
  assert.deepEqual(files, ['b.md', 'a.md']);
});

test('resolveGeneratedBlockFiles: falls back to sourceGlobs when paths is absent, deduped and sorted', () => {
  const seenPatterns: string[] = [];
  const files = resolveGeneratedBlockFiles(
    { sourceGlobs: ['src/*.mts', 'lib/*.mts'] },
    (pattern) => {
      seenPatterns.push(pattern);
      if (pattern === 'src/*.mts') {
        return ['src/b.mts', 'src/a.mts', 'src/a.mts'];
      }
      return ['lib/z.mts'];
    },
  );
  assert.deepEqual(seenPatterns, ['src/*.mts', 'lib/*.mts']);
  assert.deepEqual(files, ['lib/z.mts', 'src/a.mts', 'src/b.mts']);
});

test('resolveGeneratedBlockFiles: neither paths nor sourceGlobs resolves to an empty list', () => {
  assert.deepEqual(
    resolveGeneratedBlockFiles({}, () => []),
    [],
  );
});

// =============================================================================
// collectOkfFrontmatterViolations (#1680) -- fail-closed OKF v0.1 frontmatter
// conformance checker for `okfBundles[]` manifest entries. Every case here
// uses synthetic in-memory fixtures, never the live docs/** corpus: this
// track intentionally backfills no page (see docs/okf-frontmatter.md).
// =============================================================================

const OKF_TEST_TYPES = ['guide', 'reference', 'concept'];

/**
 * Builds `listFiles`/`readFile` callbacks over an in-memory
 * `{ path: content }` map, mirroring how the audit pipeline binds
 * `globFiles`/`readText` to `repoFiles` -- without touching the real
 * filesystem or the live docs corpus.
 */
function okfFixture(files: Record<string, string>) {
  const listFiles = (pattern: string) => {
    const prefix = pattern.replace(/\/\*\*\/\*\.md$/, '/');
    return Object.keys(files)
      .filter((path) => path.startsWith(prefix))
      .sort();
  };
  const readFile = (path: string) => {
    if (!Object.hasOwn(files, path)) {
      throw new Error(`unexpected read in OKF fixture: ${path}`);
    }
    return files[path];
  };
  return { listFiles, readFile };
}

test('collectOkfFrontmatterViolations: a conforming page passes', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\ntags: [a, b]\n---\n\n# Foo\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        reservedFilenames: ['index.md'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: a plain YAML comment inside frontmatter is not misread as the H1', () => {
  // A `# `-prefixed line inside the frontmatter block is a YAML comment,
  // not a Markdown heading -- the H1 scan must only run on the
  // post-frontmatter body, or this would produce a false "title does not
  // match" failure even though the body's own `# Foo` heading agrees with
  // `title`.
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\n# a plain YAML comment, not a heading\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: a reserved filename is skipped entirely', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/index.md': '# Index\n\nNo frontmatter here, and that is fine.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        reservedFilenames: ['index.md', 'log.md'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: a file with no frontmatter block fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md': '# Foo\n\nBody with no leading frontmatter at all.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /docs\/foo\.md has no parseable YAML frontmatter block/,
  );
});

test('collectOkfFrontmatterViolations: an empty type fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: ""\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing a non-empty "type" field/);
});

test('collectOkfFrontmatterViolations: a missing description fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md': '---\ntype: guide\ntitle: Foo\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing a non-empty "description" field/);
});

test('collectOkfFrontmatterViolations: a type outside the closed set fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: essay\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"type: essay" is not in the configured types list/);
});

test('collectOkfFrontmatterViolations: a title disagreeing with the H1 fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Wrong Title\ndescription: A short sentence.\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /"title: Wrong Title" does not match the page's "# Foo" heading/,
  );
});

test('collectOkfFrontmatterViolations: a non-list tags fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\ntags: not-a-list\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"tags" must be a YAML list of non-empty strings/);
});

test('collectOkfFrontmatterViolations: a non-conforming page listed in exemptPaths is silently skipped', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md': '# Foo\n\nNo frontmatter, but grandfathered in.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: ['docs/foo.md'],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: an exemptPaths entry naming a nonexistent file fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: ['docs/missing.md'],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /exemptPaths names docs\/missing\.md, which does not exist under a configured root/,
  );
});

test('collectOkfFrontmatterViolations: an exemptPaths entry naming a now-conforming file fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: ['docs/foo.md'],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /exemptPaths names docs\/foo\.md, which now conforms to the OKF profile/,
  );
});

test('collectOkfFrontmatterViolations: an H1 legitimately ending in "#" is not stripped', () => {
  // CommonMark's ATX closing sequence requires a preceding space; a title
  // like "Guide to C#" must keep its trailing "#" rather than have it
  // misread as a closing sequence and stripped down to "Guide to C".
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Guide to C#\ndescription: A short sentence.\n---\n\n# Guide to C#\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: a legitimate closing sequence is still stripped', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\n---\n\n# Foo #\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: a zero-indent YAML block sequence for tags parses correctly', () => {
  // YAML permits a block sequence at the same indentation as its mapping
  // key; the parser must not silently drop these items into an empty
  // scalar and then fail the "tags must be a list" check on valid YAML.
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\ntags:\n- okf\n- frontmatter\n---\n\n# Foo\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: an indented block sequence for tags still parses correctly', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/foo.md':
      '---\ntype: guide\ntitle: Foo\ndescription: A short sentence.\ntags:\n  - okf\n  - frontmatter\n---\n\n# Foo\n\nBody.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        types: OKF_TEST_TYPES,
        exemptPaths: [],
      },
    ],
    listFiles,
    readFile,
  );
  assert.deepEqual(errors, []);
});

test('collectOkfFrontmatterViolations: an exemptPaths entry naming a reserved filename fails', () => {
  const { listFiles, readFile } = okfFixture({
    'docs/index.md': '# Index\n\nNo frontmatter here, and that is fine.\n',
  });
  const errors = collectOkfFrontmatterViolations(
    [
      {
        id: 'docs-okf',
        roots: ['docs'],
        reservedFilenames: ['index.md', 'log.md'],
        types: OKF_TEST_TYPES,
        exemptPaths: ['docs/index.md'],
      },
    ],
    listFiles,
    readFile,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /exemptPaths names docs\/index\.md, which is a reserved filename and is never checked/,
  );
});

test('collectOkfFrontmatterViolations: misconfigured roots/types fail closed, non-array bundles are a no-op', () => {
  assert.deepEqual(
    collectOkfFrontmatterViolations(
      null,
      () => [],
      () => '',
    ),
    [],
  );
  assert.deepEqual(
    collectOkfFrontmatterViolations(
      undefined,
      () => [],
      () => '',
    ),
    [],
  );

  const noRoots = collectOkfFrontmatterViolations(
    [{ id: 'x', roots: [], types: OKF_TEST_TYPES }],
    () => {
      throw new Error('listFiles must not be called without roots');
    },
    () => '',
  );
  assert.equal(noRoots.length, 1);
  assert.match(
    noRoots[0],
    /roots must be a non-empty array of directory strings/,
  );

  const noTypes = collectOkfFrontmatterViolations(
    [{ id: 'x', roots: ['docs'], types: [] }],
    () => [],
    () => '',
  );
  assert.equal(noTypes.length, 1);
  assert.match(noTypes[0], /types must be a non-empty array of type strings/);
});

test('idd-merge.instructions.md F4 verifies the PR digest before the issue digest and claim release (#3739)', () => {
  const text = readText(
    'idd-template/.github/instructions/idd-merge.instructions.md',
  );
  const f4Start = text.indexOf('## F4 — Cleanup');
  const f4End = text.indexOf('\n## F5', f4Start);
  const earlyDigestCheck = text.indexOf(
    '2. Re-validate claim; confirm the PR digest',
    f4Start,
  );
  const prDigestCheck = text.indexOf('7. After steps 4–6', f4Start);
  const issueDigest = text.indexOf('Phase: F4 complete', prDigestCheck);
  const claimRelease = text.indexOf(
    'Finally, while the claim still matches',
    issueDigest,
  );
  assert.ok(
    f4Start >= 0 &&
      f4End > f4Start &&
      earlyDigestCheck > f4Start &&
      earlyDigestCheck < prDigestCheck &&
      prDigestCheck > f4Start &&
      issueDigest > prDigestCheck &&
      claimRelease > issueDigest &&
      claimRelease < f4End,
    'F4 must verify the PR digest before the issue digest and claim release',
  );
  const closeStepStart = text.indexOf(
    '1. **Non-default development branch**',
    f4Start,
  );
  const closeStepEnd = text.indexOf('\n2. Re-validate claim', closeStepStart);
  assert.ok(
    closeStepStart >= 0 && closeStepEnd > closeStepStart,
    'F4 step 1 boundaries not found',
  );
  const closeStep = text.slice(closeStepStart, closeStepEnd);
  assert.match(
    closeStep,
    /Revalidate the active claim immediately before each\s+`gh issue close`[\s\S]*if it no longer matches this session, stop before\s+that close and every later F4 mutation/,
  );
  const resumeText = readText(
    'idd-template/.github/instructions/idd-resume.instructions.md',
  );
  assert.match(
    resumeText,
    /\| PR merged; claim = this session's verified `\{claim-id\}`\s+\| Run F4 steps 2-7 \(guarded\);/,
  );
  const resumeDetail = readText('idd-template/docs/idd-resume-detail.md');
  assert.match(
    resumeDetail,
    /runs the full `idd-merge\.instructions\.md` F4\s+contract \(steps 2-7,[\s\S]*includes step 3's merged-PR comment cleanup/,
  );
  assert.match(
    resumeDetail,
    /When this\s+route includes step 1, revalidate immediately before each closing-set\s+`gh issue close` as well \(PR `#3741` review comment `#4174332509`\)/,
  );
  const headProofStart = resumeDetail.indexOf('## F4 Head Proof');
  const headProofEnd = resumeDetail.indexOf('\n## ', headProofStart + 1);
  const headProof = resumeDetail.slice(headProofStart, headProofEnd);
  assert.ok(headProofStart >= 0 && headProofEnd > headProofStart);
  assert.match(
    headProof,
    /idd-f4-head-proof: v2 pr=\{pr-number\} claim=\{claim-id\} branch=\{branch-name\} f2=\{f2-head-SHA\} branch-tip=\{branch-tip-SHA\} merge=\{merge-commit-SHA\} head=\{pr-head-SHA\}/,
  );
  assert.match(
    headProof,
    /gh api --paginate[\s\S]*issues\/\{issue-number\}\/comments/,
  );
  assert.match(
    headProof,
    /gh api "repos\/\{owner\}\/\{repo\}\/pulls\/\$PR_NUMBER"[\s\S]*\.merge_commit_sha \| test\([\s\S]*\.head\.sha \| test\(/,
  );
  assert.match(
    headProof,
    /\.state == "closed" and \.merged == true[\s\S]*merge_commit_sha[\s\S]*git\/commits\/\$MERGE_COMMIT_SHA[\s\S]*commit object's `\.sha` to equal `merge_commit_sha`/,
  );
  assert.ok(
    headProof.indexOf('.merge_commit_sha | test') <
      headProof.indexOf('MERGE_COMMIT_DATA=$(gh api'),
    'F4 must validate the merge SHA before using it in the commit endpoint',
  );
  assert.match(
    headProof,
    /\.state == "closed" and \.merged == true[\s\S]*require exactly\s+one or two parent objects with full 40-hex SHAs/,
  );
  assert.match(headProof, /GitHub's pull request REST API/);
  assert.doesNotMatch(headProof, /mergeCommit\.oid|headRefOid/);
  assert.match(headProof, /Ignore comments from untrusted authors/);
  assert.match(headProof, /shared \[trusted marker actor policy\]/);
  assert.match(
    headProof,
    /live Write\/Maintain\/Admin collaborator permission when\s+`markerTrust\.allowCollaboratorMarkers` is enabled/,
  );
  assert.match(headProof, /not a later heartbeat of the same claim/);
  assert.match(headProof, /`updated_at` must equal\s+`created_at`/);
  assert.match(
    headProof,
    /First look\s+for a reusable, valid proof[\s\S]*without requiring the branch ref\s+to exist/,
  );
  const issueCommentRead = headProof.indexOf("claimed issue's comments");
  const reusableProof = headProof.indexOf('for a reusable, valid proof');
  const freshCapture = headProof.indexOf('If no reusable proof exists');
  const branchLookup = headProof.indexOf(
    '`git rev-parse --verify "refs/heads/$BRANCH_NAME"`',
  );
  assert.ok(
    issueCommentRead >= 0 &&
      reusableProof > issueCommentRead &&
      freshCapture > reusableProof &&
      branchLookup > freshCapture,
    'F4 must read and reuse a valid proof before requiring the branch ref',
  );
  assert.match(
    headProof,
    /If the ref exists,\s+require its tip to equal the stored branch tip; if absent, continue only\s+through the resume-safe cleanup guards below/,
  );
  assert.match(
    headProof,
    /take `\{f2-head-SHA\}` from the E1 `review-watermark` that F2 validated[\s\S]*latest valid same-claim `review-watermark`[\s\S]*not a separate\s+F2 watermark format[\s\S]*`git rev-parse --verify "refs\/heads\/\$BRANCH_NAME"`/,
  );
  assert.match(
    headProof,
    /keep the values separate[\s\S]*Do not require either to equal the merged PR\s+head[\s\S]*Derive\s+the merged PR head independently[\s\S]*including the verified merge commit and resulting\s+`PR_HEAD_SHA_F3`/,
  );
  const liveHeadPreflight = headProof.indexOf(
    'First run the REST and commit-object validation below',
  );
  const proofPost = headProof.indexOf('F4_MARKER_BODY=$(');
  const proofVerified = headProof.indexOf('Fetch the comments again');
  const preCleanupCheck = headProof.indexOf(
    'Immediately before step 3, revalidate the claim',
  );
  assert.ok(
    liveHeadPreflight >= 0 &&
      liveHeadPreflight < proofPost &&
      proofPost < proofVerified &&
      proofVerified < preCleanupCheck,
    'F4 must verify the merged head before posting proof and recheck before cleanup',
  );
  assert.match(
    headProof,
    /Immediately before step 3, revalidate the claim and repeat the live\s+merged-PR check from step 7[\s\S]*Step\s+7 repeats the validation after cleanup/,
  );
  assert.match(
    headProof,
    /With a newly posted proof, require the same\s+merge commit and PR head observed before posting[\s\S]*with a reused proof,\s+require both values to match the marker's `merge` and `head` fields/,
  );
  assert.match(
    headProof,
    /F4_MARKER_BODY=\$\(printf[\s\S]*jq -n --arg body "\$F4_MARKER_BODY" '\{body: \$body\}'[\s\S]*gh api --method POST[\s\S]*--input -/,
  );
  assert.match(headProof, /visible note after it/);
  assert.doesNotMatch(headProof, /gh issue comment \{issue-number\} --body/);
  assert.match(
    headProof,
    /If the write response\s+is ambiguous, reconcile by reading comments; never post another marker\s+blindly/,
  );
  assert.match(
    headProof,
    /For a two-parent merge, set `PR_HEAD_SHA_F3` to parent 2 and require it\s+to equal `PR_HEAD_SHA_LIVE`/,
  );
  assert.match(
    headProof,
    /For a one-parent merge \(squash or rebase\),\s+set `PR_HEAD_SHA_F3` to `PR_HEAD_SHA_LIVE`[\s\S]*Neither path requires the\s+merged head to equal the F2 watermark or local branch tip/,
  );
  assert.match(
    headProof,
    /Before worktree removal, revalidate the claim and compare the path with\s+`git worktree list --porcelain`/,
  );
  assert.match(
    headProof,
    /If both are absent, skip\s+inspection\/removal; the local branch may also be absent, and if it still\s+exists its tip must equal `\{branch-tip-SHA\}`/,
  );
  assert.match(
    headProof,
    /If both are present, require\s+the local branch to exist and its tip to equal `\{branch-tip-SHA\}`, then\s+run the normal safety inspection/,
  );
  assert.match(
    headProof,
    /owns local-branch\s+deletion: it runs\s+`git branch -d -- "\$BRANCH_NAME"` only when the branch exists,\s+and absence\s+is already complete/,
  );
  assert.match(
    headProof,
    /For step 6, use the profile-selected `delete-remote-branch` helper[\s\S]*default dry-run[\s\S]*`--apply`[\s\S]*argument-vector[\s\S]*`--force-with-lease`[\s\S]*confirms absence/,
  );
  assert.match(
    headProof,
    /node scripts\/delete-remote-branch\.mjs[\s\S]*--branch "\$BRANCH_NAME" --expected-sha "\$PR_HEAD_SHA_F3"[\s\S]*--apply/,
  );
  assert.doesNotMatch(
    headProof,
    /git push/,
    'F4 must route the protected remote deletion through the helper',
  );
  assert.match(
    headProof,
    /local branch ref is checked against `branch-tip-SHA`/,
  );
  assert.match(headProof, /CodeRabbit\s+review comment `#4174140998`/);
  assert.match(
    headProof,
    /git check-ref-format "refs\/heads\/\$BRANCH_NAME"[\s\S]*Never paste a recovered branch name into shell source/,
  );
  assert.match(
    headProof,
    /F4_MARKER_TOKEN=\$\(printf[\s\S]*branch=%s[\s\S]*"\$BRANCH_NAME"/,
  );
  assert.match(
    headProof,
    /F4_MARKER_TOKEN=\$\(printf[\s\S]*merge=%s head=%s[\s\S]*"\$BRANCH_TIP_SHA" "\$MERGE_COMMIT_SHA" "\$PR_HEAD_SHA_F3"/,
  );
  assert.match(headProof, /CodeRabbit review\s+comment\s+`#4174140996`/);
  const finalCheck = text.slice(prDigestCheck, issueDigest);
  const earlyCheck = text.slice(earlyDigestCheck, prDigestCheck);
  assert.match(
    earlyCheck,
    /If `human_merge` left\s+none, retain the claim; step 7 repairs it after cleanup/,
  );
  assert.match(
    earlyCheck,
    /Before step\s+3, follow the \[F4 Head Proof\][\s\S]*reuse its trusted marker before reading a branch ref/,
  );
  assert.match(earlyCheck, /idd-resume-detail\.md#f4-head-proof/);
  assert.match(finalCheck, /After steps 4–6/);
  assert.match(
    finalCheck,
    /follow the\s+\[F4 Head Proof\][\s\S]*Hold on failed\s+or ambiguous evidence/,
  );
  assert.match(finalCheck, /`F3 merged` `Authoritative by`/);
  assert.match(finalCheck, /Use its proof-bound `PR_HEAD_SHA_F3`/);
  assert.match(finalCheck, /never\s+use digest\s+head\s+as proof/);
  assert.match(
    finalCheck,
    /Upsert `F3 merged` `Authoritative by` with both proven,\s+distinct full SHAs/,
  );
  assert.match(
    finalCheck,
    /even if\s+`human_merge` skipped F3 or the digest is\s+missing\/stale/,
  );
  assert.match(finalCheck, /Hold on\s+duplicate, invalid, or incomplete proof/);
  const step5Start = text.indexOf(
    '\n5. Run from the **primary worktree**',
    f4Start,
  );
  const step6Start = text.indexOf(
    '\n6. If GitHub auto-delete is disabled',
    step5Start,
  );
  const step5 = text.slice(step5Start, step6Start);
  assert.match(step5, /Resume-safe absence checks/);
  const step6 = text.slice(step6Start, prDigestCheck);
  assert.match(step6, /delete the remote branch per/);
  assert.ok(
    step5.indexOf('Resume-safe absence checks') <
      step5.indexOf('git worktree remove <path>'),
  );
  assert.match(finalCheck, /Phase: F3 merged/);
  assert.match(finalCheck, /Claim: \{agent-id\} \/ \{claim-id\}/);
  assert.match(finalCheck, /Branch: \{branch-name\}/);
  assert.match(finalCheck, /Open blockers: none/);
  assert.match(finalCheck, /Next action: F4 cleanup then F5 discover/);
  assert.match(finalCheck, /`Authoritative by` both SHAs/);
  assert.match(finalCheck, /Use one `--last-checked` throughout/);
  assert.match(finalCheck, /create`\/`update/);
  assert.match(
    finalCheck,
    /Apply `create`\/`update` with\s+`--claim-issue \{issue-number\} --claim-id \{claim-id\} --agent-id \{agent-id\}`/,
  );
  assert.match(finalCheck, /re-validate before\/after/);
  assert.match(
    finalCheck,
    /Lost ownership stops confirmation\s+and later\s+F4 mutations/,
  );
  assert.match(finalCheck, /identical fields\/timestamp/);
  assert.match(finalCheck, /Confirm `noop` with identical fields/);
  assert.match(
    finalCheck,
    /On\s+duplicate, invalid, or inconclusive results, keep claim, re-validate\s+before hold/,
  );
  assert.match(finalCheck, /stop before issue digest or unclaim/);
  assert.match(finalCheck, /if\s+lost, post no hold/);
});

// #4377: the fan-out variant's "Delegation brief template" assembles the brief
// elements that four places state separately. Each row names an element, the
// file that supplies its single-line anchor, the anchor, and the template label
// (a bold run-in head) that must carry the element in both docs copies.
const BRIEF_TEMPLATE_HEADING = '#### Delegation brief template';
const BRIEF_TEMPLATE_NEXT_HEADING = '### Orchestrator run report';
const BRIEF_TEMPLATE_DOC_COPIES = [
  'docs/idd-workflow.md',
  'idd-template/docs/idd-workflow.md',
];
// Each placeholder must appear in the part that uses it, not only in the
// definitions list at the top of the section.
const BRIEF_TEMPLATE_PLACEHOLDER_OWNERS: Readonly<Record<string, string>> = {
  '{issue-number}': '**Role.**',
  '{agent-id}': '**Claim token.**',
  '{claim-id}': '**Claim token.**',
  '{nonce}': '**Claim token.**',
  '{branch-name}': '**Branch and worktree.**',
  '{worktree-path}': '**Branch and worktree.**',
  '{scratchpad-dir}': '**Scratchpad.**',
  '{report-path}': '**Worker report.**',
  '{terminal-phase}': '**Terminal phase.**',
};
// The observed-incident wording the issue requires for each cited failure.
const BRIEF_INCIDENT_WORDING = ['no issue records', '2026-10-14 to 2026-10-15'];
const BRIEF_ELEMENT_ROWS: readonly {
  element: string;
  source: string;
  anchor: string;
  label: string;
}[] = [
  {
    element: 'topology-safety condition',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '- **A delegation brief that restates the background-wait topology',
    label: '**Wake-up discipline.**',
  },
  {
    element: 'exit boundary and scope stop',
    source: 'idd-template/docs/idd-workflow.md',
    anchor:
      'carries `scope-stopped` and not `held`. A gate or unmet condition that',
    label: '**Terminal phase.**',
  },
  {
    element: 'scratchpad rules',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '- **A delegation brief that requires issue-number-namespaced',
    label: '**Scratchpad.**',
  },
  {
    element: 'claim token and activation nonce',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '- **The delegation brief carries the claim token verbatim, nonce',
    label: '**Claim token.**',
  },
  {
    element: 'cold-start rule for the review phases',
    source: 'idd-template/docs/idd-workflow.md',
    anchor:
      '- **A delegation brief resuming mid-review at E4 or E9 must run the',
    label: '**Review cold start.**',
  },
  {
    element: 'hold-marker rule',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '- **Hold marker.**',
    label: '**Hold marker.**',
  },
  {
    element: 'sole-worker role statement',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor:
      '**State the worker role explicitly when the delegate inherits full',
    label: '**Role.**',
  },
  {
    element: 'branch rules',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor: '**Cite the branch rules, do not restate them.**',
    label: '**Branch and worktree.**',
  },
  {
    element: 'execution-timeout override carried by the brief',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor:
      'and the execution-timeout override for a heavy or long-running local',
    label: '**Execution timeout.**',
  },
  {
    element: 'execution-timeout override text',
    source: 'idd-template/.github/instructions/idd-ci.instructions.md',
    anchor: '## Wake-up discipline',
    label: '**Execution timeout.**',
  },
  {
    element: 'hold-marker requirement for the brief',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor: '**Restate the hold-marker requirement.**',
    label: '**Hold marker.**',
  },
  {
    element: 'worker report request',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: 'Fill the worker-supplied fields of',
    label: '**Worker report.**',
  },
  {
    element: 'critique allowance: harness limits',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '## Worker delegation',
    label: '**Critique allowance.**',
  },
  {
    element: 'critique allowance: invocation',
    source: 'idd-template/docs/idd-workflow.md',
    anchor: '## Critique pass invocation',
    label: '**Critique allowance.**',
  },
  {
    element: 'critique allowance: context-inheriting residual risk',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor: '**Known limitation.**',
    label: '**Critique allowance.**',
  },
  {
    element: 'terminal phase: F4 head proof before step 3',
    source: 'idd-template/.github/instructions/idd-merge.instructions.md',
    anchor: '2. Re-validate claim; confirm the PR digest',
    label: '**Terminal phase.**',
  },
  {
    element: 'terminal phase: step 7 digest and unclaimed-by',
    source: 'idd-template/.github/instructions/idd-merge.instructions.md',
    anchor: '7. After steps 4–6',
    label: '**Terminal phase.**',
  },
  {
    element: 'lock sentence of F4 step 4',
    source: 'idd-template/.github/instructions/idd-merge.instructions.md',
    anchor: '4. Concurrent workers sharing one clone: serialize this fetch and',
    label: '**Terminal phase.**',
  },
  {
    element: 'primary-worktree exemption: F4 step 5 runs from the primary',
    source: 'idd-template/.github/instructions/idd-merge.instructions.md',
    anchor: '5. Run from the **primary worktree**, not one being removed.',
    label: '**Terminal phase.**',
  },
  {
    element: 'primary-worktree exemption: F4 step 4 runs from the primary',
    source: 'idd-template/.github/instructions/idd-merge.instructions.md',
    anchor: 'From the **primary worktree** (elsewhere would fast-forward the',
    label: '**Terminal phase.**',
  },
  {
    element: 'primary-worktree exemption: harness reclaim skip',
    source: 'idd-template/.github/instructions/idd-work.instructions.md',
    anchor:
      'remove` steps; let the harness reclaim it and finish the rest (issue',
    label: '**Terminal phase.**',
  },
  {
    element: 'branch rules: D1 of the PR submit phase',
    source: 'idd-template/.github/instructions/idd-pr-submit.instructions.md',
    anchor: '## D1 — Sync {development-branch} before first push',
    label: '**Branch and worktree.**',
  },
  {
    element: 'branch rules: E-phase branch-sync check',
    source:
      'idd-template/.github/instructions/idd-review-triage.instructions.md',
    anchor: '## E-phase branch-sync check',
    label: '**Branch and worktree.**',
  },
  {
    element: 'primary-worktree exemption: host-isolated worktree skips',
    source: 'idd-template/.github/instructions/idd-work.instructions.md',
    anchor: '### Already inside a host-isolated worktree',
    label: '**Terminal phase.**',
  },
  {
    element: 'scratchpad part',
    source:
      'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    anchor: '**Restate the scratchpad file-naming requirement.**',
    label: '**Scratchpad.**',
  },
];
// Strings that must sit inside one labeled part, so a part with the right label
// and the wrong content fails. Checked on whitespace-collapsed part text.
const BRIEF_PART_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  '**Terminal phase.**': [
    ...BRIEF_INCIDENT_WORDING,
    '{terminal-phase}',
    'unclaimed-by',
    'scope-stopped',
    'idd-merge.instructions.md#f4--cleanup',
    'host-isolated',
    'F4 steps 4 to 6',
  ],
  '**Scratchpad.**': [
    ...BRIEF_INCIDENT_WORDING,
    'issue-numbered',
    'parent path',
    'held',
    'never `mkdir -p`',
  ],
  '**Execution timeout.**': [
    'execution-timeout',
    'idd-ci.instructions.md#wake-up-discipline',
  ],
  '**Critique allowance.**': [
    ...BRIEF_INCIDENT_WORDING,
    '](#critique-pass-invocation)',
    '](#worker-delegation)',
    'Limits',
    'depth 2',
    'context-inheriting fork',
  ],
};

// Strings that must sit in the worker-facing text of a part, before its Fill
// note, so that a string kept only in a note (which is not copied into a brief)
// does not satisfy the check.
const BRIEF_PART_BODY_REQUIREMENTS: Readonly<
  Record<string, readonly string[]>
> = {
  '**Terminal phase.**': [
    '{terminal-phase}',
    'unclaimed-by',
    'host-isolated',
    'idd-merge.instructions.md#f4--cleanup',
    'idd-resume-detail.md#f4-head-proof',
    'idd-helper-scripts.md#clone-scoped-lock',
    'first entry of `git worktree list`',
  ],
  '**Scratchpad.**': [
    'issue-numbered',
    'parent path',
    'held',
    'never `mkdir -p`',
    '(#orchestrator-fan-out-variant)',
  ],
  '**Critique allowance.**': [
    '](#critique-pass-invocation)',
    'non-context-inheriting',
  ],
  '**Execution timeout.**': [
    'execution-timeout',
    'idd-ci.instructions.md#wake-up-discipline',
  ],
  '**Role.**': [
    'sole worker',
    're-delegate',
    'idd-claim.instructions.md#orchestrator-delegation',
  ],
  '**Claim token.**': [
    'recompute the nonce winner',
    'idd-claim.instructions.md#orchestrator-delegation',
  ],
  '**Branch and worktree.**': [
    'idd-pr-submit.instructions.md#d1--sync-development-branch-before-first-push',
    'idd-review-triage.instructions.md#e-phase-branch-sync-check',
    'do not paraphrase',
    'git rev-parse --abbrev-ref HEAD',
  ],
  '**Wake-up discipline.**': [
    'Never end your turn',
    'idd-ci.instructions.md#wake-up-discipline',
  ],
  '**Hold marker.**': ['idd-hold', 'after your last `claimed-by`', 'held'],
  '**Review cold start.**': [
    'idd-review-snapshot.instructions.md#cold-start-reviewitems_snapshot-reconstruction',
    '(#reviewitems_snapshot-lifecycle)',
  ],
  '**Worker report.**': [
    'schemas/worker-report.schema.json',
    'any non-empty value',
    'Leave `verifiedAt`, `recordedAt`, and `reviewRounds` out',
    'the orchestrator sets `verifiedAt` to that check',
    'sets `recordedAt` immediately before append',
    'derives `reviewRounds` from the complete review list',
    'The orchestrator validates the completed record against the schema after filling the required fields and before appending it',
    '(#worker-report-outcomes)',
  ],
};

function sliceBriefTemplate(path: string, text: string) {
  const variantStart = text.indexOf('### Orchestrator fan-out variant\n');
  const start = text.indexOf(`\n${BRIEF_TEMPLATE_HEADING}\n`, variantStart) + 1;
  assert.ok(
    variantStart >= 0 && start > variantStart,
    `${path}: the template heading must sit inside the fan-out variant`,
  );
  assert.equal(
    text.indexOf(`\n${BRIEF_TEMPLATE_HEADING}\n`, start),
    -1,
    `${path}: the template heading must occur once`,
  );
  const bodyStart = start + BRIEF_TEMPLATE_HEADING.length;
  const nextHeading = text.slice(bodyStart).search(/\n#{1,6} /u);
  assert.ok(nextHeading > 0, `${path}: no heading follows the template`);
  const end = bodyStart + nextHeading + 1;
  assert.ok(
    text.slice(end).startsWith(`${BRIEF_TEMPLATE_NEXT_HEADING}\n`),
    `${path}: the template must sit directly before ${BRIEF_TEMPLATE_NEXT_HEADING}`,
  );
  return { variantStart, start, section: text.slice(start, end) };
}

test('pre-B1 parent continuation keeps same-claim safety and truthful reports (#4714)', () => {
  const workflowCopies = [
    'idd-template/docs/idd-workflow.md',
    'docs/idd-workflow.md',
  ];
  const continuationRequirements = [
    'original parent is still in the same uninterrupted session',
    'A runtime result must be final, not interim',
    'complete worker/launch history and live process evidence',
    'no child process or other writer remains',
    'original claim and winning nonce, branch, exact worktree, lock, and generated tokens',
    'a clean `git status` alone is not proof',
    'incomplete listing, unknown launch, mismatch, unreadable worktree',
    'implementation change/commit, existing PR, or unresolved report artifact',
    'Reuse a valid existing session record and its exact canonical root read-only',
    'complete process, session, and artifact evidence proves no earlier root',
    'unknown allocation or report history is a hold',
    'A pre-B1 stop by itself does not qualify',
    'An active child hold requires a trusted, unedited `idd-hold` marker',
    'GraphQL `lastEditedAt` must be explicitly `null`',
    'only a complete trusted history read can prove that none exists',
    'A missing, edited, untrusted, or unreadable marker is not proof of absence',
    'persist a `pending` continuation recovery record as `issue-<n>-pre-b1-continuation.json` under the verified session scratchpad root',
    'Create it exclusively; never overwrite or follow a pre-existing or symlinked file at that path',
    'Later state changes replace only this record, using the atomic write and read-back step',
    'transition stage, intended parent role, intended final roster pair',
    'Write the record atomically and read it back',
    'A restarted parent treats a pending record as recovery/hold',
    'and permits only the verified transition steps below; it blocks all other',
    'first record the per-issue role change to `parent-continuation` in the pending recovery record',
    'posts an ordinary `claimed-by` heartbeat as the continuation worker',
    'the heartbeat ends the hold only when the claim parser recognizes it as a valid worker heartbeat newer than the trusted marker',
    'An orchestrator renewal does not end the hold',
    'A complete read proving the heartbeat absent follows the existing bounded retry',
    'If the complete history proves no active hold, no hold-ending heartbeat is needed',
    'replace the roster atomically in one update',
    'Do not dispose the child and add the parent entry as separate roster writes',
    'If the atomic update or its read-back is incomplete or uncertain',
    'atomically mark the recovery record `reconciled` and read it back',
    'preserve claim, worktree, and storage',
    'make no further mutation, budget/overlap call, refill, or implementation change',
    'add one separate `parent-continuation` entry for the same issue, claim, and branch as `running`',
    'it has no worker handle or report path',
    'Count the continuation entry once in `--running`',
    'pass its issue exactly once as `--in-flight`',
    'never count the disposed child',
    'then mark it `disposed`',
    'Record both entries and the role transition in the run report',
    'Pause new refills/claims while the parent implements',
    'a hold on another issue is local, not global exhaustion',
    'Resume ordinary discovery/refill after the parent reaches terminal',
    'Never restart the ended child or mint a claim, nonce, or forced handoff',
    'Do not delete a branch/worktree, take over a lock automatically, or reset lost work',
    'Do not append a terminal worker report or F4 result for the pre-B1 child',
    'do not change the worker-report schema',
  ];

  for (const path of workflowCopies) {
    const text = normalizeWhitespace(readText(path));
    assert.ok(
      text.includes(
        'Use the verified pre-B1 parent-continuation route below; otherwise use existing recovery/hold',
      ),
      `${path}: the live capability table must route only to the narrow continuation proof`,
    );
    const start = text.indexOf('##### Verified pre-B1 parent continuation');
    const end = text.indexOf('#### Session scratchpad lifecycle', start);
    assert.ok(
      start >= 0 && end > start,
      `${path}: continuation section missing`,
    );
    const route = text.slice(start, end);
    for (const requirement of continuationRequirements) {
      assert.ok(
        route.includes(requirement),
        `${path}: continuation proof must include "${requirement}"`,
      );
    }
    const noEarlyB1 = route.indexOf('but does not enter B1 Step 3 yet');
    const holdProof = route.indexOf(
      'An active child hold requires a trusted, unedited `idd-hold` marker',
    );
    const pendingRecord = route.indexOf(
      'persist a `pending` continuation recovery record',
    );
    const roleChange = route.indexOf(
      'first record the per-issue role change to `parent-continuation`',
    );
    const heartbeat = route.indexOf(
      'posts an ordinary `claimed-by` heartbeat as the continuation worker',
    );
    const atomicRoster = route.indexOf(
      'replace the roster atomically in one update',
    );
    const reconciledRecord = route.indexOf(
      'atomically mark the recovery record `reconciled` and read it back',
    );
    const budgetCount = route.indexOf(
      'Count the continuation entry once in `--running`',
    );
    const overlapCount = route.indexOf(
      'pass its issue exactly once as `--in-flight`',
    );
    const parentRole = route.indexOf(
      'Record both entries and the role transition',
    );
    const b1Gate = route.indexOf(
      'Do not enter B1 Step 3 or start implementation until',
    );
    const b1Continuation = route.indexOf(
      'Only then continue in the same worktree with the original claim and nonce.',
    );
    assert.ok(
      holdProof >= 0 &&
        noEarlyB1 > holdProof &&
        pendingRecord > noEarlyB1 &&
        roleChange > pendingRecord &&
        heartbeat > roleChange &&
        atomicRoster > heartbeat &&
        reconciledRecord > atomicRoster &&
        budgetCount > reconciledRecord &&
        overlapCount > budgetCount &&
        parentRole > overlapCount &&
        b1Gate > parentRole &&
        b1Continuation > b1Gate,
      `${path}: B1 must follow hold proof, pending record, verified transition, and atomic roster reconciliation`,
    );
    const b1GateText = route.slice(b1Gate, b1Continuation);
    for (const requirement of [
      'until the hold-ending heartbeat is verified or complete trusted history proves no active hold',
      'the recovery record is `reconciled`',
      'A `disposed` child entry alone does not prove that the hold ended',
      'current ownership, storage/record state, both roster entries, and parent role are reconciled',
    ]) {
      assert.ok(
        b1GateText.includes(requirement),
        `${path}: B1 gate must require "${requirement}" before continuation`,
      );
    }

    const reportStart = text.indexOf('### Orchestrator run report');
    const reportEnd = text.indexOf('### Worker report outcomes', reportStart);
    assert.ok(
      reportStart >= 0 && reportEnd > reportStart,
      `${path}: run report missing`,
    );
    const report = text.slice(reportStart, reportEnd);
    for (const required of [
      '**Pre-B1 parent continuation.**',
      'historical handle',
      'separate active `parent-continuation` entry',
      'final state',
      'no terminal worker report or F4 result',
    ]) {
      assert.ok(
        report.includes(required),
        `${path}: run report must include "${required}"`,
      );
    }
  }

  for (const path of [
    'idd-template/.github/instructions/idd-orchestrator.instructions.md',
    '.github/instructions/idd-orchestrator.instructions.md',
  ]) {
    const text = normalizeWhitespace(readText(path));
    for (const required of [
      'A pre-B1 stop may use the [parent-continuation route]',
      'only after its complete proof passes; otherwise use existing recovery/hold',
      '[restart scan](../../docs/idd-helper-scripts.md#orchestrator-restart-scan)',
    ]) {
      assert.ok(text.includes(required), `${path}: missing "${required}"`);
    }
  }

  for (const path of [
    'idd-template/.github/instructions/claim-orchestrator.instructions.md',
    '.github/instructions/claim-orchestrator.instructions.md',
  ]) {
    const text = normalizeWhitespace(readText(path));
    for (const required of [
      'Continuation after a confirmed pre-B1 stop is not a new activation',
      '[canonical parent-continuation proof]',
      'keep the same claim and nonce',
    ]) {
      assert.ok(text.includes(required), `${path}: missing "${required}"`);
    }
  }
});

test('orchestrator restart scans continuation records before roster rebuild and refill (#4714)', () => {
  for (const path of [
    'idd-template/docs/idd-workflow.md',
    'docs/idd-workflow.md',
  ]) {
    const text = normalizeWhitespace(readText(path));
    const restartStart = text.indexOf(
      'This subsection covers an orchestrating session that restarts',
    );
    const scanStart = text.indexOf(
      'Before roster reconstruction or any Discover/refill step, follow the [orchestrator restart scan]',
      restartStart,
    );
    const findClaims = text.indexOf('1. **Find own claims.**', restartStart);
    const reattachWorkers = text.indexOf(
      '3. **Re-attach workers.**',
      restartStart,
    );
    assert.ok(
      restartStart >= 0 &&
        scanStart > restartStart &&
        findClaims > scanStart &&
        reattachWorkers > scanStart,
      `${path}: continuation-record validation must precede restart roster reconstruction`,
    );
  }

  for (const path of [
    'idd-template/docs/idd-helper-scripts.md',
    'docs/idd-helper-scripts.md',
  ]) {
    const text = normalizeWhitespace(readText(path));
    const scanStart = text.indexOf('### Orchestrator restart scan');
    assert.ok(scanStart >= 0, `${path}: restart scan contract missing`);
    const nextHeading = text.indexOf('\n### ', scanStart + 1);
    const scan = text.slice(
      scanStart,
      nextHeading < 0 ? undefined : nextHeading,
    );
    for (const required of [
      '`issue-<n>-pre-b1-continuation.json` records',
      'without following symlinks',
      'A `pending` record requires existing recovery or a hold',
      'A `reconciled` record does not authorize the uninterrupted-session shortcut after restart',
      'never as worker report drafts or report-store entries',
      'no record requires recovery',
    ]) {
      assert.ok(scan.includes(required), `${path}: missing "${required}"`);
    }
  }
});

test('pre-B1 continuation ownership matrix requires verified hold completion (#4714)', () => {
  for (const path of [
    'idd-template/docs/idd-concept-ownership.md',
    'docs/idd-concept-ownership.md',
  ]) {
    const matrix = normalizeWhitespace(readText(path));
    assert.ok(
      matrix.includes(
        'under the ordinary fan-out lifecycle, ended by a later valid `claimed-by`',
      ),
      `${path}: the ownership matrix must preserve ordinary fan-out disposal as a hold-ending cause`,
    );
    assert.ok(
      matrix.includes(
        'For the verified pre-B1 continuation route only, dispose the child after complete trusted history proves no active hold or a valid hold-ending heartbeat is verified; disposal alone proves neither',
      ),
      `${path}: the ownership matrix must scope the stricter disposal proof to pre-B1 continuation`,
    );
    assert.ok(
      matrix.includes(
        'the uninterrupted owning parent creates a pending continuation record and adds a `parent-continuation` entry only under the [verified pre-B1 route]',
      ),
      `${path}: the ownership matrix must limit parent continuation to its verified route`,
    );
    assert.ok(
      matrix.includes(
        'when a hold is active, a verified hold-ending heartbeat before roster disposal',
      ),
      `${path}: the ownership matrix must gate disposal on verified hold completion`,
    );
  }

  for (const path of [
    'idd-template/docs/idd-workflow.md',
    'docs/idd-workflow.md',
  ]) {
    const workflow = normalizeWhitespace(readText(path));
    assert.ok(
      workflow.includes('`disposed` under the ordinary fan-out lifecycle'),
      `${path}: ordinary fan-out disposal must remain a hold-ending cause`,
    );
    assert.ok(
      workflow.includes(
        'The verified pre-B1 parent-continuation route is stricter: it disposes the child only after a hold-ending heartbeat is verified or complete trusted history proves that no hold is active.',
      ),
      `${path}: the pre-B1 route must verify the hold end before disposal`,
    );
    assert.ok(
      workflow.includes(
        'report an active hold as ended only after its hold-ending heartbeat is verified. When complete trusted history proves no hold is active, report that no active hold exists; do not attribute that state to disposal',
      ),
      `${path}: run reports must preserve the verified pre-B1 disposal condition`,
    );
  }
});

test('docs idd-workflow fan-out variant carries a delegation brief template for every brief element (#4377)', () => {
  const sourceTexts = new Map<string, string>();
  for (const row of BRIEF_ELEMENT_ROWS) {
    assert.ok(
      !row.anchor.includes('\n'),
      `${row.element}: the anchor must be a single line`,
    );
    if (!sourceTexts.has(row.source)) {
      sourceTexts.set(row.source, readText(row.source));
    }
    assert.ok(
      sourceTexts.get(row.source)?.includes(row.anchor),
      `${row.element}: anchor not found in ${row.source}: ${row.anchor}`,
    );
  }
  const labels = [...new Set(BRIEF_ELEMENT_ROWS.map((row) => row.label))];

  for (const path of BRIEF_TEMPLATE_DOC_COPIES) {
    const text = readText(path);
    const { variantStart, start, section } = sliceBriefTemplate(path, text);

    // The pointer sits in the topology and exit-boundary brief bullet, and
    // the template follows the variant's last bullet.
    const bulletStart = text.indexOf(
      '- **A delegation brief that restates the background-wait topology',
      variantStart,
    );
    const bulletEnd = text.indexOf('\n- **', bulletStart + 1);
    assert.ok(
      bulletStart > variantStart &&
        bulletEnd > bulletStart &&
        bulletEnd < start,
      `${path}: topology and exit-boundary bullet not found`,
    );
    assert.ok(
      text
        .slice(bulletStart, bulletEnd)
        .includes('](#delegation-brief-template)'),
      `${path}: the variant's brief bullets must point at the template`,
    );
    const renewal = text.indexOf('- **Held-worker renewal.**', variantStart);
    assert.ok(
      renewal > variantStart && renewal < start,
      `${path}: the template must follow the Held-worker renewal bullet`,
    );

    assert.ok(!section.includes('{{'), `${path}: the template has no {{ token`);
    const tokens = new Set(section.match(/\{[^}\s]*\}/gu) ?? []);
    assert.deepEqual(
      [...tokens].sort(),
      Object.keys(BRIEF_TEMPLATE_PLACEHOLDER_OWNERS).sort(),
      `${path}: the placeholders used must be exactly the defined ones`,
    );
    const definitions = section.slice(0, section.indexOf('\n**Role.** '));
    assert.ok(
      normalizeWhitespace(definitions).includes(
        'whose name starts with the issue number',
      ),
      `${path}: {report-path} must be defined as an issue-number prefix`,
    );
    for (const placeholder of tokens) {
      assert.ok(
        definitions.includes(`\`${placeholder}\``),
        `${path}: no definition for ${placeholder}`,
      );
    }
    const flat = normalizeWhitespace(section);
    for (const wording of BRIEF_INCIDENT_WORDING) {
      assert.ok(flat.includes(wording), `${path}: missing "${wording}"`);
    }

    // Split the parts at the exact label literals, never at any bold text.
    const positions = new Map<string, number>();
    for (const label of labels) {
      const position = section.indexOf(`\n${label} `);
      assert.ok(position >= 0, `${path}: missing template label ${label}`);
      assert.equal(
        section.indexOf(`\n${label} `, position + 1),
        -1,
        `${path}: duplicate template label ${label}`,
      );
      positions.set(label, position);
    }
    const partText = (label: string): string => {
      const position = positions.get(label) ?? -1;
      const following = [...positions.values()]
        .filter((other) => other > position)
        .sort((a, b) => a - b);
      return normalizeWhitespace(
        section.slice(position, following[0] ?? section.length),
      );
    };
    for (const [placeholder, label] of Object.entries(
      BRIEF_TEMPLATE_PLACEHOLDER_OWNERS,
    )) {
      assert.ok(
        partText(label).split(' Fill note: ')[0].includes(placeholder),
        `${path}: the worker-facing ${label} text must use ${placeholder}`,
      );
    }
    // A Fill note is its own paragraph, and the orchestrator-only incident
    // wording stays out of the worker-facing text that is copied.
    for (const match of section.matchAll(/Fill note:/gu)) {
      assert.equal(
        section.slice(match.index - 2, match.index),
        '\n\n',
        `${path}: a Fill note must start its own paragraph`,
      );
    }
    for (const [label, required] of Object.entries(
      BRIEF_PART_BODY_REQUIREMENTS,
    )) {
      const body = partText(label).split(' Fill note: ')[0];
      for (const wording of BRIEF_INCIDENT_WORDING) {
        assert.ok(
          !body.includes(wording),
          `${path}: the worker-facing ${label} text must not hold "${wording}"`,
        );
      }
      for (const needle of required) {
        assert.ok(
          body.includes(needle),
          `${path}: the worker-facing ${label} text must hold ${needle}`,
        );
      }
    }
    for (const [label, required] of Object.entries(BRIEF_PART_REQUIREMENTS)) {
      const part = partText(label);
      for (const needle of required) {
        assert.ok(
          part.includes(needle),
          `${path}: the ${label} part must hold ${needle}`,
        );
      }
    }
  }
});

test('fan-out scratchpad preflight provisions and recovers one session root (#4685)', () => {
  const workflowCopies = [
    'idd-template/docs/idd-workflow.md',
    'docs/idd-workflow.md',
  ];
  const orchestratorCopies = [
    'idd-template/.github/instructions/idd-orchestrator.instructions.md',
    '.github/instructions/idd-orchestrator.instructions.md',
  ];
  const routingCases = [
    {
      evidence:
        'harness supplies an existing valid root with no prior record or reservation on first entry before claims or dispatch; a complete worker listing and artifact evidence show no prior start, and all session records show no canonical root collision',
      action:
        'Verify the root, reserve it, create and verify the record exclusively, then reuse it',
    },
    {
      evidence:
        'There is no supplied root, record, reservation, or fallback directory, and harness context identifies a first entry before claims or dispatch; the complete live worker listing and session artifacts show no prior start, and all session records show no canonical root collision',
      action: 'Allocate the private fallback root and record before Discover',
    },
    {
      evidence: 'live worker listing is unavailable or incomplete',
      action:
        'Treat prior-worker state as uncertain and hold for reconciliation before reuse, allocation, or dispatch',
    },
    {
      evidence:
        'root reservation exists without an exact valid record for this session, does not match that record, or cannot be read or verified',
      action: 'Hold and preserve it; do not accept or allocate the root',
    },
    {
      evidence:
        'A session record is unreadable or invalid, or another session records the canonical candidate root',
      action: 'do not accept or allocate a colliding root',
    },
    {
      evidence:
        'exact record matches this session, repository, and canonical root; the same uninterrupted allocator carries its invocation-local owner token from successful exclusive reservation acquisition; the full collision scan is clear; root and worker, artifact, and report evidence are valid and settled',
      action:
        'Continue this invocation on the recorded root; leave any reservation untouched and recover report locations before refill',
    },
    {
      evidence:
        'exact prior record is valid; the token is absent because this is a restarted or unknown invocation; a trusted maintainer confirms no live same-session orchestrator and grants this resumer sole control in the current operator-run LWR step 2 interaction; all collision and settled-evidence checks pass',
      action:
        'During recovery preflight, reuse the recorded root read-only and leave its reservation untouched; after sole control, use the normal brief/report path',
    },
    {
      evidence:
        'exact record is valid in a restarted or unknown invocation, but the trusted maintainer has not confirmed no live same-session orchestrator and sole-resumer control in the current recovery',
      action:
        'Hold and preserve the record and any reservation until that operator confirmation',
    },
    {
      evidence:
        'Claims already exist, but live evidence establishes that no worker was dispatched',
      action: 'resume those claims without minting a claim or nonce',
    },
    {
      evidence:
        'A worker dispatch is proven, but no safe root or matching session record can be recovered',
      action:
        'do not allocate or redispatch until ownership and report locations are reconciled',
    },
    {
      evidence: 'fallback directory already exists without a valid record',
      action: 'Hold and preserve it; do not reuse or overwrite it',
    },
    {
      evidence:
        'record is unreadable, invalid, linked unsafely, for another session or repository',
      action: 'Hold and preserve all evidence; do not allocate a replacement',
    },
    {
      evidence: 'Worker launch or prior-worker state is uncertain',
      action: 'hold while any dispatch or ownership remains unresolved',
    },
    {
      evidence:
        'Allocation succeeded but the durable record cannot be verified',
      action:
        'Keep the directory and known path, start no worker, and hold for reconciliation',
    },
    {
      evidence:
        'Stable session identity or a verified writable root cannot be resolved',
      action:
        'Hold with the missing prerequisite; do not guess a harness capability',
    },
    {
      evidence: 'A worker receives a missing parent path',
      action: 'Hold in the worker, create nothing, and never use `mkdir -p`',
    },
  ];

  for (const path of workflowCopies) {
    const text = readText(path);
    const start = text.indexOf('#### Session scratchpad lifecycle\n');
    const end = text.indexOf('\nRunning this variant safely requires:', start);
    assert.ok(
      start >= 0 && end > start,
      `${path}: lifecycle section not found`,
    );
    const lifecycleText = text.slice(start, end);
    const lifecycle = normalizeWhitespace(lifecycleText);
    for (const required of [
      'stable session identifier supplied by the current harness context',
      'path-safe single component',
      'name different roots, treat that as a contradiction and hold',
      'actual harness context',
      'live worker and artifact evidence',
      'If the listing is unavailable or incomplete, treat prior-worker state as uncertain',
      'Absence of scratchpad artifacts alone does not prove that no worker start was attempted',
      'Keep a first-allocation reservation while scanning every session record',
      'An existing reservation without an exact, valid record for this session is a hold',
      'Remove only the reservation this invocation created, after the record is verified',
      'same uninterrupted allocator invocation may continue only when it carries the invocation-local owner token',
      'created after that invocation successfully acquired the exclusive reservation',
      'never persist or reconstruct it from a matching session id, record, manifest, or copied context',
      'A missing token means the invocation restarted or is unknown',
      "obtain a trusted maintainer's explicit confirmation in the current operator-run recovery",
      'confirms no orchestrator for this exact session is live and grants this resumer sole control',
      'operator confirmation in step 2 of [LWR]',
      'human assertion rather than a machine-checked liveness result',
      'No issue thread or new marker is required',
      'do not infer confirmation from prior comments or matching session identifiers',
      'Follow the liveness check in [LWR](idd-resume-detail.md#lwr--local-worktree-recovery) before resuming.',
      "Verify the record's exact session, repository, and canonical root",
      'If a reservation remains, require its full tuple to match the record; if none remains, do not recreate it',
      'During recovery preflight, reuse the recorded root read-only and leave any reservation untouched',
      'Matching files alone never authorize reuse',
      'elapsed time and process ids do not prove liveness',
      'no new marker or automatic unlink is used',
      'Hold and preserve on any mismatch or uncertainty',
      'root-reservations/<root-key>.lock',
      "canonicalize the candidate root with the operating system's filesystem comparison rules",
      'case normalization on case-insensitive filesystems',
      "SHA-256 digest of the canonical path's UTF-8 bytes",
      'checking worker and artifact evidence, and exclusively creating and verifying the session record',
      'never overwrite or remove it automatically',
      "worker only receives session-scratchpad paths under the root; the Worker brief's named critique scratch directory is the explicit exception",
      '<state-base>/idd-skill/orchestrator-sessions/records/<session-id>.json',
      '<state-base>/idd-skill/orchestrator-sessions/scratchpads/<session-id>/',
      'canonical repository root',
      'canonical git common directory',
      'strict version 1 shape requires exactly these seven fields',
      '`schemaVersion`: JSON integer exactly `1`',
      '`sessionId`: non-empty JSON string containing one path-safe component',
      'excluding `.`/`..`, path separators, and control characters',
      '`repository`: non-empty JSON string in `owner/repo` form',
      'normalizing both owner and repo components case-insensitively before comparison',
      '`repositoryRoot`, `gitCommonDir`, and `scratchpadRoot`',
      'non-empty JSON strings containing canonical absolute paths',
      '`allocationSource`: JSON string exactly `harness` or `parent`',
      'rejects missing or additional fields',
      'Reject an unsupported schema version, wrong JSON type, malformed value, or unknown property before trusting the record',
      'canonical state base, record directory, reservation directory, and scratchpad root all lie',
      'Reject symlink components along each managed path',
      'directory owned by the current user with private permissions',
      'Create each parent-owned directory exclusively',
      'Create the record exclusively too',
      'current-user-only access',
      'Never overwrite a record',
      'adds no helper, policy key, or automatic scratchpad deletion',
      'keep the allocated directory and any known path',
      'resume those claims without minting a claim or nonce',
      'Resume only claims classified by the no-dispatch route',
      'a complete worker listing and session artifacts with no matching worker',
      'eligible resumes bypass step 4',
      'run the profile-selected `idd-worker-budget` with `--running <n> --startable <resume-count>`',
      'Add `--harness-limit <limit>` when the worker mechanism row gives one',
      'Pass resume IDs to the profile-selected `discover-shared-file-overlap`',
      '`--issues <ids> --batch <slots> --check-overlap`',
      '`--desync-token <session-agent-id>` when `discover.selectionDesync` is `session-offset`',
      'existing claim, nonce, branch, and worktree; skip A4.5/A5',
      'until no resume remains, then Discover fresh candidates',
      'zero-slot result follows the normal budget wait/stop rule; no pick preserves the claim',
      'hold for reconciliation',
    ]) {
      assert.ok(
        lifecycle.includes(required),
        `${path}: lifecycle must include ${required}`,
      );
    }
    const allocationRaceStart = lifecycleText.indexOf(
      'A per-session exclusive record does not serialize the first allocation scan:',
    );
    const allocationRaceEnd = lifecycleText.indexOf(
      '\n\nCreate each parent-owned directory',
      allocationRaceStart,
    );
    assert.ok(
      allocationRaceStart >= 0 && allocationRaceEnd > allocationRaceStart,
      `${path}: allocation race rationale not found`,
    );
    const allocationRace = normalizeWhitespace(
      lifecycleText.slice(allocationRaceStart, allocationRaceEnd),
    );
    const allocationRaceRationale = [
      'two sessions could otherwise accept one canonical root (preventive;',
      'no observed runtime incident yet; identified during E1 review on',
      '2026-10-25, PR `#4690`, issue `#4685`). Apply collision checks to',
      'harness-supplied and parent-fallback roots.',
    ].join(' ');
    assert.ok(
      allocationRace.includes(allocationRaceRationale),
      `${path}: allocation race rationale must cite its observed review finding`,
    );
    const routingRows = lifecycleText
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map(normalizeWhitespace);
    for (const { evidence, action } of routingCases) {
      assert.ok(
        routingRows.some(
          (row) => row.includes(evidence) && row.includes(action),
        ),
        path + ': missing scratchpad evidence/action pair for ' + evidence,
      );
    }

    const scratchpad = text.slice(
      text.indexOf('**Scratchpad.**'),
      text.indexOf('**Critique allowance.**'),
    );
    assert.match(scratchpad, /parent path already exists/);
    assert.match(
      scratchpad,
      /When the parent path is missing,\s+create nothing/,
    );
    assert.match(scratchpad, /never `mkdir -p`/);
    assert.match(
      normalizeWhitespace(scratchpad),
      /inspect it without following links \(`lstat`\); require a real directory owned by the current user with private permissions, then verify its canonical path remains beneath the verified session root/,
    );
    assert.match(
      normalizeWhitespace(scratchpad),
      /Hold and preserve an entry that is a symlink, non-directory, owned by another user, too broadly accessible, or outside that root/,
    );
    assert.match(
      text,
      /issue-numbered subdirectory of the resolved session\s+scratchpad root/,
    );
    assert.match(text, /directly in the resolved session scratchpad root/);
    assert.match(text, /the verified root from the session\s+record/);
    assert.match(
      normalizeWhitespace(text),
      /During recovery preflight, reuse the recorded root read-only and leave any reservation untouched\. After sole control is established, an eligible never-dispatched resume may use the normal brief\/report path and write only to verified child issue directories and report drafts under that root\./,
    );
    assert.match(
      normalizeWhitespace(text),
      /Before dispatch, the orchestrator uses `lstat` to require `\{report-path\}` to be absent; hold and preserve any existing entry\. The worker, as the eventual writer, must create its final report draft atomically as a new regular file without following links, with current-user-only permissions \(POSIX `O_CREAT \| O_EXCL`, mode `0600`; equivalent create-new, current-user-only access on Windows\)\. If a symlink, non-regular entry, or conflicting draft appears before creation, or exclusive creation fails, hold and preserve it; never truncate, replace, or rename it\./,
    );
    assert.match(
      normalizeWhitespace(text),
      /On restart, enumerate direct-child JSON drafts with that issue number prefix and select only the unique draft matching both `issue` and `claimId`; hold on unreadable or ambiguous matches/,
    );
    assert.match(
      normalizeWhitespace(text),
      /If a candidate is a symlink or non-regular file, hold and preserve it without following it/,
    );
    assert.match(
      normalizeWhitespace(text),
      /enumerate direct-child report drafts whose filename starts with the issue number and ends in `.json`; other issue-numbered scratch files remain in that root's matching issue directory/,
    );
    assert.match(
      normalizeWhitespace(text),
      /`--issues <ids> --batch <slots> --check-overlap`/,
    );
    assert.match(
      normalizeWhitespace(text),
      /An own claim that matches no worker is an unmatched claim unless the session-scratchpad lifecycle has positively classified it as an eligible never-dispatched resume/,
    );
    assert.match(
      normalizeWhitespace(text),
      /If the resume set is non-empty, use the lifecycle's budgeted resume route before fresh candidates and do not run step 4 on those claims before dispatch/,
    );
    assert.doesNotMatch(
      text,
      /copy the scratchpad path that your harness reports/,
    );
  }

  for (const path of orchestratorCopies) {
    const text = normalizeWhitespace(readText(path));
    assert.match(
      text,
      /Use the lifecycle's budgeted route for eligible already-claimed\/no-dispatch resumes; run Discover A0 through A4 Step 1\.5 only after that set is empty/,
    );
    assert.match(
      text,
      /Before Discover, A5, \[restart scan\]\([^)]*\), refill, or dispatch, follow the \[session scratchpad lifecycle\]/,
    );
    assert.match(text, /worker missing-parent guard/);
    assert.match(
      text,
      /Verify outcome on live GitHub outside the worktree; copy the roster's `workerHandle` into the report, then set `verifiedAt`, append-time `recordedAt`, and applicable `reviewRounds`\. Validate and append with the profile-selected `idd-worker-report append --file <path>`, then dispose per table and mark the roster entry `disposed`\./,
    );
    assert.match(
      text,
      /mark `stalled`, and follow \[fan-out recovery\]\[fv\]\./,
    );
  }
});

// #4711: the ledger storage bootstrap in the bundle, its SKILL entry, and the
// docs copy. These are structural text checks that pin the rules; they never
// run an authoring session. Only a live authoring run shows that the procedure
// allocates a namespace and writes a ledger.
const LEDGER_STORAGE_CONTRACT = 'skills/issue-authoring/references/contract.md';
const LEDGER_STORAGE_SKILL = 'skills/issue-authoring/SKILL.md';
const LEDGER_STORAGE_DOCS = 'docs/issue-authoring-skill.md';
const LEDGER_STORAGE_END = '\n## Mechanical pre-publish gate';
const LEDGER_STORAGE_CASES = [
  {
    label: '**Owned and unchanged.**',
    expectedAction:
      'Continue: write the complete new JSON to a new exclusively created, owner-only temporary file',
  },
  {
    label: '**Owned but edited.**',
    expectedAction: 'Do not overwrite it.',
  },
  {
    label: '**Missing (lost).**',
    expectedAction:
      'Treat it as a lost ledger: recreate an empty ledger at the same path with exclusive creation',
  },
  {
    label: '**Unowned.**',
    expectedAction:
      'Refuse. Do not read it as a ledger, adopt it, rename it, or delete it.',
  },
  {
    label: '**Replaced.**',
    expectedAction:
      'Treat it as a conflict with another owner. Refuse, preserve both entries, and report.',
  },
  {
    label: '**Linked leaf.**',
    expectedAction: 'Refuse. Never follow it or write through it.',
  },
  {
    label: '**Linked parent.**',
    expectedAction: 'Refuse. Report.',
  },
  {
    label: '**Partial first ledger.**',
    expectedAction: 'keep the namespace and any partial file, delete nothing',
  },
  {
    label: '**Rename to the issue number.**',
    expectedAction:
      'keep the `<uuid>.json` file, never overwrite or adopt the existing file',
  },
  {
    label: '**A review that cannot finish.**',
    expectedAction: 'The target is then not published as reviewed',
  },
];

// Returns the subsection body after its heading line, so the two copies can be
// compared even though the docs copy nests it one level deeper.
function ledgerStorageSection(path: string, heading: string): string {
  return extractSection(readText(path), heading, LEDGER_STORAGE_END).slice(
    heading.length,
  );
}

test('issue-authoring contract defines ledger storage verdicts, allocation, and every ownership case (#4711)', () => {
  const section = ledgerStorageSection(
    LEDGER_STORAGE_CONTRACT,
    '### Ledger storage\n',
  );
  const text = normalizeWhitespace(section);
  for (const verdict of [
    'Supplied verified storage',
    'No previously supplied allocation',
    'Unsafe, conflicting, or unreadable storage',
  ]) {
    assert.ok(text.includes(verdict), `missing verdict: ${verdict}`);
  }
  for (const [index, scenario] of LEDGER_STORAGE_CASES.entries()) {
    const start = section.indexOf(scenario.label);
    assert.notEqual(start, -1, `missing ownership case: ${scenario.label}`);
    const nextStart = LEDGER_STORAGE_CASES.slice(index + 1)
      .map((next) => section.indexOf(next.label, start + scenario.label.length))
      .find((position) => position !== -1);
    const caseText = normalizeWhitespace(
      section.slice(start, nextStart ?? section.length),
    );
    assert.ok(
      caseText.includes(scenario.expectedAction),
      `missing expected action for ${scenario.label}: ${scenario.expectedAction}`,
    );
  }
  // Allocation is exclusive and non-recursive, and `mkdir -p` appears only in
  // the sentence that forbids it.
  assert.match(
    text,
    /Create `issue-authoring-<uuid>` relative to that handle with exclusive, non-recursive directory creation, never `mkdir -p`/,
  );
  assert.match(
    text,
    /Retry with a fresh UUID only when the name already exists, at most three times/,
  );
  assert.equal(section.match(/mkdir -p/g)?.length, 1);
  assert.match(text, /exclusive creation/);
  assert.match(text, /use POSIX mode 700/);
  assert.match(
    text,
    /On POSIX, reject a root that grants group or other users write and search permission without the sticky bit/,
  );
  assert.match(
    text,
    /On Windows, reject a root whose ACL lets another user rename or delete child entries/,
  );
  assert.match(
    text,
    /complete, successful `git worktree list --porcelain` run/,
  );
  assert.match(
    text,
    /For each existing reported worktree, run `git -C <worktree> rev-parse --path-format=absolute --git-dir` and `git -C <worktree> rev-parse --path-format=absolute --git-common-dir`/,
  );
  assert.match(
    text,
    /A common directory protects linked-worktree administrative records under its `worktrees\/` subtree, including records for a registered worktree whose checkout path is confirmed absent/,
  );
  assert.match(
    text,
    /A missing executable, nonzero status, malformed record, or incomplete output makes the protected-path inventory unreadable/,
  );
  assert.match(
    text,
    /A nonzero result proves non-membership only when it is either the exact standard `fatal: not a git repository/,
  );
  assert.match(
    text,
    /exact two-line filesystem-boundary diagnostic whose first line is `fatal: not a git repository \(or any parent up to mount point <path>\)` and whose second line is `Stopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.`/,
  );
  assert.match(
    text,
    /For the filesystem-boundary form, the reported mount point must be a verified ancestor mount point of the canonical root/,
  );
  assert.match(
    text,
    /Never treat an arbitrary Git failure as proof that the path is outside a repository/,
  );
  assert.match(
    text,
    /For every protected path \(each reported worktree path and each discovered Git directory\), first compare its normalized absolute lexical path against the candidate root using component-aware containment/,
  );
  assert.ok(
    text.includes(
      'If that walk confirms a registered worktree path is absent after checking its readable ancestors, retain the worktree record and its Git common directory, mark the protected-path inventory incomplete, and stop before evaluating any candidate root. A missing checkout does not rule out an external bind mount of one of its subdirectories; a ledger in that alias could be staged after the checkout is remounted. This control gap was identified during review of PR #4728 on 2026-10-28',
    ),
  );
  assert.ok(
    text.includes(
      'The root must be owned by the current user or a trusted system principal (POSIX UID 0 or the Windows LocalSystem SID), and must be writable by the current user.',
    ),
  );
  assert.ok(
    text.includes(
      'A sticky bit does not make a root owned by another local user trustworthy: that directory owner can rename entries in the session namespace.',
    ),
  );
  assert.ok(
    text.includes(
      "For Linux root checks, also record the candidate root, each existing protected path, and every nested mount point's mount ID, matching mountinfo fields, and derived backing location; repeat the full inventory and comparison whenever the root checks run.",
    ),
  );
  assert.match(
    text,
    /On Linux, enumerate every `\/proc\/self\/mountinfo` entry whose decoded mount point is equal to or component-contained beneath an existing protected path/,
  );
  assert.match(
    text,
    /For the candidate root, each existing protected path, and every such nested mount point, obtain a mount ID from an already-open directory handle using `statx\(2\)` with `AT_EMPTY_PATH/,
  );
  assert.match(
    text,
    /When `statx` fails or does not provide `STATX_MNT_ID`, read the single decimal `mnt_id` field from `\/proc\/self\/fdinfo\/<fd>` for that same open handle/,
  );
  assert.match(
    text,
    /Reject the candidate root when its backing location is equal to or below any protected backing location on the same device, including each nested mount point's backing location/,
  );
  assert.match(
    text,
    /Do not use `RESOLVE_NO_XDEV` as a blanket cross-mount rejection/,
  );
  assert.match(
    text,
    /If a root was supplied, stop and report its path and error; do not try another root/,
  );
  assert.match(
    text,
    /Only when no root was supplied may the next candidate be tried/,
  );
  assert.match(
    text,
    /Then open the root as a directory handle without following a symbolic link or reparse point/,
  );
  assert.ok(
    text.includes(
      'Resolve the whole root path from a trusted filesystem root or volume handle:',
    ),
  );
  assert.ok(
    text.includes(
      'on POSIX, open each component relative to the preceding verified handle with',
    ),
  );
  assert.ok(
    text.includes('`O_DIRECTORY | O_NOFOLLOW`, or use Linux `openat2(2)` with'),
  );
  assert.ok(
    text.includes(
      '`RESOLVE_NO_SYMLINKS | RESOLVE_IN_ROOT` from a trusted `/` descriptor (see',
    ),
  );
  assert.ok(
    text.includes(
      '[openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)',
    ),
  );
  assert.ok(
    text.includes(
      'On Windows, open each component relative to a trusted volume or root handle with',
    ),
  );
  assert.ok(text.includes('with `NtCreateFile` and `OBJ_DONT_REPARSE`.'));
  assert.ok(
    text.includes(
      'Applying `O_NOFOLLOW` only to the final component is insufficient.',
    ),
  );
  assert.match(
    text,
    /Open it relative to the root handle without following links, then record its canonical path, file identity, type, link count, owner, and mode or ACL/,
  );
  assert.ok(
    text.includes(
      'Create a stable `ledger.lock` file relative to this handle with exclusive, no-follow, owner-only creation.',
    ),
  );
  assert.ok(
    text.includes(
      'canonical path, owner, and owner-only mode or ACL, and has link count 1.',
    ),
  );
  assert.ok(
    text.includes(
      'Before every ledger read, write, copy, rename, or unlink, acquire the namespace lock',
    ),
  );
  assert.ok(text.includes("On POSIX, use Python's [`fcntl.flock`]"));
  assert.ok(text.includes("on Windows, use Microsoft's [`LockFileEx`]"));
  assert.match(
    text,
    /Use native handle-relative operations with exclusive creation and no-follow checks/,
  );
  assert.match(
    text,
    /On POSIX, a standard-library Python implementation can use `os\.open`, `os\.mkdir`, `os\.stat`, `os\.rename`, and `os\.unlink` with directory-descriptor parameters/,
  );
  assert.match(
    text,
    /On Windows, use a native binding that opens or creates child names with `NtCreateFile`, setting `OBJECT_ATTRIBUTES\.RootDirectory` to the verified directory handle and `OBJ_DONT_REPARSE` in its attributes\. Use `CreateDisposition=FILE_CREATE` for exclusive child creation; create a directory with `FILE_DIRECTORY_FILE`/,
  );
  assert.match(
    text,
    /Make the namespace owner-only as part of creation: use POSIX mode 700, or on Windows pass an explicit security descriptor through `OBJECT_ATTRIBUTES\.SecurityDescriptor`, with a DACL granting access only to the current user and both `SE_DACL_PRESENT` and `SE_DACL_PROTECTED` set on that descriptor/,
  );
  assert.match(
    text,
    /Make every ledger file owner-only at creation: use POSIX mode 600, or on Windows pass an explicit protected security descriptor through `OBJECT_ATTRIBUTES\.SecurityDescriptor`, with a DACL granting access only to the current user and both `SE_DACL_PRESENT` and `SE_DACL_PROTECTED` set on that descriptor/,
  );
  assert.match(
    text,
    /After opening the new file, verify its owner and owner-only mode or ACL before writing its first byte/,
  );
  assert.match(text, /Write `\[\]`, then record its SHA-256/);
  assert.match(
    text,
    /the recorded file identity, and its recorded owner-only mode or ACL/,
  );
  assert.match(
    text,
    /For every ledger file creation — the initial or recreated ledger, temporary replacement, and issue-number copy — also pass an explicit protected owner-only security descriptor through `OBJECT_ATTRIBUTES\.SecurityDescriptor`\. The namespace DACL does not establish that a child file is private\. Verify each created file's resulting owner-only DACL before writing to it/,
  );
  assert.match(
    text,
    /If the platform cannot apply this restriction before the directory is visible, fail closed/,
  );
  assert.match(
    text,
    /After the final identity and SHA-256 checks, replace the owned ledger via `SetFileInformationByHandle` on the verified temporary-file handle with `FileRenameInfo`, `ReplaceIfExists=TRUE`, and `FILE_RENAME_INFO\.RootDirectory` set to the namespace handle/,
  );
  assert.match(text, /Open that file handle with `DELETE` access/);
  assert.match(
    text,
    /mark the verified source handle for deletion with `SetFileInformationByHandle` and `FileDispositionInfo` \(`DeleteFile=TRUE`\); it also requires `DELETE` access/,
  );
  assert.match(
    text,
    /If the host cannot bind an operation to the verified handle or supply the required evidence, treat the storage as unreadable and stop/,
  );
  assert.match(
    text,
    /replacement, while holding the exclusive namespace lock, repeat the ownership check and verify that the existing ledger's identity and SHA-256 still match the records/,
  );
  assert.match(
    text,
    /Immediately before unlinking the source, verify that the namespace identity still matches, the source identity and SHA-256 still match their records/,
  );
  assert.ok(
    text.includes(
      'the destination is a regular file with link count 1, the recorded identity and SHA-256, and the canonical path `<namespace>/<number>.json`',
    ),
  );
  assert.match(
    text,
    /confirm that the copy's SHA-256 equals the source ledger's recorded SHA-256/,
  );
  assert.match(
    text,
    /confirm that the destination's SHA-256 still equals the source ledger's recorded SHA-256/,
  );
  // Failed post-creation checks preserve the new namespace instead of deleting
  // it by path; no other session's entry is adopted or removed.
  assert.match(
    text,
    /If any check fails, preserve the namespace and report its path and the exact failing evidence; mark this candidate failed\. Do not remove it by path/,
  );
  assert.doesNotMatch(section, /rmdir/);
  assert.match(
    text,
    /The cases below are preventive; no observed incident yet/,
  );
  // Mismatches preserve unverified entries, and cleanup is restricted to
  // session-created entries whose identity still matches.
  assert.match(
    text,
    /On a mismatch, preserve the ledger and any unverified temporary entry; never recurse into a directory or adopt an entry this session did not create/,
  );
  assert.match(
    text,
    /Cleanup may remove only an entry created by this session whose recorded identity still matches/,
  );
  assert.match(
    text,
    /never automatically deletes an older or abandoned namespace/,
  );
  assert.match(
    text,
    /It may remove only a newly created entry whose recorded identity still matches/,
  );
});

test('ledger storage needs no orchestrator, environment variable, helper, or session ID (#4711)', () => {
  const text = normalizeWhitespace(
    ledgerStorageSection(LEDGER_STORAGE_CONTRACT, '### Ledger storage\n'),
  );
  assert.match(
    text,
    /no orchestrator, no particular environment variable, no helper package, and no stable harness session ID/,
  );
  assert.match(text, /instructions-only and same-response self-critique runs/);
});

test('ledger rules keep namespaces, rejection carry-forward, and lost-ledger semantics in bundle and docs (#4711)', () => {
  for (const path of [LEDGER_STORAGE_CONTRACT, LEDGER_STORAGE_DOCS]) {
    const text = normalizeWhitespace(readText(path));
    for (const needle of [
      'keep a findings ledger in the namespace that [Ledger storage](#ledger-storage) allocates',
      'No two drafts or concurrent workers share a ledger file.',
      'The ledger is never written to the repository or to a marker.',
      'If the namespace or the ledger is lost, for example after a restart, the ledger is empty and the review runs as it does without one.',
      'For each `rejected` entry that has evidence, add one string',
    ]) {
      assert.ok(text.includes(needle), `${path}: missing "${needle}"`);
    }
    assert.doesNotMatch(text, /session scratchpad/);
  }
});

test('SKILL entry carries the ledger storage summary and link for instructions-only runs (#4711)', () => {
  const skill = normalizeWhitespace(readText(LEDGER_STORAGE_SKILL));
  for (const needle of [
    '## Findings ledger storage',
    '[Ledger storage](references/contract.md#ledger-storage)',
    '[Findings ledger storage](#findings-ledger-storage)',
    "never reuse another session's namespace",
    'if a supplied root fails, stop without trying another root',
    'When no root is supplied, allocate a',
    'including mount aliases verified by native filesystem evidence.',
    'preserve unverified entries; the contract permits cleanup only for entries this session created whose identity still matches.',
    'Instructions-only and same-response self-critique runs follow the same procedure; no orchestrator, environment variable, or helper is needed.',
  ]) {
    assert.ok(skill.includes(needle), `SKILL.md: missing "${needle}"`);
  }
  assert.doesNotMatch(skill, /session scratchpad/);
  assert.doesNotMatch(skill, /delete nothing|or otherwise create/);
});

test('docs copy mirrors the ledger storage subsection and separates structural checks from a live run (#4711)', () => {
  const contract = normalizeWhitespace(
    ledgerStorageSection(LEDGER_STORAGE_CONTRACT, '### Ledger storage\n'),
  );
  const docs = normalizeWhitespace(
    ledgerStorageSection(LEDGER_STORAGE_DOCS, '#### Ledger storage\n'),
  );
  assert.ok(
    docs.startsWith(contract),
    'the docs copy must hold the contract subsection verbatim',
  );
  assert.match(docs, /Structural checks and a live run differ/);
  assert.match(docs, /they never run an authoring session/);
});
