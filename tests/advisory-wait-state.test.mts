import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseArgs } from '../src/scripts/advisory-wait-state.mts';

// This file previously had no parse-level coverage at all (#1450: roughly
// 30 of the repository's parsers were in that state before this issue).
// It only tests the #1446 shared cli-args.mts wrapper migration; the
// business-logic summary building (buildAdvisoryWaitSummary et al.) is
// covered via protocol-helpers.test.mts.

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses --pr, --owner, --repo, --trusted-marker-logins, and --now', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--trusted-marker-logins',
    'a,b',
    '--now',
    '2026-07-17T00:00:00Z',
  ]);
  assert.equal(args.prNumber, 42);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
  assert.equal(args.trustedMarkerLogins, 'a,b');
  assert.equal(args.now, '2026-07-17T00:00:00Z');
  assert.equal(args.help, false);
});

test('parseArgs: an invalid --pr resolves to null (fails closed at the caller)', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

test('parseArgs: an absent --pr also resolves to null', () => {
  const args = parseArgs([]);
  assert.equal(args.prNumber, null);
});

test('parseArgs: a missing --pr value throws', () => {
  assert.throws(() => parseArgs(['--pr']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --owner would greedily accept '--now' as its literal
  // value, silently leaving --now unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--pr', '42', '--owner', '--now']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});
