import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyProviderHealth,
  deriveAdvisoryReviewObservation,
  deriveCiActionsObservation,
  type ProviderHealthSnapshot,
  resolveCutoffIso,
} from '../src/scripts/provider-health.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const NOW = '2026-09-01T00:00:00Z';
const POLICY = { minCorroboratingPrs: 2 };

function snapshot(
  overrides: Partial<ProviderHealthSnapshot> = {},
): ProviderHealthSnapshot {
  return {
    service: 'advisory-review',
    now: NOW,
    contradictory: false,
    unreadable: false,
    observations: [],
    ...overrides,
  };
}

test('healthy: zero failure observations', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'success' },
        { prNumber: 2, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'healthy');
  assert.equal(result.reason, 'all-healthy');
  assert.equal(result.distinctFailingPrCount, 0);
  assert.equal(result.distinctSuccessPrCount, 2);
});

test('degraded: a single pull request failure burst never resolves stronger than degraded', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.reason, 'failure-below-corroboration-threshold');
  assert.equal(result.distinctFailingPrCount, 1);
});

test('degraded: corroborated failures alongside surviving successes stay degraded, not unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.reason, 'mixed-evidence-with-corroboration');
  assert.equal(result.distinctFailingPrCount, 2);
  assert.equal(result.distinctSuccessPrCount, 1);
});

test('unavailable: failure corroborated across the threshold with zero successes', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.reason, 'full-failure-with-corroboration');
  assert.equal(result.distinctFailingPrCount, 3);
  assert.equal(result.distinctSuccessPrCount, 0);
});

test('unknown: unreadable evidence never resolves to unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      unreadable: true,
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'evidence-unreadable');
});

test('unknown: contradictory evidence is an explicit signal, not derived from a success/failure vote', () => {
  const result = classifyProviderHealth(
    snapshot({
      contradictory: true,
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'contradictory-evidence');
});

test('unknown: no observations at all is insufficient evidence, not healthy', () => {
  const result = classifyProviderHealth(snapshot(), POLICY);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'no-evidence');
});

test('ci-actions service: same classifier, same verdict shape', () => {
  const result = classifyProviderHealth(
    snapshot({
      service: 'ci-actions',
      observations: [
        { prNumber: 10, outcome: 'failure' },
        { prNumber: 11, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.service, 'ci-actions');
  assert.equal(result.verdict, 'unavailable');
});

test('corroboration threshold is configurable: a higher minCorroboratingPrs keeps more failure below unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'failure' },
      ],
    }),
    { minCorroboratingPrs: 5 },
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.minCorroboratingPrs, 5);
});

test('a repeated observation for the same PR counts once toward corroboration', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.distinctFailingPrCount, 2);
  assert.equal(result.verdict, 'unavailable');
});

const TRUSTED = new Set(['idd-bot']);
const BASE_DERIVE_OPTIONS = {
  trustedMarkerLogins: TRUSTED,
  primaryBotLogin: 'copilot-pull-request-reviewer[bot]',
  cutoffIso: null,
  // A zero settling window preserves this suite's existing
  // immediate-failure-classification semantics; the settling-window
  // behavior itself is covered by its own dedicated test below.
  now: NOW,
  settledWindowMs: 0,
};

test('deriveAdvisoryReviewObservation: an untrusted actor cannot post evidence-bearing markers', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        user: { login: 'an-untrusted-actor' },
      },
    ],
    [],
    [],
    BASE_DERIVE_OPTIONS,
  );
  assert.equal(result, null);
});

test('deriveAdvisoryReviewObservation: the LATEST trusted marker decides the outcome, not the earliest', () => {
  const comments = [
    {
      // Earliest marker: registered via timeline -- would read as 'success'
      // if this one were selected.
      body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
      created_at: '2026-09-01T00:00:00Z',
      user: { login: 'idd-bot' },
    },
    {
      // Latest marker: never registered -- the observable is whether THIS
      // request registered.
      body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T12:00:00Z',
      created_at: '2026-09-01T12:00:00Z',
      user: { login: 'idd-bot' },
    },
  ];
  const timeline = [
    {
      event: 'review_requested',
      created_at: '2026-09-01T00:05:00Z',
      requested_reviewer: { login: 'copilot-pull-request-reviewer[bot]' },
    },
  ];
  const result = deriveAdvisoryReviewObservation(1, comments, timeline, [], {
    ...BASE_DERIVE_OPTIONS,
    now: '2026-09-01T12:30:00Z',
  });
  assert.deepEqual(result, { prNumber: 1, outcome: 'failure' });
});

