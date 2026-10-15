import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classifyBranchConflictState,
  collectPinnedRequiredAppIds,
  describeUnstableHold,
  MERGE_BASE_FETCH_STEPS,
  markSuiteRequirement,
  type NonPassingRun,
  parseArgs,
  parseConflictFiles,
  parseGitFetchOrigin,
  parseHeadNonPassing,
  parseHeadRollup,
  parseHeadSuites,
  parseNonPassingRuns,
  readTrustEmptyProtectionReads,
  resolveCallSiteRouting,
  resolveFetchAttemptTimeoutMs,
  resolveFetchOrigin,
  resolveMergeBaseWithRetry,
  resolvePinnedRequiredAppIds,
  resolveRequiresUpToDateHead,
} from '../src/scripts/branch-conflict-state.mts';
import { trackTempDirectories } from './temp-fixtures.mts';

// #4049: every fixture directory below is removed when the file finishes.
const makeTempDir = trackTempDirectories();

type ClassifyOptions = NonNullable<
  Parameters<typeof classifyBranchConflictState>[1]
>;
type PrData = NonNullable<ClassifyOptions['_testPrData']>;

/** Structural view of the branch-conflict-state JSON fixtures. */
interface ConflictFixture {
  prData: PrData & { number: number };
  expected: {
    branchState: string;
    syncRecommendation: string;
    mergeableSource: string;
  };
}

function loadFixture(name: string): ConflictFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        `../fixtures/branch-conflict-state/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as ConflictFixture;
}

function _stubLoader(fixture: ConflictFixture) {
  return async (_prNumber: number, _options: unknown) => {
    return fixture.prData;
  };
}

async function _classifyFromFixture(fixture: ConflictFixture) {
  const { prData } = fixture;
  return classifyBranchConflictState(prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: prData,
  });
}

let sharedTwoCommitRepo: { dir: string; older: string; newer: string } | null =
  null;

/**
 * Builds (once, memoized) a hermetic two-commit git repository in a fresh
 * temp directory and returns the SHAs of both commits, oldest first. Real
 * local objects let `git merge-base` resolve deterministically with no
 * network fetch, so `baseAdvancedSinceMergeBase` tests don't depend on the
 * ambient checkout's history or depth (this project's own CI uses shallow,
 * `fetch-depth: 1` checkouts in places, so relying on e.g. `HEAD~3` here
 * would be fragile). Every caller only reads this fixture via `merge-base`
 * afterward, so sharing one instance across tests is safe and avoids paying
 * `git init` + two commits repeatedly.
 */
function createTwoCommitRepo(): { dir: string; older: string; newer: string } {
  if (sharedTwoCommitRepo) return sharedTwoCommitRepo;
  const dir = makeTempDir(join(tmpdir(), 'idd-branch-conflict-state-'));
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
  gitNoSign(dir, ['commit', '-q', '-m', 'older']);
  const older = git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(['add', 'b.txt']);
  gitNoSign(dir, ['commit', '-q', '-m', 'newer']);
  const newer = git(['rev-parse', 'HEAD']);
  sharedTwoCommitRepo = { dir, older, newer };
  return sharedTwoCommitRepo;
}

/** Runs a git command with signing forced off. These fixture repos are
 * throwaway temp directories, not real project history, so there is
 * nothing to sign -- and this repository's own ambient global
 * `commit.gpgsign=true` would otherwise make every fixture commit attempt a
 * real GPG signature, which can hang or fail on pinentry/gpg-agent
 * contention under concurrent local sessions (observed directly: a first
 * attempt at this fixture failed with `gpg: signing failed: timeout` from
 * exactly this cause). `-c commit.gpgsign=false` overrides the ambient
 * config for this invocation only, without touching any real repository or
 * user config. */
function gitNoSign(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  ).trim();
}

let sharedUpstreamRepo: {
  dir: string;
  branch: string;
  commits: string[];
  featureBranch: string;
  featureCommits: string[];
} | null = null;

/**
 * Builds (once, memoized) a real "upstream" repo with several sequential
 * commits on its main line -- oldest first in the returned `commits` array
 * -- plus a second, divergent `featureBranch` that branches off
 * `commits[2]` and adds its own commits (`featureCommits`, oldest first).
 * `featureBranch` models a real PR head that shares an ancestor with the
 * base branch but has since diverged -- used by the head-side-shallow retry
 * test below (#1535), which needs a commit reachable only through a ref
 * *different* from whichever one was already shallow-cloned, unlike the
 * single-branch `commits` array (which only proves that deepening the
 * *same* already-shallow ref works, already covered by the pre-existing
 * "deepened-success" test).
 *
 * `featureBranch` is built in a separate, temporary `git worktree` rather
 * than by checking it out directly in `dir` (add commits, then checkout
 * back to `branch`): `dir`'s own HEAD/working tree never has to leave
 * `branch` at any point this way, so there is no window -- even a
 * same-process one -- where a concurrent reader of `dir` (or a future test
 * added to this file) could observe it mid-switch. The scratch worktree is
 * removed again once `featureBranch`'s commits exist as a plain ref.
 *
 * Immutable after creation (nothing below ever fetches into or otherwise
 * mutates this directory), so sharing one instance across tests is safe.
 */
function createUpstreamRepo(): {
  dir: string;
  branch: string;
  commits: string[];
  featureBranch: string;
  featureCommits: string[];
} {
  if (sharedUpstreamRepo) return sharedUpstreamRepo;
  const dir = makeTempDir(join(tmpdir(), 'idd-branch-conflict-upstream-'));
  gitNoSign(dir, ['init', '-q']);
  gitNoSign(dir, ['config', 'user.email', 'test@example.invalid']);
  gitNoSign(dir, ['config', 'user.name', 'Test']);
  const commits: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    gitNoSign(dir, ['add', `f${i}.txt`]);
    gitNoSign(dir, ['commit', '-q', '-m', `commit ${i}`]);
    commits.push(gitNoSign(dir, ['rev-parse', 'HEAD']));
  }
  const branch = gitNoSign(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const featureBranch = 'feature';
  const featureWorktreeDir = makeTempDir(
    join(tmpdir(), 'idd-branch-conflict-feature-wt-'),
  );
  gitNoSign(dir, [
    'worktree',
    'add',
    '-q',
    featureWorktreeDir,
    '-b',
    featureBranch,
    commits[2],
  ]);
  const featureCommits: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(join(featureWorktreeDir, `g${i}.txt`), `${i}\n`);
    gitNoSign(featureWorktreeDir, ['add', `g${i}.txt`]);
    gitNoSign(featureWorktreeDir, [
      'commit',
      '-q',
      '-m',
      `feature commit ${i}`,
    ]);
    featureCommits.push(gitNoSign(featureWorktreeDir, ['rev-parse', 'HEAD']));
  }
  gitNoSign(dir, ['worktree', 'remove', '--force', featureWorktreeDir]);

  sharedUpstreamRepo = { dir, branch, commits, featureBranch, featureCommits };
  return sharedUpstreamRepo;
}

/**
 * Creates a **fresh** (never memoized/shared) genuine `--depth=1` shallow
 * clone of the upstream repo, so each caller can deepen its own clone
 * without order-coupling to any other test. `git clone` wires the clone's
 * `origin` remote to the upstream directory automatically, so
 * `fetchShallowFixtureStep` can fetch progressively more history straight
 * from that local path -- exercising real shallow-git `--deepen` semantics
 * with the exact {@link MERGE_BASE_FETCH_STEPS} args `tryFetchBase` uses in
 * production, with no network access. Only `tryFetchBase`'s own HTTPS
 * remote-URL resolution is bypassed (a local path is not a resolvable host
 * per `resolveFetchOrigin`), matching this file's existing convention of
 * never letting a test reach a live network fetch (see the "unresolvable
 * merge-base" test's `baseRefName: ''` short-circuit, and `tryFetchBase`'s
 * own doc comment).
 *
 * A plain filesystem path clone silently **ignores** `--depth` ("--depth is
 * ignored in local clones; use file:// instead"). `--no-local` is used
 * instead of a `file://` URL: it forces the same non-optimized transfer
 * path a real remote would use (so `--depth` takes effect) without
 * constructing a URL by string interpolation, which could break if
 * `upstreamDir` contains characters that need URL escaping (e.g. spaces).
 */
function createFreshShallowClone(upstreamDir: string): string {
  const shallowDir = makeTempDir(
    join(tmpdir(), 'idd-branch-conflict-shallow-'),
  );
  execFileSync(
    'git',
    ['clone', '-q', '--depth=1', '--no-local', upstreamDir, shallowDir],
    { encoding: 'utf8' },
  );
  return shallowDir;
}

/** Real `git fetch --no-tags <fetchArgs> origin <branch>` against the
 * shallow clone's own `origin` remote (the local upstream directory) --
 * the same invocation shape as `tryFetchBase`, minus its HTTPS remote-URL
 * resolution. Returns whether the fetch itself succeeded, mirroring
 * `tryFetchBase`'s own return contract for {@link resolveMergeBaseWithRetry}. */
function fetchShallowFixtureStep(
  shallowDir: string,
  branch: string,
  fetchArgs: readonly string[],
): boolean {
  try {
    execFileSync(
      'git',
      ['fetch', '--no-tags', ...fetchArgs, 'origin', branch],
      { cwd: shallowDir, encoding: 'utf8', stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Read-only local `git merge-base` lookup mirroring the production
 * `gitText` helper's contract exactly: swallow any git failure (missing
 * object, unrelated history, etc.) and return `''` rather than throwing, so
 * `resolveMergeBaseWithRetry`'s `lookupMergeBase` callback never needs its
 * own try/catch at each call site. */
function mergeBaseText(dir: string, a: string, b: string): string {
  try {
    return execFileSync('git', ['merge-base', a, b], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

test('classifyBranchConflictState: clean PR returns clean state', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
    // The fixture's SHAs are placeholders, not real git objects; skip the
    // new baseAdvancedSinceMergeBase probe so this pre-existing test stays
    // fast and offline (dedicated tests below cover the probe itself).
    _skipGitProbe: true,
  });
  assert.equal(result.branchState, fixture.expected.branchState);
  assert.equal(result.syncRecommendation, fixture.expected.syncRecommendation);
  assert.equal(
    result.diagnostics.mergeableSource,
    fixture.expected.mergeableSource,
  );
  assert.equal(result.baseAdvancedSinceMergeBase, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.worktreeUnchanged, true);
  assert.equal(result.protocolVersion, '1');
});

test('classifyBranchConflictState: CONFLICTING returns content-conflict', async () => {
  const fixture = loadFixture('content-conflict');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
    // The fixture's SHAs are placeholders, not real git objects, and its
    // owner/repo ('test-owner'/'test-repo') do not exist -- without this
    // flag, deriveBranchState's CONFLICTING branch falls through to a
    // real anonymous git fetch that hangs on a host with an interactive
    // credential helper configured (#2990). The assertions below --
    // branchState, syncRecommendation, and baseAdvancedSinceMergeBase --
    // are all set unconditionally for this branch (see
    // deriveBranchState), so skipping the probe changes none of them.
    _skipGitProbe: true,
  });
  assert.equal(result.branchState, fixture.expected.branchState);
  assert.equal(result.syncRecommendation, fixture.expected.syncRecommendation);
  assert.equal(result.baseAdvancedSinceMergeBase, false);
});

test('classifyBranchConflictState: DIRTY returns dirty state', async () => {
  const fixture = loadFixture('dirty');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.branchState, fixture.expected.branchState);
  assert.equal(result.syncRecommendation, fixture.expected.syncRecommendation);
  assert.equal(
    result.diagnostics.mergeableSource,
    fixture.expected.mergeableSource,
  );
  assert.equal(result.baseAdvancedSinceMergeBase, false);
});

