import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readWorkflow(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

const REQUIRED_PATHS = [
  '.github/workflows/idd-advisory-convergence.yml',
  'idd-template/.github/workflows/idd-advisory-convergence.yml',
] as const;

const COMMENT_PATHS = [
  '.github/workflows/idd-advisory-convergence-comment.yml',
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
] as const;

test('required advisory-convergence workflows keep the required job id', () => {
  for (const path of REQUIRED_PATHS) {
    const text = readWorkflow(path);
    assert.match(
      text,
      /^ {2}idd-advisory-convergence:$/m,
      `${path} must keep job id idd-advisory-convergence`,
    );
  }
});

test('required advisory-convergence workflows no longer trigger on review comments', () => {
  for (const path of REQUIRED_PATHS) {
    const text = readWorkflow(path);
    // The `on:` block must not list pull_request_review_comment as a trigger.
    const onBlock = text.slice(
      text.indexOf('\non:'),
      text.indexOf('\npermissions:'),
    );
    assert.doesNotMatch(
      onBlock,
      /pull_request_review_comment/,
      `${path} on: must not include pull_request_review_comment`,
    );
    assert.doesNotMatch(
      onBlock,
      /issue_comment/,
      `${path} on: must not include issue_comment`,
    );
    assert.match(onBlock, /pull_request:/);
  }
});

// #2764 Phase 1: pull_request_review moved to the companion workflow (a
// PR-edited copy of this file could otherwise control when its own
// required check re-asserts); pull_request_target was added alongside
// the existing pull_request trigger so the implementing PR itself stays
// normally mergeable (pull_request_target cannot fire against its own
// defining PR -- verification of its attachment is deferred to the
// first PR opened after this change merges).
test('required advisory-convergence workflows add pull_request_target and drop pull_request_review', () => {
  for (const path of REQUIRED_PATHS) {
    const text = readWorkflow(path);
    const onBlock = text.slice(
      text.indexOf('\non:'),
      text.indexOf('\npermissions:'),
    );
    assert.doesNotMatch(
      onBlock,
      /(?<!_)pull_request_review:/,
      `${path} on: must not include pull_request_review (moved to the companion workflow)`,
    );
    assert.match(
      onBlock,
      /pull_request_target:/,
      `${path} on: must include pull_request_target`,
    );
    // Still checks out only the trusted default branch, for every
    // trigger including the new one -- see the module-header rationale.
    assert.match(
      text,
      /ref:\s*main/,
      `${path} checkout must stay pinned to ref: main`,
    );
  }
});

test('comment-refresh workflows are non-required and use a different job id', () => {
  for (const path of COMMENT_PATHS) {
    const text = readWorkflow(path);
    assert.doesNotMatch(
      text,
      /^ {2}idd-advisory-convergence:$/m,
      `${path} must not reuse the required job id`,
    );
    assert.match(text, /^ {2}refresh-if-idd-originated:$/m);
    assert.match(text, /pull_request_review_comment:/);
    assert.match(text, /rerun-advisory-convergence/);
    assert.match(text, /review-comment-origin/);
    assert.match(
      text,
      /cancel-in-progress:\s*false/,
      `${path} must not cancel an in-flight IDD refresh`,
    );
  }
});

// #2411: IDD's own operational markers (post-idd-marker.mjs,
// disposition-non-review-notices.mjs) post through the issues-comments
// API (issue_comment events), not the review-comment API -- the
// comment-refresh workflows need this trigger too, plus a guard so a
// comment on a plain issue (not a PR) is a no-op.
test('comment-refresh workflows also trigger on issue_comment and guard non-PR issues', () => {
  for (const path of COMMENT_PATHS) {
    const text = readWorkflow(path);
    assert.match(
      text,
      /issue_comment:/,
      `${path} on: must include issue_comment`,
    );
    assert.match(
      text,
      /github\.event_name\s*!=\s*'issue_comment'\s*\|\|\s*github\.event\.issue\.pull_request\s*!=\s*null/,
      `${path} must skip a plain-issue issue_comment event`,
    );
    // Scope this assertion to the "Rerun required HEAD check" step's own
    // env block -- the concurrency.group expression coincidentally shares
    // the same `pull_request.number || issue.number` substring, so a
    // whole-file match would still pass even if the step's own PR_NUMBER
    // assignment regressed back to the pull_request-only form.
    const rerunStepIndex = text.indexOf('- name: Rerun required HEAD check');
    assert.notEqual(
      rerunStepIndex,
      -1,
      `${path} must have a "Rerun required HEAD check" step`,
    );
    const prNumberAssignment = text
      .slice(rerunStepIndex)
      .match(/PR_NUMBER:\s*\$\{\{\s*([^}]+)\}\}/);
    assert.ok(
      prNumberAssignment,
      `${path} Rerun required HEAD check step must assign PR_NUMBER`,
    );
    assert.match(
      prNumberAssignment[1],
      /github\.event\.pull_request\.number\s*\|\|\s*github\.event\.issue\.number/,
      `${path} PR_NUMBER must resolve from either event shape`,
    );
  }
});

