import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeJson,
  classifyComparedFile,
  classifyDeletedFile,
  classifyFileContent,
  computeExitCode,
  isGeneratedBannerEligible,
  isProseExtension,
  isTolerated,
  normalizeProseWhitespace,
  runVerification,
  stripGeneratedBannerParagraph,
} from '../src/scripts/verify-import-mirror.mts';
import { fixtureEnv } from './test-utils.mts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'verify-import-mirror.mjs');

// ---------------------------------------------------------------------------
// Rule 1 -- generated-banner-only tolerance
// ---------------------------------------------------------------------------

test("stripGeneratedBannerParagraph strips only the marker line, not the trailing prose (this repo's own real banner shape)", () => {
  // Mirrors scripts/verify-install-deps.mjs's own header exactly: the
  // marker line is immediately followed by a bare "//" separator, then a
  // longer prose paragraph that must survive untouched.
  const content = [
    '#!/usr/bin/env node',
    '// idd-generated-from: src/scripts/verify-install-deps.mts',
    '//',
    '// The scripts/verify-install-deps.mjs copy is generated from the .mts',
    '// source named above by `pnpm run build`. Edit the .mts source, never',
    '// the generated .mjs. See docs/typescript-sources.md.',
    '',
    "import { execFileSync } from 'node:child_process';",
  ].join('\n');
  const stripped = stripGeneratedBannerParagraph(content, 'idd-generated-from');
  assert.equal(
    stripped,
    [
      '#!/usr/bin/env node',
      '<generated-banner-stripped>',
      '//',
      '// The scripts/verify-install-deps.mjs copy is generated from the .mts',
      '// source named above by `pnpm run build`. Edit the .mts source, never',
      '// the generated .mjs. See docs/typescript-sources.md.',
      '',
      "import { execFileSync } from 'node:child_process';",
    ].join('\n'),
  );
});

test('stripGeneratedBannerParagraph returns content unchanged when the marker is absent', () => {
  const content = '// nothing generated here\nconst x = 1;\n';
  assert.equal(
    stripGeneratedBannerParagraph(content, 'idd-generated-from'),
    content,
  );
});

test('isGeneratedBannerEligible is false with no --generated-dir (fails closed by default)', () => {
  // Regression test for the critique's High finding: unscoped banner
  // tolerance would reproduce the issue's own "too permissive v1" failure.
  assert.equal(isGeneratedBannerEligible('scripts/foo.mjs', []), false);
});

test('isGeneratedBannerEligible is true only for a .mjs path under a configured dir', () => {
  assert.equal(isGeneratedBannerEligible('scripts/foo.mjs', ['scripts']), true);
  assert.equal(isGeneratedBannerEligible('bin/foo.mjs', ['scripts']), false);
  assert.equal(
    isGeneratedBannerEligible('scripts/foo.mts', ['scripts']),
    false,
  );
});

test('rule 1 pass: classifyFileContent tolerates a banner-only difference under a configured --generated-dir', () => {
  const upstream = Buffer.from(
    '// idd-generated-from: src/scripts/foo.mts\n//\nconst x = 1;\n',
  );
  const target = Buffer.from(
    '// idd-generated-from: vendor/src/scripts/foo.mts\n//\nconst x = 1;\n',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: ['scripts'],
  });
  assert.equal(result.contentClass, 'generated-banner-only');
});