test('classifyBranchConflictState: UNKNOWN returns transient computing state', async () => {
  const fixture = loadFixture('computing');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.branchState, 'computing');
  assert.equal(result.syncRecommendation, 'recheck');
  assert.equal(result.baseAdvancedSinceMergeBase, false);
});

test('classifyBranchConflictState: unrecognized mergeable returns terminal unknown', async () => {
  const fixture = loadFixture('unknown');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.branchState, 'unknown');
  assert.equal(result.syncRecommendation, 'hold-unknown');
  assert.equal(result.baseAdvancedSinceMergeBase, false);
});

test('classifyBranchConflictState: missing SHA returns unknown with hold-unknown', async () => {
  const fixture = loadFixture('missing-sha');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.branchState, 'unknown');
  assert.equal(result.syncRecommendation, 'hold-unknown');
  assert.equal(result.prHeadSha, '');
  assert.equal(result.baseAdvancedSinceMergeBase, false);
  assert.ok(result.diagnostics.notes.length > 0);
});

test('classifyBranchConflictState: result always reports readOnly and worktreeUnchanged', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
    _skipGitProbe: true,
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.worktreeUnchanged, true);
});

test('classifyBranchConflictState: BEHIND without conflict recommends merge-base', async () => {
  const prData = {
    number: 201,
    headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    headRefName: 'feature/behind',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    headRepository: { id: 'R_test', name: 'test-repo' },
  };
  const result = await classifyBranchConflictState(201, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: prData,
    _skipGitProbe: true,
  });
  assert.equal(result.branchState, 'behind-no-conflict');
  assert.equal(result.syncRecommendation, 'merge-base');
  // BEHIND is definitional: base has already advanced past the merge-base,
  // so this is `true` even though the git probe itself was skipped.
  assert.equal(result.baseAdvancedSinceMergeBase, true);
});

// #2274: the previous test's `baseRefName: 'main'` alone cannot prove the
// generic (branch-name-neutral) `'merge-base'` value isn't coincidentally
// correct for the default branch specifically -- rerun the same BEHIND
// scenario against a non-default configured `{development-branch}` and
// assert the identical, still branch-name-free recommendation.
test('classifyBranchConflictState: BEHIND against a non-default development branch still recommends merge-base, not a main-specific value', async () => {
  const prData = {
    number: 203,
    headRefOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    baseRefOid: 'ffffffffffffffffffffffffffffffffffffffff',
    headRefName: 'feature/behind-develop',
    baseRefName: 'develop',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    headRepository: { id: 'R_test', name: 'test-repo' },
  };
  const result = await classifyBranchConflictState(203, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: prData,
    _skipGitProbe: true,
  });
  assert.equal(result.branchState, 'behind-no-conflict');
  assert.equal(result.syncRecommendation, 'merge-base');
  assert.notEqual(result.syncRecommendation, 'merge-main');
  assert.equal(result.baseAdvancedSinceMergeBase, true);
});

test('parseConflictFiles: parses content conflict lines', () => {
  const output = 'CONFLICT (content): Merge conflict in src/foo.ts\n';
  assert.deepEqual(parseConflictFiles(output), ['src/foo.ts']);
});

test('parseConflictFiles: parses add/add conflict lines', () => {
  const output = 'CONFLICT (add/add): Merge conflict in src/bar.ts\n';
  assert.deepEqual(parseConflictFiles(output), ['src/bar.ts']);
});

test('parseConflictFiles: parses modify/delete conflict lines', () => {
  const output =
    'CONFLICT (modify/delete): src/baz.ts deleted in HEAD and modified in feature\n';
  assert.deepEqual(parseConflictFiles(output), ['src/baz.ts']);
});

test('parseConflictFiles: parses rename/delete conflict lines', () => {
  const output =
    'CONFLICT (rename/delete): old.ts renamed to new.ts in feature and deleted in HEAD\n';
  assert.deepEqual(parseConflictFiles(output), ['old.ts']);
});

test('parseConflictFiles: deduplicates repeated conflict paths', () => {
  const output =
    'CONFLICT (content): Merge conflict in src/foo.ts\n' +
    'CONFLICT (add/add): Merge conflict in src/foo.ts\n';
  assert.deepEqual(parseConflictFiles(output), ['src/foo.ts']);
});

test('parseConflictFiles: returns empty array for clean merge output', () => {
  const output = "Merge made by the 'ort' strategy.\n src/foo.ts | 2 ++\n";
  assert.deepEqual(parseConflictFiles(output), []);
});

test('classifyBranchConflictState: post-push merge recommendation for BEHIND is merge-base', async () => {
  const prData = {
    number: 202,
    headRefOid: 'cccccccccccccccccccccccccccccccccccccccc',
    baseRefOid: 'dddddddddddddddddddddddddddddddddddddddd',
    headRefName: 'feature/behind-published',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    headRepository: { id: 'R_test', name: 'test-repo' },
  };
  const result = await classifyBranchConflictState(202, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: prData,
    _skipGitProbe: true,
  });
  assert.equal(result.syncRecommendation, 'merge-base');
  assert.equal(result.baseAdvancedSinceMergeBase, true);
});

