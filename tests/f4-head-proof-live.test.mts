import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  claimCheckSpawnOptions,
  classifyClaimAssertResult,
  classifyLocalRefReads,
  createLiveF4HeadProofDeps,
  matchRegisteredWorktree,
  originMismatchMessage,
  resolveCheckoutRepository,
  selectPullRequests,
} from '../src/scripts/f4-head-proof-live.mts';

// kurone-kito/idd-skill#4368: the pure classifiers behind the production
// wiring of the F4 head-proof flow. The `git`, `gh`, and spawn calls around
// them are thin; what they conclude from their output is tested here.

const CLAIM = '95ad0071-ebaa-4155-91ac-ceeae7897bf8';
const BRANCH = 'issue/4368-feat-post-idd-marker-add-f4-head-proof';
const TIP = 'a'.repeat(40);

function routing(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'already_owned',
    action: 'keep',
    reason: 'claim-id-match',
    active_claim: { claim_id: CLAIM, branch: BRANCH },
    ...overrides,
  });
}

test('classifyClaimAssertResult: exit 0 with an owned keep verdict for this claim is owned', () => {
  assert.deepEqual(classifyClaimAssertResult(0, routing(), CLAIM), {
    status: 'owned',
    branch: BRANCH,
  });
});

test('classifyClaimAssertResult: a non-zero exit is not-owned for every routing state and action', () => {
  for (const state of [
    'unclaimed',
    'stale',
    'non_inheritable',
    'disputed',
    'owner_evidence_required',
    'already_owned',
    'local_worktree_occupied',
  ]) {
    assert.deepEqual(
      classifyClaimAssertResult(1, routing({ state, action: 'stop' }), CLAIM),
      { status: 'not-owned' },
      state,
    );
  }
  for (const action of ['keep', 're_claim', 'stop', 'takeover']) {
    assert.deepEqual(
      classifyClaimAssertResult(
        1,
        routing({ state: 'disputed', action }),
        CLAIM,
      ),
      { status: 'not-owned' },
      action,
    );
  }
});

test('classifyClaimAssertResult: a non-zero exit with a routing verdict is not-owned', () => {
  for (const body of [
    routing({ state: 'owner_evidence_required', action: 'stop' }),
    routing({
      state: 'local_worktree_occupied',
      action: 'stop',
      active_claim: null,
    }),
    routing({ state: 'disputed', action: 'stop' }),
  ]) {
    assert.deepEqual(classifyClaimAssertResult(1, body, CLAIM), {
      status: 'not-owned',
    });
  }
});

test('classifyClaimAssertResult: output that is not a routing verdict is unreadable', () => {
  for (const [exited, stdout] of [
    [1, ''],
    [0, ''],
    [1, 'not json'],
    [0, 'null'],
    [0, '[]'],
    [1, JSON.stringify({ state: 'already_owned' })],
    [1, JSON.stringify({ action: 'keep' })],
  ] as const) {
    assert.equal(
      classifyClaimAssertResult(exited, stdout, CLAIM).status,
      'unreadable',
      `${exited} ${stdout}`,
    );
  }
});

test('classifyClaimAssertResult: a non-zero exit with a state or action outside the routing vocabulary is unreadable', () => {
  // Only the verdicts resume-claim-routing can print prove that the claim is
  // not this session's; a value it never prints does not, and holds instead.
  for (const body of [
    routing({ state: 'future_state', action: 'stop' }),
    routing({ state: 'disputed', action: 'teleport' }),
    routing({ state: 42, action: 'stop' }),
    routing({ state: 'disputed', action: 42 }),
  ]) {
    assert.equal(
      classifyClaimAssertResult(1, body, CLAIM).status,
      'unreadable',
      body,
    );
  }
});

test('classifyClaimAssertResult: an owned keep verdict with a non-zero exit was cut short, so it is unreadable', () => {
  // `--assert` exits 0 exactly for this verdict; a kill after printing it
  // must not read as a claim that is lost.
  for (const exited of [1, 2, 137]) {
    assert.equal(
      classifyClaimAssertResult(exited, routing(), CLAIM).status,
      'unreadable',
      String(exited),
    );
  }
});

