import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseScopeOverrunRecordComment,
  renderScopeOverrunRecordComment,
  resolveScopeOverrunEvidence,
} from '../src/scripts/marker-helpers.mts';

const ISSUE = 4674;
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const PREFIX = 'idd-skill';
const TRUSTED = ['kurone-kito'];
const FILES = ['src/z.mts', 'src/a.mts'];
let nextEvidenceId = 1;

function prePushRecord(files = FILES): string {
  return renderScopeOverrunRecordComment({
    markerPrefix: PREFIX,
    agentId: 'worker-1',
    issueNumber: ISSUE,
    effort: 'M',
    candidateFiles: files,
  });
}

function postPushRecord(headSha = HEAD, files = FILES): string {
  return renderScopeOverrunRecordComment({
    markerPrefix: PREFIX,
    agentId: 'worker-1',
    issueNumber: ISSUE,
    effort: 'M',
    candidateFiles: files,
    pullRequestNumber: 4399,
    branch: 'issue/4674-scope-overrun',
    headSha,
  });
}

function evidenceComment(
  body: string,
  overrides: {
    authorLogin?: string;
    lastEditedAt?: string | null;
    id?: number | string | null;
    createdAt?: string | null;
  } = {},
) {
  const id = nextEvidenceId++;
  return {
    body,
    authorLogin: overrides.authorLogin ?? 'kurone-kito',
    id: overrides.id === undefined ? id : overrides.id,
    createdAt:
      overrides.createdAt === undefined
        ? '2026-10-24T18:00:00Z'
        : overrides.createdAt,
    lastEditedAt:
      overrides.lastEditedAt === undefined ? null : overrides.lastEditedAt,
  };
}

test('scope-overrun pre-push record round-trips without invented PR fields', () => {
  const body = prePushRecord();
  const parsed = parseScopeOverrunRecordComment(body, PREFIX);
  assert.deepEqual(parsed, {
    kind: 'pre-push',
    agentId: 'worker-1',
    issueNumber: ISSUE,
    effort: 'M',
    candidateFiles: ['src/a.mts', 'src/z.mts'],
  });
  assert.doesNotMatch(body.split('\n', 1)[0], /\b(?:pr|branch|head)=/);
});

test('scope-overrun post-push record round-trips PR, branch, and full HEAD', () => {
  const parsed = parseScopeOverrunRecordComment(postPushRecord(), PREFIX);
  assert.deepEqual(parsed, {
    kind: 'post-push',
    agentId: 'worker-1',
    issueNumber: ISSUE,
    effort: 'M',
    candidateFiles: ['src/a.mts', 'src/z.mts'],
    pullRequestNumber: 4399,
    branch: 'issue/4674-scope-overrun',
    headSha: HEAD,
  });
});

test('scope-overrun permits internal spaces and visibly lists sorted paths', () => {
  const body = prePushRecord(['src/z file.mts', 'src/a file.mts']);
  assert.equal(
    parseScopeOverrunRecordComment(body, PREFIX)?.candidateFiles.join(','),
    'src/a file.mts,src/z file.mts',
  );
  assert.match(body, /candidate files: `src\/a file\.mts`, `src\/z file\.mts`/);
});

test('scope-overrun rejects non-canonical candidate path spellings', () => {
  for (const file of [
    '/src/file.mts',
    'C:/src/file.mts',
    'src\\file.mts',
    'src//file.mts',
    'src/./file.mts',
    'src/../file.mts',
    ' src/file.mts',
    'src/file.mts ',
    'src/`file`.mts',
    'src/file\n.mts',
    'src/\u0001file.mts',
  ]) {
    assert.throws(() => prePushRecord([file]), file);
  }
  assert.throws(() => prePushRecord(['src/file.mts', 'src/file.mts']));
});

test('scope-overrun parser rejects unsorted candidate-file payloads', () => {
  const sorted = encodeURIComponent(JSON.stringify(['src/a.mts', 'src/z.mts']));
  const unsorted = encodeURIComponent(
    JSON.stringify(['src/z.mts', 'src/a.mts']),
  );
  assert.equal(
    parseScopeOverrunRecordComment(
      prePushRecord().replace(sorted, unsorted),
      PREFIX,
    ),
    null,
  );
});

