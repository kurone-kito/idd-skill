import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  backLinkPatternFor,
  checkClaimTimingConsistency,
  checkDependencyVersionDrift,
  checkLiveConfigSchema,
  checkMergePolicyAcknowledgement,
  checkPlaceholders,
  checkPolicySignals,
  checkProjectCommands,
  classifyBacklog,
  classifyBootstrapEraPrNumbers,
  classifyClaimTimingConsistency,
  classifyLiveConfigSchemaFinding,
  classifyMergePolicyAcknowledgement,
  classifyPrimaryHead,
  classifyReleaseTagDrift,
  classifyWorktreeGuardActivation,
  classifyWorktreeHeadFinding,
  computeWindowStartIso,
  containsExampleRepoBackLink,
  containsWorkshopReference,
  DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
  decodeGithubReadmeBase64,
  detectWorktreeGuardCrlfHookNames,
  emitCleanupBacklogProgress,
  evaluateAutopilotSuitabilityConsistency,
  evaluateBranchProtectionFindings,
  evaluateDependencyVersionDrift,
  evaluateMarkerPrefixConsistency,
  extractMarkerPrefixes,
  fetchGhApiJsonAt,
  filterIddBranchMergedPrs,
  findMissingWorkshopReferences,
  findMissingWorktreeHardening,
  findPlaceholders,
  formatCleanupBacklogExamples,
  formatCleanupBacklogRemediation,
  formatCleanupBacklogScanPreamble,
  formatCleanupBacklogScanProgress,
  formatRulesetsOnlyTrustGapWarning,
  hookChainsToGithooksScript,
  hookHasCrlfLineEndings,
  hookWiresWorktreeGuard,
  isBranchProtectionUnreadable,
  isGithubBackLinkHost,
  isIddManagedPlaceholderScanPath,
  isRulesetsOnlyTrustGap,
  parseIsoDurationToHours,
  parseLockfileImporterVersion,
  parsePrimaryWorktreePath,
  parseProjectCommandRows,
  parseStrictCutoffToUtcMs,
  parseThresholdsProseHours,
  readCleanupEvidenceTrustedLogins,
  readTrustEmptyProtectionReads,
  readWorktreeGuardBranchPatterns,
  readWorktreeGuardEnabled,
  resolveAutopilotSuitabilityPolicy,
  resolveConfiguredHelperRuntimePackageSpec,
  resolveConfiguredHelperRuntimeProfile,
  resolveTargetGhHostname,
  scanFileForPlaceholders,
  selectBacklogExamples,
  stripMarkdownNonText,
  worktreeGuardWiredAt,
} from '../src/scripts/idd-doctor.mts';
import { fetchGovernanceJson } from '../src/scripts/pre-merge-readiness.mts';
import { loadJson } from '../src/scripts/validate-schemas.mts';
import { readText, stubExecutable } from './test-utils.mts';

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

test('resolveAutopilotSuitabilityPolicy reads floor and blockedByHumanLabelName from the canonical config (idd-skill#2028)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-suitability-policy-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        autopilotSuitability: { floor: 3 },
        labels: { blockedByHumanLabelName: 'status:human-only' },
      }),
    );
    assert.deepEqual(resolveAutopilotSuitabilityPolicy(dir), {
      floor: 3,
      blockedByHumanLabelName: 'status:human-only',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAutopilotSuitabilityPolicy also reads the legacy idd-policy.json path when the canonical file is absent (idd-skill#2028)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-suitability-policy-legacy-'),
  );
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ autopilotSuitability: { floor: 2 } }),
    );
    assert.deepEqual(resolveAutopilotSuitabilityPolicy(dir), {
      floor: 2,
      blockedByHumanLabelName: undefined,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAutopilotSuitabilityPolicy returns undefined fields when config is missing or malformed, never falling through a present canonical config (idd-skill#2028)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-suitability-policy-absent-'),
  );
  try {
    // No config file at all.
    assert.deepEqual(resolveAutopilotSuitabilityPolicy(dir), {
      floor: undefined,
      blockedByHumanLabelName: undefined,
    });

    // Malformed canonical JSON must fail closed, not fall through to a
    // legacy file even if one is also present.
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ autopilotSuitability: { floor: 4 } }),
    );
    assert.deepEqual(resolveAutopilotSuitabilityPolicy(dir), {
      floor: undefined,
      blockedByHumanLabelName: undefined,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('isIddManagedPlaceholderScanPath accepts every IDD-managed path class (idd-skill#2079)', () => {
  for (const distributionSource of [true, false]) {
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'docs/getting-started.md',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'docs/onboarding/placeholders.md',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'profiles/human-required/README.md',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        '.claude/skills/issue-authoring/SKILL.md',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'scripts/idd-doctor.mjs',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'schemas/idd-doctor.schema.json',
        distributionSource,
      ),
      true,
    );
    assert.equal(
      isIddManagedPlaceholderScanPath(
        'fixtures/schemas/idd-doctor.schema.json',
        distributionSource,
      ),
      true,
    );
    // idd-skill#2079 review follow-up: .github/idd/config.json is
    // IDD-managed (validated by checkLiveConfigSchema) and templated
    // in idd-template/.github/idd/config.json with
    // {{PROJECT_MARKER_PREFIX}} -- the allowlist must not drop it.
    assert.equal(
      isIddManagedPlaceholderScanPath(
        '.github/idd/config.json',
        distributionSource,
      ),
      true,
    );
  }
});

test('isIddManagedPlaceholderScanPath rejects an adopter application source file (idd-skill#2079 regression)', () => {
  // The reported kit.black#128 case: an adopter's own i18n dictionary
  // using {{ year }} as its own runtime template syntax.
  assert.equal(
    isIddManagedPlaceholderScanPath('packages/web/src/i18n/en.ts', true),
    false,
  );
  assert.equal(
    isIddManagedPlaceholderScanPath('packages/web/src/i18n/en.ts', false),
    false,
  );
  assert.equal(isIddManagedPlaceholderScanPath('README.md', true), false);
  assert.equal(isIddManagedPlaceholderScanPath('package.json', false), false);
  // A docs/ file with a non-.md extension is out of scope too -- the
  // issue's proposed scope is docs/*.md specifically.
  assert.equal(
    isIddManagedPlaceholderScanPath('docs/some-data.json', true),
    false,
  );
});

test('isIddManagedPlaceholderScanPath scans .github/instructions/ only in adopter mode', () => {
  // distributionSource=true (the idd-skill source repo itself): these
  // files document the placeholder syntax with example tokens that are
  // never meant to be "resolved" -- scanning them would self-trigger.
  assert.equal(
    isIddManagedPlaceholderScanPath(
      '.github/instructions/idd-discover.instructions.md',
      true,
    ),
    false,
  );
  // distributionSource=false (an adopter's own copy after import): a
  // leftover unresolved placeholder here is a genuine import bug.
  assert.equal(
    isIddManagedPlaceholderScanPath(
      '.github/instructions/idd-discover.instructions.md',
      false,
    ),
    true,
  );
});

