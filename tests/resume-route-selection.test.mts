import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyBranchState,
  countLatestChangesRequestedByReviewer,
  recoverJsonFromGhFailure,
  selectResumeRoute,
} from '../src/scripts/resume-route-selection.mts';

test('routes D4 when no PR and required checks are not generated', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: false,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'D4');
});

test('routes stop when multiple matching open PRs are detected', () => {
  const result = selectResumeRoute({
    prAmbiguous: true,
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'multiple-open-prs-for-issue');
});

test('routes D1 when no PR and clean worktree has unpushed commits', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'D1');
});

test('routes D4 when no PR and worktree is dirty', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: true,
  });
  assert.equal(result.route, 'D4');
});

test('routes D4 when PR exists, CI is running, and no reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: false,
    reviewPending: false,
  });
  assert.equal(result.route, 'D4');
});

test('routes E15 when PR exists, CI is running, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E15');
});

test('routes E1 when PR exists, CI succeeded, and reviews are pending', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E1');
});

test('routes F2 when PR exists, CI succeeded, no pending reviews, and branch is clean', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'clean',
  });
  assert.equal(result.route, 'F2');
});

test('routes F1 when PR exists, CI succeeded, no pending reviews, and branch is behind without conflict', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'behind-no-conflict',
  });
  assert.equal(result.route, 'F1');
  assert.equal(result.reason, 'pr-ci-success-branch-behind-no-conflict');
});

test('routes Esync when PR exists, CI succeeded, no pending reviews, and branch has content conflict', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'content-conflict',
  });
  assert.equal(result.route, 'Esync');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branch state is dirty', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'dirty',
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branch state is unknown', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'unknown',
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
});

test('routes F1 when PR exists, CI succeeded, no pending reviews, and branch state is computing', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'computing',
  });
  assert.equal(result.route, 'F1');
  assert.equal(result.reason, 'pr-ci-success-branch-computing');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branchState is not provided (fail-closed to unknown)', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
  assert.equal(result.state.branchState, 'unknown');
});

test('routes stop when a non-string branchState is supplied (fail-closed to unknown)', () => {
  for (const branchState of [123, null, true, {}, ['clean']]) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: true,
      ciSuccess: true,
      reviewExists: false,
      reviewPending: false,
      branchState,
    });
    assert.equal(result.route, 'stop');
    assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
    assert.equal(result.state.branchState, 'unknown');
  }
});

test('routes stop when an unrecognized branchState string is supplied (fail-closed to unknown)', () => {
  for (const branchState of ['GARBAGE', 'CORRUPT', 'Clean', '']) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: true,
      ciSuccess: true,
      reviewExists: false,
      reviewPending: false,
      branchState,
    });
    assert.equal(result.route, 'stop');
    assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
    assert.equal(result.state.branchState, 'unknown');
  }
});

test('routes E15 when PR exists, CI fails, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciFailed: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E15');
});

test('routes E15 when PR exists, required checks are not generated, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: false,
    reviewExists: true,
  });
  assert.equal(result.route, 'E15');
});

test('classifyBranchState returns clean for CLEAN mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    'clean',
  );
});

test('classifyBranchState returns behind-no-conflict for BEHIND mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }),
    'behind-no-conflict',
  );
});

test('classifyBranchState returns content-conflict for CONFLICTING mergeable', () => {
  assert.equal(
    classifyBranchState({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    }),
    'content-conflict',
  );
});

test('classifyBranchState returns dirty for DIRTY mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }),
    'dirty',
  );
});

test('classifyBranchState returns clean for BLOCKED MERGEABLE (non-git-conflict block)', () => {
  assert.equal(
    classifyBranchState({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    }),
    'clean',
  );
});

test('classifyBranchState returns unknown for genuinely missing state', () => {
  // No payload, or a payload with no `mergeable` field at all (undefined):
  // genuinely missing/unparseable, so it stays terminal `unknown`.
  assert.equal(classifyBranchState(null), 'unknown');
  assert.equal(classifyBranchState({}), 'unknown');
  assert.equal(classifyBranchState({ mergeStateStatus: 'UNKNOWN' }), 'unknown');
});

test('classifyBranchState returns computing for transient UNKNOWN/null mergeable', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'UNKNOWN', mergeStateStatus: '' }),
    'computing',
  );
  assert.equal(
    classifyBranchState({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    'computing',
  );
  // An explicit `null` mergeable on a present payload is GitHub still
  // computing, not a missing payload, so it is transient `computing`.
  assert.equal(
    classifyBranchState({ mergeable: null, mergeStateStatus: 'UNKNOWN' }),
    'computing',
  );
});

test("counts CHANGES_REQUESTED using each reviewer's latest gating state", () => {
  const count = countLatestChangesRequestedByReviewer([
    {
      user: { login: 'alice' },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-05-12T10:00:00Z',
    },
    {
      user: { login: 'alice' },
      state: 'APPROVED',
      submitted_at: '2026-05-12T11:00:00Z',
    },
    {
      user: { login: 'bob' },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-05-12T09:00:00Z',
    },
  ]);
  assert.equal(count, 1);
});

test('recovers empty required-check set from gh pr checks failure', () => {
  const recovered = recoverJsonFromGhFailure(
    { stderr: "no required checks reported on the 'main' branch" },
    { allowNoRequiredChecks: true },
  );
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.value, []);
});
