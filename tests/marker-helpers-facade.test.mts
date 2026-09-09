import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as direct from '../src/scripts/marker-helpers.mts';
import * as facade from '../src/scripts/protocol-helpers.mts';

// Wave 1 of the protocol-helpers split (#1209) moved every operational-marker
// render/parse primitive into marker-helpers.mts and made protocol-helpers.mts
// re-export all of it (`export * from './marker-helpers.mts'`) so existing
// call sites keep importing from '../src/scripts/protocol-helpers.mts'
// unchanged. This test is the facade-identity assertion the issue's
// acceptance criteria calls for: a sample of moved names, imported from BOTH
// paths, must resolve to the exact same binding -- proving a re-export, not a
// duplicated copy that could drift.
const SAMPLE_NAMES = [
  'parseClaimComment',
  'parseReleaseComment',
  'renderClaimedByMarker',
  'renderUnclaimedByMarker',
  'renderActivationNonceMarker',
  'parseActivationNonceComment',
  'findActivationNonceWinner',
  'renderReviewWatermarkMarker',
  'renderReviewBaselineMarker',
  'renderAdvisoryWaitMarker',
  'renderAdvisoryWaitRecoveryMarker',
  'parseAdvisoryRecoveryComment',
  'renderCopilotUnavailableMarker',
  'parseCopilotUnavailableComment',
  'parseForcedHandoffComment',
  'normalizeForcedHandoffPayload',
  'renderForcedHandoffComment',
  'renderForcedHandoffConsentNote',
  'renderExternalCheckWaiverComment',
  'parseExternalCheckWaiverComment',
  'renderProviderOutageDeclarationComment',
  'parseProviderOutageDeclarationComment',
  'renderProviderOutageAdvancedComment',
  'parseProviderOutageAdvancedComment',
  'renderProviderOutageParkComment',
  'parseProviderOutageParkComment',
  'parseReviewWatermarkComment',
  'operationalMarkerPrefix',
  'operationalMarkerPrefixByStart',
  'detectMalformedOperationalMarker',
  'IDD_AGENT_DERIVED_MARKERS',
  'isValidIsoTimestamp',
  'OPERATIONAL_MARKERS',
  'REVIEW_REPLY_STAMP_SUFFIX',
  'hasReviewReplyStamp',
  'appendReviewReplyStamp',
  'isIddOriginatedReply',
] as const;

test('protocol-helpers re-exports every sampled marker-helpers name by identity', () => {
  for (const name of SAMPLE_NAMES) {
    const viaFacade = (facade as Record<string, unknown>)[name];
    const viaDirect = (direct as Record<string, unknown>)[name];
    assert.notStrictEqual(
      viaDirect,
      undefined,
      `marker-helpers.mts must export ${name}`,
    );
    assert.strictEqual(
      viaFacade,
      viaDirect,
      `protocol-helpers.mts's ${name} must be the same binding as marker-helpers.mts's (re-export, not a copy)`,
    );
  }
});

// #2752: guards against the drift issue #1705 hit -- a new marker family
// shipped with zero hide-at-post-time wiring and zero record of that gap,
// so F4 cleanup silently missed it. This asserts every OPERATIONAL_MARKERS
// entry has exactly one MARKER_HIDE_POLICY classification: a future new
// entry with no classification fails this test instead of drifting quietly.
// (A `policyLabels.length === new Set(policyLabels).size` duplicate check
// was considered here and dropped: `MARKER_HIDE_POLICY.keys()` can never
// contain a duplicate -- Map key sets are unique by construction -- so
// that comparison could never fail here. A duplicate label in the *source*
// array is instead caught at construction time by
// `buildMarkerHidePolicyMap` throwing, exercised directly below -- a
// duplicate that still names every required label would otherwise pass
// this coverage check silently, since it only verifies label-set
// membership, not per-label uniqueness in the source array. Caught by
// chatgpt-codex-connector review on PR #2759.)
test('MARKER_HIDE_POLICY classifies every OPERATIONAL_MARKERS entry exactly once', () => {
  const markerLabels = direct.OPERATIONAL_MARKERS.map((marker) => marker.label);
  const policyLabels = [...direct.MARKER_HIDE_POLICY.keys()];

  assert.deepStrictEqual(
    new Set(policyLabels),
    new Set(markerLabels),
    'MARKER_HIDE_POLICY must classify exactly the OPERATIONAL_MARKERS label set (no missing, no stale, no extra entries)',
  );

  for (const marker of direct.OPERATIONAL_MARKERS) {
    const entry = direct.MARKER_HIDE_POLICY.get(marker.label);
    assert.ok(
      entry,
      `MARKER_HIDE_POLICY is missing a classification for ${marker.label}`,
    );
    assert.match(
      entry.policy,
      /^(wired|f4-only|excluded)$/,
      `${marker.label}: unexpected hide-policy kind "${entry.policy}"`,
    );
    assert.ok(
      entry.reason.trim().length > 0,
      `${marker.label}: hide-policy entry must carry a non-empty reason`,
    );
  }
});

