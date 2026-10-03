// Guards two of #2322's acceptance criteria, one of #3665's, and one of
// #3728's against future workflow edits:
// (1) none of the four required status-check workflows ever gains a path
// filter on its pull_request trigger or renames its job id (a path-filtered
// required check never reports for a change outside its filter, which
// blocks every such pull request rather than saving anything); (2) every
// pull_request-triggering workflow keeps some form of concurrency
// cancellation, so a superseded push does not also pay for a stale run;
// (3) both of this repository's own pnpm-boundary lanes keep running on
// ubuntu-latest, while the reusable workflow's declared runner input
// default stays ubuntu-slim for downstream callers (GitHub caps a job on
// the single-CPU ubuntu-slim runner at 15 minutes, which cancelled the
// required check although timeout-minutes was 20).
// (4) the required `lint` job stays on `ubuntu-latest`: issue #3728 recorded
// cancellation annotations for runs 36730573670, 36752800229, and
// 36955823310; the workflow comment preserves their timer ambiguity.
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

/** Every top-level job id declared under `text`'s `jobs:` key (2-space
 * indented `<id>:` lines). Used to verify a "pure reusable-workflow
 * caller" claim structurally: calling a reusable workflow inherits its
 * concurrency only for *that* job, so a sibling job in the same
 * workflow file would keep running uncancelled. */
