import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMarkerBody,
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
  for (const omit of Object.keys(fullFields)) {
    const fields = { ...fullFields };
    delete (fields as Record<string, string>)[omit];
    assert.throws(
      () => buildMarkerBody('copilot-unavailable', fields),
      /invalid copilot-unavailable marker payload/,
      `omitting ${omit} should throw`,
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
  // Missing nonce for an activation-nonce marker.
  assert.throws(
    () =>
      buildMarkerBody('activation-nonce', {
        'agent-id': 'a',
        'claim-id': 'c',
        timestamp: TS,
      }),
    /invalid activation-nonce marker payload/,
  );
});

test('MARKER_TYPES lists exactly the nine supported types', () => {
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
if (args[0] === 'pr' && args[1] === 'view') out('${SHA}\\n');
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
  });
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
if (args[0] === 'pr' && args[1] === 'view') out('${headSha}\\n');
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

test('--from-pr is rejected for a non-watermark type', () => {
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
  assert.match(stderr, /--from-pr is only valid for --type watermark/);
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
