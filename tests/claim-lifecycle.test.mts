import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveActiveClaim } from '../src/scripts/protocol-helpers.mts';
import { readJson } from './test-utils.mts';

const fixtures = {
  staleTakeover: readJson('fixtures/claim-lifecycle/stale-takeover.json'),
  sameSecondTieBreak: readJson(
    'fixtures/claim-lifecycle/same-second-tie-break.json',
  ),
  sameSecondInterleaved: readJson(
    'fixtures/claim-lifecycle/same-second-interleaved.json',
  ),
};

test('golden scenario: stale takeover keeps the newer active claim', () => {
  const active = resolveActiveClaim(fixtures.staleTakeover.events);
  assert.deepEqual(active, fixtures.staleTakeover.expectedActiveClaim);
});

test('golden scenario: same-second competing claims use deterministic tie-break', () => {
  const active = resolveActiveClaim(fixtures.sameSecondTieBreak.events);
  assert.deepEqual(active, fixtures.sameSecondTieBreak.expectedActiveClaim);
});

// kurone-kito/idd-skill#3266: an activation-nonce and a plain comment
// interleaved between two same-second competing claims must never change
// which claim-id wins -- the pre-#3266 comparator mixed a claim-id
// comparison into the same comparator used for everything else, which was
// not transitive across a claim/non-claim/claim triple in one second.
test('golden scenario: same-second competing claims with an activation-nonce and a plain comment interleaved still use the deterministic tie-break', () => {
  const active = resolveActiveClaim(fixtures.sameSecondInterleaved.events);
  assert.deepEqual(active, fixtures.sameSecondInterleaved.expectedActiveClaim);
});
