import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMarkerBody,
  describeUnaddressedActivity,
  FROM_PR_MARKER_TYPES,
  findSupersededCopilotUnavailableSubjects,
  findSupersededReviewAckSubjects,
  HIDE_AT_POST_TIME_MARKER_TYPES,
  hideSupersededPostTimeMarkers,
  isHideAtPostTimeMarkerType,
  MARKER_TYPES,
  parseArgs,
  parseIssueReference,
  validateAuthoringOwnerModeDigestCoupling,
  validateAuthoringOwnerSupersedesModeCoupling,
  validateAuthoringPublicationIntentStateIssueCoupling,
  watermarkFieldsFromSnapshot,
} from '../src/scripts/post-idd-marker.mts';
import {
  matchCanonicalAuthoringMarkerFamily,
  operationalMarkerPrefix,
  parseActivationNonceComment,
  parseAdvisoryRecoveryComment,
  parseClaimComment,
  parseCopilotUnavailableComment,
  parseReleaseComment,
  parseReviewAckComment,
  parseReviewWatermarkComment,
} from '../src/scripts/protocol-helpers.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';
import { stubExecutable } from './test-utils.mts';

// A real 40-hex SHA — the watermark/baseline/advisory renderers require it.
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TS = '2026-06-17T09:47:08Z';

// #1833: the exact `describeUnaddressedActivity` warning text for the
// `withReviewActivitySnapshotGhStub` / inline "--from-pr CLI composes..."
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

