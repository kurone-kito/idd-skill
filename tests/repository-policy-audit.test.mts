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

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
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

  for (const [path, contents] of initialContents) {
    assert.equal(
      readFileSync(join(fixtureRoot, path), 'utf8'),
      contents,
      `${path} changed during audit`,
    );
  }
  assert.deepEqual(readdirSync(emptyPath), []);
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