// #2764 Phase 1: pull_request_review submissions now refresh the gate
// through this companion instead of running a PR-controlled copy of the
// gate workflow directly.
test('comment-refresh workflows now trigger on pull_request_review submissions', () => {
  for (const path of COMMENT_PATHS) {
    const text = readWorkflow(path);
    const onBlock = text.slice(
      text.indexOf('\non:'),
      text.indexOf('\npermissions:'),
    );
    assert.match(
      onBlock,
      /pull_request_review:/,
      `${path} on: must include pull_request_review`,
    );
    // The rerun/debounce steps' if: conditions must OR in the review
    // trigger explicitly, not rely on content classification -- a
    // review's own body is not filtered through the IDD-origin marker
    // check the way a comment's is (#2764 review floor: silently
    // routing review events through unchanged idd_originated-only
    // conditions would never actually rerun the gate on a review).
    const rerunIndex = text.indexOf('- name: Rerun required HEAD check');
    assert.notEqual(rerunIndex, -1);
    const rerunStepText = text.slice(
      rerunIndex,
      text.indexOf('\n      - name:', rerunIndex + 1) === -1
        ? undefined
        : text.indexOf('\n      - name:', rerunIndex + 1),
    );
    const ifLine = rerunStepText
      .split('\n')
      .find((line) => line.trim().startsWith('if:'));
    assert.ok(
      ifLine,
      `${path} Rerun required HEAD check step must have an if:`,
    );
    assert.match(
      ifLine as string,
      /github\.event_name\s*==\s*'pull_request_review'/,
      `${path} rerun step's if: must OR in pull_request_review explicitly`,
    );
  }
});

test('comment-refresh workflow files exist next to the required copies', () => {
  for (const path of COMMENT_PATHS) {
    assert.ok(readFileSync(`${REPO_ROOT}/${path}`, 'utf8').length > 0);
  }
});

// #2643: a burst of IDD-originated comments must not exhaust the
// required check's rerun budget by firing --apply once per comment.
test('comment-refresh workflows debounce the rerun call and preserve cancel-in-progress: false', () => {
  for (const path of COMMENT_PATHS) {
    const text = readWorkflow(path);
    assert.match(
      text,
      /- name: Check for newer qualifying event/,
      `${path} must have a "Check for newer qualifying event" debounce step`,
    );
    assert.match(
      text,
      /id:\s*debounce/,
      `${path} debounce step must expose id: debounce`,
    );
    assert.match(
      text,
      /advisory-comment-debounce/,
      `${path} must invoke the advisory-comment-debounce helper`,
    );
    // The debounce step must run (and be able to gate the rerun step)
    // only after classification, not before or in place of it.
    const originIndex = text.indexOf('- name: Classify review comment');
    const debounceIndex = text.indexOf(
      '- name: Check for newer qualifying event',
    );
    const rerunIndex = text.indexOf('- name: Rerun required HEAD check');
    assert.ok(originIndex !== -1 && debounceIndex !== -1 && rerunIndex !== -1);
    assert.ok(
      originIndex < debounceIndex && debounceIndex < rerunIndex,
      `${path} steps must run in order: classify, debounce, rerun`,
    );
    // The rerun step's own `if:` must require both a positive origin
    // classification AND a non-skip debounce verdict -- neither alone
    // is sufficient (#2643 review floor: a debounce step that exists
    // but doesn't actually gate the rerun call would be a no-op fix).
    const rerunStepText = text.slice(
      rerunIndex,
      text.indexOf('\n      - name:', rerunIndex + 1) === -1
        ? undefined
        : text.indexOf('\n      - name:', rerunIndex + 1),
    );
    const ifLine = rerunStepText
      .split('\n')
      .find((line) => line.trim().startsWith('if:'));
    assert.ok(
      ifLine,
      `${path} Rerun required HEAD check step must have an if: condition`,
    );
    assert.match(
      ifLine as string,
      /steps\.origin\.outputs\.idd_originated\s*==\s*'true'/,
      `${path} rerun step's if: must still require idd_originated`,
    );
    assert.match(
      ifLine as string,
      /steps\.debounce\.outputs\.skip\s*!=\s*'true'/,
      `${path} rerun step's if: must require the debounce step did not skip`,
    );
    // #2136's invariant must survive this change unmodified.
    assert.match(
      text,
      /cancel-in-progress:\s*false/,
      `${path} must not cancel an in-flight IDD refresh`,
    );
  }
});

