import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateMergeGates,
  isEligibleForSoloCodeownerAdminFallback,
  isSafeSoloCodeownerAdminMergeState,
  type MergeExecuteDeps,
  resolveRemoteSoloCodeownerAdminFallbackMode,
  runMergeExecute,
} from '../src/scripts/idd-merge-execute.mts';
import { computePreMergeReadinessBlockers } from '../src/scripts/protocol-helpers.mts';

const HEAD = '1111111111111111111111111111111111111111';
const DRIFTED = '2222222222222222222222222222222222222222';

// A pre-merge-readiness report whose every F3 gate is satisfied. Each
// test mutates a shallow copy to flip exactly one gate.
function readyReport(): Record<string, unknown> {
  return {
    prHeadSha: HEAD,
    reviewCurrency: { comparisonRoute: 'proceed', comparisonReason: 'match' },
    threads: { actionableCount: 0 },
    advisoryWait: { f3Outcome: 'SATISFIED' },
    ci: {
      status: 'success',
      requiredChecksPassing: true,
      noRequiredChecksConfigured: false,
      presentRunConclusion: 'all-passing',
      discardedNonPassingRequiredChecks: [],
    },
    reviewerStates: {
      requiredApprovalsSatisfied: true,
      codeownerApprovalSatisfied: true,
      codeownerSelfApproval: { status: 'not_applicable' },
    },
    claim: { matchesExpectedClaim: true, reason: 'match' },
    dispositionEvidence: { route: 'proceed', blockingCount: 0 },
    branchCurrency: {
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      requiresUpToDateHead: false,
      requiresUpToDateHeadSource: 'none',
    },
  };
}

// Build injectable deps from a fixed report; record merge attempts so a
// test can assert merge did or did not happen.
function depsFor(
  report: Record<string, unknown>,
  overrides: Partial<MergeExecuteDeps> = {},
): {
  deps: MergeExecuteDeps;
  calls: {
    merged: string[];
    fetchRepoRefs: (string | null)[];
    mergeRepoRefs: (string | null)[];
    adminMerged: string[];
  };
} {
  const calls = {
    merged: [] as string[],
    fetchRepoRefs: [] as (string | null)[],
    mergeRepoRefs: [] as (string | null)[],
    adminMerged: [] as string[],
  };
  const deps: MergeExecuteDeps = {
    collect: () => report,
    fetchHeadSha: (_prNumber, repoRef) => {
      calls.fetchRepoRefs.push(repoRef);
      return String(report.prHeadSha ?? '');
    },
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    mergePr: (prNumber, headSha, repoRef) => {
      calls.merged.push(`${prNumber}:${headSha}`);
      calls.mergeRepoRefs.push(repoRef);
      return 'Merged PR.';
    },
    // #1521: default admin-fallback deps are never exercised unless a test
    // overrides `mergePr` to throw the base-branch-policy error AND opts
    // into a fallback-eligible report, so a plain success/failure test
    // never touches these.
    mergePrAdmin: (prNumber, headSha, repoRef) => {
      calls.adminMerged.push(`${prNumber}:${headSha}`);
      calls.mergeRepoRefs.push(repoRef);
      return 'Merged PR (admin).';
    },
    resolveSoloCodeownerAdminFallbackMode: () => 'auto-admin-retry',
    // #2453: safe no-op defaults so every pre-existing test (none of which
    // exercise the local-head-drift advisory) sees no local git state and
    // therefore no warning.
    getLocalHeadState: () => ({ branch: null, headSha: null }),
    fetchHeadRefName: () => '',
    ...overrides,
  };
  return { deps, calls };
}

/** A `gh`-shaped thrown error carrying the #1494 "base branch policy
 * prohibits the merge" text on stderr, matching how `execFileSync` reports
 * a non-zero `gh pr merge` exit under `{ encoding: 'utf8' }`. */
function baseBranchPolicyMergeError(): Error & { stderr: string } {
  return Object.assign(new Error('Command failed'), {
    stderr:
      'X Pull request kurone-kito/idd-skill#1487 is not mergeable: the base branch policy prohibits the merge.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.\n',
  });
}

/** A report whose `reviewerStates` proves the genuine solo-CODEOWNER
 * self-approval deadlock: `status: 'clear'` via the pull-request bypass
 * AND `prAuthorIsSoleEligibleCodeowner: true`. */
function soloCodeownerDeadlockReport(): Record<string, unknown> {
  const report = readyReport();
  report.reviewerStates = {
    requiredApprovalsSatisfied: true,
    codeownerApprovalSatisfied: false,
    codeownerSelfApproval: {
      status: 'clear',
      reason: 'pull-request-bypass-available',
      prAuthorIsSoleEligibleCodeowner: true,
    },
  };
  return report;
}

const BASE_ARGS = ['--pr', '994', '--claim-issue', '309', '--claim-id', 'c-1'];

test('evaluateMergeGates returns no blockers for a fully ready report', () => {
  assert.deepEqual(evaluateMergeGates(readyReport()), []);
});