test('checkPlaceholders no longer flags a non-IDD-managed adopter file (idd-skill#2079 regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-placeholders-'));
  try {
    const fixtureContent = readText(
      'tests/fixtures/idd-doctor-placeholders/adopter-i18n-example.ts',
    );
    writeFixtureFile(dir, 'packages/web/src/i18n/en.ts', fixtureContent);
    const report = { root: dir, errors: [], warnings: [], passes: [] };
    checkPlaceholders(dir, ['packages/web/src/i18n/en.ts'], report);
    assert.deepEqual(report.errors, []);
    assert.match(
      report.passes[0] ?? '',
      /no unresolved \{\{\.\.\.\}\} placeholders/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPlaceholders still flags an unresolved placeholder in an IDD-managed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-placeholders-hit-'));
  try {
    writeFixtureFile(
      dir,
      'docs/getting-started.md',
      'Welcome to {{PROJECT_MARKER_PREFIX}}!\n',
    );
    const report = { root: dir, errors: [], warnings: [], passes: [] };
    checkPlaceholders(dir, ['docs/getting-started.md'], report);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /docs\/getting-started\.md/);
    assert.match(report.errors[0], /\{\{PROJECT_MARKER_PREFIX\}\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('filterIddBranchMergedPrs keeps issue/* and roadmap-audit/* head refs and drops a Dependabot-style branch (idd-skill#1829)', () => {
  const result = filterIddBranchMergedPrs([
    { number: 101, headRefName: 'issue/101-fix-foo' },
    { number: 102, headRefName: 'roadmap-audit/45-bar' },
    { number: 103, headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21' },
  ]);
  assert.deepEqual(result, [{ number: 101 }, { number: 102 }]);
});

test('filterIddBranchMergedPrs drops malformed entries (missing headRefName, non-integer number)', () => {
  const result = filterIddBranchMergedPrs([
    { number: 201, headRefName: 'issue/201-ok' },
    { number: 202 },
    { headRefName: 'issue/203-no-number' },
    { number: 'not-a-number', headRefName: 'issue/204-bad-number' },
    null,
  ]);
  assert.deepEqual(result, [{ number: 201 }]);
});

test('filterIddBranchMergedPrs returns an empty array for non-array input', () => {
  assert.deepEqual(filterIddBranchMergedPrs(undefined), []);
  assert.deepEqual(filterIddBranchMergedPrs(null), []);
  assert.deepEqual(filterIddBranchMergedPrs('not-an-array'), []);
});

test('filterIddBranchMergedPrs honors a custom pattern list instead of the default', () => {
  const prs = [
    { number: 301, headRefName: 'issue/301-fix' },
    { number: 302, headRefName: 'chore/302-bump' },
  ];
  assert.deepEqual(filterIddBranchMergedPrs(prs, ['chore/*']), [
    { number: 302 },
  ]);
});

// idd-skill#1936: when every merged PR's head ref fails every configured
// pattern (all non-IDD traffic in the window), the filter must return an
// empty array rather than falling back to the unfiltered input.
test('filterIddBranchMergedPrs carries a valid mergedAt through, omitted when absent or empty (idd-skill#2226)', () => {
  const result = filterIddBranchMergedPrs([
    {
      number: 501,
      headRefName: 'issue/501-fix',
      mergedAt: '2025-01-01T00:00:00Z',
    },
    { number: 502, headRefName: 'issue/502-fix' },
    { number: 503, headRefName: 'issue/503-fix', mergedAt: '' },
    { number: 504, headRefName: 'issue/504-fix', mergedAt: 12345 },
  ]);
  assert.deepEqual(result, [
    { number: 501, mergedAt: '2025-01-01T00:00:00Z' },
    { number: 502 },
    { number: 503 },
    { number: 504 },
  ]);
});

test('filterIddBranchMergedPrs returns an empty array when every entry is non-matching', () => {
  const prs = [
    { number: 401, headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21' },
    { number: 402, headRefName: 'renovate/eslint-9.x' },
  ];
  assert.deepEqual(filterIddBranchMergedPrs(prs), []);
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

test('hookWiresWorktreeGuard still matches a CRLF-converted sourcing line (regression evidence for #2060)', () => {
  // The trailing \r sits after the matched filename, not inside it, so the
  // regex alone cannot distinguish this from a healthy LF hook -- this is
  // exactly why `hookHasCrlfLineEndings` exists as an independent check.
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/sh\r\n. "$(dirname "$0")/_idd-worktree-guard.sh"\r\n',
    ),
    true,
  );
});

test('hookWiresWorktreeGuard rejects a disabled/backed-up guard filename (#2476)', () => {
  // `_idd-worktree-guard.sh.disabled` / `.bak` are not the active guard
  // file -- the prior unbounded regex matched the `.sh` prefix and
  // misreported the guard as wired even though it is not.
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/sh\n. "$(dirname "$0")/_idd-worktree-guard.sh.disabled"\n',
    ),
    false,
  );
  assert.equal(
    hookWiresWorktreeGuard(
      '#!/bin/sh\n. "$(dirname "$0")/_idd-worktree-guard.sh.bak"\n',
    ),
    false,
  );
});

test('hookHasCrlfLineEndings detects a CRLF line ending', () => {
  assert.equal(hookHasCrlfLineEndings('#!/bin/sh\r\necho hi\r\n'), true);
});

test('hookHasCrlfLineEndings rejects LF-only content', () => {
  assert.equal(hookHasCrlfLineEndings('#!/bin/sh\necho hi\n'), false);
  assert.equal(hookHasCrlfLineEndings(''), false);
});

test('hookHasCrlfLineEndings treats a non-string (absent hook) as CRLF-free', () => {
  assert.equal(hookHasCrlfLineEndings(null), false);
  assert.equal(hookHasCrlfLineEndings(undefined), false);
});

test('hookChainsToGithooksScript detects the exec chain form', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    true,
  );
});

test('hookChainsToGithooksScript detects the non-exec insertion form', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '#!/bin/sh\n"$(git rev-parse --show-toplevel)/.githooks/pre-push" "$@" || exit $?\nexec ./husky-real-hook\n',
      'pre-push',
    ),
    true,
  );
});

test('hookChainsToGithooksScript requires the matching hook name', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-push',
    ),
    false,
  );
});

test('hookChainsToGithooksScript ignores a commented-out chain line', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '#!/bin/sh\n# exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript treats a non-string (absent hook) as not chaining', () => {
  assert.equal(hookChainsToGithooksScript(null, 'pre-commit'), false);
  assert.equal(hookChainsToGithooksScript(undefined, 'pre-push'), false);
});

// Review feedback (PR #1969, Copilot + chatgpt-codex-connector): the
// unanchored `[^"#\n]*` prefix used to let ANY leading command that merely
// *mentions* the .githooks path -- quoted or not -- read as a genuine
// chain, even though nothing actually invokes the guard.
test('hookChainsToGithooksScript rejects an unrelated leading command with an unquoted path (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'echo $(git rev-parse --show-toplevel)/.githooks/pre-commit "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript rejects an unrelated leading command with a quoted path (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'echo "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript rejects a bare mention with no exec/invocation at all (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '#!/bin/sh\necho "chains to .githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

// Review feedback (PR #1969, CodeRabbit): the matcher required only that
// the quoted path *end* in `.githooks/<hookName>`, so an unrelated target
// like `$HOME/.githooks/<hookName>` matched too, even though it has no
// relationship to this repository's own shipped `.githooks/<hookName>`.
test('hookChainsToGithooksScript rejects a foreign path that only happens to end in .githooks/<hookName> (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'exec "$HOME/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

// Review feedback (PR #1969, chatgpt-codex-connector): the non-exec form
// was accepted even without its documented `|| exit $?` failure-propagation
// suffix, so a guard failure could be silently swallowed by whatever the
// hook manager's own dispatcher ran next.
test('hookChainsToGithooksScript rejects a non-exec invocation missing the failure-propagation suffix (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '"$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\necho continuing anyway\n',
      'pre-commit',
    ),
    false,
  );
});

// Review feedback (PR #1969, chatgpt-codex-connector): neither documented
// form was end-anchored, so a trailing shell operator (piping, or
// backgrounding) that decouples the line's own exit status from the
// guard's could still match.
test('hookChainsToGithooksScript rejects an exec form piped to another command (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@" | cat\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript rejects a non-exec form backgrounded with &  (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      '"$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@" || exit $? &\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript still accepts a trailing comment after either documented form', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"  # invoke the guard\n',
      'pre-commit',
    ),
    true,
  );
});

// Review feedback (PR #1969, chatgpt-codex-connector): a `#` with no
// preceding whitespace is not a comment delimiter to a real shell -- it
// stays part of the same word as the closing quote -- so accepting it
// blindly let disguised trailing content (e.g. a pipe) back in through the
// comment escape hatch the prior end-anchor fix added.
test('hookChainsToGithooksScript rejects a "#" with no preceding whitespace (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"# | cat\n',
      'pre-commit',
    ),
    false,
  );
});

// Review feedback (PR #1969, chatgpt-codex-connector): the shell joins a
// line ending in a backslash with the next physical line into one logical
// command, so a chain-shaped line immediately following a backslash
// continuation is not actually executed as its own command.
test('hookChainsToGithooksScript rejects a chain line continued from the preceding backslash-terminated line (false-positive regression)', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'printf %s \\\nexec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    false,
  );
});

test('hookChainsToGithooksScript still accepts a chain line following an ordinary (non-continued) line', () => {
  assert.equal(
    hookChainsToGithooksScript(
      'echo hi\nexec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"\n',
      'pre-commit',
    ),
    true,
  );
});

