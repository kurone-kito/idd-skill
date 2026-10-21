import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteBranchDeleteVerdict } from '../src/scripts/delete-remote-branch.mts';
import {
  ancestorChain,
  classifyClaimAssert,
  classifyPrimaryRefusal,
  classifyProofEnvelope,
  type DirectoryPrivacy,
  type F4WorktreeBranchDeps,
  type F4WorktreeBranchInput,
  type GitResult,
  isWithinRoot,
  type LstatKind,
  NEXT_ACTIONS,
  parseNulList,
  parseOverwrittenPaths,
  runF4WorktreeBranchSteps,
  type SpawnedResult,
} from '../src/scripts/f4-worktree-branch-steps.mts';

// Fake-dependency coverage of the F4 steps 4 to 6 flow (#4370). Every git
// call, lstat, spawned helper, gh read, lock, and remote deletion is a fake
// here, so no test touches a real repository or GitHub.

const PRIMARY = '/work/primary';
const WORKTREE = '/work/issue-4370';
const BRANCH = 'issue/4370-feat-merge-gate-f4-worktree-branch';
const CLAIM = '696739a9-a2be-4b53-9f7f-6fde6c11452e';
const AGENT = 'claude-23c12b20';
const TIP = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const F2 = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const STATE_ROOT = '/state';
const PRESERVE_DESTINATION =
  '/state/idd-skill/f4-preserved/4370-20261021T103000Z';

type Args = readonly string[];

interface Route {
  readonly match: (args: Args) => boolean;
  readonly result: GitResult;
}

const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): GitResult => ({
  status: 1,
  stdout,
  stderr,
});

const input = (
  overrides: Partial<F4WorktreeBranchInput> = {},
): F4WorktreeBranchInput => ({
  issueNumber: 4370,
  claimId: CLAIM,
  agentId: AGENT,
  worktree: WORKTREE,
  primaryRoot: PRIMARY,
  apply: true,
  ...overrides,
});

function claimOk(): SpawnedResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      state: 'already_owned',
      action: 'keep',
      reason: 'claim-id-match',
      claim_id_checked: CLAIM,
      active_claim: { agent_id: AGENT, claim_id: CLAIM, branch: BRANCH },
    }),
  };
}

function proofProceed(overrides: Record<string, unknown> = {}): SpawnedResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      verdict: 'proceed',
      reason: 'reusable',
      proof: {
        pr: 12,
        claim: CLAIM,
        branch: BRANCH,
        f2: F2,
        branchTip: TIP,
        merge: MERGE,
        head: HEAD,
        ...overrides,
      },
    }),
  };
}

function worktreeListing(additionalPaths: readonly string[] = []): string {
  const record = (path: string, branch: string): string =>
    `worktree ${path}\0HEAD ${OTHER}\0branch refs/heads/${branch}\0\0`;
  return (
    record(PRIMARY, 'main') +
    record(WORKTREE, BRANCH) +
    additionalPaths
      .map((path, index) => record(path, `issue/other-${index}`))
      .join('')
  );
}

/** The healthy path: every check passes, and the branch is merged. */
function healthyRoutes(): Route[] {
  return [
    { match: (a) => a[0] === 'check-ref-format', result: ok() },
    { match: (a) => a[0] === 'fetch', result: ok() },
    {
      match: (a) => a[0] === 'worktree' && a[1] === 'list',
      result: ok(worktreeListing()),
    },
    { match: (a) => a[0] === 'show-ref', result: ok() },
    { match: (a) => a[0] === 'switch', result: ok() },
    { match: (a) => a[0] === '-c' && a.includes('merge'), result: ok() },
    {
      match: (a) => a[0] === 'rev-parse' && a.includes(`refs/heads/${BRANCH}`),
      result: ok(`${TIP}\n`),
    },
    {
      match: (a) => a[0] === '-C' && a[2] === 'status',
      result: ok(''),
    },
    {
      match: (a) => a[0] === '-C' && a[2] === 'submodule',
      result: ok(''),
    },
    {
      match: (a) => a[0] === '-C' && a[2] === 'ls-files' && a.includes('-z'),
      result: ok('README.md\0'),
    },
    { match: (a) => a[0] === 'worktree' && a[1] === 'remove', result: ok() },
    { match: (a) => a[0] === 'branch' && a[1] === '-d', result: ok() },
  ];
}

interface Harness {
  readonly deps: F4WorktreeBranchDeps;
  readonly gitCalls: { args: Args; cwd: string }[];
  readonly remoteCalls: string[];
  readonly claimCalls: string[];
  readonly proofCalls: number[];
  readonly lockCalls: number[];
  readonly mkdirCalls: string[];
  readonly mkdirModes: number[];
  readonly renameCalls: string[][];
}

