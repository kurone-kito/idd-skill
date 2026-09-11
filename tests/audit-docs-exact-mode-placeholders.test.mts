import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv } from './test-utils.mts';

// Coverage for checkExactModePlaceholders in src/scripts/audit-docs.mts
// (kurone-kito/idd-skill#2899): a `"mode": "exact"` sync pair has no
// `replacements` array, so an unresolved onboarding placeholder token
// (e.g. `{{PROJECT_MARKER_PREFIX}}`) left in its source leaks byte-for-byte
// into this repository's own live mirror -- checkSyncPairs alone cannot see
// this, since an identical placeholder on both sides of an "exact" pair
// produces zero drift. Same subprocess-fixture pattern as
// tests/audit-docs-file-sets.test.mts (checkExactModePlaceholders is not
// exported; the module is a top-level side-effecting CLI script).

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
  // and this failure is isolated to checkExactModePlaceholders alone.
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

test('an exempted "exact" mode pair passes despite an unresolved placeholder', (t) => {
  // "customization-doc" is the one real entry in audit-docs.mts's
  // EXACT_MODE_PLACEHOLDER_EXEMPTIONS constant -- the exemption is an
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
