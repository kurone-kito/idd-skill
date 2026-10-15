import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type {
  ClaimedPushDeps,
  ClaimedPushInput,
  ClaimedPushReport,
  ClaimedPushStepId,
  CommandRequest,
  CommandResult,
  GateCommandRead,
} from '../src/scripts/claimed-push.mts';
import {
  parseArgs,
  readEffectiveGateCommand,
  runClaimedPush,
  runCli,
  runProductionCommand,
} from '../src/scripts/claimed-push.mts';

// Every nextAction below is copied from the acceptance table of issue 4375,
// not imported from the helper, so a drifted constant cannot pass by
// agreeing with itself.
const BRANCH = 'issue/4375-feat-push-add-helper';
const NEXT = {
  staleClaim: 'stop and re-read the claim',
  helperInstallation: 'check the helper installation, then rerun',
  stopAndReport: 'stop and report',
  runFromWorktree: 'run the helper from the claimed worktree',
  switchBranch: 'switch the worktree to the claimed branch',
  commitThenRerun: 'stage and commit, then rerun',
  fixThenRerun: 'fix the failure, commit, and rerun',
  configureGate: 'configure the command or run the written gate by hand',
  commitOrDiscard: 'commit or discard what the gate changed, then rerun',
  rerunForHead: 'rerun the helper so the gate sees the new HEAD',
  pushRejected: `read git's message, fetch and inspect origin/${BRANCH}, never force`,
  pushUnknown: 'read the remote branch before any new push, no retry',
  readGitError: 'read the git error in the worktree and fix it, then rerun',
} as const;

const ISSUE = 4375;
const CLAIM_ID = 'claim-id-4375';
const NONCE = 'nonce-4375';
const ROOT = resolve(tmpdir(), 'claimed-push-fake-root');
const PRIMARY = join(ROOT, 'idd-skill');
const WORKTREE = join(ROOT, 'idd-skill.issue-4375-feat-push-add-helper');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const STEP_IDS: ClaimedPushStepId[] = [
  'assert',
  'location',
  'gate',
  'reassert',
  'push',
];

const K = {
  toplevel: 'git rev-parse --show-toplevel',
  assert: 'assert',
  worktrees: 'git worktree list --porcelain -z',
  origin: 'git remote get-url origin',
  current: 'git branch --show-current',
  status: 'git status --porcelain --untracked-files=all',
  head: 'git rev-parse HEAD',
  tip: `git rev-parse --verify refs/heads/${BRANCH}`,
  upstream: `git rev-parse --abbrev-ref --symbolic-full-name ${BRANCH}@{upstream}`,
  pushNew: `git push -u origin ${BRANCH}`,
  pushKnown: `git push origin ${BRANCH}`,
  gate: 'gate',
} as const;

type Responses = CommandResult | CommandResult[];

function result(
  status: number | null,
  stdout = '',
  stderr = '',
  extra: Partial<CommandResult> = {},
): CommandResult {
  return { status, signal: null, stdout, stderr, ...extra };
}

const KILLED = result(null, '', '', { signal: 'SIGKILL' });
const CANNOT_START = result(null, '', '', { error: 'spawn ENOENT' });

function claimJson(branch = BRANCH): string {
  return JSON.stringify({ active_claim: { branch } });
}

function worktreeList(primary = PRIMARY, worktree = WORKTREE): string {
  return [
    `worktree ${primary}`,
    `HEAD ${HEAD}`,
    'branch refs/heads/main',
    '',
    `worktree ${worktree}`,
    `HEAD ${HEAD}`,
    `branch refs/heads/${BRANCH}`,
    '',
    '',
  ].join('\0');
}

function defaultWorld(): Record<string, Responses> {
  return {
    [K.toplevel]: result(0, `${WORKTREE}\n`),
    [K.assert]: result(0, claimJson()),
    [K.worktrees]: result(0, worktreeList()),
    [K.origin]: result(0, 'git@github.com:kurone-kito/idd-skill.git\n'),
    [K.current]: result(0, `${BRANCH}\n`),
    [K.status]: result(0, ''),
    [K.head]: result(0, `${HEAD}\n`),
    [K.tip]: result(0, `${HEAD}\n`),
    [K.gate]: result(0),
    [K.upstream]: result(128, '', 'fatal: no upstream configured'),
    [K.pushNew]: result(0, '', 'To github.com:kurone-kito/idd-skill.git\n'),
    [K.pushKnown]: result(0, '', 'To github.com:kurone-kito/idd-skill.git\n'),
  };
}

function keyOf(request: CommandRequest): string {
  if (request.kind === 'gate') return K.gate;
  if (request.kind === 'helper') return K.assert;
  return `git ${request.args.join(' ')}`;
}

