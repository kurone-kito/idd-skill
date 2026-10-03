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
  const startMatch = text.match(new RegExp(`^ {2}${jobId}:$`, 'm'));
  assert.ok(startMatch?.index !== undefined, `job ${jobId} not found`);
  const afterStart = text.slice(startMatch.index + startMatch[0].length);
  const nextSiblingMatch = afterStart.match(/^ {2}\S/m);
  return nextSiblingMatch?.index === undefined
    ? afterStart
    : afterStart.slice(0, nextSiblingMatch.index);
}

/** Extracts one named step's body from a job, stopping before the next
 * step. The exact step header keeps comments or similarly named steps
 * elsewhere in the workflow from satisfying a step-specific guard. */
function extractNamedStepBody(
  text: string,
  jobId: string,
  stepName: string,
): string {
  const jobBody = extractJobBody(text, jobId);
  const lines = jobBody.split('\n');
  const start = lines.indexOf(`      - name: ${stepName}`);
  assert.notEqual(
    start,
    -1,
    `step ${JSON.stringify(stepName)} not found in job ${jobId}`,
  );
  const nextStep = lines.findIndex(
    (line, index) => index > start && /^ {6}- /.test(line),
  );
  return lines.slice(start, nextStep === -1 ? undefined : nextStep).join('\n');
}

/** Removes shell here-document bodies from a script, including multiple
 * redirections on one command and quoted delimiters. The redirection line
 * remains executable; body text and delimiter lines do not. Quoted shell
 * strings, comments, and here-document delimiters are scanned with shell
 * quoting rules so text inside a command argument cannot start a here-doc. */
function excludeHereDocumentBodies(lines: string[]): string[] {
  const executableLines: string[] = [];
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let quote: "'" | '"' | null = null;

  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === current.delimiter) {
        pending.shift();
      }
      continue;
    }

    executableLines.push(line);
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'") {
          quote = null;
        }
        continue;
      }
      if (quote === '"') {
        if (character === '\\') {
          index += 1;
        } else if (character === '"') {
          quote = null;
        }
        continue;
      }

      if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
        break;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (
        character !== '<' ||
        line[index + 1] !== '<' ||
        line[index + 2] === '<'
      ) {
        continue;
      }

      let delimiterStart = index + 2;
      const stripTabs = line[delimiterStart] === '-';
      if (stripTabs) {
        delimiterStart += 1;
      }
      while (/\s/.test(line[delimiterStart] ?? '')) {
        delimiterStart += 1;
      }
      const openingQuote = line[delimiterStart];
      let delimiter: string | undefined;
      let delimiterEnd = delimiterStart;
      if (openingQuote === "'" || openingQuote === '"') {
        delimiterEnd = line.indexOf(openingQuote, delimiterStart + 1);
        if (delimiterEnd !== -1) {
          delimiter = line.slice(delimiterStart + 1, delimiterEnd);
        }
      } else if (openingQuote === '\\') {
        delimiterStart += 1;
        delimiterEnd = delimiterStart;
        while (
          delimiterEnd < line.length &&
          !/[\s;&|()<>]/.test(line[delimiterEnd])
        ) {
          delimiterEnd += 1;
        }
        delimiter = line.slice(delimiterStart, delimiterEnd);
      } else {
        delimiterEnd = delimiterStart;
        while (
          delimiterEnd < line.length &&
          !/[\s;&|()<>]/.test(line[delimiterEnd])
        ) {
          delimiterEnd += 1;
        }
        delimiter = line.slice(delimiterStart, delimiterEnd);
      }
      if (delimiter) {
        pending.push({ delimiter, stripTabs });
        index = delimiterEnd;
      }
    }
  }

  return executableLines;
}

/** Returns the executable lines from a step's literal `run: |` block.
 * YAML comments outside that scalar, shell comments, and here-document
 * body text are excluded before a command-specific assertion runs. */
function executableLinesFromLiteralRun(stepBody: string): string[] {
  const lines = stepBody.split('\n');
  const runStart = lines.findIndex((line) => /^ {8}run: \|[+-]?$/.test(line));
  assert.notEqual(runStart, -1, 'step must have a literal run: | block');

  const scriptLines: string[] = [];
  for (const line of lines.slice(runStart + 1)) {
    if (line.trim() === '') {
      scriptLines.push('');
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= 8) {
      break;
    }
    scriptLines.push(line.slice(10));
  }

  return excludeHereDocumentBodies(scriptLines)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Asserts the named step logs Node before running the existing engine
 * floor assertion. Keeping this pure lets regression tests supply a
 * synthetic step containing non-executable shell text. */
type ShellCommand = { words: string[] };

/** Splits a shell script into basic commands while keeping quoted multiline
 * arguments as one word. This guard only needs simple word boundaries and
 * command separators, not shell expansion or execution. */
function parseShellCommands(lines: string[]): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: "'" | '"' | null = null;

  const finishWord = () => {
    if (wordStarted) {
      words.push(word);
      word = '';
      wordStarted = false;
    }
  };
  const finishCommand = () => {
    finishWord();
    if (words.length > 0) {
      commands.push({ words });
      words = [];
    }
  };

  for (const line of lines) {
    let escapedNewline = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'") {
          quote = null;
        } else {
          word += character;
        }
        continue;
      }
      if (quote === '"') {
        if (character === '"') {
          quote = null;
        } else if (character === '\\' && index + 1 < line.length) {
          index += 1;
          word += line[index];
        } else {
          word += character;
        }
        continue;
      }

      if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
        break;
      }
      if (character === '\\') {
        if (index + 1 === line.length) {
          escapedNewline = true;
        } else {
          index += 1;
          word += line[index];
          wordStarted = true;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        if (!wordStarted) {
          wordStarted = true;
        }
        quote = character;
        continue;
      }
      if (/\s/.test(character)) {
        finishWord();
        continue;
      }
      if (';|&()'.includes(character)) {
        finishCommand();
        continue;
      }
      if (!wordStarted) {
        wordStarted = true;
      }
      word += character;
    }

    if (quote !== null) {
      word += '\n';
    } else if (!escapedNewline) {
      finishCommand();
    }
  }
  finishCommand();
  return commands;
}

function assertNodeVersionLogBeforeFloor(stepBody: string): void {
  const lines = executableLinesFromLiteralRun(stepBody);
  const commands = parseShellCommands(lines);
  const versionLogIndex = commands.findIndex(
    ({ words }) => words[0] === 'node' && words[1] === '--version',
  );
  const floorAssertionIndex = commands.findIndex(
    ({ words }) => words[0] === 'node' && words[1] === '-e',
  );

  assert.notEqual(
    versionLogIndex,
    -1,
    'lint.yml: Assert Node.js floor must execute node --version',
  );
  assert.notEqual(
    floorAssertionIndex,
    -1,
    'lint.yml: Assert Node.js floor must execute its node -e assertion',
  );
  const assertionScript = commands[floorAssertionIndex].words[2] ?? '';
  assert.ok(
    assertionScript.includes(
      'const versionParts = process.versions.node.split(".")',
    ) &&
      assertionScript.includes('const ok =') &&
      assertionScript.includes('if (!ok)') &&
      assertionScript.includes('process.exit(1)'),
    'lint.yml: node -e must retain the Node engines.node floor assertion and its failing path',
  );
  assert.ok(
    versionLogIndex < floorAssertionIndex,
    'lint.yml: node --version must run before the node -e floor assertion',
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
  assertNodeVersionLogBeforeFloor(
    extractNamedStepBody(
      readWorkflow('lint.yml'),
      'lint',
      'Assert Node.js floor',
    ),
  );
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
