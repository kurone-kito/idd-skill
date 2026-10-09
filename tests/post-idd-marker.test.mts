import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAuthoringOwnerComment } from '../src/scripts/marker-helpers.mts';
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
  runOperationLocalSnapshotWatermark,
  selectAuthoringOwnerOpeningMarkers,
  validateAuthoringOwnerModeDigestCoupling,
  validateAuthoringOwnerPostIdentity,
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
  parseOutOfLoopMarker,
  parseReleaseComment,
  parseReviewAckComment,
  parseReviewWatermarkComment,
} from '../src/scripts/protocol-helpers.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';
import { PR_1897_REVIEW_4863787336 } from './coderabbit-pr-1897-review.mts';
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

// --- #3328: out-of-loop -----------------------------------------------

test('buildMarkerBody renders the out-of-loop body (reason is always bootstrap)', () => {
  const body = buildMarkerBody('out-of-loop', {
    'agent-id': 'claude-ad242b1f',
    pr: '3229',
    timestamp: TS,
  });
  assert.equal(
    body,
    `<!-- idd-out-of-loop: claude-ad242b1f pr:3229 reason:bootstrap at:${TS} -->\n\n` +
      '_claude-ad242b1f: this PR runs outside the IDD claim loop -- IDD automation marker. Do not edit._',
  );
});

test('buildMarkerBody throws on out-of-loop with agent-id, pr, or timestamp missing', () => {
  const fullFields = {
    'agent-id': 'claude-ad242b1f',
    pr: '3229',
    timestamp: TS,
  };
  for (const omit of Object.keys(fullFields)) {
    const fields = { ...fullFields };
    delete (fields as Record<string, string>)[omit];
    assert.throws(
      () => buildMarkerBody('out-of-loop', fields),
      /invalid out-of-loop marker payload/,
      `omitting ${omit} should throw`,
    );
  }
});

test('the out-of-loop body round-trips through parseOutOfLoopMarker', () => {
  const body = buildMarkerBody('out-of-loop', {
    'agent-id': 'claude-ad242b1f',
    pr: '3229',
    timestamp: TS,
  });
  assert.deepEqual(parseOutOfLoopMarker(body, CREATED_AT), {
    agentId: 'claude-ad242b1f',
    prNumber: 3229,
    reason: 'bootstrap',
    at: TS,
    createdAt: CREATED_AT,
  });
  assert.equal(operationalMarkerPrefix(body), '<!-- idd-out-of-loop:');
});

test('parseOutOfLoopMarker returns null for a non-out-of-loop / malformed body', () => {
  assert.equal(parseOutOfLoopMarker('not a marker', TS), null);
  assert.equal(
    parseOutOfLoopMarker(
      `copilot-unavailable: a ${SHA} ${TS} claim:c attempt:1`,
      TS,
    ),
    null,
  );
  // A `reason:` token other than `bootstrap` is not a valid out-of-loop
  // marker: the grammar accepts exactly `reason:bootstrap` (#3328).
  assert.equal(
    parseOutOfLoopMarker(
      '<!-- idd-out-of-loop: claude-ad242b1f pr:3229 reason:other at:2026-09-24T00:00:00Z -->',
      TS,
    ),
    null,
  );
});

test('CLI: --type out-of-loop derives pr: from --target pr <n>, never a separate flag', () => {
  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'out-of-loop',
      '--target',
      'pr',
      '3229',
      '--agent-id',
      'claude-ad242b1f',
      '--timestamp',
      TS,
    ],
    { encoding: 'utf8' },
  );
  const report = JSON.parse(output) as { body: string };
  assert.match(report.body, /pr:3229/);
  assert.match(report.body, /reason:bootstrap/);
});

test('CLI: --type out-of-loop with --target issue is rejected', () => {
  const stderr = runCliExpectingFailure([
    join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
    '--type',
    'out-of-loop',
    '--target',
    'issue',
    '3229',
    '--agent-id',
    'claude-ad242b1f',
    '--timestamp',
    TS,
  ]);
  assert.match(stderr, /--type out-of-loop requires --target pr/);
});

test('--help lists out-of-loop among the supported --type values', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  assert.match(output, /--type <type>\s+one of:.*\bout-of-loop\b/);
});

test('--help documents --operation-local and its --prior-* flags (#3592)', () => {
  // post-idd-marker has a hand-rolled parser, so tests/help-text-flags.test.mts
  // excludes it and cannot catch an accepted-but-undocumented flag.
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  for (const flag of [
    '--operation-local',
    '--prior-head-sha',
    '--prior-total-item-count',
    '--prior-max-activity-at',
  ]) {
    assert.ok(output.includes(flag), `--help must document ${flag}`);
  }
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

test('MARKER_TYPES lists exactly the thirteen supported types', () => {
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
      'out-of-loop',
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

test('operationLocal.watermarkFields is always an object: the schema rejects null and non-string values (#3622)', () => {
  // The operation-local path throws before any envelope is printed when the
  // derivation fails, so it never emits `null`; the schema must say so.
  const operationLocalSchema = (
    schema as { properties: { operationLocal: Record<string, unknown> } }
  ).properties.operationLocal;
  const capture = {
    decision: 'publish',
    reason: null,
    snapshot: {},
    watermarkFields: { 'head-sha': 'abc123' },
    warnings: [],
  };
  assert.deepEqual(validate(capture, operationLocalSchema), []);
  assert.ok(
    validate({ ...capture, watermarkFields: null }, operationLocalSchema).some(
      (message) => message.includes('watermarkFields'),
    ),
  );
  assert.ok(
    validate(
      { ...capture, watermarkFields: { 'total-item-count': 1 } },
      operationLocalSchema,
    ).some((message) => message.includes('watermarkFields')),
  );
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

/**
 * Environment for a claim or unclaim `--apply` child. Those markers drop the
 * cached Discover hints after posting (#3588), and this repository's config
 * enables that cache, so point the child's cache at a throwaway directory
 * instead of the developer's real per-user location.
 */
function sandboxedHintCacheEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    XDG_CACHE_HOME: join(dir, 'xdg-cache'),
    LOCALAPPDATA: join(dir, 'local-app-data'),
  };
}

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
  const raw = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(stdinFile)}, raw);
  const sent = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ id: 4242, html_url: 'https://github.com/o/r/issues/1047#issuecomment-4242', body: sent.body }));
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
        env: sandboxedHintCacheEnv(tempRoot),
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
    // `--include` (#3275) keeps the response's HTTP headers available for a
    // failed attempt's `Retry-After` derivation; a plain JSON body (as this
    // stub still returns) is parsed unchanged via the tolerant fallback in
    // `extractIncludedResponseBody`.
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      '--method',
      'POST',
      'repos/o/r/issues/1047/comments',
      '--input',
      '-',
      '--include',
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

test('describeUnaddressedActivity stays silent for a courtesy-ack-only thread set (#3482)', () => {
  assert.deepEqual(
    describeUnaddressedActivity({
      dispositionEvidence: {
        missingRegularCommentCount: 0,
        missingThreadCount: 1,
        soleCauseAckOnlyPostDisposition: true,
      },
    }),
    [],
  );
});

