import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDiscoverIncompleteResult,
  classifyDiscoverInterruption,
  createDiscoverProgress,
  DISCOVER_INCOMPLETE_EXIT_CODE,
  isDiscoverIncompleteResult,
} from '../src/scripts/discover-progress.mts';
import { createLoadControlRefusal } from '../src/scripts/github-api-refusal.mts';

const NOW_MS = Date.parse('2026-10-01T00:00:00.000Z');

/** A manual clock so no test depends on real elapsed time. */
function fakeClock(start = NOW_MS) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

/** Build a `gh`-style failure that carries only captured streams. */
function ghFailure(fields: {
  stderr?: string;
  stdout?: string;
  code?: unknown;
  killed?: boolean;
  cause?: unknown;
}): Error {
  const error = new Error('Command failed: gh api SECRET-COMMAND-LINE', {
    cause: fields.cause,
  });
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'cause') {
      Object.defineProperty(error, key, { value, enumerable: false });
    }
  }
  return error;
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => {
    assert.ok(line.endsWith('\n'), 'every progress line is newline terminated');
    const parsed = JSON.parse(line) as { iddProgress: Record<string, unknown> };
    return parsed.iddProgress;
  });
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

test('progress prints every phase edge but rate-bounds in-phase updates', () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const progress = createDiscoverProgress({
    write: (line) => lines.push(line),
    now: clock.now,
    minIntervalMs: 1000,
  });

  progress.begin('claim-state', 'leaves', 40);
  // Forty items finish inside one interval: none of them prints.
  for (let index = 0; index < 20; index += 1) {
    progress.advance();
  }
  assert.equal(lines.length, 1, 'only the start line so far');

  clock.advance(1000);
  progress.advance();
  // A burst right after an update stays silent again.
  for (let index = 0; index < 18; index += 1) {
    progress.advance();
  }
  progress.complete();

  const events = parseLines(lines);
  assert.deepEqual(
    events.map((event) => event.event),
    ['start', 'progress', 'complete'],
  );
  assert.deepEqual(
    events.map((event) => event.completed),
    [0, 21, 40],
    'complete reports the phase as fully done',
  );
  assert.deepEqual(
    events.map((event) => event.elapsedMs),
    [0, 1000, 1000],
  );
});

test('a slow provider produces one update per interval, never one per request', () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const progress = createDiscoverProgress({
    write: (line) => lines.push(line),
    now: clock.now,
    minIntervalMs: 2000,
  });
  progress.begin('claim-state', 'leaves', 10);
  // Ten leaves, 700 ms each: 7 seconds of delayed annotation.
  for (let index = 0; index < 10; index += 1) {
    clock.advance(700);
    progress.advance();
  }
  progress.complete();
  const events = parseLines(lines);
  // start + at most one update per 2 s window + complete.
  assert.ok(
    events.length <= 1 + Math.ceil(7000 / 2000) + 1,
    `bounded output, got ${events.length} lines`,
  );
  assert.equal(events[0]?.event, 'start');
  assert.equal(events.at(-1)?.event, 'complete');
});

test('progress lines carry only the allow-listed keys', () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const progress = createDiscoverProgress({
    write: (line) => lines.push(line),
    now: clock.now,
  });
  progress.begin('root-discovery', 'roots', null);
  progress.setKnown(3);
  progress.complete();
  progress.begin('traversal', 'roots', 3);
  progress.setLeavesKnown(5);
  progress.interrupted('timeout');
  const allowed = new Set([
    'helper',
    'event',
    'phase',
    'unit',
    'completed',
    'known',
    'leavesKnown',
    'elapsedMs',
    'reason',
  ]);
  for (const event of parseLines(lines)) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `unexpected progress key ${key}`);
    }
    assert.equal(event.helper, 'discover-roadmap-graph');
  }
  const [rootStart, rootDone, , interrupted] = parseLines(lines);
  assert.equal(rootStart?.known, null, 'unknown size is null, never 0');
  assert.equal(rootDone?.known, 3);
  assert.equal(rootDone?.completed, 3);
  assert.equal(interrupted?.event, 'interrupted');
  assert.equal(interrupted?.reason, 'timeout');
  assert.equal(interrupted?.leavesKnown, 5);
});

test('the tracker keeps state without a writer and survives a broken one', () => {
  const silent = createDiscoverProgress({ now: fakeClock().now });
  silent.begin('traversal', 'roots', 2);
  silent.advance();
  assert.deepEqual(silent.snapshot(), {
    phase: 'traversal',
    lastCompletedPhase: null,
    counts: { unit: 'roots', completed: 1, known: 2, leavesKnown: null },
  });
  silent.complete();
  silent.begin('claim-state', 'leaves', 4);
  assert.equal(silent.snapshot().lastCompletedPhase, 'traversal');

  const broken = createDiscoverProgress({
    write: () => {
      throw new Error('EPIPE');
    },
    now: fakeClock().now,
  });
  assert.doesNotThrow(() => {
    broken.begin('traversal', 'roots', 1);
    broken.advance();
    broken.complete();
  });
});

