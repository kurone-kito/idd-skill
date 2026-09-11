import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ADVISORY_CONVERGENCE_WORKFLOW_PATH,
  collectFromGitHub,
  computeAdvisoryConvergenceVerdict,
  parseArgs,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
  SELF_REFERENTIAL_WAIVER_JOB_ID,
  SELF_REFERENTIAL_WAIVER_POST_STEP_NAME,
} from '../src/scripts/advisory-convergence.mts';
import { DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES } from '../src/scripts/advisory-wait-policy.mts';
import {
  digestExternalCheckWaiverMarkerBody,
  renderExternalCheckWaiverComment,
} from '../src/scripts/marker-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

// ---------------------------------------------------------------------------
// Fake-provider collection wiring (#2267 AC4: "unit tests exercise the
// PR-facing state machine with a fake provider ... including unsupported
// capability, and explicit advisory not_applicable ... without network
// access"). collectFromGitHub is the one function in this file that talks
// to a provider at all; runAdvisoryConvergence's own tests inject their own
// deps.collect and never exercise it. This suite drives it in-process
// against createFakeProviderAdapter via its createPort injection seam --
// zero gh subprocess, zero network -- covering the two scenarios this
// commit's new capability-coercion wiring can produce (an
// advisory-review-unsupported provider forcing reviewPolicy to
// 'no-advisory', and a fully-supported provider leaving it untouched), plus
// one assertion that a Copilot-authored unresolved thread survives the
// listChangeRequestReviewThreadsWithAuthorType -> ReviewThreadPayload shim
// this migration introduced. The pure computeAdvisoryConvergenceVerdict
// state machine itself is already covered exhaustively by
// tests/advisory-convergence.test.mts's own direct unit tests.
// ---------------------------------------------------------------------------

const PR_NUMBER = 42;

function withHermeticCwd<T>(run: () => T): T {
  const cwdRoot = mkdtempSync(join(tmpdir(), 'idd-advisory-convergence-fake-'));
  const originalCwd = process.cwd();
  try {
    // collectFromGitHub resolves every policy read (.github/idd/config.json)
    // relative to process.cwd(), not this script's location -- an unpatched
    // cwd would read this repo's own live config during the test (same
    // rationale as pre-merge-readiness-collection-smoke.test.mts's own
    // empty-cwd fixture).
    process.chdir(cwdRoot);
    return run();
  } finally {
    process.chdir(originalCwd);
    rmSync(cwdRoot, { recursive: true, force: true });
  }
}

function baseFixture() {
  return {
    changeRequestConvergenceViews: {
      [PR_NUMBER]: {
        headSha: 'a'.repeat(40),
        headRefName: 'issue/42-example',
        authorLogin: 'author-user',
        url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        closingIssuesReferences: [],
      },
    },
    reviewsWithHeadCommitDate: {
      [PR_NUMBER]: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
    },
  };
}

test('collectFromGitHub against a fake provider without advisory-review support coerces reviewPolicy to no-advisory', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      capabilityDeclarations: [
        { group: 'advisory-review', requirement: 'optional', supported: false },
      ],
    });

    const { options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.equal(options.reviewPolicy, 'no-advisory');
  });
});

test('collectFromGitHub against a fake provider with every capability supported (the GitHub adapter posture) never coerces reviewPolicy', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter(baseFixture());

    const { options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    // No .github/idd/config.json under the hermetic cwd, so rawConfig has
    // no reviewPolicy of its own either -- this asserts the capability
    // check itself stays inert (never forces 'no-advisory'), not merely
    // that some other default happened to already be 'no-advisory'.
    assert.notEqual(options.reviewPolicy, 'no-advisory');
  });
});

test('collectFromGitHub threads a Copilot-authored unresolved thread through listChangeRequestReviewThreadsWithAuthorType, with no gh process spawned', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      reviewThreadsWithAuthorType: {
        [PR_NUMBER]: [
          {
            id: 'RT_1',
            isResolved: false,
            comments: [
              {
                body: 'please address this',
                createdAt: '2026-07-31T09:00:00Z',
                updatedAt: '2026-07-31T09:00:00Z',
                authorLogin: 'copilot',
                authorTypename: 'Bot',
                pullRequestReviewId: null,
              },
            ],
          },
        ],
      },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.equal(inputs.threads?.length, 1);
    const [thread] = inputs.threads ?? [];
    assert.equal(thread.id, 'RT_1');
    assert.equal(thread.isResolved, false);
    assert.equal(thread.comments?.nodes[0]?.author?.login, 'copilot');
    assert.equal(thread.comments?.nodes[0]?.author?.__typename, 'Bot');
  });
});

