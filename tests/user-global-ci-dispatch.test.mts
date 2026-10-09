import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The distributed templates are what adopters copy. The repository's own live
// workflows dispatch no profile at all, so they are deliberately not checked.
const TEMPLATE_WORKFLOW_PATHS = [
  'idd-template/.github/workflows/idd-advisory-convergence.yml',
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
] as const;

// One `ephemeral-npx|user-global` arm per dispatch site: six in total.
const EXPECTED_ARM_COUNTS: Record<
  (typeof TEMPLATE_WORKFLOW_PATHS)[number],
  number
> = {
  'idd-template/.github/workflows/idd-advisory-convergence.yml': 2,
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml': 3,
  'idd-template/.github/workflows/post-merge-cleanup.yml': 1,
};

const PINNED_OR_DEFAULT_SPEC =
  /SPEC="\$\{PACKAGE_SPEC:-https:\/\/codeload\.github\.com\/kurone-kito\/idd-skill\/tar\.gz\/refs\/heads\/main\}"/;

function readWorkflow(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test('distributed workflows no longer refuse the user-global profile in CI (#3888)', () => {
  for (const path of TEMPLATE_WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    assert.doesNotMatch(
      text,
      /if \[ "\$PROFILE" = "user-global" \]; then/,
      `${path} must not refuse user-global`,
    );
    assert.doesNotMatch(
      text,
      /operator-local install that CI runners do not have/,
      `${path} must not keep the user-global refusal message`,
    );
  }
});

test('every ephemeral-npx dispatch arm also serves user-global through the same npx line (#3888)', () => {
  for (const path of TEMPLATE_WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    assert.doesNotMatch(
      text,
      /^ +ephemeral-npx\)$/m,
      `${path} must not keep an ephemeral-npx-only dispatch arm`,
    );

    const arms = [
      ...text.matchAll(/^( +)ephemeral-npx\|user-global\)\n([\s\S]*?)^ +;;$/gm),
    ];
    assert.equal(
      arms.length,
      EXPECTED_ARM_COUNTS[path],
      `${path} must dispatch user-global at every ephemeral-npx site`,
    );
    for (const arm of arms) {
      const body = arm[2] ?? '';
      assert.match(
        body,
        PINNED_OR_DEFAULT_SPEC,
        `${path} user-global arm must use the same SPEC default as ephemeral-npx`,
      );
      assert.match(
        body,
        /npx --yes --package "\$SPEC" /,
        `${path} user-global arm must run the helper through npx --package "$SPEC"`,
      );
    }
  }
});
