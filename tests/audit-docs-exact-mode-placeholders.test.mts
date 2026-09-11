import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv } from './test-utils.mts';

// Coverage for checkGeneratedModePlaceholders in src/scripts/audit-docs.mts
// (kurone-kito/idd-skill#2899): an unresolved onboarding placeholder token
// (e.g. `{{PROJECT_MARKER_PREFIX}}`) left in an `"exact"`- or
// `"concreted"`-mode pair's *post-replacement* source leaks byte-for-byte
// into this repository's own live mirror -- checkSyncPairs alone cannot see
// this, since an identical placeholder on both sides produces zero drift.
// Neither mode is substitution-free by name alone (PR #2904 review,
// Copilot + Codex): checkSyncPairs and sync-docs.mts both apply a pair's
// own `replacements` array regardless of mode, so the guard must do the
// same before reporting a remaining placeholder -- both to avoid rejecting
// a pair whose own replacement already resolves the token, and to still
// catch a `"concreted"` pair whose `replacements` array is missing or
// incomplete. Same subprocess-fixture pattern as
// tests/audit-docs-file-sets.test.mts (checkGeneratedModePlaceholders is
// not exported; the module is a top-level side-effecting CLI script).

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLACEHOLDER_TOKEN = '{{PROJECT_MARKER_PREFIX}}';

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

function writeFile(dir: string, relativePath: string, content: string) {
  const absolute = join(dir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function makeFixture(syncPairs: unknown[]): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-exact-placeholders-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  writeFile(dir, 'audit/sync-manifest.json', JSON.stringify({ syncPairs }));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('"exact" mode pair whose source still carries a known placeholder fails', (t) => {
  const { dir, cleanup } = makeFixture([
    {
      id: 'fixture-exact-placeholder',
      source: 'idd-template/docs/fixture-guide.md',
      target: 'docs/fixture-guide.md',
      mode: 'exact',
    },
  ]);
  t.after(cleanup);

  // Source and target are identical so checkSyncPairs itself sees no drift
  // and this failure is isolated to checkGeneratedModePlaceholders alone.
  const content = `# Fixture guide\n\nMarker syntax: \`<!-- ${PLACEHOLDER_TOKEN}-roadmap-id: ... -->\`\n`;
  writeFile(dir, 'idd-template/docs/fixture-guide.md', content);
  writeFile(dir, 'docs/fixture-guide.md', content);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-exact-placeholder: idd-template\/docs\/fixture-guide\.md is "exact" mode but still contains unresolved placeholder\(s\) \{\{PROJECT_MARKER_PREFIX\}\}/,
  );
});

test('the same pair passes once flipped to "concreted" with a matching replacement', (t) => {
  const { dir, cleanup } = makeFixture([
    {
      id: 'fixture-exact-placeholder',
      source: 'idd-template/docs/fixture-guide.md',
      target: 'docs/fixture-guide.md',
      mode: 'concreted',
      replacements: [{ from: PLACEHOLDER_TOKEN, to: 'idd-skill' }],
    },
  ]);
  t.after(cleanup);

  writeFile(
    dir,
    'idd-template/docs/fixture-guide.md',
    `# Fixture guide\n\nMarker syntax: \`<!-- ${PLACEHOLDER_TOKEN}-roadmap-id: ... -->\`\n`,
  );
  writeFile(
    dir,
    'docs/fixture-guide.md',
    '# Fixture guide\n\nMarker syntax: `<!-- idd-skill-roadmap-id: ... -->`\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a "concreted" mode pair whose replacements do not resolve a placeholder fails', (t) => {
  // Codex (PR #2904 review): the guard originally skipped every
  // "concreted" pair outright, so an incomplete or missing replacement on
  // a "concreted" pair -- the same live-leak risk as an "exact" pair with
  // no replacements at all -- went uncaught. checkSyncPairs alone cannot
  // catch it either: an identical leftover placeholder on both source and
  // target sides of a "concreted" pair still produces zero byte-drift.
  const { dir, cleanup } = makeFixture([
    {
      id: 'fixture-concreted-incomplete',
      source: 'idd-template/docs/fixture-incomplete.md',
      target: 'docs/fixture-incomplete.md',
      mode: 'concreted',
      // Resolves an unrelated token, leaving PLACEHOLDER_TOKEN itself
      // untouched -- an incomplete `replacements` array, not an absent one.
      replacements: [{ from: '{{REPO_NAME}}', to: 'idd-skill' }],
    },
  ]);
  t.after(cleanup);

  const content = `# Fixture guide\n\nMarker syntax: \`<!-- ${PLACEHOLDER_TOKEN}-roadmap-id: ... -->\`\n`;
  writeFile(dir, 'idd-template/docs/fixture-incomplete.md', content);
  writeFile(dir, 'docs/fixture-incomplete.md', content);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-concreted-incomplete: idd-template\/docs\/fixture-incomplete\.md is "concreted" mode but still contains unresolved placeholder\(s\) \{\{PROJECT_MARKER_PREFIX\}\}/,
  );
});

test('an "exact" mode pair whose own replacements resolve the placeholder passes', (t) => {
  // "exact" mode is not substitution-free: checkSyncPairs and sync-docs.mts
  // both apply `pair.replacements` regardless of mode (tests/sync-
  // docs.test.mts covers this same "exact" + replacements combination), so
  // checkGeneratedModePlaceholders must scan the post-replacement source,
  // not the raw one.
  const { dir, cleanup } = makeFixture([
    {
      id: 'fixture-exact-with-replacement',
      source: 'idd-template/docs/fixture-resolved.md',
      target: 'docs/fixture-resolved.md',
      mode: 'exact',
      replacements: [{ from: PLACEHOLDER_TOKEN, to: 'idd-skill' }],
    },
  ]);
  t.after(cleanup);

  writeFile(
    dir,
    'idd-template/docs/fixture-resolved.md',
    `# Fixture guide\n\nMarker syntax: \`<!-- ${PLACEHOLDER_TOKEN}-roadmap-id: ... -->\`\n`,
  );
  writeFile(
    dir,
    'docs/fixture-resolved.md',
    '# Fixture guide\n\nMarker syntax: `<!-- idd-skill-roadmap-id: ... -->`\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('an exempted "exact" mode pair passes despite an unresolved placeholder', (t) => {
  // "customization-doc" is the one real entry in audit-docs.mts's
  // GENERATED_MODE_PLACEHOLDER_EXEMPTIONS constant -- the exemption is an
  // id-keyed allowlist inside the script itself, not a manifest field, so
  // exercising it means reusing that exact id here rather than an
  // arbitrary fixture name.
  const { dir, cleanup } = makeFixture([
    {
      id: 'customization-doc',
      source: 'idd-template/docs/fixture-customization.md',
      target: 'docs/fixture-customization.md',
      mode: 'exact',
    },
  ]);
  t.after(cleanup);

  const content = `# Placeholders\n\n| Placeholder | Meaning |\n| --- | --- |\n| \`${PLACEHOLDER_TOKEN}\` | marker prefix |\n`;
  writeFile(dir, 'idd-template/docs/fixture-customization.md', content);
  writeFile(dir, 'docs/fixture-customization.md', content);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
