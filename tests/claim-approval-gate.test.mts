import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateClaimApprovalGate } from '../src/scripts/claim-approval-gate.mts';
import { stubExecutable } from './test-utils.mts';

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

test('OWNER author_association self-authorizes when permission read is unknown (#2148)', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, author_association: 'OWNER' },
      policy: { maintainerApprovalActorPolicy: 'owners-and-maintainers-only' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: {
          known: false,
          permission: '',
          error: 'permission lookup failed: 503',
        },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'author-self-authorized');
  assert.equal(findCheck(result, 'ambiguity_guard')?.result, 'pass');
});

test('MEMBER author_association self-authorizes under default policy when permission read is unknown (#2148)', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, author_association: 'MEMBER' },
      policy: { maintainerApprovalActorPolicy: 'owners-and-maintainers-only' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: {
          known: false,
          permission: '',
          error: 'permission lookup failed: 503',
        },
      }),
    },
  );
  assert.equal(result.approved, true);
  assert.equal(result.reason, 'author-self-authorized');
});

test('CONTRIBUTOR author_association does not self-authorize when permission read is unknown', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, author_association: 'CONTRIBUTOR' },
      policy: { maintainerApprovalActorPolicy: 'owners-and-maintainers-only' },
      timeline: BASE_TIMELINE,
    },
    {
      resolvePermission: permissionResolver({
        author: {
          known: false,
          permission: '',
          error: 'permission lookup failed: 503',
        },
      }),
    },
  );
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'approval-ambiguous');
});

test('known write permission is not overridden by OWNER association', () => {
  const result = evaluateClaimApprovalGate(
    {
      issue: { ...BASE_ISSUE, author_association: 'OWNER' },
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

// #1721: claim-approval-gate was one of three helpers that silently
// swallowed every --policy load failure (including an explicitly-supplied
// path) into fallback defaults (fail-open). It now routes through
// idd-config.mts's loadPolicyConfig, which fails closed for an
// unreadable/malformed explicit path.

test('CLI path fails when an explicit --policy file is invalid', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-claim-approval-gate-policy-'),
  );
  const policyPath = join(tempRoot, 'bad-policy.json');
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
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
  try {
    writeFileSync(policyPath, '{not-json');

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
            env: { ...process.env },
          },
        ),
      /failed to load policy from .*bad-policy\.json/,
    );
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// #2195: --token substituted GH_TOKEN/GITHUB_TOKEN for gh auth, ambiguous
// against select-desynced-index.mjs's unrelated same-named session-desync
// token. --gh-token is now canonical; --token stays a deprecated alias for
// one release. A fake `gh` on PATH dumps GH_TOKEN/GITHUB_TOKEN to a side
// file before failing (any real network call is out of scope for this
// flag-propagation test), so the CLI process always exits non-zero -- only
// the dumped env values matter here.
function ghTokenPropagationFixture() {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-claim-approval-gate-token-'),
  );
  const dumpPath = join(tempRoot, 'env-dump.json');
  const restore = stubExecutable(
    'gh',
    `require('fs').writeFileSync(process.env.ENV_DUMP_PATH, JSON.stringify({
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
}));
process.exit(1);
`,
  );
  return {
    dumpPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function runClaimApprovalGateCli(
  extraArgs: string[],
  fixture: ReturnType<typeof ghTokenPropagationFixture>,
) {
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/claim-approval-gate.mjs'),
        '--issue',
        '1',
        ...extraArgs,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
      },
    ),
  );
  return JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
    ghToken: string | null;
    githubToken: string | null;
  };
}

test('--gh-token sets GH_TOKEN/GITHUB_TOKEN for gh auth', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    const dump = runClaimApprovalGateCli(
      ['--gh-token', 'canonical-test-token'],
      fixture,
    );
    assert.equal(dump.ghToken, 'canonical-test-token');
    assert.equal(dump.githubToken, 'canonical-test-token');
  } finally {
    fixture.restore();
  }
});

test('--token still sets GH_TOKEN/GITHUB_TOKEN and warns as a deprecated alias', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/claim-approval-gate.mjs'),
          '--issue',
          '1',
          '--token',
          'deprecated-test-token',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
        },
      );
      assert.fail('expected the CLI to exit non-zero');
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? '');
    }
    const dump = JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
      ghToken: string | null;
      githubToken: string | null;
    };
    assert.equal(dump.ghToken, 'deprecated-test-token');
    assert.equal(dump.githubToken, 'deprecated-test-token');
    assert.match(stderr, /--token is deprecated; use --gh-token instead\./);
  } finally {
    fixture.restore();
  }
});
