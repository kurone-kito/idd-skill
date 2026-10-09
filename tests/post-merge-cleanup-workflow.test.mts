import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const WORKFLOW_PATHS = [
  '.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
] as const;

// Fixture directories for the evidence-body tests below, removed at the end.
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      /''\|\*\[!0-9\]\*\)\s*\n\s*echo "::error::[^\n]*"\s*\n\s*exit 1\s*\n\s*;;/,
      `${path} guard step must reject a non-numeric PR_NUMBER with an ::error:: message and exit non-zero, not merely match the glob (#2979 review, Copilot)`,
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
    // A single generic `exit 1` match anywhere in the block would also
    // match the earlier numeric-format branch, so it stays green even if
    // a regression drops `exit 1` from just the lookup-failure or
    // not-merged branch below. Anchor each check to its own branch
    // instead (#2979 review, CodeRabbit).
    assert.match(
      guardBlock,
      /\|\| \{\s*\n\s*echo "::error::[^"]*"\s*\n\s*exit 1\s*\n\s*\}/,
      `${path} guard step must exit non-zero when the gh pr view lookup itself fails`,
    );
    assert.match(
      guardBlock,
      /if \[ "\$STATE" != "MERGED" \]; then\s*\n\s*echo "::error::[^"]*"\s*\n\s*exit 1\s*\n\s*fi/,
      `${path} guard step must exit non-zero when the PR's state is not MERGED`,
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

test('cleanup step timeout is below the job timeout and evidence still runs after it (#3320)', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    const cleanupStart = text.indexOf(
      'name: Run F4 cleanup (server-side fallback)',
    );
    assert.notStrictEqual(
      cleanupStart,
      -1,
      `${path} must define the cleanup step`,
    );
    const evidenceStart = text.indexOf(
      'name: Post cleanup evidence comment',
      cleanupStart,
    );
    assert.notStrictEqual(
      evidenceStart,
      -1,
      `${path} must define the evidence step after cleanup`,
    );
    const beforeCleanup = text.slice(0, cleanupStart);
    const jobTimeouts = [
      ...beforeCleanup.matchAll(/timeout-minutes:\s*(\d+)/g),
    ];
    assert.equal(
      jobTimeouts.length,
      1,
      `${path} must set exactly one job timeout-minutes before the cleanup step`,
    );
    const jobTimeout = Number(jobTimeouts[0]?.[1]);
    const cleanupBlock = text.slice(cleanupStart, evidenceStart);
    const stepTimeoutMatch = cleanupBlock.match(/timeout-minutes:\s*(\d+)/);
    assert.ok(
      stepTimeoutMatch,
      `${path} cleanup step must set timeout-minutes`,
    );
    const stepTimeout = Number(stepTimeoutMatch?.[1]);
    assert.ok(
      stepTimeout < jobTimeout,
      `${path} cleanup timeout ${stepTimeout} must be below job timeout ${jobTimeout}`,
    );
    assert.equal(
      stepTimeout,
      8,
      `${path} cleanup step timeout must be 8 minutes`,
    );
    if (path.startsWith('idd-template/')) {
      assert.match(
        cleanupBlock,
        /if: steps\.profile\.outputs\.profile != 'instructions-only' && steps\.manager\.outputs\.manager != 'ambiguous'/,
        `${path} cleanup step must keep the profile/manager skip guard`,
      );
    }
    const evidence = text.slice(evidenceStart);
    assert.match(
      evidence,
      /if: always\(\) && steps\.cleanup\.outcome != 'skipped'/,
      `${path} evidence step must run on always() unless cleanup was skipped`,
    );
    const evidenceRun = evidence.indexOf('run: |');
    assert.notStrictEqual(
      evidenceRun,
      -1,
      `${path} evidence step must have a run script`,
    );
    const evidenceHeader = evidence.slice(0, evidenceRun);
    assert.match(
      evidenceHeader,
      /PR_NUMBER: \$\{\{ steps\.cleanup\.outputs\.pr_number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \}\}/,
      `${path} evidence PR_NUMBER must fall back to the event expression`,
    );
    const existingGuard = evidence.indexOf('if [ -n "$EXISTING" ]');
    const ghApi = evidence.indexOf('gh api --paginate');
    const emptyPr = evidence.indexOf('if [ -z "$PR_NUMBER" ]');
    const emptyStatus = evidence.indexOf('if [ -z "$STATUS" ]; then');
    const timeoutAssign = evidence.indexOf('STATUS="timeout"', emptyStatus);
    const emptyStatusEnd = evidence.indexOf('\n          fi\n', emptyStatus);
    assert.ok(
      emptyPr !== -1 && emptyPr < ghApi,
      `${path} empty PR_NUMBER exit must precede gh api`,
    );
    assert.ok(
      emptyStatus !== -1 &&
        timeoutAssign > emptyStatus &&
        emptyStatusEnd > timeoutAssign &&
        emptyStatusEnd < existingGuard,
      `${path} STATUS=timeout must be assigned inside the empty-status branch, before the duplicate-evidence skip`,
    );
    const emptyStatusBranch = evidence.slice(emptyStatus, emptyStatusEnd);
    for (const token of [
      'APPLIED=0',
      'FAILED=0',
      'SKIPPED=0',
      'BLOCKED=0',
      'RETRY_ATTEMPTS=0',
      'RETRY_BOUND_EXHAUSTED=false',
      'The cleanup step ended without reporting a status. Counts are zero.',
    ]) {
      assert.ok(
        emptyStatusBranch.includes(token),
        `${path} empty-status branch must include ${token} before the skip guard`,
      );
    }
  }
});