test('scope-overrun requires the configured marker prefix and canonical body', () => {
  assert.equal(parseScopeOverrunRecordComment(prePushRecord(), 'other'), null);
  assert.equal(
    parseScopeOverrunRecordComment(
      prePushRecord().replace('effort=M', 'effort=M extra=true'),
      PREFIX,
    ),
    null,
  );
});

test('scope-overrun rejects a worker-marked exact-head decision', () => {
  const result = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(
        `Scope decision: accept head ${HEAD}\n\n<!-- idd-agent-authored: codex-worker -->\n\n_codex-worker: IDD automation comment; attribution is self-reported._`,
      ),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.deepEqual(
    { status: result.status, reason: result.reason },
    { status: 'invalid', reason: 'decision-agent-authored' },
  );
});

test('scope-overrun accepts only a trusted exact-head first-line decision', () => {
  const decision = `Scope decision: accept head ${HEAD}\nReviewed scope.`;
  const result = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(prePushRecord()),
      evidenceComment(postPushRecord()),
      evidenceComment(decision),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.record?.kind, 'post-push');
  assert.equal(result.decisionHeadSha, HEAD);
});

test('scope-overrun rejects acceptance when the current PR head changes', () => {
  const result = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.deepEqual(
    { status: result.status, reason: result.reason },
    { status: 'pending', reason: 'current-head-mismatch' },
  );
});

test('scope-overrun fails closed for untrusted record and decision authors', () => {
  const recordResult = resolveScopeOverrunEvidence({
    comments: [evidenceComment(prePushRecord(), { authorLogin: 'intruder' })],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(recordResult.reason, 'record-untrusted');

  const decisionResult = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`, {
        authorLogin: 'intruder',
      }),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(decisionResult.reason, 'decision-untrusted');
});

test('scope-overrun fails closed for malformed, edited, or conflicting evidence', () => {
  const malformed = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(
        '<!-- idd-skill-scope-overrun: v1 issue=4674 effort=M -->',
      ),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
  });
  assert.equal(malformed.reason, 'record-malformed');

  const edited = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(prePushRecord(), {
        lastEditedAt: '2026-10-24T18:00:00Z',
      }),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
  });
  assert.equal(edited.reason, 'record-edited-or-unknown');

  const editedDecision = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`, {
        lastEditedAt: '2026-10-24T18:00:00Z',
      }),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(editedDecision.reason, 'decision-edited-or-unknown');

  const conflictingRecord = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(prePushRecord()),
      evidenceComment(prePushRecord(['src/other.mts'])),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
  });
  assert.equal(conflictingRecord.reason, 'record-conflict');

  const conflictingDecision = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`, {
        id: 250,
        createdAt: '2026-10-24T18:00:00Z',
      }),
      evidenceComment(`Scope decision: accept head ${OTHER_HEAD}`, {
        id: 250,
        createdAt: '2026-10-24T18:00:00Z',
      }),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(conflictingDecision.reason, 'decision-conflict');
});

test('scope-overrun rejects incomplete GitHub ordering metadata', () => {
  for (const missing of [{ id: null }, { id: 0 }, { createdAt: null }]) {
    const record = resolveScopeOverrunEvidence({
      comments: [evidenceComment(postPushRecord(), missing)],
      markerPrefix: PREFIX,
      trustedMarkerLogins: TRUSTED,
      issueNumber: ISSUE,
    });
    assert.equal(record.reason, 'record-malformed');

    const decision = resolveScopeOverrunEvidence({
      comments: [
        evidenceComment(postPushRecord()),
        evidenceComment(`Scope decision: accept head ${HEAD}`, missing),
      ],
      markerPrefix: PREFIX,
      trustedMarkerLogins: TRUSTED,
      issueNumber: ISSUE,
      currentHeadSha: HEAD,
    });
    assert.equal(decision.reason, 'decision-malformed');
  }
});

test('scope-overrun decision cannot accept a pre-push record or a different recorded head', () => {
  const preOnly = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(prePushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(preOnly.reason, 'pre-push-record-has-no-head');

  const mismatchedDecision = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${OTHER_HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.equal(mismatchedDecision.status, 'pending');
  assert.equal(mismatchedDecision.reason, 'decision-head-mismatch');
});

test('scope-overrun requires a complete PR tuple and matching issue number', () => {
  assert.throws(
    () =>
      renderScopeOverrunRecordComment({
        markerPrefix: PREFIX,
        agentId: 'worker-1',
        issueNumber: ISSUE,
        effort: 'M',
        candidateFiles: FILES,
        pullRequestNumber: 4399,
      }),
    /either no PR fields or a PR number, branch, and full 40-character HEAD together/,
  );
  const wrongIssueRecord = renderScopeOverrunRecordComment({
    markerPrefix: PREFIX,
    agentId: 'worker-1',
    issueNumber: ISSUE + 1,
    effort: 'M',
    candidateFiles: FILES,
    pullRequestNumber: 4399,
    branch: 'issue/4674-scope-overrun',
    headSha: HEAD,
  });
  const result = resolveScopeOverrunEvidence({
    comments: [evidenceComment(wrongIssueRecord)],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
  });
  assert.equal(result.reason, 'record-issue-mismatch');
});

test('scope-overrun needs a well-formed decision and a live current head', () => {
  const malformed = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD.slice(0, 39)}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(malformed.reason, 'decision-malformed');

  const unavailable = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
  });
  assert.equal(unavailable.reason, 'current-head-unavailable');
});

test('scope-overrun tolerates identical duplicate evidence', () => {
  const result = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord()),
      evidenceComment(postPushRecord()),
      evidenceComment(`Scope decision: accept head ${HEAD}`),
      evidenceComment(`Scope decision: accept head ${HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(result.status, 'accepted');
});

