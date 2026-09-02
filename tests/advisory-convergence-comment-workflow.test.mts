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
    assert.match(onBlock, /pull_request_review:/);
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
    assert.match(
      text,
      /github\.event\.pull_request\.number\s*\|\|\s*github\.event\.issue\.number/,
      `${path} must resolve PR_NUMBER from either event shape`,
    );
  }
});

test('comment-refresh workflow files exist next to the required copies', () => {
  for (const path of COMMENT_PATHS) {
    assert.ok(readFileSync(`${REPO_ROOT}/${path}`, 'utf8').length > 0);
  }
});