function remoteVerdict(
  action: RemoteBranchDeleteVerdict['action'],
  mode: 'dry-run' | 'apply',
  detail = `${action} detail`,
): RemoteBranchDeleteVerdict {
  return {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    mode,
    status:
      action === 'deleted' ||
      action === 'would-delete' ||
      action === 'already-absent'
        ? 'complete'
        : 'hold',
    action,
    branch: BRANCH,
    expectedSha: HEAD,
    observedSha: HEAD,
    detail,
  };
}

interface HarnessOptions {
  readonly routes?: Route[];
  readonly lstat?: (path: string) => LstatKind;
  readonly claims?: SpawnedResult[];
  readonly proof?: SpawnedResult;
  readonly base?: string | null;
  readonly autoDelete?: boolean | null;
  readonly remote?: (
    mode: 'dry-run' | 'apply',
    branch: string,
    sha: string,
  ) => RemoteBranchDeleteVerdict | null;
  readonly lockBusy?: boolean;
  readonly statusResults?: readonly GitResult[];
  readonly nestedWorktrees?: readonly string[];
  readonly stateRoot?: string;
  readonly now?: () => Date;
  readonly directoryPrivacy?: (path: string) => DirectoryPrivacy;
  readonly mkdir?: (path: string) => void;
  readonly rename?: (source: string, destination: string) => void;
}

/** Build the deps: git answers by the first matching route, else success. */
function harness(options: HarnessOptions = {}): Harness {
  const routes = [...(options.routes ?? healthyRoutes())];
  const gitCalls: { args: Args; cwd: string }[] = [];
  const remoteCalls: string[] = [];
  const claimCalls: string[] = [];
  const proofCalls: number[] = [];
  const lockCalls: number[] = [];
  const statusResults = [...(options.statusResults ?? [])];
  const mkdirCalls: string[] = [];
  const mkdirModes: number[] = [];
  const renameCalls: string[][] = [];
  const createdDirectories = new Set<string>();
  const renamedDirectories = new Set<string>();
  let statusIndex = 0;
  const claims = options.claims ?? [claimOk()];
  const lstat = (path: string): LstatKind => {
    if (renamedDirectories.has(path) || createdDirectories.has(path)) {
      return 'directory';
    }
    if (options.lstat) return options.lstat(path);
    if (path === PRESERVE_DESTINATION) return 'absent';
    if (path === STATE_ROOT) return 'directory';
    if (
      path === `${STATE_ROOT}/idd-skill` ||
      path === `${STATE_ROOT}/idd-skill/f4-preserved`
    ) {
      return 'absent';
    }
    return 'directory';
  };
  const deps: F4WorktreeBranchDeps = {
    lstat,
    realpath: (path) => path,
    stateRoot: options.stateRoot ?? STATE_ROOT,
    now: options.now ?? (() => new Date('2026-10-21T10:30:00.000Z')),
    inspectDirectoryPrivacy: (path) =>
      options.directoryPrivacy?.(path) ?? 'private',
    ensurePrivateDirectory: (path) => {
      if ((options.directoryPrivacy?.(path) ?? 'private') === 'unsafe') {
        throw new Error('directory is not private');
      }
    },
    mkdir: (path, mode) => {
      mkdirCalls.push(path);
      mkdirModes.push(mode);
      createdDirectories.add(path);
      options.mkdir?.(path);
    },
    rename: (source, destination) => {
      renameCalls.push([source, destination]);
      options.rename?.(source, destination);
      renamedDirectories.add(destination);
    },
    git: (args, cwd) => {
      gitCalls.push({ args: [...args], cwd });
      if (args[0] === '-C' && args[2] === 'status') {
        const result = statusResults[statusIndex];
        statusIndex += 1;
        if (result !== undefined) return result;
      }
      if (
        args[0] === 'worktree' &&
        args[1] === 'list' &&
        options.nestedWorktrees !== undefined
      ) {
        return ok(worktreeListing(options.nestedWorktrees));
      }
      const route = routes.find((candidate) => candidate.match(args));
      return route ? route.result : ok();
    },
    assertClaim: (worktree) => {
      claimCalls.push(worktree);
      const index = Math.min(claimCalls.length - 1, claims.length - 1);
      return claims[index] as SpawnedResult;
    },
    proofDryRun: () => {
      proofCalls.push(proofCalls.length + 1);
      return options.proof ?? proofProceed();
    },
    prBaseRef: () => (options.base === undefined ? 'main' : options.base),
    deleteBranchOnMerge: () =>
      options.autoDelete === undefined ? true : options.autoDelete,
    remoteDelete: (mode, branch, sha) => {
      remoteCalls.push(`${mode}:${branch}:${sha}`);
      if (options.remote) {
        return options.remote(mode, branch, sha);
      }
      return remoteVerdict(
        mode === 'dry-run' ? 'would-delete' : 'deleted',
        mode,
      );
    },
    withCloneLock: (run) => {
      lockCalls.push(1);
      if (options.lockBusy) {
        return { acquired: false };
      }
      return { acquired: true, value: run() };
    },
  };
  return {
    deps,
    gitCalls,
    remoteCalls,
    claimCalls,
    proofCalls,
    lockCalls,
    mkdirCalls,
    mkdirModes,
    renameCalls,
  };
}