test('describeUnaddressedActivity still warns when the courtesy-ack flag is set but a regular comment is missing (#3482)', () => {
  const warnings = describeUnaddressedActivity({
    dispositionEvidence: {
      missingRegularCommentCount: 1,
      missingThreadCount: 1,
      soleCauseAckOnlyPostDisposition: true,
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^1 comment and 1 thread have no disposition evidence/,
  );
});

test('describeUnaddressedActivity still warns when the courtesy-ack flag is missing or not exactly true (#3482)', () => {
  const base = {
    missingRegularCommentCount: 0,
    missingThreadCount: 1,
  };
  const cases: Array<Record<string, unknown>> = [
    base,
    { ...base, soleCauseAckOnlyPostDisposition: false },
    { ...base, soleCauseAckOnlyPostDisposition: 'true' },
    { ...base, soleCauseAckOnlyPostDisposition: 1 },
  ];
  for (const dispositionEvidence of cases) {
    const warnings = describeUnaddressedActivity({ dispositionEvidence });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^1 thread has no disposition evidence/);
  }
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

const PASSING_CHECK_RUN = {
  __typename: 'CheckRun',
  name: 'ci',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  startedAt: '2026-06-25T10:00:00Z',
  completedAt: '2026-06-25T11:00:00Z',
  detailsUrl: 'https://example.test/ci',
  checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: {
      file: { path: '.github/workflows/ci.yml' },
      workflow: { name: 'ci' },
    },
  },
};

function statusCheckRollupResponse(
  headSha: string,
  nodes: readonly Record<string, unknown>[],
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          baseRefName: 'main',
          statusCheckRollup: {
            contexts: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  });
}

/**
 * Offline `gh` for a `--from-pr` watermark. The review-activity snapshot
 * answers stay as they were; the extra branches answer `ci-wait-state`'s
 * required-check read (#3465) so the shared pre-merge predicate sees one
 * passing present run and no required-check names.
 */
function watermarkFromPrGhStub(
  headSha: string,
  options: {
    rollupNodes?: readonly Record<string, unknown>[];
    rollupHeadSha?: string;
    rulesBody?: string;
    commentsBody?: string;
    /** REST `pulls/<n>/reviews` payload (JSON text); default no reviews. */
    reviewsBody?: string;
    /** Raw GraphQL body for the review-threads query (#3655). */
    threadsBody?: string;
    /** Raw GraphQL body for the `userContentEdits` `nodes(ids:)` query. */
    editsBody?: string;
  } = {},
): string {
  const reviewsBody = JSON.stringify(options.reviewsBody ?? '[]');
  const rollup = JSON.stringify(
    statusCheckRollupResponse(
      options.rollupHeadSha ?? headSha,
      options.rollupNodes ?? [PASSING_CHECK_RUN],
    ),
  );
  const rulesBody = JSON.stringify(options.rulesBody ?? '');
  const commentsBody = JSON.stringify(
    options.commentsBody ??
      JSON.stringify([
        {
          node_id: 'C_1',
          body: 'hi',
          created_at: '2026-06-25T10:00:00Z',
          updated_at: '2026-06-25T10:30:00Z',
          user: { login: 'someone' },
        },
      ]),
  );
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
const out = (s) => { fs.writeSync(1, s); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') out(JSON.stringify({ headRefOid: '${headSha}', author: { login: 'someone' } }));
if (args[0] === 'pr' && args[1] === 'checks') {
  out(JSON.stringify([{ name: 'ci', state: 'SUCCESS', completedAt: '2026-06-25T11:00:00Z' }]));
}
if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('statusCheckRollup')) {
  out(${rollup});
}
if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('databaseId')) {
  const raw = ${commentsBody};
  const trimmed = String(raw).trim();
  const rows = trimmed === ''
    ? []
    : trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed.split('\\n').filter(Boolean).map((line) => JSON.parse(line));
  const nodes = rows.map((row, index) => ({
    id: row.node_id || ('C_rest_' + (index + 1)),
    databaseId: typeof row.id === 'number' ? row.id : index + 1,
    body: row.body || '',
    createdAt: row.created_at || '2026-06-25T10:00:00Z',
    updatedAt: row.updated_at || row.created_at || '2026-06-25T10:00:00Z',
    lastEditedAt: null,
    author: {
      login: (row.user && row.user.login) || '',
      __typename: 'User',
    },
  }));
  out(JSON.stringify({
    data: {
      repository: {
        issue: null,
        pullRequest: {
          comments: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  }));
}
${
  options.editsBody === undefined
    ? ''
    : `if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('userContentEdits')) out(${JSON.stringify(options.editsBody)});`
}
${
  options.threadsBody === undefined
    ? ''
    : `if (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('reviewThreads(')) out(${JSON.stringify(options.threadsBody)});`
}
if (args[0] === 'api' && args[1] === 'graphql') {
  out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } }, nodes: [{ id: 'C_1', lastEditedAt: null }] } }));
}
if (args[0] === 'api' && /\\/reviews$/.test(args[1])) out(${reviewsBody});
if (args[0] === 'api' && /rules\\/branches\\//.test(args[1])) out(${rulesBody});
if (args[0] === 'api' && /\\/protection$/.test(args[1])) out('{}');
if (args[0] === 'api' && /contents\\/\\.github\\/idd\\/config\\.json/.test(args[1])) out('e30=');
if (args[0] === 'api' && /\\/comments$/.test(args[1])) out(${commentsBody});
fs.writeSync(2, 'unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`;
}

const REVIEW_ACTIVITY_SNAPSHOT_GH_STUB = (headSha: string) =>
  watermarkFromPrGhStub(headSha);

const REQUIRED_LINT_RULE =
  '{"type":"required_status_checks","parameters":{"required_status_checks":["lint"]}}\n';

function rollupCheck(
  name: string,
  conclusion: string,
  status = 'COMPLETED',
): Record<string, unknown> {
  return { ...PASSING_CHECK_RUN, name, status, conclusion };
}

function runWatermarkFromPr(apply: boolean): string {
  return execFileSync(
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
      ...(apply ? ['--apply'] : []),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function assertWatermarkRefused(
  stub: string,
  apply: boolean,
  expected: RegExp = /required checks are not passing/,
): void {
  const restore = stubExecutable('gh', stub);
  try {
    runWatermarkFromPr(apply);
  } catch (error) {
    const failure = error as {
      status?: number;
      stderr?: string;
      stdout?: string;
    };
    assert.equal(failure.status, 1);
    assert.match(failure.stderr ?? '', expected);
    assert.equal(failure.stdout ?? '', '');
    return;
  } finally {
    restore();
  }
  throw new Error('expected the CLI to exit non-zero');
}

test('#3465: --from-pr watermark refuses a failed required check in dry-run and --apply', () => {
  const stub = watermarkFromPrGhStub(SHA, {
    rollupNodes: [rollupCheck('lint', 'FAILURE')],
    rulesBody: REQUIRED_LINT_RULE,
  });
  assertWatermarkRefused(stub, false);
  assertWatermarkRefused(stub, true);
});

test('#3465: --from-pr watermark refuses a still-pending required check', () => {
  assertWatermarkRefused(
    watermarkFromPrGhStub(SHA, {
      rollupNodes: [rollupCheck('lint', '', 'IN_PROGRESS')],
      rulesBody: REQUIRED_LINT_RULE,
    }),
    false,
  );
});

test('#3465: --from-pr watermark refuses when the required-check HEAD differs from the snapshot', () => {
  const otherHead = 'b'.repeat(40);
  const restore = stubExecutable(
    'gh',
    watermarkFromPrGhStub(SHA, { rollupHeadSha: otherHead }),
  );
  try {
    runWatermarkFromPr(false);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /does not match the activity snapshot HEAD/,
    );
    assert.match(failure.stderr ?? '', new RegExp(otherHead));
    assert.match(failure.stderr ?? '', new RegExp(SHA));
    return;
  } finally {
    restore();
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('#3465: --from-pr watermark refuses when the live passing completion moved past the snapshot', () => {
  const restore = stubExecutable(
    'gh',
    watermarkFromPrGhStub(SHA, {
      rollupNodes: [
        {
          ...PASSING_CHECK_RUN,
          completedAt: '2026-06-25T12:00:00Z',
        },
      ],
    }),
  );
  try {
    runWatermarkFromPr(false);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(
      failure.stderr ?? '',
      /live passing completion 2026-06-25T12:00:00Z does not match the activity snapshot ci-completed-at 2026-06-25T11:00:00Z/,
    );
    return;
  } finally {
    restore();
  }
  throw new Error('expected the CLI to exit non-zero');
});

test('#3465: a non-required failure does not refuse a passing required check', () => {
  const restore = stubExecutable(
    'gh',
    watermarkFromPrGhStub(SHA, {
      rollupNodes: [
        rollupCheck('lint', 'SUCCESS'),
        rollupCheck('docs', 'FAILURE'),
      ],
      rulesBody: REQUIRED_LINT_RULE,
    }),
  );
  try {
    const output = runWatermarkFromPr(false);
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
      warnings: [NO_DISPOSITION_EVIDENCE_WARNING_ONE_COMMENT],
    });
  } finally {
    restore();
  }
});

test('#3670: --from-pr watermark with no required check names the blocking present run and the deferral path', () => {
  // No required check is configured (the default empty rules), so the failing
  // present run decides CI. The text must not claim a required check fails.
  const stub = watermarkFromPrGhStub(SHA, {
    rollupNodes: [
      rollupCheck('lint', 'SUCCESS'),
      rollupCheck('docs', 'FAILURE'),
    ],
  });
  assertWatermarkRefused(
    stub,
    false,
    /PR 1200 has no required check configured, so its present runs decide CI, and docs is blocking\. In E1 Step 2 this is a deferral, not a deadlock: continue to E3 .*re-run --from-pr at E1 Step 2/,
  );
});

test('#3670: --from-pr watermark keeps the required-checks text when a required check fails', () => {
  assertWatermarkRefused(
    watermarkFromPrGhStub(SHA, {
      rollupNodes: [rollupCheck('lint', 'FAILURE')],
      rulesBody: REQUIRED_LINT_RULE,
    }),
    false,
    /PR 1200's required checks are not passing\. Re-run --from-pr once they pass\./,
  );
});

test('--from-pr CLI composes review-activity-snapshot and prints the derived watermark (dry-run)', () => {
  // Stub `gh` on PATH so the in-process activity capture and the separate
  // required-CI/HEAD agreement read both run offline. The stub answers each
  // `gh` argv shape those two reads make.
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
    watermarkFromPrGhStub(SHA, { commentsBody: '[]' }),
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
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
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
      // #3434: suppress the duplicate raw-stderr relay execFileSync
      // performs when no `stdio` override is given -- the `failure.stderr`
      // this helper returns below is unaffected.
      stdio: ['ignore', 'pipe', 'pipe'],
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
 * makes no activity-capture call). Returns the cleanup callback.
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
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
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
  const raw = fs.readFileSync(0, 'utf8');
  const sent = JSON.parse(raw);
  out(JSON.stringify({ id: newCommentId, html_url: 'https://github.com/o/r/issues/1#issuecomment-' + newCommentId, body: sent.body }));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const fValues = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-f') fValues.push(args[i + 1]);
  }
  const idEntry = fValues.find((v) => v.indexOf('id=') === 0);
  const classifierEntry = fValues.find((v) => v.indexOf('classifier=') === 0);
  const id = idEntry ? idEntry.slice('id='.length) : '';
  const ids = fValues.filter((v) => v.indexOf('ids[]=') === 0).map((v) => v.slice('ids[]='.length));
  if (classifierEntry) {
    fs.appendFileSync(mutationLogFile, JSON.stringify({ id, mutation: true }) + '\\n');
    if (failMutationFor.indexOf(id) !== -1) {
      fail('mutation-error: permission denied');
    }
    out(JSON.stringify({ data: { minimizeComment: { minimizedComment: { __typename: 'IssueComment', isMinimized: true } } } }));
  } else if (ids.length > 0) {
    for (const probedId of ids) {
      fs.appendFileSync(mutationLogFile, JSON.stringify({ id: probedId, mutation: false }) + '\\n');
    }
    const nodes = ids.map((probedId) => {
      const info = probeIndex[probedId];
      if (!info) return null;
      return { __typename: 'IssueComment', id: probedId, url: 'https://github.com/o/r/issues/1#issuecomment-' + probedId, isMinimized: info.isMinimized || false, viewerCanMinimize: info.viewerCanMinimize !== false, author: { login: info.author || 'kurone-kito' } };
    });
    out(JSON.stringify({ data: { nodes } }));
  } else {
    fs.appendFileSync(mutationLogFile, JSON.stringify({ id, mutation: false }) + '\\n');
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
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-claim-'));
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  const raw = fs.readFileSync(0, 'utf8');
  const sent = JSON.parse(raw);
  out(JSON.stringify({ id: 9800, html_url: 'https://github.com/o/r/issues/1#issuecomment-9800', body: sent.body }));
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
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: sandboxedHintCacheEnv(sandbox),
      },
    );
    assert.equal(JSON.parse(output).commentId, 9800);
  } finally {
    restore();
    rmSync(sandbox, { recursive: true, force: true });
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

test('authoring-owner CLI refuses a --session value that breaks the marker grammar, before any gh call (#2931)', () => {
  // Codex review on PR #2937, round 6: a literal `;` inside any opaque
  // field (set/session/token, or authoring-publication-intent's opaque
  // --marker-target/--anchor) passes every per-field check -- none of
  // them scan for grammar-breaking characters -- yet the rendered body
  // fails to round-trip through matchCanonicalAuthoringMarkerFamily,
  // reproducing the #2900/#2926/#2927 non-canonical-body incident class
  // through a different field than #2925's body-sha256. The terminal
  // round-trip assertion this file now runs after buildMarkerBody must
  // catch this regardless of which field carries the delimiter.
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      session: 'a;b',
    }),
  );
  assert.match(
    stderr,
    /refusing to post: the rendered authoring-owner body does not round-trip through matchCanonicalAuthoringMarkerFamily as canonical/,
  );
});

