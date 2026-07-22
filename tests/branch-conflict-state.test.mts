import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classifyBranchConflictState,
  MERGE_BASE_FETCH_STEPS,
  parseArgs,
  parseConflictFiles,
  parseGitFetchOrigin,
  resolveFetchOrigin,
  resolveMergeBaseWithRetry,
} from '../src/scripts/branch-conflict-state.mts';

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
  const dir = mkdtempSync(join(tmpdir(), 'idd-branch-conflict-state-'));
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
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
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
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
  const dir = mkdtempSync(join(tmpdir(), 'idd-branch-conflict-upstream-'));
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
  const featureWorktreeDir = mkdtempSync(
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
  const shallowDir = mkdtempSync(
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

test('classifyBranchConflictState: BEHIND without conflict recommends merge-main', async () => {
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
  assert.equal(result.syncRecommendation, 'merge-main');
  // BEHIND is definitional: base has already advanced past the merge-base,
  // so this is `true` even though the git probe itself was skipped.
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

test('classifyBranchConflictState: post-push merge recommendation for BEHIND is merge-main', async () => {
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
  assert.equal(result.syncRecommendation, 'merge-main');
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
  const configDir = mkdtempSync(
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

test('classifyBranchConflictState: published is true when head SHA is present', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
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
