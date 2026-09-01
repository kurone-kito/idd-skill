import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clone,
  getReviewEscalationChangesRequestedPolicy,
  inspectCritiqueLoopDelegateLayer,
  inspectDevelopmentBranch,
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
  resolveEffectiveCritiqueLoopDelegate,
  resolveEffectiveDevelopmentBranch,
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

test('advisoryWait.exemptBotAuthoredPrs defaults to false and only a literal true opts in (#1906)', () => {
  assert.equal(POLICY_DEFAULTS.advisoryWait.exemptBotAuthoredPrs, false);
  assert.equal(
    normalizePolicyConfig({}).advisoryWait.exemptBotAuthoredPrs,
    false,
  );
  assert.equal(
    normalizePolicyConfig({
      advisoryWait: { exemptBotAuthoredPrs: true },
    }).advisoryWait.exemptBotAuthoredPrs,
    true,
  );
  assert.equal(
    normalizePolicyConfig({
      advisoryWait: { exemptBotAuthoredPrs: 'true' },
    }).advisoryWait.exemptBotAuthoredPrs,
    false,
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

test('discover.milestoneScope defaults to off (empty string) and accepts a configured value', () => {
  assert.equal(POLICY_DEFAULTS.discover.milestoneScope, '');
  // Absence disables the preference entirely.
  assert.equal(normalizePolicyConfig({}).discover.milestoneScope, '');
  assert.equal(
    normalizePolicyConfig({ discover: { milestoneScope: 'v0.8.0' } }).discover
      .milestoneScope,
    'v0.8.0',
  );
  // An explicit empty string yields the same off state as absence.
  assert.equal(
    normalizePolicyConfig({ discover: { milestoneScope: '' } }).discover
      .milestoneScope,
    '',
  );
  // A non-string value is rejected deterministically -- falls back to the
  // off default rather than throwing or coercing to a truthy string.
  assert.equal(
    normalizePolicyConfig({ discover: { milestoneScope: 42 } }).discover
      .milestoneScope,
    '',
  );
  assert.equal(
    normalizePolicyConfig({ discover: { milestoneScope: ['v0.8.0'] } }).discover
      .milestoneScope,
    '',
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

test('providerOutage.declarationTarget is absent (own-property-omitted) when unconfigured, disabling the declaration path (#2320)', () => {
  assert.equal(
    Object.hasOwn(POLICY_DEFAULTS.providerOutage, 'declarationTarget'),
    false,
  );
  assert.equal(
    normalizePolicyConfig({}).providerOutage.declarationTarget,
    undefined,
  );
  assert.equal(
    Object.hasOwn(
      normalizePolicyConfig({}).providerOutage,
      'declarationTarget',
    ),
    false,
  );
});

test('providerOutage.declarationTarget accepts a positive integer issue number (#2320)', () => {
  assert.equal(
    normalizePolicyConfig({ providerOutage: { declarationTarget: 2318 } })
      .providerOutage.declarationTarget,
    2318,
  );
});

test('providerOutage.declarationTarget fails safe to absent on an invalid value (#2320)', () => {
  for (const invalid of [0, -1, 1.5, '2318', null, [2318]]) {
    assert.equal(
      normalizePolicyConfig({ providerOutage: { declarationTarget: invalid } })
        .providerOutage.declarationTarget,
      undefined,
      `expected declarationTarget ${JSON.stringify(invalid)} to fail safe to absent`,
    );
  }
});

test('providerOutage.maxValidity defaults to PT24H and accepts a configured override (#2320)', () => {
  assert.equal(POLICY_DEFAULTS.providerOutage.maxValidity, 'PT24H');
  assert.equal(normalizePolicyConfig({}).providerOutage.maxValidity, 'PT24H');
  assert.equal(
    normalizePolicyConfig({ providerOutage: { maxValidity: 'PT12H' } })
      .providerOutage.maxValidity,
    'PT12H',
  );
  assert.equal(
    normalizePolicyConfig({ providerOutage: { maxValidity: 'not-a-duration' } })
      .providerOutage.maxValidity,
    'PT24H',
  );
});

test('critiqueLoop.delegate resolves to undefined when absent (#2199)', () => {
  assert.equal(normalizePolicyConfig({}).critiqueLoop.delegate, undefined);
});

test('critiqueLoop.delegate resolves a valid command, defaulting mode to fallback (#2199)', () => {
  assert.deepEqual(
    normalizePolicyConfig({
      critiqueLoop: { delegate: { command: 'coderabbit review --plain' } },
    }).critiqueLoop.delegate,
    { command: 'coderabbit review --plain', mode: 'fallback' },
  );
});

test('critiqueLoop.delegate preserves an explicit combined mode (#2199)', () => {
  assert.deepEqual(
    normalizePolicyConfig({
      critiqueLoop: {
        delegate: { command: 'coderabbit review --plain', mode: 'combined' },
      },
    }).critiqueLoop.delegate,
    { command: 'coderabbit review --plain', mode: 'combined' },
  );
});

test('critiqueLoop.delegate fails safe to undefined on a missing or empty command (#2199)', () => {
  assert.equal(
    normalizePolicyConfig({ critiqueLoop: { delegate: {} } }).critiqueLoop
      .delegate,
    undefined,
  );
  assert.equal(
    normalizePolicyConfig({ critiqueLoop: { delegate: { command: '' } } })
      .critiqueLoop.delegate,
    undefined,
  );
  assert.equal(
    normalizePolicyConfig({
      critiqueLoop: { delegate: { command: 123 } },
    }).critiqueLoop.delegate,
    undefined,
  );
  assert.equal(
    normalizePolicyConfig({ critiqueLoop: { delegate: 'not-an-object' } })
      .critiqueLoop.delegate,
    undefined,
  );
  // Whitespace-only command: mirrors worktreeGuard.branchPatterns' `\S`
  // schema rejection so a normalizePolicyConfig caller cannot accept a
  // configuration the schema would reject (#2207 review).
  assert.equal(
    normalizePolicyConfig({ critiqueLoop: { delegate: { command: '   ' } } })
      .critiqueLoop.delegate,
    undefined,
  );
});

test('critiqueLoop.delegate fails safe to undefined on an unknown property (#2207 review)', () => {
  // Mirrors parseCheckSelectors' exact-key-set rejection: the schema's
  // additionalProperties: false already rejects an unrecognized key, and
  // the resolver must reject the same shape for a direct
  // normalizePolicyConfig caller that bypasses schema validation.
  assert.equal(
    normalizePolicyConfig({
      critiqueLoop: { delegate: { command: 'coderabbit review', bogus: 1 } },
    }).critiqueLoop.delegate,
    undefined,
  );
});

test('critiqueLoop.delegate fails safe to undefined on an inherited (non-own) command property (#2207 review)', () => {
  // A plain property read (candidate.command) walks the prototype chain
  // even though Object.keys() only sees own properties -- a crafted
  // object with `command` supplied via its prototype must be rejected
  // the same as a genuinely missing command, not silently accepted.
  const proto = { command: 'evil-inherited-command' };
  const candidate = Object.create(proto);
  candidate.mode = 'fallback';
  assert.equal(
    normalizePolicyConfig({ critiqueLoop: { delegate: candidate } })
      .critiqueLoop.delegate,
    undefined,
  );
});

test('critiqueLoop.delegate ignores an inherited (non-own) mode property, defaulting to fallback (#2207 review)', () => {
  const proto = { mode: 'combined' };
  const candidate = Object.create(proto);
  candidate.command = 'coderabbit review --plain';
  assert.deepEqual(
    normalizePolicyConfig({ critiqueLoop: { delegate: candidate } })
      .critiqueLoop.delegate,
    { command: 'coderabbit review --plain', mode: 'fallback' },
  );
});

test('critiqueLoop.delegate is absent (not an own key) when unconfigured, matching POLICY_DEFAULTS (#2207 review)', () => {
  // POLICY_DEFAULTS never carries an undefined-valued property (see the
  // clone() doc comment) -- the resolved object must match that shape
  // exactly, not merely resolve `.delegate` to `undefined` via a missing
  // lookup.
  assert.equal(
    Object.hasOwn(normalizePolicyConfig({}).critiqueLoop, 'delegate'),
    false,
  );
  assert.equal(Object.hasOwn(POLICY_DEFAULTS.critiqueLoop, 'delegate'), false);
});

test('inspectCritiqueLoopDelegateLayer distinguishes absent, disabled, configured, and malformed (#2257)', () => {
  assert.deepEqual(inspectCritiqueLoopDelegateLayer({}), { status: 'absent' });
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({ critiqueLoop: { delegate: null } }),
    { status: 'disabled' },
  );
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({
      critiqueLoop: { delegate: { command: 'coderabbit review --plain' } },
    }),
    {
      status: 'configured',
      delegate: { command: 'coderabbit review --plain', mode: 'fallback' },
    },
  );
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({
      critiqueLoop: { delegate: { command: 'coderabbit review', bogus: 1 } },
    }),
    {
      status: 'malformed',
      reason: 'invalid-repository-local-delegate',
    },
  );
});

test('normalizePolicyConfig still fail-safes a local null delegate to absent (#2257)', () => {
  // CI/merge helpers keep the pre-#2257 collapse; only the opt-in layered
  // resolver treats JSON null as the disable sentinel.
  assert.equal(
    Object.hasOwn(
      normalizePolicyConfig({ critiqueLoop: { delegate: null } }).critiqueLoop,
      'delegate',
    ),
    false,
  );
});

test('resolveEffectiveCritiqueLoopDelegate prefers a local object over a global object (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: {
      critiqueLoop: { delegate: { command: 'local-review' } },
    },
    globalConfig: {
      critiqueLoop: {
        delegate: { command: 'global-review', mode: 'combined' },
      },
    },
  });
  assert.deepEqual(result, {
    status: 'local',
    source: 'repository-local',
    delegate: { command: 'local-review', mode: 'fallback' },
  });
});