test('classifyWorktreeGuardActivation returns null when the guard is disabled', () => {
  assert.equal(
    classifyWorktreeGuardActivation({
      guardEnabled: false,
      headDetached: false,
      hooksPath: null,
      guardWired: false,
      crlfHookNames: [],
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
      crlfHookNames: [],
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
      crlfHookNames: [],
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
    crlfHookNames: [],
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /worktreeGuard\.enabled is true/);
  assert.match(finding?.message ?? '', /core\.hooksPath = \.husky\/_/);
  assert.match(finding?.message ?? '', /git config core\.hooksPath \.githooks/);
  // The remediation also points a chaining operator at the coexistence
  // recipe instead of only telling them to repoint core.hooksPath directly.
  assert.match(
    finding?.message ?? '',
    /existing hook manager already owns core\.hooksPath/,
  );
  assert.match(
    finding?.message ?? '',
    /Coexisting with an existing hook manager/,
  );
});

test('classifyWorktreeGuardActivation shows (unset) when core.hooksPath is absent', () => {
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: null,
    guardWired: false,
    crlfHookNames: [],
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /core\.hooksPath = \(unset\)/);
});

test('classifyWorktreeGuardActivation warns on CRLF hooks even when guardWired is (incorrectly) true', () => {
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: '.githooks',
    guardWired: true,
    crlfHookNames: ['pre-commit'],
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /pre-commit contains CRLF/);
  assert.match(finding?.message ?? '', /core\.autocrlf=true/);
  assert.match(finding?.message ?? '', /\.gitattributes/);
  assert.match(finding?.message ?? '', /text eol=lf/);
});

test('classifyWorktreeGuardActivation lists every CRLF-affected hook with plural wording', () => {
  const finding = classifyWorktreeGuardActivation({
    guardEnabled: true,
    headDetached: false,
    hooksPath: '.githooks',
    guardWired: false,
    crlfHookNames: ['pre-commit', 'pre-push'],
  });
  assert.match(
    finding?.message ?? '',
    /pre-commit, pre-push contain CRLF line endings/,
  );
});

test('classifyWorktreeGuardActivation stays silent on a detached HEAD even with CRLF hooks (CI-safe)', () => {
  assert.equal(
    classifyWorktreeGuardActivation({
      guardEnabled: true,
      headDetached: true,
      hooksPath: null,
      guardWired: false,
      crlfHookNames: ['pre-commit'],
    }),
    null,
  );
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

const GUARD_SOURCE_LINE = '. "$(dirname "$0")/_idd-worktree-guard.sh"\n';
const chainLine = (hookName: string) =>
  `exec "$(git rev-parse --show-toplevel)/.githooks/${hookName}" "$@"\n`;
// Husky v9's own generated core.hooksPath (.husky/_) dispatcher: present on
// disk (git has something to invoke), but it neither sources the guard nor
// chains anywhere itself -- the committed, adopter-edited chain line lives
// one directory up, per ONBOARDING.md's recipe. Fixtures below must create
// this stub at hooksPath itself, mirroring a real Husky install, or the
// P1 "no active hook file" guard short-circuits every wired() check to
// false regardless of what the test actually intends to isolate.
const HUSKY_DISPATCHER_STUB = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/h"\n';

function writeFixtureFile(root: string, relativePath: string, content: string) {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  // git skips a hook file lacking the executable bit; writeFileSync's
  // default mode does not set it, so every fixture hook file must be made
  // executable explicitly to be a faithful "active hook" stand-in. Callers
  // that specifically need a non-executable fixture chmod it back off
  // afterward.
  chmodSync(full, 0o755);
}

test('detectWorktreeGuardCrlfHookNames: finds CRLF-converted shipped hooks (regression for #2060)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-crlf-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/_idd-worktree-guard.sh',
      '#!/bin/sh\r\necho guard\r\n',
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\r\n${GUARD_SOURCE_LINE}`,
    );
    assert.deepEqual(detectWorktreeGuardCrlfHookNames(dir), [
      '_idd-worktree-guard.sh',
      'pre-push',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWorktreeGuardCrlfHookNames: LF-only hooks report no CRLF names (unchanged case)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-crlf-none-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/_idd-worktree-guard.sh',
      '#!/bin/sh\necho guard\n',
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    assert.deepEqual(detectWorktreeGuardCrlfHookNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWorktreeGuardCrlfHookNames: missing .githooks directory reports no CRLF names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-crlf-missing-'));
  try {
    assert.deepEqual(detectWorktreeGuardCrlfHookNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktreeGuardWiredAt: direct .githooks hooksPath wires both hooks (regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-wired-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    assert.equal(worktreeGuardWiredAt(dir, '.githooks'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktreeGuardWiredAt: Husky-shape chain (core.hooksPath=.husky/_, committed .husky/<hook>) reads as wired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    // Husky's generated dispatcher at core.hooksPath (.husky/_) does not
    // itself chain; the committed, adopter-edited file lives one directory
    // up, per ONBOARDING.md's chaining recipe. It must still exist on disk
    // for git to have anything to invoke at all.
    writeFixtureFile(dir, '.husky/_/pre-commit', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/_/pre-push', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.husky/pre-push', chainLine('pre-push'));
    assert.equal(worktreeGuardWiredAt(dir, '.husky/_'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktreeGuardWiredAt: only one hook chained still reads as unwired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-partial-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(dir, '.husky/_/pre-commit', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/_/pre-push', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/pre-commit', chainLine('pre-commit'));
    // pre-push was never chained -- still enabled-but-inert overall.
    writeFixtureFile(
      dir,
      '.husky/pre-push',
      '#!/bin/sh\necho husky pre-push\n',
    );
    assert.equal(worktreeGuardWiredAt(dir, '.husky/_'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktreeGuardWiredAt: a chain line pointing at a missing/unwired .githooks target reads as unwired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-broken-target-'));
  try {
    // .githooks/pre-commit does not exist at all -- a chain referencing it
    // must not read as wired just because a chain line is present.
    writeFixtureFile(dir, '.githooks/pre-push', 'echo not the guard\n');
    writeFixtureFile(dir, '.husky/_/pre-commit', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/_/pre-push', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.husky/pre-push', chainLine('pre-push'));
    assert.equal(worktreeGuardWiredAt(dir, '.husky/_'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review feedback (PR #1969, chatgpt-codex-connector P1): when core.hooksPath
// resolves to the manager's own dispatch directory but its generated hook
// files are absent -- a deleted/incomplete install -- git has nothing to
// invoke there at all, so the committed parent-directory chain lines are
// unreachable and must not read as wired.
test('worktreeGuardWiredAt: no active hook file at core.hooksPath reads as unwired despite committed chain lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-no-active-hook-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(dir, '.husky/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.husky/pre-push', chainLine('pre-push'));
    // .husky/_/pre-commit and .husky/_/pre-push (the files git would
    // actually invoke) are deliberately never created.
    assert.equal(worktreeGuardWiredAt(dir, '.husky/_'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review feedback (PR #1969, Copilot suppressed comment): the
// parent-directory fallback must be scoped to the documented Husky v9
// `.husky/_` shape specifically -- otherwise an unrelated coincidental
// file sitting in some other hooksPath's parent directory (no real
// dispatch relationship to the active hook at all) could still read as
// wired evidence.
test('worktreeGuardWiredAt: parent-directory chain is ignored when hooksPath is not the Husky "_" shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-non-underscore-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    // The file git actually invokes at core.hooksPath: present, but a
    // no-op that never dispatches anywhere.
    writeFixtureFile(
      dir,
      '.other-hooks/dispatch/pre-commit',
      '#!/bin/sh\nexit 0\n',
    );
    writeFixtureFile(
      dir,
      '.other-hooks/dispatch/pre-push',
      '#!/bin/sh\nexit 0\n',
    );
    // A coincidental, unrelated file in the parent directory that happens
    // to contain a chain-shaped line -- not a real Husky "_"-split sibling.
    writeFixtureFile(dir, '.other-hooks/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.other-hooks/pre-push', chainLine('pre-push'));
    assert.equal(worktreeGuardWiredAt(dir, '.other-hooks/dispatch'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review feedback (PR #1969, chatgpt-codex-connector): the Husky
// parent-directory fallback must key on the exact `.husky/_` path relative
// to the repository root, not merely a trailing `_` path segment -- an
// unrelated directory that happens to also end in `_` (e.g. `.other-hooks/_`)
// has no real Husky dispatch relationship to its own parent directory.
test('worktreeGuardWiredAt: a directory merely ending in "_" is not treated as the Husky shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-fake-underscore-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(dir, '.other-hooks/_/pre-commit', '#!/bin/sh\nexit 0\n');
    writeFixtureFile(dir, '.other-hooks/_/pre-push', '#!/bin/sh\nexit 0\n');
    writeFixtureFile(dir, '.other-hooks/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.other-hooks/pre-push', chainLine('pre-push'));
    assert.equal(worktreeGuardWiredAt(dir, '.other-hooks/_'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review feedback (PR #1969, chatgpt-codex-connector P1): git silently
// skips a hook file that exists but lacks the executable bit, so an
// existence-only check is not sufficient evidence that git would invoke it.
//
// Skipped on Windows (#2580): `worktreeGuardWiredAt` checks executability
// via `accessSync(path, fsConstants.X_OK)`, and Windows has no POSIX
// execute-permission bit for `accessSync` to detect the absence of --
// verified empirically, `chmodSync(f, 0o644)` never makes `X_OK` fail
// there, so this test's fault precondition can't be constructed on
// Windows at all. POSIX/Linux CI stays the authoritative coverage for
// this POSIX-permission-semantics check, unaffected by this skip.
test('worktreeGuardWiredAt: a present but non-executable active hook file reads as unwired', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-chain-non-executable-'));
  try {
    writeFixtureFile(
      dir,
      '.githooks/pre-commit',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(
      dir,
      '.githooks/pre-push',
      `#!/bin/sh\n${GUARD_SOURCE_LINE}`,
    );
    writeFixtureFile(dir, '.husky/_/pre-commit', HUSKY_DISPATCHER_STUB);
    // Readable, but not executable -- e.g. an incomplete install or a
    // checkout that lost its mode bit.
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o644);
    writeFixtureFile(dir, '.husky/_/pre-push', HUSKY_DISPATCHER_STUB);
    writeFixtureFile(dir, '.husky/pre-commit', chainLine('pre-commit'));
    writeFixtureFile(dir, '.husky/pre-push', chainLine('pre-push'));
    assert.equal(worktreeGuardWiredAt(dir, '.husky/_'), false);
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

test('readWorktreeGuardEnabled also reads the legacy idd-policy.json path when the canonical file is absent (idd-skill#2028)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-legacy-'));
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ worktreeGuard: { enabled: true } }),
    );
    assert.equal(readWorktreeGuardEnabled(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorktreeGuardEnabled never falls through a present canonical config to a legacy one (idd-skill#2028)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-guard-no-fallthrough-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify({}));
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ worktreeGuard: { enabled: true } }),
    );
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

