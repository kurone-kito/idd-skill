import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { computeBranchName } from '../src/scripts/branch-name.mts';
import {
  type ClaimIssueDeps,
  type ClaimIssueReport,
  type ClaimStopReason,
  type CommandResult,
  createDefaultDeps,
  createDefaultRunner,
  runClaimIssue,
  runClaimPrechecks,
} from '../src/scripts/claim-issue.mts';
import type { HelperCliResult } from '../src/scripts/helper-cli-runner.mts';
import {
  inspectLocalWorktreeBranchPrefix,
  type LocalWorktreeInspection,
} from '../src/scripts/local-worktree-occupancy.mts';
import {
  createFakeProviderAdapter,
  type FakeProviderFixture,
} from '../src/scripts/provider-adapter-fake.mts';
import {
  createGithubProviderAdapter,
  type GithubProviderAdapterDeps,
} from '../src/scripts/provider-adapter-github.mts';
import type { ProviderPort } from '../src/scripts/provider-port.mts';
import {
  fixtureEnv,
  spawnHelperBinWithEnvelope,
  stubExecutable,
} from './test-utils.mts';

const ISSUE = 4372;
const PREFIX = `issue/${ISSUE}-`;
const TITLE = 'feat(claim): add a read-only helper';
const BRANCH = computeBranchName(ISSUE, TITLE);
const OWNER = 'kurone-kito';
const REPO = 'idd-skill';
const SLUG = `${OWNER}/${REPO}`;
const CHECK_IDS = [
  'a5a-approval',
  'a5b-assignee',
  'a5c-claim-state',
  'a5d-open-pr',
  'a5e-branch-collision',
];

const ok = (stdout: string): CommandResult => ({
  status: 0,
  stdout,
  stderr: '',
});
const failed = (status: number | null = 1): CommandResult => ({
  status,
  stdout: '',
  stderr: 'boom',
});

const ISSUE_VIEW = ok(JSON.stringify({ title: TITLE, assignees: [] }));
const CHECK_AUTHOR = {
  id: 'author_self_authorized',
  name: 'Issue author self-authorized',
  result: 'pass',
};
const VALID_CHECK = {
  id: 'gate_enabled',
  name: 'Issue-author gate enabled',
  result: 'pass',
};
const APPROVED = ok(
  JSON.stringify({
    issue: { number: ISSUE },
    approved: true,
    reason: 'author-self-authorized',
    gateEnabled: true,
    policy: {
      skipIssueAuthorApprovalGate: false,
      maintainerApprovalActorPolicy: 'owners-and-maintainers-only',
      approvalSignals: {
        readyLabelName: 'idd:ready',
        labelFreshnessMode: 'presence-only',
      },
    },
    checks: [
      VALID_CHECK,
      {
        id: 'author_self_authorized',
        name: 'Issue author self-authorized',
        result: 'pass',
      },
    ],
  }),
);

const APPROVED_POLICY = (
  JSON.parse(APPROVED.stdout) as { policy: Record<string, unknown> }
).policy;

function approvalOutput(overrides: Record<string, unknown>): CommandResult {
  const base = JSON.parse(APPROVED.stdout) as Record<string, unknown>;
  return ok(JSON.stringify({ ...base, ...overrides }));
}

function routingOutput(
  verdict: string,
  options: {
    reason?: unknown;
    winning?: string | null | 'absent';
    state?: string;
    action?: unknown;
  } = {},
): CommandResult {
  const gate: Record<string, unknown> = { verdict };
  if (options.winning !== 'absent') {
    gate.winning_claim_id = options.winning ?? null;
  }
  const state =
    options.state ??
    (verdict === 'claimable'
      ? 'unclaimed'
      : verdict === 'stale-reclaimable'
        ? 'stale'
        : 'non_inheritable');
  const action =
    state === 'unclaimed'
      ? 're_claim'
      : state === 'stale'
        ? 'takeover'
        : 'stop';
  return ok(
    JSON.stringify({
      issue: { number: ISSUE },
      state,
      action: 'action' in options ? options.action : action,
      reason: 'reason' in options ? options.reason : 'no-active-claim',
      fresh_claim_gate: gate,
    }),
  );
}

const CLAIMABLE = routingOutput('claimable');
/** One matching-refs page as `gh api --paginate --jq tojson` prints it. */
const pageOf = (...branches: string[]): string =>
  JSON.stringify(branches.map((branch) => ({ ref: `refs/heads/${branch}` })));
const refPage = (...branches: string[]): CommandResult =>
  ok(pageOf(...branches));
const NO_REFS = ok('[]');
const LOCAL_ABSENT: LocalWorktreeInspection = {
  status: 'absent',
  paths: [],
  reason: null,
};

interface Scenario {
  resolveRepository?: () => { owner: string; repo: string };
  issueView?: CommandResult;
  approval?: CommandResult | Error;
  routing?: CommandResult | Error;
  refs?: CommandResult | Error;
  fixture?: FakeProviderFixture;
  /** Port methods that throw instead of answering. */
  portThrows?: readonly string[];
  inspectLocalWorktrees?: (issueNumber: number) => LocalWorktreeInspection;
}

interface RunRecord {
  calls: string[][];
  portCalls: string[];
  fixture: FakeProviderFixture;
  deps: ClaimIssueDeps;
}

/** Every command a run may attempt. Anything else could write. */
function isReadOnlyCall(call: readonly string[]): boolean {
  const [file, ...args] = call;
  if (file === 'gh') {
    if (args[0] === 'issue') {
      return (
        args.length === 5 &&
        args[1] === 'view' &&
        args[2] === String(ISSUE) &&
        args[3] === '--json' &&
        args[4] === 'title,assignees'
      );
    }
    if (args[0] === 'api') {
      const writeFlags = ['--method', '-X', '-f', '-F', '--field', '--input'];
      return (
        args[1] === `repos/${SLUG}/git/matching-refs/heads/${PREFIX}` &&
        !args.some(
          (arg) => writeFlags.includes(arg) || arg.startsWith('--method='),
        )
      );
    }
    return false;
  }
  if (file === process.execPath) {
    const script = basename(args[0] ?? '');
    if (script === 'claim-approval-gate.mjs') {
      return args.slice(1).join(' ') === `--issue ${ISSUE}`;
    }
    if (script === 'resume-claim-routing.mjs') {
      return args.slice(1).join(' ') === `--issue ${ISSUE} --fresh-claim-gate`;
    }
  }
  return false;
}

