import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeWorkerBudget,
  readInstructionsReport,
  readOneMinuteLoad,
  sortPathsInByteOrder,
  type WorkerBudgetReaders,
  type WorkerBudgetRequest,
} from '../src/scripts/idd-worker-budget.mts';
import { trackTempDirectories } from './temp-fixtures.mts';
import { fixtureEnv, spawnHelperBinWithEnvelope } from './test-utils.mts';

const GIB = 1024 * 1024 * 1024;

function readers(
  overrides: Partial<WorkerBudgetReaders> = {},
): WorkerBudgetReaders {
  return {
    load1m: () => 0.5,
    coreCount: () => 4,
    procMemAvailableBytes: () => 3 * GIB,
    freeMemoryBytes: () => 3 * GIB,
    rateLimit: () => ({
      resources: {
        core: { remaining: 5_000 },
        graphql: { remaining: 5_000 },
      },
    }),
    ...overrides,
  };
}

function request(
  overrides: Partial<WorkerBudgetRequest> = {},
): WorkerBudgetRequest {
  return {
    maxWorkers: 3,
    running: 0,
    startable: 2,
    harnessLimit: null,
    ...overrides,
  };
}

test('worker budget reports each reachable limiting factor', () => {
  const cases: Array<{
    name: string;
    request?: Partial<WorkerBudgetRequest>;
    readers?: Partial<WorkerBudgetReaders>;
    factor: string;
  }> = [
    {
      name: 'host load',
      readers: { load1m: () => 4.01 },
      factor: 'host-load',
    },
    {
      name: 'zero core count',
      readers: { coreCount: () => 0, load1m: () => 0 },
      factor: 'host-load',
    },
    {
      name: 'unavailable host load',
      readers: { load1m: () => Number.NaN },
      factor: 'host-load',
    },
    {
      name: 'Windows unsupported host load',
      readers: { load1m: () => readOneMinuteLoad([0, 0, 0], 'win32') },
      factor: 'host-load',
    },
    {
      name: 'host memory',
      readers: { procMemAvailableBytes: () => 2 * GIB - 1 },
      factor: 'host-memory',
    },
    {
      name: 'unavailable API',
      readers: {
        rateLimit: () => {
          throw new Error('load control refused request');
        },
      },
      factor: 'api-unavailable',
    },
    {
      name: 'API quota',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 499 },
            graphql: { remaining: 500 },
          },
        }),
      },
      factor: 'api-rate-limit',
    },
    {
      name: 'GraphQL quota',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 500 },
            graphql: { remaining: 499 },
          },
        }),
      },
      factor: 'api-rate-limit',
    },
    {
      name: 'session cap',
      request: { maxWorkers: 1, running: 1, startable: 2 },
      factor: 'cap',
    },
    {
      name: 'harness limit',
      request: { maxWorkers: 3, harnessLimit: 1, startable: 2 },
      factor: 'harness-limit',
    },
    {
      name: 'startable candidates',
      request: { startable: 0 },
      factor: 'candidates',
    },
  ];

  for (const scenario of cases) {
    const result = computeWorkerBudget(
      request(scenario.request),
      readers(scenario.readers),
    );
    assert.equal(result.limitingFactor, scenario.factor, scenario.name);
    if (
      [
        'host-load',
        'host-memory',
        'api-unavailable',
        'api-rate-limit',
      ].includes(scenario.factor)
    ) {
      assert.equal(result.slots, 0, scenario.name);
    }
  }
});

test('worker budget applies the documented limiting-factor precedence', () => {
  const bothHostSignals = computeWorkerBudget(
    request(),
    readers({
      load1m: () => 5,
      procMemAvailableBytes: () => 1,
      rateLimit: () => {
        throw new Error('rate-limit read failed');
      },
    }),
  );
  assert.equal(bothHostSignals.limitingFactor, 'host-load');

  const memoryBeforeApi = computeWorkerBudget(
    request(),
    readers({
      procMemAvailableBytes: () => 1,
      rateLimit: () => {
        throw new Error('rate-limit read failed');
      },
    }),
  );
  assert.equal(memoryBeforeApi.limitingFactor, 'host-memory');

  const unavailableBeforeQuota = computeWorkerBudget(
    request(),
    readers({
      rateLimit: () => ({ resources: { core: { remaining: 1 } } }),
    }),
  );
  assert.equal(unavailableBeforeQuota.limitingFactor, 'api-unavailable');

  const capBeforeHarness = computeWorkerBudget(
    request({ maxWorkers: 2, harnessLimit: 2, running: 2 }),
    readers(),
  );
  assert.equal(capBeforeHarness.limitingFactor, 'cap');

  const rateLimitBeforeCap = computeWorkerBudget(
    request({ maxWorkers: 1, running: 1 }),
    readers({
      rateLimit: () => ({
        resources: {
          core: { remaining: 499 },
          graphql: { remaining: 2_000 },
        },
      }),
    }),
  );
  assert.equal(rateLimitBeforeCap.limitingFactor, 'api-rate-limit');

  const harnessBeforeCandidates = computeWorkerBudget(
    request({ maxWorkers: 3, harnessLimit: 1, startable: 1 }),
    readers(),
  );
  assert.equal(harnessBeforeCandidates.limitingFactor, 'harness-limit');
});