test('resolveEffectiveCritiqueLoopDelegate honors local JSON null over a valid global object (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: { critiqueLoop: { delegate: null } },
    globalConfig: {
      critiqueLoop: { delegate: { command: 'global-review' } },
    },
  });
  assert.deepEqual(result, {
    status: 'disabled',
    source: 'repository-local',
  });
});

test('resolveEffectiveCritiqueLoopDelegate inherits a global object when local is absent (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: {},
    globalConfig: {
      mergePolicy: 'must-not-leak',
      critiqueLoop: {
        delegate: { command: 'global-review', mode: 'combined' },
      },
    },
  });
  assert.deepEqual(result, {
    status: 'global',
    source: 'user-global',
    delegate: { command: 'global-review', mode: 'combined' },
  });
});

test('resolveEffectiveCritiqueLoopDelegate fails closed on a malformed local delegate (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: {
      critiqueLoop: { delegate: { command: 'local-review', bogus: 1 } },
    },
    globalConfig: {
      critiqueLoop: { delegate: { command: 'global-review' } },
    },
  });
  assert.deepEqual(result, {
    status: 'local-malformed',
    source: 'repository-local',
    reason: 'invalid-repository-local-delegate',
  });
});

test('resolveEffectiveCritiqueLoopDelegate fails closed on a non-object local critiqueLoop (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: { critiqueLoop: 'not-an-object' },
    globalConfig: {
      critiqueLoop: { delegate: { command: 'global-review' } },
    },
  });
  assert.deepEqual(result, {
    status: 'local-malformed',
    source: 'repository-local',
    reason: 'invalid-repository-local-delegate',
  });
});

