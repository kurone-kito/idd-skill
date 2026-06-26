import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isConfiguredAdvisoryBotLogin,
  isGateAdvisoryBotLogin,
  normalizeTrustedMarkerLogins,
} from '../src/scripts/protocol-helpers.mts';

// Build the advisory-bot set exactly as the gate callers do, so the test
// exercises the real construction path rather than a hand-rolled Set.
const buildSet = (logins: string[]): Set<string> =>
  new Set(normalizeTrustedMarkerLogins(logins));

test('isGateAdvisoryBotLogin matches a custom bot across the [bot] suffix cross-product', () => {
  // config stores the suffixless form
  const suffixlessConfig = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('my-bot', suffixlessConfig), true);
  assert.equal(isGateAdvisoryBotLogin('my-bot[bot]', suffixlessConfig), true);

  // config stores the suffixed form
  const suffixedConfig = buildSet(['my-bot[bot]']);
  assert.equal(isGateAdvisoryBotLogin('my-bot', suffixedConfig), true);
  assert.equal(isGateAdvisoryBotLogin('my-bot[bot]', suffixedConfig), true);
});

test('isGateAdvisoryBotLogin normalizes case and surrounding whitespace', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('  My-Bot[BOT] ', config), true);
});

test('isGateAdvisoryBotLogin keeps the CodeRabbit/Codex/Copilot defaults working', () => {
  const empty = buildSet([]);
  for (const login of [
    'coderabbitai',
    'coderabbitai[bot]',
    'chatgpt-codex-connector',
    'chatgpt-codex-connector[bot]',
    'copilot-pull-request-reviewer[bot]',
  ]) {
    assert.equal(
      isGateAdvisoryBotLogin(login, empty),
      true,
      `default review bot should match: ${login}`,
    );
  }
});

test('isGateAdvisoryBotLogin rejects unconfigured and empty logins', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('some-human', config), false);
  assert.equal(isGateAdvisoryBotLogin('other-bot[bot]', config), false);
  assert.equal(isGateAdvisoryBotLogin('', config), false);
  assert.equal(isGateAdvisoryBotLogin(null, config), false);
  assert.equal(isGateAdvisoryBotLogin(undefined, config), false);
  // A bare `[bot]` reduces to an empty token and must not match.
  assert.equal(isGateAdvisoryBotLogin('[bot]', config), false);
});

test('isConfiguredAdvisoryBotLogin matches a custom bot across the [bot] suffix cross-product', () => {
  // config stores the suffixless form
  const suffixlessConfig = buildSet(['my-bot']);
  assert.equal(isConfiguredAdvisoryBotLogin('my-bot', suffixlessConfig), true);
  assert.equal(
    isConfiguredAdvisoryBotLogin('my-bot[bot]', suffixlessConfig),
    true,
  );

  // config stores the suffixed form
  const suffixedConfig = buildSet(['my-bot[bot]']);
  assert.equal(isConfiguredAdvisoryBotLogin('my-bot', suffixedConfig), true);
  assert.equal(
    isConfiguredAdvisoryBotLogin('my-bot[bot]', suffixedConfig),
    true,
  );

  // case and surrounding whitespace are normalized like the gate callers expect
  assert.equal(
    isConfiguredAdvisoryBotLogin('  My-Bot[BOT] ', suffixlessConfig),
    true,
  );
});

test('isConfiguredAdvisoryBotLogin matches ONLY configured bots, not known review bots', () => {
  // Unlike isGateAdvisoryBotLogin, the ack-only carve-out predicate must not
  // fold in the CodeRabbit/Codex/Copilot defaults: a known-review-bot ack must
  // never be reclassified as a configured-advisory-bot courtesy ack.
  const empty = buildSet([]);
  for (const login of [
    'coderabbitai',
    'coderabbitai[bot]',
    'chatgpt-codex-connector[bot]',
    'copilot-pull-request-reviewer[bot]',
  ]) {
    assert.equal(
      isConfiguredAdvisoryBotLogin(login, empty),
      false,
      `known review bot must not match when unconfigured: ${login}`,
    );
    // isGateAdvisoryBotLogin still folds the same default in — the two
    // predicates intentionally differ on exactly this class.
    assert.equal(isGateAdvisoryBotLogin(login, empty), true);
  }
  // It does match a known review bot once that bot is explicitly configured.
  assert.equal(
    isConfiguredAdvisoryBotLogin(
      'coderabbitai[bot]',
      buildSet(['coderabbitai']),
    ),
    true,
  );
});

test('isConfiguredAdvisoryBotLogin rejects unconfigured and empty logins', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isConfiguredAdvisoryBotLogin('some-human', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin('other-bot[bot]', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin('', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin(null, config), false);
  assert.equal(isConfiguredAdvisoryBotLogin(undefined, config), false);
  // A bare `[bot]` reduces to an empty token and must not match.
  assert.equal(isConfiguredAdvisoryBotLogin('[bot]', config), false);
});
