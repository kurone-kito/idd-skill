import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';

import type {
  AutoDecisionRecord,
  ConfirmationIssueRead,
} from '../src/scripts/auto-decision-records.mts';
import {
  type B1CommandResult,
  type B1Filesystem,
  type B1GateReading,
  type B1LeftoverReport,
  type B1PreservePorts,
  type B1PreserveRequest,
  type B1Runner,
  createDefaultB1PreservePorts,
  describeB1Locations,
  isDecisionId,
  newB1LeftoverReport,
  runB1Preservation,
  worktreeParentProblem,
} from '../src/scripts/b1-leftover-preserve.mts';
import type { TrustedAutoDecideReport } from '../src/scripts/idd-config.mts';
import { inspectLocalWorktreeBranchPrefix } from '../src/scripts/local-worktree-occupancy.mts';
import { fixtureEnv } from './test-utils.mts';

// Ownership, mode bits, and rename identity make the path-mode checks POSIX
// only. The branch mode runs everywhere.
const POSIX = process.platform !== 'win32';
const ISSUE = 4970;
const BRANCH = 'issue/4970-feat-claim-preserve-b1-leftovers-when';
const OWNER = 'kurone-kito';
const REPO = 'idd-skill';
const SOURCE = `${OWNER}/${REPO}#${ISSUE}`;
const CONFIRMATION_NUMBER = 5200;
const NOW = new Date('2026-11-09T01:02:03.000Z');
const STAMP = '20261109T010203Z';
const OID = /^[0-9a-f]{40}$/;

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Fixture {
  readonly root: string;
  readonly parent: string;
  readonly primary: string;
  readonly state: string;
  /** The computed worktree path of the claim. */
  readonly worktree: string;
  /** The destination directory the clock above produces. */
  readonly destination: string;
}

function fresh(): Fixture {
  // Canonical paths, so realpath comparisons see one spelling.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'b1-leftover-')));
  roots.push(root);
  const parent = join(root, 'parent');
  mkdirSync(parent);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '--quiet', '-b', 'main']);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  writeFileSync(join(seed, 'seed.txt'), 'seed\n');
  git(seed, ['add', 'seed.txt']);
  git(seed, ['commit', '--quiet', '-m', 'seed']);
  const origin = join(root, 'origin.git');
  git(root, ['clone', '--quiet', '--bare', seed, origin]);
  git(parent, ['clone', '--quiet', origin, 'primary']);
  const primary = join(parent, 'primary');
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  const state = join(root, 'state');
  mkdirSync(state);
  chmodSync(state, 0o700);
  const worktree = join(parent, `${REPO}.${BRANCH.replace(/\//g, '-')}`);
  return {
    root,
    parent,
    primary,
    state,
    worktree,
    destination: join(state, 'idd-skill', 'b1-preserved', `${ISSUE}-${STAMP}`),
  };
}

/** A commit that no branch holds yet, so `git branch -d` refuses the branch. */
function leftoverBranch(fixture: Fixture, name = BRANCH): string {
  const tree = git(fixture.primary, ['rev-parse', 'HEAD^{tree}']);
  const commit = git(fixture.primary, [
    'commit-tree',
    tree,
    '-p',
    'HEAD',
    '-m',
    'leftover work',
  ]);
  git(fixture.primary, ['update-ref', `refs/heads/${name}`, commit]);
  return commit;
}

function leftoverPath(fixture: Fixture): void {
  mkdirSync(fixture.worktree);
  writeFileSync(join(fixture.worktree, 'work.txt'), 'precious\n');
}

const CLAIMABLE: B1GateReading = {
  ok: true,
  detail: '',
  verdict: 'claimable',
  releasedClaim: { present: false, branch: null },
};

const TRUSTED: TrustedAutoDecideReport = {
  status: 'readable',
  source: 'repository',
  ref: 'main',
  master: 'enabled',
  classes: {
    decisionIssue: 'class-off',
    runtimeQuestion: 'class-off',
    authoringChoice: 'class-off',
    worktreeRemnant: 'class-off',
    b1Leftover: 'enabled',
  },
  confirmationLabelName: 'status:needs-confirmation',
};

function trustedWith(
  verdict: TrustedAutoDecideReport['classes']['b1Leftover'],
): TrustedAutoDecideReport {
  return { ...TRUSTED, classes: { ...TRUSTED.classes, b1Leftover: verdict } };
}

function record(
  decision: string,
  subject: string | null,
  overrides: Partial<AutoDecisionRecord> = {},
): AutoDecisionRecord {
  return {
    issue: CONFIRMATION_NUMBER,
    from: 'body',
    class: 'b1Leftover',
    source: SOURCE,
    claim: 'none',
    set: 'none',
    decision,
    subject,
    locationNote: false,
    failureNote: false,
    ...overrides,
  };
}

function confirmationRead(
  records: readonly AutoDecisionRecord[],
  overrides: Record<string, unknown> = {},
): ConfirmationIssueRead {
  return {
    status: 'readable',
    number: CONFIRMATION_NUMBER,
    state: 'open',
    confirmationLabel: true,
    authoringLabel: false,
    bodyRecordCounts: true,
    bodyRecordReason: null,
    records: [...records],
    voidedDecisions: [],
    conflictingDecisions: [],
    notes: [],
    ...overrides,
  } as ConfirmationIssueRead;
}

interface Overrides {
  /** Runs before the snapshot, to build the leftovers. */
  prepare?: (fixture: Fixture) => void;
  request?: Partial<B1PreserveRequest>;
  trusted?: TrustedAutoDecideReport | (() => TrustedAutoDecideReport);
  confirmation?: (fixture: Fixture) => ConfirmationIssueRead;
  fs?: (fixture: Fixture) => Partial<B1Filesystem>;
  prHeads?: readonly string[];
  /** Answer a call instead of running it; `undefined` runs it. */
  hook?: (
    fixture: Fixture,
    file: string,
    args: readonly string[],
  ) => B1CommandResult | undefined;
}

const okResult = (stdout = ''): B1CommandResult => ({
  status: 0,
  stdout,
  stderr: '',
});
const failedResult = (status = 1): B1CommandResult => ({
  status,
  stdout: '',
  stderr: 'boom',
});