const READ_ONLY_PORT_METHODS = new Set([
  'resolveRepositoryLocator',
  'getConnectedPullRequestEventsPage',
  'getWorkItemClosingPullRequestsPage',
  'listOpenChangeRequests',
]);

function assertReadOnly(record: RunRecord): void {
  for (const call of record.calls) {
    assert.ok(
      isReadOnlyCall(call),
      `a command outside the read-only allowlist: ${call.join(' ')}`,
    );
  }
  for (const method of record.portCalls) {
    assert.ok(
      READ_ONLY_PORT_METHODS.has(method),
      `a provider port call outside the read-only allowlist: ${method}`,
    );
  }
  assert.deepEqual(record.fixture.postedComments ?? [], []);
  assert.deepEqual(record.fixture.closedWorkItems ?? [], []);
}

function makeRun(scenario: Scenario = {}): RunRecord {
  const calls: string[][] = [];
  const portCalls: string[] = [];
  const fixture: FakeProviderFixture = {
    locator: { provider: 'github', owner: OWNER, name: REPO },
    ...scenario.fixture,
  };
  const answer = (
    value: CommandResult | Error | undefined,
    fallback: CommandResult,
  ): CommandResult => {
    if (value instanceof Error) {
      throw value;
    }
    return value ?? fallback;
  };
  const deps: ClaimIssueDeps = {
    run: (file, args) => {
      calls.push([file, ...args]);
      if (file === 'gh' && args[0] === 'issue') {
        return scenario.issueView ?? ISSUE_VIEW;
      }
      if (file === 'gh' && args[0] === 'api') {
        return answer(scenario.refs, NO_REFS);
      }
      const script = basename(args[0] ?? '');
      if (file === process.execPath && script === 'claim-approval-gate.mjs') {
        return answer(scenario.approval, APPROVED);
      }
      if (file === process.execPath && script === 'resume-claim-routing.mjs') {
        return answer(scenario.routing, CLAIMABLE);
      }
      throw new Error(`unexpected command: ${[file, ...args].join(' ')}`);
    },
    resolveRepository:
      scenario.resolveRepository ?? (() => ({ owner: OWNER, repo: REPO })),
    createPort: (owner, repo) => {
      assert.equal(`${owner}/${repo}`, SLUG);
      const inner = createFakeProviderAdapter(fixture);
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') {
            return value;
          }
          return (...args: unknown[]) => {
            portCalls.push(String(property));
            if (scenario.portThrows?.includes(String(property))) {
              throw new Error(`${String(property)} failed`);
            }
            return value.apply(target, args);
          };
        },
      }) as ProviderPort;
    },
    inspectLocalWorktrees:
      scenario.inspectLocalWorktrees ?? (() => LOCAL_ABSENT),
    childScript: (name) => join('/bundle/scripts', name),
  };
  return { calls, portCalls, fixture, deps };
}

function reportOf(record: RunRecord): ClaimIssueReport {
  const outcome = runClaimPrechecks(ISSUE, record.deps);
  assert.equal(outcome.kind, 'report');
  assertReadOnly(record);
  return (outcome as { kind: 'report'; report: ClaimIssueReport }).report;
}

function run(scenario: Scenario = {}): {
  report: ClaimIssueReport;
  record: RunRecord;
} {
  const record = makeRun(scenario);
  return { report: reportOf(record), record };
}

/** Assert the first failing step and that every later step is `not-run`. */
function assertStoppedAt(
  report: ClaimIssueReport,
  stepId: string,
  reason: ClaimStopReason,
): void {
  assert.equal(report.eligible, false);
  assert.equal(report.reason, reason);
  assert.equal(report.projectStatusChecked, false);
  assert.deepEqual(
    report.steps.map((step) => step.id),
    CHECK_IDS,
  );
  const index = CHECK_IDS.indexOf(stepId);
  report.steps.forEach((step, position) => {
    if (position < index) {
      assert.equal(step.status, 'passed', `${step.id} passes before the stop`);
    } else if (position === index) {
      assert.equal(step.status, 'failed');
      assert.equal(step.reason, reason);
      assert.equal(typeof step.nextAction, 'string');
    } else {
      assert.deepEqual(
        {
          status: step.status,
          reason: step.reason,
          nextAction: step.nextAction,
        },
        { status: 'not-run', reason: null, nextAction: null },
        `${step.id} must be not-run`,
      );
    }
  });
}

function assertEligible(report: ClaimIssueReport): void {
  assert.equal(report.eligible, true);
  assert.equal(report.reason, null);
  assert.equal(report.branch, BRANCH);
  assert.equal(report.projectStatusChecked, false);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['passed', 'passed', 'passed', 'passed', 'passed'],
  );
}

function openPr(number: number, body: string) {
  return { number, title: `pull request ${number}`, body, url: `u${number}` };
}

function closingNode(number: number, state: string, repository = SLUG) {
  return { number, state, repository };
}

// A5(a)

test('A5(a): a failed approval helper is approval-unproven and later checks are not-run', () => {
  for (const approval of [failed(1), failed(null)]) {
    const { report, record } = run({ approval });
    assertStoppedAt(report, 'a5a-approval', 'approval-unproven');
    assert.equal(record.calls.length, 2);
  }
});