test('createTwoCommitRepo: commits succeed even with global commit signing forced on', () => {
  // Regression test for #1628: createTwoCommitRepo()'s two commit calls
  // must go through gitNoSign() (or an equivalent `-c commit.gpgsign=false`)
  // instead of the raw git() helper, so they never attempt a real GPG
  // signature. Simulate a machine with a real, interactively-signed global
  // GPG key by pointing GIT_CONFIG_GLOBAL at a temporary config that forces
  // signing on and points gpg.program at a binary that always fails --
  // the exact pattern tests/worktree-guard-hook.test.mts already uses for
  // this same condition. Reset the memoized shared repo first so this test
  // actually forces a rebuild under the poisoned config, rather than
  // silently reusing an already-built repo from an earlier test and
  // passing for the wrong reason.
  const configDir = makeTempDir(
    join(tmpdir(), 'idd-branch-conflict-state-gitconfig-'),
  );
  const configPath = join(configDir, 'gitconfig');
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  writeFileSync(
    configPath,
    '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n',
  );
  sharedTwoCommitRepo = null;
  try {
    process.env.GIT_CONFIG_GLOBAL = configPath;
    // Any signing attempt would invoke /bin/false and throw, failing this.
    assert.doesNotThrow(() => createTwoCommitRepo());
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('classifyBranchConflictState: CLEAN with base advanced past merge-base reports true with an advisory note', async () => {
  const { dir, older, newer } = createTwoCommitRepo();
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const prData = {
      number: 301,
      // Head is stuck at the older commit; base has moved on to the
      // newer one -- textually clean/mergeable, yet base advanced past
      // the merge-base. This is the exact blind spot the issue reports.
      headRefOid: older,
      baseRefOid: newer,
      headRefName: 'feature/stale-clean',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRepository: { id: 'R_test', name: 'test-repo' },
    };
    const result = await classifyBranchConflictState(301, {
      owner: 'test-owner',
      repo: 'test-repo',
      _testPrData: prData,
    });
    assert.equal(result.branchState, 'clean');
    assert.equal(result.syncRecommendation, 'none');
    assert.equal(result.baseAdvancedSinceMergeBase, true);
    assert.ok(
      result.diagnostics.notes.some((note) =>
        note.includes('baseAdvancedSinceMergeBase'),
      ),
      'expected an advisory note naming the blind spot',
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('classifyBranchConflictState: CLEAN with base unmoved since merge-base reports false with no advisory note', async () => {
  const { dir, older, newer } = createTwoCommitRepo();
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const prData = {
      number: 302,
      // Head has moved ahead with its own commit; base is still the
      // older commit it forked from -- base has not advanced.
      headRefOid: newer,
      baseRefOid: older,
      headRefName: 'feature/genuinely-clean',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRepository: { id: 'R_test', name: 'test-repo' },
    };
    const result = await classifyBranchConflictState(302, {
      owner: 'test-owner',
      repo: 'test-repo',
      _testPrData: prData,
    });
    assert.equal(result.branchState, 'clean');
    assert.equal(result.syncRecommendation, 'none');
    assert.equal(result.baseAdvancedSinceMergeBase, false);
    assert.ok(
      !result.diagnostics.notes.some((note) =>
        note.includes('baseAdvancedSinceMergeBase'),
      ),
      'did not expect an advisory note when base has not advanced',
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('classifyBranchConflictState: bare MERGEABLE (non-CLEAN state) also computes baseAdvancedSinceMergeBase', async () => {
  const { dir, older, newer } = createTwoCommitRepo();
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const prData = {
      number: 303,
      headRefOid: older,
      baseRefOid: newer,
      headRefName: 'feature/stale-unstable',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      // Any merge state other than CLEAN/DIRTY/BEHIND falls through to
      // the bare-MERGEABLE branch (line ~293 in the source), which is
      // the second `none`-producing branch the issue names.
      mergeStateStatus: 'UNSTABLE',
      headRepository: { id: 'R_test', name: 'test-repo' },
    };
    const result = await classifyBranchConflictState(303, {
      owner: 'test-owner',
      repo: 'test-repo',
      _testPrData: prData,
    });
    assert.equal(result.branchState, 'clean');
    assert.equal(result.syncRecommendation, 'none');
    assert.equal(result.baseAdvancedSinceMergeBase, true);
  } finally {
    process.chdir(originalCwd);
  }
});

test('classifyBranchConflictState: CLEAN with an unresolvable merge-base reports false with an undetermined note, never a silent false-negative', async () => {
  const fixture = loadFixture('clean');
  // The prNumber argument is deliberately `0` (not the fixture's real
  // `101`), not just `fixture.prData.baseRefName: ''` below: since #1535,
  // computeMergeBase also tries a head-ref fetch fallback
  // (refs/pull/<prNumber>/head), gated on prNumber looking like a real
  // positive-integer PR number. A real-looking prNumber here would let that
  // new fetch attempt reach the network (test-owner/test-repo is not a real
  // remote) even with baseRefName short-circuiting the base-ref fetch --
  // `0` fails the same canonical-positive-integer check tryFetchHead uses,
  // short-circuiting the head-ref fetch too, so this test stays hermetic.
  // This test does not assert on `result.prNumber`, so the substitution is
  // safe.
  const result = await classifyBranchConflictState(0, {
    owner: 'test-owner',
    repo: 'test-repo',
    // Deliberately no _skipGitProbe: the fixture's placeholder SHAs are not
    // real git objects, so the initial merge-base lookup fails.
    // baseRefName is overridden to '' so the base-ref fallback-fetch guard
    // (`if (!prBaseRef) return;`) short-circuits before attempting a real
    // network fetch -- keeping this test hermetic and fast -- while still
    // exercising the "merge-base not found" path: baseAdvancedSinceMergeBase
    // must still read `false`, but must NOT read the same as a confirmed
    // base-unmoved result -- a distinguishing note is required (see the
    // computeBaseAdvanced doc comment).
    _testPrData: { ...fixture.prData, baseRefName: '' },
  });
  assert.equal(result.baseAdvancedSinceMergeBase, false);
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes('undetermined')),
    'expected a note distinguishing "undetermined" from a confirmed unmoved base',
  );
});

// #1519: tryFetchBase's single --depth=1 fetch could not expose a common
// ancestor from a genuinely shallow checkout or missing base history.
// resolveMergeBaseWithRetry is the extracted, directly-testable bounded
// retry loop that now backs computeMergeBase; the "deepened-success" test
// below exercises it against a *real* shallow git clone (fresh, not shared,
// so it can be safely deepened) so that path is proven with genuine
// shallow-git semantics, not just callback call-counts.

test('resolveMergeBaseWithRetry: a genuinely shallow checkout resolves after a deepening fetch', () => {
  const { dir: upstreamDir, branch, commits } = createUpstreamRepo();
  const shallowDir = createFreshShallowClone(upstreamDir);
  assert.equal(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: shallowDir,
      encoding: 'utf8',
    }).trim(),
    'true',
    'fixture setup bug: the clone must genuinely be shallow for this test to mean anything',
  );
  // commits[0] is the oldest (root) commit -- several generations behind the
  // shallow clone's sole local commit (the tip, commits[commits.length - 1]).
  // A depth=1 clone cannot see it yet, so the initial local merge-base
  // lookup (and the first --depth=1 step, already satisfied by the clone)
  // both fail; a later --deepen step must widen far enough to expose it.
  const headSha = commits[commits.length - 1];
  const baseSha = commits[0];
  const widenedSteps: number[] = [];
  const result = resolveMergeBaseWithRetry(
    () => mergeBaseText(shallowDir, headSha, baseSha),
    (step) => {
      widenedSteps.push(step);
      return fetchShallowFixtureStep(
        shallowDir,
        branch,
        MERGE_BASE_FETCH_STEPS[step],
      );
    },
    MERGE_BASE_FETCH_STEPS.length,
  );
  assert.equal(result, baseSha);
  assert.ok(
    widenedSteps.length >= 1 &&
      widenedSteps.length < MERGE_BASE_FETCH_STEPS.length,
    `expected resolution after a deepening step and before exhausting the cap, got ${JSON.stringify(widenedSteps)}`,
  );
});

// #1535: #1519's retry above only re-fetches the *base* ref, so it cannot
// help when the PR **head**'s own ancestry is missing from the local
// object store entirely (e.g. a fork PR, or a checkout that only ever
// fetched the base branch) -- deepening the base side can never retrieve
// commits that were never fetched from any remote in the first place.
// tryFetchHead (production code) fetches `refs/pull/<prNumber>/head` from
// the same base-repository remote to close this gap; the test below proves
// the same underlying shallow-git mechanism against a *real* local fixture,
// mirroring tryFetchHead's exact fetch shape without going through its own
// (deliberately untested, per its doc comment) network-URL assembly.
//
// The widen step below explicitly deepens *both* `branch` (the base line)
// and `featureBranch` (standing in for the PR head) at every retry step --
// mirroring computeMergeBase's actual combined step (`baseFetched ||
// headFetched`) exactly, rather than deepening only one side and relying on
// git's shallow-boundary bookkeeping to have incidentally widened the
// other. Each explicit `--deepen` targets its own named ref directly, so
// this does not depend on any cross-ref widening side effect.

test('resolveMergeBaseWithRetry: a genuinely shallow PR head, entirely absent locally, resolves once both sides are deepened', () => {
  const {
    dir: upstreamDir,
    branch,
    commits,
    featureBranch,
    featureCommits,
  } = createUpstreamRepo();
  // A --depth=1 clone of the *base* branch only -- this checkout has the
  // base ref's tip, but has never fetched featureBranch (standing in for
  // the PR head's own ref/remote) at all: the head commit is not merely
  // shallow, it is completely absent from the local object database, the
  // exact #1535 gap.
  const shallowDir = createFreshShallowClone(upstreamDir);
  const headSha = featureCommits[featureCommits.length - 1];
  const baseSha = commits[commits.length - 1];
  assert.equal(
    mergeBaseText(shallowDir, headSha, baseSha),
    '',
    'fixture setup bug: the PR head commit must be entirely unresolvable before any head-side fetch',
  );
  const widenedSteps: number[] = [];
  const result = resolveMergeBaseWithRetry(
    () => mergeBaseText(shallowDir, headSha, baseSha),
    (step) => {
      widenedSteps.push(step);
      const fetchArgs = MERGE_BASE_FETCH_STEPS[step];
      // Mirrors computeMergeBase's real combined widen step: attempt both
      // tryFetchBase's shape (deepen `branch`) and tryFetchHead's shape
      // (deepen `featureBranch`) at the same escalating depth/deepen args,
      // widening if either succeeds.
      const baseWidened = fetchShallowFixtureStep(
        shallowDir,
        branch,
        fetchArgs,
      );
      const headWidened = fetchShallowFixtureStep(
        shallowDir,
        featureBranch,
        fetchArgs,
      );
      return baseWidened || headWidened;
    },
    MERGE_BASE_FETCH_STEPS.length,
  );
  // The true shared ancestor is commits[2] (where featureBranch forked from
  // the main line) -- reachable only once *both* sides are deepened enough
  // to expose it: a first depth=1 fetch of featureBranch only brings its
  // own tip commit with no parent history yet, and baseSha's own shallow
  // boundary must also widen back far enough to reach commits[2].
  assert.equal(result, commits[2]);
  assert.ok(
    widenedSteps.length >= 1 &&
      widenedSteps.length < MERGE_BASE_FETCH_STEPS.length,
    `expected resolution after a deepening step and before exhausting the cap, got ${JSON.stringify(widenedSteps)}`,
  );
});

test('resolveMergeBaseWithRetry: still reports undetermined (null) after exhausting the bounded retry', () => {
  const { dir: upstreamDir, commits } = createUpstreamRepo();
  const headSha = commits[commits.length - 1];
  // A syntactically valid but nonexistent object: never resolvable no
  // matter how much history is available, so this deterministically covers
  // the true "exhausted the cap" path -- every bounded attempt reports a
  // successful widen, yet the lookup never resolves -- distinct from the
  // pre-existing baseRefName: '' short-circuit test above (which breaks on
  // the very first step instead of exhausting all of them). `widenHistory`
  // is a trivial stub here (always succeeds) because the scenario under
  // test is retry-cap exhaustion, not deepening mechanics -- that is
  // already covered by the real-clone test above.
  const unreachableSha = 'f'.repeat(40);
  const widenedSteps: number[] = [];
  const result = resolveMergeBaseWithRetry(
    () => mergeBaseText(upstreamDir, headSha, unreachableSha),
    (step) => {
      widenedSteps.push(step);
      return true;
    },
    MERGE_BASE_FETCH_STEPS.length,
  );
  assert.equal(result, null);
  assert.deepEqual(
    widenedSteps,
    MERGE_BASE_FETCH_STEPS.map((_, i) => i),
    'expected every bounded step to be attempted before giving up',
  );
});

test('resolveMergeBaseWithRetry: stops immediately when widenHistory cannot help, without exhausting the cap', () => {
  // Pure control-flow coverage (no git involved): mirrors tryFetchBase
  // returning false for a structurally-impossible fetch (missing base ref,
  // or missing owner/repo) -- retrying further would just repeat the same
  // no-op, so the loop must not call widenHistory again after a false.
  let widenCalls = 0;
  const result = resolveMergeBaseWithRetry(
    () => '',
    () => {
      widenCalls += 1;
      return false;
    },
    3,
  );
  assert.equal(result, null);
  assert.equal(widenCalls, 1);
});

test('resolveMergeBaseWithRetry: never calls widenHistory when the first lookup already resolves', () => {
  let widenCalls = 0;
  const result = resolveMergeBaseWithRetry(
    () => 'already-resolved-sha',
    () => {
      widenCalls += 1;
      return true;
    },
    3,
  );
  assert.equal(result, 'already-resolved-sha');
  assert.equal(widenCalls, 0);
});

// #2989 review, Copilot round 3: resolveFetchAttemptTimeoutMs is the
// pure budget/skip arithmetic computeMergeBase's retry loop uses to
// bound its overall wait -- extracted specifically so a regression here
// (propagating the wrong remaining timeout, enforcing the wrong skip
// floor, or not stopping after the deadline) is caught directly,
// without needing a real `git fetch` at the untested call sites this
// feeds.

test('resolveFetchAttemptTimeoutMs: returns the full per-attempt cap when the whole budget remains', () => {
  const now = 1_000_000;
  const deadline = now + 2 * 120_000; // OVERALL_FETCH_BUDGET_MS
  assert.equal(resolveFetchAttemptTimeoutMs(deadline, now), 120_000);
});

test('resolveFetchAttemptTimeoutMs: clamps to the remaining budget once it is below the per-attempt cap', () => {
  const now = 1_000_000;
  const deadline = now + 60_000; // less than the 120s per-attempt cap
  assert.equal(resolveFetchAttemptTimeoutMs(deadline, now), 60_000);
});

test('resolveFetchAttemptTimeoutMs: returns null once the remaining budget drops below the minimum floor', () => {
  const now = 1_000_000;
  const deadline = now + 4_999; // one ms under MIN_FETCH_ATTEMPT_MS (5s)
  assert.equal(resolveFetchAttemptTimeoutMs(deadline, now), null);
});

test('resolveFetchAttemptTimeoutMs: the minimum floor itself is still a valid attempt (boundary, not skipped)', () => {
  const now = 1_000_000;
  const deadline = now + 5_000; // exactly MIN_FETCH_ATTEMPT_MS
  assert.equal(resolveFetchAttemptTimeoutMs(deadline, now), 5_000);
});

test('resolveFetchAttemptTimeoutMs: returns null once the deadline has already passed', () => {
  const now = 1_000_000;
  const deadline = now - 1;
  assert.equal(resolveFetchAttemptTimeoutMs(deadline, now), null);
});

test('classifyBranchConflictState: published is true when head SHA is present', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
    // Same reasoning as the CONFLICTING test above (#2990): the `clean`
    // fixture's placeholder SHAs and nonexistent test-owner/test-repo
    // would otherwise reach a real, hanging git fetch via
    // computeBaseAdvanced. `published` is derived from `prHeadSha`
    // before the probe ever runs, so this assertion is unaffected.
    _skipGitProbe: true,
  });
  assert.equal(result.published, true);
});

test('classifyBranchConflictState: published is false when head SHA is absent', async () => {
  const fixture = loadFixture('missing-sha');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.published, false);
});

