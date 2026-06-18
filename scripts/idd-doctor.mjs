#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-doctor.mts
//
// The scripts/idd-doctor.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAutopilotSuitabilityScore,
  normalizeAutopilotSuitabilityFloor,
} from './autopilot-suitability.mjs';
import {
  inspectHelperRuntimeConfig,
  parseProjectCommandRows,
} from './policy-helpers.mjs';

const WORKSHOP_ENTRY_POINTS = ['README.md', 'README.ja.md', 'docs/index.md'];
const WORKSHOP_REL_PATH = 'docs/workshop';
const WORKSHOP_LINK_TARGET_PATTERNS = [
  /(?:^|\/)docs\/workshop(?:\/|$)/,
  /(?:^|\/)workshop(?:\/|$)/,
];
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;

export { parseProjectCommandRows };
export function runDoctor({
  root,
  requireGithub,
  cleanupBacklogWindowDays,
  cleanupBacklogWarnThreshold,
  workshopCrossRefAllowMissing,
  strict,
}) {
  const files = listFiles(root);
  const textFiles = files.filter(isTextLikeFile);
  const report = {
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
  checkAgentEntryFiles(root, report);
  checkTemplateVersionSignal(root, report);
  const worktreeGuardEnforced =
    strict === true || readWorktreeGuardEnabled(root);
  checkPrimaryWorktreeHead(root, report, { enforce: worktreeGuardEnforced });
  checkWorktreeHardeningPresence(root, report);
  checkPostMergeCleanupBacklog(
    root,
    {
      windowDays: cleanupBacklogWindowDays ?? 14,
      warnThreshold: cleanupBacklogWarnThreshold ?? 2,
      requireGithub,
    },
    report,
  );
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
export function evaluateAutopilotSuitabilityConsistency(issues, options = {}) {
  const floor = normalizeAutopilotSuitabilityFloor(options.floor);
  const prefix =
    typeof options.markerPrefix === 'string' && options.markerPrefix.length > 0
      ? options.markerPrefix
      : 'idd-skill';
  const warnings = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const labelNames = new Set(
      (issue?.labels ?? []).map((label) =>
        typeof label === 'string' ? label : (label?.name ?? ''),
      ),
    );
    const blockedByHuman = labelNames.has('status:blocked-by-human');
    const marker = detectAutopilotSuitabilityMarker(issue?.body, prefix);
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
        `autopilot-suitability: issue #${number} is scored 1 (human-only) but is missing the status:blocked-by-human label`,
      );
    } else if (
      marker.value !== null &&
      marker.value > 1 &&
      marker.value >= floor &&
      blockedByHuman
    ) {
      warnings.push(
        `autopilot-suitability: issue #${number} is scored ${marker.value} (>= floor ${floor}) but carries status:blocked-by-human; the score and label disagree`,
      );
    }
  }
  return { warnings };
}
function detectAutopilotSuitabilityMarker(body, prefix) {
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-autopilot-suitability:\\s*([^\\s>]+)\\s*-->`,
    'gi',
  );
  const raws = [...String(body ?? '').matchAll(regex)].map((match) => match[1]);
  if (raws.length === 0) {
    return { present: false, value: null, malformed: false };
  }
  const values = raws.map((raw) =>
    /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN,
  );
  const distinct = new Set(values);
  if (!values.every(isAutopilotSuitabilityScore) || distinct.size !== 1) {
    return { present: true, value: null, malformed: true };
  }
  return { present: true, value: [...distinct][0], malformed: false };
}
function checkAutopilotSuitabilityConsistency(root, options, report) {
  const requireGithub = options.requireGithub === true;
  const recordGhFailure = (message) => {
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
  let issues;
  try {
    issues = JSON.parse(list.stdout);
  } catch {
    recordGhFailure('gh issue list returned invalid JSON');
    return;
  }
  if (!Array.isArray(issues) || issues.length === 0) {
    return;
  }
  let floor;
  try {
    const config = JSON.parse(
      readFileSync(join(root, '.github/idd/config.json'), 'utf8'),
    );
    floor = config?.autopilotSuitability?.floor;
  } catch {
    floor = undefined;
  }
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor,
    markerPrefix: options.markerPrefix,
  });
  for (const warning of warnings) {
    report.warnings.push(warning);
  }
}
export function parsePrimaryWorktreePath(porcelain) {
  const lines = porcelain.split('\n');
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
function branchGlobToRegExp(pattern) {
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
  branch,
  patterns = DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
) {
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
export function findPlaceholders(text) {
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
export function scanFileForPlaceholders(file, text) {
  const documentsPlaceholders =
    file.startsWith('docs/') && file.endsWith('.md');
  return findPlaceholders(
    documentsPlaceholders ? stripMarkdownNonText(text) : text,
  );
}
export function extractMarkerPrefixes(text) {
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
function checkRequiredFiles(_files, report) {
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
function checkPlaceholders(root, files, report) {
  const distributionSource =
    exists(join(root, 'idd-template/ONBOARDING.md')) &&
    exists(join(root, 'audit/sync-manifest.json'));
  const excludedPrefixes = [
    'idd-template/',
    'fixtures/',
    'tests/fixtures/',
    'tests/',
    '.git/',
  ];
  if (distributionSource) {
    excludedPrefixes.push('.github/instructions/', 'audit/');
  }
  const hits = [];
  for (const file of files) {
    if (excludedPrefixes.some((prefix) => file.startsWith(prefix))) {
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
function checkMarkerPrefixes(root, report) {
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
  discoverPrefixes,
  overviewPrefixes,
) {
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
  const consistent = (left, right) =>
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
function checkProjectCommands(root, report) {
  const path = join(
    root,
    '.github/instructions/idd-overview-core.instructions.md',
  );
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    report.errors.push(
      'cannot read .github/instructions/idd-overview-core.instructions.md',
    );
    return null;
  }
  const commands = parseProjectCommandRows(text);
  const requiredRows = [
    'fix-validate',
    'pre-push-validate',
    'post-fix-validate',
    'install-deps',
  ];
  const missingRows = requiredRows.filter((row) => !commands.has(row));
  if (missingRows.length > 0) {
    report.errors.push(
      `project commands table is missing rows: ${missingRows.join(', ')}`,
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
  root,
  markerPrefix,
  projectCommands,
  report,
) {
  if (!(projectCommands instanceof Map)) {
    return;
  }
  const policyCommands = loadPolicyCommands(root);
  const policyCommandMap =
    policyCommands instanceof Map ? policyCommands : new Map();
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
  const residueMessages = new Set();
  for (const [source, commands] of [
    ['.github/idd/config.json', policyCommandMap],
    ['overview project commands table', projectCommands],
  ]) {
    for (const [key, value] of commands.entries()) {
      const normalized = normalizeCommandValue(value);
      if (normalized === null) {
        continue;
      }
      const token = findToolchainResidueToken(normalized);
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
function loadPolicyCommands(root) {
  const configPath = join(root, '.github/idd/config.json');
  if (!exists(configPath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
  const commands = parsed?.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    return null;
  }
  return new Map(
    Object.entries(commands).filter((entry) => typeof entry[1] === 'string'),
  );
}
function normalizeCommandValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim();
}
function isConcreteCommandValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    return false;
  }
  return !/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/.test(value);
}
function findToolchainResidueToken(value) {
  for (const token of ['dprint', 'markdownlint-cli2', 'cspell']) {
    if (new RegExp(`\\b${escapeRegex(token)}\\b`, 'i').test(value)) {
      return token;
    }
  }
  return null;
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function checkPolicySignals(root, report) {
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
function checkHelperRuntimeConfig(root, report) {
  const candidates = ['.github/idd/config.json', 'idd-policy.json'];
  for (const file of candidates) {
    const absolutePath = join(root, file);
    if (!exists(absolutePath)) {
      continue;
    }
    let config;
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
function checkAgentEntryFiles(root, report) {
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
function checkTemplateVersionSignal(root, report) {
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
export function readWorktreeGuardEnabled(root) {
  try {
    const config = JSON.parse(
      readFileSync(join(root, '.github/idd/config.json'), 'utf8'),
    );
    return config?.worktreeGuard?.enabled === true;
  } catch {
    return false;
  }
}
/**
 * Read `worktreeGuard.branchPatterns` from the repo config, falling back
 * to the default implementation-branch globs when the key is absent,
 * empty, or malformed. Matches the core.hooksPath hook so idd-doctor and
 * the hook agree on which branches the guard covers.
 */
export function readWorktreeGuardBranchPatterns(root) {
  try {
    const config = JSON.parse(
      readFileSync(join(root, '.github/idd/config.json'), 'utf8'),
    );
    const patterns = config?.worktreeGuard?.branchPatterns;
    if (
      Array.isArray(patterns) &&
      patterns.length > 0 &&
      patterns.every((p) => typeof p === 'string' && p.trim().length > 0)
    ) {
      return patterns;
    }
  } catch {
    // fall through to defaults
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
export function findMissingWorktreeHardening({ work, core, doctor } = {}) {
  const missing = [];
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
function checkWorktreeHardeningPresence(root, report) {
  const read = (relativePath) => {
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
function checkPrimaryWorktreeHead(root, report, options = {}) {
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
  classification,
  branch,
  primaryPath,
  enforce,
) {
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
export function computeWindowStartIso(now, windowDays) {
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
export function classifyBacklog(missingPrNumbers, warnThreshold) {
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
      ? missingPrNumbers.slice(0, 5)
      : [],
  };
}
function checkPostMergeCleanupBacklog(root, options, report) {
  const windowDays = options.windowDays;
  const warnThreshold = options.warnThreshold;
  const requireGithub = options.requireGithub === true;
  // Soft GitHub-API failures (gh missing, no token, repo view fails,
  // pr list fails) are silent by default — same pattern as the other
  // doctor GitHub-readiness checks — and only surface as errors when
  // the operator passed --require-github. Per-PR evidence-fetch
  // failures are still always reported because they materially change
  // the backlog count.
  const recordGhFailure = (message) => {
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
  let parsed;
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
      'number',
      '--limit',
      '1000',
    ],
    root,
  );
  if (!search.ok) {
    recordGhFailure(`merged-PR list query failed for ${owner}/${repo}`);
    return;
  }
  let mergedPrs;
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
  const missing = [];
  const evidenceFailures = [];
  for (const pr of mergedPrs) {
    const number = pr?.number;
    if (!Number.isInteger(number)) {
      continue;
    }
    const evidence = runCommand(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/issues/${number}/comments`,
        '--jq',
        '.[] | select(.body | startswith("<!-- idd-cleanup-evidence:")) | .id',
      ],
      root,
    );
    if (!evidence.ok) {
      evidenceFailures.push(number);
      continue;
    }
    const matchLines = String(evidence.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (matchLines.length === 0) {
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
  const examplesText = verdict.examples.map((n) => `#${n}`).join(', ');
  report.warnings.push(
    `post-merge cleanup backlog: ${verdict.count} merged PRs in the last ${windowDays} days lack F4 cleanup evidence (warn threshold: ${warnThreshold}). Examples: ${examplesText}. Remediation: see docs/idd-comment-minimization.md or run \`node scripts/audit-pr-cleanup.mjs --pr <N> --apply --skip-claim-check\`.`,
  );
}
export function findMissingWorkshopReferences(entryFiles, allowMissing) {
  const allowSet = new Set(
    (Array.isArray(allowMissing) ? allowMissing : []).map((path) =>
      String(path),
    ),
  );
  const missing = [];
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
export function containsWorkshopReference(content) {
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
  let match;
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
function stripFencedCodeBlocks(content) {
  const lines = String(content).split(/\r?\n/);
  const out = [];
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
function matchesWorkshopPath(target) {
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
function checkWorkshopCrossReferences(root, options, report) {
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
export function backLinkPatternFor(repoSlug) {
  const escSlug = String(repoSlug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^/${escSlug}/(?:[^?#]*?/)?docs/workshop(?:/|$|[?#])`, 'i');
}
export function stripMarkdownNonText(content) {
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
  let prev;
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
function stripFencesPreservingLines(content) {
  const lines = String(content).split(/\r?\n/);
  const out = [];
  let fence = null;
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
// CommonMark §4.4 indented code blocks: at least 4 leading spaces
// (or one tab), preceded by a blank line. Indented lines that are
// recognizable list items (`-`, `*`, `+`, or `\d+\.` after the
// leading whitespace) stay as text — loose-list nested items can
// otherwise be misread as code. We only blank lines that follow a
// blank or already-blanked line and do not look like list items.
function stripIndentedCodeBlocksPreservingLines(content) {
  const lines = String(content).split(/\r?\n/);
  const out = [];
  let prevBlank = true;
  let inBlock = false;
  for (const line of lines) {
    const isBlank = /^\s*$/.test(line);
    const indented = /^(?: {4}|\t)/.test(line);
    // CommonMark §5.2: ordered-list markers may use either `.` or
    // `)` after the digit. Both shapes count as list items (not
    // code) even when indented under a parent item.
    const looksLikeListItem = /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line);
    if (isBlank) {
      out.push(line);
      prevBlank = true;
      inBlock = false;
      continue;
    }
    if (indented && (prevBlank || inBlock) && !looksLikeListItem) {
      out.push('');
      inBlock = true;
      prevBlank = false;
      continue;
    }
    out.push(line);
    inBlock = false;
    prevBlank = false;
  }
  return out.join('\n');
}
export function containsExampleRepoBackLink(readmeContent, repoSlug) {
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
  const stripped = imagedStripped;
  // Absolute http(s) URLs.
  const urlPattern = /https?:\/\/[^\s<>)\]"']+/gi;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = urlPattern.exec(stripped)) !== null) {
    const token = match[0].replace(/[.,;:!?]+$/, '');
    let url;
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
export function isGithubBackLinkHost(host) {
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
export function decodeGithubReadmeBase64(content) {
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
  let decoded;
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
function checkWorkshopExampleRepoBackLink(root, options, report) {
  const requireGithub = options.requireGithub === true;
  const workshopDir = resolve(root, WORKSHOP_REL_PATH);
  if (!existsSync(workshopDir)) return;
  const configPath = resolve(root, '.github/idd/config.json');
  if (!existsSync(configPath)) return;
  let config;
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
  const recordSoftFailure = (message) => {
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
  let viewer;
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
function checkGithubReadiness(root, requireGithub, report) {
  const repoView = runCommand(
    'gh',
    ['repo', 'view', '--json', 'owner,name,defaultBranchRef'],
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
  let parsed;
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
  const protection = runCommand(
    'gh',
    ['api', `repos/${owner}/${repo}/branches/${branch}/protection`],
    root,
  );
  if (!protection.ok) {
    const message = `branch protection not readable for ${owner}/${repo}:${branch}`;
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }
  let protectionJson;
  try {
    protectionJson = JSON.parse(protection.stdout);
  } catch {
    const message = 'branch protection response is not valid JSON';
    if (requireGithub) {
      report.errors.push(message);
    } else {
      report.warnings.push(message);
    }
    return;
  }
  const requiredChecks = protectionJson.required_status_checks?.contexts ?? [];
  const strict = protectionJson.required_status_checks?.strict ?? false;
  if (requiredChecks.length === 0) {
    report.warnings.push(
      `branch protection is enabled but no required status checks are configured on ${branch}`,
    );
  } else {
    report.passes.push(
      `required status checks configured on ${branch} (${requiredChecks.length}, strict=${strict})`,
    );
  }
  const reviewConfig = protectionJson.required_pull_request_reviews;
  if (!reviewConfig) {
    report.warnings.push(
      `required pull request reviews are not configured on ${branch}`,
    );
  } else {
    report.passes.push('required pull request review policy is configured');
  }
}
function runCommand(command, argv, cwd) {
  try {
    const stdout = execFileSync(command, argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    const candidate = error;
    return {
      ok: false,
      code: candidate.status,
      stderr: candidate.stderr?.toString?.() ?? '',
    };
  }
}
function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    json: false,
    help: false,
    requireGithub: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--require-github') {
      args.requireGithub = true;
      continue;
    }
    if (arg === '--strict') {
      args.strict = true;
      continue;
    }
    if (arg === '--repo-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo-root requires a value');
      }
      args.root = value;
      index += 1;
      continue;
    }
    if (arg === '--cleanup-backlog-window-days') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--cleanup-backlog-window-days requires a value');
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error(
          `--cleanup-backlog-window-days must be a positive finite number (got "${value}")`,
        );
      }
      args.cleanupBacklogWindowDays = numeric;
      index += 1;
      continue;
    }
    if (arg === '--cleanup-backlog-warn-threshold') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--cleanup-backlog-warn-threshold requires a value');
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error(
          `--cleanup-backlog-warn-threshold must be a non-negative finite number (got "${value}")`,
        );
      }
      args.cleanupBacklogWarnThreshold = numeric;
      index += 1;
      continue;
    }
    if (arg === '--workshop-cross-ref-allow-missing') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--workshop-cross-ref-allow-missing requires a value');
      }
      args.workshopCrossRefAllowMissing = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}
function printHumanReport(report) {
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
  --workshop-cross-ref-allow-missing <list> comma-separated entry-point paths to skip in the workshop cross-reference check (default: none)
  --help, -h                               show this help

The merged-PR backlog scan caps at gh's per-query maximum of 1000
results; repositories with > 1000 merged PRs in the window get a
representative sample. The check makes one gh api .../comments
call per merged PR returned, which is intentionally simple — for
very large or rate-limited repos consider raising the warn
threshold or shortening the window.
`);
}
function listFiles(root) {
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
function walk(directory) {
  const entries = [];
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
function exists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isTextLikeFile(file) {
  return /\.(md|txt|yml|yaml|json|mjs|js|ts|sh)$/.test(file);
}
function unique(values) {
  return [...new Set(values)];
}
function sameMembers(left, right) {
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
function isMainModule(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(moduleUrl) === resolve(process.argv[1]);
}
// Run as a CLI only after the whole module (including consts used by the
// checks above) has finished evaluating. Keeping this block at the end of
// the file avoids a temporal-dead-zone crash when runDoctor reaches a check
// that reads a `const` declared later in the file.
if (isMainModule(import.meta.url)) {
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
