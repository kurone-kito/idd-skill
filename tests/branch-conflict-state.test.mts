import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classifyBranchConflictState,
  parseArgs,
  parseConflictFiles,
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
  git(['commit', '-q', '-m', 'older']);
  const older = git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(['add', 'b.txt']);
  git(['commit', '-q', '-m', 'newer']);
  const newer = git(['rev-parse', 'HEAD']);
  sharedTwoCommitRepo = { dir, older, newer };
  return sharedTwoCommitRepo;
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
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    // Deliberately no _skipGitProbe: the fixture's placeholder SHAs are not
    // real git objects, so the initial merge-base lookup fails.
    // baseRefName is overridden to '' so the fallback-fetch guard
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