function stepsOf(report: {
  steps: readonly { step: string; status: string }[];
}): string[] {
  return report.steps.map((entry) => `${entry.step}:${entry.status}`);
}

test('the healthy apply path completes every step in order', () => {
  const h = harness();
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.equal(report.failedStep, null);
  assert.deepEqual(report.notRunSteps, []);
  assert.deepEqual(stepsOf(report), [
    'path-check:passed',
    'claim-check:passed',
    'proof-check:passed',
    'step-4:done',
    'step-5:done',
    'claim-check:passed',
    'step-6:skipped',
  ]);
  const removal = h.gitCalls.find(
    (c) => c.args[0] === 'worktree' && c.args[1] === 'remove',
  );
  assert.deepEqual(removal?.args, ['worktree', 'remove', WORKTREE]);
  assert.equal(
    h.gitCalls.some((c) => c.args.includes('--force')),
    false,
    'no git call may carry --force',
  );
});

test('a dry run mutates nothing and reports the steps it would run', () => {
  const h = harness({ autoDelete: false });
  const report = runF4WorktreeBranchSteps(input({ apply: false }), h.deps);
  assert.equal(report.status, 'dry-run');
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(stepsOf(report).slice(3, 4), ['step-4:would-run']);
  const mutating = h.gitCalls.filter((c) => {
    const [first, second] = c.args;
    return (
      first === 'fetch' ||
      first === 'switch' ||
      (first === '-c' && c.args.includes('merge')) ||
      (first === 'worktree' && second === 'remove') ||
      (first === 'branch' && second === '-d')
    );
  });
  assert.deepEqual(mutating, []);
  assert.deepEqual(h.remoteCalls, [`dry-run:${BRANCH}:${HEAD}`]);
  assert.equal(h.lockCalls.length, 0, 'a dry run takes no clone lock');
});

