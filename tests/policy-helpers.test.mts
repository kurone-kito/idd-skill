import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clone,
  getReviewEscalationChangesRequestedPolicy,
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
  selectDesyncedIndex,
} from '../src/scripts/policy-helpers.mts';

test('issueScope defaults to roadmap-first and accepts all values', () => {
  assert.equal(POLICY_DEFAULTS.issueScope, 'roadmap-first');
  assert.equal(normalizePolicyConfig({}).issueScope, 'roadmap-first');
  assert.equal(
    normalizePolicyConfig({ issueScope: 'roadmap' }).issueScope,
    'roadmap',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'roadmap-first' }).issueScope,
    'roadmap-first',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'orphan-first' }).issueScope,
    'orphan-first',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'bogus' }).issueScope,
    'roadmap-first',
  );
});

test('advisoryWait.convergenceScope defaults to all-prs and accepts idd-claimed', () => {
  assert.equal(POLICY_DEFAULTS.advisoryWait.convergenceScope, 'all-prs');
  assert.equal(
    normalizePolicyConfig({}).advisoryWait.convergenceScope,
    'all-prs',
  );
  assert.equal(
    normalizePolicyConfig({
      advisoryWait: { convergenceScope: 'idd-claimed' },
    }).advisoryWait.convergenceScope,
    'idd-claimed',
  );
  assert.equal(
    normalizePolicyConfig({
      advisoryWait: { convergenceScope: 'bogus' },
    }).advisoryWait.convergenceScope,
    'all-prs',
  );
});

test('POLICY_DEFAULTS.labels exposes the three reserved label name defaults', () => {
  // Additive only (#1272): POLICY_DEFAULTS carries the literal defaults,
  // and normalizePolicyConfig normalizes this namespace too (for shape
  // parity — see its labels branch), but no consuming helper outside
  // policy-helpers.mts reads it yet. Wiring the discover/claim/
  // roadmap-audit label lookups to it is deferred to the follow-up
  // (#1273).
  assert.deepEqual(POLICY_DEFAULTS.labels, {
    roadmapLabelName: 'roadmap',
    blockedByHumanLabelName: 'status:blocked-by-human',
    needsDecisionLabelName: 'status:needs-decision',
  });
});

test('claimTiming.staleAge defaults to PT24H and accepts a configured override', () => {
  // #1310: the canonical single parse point for claimTiming.staleAge, so
  // write-gate callers read it here instead of hand-rolling
  // `config?.claimTiming?.staleAge` access.
  assert.equal(POLICY_DEFAULTS.claimTiming.staleAge, 'PT24H');
  assert.equal(normalizePolicyConfig({}).claimTiming.staleAge, 'PT24H');
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'PT18H' } }).claimTiming
      .staleAge,
    'PT18H',
  );
  // Malformed or non-positive values fall back to the 24h default.
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'not-a-duration' } })
      .claimTiming.staleAge,
    'PT24H',
  );
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'PT0S' } }).claimTiming
      .staleAge,
    'PT24H',
  );
});

test('ciWait.rerunPolicy defaults to rerun-once and accepts hold', () => {
  // #1359: CI_RERUN_POLICIES previously only accepted 'rerun-once',
  // silently downgrading a configured 'hold' — the schema and
  // ci-wait-policy.mts's own RERUN_POLICIES both accept 'hold'.
  assert.equal(POLICY_DEFAULTS.ciWait.rerunPolicy, 'rerun-once');
  assert.equal(normalizePolicyConfig({}).ciWait.rerunPolicy, 'rerun-once');
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'hold' } }).ciWait
      .rerunPolicy,
    'hold',
  );
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'rerun-once' } }).ciWait
      .rerunPolicy,
    'rerun-once',
  );
  // An unrecognized value still falls back to the default.
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'rerun-forever' } }).ciWait
      .rerunPolicy,
    'rerun-once',
  );
});

