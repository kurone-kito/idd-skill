import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as onboard from '../src/scripts/idd-onboard.mts';
import { ONBOARDING_PLACEHOLDERS } from '../src/scripts/idd-onboard.mts';
import {
  loadOnboardingHearingCatalog,
  loadOnboardingHearingItems,
} from '../src/scripts/onboarding-hearing.mts';
import { ONBOARDING_STEP1B_COMPANIONS } from '../src/scripts/repository-schema-audit.mts';

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

// The live hearing-catalog schema, keyword and document agreements moved out of
// this suite (#3751): `validate-schemas` validates both hearing schemas and the
// live catalog, and `audit-docs --check` runs HEARING-PLACEHOLDER-DOC and
// HEARING-STEP1B-COMPANION. What stays is the loader, order, config-map and
// derivation-hook behavior.

test('the shared Step 1B companion table names exactly the Step 1B ids, in order', () => {
  assert.deepEqual(Object.keys(ONBOARDING_STEP1B_COMPANIONS), [...STEP1B_IDS]);
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
