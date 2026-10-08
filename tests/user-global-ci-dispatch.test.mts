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
    assert.ok(
      arms.length > 0,
      `${path} must dispatch through an ephemeral-npx|user-global arm`,
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
