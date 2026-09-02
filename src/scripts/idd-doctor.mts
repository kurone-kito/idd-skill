#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-doctor.mts
//
// The scripts/idd-doctor.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitabilityMarker,
} from './autopilot-suitability.mts';
import { parseCliArgs } from './cli-args.mts';
import { resolveHelperCommandForProfile } from './helper-runtime-manifest.mts';
import { isValidIsoTimestamp } from './marker-helpers.mts';
import {
  inspectHelperRuntimeConfig,
  POLICY_DEFAULTS,
  parseProjectCommandRows,
} from './policy-helpers.mts';
import { fetchGovernanceJson } from './pre-merge-readiness.mts';
import {
  parsePaginatedGhNdjson,
  resolveTrustedMarkerActors,
  summarizeBranchReviewRequirements,
  summarizeRequiredCheckMetadata,
} from './protocol-helpers.mts';
import { loadJson, validate } from './validate-schemas.mts';

const WORKSHOP_ENTRY_POINTS = ['README.md', 'README.ja.md', 'docs/index.md'];
const WORKSHOP_REL_PATH = 'docs/workshop';
const WORKSHOP_LINK_TARGET_PATTERNS = [
  /(?:^|\/)docs\/workshop(?:\/|$)/,
  /(?:^|\/)workshop(?:\/|$)/,
];
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;

export { parseProjectCommandRows };

/** Aggregated doctor findings for one repository root. */
export interface DoctorReport {
  root: string;
  errors: string[];
  warnings: string[];
  passes: string[];
}

/** Options accepted by `runDoctor`. */
export interface DoctorOptions {
  root: string;
  requireGithub?: boolean;
  cleanupBacklogWindowDays?: number;
  cleanupBacklogWarnThreshold?: number;
  cleanupBacklogBootstrapCutoff?: string;
  workshopCrossRefAllowMissing?: string[];
  strict?: boolean;
}

/** Verdict for one primary-worktree HEAD classification. */
export interface PrimaryHeadClassification {
  isB1Violation: boolean;
  kind: 'unknown' | 'other' | 'issue' | 'roadmap-audit' | 'implementation';
}

/** One reportable finding about the primary-worktree HEAD. */
export interface WorktreeHeadFinding {
  level: 'error' | 'warning';
  message: string;
}

/** Marker prefixes extracted from one instruction file. */
export interface MarkerPrefixSets {
  roadmap: string[];
  blockedBy: string[];
}

/** Outcome of the marker-prefix consistency evaluation. */
export type MarkerPrefixConsistency =
  | { skip: true; error?: undefined; prefix?: undefined }
  | { skip?: undefined; error: string; prefix?: undefined }
  | { skip?: undefined; error?: undefined; prefix: string };

/** Backlog verdict for the post-merge cleanup check. */
export interface CleanupBacklogVerdict {
  count: number;
  warn: boolean;
  examples: number[];
}

interface SuitabilityIssueInput {
  number?: unknown;
  body?: unknown;
  labels?: unknown;
}

type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; code: number | undefined; stderr: string; stdout: string };

interface DoctorCliArgs {
  root: string;
  json: boolean;
  help: boolean;
  requireGithub: boolean;
  strict: boolean;
  cleanupBacklogWindowDays?: number;
  cleanupBacklogWarnThreshold?: number;
  cleanupBacklogBootstrapCutoff?: string;
  workshopCrossRefAllowMissing?: string[];
}

export function runDoctor({
  root,
  requireGithub,
  cleanupBacklogWindowDays,
  cleanupBacklogWarnThreshold,
  cleanupBacklogBootstrapCutoff,
  workshopCrossRefAllowMissing,
  strict,
}: DoctorOptions): DoctorReport {
  const files = listFiles(root);
  const textFiles = files.filter(isTextLikeFile);
  const report: DoctorReport = {
    root,
    errors: [],
    warnings: [],
    passes: [],
  };

  checkRequiredFiles(files, report);
  checkPlaceholders(root, textFiles, report);
  const markerPrefix = checkMarkerPrefixes(root, report);
  const projectCommands = checkProjectCommands(root, report);
  checkCommandResidueAndConsistency(
    root,
    markerPrefix,
    projectCommands,
    report,
  );
  checkPolicySignals(root, report);
  checkHelperRuntimeConfig(root, report);
  checkLiveConfigSchema(root, report);
  checkClaimTimingConsistency(root, report);
  checkMergePolicyAcknowledgement(root, report);
  checkDependencyVersionDrift(root, report);
  checkAgentEntryFiles(root, report);
  checkTemplateVersionSignal(root, report);
  const worktreeGuardEnforced =
    strict === true || readWorktreeGuardEnabled(root);
  checkPrimaryWorktreeHead(root, report, { enforce: worktreeGuardEnforced });
  checkWorktreeGuardActive(root, report);
  checkWorktreeHardeningPresence(root, report);
  checkPostMergeCleanupBacklog(
    root,
    {
      windowDays: cleanupBacklogWindowDays ?? 14,
      warnThreshold: cleanupBacklogWarnThreshold ?? 2,
      bootstrapCutoff: cleanupBacklogBootstrapCutoff,
      requireGithub,
    },
    report,
  );
  checkReleaseTagDrift(root, report);
  checkWorkshopCrossReferences(
    root,
    { allowMissing: workshopCrossRefAllowMissing ?? [] },
    report,
  );
  checkWorkshopExampleRepoBackLink(root, { requireGithub }, report);
  checkGithubReadiness(root, requireGithub, report);
  checkAutopilotSuitabilityConsistency(
    root,
    { requireGithub, markerPrefix },
    report,
  );

  return report;
}

/**
 * Classify each open issue's authored autopilot-suitability marker and
 * emit warning strings for contradictions, without any I/O. Exported
 * for unit testing. Issues are `{ number, body, labels }` where labels
 * are strings or `{ name }` objects.
 */
export function evaluateAutopilotSuitabilityConsistency(
  issues: unknown,
  options: {
    floor?: unknown;
    markerPrefix?: unknown;
    blockedByHumanLabelName?: unknown;
  } = {},
): { warnings: string[] } {
  const floor = normalizeAutopilotSuitabilityFloor(options.floor);
  const prefix =
    typeof options.markerPrefix === 'string' && options.markerPrefix.length > 0
      ? options.markerPrefix
      : 'idd-skill';
  const blockedByHumanLabelName =
    typeof options.blockedByHumanLabelName === 'string' &&
    options.blockedByHumanLabelName.length > 0
      ? options.blockedByHumanLabelName
      : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
  const warnings: string[] = [];
  for (const issue of (Array.isArray(issues)
    ? issues
    : []) as SuitabilityIssueInput[]) {
    const labelNames = new Set(
      ((issue?.labels ?? []) as unknown[]).map((label) =>
        typeof label === 'string'
          ? label
          : ((label as { name?: unknown } | null)?.name ?? ''),
      ),
    );
    const blockedByHuman = labelNames.has(blockedByHumanLabelName);
    const marker = parseAutopilotSuitabilityMarker(issue?.body, prefix);
    if (!marker.present) {
      continue;
    }
    const number = issue?.number;
    if (marker.malformed) {
      warnings.push(
        `autopilot-suitability: issue #${number} has a malformed or out-of-range score marker (expected a single integer 1-5)`,
      );
      continue;
    }
    if (marker.value === 1 && !blockedByHuman) {
      warnings.push(
        `autopilot-suitability: issue #${number} is scored 1 (human-only) but is missing the ${blockedByHumanLabelName} label`,
      );
    } else if (
      marker.value !== null &&
      marker.value > 1 &&
      marker.value >= floor &&
      blockedByHuman
    ) {
      warnings.push(
        `autopilot-suitability: issue #${number} is scored ${marker.value} (>= floor ${floor}) but carries ${blockedByHumanLabelName}; the score and label disagree`,
      );
    }
  }
  return { warnings };
}

function checkAutopilotSuitabilityConsistency(
  root: string,
  options: { requireGithub?: boolean; markerPrefix: string | null },
  report: DoctorReport,
) {
  const requireGithub = options.requireGithub === true;
  const recordGhFailure = (message: string) => {
    if (requireGithub) {
      report.errors.push(`autopilot-suitability consistency check: ${message}`);
    }
  };

  const list = runCommand(
    'gh',
    [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number,labels,body',
      '--limit',
      '1000',
    ],
    root,
  );
  if (!list.ok) {
    recordGhFailure('gh issue list unavailable');
    return;
  }
  let issues: unknown;
  try {
    issues = JSON.parse(list.stdout);
  } catch {
    recordGhFailure('gh issue list returned invalid JSON');
    return;
  }
  if (!Array.isArray(issues) || issues.length === 0) {
    return;
  }

  const { floor, blockedByHumanLabelName } =
    resolveAutopilotSuitabilityPolicy(root);

  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor,
    markerPrefix: options.markerPrefix,
    blockedByHumanLabelName,
  });
  for (const warning of warnings) {
    report.warnings.push(warning);
  }
}

export function parsePrimaryWorktreePath(porcelain: unknown): string | null {
  if (typeof porcelain !== 'string') {
    return null;
  }
  // Split on CRLF or LF so a CRLF porcelain line parses (a `\r` is not
  // matched by `.` and `$` does not anchor before a trailing `\r`); this
  // matches the `/\r?\n/` splitting used by the sibling helpers in this
  // file.
  const lines = porcelain.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^worktree (.+)$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export const DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS = [
  'issue/*',
  'roadmap-audit/*',
];

/**
 * Convert a shell-style branch glob to an anchored RegExp, matching the
 * core.hooksPath hook's POSIX `case` semantics: `*` (any run), `?` (any
 * one character), and bracket expressions (`[...]`, `[!...]`/`[^...]`).
 * A malformed glob yields a never-matching RegExp rather than throwing.
 */
function branchGlobToRegExp(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '?') {
      out += '.';
      i += 1;
    } else if (ch === '[') {
      // POSIX glob bracket expression, matching the hook's `case`
      // semantics. A `]` immediately after `[`, `[!`, or `[^` is a
      // literal member rather than the terminator.
      let j = i + 1;
      if (pattern[j] === '!' || pattern[j] === '^') j += 1;
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        out += '\\['; // unterminated — treat the `[` as a literal
        i += 1;
      } else {
        const body = pattern.slice(i + 1, j);
        const negated = body[0] === '!' || body[0] === '^';
        const members = (negated ? body.slice(1) : body)
          .replace(/\\/g, '\\\\')
          .replace(/\]/g, '\\]');
        out += `[${negated ? '^' : ''}${members}]`;
        i = j + 1;
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  try {
    return new RegExp(`${out}$`);
  } catch {
    return /(?!)/; // malformed glob: never matches, never crashes
  }
}

export function classifyPrimaryHead(
  branch: unknown,
  patterns: string[] = DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
): PrimaryHeadClassification {
  if (typeof branch !== 'string' || branch.length === 0) {
    return { isB1Violation: false, kind: 'unknown' };
  }
  const matchedPattern = patterns.find((pattern) =>
    branchGlobToRegExp(pattern).test(branch),
  );
  if (matchedPattern === undefined) {
    return { isB1Violation: false, kind: 'other' };
  }
  // Derive the kind from the matched pattern, not the branch name, so a
  // custom glob (e.g. "*") is reported as a generic implementation
  // branch even when the branch happens to start with issue/.
  if (matchedPattern === 'issue/*') {
    return { isB1Violation: true, kind: 'issue' };
  }
  if (matchedPattern === 'roadmap-audit/*') {
    return { isB1Violation: true, kind: 'roadmap-audit' };
  }
  return { isB1Violation: true, kind: 'implementation' };
}

export function findPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/g)].map(
    (match) => match[0],
  );
}

/**
 * Find unresolved `{{…}}` placeholders in one file's text. Markdown docs
 * under `docs/` legitimately *document* placeholder names inside code
 * spans, so those are stripped first to avoid false positives. Every
 * other file (including `.github/instructions/*.md`, whose marker
 * examples may contain unsubstituted placeholders inside inline code or
 * HTML comments) is scanned raw, so a real leftover is still detected.
 */
export function scanFileForPlaceholders(file: string, text: string): string[] {
  const documentsPlaceholders =
    file.startsWith('docs/') && file.endsWith('.md');
  return findPlaceholders(
    documentsPlaceholders ? stripMarkdownNonText(text) : text,
  );
}

export function extractMarkerPrefixes(text: string): MarkerPrefixSets {
  // The negative lookahead keeps each match to a complete marker token
  // (e.g. `idd-skill-blocked-by:` or `idd-skill-roadmap-id`), so a
  // prose/heading slug such as
  // `diagnostic-all-candidates-blocked-by-an-open-roadmap` is not
  // mis-read as a marker prefix.
  const roadmap = [
    ...text.matchAll(
      /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-roadmap-id(?![A-Za-z0-9-])/g,
    ),
  ].map((match) => match[1]);
  const blockedBy = [
    ...text.matchAll(
      /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-blocked-by(?![A-Za-z0-9-])/g,
    ),
  ].map((match) => match[1]);
  return {
    roadmap: unique(roadmap),
    blockedBy: unique(blockedBy),
  };
}

function checkRequiredFiles(_files: string[], report: DoctorReport) {
  const required = [
    '.github/instructions/idd-overview-core.instructions.md',
    '.github/instructions/idd-discover.instructions.md',
    '.github/instructions/idd-suitability.instructions.md',
    '.github/instructions/idd-claim.instructions.md',
    '.github/instructions/idd-work.instructions.md',
    '.github/instructions/idd-pr-submit.instructions.md',
    '.github/instructions/idd-ci.instructions.md',
    '.github/instructions/idd-review-snapshot.instructions.md',
    '.github/instructions/idd-review-triage.instructions.md',
    '.github/instructions/idd-review-fix.instructions.md',
    '.github/instructions/idd-pre-merge.instructions.md',
    '.github/instructions/idd-merge-handoff.instructions.md',
    '.github/instructions/idd-merge.instructions.md',
    '.github/instructions/idd-resume.instructions.md',
    '.github/instructions/idd-resume-stall.instructions.md',
    '.github/instructions/idd-advisory-wait.instructions.md',
    'docs/getting-started.md',
    'docs/concepts.md',
    'docs/customization.md',
    'docs/reference.md',
    'docs/idd-workflow.md',
    'docs/idd-review-policy-profiles.md',
    'docs/idd-helper-scripts.md',
    'docs/idd-comment-minimization.md',
    'docs/permissions.md',
    'docs/policy-constants.md',
  ];

  const profileFiles = [
    'profiles/README.md',
    'profiles/human-required/README.md',
    'profiles/no-advisory/README.md',
    'profiles/external-bot/README.md',
  ];

  const missingRequired = required.filter(
    (file) => !exists(join(report.root, file)),
  );
  const missingProfiles = profileFiles.filter(
    (file) => !exists(join(report.root, file)),
  );

  if (missingRequired.length > 0) {
    report.errors.push(
      `missing required IDD files: ${missingRequired.join(', ')}`,
    );
  } else {
    report.passes.push('required instruction and reference files are present');
  }

  if (missingProfiles.length > 0) {
    report.warnings.push(
      `missing non-default profile files (expected for adopters): ${missingProfiles.join(', ')}`,
    );
  } else {
    report.passes.push('profile artifacts are present');
  }
}

/**
 * True when `file` (a repo-relative, forward-slash path) is IDD-managed
 * content `checkPlaceholders` should scan for unresolved `{{...}}` import
 * placeholders -- not an adopter's own application source, which can
 * legitimately use `{{...}}` as its own runtime template syntax (i18n,
 * mustache-style templates, etc.) with nothing to do with IDD onboarding
 * (idd-skill#2079). An allowlist, not a denylist: only these path classes
 * are ever scanned -- `docs/*.md`, `profiles/`, `.claude/skills/`,
 * `.github/idd/`, and the vendored `scripts/`/`schemas/`/
 * `fixtures/schemas/` bundle.
 *
 * `.github/instructions/` is included only in adopter mode
 * (`distributionSource` false): in the source repository itself those
 * files document the placeholder syntax with example tokens that are
 * never meant to be "resolved", so scanning them there would self-trigger
 * a false positive on every dogfooded run. Pure (no I/O) so it can be
 * unit-tested directly.
 */
export function isIddManagedPlaceholderScanPath(
  file: string,
  distributionSource: boolean,
): boolean {
  if (file.startsWith('docs/') && file.endsWith('.md')) {
    return true;
  }
  if (
    file.startsWith('profiles/') ||
    file.startsWith('.claude/skills/') ||
    file.startsWith('scripts/') ||
    file.startsWith('schemas/') ||
    file.startsWith('fixtures/schemas/') ||
    file.startsWith('.github/idd/')
  ) {
    return true;
  }
  return !distributionSource && file.startsWith('.github/instructions/');
}