function jobIds(text: string): string[] {
  const start = text.indexOf('\njobs:');
  assert.ok(start !== -1, 'jobs: block not found');
  const body = text.slice(start + '\njobs:'.length);
  return [...body.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
}

/** Extracts one job's indented body -- the lines from `^  {jobId}:$` up to
 * (but not including) the next 2-space-indented sibling key, or end of
 * file. */
function extractJobBody(text: string, jobId: string): string {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const startIndex = lines.findIndex(
    (line, index) => !scalarContent[index] && line === `  ${jobId}:`,
  );
  assert.notEqual(startIndex, -1, `job ${jobId} not found`);
  const nextSiblingIndex = lines.findIndex(
    (line, index) =>
      index > startIndex && !scalarContent[index] && /^ {2}(?!#)\S/.test(line),
  );
  return lines
    .slice(
      startIndex + 1,
      nextSiblingIndex === -1 ? undefined : nextSiblingIndex,
    )
    .join('\n');
}

/** Marks lines that belong to YAML literal or folded block scalars. The
 * implicit indentation is the first non-empty content line, per YAML's
 * block-scalar rules. */
function yamlBlockScalarContentFlags(lines: string[]): boolean[] {
  const contentFlags = lines.map(() => false);
  let activeContentIndent: number | undefined;
  let pendingHeaderIndent: number | undefined;
  let pendingExplicitContentIndent: number | undefined;

  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (activeContentIndent !== undefined) {
      if (line.trim() === '') {
        contentFlags[index] = true;
        continue;
      }
      if (indent >= activeContentIndent) {
        contentFlags[index] = true;
        continue;
      }
      activeContentIndent = undefined;
    }

    if (pendingHeaderIndent !== undefined) {
      if (line.trim() === '') {
        continue;
      }
      const contentIndent =
        pendingExplicitContentIndent ??
        (indent > pendingHeaderIndent ? indent : undefined);
      pendingHeaderIndent = undefined;
      pendingExplicitContentIndent = undefined;
      if (contentIndent !== undefined && indent >= contentIndent) {
        contentFlags[index] = true;
        activeContentIndent = contentIndent;
        continue;
      }
    }

    const header = line.match(
      /^([ ]*)(?:-\s+)?[^:\n]+:\s*[|>](?:([+-]?[1-9]|[1-9][+-]))?\s*(?:#.*)?$/,
    );
    if (header) {
      pendingHeaderIndent = header[1].length;
      const explicitIndent = header[2]?.match(/[1-9]/)?.[0];
      pendingExplicitContentIndent = explicitIndent
        ? pendingHeaderIndent + Number(explicitIndent)
        : undefined;
    }
  }

  return contentFlags;
}

/** Removes a YAML comment from one line without treating a quoted `#` as
 * a comment marker. */
function stripYamlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === '#' &&
      (index === 0 || /\s/.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Extracts only the root workflow `env` mapping, leaving independent jobs
 * and comments outside the lint job's execution scope. */
function extractWorkflowEnvironmentBlock(text: string): string {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const start = lines.findIndex(
    (line, index) =>
      !scalarContent[index] &&
      /^(?:env|'env'|"env")\s*:/.test(stripYamlComment(line)),
  );
  if (start === -1) {
    return '';
  }

  const header = stripYamlComment(lines[start]);
  const inlineValue = header.match(/^(?:env|'env'|"env")\s*:(.*)$/)?.[1];
  if (inlineValue?.trim()) {
    const value = inlineValue.trim();
    if (value.startsWith('{') || !/^(?:&[^\s]+|![^\s]+)(?:\s|$)/.test(value)) {
      return header;
    }
  }

  const block = [header];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      block.push(line);
      continue;
    }
    if (/^\s/.test(line)) {
      block.push(line);
      continue;
    }
    break;
  }
  return block.join('\n');
}

/** Extracts one named step's body from the job's `steps` mapping, stopping
 * before the next step. Similar headers elsewhere in the job cannot satisfy
 * a step-specific guard. */
function extractNamedStepBody(
  text: string,
  jobId: string,
  stepName: string,
): string {
  const jobBody = extractJobBody(text, jobId);
  const jobLines = jobBody.split('\n');
  const jobScalarContent = yamlBlockScalarContentFlags(jobLines);
  const stepsStart = jobLines.findIndex(
    (line, index) =>
      !jobScalarContent[index] &&
      /^ {4}(?:steps|'steps'|"steps")\s*:/.test(stripYamlComment(line)),
  );
  assert.notEqual(stepsStart, -1, `steps mapping not found in job ${jobId}`);
  const nextJobProperty = jobLines.findIndex(
    (line, index) =>
      index > stepsStart &&
      !jobScalarContent[index] &&
      /^ {4}(?!#)\S/.test(line),
  );
  const lines = jobLines.slice(
    stepsStart + 1,
    nextJobProperty === -1 ? undefined : nextJobProperty,
  );
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const matchingSteps = lines
    .map((line, index) =>
      !scalarContent[index] && line === `      - name: ${stepName}`
        ? index
        : -1,
    )
    .filter((index) => index !== -1);
  assert.equal(
    matchingSteps.length,
    1,
    `expected exactly one step ${JSON.stringify(stepName)} in job ${jobId}, found ${matchingSteps.length}`,
  );
  const start = matchingSteps[0];
  const nextStep = lines.findIndex(
    (line, index) =>
      index > start && !scalarContent[index] && /^ {6}- /.test(line),
  );
  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join('\n');
}

/** Returns the raw lines from a step's literal run block. Keeping comments
 * and shell syntax intact lets the guard compare the whole script against
 * its one supported command shape instead of approximating a shell lexer. */
function literalRunLinesFromStep(stepBody: string): string[] {
  const lines = stepBody.split('\n');
  const runStart = lines.findIndex((line) => /^ {8}run: \|[+-]?$/.test(line));
  assert.notEqual(runStart, -1, 'step must have a literal run: | block');

  const scriptLines: string[] = [];
  let contentIndent: number | undefined;
  for (const line of lines.slice(runStart + 1)) {
    if (line.trim() === '') {
      scriptLines.push('');
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= 8) {
      break;
    }
    if (contentIndent === undefined) {
      contentIndent = indent;
    } else if (indent < contentIndent) {
      break;
    }
    scriptLines.push(line.slice(contentIndent));
  }

  return scriptLines;
}

/** Exact engine-floor assertion expected in the workflow's node -e body. */
const NODE_FLOOR_ASSERTION_LINES = [
  'const versionParts = process.versions.node.split(".");',
  'const [major, minor, patch] = versionParts.map(Number);',
  'const isPrerelease = versionParts.some((part) => part.includes("-"));',
  'const ok = !isPrerelease && ((major === 22 && (minor > 23 || (minor === 23 && patch >= 2))) || (major === 24 && minor >= 2) || major >= 26);',
  'if (!ok) {',
  '  console.error(',
  '    "Node " + process.version + " does not satisfy this " +',
  '    "repository\'s engines.node range (^22.23.2 || ^24.2.0 || >=26.0.0).",',
  '  );',
  '  process.exit(1);',
  '}',
];
const REQUIRED_NODE_FLOOR_ASSERTION = NODE_FLOOR_ASSERTION_LINES.join(' ')
  .replace(/\s+/g, ' ')
  .trim();

function assertNoExecutionPreloads(text: string, scope: string): void {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const usesUnresolvedEnvironmentAlias = lines.some((line, index) => {
    if (scalarContent[index]) {
      return false;
    }
    return /(?:^|[{,])\s*(?:env|'env'|"env")\s*:\s*\*[A-Za-z0-9_.-]+/.test(
      stripYamlComment(line),
    );
  });
  assert.equal(
    usesUnresolvedEnvironmentAlias,
    false,
    'lint.yml: ' +
      scope +
      ' must not use an unresolved env alias because its preload values cannot be verified',
  );

  const configuresOrReferencesPreload = lines.some((line, index) => {
    if (scalarContent[index]) {
      const shellLine = line.trimStart();
      return (
        !shellLine.startsWith('#') &&
        /\b(?:NODE_OPTIONS|BASH_ENV)\b|\bBASH_FUNC_node%%/.test(shellLine)
      );
    }
    const uncommented = stripYamlComment(line);
    return /(?:^|[{,])\s*(?:NODE_OPTIONS|'NODE_OPTIONS'|"NODE_OPTIONS"|BASH_ENV|'BASH_ENV'|"BASH_ENV"|BASH_FUNC_node%%|'BASH_FUNC_node%%'|"BASH_FUNC_node%%")\s*:/.test(
      uncommented,
    );
  });
  assert.equal(
    configuresOrReferencesPreload,
    false,
    `lint.yml: ${scope} must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%, which can bypass the floor assertion`,
  );
}

function assertLintJobEnforcesNodeFloor(jobBody: string): void {
  assertNoExecutionPreloads(jobBody, 'lint job or its steps');
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:if|'if'|"if")\s*:/m,
    'lint.yml: lint job must not be conditionally skipped',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:continue-on-error|'continue-on-error'|"continue-on-error")\s*:/m,
    'lint.yml: lint job must not set continue-on-error',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:needs|'needs'|"needs")\s*:/m,
    'lint.yml: lint job must not depend on a prerequisite that can skip it',
  );
}

