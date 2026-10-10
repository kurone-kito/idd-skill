import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivationResult } from '../src/scripts/idd-activation.mts';
import {
  baseWorkflowAbsentAt,
  collectPreMergeReadiness,
  remoteNamesRepo,
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

// A passing required `lint` check run, in the shape the rollup normalizer reads.
const LINT_PASSING = [
  {
    __typename: 'CheckRun',
    name: 'lint',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    startedAt: '2026-07-31T22:00:00Z',
    completedAt: '2026-07-31T22:05:00Z',
  },
];

function contentPort(content: Record<string, unknown>): ProviderPort {
  return createFakeProviderAdapter({ repositoryContentAtRef: content });
}

function readinessPort(
  content: Record<string, unknown>,
  requiredContexts: string[] = [ADVISORY],
  rollup: unknown[] = [],
): ProviderPort {
  return createFakeProviderAdapter({
    changeRequestReadinessSnapshots: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: 'main',
        url: 'https://github.com/o/r/pull/42',
        authorLogin: 'author-user',
        reviewDecision: null,
        statusCheckRollup: rollup as never,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [],
      },
    },
    branchRules: {
      'o/r/main': [
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: requiredContexts.map((context) => ({
              context,
            })),
          },
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

// End-to-end through collectPreMergeReadiness, with the activation injected.
function collectReport(
  extraArgs: string[],
  activation: ActivationResult | null,
  content: Record<string, unknown>,
  requiredContexts: string[] = [ADVISORY],
  rollup: unknown[] = [],
) {
  return collectPreMergeReadiness(
    ['--pr', '42', '--claimless', '--owner', 'o', '--repo', 'r', ...extraArgs],
    () => readinessPort(content, requiredContexts, rollup),
    () => null,
    () => activation,
  );
}

function collectCi(
  extraArgs: string[],
  activation: ActivationResult | null,
  content: Record<string, unknown>,
): { requiredCheckNames: string[]; missingRequiredCheckNames: string[] } {
  return collectReport(extraArgs, activation, content).ci as unknown as {
    requiredCheckNames: string[];
    missingRequiredCheckNames: string[];
  };
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

test('an unavailable primary checkout keeps the advisory name required', () => {
  // primaryCheckoutRoot returns null when the worktree listing fails. That must
  // not fall back to the caller's checkout, so the check stays required.
  assert.deepEqual(
    resolveGlobalOnlyRunIgnores({
      globalOnly: true,
      activation: () => null,
      port: contentPort(READABLE_ROOT),
      owner: 'o',
      repo: 'r',
      trustedRef: 'main',
    }),
    [],
  );
});

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

test('the flag keeps the advisory check when the primary checkout is unavailable', () => {
  const ci = collectCi(['--global-only'], null, READABLE_ROOT);
  assert.deepEqual(ci.requiredCheckNames, [ADVISORY]);
  assert.deepEqual(ci.missingRequiredCheckNames, [ADVISORY]);
});

// CI-gate verdict: with a passing required lint check, the global-only run
// clears the CI gate, while each non-global-only run still holds it.
function ciGateBlocked(report: ReturnType<typeof collectReport>): boolean {
  const blockers = report.blockers as unknown as Array<{ gate: string }>;
  return blockers.some((blocker) => blocker.gate === 'ci');
}

test('with the flag and a passing lint check, the CI gate raises no blocker', () => {
  const report = collectReport(
    ['--global-only'],
    GLOBAL_ONLY,
    READABLE_ROOT,
    ['lint', ADVISORY],
    LINT_PASSING,
  );
  assert.equal(ciGateBlocked(report), false);
});

test('without the flag the same passing lint run still holds the CI gate', () => {
  const report = collectReport(
    [],
    GLOBAL_ONLY,
    READABLE_ROOT,
    ['lint', ADVISORY],
    LINT_PASSING,
  );
  assert.equal(ciGateBlocked(report), true);
});

test('the flag does not clear the CI gate when the base workflow is present', () => {
  const report = collectReport(
    ['--global-only'],
    GLOBAL_ONLY,
    {
      ...READABLE_ROOT,
      [`o/r/${WORKFLOW}@main`]: { name: 'idd-advisory-convergence.yml' },
    },
    ['lint', ADVISORY],
    LINT_PASSING,
  );
  assert.equal(ciGateBlocked(report), true);
});

test('a remote URL names the repository in its https, scp, and ssh forms', () => {
  assert.equal(
    remoteNamesRepo(
      'https://github.com/kurone-kito/idd-skill.git',
      'kurone-kito',
      'idd-skill',
    ),
    true,
  );
  assert.equal(
    remoteNamesRepo(
      'git@github.com:kurone-kito/idd-skill.git\n',
      'kurone-kito',
      'idd-skill',
    ),
    true,
  );
  assert.equal(
    remoteNamesRepo(
      'ssh://git@github.com/Kurone-Kito/IDD-Skill',
      'kurone-kito',
      'idd-skill',
    ),
    true,
  );
});

test('a remote URL for another repository or a local path does not match', () => {
  assert.equal(
    remoteNamesRepo(
      'https://github.com/someone/fork.git',
      'kurone-kito',
      'idd-skill',
    ),
    false,
  );
  assert.equal(
    remoteNamesRepo('/srv/git/idd-skill.git', 'kurone-kito', 'idd-skill'),
    false,
  );
  assert.equal(remoteNamesRepo('', 'kurone-kito', 'idd-skill'), false);
});