function makeRunner(fixture: Fixture, overrides: Overrides) {
  const calls: string[] = [];
  const run: B1Runner = (file, args) => {
    calls.push(`${file} ${args.join(' ')}`);
    const hooked = overrides.hook?.(fixture, file, args);
    if (hooked !== undefined) return hooked;
    if (file === 'gh') {
      assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
      return okResult(
        JSON.stringify(
          (overrides.prHeads ?? []).map((head, index) => ({
            number: index + 1,
            headRefName: head,
          })),
        ),
      );
    }
    const result = spawnSync(file, [...args], {
      env: fixtureEnv(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  return { run, calls };
}

function portsFor(fixture: Fixture, overrides: Overrides): B1PreservePorts {
  const real = createDefaultB1PreservePorts({
    env: { XDG_STATE_HOME: fixture.state },
    platform: process.platform,
    home: fixture.root,
    now: () => NOW,
  });
  return {
    readTrusted: () => {
      const trusted = overrides.trusted ?? TRUSTED;
      return typeof trusted === 'function' ? trusted() : trusted;
    },
    readConfirmation: () =>
      overrides.confirmation?.(fixture) ??
      confirmationRead([record('d1', BRANCH)]),
    fs: { ...real.fs, ...overrides.fs?.(fixture) },
  };
}

function requestFor(
  fixture: Fixture,
  overrides: Partial<B1PreserveRequest> = {},
): B1PreserveRequest {
  return {
    mode: 'apply',
    issue: ISSUE,
    repository: { owner: OWNER, repo: REPO },
    branch: BRANCH,
    primary: fixture.primary,
    path: fixture.worktree,
    defaultBranch: 'main',
    developmentBranch: 'main',
    authoringLabel: 'status:authoring',
    policyPath: join(fixture.primary, '.github', 'idd', 'config.json'),
    confirmation: {
      owner: OWNER,
      repo: REPO,
      number: CONFIRMATION_NUMBER,
    },
    decisions: ['d1'],
    readGate: () => CLAIMABLE,
    inspectLocalWorktrees: () => ({
      status: 'absent',
      paths: [],
      reason: null,
    }),
    ...overrides,
  };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function listTree(path: string): string[] {
  if (!existsSync(path) && !lstatExists(path)) return [];
  if (!lstatSync(path).isDirectory()) return [path];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      out.push(full);
      if (lstatSync(full).isDirectory()) visit(full);
    }
  };
  visit(path);
  return out;
}

/** Everything the module may change: refs, branch configuration, path, state root. */
function snapshot(fixture: Fixture): string {
  const entry = (() => {
    try {
      const stat = lstatSync(fixture.worktree, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return 'absent';
    }
  })();
  return JSON.stringify({
    refs: git(fixture.primary, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]),
    config: git(fixture.primary, ['config', '--local', '--list']),
    path: entry,
    pathTree: listTree(fixture.worktree),
    state: listTree(fixture.state),
  });
}

function exercise(fixture: Fixture, overrides: Overrides = {}) {
  overrides.prepare?.(fixture);
  const before = snapshot(fixture);
  const { run, calls } = makeRunner(fixture, overrides);
  const report = newB1LeftoverReport(overrides.request?.mode ?? 'apply');
  const failure = runB1Preservation(
    requestFor(fixture, overrides.request),
    portsFor(fixture, overrides),
    run,
    report,
  );
  return { report, failure, calls, before, after: snapshot(fixture) };
}

function unmet(report: B1LeftoverReport): string[] {
  return [
    ...report.common
      .filter((entry) => entry.status === 'unmet')
      .map((entry) => entry.id),
    ...report.subjects.flatMap((subject) =>
      subject.preconditions
        .filter((entry) => entry.status === 'unmet')
        .map((entry) => `${subject.kind}:${entry.id}`),
    ),
  ];
}

function assertRefused(
  result: ReturnType<typeof exercise>,
  expected: string,
): void {
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'unmet-preconditions');
  assert.ok(
    unmet(result.report).includes(expected),
    `${expected} is unmet; got ${unmet(result.report).join(', ')}`,
  );
  assert.equal(result.report.actions.length, 0);
  assert.equal(result.after, result.before, 'a refusal changes nothing');
  assert.equal(
    result.calls.some((call) => /update-ref|--remove-section/.test(call)),
    false,
  );
}

const pathCase = { skip: !POSIX };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

test('isDecisionId follows the contract value rule', () => {
  assert.equal(isDecisionId('d1'), true);
  assert.equal(isDecisionId('a'.repeat(128)), true);
  for (const bad of ['', 'a b', 'a;b', 'a-->b', 'a'.repeat(129)]) {
    assert.equal(isDecisionId(bad), false, JSON.stringify(bad));
  }
});

test('worktreeParentProblem checks the direct child and an unlinked parent', () => {
  const fixture = fresh();
  assert.equal(worktreeParentProblem(fixture.primary, fixture.worktree), null);
  assert.match(
    worktreeParentProblem(fixture.primary, join(fixture.parent, 'a', 'b')) ??
      '',
    /not a direct child/,
  );
  assert.match(
    worktreeParentProblem(fixture.primary, fixture.primary) ?? '',
    /not a direct child/,
  );
  if (POSIX) {
    const link = join(fixture.root, 'link');
    symlinkSync(fixture.parent, link);
    assert.match(
      worktreeParentProblem(join(link, 'primary'), join(link, 'x')) ?? '',
      /is a link/,
    );
  }
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test('no leftover: the flag acts on nothing and reports unused decisions', () => {
  const fixture = fresh();
  const result = exercise(fixture, { request: { decisions: ['d9'] } });
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'no-leftover');
  assert.deepEqual(result.report.decisionsUnused, ['d9']);
  assert.deepEqual(result.report.subjects, []);
  assert.equal(result.after, result.before);
});

test('a dry run without a confirmation lists the branch and shows the record unmet', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  const result = exercise(fixture, {
    request: { mode: 'dry-run', confirmation: null, decisions: [] },
  });
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'unmet-preconditions');
  assert.equal(result.report.mode, 'dry-run');
  assert.deepEqual(
    result.report.subjects.map((subject) => [subject.kind, subject.subject]),
    [['branch', BRANCH]],
  );
  assert.deepEqual(
    unmet(result.report).filter((id) => /record/.test(id)),
    ['record', 'branch:record-match'],
  );
  // Every other precondition of the branch is met, and nothing changed.
  const branch = result.report.subjects[0];
  assert.ok(branch);
  assert.equal(
    branch.preconditions.filter((entry) => entry.status === 'unmet').length,
    1,
  );
  assert.equal(
    git(fixture.primary, ['rev-parse', `refs/heads/${BRANCH}`]),
    tip,
  );
  assert.equal(result.after, result.before);
});

test('a dry run with every precondition met is ready and changes nothing', () => {
  const fixture = fresh();
  leftoverBranch(fixture);
  const result = exercise(fixture, { request: { mode: 'dry-run' } });
  assert.equal(result.report.outcome, 'ready');
  assert.deepEqual(unmet(result.report), []);
  assert.equal(result.report.subjects[0]?.decision, 'd1');
  assert.equal(result.after, result.before);
  assert.equal(
    result.calls.some((call) => /update-ref|config --remove/.test(call)),
    false,
  );
});

// ---------------------------------------------------------------------------
// Branch mode
// ---------------------------------------------------------------------------

test('apply: the branch is backed up, read back, and deleted at its commit', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  git(fixture.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
  git(fixture.primary, [
    'config',
    `branch.${BRANCH}.merge`,
    `refs/heads/${BRANCH}`,
  ]);
  const result = exercise(fixture);
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'preserved');
  const backup = `refs/idd-b1/${ISSUE}/${tip}`;
  assert.deepEqual(result.report.backupRefs, [backup]);
  assert.equal(git(fixture.primary, ['rev-parse', backup]), tip);
  assert.equal(
    git(fixture.primary, ['branch', '--list', BRANCH]),
    '',
    'the branch is gone',
  );
  assert.equal(
    spawnSync('git', ['config', '--get-regexp', '^branch\\.issue/'], {
      cwd: fixture.primary,
      env: fixtureEnv(),
    }).status,
    1,
    'no branch configuration section is left',
  );
  assert.deepEqual(result.report.removedConfigSections, [`branch.${BRANCH}`]);
  assert.deepEqual(
    result.report.actions.map((action) => action.id),
    ['backup-ref', 'branch-deleted', 'config-section-removed'],
  );
  assert.match(describeB1Locations(result.report) ?? '', new RegExp(backup));
  // The commits stay reachable from the backup ref.
  assert.equal(git(fixture.primary, ['cat-file', '-t', tip]), 'commit');
});

