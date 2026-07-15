import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// checkFileSets in src/scripts/audit-docs.mts is not exported (the module
// runs as a top-level side-effecting CLI script, including a `process.exit`
// on failure), so it cannot be imported and unit-tested directly. These
// tests drive the built `scripts/audit-docs.mjs` CLI as a subprocess
// against a minimal fixture git repo instead — the same pattern used by
// tests/sync-docs.test.mts and the CLI-subprocess smoke tests in
// tests/cli-entry-smoke.test.mts.
//
// Coverage motivation: a same-side basename collision under a recursive
// `**/*.md` fileSet glob (for example a new
// `skills/issue-authoring/references/a/contract.md` alongside the existing
// `skills/issue-authoring/references/contract.md`) used to be silently
// swallowed by the basename-keyed Set/Map in checkFileSets — the guard
// would report the new file as already covered by the unrelated existing
// file's target and syncPairs entry. checkFileSets now fails closed on any
// such collision instead of guessing which path a basename "really" refers
// to.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Fixture invariant: fixture git processes (and the audit-docs.mjs
// subprocess, which itself shells out to `git ls-files`) must never read
// the ambient GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE state. A caller that
// runs this suite from inside a git hook exports those variables, and an
// unsanitized fixture would then operate on (and could mutate) the host
// repository instead of the temp fixture, despite `cwd` pointing at the
// fixture. Same pattern as tests/worktree-guard-hook.test.mts.
//
// `git ls-files --exclude-standard` also honors `core.excludesFile`, which
// git resolves from the global/system config file *or*, when that key is
// entirely unset (as it is once GIT_CONFIG_GLOBAL/SYSTEM point at
// /dev/null below), falls back to git's own hardcoded default
// `$XDG_CONFIG_HOME/git/ignore`. An operator's real personal ignore file
// there can exclude fixture paths for reasons that have nothing to do with
// this suite (for example a `.claude/*` entry with a narrower allowlist
// than this fixture's directory names need), silently dropping fixture
// files from `git ls-files` and making the suite flaky depending on who
// runs it. Force `core.excludesFile` itself to `/dev/null` via the
// `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env
// injection (which git honors regardless of file-based config, and unlike
// leaving the key unset, does not trigger the XDG-default fallback) so
// fixture file discovery can never be influenced by the host's ignore
// patterns.
function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.excludesFile';
  env.GIT_CONFIG_VALUE_0 = devNull;
  return env;
}

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

function makeFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-file-sets-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  mkdirSync(join(dir, 'audit'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'mirror-source', 'nested'), {
    recursive: true,
  });
  mkdirSync(join(dir, '.claude', 'mirror-target'), { recursive: true });
  writeFileSync(
    join(dir, 'audit', 'sync-manifest.json'),
    JSON.stringify({
      fileSets: [
        {
          id: 'fixture-set',
          sourceGlob: 'skills/mirror-source/**/*.md',
          targetGlob: '.claude/mirror-target/**/*.md',
          match: 'basename',
          requireSyncPairs: false,
        },
      ],
    }),
    'utf8',
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('checkFileSets passes a recursive fileSet with no basename collision', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('checkFileSets fails closed when two source files share a basename', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');
  // A new canonical file nested one directory deeper, sharing the basename
  // of the already-mirrored file above.
  writeFileSync(
    join(dir, 'skills', 'mirror-source', 'nested', 'a.md'),
    '# a nested\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-set: ambiguous basename a\.md matches multiple source files/,
  );
  assert.match(result.stderr, /mirror-source\/a\.md/);
  assert.match(result.stderr, /mirror-source\/nested\/a\.md/);
});

test('checkFileSets fails closed when two target files share a basename', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');
  mkdirSync(join(dir, '.claude', 'mirror-target', 'nested'), {
    recursive: true,
  });
  writeFileSync(
    join(dir, '.claude', 'mirror-target', 'nested', 'a.md'),
    '# a mirror nested\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-set: ambiguous basename a\.md matches multiple target files/,
  );
});
