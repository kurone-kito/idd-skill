import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv } from './test-utils.mts';

// Coverage for the optional `sharedSections` key on `structure` pairs in
// src/scripts/audit-docs.mts (kurone-kito/idd-skill#4009). A `structure`
// pair compares heading signatures only, so prose drift under a heading
// passes both checks. Listing a section title in `sharedSections` makes
// audit-docs compare that section's full text (the heading and its
// subsections) exactly. Same subprocess-fixture pattern as
// tests/audit-docs-exact-mode-placeholders.test.mts.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAIR_ID = 'fixture-structure';
const SOURCE = 'idd-template/docs/fixture-rationale.md';
const TARGET = 'docs/fixture-rationale.md';

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
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-shared-sections-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  writeFile(dir, 'audit/sync-manifest.json', JSON.stringify({ syncPairs }));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function structurePair(extra: Record<string, unknown> = {}) {
  return {
    id: PAIR_ID,
    source: SOURCE,
    target: TARGET,
    mode: 'structure',
    ...extra,
  };
}

// A shared section with a subsection, and a local section that is allowed
// to differ between the two copies.
const BASE = [
  '# Fixture rationale',
  '',
  '## Shared rule',
  '',
  'The shared rule text.',
  '',
  '### Shared detail',
  '',
  'Detail text.',
  '',
  '## Local prose',
  '',
  'Prose that differs by design.',
  '',
].join('\n');

function seed(dir: string, source: string, target: string): void {
  writeFile(dir, SOURCE, source);
  writeFile(dir, TARGET, target);
}

test('sharedSections on a non-structure pair fails for every other mode', (t) => {
  for (const mode of ['exact', 'concreted', 'contains']) {
    const { dir, cleanup } = makeFixture([
      {
        id: PAIR_ID,
        source: SOURCE,
        target: TARGET,
        mode,
        sharedSections: ['Shared rule'],
      },
    ]);
    t.after(cleanup);
    seed(dir, BASE, BASE);

    const result = runAuditDocs(dir);
    assert.equal(result.status, 1, `mode ${mode}: ${result.stdout}`);
    assert.match(
      result.stderr,
      new RegExp(
        `${PAIR_ID}: sharedSections is only valid on a "structure" pair, not "${mode}"`,
      ),
    );
  }
});

test('a null sharedSections on a structure pair fails as a malformed value', (t) => {
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: null }),
  ]);
  t.after(cleanup);
  seed(dir, BASE, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: sharedSections must be an array of non-empty section titles`,
    ),
  );
});

test('a non-string sharedSections entry fails as a malformed value', (t) => {
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: [42] }),
  ]);
  t.after(cleanup);
  seed(dir, BASE, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sharedSections must be an array/);
});

test('a listed section whose full text differs fails and names the pair and the section', (t) => {
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    BASE,
    BASE.replace('The shared rule text.', 'The shared rule text, reworded.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" differs between ${SOURCE} and ${TARGET}`,
    ),
  );
});

test('a one-sentence probe in a listed subsection fails, as in the issue', (t) => {
  // The issue's probe: one sentence added to the template copy only. Here
  // it lands in the "### Shared detail" subsection, which is part of the
  // listed "Shared rule" section, so it must fail the check.
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    BASE.replace('Detail text.', 'Detail text. One probe sentence.'),
    BASE,
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('source-only text in an unlisted section still passes', (t) => {
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    BASE.replace(
      'Prose that differs by design.',
      'Prose that differs by design. Source-only sentence.',
    ),
    BASE.replace('Prose that differs by design.', 'Target-only prose.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a listed section missing from one side fails and names that file', (t) => {
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  // The target renames the section, so the heading-structure check fails too.
  // This test pins the missing-title message that the shared-section check
  // adds on top of it.
  seed(dir, BASE, BASE.replace('## Shared rule', '## Renamed rule'));

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" is missing from ${TARGET}`,
    ),
  );
});

test('a listed title that appears twice on one side fails closed', (t) => {
  const duplicated = `${BASE}\n## Shared rule\n\nA second copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, duplicated, duplicated);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears 2 times in ${SOURCE}`,
    ),
  );
});