test('collectFromGitHub retries one transient getChangeRequestConvergenceView failure, then succeeds (#2459)', () => {
  withHermeticCwd(() => {
    const realPort = createFakeProviderAdapter(baseFixture());
    let calls = 0;
    const flakyPort = {
      ...realPort,
      getChangeRequestConvergenceView(number: number) {
        calls += 1;
        if (calls === 1) {
          throw new Error('connection reset by peer');
        }
        return realPort.getChangeRequestConvergenceView(number);
      },
    };

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => flakyPort,
    );

    // Retried past the transient failure instead of crashing the whole
    // collection: the second (real) call succeeded, and its data made it
    // all the way into the returned inputs.
    assert.equal(calls, 2);
    assert.equal(inputs.prHeadSha, 'a'.repeat(40));
  });
});

test('collectFromGitHub does not retry a definitive 404 from getChangeRequestConvergenceView (#2459)', () => {
  withHermeticCwd(() => {
    const realPort = createFakeProviderAdapter(baseFixture());
    let calls = 0;
    const notFound = Object.assign(new Error('gh: Not Found (HTTP 404)'), {
      stderr: 'gh: Not Found (HTTP 404)',
    });
    const missingPort = {
      ...realPort,
      getChangeRequestConvergenceView(_number: number) {
        calls += 1;
        throw notFound;
      },
    };

    assert.throws(
      () =>
        collectFromGitHub(
          parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
          () => missingPort,
        ),
      notFound,
    );
    // A permanent 404 rethrows on the first attempt -- no wasted retry
    // budget on a failure a retry cannot fix.
    assert.equal(calls, 1);
  });
});

test('collectFromGitHub falls back to the default terminal window when advisoryWait is schema-invalid for an UNRELATED reason (#2554, Copilot review PR #2564 round 3)', () => {
  withHermeticCwd(() => {
    mkdirSync(join('.github', 'idd'), { recursive: true });
    // `terminalWindow` itself is a syntactically valid duration string, but
    // the unknown `notARealKey` field violates the advisoryWait section's
    // `additionalProperties: false` schema, which must invalidate the WHOLE
    // section per this file's `readAdvisoryTerminalWindowMinutes()`-style
    // validate-or-default contract. Before #2554's fix, `terminalWindow`
    // fed straight into the pure resolveEffectiveAdvisoryTerminalWindow-
    // Minutes with no such gate, so this syntactically-valid-looking value
    // leaked through as 120 instead of falling back to the 720 default the
    // section's own invalidity should have forced.
    writeFileSync(
      join('.github', 'idd', 'config.json'),
      JSON.stringify({
        advisoryWait: { terminalWindow: 'PT2H', notARealKey: 'x' },
      }),
      'utf8',
    );
    const port = createFakeProviderAdapter(baseFixture());

    const { options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.equal(
      options.terminalWindowMinutes,
      DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
    );
  });
});

// ---------------------------------------------------------------------------
// self-referential-bootstrap-auto waiver run-id resolution
// (kurone-kito/idd-skill#2657): collectFromGitHub is the only place this
// gate performs the `GET /repos/{owner}/{repo}/actions/runs/{run-id}`
// lookup a candidate marker's `run-id:` field names -- exercised here
// end-to-end against the fake provider's `workflowRuns` fixture, with the
// actual trust verdict covered by the pure computeAdvisoryConvergenceVerdict
// unit tests in advisory-convergence.test.mts.
// ---------------------------------------------------------------------------

const RUN_ID = '999';
const HEAD_SHA = 'a'.repeat(40);

function autoWaiverComment() {
  return {
    id: 1,
    body: renderExternalCheckWaiverComment({
      agentId: 'github-actions-bot',
      // kurone-kito/idd-skill#2912 (round 2): 'none', not an arbitrary
      // claim id -- the end-to-end tests below compute a verdict with
      // `claimEvents: []` (no active claim resolves), and the sentinel is
      // the only claimId that satisfies claim-binding when
      // `activeClaimId` is empty (protocol-helpers.mts's
      // `claimBindingSatisfied`). A non-'none' claimId there would make
      // every marker fail claim-binding before the artifact-binding
      // check under test is ever reached.
      claimId: 'none',
      headSha: HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
      // kurone-kito/idd-skill#2912 (round 2): within the default
      // `ciGate.externalCheckWaivers.maxValidity` window (`PT24H`) of
      // `createdAt` below -- `summarizeExternalCheckWaivers` re-checks
      // `expiresAt - createdAt` against that window at consume time
      // regardless of how far `expiresAt` sits from the CURRENT wall
      // clock, so a far-future `expiresAt` (e.g. year 2099) with a fixed
      // 2026 `createdAt` classifies as `expired` there, never reaching
      // `.valid` at all -- silently short-circuiting every end-to-end
      // verdict test in this file to `autoWaiverValid: false` for the
      // WRONG reason regardless of the artifact-binding mechanism under
      // test. The end-to-end tests below pin `options.now` near
      // `createdAt` (not real wall-clock time) so this stays valid
      // there too.
      expiresAt: '2026-07-31T20:00:00Z',
      actor: 'github-actions[bot]',
      runId: RUN_ID,
    }),
    createdAt: '2026-07-31T09:00:00Z',
    updatedAt: '2026-07-31T09:00:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

test("collectFromGitHub resolves a candidate self-referential-bootstrap-auto marker's run-id against the runs API (accepted shape)", () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
    });

    const { inputs, options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunLookups?.[RUN_ID], {
      path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
      headSha: HEAD_SHA,
      repositoryFullName: 'o/r',
      event: 'pull_request_target',
    });
    assert.equal(options.repositoryFullName, 'o/r');
  });
});