test('A5(a): invalid or incomplete approval JSON is approval-unproven', () => {
  const broken: CommandResult[] = [
    ok('not json'),
    ok('[]'),
    approvalOutput({ approved: 'yes' }),
    approvalOutput({ reason: undefined }),
    approvalOutput({ gateEnabled: undefined }),
    approvalOutput({ policy: {} }),
    approvalOutput({ policy: { maintainerApprovalActorPolicy: 'x' } }),
    approvalOutput({
      policy: { maintainerApprovalActorPolicy: 'x', approvalSignals: {} },
    }),
    approvalOutput({
      policy: {
        maintainerApprovalActorPolicy: 'x',
        approvalSignals: { readyLabelName: 'idd:ready' },
      },
    }),
    approvalOutput({
      policy: {
        maintainerApprovalActorPolicy: 'x',
        approvalSignals: { readyLabelName: 7, labelFreshnessMode: 'x' },
      },
    }),
    approvalOutput({ checks: undefined }),
    approvalOutput({ checks: [] }),
    approvalOutput({ checks: [null] }),
    approvalOutput({ checks: [{}] }),
    approvalOutput({ checks: [{ id: 'gate_enabled', result: 'pass' }] }),
    approvalOutput({ checks: [{ id: 'gate_enabled', name: 'n', result: 1 }] }),
    approvalOutput({ checks: [{ id: '', name: 'n', result: 'pass' }] }),
    approvalOutput({ issue: undefined }),
    approvalOutput({ issue: { number: ISSUE + 1 } }),
    approvalOutput({ issue: { number: String(ISSUE) } }),
    approvalOutput({ reason: '' }),
    approvalOutput({ reason: '  ' }),
    approvalOutput({ reason: 'approval-missing' }),
    approvalOutput({ reason: 'something-else' }),
    approvalOutput({ approved: false, reason: 'author-self-authorized' }),
    // gateEnabled and the gate_enabled check must agree with the reason.
    approvalOutput({ reason: 'gate-disabled' }),
    approvalOutput({ gateEnabled: false }),
    approvalOutput({
      reason: 'gate-disabled',
      gateEnabled: false,
      checks: [VALID_CHECK],
    }),
    approvalOutput({
      reason: 'gate-disabled',
      gateEnabled: false,
      checks: [{ ...VALID_CHECK, result: 'pass' }],
    }),
    approvalOutput({
      checks: [{ ...CHECK_AUTHOR, id: 'other' }],
    }),
    approvalOutput({
      approved: false,
      reason: 'approval-missing',
      gateEnabled: false,
    }),
    // policy.skipIssueAuthorApprovalGate must be the opposite of gateEnabled.
    approvalOutput({
      policy: { ...APPROVED_POLICY, skipIssueAuthorApprovalGate: true },
    }),
    approvalOutput({
      policy: { ...APPROVED_POLICY, skipIssueAuthorApprovalGate: undefined },
    }),
    approvalOutput({
      policy: { ...APPROVED_POLICY, skipIssueAuthorApprovalGate: 'false' },
    }),
    // The check behind the approved reason must be present and pass.
    approvalOutput({ checks: [VALID_CHECK] }),
    approvalOutput({
      checks: [VALID_CHECK, { ...CHECK_AUTHOR, result: 'fail' }],
    }),
    approvalOutput({ reason: 'ready-label-present' }),
    approvalOutput({ reason: 'ready-comment-fresh' }),
    approvalOutput({ approved: false, reason: 'gate-disabled' }),
    approvalOutput({
      policy: {
        maintainerApprovalActorPolicy: 'x',
        approvalSignals: { readyLabelName: ' ', labelFreshnessMode: 'x' },
      },
    }),
    approvalOutput({ checks: [VALID_CHECK, null] }),
    approvalOutput({ checks: [VALID_CHECK, { id: 'x' }] }),
    approvalOutput({ checks: [{ ...VALID_CHECK, result: 'x' }] }),
    approvalOutput({ checks: [{ ...VALID_CHECK, result: '' }] }),
    approvalOutput({ checks: [{ ...VALID_CHECK, name: ' ' }] }),
    approvalOutput({
      policy: {
        maintainerApprovalActorPolicy: ' ',
        approvalSignals: {
          readyLabelName: 'idd:ready',
          labelFreshnessMode: 'presence-only',
        },
      },
    }),
    approvalOutput({
      policy: {
        maintainerApprovalActorPolicy: 'x',
        approvalSignals: {
          readyLabelName: 'idd:ready',
          labelFreshnessMode: '',
        },
      },
    }),
  ];
  for (const approval of broken) {
    const { report } = run({ approval });
    assertStoppedAt(report, 'a5a-approval', 'approval-unproven');
  }
});

test('A5(a): a throw from the approval call is approval-unproven, still a report', () => {
  const { report } = run({ approval: new Error('spawn failed') });
  assertStoppedAt(report, 'a5a-approval', 'approval-unproven');
});

test('A5(a): a result of not approved is approval-missing', () => {
  const { report } = run({
    approval: approvalOutput({ approved: false, reason: 'approval-missing' }),
  });
  assertStoppedAt(report, 'a5a-approval', 'approval-missing');
});

// A5(b)

test('A5(b): an assignee stops the claim', () => {
  const { report, record } = run({
    issueView: ok(
      JSON.stringify({ title: TITLE, assignees: [{ login: 'someone' }] }),
    ),
  });
  assertStoppedAt(report, 'a5b-assignee', 'assigned');
  assert.match(report.steps[1]?.detail ?? '', /someone/);
  assert.equal(record.calls.length, 2);
});

test('a successful run is eligible, holds the branch, and has projectStatusChecked false', () => {
  const { report, record } = run();
  assertEligible(report);
  assert.equal(report.branch, 'issue/4372-feat-claim-add-read-only-helper');
  assert.equal('gateReason' in report, false);
  assert.equal('winningClaimId' in report, false);
  assert.deepEqual(
    record.calls.map((call) =>
      call[0] === 'gh' ? `gh ${call[1]}` : basename(call[1] ?? ''),
    ),
    [
      'gh issue',
      'claim-approval-gate.mjs',
      'resume-claim-routing.mjs',
      'gh api',
    ],
  );
});