test('running at or above the worker cap returns zero slots', () => {
  const oneWorkerAllowed = computeWorkerBudget(
    request({ maxWorkers: 1, running: 0, startable: 1 }),
    readers(),
  );
  assert.equal(oneWorkerAllowed.slots, 1);
  assert.equal(oneWorkerAllowed.limitingFactor, 'cap');

  for (const running of [1, 2, 8]) {
    const result = computeWorkerBudget(
      request({ maxWorkers: 1, running }),
      readers(),
    );
    assert.equal(result.slots, 0);
    assert.equal(result.limitingFactor, 'cap');
  }
});

test('Windows load averages are treated as unavailable, not zero load', () => {
  assert.equal(readOneMinuteLoad([0, 0, 0], 'win32'), null);
  assert.equal(readOneMinuteLoad([0.5, 0.4, 0.3], 'linux'), 0.5);
  const result = computeWorkerBudget(
    request(),
    readers({ load1m: () => readOneMinuteLoad([0, 0, 0], 'win32') }),
  );
  assert.equal(result.load1m, null);
  assert.equal(result.slots, 0);
  assert.equal(result.limitingFactor, 'host-load');
});

test('a successful rate-limit response missing either resource fails closed', () => {
  for (const rateLimit of [
    { resources: { graphql: { remaining: 2_000 } } },
    { resources: { core: { remaining: 2_000 } } },
  ]) {
    const result = computeWorkerBudget(
      request(),
      readers({ rateLimit: () => rateLimit }),
    );
    assert.equal(result.slots, 0);
    assert.equal(result.limitingFactor, 'api-unavailable');
    assert.equal(
      result.restRemaining,
      rateLimit.resources.core?.remaining ?? null,
    );
    assert.equal(
      result.graphqlRemaining,
      rateLimit.resources.graphql?.remaining ?? null,
    );
  }
});

test('a load-control not-dispatched refusal is treated as API unavailable', () => {
  const refusal = Object.assign(new Error('request was not dispatched'), {
    notDispatched: true,
  });
  const result = computeWorkerBudget(
    request(),
    readers({
      rateLimit: () => {
        throw refusal;
      },
    }),
  );
  assert.equal(result.slots, 0);
  assert.equal(result.limitingFactor, 'api-unavailable');
  assert.equal(result.restRemaining, null);
  assert.equal(result.graphqlRemaining, null);
});

test('--no-network skips the API read without blocking worker dispatch', () => {
  let readCount = 0;
  const result = computeWorkerBudget(
    request({ noNetwork: true }),
    readers({
      rateLimit: () => {
        readCount += 1;
        throw new Error('must not be called');
      },
    }),
  );
  assert.equal(readCount, 0);
  assert.equal(result.slots, 2);
  assert.equal(result.limitingFactor, 'candidates');
  assert.equal(result.restRemaining, null);
  assert.equal(result.graphqlRemaining, null);
});

test('available memory falls back from /proc/meminfo to os.freemem()', () => {
  const result = computeWorkerBudget(
    request(),
    readers({
      procMemAvailableBytes: () => {
        throw new Error('no /proc/meminfo');
      },
      freeMemoryBytes: () => 4 * GIB,
    }),
  );
  assert.equal(result.availableMemoryBytes, 4 * GIB);
  assert.equal(result.limitingFactor, 'candidates');
});

test('worker budget admits slots at each exact threshold', () => {
  const atThreshold = [
    { name: 'load equal to the core count', readers: { load1m: () => 4 } },
    {
      name: 'memory at the floor',
      readers: { procMemAvailableBytes: () => 2 * GIB },
    },
    {
      name: 'quota at the floor',
      readers: {
        rateLimit: () => ({
          resources: {
            core: { remaining: 500 },
            graphql: { remaining: 500 },
          },
        }),
      },
    },
  ];
  for (const scenario of atThreshold) {
    const result = computeWorkerBudget(request(), readers(scenario.readers));
    assert.equal(result.slots, 2, scenario.name);
    assert.equal(result.limitingFactor, 'candidates', scenario.name);
  }
});