test('apply: the order is backup, read back, then deletion', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  const result = exercise(fixture);
  const calls = result.calls;
  const at = (needle: RegExp) => calls.findIndex((call) => needle.test(call));
  const create = at(
    new RegExp(`update-ref refs/idd-b1/${ISSUE}/${tip} ${tip} $`),
  );
  const readBack = at(
    new RegExp(`rev-parse --verify refs/idd-b1/${ISSUE}/${tip}$`),
  );
  const remove = at(
    new RegExp(`update-ref --no-deref -d refs/heads/${BRANCH} ${tip}$`),
  );
  assert.ok(
    create >= 0 && readBack > create && remove > readBack,
    calls.join('\n'),
  );
});

test('apply: an existing backup ref at the same commit is reused', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      const tip = leftoverBranch(f);
      git(f.primary, ['update-ref', `refs/idd-b1/${ISSUE}/${tip}`, tip]);
    },
  });
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'preserved');
  assert.equal(
    result.calls.some((call) =>
      / update-ref refs\/idd-b1\/\S+ \S+ $/.test(call),
    ),
    false,
    'a reused ref is not created again',
  );
});

test('refused: a backup ref at another commit', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      const tip = leftoverBranch(f);
      const other = git(f.primary, ['rev-parse', 'HEAD']);
      git(f.primary, ['update-ref', `refs/idd-b1/${ISSUE}/${tip}`, other]);
    },
  });
  assertRefused(result, 'branch:backup-ref-compatible');
});

const branchRefusals: [string, string, Overrides][] = [
  ['the class is off', 'class-enabled', { trusted: trustedWith('class-off') }],
  [
    'the master switch is off',
    'class-enabled',
    { trusted: trustedWith('master-off') },
  ],
  [
    'the trusted read is unreadable',
    'class-enabled',
    {
      trusted: {
        ...TRUSTED,
        status: 'unreadable',
        error: 'no policy',
      } as TrustedAutoDecideReport,
    },
  ],
  [
    'the trusted read throws',
    'class-enabled',
    {
      trusted: () => {
        throw new Error('network down');
      },
    },
  ],
  [
    'the fresh-claim gate is not claimable',
    'fresh-claim-gate',
    {
      request: {
        readGate: () => ({ ...CLAIMABLE, verdict: 'already-claimed' }),
      },
    },
  ],
  [
    'the fresh-claim gate cannot be read',
    'fresh-claim-gate',
    {
      request: {
        readGate: () => ({ ...CLAIMABLE, ok: false, detail: 'exit code 1' }),
      },
    },
  ],
  [
    'the branch is the branch of a released claim',
    'released-claim',
    {
      request: {
        readGate: () => ({
          ...CLAIMABLE,
          releasedClaim: { present: true, branch: BRANCH },
        }),
      },
    },
  ],
  [
    'a released claim has no readable branch',
    'released-claim',
    {
      request: {
        readGate: () => ({
          ...CLAIMABLE,
          releasedClaim: { present: true, branch: null },
        }),
      },
    },
  ],
  [
    'the branch is the development branch',
    'branch:not-default-or-development',
    { request: { developmentBranch: BRANCH } },
  ],
  [
    'the branch is the default branch',
    'branch:not-default-or-development',
    { request: { defaultBranch: BRANCH } },
  ],
  [
    'a worktree may hold the branch',
    'branch:not-checked-out',
    {
      request: {
        inspectLocalWorktrees: () => ({
          status: 'occupied',
          paths: ['/elsewhere'],
          reason: null,
        }),
      },
    },
  ],
  [
    'the local worktree scan is unreadable',
    'branch:not-checked-out',
    {
      request: {
        inspectLocalWorktrees: () => ({
          status: 'unreadable',
          paths: [],
          reason: 'unreadable',
        }),
      },
    },
  ],
  [
    'an open pull request has the branch as its head',
    'branch:no-open-pr',
    { prHeads: [BRANCH] },
  ],
  [
    'the pull request list has a row without a head name',
    'branch:no-open-pr',
    {
      hook: (_fixture, file) => (file === 'gh' ? okResult('[{}]') : undefined),
    },
  ],
  [
    'the pull request list has a row of the wrong type',
    'branch:no-open-pr',
    {
      hook: (_fixture, file) =>
        file === 'gh'
          ? okResult('[{"number":"7","headRefName":"x"},{"number":8}]')
          : undefined,
    },
  ],
  [
    'the pull request list is not an array',
    'branch:no-open-pr',
    {
      hook: (_fixture, file) =>
        file === 'gh' ? okResult('{"message":"x"}') : undefined,
    },
  ],
  [
    'the pull request read fails',
    'branch:no-open-pr',
    {
      hook: (_fixture, file) => (file === 'gh' ? failedResult(1) : undefined),
    },
  ],
  [
    'the remote read fails',
    'branch:no-remote-branch',
    {
      hook: (_fixture, _file, args) =>
        args.includes('ls-remote') ? failedResult(128) : undefined,
    },
  ],
  [
    'the confirmation issue is closed',
    'record',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH)], { state: 'closed' }),
    },
  ],
  [
    'the confirmation issue lacks the label',
    'record',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH)], { confirmationLabel: false }),
    },
  ],
  [
    'the confirmation issue is still held',
    'record',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH)], { authoringLabel: true }),
    },
  ],
  [
    'the confirmation issue is unreadable',
    'record',
    {
      confirmation: () => ({ status: 'unreadable', error: 'no page' }),
    },
  ],
  [
    'the record names another subject',
    'decision-pairing',
    { confirmation: () => confirmationRead([record('d1', 'issue/other')]) },
  ],
  [
    'the record is for another issue',
    'decision-pairing',
    {
      confirmation: () =>
        confirmationRead([
          record('d1', BRANCH, { source: `${OWNER}/${REPO}#1` }),
        ]),
    },
  ],
  [
    'the record carries a claim ID',
    'decision-pairing',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH, { claim: 'some-claim' })]),
    },
  ],
  [
    'the decision is voided',
    'decision-pairing',
    {
      confirmation: () => confirmationRead([], { voidedDecisions: ['d1'] }),
    },
  ],
  [
    'the decision has a counting location note',
    'branch:record-match',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH, { locationNote: true })]),
    },
  ],
  [
    'the decision has a counting failure note',
    'branch:record-match',
    {
      confirmation: () =>
        confirmationRead([record('d1', BRANCH, { failureNote: true })]),
    },
  ],
  ['no decision is given', 'decision-pairing', { request: { decisions: [] } }],
  [
    'a decision ID matches no record',
    'decision-pairing',
    { request: { decisions: ['nope'] } },
  ],
  [
    'there is no confirmation issue',
    'record',
    { request: { confirmation: null } },
  ],
];