test('a missing or invalid prHeadSha fails closed as a head-sha blocker', () => {
  for (const bad of ['', 'not-a-sha', 'ABCDEF', `${HEAD}extra`]) {
    const report = readyReport();
    report.prHeadSha = bad;
    const blockers = evaluateMergeGates(report);
    assert.ok(
      blockers.some((b) => b.gate === 'head-sha'),
      `expected a head-sha blocker for prHeadSha=${JSON.stringify(bad)}`,
    );
  }
});

test('mergeCommand is suppressed when the head-sha gate fires', () => {
  const report = readyReport();
  report.prHeadSha = 'not-a-sha';
  const { deps } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);
  assert.equal(verdict.ready, false);
  // No copy-pasteable command when the head cannot bind --match-head-commit.
  assert.equal(verdict.mergeCommand, '');
  assert.equal(exitCode, 1);
});

test('dry-run on a ready report reports ready with the bound merge command', () => {
  const { deps, calls } = depsFor(readyReport());
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);

  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.decisionAuthority, 'instructions');
  assert.equal(
    verdict.mergeCommand,
    `gh pr merge 994 --merge --match-head-commit ${HEAD}`,
  );
  // Dry-run NEVER merges.
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.equal(exitCode, 0);
});

test('a failing gate becomes a blocker and blocks readiness', () => {
  const report = readyReport();
  report.advisoryWait = { f3Outcome: 'WAIT' };
  const { deps } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);

  assert.equal(verdict.ready, false);
  assert.equal(verdict.blockers.length, 1);
  assert.equal(verdict.blockers[0]?.gate, 'advisory-wait');
  assert.match(verdict.blockers[0]?.detail ?? '', /WAIT/);
  assert.equal(exitCode, 1);
});

test('every F3 gate maps to its own blocker', () => {
  const cases: [string, (r: Record<string, unknown>) => void][] = [
    [
      'review-currency',
      (r) => {
        r.reviewCurrency = {
          comparisonRoute: 'return-to-e1',
          comparisonReason: 'newer-activity',
        };
      },
    ],
    ['unresolved-threads', (r) => (r.threads = { actionableCount: 2 })],
    ['advisory-wait', (r) => (r.advisoryWait = { f3Outcome: 'HOLD' })],
    [
      'ci',
      (r) =>
        (r.ci = {
          status: 'pending',
          requiredChecksPassing: false,
          noRequiredChecksConfigured: false,
          presentRunConclusion: 'pending',
        }),
    ],
    [
      'required-reviews',
      (r) =>
        (r.reviewerStates = {
          requiredApprovalsSatisfied: false,
          codeownerApprovalSatisfied: true,
          codeownerSelfApproval: { status: 'not_applicable' },
        }),
    ],
    [
      'claim-ownership',
      (r) =>
        (r.claim = {
          matchesExpectedClaim: false,
          reason: 'claim-id-mismatch',
        }),
    ],
    [
      'disposition-evidence',
      (r) =>
        (r.dispositionEvidence = {
          route: 'return-to-e1',
          blockingCount: 1,
        }),
    ],
    [
      'branch-currency',
      (r) =>
        (r.branchCurrency = {
          mergeStateStatus: 'BEHIND',
          mergeable: 'MERGEABLE',
          requiresUpToDateHead: true,
          requiresUpToDateHeadSource: 'ruleset',
        }),
    ],
    // #2274: `evaluateMergeGates` is `computePreMergeReadinessBlockers`
    // verbatim (see its one-line definition above), so the #2272
    // development-branch-target invariant already reaches F3 merge
    // execution without any dedicated wiring here -- this case is the
    // parity proof for that fact at this file's own entry point.
    [
      'development-branch-target',
      (r) =>
        (r.developmentBranchTarget = {
          status: 'configured',
          branch: 'develop',
          baseRefName: 'main',
        }),
    ],
  ];

  for (const [gate, mutate] of cases) {
    const report = readyReport();
    mutate(report);
    const blockers = evaluateMergeGates(report);
    assert.deepEqual(
      blockers.map((b) => b.gate),
      [gate],
      `expected sole blocker ${gate}`,
    );
  }
});

// #2274: a wrong-base PR must not merge even when the full CLI path's own
// live merge-state re-check (`fetchMergeState`) is otherwise clean --
// proves the gate holds `runMergeExecute` fail-closed all the way through
// the deps injection boundary, not just at `evaluateMergeGates` in
// isolation. Uses `--apply` (like the sibling "--apply on a blocked gate
// fails closed" test above) -- a plain dry-run never calls `mergePr`
// regardless of any blocker, so it would prove nothing about this gate
// specifically (review round 1).
test('--apply on a wrong-base PR fails closed without merging, even with an otherwise-clean live merge state', () => {
  const report = readyReport();
  report.developmentBranchTarget = {
    status: 'configured',
    branch: 'develop',
    baseRefName: 'main',
  };
  const { deps, calls } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.ready, false);
  assert.deepEqual(
    verdict.blockers.map((b) => b.gate),
    ['development-branch-target'],
  );
  assert.match(verdict.blockers[0]?.detail ?? '', /"main".*"develop"/);
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /not-ready/);
  assert.equal(exitCode, 1);
});