// #2759 (chatgpt-codex-connector review): a duplicate `label` in the source
// entries must fail loudly at construction time, not silently let the later
// row win. Exercises `buildMarkerHidePolicyMap` directly with a synthetic
// duplicate so this does not require corrupting the real production entries.
test('buildMarkerHidePolicyMap throws on a duplicate label', () => {
  assert.throws(
    () =>
      direct.buildMarkerHidePolicyMap([
        { label: '<!-- dup:', policy: 'f4-only', reason: 'first' },
        { label: '<!-- dup:', policy: 'wired', reason: 'second' },
      ]),
    /duplicate.*label/i,
    'buildMarkerHidePolicyMap must reject two entries sharing the same label',
  );
});

// #2759 (chatgpt-codex-connector review): `ReadonlyMap<K, V>` is a
// compile-time-only guard -- `Object.freeze` on a `Map` instance does not
// stop `Map#set`/`#delete`/`#clear` at runtime, so this asserts the actual
// exported object rejects mutation, not just its declared type.
test('MARKER_HIDE_POLICY rejects runtime mutation', () => {
  const mutable = direct.MARKER_HIDE_POLICY as unknown as Map<string, unknown>;
  const sizeBefore = direct.MARKER_HIDE_POLICY.size;

  assert.throws(() => mutable.set('<!-- injected:', {}), TypeError);
  assert.throws(() => mutable.delete('<!-- claimed-by:'), TypeError);
  assert.throws(() => mutable.clear(), TypeError);
  assert.strictEqual(
    direct.MARKER_HIDE_POLICY.size,
    sizeBefore,
    'a failed mutation attempt must not change the map contents',
  );
  assert.strictEqual(
    direct.MARKER_HIDE_POLICY.get('<!-- claimed-by:')?.policy,
    'wired',
    'read access must keep working after rejected mutation attempts',
  );
});

// #2759 E10 self-critique: `Map#forEach`'s native implementation invokes the
// callback with its own receiver as the third argument, so naively binding
// `forEach` to the real underlying `Map` (as every other read method is
// bound) would hand callers that mutable `Map` as `forEach`'s third
// argument -- an escape hatch around the freeze above. Asserts the third
// argument is the frozen lookup itself, not the raw map, and that trying to
// mutate through it still throws.
test('MARKER_HIDE_POLICY.forEach never exposes the underlying mutable map', () => {
  let sawThirdArg = false;
  direct.MARKER_HIDE_POLICY.forEach((_value, _key, mapArg) => {
    sawThirdArg = true;
    assert.strictEqual(
      mapArg,
      direct.MARKER_HIDE_POLICY,
      "forEach's third argument must be the frozen lookup, not the raw map",
    );
    const mutableArg = mapArg as unknown as Map<string, unknown>;
    assert.throws(
      () => mutableArg.set('<!-- injected-via-forEach:', {}),
      TypeError,
    );
  });
  assert.ok(sawThirdArg, 'forEach must invoke its callback at least once');
});