// Codex P1 review, PR #2855: a review superseded by debounce would
// silently downgrade to whatever a later comment-triggered run does
// (plain `--apply`, never `--refresh-latest`), which could leave an
// already-green gate green even though the review added new blocking
// findings. `pull_request_review` must bypass debounce entirely, not
// merely be exempted from the origin-classification half of the gate.
test('comment-refresh workflows never let debounce suppress a pull_request_review rerun', () => {
  for (const path of COMMENT_PATHS) {
    const text = readWorkflow(path);
    const debounceIndex = text.indexOf(
      '- name: Check for newer qualifying event',
    );
    const rerunIndex = text.indexOf('- name: Rerun required HEAD check');
    assert.ok(debounceIndex !== -1 && rerunIndex !== -1);

    const debounceStepText = text.slice(debounceIndex, rerunIndex);
    const debounceIfLine = debounceStepText
      .split('\n')
      .find((line) => line.trim().startsWith('if:'));
    assert.ok(
      debounceIfLine,
      `${path} debounce step must have an if: condition`,
    );
    // Copilot + Codex P1 review, PR #2855: merely not MENTIONING
    // pull_request_review is not enough -- a review body that happens to
    // classify as IDD-originated (it is fed through the same classifier
    // as a comment) would otherwise still satisfy
    // `idd_originated == 'true'` and run this step for a review anyway.
    // The exclusion must be explicit and load-bearing, not incidental.
    assert.match(
      debounceIfLine as string,
      /github\.event_name\s*!=\s*'pull_request_review'/,
      `${path} debounce step's if: must explicitly exclude pull_request_review, not merely omit mentioning it`,
    );

    const rerunStepText = text.slice(
      rerunIndex,
      text.indexOf('\n      - name:', rerunIndex + 1) === -1
        ? undefined
        : text.indexOf('\n      - name:', rerunIndex + 1),
    );
    const rerunIfLine = rerunStepText
      .split('\n')
      .find((line) => line.trim().startsWith('if:'));
    assert.ok(rerunIfLine, `${path} rerun step must have an if: condition`);
    // The pull_request_review disjunct must stand on its own, never
    // conjoined with `steps.debounce.outputs.skip` -- a regex anchored on
    // "pull_request_review' &&...debounce" (in either operand order)
    // would indicate the bypass regressed back to being debounce-gated.
    assert.doesNotMatch(
      rerunIfLine as string,
      /pull_request_review'\s*&&[^|]*debounce/,
      `${path} rerun step's pull_request_review branch must not be gated by debounce.outputs.skip`,
    );
    assert.doesNotMatch(
      rerunIfLine as string,
      /debounce\.outputs\.skip[^|]*&&[^)]*pull_request_review/,
      `${path} rerun step's pull_request_review branch must not be gated by debounce.outputs.skip`,
    );
  }
});

// CodeRabbit review, PR #2855: idd-template's helper-runtime profile
// guard ("Classify review comment" step's own if:) must still apply to
// the debounce and rerun steps even though pull_request_review bypasses
// origin classification -- an instructions-only install has no helper
// runtime to execute either step's run: case statement with, regardless
// of which trigger family reaches it.
test('idd-template comment-refresh workflow keeps the profile/manager guard on debounce and rerun steps', () => {
  const path =
    'idd-template/.github/workflows/idd-advisory-convergence-comment.yml';
  const text = readWorkflow(path);
  const debounceIndex = text.indexOf(
    '- name: Check for newer qualifying event',
  );
  const rerunIndex = text.indexOf('- name: Rerun required HEAD check');
  assert.ok(debounceIndex !== -1 && rerunIndex !== -1);

  const rerunStepText = text.slice(
    rerunIndex,
    text.indexOf('\n      - name:', rerunIndex + 1) === -1
      ? undefined
      : text.indexOf('\n      - name:', rerunIndex + 1),
  );
  const rerunIfLine = rerunStepText
    .split('\n')
    .find((line) => line.trim().startsWith('if:'));
  assert.ok(rerunIfLine, `${path} rerun step must have an if: condition`);
  assert.match(
    rerunIfLine as string,
    /steps\.profile\.outputs\.profile\s*!=\s*'instructions-only'/,
    `${path} rerun step's if: must still exclude instructions-only`,
  );
  assert.match(
    rerunIfLine as string,
    /steps\.manager\.outputs\.manager\s*!=\s*'ambiguous'/,
    `${path} rerun step's if: must still exclude an ambiguous package manager`,
  );
});