test('MARKER_TYPES lists exactly the twelve supported types', () => {
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
      'authoring-owner',
      'authoring-publication-intent',
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
  const argsFile = join(tempRoot, 'gh-args.json');
  const stdinFile = join(tempRoot, 'gh-stdin.txt');
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
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
  try {
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
        env: { ...process.env },
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
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

const REVIEW_ACTIVITY_SNAPSHOT_GH_STUB = (
  headSha: string,
) => `const fs = require('node:fs');
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
`;

test('--from-pr CLI composes review-activity-snapshot and prints the derived watermark (dry-run)', () => {
  // Stub `gh` on PATH so the real subprocess composition runs offline: the
  // post-idd-marker.mjs CLI resolves its sibling review-activity-snapshot.mjs,
  // which makes the read calls below; the stub answers each by argv.
  const restore = stubExecutable('gh', REVIEW_ACTIVITY_SNAPSHOT_GH_STUB(SHA));
  try {
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
        env: { ...process.env },
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
  } finally {
    restore();
  }
});

// #1833: end-to-end negative -- when the live snapshot has NO comments at
// all, `dispositionEvidence`'s counters are both zero, so no `warnings` key
// appears in the CLI's own success output (proving the wiring does not fire
// on the routine/empty-PR path, not just that `describeUnaddressedActivity`
// returns `[]` in isolation).
test('--from-pr CLI omits warnings when the live snapshot has nothing missing a disposition', () => {
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
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
  try {
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
        env: { ...process.env },
      },
    );

    const parsed = JSON.parse(output);
    assert.equal('warnings' in parsed, false);
  } finally {
    restore();
  }
});

/**
 * Stub the same offline `gh` behavior as the "--from-pr CLI composes..." test
 * above (PR HEAD = `headSha`, one CI pass, no threads, no reviews, one plain
 * comment), so the --expected-head-sha match/mismatch tests below can reuse
 * it without duplicating the stub script. Returns the cleanup callback.
 */
function withReviewActivitySnapshotGhStub(headSha: string): () => void {
  return stubExecutable('gh', REVIEW_ACTIVITY_SNAPSHOT_GH_STUB(headSha));
}

test('--expected-head-sha lets a matching (even differently-cased) --from-pr snapshot proceed', () => {
  const restore = withReviewActivitySnapshotGhStub(SHA);
  try {
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
            env: { ...process.env },
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
  } finally {
    restore();
  }
});

test('--expected-head-sha fails closed (no post) when the live snapshot HEAD has moved', () => {
  // The branch moved between E1 Step 1 (which stored `staleSha`) and this
  // Step 2 call: the live snapshot now reports SHA. Even with --apply, the
  // CLI must refuse to post rather than silently posting a watermark keyed to
  // a HEAD newer than Step 1 actually snapshotted. If the guard regressed,
  // this would fall through to the stub's POST-call fallback branch, whose
  // "unexpected gh invocation" stderr would fail the message assertion below.
  const restore = withReviewActivitySnapshotGhStub(SHA);
  const staleSha = 'fedcba9876543210fedcba9876543210fedcba98';

  try {
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
          env: { ...process.env },
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
  } finally {
    restore();
  }
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
 * never spawns the heavier snapshot child). Returns the cleanup callback.
 */
function withHeadShaOnlyGhStub(headSha: string): () => void {
  return stubExecutable(
    'gh',
    `const fs = require('node:fs');
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
}

function runFromPrCliDryRun(argv: string[]): unknown {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), ...argv],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env },
    },
  );
  return JSON.parse(output);
}

test('--from-pr fails closed with a targeted error when gh pr view returns a non-SHA value', () => {
  // Copilot review (#1889/#1891): headShaFromPr() must not just check for
  // non-empty -- a non-SHA value (e.g. the literal text "null") should fail
  // closed here with a specific message, not fall through to
  // buildMarkerBody's generic "invalid advisory-wait marker payload".
  const restore = withHeadShaOnlyGhStub('null');
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
        env: { ...process.env },
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
  } finally {
    restore();
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('--from-pr CLI derives only --head-sha for --type advisory (dry-run)', () => {
  const restore = withHeadShaOnlyGhStub(SHA);
  try {
    const result = runFromPrCliDryRun([
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
  } finally {
    restore();
  }
});

test('--from-pr CLI derives only --head-sha for --type advisory-reroll (dry-run)', () => {
  const restore = withHeadShaOnlyGhStub(SHA);
  try {
    const result = runFromPrCliDryRun([
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
  } finally {
    restore();
  }
});

test('--from-pr CLI derives only --head-sha for --type review-ack (dry-run, #2050)', () => {
  const restore = withHeadShaOnlyGhStub(SHA);
  try {
    const result = runFromPrCliDryRun([
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
  } finally {
    restore();
  }
});

test('--from-pr CLI derives only --head-sha for --type advisory-recovery, legacy 3-field form (dry-run)', () => {
  const restore = withHeadShaOnlyGhStub(SHA);
  try {
    const result = runFromPrCliDryRun([
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
  } finally {
    restore();
  }
});

test('--from-pr CLI + --claim-id/--attempt still renders the claim-bound advisory-recovery form (dry-run)', () => {
  // #1572's optional claim-bound pairing must keep working unchanged
  // alongside #1889's --from-pr derivation.
  const restore = withHeadShaOnlyGhStub(SHA);
  try {
    const result = runFromPrCliDryRun([
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
  } finally {
    restore();
  }
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
  // #2931: authoring-owner is deliberately NOT listed here -- unlike every
  // other type, its body-sha256 is derived/verified via a live `gh` fetch
  // BEFORE this file's REQUIRED_FIELDS_BY_TYPE loop even runs, so it cannot
  // share this table's network-free "every flag rejected by name" contract
  // without either a `gh` stub (this table has none) or the `body-sha256:
  // 'none'` sentinel (which would make omitting body-sha256 itself
  // untestable here, since it is optional, not required). See the dedicated
  // authoring-owner CLI tests below instead.
  //
  // authoring-publication-intent is likewise deliberately NOT listed here
  // (#2931, Codex/Copilot review on PR #2937): its --journal must now name
  // the SAME issue this CLI actually posts to (isPostingDestination), but
  // this table's own generic tests drive every type through
  // postIddMarkerArgv's hardcoded `--target pr 1722` with no --owner/
  // --repo, resolving the real current repository -- a fixed --journal
  // value here could never match that for every test environment. See the
  // dedicated authoring-publication-intent CLI tests below (using
  // authoringArgv, which pins the destination explicitly) instead.
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

/**
 * argv builder for authoring-owner / authoring-publication-intent CLI tests
 * (#2931). Unlike postIddMarkerArgv's hardcoded `--target pr 1722` (shared
 * by every OTHER marker type, none of which destination-checks any of
 * their own fields), these two types now require --marker-target /
 * --journal to name the SAME issue this CLI is actually posting to
 * (isPostingDestination, kurone-kito/idd-skill#2931's destination-equality
 * fix). This helper posts to `--target issue <number>` with explicit
 * `--owner`/`--repo` (defaulting to `o`/`r`/`42`, matching
 * AUTHORING_OWNER_FULL_FIELDS's own `o/r#42` marker-target/anchor), so
 * every authoring-type test controls -- and can stub `gh` against -- the
 * exact destination its own fixture already names, without a real `gh repo
 * view` network call ever firing.
 */
function authoringArgv(
  type: string,
  fields: Record<string, string>,
  destination: { number?: number; owner?: string; repo?: string } = {},
): string[] {
  const number = destination.number ?? 42;
  const owner = destination.owner ?? 'o';
  const repo = destination.repo ?? 'r';
  const argv = [
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    type,
    '--target',
    'issue',
    String(number),
    '--owner',
    owner,
    '--repo',
    repo,
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

test('--help marks every REQUIRED_FIELDS_BY_TYPE field as required and every deliberately-optional field as bracketed (#2492)', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  assert.match(
    output,
    /flags in \[brackets\] are optional; every other flag\s*\n\s*listed is required for that type/,
  );
  // claim: --supersedes is deliberately optional (renderer-defaulted).
  assert.match(
    output,
    /claim\s+--agent-id --claim-id \[--supersedes] --timestamp --branch/,
  );
  // watermark: --max-activity-at / --ci-completed-at are deliberately
  // optional (renderer-defaulted); --agent-id / --claim-id / --head-sha /
  // --total-item-count stay unbracketed (required).
  assert.match(
    output,
    /watermark\s+--agent-id --claim-id --head-sha \[--max-activity-at] --total-item-count \[--ci-completed-at]/,
  );
});

test('parseReviewAckComment round-trips renderReviewAckMarker output', () => {
  const body = buildMarkerBody('review-ack', {
    'agent-id': 'a',
    'head-sha': SHA,
    timestamp: TS,
  });
  assert.deepEqual(parseReviewAckComment(body, TS), {
    agentId: 'a',
    headSha: SHA,
    timestamp: TS,
    createdAt: TS,
  });
});

test('parseReviewAckComment returns null for a non-review-ack / malformed body', () => {
  assert.equal(parseReviewAckComment('not a marker', TS), null);
  assert.equal(
    parseReviewAckComment(
      `copilot-unavailable: a ${SHA} ${TS} claim:c attempt:1`,
      TS,
    ),
    null,
  );
});

// --- #2754: hide-at-post-time for review-ack / copilot-unavailable --------

test('HIDE_AT_POST_TIME_MARKER_TYPES lists exactly review-ack and copilot-unavailable', () => {
  assert.deepEqual(HIDE_AT_POST_TIME_MARKER_TYPES, [
    'review-ack',
    'copilot-unavailable',
  ]);
});

test('isHideAtPostTimeMarkerType recognizes only the two hide-at-post-time types', () => {
  assert.equal(isHideAtPostTimeMarkerType('review-ack'), true);
  assert.equal(isHideAtPostTimeMarkerType('copilot-unavailable'), true);
  assert.equal(isHideAtPostTimeMarkerType('claim'), false);
  assert.equal(isHideAtPostTimeMarkerType('advisory-wait'), false);
});

function candidateComment(
  overrides: Partial<{
    id: number;
    nodeId: string;
    body: string;
    authorLogin: string;
  }> = {},
) {
  return {
    id: 1,
    nodeId: 'IC_default',
    body: '',
    authorLogin: 'kurone-kito',
    ...overrides,
  };
}

const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba90';

test('findSupersededReviewAckSubjects hides a prior review-ack whose HEAD SHA differs from the new one', () => {
  const stale = candidateComment({
    id: 1,
    nodeId: 'IC_stale',
    body: `review-ack: a ${OTHER_SHA} ${TS}`,
  });
  assert.deepEqual(findSupersededReviewAckSubjects([stale], SHA), ['IC_stale']);
});

test('findSupersededReviewAckSubjects never hides a review-ack matching the new HEAD SHA (current-HEAD protection)', () => {
  const current = candidateComment({
    id: 2,
    nodeId: 'IC_current',
    body: `review-ack: a ${SHA} ${TS}`,
  });
  assert.deepEqual(findSupersededReviewAckSubjects([current], SHA), []);
});

test('findSupersededReviewAckSubjects ignores a non-review-ack comment and one with no node id', () => {
  const unrelated = candidateComment({
    id: 3,
    nodeId: 'IC_unrelated',
    body: 'just a regular comment',
  });
  const noNodeId = candidateComment({
    id: 4,
    nodeId: '',
    body: `review-ack: a ${OTHER_SHA} ${TS}`,
  });
  assert.deepEqual(
    findSupersededReviewAckSubjects([unrelated, noNodeId], SHA),
    [],
  );
});

const CLAIM_A = 'claim-aaaa';
const CLAIM_B = 'claim-bbbb';

test('findSupersededCopilotUnavailableSubjects hides a prior comment carrying the SAME claim: value and a LOWER attempt', () => {
  const sameClaimEarlierAttempt = candidateComment({
    id: 5,
    nodeId: 'IC_same_claim',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:1`,
  });
  assert.deepEqual(
    findSupersededCopilotUnavailableSubjects(
      [sameClaimEarlierAttempt],
      CLAIM_A,
      2,
    ),
    ['IC_same_claim'],
  );
});

test('findSupersededCopilotUnavailableSubjects never hides a comment whose claim: value differs (foreign-claim protection)', () => {
  const foreignClaim = candidateComment({
    id: 6,
    nodeId: 'IC_foreign_claim',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_B} attempt:1`,
  });
  assert.deepEqual(
    findSupersededCopilotUnavailableSubjects([foreignClaim], CLAIM_A, 2),
    [],
  );
});

test('findSupersededCopilotUnavailableSubjects never hides a same-claim comment whose attempt is >= the new one (#2754, round 5: attempt-ordering protection)', () => {
  // Two same-claim sessions racing on the SAME HEAD (no HEAD drift needed)
  // can still POST out of attempt order -- e.g. attempt 2 lands with a
  // LOWER REST id while a stalled attempt 1 lands with the next one. An
  // attempt-blind filter would let that delayed, regressive attempt 1
  // hide the more advanced attempt 2. A same-attempt candidate (a bare
  // retry of this exact attempt number) is also left alone rather than
  // guessing whether it is a true duplicate -- current-attempt protection,
  // mirroring the live-HEAD gate's own "when ambiguous, never hide" policy
  // for a same-embedded-HEAD review-ack.
  const higherAttempt = candidateComment({
    id: 9,
    nodeId: 'IC_higher_attempt',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:3`,
  });
  const sameAttempt = candidateComment({
    id: 10,
    nodeId: 'IC_same_attempt',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:2`,
  });
  assert.deepEqual(
    findSupersededCopilotUnavailableSubjects(
      [higherAttempt, sameAttempt],
      CLAIM_A,
      2,
    ),
    [],
  );
});

test('findSupersededCopilotUnavailableSubjects trims newClaimId before comparing (#2754, Copilot review on PR #2788)', () => {
  // renderCopilotUnavailableMarker trims claimId before posting, so a
  // caller passing --claim-id with surrounding whitespace still posts the
  // trimmed form -- this finder must trim its own newClaimId the same way,
  // or it would never match the very comment it just posted's own claim.
  const sameClaim = candidateComment({
    id: 5,
    nodeId: 'IC_same_claim_untrimmed',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:1`,
  });
  assert.deepEqual(
    findSupersededCopilotUnavailableSubjects([sameClaim], `  ${CLAIM_A}  `, 2),
    ['IC_same_claim_untrimmed'],
  );
});

test('findSupersededCopilotUnavailableSubjects ignores a non-copilot-unavailable comment and one with no node id', () => {
  const unrelated = candidateComment({
    id: 7,
    nodeId: 'IC_unrelated2',
    body: 'just a regular comment',
  });
  const noNodeId = candidateComment({
    id: 8,
    nodeId: '',
    body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:1`,
  });
  assert.deepEqual(
    findSupersededCopilotUnavailableSubjects([unrelated, noNodeId], CLAIM_A, 2),
    [],
  );
});

/**
 * Stub `gh` on PATH so a full `--apply --type review-ack` or
 * `--apply --type copilot-unavailable` run resolves offline (#2754):
 * dispatches on argv shape across the four distinct `gh` calls this path
 * can issue -- the prior-comments listing (`api .../comments --paginate`),
 * the new marker's own POST (`api --method POST ... --input -`), the
 * minimize-superseded-markers.mts GraphQL probe (`api graphql` with an
 * `id=` variable and no `classifier=`), and its GraphQL mutation (`api
 * graphql` with both `id=` and `classifier=`). `priorComments` seeds the
 * first call's NDJSON response; `probeIndex` (keyed by node id) seeds the
 * probe's per-subject `isMinimized` / `viewerCanMinimize` / `author`
 * fields; `failMutationFor` names node ids whose mutation call exits
 * non-zero (simulating a permission failure) instead of succeeding.
 *
 * Every `graphql` call (probe or mutation) appends one `{id, mutation}`
 * JSON line to `mutationLogFile`, so a test can assert the EXACT set of
 * node ids the mutation actually ran for -- proving a spared or
 * already-minimized candidate never reached `minimizeComment`, not just
 * that the CLI happened to exit 0.
 */
function withHideAtPostTimeGhStub(options: {
  priorComments: {
    id: number;
    node_id: string;
    body: string;
    user: { login: string };
  }[];
  probeIndex: Record<
    string,
    { isMinimized?: boolean; viewerCanMinimize?: boolean; author?: string }
  >;
  mutationLogFile: string;
  failMutationFor?: string[];
  newCommentId?: number;
  /**
   * The `headRefOid` a `gh pr view --json headRefOid --jq .headRefOid` call
   * resolves to (#2754, chatgpt-codex-connector review on PR #2788) --
   * `hideSupersededPostTimeMarkers`'s pre-scan live-HEAD re-read for
   * `review-ack`. Defaults to `SHA` (matching every review-ack test's own
   * `--head-sha`), so existing callers exercising the hide-and-spare /
   * race-condition / permission-failure paths keep passing without a
   * mismatch short-circuiting them.
   */
  liveHeadSha?: string;
  /**
   * `user.login` for the marker comment this call itself just "posted"
   * (`newCommentId`) once it reappears in the post-POST `--paginate`
   * listing (#2754, chatgpt-codex-connector review on PR #2788):
   * `hideSupersededPostTimeMarkers` now re-reads this comment's own author
   * and requires it to be in `trustedSet` before scanning for anything to
   * hide. Defaults to `'kurone-kito'` (the sole trusted login every
   * existing hide-and-spare / race-condition / permission-failure test
   * already passes via `--trusted-marker-logins`), so those callers keep
   * passing without this new gate short-circuiting them.
   */
  postedAuthorLogin?: string;
}): () => void {
  const failMutationFor = options.failMutationFor ?? [];
  const newCommentId = options.newCommentId ?? 9999;
  const postedAuthorLogin = options.postedAuthorLogin ?? 'kurone-kito';
  const listedComments = [
    ...options.priorComments,
    {
      id: newCommentId,
      node_id: 'IC_posted_self',
      body: '(the marker this call itself just posted)',
      user: { login: postedAuthorLogin },
    },
  ];
  return stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const priorComments = ${JSON.stringify(listedComments)};
const probeIndex = ${JSON.stringify(options.probeIndex)};
const failMutationFor = ${JSON.stringify(failMutationFor)};
const newCommentId = ${JSON.stringify(newCommentId)};
const mutationLogFile = ${JSON.stringify(options.mutationLogFile)};
const liveHeadSha = ${JSON.stringify(options.liveHeadSha ?? SHA)};
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid') && args.includes('.headRefOid')) {
  out(liveHeadSha + '\\n');
} else if (args[0] === 'api' && typeof args[1] === 'string' && args[1].indexOf('/comments') !== -1 && args.indexOf('--paginate') !== -1) {
  out(priorComments.map((c) => JSON.stringify(c)).join('\\n') + '\\n');
} else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  fs.readFileSync(0, 'utf8');
  out(JSON.stringify({ id: newCommentId, html_url: 'https://github.com/o/r/issues/1#issuecomment-' + newCommentId }));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const fValues = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-f') fValues.push(args[i + 1]);
  }
  const idEntry = fValues.find((v) => v.indexOf('id=') === 0);
  const classifierEntry = fValues.find((v) => v.indexOf('classifier=') === 0);
  const id = idEntry ? idEntry.slice('id='.length) : '';
  fs.appendFileSync(mutationLogFile, JSON.stringify({ id, mutation: Boolean(classifierEntry) }) + '\\n');
  if (classifierEntry) {
    if (failMutationFor.indexOf(id) !== -1) {
      fail('mutation-error: permission denied');
    }
    out(JSON.stringify({ data: { minimizeComment: { minimizedComment: { __typename: 'IssueComment', isMinimized: true } } } }));
  } else {
    const info = probeIndex[id];
    if (!info) {
      out(JSON.stringify({ data: { node: null } }));
    } else {
      out(JSON.stringify({ data: { node: { __typename: 'IssueComment', url: 'https://github.com/o/r/issues/1#issuecomment-' + id, isMinimized: info.isMinimized || false, viewerCanMinimize: info.viewerCanMinimize !== false, author: { login: info.author || 'kurone-kito' } } } }));
    }
  }
} else {
  fail('unexpected gh invocation: ' + args.join(' '));
}
`,
  );
}

/** Read `logFile`'s `{id, mutation}` JSONL lines and return the SET of node
 * ids that actually reached a `minimizeComment` mutation call (`mutation:
 * true`), deduplicated. Missing file (no `graphql` call at all) reads as
 * empty rather than throwing. */
function readMutatedSubjectIds(logFile: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as { id: string; mutation: boolean };
    if (entry.mutation) {
      ids.add(entry.id);
    }
  }
  return [...ids].sort();
}

test('--apply --type review-ack hides a stale prior review-ack and spares the current-HEAD one (#2754)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-hide-at-post-review-ack-'));
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 100,
        node_id: 'IC_stale_review_ack',
        body: `review-ack: a ${OTHER_SHA} ${TS}`,
        user: { login: 'kurone-kito' },
      },
      {
        id: 101,
        node_id: 'IC_current_review_ack',
        body: `review-ack: a ${SHA} ${TS}`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_stale_review_ack: { author: 'kurone-kito' },
      IC_current_review_ack: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9500,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    // The marker's own POST result is unaffected by the hide step -- it
    // still succeeds and reports the newly created comment.
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'review-ack',
      target: 'pr',
      number: 1200,
      commentId: 9500,
      url: 'https://github.com/o/r/issues/1#issuecomment-9500',
    });
    // The GraphQL mutation actually ran ONLY for the stale (differing-HEAD)
    // comment -- IC_current_review_ack (current-HEAD protection) was never
    // fed to minimizeComment, even though it has a probeIndex entry and
    // would otherwise happily minimize.
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), [
      'IC_stale_review_ack',
    ]);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type review-ack never hides a differing-HEAD-SHA comment created AFTER the marker just posted (#2754, race condition)', () => {
  // Simulates a concurrent session's review-ack landing in the window
  // between this call's own POST and its comments-listing fetch: that
  // comment's REST id is HIGHER than the id this call's own marker just
  // received, even though it surfaces in the same --paginate response.
  // An inequality-only "not this exact comment" filter would wrongly treat
  // it as a prior, superseded candidate purely because its HEAD SHA
  // differs; the `id < postedCommentId` restriction must exclude it
  // regardless.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-review-ack-race-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 9999,
        node_id: 'IC_newer_review_ack',
        body: `review-ack: a ${OTHER_SHA} ${TS}`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_newer_review_ack: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9500,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.equal(JSON.parse(output).commentId, 9500);
    // The higher-id comment (9999 > 9500) was never mutated, even though
    // it has a differing HEAD SHA and a probeIndex entry that would
    // otherwise happily minimize it.
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), []);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type review-ack self-minimizes the just-posted marker when the live PR HEAD no longer matches it (#2754, round 5, chatgpt-codex-connector review)', () => {
  // Simulates the branch advancing between --from-pr's own headRefOid read
  // (embedded in the marker body as SHA) and this call reaching the
  // hide-at-post-time step: a live re-read now reports OTHER_SHA. The
  // `id <` ordering restriction alone cannot tell a stale marker from a
  // fresh one once both are "prior" by id, so scanning for OTHER
  // candidates while stale risks minimizing a genuinely newer, current-
  // HEAD acknowledgement. Round 5 (this test) asserts the step instead
  // self-minimizes the marker THIS call itself just posted -- mirroring
  // sibling #2755's self-minimize behavior for
  // `idd-local-validation-evidence:` -- rather than abandoning it
  // expanded forever (rounds 3-4's behavior, now superseded).
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-review-ack-stale-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [],
    probeIndex: {
      IC_posted_self: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9550,
    liveHeadSha: OTHER_SHA,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    // The marker's own POST result is unaffected: it still succeeds and
    // reports the newly created comment, even though that same comment is
    // then self-minimized as stale (best-effort, #2754).
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'review-ack',
      target: 'pr',
      number: 1200,
      commentId: 9550,
      url: 'https://github.com/o/r/issues/1#issuecomment-9550',
    });
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), [
      'IC_posted_self',
    ]);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type copilot-unavailable also self-minimizes the just-posted marker when the live PR HEAD no longer matches it (#2754, round 5, chatgpt-codex-connector review)', () => {
  // Same stale-HEAD race as the review-ack test above, but for
  // copilot-unavailable: a delayed, stale-HEAD same-claim poster (e.g. a
  // stalled pre-handoff session finally completing its retry) must not
  // treat an earlier, CURRENT-HEAD same-claim comment as "superseded"
  // purely because findSupersededCopilotUnavailableSubjects matches on
  // claim: equality alone, with no HEAD comparison of its own. The
  // live-HEAD gate, unconditional for both types, now self-minimizes
  // THIS call's own just-posted marker instead of scanning for other
  // candidates while stale.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-copilot-unavailable-stale-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [],
    probeIndex: {
      IC_posted_self: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9560,
    liveHeadSha: OTHER_SHA,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'copilot-unavailable',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--claim-id',
        CLAIM_A,
        '--head-sha',
        SHA,
        '--attempt',
        '1',
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'copilot-unavailable',
      target: 'pr',
      number: 1200,
      commentId: 9560,
      url: 'https://github.com/o/r/issues/1#issuecomment-9560',
    });
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), [
      'IC_posted_self',
    ]);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type review-ack never self-minimizes a stale just-posted marker whose own author is untrusted (#2754, round 5)', () => {
  // The trust gate on postedComment applies to the self-minimize path
  // exactly as it already does to the scan-for-others path: an untrusted
  // poster must not trigger ANY mutation, including of its own comment.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-review-ack-stale-untrusted-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [],
    probeIndex: {
      IC_posted_self: { author: 'some-random-bot' },
    },
    mutationLogFile,
    newCommentId: 9551,
    liveHeadSha: OTHER_SHA,
    postedAuthorLogin: 'some-random-bot',
  });
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), []);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type copilot-unavailable hides a prior same-claim comment, spares a foreign-claim one, and is idempotent on an already-minimized candidate (#2754)', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-copilot-unavailable-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 200,
        node_id: 'IC_same_claim_attempt1',
        body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:1`,
        user: { login: 'kurone-kito' },
      },
      {
        id: 201,
        node_id: 'IC_already_minimized',
        body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:2`,
        user: { login: 'kurone-kito' },
      },
      {
        id: 202,
        node_id: 'IC_foreign_claim',
        body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_B} attempt:1`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_same_claim_attempt1: { author: 'kurone-kito' },
      // Already minimized: runMinimize's own probe reports isMinimized
      // true, so this candidate must be skipped (idempotent) -- probed, but
      // never reaches the actual minimizeComment mutation.
      IC_already_minimized: { author: 'kurone-kito', isMinimized: true },
      IC_foreign_claim: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9600,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'copilot-unavailable',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--claim-id',
        CLAIM_A,
        '--head-sha',
        SHA,
        '--attempt',
        '3',
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'copilot-unavailable',
      target: 'pr',
      number: 1200,
      commentId: 9600,
      url: 'https://github.com/o/r/issues/1#issuecomment-9600',
    });
    // The mutation actually ran ONLY for the same-claim, not-yet-minimized
    // candidate -- IC_already_minimized was probed (its isMinimized: true
    // is how runMinimize decides to skip it) but never reached
    // minimizeComment, and IC_foreign_claim (differing claim:) was never a
    // candidate at all.
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), [
      'IC_same_claim_attempt1',
    ]);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type copilot-unavailable never hides a same-claim comment carrying a HIGHER attempt than the one just posted (#2754, round 5, chatgpt-codex-connector review)', () => {
  // Simulates attempt 2 landing FIRST (lower REST id) while a stalled
  // attempt 1 finally lands second (higher id): the `id <` ordering
  // restriction alone would treat attempt 2 as "prior" and, without an
  // attempt-aware filter, this delayed attempt-1 post would hide the more
  // advanced attempt 2, leaving the regressive attempt 1 as the only
  // marker expanded.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-copilot-unavailable-attempt-order-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 300,
        node_id: 'IC_higher_attempt_earlier_post',
        body: `copilot-unavailable: a ${SHA} ${TS} claim:${CLAIM_A} attempt:2`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_higher_attempt_earlier_post: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9650,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'copilot-unavailable',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--claim-id',
        CLAIM_A,
        '--head-sha',
        SHA,
        '--attempt',
        '1',
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'copilot-unavailable',
      target: 'pr',
      number: 1200,
      commentId: 9650,
      url: 'https://github.com/o/r/issues/1#issuecomment-9650',
    });
    // The higher-attempt candidate was never mutated, even though it has
    // a lower id (so it passes the ordering filter) and a probeIndex
    // entry that would otherwise happily minimize it.
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), []);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type review-ack: a minimize-mutation permission failure never blocks the marker post itself (#2754)', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-permission-failure-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 300,
        node_id: 'IC_permission_denied',
        body: `review-ack: a ${OTHER_SHA} ${TS}`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_permission_denied: { author: 'kurone-kito' },
    },
    mutationLogFile,
    failMutationFor: ['IC_permission_denied'],
    newCommentId: 9700,
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    // The mutation "failed" (simulated permission denial) inside the
    // best-effort hide step, but the CLI still exits 0 and reports the
    // marker's own successful POST -- proving the failure never propagated.
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'review-ack',
      target: 'pr',
      number: 1200,
      commentId: 9700,
      url: 'https://github.com/o/r/issues/1#issuecomment-9700',
    });
    // The mutation was genuinely attempted (and failed) for the candidate --
    // proving this is a real permission-failure path, not a candidate list
    // that silently came back empty.
    const mutationAttempts = readFileSync(mutationLogFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; mutation: boolean });
    assert.deepEqual(
      mutationAttempts.filter((entry) => entry.mutation),
      [{ id: 'IC_permission_denied', mutation: true }],
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type review-ack never scans for candidates when the just-posted marker is itself untrusted (#2754, chatgpt-codex-connector review on PR #2788)', () => {
  // An untrusted poster's own new marker is already ignored by downstream
  // trust-filtered consumers -- but without this gate, its mere presence
  // would still drive this scan, and the OLDER trusted candidate below
  // (differing HEAD SHA, so it would otherwise qualify) would still get
  // minimized purely because ITS OWN author is trusted: collapsing the
  // one copy of the marker consumers actually rely on.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-hide-at-post-untrusted-poster-'),
  );
  const mutationLogFile = join(tempRoot, 'mutations.jsonl');
  const restore = withHideAtPostTimeGhStub({
    priorComments: [
      {
        id: 100,
        node_id: 'IC_trusted_stale_review_ack',
        body: `review-ack: a ${OTHER_SHA} ${TS}`,
        user: { login: 'kurone-kito' },
      },
    ],
    probeIndex: {
      IC_trusted_stale_review_ack: { author: 'kurone-kito' },
    },
    mutationLogFile,
    newCommentId: 9800,
    postedAuthorLogin: 'untrusted-stranger',
  });
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'review-ack',
        '--target',
        'pr',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--head-sha',
        SHA,
        '--timestamp',
        TS,
        '--trusted-marker-logins',
        'kurone-kito',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    // The marker's own POST result is unaffected: it still succeeds and
    // reports the newly created comment, even though the hide step bailed
    // out entirely (best-effort, #2754) because ITS OWN author is
    // untrusted.
    assert.deepEqual(JSON.parse(output), {
      mode: 'apply',
      type: 'review-ack',
      target: 'pr',
      number: 1200,
      commentId: 9800,
      url: 'https://github.com/o/r/issues/1#issuecomment-9800',
    });
    // No graphql call reached the probe/mutation stage at all: the trusted
    // stale candidate (which has a valid probeIndex entry and would
    // otherwise happily minimize) was never touched.
    assert.deepEqual(readMutatedSubjectIds(mutationLogFile), []);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// --- #2754, chatgpt-codex-connector review round 3 on PR #2788: the whole
// --- step's own HIDE_STEP_DEADLINE_MS budget, not just runMinimize's pass ---
//
// Round 2 gave runMinimize an internal deadlineMs, but that clock only
// started at ITS OWN entry -- every network call BEFORE it (the review-ack
// live-HEAD re-check, and the comments listing every type makes) stayed
// outside the budget, bounded only by gh-exec.mts's own defaults (30s for
// the HEAD re-check, 120s for the paginated comments listing). These tests
// call the now-exported hideSupersededPostTimeMarkers directly (no CLI
// subprocess spawn) so a real, enforced execFileSync timeout can be
// exercised in well under a second instead of needing 45+ real seconds to
// elapse.

test('hideSupersededPostTimeMarkers makes no gh call at all when deadlineMs is already exhausted at entry (#2754, round 3)', () => {
  const restore = stubExecutable(
    'gh',
    `process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
process.exit(1);
`,
  );
  try {
    assert.doesNotThrow(() => {
      hideSupersededPostTimeMarkers(
        'copilot-unavailable',
        { 'claim-id': CLAIM_A },
        'o',
        'r',
        1200,
        9999,
        'kurone-kito',
        0,
      );
    });
  } finally {
    restore();
  }
});

test('hideSupersededPostTimeMarkers (review-ack) makes no gh call at all when deadlineMs is already exhausted at entry (#2754, round 3)', () => {
  // Unlike runMinimize's entry check (which always lets the first
  // candidate's OWN probe through so the pass makes forward progress),
  // this step's own budget check has no such exemption for its live-HEAD
  // re-check: an already-exhausted budget must skip everything, review-ack
  // included.
  const restore = stubExecutable(
    'gh',
    `process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
process.exit(1);
`,
  );
  try {
    assert.doesNotThrow(() => {
      hideSupersededPostTimeMarkers(
        'review-ack',
        { 'head-sha': SHA },
        'o',
        'r',
        1200,
        9999,
        'kurone-kito',
        0,
      );
    });
  } finally {
    restore();
  }
});

test('hideSupersededPostTimeMarkers enforces its remaining budget on the comments listing itself, not just on runMinimize (#2754, round 3)', () => {
  // The stubbed gh process answers the live-HEAD re-check (now unconditional
  // for both marker types, round 4) instantly with a matching SHA, then
  // sleeps a full real second before answering the --paginate call; a
  // correctly-threaded ~150ms remainder must kill the LATTER call long
  // before that, proving the budget bounds this READ, not merely the later
  // mutation pass (which round 2 already covered).
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid') && args.includes('.headRefOid')) {
  fs.writeSync(1, '${SHA}\\n');
  process.exit(0);
}
if (args[0] === 'api' && typeof args[1] === 'string' && args[1].indexOf('/comments') !== -1 && args.indexOf('--paginate') !== -1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  process.stdout.write('');
  process.exit(0);
}
fail('unexpected gh invocation: ' + args.join(' '));
`,
  );
  const start = Date.now();
  try {
    assert.doesNotThrow(() => {
      hideSupersededPostTimeMarkers(
        'copilot-unavailable',
        { 'claim-id': CLAIM_A, 'head-sha': SHA },
        'o',
        'r',
        1200,
        9999,
        'kurone-kito',
        150,
      );
    });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 900,
      `expected the ~150ms timeout to cut off the 1s stub sleep, took ${elapsed}ms`,
    );
  } finally {
    restore();
  }
});

test('--apply for a marker type outside HIDE_AT_POST_TIME_MARKER_TYPES never lists prior comments (#2754)', () => {
  // A `claim` POST must not trigger the hide-at-post-time comment scan at
  // all -- proven by never invoking the `--paginate` branch this stub would
  // otherwise need to answer (any comments-listing call here falls through
  // to the catch-all "unexpected gh invocation" failure).
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  fs.readFileSync(0, 'utf8');
  out(JSON.stringify({ id: 9800, html_url: 'https://github.com/o/r/issues/1#issuecomment-9800' }));
} else {
  fail('unexpected gh invocation: ' + args.join(' '));
}
`,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'claim',
        '--target',
        'issue',
        '1200',
        '--owner',
        'o',
        '--repo',
        'r',
        '--agent-id',
        'a',
        '--claim-id',
        'c',
        '--supersedes',
        'none',
        '--timestamp',
        TS,
        '--branch',
        'issue/1200-foo',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    assert.equal(JSON.parse(output).commentId, 9800);
  } finally {
    restore();
  }
});