test('readWorktreeGuardBranchPatterns also reads the legacy idd-policy.json path when the canonical file is absent (idd-skill#2028)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-bp-legacy-'));
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ worktreeGuard: { branchPatterns: ['feature/*'] } }),
    );
    assert.deepEqual(readWorktreeGuardBranchPatterns(dir), ['feature/*']);
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

test('parseStrictCutoffToUtcMs accepts a bare calendar date, anchored to UTC midnight (idd-skill#2226)', () => {
  assert.equal(
    parseStrictCutoffToUtcMs('2026-01-01'),
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
});

test('parseStrictCutoffToUtcMs accepts a Z-suffixed ISO8601 timestamp, matching the equivalent bare date', () => {
  assert.equal(
    parseStrictCutoffToUtcMs('2026-01-01T00:00:00Z'),
    parseStrictCutoffToUtcMs('2026-01-01'),
  );
});

test('parseStrictCutoffToUtcMs rejects calendar overflow instead of silently rolling over (CodeRabbit review, PR #2386)', () => {
  // Plain Date.parse('2026-02-30') resolves to March 2 -- confirmed
  // empirically before this fix. The strict parser must reject it outright.
  assert.equal(parseStrictCutoffToUtcMs('2026-02-30'), null);
  assert.equal(parseStrictCutoffToUtcMs('2026-13-01'), null);
});

test('parseStrictCutoffToUtcMs rejects a timestamp with a time-of-day but no explicit UTC offset (host-timezone-dependent, CodeRabbit review)', () => {
  // Plain Date.parse resolves this in the HOST's local time zone per the
  // ECMA-262 Date Time String Format -- the same value would classify
  // different PRs depending on which machine/CI runner evaluates it.
  // Confirmed empirically: LA -> 2026-01-01T08:00:00.000Z, UTC ->
  // 2026-01-01T00:00:00.000Z for the identical input string.
  assert.equal(parseStrictCutoffToUtcMs('2026-01-01T00:00:00'), null);
});

test('parseStrictCutoffToUtcMs rejects garbage input and non-string values', () => {
  assert.equal(parseStrictCutoffToUtcMs('not-a-date'), null);
  assert.equal(parseStrictCutoffToUtcMs(undefined), null);
  assert.equal(parseStrictCutoffToUtcMs(12345), null);
});

test('classifyBootstrapEraPrNumbers rejects a cutoff with calendar overflow (fail closed, CodeRabbit review)', () => {
  const mergedAtByNumber = new Map([[100, '2025-01-01T00:00:00Z']]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers([100], mergedAtByNumber, '2026-02-30'),
    new Set(),
  );
});

test('classifyBootstrapEraPrNumbers rejects a mergedAt with a time-of-day but no UTC offset (fail closed, CodeRabbit review)', () => {
  const mergedAtByNumber = new Map([[100, '2025-01-01T00:00:00']]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers([100], mergedAtByNumber, '2026-01-01'),
    new Set(),
  );
});

test('classifyBootstrapEraPrNumbers labels only PRs merged before the cutoff (idd-skill#2226)', () => {
  const mergedAtByNumber = new Map([
    [100, '2025-01-01T00:00:00Z'],
    [101, '2026-06-01T00:00:00Z'],
    [102, '2026-08-01T00:00:00Z'],
  ]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers(
      [100, 101, 102],
      mergedAtByNumber,
      '2026-01-01T00:00:00Z',
    ),
    new Set([100]),
  );
});

test('classifyBootstrapEraPrNumbers is presentation-only: never adds a number missingPrNumbers did not already contain', () => {
  const mergedAtByNumber = new Map([[100, '2025-01-01T00:00:00Z']]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers([], mergedAtByNumber, '2026-01-01T00:00:00Z'),
    new Set(),
  );
});

test('classifyBootstrapEraPrNumbers returns an empty set for an unparsable cutoff (fail closed)', () => {
  const mergedAtByNumber = new Map([[100, '2025-01-01T00:00:00Z']]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers([100], mergedAtByNumber, 'not-a-date'),
    new Set(),
  );
  assert.deepEqual(
    classifyBootstrapEraPrNumbers([100], mergedAtByNumber, undefined),
    new Set(),
  );
});

test('classifyBootstrapEraPrNumbers skips a PR number absent from mergedAtByNumber', () => {
  // #101 has no recorded mergedAt (fetch failed / omitted) -- never
  // guessed as bootstrap-era.
  const mergedAtByNumber = new Map([[100, '2025-01-01T00:00:00Z']]);
  assert.deepEqual(
    classifyBootstrapEraPrNumbers(
      [100, 101],
      mergedAtByNumber,
      '2026-01-01T00:00:00Z',
    ),
    new Set([100]),
  );
});

test('formatCleanupBacklogExamples tags only the bootstrap-era numbers (idd-skill#2226)', () => {
  assert.equal(
    formatCleanupBacklogExamples([100, 101, 102], new Set([100, 102])),
    '#100 (bootstrap-era), #101, #102 (bootstrap-era)',
  );
});

test('formatCleanupBacklogExamples matches the pre-#2226 plain format when no number is bootstrap-era', () => {
  assert.equal(
    formatCleanupBacklogExamples([100, 101], new Set()),
    '#100, #101',
  );
});

test('selectBacklogExamples preserves the plain slice when no bootstrap-era number exists', () => {
  assert.deepEqual(
    selectBacklogExamples([100, 101, 102, 103, 104, 105], new Set()),
    [100, 101, 102, 103, 104],
  );
});

test('selectBacklogExamples preserves the plain slice when a bootstrap-era number is already among it', () => {
  assert.deepEqual(
    selectBacklogExamples([100, 101, 102, 103, 104, 105], new Set([102])),
    [100, 101, 102, 103, 104],
  );
});

test('selectBacklogExamples swaps in a bootstrap-era number when the natural slice would show none (Copilot review, PR #2386)', () => {
  // #110 is bootstrap-era but sits past the first-5 natural slice --
  // without the fix, the warning's "(1 bootstrap-era)" count clause would
  // pair with an Examples: list showing zero (bootstrap-era) tags.
  const missing = [100, 101, 102, 103, 104, 110];
  const bootstrapEra = new Set([110]);
  const result = selectBacklogExamples(missing, bootstrapEra);
  assert.equal(result.length, 5);
  assert.ok(result.includes(110));
  // Only the last natural entry is displaced -- the rest of the natural
  // order is preserved.
  assert.deepEqual(result.slice(0, 4), [100, 101, 102, 103]);
});

test('selectBacklogExamples respects a custom limit', () => {
  const missing = [100, 101, 102, 110];
  const bootstrapEra = new Set([110]);
  assert.deepEqual(selectBacklogExamples(missing, bootstrapEra, 2), [100, 110]);
});

test('selectBacklogExamples returns an empty array for an empty missing list, even with a non-empty bootstrapEra', () => {
  assert.deepEqual(selectBacklogExamples([], new Set([110])), []);
});

test('formatCleanupBacklogRemediation resolves the audit-pr-cleanup invocation per profile (idd-skill#1718)', () => {
  // vendored-node: unchanged from the pre-#1718 hard-coded text.
  assert.equal(
    formatCleanupBacklogRemediation('vendored-node'),
    'Remediation: see docs/idd-comment-minimization.md or run `node scripts/audit-pr-cleanup.mjs --pr <N> --apply --skip-claim-check`.',
  );

  // package-manager: the bare `idd-audit-pr-cleanup` bin name -- the same
  // form buildProfileCatalog already emits as this profile's `commands`
  // value (docs/idd-helper-scripts.md's "profile-selected `idd:<name>`"
  // convention), deliberately not a `<manager> run <scriptName>` form: arg
  // forwarding after `run` differs across managers (npm needs a literal
  // `--` before flags; pnpm/yarn don't), so a manager-agnostic emitted
  // string would be wrong for at least one manager.
  assert.equal(
    formatCleanupBacklogRemediation('package-manager'),
    'Remediation: see docs/idd-comment-minimization.md or run `idd-audit-pr-cleanup --pr <N> --apply --skip-claim-check`.',
  );

  // ephemeral-npx: names the idd-* bin via npx, no scripts/ path -- this is
  // the exact profile the reported adopter repo was on (idd-skill#1718).
  const ephemeralNpxText = formatCleanupBacklogRemediation('ephemeral-npx');
  assert.match(
    ephemeralNpxText,
    /\bnpx --yes --package \S+ idd-audit-pr-cleanup /,
  );
  assert.doesNotMatch(ephemeralNpxText, /scripts\/audit-pr-cleanup\.mjs/);

  // instructions-only: prescribes no command, docs pointer only.
  assert.equal(
    formatCleanupBacklogRemediation('instructions-only'),
    'Remediation: see docs/idd-comment-minimization.md.',
  );
});

test('formatCleanupBacklogRemediation falls back to the docs-only clause for an unrecognized profile', () => {
  assert.equal(
    formatCleanupBacklogRemediation('not-a-real-profile'),
    'Remediation: see docs/idd-comment-minimization.md.',
  );
});

test('resolveConfiguredHelperRuntimeProfile reads the live helperRuntime.profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-helper-profile-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ helperRuntime: { profile: 'ephemeral-npx' } }),
    );
    assert.equal(resolveConfiguredHelperRuntimeProfile(dir), 'ephemeral-npx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfiguredHelperRuntimeProfile also reads the legacy idd-policy.json path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-helper-profile-legacy-'));
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ helperRuntime: { profile: 'package-manager' } }),
    );
    assert.equal(resolveConfiguredHelperRuntimeProfile(dir), 'package-manager');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfiguredHelperRuntimeProfile defaults to instructions-only when unset, absent, or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-helper-profile-absent-'));
  try {
    // No config file at all.
    assert.equal(
      resolveConfiguredHelperRuntimeProfile(dir),
      'instructions-only',
    );

    // Config present but helperRuntime unset.
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify({}));
    assert.equal(
      resolveConfiguredHelperRuntimeProfile(dir),
      'instructions-only',
    );

    // Malformed JSON -- already reported elsewhere by
    // checkHelperRuntimeConfig / checkLiveConfigSchema; this resolver just
    // fails closed to the safe no-command default.
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    assert.equal(
      resolveConfiguredHelperRuntimeProfile(dir),
      'instructions-only',
    );

    // Invalid profile value.
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ helperRuntime: { profile: 'bun' } }),
    );
    assert.equal(
      resolveConfiguredHelperRuntimeProfile(dir),
      'instructions-only',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfiguredHelperRuntimeProfile never falls through a present canonical config to a legacy one (idd-skill#1718 review)', () => {
  // A present .github/idd/config.json that omits helperRuntime is an
  // intentional instructions-only declaration -- it must not fall through
  // to a stale idd-policy.json left over from before a migration to the
  // canonical filename, even though idd-policy.json alone (with no
  // canonical file present) is still a supported legacy path on its own
  // (see the test above). Flagged independently by both Copilot and the
  // secondary advisory bot on PR #1730.
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-helper-profile-no-fallthrough-'),
  );
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify({}));
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ helperRuntime: { profile: 'package-manager' } }),
    );
    assert.equal(
      resolveConfiguredHelperRuntimeProfile(dir),
      'instructions-only',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfiguredHelperRuntimePackageSpec reads a configured pin, defaults to empty otherwise (idd-skill#1731)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-helper-package-spec-'));
  try {
    // No config file at all.
    assert.equal(resolveConfiguredHelperRuntimePackageSpec(dir), '');

    // profile configured, no packageSpec -- still empty (fall back to
    // the default archive URL), not an error.
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ helperRuntime: { profile: 'ephemeral-npx' } }),
    );
    assert.equal(resolveConfiguredHelperRuntimePackageSpec(dir), '');

    // Configured pin is read back verbatim.
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        helperRuntime: {
          profile: 'ephemeral-npx',
          packageSpec: 'https://example.com/pinned-idd-skill.tgz',
        },
      }),
    );
    assert.equal(
      resolveConfiguredHelperRuntimePackageSpec(dir),
      'https://example.com/pinned-idd-skill.tgz',
    );

    // Malformed JSON fails closed to empty, same as the profile resolver.
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    assert.equal(resolveConfiguredHelperRuntimePackageSpec(dir), '');

    // An invalid packageSpec (whitespace) fails the whole helperRuntime
    // block closed to empty, mirroring an invalid profile.
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        helperRuntime: { profile: 'ephemeral-npx', packageSpec: 'has space' },
      }),
    );
    assert.equal(resolveConfiguredHelperRuntimePackageSpec(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfiguredHelperRuntimePackageSpec also reads the legacy idd-policy.json path', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-helper-package-spec-legacy-'),
  );
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({
        helperRuntime: {
          profile: 'package-manager',
          packageSpec: 'https://mirror.example/idd-skill.tgz',
        },
      }),
    );
    assert.equal(
      resolveConfiguredHelperRuntimePackageSpec(dir),
      'https://mirror.example/idd-skill.tgz',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatCleanupBacklogRemediation uses a configured packageSpec under ephemeral-npx (idd-skill#1731)', () => {
  assert.equal(
    formatCleanupBacklogRemediation(
      'ephemeral-npx',
      'https://example.com/pinned-idd-skill.tgz',
    ),
    'Remediation: see docs/idd-comment-minimization.md or run `npx --yes --package https://example.com/pinned-idd-skill.tgz idd-audit-pr-cleanup --pr <N> --apply --skip-claim-check`.',
  );

  // Absent packageSpec keeps the pre-#1731 default-archive-URL behavior.
  const defaultText = formatCleanupBacklogRemediation('ephemeral-npx');
  assert.match(defaultText, /\bnpx --yes --package \S+ idd-audit-pr-cleanup /);
  assert.doesNotMatch(
    defaultText,
    /pinned-idd-skill\.tgz/,
    'no configured pin should fall back to the default archive URL',
  );
});

