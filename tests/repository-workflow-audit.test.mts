import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectRepositoryWorkflowViolations } from '../src/scripts/repository-workflow-audit.mts';

// Fixture roots are copies of the real inputs placed in a temporary
// directory, so each rule is exercised on a scratch tree. The enforcement
// itself never scans the real checkout.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'repository-workflow-audit.mjs');

const ROOT_CLEANUP = '.github/workflows/post-merge-cleanup.yml';
const TEMPLATE_CLEANUP =
  'idd-template/.github/workflows/post-merge-cleanup.yml';

// A mutation rewrites the first occurrence of `from` (or every occurrence when
// `all` is set). `truncateAfter` keeps the copy only up to and including that
// anchor, which removes whatever followed it.
type Mutation =
  | { from: string; to: string; all?: boolean }
  | { truncateAfter: string };

function realText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function applyMutation(text: string, mutation: Mutation): string {
  if ('truncateAfter' in mutation) {
    const end = text.indexOf(mutation.truncateAfter);
    assert.notEqual(
      end,
      -1,
      `fixture anchor not found: ${JSON.stringify(mutation.truncateAfter)}`,
    );
    return text.slice(0, end + mutation.truncateAfter.length);
  }
  assert.ok(
    text.includes(mutation.from),
    `fixture anchor not found: ${JSON.stringify(mutation.from)}`,
  );
  if (mutation.all) {
    return text.split(mutation.from).join(mutation.to);
  }
  return text.replace(mutation.from, mutation.to);
}