test('disposition-evidence blocks when route is proceed but blockingCount is non-zero', () => {
  const report = readyReport();
  report.dispositionEvidence = { route: 'proceed', blockingCount: 1 };
  const blockers = evaluateMergeGates(report);
  assert.deepEqual(
    blockers.map((b) => b.gate),
    ['disposition-evidence'],
  );
  assert.match(blockers[0]?.detail ?? '', /blockingCount=1/);

  const { deps } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);
  assert.equal(verdict.ready, false);
  assert.equal(exitCode, 1);
});

test('soleCauseAckOnlyPostDisposition does not add a disposition-evidence blocker (#2125)', () => {
  const report = readyReport();
  report.dispositionEvidence = {
    route: 'return-to-e1',
    blockingCount: 2,
    soleCauseAckOnlyPostDisposition: true,
  };
  assert.deepEqual(evaluateMergeGates(report), []);
  const { deps } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);
  assert.equal(verdict.ready, true);
  assert.equal(exitCode, 0);
});

test('ack-only-post-disposition review-currency does not add a review-currency blocker (#2125)', () => {
  const report = readyReport();
  report.reviewCurrency = {
    comparisonRoute: 'return-to-e1',
    comparisonReason: 'ack-only-post-disposition',
  };
  assert.deepEqual(evaluateMergeGates(report), []);
});

test('soleCauseAckOnly flag does not override garbled disposition route or count (#2125)', () => {
  const report = readyReport();
  report.dispositionEvidence = {
    route: '',
    blockingCount: 'nope',
    soleCauseAckOnlyPostDisposition: true,
  };
  const blockers = evaluateMergeGates(report);
  assert.deepEqual(
    blockers.map((b) => b.gate),
    ['disposition-evidence'],
  );
});

test('garbled review-currency route still blocks even with an ack-only reason (#2125)', () => {
  const report = readyReport();
  report.reviewCurrency = {
    comparisonRoute: '',
    comparisonReason: 'ack-only-post-disposition',
  };
  const blockers = evaluateMergeGates(report);
  assert.deepEqual(
    blockers.map((b) => b.gate),
    ['review-currency'],
  );
});

test('BLOCKED + discarded required-check siblings is a dedicated merge-gate (#2127)', () => {
  const report = readyReport();
  report.branchCurrency = {
    ...(report.branchCurrency as Record<string, unknown>),
    mergeStateStatus: 'BLOCKED',
  };
  report.ci = {
    ...(report.ci as Record<string, unknown>),
    discardedNonPassingRequiredChecks: [
      { name: 'idd-advisory-convergence', discardedState: 'CANCELLED' },
    ],
  };
  const blockers = evaluateMergeGates(report);
  assert.deepEqual(
    blockers.map((blocker) => blocker.gate),
    ['discarded-required-check-siblings'],
  );
  assert.match(blockers[0]?.detail ?? '', /BLOCKED/);
  const { deps, calls } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.equal(exitCode, 1);
});

test('CLEAN + discarded required-check siblings stays evidence-only (#2127)', () => {
  const report = readyReport();
  report.ci = {
    ...(report.ci as Record<string, unknown>),
    discardedNonPassingRequiredChecks: [
      { name: 'idd-advisory-convergence', discardedState: 'CANCELLED' },
    ],
  };
  assert.deepEqual(evaluateMergeGates(report), []);
});

test('BLOCKED with an empty or absent discarded-sibling list does not fire #2127', () => {
  const empty = readyReport();
  empty.branchCurrency = {
    ...(empty.branchCurrency as Record<string, unknown>),
    mergeStateStatus: 'BLOCKED',
  };
  assert.deepEqual(evaluateMergeGates(empty), []);

  const absent = readyReport();
  absent.branchCurrency = {
    ...(absent.branchCurrency as Record<string, unknown>),
    mergeStateStatus: 'BLOCKED',
  };
  const ci = { ...(absent.ci as Record<string, unknown>) };
  delete ci.discardedNonPassingRequiredChecks;
  absent.ci = ci;
  assert.deepEqual(evaluateMergeGates(absent), []);
});

test('ack-only override stays fail-closed when mixed with a non-ack disposition gap (#2125)', () => {
  const report = readyReport();
  report.reviewCurrency = {
    comparisonRoute: 'return-to-e1',
    comparisonReason: 'ack-only-post-disposition',
  };
  report.dispositionEvidence = {
    route: 'return-to-e1',
    blockingCount: 1,
    soleCauseAckOnlyPostDisposition: false,
  };
  const blockers = evaluateMergeGates(report);
  assert.deepEqual(
    blockers.map((b) => b.gate),
    ['disposition-evidence'],
  );
});

test('CI all-passing accepts the no-required-checks fallback', () => {
  const report = readyReport();
  report.ci = {
    status: 'unknown',
    requiredChecksPassing: false,
    noRequiredChecksConfigured: true,
    presentRunConclusion: 'all-passing',
  };
  assert.deepEqual(evaluateMergeGates(report), []);

  // ...but a vacuous "no checks at all" must NOT satisfy CI.
  report.ci = {
    status: 'unknown',
    requiredChecksPassing: false,
    noRequiredChecksConfigured: true,
    presentRunConclusion: 'none',
  };
  assert.deepEqual(
    evaluateMergeGates(report).map((b) => b.gate),
    ['ci'],
  );
});

