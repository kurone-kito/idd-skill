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
    ghTextAsync: () => {
      throw new Error('ghTextAsync not stubbed for this test');
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

// ---------------------------------------------------------------------------
// getWorkItemForTraversalAsync (#2266): the bounded-retry (#1394) and
// no-retry-on-404/inaccessible classification discover-roadmap-graph.mts's
// pre-migration buildIssueLoader implemented locally, moved here since the
// guard bans importing withBoundedRetry into a migrated domain file.
// ---------------------------------------------------------------------------

// The load-bearing #1394 regression guard: gh itself exits cleanly but the
// captured stdout is cut short, so the failure surfaces as a JSON.parse
// throw on a RESOLVED string, not a thrown transport error. Faithful port
// of the pre-migration buildIssueLoader fixture -- parsing outside the
// retry task would let this SyntaxError escape uncaught.
test('getWorkItemForTraversalAsync retries once past a truncated-but-resolved response, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          return '{"number": 900, "tit';
        }
        return JSON.stringify({ number: 900, title: 'issue 900' });
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, {
    outcome: 'found',
    item: { number: 900, title: 'issue 900' },
  });
  assert.equal(calls, 2);
});

test('getWorkItemForTraversalAsync retries once past a thrown transient transport failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('truncated') as Error & { stderr?: string };
          error.stderr = 'unexpected end of JSON input';
          throw error;
        }
        return JSON.stringify({ number: 900, title: 'issue 900' });
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, {
    outcome: 'found',
    item: { number: 900, title: 'issue 900' },
  });
  assert.equal(calls, 2);
});

test('getWorkItemForTraversalAsync rethrows after exhausting bounded attempts on a persistent failure', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 500') as Error & { stderr?: string };
        error.stderr = 'HTTP 500 (simulated persistent failure)';
        throw error;
      },
    }),
  );
  await assert.rejects(
    () => port.getWorkItemForTraversalAsync(900),
    /HTTP 500/,
  );
  assert.equal(calls, 3);
});

test('getWorkItemForTraversalAsync resolves not-found on a 404 immediately, without retry', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 404') as Error & { stderr?: string };
        error.stderr =
          'HTTP 404: Not Found (https://api.github.com/repos/o/r/issues/900)';
        throw error;
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, { outcome: 'not-found' });
  assert.equal(calls, 1);
});

test('getWorkItemForTraversalAsync resolves inaccessible on a 403 immediately, without retry', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 403') as Error & { status?: number };
        error.status = 403;
        throw error;
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, { outcome: 'inaccessible' });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// listWorkItemSubIssueNodesAsync (#2266)
// ---------------------------------------------------------------------------

test('listWorkItemSubIssueNodesAsync retries once past a transient GraphQL failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          return '{"data": {"repository": {"issue": {"sub';
        }
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                subIssues: {
                  nodes: [{ number: 701 }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    }),
  );
  const result = await port.listWorkItemSubIssueNodesAsync(700);
  assert.deepEqual(result, [{ number: 701 }]);
  assert.equal(calls, 2);
});

test('listWorkItemSubIssueNodesAsync rethrows after exhausting bounded attempts on a persistent failure', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        throw new Error('rate limited (simulated persistent failure)');
      },
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /rate limited/,
  );
  assert.equal(calls, 3);
});

test('listWorkItemSubIssueNodesAsync throws when the subIssues connection is missing', async () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () =>
        JSON.stringify({ data: { repository: { issue: {} } } }),
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /subIssues connection missing/,
  );
});

test('listWorkItemSubIssueNodesAsync throws on a truncated page (hasNextPage, no endCursor)', async () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                subIssues: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /pagination cursor missing/,
  );
});

// ---------------------------------------------------------------------------
// listWorkItemCommentsWithRetryAsync (#2266)
// ---------------------------------------------------------------------------

test('listWorkItemCommentsWithRetryAsync retries once past a transient page-fetch failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        calls += 1;
        if (calls === 1) {
          return '[{"body": "trunca';
        }
        return JSON.stringify([
          {
            body: 'hello',
            created_at: '2026-01-01T00:00:00Z',
            user: { login: 'kurone-kito' },
          },
        ]);
      },
    }),
  );
  const result = await port.listWorkItemCommentsWithRetryAsync(900);
  assert.deepEqual(result, [
    {
      body: 'hello',
      created_at: '2026-01-01T00:00:00Z',
      user: { login: 'kurone-kito' },
    },
  ]);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// searchOpenWorkItems (#2266): discover-roadmap-graph.mts's
// buildSearchIssuesRunner, previously never directly tested (only exercised
// through live production wiring) -- net-new coverage.
// ---------------------------------------------------------------------------

test('searchOpenWorkItems builds the label-search args and returns the raw array', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return JSON.stringify([{ number: 5 }]);
      },
    }),
  );
  const result = port.searchOpenWorkItems({
    label: 'roadmap',
    fields: ['number'],
    limit: 1000,
  });
  assert.deepEqual(result, [{ number: 5 }]);
  assert.deepEqual(capturedArgs, [
    'search',
    'issues',
    '--repo',
    'o/r',
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number',
    '--label',
    'roadmap',
  ]);
});

test('searchOpenWorkItems builds the body-marker-search args', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return '[]';
      },
    }),
  );
  port.searchOpenWorkItems({
    matchBody: 'idd-skill-roadmap-id',
    fields: ['number', 'body'],
    limit: 1000,
  });
  assert.deepEqual(capturedArgs, [
    'search',
    'issues',
    '--repo',
    'o/r',
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,body',
    '--match',
    'body',
    'idd-skill-roadmap-id',
  ]);
});
