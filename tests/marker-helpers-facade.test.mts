import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as direct from '../src/scripts/marker-helpers.mts';
import {
  MARKER_HIDE_POLICY,
  OPERATIONAL_MARKERS,
} from '../src/scripts/marker-helpers.mts';
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
test('MARKER_HIDE_POLICY classifies every OPERATIONAL_MARKERS entry exactly once', () => {
  const markerLabels = OPERATIONAL_MARKERS.map((marker) => marker.label);
  const policyLabels = [...MARKER_HIDE_POLICY.keys()];

  assert.strictEqual(
    policyLabels.length,
    new Set(policyLabels).size,
    'MARKER_HIDE_POLICY must not carry duplicate labels',
  );
  assert.deepStrictEqual(
    new Set(policyLabels),
    new Set(markerLabels),
    'MARKER_HIDE_POLICY must classify exactly the OPERATIONAL_MARKERS label set (no missing, no stale, no extra entries)',
  );

  for (const marker of OPERATIONAL_MARKERS) {
    const entry = MARKER_HIDE_POLICY.get(marker.label);
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