test('readCleanupEvidenceTrustedLogins includes configured trustedMarkerActors plus github-actions[bot], excludes untrusted logins (idd-skill#1691, PR#1759)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-cleanup-evidence-trust-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ trustedMarkerActors: ['kurone-kito'] }),
    );
    const logins = readCleanupEvidenceTrustedLogins(dir);
    // Exact-set assertion (not just membership): a regression that
    // accidentally widens the trusted set with an extra login must fail
    // this test even though it would still contain 'kurone-kito' and
    // 'github-actions[bot]' (Copilot review, PR#1809).
    assert.deepEqual(logins, new Set(['kurone-kito', 'github-actions[bot]']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCleanupEvidenceTrustedLogins fails closed to github-actions[bot] alone when config is missing, empty, or malformed (idd-skill#1691, PR#1759)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-cleanup-evidence-trust-fail-closed-'),
  );
  try {
    // No config file at all.
    assert.deepEqual(
      readCleanupEvidenceTrustedLogins(dir),
      new Set(['github-actions[bot]']),
    );

    // Config present, valid JSON, but the trustedMarkerActors key is
    // entirely absent -- a distinct code path (config?.trustedMarkerActors
    // resolves via optional chaining to undefined, no throw at all) from
    // both the missing-file case above and the malformed-JSON case below
    // (Copilot review, PR#1809).
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify({}));
    assert.deepEqual(
      readCleanupEvidenceTrustedLogins(dir),
      new Set(['github-actions[bot]']),
    );

    // Present but empty trustedMarkerActors array -- a further distinct
    // code branch (Array.isArray true, then empty) from the case above
    // (Array.isArray false on undefined), even though the observable
    // result is the same fail-closed set.
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ trustedMarkerActors: [] }),
    );
    assert.deepEqual(
      readCleanupEvidenceTrustedLogins(dir),
      new Set(['github-actions[bot]']),
    );

    // Malformed JSON must never widen trust beyond the safe default.
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    assert.deepEqual(
      readCleanupEvidenceTrustedLogins(dir),
      new Set(['github-actions[bot]']),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCleanupEvidenceTrustedLogins also reads the legacy idd-policy.json path when the canonical file is absent (idd-skill#2028)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-cleanup-evidence-trust-legacy-'),
  );
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ trustedMarkerActors: ['kurone-kito'] }),
    );
    assert.deepEqual(
      readCleanupEvidenceTrustedLogins(dir),
      new Set(['kurone-kito', 'github-actions[bot]']),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('classifyMergePolicyAcknowledgement warns when fully_autonomous_merge is unacknowledged', () => {
  const finding = classifyMergePolicyAcknowledgement({
    mergePolicy: 'fully_autonomous_merge',
  });
  assert.equal(finding?.level, 'warning');
  assert.match(finding?.message ?? '', /fully_autonomous_merge/);
  assert.match(finding?.message ?? '', /human_merge/);
  assert.match(finding?.message ?? '', /mergePolicyAck/);
  assert.match(finding?.message ?? '', /\.github\/idd\/config\.json/);
});

test('classifyMergePolicyAcknowledgement names the legacy file when that is what was read (#2301 review)', () => {
  const finding = classifyMergePolicyAcknowledgement(
    { mergePolicy: 'fully_autonomous_merge' },
    'idd-policy.json',
  );
  assert.match(finding?.message ?? '', /idd-policy\.json/);
  assert.doesNotMatch(finding?.message ?? '', /\.github\/idd\/config\.json/);
});

test('classifyMergePolicyAcknowledgement returns null when acknowledged', () => {
  assert.equal(
    classifyMergePolicyAcknowledgement({
      mergePolicy: 'fully_autonomous_merge',
      mergePolicyAck: 'fully_autonomous_merge',
    }),
    null,
  );
});

test('classifyMergePolicyAcknowledgement warns when the ack value is stale (mismatched)', () => {
  const finding = classifyMergePolicyAcknowledgement({
    mergePolicy: 'fully_autonomous_merge',
    mergePolicyAck: 'human_merge',
  });
  assert.equal(finding?.level, 'warning');
});

test('classifyMergePolicyAcknowledgement returns null for a different mergePolicy value, ack present or not', () => {
  assert.equal(
    classifyMergePolicyAcknowledgement({ mergePolicy: 'human_merge' }),
    null,
  );
  assert.equal(
    classifyMergePolicyAcknowledgement({
      mergePolicy: 'separate_merge_agent',
      mergePolicyAck: 'fully_autonomous_merge',
    }),
    null,
  );
});

test('classifyMergePolicyAcknowledgement returns null for a missing/absent mergePolicy', () => {
  assert.equal(classifyMergePolicyAcknowledgement(undefined), null);
  assert.equal(classifyMergePolicyAcknowledgement(null), null);
  assert.equal(classifyMergePolicyAcknowledgement({}), null);
});

test('checkMergePolicyAcknowledgement pushes a warning when unacknowledged, none when acknowledged or missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-merge-policy-ack-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ mergePolicy: 'fully_autonomous_merge' }),
    );

    const unacknowledgedReport = emptyReport(dir);
    checkMergePolicyAcknowledgement(dir, unacknowledgedReport);
    assert.equal(unacknowledgedReport.errors.length, 0);
    assert.equal(unacknowledgedReport.warnings.length, 1);
    assert.match(unacknowledgedReport.warnings[0], /mergePolicyAck/);

    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({
        mergePolicy: 'fully_autonomous_merge',
        mergePolicyAck: 'fully_autonomous_merge',
      }),
    );
    const acknowledgedReport = emptyReport(dir);
    checkMergePolicyAcknowledgement(dir, acknowledgedReport);
    assert.equal(acknowledgedReport.warnings.length, 0);
    assert.equal(acknowledgedReport.errors.length, 0);

    // No config.json at all: this check is not the file-presence gate —
    // it skips rather than erroring.
    rmSync(join(dir, '.github/idd/config.json'));
    const missingConfigReport = emptyReport(dir);
    checkMergePolicyAcknowledgement(dir, missingConfigReport);
    assert.equal(missingConfigReport.warnings.length, 0);
    assert.equal(missingConfigReport.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkMergePolicyAcknowledgement names idd-policy.json when only the legacy candidate is present (#2301 review)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-merge-policy-ack-legacy-'));
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ mergePolicy: 'fully_autonomous_merge' }),
    );

    const report = emptyReport(dir);
    checkMergePolicyAcknowledgement(dir, report);
    assert.equal(report.errors.length, 0);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /idd-policy\.json/);
    assert.doesNotMatch(report.warnings[0], /\.github\/idd\/config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPolicySignals recognizes the hyphenated copilot-advisory literal (#1827)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-policy-signals-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(
      join(dir, 'docs/idd-policy.md'),
      '# Review policy\n\nThis repository uses the copilot-advisory review policy profile.\n',
    );
    // A merge-policy signal must also be present so only the review-policy
    // branch is under test here.
    writeFileSync(
      join(dir, 'AGENTS.md'),
      'mergePolicy: fully_autonomous_merge\n',
    );

    const report = emptyReport(dir);
    checkPolicySignals(dir, report);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.ok(report.passes.includes('review policy signal found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPolicySignals still recognizes the unhyphenated prose form "copilot advisory"', () => {
  // Two adopter repositories worked around the pre-fix bug by rewording
  // their docs to read naturally as "the Copilot advisory review
  // profile" (#1827 Background) instead of recording the canonical
  // hyphenated value. The hyphenated-literal fix must not regress this
  // prose-only case for those repositories.
  const dir = mkdtempSync(join(tmpdir(), 'idd-policy-signals-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(
      join(dir, 'docs/idd-policy.md'),
      '# Review policy\n\nThis repository uses the Copilot advisory review profile.\n',
    );
    writeFileSync(
      join(dir, 'AGENTS.md'),
      'mergePolicy: fully_autonomous_merge\n',
    );

    const report = emptyReport(dir);
    checkPolicySignals(dir, report);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.ok(report.passes.includes('review policy signal found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPolicySignals still warns when no recognized review-policy signal is present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-policy-signals-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(
      join(dir, 'docs/idd-policy.md'),
      '# Review policy\n\nNo recognized signal here.\n',
    );
    writeFileSync(
      join(dir, 'AGENTS.md'),
      'mergePolicy: fully_autonomous_merge\n',
    );

    const report = emptyReport(dir);
    checkPolicySignals(dir, report);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, [
      'review policy signal not found in docs or entry files',
    ]);
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

test('classifyLiveConfigSchemaFinding truncates past 10 errors with an "and N more" suffix', () => {
  const config = {
    ...VALID_POLICY_CONFIG,
    // 12 unrelated unknown top-level keys, each its own additionalProperties
    // error, so the total exceeds the 10-error display cap.
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`_extra${i}`, true]),
    ),
  };
  const finding = classifyLiveConfigSchemaFinding(config, POLICY_SCHEMA);
  assert.ok(finding);
  assert.match(finding?.message ?? '', /\(and 2 more\)$/);
});

test('checkLiveConfigSchema also validates the legacy idd-policy.json path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-live-config-schema-legacy-'));
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ ...VALID_POLICY_CONFIG, _note: 'adopter comment' }),
    );

    const report = emptyReport(dir);
    checkLiveConfigSchema(dir, report);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /^idd-policy\.json fails schema validation/);
    assert.match(report.errors[0], /additional property "_note" not allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLiveConfigSchema checks both live-config filenames independently when both are present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-live-config-schema-both-'));
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify(VALID_POLICY_CONFIG),
    );
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ ...VALID_POLICY_CONFIG, _note: 'adopter comment' }),
    );

    const report = emptyReport(dir);
    checkLiveConfigSchema(dir, report);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /^idd-policy\.json fails schema validation/);
    assert.ok(
      report.passes.some((line) =>
        line.startsWith('.github/idd/config.json validates'),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// idd-skill#2010: evaluateBranchProtectionFindings combines a classic
// `branches/{branch}/protection` read with a GitHub Rulesets
// `rules/branches/{branch}` read. This matrix exercises every source
// combination `checkGithubReadiness` can see in production, without
// mocking `gh` -- the function is pure.
test('evaluateBranchProtectionFindings counts classic-only required checks and review policy', () => {
  const findings = evaluateBranchProtectionFindings([], {
    required_status_checks: { contexts: ['lint', 'test'], strict: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  });
  assert.deepEqual(findings, {
    requiredCheckCount: 2,
    requiredChecksSourcePinned: false,
    requiredChecksStrict: true,
    reviewPolicyConfigured: true,
  });
});

test('evaluateBranchProtectionFindings counts Rulesets-only required checks and review policy', () => {
  const findings = evaluateBranchProtectionFindings(
    [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'lint' }, { context: 'test' }],
        },
      },
      { type: 'pull_request', parameters: {} },
    ],
    {},
  );
  assert.deepEqual(findings, {
    requiredCheckCount: 2,
    requiredChecksSourcePinned: false,
    requiredChecksStrict: false,
    reviewPolicyConfigured: true,
  });
});