test('authoring-publication-intent CLI refuses a --marker-target value that breaks the marker grammar, before any gh call (#2931)', () => {
  const stderr = runCliExpectingFailure(
    authoringArgv('authoring-publication-intent', {
      ...AUTHORING_PUBLICATION_INTENT_FULL_FIELDS,
      'marker-target': 'target;x=y',
    }),
  );
  assert.match(
    stderr,
    /refusing to post: the rendered authoring-publication-intent body does not round-trip through matchCanonicalAuthoringMarkerFamily as canonical/,
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

test('validateAuthoringOwnerSupersedesModeCoupling rejects --marker-owner none for every mode that needs a real owner token (#2931)', () => {
  // Codex review on PR #2937, round 7: a bare `supersedes !== markerOwner`
  // equality check trivially passes when both are literally 'none' --
  // this must be rejected independently of that equality check, for every
  // mode contract.md gives a real owner-token requirement to (i.e. every
  // recognized mode except the ones this function does not otherwise
  // constrain via marker-owner at all -- there are none: acquire/
  // bootstrap/resume all mint a real token, and the four self-superseding
  // modes all retain one).
  for (const mode of [
    'acquire',
    'bootstrap',
    'resume',
    'release',
    'heartbeat',
    'release-guard',
    'release-complete',
  ]) {
    assert.match(
      validateAuthoringOwnerSupersedesModeCoupling({
        mode,
        supersedes: 'none',
        'marker-owner': 'none',
      }) ?? '',
      /--marker-owner must be a real opaque per-target owner token, not the none sentinel/,
      `--mode ${mode} should reject --marker-owner none`,
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

test('authoring-owner plain dry-run stays network-free when --owner/--repo are omitted (#2931)', () => {
  // Copilot review on PR #2937, round 7: an earlier revision eagerly
  // resolved the posting destination via `gh repo view` for the
  // destination-equality check, even in a PLAIN dry-run (no --apply, no
  // --from-pr) -- breaking this file's own documented offline dry-run
  // guarantee (docs/harness-orchestrated-execution-investigation.md's
  // "Live state required?" table), which every OTHER marker type's dry-run
  // has always honored. PATH='' proves no `gh` call happens: a real
  // `gh repo view` attempt would fail with ENOENT and a non-zero exit.
  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'authoring-owner',
      '--target',
      'issue',
      '42',
      ...Object.entries(AUTHORING_OWNER_FULL_FIELDS).flatMap(
        ([flag, value]) => [`--${flag}`, value],
      ),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: '' } },
  );
  assert.equal(JSON.parse(output).mode, 'dry-run');
});

test('authoring-publication-intent plain dry-run stays network-free when --owner/--repo are omitted (#2931)', () => {
  const output = execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/post-idd-marker.mjs'),
      '--type',
      'authoring-publication-intent',
      '--target',
      'issue',
      '42',
      ...Object.entries(AUTHORING_PUBLICATION_INTENT_FULL_FIELDS).flatMap(
        ([flag, value]) => [`--${flag}`, value],
      ),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: '' } },
  );
  assert.equal(JSON.parse(output).mode, 'dry-run');
});

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

test('authoring-owner --body-sha256 padded with whitespace is still recognized as the none sentinel (#2931)', () => {
  // CodeRabbit review on PR #2937, round 5: the CLI entry point's own
  // `args.fields['body-sha256'] !== 'none'` sentinel check compared the
  // UNTRIMMED value, so `--body-sha256 ' none '` would (wrongly) trigger
  // the live-fetch derive/verify path instead of being recognized as the
  // anchor-only none sentinel -- this proves no gh call happens either
  // way.
  const restore = stubGhNeverCalled();
  try {
    const output = execFileSync(
      process.execPath,
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode: 'release-guard',
        'body-sha256': ' none ',
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
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env },
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
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
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env },
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
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

test('authoring-owner CLI rejects --marker-owner none paired with --supersedes none for self-superseding modes, before any gh call (#2931)', () => {
  // Codex review on PR #2937, round 7: a bare equality check
  // (supersedes !== markerOwner) trivially PASSES when BOTH are the
  // literal string 'none' -- contract.md explicitly forbids
  // supersedes=none for release (and, by the same "retain the current
  // owner token" wording, for heartbeat/release-guard/release-complete
  // too), but the append-only marker would still post successfully with
  // no real owner token at all.
  for (const mode of [
    'release',
    'heartbeat',
    'release-guard',
    'release-complete',
  ]) {
    const anchorOnly = mode === 'release-guard' || mode === 'release-complete';
    const stderr = runCliExpectingFailure(
      authoringArgv('authoring-owner', {
        ...AUTHORING_OWNER_FULL_FIELDS,
        mode,
        'body-sha256': anchorOnly ? 'none' : 'a'.repeat(64),
        'snapshot-sha256':
          mode === 'release-complete' ? 'a'.repeat(64) : 'none',
        'marker-owner': 'none',
        supersedes: 'none',
      }),
    );
    assert.match(
      stderr,
      /--marker-owner must be a real opaque per-target owner token, not the none sentinel/,
      `--mode ${mode} should reject --marker-owner none`,
    );
  }
});

test('authoring-owner CLI accepts a padded --marker-prefix (trimmed before the round-trip assertion, #2931)', () => {
  // Copilot review on PR #2937, round 7: both renderers trim
  // --marker-prefix internally, but this file's own terminal round-trip
  // assertion (round 6) was comparing against the UNTRIMMED prefix,
  // causing it to reject a body the renderer had already produced
  // canonically. Fail-SAFE (never posted the wrong body) but a needless
  // false rejection -- this proves the fix accepts the padded input.
  const output = execFileSync(
    process.execPath,
    authoringArgv('authoring-owner', {
      ...AUTHORING_OWNER_FULL_FIELDS,
      'marker-prefix': ' custom-prefix ',
    }),
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(JSON.parse(output).body, /^<!-- custom-prefix-authoring-owner:/);
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
  const raw = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(stdinFile)}, raw);
  const sent = JSON.parse(raw);
  out(JSON.stringify({ id: 555, html_url: 'https://github.com/o/r/issues/42#issuecomment-555', body: sent.body }));
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
  const raw = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(stdinFile)}, raw);
  const sent = JSON.parse(raw);
  out(JSON.stringify({ id: 777, html_url: 'https://github.com/${owner}/${repo}/issues/${number}#issuecomment-777', body: sent.body }));
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
      {
        encoding: 'utf8',
        env: { ...process.env },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
      {
        encoding: 'utf8',
        env: { ...process.env },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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

const OPERATION_LOCAL_SHA = 'a'.repeat(40);

function operationLocalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    headSha: OPERATION_LOCAL_SHA,
    totalItemCount: 1,
    maxActivityUpdatedAt: '2026-06-25T10:30:00Z',
    latestPassingCiCompletedAt: '2026-06-25T11:00:00Z',
    dispositionEvidence: {
      missingRegularCommentCount: 0,
      missingThreadCount: 0,
      soleCauseAckOnlyPostDisposition: false,
    },
    ...overrides,
  };
}

function passingAgreement(head = OPERATION_LOCAL_SHA) {
  return {
    headRefOid: head,
    requiredChecksPassing: true,
    noRequiredChecksConfigured: false,
    blockingPresentRunNames: [] as string[],
    latestPassingCompletedAt: '2026-06-25T11:00:00Z',
  };
}

test('operation-local watermark uses one rich capture and one CI agreement read', () => {
  let rich = 0;
  let agreement = 0;
  const snapshot = operationLocalSnapshot();
  const first = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => {
      rich += 1;
      return snapshot;
    },
    readRequiredCiAgreement: () => {
      agreement += 1;
      return passingAgreement();
    },
  });
  assert.equal(rich, 1);
  assert.equal(agreement, 1);
  assert.equal(first.decision, 'publish');
  assert.equal(first.watermarkFields?.['head-sha'], OPERATION_LOCAL_SHA);
  assert.equal(first.watermarkFields?.['total-item-count'], '1');
  assert.equal(
    first.watermarkFields?.['max-activity-at'],
    '2026-06-25T10:30:00Z',
  );
  assert.equal(
    first.watermarkFields?.['ci-completed-at'],
    '2026-06-25T11:00:00Z',
  );
  assert.equal(first.snapshot, snapshot);
  runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => {
      rich += 1;
      return snapshot;
    },
    readRequiredCiAgreement: () => {
      agreement += 1;
      return passingAgreement();
    },
  });
  assert.equal(rich, 2);
  assert.equal(agreement, 2);
});

test('operation-local incomplete collection does not call the CI agreement read', () => {
  let agreement = 0;
  assert.throws(
    () =>
      runOperationLocalSnapshotWatermark({
        prNumber: 3592,
        collectRichActivity: () => {
          throw new Error('pagination stopped');
        },
        readRequiredCiAgreement: () => {
          agreement += 1;
          return passingAgreement();
        },
      }),
    /incomplete review-activity collection: pagination stopped/,
  );
  assert.equal(agreement, 0);
  assert.throws(
    () =>
      runOperationLocalSnapshotWatermark({
        prNumber: 3592,
        collectRichActivity: () => ({ totalItemCount: 0 }),
        readRequiredCiAgreement: () => {
          agreement += 1;
          return passingAgreement();
        },
      }),
    /incomplete review-activity collection: review-activity-snapshot is missing a usable headSha/,
  );
  assert.equal(agreement, 0);
});

test('operation-local refuses a new HEAD, a moved expected HEAD, and CI completion drift', () => {
  const other = 'b'.repeat(40);
  const moved = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => passingAgreement(other),
  });
  assert.equal(moved.decision, 'refuse');
  assert.equal(moved.reasonCode, 'new-head');
  assert.match(moved.reason ?? '', /Re-run --from-pr/);

  const expected = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    expectedHeadSha: other,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(expected.reasonCode, 'expected-head');
  assert.match(expected.reason ?? '', /Re-run E1 from Step 1/);

  const completion = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => ({
      ...passingAgreement(),
      latestPassingCompletedAt: '2026-06-25T12:00:00Z',
    }),
  });
  assert.equal(completion.reasonCode, 'ci-completion');
});