test('mergeGate.soloCodeownerAdminFallback defaults to auto-admin-retry and accepts hold-and-report (#1521)', () => {
  assert.equal(
    POLICY_DEFAULTS.mergeGate.soloCodeownerAdminFallback,
    'auto-admin-retry',
  );
  assert.equal(
    normalizePolicyConfig({}).mergeGate.soloCodeownerAdminFallback,
    'auto-admin-retry',
  );
  assert.equal(
    normalizePolicyConfig({
      mergeGate: { soloCodeownerAdminFallback: 'hold-and-report' },
    }).mergeGate.soloCodeownerAdminFallback,
    'hold-and-report',
  );
  assert.equal(
    normalizePolicyConfig({
      mergeGate: { soloCodeownerAdminFallback: 'auto-admin-retry' },
    }).mergeGate.soloCodeownerAdminFallback,
    'auto-admin-retry',
  );
  // An unrecognized value falls back to POLICY_DEFAULTS, matching every
  // other enum field normalizePolicyConfig parses (e.g. ciWait.rerunPolicy
  // above) -- it does NOT silently coerce to 'hold-and-report'. A malformed
  // `mergeGate.soloCodeownerAdminFallback` in `.github/idd/config.json` is
  // caught earlier by schema validation (`idd-doctor`/config-schema checks
  // against policy.schema.json's enum), which is the actual safety net
  // against an operator typo; this parser's job is only to never crash on
  // a technically-invalid-but-parseable config.
  assert.equal(
    normalizePolicyConfig({
      mergeGate: { soloCodeownerAdminFallback: 'always-admin' },
    }).mergeGate.soloCodeownerAdminFallback,
    'auto-admin-retry',
  );
});

test('parseIsoDurationToMs parses supported ISO durations', () => {
  assert.equal(parseIsoDurationToMs('PT5S'), 5000);
  assert.equal(parseIsoDurationToMs('PT2H'), 2 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs('P1DT2H'), 26 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs('PT0S'), null);
  assert.equal(parseIsoDurationToMs('invalid'), null);
});

test('changes-requested escalation policy keeps 24h + 24h default windows', () => {
  assert.deepEqual(getReviewEscalationChangesRequestedPolicy({}), {
    escalateAfterMs: 24 * 60 * 60 * 1000,
    releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
  });
});

test('changes-requested escalation overrides map first/second thresholds to two windows', () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT2H',
        changesRequestedSecondEscalation: 'PT6H',
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 4 * 60 * 60 * 1000,
    },
  );
});

test('changes-requested escalation falls back when second threshold is invalid', () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT2H',
        changesRequestedSecondEscalation: 'PT1H',
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
    },
  );
});

test('discover.selectionDesync defaults to off and accepts session-offset', () => {
  assert.equal(POLICY_DEFAULTS.discover.selectionDesync, 'off');
  assert.equal(normalizePolicyConfig({}).discover.selectionDesync, 'off');
  assert.equal(
    normalizePolicyConfig({ discover: { selectionDesync: 'session-offset' } })
      .discover.selectionDesync,
    'session-offset',
  );
  // Unknown value falls back to the default.
  assert.equal(
    normalizePolicyConfig({ discover: { selectionDesync: 'random' } }).discover
      .selectionDesync,
    'off',
  );
});

test('discover.legacyRoots defaults to [] and accepts a valid issue-number array', () => {
  assert.deepEqual(POLICY_DEFAULTS.discover.legacyRoots, []);
  assert.deepEqual(normalizePolicyConfig({}).discover.legacyRoots, []);
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [12, 7, 99] } }).discover
      .legacyRoots,
    [12, 7, 99],
  );
});

test('discover.legacyRoots fails safe to [] on invalid input', () => {
  // Non-array, empty array, and an out-of-range/non-integer entry all fall
  // back to the default `[]` — the whole array is rejected rather than
  // silently dropping just the bad entry, so a typo'd issue number cannot
  // vanish unnoticed.
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: 'not-an-array' } })
      .discover.legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, 0] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, 1.5] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, '2'] } }).discover
      .legacyRoots,
    [],
  );
});

test('selectDesyncedIndex returns 0 for empty, singleton, or invalid bands', () => {
  assert.equal(selectDesyncedIndex('any-token', 0), 0);
  assert.equal(selectDesyncedIndex('any-token', 1), 0);
  assert.equal(selectDesyncedIndex('any-token', -3), 0);
  assert.equal(selectDesyncedIndex('any-token', 2.5), 0);
  assert.equal(selectDesyncedIndex('any-token', 'x'), 0);
});

