import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { stripGeneratedFromBanner } from '../src/scripts/consistency-helpers.mts';

// The fixed remedy order for a bundle-ceiling breach (#4128) lives in E12 of
// the review-fix instructions, and PR-submit only points at it.
const REVIEW_FIX_COPIES = [
  'idd-template/.github/instructions/idd-review-fix.instructions.md',
  '.github/instructions/idd-review-fix.instructions.md',
];
const PR_SUBMIT_COPIES = [
  'idd-template/.github/instructions/idd-pr-submit.instructions.md',
  '.github/instructions/idd-pr-submit.instructions.md',
];
const TEMPLATE_FILES = [REVIEW_FIX_COPIES[0], PR_SUBMIT_COPIES[0]];

/** The E12 budget-breach block: from its heading to the push paragraph. */
function budgetBreachBlock(path: string): string {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('**Budget breach.**');
  const end = text.indexOf(
    '**Bounded cross-round batching allowance.**',
    start,
  );
  assert.ok(start >= 0 && end > start, `${path} has the budget-breach block`);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

/** Index of each needle in order; fails when one is missing or out of order. */
function assertInOrder(text: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= 0, `"${needle}" appears after offset ${from}`);
    from = at + needle.length;
  }
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} lists the remedy steps in order, with the 95% split in step 2 (#4128)`, () => {
    const block = budgetBreachBlock(path);
    assertInOrder(block, [
      'above 98% of its `limitBytes`',
      '1. Move each obligation the change removes into `docs/idd-helper-scripts.md`',
      'in the same change; a bare link is not a move.',
      'Skip for lite files.',
      'Do not trim shared, terminology-sensitive text.',
      '2. If the bundle is still above 98%, read its base utilization',
      'If its base utilization was below 95%, raise the limit to about 10% above the new total',
      'PR-description callout. No question is asked.',
      'If its base utilization was at or above 95%, stop and ask once',
      'the bundle name, its utilization at the base ref, its bytes after step 1, and the proposed limit with about 10% headroom.',
      'Never commit the raise.',
      'For a per-file cap, apply step 1.',
      '(`phaseLimitBytes`, or `alwaysLoadedLimitBytes` for an always-loaded file), stop and ask once.',
      'Never raise a per-file cap.',
    ]);
    // The 95% split sits inside step 2, not after the per-file rule.
    const stepTwo = block.slice(
      block.indexOf('2. If the bundle is still above 98%'),
      block.indexOf('For a per-file cap'),
    );
    assert.match(stepTwo, /below 95%/);
    assert.match(stepTwo, /at or above 95%/);
  });
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} routes the E12 push through claimed-push, then pushes normally (#4564)`, () => {
    const block = budgetBreachBlock(path);
    assertInOrder(block.slice(block.indexOf('Then push the feature branch')), [
      'Then push the feature branch',
      '`claimed-push` as D2 does',
      'Under `instructions-only`, follow the E12 fallback in `docs/idd-helper-scripts.md`.',
    ]);
  });
}

for (const path of REVIEW_FIX_COPIES) {
  test(`${path} keeps the E11 conflict and merge-failure outcomes (#4864)`, () => {
    const text = readFileSync(path, 'utf8');
    const start = text.indexOf('## E11 ');
    const end = text.indexOf('## E12 ', start);
    assert.ok(start >= 0 && end > start, `${path} has the E11 section`);
    assertInOrder(text.slice(start, end).replace(/\s+/g, ' '), [
      'Continue after a clean resolution;',
      'abort, report, and hold without pushing.',
      '**Merge failure:** run `git merge --abort`, report, and hold on a merge, signing, or hook failure;',
    ]);
  });
}

const LITE_REVIEW_FIX =
  'idd-template/.github/instructions/lite/idd-review-fix-lite.instructions.md';

test(`${LITE_REVIEW_FIX} runs post-fix-validate before the claimed-push steps (#4564)`, () => {
  const text = readFileSync(LITE_REVIEW_FIX, 'utf8');
  const start = text.indexOf('## E12 — Lint, test, push');
  const end = text.indexOf('\n## ', start + 1);
  assert.ok(
    start >= 0 && end > start,
    `${LITE_REVIEW_FIX} has the E12 section`,
  );
  assertInOrder(text.slice(start, end).replace(/\s+/g, ' '), [
    '1. Run `post-fix-validate`.',
    'profile-selected `claimed-push`',
    '`pushed: true`.',
    'Under `instructions-only`, verify the active claim, location, and scope,',
    '**pre-push-validate**, then push normally.',
  ]);
});

for (const path of TEMPLATE_FILES) {
  test(`${path} never names the approval key (#4128)`, () => {
    assert.equal(
      readFileSync(path, 'utf8').includes('nearCeilingRaiseApprovals'),
      false,
    );
  });
}

test('the template ships no audit directory (#4128)', () => {
  assert.equal(existsSync('idd-template/audit'), false);
});

for (const path of PR_SUBMIT_COPIES) {
  test(`${path} stays within the 40,000-byte phase cap and points at the order (#4128)`, () => {
    const text = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(stripGeneratedFromBanner(text), 'utf8');
    assert.ok(bytes <= 40000, `${path} is ${bytes} bytes`);
    assert.match(
      text,
      /A budget breach follows `idd-review-fix\.instructions\.md`'s E12 order\./,
    );
  });
}
