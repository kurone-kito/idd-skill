import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectRepositoryPolicyViolationsFromDocuments,
  NEEDS_DECISION_ROUTE_PINS,
  PR_HEAD_FRESHNESS_PINS,
  REGRESSION_DEFINITION_PINS,
  REVIEW_TRIAGE_DONOR_PINS,
  type RepositoryPolicyDocuments,
  repositoryPolicyRuleIds,
  repositoryPolicyRulePaths,
  WAVE_GRADIENT_PINS,
  WHOLE_CLASS_SWEEP_PINS,
} from '../src/scripts/repository-policy-audit.mts';
import { fixtureEnv } from './test-utils.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUDIT_DOCS_CLI = join(REPOSITORY_ROOT, 'scripts/audit-docs.mjs');
const AUDIT_DOCS_SOURCE = join(REPOSITORY_ROOT, 'src/scripts/audit-docs.mts');
const AUDIT_HELP_PROBE_PATHS = [
  'scripts/audit-pr-cleanup.mjs',
  'scripts/minimize-superseded-markers.mjs',
  'scripts/post-idd-marker.mjs',
  'scripts/resume-claim-routing.mjs',
  'scripts/suitability-close-execute.mjs',
];
const POSITIVE_FIXTURE = new URL(
  './fixtures/repository-policy-audit/positive.json',
  import.meta.url,
);
const CLI_SOURCE = join(REPOSITORY_ROOT, 'scripts/repository-policy-audit.mjs');

interface RuleViolationMutation {
  path: string;
  contents: string;
  diagnosticPath?: string;
}

const PINNED_CLAUSE_GROUPS = [
  ...NEEDS_DECISION_ROUTE_PINS,
  ...REVIEW_TRIAGE_DONOR_PINS,
  ...WHOLE_CLASS_SWEEP_PINS,
  ...WAVE_GRADIENT_PINS,
  ...PR_HEAD_FRESHNESS_PINS,
  ...REGRESSION_DEFINITION_PINS,
];

function readPositiveFixture(): Map<string, string> {
  const parsed = JSON.parse(readFileSync(POSITIVE_FIXTURE, 'utf8')) as unknown;
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
  );
  return new Map(
    Object.entries(parsed).map(([path, contents]) => {
      assert.equal(
        typeof contents,
        'string',
        `${path} must have string contents`,
      );
      return [path, contents];
    }),
  );
}

function materializeDocuments(
  root: string,
  documents: RepositoryPolicyDocuments,
): void {
  for (const [path, contents] of documents) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function copyBareNodeRuntime(
  destination: string,
  schemaContents: string,
): string {
  const copied = new Set<string>();
  const queue = [CLI_SOURCE];

  while (queue.length > 0) {
    const source = queue.pop();
    assert.ok(source);
    const relativePath = relative(REPOSITORY_ROOT, source);
    assert.ok(
      !relativePath.startsWith('..'),
      `${source} must stay inside the repository`,
    );
    const target = join(destination, relativePath);
    if (copied.has(source)) continue;
    copied.add(source);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);

    const sourceText = readFileSync(source, 'utf8');
    const imports = [
      ...sourceText.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...sourceText.matchAll(/^\s*import\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ...sourceText.matchAll(
        /^\s*export\s+(?:type\s+)?(?:\*\s+as\s+\w+|\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm,
      ),
    ];
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.ok(
        specifier.startsWith('.'),
        `unexpected package import ${specifier} in ${source}`,
      );
      const dependency = resolve(dirname(source), specifier);
      assert.ok(
        dependency.endsWith('.mjs'),
        `expected generated .mjs import: ${specifier}`,
      );
      queue.push(dependency);
    }
  }

  const runtimeSchema = join(destination, 'schemas', 'policy.schema.json');
  mkdirSync(dirname(runtimeSchema), { recursive: true });
  writeFileSync(runtimeSchema, schemaContents);
  const entry = join(destination, relative(REPOSITORY_ROOT, CLI_SOURCE));
  assert.equal(existsSync(join(destination, 'node_modules')), false);
  return entry;
}

function copyAuditDocsRuntime(destination: string): string {
  const copied = new Set<string>();
  const queue = [AUDIT_DOCS_CLI, CLI_SOURCE];

  while (queue.length > 0) {
    const source = queue.pop();
    assert.ok(source);
    const relativePath = relative(REPOSITORY_ROOT, source);
    assert.ok(
      !relativePath.startsWith('..'),
      `${source} must stay inside the repository`,
    );
    if (copied.has(source)) continue;
    copied.add(source);
    const target = join(destination, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);

    if (source.endsWith('.mjs')) {
      const generatedSource = /^\/\/ idd-generated-from: (.+)$/m.exec(
        readFileSync(source, 'utf8'),
      )?.[1];
      assert.ok(generatedSource, `${relativePath} must name its source`);
      const sourcePath = join(REPOSITORY_ROOT, generatedSource);
      assert.ok(existsSync(sourcePath), `${generatedSource} must exist`);
      const sourceTarget = join(destination, generatedSource);
      mkdirSync(dirname(sourceTarget), { recursive: true });
      cpSync(sourcePath, sourceTarget);

      const sourceText = readFileSync(source, 'utf8');
      const imports = [
        ...sourceText.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
        ...sourceText.matchAll(
          /^\s*import\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm,
        ),
        ...sourceText.matchAll(
          /^\s*export\s+(?:type\s+)?(?:\*\s+as\s+\w+|\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm,
        ),
      ];
      for (const match of imports) {
        const specifier = match[1];
        if (specifier.startsWith('node:')) continue;
        assert.ok(
          specifier.startsWith('.'),
          `unexpected package import ${specifier} in ${source}`,
        );
        const dependency = resolve(dirname(source), specifier);
        assert.ok(
          dependency.endsWith('.mjs'),
          `expected generated .mjs import: ${specifier}`,
        );
        queue.push(dependency);
      }
    }
  }

  assert.ok(existsSync(AUDIT_DOCS_SOURCE));
  assert.equal(existsSync(join(destination, 'node_modules')), false);
  return join(destination, relative(REPOSITORY_ROOT, AUDIT_DOCS_CLI));
}

function runCli(
  executable: string,
  fixtureRoot: string,
  emptyPath: string,
): { status: number | null; stderr: string; stdout: string } {
  return spawnSync(process.execPath, [executable, '--root', fixtureRoot], {
    cwd: dirname(executable),
    encoding: 'utf8' as const,
    env: { PATH: emptyPath },
  });
}

function runAuditDocs(
  executable: string,
  fixtureRoot: string,
  envOverrides: NodeJS.ProcessEnv = {},
): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync(process.execPath, [executable, '--check'], {
    cwd: fixtureRoot,
    encoding: 'utf8' as const,
    env: { ...fixtureEnv(), ...envOverrides },
  });
  return {
    status: result.status,
    stderr: String(result.stderr ?? ''),
    stdout: String(result.stdout ?? ''),
  };
}

function materializeAuditOverviewPairs(
  fixtureRoot: string,
  documents: RepositoryPolicyDocuments,
): void {
  for (const [configPath, overviewPath] of [
    [
      '.github/idd/config.json',
      '.github/instructions/idd-overview-core.instructions.md',
    ],
    [
      'idd-template/.github/idd/config.json',
      'idd-template/.github/instructions/idd-overview-core.instructions.md',
    ],
  ]) {
    const configText = documents.get(configPath);
    assert.ok(configText, `${configPath} must be covered by the fixture`);
    const config = JSON.parse(configText) as {
      commands?: Record<string, unknown>;
      issueScope?: unknown;
      orphanFirstPolicy?: unknown;
    };
    const rows: [string, unknown][] = [
      ['install-deps', config.commands?.['install-deps']],
      ['fix-validate', config.commands?.['fix-validate']],
      ['pre-push-validate', config.commands?.['pre-push-validate']],
      ['post-fix-validate', config.commands?.['post-fix-validate']],
      ['issue-scope', config.issueScope],
      ['orphan-first-policy', config.orphanFirstPolicy],
    ];
    const overview = `${rows
      .map(([key, value]) => {
        assert.ok(typeof value === 'string', `${key} must be configured`);
        return `| **${key}** | \`${value}\` |`;
      })
      .join('\n')}\n`;
    const target = join(fixtureRoot, overviewPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, overview, 'utf8');
  }
}

function materializeLiteParityAnchors(fixtureRoot: string): void {
  for (const [path, heading, evidence] of [
    [
      'idd-template/.github/instructions/idd-review-snapshot.instructions.md',
      'E1 — Fetch review items into ReviewItems_snapshot',
      'regardless of the last-speaker exclusion',
    ],
    [
      'idd-template/.github/instructions/lite/idd-review-snapshot-lite.instructions.md',
      'Step 3 — Filter into ReviewItems_snapshot',
      'with `**Awaiting maintainer decision**` — exclude periodic',
    ],
  ]) {
    const target = join(fixtureRoot, path);
    const contents = readFileSync(target, 'utf8');
    writeFileSync(
      target,
      `## ${heading}\n\n${evidence}\n\n${contents}`,
      'utf8',
    );
  }
}