test('evaluateBranchProtectionFindings unions distinct check names from both sources without double-counting an overlapping name', () => {
  const findings = evaluateBranchProtectionFindings(
    [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'lint' }] },
      },
    ],
    {
      required_status_checks: { contexts: ['lint', 'test'], strict: false },
      required_pull_request_reviews: null,
    },
  );
  // 'lint' is required by both sources and counts once; 'test' is classic-
  // only. Review policy comes from the Rulesets rule below in a sibling
  // test -- here neither source configures one, so it stays unconfigured.
  assert.deepEqual(findings, {
    requiredCheckCount: 2,
    requiredChecksSourcePinned: false,
    requiredChecksStrict: false,
    reviewPolicyConfigured: false,
  });
});

test('evaluateBranchProtectionFindings reports neither source configured when both reads are empty', () => {
  const findings = evaluateBranchProtectionFindings([], {});
  assert.deepEqual(findings, {
    requiredCheckCount: 0,
    requiredChecksSourcePinned: false,
    requiredChecksStrict: false,
    reviewPolicyConfigured: false,
  });
});

test('evaluateBranchProtectionFindings treats a Rulesets "workflows" rule as configured despite zero enumerable check names (idd-skill#2010 review)', () => {
  // A branch protected solely by a Rulesets required-workflows rule has
  // real protection: summarizeBranchReviewRequirements() correctly cannot
  // contribute a check NAME for it (workflow-based requirements have no
  // enumerable context), but that must not read as "nothing configured".
  const findings = evaluateBranchProtectionFindings(
    [{ type: 'workflows', parameters: {} }],
    {},
  );
  assert.equal(findings.requiredCheckCount, 0);
  assert.equal(findings.requiredChecksSourcePinned, true);
});