test('classifyClaimAssertResult: exit 0 that does not prove this claim is unreadable, never owned', () => {
  for (const body of [
    routing({ active_claim: { claim_id: 'another-claim', branch: BRANCH } }),
    routing({ active_claim: { claim_id: CLAIM, branch: '' } }),
    routing({ active_claim: { claim_id: CLAIM } }),
    routing({ active_claim: null }),
    routing({ state: 'stale', action: 'takeover' }),
  ]) {
    const outcome = classifyClaimAssertResult(0, body, CLAIM);
    assert.equal(outcome.status, 'unreadable', body);
  }
});

test('classifyLocalRefReads: a verified full SHA is present', () => {
  assert.deepEqual(classifyLocalRefReads({ status: 0, stdout: TIP }, null), {
    state: 'present',
    tip: TIP,
  });
});

test('classifyLocalRefReads: a verified value that is not a full SHA is an error', () => {
  for (const stdout of ['', 'abc', TIP.toUpperCase(), `${TIP}0`]) {
    assert.deepEqual(classifyLocalRefReads({ status: 0, stdout }, null), {
      state: 'error',
      tip: null,
    });
  }
});

test('classifyLocalRefReads: only a show-ref exit of 1 makes a failed rev-parse an absent ref', () => {
  const failed = { status: 128, stdout: '' };
  assert.deepEqual(classifyLocalRefReads(failed, { status: 1 }), {
    state: 'absent',
    tip: null,
  });
  for (const exists of [
    { status: 0 },
    { status: 128 },
    { status: null },
    null,
  ]) {
    assert.deepEqual(classifyLocalRefReads(failed, exists), {
      state: 'error',
      tip: null,
    });
  }
});

test('selectPullRequests keeps same-repository pull requests with exactly this head branch', () => {
  const rows = [
    {
      number: 10,
      state: 'MERGED',
      headRefName: BRANCH,
      isCrossRepository: false,
    },
    {
      number: 11,
      state: 'CLOSED',
      headRefName: BRANCH,
      isCrossRepository: false,
    },
    { number: 12, state: 'OPEN', headRefName: BRANCH },
    // A fork's pull request that happens to use the same branch name.
    {
      number: 13,
      state: 'MERGED',
      headRefName: BRANCH,
      isCrossRepository: true,
    },
    {
      number: 14,
      state: 'MERGED',
      headRefName: `${BRANCH}-2`,
      isCrossRepository: false,
    },
    // Rows that cannot be used.
    { number: 'x', state: 'MERGED', headRefName: BRANCH },
    { number: 0, state: 'MERGED', headRefName: BRANCH },
    null,
    'text',
  ];
  assert.deepEqual(selectPullRequests(rows, BRANCH, 100), [
    { number: 10, merged: true },
    { number: 11, merged: false },
    { number: 12, merged: false },
  ]);
});

test('selectPullRequests throws on output that is not an array', () => {
  assert.throws(
    () => selectPullRequests({}, BRANCH, 100),
    /did not return a JSON array/,
  );
  assert.deepEqual(selectPullRequests([], BRANCH, 100), []);
});

