import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  backLinkPatternFor,
  checkClaimTimingConsistency,
  checkDependencyVersionDrift,
  checkLiveConfigSchema,
  checkProjectCommands,
  classifyBacklog,
  classifyClaimTimingConsistency,
  classifyLiveConfigSchemaFinding,
  classifyPrimaryHead,
  classifyReleaseTagDrift,
  classifyWorktreeGuardActivation,
  classifyWorktreeHeadFinding,
  computeWindowStartIso,
  containsExampleRepoBackLink,
  containsWorkshopReference,
  DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
  decodeGithubReadmeBase64,
  emitCleanupBacklogProgress,
  evaluateAutopilotSuitabilityConsistency,
  evaluateDependencyVersionDrift,
  evaluateMarkerPrefixConsistency,
  extractMarkerPrefixes,
  findMissingWorkshopReferences,
  findMissingWorktreeHardening,
  findPlaceholders,
  formatCleanupBacklogScanPreamble,
  formatCleanupBacklogScanProgress,
  hookWiresWorktreeGuard,
  isGithubBackLinkHost,
  parseIsoDurationToHours,
  parseLockfileImporterVersion,
  parsePrimaryWorktreePath,
  parseProjectCommandRows,
  parseThresholdsProseHours,
  readWorktreeGuardBranchPatterns,
  readWorktreeGuardEnabled,
  scanFileForPlaceholders,
  stripMarkdownNonText,
} from '../src/scripts/idd-doctor.mts';
import { loadJson } from '../src/scripts/validate-schemas.mts';

const ap = (n: number | string) =>
  `<!-- idd-skill-autopilot-suitability: ${n} -->`;

test('autopilot-suitability consistency: valid score+label combinations produce no warnings', () => {
  const issues = [
    { number: 1, body: `task\n${ap(5)}`, labels: [] },
    { number: 2, body: `task\n${ap(4)}`, labels: [{ name: 'enhancement' }] },
    {
      number: 3,
      body: `human-only\n${ap(1)}`,
      labels: ['status:blocked-by-human'],
    },
    { number: 4, body: 'no score marker at all', labels: [] },
  ];
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor: 3,
  });
  assert.deepEqual(warnings, []);
});

test('autopilot-suitability consistency: score 1 without blocked-by-human warns', () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [{ number: 7, body: `task\n${ap(1)}`, labels: [] }],
    { floor: 3 },
  );
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /issue #7 is scored 1 .* missing the status:blocked-by-human label/,
  );
});

test('autopilot-suitability consistency: score >= floor with blocked-by-human warns', () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [
      {
        number: 8,
        body: `task\n${ap(4)}`,
        labels: ['status:blocked-by-human'],
      },
    ],
    { floor: 3 },
  );
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /issue #8 is scored 4 \(>= floor 3\) but carries status:blocked-by-human/,
  );
});

test('autopilot-suitability consistency: resolves a configured blocked-by-human label name (#1273)', () => {
  // The configured label name is honored for both the "missing" and
  // "carries" warning paths...
  const missing = evaluateAutopilotSuitabilityConsistency(
    [{ number: 20, body: `task\n${ap(1)}`, labels: [] }],
    { floor: 3, blockedByHumanLabelName: 'triage:human-gate' },
  );
  assert.equal(missing.warnings.length, 1);
  assert.match(
    missing.warnings[0],
    /issue #20 is scored 1 .* missing the triage:human-gate label/,
  );

  const carries = evaluateAutopilotSuitabilityConsistency(
    [
      {
        number: 21,
        body: `task\n${ap(4)}`,
        labels: ['triage:human-gate'],
      },
    ],
    { floor: 3, blockedByHumanLabelName: 'triage:human-gate' },
  );
  assert.equal(carries.warnings.length, 1);
  assert.match(
    carries.warnings[0],
    /issue #21 is scored 4 \(>= floor 3\) but carries triage:human-gate/,
  );

  // ...and the stock default no longer matches once overridden, so a score
  // of 1 with only the stock label still warns as "missing".
  const stockNoLongerMatches = evaluateAutopilotSuitabilityConsistency(
    [
      {
        number: 22,
        body: `task\n${ap(1)}`,
        labels: ['status:blocked-by-human'],
      },
    ],
    { floor: 3, blockedByHumanLabelName: 'triage:human-gate' },
  );
  assert.equal(stockNoLongerMatches.warnings.length, 1);
  assert.match(
    stockNoLongerMatches.warnings[0],
    /issue #22 is scored 1 .* missing the triage:human-gate label/,
  );
});

test('autopilot-suitability consistency: malformed or conflicting markers warn', () => {
  const issues = [
    { number: 9, body: `task\n${ap(6)}`, labels: [] },
    { number: 10, body: `task\n${ap('high')}`, labels: [] },
    { number: 11, body: `task\n${ap(4)}\n${ap(2)}`, labels: [] },
  ];
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor: 3,
  });
  assert.equal(warnings.length, 3);
  assert.ok(
    warnings.every((w) => /malformed or out-of-range score marker/.test(w)),
  );
});

test('autopilot-suitability consistency: missing marker never warns (fail-safe)', () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [
      {
        number: 12,
        body: 'ordinary issue, no score',
        labels: ['status:blocked-by-human'],
      },
    ],
    { floor: 3 },
  );
  assert.deepEqual(warnings, []);
});

test('autopilot-suitability consistency: honors a custom floor and marker prefix', () => {
  const issues = [
    // floor 4: score 3 with blocked-by-human is NOT >= floor, so no warning.
    {
      number: 13,
      body: `t\n<!-- my-org-autopilot-suitability: 3 -->`,
      labels: ['status:blocked-by-human'],
    },
    // floor 4: score 4 with blocked-by-human warns.
    {
      number: 14,
      body: `t\n<!-- my-org-autopilot-suitability: 4 -->`,
      labels: ['status:blocked-by-human'],
    },
  ];
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor: 4,
    markerPrefix: 'my-org',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /issue #14 is scored 4 \(>= floor 4\)/);
});