// A5(c)

test('A5(c): already-claimed with a null winning claim id keeps both report fields', () => {
  const { report } = run({
    routing: routingOutput('already-claimed', {
      reason: 'active-claim-non-stale',
      winning: null,
    }),
  });
  assertStoppedAt(report, 'a5c-claim-state', 'already-claimed');
  assert.equal(report.gateReason, 'active-claim-non-stale');
  assert.equal(Object.hasOwn(report, 'winningClaimId'), true);
  assert.equal(report.winningClaimId, null);
});

test('A5(c): already-claimed carries the winning claim id and the gate reason', () => {
  const { report } = run({
    routing: routingOutput('already-claimed', {
      reason: 'released-claim-local-worktree-occupied',
      winning: 'claim-1',
    }),
  });
  assertStoppedAt(report, 'a5c-claim-state', 'already-claimed');
  assert.equal(report.gateReason, 'released-claim-local-worktree-occupied');
  assert.equal(report.winningClaimId, 'claim-1');
});

test('A5(c): stale-reclaimable stops because takeover is out of scope', () => {
  const { report } = run({ routing: routingOutput('stale-reclaimable') });
  assertStoppedAt(report, 'a5c-claim-state', 'stale-takeover-out-of-scope');
});

test('A5(c): a failed, malformed, or unknown fresh-claim result is precheck-unavailable', () => {
  const broken: (CommandResult | Error)[] = [
    failed(1),
    failed(null),
    ok('not json'),
    ok(JSON.stringify({ reason: 'x' })),
    ok(JSON.stringify({ fresh_claim_gate: { verdict: 'claimable' } })),
    routingOutput('claimable', { reason: undefined }),
    routingOutput('claimable', { reason: '' }),
    routingOutput('claimable', { winning: 'absent' }),
    routingOutput('stale-reclaimable', { reason: undefined }),
    routingOutput('stale-reclaimable', { winning: 'absent' }),
    routingOutput('claimable', { state: 'stale' }),
    routingOutput('claimable', { state: 'non_inheritable' }),
    routingOutput('stale-reclaimable', { state: 'unclaimed' }),
    routingOutput('stale-reclaimable', { action: 're_claim' }),
    routingOutput('stale-reclaimable', { action: undefined }),
    routingOutput('already-claimed', { action: 're_claim' }),
    routingOutput('already-claimed', { action: 'keep' }),
    routingOutput('already-claimed', { action: undefined }),
    routingOutput('already-claimed', { state: 'disputed', action: 'takeover' }),
    routingOutput('claimable', { winning: 'claim-1' }),
    routingOutput('claimable', { action: 'stop' }),
    routingOutput('claimable', { action: undefined }),
    routingOutput('claimable', { winning: '' }),
    routingOutput('claimable', { reason: '  ' }),
    routingOutput('already-claimed', { winning: '' }),
    routingOutput('already-claimed', { state: 'unclaimed' }),
    routingOutput('already-claimed', { state: 'stale' }),
    routingOutput('already-claimed', { state: 'bogus' }),
    ok(
      JSON.stringify({
        ...JSON.parse(CLAIMABLE.stdout),
        issue: { number: ISSUE + 1 },
      }),
    ),
    ok(JSON.stringify({ ...JSON.parse(CLAIMABLE.stdout), issue: undefined })),
    routingOutput('something-else'),
    routingOutput('already-claimed', { reason: undefined, winning: null }),
    routingOutput('already-claimed', { reason: '', winning: null }),
    routingOutput('already-claimed', { reason: 'x', winning: 'absent' }),
    ok(
      JSON.stringify({
        reason: 'x',
        fresh_claim_gate: { verdict: 'already-claimed', winning_claim_id: 7 },
      }),
    ),
    new Error('spawn failed'),
  ];
  for (const routing of broken) {
    const { report } = run({ routing });
    assertStoppedAt(report, 'a5c-claim-state', 'precheck-unavailable');
  }
});

// A5(d)

