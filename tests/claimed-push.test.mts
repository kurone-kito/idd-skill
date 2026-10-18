import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { auditAuthoredIssue } from '../src/scripts/audit-authored-issue.mts';
import type {
  BaseTextRead,
  ClaimedPushDeps,
  ClaimedPushInput,
  ClaimedPushReport,
  ClaimedPushStepId,
  CommandRequest,
  CommandResult,
  GateCommandRead,
  PolicyRead,
} from '../src/scripts/claimed-push.mts';
import {
  makeBaseTextReader,
  parseArgs,
  readEffectiveGateCommand,
  readPrimaryPolicy,
  runClaimedPush,
  runCli,
  runProductionCommand,
} from '../src/scripts/claimed-push.mts';
import { parseCandidateFiles } from '../src/scripts/discover-shared-file-overlap.mts';
import {
  fixtureEnv,
  pinLoadControlOff,
  stubExecutable,
} from './test-utils.mts';

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

// The scope step's next actions are copied from items 4(c) and 6 of issue
// 4480 for the same reason.
const SCOPE_NEXT = {
  overrun:
    'stop without pushing and follow the Scope overrun rule in idd-work.instructions.md',
  staleBase: (base: string): string =>
    `run node scripts/clone-lock.mjs --exec --agent-id <your agent id> -- git fetch origin +refs/heads/${base}:refs/remotes/origin/${base} (see docs/idd-helper-scripts.md, "Clone-scoped lock"), then rerun the helper once; if the base is still stale, stop, report both SHAs, and do not push`,
} as const;

const ISSUE = 4375;
const CLAIM_ID = 'claim-id-4375';
const NONCE = 'nonce-4375';
const ROOT = resolve(tmpdir(), 'claimed-push-fake-root');
const PRIMARY = join(ROOT, 'idd-skill');
const WORKTREE = join(ROOT, 'idd-skill.issue-4375-feat-push-add-helper');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'main';
const BASE_SHA = 'd'.repeat(40);
const STALE_SHA = 'f'.repeat(40);
const BRANCH_POINT = 'e'.repeat(40);
const ISSUE_TITLE = 'feat(push): add the claimed-push helper';
const STEP_IDS: ClaimedPushStepId[] = [
  'assert',
  'location',
  'scope',
  'gate',
  'reassert',
  'push',
];
const AUDIT_SCRIPT = 'audit-authored-issue.mjs';
const EFFORT_FINDING = 'effort-candidate-file-limit';

const K = {
  toplevel: 'git rev-parse --show-toplevel',
  assert: 'assert',
  worktrees: 'git worktree list --porcelain -z',
  origin: 'git remote get-url origin',
  current: 'git branch --show-current',
  issueView: `gh issue view ${ISSUE} --json title,body`,
  repoView: 'gh repo view --json defaultBranchRef --jq .defaultBranchRef.name',
  lsRemote: `git ls-remote --heads origin ${BASE}`,
  tracking: `git rev-parse --verify --quiet refs/remotes/origin/${BASE}`,
  mergeBase: `git merge-base refs/remotes/origin/${BASE} HEAD`,
  diff: `git diff --no-renames --name-only -z ${BRANCH_POINT}`,
  untracked: 'git ls-files --others --exclude-standard -z',
  audit: 'audit',
  status:
    'git status --porcelain --untracked-files=all --ignore-submodules=none',
  head: 'git rev-parse HEAD',
  tip: `git rev-parse --verify refs/heads/${BRANCH}`,
  upstream: `git rev-parse --abbrev-ref --symbolic-full-name ${BRANCH}@{upstream}`,
  pushNew: `git push -u origin ${BRANCH}`,
  pushKnown: `git push origin ${BRANCH}`,
  gate: 'gate',
} as const;

/** The scope calls of a passing run, in order. */
const SCOPE_CALLS = [
  K.issueView,
  K.repoView,
  K.lsRemote,
  K.tracking,
  K.mergeBase,
  K.diff,
  K.untracked,
  K.audit,
  K.audit,
];

type Responses =
  | CommandResult
  | CommandResult[]
  | ((request: CommandRequest) => CommandResult);

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

/** An issue body within the M limit, with headings after its first line. */
function issueBody(candidates: readonly string[], extra = ''): string {
  return [
    '## Background',
    '',
    'The helper pushes a claimed branch.',
    '',
    '## Candidate files',
    '',
    ...candidates.map((path) => `- \`${path}\``),
    '',
    ...(extra === '' ? [] : [extra, '']),
    '<!-- idd-skill-effort: M -->',
    '',
  ].join('\n');
}

const DEFAULT_BODY = issueBody([
  'src/scripts/claimed-push.mts',
  'tests/claimed-push.test.mts',
]);

function issueJson(body = DEFAULT_BODY, title = ISSUE_TITLE): string {
  return JSON.stringify({ title, body });
}

/** `count` distinct canonical paths, none of which shares a key. */
function manyPaths(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `src/scripts/p${index}.mts`,
  );
}

function nulList(paths: readonly string[]): string {
  return paths.map((path) => `${path}\0`).join('');
}