export function checkPlaceholders(
  root: string,
  files: string[],
  report: DoctorReport,
) {
  const distributionSource =
    exists(join(root, 'idd-template/ONBOARDING.md')) &&
    exists(join(root, 'audit/sync-manifest.json'));
  const hits: string[] = [];

  for (const file of files) {
    if (!isIddManagedPlaceholderScanPath(file, distributionSource)) {
      continue;
    }
    const absolutePath = join(root, file);
    let text = '';
    try {
      text = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const placeholders = scanFileForPlaceholders(file, text);
    if (placeholders.length === 0) {
      continue;
    }
    hits.push(`${file}: ${unique(placeholders).join(', ')}`);
  }

  if (hits.length > 0) {
    report.errors.push(
      `unresolved placeholders found: ${hits.slice(0, 10).join(' | ')}`,
    );
    return;
  }
  report.passes.push('no unresolved {{...}} placeholders in IDD-managed files');
}

function checkMarkerPrefixes(
  root: string,
  report: DoctorReport,
): string | null {
  const discoverPath = join(
    root,
    '.github/instructions/idd-discover.instructions.md',
  );
  const overviewPath = join(
    root,
    '.github/instructions/idd-overview-core.instructions.md',
  );
  let discover = '';
  let overview = '';
  try {
    discover = readFileSync(discoverPath, 'utf8');
    overview = readFileSync(overviewPath, 'utf8');
  } catch {
    report.warnings.push(
      'marker-prefix checks skipped because discover/overview files are missing',
    );
    return null;
  }

  const result = evaluateMarkerPrefixConsistency(
    extractMarkerPrefixes(discover),
    extractMarkerPrefixes(overview),
  );
  if (result.skip) {
    report.warnings.push(
      'marker-prefix checks skipped because no resolved marker prefixes were found',
    );
    return null;
  }
  if (result.error) {
    report.errors.push(result.error);
    return null;
  }
  report.passes.push(
    `marker prefix is valid and consistent (${result.prefix})`,
  );
  return result.prefix ?? null;
}

/**
 * Decide whether the marker prefixes extracted from the discover and
 * overview instruction files are valid and consistent. Pure (no I/O), so
 * it can be unit-tested. Empty sets impose no constraint (a file may not
 * reference roadmap-id/blocked-by markers at all — e.g. overview-core,
 * which defines claim markers, not roadmap markers), but an explicit
 * all-prefixes guard still catches a mismatch hidden across different
 * marker types (e.g. discover uses `a-roadmap-id` while overview uses
 * `b-blocked-by`).
 */
export function evaluateMarkerPrefixConsistency(
  discoverPrefixes: MarkerPrefixSets,
  overviewPrefixes: MarkerPrefixSets,
): MarkerPrefixConsistency {
  const allPrefixes = unique([
    ...discoverPrefixes.roadmap,
    ...discoverPrefixes.blockedBy,
    ...overviewPrefixes.roadmap,
    ...overviewPrefixes.blockedBy,
  ]);
  if (allPrefixes.length === 0) {
    return { skip: true };
  }
  const invalid = allPrefixes.filter(
    (prefix) => !/^[a-z][a-z0-9-]{1,31}$/.test(prefix),
  );
  if (invalid.length > 0) {
    return { error: `invalid marker prefixes: ${invalid.join(', ')}` };
  }
  // Compare only populated sets so a file that does not reference these
  // markers at all imposes no constraint.
  const consistent = (left: string[], right: string[]) =>
    left.length === 0 || right.length === 0 || sameMembers(left, right);
  if (!consistent(discoverPrefixes.roadmap, discoverPrefixes.blockedBy)) {
    return {
      error:
        'discover marker prefixes differ between roadmap-id and blocked-by',
    };
  }
  if (!consistent(overviewPrefixes.roadmap, overviewPrefixes.blockedBy)) {
    return {
      error:
        'overview marker prefixes differ between roadmap-id and blocked-by',
    };
  }
  if (
    !consistent(discoverPrefixes.roadmap, overviewPrefixes.roadmap) ||
    !consistent(discoverPrefixes.blockedBy, overviewPrefixes.blockedBy)
  ) {
    return {
      error:
        'marker prefixes differ between discover and overview instructions',
    };
  }
  // Catch a mismatch the empty-tolerant pairwise checks miss: two files
  // referencing different marker types with different prefixes.
  if (allPrefixes.length > 1) {
    return {
      error: `marker prefixes are inconsistent across discover/overview instructions: ${allPrefixes.join(', ')}`,
    };
  }
  return { prefix: allPrefixes[0] };
}

// The Project commands table normally lives in idd-overview-core, but a
// router/core split can keep it in idd-overview instead. Resolve whichever
// candidate carries a non-empty table rather than hardcoding one file.
const PROJECT_COMMANDS_CANDIDATE_FILES = [
  '.github/instructions/idd-overview-core.instructions.md',
  '.github/instructions/idd-overview.instructions.md',
];

export function checkProjectCommands(
  root: string,
  report: DoctorReport,
): Map<string, string> | null {
  let commands: Map<string, string> | null = null;
  let usedPath = '';
  for (const rel of PROJECT_COMMANDS_CANDIDATE_FILES) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseProjectCommandRows(text);
    if (parsed.size > 0) {
      commands = parsed;
      usedPath = rel;
      break;
    }
  }
  if (!commands) {
    report.errors.push(
      `cannot find a Project commands table in any of: ${PROJECT_COMMANDS_CANDIDATE_FILES.join(', ')}`,
    );
    return null;
  }

  const requiredRows = [
    'fix-validate',
    'pre-push-validate',
    'post-fix-validate',
    'install-deps',
  ];
  const missingRows = requiredRows.filter((row) => !commands.has(row));
  if (missingRows.length > 0) {
    report.errors.push(
      `project commands table (${usedPath}) is missing rows: ${missingRows.join(', ')}`,
    );
    return null;
  }

  const noOps = requiredRows.filter((row) => commands.get(row) === 'true');
  if (noOps.length === requiredRows.length) {
    report.warnings.push(
      'all primary command rows are set to `true` (no-op substitutions)',
    );
  } else {
    report.passes.push('project commands table has non-empty command values');
  }
  return commands;
}

function checkCommandResidueAndConsistency(
  root: string,
  markerPrefix: string | null,
  projectCommands: Map<string, string> | null,
  report: DoctorReport,
) {
  if (!(projectCommands instanceof Map)) {
    return;
  }

  const policyCommands = loadPolicyCommands(root);
  const policyCommandMap =
    policyCommands instanceof Map ? policyCommands : new Map<string, string>();

  const sharedKeys = unique(
    [...policyCommandMap.keys()].filter((key) => projectCommands.has(key)),
  ).sort();
  for (const key of sharedKeys) {
    const configValue = normalizeCommandValue(policyCommandMap.get(key));
    const overviewValue = normalizeCommandValue(projectCommands.get(key));
    if (
      !isConcreteCommandValue(configValue) ||
      !isConcreteCommandValue(overviewValue)
    ) {
      continue;
    }
    if (configValue !== overviewValue) {
      report.warnings.push(
        `command mismatch between .github/idd/config.json and overview table for "${key}": config="${configValue}" overview="${overviewValue}"`,
      );
    }
  }

  if (typeof markerPrefix !== 'string' || markerPrefix.length === 0) {
    report.warnings.push(
      'toolchain residue checks skipped because marker prefix could not be resolved',
    );
    return;
  }
  if (markerPrefix === 'idd-skill') {
    return;
  }

  const residueMessages = new Set<string>();
  for (const [source, commands] of [
    ['.github/idd/config.json', policyCommandMap],
    ['overview project commands table', projectCommands],
  ] as [string, Map<string, string>][]) {
    for (const [key, value] of commands.entries()) {
      const normalized = normalizeCommandValue(value);
      if (normalized === null) {
        continue;
      }
      const token = findToolchainResidueToken(normalized, key);
      if (!token) {
        continue;
      }
      residueMessages.add(
        `toolchain residue detected for marker prefix "${markerPrefix}": ${source} "${key}" contains "${token}"`,
      );
    }
  }
  for (const message of residueMessages) {
    report.warnings.push(message);
  }
}

function loadPolicyCommands(root: string): Map<string, string> | null {
  const configPath = join(root, '.github/idd/config.json');
  if (!exists(configPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
  const commands = (parsed as { commands?: unknown } | null)?.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    return null;
  }

  return new Map(
    Object.entries(commands).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function normalizeCommandValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim();
}

function isConcreteCommandValue(value: string | null): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    return false;
  }
  return !/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/.test(value);
}

/**
 * Per-key documented invocation segments from
 * `idd-template/docs/customization.md`'s worked-example commands table,
 * split on `&&` and trimmed. A command value's residue-token segment is
 * exempt from the warning only when it matches one of these verbatim for
 * the same key -- the same token under a different key (e.g. `dprint
 * check` under `fix-validate`, whose documented form is `dprint fmt`) is
 * not exempt.
 */
export const DOCUMENTED_TOOLCHAIN_SEGMENTS: Readonly<
  Record<string, readonly string[]>
> = {
  'fix-validate': [
    'npx dprint fmt "**/*.md"',
    'npx markdownlint-cli2 --fix "**/*.md"',
    'npx markdownlint-cli2 "**/*.md"',
    'npx cspell lint "**" --no-progress',
  ],
  'pre-push-validate': [
    'npx dprint check "**/*.md"',
    'npx markdownlint-cli2 "**/*.md"',
    'npx cspell lint "**" --no-progress',
  ],
  'post-fix-validate': [
    'npx dprint fmt "**/*.md"',
    'npx markdownlint-cli2 --fix "**/*.md"',
    'npx markdownlint-cli2 "**/*.md"',
    'npx cspell lint "**" --no-progress',
  ],
};

function findToolchainResidueToken(value: string, key: string): string | null {
  const documented = DOCUMENTED_TOOLCHAIN_SEGMENTS[key];
  const segments = value.split('&&').map((segment) => segment.trim());
  for (const token of ['dprint', 'markdownlint-cli2', 'cspell']) {
    const pattern = new RegExp(`\\b${escapeRegex(token)}\\b`, 'i');
    const matchingSegments = segments.filter((segment) =>
      pattern.test(segment),
    );
    if (matchingSegments.length === 0) {
      continue;
    }
    const allDocumented =
      documented !== undefined &&
      matchingSegments.every((segment) => documented.includes(segment));
    if (!allDocumented) {
      return token;
    }
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkPolicySignals(root: string, report: DoctorReport) {
  const files = [
    'README.md',
    'README.ja.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    'docs/idd-policy.md',
    '.github/idd/config.json',
    'idd-policy.json',
  ];
  const existing = files.filter((file) => exists(join(root, file)));
  const corpus = existing
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('\n');

  const mergePolicies = [
    'fully_autonomous_merge',
    'human_merge',
    'separate_merge_agent',
  ];
  if (!mergePolicies.some((policy) => corpus.includes(policy))) {
    report.errors.push('merge policy signal not found in docs or entry files');
  } else {
    report.passes.push('merge policy signal found');
  }

  const reviewPolicySignals = [
    'copilot-advisory',
    'copilot advisory',
    'no-advisory',
    'human-required',
    'external-bot',
    'strict-reviewer-resolve',
  ];
  if (
    !reviewPolicySignals.some((signal) => corpus.toLowerCase().includes(signal))
  ) {
    report.warnings.push(
      'review policy signal not found in docs or entry files',
    );
  } else {
    report.passes.push('review policy signal found');
  }
}

function checkHelperRuntimeConfig(root: string, report: DoctorReport) {
  const candidates = ['.github/idd/config.json', 'idd-policy.json'];

  for (const file of candidates) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      continue;
    }

    let config: unknown;
    try {
      config = JSON.parse(readFileSync(absolutePath, 'utf8'));
    } catch {
      report.errors.push(`${file} is not valid JSON`);
      continue;
    }

    const helperRuntime = inspectHelperRuntimeConfig(config);
    if (helperRuntime.status === 'absent') {
      report.passes.push(
        `${file} leaves helperRuntime unset (instructions-only fallback)`,
      );
      continue;
    }
    if (helperRuntime.status === 'invalid') {
      report.errors.push(`${file}: ${helperRuntime.reason}`);
      continue;
    }
    report.passes.push(
      `${file} declares helper runtime profile "${helperRuntime.profile}"`,
    );
  }
}

// The two live-config filenames idd-doctor already recognizes elsewhere in
// this file (checkHelperRuntimeConfig's and checkTemplateVersionSignal's own
// candidate lists): `.github/idd/config.json` is canonical, `idd-policy.json`
// is the legacy top-level name. Both get the same schema check so an adopter
// still on the legacy filename gets the same #1359 coverage.
const LIVE_CONFIG_CANDIDATE_FILES = [
  '.github/idd/config.json',
  'idd-policy.json',
];
const LIVE_CONFIG_ERRORS_SHOWN = 10;

/**
 * Resolve the repository's configured `helperRuntime` (`profile` plus the
 * optional pinned `packageSpec`, idd-skill#1731) for building profile-aware
 * remediation text (see `formatCleanupBacklogRemediation` below), trying
 * the same live-config candidates as `checkHelperRuntimeConfig` in
 * declaration order.
 *
 * The **first present candidate wins outright** -- whether it declares a
 * valid profile, leaves `helperRuntime` absent, or is malformed -- and the
 * search never falls through to a later (legacy) candidate once a present
 * file has been evaluated. A present canonical `.github/idd/config.json`
 * that omits `helperRuntime` is an intentional `instructions-only`
 * declaration, not an invitation to consult a stale `idd-policy.json` left
 * over from before a migration to the canonical filename -- silently
 * picking up the legacy file's profile there would build a remediation
 * command for a runtime the repository no longer uses (idd-skill#1718
 * review: both Copilot and the secondary advisory bot flagged this
 * independently). Only an *absent* (nonexistent) candidate file is
 * skipped in favor of the next one.
 *
 * Defaults to `{ profile: 'instructions-only', packageSpec: '' }` -- the
 * safe, no-runnable-command fallback -- when no candidate file exists at
 * all, the first present one is not valid JSON, or it does not declare a
 * valid `helperRuntime.profile`; those cases are already surfaced as their
 * own findings by `checkHelperRuntimeConfig` / `checkLiveConfigSchema`;
 * this resolver only needs a fail-closed profile to build remediation text
 * from, not a second diagnostic. `packageSpec` is `''` (meaning: fall back
 * to the default package spec) whenever it isn't configured, even when
 * `profile` itself resolved successfully.
 *
 * Both `resolveConfiguredHelperRuntimeProfile` and
 * `resolveConfiguredHelperRuntimePackageSpec` below delegate to this single
 * internal walk so the file-candidate-resolution invariant above lives in
 * exactly one place.
 */
function resolveConfiguredHelperRuntime(root: string): {
  profile: string;
  packageSpec: string;
} {
  for (const file of LIVE_CONFIG_CANDIDATE_FILES) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      continue;
    }
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(absolutePath, 'utf8'));
    } catch {
      return { profile: 'instructions-only', packageSpec: '' };
    }
    const helperRuntime = inspectHelperRuntimeConfig(config);
    return helperRuntime.status === 'ok'
      ? {
          profile: helperRuntime.profile,
          packageSpec: helperRuntime.packageSpec ?? '',
        }
      : { profile: 'instructions-only', packageSpec: '' };
  }
  return { profile: 'instructions-only', packageSpec: '' };
}

export function resolveConfiguredHelperRuntimeProfile(root: string): string {
  return resolveConfiguredHelperRuntime(root).profile;
}

/**
 * Resolve the repository's configured `helperRuntime.packageSpec`
 * (idd-skill#1731), for threading a pinned ephemeral-npx/package-manager
 * spec into remediation text instead of always falling back to the
 * mutable default archive URL. Returns `''` (use the default) under the
 * same fail-closed conditions as `resolveConfiguredHelperRuntimeProfile`:
 * no candidate file, invalid JSON, an invalid `helperRuntime`, or simply no
 * `packageSpec` configured.
 */
export function resolveConfiguredHelperRuntimePackageSpec(
  root: string,
): string {
  return resolveConfiguredHelperRuntime(root).packageSpec;
}

/**
 * Resolve the repository's live IDD config document, preferring the
 * canonical `.github/idd/config.json` and falling back to the legacy
 * `idd-policy.json` only when the canonical file is entirely absent --
 * the same first-present-candidate-wins-outright walk over
 * `LIVE_CONFIG_CANDIDATE_FILES` as `resolveConfiguredHelperRuntime` above,
 * never a per-key merge of the two files. Shared by every scalar policy
 * reader below (`readWorktreeGuardEnabled`, `readWorktreeGuardBranchPatterns`,
 * `readCleanupEvidenceTrustedLogins`, `readTrustEmptyProtectionReads`, and
 * `checkAutopilotSuitabilityConsistency`'s floor/label read) so the
 * two-file resolution invariant lives in exactly one place instead of five
 * separate copies that only ever read the canonical filename
 * (idd-skill#2028).
 *
 * Returns `{ config: null, file: null }` when no candidate file exists;
 * `{ config: null, file }` when the first present candidate (`file`) is
 * not valid JSON -- each caller keeps its own fail-closed default for
 * either case, matching every reader's behavior before this extraction.
 * `file` names which candidate was selected (idd-skill#2301 review) so a
 * caller building a remediation message can point at the file actually
 * read instead of assuming the canonical name.
 */
function resolveLiveConfigDocument(root: string): {
  config: unknown;
  file: string | null;
} {
  for (const file of LIVE_CONFIG_CANDIDATE_FILES) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      continue;
    }
    try {
      return { config: JSON.parse(readFileSync(absolutePath, 'utf8')), file };
    } catch {
      return { config: null, file };
    }
  }
  return { config: null, file: null };
}

/**
 * Resolve `autopilotSuitability.floor` and `labels.blockedByHumanLabelName`
 * from the live IDD config (canonical-first, legacy-`idd-policy.json`
 * fallback via {@link resolveLiveConfigDocument}), for
 * `checkAutopilotSuitabilityConsistency`'s cross-field check. Extracted as
 * its own exported reader -- matching `readWorktreeGuardEnabled` and its
 * siblings -- so this one config read is independently unit-testable
 * without mocking `gh issue list` (idd-skill#2028).
 */
export function resolveAutopilotSuitabilityPolicy(root: string): {
  floor: unknown;
  blockedByHumanLabelName: unknown;
} {
  const { config } = resolveLiveConfigDocument(root);
  const typedConfig = config as {
    autopilotSuitability?: { floor?: unknown };
    labels?: { blockedByHumanLabelName?: unknown };
  } | null;
  return {
    floor: typedConfig?.autopilotSuitability?.floor,
    blockedByHumanLabelName: typedConfig?.labels?.blockedByHumanLabelName,
  };
}

/**
 * Decide whether a parsed live-config document is a schema finding, given
 * the canonical policy schema and the file it was read from (for the
 * message). Pure (no I/O) so it can be unit-tested directly. Returns `null`
 * when `config` validates cleanly.
 *
 * This is the live-config counterpart to the `ciWait`/`advisoryWait`
 * readers' own subtree-scoped validation (#1359): those readers only
 * revert their own section on their own section's error, so a malformed
 * config (an unknown top-level key, `additionalProperties: false`
 * rejecting an adopter typo, a typo'd enum anywhere in the document, ...)
 * would otherwise pass through with no diagnostic at all. This check
 * surfaces every schema error against the whole document instead, so a
 * malformed live config no longer passes idd-doctor silently.
 */
export function classifyLiveConfigSchemaFinding(
  config: unknown,
  schema: unknown,
  file: string = '.github/idd/config.json',
): { level: 'error'; message: string } | null {
  const errors = validate(config, schema);
  if (errors.length === 0) {
    return null;
  }
  const shown = errors.slice(0, LIVE_CONFIG_ERRORS_SHOWN);
  const remainder = errors.length - shown.length;
  const suffix = remainder > 0 ? ` (and ${remainder} more)` : '';
  return {
    level: 'error',
    message: `${file} fails schema validation against policy.schema.json: ${shown.join('; ')}${suffix}`,
  };
}

/**
 * Validate each present live-config file (`.github/idd/config.json` and the
 * legacy `idd-policy.json`) against the canonical policy schema and report
 * any errors as a doctor finding. Skips a candidate silently when it is
 * absent (nothing to validate) or is not valid JSON (already reported by
 * checkHelperRuntimeConfig above); skips the whole check when the bundled
 * schema itself cannot be loaded (a bootstrap edge case, not a live-config
 * problem).
 */
export function checkLiveConfigSchema(root: string, report: DoctorReport) {
  let schema: unknown;
  try {
    schema = loadJson('schemas/policy.schema.json');
  } catch {
    report.warnings.push(
      'live-config schema check skipped: schemas/policy.schema.json could not be loaded',
    );
    return;
  }

  for (const file of LIVE_CONFIG_CANDIDATE_FILES) {
    const configPath = join(root, file);
    if (!exists(configPath)) {
      continue;
    }

    let config: unknown;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }

    const finding = classifyLiveConfigSchemaFinding(config, schema, file);
    if (!finding) {
      report.passes.push(`${file} validates against policy.schema.json`);
      continue;
    }
    report.errors.push(finding.message);
  }
}