const SHELL_ESCAPED_SINGLE_QUOTE = "'\"'\"'";

function assertLintJobUsesDefaultShell(
  jobBody: string,
  workflow: string,
): void {
  assertNoExecutionPreloads(
    extractWorkflowEnvironmentBlock(workflow),
    'workflow environment',
  );
  assert.doesNotMatch(
    workflow,
    /^(?:defaults|'defaults'|"defaults")\s*:/m,
    'lint.yml: workflow must not declare defaults that can override the default shell',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {4}(?:defaults|'defaults'|"defaults")\s*:/m,
    'lint.yml: lint job must not declare defaults that can override the default shell',
  );
  assert.doesNotMatch(
    jobBody,
    /^ {8}(?:shell|'shell'|"shell")\s*:/m,
    'lint.yml: lint job and its steps must not override the default shell',
  );
}

/** Asserts the named step logs Node before running the exact engine-floor
 * assertion. Synthetic steps exercise rejected shell shapes. */
function assertNodeVersionLogBeforeFloor(stepBody: string): void {
  assertNoExecutionPreloads(stepBody, 'Assert Node.js floor step');
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:if|'if'|"if")\s*:/m,
    'lint.yml: Assert Node.js floor step must not be conditionally skipped',
  );
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:continue-on-error|'continue-on-error'|"continue-on-error")\s*:/m,
    'lint.yml: Assert Node.js floor step must not set continue-on-error',
  );
  assert.doesNotMatch(
    stepBody,
    /^ {8}(?:shell|'shell'|"shell")\s*:/m,
    'lint.yml: Assert Node.js floor step must use the default shell',
  );
  const lines = literalRunLinesFromStep(stepBody)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  assert.equal(
    lines[0],
    'node --version',
    'lint.yml: Assert Node.js floor must execute node --version as the first shell command, with stdout visible',
  );
  assert.equal(
    lines[1],
    "node -e '",
    'lint.yml: the Node floor assertion must execute immediately after the version log',
  );
  const closingQuoteIndex = lines.indexOf("'", 2);
  assert.equal(
    closingQuoteIndex,
    lines.length - 1,
    'lint.yml: shell script must not leave a quote open or add commands after the floor assertion',
  );
  const assertionScript = lines
    .slice(2, closingQuoteIndex)
    .join(' ')
    .replaceAll(SHELL_ESCAPED_SINGLE_QUOTE, "'");
  const normalizedAssertionScript = assertionScript.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalizedAssertionScript,
    REQUIRED_NODE_FLOOR_ASSERTION,
    'lint.yml: node -e must retain the Node engines.node floor assertion and its failing path',
  );
}