// #1454: tryFetchBase hardcoded `https://github.com/...` as the base-ref
// fetch fallback remote, breaking (or worse, silently mis-targeting) GHES
// checkouts. parseGitFetchOrigin / resolveFetchOrigin are the extracted,
// independently unit-testable pieces of that fix. Both findings below
// (HTTP-scheme preservation, username-less scp-like remotes) came from an
// independent Codex review pass on the PR.

test('parseGitFetchOrigin: extracts scheme+host from an HTTPS GHES remote, preserving a non-default port', () => {
  assert.deepEqual(
    parseGitFetchOrigin('https://ghes.example.com:8443/owner/repo.git'),
    { scheme: 'https', host: 'ghes.example.com:8443' },
  );
});

test('parseGitFetchOrigin: preserves http (not https) for a plain HTTP GHES remote', () => {
  // An http://-only GHES instance (no TLS) must stay http: silently
  // upgrading to https on the same port would target a port that is not
  // serving TLS, and the fetch would fail even though the configured
  // remote is reachable over plain HTTP.
  assert.deepEqual(
    parseGitFetchOrigin('http://ghes.example.com:8080/owner/repo.git'),
    { scheme: 'http', host: 'ghes.example.com:8080' },
  );
});

test('parseGitFetchOrigin: strips embedded credentials from an actions/checkout-style origin, keeping only the host', () => {
  // actions/checkout writes `origin` as
  // `https://x-access-token:<token>@host/owner/repo` -- the real-world CI
  // shape this fix targets. URL() parses the token into userinfo, not the
  // host, so it never leaks into the constructed fetch URL.
  assert.deepEqual(
    parseGitFetchOrigin(
      'https://x-access-token:ghs_abc123@ghes.example.com/owner/repo',
    ),
    { scheme: 'https', host: 'ghes.example.com' },
  );
});

test('parseGitFetchOrigin: returns null for an ssh:// origin instead of guessing an HTTPS host', () => {
  // An ssh:// hostname is sometimes an SSH-only alias with no HTTPS
  // service of its own -- guessing wrong would regress a
  // previously-working github.com fallback into a broken fetch, so this
  // signal is unusable rather than guessed at (see the dedicated
  // ssh.github.com regression test below for the concrete case this
  // protects against).
  assert.equal(
    parseGitFetchOrigin('ssh://git@ghes.example.com:2222/owner/repo.git'),
    null,
  );
});

test("parseGitFetchOrigin: returns null for GitHub's documented SSH-over-443 endpoint, not a broken HTTPS host", () => {
  // ssh.github.com is GitHub's own documented alias for SSH traffic over
  // the HTTPS port (firewall traversal); it accepts SSH, not HTTPS, on
  // that hostname. Before #1454, this checkout shape already worked via
  // the hardcoded github.com default -- treating the ssh:// origin's
  // hostname as reusable for HTTPS would have silently regressed it to
  // an unreachable https://ssh.github.com fetch (found by Codex review on
  // PR #1470).
  assert.equal(
    parseGitFetchOrigin('ssh://git@ssh.github.com:443/owner/repo.git'),
    null,
  );
});

test('parseGitFetchOrigin: extracts host from the scp-like SSH shorthand with a username', () => {
  assert.deepEqual(parseGitFetchOrigin('git@ghes.example.com:owner/repo.git'), {
    scheme: 'https',
    host: 'ghes.example.com',
  });
});

test('parseGitFetchOrigin: extracts host from the scp-like SSH shorthand without a username', () => {
  // Git's documented scp-like URL form is `[user@]host:path` -- the
  // username is optional, so a bare `ghes.example.com:owner/repo.git`
  // (no `user@` prefix) is a valid, real-world GHES remote.
  assert.deepEqual(parseGitFetchOrigin('ghes.example.com:owner/repo.git'), {
    scheme: 'https',
    host: 'ghes.example.com',
  });
});

test('parseGitFetchOrigin: extracts a bracketed IPv6 host from the scp-like shorthand', () => {
  // The generic scp-like host pattern stops at the first colon, which
  // would otherwise truncate an IPv6 literal (`[2001:db8::1]`) to
  // `[2001`; the bracketed form must be matched before the generic one.
  assert.deepEqual(parseGitFetchOrigin('git@[2001:db8::1]:owner/repo.git'), {
    scheme: 'https',
    host: '[2001:db8::1]',
  });
});

test('parseGitFetchOrigin: extracts github.com from the pre-existing HTTPS form, lowercased', () => {
  assert.deepEqual(parseGitFetchOrigin('https://GitHub.com/owner/repo.git'), {
    scheme: 'https',
    host: 'github.com',
  });
});

test('parseGitFetchOrigin: returns null for empty or whitespace-only input', () => {
  assert.equal(parseGitFetchOrigin(''), null);
  assert.equal(parseGitFetchOrigin('   '), null);
});

test('parseGitFetchOrigin: returns null for a host-less file:// URL', () => {
  assert.equal(parseGitFetchOrigin('file:///some/local/path.git'), null);
});

test('parseGitFetchOrigin: returns null for an unparseable, scheme-less, colon-less string', () => {
  assert.equal(parseGitFetchOrigin('not a url'), null);
});

test('parseGitFetchOrigin: returns null for a Windows-style local path, not the drive letter as a host', () => {
  // A single-character "host" (`C:\Users\...`, `C:repo.git`) is almost
  // certainly a Windows drive letter, never a real git host -- excluded
  // explicitly rather than by requiring a `user@` prefix, since that
  // would also reject the valid username-less scp-like form covered
  // above.
  assert.equal(parseGitFetchOrigin('C:\\Users\\foo\\repo.git'), null);
  assert.equal(parseGitFetchOrigin('C:repo.git'), null);
});

test('resolveFetchOrigin: regression -- resolves to https://github.com when GH_HOST is unset and origin does not resolve', () => {
  // Existing github.com-hosted behavior must stay unchanged. Injecting an
  // empty-returning reader exercises the literal `github.com` fallback
  // constant directly, rather than incidentally depending on whatever
  // this checkout's own real `origin` remote happens to be.
  assert.deepEqual(resolveFetchOrigin({}, { readOriginUrl: () => '' }), {
    scheme: 'https',
    host: 'github.com',
  });
});

test('resolveFetchOrigin: honors a GH_HOST override to a non-github.com host, always as https', () => {
  assert.deepEqual(
    resolveFetchOrigin(
      { GH_HOST: 'ghes.example.com' },
      { readOriginUrl: () => '' },
    ),
    { scheme: 'https', host: 'ghes.example.com' },
  );
});

test('resolveFetchOrigin: lowercases a mixed-case GH_HOST for consistency with the origin-derived path', () => {
  assert.deepEqual(
    resolveFetchOrigin(
      { GH_HOST: 'GHES.Example.COM' },
      { readOriginUrl: () => '' },
    ),
    { scheme: 'https', host: 'ghes.example.com' },
  );
});

test('resolveFetchOrigin: falls back to a non-github.com origin remote when GH_HOST is unset', () => {
  assert.deepEqual(
    resolveFetchOrigin(
      {},
      { readOriginUrl: () => 'http://ghes.example.com/owner/repo.git' },
    ),
    { scheme: 'http', host: 'ghes.example.com' },
  );
});

test('resolveFetchOrigin: falls through to the github.com default for an ssh:// origin, not a guessed host', () => {
  // End-to-end confirmation of the ssh.github.com regression fix: an
  // ssh:// origin (unresolvable per parseGitFetchOrigin) must not block
  // or corrupt resolution -- it falls through to the same github.com
  // default as no origin at all, exactly matching this checkout shape's
  // pre-#1454 behavior.
  assert.deepEqual(
    resolveFetchOrigin(
      {},
      { readOriginUrl: () => 'ssh://git@ssh.github.com:443/owner/repo.git' },
    ),
    { scheme: 'https', host: 'github.com' },
  );
});

test('resolveFetchOrigin: GH_HOST takes precedence over a resolvable non-github.com origin', () => {
  assert.deepEqual(
    resolveFetchOrigin(
      { GH_HOST: 'override.example.com' },
      { readOriginUrl: () => 'https://ghes.example.com/owner/repo.git' },
    ),
    { scheme: 'https', host: 'override.example.com' },
  );
});

test('resolveFetchOrigin: a whitespace-only GH_HOST is ignored, falling through to origin resolution', () => {
  assert.deepEqual(
    resolveFetchOrigin(
      { GH_HOST: '   ' },
      { readOriginUrl: () => 'https://ghes.example.com/owner/repo.git' },
    ),
    { scheme: 'https', host: 'ghes.example.com' },
  );
});

test('parseArgs: valid --pr parses to a positive-integer string', () => {
  const args = parseArgs(['--pr', '1082', '--owner', 'o', '--repo', 'r']);
  assert.equal(args.prNumber, '1082');
  assert.equal(args.owner, 'o');
  assert.equal(args.repo, 'r');
  assert.equal(args.help, false);
});