/** One reportable finding from the claimTiming config↔prose check. */
export interface ClaimTimingFinding {
  level: 'warning';
  message: string;
}

/** One config↔prose value pair this doctor cross-checks. */
interface ClaimTimingAnchor {
  configKey: 'staleAge' | 'heartbeatInterval';
  label: string;
  proseHoursKey: 'staleAgeHours' | 'heartbeatIntervalHours';
}

// Adding a future anchor is a one-line addition here — no new branching
// logic — as long as its prose lives in the same Thresholds section
// parsed by parseThresholdsProseHours.
const CLAIM_TIMING_ANCHORS: readonly ClaimTimingAnchor[] = [
  {
    configKey: 'staleAge',
    label: 'claimTiming.staleAge',
    proseHoursKey: 'staleAgeHours',
  },
  {
    configKey: 'heartbeatInterval',
    label: 'claimTiming.heartbeatInterval',
    proseHoursKey: 'heartbeatIntervalHours',
  },
];

/**
 * Parse an ISO 8601 duration to whole hours. Returns null when the input
 * is not a string, does not match the ISO 8601 duration grammar, carries
 * sub-hour precision (minutes/seconds) — the Thresholds prose only ever
 * states whole hours, so a sub-hour config value has no prose counterpart
 * to compare against — or resolves to zero hours (`PT0H`, ...), which
 * matches the grammar but is operationally meaningless as a
 * stale-age/heartbeat value. A negative duration cannot occur: the
 * grammar has no sign, so a leading `-` fails the `^P` anchor outright.
 *
 * The lookaheads (`(?=\d|T\d)` after `P`, `(?=\d)` after `T`) mirror
 * `schemas/policy.schema.json`'s `claimTiming.staleAge`/
 * `heartbeatInterval` pattern exactly, so this rejects the same
 * dangling-designator strings the schema does (bare `P`, bare `PT`,
 * `P1DT` with no time components after `T`) at the match stage, instead
 * of accepting them as a syntactically-valid zero/malformed duration
 * that a looser grammar would silently normalize.
 */
export function parseIsoDurationToHours(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match =
    /^P(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  if (Number(minutes ?? 0) !== 0 || Number(seconds ?? 0) !== 0) {
    return null;
  }
  const totalHours = Number(days ?? 0) * 24 + Number(hours ?? 0);
  return totalHours > 0 ? totalHours : null;
}

// Matches the start of the next Markdown list item: a newline, optional
// leading indentation (nested/indented lists), then one of the three
// common bullet markers and at least one space. Whitespace-tolerant so
// an indented or differently-marked list still bounds correctly instead
// of letting the slice run past the intended bullet.
const NEXT_BULLET_PATTERN = /\n[ \t]*[-*+]\s+/;

/**
 * Slice `section` down to just the bullet introduced by `bulletLabel`
 * (e.g. `**Stale**:`), stopping before the next list item (see
 * {@link NEXT_BULLET_PATTERN}) or at the end of `section`. Returns null
 * when `bulletLabel` is not found. Bounding the slice to one bullet is
 * what stops the anchor regexes in {@link parseThresholdsProseHours}
 * from crossing into an unrelated number that happens to appear in a
 * *different* bullet.
 */
function extractBulletText(
  section: string,
  bulletLabel: string,
): string | null {
  const start = section.indexOf(bulletLabel);
  if (start === -1) {
    return null;
  }
  const rest = section.slice(start);
  const nextBulletMatch = NEXT_BULLET_PATTERN.exec(rest);
  return nextBulletMatch ? rest.slice(0, nextBulletMatch.index) : rest;
}

/**
 * Extract the stale-age and heartbeat-interval hour values the
 * `## Thresholds` section of overview-core prose states. Returns null for
 * the whole result when the section heading itself is not found (the
 * section was renamed or removed); returns null for an individual field
 * when that field's own bullet, or its anchor phrase within that bullet,
 * is not found (the bullet was reworded past recognition or removed).
 * Neither case is an error — the caller skips the comparison for what it
 * cannot parse. Each anchor regex is matched only within its own
 * bullet's text (see {@link extractBulletText}), so a number in an
 * unrelated bullet is never misattributed to this field.
 */
export function parseThresholdsProseHours(overviewCoreText: string): {
  staleAgeHours: number | null;
  heartbeatIntervalHours: number | null;
} | null {
  const sectionStart = overviewCoreText.indexOf('## Thresholds');
  if (sectionStart === -1) {
    return null;
  }
  const nextHeading = overviewCoreText.indexOf('\n## ', sectionStart + 1);
  const section = overviewCoreText.slice(
    sectionStart,
    nextHeading === -1 ? undefined : nextHeading,
  );

  const staleBullet = extractBulletText(section, '**Stale**:');
  const heartbeatBullet = extractBulletText(section, '**Heartbeat**:');
  const staleMatch = staleBullet ? /≥\s*(\d+)\s*h\b/.exec(staleBullet) : null;
  const heartbeatMatch = heartbeatBullet
    ? /every\s+(\d+)\s*h\b/.exec(heartbeatBullet)
    : null;

  return {
    staleAgeHours: staleMatch ? Number(staleMatch[1]) : null,
    heartbeatIntervalHours: heartbeatMatch ? Number(heartbeatMatch[1]) : null,
  };
}

/**
 * Compare `.github/idd/config.json`'s claimTiming values against the
 * overview-core Thresholds prose. Returns a warning-level finding naming
 * both locations and both values only when a config value and its
 * matching prose value are both parseable AND numerically differ. Returns
 * null (no finding) when the section/bullet cannot be parsed, when either
 * side is unparseable, or when the values agree — this check never
 * produces an error, per its acceptance criteria, and degrades silently
 * on a customized adopter repo rather than false-failing it.
 */
export function classifyClaimTimingConsistency(
  claimTiming: { staleAge?: unknown; heartbeatInterval?: unknown } | undefined,
  overviewCoreText: string,
): ClaimTimingFinding | null {
  if (!claimTiming) {
    return null;
  }
  const prose = parseThresholdsProseHours(overviewCoreText);
  if (!prose) {
    return null;
  }

  const mismatches: string[] = [];
  for (const anchor of CLAIM_TIMING_ANCHORS) {
    const configHours = parseIsoDurationToHours(claimTiming[anchor.configKey]);
    const proseHours = prose[anchor.proseHoursKey];
    if (configHours === null || proseHours === null) {
      continue;
    }
    if (configHours !== proseHours) {
      mismatches.push(
        `${anchor.label} is ${configHours} h in .github/idd/config.json but ` +
          `${proseHours} h in the Thresholds section of ` +
          '.github/instructions/idd-overview-core.instructions.md',
      );
    }
  }

  if (mismatches.length === 0) {
    return null;
  }
  return {
    level: 'warning',
    message: `config↔instruction-prose policy-value drift: ${mismatches.join('; ')}.`,
  };
}

export function checkClaimTimingConsistency(
  root: string,
  report: DoctorReport,
) {
  const read = (relativePath: string) => {
    try {
      return readFileSync(join(root, relativePath), 'utf8');
    } catch {
      return null;
    }
  };
  const configText = read('.github/idd/config.json');
  const overviewCoreText = read(
    '.github/instructions/idd-overview-core.instructions.md',
  );
  if (configText === null || overviewCoreText === null) {
    return;
  }

  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return;
  }
  const claimTiming = (config as { claimTiming?: unknown } | null)
    ?.claimTiming as
    | { staleAge?: unknown; heartbeatInterval?: unknown }
    | undefined;

  const finding = classifyClaimTimingConsistency(claimTiming, overviewCoreText);
  if (finding) {
    report.warnings.push(finding.message);
  }
}

/** One reportable finding from the mergePolicy acknowledgement check. */
export interface MergePolicyAckFinding {
  level: 'warning';
  message: string;
}

/**
 * `fully_autonomous_merge` grants an agent unattended F3 merge authority
 * and is an explicit opt-in against the distributed `human_merge` default
 * (idd-skill#2284). This reminds an operator who has `mergePolicy:
 * "fully_autonomous_merge"` recorded -- including one who reached it via
 * the old distributed default before it flipped -- that the profile is
 * now an explicit choice, unless they have confirmed it with a matching
 * `mergePolicyAck`. `mergePolicyAck` is diagnostics-only: it never
 * participates in F2.5/F3 merge-authority resolution and this check never
 * changes what any `mergePolicy` value authorizes.
 *
 * `file` names the live-config candidate `config` was actually read from
 * (`.github/idd/config.json` or the legacy `idd-policy.json`) so the
 * remediation text points at the file the operator needs to edit, not
 * always the canonical name (idd-skill#2301 review) -- setting
 * `mergePolicyAck` in a *different* candidate than the one this doctor
 * run selected would not silence the warning.
 *
 * Returns null (no finding) for every `mergePolicy` value other than
 * `fully_autonomous_merge`, for a missing/absent `mergePolicy` key, or
 * when `mergePolicyAck` already equals `"fully_autonomous_merge"`.
 *
 * The ack is scoped to that exact value rather than a boolean: while
 * `mergePolicy` is any value *other than* `fully_autonomous_merge`, this
 * always returns null regardless of `mergePolicyAck` (the check only
 * fires for that one value). But this is NOT a full time/generation-scoped
 * reset -- a round trip that later lands back on the exact same
 * `fully_autonomous_merge` value, with `mergePolicyAck` still equal to
 * `"fully_autonomous_merge"` from an earlier, now-stale confirmation
 * that was never cleared in between, does **not** resume the
 * warning: it silently returns null again. This diagnostics-only field
 * has no timestamp or generation counter to detect that narrow case -- a
 * known, accepted limitation of the deliberately value-scoped (not
 * boolean, not time-scoped) design (idd-skill#2301 review, rejected as a
 * follow-up beyond this issue's locked scope).
 */
export function classifyMergePolicyAcknowledgement(
  config:
    | { mergePolicy?: unknown; mergePolicyAck?: unknown }
    | null
    | undefined,
  file: string = '.github/idd/config.json',
): MergePolicyAckFinding | null {
  if (config?.mergePolicy !== 'fully_autonomous_merge') {
    return null;
  }
  if (config.mergePolicyAck === 'fully_autonomous_merge') {
    return null;
  }
  return {
    level: 'warning',
    message:
      'mergePolicy is "fully_autonomous_merge", an explicit opt-in against ' +
      'the distributed "human_merge" default -- confirm this choice by ' +
      `setting mergePolicyAck: "fully_autonomous_merge" in ${file} to ` +
      'silence this reminder.',
  };
}

/**
 * Checks the resolved live-config candidate ({@link resolveLiveConfigDocument},
 * the same first-present-wins walk every other scalar policy reader in
 * this file shares, idd-skill#2028) for the mergePolicy acknowledgement
 * finding above. Never errors: an unreadable or malformed config is
 * already surfaced by {@link checkLiveConfigSchema} /
 * {@link checkHelperRuntimeConfig}, so this silently skips instead of
 * double-reporting.
 */
export function checkMergePolicyAcknowledgement(
  root: string,
  report: DoctorReport,
) {
  const { config, file } = resolveLiveConfigDocument(root);
  if (config === null || file === null) {
    return;
  }
  const finding = classifyMergePolicyAcknowledgement(
    config as { mergePolicy?: unknown; mergePolicyAck?: unknown } | null,
    file,
  );
  if (finding) {
    report.warnings.push(finding.message);
  }
}

/** One package's installed-vs-lockfile version comparison input. */
export interface DependencyVersionDriftEntry {
  name: string;
  installed: string | null;
  resolved: string | null;
}

// The two packages implicated in the #1164 incident: a stale node_modules
// install silently masked a real `pnpm run typecheck` break on fresh
// installs, because the break only surfaced once `@types/node` was
// actually installed at its lockfile-resolved version. Kept as a single
// array literal so extending coverage to another package is a one-line
// change, not a redesign.
const DEPENDENCY_VERSION_DRIFT_PACKAGES = ['typescript', '@types/node'];

/**
 * Extract the resolved `version:` pinned for `packageName` under the root
 * `.` importer's `dependencies`/`devDependencies` maps in a `pnpm-lock.yaml`
 * text (lockfileVersion 9's nested `specifier:`/`version:` shape). Pure (no
 * I/O) so it can be unit-tested directly. Returns `null` when the
 * `importers:` section, the root `.` importer, or the named package's own
 * entry cannot be found — a miss here is a staleness signal, not a
 * required-file check, so the caller must skip silently rather than treat
 * `null` as an error. A version resolved with a trailing peer-dependency
 * annotation (e.g. `21.2.0(@types/node@26.1.0)`) is stripped down to the
 * bare version so it compares cleanly against an installed package's plain
 * `package.json` `version` field.
 */
export function parseLockfileImporterVersion(
  lockfileText: string,
  packageName: string,
): string | null {
  if (typeof lockfileText !== 'string' || lockfileText.length === 0) {
    return null;
  }
  const normalized = lockfileText.replace(/\r\n/g, '\n');
  const importersIndex = normalized.indexOf('\nimporters:');
  if (importersIndex === -1) {
    return null;
  }
  const rootMarker = '\n  .:\n';
  const rootIndex = normalized.indexOf(rootMarker, importersIndex);
  if (rootIndex === -1) {
    return null;
  }
  const blockStart = rootIndex + rootMarker.length;
  // The root importer's own block ends at the next line indented 2
  // columns or fewer: either a sibling importer entry (workspace repos)
  // or a top-level key such as `packages:`.
  const boundaryMatch = /\n {0,2}\S/.exec(normalized.slice(blockStart));
  const blockEnd = boundaryMatch
    ? blockStart + (boundaryMatch.index ?? 0)
    : normalized.length;
  const block = normalized.slice(blockStart, blockEnd);

  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryPattern = new RegExp(
    `\\n {6}'?${escaped}'?:\\n(?:.*\\n)*? {8}version: *([^\\n]+)`,
  );
  const match = entryPattern.exec(block);
  if (!match) {
    return null;
  }
  const bare = match[1]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split('(')[0]
    .trim();
  return bare.length > 0 ? bare : null;
}

/**
 * Compare each package's installed `node_modules` version against what
 * `pnpm-lock.yaml` resolves for it, and produce one warning string for
 * every entry where both sides are known and differ. Pure (no I/O) so it
 * can be unit-tested directly. An entry with either side unknown (package
 * not installed, or not found in the lockfile) is a staleness signal only
 * — skipped without a warning, per this check's acceptance criteria.
 */
export function evaluateDependencyVersionDrift(
  entries: DependencyVersionDriftEntry[],
): string[] {
  const warnings: string[] = [];
  for (const { name, installed, resolved } of entries) {
    if (!installed || !resolved || installed === resolved) {
      continue;
    }
    warnings.push(
      `dependency version drift: node_modules/${name} is installed at ${installed}, but pnpm-lock.yaml resolves ${resolved}. Run pnpm install to sync node_modules with the lockfile.`,
    );
  }
  return warnings;
}

function readInstalledPackageVersion(
  root: string,
  name: string,
): string | null {
  const packageJsonPath = join(root, 'node_modules', name, 'package.json');
  if (!exists(packageJsonPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Warn (never fail) when the installed `node_modules/typescript` or
 * `node_modules/@types/node` version drifts from what `pnpm-lock.yaml`
 * resolves for this project's own root dependency. This is the local
 * diagnostic half of the #1198 fix: it surfaces a stale local install
 * *before* an agent chases a phantom typecheck failure caused by it — see
 * the #1164 incident, where a stale `@types/node` install masked a real
 * break for fresh installs. Skips silently (no warning, no error) when
 * `pnpm-lock.yaml`, `node_modules`, or a package's matching lockfile entry
 * is absent; this is a staleness signal, not a required-file check.
 */
export function checkDependencyVersionDrift(
  root: string,
  report: DoctorReport,
) {
  let lockfileText: string;
  try {
    lockfileText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return;
  }

  const entries: DependencyVersionDriftEntry[] =
    DEPENDENCY_VERSION_DRIFT_PACKAGES.map((name) => ({
      name,
      installed: readInstalledPackageVersion(root, name),
      resolved: parseLockfileImporterVersion(lockfileText, name),
    }));
  for (const warning of evaluateDependencyVersionDrift(entries)) {
    report.warnings.push(warning);
  }
}

function checkAgentEntryFiles(root: string, report: DoctorReport) {
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      report.warnings.push(
        `${file} is missing (allowed only if operator opted out)`,
      );
      continue;
    }
    const text = readFileSync(absolutePath, 'utf8');
    if (!text.includes('docs/idd-workflow.md')) {
      report.errors.push(
        `${file} exists but does not reference docs/idd-workflow.md`,
      );
      continue;
    }
    report.passes.push(`${file} references docs/idd-workflow.md`);
  }
}

function checkTemplateVersionSignal(root: string, report: DoctorReport) {
  const candidates = [
    '.github/idd/config.json',
    'idd-policy.json',
    'docs/idd-policy.md',
    'README.md',
  ];
  for (const file of candidates) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      continue;
    }
    const text = readFileSync(absolutePath, 'utf8');
    if (!/\biddVersion\b/i.test(text) && !/template version/i.test(text)) {
      continue;
    }
    report.passes.push(`template version signal found in ${file}`);
    return;
  }
  report.warnings.push(
    'template version signal not found (iddVersion/template version)',
  );
}

export function readWorktreeGuardEnabled(root: string): boolean {
  const { config } = resolveLiveConfigDocument(root);
  return (
    (config as { worktreeGuard?: { enabled?: unknown } } | null)?.worktreeGuard
      ?.enabled === true
  );
}

/**
 * Read `worktreeGuard.branchPatterns` from the repo config, falling back
 * to the default implementation-branch globs when the key is absent,
 * empty, or malformed. Matches the core.hooksPath hook so idd-doctor and
 * the hook agree on which branches the guard covers.
 */
export function readWorktreeGuardBranchPatterns(root: string): string[] {
  const { config } = resolveLiveConfigDocument(root);
  const patterns = (
    config as { worktreeGuard?: { branchPatterns?: unknown } } | null
  )?.worktreeGuard?.branchPatterns;
  if (
    Array.isArray(patterns) &&
    patterns.length > 0 &&
    patterns.every((p) => typeof p === 'string' && p.trim().length > 0)
  ) {
    // Return trimmed patterns: a configured entry with surrounding
    // whitespace (e.g. `"issue/* "`) otherwise passes validation but
    // never matches a real branch, silently covering nothing. The
    // validation above stays fail-closed — any empty/whitespace-only or
    // non-string entry invalidates the whole list and falls back to the
    // defaults — so every surviving entry is non-empty after trim.
    return (patterns as string[]).map((pattern) => pattern.trim());
  }
  return DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS;
}