test('A5(d): a linked open pull request in the closing references stops the claim', () => {
  const { report, record } = run({
    fixture: {
      closingPullRequestPages: {
        [ISSUE]: [
          {
            nodes: [closingNode(77, 'OPEN')],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
    },
  });
  assertStoppedAt(report, 'a5d-open-pr', 'open-pr');
  assert.match(report.steps[3]?.detail ?? '', /#77/);
  // Both signals run: the body scan still reads the paginated open list.
  assert.ok(record.portCalls.includes('listOpenChangeRequests'));
});

test('A5(d): an open pull request connected to the issue stops the claim', () => {
  const { report } = run({
    fixture: {
      connectedPrEventPages: {
        [ISSUE]: [
          {
            events: [
              {
                __typename: 'ConnectedEvent',
                subject: {
                  __typename: 'PullRequest',
                  number: 88,
                  state: 'OPEN',
                },
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
    },
  });
  assertStoppedAt(report, 'a5d-open-pr', 'open-pr');
  assert.match(report.steps[3]?.detail ?? '', /#88/);
});

test('A5(d): a closing keyword in a body counts, in any case, with the colon form', () => {
  const bodies = [
    `Closes #${ISSUE}`,
    `closes #${ISSUE}`,
    `CLOSES: #${ISSUE}`,
    `Fixes #${ISSUE}`,
    `resolved ${SLUG}#${ISSUE}`,
    `Closes ${SLUG.toUpperCase()}#${ISSUE}`,
    `Summary\n\nCloses #${ISSUE}\n`,
  ];
  for (const body of bodies) {
    const { report, record } = run({
      fixture: { openChangeRequests: [openPr(55, body)] },
    });
    assertStoppedAt(report, 'a5d-open-pr', 'open-pr');
    assert.match(report.steps[3]?.detail ?? '', /#55/, body);
    assert.ok(record.portCalls.includes('listOpenChangeRequests'));
  }
});

test('A5(d): a mention, a Refs line, a quote, code, another issue or repository is not a reference', () => {
  const bodies = [
    `Closes #${ISSUE}1`,
    `See #${ISSUE} for context`,
    `Refs #${ISSUE}`,
    `> Closes #${ISSUE}`,
    `Use \`Closes #${ISSUE}\` to link`,
    `\`\`\`\nCloses #${ISSUE}\n\`\`\``,
    `Closes other/repo#${ISSUE}`,
    `Closes #9${ISSUE}`,
  ];
  for (const body of bodies) {
    const { report, record } = run({
      fixture: { openChangeRequests: [openPr(55, body)] },
    });
    assertEligible(report);
    assert.ok(record.portCalls.includes('listOpenChangeRequests'));
  }
});

test('A5(d): a merged or closed closing reference is not a reference', () => {
  const { report } = run({
    fixture: {
      closingPullRequestPages: {
        [ISSUE]: [
          {
            nodes: [
              closingNode(801, 'MERGED'),
              closingNode(802, 'CLOSED'),
              closingNode(803, 'OPEN', 'other/repo'),
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
    },
  });
  assertEligible(report);
});

test('A5(d): the open pull request list is read through the port and a lookup that fails and finds nothing is unavailable', () => {
  const cases: Scenario[] = [
    { portThrows: ['listOpenChangeRequests'] },
    {
      fixture: { closingPullRequestPageErrors: { [ISSUE]: 'closing failed' } },
    },
    {
      fixture: { connectedPrEventPageErrors: { [ISSUE]: 'connected failed' } },
    },
    { portThrows: ['getWorkItemClosingPullRequestsPage'] },
  ];
  for (const scenario of cases) {
    const { report, record } = run(scenario);
    assertStoppedAt(report, 'a5d-open-pr', 'precheck-unavailable');
    assert.ok(record.portCalls.includes('listOpenChangeRequests'));
  }
});

test('A5(d): a failed lookup that still found a pull request is open-pr', () => {
  const found: Scenario[] = [
    {
      portThrows: ['listOpenChangeRequests'],
      fixture: {
        closingPullRequestPages: {
          [ISSUE]: [
            {
              nodes: [closingNode(77, 'OPEN')],
              hasNextPage: false,
              endCursor: null,
            },
          ],
        },
      },
    },
    {
      fixture: {
        closingPullRequestPageErrors: { [ISSUE]: 'closing failed' },
        openChangeRequests: [openPr(55, `Closes #${ISSUE}`)],
      },
    },
    {
      fixture: {
        connectedPrEventPageErrors: { [ISSUE]: 'connected failed' },
        openChangeRequests: [openPr(55, `Closes #${ISSUE}`)],
      },
    },
  ];
  for (const scenario of found) {
    const { report } = run(scenario);
    assertStoppedAt(report, 'a5d-open-pr', 'open-pr');
  }
});

test('A5(d): a closing signal that fails keeps a connected pull request it already found', () => {
  const { report } = run({
    fixture: {
      closingPullRequestPageErrors: { [ISSUE]: 'closing failed' },
      connectedPrEventPages: {
        [ISSUE]: [
          {
            events: [
              {
                __typename: 'ConnectedEvent',
                subject: {
                  __typename: 'PullRequest',
                  number: 88,
                  state: 'OPEN',
                },
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
    },
  });
  assertStoppedAt(report, 'a5d-open-pr', 'open-pr');
  assert.match(report.steps[3]?.detail ?? '', /#88/);
});

// A5(e)

function withRepository<T>(body: (primary: string, parent: string) => T): T {
  const parent = realpathSync(mkdtempSync(`${tmpdir()}/idd-claim-issue-`));
  const primary = join(parent, 'primary');
  mkdirSync(primary);
  const env = fixtureEnv();
  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  };
  try {
    git(primary, ['init', '--quiet', '-b', 'main']);
    git(primary, ['config', 'user.email', 'test@example.com']);
    git(primary, ['config', 'user.name', 'Test']);
    writeFileSync(join(primary, 'seed.txt'), 'seed\n');
    git(primary, ['add', 'seed.txt']);
    git(primary, ['commit', '--quiet', '-m', 'seed']);
    return body(primary, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function addWorktree(
  primary: string,
  parent: string,
  directory: string,
  extra: string[],
): string {
  const path = join(parent, directory);
  execFileSync(
    'git',
    [
      'worktree',
      'add',
      '--quiet',
      ...extra.map((arg) => (arg === '<path>' ? path : arg)),
    ],
    {
      cwd: primary,
      env: fixtureEnv(),
      stdio: 'pipe',
    },
  );
  return path;
}

test('A5(e): a local worktree on issue/<n>-other-slug is local-worktree-occupied', () => {
  withRepository((primary, parent) => {
    const other = addWorktree(primary, parent, 'other', [
      '-b',
      `${PREFIX}other-slug`,
      '<path>',
    ]);
    const { report, record } = run({
      inspectLocalWorktrees: (n) =>
        inspectLocalWorktreeBranchPrefix(n, primary),
    });
    assertStoppedAt(report, 'a5e-branch-collision', 'local-worktree-occupied');
    assert.match(report.steps[4]?.detail ?? '', new RegExp(basename(other)));
    // The remote scan never ran after a local stop.
    assert.equal(
      record.calls.some((call) => call[1] === 'api'),
      false,
    );
  });
});

test('A5(e): issue/<n>1-other-slug, a plain detached worktree, and other branches are not a collision', () => {
  withRepository((primary, parent) => {
    addWorktree(primary, parent, 'longer', [
      '-b',
      `issue/${ISSUE}1-other-slug`,
      '<path>',
    ]);
    addWorktree(primary, parent, 'pin', ['--detach', '<path>']);
    addWorktree(primary, parent, 'feature', ['-b', 'feature/x', '<path>']);
    const { report } = run({
      inspectLocalWorktrees: (n) =>
        inspectLocalWorktreeBranchPrefix(n, primary),
    });
    assertEligible(report);
  });
});

test('A5(e): a failed worktree listing or an unreadable record is local-worktree-unreadable', () => {
  const outside = mkdtempSync(`${tmpdir()}/idd-claim-issue-outside-`);
  try {
    const failedListing = run({
      inspectLocalWorktrees: (n) =>
        inspectLocalWorktreeBranchPrefix(n, outside),
    });
    assertStoppedAt(
      failedListing.report,
      'a5e-branch-collision',
      'local-worktree-unreadable',
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const missing = join(tmpdir(), `idd-claim-issue-missing-${process.pid}`);
  const unknown = run({
    inspectLocalWorktrees: (n) =>
      inspectLocalWorktreeBranchPrefix(
        n,
        process.cwd(),
        process.env,
        ((_file: string, _args: string[]) =>
          `worktree ${missing}\0HEAD abc\0detached\0prunable gitdir file\0\0`) as typeof execFileSync,
      ),
  });
  assertStoppedAt(
    unknown.report,
    'a5e-branch-collision',
    'local-worktree-unreadable',
  );
  const thrown = run({
    inspectLocalWorktrees: () => {
      throw new Error('inspector crashed');
    },
  });
  assertStoppedAt(
    thrown.report,
    'a5e-branch-collision',
    'local-worktree-unreadable',
  );
});

test('A5(e): a remote issue/<n>- branch is branch-collision naming the ref, and the hold note is not posted', () => {
  const { report, record } = run({
    refs: refPage(`${PREFIX}other-slug`),
  });
  assertStoppedAt(report, 'a5e-branch-collision', 'branch-collision');
  assert.match(
    report.steps[4]?.detail ?? '',
    new RegExp(`${PREFIX}other-slug`),
  );
  assert.deepEqual(record.fixture.postedComments, []);
  const scan = record.calls.find((call) => call[1] === 'api');
  assert.deepEqual(scan?.slice(0, 3), [
    'gh',
    'api',
    `repos/${SLUG}/git/matching-refs/heads/${PREFIX}`,
  ]);
  // Without --paginate the scan would silently cap at one page of refs.
  assert.ok(scan?.includes('--paginate'));
  assert.equal(scan?.[scan.indexOf('--jq') + 1], 'tojson');
});

test('A5(e): a remote issue/<n>1- branch does not count', () => {
  const { report } = run({
    refs: refPage(`issue/${ISSUE}1-other-slug`, 'feature/x'),
  });
  assertEligible(report);
});

test('A5(e): a failed remote scan is precheck-unavailable', () => {
  for (const refs of [failed(1), failed(null), new Error('spawn failed')]) {
    const { report } = run({ refs });
    assertStoppedAt(report, 'a5e-branch-collision', 'precheck-unavailable');
  }
});

test('A5(e): a malformed matching-refs response is precheck-unavailable, not a clean scan', () => {
  const malformed: CommandResult[] = [
    ok(''),
    ok('   \n'),
    ok('{}'),
    ok('not json'),
    ok('null'),
    ok('[{"ref":7}]'),
    ok('[{"name":"x"}]'),
    ok('["refs/heads/x"]'),
    ok('[{"ref":"heads/issue/4372-x"}]'),
    ok('[{"ref":"refs/heads/"}]'),
    ok(`${pageOf()}\nnot json`),
    ok(`${pageOf()}\n{}`),
  ];
  for (const refs of malformed) {
    const { report } = run({ refs });
    assertStoppedAt(report, 'a5e-branch-collision', 'precheck-unavailable');
  }
});

test('A5(e): every page of a paginated response is read', () => {
  const { report } = run({
    refs: ok(`${pageOf()}\n${pageOf(`${PREFIX}second-page`)}`),
  });
  assertStoppedAt(report, 'a5e-branch-collision', 'branch-collision');
  assert.match(
    report.steps[4]?.detail ?? '',
    new RegExp(`${PREFIX}second-page`),
  );
});

test('A5(d): a malformed open pull request row is precheck-unavailable, not a clean scan', () => {
  const valid = openPr(55, 'No closing reference here');
  const rows: unknown[] = [
    { ...valid, number: Number.NaN },
    { ...valid, number: 0 },
    { ...valid, number: -3 },
    { ...valid, number: 1.5 },
    { ...valid, number: '55' },
    { ...valid, body: undefined },
    { ...valid, body: null },
    { ...valid, title: 7 },
    { ...valid, url: undefined },
    null,
    'row',
  ];
  for (const row of rows) {
    const { report } = run({
      fixture: {
        openChangeRequests: [
          valid,
          row,
        ] as unknown as FakeProviderFixture['openChangeRequests'],
      },
    });
    assertStoppedAt(report, 'a5d-open-pr', 'precheck-unavailable');
  }
});

test('A5(d): a valid row with an empty body passes', () => {
  const { report } = run({
    fixture: { openChangeRequests: [openPr(55, '')] },
  });
  assertEligible(report);
});

// Failures before any check

test('a failed read of the title and assignees is a transport outcome before any check', () => {
  const broken: CommandResult[] = [
    failed(1),
    failed(null),
    ok('not json'),
    ok(JSON.stringify({ title: TITLE })),
    ok(JSON.stringify({ title: 7, assignees: [] })),
    ok(JSON.stringify({ title: TITLE, assignees: [{ name: 'x' }] })),
    ok(JSON.stringify({ title: TITLE, assignees: 'none' })),
    ok(JSON.stringify({ title: '  ', assignees: [] })),
    ok(JSON.stringify({ title: TITLE, assignees: [{ login: '' }] })),
  ];
  for (const issueView of broken) {
    const record = makeRun({ issueView });
    const outcome = runClaimPrechecks(ISSUE, record.deps);
    assert.equal(outcome.kind, 'transport');
    assert.deepEqual(
      record.calls.map((call) => call.slice(0, 2)),
      [['gh', 'issue']],
    );
    assertReadOnly(record);
  }
});

test('a failed repository resolution is a transport outcome and runs nothing', () => {
  const record = makeRun({
    resolveRepository: () => {
      throw new Error('gh repo view failed');
    },
  });
  const outcome = runClaimPrechecks(ISSUE, record.deps);
  assert.equal(outcome.kind, 'transport');
  assert.deepEqual(record.calls, []);
});

test('a throw inside a later check is precheck-unavailable, still a report', () => {
  const { report } = run({ routing: new Error('spawn failed') });
  assertStoppedAt(report, 'a5c-claim-state', 'precheck-unavailable');
});

// The command

function runCommand(
  argv: string[],
  scenario: Scenario = {},
): {
  result: HelperCliResult;
  stdout: string;
  stderr: string;
  record: RunRecord;
} {
  const record = makeRun(scenario);
  let stdout = '';
  let stderr = '';
  const result = runClaimIssue(argv, record.deps, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assertReadOnly(record);
  return { result, stdout, stderr, record };
}

test('--apply is a usage error with nothing on stdout and no command run', () => {
  for (const argv of [
    ['--issue', String(ISSUE), '--apply'],
    ['--apply', '--issue', String(ISSUE)],
  ]) {
    const { result, stdout, stderr, record } = runCommand(argv);
    assert.deepEqual(result, {
      exitCode: 2,
      kind: 'usage',
      message: 'unknown argument: --apply',
    });
    assert.equal(stdout, '');
    assert.match(stderr, /unknown argument: --apply/);
    assert.deepEqual(record.calls, []);
  }
});

test('a missing or invalid --issue is a usage error', () => {
  for (const argv of [
    [],
    ['--issue'],
    ['--issue', 'abc'],
    ['--issue', '0'],
    ['--issue', '12x'],
    ['--unknown'],
  ]) {
    const { result, stdout, record } = runCommand(argv);
    assert.equal((result as { exitCode: number }).exitCode, 2);
    assert.equal((result as { kind: string }).kind, 'usage');
    assert.equal(stdout, '');
    assert.deepEqual(record.calls, []);
  }
});

test('--help prints usage, exits 0, and runs nothing', () => {
  const { result, stdout, record } = runCommand(['--help']);
  assert.equal(result, 0);
  assert.match(stdout, /^Usage:/);
  assert.deepEqual(record.calls, []);
});

test('an eligible result exits 0 and prints the report', () => {
  const { result, stdout, stderr } = runCommand(['--issue', String(ISSUE)]);
  assert.equal(result, 0);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout) as ClaimIssueReport;
  assertEligible(report);
});

test('an ineligible result exits 1 as a gate outcome and still prints the report', () => {
  const { result, stdout } = runCommand(['--issue', String(ISSUE)], {
    refs: refPage(`${PREFIX}other-slug`),
  });
  assert.equal((result as { exitCode: number }).exitCode, 1);
  assert.equal((result as { kind: string }).kind, 'gate');
  const report = JSON.parse(stdout) as ClaimIssueReport;
  assertStoppedAt(report, 'a5e-branch-collision', 'branch-collision');
});

test('every failure inside a check exits 1 as a gate outcome', () => {
  const { result, stdout } = runCommand(['--issue', String(ISSUE)], {
    approval: failed(1),
  });
  assert.equal((result as { exitCode: number }).exitCode, 1);
  assert.equal((result as { kind: string }).kind, 'gate');
  assertStoppedAt(
    JSON.parse(stdout) as ClaimIssueReport,
    'a5a-approval',
    'approval-unproven',
  );
});

test('a failure before any check exits 1 as a transport outcome with nothing on stdout', () => {
  const { result, stdout, stderr, record } = runCommand(
    ['--issue', String(ISSUE)],
    { issueView: failed(1) },
  );
  assert.equal((result as { exitCode: number }).exitCode, 1);
  assert.equal((result as { kind: string }).kind, 'transport');
  assert.equal(stdout, '');
  assert.match(stderr, /could not read issue 4372/);
  assert.deepEqual(
    record.calls.map((call) => call.slice(0, 2)),
    [['gh', 'issue']],
  );
});

test('the packaged command reports --apply as a usage envelope with nothing on stdout', () => {
  const result = spawnHelperBinWithEnvelope('idd-claim-issue.mjs', [
    '--issue',
    String(ISSUE),
    '--apply',
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.envelope?.kind, 'usage');
  assert.equal(result.envelope?.exitCode, 2);
});

// Round 1 critique additions

test('A5(d): a closing keyword in a pull request title is not scanned', () => {
  const { report } = run({
    fixture: {
      openChangeRequests: [
        {
          ...openPr(55, 'No closing reference here'),
          title: `Closes #${ISSUE}`,
        },
      ],
    },
  });
  assertEligible(report);
});

test('A5(e): a prunable worktree record on issue/<n>-* is local-worktree-unreadable (real git)', () => {
  withRepository((primary, parent) => {
    const gone = addWorktree(primary, parent, 'gone', [
      '-b',
      `${PREFIX}gone-slug`,
      '<path>',
    ]);
    rmSync(gone, { recursive: true, force: true });
    const { report } = run({
      inspectLocalWorktrees: (n) =>
        inspectLocalWorktreeBranchPrefix(n, primary),
    });
    assertStoppedAt(
      report,
      'a5e-branch-collision',
      'local-worktree-unreadable',
    );
  });
});

test('A5(e): a local scan result that is not a proven absence fails closed', () => {
  const { report, record } = run({
    inspectLocalWorktrees: () =>
      ({
        status: 'bogus',
        paths: [],
        reason: null,
      }) as unknown as LocalWorktreeInspection,
  });
  assertStoppedAt(report, 'a5e-branch-collision', 'local-worktree-unreadable');
  assert.equal(
    record.calls.some((call) => call[1] === 'api'),
    false,
  );
});

test('the default dependencies point at real sibling scripts', () => {
  const deps = createDefaultDeps();
  for (const name of ['claim-approval-gate.mjs', 'resume-claim-routing.mjs']) {
    assert.ok(existsSync(deps.childScript(name)), `${name} must exist`);
  }
});

test('the default runner reports gh output, a gh failure, and a failed spawn', () => {
  const run = createDefaultRunner();
  const restoreOk = stubExecutable('gh', `process.stdout.write('  out  \\n');`);
  try {
    assert.deepEqual(run('gh', ['issue', 'view', '1']), {
      status: 0,
      stdout: 'out',
      stderr: '',
    });
  } finally {
    restoreOk();
  }
  const restoreFail = stubExecutable(
    'gh',
    `process.stderr.write('gh: HTTP 503\\n'); process.exit(3);`,
  );
  try {
    const failure = run('gh', ['issue', 'view', '1']);
    assert.notEqual(failure.status, 0);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /503/);
  } finally {
    restoreFail();
  }
  const missing = run(process.execPath, [
    join(tmpdir(), `idd-claim-issue-no-such-script-${process.pid}.mjs`),
  ]);
  assert.notEqual(missing.status, 0);
});

// Issue 4372 review: the raw open pull request rows reach the helper through the
// real adapter, which fails the list on a malformed row instead of coercing it.
function portWithRawOpenRows(rawRows: unknown): ProviderPort {
  const deps = {
    ghText: () => {
      throw new Error('unexpected gh call');
    },
    ghApiJson: () => rawRows,
    resolveViewerLogin: () => 'viewer',
    ghTextAsync: async () => {
      throw new Error('unexpected gh call');
    },
  } as unknown as GithubProviderAdapterDeps;
  const real = createGithubProviderAdapter(OWNER, REPO, deps);
  const empty = createFakeProviderAdapter({
    locator: { provider: 'github', owner: OWNER, name: REPO },
  });
  return { ...empty, listOpenChangeRequests: real.listOpenChangeRequests };
}

test('A5(d): raw rows through the real adapter, a malformed one fails the lookup and a null body passes', () => {
  const valid = {
    number: 5,
    title: 't',
    body: 'No closing reference here',
    html_url: 'https://github.com/o/r/pull/5',
  };
  const malformedRows: unknown[] = [
    { number: 7 },
    { ...valid, body: undefined },
    { ...valid, number: '7' },
    { ...valid, number: true },
  ];
  for (const row of malformedRows) {
    const record = makeRun();
    record.deps.createPort = () => portWithRawOpenRows([valid, row]);
    const report = reportOf(record);
    assertStoppedAt(report, 'a5d-open-pr', 'precheck-unavailable');
  }
  const clean = makeRun();
  clean.deps.createPort = () => portWithRawOpenRows([{ ...valid, body: null }]);
  assertEligible(reportOf(clean));
  const closing = makeRun();
  closing.deps.createPort = () =>
    portWithRawOpenRows([{ ...valid, body: `Closes #${ISSUE}` }]);
  assertStoppedAt(reportOf(closing), 'a5d-open-pr', 'open-pr');
});

test('A5(c): the routing states the fresh gate pairs with already-claimed are accepted', () => {
  for (const state of [
    'local_worktree_occupied',
    'non_inheritable',
    'disputed',
  ]) {
    const { report } = run({
      routing: routingOutput('already-claimed', { state, reason: 'r' }),
    });
    assertStoppedAt(report, 'a5c-claim-state', 'already-claimed');
  }
});

test('A5(e): a local absent result with paths or a reason is not a proven absence', () => {
  const shapes: unknown[] = [
    { status: 'absent', paths: ['/x'], reason: null },
    { status: 'absent', paths: [], reason: 'something' },
    { status: 'absent', paths: [], reason: undefined },
    { status: 'absent', paths: undefined, reason: null },
    { status: 'absent', paths: 'none', reason: null },
  ];
  for (const shape of shapes) {
    const { report, record } = run({
      inspectLocalWorktrees: () => shape as LocalWorktreeInspection,
    });
    assertStoppedAt(
      report,
      'a5e-branch-collision',
      'local-worktree-unreadable',
    );
    assert.equal(
      record.calls.some((call) => call[1] === 'api'),
      false,
    );
  }
});

test('A5(e): an occupied local result still stops when its paths are not a list', () => {
  for (const paths of [undefined, 'x', null]) {
    const { report, record } = run({
      inspectLocalWorktrees: () =>
        ({
          status: 'occupied',
          paths,
          reason: 'r',
        }) as unknown as LocalWorktreeInspection,
    });
    assertStoppedAt(report, 'a5e-branch-collision', 'local-worktree-occupied');
    assert.equal(
      record.calls.some((call) => call[1] === 'api'),
      false,
    );
  }
});

test('A5(a): every approved reason the gate emits is accepted with its own check', () => {
  const cases: [string, boolean, string | null][] = [
    ['author-self-authorized', true, 'author_self_authorized'],
    ['ready-label-present', true, 'ready_label_present'],
    ['ready-comment-fresh', true, 'ready_comment_fresh'],
    ['gate-disabled', false, null],
  ];
  for (const [reason, gateEnabled, checkId] of cases) {
    const checks = [
      { ...VALID_CHECK, result: gateEnabled ? 'pass' : 'fail' },
      ...(checkId === null
        ? []
        : [{ id: checkId, name: 'a check', result: 'pass' }]),
    ];
    const { report } = run({
      approval: approvalOutput({
        reason,
        gateEnabled,
        checks,
        policy: {
          ...APPROVED_POLICY,
          skipIssueAuthorApprovalGate: !gateEnabled,
        },
      }),
    });
    assertEligible(report);
  }
});
