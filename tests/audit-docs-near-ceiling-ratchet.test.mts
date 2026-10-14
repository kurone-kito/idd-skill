import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
// Codex and Copilot). It also covers the
// `contextCeiling.nearCeilingRaiseApprovals` wiring from
// `checkNearCeilingRatchet` into `parseNearCeilingRaiseApprovals`, which the
// pure-helper tests call directly and so cannot notice if that call site
// regresses (#3972, the round-5 Copilot finding deferred from PR #3971
// for issue #3840).

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
    mkdirSync(dirname(join(dir, path)), { recursive: true });
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

const BUNDLE_ID = 'fixture-bundle';
const BUNDLE_MEMBER = 'docs/fixture-bundle-member.md';

/** The fixture manifest: one `bundleBudgets` bundle with the given limit,
 * plus an optional `nearCeilingRaiseApprovals` list under `contextCeiling`. */
function bundleManifest(limitBytes: number, approvals?: unknown[]) {
  return {
    contextCeiling: {
      ...CONTEXT_CEILING,
      ...(approvals === undefined
        ? {}
        : { nearCeilingRaiseApprovals: approvals }),
    },
    bundleBudgets: [{ id: BUNDLE_ID, files: [BUNDLE_MEMBER], limitBytes }],
  };
}

/** A maintainer approval for raising the fixture bundle to 1200 bytes. */
const RAISE_TO_1200_APPROVAL = {
  bundle: BUNDLE_ID,
  limitBytes: 1200,
  issue: 3972,
  reason: 'Fixture approval for the near-ceiling raise wiring test.',
};

/** The bundle's member file is 960 bytes against a 1000-byte limit at the
 * base ref (96%, past the 95% notice threshold), and the working-tree
 * manifest raises the limit to `currentLimitBytes`. */
function makeBundleRaiseFixture(
  currentLimitBytes: number,
  approvals?: unknown[],
) {
  return makeFixture(
    bundleManifest(1000),
    bundleManifest(currentLimitBytes, approvals),
    { [BUNDLE_MEMBER]: 'x'.repeat(960) },
  );
}

test('near-ceiling-ratchet: a near-ceiling bundle raise within its approved limit passes audit-docs --check', (t) => {
  const { dir, cleanup } = makeBundleRaiseFixture(1200, [
    RAISE_TO_1200_APPROVAL,
  ]);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /documentation audit passed/);
  // Notices print on stdout, so this also proves the ratchet ran against a
  // resolved base ref instead of being skipped with a "could not ..." notice.
  assert.doesNotMatch(output, /near-ceiling-ratchet/);
});

test('near-ceiling-ratchet: a near-ceiling bundle raise above its approved limit fails audit-docs --check', (t) => {
  const { dir, cleanup } = makeBundleRaiseFixture(1500, [
    RAISE_TO_1200_APPROVAL,
  ]);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /near-ceiling-ratchet: fixture-bundle limitBytes raised from 1000 to 1500/,
  );
});

test('near-ceiling-ratchet: the same near-ceiling bundle raise fails audit-docs --check without an approval', (t) => {
  // Control for the approved-raise test above: without the approval entry the
  // identical raise is rejected, so that test passes because of the approval.
  const { dir, cleanup } = makeBundleRaiseFixture(1200);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /near-ceiling-ratchet: fixture-bundle limitBytes raised from 1000 to 1200/,
  );
});

// --- Per-file phaseLimitBytes approvals (#4233) ------------------------------

const PHASE_BUDGET_ID = 'fixture-budget';

/** A maintainer approval for raising the fixture entry's phaseLimitBytes to
 * 2000 bytes (the `bundle` field names the instructionSizeBudgets entry id). */
const PHASE_RAISE_TO_2000_APPROVAL = {
  bundle: PHASE_BUDGET_ID,
  limitBytes: 2000,
  issue: 4233,
  reason: 'Fixture approval for the per-file near-ceiling raise wiring test.',
};

/** The governed file is 960 bytes against a 1000-byte phaseLimitBytes at the
 * base ref (96%, past the 95% notice threshold), and the working-tree
 * manifest raises phaseLimitBytes to `currentPhaseLimitBytes`. */
function makePhaseRaiseFixture(
  currentPhaseLimitBytes: number,
  approvals?: unknown[],
) {
  const budgets = (phaseLimitBytes: number) => [
    {
      id: PHASE_BUDGET_ID,
      glob: '*.instructions.md',
      phaseLimitBytes,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  return makeFixture(
    { contextCeiling: CONTEXT_CEILING, instructionSizeBudgets: budgets(1000) },
    {
      contextCeiling: {
        ...CONTEXT_CEILING,
        ...(approvals === undefined
          ? {}
          : { nearCeilingRaiseApprovals: approvals }),
      },
      instructionSizeBudgets: budgets(currentPhaseLimitBytes),
    },
    { 'idd-fixture.instructions.md': 'x'.repeat(960) },
  );
}

test('near-ceiling-ratchet: an approved per-file phaseLimitBytes raise within its approved limit passes audit-docs --check', (t) => {
  const { dir, cleanup } = makePhaseRaiseFixture(2000, [
    PHASE_RAISE_TO_2000_APPROVAL,
  ]);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /documentation audit passed/);
  assert.doesNotMatch(output, /near-ceiling-ratchet/);
});

test('near-ceiling-ratchet: an approved per-file phaseLimitBytes raise above its approved limit fails audit-docs --check', (t) => {
  const { dir, cleanup } = makePhaseRaiseFixture(2500, [
    PHASE_RAISE_TO_2000_APPROVAL,
  ]);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /near-ceiling-ratchet: fixture-budget phaseLimitBytes raised from 1000 to 2500/,
  );
});

test('near-ceiling-ratchet: the same per-file phaseLimitBytes raise fails audit-docs --check without an approval', (t) => {
  // Control for the approved-raise test above: the identical raise without the
  // approval entry is rejected, so that test passes because of the approval.
  const { dir, cleanup } = makePhaseRaiseFixture(2000);
  t.after(cleanup);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /near-ceiling-ratchet: fixture-budget phaseLimitBytes raised from 1000 to 2000/,
  );
});