test('parseArgs: a flag-shaped --pr value throws instead of consuming the flag', () => {
  // `--pr --json` must fail fast, not assign `--json` as the PR number.
  assert.throws(() => parseArgs(['--pr', '--json']), /missing value/);
  assert.throws(() => parseArgs(['--owner', '--repo']), /missing value/);
  // A trailing flag with no value at all also fails closed.
  assert.throws(() => parseArgs(['--pr']), /missing value/);
});

test('parseArgs: an unknown argument throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['1082']), /unknown argument/);
});

test('parseArgs: a non-positive / non-integer --pr throws a clear message', () => {
  assert.throws(() => parseArgs(['--pr', '0']), /invalid --pr value/);
  assert.throws(() => parseArgs(['--pr', '-5']), /invalid --pr value/);
  assert.throws(() => parseArgs(['--pr', '12abc']), /invalid --pr value/);
});

// #3497: each call site's next step is derived once here, from the branch
// state, the CLEAN-only `clean` definition, and the policy input.
test('resolveCallSiteRouting: one row per routing-table state', () => {
  const proceed = {
    eBranchSync: 'proceed-to-f1',
    e11: 'skip-merge',
    f1: 'proceed-to-f2',
  };
  const hold = { eBranchSync: 'hold', e11: 'skip-merge', f1: 'hold' };
  const rows: [string, unknown, boolean, unknown][] = [
    ['clean', 'CLEAN', true, proceed],
    ['clean', 'CLEAN', false, proceed],
    ['clean', 'BLOCKED', false, hold],
    ['clean', null, false, hold],
    ['behind-no-conflict', 'BEHIND', false, proceed],
    [
      'behind-no-conflict',
      'BEHIND',
      true,
      {
        eBranchSync: 'sync-path',
        e11: 'skip-merge',
        f1: 'return-to-e-phase-branch-sync',
      },
    ],
    [
      'content-conflict',
      'DIRTY',
      true,
      {
        eBranchSync: 'sync-path',
        e11: 'merge-development-branch',
        f1: 'return-to-e-phase-branch-sync',
      },
    ],
    [
      'computing',
      'UNKNOWN',
      false,
      { eBranchSync: 'retry', e11: 'skip-merge', f1: 'retry' },
    ],
    ['dirty', 'DIRTY', true, hold],
    ['unknown', null, true, hold],
    ['force-push-exception', 'CLEAN', false, hold],
  ];
  for (const [state, status, requires, expected] of rows) {
    assert.deepEqual(
      resolveCallSiteRouting(state, status, requires as boolean, []),
      expected,
      `${state} / ${String(status)} / requiresUpToDateHead=${requires}`,
    );
  }
});

// #4209: UNSTABLE is conflict-free but not CLEAN. F1 proceeds only when every
// non-passing head run is non-required and still waiting; anything else holds.
test('resolveCallSiteRouting: UNSTABLE proceeds only past non-required waiting runs', () => {
  const proceed = {
    eBranchSync: 'proceed-to-f1',
    e11: 'skip-merge',
    f1: 'proceed-to-f2',
  };
  const hold = { eBranchSync: 'hold', e11: 'skip-merge', f1: 'hold' };
  const run = (state: string, required = false): NonPassingRun => ({
    name: 'companion',
    state,
    required,
  });
  const cases: [string, NonPassingRun[], unknown][] = [
    ['only non-required action_required', [run('action_required')], proceed],
    ['only non-required pending', [run('pending')], proceed],
    ['only non-required failure', [run('failure')], hold],
    ['failing required run', [run('failure', true)], hold],
    ['empty list', [], hold],
    [
      'waiting run plus a required pending run',
      [run('action_required'), run('pending', true)],
      hold,
    ],
  ];
  for (const [label, runs, expected] of cases) {
    assert.deepEqual(
      resolveCallSiteRouting('clean', 'UNSTABLE', true, runs),
      expected,
      label,
    );
  }
  assert.deepEqual(
    resolveCallSiteRouting('clean', 'UNSTABLE', true, [run('action_required')]),
    proceed,
  );
  assert.deepEqual(resolveCallSiteRouting('clean', 'CLEAN', true, []), proceed);
});

test('parseNonPassingRuns: keeps only non-passing runs and fails closed', () => {
  const runs = parseNonPassingRuns([
    {
      __typename: 'CheckRun',
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      isRequired: true,
    },
    {
      __typename: 'CheckRun',
      name: 'IDD advisory-convergence comment refresh',
      status: 'COMPLETED',
      conclusion: 'ACTION_REQUIRED',
      isRequired: false,
    },
    {
      __typename: 'CheckRun',
      name: 'queued-run',
      status: 'QUEUED',
      conclusion: null,
      isRequired: false,
    },
    {
      __typename: 'StatusContext',
      context: 'CodeRabbit',
      state: 'SUCCESS',
      isRequired: false,
    },
    {
      __typename: 'StatusContext',
      context: 'expected-check',
      state: 'EXPECTED',
      isRequired: null,
    },
    {
      __typename: 'StatusContext',
      context: 'requested-check',
      state: 'REQUESTED',
      isRequired: false,
    },
    {
      __typename: 'CheckRun',
      name: 'Windows platform tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      isRequired: false,
    },
    {
      __typename: 'CheckRun',
      name: 'not-applicable-run',
      status: 'COMPLETED',
      conclusion: 'NOT_APPLICABLE',
      isRequired: false,
    },
    {
      __typename: 'CheckRun',
      name: 'odd-status',
      status: 'SOMETHING_NEW',
      conclusion: null,
      isRequired: false,
    },
    { __typename: 'Mystery' },
  ]);
  assert.deepEqual(runs, [
    {
      name: 'IDD advisory-convergence comment refresh',
      state: 'action_required',
      required: false,
    },
    { name: 'queued-run', state: 'pending', required: false },
    { name: 'expected-check', state: 'pending', required: true },
    { name: 'requested-check', state: 'pending', required: false },
    { name: 'Windows platform tests', state: 'failure', required: false },
    { name: 'odd-status', state: 'unknown', required: false },
    { name: '', state: 'unknown', required: true },
  ]);
});

test('parseHeadRollup: fails closed unless the pinned head and full rollup match', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const contexts = (totalCount: number, nodes: unknown[]) => ({
    oid: sha,
    statusCheckRollup: { contexts: { totalCount, nodes } },
  });
  const waiting = {
    __typename: 'CheckRun',
    name: 'refresh',
    status: 'COMPLETED',
    conclusion: 'ACTION_REQUIRED',
    isRequired: false,
  };
  assert.deepEqual(parseHeadRollup(contexts(1, [waiting]), sha), {
    runs: [{ name: 'refresh', state: 'action_required', required: false }],
    notes: [],
  });
  const hold = (object: unknown) => parseHeadRollup(object, sha).runs;
  assert.deepEqual(hold(null), []);
  assert.deepEqual(
    hold({ ...contexts(1, [waiting]), oid: 'f'.repeat(40) }),
    [],
  );
  assert.deepEqual(hold({ oid: sha, statusCheckRollup: null }), []);
  assert.deepEqual(hold(contexts(101, [waiting])), []);
  // A zero, NaN, or missing count is inconsistent with the page, so it holds.
  assert.deepEqual(hold(contexts(0, [waiting])), []);
  assert.deepEqual(hold(contexts(Number.NaN, [waiting])), []);
  assert.deepEqual(
    hold({ oid: sha, statusCheckRollup: { contexts: { nodes: [waiting] } } }),
    [],
  );
  assert.match(
    parseHeadRollup(null, sha).notes[0] ?? '',
    /UNSTABLE non-passing run list unavailable/,
  );
});

// #4209 review: a rerun can leave the stale instance in the rollup beside the
// current one. Only the latest instance of each name governs.
test('parseHeadRollup: judges only the latest instance of each check name', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const run = (
    name: string,
    status: string,
    conclusion: string | null,
    completedAt: string | null,
  ) => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    completedAt,
    isRequired: false,
    checkSuite: {
      app: { databaseId: 15368, slug: 'github-actions' },
      workflowRun: { workflow: { databaseId: 1, name: 'CI' } },
    },
  });
  const nodes = [
    run('refresh', 'COMPLETED', 'FAILURE', '2026-10-14T08:00:00Z'),
    run('refresh', 'COMPLETED', 'ACTION_REQUIRED', '2026-10-14T09:00:00Z'),
    run('lint', 'COMPLETED', 'FAILURE', '2026-10-14T08:00:00Z'),
    run('lint', 'COMPLETED', 'SUCCESS', '2026-10-14T09:00:00Z'),
    run('rerun-pending', 'COMPLETED', 'FAILURE', '2026-10-14T08:00:00Z'),
    run('rerun-pending', 'QUEUED', null, null),
  ];
  const object = {
    oid: sha,
    statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
  };
  assert.deepEqual(parseHeadRollup(object, sha).runs, [
    { name: 'refresh', state: 'action_required', required: false },
    { name: 'rerun-pending', state: 'pending', required: false },
  ]);
});

// #4209 review: same-named runs from different producers are not reruns of
// each other, so a stale failure from one workflow must not hide the other.
test('parseHeadRollup: keeps same-named check runs from different producers apart', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const producer = (workflowId: number, workflow: string) => ({
    app: { databaseId: 15368, slug: 'github-actions' },
    workflowRun: { workflow: { databaseId: workflowId, name: workflow } },
  });
  const nodes = [
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-10-14T08:00:00Z',
      isRequired: false,
      checkSuite: producer(101, 'ci-a'),
    },
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'COMPLETED',
      conclusion: 'ACTION_REQUIRED',
      completedAt: '2026-10-14T09:00:00Z',
      isRequired: false,
      checkSuite: producer(202, 'ci-b'),
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'shared', state: 'failure', required: false },
      { name: 'shared', state: 'action_required', required: false },
    ],
  );
});

// A re-posted status context has no producer identity in GraphQL, so the
// older state is kept beside the newer one and judged on its own. A stale
// failure then holds, which fails closed.
test('parseHeadRollup: keeps every re-posted status context', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const nodes = [
    {
      __typename: 'StatusContext',
      context: 'legacy',
      state: 'FAILURE',
      isRequired: false,
    },
    {
      __typename: 'StatusContext',
      context: 'legacy',
      state: 'PENDING',
      isRequired: false,
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'legacy', state: 'failure', required: false },
      { name: 'legacy', state: 'pending', required: false },
    ],
  );
});