function materializeAuditHelperProbes(fixtureRoot: string): void {
  for (const path of AUDIT_HELP_PROBE_PATHS) {
    const source = join(REPOSITORY_ROOT, path);
    const result = spawnSync(process.execPath, [source, '--help'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8' as const,
      env: fixtureEnv(),
    });
    assert.equal(
      result.status,
      0,
      `${path} --help must work for the audit fixture: ${String(result.stderr)}`,
    );
    const target = join(fixtureRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `process.stdout.write(${JSON.stringify(`${result.stdout}${result.stderr}`)});\n`,
      'utf8',
    );
  }
}

function replaceFixtureText(
  documents: RepositoryPolicyDocuments,
  path: string,
  needle: string,
  replacement: string,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  assert.ok(original.includes(needle), `${path} must contain ${needle}`);
  return { path, contents: original.replace(needle, replacement) };
}

function replaceFixturePattern(
  documents: RepositoryPolicyDocuments,
  path: string,
  pattern: RegExp,
  replacement: string,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  assert.match(original, pattern, `${path} must match ${pattern}`);
  return { path, contents: original.replace(pattern, replacement) };
}

function replaceFixtureTextEverywhere(
  documents: RepositoryPolicyDocuments,
  path: string,
  needle: string,
  replacement: string,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  assert.ok(original.includes(needle), `${path} must contain ${needle}`);
  return { path, contents: original.replaceAll(needle, replacement) };
}

function replaceFixturePatternEverywhere(
  documents: RepositoryPolicyDocuments,
  path: string,
  pattern: RegExp,
  replacement: string,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  assert.match(original, pattern, `${path} must match ${pattern}`);
  return { path, contents: original.replace(pattern, replacement) };
}

/**
 * #3860: moves the removal proof's comment out of the pending-only removal
 * branch, to the line after its closing `fi`, where it guards nothing.
 */
function moveRemovalProofOutsidePendingBranch(
  documents: RepositoryPolicyDocuments,
): RuleViolationMutation {
  const path = 'idd-template/docs/idd-advisory-wait-shell-fallback.md';
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  const phrase = '# Removal proof (#3860)';
  const phraseAt = original.indexOf(phrase);
  assert.notEqual(phraseAt, -1, `${path} must carry the removal proof`);
  const renamed =
    original.slice(0, phraseAt) +
    '# Removal check (#3860)' +
    original.slice(phraseAt + phrase.length);
  const pendingBranchStart = renamed.indexOf(
    'if [ "$AW3S_ENTRY" = "pending" ]; then',
  );
  const pendingBranchEnd = renamed.indexOf(
    '\nfi\n\n# Step 3',
    pendingBranchStart,
  );
  assert.notEqual(
    pendingBranchEnd,
    -1,
    `${path} must close the pending-only removal branch`,
  );
  const insertAt = pendingBranchEnd + '\nfi'.length;
  return {
    path,
    contents: `${renamed.slice(0, insertAt)}\n${phrase}${renamed.slice(insertAt)}`,
  };
}