test('inspectCritiqueLoopDelegateLayer treats an explicit invalid mode as malformed (#2257)', () => {
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({
      critiqueLoop: {
        delegate: { command: 'review', mode: 'always' },
      },
    }),
    {
      status: 'malformed',
      reason: 'invalid-repository-local-delegate',
    },
  );
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({
      critiqueLoop: {
        delegate: { command: 'review', mode: 1 },
      },
    }),
    {
      status: 'malformed',
      reason: 'invalid-repository-local-delegate',
    },
  );
});

test('resolveEffectiveCritiqueLoopDelegate does not inherit a global invalid mode (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: {},
    globalConfig: {
      critiqueLoop: {
        delegate: { command: 'global-review', mode: 'always' },
      },
    },
  });
  assert.deepEqual(result, { status: 'none', source: 'none' });
});

test('normalizePolicyConfig still fail-safes an invalid explicit mode to fallback (#2199)', () => {
  assert.deepEqual(
    normalizePolicyConfig({
      critiqueLoop: {
        delegate: { command: 'review', mode: 'always' },
      },
    }).critiqueLoop.delegate,
    { command: 'review', mode: 'fallback' },
  );
});

test('resolveEffectiveCritiqueLoopDelegate treats a malformed global fragment as absent (#2257)', () => {
  const result = resolveEffectiveCritiqueLoopDelegate({
    localConfig: {},
    globalConfig: {
      critiqueLoop: { delegate: { command: 'global-review', bogus: 1 } },
    },
  });
  assert.deepEqual(result, { status: 'none', source: 'none' });
});

