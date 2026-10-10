import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivationResult } from '../src/scripts/idd-activation.mts';
import {
  baseWorkflowAbsentAt,
  collectPreMergeReadiness,
  resolveGlobalOnlyRunIgnores,
} from '../src/scripts/pre-merge-readiness.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import type { ProviderPort } from '../src/scripts/provider-port.mts';

const WORKFLOW = '.github/workflows/idd-advisory-convergence.yml';
const ADVISORY = 'idd-advisory-convergence';

const GLOBAL_ONLY: ActivationResult = {
  active: true,
  tier: 'repository-local',
  instructionsRoot: '/payload/root',
  reason: 'repository-policy-minimal-import',
} as ActivationResult;

const REPOSITORY_LOCAL: ActivationResult = {
  active: true,
  tier: 'repository-local',
  instructionsRoot: '/repo/root',
  reason: 'repository-local-instructions',
} as ActivationResult;

// The root listing is the proof that contents are readable. `o/r/@main` is
// the root path key, `o/r/<path>@main` a file key (see provider-adapter-fake).
const READABLE_ROOT = { 'o/r/@main': [{ name: 'README.md' }] };

function contentPort(content: Record<string, unknown>): ProviderPort {
  return createFakeProviderAdapter({ repositoryContentAtRef: content });
}

function readinessPort(content: Record<string, unknown>): ProviderPort {
  return createFakeProviderAdapter({
    changeRequestReadinessSnapshots: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: 'main',
        url: 'https://github.com/o/r/pull/42',
        authorLogin: 'author-user',
        reviewDecision: null,
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [],
      },
    },
    branchRules: {
      'o/r/main': [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: ADVISORY }] },
        },
      ],
    },
    branchProtection: { 'o/r/main': {} },
    reviewThreadsWithComments: { 42: [] },
    reviewsWithHeadCommitDate: {
      42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
    },
    repositoryDefaultBranch: 'main',
    repositoryContentAtRef: content,
  });
}

test('a readable root with no workflow file counts as absent', () => {
  assert.equal(
    baseWorkflowAbsentAt(contentPort(READABLE_ROOT), 'o', 'r', 'main'),
    true,
  );
});

test('an unreadable root keeps the workflow present even though the file reads null', () => {
  // A masked 403 comes back as null on every path, so a null file is not
  // proof of absence until the root listing has been read.
  assert.equal(baseWorkflowAbsentAt(contentPort({}), 'o', 'r', 'main'), false);
});

test('a present workflow file keeps the check required', () => {
  assert.equal(
    baseWorkflowAbsentAt(
      contentPort({
        ...READABLE_ROOT,
        [`o/r/${WORKFLOW}@main`]: { name: 'idd-advisory-convergence.yml' },
      }),
      'o',
      'r',
      'main',
    ),
    false,
  );
});

test('a throwing content read fails closed', () => {
  const throwing = {
    getRepositoryContentAtRef: () => {
      throw new Error('boom');
    },
  } as unknown as ProviderPort;
  assert.equal(baseWorkflowAbsentAt(throwing, 'o', 'r', 'main'), false);
});

test('the flag off returns no names and never reads the activation', () => {
  let read = false;
  const names = resolveGlobalOnlyRunIgnores({
    globalOnly: false,
    activation: () => {
      read = true;
      return GLOBAL_ONLY;
    },
    port: contentPort(READABLE_ROOT),
    owner: 'o',
    repo: 'r',
    trustedRef: 'main',
  });
  assert.deepEqual(names, []);
  assert.equal(read, false);
});

test('a global-only activation with an absent workflow ignores the advisory name', () => {
  assert.deepEqual(
    resolveGlobalOnlyRunIgnores({
      globalOnly: true,
      activation: () => GLOBAL_ONLY,
      port: contentPort(READABLE_ROOT),
      owner: 'o',
      repo: 'r',
      trustedRef: 'main',
    }),
    [ADVISORY],
  );
});

test('a repository-local activation keeps the advisory name required', () => {
  assert.deepEqual(
    resolveGlobalOnlyRunIgnores({
      globalOnly: true,
      activation: () => REPOSITORY_LOCAL,
      port: contentPort(READABLE_ROOT),
      owner: 'o',
      repo: 'r',
      trustedRef: 'main',
    }),
    [],
  );
});

// End-to-end through collectPreMergeReadiness: the flag must reach the CI
// gate's required-check list, and only when every condition holds.
function collectCi(
  extraArgs: string[],
  activation: ActivationResult,
  content: Record<string, unknown>,
): { requiredCheckNames: string[]; missingRequiredCheckNames: string[] } {
  const report = collectPreMergeReadiness(
    ['--pr', '42', '--claimless', '--owner', 'o', '--repo', 'r', ...extraArgs],
    () => readinessPort(content),
    () => null,
    () => activation,
  );
  return report.ci as unknown as {
    requiredCheckNames: string[];
    missingRequiredCheckNames: string[];
  };
}

test('without the flag the advisory check stays a required, missing check', () => {
  const ci = collectCi([], GLOBAL_ONLY, READABLE_ROOT);
  assert.deepEqual(ci.requiredCheckNames, [ADVISORY]);
  assert.deepEqual(ci.missingRequiredCheckNames, [ADVISORY]);
});

test('the flag drops the advisory check when every condition holds', () => {
  const ci = collectCi(['--global-only'], GLOBAL_ONLY, READABLE_ROOT);
  assert.deepEqual(ci.requiredCheckNames, []);
  assert.deepEqual(ci.missingRequiredCheckNames, []);
});

test('the flag keeps the advisory check when the base workflow is present', () => {
  const ci = collectCi(['--global-only'], GLOBAL_ONLY, {
    ...READABLE_ROOT,
    [`o/r/${WORKFLOW}@main`]: { name: 'idd-advisory-convergence.yml' },
  });
  assert.deepEqual(ci.requiredCheckNames, [ADVISORY]);
  assert.deepEqual(ci.missingRequiredCheckNames, [ADVISORY]);
});

test('the flag keeps the advisory check for a repository-local activation', () => {
  const ci = collectCi(['--global-only'], REPOSITORY_LOCAL, READABLE_ROOT);
  assert.deepEqual(ci.requiredCheckNames, [ADVISORY]);
  assert.deepEqual(ci.missingRequiredCheckNames, [ADVISORY]);
});