test('deriveAdvisoryReviewObservation: recognizes both the plain-text and HTML-comment marker forms', () => {
  const timeline = [
    {
      event: 'review_requested',
      created_at: '2026-09-01T00:05:00Z',
      requested_reviewer: { login: 'copilot-pull-request-reviewer[bot]' },
    },
  ];
  for (const body of [
    'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
    '<!-- advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z -->',
  ]) {
    const result = deriveAdvisoryReviewObservation(
      1,
      [
        {
          body,
          created_at: '2026-09-01T00:00:00Z',
          user: { login: 'idd-bot' },
        },
      ],
      timeline,
      [],
      BASE_DERIVE_OPTIONS,
    );
    assert.deepEqual(result, { prNumber: 1, outcome: 'success' });
  }
});

test('deriveAdvisoryReviewObservation: a malformed timestamp is not evidence-bearing', () => {
  for (const body of [
    'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 not-a-timestamp',
    '<!-- advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 not-a-timestamp -->',
  ]) {
    const result = deriveAdvisoryReviewObservation(
      1,
      [
        {
          body,
          created_at: '2026-09-01T00:00:00Z',
          user: { login: 'idd-bot' },
        },
      ],
      [],
      [],
      BASE_DERIVE_OPTIONS,
    );
    assert.equal(result, null);
  }
});

test('deriveAdvisoryReviewObservation: a submitted review from the primary bot registers success without a timeline event', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        user: { login: 'idd-bot' },
      },
    ],
    [],
    [
      {
        user: { login: 'copilot-pull-request-reviewer[bot]' },
        submitted_at: '2026-09-01T00:10:00Z',
      },
    ],
    BASE_DERIVE_OPTIONS,
  );
  assert.deepEqual(result, { prNumber: 1, outcome: 'success' });
});

test('deriveAdvisoryReviewObservation: registration is detected across mismatched fractional-second precision', () => {
  // A second-precision marker timestamp and a fractional-second timeline
  // timestamp for the SAME instant would misorder under lexical string
  // comparison ("...:00.000Z" sorts lexically BEFORE "...:00Z" despite
  // being the identical instant) -- this must resolve as registered.
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        user: { login: 'idd-bot' },
      },
    ],
    [
      {
        event: 'review_requested',
        created_at: '2026-09-01T00:00:00.000Z',
        requested_reviewer: { login: 'copilot-pull-request-reviewer[bot]' },
      },
    ],
    [],
    BASE_DERIVE_OPTIONS,
  );
  assert.deepEqual(result, { prNumber: 1, outcome: 'success' });
});

test('deriveAdvisoryReviewObservation: registration is detected when the timeline event precedes the marker COMMENT (the documented request-then-post ordering)', () => {
  // idd-review-fix.instructions.md's REQUEST_NEEDED flow requests the
  // review FIRST, then posts this marker -- so the review_requested event
  // is ordinarily recorded seconds BEFORE the marker comment's created_at.
  // Comparing against the comment's created_at (rather than the marker's
  // own embedded {ISO8601-requested-at}) would misclassify this ordinary,
  // healthy case as unregistered.
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        // Embedded timestamp 00:00:00Z; posted 5s later at 00:00:05Z.
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:05Z',
        user: { login: 'idd-bot' },
      },
    ],
    [
      {
        // 2s after the request, but 3s BEFORE the marker comment posted.
        event: 'review_requested',
        created_at: '2026-09-01T00:00:02Z',
        requested_reviewer: { login: 'copilot-pull-request-reviewer[bot]' },
      },
    ],
    [],
    BASE_DERIVE_OPTIONS,
  );
  assert.deepEqual(result, { prNumber: 1, outcome: 'success' });
});

test('deriveAdvisoryReviewObservation: an unregistered marker still within the settling window is not failure evidence', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        user: { login: 'idd-bot' },
      },
    ],
    [],
    [],
    {
      ...BASE_DERIVE_OPTIONS,
      now: '2026-09-01T00:05:00Z',
      settledWindowMs: 10 * 60_000,
    },
  );
  assert.equal(result, null);
});

