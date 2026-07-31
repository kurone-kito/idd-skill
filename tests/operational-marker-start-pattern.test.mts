import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPERATIONAL_MARKERS } from '../src/scripts/marker-helpers.mts';

// #1720: `startPattern` is now a required field on every `OPERATIONAL_MARKERS`
// entry, replacing `operationalMarkerPrefixByStart()`'s old case-sensitive
// `normalized.startsWith(candidate.label)` fallback. These tests protect the
// two invariants a future entry (or a hand-edit of an existing one) could
// silently violate without either failing to compile or failing an existing
// test: case-flag parity with `pattern`, and correspondence with the
// entry's own `label` (as opposed to some other entry's).

test('every OPERATIONAL_MARKERS entry carries the same /i flag on pattern and startPattern', () => {
  for (const marker of OPERATIONAL_MARKERS) {
    assert.equal(
      marker.startPattern.flags.includes('i'),
      marker.pattern.flags.includes('i'),
      `${marker.label}: pattern flags "${marker.pattern.flags}" vs startPattern flags "${marker.startPattern.flags}"`,
    );
  }
});

test('every OPERATIONAL_MARKERS entry startPattern is ^-anchored and not global or sticky', () => {
  for (const marker of OPERATIONAL_MARKERS) {
    assert.ok(
      marker.startPattern.source.startsWith('^'),
      `${marker.label}: startPattern "${marker.startPattern.source}" must anchor at ^`,
    );
    // A `g`- or `y`-flagged RegExp is `lastIndex`-stateful across repeated
    // `.test()` calls in `OPERATIONAL_MARKERS.find(...)` -- a shared
    // instance reused across many `operationalMarkerPrefixByStart()` calls
    // would then give inconsistent results depending on call history.
    // Sticky (`/y`) is the same hazard as global (`/g`) here: both advance
    // `lastIndex` on a match, they just differ in where the match is
    // required to start.
    assert.equal(
      marker.startPattern.global,
      false,
      `${marker.label}: startPattern must not carry the /g flag`,
    );
    assert.equal(
      marker.startPattern.sticky,
      false,
      `${marker.label}: startPattern must not carry the /y flag`,
    );
  }
});

test('every OPERATIONAL_MARKERS entry startPattern matches its own label and no other entry label', () => {
  for (const marker of OPERATIONAL_MARKERS) {
    assert.ok(
      marker.startPattern.test(marker.label),
      `${marker.label}: startPattern must match its own label`,
    );
    for (const other of OPERATIONAL_MARKERS) {
      if (other === marker) {
        continue;
      }
      assert.equal(
        marker.startPattern.test(other.label),
        false,
        `${marker.label}: startPattern must not match ${other.label}`,
      );
    }
  }
});