test('selectDesyncedIndex returns 0 for a non-string or empty token', () => {
  assert.equal(selectDesyncedIndex('', 4), 0);
  assert.equal(selectDesyncedIndex(null, 4), 0);
  assert.equal(selectDesyncedIndex(undefined, 4), 0);
  assert.equal(selectDesyncedIndex(42, 4), 0);
});

test('selectDesyncedIndex is deterministic and stays within the band', () => {
  const bandSize = 5;
  // Same token always maps to the same index.
  assert.equal(
    selectDesyncedIndex('claude-82e2247e', bandSize),
    selectDesyncedIndex('claude-82e2247e', bandSize),
  );
  // Every result is a valid in-band index.
  for (const token of ['a', 'session-1', 'claude-5bee6c1b', 'zzz', '0xdead']) {
    const index = selectDesyncedIndex(token, bandSize);
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < bandSize,
      `index ${index} out of band for ${token}`,
    );
  }
});

test('selectDesyncedIndex spreads distinct session tokens across the band', () => {
  const bandSize = 4;
  // A spread of distinct tokens should not all collapse to a single index;
  // distinct sessions must be able to land on different band offsets.
  const tokens = Array.from({ length: 24 }, (_, i) => `session-token-${i}`);
  const indices = new Set(tokens.map((t) => selectDesyncedIndex(t, bandSize)));
  assert.ok(
    indices.size > 1,
    `expected distinct tokens to spread across the band, got ${[...indices]}`,
  );
});

// #1449: clone() swapped from JSON.parse(JSON.stringify(value)) to
// structuredClone(value). Two-level coverage — a direct clone() assertion
// showing structuredClone preserves an undefined-valued key would only
// prove clone's *isolated* behavior changed, not that callers are
// unaffected. The caller-level test below is the actual proof: the only
// production path that reaches clone(POLICY_DEFAULTS) is
// normalizePolicyConfig's invalid-input branch, and POLICY_DEFAULTS itself
// has no undefined/Date/Map/function property anywhere, so that path's
// observed output is unchanged.
test('normalizePolicyConfig falls back to a structural copy of POLICY_DEFAULTS on invalid input', () => {
  // typeof null === 'object', so null hits the same `clone(POLICY_DEFAULTS)`
  // branch as an array or a non-object primitive.
  assert.deepEqual(normalizePolicyConfig(null), POLICY_DEFAULTS);
  assert.deepEqual(normalizePolicyConfig([]), POLICY_DEFAULTS);
  assert.deepEqual(normalizePolicyConfig('bogus'), POLICY_DEFAULTS);
  // Reference inequality is the actual copy-semantics claim in this test's
  // name: deepEqual alone would also pass if clone() were a no-op identity
  // function returning POLICY_DEFAULTS itself (Copilot review, #1463). Each
  // call must also return its own independent object, not the frozen
  // singleton or a shared instance across calls.
  assert.notEqual(normalizePolicyConfig(null), POLICY_DEFAULTS);
  assert.notEqual(normalizePolicyConfig(null), normalizePolicyConfig(null));
});

test('clone() deep-copies independently of the source, including through undefined-valued keys', () => {
  const source: { a: number; b: undefined; nested: { c: unknown } } = {
    a: 1,
    b: undefined,
    nested: { c: 2 },
  };
  const copy = clone(source);

  // Deep independence is the property every real caller relies on
  // (parsePositiveIntegerArray / parseCheckSelectors hand the clone back
  // to callers who may mutate it): mutating the clone must never reach
  // the source.
  (copy.nested as { c: unknown }).c = 'mutated';
  assert.equal(source.nested.c, 2);

  // structuredClone preserves an undefined-valued key where the old
  // JSON.parse(JSON.stringify(...)) round-trip silently dropped it — this
  // is a genuine, intentional behavior change of clone() in isolation.
  // No real call site is affected: every production call clones either
  // POLICY_DEFAULTS or one of its own frozen sub-arrays, none of which
  // ever contains an undefined-valued key (see the clone() doc comment).
  assert.equal('b' in copy, true);
  assert.equal(copy.b, undefined);
});