test('worker budget reads an idle Linux load as zero, not unavailable', () => {
  assert.equal(readOneMinuteLoad([0, 0, 0], 'linux'), 0);
  const result = computeWorkerBudget(
    request(),
    readers({ load1m: () => readOneMinuteLoad([0, 0, 0], 'linux') }),
  );
  assert.equal(result.limitingFactor, 'candidates');
  assert.equal(result.slots, 2);
});

test('worker budget fails closed on a fractional core count and admits a single-core host', () => {
  const fractional = computeWorkerBudget(
    request(),
    readers({ coreCount: () => 2.5 }),
  );
  assert.equal(fractional.limitingFactor, 'host-load');
  assert.equal(fractional.slots, 0);

  const singleCore = computeWorkerBudget(
    request(),
    readers({ coreCount: () => 1, load1m: () => 0.5 }),
  );
  assert.equal(singleCore.limitingFactor, 'candidates');
  assert.equal(singleCore.slots, 2);
});

test('the helper CLI rejects a worker count beyond the safe integer range', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      'scripts/idd-worker-budget.mjs',
      '--running',
      '9007199254740993',
      '--startable',
      '1',
      '--no-network',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /invalid value for argument: --running/,
  );
});

// --- --instructions-since (issue #4376) ------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'idd-worker-budget.mjs');
const makeTempDir = trackTempDirectories();

/** The output keys of a run without the flag, in the order the helper writes them. */
const BUDGET_KEYS = [
  'slots',
  'limitingFactor',
  'maxWorkers',
  'harnessLimit',
  'running',
  'startable',
  'load1m',
  'coreCount',
  'availableMemoryBytes',
  'restRemaining',
  'graphqlRemaining',
];

interface FixtureRepo {
  dir: string;
  /** Run git in the fixture; fixture settings win over the host's. */
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  /** Stage everything and commit; returns the new commit's SHA. */
  commit: (message: string) => string;
  /** Point `refs/remotes/origin/<branch>` at `sha`; the helper never fetches. */
  track: (branch: string, sha: string) => void;
}

/**
 * A throwaway repository with hostile repository-local settings: the helper
 * strips `GIT_CONFIG*`, so a repository-local setting is the way to prove its
 * output does not depend on the user's git configuration.
 */
function makeFixtureRepo(): FixtureRepo {
  const dir = makeTempDir(join(tmpdir(), 'idd-worker-budget-git-'));
  const env = fixtureEnv();
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd: dir, env, encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'diff.relative', 'true');
  git('config', 'diff.renames', 'copies');
  git('config', 'core.quotePath', 'true');
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  // Git's own order would list these in reverse byte order.
  writeFileSync(
    join(dir, '.git', 'idd-order.txt'),
    [
      'other.txt',
      'docs/idd-workflow.md',
      '.github/instructions/old-name.md',
      '.github/instructions/new-name.md',
      '.github/instructions/deleted.md',
      '.github/instructions/changed.md',
      '.github/instructions/Upper.md',
    ].join('\n'),
  );
  git('config', 'diff.orderFile', join(dir, '.git', 'idd-order.txt'));
  return {
    dir,
    git,
    write,
    commit: (message) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    track: (branch, sha) => {
      git('update-ref', `refs/remotes/origin/${branch}`, sha);
    },
  };
}

/** The shared history: two commits that change, delete, rename, and add. */
function makeTwoCommitFixture(): FixtureRepo & {
  first: string;
  second: string;
} {
  const repo = makeFixtureRepo();
  repo.write('.github/instructions/changed.md', 'one\n'.repeat(20));
  repo.write('.github/instructions/deleted.md', 'gone\n'.repeat(20));
  repo.write('.github/instructions/old-name.md', 'renamed\n'.repeat(20));
  repo.write('docs/idd-workflow.md', 'workflow\n');
  repo.write('other.txt', 'other\n');
  const first = repo.commit('first');
  repo.write('.github/instructions/changed.md', 'two\n'.repeat(20));
  repo.git('rm', '-q', '.github/instructions/deleted.md');
  repo.git(
    'mv',
    '.github/instructions/old-name.md',
    '.github/instructions/new-name.md',
  );
  repo.write('.github/instructions/Upper.md', 'added\n');
  // A name with a space and a non-ASCII letter, a nested file, and paths that
  // only look like the two instruction locations.
  repo.write('.github/instructions/café x.md', 'accent\n');
  repo.write('.github/instructions/sub/dir.md', 'nested\n');
  repo.write('.github/instructions-x/y.md', 'sibling directory\n');
  repo.write('docs/idd-workflow.mdx', 'sibling file\n');
  repo.write('other.txt', 'other, changed\n');
  const second = repo.commit('second');
  repo.track('main', second);
  repo.git(
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );
  return Object.assign(repo, { first, second });
}

