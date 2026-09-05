import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADVISORY_CONVERGENCE_CHECK_SELECTOR } from '../src/scripts/advisory-convergence.mts';
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
  globFiles,
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
import { readJson, readText } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const SUITABILITY_PATH = new URL(
  '../.github/instructions/idd-suitability.instructions.md',
  import.meta.url,
);
const ROADMAP_AUDIT_PATH = new URL(
  '../.github/instructions/idd-roadmap-audit.instructions.md',
  import.meta.url,
);
const WORKFLOW_PATH = new URL('../docs/idd-workflow.md', import.meta.url);
const CUSTOMIZATION_PATH = new URL('../docs/customization.md', import.meta.url);

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
  phaseLimitBytes: 36_000,
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
    'README.md': '| Phase | 36,000 bytes |\n| Always | 20,000 bytes |',
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
    /doc-budget-drift: README\.md states 30,000 bytes, which is not a current sync-manifest budget value \(valid: 16000, 20000, 24000, 26000, 36000, 45000, 104000\)/,
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

test('live manifest instructionSizeBudgets covers both the dogfooding and idd-template instruction globs', () => {
  // Regression guard for #1667: the manifest must keep a dedicated entry
  // for the canonical idd-template source, not just the dogfooding copy,
  // or a future structure-mode divergence can silently exceed the shared
  // byte cap on the idd-template side again.
  const manifest = readJson('audit/sync-manifest.json') as {
    instructionSizeBudgets?: { id?: string; glob?: string }[];
  };
  const budgets = manifest.instructionSizeBudgets;
  assert.ok(
    Array.isArray(budgets),
    'instructionSizeBudgets must be an array of per-glob budget entries',
  );
  // Assert inclusion, not an exact-array match: audit/README.md explicitly
  // encourages adding further per-glob entries later, and this guard must
  // not start failing the day a third one lands.
  const globs = budgets.map((budget) => budget.glob);
  for (const requiredGlob of [
    '.github/instructions/idd-*.instructions.md',
    'idd-template/.github/instructions/idd-*.instructions.md',
  ]) {
    assert.ok(
      globs.includes(requiredGlob),
      `instructionSizeBudgets is missing an entry for ${requiredGlob}`,
    );
  }
  const ids = budgets.map((budget) => budget.id);
  assert.ok(
    ids.every((id) => typeof id === 'string' && id.trim().length > 0),
    'each instructionSizeBudgets entry needs a non-empty id',
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    'each instructionSizeBudgets entry needs a distinct id to disambiguate audit output',
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
  for (const profile of ['package-manager', 'vendored-node', 'ephemeral-npx']) {
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

test('the "Detect package manager" workflow step body is byte-identical across the three files that share it (idd-skill#2392)', () => {
  const WORKFLOW_FILES = [
    'idd-template/.github/workflows/post-merge-cleanup.yml',
    'idd-template/.github/workflows/idd-advisory-convergence.yml',
    'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
  ];
  const STEP_START = '      - name: Detect package manager\n';
  const STEP_END_RE = /\n {6}- name: /;

  function extractDetectPackageManagerStep(relativePath: string): string {
    const content = readText(relativePath);
    const startIndex = content.indexOf(STEP_START);
    assert.notEqual(
      startIndex,
      -1,
      `expected to find a "Detect package manager" step in ${relativePath}`,
    );
    const afterStart = content.slice(startIndex + STEP_START.length);
    const endIndex = afterStart.search(STEP_END_RE);
    assert.notEqual(
      endIndex,
      -1,
      `expected a step boundary after "Detect package manager" in ${relativePath}`,
    );
    return afterStart.slice(0, endIndex);
  }

  const [reference, ...rest] = WORKFLOW_FILES.map((path) => ({
    path,
    body: extractDetectPackageManagerStep(path),
  }));
  for (const other of rest) {
    assert.equal(
      other.body,
      reference.body,
      `"Detect package manager" step body in ${other.path} drifted from ${reference.path}`,
    );
  }
});

test('policy normalization provides default-safe values and supports aliases', () => {
  assert.deepEqual(normalizePolicyConfig(null), {
    issueScope: 'roadmap-first',
    orphanFirstPolicy: 'none',
    skipIssueAuthorApprovalGate: false,
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
      cPhaseLowSeveritySkipAfter: 3,
      e10NoProgressHoldAfter: 3,
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
    },
    labels: {
      roadmapLabelName: 'roadmap',
      blockedByHumanLabelName: 'status:blocked-by-human',
      needsDecisionLabelName: 'status:needs-decision',
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
      },
      mergeGate: {
        soloCodeownerAdminFallback: 'hold-and-report',
      },
    }),
    {
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

test('A4.5 outcome fixtures match the documented check-to-outcome mapping', () => {
  const text = readFileSync(SUITABILITY_PATH, 'utf8');
  const checks = extractCheckOutcomes(text);
  const outcomes = extractOutcomeTable(text);
  const cases = readJson('tests/fixtures/consistency/a45-outcomes.json') as {
    id: string;
    failedCheck: string;
    expectedOutcome: string;
  }[];

  for (const fixture of cases) {
    assert.equal(
      checks.get(fixture.failedCheck),
      fixture.expectedOutcome,
      fixture.id,
    );
    assert.ok(outcomes.has(fixture.expectedOutcome), fixture.expectedOutcome);
  }

  assert.deepEqual(
    [...new Set(cases.map((fixture) => fixture.expectedOutcome))].sort(),
    [
      'blocked-by-human',
      'duplicate',
      'invalid',
      'needs-decision',
      'out-of-scope',
      'unclear',
    ],
  );
  assert.match(outcomes.get('invalid') ?? '', /do not retry/i);
});

test('discover A2 roadmap node classification guidance is present in instruction and docs surfaces', () => {
  const discover = readFileSync(
    new URL(
      '../.github/instructions/idd-discover.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const templateDiscover = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-discover.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const templateWorkflow = readFileSync(
    new URL('../idd-template/docs/idd-workflow.md', import.meta.url),
    'utf8',
  );

  assert.match(discover, /roadmap node/i);
  assert.match(discover, /execution leaf/i);
  assert.match(discover, /only open roadmap nodes remain/i);
  assert.match(discover, /A3\/A4\/A4\.5\/A5/i);
  assert.match(workflow, /classify roadmap/i);

  assert.match(templateDiscover, /roadmap node/i);
  assert.match(templateDiscover, /execution leaf/i);
  assert.match(templateDiscover, /only open roadmap nodes remain/i);
  assert.match(templateDiscover, /A3\/A4\/A4\.5\/A5/i);
  assert.match(templateWorkflow, /classify roadmap/i);
});

test('Codex critique guidance prefers a bounded reviewer with an explicit fallback (idd-skill#1851)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const templateWorkflow = readFileSync(
    new URL('../idd-template/docs/idd-workflow.md', import.meta.url),
    'utf8',
  );

  const critiqueSections = [workflow, templateWorkflow].map((text) => {
    const critiqueSectionStart = text.indexOf('## Critique pass invocation');
    assert.notEqual(
      critiqueSectionStart,
      -1,
      'the workflow must keep the critique section header',
    );
    const nextSectionStart = text.indexOf('\n## ', critiqueSectionStart + 1);
    const critiqueSection = text.slice(
      critiqueSectionStart,
      nextSectionStart === -1 ? undefined : nextSectionStart,
    );
    const codexRow = critiqueSection.match(
      /^\| Codex CLI\s+\|([^\n]+)\|$/m,
    )?.[1];
    assert.ok(codexRow, 'the workflow must keep a Codex critique row');
    assert.match(
      codexRow,
      /Use one bounded read-only native subagent review when supported and suitable/,
    );
    assert.match(codexRow, /parent waits for and collects the result/);
    assert.match(codexRow, /structured self-critique/);
    assert.match(
      codexRow,
      /delegation is unavailable, disabled, unsuitable, or fails/,
    );
    assert.doesNotMatch(
      codexRow,
      /Self-critique: add a "review the above for issues"/,
    );
    assert.match(critiqueSection, /objective diff validation floor/);
    assert.match(
      critiqueSection,
      /This floor applies \*\*uniformly\*\* to every runtime/,
    );
    assert.match(
      critiqueSection,
      /parent collects the reviewer result before\s+continuing/,
    );
    return { codexRow: codexRow.trim(), critiqueSection };
  });

  assert.deepEqual(
    critiqueSections[0].codexRow,
    critiqueSections[1].codexRow,
    'source and template Codex critique rows must stay equivalent',
  );
  assert.equal(
    critiqueSections[0].critiqueSection,
    critiqueSections[1].critiqueSection,
    'source and template critique guidance must remain equivalent',
  );
});

test('review-triage PATH A verify-before-accept and actor-permission-cap guidance is present in instruction and template surfaces (idd-skill#1690, PR#1796)', () => {
  const reviewTriage = readFileSync(
    new URL(
      '../.github/instructions/idd-review-triage.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const templateReviewTriage = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-review-triage.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );

  for (const text of [reviewTriage, templateReviewTriage]) {
    // \s+ between words tolerates a Markdown reflow (dprint) that moves a
    // wrap point mid-phrase without changing the semantic content.
    assert.match(text, /Verify\s+before\s+accept/);
    assert.match(text, /actor-permission\s+cap/i);
    // Guards against reverting the PR#1796 hardening: an unprivileged
    // commenter's assertion alone must never force an Accept.
    assert.match(text, /collaborators\/\{username\}\/permission/);
    assert.match(text, /assertion\s+alone\s+never\s+reaches\s+Accept\s+forced/);
  }
});

test('merge Duplicate-success-record skip rule still requires a trusted marker actor is present in instruction and template surfaces (idd-skill#1691, PR#1759)', () => {
  const merge = readFileSync(
    new URL(
      '../.github/instructions/idd-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const templateMerge = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );

  for (const text of [merge, templateMerge]) {
    // \s+ between words tolerates a Markdown reflow (dprint) that moves a
    // wrap point mid-phrase without changing the semantic content.
    assert.match(text, /Duplicate-success-record\s+skip\s+rule/);
    assert.match(text, /whose\s+author\s+is\s+a\s+trusted\s+marker\s+actor/);
    assert.match(
      text,
      /An\s+untrusted\s+commenter's\s+marker-prefixed\s+comment\s+never\s+counts\s+as\s+evidence/,
    );
  }
});

test('autonomy contract main-merge row caveats the standing operator-confirmation gate independent of the Reversible classification (idd-skill#1627)', () => {
  const autonomyContract = readFileSync(
    new URL('../docs/idd-autonomy-contract.md', import.meta.url),
    'utf8',
  );
  const templateAutonomyContract = readFileSync(
    new URL('../idd-template/docs/idd-autonomy-contract.md', import.meta.url),
    'utf8',
  );

  for (const text of [autonomyContract, templateAutonomyContract]) {
    // \s+ between words tolerates a Markdown reflow (dprint) that moves a
    // wrap point mid-phrase without changing the semantic content.
    assert.match(
      text,
      /standing\s+operator\s+confirmation\s+before\s+this\s+merge\s+regardless\s+of\s+this\s+Reversible\s+classification/,
    );
    assert.match(text, /protects\s+reviewer\s+attention/);
    assert.match(text, /not\s+against\s+data\s+loss/);
    assert.match(text, /unresolved\s+review\s+threads/);
    assert.match(text, /idd-review-fix-lite\.instructions\.md/);
  }
});

test('pre-merge F2 own-agent-comment carve-out covers procedural/status comments beyond disposition replies (idd-skill#1811)', () => {
  const preMerge = readFileSync(
    new URL(
      '../.github/instructions/idd-pre-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const templatePreMerge = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-pre-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );

  for (const text of [preMerge, templatePreMerge]) {
    // \s+ between words tolerates a Markdown reflow (dprint) that moves a
    // wrap point mid-phrase without changing the semantic content.
    assert.match(
      text,
      /own-agent-authored\s+procedural\s+or\s+status\s+comment/,
    );
    assert.match(text, /hold\s+comment\s+explaining\s+a\s+blocker/);
    // Guards the carve-out's no-finding condition: it only covers a
    // comment that introduces no reviewer or bot finding of its own.
    assert.match(
      text,
      /introduces\s+no\s+reviewer\s+or\s+bot\s+finding\s+of\s+its\s+own/,
    );
    // Guards against silently swallowing a mixed-cause trigger: the
    // refresh-instead sentence must still be gated on "solely".
    assert.match(text, /triggered\s+solely\s+by\s+disposition\s+replies/);
  }
});

test('pre-merge F2 carves out third-party advisory bot skip-review notices from review-currency staleness (idd-skill#2590)', () => {
  const preMerge = readFileSync(
    new URL(
      '../.github/instructions/idd-pre-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );
  const templatePreMerge = readFileSync(
    new URL(
      '../idd-template/.github/instructions/idd-pre-merge.instructions.md',
      import.meta.url,
    ),
    'utf8',
  );

  for (const text of [preMerge, templatePreMerge]) {
    // \s+ between words tolerates a Markdown reflow (dprint) that moves a
    // wrap point mid-phrase without changing the semantic content.
    assert.match(
      text,
      /third-party\s+advisory\s+bot's\s+own\s+skip-review\s+or\s+no-action\s+notice/,
    );
    // Guards the carve-out's no-finding condition: it only covers a
    // notice that carries no reviewer finding or actionable content.
    assert.match(text, /no\s+reviewer\s+finding\s+or\s+actionable\s+content/);
    // Guards against silently swallowing a mixed-cause trigger: the
    // refresh-instead sentence must still be gated on "solely".
    assert.match(text, /triggered\s+solely\s+by\s+that\s+notice/);
    assert.match(
      text,
      /mixed-cause\s+trigger\s+still\s+returns\s+to\s+E1\s+normally/,
    );
  }
});

test('recursive roadmap audit guidance stays aligned across instruction and docs surfaces', () => {
  const audit = readFileSync(ROADMAP_AUDIT_PATH, 'utf8');
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  const customization = readFileSync(CUSTOMIZATION_PATH, 'utf8');

  assert.match(audit, /nested roadmaps?/i);
  assert.match(audit, /bottom-up/i);
  assert.match(audit, /exact roadmap issue being mutated/i);
  assert.match(workflow, /nested roadmap/i);
  assert.match(workflow, /bottom-up/i);
  assert.match(customization, /bottom-up/i);
  assert.match(customization, /exact roadmap node being mutated/i);
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

function extractCheckOutcomes(text: string): Map<string, string> {
  const entries = [
    ...text.matchAll(
      /^### Check \d+: ([^\n]+)\n[\s\S]*?^- \*\*Outcome on fail\*\*: `([^`]+)`$/gm,
    ),
  ];
  return new Map(
    entries.map(
      ([, heading, outcome]) => [heading.trim(), outcome] as [string, string],
    ),
  );
}

function extractOutcomeTable(text: string): Map<string, string> {
  const sectionMatch = text.match(
    /## Failure Outcomes[\s\S]*?\n\| Outcome[\s\S]*?\n((?:\|[^\n]+\n)+)/,
  );
  const rows = (sectionMatch?.[1] ?? '')
    .split(/\r?\n/)
    .filter((row) => row.startsWith('| `'));
  return new Map(
    rows.map((row) => {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return [cells[0].replaceAll('`', ''), cells[2]] as [string, string];
    }),
  );
}

test('package.json version stays aligned with iddVersion in the shipped and template configs', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const configPath of [
    '.github/idd/config.json',
    'idd-template/.github/idd/config.json',
  ]) {
    const config = JSON.parse(
      readFileSync(new URL(`../${configPath}`, import.meta.url), 'utf8'),
    );
    assert.equal(
      packageJson.version,
      config.iddVersion,
      `package.json version (${packageJson.version}) must equal iddVersion ` +
        `(${config.iddVersion}) in ${configPath}`,
    );
  }
});

test('#1512: this repository opts into the advisory-convergence maintainer-waiver backstop, while the distributed template config stays disabled', () => {
  const repoPolicy = normalizePolicyConfig(readJson('.github/idd/config.json'));
  assert.equal(
    repoPolicy.ciGate.externalCheckWaivers.mode,
    'maintainer-authorized',
  );
  assert.ok(
    repoPolicy.ciGate.externalChecks.waivable.some(
      (entry) =>
        entry.selector === ADVISORY_CONVERGENCE_CHECK_SELECTOR &&
        entry.matchMode === 'exact',
    ),
    `expected ${ADVISORY_CONVERGENCE_CHECK_SELECTOR} to be registered under ` +
      'ciGate.externalChecks.waivable with matchMode "exact" (not a ' +
      'broader glob) in .github/idd/config.json',
  );

  const templatePolicy = normalizePolicyConfig(
    readJson('idd-template/.github/idd/config.json'),
  );
  assert.equal(templatePolicy.ciGate.externalCheckWaivers.mode, 'disabled');
  assert.deepEqual(templatePolicy.ciGate.externalChecks.waivable, []);
});

test('#2284: this repository keeps fully_autonomous_merge as its local dogfood opt-in, while the distributed template config defaults to human_merge', () => {
  const repoConfig = readJson('.github/idd/config.json') as {
    mergePolicy: string;
  };
  assert.equal(repoConfig.mergePolicy, 'fully_autonomous_merge');

  const templateConfig = readJson('idd-template/.github/idd/config.json') as {
    mergePolicy: string;
  };
  assert.equal(templateConfig.mergePolicy, 'human_merge');
});

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

test("audit/sync-manifest.json's guarded repo state: this repository's own engines.node mirrors are currently in sync", () => {
  const packageJson = readJson('package.json') as {
    engines?: { node?: unknown };
  };
  const violations = collectEnginesRangeMirrorViolations(
    packageJson.engines?.node,
    [
      { file: '.nvmrc', mode: 'low-bound-line' },
      { file: '.node-version', mode: 'low-bound-line' },
      { file: '.tool-versions', mode: 'low-bound-contains' },
      { file: '.github/workflows/lint.yml', mode: 'full-range' },
      {
        file: '.github/workflows/idd-advisory-convergence.yml',
        mode: 'full-range',
      },
      {
        file: '.github/workflows/idd-advisory-convergence-comment.yml',
        mode: 'full-range',
      },
      {
        file: '.github/workflows/pnpm-boundary-node22-floor.yml',
        mode: 'low-bound-contains',
      },
      { file: '.github/CONTRIBUTING.md', mode: 'full-range' },
      { file: '.github/CONTRIBUTING.ja.md', mode: 'full-range' },
      { file: '.github/CONTRIBUTING.zh.md', mode: 'full-range' },
      { file: 'docs/typescript-sources.md', mode: 'full-range' },
      { file: 'docs/workshop/README.md', mode: 'components' },
      { file: 'docs/stalled-session-quiet-check.md', mode: 'components' },
      { file: 'src/scripts/helper-runtime-manifest.mts', mode: 'full-range' },
    ],
    readText,
  );
  assert.deepEqual(violations, []);
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

test("this repository's own bin/**/*.mjs files are currently all tracked executable (#1971 guarded repo state)", () => {
  const repoFiles = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const binFiles = globFiles('bin/**/*.mjs', repoFiles);
  assert.ok(binFiles.length > 0, 'expected at least one bin/*.mjs file');
  const modeOutput = execFileSync(
    'git',
    ['ls-files', '-s', '--', ...binFiles],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const modes = new Map<string, string>();
  for (const line of modeOutput.split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+)\s+\S+\s+\S+\t(.+)$/.exec(line);
    if (match) {
      modes.set(match[2], match[1]);
    }
  }
  const violations = collectBinExecutableModeViolations(
    binFiles,
    readText,
    (file) => modes.get(file) ?? null,
  );
  assert.deepEqual(violations, []);
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

// #2274: regression guard for #2271-#2273's development-branch migration --
// finds every line carrying a standalone `main` branch-token mention in the
// affected D/E/F phase files and asserts each line's exact (trimmed) text
// equals one already-known-legitimate entry (the B1 trusted-checkout
// contract, which intentionally keeps the primary worktree pinned to
// `main` regardless of `{development-branch}`, and one historical
// ruleset-name reference). Exact-line equality, not a substring/count
// check, so an *additional* `main` mention appended to an otherwise
// allowed line still fails: the trimmed line no longer matches any
// allowlist entry (review round 1 -- a per-line-count check alone could
// not distinguish a legitimate line from the same line with a second,
// newly reintroduced `main` mention appended to it).
function findBareMainLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /\bmain\b/.test(line))
    .map((line) => line.trim());
}

/** Lines outside `allowedLines` that carry a bare `main` mention. */
function findUnallowedMainLines(
  text: string,
  allowedLines: ReadonlySet<string>,
): string[] {
  return findBareMainLines(text).filter((line) => !allowedLines.has(line));
}

const NO_MAIN_MENTIONS_ALLOWED = new Set<string>();

const REVIEW_TRIAGE_ALLOWED_MAIN_LINES = new Set([
  // A design-rationale anchor whose slug text embeds "main"
  // (`#merge-main-livelock-...`) -- not a branch-sync instruction.
  '[design rationale](../../docs/idd-design-rationale.md#merge-main-livelock-under-fast-moving-main)).',
]);

const MERGE_ALLOWED_MAIN_LINES = new Set([
  // A historical, repository-specific ruleset-name reference, not a
  // synchronization/target instruction.
  'current `main` ruleset (`require_code_owner_review: false`), the',
]);

const B1_TRUSTED_CHECKOUT_MAIN_LINES = new Set([
  '1. Ensure the local `main` branch is up to date and has no local',
  'commits. Run this from the primary worktree while on `main`:',
  'git fetch origin main',
  'git log origin/main..main --oneline',
  'If the second command outputs any lines, local `main` has unpushed',
  'commits — stop and report, do not force-reset `main`. Otherwise,',
  'git merge --ff-only origin/main',
  'After this `main` fast-forward, do **not** change the primary',
  "worktree's HEAD off `main` for any reason during B1 — see",
  "The primary worktree's HEAD MUST remain on `main` throughout B1; if it",
  'ever leaves `main`, stop immediately and follow the B1 self-check',
  '`main`.',
  '`main` baseline — verify with a fresh-vs-stale `node_modules` comparison',
]);

test('idd-pr-submit.instructions.md and idd-review-fix.instructions.md carry zero bare `main` branch mentions (#2274)', () => {
  for (const name of [
    'idd-pr-submit.instructions.md',
    'idd-review-fix.instructions.md',
  ]) {
    const text = readText(`idd-template/.github/instructions/${name}`);
    assert.deepEqual(
      findUnallowedMainLines(text, NO_MAIN_MENTIONS_ALLOWED),
      [],
      `${name} must reference {development-branch}, not a bare "main"`,
    );
  }
});

test('idd-review-triage.instructions.md confines its bare `main` mention to the known design-rationale anchor (#2274)', () => {
  const text = readText(
    'idd-template/.github/instructions/idd-review-triage.instructions.md',
  );
  assert.deepEqual(
    findUnallowedMainLines(text, REVIEW_TRIAGE_ALLOWED_MAIN_LINES),
    [],
  );
});

test('idd-merge.instructions.md confines its bare `main` mention to the known historical ruleset-name reference (#2274)', () => {
  const text = readText(
    'idd-template/.github/instructions/idd-merge.instructions.md',
  );
  assert.deepEqual(findUnallowedMainLines(text, MERGE_ALLOWED_MAIN_LINES), []);
});

test('idd-work.instructions.md confines every bare `main` mention to the B1 trusted-checkout contract (#2274)', () => {
  const text = readText(
    'idd-template/.github/instructions/idd-work.instructions.md',
  );
  assert.ok(
    findBareMainLines(text).length > 0,
    'sanity check: B1 still documents `main`',
  );
  assert.deepEqual(
    findUnallowedMainLines(text, B1_TRUSTED_CHECKOUT_MAIN_LINES),
    [],
    'a `main` mention outside the B1 trusted-checkout allowlist regressed the {development-branch} migration',
  );
});

function extractBoundedRegion(
  content: string,
  startMarker: string,
  endMarker: string,
  path: string,
): string {
  const startIndex = content.indexOf(startMarker);
  assert.notEqual(
    startIndex,
    -1,
    `expected to find ${JSON.stringify(startMarker)} in ${path}`,
  );
  const afterStart = content.slice(startIndex + startMarker.length);
  const endIndex = afterStart.indexOf(endMarker);
  assert.notEqual(
    endIndex,
    -1,
    `expected ${JSON.stringify(endMarker)} after ${JSON.stringify(startMarker)} in ${path}`,
  );
  return afterStart.slice(0, endIndex);
}

test('D4 pending:true recovery ties each advisory-wait outcome to its actual action, not just "not outstanding" (idd-skill#2622)', () => {
  // "not already outstanding" alone reads true for SATISFIED (review just
  // landed), WAIT (same-head request already exists, inside its settle
  // window), and CAP_EXHAUSTED (request cap already spent) -- not only for
  // the genuinely-needs-a-request case. Naively requesting whenever nothing
  // is "outstanding" re-requests a review Copilot already submitted
  // (traced on PR #2598), violates the cap/settle-window contract, or loops
  // forever waiting on a review that will never arrive once the cap is
  // spent. Assert each outcome sits next to its correct disposition, not
  // merely that the outcome name appears somewhere in the bullet (a bare
  // name-presence check would still pass if a future edit moved an outcome
  // into the wrong clause).
  const path =
    'idd-template/.github/instructions/idd-pr-submit.instructions.md';
  const bullet = extractBoundedRegion(
    readText(path),
    'reports `pending: true`**',
    'the pending-disposition case above takes.',
    path,
  );
  assert.match(bullet, /advisory-wait-state/);
  assert.match(bullet, /lastCopilotCommit/);

  const requestNow = extractBoundedRegion(
    bullet,
    'read `outcome`:',
    'request a review now.',
    path,
  );
  assert.match(requestNow, /only `REQUEST_NEEDED`/);

  const requestNothingWaitAndRerun = extractBoundedRegion(
    bullet,
    'request a review now.',
    'resume D4.',
    path,
  );
  assert.match(requestNothingWaitAndRerun, /`SATISFIED`/);
  assert.match(requestNothingWaitAndRerun, /`WAIT`/);
  assert.match(requestNothingWaitAndRerun, /request nothing/);

  const exitToE1 = extractBoundedRegion(
    readText(path),
    'resume D4.',
    'the pending-disposition case above takes.',
    path,
  );
  assert.match(exitToE1, /`CAP_EXHAUSTED`/);
  assert.match(exitToE1, /`RECOVERY_NEEDED`/);
  assert.match(exitToE1, /idd-review-snapshot\.instructions\.md.*\(E1\)/);
});

test('idd-ci.instructions.md Exception 3 defers to D4\'s corrected pending:true recovery check, not a standalone "outstanding" check (idd-skill#2622)', () => {
  const path = 'idd-template/.github/instructions/idd-ci.instructions.md';
  const row = extractBoundedRegion(readText(path), 'Exception 3:', ' |', path);
  assert.match(row, /D4's `pending: true` recovery check/);
});

test('D3.6 derives the IDD impact checklist mechanically, excluding the idd-template mirror from Instruction files (idd-skill#2634)', () => {
  const path =
    'idd-template/.github/instructions/idd-pr-submit.instructions.md';
  const section = extractBoundedRegion(
    readText(path),
    '### D3.6 — Derive the IDD impact checklist',
    '### PR body language',
    path,
  );
  for (const label of [
    'Instruction files changed',
    'Template files changed',
    'Helper scripts changed',
    'Config schema changed',
    'Security / credential / merge behavior changed',
  ]) {
    assert.match(
      section,
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `D3.6 must derive the "${label}" checkbox`,
    );
  }
  assert.match(section, /root-anchored path-prefix match/);
  assert.match(
    section,
    /excludes `idd-template\/\.github\/instructions\/`\s+paths/,
    'D3.6 must exclude the idd-template mirror from "Instruction files changed"',
  );
  assert.match(
    section,
    /Skip this sub-step and D3\.7 below entirely when/,
    'D3.6 must skip itself and D3.7 when no pull_request_template.md exists (idd-template/ ships none)',
  );
});

test('D3.7 re-derives the impact checklist against final HEAD before merge, using a generic safe-edit (not round-specific PR-body-sync prose) (idd-skill#2634)', () => {
  const path =
    'idd-template/.github/instructions/idd-pr-submit.instructions.md';
  const section = extractBoundedRegion(
    readText(path),
    '### D3.7 — Re-verify the IDD impact checklist before merge',
    '## D4 — Wait for CI',
    path,
  );
  assert.match(section, /re-derive D3\.6's checklist/);
  assert.match(section, /ratchet-rule/);
  assert.match(section, /gh pr edit \{pr-number\} --body-file/);
  assert.match(section, /never pass a partial file/);
  assert.match(section, /D3\.5 step 6's closing-set check/);
  // Must not lean on idd-review-fix.instructions.md's round-specific "this
  // round's fix" framing verbatim -- the mechanics here are paraphrased
  // generically since D3.7 can fire with zero E-phase rounds behind it.
  assert.doesNotMatch(section, /this round's fix/);
});