test('autopilot-suitability consistency: floor 1 treats score-1 + blocked-by-human as agreement', () => {
  const issues = [
    // floor 1: score 1 with blocked-by-human AGREES — the score and label
    // both mark the issue human-only, so there is no contradiction.
    {
      number: 21,
      body: `human-only\n${ap(1)}`,
      labels: ['status:blocked-by-human'],
    },
    // floor 1: score 1 without the label still warns via the first branch.
    { number: 22, body: `task\n${ap(1)}`, labels: [] },
    // floor 1: score 2 with blocked-by-human still warns (>= floor 1).
    {
      number: 23,
      body: `task\n${ap(2)}`,
      labels: ['status:blocked-by-human'],
    },
  ];
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, {
    floor: 1,
  });
  assert.equal(warnings.length, 2);
  assert.ok(
    !warnings.some((w) => /issue #21/.test(w)),
    'score-1 + blocked-by-human must not warn at floor 1',
  );
  assert.match(
    warnings.find((w) => /issue #22/.test(w)) ?? '',
    /issue #22 is scored 1 .* missing the status:blocked-by-human label/,
  );
  assert.match(
    warnings.find((w) => /issue #23/.test(w)) ?? '',
    /issue #23 is scored 2 \(>= floor 1\) but carries status:blocked-by-human/,
  );
});

test('findPlaceholders returns template tokens', () => {
  const placeholders = findPlaceholders(`
  keep {{REPO_NAME}}
  and {{PROJECT_MARKER_PREFIX}}
  but ignore {NOT_A_PLACEHOLDER}
  `);

  assert.deepEqual(placeholders, [
    '{{REPO_NAME}}',
    '{{PROJECT_MARKER_PREFIX}}',
  ]);
});

test('findPlaceholders also captures lowercase and hyphenated tokens', () => {
  const placeholders = findPlaceholders(`
  keep {{repo_name}}
  and {{marker-prefix}}
  but ignore {NOT_A_PLACEHOLDER}
  `);

  assert.deepEqual(placeholders, ['{{repo_name}}', '{{marker-prefix}}']);
});

test('parseProjectCommandRows extracts command rows from the table', () => {
  const commands = parseProjectCommandRows(`
| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`npm run fix\` |
| **pre-push-validate** | \`npm run lint && npm test\` |
| **post-fix-validate** | \`npm run build\` |
| **install-deps** | \`npm ci\` |
| **issue-scope** | \`roadmap\` |
`);

  assert.equal(commands.get('fix-validate'), 'npm run fix');
  assert.equal(commands.get('pre-push-validate'), 'npm run lint && npm test');
  assert.equal(commands.get('install-deps'), 'npm ci');
  assert.equal(commands.get('issue-scope'), 'roadmap');
});

test('extractMarkerPrefixes returns roadmap and blocked-by prefixes', () => {
  const markers = extractMarkerPrefixes(`
<!-- idd-skill-roadmap-id: value -->
<!-- idd-skill-blocked-by: value -->
<!-- my-team-roadmap-id: value -->
<!-- MyTeam-blocked-by: value -->
`);

  assert.deepEqual(markers.roadmap, ['idd-skill', 'my-team']);
  assert.deepEqual(markers.blockedBy, ['idd-skill', 'MyTeam']);
});

test('evaluateMarkerPrefixConsistency accepts one consistent prefix with an empty overview set', () => {
  const result = evaluateMarkerPrefixConsistency(
    { roadmap: ['idd-skill'], blockedBy: ['idd-skill'] },
    { roadmap: [], blockedBy: [] },
  );
  assert.deepEqual(result, { prefix: 'idd-skill' });
});

test('evaluateMarkerPrefixConsistency skips when no prefixes are present', () => {
  assert.deepEqual(
    evaluateMarkerPrefixConsistency(
      { roadmap: [], blockedBy: [] },
      { roadmap: [], blockedBy: [] },
    ),
    { skip: true },
  );
});

test('evaluateMarkerPrefixConsistency catches a cross-type prefix mismatch hidden by empty sets', () => {
  // discover only has a roadmap-id prefix, overview only a blocked-by
  // prefix, and they differ — the pairwise empty-tolerant checks all
  // pass, so the all-prefixes guard must catch it. (Prefixes must be
  // valid multi-character tokens or the format guard fires first.)
  const result = evaluateMarkerPrefixConsistency(
    { roadmap: ['alpha'], blockedBy: [] },
    { roadmap: [], blockedBy: ['beta'] },
  );
  assert.ok(
    result.error && /inconsistent/.test(result.error),
    result.error ?? 'expected an inconsistency error, got none',
  );
});

test('evaluateMarkerPrefixConsistency reports a within-file roadmap/blocked-by mismatch', () => {
  const result = evaluateMarkerPrefixConsistency(
    { roadmap: ['alpha'], blockedBy: ['alpha', 'beta'] },
    { roadmap: [], blockedBy: [] },
  );
  assert.equal(
    result.error,
    'discover marker prefixes differ between roadmap-id and blocked-by',
  );
});

test('extractMarkerPrefixes ignores prose/heading slugs and status labels', () => {
  const markers = extractMarkerPrefixes(
    '## A3.5 — diagnostic-all-candidates-blocked-by-an-open-roadmap\n' +
      'see `status:blocked-by-human`, idd-skill-roadmap-id and idd-skill-blocked-by here\n',
  );
  // The heading slug (`...-blocked-by-an-...`) and the `status:` label
  // must not contribute a bogus prefix; only the real markers count.
  assert.deepEqual(markers.roadmap, ['idd-skill']);
  assert.deepEqual(markers.blockedBy, ['idd-skill']);
});

test('scanFileForPlaceholders ignores placeholder names documented in docs code spans', () => {
  // A docs/*.md file documents the placeholder name in an inline code
  // span — not an unresolved substitution.
  assert.deepEqual(
    scanFileForPlaceholders(
      'docs/customization.md',
      'Set `{{REPO_NAME}}` during onboarding.',
    ),
    [],
  );
  // A genuine leftover in docs prose is still detected.
  assert.deepEqual(
    scanFileForPlaceholders(
      'docs/customization.md',
      'Welcome to {{REPO_NAME}} (oops).',
    ),
    ['{{REPO_NAME}}'],
  );
});

test('scanFileForPlaceholders scans non-docs files raw so code-span leftovers are caught', () => {
  // An instruction file's marker example with an UNSUBSTITUTED
  // placeholder inside inline code / an HTML comment must still be
  // flagged (stripping is not applied outside docs/).
  assert.deepEqual(
    scanFileForPlaceholders(
      '.github/instructions/idd-discover.instructions.md',
      'example: `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: x -->`',
    ),
    ['{{PROJECT_MARKER_PREFIX}}'],
  );
  // A non-markdown file is also scanned raw.
  assert.deepEqual(
    scanFileForPlaceholders(
      '.github/idd/config.json',
      '{ "markerPrefix": "{{PROJECT_MARKER_PREFIX}}" }',
    ),
    ['{{PROJECT_MARKER_PREFIX}}'],
  );
});

test('parsePrimaryWorktreePath returns the first worktree entry', () => {
  const porcelain = [
    'worktree /repo/idd-skill',
    'HEAD ec72ee60dea3b9eeeb6ca0d7717daa46b98dcc13',
    'branch refs/heads/main',
    '',
    'worktree /repo/idd-skill.issue-703-foo',
    'HEAD abc123',
    'branch refs/heads/issue/703-foo',
    '',
  ].join('\n');

  assert.equal(parsePrimaryWorktreePath(porcelain), '/repo/idd-skill');
});

test('parsePrimaryWorktreePath returns null when input has no worktree line', () => {
  assert.equal(parsePrimaryWorktreePath(''), null);
  assert.equal(parsePrimaryWorktreePath('HEAD abc\nbranch main\n'), null);
});

test('parsePrimaryWorktreePath parses CRLF-delimited porcelain output', () => {
  const porcelain = [
    'worktree C:\\repo\\idd-skill',
    'HEAD ec72ee60dea3b9eeeb6ca0d7717daa46b98dcc13',
    'branch refs/heads/main',
    '',
  ].join('\r\n');

  assert.equal(parsePrimaryWorktreePath(porcelain), 'C:\\repo\\idd-skill');
});

test('parsePrimaryWorktreePath returns null for null / undefined / non-string input', () => {
  assert.equal(parsePrimaryWorktreePath(null), null);
  assert.equal(parsePrimaryWorktreePath(undefined), null);
  assert.equal(parsePrimaryWorktreePath(42), null);
});

test('classifyPrimaryHead flags issue/* branches as B1 violations', () => {
  assert.deepEqual(classifyPrimaryHead('issue/123-foo'), {
    isB1Violation: true,
    kind: 'issue',
  });
});

test('classifyPrimaryHead flags roadmap-audit/* branches as B1 violations', () => {
  assert.deepEqual(classifyPrimaryHead('roadmap-audit/456-bar'), {
    isB1Violation: true,
    kind: 'roadmap-audit',
  });
});

test('classifyPrimaryHead accepts main as not a violation', () => {
  assert.deepEqual(classifyPrimaryHead('main'), {
    isB1Violation: false,
    kind: 'other',
  });
});

test('classifyPrimaryHead handles empty or non-string input as unknown', () => {
  assert.deepEqual(classifyPrimaryHead(''), {
    isB1Violation: false,
    kind: 'unknown',
  });
  assert.deepEqual(classifyPrimaryHead(null), {
    isB1Violation: false,
    kind: 'unknown',
  });
  assert.deepEqual(classifyPrimaryHead(undefined), {
    isB1Violation: false,
    kind: 'unknown',
  });
});

test('classifyWorktreeHeadFinding returns null when HEAD is not a violation', () => {
  assert.equal(
    classifyWorktreeHeadFinding(
      { isB1Violation: false, kind: 'other' },
      'main',
      '/repo',
      true,
    ),
    null,
  );
});

test('classifyWorktreeHeadFinding warns (not errors) when the guard is not enforced', () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: 'issue' },
    'issue/123-foo',
    '/repo',
    false,
  );
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /an issue branch \(issue\/123-foo\)/);
  assert.match(finding?.message ?? '', /likely a past B1 violation/);
});

test('classifyWorktreeHeadFinding promotes to an error when the guard is enforced', () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: 'issue' },
    'issue/123-foo',
    '/repo',
    true,
  );
  assert.equal(finding?.level, 'error');
  assert.match(finding?.message ?? '', /worktree guard enforced/);
});

test('classifyWorktreeHeadFinding labels roadmap-audit branches', () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: 'roadmap-audit' },
    'roadmap-audit/456-bar',
    '/repo',
    true,
  );
  assert.equal(finding?.level, 'error');
  assert.match(finding?.message ?? '', /a roadmap-audit branch/);
});

test('hookWiresWorktreeGuard detects a hook that sources the guard', () => {
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/sh\n. "$(dirname "$0")/_idd-worktree-guard.sh"\n',
    ),
    true,
  );
});

test('hookWiresWorktreeGuard rejects hooks that do not source the guard', () => {
  assert.equal(hookWiresWorktreeGuard('#!/bin/sh\npnpm run lint\n'), false);
  assert.equal(hookWiresWorktreeGuard(''), false);
});

test('hookWiresWorktreeGuard ignores a bare mention in a comment', () => {
  // A leftover doc/comment line that names the helper but no longer sources
  // it is inert and must not read as wired.
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/sh\n# was: . "$(dirname "$0")/_idd-worktree-guard.sh"\necho hi\n',
    ),
    false,
  );
  // The `source` keyword variant (with indentation) still counts as wired.
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/bash\n  source ./.githooks/_idd-worktree-guard.sh\n',
    ),
    true,
  );
});

test('hookWiresWorktreeGuard treats a non-string (absent hook) as unwired', () => {
  assert.equal(hookWiresWorktreeGuard(null), false);
  assert.equal(hookWiresWorktreeGuard(undefined), false);
});

test('classifyWorktreeGuardActivation returns null when the guard is disabled', () => {
  assert.equal(
    classifyWorktreeGuardActivation({
      guardEnabled: false,
      headDetached: false,
      hooksPath: null,
      guardWired: false,
    }),
    null,
  );
});

test('classifyWorktreeGuardActivation stays silent on a detached HEAD (CI-safe)', () => {
  assert.equal(
    classifyWorktreeGuardActivation({
      guardEnabled: true,
      headDetached: true,
      hooksPath: null,
      guardWired: false,
    }),
    null,
  );
});

test('classifyWorktreeGuardActivation returns null when the guard is wired', () => {
  assert.equal(
    classifyWorktreeGuardActivation({
      guardEnabled: true,
      headDetached: false,
      hooksPath: '.githooks',
      guardWired: true,
    }),
    null,
  );
});