for (const [name, expected, overrides] of branchRefusals) {
  test(`refused: ${name}`, () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      ...overrides,
      prepare: (f) => {
        leftoverBranch(f);
        overrides.prepare?.(f);
      },
    });
    assertRefused(result, expected);
  });
}

test('refused: the branch is merged, so git branch -d deletes it', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => git(f.primary, ['branch', BRANCH, 'main']),
  });
  assertRefused(result, 'branch:not-deletable-with-d');
});

/** A commit under a new remote-tracking ref, as a configured upstream. */
function upstreamAt(
  f: Fixture,
  ref: string,
  parent: string | null,
  configured = ref,
): void {
  const tree = git(f.primary, ['rev-parse', 'HEAD^{tree}']);
  const commit = git(f.primary, [
    'commit-tree',
    tree,
    ...(parent === null ? [] : ['-p', parent]),
    '-m',
    'upstream',
  ]);
  git(f.primary, ['update-ref', `refs/remotes/origin/${ref}`, commit]);
  git(f.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
  git(f.primary, [
    'config',
    `branch.${BRANCH}.merge`,
    `refs/heads/${configured}`,
  ]);
}

test('a configured upstream decides whether git branch -d would delete the branch', () => {
  // Merged into the upstream but not into HEAD: -d deletes it, so refuse.
  const mergedUpstream = fresh();
  const tip = leftoverBranch(mergedUpstream);
  upstreamAt(mergedUpstream, 'descendant', tip);
  assertRefused(exercise(mergedUpstream), 'branch:not-deletable-with-d');

  // Merged into HEAD but not into the upstream: -d refuses, so preserve.
  const unmergedUpstream = fresh();
  git(unmergedUpstream.primary, ['branch', BRANCH, 'main']);
  upstreamAt(unmergedUpstream, 'unrelated', null);
  const unmerged = exercise(unmergedUpstream, { request: { mode: 'dry-run' } });
  assert.equal(unmerged.report.outcome, 'ready');

  // An upstream whose ref is gone falls back to HEAD, as git does.
  const goneUpstream = fresh();
  leftoverBranch(goneUpstream);
  git(goneUpstream.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
  git(goneUpstream.primary, [
    'config',
    `branch.${BRANCH}.merge`,
    'refs/heads/gone',
  ]);
  assert.equal(
    exercise(goneUpstream, { request: { mode: 'dry-run' } }).report.outcome,
    'ready',
  );
});

test('refused: the branch exists on a remote', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      leftoverBranch(f);
      git(f.primary, ['push', '--quiet', 'origin', `${BRANCH}:${BRANCH}`]);
    },
  });
  assertRefused(result, 'branch:no-remote-branch');
});

test('refused: a worktree has the branch checked out', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      git(f.primary, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        BRANCH,
        join(f.root, 'other'),
      ]);
      git(join(f.root, 'other'), [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@e.c',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'work',
      ]);
    },
  });
  assertRefused(result, 'branch:not-checked-out');
});

test('refused: a prunable worktree entry is in the way and stays', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      const stale = join(f.root, 'stale');
      git(f.primary, ['worktree', 'add', '--quiet', '-b', BRANCH, stale]);
      rmSync(stale, { recursive: true, force: true });
    },
  });
  assertRefused(result, 'no-prunable-entry');
  assert.match(
    git(fixture.primary, ['worktree', 'list', '--porcelain']),
    /prunable/,
  );
});

test('refused: the worktree list cannot be read', () => {
  const fixture = fresh();
  leftoverBranch(fixture);
  const result = exercise(fixture, {
    hook: (_f, _file, args) =>
      args.includes('worktree') ? failedResult(128) : undefined,
  });
  assert.equal(result.report.outcome, 'unmet-preconditions');
  assert.deepEqual(unmet(result.report), ['worktree-list']);
  assert.equal(result.after, result.before);
});

// ---------------------------------------------------------------------------
// Branch failures after a state change
// ---------------------------------------------------------------------------

test('failure: the backup ref reads back wrong, and the branch stays', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  const backup = `refs/idd-b1/${ISSUE}/${tip}`;
  const result = exercise(fixture, {
    hook: (_f, _file, args) =>
      args.at(-1) === backup &&
      args.includes('--verify') &&
      !args.includes('--quiet')
        ? okResult(`${'a'.repeat(40)}\n`)
        : undefined,
  });
  assert.equal(result.report.outcome, 'failed');
  assert.match(result.failure?.detail ?? '', /did not read back/);
  assert.equal(
    git(fixture.primary, ['rev-parse', backup]),
    tip,
    'the ref stays',
  );
  assert.equal(
    git(fixture.primary, ['rev-parse', `refs/heads/${BRANCH}`]),
    tip,
  );
  // The ref exists, so the report and the next action name it.
  assert.deepEqual(result.report.backupRefs, [backup]);
  assert.match(result.failure?.nextAction ?? '', new RegExp(backup));
  assert.doesNotMatch(result.failure?.nextAction ?? '', /changed nothing/);
});

test('failure: the tip moved before the deletion, so the branch and the backup stay', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  let moved = '';
  const result = exercise(fixture, {
    hook: (f, _file, args) => {
      if (args.includes('update-ref') && args.includes('-d')) {
        moved = git(f.primary, [
          'commit-tree',
          git(f.primary, ['rev-parse', 'HEAD^{tree}']),
          '-p',
          tip,
          '-m',
          'moved',
        ]);
        git(f.primary, ['update-ref', `refs/heads/${BRANCH}`, moved]);
      }
      return undefined;
    },
  });
  assert.equal(result.report.outcome, 'failed');
  assert.match(result.failure?.detail ?? '', /tip moved/);
  assert.equal(
    git(fixture.primary, ['rev-parse', `refs/heads/${BRANCH}`]),
    moved,
  );
  assert.equal(
    git(fixture.primary, ['rev-parse', `refs/idd-b1/${ISSUE}/${tip}`]),
    tip,
  );
  assert.match(
    result.failure?.nextAction ?? '',
    new RegExp(`refs/idd-b1/${ISSUE}/${tip}`),
  );
  assert.deepEqual(
    result.report.actions.map((a) => a.id),
    ['backup-ref'],
  );
});

test('failure: a present configuration section cannot be removed', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  git(fixture.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
  const result = exercise(fixture, {
    hook: (_f, _file, args) =>
      args.includes('--remove-section') ? failedResult(1) : undefined,
  });
  assert.equal(result.report.outcome, 'failed');
  assert.match(
    result.failure?.detail ?? '',
    /branch\.issue.*could not be removed/,
  );
  assert.equal(git(fixture.primary, ['branch', '--list', BRANCH]), '');
  assert.match(
    result.failure?.nextAction ?? '',
    new RegExp(`refs/idd-b1/${ISSUE}/${tip}`),
  );
  assert.deepEqual(
    result.report.actions.map((a) => a.id),
    ['backup-ref', 'branch-deleted'],
  );
});