test("evaluateBranchProtectionFindings honors a Rulesets required_status_checks rule's own strict policy (idd-skill#2010 review)", () => {
  const findings = evaluateBranchProtectionFindings(
    [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'lint' }],
          strict_required_status_checks_policy: true,
        },
      },
    ],
    {},
  );
  assert.equal(findings.requiredChecksStrict, true);
});

test('evaluateBranchProtectionFindings ignores a Rulesets strict policy whose own rule has an empty check list, even when another source supplies the counted checks (idd-skill#2010 review, Codex round 2)', () => {
  // GitHub's ruleset docs: strict_required_status_checks_policy "will not
  // take effect unless at least one status check is enabled" -- scoped to
  // that SAME rule's own check list, not the combined count from other
  // sources. Classic protection supplies the one counted check here, so
  // requiredCheckCount is 1, but the Rulesets rule claiming strict=true
  // has zero checks of its own and must not contribute strict=true.
  const findings = evaluateBranchProtectionFindings(
    [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [],
          strict_required_status_checks_policy: true,
        },
      },
    ],
    { required_status_checks: { contexts: ['lint'], strict: false } },
  );
  assert.equal(findings.requiredCheckCount, 1);
  assert.equal(findings.requiredChecksStrict, false);
});

test('evaluateBranchProtectionFindings strict stays false when neither classic nor Rulesets configures an up-to-date-head policy', () => {
  const findings = evaluateBranchProtectionFindings(
    [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'lint' }],
          strict_required_status_checks_policy: false,
        },
      },
    ],
    { required_status_checks: { contexts: [], strict: false } },
  );
  assert.equal(findings.requiredChecksStrict, false);
});

test('evaluateBranchProtectionFindings treats a zero-approval classic review requirement as configured (presence, not a minimum-count test)', () => {
  const findings = evaluateBranchProtectionFindings([], {
    required_pull_request_reviews: { required_approving_review_count: 0 },
  });
  assert.equal(findings.reviewPolicyConfigured, true);
});

// idd-skill#2010 review (Copilot round): isBranchProtectionUnreadable must
// warn only when BOTH governance reads are unreadable, not when either one
// is -- a Rulesets-only repository legitimately 404s on the classic
// `branches/{branch}/protection` endpoint even though its Rulesets read
// (`rules/branches/{branch}`) succeeds, and that must not be reported as
// unreadable even with `ciGate.trustEmptyProtectionReads` unset.
test('isBranchProtectionUnreadable is false when only the Rulesets read succeeds (classic 404, Rulesets-only repository)', () => {
  assert.equal(
    isBranchProtectionUnreadable({ unreadable: false }, { unreadable: true }),
    false,
  );
});

test('isBranchProtectionUnreadable is false when only the classic read succeeds (Rulesets 404, classic-only repository)', () => {
  assert.equal(
    isBranchProtectionUnreadable({ unreadable: true }, { unreadable: false }),
    false,
  );
});

test('isBranchProtectionUnreadable is false when both reads succeed', () => {
  assert.equal(
    isBranchProtectionUnreadable({ unreadable: false }, { unreadable: false }),
    false,
  );
});

test('isBranchProtectionUnreadable is true only when both reads are unreadable', () => {
  assert.equal(
    isBranchProtectionUnreadable({ unreadable: true }, { unreadable: true }),
    true,
  );
});

// idd-skill#2587: isRulesetsOnlyTrustGap warns (or, under --strict, errors)
// when a repository's branch protection is enforced only via GitHub
// Rulesets and ciGate.trustEmptyProtectionReads is not set -- the F2/F3
// merge gate still fails closed on the first merge attempt in that case,
// even though isBranchProtectionUnreadable (above) reports no problem.
test('isRulesetsOnlyTrustGap is true for a rulesets-only repository with trust unset', () => {
  assert.equal(
    isRulesetsOnlyTrustGap(
      { value: [{ type: 'required_status_checks' }], unreadable: false },
      { unreadable: true },
    ),
    true,
  );
});

