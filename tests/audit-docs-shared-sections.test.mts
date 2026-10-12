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

test('a heading after a comment that closes and reopens on one line is a real heading', (t) => {
  // CommonMark: the "--> <!--" line ends the comment block, so the next line
  // "## Commented-out heading" is an ordinary heading. The section therefore
  // ends before it, and text under that heading is outside the listed section.
  // Only the text above the heading is compared, so drift below it passes.
  const reopened = (after: string) =>
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
    reopened('Text after the reopened comment, source.'),
    reopened('Text after the reopened comment, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a mid-line comment does not hide a heading on the next line', (t) => {
  // "text <!--" does not start its line, so it is inline HTML and the next
  // line is still a heading (confirmed with a CommonMark parser).
  const midLine = [
    '# Fixture rationale',
    '',
    'Some text <!--',
    '## Shared rule',
    '-->',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, midLine, midLine.replace('The shared rule text.', 'Drifted.'));

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('a "<!--" inside continued indented code is literal', (t) => {
  // The first line is indented code after a blank line; the next two lines are
  // still indented, so they stay code and "<!--" in them opens nothing. The
  // listed heading below must still be found.
  const continued = [
    '# Fixture rationale',
    '',
    '    code line',
    '    <!--',
    '    more code',
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
  seed(dir, continued, continued);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
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

test('an example fence inside an HTML comment does not hide the headings after it', (t) => {
  // Inside an HTML block nothing is parsed as a fence, so the "```js" line in
  // the comment does not open code. If it did, it would stay open to the end of
  // the file and hide the real "## Shared rule" heading below. Both sides are
  // identical, so the check must pass.
  const commentedExample = [
    '# Fixture rationale',
    '',
    '<!--',
    '```js',
    '-->',
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
  seed(dir, commentedExample, commentedExample);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a fence opened in a list item hides a heading-looking line in it', (t) => {
  // "  ## Example" sits inside the fence that "- ```sh" opens, so it is code and
  // not a heading. The real "## After" heading below the list still counts.
  // Both sides are identical, so the check must pass.
  const listFence = [
    '## Shared rule',
    '',
    '- ```sh',
    '  ## Example',
    '  ```',
    '',
    '## After',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, listFence, listFence);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a backtick in a backtick fence info string does not open a fence', (t) => {
  // "```info`" is not a fence opener, so the "## Shared rule" heading below it
  // is a real heading. Treating the line as a fence would hide that heading and
  // report the section missing. Both sides are identical, so the check passes.
  const badOpener = [
    '```info`',
    '## Shared rule',
    '```',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, badOpener, badOpener);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a listed title that is also a source-only blockquote heading fails and names that file', (t) => {
  // "> ## Shared rule" renders as a second heading with the listed title, but
  // headingSignature and the top-level scan both skip it. Without this check the
  // duplicate would pass, since the top-level copy still matches exactly.
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, `${BASE}\n> ## Shared rule\n\nQuoted copy.\n`, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('a listed title that is a target-only list-item heading fails and names that file', (t) => {
  // "- ## Shared rule" is a list-item heading in the target copy only.
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, BASE, `${BASE}\n- ## Shared rule\n\nListed copy.\n`);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${TARGET}`,
    ),
  );
});

test('a list marker without a following space is text, not a nested heading', (t) => {
  // "-## Shared rule" has no space after the list marker, so CommonMark renders
  // it as a paragraph. It must not count as a nested copy of the listed title.
  // Both sides carry the same literal line, so the check passes.
  const literal = `${BASE}\n-## Shared rule\n\nLiteral text.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, literal, literal);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a heading in a list item nested four spaces deep counts as a nested heading', (t) => {
  // "    - ## Shared rule" sits under "- parent" as a nested list item, so it is a
  // rendered duplicate of the listed title and must fail, naming the source.
  const nested = `${BASE}\n- parent\n    - ## Shared rule\n\nNested copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, nested, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('a heading indented under a list item is nested, not a section boundary', (t) => {
  // "  ## Shared rule" sits inside the "- parent" list item, so it is a nested
  // copy of the listed title and must fail, naming the source file.
  const indented = `${BASE}\n- parent\n  ## Shared rule\n\nNested copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, indented, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('a standalone heading indented up to three spaces is a top-level section', (t) => {
  // Outside any list item, "   ## Shared rule" is an ordinary top-level heading
  // (CommonMark allows up to three spaces). Both sides are identical, so the
  // listed section is found and the check passes.
  const standalone = [
    '# Fixture rationale',
    '',
    '   ## Shared rule',
    '',
    'The shared rule text.',
    '',
  ].join('\n');
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, standalone, standalone);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a non-breaking space after the hashes does not make a heading', (t) => {
  // "##" followed by a non-breaking space is paragraph text in CommonMark, so
  // the section under "## Shared rule" runs past that line. The drift after it
  // must still fail.
  const nbsp = (after: string) =>
    [
      '# Fixture rationale',
      '',
      '## Shared rule',
      '',
      'The shared rule text.',
      '',
      '##\u00a0Not a heading',
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
    nbsp('After the non-breaking line, source.'),
    nbsp('After the non-breaking line, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared section "Shared rule" differs between/);
});

test('a tab-padded list marker is measured in columns, so a tab-expanded code line is not a heading', (t) => {
  // "-\t\t## Shared rule" pads the marker to seven columns, which is indented
  // code in CommonMark, so it must not count as a nested copy. Both sides carry
  // the same line, so the check passes.
  const tabCode = `${BASE}\n-\t\t## Shared rule\n\nCode, not a heading.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, tabCode, tabCode);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a tab after a list marker is one nested heading column, so it counts as nested', (t) => {
  // "-\t## Shared rule" pads the marker to three columns, which is still a list
  // item in CommonMark, so the source-only copy must fail.
  const tabHeading = `${BASE}\n-\t## Shared rule\n\nListed copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, tabHeading, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('a nested blockquote heading with extra spaces after its markers counts as nested', (t) => {
  // CommonMark lets the markers take extra spaces, so ">  > ## Shared rule" is a
  // nested copy of the listed title in the source and must fail.
  const quoted = `${BASE}\n>  > ## Shared rule\n\nQuoted copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, quoted, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('a shared-section drift prints its own remediation, not the mirror-sync advice', (t) => {
  // sync-docs skips structure pairs, so the remediation must tell the operator to
  // align the file by hand instead of pointing at sync-docs.
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
    /align the listed shared section in both files by hand/,
  );
  assert.doesNotMatch(result.stderr, /sync-docs\.mjs --apply/);
});

test('a bare "##" heading ends a listed section, so prose after it is outside the section', (t) => {
  // A bare "##" is a valid empty heading, so the listed section stops before it.
  // The prose under it is not compared, and drift there must pass.
  const bare = (after: string) =>
    [
      '# Fixture rationale',
      '',
      '## Shared rule',
      '',
      'The shared rule text.',
      '',
      '##',
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
    bare('After the bare heading, source.'),
    bare('After the bare heading, target.'),
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('five spaces after a list marker make indented code, not a nested heading', (t) => {
  // CommonMark reads the fifth space as the start of indented code, so "-     ##
  // Shared rule" is code. It must not count as a nested copy of the listed title.
  const overPadded = `${BASE}\n-     ## Shared rule\n\nCode, not a heading.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, overPadded, overPadded);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a list-like line directly under paragraph text is counted as nested, so the check fails closed', (t) => {
  // "2. ## Shared rule" under paragraph text may be paragraph text in CommonMark,
  // but this scan does not track paragraph state. It is recorded as nested, so
  // the listed title fails loudly rather than letting a real duplicate slip by.
  const underParagraph = `${BASE}\nSome paragraph text\n2. ## Shared rule\n\nMore text.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, underParagraph, underParagraph);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('an ordered marker after a closed fence starts a list, so its nested heading counts', (t) => {
  // A closed fence is not paragraph text, so "2. ## Shared rule" after it can
  // start a list. That nested copy of the listed title must fail, naming the
  // source file.
  const afterFence = `${BASE}\n~~~\ncode\n~~~\n2. ## Shared rule\n\nQuoted copy.\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, afterFence, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});

test('an ordered marker after a thematic break starts a list, so its nested heading counts', (t) => {
  // "***" ends the paragraph above it, so "2. ## Shared rule" on the next line
  // starts a list item in CommonMark. The source-only copy must fail.
  const afterBreak = `${BASE.replace('Prose that differs by design.', 'Prose that differs by design.\n***\n2. ## Shared rule')}\n`;
  const { dir, cleanup } = makeFixture([
    structurePair({ sharedSections: ['Shared rule'] }),
  ]);
  t.after(cleanup);
  seed(dir, afterBreak, BASE);

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `${PAIR_ID}: shared section "Shared rule" appears inside a blockquote or list item in ${SOURCE}`,
    ),
  );
});