test('matchRegisteredWorktree matches a registered worktree by real path and fails closed otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-live-'));
  try {
    const registered = join(root, 'registered');
    const other = join(root, 'other');
    const prunable = join(root, 'prunable');
    mkdirSync(registered);
    mkdirSync(other);
    mkdirSync(prunable);
    const link = join(root, 'link-to-registered');
    symlinkSync(registered, link);
    const record = (path: string, extra: string[] = []): string =>
      [
        `worktree ${path}`,
        `HEAD ${'1'.repeat(40)}`,
        `branch refs/heads/${BRANCH}`,
        ...extra,
        '',
        '',
      ].join('\0');
    const listing = record(registered) + record(prunable, ['prunable gone']);

    assert.equal(matchRegisteredWorktree(listing, registered), true);
    // A symbolic link to a registered worktree is the same directory.
    assert.equal(matchRegisteredWorktree(listing, link), true);
    assert.equal(matchRegisteredWorktree(listing, other), false);
    // A prunable record never matches, and neither does a missing path.
    assert.equal(matchRegisteredWorktree(listing, prunable), false);
    assert.equal(
      matchRegisteredWorktree(listing, join(root, 'missing')),
      false,
    );
    assert.equal(matchRegisteredWorktree('', registered), false);
    // Output the strict parser rejects is unreadable, not "not registered".
    assert.equal(
      matchRegisteredWorktree(`${listing}worktree`, registered),
      null,
    );
    assert.equal(
      matchRegisteredWorktree(
        `worktree ${registered}\0HEAD ${'1'.repeat(40)}\0detached\0future-field x\0\0`,
        registered,
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the git reads ignore Git environment overrides of the caller', () => {
  // A caller that exports GIT_DIR or GIT_WORK_TREE would otherwise make the
  // reads below describe another repository than the supplied worktree.
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-git-env-'));
  const repo = join(root, 'repo');
  const decoy = join(root, 'decoy');
  mkdirSync(repo);
  mkdirSync(decoy);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      },
    ).trim();
  git(repo, 'init', '-q', '-b', 'work');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
  const tip = git(repo, 'rev-parse', 'refs/heads/work');
  git(decoy, 'init', '-q', '-b', 'other');

  const savedCwd = process.cwd();
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    process.chdir(repo);
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    const deps = createLiveF4HeadProofDeps({
      resolveRepo: () => ({ owner: 'o', repo: 'r' }),
    });
    assert.deepEqual(deps.readLocalRef(repo, 'work'), {
      state: 'present',
      tip,
    });
    assert.deepEqual(deps.readLocalRef(repo, 'other'), {
      state: 'absent',
      tip: null,
    });
    assert.equal(deps.isRegisteredWorktree(repo), true);
    assert.equal(deps.isRegisteredWorktree(decoy), false);
    assert.equal(deps.isValidRefName('work'), true);
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectPullRequests refuses a list that reached the row cap, even when every row is filtered out', () => {
  const row = { number: 7, state: 'CLOSED', headRefName: BRANCH };
  const other = { number: 8, state: 'MERGED', headRefName: 'issue/other' };
  assert.deepEqual(selectPullRequests([row, row], BRANCH, 3), [
    { number: 7, merged: false },
    { number: 7, merged: false },
  ]);
  assert.throws(
    () => selectPullRequests([row, row, row], BRANCH, 3),
    /may be truncated/,
  );
  assert.throws(
    () => selectPullRequests([other, other, other], BRANCH, 3),
    /cap of 3/,
  );
});