test('operation-local defers the watermark when required CI is not passing', () => {
  for (const passing of [false]) {
    const result = runOperationLocalSnapshotWatermark({
      prNumber: 3592,
      collectRichActivity: () => operationLocalSnapshot(),
      readRequiredCiAgreement: () => ({
        ...passingAgreement(),
        requiredChecksPassing: passing,
      }),
    });
    assert.equal(result.decision, 'defer');
    assert.equal(result.reasonCode, 'required-checks');
    assert.equal(result.snapshot !== null, true);
  }
});

test('#3670: operation-local with no required check names the blocking runs and the deferral path', () => {
  const defer = (blockingPresentRunNames: string[]) =>
    runOperationLocalSnapshotWatermark({
      prNumber: 3592,
      collectRichActivity: () => operationLocalSnapshot(),
      readRequiredCiAgreement: () => ({
        ...passingAgreement(),
        requiredChecksPassing: false,
        noRequiredChecksConfigured: true,
        blockingPresentRunNames,
      }),
    });

  const one = defer(['idd-advisory-convergence']);
  assert.equal(one.decision, 'defer');
  assert.equal(one.reasonCode, 'present-run-failing');
  assert.match(one.reason ?? '', /^refusing to post watermark: /);
  assert.match(one.reason ?? '', /has no required check configured/);
  assert.match(one.reason ?? '', /idd-advisory-convergence is blocking\./);
  assert.match(one.reason ?? '', /deferral, not a deadlock/);
  assert.match(one.reason ?? '', /empty list routes through E15\/E14/);
  assert.doesNotMatch(one.reason ?? '', /required checks are not passing/);

  const two = defer(['docs', 'lint']);
  assert.equal(two.reasonCode, 'present-run-failing');
  assert.match(two.reason ?? '', /docs, lint are blocking\./);

  // A pending, cancelled-only, or empty run set blocks nothing by name, but
  // with no required check it is still not a required-check failure.
  const none = defer([]);
  assert.equal(none.decision, 'defer');
  assert.equal(none.reasonCode, 'required-checks');
  assert.match(none.reason ?? '', /has no required check configured/);
  assert.match(none.reason ?? '', /not all passing yet/);
  assert.match(none.reason ?? '', /deferral, not a deadlock/);
  assert.doesNotMatch(none.reason ?? '', /required checks are not passing/);
});

test('#3670: operation-local collapses whitespace in check names and caps how many it names', () => {
  const reasonFor = (blockingPresentRunNames: string[]) =>
    runOperationLocalSnapshotWatermark({
      prNumber: 3592,
      collectRichActivity: () => operationLocalSnapshot(),
      readRequiredCiAgreement: () => ({
        ...passingAgreement(),
        requiredChecksPassing: false,
        noRequiredChecksConfigured: true,
        blockingPresentRunNames,
      }),
    }).reason ?? '';

  // A name with a newline or runs of spaces stays on one line.
  const clean = reasonFor(['docs\nlint   job']);
  assert.equal(clean.includes('\n'), false);
  assert.match(clean, /docs lint job is blocking\./);

  // Five names fit exactly, six spill one, and the verb stays plural.
  assert.match(
    reasonFor(['a', 'b', 'c', 'd', 'e']),
    /, and a, b, c, d, e are blocking\./,
  );
  assert.match(
    reasonFor(['a', 'b', 'c', 'd', 'e', 'f']),
    /a, b, c, d, e and 1 more are blocking\./,
  );
  // Only the first five are named, then "and N more".
  assert.match(
    reasonFor(['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    /a, b, c, d, e and 2 more are blocking\./,
  );

  // Two raw names that collapse to the same string are listed once.
  assert.match(
    reasonFor(['docs  job', 'docs job']),
    /, and docs job is blocking\./,
  );

  // Names that are empty after cleaning are not named: the generic text
  // applies and the reason code stays required-checks.
  const blank = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => ({
      ...passingAgreement(),
      requiredChecksPassing: false,
      noRequiredChecksConfigured: true,
      blockingPresentRunNames: ['  ', '\n'],
    }),
  });
  assert.equal(blank.reasonCode, 'required-checks');
  assert.match(blank.reason ?? '', /not all passing yet/);
});

test('#3670: operation-local keeps the required-checks text when a required check is configured', () => {
  const result = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => ({
      ...passingAgreement(),
      requiredChecksPassing: false,
      noRequiredChecksConfigured: false,
      // Names are only meaningful with no required check configured.
      blockingPresentRunNames: ['docs'],
    }),
  });
  assert.equal(result.decision, 'defer');
  assert.equal(result.reasonCode, 'required-checks');
  assert.equal(
    result.reason,
    `refusing to post watermark: PR 3592's required checks are not passing. ` +
      `Re-run --from-pr once they pass.`,
  );
});

test('operation-local refuses newly actionable same-HEAD activity past a stored boundary', () => {
  const undispositioned = operationLocalSnapshot({
    totalItemCount: 2,
    maxActivityUpdatedAt: '2026-06-25T10:45:00Z',
    dispositionEvidence: {
      missingRegularCommentCount: 1,
      missingThreadCount: 0,
      soleCauseAckOnlyPostDisposition: false,
    },
  });
  const refused = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: OPERATION_LOCAL_SHA,
      totalItemCount: 1,
      maxActivityUpdatedAt: '2026-06-25T10:30:00Z',
    },
    collectRichActivity: () => undispositioned,
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(refused.decision, 'refuse');
  assert.equal(refused.reasonCode, 'same-head-activity');
  assert.match(refused.reason ?? '', /fresh triage/);

  const handled = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: OPERATION_LOCAL_SHA,
      totalItemCount: 1,
      maxActivityUpdatedAt: '2026-06-25T10:30:00Z',
    },
    collectRichActivity: () =>
      operationLocalSnapshot({
        totalItemCount: 2,
        maxActivityUpdatedAt: '2026-06-25T10:45:00Z',
      }),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(handled.decision, 'publish');
});

// #3622: a review whose only findings sit in its body (for example
// CodeRabbit's "outside the diff" blocks) advances the capture's item count
// and latest activity, but never shows up in `dispositionEvidence`, so the
// guard used to stay silent for it.
const EMBEDDED_BOUNDARY = {
  headSha: OPERATION_LOCAL_SHA,
  totalItemCount: 1,
  maxActivityUpdatedAt: '2026-06-25T10:30:00Z',
};

function snapshotWithEmbeddedFindings(
  embeddedFindings: unknown,
  overrides: Record<string, unknown> = {},
) {
  return operationLocalSnapshot({
    totalItemCount: 2,
    maxActivityUpdatedAt: '2026-06-25T10:45:00Z',
    embeddedFindings,
    ...overrides,
  });
}