// A check run with no App or workflow identity cannot be attributed to a
// producer, so same-named runs without one are never merged.
test('parseHeadRollup: keeps same-named check runs without a producer apart', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const nodes = [
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-10-14T08:00:00Z',
      isRequired: false,
    },
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'COMPLETED',
      conclusion: 'ACTION_REQUIRED',
      completedAt: '2026-10-14T09:00:00Z',
      isRequired: false,
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'shared', state: 'failure', required: false },
      { name: 'shared', state: 'action_required', required: false },
    ],
  );
});

// #4209 review: the same status context name from two creators must not
// collapse, or a stale failure from one creator could hide the other's run.
test('parseHeadRollup: keeps the same status context name from two creators apart', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const nodes = [
    {
      __typename: 'StatusContext',
      context: 'shared',
      state: 'FAILURE',
      createdAt: '2026-10-14T08:00:00Z',
      creator: { login: 'bot-a' },
      isRequired: false,
    },
    {
      __typename: 'StatusContext',
      context: 'shared',
      state: 'PENDING',
      createdAt: '2026-10-14T09:00:00Z',
      creator: { login: 'bot-b' },
      isRequired: false,
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'shared', state: 'failure', required: false },
      { name: 'shared', state: 'pending', required: false },
    ],
  );
});

// A status context with no creator cannot be attributed to one producer, so
// it keeps its own slot instead of collapsing with a same-named entry.
test('parseHeadRollup: keeps status contexts without a creator apart', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const nodes = [
    {
      __typename: 'StatusContext',
      context: 'orphan',
      state: 'FAILURE',
      createdAt: '2026-10-14T08:00:00Z',
      creator: null,
      isRequired: false,
    },
    {
      __typename: 'StatusContext',
      context: 'orphan',
      state: 'PENDING',
      createdAt: '2026-10-14T09:00:00Z',
      creator: null,
      isRequired: false,
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'orphan', state: 'failure', required: false },
      { name: 'orphan', state: 'pending', required: false },
    ],
  );
});

// #4209 review: a completed rerun whose completion time cannot be read must
// not hide the older failure it may supersede. Every instance is kept.
test('parseHeadRollup: keeps every instance when a completed rerun has no valid timestamp', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const nodes = [
    {
      __typename: 'CheckRun',
      name: 'refresh',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-10-14T08:00:00Z',
      isRequired: false,
      checkSuite: {
        app: { databaseId: 15368, slug: 'github-actions' },
        workflowRun: { workflow: { databaseId: 1, name: 'CI' } },
      },
    },
    {
      __typename: 'CheckRun',
      name: 'refresh',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      completedAt: 'not-a-time',
      isRequired: false,
      checkSuite: {
        app: { databaseId: 15368, slug: 'github-actions' },
        workflowRun: { workflow: { databaseId: 1, name: 'CI' } },
      },
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [{ name: 'refresh', state: 'failure', required: false }],
  );
});

// #4209 review: an unrecognized status is never ordered, so it cannot be
// hidden by a newer waiting run of the same name and producer.
test('parseHeadRollup: keeps an unrecognized check state beside a waiting run of its name', () => {
  const sha = 'd061d433cbaf1ad0b92337263d53237130e9cf5d';
  const checkSuite = {
    app: { databaseId: 15368, slug: 'github-actions' },
    workflowRun: { workflow: { databaseId: 1, name: 'CI' } },
  };
  const nodes = [
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'SOMETHING_NEW',
      conclusion: null,
      isRequired: false,
      checkSuite,
    },
    {
      __typename: 'CheckRun',
      name: 'shared',
      status: 'QUEUED',
      conclusion: null,
      isRequired: false,
      checkSuite,
    },
  ];
  assert.deepEqual(
    parseHeadRollup(
      {
        oid: sha,
        statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
      },
      sha,
    ).runs,
    [
      { name: 'shared', state: 'unknown', required: false },
      { name: 'shared', state: 'pending', required: false },
    ],
  );
});

test('classifyBranchConflictState: UNSTABLE routing reads the injected run list', async () => {
  const fixture = loadFixture('clean');
  const base = {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: { ...fixture.prData, mergeStateStatus: 'UNSTABLE' },
    _testRequiresUpToDateHead: false,
    _skipGitProbe: true,
  };
  const waiting: NonPassingRun[] = [
    { name: 'refresh', state: 'action_required', required: false },
  ];
  const proceed = await classifyBranchConflictState(fixture.prData.number, {
    ...base,
    _testNonPassingRuns: waiting,
  });
  assert.equal(proceed.callSiteRouting.f1, 'proceed-to-f2');
  assert.equal(proceed.callSiteRouting.eBranchSync, 'proceed-to-f1');
  const held = await classifyBranchConflictState(fixture.prData.number, {
    ...base,
    _testNonPassingRuns: [],
  });
  assert.equal(held.callSiteRouting.f1, 'hold');
  assert.match(
    held.diagnostics.notes.join('\n'),
    /no non-passing head run is visible/,
  );
  const offline = await classifyBranchConflictState(
    fixture.prData.number,
    base,
  );
  assert.equal(offline.callSiteRouting.f1, 'hold');
});

// #4309: a check suite with no check run is absent from the status check
// rollup, so a queued external app left UNSTABLE with an empty run list.
// PR 4292 had six such suites (netlify, sentry, coderabbitai, codecov, cursor,
// claude) queued for more than 70 minutes.
test('classifyBranchConflictState: UNSTABLE proceeds past a queued non-required suite', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: { ...fixture.prData, mergeStateStatus: 'UNSTABLE' },
    _testRequiresUpToDateHead: false,
    _skipGitProbe: true,
    _testNonPassingRuns: [
      {
        name: 'netlify',
        state: 'pending',
        suiteStatus: 'queued',
        required: false,
      },
    ],
  });
  assert.equal(result.callSiteRouting.f1, 'proceed-to-f2');
  assert.equal(result.callSiteRouting.eBranchSync, 'proceed-to-f1');
  const notes = result.diagnostics.notes.join('\n');
  assert.match(notes, /netlify \(queued suite, non-required\)/);
  assert.doesNotMatch(notes, /UNSTABLE hold:/);
});

test('classifyBranchConflictState: UNSTABLE holds on a queued required suite and names its app slug', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: { ...fixture.prData, mergeStateStatus: 'UNSTABLE' },
    _testRequiresUpToDateHead: false,
    _skipGitProbe: true,
    _testNonPassingRuns: [
      {
        name: 'sentry',
        state: 'pending',
        suiteStatus: 'queued',
        required: false,
      },
      {
        name: 'netlify',
        state: 'pending',
        suiteStatus: 'queued',
        required: true,
      },
    ],
  });
  assert.equal(result.callSiteRouting.f1, 'hold');
  assert.equal(result.callSiteRouting.eBranchSync, 'hold');
  const holds = result.diagnostics.notes.filter((note) =>
    note.startsWith('UNSTABLE hold:'),
  );
  // Only the entry that blocks the proceed path is named as a hold, with its
  // reason and the condition that resumes F1.
  assert.equal(holds.length, 1);
  assert.match(holds[0] ?? '', /netlify \(queued suite, required\)/);
  assert.match(holds[0] ?? '', /because it is required and has not passed/);
  assert.match(
    holds[0] ?? '',
    /resumes when it passes, or a maintainer clears/,
  );
});

test('describeUnstableHold: names a non-required entry that is not waiting', () => {
  assert.equal(
    describeUnstableHold({
      name: 'Windows platform tests',
      state: 'failure',
      required: false,
    }),
    'UNSTABLE hold: Windows platform tests (failure, non-required) holds F1 because it is non-required but neither pending nor action_required; resumes when it passes, or a maintainer clears the hold.',
  );
  assert.match(
    describeUnstableHold({
      name: 'github-actions/refresh',
      state: 'failure',
      suiteStatus: 'failure',
      required: false,
    }),
    /github-actions\/refresh \(failure suite, non-required\)/,
  );
});

/** A stable App id per slug, so two fixture apps are never one producer. */
const appIdOf = (slug: string): number =>
  [...slug].reduce((id, char) => (id * 31 + char.charCodeAt(0)) % 100_003, 7);

/** One `checkSuites` node as the head-rollup GraphQL query returns it. */
function suiteNode(
  slug: string | null,
  options: {
    appId?: number | null;
    status?: string;
    conclusion?: string | null;
    createdAt?: string;
    runs?: number;
    workflow?: { databaseId: number; name: string } | null;
  } = {},
): unknown {
  return {
    status: options.status ?? 'QUEUED',
    conclusion: options.conclusion ?? null,
    createdAt: options.createdAt ?? '2026-10-14T16:37:56Z',
    app:
      slug === null
        ? null
        : {
            databaseId:
              options.appId === undefined ? appIdOf(slug) : options.appId,
            slug,
          },
    workflowRun: options.workflow ? { workflow: options.workflow } : null,
    checkRuns: { totalCount: options.runs ?? 0 },
  };
}

const suitesOf = (nodes: unknown[], totalCount = nodes.length) => ({
  checkSuites: { totalCount, nodes },
});

test('parseHeadSuites: lists run-less suites by app slug and status', () => {
  const result = parseHeadSuites(
    suitesOf([
      suiteNode('netlify', { appId: 13473 }),
      suiteNode('sentry', { appId: 12637, status: 'IN_PROGRESS' }),
      suiteNode('codecov', { appId: 254, status: 'WAITING' }),
      // A suite with a run is judged through that run in the rollup.
      suiteNode('cursor', { runs: 1 }),
      suiteNode('github-advanced-security', {
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        runs: 1,
      }),
      suiteNode('claude', { status: 'COMPLETED', conclusion: 'SKIPPED' }),
      suiteNode('github-actions', {
        appId: 15368,
        status: 'COMPLETED',
        conclusion: 'ACTION_REQUIRED',
        workflow: { databaseId: 7, name: 'IDD advisory-convergence refresh' },
      }),
      suiteNode('odd-app', { status: 'SOMETHING_NEW' }),
    ]),
  );
  assert.deepEqual(result, {
    suites: [
      {
        name: 'netlify',
        state: 'pending',
        suiteStatus: 'queued',
        appId: 13473,
      },
      {
        name: 'sentry',
        state: 'pending',
        suiteStatus: 'in_progress',
        appId: 12637,
      },
      { name: 'codecov', state: 'pending', suiteStatus: 'waiting', appId: 254 },
      {
        name: 'github-actions/IDD advisory-convergence refresh',
        state: 'action_required',
        suiteStatus: 'action_required',
        appId: 15368,
      },
      {
        name: 'odd-app',
        state: 'unknown',
        suiteStatus: 'something_new',
        appId: appIdOf('odd-app'),
      },
    ],
    notes: [],
  });
});

