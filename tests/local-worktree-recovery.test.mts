import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countTaggedStashEntries,
  detectInProgressOperation,
  evaluatePrunableShortcut,
  extractDirtyPaths,
  extractIgnoredPaths,
  extractRecoveredClaim,
  hasWorkingTreeChanges,
  isAcceptedBlockReason,
  isSafeRelativePath,
  type LocalGitCommandResult,
  type LocalWorktreeRecoveryDeps,
  runLocalWorktreeRecovery,
  submoduleStatusEntries,
} from '../src/scripts/local-worktree-recovery.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

test('isAcceptedBlockReason accepts only the two §LWR step 1 prefixes', () => {
  assert.equal(
    isAcceptedBlockReason('stale-claim-local-worktree-occupied'),
    true,
  );
  assert.equal(
    isAcceptedBlockReason('released-claim-local-worktree-unreadable'),
    true,
  );
  assert.equal(isAcceptedBlockReason('active-claim-non-stale'), false);
  assert.equal(isAcceptedBlockReason('legacy-absent'), false);
});

test('extractRecoveredClaim prefers active_claim, falls back to evidence.released_claim', () => {
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'stale-claim-local-worktree-occupied',
      active_claim: { claim_id: 'claim-a', branch: 'issue/1-task' },
    }),
    { claimId: 'claim-a', branch: 'issue/1-task' },
  );
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'released-claim-local-worktree-occupied',
      active_claim: null,
      evidence: {
        released_claim: { claim_id: null, branch: 'issue/2-task' },
      },
    }),
    { claimId: null, branch: 'issue/2-task' },
  );
  assert.deepEqual(
    extractRecoveredClaim({
      state: 'local_worktree_occupied',
      reason: 'stale-claim-local-worktree-occupied',
      active_claim: null,
    }),
    { claimId: null, branch: null },
  );
});

test('hasWorkingTreeChanges ignores only `!!`-prefixed (ignored) lines', () => {
  assert.equal(hasWorkingTreeChanges(''), false);
  assert.equal(hasWorkingTreeChanges('!! node_modules/\n'), false);
  assert.equal(hasWorkingTreeChanges(' M tracked.txt\n'), true);
  assert.equal(hasWorkingTreeChanges('?? untracked.txt\n'), true);
});

test('extractIgnoredPaths reads only `!! `-prefixed lines', () => {
  assert.deepEqual(
    extractIgnoredPaths(
      ' M tracked.txt\n!! .env\n?? untracked.txt\n!! dist/\n',
    ),
    ['.env', 'dist/'],
  );
  assert.deepEqual(extractIgnoredPaths(''), []);
});

test('countTaggedStashEntries counts only entries whose subject contains the tag', () => {
  const stashList = [
    'stash@{0}: On issue/1-task: idd-lwr claim-x',
    'stash@{1}: On main: unrelated',
    'stash@{2}: On issue/1-task: idd-lwr claim-x',
  ].join('\n');
  assert.equal(countTaggedStashEntries(stashList, 'idd-lwr claim-x'), 2);
  assert.equal(countTaggedStashEntries('', 'idd-lwr claim-x'), 0);
});

test('evaluatePrunableShortcut requires prunable + absent + unlocked + matching branch', () => {
  const pathExists = (p: string) => p === '/present';
  const base = {
    path: '/gone',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  assert.equal(
    evaluatePrunableShortcut([base], '/gone', 'issue/1-task', pathExists)
      .eligible,
    true,
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, locked: true }],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'a locked prunable-absent record must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, path: '/present' }],
      '/present',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'present-on-disk must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [{ ...base, branchRef: 'refs/heads/other-branch' }],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
    'an unrelated matching branch must never be shortcut',
  );
  assert.equal(
    evaluatePrunableShortcut(
      [base],
      '/nonexistent-record',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
  );
});