test('resolveEffectiveCritiqueLoopDelegate returns none when both layers are absent (#2257)', () => {
  assert.deepEqual(resolveEffectiveCritiqueLoopDelegate({ localConfig: {} }), {
    status: 'none',
    source: 'none',
  });
});

// #2324: `mode` widened from fallback/combined to a four-value enum
// answering "when does the per-agent critique pass also run". The two
// added values are exercised through every layer the existing two
// already cover, so a future narrowing cannot pass by only keeping the
// original pair working.
const ADDED_CRITIQUE_LOOP_DELEGATE_MODES = ['on-success', 'never'] as const;

test('critiqueLoop.delegate preserves each added mode (#2324)', () => {
  for (const mode of ADDED_CRITIQUE_LOOP_DELEGATE_MODES) {
    assert.deepEqual(
      normalizePolicyConfig({
        critiqueLoop: {
          delegate: { command: 'coderabbit review --plain', mode },
        },
      }).critiqueLoop.delegate,
      { command: 'coderabbit review --plain', mode },
      `expected mode ${mode} to survive normalization`,
    );
  }
});

test('inspectCritiqueLoopDelegateLayer reports configured for each added mode (#2324)', () => {
  for (const mode of ADDED_CRITIQUE_LOOP_DELEGATE_MODES) {
    assert.deepEqual(
      inspectCritiqueLoopDelegateLayer({
        critiqueLoop: {
          delegate: { command: 'coderabbit review --plain', mode },
        },
      }),
      {
        status: 'configured',
        delegate: { command: 'coderabbit review --plain', mode },
      },
      `expected mode ${mode} to inspect as configured`,
    );
  }
});

test('resolveEffectiveCritiqueLoopDelegate carries each added mode through the repository-local layer (#2324)', () => {
  for (const mode of ADDED_CRITIQUE_LOOP_DELEGATE_MODES) {
    assert.deepEqual(
      resolveEffectiveCritiqueLoopDelegate({
        localConfig: {
          critiqueLoop: { delegate: { command: 'local-review', mode } },
        },
        globalConfig: {
          critiqueLoop: {
            delegate: { command: 'global-review', mode: 'combined' },
          },
        },
      }),
      {
        status: 'local',
        source: 'repository-local',
        delegate: { command: 'local-review', mode },
      },
      `expected local mode ${mode} to win over the global layer`,
    );
  }
});

test('resolveEffectiveCritiqueLoopDelegate carries each added mode through the user-global layer (#2324)', () => {
  for (const mode of ADDED_CRITIQUE_LOOP_DELEGATE_MODES) {
    assert.deepEqual(
      resolveEffectiveCritiqueLoopDelegate({
        localConfig: {},
        globalConfig: {
          critiqueLoop: { delegate: { command: 'global-review', mode } },
        },
      }),
      {
        status: 'global',
        source: 'user-global',
        delegate: { command: 'global-review', mode },
      },
      `expected global mode ${mode} to be inherited`,
    );
  }
});