test('collectFromGitHub fetches and threads listChangeRequestChangedFiles into inputs.changedFilePaths when a candidate auto-waiver marker is present (Codex review, PR #2895: independent allowlist verification)', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      changedFiles: {
        [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH, 'README.md'],
      },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.changedFilePaths, [
      ADVISORY_CONVERGENCE_WORKFLOW_PATH,
      'README.md',
    ]);
  });
});

test('collectFromGitHub also merges listChangeRequestRenamedFromPaths into inputs.changedFilePaths (Codex review, PR #2895, round 12)', () => {
  // listChangeRequestChangedFiles no longer includes a renamed file's OLD
  // path (round 12 split it out to stop polluting CODEOWNERS resolution),
  // but this specific allowlist check still needs it -- collectFromGitHub
  // must fetch and concatenate listChangeRequestRenamedFromPaths too, or a
  // rename-shaped checker repair away from an allowlisted path would go
  // unrecognized here again.
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      changedFiles: {
        [PR_NUMBER]: ['src/scripts/renamed-checker.mts', 'README.md'],
      },
      renamedFromPaths: {
        [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH],
      },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.changedFilePaths, [
      'src/scripts/renamed-checker.mts',
      'README.md',
      ADVISORY_CONVERGENCE_WORKFLOW_PATH,
    ]);
  });
});

test('collectFromGitHub never fetches listChangeRequestChangedFiles when no candidate auto-waiver marker is present (no wasted API call)', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [] },
      // No `changedFiles` fixture entry -- the fake adapter would return
      // `[]` regardless, so this only proves the field stays `undefined`
      // when there is nothing to verify, not that the call was skipped.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.equal(inputs.changedFilePaths, undefined);
  });
});

test('collectFromGitHub resolves a candidate run-id lookup failure to an {error} entry instead of crashing the whole collection', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      // No `workflowRuns` fixture entry for RUN_ID -- the fake adapter
      // throws "no workflow-run fixture for ..." on lookup, matching the
      // real adapter's own no-catch, throw-on-failure contract for an
      // unresolvable run.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    const lookup = inputs.autoWaiverRunLookups?.[RUN_ID];
    assert.ok(lookup && 'error' in lookup && lookup.error.length > 0);
  });
});

test('collectFromGitHub never looks up a run id for a comment that is not this waiver kind (no wasted API calls)', () => {
  withHermeticCwd(() => {
    const ordinaryWaiver = {
      id: 2,
      body: renderExternalCheckWaiverComment({
        agentId: 'kurone-kito',
        claimId: 'claim-abc',
        headSha: HEAD_SHA,
        checkSelector: 'CodeRabbit',
        reason: 'rate limit',
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'kurone-kito',
      }),
      createdAt: '2026-07-31T09:00:00Z',
      updatedAt: '2026-07-31T09:00:00Z',
      authorLogin: 'kurone-kito',
    };
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [ordinaryWaiver] },
      // No `workflowRuns` fixture at all -- any lookup attempt would throw.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunLookups, {});
  });
});

test('collectFromGitHub never looks up a run id from a non-github-actions[bot] author, even with the exact reason token (Copilot review, PR #2895: rate-limit exhaustion guard)', () => {
  withHermeticCwd(() => {
    // Same reason token and run-id shape as a genuine auto-waiver marker,
    // but authored by an arbitrary commenter -- without the author check,
    // this would cost one Actions-run API lookup per such comment on
    // every assert invocation, a cheap way to drain the repository-shared
    // GITHUB_TOKEN rate-limit budget. No `workflowRuns` fixture exists, so
    // an attempted lookup would throw and this test would fail with that
    // exception instead of the assertion below.
    const impostor = {
      id: 3,
      body: renderExternalCheckWaiverComment({
        agentId: 'someone',
        claimId: 'claim-abc',
        headSha: HEAD_SHA,
        checkSelector: 'idd-advisory-convergence',
        reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'not-github-actions',
        runId: RUN_ID,
      }),
      createdAt: '2026-07-31T09:00:00Z',
      updatedAt: '2026-07-31T09:00:00Z',
      authorLogin: 'not-github-actions',
    };
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [impostor] },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunLookups, {});
  });
});