test('parseHeadSuites: a failed or unfinished-conclusion suite never proceeds', () => {
  const states = (nodes: unknown[]) =>
    parseHeadSuites(suitesOf(nodes)).suites.map((suite) => suite.state);
  assert.deepEqual(
    states([
      suiteNode('a', { status: 'COMPLETED', conclusion: 'FAILURE' }),
      suiteNode('b', { status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }),
      suiteNode('c', { status: 'COMPLETED', conclusion: 'TIMED_OUT' }),
      suiteNode('d', { status: 'COMPLETED', conclusion: null }),
    ]),
    ['failure', 'startup_failure', 'timed_out', 'unknown'],
  );
});

// Observed 2026-10-15: the comment-refresh workflow leaves cancelled suites
// with no run on the head. They are concurrency control, so they list nothing.
test('parseHeadSuites: a run-less cancelled workflow suite is not a check result', () => {
  const result = parseHeadSuites(
    suitesOf([
      suiteNode('github-actions', {
        appId: 15368,
        status: 'COMPLETED',
        conclusion: 'CANCELLED',
        workflow: { databaseId: 7, name: 'refresh' },
      }),
    ]),
  );
  assert.deepEqual(result, { suites: [], notes: [] });
});

// Pull request 4323 review: only an Actions workflow suite is concurrency
// control. A cancelled suite from an external app has no such proof, so it is
// listed as non-passing and holds the branch beside a waiting suite.
test('parseHeadSuites: a run-less cancelled external suite stays listed and holds', () => {
  const sha = 'a13f804ba88e71f2a373c947edbe9d9fc99d2d95';
  const cancelled = suiteNode('netlify', {
    appId: 13473,
    status: 'COMPLETED',
    conclusion: 'CANCELLED',
  });
  assert.deepEqual(parseHeadSuites(suitesOf([cancelled])), {
    suites: [
      {
        name: 'netlify',
        state: 'cancelled',
        suiteStatus: 'cancelled',
        appId: 13473,
      },
    ],
    notes: [],
  });
  const result = parseHeadNonPassing(
    {
      oid: sha,
      statusCheckRollup: { contexts: { totalCount: 0, nodes: [] } },
      ...suitesOf([
        cancelled,
        suiteNode('sentry', { appId: 12637 }),
        // The workflow suite beside it is still skipped.
        suiteNode('github-actions', {
          appId: 15368,
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          workflow: { databaseId: 7, name: 'refresh' },
        }),
      ]),
    },
    sha,
    () => new Set<number>(),
  );
  assert.deepEqual(
    result.runs.map((run) => `${run.name}:${run.state}`),
    ['netlify:cancelled', 'sentry:pending'],
  );
  assert.equal(
    resolveCallSiteRouting('clean', 'UNSTABLE', true, result.runs).f1,
    'hold',
  );
});

test('parseHeadSuites: only the newest suite of each producer governs', () => {
  const workflow = { databaseId: 7, name: 'refresh' };
  const failed = (createdAt: string, extra: object = {}) =>
    suiteNode('github-actions', {
      appId: 15368,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      createdAt,
      workflow,
      ...extra,
    });
  const passed = (createdAt: string) =>
    suiteNode('github-actions', {
      appId: 15368,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      createdAt,
      runs: 1,
      workflow,
    });
  const list = (nodes: unknown[]) => parseHeadSuites(suitesOf(nodes)).suites;
  // A later passing suite of the same workflow supersedes the failed one.
  assert.deepEqual(
    list([failed('2026-10-14T16:40:41Z'), passed('2026-10-14T16:50:39Z')]),
    [],
  );
  // The order does not depend on the node order of the page.
  assert.deepEqual(
    list([passed('2026-10-14T16:50:39Z'), failed('2026-10-14T16:40:41Z')]),
    [],
  );
  // A newer failed suite still holds.
  assert.equal(
    list([passed('2026-10-14T16:40:41Z'), failed('2026-10-14T16:50:39Z')])
      .length,
    1,
  );
  // Suites that share the newest timestamp are not provably ordered.
  assert.equal(
    list([passed('2026-10-14T16:40:41Z'), failed('2026-10-14T16:40:41Z')])
      .length,
    1,
  );
  // A suite without a valid timestamp keeps every member of its group.
  assert.equal(
    list([failed('not a time'), passed('2026-10-14T16:50:39Z')]).length,
    1,
  );
  // A different workflow of the same app is a different producer.
  assert.equal(
    list([
      failed('2026-10-14T16:40:41Z', {
        workflow: { databaseId: 8, name: 'other' },
      }),
      passed('2026-10-14T16:50:39Z'),
    ]).length,
    1,
  );
});

test('parseHeadSuites: a suite without an app is kept and never merged', () => {
  const result = parseHeadSuites(
    suitesOf([
      suiteNode(null, { createdAt: '2026-10-14T16:40:41Z' }),
      suiteNode(null, {
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        createdAt: '2026-10-14T16:50:39Z',
      }),
    ]),
  );
  assert.deepEqual(result.suites, [
    {
      name: 'unknown-app',
      state: 'pending',
      suiteStatus: 'queued',
      appId: null,
    },
  ]);
});

test('parseHeadSuites: fails closed on a missing or inconsistent page', () => {
  const held = (object: unknown, reason: RegExp) => {
    const result = parseHeadSuites(object);
    assert.deepEqual(result.suites, []);
    assert.match(result.notes[0] ?? '', reason);
  };
  const queued = suiteNode('netlify');
  held(null, /no check suites/);
  held({}, /no check suites/);
  held({ checkSuites: { totalCount: 1 } }, /no check suites/);
  held({ checkSuites: { nodes: [queued] } }, /suite count is missing/);
  held(suitesOf([queued], 101), /more check suites than one page/);
  held(suitesOf([queued], 0), /does not match its page/);
  held(
    suitesOf([{ ...(queued as object), checkRuns: null }]),
    /run count is missing/,
  );
});

test('markSuiteRequirement: a suite is required when a pinned check names its app', () => {
  const suites = [
    { name: 'netlify', state: 'pending', suiteStatus: 'queued', appId: 13473 },
    { name: 'sentry', state: 'pending', suiteStatus: 'queued', appId: 12637 },
    { name: 'mystery', state: 'pending', suiteStatus: 'queued', appId: null },
  ];
  const required = (pinned: Set<number> | null) =>
    markSuiteRequirement(suites, pinned).map((run) => run.required);
  assert.deepEqual(required(new Set()), [false, false, true]);
  assert.deepEqual(required(new Set([13473])), [true, false, true]);
  // An unreadable policy marks every suite required.
  assert.deepEqual(required(null), [true, true, true]);
});

test('collectPinnedRequiredAppIds: reads App pins from rules and classic protection', () => {
  const rule = (checks: unknown[]) => ({
    type: 'required_status_checks',
    parameters: { required_status_checks: checks },
  });
  assert.deepEqual(
    collectPinnedRequiredAppIds(
      [
        { type: 'pull_request' },
        rule([
          { context: 'lint' },
          { context: 'build', integration_id: 15368 },
        ]),
      ],
      {
        required_status_checks: {
          contexts: ['legacy'],
          checks: [
            { context: 'deploy', app_id: 13473 },
            { context: 'any', app_id: -1 },
          ],
        },
      },
    ),
    new Set([15368, 13473]),
  );
  assert.deepEqual(collectPinnedRequiredAppIds([], {}), new Set());
  // A pin the read cannot turn into an App id is unresolvable.
  assert.equal(
    collectPinnedRequiredAppIds([rule([{ context: 'x', source: 'app' }])], {}),
    null,
  );
  assert.equal(
    collectPinnedRequiredAppIds([rule([{ integration_id: 'abc' }])], {}),
    null,
  );
  // A required workflow produces Actions suites that no pin names.
  assert.equal(
    collectPinnedRequiredAppIds([{ type: 'workflows', parameters: {} }], {}),
    null,
  );
});

// The shared required-check reader accepts four list keys, in both a rule's
// parameters and the classic protection object. A pin under any of them counts.
test('collectPinnedRequiredAppIds: reads every supported check list key', () => {
  for (const key of [
    'required_status_checks',
    'required_checks',
    'checks',
    'contexts',
  ]) {
    assert.deepEqual(
      collectPinnedRequiredAppIds(
        [
          {
            type: 'required_status_checks',
            parameters: { [key]: [{ context: 'a', integration_id: 11 }] },
          },
        ],
        { required_status_checks: { [key]: [{ context: 'b', app_id: 22 }] } },
      ),
      new Set([11, 22]),
      key,
    );
  }
});

// A shape this read cannot trust is unresolvable, never an empty policy.
test('collectPinnedRequiredAppIds: a malformed payload or list is unresolvable', () => {
  const rule = (parameters: unknown) => [
    { type: 'required_status_checks', parameters },
  ];
  const cases: [string, unknown, unknown][] = [
    ['rules not an array', { type: 'required_status_checks' }, {}],
    ['rule parameters not an object', rule('checks'), {}],
    ['rule list not an array', rule({ required_status_checks: 'lint' }), {}],
    ['classic object not an object', [], { required_status_checks: 'lint' }],
    [
      'classic list not an array',
      [],
      { required_status_checks: { checks: {} } },
    ],
    ['entry is a number', rule({ required_status_checks: [7] }), {}],
    ['entry is a nested array', rule({ required_status_checks: [[1]] }), {}],
    [
      'source pin beside a zero id',
      rule({ checks: [{ source: 'app', integration_id: 0 }] }),
      {},
    ],
    [
      'source pin beside an any-source id',
      rule({ checks: [{ source: 'app', app_id: -1 }] }),
      {},
    ],
    ['pin id is an empty string', rule({ checks: [{ app_id: '' }] }), {}],
    ['pin id is a boolean', rule({ checks: [{ integration_id: true }] }), {}],
    ['pin id is an array', rule({ checks: [{ integration_id: [7] }] }), {}],
    ['pin id is fractional', rule({ checks: [{ integration_id: 1.5 }] }), {}],
    ['rule parameters is an array', rule([]), {}],
    ['rule is an array', [[]], {}],
    ['rule is a string', ['required_status_checks'], {}],
    ['rule is null', [null], {}],
    ['classic object is an array', [], { required_status_checks: [] }],
    ['protection is an array', [], []],
    ['protection is a string', [], 'protected'],
  ];
  for (const [label, rules, protection] of cases) {
    assert.equal(collectPinnedRequiredAppIds(rules, protection), null, label);
  }
  // Each id field counts on its own, and a source pin with a positive id stays
  // readable.
  assert.deepEqual(
    collectPinnedRequiredAppIds(
      rule({
        checks: [
          { integration_id: 0, app_id: 55 },
          { source: 'app', app_id: -1, integration_id: 66 },
        ],
      }),
      {},
    ),
    new Set([55, 66]),
  );
  // A decimal-integer string is an id, and a zero or negative one is any source.
  assert.deepEqual(
    collectPinnedRequiredAppIds(
      rule({ checks: [{ integration_id: '15368' }, { app_id: '-1' }] }),
      {},
    ),
    new Set([15368]),
  );
  // Absent policy parts and null or string entries stay readable.
  assert.deepEqual(collectPinnedRequiredAppIds(null, null), new Set());
  assert.deepEqual(
    collectPinnedRequiredAppIds(rule({ contexts: [null, 'lint'] }), {
      required_status_checks: null,
    }),
    new Set(),
  );
});