test('operation-local refuses a review that arrived after the boundary and carries only uncovered body findings (#3622)', () => {
  const refused = runOperationLocalSnapshotWatermark({
    prNumber: 3622,
    priorBoundary: EMBEDDED_BOUNDARY,
    collectRichActivity: () =>
      snapshotWithEmbeddedFindings([
        { reviewId: 'PRR_new', embeddedFindingCount: 2, uncoveredCount: 2 },
      ]),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(refused.decision, 'refuse');
  assert.equal(refused.reasonCode, 'same-head-activity');
  assert.deepEqual(refused.warnings, [
    '2 review-body findings have no thread of their own, so the boundary ' +
      'guard cannot treat those reviews as handled.',
  ]);
});

test('operation-local publishes when the body findings are covered, absent, or older than the boundary (#3622)', () => {
  for (const [label, embeddedFindings, overrides] of [
    [
      'covered by a thread',
      [{ reviewId: 'PRR_new', embeddedFindingCount: 2, uncoveredCount: 0 }],
      {},
    ],
    ['none reported', [], {}],
    ['field absent', undefined, {}],
    ['malformed field', 'not-an-array', {}],
    [
      'no activity past the boundary',
      [{ reviewId: 'PRR_old', embeddedFindingCount: 1, uncoveredCount: 1 }],
      { totalItemCount: 1, maxActivityUpdatedAt: '2026-06-25T10:30:00Z' },
    ],
  ] as const) {
    const result = runOperationLocalSnapshotWatermark({
      prNumber: 3622,
      priorBoundary: EMBEDDED_BOUNDARY,
      collectRichActivity: () =>
        snapshotWithEmbeddedFindings(embeddedFindings, { ...overrides }),
      readRequiredCiAgreement: () => passingAgreement(),
    });
    assert.equal(result.decision, 'publish', label);
  }
});

test('operation-local does not refuse uncovered body findings without a stored boundary (#3622)', () => {
  const result = runOperationLocalSnapshotWatermark({
    prNumber: 3622,
    collectRichActivity: () =>
      snapshotWithEmbeddedFindings([
        { reviewId: 'PRR_new', embeddedFindingCount: 1, uncoveredCount: 1 },
      ]),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(result.decision, 'publish');
  // Body findings only ever show up in a refusal's warnings, so a standalone
  // --from-pr and an --operation-local run without a boundary print what they
  // printed before.
  assert.deepEqual(result.warnings, []);
});

test('describeUnaddressedActivity ignores review-body findings, which only a refusal reports (#3622)', () => {
  assert.deepEqual(
    describeUnaddressedActivity({
      embeddedFindings: [
        { reviewId: 'PRR_a', embeddedFindingCount: 1, uncoveredCount: 1 },
      ],
    }),
    [],
  );
});

test('a refusal reports the summed uncovered body findings next to the undispositioned-item warning (#3622)', () => {
  const refuse = (snapshot: Record<string, unknown>) =>
    runOperationLocalSnapshotWatermark({
      prNumber: 3622,
      priorBoundary: EMBEDDED_BOUNDARY,
      collectRichActivity: () => snapshotWithEmbeddedFindings([], snapshot),
      readRequiredCiAgreement: () => passingAgreement(),
    });
  const many = refuse({
    embeddedFindings: [
      { reviewId: 'PRR_a', embeddedFindingCount: 1, uncoveredCount: 1 },
      { reviewId: 'PRR_b', embeddedFindingCount: 3, uncoveredCount: 0 },
      { reviewId: 'PRR_c', embeddedFindingCount: 2, uncoveredCount: 2 },
      null,
      { reviewId: 'PRR_d', uncoveredCount: -4 },
      { reviewId: 'PRR_e', uncoveredCount: 'x' },
    ],
  });
  assert.equal(many.decision, 'refuse');
  assert.deepEqual(many.warnings, [
    '3 review-body findings have no thread of their own, so the boundary ' +
      'guard cannot treat those reviews as handled.',
  ]);
  const one = refuse({
    embeddedFindings: [
      { reviewId: 'PRR_a', embeddedFindingCount: 1, uncoveredCount: 1 },
    ],
  });
  assert.deepEqual(one.warnings, [
    '1 review-body finding has no thread of its own, so the boundary guard ' +
      'cannot treat that review as handled.',
  ]);
  const both = refuse({
    dispositionEvidence: {
      missingRegularCommentCount: 1,
      missingThreadCount: 0,
      soleCauseAckOnlyPostDisposition: false,
    },
    embeddedFindings: [
      { reviewId: 'PRR_a', embeddedFindingCount: 1, uncoveredCount: 1 },
    ],
  });
  assert.equal(both.decision, 'refuse');
  assert.equal(both.warnings.length, 2);
  assert.match(both.warnings[0], /^1 comment has no disposition evidence/);
  assert.match(both.warnings[1], /^1 review-body finding has no thread/);
});

// ---------------------------------------------------------------------------
// #3622: `--operation-local` through the CLI. The offline `gh` stub answers the
// activity capture and the required-check read, and records every comment POST
// so a run can be told from a deferred or refused one by what it posted.
// ---------------------------------------------------------------------------

function operationLocalCliStub(
  options: Parameters<typeof watermarkFromPrGhStub>[1],
  postLogPath: string,
): string {
  const prelude = `const __fs = require('node:fs');
const __args = process.argv.slice(2);
if (__args[0] === 'api' && __args.includes('--method') && __args[__args.indexOf('--method') + 1] === 'POST') {
  const __sent = JSON.parse(__fs.readFileSync(0, 'utf8'));
  __fs.appendFileSync(${JSON.stringify(postLogPath)}, JSON.stringify({ args: __args, body: __sent.body }) + '\\n');
  process.stdout.write(JSON.stringify({ id: 9001, html_url: 'https://github.com/o/r/issues/1200#issuecomment-9001', body: __sent.body }));
  process.exit(0);
}
`;
  return prelude + watermarkFromPrGhStub(SHA, options);
}

/** The slice of the CLI's JSON envelope these tests read. */
interface OperationLocalCliEnvelope {
  mode?: string;
  body?: string;
  commentId?: number;
  warnings?: string[];
  operationLocal: {
    decision: string;
    reason: string | null;
    watermarkFields: Record<string, string>;
  };
}

interface OperationLocalCliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  posts: { args: string[]; body: string }[];
  json: OperationLocalCliEnvelope | null;
}

function runOperationLocalCli(
  extraArgs: readonly string[],
  stubOptions: Parameters<typeof watermarkFromPrGhStub>[1] = {},
): OperationLocalCliRun {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-operation-local-cli-'));
  const postLog = join(tempRoot, 'posts.jsonl');
  const restore = stubExecutable(
    'gh',
    operationLocalCliStub(stubOptions, postLog),
  );
  try {
    const { status, stdout, stderr } = runWatermarkCli([...extraArgs]);
    return {
      status,
      stdout,
      stderr,
      posts: existsSync(postLog)
        ? readFileSync(postLog, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line))
        : [],
      json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null,
    };
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** The boundary flags of one stored watermark, for the stub's HEAD. */
function boundaryFlags(count: string, maxActivityAt: string): string[] {
  return [
    '--prior-head-sha',
    SHA,
    '--prior-total-item-count',
    count,
    '--prior-max-activity-at',
    maxActivityAt,
  ];
}

test('--operation-local dry-run publishes the same marker body plus the operationLocal envelope (#3622)', () => {
  const plain = runOperationLocalCli([]);
  const local = runOperationLocalCli(['--operation-local']);
  assert.equal(plain.status, 0);
  assert.equal(local.status, 0);
  assert.equal(local.json?.mode, 'dry-run');
  assert.equal(local.json?.body, plain.json?.body);
  assert.deepEqual(local.json?.warnings, plain.json?.warnings);
  assert.equal(local.json?.operationLocal.decision, 'publish');
  assert.equal(local.json?.operationLocal.reason, null);
  assert.equal(local.json?.operationLocal.watermarkFields['head-sha'], SHA);
  assert.equal(plain.json !== null && 'operationLocal' in plain.json, false);
  assert.deepEqual(local.posts, []);
});

test('--operation-local --apply POSTs exactly one marker whose body is the dry-run body (#3622)', () => {
  const dryRun = runOperationLocalCli(['--operation-local']);
  const applied = runOperationLocalCli(['--operation-local', '--apply']);
  assert.equal(applied.status, 0);
  assert.equal(applied.json?.mode, 'apply');
  assert.equal(applied.json?.commentId, 9001);
  assert.equal(applied.json?.operationLocal.decision, 'publish');
  assert.equal(applied.posts.length, 1);
  assert.equal(applied.posts[0].body, dryRun.json?.body);
});

test('--operation-local refuses new same-HEAD activity past a stored boundary given as count 0 or none (#3622)', () => {
  for (const [count, maxActivityAt] of [
    ['0', 'none'],
    ['0', '2026-06-25T10:00:00Z'],
    ['1', '2026-06-25T10:00:00Z'],
  ] as const) {
    for (const apply of [false, true]) {
      const run = runOperationLocalCli([
        '--operation-local',
        ...boundaryFlags(count, maxActivityAt),
        ...(apply ? ['--apply'] : []),
      ]);
      const label = `${count}/${maxActivityAt}${apply ? ' --apply' : ''}`;
      assert.equal(run.status, 1, label);
      assert.match(run.stderr, /fresh triage/, label);
      assert.equal(run.json?.mode, 'dry-run', label);
      assert.equal(run.json?.operationLocal.decision, 'refuse', label);
      assert.equal('body' in (run.json ?? {}), false, label);
      assert.deepEqual(run.posts, [], label);
    }
  }
});

test('--operation-local publishes when nothing arrived past the stored boundary (#3622)', () => {
  const unchanged = runOperationLocalCli([
    '--operation-local',
    ...boundaryFlags('1', '2026-06-25T10:30:00Z'),
  ]);
  assert.equal(unchanged.status, 0);
  assert.equal(unchanged.json?.operationLocal.decision, 'publish');
  const empty = runOperationLocalCli(
    ['--operation-local', ...boundaryFlags('0', 'none')],
    { commentsBody: '[]' },
  );
  assert.equal(empty.status, 0);
  assert.equal(empty.json?.operationLocal.decision, 'publish');
});

test('--operation-local evaluates the boundary guard before the defer for failing required checks (#3622)', () => {
  const failing = {
    rollupNodes: [rollupCheck('lint', 'FAILURE')],
    rulesBody: REQUIRED_LINT_RULE,
  };
  // No boundary: the required-check failure defers, exit 0, nothing posted.
  const deferred = runOperationLocalCli(
    ['--operation-local', '--apply'],
    failing,
  );
  assert.equal(deferred.status, 0);
  assert.equal(deferred.json?.mode, 'dry-run');
  assert.equal(deferred.json?.operationLocal.decision, 'defer');
  assert.match(
    deferred.json?.operationLocal.reason ?? '',
    /required checks are not passing/,
  );
  assert.equal('body' in (deferred.json ?? {}), false);
  assert.deepEqual(deferred.posts, []);
  // The same failing checks with a boundary the capture already passed: the
  // guard refuses first, so the caller gets the triage route, not a retry.
  const refused = runOperationLocalCli(
    ['--operation-local', '--apply', ...boundaryFlags('0', 'none')],
    failing,
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.json?.operationLocal.decision, 'refuse');
  assert.match(refused.stderr, /fresh triage/);
  assert.deepEqual(refused.posts, []);
});

test('--operation-local refuses a review that arrived after the boundary and carries only uncovered body findings (#3622)', () => {
  const review = JSON.stringify([
    {
      id: 555,
      node_id: 'PRR_coderabbit_body_only',
      user: { login: 'coderabbitai[bot]' },
      body: PR_1897_REVIEW_4863787336,
      state: 'COMMENTED',
      submitted_at: '2026-06-25T10:50:00Z',
      commit_id: SHA,
    },
  ]);
  const options = { commentsBody: '[]', reviewsBody: review };
  const refused = runOperationLocalCli(
    ['--operation-local', ...boundaryFlags('0', 'none')],
    options,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /fresh triage/);
  assert.equal(refused.json?.operationLocal.decision, 'refuse');
  assert.match(
    refused.json?.warnings?.[0] ?? '',
    /^\d+ review-body findings? (has|have) no thread of (its|their) own/,
  );
  // The same capture publishes once the boundary already contains the review.
  const publishes = runOperationLocalCli(
    ['--operation-local', ...boundaryFlags('1', '2026-06-25T10:50:00Z')],
    options,
  );
  assert.equal(publishes.status, 0);
  assert.equal(publishes.json?.operationLocal.decision, 'publish');
  // The uncovered body finding is reported by a refusal only.
  assert.equal('warnings' in (publishes.json ?? {}), false);
});

// #3622: the CLI's exit codes and refusal envelope stay covered by its help output.

test('--help states the defer exit code and the refusal envelope (#3622)', () => {
  const help = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), '--help'],
    { encoding: 'utf8' },
  ).replace(/\s+/g, ' ');
  assert.match(help, /Read operationLocal\.decision to tell the runs apart/);
  assert.match(help, /publish posts the marker \(exit 0\)/);
  assert.match(help, /defer exits 0 with "mode": "dry-run" and posts nothing/);
  assert.match(
    help,
    /refuse exits 1, posts nothing, and prints the same envelope on stdout next to the reason on stderr/,
  );
  assert.match(help, /which is checked before the defer/);
  assert.match(help, /values E1 Step 1 saw for the SAME HEAD/);
  assert.match(help, /findings in a review body that has no thread for them/);
});

test('operation-local orders same-HEAD activity by instant, not timestamp text (#3592)', () => {
  const laterFractional = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: OPERATION_LOCAL_SHA,
      totalItemCount: 2,
      maxActivityUpdatedAt: '2026-05-11T08:00:00Z',
    },
    collectRichActivity: () =>
      operationLocalSnapshot({
        totalItemCount: 2,
        maxActivityUpdatedAt: '2026-05-11T08:00:00.100Z',
        dispositionEvidence: {
          missingRegularCommentCount: 1,
          missingThreadCount: 0,
          soleCauseAckOnlyPostDisposition: false,
        },
      }),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(laterFractional.decision, 'refuse');
  assert.equal(laterFractional.reasonCode, 'same-head-activity');

  const earlierWholeSecond = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: OPERATION_LOCAL_SHA,
      totalItemCount: 2,
      maxActivityUpdatedAt: '2026-05-11T08:00:00.900Z',
    },
    collectRichActivity: () =>
      operationLocalSnapshot({
        totalItemCount: 2,
        maxActivityUpdatedAt: '2026-05-11T08:00:00Z',
        dispositionEvidence: {
          missingRegularCommentCount: 1,
          missingThreadCount: 0,
          soleCauseAckOnlyPostDisposition: false,
        },
      }),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.notEqual(earlierWholeSecond.reasonCode, 'same-head-activity');
});

