import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGithubProviderAdapter,
  type GithubProviderAdapterDeps,
} from '../src/scripts/provider-adapter-github.mts';

function fakeDeps(
  overrides: Partial<GithubProviderAdapterDeps>,
): GithubProviderAdapterDeps {
  return {
    ghText: () => {
      throw new Error('ghText not stubbed for this test');
    },
    ghApiJson: () => {
      throw new Error('ghApiJson not stubbed for this test');
    },
    resolveViewerLogin: () => {
      throw new Error('resolveViewerLogin not stubbed for this test');
    },
    ...overrides,
  } as GithubProviderAdapterDeps;
}

// ---------------------------------------------------------------------------
// listRequiredChecks (#2266): the pre-migration ghJson/
// recoverJsonFromGhFailure recovery this method replaces, verified through
// the injectable deps seam (both recoveries have zero coverage otherwise --
// an earlier draft of this method had neither and would have thrown on both
// routine cases).
// ---------------------------------------------------------------------------

test('listRequiredChecks recovers an empty set when gh reports no required checks', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & { stderr?: string };
        error.stderr = "no required checks reported on the 'main' branch";
        throw error;
      },
    }),
  );
  assert.deepEqual(port.listRequiredChecks(42), []);
});

test('listRequiredChecks recovers from a non-zero exit that still emitted JSON on stdout', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & {
          stderr?: string;
          stdout?: string;
        };
        error.stderr = 'some checks are still pending';
        error.stdout = JSON.stringify([
          { name: 'ci', state: 'IN_PROGRESS', completedAt: null },
        ]);
        throw error;
      },
    }),
  );
  assert.deepEqual(port.listRequiredChecks(42), [
    { name: 'ci', state: 'IN_PROGRESS', completedAt: null },
  ]);
});

test('listRequiredChecks rethrows when neither recovery applies', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & { stderr?: string };
        error.stderr = 'authentication required';
        throw error;
      },
    }),
  );
  assert.throws(() => port.listRequiredChecks(42), /gh failed/);
});

// ---------------------------------------------------------------------------
// listChangeRequestReviewThreads (#2266): full-walk pagination and the
// missing-endCursor fail-fast, both preserved from
// resume-route-selection.mts's pre-migration fetchReviewThreads loop.
// ---------------------------------------------------------------------------

test('listChangeRequestReviewThreads walks every page and flattens isResolved', () => {
  const pages = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: true }, { isResolved: false }],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  ];
  let call = 0;
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const page = pages[call];
        call += 1;
        return page;
      },
    }),
  );
  assert.deepEqual(port.listChangeRequestReviewThreads(7), [
    { isResolved: true },
    { isResolved: false },
    { isResolved: null },
  ]);
  assert.equal(call, 2);
});

test('listChangeRequestReviewThreads throws when hasNextPage is true but endCursor is missing', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestReviewThreads(7),
    /missing endCursor/,
  );
});

// ---------------------------------------------------------------------------
// resolveViewerLoginSafe (#2266): idd-roadmap-audit-execute.mts's own
// resolveViewerLogin/fetchViewerLogin (#1396) is deleted in favor of this
// method, now its sole consumer -- these three cases are moved, not new.
// ---------------------------------------------------------------------------

test('resolveViewerLoginSafe normalizes a successful login to lowercase', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({ ghText: () => 'Some-User' }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: 'some-user',
    viewerLoginUnavailable: false,
  });
});

test('resolveViewerLoginSafe reports unavailable when ghText throws', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        throw new Error('gh failed');
      },
    }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: '',
    viewerLoginUnavailable: true,
  });
});

test('resolveViewerLoginSafe reports unavailable on a blank-but-successful response', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({ ghText: () => '   ' }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: '',
    viewerLoginUnavailable: true,
  });
});

// ---------------------------------------------------------------------------
// getWorkItemClosingPullRequestsPage / getConnectedPullRequestEventsPage
// (#2266): idd-roadmap-audit-execute.mts's hasOpenClosingPr/
// hasOpenConnectedPr distinguished an absent issue node from an absent
// connection on an otherwise-present issue -- both funnel through the same
// optional chain here, so both are covered.
// ---------------------------------------------------------------------------

test('getWorkItemClosingPullRequestsPage returns a normal page', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ state: 'OPEN' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.deepEqual(port.getWorkItemClosingPullRequestsPage(1048, null), {
    nodes: [{ state: 'OPEN' }],
    hasNextPage: false,
    endCursor: null,
  });
});

test('getWorkItemClosingPullRequestsPage throws when the issue node is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: { issue: null } } }),
    }),
  );
  assert.throws(
    () => port.getWorkItemClosingPullRequestsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getWorkItemClosingPullRequestsPage throws when the connection itself is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: { closedByPullRequestsReferences: null },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.getWorkItemClosingPullRequestsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getConnectedPullRequestEventsPage returns a normal page', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  nodes: [{ __typename: 'ConnectedEvent' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.deepEqual(port.getConnectedPullRequestEventsPage(1048, null), {
    events: [{ __typename: 'ConnectedEvent' }],
    hasNextPage: false,
    endCursor: null,
  });
});

test('getConnectedPullRequestEventsPage throws when the issue node is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: { issue: null } } }),
    }),
  );
  assert.throws(
    () => port.getConnectedPullRequestEventsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getConnectedPullRequestEventsPage throws when the connection itself is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: { timelineItems: null },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.getConnectedPullRequestEventsPage(1048, null),
    /connection is null\/absent/,
  );
});