/**
 * Decide which worktree-hardening signals are missing from the consuming
 * repository's imported files. Pure (no I/O): each argument is the file's
 * text, or `null`/`undefined` when the file is absent (absent files are
 * skipped, not reported, so this never double-reports a missing required
 * file). Returns a list of human-readable missing-signal labels.
 */
export function findMissingWorktreeHardening({
  work,
  core,
  doctor,
}: {
  work?: string | null;
  core?: string | null;
  doctor?: string | null;
} = {}): string[] {
  const missing: string[] = [];
  if (typeof work === 'string') {
    if (!/^###\s+Anti-patterns\b/m.test(work)) {
      missing.push('idd-work B1 Anti-patterns section');
    }
    if (!/^###\s+B1 self-check\b/m.test(work)) {
      missing.push('idd-work B1 self-check section');
    }
  }
  if (typeof core === 'string') {
    if (!/cwd-vs-claim/.test(core)) {
      missing.push('overview-core cwd-vs-claim gate');
    } else if (
      !/\(local commit,/.test(core) &&
      !/before any local commit\b/.test(core)
    ) {
      // Scope the local-commit signal to the gate's own mutation
      // enumeration (the opening "(local commit, ..." list and the
      // closing "before any local commit, ..." sentence) so an unrelated
      // "local commit" mention elsewhere in the file cannot mask a gate
      // that still omits commit coverage.
      missing.push('overview-core cwd-vs-claim local-commit coverage');
    }
  }
  // Only meaningful when idd-doctor is vendored into the repo at all.
  if (typeof doctor === 'string' && !/checkPrimaryWorktreeHead/.test(doctor)) {
    missing.push('idd-doctor checkPrimaryWorktreeHead detector');
  }
  return missing;
}

function checkWorktreeHardeningPresence(root: string, report: DoctorReport) {
  const read = (relativePath: string) => {
    try {
      return readFileSync(join(root, relativePath), 'utf8');
    } catch {
      return null;
    }
  };
  const missing = findMissingWorktreeHardening({
    work: read('.github/instructions/idd-work.instructions.md'),
    core: read('.github/instructions/idd-overview-core.instructions.md'),
    doctor: read('scripts/idd-doctor.mjs'),
  });
  if (missing.length === 0) {
    return;
  }
  report.warnings.push(
    `stale import — missing worktree-hardening: ${missing.join('; ')}. ` +
      'Re-sync the IDD template to adopt the B1 worktree guard; see B1 in ' +
      '.github/instructions/idd-work.instructions.md.',
  );
}

function checkPrimaryWorktreeHead(
  root: string,
  report: DoctorReport,
  options: { enforce?: boolean } = {},
) {
  const listResult = runCommand(
    'git',
    ['worktree', 'list', '--porcelain'],
    root,
  );
  if (!listResult.ok) {
    return;
  }

  const primaryPath = parsePrimaryWorktreePath(listResult.stdout);
  if (!primaryPath) {
    return;
  }

  const headResult = runCommand(
    'git',
    ['-C', primaryPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    root,
  );
  if (!headResult.ok) {
    return;
  }

  const branch = headResult.stdout.trim();
  const classification = classifyPrimaryHead(
    branch,
    readWorktreeGuardBranchPatterns(root),
  );
  const finding = classifyWorktreeHeadFinding(
    classification,
    branch,
    primaryPath,
    options.enforce === true,
  );
  if (!finding) {
    return;
  }
  if (finding.level === 'error') {
    report.errors.push(finding.message);
  } else {
    report.warnings.push(finding.message);
  }
}

/**
 * Decide whether a primary-worktree HEAD classification is a finding and,
 * if so, at what level. Pure (no I/O) so it can be unit-tested directly.
 *
 * `enforce` is true when the worktree guard is enabled or `--strict` was
 * passed; it promotes the finding from a warning to a blocking error.
 */
export function classifyWorktreeHeadFinding(
  classification: PrimaryHeadClassification | null | undefined,
  branch: string,
  primaryPath: string,
  enforce: boolean,
): WorktreeHeadFinding | null {
  if (!classification?.isB1Violation) {
    return null;
  }
  const kindLabel =
    classification.kind === 'issue'
      ? 'an issue branch'
      : classification.kind === 'roadmap-audit'
        ? 'a roadmap-audit branch'
        : 'an implementation branch';
  const severity = enforce
    ? 'B1 violation: this branch must live in a sibling worktree, not the primary worktree (worktree guard enforced)'
    : 'likely a past B1 violation';
  return {
    level: enforce ? 'error' : 'warning',
    message: `primary worktree HEAD is on ${kindLabel} (${branch}) at ${primaryPath} — ${severity}. See B1 in .github/instructions/idd-work.instructions.md.`,
  };
}

/** Signals consumed by `classifyWorktreeGuardActivation` (all pre-resolved). */
export interface WorktreeGuardActivationInput {
  /** `worktreeGuard.enabled === true` in `.github/idd/config.json`. */
  guardEnabled: boolean;
  /** HEAD is detached (`git rev-parse --abbrev-ref HEAD` === `HEAD`). */
  headDetached: boolean;
  /** Resolved `core.hooksPath` value, or `null`/empty when unset. */
  hooksPath: string | null;
  /** The resolved hooks path actually wires the B1 guard. */
  guardWired: boolean;
  /**
   * Names of the shipped `.githooks/` files found to contain CRLF line
   * endings (any of `_idd-worktree-guard.sh`, `pre-commit`, `pre-push`),
   * in file order; empty when none do. Checked independently of
   * `guardWired`, since `hookWiresWorktreeGuard`'s regex still matches a
   * CRLF-converted sourcing line (idd-skill#2060) -- a non-empty list
   * always produces a warning even when `guardWired` is (incorrectly)
   * `true`.
   */
  crlfHookNames: string[];
}

/**
 * True when a git hook file body wires the B1 worktree guard, i.e. a `.`/
 * `source` command loads the shared `_idd-worktree-guard.sh` helper. Matching
 * the sourcing line (not a bare mention) means a hook that only names the
 * helper in a comment — e.g. a leftover doc line after the source was removed —
 * correctly reads as inert rather than wired. The trailing `(?![.\w-])`
 * boundary rejects a disabled/backed-up filename that merely starts with
 * `_idd-worktree-guard.sh` (e.g. `_idd-worktree-guard.sh.disabled`,
 * `_idd-worktree-guard.sh.bak`) — those are not the active guard file,
 * regardless of the sourcing syntax around them (idd-skill#2476) — while
 * still matching the CRLF-converted case (a `\r` right after `.sh` is not
 * excluded, so `hookHasCrlfLineEndings` below stays the sole signal for
 * that failure mode, unchanged from before this fix). Pure (no I/O) so
 * the wired/unwired classification can be unit-tested directly. A
 * non-string (absent/unreadable hook) is treated as not wiring the guard.
 */
export function hookWiresWorktreeGuard(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    /^[ \t]*(?:\.|source)[ \t]+[^\n]*_idd-worktree-guard\.sh(?![.\w-])/m.test(
      content,
    )
  );
}

/**
 * True when hook file content contains a Windows-style CRLF line ending. A
 * working tree checked out under Git for Windows' default
 * `core.autocrlf=true`, with no adopter-side `.gitattributes` override,
 * converts these shipped POSIX shell hook files to CRLF -- the trailing `\r`
 * then becomes part of the sourced path (e.g.
 * `. "$(dirname "$0")/_idd-worktree-guard.sh"\r`), which every POSIX shell
 * rejects as "No such file", hard-blocking every commit/push even though
 * `hookWiresWorktreeGuard`'s own regex still matches the text -- the `\r`
 * sits after, not inside, the matched filename (idd-skill#2060). Pure (no
 * I/O) so it can be unit-tested directly. A non-string (absent/unreadable
 * hook) is treated as CRLF-free.
 */
export function hookHasCrlfLineEndings(content: unknown): boolean {
  return typeof content === 'string' && content.includes('\r\n');
}

/**
 * True when a git hook file body chains execution to the corresponding
 * shipped `.githooks/<hookName>` script via one of the two documented
 * exec/invocation forms from ONBOARDING.md's "Coexisting with an existing
 * hook manager" recipe:
 *
 * ```sh
 * exec "$(git rev-parse --show-toplevel)/.githooks/<hookName>" "$@"
 * "$(git rev-parse --show-toplevel)/.githooks/<hookName>" "$@" || exit $?
 * ```
 *
 * Line-anchored and comment-immune the same way `hookWiresWorktreeGuard`
 * is: a `#`-prefixed line (e.g. a leftover "was:" comment) never matches.
 * The quoted path must begin the executed command token (immediately after
 * an optional `exec`, with nothing else in between) — an unrelated leading
 * command such as `echo "$(...)/.githooks/pre-commit" "$@"` never matches,
 * since that would only *mention* the path rather than invoke it. The path
 * must also use the documented `$(git rev-parse --show-toplevel)/` prefix
 * exactly, not merely end in `.githooks/<hookName>` — an unrelated target
 * such as `"$HOME/.githooks/<hookName>"` never matches, since that string
 * has no relationship to this repository's own shipped script regardless
 * of what happens to live at the fixed `.githooks/<hookName>` path this
 * function's caller separately verifies. The non-`exec` form additionally
 * requires the documented `|| exit $?` failure-propagation suffix
 * immediately afterward (only whitespace may separate them) — without
 * `exec`, a guard failure that isn't explicitly propagated can be silently
 * swallowed by whatever the hook manager's own dispatcher runs next, so an
 * invocation lacking that suffix is not accepted as reliable chaining
 * evidence. Both forms must also end the line (only trailing whitespace and
 * an optional `#` comment may follow) — a trailing shell operator such as
 * `| cat` or a backgrounding `&` can decouple the line's own exit status
 * from the guard's, so a line carrying either form of the two documented
 * commands plus anything else is not accepted either. The trailing comment
 * itself must be preceded by whitespace, matching real shell tokenizing: an
 * adjacent `#` right after the closing quote (e.g. `"$@"#| cat`) is not a
 * comment delimiter to the shell at all — it stays part of the same word —
 * so accepting it here would let disguised trailing content back in through
 * the very escape hatch meant only for a genuine, separated comment. A
 * candidate line must also not be a backslash-continuation of the
 * preceding physical line (a line ending in `\` before it) — the shell
 * joins such a pair into one logical command, so e.g. a `printf '%s' \`
 * line immediately followed by the exec form on the next physical line
 * never actually invokes it; it only passes those words as arguments to
 * the earlier command.
 *
 * Scope boundary: this is a bounded lexical heuristic for the two
 * documented forms appearing as an ordinary standalone physical line, not
 * a shell parser. It does not evaluate quoting edge cases, variable
 * expansion, here-docs, `eval`, subshell wrapping, or any other
 * adversarial or unusual shell construction that could still reach one of
 * the two forms at runtime while lexically evading this check (or vice
 * versa). This is a warning-level misconfiguration diagnostic, not a
 * security boundary — an operator who wants to fool it can simply not
 * enable the guard — so further hardening against constructions beyond
 * the documented recipe is out of scope absent an observed incident.
 * Pure (no I/O) so it can be unit-tested directly. A non-string
 * (absent/unreadable hook) is treated as not chaining.
 */
export function hookChainsToGithooksScript(
  content: unknown,
  hookName: string,
): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  const escaped = escapeRegex(hookName);
  const quotedPath = `"\\$\\(git rev-parse --show-toplevel\\)/\\.githooks/${escaped}"`;
  const lineEnd = '(?:[ \\t]*$|[ \\t]+#.*$)';
  const execForm = `exec[ \\t]+${quotedPath}[ \\t]+"\\$@"${lineEnd}`;
  const nonExecForm = `${quotedPath}[ \\t]+"\\$@"[ \\t]*\\|\\|[ \\t]*exit[ \\t]+\\$\\?${lineEnd}`;
  const notContinuedLine = '(?<!\\\\\\n)';
  return new RegExp(
    `${notContinuedLine}^[ \\t]*(?:${execForm}|${nonExecForm})`,
    'm',
  ).test(content);
}

/**
 * Decide whether the worktree guard is enabled-but-inert in the current
 * environment and, if so, produce a warning finding. Pure (no I/O) so it can
 * be unit-tested directly.
 *
 * The finding is intentionally a **warning**, never a blocking error: the
 * idd-doctor CI health gate checks out a detached HEAD (which never wires the
 * local hook) and must stay green. `headDetached` short-circuits that CI case,
 * and a warning-level finding keeps the exit code zero even if it ever fires.
 */
export function classifyWorktreeGuardActivation({
  guardEnabled,
  headDetached,
  hooksPath,
  guardWired,
  crlfHookNames,
}: WorktreeGuardActivationInput): WorktreeHeadFinding | null {
  // Only runs when the guard is opted in.
  if (!guardEnabled) {
    return null;
  }
  // CI-safe: a detached HEAD (CI checkout of a raw SHA) never wires the hook
  // and is not a real B1 environment, so stay silent — matching how
  // `classifyPrimaryHead('HEAD')` reports no violation.
  if (headDetached) {
    return null;
  }
  // Checked ahead of `guardWired`, and regardless of its value: a
  // CRLF-converted sourcing line still satisfies `hookWiresWorktreeGuard`'s
  // regex, so `guardWired` alone cannot be trusted to catch this case.
  if (crlfHookNames.length > 0) {
    const names = crlfHookNames.join(', ');
    const plural = crlfHookNames.length === 1 ? 's' : '';
    return {
      level: 'warning',
      message:
        `worktreeGuard.enabled is true but ${names} contain${plural} CRLF ` +
        `line endings; the trailing \\r breaks the "." sourcing path (e.g. ` +
        `". …: cannot open …/_idd-worktree-guard.sh: No such file") even ` +
        `though the wiring check still matches the text. A CRLF-broken ` +
        `hook HARD-BLOCKS any commit or push that invokes it -- via ` +
        `core.hooksPath = .githooks directly, or a documented chain from ` +
        `elsewhere -- not merely disables enforcement, so this must be ` +
        `fixed before (or as part of) wiring core.hooksPath. Likely ` +
        `cause: Git for Windows' default core.autocrlf=true with no ` +
        `adopter-side .gitattributes override. Add an explicit LF rule ` +
        `covering all three shipped .githooks/ files (for example ` +
        `".githooks/* text eol=lf"); see ONBOARDING.md's worktree-guard ` +
        `activation section`,
    };
  }
  // Correctly wired → nothing to report.
  if (guardWired) {
    return null;
  }
  const shown =
    typeof hooksPath === 'string' && hooksPath.trim().length > 0
      ? hooksPath.trim()
      : '(unset)';
  return {
    level: 'warning',
    message:
      `worktreeGuard.enabled is true but the commit/push guard is not active ` +
      `in this environment (core.hooksPath = ${shown}); B1 primary-worktree ` +
      `commits will NOT be blocked here. Wire it with: ` +
      `git config core.hooksPath .githooks && chmod +x ` +
      `.githooks/pre-commit .githooks/pre-push — or, if an existing hook ` +
      `manager already owns core.hooksPath here, chain each hook to the ` +
      `corresponding .githooks/* script instead of repointing directly; see ` +
      `ONBOARDING.md's "Coexisting with an existing hook manager" section`,
  };
}

/**
 * Read the `pre-commit` and `pre-push` hooks at the resolved `core.hooksPath`
 * and report whether both wire the B1 guard, directly or through a
 * documented one-level chain. A relative hooks path resolves against the
 * repository root; an absolute one is used as-is.
 *
 * A hook counts as wired when the file **actually present and executable
 * at `hooksPath`** — the one git itself would invoke, and only when git
 * would actually invoke it: git silently skips a hook file that exists but
 * lacks the executable bit — either:
 *  - sources `_idd-worktree-guard.sh` directly (the base, non-chained
 *    activation path), or
 *  - itself chains to the corresponding `.githooks/<hook>` script via a
 *    documented exec/invocation line, or — **only when `hooksPath` resolves
 *    to exactly `.husky/_`**, the precise shape Husky v9's own
 *    `core.hooksPath = .husky/_` plus the committed `.husky/<hook>` file
 *    takes (see ONBOARDING.md's "Coexisting with an existing hook
 *    manager") — hands off to the sibling file in `hooksPath`'s **parent**
 *    directory that does, with that `.githooks/<hook>` script itself
 *    confirmed to both genuinely source the guard and be executable
 *    (defense-in-depth against a chain line pointing at a missing,
 *    non-executable, or tampered target).
 *
 * The parent-directory fallback checks the **full path** relative to the
 * repository root, not merely `hooksPath`'s last path segment: matching on
 * a bare trailing `_` would also fire for an unrelated directory that
 * happens to end in `_` (e.g. `.other-hooks/_`), and matching on an
 * arbitrary directory at all — without the executable-bit check above —
 * would let an unrelated file that merely happens to sit in some other
 * hooksPath's parent directory, and happens to contain a chain-shaped
 * line, supply chain evidence for two files with no real dispatch
 * relationship (Copilot + Codex review, PR #1969).
 *
 * This stays bounded to the documented recipe's two concrete file
 * locations — it does not trace an arbitrary hook manager's own dispatch
 * machinery.
 */
