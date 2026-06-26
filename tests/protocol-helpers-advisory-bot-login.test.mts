import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
