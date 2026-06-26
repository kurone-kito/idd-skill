import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAuthoringLabelWarning,
  findLatestLabeledAt,
  formatElapsedDuration,
  resolveAuthoringGuardPolicy,
} from '../src/scripts/authoring-label-guard.mts';
import {
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
} from '../src/scripts/policy-helpers.mts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_AUTHORING = POLICY_DEFAULTS.issueAuthoring;

test('findLatestLabeledAt only accepts explicit labeled events', () => {
  const latest = findLatestLabeledAt(
    [
      {
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T08:00:00Z',
      },
      {
        event: 'unlabeled',
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T09:00:00Z',
      },
      {
        event: 'labeled',
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T07:00:00Z',
      },
    ],
    'status:authoring',
  );

  assert.equal(latest, '2026-05-15T07:00:00Z');
});

test('findLatestLabeledAt matches the label case-insensitively and trimmed', () => {
  const latest = findLatestLabeledAt(
    [
      {
        event: 'labeled',
        label: { name: ' Status:Authoring ' },
        created_at: '2026-05-15T10:00:00Z',
      },
      {
        event: 'labeled',
        label: 'STATUS:AUTHORING',
        created_at: '2026-05-15T11:00:00Z',
      },
    ],
    'status:authoring',
  );

  assert.equal(latest, '2026-05-15T11:00:00Z');
});

test('findLatestLabeledAt normalizes the configured labelName too', () => {
  // labelName side carries mixed case + whitespace; the event label is the
  // canonical form. Both sides must be normalized for this to match.
  const latest = findLatestLabeledAt(
    [
      {
        event: 'labeled',
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T12:00:00Z',
      },
    ],
    '  Status:AUTHORING  ',
  );

  assert.equal(latest, '2026-05-15T12:00:00Z');
});

test('findLatestLabeledAt still ignores a genuinely different label', () => {
  const latest = findLatestLabeledAt(
    [
      {
        event: 'labeled',
        label: { name: 'status:blocked-by-human' },
        created_at: '2026-05-15T10:00:00Z',
      },
    ],
    'status:authoring',
  );

  assert.equal(latest, '');
});

test('buildAuthoringLabelWarning treats implicit events as timestamp unavailable', () => {
  const warning = buildAuthoringLabelWarning({
    issueNumber: 536,
    labelName: 'status:authoring',
    labelEvents: [
      {
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T07:00:00Z',
      },
    ],
    now: '2026-05-15T12:00:00Z',
    staleAgeMs: 4 * 60 * 60 * 1000,
  });

  assert.equal(warning?.status, 'timestamp_unavailable');
  assert.match(warning?.message ?? '', /timestamp could not be resolved/);
});

test('buildAuthoringLabelWarning reports timestamp_unavailable without a labeled event', () => {
  // No event matches the label, so findLatestLabeledAt yields '' and the
  // warning falls into the timestamp_unavailable branch with null age fields.
  const warning = buildAuthoringLabelWarning({
    issueNumber: 1088,
    labelName: 'status:authoring',
    labelEvents: [],
    now: '2026-05-15T12:00:00Z',
    staleAgeMs: 4 * HOUR_MS,
  });

  assert.equal(warning?.status, 'timestamp_unavailable');
  assert.equal(warning?.labeledAt, null);
  assert.equal(warning?.ageMs, null);
});

test('buildAuthoringLabelWarning flags an age exactly at the stale threshold', () => {
  // ageMs === staleAgeMs is NOT `< staleAgeMs`, so the boundary is stale.
  const staleAgeMs = 4 * HOUR_MS;
  const warning = buildAuthoringLabelWarning({
    issueNumber: 1088,
    labelName: 'status:authoring',
    labelEvents: [
      {
        event: 'labeled',
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T08:00:00Z',
      },
    ],
    now: '2026-05-15T12:00:00Z', // exactly staleAgeMs after the labeled event
    staleAgeMs,
  });

  assert.equal(warning?.status, 'stale');
  assert.equal(warning?.ageMs, staleAgeMs);
  // The message renders the elapsed age through formatElapsedDuration.
  assert.match(warning?.message ?? '', /carried the authoring label for 4h;/);
});

test('buildAuthoringLabelWarning stays silent one millisecond under the threshold', () => {
  const warning = buildAuthoringLabelWarning({
    issueNumber: 1088,
    labelName: 'status:authoring',
    labelEvents: [
      {
        event: 'labeled',
        label: { name: 'status:authoring' },
        created_at: '2026-05-15T08:00:00.001Z',
      },
    ],
    now: '2026-05-15T12:00:00Z', // 1 ms short of the stale threshold
    staleAgeMs: 4 * HOUR_MS,
  });

  assert.equal(warning, null);
});

test('formatElapsedDuration composes days, hours, and minutes', () => {
  assert.equal(
    formatElapsedDuration(DAY_MS + 2 * HOUR_MS + 3 * MINUTE_MS),
    '1d 2h 3m',
  );
});

test('formatElapsedDuration omits zero-valued units', () => {
  // Zero hours between a non-zero day and non-zero minutes.
  assert.equal(formatElapsedDuration(DAY_MS + 5 * MINUTE_MS), '1d 5m');
  // Zero trailing minutes are dropped when a larger unit is present.
  assert.equal(formatElapsedDuration(2 * DAY_MS + 3 * HOUR_MS), '2d 3h');
  // A lone hour drops both the day and the minute parts.
  assert.equal(formatElapsedDuration(2 * HOUR_MS), '2h');
});

test('formatElapsedDuration clamps sub-minute and negative inputs to 0m', () => {
  assert.equal(formatElapsedDuration(30 * 1000), '0m'); // 30s, under a minute
  assert.equal(formatElapsedDuration(0), '0m');
  assert.equal(formatElapsedDuration(-5 * MINUTE_MS), '0m'); // negative clamps
});

test('formatElapsedDuration floors fractional milliseconds down to a minute', () => {
  assert.equal(formatElapsedDuration(MINUTE_MS + 0.9), '1m');
});

test('resolveAuthoringGuardPolicy returns the policy defaults for an absent config', () => {
  const policy = resolveAuthoringGuardPolicy(undefined);

  assert.equal(policy.labelName, DEFAULT_AUTHORING.authoringLabelName);
  assert.equal(policy.staleAge, DEFAULT_AUTHORING.authoringStaleAge);
  assert.equal(
    policy.staleAgeMs,
    parseIsoDurationToMs(DEFAULT_AUTHORING.authoringStaleAge),
  );
});

test('resolveAuthoringGuardPolicy honors label and stale-age overrides', () => {
  const policy = resolveAuthoringGuardPolicy({
    issueAuthoring: {
      authoringLabelName: 'status:drafting',
      authoringStaleAge: 'PT2H',
    },
  });

  assert.equal(policy.labelName, 'status:drafting');
  assert.equal(policy.staleAge, 'PT2H');
  assert.equal(policy.staleAgeMs, 2 * HOUR_MS);
});

test('resolveAuthoringGuardPolicy falls back to the default for an invalid duration', () => {
  // An unparseable ISO-8601 duration is rejected by normalizePolicyConfig's
  // parseDuration, so the normalize -> resolve chain yields the default age.
  const policy = resolveAuthoringGuardPolicy({
    issueAuthoring: { authoringStaleAge: 'not-a-duration' },
  });

  assert.notEqual(policy.staleAge, 'not-a-duration');
  assert.equal(policy.staleAge, DEFAULT_AUTHORING.authoringStaleAge);
  assert.equal(
    policy.staleAgeMs,
    parseIsoDurationToMs(DEFAULT_AUTHORING.authoringStaleAge),
  );
});
