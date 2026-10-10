#!/usr/bin/env node
// idd-generated-from: src/scripts/repository-instruction-audit.mts
//
// The scripts/repository-instruction-audit.mjs copy is generated from this
// source by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './node-runtime-guard.mjs';

const SHARED_TOP_LEVEL_SECTIONS = [
  '## Minimum requirements',
  '## Project standards',
  '## Key workflow rules',
  '## For IDD work',
];
const SPECIFICITY_SECTIONS = [
  '## Specificity target',
  '## Dependency minimization',
  '## Nested roadmap nodes',
  '## Human-dependency isolation',
  '## Hidden human-dependency validation',
];
const SPECIFICITY_NEEDLES = {
  '## Specificity target': [
    '## Specificity target',
    '### Three specificity bands',
    '**Under-specified**',
    '**Target**',
    '**Over-specified**',
    'frontier cloud model class',
    'middle-tier cloud model class',
    'lightweight local or compact cloud model class',
    '"ready and stable for a middle-tier model," not "maximally detailed."',
  ],
  '## Nested roadmap nodes': [
    'coordination boundary, active child list, or multi-session handoff',
    'roadmap node, not a normal execution candidate',
    'parent roadmap task list',
    'links the active child work it coordinates',
    'normal A3/A4/A5 execution work',
    'true execution dependencies or sequential roadmap dependencies',
    'closed intermediate roadmaps with hidden open descendants',
  ],
  '## Human-dependency isolation': [
    'Treat unresolved human dependency as a side effect',
    '**Front-load** human-dependent work',
    '**Back-load** human-dependent work',
    'maintainer-only action',
    'unavailable system becomes usable again',
    'Route unresolved choices to `needs-decision`',
    '`blocked-by-human`',
    '`deferred`',
    'approval-needed hold',
    'it is not yet `ready`',
    'protect autonomous completion and clear verification',
  ],
  '## Hidden human-dependency validation': [
    'routing aid, not a rigid wording linter',
    'credentials, external access, hardware, or infrastructure',
    '`blocked-by-human`',
    'product, policy, or design decision',
    '`needs-decision`',
    'subjective human approval',
    'objective verification',
    'optional review or publication judgment',
    'roadmap narrative',
    'approval-needed hold',
    'dependency marker',
    'true start blockers',
    'post-implementation code review, merge approval, or publication choice',
  ],
  '## Dependency minimization': [
    'true correctness, availability, or ordering constraint',
    'roadmap task-list entries',
    'artificial serial chain',
    'artificial sibling issues only to widen parallel execution',
    'justify each dependency edge',
    'natural cohesion',
  ],
};
function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, ' ').trim();
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJsonObject(text, path, ruleId, report) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    report(ruleId, path, 'must contain valid JSON');
    return null;
  }
  if (!isRecord(value)) {
    report(ruleId, path, 'must contain a JSON object');
    return null;
  }
  return value;
}
function onboardingPlaceholder(name) {
  return `{{${name}}}`;
}
function findLineMarker(text, marker, fromIndex = 0) {
  const pattern = new RegExp(
    `^ {0,3}${escapeRegExp(marker)}[ \\t]*\\r?$`,
    'gmu',
  );
  pattern.lastIndex = fromIndex;
  return pattern.exec(text)?.index ?? -1;
}
function findSectionMarker(text, marker, fromIndex = 0) {
  return /^#{1,6} /u.test(marker)
    ? findLineMarker(text, marker, fromIndex)
    : text.indexOf(marker, fromIndex);
}
function stripGeneratedFromBanner(value) {
  return value.replace(/^<!-- idd-generated-from:\n[\s\S]*?-->\n\n/u, '');
}
function extractSection(text, file, startMarker, endMarker, report, ruleId) {
  const start = findSectionMarker(text, startMarker);
  if (start === -1) {
    report(
      ruleId,
      file,
      `missing section marker ${JSON.stringify(startMarker)}`,
    );
    return null;
  }
  const end = findSectionMarker(text, endMarker, start + startMarker.length);
  if (end === -1) {
    report(ruleId, file, `missing section marker ${JSON.stringify(endMarker)}`);
    return null;
  }
  return text.slice(start, end);
}
function extractTopLevelSection(text, file, marker, report, ruleId) {
  const start = findLineMarker(text, marker);
  if (start === -1) {
    report(ruleId, file, `missing section marker ${JSON.stringify(marker)}`);
    return null;
  }
  const nextHeading = /^ {0,3}## [^\r\n]*\r?$/gmu;
  nextHeading.lastIndex = start + marker.length;
  const next = nextHeading.exec(text)?.index ?? -1;
  return text.slice(start, next === -1 ? text.length : next).trim();
}
export function collectRepositoryInstructionViolations(root, readTextOverride) {
  const violations = [];
  const contents = new Map();
  const reportedMissing = new Set();
  const report = (ruleId, path, message) => {
    violations.push({ ruleId, path, message });
  };
  const readText = (path) => {
    const cached = contents.get(path);
    if (cached !== undefined) return cached;
    try {
      const text = readTextOverride
        ? readTextOverride(path)
        : readFileSync(resolve(root, path), 'utf8');
      contents.set(path, text);
      return text;
    } catch (error) {
      if (!reportedMissing.has(path)) {
        reportedMissing.add(path);
        report(
          'repository-instruction.required-file',
          path,
          `cannot read required file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      contents.set(path, '');
      return '';
    }
  };
  const has = (ruleId, path, text, expected) => {
    if (!text.includes(expected)) {
      report(ruleId, path, `missing required text ${JSON.stringify(expected)}`);
    }
  };
  const matches = (ruleId, path, text, pattern, message) => {
    if (!pattern.test(text)) report(ruleId, path, message);
  };
  const excludes = (ruleId, path, text, pattern, message) => {
    if (pattern.test(text)) report(ruleId, path, message);
  };
  const equal = (ruleId, path, left, right, message) => {
    if (left !== right) report(ruleId, path, message);
  };
  auditAgentEntry(readText, report, has, matches, excludes);
  auditApprovalGate(readText, report, has, matches, equal);
  auditSpecificity(readText, report, has, equal);
  auditCompanionPaths(readText, report, has, matches, excludes);
  auditNonNodeFallback(readText, report, has, matches, excludes);
  auditWorkflowMap(readText, report, has, matches, equal);
  auditPnpmBoundary(readText, excludes);
  auditGeneratedImportAnchor(readText, report, has, matches);
  return violations;
}
function auditAgentEntry(readText, report, has, matches, excludes) {
  const agentsPath = 'AGENTS.md';
  const agents = readText(agentsPath);
  for (const marker of [
    ...SHARED_TOP_LEVEL_SECTIONS,
    '## Branch strategy',
    '## Commit rules',
    '## Dogfood: token-cost events',
    '## Issue-authoring skill (dogfooded)',
    '## Codex issue-authoring route',
  ]) {
    if (findLineMarker(agents, marker) === -1) {
      report(
        'agent-entry.canonical-sections',
        agentsPath,
        `missing top-level section marker ${JSON.stringify(marker)}`,
      );
    }
  }
  const standards = extractTopLevelSection(
    agents,
    agentsPath,
    '## Project standards',
    report,
    'agent-entry.helper-source-rule',
  );
  if (standards !== null) {
    matches(
      'agent-entry.helper-source-rule',
      agentsPath,
      standards,
      /\*\*Helper sources\*\*: the helper migration to TypeScript is complete/u,
      'Project standards must keep the helper TypeScript source-of-truth rule',
    );
    has(
      'agent-entry.helper-source-rule',
      agentsPath,
      standards,
      'See [docs/typescript-sources.md](docs/typescript-sources.md).',
    );
  }
  const adapterFiles = ['CLAUDE.md', 'GEMINI.md'];
  for (const file of adapterFiles) {
    const text = readText(file);
    matches(
      'agent-entry.adapters',
      file,
      text,
      /^@AGENTS\.md$/mu,
      'must contain a standalone @AGENTS.md import line',
    );
    for (const marker of SHARED_TOP_LEVEL_SECTIONS) {
      excludes(
        'agent-entry.adapters',
        file,
        text,
        new RegExp(escapeRegExp(marker), 'u'),
        `must not restate ${marker}`,
      );
    }
    if (text.split('\n').length >= 40) {
      report(
        'agent-entry.adapters',
        file,
        `must stay a short adapter (got ${text.split('\n').length} lines; expected fewer than 40)`,
      );
    }
  }
  const claude = readText('CLAUDE.md');
  has('agent-entry.claude-delta', 'CLAUDE.md', claude, 'Claude Code');
  matches(
    'agent-entry.claude-delta',
    'CLAUDE.md',
    claude,
    /In Claude Code specifically,[^.]*--vendor claude/u,
    'must keep --vendor claude scoped to Claude Code',
  );
  matches(
    'agent-entry.claude-delta',
    'CLAUDE.md',
    claude,
    /\.claude\/skills\/issue-authoring\//u,
    'must retain the .claude/skills auto-discovery note',
  );
  excludes(
    'agent-entry.claude-delta',
    'CLAUDE.md',
    claude,
    /Antigravity/u,
    'must not name Antigravity',
  );
  const gemini = readText('GEMINI.md');
  has('agent-entry.gemini-delta', 'GEMINI.md', gemini, 'Antigravity');
  matches(
    'agent-entry.gemini-delta',
    'GEMINI.md',
    gemini,
    /vendor/iu,
    'must keep the token-cost vendor-skip note',
  );
  excludes(
    'agent-entry.gemini-delta',
    'GEMINI.md',
    gemini,
    /Claude/u,
    'must not name Claude',
  );
  excludes(
    'agent-entry.gemini-delta',
    'GEMINI.md',
    gemini,
    /\.claude\/skills\//u,
    'must not carry Claude-only skills details',
  );
  const copilotPath = '.github/copilot-instructions.md';
  const copilot = readText(copilotPath);
  excludes(
    'agent-entry.copilot-adapter',
    copilotPath,
    copilot,
    /canonical, fully detailed/u,
    'must not claim to be the canonical fully detailed guide',
  );
  matches(
    'agent-entry.copilot-adapter',
    copilotPath,
    copilot,
    /^## Commit rules$/mu,
    'must keep a Commit rules heading for the CONTRIBUTING fragment',
  );
  matches(
    'agent-entry.copilot-adapter',
    copilotPath,
    copilot,
    /AGENTS\.md#commit-rules/u,
    'Commit rules section must point at AGENTS.md#commit-rules',
  );
  for (const marker of SHARED_TOP_LEVEL_SECTIONS) {
    excludes(
      'agent-entry.copilot-adapter',
      copilotPath,
      copilot,
      new RegExp(escapeRegExp(marker), 'u'),
      `must not restate ${marker}`,
    );
  }
}
function auditApprovalGate(readText, report, has, matches, equal) {
  const discoverPath = '.github/instructions/idd-discover.instructions.md';
  const discover = readText(discoverPath);
  for (const needle of [
    'approval-needed fallback bucket',
    'skipIssueAuthorApprovalGate',
    'maintainerApprovalActorPolicy',
    'owners-and-maintainers-only',
    'all-write-permission-actors',
    'visible approval comment',
    'IDD ready',
    'bare organization `MEMBER` association',
    'stop before A5',
  ]) {
    has('approval-gate.discover', discoverPath, discover, needle);
  }
  matches(
    'approval-gate.discover',
    discoverPath,
    discover,
    /do not auto-claim from the fallback[\s\S]*bucket/iu,
    'must not auto-claim from the approval-needed fallback bucket',
  );
  equalSections(
    readText,
    report,
    equal,
    'approval-gate.mirror-sections',
    '.github/instructions/idd-discover.instructions.md',
    'idd-template/.github/instructions/idd-discover.instructions.md',
    '## A3.5 — Apply issue-author approval gate',
    '## A4 — Gate, then pick',
    'Discover A3.5 approval instructions must match the template section',
  );
  equalSections(
    readText,
    report,
    equal,
    'approval-gate.mirror-sections',
    '.github/instructions/idd-claim.instructions.md',
    'idd-template/.github/instructions/idd-claim.instructions.md',
    '**(a) Issue-author approval gate**',
    '**(b) Assignee and project status**',
    'Claim approval pre-check must match the template section',
    (section) =>
      section.includes('stop without') && section.includes('claiming'),
  );
  const claimPath = '.github/instructions/idd-claim.instructions.md';
  const claimSection = getSection(
    readText,
    report,
    'approval-gate.claim-stop',
    claimPath,
    '**(a) Issue-author approval gate**',
    '**(b) Assignee and project status**',
  );
  if (claimSection !== null) {
    matches(
      'approval-gate.claim-stop',
      claimPath,
      claimSection,
      /bare organization `MEMBER` association/u,
      'must preserve the organization MEMBER distinction',
    );
  }
  const suitabilityPath =
    '.github/instructions/idd-suitability.instructions.md';
  const suitability = readText(suitabilityPath);
  has(
    'approval-gate.suitability-separation',
    suitabilityPath,
    suitability,
    'Issue-author approval is a separate pre-claim gate.',
  );
  auditSuitabilityPair(readText, report, has);
  const configPath = '.github/idd/config.json';
  const configText = readText(configPath);
  const config = parseJsonObject(
    configText,
    configPath,
    'approval-gate.config',
    report,
  );
  const skipIssueAuthorApprovalGate = config?.skipIssueAuthorApprovalGate;
  if (
    skipIssueAuthorApprovalGate !== undefined &&
    typeof skipIssueAuthorApprovalGate !== 'boolean'
  ) {
    report(
      'approval-gate.config',
      configPath,
      'skipIssueAuthorApprovalGate must be a boolean',
    );
  }
  if (skipIssueAuthorApprovalGate === true) {
    report(
      'approval-gate.config',
      configPath,
      'issue-author approval gate must remain enabled by default',
    );
  }
  const overviewPath = '.github/instructions/idd-overview-core.instructions.md';
  const overview = readText(overviewPath);
  const templateOverviewPath =
    'idd-template/.github/instructions/idd-overview-core.instructions.md';
  const templateOverview = readText(templateOverviewPath);
  for (const [path, text] of [
    [overviewPath, overview],
    [templateOverviewPath, templateOverview],
  ]) {
    has(
      'approval-gate.secure-default',
      path,
      text,
      'skipIssueAuthorApprovalGate',
    );
    has(
      'approval-gate.secure-default',
      path,
      text,
      'maintainerApprovalActorPolicy',
    );
    matches(
      'approval-gate.secure-default',
      path,
      text,
      /Absent values keep the gate\s+enabled and default approval actors to\s+`owners-and-maintainers-only`\./u,
      'must document the enabled-by-default secure actor policy',
    );
  }
  const customizationPath = 'docs/customization.md';
  const templateCustomizationPath = 'idd-template/docs/customization.md';
  equalSections(
    readText,
    report,
    equal,
    'approval-gate.safety-invariants',
    customizationPath,
    templateCustomizationPath,
    '## Non-Configurable Safety Invariants',
    '## Helper Runtime Profile',
    'Customization safety invariant section must match the template',
  );
  const customization = getSection(
    readText,
    report,
    'approval-gate.safety-invariants',
    customizationPath,
    '## Non-Configurable Safety Invariants',
    '## Helper Runtime Profile',
  );
  if (customization !== null) {
    for (const needle of [
      'Claim revalidation still runs before every mutating side effect.',
      'Marker-shaped comments from untrusted authors never gain authority.',
      'Forced handoff remains human-gated only.',
    ]) {
      has(
        'approval-gate.safety-invariants',
        customizationPath,
        customization,
        needle,
      );
    }
    matches(
      'approval-gate.safety-invariants',
      customizationPath,
      customization,
      /Approval-needed fallback issues remain a stop condition for unattended[\s\S]*discovery\./u,
      'must keep approval-needed fallback issues as a discovery stop condition',
    );
  }
  const policyPath = 'docs/policy-constants.md';
  const templatePolicyPath = 'idd-template/docs/policy-constants.md';
  equalSections(
    readText,
    report,
    equal,
    'approval-gate.safety-invariants',
    policyPath,
    templatePolicyPath,
    '## Non-Configurable Safety Invariants',
    '## Forced Handoff Defaults',
    'Policy safety invariant section must match the template',
  );
  const policy = getSection(
    readText,
    report,
    'approval-gate.safety-invariants',
    policyPath,
    '## Non-Configurable Safety Invariants',
    '## Forced Handoff Defaults',
  );
  if (policy !== null) {
    for (const needle of [
      'These rules are fixed gates, not policy knobs',
      'Claim revalidation gate',
      'Marker trust / authority',
      'Forced handoff initiator',
      'Approval-needed fallback',
    ]) {
      has('approval-gate.safety-invariants', policyPath, policy, needle);
    }
  }
}
function auditSuitabilityPair(readText, report, has) {
  const manifestPath = 'audit/sync-manifest.json';
  const targetPath = '.github/instructions/idd-suitability.instructions.md';
  const templatePath =
    'idd-template/.github/instructions/idd-suitability.instructions.md';
  const manifest = parseJsonObject(
    readText(manifestPath),
    manifestPath,
    'approval-gate.suitability-pair',
    report,
  );
  if (manifest === null) return;
  const syncPairs = manifest.syncPairs;
  if (!Array.isArray(syncPairs)) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'syncPairs must be an array',
    );
    return;
  }
  if (
    syncPairs.some((entry) => !isRecord(entry) || typeof entry.id !== 'string')
  ) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'syncPairs entries must be objects with string ids',
    );
    return;
  }
  const syncPairEntries = syncPairs;
  const pair = syncPairEntries.find(
    (entry) => entry.id === 'idd-suitability-instructions',
  );
  if (!pair) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'is missing the idd-suitability-instructions sync pair',
    );
    return;
  }
  const replacements = pair.replacements;
  if (replacements !== undefined && !Array.isArray(replacements)) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'idd-suitability-instructions replacements must be an array',
    );
    return;
  }
  const replacementEntries = Array.isArray(replacements) ? replacements : [];
  if (
    replacementEntries.some(
      (replacement) =>
        !isRecord(replacement) ||
        typeof replacement.from !== 'string' ||
        typeof replacement.to !== 'string',
    )
  ) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'idd-suitability-instructions has a malformed replacement entry',
    );
    return;
  }
  if (pair.mode !== 'concreted') {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'idd-suitability-instructions must stay in concreted mode',
    );
  }
  if (pair.source !== templatePath || pair.target !== targetPath) {
    report(
      'approval-gate.suitability-pair',
      manifestPath,
      'must keep the canonical template source and live target paths',
    );
  }
  const source = readText(templatePath);
  const expected = replacementEntries.reduce((text, replacement) => {
    const entry = replacement;
    return text.split(entry.from).join(entry.to);
  }, source);
  const actual = stripGeneratedFromBanner(readText(targetPath));
  if (expected !== actual) {
    report(
      'approval-gate.suitability-pair',
      targetPath,
      'must equal the template after manifest replacements and generated-banner removal',
    );
  }
  if (expected.includes(onboardingPlaceholder('PROJECT_MARKER_PREFIX'))) {
    report(
      'approval-gate.suitability-pair',
      targetPath,
      'concreted output must not retain the project marker placeholder',
    );
  }
  const configPath = '.github/idd/config.json';
  const config = parseJsonObject(
    readText(configPath),
    configPath,
    'approval-gate.suitability-pair',
    report,
  );
  const markerPrefix = config?.markerPrefix;
  if (typeof markerPrefix !== 'string' || markerPrefix.length === 0) {
    report(
      'approval-gate.suitability-pair',
      configPath,
      'is missing markerPrefix',
    );
  } else if (!expected.includes(`${markerPrefix}-autopilot-suitability`)) {
    report(
      'approval-gate.suitability-pair',
      targetPath,
      `concreted output must use the configured markerPrefix ${JSON.stringify(markerPrefix)}`,
    );
  }
  has(
    'approval-gate.suitability-pair',
    targetPath,
    actual,
    'Issue-author approval is a separate pre-claim gate.',
  );
}
function auditSpecificity(readText, report, has, equal) {
  const canonicalPath = 'docs/issue-authoring-skill.md';
  const contractPath = 'skills/issue-authoring/references/contract.md';
  const canonical = readText(canonicalPath);
  const contract = readText(contractPath);
  for (const heading of SPECIFICITY_SECTIONS) {
    const left = extractTopLevelSection(
      canonical,
      canonicalPath,
      heading,
      report,
      'issue-authoring.section-mirror',
    );
    const right = extractTopLevelSection(
      contract,
      contractPath,
      heading,
      report,
      'issue-authoring.section-mirror',
    );
    if (left !== null && right !== null) {
      equal(
        'issue-authoring.section-mirror',
        contractPath,
        left,
        right,
        `${heading} must match between the canonical doc and bundled contract`,
      );
    }
  }
  for (const file of [canonicalPath, contractPath]) {
    const text = readText(file);
    for (const [heading, needles] of Object.entries(SPECIFICITY_NEEDLES)) {
      const section = extractTopLevelSection(
        text,
        file,
        heading,
        report,
        'issue-authoring.specificity-content',
      );
      if (section === null) continue;
      const normalized = normalizeWhitespace(section);
      for (const needle of needles) {
        has(
          'issue-authoring.specificity-content',
          file,
          normalized,
          normalizeWhitespace(needle),
        );
      }
    }
  }
  const draftPath = 'skills/issue-authoring/references/draft-patterns.md';
  const draft = normalizeWhitespace(readText(draftPath));
  for (const needle of [
    '## Hidden human-dependency quick check',
    'unresolved credentials, access, or unavailable infrastructure',
    '`needs-decision`',
    'objective verification',
    'optional post-implementation review stays optional',
    'approval-needed hold',
    'true start blockers rather than grouping related work',
    'subjective approval',
    'grouping-only dependency markers',
  ]) {
    has(
      'issue-authoring.draft-patterns',
      draftPath,
      draft,
      normalizeWhitespace(needle),
    );
  }
  for (const needle of [
    '## Nested roadmap chooser note',
    'Parent roadmap `## Tracks` excerpt:',
    'Nested roadmap `#510` `## Tracks` excerpt:',
    'coordination/audit node',
    'normal execution issue',
    '## Dependency minimization examples',
    '### Natural parallel decomposition',
    '### Artificial decomposition',
    'Bad serial chain:',
    'Bad split for parallelism:',
  ]) {
    has(
      'issue-authoring.draft-patterns',
      draftPath,
      draft,
      normalizeWhitespace(needle),
    );
  }
  const checklistPath = 'docs/issue-authoring-skill.md';
  const checklist = normalizeWhitespace(readText(checklistPath));
  for (const needle of [
    'each nested roadmap node is linked from the parent roadmap task list and links its own active child work',
    'each nested roadmap remains identifiable as a coordination/audit node instead of a normal execution candidate',
    'used only for true sequential dependencies, never to group nested roadmap children',
  ]) {
    has(
      'issue-authoring.validation-checklist',
      checklistPath,
      checklist,
      normalizeWhitespace(needle),
    );
  }
  for (const file of [canonicalPath, contractPath]) {
    const text = readText(file);
    for (const needle of [
      'acceptance criteria are locally verifiable',
      'any dependency marker is resolvable, intentionally chosen, and',
      'the issue can be claimed independently without absorbing sibling work',
    ]) {
      has('issue-authoring.child-validation', file, text, needle);
    }
  }
}
function auditCompanionPaths(readText, report, has, matches, excludes) {
  const distributionPath =
    'idd-template/docs/onboarding/template-distribution.md';
  const distribution = readText(distributionPath);
  const extractShellList = (id) => {
    const marker = `<!-- audit:shell-list id=${id} -->`;
    const markerIndex = distribution.indexOf(marker);
    if (markerIndex === -1) {
      report(
        'onboarding.companion-paths',
        distributionPath,
        `missing shell-list marker ${id}`,
      );
      return '';
    }
    const fenceStart = distribution.indexOf('```sh', markerIndex);
    if (fenceStart === -1) {
      report(
        'onboarding.companion-paths',
        distributionPath,
        `missing shell block for ${id}`,
      );
      return '';
    }
    const fenceEnd = distribution.indexOf('\n```', fenceStart);
    if (fenceEnd === -1) {
      report(
        'onboarding.companion-paths',
        distributionPath,
        `unterminated shell block for ${id}`,
      );
      return '';
    }
    return distribution.slice(fenceStart, fenceEnd);
  };
  const assertNativeDestination = (shell, label, skillId) => {
    matches(
      'onboarding.companion-paths',
      distributionPath,
      shell,
      new RegExp(
        `SKILL_DEST="\\$\\{DEST\\}\\/\\.agents\\/skills\\/${skillId}"`,
        'u',
      ),
      `${label} must write into the Codex native destination`,
    );
    matches(
      'onboarding.companion-paths',
      distributionPath,
      shell,
      /\$\{SKILL_DEST\}\/\$\{FILE\}/u,
      `${label} must write each source file through SKILL_DEST`,
    );
    excludes(
      'onboarding.companion-paths',
      distributionPath,
      shell,
      new RegExp(`\\$\\{DEST\\}\\/skills\\/${skillId}`, 'u'),
      `${label} must not use target skills/${skillId} as the destination`,
    );
  };
  for (const [suffix, skillId] of [
    ['issue-authoring-companion', 'issue-authoring'],
    ['idd-spec-audit-companion', 'idd-spec-audit'],
  ]) {
    const ghApi = extractShellList(`${suffix}-gh-api-loop`);
    const curl = extractShellList(`${suffix}-curl-loop`);
    assertNativeDestination(ghApi, 'gh api', skillId);
    assertNativeDestination(curl, 'curl', skillId);
    has(
      'onboarding.companion-paths',
      distributionPath,
      ghApi,
      `contents/skills/${skillId}/\${FILE}`,
    );
    if (skillId === 'issue-authoring') {
      matches(
        'onboarding.companion-paths',
        distributionPath,
        curl,
        /BASE="https:\/\/raw\.githubusercontent\.com\/kurone-kito\/idd-skill\/main\/skills\/issue-authoring"/u,
        'curl must fetch the canonical issue-authoring source bundle',
      );
    } else {
      matches(
        'onboarding.companion-paths',
        distributionPath,
        curl,
        /BASE="https:\/\/raw\.githubusercontent\.com\/kurone-kito\/idd-skill\/main\/skills\/idd-spec-audit"/u,
        'curl must fetch the canonical idd-spec-audit source bundle',
      );
    }
  }
  const localCopyStart = distribution.indexOf('## Local-copy installs');
  const localCopyEnd = distribution.indexOf(
    '## Maintenance checklist',
    localCopyStart,
  );
  if (localCopyStart === -1 || localCopyEnd === -1) {
    report(
      'onboarding.companion-paths',
      distributionPath,
      'missing local-copy or maintenance section',
    );
  } else {
    const localCopy = distribution.slice(localCopyStart, localCopyEnd);
    for (const needle of [
      'SOURCE="skills/issue-authoring"',
      'TARGET_REPO=',
      'SKILL_DEST="$' + '{TARGET_REPO}/.agents/skills/issue-authoring"',
      'cp -R "$' + '{SOURCE}/." "$' + '{SKILL_DEST}/"',
    ]) {
      has('onboarding.companion-paths', distributionPath, localCopy, needle);
    }
    excludes(
      'onboarding.companion-paths',
      distributionPath,
      localCopy,
      /\$\{TARGET_REPO\}\/skills\/issue-authoring/u,
      'local-copy example must not assume target skills/issue-authoring is native',
    );
  }
  const policyPath = 'idd-template/docs/onboarding/policy-decisions.md';
  const policy = readText(policyPath);
  for (const needle of [
    'selected destination alongside',
    '**Native destination**:',
    'canonical source path and the installed destination',
  ]) {
    has('onboarding.companion-policy', policyPath, policy, needle);
  }
  matches(
    'onboarding.companion-policy',
    'idd-template/ONBOARDING.md',
    readText('idd-template/ONBOARDING.md'),
    /issue-authoring companion status[\s\S]*selected native destination/iu,
    'policy must distinguish companion source and selected destination',
  );
  const verificationPath =
    'idd-template/docs/onboarding/agent-entry-and-verification.md';
  const verification = readText(verificationPath);
  matches(
    'onboarding.companion-policy',
    verificationPath,
    verification,
    /source-versus-\s*destination contract/iu,
    'verification guidance must name the source-versus-destination contract',
  );
  has(
    'onboarding.companion-policy',
    verificationPath,
    verification,
    '.agents/skills/issue-authoring/SKILL.md',
  );
  matches(
    'onboarding.companion-policy',
    verificationPath,
    verification,
    /native destination[\s\S]*contains `SKILL\.md`/iu,
    'verification guidance must check that the native destination contains SKILL.md',
  );
  excludes(
    'onboarding.companion-policy',
    verificationPath,
    verification,
    /`skills\/issue-authoring\/SKILL\.md`[\s\S]*`skills\/issue-authoring\/references\//u,
    'verification guidance must not confuse the canonical source with the installed destination',
  );
  const agentsPath = 'AGENTS.md';
  const agents = readText(agentsPath);
  for (const needle of [
    '## Codex issue-authoring route',
    'canonical issue-authoring bundle',
    '.claude/skills/issue-authoring/',
    '.agents/skills/issue-authoring/',
  ]) {
    has('onboarding.companion-policy', agentsPath, agents, needle);
  }
  const onboardingPath = 'idd-template/ONBOARDING.md';
  const onboarding = readText(onboardingPath);
  auditCanonicalInventory(
    onboarding,
    onboardingPath,
    'issue-authoring-companion-files',
    [
      'skills/issue-authoring/SKILL.md',
      'skills/issue-authoring/references/contract.md',
      'skills/issue-authoring/references/draft-patterns.md',
      'skills/issue-authoring/references/workflow-boundary.md',
    ],
    report,
    excludes,
  );
  auditCanonicalInventory(
    onboarding,
    onboardingPath,
    'idd-spec-audit-companion-files',
    [
      'skills/idd-spec-audit/SKILL.md',
      'skills/idd-spec-audit/references/report-template.md',
    ],
    report,
    excludes,
  );
}
function auditCanonicalInventory(text, file, id, paths, report, excludes) {
  const ruleId = 'onboarding.companion-inventory';
  const startMarker = `<!-- audit:generated id=${id} -->`;
  const markerCount = text.split(startMarker).length - 1;
  if (markerCount !== 1) {
    report(
      ruleId,
      file,
      `${id} generated block start marker must appear exactly once (found ${markerCount})`,
    );
  }
  const start = text.indexOf(startMarker);
  if (start === -1) return;
  const endMarker = '<!-- /audit:generated -->';
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    report(ruleId, file, `${id} generated block is missing its end marker`);
    return;
  }
  const inventory = text.slice(start, end);
  for (const path of paths) {
    if (!inventory.includes(path)) {
      report(
        ruleId,
        file,
        `${id} generated inventory is missing canonical source path ${path}`,
      );
    }
  }
  excludes(
    ruleId,
    file,
    inventory,
    /\.(?:agents|claude|opencode)\/skills/u,
    `${id} generated inventory must contain canonical source paths only`,
  );
}
function auditNonNodeFallback(readText, report, has, matches, excludes) {
  const customizationFiles = [
    'docs/customization.md',
    'idd-template/docs/customization.md',
  ];
  for (const file of customizationFiles) {
    const text = readText(file);
    has(
      'non-node.fallback-wording',
      file,
      text,
      '2. `npx` when available; 3. `true` when unavailable or not relevant',
    );
    matches(
      'non-node.fallback-wording',
      file,
      normalizeWhitespace(text),
      /\(2\) use bare `npx <tool>` when `npx` is available; \(3\) replace with `true` when `npx` is unavailable or the check is not relevant to the project\./u,
      'must document both npx availability and the irrelevant-check branch',
    );
    has(
      'non-node.fallback-wording',
      file,
      text,
      'or the check is not relevant to the project.',
    );
    excludes(
      'non-node.fallback-wording',
      file,
      text,
      /`npx` if Node\.js is present/u,
      'must not infer npx availability from Node.js alone',
    );
  }
  const onboardingPath = 'idd-template/ONBOARDING.md';
  const onboarding = readText(onboardingPath);
  has(
    'non-node.onboarding-placeholders',
    onboardingPath,
    onboarding,
    'docs/onboarding/placeholders.md',
  );
  has(
    'non-node.onboarding-policy',
    onboardingPath,
    onboarding,
    'docs/onboarding/policy-decisions.md',
  );
  has(
    'non-node.agent-entry-reference',
    onboardingPath,
    onboarding,
    'docs/onboarding/agent-entry-and-verification.md',
  );
  matches(
    'non-node.onboarding-placeholders',
    onboardingPath,
    onboarding,
    /all seven placeholders:[\s\S]*`\{\{TRUSTED_MARKER_ACTOR\}\}`/u,
    'Step 1A must include the trusted marker actor placeholder',
  );
  matches(
    'non-node.onboarding-placeholders',
    onboardingPath,
    onboarding,
    /perform a global replacement for:[\s\S]*`\{\{TRUSTED_MARKER_ACTOR\}\}`/u,
    'Step 4 must replace the trusted marker actor placeholder',
  );
  excludes(
    'non-node.onboarding-placeholders',
    onboardingPath,
    onboarding,
    /\{\{TRUSTED_MARKER_ACTORS\}\}/u,
    'must not use the legacy plural trusted marker placeholder',
  );
  matches(
    'non-node.agent-entry-reference',
    onboardingPath,
    onboarding,
    /`CLAUDE\.md`, `AGENTS\.md`, and `GEMINI\.md`/u,
    'must keep the root agent entry file list inline',
  );
  matches(
    'non-node.agent-entry-reference',
    onboardingPath,
    onboarding,
    /explicitly opts out of adding new files/u,
    'must keep the operator opt-out rule inline',
  );
  has(
    'non-node.agent-entry-reference',
    onboardingPath,
    onboarding,
    'If `.github/copilot-instructions.md` existed before onboarding,',
  );
  const configPath = 'idd-template/.github/idd/config.json';
  const templateConfig = readText(configPath);
  for (const [key, token] of [
    ['trustedMarkerActors', onboardingPlaceholder('TRUSTED_MARKER_ACTOR')],
    ['install-deps', onboardingPlaceholder('INSTALL_DEPS_COMMAND')],
    ['fix-validate', onboardingPlaceholder('FIX_VALIDATE_COMMANDS')],
    ['pre-push-validate', onboardingPlaceholder('PRE_PUSH_VALIDATE_COMMANDS')],
    ['post-fix-validate', onboardingPlaceholder('POST_FIX_VALIDATE_COMMANDS')],
  ]) {
    const tokenPattern = escapeRegExp(token);
    const pattern =
      key === 'trustedMarkerActors'
        ? new RegExp(`"${key}": \\["${tokenPattern}"\\]`, 'u')
        : new RegExp(`"${key}": "${tokenPattern}"`, 'u');
    matches(
      'non-node.onboarding-placeholders',
      configPath,
      templateConfig,
      pattern,
      `must keep ${key} as its placeholder token`,
    );
  }
  excludes(
    'non-node.onboarding-placeholders',
    configPath,
    templateConfig,
    /\{\{TRUSTED_MARKER_ACTORS\}\}/u,
    'must not contain the legacy trusted marker actors placeholder',
  );
  const placeholdersPath = 'idd-template/docs/onboarding/placeholders.md';
  const placeholders = readText(placeholdersPath);
  matches(
    'non-node.onboarding-placeholders',
    placeholdersPath,
    placeholders,
    /### `\{\{TRUSTED_MARKER_ACTOR\}\}`/u,
    'must document the trusted marker actor placeholder',
  );
  matches(
    'non-node.onboarding-placeholders',
    placeholdersPath,
    placeholders,
    /single[\s\S]*login string first/iu,
    'must explain replacing the first trusted login',
  );
  matches(
    'non-node.onboarding-placeholders',
    placeholdersPath,
    placeholders,
    /extra[\s\S]*quoted array entries manually/iu,
    'must explain adding more trusted actors',
  );
  has(
    'non-node.onboarding-placeholders',
    placeholdersPath,
    placeholders,
    'Only the command placeholders may be set to `true`',
  );
  const fixSection = sectionOrReport(
    report,
    placeholdersPath,
    placeholders,
    `### \`${onboardingPlaceholder('FIX_VALIDATE_COMMANDS')}\``,
    `### \`${onboardingPlaceholder('PRE_PUSH_VALIDATE_COMMANDS')}\``,
    'non-node.onboarding-placeholders',
  );
  if (fixSection !== null) {
    matches(
      'non-node.onboarding-placeholders',
      placeholdersPath,
      fixSection,
      /Node\.js without a relevant script but with `npx` available:/u,
      'fix-validate guidance must check npx availability',
    );
    matches(
      'non-node.onboarding-placeholders',
      placeholdersPath,
      fixSection,
      /no relevant auto-fix tooling: `true`/u,
      'fix-validate no-op must be limited to no-relevant-tooling cases',
    );
  }
  const prePushSection = sectionOrReport(
    report,
    placeholdersPath,
    placeholders,
    `### \`${onboardingPlaceholder('PRE_PUSH_VALIDATE_COMMANDS')}\``,
    `### \`${onboardingPlaceholder('POST_FIX_VALIDATE_COMMANDS')}\``,
    'non-node.onboarding-placeholders',
  );
  if (prePushSection !== null) {
    matches(
      'non-node.onboarding-placeholders',
      placeholdersPath,
      prePushSection,
      /Node\.js without a relevant script but with `npx` available:/u,
      'pre-push guidance must check npx availability',
    );
    matches(
      'non-node.onboarding-placeholders',
      placeholdersPath,
      prePushSection,
      /no relevant verification command: `true`/u,
      'pre-push no-op must be limited to no-relevant-tooling cases',
    );
  }
  const readmePath = 'idd-template/README.md';
  matches(
    'non-node.onboarding-placeholders',
    readmePath,
    readText(readmePath),
    /\| `\{\{TRUSTED_MARKER_ACTOR\}\}` +\| Single JSON-escaped trusted marker login/u,
    'README placeholder table must list the trusted marker actor',
  );
  const policyPath = 'idd-template/docs/onboarding/policy-decisions.md';
  const policy = readText(policyPath);
  for (const needle of [
    '### Credential scope',
    '### Critique-loop profile',
    'Review `docs/permissions.md` with the operator',
    '### Credential Scope',
    '### Critique-Loop Profile',
  ]) {
    has('non-node.onboarding-policy', policyPath, policy, needle);
  }
  matches(
    'non-node.onboarding-policy',
    policyPath,
    policy,
    /single[\s\S]*GitHub login string first/iu,
    'must document replacing the first trusted actor',
  );
  matches(
    'non-node.onboarding-policy',
    policyPath,
    policy,
    /extra[\s\S]*quoted array entries manually/iu,
    'must document adding more trusted actors',
  );
  for (const [pattern, message] of [
    [
      /critique-loop profile \(distributed defaults, or a documented\s+repository override\)/u,
      'Step 1B must confirm the critique-loop profile',
    ],
    [
      /claim-timing defaults \(`claim-stale-age` and\s+`claim-heartbeat-interval`\)/u,
      'Step 1B must confirm claim timing defaults',
    ],
    [
      /CI wait policy defaults \(`ciWait\.runningTimeout`,\s+`ciWait\.generationTimeout`, `ciWait\.rerunPolicy`\)/u,
      'Step 1B must confirm CI wait defaults',
    ],
    [
      /issue-author approval gate \(`enabled-by-default` by default, or\s+explicit config opt-out via `skipIssueAuthorApprovalGate: true`\)/u,
      'Step 1B must confirm the issue-author approval gate decision',
    ],
    [
      /critique-loop profile, credential scope, claim-timing defaults, CI wait\s+policy defaults, issue-author approval gate, maintainer approval actor\s+policy, issue-authoring companion status, helper runtime profile, IDD\s+label names, the up-to-date-head ruleset check, and bootstrap execution\s+mode\./u,
      'Step 2 must re-check the complete policy confirmation list',
    ],
    [
      /review-thread resolution policy and critique-loop\s+profile are recorded/u,
      'Step 6 must record review and critique-loop policy',
    ],
    [
      /selected CI wait policy values, merge policy, credential\s+scope, claim timing values, issue-author approval gate decision,/u,
      'Step 6 must keep CI wait and issue-author gate in the recorded checklist',
    ],
    [
      /`\.github\/instructions\/idd-overview-core\.instructions\.md` keeps/u,
      'Step 6 must use the full overview instruction path',
    ],
    [
      /helper runtime profile \(`instructions-only` by default, or an evidence-based helper profile recommendation that still requires explicit operator confirmation\)/u,
      'Step 1B must keep helper profile recommendations subject to confirmation',
    ],
  ]) {
    matches(
      'non-node.onboarding-confirmation',
      onboardingPath,
      normalizeWhitespace(onboarding),
      pattern,
      message,
    );
  }
  excludes(
    'non-node.helper-profile',
    policyPath,
    policy,
    /Keep `instructions-only` unless helper support was explicitly requested\./u,
    'must not require prior helper opt-in before a profile recommendation',
  );
  matches(
    'non-node.helper-profile',
    policyPath,
    normalizeWhitespace(policy),
    /Auto-propose a helper runtime profile only when repository evidence shows a supported package-manager path or another real Node\.js helper path, but require explicit operator confirmation before recording anything other than `instructions-only`\./u,
    'must require repository evidence and explicit operator confirmation',
  );
  excludes(
    'non-node.helper-profile',
    placeholdersPath,
    placeholders,
    /`package\.json` → `npm install`/u,
    'must not derive npm install from bare package.json presence',
  );
  matches(
    'non-node.helper-profile',
    placeholdersPath,
    normalizeWhitespace(placeholders),
    /declared `packageManager` metadata or exactly one supported lockfile[\s\S]*bare `package\.json` without those signals → do not infer `npm install` from that alone/u,
    'must require package-manager evidence before proposing npm install',
  );
  for (const file of customizationFiles) {
    const text = readText(file);
    excludes(
      'non-node.helper-profile',
      file,
      text,
      /unless helper support is explicitly requested during onboarding/u,
      'must not gate helper profile recommendations on prior opt-in',
    );
    matches(
      'non-node.helper-profile',
      file,
      normalizeWhitespace(text),
      /Auto-propose helper support only when repository evidence shows a real package-manager or Node\.js helper path, keep operator confirmation explicit, prefer `package-manager` when supported package-manager evidence exists, and otherwise prefer `vendored-node` before `ephemeral-npx`\./u,
      'must describe evidence-based helper profile selection order',
    );
  }
  for (const file of [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ]) {
    const text = readText(file);
    excludes(
      'non-node.helper-profile',
      file,
      text,
      /Apply this order only after a maintainer or import flow has explicitly opted into helper support\./u,
      'must not gate helper profile proposals on prior opt-in',
    );
    matches(
      'non-node.helper-profile',
      file,
      normalizeWhitespace(text),
      /Use repository evidence to decide whether helper support should be proposed for operator confirmation\./u,
      'must describe evidence-based proposal flow',
    );
    matches(
      'non-node.helper-profile',
      file,
      normalizeWhitespace(text),
      /If supported `packageManager` metadata or exactly one supported lockfile is present, propose `package-manager`\./u,
      'must prefer package-manager only when supported evidence exists',
    );
  }
  auditManifestImportSurface(readText, report, has);
  const agentReferencePath =
    'idd-template/docs/onboarding/agent-entry-and-verification.md';
  const agentReference = readText(agentReferencePath);
  for (const [pattern, message] of [
    [
      /### CLAUDE\.md/u,
      'must keep the CLAUDE.md example in the extracted reference',
    ],
    [
      /### AGENTS\.md \(for Codex CLI, OpenCode, Grok Build, and Cursor CLI\)/u,
      'must keep the AGENTS.md example in the extracted reference',
    ],
    [
      /### GEMINI\.md/u,
      'must keep the GEMINI.md example in the extracted reference',
    ],
    [/## Verification details/u, 'must include expanded verification guidance'],
    [
      /selected critique-loop profile is recorded/u,
      'must keep critique-loop terminology aligned',
    ],
    [
      /`\.github\/instructions\/idd-overview-core\.instructions\.md` has/u,
      'must use the full overview instruction path',
    ],
    [
      /`\.github\/instructions\/idd-discover\.instructions\.md` and\s+`\.github\/instructions\/idd-overview-core\.instructions\.md`/u,
      'must use the full instruction paths in marker checklist',
    ],
  ]) {
    matches(
      'non-node.agent-entry-reference',
      agentReferencePath,
      agentReference,
      pattern,
      message,
    );
  }
  for (const [pattern, message] of [
    [
      /Treat\s+`refs\/heads\/main`\s+as a manual opt-in/u,
      'policy reference must treat moving branch specs as manual opt-in',
    ],
  ]) {
    matches('non-node.policy-reference', policyPath, policy, pattern, message);
  }
  has(
    'non-node.policy-reference',
    policyPath,
    policy,
    'npx --yes --package <reviewed-helper-spec> \\',
  );
  excludes(
    'non-node.policy-reference',
    policyPath,
    policy,
    /policy fields override the command table values/u,
    'must not claim policy fields override phase behavior',
  );
  const liveOverviewPath =
    '.github/instructions/idd-overview-core.instructions.md';
  const templateOverviewPath =
    'idd-template/.github/instructions/idd-overview-core.instructions.md';
  has(
    'non-node.overview-fallback',
    liveOverviewPath,
    readText(liveOverviewPath),
    '`npx <tool>` only when `npx` is available',
  );
  const templateOverview = readText(templateOverviewPath);
  has(
    'non-node.overview-fallback',
    templateOverviewPath,
    templateOverview,
    '`npx <tool>` if Node.js and `npx` are available',
  );
  // Each command row is either its onboarding placeholder or a reference to
  // the matching `commands` key in config.json. A line that mixes the two,
  // or any other text, matches neither form and fails. The placeholder token
  // is built from its name, not written out, so the placeholder scan that
  // reads generated helpers does not see an unresolved token in this file.
  const templateOverviewLines = new Set(templateOverview.split(/\r?\n/u));
  for (const [row, token] of [
    ['install-deps', 'INSTALL_DEPS_COMMAND'],
    ['fix-validate', 'FIX_VALIDATE_COMMANDS'],
    ['pre-push-validate', 'PRE_PUSH_VALIDATE_COMMANDS'],
    ['post-fix-validate', 'POST_FIX_VALIDATE_COMMANDS'],
  ]) {
    const placeholderRow = `| **${row}** | \`{{${token}}}\` |`;
    const referenceRow = `| **${row}** | \`commands.${row}\` |`;
    if (
      !templateOverviewLines.has(placeholderRow) &&
      !templateOverviewLines.has(referenceRow)
    ) {
      report(
        'non-node.overview-fallback',
        templateOverviewPath,
        `missing required row ${JSON.stringify(placeholderRow)} or ${JSON.stringify(referenceRow)}`,
      );
    }
  }
  for (const file of [
    '.github/instructions/idd-ci.instructions.md',
    'idd-template/.github/instructions/idd-ci.instructions.md',
  ]) {
    const text = readText(file);
    has(
      'non-node.ci-wait-command',
      file,
      text,
      '<profile-selected-ci-wait-policy-command>',
    );
    matches(
      'non-node.ci-wait-command',
      file,
      text,
      /Do not hardcode[\s\S]*node scripts\/ci-wait-policy\.mjs/u,
      'must warn against hardcoding the vendored helper command',
    );
  }
  for (const file of [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ]) {
    const text = readText(file);
    matches(
      'non-node.ci-wait-command',
      file,
      text,
      /profile-selected `idd:ci-wait-policy` command/u,
      'must document the selected ci-wait command',
    );
    matches(
      'non-node.ci-wait-command',
      file,
      text,
      /append\s+`--rerun-count <count>` to\s+the selected command/u,
      'must append rerun-count to the selected command',
    );
  }
}
function auditManifestImportSurface(readText, report, has) {
  const onboardingPath = 'idd-template/ONBOARDING.md';
  const onboarding = readText(onboardingPath);
  const blockText = sectionOrReport(
    report,
    onboardingPath,
    onboarding,
    '<!-- audit:generated id=idd-template-core-files -->',
    '<!-- /audit:generated -->',
    'non-node.generated-import-surface',
  );
  if (blockText !== null) {
    for (const path of [
      'docs/onboarding/agent-entry-and-verification.md',
      'docs/onboarding/placeholders.md',
      'docs/onboarding/policy-decisions.md',
    ]) {
      has('non-node.generated-import-surface', onboardingPath, blockText, path);
    }
  }
  const manifestPath = 'audit/sync-manifest.json';
  const manifest = parseJsonObject(
    readText(manifestPath),
    manifestPath,
    'non-node.generated-import-surface',
    report,
  );
  if (manifest === null) return;
  const generatedBlocks = manifest.generatedBlocks;
  if (!Array.isArray(generatedBlocks)) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'generatedBlocks must be an array',
    );
    return;
  }
  if (
    generatedBlocks.some(
      (entry) => !isRecord(entry) || typeof entry.id !== 'string',
    )
  ) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'generatedBlocks entries must be objects with string ids',
    );
    return;
  }
  const generatedBlockEntries = generatedBlocks;
  const block = generatedBlockEntries.find(
    (entry) => entry.id === 'idd-template-core-files',
  );
  if (!block) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'is missing the idd-template-core-files generated block',
    );
    return;
  }
  if (
    !Array.isArray(block.paths) ||
    !block.paths.every((path) => typeof path === 'string')
  ) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'idd-template-core-files paths must be an array of strings',
    );
    return;
  }
  if (
    !Array.isArray(block.sourceGlobs) ||
    !block.sourceGlobs.every((glob) => typeof glob === 'string')
  ) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'idd-template-core-files sourceGlobs must be an array of strings',
    );
    return;
  }
  const paths = block.paths;
  const sourceGlobs = block.sourceGlobs;
  for (const path of [
    'idd-template/docs/onboarding/agent-entry-and-verification.md',
    'idd-template/docs/onboarding/placeholders.md',
    'idd-template/docs/onboarding/policy-decisions.md',
  ]) {
    if (!paths.includes(path))
      report(
        'non-node.generated-import-surface',
        manifestPath,
        `core file list is missing ${path}`,
      );
  }
  if (!sourceGlobs.includes('idd-template/docs/onboarding/*.md')) {
    report(
      'non-node.generated-import-surface',
      manifestPath,
      'core file input must include the onboarding docs glob',
    );
  }
}
function auditWorkflowMap(readText, report, has, matches, equal) {
  const canonicalPath = 'docs/idd-workflow.md';
  const templatePath = 'idd-template/docs/idd-workflow.md';
  const canonical = readText(canonicalPath);
  const template = readText(templatePath);
  const canonicalMap = extractTopLevelSection(
    canonical,
    canonicalPath,
    '## IDD file map',
    report,
    'workflow.phase-map',
  );
  const templateMap = extractTopLevelSection(
    template,
    templatePath,
    '## IDD file map',
    report,
    'workflow.phase-map',
  );
  if (canonicalMap !== null && templateMap !== null) {
    equal(
      'workflow.phase-map',
      canonicalPath,
      canonicalMap,
      templateMap,
      'IDD file map section must match the template',
    );
    for (const [path, section] of [
      [canonicalPath, canonicalMap],
      [templatePath, templateMap],
    ]) {
      for (const anchor of [
        'A0-T–A4',
        'A4.5',
        'B1-B3 + C1-C6',
        'F2.5',
        'Resume Step 0-3',
        'Resume S1-S5',
      ]) {
        has('workflow.phase-map.anchors', path, section, anchor);
      }
    }
  }
  for (const [path, text] of [
    [canonicalPath, normalizeWhitespace(canonical)],
    [templatePath, normalizeWhitespace(template)],
  ]) {
    matches(
      'workflow.onboarding-guidance',
      path,
      text,
      /During onboarding, create or update `CLAUDE\.md`, `AGENTS\.md`, and `GEMINI\.md` so each non-Copilot agent listed above has a stable first file to read\. GitHub Copilot remains an update-if-present surface via `\.github\/copilot-instructions\.md`\. Skipping creation of a missing root entry file should be an explicit operator choice, not the default\./u,
      'must keep agent-entry onboarding guidance',
    );
  }
  if (
    canonical.includes('helper-backed evidence collectors first') !==
    template.includes('helper-backed evidence collectors first')
  ) {
    report(
      'workflow.onboarding-guidance',
      canonicalPath,
      'helper-backed evidence collector wording must agree with the template',
    );
  }
}
function auditPnpmBoundary(readText, excludes) {
  for (const file of [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ]) {
    excludes(
      'pnpm-boundary.distributed-docs',
      file,
      readText(file),
      /`[^`\n]*\bpnpm\s+\S+[^`\n]*`/iu,
      'distributed helper-runtime docs must not assume pnpm-only commands',
    );
  }
}
function auditGeneratedImportAnchor(readText, report, has, matches) {
  const file = 'idd-template/ONBOARDING.md';
  const doc = readText(file);
  const heading = '## CLI-assisted onboarding';
  const section = extractTopLevelSection(
    doc,
    file,
    heading,
    report,
    'onboarding.generated-import-anchor',
  );
  if (section === null) return;
  matches(
    'onboarding.generated-import-anchor',
    file,
    section,
    /idd-template-core-files/u,
    'CLI-assisted onboarding must anchor --import to the shared generated file list',
  );
  const marker = '<!-- audit:generated id=idd-template-core-files -->';
  const count = doc.split(marker).length - 1;
  if (count !== 1) {
    report(
      'onboarding.generated-import-anchor',
      file,
      `generated block start marker must appear exactly once (found ${count})`,
    );
  }
  has(
    'onboarding.generated-import-anchor',
    file,
    section,
    'idd-template-core-files',
  );
}
function equalSections(
  readText,
  report,
  equal,
  ruleId,
  leftPath,
  rightPath,
  startMarker,
  endMarker,
  message,
  validate,
) {
  const left = getSection(
    readText,
    report,
    ruleId,
    leftPath,
    startMarker,
    endMarker,
  );
  const right = getSection(
    readText,
    report,
    ruleId,
    rightPath,
    startMarker,
    endMarker,
  );
  if (left !== null && right !== null) {
    if (validate && !validate(left)) {
      report(
        ruleId,
        leftPath,
        'section is missing required approval-stop wording',
      );
    }
    equal(ruleId, leftPath, left, right, message);
  }
}
function getSection(readText, report, ruleId, path, start, end) {
  return extractSection(readText(path), path, start, end, report, ruleId);
}
function sectionOrReport(report, file, text, start, end, ruleId) {
  return extractSection(text, file, start, end, report, ruleId);
}
export function runRepositoryInstructionAuditCli(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      process.stdout.write(
        'usage: node scripts/repository-instruction-audit.mjs [--root <fixture-dir>]\n',
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
  const violations = collectRepositoryInstructionViolations(root);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `repository-instruction-audit/${violation.ruleId}: ${violation.path}: ${violation.message}\n`,
      );
    }
    return 1;
  }
  process.stdout.write('repository-instruction-audit: no violations\n');
  return 0;
}
if (import.meta.main) {
  process.exitCode = runRepositoryInstructionAuditCli(process.argv.slice(2));
}
