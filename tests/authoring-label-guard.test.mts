import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAuthoringLabelWarning,
  findLatestLabeledAt,
} from '../src/scripts/authoring-label-guard.mts';

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