test('evaluatePrunableShortcut fails closed on a detached record, even prunable+absent+unlocked (C1 finding)', () => {
  // inspectLocalWorktreeBranch (local-worktree-occupancy.mts) can never
  // resolve a detached record's branch once its path is already absent --
  // its own resolveDetachedBranch sequencer lookup needs to read files at
  // that path. It always treats this shape as blocking/unreadable, so the
  // shortcut must never authorize a force-remove here either, regardless of
  // whether the branch happens to be unresolvable rather than genuinely
  // unrelated.
  const pathExists = () => false;
  const detachedRecord = {
    path: '/gone',
    branchRef: null,
    detached: true,
    bare: false,
    locked: false,
    prunable: true,
  };
  assert.equal(
    evaluatePrunableShortcut(
      [detachedRecord],
      '/gone',
      'issue/1-task',
      pathExists,
    ).eligible,
    false,
  );
});

test('detectInProgressOperation reads orig-head for an in-progress rebase, not HEAD', () => {
  const runGit = (argv: string[]): LocalGitCommandResult => {
    if (argv[0] === 'rev-parse' && argv.includes('MERGE_HEAD')) {
      return { ok: false, status: 1, stdout: '', stderr: '' };
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
      if (argv.includes('rebase-merge')) {
        return {
          ok: true,
          status: 0,
          stdout: '/repo/.git/rebase-merge\n',
          stderr: '',
        };
      }
      return { ok: true, status: 0, stdout: 'rebase-apply\n', stderr: '' };
    }
    return { ok: true, status: 0, stdout: 'replay-tip-sha\n', stderr: '' };
  };
  const pathExists = (p: string) => p === '/repo/.git/rebase-merge';
  const readFile = (p: string) =>
    p === '/repo/.git/rebase-merge/orig-head' ? 'orig-head-sha\n' : null;
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    pathExists,
    readFile,
  );
  assert.deepEqual(result, { kind: 'rebase', tipSha: 'orig-head-sha' });
});

test('detectInProgressOperation reports null when nothing is in progress', () => {
  const runGit = (): LocalGitCommandResult => ({
    ok: false,
    status: 1,
    stdout: '',
    stderr: '',
  });
  const result = detectInProgressOperation(
    '/repo',
    runGit,
    () => false,
    () => null,
  );
  assert.equal(result, null);
});

test('submoduleStatusEntries parses a path containing spaces (Copilot review finding)', () => {
  const raw = [
    ' abc123def456abc123def456abc123def456abcd libs/my module (heads/main)',
    '-0000000000000000000000000000000000000000 uninit/sub with space',
    '+1111111111111111111111111111111111111111 dirty/no-space-path (heads/x)',
  ].join('\n');
  assert.deepEqual(submoduleStatusEntries(raw), [
    { status: ' ', path: 'libs/my module' },
    { status: '-', path: 'uninit/sub with space' },
    { status: '+', path: 'dirty/no-space-path' },
  ]);
});

test('extractDirtyPaths reads tracked/untracked paths, follows a rename arrow, and skips ignored lines', () => {
  const status = [
    ' M tracked.txt',
    '?? untracked.txt',
    'R  old.txt -> new.txt',
    '!! ignored.txt',
  ].join('\n');
  assert.deepEqual(extractDirtyPaths(status), [
    'tracked.txt',
    'untracked.txt',
    'new.txt',
  ]);
});

test('isSafeRelativePath rejects absolute paths and any `..` segment', () => {
  assert.equal(isSafeRelativePath('a/b.txt'), true);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('../escape.txt'), false);
  assert.equal(isSafeRelativePath('a/../../escape.txt'), false);
  assert.equal(isSafeRelativePath(''), false);
});

// ---------------------------------------------------------------------------
// Orchestration unit tests (fully injected deps -- no real git, no gh)
// ---------------------------------------------------------------------------