test('a dry run holds on a development branch in use, as apply does', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/scratch\0\0worktree /work/other-holder\0HEAD ${OTHER}\0branch refs/heads/main\0\0`;
  const h = harness({
    autoDelete: false,
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
    ],
  });
  const report = runF4WorktreeBranchSteps(input({ apply: false }), h.deps);
  assert.equal(report.reason, 'development-branch-in-use');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'fetch'),
    false,
    'a dry run never fetches',
  );
});

test('a dry run reports an unreadable base ref as apply does', () => {
  const report = runF4WorktreeBranchSteps(
    input({ apply: false }),
    harness({ base: null }).deps,
  );
  assert.equal(report.reason, 'base-ref-unreadable');
});

test('the proof dry run is the only proof read, and nothing posts a proof', () => {
  const h = harness();
  runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(h.proofCalls.length, 1);
});

test('a lost claim before step 4 holds before any other read', () => {
  const claimLost = {
    exitCode: 1,
    stdout: JSON.stringify({ state: 'non_inheritable', action: 'stop' }),
  };
  const h = harness({ claims: [claimLost] });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'hold');
  assert.equal(report.reason, 'claim-lost');
  assert.equal(report.nextAction, NEXT_ACTIONS['claim-lost']);
  assert.equal(h.proofCalls.length, 0);
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'fetch'),
    false,
  );
});

test('owner evidence required holds with its own code', () => {
  const needed = {
    exitCode: 1,
    stdout: JSON.stringify({
      state: 'owner_evidence_required',
      action: 'stop',
    }),
  };
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({ claims: [needed] }).deps,
  );
  assert.equal(report.reason, 'owner-evidence-required');
});

test('a symlink on the worktree path holds before any claim or git call', () => {
  const h = harness({
    lstat: (path) => (path === WORKTREE ? 'symlink' : 'directory'),
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'symlink-path');
  assert.equal(h.claimCalls.length, 0);
  assert.equal(h.gitCalls.length, 0);
});

test('the primary worktree is never the removal target', () => {
  const report = runF4WorktreeBranchSteps(
    input({ worktree: PRIMARY }),
    harness().deps,
  );
  assert.equal(report.reason, 'inconsistent-worktree-state');
});

test('each proof hold keeps its reason code and next action', () => {
  const reasons = [
    'claim-or-lock',
    'pr-state',
    'ref-read',
    'marker-read-failed',
    'branch-absent',
    'conflicting-marker',
    'watermark-unauthenticated',
    'claim-activation-unknown',
  ] as const;
  for (const reason of reasons) {
    const proof = {
      exitCode: 1,
      stdout: JSON.stringify({
        verdict: reason === 'claim-or-lock' ? 'stop' : 'hold',
        reason,
      }),
    };
    const report = runF4WorktreeBranchSteps(input(), harness({ proof }).deps);
    assert.equal(report.status, 'hold', reason);
    assert.equal(report.reason, reason);
    assert.equal(report.nextAction, NEXT_ACTIONS[reason]);
  }
});

test('a missing proof holds with proof-missing and points at step 3', () => {
  const proof = {
    exitCode: 1,
    stdout: JSON.stringify({ verdict: 'post', reason: null }),
  };
  const report = runF4WorktreeBranchSteps(input(), harness({ proof }).deps);
  assert.equal(report.reason, 'proof-missing');
  assert.match(report.nextAction ?? '', /step 3/u);
});

test('a proceed verdict with a non-zero exit is not trusted', () => {
  const proof = { exitCode: 1, stdout: proofProceed().stdout };
  const report = runF4WorktreeBranchSteps(input(), harness({ proof }).deps);
  assert.equal(report.reason, 'proof-unreadable');
});

test('an unregistered claimed worktree holds with proof-worktree-missing and its cause', () => {
  const proof = {
    exitCode: 1,
    stdout: '',
    stderr:
      '--worktree /work/gone is not a worktree that git worktree list --porcelain registers for this repository\n',
  };
  const report = runF4WorktreeBranchSteps(input(), harness({ proof }).deps);
  assert.equal(report.reason, 'proof-worktree-missing');
  assert.equal(report.nextAction, NEXT_ACTIONS['proof-worktree-missing']);
  assert.match(report.steps[2]?.detail ?? '', /registers for this repository/u);
});

test('an unreadable proof envelope holds with proof-unreadable', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({ proof: { exitCode: 1, stdout: 'not json' } }).deps,
  );
  assert.equal(report.reason, 'proof-unreadable');
});

test('a proof for another branch conflicts with the claim', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      proof: proofProceed({ branch: 'issue/other' }),
    }).deps,
  );
  assert.equal(report.reason, 'conflicting-marker');
});

test('a lock that another session holds stops the run with lock-busy', () => {
  const h = harness({ lockBusy: true });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'lock-busy');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'fetch'),
    false,
  );
});

test('an exception from a dependency reports a failed step, not a throw', () => {
  const h = harness();
  const deps: F4WorktreeBranchDeps = {
    ...h.deps,
    git: (args, cwd) => {
      if (args[0] === 'fetch') {
        throw new Error('network reset during fetch');
      }
      return h.deps.git(args, cwd);
    },
  };
  const report = runF4WorktreeBranchSteps(input(), deps);
  assert.equal(report.status, 'failed');
  assert.equal(report.failedStep, 'step-4');
  assert.deepEqual(report.notRunSteps, [
    'step-5',
    'claim-check (before-step-6)',
    'step-6',
  ]);
  assert.match(report.nextAction ?? '', /network reset/u);
});

test('a failed fetch holds at step 4 and changes nothing', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a[0] === 'fetch',
          result: fail('fatal: unable to access remote'),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'fetch-failed');
  assert.equal(report.failedStep, null);
});

test('an unreadable base ref holds at step 4', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({ base: null }).deps,
  );
  assert.equal(report.reason, 'base-ref-unreadable');
});

test('an unreadable development branch ref holds instead of reading as absent', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a[0] === 'show-ref' && a.includes('refs/heads/main'),
          result: { status: 128, stdout: '', stderr: 'fatal: bad object' },
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'primary-update-failed');
});

test('an unreadable worktree list fails closed as inconsistent-worktree-state', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a[0] === 'worktree' && a[1] === 'list',
          result: fail('fatal: not a repository'),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'inconsistent-worktree-state');
  assert.equal(report.failedStep, null);
});

test('a development branch name that starts with a dash holds base-ref-unreadable', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({ base: '-x' }).deps,
  );
  assert.equal(report.reason, 'base-ref-unreadable');
});

test('a development branch checked out elsewhere holds before the switch', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/scratch\0\0worktree /work/other-holder\0HEAD ${OTHER}\0branch refs/heads/main\0\0`;
  const h = harness({
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'development-branch-in-use');
  assert.match(report.steps[3]?.detail ?? '', /other-holder/u);
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'switch'),
    false,
  );
});

test('the probed switch refusal for a branch used by a worktree holds in use', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a[0] === 'switch',
          result: fail(
            `fatal: 'main' is already used by worktree at '/work/x'`,
          ),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'development-branch-in-use');
});

test('the probed diverged refusal holds with development-branch-diverged', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a.includes('merge'),
          result: fail(
            "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.",
          ),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'development-branch-diverged');
});