interface BudgetRun {
  status: number | null;
  stderr: string;
  output: Record<string, unknown>;
}

/** Run the generated helper in `cwd`; `--startable 0` makes `slots` 0 on any host. */
function runBudget(
  cwd: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = fixtureEnv(),
): BudgetRun {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--running',
      '0',
      '--startable',
      '0',
      '--no-network',
      ...extraArgs,
    ],
    { cwd, env, encoding: 'utf8' },
  );
  let output: Record<string, unknown> = {};
  try {
    output = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    // A run that failed before printing keeps the empty object.
  }
  return { status: result.status, stderr: result.stderr, output };
}

test('--instructions-since lists changed, deleted, renamed and added paths in byte order', () => {
  const repo = makeTwoCommitFixture();
  const expected = [
    '.github/instructions/Upper.md',
    '.github/instructions/café x.md',
    '.github/instructions/changed.md',
    '.github/instructions/deleted.md',
    '.github/instructions/new-name.md',
    '.github/instructions/old-name.md',
    '.github/instructions/sub/dir.md',
  ];
  const run = runBudget(repo.dir, ['--instructions-since', repo.first]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.output.instructionsChanged, expected);
  assert.equal(run.output.instructionsTip, repo.second);
  assert.ok(!('instructionsChangedError' in run.output));
  assert.deepEqual(Object.keys(run.output), [
    ...BUDGET_KEYS,
    'instructionsTip',
    'instructionsChanged',
  ]);
  assert.deepEqual(
    readInstructionsReport({ since: repo.first, policy: null, cwd: repo.dir }),
    { instructionsTip: repo.second, instructionsChanged: expected },
  );
});

test('--instructions-since ignores git variables that change how a pathspec is read', () => {
  const repo = makeTwoCommitFixture();
  const expected = readInstructionsReport({
    since: repo.first,
    policy: null,
    cwd: repo.dir,
  });
  assert.ok((expected.instructionsChanged?.length ?? 0) > 0);
  // With these pathspecs only the literal-pathspecs variable changes git's
  // answer (it makes the `:(top,literal)` prefix match nothing); the other
  // three are removed defensively, and the loop keeps them from regressing.
  for (const name of [
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ]) {
    assert.deepEqual(
      readInstructionsReport({
        since: repo.first,
        policy: null,
        cwd: repo.dir,
        environment: { ...process.env, [name]: '1' },
      }),
      expected,
      name,
    );
  }
});

test('--instructions-since reports a change until the tip is passed back', () => {
  const repo = makeTwoCommitFixture();
  const first = runBudget(repo.dir, ['--instructions-since', repo.first]);
  const tip = first.output.instructionsTip as string;
  assert.equal(tip, repo.second);

  const second = runBudget(repo.dir, ['--instructions-since', tip]);
  assert.equal(second.output.instructionsTip, repo.second);
  assert.deepEqual(second.output.instructionsChanged, []);

  repo.write('.github/instructions/changed.md', 'three\n'.repeat(20));
  const third = repo.commit('third');
  repo.track('main', third);
  const afterThird = runBudget(repo.dir, ['--instructions-since', tip]);
  assert.equal(afterThird.output.instructionsTip, third);
  assert.deepEqual(afterThird.output.instructionsChanged, [
    '.github/instructions/changed.md',
  ]);
});

test('--instructions-since gives the same lists from a subdirectory with no configured branch', () => {
  const repo = makeTwoCommitFixture();
  const fromRoot = runBudget(repo.dir, ['--instructions-since', repo.first]);
  for (const subdirectory of ['docs', '.github/instructions']) {
    const cwd = join(repo.dir, subdirectory);
    const nested = runBudget(cwd, ['--instructions-since', repo.first]);
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(
      nested.output.instructionsChanged,
      fromRoot.output.instructionsChanged,
      subdirectory,
    );
    assert.equal(nested.output.instructionsTip, repo.second, subdirectory);
    const caught = runBudget(cwd, ['--instructions-since', repo.second]);
    assert.deepEqual(caught.output.instructionsChanged, [], subdirectory);
  }
});