function baseArgs(
  overrides: Partial<Parameters<typeof runLocalWorktreeRecovery>[0]> = {},
) {
  return {
    issue: 1,
    worktree: '/repo/linked',
    operatorConfirmedNoLiveSession: false,
    apply: false,
    agentId: 'test-agent',
    owner: '',
    repo: '',
    policy: '',
    now: '',
    preserveDir: '',
    help: false,
    ...overrides,
  };
}

function fakeDeps(
  overrides: Partial<LocalWorktreeRecoveryDeps> = {},
): LocalWorktreeRecoveryDeps {
  const okRouting = {
    state: 'local_worktree_occupied',
    reason: 'stale-claim-local-worktree-occupied',
    active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
    evidence: {
      local_worktree: {
        status: 'occupied',
        paths: ['/repo/linked'],
        reason: null,
      },
    },
  };
  return {
    cwd: () => '/repo/primary',
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    confirmBlock: () => ({ ok: true, routing: okRouting, error: null }),
    checkLock: () => ({
      path: '/repo/linked/.git/idd-claim.lock',
      present: false,
    }),
    runGit: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
    pathExists: () => true,
    realpathOrNull: (p: string) => p,
    acquireCloneLock: () => ({ path: '/repo/.idd-clone.lock', token: 'tok' }),
    releaseCloneLock: () => {},
    resolveDevelopmentBranch: () => 'main',
    copyPath: () => {},
    ensurePreserveDir: () => '/tmp/preserve',
    now: () => '2026-09-25T00:00:00Z',
    ...overrides,
  };
}

test('never mutates without --operator-confirmed-no-live-session, regardless of --apply', () => {
  const deps = fakeDeps();
  let gitCalls = 0;
  deps.runGit = (argv) => {
    if (argv[0] === 'worktree' && argv[1] === 'remove') gitCalls += 1;
    if (argv[0] === 'stash' && argv[1] === 'push') gitCalls += 1;
    if (argv[0] === 'update-ref') gitCalls += 1;
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: false }),
    deps,
  );
  assert.equal(verdict.mutated, false);
  assert.equal(gitCalls, 0);
  assert.match(verdict.result, /operator-confirmed-no-live-session/);
});

