import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO_ROOT, 'scripts/repository-instruction-audit.mjs');
const AUDIT_DOCS = join(REPO_ROOT, 'scripts/audit-docs.mjs');

const specificity = [
  '## Specificity target',
  '### Three specificity bands',
  '**Under-specified** **Target** **Over-specified**',
  'frontier cloud model class middle-tier cloud model class lightweight local or compact cloud model class',
  '"ready and stable for a middle-tier model," not "maximally detailed."',
  '## Dependency minimization',
  'true correctness, availability, or ordering constraint; roadmap task-list entries; artificial serial chain; artificial sibling issues only to widen parallel execution; justify each dependency edge; natural cohesion.',
  '## Nested roadmap nodes',
  'coordination boundary, active child list, or multi-session handoff; roadmap node, not a normal execution candidate; parent roadmap task list; links the active child work it coordinates; normal A3/A4/A5 execution work; true execution dependencies or sequential roadmap dependencies; closed intermediate roadmaps with hidden open descendants.',
  '## Human-dependency isolation',
  'Treat unresolved human dependency as a side effect. **Front-load** human-dependent work. **Back-load** human-dependent work. maintainer-only action. unavailable system becomes usable again. Route unresolved choices to `needs-decision`. `blocked-by-human`. `deferred`. approval-needed hold. it is not yet `ready`. protect autonomous completion and clear verification.',
  '## Hidden human-dependency validation',
  'routing aid, not a rigid wording linter; credentials, external access, hardware, or infrastructure; `blocked-by-human`; product, policy, or design decision; `needs-decision`; subjective human approval; objective verification; optional review or publication judgment; roadmap narrative; approval-needed hold; dependency marker; true start blockers; post-implementation code review, merge approval, or publication choice.',
  'each nested roadmap node is linked from the parent roadmap task list and links its own active child work; each nested roadmap remains identifiable as a coordination/audit node instead of a normal execution candidate; used only for true sequential dependencies, never to group nested roadmap children.',
  'acceptance criteria are locally verifiable; any dependency marker is resolvable, intentionally chosen, and the issue can be claimed independently without absorbing sibling work.',
].join('\n');

const agentSharedHeadings = [
  '## Minimum requirements',
  '## Project standards',
  '## Key workflow rules',
  '## For IDD work',
];

const discoverSection = [
  '## A3.5 — Apply issue-author approval gate',
  'approval-needed fallback bucket; skipIssueAuthorApprovalGate; maintainerApprovalActorPolicy; owners-and-maintainers-only; all-write-permission-actors; visible approval comment; IDD ready; bare organization `MEMBER` association; stop before A5; do not auto-claim from the fallback bucket.',
  '## A4 — Gate, then pick',
].join('\n');
const claimSection = [
  '**(a) Issue-author approval gate**',
  'stop without claiming; bare organization `MEMBER` association',
  '**(b) Assignee and project status**',
].join('\n');

const issueAuthorPolicySection = [
  '## Non-Configurable Safety Invariants',
  'Claim revalidation still runs before every mutating side effect. Marker-shaped comments from untrusted authors never gain authority. Forced handoff remains human-gated only. Approval-needed fallback issues remain a stop condition for unattended discovery.',
  'These rules are fixed gates, not policy knobs. Claim revalidation gate. Marker trust / authority. Forced handoff initiator. Approval-needed fallback.',
  '## Helper Runtime Profile',
  '## Forced Handoff Defaults',
].join('\n');