test('failure: an unexpected throw still names the backup ref', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  const result = exercise(fixture, {
    hook: (_f, _file, args) => {
      if (args.includes('update-ref') && args.includes('-d')) {
        throw new Error('spawn exploded');
      }
      return undefined;
    },
  });
  assert.equal(result.report.outcome, 'failed');
  assert.match(result.failure?.detail ?? '', /spawn exploded/);
  assert.match(result.failure?.nextAction ?? '', new RegExp(tip));
  assert.equal(result.report.backupRefs.length, 1);
});

// ---------------------------------------------------------------------------
// Path mode
// ---------------------------------------------------------------------------

test(
  'dry run: a path leftover is listed with its canonical subject',
  pathCase,
  () => {
    const fixture = fresh();
    leftoverPath(fixture);
    const result = exercise(fixture, {
      request: { mode: 'dry-run' },
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
    });
    assert.equal(result.report.outcome, 'ready');
    assert.deepEqual(
      result.report.subjects.map((s) => [s.kind, s.subject]),
      [['path', fixture.worktree]],
    );
    assert.equal(result.after, result.before);
    assert.equal(existsSync(join(fixture.state, 'idd-skill')), false);
  },
);

test(
  'apply: a directory is renamed under the preserve directory, contents intact',
  pathCase,
  () => {
    const fixture = fresh();
    leftoverPath(fixture);
    const before = lstatSync(fixture.worktree, { bigint: true });
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
    });
    assert.equal(result.failure, null);
    assert.equal(result.report.outcome, 'preserved');
    const moved = join(fixture.destination, basename(fixture.worktree));
    assert.deepEqual(result.report.destinations, [
      { from: fixture.worktree, to: moved },
    ]);
    assert.equal(existsSync(fixture.worktree), false);
    assert.equal(readFileSync(join(moved, 'work.txt'), 'utf8'), 'precious\n');
    const after = lstatSync(moved, { bigint: true });
    assert.equal(after.ino, before.ino, 'a rename keeps the inode');
    assert.equal(after.dev, before.dev);
    assert.equal(
      lstatSync(fixture.destination).mode & 0o077,
      0,
      'the directory is private',
    );
    assert.deepEqual(
      result.report.actions.map((a) => a.id),
      ['destination-created', 'path-moved'],
    );
  },
);

test(
  'apply: a symlink is moved as the link, and its target is untouched',
  pathCase,
  () => {
    const fixture = fresh();
    const target = join(fixture.root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'kept.txt'), 'kept\n');
    symlinkSync(target, fixture.worktree);
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
    });
    assert.equal(result.report.outcome, 'preserved');
    const moved = join(fixture.destination, basename(fixture.worktree));
    assert.equal(lstatSync(moved).isSymbolicLink(), true);
    assert.equal(readFileSync(join(target, 'kept.txt'), 'utf8'), 'kept\n');
    assert.equal(existsSync(fixture.worktree), false);
  },
);

test('apply: a file is moved too', pathCase, () => {
  const fixture = fresh();
  writeFileSync(fixture.worktree, 'occupied\n');
  const result = exercise(fixture, {
    confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
  });
  assert.equal(result.report.outcome, 'preserved');
  assert.equal(
    readFileSync(join(fixture.destination, basename(fixture.worktree)), 'utf8'),
    'occupied\n',
  );
});

const pathRefusals: [
  string,
  string,
  Overrides & { build?: (f: Fixture) => void },
][] = [
  [
    'the entry belongs to another user',
    'path:owned-by-user',
    { fs: () => ({ currentUid: () => 424242 }) },
  ],
  [
    'ownership cannot be verified',
    'path:owned-by-user',
    { fs: () => ({ currentUid: () => null }) },
  ],
  [
    'the path cannot be inspected',
    'path-listing',
    {
      fs: () => ({
        lstatEntry: () => {
          throw new Error('EACCES');
        },
      }),
    },
  ],
  [
    'the entry is on another device than the state root',
    'path:same-device',
    {
      fs: (f) => {
        const real = createDefaultB1PreservePorts().fs;
        return {
          lstatEntry: (path: string) => {
            const info = real.lstatEntry(path);
            return path === f.worktree && info !== null
              ? { ...info, device: '999999' }
              : info;
          },
        };
      },
    },
  ],
  [
    'the destination already exists',
    'path:destination',
    {
      build: (f) =>
        mkdirSync(
          join(f.state, 'idd-skill', 'b1-preserved', `${ISSUE}-${STAMP}`),
          {
            recursive: true,
            mode: 0o700,
          },
        ),
    },
  ],
  [
    'a destination component is a symlink',
    'path:destination',
    {
      build: (f) => {
        const elsewhere = join(f.root, 'elsewhere');
        mkdirSync(elsewhere, { mode: 0o700 });
        symlinkSync(elsewhere, join(f.state, 'idd-skill'));
      },
    },
  ],
  [
    'the state root does not exist',
    'path:destination',
    { build: (f) => rmSync(f.state, { recursive: true, force: true }) },
  ],
  [
    'a .git file points to an existing administration directory',
    'path:no-git-link',
    {
      build: (f) =>
        writeFileSync(join(f.worktree, '.git'), `gitdir: ${f.primary}/.git\n`),
    },
  ],
  [
    'a .git file is not a gitdir line',
    'path:no-git-link',
    { build: (f) => writeFileSync(join(f.worktree, '.git'), 'nonsense\n') },
  ],
];

for (const [name, expected, overrides] of pathRefusals) {
  test(`refused (path): ${name}`, pathCase, () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      ...overrides,
      prepare: (f) => {
        leftoverPath(f);
        overrides.build?.(f);
      },
    });
    assertRefused(result, expected);
  });
}

test(
  'path mode allows a .git file that points to no existing directory',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: (f) => {
        leftoverPath(f);
        writeFileSync(
          join(f.worktree, '.git'),
          `gitdir: ${f.root}/gone/.git\n`,
        );
      },
    });
    assert.equal(result.report.outcome, 'preserved');
  },
);

test('refused (path): a registered worktree is at the path', pathCase, () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
    prepare: (f) =>
      git(f.primary, ['worktree', 'add', '--quiet', '-b', 'other', f.worktree]),
  });
  assertRefused(result, 'path:not-registered-worktree');
});

test(
  'refused (path): a registered worktree is inside the path',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: (f) => {
        mkdirSync(f.worktree);
        git(f.primary, [
          'worktree',
          'add',
          '--quiet',
          '-b',
          'other',
          join(f.worktree, 'inner'),
        ]);
      },
    });
    assertRefused(result, 'path:not-registered-worktree');
  },
);