interface Scenario {
  world?: Record<string, Responses>;
  known?: string[];
  gate?: GateCommandRead;
  input?: Partial<ClaimedPushInput>;
}

interface Run {
  report: ClaimedPushReport;
  calls: CommandRequest[];
  count: (key: string) => number;
}

function run(scenario: Scenario = {}): Run {
  const world = { ...defaultWorld(), ...scenario.world };
  const known = new Set(scenario.known ?? [PRIMARY, WORKTREE]);
  const seen = new Map<string, number>();
  const calls: CommandRequest[] = [];
  const deps: ClaimedPushDeps = {
    run: (request) => {
      calls.push(request);
      const key = keyOf(request);
      const entry = world[key];
      assert.ok(entry, `unexpected command: ${key}`);
      const list = Array.isArray(entry) ? entry : [entry];
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      return list[Math.min(index, list.length - 1)] as CommandResult;
    },
    realpath: (path) => (known.has(path) ? path : null),
    readGateCommand: () =>
      scenario.gate ?? { ok: true, command: 'pnpm run check' },
  };
  const input: ClaimedPushInput = {
    issue: ISSUE,
    claimId: CLAIM_ID,
    nonce: NONCE,
    apply: true,
    cwd: WORKTREE,
    ...scenario.input,
  };
  const report = runClaimedPush(input, deps);
  assertReportInvariants(report);
  return {
    report,
    calls,
    count: (key) => calls.filter((call) => keyOf(call) === key).length,
  };
}

function assertReportInvariants(report: ClaimedPushReport): void {
  assert.deepEqual(
    report.steps.map((step) => step.id),
    STEP_IDS,
  );
  for (const step of report.steps) {
    assert.ok(step.reason.length > 0, `${step.id} has a reason`);
    if (step.status === 'failed') {
      assert.ok(
        typeof step.nextAction === 'string' && step.nextAction.length > 0,
        `${step.id} failed without a nextAction`,
      );
    }
  }
  const failedIndex = report.steps.findIndex(
    (step) => step.status === 'failed',
  );
  if (failedIndex >= 0) {
    for (const step of report.steps.slice(0, failedIndex)) {
      assert.equal(step.status, 'passed');
    }
    for (const step of report.steps.slice(failedIndex + 1)) {
      assert.equal(step.status, 'skipped');
    }
  }
}

function assertRefused(
  run_: Run,
  id: ClaimedPushStepId,
  nextAction: string,
  options: { exitStatus?: number | null; pushed?: boolean | null } = {},
): void {
  const step = run_.report.steps.find((candidate) => candidate.id === id);
  assert.equal(step?.status, 'failed');
  assert.equal(step?.nextAction, nextAction);
  if ('exitStatus' in options) {
    assert.equal(step?.exitStatus, options.exitStatus);
  }
  assert.equal(
    run_.report.pushed,
    'pushed' in options ? options.pushed : false,
  );
  assert.equal(run_.report.pushedSha, undefined);
  if (id === 'assert' || id === 'location') {
    assert.equal(run_.count(K.gate), 0, 'the gate must not run');
  }
  if (id !== 'push') {
    noPush(run_);
  }
}

function noPush(run_: Run): void {
  assert.equal(run_.count(K.pushNew), 0);
  assert.equal(run_.count(K.pushKnown), 0);
}

// ---- Acceptance table rows -------------------------------------------------

test('a first assert that exits non-zero refuses before the gate and the push', () => {
  const r = run({
    world: {
      [K.assert]: result(
        1,
        claimJson(),
        'resume-claim-routing --assert: state=disputed\nsecond line',
      ),
    },
  });
  assertRefused(r, 'assert', NEXT.staleClaim, { exitStatus: 1 });
  assert.match(
    r.report.steps[0]?.reason ?? '',
    /exited 1: resume-claim-routing --assert: state=disputed/u,
  );
  assert.doesNotMatch(r.report.steps[0]?.reason ?? '', /second line/u);
  assert.equal(r.count(K.gate), 0);
  assert.equal(r.count(K.worktrees), 0);
  noPush(r);
});

