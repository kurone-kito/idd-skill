import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateMergeGates,
  type MergeExecuteDeps,
  runMergeExecute,
} from '../src/scripts/idd-merge-execute.mts';

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

test('missing --pr is rejected', () => {
  assert.throws(
    () =>
      runMergeExecute(['--claim-issue', '309'], depsFor(readyReport()).deps),
    /missing required --pr/,
  );
});
