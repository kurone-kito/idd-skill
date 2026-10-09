#!/usr/bin/env node
// idd-generated-from: src/scripts/repository-workflow-audit.mts
//
// The scripts/repository-workflow-audit.mjs copy is generated from this
// source by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Pure, repository-root-parameterized audit of static GitHub Actions
// workflow policy. Each rule family owns the contracts that used to live as
// static assertions in the test suite (issue #3752). The audit reads only
// the repository files it names, makes no network calls, and runs under bare
// Node with no installed dependencies. It is a local validator, not a
// distributed helper command.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './node-runtime-guard.mjs';

const RWA004 = 'RWA004';
const POST_MERGE_CLEANUP_PATHS = [
  '.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
];
// The RWA004 checks below carry over the matchers of the five static tests
// this rule replaced, so a regression those tests caught is still caught.
// Each assertion has a violating fixture in tests/repository-workflow-audit.test.mts.
const EMPTY_STATUS_TOKENS = [
  'APPLIED=0',
  'FAILED=0',
  'SKIPPED=0',
  'BLOCKED=0',
  'RETRY_ATTEMPTS=0',
  'RETRY_BOUND_EXHAUSTED=false',
  'The cleanup step ended without reporting a status. Counts are zero.',
];
function readRequiredText(root, relativePath, ruleId, report) {
  try {
    return readFileSync(resolve(root, relativePath), 'utf8');
  } catch {
    // A missing or unreadable input is an inspection failure, never a clean
    // result, so the rule reports it under its own ID.
    report(ruleId, relativePath, 'required input is missing or unreadable');
    return undefined;
  }
}
function checkDuplicateEvidenceSkipGuard(path, text, report) {
  const guardStart = text.indexOf('if [ -n "$EXISTING" ]');
  if (guardStart === -1) {
    report(RWA004, path, 'must keep the duplicate-evidence-skip guard');
    return;
  }
  const guardEnd = text.indexOf('; then', guardStart);
  if (guardEnd === -1) {
    report(RWA004, path, 'guard must be closed with "; then"');
    return;
  }
  const guard = text.slice(guardStart, guardEnd);
  if (!/\[ "\$EXISTING_STATUS" = "applied" \]/.test(guard)) {
    report(
      RWA004,
      path,
      "guard must still check the prior comment's EXISTING_STATUS",
    );
  }
  if (!/\[ "\$STATUS" = "applied" \]/.test(guard)) {
    report(
      RWA004,
      path,
      "guard must also check the current run's own STATUS, not only EXISTING_STATUS",
    );
  }
  if (!/\[ "\$STATUS" = "clean" \]/.test(guard)) {
    report(
      RWA004,
      path,
      'guard must also check STATUS = clean, not only EXISTING_STATUS',
    );
  }
}
function checkDuplicateEvidenceSkipBlock(path, text, report) {
  const skipBlockStart = text.indexOf('# Avoid duplicate evidence comments');
  if (skipBlockStart === -1) {
    report(RWA004, path, 'must keep the duplicate-evidence-skip comment block');
    return;
  }
  const skipBlockEnd = text.indexOf('BODY=$(printf', skipBlockStart);
  if (skipBlockEnd === -1) {
    report(
      RWA004,
      path,
      'must keep the BODY=$(printf anchor after the skip block',
    );
    return;
  }
  const skipBlock = text.slice(skipBlockStart, skipBlockEnd);
  const statusMentions = (skipBlock.match(/"\$STATUS"/g) ?? []).length;
  if (statusMentions < 2) {
    report(
      RWA004,
      path,
      `skip block must reference $STATUS at least twice (applied and clean), found ${statusMentions}`,
    );
  }
}
// A declared step, read twice: its keys from the declaration view and its run body
// from the token view. A comment cannot supply either, and the step text ends at the
// next step bullet, so text in a neighboring step cannot satisfy these checks.
function declaredStep(text, name) {
  const keys = stepTextNamed(declarationText(text), name);
  const run = stepTextNamed(tokenText(text), name);
  return keys === undefined || run === undefined ? undefined : { keys, run };
}
function checkWorkflowDispatchMergedGuard(path, text, report) {
  const guard = declaredStep(text, 'Require a merged PR for workflow_dispatch');
  if (guard === undefined) {
    report(
      RWA004,
      path,
      'must define the workflow_dispatch merged-PR guard step',
    );
    return;
  }
  const cleanup = declaredStep(text, 'Run F4 cleanup (server-side fallback)');
  if (cleanup === undefined) {
    report(RWA004, path, 'must still define the F4 cleanup step');
    return;
  }
  const declared = declarationText(text);
  if (
    stepOffset(declared, 'Require a merged PR for workflow_dispatch') >=
    stepOffset(declared, 'Run F4 cleanup (server-side fallback)')
  ) {
    report(RWA004, path, 'guard step must run before the F4 cleanup step');
    return;
  }
  // The gate is a declaration, so it is read from the step's keys.
  if (!/if: github\.event_name == 'workflow_dispatch'/.test(guard.keys)) {
    report(RWA004, path, 'guard step must be gated on workflow_dispatch');
  }
  // The checks below read the guard step's own run body, so text in another step
  // cannot satisfy them.
  const guardBlock = guard.run;
  const requirements = [
    [
      /''\|\*\[!0-9\]\*\)\s*\n\s*echo "::error::[^\n]*"\s*\n\s*exit 1\s*\n\s*;;/,
      'guard step must reject a non-numeric PR_NUMBER with an ::error:: message and exit non-zero, not merely match the glob (#2979 review, Copilot)',
    ],
    [
      /gh pr view "\$PR_NUMBER" --json state --jq \.state/,
      'guard step must look up the dispatched PR\'s state via a supported gh pr view JSON field (not the unsupported "merged" field, #2979 review)',
    ],
    [
      /"\$STATE" != "MERGED"/,
      "guard step must fail when the PR's state is not MERGED",
    ],
    [/::error::/, 'guard step must fail with a clear ::error:: message'],
    [
      /\|\| \{\s*\n\s*echo "::error::[^"]*"\s*\n\s*exit 1\s*\n\s*\}/,
      'guard step must exit non-zero when the gh pr view lookup itself fails',
    ],
    [
      /if \[ "\$STATE" != "MERGED" \]; then\s*\n\s*echo "::error::[^"]*"\s*\n\s*exit 1\s*\n\s*fi/,
      "guard step must exit non-zero when the PR's state is not MERGED",
    ],
  ];
  for (const [pattern, message] of requirements) {
    if (!pattern.test(guardBlock)) {
      report(RWA004, path, message);
    }
  }
  if (/--json merged\b/.test(guardBlock)) {
    report(
      RWA004,
      path,
      'guard step must not query the unsupported "merged" gh pr view JSON field (#2979 review: this field does not exist and always errors)',
    );
  }
}
function checkWorkflowDispatchCheckoutRef(path, text, report) {
  // Read as declarations: a commented-out checkout cannot stand in for the real one.
  const declared = declarationText(text);
  // Every checkout counts, in either spelling of a step, so a name-first checkout
  // cannot sit beside the real one unchecked.
  const checkouts = declared
    .split('\n')
    .filter((line) => /^[ \t]*(?:- )?uses: actions\/checkout@/.test(line));
  if (checkouts.length > 1) {
    report(RWA004, path, 'must declare exactly one actions/checkout step');
    return;
  }
  const checkoutStart = declared.search(
    /^[ \t]*(?:- )?uses: actions\/checkout@/m,
  );
  if (checkoutStart === -1) {
    report(RWA004, path, 'must keep its actions/checkout step');
    return;
  }
  // Searched inside the checkout step only, so a later step's fetch-depth
  // cannot satisfy this check.
  const checkoutStep = stepTextFrom(declared, checkoutStart);
  const fetchDepthStart = checkoutStep.indexOf('fetch-depth:');
  if (fetchDepthStart === -1) {
    report(RWA004, path, 'checkout step must keep its fetch-depth: input');
    return;
  }
  const checkoutWith = checkoutStep.slice(0, fetchDepthStart);
  if (
    !/ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.repository\.default_branch \|\| github\.sha \}\}/.test(
      checkoutWith,
    )
  ) {
    report(
      RWA004,
      path,
      'checkout must pin ref: to the default branch on workflow_dispatch and fall back to github.sha (the pull_request_target default) otherwise',
    );
  }
}
function checkEmptyStatusBranch(path, evidence, report) {
  const existingGuard = evidence.indexOf('if [ -n "$EXISTING" ]');
  const ghApi = evidence.indexOf('gh api --paginate');
  const emptyPr = evidence.indexOf('if [ -z "$PR_NUMBER" ]');
  if (!(emptyPr !== -1 && emptyPr < ghApi)) {
    report(RWA004, path, 'empty PR_NUMBER exit must precede gh api');
  }
  const emptyStatus = evidence.indexOf('if [ -z "$STATUS" ]; then');
  const timeoutAssign = evidence.indexOf('STATUS="timeout"', emptyStatus);
  const emptyStatusEnd = evidence.indexOf('\n          fi\n', emptyStatus);
  if (
    !(
      emptyStatus !== -1 &&
      timeoutAssign > emptyStatus &&
      emptyStatusEnd > timeoutAssign &&
      emptyStatusEnd < existingGuard
    )
  ) {
    report(
      RWA004,
      path,
      'STATUS=timeout must be assigned inside the empty-status branch, before the duplicate-evidence skip',
    );
    return;
  }
  const emptyStatusBranch = evidence.slice(emptyStatus, emptyStatusEnd);
  for (const token of EMPTY_STATUS_TOKENS) {
    if (!emptyStatusBranch.includes(token)) {
      report(
        RWA004,
        path,
        `empty-status branch must include ${token} before the skip guard`,
      );
    }
  }
}
function checkCleanupTimeoutAndEvidence(path, text, report) {
  const cleanup = declaredStep(text, 'Run F4 cleanup (server-side fallback)');
  if (cleanup === undefined) {
    report(RWA004, path, 'must define the cleanup step');
    return;
  }
  const evidence = declaredStep(text, 'Post cleanup evidence comment');
  const declared = declarationText(text);
  if (
    evidence === undefined ||
    stepOffset(declared, 'Post cleanup evidence comment') <=
      stepOffset(declared, 'Run F4 cleanup (server-side fallback)')
  ) {
    report(RWA004, path, 'must define the evidence step after cleanup');
    return;
  }
  const jobTimeouts = [
    ...declared
      .slice(0, stepOffset(declared, 'Run F4 cleanup (server-side fallback)'))
      .matchAll(/timeout-minutes:\s*(\d+)/g),
  ];
  if (jobTimeouts.length !== 1) {
    report(
      RWA004,
      path,
      'must set exactly one job timeout-minutes before the cleanup step',
    );
    return;
  }
  const jobTimeout = Number(jobTimeouts[0]?.[1]);
  const stepTimeoutMatch = cleanup.keys.match(/timeout-minutes:\s*(\d+)/);
  if (!stepTimeoutMatch) {
    report(RWA004, path, 'cleanup step must set timeout-minutes');
    return;
  }
  const stepTimeout = Number(stepTimeoutMatch[1]);
  if (!(stepTimeout < jobTimeout)) {
    report(
      RWA004,
      path,
      `cleanup timeout ${stepTimeout} must be below job timeout ${jobTimeout}`,
    );
  }
  if (stepTimeout !== 8) {
    report(RWA004, path, 'cleanup step timeout must be 8 minutes');
  }
  if (
    path.startsWith('idd-template/') &&
    !/if: steps\.profile\.outputs\.profile != 'instructions-only' && steps\.manager\.outputs\.manager != 'ambiguous'/.test(
      cleanup.keys,
    )
  ) {
    report(
      RWA004,
      path,
      'cleanup step must keep the profile/manager skip guard',
    );
  }
  if (
    !/if: always\(\) && steps\.cleanup\.outcome != 'skipped'/.test(
      evidence.keys,
    )
  ) {
    report(
      RWA004,
      path,
      'evidence step must run on always() unless cleanup was skipped',
    );
  }
  const evidenceRun = evidence.run.indexOf('run: |');
  if (evidenceRun === -1) {
    report(RWA004, path, 'evidence step must have a run script');
    return;
  }
  const evidenceHeader = evidence.keys.slice(
    0,
    evidence.keys.indexOf('run: |'),
  );
  if (
    !/PR_NUMBER: \$\{\{ steps\.cleanup\.outputs\.pr_number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \}\}/.test(
      evidenceHeader,
    )
  ) {
    report(
      RWA004,
      path,
      'evidence PR_NUMBER must fall back to the event expression',
    );
  }
  checkEmptyStatusBranch(path, evidence.run, report);
}
function checkPostMergeCleanupWorkflows(root, report) {
  for (const path of POST_MERGE_CLEANUP_PATHS) {
    const text = readRequiredText(root, path, RWA004, report);
    if (text === undefined) {
      continue;
    }
    checkDuplicateEvidenceSkipGuard(path, text, report);
    checkDuplicateEvidenceSkipBlock(path, text, report);
    checkWorkflowDispatchMergedGuard(path, text, report);
    checkWorkflowDispatchCheckoutRef(path, text, report);
    checkCleanupTimeoutAndEvidence(path, text, report);
  }
}
const RWA006 = 'RWA006';
const SELF_WAIVER_WORKFLOW_PATHS = [
  '.github/workflows/idd-advisory-convergence.yml',
  'idd-template/.github/workflows/idd-advisory-convergence.yml',
];
const SELF_WAIVER_CONSTANTS_PATH = 'src/scripts/advisory-convergence.mts';
// Reads one string constant from the verifier's source text. Importing the
// verifier would run its module graph, which loads the schema validator and
// resolves the repository layout, so the audit reads the declaration instead.
// A declaration that does not match fails closed. Only a declaration that starts
// a line counts, so a comment that repeats it cannot supply the value, and a
// repeated declaration makes the constant unreadable instead of letting one copy
// win.
function readStringConstant(source, name) {
  const matches = [
    ...source.matchAll(
      new RegExp(`^export const ${name} =\\s*'([^']*)';`, 'gm'),
    ),
  ];
  return matches.length === 1 ? matches[0][1] : undefined;
}
// Structure only: the lines of a workflow with comment lines removed, and the
// body of every block scalar (`key: |` or `key: >`) blanked. A block scalar's
// body is text, not YAML structure, so its shell or script braces and
// backslashes neither trip nor hide a structural check. Every other line,
// including the rest of a line that carries a key, stays in view.
function structuralLines(text) {
  const out = [];
  let blockColumn;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) {
      continue;
    }
    if (
      blockColumn !== undefined &&
      (line.trim() === '' || indentOf(line) > blockColumn)
    ) {
      out.push('');
      continue;
    }
    blockColumn = undefined;
    if (/:\s*[|>][-+0-9]*\s*$/.test(line.replace(/\s+#.*$/, ''))) {
      blockColumn = line.search(/[^\s-]/);
    }
    out.push(line);
  }
  return out;
}
function indentOf(line) {
  return line.length - line.trimStart().length;
}
// The canonical spellings of the action lines a required gate may contain. Any
// other `uses` key is reported, whatever its spelling.
const CHECKOUT_USES = /^ {6}- uses: actions\/checkout@\S+( # .*)?$/;
const UPLOAD_USES = /^ {8}uses: actions\/upload-artifact@\S+( # .*)?$/;
const CANONICAL_USES = [
  CHECKOUT_USES,
  /^ {6}- uses: actions\/setup-node@\S+( # .*)?$/,
  UPLOAD_USES,
];
// The `uses` key in any spelling: quotes are dropped and case is folded, so
// `"uses" :` and `Uses:` count too. Escapes are excluded by the backslash check.
function isUsesKey(line) {
  return /\buses\s*:/.test(line.replace(/["']/g, '').toLowerCase());
}
// The lines of a step after its first line: blank lines and lines indented
// deeper than the six-space dash column.
function stepLines(lines, start) {
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) < 7) {
      break;
    }
    out.push(line);
  }
  return out;
}
// The children of a step's single `with:` key, which must be spelled exactly
// `        with:`. Undefined when the step has none, or more than one spelling.
function withChildren(step) {
  const headers = step.filter((line) =>
    /\bwith\s*:/.test(line.replace(/["']/g, '').toLowerCase()),
  );
  const at = step.indexOf('        with:');
  if (headers.length !== 1 || at === -1) {
    return undefined;
  }
  const children = [];
  for (const line of step.slice(at + 1)) {
    if (line.trim() === '') {
      continue;
    }
    if (indentOf(line) < 9) {
      break;
    }
    children.push(line);
  }
  return children;
}
// The upload step of a job, read in its canonical spelling only: the uses line
// and the step's own keys at eight spaces, and the with: keys at ten. An `if:`
// can only skip the upload, never rename or add an artifact, so it is allowed.
const UPLOAD_STEP_KEYS = [UPLOAD_USES, /^ {8}with:$/, /^ {8}if: .+$/];
const UPLOAD_WITH_KEYS = [
  /^ {10}name: .+$/,
  /^ {10}path: .+$/,
  /^ {10}if-no-files-found: \w+$/,
];
// Whether the job's single upload step declares the artifact prefix as the
// value of its own `name:` key. An env name, an extra step key, or a second
// upload step cannot satisfy this. The file-wide count of uploads is checked
// in checkCheckoutSurface, so the verifier cannot trust an upload elsewhere.
function declaresArtifactName(jobBody, prefix) {
  const lines = structuralLines(jobBody);
  const uploads = lines.flatMap((line, index) =>
    UPLOAD_USES.test(line) ? [index] : [],
  );
  if (uploads.length !== 1) {
    return false;
  }
  let start = uploads[0];
  while (start >= 0 && !/^ {6}- /.test(lines[start])) {
    start -= 1;
  }
  if (start < 0 || !/^ {6}- name: /.test(lines[start])) {
    return false;
  }
  const step = stepLines(lines, start);
  const keys = step.filter(
    (line) => line.trim() !== '' && indentOf(line) === 8,
  );
  const children = withChildren(step);
  if (
    !keys.every((line) => UPLOAD_STEP_KEYS.some((form) => form.test(line))) ||
    children === undefined ||
    !children.every((line) => UPLOAD_WITH_KEYS.some((form) => form.test(line)))
  ) {
    return false;
  }
  const names = children.filter((line) => /^ {10}name:/.test(line));
  return names.length === 1 && names[0].startsWith(`          name: ${prefix}`);
}
// The run: body of a step: from its run: key to the next key at the step's own
// indentation. A poster name in an env: or if: key, before or after run:, does not run.
function runBodyOf(stepText) {
  const start = stepText.search(/^ {8}run:(?: |$)/m);
  if (start === -1) {
    return '';
  }
  const rest = stepText.slice(start);
  const next = rest.search(/\n {8}\S/);
  return next === -1 ? rest : rest.slice(0, next);
}
// The waiver poster the self-waiver post step must run.
const WAIVER_POSTER = 'scripts/external-check-waiver.mjs';
// Both copies must keep the self-waiver job id, post-step name, and artifact
// prefix that the waiver provenance verifier reads, so a rename in one copy
// cannot silently break the waiver check.
function checkSelfReferentialWaiverConstants(root, report) {
  const source = readRequiredText(
    root,
    SELF_WAIVER_CONSTANTS_PATH,
    RWA006,
    report,
  );
  if (source === undefined) {
    return;
  }
  const jobId = readStringConstant(source, 'SELF_REFERENTIAL_WAIVER_JOB_ID');
  const postStepName = readStringConstant(
    source,
    'SELF_REFERENTIAL_WAIVER_POST_STEP_NAME',
  );
  const artifactNamePrefix = readStringConstant(
    source,
    'SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX',
  );
  for (const [name, value] of [
    ['SELF_REFERENTIAL_WAIVER_JOB_ID', jobId],
    ['SELF_REFERENTIAL_WAIVER_POST_STEP_NAME', postStepName],
    ['SELF_REFERENTIAL_WAIVER_ARTIFACT_NAME_PREFIX', artifactNamePrefix],
  ]) {
    if (value === undefined) {
      report(
        RWA006,
        SELF_WAIVER_CONSTANTS_PATH,
        `could not read ${name} from ${SELF_WAIVER_CONSTANTS_PATH}`,
      );
    }
  }
  if (
    jobId === undefined ||
    postStepName === undefined ||
    artifactNamePrefix === undefined
  ) {
    return;
  }
  for (const path of SELF_WAIVER_WORKFLOW_PATHS) {
    const workflow = readRequiredText(root, path, RWA006, report);
    if (workflow === undefined) {
      continue;
    }
    // Declarations, read from the job the verifier reads. A comment, another
    // job, or another step that repeats the same text cannot satisfy these.
    const jobBody = jobBlocks(workflow)?.get(jobId);
    if (jobBody === undefined) {
      report(
        RWA006,
        path,
        'no longer declares the expected self-waiver job id',
      );
      continue;
    }
    // The name labels exactly one step, and that step runs the waiver poster, so a
    // second step with the same name, or a renamed poster, cannot satisfy the check.
    const labelled = structuralLines(jobBody).filter(
      (line) => line.trimEnd() === `      - name: ${postStepName}`,
    ).length;
    if (labelled === 0) {
      report(RWA006, path, 'no longer declares the expected post-step name');
    } else if (labelled > 1) {
      report(
        RWA006,
        path,
        'must declare the expected post-step name exactly once',
      );
    } else if (
      !runBodyOf(
        stepTextNamed(tokenText(jobBody), postStepName) ?? '',
      ).includes(WAIVER_POSTER)
    ) {
      report(RWA006, path, `the post step must run ${WAIVER_POSTER}`);
    }
    if (!declaresArtifactName(jobBody, artifactNamePrefix)) {
      report(
        RWA006,
        path,
        'no longer declares the expected artifact-name prefix',
      );
    }
  }
}
const RWA007 = 'RWA007';
const TEMPLATE_SETUP_NODE_PATHS = [
  'idd-template/.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/idd-advisory-convergence.yml',
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
];
const DETECT_PACKAGE_MANAGER_STEP_START =
  '      - name: Detect package manager\n';
const STEP_BOUNDARY_AFTER_DETECT = /\n {6}- name: /;
const STEP_BOUNDARY = '\n      - ';
// The keys a checkout's with: block may carry. A repository key, a quoted key,
// or a second ref is not on this list, so it fails the pinned-ref contract.
const CHECKOUT_WITH_KEYS = [
  /^ {10}ref: main$/,
  /^ {10}fetch-depth: \d+$/,
  /^ {10}persist-credentials: (true|false)$/,
];
// The advisory jobs that run the gate and its self-waiver. Each one must declare
// its own checkout, so a checkout left in another job cannot stand in for it.
const ADVISORY_CHECKOUT_JOBS = [
  'idd-advisory-convergence',
  'idd-advisory-convergence-self-waiver',
];
// Checks each checkout step of a required gate on its own. A spelling the audit
// cannot read is reported, so an escape, a complex key, a third-party action,
// or an extra key in a checkout step cannot hide a checkout.
function checkCheckoutSurface(path, text, report) {
  const lines = structuralLines(text);
  // A flow collection can hide a key on a line that reads as text, so flow
  // syntax is refused in the jobs section. Expressions are removed first, since
  // their braces are not flow syntax.
  const jobsAt = lines.indexOf('jobs:');
  if (
    lines
      .slice(jobsAt === -1 ? 0 : jobsAt)
      .some((line) => /[[\]{}]/.test(line.replace(/\$\{\{.*?\}\}/g, '')))
  ) {
    report(RWA005, path, 'flow collections cannot be read by this audit');
    return;
  }
  // The verifier trusts a prefixed artifact anywhere in the run, so the gate
  // may declare exactly one upload in the whole file.
  const uploads = lines.filter((line) => UPLOAD_USES.test(line));
  if (uploads.length !== 1) {
    report(
      RWA005,
      path,
      'a required gate may declare only its self-waiver upload',
    );
    return;
  }
  if (lines.some((line) => line.includes('\\'))) {
    report(
      RWA005,
      path,
      'a backslash outside run: blocks cannot be read by this audit',
    );
    return;
  }
  if (lines.some((line) => /^\s*(?:- +)?\?/.test(line))) {
    report(RWA005, path, 'complex mapping keys cannot be read by this audit');
    return;
  }
  if (
    lines
      .filter(isUsesKey)
      .some((line) => !CANONICAL_USES.some((form) => form.test(line)))
  ) {
    report(
      RWA005,
      path,
      'uses must name a recognized action in its canonical form',
    );
    return;
  }
  const checkouts = lines.flatMap((line, index) =>
    CHECKOUT_USES.test(line) ? [index] : [],
  );
  if (checkouts.length === 0) {
    report(RWA005, path, 'no actions/checkout step to pin to ref: main');
    return;
  }
  for (const index of checkouts) {
    const step = stepLines(lines, index);
    const keys = step.filter(
      (line) => line.trim() !== '' && indentOf(line) === 8,
    );
    const children = withChildren(step);
    const pinned =
      keys.length === 1 &&
      children !== undefined &&
      children.every((line) =>
        CHECKOUT_WITH_KEYS.some((form) => form.test(line)),
      ) &&
      children.filter((line) => /^ {10}ref:/.test(line)).length === 1 &&
      children.includes('          ref: main');
    if (!pinned) {
      report(RWA005, path, 'checkout must stay pinned to ref: main');
      return;
    }
  }
  for (const jobId of ADVISORY_CHECKOUT_JOBS) {
    const body = jobBlocks(text)?.get(jobId);
    if (
      body === undefined ||
      !structuralLines(body).some((line) => CHECKOUT_USES.test(line))
    ) {
      report(RWA005, path, `${jobId} must declare its own checkout`);
    }
  }
}
const SETUP_NODE_STEP_COUNT = 4;
// The RWA007 checks share one read of each template copy, so a missing copy is
// reported once rather than once per check.
function readTemplateSetupNodeInputs(root, report) {
  const inputs = new Map();
  for (const path of TEMPLATE_SETUP_NODE_PATHS) {
    const text = readRequiredText(root, path, RWA007, report);
    if (text !== undefined) {
      inputs.set(path, text);
    }
  }
  return inputs;
}
// Every copy of the "Detect package manager" step body must match the first
// copy byte for byte, so the three template workflows cannot drift apart.
function checkDetectPackageManagerStepsAgree(inputs, report) {
  const bodies = [];
  for (const path of TEMPLATE_SETUP_NODE_PATHS) {
    const text = inputs.get(path);
    if (text === undefined) {
      continue;
    }
    const startIndex = text.indexOf(DETECT_PACKAGE_MANAGER_STEP_START);
    if (startIndex === -1) {
      report(RWA007, path, 'expected to find a "Detect package manager" step');
      continue;
    }
    const afterStart = text.slice(
      startIndex + DETECT_PACKAGE_MANAGER_STEP_START.length,
    );
    const endIndex = afterStart.search(STEP_BOUNDARY_AFTER_DETECT);
    if (endIndex === -1) {
      report(
        RWA007,
        path,
        'expected a step boundary after "Detect package manager"',
      );
      continue;
    }
    bodies.push({ path, body: afterStart.slice(0, endIndex) });
  }
  const reference = bodies.find(
    ({ path }) => path === TEMPLATE_SETUP_NODE_PATHS[0],
  );
  if (reference === undefined) {
    return;
  }
  for (const other of bodies) {
    if (other.path !== reference.path && other.body !== reference.body) {
      report(
        RWA007,
        other.path,
        `"Detect package manager" step body drifted from ${reference.path}`,
      );
    }
  }
}
function stepIfCondition(stepText) {
  const match = /^ {8}if: (.+)$/m.exec(stepText);
  return match?.[1].trim();
}
function stepName(stepText) {
  const [firstLine] = stepText.split('\n', 1);
  const match = /^ {6}- name: (.+)$/.exec(firstLine ?? '');
  return match?.[1].trim();
}
// Each actions/setup-node step must pin check-latest, be immediately followed
// by an "Assert Node.js floor" step, and share its if: condition. The three
// template files must contain exactly SETUP_NODE_STEP_COUNT such steps.
function checkSetupNodeSteps(inputs, report) {
  let totalSetupNodeSteps = 0;
  for (const path of TEMPLATE_SETUP_NODE_PATHS) {
    const raw = inputs.get(path);
    if (raw === undefined) {
      continue;
    }
    // Read as declarations: a commented-out use, or one inside a run body, is not a step.
    const content = declarationText(raw);
    let searchFrom = 0;
    for (;;) {
      const usesIndex = content.indexOf(
        'uses: actions/setup-node@',
        searchFrom,
      );
      if (usesIndex === -1) {
        break;
      }
      searchFrom = usesIndex + 1;
      totalSetupNodeSteps += 1;
      const stepStartIndex = content.lastIndexOf(STEP_BOUNDARY, usesIndex);
      if (stepStartIndex === -1) {
        report(
          RWA007,
          path,
          `could not find the step bullet enclosing the actions/setup-node use at offset ${usesIndex}`,
        );
        continue;
      }
      const stepStart = stepStartIndex + 1;
      const nextStepIndex = content.indexOf(STEP_BOUNDARY, usesIndex);
      if (nextStepIndex === -1) {
        report(
          RWA007,
          path,
          `expected a step after the actions/setup-node step at offset ${usesIndex}`,
        );
        continue;
      }
      const nextStepStart = nextStepIndex + 1;
      const stepAfterNextIndex = content.indexOf(STEP_BOUNDARY, nextStepStart);
      const stepAfterNextStart =
        stepAfterNextIndex === -1 ? content.length : stepAfterNextIndex + 1;
      const setupNodeStep = content.slice(stepStart, nextStepStart);
      const followingStep = content.slice(nextStepStart, stepAfterNextStart);
      if (!/\n {10}check-latest: true\n/.test(setupNodeStep)) {
        report(
          RWA007,
          path,
          `the actions/setup-node step at offset ${usesIndex} is missing \`check-latest: true\``,
        );
      }
      if (stepName(followingStep) !== 'Assert Node.js floor') {
        report(
          RWA007,
          path,
          `the step immediately after actions/setup-node at offset ${usesIndex} must be named "Assert Node.js floor"`,
        );
      }
      if (stepIfCondition(followingStep) !== stepIfCondition(setupNodeStep)) {
        report(
          RWA007,
          path,
          `"Assert Node.js floor"'s if: must equal its actions/setup-node step's if: (offset ${usesIndex})`,
        );
      }
    }
  }
  if (
    inputs.size === TEMPLATE_SETUP_NODE_PATHS.length &&
    totalSetupNodeSteps !== SETUP_NODE_STEP_COUNT
  ) {
    report(
      RWA007,
      'idd-template/.github/workflows',
      `expected exactly ${SETUP_NODE_STEP_COUNT} actions/setup-node steps across the three idd-template workflow files (idd-skill#3240); update this count alongside a deliberate step-count change`,
    );
  }
}
const RWA001 = 'RWA001';
const RWA002 = 'RWA002';
const RWA003 = 'RWA003';
const WORKFLOWS_DIRECTORY = '.github/workflows';
const SLIM_CAP_NOTE =
  'ubuntu-slim caps a job at 15 minutes, which cancelled the required pnpm-boundary check (#3665)';
// Required status checks. Each job id and trigger must stay fixed, because
// the ruleset waits on the display name GitHub derives from them.
const REQUIRED_CHECKS = [
  { file: 'lint.yml', jobId: 'lint' },
  { file: 'idd-doctor.yml', jobId: 'idd-doctor' },
  { file: 'pnpm-boundary.yml', jobId: 'pnpm-boundary' },
  { file: 'idd-advisory-convergence.yml', jobId: 'idd-advisory-convergence' },
];
// cancel-in-progress values this repository's own workflows are known to use
// for a genuinely self-cancelling pull_request-scoped concurrency group: a
// literal `true`, or pnpm-boundary.yml's own conditional. An expression outside
// this allowlist cannot be verified to evaluate true without running it, so a
// new conditional must be added here deliberately.
const KNOWN_SAFE_CANCEL_IN_PROGRESS_VALUES = new Set([
  'true',
  `\${{ startsWith(github.ref, 'refs/pull/') }}`,
]);
// YAML text helpers. They mirror the post-#3737 helpers of the workflow guard
// test, so the audit and the remaining Node-floor tests read workflows alike.
function yamlMappingColonIndex(line) {
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
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      break;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === ':' &&
      (index + 1 === line.length || /\s/.test(line[index + 1]))
    ) {
      return index;
    }
  }
  return -1;
}
function yamlBlockScalarHeader(line) {
  const leadingIndent = line.match(/^ */)?.[0].length ?? 0;
  let content = line.slice(leadingIndent);
  let contentHeaderIndent = leadingIndent;
  if (/^-\s/.test(content)) {
    content = content.slice(1).trimStart();
    const sequenceMappingColon = yamlMappingColonIndex(content);
    if (sequenceMappingColon !== -1) {
      contentHeaderIndent += 2;
      content = content.slice(sequenceMappingColon + 1);
    }
  } else {
    const mappingColon = yamlMappingColonIndex(content);
    if (mappingColon === -1) {
      return undefined;
    }
    content = content.slice(mappingColon + 1);
  }
  const value = stripYamlComment(content).trim();
  const header = value.match(
    /^(?:(?:&[^\s]+|![^\s]+)\s+)*(?:[|>])(?:([+-]?[1-9]|[1-9][+-]|[+-]))?$/,
  );
  if (!header) {
    return undefined;
  }
  const explicitIndent = header[1]?.match(/[1-9]/)?.[0];
  return {
    contentHeaderIndent,
    ...(explicitIndent ? { explicitIndent: Number(explicitIndent) } : {}),
  };
}
function yamlBlockScalarContentFlags(lines) {
  const contentFlags = lines.map(() => false);
  let activeContentIndent;
  let pendingHeaderIndent;
  let pendingExplicitContentIndent;
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
    const header = yamlBlockScalarHeader(line);
    if (header) {
      pendingHeaderIndent = header.contentHeaderIndent;
      pendingExplicitContentIndent = header.explicitIndent
        ? pendingHeaderIndent + header.explicitIndent
        : undefined;
    }
  }
  return contentFlags;
}
// Removes a YAML comment from one line without treating a quoted # as a
// comment marker.
function stripYamlComment(line) {
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
// One job's indented body: the lines after `  <jobId>:` up to the next
// two-space sibling key or the end of the root jobs mapping.
function extractJobBody(text, jobId) {
  const lines = text.split('\n');
  const scalarContent = yamlBlockScalarContentFlags(lines);
  const jobsStartIndex = lines.findIndex(
    (line, index) =>
      !scalarContent[index] &&
      /^(?:jobs|'jobs'|"jobs")\s*:\s*$/.test(stripYamlComment(line)),
  );
  if (jobsStartIndex === -1) {
    return undefined;
  }
  const jobsEndIndex = lines.findIndex(
    (line, index) =>
      index > jobsStartIndex &&
      !scalarContent[index] &&
      line.trim() !== '' &&
      !line.trimStart().startsWith('#') &&
      !/^\s/.test(line),
  );
  const startIndex = lines.findIndex(
    (line, index) =>
      index > jobsStartIndex &&
      (jobsEndIndex === -1 || index < jobsEndIndex) &&
      !scalarContent[index] &&
      line === `  ${jobId}:`,
  );
  if (startIndex === -1) {
    return undefined;
  }
  const nextSiblingIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      (jobsEndIndex === -1 || index < jobsEndIndex) &&
      !scalarContent[index] &&
      /^ {2}(?!#)\S/.test(line),
  );
  const endIndex =
    nextSiblingIndex === -1
      ? jobsEndIndex
      : jobsEndIndex === -1
        ? nextSiblingIndex
        : Math.min(nextSiblingIndex, jobsEndIndex);
  return lines
    .slice(startIndex + 1, endIndex === -1 ? undefined : endIndex)
    .join('\n');
}
// The indented block under one key at a fixed indent, or undefined when the
// key is absent.
function extractKeyBlock(text, indent, key) {
  const lines = text.split('\n');
  const start = lines.indexOf(`${' '.repeat(indent)}${key}:`);
  if (start === -1) {
    return undefined;
  }
  const deeper = ' '.repeat(indent + 1);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(deeper)) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}
// The slice from the top-level `on:` key up to `permissions:`, which every
// workflow in this repository places right after its trigger block.
function extractOnBlock(text) {
  const start = text.indexOf('\non:');
  const end = text.indexOf('\npermissions:');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end);
}
// The workflow as YAML keys see it: full-line comments dropped, block-scalar
// bodies blanked, and trailing comments cut. A key, a step name, or an if:
// condition read from this view cannot be supplied by a comment.
function declarationText(text) {
  return structuralLines(text)
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}
// The workflow with full-line comments dropped and trailing comments cut from key
// lines. Block-scalar bodies keep their text, because a `#` inside a run: body can
// sit inside shell quotes, so cutting it could hide a command that still runs. Only
// the full-line comments of a body are dropped. A token that lives in a run: body
// reads from this view, so a comment cannot supply it.
function tokenText(text) {
  const out = [];
  let blockColumn;
  for (const line of text.split('\n')) {
    if (
      blockColumn !== undefined &&
      (line.trim() === '' || indentOf(line) > blockColumn)
    ) {
      if (!/^\s*#/.test(line)) {
        out.push(line);
      }
      continue;
    }
    blockColumn = undefined;
    if (/^\s*#/.test(line)) {
      continue;
    }
    const key = line.replace(/\s+#.*$/, '');
    if (/:\s*[|>][-+0-9]*\s*$/.test(key)) {
      blockColumn = line.search(/[^\s-]/);
    }
    out.push(key);
  }
  return out.join('\n');
}
// The top-level on: block of a declaration view, from `on:` up to `permissions:`.
function onBlockOf(declared) {
  const start = declared.indexOf('\non:');
  const end = declared.indexOf('\npermissions:');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return declared.slice(start, end);
}
// The top-level concurrency block of a declaration view, or '' when absent.
function concurrencyOf(declared) {
  return extractConcurrencyBlock(`${declared}\n`) ?? '';
}
// The character offset of the `- name:` line of the named step in a view, or -1.
// The step names passed here contain no regular-expression metacharacters.
// The character offset of the `- name:` line of the named step in a view, or -1.
// The name is escaped, so a step name may carry parentheses or other punctuation.
function stepOffset(view, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return view.search(new RegExp(`^ {6}- name: ${escaped}\\s*$`, 'm'));
}
// The text of the named step in a view, or undefined when no step has that name.
function stepTextNamed(view, name) {
  const index = stepOffset(view, name);
  return index === -1 ? undefined : stepTextFrom(view, index);
}
function jobIds(text) {
  const start = text.indexOf('\njobs:');
  if (start === -1) {
    return undefined;
  }
  const rest = text.slice(start + '\njobs:'.length);
  // Only the jobs block counts. The next top-level key, or the end of the
  // file, ends it, so a top-level `defaults:` block after `jobs:` is not read
  // as a job.
  const next = rest.search(/\n(?=[^\s#])/);
  const body = next === -1 ? rest : rest.slice(0, next);
  return [...body.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);
}
// The top-level `concurrency:` block's indented body, or null when absent.
function extractConcurrencyBlock(text) {
  const match = text.match(/^concurrency:\n((?: {2}.*\n)+)/m);
  return match ? match[1] : null;
}
// Whether the top-level concurrency block sets cancel-in-progress to a value
// known to evaluate true for this repository's own pull_request runs. A key
// that is present but false, or unset, cancels nothing.
function hasEffectiveCancelInProgress(text) {
  const block = extractConcurrencyBlock(text);
  if (!block) {
    return false;
  }
  const match = block.match(/^ {2}cancel-in-progress: (.+)$/m);
  return (
    match !== null && KNOWN_SAFE_CANCEL_IN_PROGRESS_VALUES.has(match[1].trim())
  );
}
// The called workflow's own file name, when the text calls a local reusable
// workflow; null otherwise.
function reusableWorkflowCallTarget(text) {
  const match = text.match(
    /\n {4}uses: \.\/\.github\/workflows\/([\w.-]+\.ya?ml)/,
  );
  return match ? match[1] : null;
}
// RWA001: each required status check keeps its trigger, its job id, and a job
// without a display name override.
function checkRequiredCheckWorkflows(root, report) {
  for (const { file, jobId } of REQUIRED_CHECKS) {
    const path = `${WORKFLOWS_DIRECTORY}/${file}`;
    const text = readRequiredText(root, path, RWA001, report);
    if (text === undefined) {
      continue;
    }
    const onBlock = onBlockOf(declarationText(text));
    if (onBlock === undefined) {
      report(RWA001, path, 'on:/permissions: block not found');
      continue;
    }
    // idd-advisory-convergence.yml moved to a pull_request_target-only trigger,
    // and the path-filter concern applies to that key as well.
    const pullRequestFamilyKey =
      file === 'idd-advisory-convergence.yml'
        ? 'pull_request_target'
        : 'pull_request';
    if (
      !new RegExp(`^ {2}["']?${pullRequestFamilyKey}["']?\\s*:`, 'm').test(
        onBlock,
      )
    ) {
      report(RWA001, path, `must trigger on ${pullRequestFamilyKey}`);
    }
    // A required job runs the check that gates the merge, so it must not be
    // conditional, wait on another job, or continue on error. The advisory gate
    // is excluded: its needs and if are part of its own design.
    const requiredJobBody = jobBlocks(text)?.get(jobId);
    if (requiredJobBody === undefined) {
      report(RWA001, path, `job ${jobId} not found`);
    } else if (
      file !== 'idd-advisory-convergence.yml' &&
      structuralLines(requiredJobBody).some(
        (line) =>
          /^ {4}(if|needs)\s*:/.test(line) ||
          /^\s*continue-on-error\s*:/.test(line),
      )
    ) {
      report(
        RWA001,
        path,
        `${jobId} must not be conditional, depend on another job, or continue on error`,
      );
    }
    if (/\bpaths(-ignore)?["']?\s*:/.test(onBlock)) {
      report(
        RWA001,
        path,
        `${pullRequestFamilyKey} trigger must not gain a path filter -- a path-filtered required check never reports for an out-of-filter change`,
      );
    }
    if (!new RegExp(`^ {2}${jobId}:$`, 'm').test(text)) {
      report(RWA001, path, `must keep required job id ${jobId}`);
    }
    // GitHub reports a required check under the job's display name, so a
    // job-level name: would move the check the ruleset waits on.
    const jobBody = extractJobBody(text, jobId);
    if (jobBody === undefined) {
      report(RWA001, path, `job ${jobId} not found`);
      continue;
    }
    if (/^ {4}name:/m.test(jobBody)) {
      report(
        RWA001,
        path,
        `job ${jobId} must not declare its own display name -- that changes the literal required-status-check context`,
      );
    }
  }
}
// The pull_request-triggered workflows, sorted by file name. The advisory
// workflow is included by name because its trigger moved to pull_request_target
// while it still re-runs on every push to an open pull request.
function listPullRequestWorkflows(root, report) {
  let names;
  try {
    names = readdirSync(resolve(root, WORKFLOWS_DIRECTORY))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  } catch {
    report(
      RWA002,
      WORKFLOWS_DIRECTORY,
      'required input is missing or unreadable',
    );
    return undefined;
  }
  const files = [];
  for (const name of names) {
    if (name === 'idd-advisory-convergence.yml') {
      files.push(name);
      continue;
    }
    const path = `${WORKFLOWS_DIRECTORY}/${name}`;
    const text = readRequiredText(root, path, RWA002, report);
    if (text === undefined) {
      continue;
    }
    const onBlock = extractOnBlock(text);
    if (onBlock === undefined) {
      report(RWA002, path, 'on:/permissions: block not found');
      continue;
    }
    if (/^ {2}["']?pull_request["']?\s*:/m.test(onBlock)) {
      files.push(name);
    }
  }
  return files;
}
// RWA002: every pull_request-triggered workflow cancels superseded runs, either
// directly or by inheriting that from its single reusable-workflow job.
function checkPullRequestConcurrency(root, report) {
  const files = listPullRequestWorkflows(root, report);
  if (files === undefined) {
    return;
  }
  if (files.length < 6) {
    report(
      RWA002,
      WORKFLOWS_DIRECTORY,
      `expected >= 6 pull_request-triggered workflows, found ${files.length}: ${files.join(', ')}`,
    );
  }
  for (const file of files) {
    const path = `${WORKFLOWS_DIRECTORY}/${file}`;
    const text = readRequiredText(root, path, RWA002, report);
    if (text === undefined || hasEffectiveCancelInProgress(text)) {
      continue;
    }
    const calledFile = reusableWorkflowCallTarget(text);
    if (!calledFile) {
      report(
        RWA002,
        path,
        'must declare an effective cancel-in-progress concurrency setting, or be a pure reusable-workflow caller that inherits one',
      );
      continue;
    }
    // Inherited concurrency cancels only the reusable-workflow job, so the
    // exception holds only when that job is the file's sole job.
    const ids = jobIds(text);
    if (ids === undefined) {
      report(RWA002, path, 'jobs: block not found');
      continue;
    }
    if (ids.length !== 1) {
      report(
        RWA002,
        path,
        `calls ${calledFile} as a reusable workflow, but declares ${ids.length} jobs (${ids.join(', ')}) -- inherited concurrency only covers the reusable-workflow job itself, so every sibling job needs its own effective cancel-in-progress`,
      );
    }
    const calledText = readRequiredText(
      root,
      `${WORKFLOWS_DIRECTORY}/${calledFile}`,
      RWA002,
      report,
    );
    if (calledText === undefined) {
      continue;
    }
    if (!hasEffectiveCancelInProgress(calledText)) {
      report(
        RWA002,
        path,
        `calls ${calledFile} as a reusable workflow, but ${calledFile} declares no effective cancel-in-progress for it to inherit`,
      );
    }
  }
}
function requireKeyBlock(text, indent, key, path, report) {
  const block = extractKeyBlock(text, indent, key);
  if (block === undefined) {
    report(RWA003, path, `${key}: block not found at indent ${indent}`);
  }
  return block;
}
// RWA003: the runner contracts that keep the required checks off the 15-minute
// ubuntu-slim cap, and keep the documented ubuntu-slim default for callers.
function checkRunnerContracts(root, report) {
  const pnpmBoundaryPath = `${WORKFLOWS_DIRECTORY}/pnpm-boundary.yml`;
  const pnpmBoundary = readRequiredText(root, pnpmBoundaryPath, RWA003, report);
  if (pnpmBoundary !== undefined) {
    const jobBody = extractJobBody(pnpmBoundary, 'pnpm-boundary');
    if (jobBody === undefined) {
      report(RWA003, pnpmBoundaryPath, 'job pnpm-boundary not found');
    } else if (
      !/^ {4}runs-on: \$\{\{ inputs\.runner \|\| 'ubuntu-latest' \}\}$/m.test(
        jobBody,
      )
    ) {
      report(
        RWA003,
        pnpmBoundaryPath,
        `the pnpm-boundary job's runs-on fallback must be ubuntu-latest -- the inputs context is empty under pull_request, so the fallback is the runner the default lane gets, and ${SLIM_CAP_NOTE}`,
      );
    }
    const workflowCall = requireKeyBlock(
      pnpmBoundary,
      2,
      'workflow_call',
      pnpmBoundaryPath,
      report,
    );
    const inputs =
      workflowCall === undefined
        ? undefined
        : requireKeyBlock(workflowCall, 4, 'inputs', pnpmBoundaryPath, report);
    const inputsRunner =
      inputs === undefined
        ? undefined
        : requireKeyBlock(inputs, 6, 'runner', pnpmBoundaryPath, report);
    if (
      inputsRunner !== undefined &&
      !/^ {8}default: ubuntu-slim$/m.test(inputsRunner)
    ) {
      report(
        RWA003,
        pnpmBoundaryPath,
        'inputs.runner.default must stay ubuntu-slim -- the documented default for downstream workflow_call callers in docs/customization.md (#3665)',
      );
    }
  }
  const floorPath = `${WORKFLOWS_DIRECTORY}/pnpm-boundary-node22-floor.yml`;
  const floor = readRequiredText(root, floorPath, RWA003, report);
  if (floor !== undefined) {
    const jobBody = extractJobBody(floor, 'pnpm-boundary-node22-floor');
    if (jobBody === undefined) {
      report(RWA003, floorPath, 'job pnpm-boundary-node22-floor not found');
    } else {
      const withBlock = requireKeyBlock(jobBody, 4, 'with', floorPath, report);
      if (
        withBlock !== undefined &&
        !/^ {6}runner: ["']?ubuntu-latest["']?$/m.test(withBlock)
      ) {
        report(
          RWA003,
          floorPath,
          `the job's with: block must pass runner: ubuntu-latest -- a workflow_call caller otherwise receives the declared ubuntu-slim default, and ${SLIM_CAP_NOTE}`,
        );
      }
    }
  }
  const lintPath = `${WORKFLOWS_DIRECTORY}/lint.yml`;
  const lint = readRequiredText(root, lintPath, RWA003, report);
  if (lint !== undefined) {
    const jobBody = extractJobBody(lint, 'lint');
    if (jobBody === undefined) {
      report(RWA003, lintPath, 'job lint not found');
    } else if (!/^ {4}runs-on: ubuntu-latest$/m.test(jobBody)) {
      report(
        RWA003,
        lintPath,
        'the lint job must use ubuntu-latest; ubuntu-slim has a hard 15-minute cap, and issue #3728 recorded cancellation annotations for runs 36730573670, 36752800229, and 36955823310',
      );
    }
  }
}
const RWA005 = 'RWA005';
const ADVISORY_REQUIRED_PATHS = [
  '.github/workflows/idd-advisory-convergence.yml',
  'idd-template/.github/workflows/idd-advisory-convergence.yml',
];
const PROBE_WORKFLOW_PATHS = [
  '.github/workflows/idd-advisory-convergence-probe.yml',
  'idd-template/.github/workflows/idd-advisory-convergence-probe.yml',
];
const COMMENT_WORKFLOW_PATHS = [
  '.github/workflows/idd-advisory-convergence-comment.yml',
  'idd-template/.github/workflows/idd-advisory-convergence-comment.yml',
];
const PROBE_READ_PERMISSIONS = [
  'actions: read',
  'checks: read',
  'contents: read',
  'issues: read',
  'pull-requests: read',
  'statuses: read',
];
const ONBOARDING_GUIDE_PATH =
  'idd-template/docs/onboarding/optional-host-setup.md';
const EXTERNAL_CHECK_WAIVER_PATH = 'src/scripts/external-check-waiver.mts';
// Each job's indented body, keyed by job id, from the root jobs mapping. Full
// comment lines are dropped first so commented-out steps cannot satisfy a check.
function jobBlocks(text) {
  const header = text.match(/^jobs:\s*(?:#.*)?$/m);
  if (header?.index === undefined) {
    return undefined;
  }
  const uncommented = text
    .slice(header.index + header[0].length)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const nextTopLevel = uncommented.search(/^\S/m);
  const jobsBody =
    nextTopLevel === -1 ? uncommented : uncommented.slice(0, nextTopLevel);
  const headers = [...jobsBody.matchAll(/^ {2}([\w-]+):\s*$/gm)];
  const blocks = new Map();
  headers.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headers[index + 1]?.index ?? jobsBody.length;
    blocks.set(match[1], jobsBody.slice(start, end));
  });
  return blocks;
}
// The text after one job header line, up to the next two-space sibling key.
function jobBodyAfterHeader(text, header) {
  const match = text.match(header);
  if (match?.index === undefined) {
    return undefined;
  }
  const afterJob = text.slice(match.index + match[0].length);
  const nextSibling = afterJob.match(/^ {2}\S/m);
  return nextSibling?.index === undefined
    ? afterJob
    : afterJob.slice(0, nextSibling.index);
}
function jobPermissionsBlock(jobBody) {
  return jobBody.match(/^ {4}permissions:\n((?: {6}.*\n)+)/m)?.[1];
}
// The text of one step, from its marker to the next step bullet. A bullet is
// any `- ` at the steps indentation, so an unnamed step ends the step too.
function stepTextFrom(text, index) {
  const next = text.indexOf('\n      - ', index + 1);
  return text.slice(index, next === -1 ? undefined : next);
}
function firstIfLine(stepText) {
  return stepText.split('\n').find((line) => line.trim().startsWith('if:'));
}
// Self-waiver job read-scope contracts (kurone-kito/idd-skill#2951, #2995).
function checkSelfWaiverJobPermissions(root, report) {
  for (const path of ADVISORY_REQUIRED_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const jobBody = jobBodyAfterHeader(
      text,
      /^ {2}idd-advisory-convergence-self-waiver:$/m,
    );
    if (jobBody === undefined) {
      report(
        RWA005,
        path,
        'must keep the idd-advisory-convergence-self-waiver job',
      );
      continue;
    }
    const permissions = jobPermissionsBlock(jobBody);
    if (permissions === undefined) {
      report(
        RWA005,
        path,
        'idd-advisory-convergence-self-waiver job must declare a permissions: block',
      );
      continue;
    }
    if (!/^ {6}pull-requests: write$/m.test(permissions)) {
      report(
        RWA005,
        path,
        'idd-advisory-convergence-self-waiver job must keep pull-requests: write (kurone-kito/idd-skill#2951 -- without it the marker POST 403s)',
      );
    }
    if (!/^ {6}checks: read$/m.test(permissions)) {
      report(
        RWA005,
        path,
        "idd-advisory-convergence-self-waiver job must keep checks: read (kurone-kito/idd-skill#2995 -- --auto-bootstrap's statusCheckRollup read needs it)",
      );
    }
    if (!/^ {6}statuses: read$/m.test(permissions)) {
      report(
        RWA005,
        path,
        "idd-advisory-convergence-self-waiver job must keep statuses: read (kurone-kito/idd-skill#2995 -- --auto-bootstrap's statusCheckRollup read needs it)",
      );
    }
  }
}
// The required gate job keeps its id, its manual re-check condition, and its
// checks read scope (kurone-kito/idd-skill#3253).
function checkRequiredGateWorkflows(root, report) {
  for (const path of ADVISORY_REQUIRED_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    if (!/^ {2}idd-advisory-convergence:$/m.test(text)) {
      report(RWA005, path, 'must keep job id idd-advisory-convergence');
    }
    const requiredJob = jobBlocks(text)?.get('idd-advisory-convergence');
    if (requiredJob === undefined) {
      report(RWA005, path, 'must keep the required gate job');
    } else if (!/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m.test(requiredJob)) {
      report(RWA005, path, 'manual re-checks must still run the required gate');
    }
    if (/probe_token_scopes|probe-self-waiver-token-scopes/.test(text)) {
      report(RWA005, path, 'must not reference the token-scope probe');
    }
    const jobBody = jobBodyAfterHeader(
      text,
      /^ {2}idd-advisory-convergence:$/m,
    );
    const permissions =
      jobBody === undefined ? undefined : jobPermissionsBlock(jobBody);
    if (jobBody === undefined) {
      report(RWA005, path, 'must keep the idd-advisory-convergence job');
    } else if (permissions === undefined) {
      report(
        RWA005,
        path,
        'idd-advisory-convergence job must declare a permissions: block',
      );
    } else if (!/^ {6}checks: read$/m.test(permissions)) {
      report(
        RWA005,
        path,
        "idd-advisory-convergence job must keep checks: read (kurone-kito/idd-skill#3253 -- getChangeRequestHeadObservedAt's checkSuites read needs it)",
      );
    }
  }
}
// The trigger contract of the required gate: pull_request_target only.
function checkRequiredGateTriggers(root, report) {
  for (const path of ADVISORY_REQUIRED_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const onBlock = onBlockOf(declarationText(text));
    if (onBlock === undefined) {
      report(RWA005, path, 'on:/permissions: block not found');
      continue;
    }
    if (/pull_request_review_comment/.test(onBlock)) {
      report(RWA005, path, 'on: must not include pull_request_review_comment');
    }
    if (/issue_comment/.test(onBlock)) {
      report(RWA005, path, 'on: must not include issue_comment');
    }
    if (/^\s*pull_request\s*:\s*$/m.test(onBlock)) {
      report(
        RWA005,
        path,
        'on: must no longer include the transitional pull_request trigger',
      );
    }
    if (!/^\s*pull_request_target\s*:\s*$/m.test(onBlock)) {
      report(RWA005, path, 'on: must still include pull_request_target');
    }
    if (/(?<!_)pull_request_review\s*:/.test(onBlock)) {
      report(
        RWA005,
        path,
        'on: must not include pull_request_review (moved to the companion workflow)',
      );
    }
    if (!/^ {2}["']?pull_request_target["']?\s*:/m.test(onBlock)) {
      report(RWA005, path, 'on: must include pull_request_target');
    }
    checkCheckoutSurface(path, text, report);
  }
}
// The required gate's external-check-waiver jobs keep all three read scopes
// (kurone-kito/idd-skill#3683). Discovery is by substring, so a template step
// that calls the helper through another command is still covered.
function checkExternalCheckWaiverInvokers(root, report) {
  for (const path of ADVISORY_REQUIRED_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const blocks = jobBlocks(text);
    if (blocks === undefined) {
      report(RWA005, path, 'workflow must declare a jobs: section');
      continue;
    }
    const invokers = [...blocks].filter(([, body]) =>
      body.includes('external-check-waiver'),
    );
    if (
      !invokers.some(([id]) => id === 'idd-advisory-convergence-self-waiver')
    ) {
      report(
        RWA005,
        path,
        'the scan must find idd-advisory-convergence-self-waiver as an external-check-waiver invoker, or this check would pass vacuously',
      );
    }
    for (const [id, body] of invokers) {
      const permissions = jobPermissionsBlock(body);
      if (permissions === undefined) {
        report(
          RWA005,
          path,
          `${id} invokes external-check-waiver and must declare a permissions: block`,
        );
        continue;
      }
      for (const scope of ['actions', 'checks', 'statuses']) {
        if (!new RegExp(`^ {6}${scope}: read$`, 'm').test(permissions)) {
          report(
            RWA005,
            path,
            `${id} invokes external-check-waiver and must keep ${scope}: read (kurone-kito/idd-skill#3683 -- its statusCheckRollup and check-suites reads can fail with "Resource not accessible by integration" in a private repository without it)`,
          );
        }
      }
    }
  }
}
// The probe is a separate, non-required, issue_comment-only workflow that
// reads exactly the six requested scopes and matches the helper's query.
function checkTokenScopeProbeWorkflows(root, report) {
  const helper = readRequiredText(
    root,
    EXTERNAL_CHECK_WAIVER_PATH,
    RWA005,
    report,
  );
  const helperFields = helper?.match(
    /function fetchPullRequest\([\s\S]*?'--json',\s*'([^']+)'/,
  )?.[1];
  if (helper !== undefined && helperFields === undefined) {
    report(
      RWA005,
      EXTERNAL_CHECK_WAIVER_PATH,
      'fetchPullRequest must declare its --json fields',
    );
  }
  for (const path of PROBE_WORKFLOW_PATHS) {
    const workflow = readRequiredText(root, path, RWA005, report);
    if (workflow === undefined) {
      continue;
    }
    checkProbeTriggersAndIdentity(path, workflow, report);
    const probe = jobBlocks(workflow)?.get('probe-self-waiver-token-scopes');
    if (probe === undefined) {
      report(RWA005, path, 'workflow must contain the token-scope probe job');
      continue;
    }
    checkProbeJob(path, probe, helperFields, report);
  }
}
function checkProbeTriggersAndIdentity(path, workflow, report) {
  const declared = declarationText(workflow);
  const onBlock = onBlockOf(declared);
  if (onBlock === undefined) {
    report(RWA005, path, 'on:/permissions: block not found');
    return;
  }
  // Every key at the trigger indentation, quoted or not. A line that does not
  // read as a plain or quoted key stays in the list, so it fails the check.
  const triggerKeys = onBlock
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.match(/^ {2}(["']?)([\w-]+)\1\s*:/)?.[2] ?? line);
  if (triggerKeys.length !== 1 || triggerKeys[0] !== 'issue_comment') {
    report(RWA005, path, 'probe must use only issue_comment');
  }
  if (!/^ {4}types: \[created\]$/m.test(onBlock)) {
    report(RWA005, path, 'probe must run only for newly created comments');
  }
  if (/workflow_dispatch|pull_request|push|workflow_call/.test(onBlock)) {
    report(
      RWA005,
      path,
      'probe must not expose another trigger or selected ref',
    );
  }
  if (
    !/^# issue_comment uses the workflow definition from the repository's default branch\.$/m.test(
      workflow,
    )
  ) {
    report(RWA005, path, 'probe must keep its default-branch trigger note');
  }
  if (!/^name: IDD self-waiver token-scope probe$/m.test(workflow)) {
    report(RWA005, path, 'probe must keep its workflow name');
  }
  if (!/^ {2}probe-self-waiver-token-scopes:$/m.test(workflow)) {
    report(RWA005, path, 'probe must keep its job id');
  }
  if (/^ {2}idd-advisory-convergence:$/m.test(workflow)) {
    report(RWA005, path, 'probe must not declare the required job id');
  }
}
// The probe job's own contract: trusted author gate, no caller-selected input,
// hardened shell, read-only query, and exactly six read scopes.
function checkProbeJob(path, probe, helperFields, report) {
  const fail = (message) => report(RWA005, path, message);
  if (
    !/^ {4}if: \$\{\{ github\.event\.issue\.pull_request != null && github\.event\.comment\.body == '\/idd-probe-token-scopes' && \(github\.event\.comment\.author_association == 'OWNER' \|\| github\.event\.comment\.author_association == 'MEMBER' \|\| github\.event\.comment\.author_association == 'COLLABORATOR'\) \}\}$/m.test(
      probe,
    )
  ) {
    fail(
      'job must require a PR, the exact command, and a trusted author association',
    );
  }
  if (
    /inputs\.|github\.ref|workflow_dispatch|actions\/checkout|git clone/.test(
      probe,
    )
  ) {
    fail(
      'probe must not accept caller-selected inputs or execute checked-out content',
    );
  }
  if (path.startsWith('idd-template/')) {
    if (
      !/^ {4}runs-on: \$\{\{ vars\.CI_RUNNER_LABEL \|\| 'ubuntu-slim' \}\}$/m.test(
        probe,
      )
    ) {
      fail('runner must keep the CI_RUNNER_LABEL and ubuntu-slim fallback');
    }
  } else if (!/^ {4}runs-on: ubuntu-slim$/m.test(probe)) {
    fail('probe runner must be ubuntu-slim');
  }
  if (
    !/^ {10}PR_NUMBER: \$\{\{ github\.event\.issue\.number \}\}$/m.test(probe)
  ) {
    fail('PR number must come only from the issue_comment event');
  }
  if (
    !/^ {10}COMMENT_BODY: \$\{\{ github\.event\.comment\.body \}\}$/m.test(
      probe,
    )
  ) {
    fail('comment text must be passed through an environment variable');
  }
  if (!/^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m.test(probe)) {
    fail("probe must authenticate gh with this run's GITHUB_TOKEN");
  }
  if (!/--repo "\$GITHUB_REPOSITORY"/.test(probe)) {
    fail('probe must query the current repository');
  }
  const run = probe.slice(probe.indexOf('\n        run:'));
  if (/\$\{\{\s*github\.event\.comment/.test(run)) {
    fail('comment text must not be interpolated into a shell command');
  }
  const exactCommandGuard = run.indexOf(
    `if [[ "$COMMENT_BODY" != '/idd-probe-token-scopes' ]]; then`,
  );
  const probeQuery = run.indexOf('gh pr view');
  if (!(exactCommandGuard >= 0 && exactCommandGuard < probeQuery)) {
    fail(
      'shell must case-sensitively reject non-exact commands before API reads',
    );
  }
  const hostSetup = probe.search(
    /NORMALIZED_GH_HOST=\$\(printf '%s' "\$\{GH_HOST:-\}"/,
  );
  const query = probe.indexOf('gh pr view');
  if (!(hostSetup >= 0 && hostSetup < query)) {
    fail(
      'probe must normalize GH_HOST before gh runs without a local repository',
    );
  }
  if (!probe.includes("sed 's/^[[:space:]]*//; s/[[:space:]]*$//'")) {
    fail('probe must treat whitespace-only GH_HOST as unset');
  }
  if (
    !/if \[ -z "\$NORMALIZED_GH_HOST" \][\s\S]*?GITHUB_SERVER_URL[\s\S]*?NORMALIZED_GH_HOST="\$SERVER_HOST"[\s\S]*?export GH_HOST="\$NORMALIZED_GH_HOST"/.test(
      probe,
    )
  ) {
    fail('probe must derive the gh host from the Actions server URL');
  }
  if (!/gh pr view/.test(probe)) {
    fail('probe must query gh pr view');
  }
  if (
    !/--jq '\[any\(\.statusCheckRollup\[\]\?; \.__typename == "CheckRun" and \(\(\.workflowName \/\/ ""\) \| length > 0\)\), any\(\.statusCheckRollup\[\]\?; \.__typename == "StatusContext"\), any\(\.closingIssuesReferences\[\]\?; \.number > 0\)\] \| map\(tostring\) \| join\(" "\)'/.test(
      probe,
    )
  ) {
    fail(
      'probe must verify Actions, legacy status, and a linked issue exercise all read scopes',
    );
  }
  for (const phrase of [
    'has no Actions check run',
    'has no legacy status context',
    'has no linked closing issue',
  ]) {
    if (!probe.includes(phrase)) {
      fail(`probe must report when it ${phrase}`);
    }
  }
  if (
    !/Read-only self-waiver query probe succeeded for PR .*Actions, legacy status, and a linked issue/.test(
      probe,
    )
  ) {
    fail('probe must print its read-only success summary');
  }
  if (
    /external-check-waiver|gh api|gh issue|gh pr comment|--method|labels|required_status_checks/.test(
      probe,
    )
  ) {
    fail(
      'probe must not invoke a waiver, comment, label, or required-check write operation',
    );
  }
  const probeFields = probe.match(/--json\s+([^\s\\]+)/)?.[1];
  if (probeFields !== helperFields) {
    fail('probe query fields must match fetchPullRequest exactly');
  }
  const permissions = probe.match(/^ {4}permissions:\n((?: {6}.*\n)+)/m)?.[1];
  if (permissions === undefined) {
    fail('probe must declare job-level permissions');
    return;
  }
  const actualPermissions = [...permissions.matchAll(/^ {6}([\w-]+: \w+)$/gm)]
    .map((match) => match[1])
    .sort();
  if (
    actualPermissions.join('\n') !==
    [...PROBE_READ_PERMISSIONS].sort().join('\n')
  ) {
    fail('probe must grant exactly the six requested read-only scopes');
  }
}
// The onboarding guide documents how to run the probe: its scopes, trigger,
// command, and the denied-read remedy.
function checkOnboardingGuideProbeSection(root, report) {
  const guide = readRequiredText(root, ONBOARDING_GUIDE_PATH, RWA005, report);
  if (guide === undefined) {
    return;
  }
  const heading = '### Waiver probe';
  const start = guide.indexOf(heading);
  if (start === -1) {
    report(
      RWA005,
      ONBOARDING_GUIDE_PATH,
      'onboarding guide must explain the token-scope probe',
    );
    return;
  }
  const afterHeading = guide.slice(start + heading.length);
  const nextHeading = afterHeading.search(/^#{1,3} /m);
  const section =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const tableRows = section
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  for (const permission of PROBE_READ_PERMISSIONS) {
    const cell = `\`${permission}\``;
    if (!tableRows.some((line) => line.split('|')[1]?.trim() === cell)) {
      report(
        RWA005,
        ONBOARDING_GUIDE_PATH,
        `onboarding guide table must include ${permission}`,
      );
    }
  }
  const sectionChecks = [
    [
      /non-required/i,
      'onboarding guide must describe the probe as non-required',
    ],
    [
      /idd-advisory-convergence-probe\.yml/,
      'onboarding guide must name the probe workflow',
    ],
    [/default branch/i, 'onboarding guide must name the default branch'],
    [/issue_comment/i, 'onboarding guide must name the issue_comment trigger'],
    [
      /post this on the target PR/i,
      'onboarding guide must say to post the command on the target PR',
    ],
    [
      /```text\n\/idd-probe-token-scopes\n```/,
      'onboarding guide must show the exact command',
    ],
    [
      /`OWNER`, `MEMBER`, or `COLLABORATOR`/,
      'onboarding guide must list the trusted author associations',
    ],
    [/edits/i, 'onboarding guide must say edits do not re-trigger the probe'],
    [/other casing/i, 'onboarding guide must say other casing is rejected'],
    [
      /no ref input, checkout, PR code/i,
      'onboarding guide must say the probe takes no ref input or checkout',
    ],
    [
      /comment write/i,
      'onboarding guide must say the probe performs no comment write',
    ],
    [
      /Actions\s+check,\s+legacy status,\s+and linked\s+issue/i,
      'onboarding guide must name the three read exercises',
    ],
    [
      /this run's token access here/i,
      "onboarding guide must describe this run's token access",
    ],
    [
      /denied reads point to token or\s+Actions settings/i,
      'onboarding guide must point denied reads at token or Actions settings',
    ],
    [/`issues: write`/, 'onboarding guide must name the issues: write scope'],
    [
      /`pull-requests: write`/,
      'onboarding guide must name the pull-requests: write scope',
    ],
    [
      /public success does not prove private access/i,
      'onboarding guide must say public success does not prove private access',
    ],
    [
      /required-gate change/i,
      'onboarding guide must say a required-gate change is needed',
    ],
  ];
  for (const [pattern, message] of sectionChecks) {
    if (!pattern.test(section)) {
      report(RWA005, ONBOARDING_GUIDE_PATH, message);
    }
  }
}
// The comment-refresh companion is non-required, uses its own job id, and
// keeps its trigger, helper calls, and non-cancelling concurrency.
function checkCommentRefreshIdentity(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const declared = declarationText(text);
    const tokens = tokenText(text);
    if (/^ {2}idd-advisory-convergence:$/m.test(declared)) {
      report(RWA005, path, 'must not reuse the required job id');
    }
    if (!/^ {2}refresh-if-idd-originated:$/m.test(declared)) {
      report(RWA005, path, 'must keep the refresh-if-idd-originated job');
    }
    if (
      !/^ {2}["']?pull_request_review_comment["']?\s*:/m.test(
        onBlockOf(declared) ?? '',
      )
    ) {
      report(RWA005, path, 'must keep the pull_request_review_comment trigger');
    }
    if (!/rerun-advisory-convergence/.test(tokens)) {
      report(RWA005, path, 'must keep the rerun helper');
    }
    if (!/review-comment-origin/.test(tokens)) {
      report(RWA005, path, 'must keep the review-comment origin classifier');
    }
    if (
      !/^ {2}cancel-in-progress:\s*false\s*$/m.test(concurrencyOf(declared))
    ) {
      report(RWA005, path, 'must not cancel an in-flight IDD refresh');
    }
  }
}
// The companion also listens to issue_comment, skips plain issues, and gives the
// rerun step its PR number from either event shape.
function checkCommentRefreshTriggers(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const declared = declarationText(text);
    const onBlock = onBlockOf(declared);
    if (
      onBlock === undefined ||
      !/^ {2}["']?issue_comment["']?\s*:/m.test(onBlock)
    ) {
      report(RWA005, path, 'on: must include issue_comment');
    }
    if (
      !/github\.event_name\s*!=\s*'issue_comment'\s*\|\|\s*github\.event\.issue\.pull_request\s*!=\s*null/.test(
        declared,
      )
    ) {
      report(RWA005, path, 'must skip a plain-issue issue_comment event');
    }
    // Checked before the rerun step is looked up, so a missing rerun step does
    // not hide a missing review trigger.
    if (onBlock === undefined) {
      report(RWA005, path, 'on:/permissions: block not found');
    } else if (!/^ {2}["']?pull_request_review["']?\s*:/m.test(onBlock)) {
      report(RWA005, path, 'on: must include pull_request_review');
    }
    const rerunIndex = stepOffset(declared, 'Rerun required HEAD check');
    if (rerunIndex === -1) {
      report(RWA005, path, 'must have a "Rerun required HEAD check" step');
      continue;
    }
    const prNumberAssignment = stepTextFrom(declared, rerunIndex).match(
      /PR_NUMBER:\s*\$\{\{\s*([^}]+)\}\}/,
    );
    if (prNumberAssignment === null) {
      report(
        RWA005,
        path,
        'Rerun required HEAD check step must assign PR_NUMBER',
      );
    } else if (
      !/github\.event\.pull_request\.number\s*\|\|\s*github\.event\.issue\.number/.test(
        prNumberAssignment[1],
      )
    ) {
      report(RWA005, path, 'PR_NUMBER must resolve from either event shape');
    }
    const reviewRerunIndex = stepOffset(declared, 'Rerun required HEAD check');
    const ifLine = firstIfLine(stepTextFrom(declared, reviewRerunIndex));
    if (ifLine === undefined) {
      report(RWA005, path, 'Rerun required HEAD check step must have an if:');
    } else if (
      !/github\.event_name\s*==\s*'pull_request_review'/.test(ifLine)
    ) {
      report(
        RWA005,
        path,
        "rerun step's if: must OR in pull_request_review explicitly",
      );
    }
  }
}
// The companion files exist and are not empty.
function checkCommentRefreshFiles(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text !== undefined && text.length === 0) {
      report(RWA005, path, 'must not be empty');
    }
  }
}
// The debounce step runs between classification and rerun, gates the rerun, and
// never delays a pull_request_review rerun.
function checkCommentRefreshDebounce(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const declared = declarationText(text);
    const tokens = tokenText(text);
    if (stepOffset(declared, 'Check for newer qualifying event') === -1) {
      report(
        RWA005,
        path,
        'must have a "Check for newer qualifying event" debounce step',
      );
    }
    if (!/^ {8}id: debounce\s*$/m.test(declared)) {
      report(RWA005, path, 'debounce step must expose id: debounce');
    }
    if (!/advisory-comment-debounce/.test(tokens)) {
      report(RWA005, path, 'must invoke the advisory-comment-debounce helper');
    }
    const originIndex = stepOffset(declared, 'Classify review comment');
    const debounceIndex = stepOffset(
      declared,
      'Check for newer qualifying event',
    );
    const rerunIndex = stepOffset(declared, 'Rerun required HEAD check');
    if (originIndex === -1 || debounceIndex === -1 || rerunIndex === -1) {
      report(RWA005, path, 'must keep the classify, debounce, and rerun steps');
    } else {
      if (!(originIndex < debounceIndex && debounceIndex < rerunIndex)) {
        report(
          RWA005,
          path,
          'steps must run in order: classify, debounce, rerun',
        );
      }
      const ifLine = firstIfLine(stepTextFrom(declared, rerunIndex));
      if (ifLine === undefined) {
        report(
          RWA005,
          path,
          'Rerun required HEAD check step must have an if: condition',
        );
      } else {
        if (
          !/steps\.origin\.outputs\.idd_originated\s*==\s*'true'/.test(ifLine)
        ) {
          report(
            RWA005,
            path,
            "rerun step's if: must still require idd_originated",
          );
        }
        if (!/steps\.debounce\.outputs\.skip\s*!=\s*'true'/.test(ifLine)) {
          report(
            RWA005,
            path,
            "rerun step's if: must require the debounce step did not skip",
          );
        }
      }
    }
    if (
      !/^ {2}cancel-in-progress:\s*false\s*$/m.test(concurrencyOf(declared))
    ) {
      report(RWA005, path, 'must not cancel an in-flight IDD refresh');
    }
  }
}
// The rerun step calls success() explicitly, and the review branch is not
// gated by success().
function checkCommentRefreshSuccessCall(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const declared = declarationText(text);
    const rerunIndex = stepOffset(declared, 'Rerun required HEAD check');
    if (rerunIndex === -1) {
      report(RWA005, path, 'must have a "Rerun required HEAD check" step');
      continue;
    }
    const ifLine = firstIfLine(stepTextFrom(declared, rerunIndex));
    if (ifLine === undefined) {
      report(RWA005, path, 'rerun step must have an if: condition');
      continue;
    }
    if (!/success\(\)/.test(ifLine)) {
      report(
        RWA005,
        path,
        "rerun step's if: must call success() explicitly to suppress GitHub's implicit prepend",
      );
    }
    if (/pull_request_review'\s*&&\s*success\(\)/.test(ifLine)) {
      report(
        RWA005,
        path,
        "rerun step's pull_request_review branch must not itself be gated by success()",
      );
    }
    if (
      /success\(\)\s*&&\s*\(?\s*github\.event_name\s*==\s*'pull_request_review'/.test(
        ifLine,
      )
    ) {
      report(
        RWA005,
        path,
        "rerun step's pull_request_review branch must not itself be gated by success()",
      );
    }
  }
}
// Debounce never suppresses a pull_request_review rerun.
function checkCommentRefreshReviewBypass(root, report) {
  for (const path of COMMENT_WORKFLOW_PATHS) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    const declared = declarationText(text);
    const debounceIndex = stepOffset(
      declared,
      'Check for newer qualifying event',
    );
    const rerunIndex = stepOffset(declared, 'Rerun required HEAD check');
    if (debounceIndex === -1 || rerunIndex === -1) {
      report(RWA005, path, 'must keep the debounce and rerun steps');
      continue;
    }
    // The debounce step's own condition, so a later step's `if:` cannot stand in.
    const debounceIfLine = firstIfLine(stepTextFrom(declared, debounceIndex));
    if (debounceIfLine === undefined) {
      report(RWA005, path, 'debounce step must have an if: condition');
    } else if (
      !/github\.event_name\s*!=\s*'pull_request_review'/.test(debounceIfLine)
    ) {
      report(
        RWA005,
        path,
        "debounce step's if: must explicitly exclude pull_request_review, not merely omit mentioning it",
      );
    }
    const rerunIfLine = firstIfLine(stepTextFrom(declared, rerunIndex));
    if (rerunIfLine === undefined) {
      report(RWA005, path, 'rerun step must have an if: condition');
      continue;
    }
    if (/pull_request_review'\s*&&[^|]*debounce/.test(rerunIfLine)) {
      report(
        RWA005,
        path,
        "rerun step's pull_request_review branch must not be gated by debounce.outputs.skip",
      );
    }
    if (
      /debounce\.outputs\.skip[^|]*&&[^)]*pull_request_review/.test(rerunIfLine)
    ) {
      report(
        RWA005,
        path,
        "rerun step's pull_request_review branch must not be gated by debounce.outputs.skip",
      );
    }
  }
}
// The template companion keeps the profile and manager guard on its rerun step.
function checkTemplateCommentProfileGuard(root, report) {
  const path =
    'idd-template/.github/workflows/idd-advisory-convergence-comment.yml';
  const text = readRequiredText(root, path, RWA005, report);
  if (text === undefined) {
    return;
  }
  const declared = declarationText(text);
  const debounceIndex = stepOffset(
    declared,
    'Check for newer qualifying event',
  );
  const rerunIndex = stepOffset(declared, 'Rerun required HEAD check');
  if (debounceIndex === -1 || rerunIndex === -1) {
    report(RWA005, path, 'must keep the debounce and rerun steps');
    return;
  }
  const rerunIfLine = firstIfLine(stepTextFrom(declared, rerunIndex));
  if (rerunIfLine === undefined) {
    report(RWA005, path, 'rerun step must have an if: condition');
    return;
  }
  if (
    !/steps\.profile\.outputs\.profile\s*!=\s*'instructions-only'/.test(
      rerunIfLine,
    )
  ) {
    report(
      RWA005,
      path,
      "rerun step's if: must still exclude instructions-only",
    );
  }
  if (
    !/steps\.manager\.outputs\.manager\s*!=\s*'ambiguous'/.test(rerunIfLine)
  ) {
    report(
      RWA005,
      path,
      "rerun step's if: must still exclude an ambiguous package manager",
    );
  }
}
// The template self-waiver job keeps a non-failing notice for an unconfigured
// helper runtime, gated on the allowlist touch.
function checkTemplateSelfWaiverNotice(root, report) {
  const path = 'idd-template/.github/workflows/idd-advisory-convergence.yml';
  const text = readRequiredText(root, path, RWA005, report);
  if (text === undefined) {
    return;
  }
  const declared = declarationText(text);
  const tokens = tokenText(text);
  const noticeIndex = stepOffset(
    declared,
    'Notice when no helper runtime is configured',
  );
  if (noticeIndex === -1) {
    report(
      RWA005,
      path,
      'must keep a non-failing notice step for an unconfigured helper runtime',
    );
    return;
  }
  const noticeStepText = stepTextFrom(declared, noticeIndex);
  const noticeIfLine = firstIfLine(noticeStepText);
  if (noticeIfLine === undefined) {
    report(RWA005, path, 'notice step must have an if: condition');
  } else if (
    !/steps\.allowlist\.outputs\.touched\s*==\s*'true'/.test(noticeIfLine)
  ) {
    report(
      RWA005,
      path,
      "notice step's if: must be gated on the allowlist touch result",
    );
  }
  const noticeStepCode = (
    stepTextNamed(tokens, 'Notice when no helper runtime is configured') ?? ''
  )
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  if (/exit 1/.test(noticeStepCode)) {
    report(
      RWA005,
      path,
      'notice step must not fail the job (exit 1) for an unconfigured helper runtime',
    );
  }
  if (!/::notice::/.test(noticeStepCode)) {
    report(
      RWA005,
      path,
      'notice step must explain itself with a ::notice:: annotation',
    );
  }
}
// The template self-waiver post step excludes instructions-only explicitly.
function checkTemplateSelfWaiverPostGuard(root, report) {
  const path = 'idd-template/.github/workflows/idd-advisory-convergence.yml';
  const text = readRequiredText(root, path, RWA005, report);
  if (text === undefined) {
    return;
  }
  const declared = declarationText(text);
  const postIndex = stepOffset(
    declared,
    'Post the self-referential-bootstrap-auto waiver',
  );
  if (postIndex === -1) {
    report(
      RWA005,
      path,
      'must keep the self-referential-bootstrap-auto post step',
    );
    return;
  }
  const postIfLine = firstIfLine(stepTextFrom(declared, postIndex));
  if (postIfLine === undefined) {
    report(RWA005, path, 'post step must have an if: condition');
  } else if (
    !/steps\.profile\.outputs\.profile\s*!=\s*'instructions-only'/.test(
      postIfLine,
    )
  ) {
    report(
      RWA005,
      path,
      "post step's if: must exclude instructions-only, not rely on the case statement's *) fallthrough",
    );
  }
}
// The one shape of YAML this audit reads. A line is a key with an optional
// plain or quoted value, a sequence item, a bare dash, a block scalar header, a
// blank, or the trigger types list. Anything else (a flow collection, an anchor,
// an alias, a tag, a complex or quoted key, a continuation line) is outside the
// grammar, so it fails the audit instead of hiding a step.
const GRAMMAR_KEY =
  /^\s*(?:- +)?[A-Za-z_][\w-]*\s*:(?:\s*$|\s+(?=[^\s{[&*!?:%@`|>]).*$)/;
const GRAMMAR_BLOCK_HEADER = /^\s*(?:- +)?[A-Za-z_][\w-]*\s*:\s+[|>][-+0-9]*$/;
const GRAMMAR_ITEM = /^\s*(?:-\s*$|- +(?=[^\s{[&*!?:%@`"'|>]).*$)/;
const GRAMMAR_TYPES = /^\s*types: \[[\w ,-]*\]$/;
// Whether a line is in the grammar. A trailing comment is not part of the line.
function isGrammarLine(line) {
  const bare = line.replace(/\s+#.*$/, '');
  return (
    bare.trim() === '' ||
    GRAMMAR_KEY.test(bare) ||
    GRAMMAR_BLOCK_HEADER.test(bare) ||
    GRAMMAR_ITEM.test(bare) ||
    GRAMMAR_TYPES.test(bare)
  );
}
// Line breaks other than LF: CR (alone or in CRLF), vertical tab, form feed,
// NEL, LS, and PS. YAML parsers may honour some of these as line ends, and the
// audit splits on LF only, so any of them fails the audit instead of hiding a line.
const NON_LF_LINE_BREAKS = new Set([0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
// Reports each advisory or comment workflow with a line outside the grammar.
function checkWorkflowGrammar(root, report) {
  const grammarPaths = [
    ...ADVISORY_REQUIRED_PATHS,
    ...COMMENT_WORKFLOW_PATHS,
    ...REQUIRED_CHECKS.map(({ file }) => `${WORKFLOWS_DIRECTORY}/${file}`),
  ];
  for (const path of grammarPaths) {
    const text = readRequiredText(root, path, RWA005, report);
    if (text === undefined) {
      continue;
    }
    if (
      [...text].some((character) =>
        NON_LF_LINE_BREAKS.has(character.charCodeAt(0)),
      )
    ) {
      report(
        RWA005,
        path,
        'a line break other than LF cannot be read by this audit',
      );
      continue;
    }
    if (structuralLines(text).some((line) => !isGrammarLine(line))) {
      report(
        RWA005,
        path,
        'workflow syntax outside plain keys and values cannot be read by this audit',
      );
    }
  }
}
export function collectRepositoryWorkflowViolations(root) {
  const violations = [];
  const reported = new Set();
  // Several checks read the same copy, so an identical finding for the same
  // rule and path is recorded once: a missing input is reported once per rule.
  const report = (ruleId, path, message) => {
    const key = JSON.stringify([ruleId, path, message]);
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    violations.push({ ruleId, path, message });
  };
  checkPostMergeCleanupWorkflows(root, report);
  checkSelfReferentialWaiverConstants(root, report);
  const templateInputs = readTemplateSetupNodeInputs(root, report);
  checkDetectPackageManagerStepsAgree(templateInputs, report);
  checkSetupNodeSteps(templateInputs, report);
  checkRequiredCheckWorkflows(root, report);
  checkPullRequestConcurrency(root, report);
  checkRunnerContracts(root, report);
  checkSelfWaiverJobPermissions(root, report);
  checkRequiredGateWorkflows(root, report);
  checkRequiredGateTriggers(root, report);
  checkWorkflowGrammar(root, report);
  checkExternalCheckWaiverInvokers(root, report);
  checkTokenScopeProbeWorkflows(root, report);
  checkOnboardingGuideProbeSection(root, report);
  checkCommentRefreshIdentity(root, report);
  checkCommentRefreshTriggers(root, report);
  checkCommentRefreshFiles(root, report);
  checkCommentRefreshDebounce(root, report);
  checkCommentRefreshSuccessCall(root, report);
  checkCommentRefreshReviewBypass(root, report);
  checkTemplateCommentProfileGuard(root, report);
  checkTemplateSelfWaiverNotice(root, report);
  checkTemplateSelfWaiverPostGuard(root, report);
  return violations;
}
export function runRepositoryWorkflowAuditCli(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      continue;
    }
    if (arg === '--help') {
      process.stdout.write(
        'usage: node scripts/repository-workflow-audit.mjs --check [--root <fixture-dir>]\n',
      );
      return 0;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        process.stderr.write('--root requires a directory path\n');
        return 2;
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    process.stderr.write(`unknown argument: ${arg}\n`);
    return 2;
  }
  const violations = collectRepositoryWorkflowViolations(root);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `repository-workflow-audit/${violation.ruleId}: ${violation.path}: ${violation.message}\n`,
      );
    }
    return 1;
  }
  process.stdout.write('repository-workflow-audit: no violations\n');
  return 0;
}
if (import.meta.main) {
  process.exitCode = runRepositoryWorkflowAuditCli(process.argv.slice(2));
}
