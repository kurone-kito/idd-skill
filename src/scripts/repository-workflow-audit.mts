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
import { readFileSync } from 'node:fs';
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

export function collectRepositoryWorkflowViolations(
  root: string,
): RepositoryWorkflowViolation[] {
  const violations: RepositoryWorkflowViolation[] = [];
  const report: Report = (ruleId, path, message) => {
    violations.push({ ruleId, path, message });
  };
  checkPostMergeCleanupWorkflows(root, report);
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