test("collectFromGitHub never looks up a run id whose own marker HEAD does not match this PR's current HEAD (Codex review, PR #2895, round 5)", () => {
  withHermeticCwd(() => {
    // Correct author, reason, and run-id shape -- only the bound HEAD is
    // wrong. Without a local HEAD pre-filter this would still cost an
    // Actions-run lookup; the authoritative HEAD check inside
    // computeAdvisoryConvergenceVerdict already rejects it later, but by
    // then the API call (and its rate-limit cost) has already happened.
    const wrongHeadMarker = {
      id: 4,
      body: renderExternalCheckWaiverComment({
        agentId: 'github-actions-bot',
        claimId: 'claim-abc',
        headSha: 'b'.repeat(40),
        checkSelector: 'idd-advisory-convergence',
        reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'github-actions[bot]',
        runId: RUN_ID,
      }),
      createdAt: '2026-07-31T09:00:00Z',
      updatedAt: '2026-07-31T09:00:00Z',
      authorLogin: 'github-actions[bot]',
    };
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [wrongHeadMarker] },
      // No `workflowRuns` fixture at all -- any lookup attempt would throw.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunLookups, {});
  });
});

test('collectFromGitHub bounds the number of run-id lookups, keeping only the earliest candidates by createdAt (Codex review, PR #2895, rounds 5-6: DoS-via-comment-flood guard)', () => {
  withHermeticCwd(() => {
    // Twenty-five distinct, otherwise-fully-valid, same-HEAD candidates --
    // more than the 20-lookup cap -- a same-repository PR-authored
    // pull_request workflow with issues: write is not fork-restricted and
    // could post arbitrarily many of these. Only a hard cap on lookup
    // COUNT closes this, independent of the HEAD/author filters above (a
    // flood could still share this PR's own real HEAD, which this
    // scenario deliberately does).
    const candidateCount = 25;
    // 1-based -- a real GitHub Actions run id is never "0" (Copilot
    // review, PR #2895: `collectFromGitHub` now validates each candidate's
    // `run-id:` token as a canonical positive integer, `min: 1`, before it
    // is eligible for lookup at all, matching `ci-wait-policy.mts`'s own
    // `--run-id` shape).
    const comments = Array.from({ length: candidateCount }, (_, index) => ({
      id: 100 + index,
      body: renderExternalCheckWaiverComment({
        agentId: 'github-actions-bot',
        claimId: 'claim-abc',
        headSha: HEAD_SHA,
        checkSelector: 'idd-advisory-convergence',
        reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'github-actions[bot]',
        runId: String(index + 1),
      }),
      // Ascending createdAt -- the earliest twenty (run ids "1".."20") are
      // the ones a bound respecting earliest-wins must keep.
      createdAt: `2026-07-31T09:00:${String(index).padStart(2, '0')}Z`,
      updatedAt: `2026-07-31T09:00:${String(index).padStart(2, '0')}Z`,
      authorLogin: 'github-actions[bot]',
    }));
    const workflowRuns: Record<string, unknown> = {};
    for (let index = 0; index < candidateCount; index += 1) {
      workflowRuns[`o/r/${index + 1}`] = {
        path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
        head_sha: HEAD_SHA,
        head_repository: { full_name: 'o/r' },
        event: 'pull_request_target',
      };
    }
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: comments },
      workflowRuns,
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    const lookedUpRunIds = Object.keys(inputs.autoWaiverRunLookups ?? {})
      .map(Number)
      .sort((left, right) => left - right);
    assert.deepEqual(
      lookedUpRunIds,
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });
});

