import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkPathAItem,
  checkPathBItem,
  classifyMarker,
  verifyDispositions,
} from '../src/scripts/review-disposition-verify.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/review-disposition-verify.mjs');

/** Run the built CLI and return its trimmed stdout. */
function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
}

/** Run the built CLI expecting a non-zero exit, and return its stderr. */
function runCliExpectFailure(args: string[]): {
  status: number;
  stderr: string;
} {
  try {
    execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    throw new Error('expected the CLI to exit non-zero, but it succeeded');
  } catch (error) {
    const status = (error as { status?: number }).status;
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    assert.ok(
      typeof status === 'number' && status !== 0,
      `expected a non-zero exit status, got ${String(status)}`,
    );
    return { status: status as number, stderr };
  }
}

// ─── classifyMarker ───────────────────────────────────────────────────────────

test('classifyMarker: null for empty string', () => {
  assert.equal(classifyMarker(''), null);
});

test('classifyMarker: null for null input', () => {
  assert.equal(classifyMarker(null), null);
});

test('classifyMarker: accepted', () => {
  assert.equal(
    classifyMarker('**Accepted** — the advisory confirmed no action needed'),
    'accepted',
  );
});

test('classifyMarker: rejected', () => {
  assert.equal(
    classifyMarker('**Rejected** — the suggestion is out of scope'),
    'rejected',
  );
});

test('classifyMarker: awaiting_maintainer', () => {
  assert.equal(
    classifyMarker(
      '**Awaiting maintainer decision** — CODEOWNER feedback on naming',
    ),
    'awaiting_maintainer',
  );
});

test('classifyMarker: null when prefix missing em-dash', () => {
  assert.equal(classifyMarker('**Rejected** just notes the rejection'), null);
});

test('classifyMarker: null when no bold prefix', () => {
  assert.equal(classifyMarker('Accepted — some note'), null);
});

test('classifyMarker: null for unrecognized text', () => {
  assert.equal(classifyMarker('LGTM'), null);
});

test('classifyMarker: rejection confirmed by maintainer → rejected', () => {
  assert.equal(
    classifyMarker(
      '**Rejection confirmed by maintainer** — agreed, closing thread',
    ),
    'rejected',
  );
});

// ─── checkPathAItem ───────────────────────────────────────────────────────────