test('classifyWorktreeGuardActivation warns (never errors) when enabled-but-inert', () => {
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: '.husky/_',
    guardWired: false,
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /worktreeGuard\.enabled is true/);
  assert.match(finding?.message ?? '', /core\.hooksPath = \.husky\/_/);
  assert.match(finding?.message ?? '', /git config core\.hooksPath \.githooks/);
});

test('classifyWorktreeGuardActivation shows (unset) when core.hooksPath is absent', () => {
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: null,
    guardWired: false,
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /core\.hooksPath = \(unset\)/);
});

test('readWorktreeGuardEnabled reads worktreeGuard.enabled from config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-'));
  try {
    const writeConfig = (obj: unknown) => {
      mkdirSync(join(dir, '.github/idd'), { recursive: true });
      writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify(obj));
    };
    writeConfig({ worktreeGuard: { enabled: true } });
    assert.equal(readWorktreeGuardEnabled(dir), true);
    writeConfig({ worktreeGuard: { enabled: false } });
    assert.equal(readWorktreeGuardEnabled(dir), false);
    writeConfig({ markerPrefix: 'idd-skill' });
    assert.equal(readWorktreeGuardEnabled(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeGuardEnabled returns false when config is missing or invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-'));
  try {
    assert.equal(readWorktreeGuardEnabled(dir), false);
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    assert.equal(readWorktreeGuardEnabled(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeGuardBranchPatterns trims configured patterns and falls back when invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-'));
  try {
    const writeConfig = (obj: unknown) => {
      mkdirSync(join(dir, '.github/idd'), { recursive: true });
      writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify(obj));
    };
    // Missing config -> defaults.
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    // Surrounding whitespace is trimmed so the pattern matches real branches.
    writeConfig({
      worktreeGuard: { branchPatterns: ['  issue/* ', 'release/*\t'] },
    });
    assert.deepEqual(readWorktreeGuardBranchPatterns(dir), [
      'issue/*',
      'release/*',
    ]);
    // Fail-closed: a single empty/whitespace-only entry invalidates the
    // whole list and falls back to defaults (no partial honoring of a
    // malformed config).
    writeConfig({
      worktreeGuard: { branchPatterns: ['issue/* ', ''] },
    });
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    // Whitespace-only entries -> fall back to defaults.
    writeConfig({ worktreeGuard: { branchPatterns: ['  ', ''] } });
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    // A non-string entry is malformed -> fall back to defaults.
    writeConfig({ worktreeGuard: { branchPatterns: ['issue/*', 42] } });
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    // Non-array -> defaults.
    writeConfig({ worktreeGuard: { branchPatterns: 'issue/*' } });
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HARDENED_WORK =
  '## B1\n\n### Anti-patterns\n\ntext\n\n### B1 self-check\n\ntext\n';
const HARDENED_CORE =
  'The cwd-vs-claim check runs before any local commit, push, or merge.\n';
const HARDENED_DOCTOR = 'function checkPrimaryWorktreeHead(root, report) {}\n';

test('findMissingWorktreeHardening reports nothing when all signals are present', () => {
  assert.deepEqual(
    findMissingWorktreeHardening({
      work: HARDENED_WORK,
      core: HARDENED_CORE,
      doctor: HARDENED_DOCTOR,
    }),
    [],
  );
});

test('findMissingWorktreeHardening flags a stale instruction set missing the B1 sections', () => {
  const missing = findMissingWorktreeHardening({
    work: '## B1\n\nno guardrails here\n',
    core: HARDENED_CORE,
    doctor: HARDENED_DOCTOR,
  });
  assert.ok(missing.some((m) => /Anti-patterns/.test(m)));
  assert.ok(missing.some((m) => /B1 self-check/.test(m)));
});

test('findMissingWorktreeHardening flags cwd-vs-claim present but lacking local-commit coverage', () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: 'The cwd-vs-claim check runs before any push or merge.\n',
    doctor: HARDENED_DOCTOR,
  });
  assert.deepEqual(missing, [
    'overview-core cwd-vs-claim local-commit coverage',
  ]);
});

test("findMissingWorktreeHardening is not fooled by an unrelated 'local commit' mention", () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    // "local commit" appears, but not in the gate's mutation enumeration.
    core: 'A local commit is just a commit. The cwd-vs-claim check runs before any push or merge.\n',
    doctor: HARDENED_DOCTOR,
  });
  assert.deepEqual(missing, [
    'overview-core cwd-vs-claim local-commit coverage',
  ]);
});

test("findMissingWorktreeHardening accepts the opening '(local commit,' enumeration", () => {
  assert.deepEqual(
    findMissingWorktreeHardening({
      work: HARDENED_WORK,
      core: 'The cwd-vs-claim gate covers (local commit, claim heartbeat, push, merge).\n',
      doctor: HARDENED_DOCTOR,
    }),
    [],
  );
});

test('findMissingWorktreeHardening flags a missing cwd-vs-claim gate', () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: 'no gate at all\n',
    doctor: HARDENED_DOCTOR,
  });
  assert.deepEqual(missing, ['overview-core cwd-vs-claim gate']);
});

test('findMissingWorktreeHardening flags a vendored idd-doctor without the detector', () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: HARDENED_CORE,
    doctor: 'function somethingElse() {}\n',
  });
  assert.deepEqual(missing, ['idd-doctor checkPrimaryWorktreeHead detector']);
});

test('findMissingWorktreeHardening skips absent files instead of reporting them', () => {
  // null/undefined (file not present) must not be treated as a stale signal.
  assert.deepEqual(
    findMissingWorktreeHardening({ work: null, core: null, doctor: null }),
    [],
  );
  assert.deepEqual(findMissingWorktreeHardening({}), []);
});

test('classifyPrimaryHead honors custom branchPatterns', () => {
  // A custom pattern matches → violation, reported as a generic
  // implementation branch.
  assert.deepEqual(classifyPrimaryHead('release/1', ['release/*']), {
    isB1Violation: true,
    kind: 'implementation',
  });
  // The default issue/* is no longer guarded when patterns are overridden.
  assert.deepEqual(classifyPrimaryHead('issue/9', ['release/*']), {
    isB1Violation: false,
    kind: 'other',
  });
  // Default prefixes keep their familiar kind labels.
  assert.deepEqual(classifyPrimaryHead('issue/9', ['issue/*']), {
    isB1Violation: true,
    kind: 'issue',
  });
  // kind is derived from the matched pattern, not the branch name: a
  // catch-all glob reports a generic implementation branch even for an
  // issue/ branch.
  assert.deepEqual(classifyPrimaryHead('issue/9', ['*']), {
    isB1Violation: true,
    kind: 'implementation',
  });
});

test('classifyPrimaryHead supports bracket-expression globs like the hook', () => {
  assert.equal(
    classifyPrimaryHead('release/1', ['release/[0-9]*']).isB1Violation,
    true,
  );
  assert.equal(
    classifyPrimaryHead('release/x', ['release/[0-9]*']).isB1Violation,
    false,
  );
  // Negated bracket expression ([!…]).
  assert.equal(
    classifyPrimaryHead('wip/a', ['wip/[!0-9]']).isB1Violation,
    true,
  );
  assert.equal(
    classifyPrimaryHead('wip/5', ['wip/[!0-9]']).isB1Violation,
    false,
  );
});

test('classifyWorktreeHeadFinding labels a custom implementation branch', () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: 'implementation' },
    'release/1',
    '/repo',
    true,
  );
  assert.match(finding?.message ?? '', /an implementation branch/);
});

test('readWorktreeGuardBranchPatterns returns config patterns or the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-bp-'));
  try {
    const write = (obj: unknown) => {
      mkdirSync(join(dir, '.github/idd'), { recursive: true });
      writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify(obj));
    };
    write({ worktreeGuard: { branchPatterns: ['release/*', 'wip/*'] } });
    assert.deepEqual(readWorktreeGuardBranchPatterns(dir), [
      'release/*',
      'wip/*',
    ]);
    write({ worktreeGuard: { enabled: true } }); // no branchPatterns → default
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    write({ worktreeGuard: { branchPatterns: [] } }); // empty array → default
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    write({ worktreeGuard: { branchPatterns: ['', 'issue/*'] } }); // empty entry → default
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
    write({ worktreeGuard: { branchPatterns: ['   '] } }); // whitespace-only → default
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeGuardBranchPatterns defaults when config is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-bp-'));
  try {
    assert.deepEqual(
      readWorktreeGuardBranchPatterns(dir),
      DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeWindowStartIso subtracts the given number of days from now', () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0);
  assert.equal(computeWindowStartIso(now, 14), '2026-05-07T12:00:00.000Z');
  assert.equal(computeWindowStartIso(now, 1), '2026-05-20T12:00:00.000Z');
  assert.equal(computeWindowStartIso(now, 7), '2026-05-14T12:00:00.000Z');
});

test('computeWindowStartIso returns null for non-positive or non-finite windows', () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0);
  assert.equal(computeWindowStartIso(now, 0), null);
  assert.equal(computeWindowStartIso(now, -1), null);
  assert.equal(computeWindowStartIso(now, 'abc'), null);
  assert.equal(computeWindowStartIso(now, NaN), null);
  assert.equal(computeWindowStartIso(now, Infinity), null);
});