test('collectFromGitHub never counts a wrong-checkSelector marker toward the bounded run-id lookup budget, even with the reserved reason and current HEAD (Copilot review, PR #2895, round 13: budget-exhaustion DoS guard)', () => {
  withHermeticCwd(() => {
    // A same-repository `pull_request`-triggered workflow (runs
    // PR-controlled code, unlike the trusted `pull_request_target` verdict
    // job) could post bot-authored markers with the reserved reason and
    // this PR's real HEAD, but an arbitrary `checkSelector` -- these can
    // never satisfy autoWaiverValid regardless, but before this fix their
    // distinct run ids still consumed the entire 20-slot lookup budget.
    // Twenty such forged candidates (created earliest, so an unfiltered
    // earliest-wins bound would keep exactly them) plus one genuine,
    // later-created marker with the correct selector: the genuine run id
    // must still be looked up.
    const forgedCandidateCount = 20;
    const forgedComments = Array.from(
      { length: forgedCandidateCount },
      (_, index) => ({
        id: 200 + index,
        body: renderExternalCheckWaiverComment({
          agentId: 'github-actions-bot',
          claimId: 'claim-abc',
          headSha: HEAD_SHA,
          checkSelector: 'some-other-check',
          reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
          expiresAt: '2099-01-01T00:00:00Z',
          actor: 'github-actions[bot]',
          runId: String(index + 1),
        }),
        createdAt: `2026-07-31T09:00:${String(index).padStart(2, '0')}Z`,
        updatedAt: `2026-07-31T09:00:${String(index).padStart(2, '0')}Z`,
        authorLogin: 'github-actions[bot]',
      }),
    );
    const genuineRunId = '999';
    const genuineComment = {
      id: 999,
      body: renderExternalCheckWaiverComment({
        agentId: 'github-actions-bot',
        claimId: 'claim-abc',
        headSha: HEAD_SHA,
        checkSelector: 'idd-advisory-convergence',
        reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'github-actions[bot]',
        runId: genuineRunId,
      }),
      // Created LAST -- under the pre-fix earliest-wins bound (with no
      // selector prefilter), the twenty earlier forged candidates alone
      // would already fill the 20-slot budget and crowd this one out.
      createdAt: '2026-07-31T09:01:00Z',
      updatedAt: '2026-07-31T09:01:00Z',
      authorLogin: 'github-actions[bot]',
    };
    const workflowRuns: Record<string, unknown> = {
      [`o/r/${genuineRunId}`]: {
        path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
        head_sha: HEAD_SHA,
        head_repository: { full_name: 'o/r' },
        event: 'pull_request_target',
      },
    };
    // No `workflowRuns` fixture entries for the forged run ids ("1".."20")
    // -- if any of them were still eligible for lookup, the fake adapter
    // would throw on that lookup and this test would fail with that
    // exception rather than the assertion below.
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [...forgedComments, genuineComment] },
      workflowRuns,
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(Object.keys(inputs.autoWaiverRunLookups ?? {}), [
      genuineRunId,
    ]);
    assert.deepEqual(inputs.autoWaiverRunLookups?.[genuineRunId], {
      path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
      headSha: HEAD_SHA,
      repositoryFullName: 'o/r',
      event: 'pull_request_target',
    });
  });
});

test('collectFromGitHub rejects a run-id token that is not a canonical positive integer, never looking it up (Copilot review, PR #2895)', () => {
  withHermeticCwd(() => {
    // renderExternalCheckWaiverComment's own runId normalization only
    // requires a non-whitespace token to round-trip (matching the parser's
    // own `\S+` shape) -- it does not itself require a canonical integer.
    // getWorkflowRun interpolates the token directly into a `gh api` REST
    // path, so a same-repository attacker-authored marker with path syntax
    // in run-id must never reach that call. No `workflowRuns` fixture
    // exists, so an attempted lookup would throw and this test would fail
    // with that exception instead of the assertion below.
    const pathInjectionMarker = {
      id: 5,
      body: renderExternalCheckWaiverComment({
        agentId: 'github-actions-bot',
        claimId: 'claim-abc',
        headSha: HEAD_SHA,
        checkSelector: 'idd-advisory-convergence',
        reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
        expiresAt: '2099-01-01T00:00:00Z',
        actor: 'github-actions[bot]',
        runId: `${RUN_ID}/../../orgs/evil`,
      }),
      createdAt: '2026-07-31T09:00:00Z',
      updatedAt: '2026-07-31T09:00:00Z',
      authorLogin: 'github-actions[bot]',
    };
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [pathInjectionMarker] },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunLookups, {});
  });
});

// ---------------------------------------------------------------------------
// run-jobs provenance lookup and duplicate-run-id candidate counting
// (kurone-kito/idd-skill#2912): closes the residual bearer-evidence gap
// #2657 round 16 tracked but did not close -- a marker citing a real,
// legitimate run's id must also be proven to have been POSTED by that
// run's own idd-advisory-convergence-self-waiver job, not merely to cite
// a run of the right shape.
// ---------------------------------------------------------------------------

function acceptedRunJobsFixture() {
  return {
    jobs: [
      {
        name: SELF_REFERENTIAL_WAIVER_JOB_ID,
        conclusion: 'success',
        steps: [
          {
            name: SELF_REFERENTIAL_WAIVER_POST_STEP_NAME,
            conclusion: 'success',
            started_at: '2026-07-31T08:59:30Z',
            completed_at: '2026-07-31T09:00:30Z',
          },
        ],
      },
    ],
  };
}