function moveAw3sEntryValidationAfterPendingRemoval(
  documents: RepositoryPolicyDocuments,
): RuleViolationMutation {
  const path = 'idd-template/docs/idd-advisory-wait-shell-fallback.md';
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  const validationStart = original.indexOf('case "$AW3S_ENTRY" in');
  assert.notEqual(validationStart, -1, `${path} must validate AW3S_ENTRY`);
  const validationEndMarker = '\nesac';
  const validationEnd = original.indexOf(validationEndMarker, validationStart);
  assert.notEqual(validationEnd, -1, `${path} must close AW3S_ENTRY case`);
  const validationEndExclusive = validationEnd + validationEndMarker.length;
  const validation = original.slice(validationStart, validationEndExclusive);
  const withoutValidation =
    original.slice(0, validationStart) + original.slice(validationEndExclusive);
  const pendingBranchStart = withoutValidation.indexOf(
    'if [ "$AW3S_ENTRY" = "pending" ]; then',
  );
  assert.notEqual(
    pendingBranchStart,
    -1,
    `${path} must remove the reviewer only for a pending entry`,
  );
  const pendingBranchEnd = withoutValidation.indexOf(
    '\nfi\n\n# Step 3',
    pendingBranchStart,
  );
  assert.notEqual(
    pendingBranchEnd,
    -1,
    `${path} must close the pending-only removal branch`,
  );
  const insertAt = pendingBranchEnd + '\nfi'.length;
  return {
    path,
    contents:
      withoutValidation.slice(0, insertAt) +
      '\n' +
      validation +
      withoutValidation.slice(insertAt),
  };
}

function appendFixtureText(
  documents: RepositoryPolicyDocuments,
  path: string,
  addition: string,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  return { path, contents: `${original}\n${addition}\n` };
}

function updateFixtureJson(
  documents: RepositoryPolicyDocuments,
  path: string,
  update: (value: Record<string, unknown>) => void,
): { path: string; contents: string } {
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  const value = JSON.parse(original) as Record<string, unknown>;
  update(value);
  return { path, contents: `${JSON.stringify(value, null, 2)}\n` };
}