test('required-reviews clears on a clear codeowner self-approval bypass', () => {
  const report = readyReport();
  report.reviewerStates = {
    requiredApprovalsSatisfied: true,
    codeownerApprovalSatisfied: false,
    codeownerSelfApproval: { status: 'clear' },
  };
  assert.deepEqual(evaluateMergeGates(report), []);
});

test('--apply merges a ready PR bound to the validated head', () => {
  const { deps, calls } = depsFor(readyReport());
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.ready, true);
  assert.equal(verdict.merged, true);
  assert.deepEqual(calls.merged, [`994:${HEAD}`]);
  assert.equal(exitCode, 0);
});

test('#2453 localHeadDrift stays null when the local branch matches the PR head branch and the local HEAD matches prHeadSha', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({
      branch: 'issue/994-fix-thing',
      headSha: HEAD,
    }),
    fetchHeadRefName: () => 'issue/994-fix-thing',
  });
  const { verdict } = runMergeExecute([...BASE_ARGS, '--apply'], deps);

  assert.equal(verdict.localHeadDrift, null);
  assert.equal(verdict.merged, true);
});

test('#2453 localHeadDrift warns when the local branch matches the PR head branch but local HEAD differs from prHeadSha', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({
      branch: 'issue/994-fix-thing',
      headSha: DRIFTED,
    }),
    fetchHeadRefName: () => 'issue/994-fix-thing',
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.deepEqual(verdict.localHeadDrift, {
    localHeadSha: DRIFTED,
    remoteHeadSha: HEAD,
  });
  // Advisory only: never blocks the merge.
  assert.equal(verdict.merged, true);
  assert.equal(exitCode, 0);
});

test('#2453 localHeadDrift stays null when the local branch differs from the PR head branch, even with a different SHA', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({
      branch: 'main',
      headSha: DRIFTED,
    }),
    fetchHeadRefName: () => 'issue/994-fix-thing',
  });
  const { verdict } = runMergeExecute([...BASE_ARGS, '--apply'], deps);

  assert.equal(verdict.localHeadDrift, null);
});

test('#2453 localHeadDrift stays null when getLocalHeadState reports no local branch/HEAD (not a git repo)', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({ branch: null, headSha: null }),
    fetchHeadRefName: () => {
      throw new Error('must not be called without local branch/HEAD');
    },
  });
  const { verdict } = runMergeExecute([...BASE_ARGS, '--apply'], deps);

  assert.equal(verdict.localHeadDrift, null);
});

test('#2453 localHeadDrift stays null and never throws when getLocalHeadState itself misbehaves and throws', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => {
      throw new Error('simulated local git failure');
    },
  });

  assert.doesNotThrow(() => runMergeExecute([...BASE_ARGS, '--apply'], deps));
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );
  assert.equal(verdict.localHeadDrift, null);
  assert.equal(verdict.merged, true);
  assert.equal(exitCode, 0);
});

test('#2453 localHeadDrift stays null and never throws when fetchHeadRefName itself misbehaves and throws', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({
      branch: 'issue/994-fix-thing',
      headSha: DRIFTED,
    }),
    fetchHeadRefName: () => {
      throw new Error('simulated gh failure');
    },
  });

  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );
  assert.equal(verdict.localHeadDrift, null);
  assert.equal(verdict.merged, true);
  assert.equal(exitCode, 0);
});

test('#2453 localHeadDrift is also computed in dry-run, without affecting readiness', () => {
  const { deps } = depsFor(readyReport(), {
    getLocalHeadState: () => ({
      branch: 'issue/994-fix-thing',
      headSha: DRIFTED,
    }),
    fetchHeadRefName: () => 'issue/994-fix-thing',
  });
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);

  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.localHeadDrift, {
    localHeadSha: DRIFTED,
    remoteHeadSha: HEAD,
  });
  assert.equal(exitCode, 0);
});

test('--owner/--repo scope the head re-fetch, merge, and mergeCommand to that repoRef', () => {
  const { deps, calls } = depsFor(readyReport());
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--owner', 'acme', '--repo', 'widget', '--apply'],
    deps,
  );

  assert.equal(verdict.merged, true);
  assert.equal(exitCode, 0);
  // The emitted command is scoped to the same repo.
  assert.equal(
    verdict.mergeCommand,
    `gh -R acme/widget pr merge 994 --merge --match-head-commit ${HEAD}`,
  );
  // Both the head re-fetch and the merge gh calls are scoped to repoRef.
  assert.deepEqual(calls.fetchRepoRefs, ['acme/widget']);
  assert.deepEqual(calls.mergeRepoRefs, ['acme/widget']);
});

