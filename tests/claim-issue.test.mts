import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
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
import type { ProviderPort } from '../src/scripts/provider-port.mts';
import { fixtureEnv, spawnHelperBinWithEnvelope } from './test-utils.mts';

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
const APPROVED = ok(
  JSON.stringify({
    approved: true,
    reason: 'author-self-authorized',
    gateEnabled: true,
    policy: {
      maintainerApprovalActorPolicy: 'owners-and-maintainers-only',
      approvalSignals: { readyLabelName: 'idd:ready' },
    },
    checks: [],
  }),
);

function approvalOutput(overrides: Record<string, unknown>): CommandResult {
  const base = JSON.parse(APPROVED.stdout) as Record<string, unknown>;
  return ok(JSON.stringify({ ...base, ...overrides }));
}

function routingOutput(
  verdict: string,
  options: {
    reason?: unknown;
    winning?: string | null | 'absent';
  } = {},
): CommandResult {
  const gate: Record<string, unknown> = { verdict };
  if (options.winning !== 'absent') {
    gate.winning_claim_id = options.winning ?? null;
  }
  return ok(
    JSON.stringify({
      state: 'unclaimed',
      action: 're_claim',
      reason: 'reason' in options ? options.reason : 'no-active-claim',
      fresh_claim_gate: gate,
    }),
  );
}

const CLAIMABLE = routingOutput('claimable');
const NO_REFS = ok('');
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
    approvalOutput({ checks: undefined }),
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
    approval: approvalOutput({ approved: false, reason: 'no-approval' }),
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
    refs: ok(`${PREFIX}other-slug\n`),
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
});

test('A5(e): a remote issue/<n>1- branch does not count', () => {
  const { report } = run({
    refs: ok(`issue/${ISSUE}1-other-slug\nrefs-noise\n`),
  });
  assertEligible(report);
});

test('A5(e): a failed remote scan is precheck-unavailable', () => {
  for (const refs of [failed(1), failed(null), new Error('spawn failed')]) {
    const { report } = run({ refs });
    assertStoppedAt(report, 'a5e-branch-collision', 'precheck-unavailable');
  }
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
    refs: ok(`${PREFIX}other-slug`),
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