test('formatCleanupBacklogScan* produce the expected progress wording', () => {
  assert.equal(
    formatCleanupBacklogScanPreamble(3),
    'post-merge cleanup backlog: scanning 3 merged PRs for F4 cleanup evidence…',
  );
  // Singular for exactly one PR.
  assert.equal(
    formatCleanupBacklogScanPreamble(1),
    'post-merge cleanup backlog: scanning 1 merged PR for F4 cleanup evidence…',
  );
  assert.equal(
    formatCleanupBacklogScanProgress(2, 10, 42),
    '  [2/10] merged PR #42',
  );
});

test('emitCleanupBacklogProgress writes to stderr, keeping --json stdout clean', () => {
  // Capture both streams: the progress line must land on stderr and stdout
  // (which carries the --json report) must stay untouched.
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    // Default sink is process.stderr.
    emitCleanupBacklogProgress('  [1/2] merged PR #7');
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  }
  assert.deepEqual(stderrChunks, ['  [1/2] merged PR #7\n']);
  assert.deepEqual(stdoutChunks, []);
});

test('emitCleanupBacklogProgress writes to an injected sink verbatim', () => {
  const sink: string[] = [];
  emitCleanupBacklogProgress('preamble', {
    write: (chunk) => sink.push(chunk),
  });
  assert.deepEqual(sink, ['preamble\n']);
});

test('classifyBacklog warns only when count strictly exceeds the threshold', () => {
  assert.deepEqual(classifyBacklog([], 2), {
    count: 0,
    warn: false,
    examples: [],
  });
  assert.deepEqual(classifyBacklog([100], 2), {
    count: 1,
    warn: false,
    examples: [100],
  });
  assert.deepEqual(classifyBacklog([100, 101], 2), {
    count: 2,
    warn: false,
    examples: [100, 101],
  });
  assert.deepEqual(classifyBacklog([100, 101, 102], 2), {
    count: 3,
    warn: true,
    examples: [100, 101, 102],
  });
});

test('classifyBacklog caps examples at 5 entries', () => {
  const verdict = classifyBacklog([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);
  assert.equal(verdict.count, 10);
  assert.equal(verdict.warn, true);
  assert.deepEqual(verdict.examples, [1, 2, 3, 4, 5]);
});

test('classifyBacklog treats non-array input as zero', () => {
  assert.deepEqual(classifyBacklog(null, 2), {
    count: 0,
    warn: false,
    examples: [],
  });
  assert.deepEqual(classifyBacklog(undefined, 2), {
    count: 0,
    warn: false,
    examples: [],
  });
  assert.deepEqual(classifyBacklog('not an array', 2), {
    count: 0,
    warn: false,
    examples: [],
  });
});

test('classifyBacklog coerces non-numeric / NaN / negative thresholds to 0', () => {
  // Any positive count must warn when the threshold is unusable.
  assert.equal(classifyBacklog([1], 'not a number').warn, true);
  assert.equal(classifyBacklog([1], NaN).warn, true);
  assert.equal(classifyBacklog([1], Infinity).warn, true);
  assert.equal(classifyBacklog([1], -5).warn, true);
  // Zero count must not warn even with a broken threshold.
  assert.equal(classifyBacklog([], NaN).warn, false);
});

test('computeWindowStartIso returns null for windows that overflow Date range', () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0);
  // ~1e9 days is well past the ±100,000,000-day toISOString limit and
  // would historically throw RangeError before this guard landed.
  assert.equal(computeWindowStartIso(now, 1e9), null);
  assert.equal(computeWindowStartIso(now, Number.MAX_SAFE_INTEGER), null);
});

test('classifyReleaseTagDrift skips silently when no tag is reachable from HEAD', () => {
  // A fresh adopter clone before its first release (or a repo with no
  // tags at all) must never warn or crash.
  const verdict = classifyReleaseTagDrift(null, 500, 200);
  assert.equal(verdict.warn, false);
  assert.equal(verdict.message, undefined);
});

test('classifyReleaseTagDrift does not warn when a tag is within both thresholds', () => {
  const verdict = classifyReleaseTagDrift('v1.0.0', 50, 10);
  assert.equal(verdict.warn, false);
  assert.equal(verdict.message, undefined);
});

test('classifyReleaseTagDrift warns when past the commit threshold only', () => {
  const verdict = classifyReleaseTagDrift('v1.0.0', 150, 10);
  assert.equal(verdict.warn, true);
  assert.match(verdict.message ?? '', /150 commit\(s\) \(> 100\)/);
  assert.doesNotMatch(verdict.message ?? '', /day\(s\)/);
  assert.match(verdict.message ?? '', /v1\.0\.0/);
});

test('classifyReleaseTagDrift warns when past the day threshold only', () => {
  const verdict = classifyReleaseTagDrift('v1.0.0', 50, 60);
  assert.equal(verdict.warn, true);
  assert.match(verdict.message ?? '', /60 day\(s\) \(> 45\)/);
  assert.doesNotMatch(verdict.message ?? '', /commit\(s\)/);
});

test('classifyReleaseTagDrift warns on both thresholds and names both in the message', () => {
  const verdict = classifyReleaseTagDrift('v1.0.0', 636, 60);
  assert.equal(verdict.warn, true);
  assert.match(verdict.message ?? '', /commit\(s\).*and.*day\(s\)/);
});

test('classifyReleaseTagDrift treats the threshold boundary as non-warning ("more than", not "at least")', () => {
  const atCommitThreshold = classifyReleaseTagDrift('v1.0.0', 100, 10);
  const atDayThreshold = classifyReleaseTagDrift('v1.0.0', 50, 45);
  assert.equal(atCommitThreshold.warn, false);
  assert.equal(atDayThreshold.warn, false);
});

test('classifyReleaseTagDrift coerces non-numeric commit/day values to 0', () => {
  const verdict = classifyReleaseTagDrift('v1.0.0', 'not a number', NaN);
  assert.equal(verdict.warn, false);
});

test('classifyReleaseTagDrift rounds the printed day count up, never down to the threshold', () => {
  // A floor here would print "45 day(s) (> 45)", which reads as
  // self-contradictory since 45 is not greater than 45.
  const verdict = classifyReleaseTagDrift('v1.0.0', 50, 45.1);
  assert.equal(verdict.warn, true);
  assert.match(verdict.message ?? '', /46 day\(s\) \(> 45\)/);
  assert.doesNotMatch(verdict.message ?? '', /45 day\(s\)/);
});

test('containsWorkshopReference accepts canonical, dotted, and absolute link targets', () => {
  assert.equal(
    containsWorkshopReference('see [workshop](docs/workshop/README.md)'),
    true,
  );
  assert.equal(
    containsWorkshopReference('see [workshop](./docs/workshop/)'),
    true,
  );
  assert.equal(
    containsWorkshopReference('see [workshop](/docs/workshop/README.md#intro)'),
    true,
  );
});

test('containsWorkshopReference accepts docs/index.md-relative workshop links', () => {
  // docs/index.md naturally links with `workshop/README.md` because
  // it lives inside docs/ itself. The cross-ref check must accept
  // this shape too.
  assert.equal(
    containsWorkshopReference('see [workshop](workshop/README.md)'),
    true,
  );
  assert.equal(containsWorkshopReference('see [workshop](./workshop/)'), true);
});

test('containsWorkshopReference accepts single-quoted and parenthesized title forms', () => {
  assert.equal(
    containsWorkshopReference("[w](docs/workshop/README.md 'title')"),
    true,
  );
  assert.equal(
    containsWorkshopReference('[w](docs/workshop/README.md (title))'),
    true,
  );
});

test('containsWorkshopReference ignores workshop links inside fenced code blocks', () => {
  const md =
    'Demo:\n```md\n[workshop](docs/workshop/README.md)\n```\nreal prose';
  assert.equal(containsWorkshopReference(md), false);
});

test('containsWorkshopReference also ignores tilde-fence code blocks', () => {
  const md =
    'Demo:\n~~~md\n[workshop](docs/workshop/README.md)\n~~~\nreal prose';
  assert.equal(containsWorkshopReference(md), false);
});

test('containsWorkshopReference rejects unrelated targets and empty content', () => {
  assert.equal(containsWorkshopReference('see [other](docs/index.md)'), false);
  assert.equal(containsWorkshopReference('plain prose without links'), false);
  assert.equal(containsWorkshopReference(''), false);
  assert.equal(containsWorkshopReference(null), false);
  assert.equal(containsWorkshopReference(undefined), false);
});

test('findMissingWorkshopReferences names entry files lacking workshop links', () => {
  const entries = [
    { path: 'README.md', content: 'see [workshop](docs/workshop/README.md)' },
    {
      path: 'README.ja.md',
      content: 'ワークショップは [こちら](docs/workshop/)',
    },
    { path: 'docs/index.md', content: 'no workshop link here' },
  ];
  assert.deepEqual(findMissingWorkshopReferences(entries, []), [
    'docs/index.md',
  ]);
});

test('findMissingWorkshopReferences flags all three entries when none link the workshop', () => {
  const entries = [
    { path: 'README.md', content: 'no link' },
    { path: 'README.ja.md', content: 'リンクなし' },
    { path: 'docs/index.md', content: 'no link' },
  ];
  assert.deepEqual(findMissingWorkshopReferences(entries, []), [
    'README.md',
    'README.ja.md',
    'docs/index.md',
  ]);
});