test('a title that appears only inside a tilde fence counts as missing', (t) => {
  // headingSignature tracks only backtick fences, so the tilde-fenced "##"
  // line still counts in the signature on both sides and matches. The
  // shared-section check must not treat it as a real heading.
  const fenced = [
    '# Fixture rationale',
    '',
    '~~~',
    '## Shared rule',
    '~~~',
    '',
    'Only a code sample mentions it.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, fenced, fenced);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" is missing from ${SOURCE}`,
    ),
  );
});

test('a "#" line inside a tilde fence does not cut a listed section short', (t) => {
  // The section ends at the next real heading. If the tilde-fenced "#" line
  // were treated as a heading, the text after the fence would go left unchecked,
  // and this drift would pass.
  const withFence = (after: string) =>
    [
      '# Fixture rationale',
      '',
      '## Shared rule',
      '',
      '~~~',
      '# Not a heading',
      '~~~',
      '',
      after,
      '',
    ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    withFence('Text after the fence, source.'),
    withFence('Text after the fence, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('a structure pair without sharedSections keeps the heading-only behavior', (t) => {
  const { dir, cleanup } = makeFixture([structurePair()]);
  t.after(cleanup);
  seed(
    dir,
    BASE,
    BASE.replace('The shared rule text.', 'The shared rule text, reworded.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a four-space-indented tilde line is indented code, not a fence, so a later listed heading still counts', (t) => {
  // Markdown treats `    ~~~` as indented code. If the scanner opened a fence
  // on it, the real "## Shared rule" below would be hidden and reported as
  // missing. Both sides are identical, so the check must pass.
  const indented = [
    '# Fixture rationale',
    '',
    '    ~~~',
    '',
    '## Shared rule',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, indented, indented);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a heading inside an HTML comment does not end a listed section', (t) => {
  // Markdown does not render a commented-out heading, so the section runs
  // past the comment. Drift after the comment must still fail, even though the
  // commented "##" line matches on both sides and the heading signature
  // agrees.
  const commented = (after: string) =>
    [
      '# Fixture rationale',
      '',
      '## Shared rule',
      '',
      '<!--',
      '## Commented-out heading',
      '-->',
      '',
      after,
      '',
    ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    commented('Text after the comment, source.'),
    commented('Text after the comment, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('a second comment opened on the line where the first one closes is still scanned', (t) => {
  // The first comment closes and a second one opens on the same line. The
  // commented-out "##" line belongs to the second comment, so it must not end
  // the section. Drift after the second comment must still fail.
  const twoComments = (after: string) =>
    [
      '# Fixture rationale',
      '',
      '## Shared rule',
      '',
      '<!--',
      'first note',
      '--> <!--',
      '## Commented-out heading',
      '-->',
      '',
      after,
      '',
    ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(
    dir,
    twoComments('Text after the second comment, source.'),
    twoComments('Text after the second comment, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('a literal "<!--" inside a code span does not open a comment', (t) => {
  // The code span holds the text "<!--", which Markdown renders literally. A
  // comment opened there would hide the real "## Shared rule" heading below
  // it. Both sides are identical, so the check must pass.
  const literal = [
    '# Fixture rationale',
    '',
    'Write `<!--` to open a comment.',
    '',
    '## Shared rule',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, literal, literal);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a "<!--" in an indented code block after a blank line is literal', (t) => {
  // Four leading spaces after a blank line make an indented code block, where
  // "<!--" is text, not a comment. The real heading below must still count.
  const indentedCode = [
    '# Fixture rationale',
    '',
    '    <!--',
    '',
    '## Shared rule',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, indentedCode, indentedCode);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a heading whose title ends in a hash keeps that hash in its title', (t) => {
  // "## C#" has no space before the trailing "#", so the "#" is part of the
  // title, not a closing sequence. The listed "C#" section must be found, and
  // drift inside it must still fail.
  const csharp = (body: string) =>
    ['# Fixture rationale', '', '## C#', '', body, ''].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['C#'] }),
  ]);
  t.after(cleanup);
  seed(dir, csharp('Body, source.'), csharp('Body, target.'));

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "C#" differs between/);
});
