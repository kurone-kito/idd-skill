import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv } from './test-utils.mts';

// Coverage for #1703's remediation-text split: a `generatedBlocks` entry
// carrying both `paths` and `sourceGlobs` that disagree produces a
// `manifest paths omit …` / `manifest path does not exist or match globs`
// error, which `docs:sync` cannot fix (it reads `paths` as-is). Before
// #1703, `containsMirrorDrift` treated these as generic mirror drift and
// suggested `docs:sync` regardless; this suite pins the corrected
// behavior and guards the still-legitimate `docs:sync` suggestion for a
// genuinely stale generated block.
//
// Same subprocess-fixture pattern as tests/audit-docs-file-sets.test.mts
// (checkGeneratedBlocks is not exported; the module is a top-level
// side-effecting CLI script).

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

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

function makeFixture(manifest: unknown): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-generated-blocks-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  mkdirSync(join(dir, 'audit'), { recursive: true });
  writeFileSync(
    join(dir, 'audit', 'sync-manifest.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  // detectSyncCommand() needs this to name an actual `docs:sync` command in
  // remediation output; without it a mirror-drift remediation line still
  // fires but falls back to a generic "align files" sentence instead.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      scripts: { 'docs:sync': 'node scripts/sync-docs.mjs --apply' },
      packageManager: 'pnpm@10.0.0',
    }),
    'utf8',
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// The exact marker-block content renderGeneratedBlock(block) produces for
// paths (no stripPrefix, `text` language) -- used to keep a fixture's
// on-disk marker content already in sync, so a test can isolate a single
// error class instead of also tripping the unrelated "is stale" check.
function markerDoc(id: string, paths: string[]): string {
  return `<!-- audit:generated id=${id} -->\n\n\`\`\`text\n${paths.join('\n')}\n\`\`\`\n\n<!-- /audit:generated -->\n`;
}

test('manifest paths/sourceGlobs mismatch: remediation names the manifest, not docs:sync', (t) => {
  const { dir, cleanup } = makeFixture({
    generatedBlocks: [
      {
        id: 'blk',
        file: 'doc.md',
        language: 'text',
        paths: ['content/a.md'],
        sourceGlobs: ['content/*.md'],
      },
    ],
  });
  t.after(cleanup);

  mkdirSync(join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'content', 'a.md'), '# a\n');
  // Present on disk (matches sourceGlobs) but missing from paths.
  writeFileSync(join(dir, 'content', 'b.md'), '# b\n');
  // Marker content already matches `paths` exactly, so the only error this
  // fixture can produce is the paths/sourceGlobs cross-check below -- not
  // a coincidental "generated block is stale" mirror-drift error.
  writeFileSync(join(dir, 'doc.md'), markerDoc('blk', ['content/a.md']));

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blk: manifest paths omit content\/b\.md/);
  assert.doesNotMatch(result.stderr, /generated block .* is stale/);

  assert.match(result.stderr, /remediation:/);
  assert.match(
    result.stderr,
    /edit `audit\/sync-manifest\.json`'s `generatedBlocks\[\]\.paths`/,
  );
  // No mirror-drift line: the suggestion never tells the operator to run
  // docs:sync (only explains, in the manifest-fix line above, why it can't
  // fix this specific error class).
  assert.doesNotMatch(result.stderr, /run `.*` to refresh mirrored files/);
});

test('a genuinely stale generated block still recommends docs:sync', (t) => {
  const { dir, cleanup } = makeFixture({
    generatedBlocks: [
      { id: 'blk', file: 'doc.md', language: 'text', paths: ['a.md', 'b.md'] },
    ],
  });
  t.after(cleanup);

  writeFileSync(join(dir, 'a.md'), '# a\n');
  writeFileSync(join(dir, 'b.md'), '# b\n');
  // Marker content lists only one of the two configured paths -- stale.
  writeFileSync(join(dir, 'doc.md'), markerDoc('blk', ['a.md']));

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blk: generated block in doc\.md is stale/);

  assert.match(result.stderr, /remediation:/);
  assert.match(result.stderr, /docs:sync/);
  assert.doesNotMatch(result.stderr, /manifest paths omit/);
});