test('an assert that cannot start refuses with the installation next action', () => {
  const r = run({ world: { [K.assert]: CANNOT_START } });
  assertRefused(r, 'assert', NEXT.helperInstallation, { exitStatus: null });
  assert.match(
    r.report.steps[0]?.reason ?? '',
    /could not start: spawn ENOENT/u,
  );
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('an assert killed by a signal refuses as a lost claim', () => {
  const r = run({ world: { [K.assert]: KILLED } });
  assertRefused(r, 'assert', NEXT.staleClaim, { exitStatus: null });
  assert.match(r.report.steps[0]?.reason ?? '', /SIGKILL/u);
  noPush(r);
});

test('an assert that exits 0 without a claimed branch refuses', () => {
  for (const stdout of [
    '',
    'not json',
    '{}',
    '{"active_claim":{"branch":""}}',
  ]) {
    const r = run({ world: { [K.assert]: result(0, stdout) } });
    assertRefused(r, 'assert', NEXT.staleClaim, { exitStatus: 0 });
    noPush(r);
  }
});

test('an unresolvable worktree refuses before the assert', () => {
  const r = run({
    world: { [K.toplevel]: result(128, '', 'fatal: not a git repository') },
  });
  assertRefused(r, 'assert', NEXT.runFromWorktree);
  assert.equal(r.count(K.assert), 0);
  noPush(r);
});

test('a claimed branch outside issue/<n>- refuses before any path is computed', () => {
  for (const branch of ['main', 'issue/4376-other-issue', 'issue/4375']) {
    const r = run({ world: { [K.assert]: result(0, claimJson(branch)) } });
    assertRefused(r, 'location', NEXT.stopAndReport);
    assert.equal(r.count(K.worktrees), 0, branch);
    assert.equal(r.count(K.gate), 0);
    noPush(r);
  }
});

test('a worktree that is not the sibling path of the claimed branch refuses', () => {
  const elsewhere = join(ROOT, 'somewhere-else');
  const r = run({
    world: { [K.toplevel]: result(0, `${elsewhere}\n`) },
    known: [PRIMARY, WORKTREE, elsewhere],
  });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('an expected sibling path that cannot be resolved refuses', () => {
  const r = run({ known: [PRIMARY] });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  assert.match(
    r.report.steps[1]?.reason ?? '',
    /does not exist or cannot be resolved/u,
  );
  noPush(r);
});

test('a worktree path that cannot be resolved refuses', () => {
  const other = join(ROOT, 'unresolvable');
  const r = run({
    world: { [K.toplevel]: result(0, `${other}\n`) },
    known: [PRIMARY, WORKTREE],
  });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  noPush(r);
});

test('a primary checkout that git does not list first refuses', () => {
  const r = run({ world: { [K.worktrees]: result(0, '') } });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  const failed = run({
    world: { [K.worktrees]: result(128, '', 'fatal: nope') },
  });
  assertRefused(failed, 'location', NEXT.runFromWorktree);
});

test('a current branch that differs from the claimed branch refuses', () => {
  const r = run({ world: { [K.current]: result(0, 'issue/4375-another\n') } });
  assertRefused(r, 'location', NEXT.switchBranch);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a detached HEAD refuses', () => {
  const r = run({ world: { [K.current]: result(0, '\n') } });
  assertRefused(r, 'location', NEXT.switchBranch);
  assert.match(r.report.steps[1]?.reason ?? '', /detached/u);
  noPush(r);
  const failed = run({ world: { [K.current]: result(128, '', 'fatal') } });
  assertRefused(failed, 'location', NEXT.switchBranch);
});

test('a dirty working tree refuses before the gate runs', () => {
  const r = run({
    world: { [K.status]: result(0, ' M src/file.mts\n?? new.txt\n') },
  });
  assertRefused(r, 'gate', NEXT.commitThenRerun);
  assert.match(r.report.steps[2]?.reason ?? '', / M src\/file\.mts/u);
  assert.match(r.report.steps[2]?.reason ?? '', /\?\? new\.txt/u);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a status read that fails refuses instead of reading as clean', () => {
  const r = run({
    world: { [K.status]: result(128, '', 'fatal: index.lock exists') },
  });
  assertRefused(r, 'gate', NEXT.readGitError);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a long dirty-tree listing is capped', () => {
  const lines = Array.from(
    { length: 30 },
    (_, index) => ` M file-${index}.txt`,
  );
  const r = run({ world: { [K.status]: result(0, `${lines.join('\n')}\n`) } });
  assertRefused(r, 'gate', NEXT.commitThenRerun);
  const reason = r.report.steps[2]?.reason ?? '';
  assert.match(reason, /file-19\.txt/u);
  assert.doesNotMatch(reason, /file-20\.txt/u);
  assert.match(reason, /and 10 more/u);
});

test('a gate that exits non-zero refuses without a second assert or a push', () => {
  const r = run({ world: { [K.gate]: result(2) } });
  assertRefused(r, 'gate', NEXT.fixThenRerun, { exitStatus: 2 });
  assert.equal(r.count(K.assert), 1);
  noPush(r);
});

test('a gate killed by a signal refuses with no exit status', () => {
  const r = run({ world: { [K.gate]: KILLED } });
  assertRefused(r, 'gate', NEXT.fixThenRerun, { exitStatus: null });
  assert.match(r.report.steps[2]?.reason ?? '', /SIGKILL/u);
  noPush(r);
});

test('a buffer overflow that kills the gate keeps the error text', () => {
  const overflow = result(null, '', '', {
    signal: 'SIGTERM',
    error: 'spawnSync ENOBUFS',
  });
  const r = run({ world: { [K.gate]: overflow } });
  assertRefused(r, 'gate', NEXT.fixThenRerun, { exitStatus: null });
  assert.match(r.report.steps[2]?.reason ?? '', /SIGTERM.*ENOBUFS/u);
});

test('a gate that cannot start refuses with the configure next action', () => {
  const r = run({ world: { [K.gate]: CANNOT_START } });
  assertRefused(r, 'gate', NEXT.configureGate, { exitStatus: null });
  assert.match(
    r.report.steps[2]?.reason ?? '',
    /could not start: spawn ENOENT/u,
  );
  noPush(r);
});

test('a gate command that is not configured is never run', () => {
  const r = run({
    gate: { ok: false, reason: 'commands.pre-push-validate is not configured' },
  });
  assertRefused(r, 'gate', NEXT.configureGate);
  assert.match(r.report.steps[2]?.reason ?? '', /not configured/u);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a working tree the gate dirtied refuses', () => {
  const r = run({
    world: { [K.status]: [result(0, ''), result(0, ' M generated.mjs\n')] },
  });
  assertRefused(r, 'gate', NEXT.commitOrDiscard, { exitStatus: 0 });
  assert.match(r.report.steps[2]?.reason ?? '', /generated\.mjs/u);
  assert.equal(r.count(K.gate), 1);
  noPush(r);
});

test('a second assert that exits non-zero refuses the push', () => {
  const r = run({
    world: {
      [K.assert]: [
        result(0, claimJson()),
        result(1, claimJson(), 'claim lost'),
      ],
    },
  });
  assertRefused(r, 'reassert', NEXT.staleClaim, { exitStatus: 1 });
  assert.equal(r.count(K.gate), 1);
  noPush(r);
});

test('a second assert that cannot start refuses with the installation action', () => {
  const r = run({
    world: { [K.assert]: [result(0, claimJson()), CANNOT_START] },
  });
  assertRefused(r, 'reassert', NEXT.helperInstallation, { exitStatus: null });
  noPush(r);
});

test('a HEAD that moved during the gate refuses the push', () => {
  const r = run({
    world: { [K.head]: [result(0, `${HEAD}\n`), result(0, `${OTHER_HEAD}\n`)] },
  });
  assertRefused(r, 'reassert', NEXT.rerunForHead);
  assert.match(r.report.steps[3]?.reason ?? '', new RegExp(OTHER_HEAD, 'u'));
  noPush(r);
});

test('a branch tip that differs from the gated commit refuses the push', () => {
  const r = run({ world: { [K.tip]: result(0, `${OTHER_HEAD}\n`) } });
  assertRefused(r, 'reassert', NEXT.rerunForHead);
  noPush(r);
});

test('a second assert that names another branch refuses the push', () => {
  const r = run({
    world: {
      [K.assert]: [
        result(0, claimJson()),
        result(0, claimJson('issue/4375-another-branch')),
      ],
    },
  });
  assertRefused(r, 'reassert', NEXT.staleClaim, { exitStatus: 0 });
  noPush(r);
});

test('an origin read that ends without an exit status refuses', () => {
  const r = run({ world: { [K.origin]: KILLED } });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  assert.match(r.report.steps[1]?.reason ?? '', /SIGKILL/u);
});

test('the path check runs before the current-branch check', () => {
  const elsewhere = join(ROOT, 'somewhere-else');
  const r = run({
    world: {
      [K.toplevel]: result(0, `${elsewhere}\n`),
      [K.current]: result(0, 'main\n'),
    },
    known: [PRIMARY, WORKTREE, elsewhere],
  });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  assert.equal(r.count(K.current), 0);
});

test('a HEAD read that fails refuses instead of comparing empty values', () => {
  const r = run({ world: { [K.head]: result(128, '', 'fatal: bad object') } });
  assertRefused(r, 'gate', NEXT.readGitError);
  assert.equal(r.count(K.gate), 0);
  const malformed = run({ world: { [K.head]: result(0, 'not-a-sha\n') } });
  assertRefused(malformed, 'gate', NEXT.readGitError);
  const second = run({
    world: { [K.head]: [result(0, `${HEAD}\n`), result(128, '', 'fatal')] },
  });
  assertRefused(second, 'reassert', NEXT.readGitError);
  noPush(second);
});

test('a branch with no upstream is pushed once with -u and no force flag', () => {
  const r = run();
  assert.equal(r.report.mode, 'apply');
  assert.equal(r.report.pushed, true);
  assert.equal(r.report.pushedSha, HEAD);
  assert.match(r.report.pushMessage ?? '', /To github\.com/u);
  assert.deepEqual(
    r.report.steps.map((step) => step.status),
    ['passed', 'passed', 'passed', 'passed', 'passed'],
  );
  const pushes = r.calls.filter(
    (call) => call.kind === 'git' && call.args[0] === 'push',
  );
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0] && 'args' in pushes[0] ? pushes[0].args : [], [
    'push',
    '-u',
    'origin',
    BRANCH,
  ]);
  assert.equal(r.count(K.assert), 2);
  assert.equal(r.count(K.gate), 1);
  assert.deepEqual(r.calls.map(keyOf), [
    K.toplevel,
    K.assert,
    K.worktrees,
    K.origin,
    K.current,
    K.status,
    K.head,
    K.gate,
    K.status,
    K.assert,
    K.head,
    K.tip,
    K.upstream,
    K.pushNew,
  ]);
});

test('a branch with an upstream is pushed once without -u', () => {
  const r = run({ world: { [K.upstream]: result(0, 'origin/main\n') } });
  assert.equal(r.report.pushed, true);
  assert.equal(r.count(K.pushKnown), 1);
  assert.equal(r.count(K.pushNew), 0);
  const push = r.calls.find(
    (call) => call.kind === 'git' && call.args[0] === 'push',
  );
  assert.deepEqual(push && 'args' in push ? push.args : [], [
    'push',
    'origin',
    BRANCH,
  ]);
});

test('no run ever passes a force flag', () => {
  const worlds: Record<string, Responses>[] = [
    {},
    { [K.upstream]: result(0, 'origin/main\n') },
  ];
  for (const world of worlds) {
    const r = run({ world });
    for (const call of r.calls) {
      if (call.kind === 'git' && call.args[0] === 'push') {
        assert.ok(
          call.args.every((arg) => !/^-f$|force/iu.test(arg)),
          call.args.join(' '),
        );
      }
    }
  }
});

test('a rejected push fails once, is not retried, and reports git message', () => {
  const r = run({
    world: {
      [K.pushNew]: result(
        1,
        '',
        '! [rejected] issue (non-fast-forward)\nerror: failed to push some refs',
      ),
    },
  });
  assertRefused(r, 'push', NEXT.pushRejected, { exitStatus: 1, pushed: false });
  assert.match(r.report.steps[4]?.reason ?? '', /non-fast-forward/u);
  assert.equal(r.count(K.pushNew), 1);
  assert.equal(r.count(K.pushKnown), 0);
});

test('a push killed by a signal leaves the outcome unknown', () => {
  const r = run({ world: { [K.pushNew]: KILLED } });
  assertRefused(r, 'push', NEXT.pushUnknown, {
    exitStatus: null,
    pushed: null,
  });
  assert.match(r.report.steps[4]?.reason ?? '', /SIGKILL/u);
  assert.equal(r.count(K.pushNew), 1);
});

test('a push that cannot start leaves the outcome unknown', () => {
  const r = run({ world: { [K.pushNew]: CANNOT_START } });
  assertRefused(r, 'push', NEXT.pushUnknown, {
    exitStatus: null,
    pushed: null,
  });
  assert.equal(r.count(K.pushNew), 1);
});

test('an upstream check that cannot run refuses before pushing', () => {
  const r = run({ world: { [K.upstream]: CANNOT_START } });
  assertRefused(r, 'push', NEXT.readGitError, {
    exitStatus: null,
    pushed: false,
  });
  noPush(r);
});

test('a dry run checks the claim and the location only', () => {
  const r = run({ input: { apply: false } });
  assert.equal(r.report.mode, 'dry-run');
  assert.equal(r.report.pushed, false);
  assert.deepEqual(
    r.report.steps.map((step) => step.status),
    ['passed', 'passed', 'skipped', 'skipped', 'skipped'],
  );
  for (const step of r.report.steps.slice(2)) {
    assert.match(step.reason, /dry run/u);
  }
  assert.equal(r.count(K.gate), 0);
  assert.equal(r.count(K.status), 0);
  assert.equal(r.count(K.assert), 1);
  noPush(r);
});

test('a dry run still refuses on a failed assert or location', () => {
  const lost = run({
    input: { apply: false },
    world: { [K.assert]: result(1) },
  });
  assertRefused(lost, 'assert', NEXT.staleClaim, { exitStatus: 1 });
  const wrong = run({
    input: { apply: false },
    world: { [K.current]: result(0, 'main\n') },
  });
  assertRefused(wrong, 'location', NEXT.switchBranch);
});

test('the assert receives the identity, the nonce only when given, and the worktree', () => {
  const withNonce = run();
  const assertCall = withNonce.calls.find((call) => call.kind === 'helper');
  assert.ok(assertCall && assertCall.kind === 'helper');
  assert.equal(assertCall.script, 'resume-claim-routing.mjs');
  assert.deepEqual(assertCall.args, [
    '--issue',
    String(ISSUE),
    '--assert',
    '--claim-id',
    CLAIM_ID,
    '--nonce',
    NONCE,
    '--worktree',
    WORKTREE,
  ]);
  assert.equal(assertCall.cwd, WORKTREE);

  const without = run({ input: { nonce: null } });
  const call = without.calls.find((candidate) => candidate.kind === 'helper');
  assert.ok(call && call.kind === 'helper');
  assert.equal(call.args.includes('--nonce'), false);

  const gate = withNonce.calls.find((candidate) => candidate.kind === 'gate');
  assert.deepEqual(gate, {
    kind: 'gate',
    command: 'pnpm run check',
    cwd: WORKTREE,
  });
});

// ---- Expected sibling path -------------------------------------------------

test('the repository name comes from the origin slug, not the primary basename', () => {
  const primary = join(ROOT, 'checkout-dir');
  const worktree = join(ROOT, 'idd-skill.issue-4375-feat-push-add-helper');
  const r = run({
    world: {
      [K.toplevel]: result(0, `${worktree}\n`),
      [K.worktrees]: result(0, worktreeList(primary, worktree)),
    },
    known: [primary, worktree],
  });
  assert.equal(r.report.steps[1]?.status, 'passed');
  const byBasename = run({
    world: {
      [K.toplevel]: result(
        0,
        `${join(ROOT, 'checkout-dir.issue-4375-feat-push-add-helper')}\n`,
      ),
      [K.worktrees]: result(0, worktreeList(primary, worktree)),
    },
    known: [
      primary,
      join(ROOT, 'checkout-dir.issue-4375-feat-push-add-helper'),
    ],
  });
  assertRefused(byBasename, 'location', NEXT.runFromWorktree);
});

test('an origin that is not on github.com builds the name from the primary basename', () => {
  const primary = join(ROOT, 'checkout-dir');
  const worktree = join(ROOT, 'checkout-dir.issue-4375-feat-push-add-helper');
  for (const origin of [
    result(2, '', "error: No such remote 'origin'"),
    result(0, 'git@gitlab.com:owner/other-name.git\n'),
    result(0, 'https://github.com.example.org/owner/other-name.git\n'),
    result(0, '/srv/git/other-name.git\n'),
  ]) {
    const r = run({
      world: {
        [K.origin]: origin,
        [K.toplevel]: result(0, `${worktree}\n`),
        [K.worktrees]: result(0, worktreeList(primary, worktree)),
      },
      known: [primary, worktree],
    });
    assert.equal(r.report.steps[1]?.status, 'passed', origin.stdout);
  }
});

test('github.com origin forms all yield the case-preserved repository name', () => {
  for (const url of [
    'https://github.com/Owner/MyApp.git',
    'https://github.com/Owner/MyApp',
    'https://github.com/Owner/MyApp/',
    'https://user@github.com/Owner/MyApp.git',
    'ssh://git@github.com/Owner/MyApp.git',
    'ssh://git@github.com:22/Owner/MyApp.git',
    'git@github.com:Owner/MyApp.git',
    'git@github.com:Owner/MyApp',
    'git@github.com:Owner/MyApp.git/',
  ]) {
    const primary = join(ROOT, 'unrelated');
    const worktree = join(ROOT, 'MyApp.issue-4375-feat-push-add-helper');
    const r = run({
      world: {
        [K.origin]: result(0, `${url}\n`),
        [K.toplevel]: result(0, `${worktree}\n`),
        [K.worktrees]: result(0, worktreeList(primary, worktree)),
      },
      known: [primary, worktree],
    });
    assert.equal(r.report.steps[1]?.status, 'passed', url);
  }
});

test('a github.com origin without an owner/repository path refuses', () => {
  const r = run({
    world: { [K.origin]: result(0, 'https://github.com/just-owner\n') },
  });
  assertRefused(r, 'location', NEXT.runFromWorktree);
  assert.match(r.report.steps[1]?.reason ?? '', /owner\/repository/u);
});

// ---- Command line ----------------------------------------------------------

test('parseArgs requires --issue and --claim-id and validates --nonce', () => {
  assert.deepEqual(
    parseArgs([
      '--issue',
      '4375',
      '--claim-id',
      'c',
      '--nonce',
      'n',
      '--apply',
    ]),
    { help: false, issue: 4375, claimId: 'c', nonce: 'n', apply: true },
  );
  assert.deepEqual(parseArgs(['--issue', '4375', '--claim-id', 'c']), {
    help: false,
    issue: 4375,
    claimId: 'c',
    nonce: null,
    apply: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs([]), /--issue is required/u);
  assert.throws(
    () => parseArgs(['--issue', '4375']),
    /--claim-id is required/u,
  );
  assert.throws(
    () => parseArgs(['--issue', 'abc', '--claim-id', 'c']),
    /--issue/u,
  );
  assert.throws(
    () => parseArgs(['--issue', '0', '--claim-id', 'c']),
    /--issue/u,
  );
  assert.throws(
    () => parseArgs(['--issue', '4375', '--claim-id', 'c', '--nonce', ' ']),
    /--nonce must not be empty/u,
  );
  assert.throws(() =>
    parseArgs(['--issue', '4375', '--claim-id', 'c', '--bogus']),
  );
});

test('runCli writes only the JSON report to stdout and maps failures to exit 1', () => {
  const chunks: string[] = [];
  const stdout = { write: (text: string) => chunks.push(text) };
  const world = defaultWorld();
  const deps: ClaimedPushDeps = {
    run: (request) => world[keyOf(request)] as CommandResult,
    realpath: (path) => path,
    readGateCommand: () => ({ ok: true, command: 'true' }),
  };
  const argv = ['--issue', String(ISSUE), '--claim-id', CLAIM_ID, '--apply'];
  assert.equal(runCli(argv, deps, { cwd: WORKTREE, stdout }), 0);
  assert.equal(chunks.length, 1);
  const parsed = JSON.parse(chunks.join('')) as ClaimedPushReport;
  assert.equal(parsed.pushed, true);

  chunks.length = 0;
  world[K.gate] = result(3);
  assert.equal(runCli(argv, deps, { cwd: WORKTREE, stdout }), 1);
  assert.equal(JSON.parse(chunks.join('')).pushed, false);
});

test('runCli exits 0 on a passing dry run and 1 on a refused one', () => {
  const chunks: string[] = [];
  const stdout = { write: (text: string) => chunks.push(text) };
  const world = defaultWorld();
  const deps: ClaimedPushDeps = {
    run: (request) => {
      const entry = world[keyOf(request)];
      assert.ok(entry, `unexpected command: ${keyOf(request)}`);
      return entry as CommandResult;
    },
    realpath: (path) => path,
    readGateCommand: () => ({ ok: true, command: 'true' }),
  };
  const argv = ['--issue', String(ISSUE), '--claim-id', CLAIM_ID];
  assert.equal(runCli(argv, deps, { cwd: WORKTREE, stdout }), 0);
  const dry = JSON.parse(chunks.join('')) as ClaimedPushReport;
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.pushed, false);

  chunks.length = 0;
  world[K.current] = result(0, 'main\n');
  assert.equal(runCli(argv, deps, { cwd: WORKTREE, stdout }), 1);
  assert.equal(
    (JSON.parse(chunks.join('')) as ClaimedPushReport).steps[1]?.status,
    'failed',
  );
});

test('runCli prints the usage for --help without running any command', () => {
  const chunks: string[] = [];
  const deps: ClaimedPushDeps = {
    run: () => assert.fail('no command may run for --help'),
    realpath: () => assert.fail('no path may be resolved for --help'),
    readGateCommand: () => assert.fail('no policy may be read for --help'),
  };
  const code = runCli(['--help'], deps, {
    stdout: { write: (text: string) => chunks.push(text) },
  });
  assert.equal(code, 0);
  assert.match(
    chunks.join(''),
    /^Usage:\n {2}node scripts\/claimed-push\.mjs/u,
  );
});

// ---- Production pieces -----------------------------------------------------

test('the production runner starts the real claim helper with the flags the assert uses', () => {
  const help = runProductionCommand({
    kind: 'helper',
    script: 'resume-claim-routing.mjs',
    args: ['--help'],
    cwd: tmpdir(),
  });
  assert.equal(help.status, 0, help.stderr);
  for (const flag of ['--assert', '--worktree', '--nonce', '--claim-id']) {
    assert.ok(`${help.stdout}${help.stderr}`.includes(flag), flag);
  }
});

test('the production runner reports a failure to start instead of throwing', () => {
  const missingDir = join(makeScratch(), 'does-not-exist');
  const git = runProductionCommand({
    kind: 'git',
    args: ['--version'],
    cwd: missingDir,
  });
  assert.equal(git.status, null);
  assert.ok((git.error ?? '') !== '');
  const gate = runProductionCommand({
    kind: 'gate',
    command: `"${process.execPath}" -e "process.exit(7)"`,
    cwd: tmpdir(),
  });
  assert.equal(gate.status, 7);
});

test('a helper script missing from the bundle cannot start', () => {
  const missing = runProductionCommand({
    kind: 'helper',
    script: 'no-such-helper.mjs',
    args: [],
    cwd: tmpdir(),
  });
  assert.equal(missing.status, null);
  assert.equal(missing.signal, null);
  assert.match(missing.error ?? '', /no-such-helper\.mjs does not exist/u);
});

const scratch: string[] = [];
function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claimed-push-test-'));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a gate that prints to stdout leaves stdout holding only the report', () => {
  const dir = makeScratch();
  const gateScript = join(dir, 'gate.mjs');
  writeFileSync(gateScript, "process.stdout.write('gate-says-hello\\n');\n");
  const gateCommand = `"${process.execPath}" "${gateScript}"`;
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../src/scripts/claimed-push.mts'),
  ).href;
  const fixture = join(dir, 'fixture.mjs');
  writeFileSync(
    fixture,
    `import { runCli, runProductionCommand } from ${JSON.stringify(moduleUrl)};
const [worldJson, gateCommand, cwd] = process.argv.slice(2);
const world = JSON.parse(worldJson);
const counts = {};
const run = (request) => {
  if (request.kind === 'gate') return runProductionCommand({ ...request, cwd });
  const key = request.kind === 'helper' ? 'assert' : 'git ' + request.args.join(' ');
  const entry = world[key];
  if (entry === undefined) throw new Error('unexpected command: ' + key);
  const list = Array.isArray(entry) ? entry : [entry];
  const index = counts[key] ?? 0;
  counts[key] = index + 1;
  return list[Math.min(index, list.length - 1)];
};
const deps = {
  run,
  realpath: (path) => path,
  readGateCommand: () => ({ ok: true, command: gateCommand }),
};
process.exitCode = runCli(
  ['--issue', '${ISSUE}', '--claim-id', '${CLAIM_ID}', '--apply'],
  deps,
  { cwd },
);
`,
  );
  const child = spawnSync(
    process.execPath,
    [fixture, JSON.stringify(defaultWorld()), gateCommand, dir],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout) as ClaimedPushReport;
  assert.equal(report.pushed, true);
  assert.doesNotMatch(child.stdout, /gate-says-hello/u);
  assert.match(child.stderr, /gate-says-hello/u);
});