test('findMissingWorkshopReferences flags missing entry-point files (content: null)', () => {
  const entries = [
    { path: 'README.md', content: null },
    { path: 'README.ja.md', content: 'see [workshop](docs/workshop/)' },
  ];
  // Missing required entry-point file is a real warning signal —
  // an adopter who removes README.md needs to know the workshop
  // cross-reference is also gone.
  assert.deepEqual(findMissingWorkshopReferences(entries, []), ['README.md']);
});

test('findMissingWorkshopReferences honors allow-missing for genuinely absent files', () => {
  const entries = [
    { path: 'README.md', content: null },
    { path: 'README.ja.md', content: 'see [workshop](docs/workshop/)' },
  ];
  // If the adopter intentionally has no README.md, allow-missing
  // suppresses the warning.
  assert.deepEqual(findMissingWorkshopReferences(entries, ['README.md']), []);
});

test('findMissingWorkshopReferences honors the allow-missing list', () => {
  const entries = [
    { path: 'README.md', content: 'no link' },
    { path: 'README.ja.md', content: 'see [workshop](docs/workshop/)' },
    { path: 'docs/index.md', content: 'no link' },
  ];
  assert.deepEqual(
    findMissingWorkshopReferences(entries, ['README.md', 'docs/index.md']),
    [],
  );
});

test('backLinkPatternFor escapes special regex characters in the slug', () => {
  // Slug carries real regex metacharacters so a missing escape would
  // change the match semantics. Pattern is anchored to `^/<slug>`
  // and tested against URL pathnames only.
  const pattern = backLinkPatternFor('foo.bar/repo+x');
  assert.equal(
    pattern.test('/foo.bar/repo+x/blob/main/docs/workshop/README.md'),
    true,
  );
  // A path that differs in the metacharacter positions must not
  // match (unescaped `.` would match any char and unescaped `+`
  // would require one or more `o`).
  assert.equal(
    pattern.test('/different-org/different-repo/docs/workshop/'),
    false,
  );
});

test('backLinkPatternFor rejects fork-suffixed slugs that share a prefix', () => {
  const pattern = backLinkPatternFor('kurone-kito/idd-skill');
  assert.equal(
    pattern.test('/kurone-kito/idd-skill/blob/main/docs/workshop/README.md'),
    true,
  );
  assert.equal(
    pattern.test(
      '/kurone-kito/idd-skill-fork/blob/main/docs/workshop/README.md',
    ),
    false,
  );
});

test('backLinkPatternFor requires the slug at the start of pathname (no host-suffix matches)', () => {
  // URL path under a different repo whose name happens to end with
  // the configured slug. The anchored regex must NOT match.
  const pattern = backLinkPatternFor('me/repo');
  assert.equal(
    pattern.test('/acme/me/repo/blob/main/docs/workshop/README.md'),
    false,
  );
  assert.equal(
    pattern.test('/me/repo/blob/main/docs/workshop/README.md'),
    true,
  );
});

test('backLinkPatternFor requires a path separator after the slug (no slug+docs concatenation)', () => {
  // Pathological case from review: pathname concatenates slug and
  // docs/workshop without an intermediate `/`. The actual repo
  // would be `kurone-kito/idd-skilldocs` which is a different
  // repository; the regex must NOT match.
  const pattern = backLinkPatternFor('kurone-kito/idd-skill');
  assert.equal(
    pattern.test('/kurone-kito/idd-skilldocs/workshop/README.md'),
    false,
  );
});

test('backLinkPatternFor requires a path boundary after docs/workshop', () => {
  const pattern = backLinkPatternFor('kurone-kito/idd-skill');
  // Valid: trailing slash, anchor, query, or end-of-string.
  assert.equal(
    pattern.test('/kurone-kito/idd-skill/blob/main/docs/workshop/'),
    true,
  );
  assert.equal(
    pattern.test('/kurone-kito/idd-skill/tree/main/docs/workshop'),
    true,
  );
  // Invalid: docs/workshops, docs/workshop-old.
  assert.equal(
    pattern.test('/kurone-kito/idd-skill/blob/main/docs/workshops/README.md'),
    false,
  );
  assert.equal(
    pattern.test(
      '/kurone-kito/idd-skill/blob/main/docs/workshop-old/README.md',
    ),
    false,
  );
});

test('containsExampleRepoBackLink accepts canonical blob/main link to docs/workshop', () => {
  const md =
    'Read the [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md).';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink accepts tree/main and deep-link with anchor', () => {
  const tree =
    'Tutorial: [link](https://github.com/kurone-kito/idd-skill/tree/main/docs/workshop)';
  const anchored =
    'More: [link](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md#prerequisites)';
  assert.equal(
    containsExampleRepoBackLink(tree, 'kurone-kito/idd-skill'),
    true,
  );
  assert.equal(
    containsExampleRepoBackLink(anchored, 'kurone-kito/idd-skill'),
    true,
  );
});

