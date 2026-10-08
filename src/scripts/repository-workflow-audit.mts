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
import './node-runtime-guard.mts';

export interface RepositoryWorkflowViolation {
  ruleId: string;
  path: string;
  message: string;
}

type Report = (ruleId: string, path: string, message: string) => void;

const RWA004 = 'RWA004';

const POST_MERGE_CLEANUP_PATHS = [
  '.github/workflows/post-merge-cleanup.yml',
  'idd-template/.github/workflows/post-merge-cleanup.yml',
] as const;

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
] as const;

function readRequiredText(
  root: string,
  relativePath: string,
  ruleId: string,
  report: Report,
): string | undefined {
  try {
    return readFileSync(resolve(root, relativePath), 'utf8');
  } catch {
    // A missing or unreadable input is an inspection failure, never a clean
    // result, so the rule reports it under its own ID.
    report(ruleId, relativePath, 'required input is missing or unreadable');
    return undefined;
  }
}

function checkDuplicateEvidenceSkipGuard(
  path: string,
  text: string,
  report: Report,
): void {
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

function checkDuplicateEvidenceSkipBlock(
  path: string,
  text: string,
  report: Report,
): void {
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

function checkWorkflowDispatchMergedGuard(
  path: string,
  text: string,
  report: Report,
): void {
  const guardStart = text.indexOf(
    'name: Require a merged PR for workflow_dispatch',
  );
  if (guardStart === -1) {
    report(
      RWA004,
      path,
      'must define the workflow_dispatch merged-PR guard step',
    );
    return;
  }
  const cleanupStepStart = text.indexOf(
    'name: Run F4 cleanup (server-side fallback)',
  );
  if (cleanupStepStart === -1) {
    report(RWA004, path, 'must still define the F4 cleanup step');
    return;
  }
  if (guardStart >= cleanupStepStart) {
    report(RWA004, path, 'guard step must run before the F4 cleanup step');
    return;
  }
  const guardBlock = text.slice(guardStart, cleanupStepStart);

  const requirements: readonly (readonly [RegExp, string])[] = [
    [
      /if: github\.event_name == 'workflow_dispatch'/,
      'guard step must be gated on workflow_dispatch',
    ],
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

function checkWorkflowDispatchCheckoutRef(
  path: string,
  text: string,
  report: Report,
): void {
  const checkoutStart = text.indexOf('uses: actions/checkout');
  if (checkoutStart === -1) {
    report(RWA004, path, 'must keep its actions/checkout step');
    return;
  }
  const fetchDepthStart = text.indexOf('fetch-depth:', checkoutStart);
  if (fetchDepthStart === -1) {
    report(RWA004, path, 'checkout step must keep its fetch-depth: input');
    return;
  }
  const checkoutWith = text.slice(checkoutStart, fetchDepthStart);
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

function checkEmptyStatusBranch(
  path: string,
  evidence: string,
  report: Report,
): void {
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

function checkCleanupTimeoutAndEvidence(
  path: string,
  text: string,
  report: Report,
): void {
  const cleanupStart = text.indexOf(
    'name: Run F4 cleanup (server-side fallback)',
  );
  if (cleanupStart === -1) {
    report(RWA004, path, 'must define the cleanup step');
    return;
  }
  const evidenceStart = text.indexOf(
    'name: Post cleanup evidence comment',
    cleanupStart,
  );
  if (evidenceStart === -1) {
    report(RWA004, path, 'must define the evidence step after cleanup');
    return;
  }

  const jobTimeouts = [
    ...text.slice(0, cleanupStart).matchAll(/timeout-minutes:\s*(\d+)/g),
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

  const cleanupBlock = text.slice(cleanupStart, evidenceStart);
  const stepTimeoutMatch = cleanupBlock.match(/timeout-minutes:\s*(\d+)/);
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
      cleanupBlock,
    )
  ) {
    report(
      RWA004,
      path,
      'cleanup step must keep the profile/manager skip guard',
    );
  }

  const evidence = text.slice(evidenceStart);
  if (
    !/if: always\(\) && steps\.cleanup\.outcome != 'skipped'/.test(evidence)
  ) {
    report(
      RWA004,
      path,
      'evidence step must run on always() unless cleanup was skipped',
    );
  }
  const evidenceRun = evidence.indexOf('run: |');
  if (evidenceRun === -1) {
    report(RWA004, path, 'evidence step must have a run script');
    return;
  }
  const evidenceHeader = evidence.slice(0, evidenceRun);
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
  checkEmptyStatusBranch(path, evidence, report);
}

function checkPostMergeCleanupWorkflows(root: string, report: Report): void {
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
] as const;

const SELF_WAIVER_CONSTANTS_PATH = 'src/scripts/advisory-convergence.mts';

// Reads one string constant from the verifier's source text. Importing the
// verifier would run its module graph, which loads the schema validator and
// resolves the repository layout, so the audit reads the declaration instead.
// A declaration that does not match fails closed.
function readStringConstant(source: string, name: string): string | undefined {
  const match = new RegExp(`export const ${name} =\\s*'([^']*)';`).exec(source);
  return match?.[1];
}

// Both copies must keep the self-waiver job id, post-step name, and artifact
// prefix that the waiver provenance verifier reads, so a rename in one copy
// cannot silently break the waiver check.
function checkSelfReferentialWaiverConstants(
  root: string,
  report: Report,
): void {
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
  ] as const) {
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
    if (!workflow.includes(`${jobId}:`)) {
      report(
        RWA006,
        path,
        'no longer declares the expected self-waiver job id',
      );
    }
    if (!workflow.includes(`name: ${postStepName}`)) {
      report(RWA006, path, 'no longer declares the expected post-step name');
    }
    if (!workflow.includes(artifactNamePrefix)) {
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
] as const;

const DETECT_PACKAGE_MANAGER_STEP_START =
  '      - name: Detect package manager\n';
const STEP_BOUNDARY_AFTER_DETECT = /\n {6}- name: /;
const STEP_BOUNDARY = '\n      - ';
const SETUP_NODE_STEP_COUNT = 4;

// The RWA007 checks share one read of each template copy, so a missing copy is
// reported once rather than once per check.
function readTemplateSetupNodeInputs(
  root: string,
  report: Report,
): Map<string, string> {
  const inputs = new Map<string, string>();
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
function checkDetectPackageManagerStepsAgree(
  inputs: ReadonlyMap<string, string>,
  report: Report,
): void {
  const bodies: { path: string; body: string }[] = [];
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

function stepIfCondition(stepText: string): string | undefined {
  const match = /^ {8}if: (.+)$/m.exec(stepText);
  return match?.[1].trim();
}

function stepName(stepText: string): string | undefined {
  const [firstLine] = stepText.split('\n', 1);
  const match = /^ {6}- name: (.+)$/.exec(firstLine ?? '');
  return match?.[1].trim();
}

// Each actions/setup-node step must pin check-latest, be immediately followed
// by an "Assert Node.js floor" step, and share its if: condition. The three
// template files must contain exactly SETUP_NODE_STEP_COUNT such steps.
function checkSetupNodeSteps(
  inputs: ReadonlyMap<string, string>,
  report: Report,
): void {
  let totalSetupNodeSteps = 0;
  for (const path of TEMPLATE_SETUP_NODE_PATHS) {
    const content = inputs.get(path);
    if (content === undefined) {
      continue;
    }
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
] as const;

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
function yamlMappingColonIndex(line: string): number {
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

function yamlBlockScalarHeader(
  line: string,
): { contentHeaderIndent: number; explicitIndent?: number } | undefined {
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

// One job's indented body: the lines after `  <jobId>:` up to the next
// two-space sibling key or the end of the root jobs mapping.
function extractJobBody(text: string, jobId: string): string | undefined {
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
function extractKeyBlock(
  text: string,
  indent: number,
  key: string,
): string | undefined {
  const lines = text.split('\n');
  const start = lines.indexOf(`${' '.repeat(indent)}${key}:`);
  if (start === -1) {
    return undefined;
  }
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

// The slice from the top-level `on:` key up to `permissions:`, which every
// workflow in this repository places right after its trigger block.
function extractOnBlock(text: string): string | undefined {
  const start = text.indexOf('\non:');
  const end = text.indexOf('\npermissions:');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end);
}

function jobIds(text: string): string[] | undefined {
  const start = text.indexOf('\njobs:');
  if (start === -1) {
    return undefined;
  }
  const body = text.slice(start + '\njobs:'.length);
  return [...body.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);
}

// The top-level `concurrency:` block's indented body, or null when absent.
function extractConcurrencyBlock(text: string): string | null {
  const match = text.match(/^concurrency:\n((?: {2}.*\n)+)/m);
  return match ? match[1] : null;
}

// Whether the top-level concurrency block sets cancel-in-progress to a value
// known to evaluate true for this repository's own pull_request runs. A key
// that is present but false, or unset, cancels nothing.
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

// The called workflow's own file name, when the text calls a local reusable
// workflow; null otherwise.
function reusableWorkflowCallTarget(text: string): string | null {
  const match = text.match(
    /\n {4}uses: \.\/\.github\/workflows\/([\w.-]+\.ya?ml)/,
  );
  return match ? match[1] : null;
}

// RWA001: each required status check keeps its trigger, its job id, and a job
// without a display name override.
function checkRequiredCheckWorkflows(root: string, report: Report): void {
  for (const { file, jobId } of REQUIRED_CHECKS) {
    const path = `${WORKFLOWS_DIRECTORY}/${file}`;
    const text = readRequiredText(root, path, RWA001, report);
    if (text === undefined) {
      continue;
    }
    const onBlock = extractOnBlock(text);
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
    if (!new RegExp(`${pullRequestFamilyKey}:`).test(onBlock)) {
      report(RWA001, path, `must trigger on ${pullRequestFamilyKey}`);
    }
    if (/\bpaths(-ignore)?:/.test(onBlock)) {
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
function listPullRequestWorkflows(
  root: string,
  report: Report,
): string[] | undefined {
  let names: string[];
  try {
    names = readdirSync(resolve(root, WORKFLOWS_DIRECTORY))
      .filter((name) => name.endsWith('.yml'))
      .sort();
  } catch {
    report(
      RWA002,
      WORKFLOWS_DIRECTORY,
      'required input is missing or unreadable',
    );
    return undefined;
  }
  const files: string[] = [];
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
    if (/^ {2}pull_request:/m.test(onBlock)) {
      files.push(name);
    }
  }
  return files;
}

// RWA002: every pull_request-triggered workflow cancels superseded runs, either
// directly or by inheriting that from its single reusable-workflow job.
function checkPullRequestConcurrency(root: string, report: Report): void {
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

function requireKeyBlock(
  text: string,
  indent: number,
  key: string,
  path: string,
  report: Report,
): string | undefined {
  const block = extractKeyBlock(text, indent, key);
  if (block === undefined) {
    report(RWA003, path, `${key}: block not found at indent ${indent}`);
  }
  return block;
}

// RWA003: the runner contracts that keep the required checks off the 15-minute
// ubuntu-slim cap, and keep the documented ubuntu-slim default for callers.
function checkRunnerContracts(root: string, report: Report): void {
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

export function collectRepositoryWorkflowViolations(
  root: string,
): RepositoryWorkflowViolation[] {
  const violations: RepositoryWorkflowViolation[] = [];
  const report: Report = (ruleId, path, message) => {
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
  return violations;
}

export function runRepositoryWorkflowAuditCli(argv: readonly string[]): number {
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