test('without --owner/--repo no -R scope is added (current-directory repo)', () => {
  const { deps, calls } = depsFor(readyReport());
  const { verdict } = runMergeExecute([...BASE_ARGS, '--apply'], deps);

  assert.equal(
    verdict.mergeCommand,
    `gh pr merge 994 --merge --match-head-commit ${HEAD}`,
  );
  assert.deepEqual(calls.fetchRepoRefs, [null]);
  assert.deepEqual(calls.mergeRepoRefs, [null]);
});

test('exactly one of --owner/--repo fails closed (require both or neither)', () => {
  const { deps } = depsFor(readyReport());
  // The collector fills the missing half from the current-directory repo,
  // so a single flag would validate one repo but merge another.
  assert.throws(
    () => runMergeExecute([...BASE_ARGS, '--owner', 'acme', '--apply'], deps),
    /must be provided together or not at all/,
  );
  assert.throws(
    () => runMergeExecute([...BASE_ARGS, '--repo', 'widget', '--apply'], deps),
    /must be provided together or not at all/,
  );
});

test('--apply on a blocked gate fails closed without merging', () => {
  const report = readyReport();
  report.advisoryWait = { f3Outcome: 'WAIT' };
  const { deps, calls } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.ready, false);
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /not-ready/);
  assert.equal(exitCode, 1);
});

test('--apply fails closed when the head drifts before merge', () => {
  // Live head re-fetch returns a different SHA than the validated head.
  const { deps, calls } = depsFor(readyReport(), {
    fetchHeadSha: () => DRIFTED,
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /head drift/);
  assert.equal(exitCode, 1);
});

test('--apply returns a structured verdict when head re-validation fails', () => {
  const { deps, calls } = depsFor(readyReport(), {
    fetchHeadSha: () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'gh: API rate limit exceeded\n',
      });
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /head re-validation failed/);
  assert.match(verdict.mergeResult, /API rate limit exceeded/);
  assert.equal(exitCode, 1);
});