test('the claim check runs with the sanitized Git environment, keeping PATH and the GitHub token', () => {
  const keys = ['GIT_DIR', 'GH_TOKEN', 'PATH'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  try {
    process.env.GIT_DIR = '/decoy/.git';
    process.env.GH_TOKEN = 'token-fixture';
    const env = claimCheckSpawnOptions().env ?? {};
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GH_TOKEN, 'token-fixture');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('the live deps refuse a repository the checkout origin does not name, and an empty one', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-mismatch-'));
  const savedCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root], {
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-C',
        root,
        'remote',
        'add',
        'origin',
        'https://github.com/origin-owner/origin-repo.git',
      ],
      { stdio: 'ignore' },
    );
    process.chdir(root);
    let resolved = 0;
    const other = createLiveF4HeadProofDeps({
      resolveRepo: () => {
        resolved += 1;
        return { owner: 'another-owner', repo: 'another-repo' };
      },
    });
    assert.equal(
      other.checkoutRepositoryError(),
      "another-owner/another-repo is not the repository the current checkout's origin names (origin-owner/origin-repo)",
    );
    // The gate asks once and stops at a refusal, so the repository is resolved
    // once for this check.
    assert.equal(resolved, 1);
    const empty = createLiveF4HeadProofDeps({
      resolveRepo: () => ({ owner: '', repo: 'idd-skill' }),
    });
    assert.equal(
      empty.checkoutRepositoryError(),
      'the repository of the current checkout could not be resolved',
    );
  } finally {
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Run `run` with the environment overrides applied (undefined removes a
 * variable), then put back every variable the overrides touched.
 */
function withEnvironment(
  overrides: Record<string, string | undefined>,
  run: () => void,
): void {
  const saved = Object.keys(overrides).map(
    (key) => [key, process.env[key]] as const,
  );
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Run `run` in a fresh checkout whose origin is `url` (no origin when null).
 * HOME and XDG_CONFIG_HOME point at an empty directory, so a user-level rule
 * (an insteadOf, for example) cannot rewrite the URL git reports.
 */
function inOriginCheckout(url: string | null, run: () => void): void {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-checkout-'));
  const home = mkdtempSync(join(tmpdir(), 'f4-head-proof-home-'));
  const savedCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root], {
      stdio: 'ignore',
    });
    if (url !== null) {
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', url], {
        stdio: 'ignore',
      });
    }
    withEnvironment({ HOME: home, XDG_CONFIG_HOME: home }, () => {
      process.chdir(root);
      run();
    });
  } finally {
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test('the repository is read from the checkout origin, and an inherited GH_REPO has no effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-origin-'));
  // A user-level insteadOf rule would change the origin URL git reports, so
  // HOME and XDG_CONFIG_HOME point at an empty directory for this test.
  const home = mkdtempSync(join(tmpdir(), 'f4-head-proof-home-'));
  const keys = [
    'GH_REPO',
    'GH_HOST',
    'GITHUB_SERVER_URL',
    'HOME',
    'XDG_CONFIG_HOME',
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  const savedCwd = process.cwd();
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    execFileSync('git', ['init', '-q', '-b', 'main', root], {
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-C',
        root,
        'remote',
        'add',
        'origin',
        'https://github.com/origin-owner/origin-repo.git',
      ],
      { stdio: 'ignore' },
    );
    process.chdir(root);
    delete process.env.GH_HOST;
    delete process.env.GITHUB_SERVER_URL;
    process.env.GH_REPO = 'elsewhere/not-this-one';
    assert.deepEqual(resolveCheckoutRepository(), {
      owner: 'origin-owner',
      repo: 'origin-repo',
    });
    // The origin confirms the repository, so the live deps accept it.
    const deps = createLiveF4HeadProofDeps({
      resolveRepo: resolveCheckoutRepository,
    });
    assert.equal(deps.checkoutRepositoryError(), null);
    // The origin's host is now the process's gh host, so every gh call of the
    // command goes there.
    assert.equal(process.env.GH_HOST, 'github.com');
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a checkout without an origin remote cannot resolve a repository locally', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-no-origin-'));
  const savedCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root], {
      stdio: 'ignore',
    });
    process.chdir(root);
    // The repository must exist, so the refusal below is about the missing
    // origin and not about a directory that is not a checkout.
    assert.equal(
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
      }).trim(),
      'true',
    );
    assert.throws(() => resolveCheckoutRepository(), /no origin remote/);
    const deps = createLiveF4HeadProofDeps({
      resolveRepo: resolveCheckoutRepository,
    });
    assert.match(deps.checkoutRepositoryError() ?? '', /no origin remote/);
  } finally {
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an origin URL with whitespace, a backslash, or a character outside printable ASCII is refused before it is parsed', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-odd-origin-'));
  const savedCwd = process.cwd();
  // git stores each URL as set (`git remote get-url` returns it intact), and
  // the check reads the URL raw, so an edge character such as a trailing
  // space, tab, or carriage return is refused like an interior one.
  const odd = [
    'https://github.com\\@evil.example/o/r',
    'https://github.com/o r',
    'https://github.com/o\tr',
    'https://github.com/o\u0001r',
    'https://github.com/o\u0085r',
    'https://github.com/o\u2028r',
    'https://gith\u200bub.com/o/r',
    'https://github.com/o\u00adr',
    'https://github.com/o/r ',
    'https://github.com/o/r\t',
    'https://github.com/o/r\r',
    ' https://github.com/o/r',
  ];
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root], {
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      ['-C', root, 'remote', 'add', 'origin', 'https://github.com/o/r'],
      { stdio: 'ignore' },
    );
    process.chdir(root);
    for (const url of odd) {
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', url], {
        stdio: 'ignore',
      });
      assert.throws(
        () => resolveCheckoutRepository(),
        /characters that a repository URL does not/,
        JSON.stringify(url),
      );
    }
  } finally {
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a matching origin on another active host is refused with the GH_HOST fix, and nothing is pinned', () => {
  inOriginCheckout('https://github.com/origin-owner/origin-repo.git', () => {
    withEnvironment(
      { GH_HOST: undefined, GITHUB_SERVER_URL: 'https://ghe.example.com' },
      () => {
        const deps = createLiveF4HeadProofDeps({
          resolveRepo: () => ({ owner: 'origin-owner', repo: 'origin-repo' }),
        });
        assert.equal(
          deps.checkoutRepositoryError(),
          "the current checkout's origin names origin-owner/origin-repo on github.com, but the active GitHub host is ghe.example.com; set GH_HOST to github.com to use it",
        );
        // A refusal pins nothing: the process keeps its own gh host.
        assert.equal(process.env.GH_HOST, undefined);
      },
    );
  });
});

