import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMarkerBody,
  MARKER_TYPES,
  parseArgs,
} from '../src/scripts/post-idd-marker.mts';
import {
  operationalMarkerPrefix,
  parseClaimComment,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from '../src/scripts/protocol-helpers.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';

// A real 40-hex SHA — the watermark/baseline/advisory renderers require it.
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TS = '2026-06-17T09:47:08Z';

const schema = loadJson('schemas/post-idd-marker.schema.json');

test('schema uses only supported keywords', () => {
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('buildMarkerBody renders the exact claim body (reuses renderClaimedByMarker)', () => {
  assert.equal(
    buildMarkerBody('claim', {
      'agent-id': 'claude-417b737f',
      'claim-id': 'c3009f22b5f6',
      supersedes: 'none',
      timestamp: TS,
      branch: 'issue/1047-add-post-idd-marker-write-side-helper',
    }),
    '<!-- claimed-by: claude-417b737f c3009f22b5f6 supersedes: none 2026-06-17T09:47:08Z branch: issue/1047-add-post-idd-marker-write-side-helper -->\n\n_claude-417b737f: issue claim — IDD automation marker. Do not edit._',
  );
});

test('buildMarkerBody renders the exact unclaim body', () => {
  assert.equal(
    buildMarkerBody('unclaim', {
      'agent-id': 'claude-417b737f',
      'claim-id': 'c3009f22b5f6',
      timestamp: TS,
    }),
    '<!-- unclaimed-by: claude-417b737f c3009f22b5f6 2026-06-17T09:47:08Z -->\n\n_claude-417b737f: issue claim released — IDD automation marker. Do not edit._',
  );
});

test('buildMarkerBody renders the exact watermark body (reuses renderReviewWatermarkMarker)', () => {
  assert.equal(
    buildMarkerBody('watermark', {
      'agent-id': 'a',
      'claim-id': 'c',
      'head-sha': SHA,
      'max-activity-at': 'none',
      'total-item-count': '0',
      'ci-completed-at': 'none',
    }),
    `<!-- review-watermark: a c ${SHA} none 0 none -->\n\n_a: review triage snapshot — IDD automation marker. Do not edit._`,
  );
});

test('buildMarkerBody renders the exact baseline body (reuses renderReviewBaselineMarker)', () => {
  assert.equal(
    buildMarkerBody('baseline', { 'agent-id': 'a', 'claim-id': 'c', sha: SHA }),
    `<!-- review-baseline: a c ${SHA} -->\n\n_a: critique baseline — IDD automation marker. Do not edit._`,
  );
});

test('buildMarkerBody renders advisory markers as plain text with no visible note', () => {
  const advisory = buildMarkerBody('advisory', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.equal(advisory, `advisory-wait: claude-417b737f ${SHA} ${TS}`);
  // Plain-text canonical form: no HTML comment and no visible note, so the
  // AW2 / shell-fallback recognizers (anchored on `\s*$`) still match.
  assert.doesNotMatch(advisory, /<!--/);
  assert.doesNotMatch(advisory, /\n/);

  const recovery = buildMarkerBody('advisory-recovery', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.equal(
    recovery,
    `advisory-wait-recovery: claude-417b737f ${SHA} ${TS}`,
  );
  assert.doesNotMatch(recovery, /<!--/);
});

test('buildMarkerBody normalizes an upper-case head SHA for advisory markers', () => {
  assert.equal(
    buildMarkerBody('advisory', {
      'agent-id': 'a',
      'head-sha': SHA.toUpperCase(),
      timestamp: TS,
    }),
    `advisory-wait: a ${SHA} ${TS}`,
  );
});

// The helper's central guarantee is that what it POSTs is what the IDD
// parsers/recognizers accept. These round-trip assertions guard against future
// renderer/parser drift (the failure mode behind several past gate bugs).
const CREATED_AT = '2026-06-25T13:48:09Z';

test('claim body round-trips through parseClaimComment (non-none supersedes)', () => {
  const body = buildMarkerBody('claim', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'c3009f22b5f6',
    supersedes: 'prior9',
    timestamp: TS,
    branch: 'issue/1047-foo',
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- claimed-by:');
  assert.deepEqual(parseClaimComment(body, CREATED_AT), {
    agentId: 'claude-417b737f',
    claimId: 'c3009f22b5f6',
    supersedes: 'prior9',
    branch: 'issue/1047-foo',
    createdAt: CREATED_AT,
  });
});

test('unclaim body round-trips through parseReleaseComment', () => {
  const body = buildMarkerBody('unclaim', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'c3009f22b5f6',
    timestamp: TS,
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- unclaimed-by:');
  assert.deepEqual(parseReleaseComment(body), {
    agentId: 'claude-417b737f',
    claimId: 'c3009f22b5f6',
  });
});

test('watermark body round-trips through parseReviewWatermarkComment (real ISO + non-zero count)', () => {
  const body = buildMarkerBody('watermark', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'c3009f22b5f6',
    'head-sha': SHA,
    'max-activity-at': '2026-06-25T12:00:00Z',
    'total-item-count': '7',
    'ci-completed-at': '2026-06-25T11:59:00Z',
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- review-watermark:');
  assert.deepEqual(parseReviewWatermarkComment(body, CREATED_AT), {
    agentId: 'claude-417b737f',
    claimId: 'c3009f22b5f6',
    headSha: SHA,
    maxActivityUpdatedAt: '2026-06-25T12:00:00Z',
    totalItemCount: 7,
    latestCiCompletedAt: '2026-06-25T11:59:00Z',
    createdAt: CREATED_AT,
  });
});

test('advisory markers are recognized by operationalMarkerPrefix', () => {
  assert.equal(
    operationalMarkerPrefix(
      buildMarkerBody('advisory', {
        'agent-id': 'a',
        'head-sha': SHA,
        timestamp: TS,
      }),
    ),
    'advisory-wait:',
  );
  assert.equal(
    operationalMarkerPrefix(
      buildMarkerBody('advisory-recovery', {
        'agent-id': 'a',
        'head-sha': SHA,
        timestamp: TS,
      }),
    ),
    'advisory-wait-recovery:',
  );
});

test('buildMarkerBody throws on an unknown type', () => {
  assert.throws(() => buildMarkerBody('bogus', {}), /must be one of/);
});

test('buildMarkerBody throws on an invalid field set (renderer validation)', () => {
  // Missing branch for a claim.
  assert.throws(
    () =>
      buildMarkerBody('claim', {
        'agent-id': 'a',
        'claim-id': 'c',
        timestamp: TS,
      }),
    /invalid claimed-by marker payload/,
  );
  // Non-hex head SHA for an advisory marker.
  assert.throws(
    () =>
      buildMarkerBody('advisory', {
        'agent-id': 'a',
        'head-sha': 'not-a-sha',
        timestamp: TS,
      }),
    /invalid advisory-wait marker payload/,
  );
  // Missing timestamp for an unclaim.
  assert.throws(
    () => buildMarkerBody('unclaim', { 'agent-id': 'a', 'claim-id': 'c' }),
    /invalid unclaimed-by marker payload/,
  );
});

test('MARKER_TYPES lists exactly the six supported types', () => {
  assert.deepEqual(
    [...MARKER_TYPES],
    [
      'claim',
      'unclaim',
      'watermark',
      'baseline',
      'advisory',
      'advisory-recovery',
    ],
  );
});

test('parseArgs reads structural flags, the positional number, and renderer fields', () => {
  const args = parseArgs([
    '--type',
    'claim',
    '--target',
    'issue',
    '1047',
    '--agent-id',
    'claude-417b737f',
    '--claim-id',
    'c3009f22b5f6',
    '--branch',
    'issue/1047-foo',
    '--apply',
  ]);
  assert.equal(args.type, 'claim');
  assert.equal(args.target, 'issue');
  assert.equal(args.number, 1047);
  assert.equal(args.apply, true);
  assert.deepEqual(args.fields, {
    'agent-id': 'claude-417b737f',
    'claim-id': 'c3009f22b5f6',
    branch: 'issue/1047-foo',
  });
});

test('parseArgs rejects a second positional, non-numeric, and suffixed numbers', () => {
  assert.throws(() => parseArgs(['1047', '2048']), /unexpected positional/);
  assert.throws(() => parseArgs(['not-a-number']), /invalid issue\/PR number/);
  // A numeric prefix plus a typo/suffix must fail closed, not parse to 1047 —
  // otherwise --apply could post the marker to the wrong target.
  assert.throws(() => parseArgs(['1047abc']), /invalid issue\/PR number/);
  assert.throws(() => parseArgs(['1047-draft']), /invalid issue\/PR number/);
  assert.throws(() => parseArgs(['0']), /invalid issue\/PR number/);
});

test('a dry-run envelope validates against the schema', () => {
  const envelope = {
    mode: 'dry-run',
    type: 'advisory',
    target: 'pr',
    number: 1047,
    body: `advisory-wait: a ${SHA} ${TS}`,
  };
  assert.deepEqual(validate(envelope, schema), []);
});

test('an apply envelope validates against the schema', () => {
  const envelope = {
    mode: 'apply',
    type: 'claim',
    target: 'issue',
    number: 1047,
    commentId: 4800026123,
    url: 'https://github.com/kurone-kito/idd-skill/issues/1047#issuecomment-4800026123',
  };
  assert.deepEqual(validate(envelope, schema), []);
});

test('the schema rejects an unknown field and a missing required field', () => {
  assert.notDeepEqual(
    validate(
      { mode: 'dry-run', type: 'claim', target: 'issue', number: 1, extra: 1 },
      schema,
    ),
    [],
  );
  assert.notDeepEqual(
    validate({ mode: 'dry-run', type: 'claim', target: 'issue' }, schema),
    [],
  );
});