test('the probed tracked-change refusal holds with primary-worktree-dirty', () => {
  const text =
    'error: Your local changes to the following files would be overwritten by merge:\n\tbase.txt\nPlease commit your changes or stash them before you merge.\nAborting';
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [{ match: (a) => a.includes('merge'), result: fail(text) }],
    }).deps,
  );
  assert.equal(report.reason, 'primary-worktree-dirty');
});

test('an untracked overwrite of an ignored file holds with primary-ignored-overwrite', () => {
  const text =
    'error: The following untracked working tree files would be overwritten by merge:\n\tign.txt\nPlease move or remove them before you merge.\nAborting';
  const h = harness({
    routes: [
      { match: (a) => a.includes('merge'), result: fail(text) },
      { match: (a) => a[0] === 'check-ignore', result: ok('ign.txt\n') },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'primary-ignored-overwrite');
});

test('an untracked overwrite of a non-ignored file stays primary-worktree-dirty', () => {
  const text =
    'error: The following untracked working tree files would be overwritten by merge:\n\tnote.txt\nAborting';
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        { match: (a) => a.includes('merge'), result: fail(text) },
        {
          match: (a) => a[0] === 'check-ignore',
          result: { status: 1, stdout: '', stderr: '' },
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'primary-worktree-dirty');
});

test('an unclassified refusal holds with primary-update-failed', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a.includes('merge'),
          result: fail('fatal: something new'),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'primary-update-failed');
});

test('a dirty worktree holds at step 5 and removes nothing', () => {
  const h = harness({
    routes: [
      ...healthyRoutes().slice(0, 7),
      {
        match: (a) => a[0] === '-C' && a[2] === 'status',
        result: ok('?? scratch.txt\n'),
      },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'dirty-worktree');
  assert.equal(report.failedStep, null);
  assert.deepEqual(report.notRunSteps, [
    'claim-check (before-step-6)',
    'step-6',
  ]);
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    false,
  );
});

test('an ignored-only file in the worktree still holds dirty-worktree', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 7),
        {
          match: (a) => a[0] === '-C' && a[2] === 'status',
          result: ok('!! build/\n'),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'dirty-worktree');
});

test('a lone ignored node_modules directory moves after the claim check', () => {
  const h = harness({
    statusResults: [ok('!! node_modules/\n'), ok('')],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.deepEqual(h.renameCalls, [
    [`${WORKTREE}/node_modules`, PRESERVE_DESTINATION],
  ]);
  assert.deepEqual(h.mkdirCalls, [
    `${STATE_ROOT}/idd-skill`,
    `${STATE_ROOT}/idd-skill/f4-preserved`,
  ]);
  assert.deepEqual(h.mkdirModes, [0o700, 0o700]);
  assert.equal(h.claimCalls.length, 5);
  assert.equal(
    report.steps.find((step) => step.step === 'step-5')?.detail,
    `node_modules/ was preserved at ${PRESERVE_DESTINATION}`,
  );
});

test('an unsafe node_modules directory holds before creating the destination', () => {
  const h = harness({
    statusResults: [ok('!! node_modules/\n')],
    directoryPrivacy: (path) =>
      path === `${WORKTREE}/node_modules` ? 'unsafe' : 'private',
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'dirty-worktree');
  assert.match(report.steps.at(-1)?.detail ?? '', /ownership or privacy/);
  assert.deepEqual(h.mkdirCalls, []);
  assert.deepEqual(h.renameCalls, []);
});

test('a dry run reports the node_modules destination without creating or moving it', () => {
  const h = harness({
    statusResults: [ok('!! node_modules/\n')],
  });
  const report = runF4WorktreeBranchSteps(input({ apply: false }), h.deps);
  assert.equal(report.status, 'dry-run');
  assert.match(
    report.steps.find((step) => step.step === 'step-5')?.detail ?? '',
    new RegExp(PRESERVE_DESTINATION.replaceAll('/', '\\/')),
  );
  assert.deepEqual(h.mkdirCalls, []);
  assert.deepEqual(h.renameCalls, []);
});

test('a lone ignored node_modules path that is not a real directory still holds', () => {
  for (const kind of ['symlink', 'file'] as const) {
    const h = harness({
      statusResults: [ok('!! node_modules/\n')],
      lstat: (path) =>
        path === `${WORKTREE}/node_modules`
          ? kind
          : path === PRESERVE_DESTINATION
            ? 'absent'
            : 'directory',
    });
    const report = runF4WorktreeBranchSteps(input(), h.deps);
    assert.equal(report.reason, 'dirty-worktree');
    assert.match(
      report.steps.at(-1)?.detail ?? '',
      /did not move node_modules/,
    );
    assert.deepEqual(h.renameCalls, []);
  }
});

test('a registered worktree inside node_modules prevents the move', () => {
  const nested = `${WORKTREE}/node_modules/nested-checkout`;
  const h = harness({
    statusResults: [ok('!! node_modules/\n')],
    nestedWorktrees: [nested],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'dirty-worktree');
  assert.match(report.steps.at(-1)?.detail ?? '', new RegExp(nested));
  assert.match(report.steps.at(-1)?.detail ?? '', /did not move node_modules/);
  assert.deepEqual(h.renameCalls, []);
});

test('a claim lost after the move keeps the preserved tree and worktree', () => {
  const lost = {
    exitCode: 0,
    stdout: JSON.stringify({ state: 'disputed', action: 'stop' }),
  };
  const h = harness({
    statusResults: [ok('!! node_modules/\n'), ok('')],
    claims: [claimOk(), claimOk(), claimOk(), lost],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'claim-lost');
  assert.match(report.steps.at(-1)?.detail ?? '', /preserving node_modules/);
  assert.equal(
    h.gitCalls.some(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'remove',
    ),
    false,
  );
  assert.deepEqual(h.renameCalls, [
    [`${WORKTREE}/node_modules`, PRESERVE_DESTINATION],
  ]);
});

test('a skip-worktree entry holds dirty-worktree, since git status cannot vouch for it', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 9),
        {
          match: (a) =>
            a[0] === '-C' && a[2] === 'ls-files' && a.includes('-v'),
          result: ok('S README.md\n'),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'dirty-worktree');
});

test('a populated submodule holds with submodule-worktree and an uninitialized one does not', () => {
  const populated = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 8),
        {
          match: (a) => a[0] === '-C' && a[2] === 'submodule',
          result: ok(` ${OTHER} vendor/lib (heads/main)\n`),
        },
      ],
    }).deps,
  );
  assert.equal(populated.reason, 'submodule-worktree');
  const uninitialized = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 8),
        {
          match: (a) => a[0] === '-C' && a[2] === 'submodule',
          result: ok(`-${OTHER} vendor/lib\n`),
        },
      ],
    }).deps,
  );
  assert.equal(uninitialized.status, 'complete');
});