test('--instructions-since lists a docs-only change to docs/idd-workflow.md', () => {
  const repo = makeTwoCommitFixture();
  repo.write('docs/idd-workflow.md', 'workflow, changed\n');
  repo.write('docs/elsewhere.md', 'not an instruction file\n');
  const third = repo.commit('docs only');
  repo.track('main', third);
  const run = runBudget(repo.dir, ['--instructions-since', repo.second]);
  assert.deepEqual(run.output.instructionsChanged, ['docs/idd-workflow.md']);
  assert.equal(run.output.instructionsTip, third);
});

test('--instructions-since resolves the base ref from developmentBranch, else origin/HEAD', () => {
  const repo = makeTwoCommitFixture();
  repo.write('.github/instructions/late.md', 'late\n');
  const third = repo.commit('late');
  repo.track('main', third);
  repo.track('release', repo.second);

  // Absent: origin/HEAD names main, whose tip is the third commit.
  const absent = readInstructionsReport({
    since: repo.first,
    policy: {},
    cwd: repo.dir,
  });
  assert.equal(absent.instructionsTip, third);
  assert.ok(
    absent.instructionsChanged?.includes('.github/instructions/late.md'),
  );

  // Configured: the tip of that branch's remote-tracking ref.
  const configured = readInstructionsReport({
    since: repo.first,
    policy: { developmentBranch: 'release' },
    cwd: repo.dir,
  });
  assert.equal(configured.instructionsTip, repo.second);
  assert.ok(
    !configured.instructionsChanged?.includes('.github/instructions/late.md'),
  );

  // The CLI reads the same value from the repository's policy file.
  repo.write(
    '.github/idd/config.json',
    `${JSON.stringify({ developmentBranch: 'release' })}\n`,
  );
  const viaCli = runBudget(repo.dir, ['--instructions-since', repo.first]);
  assert.equal(viaCli.output.instructionsTip, repo.second);

  // Invalid: a failure, with no tip.
  for (const developmentBranch of ['refs/heads/main', '-q', 5, '']) {
    const invalid = readInstructionsReport({
      since: repo.first,
      policy: { developmentBranch },
      cwd: repo.dir,
    });
    assert.equal(invalid.instructionsChanged, null, String(developmentBranch));
    assert.equal(invalid.instructionsTip, null, String(developmentBranch));
    assert.match(invalid.instructionsChangedError ?? '', /developmentBranch/);
  }
  writeFileSync(
    join(repo.dir, '.github/idd/config.json'),
    `${JSON.stringify({ developmentBranch: 'refs/heads/main' })}\n`,
  );
  const invalidViaCli = runBudget(repo.dir, [
    '--instructions-since',
    repo.first,
  ]);
  assert.equal(invalidViaCli.status, 0, invalidViaCli.stderr);
  assert.equal(invalidViaCli.output.instructionsChanged, null);
  assert.match(
    String(invalidViaCli.output.instructionsChangedError),
    /developmentBranch/,
  );
  assert.equal(invalidViaCli.output.instructionsTip, null);
});

test('--instructions-since reports each git failure and leaves the budget alone', () => {
  const repo = makeTwoCommitFixture();
  const control = runBudget(repo.dir);

  // A well-formed SHA that the repository lacks: the tip still resolves.
  const missing = runBudget(repo.dir, ['--instructions-since', '1234567']);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.output.instructionsChanged, null);
  assert.equal(missing.output.instructionsTip, repo.second);
  assert.match(String(missing.output.instructionsChangedError), /1234567/);

  // A directory that is not a repository.
  const outside = makeTempDir(join(tmpdir(), 'idd-worker-budget-plain-'));
  const notRepository = runBudget(
    outside,
    ['--instructions-since', repo.first],
    {
      ...fixtureEnv(),
      GIT_CEILING_DIRECTORIES: dirname(outside),
    },
  );
  assert.equal(notRepository.status, 0, notRepository.stderr);
  assert.equal(notRepository.output.instructionsChanged, null);
  assert.equal(notRepository.output.instructionsTip, null);
  assert.notEqual(notRepository.output.instructionsChangedError, '');

  // A repository with no origin/HEAD and no configured branch.
  repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const noOriginHead = runBudget(repo.dir, [
    '--instructions-since',
    repo.first,
  ]);
  assert.equal(noOriginHead.status, 0, noOriginHead.stderr);
  assert.equal(noOriginHead.output.instructionsChanged, null);
  assert.equal(noOriginHead.output.instructionsTip, null);
  assert.match(
    String(noOriginHead.output.instructionsChangedError),
    /origin\/HEAD/,
  );

  for (const run of [missing, notRepository, noOriginHead]) {
    assert.equal(run.output.slots, control.output.slots);
    assert.equal(run.output.maxWorkers, control.output.maxWorkers);
    assert.equal(run.output.startable, control.output.startable);
    assert.ok(typeof run.output.instructionsChangedError === 'string');
  }
});