// --- authoring-owner / authoring-publication-intent (#2931) ----------------
//
// post-idd-marker.mjs's byte-exact canonical CLI path for the issue-authoring
// skill's Stage 1/Stage 2 ownership markers (skills/issue-authoring/
// references/contract.md), closing two observed incidents this session
// filed the issue over: kurone-kito/idd-skill#2925's bad body-sha256 from a
// shell-captured `--jq` scalar with a trailing newline, and #2900/#2926/
// #2927's acquire markers using a non-canonical blank-line separator that
// makes matchCanonicalAuthoringMarkerFamily return null for them.

test('buildMarkerBody renders the exact authoring-owner body (reuses renderAuthoringOwnerMarker, #2931)', () => {
  const digest = 'a'.repeat(64);
  assert.equal(
    buildMarkerBody('authoring-owner', {
      'marker-prefix': 'idd-skill',
      'marker-target': 'o/r#42',
      anchor: 'o/r#42',
      mode: 'acquire',
      'marker-owner': 'owner-abc',
      set: 'set-1',
      session: 'session-1',
      'body-sha256': digest,
      'snapshot-sha256': 'none',
      supersedes: 'none',
    }),
    `<!-- idd-skill-authoring-owner: target=o/r#42; anchor=o/r#42; mode=acquire; owner=owner-abc; set=set-1; session=session-1; body-sha256=${digest}; snapshot-sha256=none; supersedes=none -->\n_Issue-authoring ownership marker. Do not edit or delete._`,
  );
});