/** Extracts the indented body of the `key:` line that sits at exactly
 * `indent` spaces in `text`: every following line that is blank or indented
 * deeper than the key, up to the first line that is neither. Asserts the key
 * exists, so a renamed or removed block fails loudly instead of matching
 * nothing. */
function extractKeyBlock(text: string, indent: number, key: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`${' '.repeat(indent)}${key}:`);
  assert.notEqual(start, -1, `${key}: block not found at indent ${indent}`);
  const deeper = ' '.repeat(indent + 1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(deeper)) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
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
    // kurone-kito/idd-skill#3256 (#2764 Phase 2): idd-advisory-convergence.yml
    // dropped its transitional pull_request trigger and now fires only on
    // pull_request_target -- the identical path-filter concern below still
    // applies to that trigger, just under a different key.
    const pullRequestFamilyKey =
      file === 'idd-advisory-convergence.yml'
        ? 'pull_request_target'
        : 'pull_request';
    assert.match(
      onBlock,
      new RegExp(`${pullRequestFamilyKey}:`),
      `${file}: must trigger on ${pullRequestFamilyKey}`,
    );
    assert.doesNotMatch(
      onBlock,
      /\bpaths(-ignore)?:/,
      `${file}: ${pullRequestFamilyKey} trigger must not gain a path filter -- a path-filtered required check never reports for an out-of-filter change`,
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

/** Every workflow file that fires on `pull_request`, PLUS
 * `idd-advisory-convergence.yml` by name (kurone-kito/idd-skill#3256:
 * moved to a `pull_request_target`-only trigger in #2764 Phase 2, but it
 * still re-runs on every push to an open PR -- `synchronize` is one of its
 * declared activity types -- exactly the "a superseded push does not also
 * pay for a stale run" concern this test guards, so it stays in scope even
 * though it no longer matches the generic `pull_request:` scan below) --
 * excluding the PR-comment-triggered advisory-convergence companion, which
 * is pull_request_review_comment-only and already asserted non-cancelling
 * by tests/advisory-convergence-comment-workflow.test.mts. Deliberately
 * NOT a generic `pull_request_target:` scan: `post-merge-cleanup.yml`
 * (`types: [closed]`) and `strip-untrusted-labels.yml` (`types: [labeled]`)
 * also declare `pull_request_target` but never re-run per push, so
 * widening the scan to match the trigger key alone would sweep in two
 * workflows this concern never applied to and that genuinely lack
 * concurrency cancellation. */
function pullRequestTriggeredWorkflowFiles(): string[] {
  const dir = new URL(`../.github/${WORKFLOWS_DIR}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) => {
      if (name === 'idd-advisory-convergence.yml') {
        return true;
      }
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
    // The inherited concurrency only cancels *that* job -- a sibling job
    // in the same workflow file would keep running uncancelled, so the
    // exception applies only when the reusable-workflow call is this
    // file's sole job.
    const ids = jobIds(text);
    assert.equal(
      ids.length,
      1,
      `${file}: calls ${calledFile} as a reusable workflow, but declares ${ids.length} jobs (${ids.join(
        ', ',
      )}) -- inherited concurrency only covers the reusable-workflow job itself, so every sibling job needs its own effective cancel-in-progress`,
    );
    const calledText = readWorkflow(calledFile);
    assert.ok(
      hasEffectiveCancelInProgress(calledText),
      `${file}: calls ${calledFile} as a reusable workflow, but ${calledFile} declares no effective cancel-in-progress for it to inherit`,
    );
  }
});

// #3665: GitHub limits a job on a single-CPU runner such as ubuntu-slim to 15
// minutes, so the required pnpm-boundary job (a suite that can take longer)
// was cancelled at 15m0s although its timeout-minutes was 20. Both of this
// repository's own pull_request lanes must therefore run on ubuntu-latest,
// and they reach it by different paths: the default lane through the literal
// fallback in `runs-on` (the `inputs` context is empty under pull_request),
// the Node 22 floor lane through an explicit `runner` input (a workflow_call
// caller otherwise receives the declared default). The declared default stays
// ubuntu-slim on purpose, so downstream callers keep the documented default.
const SLIM_CAP_NOTE =
  'ubuntu-slim caps a job at 15 minutes, which cancelled the required pnpm-boundary check (#3665)';

test('pnpm-boundary.yml falls back to ubuntu-latest for the default lane of this repository', () => {
  const jobBody = extractJobBody(
    readWorkflow('pnpm-boundary.yml'),
    'pnpm-boundary',
  );
  assert.match(
    jobBody,
    /^ {4}runs-on: \$\{\{ inputs\.runner \|\| 'ubuntu-latest' \}\}$/m,
    `pnpm-boundary.yml: the pnpm-boundary job's runs-on fallback must be ubuntu-latest -- the inputs context is empty under pull_request, so the fallback is the runner the default lane gets, and ${SLIM_CAP_NOTE}`,
  );
});

