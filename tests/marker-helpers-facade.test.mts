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
  'renderReviewWatermarkMarker',
  'renderReviewBaselineMarker',
  'renderAdvisoryWaitMarker',
  'renderAdvisoryWaitRecoveryMarker',
  'parseForcedHandoffComment',
  'normalizeForcedHandoffPayload',
  'renderForcedHandoffComment',
  'renderForcedHandoffConsentNote',
  'renderExternalCheckWaiverComment',
  'parseExternalCheckWaiverComment',
  'parseReviewWatermarkComment',
  'operationalMarkerPrefix',
  'operationalMarkerPrefixByStart',
  'detectMalformedOperationalMarker',
  'IDD_AGENT_DERIVED_MARKERS',
  'isValidIsoTimestamp',
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
