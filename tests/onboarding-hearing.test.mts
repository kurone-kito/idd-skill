import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as onboard from '../src/scripts/idd-onboard.mts';
import { ONBOARDING_PLACEHOLDERS } from '../src/scripts/idd-onboard.mts';
import {
  loadOnboardingHearingCatalog,
  loadOnboardingHearingItems,
  ONBOARDING_HEARING_CATALOG_RELATIVE_PATH,
} from '../src/scripts/onboarding-hearing.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validateFixture,
} from '../src/scripts/validate-schemas.mts';

const PLACEHOLDERS_DOC = fileURLToPath(
  new URL('../idd-template/docs/onboarding/placeholders.md', import.meta.url),
);
const POLICY_DOC = fileURLToPath(
  new URL(
    '../idd-template/docs/onboarding/policy-decisions.md',
    import.meta.url,
  ),
);

const STEP0_IDS = [
  'gh-cli',
  'git-remote-host',
  'execution-environment',
] as const;

const STEP1B_IDS = [
  'merge-policy',
  'review-policy',
  'thread-resolution-policy',
  'critique-loop-profile',
  'credential-scope',
  'claim-timing',
  'ci-wait-policy',
  'issue-author-approval-gate',
  'maintainer-approval-actor-policy',
  'issue-authoring-companion',
  'helper-runtime-profile',
  'idd-label-names',
  'up-to-date-head-ruleset',
  'bootstrap-execution-mode',
  'development-branch',
] as const;

const DOCS_ONLY_IDS = new Set<string>([
  ...STEP0_IDS,
  'critique-loop-profile',
  'credential-scope',
  'issue-authoring-companion',
  'up-to-date-head-ruleset',
  'bootstrap-execution-mode',
]);

const STEP1B_COMPANION = {
  'merge-policy': '### Merge policy',
  'review-policy': '### PR review policy profile',
  'thread-resolution-policy': '### Review-thread resolution policy',
  'critique-loop-profile': '### Critique-loop profile',
  'credential-scope': '### Credential scope',
  'claim-timing': 'claim-stale-age',
  'ci-wait-policy': '### CI wait policy',
  'issue-author-approval-gate': '### Issue-author approval gate',
  'maintainer-approval-actor-policy': '### `maintainer-approval-actors` policy',
  'issue-authoring-companion': '### Issue-authoring companion',
  'helper-runtime-profile': '### Helper runtime profile',
  'idd-label-names': '### IDD label names',
  'up-to-date-head-ruleset': 'up to date before merging',
  'bootstrap-execution-mode': '### Bootstrap execution mode',
  'development-branch': '### Development branch',
} as const;

function extractH2Section(doc: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = doc.indexOf(marker);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const after = doc.slice(start + marker.length);
  const next = after.search(/^## /mu);
  return next === -1 ? after : after.slice(0, next);
}

test('hearing catalog schemas use only allowed keywords', () => {
  assert.deepEqual(
    checkSchemaKeywords(
      loadJson('schemas/onboarding-hearing-catalog.schema.json'),
    ),
    [],
  );
  assert.deepEqual(
    checkSchemaKeywords(
      loadJson('schemas/onboarding-hearing-transcript.schema.json'),
    ),
    [],
  );
});

test('live hearing catalog validates against its schema', () => {
  const { ok, errors } = validateFixture(
    'schemas/onboarding-hearing-catalog.schema.json',
    ONBOARDING_HEARING_CATALOG_RELATIVE_PATH,
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('loader returns the required identity set in order', () => {
  const items = loadOnboardingHearingItems();
  const expected = [
    ...STEP0_IDS,
    ...ONBOARDING_PLACEHOLDERS.map((entry) => entry.name),
    ...STEP1B_IDS,
  ];
  assert.deepEqual(
    items.map((item) => item.id),
    expected,
    'catalog item ids drifted from the required identity set',
  );
});

test('placeholder items match ONBOARDING_PLACEHOLDERS names and order', () => {
  const placeholders = loadOnboardingHearingItems().filter(
    (item) => item.kind === 'placeholder',
  );
  assert.deepEqual(
    placeholders.map((item) => item.mapsToPlaceholder),
    ONBOARDING_PLACEHOLDERS.map((entry) => entry.name),
  );
  assert.deepEqual(
    placeholders.map((item) => item.id),
    ONBOARDING_PLACEHOLDERS.map((entry) => entry.name),
  );
});

test('placeholder items match the Final placeholder meanings table', () => {
  const doc = readFileSync(PLACEHOLDERS_DOC, 'utf8');
  const documented = [
    ...doc.matchAll(/^\| `\{\{([A-Z0-9_]+)\}\}`\s+\| (.+?)\s+\|/gmu),
  ].map((row) => row[1]);
  const placeholders = loadOnboardingHearingItems().filter(
    (item) => item.kind === 'placeholder',
  );
  assert.deepEqual(
    placeholders.map((item) => item.mapsToPlaceholder),
    documented,
  );
});

test('every Step 1B id has a matching companion heading', () => {
  const doc = readFileSync(POLICY_DOC, 'utf8');
  const corpus = [
    extractH2Section(
      doc,
      'Decisions that require explicit operator confirmation',
    ),
    extractH2Section(doc, 'Related default policies to confirm'),
  ].join('\n');
  for (const id of STEP1B_IDS) {
    const needle = STEP1B_COMPANION[id];
    assert.ok(
      corpus.includes(needle),
      `Step 1B id ${id} has no companion heading ${needle}`,
    );
  }
});

test('mapsToConfig is present only for mappable Step 1B items', () => {
  for (const item of loadOnboardingHearingItems()) {
    if (DOCS_ONLY_IDS.has(item.id) || item.kind === 'placeholder') {
      assert.equal(
        item.mapsToConfig,
        undefined,
        `${item.id} must stay docs-only / placeholder-mapped`,
      );
      continue;
    }
    assert.ok(
      typeof item.mapsToConfig === 'string' &&
        item.mapsToConfig.startsWith('/'),
      `${item.id} must carry mapsToConfig`,
    );
  }
});

test('derivationHook names existing derive* exports', () => {
  const hooks = loadOnboardingHearingItems()
    .map((item) => item.derivationHook)
    .filter((hook): hook is string => typeof hook === 'string');
  assert.ok(hooks.length > 0, 'expected at least one derivation hook');
  for (const hook of hooks) {
    assert.equal(
      typeof (onboard as Record<string, unknown>)[hook],
      'function',
      `${hook} is not an exported derive* function`,
    );
  }
});

test('loadOnboardingHearingCatalog type-checks the live file', () => {
  const catalog = loadOnboardingHearingCatalog();
  assert.equal(catalog.version, '1.0.0');
  assert.ok(catalog.items.length >= 24);
  assert.equal(catalog.items[0]?.id, 'gh-cli');
});