test('the Node 22 floor lane passes runner: ubuntu-latest to pnpm-boundary.yml', () => {
  const jobBody = extractJobBody(
    readWorkflow('pnpm-boundary-node22-floor.yml'),
    'pnpm-boundary-node22-floor',
  );
  // Anchored to a whole line at the with: entries' indentation, so a comment
  // that merely mentions the runner cannot satisfy it.
  assert.match(
    extractKeyBlock(jobBody, 4, 'with'),
    /^ {6}runner: ["']?ubuntu-latest["']?$/m,
    `pnpm-boundary-node22-floor.yml: the job's with: block must pass runner: ubuntu-latest -- a workflow_call caller otherwise receives the declared ubuntu-slim default, and ${SLIM_CAP_NOTE}`,
  );
});

test('pnpm-boundary.yml keeps ubuntu-slim as the declared runner input default', () => {
  const inputsRunner = extractKeyBlock(
    extractKeyBlock(
      extractKeyBlock(readWorkflow('pnpm-boundary.yml'), 2, 'workflow_call'),
      4,
      'inputs',
    ),
    6,
    'runner',
  );
  assert.match(
    inputsRunner,
    /^ {8}default: ubuntu-slim$/m,
    'pnpm-boundary.yml: inputs.runner.default must stay ubuntu-slim -- the documented default for downstream workflow_call callers in docs/customization.md (#3665)',
  );
});

test('lint.yml keeps the lint job on ubuntu-latest past the ubuntu-slim cap', () => {
  const jobBody = extractJobBody(readWorkflow('lint.yml'), 'lint');
  assert.match(
    jobBody,
    /^ {4}runs-on: ubuntu-latest$/m,
    'lint.yml: the lint job must use ubuntu-latest; ubuntu-slim has a hard 15-minute cap, and issue #3728 recorded cancellation annotations for runs 36730573670, 36752800229, and 36955823310',
  );
});

test('lint.yml logs Node.js version before asserting the Node floor', () => {
  const workflow = readWorkflow('lint.yml');
  const lintJob = extractJobBody(workflow, 'lint');
  assertLintJobEnforcesNodeFloor(lintJob);
  assertLintJobUsesDefaultShell(lintJob, workflow);
  assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
  );
});

test('a conditionally skipped lint job cannot satisfy the Node log guard', () => {
  for (const condition of ['false', '${' + '{ false }}']) {
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(`    if: ${condition}`),
      /lint job must not be conditionally skipped/,
      `accepted job condition: ${condition}`,
    );
  }
});

test('a YAML comment cannot hide a later lint job condition', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    steps:',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    '  # This comment does not end the lint job.',
    '    if: false',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');

  assert.throws(
    () => assertLintJobEnforcesNodeFloor(extractJobBody(workflow, 'lint')),
    /lint job must not be conditionally skipped/,
  );
});

test('a prerequisite-dependent lint job cannot skip the Node floor guard', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    needs: gate'),
    /lint job must not depend on a prerequisite that can skip it/,
  );
});

test('quoted YAML job keys cannot bypass skip or failure guards', () => {
  for (const quote of ["'", '"']) {
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(`    ${quote}if${quote}: false`),
      /lint job must not be conditionally skipped/,
    );
    assert.throws(
      () =>
        assertLintJobEnforcesNodeFloor(
          `    ${quote}continue-on-error${quote}: true`,
        ),
      /lint job must not set continue-on-error/,
    );
  }
});

test('duplicate Node floor step names are rejected as ambiguous', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    steps:',
    '      - name: Assert Node.js floor',
    '        run: node --version',
    '      - name: Assert Node.js floor',
    '        run: node -e "process.exit(1)"',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 2/,
  );
});