function writePolicy(dir: string, text: string): void {
  mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
  writeFileSync(join(dir, '.github', 'idd', 'config.json'), text);
}

test('the effective gate command is read from the worktree policy', () => {
  const dir = makeScratch();
  const env = { GITHUB_ACTIONS: 'true' };
  writePolicy(
    dir,
    JSON.stringify({ commands: { 'pre-push-validate': '  pnpm run check  ' } }),
  );
  assert.deepEqual(readEffectiveGateCommand(dir, { env }), {
    ok: true,
    command: 'pnpm run check',
  });

  const absent = makeScratch();
  assert.equal(readEffectiveGateCommand(absent, { env }).ok, false);

  const blank = makeScratch();
  writePolicy(
    blank,
    JSON.stringify({ commands: { 'pre-push-validate': ' ' } }),
  );
  assert.equal(readEffectiveGateCommand(blank, { env }).ok, false);

  const missingKey = makeScratch();
  writePolicy(
    missingKey,
    JSON.stringify({ commands: { 'fix-validate': 'x' } }),
  );
  assert.equal(readEffectiveGateCommand(missingKey, { env }).ok, false);

  const malformed = makeScratch();
  writePolicy(malformed, '{ not json');
  const refusal = readEffectiveGateCommand(malformed, { env });
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? '' : refusal.reason, /unreadable/u);
});

