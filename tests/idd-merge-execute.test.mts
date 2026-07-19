import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateMergeGates,
  type MergeExecuteDeps,
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
  };
} {
  const calls = {
    merged: [] as string[],
    fetchRepoRefs: [] as (string | null)[],
    mergeRepoRefs: [] as (string | null)[],
  };
  const deps: MergeExecuteDeps = {
    collect: () => report,
    fetchHeadSha: (_prNumber, repoRef) => {
      calls.fetchRepoRefs.push(repoRef);
      return String(report.prHeadSha ?? '');
    },
    mergePr: (prNumber, headSha, repoRef) => {
      calls.merged.push(`${prNumber}:${headSha}`);
      calls.mergeRepoRefs.push(repoRef);
      return 'Merged PR.';
    },
    ...overrides,
  };
  return { deps, calls };
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