test('a YAML block scalar cannot impersonate the named Node floor step', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    fake: |',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    "          node -e '",
    '            process.exit(0);',
    "          '\n",
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 0/,
  );
});

test('a same-named list item outside job.steps cannot impersonate the floor step', () => {
  const workflow = [
    'jobs:',
    '  lint:',
    '    metadata:',
    '      - name: Assert Node.js floor',
    '        run: |',
    '          node --version',
    '          node -e "process.exit(0)"',
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
  ].join('\n');

  assert.throws(
    () => extractNamedStepBody(workflow, 'lint', 'Assert Node.js floor'),
    /expected exactly one step .* found 0/,
  );
});

test('job extraction ignores job-like headers inside YAML block scalars', () => {
  const missingLintJob = [
    'metadata: |',
    '  lint:',
    '    continue-on-error: true',
    'jobs:',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.throws(
    () => extractJobBody(missingLintJob, 'lint'),
    /job lint not found/,
  );

  const actualLintJob = [
    'metadata: |',
    '  lint:',
    '    continue-on-error: true',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '  other:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  const lintJob = extractJobBody(actualLintJob, 'lint');
  assert.match(lintJob, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(lintJob, /continue-on-error/);
});

test('a command inside a quoted here-document cannot satisfy the Node log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    "          : <<'COMMENT'",
    '            node --version',
    '          COMMENT',
    "          node -e '",
    '            process.versions.node.split(".");',
    "          '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('a nine-space shell comment cannot satisfy the Node version log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    '         # node --version',
    "         node -e '",
    '           const versionParts = process.versions.node.split(".");',
    '           const ok = false;',
    '           if (!ok) { process.exit(1); }',
    "         '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('a command inside a multiline shell string cannot satisfy the Node log guard', () => {
  const stepBody = [
    '      - name: Assert Node.js floor',
    '        run: |',
    "          printf '%s\\n' 'example text",
    '          node --version',
    "          still quoted'",
    "          node -e '",
    '            const versionParts = process.versions.node.split(".");',
    '            const ok = false;',
    '            if (!ok) { process.exit(1); }',
    "          '",
  ].join('\n');

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

const SYNTHETIC_FLOOR_ASSERTION = NODE_FLOOR_ASSERTION_LINES;

function syntheticFloorStep(
  shellLines: string[],
  assertionLines = SYNTHETIC_FLOOR_ASSERTION,
): string {
  return [
    '      - name: Assert Node.js floor',
    '        run: |',
    ...shellLines.map((line) => `          ${line}`),
    "          node -e '",
    ...assertionLines.map(
      (line) => `            ${line.replaceAll("'", "'\"'\"'")}`,
    ),
    "          '",
  ].join('\n');
}

test('a conditionally skipped workflow step cannot satisfy the Node log guard', () => {
  for (const condition of ['false', '${' + '{ false }}']) {
    const stepBody = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        if: ${condition}\n        run: |`,
    );

    assert.throws(
      () => assertNodeVersionLogBeforeFloor(stepBody),
      /step must not be conditionally skipped/,
      `accepted step condition: ${condition}`,
    );
  }
});

test('job or step continue-on-error cannot hide a Node floor failure', () => {
  assert.throws(
    () => assertLintJobEnforcesNodeFloor('    continue-on-error: true'),
    /lint job must not set continue-on-error/,
  );

  const stepBody = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        continue-on-error: true\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /floor step must not set continue-on-error/,
  );
});

test('quoted YAML step keys cannot bypass skip or failure guards', () => {
  for (const quote of ["'", '"']) {
    const conditionalStep = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        ${quote}if${quote}: false\n        run: |`,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(conditionalStep),
      /step must not be conditionally skipped/,
    );

    const continueOnErrorStep = syntheticFloorStep(['node --version']).replace(
      '        run: |',
      `        ${quote}continue-on-error${quote}: true\n        run: |`,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(continueOnErrorStep),
      /floor step must not set continue-on-error/,
    );
  }
});

test('custom shell templates cannot skip Node floor execution', () => {
  assert.throws(
    () => assertLintJobUsesDefaultShell('        shell: bash -n {0}', ''),
    /lint job and its steps must not override the default shell/,
  );
  for (const quote of ["'", '"']) {
    assert.throws(
      () =>
        assertLintJobUsesDefaultShell(
          `        ${quote}shell${quote}: bash -n {0}`,
          '',
        ),
      /lint job and its steps must not override the default shell/,
    );
  }
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '    defaults:\n      run:\n        shell: bash -n {0}',
        '',
      ),
    /lint job must not declare defaults/,
  );
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        "    defaults: { run: { shell: 'bash -n {0}' } }",
        '',
      ),
    /lint job must not declare defaults/,
  );
  assert.throws(
    () =>
      assertLintJobUsesDefaultShell(
        '',
        'defaults:\n  run:\n    shell: bash -n {0}',
      ),
    /workflow must not declare defaults/,
  );
  for (const workflow of [
    'defaults: # trailing YAML comment\n  run:\n    shell: bash -n {0}',
    '"defaults" : &lint-defaults\n  run:\n    shell: bash -n {0}',
  ]) {
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflow),
      /workflow must not declare defaults/,
    );
  }
});