test('resolvePinnedRequiredAppIds: a 404 or a failed read is unreadable', () => {
  const ok = (value: unknown) => ({ outcome: 'ok', value });
  const notFound = { outcome: 'not-found' };
  const port = (
    rules: unknown,
    protection: unknown,
  ): Parameters<typeof resolvePinnedRequiredAppIds>[3] =>
    ({
      listBranchRules: () => rules,
      getBranchProtection: () => protection,
    }) as unknown as Parameters<typeof resolvePinnedRequiredAppIds>[3];
  const rules = ok([
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'build', integration_id: 15368 }],
      },
    },
  ]);
  assert.deepEqual(
    resolvePinnedRequiredAppIds('o', 'r', 'main', port(rules, ok({})), false),
    new Set([15368]),
  );
  // A 404 is unreadable unless the trust flag is set.
  assert.equal(
    resolvePinnedRequiredAppIds('o', 'r', 'main', port(rules, notFound), false),
    null,
  );
  assert.deepEqual(
    resolvePinnedRequiredAppIds('o', 'r', 'main', port(rules, notFound), true),
    new Set([15368]),
  );
  const throwing = {
    listBranchRules: () => {
      throw new Error('HTTP 403');
    },
    getBranchProtection: () => notFound,
  } as unknown as Parameters<typeof resolvePinnedRequiredAppIds>[3];
  assert.equal(
    resolvePinnedRequiredAppIds('o', 'r', 'main', throwing, true),
    null,
  );
});

test('parseHeadNonPassing: joins the rollup runs with the run-less suites', () => {
  const sha = 'a13f804ba88e71f2a373c947edbe9d9fc99d2d95';
  const head = (suites: unknown[], rollupNodes: unknown[] = []) => ({
    oid: sha,
    statusCheckRollup: {
      contexts: { totalCount: rollupNodes.length, nodes: rollupNodes },
    },
    ...suitesOf(suites),
  });
  const queuedSix = [
    'netlify',
    'sentry',
    'coderabbitai',
    'codecov',
    'cursor',
    'claude',
  ].map((slug, index) => suiteNode(slug, { appId: 100 + index }));
  let policyReads = 0;
  const policy = (pinned: Set<number> | null) => () => {
    policyReads += 1;
    return pinned;
  };

  // PR 4292: six queued external suites and nothing pinned proceeds.
  const proceed = parseHeadNonPassing(head(queuedSix), sha, policy(new Set()));
  assert.equal(proceed.runs.length, 6);
  assert.deepEqual(proceed.notes, []);
  assert.equal(
    resolveCallSiteRouting('clean', 'UNSTABLE', true, proceed.runs).f1,
    'proceed-to-f2',
  );

  // One of them is pinned by a required check: the branch holds and the
  // listed entry carries the app slug.
  const required = parseHeadNonPassing(
    head(queuedSix),
    sha,
    policy(new Set([101])),
  );
  assert.deepEqual(
    required.runs.filter((run) => run.required).map((run) => run.name),
    ['sentry'],
  );
  assert.equal(
    resolveCallSiteRouting('clean', 'UNSTABLE', true, required.runs).f1,
    'hold',
  );

  // An unreadable policy marks every suite required and says why.
  const unreadable = parseHeadNonPassing(head(queuedSix), sha, policy(null));
  assert.ok(unreadable.runs.every((run) => run.required));
  assert.match(unreadable.notes[0] ?? '', /requirement unavailable/);
  assert.equal(
    resolveCallSiteRouting('clean', 'UNSTABLE', true, unreadable.runs).f1,
    'hold',
  );

  // The rollup's own non-passing runs stay in the list.
  const withRun = parseHeadNonPassing(
    head(
      [suiteNode('netlify')],
      [
        {
          __typename: 'CheckRun',
          name: 'Windows platform tests',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          isRequired: false,
        },
      ],
    ),
    sha,
    policy(new Set()),
  );
  assert.deepEqual(
    withRun.runs.map((run) => run.name),
    ['Windows platform tests', 'netlify'],
  );

  // The policy is read only when a suite is listed.
  policyReads = 0;
  const none = parseHeadNonPassing(
    head([suiteNode('claude', { status: 'COMPLETED', conclusion: 'SUCCESS' })]),
    sha,
    policy(new Set()),
  );
  assert.deepEqual(none, { runs: [], notes: [] });
  assert.equal(policyReads, 0);
});

test('parseHeadNonPassing: an unreadable suite page or rollup holds', () => {
  const sha = 'a13f804ba88e71f2a373c947edbe9d9fc99d2d95';
  const rollup = { contexts: { totalCount: 0, nodes: [] } };
  const readPolicy = () => new Set<number>();
  const noSuites = parseHeadNonPassing(
    { oid: sha, statusCheckRollup: rollup },
    sha,
    readPolicy,
  );
  assert.deepEqual(noSuites.runs, []);
  assert.match(noSuites.notes[0] ?? '', /check suite list unavailable/);
  const noRollup = parseHeadNonPassing(
    { oid: sha, statusCheckRollup: null, ...suitesOf([suiteNode('netlify')]) },
    sha,
    readPolicy,
  );
  assert.deepEqual(noRollup.runs, []);
  assert.match(noRollup.notes[0] ?? '', /non-passing run list unavailable/);
});

test('classifyBranchConflictState: callSiteRouting follows the injected policy input', async () => {
  const fixture = loadFixture('clean');
  const base = {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
    _skipGitProbe: true,
  };
  const required = await classifyBranchConflictState(fixture.prData.number, {
    ...base,
    _testRequiresUpToDateHead: true,
  });
  assert.deepEqual(required.callSiteRouting, {
    eBranchSync: 'proceed-to-f1',
    e11: 'skip-merge',
    f1: 'proceed-to-f2',
  });
  const blocked = await classifyBranchConflictState(fixture.prData.number, {
    ...base,
    _testPrData: { ...fixture.prData, mergeStateStatus: 'BLOCKED' },
    _testRequiresUpToDateHead: false,
  });
  assert.equal(blocked.callSiteRouting.eBranchSync, 'hold');
  assert.equal(blocked.callSiteRouting.f1, 'hold');
});

test('resolveRequiresUpToDateHead: fail closed on unreadable or failed policy reads', () => {
  const okRules = [{ type: 'pull_request' }];
  const port = (
    rules: unknown,
    protection: unknown,
  ): Parameters<typeof resolveRequiresUpToDateHead>[3] =>
    ({
      listBranchRules: () => rules,
      getBranchProtection: () => protection,
    }) as unknown as Parameters<typeof resolveRequiresUpToDateHead>[3];
  const ok = (value: unknown) => ({ outcome: 'ok', value });
  const notFound = { outcome: 'not-found' };
  const strictProtection = ok({
    required_status_checks: { strict: true, contexts: ['ci'] },
  });

  // Readable policy: the value follows summarizeBranchCurrency.
  assert.equal(
    resolveRequiresUpToDateHead(
      'o',
      'r',
      'main',
      port(ok(okRules), strictProtection),
      false,
    ),
    true,
  );
  assert.equal(
    resolveRequiresUpToDateHead(
      'o',
      'r',
      'main',
      port(ok(okRules), ok({})),
      false,
    ),
    false,
  );
  // A 404 is unreadable unless the trust flag is set.
  assert.equal(
    resolveRequiresUpToDateHead(
      'o',
      'r',
      'main',
      port(notFound, notFound),
      false,
    ),
    true,
  );
  assert.equal(
    resolveRequiresUpToDateHead(
      'o',
      'r',
      'main',
      port(notFound, notFound),
      true,
    ),
    false,
  );
  // Any thrown read (403, 500, transport) resolves to true.
  const throwing = {
    listBranchRules: () => {
      throw new Error('HTTP 403');
    },
    getBranchProtection: () => notFound,
  } as unknown as Parameters<typeof resolveRequiresUpToDateHead>[3];
  assert.equal(
    resolveRequiresUpToDateHead('o', 'r', 'main', throwing, true),
    true,
  );
});

// #3497 review: the trust opt-in comes from the base ref, never from the PR
// working tree, and any read failure keeps it unset (fail closed).
test('readTrustEmptyProtectionReads: reads the opt-in from the base ref', () => {
  const refs: string[] = [];
  const encoded =
    (json: string) =>
    (_owner: string, _repo: string, ref: string): string => {
      refs.push(ref);
      return Buffer.from(json).toString('base64');
    };
  const noProbe = () => {};
  const noUserGlobal = { userGlobalFallback: false };
  assert.equal(
    readTrustEmptyProtectionReads(
      'o',
      'r',
      'release/1',
      encoded('{"ciGate":{"trustEmptyProtectionReads":true}}'),
      noProbe,
      noUserGlobal,
    ),
    true,
  );
  assert.deepEqual(refs, ['release/1']);
  assert.equal(
    readTrustEmptyProtectionReads(
      'o',
      'r',
      'main',
      encoded('{"ciGate":{}}'),
      noProbe,
      noUserGlobal,
    ),
    false,
  );
  assert.equal(
    readTrustEmptyProtectionReads(
      'o',
      'r',
      'main',
      encoded('not json'),
      noProbe,
      noUserGlobal,
    ),
    false,
  );
  assert.equal(
    readTrustEmptyProtectionReads(
      'o',
      'r',
      'main',
      () => {
        throw new Error('gh: Forbidden (HTTP 403)');
      },
      noProbe,
      noUserGlobal,
    ),
    false,
  );
  assert.equal(
    readTrustEmptyProtectionReads(
      'o',
      'r',
      'main',
      () => {
        throw new Error('gh: Not Found (HTTP 404)');
      },
      noProbe,
      noUserGlobal,
    ),
    false,
  );
});
