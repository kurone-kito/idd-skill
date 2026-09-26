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

// kurone-kito/idd-skill#3248: a trusted claimed-by marker with an absent
// lastEditedAt (the caller never resolved edit state) must fail loudly
// rather than silently resolving to "no active claim" -- an unreadable
// edit state is not evidence the issue is unclaimed.
test('resolveActiveClaim throws on a trusted claim-family marker whose edit state is unresolved (absent lastEditedAt)', () => {
  const events = [
    {
      author: { login: 'trusted-actor' },
      body: '<!-- claimed-by: trusted-actor claim-1 supersedes: none 2026-05-10T00:00:00Z branch: issue/1-fix -->\n\n_trusted-actor: issue claim - IDD automation marker. Do not edit._',
      createdAt: '2026-05-10T00:00:00Z',
      // lastEditedAt intentionally omitted.
    },
  ];
  assert.throws(() => resolveActiveClaim(events, () => true));
});

// kurone-kito/idd-skill#3248: an edited trusted claimed-by marker is
// ignored exactly like an untrusted comment, so the earlier claim (whose
// own release attempt never lands, because that release comment is also
// edited and dropped the same way) stays active.
test('resolveActiveClaim ignores an edited trusted claimed-by marker the same way it ignores an untrusted one', () => {
  const firstClaim = {
    author: { login: 'trusted-actor' },
    body: '<!-- claimed-by: trusted-actor claim-1 supersedes: none 2026-05-10T00:00:00Z branch: issue/1-fix -->\n\n_trusted-actor: issue claim - IDD automation marker. Do not edit._',
    createdAt: '2026-05-10T00:00:00Z',
    lastEditedAt: null,
  };
  const editedTakeover = {
    author: { login: 'trusted-actor' },
    body: '<!-- claimed-by: trusted-actor claim-2 supersedes: claim-1 2026-05-11T00:00:00Z branch: issue/1-fix -->\n\n_trusted-actor: issue claim - IDD automation marker. Do not edit._',
    createdAt: '2026-05-11T00:00:00Z',
    // Body-edited after posting: must be ignored, not honored as a
    // takeover, regardless of how old firstClaim's own createdAt is.
    lastEditedAt: '2026-05-11T00:05:00Z',
  };
  const withEditedEvent = resolveActiveClaim(
    [firstClaim, editedTakeover],
    () => true,
  );
  const withoutEditedEvent = resolveActiveClaim([firstClaim], () => true);
  assert.deepEqual(withEditedEvent, withoutEditedEvent);
  assert.equal(withEditedEvent?.claimId, 'claim-1');
});

// kurone-kito/idd-skill#3248: the F4 hide-on-supersede minimization path
// (`minimizeComment`) advances `updatedAt` while leaving `lastEditedAt`
// `null` (kurone-kito/idd-skill#3173) -- that minimized shape must still
// resolve as unedited, never as unknown or edited.
test('resolveActiveClaim honors a claim-family marker whose lastEditedAt is null even when updatedAt is later than createdAt (minimized shape)', () => {
  const events = [
    {
      author: { login: 'trusted-actor' },
      body: '<!-- claimed-by: trusted-actor claim-1 supersedes: none 2026-05-10T00:00:00Z branch: issue/1-fix -->\n\n_trusted-actor: issue claim - IDD automation marker. Do not edit._',
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-12T00:00:00Z',
      lastEditedAt: null,
    },
  ];
  const active = resolveActiveClaim(events, () => true);
  assert.equal(active?.claimId, 'claim-1');
});