function makeRuleViolation(
  ruleId: string,
  documents: RepositoryPolicyDocuments,
): RuleViolationMutation {
  switch (ruleId) {
    case 'helper-runtime-docs':
      return replaceFixtureText(
        documents,
        'docs/idd-helper-scripts.md',
        'Discover Roadmap Graph Contract',
        'Roadmap Graph Contract',
      );
    case 'marker-candidate-list':
      return replaceFixtureText(
        documents,
        'idd-template/docs/idd-comment-minimization.md',
        '- `<!-- claimed-by:',
        '- `<!-- claimed:',
      );
    case 'operational-comment-prefixes':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-snapshot.instructions.md',
        '- `<!-- review-watermark:',
        '- `<!-- watermark:',
      );
    case 'urgency-matrix-doc':
      return replaceFixtureTextEverywhere(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        'High defers only at `very-low`',
        'High defers at every urgency',
      );
    case 'review-triage-in-place-edit-only-boundary':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        '(`inPlaceEditOnly`/`soleCauseInPlaceEditOnly`, #1313, is a stricter subset — not an override path of its own.)',
        '',
      );
    case 'review-triage-verify-confirm-boundary':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        "A verify-then-confirm reply (analysis before the confirmation verb) isn't recognized, so #2125's override doesn't fire (recognized replies are unaffected).",
        '',
      );
    case 'review-triage-repeating-advisory-hold':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        "A repeating `missingThreads` entry that's a no-new-content advisory-bot reply needs a hold comment; stop instead of re-posting the disposition (#3324).",
        '',
      );
    case 'f2-ack-only-override-condition':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pre-merge.instructions.md',
        'when `dispositionEvidence.soleCauseAckOnlyPostDisposition` is `true` (every blocking item is a `missingThreads` entry with `ackOnlyPostDisposition: true`, `missingRegularComments` empty), autopilot may deterministically override `return-to-e1` and proceed on the current HEAD SHA.',
        '',
      );
    case 'post-marker-outcomes':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-snapshot.instructions.md',
        'operationLocal.decision: refuse',
        'operationLocal.decision: publish',
      );
    case 'advisory-fallback-order':
      return replaceFixtureText(
        documents,
        'idd-template/docs/idd-advisory-wait-shell-fallback.md',
        'requestReviews(input:{pullRequestId:$id,botIds:$reviewer,union:true})',
        'requestReviews(input:{pullRequestId:$id,reviewers:$reviewer,union:true})',
      );
    case 'shadow-path-guidance':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pre-merge.instructions.md',
        'git ls-tree -r -z',
        'git ls-tree -z',
      );
    case 'pr-head-freshness-order':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pre-merge.instructions.md',
        'run `git merge --ff-only "$PR_HEAD_SHA"`',
        'run `git reset --hard "$PR_HEAD_SHA"`',
      );
    case 'a45-outcome-fixtures': {
      const path = 'tests/fixtures/consistency/a45-outcomes.json';
      return {
        ...updateFixtureJson(documents, path, (value) => {
          assert.ok(Array.isArray(value));
          const first = value[0] as Record<string, unknown>;
          first.expectedOutcome = 'not-a-documented-outcome';
        }),
        diagnosticPath: '.github/instructions/idd-suitability.instructions.md',
      };
    }
    case 'roadmap-node-classification':
      return replaceFixturePattern(
        documents,
        '.github/instructions/idd-discover.instructions.md',
        /only open roadmap nodes remain/i,
        'only execution leaves remain',
      );
    case 'codex-critique-invocation':
      return replaceFixtureText(
        documents,
        'docs/idd-workflow.md',
        'Use one bounded read-only native subagent review when supported and suitable',
        'Use one native review',
      );
    case 'path-a-verify-before-accept':
      return replaceFixtureTextEverywhere(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        'assertion alone never reaches Accept forced',
        'an unsupported assertion cannot be accepted',
      );
    case 'trusted-duplicate-marker':
      return replaceFixtureTextEverywhere(
        documents,
        'idd-template/.github/instructions/idd-merge.instructions.md',
        'trusted marker actor',
        'trusted marker author',
      );
    case 'operator-confirmation-merge-gate':
      return replaceFixturePattern(
        documents,
        'docs/idd-autonomy-contract.md',
        /standing\s+operator\s+confirmation before this merge/,
        'operator confirmation before this merge',
      );
    case 'f2-own-comment-carveout':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pre-merge.instructions.md',
        'own-agent-authored procedural or status comment',
        'agent procedural or status comment',
      );
    case 'f2-third-party-advisory-carveout':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pre-merge.instructions.md',
        "third-party advisory bot's own skip-review or no-action notice",
        'third-party advisory bot notice',
      );
    case 'recursive-roadmap-audit':
      return replaceFixturePatternEverywhere(
        documents,
        '.github/instructions/idd-roadmap-audit.instructions.md',
        /nested roadmaps?/gi,
        'roadmap hierarchy',
      );
    case 'package-config-version-alignment':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          value.iddVersion = '0.0.0';
        },
      );
    case 'advisory-waiver-dogfood-opt-in':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          const ciGate = value.ciGate as Record<string, unknown>;
          const waivers = ciGate.externalCheckWaivers as Record<
            string,
            unknown
          >;
          waivers.mode = 'disabled';
        },
      );
    case 'merge-policy-dogfood-opt-in':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          value.mergePolicy = 'human_merge';
        },
      );
    case 'critique-telemetry-dogfood-hook':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          const critiqueLoop = value.critiqueLoop as Record<string, unknown>;
          const telemetryHook = critiqueLoop.telemetryHook as Record<
            string,
            unknown
          >;
          telemetryHook.command = 'disabled';
        },
      );
    case 'github-api-load-control-dogfood':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          const githubApi = value.githubApi as Record<string, unknown>;
          const loadControl = githubApi.loadControl as Record<string, unknown>;
          loadControl.maxConcurrent = 3;
        },
      );
    case 'orchestrator-worker-cap-dogfood':
      return updateFixtureJson(
        documents,
        '.github/idd/config.json',
        (value) => {
          value.orchestrator = { maxWorkers: 2 };
        },
      );
    case 'f4-dirty-worktree-hold':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-merge.instructions.md',
        '`primary-worktree-dirty`',
        '`dirty-primary-worktree`',
      );
    case 'f4-worktree-error-routing':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-merge.instructions.md',
        '`development-branch-in-use`',
        '`development-branch-unknown`',
      );
    case 'b1-main-boundary':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-work.instructions.md',
        "The primary worktree's HEAD MUST remain on `main` throughout B1; if it",
        "The primary worktree's HEAD MUST remain on `main` throughout B1; if it. The main branch is trusted without checks",
      );
    case 'pr-submit-main-boundary':
      return appendFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pr-submit.instructions.md',
        'The main branch is trusted without checks.',
      );
    case 'review-triage-main-boundary':
      return appendFixtureText(
        documents,
        'idd-template/.github/instructions/idd-review-triage.instructions.md',
        'The main branch is trusted without checks.',
      );
    case 'merge-main-boundary':
      return appendFixtureText(
        documents,
        'idd-template/.github/instructions/idd-merge.instructions.md',
        'The main branch is trusted without checks.',
      );
    case 'fetch-refspecs':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-work.instructions.md',
        'git fetch origin\n   git log origin/main..main',
        'git fetch origin main\n   git log origin/main..main',
      );
    case 'd4-pending-recovery-actions':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pr-submit.instructions.md',
        'only `REQUEST_NEEDED`',
        'only `WAIT`',
      );
    case 'ci-exception-d4-delegation':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-ci.instructions.md',
        "D4's `pending: true` recovery check",
        "D3's `pending: true` recovery check",
      );
    case 'd3-impact-checklist-derivation':
      return replaceFixtureTextEverywhere(
        documents,
        'idd-template/.github/instructions/idd-pr-submit.instructions.md',
        'Instruction files changed',
        'Source instruction files changed',
      );
    case 'd3-final-head-impact-recheck':
      return replaceFixtureText(
        documents,
        'idd-template/.github/instructions/idd-pr-submit.instructions.md',
        "re-derive D3.6's checklist",
        "reuse D3.6's checklist",
      );
    default: {
      // The pinned-clause rules are generated from four tables; deleting the
      // first pinned phrase from the first path is their targeted fixture
      // (the per-phrase test below deletes every phrase from the real files).
      // The whole-class sweep pins a wrapped bullet, so the phrase is deleted
      // whitespace-tolerantly.
      const group = PINNED_CLAUSE_GROUPS.find(
        (candidate) => candidate.id === ruleId,
      );
      if (group !== undefined) {
        const path = group.paths[0];
        const original = documents.get(path);
        assert.ok(original, `${path} must be covered by the positive fixture`);
        const mutated = deletePhrase(original, group.phrases[0]);
        assert.notEqual(mutated, null, `${path} must hold the pinned phrase`);
        return { path, contents: mutated as string };
      }
      assert.fail(`no targeted negative fixture for ${ruleId}`);
    }
  }
}

