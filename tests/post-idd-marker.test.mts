import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMarkerBody,
  describeUnaddressedActivity,
  FROM_PR_MARKER_TYPES,
  MARKER_TYPES,
  parseArgs,
  watermarkFieldsFromSnapshot,
} from '../src/scripts/post-idd-marker.mts';
import {
  operationalMarkerPrefix,
  parseActivationNonceComment,
  parseAdvisoryRecoveryComment,
  parseClaimComment,
  parseCopilotUnavailableComment,
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

// #1833: the exact `describeUnaddressedActivity` warning text for the
// `writeReviewActivitySnapshotGhStub` / inline "--from-pr CLI composes..."
// fixture's one plain, never-dispositioned comment (`body: 'hi'`).
const NO_DISPOSITION_EVIDENCE_WARNING_ONE_COMMENT =
  '1 comment has no disposition evidence as of this watermark, but its ' +
  'max-activity-at/total-item-count already cover it -- dispose it ' +
  '(or re-run --from-pr after doing so) before relying on this watermark.';

const schema = loadJson('schemas/post-idd-marker.schema.json');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

test('buildMarkerBody renders the exact activation-nonce body (reuses renderActivationNonceMarker)', () => {
  assert.equal(
    buildMarkerBody('activation-nonce', {
      'agent-id': 'claude-417b737f',
      'claim-id': 'c3009f22b5f6',
      nonce: 'n-9f6885e3',
      timestamp: TS,
    }),
    '<!-- activation-nonce: claude-417b737f c3009f22b5f6 n-9f6885e3 2026-06-17T09:47:08Z -->\n\n_claude-417b737f: claim activation nonce — IDD automation marker. Do not edit._',
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

  // #1511: bounded same-HEAD advisory reroll marker -- same plain-text
  // shape, distinct prefix (never counted toward advisory-wait's
  // REQUEST_CAP).
  const reroll = buildMarkerBody('advisory-reroll', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.equal(reroll, `advisory-reroll: claude-417b737f ${SHA} ${TS}`);
  assert.doesNotMatch(reroll, /<!--/);
  assert.doesNotMatch(reroll, /\n/);

  // #2050: disposition-aware Clause 1 escape hatch marker -- same plain-text
  // shape as advisory-reroll above.
  const reviewAck = buildMarkerBody('review-ack', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.equal(reviewAck, `review-ack: claude-417b737f ${SHA} ${TS}`);
  assert.doesNotMatch(reviewAck, /<!--/);
  assert.doesNotMatch(reviewAck, /\n/);
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

test('activation-nonce body round-trips through parseActivationNonceComment', () => {
  const body = buildMarkerBody('activation-nonce', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'c3009f22b5f6',
    nonce: 'n-9f6885e3',
    timestamp: TS,
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- activation-nonce:');
  assert.deepEqual(parseActivationNonceComment(body, CREATED_AT), {
    agentId: 'claude-417b737f',
    claimId: 'c3009f22b5f6',
    nonce: 'n-9f6885e3',
    createdAt: CREATED_AT,
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

// --- #1572: extended advisory-recovery binding + new copilot-unavailable ---

test('buildMarkerBody renders the legacy 3-field advisory-recovery body unchanged when claim-id/attempt are absent', () => {
  // Regression guard: the shipped AW3-R recovery flow
  // (idd-advisory-wait.instructions.md) posts exactly this 3-field call
  // today with no claim-id/attempt fields. This must never change.
  assert.equal(
    buildMarkerBody('advisory-recovery', {
      'agent-id': 'claude-417b737f',
      'head-sha': SHA,
      timestamp: TS,
    }),
    `advisory-wait-recovery: claude-417b737f ${SHA} ${TS}`,
  );
});

test('buildMarkerBody renders the bound advisory-recovery body when claim-id and attempt are both present', () => {
  const body = buildMarkerBody('advisory-recovery', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
    'claim-id': 'clm-9f6885e3',
    attempt: '2',
  });
  assert.equal(
    body,
    `advisory-wait-recovery: claude-417b737f ${SHA} ${TS} claim:clm-9f6885e3 attempt:2`,
  );
  assert.doesNotMatch(body, /<!--/);
  assert.doesNotMatch(body, /\n/);
});

test('buildMarkerBody throws on advisory-recovery with only one of claim-id/attempt (half-bound, ambiguous)', () => {
  assert.throws(
    () =>
      buildMarkerBody('advisory-recovery', {
        'agent-id': 'a',
        'head-sha': SHA,
        timestamp: TS,
        'claim-id': 'clm-1',
      }),
    /claimId and attempt must both be provided together/,
  );
  assert.throws(
    () =>
      buildMarkerBody('advisory-recovery', {
        'agent-id': 'a',
        'head-sha': SHA,
        timestamp: TS,
        attempt: '1',
      }),
    /claimId and attempt must both be provided together/,
  );
});

test('the bound advisory-recovery body round-trips through parseAdvisoryRecoveryComment', () => {
  const body = buildMarkerBody('advisory-recovery', {
    'agent-id': 'claude-417b737f',
    'head-sha': SHA,
    timestamp: TS,
    'claim-id': 'clm-9f6885e3',
    attempt: '2',
  });
  assert.deepEqual(parseAdvisoryRecoveryComment(body, CREATED_AT), {
    agentId: 'claude-417b737f',
    headSha: SHA,
    timestamp: TS,
    claimId: 'clm-9f6885e3',
    attempt: 2,
    createdAt: CREATED_AT,
  });
});

test('parseAdvisoryRecoveryComment returns null for the legacy unbound 3-field form', () => {
  // The legacy form is still a well-formed, recognized operational marker
  // (see the round-trip test below) but is not usable recovery-cycle
  // evidence -- excluded from counting/anchoring, not from recognition.
  const legacyBody = buildMarkerBody('advisory-recovery', {
    'agent-id': 'a',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.equal(parseAdvisoryRecoveryComment(legacyBody, CREATED_AT), null);
});

test('the legacy unbound advisory-recovery body is still recognized by operationalMarkerPrefix', () => {
  const legacyBody = buildMarkerBody('advisory-recovery', {
    'agent-id': 'a',
    'head-sha': SHA,
    timestamp: TS,
  });
  const boundBody = buildMarkerBody('advisory-recovery', {
    'agent-id': 'a',
    'head-sha': SHA,
    timestamp: TS,
    'claim-id': 'clm-1',
    attempt: '1',
  });
  assert.equal(operationalMarkerPrefix(legacyBody), 'advisory-wait-recovery:');
  assert.equal(operationalMarkerPrefix(boundBody), 'advisory-wait-recovery:');
});

test('buildMarkerBody renders the copilot-unavailable body (all fields required)', () => {
  const body = buildMarkerBody('copilot-unavailable', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'clm-9f6885e3',
    'head-sha': SHA,
    attempt: '3',
    timestamp: TS,
  });
  assert.equal(
    body,
    `copilot-unavailable: claude-417b737f ${SHA} ${TS} claim:clm-9f6885e3 attempt:3`,
  );
  assert.doesNotMatch(body, /<!--/);
  assert.doesNotMatch(body, /\n/);
});

test('buildMarkerBody throws on copilot-unavailable with any field missing', () => {
  const fullFields = {
    'agent-id': 'a',
    'claim-id': 'c',
    'head-sha': SHA,
    attempt: '1',
    timestamp: TS,
  };
  const fieldNames: Record<string, string> = {
    'agent-id': 'agentId',
    'claim-id': 'claimId',
    'head-sha': 'headSha',
    attempt: 'attempt',
    timestamp: 'timestamp',
  };
  for (const omit of Object.keys(fullFields)) {
    const fields = { ...fullFields };
    delete (fields as Record<string, string>)[omit];
    // #2247: the aggregate guard names the specific failing field, not just
    // the marker kind.
    assert.throws(
      () => buildMarkerBody('copilot-unavailable', fields),
      new RegExp(
        `invalid copilot-unavailable marker payload:.*"${fieldNames[omit]}"`,
      ),
      `omitting ${omit} should throw and name "${fieldNames[omit]}"`,
    );
  }
});

test('the copilot-unavailable body round-trips through parseCopilotUnavailableComment', () => {
  const body = buildMarkerBody('copilot-unavailable', {
    'agent-id': 'claude-417b737f',
    'claim-id': 'clm-9f6885e3',
    'head-sha': SHA,
    attempt: '3',
    timestamp: TS,
  });
  assert.deepEqual(parseCopilotUnavailableComment(body, CREATED_AT), {
    agentId: 'claude-417b737f',
    headSha: SHA,
    timestamp: TS,
    claimId: 'clm-9f6885e3',
    attempt: 3,
    createdAt: CREATED_AT,
  });
  assert.equal(operationalMarkerPrefix(body), 'copilot-unavailable:');
});

test('a fractional-second embedded timestamp is recognized identically by operationalMarkerPrefix and the parse helpers', () => {
  // OPERATIONAL_MARKERS (regex-based recognition) and
  // parseBoundAdvisoryEvidenceMarker (structured field extraction) must
  // agree on where the fractional-seconds group sits (before `Z`, per ISO
  // 8601) -- otherwise a fractional embedded timestamp could be recognized
  // as an operational marker by one path and silently rejected by the
  // other, which would be a fail-open gap in trust-filtering (#1572).
  const fractionalTs = '2026-07-22T14:17:41.123Z';
  const recoveryBody = `advisory-wait-recovery: claude-417b737f ${SHA} ${fractionalTs} claim:clm-9f6885e3 attempt:2`;
  assert.equal(
    operationalMarkerPrefix(recoveryBody),
    'advisory-wait-recovery:',
  );
  assert.deepEqual(parseAdvisoryRecoveryComment(recoveryBody, CREATED_AT), {
    agentId: 'claude-417b737f',
    headSha: SHA,
    timestamp: fractionalTs,
    claimId: 'clm-9f6885e3',
    attempt: 2,
    createdAt: CREATED_AT,
  });

  const unavailableBody = `copilot-unavailable: claude-417b737f ${SHA} ${fractionalTs} claim:clm-9f6885e3 attempt:3`;
  assert.equal(
    operationalMarkerPrefix(unavailableBody),
    'copilot-unavailable:',
  );
  assert.deepEqual(
    parseCopilotUnavailableComment(unavailableBody, CREATED_AT),
    {
      agentId: 'claude-417b737f',
      headSha: SHA,
      timestamp: fractionalTs,
      claimId: 'clm-9f6885e3',
      attempt: 3,
      createdAt: CREATED_AT,
    },
  );
});

test('attempt:0 is rejected by both operationalMarkerPrefix and the parse helpers, for both bound marker types', () => {
  // OPERATIONAL_MARKERS' recognizer patterns and parseBoundAdvisoryEvidenceMarker
  // must agree on requiring a POSITIVE integer attempt -- otherwise a
  // structurally invalid attempt:0 body would be recognized as a
  // well-formed operational marker by the recognizer, then silently
  // rejected by the parser, an inconsistency flagged by Copilot review on
  // PR #1644 (#1572).
  const recoveryZero = `advisory-wait-recovery: claude-417b737f ${SHA} ${TS} claim:clm-9f6885e3 attempt:0`;
  assert.equal(operationalMarkerPrefix(recoveryZero), null);
  assert.equal(parseAdvisoryRecoveryComment(recoveryZero, CREATED_AT), null);

  const unavailableZero = `copilot-unavailable: claude-417b737f ${SHA} ${TS} claim:clm-9f6885e3 attempt:0`;
  assert.equal(operationalMarkerPrefix(unavailableZero), null);
  assert.equal(
    parseCopilotUnavailableComment(unavailableZero, CREATED_AT),
    null,
  );
});

test('copilot-unavailable envelope validates against the post-idd-marker schema', () => {
  const body = buildMarkerBody('copilot-unavailable', {
    'agent-id': 'a',
    'claim-id': 'c',
    'head-sha': SHA,
    attempt: '1',
    timestamp: TS,
  });
  const envelope = {
    mode: 'dry-run',
    type: 'copilot-unavailable',
    target: 'pr',
    number: 1572,
    body,
  };
  assert.deepEqual(validate(envelope, schema), []);
});

test('parseArgs collects --claim-id and --attempt as renderer fields for advisory-recovery', () => {
  const args = parseArgs([
    '--type',
    'advisory-recovery',
    '--target',
    'pr',
    '1572',
    '--agent-id',
    'a',
    '--head-sha',
    SHA,
    '--timestamp',
    TS,
    '--claim-id',
    'clm-1',
    '--attempt',
    '2',
  ]);
  assert.deepEqual(args.fields, {
    'agent-id': 'a',
    'head-sha': SHA,
    timestamp: TS,
    'claim-id': 'clm-1',
    attempt: '2',
  });
});

test('buildMarkerBody throws on an unknown type', () => {
  assert.throws(() => buildMarkerBody('bogus', {}), /must be one of/);
});

test('buildMarkerBody throws on an invalid field set (renderer validation)', () => {
  // #2247: the aggregate guard names the specific failing field, not just
  // the marker kind.
  // Missing branch for a claim.
  assert.throws(
    () =>
      buildMarkerBody('claim', {
        'agent-id': 'a',
        'claim-id': 'c',
        timestamp: TS,
      }),
    /invalid claimed-by marker payload:.*missing "branch"/,
  );
  // Non-hex head SHA for an advisory marker -- present but malformed, so
  // "invalid", not "missing".
  assert.throws(
    () =>
      buildMarkerBody('advisory', {
        'agent-id': 'a',
        'head-sha': 'not-a-sha',
        timestamp: TS,
      }),
    /invalid advisory-wait marker payload:.*invalid "headSha"/,
  );
  // Missing timestamp for an unclaim.
  assert.throws(
    () => buildMarkerBody('unclaim', { 'agent-id': 'a', 'claim-id': 'c' }),
    /invalid unclaimed-by marker payload:.*missing "timestamp"/,
  );
  // Missing nonce for an activation-nonce marker.
  assert.throws(
    () =>
      buildMarkerBody('activation-nonce', {
        'agent-id': 'a',
        'claim-id': 'c',
        timestamp: TS,
      }),
    /invalid activation-nonce marker payload:.*missing "nonce"/,
  );
  // Two failing fields at once, one missing and one malformed, both named
  // together. max-activity-at / ci-completed-at both default to the "none"
  // sentinel when absent (renderer-defaulted, like --supersedes above), so
  // total-item-count is the field genuinely absent here.
  assert.throws(
    () =>
      buildMarkerBody('watermark', {
        'agent-id': 'a',
        'claim-id': 'c',
        'head-sha': 'not-a-sha',
        'max-activity-at': 'none',
        'ci-completed-at': 'none',
      }),
    /invalid review-watermark marker payload:.*missing "totalItemCount".*invalid "headSha"/,
  );
});

test('MARKER_TYPES lists exactly the ten supported types', () => {
  assert.deepEqual(
    [...MARKER_TYPES],
    [
      'claim',
      'unclaim',
      'activation-nonce',
      'watermark',
      'baseline',
      'advisory',
      'advisory-recovery',
      'advisory-reroll',
      'review-ack',
      'copilot-unavailable',
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

test('parseArgs strips a pnpm-forwarded leading -- (#2465), parsing identically to the bare form', () => {
  // This parser is excluded from the shared cli-args.mts parseCliArgs
  // wrapper (see the comment above its declaration), so it must call
  // stripLeadingArgumentSeparator directly rather than inheriting the
  // wrapper's own #1921 stripping.
  const withSeparator = parseArgs([
    '--',
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
  ]);
  const bare = parseArgs([
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
  ]);
  assert.deepEqual(withSeparator, bare);
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

test('an advisory-reroll envelope validates against the schema (PR #1517 review)', () => {
  const envelope = {
    mode: 'dry-run',
    type: 'advisory-reroll',
    target: 'pr',
    number: 1047,
    body: `advisory-reroll: a ${SHA} ${TS}`,
  };
  assert.deepEqual(validate(envelope, schema), []);
});

test('a review-ack envelope validates against the schema (#2050)', () => {
  const envelope = {
    mode: 'dry-run',
    type: 'review-ack',
    target: 'pr',
    number: 1047,
    body: `review-ack: a ${SHA} ${TS}`,
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

test('--apply CLI POSTs via gh api --input - and prints the apply envelope', () => {
  // Stub `gh` on PATH (the discover-roadmap-graph.test.mts pattern) so the
  // --apply POST path is exercised without network access. The stub records its
  // argv and the JSON request body piped to stdin, then returns a comment object.
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-cli-'));
  const ghPath = join(tempRoot, 'gh');
  const argsFile = join(tempRoot, 'gh-args.json');
  const stdinFile = join(tempRoot, 'gh-stdin.txt');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
if (args[0] === 'api' && args.includes('--input') && args[args.indexOf('--input') + 1] === '-') {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify({ id: 4242, html_url: 'https://github.com/o/r/issues/1047#issuecomment-4242' }));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'claim',
      '--target',
      'issue',
      '1047',
      '--owner',
      'o',
      '--repo',
      'r',
      '--agent-id',
      'claude-417b737f',
      '--claim-id',
      'c3009f22b5f6',
      '--supersedes',
      'none',
      '--timestamp',
      TS,
      '--branch',
      'issue/1047-foo',
      '--apply',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
    },
  );

  // (3) apply mode prints the envelope with the created comment id / url.
  assert.deepEqual(JSON.parse(output), {
    mode: 'apply',
    type: 'claim',
    target: 'issue',
    number: 1047,
    commentId: 4242,
    url: 'https://github.com/o/r/issues/1047#issuecomment-4242',
  });

  // (1) the exact gh api arguments (JSON `--input -` path, not `-f body=`).
  assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
    'api',
    '--method',
    'POST',
    'repos/o/r/issues/1047/comments',
    '--input',
    '-',
  ]);

  // (2) the JSON request body piped to stdin carries the exact marker body.
  assert.deepEqual(JSON.parse(readFileSync(stdinFile, 'utf8')), {
    body: buildMarkerBody('claim', {
      'agent-id': 'claude-417b737f',
      'claim-id': 'c3009f22b5f6',
      supersedes: 'none',
      timestamp: TS,
      branch: 'issue/1047-foo',
    }),
  });
});

// --- #1134: --from-pr snapshot-derivation mode for the watermark ---

test('watermarkFieldsFromSnapshot maps the four snapshot fields (real values)', () => {
  assert.deepEqual(
    watermarkFieldsFromSnapshot({
      headSha: SHA,
      totalItemCount: 7,
      maxActivityUpdatedAt: '2026-06-25T12:00:00Z',
      latestPassingCiCompletedAt: '2026-06-25T11:59:00Z',
    }),
    {
      'head-sha': SHA,
      'max-activity-at': '2026-06-25T12:00:00Z',
      'total-item-count': '7',
      'ci-completed-at': '2026-06-25T11:59:00Z',
    },
  );
});

test('watermarkFieldsFromSnapshot uses latestPassingCiCompletedAt, NOT latestCiCompletedAt', () => {
  // A failing/in-progress check can complete AFTER the latest pass, so the two
  // snapshot CI fields differ. The watermark must record the latest *pass*, or
  // F2 review-currency trips a false `ci-pass-drift`.
  const fields = watermarkFieldsFromSnapshot({
    headSha: SHA,
    totalItemCount: 1,
    maxActivityUpdatedAt: 'none',
    latestPassingCiCompletedAt: '2026-06-25T11:00:00Z',
    latestCiCompletedAt: '2026-06-25T11:30:00Z',
  });
  assert.equal(fields['ci-completed-at'], '2026-06-25T11:00:00Z');
});

test('watermarkFieldsFromSnapshot forwards the none sentinel for empty timestamps', () => {
  // The snapshot emits the string `none` (never null) for an empty universe.
  assert.deepEqual(
    watermarkFieldsFromSnapshot({
      headSha: SHA,
      totalItemCount: 0,
      maxActivityUpdatedAt: 'none',
      latestPassingCiCompletedAt: 'none',
    }),
    {
      'head-sha': SHA,
      'max-activity-at': 'none',
      'total-item-count': '0',
      'ci-completed-at': 'none',
    },
  );
});

test('watermarkFieldsFromSnapshot fails closed on a malformed snapshot', () => {
  assert.throws(
    () => watermarkFieldsFromSnapshot({ totalItemCount: 0 }),
    /missing a usable headSha/,
  );
  assert.throws(
    () => watermarkFieldsFromSnapshot({ headSha: SHA }),
    /missing a usable totalItemCount/,
  );
  assert.throws(
    () => watermarkFieldsFromSnapshot({ headSha: SHA, totalItemCount: -1 }),
    /missing a usable totalItemCount/,
  );
  assert.throws(() => watermarkFieldsFromSnapshot(null), /headSha/);
});

test('watermarkFieldsFromSnapshot output round-trips through the watermark parser', () => {
  const body = buildMarkerBody('watermark', {
    'agent-id': 'claude-02f8159e',
    'claim-id': 'claim-1134-02f8159e',
    ...watermarkFieldsFromSnapshot({
      headSha: SHA,
      totalItemCount: 3,
      maxActivityUpdatedAt: '2026-06-25T12:00:00Z',
      latestPassingCiCompletedAt: '2026-06-25T11:59:00Z',
    }),
  });
  assert.deepEqual(parseReviewWatermarkComment(body, CREATED_AT), {
    agentId: 'claude-02f8159e',
    claimId: 'claim-1134-02f8159e',
    headSha: SHA,
    maxActivityUpdatedAt: '2026-06-25T12:00:00Z',
    totalItemCount: 3,
    // The parser stores the 6th field under `latestCiCompletedAt`; pre-merge
    // currency reads it back AS the latest-passing CI time.
    latestCiCompletedAt: '2026-06-25T11:59:00Z',
    createdAt: CREATED_AT,
  });
});

test('parseArgs reads --from-pr and the forwarded snapshot-actor lists', () => {
  const args = parseArgs([
    '--type',
    'watermark',
    '--from-pr',
    '1200',
    '--agent-id',
    'a',
    '--claim-id',
    'c',
    '--trusted-marker-logins',
    'kurone-kito',
    '--apply',
  ]);
  assert.equal(args.fromPr, 1200);
  assert.equal(args.trustedMarkerLogins, 'kurone-kito');
  // --from-pr / --trusted-marker-logins are structural, not renderer fields.
  assert.deepEqual(args.fields, { 'agent-id': 'a', 'claim-id': 'c' });
});

test('parseArgs rejects a non-numeric / suffixed --from-pr', () => {
  assert.throws(
    () => parseArgs(['--from-pr', '1200abc']),
    /invalid --from-pr number/,
  );
  assert.throws(
    () => parseArgs(['--from-pr', '0']),
    /invalid --from-pr number/,
  );
});

// --- #1250: --expected-head-sha pins --from-pr to the Step 1 stored HEAD ---

test('parseArgs reads --expected-head-sha as a structural flag, not a renderer field', () => {
  const args = parseArgs([
    '--type',
    'watermark',
    '--from-pr',
    '1200',
    '--expected-head-sha',
    SHA,
    '--agent-id',
    'a',
    '--claim-id',
    'c',
  ]);
  assert.equal(args.expectedHeadSha, SHA);
  assert.deepEqual(args.fields, { 'agent-id': 'a', 'claim-id': 'c' });
});

// --- #1833: describeUnaddressedActivity (the --from-pr watermark warning) ---

test('describeUnaddressedActivity returns [] when dispositionEvidence is absent', () => {
  assert.deepEqual(describeUnaddressedActivity({}), []);
  assert.deepEqual(describeUnaddressedActivity(null), []);
  assert.deepEqual(describeUnaddressedActivity(undefined), []);
});

test('describeUnaddressedActivity returns [] when both counters are zero', () => {
  assert.deepEqual(
    describeUnaddressedActivity({
      dispositionEvidence: {
        missingRegularCommentCount: 0,
        missingThreadCount: 0,
      },
    }),
    [],
  );
});

test('describeUnaddressedActivity warns (singular) for exactly one missing comment', () => {
  const warnings = describeUnaddressedActivity({
    dispositionEvidence: {
      missingRegularCommentCount: 1,
      missingThreadCount: 0,
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^1 comment has no disposition evidence/);
  // #1833: pronoun must agree with the singular count too (Copilot review on
  // PR #1848 caught the original "cover them -- dispose them" mismatch).
  assert.match(warnings[0], /cover it -- dispose it\b/);
  assert.doesNotMatch(warnings[0], /cover them|dispose them/);
});

test('describeUnaddressedActivity warns (plural) for multiple missing comments', () => {
  const warnings = describeUnaddressedActivity({
    dispositionEvidence: {
      missingRegularCommentCount: 3,
      missingThreadCount: 0,
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^3 comments have no disposition evidence/);
});

test('describeUnaddressedActivity reports both comments and threads together', () => {
  const warnings = describeUnaddressedActivity({
    dispositionEvidence: {
      missingRegularCommentCount: 2,
      missingThreadCount: 1,
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    '2 comments and 1 thread have no disposition evidence as of this ' +
      'watermark, but its max-activity-at/total-item-count already cover ' +
      'them -- dispose them (or re-run --from-pr after doing so) before ' +
      'relying on this watermark.',
  );
});

test('describeUnaddressedActivity reports threads alone (singular)', () => {
  const warnings = describeUnaddressedActivity({
    dispositionEvidence: {
      missingRegularCommentCount: 0,
      missingThreadCount: 1,
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^1 thread has no disposition evidence/);
  assert.match(warnings[0], /cover it -- dispose it\b/);
});

test('describeUnaddressedActivity fails open on negative/non-numeric counters (never throws)', () => {
  assert.deepEqual(
    describeUnaddressedActivity({
      dispositionEvidence: {
        missingRegularCommentCount: -1,
        missingThreadCount: 'not-a-number',
      },
    }),
    [],
  );
});

test('--from-pr CLI composes review-activity-snapshot and prints the derived watermark (dry-run)', () => {
  // Stub `gh` on PATH so the real subprocess composition runs offline: the
  // post-idd-marker.mjs CLI resolves its sibling review-activity-snapshot.mjs,
  // which makes the read calls below; the stub answers each by argv.
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-cli-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') out(JSON.stringify({ headRefOid: '${SHA}', author: { login: 'someone' } }));
if (args[0] === 'pr' && args[1] === 'checks') {
  out(JSON.stringify([{ name: 'ci', state: 'SUCCESS', completedAt: '2026-06-25T11:00:00Z' }]));
}
if (args[0] === 'api' && args[1] === 'graphql') {
  out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));
}
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out('[]');
if (args[0] === 'api' && /\\/comments$/.test(args[1])) {
  out(JSON.stringify([{ body: 'hi', created_at: '2026-06-25T10:00:00Z', updated_at: '2026-06-25T10:30:00Z', user: { login: 'someone' } }]));
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'watermark',
      '--from-pr',
      '1200',
      '--owner',
      'o',
      '--repo',
      'r',
      '--agent-id',
      'claude-02f8159e',
      '--claim-id',
      'claim-1134-02f8159e',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
    },
  );

  assert.deepEqual(JSON.parse(output), {
    mode: 'dry-run',
    type: 'watermark',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('watermark', {
      'agent-id': 'claude-02f8159e',
      'claim-id': 'claim-1134-02f8159e',
      'head-sha': SHA,
      'max-activity-at': '2026-06-25T10:30:00Z',
      'total-item-count': '1',
      'ci-completed-at': '2026-06-25T11:00:00Z',
    }),
    // #1833: the stub's one plain (never-dispositioned) comment has no
    // disposition evidence, so the diagnostic warning fires -- see the
    // dedicated `describeUnaddressedActivity` tests below for the field's
    // own coverage.
    warnings: [NO_DISPOSITION_EVIDENCE_WARNING_ONE_COMMENT],
  });
});

// #1833: end-to-end negative -- when the live snapshot has NO comments at
// all, `dispositionEvidence`'s counters are both zero, so no `warnings` key
// appears in the CLI's own success output (proving the wiring does not fire
// on the routine/empty-PR path, not just that `describeUnaddressedActivity`
// returns `[]` in isolation).
test('--from-pr CLI omits warnings when the live snapshot has nothing missing a disposition', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-no-warning-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') out(JSON.stringify({ headRefOid: '${SHA}', author: { login: 'someone' } }));
if (args[0] === 'pr' && args[1] === 'checks') {
  out(JSON.stringify([{ name: 'ci', state: 'SUCCESS', completedAt: '2026-06-25T11:00:00Z' }]));
}
if (args[0] === 'api' && args[1] === 'graphql') {
  out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));
}
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out('[]');
if (args[0] === 'api' && /\\/comments$/.test(args[1])) out('[]');
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'watermark',
      '--from-pr',
      '1200',
      '--owner',
      'o',
      '--repo',
      'r',
      '--agent-id',
      'claude-02f8159e',
      '--claim-id',
      'claim-1134-02f8159e',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
    },
  );

  const parsed = JSON.parse(output);
  assert.equal('warnings' in parsed, false);
});

/**
 * Build the same offline `gh` stub as the "--from-pr CLI composes..." test
 * above (PR HEAD = `headSha`, one CI pass, no threads, no reviews, one plain
 * comment), so the --expected-head-sha match/mismatch tests below can reuse
 * it without duplicating the stub script.
 */
function writeReviewActivitySnapshotGhStub(
  tempRoot: string,
  headSha: string,
): void {
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') out(JSON.stringify({ headRefOid: '${headSha}', author: { login: 'someone' } }));
if (args[0] === 'pr' && args[1] === 'checks') {
  out(JSON.stringify([{ name: 'ci', state: 'SUCCESS', completedAt: '2026-06-25T11:00:00Z' }]));
}
if (args[0] === 'api' && args[1] === 'graphql') {
  out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));
}
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out('[]');
if (args[0] === 'api' && /\\/comments$/.test(args[1])) {
  out(JSON.stringify([{ body: 'hi', created_at: '2026-06-25T10:00:00Z', updated_at: '2026-06-25T10:30:00Z', user: { login: 'someone' } }]));
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);
}

test('--expected-head-sha lets a matching (even differently-cased) --from-pr snapshot proceed', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-pinned-'));
  writeReviewActivitySnapshotGhStub(tempRoot, SHA);

  const runDryRun = (expectedHeadSha: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
          '--type',
          'watermark',
          '--from-pr',
          '1200',
          '--expected-head-sha',
          expectedHeadSha,
          '--owner',
          'o',
          '--repo',
          'r',
          '--agent-id',
          'claude-02f8159e',
          '--claim-id',
          'claim-1134-02f8159e',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
          },
        },
      ),
    );

  const expected = {
    mode: 'dry-run',
    type: 'watermark',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('watermark', {
      'agent-id': 'claude-02f8159e',
      'claim-id': 'claim-1134-02f8159e',
      'head-sha': SHA,
      'max-activity-at': '2026-06-25T10:30:00Z',
      'total-item-count': '1',
      'ci-completed-at': '2026-06-25T11:00:00Z',
    }),
    // #1833: same one-plain-comment fixture as the "--from-pr CLI
    // composes..." test above (shared stub function).
    warnings: [NO_DISPOSITION_EVIDENCE_WARNING_ONE_COMMENT],
  };

  assert.deepEqual(runDryRun(SHA), expected);
  // Case-insensitive: the Step 1 stored value and the live snapshot value
  // must match regardless of hex-digit casing.
  assert.deepEqual(runDryRun(SHA.toUpperCase()), expected);
});

test('--expected-head-sha fails closed (no post) when the live snapshot HEAD has moved', () => {
  // The branch moved between E1 Step 1 (which stored `staleSha`) and this
  // Step 2 call: the live snapshot now reports SHA. Even with --apply, the
  // CLI must refuse to post rather than silently posting a watermark keyed to
  // a HEAD newer than Step 1 actually snapshotted. If the guard regressed,
  // this would fall through to the stub's POST-call fallback branch, whose
  // "unexpected gh invocation" stderr would fail the message assertion below.
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-drift-'));
  writeReviewActivitySnapshotGhStub(tempRoot, SHA);
  const staleSha = 'fedcba9876543210fedcba9876543210fedcba98';

  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'watermark',
        '--from-pr',
        '1200',
        '--expected-head-sha',
        staleSha,
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--claim-id',
        'c',
        '--apply',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(failure.stderr ?? '', /refusing to post watermark/);
    assert.match(failure.stderr ?? '', new RegExp(staleSha));
    assert.match(failure.stderr ?? '', new RegExp(SHA));
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

// Run the CLI expecting a non-zero exit; return its stderr. These guards fire
// before any `gh` call, so no stub is needed (and `gh` is removed from PATH to
// prove the rejection is argument-only, never a network side effect).
function runCliExpectingFailure(argv: string[]): string {
  try {
    execFileSync(process.execPath, [...argv], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    return failure.stderr ?? '';
  }
  throw new Error('expected the CLI to exit non-zero');
}

test('--from-pr rejects manual snapshot fields as ambiguous (before any gh call)', () => {
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'watermark',
    '--from-pr',
    '1200',
    '--head-sha',
    SHA,
    '--agent-id',
    'a',
    '--claim-id',
    'c',
  ]);
  assert.match(stderr, /--from-pr derives .* do not also pass: --head-sha/);
});

test('--from-pr is rejected for a type outside FROM_PR_MARKER_TYPES', () => {
  // #1889 / #2050: --from-pr now supports watermark AND the advisory-family
  // types (see the dedicated tests below), but a structurally unrelated type
  // like `claim` -- which has no head-sha field at all -- still fails
  // exactly as before.
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'claim',
    '--from-pr',
    '1200',
    '--agent-id',
    'a',
    '--claim-id',
    'c',
  ]);
  assert.match(
    stderr,
    /--from-pr is only valid for --type watermark, advisory, advisory-recovery, advisory-reroll, review-ack/,
  );
});

test('FROM_PR_MARKER_TYPES lists exactly the five --from-pr-supported types', () => {
  assert.deepEqual(FROM_PR_MARKER_TYPES, [
    'watermark',
    'advisory',
    'advisory-recovery',
    'advisory-reroll',
    'review-ack',
  ]);
});

test('--from-pr fails closed on an explicit non-pr --target', () => {
  // A watermark always belongs on the PR; an issue-targeted snapshot watermark
  // is incoherent, so an explicit --target issue is rejected (not defaulted).
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'watermark',
    '--target',
    'issue',
    '--from-pr',
    '1200',
    '--agent-id',
    'a',
    '--claim-id',
    'c',
  ]);
  assert.match(stderr, /--from-pr always targets the PR/);
});

// --- #1889 / #2050: --from-pr live head-sha derivation for the advisory- --
// --- family types ----------------------------------------------------------
//
// Unlike watermark's --from-pr (full review-activity-snapshot composition),
// the advisory-family types derive ONLY --head-sha via a single lightweight
// `gh pr view --json headRefOid --jq .headRefOid` call -- no CI checks,
// review threads, or comment pagination.

/**
 * Stub `gh` on PATH so `headShaFromPr`'s single `gh pr view ... --jq
 * .headRefOid` call resolves offline to `headSha`, without needing the full
 * review-activity-snapshot stub the watermark tests use above. Any other
 * invocation is treated as unexpected (proving the advisory --from-pr path
 * never spawns the heavier snapshot child).
 */
function writeHeadShaOnlyGhStub(tempRoot: string, headSha: string): void {
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
// Tightened to the exact lightweight call shape headShaFromPr() issues
// (--json headRefOid --jq .headRefOid), not any \`gh pr view\` invocation --
// proves the advisory --from-pr path never accidentally requests the
// richer field set the watermark path uses (Copilot review, #1889/#1891).
if (
  args[0] === 'pr' &&
  args[1] === 'view' &&
  args.includes('headRefOid') &&
  args.includes('.headRefOid')
) {
  out('${headSha}\\n');
}
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);
}

function runFromPrCliDryRun(tempRoot: string, argv: string[]): unknown {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), ...argv],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
    },
  );
  return JSON.parse(output);
}

test('--from-pr fails closed with a targeted error when gh pr view returns a non-SHA value', () => {
  // Copilot review (#1889/#1891): headShaFromPr() must not just check for
  // non-empty -- a non-SHA value (e.g. the literal text "null") should fail
  // closed here with a specific message, not fall through to
  // buildMarkerBody's generic "invalid advisory-wait marker payload".
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-bad-sha-'));
  writeHeadShaOnlyGhStub(tempRoot, 'null');

  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'advisory',
        '--from-pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--timestamp',
        TS,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempRoot}:${process.env.PATH ?? ''}`,
        },
      },
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /failed to derive head-sha from PR 1200: PR 1200 has no usable headRefOid \(expected a 40-hex-character SHA, got: null\)/,
    );
    return;
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--from-pr CLI derives only --head-sha for --type advisory (dry-run)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-advisory-'));
  writeHeadShaOnlyGhStub(tempRoot, SHA);

  const result = runFromPrCliDryRun(tempRoot, [
    '--type',
    'advisory',
    '--from-pr',
    '1200',
    '--owner',
    'o',
    '--repo',
    'r',
    '--agent-id',
    'claude-02f8159e',
    '--timestamp',
    TS,
  ]);

  assert.deepEqual(result, {
    mode: 'dry-run',
    type: 'advisory',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('advisory', {
      'agent-id': 'claude-02f8159e',
      'head-sha': SHA,
      timestamp: TS,
    }),
  });
});

test('--from-pr CLI derives only --head-sha for --type advisory-reroll (dry-run)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-reroll-'));
  writeHeadShaOnlyGhStub(tempRoot, SHA);

  const result = runFromPrCliDryRun(tempRoot, [
    '--type',
    'advisory-reroll',
    '--from-pr',
    '1200',
    '--owner',
    'o',
    '--repo',
    'r',
    '--agent-id',
    'claude-02f8159e',
    '--timestamp',
    TS,
  ]);

  assert.deepEqual(result, {
    mode: 'dry-run',
    type: 'advisory-reroll',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('advisory-reroll', {
      'agent-id': 'claude-02f8159e',
      'head-sha': SHA,
      timestamp: TS,
    }),
  });
});

test('--from-pr CLI derives only --head-sha for --type review-ack (dry-run, #2050)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-review-ack-'));
  writeHeadShaOnlyGhStub(tempRoot, SHA);

  const result = runFromPrCliDryRun(tempRoot, [
    '--type',
    'review-ack',
    '--from-pr',
    '1200',
    '--owner',
    'o',
    '--repo',
    'r',
    '--agent-id',
    'claude-02f8159e',
    '--timestamp',
    TS,
  ]);

  assert.deepEqual(result, {
    mode: 'dry-run',
    type: 'review-ack',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('review-ack', {
      'agent-id': 'claude-02f8159e',
      'head-sha': SHA,
      timestamp: TS,
    }),
  });
});

test('--from-pr CLI derives only --head-sha for --type advisory-recovery, legacy 3-field form (dry-run)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-recovery-legacy-'));
  writeHeadShaOnlyGhStub(tempRoot, SHA);

  const result = runFromPrCliDryRun(tempRoot, [
    '--type',
    'advisory-recovery',
    '--from-pr',
    '1200',
    '--owner',
    'o',
    '--repo',
    'r',
    '--agent-id',
    'claude-02f8159e',
    '--timestamp',
    TS,
  ]);

  assert.deepEqual(result, {
    mode: 'dry-run',
    type: 'advisory-recovery',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('advisory-recovery', {
      'agent-id': 'claude-02f8159e',
      'head-sha': SHA,
      timestamp: TS,
    }),
  });
});

test('--from-pr CLI + --claim-id/--attempt still renders the claim-bound advisory-recovery form (dry-run)', () => {
  // #1572's optional claim-bound pairing must keep working unchanged
  // alongside #1889's --from-pr derivation.
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-from-pr-recovery-bound-'));
  writeHeadShaOnlyGhStub(tempRoot, SHA);

  const result = runFromPrCliDryRun(tempRoot, [
    '--type',
    'advisory-recovery',
    '--from-pr',
    '1200',
    '--owner',
    'o',
    '--repo',
    'r',
    '--agent-id',
    'claude-02f8159e',
    '--timestamp',
    TS,
    '--claim-id',
    'claude-8cb5b32f1100',
    '--attempt',
    '2',
  ]);

  assert.deepEqual(result, {
    mode: 'dry-run',
    type: 'advisory-recovery',
    target: 'pr',
    number: 1200,
    body: buildMarkerBody('advisory-recovery', {
      'agent-id': 'claude-02f8159e',
      'head-sha': SHA,
      timestamp: TS,
      'claim-id': 'claude-8cb5b32f1100',
      attempt: '2',
    }),
  });
});

test('--from-pr rejects manual --head-sha as ambiguous for an advisory type (before any gh call)', () => {
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'advisory',
    '--from-pr',
    '1200',
    '--head-sha',
    SHA,
    '--agent-id',
    'a',
    '--timestamp',
    TS,
  ]);
  assert.match(
    stderr,
    /--from-pr derives head-sha from the live PR; do not also pass: --head-sha/,
  );
});

test('--expected-head-sha is rejected together with --from-pr for a non-watermark type', () => {
  // #1889: the E1 Step 1/Step 2 HEAD-pinning concept is watermark-specific;
  // an advisory --from-pr has no Step 1 counterpart to pin against, so the
  // combination fails closed rather than silently ignoring the flag.
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'advisory',
    '--from-pr',
    '1200',
    '--expected-head-sha',
    SHA,
    '--agent-id',
    'a',
    '--timestamp',
    TS,
  ]);
  assert.match(
    stderr,
    /--expected-head-sha is only valid together with --from-pr --type watermark/,
  );
});

test('--from-pr fails closed on an explicit non-pr --target for an advisory type', () => {
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'advisory',
    '--target',
    'issue',
    '--from-pr',
    '1200',
    '--agent-id',
    'a',
    '--timestamp',
    TS,
  ]);
  assert.match(stderr, /--from-pr always targets the PR/);
});

test('--from-pr rejects a positional number that disagrees for an advisory type', () => {
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'advisory',
    '1201',
    '--from-pr',
    '1200',
    '--agent-id',
    'a',
    '--timestamp',
    TS,
  ]);
  assert.match(
    stderr,
    /in --from-pr mode the positional number must be omitted or equal --from-pr/,
  );
});

// --- CLI-layer required-flag validation (#1722) -----------------------------
//
// Before #1722, only --type/--target/the positional number were validated by
// name; a missing per-type renderer field (e.g. --timestamp for --type
// claim) fell through to buildMarkerBody's aggregate guard, surfacing only
// an unattributed "invalid ... marker payload" with no indication of which
// flag was absent. These tests spawn the compiled CLI (reusing
// runCliExpectingFailure above, which also proves the rejection happens
// before any `gh` call by removing `gh` from PATH) and assert the exit code
// and error text name the specific missing flag, for every required flag of
// every marker type the CLI supports.

/** A complete, valid renderer-field set per marker type (excluding the
 * structural --type / --target / positional-number flags), matching
 * REQUIRED_FIELDS_BY_TYPE in post-idd-marker.mts. */
const FULL_FIELDS_BY_TYPE: Record<string, Record<string, string>> = {
  claim: {
    'agent-id': 'a',
    'claim-id': 'c',
    timestamp: TS,
    branch: 'issue/1722-fix',
  },
  unclaim: { 'agent-id': 'a', 'claim-id': 'c', timestamp: TS },
  'activation-nonce': {
    'agent-id': 'a',
    'claim-id': 'c',
    nonce: 'n-1',
    timestamp: TS,
  },
  watermark: {
    'agent-id': 'a',
    'claim-id': 'c',
    'head-sha': SHA,
    'total-item-count': '0',
  },
  baseline: { 'agent-id': 'a', 'claim-id': 'c', sha: SHA },
  advisory: { 'agent-id': 'a', 'head-sha': SHA, timestamp: TS },
  'advisory-recovery': { 'agent-id': 'a', 'head-sha': SHA, timestamp: TS },
  'advisory-reroll': { 'agent-id': 'a', 'head-sha': SHA, timestamp: TS },
  'review-ack': { 'agent-id': 'a', 'head-sha': SHA, timestamp: TS },
  'copilot-unavailable': {
    'agent-id': 'a',
    'claim-id': 'c',
    'head-sha': SHA,
    attempt: '1',
    timestamp: TS,
  },
};

function postIddMarkerArgv(
  type: string,
  fields: Record<string, string>,
): string[] {
  const argv = [
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    type,
    '--target',
    'pr',
    '1722',
  ];
  for (const [flag, value] of Object.entries(fields)) {
    argv.push(`--${flag}`, value);
  }
  return argv;
}

test('post-idd-marker CLI: the full flag set for every marker type succeeds (dry-run)', () => {
  for (const [type, fields] of Object.entries(FULL_FIELDS_BY_TYPE)) {
    const output = execFileSync(
      process.execPath,
      postIddMarkerArgv(type, fields),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, 'dry-run', `${type} should dry-run cleanly`);
    assert.equal(parsed.type, type);
  }
});

test('post-idd-marker CLI: claim without --timestamp names --timestamp (issue example)', () => {
  const { timestamp: _omit, ...rest } = FULL_FIELDS_BY_TYPE.claim;
  const stderr = runCliExpectingFailure(postIddMarkerArgv('claim', rest));
  assert.match(stderr, /--timestamp is required/);
});

test('post-idd-marker CLI: every required flag of every marker type is rejected by name when omitted', () => {
  for (const [type, fields] of Object.entries(FULL_FIELDS_BY_TYPE)) {
    for (const omittedFlag of Object.keys(fields)) {
      const partial = Object.fromEntries(
        Object.entries(fields).filter(([flag]) => flag !== omittedFlag),
      );
      const stderr = runCliExpectingFailure(postIddMarkerArgv(type, partial));
      assert.match(
        stderr,
        new RegExp(`--${omittedFlag} is required`),
        `${type} without --${omittedFlag} should name --${omittedFlag}`,
      );
    }
  }
});

test('post-idd-marker CLI: --supersedes stays optional (renderer-defaulted, not CLI-required)', () => {
  const output = execFileSync(
    process.execPath,
    postIddMarkerArgv('claim', FULL_FIELDS_BY_TYPE.claim),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  assert.match(parsed.body, /supersedes: none /);
});

test('--expected-head-sha is rejected without --from-pr (before any gh call)', () => {
  // In manual mode the caller already supplies --head-sha directly; there is
  // nothing for --expected-head-sha to compare it against.
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'watermark',
    '--target',
    'pr',
    '1200',
    '--expected-head-sha',
    SHA,
    '--agent-id',
    'a',
    '--claim-id',
    'c',
    '--head-sha',
    SHA,
    '--max-activity-at',
    'none',
    '--total-item-count',
    '0',
    '--ci-completed-at',
    'none',
  ]);
  assert.match(
    stderr,
    /--expected-head-sha is only valid together with --from-pr/,
  );
});
