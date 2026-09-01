// Guards two of #2322's acceptance criteria against future workflow edits:
// (1) none of the four required status-check workflows ever gains a path
// filter on its pull_request trigger or renames its job id (a path-filtered
// required check never reports for a change outside its filter, which
// blocks every such pull request rather than saving anything); (2) every
// pull_request-triggering workflow keeps some form of concurrency
// cancellation, so a superseded push does not also pay for a stale run.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOWS_DIR = 'workflows';

function readWorkflow(name: string): string {
  return readFileSync(
    new URL(`../.github/${WORKFLOWS_DIR}/${name}`, import.meta.url),
    'utf8',
  );
}

/** Extracts a top-level `concurrency:` block's indented body (the lines
 * immediately following a `^concurrency:$` line), or `null` when no
 * top-level `concurrency:` block exists. */
function extractConcurrencyBlock(text: string): string | null {
  const match = text.match(/^concurrency:\n((?: {2}.*\n)+)/m);
  return match ? match[1] : null;
}

// cancel-in-progress values this repository's own workflows are known to
// use for a genuinely self-cancelling pull_request-scoped concurrency
// group -- a literal `true`, or pnpm-boundary.yml's own conditional
// (documented there as always true for this repository's own
// pull_request-triggered runs). An expression outside this allowlist
// cannot be verified to evaluate true without actually running it, so a
// future workflow using a different conditional must extend this list
// deliberately rather than silently pass a guard that never checked it.
const KNOWN_SAFE_CANCEL_IN_PROGRESS_VALUES = new Set([
  'true',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal YAML/Actions expression matched against workflow text, not a JS template placeholder.
  "${{ startsWith(github.ref, 'refs/pull/') }}",
]);

/** Whether `text`'s top-level `concurrency:` block sets
 * `cancel-in-progress` to a value known to evaluate `true` for this
 * repository's own pull_request-triggered runs -- not merely whether a
 * `concurrency:` key is present, since `false` or an unset (default
 * `false`) value declares a block but cancels nothing. */
function hasEffectiveCancelInProgress(text: string): boolean {
  const block = extractConcurrencyBlock(text);
  if (!block) {
    return false;
  }
  const match = block.match(/^ {2}cancel-in-progress: (.+)$/m);
  return (
    match !== null && KNOWN_SAFE_CANCEL_IN_PROGRESS_VALUES.has(match[1].trim())
  );
}

/** The called workflow's own filename, when `text`'s job body calls a
 * local reusable workflow (`uses: ./.github/workflows/<file>`); `null`
 * otherwise. */
function reusableWorkflowCallTarget(text: string): string | null {
  const match = text.match(
    /\n {4}uses: \.\/\.github\/workflows\/([\w.-]+\.ya?ml)/,
  );
  return match ? match[1] : null;
}

/** Extracts one job's indented body -- the lines from `^  {jobId}:$` up to
 * (but not including) the next 2-space-indented sibling key, or end of
 * file. */
function extractJobBody(text: string, jobId: string): string {
  const startMatch = text.match(new RegExp(`^ {2}${jobId}:$`, 'm'));
  assert.ok(startMatch?.index !== undefined, `job ${jobId} not found`);
  const afterStart = text.slice(startMatch.index + startMatch[0].length);
  const nextSiblingMatch = afterStart.match(/^ {2}\S/m);
  return nextSiblingMatch?.index === undefined
    ? afterStart
    : afterStart.slice(0, nextSiblingMatch.index);
}

/** Same on:-block slice convention as
 * tests/advisory-convergence-comment-workflow.test.mts: every workflow file
 * in this repository places `permissions:` immediately after its `on:`
 * block. */
function extractOnBlock(text: string): string {
  const start = text.indexOf('\non:');
  const end = text.indexOf('\npermissions:');
  assert.ok(
    start !== -1 && end !== -1 && end > start,
    'on:/permissions: block not found',
  );
  return text.slice(start, end);
}