function gitIndexTree(root: string): string {
  return execFileSync('git', ['write-tree'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function snapshotFixtureFiles(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        snapshot.set(relative(root, path), readFileSync(path));
    }
  };
  visit(root);
  return snapshot;
}

function runCliAndAssertReadOnly(
  executable: string,
  fixtureRoot: string,
  emptyPath: string,
  initialIndexTree: string,
): { status: number | null; stderr: string; stdout: string } {
  const fixtureBefore = snapshotFixtureFiles(fixtureRoot);
  const indexPath = join(fixtureRoot, '.git', 'index');
  const indexBefore = readFileSync(indexPath);
  const result = runCli(executable, fixtureRoot, emptyPath);
  assert.deepEqual(
    snapshotFixtureFiles(fixtureRoot),
    fixtureBefore,
    'CLI must leave all fixture files unchanged',
  );
  assert.deepEqual(
    readFileSync(indexPath),
    indexBefore,
    'CLI must leave raw Git index bytes unchanged',
  );
  assert.equal(gitIndexTree(fixtureRoot), initialIndexTree);
  return result;
}

test('repository policy rules accept an independent positive document snapshot', () => {
  const documents = readPositiveFixture();
  assert.deepEqual(
    collectRepositoryPolicyViolationsFromDocuments(documents),
    [],
  );
});

test('load-control dogfood check ignores JSON property order', () => {
  const documents = readPositiveFixture();
  const path = '.github/idd/config.json';
  const configContents = documents.get(path);
  assert.ok(configContents);
  const config = JSON.parse(configContents) as {
    githubApi: { loadControl: { enabled: boolean; maxConcurrent: number } };
  };
  config.githubApi.loadControl = {
    maxConcurrent: config.githubApi.loadControl.maxConcurrent,
    enabled: config.githubApi.loadControl.enabled,
  };
  documents.set(path, JSON.stringify(config, null, 2));

  assert.deepEqual(
    collectRepositoryPolicyViolationsFromDocuments(documents),
    [],
  );
});

test('orchestrator dogfood rejects a local entry in the distributed template', () => {
  const documents = readPositiveFixture();
  const templatePath = 'idd-template/.github/idd/config.json';
  const templateContents = documents.get(templatePath);
  assert.ok(templateContents);
  const template = JSON.parse(templateContents) as Record<string, unknown>;
  template.orchestrator = { maxWorkers: 4 };
  documents.set(templatePath, JSON.stringify(template, null, 2));

  assert.ok(
    collectRepositoryPolicyViolationsFromDocuments(documents).some(
      (violation) =>
        violation.ruleId === 'orchestrator-worker-cap-dogfood' &&
        violation.path === templatePath,
    ),
  );
});

test('bare-Node CLI rejects one negative fixture for every stable rule ID', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-repository-policy-audit-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const fixtureRoot = join(tempRoot, 'fixture');
  const runtimeRoot = join(tempRoot, 'runtime');
  const emptyPath = join(tempRoot, 'empty-bin');
  mkdirSync(emptyPath);
  const documents = readPositiveFixture();
  materializeDocuments(fixtureRoot, documents);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: fixtureRoot,
  });
  execFileSync('git', ['add', '-A'], { cwd: fixtureRoot });
  const initialIndexTree = gitIndexTree(fixtureRoot);
  const schemaContents = documents.get('schemas/policy.schema.json');
  assert.ok(schemaContents);
  const executable = copyBareNodeRuntime(runtimeRoot, schemaContents);
  const initialContents = new Map(documents);

  const positive = runCliAndAssertReadOnly(
    executable,
    fixtureRoot,
    emptyPath,
    initialIndexTree,
  );
  assert.equal(positive.status, 0, String(positive.stderr));
  assert.match(String(positive.stdout), /repository policy audit passed/);
  assert.equal(existsSync(join(runtimeRoot, 'node_modules')), false);
  assert.equal(existsSync(join(fixtureRoot, '.git')), true);

  for (const ruleId of repositoryPolicyRuleIds) {
    assert.ok(repositoryPolicyRulePaths[ruleId]?.length, `${ruleId} has paths`);
    const mutation = makeRuleViolation(ruleId, initialContents);
    const expectedDiagnosticPath = mutation.diagnosticPath ?? mutation.path;
    const original = initialContents.get(mutation.path);
    assert.ok(
      original,
      `${ruleId} input must be covered by the positive fixture`,
    );
    assert.notEqual(mutation.contents, original, `${ruleId} must mutate input`);
    const mutatedSnapshot = new Map(initialContents);
    mutatedSnapshot.set(mutation.path, mutation.contents);
    assert.ok(
      collectRepositoryPolicyViolationsFromDocuments(mutatedSnapshot).some(
        (violation) =>
          violation.ruleId === ruleId &&
          violation.path === expectedDiagnosticPath,
      ),
      `${ruleId} targeted mutation must violate its substantive rule`,
    );
    const target = join(fixtureRoot, mutation.path);
    writeFileSync(target, mutation.contents);

    const result = runCliAndAssertReadOnly(
      executable,
      fixtureRoot,
      emptyPath,
      initialIndexTree,
    );
    assert.equal(result.status, 1, `${ruleId}: ${String(result.stderr)}`);
    assert.ok(
      String(result.stderr).includes(`${ruleId}: ${expectedDiagnosticPath}:`),
      `${ruleId} did not report its relative path:\n${String(result.stderr)}`,
    );
    writeFileSync(target, original);
  }

  const orderMutation =
    moveAw3sEntryValidationAfterPendingRemoval(initialContents);
  const orderOriginal = initialContents.get(orderMutation.path);
  assert.ok(orderOriginal, `${orderMutation.path} must be in the fixture`);
  const orderSnapshot = new Map(initialContents);
  orderSnapshot.set(orderMutation.path, orderMutation.contents);
  const expectedDiagnosticPath =
    orderMutation.diagnosticPath ?? orderMutation.path;
  assert.ok(
    collectRepositoryPolicyViolationsFromDocuments(orderSnapshot).some(
      (violation) =>
        violation.ruleId === 'advisory-fallback-order' &&
        violation.path === expectedDiagnosticPath,
    ),
    'advisory-fallback-order must reject pending removal before AW3S_ENTRY validation',
  );
  writeFileSync(join(fixtureRoot, orderMutation.path), orderMutation.contents);
  const orderResult = runCliAndAssertReadOnly(
    executable,
    fixtureRoot,
    emptyPath,
    initialIndexTree,
  );
  assert.equal(
    orderResult.status,
    1,
    `advisory-fallback-order: ${String(orderResult.stderr)}`,
  );
  assert.ok(
    String(orderResult.stderr).includes(
      `advisory-fallback-order: ${expectedDiagnosticPath}:`,
    ),
    `advisory-fallback-order did not report its relative path:\n${String(orderResult.stderr)}`,
  );
  writeFileSync(join(fixtureRoot, orderMutation.path), orderOriginal);

  const proofMutation = moveRemovalProofOutsidePendingBranch(initialContents);
  const proofSnapshot = new Map(initialContents);
  proofSnapshot.set(proofMutation.path, proofMutation.contents);
  assert.ok(
    collectRepositoryPolicyViolationsFromDocuments(proofSnapshot).some(
      (violation) =>
        violation.ruleId === 'advisory-fallback-order' &&
        violation.path === proofMutation.path,
    ),
    'advisory-fallback-order must reject a removal proof outside the pending branch',
  );

  for (const [path, contents] of initialContents) {
    assert.equal(
      readFileSync(join(fixtureRoot, path), 'utf8'),
      contents,
      `${path} changed during audit`,
    );
  }
  assert.deepEqual(readdirSync(emptyPath), []);
});

