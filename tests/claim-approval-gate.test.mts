import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateClaimApprovalGate,
  wrapGhError,
} from '../src/scripts/claim-approval-gate.mts';
import { deriveGhHttpStatus } from '../src/scripts/gh-http-status.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

type GateResult = ReturnType<typeof evaluateClaimApprovalGate>;

function permissionResolver(map: Record<string, unknown>) {
  return (login: string) => {
    const value = map[login];
    if (value === undefined) {
      return { known: false, permission: '', error: 'unknown login' };
    }
    return value;
  };
}

function findCheck(result: GateResult, id: string) {
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

// --- #1693: shared gh-http-status.mts wiring --------------------------

// wrapGhError is runGh's catch-branch pure step, exported so these tests
// can inject a raw execFileSync-shaped error directly instead of shelling
// out to a real `gh` invocation (#1212's mock-free-subprocess convention).
// Composing it with deriveGhHttpStatus (the same composition
// ghApiJsonWithStatus's catch branch performs internally) proves the full
// wiring, not just the underlying shared helper in isolation.

test('wrapGhError preserves stdout on the wrapped error (previously dropped)', () => {
  const wrapped = wrapGhError({
    status: 1,
    stderr: 'gh: Not Found (HTTP 404)',
    stdout: '{"message":"Not Found","status":"404"}',
  }) as { stderr?: string; stdout?: string };
  assert.equal(wrapped.stderr, 'gh: Not Found (HTTP 404)');
  assert.equal(wrapped.stdout, '{"message":"Not Found","status":"404"}');
});

test('wrapGhError returns the original error unchanged when stderr is empty', () => {
  const original = { status: 1, stderr: '', stdout: 'irrelevant' };
  assert.equal(wrapGhError(original), original);
});

test('wrapGhError + deriveGhHttpStatus never surfaces a bare exit code as the HTTP status', () => {
  // gh exits 1 for 401/403/404 alike; the removed status-derivation logic
  // in ghApiJsonWithStatus greped stderr only for /HTTP\s+(\d+)/ and fell
  // through to a "status could not be determined" 0 when absent -- so an
  // exit code never leaked through this specific path even before the
  // fix. This test locks in that invariant against the new composition.
  const wrapped = wrapGhError({ status: 1, stderr: 'connect ETIMEDOUT' });
  assert.equal(deriveGhHttpStatus(wrapped), null);
});

test('wrapGhError + deriveGhHttpStatus recovers a status from a JSON error body on stdout', () => {
  // #1693: the prior local ghApiJsonWithStatus implementation greped
  // stderr only, and even wrapGhError's predecessor dropped .stdout on the
  // wrapped error -- so a JSON error body written to stdout (with no
  // "(HTTP NNN)" text in stderr) was invisible end to end. Both defects
  // are fixed together: wrapGhError now preserves .stdout, and
  // deriveGhHttpStatus already knows how to fall back to it.
  const wrapped = wrapGhError({
    status: 1,
    stderr: 'gh: Not Found',
    stdout: '{"message":"Not Found","status":"404"}',
  });
  assert.equal(deriveGhHttpStatus(wrapped), 404);
});

// #1721: claim-approval-gate was one of three helpers that silently
// swallowed every --policy load failure (including an explicitly-supplied
// path) into fallback defaults (fail-open). It now routes through
// idd-config.mts's loadPolicyConfig, which fails closed for an
// unreadable/malformed explicit path.

test('CLI path fails when an explicit --policy file is invalid', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-claim-approval-gate-policy-'),
  );
  const ghPath = join(tempRoot, 'gh');
  const policyPath = join(tempRoot, 'bad-policy.json');

  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  const jq = args[args.indexOf("--jq") + 1];
  process.stdout.write(jq === ".owner.login" ? "kurone-kito\\n" : "idd-skill\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] && args[1].endsWith("/issues/1")) {
  process.stdout.write(JSON.stringify({
    number: 1,
    title: "t",
    state: "OPEN",
    html_url: "https://example.com/issues/1",
    user: { login: "author" },
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] && args[1].endsWith("/comments")) {
  process.stdout.write("[]\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] && args[1].endsWith("/timeline")) {
  process.stdout.write("[]\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  writeFileSync(policyPath, '{not-json');
  chmodSync(ghPath, 0o755);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/claim-approval-gate.mjs'),
          '--issue',
          '1',
          '--policy',
          policyPath,
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
    /failed to load policy from .*bad-policy\.json/,
  );
});