test('a GHES origin on the GITHUB_SERVER_URL host is accepted, and gh is pinned to that host', () => {
  inOriginCheckout(
    'https://ghe.example.com/origin-owner/origin-repo.git',
    () => {
      withEnvironment(
        { GH_HOST: undefined, GITHUB_SERVER_URL: 'https://ghe.example.com' },
        () => {
          const deps = createLiveF4HeadProofDeps({
            resolveRepo: resolveCheckoutRepository,
          });
          assert.equal(deps.checkoutRepositoryError(), null);
          assert.equal(process.env.GH_HOST, 'ghe.example.com');
        },
      );
    },
  );
});

test('a blank GH_HOST counts as unset, and a GH_HOST in another case is pinned in its normalized form', () => {
  inOriginCheckout('https://github.com/origin-owner/origin-repo.git', () => {
    withEnvironment({ GH_HOST: '  ', GITHUB_SERVER_URL: undefined }, () => {
      const deps = createLiveF4HeadProofDeps({
        resolveRepo: resolveCheckoutRepository,
      });
      assert.equal(deps.checkoutRepositoryError(), null);
      assert.equal(process.env.GH_HOST, 'github.com');
    });
    withEnvironment(
      { GH_HOST: 'GitHub.com', GITHUB_SERVER_URL: undefined },
      () => {
        const deps = createLiveF4HeadProofDeps({
          resolveRepo: resolveCheckoutRepository,
        });
        assert.equal(deps.checkoutRepositoryError(), null);
        assert.equal(process.env.GH_HOST, 'github.com');
      },
    );
  });
});

test('an unreadable GITHUB_SERVER_URL refuses the origin, names the unreadable host, and pins nothing', () => {
  inOriginCheckout('https://github.com/origin-owner/origin-repo.git', () => {
    withEnvironment(
      { GH_HOST: undefined, GITHUB_SERVER_URL: 'not a url' },
      () => {
        const deps = createLiveF4HeadProofDeps({
          resolveRepo: resolveCheckoutRepository,
        });
        assert.equal(
          deps.checkoutRepositoryError(),
          "the current checkout's origin names origin-owner/origin-repo on github.com, but the active GitHub host is an unreadable host; set GH_HOST to github.com to use it",
        );
        assert.equal(process.env.GH_HOST, undefined);
      },
    );
  });
});