/** A canned audit report holding one effort-candidate-file-limit finding. */
function auditResult(
  outcome: 'pass' | 'fail',
  detail = outcome === 'pass'
    ? 'effort M with 2 candidate file(s) is within the limit of 8'
    : 'effort M with 9 candidate files exceeds the limit of 8',
  status = outcome === 'pass' ? 0 : 1,
): CommandResult {
  return result(
    status,
    `${JSON.stringify({
      shape: 'child',
      markerPrefix: 'idd-skill',
      passed: status === 0,
      findings: [
        { id: EFFORT_FINDING, name: 'limit', result: outcome, detail },
      ],
    })}\n`,
  );
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The real audit, run in this process on the request's stdin. */
function realAudit(request: CommandRequest): CommandResult {
  assert.ok(request.kind === 'helper' && request.stdin !== undefined);
  const report = auditAuthoredIssue(request.stdin, {
    shape: 'child',
    markerPrefix: argValue(request.args, '--marker-prefix'),
    title: argValue(request.args, '--title'),
  });
  return result(report.passed ? 0 : 1, `${JSON.stringify(report)}\n`);
}

function defaultWorld(): Record<string, Responses> {
  return {
    [K.toplevel]: result(0, `${WORKTREE}\n`),
    [K.assert]: result(0, claimJson()),
    [K.worktrees]: result(0, worktreeList()),
    [K.origin]: result(0, 'git@github.com:kurone-kito/idd-skill.git\n'),
    [K.current]: result(0, `${BRANCH}\n`),
    [K.issueView]: result(0, issueJson()),
    [K.repoView]: result(0, `${BASE}\n`),
    [K.lsRemote]: result(0, `${BASE_SHA}\trefs/heads/${BASE}\n`),
    [K.tracking]: result(0, `${BASE_SHA}\n`),
    [K.mergeBase]: result(0, `${BRANCH_POINT}\n`),
    [K.diff]: result(
      0,
      nulList(['src/scripts/claimed-push.mts', 'tests/claimed-push.test.mts']),
    ),
    [K.untracked]: result(0, ''),
    [K.audit]: auditResult('pass'),
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
  if (request.kind === 'helper') {
    return request.script === AUDIT_SCRIPT ? K.audit : K.assert;
  }
  return `${request.kind} ${request.args.join(' ')}`;
}

interface Scenario {
  world?: Record<string, Responses>;
  known?: string[];
  gate?: GateCommandRead;
  input?: Partial<ClaimedPushInput>;
  policy?: PolicyRead;
  /** Files at the branch point; a path not listed is absent there. */
  baseFiles?: Record<string, BaseTextRead>;
  parseCandidates?: (body: string) => string[];
}

interface Run {
  report: ClaimedPushReport;
  calls: CommandRequest[];
  count: (key: string) => number;
}

interface Harness {
  deps: ClaimedPushDeps;
  calls: CommandRequest[];
  count: (key: string) => number;
  /** The live response table; a test may replace an entry between runs. */
  world: Record<string, Responses>;
}

function harness(scenario: Scenario = {}): Harness {
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
      if (typeof entry === 'function') {
        return entry(request);
      }
      const list = Array.isArray(entry) ? entry : [entry];
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      return list[Math.min(index, list.length - 1)] as CommandResult;
    },
    realpath: (path) => (known.has(path) ? path : null),
    readGateCommand: () =>
      scenario.gate ?? { ok: true, command: 'pnpm run check' },
    readPolicy: () => scenario.policy ?? { ok: true, policy: null },
    readBaseText: (_worktree, branchPoint, path) => {
      assert.equal(branchPoint, BRANCH_POINT);
      return scenario.baseFiles?.[path] ?? { status: 'absent' };
    },
    parseCandidates: scenario.parseCandidates ?? parseCandidateFiles,
  };
  return {
    deps,
    calls,
    count: (key) => calls.filter((call) => keyOf(call) === key).length,
    world,
  };
}

function run(scenario: Scenario = {}): Run {
  const { deps, calls, count } = harness(scenario);
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
  return { report, calls, count };
}

function stepOf(run_: Run, id: ClaimedPushStepId) {
  const step = run_.report.steps.find((candidate) => candidate.id === id);
  assert.ok(step, `the report has a ${id} step`);
  return step;
}

/** The stdin of each audit run, in order. */
function auditInputs(run_: Run): string[] {
  return run_.calls.flatMap((call) =>
    call.kind === 'helper' && call.script === AUDIT_SCRIPT
      ? [call.stdin ?? '']
      : [],
  );
}

function assertReportInvariants(report: ClaimedPushReport): void {
  assert.deepEqual(
    report.steps.map((step) => step.id),
    STEP_IDS,
  );
  for (const step of report.steps) {
    assert.ok(step.reason.length > 0, `${step.id} has a reason`);
    if (step.status === 'passed') {
      assert.equal(
        step.exitStatus,
        0,
        `${step.id} passed without exit status 0`,
      );
    }
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
  if (id === 'assert' || id === 'location' || id === 'scope') {
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
  assertRefused(r, 'assert', NEXT.runFromWorktree, { exitStatus: 128 });
  assert.equal(r.count(K.assert), 0);
  noPush(r);
});

test('the worktree path keeps trailing whitespace and loses only the line break', () => {
  const spaced = `${WORKTREE} `;
  for (const terminator of ['\n', '\r\n']) {
    const r = run({
      world: { [K.toplevel]: result(0, `${spaced}${terminator}`) },
      input: { apply: false },
    });
    const call = r.calls.find((candidate) => candidate.kind === 'helper');
    assert.ok(call && call.kind === 'helper');
    assert.equal(call.cwd, spaced);
    assert.equal(call.args[call.args.length - 1], spaced);
    assert.equal(r.report.worktree, spaced);
  }
});

test('a claimed branch outside issue/<n>- refuses before any path is computed', () => {
  for (const branch of ['main', 'issue/4376-other-issue', 'issue/4375']) {
    const r = run({ world: { [K.assert]: result(0, claimJson(branch)) } });
    assertRefused(r, 'location', NEXT.stopAndReport, { exitStatus: 0 });
    assert.equal(r.count(K.worktrees), 0, branch);
    assert.equal(r.count(K.gate), 0);
    noPush(r);
  }
});

test('an empty worktree path from git refuses at the assert step', () => {
  const r = run({ world: { [K.toplevel]: result(0, '\n') } });
  assertRefused(r, 'assert', NEXT.runFromWorktree, { exitStatus: 0 });
  assert.equal(r.count(K.assert), 0);
  noPush(r);
});

test('a worktree that is not the sibling path of the claimed branch refuses', () => {
  const elsewhere = join(ROOT, 'somewhere-else');
  const r = run({
    world: { [K.toplevel]: result(0, `${elsewhere}\n`) },
    known: [PRIMARY, WORKTREE, elsewhere],
  });
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: 0 });
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('an expected sibling path that cannot be resolved refuses', () => {
  const r = run({ known: [PRIMARY] });
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: undefined });
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
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: undefined });
  noPush(r);
});

test('a primary checkout that git does not list first refuses', () => {
  const r = run({ world: { [K.worktrees]: result(0, '') } });
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: 0 });
  const failed = run({
    world: { [K.worktrees]: result(128, '', 'fatal: nope') },
  });
  assertRefused(failed, 'location', NEXT.runFromWorktree, { exitStatus: 128 });
});

test('a current branch that differs from the claimed branch refuses', () => {
  const r = run({ world: { [K.current]: result(0, 'issue/4375-another\n') } });
  assertRefused(r, 'location', NEXT.switchBranch, { exitStatus: 0 });
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a detached HEAD refuses', () => {
  const r = run({ world: { [K.current]: result(0, '\n') } });
  assertRefused(r, 'location', NEXT.switchBranch, { exitStatus: 0 });
  assert.match(r.report.steps[1]?.reason ?? '', /detached/u);
  noPush(r);
  const failed = run({ world: { [K.current]: result(128, '', 'fatal') } });
  assertRefused(failed, 'location', NEXT.switchBranch, { exitStatus: 128 });
});

test('a dirty working tree refuses before the gate runs', () => {
  const r = run({
    world: { [K.status]: result(0, ' M src/file.mts\n?? new.txt\n') },
  });
  assertRefused(r, 'gate', NEXT.commitThenRerun, { exitStatus: 0 });
  assert.match(r.report.steps[3]?.reason ?? '', / M src\/file\.mts/u);
  assert.match(r.report.steps[3]?.reason ?? '', /\?\? new\.txt/u);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a status read that fails refuses instead of reading as clean', () => {
  const r = run({
    world: { [K.status]: result(128, '', 'fatal: index.lock exists') },
  });
  assertRefused(r, 'gate', NEXT.readGitError, { exitStatus: 128 });
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a long dirty-tree listing is capped', () => {
  const lines = Array.from(
    { length: 30 },
    (_, index) => ` M file-${index}.txt`,
  );
  const r = run({ world: { [K.status]: result(0, `${lines.join('\n')}\n`) } });
  assertRefused(r, 'gate', NEXT.commitThenRerun, { exitStatus: 0 });
  const reason = r.report.steps[3]?.reason ?? '';
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
  assert.match(r.report.steps[3]?.reason ?? '', /SIGKILL/u);
  noPush(r);
});