export function worktreeGuardWiredAt(root: string, hooksPath: string): boolean {
  const directory = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
  const parentDirectory = join(directory, '..');
  const isHuskyUnderscoreSplit =
    relative(root, directory).split('\\').join('/') === '.husky/_';
  const githooksDirectory = join(root, '.githooks');
  const read = (dir: string, name: string): string | null => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const isExecutable = (dir: string, name: string): boolean => {
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const wired = (name: string): boolean => {
    const atHooksPath = read(directory, name);
    // git silently skips a hook file that exists but isn't executable, so
    // neither wiring form below is reachable without this bit set.
    if (atHooksPath === null || !isExecutable(directory, name)) {
      return false;
    }
    if (hookWiresWorktreeGuard(atHooksPath)) {
      return true;
    }
    const chains =
      hookChainsToGithooksScript(atHooksPath, name) ||
      (isHuskyUnderscoreSplit &&
        hookChainsToGithooksScript(read(parentDirectory, name), name));
    return (
      chains &&
      hookWiresWorktreeGuard(read(githooksDirectory, name)) &&
      isExecutable(githooksDirectory, name)
    );
  };
  return wired('pre-commit') && wired('pre-push');
}

// The three shipped hook files a native-Windows checkout under
// `core.autocrlf=true` can silently convert to CRLF, hard-blocking the guard
// (idd-skill#2060). Always read from `.githooks/` regardless of the resolved
// `core.hooksPath`: that is where the shipped files themselves live, and
// where an adopter's own `.gitattributes` LF rule must apply, whether or not
// `core.hooksPath` points directly at them or chains through another
// directory (e.g. Husky's `.husky/_`).
const WORKTREE_GUARD_HOOK_FILE_NAMES = [
  '_idd-worktree-guard.sh',
  'pre-commit',
  'pre-push',
];

/**
 * Read the three shipped `.githooks/` files and report which ones (if any)
 * contain CRLF line endings, in `WORKTREE_GUARD_HOOK_FILE_NAMES` order. A
 * missing or unreadable file is treated as CRLF-free (nothing to report;
 * `worktreeGuardWiredAt`'s own executable/presence checks already cover a
 * genuinely missing hook).
 */
export function detectWorktreeGuardCrlfHookNames(root: string): string[] {
  const githooksDirectory = join(root, '.githooks');
  const found: string[] = [];
  for (const name of WORKTREE_GUARD_HOOK_FILE_NAMES) {
    let content: string | null;
    try {
      content = readFileSync(join(githooksDirectory, name), 'utf8');
    } catch {
      content = null;
    }
    if (hookHasCrlfLineEndings(content)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Warn when `worktreeGuard.enabled` is true but the commit/push guard is not
 * actually wired in this environment (`core.hooksPath` unset or pointing at a
 * directory that does not source the guard). A fresh coding-agent / ephemeral
 * checkout never inherits the local `core.hooksPath`, so `enabled` alone can be
 * silently unenforced. Warning-only and inert on a detached HEAD so the
 * idd-doctor CI health gate stays green.
 */
function checkWorktreeGuardActive(root: string, report: DoctorReport) {
  if (!readWorktreeGuardEnabled(root)) {
    return;
  }
  // Resolve HEAD; skip on a detached HEAD (CI checks out a raw SHA) or when
  // git is unavailable (fail-safe: no finding).
  const headResult = runCommand(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    root,
  );
  if (!headResult.ok) {
    return;
  }
  // A detached HEAD (CI checks out a raw SHA) never wires the local hook and is
  // not a real B1 environment — return before touching core.hooksPath so the
  // idd-doctor CI health gate stays green. classifyWorktreeGuardActivation also
  // guards this case so it can be unit-tested directly.
  if (headResult.stdout.trim() === 'HEAD') {
    return;
  }
  // Resolve the active hooks path. An unset core.hooksPath makes git exit
  // non-zero, which reads as unset here.
  const hooksResult = runCommand(
    'git',
    ['config', '--get', 'core.hooksPath'],
    root,
  );
  const hooksPath = hooksResult.ok ? hooksResult.stdout.trim() : '';
  const guardWired =
    hooksPath.length > 0 && worktreeGuardWiredAt(root, hooksPath);
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: hooksPath.length > 0 ? hooksPath : null,
    guardWired,
    crlfHookNames: detectWorktreeGuardCrlfHookNames(root),
  });
  if (finding) {
    report.warnings.push(finding.message);
  }
}

export function computeWindowStartIso(
  now: unknown,
  windowDays: unknown,
): string | null {
  const ms = Number(windowDays) * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const candidate = Number(now) - ms;
  if (!Number.isFinite(candidate)) {
    return null;
  }
  const date = new Date(candidate);
  // JavaScript `Date` accepts the full IEEE 754 range, but `toISOString`
  // throws RangeError for any `Date` outside ±100,000,000 days of the
  // epoch (≈ year ±271,821). Detect that here so a too-large
  // `--cleanup-backlog-window-days` value never crashes the caller.
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return date.toISOString();
  } catch {
    return null;
  }
}

export function classifyBacklog(
  missingPrNumbers: unknown,
  warnThreshold: unknown,
): CleanupBacklogVerdict {
  const count = Array.isArray(missingPrNumbers) ? missingPrNumbers.length : 0;
  const thresholdNumber = Number(warnThreshold);
  const safeThreshold =
    Number.isFinite(thresholdNumber) && thresholdNumber >= 0
      ? thresholdNumber
      : 0;
  return {
    count,
    warn: count > safeThreshold,
    examples: Array.isArray(missingPrNumbers)
      ? (missingPrNumbers.slice(0, 5) as number[])
      : [],
  };
}

const CUTOFF_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a `--cleanup-backlog-bootstrap-cutoff` value (or a `gh`-supplied
 * `mergedAt`) to a UTC millisecond timestamp, or `null` when unparsable
 * (idd-skill#2226, CodeRabbit review on PR #2386). Deliberately stricter
 * than plain `Date.parse`, which both silently normalizes calendar
 * overflow (`Date.parse('2026-02-30')` resolves to March 2 instead of
 * rejecting the date) and resolves a timestamp with a time-of-day but no
 * explicit UTC offset in the HOST's local time zone -- so the identically
 * configured cutoff would classify different PRs depending on which
 * machine or CI runner evaluates it (confirmed empirically across `TZ`
 * values before this fix).
 *
 * Two forms are accepted, both unambiguous everywhere:
 * - a bare calendar date (`YYYY-MM-DD`), anchored to UTC midnight;
 * - a full ISO8601 UTC timestamp recognized by `isValidIsoTimestamp`
 *   (marker-helpers.mts) -- this repository's own existing canonical
 *   timestamp contract, Z-suffixed only, no other offset forms.
 *
 * The date-only branch round-trips through `Date` -> `toISOString()` and
 * compares the calendar-date portion against the input, which rejects
 * overflow the same way `isValidIsoTimestamp` already does for its own
 * shape.
 */
export function parseStrictCutoffToUtcMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (CUTOFF_DATE_ONLY_PATTERN.test(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(ms) &&
      new Date(ms).toISOString().slice(0, 10) === value
      ? ms
      : null;
  }
  return isValidIsoTimestamp(value) ? Date.parse(value) : null;
}

/**
 * Numbers among `missingPrNumbers` whose merge predates `cutoffIso`
 * (idd-skill#2226) -- presentation-only: never changes which PRs count as
 * missing evidence, only which of them the backlog warning labels
 * "bootstrap-era" instead of a genuine claim-marker-missing gap. A PR
 * absent from `mergedAtByNumber` (its `mergedAt` was missing or malformed
 * at fetch time), whose `mergedAt` fails {@link parseStrictCutoffToUtcMs},
 * or an unparsable `cutoffIso` never counts as bootstrap-era -- fails
 * closed to "flag every PR the same as before this feature existed"
 * rather than guessing. Pure so it can be unit-tested without mocking
 * `gh`.
 */
export function classifyBootstrapEraPrNumbers(
  missingPrNumbers: readonly number[],
  mergedAtByNumber: ReadonlyMap<number, string>,
  cutoffIso: string | undefined,
): Set<number> {
  const cutoffMs = parseStrictCutoffToUtcMs(cutoffIso);
  if (cutoffMs === null) {
    return new Set();
  }
  const bootstrapEra = new Set<number>();
  for (const number of missingPrNumbers) {
    const mergedAtMs = parseStrictCutoffToUtcMs(mergedAtByNumber.get(number));
    if (mergedAtMs !== null && mergedAtMs < cutoffMs) {
      bootstrapEra.add(number);
    }
  }
  return bootstrapEra;
}

/**
 * Selects up to `limit` example PR numbers for display, guaranteeing at
 * least one bootstrap-era-tagged example is visible whenever `bootstrapEra`
 * is non-empty (idd-skill#2226 review, Copilot): a plain `slice(0, limit)`
 * could silently omit every bootstrap-era number when none of the first
 * `limit` entries in `missingPrNumbers` happen to be tagged, which would
 * make the warning message's own bootstrap-era count clause look
 * inconsistent with its own `Examples: ...` list (a non-zero count, zero
 * `(bootstrap-era)` tags shown). Preserves the plain, order-preserving
 * slice when `bootstrapEra` is empty or already represented in it --
 * byte-identical to pre-#2226 behavior in the common case where no cutoff
 * is configured at all.
 */
export function selectBacklogExamples(
  missingPrNumbers: readonly number[],
  bootstrapEra: ReadonlySet<number>,
  limit = 5,
): number[] {
  const natural = missingPrNumbers.slice(0, limit);
  if (bootstrapEra.size === 0 || natural.some((n) => bootstrapEra.has(n))) {
    return natural;
  }
  const firstBootstrapEra = missingPrNumbers.find((n) => bootstrapEra.has(n));
  if (firstBootstrapEra === undefined || natural.length === 0) {
    return natural;
  }
  return [...natural.slice(0, natural.length - 1), firstBootstrapEra];
}

/**
 * Preamble line announcing how many merged PRs the backlog scan will visit.
 * Pure so tests can assert the exact wording without running the network scan.
 */
export function formatCleanupBacklogScanPreamble(total: number): string {
  const plural = total === 1 ? '' : 's';
  return `post-merge cleanup backlog: scanning ${total} merged PR${plural} for F4 cleanup evidence…`;
}

/**
 * Per-PR progress line for the backlog scan. Pure for the same reason as the
 * preamble above.
 */
export function formatCleanupBacklogScanProgress(
  scanned: number,
  total: number,
  prNumber: number,
): string {
  return `  [${scanned}/${total}] merged PR #${prNumber}`;
}

/**
 * Emit a backlog-scan progress line. It writes to **stderr** by default so the
 * `--json` report on stdout stays machine-parseable — a slow network-bound scan
 * is then distinguishable from a hang without polluting stdout. The `stream`
 * parameter exists only so tests can capture the output and assert it never
 * reaches stdout.
 */
export function emitCleanupBacklogProgress(
  line: string,
  stream: { write: (chunk: string) => unknown } = process.stderr,
): void {
  stream.write(`${line}\n`);
}

// `helper-runtime-manifest.mts`'s HELPER_COMMANDS id for `audit-pr-cleanup`
// -- the helper the cleanup-backlog remediation hint below points at.
const CLEANUP_BACKLOG_HELPER_ID = 'audit-pr-cleanup';
const CLEANUP_BACKLOG_REMEDIATION_ARGS = '--pr <N> --apply --skip-claim-check';
const CLEANUP_BACKLOG_DOCS_POINTER = 'docs/idd-comment-minimization.md';

/**
 * Build the post-merge-cleanup-backlog warning's remediation clause for one
 * resolved `helperRuntime.profile`, resolving the `audit-pr-cleanup`
 * invocation through `resolveHelperCommandForProfile` instead of
 * hard-coding the `vendored-node` form (idd-skill#1718) -- a
 * `vendored-node`-only command fails immediately under any other profile
 * (for example `ephemeral-npx`, which has no `scripts/` directory to
 * invoke). Pure (no I/O) so it can be unit-tested for every profile
 * without mocking `gh` or the filesystem.
 *
 * The optional `packageSpec` (idd-skill#1731) is the resolved
 * `helperRuntime.packageSpec`; an empty string (the default when unset)
 * lets `resolveHelperCommandForProfile` fall back to the mutable default
 * archive URL under `ephemeral-npx`, unchanged from before this pin
 * existed.
 *
 * The `docs/idd-comment-minimization.md` pointer stays in every profile,
 * including `instructions-only`, which has no runnable command at all --
 * the pointer alone is then the whole remediation clause.
 */
export function formatCleanupBacklogRemediation(
  profile: string,
  packageSpec = '',
): string {
  const docsClause = `see ${CLEANUP_BACKLOG_DOCS_POINTER}`;
  const command = resolveHelperCommandForProfile({
    helperId: CLEANUP_BACKLOG_HELPER_ID,
    profile,
    packageSpec,
  });
  if (!command) {
    return `Remediation: ${docsClause}.`;
  }
  return `Remediation: ${docsClause} or run \`${command} ${CLEANUP_BACKLOG_REMEDIATION_ARGS}\`.`;
}

/**
 * Trusted authors for `<!-- idd-cleanup-evidence: ... -->` comments: the
 * repository's configured `trustedMarkerActors` (from the live IDD config,
 * canonical `.github/idd/config.json` first, falling back to the legacy
 * `idd-policy.json` when the canonical file is absent -- see
 * {@link resolveLiveConfigDocument}) plus `github-actions[bot]`, the
 * identity `post-merge-cleanup.yml` posts under via `GITHUB_TOKEN`. Any
 * commenter outside this set can pre-post the marker prefix on a public
 * repo, so an untrusted-author match must never count as genuine cleanup
 * evidence -- the same trust-scoping every other IDD operational marker
 * already applies. Fails closed to `github-actions[bot]` alone (config
 * unreadable/malformed never widens trust).
 */
export function readCleanupEvidenceTrustedLogins(root: string): Set<string> {
  const { config } = resolveLiveConfigDocument(root);
  const trustedMarkerActors = (
    config as { trustedMarkerActors?: unknown } | null
  )?.trustedMarkerActors;
  const { actors } = resolveTrustedMarkerActors({
    config: { trustedMarkerActors },
  });
  return new Set([...actors, 'github-actions[bot]']);
}

/**
 * Filter a `gh pr list --json number,headRefName,mergedAt` result down to
 * entries whose head ref matches the IDD branch-naming convention -- the same
 * `worktreeGuard.branchPatterns` globs (`issue/*`, `roadmap-audit/*` by
 * default; see `readWorktreeGuardBranchPatterns`) that `classifyPrimaryHead`
 * already matches elsewhere in this file. A routine non-IDD merge (a
 * Dependabot dependency bump, for example) never created a branch the
 * post-merge cleanup backlog scan is responsible for, so it is dropped here
 * before the backlog count, evidence-fetch loop, or `Examples: ...` list
 * ever sees it (idd-skill#1829). Pure (no I/O) so it can be unit-tested
 * without mocking `gh`.
 *
 * The returned `mergedAt` field (#2226) is present only when the input
 * entry carries a non-empty string value -- an entry with no `mergedAt`
 * (or a malformed one) yields `{ number }` alone, so callers built before
 * this field existed (and their fixtures) see an unchanged shape.
 */
export function filterIddBranchMergedPrs(
  prs: unknown,
  patterns: string[] = DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
): { number: number; mergedAt?: string }[] {
  const matchers = patterns.map((pattern) => branchGlobToRegExp(pattern));
  const filtered: { number: number; mergedAt?: string }[] = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const number = (pr as { number?: unknown } | null)?.number;
    const headRefName = (pr as { headRefName?: unknown } | null)?.headRefName;
    if (
      !Number.isInteger(number) ||
      typeof headRefName !== 'string' ||
      !matchers.some((matcher) => matcher.test(headRefName))
    ) {
      continue;
    }
    const mergedAt = (pr as { mergedAt?: unknown } | null)?.mergedAt;
    const entry: { number: number; mergedAt?: string } = {
      number: number as number,
    };
    if (typeof mergedAt === 'string' && mergedAt.length > 0) {
      entry.mergedAt = mergedAt;
    }
    filtered.push(entry);
  }
  return filtered;
}

/**
 * Renders the backlog warning's `Examples: ...` clause, appending a
 * `(bootstrap-era)` tag to every listed PR number present in
 * `bootstrapEra` (idd-skill#2226) -- a presentation-only distinction, never
 * a change to which numbers are listed. Pure so it can be unit-tested
 * independently of the network scan.
 */
export function formatCleanupBacklogExamples(
  examples: readonly number[],
  bootstrapEra: ReadonlySet<number>,
): string {
  return examples
    .map((n) => (bootstrapEra.has(n) ? `#${n} (bootstrap-era)` : `#${n}`))
    .join(', ');
}

function checkPostMergeCleanupBacklog(
  root: string,
  options: {
    windowDays: number;
    warnThreshold: number;
    bootstrapCutoff?: string;
    requireGithub?: boolean;
  },
  report: DoctorReport,
) {
  const windowDays = options.windowDays;
  const warnThreshold = options.warnThreshold;
  const bootstrapCutoff = options.bootstrapCutoff;
  const requireGithub = options.requireGithub === true;

  // Soft GitHub-API failures (gh missing, no token, repo view fails,
  // pr list fails) are silent by default — same pattern as the other
  // doctor GitHub-readiness checks — and only surface as errors when
  // the operator passed --require-github. Per-PR evidence-fetch
  // failures are still always reported because they materially change
  // the backlog count.
  const recordGhFailure = (message: string) => {
    if (requireGithub) {
      report.errors.push(`post-merge cleanup backlog check: ${message}`);
    }
  };

  const repoView = runCommand(
    'gh',
    ['repo', 'view', '--json', 'owner,name'],
    root,
  );
  if (!repoView.ok) {
    recordGhFailure('gh repo view unavailable');
    return;
  }
  let parsed: { owner?: { login?: string }; name?: string };
  try {
    parsed = JSON.parse(repoView.stdout);
  } catch {
    recordGhFailure('gh repo view output is not valid JSON');
    return;
  }
  const owner = parsed.owner?.login;
  const repo = parsed.name;
  if (!owner || !repo) {
    recordGhFailure('gh repo view did not return owner/name');
    return;
  }

  const sinceIso = computeWindowStartIso(Date.now(), windowDays);
  if (!sinceIso) {
    report.warnings.push(
      `post-merge cleanup backlog check skipped: --cleanup-backlog-window-days value ${windowDays} produced an out-of-range Date and cannot be used as a search window. Re-run with a smaller positive value (default: 14).`,
    );
    return;
  }

  const search = runCommand(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--state',
      'merged',
      '--search',
      `merged:>=${sinceIso}`,
      '--json',
      'number,headRefName,mergedAt',
      '--limit',
      '1000',
    ],
    root,
  );
  if (!search.ok) {
    recordGhFailure(`merged-PR list query failed for ${owner}/${repo}`);
    return;
  }
  let mergedPrs: unknown;
  try {
    mergedPrs = JSON.parse(search.stdout);
  } catch {
    recordGhFailure(
      `merged-PR list query for ${owner}/${repo} returned invalid JSON`,
    );
    return;
  }
  if (!Array.isArray(mergedPrs) || mergedPrs.length === 0) {
    return;
  }

  // Scope the scan to IDD-branch merged PRs only (idd-skill#1829) -- a
  // routine non-IDD merge (Dependabot dependency bumps, for example) never
  // created a branch the F4 cleanup-evidence contract applies to, so it
  // must not count toward the backlog total or the `Examples: ...` list.
  // Hoisted into a named variable (idd-skill#1936) so the warning text
  // below can name the patterns actually in effect, not just apply them.
  const branchPatterns = readWorktreeGuardBranchPatterns(root);
  const iddMergedPrs = filterIddBranchMergedPrs(mergedPrs, branchPatterns);
  if (iddMergedPrs.length === 0) {
    return;
  }

  // Stream per-PR progress to stderr so a slow, serial, network-bound scan of a
  // large merge burst is distinguishable from a hang. Progress must stay on
  // stderr so the `--json` report on stdout is never polluted.
  emitCleanupBacklogProgress(
    formatCleanupBacklogScanPreamble(iddMergedPrs.length),
  );

  const trustedLogins = readCleanupEvidenceTrustedLogins(root);
  const mergedAtByNumber = new Map<number, string>();
  for (const pr of iddMergedPrs) {
    if (pr.mergedAt) {
      mergedAtByNumber.set(pr.number, pr.mergedAt);
    }
  }
  const missing: number[] = [];
  const evidenceFailures: number[] = [];
  let scanned = 0;
  for (const pr of iddMergedPrs) {
    const number = pr.number;
    scanned += 1;
    emitCleanupBacklogProgress(
      formatCleanupBacklogScanProgress(scanned, iddMergedPrs.length, number),
    );
    const evidence = runCommand(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/issues/${number}/comments`,
        '--jq',
        '.[] | select(.body | startswith("<!-- idd-cleanup-evidence:")) | [.id, .user.login] | @tsv',
      ],
      root,
    );
    if (!evidence.ok) {
      evidenceFailures.push(number);
      continue;
    }
    // Only a trusted-author match counts as genuine cleanup evidence (see
    // readCleanupEvidenceTrustedLogins) -- an untrusted commenter's
    // pre-posted marker-prefixed comment must not suppress this backlog
    // warning.
    const hasTrustedEvidence = String(evidence.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .some((line) => {
        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) {
          return false;
        }
        const login = line
          .slice(tabIndex + 1)
          .trim()
          .toLowerCase();
        return trustedLogins.has(login);
      });
    if (!hasTrustedEvidence) {
      missing.push(number);
    }
  }

  if (evidenceFailures.length > 0) {
    const evidenceMessage =
      `post-merge cleanup evidence query failed for ${evidenceFailures.length} merged PR(s) ` +
      `(examples: ${evidenceFailures
        .slice(0, 5)
        .map((n) => `#${n}`)
        .join(', ')}). ` +
      `Backlog count below may be undercounted.`;
    if (requireGithub) {
      report.errors.push(evidenceMessage);
    } else {
      report.warnings.push(evidenceMessage);
    }
  }

  const verdict = classifyBacklog(missing, warnThreshold);
  if (!verdict.warn) {
    return;
  }

  // idd-skill#2226: presentation-only -- `verdict.count`/`warn`/`examples`
  // above are computed from the unmodified `missing` list, so a configured
  // bootstrapCutoff never changes which PRs are flagged, only how the
  // `Examples: ...` clause labels the ones merged before it.
  const bootstrapEra = classifyBootstrapEraPrNumbers(
    missing,
    mergedAtByNumber,
    bootstrapCutoff,
  );
  // idd-skill#2226 review (Copilot): select from the full `missing` list,
  // not `verdict.examples` alone, so a non-zero bootstrapEraCountClause
  // below is never shown alongside an Examples: list with zero
  // (bootstrap-era) tags.
  const examplesText = formatCleanupBacklogExamples(
    selectBacklogExamples(missing, bootstrapEra),
    bootstrapEra,
  );
  const bootstrapEraCountClause =
    bootstrapEra.size > 0
      ? ` (${bootstrapEra.size} bootstrap-era, merged before ${bootstrapCutoff})`
      : '';
  const { profile, packageSpec } = resolveConfiguredHelperRuntime(root);
  const remediation = formatCleanupBacklogRemediation(profile, packageSpec);
  // State the scoping explicitly (idd-skill#1936) so an operator reading a
  // low count does not misread it as "no merged PRs in the window" --
  // non-IDD merges (Dependabot bumps, etc.) are already excluded above and
  // never reach this count.
  const patternsText = branchPatterns.join(', ');
  report.warnings.push(
    `post-merge cleanup backlog: ${verdict.count} merged PRs in the last ${windowDays} days lack F4 cleanup evidence${bootstrapEraCountClause} (warn threshold: ${warnThreshold}; scoped to IDD branch patterns: ${patternsText}). Examples: ${examplesText}. ${remediation}`,
  );
}

// Default drift thresholds (idd-skill#1269): warn when the checked-out HEAD
// (typically `main` -- see the HEAD-vs-main note below) is more than 100
// commits OR more than 45 days past the latest reachable tag, whichever
// fires first (OR logic -- either alone is enough to warn). "Days past the
// tag" is measured from the tagged **commit's** date (`%cI` on the
// dereferenced commit), not an annotated tag object's own creation
// timestamp -- lightweight tags have no separate tagger date to read, and
// using the commit date keeps both tag forms measured the same way.
// Calibrated against this repository's own history rather than picked
// arbitrarily: as of 2026-07-03, `main` was 636 commits / ~22 days past
// `v0.3.0` under this repository's own atypically heavy dogfooding
// velocity (~29 commits/day) -- not a representative adopter cadence, and
// the `v0.2.0` -> `v0.3.0` gap (~10.5 hours) was too short to use as a
// cadence sample either. 100 commits sizes the default for a *typical*
// adopter's velocity, not idd-skill's own extreme rate -- it is expected
// to (correctly) also fire immediately for idd-skill itself. 45 days gives
// roughly 1.5 release cycles of slack under a monthly-ish cadence before
// warning.
//
// HEAD-vs-main: the check measures drift from whatever commit is currently
// checked out, not specifically `main` -- `.github/workflows/idd-doctor.yml`
// runs it on every pull request against the PR's own (detached) HEAD, not
// `main`. The warning message below says "HEAD", not "main", so it stays
// accurate under that CI topology and any other non-main invocation.
export const RELEASE_TAG_DRIFT_COMMIT_THRESHOLD = 100;
export const RELEASE_TAG_DRIFT_DAY_THRESHOLD = 45;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Verdict for one release-tag-drift classification. */
export interface ReleaseTagDriftVerdict {
  warn: boolean;
  message?: string;
}

/**
 * Classify how far the current HEAD has drifted from the latest release
 * tag, given the already-computed commit and day distances. Pure and
 * exported so tests can cover every threshold combination without shelling
 * out to git, using the module-level `RELEASE_TAG_DRIFT_*` thresholds (no
 * CLI override -- the issue's acceptance criteria only calls for documented
 * defaults). `tag === null` means no tag is reachable from HEAD yet (a
 * fresh adopter clone before its first release) -- always non-warning. The
 * only caller, `checkReleaseTagDrift`, already returns before ever invoking
 * this with `tag: null` (its own `git describe` failure is the earlier exit
 * point); the branch is kept here, mirroring
 * `classifyWorktreeGuardActivation`'s `headDetached` handling, purely so
 * this no-tag case is directly unit-testable without shelling out to git.
 */
export function classifyReleaseTagDrift(
  tag: string | null,
  commitsSinceTag: unknown,
  daysSinceTag: unknown,
): ReleaseTagDriftVerdict {
  if (!tag) {
    return { warn: false };
  }
  const commitThreshold = RELEASE_TAG_DRIFT_COMMIT_THRESHOLD;
  const dayThreshold = RELEASE_TAG_DRIFT_DAY_THRESHOLD;
  const commits = Number(commitsSinceTag);
  const days = Number(daysSinceTag);
  const safeCommits = Number.isFinite(commits) ? commits : 0;
  const safeDays = Number.isFinite(days) ? days : 0;
  const overCommits = safeCommits > commitThreshold;
  const overDays = safeDays > dayThreshold;
  if (!overCommits && !overDays) {
    return { warn: false };
  }
  const parts: string[] = [];
  if (overCommits) {
    parts.push(`${safeCommits} commit(s) (> ${commitThreshold})`);
  }
  if (overDays) {
    // Round up, not down: flooring a value just over the threshold (e.g.
    // 45.1 with a 45-day threshold) would print "45 day(s) (> 45)", which
    // reads as self-contradictory. Ceiling guarantees the printed integer
    // is always strictly greater than dayThreshold whenever overDays is
    // true (safeDays > dayThreshold implies ceil(safeDays) > dayThreshold
    // for any integer dayThreshold).
    parts.push(`${Math.ceil(safeDays)} day(s) (> ${dayThreshold})`);
  }
  return {
    warn: true,
    message: `release-tag drift: HEAD is ${parts.join(' and ')} past the latest tag ${tag}. Consider cutting a new release.`,
  };
}

// Warns (never fails) when the current HEAD has drifted far from the latest
// release tag. Skips silently -- no warning, no crash -- whenever there is
// no usable tag baseline to measure drift against: `git describe` (or the
// follow-up `rev-list` / `log` calls) failing is treated as one single,
// safe "no baseline" signal, covering every cause the same way -- no tags
// at all yet (a fresh adopter clone before its first release), no tag
// reachable from HEAD, tag history hidden by a shallow fetch (see
// idd-skill#1286), or `git` itself being unavailable. This function never
// tries to distinguish those causes; any of them means skip silently.
function checkReleaseTagDrift(root: string, report: DoctorReport) {
  const describeResult = runCommand(
    'git',
    ['describe', '--tags', '--abbrev=0'],
    root,
  );
  if (!describeResult.ok) {
    return;
  }
  const tag = describeResult.stdout.trim();
  if (!tag) {
    return;
  }
  const countResult = runCommand(
    'git',
    ['rev-list', '--count', `${tag}..HEAD`],
    root,
  );
  // `^{commit}` dereferences an annotated tag to the commit it points at, so
  // the drift measurement uses the tagged commit's date in both tag forms.
  const dateResult = runCommand(
    'git',
    ['log', '-1', '--format=%cI', `${tag}^{commit}`],
    root,
  );
  if (!countResult.ok || !dateResult.ok) {
    return;
  }
  const commitsSinceTag = Number(countResult.stdout.trim());
  const tagDate = new Date(dateResult.stdout.trim());
  if (!Number.isFinite(commitsSinceTag) || Number.isNaN(tagDate.getTime())) {
    return;
  }
  const daysSinceTag = (Date.now() - tagDate.getTime()) / MS_PER_DAY;
  const verdict = classifyReleaseTagDrift(tag, commitsSinceTag, daysSinceTag);
  if (verdict.warn && verdict.message) {
    report.warnings.push(verdict.message);
  }
}

export function findMissingWorkshopReferences(
  entryFiles: { path: string; content: string | null }[],
  allowMissing: unknown,
): string[] {
  const allowSet = new Set(
    (Array.isArray(allowMissing) ? allowMissing : []).map((path) =>
      String(path),
    ),
  );
  const missing: string[] = [];
  for (const entry of entryFiles) {
    if (allowSet.has(entry.path)) {
      continue;
    }
    if (entry.content === null) {
      missing.push(entry.path);
      continue;
    }
    if (typeof entry.content !== 'string') {
      continue;
    }
    if (!containsWorkshopReference(entry.content)) {
      missing.push(entry.path);
    }
  }
  return missing;
}

export function containsWorkshopReference(content: unknown): boolean {
  if (typeof content !== 'string' || content.length === 0) {
    return false;
  }
  // Strip fenced code blocks (``` and ~~~) before scanning so demo
  // Markdown inside code samples does not count as a real link.
  const stripped = stripFencedCodeBlocks(content);
  // Accept any double-quoted, single-quoted, or no-title destination
  // form per CommonMark inline-link grammar.
  const linkPattern =
    /\[[^\]\n]*\]\(\s*([^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = linkPattern.exec(stripped)) !== null) {
    const target = match[1];
    if (!target) continue;
    if (matchesWorkshopPath(target)) {
      return true;
    }
  }
  return false;
}

function stripFencedCodeBlocks(content: string): string {
  const lines = String(content).split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push(line);
  }
  return out.join('\n');
}