test('buildMarkerBody renders the exact authoring-publication-intent body (reuses renderAuthoringPublicationIntentMarker, #2931)', () => {
  // #2931 fix: authoring-publication-intent's target=/anchor= are OPAQUE
  // per-set ids (contract.md), NOT <owner>/<repo>#<number> issue
  // references like authoring-owner's -- only journal=/issue= use that
  // shape for this family. Use opaque-looking fixtures throughout this
  // file's authoring-publication-intent tests so they model the contract.
  assert.equal(
    buildMarkerBody('authoring-publication-intent', {
      'marker-prefix': 'idd-skill',
      'marker-target': 'target-abc123',
      anchor: 'anchor-abc123',
      set: 'set-1',
      session: 'session-1',
      token: 'pub-1',
      journal: 'o/r#10',
      issue: 'none',
      actor: 'kurone-kito',
      state: 'pending',
    }),
    '<!-- idd-skill-authoring-publication-intent: target=target-abc123; anchor=anchor-abc123; set=set-1; session=session-1; token=pub-1; journal=o/r#10; issue=none; actor=kurone-kito; state=pending -->\n_Issue-authoring publication-intent record. Do not edit or delete._',
  );
});

test('authoring-owner / authoring-publication-intent bodies round-trip through matchCanonicalAuthoringMarkerFamily (#2931)', () => {
  const ownerBody = buildMarkerBody('authoring-owner', {
    'marker-prefix': 'idd-skill',
    'marker-target': 'o/r#42',
    anchor: 'o/r#42',
    mode: 'acquire',
    'marker-owner': 'owner-abc',
    set: 'set-1',
    session: 'session-1',
    'body-sha256': 'a'.repeat(64),
    'snapshot-sha256': 'none',
    supersedes: 'none',
  });
  assert.equal(
    matchCanonicalAuthoringMarkerFamily(ownerBody, 'idd-skill'),
    'authoring-owner',
  );

  const intentBody = buildMarkerBody('authoring-publication-intent', {
    'marker-prefix': 'idd-skill',
    'marker-target': 'target-abc123',
    anchor: 'anchor-abc123',
    set: 'set-1',
    session: 'session-1',
    token: 'pub-1',
    journal: 'o/r#10',
    issue: 'none',
    actor: 'kurone-kito',
    state: 'pending',
  });
  assert.equal(
    matchCanonicalAuthoringMarkerFamily(intentBody, 'idd-skill'),
    'authoring-publication-intent',
  );
});

test('buildMarkerBody throws on an invalid authoring-owner field set (renderer validation, #2931)', () => {
  assert.throws(
    () => buildMarkerBody('authoring-owner', { 'marker-target': 'o/r#42' }),
    /invalid authoring-owner marker payload/,
  );
});

test('buildMarkerBody throws on an invalid authoring-publication-intent field set (renderer validation, #2931)', () => {
  assert.throws(
    () =>
      buildMarkerBody('authoring-publication-intent', {
        'marker-target': 'target-abc123',
      }),
    /invalid authoring-publication-intent marker payload/,
  );
});

test('parseIssueReference parses <owner>/<repo>#<number> and rejects everything else (#2931)', () => {
  assert.deepEqual(parseIssueReference('kurone-kito/idd-skill#2931'), {
    owner: 'kurone-kito',
    repo: 'idd-skill',
    number: 2931,
  });
  assert.equal(parseIssueReference('kurone-kito/idd-skill'), null);
  assert.equal(parseIssueReference('kurone-kito#2931'), null);
  assert.equal(parseIssueReference('kurone-kito/idd-skill#0'), null);
  assert.equal(parseIssueReference('kurone-kito/idd-skill#2931abc'), null);
  assert.equal(parseIssueReference(''), null);
  // #2931 (Copilot review on PR #2937): the number group has no digit-count
  // upper bound, so a string past Number.MAX_SAFE_INTEGER must still be
  // rejected rather than silently returning an imprecise number.
  assert.equal(
    parseIssueReference(`o/r#${'9'.repeat(300)}`),
    null,
    'a digit run past Number.MAX_SAFE_INTEGER must be rejected',
  );
});

