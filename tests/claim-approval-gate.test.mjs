import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateClaimApprovalGate } from '../scripts/claim-approval-gate.mjs';

const BASE_ISSUE = {
  number: 393,
  title: 'helper gate',
  state: 'OPEN',
  user: { login: 'author' },
  labels: [],
  created_at: '2026-05-10T00:00:00Z',
  updated_at: '2026-05-10T00:00:00Z',
};

const BASE_TIMELINE = [
  {
    event: 'edited',
    created_at: '2026-05-10T10:00:00Z',
    changes: { body: { from: 'old' } },
  },
];

function permissionResolver(map) {
  return (login) => {
    const value = map[login];
    if (value === undefined) {
      return { known: false, permission: '', error: 'unknown login' };
    }
    return value;
  };
}

function findCheck(result, id) {
  return result.checks.find((check) => check.id === id);
}

test('disables gate only when skipIssueAuthorApprovalGate is true', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      policy: { skipIssueAuthorApprovalGate: true },
    },
    { resolvePermission: permissionResolver({}) },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'gate-disabled');
});

test('author self-authorization passes for maintain under default policy', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      policy: { maintainerApprovalActorPolicy: 'owners-and-maintainers-only' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'maintain' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'author-self-authorized');
});

test('write collaborator is not self-authorized under default policy', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      policy: { maintainerApprovalActorPolicy: 'owners-and-maintainers-only' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'write' },
      }),
    },
  );
  assert.equal(result.approved, false);
});

test('write collaborator is self-authorized under all-write policy', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      policy: { maintainerApprovalActorPolicy: 'all-write-permission-actors' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'write' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'author-self-authorized');
});

test('ready label grants approval by presence', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'idd:ready' }] },
      policy: {},
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: { known: false, permission: '' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'ready-label-present');
});

test('custom configured ready label grants approval by presence', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'custom:ready' }] },
      policy: {
        approvalSignals: {
          readyLabelName: 'custom:ready',
          labelFreshnessMode: 'presence-only',
        },
      },
      timeline: BASE_TIMELINE,
      comments: [],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'ready-label-present');
  assert.deepEqual(result.policy.approvalSignals, {
    readyLabelName: 'custom:ready',
    labelFreshnessMode: 'presence-only',
  });
});

test('event-freshness label approval requires a fresh matching label event', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'custom:ready' }] },
      policy: {
        approvalSignals: {
          readyLabelName: 'custom:ready',
          labelFreshnessMode: 'event-freshness',
        },
      },
      timeline: [
        ...BASE_TIMELINE,
        {
          event: 'labeled',
          created_at: '2026-05-10T12:00:00Z',
          label: { name: 'custom:ready' },
        },
      ],
      comments: [],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'ready-label-present');
});

test('event-freshness label approval becomes stale after later issue edits', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'custom:ready' }] },
      policy: {
        approvalSignals: {
          readyLabelName: 'custom:ready',
          labelFreshnessMode: 'event-freshness',
        },
      },
      timeline: [
        {
          event: 'labeled',
          created_at: '2026-05-10T09:00:00Z',
          label: { name: 'custom:ready' },
        },
        ...BASE_TIMELINE,
      ],
      comments: [],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-missing');
  assert.equal(findCheck(result, 'ready_label_present')?.result, 'fail');
  assert.match(
    findCheck(result, 'ready_label_present')?.evidence ?? '',
    /last applied at 2026-05-10T09:00:00Z; freshness anchor is 2026-05-10T10:00:00Z/,
  );
});

test('event-freshness label approval is invalidated by generated-plan updates', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'custom:ready' }] },
      policy: {
        approvalSignals: {
          readyLabelName: 'custom:ready',
          labelFreshnessMode: 'event-freshness',
        },
      },
      timeline: [
        ...BASE_TIMELINE,
        {
          event: 'labeled',
          created_at: '2026-05-10T11:00:00Z',
          label: { name: 'custom:ready' },
        },
      ],
      comments: [],
      generatedPlanUpdatedAt: '2026-05-10T11:30:00Z',
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-missing');
  assert.match(
    findCheck(result, 'ready_label_present')?.evidence ?? '',
    /last applied at 2026-05-10T11:00:00Z; freshness anchor is 2026-05-10T11:30:00Z/,
  );
});

test('event-freshness label approval fails closed when label events are unavailable', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, labels: [{ name: 'custom:ready' }] },
      policy: {
        approvalSignals: {
          readyLabelName: 'custom:ready',
          labelFreshnessMode: 'event-freshness',
        },
      },
      comments: [],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'freshness-undetermined');
  assert.equal(findCheck(result, 'ambiguity_guard')?.result, 'fail');
});

test('ready comment must be exact or standalone line and fresh', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'notes\nIDD ready\nthanks',
          created_at: '2026-05-10T12:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'admin' },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'ready-comment-fresh');
});

test('non-standalone phrases are rejected as approval comments', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'not IDD ready yet',
          created_at: '2026-05-10T12:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'admin' },
      }),
    },
  );
  assert.equal(result.approved, false);
});

test('approval comment older than issue edit is stale', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'IDD ready',
          created_at: '2026-05-10T09:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'maintain' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-comment-stale');
});

test('unauthorized ready comments route to approval-missing, not stale', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'outsider' },
          body: 'IDD ready',
          created_at: '2026-05-10T12:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        outsider: { known: true, permission: 'none' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-missing');
});

test('approval comment equal to anchor timestamp is stale (must be strictly newer)', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'IDD ready',
          created_at: '2026-05-10T10:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'admin' },
      }),
    },
  );
  assert.equal(result.approved, false);
});

test('generated-plan updates are part of freshness anchor', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      generatedPlanUpdatedAt: '2026-05-10T11:30:00Z',
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'IDD ready',
          created_at: '2026-05-10T11:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'admin' },
      }),
    },
  );
  assert.equal(result.approved, false);
});

test('permission lookup ambiguity fails closed without explicit label', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'IDD ready',
          created_at: '2026-05-10T12:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: false, permission: '' },
        maintainer: { known: false, permission: '' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-ambiguous');
});

test('timeline absence makes freshness undetermined for comment-based approval', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      comments: [
        {
          user: { login: 'maintainer' },
          body: 'IDD ready',
          created_at: '2026-05-10T12:00:00Z',
        },
      ],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
        maintainer: { known: true, permission: 'admin' },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'freshness-undetermined');
});

test('check ids stay deterministic and ordered', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: BASE_ISSUE,
      timeline: BASE_TIMELINE,
      comments: [],
    },
    {
      resolvePermission: permissionResolver({
        author: { known: true, permission: 'none' },
      }),
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      'gate_enabled',
      'author_self_authorized',
      'ready_label_present',
      'ready_comment_fresh',
      'ambiguity_guard',
    ],
  );
});