test('the origin refusal names its cause for each case, from the origin URL and the active host', () => {
  const origin = 'https://github.com/origin-owner/origin-repo.git';
  assert.equal(
    originMismatchMessage('origin-owner', 'origin-repo', null, 'github.com'),
    'origin-owner/origin-repo is not confirmed: the current checkout has no origin remote that names a repository',
  );
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      `${origin} `,
      'github.com',
    ),
    "origin-owner/origin-repo is not confirmed: the checkout's origin URL contains characters that a repository URL does not",
  );
  assert.equal(
    originMismatchMessage('other-owner', 'origin-repo', origin, 'github.com'),
    "other-owner/origin-repo is not the repository the current checkout's origin names (origin-owner/origin-repo)",
  );
  assert.equal(
    originMismatchMessage('origin-owner', 'origin-repo', origin, 'github.com'),
    "the current checkout's origin names origin-owner/origin-repo on github.com, but the origin could not be confirmed; retry, or check the origin remote",
  );
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      'ssh://git@github.com:2222/origin-owner/origin-repo.git',
      'github.com',
    ),
    "the current checkout's origin names origin-owner/origin-repo on github.com:2222, a host with a port that the origin check does not match to the active GitHub host github.com; use an origin URL without a port",
  );
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      origin,
      'ghe.example.com',
    ),
    "the current checkout's origin names origin-owner/origin-repo on github.com, but the active GitHub host is ghe.example.com; set GH_HOST to github.com to use it",
  );
  assert.equal(
    originMismatchMessage('origin-owner', 'origin-repo', origin, null),
    "the current checkout's origin names origin-owner/origin-repo on github.com, but the active GitHub host is an unreadable host; set GH_HOST to github.com to use it",
  );
});

test('an HTTPS origin with a port is refused with GH_HOST naming that port, and accepted once GH_HOST names it', () => {
  inOriginCheckout(
    'https://ghes.example.com:8443/origin-owner/origin-repo.git',
    () => {
      withEnvironment(
        { GH_HOST: undefined, GITHUB_SERVER_URL: undefined },
        () => {
          const deps = createLiveF4HeadProofDeps({
            resolveRepo: resolveCheckoutRepository,
          });
          assert.equal(
            deps.checkoutRepositoryError(),
            "the current checkout's origin names origin-owner/origin-repo on ghes.example.com:8443, but the active GitHub host is github.com; set GH_HOST to ghes.example.com:8443 to use it",
          );
          assert.equal(process.env.GH_HOST, undefined);
        },
      );
      withEnvironment(
        { GH_HOST: 'ghes.example.com:8443', GITHUB_SERVER_URL: undefined },
        () => {
          const deps = createLiveF4HeadProofDeps({
            resolveRepo: resolveCheckoutRepository,
          });
          assert.equal(deps.checkoutRepositoryError(), null);
          assert.equal(process.env.GH_HOST, 'ghes.example.com:8443');
        },
      );
    },
  );
});

test('a blank GITHUB_SERVER_URL counts as unset, and the pin names github.com', () => {
  inOriginCheckout('https://github.com/origin-owner/origin-repo.git', () => {
    withEnvironment({ GH_HOST: undefined, GITHUB_SERVER_URL: '   ' }, () => {
      const deps = createLiveF4HeadProofDeps({
        resolveRepo: resolveCheckoutRepository,
      });
      assert.equal(deps.checkoutRepositoryError(), null);
      assert.equal(process.env.GH_HOST, 'github.com');
    });
  });
});

test('the refusal advice keeps an HTTP(S) port and never points GH_HOST at an SSH endpoint', () => {
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      'https://ghes.example.com:8443/origin-owner/origin-repo.git',
      'github.com',
    ),
    "the current checkout's origin names origin-owner/origin-repo on ghes.example.com:8443, but the active GitHub host is github.com; set GH_HOST to ghes.example.com:8443 to use it",
  );
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      'https://ghes.example.com:8443/origin-owner/origin-repo.git',
      'ghes.example.com',
    ),
    "the current checkout's origin names origin-owner/origin-repo on ghes.example.com:8443, a host with a port that the origin check does not match to the active GitHub host ghes.example.com; use an origin URL without a port, or set GH_HOST to ghes.example.com:8443 to use it",
  );
  for (const url of [
    'git@ssh.github.com:origin-owner/origin-repo.git',
    'ssh://git@ssh.github.com:443/origin-owner/origin-repo.git',
  ]) {
    assert.equal(
      originMismatchMessage('origin-owner', 'origin-repo', url, 'github.com'),
      "the current checkout's origin names origin-owner/origin-repo on ssh.github.com, GitHub's SSH endpoint and not an API host; use an origin URL on the API host, for example https://github.com/origin-owner/origin-repo.git",
      url,
    );
  }
});

