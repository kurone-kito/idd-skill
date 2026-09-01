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