test('operation-local refuses a prior boundary recorded for a different HEAD (#3592)', () => {
  const otherHead = 'b'.repeat(40);
  // This capture has neither more items nor newer activity than the boundary,
  // which is exactly the case an untied boundary silently let through.
  const mismatched = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: otherHead,
      totalItemCount: 5,
      maxActivityUpdatedAt: '2026-06-25T10:45:00Z',
    },
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(mismatched.decision, 'refuse');
  assert.equal(mismatched.reasonCode, 'prior-head');
  assert.match(mismatched.reason ?? '', new RegExp(otherHead));

  const sameHeadOtherCase = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    priorBoundary: {
      headSha: OPERATION_LOCAL_SHA.toUpperCase(),
      totalItemCount: 1,
      maxActivityUpdatedAt: '2026-06-25T10:30:00Z',
    },
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => passingAgreement(),
  });
  assert.equal(sameHeadOtherCase.decision, 'publish');
});

const POST_IDD_MARKER_CLI = join(REPO_ROOT, 'scripts/post-idd-marker.mjs');

function runWatermarkCli(extra: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      POST_IDD_MARKER_CLI,
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
      ...extra,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Make the stub `gh` append every argv it sees to `logFile`, one JSON line each. */
function withGhArgvLog(stub: string, logFile: string): string {
  return stub.replace(
    'const args = process.argv.slice(2);',
    `const args = process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');`,
  );
}

function ghPostCalls(logFile: string): string[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('--input'));
}

test('--prior-* flags must be passed together and only with --operation-local (#3592)', () => {
  const partial = runWatermarkCli([
    '--operation-local',
    '--prior-total-item-count',
    '1',
    '--prior-max-activity-at',
    'none',
  ]);
  assert.equal(partial.status, 1);
  assert.match(
    partial.stderr,
    /--prior-head-sha, --prior-total-item-count and --prior-max-activity-at must be passed together/,
  );

  const withoutOperationLocal = runWatermarkCli([
    '--prior-head-sha',
    SHA,
    '--prior-total-item-count',
    '1',
    '--prior-max-activity-at',
    'none',
  ]);
  assert.equal(withoutOperationLocal.status, 1);
  assert.match(
    withoutOperationLocal.stderr,
    /are only valid with --operation-local/,
  );
});

test('--prior-max-activity-at accepts only none or a canonical UTC timestamp (#3592)', () => {
  // Validation must run before any network call, so a `gh` that fails on any
  // invocation proves it: a bad value is a usage error, not a confusing
  // "newly actionable activity" refusal produced by an unordered comparison.
  const restore = stubGhNeverCalled();
  try {
    for (const bad of ['zzz', '2026-06-25', '2026-06-25T19:44:00+09:00']) {
      const result = runWatermarkCli([
        '--operation-local',
        '--prior-head-sha',
        SHA,
        '--prior-total-item-count',
        '1',
        '--prior-max-activity-at',
        bad,
      ]);
      assert.equal(result.status, 1, `expected exit 1 for ${bad}`);
      assert.match(
        result.stderr,
        /--prior-max-activity-at must be none or a canonical UTC timestamp/,
      );
      assert.doesNotMatch(result.stderr, /unexpected gh invocation/);
      assert.equal(result.stdout, '');
    }
  } finally {
    restore();
  }
});

test('the operationLocal envelope schema requires every view field, including reason (#3592)', () => {
  const view: Record<string, unknown> = {
    decision: 'publish',
    reason: null,
    snapshot: {},
    watermarkFields: { 'head-sha': SHA },
    warnings: [],
  };
  const envelope = {
    mode: 'dry-run',
    type: 'watermark',
    target: 'pr',
    number: 1200,
    operationLocal: view,
  };
  assert.deepEqual(validate(envelope, schema), []);
  for (const field of Object.keys(view)) {
    const { [field]: _omitted, ...rest } = view;
    assert.notDeepEqual(
      validate({ ...envelope, operationLocal: rest }, schema),
      [],
      `operationLocal without ${field} must not validate`,
    );
  }
});