test('checkPathAItem: Accepted — no reply required', () => {
  const result = checkPathAItem({
    id: 'a1',
    path: 'A',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.decisionRecorded, true);
  assert.deepEqual(result.issues, []);
});

test('checkPathAItem: Accepted — passes even with unexpected markerReply', () => {
  const result = checkPathAItem({
    id: 'a2',
    path: 'A',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: '**Accepted** — confirmed',
    threadResolved: null,
  });
  assert.equal(result.passed, true);
});

test('checkPathAItem: Rejected — proper reply + resolved thread → pass', () => {
  const result = checkPathAItem({
    id: 'a3',
    path: 'A',
    type: 'review_thread',
    decision: 'rejected',
    markerReply: '**Rejected** — out of scope for this PR',
    threadResolved: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.markerPresent, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathAItem: Rejected — reply present but thread unresolved → fail', () => {
  const result = checkPathAItem({
    id: 'a4',
    path: 'A',
    type: 'review_thread',
    decision: 'rejected',
    markerReply: '**Rejected** — out of scope',
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test('checkPathAItem: Rejected — no reply → fail', () => {
  const result = checkPathAItem({
    id: 'a5',
    path: 'A',
    type: 'review_thread',
    decision: 'rejected',
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test('checkPathAItem: Rejected — regular_comment, null threadResolved → pass', () => {
  const result = checkPathAItem({
    id: 'a6',
    path: 'A',
    type: 'regular_comment',
    decision: 'rejected',
    markerReply: '**Rejected** — not applicable',
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathAItem: Rejected — regular_comment with non-null threadResolved → fail', () => {
  const result = checkPathAItem({
    id: 'a7',
    path: 'A',
    type: 'regular_comment',
    decision: 'rejected',
    markerReply: '**Rejected** — not applicable',
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.issues.some((msg) => msg.includes('non-null threadResolved')),
  );
});

test('checkPathAItem: AMD — proper reply + unresolved thread → pass', () => {
  const result = checkPathAItem({
    id: 'a8',
    path: 'A',
    type: 'review_thread',
    decision: 'awaiting_maintainer',
    markerReply: '**Awaiting maintainer decision** — CODEOWNER review required',
    threadResolved: false,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathAItem: AMD — resolved thread → fail', () => {
  const result = checkPathAItem({
    id: 'a9',
    path: 'A',
    type: 'review_thread',
    decision: 'awaiting_maintainer',
    markerReply: '**Awaiting maintainer decision** — CODEOWNER review required',
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test('checkPathAItem: AMD — non-thread type, null threadResolved → pass', () => {
  const result = checkPathAItem({
    id: 'a10',
    path: 'A',
    type: 'regular_comment',
    decision: 'awaiting_maintainer',
    markerReply:
      '**Awaiting maintainer decision** — awaiting CODEOWNER response',
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathAItem: AMD — non-thread type with non-null threadResolved → fail', () => {
  const result = checkPathAItem({
    id: 'a10b',
    path: 'A',
    type: 'regular_comment',
    decision: 'awaiting_maintainer',
    markerReply:
      '**Awaiting maintainer decision** — awaiting CODEOWNER response',
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.issues.some((msg) => msg.includes('non-null threadResolved')),
  );
});

test('checkPathAItem: null decision → fail', () => {
  const result = checkPathAItem({
    id: 'a11',
    path: 'A',
    type: 'review_thread',
    decision: null,
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

test('checkPathAItem: unknown decision value → fail', () => {
  const result = checkPathAItem({
    id: 'a12',
    path: 'A',
    type: 'review_thread',
    decision: 'approve',
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

// ─── checkPathBItem ───────────────────────────────────────────────────────────

test('checkPathBItem: Accepted — marker + resolved thread → pass', () => {
  const result = checkPathBItem({
    id: 'b1',
    path: 'B',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: '**Accepted** — advisory confirmed the approach',
    threadResolved: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.markerPresent, true);
  assert.equal(result.checks.markerMatchesDecision, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathBItem: Rejected — marker + resolved thread → pass', () => {
  const result = checkPathBItem({
    id: 'b2',
    path: 'B',
    type: 'review_thread',
    decision: 'rejected',
    markerReply: '**Rejected** — no action required',
    threadResolved: true,
  });
  assert.equal(result.passed, true);
});

test('checkPathBItem: no marker → fail', () => {
  const result = checkPathBItem({
    id: 'b3',
    path: 'B',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test('checkPathBItem: marker but unresolved thread → fail', () => {
  const result = checkPathBItem({
    id: 'b4',
    path: 'B',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: '**Accepted** — confirmed',
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test('checkPathBItem: regular_comment — marker + null threadResolved → pass', () => {
  const result = checkPathBItem({
    id: 'b5',
    path: 'B',
    type: 'regular_comment',
    decision: 'accepted',
    markerReply: '**Accepted** — advisory confirmed',
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test('checkPathBItem: review_thread — resolved but no marker → fail', () => {
  const result = checkPathBItem({
    id: 'b6',
    path: 'B',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test('checkPathBItem: marker type mismatch (accepted decision, rejected marker) → fail', () => {
  const result = checkPathBItem({
    id: 'b7',
    path: 'B',
    type: 'review_thread',
    decision: 'accepted',
    markerReply: '**Rejected** — no action',
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerMatchesDecision, false);
});

test('checkPathBItem: awaiting_maintainer decision → fail (invalid for PATH B)', () => {
  const result = checkPathBItem({
    id: 'b8',
    path: 'B',
    type: 'review_thread',
    decision: 'awaiting_maintainer',
    markerReply: '**Awaiting maintainer decision** — ...',
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

test('checkPathBItem: regular_comment with non-null threadResolved → fail', () => {
  const result = checkPathBItem({
    id: 'b10',
    path: 'B',
    type: 'regular_comment',
    decision: 'accepted',
    markerReply: '**Accepted** — confirmed',
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.issues.some((msg) => msg.includes('non-null threadResolved')),
  );
});

test('checkPathBItem: null decision → fail', () => {
  const result = checkPathBItem({
    id: 'b9',
    path: 'B',
    type: 'review_thread',
    decision: null,
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

// ─── verifyDispositions ───────────────────────────────────────────────────────

test('verifyDispositions: empty array → passed: true', () => {
  const result = verifyDispositions([]);
  assert.equal(result.passed, true);
  assert.equal(result.totalCount, 0);
  assert.equal(result.passedCount, 0);
  assert.equal(result.failedCount, 0);
});

test('verifyDispositions: all passing items → passed: true', () => {
  const items = [
    {
      id: 'x1',
      path: 'A',
      type: 'review_thread',
      decision: 'accepted',
      markerReply: null,
      threadResolved: null,
    },
    {
      id: 'x2',
      path: 'B',
      type: 'review_thread',
      decision: 'accepted',
      markerReply: '**Accepted** — confirmed',
      threadResolved: true,
    },
  ];
  const result = verifyDispositions(items);
  assert.equal(result.passed, true);
  assert.equal(result.passedCount, 2);
  assert.equal(result.failedCount, 0);
});

test('verifyDispositions: mixed with one failure → passed: false', () => {
  const items = [
    {
      id: 'y1',
      path: 'A',
      type: 'review_thread',
      decision: 'accepted',
      markerReply: null,
      threadResolved: null,
    },
    {
      id: 'y2',
      path: 'B',
      type: 'review_thread',
      decision: 'accepted',
      markerReply: null,
      threadResolved: true,
    },
  ];
  const result = verifyDispositions(items);
  assert.equal(result.passed, false);
  assert.equal(result.passedCount, 1);
  assert.equal(result.failedCount, 1);
});

test('verifyDispositions: unknown path → fail item', () => {
  const result = verifyDispositions([
    {
      id: 'z1',
      path: 'C',
      type: 'review_thread',
      decision: 'accepted',
      markerReply: null,
      threadResolved: null,
    },
  ]);
  assert.equal(result.passed, false);
  const item = result.items[0];
  assert.ok(item.issues.some((msg) => msg.includes('Unknown path value')));
});

test('verifyDispositions: throws on non-array input', () => {
  assert.throws(() => verifyDispositions(null), TypeError);
  assert.throws(() => verifyDispositions({ items: [] }), TypeError);
});

// ─── CLI parsing (#1501: migrated onto the shared parseCliArgs wrapper) ───────

test('CLI: a correct --items invocation matches verifyDispositions directly', () => {
  const items = [
    {
      id: 'p1',
      path: 'A',
      type: 'regular_comment',
      decision: 'accepted',
      markerReply: null,
      threadResolved: null,
    },
  ];
  const expected = `${JSON.stringify(verifyDispositions(items), null, 2)}\n`;
  const actual = execFileSync(
    process.execPath,
    [CLI_PATH, '--items', JSON.stringify(items)],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(actual, expected);
});

test('CLI: missing --items value exits non-zero', () => {
  const { stderr } = runCliExpectFailure(['--items']);
  assert.match(stderr, /missing value for argument: --items/);
});

test('CLI: a flag-shaped --items value exits non-zero', () => {
  const { stderr } = runCliExpectFailure(['--items', '--help']);
  assert.match(stderr, /missing value for argument: --items/);
});

test('CLI: an unknown flag exits non-zero', () => {
  const { stderr } = runCliExpectFailure(['--bogus']);
  assert.match(stderr, /unknown argument: --bogus/);
});

test('CLI: --items is required when omitted entirely', () => {
  const { stderr } = runCliExpectFailure([]);
  assert.match(stderr, /--items is required/);
});

test('CLI: --help prints usage and exits 0', () => {
  const output = runCli(['--help']);
  assert.match(output, /^Usage:/);
  assert.match(
    output,
    /node scripts\/review-disposition-verify\.mjs --items '<json>' \[--help\]/,
  );
});
