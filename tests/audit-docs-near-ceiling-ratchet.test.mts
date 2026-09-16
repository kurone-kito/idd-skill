import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv } from './test-utils.mts';

// computeBaseInstructionSizeBudgetStats (and the near-ceiling-ratchet check
// pipeline generally) in src/scripts/audit-docs.mts is not exported -- the
// module runs as a top-level side-effecting CLI script -- so this drives
// the built scripts/audit-docs.mjs CLI as a subprocess against a minimal
// two-commit git fixture instead, the same pattern used by
// tests/audit-docs-file-sets.test.mts and tests/sync-docs.test.mts. Pure
// helper coverage for the ratchet math itself lives in
// tests/consistency-helpers.test.mts (collectInstructionSizeBudgetRatchetViolations);
// this file covers the surrounding git plumbing those pure-helper tests
// cannot reach: resolving a real base ref, reading a real base-ref
// manifest, and the crash-safety of that read (#3028 PR #3042 review,
// Codex and Copilot).

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMIT_ENV = {
  ...fixtureEnv(),
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runAuditDocs(cwd: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'audit-docs.mjs'), '--check'],
      {
        cwd,
        env: fixtureEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

const CONTEXT_CEILING = {
  id: 'fixture-ceiling',
  maxBundleLimitBytes: 1_000_000,
  maxUtilizationPct: 100,
  noticeUtilizationPct: 95,
};

/**
 * A fixture git repo with two "revisions" of `audit/sync-manifest.json`: a
 * committed base revision (`manifestAtBase`, becomes both `HEAD` and a
 * `refs/remotes/origin/main` ref so `resolveNearCeilingBaseRef` in
 * audit-docs.mts resolves it as the comparison base) and an uncommitted
 * working-tree revision (`manifestAtCurrent`, what `--check` measures as
 * "current" -- the audit reads the manifest from disk, not from git).
 *
 * `baseOnlyFiles` (path -> content, repo-root-relative) are written and
 * committed alongside the base manifest, then left untouched afterward --
 * since `--check` measures "current" straight off disk and these files are
 * never rewritten, their base-ref and current-tree byte counts are
 * identical by construction. This is how a governed instruction file's
 * "already near-ceiling at the base ref, unchanged since" state is
 * represented here.
 */
function makeFixture(
  manifestAtBase: unknown,
  manifestAtCurrent: unknown,
  baseOnlyFiles: Record<string, string> = {},
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-near-ceiling-ratchet-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const manifestPath = join(dir, 'audit', 'sync-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifestAtBase, null, 2), 'utf8');
  for (const [path, content] of Object.entries(baseOnlyFiles)) {
    writeFileSync(join(dir, path), content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, env: COMMIT_ENV });
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], {
    cwd: dir,
    env: COMMIT_ENV,
  });
  // A real `origin/main` ref, not an actual remote -- resolveNearCeilingBaseRef
  // only ever needs `git rev-parse --verify origin/main^{commit}` and
  // `git show origin/main:<path>` to succeed, both of which work against a
  // local remote-tracking ref with no configured remote at all.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
    cwd: dir,
    env: fixtureEnv(),
  });
  writeFileSync(
    manifestPath,
    JSON.stringify(manifestAtCurrent, null, 2),
    'utf8',
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('near-ceiling-ratchet: a base-ref instructionSizeBudgets still in the legacy pre-#1667 single-object shape is skipped, not a crash', (t) => {
  // Before #3028 PR #3042's review fix, computeBaseInstructionSizeBudgetStats
  // passed this object straight into a `for...of` with no Array.isArray
  // guard, throwing an uncaught TypeError and crashing the whole audit run
  // instead of the graceful per-entry skip its own doc comment promises.
  const { dir, cleanup } = makeFixture(
    {
      contextCeiling: CONTEXT_CEILING,
      instructionSizeBudgets: {
        id: 'legacy-shape',
        glob: 'nonexistent/*.md',
        phaseLimitBytes: 1000,
      },
    },
    {
      contextCeiling: CONTEXT_CEILING,
      instructionSizeBudgets: [
        {
          id: 'legacy-shape',
          glob: 'nonexistent/*.md',
          phaseLimitBytes: 1000,
          alwaysLoadedLimitBytes: 1000,
        },
      ],
    },
  );
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.doesNotMatch(
    result.stderr,
    /TypeError|is not iterable|is not a function/,
    `expected a controlled audit result, not an uncaught crash:\n${result.stderr}`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('near-ceiling-ratchet: raising phaseLimitBytes while a governed file is near-ceiling at a real base ref fails, naming the file', (t) => {
  const nearCeilingFile = 'idd-fixture.instructions.md';
  const { dir, cleanup } = makeFixture(
    {
      contextCeiling: CONTEXT_CEILING,
      instructionSizeBudgets: [
        {
          id: 'fixture-budget',
          glob: '*.instructions.md',
          phaseLimitBytes: 1000,
          alwaysLoadedLimitBytes: 1000,
        },
      ],
    },
    {
      contextCeiling: CONTEXT_CEILING,
      instructionSizeBudgets: [
        {
          id: 'fixture-budget',
          glob: '*.instructions.md',
          // Raised past the base ref's 1000-byte limit while the governed
          // file below was already at 96% utilization there.
          phaseLimitBytes: 2000,
          alwaysLoadedLimitBytes: 1000,
        },
      ],
    },
    { [nearCeilingFile]: 'x'.repeat(960) },
  );
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /near-ceiling-ratchet: fixture-budget phaseLimitBytes raised from 1000 to 2000/,
  );
  assert.match(result.stderr, new RegExp(nearCeilingFile.replace('.', '\\.')));
});