test('validateAuthoringOwnerModeDigestCoupling accepts every contract.md-valid mode/digest-sentinel combination (#2931)', () => {
  const REAL_DIGEST = 'a'.repeat(64);
  for (const mode of [
    'acquire',
    'resume',
    'bootstrap',
    'heartbeat',
    'release',
  ]) {
    assert.equal(
      validateAuthoringOwnerModeDigestCoupling({
        mode,
        'body-sha256': REAL_DIGEST,
        'snapshot-sha256': 'none',
      }),
      null,
      `${mode} + real body-sha256 + snapshot-sha256 none should be valid`,
    );
    assert.equal(
      validateAuthoringOwnerModeDigestCoupling({
        mode,
        'snapshot-sha256': 'none',
      }),
      null,
      `${mode} with body-sha256 omitted (to be auto-derived) should be valid`,
    );
  }
  assert.equal(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-guard',
      'body-sha256': 'none',
      'snapshot-sha256': 'none',
    }),
    null,
  );
  assert.equal(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-complete',
      'body-sha256': 'none',
      'snapshot-sha256': REAL_DIGEST,
    }),
    null,
  );
});

test('validateAuthoringOwnerModeDigestCoupling rejects every contract.md-invalid combination (#2931)', () => {
  const REAL_DIGEST = 'a'.repeat(64);
  // Target modes (acquire/resume/bootstrap/heartbeat/release) reject the
  // anchor-only `none` body-sha256 sentinel.
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'acquire',
      'body-sha256': 'none',
      'snapshot-sha256': 'none',
    }) ?? '',
    /--mode acquire requires a real --body-sha256/,
  );
  // Anchor-only modes reject a real body-sha256...
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-guard',
      'body-sha256': REAL_DIGEST,
      'snapshot-sha256': 'none',
    }) ?? '',
    /--mode release-guard is anchor-only and requires --body-sha256 none/,
  );
  // ...and an OMITTED body-sha256 (which would otherwise trigger the
  // live-fetch auto-derivation meant only for target modes).
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-complete',
      'snapshot-sha256': REAL_DIGEST,
    }) ?? '',
    /--mode release-complete is anchor-only and requires --body-sha256 none/,
  );
  // release-complete rejects snapshot-sha256 none (its whole purpose is
  // carrying a real canonical set snapshot digest).
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-complete',
      'body-sha256': 'none',
      'snapshot-sha256': 'none',
    }) ?? '',
    /--mode release-complete requires a real --snapshot-sha256/,
  );
  // Every other mode rejects a real (non-none) snapshot-sha256 -- only
  // release-complete ever carries one.
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'acquire',
      'body-sha256': REAL_DIGEST,
      'snapshot-sha256': REAL_DIGEST,
    }) ?? '',
    /--mode acquire requires --snapshot-sha256 none/,
  );
  assert.match(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'release-guard',
      'body-sha256': 'none',
      'snapshot-sha256': REAL_DIGEST,
    }) ?? '',
    /--mode release-guard requires --snapshot-sha256 none/,
  );
});

test('validateAuthoringOwnerModeDigestCoupling returns null for an absent/unrecognized mode (left to REQUIRED_FIELDS_BY_TYPE / the renderer)', () => {
  assert.equal(
    validateAuthoringOwnerModeDigestCoupling({
      'body-sha256': 'none',
      'snapshot-sha256': 'none',
    }),
    null,
  );
  assert.equal(
    validateAuthoringOwnerModeDigestCoupling({
      mode: 'not-a-real-mode',
      'body-sha256': 'none',
      'snapshot-sha256': 'none',
    }),
    null,
  );
});

test('validateAuthoringOwnerSupersedesModeCoupling accepts every contract.md-valid mode/supersedes combination (#2931)', () => {
  for (const mode of ['acquire', 'bootstrap']) {
    assert.equal(
      validateAuthoringOwnerSupersedesModeCoupling({
        mode,
        supersedes: 'none',
        'marker-owner': 'owner-new',
      }),
      null,
      `${mode} + supersedes none should be valid`,
    );
  }
  assert.equal(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'resume',
      supersedes: 'owner-old',
      'marker-owner': 'owner-new',
    }),
    null,
    'resume + a real supersedes distinct from marker-owner should be valid',
  );
  for (const mode of [
    'release',
    'heartbeat',
    'release-guard',
    'release-complete',
  ]) {
    assert.equal(
      validateAuthoringOwnerSupersedesModeCoupling({
        mode,
        supersedes: 'owner-abc',
        'marker-owner': 'owner-abc',
      }),
      null,
      `${mode} + supersedes === marker-owner should be valid`,
    );
  }
});

test('validateAuthoringOwnerSupersedesModeCoupling rejects every contract.md-invalid combination (#2931)', () => {
  for (const mode of ['acquire', 'bootstrap']) {
    assert.match(
      validateAuthoringOwnerSupersedesModeCoupling({
        mode,
        supersedes: 'owner-old',
        'marker-owner': 'owner-new',
      }) ?? '',
      new RegExp(`--mode ${mode} requires --supersedes none`),
    );
  }
  assert.match(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'resume',
      supersedes: 'none',
      'marker-owner': 'owner-new',
    }) ?? '',
    /--mode resume requires a real --supersedes/,
  );
  assert.match(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'resume',
      supersedes: 'owner-new',
      'marker-owner': 'owner-new',
    }) ?? '',
    /--mode resume mints a NEW --marker-owner token, so --supersedes .* must differ from --marker-owner/,
  );
  for (const mode of [
    'release',
    'heartbeat',
    'release-guard',
    'release-complete',
  ]) {
    assert.match(
      validateAuthoringOwnerSupersedesModeCoupling({
        mode,
        supersedes: 'owner-other',
        'marker-owner': 'owner-abc',
      }) ?? '',
      new RegExp(
        `--mode ${mode} retains the current owner token, so --supersedes must equal --marker-owner exactly`,
      ),
    );
  }
});

test('validateAuthoringOwnerSupersedesModeCoupling returns null when mode / supersedes / marker-owner is absent (left to REQUIRED_FIELDS_BY_TYPE)', () => {
  assert.equal(
    validateAuthoringOwnerSupersedesModeCoupling({
      supersedes: 'owner-abc',
      'marker-owner': 'owner-abc',
    }),
    null,
    'absent mode should defer to REQUIRED_FIELDS_BY_TYPE',
  );
  assert.equal(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'acquire',
      'marker-owner': 'owner-abc',
    }),
    null,
    'absent supersedes should defer to REQUIRED_FIELDS_BY_TYPE (requireFlag)',
  );
  assert.equal(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'release',
      supersedes: 'owner-abc',
    }),
    null,
    'absent marker-owner should defer to REQUIRED_FIELDS_BY_TYPE (requireFlag)',
  );
  assert.equal(
    validateAuthoringOwnerSupersedesModeCoupling({
      mode: 'not-a-real-mode',
      supersedes: 'owner-abc',
      'marker-owner': 'owner-abc',
    }),
    null,
    "unrecognized mode should defer to the renderer's own mode-enum validation",
  );
});

test('validateAuthoringPublicationIntentStateIssueCoupling accepts every contract.md-valid state/issue combination (#2931)', () => {
  assert.equal(
    validateAuthoringPublicationIntentStateIssueCoupling({
      state: 'pending',
      issue: 'none',
    }),
    null,
    'pending + issue none (pre-create) should be valid',
  );
  assert.equal(
    validateAuthoringPublicationIntentStateIssueCoupling({
      state: 'pending',
      issue: 'o/r#42',
    }),
    null,
    'pending + a real issue (post-create, not yet member) should be valid',
  );
  for (const state of ['member', 'cleanup', 'abandoned']) {
    assert.equal(
      validateAuthoringPublicationIntentStateIssueCoupling({
        state,
        issue: 'o/r#42',
      }),
      null,
      `${state} + a real issue should be valid`,
    );
  }
});

test('validateAuthoringPublicationIntentStateIssueCoupling rejects issue=none at member/cleanup/abandoned (#2931)', () => {
  for (const state of ['member', 'cleanup', 'abandoned']) {
    assert.match(
      validateAuthoringPublicationIntentStateIssueCoupling({
        state,
        issue: 'none',
      }) ?? '',
      new RegExp(`--state ${state} requires a real --issue reference`),
    );
  }
});

test('validateAuthoringPublicationIntentStateIssueCoupling returns null when state / issue is absent (left to REQUIRED_FIELDS_BY_TYPE)', () => {
  assert.equal(
    validateAuthoringPublicationIntentStateIssueCoupling({ issue: 'none' }),
    null,
  );
  assert.equal(
    validateAuthoringPublicationIntentStateIssueCoupling({ state: 'member' }),
    null,
  );
});

test('an authoring-owner envelope validates against the schema (#2931)', () => {
  const envelope = {
    mode: 'dry-run',
    type: 'authoring-owner',
    target: 'issue',
    number: 2931,
    body: buildMarkerBody('authoring-owner', {
      'marker-prefix': 'idd-skill',
      'marker-target': 'o/r#42',
      anchor: 'o/r#42',
      mode: 'acquire',
      'marker-owner': 'owner-abc',
      set: 'set-1',
      session: 'session-1',
      'body-sha256': 'a'.repeat(64),
      'snapshot-sha256': 'none',
      supersedes: 'none',
    }),
  };
  assert.deepEqual(validate(envelope, schema), []);
});

test('an authoring-publication-intent envelope validates against the schema (#2931)', () => {
  const envelope = {
    mode: 'dry-run',
    type: 'authoring-publication-intent',
    target: 'issue',
    number: 2931,
    body: buildMarkerBody('authoring-publication-intent', {
      'marker-prefix': 'idd-skill',
      'marker-target': 'target-abc123',
      anchor: 'anchor-abc123',
      set: 'set-1',
      session: 'session-1',
      token: 'pub-1',
      journal: 'o/r#10',
      issue: 'none',
      actor: 'kurone-kito',
      state: 'pending',
    }),
  };
  assert.deepEqual(validate(envelope, schema), []);
});