const onboarding = [
  'ONBOARDING entry files: `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.',
  'The operator explicitly opts out of adding new files when requested.',
  'If `.github/copilot-instructions.md` existed before onboarding, update it.',
  'docs/onboarding/placeholders.md docs/onboarding/policy-decisions.md docs/onboarding/agent-entry-and-verification.md',
  'all seven placeholders: `{{TRUSTED_MARKER_ACTOR}}`',
  'perform a global replacement for: `{{TRUSTED_MARKER_ACTOR}}`',
  'critique-loop profile (distributed defaults, or a documented repository override)',
  'claim-timing defaults (`claim-stale-age` and `claim-heartbeat-interval`)',
  'CI wait policy defaults (`ciWait.runningTimeout`, `ciWait.generationTimeout`, `ciWait.rerunPolicy`)',
  'issue-author approval gate (`enabled-by-default` by default, or explicit config opt-out via `skipIssueAuthorApprovalGate: true`)',
  'critique-loop profile, credential scope, claim-timing defaults, CI wait policy defaults, issue-author approval gate, maintainer approval actor policy, issue-authoring companion status, helper runtime profile, IDD label names, the up-to-date-head ruleset check, and bootstrap execution mode.',
  'review-thread resolution policy and critique-loop profile are recorded.',
  'selected CI wait policy values, merge policy, credential scope, claim timing values, issue-author approval gate decision,',
  '`.github/instructions/idd-overview-core.instructions.md` keeps',
  'helper runtime profile (`instructions-only` by default, or an evidence-based helper profile recommendation that still requires explicit operator confirmation)',
  'issue-authoring companion status and selected native destination',
  '## CLI-assisted onboarding',
  'Use --import with the shared idd-template-core-files generated block.',
  '<!-- audit:generated id=idd-template-core-files -->',
  'docs/onboarding/agent-entry-and-verification.md docs/onboarding/placeholders.md docs/onboarding/policy-decisions.md',
  '<!-- /audit:generated -->',
  '<!-- audit:generated id=issue-authoring-companion-files -->',
  'skills/issue-authoring/SKILL.md skills/issue-authoring/references/contract.md skills/issue-authoring/references/draft-patterns.md skills/issue-authoring/references/workflow-boundary.md',
  '<!-- /audit:generated -->',
  '<!-- audit:generated id=idd-spec-audit-companion-files -->',
  'skills/idd-spec-audit/SKILL.md skills/idd-spec-audit/references/report-template.md',
  '<!-- /audit:generated -->',
].join('\n');

const configurationDocs = [
  '2. `npx` when available; 3. `true` when unavailable or not relevant',
  '(2) use bare `npx <tool>` when `npx` is available; (3) replace with `true` when `npx` is unavailable or the check is not relevant to the project.',
  'or the check is not relevant to the project.',
  'Auto-propose helper support only when repository evidence shows a real package-manager or Node.js helper path, keep operator confirmation explicit, prefer `package-manager` when supported package-manager evidence exists, and otherwise prefer `vendored-node` before `ephemeral-npx`.',
].join('\n');

const placeholderGuide = [
  '### `{{TRUSTED_MARKER_ACTOR}}`',
  'Use a single GitHub login string first.',
  'For extra users, add quoted array entries manually.',
  'Only the command placeholders may be set to `true`.',
  '### `{{FIX_VALIDATE_COMMANDS}}`',
  'Node.js without a relevant script but with `npx` available:',
  'no relevant auto-fix tooling: `true`',
  '### `{{PRE_PUSH_VALIDATE_COMMANDS}}`',
  'Node.js without a relevant script but with `npx` available:',
  'no relevant verification command: `true`',
  '### `{{POST_FIX_VALIDATE_COMMANDS}}`',
  'declared `packageManager` metadata or exactly one supported lockfile; bare `package.json` without those signals → do not infer `npm install` from that alone.',
].join('\n');

const overview = [
  '`npx <tool>` if Node.js and `npx` are available',
  '| **fix-validate** | `{{FIX_VALIDATE_COMMANDS}}` |',
  '| **pre-push-validate** | `{{PRE_PUSH_VALIDATE_COMMANDS}}` |',
  '| **post-fix-validate** | `{{POST_FIX_VALIDATE_COMMANDS}}` |',
  '| **install-deps** | `{{INSTALL_DEPS_COMMAND}}` |',
  'Absent values keep the gate enabled and default approval actors to `owners-and-maintainers-only`.',
  'skipIssueAuthorApprovalGate maintainerApprovalActorPolicy',
].join('\n');

const helperDocs = [
  'Use repository evidence to decide whether helper support should be proposed for operator confirmation.',
  'If supported `packageManager` metadata or exactly one supported lockfile is present, propose `package-manager`.',
  'For other profiles use the profile-selected `idd:ci-wait-policy` command.',
  'append `--rerun-count <count>` to the selected command.',
].join('\n');

const phaseMap = [
  '## IDD file map',
  'A0-T–A4 A4.5 B1-B3 + C1-C6 F2.5 Resume Step 0-3 Resume S1-S5',
  '## Next section',
].join('\n');

const workflowOnboardingSentence =
  'During onboarding, create or update `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` so each non-Copilot agent listed above has a stable first file to read. GitHub Copilot remains an update-if-present surface via `.github/copilot-instructions.md`. Skipping creation of a missing root entry file should be an explicit operator choice, not the default.';