test('a buffer overflow that kills the gate keeps the error text', () => {
  const overflow = result(null, '', '', {
    signal: 'SIGTERM',
    error: 'spawnSync ENOBUFS',
  });
  const r = run({ world: { [K.gate]: overflow } });
  assertRefused(r, 'gate', NEXT.fixThenRerun, { exitStatus: null });
  assert.match(r.report.steps[3]?.reason ?? '', /SIGTERM.*ENOBUFS/u);
});

test('a gate that cannot start refuses with the configure next action', () => {
  const r = run({ world: { [K.gate]: CANNOT_START } });
  assertRefused(r, 'gate', NEXT.configureGate, { exitStatus: null });
  assert.match(
    r.report.steps[3]?.reason ?? '',
    /could not start: spawn ENOENT/u,
  );
  noPush(r);
});

test('a gate command that is not configured is never run', () => {
  const r = run({
    gate: { ok: false, reason: 'commands.pre-push-validate is not configured' },
  });
  assertRefused(r, 'gate', NEXT.configureGate, { exitStatus: undefined });
  assert.match(r.report.steps[3]?.reason ?? '', /not configured/u);
  assert.equal(r.count(K.gate), 0);
  noPush(r);
});

test('a working tree the gate dirtied refuses', () => {
  const r = run({
    world: { [K.status]: [result(0, ''), result(0, ' M generated.mjs\n')] },
  });
  assertRefused(r, 'gate', NEXT.commitOrDiscard, { exitStatus: 0 });
  assert.match(r.report.steps[3]?.reason ?? '', /generated\.mjs/u);
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
  assertRefused(r, 'reassert', NEXT.rerunForHead, { exitStatus: 0 });
  assert.match(r.report.steps[4]?.reason ?? '', new RegExp(OTHER_HEAD, 'u'));
  noPush(r);
});

test('a branch tip that differs from the gated commit refuses the push', () => {
  const r = run({ world: { [K.tip]: result(0, `${OTHER_HEAD}\n`) } });
  assertRefused(r, 'reassert', NEXT.rerunForHead, { exitStatus: 0 });
  noPush(r);
});

test('a branch-tip read that fails refuses instead of comparing', () => {
  const r = run({ world: { [K.tip]: result(128, '', 'fatal: bad ref') } });
  assertRefused(r, 'reassert', NEXT.readGitError, { exitStatus: 128 });
  noPush(r);
});

test('a git read that ends without an exit status reports a null exit status', () => {
  const r = run({ world: { [K.status]: KILLED } });
  assertRefused(r, 'gate', NEXT.readGitError, { exitStatus: null });
  assert.match(r.report.steps[3]?.reason ?? '', /SIGKILL/u);
  assert.equal(r.count(K.gate), 0);
  const noStart = run({ world: { [K.toplevel]: CANNOT_START } });
  assertRefused(noStart, 'assert', NEXT.runFromWorktree, { exitStatus: null });
});

test('a status read that fails after the gate refuses', () => {
  const r = run({
    world: {
      [K.status]: [result(0, ''), result(128, '', 'fatal: index.lock')],
    },
  });
  assertRefused(r, 'gate', NEXT.readGitError, { exitStatus: 128 });
  assert.equal(r.count(K.gate), 1);
  noPush(r);
});

test('a 64-character object id is accepted as HEAD', () => {
  const sha256 = 'c'.repeat(64);
  const r = run({
    world: {
      [K.head]: result(0, `${sha256}\n`),
      [K.tip]: result(0, `${sha256}\n`),
    },
  });
  assert.equal(r.report.pushed, true);
  assert.equal(r.report.pushedSha, sha256);
});

test('an object id of the wrong length is not accepted as HEAD', () => {
  const r = run({ world: { [K.head]: result(0, `${'a'.repeat(41)}\n`) } });
  assertRefused(r, 'gate', NEXT.readGitError, { exitStatus: 0 });
  assert.equal(r.count(K.gate), 0);
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
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: null });
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
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: 0 });
  assert.equal(r.count(K.current), 0);
});

test('a HEAD read that fails refuses instead of comparing empty values', () => {
  const r = run({ world: { [K.head]: result(128, '', 'fatal: bad object') } });
  assertRefused(r, 'gate', NEXT.readGitError, { exitStatus: 128 });
  assert.equal(r.count(K.gate), 0);
  const malformed = run({ world: { [K.head]: result(0, 'not-a-sha\n') } });
  assertRefused(malformed, 'gate', NEXT.readGitError, { exitStatus: 0 });
  const second = run({
    world: { [K.head]: [result(0, `${HEAD}\n`), result(128, '', 'fatal')] },
  });
  assertRefused(second, 'reassert', NEXT.readGitError, { exitStatus: 128 });
  noPush(second);
});

