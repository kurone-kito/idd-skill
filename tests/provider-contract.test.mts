import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertProviderCapabilityDeclaration,
  evaluateProviderCapabilityOutcome,
  isProviderId,
  PROVIDER_CAPABILITY_GROUPS,
  PROVIDER_ERROR_CATEGORIES,
  PROVIDER_IDS,
} from '../src/scripts/provider-contract.mts';

const SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'scripts',
  'provider-contract.mts',
);

test('provider-contract.mts imports nothing -- no child_process, no gh, no GitHub-specific response types (#2265 AC2)', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  assert.ok(
    !/^\s*import\b/m.test(source),
    'provider-contract.mts must have zero import statements',
  );
});

test('PROVIDER_IDS names github, gitlab, and bitbucket; isProviderId is a matching type guard', () => {
  assert.deepEqual(PROVIDER_IDS, ['github', 'gitlab', 'bitbucket']);
  for (const id of PROVIDER_IDS) {
    assert.equal(isProviderId(id), true);
  }
  assert.equal(isProviderId('svn'), false);
  assert.equal(isProviderId(''), false);
  assert.equal(isProviderId(42), false);
  assert.equal(isProviderId(null), false);
  assert.equal(isProviderId(undefined), false);
});

test('PROVIDER_CAPABILITY_GROUPS names the eleven groups from the design record', () => {
  assert.deepEqual(PROVIDER_CAPABILITY_GROUPS, [
    'repository-identity',
    'work-items',
    'comments-and-labels',
    'claims',
    'change-requests',
    'reviews-and-threads',
    'checks',
    'permissions',
    'branch-protection',
    'merge',
    // #2267: bot/advisory review interpretation, distinct from
    // reviews-and-threads's required unresolved-thread safety gate.
    'advisory-review',
  ]);
});

test('PROVIDER_ERROR_CATEGORIES names eight provider-neutral categories', () => {
  assert.deepEqual(PROVIDER_ERROR_CATEGORIES, [
    'authentication',
    'authorization',
    'not-found',
    'rate-limited',
    'conflict',
    'validation',
    'unavailable',
    'unknown',
  ]);
});

test('evaluateProviderCapabilityOutcome: a supported capability is always ok, required or optional (#2265)', () => {
  assert.equal(
    evaluateProviderCapabilityOutcome({
      group: 'merge',
      requirement: 'required',
      supported: true,
    }),
    'ok',
  );
  assert.equal(
    evaluateProviderCapabilityOutcome({
      group: 'checks',
      requirement: 'optional',
      supported: true,
    }),
    'ok',
  );
});

test('evaluateProviderCapabilityOutcome: an unsupported required capability fails closed, never a silent pass (#2265)', () => {
  assert.equal(
    evaluateProviderCapabilityOutcome({
      group: 'branch-protection',
      requirement: 'required',
      supported: false,
    }),
    'fail_closed',
  );
});

test('evaluateProviderCapabilityOutcome: an unsupported optional capability resolves not_applicable, distinct from ok (#2265)', () => {
  assert.equal(
    evaluateProviderCapabilityOutcome({
      group: 'reviews-and-threads',
      requirement: 'optional',
      supported: false,
    }),
    'not_applicable',
  );
});

test('assertProviderCapabilityDeclaration accepts a well-formed declaration and narrows its type', () => {
  const declaration = assertProviderCapabilityDeclaration({
    group: 'claims',
    requirement: 'required',
    supported: true,
  });
  assert.deepEqual(declaration, {
    group: 'claims',
    requirement: 'required',
    supported: true,
  });
});

test('assertProviderCapabilityDeclaration rejects a malformed capability policy deterministically (#2265 AC3)', () => {
  assert.throws(() => assertProviderCapabilityDeclaration(null), TypeError);
  assert.throws(() => assertProviderCapabilityDeclaration([]), TypeError);
  assert.throws(
    () => assertProviderCapabilityDeclaration('required'),
    TypeError,
  );
  assert.throws(
    () =>
      assertProviderCapabilityDeclaration({
        group: 'not-a-real-group',
        requirement: 'required',
        supported: true,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      assertProviderCapabilityDeclaration({
        group: 'merge',
        requirement: 'mandatory',
        supported: true,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      assertProviderCapabilityDeclaration({
        group: 'merge',
        requirement: 'required',
        supported: 'yes',
      }),
    TypeError,
  );
});
