import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseClaimComment,
  parseReviewWatermarkComment,
  renderClaimedByMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
} from '../src/scripts/protocol-helpers.mts';

// A real 40-hex commit SHA — the watermark/claim parsers and the published
// schemas require this exact shape, so the tests must use one.
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TS = '2026-06-17T09:47:08Z';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EMIT_MARKER_CLI = fileURLToPath(
  new URL('../scripts/emit-marker.mjs', import.meta.url),
);

test('renderClaimedByMarker emits the exact claimed-by body', () => {
  assert.equal(
    renderClaimedByMarker({
      agentId: 'claude-1cab217a',
      claimId: 'abc123',
      supersedes: 'none',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'issue/901-add-foo',
    }),
    '<!-- claimed-by: claude-1cab217a abc123 supersedes: none 2026-06-17T09:47:08Z branch: issue/901-add-foo -->\n\n_claude-1cab217a: issue claim — IDD automation marker. Do not edit._',
  );
});

test('renderClaimedByMarker defaults supersedes to none and carries a takeover id', () => {
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: none /,
  );
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      supersedes: 'prior9',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: prior9 /,
  );
});

test('renderClaimedByMarker normalizes any case-variant of the none sentinel', () => {
  // applyClaimEvent only treats `supersedes === 'none'` (exact lowercase) as a
  // fresh claim, so the renderer must fold case-variants down to lowercase.
  for (const variant of ['None', 'NONE', 'nOnE']) {
    assert.match(
      renderClaimedByMarker({
        agentId: 'a',
        claimId: 'c',
        supersedes: variant,
        timestamp: '2026-06-17T09:47:08Z',
        branch: 'b',
      }),
      /supersedes: none /,
    );
  }
  // a real prior claim id (never a case-variant of none) passes through verbatim
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      supersedes: 'AbCdEf12',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: AbCdEf12 /,
  );
});

test('renderReviewWatermarkMarker emits the exact watermark body', () => {
  assert.equal(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      maxActivityAt: '2026-06-17T10:00:00Z',
      totalItemCount: 7,
      ciCompletedAt: '2026-06-17T09:59:00Z',
    }),
    `<!-- review-watermark: a c ${SHA} 2026-06-17T10:00:00Z 7 2026-06-17T09:59:00Z -->\n\n_a: review triage snapshot — IDD automation marker. Do not edit._`,
  );
});

test('renderReviewWatermarkMarker accepts a numeric-string count and defaults none fields', () => {
  assert.equal(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: '0',
    }),
    `<!-- review-watermark: a c ${SHA} none 0 none -->\n\n_a: review triage snapshot — IDD automation marker. Do not edit._`,
  );
});

test('renderReviewWatermarkMarker accepts a count up to the safe-integer max', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.match(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: max,
    }),
    new RegExp(` ${max} none `),
  );
});

test('renderReviewBaselineMarker emits the exact baseline body', () => {
  assert.equal(
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: SHA }),
    `<!-- review-baseline: a c ${SHA} -->\n\n_a: critique baseline — IDD automation marker. Do not edit._`,
  );
});

test('round-trip: rendered claim and watermark bodies satisfy their own parsers', () => {
  const claimBody = renderClaimedByMarker({
    agentId: 'claude-1cab217a',
    claimId: 'abc123',
    supersedes: 'none',
    timestamp: '2026-06-17T09:47:08Z',
    branch: 'issue/901-add-foo',
  });
  assert.ok(
    parseClaimComment(claimBody, '2026-06-17T09:47:08Z'),
    'claimed-by must round-trip',
  );

  const watermarkBody = renderReviewWatermarkMarker({
    agentId: 'a',
    claimId: 'c',
    headSha: SHA,
    maxActivityAt: '2026-06-17T10:00:00Z',
    totalItemCount: 7,
    ciCompletedAt: '2026-06-17T09:59:00Z',
  });
  assert.ok(
    parseReviewWatermarkComment(watermarkBody, '2026-06-17T10:00:00Z'),
    'review-watermark must round-trip',
  );
});

test('renderClaimedByMarker truncates a millisecond-precision timestamp instead of rejecting it (#2592)', () => {
  // A raw Date#toISOString() value -- the idiomatic way to obtain "now" --
  // always carries millisecond precision, and the claimed-by body/parser
  // only accept second precision.
  const claimBody = renderClaimedByMarker({
    agentId: 'claude-1cab217a',
    claimId: 'abc123',
    supersedes: 'none',
    timestamp: '2026-06-17T09:47:08.219Z',
    branch: 'issue/901-add-foo',
  });
  assert.match(claimBody, /2026-06-17T09:47:08Z/);
  assert.ok(
    parseClaimComment(claimBody, '2026-06-17T09:47:08Z'),
    'truncated claimed-by must still round-trip',
  );
});