test('a tracked symlink whose target leaves the worktree holds symlink-path', () => {
  const h = harness({
    routes: [
      ...healthyRoutes().slice(0, 9),
      {
        match: (a) => a[0] === '-C' && a[2] === 'ls-files' && a.includes('-z'),
        result: ok('link\0'),
      },
    ],
    lstat: (path) => (path === `${WORKTREE}/link` ? 'symlink' : 'directory'),
  });
  // The fake realpath resolves the link outside the worktree.
  const withTarget: F4WorktreeBranchDeps = {
    ...h.deps,
    realpath: (p) => (p === `${WORKTREE}/link` ? '/outside/dir' : p),
  };
  const report = runF4WorktreeBranchSteps(input(), withTarget);
  assert.equal(report.reason, 'symlink-path');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    false,
  );
});

test('a tracked symlink that stays inside the worktree is allowed', () => {
  const h = harness({
    routes: [
      ...healthyRoutes().slice(0, 9),
      {
        match: (a) => a[0] === '-C' && a[2] === 'ls-files' && a.includes('-z'),
        result: ok('alias\0'),
      },
    ],
    lstat: (path) => (path === `${WORKTREE}/alias` ? 'symlink' : 'directory'),
  });
  const withTarget: F4WorktreeBranchDeps = {
    ...h.deps,
    realpath: (p) => (p === `${WORKTREE}/alias` ? `${WORKTREE}/README.md` : p),
  };
  assert.equal(
    runF4WorktreeBranchSteps(input(), withTarget).status,
    'complete',
  );
});

test('both absent with a branch tip that differs from the proof holds branch-tip-mismatch', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/main\0\0`;
  const h = harness({
    lstat: (path) => (path === WORKTREE ? 'absent' : 'directory'),
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
      {
        match: (a) => a[0] === 'show-ref' && a.includes(`refs/heads/${BRANCH}`),
        result: ok(),
      },
      { match: (a) => a[0] === 'rev-parse', result: ok(`${OTHER}\n`) },
    ],
  });
  assert.equal(
    runF4WorktreeBranchSteps(input(), h.deps).reason,
    'branch-tip-mismatch',
  );
});

test('a worktree whose branch ref is missing holds branch-tip-mismatch', () => {
  const h = harness({
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(worktreeListing()),
      },
      { match: (a) => a[0] === 'rev-parse', result: fail('') },
    ],
  });
  assert.equal(
    runF4WorktreeBranchSteps(input(), h.deps).reason,
    'branch-tip-mismatch',
  );
});

test('a worktree registered on another branch holds inconsistent-worktree-state', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/main\0\0worktree ${WORKTREE}\0HEAD ${OTHER}\0branch refs/heads/issue/other\0\0`;
  const h = harness({
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
    ],
  });
  assert.equal(
    runF4WorktreeBranchSteps(input(), h.deps).reason,
    'inconsistent-worktree-state',
  );
});