test('NODE_OPTIONS and BASH_ENV preloads are rejected at every lint scope', () => {
  const options = '--require=./exit.cjs';
  for (const variable of ['NODE_OPTIONS', 'BASH_ENV']) {
    const assignments = [
      variable + ': ' + options,
      '"' + variable + '": ' + options,
      '{ ' + variable + ': ' + options + ' }',
      '{ CI: true, ' + variable + ': ' + options + ' }',
    ];
    for (const assignment of assignments) {
      const jobEnvironment = assignment.startsWith('{')
        ? '    env: ' + assignment
        : '    env:\n      ' + assignment;
      const workflowEnvironment = assignment.startsWith('{')
        ? 'env: ' + assignment
        : 'env:\n  ' + assignment;
      const stepEnvironment = assignment.startsWith('{')
        ? '        env: ' + assignment
        : '        env:\n          ' + assignment;
      assert.throws(
        () => assertLintJobEnforcesNodeFloor(jobEnvironment),
        /lint job or its steps must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
      );
      assert.throws(
        () => assertLintJobUsesDefaultShell('', workflowEnvironment),
        /workflow environment must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
      );

      const stepBody = syntheticFloorStep(['node --version']).replace(
        '        run: |',
        stepEnvironment + '\n        run: |',
      );
      assert.throws(
        () => assertNodeVersionLogBeforeFloor(stepBody),
        /Assert Node\.js floor step must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
      );
    }

    const scriptWrite =
      'echo ' + variable + '=' + options + ' >> "$GITHUB_ENV"';
    assert.throws(
      () =>
        assertLintJobEnforcesNodeFloor(
          '    steps:\n      - run: |\n          ' + scriptWrite,
        ),
      /lint job or its steps must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
    );
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([scriptWrite])),
      /Assert Node\.js floor step must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
    );
  }
});

test('exported Node shell functions are rejected at every lint scope', () => {
  const functionBody = '() { echo v26.0.0; return 0; }';
  const assignments = [
    `BASH_FUNC_node%%: "${functionBody}"`,
    `"BASH_FUNC_node%%": "${functionBody}"`,
    `{ BASH_FUNC_node%%: "${functionBody}" }`,
    `{ CI: true, "BASH_FUNC_node%%": "${functionBody}" }`,
  ];
  const rejection =
    /must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/;

  for (const assignment of assignments) {
    const jobEnvironment = assignment.startsWith('{')
      ? '    env: ' + assignment
      : '    env:\n      ' + assignment;
    const workflowEnvironment = assignment.startsWith('{')
      ? 'env: ' + assignment
      : 'env:\n  ' + assignment;
    const stepEnvironment = assignment.startsWith('{')
      ? '        env: ' + assignment
      : '        env:\n          ' + assignment;
    assert.throws(
      () => assertLintJobEnforcesNodeFloor(jobEnvironment),
      rejection,
    );
    assert.throws(
      () => assertLintJobUsesDefaultShell('', workflowEnvironment),
      rejection,
    );
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version']).replace(
            '        run: |',
            stepEnvironment + '\n        run: |',
          ),
        ),
      rejection,
    );
  }

  const scriptWrite = `echo 'BASH_FUNC_node%%=${functionBody}' >> "$GITHUB_ENV"`;
  assert.throws(
    () =>
      assertLintJobEnforcesNodeFloor(
        '    steps:\n      - run: |\n          ' + scriptWrite,
      ),
    rejection,
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(syntheticFloorStep([scriptWrite])),
    rejection,
  );
});