// Builds a scratch root from the real post-merge workflow copies. An omitted
// path leaves that copy out of the root entirely.
function postMergeRoot(
  mutations: Readonly<Record<string, Mutation>> = {},
  omit: readonly string[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), 'idd-repository-workflow-audit-'));
  for (const path of [ROOT_CLEANUP, TEMPLATE_CLEANUP]) {
    if (omit.includes(path)) {
      continue;
    }
    const mutation = mutations[path];
    const text = mutation
      ? applyMutation(realText(path), mutation)
      : realText(path);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function withRoot<T>(root: string, check: () => T): T {
  try {
    return check();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(root: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, '--check', '--root', root],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

type Expectation = { message: string } | { prefix: string };

interface PostMergeCase {
  name: string;
  path: string;
  mutation: Mutation;
  expected: readonly Expectation[];
}

// Each case mutates one copy and names the RWA004 messages it must raise, so
// every assertion of the replaced post-merge tests has a violating fixture.
// Every anchor is checked against the real file when the fixture is built.
const POST_MERGE_CASES: readonly PostMergeCase[] = [
  // Duplicate-evidence-skip guard (replaced test 14).
  {
    name: 'an EXISTING_STATUS applied check missing from the duplicate-evidence guard',
    path: ROOT_CLEANUP,
    mutation: {
      from: '[ "$EXISTING_STATUS" = "applied" ]',
      to: '[ "$EXISTING_STATUS" = "done" ]',
    },
    expected: [
      { message: "guard must still check the prior comment's EXISTING_STATUS" },
    ],
  },
  {
    name: 'a current-run STATUS applied check missing from the duplicate-evidence guard',
    path: ROOT_CLEANUP,
    mutation: {
      from: '{ [ "$STATUS" = "applied" ] || [ "$STATUS" = "clean" ]; }',
      to: '{ [ "$STATUS" = "clean" ]; }',
    },
    expected: [
      {
        message:
          "guard must also check the current run's own STATUS, not only EXISTING_STATUS",
      },
    ],
  },
  {
    name: 'a current-run STATUS clean check missing from the duplicate-evidence guard',
    path: ROOT_CLEANUP,
    mutation: {
      from: '[ "$STATUS" = "clean" ]',
      to: '[ "$STATUS" = "pending" ]',
    },
    expected: [
      {
        message:
          'guard must also check STATUS = clean, not only EXISTING_STATUS',
      },
    ],
  },
  {
    name: 'a duplicate-evidence guard renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'if [ -n "$EXISTING" ] \\',
      to: 'if [ -n "$EXISTING_RENAMED" ] \\',
    },
    expected: [{ message: 'must keep the duplicate-evidence-skip guard' }],
  },
  {
    name: 'a duplicate-evidence guard truncated before its closing "; then"',
    path: ROOT_CLEANUP,
    mutation: { truncateAfter: 'if [ -n "$EXISTING" ] \\' },
    expected: [{ message: 'guard must be closed with "; then"' }],
  },
  // Duplicate-evidence skip block (replaced test 49).
  {
    name: 'a skip block with no $STATUS reference',
    path: ROOT_CLEANUP,
    mutation: {
      from: '{ [ "$STATUS" = "applied" ] || [ "$STATUS" = "clean" ]; }',
      to: '{ true; }',
    },
    expected: [{ prefix: 'skip block must reference $STATUS at least twice' }],
  },
  {
    name: 'a duplicate-evidence skip comment block renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: '# Avoid duplicate evidence comments',
      to: '# Skip evidence comments',
    },
    expected: [
      { message: 'must keep the duplicate-evidence-skip comment block' },
    ],
  },
  {
    name: 'a BODY=$(printf anchor missing after the skip block',
    path: ROOT_CLEANUP,
    mutation: { from: 'BODY=$(printf', to: 'BODY=$(echo' },
    expected: [
      {
        message: 'must keep the BODY=$(printf anchor after the skip block',
      },
    ],
  },
  // workflow_dispatch merged-PR guard (replaced test 76).
  {
    name: 'a merged-PR guard step renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Require a merged PR for workflow_dispatch',
      to: 'name: Check the PR',
    },
    expected: [
      { message: 'must define the workflow_dispatch merged-PR guard step' },
    ],
  },
  {
    name: 'a merged-PR guard placed after the F4 cleanup step',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Require a merged PR for workflow_dispatch',
      to: 'name: Run F4 cleanup (server-side fallback)\n      - name: Require a merged PR for workflow_dispatch',
    },
    expected: [{ message: 'guard step must run before the F4 cleanup step' }],
  },
  {
    name: 'a merged-PR guard step ungated by its event',
    path: ROOT_CLEANUP,
    mutation: {
      from: "name: Require a merged PR for workflow_dispatch\n        if: github.event_name == 'workflow_dispatch'",
      to: "name: Require a merged PR for workflow_dispatch\n        if: github.event_name == 'push'",
    },
    expected: [{ message: 'guard step must be gated on workflow_dispatch' }],
  },
  {
    name: 'a PR_NUMBER guard that only logs before running gh',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'refusing to look it up."\n              exit 1',
      to: 'refusing to look it up."\n              :',
    },
    expected: [
      {
        message:
          'guard step must reject a non-numeric PR_NUMBER with an ::error:: message and exit non-zero, not merely match the glob (#2979 review, Copilot)',
      },
    ],
  },
  {
    name: 'a gh pr view lookup that uses the unsupported merged field',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'gh pr view "$PR_NUMBER" --json state --jq .state',
      to: 'gh pr view "$PR_NUMBER" --json merged --jq .merged',
    },
    expected: [
      {
        prefix:
          "guard step must look up the dispatched PR's state via a supported gh pr view JSON field",
      },
      {
        prefix:
          'guard step must not query the unsupported "merged" gh pr view JSON field',
      },
    ],
  },
  {
    name: 'a merged-state comparison removed from the guard step',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'if [ "$STATE" != "MERGED" ]; then',
      to: 'if [ "$STATE" = "" ]; then',
    },
    expected: [
      { message: "guard step must fail when the PR's state is not MERGED" },
      {
        message:
          "guard step must exit non-zero when the PR's state is not MERGED",
      },
    ],
  },
  {
    name: 'a gh pr view lookup failure that does not exit non-zero',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'refusing to run cleanup for it via workflow_dispatch."\n            exit 1',
      to: 'refusing to run cleanup for it via workflow_dispatch."\n            :',
    },
    expected: [
      {
        message:
          'guard step must exit non-zero when the gh pr view lookup itself fails',
      },
    ],
  },
  {
    name: 'a guard step with no clear ::error:: message',
    path: ROOT_CLEANUP,
    mutation: { from: '::error::', to: '::err::', all: true },
    expected: [
      { message: 'guard step must fail with a clear ::error:: message' },
    ],
  },
  // Checkout ref and checkout step (replaced test 149).
  {
    name: 'a checkout ref that is not pinned to the default branch on workflow_dispatch',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'default_branch || github.sha }}',
      to: 'default_branch || github.ref }}',
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    name: 'a checkout step renamed away',
    path: ROOT_CLEANUP,
    mutation: { from: 'uses: actions/checkout', to: 'uses: actions/cache' },
    expected: [{ message: 'must keep its actions/checkout step' }],
  },
  {
    name: 'a checkout step without its fetch-depth input',
    path: ROOT_CLEANUP,
    mutation: { from: 'fetch-depth:', to: 'fetch-depth-removed:' },
    expected: [
      {
        message: 'checkout step must keep its fetch-depth: input',
      },
    ],
  },
  // Cleanup timeout, cleanup step, and evidence step (replaced test 174).
  {
    name: 'two job-level timeouts before the cleanup step',
    path: ROOT_CLEANUP,
    mutation: {
      from: '    timeout-minutes: 10\n    steps:',
      to: '    timeout-minutes: 10\n    timeout-minutes: 10\n    steps:',
    },
    expected: [
      {
        message:
          'must set exactly one job timeout-minutes before the cleanup step',
      },
    ],
  },
  {
    name: 'a cleanup step timeout that is not below the job timeout',
    path: ROOT_CLEANUP,
    mutation: {
      from: '    timeout-minutes: 10\n    steps:',
      to: '    timeout-minutes: 8\n    steps:',
    },
    expected: [{ message: 'cleanup timeout 8 must be below job timeout 8' }],
  },
  {
    name: 'a cleanup step timeout other than 8 minutes',
    path: ROOT_CLEANUP,
    mutation: { from: 'timeout-minutes: 8', to: 'timeout-minutes: 9' },
    expected: [{ message: 'cleanup step timeout must be 8 minutes' }],
  },
  {
    name: 'a cleanup step without any step-level timeout',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'timeout-minutes: 8',
      to: 'timeout-minutes-removed: 8',
    },
    expected: [{ message: 'cleanup step must set timeout-minutes' }],
  },
  {
    name: 'a cleanup step renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Run F4 cleanup (server-side fallback)',
      to: 'name: Run cleanup',
    },
    expected: [
      { message: 'must still define the F4 cleanup step' },
      { message: 'must define the cleanup step' },
    ],
  },
  {
    name: 'a template cleanup step without the profile and manager guard',
    path: TEMPLATE_CLEANUP,
    mutation: {
      from: "if: steps.profile.outputs.profile != 'instructions-only' && steps.manager.outputs.manager != 'ambiguous'",
      to: 'if: true',
    },
    expected: [
      { message: 'cleanup step must keep the profile/manager skip guard' },
    ],
  },
  {
    name: 'an evidence step renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Post cleanup evidence comment',
      to: 'name: Post comment',
    },
    expected: [{ message: 'must define the evidence step after cleanup' }],
  },
  {
    name: 'an evidence step that does not run on always()',
    path: ROOT_CLEANUP,
    mutation: {
      from: "if: always() && steps.cleanup.outcome != 'skipped'",
      to: 'if: always()',
    },
    expected: [
      {
        message:
          'evidence step must run on always() unless cleanup was skipped',
      },
    ],
  },
  {
    name: 'an evidence step without a run script',
    path: ROOT_CLEANUP,
    mutation: { from: 'run: |', to: 'run: >', all: true },
    expected: [{ message: 'evidence step must have a run script' }],
  },
  {
    name: 'an evidence PR_NUMBER without the workflow_dispatch input fallback',
    path: ROOT_CLEANUP,
    mutation: {
      from: `PR_NUMBER: \${{ steps.cleanup.outputs.pr_number || github.event.pull_request.number || github.event.inputs.pr_number }}`,
      to: `PR_NUMBER: \${{ steps.cleanup.outputs.pr_number || github.event.pull_request.number }}`,
    },
    expected: [
      { message: 'evidence PR_NUMBER must fall back to the event expression' },
    ],
  },
  {
    name: 'an evidence step that calls gh api before the empty PR_NUMBER exit',
    path: ROOT_CLEANUP,
    mutation: {
      from: '          if [ -z "$PR_NUMBER" ]; then\n            echo "::notice::No PR number is available',
      to: '          if [ -z "$PR_NUMBER_EMPTY" ]; then\n            echo "::notice::No PR number is available',
    },
    expected: [{ message: 'empty PR_NUMBER exit must precede gh api' }],
  },
  {
    name: 'an empty-status branch that never assigns STATUS=timeout',
    path: ROOT_CLEANUP,
    mutation: { from: 'STATUS="timeout"', to: 'STATUS="unknown"' },
    expected: [
      {
        message:
          'STATUS=timeout must be assigned inside the empty-status branch, before the duplicate-evidence skip',
      },
    ],
  },
  {
    name: 'an empty-status branch missing its zero-count tokens',
    path: ROOT_CLEANUP,
    mutation: {
      from: '            APPLIED=0\n            FAILED=0\n            SKIPPED=0\n            BLOCKED=0\n            RETRY_ATTEMPTS=0\n            RETRY_BOUND_EXHAUSTED=false\n            NOTES_ROW="| Notes',
      to: '            NOTES_ROW="| Notes',
    },
    expected: [
      {
        message:
          'empty-status branch must include APPLIED=0 before the skip guard',
      },
      {
        message:
          'empty-status branch must include FAILED=0 before the skip guard',
      },
      {
        message:
          'empty-status branch must include SKIPPED=0 before the skip guard',
      },
      {
        message:
          'empty-status branch must include BLOCKED=0 before the skip guard',
      },
      {
        message:
          'empty-status branch must include RETRY_ATTEMPTS=0 before the skip guard',
      },
      {
        message:
          'empty-status branch must include RETRY_BOUND_EXHAUSTED=false before the skip guard',
      },
    ],
  },
];

