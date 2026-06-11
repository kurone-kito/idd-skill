import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  classifyBranchConflictState,
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

test('classifyBranchConflictState: clean PR returns clean state', async () => {
  const fixture = loadFixture('clean');
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
});

test('classifyBranchConflictState: UNKNOWN returns unknown state', async () => {
  const fixture = loadFixture('unknown');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
  });
  assert.equal(result.branchState, 'unknown');
  assert.equal(result.syncRecommendation, 'hold-unknown');
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
  assert.ok(result.diagnostics.notes.length > 0);
});

test('classifyBranchConflictState: result always reports readOnly and worktreeUnchanged', async () => {
  const fixture = loadFixture('clean');
  const result = await classifyBranchConflictState(fixture.prData.number, {
    owner: 'test-owner',
    repo: 'test-repo',
    _testPrData: fixture.prData,
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