test('each refusal advice names a fix that passes the origin check once it is applied', () => {
  const unset = { GH_HOST: undefined, GITHUB_SERVER_URL: undefined };
  const cases: Array<{
    name: string;
    origin: string;
    env: Record<string, string | undefined>;
    fixes: Array<{
      expect: string;
      origin?: string;
      env?: Record<string, string | undefined>;
    }>;
  }> = [
    {
      name: 'an HTTPS origin on a port that GH_HOST carries',
      origin: 'https://ghes.example.com:8443/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect: 'set GH_HOST to ghes.example.com:8443 to use it',
          env: { GH_HOST: 'ghes.example.com:8443' },
        },
      ],
    },
    {
      name: 'an HTTP origin on port 443',
      origin: 'http://ghes.example.com:443/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect:
            'set GH_HOST to ghes.example.com and use an origin URL without a port',
          origin: 'http://ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
      ],
    },
    {
      name: 'an SSH origin on a port',
      origin: 'ssh://git@ghes.example.com:2222/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect:
            'set GH_HOST to ghes.example.com and use an origin URL without a port',
          origin: 'ssh://git@ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
      ],
    },
    {
      name: 'a git+ssh origin on a port',
      origin:
        'git+ssh://git@ghes.example.com:2222/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect:
            'set GH_HOST to ghes.example.com and use an origin URL without a port',
          origin: 'git+ssh://git@ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
      ],
    },
    {
      name: 'a git origin on a port',
      origin: 'git://ghes.example.com:9419/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect:
            'set GH_HOST to ghes.example.com and use an origin URL without a port',
          origin: 'git://ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
      ],
    },
    {
      name: 'an HTTPS origin on the active host with a port',
      origin: 'https://github.com:8443/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect: 'set GH_HOST to github.com:8443 to use it',
          env: { GH_HOST: 'github.com:8443' },
        },
        {
          expect: 'use an origin URL without a port',
          origin: 'https://github.com/origin-owner/origin-repo.git',
        },
      ],
    },
    {
      name: 'an SSH origin on the active host with a port',
      origin: 'ssh://git@github.com:2222/origin-owner/origin-repo.git',
      env: unset,
      fixes: [
        {
          expect: 'use an origin URL without a port',
          origin: 'ssh://git@github.com/origin-owner/origin-repo.git',
        },
      ],
    },
    {
      name: 'an SSH origin on ssh.github.com with GHES active',
      origin: 'git@ssh.github.com:origin-owner/origin-repo.git',
      env: { GH_HOST: 'ghes.example.com', GITHUB_SERVER_URL: undefined },
      fixes: [
        {
          expect:
            'for example https://ghes.example.com/origin-owner/origin-repo.git',
          origin: 'https://ghes.example.com/origin-owner/origin-repo.git',
        },
      ],
    },
    {
      name: 'an SSH origin on ssh.github.com with an unreadable GH_HOST',
      origin: 'git@ssh.github.com:origin-owner/origin-repo.git',
      env: { GH_HOST: 'bad host', GITHUB_SERVER_URL: undefined },
      fixes: [
        {
          expect:
            'set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL',
          origin: 'https://ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
        {
          expect:
            'set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL',
          origin: 'https://ghes.example.com/origin-owner/origin-repo.git',
          env: {
            GH_HOST: undefined,
            GITHUB_SERVER_URL: 'https://ghes.example.com',
          },
        },
      ],
    },
    {
      name: 'a host GH_HOST cannot name, with an unreadable GH_HOST',
      origin: 'git@ho#st:origin-owner/origin-repo.git',
      env: { GH_HOST: 'bad host', GITHUB_SERVER_URL: undefined },
      fixes: [
        {
          expect:
            'set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL',
          origin: 'https://ghes.example.com/origin-owner/origin-repo.git',
          env: { GH_HOST: 'ghes.example.com' },
        },
        {
          expect:
            'set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL',
          origin: 'https://ghes.example.com/origin-owner/origin-repo.git',
          env: {
            GH_HOST: undefined,
            GITHUB_SERVER_URL: 'https://ghes.example.com',
          },
        },
      ],
    },
  ];
  for (const item of cases) {
    let refusal = '';
    inOriginCheckout(item.origin, () => {
      withEnvironment(item.env, () => {
        const deps = createLiveF4HeadProofDeps({
          resolveRepo: resolveCheckoutRepository,
        });
        refusal = deps.checkoutRepositoryError() ?? '';
      });
    });
    assert.notEqual(refusal, '', item.name);
    for (const fix of item.fixes) {
      assert.ok(
        refusal.includes(fix.expect),
        `${item.name}: "${fix.expect}" is not in "${refusal}"`,
      );
      inOriginCheckout(fix.origin ?? item.origin, () => {
        withEnvironment({ ...item.env, ...fix.env }, () => {
          const deps = createLiveF4HeadProofDeps({
            resolveRepo: resolveCheckoutRepository,
          });
          assert.equal(
            deps.checkoutRepositoryError(),
            null,
            `${item.name}: ${fix.expect}`,
          );
        });
      });
    }
  }
});