test('--apply fails closed when re-validation finds head drift', () => {
  // Head re-fetch agrees, but the re-validation collect reports a moved head.
  let collectCount = 0;
  const { deps, calls } = depsFor(readyReport(), {
    collect: () => {
      collectCount += 1;
      const report = readyReport();
      if (collectCount >= 2) {
        report.prHeadSha = DRIFTED;
      }
      return report;
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /head drift on re-validation/);
  assert.equal(exitCode, 1);
});

test('--apply returns a structured verdict when readiness re-validation fails', () => {
  let collectCount = 0;
  const { deps, calls } = depsFor(readyReport(), {
    collect: () => {
      collectCount += 1;
      if (collectCount >= 2) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'gh: authentication required\n',
        });
      }
      return readyReport();
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /readiness re-validation failed/);
  assert.match(verdict.mergeResult, /authentication required/);
  assert.equal(exitCode, 1);
});

test('--apply fails closed when the claim is lost on re-validation', () => {
  let collectCount = 0;
  const { deps, calls } = depsFor(readyReport(), {
    collect: () => {
      collectCount += 1;
      const report = readyReport();
      if (collectCount >= 2) {
        report.claim = { matchesExpectedClaim: false, reason: 'claim-lost' };
      }
      return report;
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /claim lost on re-validation/);
  assert.equal(exitCode, 1);
});

test('--apply fails closed when a new blocker appears at re-validation', () => {
  let collectCount = 0;
  const { deps, calls } = depsFor(readyReport(), {
    collect: () => {
      collectCount += 1;
      const report = readyReport();
      if (collectCount >= 2) {
        report.threads = { actionableCount: 1 };
      }
      return report;
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.equal(verdict.ready, false);
  assert.match(verdict.mergeResult, /new blockers/);
  assert.equal(exitCode, 1);
});

// #1513: the exact field-evidence scenario -- `pre-merge-readiness` reported
// `ready: true` for a PR GitHub itself already reported as
// `mergeStateStatus: BEHIND`. `--apply` must fail closed with a structured
// blocker BEFORE ever calling `deps.mergePr`, not attempt the merge and
// crash on GitHub's rejection.
test('--apply fails closed on a BEHIND head that requires an up-to-date head, without attempting the merge', () => {
  const report = readyReport();
  report.branchCurrency = {
    mergeStateStatus: 'BEHIND',
    mergeable: 'MERGEABLE',
    requiresUpToDateHead: true,
    requiresUpToDateHeadSource: 'ruleset',
  };
  const { deps, calls } = depsFor(report);
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.ready, false);
  assert.deepEqual(
    verdict.blockers.map((b) => b.gate),
    ['branch-currency'],
  );
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, [], 'gh pr merge must never be invoked');
  assert.match(verdict.mergeResult, /not-ready/);
  assert.equal(exitCode, 1);
});

// #1513: previously, any `gh pr merge` rejection (not only a BEHIND head --
// for example a race where the head drifted between the F3 re-validation
// and the merge call itself) propagated as an uncaught exception instead of
// this function's normal structured verdict shape.
test('a mergePr rejection produces the normal structured verdict instead of an uncaught exception', () => {
  const { deps, calls } = depsFor(readyReport(), {
    mergePr: () => {
      const error = new Error(
        'Command failed with exit code 1: gh pr merge 994 --merge --match-head-commit 1111111111111111111111111111111111111111',
      ) as Error & { stderr?: string };
      error.stderr =
        'X Pull request kurone-kito/idd-skill#994 is not mergeable: the head branch is not up to date with the base branch.\n';
      throw error;
    },
  });

  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.ready, true);
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /merge command failed/);
  assert.match(verdict.mergeResult, /not up to date with the base branch/);
  assert.equal(exitCode, 1);
});

test('a mergePr rejection without a stderr field falls back to the error message', () => {
  const { deps } = depsFor(readyReport(), {
    mergePr: () => {
      throw new Error('boom: no stderr on this error');
    },
  });

  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.match(verdict.mergeResult, /merge command failed/);
  assert.match(verdict.mergeResult, /boom: no stderr on this error/);
  assert.equal(exitCode, 1);
});

test('missing --pr is rejected', () => {
  assert.throws(
    () =>
      runMergeExecute(['--claim-issue', '309'], depsFor(readyReport()).deps),
    /missing required --pr/,
  );
});

test('evaluateMergeGates delegates to the shared computePreMergeReadinessBlockers rollup', () => {
  // A fully ready report → no blockers, and both entry points agree.
  assert.deepEqual(evaluateMergeGates(readyReport()), []);
  assert.deepEqual(
    computePreMergeReadinessBlockers(readyReport()),
    evaluateMergeGates(readyReport()),
  );

  // A report failing several gates → the executor and the shared rollup return
  // byte-identical blockers, in the same gate order.
  const bad = readyReport();
  bad.advisoryWait = { f3Outcome: 'WAIT' };
  bad.ci = { status: 'failure', noRequiredChecksConfigured: false };
  assert.deepEqual(
    computePreMergeReadinessBlockers(bad),
    evaluateMergeGates(bad),
  );
  assert.deepEqual(
    evaluateMergeGates(bad).map((blocker) => blocker.gate),
    ['advisory-wait', 'ci'],
  );
});

// #1377 (Copilot review finding on PR #1379): protectionReadsUnreadable must
// block the ci gate even when the *other* (readable) required-check source
// already yields a fully passing set -- requiredChecksPassing/status alone
// must never short-circuit past an unreadable read, because a masked 404 on
// one source can hide additional required checks the readable source never
// surfaced. A report can be "requiredChecksPassing: true" from the readable
// source and still be unsafe to merge.
test('protectionReadsUnreadable blocks the ci gate even when requiredChecksPassing is already true', () => {
  const report = readyReport();
  report.ci = {
    status: 'success',
    requiredChecksPassing: true,
    noRequiredChecksConfigured: false,
    protectionReadsUnreadable: true,
    presentRunConclusion: 'all-passing',
  };

  const blockers = evaluateMergeGates(report);
  assert.deepEqual(computePreMergeReadinessBlockers(report), blockers);
  const ciBlocker = blockers.find((blocker) => blocker.gate === 'ci');
  assert.equal(
    ciBlocker?.detail,
    'cannot determine required checks: protection/ruleset unreadable',
  );
});

// ---------------------------------------------------------------------------
// #1521: solo-CODEOWNER autonomous `--admin` merge fallback.
// ---------------------------------------------------------------------------

test('isEligibleForSoloCodeownerAdminFallback requires status clear, a bypass reason, AND the sole-eligible-codeowner topology fact', () => {
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'clear',
        reason: 'pull-request-bypass-available',
        prAuthorIsSoleEligibleCodeowner: true,
      },
    }),
    true,
  );
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'clear',
        reason: 'ruleset-bypass-available',
        prAuthorIsSoleEligibleCodeowner: true,
      },
    }),
    true,
  );
  // #1521 crux: `status: 'clear'` alone (even with a bypass reason) is NOT
  // enough -- a genuinely outstanding non-author codeowner review must
  // never satisfy this.
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'clear',
        reason: 'pull-request-bypass-available',
        prAuthorIsSoleEligibleCodeowner: false,
      },
    }),
    false,
  );
  // The 'non-author-codeowner-available' reason is never eligible either,
  // regardless of the topology field (defense in depth).
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'clear',
        reason: 'non-author-codeowner-available',
        prAuthorIsSoleEligibleCodeowner: false,
      },
    }),
    false,
  );
  // Real approval already happened -- no fallback needed, and 'reason'
  // does not match either bypass reason.
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'not_applicable',
        reason: 'codeowner-approval-satisfied',
        prAuthorIsSoleEligibleCodeowner: false,
      },
    }),
    false,
  );
  // deadlock / possible_deadlock never qualify even with the topology flag.
  assert.equal(
    isEligibleForSoloCodeownerAdminFallback({
      codeownerSelfApproval: {
        status: 'deadlock',
        reason: 'pr-author-is-only-direct-codeowner',
        prAuthorIsSoleEligibleCodeowner: true,
      },
    }),
    false,
  );
  // Missing/malformed reviewerStates fails closed (not eligible).
  assert.equal(isEligibleForSoloCodeownerAdminFallback({}), false);
});