function matchesWorkshopPath(target: string): boolean {
  const cleaned = String(target)
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  for (const pattern of WORKSHOP_LINK_TARGET_PATTERNS) {
    if (pattern.test(`/${cleaned}`)) {
      return true;
    }
  }
  return false;
}

// Verifies that the workshop publication is discoverable from every
// known entry point (README.md, README.ja.md, docs/index.md).
// Skipped silently when docs/workshop/ does not exist (adopter repos
// that never published a workshop should not see noise). The example
// repository's back-link is intentionally out of scope here because
// verifying it requires fetching a remote repository's README; that
// is a separate concern under the helper-runtime profile work.
function checkWorkshopCrossReferences(
  root: string,
  options: { allowMissing?: string[] },
  report: DoctorReport,
) {
  const allowMissing = options.allowMissing ?? [];
  const workshopDir = resolve(root, WORKSHOP_REL_PATH);
  if (!existsSync(workshopDir)) {
    return;
  }
  const entryFiles = WORKSHOP_ENTRY_POINTS.map((relPath) => {
    const abs = resolve(root, relPath);
    if (!existsSync(abs)) {
      return { path: relPath, content: null };
    }
    try {
      return { path: relPath, content: readFileSync(abs, 'utf8') };
    } catch {
      return { path: relPath, content: null };
    }
  });
  const missing = findMissingWorkshopReferences(entryFiles, allowMissing);
  for (const path of missing) {
    report.warnings.push(
      `workshop cross-reference missing in ${path}: expected a Markdown link whose target starts with ${WORKSHOP_REL_PATH}/. See acceptance criteria on issue #611 (CP-E).`,
    );
  }
}

