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
  type RepositoryPolicyDocuments,
  repositoryPolicyRuleIds,
  repositoryPolicyRulePaths,
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
    default:
      assert.fail(`no targeted negative fixture for ${ruleId}`);
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

  for (const [path, contents] of initialContents) {
    assert.equal(
      readFileSync(join(fixtureRoot, path), 'utf8'),
      contents,
      `${path} changed during audit`,
    );
  }
  assert.deepEqual(readdirSync(emptyPath), []);
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