test('isSafeSoloCodeownerAdminMergeState rejects unsettled or blocked live state', () => {
  assert.equal(
    isSafeSoloCodeownerAdminMergeState({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    true,
  );
  assert.equal(
    isSafeSoloCodeownerAdminMergeState(
      {
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND',
      },
      { requiresUpToDateHead: false },
    ),
    true,
  );
  assert.equal(
    isSafeSoloCodeownerAdminMergeState(
      {
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND',
      },
      { requiresUpToDateHead: true },
    ),
    false,
  );
  for (const mergeState of [
    { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    { mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
    {},
  ]) {
    assert.equal(isSafeSoloCodeownerAdminMergeState(mergeState), false);
  }
});

test('--apply retries with --admin and succeeds for the genuine solo-CODEOWNER deadlock', () => {
  const report = soloCodeownerDeadlockReport();
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, true);
  assert.equal(verdict.adminFallbackUsed, true);
  assert.match(verdict.mergeResult, /admin-fallback/);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, [`994:${HEAD}`]);
  assert.equal(exitCode, 0);
});

test('--apply does NOT retry with --admin when a non-author codeowner review is genuinely outstanding (#1521 multi-CODEOWNER safety property)', () => {
  const report = readyReport();
  // Same GitHub error text and same status: 'clear' as the eligible case
  // above -- the ONLY difference is the topology fact, proving a real
  // non-author codeowner exists and this is NOT the self-approval deadlock.
  report.reviewerStates = {
    requiredApprovalsSatisfied: true,
    codeownerApprovalSatisfied: false,
    codeownerSelfApproval: {
      status: 'clear',
      reason: 'pull-request-bypass-available',
      prAuthorIsSoleEligibleCodeowner: false,
    },
  };
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /merge command failed/);
  assert.match(verdict.mergeResult, /base branch policy prohibits the merge/);
  assert.equal(exitCode, 1);
});

test('--apply does not retry with --admin when the repository opts into hold-and-report', () => {
  const report = soloCodeownerDeadlockReport();
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    resolveSoloCodeownerAdminFallbackMode: () => 'hold-and-report',
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /merge command failed/);
  assert.equal(exitCode, 1);
});

test('--apply scopes admin-fallback policy resolution to the target repository', () => {
  const report = soloCodeownerDeadlockReport();
  let policyArgs: [number, string | null, string][] | undefined;
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    resolveSoloCodeownerAdminFallbackMode: (prNumber, repoRef, headSha) => {
      policyArgs = [[prNumber, repoRef, headSha]];
      return 'hold-and-report';
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--owner', 'acme', '--repo', 'widget', '--apply'],
    deps,
  );

  assert.deepEqual(policyArgs, [[994, 'acme/widget', HEAD]]);
  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /base branch policy prohibits the merge/);
  assert.equal(exitCode, 1);
});

test('--apply fails closed when the target admin-fallback policy is unreadable', () => {
  const { deps, calls } = depsFor(soloCodeownerDeadlockReport(), {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    resolveSoloCodeownerAdminFallbackMode: () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'gh: target repository policy is unreadable\n',
      });
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /target repository policy unreadable/);
  assert.equal(exitCode, 1);
});

test('--apply does not retry with --admin for an unrelated merge failure (e.g. a real conflict)', () => {
  const report = soloCodeownerDeadlockReport();
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw Object.assign(new Error('Command failed'), {
        stderr:
          'X Pull request kurone-kito/idd-skill#1487 is not mergeable: conflicts must be resolved.\n',
      });
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /conflicts must be resolved/);
  assert.equal(exitCode, 1);
});

test('--apply surfaces a distinct failure when the --admin retry itself fails', () => {
  const report = soloCodeownerDeadlockReport();
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    mergePrAdmin: () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'X insufficient permissions to use --admin\n',
      });
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  // adminFallbackUsed still records that the fallback was ATTEMPTED, even
  // though it did not succeed -- distinct from never having attempted it.
  assert.equal(verdict.adminFallbackUsed, true);
  assert.deepEqual(calls.merged, []);
  assert.match(verdict.mergeResult, /admin-fallback merge also failed/);
  assert.match(verdict.mergeResult, /insufficient permissions/);
  assert.equal(exitCode, 1);
});

test('dry-run never invokes the --admin fallback even when the report is fallback-eligible', () => {
  const report = soloCodeownerDeadlockReport();
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
  });
  const { verdict, exitCode } = runMergeExecute(BASE_ARGS, deps);

  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.ready, true);
  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.equal(exitCode, 0);
});