const REQUIRED_CHECKS = [
  { file: 'lint.yml', jobId: 'lint' },
  { file: 'idd-doctor.yml', jobId: 'idd-doctor' },
  { file: 'pnpm-boundary.yml', jobId: 'pnpm-boundary' },
  { file: 'idd-advisory-convergence.yml', jobId: 'idd-advisory-convergence' },
] as const;

test('required-check workflows keep an unfiltered pull_request trigger and their required job id', () => {
  for (const { file, jobId } of REQUIRED_CHECKS) {
    const text = readWorkflow(file);
    const onBlock = extractOnBlock(text);
    assert.match(
      onBlock,
      /pull_request:/,
      `${file}: must trigger on pull_request`,
    );
    assert.doesNotMatch(
      onBlock,
      /\bpaths(-ignore)?:/,
      `${file}: pull_request trigger must not gain a path filter -- a path-filtered required check never reports for an out-of-filter change`,
    );
    assert.match(
      text,
      new RegExp(`^ {2}${jobId}:$`, 'm'),
      `${file}: must keep required job id ${jobId}`,
    );
    // GitHub reports a required status check under the job's effective
    // *display name* -- its own `name:` key when present, the job id
    // otherwise -- so a job-level `name:` addition would silently move
    // the check the ruleset waits on, even though the job id above is
    // unchanged and this test's own id assertion would keep passing.
    const jobBody = extractJobBody(text, jobId);
    assert.doesNotMatch(
      jobBody,
      /^ {4}name:/m,
      `${file}: job ${jobId} must not declare its own display name -- that changes the literal required-status-check context`,
    );
  }
});

/** Every workflow file that fires on `pull_request` -- excluding the
 * PR-comment-triggered advisory-convergence companion, which is
 * pull_request_review_comment-only and already asserted non-cancelling by
 * tests/advisory-convergence-comment-workflow.test.mts. */
function pullRequestTriggeredWorkflowFiles(): string[] {
  const dir = new URL(`../.github/${WORKFLOWS_DIR}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) => {
      const onBlock = extractOnBlock(readWorkflow(name));
      return /^ {2}pull_request:/m.test(onBlock);
    });
}

test('every pull_request-triggering workflow has working concurrency cancellation', () => {
  const files = pullRequestTriggeredWorkflowFiles();
  // Sanity: this must find the six workflows #2322 measured, not an empty
  // or drifted set from a future rename.
  assert.ok(
    files.length >= 6,
    `expected >= 6 pull_request-triggered workflows, found ${files.length}: ${files.join(', ')}`,
  );
  for (const file of files) {
    const text = readWorkflow(file);
    if (hasEffectiveCancelInProgress(text)) {
      continue;
    }
    // pnpm-boundary-node22-floor.yml calls pnpm-boundary.yml as a reusable
    // workflow (`uses: ./.github/workflows/pnpm-boundary.yml`) and declares
    // no concurrency of its own -- it inherits the called workflow's own
    // `concurrency: group: ${{ github.workflow }}-${{ github.ref }}` block,
    // keyed by the *calling* workflow's name within that execution context,
    // so it gets its own distinct group rather than colliding with direct
    // pnpm-boundary.yml runs. Verified empirically against this
    // repository's own run history (workflow id 324862465): historical
    // `cancelled` conclusions exist for this workflow, which could only
    // happen if a newer run's concurrency group evicted an older one.
    //
    // Verify the *called* workflow actually declares an effective
    // cancel-in-progress too -- otherwise a future workflow-call-only
    // caller of a workflow lacking one would silently pass this guard.
    const calledFile = reusableWorkflowCallTarget(text);
    if (!calledFile) {
      assert.fail(
        `${file}: must declare an effective cancel-in-progress concurrency setting, or be a pure reusable-workflow caller that inherits one`,
      );
    }
    const calledText = readWorkflow(calledFile);
    assert.ok(
      hasEffectiveCancelInProgress(calledText),
      `${file}: calls ${calledFile} as a reusable workflow, but ${calledFile} declares no effective cancel-in-progress for it to inherit`,
    );
  }
});
