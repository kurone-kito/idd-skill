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

const CLEANUP_WORKFLOW_PATH =
  'idd-template/.github/workflows/post-merge-cleanup.yml';

// One `ephemeral-npx|user-global` arm per dispatch site: six in total.
const EXPECTED_ARM_COUNTS: Record<
  (typeof TEMPLATE_WORKFLOW_PATHS)[number],
  number
> = {
  'idd-template/.github/workflows/idd-advisory-convergence.yml': 2,
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml': 3,
  'idd-template/.github/workflows/post-merge-cleanup.yml': 1,
};

// The post-merge cleanup default is a reviewed full commit (issue #4700).
const CLEANUP_PINNED_COMMIT = '966b89c0c925a30d771a3063d6cf0fc628dcc27a';
const CLEANUP_PINNED_SPEC_LINE = `SPEC="\${PACKAGE_SPEC:-https://codeload.github.com/kurone-kito/idd-skill/tar.gz/${CLEANUP_PINNED_COMMIT}}"`;

// The advisory-convergence templates keep the mutable main archive (the
// default adopted in issue #3888; issue #4700 leaves them out of scope).
const ADVISORY_MUTABLE_SPEC_LINE =
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
      if (path === CLEANUP_WORKFLOW_PATH) {
        assert.ok(
          body.includes(CLEANUP_PINNED_SPEC_LINE),
          `${path} user-global arm must default to the pinned reviewed commit`,
        );
      } else {
        assert.match(
          body,
          ADVISORY_MUTABLE_SPEC_LINE,
          `${path} user-global arm must keep the mutable advisory default`,
        );
      }
      assert.match(
        body,
        /npx --yes --package "\$SPEC" /,
        `${path} user-global arm must run the helper through npx --package "$SPEC"`,
      );
    }
  }
});

test('post-merge cleanup names exactly one full-SHA default, never the mutable main archive (#4700)', () => {
  const text = readWorkflow(CLEANUP_WORKFLOW_PATH);
  assert.doesNotMatch(
    text,
    /refs\/heads\/main/,
    'the cleanup workflow must not reference the mutable main archive',
  );
  const pins = [...text.matchAll(/tar\.gz\/([0-9a-f]{40})\}"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    pins,
    [CLEANUP_PINNED_COMMIT],
    'the cleanup workflow must name exactly one full-SHA default',
  );
  const pinnedUrl = `https://codeload.github.com/kurone-kito/idd-skill/tar.gz/${CLEANUP_PINNED_COMMIT}`;
  assert.equal(
    text.split(pinnedUrl).length - 1,
    2,
    'the cleanup workflow must name the pinned archive once in its header and once in its SPEC default',
  );
});

test('the helper-scripts doc names the same reviewed cleanup pin as the workflow (#4700)', () => {
  const doc = readWorkflow('idd-template/docs/idd-helper-scripts.md');
  assert.ok(
    doc.includes(
      `https://codeload.github.com/kurone-kito/idd-skill/tar.gz/${CLEANUP_PINNED_COMMIT}`,
    ),
    'the helper-scripts doc must name the pinned cleanup archive',
  );
});