test("collectFromGitHub fetches getWorkflowRunJobs and threads the cited run's self-waiver post-step evidence into inputs.autoWaiverRunJobLookups", () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      workflowRunJobs: { [`o/r/${RUN_ID}`]: acceptedRunJobsFixture() },
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunJobLookups?.[RUN_ID], {
      conclusion: 'success',
      startedAt: '2026-07-31T08:59:30Z',
      completedAt: '2026-07-31T09:00:30Z',
    });
  });
});

test('collectFromGitHub resolves a candidate run-jobs lookup failure to an {error} entry instead of crashing the whole collection', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      // No `workflowRunJobs` fixture entry -- the fake adapter throws on
      // lookup, matching the real adapter's own no-catch, throw-on-failure
      // contract for an unresolvable run.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    const lookup = inputs.autoWaiverRunJobLookups?.[RUN_ID];
    assert.ok(lookup && 'error' in lookup && lookup.error.length > 0);
  });
});

test('collectFromGitHub never fetches getWorkflowRunJobs when no candidate auto-waiver marker is present (no wasted API call)', () => {
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [] },
      // No `workflowRunJobs` fixture at all -- any lookup attempt would
      // throw, so a non-empty result below would prove one was attempted.
    });

    const { inputs } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunJobLookups, {});
  });
});

function forgedSiblingComment() {
  return {
    id: 2,
    body: renderExternalCheckWaiverComment({
      agentId: 'github-actions-bot',
      // Same 'none' rationale as autoWaiverComment() above.
      claimId: 'none',
      headSha: HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
      // Same maxValidity rationale as autoWaiverComment() above.
      expiresAt: '2026-07-31T20:00:05Z',
      actor: 'github-actions[bot]',
      runId: RUN_ID,
    }),
    createdAt: '2026-07-31T09:00:05Z',
    updatedAt: '2026-07-31T09:00:05Z',
    authorLogin: 'github-actions[bot]',
  };
}

test("end-to-end: a genuine marker whose comment id matches the cited run's own trusted artifact validates the auto-waiver (positive control, kurone-kito/idd-skill#2912, round 2)", () => {
  // Proves the artifact-binding mechanism actually ACCEPTS a genuine
  // marker end to end (collectFromGitHub -> computeAdvisoryConvergenceVerdict),
  // not merely that it rejects forgeries -- a `false` assertion alone
  // cannot distinguish "the mechanism correctly rejected this" from "the
  // mechanism (or the test's own fixture) is broken and rejects
  // everything".
  withHermeticCwd(() => {
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment()] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      workflowRunJobs: { [`o/r/${RUN_ID}`]: acceptedRunJobsFixture() },
      workflowRunArtifacts: {
        [`o/r/${RUN_ID}`]: {
          artifacts: [
            {
              name: `idd-self-waiver-marker-1-${digestExternalCheckWaiverMarkerBody(autoWaiverComment().body)}`,
            },
          ],
        },
      },
      changedFiles: { [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH] },
    });

    const { inputs, options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    const verdict = computeAdvisoryConvergenceVerdict(
      { ...inputs, claimEvents: [] },
      {
        ...options,
        // kurone-kito/idd-skill#2912 (round 2): pinned near the fixture
        // markers' own createdAt/expiresAt (2026-07-31), not real
        // wall-clock time -- see autoWaiverComment()'s own doc comment
        // for why an unpinned `now` (whatever `collectFromGitHub`
        // resolved it to, i.e. actual test-run time) would classify
        // these markers `expired` regardless of the mechanism under
        // test.
        now: '2026-07-31T09:05:00Z',
        waiverMode: 'maintainer-authorized',
        waivableSelectors: [
          { selector: 'idd-advisory-convergence', matchMode: 'exact' },
        ],
      },
    );
    assert.equal(verdict.waiver.autoWaiverValid, true);
  });
});

