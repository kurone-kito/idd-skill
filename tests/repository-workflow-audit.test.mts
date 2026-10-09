import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const ROOT_COMMENT = '.github/workflows/idd-advisory-convergence-comment.yml';
const ROOT_PROBE = '.github/workflows/idd-advisory-convergence-probe.yml';
const TEMPLATE_PROBE =
  'idd-template/.github/workflows/idd-advisory-convergence-probe.yml';
const ONBOARDING_GUIDE = 'idd-template/docs/onboarding/optional-host-setup.md';
const EXTERNAL_CHECK_WAIVER = 'src/scripts/external-check-waiver.mts';

// The root workflow directory is an input of the pull_request concurrency
// inventory, so a fixture root carries every root workflow file.
const ROOT_WORKFLOWS = readdirSync(join(REPO_ROOT, '.github', 'workflows'))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => `.github/workflows/${name}`);

// Every input any rule reads. A fixture root always carries all of them, so a
// case that targets one rule never trips another rule's missing-input check.
const FULL_INPUTS: readonly string[] = [
  ...new Set([
    ...ROOT_WORKFLOWS,
    ROOT_CLEANUP,
    TEMPLATE_CLEANUP,
    ROOT_ADVISORY,
    TEMPLATE_ADVISORY,
    TEMPLATE_COMMENT,
    SELF_WAIVER_CONSTANTS,
    TEMPLATE_PROBE,
    ONBOARDING_GUIDE,
    EXTERNAL_CHECK_WAIVER,
  ]),
];

// A mutation rewrites one copy. `from`/`to` replace the first occurrence, or
// every occurrence when `all` is set. `truncateAfter` keeps the copy only up
// to and including its anchor. `replaceWith` substitutes the whole copy, and
// `transform` computes the new copy from the real one (for moves and inserts
// that a plain replacement cannot express).
type Mutation =
  | { from: string; to: string; all?: boolean }
  | { truncateAfter: string }
  | { replaceWith: string }
  | { transform: (text: string) => string };

function realText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

// A transform that moves or inserts text must find its anchors. A missing
// anchor either makes a replacement a no-op or moves an insertion to the
// wrong offset, so the helper fails the test instead.
function anchored(text: string, anchor: string): number {
  const index = text.indexOf(anchor);
  assert.notEqual(
    index,
    -1,
    `fixture anchor not found: ${JSON.stringify(anchor)}`,
  );
  return index;
}