test('rule 1 fail: a real content difference beyond the banner is a genuine mismatch, even under a configured --generated-dir', () => {
  const upstream = Buffer.from(
    '// idd-generated-from: src/scripts/foo.mts\n//\nconst x = 1;\n',
  );
  const target = Buffer.from(
    '// idd-generated-from: vendor/src/scripts/foo.mts\n//\nconst x = 2;\n',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: ['scripts'],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('rule 1 fail: the same banner-only difference is a genuine mismatch when no --generated-dir covers it', () => {
  const upstream = Buffer.from(
    '// idd-generated-from: src/scripts/foo.mts\n//\nconst x = 1;\n',
  );
  const target = Buffer.from(
    '// idd-generated-from: vendor/src/scripts/foo.mts\n//\nconst x = 1;\n',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

// ---------------------------------------------------------------------------
// Rule 2 -- JSON structural comparison
// ---------------------------------------------------------------------------

test('canonicalizeJson returns null for invalid JSON', () => {
  assert.equal(canonicalizeJson('{not json'), null);
});

test('rule 2 pass: structurally identical JSON tolerates pure formatting differences', () => {
  const upstream = Buffer.from('{\n  "a": 1,\n  "b": 2\n}\n');
  const target = Buffer.from('{"a":1,"b":2}');
  const result = classifyFileContent({
    path: 'config/settings.json',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'structural-json-match');
});

test('rule 2 fail: a real value change is never whitespace-tolerant', () => {
  const upstream = Buffer.from('{"a":1}');
  const target = Buffer.from('{"a":2}');
  const result = classifyFileContent({
    path: 'config/settings.json',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

// ---------------------------------------------------------------------------
// Rule 3 -- prose reflow tolerance (Markdown only)
// ---------------------------------------------------------------------------

test('normalizeProseWhitespace collapses line-wrap width but preserves paragraph breaks', () => {
  const wrapped = 'one two\nthree four\n\nsecond paragraph\n';
  const rewrapped = 'one two three\nfour\n\nsecond paragraph\n';
  assert.equal(
    normalizeProseWhitespace(wrapped),
    normalizeProseWhitespace(rewrapped),
  );
});

test('normalizeProseWhitespace tolerates a differing blank-line COUNT between paragraphs', () => {
  const oneBlankLine = 'first\n\nsecond\n';
  const twoBlankLines = 'first\n\n\nsecond\n';
  assert.equal(
    normalizeProseWhitespace(oneBlankLine),
    normalizeProseWhitespace(twoBlankLines),
  );
});

test('normalizeProseWhitespace does NOT tolerate a removed blank line that merges two paragraphs', () => {
  const twoParagraphs = 'first\n\nsecond\n';
  const merged = 'first\nsecond\n';
  assert.notEqual(
    normalizeProseWhitespace(twoParagraphs),
    normalizeProseWhitespace(merged),
  );
});

test('isProseExtension matches .md case-insensitively and nothing else', () => {
  assert.equal(isProseExtension('docs/readme.md'), true);
  assert.equal(isProseExtension('docs/README.MD'), true);
  assert.equal(isProseExtension('config/values.yaml'), false);
  assert.equal(isProseExtension('config/values.yml'), false);
});

test('rule 3 pass: a Markdown file with reflowed whitespace is tolerated', () => {
  const upstream = Buffer.from('one two\nthree four\n');
  const target = Buffer.from('one two three\nfour\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'prose-reflow-match');
});

test('rule 3 fail: a YAML file with the exact same reflow difference is NOT tolerated (acceptance-criteria worked example)', () => {
  const upstream = Buffer.from('one two\nthree four\n');
  const target = Buffer.from('one two three\nfour\n');
  const result = classifyFileContent({
    path: 'config/values.yaml',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

// ---------------------------------------------------------------------------
// Rule 4 -- git file mode comparison
// ---------------------------------------------------------------------------

test('rule 4 pass: identical content and identical mode is exact', () => {
  const content = Buffer.from('#!/bin/sh\necho hi\n');
  const result = classifyComparedFile({
    path: 'bin/tool.sh',
    upstreamContent: content,
    targetContent: content,
    upstreamMode: '100755',
    targetMode: '100755',
    generatedDirs: [],
  });
  assert.equal(result.status, 'exact');
});

test('rule 4 fail: identical bytes with a dropped executable bit is a mode-only mismatch, not tolerated', () => {
  const content = Buffer.from('#!/bin/sh\necho hi\n');
  const result = classifyComparedFile({
    path: 'bin/tool.sh',
    upstreamContent: content,
    targetContent: content,
    upstreamMode: '100755',
    targetMode: '100644',
    generatedDirs: [],
  });
  assert.equal(result.status, 'mode-only-mismatch');
  assert.equal(isTolerated(result.status), false);
});

test('a tolerated content class combined with a mode difference is a genuine (compound) mismatch, not silently tolerated', () => {
  const result = classifyComparedFile({
    path: 'config/settings.json',
    upstreamContent: Buffer.from('{"a":1}'),
    targetContent: Buffer.from('{ "a": 1 }'),
    upstreamMode: '100644',
    targetMode: '100755',
    generatedDirs: [],
  });
  assert.equal(result.status, 'content-mismatch');
  assert.match(result.detail ?? '', /structural-json-match/);
});

// ---------------------------------------------------------------------------
// Rule 5 -- deletions
// ---------------------------------------------------------------------------

test('rule 5 pass: a deletion matches upstream when upstream also lacks the path', () => {
  const result = classifyDeletedFile({ upstreamExists: false });
  assert.equal(result.status, 'deletion-matches-upstream');
});

test('rule 5 fail: a deletion is a genuine mismatch when upstream still has the path', () => {
  const result = classifyDeletedFile({ upstreamExists: true });
  assert.equal(result.status, 'content-mismatch');
});

// ---------------------------------------------------------------------------
// Cross-cutting: tolerated-set membership and exit code
// ---------------------------------------------------------------------------

test('isTolerated matches exactly the five tolerated categories', () => {
  assert.equal(isTolerated('exact'), true);
  assert.equal(isTolerated('generated-banner-only'), true);
  assert.equal(isTolerated('structural-json-match'), true);
  assert.equal(isTolerated('prose-reflow-match'), true);
  assert.equal(isTolerated('deletion-matches-upstream'), true);
  assert.equal(isTolerated('mode-only-mismatch'), false);
  assert.equal(isTolerated('content-mismatch'), false);
});

test('computeExitCode is 0 only when every result is tolerated', () => {
  assert.equal(
    computeExitCode([{ status: 'exact' }, { status: 'prose-reflow-match' }]),
    0,
  );
  assert.equal(
    computeExitCode([{ status: 'exact' }, { status: 'content-mismatch' }]),
    1,
  );
  assert.equal(computeExitCode([]), 0);
});

test('classifyComparedFile reports a genuine mismatch when the path is absent from upstream entirely', () => {
  const result = classifyComparedFile({
    path: 'scripts/new-file.mjs',
    upstreamContent: null,
    targetContent: Buffer.from('const x = 1;\n'),
    upstreamMode: null,
    targetMode: '100644',
    generatedDirs: [],
  });
  assert.equal(result.status, 'content-mismatch');
});

// ---------------------------------------------------------------------------
// CLI integration: spawn the emitted scripts/verify-import-mirror.mjs
// against a real temp git repo (target commit) and a plain --upstream-path
// directory, matching this repo's own generated-artifact-testing
// convention (docs/typescript-sources.md).
// ---------------------------------------------------------------------------

function initTargetRepo(root: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root, env: fixtureEnv() });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: root,
    env: fixtureEnv(),
  });
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: root,
    env: fixtureEnv(),
  });
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root, env: fixtureEnv() });
  execFileSync('git', ['commit', '--quiet', '-m', message], {
    cwd: root,
    env: fixtureEnv(),
  });
}

function runCli(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('CLI --help documents every declared flag and exits 0', () => {
  const result = runCli(['--help'], REPO_ROOT);
  assert.equal(result.status, 0);
  for (const flag of [
    '--target-root',
    '--target-ref',
    '--target-base-ref',
    '--upstream-path',
    '--upstream-ref',
    '--upstream-remote',
    '--path-prefix',
    '--generated-dir',
    '--format',
    '--help',
  ]) {
    assert.ok(result.stdout.includes(flag), `--help should mention ${flag}`);
  }
});

test('CLI errors (exit 2) when neither --upstream-path nor --upstream-ref is given', () => {
  const result = runCli(['--target-root', REPO_ROOT], REPO_ROOT);
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /exactly one of --upstream-path or --upstream-ref/,
  );
});

test('CLI errors (exit 2) when --upstream-remote is given without --upstream-ref', () => {
  const result = runCli(
    ['--upstream-path', REPO_ROOT, '--upstream-remote', 'upstream'],
    REPO_ROOT,
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--upstream-remote requires --upstream-ref/);
});

test('CLI end-to-end: a pure vendoring commit against an --upstream-path checkout exits 0', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(
      join(targetRoot, 'baseline.txt'),
      'unrelated pre-existing file\n',
    );
    commitAll(targetRoot, 'chore: baseline');

    // Upstream checkout: exactly what the import commit is supposed to
    // mirror.
    mkdirSync(join(upstreamRoot, 'vendor'), { recursive: true });
    writeFileSync(
      join(upstreamRoot, 'vendor', 'a.json'),
      '{\n  "value": 1\n}\n',
    );
    writeFileSync(
      join(upstreamRoot, 'vendor', 'readme.md'),
      'one two\nthree four\n',
    );

    // Import commit: adds a.json reformatted (rule 2), readme.md rewrapped
    // (rule 3) -- both should classify as tolerated, not exact.
    mkdirSync(join(targetRoot, 'vendor'), { recursive: true });
    writeFileSync(join(targetRoot, 'vendor', 'a.json'), '{"value":1}');
    writeFileSync(
      join(targetRoot, 'vendor', 'readme.md'),
      'one two three\nfour\n',
    );
    commitAll(targetRoot, 'chore: vendor import');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--path-prefix',
        'vendor',
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      scanned: number;
      results: { path: string; status: string }[];
    };
    assert.equal(report.scanned, 2);
    assert.ok(
      report.results.every((r) =>
        ['structural-json-match', 'prose-reflow-match'].includes(r.status),
      ),
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a real content drift against upstream exits 1', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(
      join(targetRoot, 'baseline.txt'),
      'unrelated pre-existing file\n',
    );
    commitAll(targetRoot, 'chore: baseline');

    mkdirSync(join(upstreamRoot, 'vendor'), { recursive: true });
    writeFileSync(join(upstreamRoot, 'vendor', 'a.json'), '{"value":1}');

    mkdirSync(join(targetRoot, 'vendor'), { recursive: true });
    writeFileSync(join(targetRoot, 'vendor', 'a.json'), '{"value":2}');
    commitAll(targetRoot, 'chore: vendor import with drift');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--path-prefix',
        'vendor',
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { status: string }[];
    };
    assert.ok(report.results.some((r) => r.status === 'content-mismatch'));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a legitimate matching deletion (upstream dropped it too) exits 0', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    mkdirSync(join(targetRoot, 'vendor'), { recursive: true });
    writeFileSync(join(targetRoot, 'vendor', 'stale.txt'), 'to be removed\n');
    commitAll(
      targetRoot,
      'chore: baseline with a soon-to-be-removed vendored file',
    );

    // Upstream no longer has vendor/stale.txt either.
    mkdirSync(upstreamRoot, { recursive: true });

    rmSync(join(targetRoot, 'vendor', 'stale.txt'));
    commitAll(targetRoot, 'chore: vendor import drops stale.txt');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { status: string }[];
    };
    assert.deepEqual(
      report.results.map((r) => r.status),
      ['deletion-matches-upstream'],
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: an empty scoped diff prints "0 files compared" and exits 0', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    writeFileSync(
      join(targetRoot, 'unrelated.txt'),
      'not under the scoped prefix\n',
    );
    commitAll(targetRoot, 'chore: unrelated change outside the scoped prefix');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--path-prefix',
        'vendor',
        '--format',
        'table',
      ],
      targetRoot,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0 files compared/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('rule 4 CLI end-to-end: --upstream-path resolves mode from a real git work tree, not just fs bits', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');

    // Upstream is itself a git work tree with an executable script
    // committed with mode 100755.
    initTargetRepo(upstreamRoot);
    writeFileSync(join(upstreamRoot, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(upstreamRoot, 'run.sh'), 0o755);
    commitAll(upstreamRoot, 'chore: add executable script');

    // Target vendors the same content, but the executable bit is dropped.
    writeFileSync(join(targetRoot, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(targetRoot, 'run.sh'), 0o644);
    commitAll(targetRoot, 'chore: vendor import drops the executable bit');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { status: string }[];
    };
    assert.deepEqual(
      report.results.map((r) => r.status),
      ['mode-only-mismatch'],
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: --upstream-ref resolves against a git ref instead of a checkout path', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'a.txt'), 'original\n');
    commitAll(targetRoot, 'chore: baseline');
    execFileSync('git', ['branch', 'upstream-snapshot'], {
      cwd: targetRoot,
      env: fixtureEnv(),
    });

    writeFileSync(join(targetRoot, 'a.txt'), 'changed\n');
    commitAll(targetRoot, 'chore: modify a.txt without mirroring upstream');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-ref',
        'upstream-snapshot',
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { path: string; changeType: string; status: string }[];
    };
    assert.deepEqual(report.results, [
      { path: 'a.txt', changeType: 'M', status: 'content-mismatch' },
    ]);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a non-ASCII path is compared correctly under core.quotePath=true (C1 critique regression)', () => {
  // Without -z, `git diff --name-status` C-quotes any non-ASCII byte under
  // git's default core.quotePath=true (e.g. "café.mjs" becomes
  // "caf\303\251.mjs"), and that mangled string would then fail to
  // resolve against the real path in every downstream lookup -- a false
  // content-mismatch for an add/modify, or a false
  // deletion-matches-upstream for a delete (the mangled path never
  // resolves against the real upstream path either). Pin
  // core.quotePath=true explicitly (rather than relying on the ambient
  // default, which this development machine happens to override
  // globally) so this test fails the same way everywhere if the -z fix
  // regresses.
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    execFileSync('git', ['config', 'core.quotePath', 'true'], {
      cwd: targetRoot,
      env: fixtureEnv(),
    });
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');

    writeFileSync(join(upstreamRoot, 'café.mjs'), 'vendored content\n');
    writeFileSync(join(targetRoot, 'café.mjs'), 'vendored content\n');
    commitAll(targetRoot, 'chore: vendor import of a non-ASCII filename');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { path: string; changeType: string; status: string }[];
    };
    assert.deepEqual(report.results, [
      { path: 'café.mjs', changeType: 'A', status: 'exact' },
    ]);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

// runVerification is exercised directly here too (not only via the CLI
// subprocess) to prove the exported plumbing function itself -- not just
// argv parsing -- is what's under test above.
test('runVerification wires the git plumbing and pure classification together', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');

    writeFileSync(join(upstreamRoot, 'new.txt'), 'vendored content\n');
    writeFileSync(join(targetRoot, 'new.txt'), 'vendored content\n');
    commitAll(targetRoot, 'chore: vendor import');

    const report = runVerification({
      targetRoot,
      targetRef: 'HEAD',
      targetBaseRef: 'HEAD^',
      upstreamPath: upstreamRoot,
      upstreamRef: null,
      upstreamRemote: null,
      pathPrefixes: [],
      generatedDirs: [],
    });
    assert.deepEqual(report.results, [
      { path: 'new.txt', changeType: 'A', status: 'exact' },
    ]);
    assert.equal(report.scanned, 1);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});