/** A complete, valid authoring-owner renderer-field set (excluding the
 * structural --type / --target / positional-number flags). `mode:
 * 'release-guard'` (one of the two anchor-only modes) pairs with
 * `body-sha256: 'none'` -- a deliberate sentinel here that skips the
 * live-fetch derivation/verification path (see REQUIRED_FIELDS_BY_TYPE's
 * own doc comment) so tests reusing this table stay network-free -- per
 * validateAuthoringOwnerModeDigestCoupling's mode/digest-sentinel
 * coupling rule (#2931 C1 review finding: `mode: 'acquire'` paired with
 * `body-sha256: 'none'` is an INVALID combination the CLI now rejects, so
 * this base object must use an anchor-only mode to stay valid). The
 * dedicated live-fetch tests below override BOTH `mode: 'acquire'` (or
 * another target mode) AND `body-sha256` explicitly. */
const AUTHORING_OWNER_FULL_FIELDS: Record<string, string> = {
  'marker-target': 'o/r#42',
  anchor: 'o/r#42',
  mode: 'release-guard',
  'marker-owner': 'owner-abc',
  set: 'set-1',
  session: 'session-1',
  'body-sha256': 'none',
  'snapshot-sha256': 'none',
  // #2931 (Codex review on PR #2937): release-guard RETAINS the current
  // owner token, so contract.md requires supersedes === marker-owner, not
  // none (validateAuthoringOwnerSupersedesModeCoupling) -- the reviewer
  // specifically flagged this fixture's original `supersedes: 'none'` as
  // self-contradictory with its own mode.
  supersedes: 'owner-abc',
};

test("post-idd-marker CLI: authoring-owner's full flag set succeeds (dry-run, --body-sha256 none avoids a live fetch, #2931)", () => {
  const output = execFileSync(
    process.execPath,
    authoringArgv('authoring-owner', AUTHORING_OWNER_FULL_FIELDS),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, 'dry-run');
  assert.equal(parsed.type, 'authoring-owner');
});

test('post-idd-marker CLI: every required flag of authoring-owner other than body-sha256 (optional/auto-derived) is rejected by name when omitted (#2931)', () => {
  for (const omittedFlag of Object.keys(AUTHORING_OWNER_FULL_FIELDS)) {
    if (omittedFlag === 'body-sha256') {
      continue;
    }
    const partial = Object.fromEntries(
      Object.entries(AUTHORING_OWNER_FULL_FIELDS).filter(
        ([flag]) => flag !== omittedFlag,
      ),
    );
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-owner', partial),
    );
    assert.match(
      stderr,
      new RegExp(`--${omittedFlag} is required`),
      `authoring-owner without --${omittedFlag} should name --${omittedFlag}`,
    );
  }
});

/** Stub `gh api repos/<owner>/<repo>/issues/<n>` (the exact call
 * `createGithubProviderAdapter(...).getWorkItem` makes, and thus the
 * authoring-owner body-sha256 live-fetch source, #2931) to return `{ body
 * }`, and fail loudly on any other invocation. */
function stubGhIssueBody(
  owner: string,
  repo: string,
  number: number,
  body: string,
): () => void {
  return stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'repos/${owner}/${repo}/issues/${number}') {
  process.stdout.write(JSON.stringify({ number: ${number}, body: ${JSON.stringify(body)} }));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
}

/** Stub `gh` that fails loudly on ANY invocation -- proves a code path makes
 * no `gh` call at all (#2931). */