test(
  'refused (path): the path is not a direct child of the primary parent',
  pathCase,
  () => {
    const fixture = fresh();
    const nested = join(fixture.parent, 'sub', 'x');
    const result = exercise(fixture, {
      request: { path: nested },
      confirmation: () => confirmationRead([record('d1', nested)]),
      prepare: (f) => {
        mkdirSync(join(f.parent, 'sub'));
        mkdirSync(nested);
      },
    });
    assertRefused(result, 'path:computed-path');
  },
);

test(
  'refused (path): a prunable entry sits at the path with no entry there',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      prepare: (f) => {
        git(f.primary, [
          'worktree',
          'add',
          '--quiet',
          '-b',
          'other',
          f.worktree,
        ]);
        rmSync(f.worktree, { recursive: true, force: true });
        leftoverBranch(f);
      },
    });
    assertRefused(result, 'no-prunable-entry');
  },
);

// ---------------------------------------------------------------------------
// Path failures after a state change
// ---------------------------------------------------------------------------

function realFs(): B1Filesystem {
  return createDefaultB1PreservePorts().fs;
}

test(
  'failure: the rename fails, and the source and empty private parents stay',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: () => ({
        rename: () => {
          throw new Error('EXDEV');
        },
      }),
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /renaming .* failed/);
    assert.equal(
      readFileSync(join(fixture.worktree, 'work.txt'), 'utf8'),
      'precious\n',
    );
    assert.equal(existsSync(fixture.destination), true);
    assert.deepEqual(readdirSync(fixture.destination), []);
    assert.match(
      result.failure?.nextAction ?? '',
      new RegExp(fixture.destination),
    );
  },
);

test(
  'failure: the destination fails its privacy check, and the source is untouched',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => ({
        inspectDirectoryPrivacy: (path: string) =>
          path === f.destination
            ? 'unsafe'
            : real.inspectDirectoryPrivacy(path),
      }),
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /not prepared/);
    assert.equal(
      readFileSync(join(fixture.worktree, 'work.txt'), 'utf8'),
      'precious\n',
    );
    assert.equal(result.report.destinations.length, 0);
    // The directory was created and stays in place, so the next action names
    // its path for the failure note.
    assert.equal(existsSync(fixture.destination), true);
    assert.deepEqual(
      result.report.actions.map((action) => action.id),
      ['destination-created'],
    );
    assert.match(
      result.failure?.nextAction ?? '',
      new RegExp(fixture.destination),
    );
    assert.doesNotMatch(result.failure?.nextAction ?? '', /changed nothing/);
  },
);

test(
  'failure: the moved entry has another identity, so it stays at the destination',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const moved = join(fixture.destination, basename(fixture.worktree));
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: () => ({
        lstatEntry: (path: string) => {
          const info = real.lstatEntry(path);
          return path === moved && info !== null
            ? { ...info, identity: '1:1' }
            : info;
        },
      }),
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /does not match the identity/);
    assert.equal(readFileSync(join(moved, 'work.txt'), 'utf8'), 'precious\n');
    assert.equal(existsSync(fixture.worktree), false);
    assert.match(result.failure?.nextAction ?? '', new RegExp(moved));
    assert.deepEqual(result.report.destinations, [
      { from: fixture.worktree, to: moved },
    ]);
  },
);

/** Parents that change right after the rename, so the move needs undoing. */
function parentsChangeAfterRename(
  f: Fixture,
  extra: Partial<B1Filesystem> = {},
): Partial<B1Filesystem> {
  const real = realFs();
  let renamed = false;
  return {
    rename: (from: string, to: string) => {
      real.rename(from, to);
      renamed = true;
    },
    directoryIdentity: (path: string) =>
      renamed && path === join(f.state, 'idd-skill')
        ? '7:7'
        : real.directoryIdentity(path),
    ...extra,
  };
}

test(
  'failure: changed parents move the entry back when the source path is free',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => parentsChangeAfterRename(f),
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /moved back/);
    assert.equal(
      readFileSync(join(fixture.worktree, 'work.txt'), 'utf8'),
      'precious\n',
    );
    assert.equal(result.report.destinations.length, 0);
  },
);

test(
  'failure: changed parents leave the entry when the source path is occupied again',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const moved = join(fixture.destination, basename(fixture.worktree));
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => {
        let renamed = false;
        return {
          ...parentsChangeAfterRename(f),
          rename: (from: string, to: string) => {
            real.rename(from, to);
            renamed = true;
          },
          lstatEntry: (path: string) =>
            renamed && path === f.worktree
              ? { kind: 'directory', identity: '9:9', device: '1', uid: 0 }
              : real.lstatEntry(path),
          directoryIdentity: (path: string) =>
            renamed && path === join(f.state, 'idd-skill')
              ? '7:7'
              : real.directoryIdentity(path),
        };
      },
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /occupied again/);
    assert.equal(readFileSync(join(moved, 'work.txt'), 'utf8'), 'precious\n');
    assert.deepEqual(result.report.destinations, [
      { from: fixture.worktree, to: moved },
    ]);
  },
);

test(
  'failure: moving the entry back fails, and it stays where the failure leaves it',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const moved = join(fixture.destination, basename(fixture.worktree));
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => {
        let calls = 0;
        return {
          ...parentsChangeAfterRename(f),
          rename: (from: string, to: string) => {
            calls += 1;
            if (calls > 1) throw new Error('EBUSY');
            real.rename(from, to);
          },
          directoryIdentity: (path: string) =>
            calls > 0 && path === join(f.state, 'idd-skill')
              ? '7:7'
              : real.directoryIdentity(path),
        };
      },
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(
      result.failure?.detail ?? '',
      /moving the entry back .* failed/,
    );
    assert.equal(readFileSync(join(moved, 'work.txt'), 'utf8'), 'precious\n');
  },
);

// ---------------------------------------------------------------------------
// Both leftovers
// ---------------------------------------------------------------------------

const both = (f: Fixture) => {
  leftoverBranch(f);
  leftoverPath(f);
};

test('both: each leftover is listed and needs its own record', pathCase, () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    request: { mode: 'dry-run', decisions: ['d1'] },
    confirmation: () => confirmationRead([record('d1', BRANCH)]),
    prepare: both,
  });
  assert.deepEqual(
    result.report.subjects.map((s) => s.kind),
    ['branch', 'path'],
  );
  assertRefused(result, 'decision-pairing');
});

test(
  'both: two records preserve the branch first and the path second',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      request: { decisions: ['d1', 'd2'] },
      confirmation: () =>
        confirmationRead([
          record('d1', BRANCH),
          record('d2', fixture.worktree),
        ]),
      prepare: both,
    });
    assert.equal(result.failure, null);
    assert.equal(result.report.outcome, 'preserved');
    assert.deepEqual(
      result.report.actions.map((a) => a.id),
      ['backup-ref', 'branch-deleted', 'destination-created', 'path-moved'],
    );
    assert.deepEqual(
      result.report.subjects.map((s) => s.decision),
      ['d1', 'd2'],
    );
  },
);