test('a registration marked prunable while its path is missing holds inconsistent-worktree-state', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/main\0\0worktree ${WORKTREE}\0HEAD ${OTHER}\0branch refs/heads/${BRANCH}\0prunable gitdir file points to non-existent location\0\0`;
  const h = harness({
    lstat: (path) => (path === WORKTREE ? 'absent' : 'directory'),
    routes: [
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
    ],
  });
  assert.equal(
    runF4WorktreeBranchSteps(input(), h.deps).reason,
    'inconsistent-worktree-state',
  );
});

test('a branch tip that differs from the proof holds with branch-tip-mismatch', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 6),
        { match: (a) => a[0] === 'rev-parse', result: ok(`${OTHER}\n`) },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'branch-tip-mismatch');
});

test('a path that exists but is not registered holds with inconsistent-worktree-state', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/main\0\0`;
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        {
          match: (a) => a[0] === 'worktree' && a[1] === 'list',
          result: ok(listing),
        },
      ],
    }).deps,
  );
  assert.equal(report.reason, 'inconsistent-worktree-state');
});

test('both absent skips the removal and completes when the branch is absent', () => {
  const listing = `worktree ${PRIMARY}\0HEAD ${OTHER}\0branch refs/heads/main\0\0`;
  const h = harness({
    lstat: (path) => (path === WORKTREE ? 'absent' : 'directory'),
    routes: [
      { match: (a) => a[0] === 'check-ref-format', result: ok() },
      { match: (a) => a[0] === 'fetch', result: ok() },
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok(listing),
      },
      {
        match: (a) => a[0] === 'show-ref' && a.includes(`refs/heads/${BRANCH}`),
        result: fail(''),
      },
      { match: (a) => a[0] === 'rev-parse', result: fail('') },
      { match: (a) => a[0] === 'switch', result: ok() },
      { match: (a) => a[0] === '-c' && a.includes('merge'), result: ok() },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    false,
  );
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'branch' && c.args[1] === '-d'),
    false,
  );
});

test('a refused branch delete keeps the branch when its tip equals the proof head', () => {
  // The tip is HEAD everywhere, so the proof names HEAD as both tip and head.
  const h = harness({
    proof: proofProceed({ branchTip: HEAD }),
    routes: [
      ...healthyRoutes().slice(0, 6),
      { match: (a) => a[0] === 'rev-parse', result: ok(`${HEAD}\n`) },
      {
        match: (a) => a[0] === 'branch' && a[1] === '-d',
        result: fail('error: not fully merged'),
      },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.equal(
    report.steps.find((entry) => entry.step === 'step-5')?.status,
    'done',
  );
});

test('a refused branch delete with a different tip holds with local-branch-unmerged-commits', () => {
  const h = harness({
    routes: [
      ...healthyRoutes().slice(0, 6),
      { match: (a) => a[0] === 'rev-parse', result: ok(`${TIP}\n`) },
      {
        match: (a) => a[0] === 'branch' && a[1] === '-d',
        result: fail('error: not fully merged'),
      },
    ],
  });
  // The proof names HEAD as the head, while the local tip is TIP: refusal holds.
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'local-branch-unmerged-commits');
});

test('a refused worktree removal fails at step 5 and names the steps not yet run', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({
      routes: [
        ...healthyRoutes().slice(0, 10),
        {
          match: (a) => a[0] === 'worktree' && a[1] === 'remove',
          result: fail('fatal: contains modified files'),
        },
      ],
    }).deps,
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.failedStep, 'step-5');
  assert.equal(report.reason, 'worktree-remove-refused');
  assert.deepEqual(report.notRunSteps, [
    'claim-check (before-step-6)',
    'step-6',
  ]);
});

test('a claim lost while waiting for the clone lock holds before the fetch', () => {
  const lost = {
    exitCode: 1,
    stdout: JSON.stringify({ state: 'non_inheritable', action: 'stop' }),
  };
  const h = harness({ claims: [claimOk(), lost] });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'claim-lost');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'fetch'),
    false,
  );
});

test('a lost claim before removal stops before the worktree is removed', () => {
  const h = harness({
    claims: [
      claimOk(),
      {
        exitCode: 1,
        stdout: JSON.stringify({ state: 'non_inheritable', action: 'stop' }),
      },
    ],
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'claim-lost');
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    false,
  );
});