function stubGhNeverCalled(): () => void {
  return stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
process.stderr.write('unexpected gh invocation (expected none): ' + args.join(' '));
process.exit(1);
`,
  );
}

test('authoring-owner --body-sha256 none skips the live fetch entirely (anchor-only release-guard convention, #2931)', () => {
  const restore = stubGhNeverCalled();
  try {
    const output = execFileSync(
      process.execPath,
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode: 'release-guard',
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.match(JSON.parse(output).body, /body-sha256=none;/);
  } finally {
    restore();
  }
});

test('authoring-owner CLI derives body-sha256 from a live, JSON-parsed read of --marker-target when omitted (#2931)', () => {
  const LIVE_BODY = 'Fresh live body for #42.';
  const expectedDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    const { 'body-sha256': _omit, ...rest } = AUTHORING_OWNER_FULL_FIELDS;
    const output = execFileSync(
      process.execPath,
      // mode: 'acquire' -- a "target" mode (validateAuthoringOwnerModeDigestCoupling)
      // that requires a real body-sha256, unlike the base table's own
      // anchor-only release-guard default; this test's whole point is
      // exercising the auto-derive path for a real body digest. supersedes:
      // 'none' -- acquire also requires supersedes none
      // (validateAuthoringOwnerSupersedesModeCoupling), unlike the base
      // table's release-guard default (supersedes === marker-owner).
      authoringArgv('authoring-owner', {
        ...rest,
        mode: 'acquire',
        supersedes: 'none',
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.match(
      JSON.parse(output).body,
      new RegExp(`body-sha256=${expectedDigest};`),
    );
  } finally {
    restore();
  }
});

test('authoring-owner CLI verifies an explicit --body-sha256 against a fresh fetch and accepts a match (#2931)', () => {
  const LIVE_BODY = 'Fresh live body for #42.';
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    const output = execFileSync(
      process.execPath,
      // mode: 'acquire' -- release-guard (the base table's own default)
      // requires body-sha256 none, so a real explicit digest needs a
      // "target" mode instead (validateAuthoringOwnerModeDigestCoupling).
      // supersedes: 'none' -- acquire also requires supersedes none
      // (validateAuthoringOwnerSupersedesModeCoupling).
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode: 'acquire',
        supersedes: 'none',
        'body-sha256': correctDigest,
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.match(
      JSON.parse(output).body,
      new RegExp(`body-sha256=${correctDigest};`),
    );
  } finally {
    restore();
  }
});

test('authoring-owner CLI refuses to post when an explicit --body-sha256 does not match a fresh fetch (#2931)', () => {
  const LIVE_BODY = 'Fresh live body for #42.';
  const wrongDigest = 'a'.repeat(64);
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    try {
      execFileSync(
        process.execPath,
        // mode: 'acquire' -- same coupling reason as the match-acceptance
        // test above; a real (even if wrong) digest requires a "target"
        // mode, or the mode/digest coupling check would reject it first
        // for the wrong reason (release-guard forbids a real digest at
        // all) instead of exercising the mismatch-detection path.
        // supersedes: 'none' -- acquire also requires supersedes none.
        authoringArgv('authoring-owner', {
          ...AUTHORING_OWNER_FULL_FIELDS,
          mode: 'acquire',
          supersedes: 'none',
          'body-sha256': wrongDigest,
        }),
        { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      assert.equal(failure.status, 1);
      assert.match(
        failure.stderr ?? '',
        /refusing to post authoring-owner marker/,
      );
      assert.match(failure.stderr ?? '', new RegExp(wrongDigest));
      assert.match(failure.stderr ?? '', new RegExp(correctDigest));
      return;
    }
    throw new Error('expected the CLI to exit non-zero');
  } finally {
    restore();
  }
});

test('authoring-owner CLI refuses an explicit empty --body-sha256 instead of silently treating it as omitted (#2931)', () => {
  // Copilot review on PR #2937: `explicitBodySha256 &&` treated an
  // explicitly supplied EMPTY --body-sha256 '' as omitted (both falsy),
  // silently overwriting it with the freshly computed digest instead of
  // failing closed on the malformed input. util.parseArgs-style manual
  // parsing here stores whatever string follows the flag, including '', so
  // this is directly reachable, not merely theoretical.
  const LIVE_BODY = 'Fresh live body for #42.';
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    try {
      execFileSync(
        process.execPath,
        authoringArgv('authoring-owner', {
          ...AUTHORING_OWNER_FULL_FIELDS,
          mode: 'acquire',
          supersedes: 'none',
          'body-sha256': '',
        }),
        { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      assert.equal(failure.status, 1);
      assert.match(
        failure.stderr ?? '',
        /refusing to post authoring-owner marker/,
      );
      assert.match(failure.stderr ?? '', new RegExp(correctDigest));
      return;
    }
    throw new Error('expected the CLI to exit non-zero');
  } finally {
    restore();
  }
});

test('authoring-owner CLI fails closed with a targeted error when --marker-target is missing, before any gh call (#2931)', () => {
  const { 'marker-target': _omit, ...rest } = AUTHORING_OWNER_FULL_FIELDS;
  const stderr = runCliExpectingFailure(authoringArgv('authoring-owner', rest));
  assert.match(stderr, /--marker-target is required/);
});

test('authoring-owner CLI fails closed on a malformed --marker-target, before any gh call (#2931)', () => {
  const { 'body-sha256': _omit, ...rest } = AUTHORING_OWNER_FULL_FIELDS;
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...rest,
      'marker-target': 'not-a-valid-ref',
    }),
  );
  assert.match(
    stderr,
    /invalid --marker-target value \(expected <owner>\/<repo>#<number>\): not-a-valid-ref/,
  );
});

test('authoring-owner CLI fails closed on a malformed --marker-target EVEN with --body-sha256 none (format check is unconditional, #2931)', () => {
  // Regression guard: an earlier revision only format-checked
  // --marker-target inside the body-sha256 derivation/verification step,
  // so a malformed value slipped through completely unvalidated whenever
  // --body-sha256 none (the anchor-only release-guard/release-complete
  // sentinel) skipped that whole step. The format check must fire
  // regardless of --body-sha256's value.
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      'marker-target': 'not-a-valid-ref',
    }),
  );
  assert.match(
    stderr,
    /invalid --marker-target value \(expected <owner>\/<repo>#<number>\): not-a-valid-ref/,
  );
});

test('authoring-owner CLI fails closed on a malformed --anchor, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      anchor: 'not-a-valid-ref',
    }),
  );
  assert.match(
    stderr,
    /invalid --anchor value \(expected <owner>\/<repo>#<number>\): not-a-valid-ref/,
  );
});

test('authoring-owner CLI refuses a --marker-target that does not match the posting destination, before any gh call (#2931)', () => {
  // Critical Codex/Copilot finding on PR #2937: an unvalidated
  // --marker-target could hash/reference one issue while the append-only
  // comment lands on a completely different one -- corrupting both issues'
  // authoring state permanently.
  const stderr = runCliExpectingFailure(
    authoringArgv(
      'authoring-owner',
      {
        ...AUTHORING_OWNER_FULL_FIELDS,
        'marker-target': 'o/r#99',
        // anchor must match marker-target here too, or release-guard's own
        // anchor-mode coupling check (#2931 round 3) fires first and this
        // test would no longer isolate the destination-equality check.
        anchor: 'o/r#99',
      },
      { number: 42, owner: 'o', repo: 'r' },
    ),
  );
  assert.match(
    stderr,
    /--marker-target o\/r#99 does not match the posting destination o\/r#42/,
  );
});

test('authoring-owner CLI tolerates a mismatching --anchor for a non-anchor-only mode (the set anchor legitimately differs from the posting destination, #2931)', () => {
  // contract.md: "the anchor's own marker uses its target as the anchor,
  // and every other marker in the set repeats the same value" -- a
  // non-anchor member of a multi-target set legitimately posts --anchor
  // naming a DIFFERENT issue (the set anchor) than its own --marker-target.
  // mode: 'acquire' (not release-guard/release-complete) -- #2931 round 3
  // requires target === anchor specifically for the two anchor-only modes,
  // since contract.md says THOSE are "valid only on the set anchor"; every
  // other mode has no such constraint.
  const LIVE_BODY = 'Fresh live body for #42.';
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    const { 'body-sha256': _omit, ...rest } = AUTHORING_OWNER_FULL_FIELDS;
    const output = execFileSync(
      process.execPath,
      authoringArgv('authoring-owner', {
        ...rest,
        mode: 'acquire',
        supersedes: 'none',
        anchor: 'o/r#7',
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const body = JSON.parse(output).body as string;
    assert.match(body, /anchor=o\/r#7;/);
    assert.match(body, new RegExp(`body-sha256=${correctDigest};`));
  } finally {
    restore();
  }
});

test('authoring-owner CLI refuses --mode release-guard/release-complete when --anchor does not match --marker-target, before any gh call (#2931)', () => {
  for (const mode of ['release-guard', 'release-complete']) {
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode,
        'body-sha256': 'none',
        'snapshot-sha256':
          mode === 'release-complete' ? 'a'.repeat(64) : 'none',
        anchor: 'o/r#7',
      }),
    );
    assert.match(
      stderr,
      /is valid only on the set anchor, so --anchor o\/r#7 must name the same issue as --marker-target o\/r#42/,
      `--mode ${mode} should reject a mismatching --anchor`,
    );
  }
});

test('authoring-owner CLI rejects --mode acquire with --body-sha256 none, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: 'acquire',
      supersedes: 'none',
    }),
  );
  assert.match(stderr, /--mode acquire requires a real --body-sha256/);
});

test('authoring-owner CLI rejects --mode release-guard with a real --body-sha256, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      'body-sha256': 'a'.repeat(64),
    }),
  );
  assert.match(
    stderr,
    /--mode release-guard is anchor-only and requires --body-sha256 none/,
  );
});

test('authoring-owner CLI rejects --mode release-complete with --snapshot-sha256 none, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: 'release-complete',
    }),
  );
  assert.match(
    stderr,
    /--mode release-complete requires a real --snapshot-sha256/,
  );
});

test('authoring-owner CLI rejects a non-release-complete --mode with a real --snapshot-sha256, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      'snapshot-sha256': 'a'.repeat(64),
    }),
  );
  assert.match(stderr, /--mode release-guard requires --snapshot-sha256 none/);
});

test('authoring-owner CLI rejects --mode acquire with --supersedes other than none, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: 'acquire',
      'body-sha256': 'a'.repeat(64),
      supersedes: 'owner-old',
    }),
  );
  assert.match(stderr, /--mode acquire requires --supersedes none/);
});

test('authoring-owner CLI rejects --mode resume with --supersedes none, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: 'resume',
      'body-sha256': 'a'.repeat(64),
      supersedes: 'none',
    }),
  );
  assert.match(stderr, /--mode resume requires a real --supersedes/);
});

test('authoring-owner CLI rejects --mode resume whose --supersedes equals its own --marker-owner, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: 'resume',
      'body-sha256': 'a'.repeat(64),
      supersedes: 'owner-abc',
    }),
  );
  assert.match(
    stderr,
    /--mode resume mints a NEW --marker-owner token, so --supersedes .* must differ from --marker-owner/,
  );
});

test('authoring-owner CLI accepts --mode resume with a real --supersedes distinct from --marker-owner (#2931)', () => {
  // mode: 'resume' is a "target" mode (AUTHORING_OWNER_REAL_BODY_DIGEST_MODES),
  // so a real --body-sha256 still triggers this file's usual live-fetch
  // verification -- stub it with a matching digest rather than an arbitrary
  // placeholder, the same pattern the explicit-digest-match test above uses.
  const LIVE_BODY = 'Fresh live body for #42.';
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const restore = stubGhIssueBody('o', 'r', 42, LIVE_BODY);
  try {
    const output = execFileSync(
      process.execPath,
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode: 'resume',
        'body-sha256': correctDigest,
        supersedes: 'owner-old',
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const body = JSON.parse(output).body as string;
    // `supersedes` is the LAST rendered field (no trailing `;`, just ` -->`).
    assert.match(body, /supersedes=owner-old -->/);
    assert.match(body, new RegExp(`body-sha256=${correctDigest};`));
  } finally {
    restore();
  }
});

test('authoring-owner CLI rejects --mode release/heartbeat/release-complete with a --supersedes other than --marker-owner, before any gh call (#2931)', () => {
  for (const mode of ['release', 'heartbeat', 'release-complete']) {
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode,
        'body-sha256': mode === 'release-complete' ? 'none' : 'a'.repeat(64),
        'snapshot-sha256':
          mode === 'release-complete' ? 'a'.repeat(64) : 'none',
        supersedes: 'owner-other',
      }),
    );
    assert.match(
      stderr,
      /retains the current owner token, so --supersedes must equal --marker-owner exactly/,
      `--mode ${mode} should reject a foreign --supersedes`,
    );
  }
});

test('authoring-owner CLI still rejects a whitespace-padded --mode that the renderer would trim and accept as canonical (#2931)', () => {
  // Codex review on PR #2937 (round 3): this file's own coupling
  // validators originally did `Set.has(fields.mode)` on the RAW string,
  // while renderAuthoringOwnerMarker trims internally
  // (normalizeNonWhitespaceToken) -- so `--mode ' acquire '` matched
  // neither AUTHORING_OWNER_REAL_BODY_DIGEST_MODES nor
  // AUTHORING_OWNER_NONE_BODY_DIGEST_MODES, silently skipping every
  // coupling check below, while the renderer still emitted canonical
  // `mode=acquire` -- a full bypass of every guard this issue added. This
  // reproduces the exact invalid combination (acquire + body-sha256 none)
  // the un-padded mode-digest coupling test above already covers, but
  // through the padded spelling that used to slip past it.
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      mode: ' acquire ',
      supersedes: 'none',
    }),
  );
  assert.match(stderr, /--mode acquire requires a real --body-sha256/);
});

test('kurone-kito/idd-skill#2925 regression: authoring-owner body-sha256 derivation avoids the exact shell-redirect trailing-newline bug', () => {
  // #2925's root cause, reproduced LITERALLY here (not just synthesized):
  // `gh api repos/.../issues/<n> --jq '.body' > file` appends a trailing
  // newline that `gh api --jq` emits on stdout but that is NOT part of the
  // actual `body` JSON field, so a hand-computed digest of that
  // shell-redirect-captured file differs from the true digest of the live
  // body. This stub answers BOTH call shapes against the same live body:
  // the plain JSON read (no --jq) this file's own live-fetch derivation
  // uses via createGithubProviderAdapter, and a `--jq .body` read (used
  // only by the actual shell-redirect command below, mirroring the real
  // `gh api --jq` trailing-newline behavior #2925 hit).
  const LIVE_BODY = 'Some real issue body content.\n\nSecond paragraph.';
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'repos/kurone-kito/idd-skill/issues/2925' && args.includes('--jq')) {
  process.stdout.write(${JSON.stringify(LIVE_BODY)} + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'repos/kurone-kito/idd-skill/issues/2925') {
  process.stdout.write(JSON.stringify({ number: 2925, body: ${JSON.stringify(LIVE_BODY)} }));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`,
  );
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-2925-'));
  const capturedFile = join(tempRoot, 'body.txt');
  try {
    // The actual #2925 shell-redirect capture, run for real (not
    // synthesized): `gh api ... --jq '.body' > file` through a real shell
    // redirect against the stub above.
    execFileSync(
      'sh',
      [
        '-c',
        `gh api repos/kurone-kito/idd-skill/issues/2925 --jq '.body' > ${JSON.stringify(capturedFile)}`,
      ],
      { encoding: 'utf8' },
    );
    const shellRedirectCapturedValue = readFileSync(capturedFile, 'utf8');
    // Sanity check: the shell redirect actually appended the trailing
    // newline #2925 hit, or this test would prove nothing about the bug
    // it targets.
    assert.equal(shellRedirectCapturedValue, `${LIVE_BODY}\n`);
    const buggyHandComputedDigest = createHash('sha256')
      .update(shellRedirectCapturedValue, 'utf8')
      .digest('hex');
    const correctDigest = createHash('sha256')
      .update(LIVE_BODY, 'utf8')
      .digest('hex');
    assert.notEqual(buggyHandComputedDigest, correctDigest);

    const { 'body-sha256': _omit, ...rest } = AUTHORING_OWNER_FULL_FIELDS;
    const output = execFileSync(
      process.execPath,
      // mode: 'acquire' -- a "target" mode requiring a real body-sha256,
      // needed here since body-sha256 is omitted (auto-derive path); the
      // base table's own default mode (release-guard) requires the none
      // sentinel instead (validateAuthoringOwnerModeDigestCoupling).
      // supersedes: 'none' -- acquire also requires supersedes none
      // (validateAuthoringOwnerSupersedesModeCoupling). Destination pinned
      // to the real kurone-kito/idd-skill#2925 this test's --marker-target
      // names (isPostingDestination, #2931's destination-equality fix).
      authoringArgv(
        'authoring-owner',
        {
          ...rest,
          mode: 'acquire',
          supersedes: 'none',
          'marker-target': 'kurone-kito/idd-skill#2925',
          anchor: 'kurone-kito/idd-skill#2925',
        },
        { number: 2925, owner: 'kurone-kito', repo: 'idd-skill' },
      ),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const body = JSON.parse(output).body as string;
    // The new helper's own live-fetch derivation computes the CORRECT
    // digest of the exact body...
    assert.match(body, new RegExp(`body-sha256=${correctDigest};`));
    // ...and never reproduces the shell-redirect-captured (buggy,
    // trailing-newline) digest #2925 actually posted.
    assert.doesNotMatch(
      body,
      new RegExp(`body-sha256=${buggyHandComputedDigest};`),
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--apply --type authoring-owner POSTs the byte-exact body with the live-derived body-sha256, and never triggers the hide-at-post-time step (#2931)', () => {
  const LIVE_BODY = 'Fresh live body for #42.';
  const correctDigest = createHash('sha256')
    .update(LIVE_BODY, 'utf8')
    .digest('hex');
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-post-idd-marker-authoring-owner-apply-'),
  );
  const stdinFile = join(tempRoot, 'gh-stdin.txt');
  // Any THIRD gh invocation beyond the GET (digest derivation) and the POST
  // falls through to the catch-all failure below -- including a
  // hide-at-post-time comments-listing call, which authoring-owner must
  // never trigger (it is deliberately not in HIDE_AT_POST_TIME_MARKER_TYPES,
  // #2931).
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'api' && args[1] === 'repos/o/r/issues/42') {
  out(JSON.stringify({ number: 42, body: ${JSON.stringify(LIVE_BODY)} }));
} else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, fs.readFileSync(0, 'utf8'));
  out(JSON.stringify({ id: 555, html_url: 'https://github.com/o/r/issues/42#issuecomment-555' }));
} else {
  fail('unexpected gh invocation: ' + args.join(' '));
}
`,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
        '--type',
        'authoring-owner',
        '--target',
        'issue',
        '42',
        '--owner',
        'o',
        '--repo',
        'r',
        '--marker-target',
        'o/r#42',
        '--anchor',
        'o/r#42',
        '--mode',
        'acquire',
        '--marker-owner',
        'owner-abc',
        '--set',
        'set-1',
        '--session',
        'session-1',
        '--snapshot-sha256',
        'none',
        '--supersedes',
        'none',
        '--apply',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, 'apply');
    assert.equal(parsed.commentId, 555);
    assert.deepEqual(JSON.parse(readFileSync(stdinFile, 'utf8')), {
      body: buildMarkerBody('authoring-owner', {
        'marker-prefix': 'idd-skill',
        'marker-target': 'o/r#42',
        anchor: 'o/r#42',
        mode: 'acquire',
        'marker-owner': 'owner-abc',
        set: 'set-1',
        session: 'session-1',
        'body-sha256': correctDigest,
        'snapshot-sha256': 'none',
        supersedes: 'none',
      }),
    });
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// marker-target / anchor are OPAQUE per-set ids for this type (contract.md),
// not <owner>/<repo>#<number> issue references -- only journal / (non-'none')
// issue use that shape. journal: 'o/r#42' matches authoringArgv's own
// destination defaults (owner 'o' / repo 'r' / number 42), since #2931's
// destination-equality fix now requires --journal to name the SAME issue
// this CLI actually posts to (isPostingDestination).
const AUTHORING_PUBLICATION_INTENT_FULL_FIELDS: Record<string, string> = {
  'marker-target': 'target-abc123',
  anchor: 'anchor-abc123',
  set: 'set-1',
  session: 'session-1',
  token: 'pub-1',
  journal: 'o/r#42',
  issue: 'none',
  actor: 'kurone-kito',
  state: 'pending',
};

test("post-idd-marker CLI: authoring-publication-intent's full flag set succeeds (dry-run, #2931)", () => {
  const output = execFileSync(
    process.execPath,
    authoringArgv(
      'authoring-publication-intent',
      AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
    ),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.mode, 'dry-run');
  assert.equal(parsed.type, 'authoring-publication-intent');
});

test('post-idd-marker CLI: every required flag of authoring-publication-intent is rejected by name when omitted (#2931)', () => {
  for (const omittedFlag of Object.keys(
    AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
  )) {
    const partial = Object.fromEntries(
      Object.entries(AUTHORING_PUBLICATION_INTENT_FULL_FIELDS).filter(
        ([flag]) => flag !== omittedFlag,
      ),
    );
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-publication-intent', partial),
    );
    assert.match(
      stderr,
      new RegExp(`--${omittedFlag} is required`),
      `authoring-publication-intent without --${omittedFlag} should name --${omittedFlag}`,
    );
  }
});

test('authoring-publication-intent CLI fails closed on a malformed --journal, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-publication-intent', {
      ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      journal: 'not-a-valid-ref',
    }),
  );
  assert.match(
    stderr,
    /invalid --journal value \(expected <owner>\/<repo>#<number>\): not-a-valid-ref/,
  );
});

test('authoring-publication-intent CLI fails closed on a malformed --issue (non-none), before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-publication-intent', {
      ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      issue: 'not-a-valid-ref',
    }),
  );
  assert.match(
    stderr,
    /invalid --issue value \(expected <owner>\/<repo>#<number> or none\): not-a-valid-ref/,
  );
});

test('authoring-publication-intent CLI accepts a real --issue reference distinct from --journal (#2931)', () => {
  // contract.md gives --issue no destination-equality requirement of its
  // own (it names the issue this publication intent is ABOUT, which need
  // not be the journal issue this marker posts to) -- only its FORMAT is
  // checked.
  const output = execFileSync(
    process.execPath,
    authoringArgv('authoring-publication-intent', {
      ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      issue: 'o/r#999',
    }),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(JSON.parse(output).body, /issue=o\/r#999;/);
});

test('authoring-publication-intent CLI refuses issue=none at member/cleanup/abandoned, before any gh call (#2931)', () => {
  for (const state of ['member', 'cleanup', 'abandoned']) {
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-publication-intent', {
        ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
        state,
      }),
    );
    assert.match(
      stderr,
      new RegExp(`--state ${state} requires a real --issue reference`),
      `state=${state} + issue=none should be rejected`,
    );
  }
});

test('authoring-publication-intent CLI accepts issue=none at state=pending (pre-create record, #2931)', () => {
  const output = execFileSync(
    process.execPath,
    authoringArgv(
      'authoring-publication-intent',
      AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
    ),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(JSON.parse(output).body, /issue=none; actor=\S+; state=pending/);
});

test('authoring-publication-intent CLI refuses a --journal that does not match the posting destination, before any gh call (#2931)', () => {
  // Critical Codex/Copilot finding on PR #2937 (same class as
  // authoring-owner's --marker-target check): an unvalidated --journal
  // could post the append-only publication-intent record to a completely
  // different issue than the one it claims to journal.
  const stderr = runCliExpectingFailure(
    authoringArgv(
      'authoring-publication-intent',
      { ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS, journal: 'o/r#99' },
      { number: 42, owner: 'o', repo: 'r' },
    ),
  );
  assert.match(
    stderr,
    /--journal o\/r#99 does not match the posting destination o\/r#42/,
  );
});

test('authoring-publication-intent CLI defaults --marker-prefix to the hardcoded fallback when no config file is present (#2931)', () => {
  const tempCwd = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-no-config-'));
  try {
    const output = execFileSync(
      process.execPath,
      authoringArgv(
        'authoring-publication-intent',
        AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      ),
      { cwd: tempCwd, encoding: 'utf8' },
    );
    assert.match(
      JSON.parse(output).body,
      /^<!-- idd-skill-authoring-publication-intent:/,
    );
  } finally {
    rmSync(tempCwd, { recursive: true, force: true });
  }
});

test('authoring-publication-intent CLI honors an explicit --marker-prefix over config/default (#2931)', () => {
  const output = execFileSync(
    process.execPath,
    authoringArgv('authoring-publication-intent', {
      ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      'marker-prefix': 'custom-prefix',
    }),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(
    JSON.parse(output).body,
    /^<!-- custom-prefix-authoring-publication-intent:/,
  );
});

/** Stub `gh api user --jq .login` (resolveViewerLoginSafe's exact call,
 * #2931) alongside the issue-comments POST, for the actor-binding tests
 * below. */
function stubGhViewerLoginAndPost(
  login: string,
  owner: string,
  repo: string,
  number: number,
  stdinFile: string,
): () => void {
  return stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'api' && args[1] === 'user') {
  out(${JSON.stringify(login)});
} else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, fs.readFileSync(0, 'utf8'));
  out(JSON.stringify({ id: 777, html_url: 'https://github.com/${owner}/${repo}/issues/${number}#issuecomment-777' }));
} else {
  fail('unexpected gh invocation: ' + args.join(' '));
}
`,
  );
}