test('a workflow env anchor keeps its mapping body in the preload scan', () => {
  for (const variable of ['NODE_OPTIONS', 'BASH_ENV']) {
    assert.throws(
      () =>
        assertLintJobUsesDefaultShell(
          '',
          'env: &lint-env\n  ' + variable + ': --require=./exit.cjs',
        ),
      /workflow environment must not configure or reference NODE_OPTIONS, BASH_ENV, or BASH_FUNC_node%%/,
    );
  }
});

test('unresolved environment aliases are rejected at workflow, job, and step scopes', () => {
  const workflow = [
    'jobs:',
    '  windows:',
    '    env: &windows-env',
    '      BASH_ENV: ./exit.sh',
    '  lint:',
    '    env: *windows-env',
  ].join('\n');
  assert.throws(
    () => assertLintJobEnforcesNodeFloor(extractJobBody(workflow, 'lint')),
    /lint job or its steps must not use an unresolved env alias/,
  );
  assert.throws(
    () => assertLintJobUsesDefaultShell('', 'env: *shared-env'),
    /workflow environment must not use an unresolved env alias/,
  );

  const stepBody = syntheticFloorStep(['node --version']).replace(
    '        run: |',
    '        env: *shared-env\n        run: |',
  );
  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor step must not use an unresolved env alias/,
  );
});

test('comments and an independent workflow job cannot trigger the lint preload guard', () => {
  const workflow = [
    '# NODE_OPTIONS: this comment does not configure the lint job.',
    'jobs:',
    '  lint:',
    '    # NODE_OPTIONS: this comment does not configure the lint job.',
    '    steps:',
    '      - name: Other step',
    '        run: echo ok',
    '  lint-windows:',
    '    env:',
    '      NODE_OPTIONS: --require=./windows-only.cjs',
    '      BASH_ENV: ./windows-only.sh',
  ].join('\n');
  const lintJob = extractJobBody(workflow, 'lint');

  assert.doesNotThrow(() => assertLintJobEnforcesNodeFloor(lintJob));
  assert.doesNotThrow(() => assertLintJobUsesDefaultShell(lintJob, workflow));
});

test('a comment after an escaped newline cannot satisfy the Node log guard', () => {
  const stepBody = syntheticFloorStep(['node --version\\', '# ignored?']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must execute node --version as the first shell command/,
  );
});

test('an unterminated shell quote cannot satisfy the Node floor guard', () => {
  const stepBody = syntheticFloorStep(['node --version']).replace(
    /\n {10}'$/,
    '',
  );

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /shell script must not leave a quote open/,
  );
});

test('redirected or conditional Node commands cannot satisfy the Node log guard', () => {
  for (const shellLines of [
    ['node --version >node-version.txt'],
    ['false && node --version'],
    ['if false', 'then', 'node --version', 'fi'],
    ['output=$(node --version)'],
  ]) {
    assert.throws(
      () => assertNodeVersionLogBeforeFloor(syntheticFloorStep(shellLines)),
      /must execute node --version as the first shell command/,
      `accepted shell lines: ${shellLines.join('\\n')}`,
    );
  }
});

test('a shell comment after a command operator cannot satisfy the Node log guard', () => {
  const stepBody = syntheticFloorStep([':;# node --version']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /Assert Node\.js floor must execute node --version/,
  );
});

test('an earlier shell exit cannot bypass either required Node command', () => {
  const stepBody = syntheticFloorStep(['exit 0', 'node --version']);

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must execute node --version as the first shell command/,
  );
});

test('a constant result cannot replace the Node engines floor comparison', () => {
  const stepBody = syntheticFloorStep(
    ['node --version'],
    [
      'const versionParts = process.versions.node.split(".");',
      'const [major, minor, patch] = versionParts.map(Number);',
      'const ok = true;',
      'if (!ok) { process.exit(1); }',
    ],
  );

  assert.throws(
    () => assertNodeVersionLogBeforeFloor(stepBody),
    /must retain the Node engines\.node floor assertion and its failing path/,
  );
});

test('commented or unreachable JavaScript cannot satisfy the Node floor guard', () => {
  for (const assertionLines of [
    ['/*', ...SYNTHETIC_FLOOR_ASSERTION, '*/'],
    ['process.exit(0);', ...SYNTHETIC_FLOOR_ASSERTION],
  ]) {
    assert.throws(
      () =>
        assertNodeVersionLogBeforeFloor(
          syntheticFloorStep(['node --version'], assertionLines),
        ),
      /must retain the Node engines\.node floor assertion and its failing path/,
    );
  }
});