test('scope-overrun uses numeric comment IDs to order same-time head revisions', () => {
  const firstHead = evidenceComment(postPushRecord(HEAD), {
    id: 100,
    createdAt: '2026-10-24T18:00:00Z',
  });
  const oldDecision = evidenceComment(`Scope decision: accept head ${HEAD}`, {
    id: 101,
    createdAt: '2026-10-24T18:00:00Z',
  });
  const revisedHead = evidenceComment(postPushRecord(OTHER_HEAD), {
    id: 102,
    createdAt: '2026-10-24T18:00:00Z',
  });
  const pending = resolveScopeOverrunEvidence({
    comments: [firstHead, oldDecision, revisedHead],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'decision-head-mismatch');
  assert.equal(
    pending.record?.kind === 'post-push' && pending.record.headSha,
    OTHER_HEAD,
  );

  const accepted = resolveScopeOverrunEvidence({
    comments: [
      firstHead,
      oldDecision,
      revisedHead,
      evidenceComment(`Scope decision: accept head ${OTHER_HEAD}`, {
        id: 103,
        createdAt: '2026-10-24T18:03:00Z',
      }),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.equal(accepted.status, 'accepted');
});

test('scope-overrun keeps conflicts with ambiguous comment ordering', () => {
  const ambiguous = {
    id: 200,
    createdAt: '2026-10-24T18:00:00Z',
  };
  const recordConflict = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord(HEAD), ambiguous),
      evidenceComment(postPushRecord(OTHER_HEAD), ambiguous),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.equal(recordConflict.reason, 'record-conflict');

  const decisionConflict = resolveScopeOverrunEvidence({
    comments: [
      evidenceComment(postPushRecord(HEAD)),
      evidenceComment(`Scope decision: accept head ${HEAD}`, ambiguous),
      evidenceComment(`Scope decision: accept head ${OTHER_HEAD}`, ambiguous),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: OTHER_HEAD,
  });
  assert.equal(decisionConflict.reason, 'decision-conflict');
});