test('authoring-publication-intent --apply refuses a --actor that does not match the authenticated user (#2931)', () => {
  // Codex review on PR #2937: contract.md requires "actor to equal the API
  // author" on every replay -- a mismatched --actor produces a record
  // replay will always reject even though this command reports success.
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-post-idd-marker-pub-intent-actor-'),
  );
  const stdinFile = join(tempRoot, 'gh-stdin.txt');
  const restore = stubGhViewerLoginAndPost(
    'the-real-user',
    'o',
    'r',
    42,
    stdinFile,
  );
  try {
    execFileSync(
      process.execPath,
      [
        ...authoringArgv('authoring-publication-intent', {
          ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
          actor: 'someone-else',
        }),
        '--apply',
      ],
      { encoding: 'utf8', env: { ...process.env } },
    );
    throw new Error('expected the CLI to exit non-zero');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /--actor someone-else does not match the authenticated user the-real-user/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('authoring-publication-intent --apply accepts a --actor that matches the authenticated user (case-insensitive, #2931)', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-post-idd-marker-pub-intent-actor-match-'),
  );
  const stdinFile = join(tempRoot, 'gh-stdin.txt');
  const restore = stubGhViewerLoginAndPost(
    'The-Real-User',
    'o',
    'r',
    42,
    stdinFile,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        ...authoringArgv('authoring-publication-intent', {
          ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
          actor: 'the-real-user',
        }),
        '--apply',
      ],
      { encoding: 'utf8', env: { ...process.env } },
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, 'apply');
    assert.equal(parsed.commentId, 777);
    assert.match(
      JSON.parse(readFileSync(stdinFile, 'utf8')).body,
      /actor=the-real-user;/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('authoring-publication-intent --apply fails closed when the authenticated login cannot be resolved (#2931)', () => {
  // Codex + Copilot review on PR #2937, round 4 (independently
  // corroborated): resolveViewerLoginSafe() fails OPEN (empty
  // viewerLogin, viewerLoginUnavailable: true) on a transient `gh api
  // user` failure -- the original round-3 actor check's `viewerLogin &&`
  // guard then silently skipped the comparison, letting an unverified
  // --actor through into a permanent append-only record. This proves the
  // POST is never reached when the login cannot be resolved.
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stderr.write('HTTP 401: Bad credentials');
  process.exit(1);
}
process.stderr.write('unexpected gh invocation (expected only a failing api user call): ' + args.join(' '));
process.exit(1);
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        ...authoringArgv('authoring-publication-intent', {
          ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
          actor: 'someone',
        }),
        '--apply',
      ],
      { encoding: 'utf8', env: { ...process.env } },
    );
    throw new Error('expected the CLI to exit non-zero');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /cannot verify --actor: the authenticated GitHub login could not be resolved/,
    );
  } finally {
    restore();
  }
});

test('authoring-publication-intent dry-run does not check --actor against the authenticated user (checked only at --apply, #2931)', () => {
  const restore = stubGhNeverCalled();
  try {
    const output = execFileSync(
      process.execPath,
      authoringArgv('authoring-publication-intent', {
        ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
        actor: 'anyone-at-all',
      }),
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.match(JSON.parse(output).body, /actor=anyone-at-all;/);
  } finally {
    restore();
  }
});