const PRE_MERGE =
  'idd-template/.github/instructions/idd-pre-merge.instructions.md';
const MERGE = 'idd-template/.github/instructions/idd-merge.instructions.md';

function freshnessViolations(
  documents: RepositoryPolicyDocuments,
  ruleId: string,
) {
  return collectRepositoryPolicyViolationsFromDocuments(documents).filter(
    (violation) => violation.ruleId === ruleId,
  );
}

function withFixtureText(
  path: string,
  change: (text: string) => string,
): RepositoryPolicyDocuments {
  const documents = readPositiveFixture();
  const original = documents.get(path);
  assert.ok(original, `${path} must be covered by the positive fixture`);
  const changed = change(original);
  assert.notEqual(changed, original, `the change must alter ${path}`);
  return new Map(documents).set(path, changed);
}

test('the F2 local check passes on the positive fixture and rejects ancestry-only checking', () => {
  assert.deepEqual(
    freshnessViolations(readPositiveFixture(), 'pr-head-freshness-f2'),
    [],
  );
  const ancestryOnly = withFixtureText(PRE_MERGE, (text) =>
    text.replace(
      '`git rev-parse HEAD` must equal `$PR_HEAD_SHA`',
      '`git merge-base --is-ancestor HEAD "$PR_HEAD_SHA"` must hold',
    ),
  );
  const violations = freshnessViolations(ancestryOnly, 'pr-head-freshness-f2');
  assert.equal(violations.length, 1);
  assert.match(
    violations[0].message,
    /`git rev-parse HEAD` must equal `\$PR_HEAD_SHA`/,
  );
});

test('the F2 local check keeps the shadow-path check before the fast-forward and never resets', () => {
  assert.deepEqual(
    freshnessViolations(readPositiveFixture(), 'pr-head-freshness-order'),
    [],
  );
  const moved = withFixtureText(PRE_MERGE, (text) => {
    const ffOnly =
      'run `git merge --ff-only "$PR_HEAD_SHA"` and require equality again, else hold.';
    const withoutFfOnly = text.replace(ffOnly, '');
    return withoutFfOnly.replace(
      'Under `set -o pipefail`, run',
      `${ffOnly} Under \`set -o pipefail\`, run`,
    );
  });
  assert.match(
    freshnessViolations(moved, 'pr-head-freshness-order')[0]?.message ?? '',
    /out of order or missing/,
  );
  for (const reset of [
    'git reset --hard "$PR_HEAD_SHA"',
    'then run `git reset` to discard local work',
    'git reset --keep "$PR_HEAD_SHA"',
    'then reset on pass)',
  ]) {
    const violations = freshnessViolations(
      withFixtureText(PRE_MERGE, (text) => `${text}\n${reset}`),
      'pr-head-freshness-order',
    );
    assert.match(violations[0]?.message ?? '', /never reset the worktree/);
  }
});

test('F3 points at the F2 sequence and does not restate an ancestry check', () => {
  assert.deepEqual(
    freshnessViolations(readPositiveFixture(), 'pr-head-freshness-order'),
    [],
  );
  const restated = withFixtureText(
    MERGE,
    (text) =>
      `${text}\nRequire \`git merge-base --is-ancestor HEAD "\${PR_HEAD_SHA_F3}"\`.`,
  );
  assert.match(
    freshnessViolations(restated, 'pr-head-freshness-order')[0]?.message ?? '',
    /not restate an ancestry check/,
  );
  const resetting = withFixtureText(
    MERGE,
    (text) => `${text}\nThen run \`git reset\` to discard local work.`,
  );
  assert.match(
    freshnessViolations(resetting, 'pr-head-freshness-order')[0]?.message ?? '',
    /never reset the worktree/,
  );
  const withoutPointer = withFixtureText(MERGE, (text) =>
    text.replace("apply F2's sequence to", 'check'),
  );
  assert.equal(
    freshnessViolations(withoutPointer, 'pr-head-freshness-f3').length,
    1,
  );
});

/** Delete the first whitespace-tolerant occurrence of `phrase` from `text`. */
function deletePhrase(text: string, phrase: string): string | null {
  const pattern = new RegExp(
    phrase
      .split(' ')
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
  );
  return pattern.test(text) ? text.replace(pattern, '') : null;
}

