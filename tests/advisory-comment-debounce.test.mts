#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateDebounceSkip } from '../src/scripts/advisory-comment-debounce.mts';

describe('advisory-comment-debounce', () => {
  const triggeredAt = '2026-09-05T12:00:00Z';

  it('does not skip when there are no later events at all', () => {
    const result = evaluateDebounceSkip({ triggeredAt, laterEvents: [] });

    assert.deepStrictEqual(result, {
      skip: false,
      reason: 'no-newer-idd-originated-event',
      newerIddOriginatedEventAt: null,
      evidence: { laterEventCount: 0, laterIddOriginatedCount: 0 },
    });
  });

  it('does not skip when a later event exists but is not IDD-originated', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [{ createdAt: '2026-09-05T12:01:00Z', body: 'LGTM!' }],
    });

    assert.strictEqual(result.skip, false);
    assert.strictEqual(result.reason, 'no-newer-idd-originated-event');
    assert.strictEqual(result.evidence.laterEventCount, 1);
    assert.strictEqual(result.evidence.laterIddOriginatedCount, 0);
  });

  it('skips when a later event is IDD-originated (disposition prefix)', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        {
          createdAt: '2026-09-05T12:01:00Z',
          body: '**Accepted** — confirmed, fixed.',
        },
      ],
    });

    assert.strictEqual(result.skip, true);
    assert.strictEqual(result.reason, 'newer-idd-originated-event');
    assert.strictEqual(
      result.newerIddOriginatedEventAt,
      '2026-09-05T12:01:00Z',
    );
    assert.strictEqual(result.evidence.laterEventCount, 1);
    assert.strictEqual(result.evidence.laterIddOriginatedCount, 1);
  });

  it('reports the latest of several newer IDD-originated events', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        {
          createdAt: '2026-09-05T12:01:00Z',
          body: '**Accepted** — first.',
        },
        {
          createdAt: '2026-09-05T12:03:00Z',
          body: '**Rejected** — second, most recent.',
        },
        {
          createdAt: '2026-09-05T12:02:00Z',
          body: '**Accepted** — third, out of order.',
        },
      ],
    });

    assert.strictEqual(result.skip, true);
    assert.strictEqual(
      result.newerIddOriginatedEventAt,
      '2026-09-05T12:03:00Z',
    );
    assert.strictEqual(result.evidence.laterEventCount, 3);
    assert.strictEqual(result.evidence.laterIddOriginatedCount, 3);
  });

  it('ignores events at or before triggeredAt (boundary is exclusive)', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        {
          createdAt: '2026-09-05T12:00:00Z', // exactly triggeredAt
          body: '**Accepted** — same instant, not "newer".',
        },
        {
          createdAt: '2026-09-05T11:59:00Z', // before triggeredAt
          body: '**Accepted** — earlier, not "newer".',
        },
      ],
    });

    assert.strictEqual(result.skip, false);
    assert.strictEqual(result.evidence.laterEventCount, 0);
    assert.strictEqual(result.evidence.laterIddOriginatedCount, 0);
  });

  it('a mix of qualifying and non-qualifying later events still skips', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        { createdAt: '2026-09-05T12:01:00Z', body: 'thanks!' },
        {
          createdAt: '2026-09-05T12:02:00Z',
          body: '**Rejected** — verified false.',
        },
      ],
    });

    assert.strictEqual(result.skip, true);
    assert.strictEqual(result.evidence.laterEventCount, 2);
    assert.strictEqual(result.evidence.laterIddOriginatedCount, 1);
  });

  it('treats an unparsable event timestamp as not-newer (fail-safe)', () => {
    const result = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        {
          createdAt: 'not-a-timestamp',
          body: '**Accepted** — would otherwise trigger a skip.',
        },
      ],
    });

    assert.strictEqual(result.skip, false);
    assert.strictEqual(result.evidence.laterEventCount, 0);
  });

  it('passes markerPrefix through to the reused classifier', () => {
    const withDefaultPrefix = evaluateDebounceSkip({
      triggeredAt,
      laterEvents: [
        {
          createdAt: '2026-09-05T12:01:00Z',
          body: '<!-- idd-skill-review-reply -->',
        },
      ],
    });
    assert.strictEqual(withDefaultPrefix.skip, true);

    const withOtherPrefix = evaluateDebounceSkip({
      triggeredAt,
      markerPrefix: 'other-prefix',
      laterEvents: [
        {
          createdAt: '2026-09-05T12:01:00Z',
          body: '<!-- idd-skill-review-reply -->',
        },
      ],
    });
    assert.strictEqual(withOtherPrefix.skip, false);
  });
});
