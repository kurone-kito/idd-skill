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
const ROOT_ADVISORY = '.github/workflows/idd-advisory-convergence.yml';
const TEMPLATE_ADVISORY =
  'idd-template/.github/workflows/idd-advisory-convergence.yml';
const TEMPLATE_COMMENT =
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml';
const SELF_WAIVER_CONSTANTS = 'src/scripts/advisory-convergence.mts';

// Every input any rule reads. A fixture root always carries all of them, so a
// case that targets one rule never trips another rule's missing-input check.
const FULL_INPUTS = [
  ROOT_CLEANUP,
  TEMPLATE_CLEANUP,
  ROOT_ADVISORY,
  TEMPLATE_ADVISORY,
  TEMPLATE_COMMENT,
  SELF_WAIVER_CONSTANTS,
] as const;

// A mutation rewrites one copy. `from`/`to` replace the first occurrence, or
// every occurrence when `all` is set. `truncateAfter` keeps the copy only up
// to and including its anchor. `replaceWith` substitutes the whole copy.
type Mutation =
  | { from: string; to: string; all?: boolean }
  | { truncateAfter: string }
  | { replaceWith: string };

function realText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function applyMutation(text: string, mutation: Mutation): string {
  if ('replaceWith' in mutation) {
    return mutation.replaceWith;
  }
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

// Builds a scratch root from the real workflow copies. An omitted path is left
// out of the root entirely, so the rule that reads it reports a missing input.
function fixtureRoot(
  mutations: Readonly<Record<string, Mutation>> = {},
  omit: readonly string[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), 'idd-repository-workflow-audit-'));
  for (const path of FULL_INPUTS) {
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

type Expectation =
  | { message: string }
  | { prefix: string }
  | { includes: string };

function matches(message: string, expectation: Expectation): boolean {
  if ('prefix' in expectation) {
    return message.startsWith(expectation.prefix);
  }
  if ('includes' in expectation) {
    return message.includes(expectation.includes);
  }
  return message === expectation.message;
}

interface RuleCase {
  ruleId: 'RWA004' | 'RWA006' | 'RWA007';
  name: string;
  path: string;
  // The path the rule reports against, when it differs from the copy that
  // the case mutates (a whole-set count is reported against the directory).
  violationPath?: string;
  mutation: Mutation;
  expected: readonly Expectation[];
}

// Each case mutates one copy and names the messages its rule must raise, so
// every assertion of the replaced tests has a violating fixture. Every anchor
// is checked against the real file when the fixture is built.
const RULE_CASES: readonly RuleCase[] = [
  // RWA004: duplicate-evidence-skip guard (replaced post-merge test 14).
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'a duplicate-evidence guard renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'if [ -n "$EXISTING" ] \\',
      to: 'if [ -n "$EXISTING_RENAMED" ] \\',
    },
    expected: [{ message: 'must keep the duplicate-evidence-skip guard' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a duplicate-evidence guard truncated before its closing "; then"',
    path: ROOT_CLEANUP,
    mutation: { truncateAfter: 'if [ -n "$EXISTING" ] \\' },
    expected: [{ message: 'guard must be closed with "; then"' }],
  },
  // RWA004: duplicate-evidence skip block (replaced post-merge test 49).
  {
    ruleId: 'RWA004',
    name: 'a skip block with no $STATUS reference',
    path: ROOT_CLEANUP,
    mutation: {
      from: '{ [ "$STATUS" = "applied" ] || [ "$STATUS" = "clean" ]; }',
      to: '{ true; }',
    },
    expected: [{ prefix: 'skip block must reference $STATUS at least twice' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'a BODY=$(printf anchor missing after the skip block',
    path: ROOT_CLEANUP,
    mutation: { from: 'BODY=$(printf', to: 'BODY=$(echo' },
    expected: [
      { message: 'must keep the BODY=$(printf anchor after the skip block' },
    ],
  },
  // RWA004: workflow_dispatch merged-PR guard (replaced post-merge test 76).
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'a merged-PR guard placed after the F4 cleanup step',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Require a merged PR for workflow_dispatch',
      to: 'name: Run F4 cleanup (server-side fallback)\n      - name: Require a merged PR for workflow_dispatch',
    },
    expected: [{ message: 'guard step must run before the F4 cleanup step' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a merged-PR guard step ungated by its event',
    path: ROOT_CLEANUP,
    mutation: {
      from: "name: Require a merged PR for workflow_dispatch\n        if: github.event_name == 'workflow_dispatch'",
      to: "name: Require a merged PR for workflow_dispatch\n        if: github.event_name == 'push'",
    },
    expected: [{ message: 'guard step must be gated on workflow_dispatch' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'a guard step with no clear ::error:: message',
    path: ROOT_CLEANUP,
    mutation: { from: '::error::', to: '::err::', all: true },
    expected: [
      { message: 'guard step must fail with a clear ::error:: message' },
    ],
  },
  // RWA004: checkout ref and checkout step (replaced post-merge test 149).
  {
    ruleId: 'RWA004',
    name: 'a checkout ref that is not pinned to the default branch on workflow_dispatch',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'default_branch || github.sha }}',
      to: 'default_branch || github.ref }}',
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a checkout step renamed away',
    path: ROOT_CLEANUP,
    mutation: { from: 'uses: actions/checkout', to: 'uses: actions/cache' },
    expected: [{ message: 'must keep its actions/checkout step' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a checkout step without its fetch-depth input',
    path: ROOT_CLEANUP,
    mutation: { from: 'fetch-depth:', to: 'fetch-depth-removed:' },
    expected: [{ message: 'checkout step must keep its fetch-depth: input' }],
  },
  // RWA004: cleanup timeout, cleanup step, and evidence step (replaced test 174).
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'a cleanup step timeout that is not below the job timeout',
    path: ROOT_CLEANUP,
    mutation: {
      from: '    timeout-minutes: 10\n    steps:',
      to: '    timeout-minutes: 8\n    steps:',
    },
    expected: [{ message: 'cleanup timeout 8 must be below job timeout 8' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup step timeout other than 8 minutes',
    path: ROOT_CLEANUP,
    mutation: { from: 'timeout-minutes: 8', to: 'timeout-minutes: 9' },
    expected: [{ message: 'cleanup step timeout must be 8 minutes' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup step without any step-level timeout',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'timeout-minutes: 8',
      to: 'timeout-minutes-removed: 8',
    },
    expected: [{ message: 'cleanup step must set timeout-minutes' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'an evidence step renamed away',
    path: ROOT_CLEANUP,
    mutation: {
      from: 'name: Post cleanup evidence comment',
      to: 'name: Post comment',
    },
    expected: [{ message: 'must define the evidence step after cleanup' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'an evidence step without a run script',
    path: ROOT_CLEANUP,
    mutation: { from: 'run: |', to: 'run: >', all: true },
    expected: [{ message: 'evidence step must have a run script' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
    name: 'an evidence step that calls gh api before the empty PR_NUMBER exit',
    path: ROOT_CLEANUP,
    mutation: {
      from: '          if [ -z "$PR_NUMBER" ]; then\n            echo "::notice::No PR number is available',
      to: '          if [ -z "$PR_NUMBER_EMPTY" ]; then\n            echo "::notice::No PR number is available',
    },
    expected: [{ message: 'empty PR_NUMBER exit must precede gh api' }],
  },
  {
    ruleId: 'RWA004',
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
    ruleId: 'RWA004',
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
  // RWA006: self-waiver constants across both advisory-convergence copies.
  {
    ruleId: 'RWA006',
    name: 'a self-waiver job id renamed in the root copy',
    path: ROOT_ADVISORY,
    mutation: {
      from: 'idd-advisory-convergence-self-waiver:',
      to: 'idd-advisory-convergence-self-waiver-renamed:',
      all: true,
    },
    expected: [
      { message: 'no longer declares the expected self-waiver job id' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a post-step name renamed in the template copy',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: 'name: Post the self-referential-bootstrap-auto waiver',
      to: 'name: Post the waiver',
      all: true,
    },
    expected: [{ message: 'no longer declares the expected post-step name' }],
  },
  {
    ruleId: 'RWA006',
    name: 'an artifact-name prefix renamed in the root copy',
    path: ROOT_ADVISORY,
    mutation: {
      from: 'idd-self-waiver-marker-',
      to: 'idd-waiver-marker-',
      all: true,
    },
    expected: [
      { message: 'no longer declares the expected artifact-name prefix' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a self-waiver constant declaration that no longer parses',
    path: SELF_WAIVER_CONSTANTS,
    mutation: {
      from: 'export const SELF_REFERENTIAL_WAIVER_JOB_ID =',
      to: 'export const SELF_REFERENTIAL_WAIVER_JOB_ID_RENAMED =',
    },
    expected: [
      {
        message:
          'could not read SELF_REFERENTIAL_WAIVER_JOB_ID from src/scripts/advisory-convergence.mts',
      },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a self-waiver job id constant changed without its workflow copies',
    path: SELF_WAIVER_CONSTANTS,
    violationPath: ROOT_ADVISORY,
    mutation: {
      from: "export const SELF_REFERENTIAL_WAIVER_JOB_ID =\n  'idd-advisory-convergence-self-waiver';",
      to: "export const SELF_REFERENTIAL_WAIVER_JOB_ID =\n  'idd-self-waiver-renamed';",
    },
    expected: [
      { message: 'no longer declares the expected self-waiver job id' },
    ],
  },
  // RWA007: template detect-package-manager and setup-node contracts.
  {
    ruleId: 'RWA007',
    name: 'a Detect package manager step that drifted in one copy',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: '      - name: Detect package manager\n        id: manager',
      to: '      - name: Detect package manager\n        id: manager-renamed',
    },
    expected: [
      {
        message:
          '"Detect package manager" step body drifted from idd-template/.github/workflows/post-merge-cleanup.yml',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'a Detect package manager step missing from one copy',
    path: TEMPLATE_CLEANUP,
    mutation: {
      from: 'name: Detect package manager',
      to: 'name: Detect manager',
    },
    expected: [{ message: 'expected to find a "Detect package manager" step' }],
  },
  {
    ruleId: 'RWA007',
    name: 'a Detect package manager step truncated before its step boundary',
    path: TEMPLATE_CLEANUP,
    mutation: { truncateAfter: '      - name: Detect package manager\n' },
    expected: [
      {
        message: 'expected a step boundary after "Detect package manager"',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'an actions/setup-node step without check-latest',
    path: TEMPLATE_CLEANUP,
    mutation: { from: 'check-latest: true', to: 'check-latest: false' },
    expected: [{ includes: 'is missing `check-latest: true`' }],
  },
  {
    ruleId: 'RWA007',
    name: 'an actions/setup-node step not followed by the Node.js floor assertion',
    path: TEMPLATE_CLEANUP,
    mutation: {
      from: 'name: Assert Node.js floor',
      to: 'name: Assert node',
    },
    expected: [{ includes: 'must be named "Assert Node.js floor"' }],
  },
  {
    ruleId: 'RWA007',
    name: 'a Node.js floor assertion whose if: differs from its setup-node step',
    path: TEMPLATE_CLEANUP,
    mutation: {
      from: "      - name: Assert Node.js floor\n        if: steps.profile.outputs.profile != 'instructions-only'",
      to: '      - name: Assert Node.js floor\n        if: true',
    },
    expected: [{ includes: "must equal its actions/setup-node step's if:" }],
  },
  {
    ruleId: 'RWA007',
    name: 'an actions/setup-node step with no following step',
    path: TEMPLATE_CLEANUP,
    mutation: { truncateAfter: 'uses: actions/setup-node@v4' },
    expected: [
      {
        includes: 'expected a step after the actions/setup-node step at offset',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'an actions/setup-node step with no enclosing step bullet',
    path: TEMPLATE_CLEANUP,
    mutation: {
      replaceWith:
        'jobs:\n  check:\n    steps:\n      uses: actions/setup-node@v4\n',
    },
    expected: [
      {
        includes:
          'could not find the step bullet enclosing the actions/setup-node use',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'an actions/setup-node step removed from the total count',
    path: TEMPLATE_ADVISORY,
    violationPath: 'idd-template/.github/workflows',
    mutation: {
      from: 'uses: actions/setup-node@',
      to: 'uses: actions/setup-node-removed@',
    },
    expected: [
      {
        message:
          'expected exactly 4 actions/setup-node steps across the three idd-template workflow files (idd-skill#3240); update this count alongside a deliberate step-count change',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'a template comment workflow whose setup-node floor is removed',
    path: TEMPLATE_COMMENT,
    mutation: {
      from: 'name: Assert Node.js floor',
      to: 'name: Assert node',
    },
    expected: [{ includes: 'must be named "Assert Node.js floor"' }],
  },
];

test('RWA004, RWA006, and RWA007 accept the real workflow copies', () => {
  const root = fixtureRoot();
  withRoot(root, () => {
    assert.deepEqual(collectRepositoryWorkflowViolations(root), []);
  });
});

test('the workflow audit CLI exits zero on a clean scratch root', () => {
  const root = fixtureRoot();
  withRoot(root, () => {
    const result = runCli(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no violations/);
  });
});

test('the workflow audit CLI reports the rule ID and relative path of a violation', () => {
  const root = fixtureRoot({
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

for (const scenario of RULE_CASES) {
  test(`${scenario.ruleId} flags ${scenario.name}`, () => {
    const root = fixtureRoot({ [scenario.path]: scenario.mutation });
    withRoot(root, () => {
      const violations = collectRepositoryWorkflowViolations(root);
      for (const expectation of scenario.expected) {
        const found = violations.some(
          (violation) =>
            violation.ruleId === scenario.ruleId &&
            violation.path === (scenario.violationPath ?? scenario.path) &&
            matches(violation.message, expectation),
        );
        assert.ok(
          found,
          `expected ${JSON.stringify(expectation)} in ${JSON.stringify(violations)}`,
        );
      }
    });
  });
}

test('a missing workflow copy is an inspection failure for every rule that reads it, never a clean result', () => {
  const root = fixtureRoot({}, [TEMPLATE_CLEANUP]);
  withRoot(root, () => {
    // The template cleanup copy is an input of both RWA004 and RWA007.
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
        {
          ruleId: 'RWA007',
          path: TEMPLATE_CLEANUP,
          message: 'required input is missing or unreadable',
        },
      ],
    );
    assert.equal(runCli(root).status, 1);
  });
});

test('RWA006 reports a missing advisory-convergence copy as an inspection failure', () => {
  const root = fixtureRoot({}, [ROOT_ADVISORY]);
  withRoot(root, () => {
    assert.deepEqual(
      collectRepositoryWorkflowViolations(root).map(
        ({ ruleId, path, message }) => ({ ruleId, path, message }),
      ),
      [
        {
          ruleId: 'RWA006',
          path: ROOT_ADVISORY,
          message: 'required input is missing or unreadable',
        },
      ],
    );
  });
});
