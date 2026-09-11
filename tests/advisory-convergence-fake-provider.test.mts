import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ADVISORY_CONVERGENCE_WORKFLOW_PATH,
  collectFromGitHub,
  parseArgs,
  SELF_REFERENTIAL_BOOTSTRAP_AUTO_REASON,
} from '../src/scripts/advisory-convergence.mts';
import { DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES } from '../src/scripts/advisory-wait-policy.mts';
import { renderExternalCheckWaiverComment } from '../src/scripts/marker-helpers.mts';
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
      claimId: 'claim-abc',
      headSha: HEAD_SHA,
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