test('a branch with no upstream is pushed once with -u and no force flag', () => {
  const r = run();
  assert.equal(r.report.mode, 'apply');
  assert.equal(r.report.pushed, true);
  assert.equal(r.report.pushedSha, HEAD);
  assert.equal(r.report.steps[1]?.exitStatus, 0);
  assert.match(r.report.pushMessage ?? '', /To github\.com/u);
  assert.deepEqual(
    r.report.steps.map((step) => step.status),
    ['passed', 'passed', 'passed', 'passed', 'passed', 'passed'],
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
    ...SCOPE_CALLS,
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
  assert.match(r.report.steps[5]?.reason ?? '', /non-fast-forward/u);
  assert.equal(r.count(K.pushNew), 1);
  assert.equal(r.count(K.pushKnown), 0);
});

test('a push killed by a signal leaves the outcome unknown', () => {
  const r = run({ world: { [K.pushNew]: KILLED } });
  assertRefused(r, 'push', NEXT.pushUnknown, {
    exitStatus: null,
    pushed: null,
  });
  assert.match(r.report.steps[5]?.reason ?? '', /SIGKILL/u);
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

test('the clean-tree check passes --ignore-submodules=none on both calls', () => {
  const statusCalls = run().calls.filter(
    (call) => call.kind === 'git' && call.args[0] === 'status',
  );
  assert.equal(
    statusCalls.length,
    2,
    'one check before and one after the gate',
  );
  for (const call of statusCalls) {
    assert.ok(
      call.kind === 'git' && call.args.includes('--ignore-submodules=none'),
      'the status call must override diff.ignoreSubmodules and submodule.<name>.ignore',
    );
  }
});

test('a dry run checks the claim, the location, and the scope only', () => {
  const r = run({ input: { apply: false } });
  assert.equal(r.report.mode, 'dry-run');
  assert.equal(r.report.pushed, false);
  assert.deepEqual(
    r.report.steps.map((step) => step.status),
    ['passed', 'passed', 'passed', 'skipped', 'skipped', 'skipped'],
  );
  for (const step of r.report.steps.slice(3)) {
    assert.match(step.reason, /dry run/u);
  }
  assert.equal(r.count(K.gate), 0);
  assert.equal(r.count(K.status), 0);
  assert.equal(r.count(K.assert), 1);
  assert.equal(r.count(K.audit), 2);
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
  assertRefused(wrong, 'location', NEXT.switchBranch, { exitStatus: 0 });
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
  assertRefused(byBasename, 'location', NEXT.runFromWorktree, {
    exitStatus: undefined,
  });
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
    'git+ssh://git@github.com/Owner/MyApp.git',
    'ssh+git://git@github.com/Owner/MyApp.git',
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
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: 0 });
  assert.match(r.report.steps[1]?.reason ?? '', /owner\/repository/u);
});

test('a refused origin never echoes the credentials in its URL', () => {
  const token = 'ghp_SECRETTOKENVALUE';
  const r = run({
    world: {
      [K.origin]: result(
        0,
        `https://x-access-token:${token}@github.com/just-owner\n`,
      ),
    },
  });
  assertRefused(r, 'location', NEXT.runFromWorktree, { exitStatus: 0 });
  assert.doesNotMatch(JSON.stringify(r.report), new RegExp(token, 'u'));
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
  const { deps, world } = harness({ gate: { ok: true, command: 'true' } });
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
  const { deps, world } = harness({ gate: { ok: true, command: 'true' } });
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
    readPolicy: () => assert.fail('no policy may be read for --help'),
    readBaseText: () => assert.fail('no file may be read for --help'),
    parseCandidates: () => assert.fail('no body may be parsed for --help'),
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
  const parserUrl = pathToFileURL(
    resolve(
      import.meta.dirname,
      '../src/scripts/discover-shared-file-overlap.mts',
    ),
  ).href;
  const fixture = join(dir, 'fixture.mjs');
  writeFileSync(
    fixture,
    `import { runCli, runProductionCommand } from ${JSON.stringify(moduleUrl)};
import { parseCandidateFiles } from ${JSON.stringify(parserUrl)};
const [worldJson, gateCommand, cwd] = process.argv.slice(2);
const world = JSON.parse(worldJson);
const counts = {};
const run = (request) => {
  if (request.kind === 'gate') return runProductionCommand({ ...request, cwd });
  const key = request.kind === 'helper'
    ? (request.script === ${JSON.stringify(AUDIT_SCRIPT)} ? 'audit' : 'assert')
    : request.kind + ' ' + request.args.join(' ');
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
  readPolicy: () => ({ ok: true, policy: null }),
  readBaseText: () => ({ status: 'absent' }),
  parseCandidates: parseCandidateFiles,
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

test('a minimal repository policy file takes the gate command from the user-global tier', () => {
  const dir = makeScratch();
  const configHome = makeScratch();
  mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
  writeFileSync(
    join(configHome, 'idd-skill', 'config.json'),
    JSON.stringify({ commands: { 'pre-push-validate': 'echo user-global' } }),
  );
  const options = { env: { XDG_CONFIG_HOME: configHome }, homedir: configHome };
  for (const policy of [{}, { commands: { 'fix-validate': 'echo fix' } }]) {
    writePolicy(dir, JSON.stringify(policy));
    assert.deepEqual(readEffectiveGateCommand(dir, options), {
      ok: true,
      command: 'echo user-global',
    });
  }
  writePolicy(dir, JSON.stringify({ commands: { 'pre-push-validate': 42 } }));
  assert.equal(readEffectiveGateCommand(dir, options).ok, false);

  // Under GitHub Actions the user-global tier is not read at all.
  writePolicy(dir, JSON.stringify({}));
  const ci = readEffectiveGateCommand(dir, {
    ...options,
    env: { ...options.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(ci.ok, false);
  assert.match(ci.ok ? '' : ci.reason, /not configured/u);
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

// ---- Scope step (issue 4480) -----------------------------------------------

interface CliRun {
  code: unknown;
  report: ClaimedPushReport;
  h: Harness;
}

/** Run the CLI over a harness and parse its report. */
function cliRun(scenario: Scenario, apply = false): CliRun {
  const h = harness(scenario);
  const chunks: string[] = [];
  const argv = [
    '--issue',
    String(ISSUE),
    '--claim-id',
    CLAIM_ID,
    '--nonce',
    NONCE,
    ...(apply ? ['--apply'] : []),
  ];
  const code = runCli(argv, h.deps, {
    cwd: WORKTREE,
    stdout: { write: (text: string) => chunks.push(text) },
  });
  const report = JSON.parse(chunks.join('')) as ClaimedPushReport;
  assertReportInvariants(report);
  return { code, report, h };
}

/** The canonical paths a copy leads with. */
function canonicalOf(copy: string): string[] {
  const head = '## Candidate files\n\n';
  assert.ok(copy.startsWith(head), 'the copy leads with the canonical section');
  const section = copy.slice(head.length, copy.indexOf('\n\n', head.length));
  return section.split('\n').map((line) => {
    const match = /^- `(.*)`$/u.exec(line);
    assert.ok(match?.[1] !== undefined, line);
    return match[1];
  });
}

/** The effort reading at the start of an effort-candidate-file-limit detail. */
function effortReading(output: string): string {
  const report = JSON.parse(output) as {
    findings: { id: string; detail: string }[];
  };
  const detail =
    report.findings.find((finding) => finding.id === EFFORT_FINDING)?.detail ??
    '';
  const match =
    /^(?:not applicable: [^;,]*|effort [SML](?: with \d+ candidate files? exceeds| with \d+ candidate file\(s\) is within)?)/u.exec(
      detail,
    );
  assert.ok(match, detail);
  return match[0];
}

function bodyWithMarker(marker: string, extra = ''): string {
  return [
    '## Background',
    '',
    'The helper pushes a claimed branch.',
    '',
    '## Candidate files',
    '',
    '- `src/scripts/claimed-push.mts`',
    '',
    ...(extra === '' ? [] : [extra, '']),
    marker,
    '',
  ].join('\n');
}

test('a body within the limit whose canonical paths exceed it fails scope in the dry run', () => {
  const { code, report, h } = cliRun({
    world: { [K.diff]: result(0, nulList(manyPaths(9))), [K.audit]: realAudit },
  });
  assert.equal(code, 1);
  const scope = report.steps[2];
  assert.equal(scope?.id, 'scope');
  assert.equal(scope?.status, 'failed');
  assert.equal(scope?.nextAction, SCOPE_NEXT.overrun);
  assert.equal(scope?.exitStatus, 1);
  assert.match(
    scope?.reason ?? '',
    /fails with the canonical paths: effort M with 9 candidate files exceeds the limit of 8/u,
  );
  assert.doesNotMatch(scope?.reason ?? '', /fails on the issue body/u);
  assert.match(scope?.reason ?? '', /9 canonical path\(s\)/u);
  assert.match(scope?.reason ?? '', /src\/scripts\/p8\.mts/u);
  assert.match(scope?.reason ?? '', /no "\/" or "\." or with whitespace/u);
  assert.deepEqual(
    report.steps.slice(3).map((step) => [step.id, step.status]),
    [
      ['gate', 'skipped'],
      ['reassert', 'skipped'],
      ['push', 'skipped'],
    ],
  );
  assert.equal(h.count(K.gate), 0);
  assert.equal(report.pushed, false);
});

test('a body over the limit fails scope', () => {
  const r = run({
    world: {
      [K.issueView]: result(0, issueJson(issueBody(manyPaths(9)))),
      [K.audit]: realAudit,
    },
  });
  assertRefused(r, 'scope', SCOPE_NEXT.overrun, { exitStatus: 1 });
  assert.match(
    stepOf(r, 'scope').reason,
    /fails on the issue body: effort M with 9 candidate files exceeds the limit of 8/u,
  );
  assert.equal(r.count(K.status), 0);
});

test('a body and canonical paths both within the limit pass scope in the dry run', () => {
  const { code, report, h } = cliRun({ world: { [K.audit]: realAudit } });
  assert.equal(code, 0);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['passed', 'passed', 'passed', 'skipped', 'skipped', 'skipped'],
  );
  assert.equal(report.steps[2]?.exitStatus, 0);
  assert.match(report.steps[3]?.reason ?? '', /dry run/u);
  assert.equal(h.count(K.gate), 0);
  assert.equal(h.count(K.audit), 2);
});

test('a scope failure with --apply sends no gate or push request', () => {
  const r = run({
    world: { [K.diff]: result(0, nulList(manyPaths(9))), [K.audit]: realAudit },
  });
  assertRefused(r, 'scope', SCOPE_NEXT.overrun, { exitStatus: 1 });
  assert.equal(r.count(K.gate), 0);
  assert.equal(r.count(K.status), 0);
  assert.equal(r.count(K.assert), 1);
  noPush(r);
});

test('a passing scope with --apply runs scope, gate, reassert, and push in order', () => {
  const r = run({ world: { [K.audit]: realAudit } });
  assert.equal(stepOf(r, 'scope').status, 'passed');
  assert.equal(r.report.pushed, true);
  const keys = r.calls.map(keyOf);
  const lastAudit = keys.lastIndexOf(K.audit);
  const gate = keys.indexOf(K.gate);
  const reassert = keys.lastIndexOf(K.assert);
  const push = keys.indexOf(K.pushNew);
  assert.ok(keys.indexOf(K.audit) > keys.indexOf(K.current));
  assert.ok(lastAudit < gate, 'scope before the gate');
  assert.ok(gate < reassert, 'gate before the reassert');
  assert.ok(reassert < push, 'reassert before the push');
  const pushes = r.calls.filter(
    (call) => call.kind === 'git' && call.args[0] === 'push',
  );
  assert.equal(pushes.length, 1);
  for (const call of pushes) {
    assert.ok(
      call.kind === 'git' &&
        call.args.every((arg) => !/^-f$|force/iu.test(arg)),
    );
  }
});

test('the production runner passes stdin to the built audit', () => {
  const over = runProductionCommand({
    kind: 'helper',
    script: AUDIT_SCRIPT,
    args: [
      '--shape',
      'child',
      '--stdin',
      '--marker-prefix',
      'idd-skill',
      '--title',
      ISSUE_TITLE,
    ],
    cwd: makeScratch(),
    stdin: issueBody(manyPaths(9)),
  });
  assert.equal(over.status, 1, over.stderr);
  const report = JSON.parse(over.stdout) as {
    findings: { id: string; result: string; detail: string }[];
  };
  const finding = report.findings.find((entry) => entry.id === EFFORT_FINDING);
  assert.equal(finding?.result, 'fail');
  assert.match(finding?.detail ?? '', /effort M with 9 candidate files/u);
});

test('the second run reads the effort marker as the first run does', () => {
  const cases: [string, string, string][] = [
    [
      'a marker split over lines',
      bodyWithMarker('<!--\n  idd-skill-effort: M\n-->'),
      'effort M with 9 candidate files exceeds',
    ],
    [
      'a marker in a fenced example',
      bodyWithMarker('```markdown\n<!-- idd-skill-effort: M -->\n```'),
      'not applicable: no coherent effort marker',
    ],
    [
      'a bullet-form marker',
      bodyWithMarker('- <!-- idd-skill-effort: M -->'),
      'effort M with 9 candidate files exceeds',
    ],
  ];
  for (const [label, body, expected] of cases) {
    const outputs: string[] = [];
    const r = run({
      input: { apply: false },
      world: {
        [K.issueView]: result(0, issueJson(body)),
        [K.diff]: result(0, nulList(manyPaths(9))),
        [K.audit]: (request) => {
          const answer = realAudit(request);
          outputs.push(answer.stdout);
          return answer;
        },
      },
    });
    const inputs = auditInputs(r);
    assert.equal(inputs[0], body, label);
    assert.ok(inputs[1]?.endsWith(body), `${label}: the copy keeps the body`);
    assert.equal(outputs.length, 2, label);
    // The issue body lists one path, so only the reading of the marker is
    // compared between the runs; the count differs by design.
    const first = effortReading(outputs[0] ?? '');
    const second = effortReading(outputs[1] ?? '');
    assert.equal(
      first.startsWith('not applicable'),
      second.startsWith('not applicable'),
      label,
    );
    assert.ok(second.startsWith(expected), `${label}: ${second}`);
    assert.equal(
      stepOf(r, 'scope').status,
      expected.startsWith('not applicable') ? 'passed' : 'failed',
      label,
    );
  }
});

test('a read-back that differs from the canonical section gives no verdict', () => {
  const r = run({
    parseCandidates: (body) =>
      body.includes('## Background')
        ? ['other/path.mts']
        : parseCandidateFiles(body),
  });
  assertRefused(r, 'scope', NEXT.stopAndReport, { exitStatus: null });
  assert.match(stepOf(r, 'scope').reason, /does not parse to exactly/u);
  assert.equal(r.count(K.audit), 0);
});

test('a body with no heading after its first line is refused before either run', () => {
  for (const body of [
    'Plain text only.\n<!-- idd-skill-effort: M -->\n',
    '## Only a first-line heading\n\nText.\n<!-- idd-skill-effort: M -->\n',
    'Text.\n\n```markdown\n## Candidate files\n```\n',
  ]) {
    const r = run({ world: { [K.issueView]: result(0, issueJson(body)) } });
    assertRefused(r, 'scope', NEXT.stopAndReport, { exitStatus: 0 });
    assert.match(stepOf(r, 'scope').reason, /no heading after its first line/u);
    assert.equal(r.count(K.audit), 0, body);
  }
});