// Returns a regex that matches a URL **pathname** of shape
// `/<slug>/(<segments>/)*docs/workshop(/|$|[?#])`. Anchored to
// `^/<slug>/` so the slug must occupy the first two path segments
// and be terminated by a real path separator (prevents
// `acme/me/repo` from matching slug `me/repo` and
// `me/repodocs/workshop` from being read as `me/repo` +
// `docs/workshop`). Trailing boundary prevents
// `docs/workshops/...` and `docs/workshop-old/...` from matching
// `docs/workshop`.
//
// This is the **pathname matcher only**. The URL parser that
// pairs with it (containsExampleRepoBackLink below) handles host
// validation, URL token cleanup, and root-relative target
// extraction; do not use this pattern against a full URL or
// external host token.
export function backLinkPatternFor(repoSlug: unknown): RegExp {
  const escSlug = String(repoSlug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^/${escSlug}/(?:[^?#]*?/)?docs/workshop(?:/|$|[?#])`, 'i');
}

export function stripMarkdownNonText(content: unknown): string {
  if (typeof content !== 'string') return '';
  let s = content;
  // Order matters: strip code regions FIRST so a literal `<!--`
  // inside a code span cannot trigger the HTML-comment strip
  // across unrelated content. After code regions are gone, HTML
  // comments are guaranteed to be real comments.
  s = stripFencesPreservingLines(s);
  s = stripIndentedCodeBlocksPreservingLines(s);
  // Inline code spans (single or multi-backtick).
  s = s.replace(/(`+)((?:(?!\1)[\s\S])+?)\1/g, '');
  // Now strip HTML comments. Loop to a fixed point so nested
  // payloads like `<!--<!-- x --> -->` fully collapse rather than
  // leaving `<!--` fragments after a single pass — satisfies
  // CodeQL's incomplete-multi-character sanitization rule.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, '');
  } while (s !== prev);
  return s;
}

// Per CommonMark §4.5: an opening fence may have up to 3 leading
// spaces; the opening backtick fence info string MUST NOT contain
// backticks (the tilde fence info string may contain anything); a
// closing fence must use the same fence character, have a length
// at least the opening length, and may have a different indent
// (still <= 3 spaces) and trailing whitespace only.
function stripFencesPreservingLines(content: string): string {
  const lines = String(content).split(/\r?\n/);
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (m) {
      const indent = m[1].length;
      const marker = m[2];
      const after = m[3];
      const isCloseShape = /^\s*$/.test(after);
      const fenceChar = marker[0];
      const fenceLen = marker.length;
      if (fence === null) {
        // Backtick-fence info strings cannot contain backticks. A
        // line like ```` ``` invalid ` info ```` is not a real
        // fence opener, so treat it as plain content.
        if (fenceChar === '`' && after.includes('`')) {
          out.push(line);
          continue;
        }
        fence = { char: fenceChar, length: fenceLen };
        out.push('');
        continue;
      }
      if (
        fenceChar === fence.char &&
        fenceLen >= fence.length &&
        isCloseShape &&
        indent <= 3
      ) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  return out.join('\n');
}

// CommonMark §4.4 indented code blocks: content indented at least 4
// columns beyond the enclosing context (the top level, or an open list
// item's content column), preceded by a blank line. The stripper below
// tracks open list levels by content column (supporting `-`/`*`/`+` and
// ordered `\d+[.)]` markers), so list continuation and nested list items
// are preserved, while a deeper indent — even a list-marker-looking line
// — is treated as a nested indented code block and blanked. See
// stripIndentedCodeBlocksPreservingLines.
/** Leading-indent width of a line in columns (space = 1, tab = 4). */
function leadingIndentColumns(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === ' ') {
      columns += 1;
    } else if (ch === '\t') {
      columns += 4;
    } else {
      break;
    }
  }
  return columns;
}

function stripIndentedCodeBlocksPreservingLines(content: string): string {
  const lines = String(content).split(/\r?\n/);
  const out: string[] = [];
  let prevBlank = true;
  let inBlock = false;
  // The minimum indent (in columns) of the open indented code block, set
  // at its opener. A line indented below this leaves the block.
  let codeBaseIndent = 4;
  // Content-indent columns of the currently open list levels, outermost
  // first (a stack, so ending an inner list returns to the outer level
  // instead of losing its context). Under the innermost open list, content
  // indented up to `top + 3` is list continuation / nested-list items,
  // while content indented `>= top + 4` is an indented code block nested
  // inside the item (CommonMark allows code blocks within a list item).
  // With no list open the threshold is the top-level 4 columns, so a
  // top-level `>=4`-column indent is still a code block even when it looks
  // like a list marker.
  const listContentIndents: number[] = [];
  const innermostListIndent = () =>
    listContentIndents.length > 0
      ? listContentIndents[listContentIndents.length - 1]
      : null;
  // Drop list levels whose content column is deeper than `indent`, so a
  // dedent re-exposes the enclosing list (or no list).
  const popDeeperThan = (indent: number) => {
    while (
      listContentIndents.length > 0 &&
      indent < listContentIndents[listContentIndents.length - 1]
    ) {
      listContentIndents.pop();
    }
  };
  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      // A blank line ends neither an open indented code block nor an open
      // list: per CommonMark §4.4 a code block is one or more indented
      // chunks separated by blank lines, and loose lists are blank-line
      // separated too. Both states survive the blank; they only end at a
      // later non-indented, non-blank line (or a dedent).
      out.push(line);
      prevBlank = true;
      continue;
    }
    const indent = leadingIndentColumns(line);
    // CommonMark §5.2: ordered-list markers may use either `.` or `)`
    // after the digit. The match is the full marker prefix (leading
    // whitespace + marker + trailing whitespace); its column width gives
    // the list item's content column, computed tab-aware where the item
    // is kept below.
    const listMarker = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line);

    if (inBlock) {
      if (indent >= codeBaseIndent) {
        // Continuation of the open code block (even across blank lines).
        // A list cannot start inside it, so a list-marker-looking line
        // here stays code and is blanked.
        out.push('');
        prevBlank = false;
        continue;
      }
      // Indented below the code block base; it ends. Reprocess this line.
      inBlock = false;
    }

    const codeThreshold = (innermostListIndent() ?? 0) + 4;
    if (prevBlank && indent >= codeThreshold) {
      // Indented code block opener — at the top level (no list) or nested
      // inside the current list item. A list marker at this depth is code,
      // not a list, so this branch precedes the list-marker handling.
      out.push('');
      inBlock = true;
      codeBaseIndent = codeThreshold;
      prevBlank = false;
      continue;
    }

    if (listMarker && indent < codeThreshold) {
      // A list item (top-level or nested, but shallower than a code block
      // per the threshold above — a marker at code depth that was not
      // opened as a code block is paragraph continuation, handled below,
      // and must not open a list level). Close any deeper sibling levels,
      // then record this item's content column as the new innermost list.
      // The content column is the full prefix width in columns (tab = 4),
      // consistent with leadingIndentColumns, so a tab after the marker is
      // not miscounted as a single column.
      out.push(line);
      let prefixWidth = 0;
      for (const ch of listMarker[0]) {
        prefixWidth += ch === '\t' ? 4 : 1;
      }
      const contentColumn = prefixWidth;
      popDeeperThan(indent);
      listContentIndents.push(contentColumn);
      prevBlank = false;
      continue;
    }

    // A non-code, non-list line: close any list levels whose content
    // column is deeper than this line's indent. A line that drops below
    // every level closes the list entirely; a line still within an outer
    // level keeps that level open.
    out.push(line);
    popDeeperThan(indent);
    prevBlank = false;
  }
  return out.join('\n');
}

export function containsExampleRepoBackLink(
  readmeContent: unknown,
  repoSlug: unknown,
): boolean {
  if (typeof readmeContent !== 'string' || readmeContent.length === 0) {
    return false;
  }
  // Strip code samples first so any literal `<!--` inside a code
  // span does not trigger HTML-comment removal across unrelated
  // content. The pattern is tested against the URL pathname only
  // (no host / query / fragment) so the regex can stay anchored
  // to `^/<slug>/` and query strings cannot smuggle the slug.
  const pattern = backLinkPatternFor(repoSlug);
  // Mask inline-image destinations BEFORE generic URL extraction
  // so badge-style images like ![alt](https://github.com/...) do
  // not count as navigational back-links.
  const imagedStripped = stripMarkdownNonText(readmeContent).replace(
    /!\[[^\]]*\]\(\s*<?[^()\s>]+>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
    '',
  );
  // Reference-style images (`![alt][id]`, collapsed `![id][]`, shortcut
  // `![id]`) resolve their source through a separate `[id]: <url>`
  // reference definition, so the definition is an image source, not a
  // navigation link. Collect every label an image references, then drop
  // the matching reference-definition lines before the URL scans below.
  // A real reference *link* (`[text][id]`) keeps its definition and is
  // still counted.
  const imageLabels = new Set<string>();
  const imageRefPattern = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;
  let imageMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((imageMatch = imageRefPattern.exec(imagedStripped)) !== null) {
    const explicit = imageMatch[2]?.trim() ?? '';
    const shortcut = imageMatch[1]?.trim() ?? '';
    const label = explicit.length > 0 ? explicit : shortcut;
    if (label.length > 0) imageLabels.add(label.toLowerCase());
  }
  // Labels that have a reference definition. A shortcut reference
  // (`[id]`) only resolves to a link/image when such a definition exists,
  // so the defined-label set scopes shortcut detection below and avoids
  // treating ordinary bracketed prose as a reference.
  const definedLabels = new Set<string>();
  const refDefPattern = /^ {0,3}\[([^\]]+)\]:.*$/gm;
  let defMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((defMatch = refDefPattern.exec(imagedStripped)) !== null) {
    definedLabels.add(defMatch[1].trim().toLowerCase());
  }
  // A reference *link* (full `[text][id]`, collapsed `[id][]`, or shortcut
  // `[id]`; the leading `!` excludes images) shares the `[id]: <url>`
  // definition with navigation, so a label used by a link must keep its
  // definition even when an image also references it. Collect link labels
  // and drop only definitions for labels referenced *exclusively* by
  // images.
  const linkLabels = new Set<string>();
  const refLinkPattern = /(?<!!)\[[^\]]*\]\[([^\]]*)\]/g;
  let linkMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((linkMatch = refLinkPattern.exec(imagedStripped)) !== null) {
    const explicit = linkMatch[1]?.trim() ?? '';
    // Collapsed form `[id][]` carries the label in the first bracket;
    // recover it from the full match when the second bracket is empty.
    const label =
      explicit.length > 0
        ? explicit
        : (linkMatch[0].match(/^\[([^\]]*)\]\[\]$/)?.[1]?.trim() ?? '');
    if (label.length > 0) linkLabels.add(label.toLowerCase());
  }
  // Shortcut reference links: a bare `[id]` not preceded by `]`/`!` (which
  // would be a full-reference tail or an image) and not followed by
  // `(`/`[`/`:` (inline link, full/collapsed reference, or definition).
  // Only count it when `id` is actually defined.
  const shortcutPattern = /(?<![\]!])\[([^\]]+)\](?![([:])/g;
  let shortcutMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((shortcutMatch = shortcutPattern.exec(imagedStripped)) !== null) {
    const label = shortcutMatch[1].trim().toLowerCase();
    if (label.length > 0 && definedLabels.has(label)) linkLabels.add(label);
  }
  const dropLabels = new Set(
    [...imageLabels].filter((label) => !linkLabels.has(label)),
  );
  const stripped =
    dropLabels.size === 0
      ? imagedStripped
      : imagedStripped.replace(
          /^ {0,3}\[([^\]]+)\]:.*$/gm,
          (full, label: string) =>
            dropLabels.has(label.trim().toLowerCase()) ? '' : full,
        );
  // Absolute http(s) URLs.
  const urlPattern = /https?:\/\/[^\s<>)\]"']+/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = urlPattern.exec(stripped)) !== null) {
    const token = match[0].replace(/[.,;:!?]+$/, '');
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      continue;
    }
    if (!isGithubBackLinkHost(url.hostname)) continue;
    if (pattern.test(url.pathname)) return true;
  }
  // Root-relative Markdown link targets (`[text](/owner/repo/...)`)
  // and reference-definition destinations (`[id]: /owner/repo/...`).
  // GitHub renders these against the current repo / docs origin;
  // the back-link pattern already requires `^/<slug>/` so a
  // root-relative target is checked against the same shape.
  // Allows CommonMark optional whitespace before the destination
  // and angle-bracket-wrapped destinations (`(<...>)` / `[id]: <...>`).
  const mdInline =
    /\[[^\]]*\]\(\s*<?(\/[^()\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = mdInline.exec(stripped)) !== null) {
    if (pattern.test(match[1].replace(/[.,;:!?]+$/, ''))) return true;
  }
  const mdRefDef = /^\s{0,3}\[[^\]]+\]:\s*<?(\/[^\s>]+)>?/gm;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = mdRefDef.exec(stripped)) !== null) {
    if (pattern.test(match[1].replace(/[.,;:!?]+$/, ''))) return true;
  }
  return false;
}

// Runtime / skip semantics live on the check function below, not on
// the helpers above. `checkWorkshopExampleRepoBackLink` reads the
// example-repo coordinates from `.github/idd/config.json`
// (`workshop.exampleRepository`, `<owner>/<repo>` shape) and skips
// silently when the local docs/workshop/ is absent, the config
// field is unset, or the gh fetch fails. Soft fetch failures
// escalate to errors under `--require-github`.

const PUBLIC_GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
]);

export function isGithubBackLinkHost(host: unknown): boolean {
  const lower = String(host ?? '').toLowerCase();
  if (PUBLIC_GITHUB_HOSTS.has(lower)) return true;
  // Any other host must be declared explicitly in
  // IDD_WORKSHOP_BACKLINK_HOSTS. The `*.github.com` wildcard was
  // removed because subdomains like `docs.github.com` and
  // `api.github.com` do not host repository paths but would pass
  // the wildcard check. GitHub Enterprise Server adopters whose
  // host does not exactly match the public list must opt in
  // explicitly.
  const extra = (process.env.IDD_WORKSHOP_BACKLINK_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(lower);
}

export function decodeGithubReadmeBase64(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const compact = content.replace(/\s+/g, '');
  if (compact.length === 0) return null;
  // `gh api --jq .content` writes the literal string `null` when
  // the JSON path does not exist; treat that as not-a-payload so a
  // missing README does not decode to a non-empty UTF-8 string.
  if (compact === 'null') return null;
  // Base64 payload length is always a multiple of 4 (with padding);
  // a short alphanumeric string like `null` survives the
  // character-class check above but fails the length check here.
  if (compact.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(content)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (typeof decoded !== 'string' || decoded.length === 0) return null;
  // Re-encode and compare to guard against base64-shaped strings
  // that happen to decode to lossy garbage. Standard GitHub README
  // payloads round-trip cleanly.
  if (Buffer.from(decoded, 'utf8').toString('base64') !== compact) {
    return null;
  }
  return decoded;
}

function checkWorkshopExampleRepoBackLink(
  root: string,
  options: { requireGithub?: boolean },
  report: DoctorReport,
) {
  const requireGithub = options.requireGithub === true;
  const workshopDir = resolve(root, WORKSHOP_REL_PATH);
  if (!existsSync(workshopDir)) return;

  const configPath = resolve(root, '.github/idd/config.json');
  if (!existsSync(configPath)) return;
  let config: { workshop?: { exampleRepository?: unknown } } | null;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  const exampleRepo = config?.workshop?.exampleRepository;
  if (typeof exampleRepo !== 'string' || exampleRepo.trim().length === 0) {
    return;
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(exampleRepo)) {
    const message = `invalid workshop.exampleRepository value "${exampleRepo}" — expected "<owner>/<repo>".`;
    // Misconfiguration is not a soft GitHub failure; it is a real
    // gating signal. Under --require-github this must escalate so
    // CI catches the typo instead of silently passing.
    if (requireGithub) {
      report.errors.push(`workshop example-repo back-link check: ${message}`);
    } else {
      report.warnings.push(`workshop example-repo check skipped: ${message}`);
    }
    return;
  }

  const recordSoftFailure = (message: string) => {
    if (requireGithub) {
      report.errors.push(`workshop example-repo back-link check: ${message}`);
    }
  };

  // Resolve this repo's slug from gh repo view so the back-link
  // pattern matches the correct owner / name even when the
  // configured GitHub origin differs from local assumptions.
  const repoView = runCommand(
    'gh',
    ['repo', 'view', '--json', 'owner,name'],
    root,
  );
  if (!repoView.ok) {
    recordSoftFailure(`gh repo view unavailable`);
    return;
  }
  let viewer: { owner?: { login?: string }; name?: string };
  try {
    viewer = JSON.parse(repoView.stdout);
  } catch {
    recordSoftFailure(`gh repo view output is not valid JSON`);
    return;
  }
  const owner = viewer.owner?.login;
  const name = viewer.name;
  if (!owner || !name) {
    recordSoftFailure(`gh repo view did not return owner / name`);
    return;
  }
  const repoSlug = `${owner}/${name}`;

  // `repos/<owner>/<repo>/readme` returns whatever GitHub considers
  // the canonical README (README.md, README.rst, README, case
  // variants), so the check works for repos that do not name their
  // README exactly `README.md`.
  const readmeFetch = runCommand(
    'gh',
    ['api', `repos/${exampleRepo}/readme`, '--jq', '.content'],
    root,
  );
  if (!readmeFetch.ok) {
    recordSoftFailure(`could not fetch ${exampleRepo} README via gh api`);
    return;
  }
  const stdout = String(readmeFetch.stdout);
  const compact = stdout.replace(/\s+/g, '');
  if (compact.length === 0) {
    // Empty README is a real missing-back-link condition, not a
    // soft fetch failure (the README exists but contains nothing).
    report.warnings.push(
      `workshop example-repo back-link missing: ${exampleRepo} README is empty; no link to ${repoSlug}/.../docs/workshop can be present.`,
    );
    return;
  }
  const decoded = decodeGithubReadmeBase64(stdout);
  if (!decoded) {
    recordSoftFailure(`${exampleRepo} README content was not valid base64`);
    return;
  }

  if (!containsExampleRepoBackLink(decoded, repoSlug)) {
    report.warnings.push(
      `workshop example-repo back-link missing: ${exampleRepo} README does not contain a link whose target matches ${repoSlug}/.../docs/workshop. See acceptance criteria on issue #611 (CP-E).`,
    );
  }
}

function checkGithubReadiness(
  root: string,
  requireGithub: boolean | undefined,
  report: DoctorReport,
) {
  const repoView = runCommand(
    'gh',
    ['repo', 'view', '--json', 'owner,name,defaultBranchRef,url'],
    root,
  );
  if (!repoView.ok) {
    const message = 'github checks skipped: gh repo view unavailable';
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }

  let parsed: {
    owner?: { login?: string };
    name?: string;
    defaultBranchRef?: { name?: string };
    url?: string;
  };
  try {
    parsed = JSON.parse(repoView.stdout);
  } catch {
    const message =
      'github checks skipped: failed to parse gh repo view output';
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }

  const owner = parsed.owner?.login;
  const repo = parsed.name;
  const branch = parsed.defaultBranchRef?.name;
  const ghHostname = resolveTargetGhHostname(parsed.url);
  if (!owner || !repo || !branch) {
    const message =
      'github checks skipped: repository owner/name/default branch is incomplete';
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }

  const trustEmptyProtectionReads = readTrustEmptyProtectionReads(root);
  const encodedBranch = encodeURIComponent(branch);
  let branchRulesRead: GovernanceReadOutcome<BranchRuleReadEntry[]>;
  let branchProtectionRead: GovernanceReadOutcome<BranchProtectionReadPayload>;
  try {
    branchRulesRead = fetchGovernanceJson<BranchRuleReadEntry[]>(
      `repos/${owner}/${repo}/rules/branches/${encodedBranch}`,
      true,
      trustEmptyProtectionReads,
      [],
      (path, paginate) => fetchGhApiJsonAt(root, ghHostname, path, paginate),
    );
    branchProtectionRead = fetchGovernanceJson<BranchProtectionReadPayload>(
      `repos/${owner}/${repo}/branches/${encodedBranch}/protection`,
      false,
      trustEmptyProtectionReads,
      {},
      (path, paginate) => fetchGhApiJsonAt(root, ghHostname, path, paginate),
    );
  } catch {
    const message = `branch protection not readable for ${owner}/${repo}:${branch}`;
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }

  if (isBranchProtectionUnreadable(branchRulesRead, branchProtectionRead)) {
    const message = `branch protection not readable for ${owner}/${repo}:${branch}`;
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }

  const findings = evaluateBranchProtectionFindings(
    branchRulesRead.value,
    branchProtectionRead.value,
  );

  if (
    findings.requiredCheckCount === 0 &&
    !findings.requiredChecksSourcePinned
  ) {
    report.warnings.push(
      `branch protection is enabled but no required status checks are configured on ${branch}`,
    );
  } else if (findings.requiredCheckCount === 0) {
    report.passes.push(
      `required status checks configured on ${branch} via a source-pinned requirement (e.g. a Rulesets "workflows" rule) with no enumerable check name`,
    );
  } else {
    report.passes.push(
      `required status checks configured on ${branch} (${findings.requiredCheckCount}, strict=${findings.requiredChecksStrict})`,
    );
  }

  if (!findings.reviewPolicyConfigured) {
    report.warnings.push(
      `required pull request reviews are not configured on ${branch}`,
    );
  } else {
    report.passes.push('required pull request review policy is configured');
  }
}

/**
 * One `rules/branches/{branch}` rule entry, as accepted by
 * `summarizeBranchReviewRequirements()`'s branch-rules parameter
 * (`protocol-helpers.mts`). Extracted via `Parameters<>` rather than
 * duplicated: that helper's own `BranchRuleLike` type is not exported,
 * and re-declaring a narrower local shape by hand previously drifted
 * out of sync with what `summarizeBranchReviewRequirements()` actually
 * reads from `rule.parameters` (idd-skill#2010 review).
 */
type BranchRuleReadEntry = NonNullable<
  Parameters<typeof summarizeBranchReviewRequirements>[0]
>[number];

/**
 * A classic `branches/{branch}/protection` payload, as accepted by
 * `summarizeBranchReviewRequirements()`'s branch-protection parameter.
 * Extracted the same way as {@link BranchRuleReadEntry}. Both parameters
 * are optional (default-valued) on `summarizeBranchReviewRequirements()`
 * itself, which is why `Parameters<>` alone would include `| undefined`
 * here; `NonNullable<>` strips that back out since every call site below
 * always passes a concrete value.
 */
type BranchProtectionReadPayload = NonNullable<
  Parameters<typeof summarizeBranchReviewRequirements>[1]
>;

/** Outcome of one `fetchGovernanceJson()` read (mirrors its own return shape). */
interface GovernanceReadOutcome<T> {
  value: T;
  unreadable: boolean;
}

/**
 * Whether `checkGithubReadiness` should report branch protection as
 * unreadable, combining both governance reads' outcomes. Only `true` when
 * **both** the Rulesets read (`rules/branches/{branch}`) and the classic
 * read (`branches/{branch}/protection`) are unreadable -- matching
 * idd-skill#2010's acceptance criteria ("When the Rulesets read succeeds,
 * or the config key is `true`, drop the warning ... instead of returning
 * early"). A repository on Rulesets-only protection legitimately 404s on
 * the classic endpoint (GitHub's classic-protection endpoint never
 * reflects Rulesets-only configuration); requiring only one read to
 * succeed keeps that case from being misreported as unreadable even when
 * `ciGate.trustEmptyProtectionReads` is unset (idd-skill#2010 review,
 * Copilot round). Pure so the classic-only / Rulesets-only / both /
 * neither matrix is directly testable without mocking `gh`, mirroring
 * {@link evaluateBranchProtectionFindings}'s own rationale.
 */
export function isBranchProtectionUnreadable(
  branchRulesRead: { unreadable: boolean },
  branchProtectionRead: { unreadable: boolean },
): boolean {
  return branchRulesRead.unreadable && branchProtectionRead.unreadable;
}

/** Findings the branch-protection check reports for the doctor output. */
export interface BranchProtectionFindings {
  requiredCheckCount: number;
  /**
   * `true` when a Rulesets `workflows` rule (or any other
   * source-pinned-but-unresolved requirement `summarizeBranchReviewRequirements()`
   * detects) requires checks with no enumerable name -- distinct from
   * `requiredCheckCount === 0` meaning "nothing configured" (idd-skill#2010
   * review): a branch protected solely by a required-workflows Rulesets
   * rule has real protection even though it contributes zero names.
   */
  requiredChecksSourcePinned: boolean;
  requiredChecksStrict: boolean;
  reviewPolicyConfigured: boolean;
}

/**
 * Combine a classic `branches/{branch}/protection` read with a GitHub
 * Rulesets `rules/branches/{branch}` read into the findings
 * `checkGithubReadiness` reports. Pure and network-free so the
 * classic-only / Rulesets-only / both / neither matrix is directly
 * testable without mocking `gh`.
 *
 * Required-check counting reuses the already-exported
 * `summarizeBranchReviewRequirements()` (`protocol-helpers.mts`), which
 * already normalizes the field-name differences between classic
 * `contexts` and a Rulesets `required_status_checks` rule's `parameters`
 * into one deduplicated name set -- this function adds no separate
 * name-extraction logic of its own (idd-skill#2010).
 *
 * Review-policy presence deliberately stays a presence check, not a
 * minimum-approval-count check, matching this file's pre-existing
 * classic-only behavior: a repository that requires a pull request but
 * configures zero mandatory approvals still counts as configured. The
 * same presence test is simply widened to also recognize a Rulesets
 * `pull_request`-type rule.
 *
 * `requiredChecksStrict` also honors a Rulesets `required_status_checks`
 * rule's own `strict_required_status_checks_policy` parameter, not just
 * classic protection's `strict` field -- a Rulesets-only repository with
 * that policy enabled previously always reported `strict=false`
 * (idd-skill#2010 review). GitHub's ruleset docs state that flag "will
 * not take effect unless at least one status check is enabled", so it
 * only counts here when that same rule's own check list is non-empty --
 * the same non-empty-check guard `summarizeBranchCurrency()`
 * (`protocol-helpers.mts`) already applies for the identical reason
 * (`#1513`), reusing its `summarizeRequiredCheckMetadata()` extraction
 * rather than a second name-counting implementation.
 */
export function evaluateBranchProtectionFindings(
  branchRules: BranchRuleReadEntry[],
  branchProtection: BranchProtectionReadPayload,
): BranchProtectionFindings {
  const requirements = summarizeBranchReviewRequirements(
    branchRules,
    branchProtection,
  );
  const reviewPolicyConfigured =
    Boolean(branchProtection.required_pull_request_reviews) ||
    branchRules.some((rule) => rule?.type === 'pull_request');
  const rulesetStrict = branchRules.some(
    (rule) =>
      rule?.type === 'required_status_checks' &&
      rule.parameters?.strict_required_status_checks_policy === true &&
      summarizeRequiredCheckMetadata(rule.parameters ?? {}).names.length > 0,
  );
  return {
    requiredCheckCount: requirements.requiredCheckNames.length,
    requiredChecksSourcePinned: requirements.requiredCheckSourcePinned,
    requiredChecksStrict:
      Boolean(branchProtection.required_status_checks?.strict) || rulesetStrict,
    reviewPolicyConfigured,
  };
}

/**
 * Root-relative `ciGate.trustEmptyProtectionReads` reader
 * (idd-skill#2010; #1377 introduced the flag). Deliberately not
 * `pre-merge-readiness.mts`'s own `readTrustEmptyProtectionReads`, which
 * reads only `.github/idd/config.json` relative to `process.cwd()` and has
 * no legacy fallback -- `idd-doctor.mts` supports `--repo-root <path>` and
 * resolves the live config root-relative, canonical `.github/idd/config.json`
 * first, falling back to the legacy `idd-policy.json` when the canonical
 * file is absent (see {@link resolveLiveConfigDocument}, idd-skill#2028),
 * the same two-file resolution every other scalar reader in this file
 * shares. Fails closed to `false` on a missing or unparseable config,
 * matching `normalizePolicyConfig(null).ciGate.trustEmptyProtectionReads`'s
 * default.
 */
export function readTrustEmptyProtectionReads(root: string): boolean {
  const { config } = resolveLiveConfigDocument(root);
  return (
    (config as { ciGate?: { trustEmptyProtectionReads?: unknown } } | null)
      ?.ciGate?.trustEmptyProtectionReads === true
  );
}

/**
 * Derive the host {@link fetchGhApiJsonAt} should target from the target
 * repository's own `gh repo view --json url` result (already fetched once
 * by `checkGithubReadiness`, so this adds no extra `gh` call). `gh api`
 * resolves its target host from `GH_HOST` / `--hostname` / the CLI's
 * single authenticated host, defaulting to `github.com` -- unlike a
 * higher-level subcommand such as `gh repo view`, it does **not** infer
 * the host from the checked-out repository's Git remote at all, so
 * routing the request through `cwd: root` (as every other `gh` call in
 * this function already does) has no effect on which host `gh api`
 * targets (`gh-exec.mts`'s `resolveGhApiHostname()` documents the
 * identical `gh api` contract for its own GHES fix, `#1962`; idd-skill#2010
 * review, Codex round 2). `resolveGhApiHostname()` itself is env-based
 * (`GH_HOST`/`GITHUB_SERVER_URL`) and deliberately does not derive a host
 * from a git remote, by its own design -- the wrong signal here, since
 * `idd-doctor --repo-root <path>` may target a repository on a different
 * host than the calling environment's own default. Deriving from the
 * target repository's own resolved `url` instead is the correct,
 * `--repo-root`-specific signal. Returns the literal `'github.com'` for
 * the common `github.com` case as an explicit override: an explicit
 * `--hostname` flag wins over `gh api`'s own environment-based `GH_HOST`
 * fallback, but `undefined` (no `--hostname` at all) leaves `GH_HOST` in
 * force, so a GHES-configured `GH_HOST` in the calling environment would
 * otherwise leak into a governance read for a genuinely
 * `github.com`-hosted target repository (idd-skill#2030).
 *
 * Returns `URL.host` (hostname plus an explicit non-default port, when
 * present -- Node's `URL` already elides an explicit-but-default `:443`
 * on an `https:` URL, so no separate default-port branch is needed here),
 * not `URL.hostname` -- unlike `resolveGhApiHostname()` (`gh-exec.mts`),
 * which deliberately keeps the bare hostname for its own env-derived
 * inputs. The distinction matters only to {@link fetchGhApiJsonAt}: `gh
 * api --hostname` rejects any value containing a colon outright
 * (confirmed against a real `gh` binary), so a ported value can never
 * reach `--hostname`; {@link fetchGhApiJsonAt} instead detects the colon
 * and routes a ported host through an absolute API URL, omitting
 * `--hostname` entirely for that request (idd-skill#2052). Omitting it is
 * not a regression: `gh` v2.98.0 / `cli/go-gh` v2.13.0 source
 * (`pkg/cmd/api/http.go::httpRequest`, `api/http_client.go::
 * AddAuthTokenHeader`, `pkg/auth/auth.go::NormalizeHostname`) confirms an
 * absolute-URL request never consults the `--hostname`/`GH_HOST`-derived
 * host at all -- routing and the per-request credential lookup both key
 * off the request URL's own host (port included, `NormalizeHostname`
 * never strips one), so a `--hostname` alongside an absolute URL would be
 * inert, not protective. One residual, real gh limitation this fix does
 * not and cannot change: `gh auth login --hostname` is gated by the same
 * colon-rejecting validator, so a ported host can never have a
 * keyring/config-stored credential either -- only `GH_ENTERPRISE_TOKEN`/
 * `GITHUB_ENTERPRISE_TOKEN` (checked independently of the exact host
 * string) authenticate a ported GHES host reliably today. Returns
 * `undefined` only for an unparseable or host-less `url`.
 */
export function resolveTargetGhHostname(
  url: string | undefined,
): string | undefined {
  if (!url) {
    return undefined;
  }
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
  return host ? host : undefined;
}

/**
 * Root-scoped `gh api` fetch for {@link fetchGovernanceJson}'s injectable
 * `fetchJson` parameter. That function's own default fetcher
 * (`ghApiJson` in `pre-merge-readiness.mts`, via `runGh`/`ghText`) never
 * passes `--hostname` at all, so it always targets `gh`'s own default
 * host resolution -- correct for that file's own CLI, which always
 * operates on the repository it is invoked from (typically the same
 * host the calling environment already authenticates against), but
 * wrong for `idd-doctor.mts`'s `--repo-root <path>`, which can target a
 * different repository (and GitHub host) than the caller's own working
 * directory or environment. Pass the `hostname` {@link
 * resolveTargetGhHostname} resolved from the target repository's own
 * `gh repo view` result, and route through this file's own
 * `runCommand()` (already `cwd`-scoped to `root` for every other `gh`
 * call in this function -- harmless for `gh api`'s own host resolution,
 * but keeps this call consistent with its siblings). Mirrors
 * `ghApiJson`'s own `--paginate --jq '.[]'` NDJSON handling via the
 * shared `parsePaginatedGhNdjson()`, and shapes a failure's thrown error
 * the same way a real `execFileSync` failure would (`status`/`stderr`/
 * `stdout`), so `fetchGovernanceJson()`'s `deriveGhHttpStatus()`-based
 * 404 detection still works, including its stdout-carried JSON-body
 * fallback. Exported for direct test coverage of that failure shape.
 *
 * A `hostname` carrying an explicit port (from {@link
 * resolveTargetGhHostname}'s `URL.host`) can never be routed through
 * `--hostname` -- `gh` rejects any value containing a colon outright --
 * so this builds an absolute API URL instead
 * (`https://{host}/api/v3/{path}`, mirroring `gh`'s own
 * `ghinstance.RESTPrefix` enterprise-host convention: no `api.`
 * subdomain, that trick is `github.com`-only) and omits `--hostname`
 * from argv entirely for that request. This is not a functional
 * regression: `gh`'s own request/auth pipeline never consults
 * `--hostname` once the endpoint argument is already an absolute URL --
 * both routing and per-request credential lookup key off the request
 * URL's own host (idd-skill#2052; see {@link resolveTargetGhHostname}'s
 * JSDoc for the source citations). Every non-ported `hostname` (including
 * `undefined`) keeps the exact prior argv shape.
 */
export function fetchGhApiJsonAt(
  root: string,
  hostname: string | undefined,
  path: string,
  paginate: boolean,
): unknown {
  const isPorted = hostname?.includes(':') ?? false;
  const endpoint = isPorted
    ? `https://${hostname}/api/v3/${path.replace(/^\//, '')}`
    : path;
  const argv = [
    'api',
    endpoint,
    ...(!isPorted && hostname ? ['--hostname', hostname] : []),
    ...(paginate ? ['--paginate', '--jq', '.[]'] : []),
  ];
  const result = runCommand('gh', argv, root);
  if (!result.ok) {
    throw Object.assign(new Error('gh api failed'), {
      status: 1,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    });
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return paginate ? [] : {};
  }
  return paginate ? parsePaginatedGhNdjson(raw) : JSON.parse(raw);
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
): CommandResult {
  try {
    const stdout = execFileSync(command, argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    const candidate = error as {
      status?: number;
      stderr?: { toString?: () => string };
      stdout?: { toString?: () => string };
    };
    return {
      ok: false,
      code: candidate.status,
      stderr: candidate.stderr?.toString?.() ?? '',
      stdout: candidate.stdout?.toString?.() ?? '',
    };
  }
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `repo-root:`): tests/flag-name-matrix.test.mts scans this file's
// *compiled* .mjs source text for quoted flag literals. See
// cli-args.mts's module header for the full invariant.
const IDD_DOCTOR_FLAG_SPEC = {
  '--json': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h', default: false },
  '--require-github': { type: 'boolean', default: false },
  '--strict': { type: 'boolean', default: false },
  '--repo-root': { type: 'string' },
  '--cleanup-backlog-window-days': { type: 'string' },
  '--cleanup-backlog-warn-threshold': { type: 'string' },
  '--cleanup-backlog-bootstrap-cutoff': { type: 'string' },
  '--workshop-cross-ref-allow-missing': { type: 'string' },
} as const;

function parseArgs(argv: string[]): DoctorCliArgs {
  const { values, help } = parseCliArgs(argv, IDD_DOCTOR_FLAG_SPEC);

  const args: DoctorCliArgs = {
    root: process.cwd(),
    json: values.json as boolean,
    help,
    requireGithub: values['require-github'] as boolean,
    strict: values.strict as boolean,
  };

  // --repo-root rejects an explicit empty string the same as an omitted
  // flag (pre-migration guard used `!value`).
  const repoRoot = values['repo-root'] as string | undefined;
  if (repoRoot !== undefined) {
    if (!repoRoot) {
      throw new Error('--repo-root requires a value');
    }
    args.root = repoRoot;
  }

  // --cleanup-backlog-window-days rejects an explicit empty string
  // (pre-migration guard used `!value`); accepts any positive finite
  // number, including decimals -- kept as Number() + Number.isFinite,
  // NOT the canonical-integer helper, which would wrongly reject "1.5".
  const windowDaysToken = values['cleanup-backlog-window-days'] as
    | string
    | undefined;
  if (windowDaysToken !== undefined) {
    if (!windowDaysToken) {
      throw new Error('--cleanup-backlog-window-days requires a value');
    }
    const numeric = Number(windowDaysToken);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(
        `--cleanup-backlog-window-days must be a positive finite number (got "${windowDaysToken}")`,
      );
    }
    args.cleanupBacklogWindowDays = numeric;
  }

  // --cleanup-backlog-warn-threshold: pre-migration guard used
  // `=== undefined` (NOT `!value`), so an explicit empty string was
  // accepted and Number('') === 0 passed the >= 0 check -- preserved
  // exactly, including that quirk.
  const warnThresholdToken = values['cleanup-backlog-warn-threshold'] as
    | string
    | undefined;
  if (warnThresholdToken !== undefined) {
    const numeric = Number(warnThresholdToken);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(
        `--cleanup-backlog-warn-threshold must be a non-negative finite number (got "${warnThresholdToken}")`,
      );
    }
    args.cleanupBacklogWarnThreshold = numeric;
  }

  // --cleanup-backlog-bootstrap-cutoff (idd-skill#2226): optional, no
  // default -- absent means every PR is still reported the same,
  // undifferentiated way this check has always used. Rejects an explicit
  // empty string (matching --cleanup-backlog-window-days's own
  // empty-string guard above) and anything parseStrictCutoffToUtcMs
  // cannot resolve -- a bare `Date.parse` check here would accept
  // calendar overflow and a host-timezone-dependent offset-less
  // timestamp, both fixed by that stricter parser (CodeRabbit review on
  // PR #2386).
  const bootstrapCutoffToken = values['cleanup-backlog-bootstrap-cutoff'] as
    | string
    | undefined;
  if (bootstrapCutoffToken !== undefined) {
    if (!bootstrapCutoffToken) {
      throw new Error('--cleanup-backlog-bootstrap-cutoff requires a value');
    }
    if (parseStrictCutoffToUtcMs(bootstrapCutoffToken) === null) {
      throw new Error(
        `--cleanup-backlog-bootstrap-cutoff must be a strict YYYY-MM-DD date or a Z-suffixed ISO8601 timestamp (got "${bootstrapCutoffToken}")`,
      );
    }
    args.cleanupBacklogBootstrapCutoff = bootstrapCutoffToken;
  }

  // --workshop-cross-ref-allow-missing: pre-migration guard used
  // `=== undefined` (NOT `!value`), so an explicit empty string was
  // accepted and resolved to an empty list (''.split(',') -> [''] ->
  // filtered to []) -- preserved exactly.
  const allowMissingToken = values['workshop-cross-ref-allow-missing'] as
    | string
    | undefined;
  if (allowMissingToken !== undefined) {
    args.workshopCrossRefAllowMissing = allowMissingToken
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return args;
}

function printHumanReport(report: DoctorReport) {
  console.log(`IDD doctor report (${report.root})`);
  for (const pass of report.passes) {
    console.log(`PASS  ${pass}`);
  }
  for (const warning of report.warnings) {
    console.log(`WARN  ${warning}`);
  }
  for (const error of report.errors) {
    console.log(`ERROR ${error}`);
  }
  if (report.errors.length > 0) {
    console.log(
      `\nresult: failed (${report.errors.length} error(s), ${report.warnings.length} warning(s))`,
    );
    return;
  }
  console.log(`\nresult: passed (${report.warnings.length} warning(s))`);
}

function printUsage() {
  console.log(`usage: node scripts/idd-doctor.mjs [options]

options:
  --repo-root <path>                       repository root to inspect (default: cwd)
  --json                                   print JSON report
  --require-github                         treat GitHub API check failures as errors
  --strict                                 treat a primary-worktree implementation-branch HEAD as an error (also enabled by worktreeGuard.enabled in config)
  --cleanup-backlog-window-days <N>        merged-PR window for the cleanup backlog check (default: 14)
  --cleanup-backlog-warn-threshold <N>     backlog count above which the check warns (default: 2)
  --cleanup-backlog-bootstrap-cutoff <YYYY-MM-DD|ISO8601Z> label a flagged merged PR "(bootstrap-era)" in the report when it merged before this UTC date/timestamp, instead of a genuine claim-marker-missing gap (default: none -- every flagged PR reports the same way)
  --workshop-cross-ref-allow-missing <list> comma-separated entry-point paths to skip in the workshop cross-reference check (default: none)
  --help, -h                               show this help

The merged-PR backlog scan caps at gh's per-query maximum of 1000
results; repositories with > 1000 merged PRs in the window get a
representative sample. The check makes one gh api .../comments
call per merged PR returned, which is intentionally simple — for
very large or rate-limited repos consider raising the warn
threshold or shortening the window. The scan streams per-PR
progress to stderr so a slow network-bound run is distinguishable
from a hang; stdout (including --json) stays free of progress. For
a local run during a merge burst, pass --cleanup-backlog-window-days 1
to keep it fast, mirroring what CI already does.
`);
}

function listFiles(root: string): string[] {
  const gitList = runCommand(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    root,
  );
  if (gitList.ok) {
    return gitList.stdout.split(/\r?\n/).filter(Boolean).sort();
  }
  return walk(root)
    .map((absolutePath) => relative(root, absolutePath))
    .sort();
}

function walk(directory: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walk(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      entries.push(absolutePath);
    }
  }
  return entries;
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isTextLikeFile(file: string): boolean {
  return /\.(md|txt|yml|yaml|json|mjs|js|ts|sh)$/.test(file);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sameMembers(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

// Run as a CLI only after the whole module (including consts used by the
// checks above) has finished evaluating. Keeping this block at the end of
// the file avoids a temporal-dead-zone crash when runDoctor reaches a check
// that reads a `const` declared later in the file.
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const report = runDoctor({
    root: resolve(args.root),
    requireGithub: args.requireGithub,
    cleanupBacklogWindowDays: args.cleanupBacklogWindowDays,
    cleanupBacklogWarnThreshold: args.cleanupBacklogWarnThreshold,
    cleanupBacklogBootstrapCutoff: args.cleanupBacklogBootstrapCutoff,
    workshopCrossRefAllowMissing: args.workshopCrossRefAllowMissing,
    strict: args.strict,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  process.exit(report.errors.length > 0 ? 1 : 0);
}