test('default (no --apply) never mutates, and reports the full plan', () => {
  const deps = fakeDeps();
  let mutatingCalls = 0;
  deps.runGit = (argv) => {
    if (
      (argv[0] === 'worktree' && argv[1] === 'remove') ||
      (argv[0] === 'stash' && argv[1] === 'push') ||
      argv[0] === 'update-ref'
    ) {
      mutatingCalls += 1;
    }
    if (argv[0] === 'status') {
      return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.mutated, false);
  assert.equal(mutatingCalls, 0);
  assert.equal(verdict.plan.stashes[0]?.hasChanges, true);
  assert.equal(verdict.plan.stashes[0]?.stashed, false);
  assert.ok(verdict.plan.removal?.wouldRun);
  assert.equal(verdict.plan.removal?.ran, false);
});

test('step 4 acquires the clone-scoped lock, re-checks, then removes, releasing even on failure', () => {
  const callOrder: string[] = [];
  const deps = fakeDeps({
    acquireCloneLock: () => {
      callOrder.push('acquire');
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    releaseCloneLock: () => {
      callOrder.push('release');
    },
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        callOrder.push(call === 1 ? 'confirm-step1' : 'confirm-recheck');
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: ['/repo/linked'],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        callOrder.push('remove');
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mutated, true);
  assert.deepEqual(callOrder, [
    'confirm-step1',
    'acquire',
    'confirm-recheck',
    'remove',
    'release',
  ]);
});

test('step 4 still releases the clone lock when removal fails', () => {
  const callOrder: string[] = [];
  const deps = fakeDeps({
    acquireCloneLock: () => {
      callOrder.push('acquire');
      return { path: '/repo/.idd-clone.lock', token: 'tok' };
    },
    releaseCloneLock: () => {
      callOrder.push('release');
    },
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        callOrder.push('remove-failed');
        return { ok: false, status: 1, stdout: '', stderr: 'boom' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.mutated, false);
  assert.deepEqual(callOrder, ['acquire', 'remove-failed', 'release']);
});

test('regression: a successful step-3 stash before a failed step-4 removal must not report success (CodeRabbit finding)', () => {
  // Reproduces the exact shape that made `verdict.mutated` alone unsafe for
  // the CLI's exit-code decision: step 3 stashes real changes (so `mutated`
  // becomes true) BEFORE step 4's `git worktree remove` fails. The caller
  // (`runCli`) must key off `verdict.plan.removal.ran`, not `mutated` --
  // this test pins the verdict shape that fix depends on.
  let stashListCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        // First call is the pre-push baseline (empty); every call after the
        // stash push itself reports the tagged entry landed.
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 1
              ? ''
              : 'stash@{0}: On issue/1-task: idd-lwr claim-x',
          stderr: '',
        };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        return { ok: false, status: 1, stdout: '', stderr: 'boom' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.stashed, true);
  assert.equal(verdict.mutated, true, 'step 3 did mutate (stashed changes)');
  assert.equal(
    verdict.plan.removal?.ran,
    false,
    'step 4 never actually removed the worktree',
  );
  // The exact formula runCli() uses under --apply: success iff removal ran.
  const success = verdict.plan.removal?.ran ?? false;
  assert.equal(success, false);
});

test('step 4 stops removal when the worktree-local lock no longer matches the recovered claim-id at recheck time', () => {
  // Step 1's own checkLock call must still see a MATCHING lock (so step 1
  // itself passes) -- only the step-4 recheck (the second call) sees a
  // different claim-id, simulating a takeover that happened in the window
  // between step 1 and step 4 acquiring the clone-scoped lock.
  let checkLockCalls = 0;
  const deps = fakeDeps({
    checkLock: () => {
      checkLockCalls += 1;
      if (checkLockCalls === 1) {
        return {
          path: '/repo/linked/.git/idd-claim.lock',
          present: true,
          holder: {
            agentId: 'agent-x',
            claimId: 'claim-x',
            acquiredAt: '2026-09-24T00:00:00Z',
          },
        };
      }
      return {
        path: '/repo/linked/.git/idd-claim.lock',
        present: true,
        holder: {
          agentId: 'someone-else',
          claimId: 'a-different-claim-id',
          acquiredAt: '2026-09-25T00:00:00Z',
        },
      };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer matches the recovered claim-id/);
});

test('step 4 proceeds when the worktree-local lock is absent at recheck time (legacy release)', () => {
  const deps = fakeDeps({ checkLock: () => ({ path: '/x', present: false }) });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, true);
});

test('step 1 always calls confirmBlock, even for a prunable-and-absent record (never skips the network check)', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/linked',
        branchRef: 'refs/heads/issue/1-task',
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
      },
    ],
    pathExists: (p) => p !== '/repo/linked',
    confirmBlock: () => {
      confirmCalls += 1;
      return {
        ok: true,
        routing: {
          state: 'local_worktree_occupied',
          reason: 'stale-claim-local-worktree-occupied',
          active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
          evidence: {
            local_worktree: {
              status: 'unreadable',
              paths: ['/repo/linked'],
              reason: null,
            },
          },
        },
        error: null,
      };
    },
  });
  const verdict = runLocalWorktreeRecovery(baseArgs({ apply: false }), deps);
  assert.equal(confirmCalls, 1);
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(verdict.plan.prunableShortcut, true);
});