test('collectFromGitHub records two distinct comments citing the same run id as two candidates, each carrying its own comment id and body digest (autoWaiverRunIdCandidates); the genuine one still validates despite a forged sibling being present (kurone-kito/idd-skill#2912, round 2, extended round 3)', () => {
  withHermeticCwd(() => {
    const forgedSibling = forgedSiblingComment();
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      comments: { [PR_NUMBER]: [autoWaiverComment(), forgedSibling] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      workflowRunJobs: { [`o/r/${RUN_ID}`]: acceptedRunJobsFixture() },
      // The trusted artifact names ONLY the genuine comment's (id, body
      // digest) pair -- this run's own trusted job posted exactly one
      // comment.
      workflowRunArtifacts: {
        [`o/r/${RUN_ID}`]: {
          artifacts: [
            {
              name: `idd-self-waiver-marker-1-${digestExternalCheckWaiverMarkerBody(autoWaiverComment().body)}`,
            },
          ],
        },
      },
      changedFiles: { [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH] },
    });

    const { inputs, options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunIdCandidates?.[RUN_ID], [
      {
        id: '1',
        createdAt: autoWaiverComment().createdAt,
        bodyDigest: digestExternalCheckWaiverMarkerBody(
          autoWaiverComment().body,
        ),
      },
      {
        id: '2',
        createdAt: forgedSibling.createdAt,
        bodyDigest: digestExternalCheckWaiverMarkerBody(forgedSibling.body),
      },
    ]);
    assert.deepEqual(inputs.autoWaiverRunArtifactBindings?.[RUN_ID], [
      {
        id: '1',
        bodyDigest: digestExternalCheckWaiverMarkerBody(
          autoWaiverComment().body,
        ),
      },
    ]);

    // End-to-end: unlike this file's ROUND-1 mechanism (a bare "no
    // duplicate visible" scan, which fail-closed BOTH markers the moment
    // any second candidate for the same run id existed), round 2's
    // artifact-binding check evaluates each candidate against the
    // trusted set independently -- the genuine marker (id 1, named by
    // the artifact) still validates on its own merits even though a
    // forged sibling (id 2, never named by any artifact) also cites the
    // same run id. This is a deliberate precision improvement: a forged
    // sibling can no longer collaterally deny a genuine marker its
    // auto-waiver, it just never validates itself (see the P1-regression
    // test below for the case that actually matters -- the genuine one
    // deleted, only the forged one surviving).
    const verdict = computeAdvisoryConvergenceVerdict(
      { ...inputs, claimEvents: [] },
      {
        ...options,
        // kurone-kito/idd-skill#2912 (round 2): pinned near the fixture
        // markers' own createdAt/expiresAt (2026-07-31), not real
        // wall-clock time -- see autoWaiverComment()'s own doc comment
        // for why an unpinned `now` (whatever `collectFromGitHub`
        // resolved it to, i.e. actual test-run time) would classify
        // these markers `expired` regardless of the mechanism under
        // test.
        now: '2026-07-31T09:05:00Z',
        waiverMode: 'maintainer-authorized',
        waivableSelectors: [
          { selector: 'idd-advisory-convergence', matchMode: 'exact' },
        ],
      },
    );
    assert.equal(verdict.waiver.autoWaiverValid, true);
  });
});

test('end-to-end: a genuine marker deleted after posting leaves a same-run-id forged sibling rejected, never validating the auto-waiver (kurone-kito/idd-skill#2912, round 2 P1: Codex + Copilot review, PR #2914)', () => {
  withHermeticCwd(() => {
    const forgedSibling = forgedSiblingComment();
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      // The genuine comment (id 1, `autoWaiverComment()`) has been
      // deleted -- `issues: write` permits deleting ANY issue comment on
      // the repository, not only ones the deleting token authored. Only
      // the forged sibling (id 2) is still live.
      comments: { [PR_NUMBER]: [forgedSibling] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      workflowRunJobs: { [`o/r/${RUN_ID}`]: acceptedRunJobsFixture() },
      // The trusted artifact -- uploaded by the run's own trusted job
      // execution, unaffected by the comment's later deletion -- still
      // names the GENUINE (now-deleted) comment's (id, original body
      // digest) pair.
      workflowRunArtifacts: {
        [`o/r/${RUN_ID}`]: {
          artifacts: [
            {
              name: `idd-self-waiver-marker-1-${digestExternalCheckWaiverMarkerBody(autoWaiverComment().body)}`,
            },
          ],
        },
      },
      changedFiles: { [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH] },
    });

    const { inputs, options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    assert.deepEqual(inputs.autoWaiverRunIdCandidates?.[RUN_ID], [
      {
        id: '2',
        createdAt: forgedSibling.createdAt,
        bodyDigest: digestExternalCheckWaiverMarkerBody(forgedSibling.body),
      },
    ]);
    assert.deepEqual(inputs.autoWaiverRunArtifactBindings?.[RUN_ID], [
      {
        id: '1',
        bodyDigest: digestExternalCheckWaiverMarkerBody(
          autoWaiverComment().body,
        ),
      },
    ]);

    const verdict = computeAdvisoryConvergenceVerdict(
      { ...inputs, claimEvents: [] },
      {
        ...options,
        // kurone-kito/idd-skill#2912 (round 2): pinned near the fixture
        // markers' own createdAt/expiresAt (2026-07-31), not real
        // wall-clock time -- see autoWaiverComment()'s own doc comment
        // for why an unpinned `now` (whatever `collectFromGitHub`
        // resolved it to, i.e. actual test-run time) would classify
        // these markers `expired` regardless of the mechanism under
        // test.
        now: '2026-07-31T09:05:00Z',
        waiverMode: 'maintainer-authorized',
        waivableSelectors: [
          { selector: 'idd-advisory-convergence', matchMode: 'exact' },
        ],
      },
    );
    assert.equal(verdict.waiver.autoWaiverValid, false);
  });
});