function applyMutation(text: string, mutation: Mutation): string {
  if ('replaceWith' in mutation) {
    return mutation.replaceWith;
  }
  if ('transform' in mutation) {
    return mutation.transform(text);
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
  try {
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
  } catch (error) {
    // A mutation that throws must not leave its scratch root behind. A cleanup
    // failure must not replace the mutation error the test should report.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignored: the mutation error is the one worth reporting.
    }
    throw error;
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
  ruleId:
    | 'RWA001'
    | 'RWA002'
    | 'RWA003'
    | 'RWA004'
    | 'RWA005'
    | 'RWA006'
    | 'RWA007';
  name: string;
  path: string;
  // The path the rule reports against, when it differs from the copy that
  // the case mutates (a whole-set count is reported against the directory).
  violationPath?: string;
  // Without a mutation the case checks the root as built, which is how a
  // missing-input case drops inputs through `omit` instead.
  mutation?: Mutation;
  omit?: readonly string[];
  expected: readonly Expectation[];
}

// Removes the first checkout step of one job and leaves the rest of the copy as it
// is, so a required job that loses its own checkout is the only change.
function removeJobCheckout(text: string, jobId: string): string {
  const job = anchored(text, `\n  ${jobId}:\n`);
  const step = text.indexOf('\n      - uses: actions/checkout@', job);
  assert.notEqual(step, -1, `fixture anchor not found: checkout in ${jobId}`);
  const end = text.indexOf('\n      - ', step + 1);
  assert.notEqual(
    end,
    -1,
    `fixture anchor not found: step after ${jobId}'s checkout`,
  );
  return text.slice(0, step) + text.slice(end);
}

// Replaces one line inside a single named step, so a fixture cannot touch another step.
function replaceInStep(
  text: string,
  stepName: string,
  from: string,
  to: string,
): string {
  const name = `      - name: ${stepName}\n`;
  const start = anchored(text, name);
  const next = text.indexOf('\n      - ', start + name.length);
  const end = next === -1 ? text.length : next;
  const step = text.slice(start, end);
  assert.ok(
    step.includes(from),
    `fixture anchor not found in ${stepName}: ${JSON.stringify(from)}`,
  );
  return text.slice(0, start) + step.split(from).join(to) + text.slice(end);
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
    name: 'a merged-PR guard step without its event condition',
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
  // RWA001: required status checks (replaced actions-usage test 1477).
  {
    ruleId: 'RWA001',
    name: 'a required check that stops triggering on pull_request',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '\n  pull_request:\n',
      to: '\n  pull_request_renamed:\n',
    },
    expected: [{ message: 'must trigger on pull_request' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check whose trigger gains a path filter',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '\n  pull_request:\n',
      to: '\n  pull_request:\n    paths:\n      - "src/**"\n',
    },
    expected: [{ prefix: 'pull_request trigger must not gain a path filter' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check whose job id changes',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '\n  lint:\n    runs-on: ubuntu-latest',
      to: '\n  lint-renamed:\n    runs-on: ubuntu-latest',
    },
    expected: [
      { message: 'must keep required job id lint' },
      { message: 'job lint not found' },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check job that declares its own display name',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '\n  lint:\n    runs-on: ubuntu-latest',
      to: '\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest',
    },
    expected: [{ prefix: 'job lint must not declare its own display name' }],
  },
  {
    ruleId: 'RWA001',
    name: 'the advisory check trigger renamed away from pull_request_target',
    path: ROOT_ADVISORY,
    mutation: {
      from: '\n  pull_request_target:\n',
      to: '\n  pull_request_renamed:\n',
    },
    expected: [{ message: 'must trigger on pull_request_target' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check job id written as a quoted YAML key',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '\n  lint:\n    runs-on: ubuntu-latest',
      to: "\n  'lint':\n    runs-on: ubuntu-latest",
    },
    expected: [
      { message: 'must keep required job id lint' },
      { message: 'job lint not found' },
    ],
  },
  // RWA002: pull_request concurrency (replaced actions-usage test 1547).
  {
    ruleId: 'RWA002',
    name: 'a pull_request inventory below six workflows',
    path: '.github/workflows/lint.yml',
    violationPath: '.github/workflows',
    omit: ROOT_WORKFLOWS.filter(
      (path) => path !== '.github/workflows/lint.yml',
    ),
    expected: [
      { prefix: 'expected >= 6 pull_request-triggered workflows, found' },
    ],
  },
  {
    ruleId: 'RWA002',
    name: 'a pull_request workflow without an effective cancel-in-progress',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  cancel-in-progress: true',
      to: '  cancel-in-progress: false',
    },
    expected: [
      {
        prefix:
          'must declare an effective cancel-in-progress concurrency setting',
      },
    ],
  },
  {
    ruleId: 'RWA002',
    name: 'a reusable-workflow caller that declares a sibling job',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: {
      from: '\njobs:\n',
      to: '\njobs:\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sibling\n',
    },
    expected: [
      {
        prefix:
          'calls pnpm-boundary.yml as a reusable workflow, but declares 2 jobs',
      },
    ],
  },
  {
    ruleId: 'RWA002',
    name: 'a reusable-workflow callee that declares no effective cancel-in-progress',
    path: '.github/workflows/pnpm-boundary.yml',
    violationPath: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: {
      from: `cancel-in-progress: \${{ startsWith(github.ref, 'refs/pull/') }}`,
      to: 'cancel-in-progress: false',
    },
    expected: [
      {
        message:
          'calls pnpm-boundary.yml as a reusable workflow, but pnpm-boundary.yml declares no effective cancel-in-progress for it to inherit',
      },
    ],
  },
  // RWA003: runner contracts (replaced actions-usage tests 1612, 1624, 1638, 1655).
  {
    ruleId: 'RWA003',
    name: 'a pnpm-boundary default-lane runner fallback that is not ubuntu-latest',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: {
      from: "inputs.runner || 'ubuntu-latest'",
      to: "inputs.runner || 'ubuntu-slim'",
    },
    expected: [
      {
        prefix:
          "the pnpm-boundary job's runs-on fallback must be ubuntu-latest",
      },
    ],
  },
  {
    ruleId: 'RWA003',
    name: 'a Node 22 floor lane without its ubuntu-latest runner input',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: {
      from: '      runner: ubuntu-latest',
      to: '      runner: ubuntu-slim',
    },
    expected: [
      {
        prefix: "the job's with: block must pass runner: ubuntu-latest",
      },
    ],
  },
  {
    ruleId: 'RWA003',
    name: 'a declared runner default other than ubuntu-slim',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: {
      from: '        default: ubuntu-slim',
      to: '        default: ubuntu-latest',
    },
    expected: [
      {
        message:
          'inputs.runner.default must stay ubuntu-slim -- the documented default for downstream workflow_call callers in docs/customization.md (#3665)',
      },
    ],
  },
  {
    ruleId: 'RWA003',
    name: 'a lint job moved to ubuntu-slim',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '    runs-on: ubuntu-latest',
      to: '    runs-on: ubuntu-slim',
    },
    expected: [
      {
        prefix:
          'the lint job must use ubuntu-latest; ubuntu-slim has a hard 15-minute cap',
      },
    ],
  },
  // RWA005: advisory-convergence workflow contracts (replaced
  // the static tests of the advisory-convergence comment workflow).
  {
    ruleId: 'RWA005',
    name: 'a required gate job id renamed away',
    path: ROOT_ADVISORY,
    mutation: {
      from: '\n  idd-advisory-convergence:\n',
      to: '\n  idd-advisory-convergence-x:\n',
    },
    expected: [
      { message: 'must keep job id idd-advisory-convergence' },
      { message: 'must keep the required gate job' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate whose manual re-check no longer runs it',
    path: ROOT_ADVISORY,
    mutation: {
      from: `    if: \${{ !cancelled() }}`,
      to: `    if: \${{ always() }}`,
    },
    expected: [
      { message: 'manual re-checks must still run the required gate' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe workflow renamed away',
    path: ROOT_PROBE,
    mutation: {
      from: 'name: IDD self-waiver token-scope probe',
      to: 'name: IDD probe',
    },
    expected: [{ message: 'probe must keep its workflow name' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that triggers on something other than issue_comment',
    path: TEMPLATE_PROBE,
    mutation: { from: '  issue_comment:', to: '  pull_request:' },
    expected: [
      { message: 'probe must use only issue_comment' },
      {
        message: 'probe must not expose another trigger or selected ref',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that also handles edited comments',
    path: ROOT_PROBE,
    mutation: { from: 'types: [created]', to: 'types: [edited]' },
    expected: [
      {
        message: 'probe must run only for newly created comments',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that also triggers on issue_comment',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request_target:\n  issue_comment:',
    },
    expected: [{ message: 'on: must not include issue_comment' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that keeps the transitional pull_request trigger',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request:\n  pull_request_target:',
    },
    expected: [
      {
        message:
          'on: must no longer include the transitional pull_request trigger',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that drops pull_request_target',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request_target_removed:',
    },
    expected: [
      { message: 'on: must still include pull_request_target' },
      { message: 'on: must include pull_request_target' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that adds pull_request_review',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request_target:\n  pull_request_review:',
    },
    expected: [
      {
        message:
          'on: must not include pull_request_review (moved to the companion workflow)',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that adds pull_request_review_comment',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request_target:\n  pull_request_review_comment:',
    },
    expected: [{ message: 'on: must not include pull_request_review_comment' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate checkout that is not pinned to main',
    path: ROOT_ADVISORY,
    mutation: { from: 'ref: main', to: 'ref: feature', all: true },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a self-waiver job that loses pull-requests: write',
    path: ROOT_ADVISORY,
    mutation: {
      from: 'pull-requests: write',
      to: 'pull-requests: read',
      all: true,
    },
    expected: [{ includes: 'must keep pull-requests: write' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a self-waiver job that loses checks: read',
    path: ROOT_ADVISORY,
    mutation: { from: 'checks: read', to: 'checks: none', all: true },
    expected: [
      {
        includes:
          'idd-advisory-convergence-self-waiver job must keep checks: read',
      },
      { includes: 'idd-advisory-convergence job must keep checks: read' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a self-waiver job that loses statuses: read',
    path: ROOT_ADVISORY,
    mutation: { from: 'statuses: read', to: 'statuses: none', all: true },
    expected: [
      {
        includes:
          'idd-advisory-convergence-self-waiver job must keep statuses: read',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a waiver-invoking job that loses actions: read',
    path: TEMPLATE_ADVISORY,
    mutation: { from: 'actions: read', to: 'actions: none', all: true },
    expected: [{ includes: 'must keep actions: read' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that admits any author association',
    path: TEMPLATE_PROBE,
    mutation: {
      from: "github.event.comment.author_association == 'COLLABORATOR'",
      to: "github.event.comment.author_association == 'NONE'",
    },
    expected: [
      {
        message:
          'job must require a PR, the exact command, and a trusted author association',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe whose PR number comes from a caller input',
    path: ROOT_PROBE,
    mutation: {
      from: `PR_NUMBER: \${{ github.event.issue.number }}`,
      to: `PR_NUMBER: \${{ inputs.pr }}`,
    },
    expected: [
      {
        message: 'PR number must come only from the issue_comment event',
      },
      {
        message:
          'probe must not accept caller-selected inputs or execute checked-out content',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template probe runner without the CI_RUNNER_LABEL fallback',
    path: TEMPLATE_PROBE,
    mutation: {
      from: "vars.CI_RUNNER_LABEL || 'ubuntu-slim'",
      to: "vars.CI_RUNNER_LABEL || 'ubuntu-latest'",
    },
    expected: [
      {
        message:
          'runner must keep the CI_RUNNER_LABEL and ubuntu-slim fallback',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a root probe runner that is not ubuntu-slim',
    path: ROOT_PROBE,
    mutation: {
      from: 'runs-on: ubuntu-slim',
      to: 'runs-on: ubuntu-latest',
    },
    expected: [{ message: 'probe runner must be ubuntu-slim' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that reads the comment body without an environment variable',
    path: ROOT_PROBE,
    mutation: {
      from: `COMMENT_BODY: \${{ github.event.comment.body }}`,
      to: 'COMMENT_BODY: static',
    },
    expected: [
      {
        message: 'comment text must be passed through an environment variable',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that authenticates with a non-run token',
    path: ROOT_PROBE,
    mutation: {
      from: `GH_TOKEN: \${{ github.token }}`,
      to: `GH_TOKEN: \${{ secrets.TOKEN }}`,
    },
    expected: [
      {
        message: "probe must authenticate gh with this run's GITHUB_TOKEN",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that queries a fixed repository',
    path: ROOT_PROBE,
    mutation: {
      from: '--repo "$GITHUB_REPOSITORY"',
      to: '--repo "owner/repo"',
      all: true,
    },
    expected: [{ message: 'probe must query the current repository' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that interpolates the comment into its shell command',
    path: ROOT_PROBE,
    mutation: {
      from: 'READ_SCOPE_EVIDENCE=$(gh pr view "$PR_NUMBER"',
      to: `READ_SCOPE_EVIDENCE=$(gh pr view "\${{ github.event.comment.body }}"`,
    },
    expected: [
      {
        message: 'comment text must not be interpolated into a shell command',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe whose exact-command guard is removed',
    path: ROOT_PROBE,
    mutation: {
      from: `if [[ "$COMMENT_BODY" != '/idd-probe-token-scopes' ]]; then`,
      to: 'if false; then',
    },
    expected: [
      {
        message:
          'shell must case-sensitively reject non-exact commands before API reads',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that skips GH_HOST normalization',
    path: ROOT_PROBE,
    mutation: {
      from: `NORMALIZED_GH_HOST=$(printf '%s' "\${GH_HOST:-}"`,
      to: `NORMALIZED_GH_HOST=$(echo "\${GH_HOST:-}"`,
    },
    expected: [
      {
        message:
          'probe must normalize GH_HOST before gh runs without a local repository',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that keeps a whitespace-only GH_HOST',
    path: ROOT_PROBE,
    mutation: {
      from: "sed 's/^[[:space:]]*//; s/[[:space:]]*$//'",
      to: 'cat',
    },
    expected: [
      {
        message: 'probe must treat whitespace-only GH_HOST as unset',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that does not derive the gh host from the server URL',
    path: ROOT_PROBE,
    mutation: {
      from: 'export GH_HOST="$NORMALIZED_GH_HOST"',
      to: 'export GH_HOST="fixed.example"',
    },
    expected: [
      {
        message: 'probe must derive the gh host from the Actions server URL',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that no longer queries gh pr view',
    path: ROOT_PROBE,
    mutation: { from: 'gh pr view', to: 'gh pr list', all: true },
    expected: [{ message: 'probe must query gh pr view' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that drops a missing-linked-issue report',
    path: ROOT_PROBE,
    mutation: {
      from: 'has no linked closing issue',
      to: 'has no linked issue',
    },
    expected: [
      { message: 'probe must report when it has no linked closing issue' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe without its read-only success summary',
    path: ROOT_PROBE,
    mutation: {
      from: 'Read-only self-waiver query probe succeeded for PR',
      to: 'Query succeeded for PR',
    },
    expected: [{ message: 'probe must print its read-only success summary' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that mentions a forbidden write command',
    path: ROOT_PROBE,
    mutation: {
      from: `GH_TOKEN: \${{ github.token }}`,
      to: `GH_TOKEN: \${{ github.token }}\n          NOTE: gh api`,
    },
    expected: [
      {
        message:
          'probe must not invoke a waiver, comment, label, or required-check write operation',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that widens its read scopes',
    path: ROOT_PROBE,
    mutation: {
      from: '      pull-requests: read',
      to: '      pull-requests: write',
    },
    expected: [
      {
        message: 'probe must grant exactly the six requested read-only scopes',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that loses its default-branch trigger note',
    path: ROOT_PROBE,
    mutation: {
      from: `# issue_comment uses the workflow definition from the repository's default branch.`,
      to: '# note removed',
    },
    expected: [{ message: 'probe must keep its default-branch trigger note' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe job id renamed away',
    path: ROOT_PROBE,
    mutation: {
      from: '  probe-self-waiver-token-scopes:',
      to: '  probe-renamed:',
    },
    expected: [
      { message: 'probe must keep its job id' },
      { message: 'workflow must contain the token-scope probe job' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that declares the required job id',
    path: ROOT_PROBE,
    mutation: {
      from: '  probe-self-waiver-token-scopes:',
      to: '  idd-advisory-convergence:\n  probe-self-waiver-token-scopes:',
    },
    expected: [{ message: 'probe must not declare the required job id' }],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide without its waiver probe section',
    path: ONBOARDING_GUIDE,
    mutation: { from: '### Waiver probe', to: '### Probe' },
    expected: [
      { message: 'onboarding guide must explain the token-scope probe' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide table without pull-requests: read',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: '`pull-requests: read`',
      to: '`pull-requests: none`',
      all: true,
    },
    expected: [
      { message: 'onboarding guide table must include pull-requests: read' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that stops calling the probe non-required',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'non-required',
      to: 'optional',
      all: true,
    },
    expected: [
      { message: 'onboarding guide must describe the probe as non-required' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the private-access caveat',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'Public success does not prove private access',
      to: 'Public success is fine',
    },
    expected: [
      {
        message:
          'onboarding guide must say public success does not prove private access',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh job that reuses the required job id',
    path: ROOT_COMMENT,
    mutation: {
      from: '\n  refresh-if-idd-originated:\n',
      to: '\n  idd-advisory-convergence:\n',
    },
    expected: [
      { message: 'must not reuse the required job id' },
      { message: 'must keep the refresh-if-idd-originated job' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template comment-refresh without pull_request_review_comment',
    path: TEMPLATE_COMMENT,
    mutation: {
      from: '  pull_request_review_comment:',
      to: '  pull_request_review_comment_removed:',
    },
    expected: [
      { message: 'must keep the pull_request_review_comment trigger' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh that no longer calls the rerun helper',
    path: ROOT_COMMENT,
    mutation: {
      from: 'rerun-advisory-convergence',
      to: 'rerun-removed',
      all: true,
    },
    expected: [{ message: 'must keep the rerun helper' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh that no longer classifies origin',
    path: ROOT_COMMENT,
    mutation: {
      from: 'review-comment-origin',
      to: 'origin-removed',
      all: true,
    },
    expected: [{ message: 'must keep the review-comment origin classifier' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh that cancels an in-flight refresh',
    path: ROOT_COMMENT,
    mutation: {
      from: 'cancel-in-progress: false',
      to: 'cancel-in-progress: true',
      all: true,
    },
    expected: [{ message: 'must not cancel an in-flight IDD refresh' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh without the issue_comment trigger',
    path: ROOT_COMMENT,
    mutation: {
      from: '  issue_comment:',
      to: '  issue_comment_removed:',
    },
    expected: [{ message: 'on: must include issue_comment' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh that no longer skips plain-issue comments',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null",
      to: 'if: true',
    },
    expected: [{ message: 'must skip a plain-issue issue_comment event' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh PR number that ignores the issue event shape',
    path: ROOT_COMMENT,
    mutation: {
      from: `PR_NUMBER: \${{ github.event.pull_request.number || github.event.issue.number }}`,
      to: `PR_NUMBER: \${{ github.event.issue.number }}`,
      all: true,
    },
    expected: [{ message: 'PR_NUMBER must resolve from either event shape' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh without the pull_request_review trigger',
    path: ROOT_COMMENT,
    mutation: {
      from: '  pull_request_review:',
      to: '  pull_request_review_removed:',
    },
    expected: [{ message: 'on: must include pull_request_review' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step whose if: does not OR in pull_request_review',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name == 'pull_request_review' || (success()",
      to: 'if: (success()',
    },
    expected: [
      {
        message: "rerun step's if: must OR in pull_request_review explicitly",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an empty comment-refresh workflow file',
    path: ROOT_COMMENT,
    mutation: { replaceWith: '' },
    expected: [{ message: 'must not be empty' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing comment-refresh workflow file',
    path: ROOT_COMMENT,
    omit: [ROOT_COMMENT],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing token-scope probe workflow file',
    path: ROOT_PROBE,
    omit: [ROOT_PROBE],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing external-check-waiver helper',
    path: EXTERNAL_CHECK_WAIVER,
    omit: [EXTERNAL_CHECK_WAIVER],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh debounce step renamed away',
    path: ROOT_COMMENT,
    mutation: {
      from: '- name: Check for newer qualifying event',
      to: '- name: Check newer',
      all: true,
    },
    expected: [
      {
        message: 'must have a "Check for newer qualifying event" debounce step',
      },
      {
        message: 'must keep the classify, debounce, and rerun steps',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a debounce step that exposes another id',
    path: ROOT_COMMENT,
    mutation: { from: 'id: debounce', to: 'id: other', all: true },
    expected: [{ message: 'debounce step must expose id: debounce' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a debounce step that no longer invokes its helper',
    path: ROOT_COMMENT,
    mutation: {
      from: 'advisory-comment-debounce',
      to: 'advisory-debounce-removed',
      all: true,
    },
    expected: [
      {
        message: 'must invoke the advisory-comment-debounce helper',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step that drops the idd_originated requirement',
    path: ROOT_COMMENT,
    mutation: {
      from: "(success() && steps.origin.outputs.idd_originated == 'true'",
      to: "(success() && steps.origin.outputs.idd_originated == 'false'",
    },
    expected: [
      {
        message: "rerun step's if: must still require idd_originated",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step that runs even when the debounce step skipped',
    path: ROOT_COMMENT,
    mutation: {
      from: "steps.debounce.outputs.skip != 'true')",
      to: "steps.debounce.outputs.skip == 'true')",
    },
    expected: [
      {
        message: "rerun step's if: must require the debounce step did not skip",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a debounce step that no longer excludes pull_request_review',
    path: ROOT_COMMENT,
    mutation: {
      from: "&& github.event_name != 'pull_request_review'",
      to: "&& github.event_name != 'issue_comment'",
    },
    expected: [
      {
        message:
          "debounce step's if: must explicitly exclude pull_request_review, not merely omit mentioning it",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step without an explicit success() call',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name == 'pull_request_review' || (success() && ",
      to: "if: github.event_name == 'pull_request_review' || (",
    },
    expected: [
      {
        message:
          "rerun step's if: must call success() explicitly to suppress GitHub's implicit prepend",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step whose review branch is gated by success()',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name == 'pull_request_review' ||",
      to: "if: success() && github.event_name == 'pull_request_review' ||",
    },
    expected: [
      {
        message:
          "rerun step's pull_request_review branch must not itself be gated by success()",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step whose review branch is gated by debounce',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name == 'pull_request_review' ||",
      to: "if: github.event_name == 'pull_request_review' && steps.debounce.outputs.skip != 'true' ||",
    },
    expected: [
      {
        message:
          "rerun step's pull_request_review branch must not be gated by debounce.outputs.skip",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template comment-refresh rerun without the instructions-only exclusion',
    path: TEMPLATE_COMMENT,
    mutation: {
      from: "steps.profile.outputs.profile != 'instructions-only'",
      to: "steps.profile.outputs.profile == 'package-manager'",
      all: true,
    },
    expected: [
      {
        message: "rerun step's if: must still exclude instructions-only",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template self-waiver notice step renamed away',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: '- name: Notice when no helper runtime is configured',
      to: '- name: Notice renamed',
    },
    expected: [
      {
        message:
          'must keep a non-failing notice step for an unconfigured helper runtime',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template self-waiver notice that is not gated on the allowlist',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: "if: steps.allowlist.outputs.touched == 'true' && steps.profile.outputs.profile == 'instructions-only'",
      to: "if: steps.profile.outputs.profile == 'instructions-only'",
    },
    expected: [
      {
        message:
          "notice step's if: must be gated on the allowlist touch result",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template self-waiver notice that fails the job',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: 'echo "::notice::helperRuntime.profile resolves to instructions-only',
      to: 'exit 1; echo "::notice::helperRuntime.profile resolves to instructions-only',
    },
    expected: [
      {
        message:
          'notice step must not fail the job (exit 1) for an unconfigured helper runtime',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template self-waiver notice without a ::notice:: annotation',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: 'echo "::notice::helperRuntime.profile resolves to instructions-only',
      to: 'echo "::warning::helperRuntime.profile resolves to instructions-only',
    },
    expected: [
      {
        message: 'notice step must explain itself with a ::notice:: annotation',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a template self-waiver post step that does not exclude instructions-only',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: "steps.profile.outputs.profile != 'instructions-only'",
      to: "steps.profile.outputs.profile == 'package-manager'",
      all: true,
    },
    expected: [
      {
        message:
          "post step's if: must exclude instructions-only, not rely on the case statement's *) fallthrough",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe whose query fields differ from the helper query',
    path: ROOT_PROBE,
    mutation: {
      from: ',statusCheckRollup,closingIssuesReferences',
      to: ',statusCheckRollup',
    },
    expected: [
      {
        message: 'probe query fields must match fetchPullRequest exactly',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that no longer names the default branch',
    path: ONBOARDING_GUIDE,
    mutation: { from: 'default branch', to: 'trunk', all: true },
    expected: [{ message: 'onboarding guide must name the default branch' }],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that no longer names the issue_comment trigger',
    path: ONBOARDING_GUIDE,
    mutation: { from: 'issue_comment', to: 'comment event', all: true },
    expected: [
      {
        message: 'onboarding guide must name the issue_comment trigger',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the post-on-target-PR instruction',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'Post this on the target PR:',
      to: 'Run this somewhere:',
    },
    expected: [
      {
        message:
          'onboarding guide must say to post the command on the target PR',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that names a different probe workflow',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'idd-advisory-convergence-probe.yml',
      to: 'probe-workflow.yml',
      all: true,
    },
    expected: [{ message: 'onboarding guide must name the probe workflow' }],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the edits rule',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'comments, edits, other text',
      to: 'comments, changes, other text',
    },
    expected: [
      {
        message: 'onboarding guide must say edits do not re-trigger the probe',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the other-casing rule',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'other casing',
      to: 'alternate letter case',
    },
    expected: [
      { message: 'onboarding guide must say other casing is rejected' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that allows a ref input',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'No ref input, checkout, PR code,',
      to: 'No inputs,',
    },
    expected: [
      {
        message:
          'onboarding guide must say the probe takes no ref input or checkout',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the no-comment-write rule',
    path: ONBOARDING_GUIDE,
    mutation: { from: 'comment write', to: 'note write', all: true },
    expected: [
      {
        message:
          'onboarding guide must say the probe performs no comment write',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the three read exercises',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'Actions check, legacy status',
      to: 'Checks, status',
    },
    expected: [
      {
        message: 'onboarding guide must name the three read exercises',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops this run token-access note',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: "this run's token access here",
      to: 'this token access there',
    },
    expected: [
      {
        message: "onboarding guide must describe this run's token access",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the denied-read remedy',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: 'Denied reads point to token or',
      to: 'Failed reads point to token or',
    },
    expected: [
      {
        message:
          'onboarding guide must point denied reads at token or Actions settings',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide without the issues: write scope',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: '`issues: write`',
      to: '`issues: none`',
      all: true,
    },
    expected: [
      { message: 'onboarding guide must name the issues: write scope' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide without the pull-requests: write scope',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: '`pull-requests: write`',
      to: '`pull-requests: none`',
      all: true,
    },
    expected: [
      {
        message: 'onboarding guide must name the pull-requests: write scope',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that narrows the trusted author associations',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: '`OWNER`, `MEMBER`, or `COLLABORATOR`',
      to: '`OWNER` or `MEMBER`',
    },
    expected: [
      {
        message: 'onboarding guide must list the trusted author associations',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that shows a different command',
    path: ONBOARDING_GUIDE,
    mutation: {
      from: '```text\n/idd-probe-token-scopes\n```',
      to: '```text\n/probe\n```',
    },
    expected: [{ message: 'onboarding guide must show the exact command' }],
  },
  {
    ruleId: 'RWA005',
    name: 'an onboarding guide that drops the required-gate caveat',
    path: ONBOARDING_GUIDE,
    mutation: { from: 'required-gate change', to: 'gate change', all: true },
    expected: [
      {
        message: 'onboarding guide must say a required-gate change is needed',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe query whose jq filter no longer tests for a CheckRun',
    path: ROOT_PROBE,
    mutation: {
      from: '.__typename == "CheckRun"',
      to: '.__typename == "CheckRunX"',
    },
    expected: [
      {
        message:
          'probe must verify Actions, legacy status, and a linked issue exercise all read scopes',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that no longer reports a missing Actions check run',
    path: ROOT_PROBE,
    mutation: {
      from: 'has no Actions check run',
      to: 'has an Actions check run',
    },
    expected: [
      { message: 'probe must report when it has no Actions check run' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe that no longer reports a missing legacy status context',
    path: ROOT_PROBE,
    mutation: {
      from: 'has no legacy status context',
      to: 'has a legacy status context',
    },
    expected: [
      { message: 'probe must report when it has no legacy status context' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe without a permissions block to bound its trigger',
    path: ROOT_PROBE,
    mutation: { from: '\npermissions:', to: '\npermissions_x:' },
    expected: [{ message: 'on:/permissions: block not found' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a waiver-invoking copy whose helper is no longer named',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: 'external-check-waiver',
      to: 'external-check-renamed',
      all: true,
    },
    expected: [
      {
        includes:
          'must find idd-advisory-convergence-self-waiver as an external-check-waiver invoker',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a waiver-invoking job without checks: read (kurone-kito/idd-skill#3683)',
    path: TEMPLATE_ADVISORY,
    mutation: { from: 'checks: read', to: 'checks: none', all: true },
    expected: [
      { includes: 'must keep checks: read (kurone-kito/idd-skill#3683' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a waiver-invoking job without statuses: read (kurone-kito/idd-skill#3683)',
    path: TEMPLATE_ADVISORY,
    mutation: { from: 'statuses: read', to: 'statuses: none', all: true },
    expected: [
      { includes: 'must keep statuses: read (kurone-kito/idd-skill#3683' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that references the token-scope probe',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:',
      to: '  pull_request_target:\n  # probe_token_scopes',
    },
    expected: [{ message: 'must not reference the token-scope probe' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a template comment-refresh rerun that no longer excludes an ambiguous package manager',
    path: TEMPLATE_COMMENT,
    mutation: {
      from: "steps.manager.outputs.manager != 'ambiguous'",
      to: "steps.manager.outputs.manager != 'other'",
      all: true,
    },
    expected: [
      {
        message:
          "rerun step's if: must still exclude an ambiguous package manager",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step whose review branch is gated by success() in the opposite order',
    path: ROOT_COMMENT,
    mutation: {
      from: "if: github.event_name == 'pull_request_review' ||",
      to: "if: github.event_name == 'pull_request_review' && success() ||",
    },
    expected: [
      {
        message:
          "rerun step's pull_request_review branch must not itself be gated by success()",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step whose review branch is gated by the debounce skip output after it',
    path: ROOT_COMMENT,
    mutation: {
      from: "steps.debounce.outputs.skip != 'true')",
      to: "steps.debounce.outputs.skip != 'true' && github.event_name == 'pull_request_review')",
    },
    expected: [
      {
        message:
          "rerun step's pull_request_review branch must not be gated by debounce.outputs.skip",
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose debounce step runs after the rerun step',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const debounce = anchored(
          text,
          '      - name: Check for newer qualifying event',
        );
        const rerun = anchored(text, '      - name: Rerun required HEAD check');
        const after = text.indexOf('\n      - ', rerun + 1);
        const end = after === -1 ? text.length : after;
        const debounceBlock = text.slice(debounce, rerun).replace(/\n$/, '');
        const rerunBlock = text.slice(rerun, end);
        return (
          text.slice(0, debounce) +
          rerunBlock +
          '\n' +
          debounceBlock +
          text.slice(end)
        );
      },
    },
    expected: [
      { message: 'steps must run in order: classify, debounce, rerun' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose rerun step is renamed and whose review trigger is removed',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        anchored(text, '- name: Rerun required HEAD check');
        anchored(text, '  pull_request_review:');
        return text
          .replace('- name: Rerun required HEAD check', '- name: Rerun renamed')
          .replace('  pull_request_review:', '  pull_request_review_removed:');
      },
    },
    expected: [
      { message: 'must have a "Rerun required HEAD check" step' },
      { message: 'on: must include pull_request_review' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step without its own PR_NUMBER while a later step has one',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const rerun = anchored(text, '- name: Rerun required HEAD check');
        const after = text.indexOf('\n      - ', rerun + 1);
        const end = after === -1 ? text.length : after;
        assert.match(text.slice(rerun, end), /\n {10}PR_NUMBER: /);
        const body = text.slice(rerun, end).replace(/\n {10}PR_NUMBER: .*/, '');
        const extra = `\n      - name: Extra step\n        env:\n          PR_NUMBER: \${{ github.event.pull_request.number || github.event.issue.number }}\n        run: echo ok`;
        return text.slice(0, rerun) + body + extra + text.slice(end);
      },
    },
    expected: [
      { message: 'Rerun required HEAD check step must assign PR_NUMBER' },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a checkout step without fetch-depth while a later step sets it',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        anchored(text, '          fetch-depth: 1\n');
        const removed = text.replace('          fetch-depth: 1\n', '');
        const later = anchored(
          removed,
          '      - name: Post cleanup evidence comment',
        );
        return (
          removed.slice(0, later) +
          '      - name: Extra step\n        with:\n          fetch-depth: 1\n        run: echo ok\n' +
          removed.slice(later)
        );
      },
    },
    expected: [{ message: 'checkout step must keep its fetch-depth: input' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing onboarding guide',
    path: ONBOARDING_GUIDE,
    omit: [ONBOARDING_GUIDE],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA006',
    name: 'a missing self-waiver constants source',
    path: SELF_WAIVER_CONSTANTS,
    omit: [SELF_WAIVER_CONSTANTS],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA006',
    name: 'a missing template advisory-convergence copy',
    path: TEMPLATE_ADVISORY,
    omit: [TEMPLATE_ADVISORY],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing template comment-refresh copy',
    path: TEMPLATE_COMMENT,
    omit: [TEMPLATE_COMMENT],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a missing template token-scope probe',
    path: TEMPLATE_PROBE,
    omit: [TEMPLATE_PROBE],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a missing pnpm-boundary workflow',
    path: '.github/workflows/pnpm-boundary.yml',
    omit: ['.github/workflows/pnpm-boundary.yml'],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a missing Node 22 floor workflow',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    omit: ['.github/workflows/pnpm-boundary-node22-floor.yml'],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a missing lint workflow',
    path: '.github/workflows/lint.yml',
    omit: ['.github/workflows/lint.yml'],
    expected: [{ message: 'required input is missing or unreadable' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check without a permissions block to bound its trigger',
    path: '.github/workflows/lint.yml',
    mutation: { from: '\npermissions:', to: '\npermissions_x:' },
    expected: [{ message: 'on:/permissions: block not found' }],
  },
  {
    ruleId: 'RWA002',
    name: 'a reusable-workflow caller without a jobs mapping',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: { from: '\njobs:\n', to: '\njobs_x:\n' },
    expected: [{ message: 'jobs: block not found' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check whose job key is renamed away',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: { from: '\n  pnpm-boundary:\n', to: '\n  pnpm-boundary-x:\n' },
    expected: [
      { message: 'job pnpm-boundary not found' },
      { message: 'must keep required job id pnpm-boundary' },
    ],
  },
  {
    ruleId: 'RWA003',
    name: 'a Node 22 floor job whose key is renamed away',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: {
      from: '\n  pnpm-boundary-node22-floor:\n',
      to: '\n  pnpm-boundary-node22-floor-x:\n',
    },
    expected: [{ message: 'job pnpm-boundary-node22-floor not found' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a Node 22 floor job without its with block',
    path: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mutation: { from: '\n    with:\n', to: '\n    with_x:\n' },
    expected: [{ message: 'with: block not found at indent 4' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a pnpm-boundary workflow without its workflow_call block',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: { from: '\n  workflow_call:', to: '\n  workflow_call_x:' },
    expected: [{ message: 'workflow_call: block not found at indent 2' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a pnpm-boundary workflow without its inputs block',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: { from: '\n    inputs:', to: '\n    inputs_x:' },
    expected: [{ message: 'inputs: block not found at indent 4' }],
  },
  {
    ruleId: 'RWA003',
    name: 'a pnpm-boundary workflow without its runner input',
    path: '.github/workflows/pnpm-boundary.yml',
    mutation: { from: '\n      runner:\n', to: '\n      runner_x:\n' },
    expected: [{ message: 'runner: block not found at indent 6' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a debounce step without its own condition while a later step has one',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const condition =
          "        if: steps.origin.outputs.idd_originated == 'true' && github.event_name != 'pull_request_review'\n";
        const rerun = '      - name: Rerun required HEAD check';
        anchored(text, condition);
        anchored(text, rerun);
        const without = text.replace(condition, '');
        const at = without.indexOf(rerun);
        return `${without.slice(0, at)}      - name: Intervening step\n        if: github.event_name != 'pull_request_review'\n        run: echo ok\n${without.slice(at)}`;
      },
    },
    expected: [{ message: 'debounce step must have an if: condition' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate without a permissions block to bound its trigger',
    path: ROOT_ADVISORY,
    mutation: { from: '\npermissions:', to: '\npermissions_x:' },
    expected: [{ message: 'on:/permissions: block not found' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh workflow without a permissions block to bound its trigger',
    path: ROOT_COMMENT,
    mutation: { from: '\npermissions:', to: '\npermissions_x:' },
    expected: [{ message: 'on:/permissions: block not found' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose with-level ref is PR-controlled while a decoy ref sits under env',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const checkout =
          '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n';
        anchored(text, checkout);
        const pinned = text.replace(
          '          ref: main\n',
          `          ref: \${{ github.event.pull_request.head.sha }}\n`,
        );
        const end = anchored(pinned, checkout) + checkout.length;
        return `${pinned.slice(0, end)}        env:\n          ref: main\n${pinned.slice(end)}`;
      },
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a quoted checkout uses value that moves to a PR-controlled ref',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const checkout =
          '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n';
        anchored(text, checkout);
        const quoted = text.replace(
          checkout,
          '      - uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" # v7.0.1\n',
        );
        return quoted.replace(
          '          ref: main\n',
          `          ref: \${{ github.event.pull_request.head.sha }}\n`,
        );
      },
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate that no longer checks out the repository',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@',
      to: '      - uses: actions/cache@',
      all: true,
    },
    expected: [
      { message: 'uses must name a recognized action in its canonical form' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose action name hides an escape the audit cannot read',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      to: '      - uses: actions\\x2fcheckout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    },
    expected: [
      {
        message: 'a backslash outside run: blocks cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout written as a flow mapping that splits its key across lines',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
      to: '      - { ? uses\n        : actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 }\n',
    },
    expected: [{ message: 'flow collections cannot be read by this audit' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a flow mapping whose run key hides a uses key on the same line',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n      - {env: {run: x}, uses: actions/checkout@v4, with: {ref: main}}${text.slice(job)}`;
      },
    },
    expected: [{ message: 'flow collections cannot be read by this audit' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a second canonical upload added to a required gate',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n      - name: extra upload\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: idd-probe\n          path: /dev/null${text.slice(job)}`;
      },
    },
    expected: [
      {
        message: 'a required gate may declare only its self-waiver upload',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate in which no step checks out the repository',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@',
      to: '      - name: no checkout at ',
      all: true,
    },
    expected: [{ message: 'no actions/checkout step to pin to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a gate whose steps key carries a trailing comment that looks like a block header',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const steps = anchored(text, '    steps:\n');
        const pinned = text.replace(
          '          ref: main\n',
          `          ref: \${{ github.event.pull_request.head.sha }}\n`,
        );
        return `${pinned.slice(0, steps)}    steps: # note: |\n${pinned.slice(steps + '    steps:\n'.length)}`;
      },
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout written under an alias key',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n      - *probe: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1${text.slice(job)}`;
      },
    },
    expected: [
      {
        message:
          'workflow syntax outside plain keys and values cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a trigger written as a flow mapping',
    path: ROOT_ADVISORY,
    mutation: {
      from: '  pull_request_target:\n',
      to: '  pull_request_target: {}\n',
    },
    expected: [
      {
        message:
          'workflow syntax outside plain keys and values cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a lone carriage return inside a checkout step',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
      to: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\r\n',
    },
    expected: [
      { message: 'a line break other than LF cannot be read by this audit' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an alias value spaced after its key so that a checkout cannot be read',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n    PROBE:  &probe uses${text.slice(job)}`;
      },
    },
    expected: [
      {
        message:
          'workflow syntax outside plain keys and values cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'an alias key spaced after its dash so that a checkout cannot be read',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n      -  *probe: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1${text.slice(job)}`;
      },
    },
    expected: [
      {
        message:
          'workflow syntax outside plain keys and values cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a gate trigger for the companion workflow spaced before its colon',
    path: ROOT_ADVISORY,
    mutation: {
      from: '\non:\n',
      to: '\non:\n  pull_request_review :\n',
    },
    expected: [
      {
        message:
          'on: must not include pull_request_review (moved to the companion workflow)',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check gaining a path filter spelled with a space before its colon',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  pull_request:\n',
      to: '  pull_request:\n    paths :\n      - "docs/**"\n',
    },
    expected: [
      {
        message:
          'pull_request trigger must not gain a path filter -- a path-filtered required check never reports for an out-of-filter change',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required check gaining a path filter spelled with a quoted key',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  pull_request:\n',
      to: '  pull_request:\n    "paths":\n      - "docs/**"\n',
    },
    expected: [
      {
        message:
          'pull_request trigger must not gain a path filter -- a path-filtered required check never reports for an out-of-filter change',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a required check trigger written as a flow mapping with a path filter',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  pull_request:\n',
      to: '  pull_request: {paths: [docs/**]}\n',
    },
    expected: [
      {
        message:
          'workflow syntax outside plain keys and values cannot be read by this audit',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required job made conditional by a job-level if',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  lint:\n',
      to: '  lint:\n    if: false\n',
    },
    expected: [
      {
        message:
          'lint must not be conditional, depend on another job, or continue on error',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required job that waits on another job',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '  lint:\n',
      to: '  lint:\n    needs: lint-windows\n',
    },
    expected: [
      {
        message:
          'lint must not be conditional, depend on another job, or continue on error',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required job step that continues on error',
    path: '.github/workflows/lint.yml',
    mutation: {
      from: '      - uses: actions/checkout@',
      to: '        continue-on-error: true\n      - uses: actions/checkout@',
    },
    expected: [
      {
        message:
          'lint must not be conditional, depend on another job, or continue on error',
      },
    ],
  },
  {
    ruleId: 'RWA001',
    name: 'a required job made conditional beneath a jobs header that carries a comment',
    path: '.github/workflows/lint.yml',
    mutation: {
      transform: (text: string) =>
        text
          .replace('\njobs:\n', '\njobs: # keep the jobs block\n')
          .replace('  lint:\n', '  lint:\n    if: false\n'),
    },
    expected: [
      {
        message:
          'lint must not be conditional, depend on another job, or continue on error',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout written as a complex mapping key',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
      to: '      - ? uses\n        : actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
    },
    expected: [
      { message: 'complex mapping keys cannot be read by this audit' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a third-party action added to a required gate',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(
          text,
          '\n  idd-advisory-convergence-self-waiver:\n',
        );
        return `${text.slice(0, job)}\n      - uses: someone/cloner@v1${text.slice(job)}`;
      },
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout that adds a repository key to its with block',
    path: ROOT_ADVISORY,
    mutation: {
      from: '          ref: main\n',
      to: '          ref: main\n          repository: someone/fork\n',
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout step that carries a second with block',
    path: ROOT_ADVISORY,
    mutation: {
      from: '          ref: main\n',
      to: '          ref: main\n        with:\n          ref: main\n',
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose uses key is quoted, which hides it from the canonical form',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      to: '      - "uses": actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose uses key has a space before its colon',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      to: '      - uses : actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose action name is differently cased',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      to: '      - uses: Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose dash stands alone on its line',
    path: ROOT_ADVISORY,
    mutation: {
      from: '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
      to: '      -\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
    },
    expected: [
      {
        message: 'uses must name a recognized action in its canonical form',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a checkout whose quoted ref key adds a second ref beside the pinned one',
    path: ROOT_ADVISORY,
    mutation: {
      from: '          ref: main\n',
      to: `          ref: main\n          "ref": \${{ github.event.pull_request.head.sha }}\n`,
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate checkout moved to a PR-controlled ref while the self-waiver checkout stays pinned',
    path: ROOT_ADVISORY,
    mutation: {
      from: '          ref: main',
      to: `          ref: \${{ github.event.pull_request.head.sha }}`,
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a template required gate checkout moved to a PR-controlled ref',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: '          ref: main',
      to: `          ref: \${{ github.event.pull_request.head.sha }}`,
    },
    expected: [{ message: 'checkout must stay pinned to ref: main' }],
  },
  {
    ruleId: 'RWA006',
    name: 'a post step renamed while its old name survives in a comment',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const step = anchored(
          text,
          '      - name: Post the self-referential-bootstrap-auto waiver\n',
        );
        return `${text.slice(0, step)}      # - name: Post the self-referential-bootstrap-auto waiver\n      - name: Post the waiver\n${text.slice(step + '      - name: Post the self-referential-bootstrap-auto waiver\n'.length)}`;
      },
    },
    expected: [{ message: 'no longer declares the expected post-step name' }],
  },
  {
    ruleId: 'RWA006',
    name: 'an artifact name renamed while its prefix survives in a shell path',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        anchored(text, '          name: idd-self-waiver-marker-');
        const renamed = text.replace(
          '          name: idd-self-waiver-marker-',
          '          name: renamed-marker-',
        );
        const at = anchored(
          renamed,
          '      - name: Post the self-referential-bootstrap-auto waiver\n',
        );
        return `${renamed.slice(0, at)}      - name: Show the prefix\n        run: echo idd-self-waiver-marker-\n${renamed.slice(at)}`;
      },
    },
    expected: [
      { message: 'no longer declares the expected artifact-name prefix' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a self-waiver post step renamed while an indented copy of the old name stays in the job',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const step =
          '      - name: Post the self-referential-bootstrap-auto waiver\n';
        anchored(text, step);
        const renamed = text.replace(step, '      - name: Post the waiver\n');
        const at = anchored(renamed, '      - name: Post the waiver\n');
        return `${renamed.slice(0, at)}        - name: Post the self-referential-bootstrap-auto waiver\n${renamed.slice(at)}`;
      },
    },
    expected: [{ message: 'no longer declares the expected post-step name' }],
  },
  {
    ruleId: 'RWA006',
    name: 'an artifact name in an upload step that also carries an env key',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const uses = anchored(text, '        uses: actions/upload-artifact@');
        const end = text.indexOf('\n', uses) + 1;
        return `${text.slice(0, end)}        env:\n          PROBE: value\n${text.slice(end)}`;
      },
    },
    expected: [
      { message: 'no longer declares the expected artifact-name prefix' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'an artifact name renamed while an env name in its upload step keeps the prefix',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        anchored(text, '          name: idd-self-waiver-marker-');
        const renamed = text.replace(
          '          name: idd-self-waiver-marker-',
          '          name: renamed-marker-',
        );
        const uses = anchored(
          renamed,
          '        uses: actions/upload-artifact@',
        );
        const end = renamed.indexOf('\n', uses) + 1;
        return `${renamed.slice(0, end)}        env:\n          name: idd-self-waiver-marker-probe\n${renamed.slice(end)}`;
      },
    },
    expected: [
      { message: 'no longer declares the expected artifact-name prefix' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a self-waiver post step renamed while another job declares the old name',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const step =
          '      - name: Post the self-referential-bootstrap-auto waiver\n';
        anchored(text, step);
        const renamed = text.replace(step, '      - name: Post the waiver\n');
        const job = anchored(
          renamed,
          '  idd-advisory-convergence-self-waiver:\n',
        );
        return `${renamed.slice(0, job)}${step}        run: echo ok\n${renamed.slice(job)}`;
      },
    },
    expected: [{ message: 'no longer declares the expected post-step name' }],
  },
  {
    ruleId: 'RWA006',
    name: 'a self-waiver artifact renamed while another job uploads under the prefix',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        anchored(text, '          name: idd-self-waiver-marker-');
        const renamed = text.replace(
          '          name: idd-self-waiver-marker-',
          '          name: renamed-marker-',
        );
        const job = anchored(
          renamed,
          '  idd-advisory-convergence-self-waiver:\n',
        );
        return `${renamed.slice(0, job)}      - uses: actions/upload-artifact@v4\n        with:\n          name: idd-self-waiver-marker-probe\n${renamed.slice(job)}`;
      },
    },
    expected: [
      { message: 'no longer declares the expected artifact-name prefix' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a job id renamed while its old id survives in a comment',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const job = anchored(text, '  idd-advisory-convergence-self-waiver:\n');
        const renamed = text.replace(
          '  idd-advisory-convergence-self-waiver:\n',
          '  renamed-self-waiver:\n',
        );
        return `${renamed.slice(0, job)}  # idd-advisory-convergence-self-waiver:\n${renamed.slice(job)}`;
      },
    },
    expected: [
      { message: 'no longer declares the expected self-waiver job id' },
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
  {
    ruleId: 'RWA005',
    name: 'a required gate job whose own checkout is removed',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) =>
        removeJobCheckout(text, 'idd-advisory-convergence'),
    },
    expected: [
      { message: 'idd-advisory-convergence must declare its own checkout' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a self-waiver job whose own checkout is removed',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) =>
        removeJobCheckout(text, 'idd-advisory-convergence-self-waiver'),
    },
    expected: [
      {
        message:
          'idd-advisory-convergence-self-waiver must declare its own checkout',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose issue_comment trigger is commented out',
    path: ROOT_COMMENT,
    mutation: { from: '\n  issue_comment:\n', to: '\n  # issue_comment:\n' },
    expected: [{ message: 'on: must include issue_comment' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose pull_request_review_comment trigger is commented out',
    path: ROOT_COMMENT,
    mutation: {
      from: '\n  pull_request_review_comment:\n',
      to: '\n  # pull_request_review_comment:\n',
    },
    expected: [
      { message: 'must keep the pull_request_review_comment trigger' },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose rerun helper survives only in header comments',
    path: ROOT_COMMENT,
    mutation: {
      from: 'scripts/rerun-advisory-convergence.mjs',
      to: 'scripts/rerun-advisory-disabled.mjs',
      all: true,
    },
    expected: [{ message: 'must keep the rerun helper' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose real cancel-in-progress is true while a comment keeps false',
    path: ROOT_COMMENT,
    mutation: {
      from: '  cancel-in-progress: false\n',
      to: '  cancel-in-progress: true\n',
    },
    expected: [{ message: 'must not cancel an in-flight IDD refresh' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose rerun step name survives only in a comment',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const old = '      - name: Rerun required HEAD check';
        const step = anchored(text, old);
        return (
          text.slice(0, step) +
          '      # - name: Rerun required HEAD check\n' +
          '      - name: Rerun disabled' +
          text.slice(step + old.length)
        );
      },
    },
    expected: [{ message: 'must have a "Rerun required HEAD check" step' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose debounce step name survives only in a comment',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const old = '      - name: Check for newer qualifying event';
        const step = anchored(text, old);
        return (
          text.slice(0, step) +
          '      # - name: Check for newer qualifying event\n' +
          '      - name: Check for newer events' +
          text.slice(step + old.length)
        );
      },
    },
    expected: [
      {
        message: 'must have a "Check for newer qualifying event" debounce step',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a probe whose trigger list adds a quoted schedule key',
    path: ROOT_PROBE,
    mutation: {
      from: '\non:\n  issue_comment:\n',
      to: '\non:\n  "schedule":\n  issue_comment:\n',
    },
    expected: [{ message: 'probe must use only issue_comment' }],
  },
  {
    ruleId: 'RWA001',
    name: 'a required workflow whose pull_request trigger is commented out',
    path: '.github/workflows/lint.yml',
    mutation: { from: '\n  pull_request:\n', to: '\n  # pull_request:\n' },
    expected: [{ message: 'must trigger on pull_request' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a required gate whose pull_request_target trigger is commented out',
    path: ROOT_ADVISORY,
    mutation: {
      from: '\n  pull_request_target:\n',
      to: '\n  # pull_request_target:\n',
    },
    expected: [{ message: 'on: must include pull_request_target' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a notice step whose exit 1 follows a quoted # on the same line',
    path: TEMPLATE_ADVISORY,
    mutation: {
      from: '::notice::helperRuntime.profile',
      to: '::notice::see #1"; exit 1; echo "helperRuntime.profile',
    },
    expected: [
      {
        message:
          'notice step must not fail the job (exit 1) for an unconfigured helper runtime',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose real ref is PR-controlled, with a commented decoy above it',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const realRef = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const decoy = [
          `      # - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`,
          `      #   with:`,
          `      #     ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}`,
          `      #     fetch-depth: 1`,
          '',
        ].join('\n');
        anchored(text, realRef);
        anchored(text, checkout);
        return text
          .split(checkout)
          .join(decoy + checkout)
          .split(realRef)
          .join(`          ref: \${{ github.event.pull_request.head.sha }}\n`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA006',
    name: 'a waiver job id whose exported constant changes while a comment keeps the old declaration',
    path: SELF_WAIVER_CONSTANTS,
    violationPath: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const head = 'export const SELF_REFERENTIAL_WAIVER_JOB_ID =\n';
        const old = "  'idd-advisory-convergence-self-waiver';";
        anchored(text, head);
        assert.equal(
          text.split(old).length - 1,
          1,
          'fixture anchor is not unique',
        );
        return text
          .split(head)
          .join(
            `// export const SELF_REFERENTIAL_WAIVER_JOB_ID = 'idd-advisory-convergence-self-waiver';\n${head}`,
          )
          .split(old)
          .join("  'renamed-self-waiver';");
      },
    },
    expected: [
      { message: 'no longer declares the expected self-waiver job id' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a second self-waiver step that carries the expected post-step name',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const anchor = `      - name: Record the posted marker's provenance\n`;
        const decoy = `      - name: Post the self-referential-bootstrap-auto waiver\n        run: echo "decoy"\n`;
        anchored(text, anchor);
        return text.split(anchor).join(decoy + anchor);
      },
    },
    expected: [
      { message: 'must declare the expected post-step name exactly once' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a post step with the expected name that no longer runs the waiver poster',
    path: ROOT_ADVISORY,
    mutation: {
      from: 'node scripts/external-check-waiver.mjs \\\n',
      to: 'node scripts/echo-check-waiver.mjs \\\n',
    },
    expected: [
      {
        message: 'the post step must run scripts/external-check-waiver.mjs',
      },
    ],
  },
  {
    ruleId: 'RWA007',
    name: 'a commented setup-node use that keeps the count while the real action is replaced',
    path: 'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
    violationPath: 'idd-template/.github/workflows',
    mutation: {
      transform: (text: string) => {
        const real = '      - uses: actions/setup-node@v4\n';
        anchored(text, real);
        return text
          .split(real)
          .join(
            '      # - uses: actions/setup-node@v4\n      - uses: actions/setup-other@v4\n',
          );
      },
    },
    expected: [{ prefix: 'expected exactly 4 actions/setup-node steps' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a name-first checkout that keeps an unpinned ref beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const legacy = [
          `      - name: Checkout legacy`,
          `        uses: actions/checkout@v4`,
          `        with:`,
          `          ref: \${{ github.event.pull_request.head.sha }}`,
          `          fetch-depth: 1`,
          '',
        ].join('\n');
        anchored(text, checkout);
        return text.split(checkout).join(legacy + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a post step that names the waiver poster in env: while its run body runs another command',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const name =
          '      - name: Post the self-referential-bootstrap-auto waiver\n';
        const start = anchored(text, name);
        const next = text.indexOf('\n      - ', start + name.length);
        const end = next === -1 ? text.length : next + 1;
        const step = text.slice(start, end);
        const run = '          node scripts/external-check-waiver.mjs \\\n';
        const env = '        env:\n';
        assert.ok(step.includes(run), 'fixture anchor not found: poster line');
        assert.ok(
          step.includes(env),
          'fixture anchor not found: post step env',
        );
        const moved = step
          .split(run)
          .join('          node scripts/echo-check-waiver.mjs \\\n')
          .split(env)
          .join(
            `${env}          WAIVER_POSTER: scripts/external-check-waiver.mjs\n`,
          );
        return text.slice(0, start) + moved + text.slice(end);
      },
    },
    expected: [
      { message: 'the post step must run scripts/external-check-waiver.mjs' },
    ],
  },
  {
    ruleId: 'RWA006',
    name: 'a post step whose poster is replaced in run: while a later key names it',
    path: ROOT_ADVISORY,
    mutation: {
      transform: (text: string) => {
        const name =
          '      - name: Post the self-referential-bootstrap-auto waiver\n';
        const start = anchored(text, name);
        const next = text.indexOf('\n      - ', start + name.length);
        assert.notEqual(
          next,
          -1,
          'fixture anchor not found: step after the post step',
        );
        const run = '          node scripts/external-check-waiver.mjs \\\n';
        const step = text.slice(start, next);
        assert.ok(step.includes(run), 'fixture anchor not found: poster line');
        const moved = step
          .split(run)
          .join('          node scripts/echo-check-waiver.mjs \\\n');
        return (
          text.slice(0, start) +
          moved +
          '\n        with:\n          poster: scripts/external-check-waiver.mjs' +
          text.slice(next)
        );
      },
    },
    expected: [
      { message: 'the post step must run scripts/external-check-waiver.mjs' },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a merged-PR guard whose gate is commented out',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) =>
        replaceInStep(
          text,
          'Require a merged PR for workflow_dispatch',
          "        if: github.event_name == 'workflow_dispatch'\n",
          "        # if: github.event_name == 'workflow_dispatch'\n",
        ),
    },
    expected: [{ message: 'guard step must be gated on workflow_dispatch' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup step whose timeout is commented out',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) =>
        replaceInStep(
          text,
          'Run F4 cleanup (server-side fallback)',
          '        timeout-minutes: 8\n',
          '        # timeout-minutes: 8\n',
        ),
    },
    expected: [{ message: 'cleanup step must set timeout-minutes' }],
  },
  {
    ruleId: 'RWA004',
    name: 'an evidence step whose always() gate is commented out',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) =>
        replaceInStep(
          text,
          'Post cleanup evidence comment',
          "        if: always() && steps.cleanup.outcome != 'skipped'\n",
          "        # if: always() && steps.cleanup.outcome != 'skipped'\n",
        ),
    },
    expected: [
      {
        message:
          'evidence step must run on always() unless cleanup was skipped',
      },
    ],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose rerun helper is removed while the classifier step names it',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) =>
        replaceInStep(
          text
            .split('scripts/rerun-advisory-convergence.mjs')
            .join('scripts/rerun-disabled.mjs'),
          'Classify review comment',
          '        run: node scripts/review-comment-origin.mjs',
          '        run: node scripts/review-comment-origin.mjs && echo rerun-advisory-convergence',
        ),
    },
    expected: [{ message: 'must keep the rerun helper' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose debounce helper is removed while the classifier step names it',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) =>
        replaceInStep(
          text
            .split('scripts/advisory-comment-debounce.mjs')
            .join('scripts/debounce-disabled.mjs'),
          'Classify review comment',
          '        run: node scripts/review-comment-origin.mjs',
          '        run: node scripts/review-comment-origin.mjs && echo advisory-comment-debounce',
        ),
    },
    expected: [{ message: 'must invoke the advisory-comment-debounce helper' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a merged-PR guard declared twice, with the drifted copy after a compliant one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const name = 'Require a merged PR for workflow_dispatch';
        const gate = "        if: github.event_name == 'workflow_dispatch'\n";
        const start = anchored(text, `      - name: ${name}\n`);
        const end = text.indexOf('\n      - ', start + 1);
        const compliant = text.slice(start, end === -1 ? text.length : end + 1);
        const drifted = replaceInStep(text, name, gate, '');
        const at = drifted.indexOf(`      - name: ${name}\n`);
        return drifted.slice(0, at) + compliant + drifted.slice(at);
      },
    },
    expected: [
      {
        message:
          'the "Require a merged PR for workflow_dispatch" step must be declared exactly once',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a merged-PR guard that ends its job, while the next job carries the gate',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        // The guard stays before the cleanup step, and the cleanup steps move to a
        // second job whose gate follows the guard, so the guard is the last step of
        // the first job.
        const name = 'Require a merged PR for workflow_dispatch';
        const gate = "        if: github.event_name == 'workflow_dispatch'\n";
        const start = anchored(text, `      - name: ${name}\n`);
        const next = text.indexOf('\n      - ', start + 1) + 1;
        assert.ok(
          next > start,
          'fixture anchor not found: step after the guard',
        );
        const guard = text.slice(start, next).split(gate).join('');
        return (
          text.slice(0, start) +
          guard +
          "  next-job:\n    if: github.event_name == 'workflow_dispatch'\n    runs-on: ubuntu-latest\n    steps:\n" +
          text.slice(next)
        );
      },
    },
    expected: [{ message: 'guard step must be gated on workflow_dispatch' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a rerun step declared twice, with the drifted copy after a compliant one',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const name = 'Rerun required HEAD check';
        const start = anchored(text, `      - name: ${name}\n`);
        const end = text.indexOf('\n      - ', start + 1);
        const compliant = text.slice(start, end === -1 ? text.length : end + 1);
        const drifted = replaceInStep(
          text,
          name,
          'scripts/rerun-advisory-convergence.mjs',
          'scripts/rerun-disabled.mjs',
        );
        const at = drifted.indexOf(`      - name: ${name}\n`);
        return drifted.slice(0, at) + compliant + drifted.slice(at);
      },
    },
    expected: [
      {
        message:
          'the "Rerun required HEAD check" step must be declared exactly once',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a second cleanup checkout whose uses key is quoted, beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const legacy = [
          `      - "uses": actions/checkout@v4`,
          `        with:`,
          `          ref: \${{ github.event.pull_request.head.sha }}`,
          `          fetch-depth: 1`,
          '',
        ].join('\n');
        anchored(text, checkout);
        return text.split(checkout).join(legacy + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a second cleanup checkout written as a flow mapping, beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const flow = `      - { uses: actions/checkout@v4, with: { fetch-depth: 1 } }\n`;
        anchored(text, checkout);
        return text.split(checkout).join(flow + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a second cleanup checkout whose action name is in another letter case',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const cased = `      - uses: Actions/Checkout@v4\n        with:\n          fetch-depth: 1\n`;
        anchored(text, checkout);
        return text.split(checkout).join(cased + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose ref moves from with: to env:',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        const uses = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        anchored(text, ref);
        anchored(text, uses);
        return text
          .split(ref)
          .join('')
          .split(uses)
          .join(`${uses}        env:\n${ref}`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose with: block carries a second ref after the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        anchored(text, ref);
        return text.split(ref).join(`${ref}          ref: main\n`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose pinned value sits under a key that merely ends in ref',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        anchored(text, ref);
        return text
          .split(ref)
          .join(ref.replace('          ref:', '          my_ref:'));
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout that declares its with: block twice',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        const fetch = '          fetch-depth: 1\n';
        const withLine = '        with:\n';
        anchored(text, ref + fetch);
        return text.split(ref + fetch).join(`${ref}${withLine}${fetch}`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose refresh job loses its plain-issue guard while another step keeps it',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        const classify = '      - name: Classify review comment\n';
        anchored(text, job);
        anchored(text, classify);
        return text
          .split(job)
          .join('')
          .split(classify)
          .join(
            `${classify}        if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`,
          );
      },
    },
    expected: [{ message: 'must skip a plain-issue issue_comment event' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a comment-refresh whose refresh job guard is prefixed with true ||',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text
          .split(job)
          .join(`    if: true || ${job.slice('    if: '.length)}`);
      },
    },
    expected: [{ message: 'must skip a plain-issue issue_comment event' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a second cleanup checkout named in a folded block scalar beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const folded = [
          '      - uses: >-',
          '          actions/checkout@v4',
          '        with:',
          '          fetch-depth: 1',
          '',
        ].join('\n');
        anchored(text, checkout);
        return text.split(checkout).join(folded + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a second cleanup checkout whose action name escapes its slash beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const escaped = `      - "uses": "actions\\/checkout@v4"\n        with:\n          fetch-depth: 1\n`;
        anchored(text, checkout);
        return text.split(checkout).join(escaped + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup step whose name mentions actions/checkout beside the pinned checkout',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n`;
        const named = `      - name: Verify actions/checkout@v4 pin\n        run: echo verified\n`;
        anchored(text, checkout);
        return text.split(checkout).join(named + checkout);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose with: block carries a second quoted ref key beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        anchored(text, ref);
        return text.split(ref).join(`${ref}          "ref": main\n`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout that declares a second quoted with: block after the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        const fetch = '          fetch-depth: 1\n';
        anchored(text, ref + fetch);
        return text
          .split(ref + fetch)
          .join(`${ref}${fetch}        "with":\n          ref: main\n`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a refresh job guard wrapped with a true || prefix does not skip plain issues',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text
          .split(job)
          .join(
            `    if: \${{ true || github.event_name != 'issue_comment' || github.event.issue.pull_request != null }}\n`,
          );
      },
    },
    expected: [{ message: 'must skip a plain-issue issue_comment event' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a refresh job that declares a second if: key after its guard',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text.split(job).join(`${job}    if: true\n`);
      },
    },
    expected: [{ message: 'refresh job must declare exactly one if: key' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a second checkout in a one-line flow mapping whose quoted hash hid its uses key',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const anchor =
          '      - name: Require a merged PR for workflow_dispatch\n';
        const flow = `      - { name: "x #", uses: actions/checkout@v4, with: { ref: "\${{ github.event.pull_request.head.sha }}", fetch-depth: 0 } }\n`;
        anchored(text, anchor);
        return text.split(anchor).join(flow + anchor);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout whose ref input has an upper-case key beside the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        anchored(text, ref);
        return text
          .split(ref)
          .join(
            `${ref}          REF: \${{ github.event.pull_request.head.sha }}\n`,
          );
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup checkout that declares an upper-case WITH block after the pinned one',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const ref = `          ref: \${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || github.sha }}\n`;
        const fetch = '          fetch-depth: 1\n';
        anchored(text, ref + fetch);
        return text
          .split(ref + fetch)
          .join(`${ref}${fetch}        WITH:\n          ref: main\n`);
      },
    },
    expected: [{ prefix: 'checkout must pin ref:' }],
  },
  {
    ruleId: 'RWA005',
    name: 'a refresh job that declares an upper-case IF key after its guard',
    path: ROOT_COMMENT,
    mutation: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text.split(job).join(`${job}    IF: true\n`);
      },
    },
    expected: [{ message: 'refresh job must declare exactly one if: key' }],
  },
  {
    ruleId: 'RWA004',
    name: 'a second checkout whose uses key sits on a flow continuation line that starts with a hash',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const anchor =
          '      - name: Require a merged PR for workflow_dispatch\n';
        const split = `      - { name: "x\n        #", uses: actions/checkout@v4, with: { ref: "\${{ github.event.pull_request.head.sha }}", fetch-depth: 0 } }\n`;
        anchored(text, anchor);
        return text.split(anchor).join(split + anchor);
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
  },
  {
    ruleId: 'RWA004',
    name: 'a cleanup comment that names actions/checkout with a tag is reported',
    path: ROOT_CLEANUP,
    mutation: {
      transform: (text: string) => {
        const anchor =
          '      - name: Require a merged PR for workflow_dispatch\n';
        anchored(text, anchor);
        return text
          .split(anchor)
          .join(
            `      # Pinned: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n${anchor}`,
          );
      },
    },
    expected: [
      {
        message: 'must mention actions/checkout only once, in its pinned step',
      },
    ],
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

// Issue #3752: a violating fixture from each rule family must fail through the CLI
// with its rule ID and relative path, not only when the detector is called directly.
test('the workflow audit CLI reports one violation from each rule family by rule ID and path', () => {
  const ruleIds = [
    'RWA001',
    'RWA002',
    'RWA003',
    'RWA004',
    'RWA005',
    'RWA006',
    'RWA007',
  ] as const;
  for (const ruleId of ruleIds) {
    // The last violating fixture of each family, so the newest rows, which exercise
    // the checks changed in this round, are the ones that run through the CLI.
    const matching = RULE_CASES.filter(
      (candidate) =>
        candidate.ruleId === ruleId && candidate.mutation !== undefined,
    );
    const scenario = matching[matching.length - 1];
    assert.ok(scenario?.mutation, `no violating fixture for ${ruleId}`);
    const root = fixtureRoot({ [scenario.path]: scenario.mutation });
    withRoot(root, () => {
      const result = runCli(root);
      const reported = scenario.violationPath ?? scenario.path;
      assert.equal(result.status, 1, `${ruleId}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes(
          `repository-workflow-audit/${ruleId}: ${reported}: `,
        ),
        `${ruleId}: ${result.stderr}`,
      );
    });
  }
});

for (const scenario of RULE_CASES) {
  test(`${scenario.ruleId} flags ${scenario.name}`, () => {
    const root = fixtureRoot(
      scenario.mutation ? { [scenario.path]: scenario.mutation } : {},
      scenario.omit ?? [],
    );
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

test('a missing advisory-convergence copy is an inspection failure for each rule that reads it', () => {
  const root = fixtureRoot({}, [ROOT_ADVISORY]);
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.deepEqual(
      violations
        .filter((violation) => violation.ruleId === 'RWA006')
        .map(({ ruleId, path, message }) => ({ ruleId, path, message })),
      [
        {
          ruleId: 'RWA006',
          path: ROOT_ADVISORY,
          message: 'required input is missing or unreadable',
        },
      ],
    );
    // The required-check rule reads the copy directly, so it reports the
    // missing input itself. The concurrency rule lists the directory instead,
    // so the absent copy shows up as a shortfall of pull_request workflows.
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'RWA001' &&
          violation.path === ROOT_ADVISORY &&
          violation.message === 'required input is missing or unreadable',
      ),
      'RWA001 must report the missing copy',
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'RWA002' &&
          violation.path === '.github/workflows' &&
          violation.message.startsWith(
            'expected >= 6 pull_request-triggered workflows',
          ),
      ),
      'RWA002 must report the inventory shortfall',
    );
  });
});

test('a missing copy is recorded once per rule, however many checks read it', () => {
  const root = fixtureRoot({}, [ROOT_COMMENT]);
  withRoot(root, () => {
    const findings = collectRepositoryWorkflowViolations(root).filter(
      (violation) => violation.path === ROOT_COMMENT,
    );
    assert.deepEqual(findings, [
      {
        ruleId: 'RWA005',
        path: ROOT_COMMENT,
        message: 'required input is missing or unreadable',
      },
    ]);
  });
});

test('a top-level defaults block after jobs is not counted as a job', () => {
  // A reusable caller with one job stays a single-job workflow even when a
  // top-level defaults block follows the jobs block.
  const path = '.github/workflows/pnpm-boundary-node22-floor.yml';
  const root = fixtureRoot({
    [path]: {
      transform: (text: string) =>
        `${text}\ndefaults:\n  run:\n    shell: bash\n`,
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) => violation.ruleId === 'RWA002'),
      false,
      JSON.stringify(violations),
    );
  });
});

test('a column-zero comment inside the jobs block does not end the job scan', () => {
  // A reusable caller's job count decides its exception, so a column-zero
  // comment right after jobs: must not end the scan before the one job.
  const path = '.github/workflows/pnpm-boundary-node22-floor.yml';
  const root = fixtureRoot({
    [path]: {
      transform: (text: string) => {
        assert.match(text, /\njobs:\n {2}[\w-]+:/);
        return text.replace(
          /\njobs:\n( {2}[\w-]+:)/,
          '\njobs:\n# A column-zero note inside the jobs block.\n$1',
        );
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) => violation.ruleId === 'RWA002'),
      false,
      JSON.stringify(violations),
    );
  });
});

test('an unnamed step after the template notice step is not part of that step', () => {
  const root = fixtureRoot({
    [TEMPLATE_ADVISORY]: {
      transform: (text: string) => {
        const notice = anchored(
          text,
          '- name: Notice when no helper runtime is configured',
        );
        const after = text.indexOf('\n      - ', notice + 1);
        assert.notEqual(
          after,
          -1,
          'fixture anchor not found: the step after the notice',
        );
        return `${text.slice(0, after)}\n      - run: exit 1${text.slice(after)}`;
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) =>
        violation.message.startsWith('notice step must not fail the job'),
      ),
      false,
      JSON.stringify(violations),
    );
  });

  // Positive control: with `exit 1` inside the notice step, the same check
  // must fire. Otherwise the clean result above could come from a check that
  // never reads the notice step.
  const control = fixtureRoot({
    [TEMPLATE_ADVISORY]: {
      from: 'echo "::notice::helperRuntime.profile resolves to instructions-only',
      to: 'exit 1; echo "::notice::helperRuntime.profile resolves to instructions-only',
    },
  });
  withRoot(control, () => {
    const violations = collectRepositoryWorkflowViolations(control);
    assert.equal(
      violations.some((violation) =>
        violation.message.startsWith('notice step must not fail the job'),
      ),
      true,
      JSON.stringify(violations),
    );
  });
});

test('a pull_request workflow saved with a .yaml extension is inventoried', () => {
  // GitHub loads .yaml workflows as well as .yml, so a pull_request .yaml file
  // without an effective cancel-in-progress setting must be reported.
  const root = fixtureRoot();
  const path = '.github/workflows/extra-pr.yaml';
  writeFileSync(
    join(root, path),
    [
      'name: Extra pull request check',
      'on:',
      '  pull_request:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  extra:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ok',
      '',
    ].join('\n'),
  );
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some(
        (violation) => violation.ruleId === 'RWA002' && violation.path === path,
      ),
      true,
      JSON.stringify(violations),
    );
  });
});

test('RWA007 does not count a commented-out setup-node use', () => {
  // A stray comment that names setup-node is not a step, so a healthy copy with
  // one must not fail the four-step inventory.
  const path =
    'idd-template/.github/workflows/idd-advisory-convergence-comment.yml';
  const real = '      - uses: actions/setup-node@v4\n';
  const root = fixtureRoot({
    [path]: {
      transform: (text: string) => {
        anchored(text, real);
        return text
          .split(real)
          .join(`      # - uses: actions/setup-node@v4\n${real}`);
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) => violation.ruleId === 'RWA007'),
      false,
      JSON.stringify(violations),
    );
  });
});

test('RWA006 reads a poster whose run: value starts on the next line', () => {
  // run: may carry its value on the following line. The poster it runs still
  // counts, so that spelling must not be reported as a missing poster.
  const name =
    '      - name: Post the self-referential-bootstrap-auto waiver\n';
  const root = fixtureRoot({
    [ROOT_ADVISORY]: {
      transform: (text: string) => {
        const start = anchored(text, name);
        const run = '        run: |\n';
        const at = text.indexOf(run, start);
        assert.notEqual(at, -1, 'fixture anchor not found: post step run key');
        return `${text.slice(0, at)}        run:\n${text.slice(at + run.length)}`;
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some(
        (violation) =>
          violation.ruleId === 'RWA006' &&
          violation.message ===
            'the post step must run scripts/external-check-waiver.mjs',
      ),
      false,
      JSON.stringify(violations),
    );
  });
});

test('RWA005 accepts a refresh job guard written in the expression wrapper', () => {
  // GitHub accepts an if: expression with or without the ${{ }} wrapper, so a
  // healthy copy written with the wrapper must not fail the guard check.
  const wrapped = `    if: \${{ github.event_name != 'issue_comment' || github.event.issue.pull_request != null }}\n`;
  const root = fixtureRoot({
    [ROOT_COMMENT]: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text.split(job).join(wrapped);
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) => violation.ruleId === 'RWA005'),
      false,
      JSON.stringify(violations),
    );
  });
});

test('RWA005 accepts a refresh job guard written in double quotes', () => {
  // GitHub reads a double-quoted if: value as the same expression, so a healthy
  // copy quoted this way must not fail the guard check.
  const quoted = `    if: "github.event_name != 'issue_comment' || github.event.issue.pull_request != null"\n`;
  const root = fixtureRoot({
    [ROOT_COMMENT]: {
      transform: (text: string) => {
        const job = `    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null\n`;
        anchored(text, job);
        return text.split(job).join(quoted);
      },
    },
  });
  withRoot(root, () => {
    const violations = collectRepositoryWorkflowViolations(root);
    assert.equal(
      violations.some((violation) => violation.ruleId === 'RWA005'),
      false,
      JSON.stringify(violations),
    );
  });
});