// kurone-kito/idd-skill#3857: the evidence comment carries the per-reason
// skip summary on a Notes row, directly after the Posted by row.
const POST_LINE = `printf '%s' "$BODY" | gh pr comment "$PR_NUMBER" --body-file -`;

/**
 * The evidence step's run block, de-indented. Returns the lines that build the
 * timeout status and the comment body, without the duplicate-evidence lookup
 * (which calls `gh api`), so the body can run in bash with no gh call.
 */
function evidenceBodyScript(text: string): string {
  const lines = text.split('\n');
  const nameIndex = lines.findIndex((line) =>
    line.includes('name: Post cleanup evidence comment'),
  );
  assert.notStrictEqual(nameIndex, -1, 'evidence step must exist');
  const runIndex = lines.findIndex(
    (line, index) => index > nameIndex && line === '        run: |',
  );
  assert.notStrictEqual(runIndex, -1, 'evidence step must have a run block');
  const block: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() !== '' && !line.startsWith('          ')) {
      break;
    }
    block.push(line.slice(10));
  }
  const trimmed = block.map((line) => line.trim());
  const notesStart = trimmed.indexOf('NOTES_ROW=""');
  assert.notStrictEqual(notesStart, -1, 'run block must reset NOTES_ROW');
  const timeoutRow = trimmed.findIndex((line) =>
    line.startsWith('NOTES_ROW="| Notes              | The cleanup step ended'),
  );
  assert.notStrictEqual(timeoutRow, -1, 'run block must keep the timeout row');
  const timeoutEnd = trimmed.findIndex(
    (line, index) => index > timeoutRow && line === 'fi',
  );
  const bodyStart = trimmed.findIndex((line) =>
    line.startsWith('BODY=$(printf'),
  );
  assert.notStrictEqual(bodyStart, -1, 'run block must build BODY');
  const postLine = trimmed.indexOf(POST_LINE);
  assert.notStrictEqual(postLine, -1, 'run block must post the body');
  return [
    ...block.slice(notesStart, timeoutEnd + 1),
    ...block.slice(bodyStart, postLine + 1),
  ].join('\n');
}