test('--instructions-since rejects a SHA that is not an ancestor of the tip', () => {
  const repo = makeTwoCommitFixture();
  repo.git('switch', '-q', '-c', 'side', repo.first);
  repo.write('.github/instructions/side.md', 'side\n');
  const side = repo.commit('side');
  repo.git('switch', '-q', 'main');
  const run = runBudget(repo.dir, ['--instructions-since', side]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.instructionsChanged, null);
  assert.equal(run.output.instructionsTip, repo.second);
  assert.match(String(run.output.instructionsChangedError), /not an ancestor/);
});

test('--instructions-since does not trust a ref whose name looks like the hex digits', () => {
  const repo = makeTwoCommitFixture();
  repo.git('branch', 'abcdef1', repo.second);
  const report = readInstructionsReport({
    since: 'abcdef1',
    policy: null,
    cwd: repo.dir,
  });
  assert.equal(report.instructionsChanged, null);
  assert.equal(report.instructionsTip, repo.second);
  assert.match(report.instructionsChangedError ?? '', /not a commit/);
});

test('--instructions-since never throws when git cannot run', () => {
  const repo = makeTwoCommitFixture();
  const report = readInstructionsReport({
    since: repo.first,
    policy: null,
    cwd: repo.dir,
    environment: { ...process.env, PATH: '', Path: '' },
  });
  assert.equal(report.instructionsChanged, null);
  assert.equal(report.instructionsTip, null);
  assert.match(report.instructionsChangedError ?? '', /git could not run/);
});

test('without --instructions-since the output has only the budget keys', () => {
  const repo = makeTwoCommitFixture();
  const run = runBudget(repo.dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(run.output), BUDGET_KEYS);
});

test('--instructions-since accepts 7 to 40 hexadecimal digits in either case', () => {
  const repo = makeTwoCommitFixture();
  for (const value of [
    repo.first.slice(0, 7),
    repo.first.toUpperCase(),
    'A'.repeat(40),
  ]) {
    const run = runBudget(repo.dir, ['--instructions-since', value]);
    assert.equal(run.status, 0, `${value}: ${run.stderr}`);
    assert.ok('instructionsChanged' in run.output, value);
  }
  assert.deepEqual(
    runBudget(repo.dir, ['--instructions-since', repo.first.toUpperCase()])
      .output.instructionsChanged,
    runBudget(repo.dir, ['--instructions-since', repo.first]).output
      .instructionsChanged,
  );
});

test('--instructions-since reports a malformed value as a usage error', () => {
  const repo = makeTwoCommitFixture();
  for (const value of ['abcdef', 'a'.repeat(41), 'xyz1234', 'abc def1']) {
    const run = spawnHelperBinWithEnvelope(
      'idd-worker-budget.mjs',
      [
        '--running',
        '0',
        '--startable',
        '0',
        '--no-network',
        '--instructions-since',
        value,
      ],
      { cwd: repo.dir },
    );
    assert.equal(run.status, 1, value);
    assert.equal(run.envelope?.kind, 'usage', value);
    assert.equal(run.envelope?.exitCode, 1, value);
  }
});

test('--help lists --instructions-since', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--instructions-since <sha>/);
});

test('instruction paths sort by UTF-8 bytes, not by UTF-16 code units', () => {
  assert.deepEqual(sortPathsInByteOrder(['b', 'B', 'a-b', 'a', 'é', 'e']), [
    'B',
    'a',
    'a-b',
    'b',
    'e',
    'é',
  ]);
  // U+1F600 encodes as F0 9F 98 80 and U+FF5E as EF BD 9E, but its UTF-16
  // surrogate D83D sorts before FF5E, so the default sort gets this wrong.
  assert.deepEqual(sortPathsInByteOrder(['\u{1F600}', '～']), [
    '～',
    '\u{1F600}',
  ]);
});