const workflow = [
  phaseMap,
  workflowOnboardingSentence,
  'helper-backed evidence collectors first',
].join('\n');

const manifest = {
  syncPairs: [
    {
      id: 'idd-suitability-instructions',
      source:
        'idd-template/.github/instructions/idd-suitability.instructions.md',
      target: '.github/instructions/idd-suitability.instructions.md',
      mode: 'concreted',
      replacements: [{ from: '{{PROJECT_MARKER_PREFIX}}', to: 'idd-skill' }],
    },
  ],
  generatedBlocks: [
    {
      id: 'idd-template-core-files',
      file: 'idd-template/ONBOARDING.md',
      paths: [
        'idd-template/docs/onboarding/agent-entry-and-verification.md',
        'idd-template/docs/onboarding/placeholders.md',
        'idd-template/docs/onboarding/policy-decisions.md',
      ],
      sourceGlobs: ['idd-template/docs/onboarding/*.md'],
    },
  ],
};

const suitabilityTemplate = [
  '# Suitability',
  '`{{PROJECT_MARKER_PREFIX}}-autopilot-suitability`',
  'Issue-author approval is a separate pre-claim gate.',
].join('\n');
const suitabilityBanner = [
  '<!-- idd-generated-from:',
  'idd-template/.github/instructions/idd-suitability.instructions.md',
  'Generated by sync-docs. Edit the source above, then run',
  '`node scripts/sync-docs.mjs --apply`; do not edit this file.',
  '-->',
  '',
  '',
].join('\n');

const distribution = [
  '<!-- audit:shell-list id=issue-authoring-companion-gh-api-loop -->',
  '```sh',
  'gh api contents/skills/issue-authoring/$' + '{FILE}',
  'SKILL_DEST="$' + '{DEST}/.agents/skills/issue-authoring"',
  'cp "$' + '{FILE}" "$' + '{SKILL_DEST}/$' + '{FILE}"',
  '```',
  '<!-- audit:shell-list id=issue-authoring-companion-curl-loop -->',
  '```sh',
  'BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/skills/issue-authoring"',
  'SKILL_DEST="$' + '{DEST}/.agents/skills/issue-authoring"',
  'cp "$' + '{FILE}" "$' + '{SKILL_DEST}/$' + '{FILE}"',
  '```',
  '<!-- audit:shell-list id=idd-spec-audit-companion-gh-api-loop -->',
  '```sh',
  'gh api contents/skills/idd-spec-audit/$' + '{FILE}',
  'SKILL_DEST="$' + '{DEST}/.agents/skills/idd-spec-audit"',
  'cp "$' + '{FILE}" "$' + '{SKILL_DEST}/$' + '{FILE}"',
  '```',
  '<!-- audit:shell-list id=idd-spec-audit-companion-curl-loop -->',
  '```sh',
  'BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/skills/idd-spec-audit"',
  'SKILL_DEST="$' + '{DEST}/.agents/skills/idd-spec-audit"',
  'cp "$' + '{FILE}" "$' + '{SKILL_DEST}/$' + '{FILE}"',
  '```',
  '## Local-copy installs',
  'SOURCE="skills/issue-authoring"',
  'TARGET_REPO="/target"',
  'SKILL_DEST="$' + '{TARGET_REPO}/.agents/skills/issue-authoring"',
  'cp -R "$' + '{SOURCE}/." "$' + '{SKILL_DEST}/"',
  '## Maintenance checklist',
].join('\n');

const companionPolicy = [
  'selected destination alongside',
  '**Native destination**:',
  'canonical source path and the installed destination',
  'issue-authoring companion status should record the selected native destination',
  '### Credential scope',
  '### Critique-loop profile',
  'Review `docs/permissions.md` with the operator.',
  '### Credential Scope',
  '### Critique-Loop Profile',
  'single GitHub login string first; extra quoted array entries manually.',
  'Auto-propose a helper runtime profile only when repository evidence shows a supported package-manager path or another real Node.js helper path, but require explicit operator confirmation before recording anything other than `instructions-only`.',
  'npx --yes --package <reviewed-helper-spec> \\',
  '  idd-helper-bundle-manifest --profile <selected-profile>',
  'Treat `refs/heads/main` as a manual opt-in.',
].join('\n');