test('step 4 re-verifies the prunable shortcut fresh under the clone lock, not just step 1s stale read (CodeRabbit finding)', () => {
  // The window between step 1's read and the clone-scoped lock acquisition
  // is exactly what the lock exists to close -- the shortcut path must be
  // re-checked fresh too, not exempted from the re-check the ordinary path
  // gets.
  let listCalls = 0;
  const prunableRecord = {
    path: '/repo/linked',
    branchRef: 'refs/heads/issue/1-task',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const primaryRecord = {
    path: '/repo/primary',
    branchRef: 'refs/heads/main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  let removeCalled = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => {
      listCalls += 1;
      // First call (step 1) sees the prunable-and-absent record; the
      // second call (step 4's fresh re-check, while the clone lock is
      // held) finds it now LOCKED -- simulating another session having
      // touched it in the window between step 1 and the lock acquisition.
      return listCalls === 1
        ? [primaryRecord, prunableRecord]
        : [primaryRecord, { ...prunableRecord, locked: true }];
    },
    pathExists: (p) => p !== '/repo/linked',
    runGit: (argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-prunable');
  assert.equal(removeCalled, false, 'must never remove on a stale shortcut');
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer matches at recheck time/);
});

test('dry-run never creates the preserve directory for an uninitialized submodule', () => {
  let ensureCalls = 0;
  const deps = fakeDeps({
    ensurePreserveDir: () => {
      ensureCalls += 1;
      return '/tmp/preserve';
    },
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return { ok: true, status: 0, stdout: '-abc123 sub\n', stderr: '' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: false, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(ensureCalls, 0, 'dry-run must have zero side effects');
  assert.equal(verdict.plan.uninitializedSubmodules[0]?.copiedTo, null);
});

test('refuses the cwd-inside-target invariant before step 1 ever runs', () => {
  let confirmCalls = 0;
  const deps = fakeDeps({
    cwd: () => '/repo/linked/nested',
    confirmBlock: () => {
      confirmCalls += 1;
      return { ok: true, routing: null, error: null };
    },
  });
  const verdict = runLocalWorktreeRecovery(baseArgs({ apply: false }), deps);
  assert.equal(verdict.step1.outcome, 'cwd-inside-target');
  assert.equal(confirmCalls, 0);
});

test('refuses --preserve-dir inside the target worktree before any mutation (Copilot review finding)', () => {
  const deps = fakeDeps({
    realpathOrNull: (p) => p,
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      preserveDir: '/repo/linked/backup',
    }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'preserve-dir-inside-target');
  assert.equal(verdict.mutated, false);
});

test('refuses a fresh routing state of `-local-worktree-unreadable` outside the prunable shortcut (Copilot review finding)', () => {
  const deps = fakeDeps({
    confirmBlock: () => ({
      ok: true,
      routing: {
        state: 'local_worktree_occupied',
        reason: 'stale-claim-local-worktree-unreadable',
        active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
        evidence: {
          local_worktree: {
            status: 'unreadable',
            paths: ['/repo/linked'],
            reason: 'some read failure',
          },
        },
      },
      error: null,
    }),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.step1.outcome, 'blocked-unreadable');
  assert.equal(verdict.mutated, false);
});

test('a failed status probe blocks removal even with no other changes detected (Codex/Copilot review finding)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: false, status: 128, stdout: '', stderr: 'boom' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.statusReadFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('a failed `git submodule status` list blocks removal instead of silently reading as no submodules (advisor-caught gap)', () => {
  let removeCalled = false;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'submodule' && argv[1] === 'status') {
        return { ok: false, status: 128, stdout: '', stderr: 'boom' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        removeCalled = true;
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.submoduleListFailed, true);
  assert.equal(removeCalled, false);
  assert.equal(verdict.mutated, false);
  assert.match(verdict.result, /could not be fully verified/);
});

test('step 4 stops removal when the fresh claim/branch identity no longer matches step 1 (Copilot review finding)', () => {
  const deps = fakeDeps({
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            // First call (step 1) recovers claim-x; the recheck (step 4)
            // now reports a DIFFERENT claim occupying the same path --
            // simulating the issue moving to another stale/legacy claim
            // while this session waited for the clone lock.
            active_claim: {
              claim_id: call === 1 ? 'claim-x' : 'claim-y',
              branch: 'issue/1-task',
            },
            evidence: {
              local_worktree: {
                status: 'occupied',
                paths: ['/repo/linked'],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /claim being recovered changed since step 1/);
});

test('step 4 stops removal when a preservation artifact no longer verifies fresh under the clone lock (Copilot review finding)', () => {
  // Call order for `git stash list` against the single stashed scope:
  // 1st = baseline (pre-push, empty); 2nd = post-push verify (one tagged
  // entry -- so the pre-lock `preservationVerified` check passes); 3rd =
  // the FRESH re-check inside the clone lock, which finds it gone again --
  // simulating a concurrent pop/drop in the lock-wait window.
  let stashListCalls = 0;
  const deps = fakeDeps({
    runGit: (argv) => {
      if (argv[0] === 'status') {
        return { ok: true, status: 0, stdout: ' M tracked.txt\n', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'push') {
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stash' && argv[1] === 'list') {
        stashListCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout:
            stashListCalls === 2
              ? 'stash@{0}: On issue/1-task: idd-lwr claim-x'
              : '',
          stderr: '',
        };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({ apply: true, operatorConfirmedNoLiveSession: true }),
    deps,
  );
  assert.equal(verdict.plan.stashes[0]?.stashed, true);
  assert.equal(verdict.plan.removal?.ran, false);
  assert.match(verdict.result, /no longer verifies fresh under the clone lock/);
});

test('primary-worktree release only deletes a lock the fresh recheck positively observed', () => {
  let unlinkAttempted = false;
  const deps = fakeDeps({
    listWorktreeRecords: () => [
      {
        path: '/repo/primary',
        branchRef: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    cwd: () => '/repo/primary',
    checkLock: () => ({
      path: '/repo/primary/.git/idd-claim.lock',
      present: false,
    }),
    confirmBlock: (() => {
      let call = 0;
      return () => {
        call += 1;
        return {
          ok: true,
          routing: {
            state: 'local_worktree_occupied',
            reason: 'stale-claim-local-worktree-occupied',
            active_claim: { claim_id: 'claim-x', branch: 'issue/1-task' },
            evidence: {
              local_worktree: {
                status: call <= 2 ? 'occupied' : 'absent',
                paths: call <= 2 ? ['/repo/primary'] : [],
                reason: null,
              },
            },
          },
          error: null,
        };
      };
    })(),
    runGit: (argv) => {
      if (argv[0] === 'rev-parse' && argv.includes('--absolute-git-dir')) {
        unlinkAttempted = true;
        return {
          ok: true,
          status: 0,
          stdout: '/repo/primary/.git\n',
          stderr: '',
        };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = runLocalWorktreeRecovery(
    baseArgs({
      apply: true,
      operatorConfirmedNoLiveSession: true,
      worktree: '/repo/primary',
    }),
    deps,
  );
  assert.equal(verdict.primaryOrLinked, 'primary');
  assert.equal(verdict.plan.removal?.ran, true);
  assert.equal(
    unlinkAttempted,
    false,
    'must never attempt to resolve/delete a lock file the recheck found absent',
  );
});

// ---------------------------------------------------------------------------
// Real sandboxed git end-to-end tests -- spawns the compiled CLI so
// argument threading, the real `resume-claim-routing.mjs` composition, and
// real git stash/ref/removal semantics are all exercised together, mirroring
// tests/resume-claim-routing.test.mts's own `--worktree end-to-end` sandbox
// technique (a disposable standalone sandbox repo, `gh` stubbed via
// stubExecutable, spawning the real compiled CLI).
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'idd-test',
  GIT_AUTHOR_EMAIL: 'idd-test@example.com',
  GIT_COMMITTER_NAME: 'idd-test',
  GIT_COMMITTER_EMAIL: 'idd-test@example.com',
};

/** Stub `gh` so `resume-claim-routing.mjs` (spawned by the helper under
 * test) reports a stale `claimed-by claim-x` on `branch` for `issueNumber`,
 * without ever touching the network. Mirrors
 * `tests/resume-claim-routing.test.mts`'s own `trustedLadderFixture`. */
function stubGhForStaleClaim(options: {
  issueNumber: number;
  branch: string;
  claimId: string;
  createdAt: string;
}): () => void {
  const commentJson = JSON.stringify({
    id: 1,
    node_id: 'IC_1',
    body: `<!-- claimed-by: agent-x ${options.claimId} supersedes: none ${options.createdAt} branch: ${options.branch} -->`,
    created_at: options.createdAt,
    updated_at: options.createdAt,
    user: { login: 'maintainer' },
  });
  return stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
const commentJson = ${JSON.stringify(commentJson)};
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('viewer-login\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => /nodes\\(ids/.test(a))) {
  const ids = args.filter((a) => /^ids\\[\\]=/.test(a)).map((a) => a.slice('ids[]='.length));
  process.stdout.write(JSON.stringify({ data: { nodes: ids.map((id) => ({ id, lastEditedAt: null })) } }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => a.includes('/issues/${options.issueNumber}/comments'))) {
  process.stdout.write(commentJson + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => a.endsWith('/issues/${options.issueNumber}'))) {
  process.stdout.write(JSON.stringify({ number: ${options.issueNumber}, title: 'lwr sandbox', state: 'open', html_url: 'https://github.com/o/r/issues/${options.issueNumber}' }));
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`,
  );
}

interface Sandbox {
  root: string;
  primary: string;
  remote: string;
  linked: string;
  policyPath: string;
  cleanup: () => void;
}

/** Build a disposable sandbox: a bare `remote`, a `primary` clone on `main`,
 * and a `linked` worktree checked out on `branch` -- with an upstream set
 * for both, so "no upstream" never falsely marks every commit unpushed
 * (a real remote is required for the clean-worktree scenario to correctly
 * report zero unpushed commits). */
function buildSandbox(branch: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'idd-lwr-sandbox-'));
  const primary = join(root, 'primary');
  const remote = join(root, 'remote.git');
  const linked = join(root, 'linked');
  mkdirSync(primary, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'root',
    ],
    { cwd: primary, stdio: 'ignore', env: GIT_ENV },
  );
  execFileSync('git', ['remote', 'add', 'origin', remote], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], {
    cwd: primary,
    stdio: 'ignore',
    env: GIT_ENV,
  });
  execFileSync('git', ['worktree', 'add', '-b', branch, linked], {
    cwd: primary,
    stdio: 'ignore',
  });
  execFileSync('git', ['push', '--quiet', '-u', 'origin', branch], {
    cwd: linked,
    stdio: 'ignore',
    env: GIT_ENV,
  });
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({ trustedMarkerActors: ['maintainer'] }),
  );
  return {
    root,
    primary,
    remote,
    linked,
    policyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(
  sandbox: Sandbox,
  issueNumber: number,
  extraArgs: string[],
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/local-worktree-recovery.mjs'),
      '--issue',
      String(issueNumber),
      '--worktree',
      sandbox.linked,
      '--owner',
      'o',
      '--repo',
      'r',
      '--policy',
      sandbox.policyPath,
      '--now',
      '2026-09-25T01:00:00Z',
      ...extraArgs,
    ],
    { cwd: sandbox.primary, encoding: 'utf8' },
  );
}

test('sandbox: clean worktree, no changes -- no stash, no backup ref, removal proceeds under --apply', () => {
  const sandbox = buildSandbox('issue/101-task');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 101,
    branch: 'issue/101-task',
    claimId: 'claim-101',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 101, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.step1.outcome, 'blocked-stale');
    assert.equal(output.plan.stashes[0].hasChanges, false);
    assert.equal(output.plan.stashes[0].stashed, false);
    assert.equal(output.plan.backupRefs[0].hasUnpushed, false);
    assert.equal(output.plan.backupRefs[0].written, false);
    assert.equal(output.plan.removal.ran, true);
    assert.equal(output.mutated, true);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(!worktreeList.includes(sandbox.linked));
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: uncommitted tracked + untracked changes -- stashed with the idd-lwr <claim-id> tag', () => {
  const sandbox = buildSandbox('issue/102-task');
  writeFileSync(join(sandbox.linked, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: sandbox.linked });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'tracked baseline',
    ],
    { cwd: sandbox.linked, env: GIT_ENV },
  );
  execFileSync('git', ['push', '--quiet'], {
    cwd: sandbox.linked,
    env: GIT_ENV,
  });
  writeFileSync(join(sandbox.linked, 'tracked.txt'), 'modified\n');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 102,
    branch: 'issue/102-task',
    claimId: 'claim-102',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 102, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.plan.stashes[0].hasChanges, true);
    assert.equal(output.plan.stashes[0].stashed, true);
    assert.equal(output.plan.stashes[0].tag, 'idd-lwr claim-102');
    assert.equal(
      output.plan.stashes[0].verifiedCount,
      output.plan.stashes[0].baselineCount + 1,
    );
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: sandbox.primary,
      encoding: 'utf8',
    });
    assert.match(stashList, /idd-lwr claim-102/);
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: unpushed commits -- refs/idd-lwr/<branch> resolves to the recorded tip', () => {
  const sandbox = buildSandbox('issue/103-task');
  writeFileSync(join(sandbox.linked, 'unpushed.txt'), 'x\n');
  execFileSync('git', ['add', 'unpushed.txt'], { cwd: sandbox.linked });
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'unpushed change',
    ],
    { cwd: sandbox.linked, env: GIT_ENV },
  );
  const tipSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sandbox.linked,
    encoding: 'utf8',
  }).trim();
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 103,
    branch: 'issue/103-task',
    claimId: 'claim-103',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 103, [
      '--apply',
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.plan.backupRefs[0].hasUnpushed, true);
    assert.equal(output.plan.backupRefs[0].tipSha, tipSha);
    assert.equal(output.plan.backupRefs[0].written, true);
    assert.equal(output.plan.backupRefs[0].verifiedOid, tipSha);
    const resolved = execFileSync(
      'git',
      ['rev-parse', 'refs/idd-lwr/issue/103-task'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    ).trim();
    assert.equal(resolved, tipSha);
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: refusal without --operator-confirmed-no-live-session never mutates', () => {
  const sandbox = buildSandbox('issue/104-task');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 104,
    branch: 'issue/104-task',
    claimId: 'claim-104',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 104, ['--apply']);
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mutated, false);
    assert.match(output.result, /operator-confirmed-no-live-session/);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(worktreeList.includes(sandbox.linked));
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: sandbox.linked,
      encoding: 'utf8',
    });
    assert.equal(stashList.trim(), '');
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});

test('sandbox: default (no --apply) never mutates even with the operator flag', () => {
  const sandbox = buildSandbox('issue/105-task');
  writeFileSync(join(sandbox.linked, 'untracked.txt'), 'new\n');
  const restoreGh = stubGhForStaleClaim({
    issueNumber: 105,
    branch: 'issue/105-task',
    claimId: 'claim-105',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runCli(sandbox, 105, [
      '--operator-confirmed-no-live-session',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'dry-run');
    assert.equal(output.mutated, false);
    assert.equal(output.plan.stashes[0].hasChanges, true);
    assert.equal(output.plan.stashes[0].stashed, false);
    const worktreeList = execFileSync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: sandbox.primary, encoding: 'utf8' },
    );
    assert.ok(worktreeList.includes(sandbox.linked));
  } finally {
    restoreGh();
    sandbox.cleanup();
  }
});