test('RWA004 accepts the real post-merge cleanup workflow copies', () => {
  const root = postMergeRoot();
  withRoot(root, () => {
    assert.deepEqual(collectRepositoryWorkflowViolations(root), []);
  });
});

test('RWA004 CLI exits zero on a clean scratch root', () => {
  const root = postMergeRoot();
  withRoot(root, () => {
    const result = runCli(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no violations/);
  });
});

test('RWA004 CLI reports the rule ID and relative path of a violation', () => {
  const root = postMergeRoot({
    [ROOT_CLEANUP]: {
      from: '[ "$STATUS" = "clean" ]',
      to: '[ "$STATUS" = "pending" ]',
    },
  });
  withRoot(root, () => {
    const result = runCli(root);
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(
        `repository-workflow-audit/RWA004: ${ROOT_CLEANUP}: guard must also check STATUS = clean`,
      ),
      result.stderr,
    );
  });
});

for (const scenario of POST_MERGE_CASES) {
  test(`RWA004 flags ${scenario.name}`, () => {
    const root = postMergeRoot({ [scenario.path]: scenario.mutation });
    withRoot(root, () => {
      const violations = collectRepositoryWorkflowViolations(root);
      for (const expectation of scenario.expected) {
        const found = violations.some(
          (violation) =>
            violation.ruleId === 'RWA004' &&
            violation.path === scenario.path &&
            ('prefix' in expectation
              ? violation.message.startsWith(expectation.prefix)
              : violation.message === expectation.message),
        );
        assert.ok(
          found,
          `expected ${JSON.stringify(expectation)} in ${JSON.stringify(violations)}`,
        );
      }
    });
  });
}

test('RWA004 reports a missing workflow copy as an inspection failure, never a clean result', () => {
  const root = postMergeRoot({}, [TEMPLATE_CLEANUP]);
  withRoot(root, () => {
    assert.deepEqual(
      collectRepositoryWorkflowViolations(root).map(
        ({ ruleId, path, message }) => ({ ruleId, path, message }),
      ),
      [
        {
          ruleId: 'RWA004',
          path: TEMPLATE_CLEANUP,
          message: 'required input is missing or unreadable',
        },
      ],
    );
    assert.equal(runCli(root).status, 1);
  });
});