/** Run the body segment in bash and return the body it would post. */
function runEvidenceBody(
  text: string,
  env: Record<string, string>,
): { status: number | null; stderr: string; body: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'post-merge-body-'));
  tempDirs.push(workDir);
  const scriptPath = join(workDir, 'evidence-body.sh');
  const bodyOut = join(workDir, 'body.md');
  const script = evidenceBodyScript(text);
  // The posting line writes the body to a file instead of calling gh.
  writeFileSync(
    scriptPath,
    script.replace(POST_LINE, `printf '%s' "$BODY" > "$BODY_OUT"`),
  );
  const result = spawnSync('bash', [scriptPath], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, ...env, BODY_OUT: bodyOut },
  });
  let body = '';
  try {
    body = readFileSync(bodyOut, 'utf8');
  } catch {
    body = '';
  }
  return { status: result.status, stderr: result.stderr, body };
}

test('both workflow copies pass the per-reason summary to the evidence step (#3857)', () => {
  for (const path of WORKFLOW_PATHS) {
    const text = readWorkflow(path);
    assert.match(
      text,
      /SKIP_REASON_SUMMARY=\$\(printf '%s' "\$JSON" \| jq -r '\.skipReasonSummary \/\/ ""'\)/,
      `${path} must read .skipReasonSummary with an empty fallback`,
    );
    assert.match(
      text,
      /echo "skip_reason_summary=\$SKIP_REASON_SUMMARY"/,
      `${path} must write the skip_reason_summary step output`,
    );
    assert.match(
      text,
      /SKIP_REASON_SUMMARY: \$\{\{ steps\.cleanup\.outputs\.skip_reason_summary \}\}/,
      `${path} must pass the step output as SKIP_REASON_SUMMARY`,
    );
    assert.match(
      text,
      /SKIP_REASON_SUMMARY=""\n\s*fi\n/,
      `${path} must leave the summary empty on the helper-error branch`,
    );
    assert.match(
      text,
      /<!-- idd-cleanup-evidence: \$\{STATUS\} applied:/,
      `${path} must keep the marker header line`,
    );
  }
});

const POSIX_ONLY = process.platform === 'win32' && 'needs a POSIX shell';

for (const path of WORKFLOW_PATHS) {
  test(`the evidence body places the Notes row directly after Posted by in ${path} (#3857)`, {
    skip: POSIX_ONLY,
  }, () => {
    const text = readWorkflow(path);
    const base = {
      PR_NUMBER: '7',
      APPLIED: '0',
      FAILED: '0',
      SKIPPED: '2',
      BLOCKED: '0',
      RETRY_ATTEMPTS: '0',
      RETRY_BOUND_EXHAUSTED: 'false',
    };

    const withSummary = runEvidenceBody(text, {
      ...base,
      STATUS: 'applied',
      SKIP_REASON_SUMMARY: 'pr-not-merged 1, thread-superseded-by-reply 2',
    });
    assert.equal(withSummary.status, 0, withSummary.stderr);
    const summaryLines = withSummary.body.split('\n');
    const postedBy = summaryLines.findIndex((line) =>
      line.startsWith('| Posted by'),
    );
    assert.notStrictEqual(postedBy, -1);
    assert.equal(
      summaryLines[postedBy + 1],
      '| Notes              | Skipped by reason: pr-not-merged 1, thread-superseded-by-reply 2 |',
    );

    const withoutSummary = runEvidenceBody(text, {
      ...base,
      STATUS: 'clean',
      SKIP_REASON_SUMMARY: '',
    });
    assert.equal(withoutSummary.status, 0, withoutSummary.stderr);
    assert.doesNotMatch(withoutSummary.body, /\| Notes /);
  });

  test(`the timeout Notes row also sits directly after Posted by in ${path} (#3857)`, {
    skip: POSIX_ONLY,
  }, () => {
    const timeout = runEvidenceBody(readWorkflow(path), {
      PR_NUMBER: '7',
      STATUS: '',
      SKIP_REASON_SUMMARY: '',
    });
    assert.equal(timeout.status, 0, timeout.stderr);
    const lines = timeout.body.split('\n');
    const postedBy = lines.findIndex((line) => line.startsWith('| Posted by'));
    assert.notStrictEqual(postedBy, -1);
    assert.match(
      lines[postedBy + 1] ?? '',
      /^\| Notes {14}\| The cleanup step ended without reporting a status/,
    );
  });
}