test('deriveAdvisoryReviewObservation: an unregistered marker past the settling window is failure evidence', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        user: { login: 'idd-bot' },
      },
    ],
    [],
    [],
    {
      ...BASE_DERIVE_OPTIONS,
      now: '2026-09-01T00:15:00Z',
      settledWindowMs: 10 * 60_000,
    },
  );
  assert.deepEqual(result, { prNumber: 1, outcome: 'failure' });
});

test('deriveAdvisoryReviewObservation: a marker older than the sampling window contributes no observation', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-08-01T00:00:00Z',
        created_at: '2026-08-01T00:00:00Z',
        user: { login: 'idd-bot' },
      },
    ],
    [],
    [],
    { ...BASE_DERIVE_OPTIONS, cutoffIso: '2026-08-31T00:00:00Z' },
  );
  assert.equal(result, null);
});

test('deriveAdvisoryReviewObservation: an unparsable marker postedAt fails closed under a configured sampling window', () => {
  const result = deriveAdvisoryReviewObservation(
    1,
    [
      {
        body: 'advisory-wait: agent-x 0123456789abcdef0123456789abcdef01234567 2026-08-31T12:00:00Z',
        created_at: 'not-a-timestamp',
        user: { login: 'idd-bot' },
      },
    ],
    [],
    [],
    { ...BASE_DERIVE_OPTIONS, cutoffIso: '2026-08-31T00:00:00Z' },
  );
  assert.equal(result, null);
});

test('deriveCiActionsObservation: every job zero-steps is failure evidence', () => {
  const result = deriveCiActionsObservation(
    { conclusion: 'failure', pull_requests: [{ number: 7 }] },
    [{ steps: [] }, { steps: [] }],
    { cutoffIso: null },
  );
  assert.deepEqual(result, { prNumber: 7, outcome: 'failure' });
});

test('deriveCiActionsObservation: a run older than the sampling window contributes no observation', () => {
  const result = deriveCiActionsObservation(
    {
      conclusion: 'success',
      updated_at: '2026-08-01T00:00:00Z',
      pull_requests: [{ number: 7 }],
    },
    null,
    { cutoffIso: '2026-08-31T00:00:00Z' },
  );
  assert.equal(result, null);
});

test('deriveCiActionsObservation: a missing updated_at fails closed under a configured sampling window', () => {
  const result = deriveCiActionsObservation(
    { conclusion: 'success', pull_requests: [{ number: 7 }] },
    null,
    { cutoffIso: '2026-08-31T00:00:00Z' },
  );
  assert.equal(result, null);
});

test('resolveCutoffIso: an ordinary window resolves to now minus the window', () => {
  assert.equal(
    resolveCutoffIso('2026-09-01T12:00:00.000Z', 10 * 60_000),
    '2026-09-01T11:50:00.000Z',
  );
});

test('resolveCutoffIso: null windowMs means no cutoff', () => {
  assert.equal(resolveCutoffIso('2026-09-01T12:00:00.000Z', null), null);
});

test('resolveCutoffIso: a window so large the resulting date is unrepresentable does not throw', () => {
  // A schema-valid but absurd samplingWindow (excessive digit count) can
  // parse to a duration whose ms value pushes the cutoff outside the
  // representable Date range -- must degrade to "no cutoff", not throw.
  assert.equal(
    resolveCutoffIso('2026-09-01T12:00:00.000Z', Number.MAX_VALUE),
    null,
  );
});

test('committed provider-health fixture validates against its schema', () => {
  const schema = loadJson('schemas/provider-health.schema.json');
  const fixture = loadJson('fixtures/schemas/provider-health.valid.json');
  assert.deepEqual(validate(fixture, schema), []);
});

test('a classifier result for each service round-trips through the report schema shape', () => {
  const advisoryReview = classifyProviderHealth(
    snapshot({
      observations: [{ prNumber: 1, outcome: 'success' }],
    }),
    POLICY,
  );
  const ciActions = classifyProviderHealth(
    snapshot({ service: 'ci-actions' }),
    POLICY,
  );
  const report = {
    protocolVersion: '1',
    now: NOW,
    services: {
      'advisory-review': advisoryReview,
      'ci-actions': ciActions,
    },
  };
  const fullSchema = loadJson('schemas/provider-health.schema.json');
  assert.deepEqual(validate(report, fullSchema), []);
});