test('a claim lost before step 6 holds and makes no remote call', () => {
  const h = harness({
    claims: [
      claimOk(),
      claimOk(),
      claimOk(),
      {
        exitCode: 1,
        stdout: JSON.stringify({ state: 'non_inheritable', action: 'stop' }),
      },
    ],
    autoDelete: false,
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'claim-lost');
  assert.deepEqual(h.remoteCalls, []);
});

test('an unreadable delete_branch_on_merge setting holds', () => {
  const report = runF4WorktreeBranchSteps(
    input(),
    harness({ autoDelete: null }).deps,
  );
  assert.equal(report.reason, 'delete-setting-unreadable');
});

test('a false setting runs the remote dry run, then the apply with the proof head', () => {
  const h = harness({ autoDelete: false });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.deepEqual(h.remoteCalls, [
    `dry-run:${BRANCH}:${HEAD}`,
    `apply:${BRANCH}:${HEAD}`,
  ]);
});

test('an already absent remote branch completes without an apply', () => {
  const h = harness({
    autoDelete: false,
    remote: () => remoteVerdict('already-absent', 'dry-run'),
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'complete');
  assert.deepEqual(h.remoteCalls, [`dry-run:${BRANCH}:${HEAD}`]);
});

test('a remote helper hold reports its own action code and detail', () => {
  const h = harness({
    autoDelete: false,
    remote: (mode) =>
      mode === 'dry-run'
        ? remoteVerdict(
            'remote-sha-mismatch',
            'dry-run',
            'the remote moved past the proof head',
          )
        : null,
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.reason, 'remote-sha-mismatch');
  assert.equal(report.nextAction, 'the remote moved past the proof head');
});

test('a failure at step 6 after step 5 succeeded names the failed step', () => {
  const h = harness({
    autoDelete: false,
    remote: (mode) => {
      if (mode === 'apply') {
        throw new Error('network reset during the delete');
      }
      return remoteVerdict('would-delete', 'dry-run');
    },
  });
  const report = runF4WorktreeBranchSteps(input(), h.deps);
  assert.equal(report.status, 'failed');
  assert.equal(report.failedStep, 'step-6');
  assert.deepEqual(report.notRunSteps, []);
  assert.equal(
    h.gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    true,
    'step 5 completed before the failure',
  );
});

test('the removal is always the claimed path, so an unrelated worktree is untouched', () => {
  const h = harness();
  runF4WorktreeBranchSteps(input(), h.deps);
  const removals = h.gitCalls.filter(
    (c) => c.args[0] === 'worktree' && c.args[1] === 'remove',
  );
  assert.equal(removals.length, 1);
  assert.equal(removals[0]?.args[2], WORKTREE);
});

test('classifyClaimAssert keeps owner_evidence_required distinct from claim-lost', () => {
  assert.deepEqual(classifyClaimAssert(claimOk(), CLAIM, AGENT), {
    ok: true,
    branch: BRANCH,
  });
  assert.deepEqual(
    classifyClaimAssert(
      { exitCode: 1, stdout: '{"state":"owner_evidence_required"}' },
      CLAIM,
      AGENT,
    ),
    { ok: false, code: 'owner-evidence-required' },
  );
  assert.deepEqual(
    classifyClaimAssert(
      { exitCode: 0, stdout: '{"state":"already_owned"' },
      CLAIM,
      AGENT,
    ),
    { ok: false, code: 'claim-lost' },
  );
  assert.deepEqual(classifyClaimAssert(claimOk(), 'other-claim', AGENT), {
    ok: false,
    code: 'claim-lost',
  });
});

test('classifyProofEnvelope accepts only the full proof values', () => {
  assert.equal(classifyProofEnvelope(proofProceed(), CLAIM).ok, true);
  assert.deepEqual(
    classifyProofEnvelope(proofProceed({ head: 'short' }), CLAIM),
    { ok: false, code: 'proof-unreadable' },
  );
  assert.deepEqual(
    classifyProofEnvelope({ exitCode: 1, stdout: '{"verdict":"post"}' }, CLAIM),
    { ok: false, code: 'proof-missing' },
  );
});

test('classifyPrimaryRefusal maps the two probed messages', () => {
  assert.deepEqual(
    classifyPrimaryRefusal('fatal: Not possible to fast-forward, aborting.'),
    { code: 'development-branch-diverged' },
  );
  assert.equal(classifyPrimaryRefusal('something else entirely'), null);
});

test('parseOverwrittenPaths reads the indented path lines after the header', () => {
  assert.deepEqual(
    parseOverwrittenPaths(
      'error: The following untracked working tree files would be overwritten by merge:\n\tign.txt\n\tdir/a b.txt\nPlease move or remove them before you merge.\n',
    ),
    ['ign.txt', 'dir/a b.txt'],
  );
});

test('the path helpers keep the walk inside the root', () => {
  assert.equal(isWithinRoot('/a/b', '/a/b/c'), true);
  assert.equal(isWithinRoot('/a/b', '/a/b'), true);
  assert.equal(isWithinRoot('/a/b', '/a/bc'), false);
  assert.equal(isWithinRoot('/a/b', '/a/b/../x'), false);
  assert.deepEqual(ancestorChain('/a/b/c'), ['/', '/a', '/a/b', '/a/b/c']);
  assert.deepEqual(parseNulList('x\0y\0\0'), ['x', 'y']);
});