const companionVerification = [
  'source-versus-destination contract',
  '.agents/skills/issue-authoring/SKILL.md',
  'the native destination contains `SKILL.md`',
  '### CLAUDE.md',
  '### AGENTS.md (for Codex CLI, OpenCode, Grok Build, and Cursor CLI)',
  '### GEMINI.md',
  '## Verification details',
  'selected critique-loop profile is recorded',
  '`.github/instructions/idd-overview-core.instructions.md` has',
  '`.github/instructions/idd-discover.instructions.md` and `.github/instructions/idd-overview-core.instructions.md`',
].join('\n');

const baseFiles: Record<string, string> = {
  'AGENTS.md': [
    agentSharedHeadings[0],
    agentSharedHeadings[1],
    '**Helper sources**: the helper migration to TypeScript is complete.',
    'See [docs/typescript-sources.md](docs/typescript-sources.md).',
    agentSharedHeadings[2],
    agentSharedHeadings[3],
    '## Branch strategy',
    '## Commit rules',
    '## Dogfood: token-cost events',
    '## Issue-authoring skill (dogfooded)',
    '## Codex issue-authoring route',
    'canonical issue-authoring bundle `.claude/skills/issue-authoring/` `.agents/skills/issue-authoring/`',
  ].join('\n'),
  'CLAUDE.md': [
    '@AGENTS.md',
    'In Claude Code specifically, use --vendor claude in Claude Code.',
    '.claude/skills/issue-authoring/',
  ].join('\n'),
  'GEMINI.md': ['@AGENTS.md', 'Antigravity vendor token-cost skip.'].join('\n'),
  '.github/copilot-instructions.md': [
    '## Commit rules',
    'See AGENTS.md#commit-rules.',
  ].join('\n'),
  '.github/instructions/idd-discover.instructions.md': discoverSection,
  'idd-template/.github/instructions/idd-discover.instructions.md':
    discoverSection,
  '.github/instructions/idd-claim.instructions.md': claimSection,
  'idd-template/.github/instructions/idd-claim.instructions.md': claimSection,
  '.github/instructions/idd-suitability.instructions.md':
    suitabilityBanner +
    suitabilityTemplate.replaceAll('{{PROJECT_MARKER_PREFIX}}', 'idd-skill'),
  'idd-template/.github/instructions/idd-suitability.instructions.md':
    suitabilityTemplate,
  '.github/idd/config.json': JSON.stringify({ markerPrefix: 'idd-skill' }),
  'idd-template/.github/idd/config.json': [
    '{',
    '  "trustedMarkerActors": ["{{TRUSTED_MARKER_ACTOR}}"],',
    '  "install-deps": "{{INSTALL_DEPS_COMMAND}}",',
    '  "fix-validate": "{{FIX_VALIDATE_COMMANDS}}",',
    '  "pre-push-validate": "{{PRE_PUSH_VALIDATE_COMMANDS}}",',
    '  "post-fix-validate": "{{POST_FIX_VALIDATE_COMMANDS}}"',
    '}',
  ].join('\n'),
  'audit/sync-manifest.json': JSON.stringify(manifest),
  '.github/instructions/idd-overview-core.instructions.md': overview.replace(
    '`npx <tool>` if Node.js and `npx` are available',
    '`npx <tool>` only when `npx` is available',
  ),
  'idd-template/.github/instructions/idd-overview-core.instructions.md':
    overview,
  'docs/customization.md': [issueAuthorPolicySection, configurationDocs].join(
    '\n',
  ),
  'idd-template/docs/customization.md': [
    issueAuthorPolicySection,
    configurationDocs,
  ].join('\n'),
  'docs/policy-constants.md': issueAuthorPolicySection,
  'idd-template/docs/policy-constants.md': issueAuthorPolicySection,
  'docs/issue-authoring-skill.md': specificity,
  'skills/issue-authoring/references/contract.md': specificity,
  'skills/issue-authoring/references/draft-patterns.md': [
    '## Hidden human-dependency quick check',
    'unresolved credentials, access, or unavailable infrastructure; `needs-decision`; objective verification; optional post-implementation review stays optional; approval-needed hold; true start blockers rather than grouping related work; subjective approval; grouping-only dependency markers.',
    '## Nested roadmap chooser note Parent roadmap `## Tracks` excerpt: Nested roadmap `#510` `## Tracks` excerpt: coordination/audit node normal execution issue.',
    '## Dependency minimization examples',
    '### Natural parallel decomposition',
    '### Artificial decomposition',
    'Bad serial chain:',
    'Bad split for parallelism:',
  ].join('\n'),
  'idd-template/docs/onboarding/template-distribution.md': distribution,
  'idd-template/docs/onboarding/policy-decisions.md': companionPolicy,
  'idd-template/docs/onboarding/agent-entry-and-verification.md':
    companionVerification,
  'idd-template/ONBOARDING.md': onboarding,
  'idd-template/docs/onboarding/placeholders.md': placeholderGuide,
  'idd-template/README.md':
    '| `{{TRUSTED_MARKER_ACTOR}}` | Single JSON-escaped trusted marker login',
  'docs/idd-helper-scripts.md': helperDocs,
  'idd-template/docs/idd-helper-scripts.md': helperDocs,
  '.github/instructions/idd-ci.instructions.md':
    '<profile-selected-ci-wait-policy-command> Do not hardcode node scripts/ci-wait-policy.mjs',
  'idd-template/.github/instructions/idd-ci.instructions.md':
    '<profile-selected-ci-wait-policy-command> Do not hardcode node scripts/ci-wait-policy.mjs',
  'docs/idd-workflow.md': workflow,
  'idd-template/docs/idd-workflow.md': workflow,
};

function writeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'idd-repository-instruction-audit-'));
  for (const [relativePath, text] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

function runAudit(root: string) {
  return spawnSync(process.execPath, [CLI, '--root', root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function writeAggregateFixture(
  origin: 'canonical' | 'fork' | 'missing',
  packageName = '@kurone-kito/idd-skill',
): string {
  const files = {
    ...baseFiles,
    'AGENTS.md': baseFiles['AGENTS.md'].replace('## Branch strategy\n', ''),
    'package.json': JSON.stringify({ name: packageName }),
  };
  const root = writeFixture(files);
  execFileSync('git', ['init', '--quiet'], { cwd: root, env: fixtureEnv() });
  if (origin !== 'missing') {
    const url =
      origin === 'canonical'
        ? 'git@github.com:kurone-kito/idd-skill.git'
        : 'git@github.com:example/idd-skill-fork.git';
    execFileSync('git', ['remote', 'add', 'origin', url], {
      cwd: root,
      env: fixtureEnv(),
    });
  }
  return root;
}

function runAggregateAudit(root: string) {
  return spawnSync(process.execPath, [AUDIT_DOCS, '--check'], {
    cwd: root,
    env: fixtureEnv(),
    encoding: 'utf8',
  });
}

function snapshot(root: string, relative = ''): [string, string][] {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) return snapshot(root, path);
      return [
        [path, readFileSync(join(root, path), 'utf8')] as [string, string],
      ];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

test('repository instruction audit CLI accepts a positive read-only scratch fixture', () => {
  const root = writeFixture(baseFiles);
  try {
    const before = snapshot(root);
    const result = runAudit(root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /no violations/u);
    assert.deepEqual(
      snapshot(root),
      before,
      'the audit CLI must not modify fixture files',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs runs source contracts for the canonical repository identity', () => {
  const root = writeAggregateFixture('canonical');
  try {
    const result = runAggregateAudit(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /repository-instruction-audit\/agent-entry\.canonical-sections: AGENTS\.md/u,
    );
    assert.doesNotMatch(output, /source-origin/u);
    assert.doesNotMatch(
      output,
      /notice: repository-instruction-audit: package identity matched the source repository but origin/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs runs source contracts for a fork and reports its origin', () => {
  const root = writeAggregateFixture('fork');
  try {
    const result = runAggregateAudit(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /repository-instruction-audit\/agent-entry\.canonical-sections: AGENTS\.md/u,
    );
    assert.match(
      output,
      /notice: repository-instruction-audit: package identity matched the source repository but origin is non-canonical; running source checks/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs reports unavailable origin and still runs source contracts', () => {
  const root = writeAggregateFixture('missing');
  try {
    const result = runAggregateAudit(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /notice: repository-instruction-audit: package identity matched the source repository but origin URL is unavailable; running source checks/u,
    );
    assert.match(
      output,
      /repository-instruction-audit\/source-origin: package\.json: source repository origin URL is unavailable/u,
    );
    assert.doesNotMatch(output, /No such remote 'origin'/u);
    assert.match(
      output,
      /repository-instruction-audit\/agent-entry\.canonical-sections: AGENTS\.md/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs runs source contracts from canonical origin after package rename', () => {
  const root = writeAggregateFixture('canonical', '@example/renamed-package');
  try {
    const result = runAggregateAudit(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /repository-instruction-audit\/agent-entry\.canonical-sections: AGENTS\.md/u,
    );
    assert.match(
      output,
      /notice: repository-instruction-audit: canonical source origin matched but package identity differs; running source checks/u,
    );
    assert.doesNotMatch(output, /repository-instruction-audit\/source-origin/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs rejects duplicate generated markers through the aggregate', () => {
  const root = writeAggregateFixture('canonical');
  try {
    const target = join(root, 'idd-template/ONBOARDING.md');
    const marker = '<!-- audit:generated id=idd-template-core-files -->';
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n${marker}\n`);
    const result = runAggregateAudit(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(
      output,
      /idd-template-core-files: idd-template\/ONBOARDING\.md must contain exactly one <!-- audit:generated id=idd-template-core-files --> \(found 2\)/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit-docs reports malformed package roots and continues the audit', () => {
  const cases = [
    {
      contents: '{ invalid json',
      diagnostic: /engines-range-mirrors: package\.json could not be parsed/u,
    },
    {
      contents: 'null',
      diagnostic: /engines-range-mirrors: package\.json must be a JSON object/u,
    },
    {
      contents: '[]',
      diagnostic: /engines-range-mirrors: package\.json must be a JSON object/u,
    },
  ];

  for (const testCase of cases) {
    const root = writeAggregateFixture('canonical');
    try {
      writeFileSync(join(root, 'package.json'), testCase.contents);
      const result = runAggregateAudit(root);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.match(output, testCase.diagnostic);
      assert.doesNotMatch(
        output,
        /SyntaxError|TypeError|Cannot read properties|at main \(/u,
      );
      assert.match(output, /documentation audit failed/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repository instruction audit rejects malformed JSON object shapes', () => {
  const cases = [
    {
      path: 'audit/sync-manifest.json',
      contents: JSON.stringify({ syncPairs: {} }),
      ruleId: 'approval-gate.suitability-pair',
    },
    {
      path: 'audit/sync-manifest.json',
      contents: JSON.stringify({ generatedBlocks: {} }),
      ruleId: 'non-node.generated-import-surface',
    },
    {
      path: '.github/idd/config.json',
      contents: 'null',
      ruleId: 'approval-gate.config',
    },
  ];

  for (const testCase of cases) {
    const files = { ...baseFiles, [testCase.path]: testCase.contents };
    const root = writeFixture(files);
    try {
      const result = runAudit(root);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.ok(output.includes(testCase.ruleId), output);
      assert.ok(output.includes(testCase.path), output);
      assert.doesNotMatch(output, /TypeError|Cannot read properties/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const mutations: {
  name: string;
  ruleId: string;
  path: string;
  mutate: (files: Record<string, string>) => void;
}[] = [
  {
    name: 'agent-entry contract',
    ruleId: 'agent-entry.canonical-sections',
    path: 'AGENTS.md',
    mutate: (files) => {
      files['AGENTS.md'] = files['AGENTS.md'].replace(
        '## Branch strategy\n',
        '',
      );
    },
  },
  {
    name: 'agent-entry top-level heading depth',
    ruleId: 'agent-entry.canonical-sections',
    path: 'AGENTS.md',
    mutate: (files) => {
      files['AGENTS.md'] = files['AGENTS.md'].replace(
        '## Project standards\n',
        '### Project standards\n',
      );
    },
  },
  {
    name: 'approval-gate contract',
    ruleId: 'approval-gate.discover',
    path: '.github/instructions/idd-discover.instructions.md',
    mutate: (files) => {
      files['.github/instructions/idd-discover.instructions.md'] = files[
        '.github/instructions/idd-discover.instructions.md'
      ].replace('IDD ready', 'ready');
    },
  },
  {
    name: 'suitability concreted pair',
    ruleId: 'approval-gate.suitability-pair',
    path: 'audit/sync-manifest.json',
    mutate: (files) => {
      files['audit/sync-manifest.json'] = files[
        'audit/sync-manifest.json'
      ].replace('"mode":"concreted"', '"mode":"exact"');
    },
  },
  {
    name: 'suitability configured marker prefix',
    ruleId: 'approval-gate.suitability-pair',
    path: '.github/instructions/idd-suitability.instructions.md',
    mutate: (files) => {
      files['audit/sync-manifest.json'] = files[
        'audit/sync-manifest.json'
      ].replace('"to":"idd-skill"', '"to":"other-project"');
    },
  },
  {
    name: 'suitability unresolved marker prefix',
    ruleId: 'approval-gate.suitability-pair',
    path: '.github/instructions/idd-suitability.instructions.md',
    mutate: (files) => {
      files['audit/sync-manifest.json'] = files[
        'audit/sync-manifest.json'
      ].replace('"to":"idd-skill"', '"to":"{{PROJECT_MARKER_PREFIX}}"');
    },
  },
  {
    name: 'specificity contract',
    ruleId: 'issue-authoring.specificity-content',
    path: 'docs/issue-authoring-skill.md',
    mutate: (files) => {
      files['docs/issue-authoring-skill.md'] = files[
        'docs/issue-authoring-skill.md'
      ].replace('frontier cloud model class', 'large model class');
      files['skills/issue-authoring/references/contract.md'] = files[
        'skills/issue-authoring/references/contract.md'
      ].replace('frontier cloud model class', 'large model class');
    },
  },
  {
    name: 'companion path contract',
    ruleId: 'onboarding.companion-paths',
    path: 'idd-template/docs/onboarding/template-distribution.md',
    mutate: (files) => {
      files['idd-template/docs/onboarding/template-distribution.md'] = files[
        'idd-template/docs/onboarding/template-distribution.md'
      ].replace(
        '$' + '{DEST}/.agents/skills/issue-authoring',
        '$' + '{DEST}/skills/issue-authoring',
      );
    },
  },
  {
    name: 'canonical companion inventory',
    ruleId: 'onboarding.companion-inventory',
    path: 'idd-template/ONBOARDING.md',
    mutate: (files) => {
      files['idd-template/ONBOARDING.md'] = files[
        'idd-template/ONBOARDING.md'
      ].replace(
        'skills/idd-spec-audit/references/report-template.md',
        'skills/idd-spec-audit/references/missing.md',
      );
    },
  },
  {
    name: 'non-Node fallback contract',
    ruleId: 'non-node.fallback-wording',
    path: 'docs/customization.md',
    mutate: (files) => {
      files['docs/customization.md'] = files['docs/customization.md'].replace(
        '2. `npx` when available',
        '2. use Node.js when available',
      );
    },
  },
  {
    name: 'workflow phase map',
    ruleId: 'workflow.phase-map',
    path: 'docs/idd-workflow.md',
    mutate: (files) => {
      files['docs/idd-workflow.md'] = files['docs/idd-workflow.md'].replace(
        'A0-T–A4 A4.5',
        'A0-T–A4',
      );
    },
  },
  {
    name: 'workflow phase map top-level heading depth',
    ruleId: 'workflow.phase-map',
    path: 'docs/idd-workflow.md',
    mutate: (files) => {
      files['docs/idd-workflow.md'] = files['docs/idd-workflow.md'].replace(
        '## IDD file map\n',
        '### IDD file map\n',
      );
    },
  },
  {
    name: 'distributed pnpm boundary',
    ruleId: 'pnpm-boundary.distributed-docs',
    path: 'docs/idd-helper-scripts.md',
    mutate: (files) => {
      files['docs/idd-helper-scripts.md'] += '\n`pnpm install`';
    },
  },
  {
    name: 'generated import anchor uniqueness',
    ruleId: 'onboarding.generated-import-anchor',
    path: 'idd-template/ONBOARDING.md',
    mutate: (files) => {
      files['idd-template/ONBOARDING.md'] +=
        '\n<!-- audit:generated id=idd-template-core-files -->';
    },
  },
  {
    name: 'generated import anchor top-level heading depth',
    ruleId: 'onboarding.generated-import-anchor',
    path: 'idd-template/ONBOARDING.md',
    mutate: (files) => {
      files['idd-template/ONBOARDING.md'] = files[
        'idd-template/ONBOARDING.md'
      ].replace(
        '## CLI-assisted onboarding\n',
        '### CLI-assisted onboarding\n',
      );
    },
  },
];

for (const mutation of mutations) {
  test(`repository instruction audit CLI reports ${mutation.name} violations`, () => {
    const files = { ...baseFiles };
    mutation.mutate(files);
    const root = writeFixture(files);
    try {
      const result = runAudit(root);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.ok(output.includes(mutation.ruleId), output);
      assert.ok(output.includes(mutation.path), output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