test('a broken repository policy never falls through to a user-global command', () => {
  const dir = makeScratch();
  const configHome = makeScratch();
  mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
  writeFileSync(
    join(configHome, 'idd-skill', 'config.json'),
    JSON.stringify({ commands: { 'pre-push-validate': 'echo user-global' } }),
  );
  writePolicy(dir, '{ not json');
  const refusal = readEffectiveGateCommand(dir, {
    env: { XDG_CONFIG_HOME: configHome },
    homedir: configHome,
  });
  assert.equal(refusal.ok, false);
  assert.match(refusal.ok ? '' : refusal.reason, /unreadable/u);
});

test('a user-global gate command applies when the repository has no policy file', () => {
  const dir = makeScratch();
  const configHome = makeScratch();
  mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
  writeFileSync(
    join(configHome, 'idd-skill', 'config.json'),
    JSON.stringify({ commands: { 'pre-push-validate': 'echo user-global' } }),
  );
  const options = { env: { XDG_CONFIG_HOME: configHome }, homedir: configHome };
  assert.deepEqual(readEffectiveGateCommand(dir, options), {
    ok: true,
    command: 'echo user-global',
  });
  writePolicy(
    dir,
    JSON.stringify({ commands: { 'pre-push-validate': 'echo repository' } }),
  );
  assert.deepEqual(readEffectiveGateCommand(dir, options), {
    ok: true,
    command: 'echo repository',
  });
});