test('a body with a Split out of line passes the second run over the limit', () => {
  const r = run({
    input: { apply: false },
    world: {
      [K.issueView]: result(
        0,
        issueJson(
          issueBody(['src/scripts/claimed-push.mts'], 'Split out of #4375'),
        ),
      ),
      [K.diff]: result(0, nulList(manyPaths(9))),
      [K.audit]: realAudit,
    },
  });
  assert.equal(stepOf(r, 'scope').status, 'passed');
  assert.match(stepOf(r, 'scope').reason, /provenance line exempts it/u);
  assert.ok(auditInputs(r)[1]?.includes('Split out of #4375'));
});

test('an audit that exits 1 with a passing finding still passes', () => {
  const r = run({
    input: { apply: false },
    world: { [K.audit]: auditResult('pass', 'effort M within', 1) },
  });
  const scope = stepOf(r, 'scope');
  assert.equal(scope.status, 'passed');
  assert.equal(scope.exitStatus, 0);
  assert.match(scope.reason, /effort M within/u);
});

test('every failed scope input or run refuses with a next action', () => {
  const cases: [string, Scenario, string, number | null][] = [
    [
      'issue read',
      { world: { [K.issueView]: result(1, '', 'HTTP 404: Not Found') } },
      NEXT.stopAndReport,
      1,
    ],
    [
      'issue read that cannot start',
      { world: { [K.issueView]: CANNOT_START } },
      NEXT.helperInstallation,
      null,
    ],
    [
      'issue output',
      { world: { [K.issueView]: result(0, 'not json') } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'empty title',
      { world: { [K.issueView]: result(0, issueJson(DEFAULT_BODY, '  ')) } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'empty body',
      { world: { [K.issueView]: result(0, issueJson(' \n')) } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'empty canonical set',
      { world: { [K.diff]: result(0, ''), [K.untracked]: result(0, '') } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'missing merge base',
      { world: { [K.mergeBase]: result(1, '', '') } },
      NEXT.readGitError,
      1,
    ],
    [
      'base missing from origin',
      { world: { [K.lsRemote]: result(0, '') } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'missing remote-tracking ref',
      { world: { [K.tracking]: result(1, '') } },
      SCOPE_NEXT.staleBase(BASE),
      1,
    ],
    [
      'diff read',
      { world: { [K.diff]: result(128, '', 'fatal: bad revision') } },
      NEXT.readGitError,
      128,
    ],
    [
      'audit that cannot start',
      { world: { [K.audit]: CANNOT_START } },
      NEXT.helperInstallation,
      null,
    ],
    [
      'audit killed by a signal',
      { world: { [K.audit]: KILLED } },
      NEXT.stopAndReport,
      null,
    ],
    [
      'audit output that is not JSON',
      { world: { [K.audit]: result(1, 'not json') } },
      NEXT.stopAndReport,
      1,
    ],
    [
      'audit output that is an array',
      { world: { [K.audit]: result(1, '[]') } },
      NEXT.stopAndReport,
      1,
    ],
    [
      'audit output without a findings array',
      { world: { [K.audit]: result(0, '{"findings":{}}') } },
      NEXT.stopAndReport,
      0,
    ],
    [
      'audit output without the finding',
      {
        world: {
          [K.audit]: result(
            1,
            JSON.stringify({
              findings: [{ id: 'other', result: 'fail', detail: 'x' }],
            }),
          ),
        },
      },
      NEXT.stopAndReport,
      1,
    ],
  ];
  for (const [label, scenario, nextAction, exitStatus] of cases) {
    const r = run(scenario);
    const scope = stepOf(r, 'scope');
    assert.equal(scope.status, 'failed', label);
    assert.equal(scope.nextAction, nextAction, label);
    assert.equal(scope.exitStatus, exitStatus, label);
    assert.equal(r.count(K.gate), 0, label);
    noPush(r);
  }
});

test('a stale base names both SHAs and the fetch next action', () => {
  const stale = run({
    world: {
      [K.tracking]: result(0, `${STALE_SHA}\n`),
      [K.diff]: result(0, nulList(manyPaths(9))),
      [K.audit]: realAudit,
    },
  });
  assertRefused(stale, 'scope', SCOPE_NEXT.staleBase(BASE), { exitStatus: 1 });
  assert.match(stepOf(stale, 'scope').reason, new RegExp(BASE_SHA, 'u'));
  assert.match(stepOf(stale, 'scope').reason, new RegExp(STALE_SHA, 'u'));

  const fresh = run({
    world: { [K.diff]: result(0, nulList(manyPaths(9))), [K.audit]: realAudit },
  });
  assertRefused(fresh, 'scope', SCOPE_NEXT.overrun, { exitStatus: 1 });
  assert.doesNotMatch(stepOf(fresh, 'scope').reason, /stale/u);

  // A stale base only adds paths, so a pass stays a pass.
  const passing = run({
    input: { apply: false },
    world: { [K.tracking]: result(0, `${STALE_SHA}\n`), [K.audit]: realAudit },
  });
  assert.equal(stepOf(passing, 'scope').status, 'passed');

  const missing = run({ world: { [K.tracking]: result(1, '') } });
  assert.match(stepOf(missing, 'scope').reason, new RegExp(BASE_SHA, 'u'));
  assert.match(stepOf(missing, 'scope').reason, /missing/u);
  assert.equal(missing.count(K.mergeBase), 0);
});

test('a body without a coherent S or M marker passes with the audit detail', () => {
  for (const [marker, detail] of [
    ['', 'not applicable: no coherent effort marker'],
    [
      '<!-- idd-skill-effort: L -->',
      'not applicable: effort L is not checked by this rule',
    ],
  ] as const) {
    const r = run({
      input: { apply: false },
      world: {
        [K.issueView]: result(0, issueJson(bodyWithMarker(marker))),
        [K.diff]: result(0, nulList(manyPaths(12))),
        [K.audit]: realAudit,
      },
    });
    const scope = stepOf(r, 'scope');
    assert.equal(scope.status, 'passed', marker);
    assert.ok(scope.reason.includes(detail), scope.reason);
  }
});

test('the marker prefix is the trimmed policy value or the default', () => {
  const prefixes = (policy: unknown): string[] =>
    run({ input: { apply: false }, policy: { ok: true, policy } })
      .calls.filter(
        (call) => call.kind === 'helper' && call.script === AUDIT_SCRIPT,
      )
      .map((call) =>
        call.kind === 'helper'
          ? (argValue(call.args, '--marker-prefix') ?? '')
          : '',
      );
  assert.deepEqual(prefixes(null), ['idd-skill', 'idd-skill']);
  assert.deepEqual(prefixes({}), ['idd-skill', 'idd-skill']);
  assert.deepEqual(prefixes({ markerPrefix: '' }), ['idd-skill', 'idd-skill']);
  assert.deepEqual(prefixes({ markerPrefix: 7 }), ['idd-skill', 'idd-skill']);
  assert.deepEqual(prefixes({ markerPrefix: '  custom  ' }), [
    'custom',
    'custom',
  ]);
});

test('the audits run in the primary checkout and the gh reads in the worktree', () => {
  const r = run({ input: { apply: false } });
  const audits = r.calls.filter(
    (call) => call.kind === 'helper' && call.script === AUDIT_SCRIPT,
  );
  assert.equal(audits.length, 2);
  for (const call of audits) {
    assert.equal(call.cwd, PRIMARY);
    assert.ok(call.kind === 'helper');
    assert.deepEqual(call.args, [
      '--shape',
      'child',
      '--stdin',
      '--marker-prefix',
      'idd-skill',
      '--title',
      ISSUE_TITLE,
    ]);
  }
  const [first, second] = auditInputs(r);
  assert.equal(first, DEFAULT_BODY);
  assert.equal(
    second,
    `## Candidate files\n\n- \`src/scripts/claimed-push.mts\`\n- \`tests/claimed-push.test.mts\`\n\n${DEFAULT_BODY}`,
  );
  const ghCalls = r.calls.filter((call) => call.kind === 'gh');
  assert.equal(ghCalls.length, 2);
  for (const call of ghCalls) {
    assert.equal(call.cwd, WORKTREE);
  }
});

test('the base comes from the policy or, when absent, the live default branch', () => {
  // A null policy and a policy without developmentBranch both read the live default.
  for (const policy of [null, {}]) {
    const r = run({ input: { apply: false }, policy: { ok: true, policy } });
    assert.equal(r.count(K.repoView), 1);
    assert.equal(stepOf(r, 'scope').status, 'passed');
  }

  const develop = {
    [`git ls-remote --heads origin develop`]: result(
      0,
      `${BASE_SHA}\trefs/heads/develop\n`,
    ),
    'git rev-parse --verify --quiet refs/remotes/origin/develop': result(
      0,
      `${BASE_SHA}\n`,
    ),
    'git merge-base refs/remotes/origin/develop HEAD': result(
      0,
      `${BRANCH_POINT}\n`,
    ),
  };
  const configured = run({
    input: { apply: false },
    policy: { ok: true, policy: { developmentBranch: 'develop' } },
    world: develop,
  });
  assert.equal(configured.count(K.repoView), 0);
  assert.equal(stepOf(configured, 'scope').status, 'passed');

  const missing = run({
    policy: { ok: true, policy: { developmentBranch: 'develop' } },
    world: {
      ...develop,
      'git ls-remote --heads origin develop': result(
        0,
        `${BASE_SHA}\trefs/heads/feature/develop\n`,
      ),
    },
  });
  assertRefused(missing, 'scope', NEXT.stopAndReport, { exitStatus: 0 });
  assert.match(stepOf(missing, 'scope').reason, /has no branch develop/u);

  for (const value of ['refs/heads/main', '-main', 'bad name', 42]) {
    const malformed = run({
      policy: { ok: true, policy: { developmentBranch: value } },
    });
    assertRefused(malformed, 'scope', NEXT.stopAndReport, { exitStatus: null });
    assert.equal(malformed.count(K.repoView), 0);
    assert.equal(malformed.count(K.lsRemote), 0);
  }

  for (const live of ['-main', 'main branch', '']) {
    const unsafe = run({ world: { [K.repoView]: result(0, `${live}\n`) } });
    assertRefused(unsafe, 'scope', NEXT.stopAndReport, { exitStatus: 0 });
    assert.equal(unsafe.count(K.lsRemote), 0);
  }
});

test('an unreadable policy refuses the scope step before any read', () => {
  const r = run({
    policy: { ok: false, reason: 'the repository policy is unreadable' },
  });
  assertRefused(r, 'scope', NEXT.stopAndReport, { exitStatus: null });
  assert.match(stepOf(r, 'scope').reason, /unreadable/u);
  assert.equal(r.count(K.issueView), 0);
});

test('readBaseText reports absent, present, and error through the runner', () => {
  const calls: CommandRequest[] = [];
  const answers: Record<string, CommandResult> = {
    'ls-tree -z bp -- absent.md': result(0, ''),
    'ls-tree -z bp -- file.mjs': result(0, `100644 blob ${HEAD}\tfile.mjs\0`),
    'show bp:file.mjs': result(0, '// idd-generated-from: src/file.mts\n'),
    'ls-tree -z bp -- broken.md': result(128, '', 'fatal: not a tree object'),
    'ls-tree -z bp -- unreadable-blob.md': result(
      0,
      `100644 blob ${HEAD}\tunreadable-blob.md\0`,
    ),
    'show bp:unreadable-blob.md': result(128, '', 'fatal: bad object'),
    'ls-tree -z bp -- module': result(0, `160000 commit ${HEAD}\tmodule\0`),
  };
  const reader = makeBaseTextReader((request) => {
    calls.push(request);
    assert.ok(request.kind === 'git');
    assert.equal(request.cwd, WORKTREE);
    const answer = answers[request.args.join(' ')];
    assert.ok(answer, request.args.join(' '));
    return answer;
  });
  assert.deepEqual(reader(WORKTREE, 'bp', 'absent.md'), { status: 'absent' });
  assert.deepEqual(reader(WORKTREE, 'bp', 'file.mjs'), {
    status: 'present',
    text: '// idd-generated-from: src/file.mts\n',
  });
  assert.equal(reader(WORKTREE, 'bp', 'broken.md').status, 'error');
  assert.equal(reader(WORKTREE, 'bp', 'unreadable-blob.md').status, 'error');
  assert.deepEqual(reader(WORKTREE, 'bp', 'module'), {
    status: 'present',
    text: '',
  });
  assert.equal(
    calls.filter((call) => call.kind === 'git' && call.args[0] === 'show')
      .length,
    2,
  );

  const failing = run({
    baseFiles: {
      'tests/claimed-push.test.mts': {
        status: 'error',
        reason: 'git show failed',
      },
    },
  });
  assertRefused(failing, 'scope', NEXT.readGitError, { exitStatus: null });
  assert.match(stepOf(failing, 'scope').reason, /git show failed/u);
});

test('generated copies and manifest targets at the branch point are excluded', () => {
  const manifest = JSON.stringify({
    syncPairs: [
      {
        source: 'idd-template/docs/idd-helper-scripts.md',
        target: 'docs/idd-helper-scripts.md',
      },
    ],
  });
  const present = (text: string): BaseTextRead => ({ status: 'present', text });
  const changed = [
    'scripts/claimed-push.mjs',
    'scripts/new-helper.mjs',
    'docs/idd-helper-scripts.md',
    'src/scripts/claimed-push.mts',
    'old/deleted.md',
    'old/deleted-generated.mjs',
    'docs/late-banner.md',
  ];
  const baseFiles: Record<string, BaseTextRead> = {
    'audit/sync-manifest.json': present(manifest),
    'scripts/claimed-push.mjs': present(
      '#!/usr/bin/env node\n// idd-generated-from: src/scripts/claimed-push.mts\n',
    ),
    'docs/idd-helper-scripts.md': present('# Helper scripts\n'),
    'src/scripts/claimed-push.mts': present(
      '#!/usr/bin/env node\n// idd-generated-from: src/scripts/claimed-push.mts\n',
    ),
    'old/deleted.md': present('# Deleted\n'),
    'old/deleted-generated.mjs': present(
      '// idd-generated-from: src/scripts/old.mts\n',
    ),
    // A banner-shaped example past the first 200 bytes is not a banner.
    'docs/late-banner.md': present(
      `# Layout\n\n${'x'.repeat(240)}\n\n// idd-generated-from: src/scripts/<name>.mts\n`,
    ),
  };
  const r = run({
    input: { apply: false },
    world: {
      [K.diff]: result(0, nulList(changed)),
      [K.untracked]: result(0, nulList(['notes/new.md'])),
    },
    baseFiles,
  });
  assert.equal(stepOf(r, 'scope').status, 'passed');
  assert.deepEqual(canonicalOf(auditInputs(r)[1] ?? ''), [
    'docs/late-banner.md',
    'notes/new.md',
    'old/deleted.md',
    'scripts/new-helper.mjs',
    'src/scripts/claimed-push.mts',
  ]);

  // Without a manifest at the branch point, nothing is a manifest target.
  const noManifest = { ...baseFiles };
  delete noManifest['audit/sync-manifest.json'];
  const bare = run({
    input: { apply: false },
    world: { [K.diff]: result(0, nulList(changed)) },
    baseFiles: noManifest,
  });
  assert.ok(
    canonicalOf(auditInputs(bare)[1] ?? '').includes(
      'docs/idd-helper-scripts.md',
    ),
  );

  const malformed = run({
    world: { [K.diff]: result(0, nulList(changed)) },
    baseFiles: { 'audit/sync-manifest.json': present('{ not json') },
  });
  assertRefused(malformed, 'scope', NEXT.stopAndReport, { exitStatus: null });
});

test('the diff request uses --no-renames and the branch point from git merge-base', () => {
  const r = run({ input: { apply: false } });
  const mergeBase = r.calls.find(
    (call) => call.kind === 'git' && call.args[0] === 'merge-base',
  );
  const diff = r.calls.find(
    (call) => call.kind === 'git' && call.args[0] === 'diff',
  );
  assert.ok(mergeBase?.kind === 'git' && diff?.kind === 'git');
  assert.deepEqual(mergeBase.args, [
    'merge-base',
    `refs/remotes/origin/${BASE}`,
    'HEAD',
  ]);
  assert.deepEqual(diff.args, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    BRANCH_POINT,
  ]);
});

test('the production gh kind runs only the two reads, through ghText', () => {
  const dir = makeScratch();
  const record = join(dir, 'gh-args.jsonl');
  const restoreLoadControl = pinLoadControlOff();
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[2] === '9') {
  process.stderr.write('HTTP 404: Not Found\\n');
  process.exit(4);
}
if (args[0] === 'issue') {
  process.stdout.write(JSON.stringify({ title: 't', body: 'b' }) + '\\n');
  process.exit(0);
}
if (args[0] === 'repo') {
  process.stdout.write('main\\n');
  process.exit(0);
}
process.exit(3);
`,
  );
  try {
    const issueArgs = ['issue', 'view', '4375', '--json', 'title,body'];
    const repoArgs = [
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ];
    const issue = runProductionCommand({
      kind: 'gh',
      args: issueArgs,
      cwd: dir,
    });
    assert.equal(issue.status, 0, issue.error ?? issue.stderr);
    assert.deepEqual(JSON.parse(issue.stdout), { title: 't', body: 'b' });
    const repo = runProductionCommand({ kind: 'gh', args: repoArgs, cwd: dir });
    assert.equal(repo.status, 0, repo.error ?? repo.stderr);
    assert.equal(repo.stdout, 'main');
    const missing = runProductionCommand({
      kind: 'gh',
      args: ['issue', 'view', '9', '--json', 'title,body'],
      cwd: dir,
    });
    assert.equal(missing.status, 4);
    assert.match(missing.stderr, /HTTP 404/u);
    const before = readFileSync(record, 'utf8');
    for (const args of [
      ['api', 'user'],
      ['issue', 'view', '4375', '--json', 'title,body,comments'],
      ['issue', 'view', '04375', '--json', 'title,body'],
      ['issue', 'view', '4375', '--json', 'title,body', '--repo', 'x/y'],
      ['repo', 'view', '--json', 'defaultBranchRef'],
      [],
    ]) {
      const refused = runProductionCommand({ kind: 'gh', args, cwd: dir });
      assert.equal(refused.status, null, args.join(' '));
      assert.equal(refused.signal, null);
      assert.match(refused.error ?? '', /refuses/u);
    }
    assert.equal(readFileSync(record, 'utf8'), before, 'no refused list ran');
    assert.deepEqual(
      before
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [issueArgs, repoArgs, ['issue', 'view', '9', '--json', 'title,body']],
    );
  } finally {
    restore();
    restoreLoadControl();
  }
});

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const ran = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(ran.status, 0, `git ${args.join(' ')}: ${ran.stderr}`);
}

test('readPrimaryPolicy reads the primary checkout, never the worktree copy', () => {
  const root = makeScratch();
  const primary = join(root, 'primary');
  const worktree = join(root, 'primary.issue-1-x');
  const env = fixtureEnv();
  const homedir = makeScratch();
  const identity = [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
  ];
  mkdirSync(primary);
  git(primary, ['init', '-q', '-b', 'main'], env);
  writePolicy(primary, JSON.stringify({ markerPrefix: 'primary-prefix' }));
  git(primary, ['add', '.'], env);
  git(primary, [...identity, 'commit', '-q', '-m', 'init'], env);
  git(primary, ['worktree', 'add', '-q', '-b', 'issue/1-x', worktree], env);
  writePolicy(worktree, JSON.stringify({ markerPrefix: 'branch-prefix' }));

  const read = readPrimaryPolicy(worktree, { env, homedir });
  assert.deepEqual(read, {
    ok: true,
    policy: { markerPrefix: 'primary-prefix' },
  });

  // No file at any tier is a null policy.
  rmSync(join(primary, '.github'), { recursive: true, force: true });
  assert.deepEqual(readPrimaryPolicy(worktree, { env, homedir }), {
    ok: true,
    policy: null,
  });

  writePolicy(primary, '{ not json');
  const unreadable = readPrimaryPolicy(worktree, { env, homedir });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.ok ? '' : unreadable.reason, /unreadable/u);

  const outside = readPrimaryPolicy(makeScratch(), { env, homedir });
  assert.equal(outside.ok, false);
});