test('an unrecognized mode still fails closed after the widening (#2324)', () => {
  // The four accepted values are not a wildcard: a value outside them
  // stays malformed at the layer level (fail-closed, never inheriting a
  // global delegate) while a direct normalizePolicyConfig caller still
  // collapses it to the fallback default.
  assert.deepEqual(
    inspectCritiqueLoopDelegateLayer({
      critiqueLoop: {
        delegate: { command: 'coderabbit review --plain', mode: 'on-failure' },
      },
    }),
    { status: 'malformed', reason: 'invalid-repository-local-delegate' },
  );
  assert.deepEqual(
    normalizePolicyConfig({
      critiqueLoop: {
        delegate: { command: 'coderabbit review --plain', mode: 'on-failure' },
      },
    }).critiqueLoop.delegate,
    { command: 'coderabbit review --plain', mode: 'fallback' },
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

// Locks the A4 Step 2 helper-unavailable worked example in both
// idd-template/.github/instructions/idd-discover.instructions.md and
// .github/instructions/idd-discover.instructions.md. A later hash
// change must update that prose in both structure-pair copies.
test('selectDesyncedIndex matches the discover-instruction worked example', () => {
  assert.equal(selectDesyncedIndex('copilot-8122ca35', 3), 1);
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

test('inspectDevelopmentBranch distinguishes absent, configured, and invalid (#2271)', () => {
  assert.deepEqual(inspectDevelopmentBranch({}), { status: 'absent' });
  assert.deepEqual(inspectDevelopmentBranch(null), { status: 'absent' });
  assert.deepEqual(inspectDevelopmentBranch('not-an-object'), {
    status: 'absent',
  });
  assert.deepEqual(inspectDevelopmentBranch({ developmentBranch: 'develop' }), {
    status: 'configured',
    branch: 'develop',
  });
  assert.deepEqual(
    inspectDevelopmentBranch({ developmentBranch: 'release/2.0' }),
    { status: 'configured', branch: 'release/2.0' },
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: '' }).status,
    'invalid',
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: '  ' }).status,
    'invalid',
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: 'my branch' }).status,
    'invalid',
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: 'refs/heads/main' }).status,
    'invalid',
  );
  // #2273: a value containing shell metacharacters is a valid,
  // non-whitespace string that would otherwise pass -- reject it so every
  // unquoted `{development-branch}` shell substitution stays safe.
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: 'release/$next' }).status,
    'invalid',
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: 'release;stable' }).status,
    'invalid',
  );
  // #2273 review: a leading "-" would be parsed as an option rather than a
  // positional argument in an unquoted `git fetch origin
  // {development-branch}`/`git switch {development-branch}` substitution.
  // Mid-string and trailing hyphens (ordinary hyphenated branch names)
  // remain valid.
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: '-q' }).status,
    'invalid',
  );
  assert.deepEqual(
    inspectDevelopmentBranch({ developmentBranch: 'release-2.0' }),
    { status: 'configured', branch: 'release-2.0' },
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: 42 }).status,
    'invalid',
  );
  assert.equal(
    inspectDevelopmentBranch({ developmentBranch: null }).status,
    'invalid',
  );
});

test('normalizePolicyConfig omits developmentBranch when absent or invalid, includes it verbatim when configured (#2271)', () => {
  assert.equal('developmentBranch' in normalizePolicyConfig({}), false);
  assert.equal(
    'developmentBranch' in
      normalizePolicyConfig({ developmentBranch: 'refs/heads/main' }),
    false,
  );
  assert.equal(
    'developmentBranch' in normalizePolicyConfig({ developmentBranch: '' }),
    false,
  );
  assert.equal(
    normalizePolicyConfig({ developmentBranch: 'develop' }).developmentBranch,
    'develop',
  );
});

test('resolveEffectiveDevelopmentBranch: a configured value wins outright, live default branch ignored (#2272)', () => {
  assert.deepEqual(
    resolveEffectiveDevelopmentBranch({ developmentBranch: 'develop' }, 'main'),
    { status: 'configured', branch: 'develop' },
  );
  // Even a null/unread live default branch never affects a configured value.
  assert.deepEqual(
    resolveEffectiveDevelopmentBranch({ developmentBranch: 'develop' }, null),
    { status: 'configured', branch: 'develop' },
  );
});

test('resolveEffectiveDevelopmentBranch: an absent policy falls back to the live default branch (#2272)', () => {
  assert.deepEqual(resolveEffectiveDevelopmentBranch({}, 'main'), {
    status: 'default',
    branch: 'main',
  });
  assert.deepEqual(resolveEffectiveDevelopmentBranch(null, 'trunk'), {
    status: 'default',
    branch: 'trunk',
  });
});

test('resolveEffectiveDevelopmentBranch: an absent policy with an unread live default branch is unavailable, not silently absent (#2272)', () => {
  assert.deepEqual(resolveEffectiveDevelopmentBranch({}, null), {
    status: 'unavailable',
  });
  assert.deepEqual(resolveEffectiveDevelopmentBranch({}, ''), {
    status: 'unavailable',
  });
});

test('resolveEffectiveDevelopmentBranch: an invalid policy fails closed regardless of a live default branch (#2272)', () => {
  assert.deepEqual(
    resolveEffectiveDevelopmentBranch(
      { developmentBranch: 'refs/heads/main' },
      'main',
    ),
    {
      status: 'invalid',
      reason: 'developmentBranch must be a branch name, not a refs/heads/ ref',
    },
  );
  // Even a fully-readable live default branch must not paper over a
  // present-but-broken policy value -- that would silently ignore an
  // operator's malformed configuration instead of surfacing it.
  assert.equal(
    resolveEffectiveDevelopmentBranch({ developmentBranch: '' }, 'main').status,
    'invalid',
  );
});