// kurone-kito/idd-skill#2912 (round 3, Copilot review, PR #2914 round 2):
// SAME id/createdAt as `autoWaiverComment()`, but rendered with a
// different `agentId` -- the one field on an external-check-waiver marker
// no classification/trust condition anywhere in this file's own trust
// chain consumes (see `parsed.agentId`'s absence from every grep hit in
// advisory-convergence.mts/protocol-helpers.mts), so this changes the
// posted body's exact text/digest without ALSO tripping an earlier,
// unrelated rejection (wrong claim/HEAD/reason/run-id) that would mask
// which check actually caused `autoWaiverValid: false` below. Models an
// attacker who edited the genuine, already-artifact-trusted comment in
// place (`issues: write` permits this) rather than deleting it.
function editedGenuineComment() {
  return {
    id: 1,
    body: renderExternalCheckWaiverComment({
      agentId: 'a-different-agent-id',
      claimId: 'none',
      headSha: HEAD_SHA,
      checkSelector: 'idd-advisory-convergence',
      reason: SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
      expiresAt: '2026-07-31T20:00:00Z',
      actor: 'github-actions[bot]',
      runId: RUN_ID,
    }),
    createdAt: '2026-07-31T09:00:00Z',
    updatedAt: '2026-07-31T09:10:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

test('end-to-end: a genuine comment EDITED in place after posting is rejected even though its id and createdAt are unchanged (kurone-kito/idd-skill#2912, round 3 P1: Copilot review, PR #2914 round 2)', () => {
  withHermeticCwd(() => {
    const edited = editedGenuineComment();
    const port = createFakeProviderAdapter({
      ...baseFixture(),
      // The SAME comment id (1) as the genuine marker's own -- only the
      // body has been rewritten in place; the id and createdAt this run's
      // trusted job originally posted with are unchanged.
      comments: { [PR_NUMBER]: [edited] },
      workflowRuns: {
        [`o/r/${RUN_ID}`]: {
          path: ADVISORY_CONVERGENCE_WORKFLOW_PATH,
          head_sha: HEAD_SHA,
          head_repository: { full_name: 'o/r' },
          event: 'pull_request_target',
        },
      },
      workflowRunJobs: { [`o/r/${RUN_ID}`]: acceptedRunJobsFixture() },
      // The trusted artifact still names the digest of the ORIGINAL,
      // genuine body -- uploaded once, immediately after posting, and
      // immutable thereafter; it cannot follow a LATER edit to the live
      // comment.
      workflowRunArtifacts: {
        [`o/r/${RUN_ID}`]: {
          artifacts: [
            {
              name: `idd-self-waiver-marker-1-${digestExternalCheckWaiverMarkerBody(autoWaiverComment().body)}`,
            },
          ],
        },
      },
      changedFiles: { [PR_NUMBER]: [ADVISORY_CONVERGENCE_WORKFLOW_PATH] },
    });

    const { inputs, options } = collectFromGitHub(
      parseArgs(['--pr', String(PR_NUMBER), '--owner', 'o', '--repo', 'r']),
      () => port,
    );

    // The live candidate's own digest reflects the EDITED body -- never
    // equal to the trusted artifact's ORIGINAL digest, since the two
    // bodies now differ.
    assert.deepEqual(inputs.autoWaiverRunIdCandidates?.[RUN_ID], [
      {
        id: '1',
        createdAt: edited.createdAt,
        bodyDigest: digestExternalCheckWaiverMarkerBody(edited.body),
      },
    ]);
    assert.notEqual(
      inputs.autoWaiverRunIdCandidates?.[RUN_ID]?.[0]?.bodyDigest,
      inputs.autoWaiverRunArtifactBindings?.[RUN_ID]?.[0]?.bodyDigest,
    );

    const verdict = computeAdvisoryConvergenceVerdict(
      { ...inputs, claimEvents: [] },
      {
        ...options,
        now: '2026-07-31T09:05:00Z',
        waiverMode: 'maintainer-authorized',
        waivableSelectors: [
          { selector: 'idd-advisory-convergence', matchMode: 'exact' },
        ],
      },
    );
    assert.equal(verdict.waiver.autoWaiverValid, false);
  });
});