test('an interruption before any phase still prints an interrupted root-discovery line', () => {
  const lines: string[] = [];
  const progress = createDiscoverProgress({
    write: (line) => lines.push(line),
    now: fakeClock().now,
  });
  progress.interrupted('rate-limit');
  assert.deepEqual(parseLines(lines), [
    {
      helper: 'discover-roadmap-graph',
      event: 'interrupted',
      phase: 'root-discovery',
      unit: 'roots',
      completed: 0,
      known: null,
      leavesKnown: null,
      elapsedMs: 0,
      reason: 'rate-limit',
    },
  ]);
});

test('a closed tracker prints nothing further', () => {
  const lines: string[] = [];
  const progress = createDiscoverProgress({
    write: (line) => lines.push(line),
    now: fakeClock().now,
  });
  progress.begin('traversal', 'roots', 1);
  progress.close();
  progress.advance();
  progress.complete();
  progress.interrupted('rate-limit');
  assert.equal(lines.length, 1);
});

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

test('a load-control cooldown refusal is a rate limit with its own retry time', () => {
  for (const outcome of ['not-dispatched', 'deadline-expired'] as const) {
    const interruption = classifyDiscoverInterruption(
      createLoadControlRefusal({
        outcome,
        reason: 'cooldown',
        retryAt: '2026-10-01T00:07:00Z',
        retryAtSource: 'server',
      }),
      NOW_MS,
    );
    assert.deepEqual(interruption, {
      reason: 'rate-limit',
      retryAt: '2026-10-01T00:07:00.000Z',
      retryAtSource: 'server',
    });
  }
});

test('a busy refusal is an admission deadline with no invented retry time', () => {
  const interruption = classifyDiscoverInterruption(
    createLoadControlRefusal({
      outcome: 'deadline-expired',
      reason: 'busy',
      holderPid: 4242,
    }),
    NOW_MS,
  );
  assert.deepEqual(interruption, {
    reason: 'deadline',
    retryAt: null,
    retryAtSource: null,
  });
});

test('a refusal is found through the cause chain', () => {
  const wrapped = new Error('wrapped', {
    cause: new Error('inner', {
      cause: createLoadControlRefusal({
        outcome: 'not-dispatched',
        reason: 'cooldown',
        retryAt: '2026-10-01T00:01:00Z',
        retryAtSource: 'backoff',
      }),
    }),
  });
  assert.deepEqual(classifyDiscoverInterruption(wrapped, NOW_MS), {
    reason: 'rate-limit',
    retryAt: '2026-10-01T00:01:00.000Z',
    retryAtSource: 'backoff',
  });
});

test('primary quota exhaustion reads its reset from the failure headers', () => {
  const resetEpochSec = NOW_MS / 1000 + 600;
  const error = ghFailure({
    stderr: [
      'HTTP/2.0 403 Forbidden',
      'x-ratelimit-limit: 5000',
      'x-ratelimit-remaining: 0',
      `x-ratelimit-reset: ${resetEpochSec}`,
      'x-ratelimit-resource: core',
      '',
      'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    ].join('\n'),
    code: 1,
  });
  assert.deepEqual(classifyDiscoverInterruption(error, NOW_MS), {
    reason: 'rate-limit',
    retryAt: '2026-10-01T00:10:00.000Z',
    retryAtSource: 'server',
  });
});

test('a secondary limit reads retry-after and clamps it to the cooldown ceiling', () => {
  const secondary = ghFailure({
    stderr: [
      'HTTP/2.0 403 Forbidden',
      'retry-after: 90',
      '',
      'gh: You have exceeded a secondary rate limit. (HTTP 403)',
    ].join('\n'),
  });
  assert.deepEqual(classifyDiscoverInterruption(secondary, NOW_MS), {
    reason: 'rate-limit',
    retryAt: '2026-10-01T00:01:30.000Z',
    retryAtSource: 'server',
  });
  const huge = ghFailure({
    stderr: [
      'HTTP/2.0 429 Too Many Requests',
      'retry-after: 999999',
      '',
      'gh: too many requests (HTTP 429)',
    ].join('\n'),
  });
  assert.equal(
    classifyDiscoverInterruption(huge, NOW_MS)?.retryAt,
    '2026-10-01T01:00:00.000Z',
  );
});

test('a reset already in the past reports no retry time', () => {
  const error = ghFailure({
    stderr: [
      'HTTP/2.0 403 Forbidden',
      'x-ratelimit-remaining: 0',
      `x-ratelimit-reset: ${NOW_MS / 1000 - 30}`,
      'x-ratelimit-resource: core',
      '',
      'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    ].join('\n'),
  });
  assert.deepEqual(classifyDiscoverInterruption(error, NOW_MS), {
    reason: 'rate-limit',
    retryAt: null,
    retryAtSource: null,
  });
});

test('a rate limit without timing is still a rate limit, with no retry time', () => {
  const error = ghFailure({
    stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  });
  assert.deepEqual(classifyDiscoverInterruption(error, NOW_MS), {
    reason: 'rate-limit',
    retryAt: null,
    retryAtSource: null,
  });
});

test('a GraphQL RATE_LIMITED body is a rate limit', () => {
  const error = ghFailure({
    stdout: JSON.stringify({
      errors: [{ type: 'RATE_LIMITED', message: 'exceeded' }],
    }),
    stderr: 'gh: exceeded',
  });
  assert.equal(
    classifyDiscoverInterruption(error, NOW_MS)?.reason,
    'rate-limit',
  );
});

test('a GraphQL failure never reads rate-limit wording out of response data', () => {
  // Partial data can carry a comment that quotes a throttle phrase; only the
  // error entries may decide the classification.
  const partial = ghFailure({
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: [
                {
                  body: 'We hit the secondary rate limit. API rate limit exceeded for user ID 1.',
                },
              ],
            },
          },
        },
      },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
    }),
    stderr: 'gh: Could not resolve to a node',
  });
  assert.equal(classifyDiscoverInterruption(partial, NOW_MS), null);
});