test('isRulesetsOnlyTrustGap is false for a rulesets-only repository once trust is set (classic 404 trusted as empty)', () => {
  // ciGate.trustEmptyProtectionReads: true makes fetchGovernanceJson trust
  // the classic endpoint's 404 as genuinely empty, so branchProtectionRead
  // arrives with unreadable: false -- simulated directly here rather than
  // through a live config read, matching this predicate's pure,
  // dependency-free contract.
  assert.equal(
    isRulesetsOnlyTrustGap(
      { value: [{ type: 'required_status_checks' }], unreadable: false },
      { unreadable: false },
    ),
    false,
  );
});

test('isRulesetsOnlyTrustGap is false for classic-only protection (no enforcing Rulesets rules, classic read succeeds)', () => {
  assert.equal(
    isRulesetsOnlyTrustGap(
      { value: [], unreadable: false },
      { unreadable: false },
    ),
    false,
  );
});

test('isRulesetsOnlyTrustGap is false when neither read succeeds (isBranchProtectionUnreadable already covers this case)', () => {
  assert.equal(
    isRulesetsOnlyTrustGap(
      { value: [], unreadable: true },
      { unreadable: true },
    ),
    false,
  );
});

test('isRulesetsOnlyTrustGap is false when the repository has no Rulesets protection at all (empty rules array)', () => {
  assert.equal(
    isRulesetsOnlyTrustGap(
      { value: [], unreadable: false },
      { unreadable: true },
    ),
    false,
  );
});

test('formatRulesetsOnlyTrustGapWarning names ciGate.trustEmptyProtectionReads and the F2/F3 fail-closed consequence', () => {
  const message = formatRulesetsOnlyTrustGapWarning(
    'example-owner',
    'example-repo',
    'master',
  );
  assert.match(message, /ciGate\.trustEmptyProtectionReads/);
  assert.match(message, /F2\/F3/);
  assert.match(message, /example-owner\/example-repo:master/);
});

test('readTrustEmptyProtectionReads is false when .github/idd/config.json is absent, lacks ciGate, or is malformed (idd-skill#2010)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-trust-empty-protection-reads-'),
  );
  try {
    // No config file at all.
    assert.equal(readTrustEmptyProtectionReads(dir), false);

    // Config present but no ciGate key.
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(join(dir, '.github/idd/config.json'), JSON.stringify({}));
    assert.equal(readTrustEmptyProtectionReads(dir), false);

    // ciGate present but trustEmptyProtectionReads explicitly false.
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ ciGate: { trustEmptyProtectionReads: false } }),
    );
    assert.equal(readTrustEmptyProtectionReads(dir), false);

    // Malformed JSON must never widen trust beyond the safe default.
    writeFileSync(join(dir, '.github/idd/config.json'), '{ not json');
    assert.equal(readTrustEmptyProtectionReads(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTrustEmptyProtectionReads is true only when ciGate.trustEmptyProtectionReads is exactly true (idd-skill#2010)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-trust-empty-protection-reads-true-'),
  );
  try {
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ ciGate: { trustEmptyProtectionReads: true } }),
    );
    assert.equal(readTrustEmptyProtectionReads(dir), true);

    // A truthy-but-non-boolean value must not widen trust (mirrors
    // pre-merge-readiness.mts's `=== true` comparison).
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ ciGate: { trustEmptyProtectionReads: 'true' } }),
    );
    assert.equal(readTrustEmptyProtectionReads(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTrustEmptyProtectionReads also reads the legacy idd-policy.json path when the canonical file is absent (idd-skill#2028)', () => {
  const dir = mkdtempSync(
    join(tmpdir(), 'idd-doctor-trust-empty-protection-reads-legacy-'),
  );
  try {
    writeFileSync(
      join(dir, 'idd-policy.json'),
      JSON.stringify({ ciGate: { trustEmptyProtectionReads: true } }),
    );
    assert.equal(readTrustEmptyProtectionReads(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchGhApiJsonAt preserves a failed `gh api` call\'s stdout so fetchGovernanceJson honors ciGate.trustEmptyProtectionReads from a JSON error body\'s "status" field (idd-skill#2044)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-fetch-gh-api-stdout-'));
  // Fake `gh` that fails a `gh api` call with a JSON error body on stdout
  // only -- no stderr `(HTTP nnn)` suffix -- the failure shape
  // deriveGhHttpStatus() falls back to a JSON body's "status" field for.
  const restore = stubExecutable(
    'gh',
    `process.stdout.write('{"message":"Not Found","status":"404"}');
process.exit(1);
`,
  );
  try {
    const fetchJson = (path: string, paginate: boolean) =>
      fetchGhApiJsonAt(dir, undefined, path, paginate);

    assert.deepEqual(
      fetchGovernanceJson(
        'repos/owner/repo/branches/main/protection',
        false,
        true,
        {},
        fetchJson,
      ),
      { value: {}, unreadable: false },
    );
    assert.deepEqual(
      fetchGovernanceJson(
        'repos/owner/repo/branches/main/protection',
        false,
        false,
        {},
        fetchJson,
      ),
      { value: {}, unreadable: true },
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// idd-skill#2010 review (Codex round 2): `gh api` never infers its target
// host from the checked-out repository's Git remote (unlike a higher-level
// subcommand such as `gh repo view`), so idd-doctor.mts's governance reads
// must derive and pass an explicit `--hostname` for a GHES-hosted target
// repository instead of relying on `cwd`.
test('resolveTargetGhHostname returns the explicit "github.com" override for a github.com URL, and undefined for an absent/unparseable URL (idd-skill#2030)', () => {
  assert.equal(
    resolveTargetGhHostname('https://github.com/kurone-kito/idd-skill'),
    'github.com',
  );
  assert.equal(resolveTargetGhHostname(undefined), undefined);
  assert.equal(resolveTargetGhHostname('not a url'), undefined);
});

test('resolveTargetGhHostname resolves a GHES hostname, lowercased', () => {
  assert.equal(
    resolveTargetGhHostname('https://GHE.example.com/owner/repo'),
    'ghe.example.com',
  );
});

// idd-skill#2052: the resolver now preserves an explicit non-default
// port (`URL.host`, not `URL.hostname`) -- `gh api --hostname` still
// rejects any value containing a colon (confirmed against a real `gh`
// binary), but that constraint is `fetchGhApiJsonAt`'s to handle (it
// routes a ported host through an absolute API URL instead), not the
// resolver's. See that function's own test below.
test('resolveTargetGhHostname preserves an explicit non-default port for a GHES hostname', () => {
  assert.equal(
    resolveTargetGhHostname('https://ghe.example.com:8443/owner/repo'),
    'ghe.example.com:8443',
  );
});

test('resolveTargetGhHostname drops an explicit but default port (Node URL.host elision)', () => {
  assert.equal(
    resolveTargetGhHostname('https://ghe.example.com:443/owner/repo'),
    'ghe.example.com',
  );
});

// idd-skill#2052 (issue AC): the #2030 review finding was specifically
// that resolver-only coverage missed the failure mode where a ported
// hostname reached `gh api --hostname` and hard-failed argv validation --
// so this asserts the actual argv `fetchGhApiJsonAt` builds, not just
// `resolveTargetGhHostname`'s return value.
test('fetchGhApiJsonAt routes a ported hostname through an absolute API URL and omits --hostname', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-fetch-gh-api-ported-'));
  const argvLog = join(dir, 'argv.log');
  // Fake `gh` that records its own argv (one arg per line) instead of
  // making a real request, then returns an empty successful response.
  const restore = stubExecutable(
    'gh',
    `require('node:fs').writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join('\\n') + '\\n');
process.stdout.write('{}');
`,
  );
  try {
    fetchGhApiJsonAt(
      dir,
      'ghe.example.com:8443',
      'repos/owner/repo/branches/main/protection',
      false,
    );

    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      'api',
      'https://ghe.example.com:8443/api/v3/repos/owner/repo/branches/main/protection',
    ]);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchGhApiJsonAt keeps the prior --hostname argv shape for a non-ported hostname', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-doctor-fetch-gh-api-unported-'));
  const argvLog = join(dir, 'argv.log');
  const restore = stubExecutable(
    'gh',
    `require('node:fs').writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join('\\n') + '\\n');
process.stdout.write('{}');
`,
  );
  try {
    fetchGhApiJsonAt(
      dir,
      'ghe.example.com',
      'repos/owner/repo/branches/main/protection',
      false,
    );

    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      'api',
      'repos/owner/repo/branches/main/protection',
      '--hostname',
      'ghe.example.com',
    ]);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