test(
  'both: a refused path refuses the branch too, so nothing is half handled',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      request: { decisions: ['d1', 'd2'] },
      confirmation: () =>
        confirmationRead([
          record('d1', BRANCH),
          record('d2', fixture.worktree),
        ]),
      prepare: both,
      fs: () => ({ currentUid: () => 424242 }),
    });
    assertRefused(result, 'path:owned-by-user');
    assert.notEqual(git(fixture.primary, ['branch', '--list', BRANCH]), '');
  },
);

test(
  'both: a path failure after the branch was preserved still names the backup ref',
  pathCase,
  () => {
    const fixture = fresh();
    let tip = '';
    const result = exercise(fixture, {
      request: { decisions: ['d1', 'd2'] },
      confirmation: () =>
        confirmationRead([
          record('d1', BRANCH),
          record('d2', fixture.worktree),
        ]),
      prepare: (f) => {
        tip = leftoverBranch(f);
        leftoverPath(f);
      },
      fs: () => ({
        rename: () => {
          throw new Error('EXDEV');
        },
      }),
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(tip, OID);
    assert.deepEqual(result.report.backupRefs, [`refs/idd-b1/${ISSUE}/${tip}`]);
    assert.match(result.failure?.nextAction ?? '', new RegExp(tip));
    assert.equal(git(fixture.primary, ['branch', '--list', BRANCH]), '');
  },
);

// ---------------------------------------------------------------------------
// Pairing rules with two listed subjects, and the remaining checks
// ---------------------------------------------------------------------------

function pairingDetail(report: B1LeftoverReport): string {
  return (
    report.common.find((entry) => entry.id === 'decision-pairing')?.detail ?? ''
  );
}

test('pairing: two decision IDs for one subject refuse', pathCase, () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    request: { decisions: ['d1', 'd2'] },
    confirmation: () =>
      confirmationRead([record('d1', BRANCH), record('d2', BRANCH)]),
    prepare: both,
  });
  assertRefused(result, 'decision-pairing');
  assert.match(pairingDetail(result.report), /two decisions pair with/);
});

test('pairing: a repeated decision ID refuses', pathCase, () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    request: { decisions: ['d1', 'd1'] },
    confirmation: () =>
      confirmationRead([record('d1', BRANCH), record('d2', fixture.worktree)]),
    prepare: both,
  });
  assertRefused(result, 'decision-pairing');
  assert.match(pairingDetail(result.report), /is repeated/);
});

test('pairing: a count that differs from the listed subjects refuses', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    request: { decisions: ['d1', 'd2'] },
    confirmation: () =>
      confirmationRead([record('d1', BRANCH), record('d2', 'issue/other')]),
    prepare: leftoverBranch,
  });
  assertRefused(result, 'decision-pairing');
  assert.match(pairingDetail(result.report), /2 --decision value\(s\) for 1/);
});

test('pairing: a voided decision is named as voided', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    confirmation: () => confirmationRead([], { voidedDecisions: ['d1'] }),
    prepare: leftoverBranch,
  });
  assertRefused(result, 'decision-pairing');
  assert.match(pairingDetail(result.report), /it is voided/);
});

test('refused (path): a linked parent of the primary', pathCase, () => {
  const fixture = fresh();
  const link = join(fixture.root, 'link');
  const through = join(link, 'x');
  const result = exercise(fixture, {
    request: { primary: join(link, 'primary'), path: through },
    confirmation: () => confirmationRead([record('d1', through)]),
    prepare: (f) => {
      symlinkSync(f.parent, link);
      mkdirSync(join(f.parent, 'x'));
    },
  });
  assertRefused(result, 'path:computed-path');
  assert.match(
    result.report.subjects[0]?.preconditions.find(
      (entry) => entry.id === 'computed-path',
    )?.detail ?? '',
    /is a link/,
  );
});

test('refused (path): a path that is not named for the claim', pathCase, () => {
  const fixture = fresh();
  const other = join(fixture.parent, 'some-other-name');
  const result = exercise(fixture, {
    request: { path: other },
    confirmation: () => confirmationRead([record('d1', other)]),
    prepare: (f) => mkdirSync(join(f.parent, 'some-other-name')),
  });
  assertRefused(result, 'path:computed-path');
});

test(
  'failure: parents that change after the destination exists leave the source untouched',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => {
        const real = realFs();
        let created = false;
        return {
          mkdir: (path: string, mode: number) => {
            real.mkdir(path, mode);
            if (path === f.destination) created = true;
          },
          directoryIdentity: (path: string) =>
            created && path === join(f.state, 'idd-skill')
              ? '7:7'
              : real.directoryIdentity(path),
        };
      },
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /changed after inspection/);
    // The destination was created before the check fired, so the pre-rename
    // guard, not the creation step's own, refused.
    assert.deepEqual(
      result.report.actions.map((action) => action.id),
      ['destination-created'],
    );
    assert.equal(
      readFileSync(join(fixture.worktree, 'work.txt'), 'utf8'),
      'precious\n',
    );
    assert.equal(result.report.destinations.length, 0);
    assert.match(
      result.failure?.nextAction ?? '',
      new RegExp(fixture.destination),
    );
  },
);

test(
  'refused: a worktree mid-rebase or mid-bisect on the branch, read by the real inspector',
  pathCase,
  () => {
    for (const [name, mark] of [
      [
        'rebase',
        (gitDir: string) => {
          mkdirSync(join(gitDir, 'rebase-merge'));
          writeFileSync(
            join(gitDir, 'rebase-merge', 'head-name'),
            `refs/heads/${BRANCH}\n`,
          );
        },
      ],
      [
        'bisect',
        (gitDir: string) =>
          writeFileSync(join(gitDir, 'BISECT_START'), `${BRANCH}\n`),
      ],
    ] as const) {
      const fixture = fresh();
      const result = exercise(fixture, {
        request: {
          inspectLocalWorktrees: () =>
            inspectLocalWorktreeBranchPrefix(
              ISSUE,
              fixture.primary,
              fixtureEnv(),
            ),
        },
        prepare: (f) => {
          leftoverBranch(f);
          const other = join(f.root, 'detached');
          git(f.primary, ['worktree', 'add', '--quiet', '--detach', other]);
          mark(git(other, ['rev-parse', '--absolute-git-dir']));
        },
      });
      assertRefused(result, 'branch:not-checked-out');
      assert.ok(result.report.subjects.length > 0, name);
    }
  },
);

test('refused: a symbolic ref is never deleted, so its target survives', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      leftoverBranch(f);
      git(f.primary, ['update-ref', '-d', `refs/heads/${BRANCH}`]);
      // The claim's branch is an alias of a real branch that must survive.
      leftoverBranch(f, 'precious-target');
      git(f.primary, [
        'symbolic-ref',
        `refs/heads/${BRANCH}`,
        'refs/heads/precious-target',
      ]);
    },
  });
  assertRefused(result, 'branch:not-symbolic-ref');
  assert.notEqual(
    git(fixture.primary, ['branch', '--list', 'precious-target']),
    '',
  );
});