test('a timeout is recognized directly and through the cause chain', () => {
  const expected = { reason: 'timeout', retryAt: null, retryAtSource: null };
  assert.deepEqual(
    classifyDiscoverInterruption(ghFailure({ code: 'ETIMEDOUT' }), NOW_MS),
    expected,
  );
  assert.deepEqual(
    classifyDiscoverInterruption(
      ghFailure({ killed: true, code: null as unknown as string }),
      NOW_MS,
    ),
    expected,
  );
  assert.deepEqual(
    classifyDiscoverInterruption(
      new Error('wrapper', { cause: ghFailure({ killed: true }) }),
      NOW_MS,
    ),
    expected,
  );
});

test('a killed child with another failure code is not a timeout', () => {
  assert.equal(
    classifyDiscoverInterruption(
      ghFailure({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      NOW_MS,
    ),
    null,
  );
});

test('every other failure is not an interruption and rethrows upstream', () => {
  for (const error of [
    new Error('boom'),
    ghFailure({ stderr: 'gh: Bad credentials (HTTP 401)' }),
    ghFailure({ stderr: 'gh: Server Error (HTTP 500)' }),
    ghFailure({ stderr: 'gh: Not Found (HTTP 404)' }),
    ghFailure({
      stderr: 'gh: Resource not accessible by integration (HTTP 403)',
    }),
    'a string',
    null,
    undefined,
  ]) {
    assert.equal(classifyDiscoverInterruption(error, NOW_MS), null);
  }
});

// ---------------------------------------------------------------------------
// Incomplete result
// ---------------------------------------------------------------------------

test('the incomplete result never lists rows and never claims exhaustion', () => {
  const progress = createDiscoverProgress({ now: fakeClock().now });
  progress.begin('root-discovery', 'roots', null);
  progress.setKnown(7);
  progress.complete();
  progress.begin('traversal', 'roots', 7);
  progress.advance();
  const result = buildDiscoverIncompleteResult(
    progress.snapshot(),
    {
      reason: 'rate-limit',
      retryAt: '2026-10-01T00:07:00.000Z',
      retryAtSource: 'server',
    },
    ['--all-roadmaps', '--with-progress'],
  );
  assert.deepEqual(result, {
    mode: 'all-roadmaps',
    status: 'incomplete',
    incomplete: {
      reason: 'rate-limit',
      phase: 'traversal',
      lastCompletedPhase: 'root-discovery',
      counts: { unit: 'roots', completed: 1, known: 7, leavesKnown: null },
      retryAt: '2026-10-01T00:07:00.000Z',
      retryAtSource: 'server',
      exhausted: false,
      recovery: {
        safeToRerun: true,
        sameArguments: true,
        notBefore: '2026-10-01T00:07:00.000Z',
        arguments: ['--all-roadmaps', '--with-progress'],
      },
    },
  });
  for (const forbidden of ['leaves', 'roots', 'summary', 'diagnostics']) {
    assert.equal(forbidden in result, false, `${forbidden} must be absent`);
  }
  assert.equal(isDiscoverIncompleteResult(result), true);
  assert.equal(
    isDiscoverIncompleteResult({ mode: 'all-roadmaps', leaves: [] }),
    false,
  );
  assert.equal(isDiscoverIncompleteResult(null), false);
  assert.equal(DISCOVER_INCOMPLETE_EXIT_CODE, 75);
});

test('an interruption before any phase reports the first phase with unknown counts', () => {
  const result = buildDiscoverIncompleteResult(
    createDiscoverProgress({ now: fakeClock().now }).snapshot(),
    { reason: 'timeout', retryAt: null, retryAtSource: null },
  );
  assert.equal(result.incomplete.phase, 'root-discovery');
  assert.equal(result.incomplete.lastCompletedPhase, null);
  assert.equal(result.incomplete.counts.known, null);
  assert.equal(result.incomplete.recovery.notBefore, null);
  assert.equal('arguments' in result.incomplete.recovery, false);
});