test('an HTTP origin on port 443 is not accepted under GH_HOST naming that port, which GH_HOST reads back without it', () => {
  inOriginCheckout(
    'http://ghes.example.com:443/origin-owner/origin-repo.git',
    () => {
      withEnvironment(
        { GH_HOST: 'ghes.example.com:443', GITHUB_SERVER_URL: undefined },
        () => {
          const message =
            createLiveF4HeadProofDeps({
              resolveRepo: resolveCheckoutRepository,
            }).checkoutRepositoryError() ?? '';
          assert.match(message, /use an origin URL without a port/);
          assert.doesNotMatch(message, /set GH_HOST to ghes\.example\.com:443/);
        },
      );
    },
  );
});

test('the refusal advice for ssh.github.com names the active host, or the setting to fix first', () => {
  const origin = 'git@ssh.github.com:origin-owner/origin-repo.git';
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      origin,
      'ghes.example.com:443',
    ),
    "the current checkout's origin names origin-owner/origin-repo on ssh.github.com, GitHub's SSH endpoint and not an API host; use an origin URL on the API host, for example http://ghes.example.com:443/origin-owner/origin-repo.git",
  );
  assert.equal(
    originMismatchMessage('origin-owner', 'origin-repo', origin, null),
    "the current checkout's origin names origin-owner/origin-repo on ssh.github.com, GitHub's SSH endpoint and not an API host; the active GitHub host cannot be read, so set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL, and then use an origin URL on that host",
  );
});

test('a host that GH_HOST cannot name gets advice to use the active host, or the setting to fix first', () => {
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      'git@ho#st:origin-owner/origin-repo.git',
      'github.com',
    ),
    "the current checkout's origin names origin-owner/origin-repo on ho#st, which GH_HOST cannot name; use an origin URL on github.com, for example https://github.com/origin-owner/origin-repo.git",
  );
  assert.equal(
    originMismatchMessage(
      'origin-owner',
      'origin-repo',
      'git@ho#st:origin-owner/origin-repo.git',
      null,
    ),
    "the current checkout's origin names origin-owner/origin-repo on ho#st, which GH_HOST cannot name, and the active GitHub host cannot be read either; set GH_HOST to a readable host, or unset it and set GITHUB_SERVER_URL to its https:// URL, and then use an origin URL on that host",
  );
});

test('an owned verdict is accepted only with the claim-id-match reason, and any other reason is unreadable', () => {
  assert.equal(classifyClaimAssertResult(0, routing(), CLAIM).status, 'owned');
  assert.equal(
    classifyClaimAssertResult(0, routing({ reason: undefined }), CLAIM).status,
    'unreadable',
  );
  assert.equal(
    classifyClaimAssertResult(
      0,
      routing({ reason: 'claim-id-match-without-independent-owner-evidence' }),
      CLAIM,
    ).status,
    'unreadable',
  );
  assert.equal(
    classifyClaimAssertResult(
      0,
      routing({ reason: 'some-other-reason' }),
      CLAIM,
    ).status,
    'unreadable',
  );
});