test('--operation-local CLI defers with the capture and never posts while required checks fail (#3592)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-defer-'));
  const argvLog = join(tempRoot, 'gh-argv.log');
  const restore = stubExecutable(
    'gh',
    withGhArgvLog(
      watermarkFromPrGhStub(SHA, {
        rollupNodes: [rollupCheck('lint', 'FAILURE')],
        rulesBody: REQUIRED_LINT_RULE,
      }),
      argvLog,
    ),
  );
  try {
    for (const apply of [false, true]) {
      const result = runWatermarkCli([
        '--operation-local',
        ...(apply ? ['--apply'] : []),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.deepEqual(validate(envelope, schema), []);
      assert.equal(envelope.mode, 'dry-run');
      assert.equal(envelope.type, 'watermark');
      assert.equal(envelope.target, 'pr');
      assert.equal(envelope.number, 1200);
      assert.equal(envelope.operationLocal.decision, 'defer');
      assert.match(
        envelope.operationLocal.reason,
        /required checks are not passing/,
      );
      assert.equal(envelope.operationLocal.snapshot.headSha, SHA);
      assert.equal(envelope.operationLocal.watermarkFields['head-sha'], SHA);
    }
    assert.ok(
      readFileSync(argvLog, 'utf8').length > 0,
      'the stub must have observed the capture reads',
    );
    assert.deepEqual(ghPostCalls(argvLog), [], 'a deferred watermark posts');
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--operation-local CLI defers with no required check, names the blocking run, and never posts (#3670)', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-post-idd-marker-no-required-'),
  );
  const argvLog = join(tempRoot, 'gh-argv.log');
  const restore = stubExecutable(
    'gh',
    withGhArgvLog(
      // No required check configured (the default empty rules), so the failing
      // present run decides CI.
      watermarkFromPrGhStub(SHA, {
        rollupNodes: [
          rollupCheck('lint', 'SUCCESS'),
          rollupCheck('docs', 'FAILURE'),
        ],
      }),
      argvLog,
    ),
  );
  try {
    for (const apply of [false, true]) {
      const result = runWatermarkCli([
        '--operation-local',
        ...(apply ? ['--apply'] : []),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.deepEqual(validate(envelope, schema), []);
      assert.equal(envelope.operationLocal.decision, 'defer');
      assert.match(
        envelope.operationLocal.reason,
        /has no required check configured, so its present runs decide CI, and docs is blocking\. In E1 Step 2 this is a deferral, not a deadlock/,
      );
      assert.doesNotMatch(
        envelope.operationLocal.reason,
        /required checks are not passing/,
      );
      assert.equal(envelope.operationLocal.snapshot.headSha, SHA);
    }
    assert.deepEqual(ghPostCalls(argvLog), [], 'a deferred watermark posts');
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--operation-local CLI refuses a --prior-head-sha for another HEAD with the envelope and never posts (#3592)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-prior-'));
  const argvLog = join(tempRoot, 'gh-argv.log');
  const otherHead = 'b'.repeat(40);
  const restore = stubExecutable(
    'gh',
    withGhArgvLog(watermarkFromPrGhStub(SHA), argvLog),
  );
  try {
    // `none` and a canonical timestamp are both valid boundary values.
    for (const priorMax of ['2026-06-25T10:45:00Z', 'none']) {
      const result = runWatermarkCli([
        '--operation-local',
        '--prior-head-sha',
        otherHead,
        '--prior-total-item-count',
        '5',
        '--prior-max-activity-at',
        priorMax,
        '--apply',
      ]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        new RegExp(`stored prior boundary is for HEAD ${otherHead}`),
      );
      const envelope = JSON.parse(result.stdout);
      assert.deepEqual(validate(envelope, schema), []);
      assert.equal(envelope.operationLocal.decision, 'refuse');
      assert.equal(envelope.operationLocal.snapshot.headSha, SHA);
    }
    assert.deepEqual(ghPostCalls(argvLog), [], 'a refused watermark posts');
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--operation-local keeps a required-CI read failure classified in the error envelope (#3592)', () => {
  // Before the operation-local refactor a failed required-check read reached
  // classifyHelperError; folding it into a `ci-read` refusal must not turn a
  // tagged 503 into a generic gate exit under IDD_HELPER_ERROR_ENVELOPE=1.
  const failingRollup = watermarkFromPrGhStub(SHA).replace(
    'const args = process.argv.slice(2);',
    `const args = process.argv.slice(2);\nif (args[0] === 'api' && args[1] === 'graphql' && args.join(' ').includes('statusCheckRollup')) { process.stderr.write('gh: Service Unavailable (HTTP 503)'); process.exit(1); }`,
  );
  const restore = stubExecutable('gh', failingRollup);
  try {
    const result = spawnSync(
      process.execPath,
      [
        POST_IDD_MARKER_CLI,
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
        '--operation-local',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, IDD_HELPER_ERROR_ENVELOPE: '1' },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    // The capture is still returned on stdout as a refusal ...
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.operationLocal.decision, 'refuse');
    assert.match(
      envelope.operationLocal.reason,
      /could not read required-check state/,
    );
    // ... while the stderr error envelope keeps the underlying classification.
    const line = result.stderr
      .split('\n')
      .find((candidate) => candidate.includes('iddHelperError'));
    assert.ok(line, `no error envelope on stderr: ${result.stderr}`);
    const error = JSON.parse(line).iddHelperError;
    assert.equal(error.kind, 'transport');
    assert.equal(error.httpStatus, 503);
  } finally {
    restore();
  }
});

test('operation-local CI agreement failure keeps the capture and does not publish', () => {
  const result = runOperationLocalSnapshotWatermark({
    prNumber: 3592,
    collectRichActivity: () => operationLocalSnapshot(),
    readRequiredCiAgreement: () => {
      throw new Error('rules unreadable');
    },
  });
  assert.equal(result.decision, 'refuse');
  assert.equal(result.reasonCode, 'ci-read');
  assert.equal(
    (result.snapshot as { headSha: string }).headSha,
    OPERATION_LOCAL_SHA,
  );
});

// #3655: the one-command watermark path must not refuse a courtesy ack that
// only follows a cosmetic in-place edit of an advisory-bot comment. The
// timestamps sit before the stub's passing check (2026-06-25T11:00:00Z).
function cosmeticEditFixtureBodies(finding: string): {
  threadsBody: string;
  editsBody: string;
} {
  const marker = (kind: string) =>
    `<!-- This is an auto-generated ${kind} by CodeRabbit -->`;
  const bot = 'coderabbitai[bot]';
  const original = `**Potential issue**: the cache key ignores the host.\n\n${marker('comment')}`;
  const edited = `${finding}\n\n${marker('reply')}`;
  const node = (
    id: string,
    login: string,
    body: string,
    created: string,
    updated: string,
    lastEditedAt: string | null,
  ) => ({
    id,
    body,
    createdAt: created,
    updatedAt: updated,
    lastEditedAt,
    author: { login },
    pullRequestReview: null,
  });
  return {
    threadsBody: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PRRT_courtesy',
                  isResolved: true,
                  path: 'src/a.ts',
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      node(
                        'PRRC_root',
                        bot,
                        edited,
                        '2026-06-25T09:29:17Z',
                        '2026-06-25T10:02:44Z',
                        '2026-06-25T10:02:44Z',
                      ),
                      node(
                        'PRRC_disposition',
                        'kurone-kito',
                        '**Rejected** — the host is part of the key already.',
                        '2026-06-25T10:02:38Z',
                        '2026-06-25T10:02:38Z',
                        null,
                      ),
                      node(
                        'PRRC_ack',
                        bot,
                        '`@kurone-kito`, confirmed. Thanks.\n\n✅ Review thread resolved.\n\n' +
                          marker('reply'),
                        '2026-06-25T10:03:05Z',
                        '2026-06-25T10:03:05Z',
                        null,
                      ),
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    }),
    editsBody: JSON.stringify({
      data: {
        nodes: [
          {
            id: 'PRRC_root',
            userContentEdits: {
              totalCount: 2,
              nodes: [
                {
                  editedAt: '2026-06-25T10:02:44Z',
                  diff: edited,
                  editor: { login: bot },
                  deletedAt: null,
                },
                {
                  editedAt: '2026-06-25T09:29:17Z',
                  diff: original,
                  editor: { login: bot },
                  deletedAt: null,
                },
              ],
            },
          },
        ],
      },
    }),
  };
}

function runCosmeticEditWatermark(finding: string): {
  status: number | null;
  stderr: string;
  envelope: {
    operationLocal: {
      decision: string;
      reason?: string | null;
      warnings: string[];
    };
  };
} {
  const restore = stubExecutable(
    'gh',
    watermarkFromPrGhStub(SHA, {
      commentsBody: '[]',
      ...cosmeticEditFixtureBodies(finding),
    }),
  );
  try {
    const result = runWatermarkCli([
      '--operation-local',
      '--trusted-marker-logins',
      'kurone-kito',
      '--advisory-bot-logins',
      'coderabbitai[bot]',
      '--prior-head-sha',
      SHA,
      '--prior-total-item-count',
      '0',
      '--prior-max-activity-at',
      'none',
    ]);
    return {
      status: result.status,
      stderr: result.stderr,
      envelope: result.stdout
        ? JSON.parse(result.stdout)
        : { operationLocal: {} },
    };
  } finally {
    restore();
  }
}

test('--operation-local CLI publishes past a cosmetic bot edit followed by a courtesy ack (#3655)', () => {
  const result = runCosmeticEditWatermark(
    '**Potential issue**: the cache key ignores the host.',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.envelope.operationLocal.decision, 'publish');
  assert.deepEqual(result.envelope.operationLocal.warnings, []);
});

test('--operation-local CLI still refuses a genuinely new post-disposition bot finding (#3655)', () => {
  const result = runCosmeticEditWatermark(
    '**Potential issue**: also handle an empty host.',
  );
  // A refusal exits 1 but still prints the envelope.
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.envelope.operationLocal.decision, 'refuse');
  assert.match(
    result.envelope.operationLocal.reason ?? '',
    /newly actionable same-HEAD activity/,
  );
});

// #3910: the identity check of `--apply --type authoring-owner`. The gh stub
// serves the GraphQL comment log (or a raw reply a test asks for), the
// live-body GET the digest derivation makes, and the POST. It appends every
// POST body and every GraphQL call to a file, so a test can assert what was
// sent and whether a read happened at all.
const OWNER_ID_TARGET = 'o/r#42';
const OWNER_ID_SET = 'set-8fc92e8e9b28760e';
const OWNER_ID_MANGLED_SET = 'set-8fc92e9b28760e';
const OWNER_ID_OWNER = 'owner-d805d0d1';
const OWNER_ID_PRIOR_OWNER = 'owner-prior-1111';
const OWNER_ID_SESSION = 'session-1';
const OWNER_ID_LIVE_BODY = 'Fresh live body for #42.';
// The explicit --body-sha256 is verified against the live body the stub
// serves, so the fixture digest must be that body's real digest.
const OWNER_ID_DIGEST = createHash('sha256')
  .update(OWNER_ID_LIVE_BODY, 'utf8')
  .digest('hex');

interface OwnerIdComment {
  id: number;
  body: string;
  author?: string;
  lastEditedAt?: string | null;
  minimizedReason?: string | null;
}

/** The flags of one authoring-owner post; `overrides` replaces any of them. */
function ownerIdFlags(
  mode: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const anchorOnly = mode === 'release-guard' || mode === 'release-complete';
  const opening = mode === 'acquire' || mode === 'bootstrap';
  return {
    'marker-target': OWNER_ID_TARGET,
    anchor: OWNER_ID_TARGET,
    mode,
    'marker-owner': OWNER_ID_OWNER,
    set: OWNER_ID_SET,
    session: OWNER_ID_SESSION,
    'body-sha256': anchorOnly ? 'none' : OWNER_ID_DIGEST,
    'snapshot-sha256': mode === 'release-complete' ? OWNER_ID_DIGEST : 'none',
    supersedes: opening ? 'none' : OWNER_ID_OWNER,
    ...overrides,
  };
}

/** The body the renderer posts for `flags`: an opening marker or any other. */
function ownerIdBody(flags: Record<string, string>): string {
  return buildMarkerBody('authoring-owner', {
    'marker-prefix': 'idd-skill',
    ...flags,
  });
}

function withOwnerIdStub(options: {
  comments?: OwnerIdComment[];
  graphqlReply?: { stdout: string } | { stderr: string };
}): { postsFile: string; readsFile: string; restore: () => void } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-identity-'));
  const postsFile = join(tempRoot, 'posts.txt');
  const readsFile = join(tempRoot, 'reads.txt');
  const nodes = (options.comments ?? []).map((comment) => ({
    databaseId: comment.id,
    lastEditedAt: comment.lastEditedAt ?? null,
    createdAt: TS,
    updatedAt: TS,
    body: comment.body,
    author: { login: comment.author ?? 'kurone-kito' },
    isMinimized: (comment.minimizedReason ?? null) !== null,
    minimizedReason: comment.minimizedReason ?? null,
  }));
  const page = JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
  const reply = options.graphqlReply ?? { stdout: page };
  const replyCode =
    'stdout' in reply
      ? `out(${JSON.stringify(reply.stdout)});`
      : `fail(${JSON.stringify(reply.stderr)});`;
  const restore = stubExecutable(
    'gh',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
function out(s) { fs.writeSync(1, s); process.exit(0); }
function fail(s) { fs.writeSync(2, s); process.exit(1); }
if (args.includes('graphql')) {
  fs.appendFileSync(${JSON.stringify(readsFile)}, 'graphql\\n');
  ${replyCode}
}
if (args[0] === 'api' && args[1] === 'repos/o/r/issues/42') {
  out(JSON.stringify({ number: 42, body: ${JSON.stringify(OWNER_ID_LIVE_BODY)} }));
}
if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  const raw = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(${JSON.stringify(postsFile)}, raw + '\\n');
  out(JSON.stringify({ id: 555, html_url: 'https://github.com/o/r/issues/42#issuecomment-555', body: JSON.parse(raw).body }));
}
fail('unexpected gh invocation: ' + args.join(' '));
`,
  );
  return {
    postsFile,
    readsFile,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function readOwnerIdLines(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];
}

function runOwnerIdPost(
  flags: Record<string, string>,
  options: { apply?: boolean; cwd?: string; trustedLogins?: string } = {},
): { status: number | null; stderr: string; kind: string | undefined } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IDD_HELPER_ERROR_ENVELOPE: '1',
  };
  delete env.IDD_TRUSTED_MARKER_ACTORS;
  const result = spawnSync(
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
      ...Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value]),
      ...(options.trustedLogins === undefined
        ? []
        : ['--trusted-marker-logins', options.trustedLogins]),
      ...(options.apply === false ? [] : ['--apply']),
    ],
    { cwd: options.cwd ?? REPO_ROOT, encoding: 'utf8', env },
  );
  const lines = result.stderr.trim().split('\n');
  let kind: string | undefined;
  try {
    kind = (
      JSON.parse(lines[lines.length - 1]) as {
        iddHelperError?: { kind?: string };
      }
    ).iddHelperError?.kind;
  } catch {
    kind = undefined;
  }
  return { status: result.status, stderr: result.stderr, kind };
}

const OWNER_ID_ACQUIRE_OPENER: OwnerIdComment = {
  id: 101,
  body: ownerIdBody(ownerIdFlags('acquire')),
};

test('authoring-owner --apply refuses a release whose set id lost two characters, names both ids, and sends nothing (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('release', { set: OWNER_ID_MANGLED_SET }),
    );
    assert.equal(run.status, 1);
    assert.equal(run.kind, 'gate');
    assert.match(
      run.stderr,
      new RegExp(`posted ${OWNER_ID_MANGLED_SET}, found ${OWNER_ID_SET}`),
    );
    assert.match(run.stderr, /comment #101 \(mode=acquire\)/);
    assert.match(run.stderr, /claim\.verifySettleDelay/);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply sends a release whose set id matches the opening marker (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(ownerIdFlags('release'));
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a heartbeat whose anchor differs from the opening marker (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat', { anchor: 'o/r#7' }));
    assert.equal(run.status, 1);
    assert.equal(run.kind, 'gate');
    assert.match(run.stderr, /anchor: posted o\/r#7, found o\/r#42/);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a heartbeat whose owner differs from the opening marker (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('heartbeat', {
        'marker-owner': 'owner-other',
        supersedes: 'owner-other',
      }),
    );
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      new RegExp(`owner: posted owner-other, found ${OWNER_ID_OWNER}`),
    );
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply sends a release from another session with the same set, anchor and owner (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('release', { session: 'session-2' }),
    );
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply sends a corrected release after a mangled release is already in the log (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [
      OWNER_ID_ACQUIRE_OPENER,
      {
        id: 102,
        body: ownerIdBody(
          ownerIdFlags('release', { set: OWNER_ID_MANGLED_SET }),
        ),
      },
    ],
  });
  try {
    const run = runOwnerIdPost(ownerIdFlags('release'));
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test("authoring-owner --apply sends a heartbeat of the first set while a second set's opener lost the race (#3910)", () => {
  const stub = withOwnerIdStub({
    comments: [
      {
        id: 101,
        body: ownerIdBody(
          ownerIdFlags('acquire', {
            set: 'set-first',
            'marker-owner': 'owner-first',
          }),
        ),
      },
      {
        id: 102,
        body: ownerIdBody(
          ownerIdFlags('acquire', {
            set: 'set-second',
            'marker-owner': 'owner-second',
          }),
        ),
      },
    ],
  });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('heartbeat', {
        set: 'set-first',
        'marker-owner': 'owner-first',
        supersedes: 'owner-first',
      }),
    );
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply sends a resume whose --supersedes names an opening owner with the same set and anchor (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [
      {
        id: 101,
        body: ownerIdBody(
          ownerIdFlags('acquire', { 'marker-owner': OWNER_ID_PRIOR_OWNER }),
        ),
      },
    ],
  });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('resume', {
        'marker-owner': OWNER_ID_OWNER,
        supersedes: OWNER_ID_PRIOR_OWNER,
      }),
    );
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a resume whose set differs from the opening marker (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [
      {
        id: 101,
        body: ownerIdBody(
          ownerIdFlags('acquire', { 'marker-owner': OWNER_ID_PRIOR_OWNER }),
        ),
      },
    ],
  });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('resume', {
        'marker-owner': OWNER_ID_OWNER,
        supersedes: OWNER_ID_PRIOR_OWNER,
        set: OWNER_ID_MANGLED_SET,
      }),
    );
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      new RegExp(`set: posted ${OWNER_ID_MANGLED_SET}, found ${OWNER_ID_SET}`),
    );
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a resume that no opening marker owner matches (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [
      {
        id: 101,
        body: ownerIdBody(
          ownerIdFlags('acquire', { 'marker-owner': OWNER_ID_PRIOR_OWNER }),
        ),
      },
    ],
  });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('resume', {
        'marker-owner': OWNER_ID_OWNER,
        supersedes: 'owner-unknown',
      }),
    );
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      new RegExp(
        `owner \\(--supersedes\\): posted owner-unknown, found ${OWNER_ID_PRIOR_OWNER}`,
      ),
    );
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a heartbeat when the target has no opening marker (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [] });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'));
    assert.equal(run.status, 1);
    assert.equal(run.kind, 'gate');
    assert.match(run.stderr, /no counted opening marker/);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a heartbeat whose only opening marker was edited after posting (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [
      { ...OWNER_ID_ACQUIRE_OPENER, lastEditedAt: '2026-10-09T01:00:00Z' },
    ],
  });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no counted opening marker/);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses a heartbeat whose opening marker is by a login outside the trusted set (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [{ ...OWNER_ID_ACQUIRE_OPENER, author: 'stranger' }],
  });
  try {
    // Run from the repository root, whose configuration trusts
    // kurone-kito; the flag names a different login so the author is outside.
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'), {
      trustedLogins: 'someone-else',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no counted opening marker/);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply still counts a minimized opening marker (#3910)', () => {
  const stub = withOwnerIdStub({
    comments: [{ ...OWNER_ID_ACQUIRE_OPENER, minimizedReason: 'outdated' }],
  });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'));
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply counts any login when the working directory configures no trusted logins (#3910)', () => {
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'idd-post-idd-marker-cwd-'));
  const stub = withOwnerIdStub({
    comments: [{ ...OWNER_ID_ACQUIRE_OPENER, author: 'stranger' }],
  });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'), {
      cwd: isolatedCwd,
    });
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
});

test('authoring-owner --apply checks release-guard and release-complete against the anchor opening marker (#3910)', () => {
  for (const mode of ['release-guard', 'release-complete']) {
    const matching = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
    try {
      assert.equal(runOwnerIdPost(ownerIdFlags(mode)).status, 0, mode);
      assert.equal(readOwnerIdLines(matching.postsFile).length, 1, mode);
    } finally {
      matching.restore();
    }
    const differingOverrides: Record<string, string>[] = [
      { set: OWNER_ID_MANGLED_SET },
      { 'marker-owner': 'owner-other', supersedes: 'owner-other' },
    ];
    for (const overrides of differingOverrides) {
      const differing = withOwnerIdStub({
        comments: [OWNER_ID_ACQUIRE_OPENER],
      });
      try {
        const run = runOwnerIdPost(ownerIdFlags(mode, overrides));
        assert.equal(run.status, 1, mode);
        assert.equal(run.kind, 'gate', mode);
        assert.deepEqual(readOwnerIdLines(differing.postsFile), [], mode);
      } finally {
        differing.restore();
      }
    }
  }
});

test('authoring-owner --apply sends acquire and bootstrap posts with no GraphQL read (#3910)', () => {
  for (const mode of ['acquire', 'bootstrap']) {
    const stub = withOwnerIdStub({ comments: [] });
    try {
      const run = runOwnerIdPost(ownerIdFlags(mode));
      assert.equal(run.status, 0, mode);
      assert.deepEqual(readOwnerIdLines(stub.readsFile), [], mode);
      assert.equal(readOwnerIdLines(stub.postsFile).length, 1, mode);
    } finally {
      stub.restore();
    }
  }
});

test('authoring-owner dry run makes no GraphQL read and posts nothing (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [] });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'), { apply: false });
    assert.equal(run.status, 0);
    assert.deepEqual(readOwnerIdLines(stub.readsFile), []);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses, sending nothing, when the GraphQL read fails with HTTP 503 (#3910)', () => {
  const stub = withOwnerIdStub({
    graphqlReply: { stderr: 'gh: Service Unavailable (HTTP 503)' },
  });
  try {
    const run = runOwnerIdPost(ownerIdFlags('heartbeat'));
    assert.equal(run.status, 1);
    assert.equal(run.kind, 'transport');
    assert.equal(readOwnerIdLines(stub.readsFile).length, 1);
    assert.deepEqual(readOwnerIdLines(stub.postsFile), []);
  } finally {
    stub.restore();
  }
});

test('authoring-owner --apply refuses, sending nothing, on an incomplete GraphQL read, as internal and never a gate (#3910)', () => {
  const incomplete: { stdout: string }[] = [
    // A repeated cursor: the third request reuses "c1" and the reader stops.
    {
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            },
          },
        },
      }),
    },
    { stdout: JSON.stringify({ errors: [{ message: 'boom' }] }) },
    { stdout: 'not json' },
    {
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [
                  {
                    lastEditedAt: null,
                    createdAt: TS,
                    updatedAt: TS,
                    body: 'x',
                    author: { login: 'kurone-kito' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    },
  ];
  for (const reply of incomplete) {
    const stub = withOwnerIdStub({ graphqlReply: reply });
    try {
      const run = runOwnerIdPost(ownerIdFlags('heartbeat'));
      assert.equal(run.status, 1, reply.stdout);
      assert.equal(run.kind, 'internal', reply.stdout);
      assert.deepEqual(readOwnerIdLines(stub.postsFile), [], reply.stdout);
    } finally {
      stub.restore();
    }
  }
});

test('authoring-owner --apply compares the set as rendered, so padding around an equal set is sent (#3910)', () => {
  const stub = withOwnerIdStub({ comments: [OWNER_ID_ACQUIRE_OPENER] });
  try {
    const run = runOwnerIdPost(
      ownerIdFlags('release', { set: ` ${OWNER_ID_SET} ` }),
    );
    assert.equal(run.status, 0);
    assert.equal(readOwnerIdLines(stub.postsFile).length, 1);
  } finally {
    stub.restore();
  }
});

test('selectAuthoringOwnerOpeningMarkers counts only acquire, bootstrap and resume markers naming the target, ignoring case (#3910)', () => {
  const comment = (id: number, body: string) => ({
    id,
    authorLogin: 'kurone-kito',
    body,
    createdAt: TS,
    updatedAt: TS,
    lastEditedAt: null,
  });
  const comments = [
    comment(
      1,
      ownerIdBody(
        ownerIdFlags('acquire', {
          'marker-target': 'O/R#42',
          anchor: 'O/R#42',
        }),
      ),
    ),
    comment(2, ownerIdBody(ownerIdFlags('release'))),
    comment(
      3,
      ownerIdBody(
        ownerIdFlags('acquire', {
          'marker-target': 'o/r#99',
          anchor: 'o/r#99',
        }),
      ),
    ),
  ];
  const openers = selectAuthoringOwnerOpeningMarkers(comments, {
    target: OWNER_ID_TARGET,
    markerPrefix: 'idd-skill',
    trustedLogins: new Set(),
    requireUnedited: true,
  });
  assert.deepEqual(
    openers.map((opener) => opener.id),
    [1],
  );
});

test('validateAuthoringOwnerPostIdentity names the earliest opening marker when two are equally close (#3910)', () => {
  const comments = [201, 202].map((id) => ({
    id,
    authorLogin: 'kurone-kito',
    body: ownerIdBody(ownerIdFlags('acquire', { set: `set-${id}` })),
    createdAt: TS,
    updatedAt: TS,
    lastEditedAt: null,
  }));
  const post = parseAuthoringOwnerComment(
    ownerIdBody(ownerIdFlags('heartbeat')),
    'idd-skill',
  );
  assert.ok(post);
  const refusal = validateAuthoringOwnerPostIdentity(
    post,
    selectAuthoringOwnerOpeningMarkers(comments, {
      target: OWNER_ID_TARGET,
      markerPrefix: 'idd-skill',
      trustedLogins: new Set(),
      requireUnedited: true,
    }),
  );
  assert.match(refusal ?? '', /comment #201 \(mode=acquire\)/);
  assert.doesNotMatch(refusal ?? '', /#202/);
});

test('post-idd-marker --help describes the authoring-owner identity check (#3910)', () => {
  const help = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/post-idd-marker.mjs'), '--help'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.match(help, /is refused, with exit 1 and nothing posted,/);
  assert.match(help, /\(#3910\)/);
});