test('every pinned needs-decision route, triage donor, whole-class sweep and wave-gradient phrase is load-bearing in the real files', () => {
  for (const group of PINNED_CLAUSE_GROUPS) {
    assert.ok(group.phrases.length > 0, `${group.id} pins phrases`);
    assert.equal(
      new Set(group.phrases).size,
      group.phrases.length,
      `${group.id} has a duplicate pinned phrase`,
    );
    const real = new Map<string, string>();
    for (const path of group.paths) {
      real.set(path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
    }
    const failing = (documents: Map<string, string>) =>
      collectRepositoryPolicyViolationsFromDocuments(documents).filter(
        (violation) => violation.ruleId === group.id,
      );
    assert.deepEqual(failing(real), [], `${group.id} must pass on real files`);
    for (const path of group.paths) {
      const original = real.get(path) as string;
      for (const phrase of group.phrases) {
        const mutated = deletePhrase(original, phrase);
        assert.notEqual(
          mutated,
          null,
          `${path} must contain the pinned phrase: ${phrase}`,
        );
        const scratch = new Map(real);
        scratch.set(path, mutated as string);
        // The rule reports every missing clause, so overlapping phrases
        // cannot shadow each other: the deleted phrase itself is named.
        assert.ok(
          failing(scratch).some(
            (violation) =>
              violation.path === path && violation.message.includes(phrase),
          ),
          `${group.id}: deleting ${JSON.stringify(phrase)} from ${path} must fail the audit and name that clause`,
        );
      }
    }
  }
});

test('replacing the converged equality pin with ready fails the wave-gradient audit (#3797)', () => {
  const needle = '`converged` equal to `true`';
  const replacement = '`ready` equal to `true`';
  const paths = [
    'idd-template/docs/idd-review-policy-profiles.md',
    'docs/idd-review-policy-profiles.md',
  ];
  const real = new Map<string, string>();
  for (const path of paths) {
    real.set(path, readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
  }
  const failing = (documents: Map<string, string>) =>
    collectRepositoryPolicyViolationsFromDocuments(documents).filter(
      (violation) => violation.ruleId === 'wave-gradient-policy-doc',
    );
  assert.deepEqual(failing(real), []);
  for (const path of paths) {
    const original = real.get(path) as string;
    assert.equal(original.split(needle).length - 1, 1, path);
    const scratch = new Map(real);
    scratch.set(path, original.replace(needle, replacement));
    assert.ok(
      failing(scratch).some(
        (violation) =>
          violation.path === path && violation.message.includes(needle),
      ),
      `${path} must fail once converged is replaced with ready`,
    );
  }
});

test('the whole-class sweep pins are scoped to the E9 bullet and reject the old sentence', () => {
  const reviewFixPaths = [
    'idd-template/.github/instructions/idd-review-fix.instructions.md',
    '.github/instructions/idd-review-fix.instructions.md',
  ];
  // A plain literal: the type-suppression ratchet scanner reads the text of
  // an interpolated template literal as code, and this bullet has a word it
  // counts.
  const nextBullet = '- **Verify any claim a fix adds.**';
  const ruleFailures = (documents: Map<string, string>, ruleId: string) =>
    collectRepositoryPolicyViolationsFromDocuments(documents).filter(
      (violation) => violation.ruleId === ruleId,
    );
  const group = (ruleId: string) => {
    const found = WHOLE_CLASS_SWEEP_PINS.find((entry) => entry.id === ruleId);
    assert.ok(found, `${ruleId} is a whole-class sweep rule`);
    return found;
  };
  for (const path of reviewFixPaths) {
    const real = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
    // Both copies are read by every rule, so only `path` is edited.
    const withEdit = (edited: string) =>
      new Map(reviewFixPaths.map((p) => [p, p === path ? edited : real]));
    const documents = withEdit(real);
    for (const entry of WHOLE_CLASS_SWEEP_PINS) {
      assert.deepEqual(ruleFailures(documents, entry.id), [], entry.id);
    }

    // A pinned clause repeated outside the bullet must not satisfy the pin.
    const fileSet = group('review-fix-sweep-file-set').phrases[0];
    const stripped = deletePhrase(real, fileSet);
    assert.notEqual(stripped, null);
    // Right after the bullet, past a blank line, so a region that ignored the
    // blank line would still reach it.
    const relocated = (stripped as string).replace(
      nextBullet,
      `\nStray paragraph: ${fileSet}\n\n${nextBullet}`,
    );
    assert.notEqual(relocated, stripped);
    assert.ok(
      ruleFailures(withEdit(relocated), 'review-fix-sweep-file-set').length > 0,
      `${path}: a clause outside the E9 bullet must not satisfy the file-set pin`,
    );

    // The next bullet follows the sweep bullet with no blank line, so the
    // region must also end at a top-level bullet.
    const tight = (stripped as string).replace(
      nextBullet,
      `${nextBullet} ${fileSet}`,
    );
    assert.notEqual(tight, stripped);
    assert.ok(
      ruleFailures(withEdit(tight), 'review-fix-sweep-file-set').length > 0,
      `${path}: a clause in the next bullet must not satisfy the file-set pin`,
    );

    // The old sentence must not come back, in either copy.
    const oldSentence = 'Sweep the current diff (and adjacent sections)';
    const reinserted = real.replace(
      nextBullet,
      `${oldSentence} and fix every instance of a systemic finding in one commit.\n\n${nextBullet}`,
    );
    assert.notEqual(reinserted, real);
    const old = ruleFailures(withEdit(reinserted), 'review-fix-sweep-trigger');
    assert.ok(
      old.some(
        (violation) =>
          violation.path === path &&
          violation.message.includes('forbidden clause present'),
      ),
      `${path}: the old sentence must fail the trigger rule`,
    );

    // The complete bullet moved out of E9 into the next section must fail
    // too: the pins enforce the section, not only the text shape.
    const bulletFrom = real.indexOf(
      '- **Fix the whole class, not just the flagged line.**',
    );
    const bulletTo = real.indexOf(nextBullet);
    assert.ok(bulletFrom > 0 && bulletTo > bulletFrom);
    const movedBullet = real.slice(bulletFrom, bulletTo);
    const e10Heading = '## E10 — Validate fixes with critique pass\n';
    const moved = (real.slice(0, bulletFrom) + real.slice(bulletTo)).replace(
      e10Heading,
      `${e10Heading}\n${movedBullet}\n`,
    );
    assert.ok(moved.includes(movedBullet));
    for (const entry of WHOLE_CLASS_SWEEP_PINS) {
      assert.ok(
        ruleFailures(withEdit(moved), entry.id).length > 0,
        `${path}: ${entry.id} must fail when the bullet sits outside E9`,
      );
    }

    // A missing bullet fails all four rules instead of passing vacuously.
    const withoutBullet = real.replace(
      '- **Fix the whole class, not just the flagged line.**',
      '- **Fix the class.**',
    );
    for (const entry of WHOLE_CLASS_SWEEP_PINS) {
      assert.ok(
        ruleFailures(withEdit(withoutBullet), entry.id).length > 0,
        `${path}: ${entry.id} must fail when the bullet is missing`,
      );
    }
  }
});

test('the needs-decision replay table keeps at least nineteen fully filled, numbered cases in both doc copies', () => {
  for (const path of [
    'idd-template/docs/idd-review-policy-profiles.md',
    'docs/idd-review-policy-profiles.md',
  ]) {
    const text = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
    const start = text.indexOf('**Replay table.**');
    assert.notEqual(start, -1, `${path} must carry the replay table`);
    const rows = text
      .slice(start)
      .split('\n')
      .slice(1)
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const cases = rows.filter((cells) => /^\d+$/.test(cells[0]));
    assert.ok(
      cases.length >= 19,
      `${path} replay table has ${cases.length} cases`,
    );
    assert.deepEqual(
      cases.map((cells) => Number(cells[0])),
      cases.map((_, index) => index + 1),
      `${path} replay table numbering`,
    );
    for (const cells of cases) {
      assert.equal(cells.length, 4, `${path} case ${cells[0]} columns`);
      for (const cell of cells) {
        assert.notEqual(cell, '', `${path} case ${cells[0]} has an empty cell`);
      }
    }
  }
});

test('audit-docs reports policy violations when the audit source is present', (t) => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-repository-policy-audit-docs-'),
  );
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const fixtureRoot = join(tempRoot, 'fixture');
  const documents = readPositiveFixture();
  const fixturePackage = JSON.parse(documents.get('package.json') ?? '{}') as {
    name?: string;
  };
  fixturePackage.name = 'repository-policy-audit-fixture';
  documents.set('package.json', JSON.stringify(fixturePackage));
  materializeDocuments(fixtureRoot, documents);
  materializeLiteParityAnchors(fixtureRoot);
  materializeAuditOverviewPairs(fixtureRoot, documents);
  mkdirSync(join(fixtureRoot, 'audit'), { recursive: true });
  const sourceManifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'audit/sync-manifest.json'), 'utf8'),
  ) as { liteGateParity?: unknown[] };
  const liteParityEntry = sourceManifest.liteGateParity?.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      (entry as { id?: unknown }).id === 'awaiting-decision-regular-comment',
  );
  assert.ok(liteParityEntry, 'the fixture must use a live lite parity row');
  writeFileSync(
    join(fixtureRoot, 'audit/sync-manifest.json'),
    JSON.stringify({ fileSets: [], liteGateParity: [liteParityEntry] }),
    'utf8',
  );
  const auditDocs = copyAuditDocsRuntime(fixtureRoot);
  materializeAuditHelperProbes(fixtureRoot);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: fixtureRoot,
    env: fixtureEnv(),
  });
  execFileSync('git', ['add', '-A'], { cwd: fixtureRoot, env: fixtureEnv() });

  const positive = runAuditDocs(auditDocs, fixtureRoot);
  assert.equal(positive.status, 0, positive.stderr || positive.stdout);

  const manifestPath = join(fixtureRoot, 'audit/sync-manifest.json');
  const validManifest = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, '{', 'utf8');
  const rejectedManifest = runAuditDocs(auditDocs, fixtureRoot, {
    NODE_OPTIONS: '--unhandled-rejections=warn',
  });
  assert.equal(rejectedManifest.status, 1, rejectedManifest.stderr);
  assert.match(rejectedManifest.stderr, /SyntaxError/);
  writeFileSync(manifestPath, validManifest, 'utf8');

  const mutation = makeRuleViolation('helper-runtime-docs', documents);
  writeFileSync(join(fixtureRoot, mutation.path), mutation.contents, 'utf8');
  const negative = runAuditDocs(auditDocs, fixtureRoot);
  assert.equal(negative.status, 1, negative.stderr || negative.stdout);
  assert.match(
    negative.stderr,
    /helper-runtime-docs: docs\/idd-helper-scripts\.md:/,
  );

  const originalContents = documents.get(mutation.path);
  assert.ok(originalContents, `${mutation.path} must be in the fixture`);
  writeFileSync(join(fixtureRoot, mutation.path), originalContents);
  execFileSync(
    'git',
    ['rm', '--quiet', '--force', 'scripts/repository-policy-audit.mjs'],
    { cwd: fixtureRoot, env: fixtureEnv() },
  );
  const missingArtifact = runAuditDocs(auditDocs, fixtureRoot);
  assert.equal(missingArtifact.status, 1, missingArtifact.stdout);
  assert.match(
    missingArtifact.stderr,
    /src\/scripts\/repository-policy-audit\.mts: missing generated artifact scripts\/repository-policy-audit\.mjs/,
  );
  assert.doesNotMatch(missingArtifact.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('incomplete document snapshots fail closed with the missing rule path', () => {
  const documents = readPositiveFixture();
  const missingPath = repositoryPolicyRulePaths['helper-runtime-docs']?.[0];
  assert.ok(missingPath);
  documents.delete(missingPath);

  const violations = collectRepositoryPolicyViolationsFromDocuments(documents);
  assert.ok(
    violations.some(
      (violation) =>
        violation.ruleId === 'helper-runtime-docs' &&
        violation.path === missingPath &&
        violation.message.includes('missing'),
    ),
  );
});
