import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectFromGitHub,
  parseArgs,
} from '../src/scripts/advisory-convergence.mts';
import { DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES } from '../src/scripts/advisory-wait-policy.mts';
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