test('containsExampleRepoBackLink accepts raw.githubusercontent.com workshop links', () => {
  const md =
    'Reference: [raw](https://raw.githubusercontent.com/kurone-kito/idd-skill/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink rejects when only the slug appears (no docs/workshop path)', () => {
  const md =
    'Built with [idd-skill](https://github.com/kurone-kito/idd-skill).';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink rejects when only docs/workshop appears (no slug)', () => {
  const md =
    'See [workshop](https://github.com/other-org/other-repo/blob/main/docs/workshop/README.md).';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink handles empty / null / undefined content', () => {
  assert.equal(containsExampleRepoBackLink('', 'x/y'), false);
  assert.equal(containsExampleRepoBackLink(null, 'x/y'), false);
  assert.equal(containsExampleRepoBackLink(undefined, 'x/y'), false);
});

test('containsExampleRepoBackLink ignores URLs inside fenced code blocks', () => {
  const md =
    '```md\n[ex](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n```';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores URLs inside HTML comments', () => {
  const md =
    '<!-- https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md -->\nplain prose';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores URLs inside inline code spans', () => {
  const md =
    'see `https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md` for example';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores URLs inside indented code blocks', () => {
  const md =
    'code:\n\n    https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n\nafter';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores URLs inside unterminated fenced blocks', () => {
  const md =
    'before\n```\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores URLs that appear only in query strings (e.g., redirect=...)', () => {
  const md =
    'Click [trap](https://example.com/?redirect=https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink preserves links inside nested-list continuation lines (not blank-separated)', () => {
  const md =
    '- top\n    - sub: [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink preserves links inside blank-separated nested list items', () => {
  // Loose-list shape: each list item separated by blank lines. The
  // indented continuation line is a list item (starts with `- `),
  // not a code block.
  const md =
    '- top\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink ignores a list-marker line inside an open indented code block', () => {
  // The indented `- [workshop](...)` line is a continuation of the open
  // indented code block started by `code line`, not a list item: per
  // CommonMark a list cannot start inside an open indented code block
  // without an intervening blank line. It must not produce a false pass.
  const md =
    'paragraph\n\n    code line\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores reference-style image destinations (absolute and root-relative)', () => {
  const absolute =
    '![badge][b]\n\n[b]: https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  const rootRelative =
    '![badge][b]\n\n[b]: /kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  // Shortcut form `![b]` resolves to the same `[b]:` definition.
  const shortcut =
    '![b]\n\n[b]: https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  assert.equal(
    containsExampleRepoBackLink(absolute, 'kurone-kito/idd-skill'),
    false,
  );
  assert.equal(
    containsExampleRepoBackLink(rootRelative, 'kurone-kito/idd-skill'),
    false,
  );
  assert.equal(
    containsExampleRepoBackLink(shortcut, 'kurone-kito/idd-skill'),
    false,
  );
});

test('containsExampleRepoBackLink keeps counting a real reference-style link', () => {
  // A reference *link* (no leading `!`) is navigation, so its definition
  // is still scanned even though a reference *image* would be excluded.
  const md =
    'See the [workshop guide][w].\n\n[w]: https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink keeps a code block open across an internal blank line', () => {
  // CommonMark §4.4: an indented code block survives a blank line between
  // indented chunks. The post-blank `- [workshop](...)` line is still
  // code, so it must not produce a false back-link pass.
  const md =
    'paragraph\n\n    code line\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink keeps a shared image/link reference definition', () => {
  // The label `shared` is used by both a reference image and a real
  // reference link, so its definition must NOT be dropped — the link
  // still counts as a navigation back-link.
  const md =
    '![badge][shared] and [the workshop][shared].\n\n[shared]: https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink keeps a definition shared by an image and a shortcut link', () => {
  // `shared` is used by a reference image and a *shortcut* reference link
  // (`[shared]`). The shortcut link still counts, so the definition must
  // not be dropped.
  const md =
    '![badge][shared] — see [shared] for details.\n\n[shared]: https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink treats a top-level indented list-marker line as code', () => {
  // With no list open, a >=4-space indented `- ...` line after a blank is
  // an indented code block (CommonMark), not a list item, so a workshop
  // URL there must not produce a false back-link pass.
  const md =
    'paragraph\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink ignores an indented code block nested inside a list item', () => {
  // The list item content sits at column 2; a blank-separated line indented
  // >= 6 columns (8 here) is an indented code block within the item
  // (CommonMark), not list content, so a workshop URL there must not
  // produce a false back-link pass.
  const md =
    '- item\n\n        [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink keeps a real nested list item under a list (not code)', () => {
  // Regression guard for the nested-code fix: a 4-column nested list item
  // under a `- ` parent (content column 2) is within `2 + 4`, so it stays
  // a list item and its back-link still counts.
  const md =
    '- parent\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink still detects list-item paragraph back-links after the nested-code fix', () => {
  // A back-link in ordinary list-item paragraph text (indented to the
  // content column, below the nested-code threshold) must still count.
  const md =
    '- See the [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n  for details.\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink measures a tab after a list marker as columns', () => {
  // `-\t` has content column 1 (`-`) + 4 (tab) = 5, so a 7-column-indented
  // back-link is list content (< 5 + 4), not a nested code block. With the
  // old character-length content column (2) the threshold would be 6 and
  // the 7-column line would be mis-blanked as code.
  const md =
    '-\titem\n\n       [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink does not open a list for a deeply-indented mid-paragraph marker', () => {
  // A `- ` marker indented >=4 columns mid-paragraph (no list open) is
  // paragraph continuation, not a list item. It must not keep a list level
  // open across the later blank and shield the following top-level indented
  // code block from being blanked (which would reintroduce a false pass).
  const md =
    'text\n    - foo\n\n        [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink keeps a back-link in an outer list item after an inner list ends', () => {
  // Multi-level lists: after the inner list and its paragraph dedent back
  // to the outer item, the back-link sits in a nested item of the still
  // open outer list (content column 2), not a top-level code block, so it
  // must still count. (Single-level list tracking would lose the outer
  // context here and blank it.)
  const md =
    '- outer\n  - inner\n  text after inner\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink rejects URL whose host is not a GitHub host', () => {
  const md =
    '[trap](https://example.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink accepts raw.githubusercontent.com host', () => {
  const md =
    '[raw](https://raw.githubusercontent.com/kurone-kito/idd-skill/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink accepts enterprise host only when IDD_WORKSHOP_BACKLINK_HOSTS is set', () => {
  const md =
    '[enterprise](https://github.acme.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  // Without the env var, the heuristic must NOT accept arbitrary
  // hosts with "github" in the name (that was the github.evil.com
  // bypass).
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
  try {
    delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
    assert.equal(
      containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'),
      false,
    );
    process.env.IDD_WORKSHOP_BACKLINK_HOSTS = 'github.acme.com';
    assert.equal(
      containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'),
      true,
    );
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev;
  }
});

test('containsExampleRepoBackLink accepts root-relative inline link targets', () => {
  const md =
    '[workshop](/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink rejects URLs that appear only as image destinations', () => {
  // `![badge](...)` is an image, not a navigational link. The
  // back-link contract is about navigation, not presence of the
  // URL anywhere on the page.
  const md =
    '![badge](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('containsExampleRepoBackLink accepts a real navigation link even when the same URL also appears as an image', () => {
  const md = `![badge](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n\n[Read the workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)`;
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink accepts root-relative reference-definition targets', () => {
  const md =
    'Link: [workshop][w]\n\n[w]: /kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink accepts root-relative targets with leading whitespace and angle brackets', () => {
  // CommonMark allows optional whitespace before the destination
  // inside `(   /...)` and angle-bracket-wrapped destinations
  // `(</...>)`.
  const indented =
    '[workshop](   /kurone-kito/idd-skill/blob/main/docs/workshop/README.md)';
  const angled =
    '[workshop](</kurone-kito/idd-skill/blob/main/docs/workshop/README.md>)';
  const refAngled =
    '[w]\n\n[w]: </kurone-kito/idd-skill/blob/main/docs/workshop/README.md>';
  assert.equal(
    containsExampleRepoBackLink(indented, 'kurone-kito/idd-skill'),
    true,
  );
  assert.equal(
    containsExampleRepoBackLink(angled, 'kurone-kito/idd-skill'),
    true,
  );
  assert.equal(
    containsExampleRepoBackLink(refAngled, 'kurone-kito/idd-skill'),
    true,
  );
});

test('isGithubBackLinkHost honors IDD_WORKSHOP_BACKLINK_HOSTS env override', () => {
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
  try {
    process.env.IDD_WORKSHOP_BACKLINK_HOSTS = 'git.internal,scm.acme';
    assert.equal(isGithubBackLinkHost('git.internal'), true);
    assert.equal(isGithubBackLinkHost('scm.acme'), true);
    assert.equal(isGithubBackLinkHost('unrelated.example'), false);
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev;
  }
});

test('isGithubBackLinkHost rejects brand-prefix lookalikes like github.evil.com', () => {
  assert.equal(isGithubBackLinkHost('github.evil.com'), false);
  assert.equal(isGithubBackLinkHost('notgithub.com'), false);
  assert.equal(isGithubBackLinkHost('github.com.evil'), false);
});

test('isGithubBackLinkHost rejects unrelated github.com subdomains', () => {
  // *.github.com is too permissive (docs.github.com, api.github.com
  // do not host repositories). Restricted to the public-host
  // whitelist + explicit IDD_WORKSHOP_BACKLINK_HOSTS opt-in.
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
  try {
    delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
    assert.equal(isGithubBackLinkHost('docs.github.com'), false);
    assert.equal(isGithubBackLinkHost('api.github.com'), false);
    assert.equal(isGithubBackLinkHost('subdomain.github.com'), false);
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS;
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev;
  }
});

test('containsExampleRepoBackLink strips trailing sentence punctuation from URLs', () => {
  const md =
    'See https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md.';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink preserves ordered-list items with paren markers (1)', () => {
  const md =
    '1. top\n\n    1) [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), true);
});

test('stripMarkdownNonText leaves backtick-fence-shaped lines with backtick info strings as content', () => {
  // CommonMark forbids backticks in a backtick-fence info string,
  // so a line like ``` invalid `info ``` is plain text, not a
  // fence opener. URLs that follow such a line must still be
  // scanned.
  const md =
    'before\n``` invalid ` info\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n';
  const stripped = stripMarkdownNonText(md);
  assert.equal(stripped.includes('github.com/kurone-kito/idd-skill'), true);
});

test('containsExampleRepoBackLink accepts CommonMark fence variations (indented opener, longer closer)', () => {
  const md =
    '  ```\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n````\n';
  assert.equal(containsExampleRepoBackLink(md, 'kurone-kito/idd-skill'), false);
});

test('stripMarkdownNonText removes fenced, indented, span, and HTML comment regions', () => {
  const md = `before
\`\`\`
fenced
\`\`\`
inline \`code\` span
<!-- comment -->

    indented code line

after`;
  const stripped = stripMarkdownNonText(md);
  assert.equal(stripped.includes('fenced'), false);
  assert.equal(
    stripped.includes('inline  span') || stripped.includes('inline span'),
    true,
  );
  assert.equal(stripped.includes('comment'), false);
  assert.equal(stripped.includes('indented code line'), false);
  assert.equal(stripped.includes('before'), true);
  assert.equal(stripped.includes('after'), true);
});

test('decodeGithubReadmeBase64 decodes a typical GitHub content payload', () => {
  const original = '# Hello\n\nlink: https://example.com\n';
  const encoded = Buffer.from(original, 'utf8').toString('base64');
  assert.equal(decodeGithubReadmeBase64(encoded), original);
  // GitHub's API returns base64 with newlines every 60 chars; the
  // decoder should tolerate that.
  const wrapped = encoded.replace(/(.{60})/g, '$1\n');
  assert.equal(decodeGithubReadmeBase64(wrapped), original);
});

test('decodeGithubReadmeBase64 returns null for empty, null, or non-base64 input', () => {
  assert.equal(decodeGithubReadmeBase64(''), null);
  assert.equal(decodeGithubReadmeBase64('   \n  '), null);
  assert.equal(decodeGithubReadmeBase64(null), null);
  assert.equal(decodeGithubReadmeBase64(undefined), null);
  assert.equal(decodeGithubReadmeBase64('not_valid_base64!!'), null);
});

test('decodeGithubReadmeBase64 rejects literal jq-null and non-multiple-of-4 lengths', () => {
  // `gh api --jq .content` prints the literal `null` when the JSON
  // path does not exist (e.g., README not found via the /readme
  // endpoint). Must not decode to garbage.
  assert.equal(decodeGithubReadmeBase64('null'), null);
  assert.equal(decodeGithubReadmeBase64('null\n'), null);
  // Base64 strings are always a multiple of 4 chars (with padding).
  assert.equal(decodeGithubReadmeBase64('abc'), null);
  assert.equal(decodeGithubReadmeBase64('abcde'), null);
});

// Minimal Project commands table (parseProjectCommandRows reads
// `| **name** | `cmd` |` rows). At least one non-`true` value avoids the
// all-no-op warning path.
const PROJECT_COMMANDS_TABLE = [
  '| Name | Commands |',
  '| --- | --- |',
  '| **fix-validate** | `npx dprint fmt` |',
  '| **pre-push-validate** | `npx dprint check` |',
  '| **post-fix-validate** | `npx dprint fmt` |',
  '| **install-deps** | `true` |',
  '',
].join('\n');

function makeOverviewFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-pc-'));
  mkdirSync(join(dir, '.github/instructions'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, '.github/instructions', name), text);
  }
  return dir;
}

const emptyReport = (root: string) => ({
  root,
  errors: [] as string[],
  warnings: [] as string[],
  passes: [] as string[],
});

test('checkProjectCommands reads the table from idd-overview-core', () => {
  const dir = makeOverviewFixture({
    'idd-overview-core.instructions.md': PROJECT_COMMANDS_TABLE,
  });
  try {
    const report = emptyReport(dir);
    const commands = checkProjectCommands(dir, report);
    assert.ok(commands instanceof Map);
    assert.equal(commands?.get('fix-validate'), 'npx dprint fmt');
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkProjectCommands falls back to idd-overview on a router/core split', () => {
  // core is a router with no commands table; the table lives in idd-overview.
  const dir = makeOverviewFixture({
    'idd-overview-core.instructions.md':
      '# Router\n\nNo commands table here.\n',
    'idd-overview.instructions.md': PROJECT_COMMANDS_TABLE,
  });
  try {
    const report = emptyReport(dir);
    const commands = checkProjectCommands(dir, report);
    assert.ok(commands instanceof Map);
    assert.equal(commands?.get('install-deps'), 'true');
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkProjectCommands errors when no overview file carries the table', () => {
  const dir = makeOverviewFixture({
    'idd-overview-core.instructions.md': '# Router\n\nNo table.\n',
  });
  try {
    const report = emptyReport(dir);
    const commands = checkProjectCommands(dir, report);
    assert.equal(commands, null);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /cannot find a Project commands table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const THRESHOLDS_SECTION = `## Thresholds

Ownership timing in this workflow uses the policy defaults
\`claim-stale-age\` and \`claim-heartbeat-interval\` listed in
\`docs/policy-constants.md\`.

- **Stale**: an active claim whose latest **valid** \`claimed-by\`
  comment's GitHub \`created_at\` is ≥ 24 h ago. Another session may take
  it over by posting a fresh \`{claim-id}\` whose \`supersedes:\` value is
  that active claim's \`{claim-id}\`.
- **Heartbeat**: after re-validating ownership, re-post the claim
  comment every 12 h while holding or when any phase is expected to
  exceed 12 h. The latest **valid** \`claimed-by\` comment for the same
  \`{claim-id}\` resets the stale clock. Embed timestamps are ignored;
  only the GitHub \`created_at\` of the comment itself counts.

## Fail-closed default

Some other section.
`;

test('parseIsoDurationToHours parses whole-hour and whole-day ISO 8601 durations', () => {
  assert.equal(parseIsoDurationToHours('PT24H'), 24);
  assert.equal(parseIsoDurationToHours('P1D'), 24);
  assert.equal(parseIsoDurationToHours('PT12H'), 12);
});

test('parseIsoDurationToHours returns null for non-string, malformed, zero, and sub-hour values', () => {
  assert.equal(parseIsoDurationToHours(24), null);
  assert.equal(parseIsoDurationToHours(undefined), null);
  assert.equal(parseIsoDurationToHours('not a duration'), null);
  assert.equal(parseIsoDurationToHours('PT0H'), null);
  assert.equal(parseIsoDurationToHours('PT30M'), null);
});

test('parseIsoDurationToHours rejects dangling designators the policy schema also rejects', () => {
  // Regression test: the original regex had no lookaheads, so `P1DT`
  // (a "D" component followed by a dangling "T" with no H/M/S after it)
  // matched and silently resolved to 24h — a schema-invalid value that
  // should be treated as unparseable, not silently normalized.
  assert.equal(parseIsoDurationToHours('P1DT'), null);
  assert.equal(parseIsoDurationToHours('P'), null);
  assert.equal(parseIsoDurationToHours('PT'), null);
});

test('parseThresholdsProseHours extracts the current stale-age and heartbeat-interval hours', () => {
  assert.deepEqual(parseThresholdsProseHours(THRESHOLDS_SECTION), {
    staleAgeHours: 24,
    heartbeatIntervalHours: 12,
  });
});

test('parseThresholdsProseHours returns null when the Thresholds heading is missing', () => {
  assert.equal(
    parseThresholdsProseHours('## Some Other Section\n\nNo thresholds here.\n'),
    null,
  );
});

test('parseThresholdsProseHours degrades per-field when a bullet is reworded past recognition', () => {
  const reworded = `## Thresholds

- **Stale**: claims expire after a while.
- **Heartbeat**: after re-validating ownership, re-post the claim
  comment every 12 h while holding.

## Fail-closed default
`;
  assert.deepEqual(parseThresholdsProseHours(reworded), {
    staleAgeHours: null,
    heartbeatIntervalHours: 12,
  });
});

test('classifyClaimTimingConsistency returns null when config and prose agree (this repo today)', () => {
  assert.equal(
    classifyClaimTimingConsistency(
      { staleAge: 'PT24H', heartbeatInterval: 'PT12H' },
      THRESHOLDS_SECTION,
    ),
    null,
  );
});

test('classifyClaimTimingConsistency warns naming both locations and both values on a seeded mismatch', () => {
  const finding = classifyClaimTimingConsistency(
    { staleAge: 'PT48H', heartbeatInterval: 'PT12H' },
    THRESHOLDS_SECTION,
  );
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /claimTiming\.staleAge is 48 h/);
  assert.match(finding?.message ?? '', /24 h in the Thresholds section/);
  assert.match(finding?.message ?? '', /\.github\/idd\/config\.json/);
  assert.match(
    finding?.message ?? '',
    /\.github\/instructions\/idd-overview-core\.instructions\.md/,
  );
  // heartbeatInterval agrees (12 h both sides), so only staleAge is named.
  assert.doesNotMatch(finding?.message ?? '', /heartbeatInterval/);
});

test('classifyClaimTimingConsistency reports every mismatching anchor, not just the first', () => {
  const finding = classifyClaimTimingConsistency(
    { staleAge: 'PT48H', heartbeatInterval: 'PT6H' },
    THRESHOLDS_SECTION,
  );
  assert.match(finding?.message ?? '', /claimTiming\.staleAge is 48 h/);
  assert.match(finding?.message ?? '', /claimTiming\.heartbeatInterval is 6 h/);
});

test('classifyClaimTimingConsistency skips (no warning, no error) when the section is unparseable', () => {
  assert.equal(
    classifyClaimTimingConsistency(
      { staleAge: 'PT48H', heartbeatInterval: 'PT6H' },
      '# A repo with no Thresholds section at all.\n',
    ),
    null,
  );
});

test('classifyClaimTimingConsistency skips when claimTiming is absent from config', () => {
  assert.equal(
    classifyClaimTimingConsistency(undefined, THRESHOLDS_SECTION),
    null,
  );
});

test('classifyClaimTimingConsistency skips when the config value itself is unparseable', () => {
  assert.equal(
    classifyClaimTimingConsistency(
      { staleAge: 'not-a-duration', heartbeatInterval: 'PT12H' },
      THRESHOLDS_SECTION,
    ),
    null,
  );
});

test("parseThresholdsProseHours does not let one bullet's number leak into the other", () => {
  // Regression test: the anchor regexes must be bounded to their OWN
  // bullet's text. Before the extractBulletText fix, an unbounded
  // [\s\S]*? could cross from a Stale bullet with no "≥ N h" of its own
  // into the Heartbeat bullet's unrelated "≥ 48 h" text, silently
  // misattributing that number as the stale-age value.
  const rewordedWithUnrelatedNumber = `## Thresholds

- **Stale**: claims expire after a while, see policy docs for specifics.
- **Heartbeat**: re-post the claim comment every 12 h while holding;
  note a hard SLA ceiling of ≥ 48 h before escalation applies.

## Fail-closed default
`;
  assert.deepEqual(parseThresholdsProseHours(rewordedWithUnrelatedNumber), {
    staleAgeHours: null,
    heartbeatIntervalHours: 12,
  });
});

test('parseThresholdsProseHours does not let a later bullet leak into an earlier one either', () => {
  const rewordedWithUnrelatedNumber = `## Thresholds

- **Stale**: an active claim is stale ≥ 24 h ago.
- **Heartbeat**: re-post while holding; no fixed cadence stated here.

## Fail-closed default
`;
  assert.deepEqual(parseThresholdsProseHours(rewordedWithUnrelatedNumber), {
    staleAgeHours: 24,
    heartbeatIntervalHours: null,
  });
});

test('parseThresholdsProseHours still bounds bullets correctly when the list is indented', () => {
  // Regression test: the bullet-boundary search originally looked only
  // for the literal "\n- " substring, so an indented sub-list (or a
  // "*"/"+" marker) would not be recognized as a boundary and the slice
  // could run past the intended bullet, re-enabling the cross-bullet
  // leak this file's other regression tests guard against.
  const indented = `## Thresholds

  - **Stale**: claims expire after a while, no number stated here.
  - **Heartbeat**: re-post the claim comment every 12 h while holding.

## Fail-closed default
`;
  assert.deepEqual(parseThresholdsProseHours(indented), {
    staleAgeHours: null,
    heartbeatIntervalHours: 12,
  });
});

test('checkClaimTimingConsistency pushes a warning when config and prose disagree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-claim-timing-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        claimTiming: { staleAge: 'PT48H', heartbeatInterval: 'PT12H' },
      }),
    );
    mkdirSync(join(dir, '.github/instructions'), { recursive: true });
    writeFileSync(
      join(dir, '.github/instructions/idd-overview-core.instructions.md'),
      THRESHOLDS_SECTION,
    );

    const report = emptyReport(dir);
    checkClaimTimingConsistency(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /claimTiming\.staleAge is 48 h/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkClaimTimingConsistency pushes no warning when config and prose agree, or when a file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-claim-timing-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        claimTiming: { staleAge: 'PT24H', heartbeatInterval: 'PT12H' },
      }),
    );
    mkdirSync(join(dir, '.github/instructions'), { recursive: true });
    writeFileSync(
      join(dir, '.github/instructions/idd-overview-core.instructions.md'),
      THRESHOLDS_SECTION,
    );

    const agreeingReport = emptyReport(dir);
    checkClaimTimingConsistency(dir, agreeingReport);
    assert.equal(agreeingReport.warnings.length, 0);
    assert.equal(agreeingReport.errors.length, 0);

    // No config.json at all: this check is not the file-presence gate —
    // it skips rather than erroring.
    rmSync(join(dir, '.github/idd/config.json'));
    const missingConfigReport = emptyReport(dir);
    checkClaimTimingConsistency(dir, missingConfigReport);
    assert.equal(missingConfigReport.warnings.length, 0);
    assert.equal(missingConfigReport.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');
const VALID_POLICY_CONFIG = loadJson(
  'fixtures/schemas/policy.valid.json',
) as Record<string, unknown>;

test('classifyLiveConfigSchemaFinding returns null for a schema-valid config', () => {
  assert.equal(
    classifyLiveConfigSchemaFinding(VALID_POLICY_CONFIG, POLICY_SCHEMA),
    null,
  );
});

test('classifyLiveConfigSchemaFinding reports an unknown top-level key', () => {
  const config = { ...VALID_POLICY_CONFIG, _note: 'adopter comment' };
  const finding = classifyLiveConfigSchemaFinding(config, POLICY_SCHEMA);
  assert.ok(finding);
  assert.equal(finding?.level, 'error');
  assert.match(finding?.message ?? '', /fails schema validation/);
  assert.match(
    finding?.message ?? '',
    /additional property "_note" not allowed/,
  );
});

test('classifyLiveConfigSchemaFinding reports every error, not just the first', () => {
  const config = {
    ...VALID_POLICY_CONFIG,
    mergePolicy: 'not-a-real-policy',
    reviewPolicy: 'not-a-real-review-policy',
  };
  const finding = classifyLiveConfigSchemaFinding(config, POLICY_SCHEMA);
  assert.ok(finding);
  assert.match(finding?.message ?? '', /mergePolicy/);
  assert.match(finding?.message ?? '', /reviewPolicy/);
});

test('checkLiveConfigSchema reports a finding for an unknown-key live config (fixture)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-live-config-schema-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ ...VALID_POLICY_CONFIG, _note: 'adopter comment' }),
    );

    const report = emptyReport(dir);
    checkLiveConfigSchema(dir, report);
    assert.equal(report.errors.length, 1);
    assert.match(
      report.errors[0],
      /\.github\/idd\/config\.json fails schema validation/,
    );
    assert.match(report.errors[0], /additional property "_note" not allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLiveConfigSchema passes for a schema-valid live config and skips when absent or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-live-config-schema-ok-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify(VALID_POLICY_CONFIG),
    );

    const validReport = emptyReport(dir);
    checkLiveConfigSchema(dir, validReport);
    assert.equal(validReport.errors.length, 0);
    assert.ok(
      validReport.passes.some((line) =>
        line.includes('validates against policy.schema.json'),
      ),
    );

    // Malformed JSON: already reported by checkHelperRuntimeConfig, so this
    // check skips silently rather than double-reporting.
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    const malformedReport = emptyReport(dir);
    checkLiveConfigSchema(dir, malformedReport);
    assert.equal(malformedReport.errors.length, 0);
    assert.equal(malformedReport.warnings.length, 0);

    // No config.json at all: nothing to validate.
    rmSync(join(dir, '.github/idd/config.json'));
    const missingReport = emptyReport(dir);
    checkLiveConfigSchema(dir, missingReport);
    assert.equal(missingReport.errors.length, 0);
    assert.equal(missingReport.warnings.length, 0);
    assert.equal(missingReport.passes.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MINIMAL_LOCKFILE_WITH_DEPS = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@commitlint/cli':
        specifier: ^21.0.2
        version: 21.2.0(@types/node@26.1.0)(conventional-commits-parser@6.4.0)(typescript@6.0.3)
      '@types/node':
        specifier: 26.1.0
        version: 26.1.0
      typescript:
        specifier: 6.0.3
        version: 6.0.3

packages:

  typescript@6.0.3:
    resolution: {integrity: sha512-fake==}
    hasBin: true
`;

test('parseLockfileImporterVersion resolves a quoted scoped package under the root importer', () => {
  assert.equal(
    parseLockfileImporterVersion(MINIMAL_LOCKFILE_WITH_DEPS, '@types/node'),
    '26.1.0',
  );
});

test('parseLockfileImporterVersion resolves an unquoted package under the root importer', () => {
  assert.equal(
    parseLockfileImporterVersion(MINIMAL_LOCKFILE_WITH_DEPS, 'typescript'),
    '6.0.3',
  );
});

test('parseLockfileImporterVersion strips a trailing peer-dependency annotation', () => {
  assert.equal(
    parseLockfileImporterVersion(MINIMAL_LOCKFILE_WITH_DEPS, '@commitlint/cli'),
    '21.2.0',
  );
});

test('parseLockfileImporterVersion returns null for a package absent from the root importer', () => {
  assert.equal(
    parseLockfileImporterVersion(
      MINIMAL_LOCKFILE_WITH_DEPS,
      'not-a-real-package',
    ),
    null,
  );
});

test('parseLockfileImporterVersion returns null when the lockfile has no importers section', () => {
  assert.equal(
    parseLockfileImporterVersion("lockfileVersion: '9.0'\n", 'typescript'),
    null,
  );
});

test('parseLockfileImporterVersion returns null when the root "." importer is absent (workspace-only lockfile)', () => {
  const workspaceOnly = `lockfileVersion: '9.0'

importers:

  packages/foo:
    devDependencies:
      typescript:
        specifier: 6.0.3
        version: 6.0.3

packages:
`;
  assert.equal(parseLockfileImporterVersion(workspaceOnly, 'typescript'), null);
});

test('parseLockfileImporterVersion returns null for empty or non-string input', () => {
  assert.equal(parseLockfileImporterVersion('', 'typescript'), null);
});

test('evaluateDependencyVersionDrift warns when installed and resolved versions differ', () => {
  const warnings = evaluateDependencyVersionDrift([
    { name: 'typescript', installed: '5.9.0', resolved: '6.0.3' },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /node_modules\/typescript is installed at 5\.9\.0/);
  assert.match(warnings[0], /pnpm-lock\.yaml resolves 6\.0\.3/);
});

test('evaluateDependencyVersionDrift is silent when versions match', () => {
  assert.deepEqual(
    evaluateDependencyVersionDrift([
      { name: 'typescript', installed: '6.0.3', resolved: '6.0.3' },
    ]),
    [],
  );
});

test('evaluateDependencyVersionDrift skips (no warning) when either side is unknown', () => {
  assert.deepEqual(
    evaluateDependencyVersionDrift([
      { name: 'typescript', installed: null, resolved: '6.0.3' },
      { name: '@types/node', installed: '26.1.0', resolved: null },
    ]),
    [],
  );
});

test('evaluateDependencyVersionDrift reports only the mismatching entries out of several', () => {
  const warnings = evaluateDependencyVersionDrift([
    { name: 'typescript', installed: '6.0.3', resolved: '6.0.3' },
    { name: '@types/node', installed: '22.19.21', resolved: '26.1.0' },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /@types\/node/);
});

function makeDependencyDriftFixture(options: {
  withLockfile?: boolean;
  installed?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-dep-drift-'));
  if (options.withLockfile !== false) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), MINIMAL_LOCKFILE_WITH_DEPS);
  }
  for (const [name, version] of Object.entries(options.installed ?? {})) {
    const pkgDir = join(dir, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name, version }),
    );
  }
  return dir;
}

test('checkDependencyVersionDrift warns on a genuine installed-vs-lockfile mismatch', () => {
  const dir = makeDependencyDriftFixture({
    installed: { typescript: '5.9.0', '@types/node': '26.1.0' },
  });
  try {
    const report = emptyReport(dir);
    checkDependencyVersionDrift(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /typescript is installed at 5\.9\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDependencyVersionDrift is silent when installed versions match the lockfile', () => {
  const dir = makeDependencyDriftFixture({
    installed: { typescript: '6.0.3', '@types/node': '26.1.0' },
  });
  try {
    const report = emptyReport(dir);
    checkDependencyVersionDrift(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDependencyVersionDrift skips silently when pnpm-lock.yaml is absent', () => {
  const dir = makeDependencyDriftFixture({
    withLockfile: false,
    installed: { typescript: '5.9.0', '@types/node': '22.19.21' },
  });
  try {
    const report = emptyReport(dir);
    checkDependencyVersionDrift(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDependencyVersionDrift skips silently when node_modules packages are absent', () => {
  const dir = makeDependencyDriftFixture({ installed: {} });
  try {
    const report = emptyReport(dir);
    checkDependencyVersionDrift(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