// #1521 (Codex review on PR #1537): the admin-fallback path re-validates a
// SECOND time, immediately before `mergePrAdmin`, rather than trusting the
// snapshot collected before the (failed) plain merge attempt. `--admin`
// bypasses the entire ruleset, so a blocker that appeared in the interim
// (a required check turning red, a review dismissal, etc.) must abort the
// fallback instead of being silently bypassed.
test('--apply aborts the admin fallback when a new blocker appears on the second re-validation', () => {
  let collectCount = 0;
  const { deps, calls } = depsFor(soloCodeownerDeadlockReport(), {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    collect: () => {
      collectCount += 1;
      const report = soloCodeownerDeadlockReport();
      // 1st collect() = the initial dry-run-equivalent report (ready).
      // 2nd collect() = the pre-plain-merge revalidation (still ready).
      // 3rd collect() = the pre-admin-merge revalidation: a required
      // check has since turned red.
      if (collectCount >= 3) {
        report.ci = {
          status: 'failure',
          requiredChecksPassing: false,
          noRequiredChecksConfigured: false,
          presentRunConclusion: 'failure',
        };
      }
      return report;
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /admin-fallback aborted/);
  assert.match(verdict.mergeResult, /new blockers/);
  assert.equal(verdict.ready, false);
  assert.ok(verdict.blockers.some((b) => b.gate === 'ci'));
  assert.equal(exitCode, 1);
});

test('--apply aborts the admin fallback when solo-CODEOWNER eligibility no longer holds on re-validation', () => {
  let collectCount = 0;
  const { deps, calls } = depsFor(soloCodeownerDeadlockReport(), {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    collect: () => {
      collectCount += 1;
      const report = soloCodeownerDeadlockReport();
      // On the pre-admin-merge revalidation (3rd collect), a non-author
      // codeowner's review arrived in the interim -- the general gate
      // still reports `status: 'clear'` (still bypass-available), but
      // the topology fact now correctly reports this is NOT the
      // solo-author deadlock.
      if (collectCount >= 3) {
        (
          report.reviewerStates as Record<string, unknown>
        ).codeownerSelfApproval = {
          status: 'clear',
          reason: 'pull-request-bypass-available',
          prAuthorIsSoleEligibleCodeowner: false,
        };
      }
      return report;
    },
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.merged, []);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /eligibility no longer holds/);
  assert.equal(exitCode, 1);
});

test('--apply aborts the admin fallback when live merge state is blocked', () => {
  const { deps, calls } = depsFor(soloCodeownerDeadlockReport(), {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    }),
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /live merge state/);
  assert.equal(exitCode, 1);
});

test('--apply aborts a BEHIND admin fallback when an up-to-date head is required', () => {
  const report = soloCodeownerDeadlockReport();
  report.branchCurrency = {
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    requiresUpToDateHead: true,
    requiresUpToDateHeadSource: 'branch-protection',
  };
  const { deps, calls } = depsFor(report, {
    mergePr: () => {
      throw baseBranchPolicyMergeError();
    },
    fetchMergeState: () => ({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    }),
  });
  const { verdict, exitCode } = runMergeExecute(
    [...BASE_ARGS, '--apply'],
    deps,
  );

  assert.equal(verdict.merged, false);
  assert.equal(verdict.adminFallbackUsed, false);
  assert.deepEqual(calls.adminMerged, []);
  assert.match(verdict.mergeResult, /admin-fallback aborted/);
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// resolveRemoteSoloCodeownerAdminFallbackMode -- #1708: pin the
// 404-vs-non-404 and empty-content branches directly (no MergeExecuteDeps
// injection), via the same injectable-fetch pattern this file's other pure
// helpers already use.
// ---------------------------------------------------------------------------

function base64Config(config: unknown): string {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

function httpError(status: number): Error {
  return new Error(`gh: Not Found (HTTP ${status})`);
}

test('resolveRemoteSoloCodeownerAdminFallbackMode decodes a valid remote config, threading repoRef/headSha to the fetch', () => {
  const calls: [string, string][] = [];
  const mode = resolveRemoteSoloCodeownerAdminFallbackMode(
    42,
    'o/r',
    'deadbeef',
    (repoRef, headSha) => {
      calls.push([repoRef, headSha]);
      return base64Config({
        mergeGate: { soloCodeownerAdminFallback: 'hold-and-report' },
      });
    },
  );
  assert.equal(mode, 'hold-and-report');
  assert.deepEqual(calls, [['o/r', 'deadbeef']]);
});

test('resolveRemoteSoloCodeownerAdminFallbackMode falls back to the distributed default on a confirmed 404', () => {
  const mode = resolveRemoteSoloCodeownerAdminFallbackMode(
    42,
    'o/r',
    'deadbeef',
    () => {
      throw httpError(404);
    },
  );
  assert.equal(mode, 'auto-admin-retry');
});

test('resolveRemoteSoloCodeownerAdminFallbackMode rethrows a non-404 fetch failure', () => {
  assert.throws(
    () =>
      resolveRemoteSoloCodeownerAdminFallbackMode(42, 'o/r', 'deadbeef', () => {
        throw httpError(403);
      }),
    /HTTP 403/,
  );
});

test('resolveRemoteSoloCodeownerAdminFallbackMode rejects an empty (but successfully fetched) content field instead of treating it as "no policy file"', () => {
  assert.throws(
    () =>
      resolveRemoteSoloCodeownerAdminFallbackMode(
        42,
        'o/r',
        'deadbeef',
        () => '',
      ),
    /policy is empty for PR #42 at deadbeef/,
  );
});
