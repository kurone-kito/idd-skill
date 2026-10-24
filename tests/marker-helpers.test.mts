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
  overrides: { authorLogin?: string; lastEditedAt?: string | null } = {},
) {
  return {
    body,
    authorLogin: overrides.authorLogin ?? 'kurone-kito',
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
      evidenceComment(`Scope decision: accept head ${HEAD}`),
      evidenceComment(`Scope decision: accept head ${OTHER_HEAD}`),
    ],
    markerPrefix: PREFIX,
    trustedMarkerLogins: TRUSTED,
    issueNumber: ISSUE,
    currentHeadSha: HEAD,
  });
  assert.equal(conflictingDecision.reason, 'decision-conflict');
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
  assert.equal(mismatchedDecision.reason, 'decision-head-mismatch');
});
