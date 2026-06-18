#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateQuietWindow } from '../src/scripts/stalled-session-quiet-check.mts';

describe('stalled-session-quiet-check', () => {
  const now = '2026-05-13T12:00:00Z';

  it('returns a quiet result when no blocking activity is present', () => {
    const result = evaluateQuietWindow({ now, activities: [] });

    assert.deepStrictEqual(result, {
      quiet_window_met: true,
      quiet_window_ms: 30 * 60 * 1000,
      window_start: '2026-05-13T11:30:00Z',
      now,
      latest_activity: null,
      latest_activity_type: null,
      reason: 'no-activity-in-window',
      evidence: {
        activity_count_in_window: 0,
        blocking_activities: [],
        has_heartbeat_in_window: false,
        has_ci_running: false,
        has_branch_tip_movement: false,
      },
    });
  });

  it('treats boundary timestamps as within the quiet window', () => {
    const result = evaluateQuietWindow({
      now,
      quietWindowMs: 30 * 60 * 1000,
      activities: [{ type: 'comment', timestamp: '2026-05-13T11:30:00Z' }],
    });

    assert.strictEqual(result.quiet_window_met, false);
    assert.strictEqual(result.latest_activity, '2026-05-13T11:30:00Z');
    assert.strictEqual(result.latest_activity_type, 'comment');
    assert.strictEqual(result.reason, 'activity-in-window: comment');
    assert.deepStrictEqual(result.evidence.blocking_activities, [
      { type: 'comment', timestamp: '2026-05-13T11:30:00Z' },
    ]);
  });

  it('reports heartbeat and branch movement through the stable evidence flags', () => {
    const result = evaluateQuietWindow({
      now,
      activities: [
        { type: 'heartbeat', timestamp: '2026-05-13T11:40:00Z' },
        { type: 'branch-tip-movement', timestamp: '2026-05-13T11:50:00Z' },
      ],
    });

    assert.strictEqual(result.quiet_window_met, false);
    assert.strictEqual(result.latest_activity, '2026-05-13T11:50:00Z');
    assert.strictEqual(result.latest_activity_type, 'branch-tip-movement');
    assert.strictEqual(
      result.reason,
      'activity-in-window: heartbeat, branch-tip-movement',
    );
    assert.strictEqual(result.evidence.activity_count_in_window, 2);
    assert.strictEqual(result.evidence.has_heartbeat_in_window, true);
    assert.strictEqual(result.evidence.has_branch_tip_movement, true);
  });

  it('always treats ci-running as blocking even without a timestamp', () => {
    const result = evaluateQuietWindow({
      now,
      activities: [
        { type: 'comment', timestamp: '2026-05-13T10:00:00Z' },
        { type: 'ci-running' },
      ],
    });

    assert.strictEqual(result.quiet_window_met, false);
    assert.strictEqual(result.latest_activity, null);
    assert.strictEqual(result.latest_activity_type, 'ci-running');
    assert.strictEqual(result.reason, 'activity-in-window: ci-running');
    assert.strictEqual(result.evidence.activity_count_in_window, 1);
    assert.strictEqual(result.evidence.has_ci_running, true);
    assert.deepStrictEqual(result.evidence.blocking_activities, [
      { type: 'ci-running', timestamp: null },
    ]);
  });

  it('falls back to the default quiet window when an invalid value is provided', () => {
    const result = evaluateQuietWindow({
      now,
      quietWindowMs: -1,
      activities: [{ type: 'review', timestamp: '2026-05-13T11:45:00Z' }],
    });

    assert.strictEqual(result.quiet_window_ms, 30 * 60 * 1000);
    assert.strictEqual(result.quiet_window_met, false);
    assert.strictEqual(result.latest_activity_type, 'review');
  });

  it('ignores non-ci activities that do not carry a valid timestamp', () => {
    const result = evaluateQuietWindow({
      now,
      activities: [
        { type: 'comment', timestamp: 'not-an-iso-timestamp' },
        { type: 'review' },
      ],
    });

    assert.strictEqual(result.quiet_window_met, true);
    assert.strictEqual(result.evidence.activity_count_in_window, 0);
    assert.deepStrictEqual(result.evidence.blocking_activities, []);
  });

  it('throws when now is not a valid ISO8601 timestamp', () => {
    assert.throws(
      () => evaluateQuietWindow({ now: 'invalid-timestamp', activities: [] }),
      /input\.now must be a valid ISO8601 timestamp/u,
    );
  });
});
