import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOW_PATHS = [
  '.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
] as const;

function readWorkflow(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test("duplicate-evidence-skip guard also requires the current run's own STATUS to be converged (#2213)", () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    const guardStart = text.indexOf('if [ -n "$EXISTING" ]');
    assert.notStrictEqual(
      guardStart,
      -1,
      `${path} must keep the duplicate-evidence-skip guard`,
    );
    const guardEnd = text.indexOf('; then', guardStart);
    assert.notStrictEqual(
      guardEnd,
      -1,
      `${path} guard must be closed with "; then"`,
    );
    const guard = text.slice(guardStart, guardEnd);

    assert.match(
      guard,
      /\[ "\$EXISTING_STATUS" = "applied" \]/,
      `${path} guard must still check the prior comment's EXISTING_STATUS`,
    );
    assert.match(
      guard,
      /\[ "\$STATUS" = "applied" \]/,
      `${path} guard must also check the current run's own STATUS, not only EXISTING_STATUS`,
    );
    assert.match(
      guard,
      /\[ "\$STATUS" = "clean" \]/,
      `${path} guard must also check STATUS = clean, not only EXISTING_STATUS`,
    );
  }
});

test('duplicate-evidence-skip guard is a strict superset of the prior EXISTING_STATUS-only condition', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    // A bare "EXISTING_STATUS = applied" check with no accompanying
    // "STATUS = applied" check anywhere nearby would mean the fix
    // regressed back to comparing only the prior comment's status.
    const skipBlockStart = text.indexOf('# Avoid duplicate evidence comments');
    assert.notStrictEqual(
      skipBlockStart,
      -1,
      `${path} must keep the duplicate-evidence-skip comment block`,
    );
    const skipBlockEnd = text.indexOf('BODY=$(printf', skipBlockStart);
    assert.notStrictEqual(
      skipBlockEnd,
      -1,
      `${path} must keep the BODY=$(printf anchor after the skip block`,
    );
    const skipBlock = text.slice(skipBlockStart, skipBlockEnd);
    const statusMentions = (skipBlock.match(/"\$STATUS"/g) ?? []).length;
    assert.ok(
      statusMentions >= 2,
      `${path} skip block must reference $STATUS at least twice (applied and clean), found ${statusMentions}`,
    );
  }
});

test('workflow_dispatch is guarded to require an already-merged PR before cleanup runs (#2979)', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    const guardStart = text.indexOf(
      'name: Require a merged PR for workflow_dispatch',
    );
    assert.notStrictEqual(
      guardStart,
      -1,
      `${path} must define the workflow_dispatch merged-PR guard step`,
    );
    const cleanupStepStart = text.indexOf(
      'name: Run F4 cleanup (server-side fallback)',
    );
    assert.notStrictEqual(
      cleanupStepStart,
      -1,
      `${path} must still define the F4 cleanup step`,
    );
    assert.ok(
      guardStart < cleanupStepStart,
      `${path} guard step must run before the F4 cleanup step`,
    );
    const guardBlock = text.slice(guardStart, cleanupStepStart);

    assert.match(
      guardBlock,
      /if: github\.event_name == 'workflow_dispatch'/,
      `${path} guard step must be gated on workflow_dispatch`,
    );
    assert.match(
      guardBlock,
      /\*\[!0-9\]\*/,
      `${path} guard step must reject a PR_NUMBER that is not a plain decimal number`,
    );
    assert.match(
      guardBlock,
      /gh pr view "\$PR_NUMBER" --json state --jq \.state/,
      `${path} guard step must look up the dispatched PR's state via a supported gh pr view JSON field (not the unsupported "merged" field, #2979 review)`,
    );
    assert.match(
      guardBlock,
      /"\$STATE" != "MERGED"/,
      `${path} guard step must fail when the PR's state is not MERGED`,
    );
    assert.doesNotMatch(
      guardBlock,
      /--json merged\b/,
      `${path} guard step must not query the unsupported "merged" gh pr view JSON field (#2979 review: this field does not exist and always errors)`,
    );
    assert.match(
      guardBlock,
      /::error::/,
      `${path} guard step must fail with a clear ::error:: message`,
    );
    assert.match(
      guardBlock,
      /\n\s*exit 1\n/,
      `${path} guard step must exit non-zero on an unmerged or unresolvable PR`,
    );
  }
});

test('workflow_dispatch checkout is pinned to the trusted default branch, pull_request_target keeps its own default (#2979)', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    const checkoutStart = text.indexOf('uses: actions/checkout');
    assert.notStrictEqual(
      checkoutStart,
      -1,
      `${path} must keep its actions/checkout step`,
    );
    const fetchDepthStart = text.indexOf('fetch-depth:', checkoutStart);
    assert.notStrictEqual(
      fetchDepthStart,
      -1,
      `${path} checkout step must keep its fetch-depth: input`,
    );
    const checkoutWith = text.slice(checkoutStart, fetchDepthStart);

    assert.match(
      checkoutWith,
      /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.repository\.default_branch \|\| github\.sha \}\}/,
      `${path} checkout must pin ref: to the default branch on workflow_dispatch and fall back to github.sha (the pull_request_target default) otherwise`,
    );
  }
});