test('renderers reject payloads that would not round-trip', () => {
  // blank required tokens
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: '',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
  );
  // non-UTC-offset timestamp (#2592: still not a valid ISO8601 UTC value --
  // a fractional-second `…Z` timestamp is truncated and accepted instead of
  // rejected as of #2592; see marker-helpers-timestamp.test.mts)
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08.123+09:00',
      branch: 'b',
    }),
  );
  // branch containing `>` (parser/schema forbid it)
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'feat/>x',
    }),
  );
  // non-40-hex head SHA (watermark parser requires [0-9a-f]{40})
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: 'deadbeef',
      totalItemCount: 0,
    }),
  );
  // non-ISO activity timestamp
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      maxActivityAt: 'garbage',
      totalItemCount: 0,
    }),
  );
  // non-numeric / negative count
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: 'abc',
    }),
  );
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: -1,
    }),
  );
  // count beyond the safe-integer range (watermark parser reads it back with
  // Number.parseInt; a huge digit string or exponential number cannot round-trip)
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: '99999999999999999999',
    }),
  );
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: 1e21,
    }),
  );
  assert.throws(() =>
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: '' }),
  );
  // non-40-hex baseline SHA (baseline tracks HEAD; must be a real commit SHA)
  assert.throws(() =>
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: 'deadbeef' }),
  );
});

// --- CLI-layer required-flag validation (#1722) -----------------------------
//
// Before #1722, `idd-emit-marker` validated only --type by name; every other
// missing flag fell through to the renderer's aggregate guard, surfacing
// only an unattributed "invalid ... marker payload" with no indication of
// which flag was absent. These tests spawn the compiled CLI directly (the
// same pattern tests/post-idd-marker.test.mts already uses) and assert the
// exit code and error text name the specific missing flag, for every
// required flag of every marker type the CLI supports.

/** Run the compiled emit-marker CLI, returning its combined error text
 * (Node writes an uncaught Error's stack -- including its `Error: <message>`
 * line -- to stderr; this helper does not care which stream carries it, only
 * that the flag name appears somewhere in the failure output). Asserts the
 * process exited non-zero. */
function runEmitMarkerExpectingFailure(argv: string[]): string {
  try {
    execFileSync(process.execPath, [EMIT_MARKER_CLI, ...argv], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.notEqual(failure.status, 0);
    return failure.stderr ?? '';
  }
  throw new Error('expected the CLI to exit non-zero');
}

/** A complete, valid flag set per marker type, keyed by the flag names the
 * CLI's own required-field validation should demand for that type. */
const FULL_FLAGS_BY_TYPE: Record<string, Record<string, string>> = {
  'claimed-by': {
    'agent-id': 'a',
    'claim-id': 'c',
    timestamp: TS,
    branch: 'issue/1722-fix',
  },
  'review-watermark': {
    'agent-id': 'a',
    'claim-id': 'c',
    'head-sha': SHA,
    'total-item-count': '0',
  },
  'review-baseline': {
    'agent-id': 'a',
    'claim-id': 'c',
    sha: SHA,
  },
};

function toArgv(type: string, fields: Record<string, string>): string[] {
  const argv = ['--type', type];
  for (const [flag, value] of Object.entries(fields)) {
    argv.push(`--${flag}`, value);
  }
  return argv;
}

test('emit-marker CLI: the full flag set for every marker type succeeds', () => {
  for (const [type, fields] of Object.entries(FULL_FLAGS_BY_TYPE)) {
    const output = execFileSync(
      process.execPath,
      [EMIT_MARKER_CLI, ...toArgv(type, fields)],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.match(output, /^<!--/, `${type} should print a marker body`);
  }
});

test('emit-marker CLI: claimed-by without --timestamp names --timestamp (issue example)', () => {
  const { timestamp: _omit, ...rest } = FULL_FLAGS_BY_TYPE['claimed-by'];
  const stderr = runEmitMarkerExpectingFailure(toArgv('claimed-by', rest));
  assert.match(stderr, /--timestamp is required/);
});

test('emit-marker CLI: every required flag of every marker type is rejected by name when omitted', () => {
  for (const [type, fields] of Object.entries(FULL_FLAGS_BY_TYPE)) {
    for (const omittedFlag of Object.keys(fields)) {
      const partial = Object.fromEntries(
        Object.entries(fields).filter(([flag]) => flag !== omittedFlag),
      );
      const stderr = runEmitMarkerExpectingFailure(toArgv(type, partial));
      assert.match(
        stderr,
        new RegExp(`--${omittedFlag} is required`),
        `${type} without --${omittedFlag} should name --${omittedFlag}`,
      );
    }
  }
});

test('emit-marker CLI: --supersedes / --max-activity-at / --ci-completed-at stay optional (renderer-defaulted, not CLI-required)', () => {
  // These three are deliberately excluded from CLI-layer requireFlag
  // validation: the renderers default an absent/empty value to the `none`
  // sentinel, so requiring them here would reject input the renderer itself
  // accepts (see emit-marker.mts's own comment above the requireFlag calls).
  const claimedByOutput = execFileSync(
    process.execPath,
    [
      EMIT_MARKER_CLI,
      ...toArgv('claimed-by', FULL_FLAGS_BY_TYPE['claimed-by']),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(claimedByOutput, /supersedes: none /);

  const watermarkOutput = execFileSync(
    process.execPath,
    [
      EMIT_MARKER_CLI,
      ...toArgv('review-watermark', FULL_FLAGS_BY_TYPE['review-watermark']),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(watermarkOutput, new RegExp(`${SHA} none 0 none `));
});