test('refused (path): a state root inside the leftover path', pathCase, () => {
  const fixture = fresh();
  const inside = join(fixture.worktree, 'state');
  const result = exercise(fixture, {
    confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
    prepare: (f) => {
      leftoverPath(f);
      mkdirSync(join(f.worktree, 'state'), { mode: 0o700 });
    },
    fs: () => ({ stateRoot: inside }),
  });
  assertRefused(result, 'path:destination');
  assert.match(
    result.report.subjects[0]?.preconditions.find(
      (entry) => entry.id === 'destination',
    )?.detail ?? '',
    /inside the leftover path/,
  );
});

test(
  'apply: a successful path preservation names the parents it created too',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
    });
    assert.equal(result.report.outcome, 'preserved');
    const created = result.report.actions.find(
      (action) => action.id === 'destination-created',
    );
    assert.match(
      created?.detail ?? '',
      new RegExp(join(fixture.state, 'idd-skill', 'b1-preserved')),
    );
    assert.match(created?.detail ?? '', new RegExp(fixture.destination));
  },
);

test('refused: the backup ref is a symbolic ref, even one that resolves to the tip', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      const tip = leftoverBranch(f);
      git(f.primary, [
        'symbolic-ref',
        `refs/idd-b1/${ISSUE}/${tip}`,
        `refs/heads/${BRANCH}`,
      ]);
    },
  });
  assertRefused(result, 'branch:backup-ref-compatible');
  assert.match(
    result.report.subjects[0]?.preconditions.find(
      (entry) => entry.id === 'backup-ref-compatible',
    )?.detail ?? '',
    /symbolic ref/,
  );
});

test('refused: a ref collides with the backup ref path, in the dry run too', () => {
  for (const mode of ['dry-run', 'apply'] as const) {
    const fixture = fresh();
    const result = exercise(fixture, {
      request: { mode },
      prepare: (f) => {
        const tip = leftoverBranch(f);
        // A ref named refs/idd-b1/<issue> blocks every ref below it.
        git(f.primary, ['update-ref', `refs/idd-b1/${ISSUE}`, tip]);
      },
    });
    assertRefused(result, 'branch:backup-ref-compatible');
    assert.match(
      result.report.subjects[0]?.preconditions.find(
        (entry) => entry.id === 'backup-ref-compatible',
      )?.detail ?? '',
      /collides/,
    );
  }
});

test(
  'failure: a throw inside the destination creation still names the directories made',
  pathCase,
  () => {
    const fixture = fresh();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => {
        const real = realFs();
        let made = false;
        return {
          mkdir: (path: string, mode: number) => {
            real.mkdir(path, mode);
            if (path === f.destination) made = true;
          },
          directoryIdentity: (path: string) => {
            if (made && path === f.destination) throw new Error('EIO');
            return real.directoryIdentity(path);
          },
        };
      },
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(result.failure?.detail ?? '', /threw: EIO/);
    assert.equal(
      readFileSync(join(fixture.worktree, 'work.txt'), 'utf8'),
      'precious\n',
    );
    assert.equal(existsSync(fixture.destination), true);
    assert.match(
      result.failure?.nextAction ?? '',
      new RegExp(fixture.destination),
    );
    assert.doesNotMatch(result.failure?.nextAction ?? '', /changed nothing/);
  },
);

test(
  'refused (path): a registered worktree is the same entry under another name',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => ({
        lstatEntry: (path: string) =>
          // The primary checkout reports the identity of the leftover entry, as
          // the same inode spelled differently would.
          path === f.primary
            ? real.lstatEntry(f.worktree)
            : real.lstatEntry(path),
      }),
    });
    assertRefused(result, 'path:not-registered-worktree');
  },
);

test(
  'failure: a replaced entry is not moved back after the destination parents change',
  pathCase,
  () => {
    const fixture = fresh();
    const real = realFs();
    const moved = join(fixture.destination, basename(fixture.worktree));
    const result = exercise(fixture, {
      confirmation: () => confirmationRead([record('d1', fixture.worktree)]),
      prepare: leftoverPath,
      fs: (f) => {
        let renames = 0;
        let movedReads = 0;
        return {
          ...parentsChangeAfterRename(f),
          rename: (from: string, to: string) => {
            renames += 1;
            real.rename(from, to);
          },
          // The first read of the moved entry is the identity check after the
          // rename. Any later read sees a replacement, as a writer racing the
          // rollback would leave.
          lstatEntry: (path: string) => {
            const info = real.lstatEntry(path);
            if (path !== moved || info === null) return info;
            movedReads += 1;
            return movedReads > 1 ? { ...info, identity: '9:9' } : info;
          },
          directoryIdentity: (path: string) =>
            renames > 0 && path === join(f.state, 'idd-skill')
              ? '7:7'
              : real.directoryIdentity(path),
        };
      },
    });
    assert.equal(result.report.outcome, 'failed');
    assert.match(
      result.failure?.detail ?? '',
      /no longer matches the identity/,
    );
    assert.equal(readFileSync(join(moved, 'work.txt'), 'utf8'), 'precious\n');
    assert.equal(existsSync(fixture.worktree), false, 'nothing was moved back');
    assert.deepEqual(result.report.destinations, [
      { from: fixture.worktree, to: moved },
    ]);
  },
);

test('apply: a multi-line branch description counts as one key, and the removal is local', () => {
  const fixture = fresh();
  const tip = leftoverBranch(fixture);
  git(fixture.primary, [
    'config',
    `branch.${BRANCH}.description`,
    'first line\nsecond-token continues here\nthird',
  ]);
  git(fixture.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
  const result = exercise(fixture);
  assert.equal(result.failure, null);
  assert.equal(result.report.outcome, 'preserved');
  const removal = result.report.actions.find(
    (action) => action.id === 'config-section-removed',
  );
  assert.match(removal?.detail ?? '', /\(branch\.[^ ]+\.description, /);
  assert.doesNotMatch(removal?.detail ?? '', /second-token|third/);
  assert.equal(
    result.report.subjects[0]?.preconditions.find(
      (entry) => entry.id === 'config-readable',
    )?.detail,
    `the section branch.${BRANCH} holds 2 key(s)`,
  );
  assert.ok(
    result.calls.some((call) => /config --local --remove-section/.test(call)),
    result.calls.join('\n'),
  );
  assert.equal(git(fixture.primary, ['cat-file', '-t', tip]), 'commit');
});

test('refused: an unexpected line in the config key list', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    prepare: (f) => {
      leftoverBranch(f);
      git(f.primary, ['config', `branch.${BRANCH}.remote`, 'origin']);
    },
    hook: (_f, _file, args) =>
      args.includes('--name-only')
        ? okResult('branch.other.remote\n')
        : undefined,
  });
  assertRefused(result, 'branch:config-readable');
});

test('refused: a b1Leftover record that names a set, though the contract pairs it with set=none', () => {
  const fixture = fresh();
  const result = exercise(fixture, {
    confirmation: () =>
      confirmationRead([record('d1', BRANCH, { set: 'some-set' })]),
    prepare: leftoverBranch,
  });
  assertRefused(result, 'decision-pairing');
  assert.match(pairingDetail(result.report), /matches no record/);
});
