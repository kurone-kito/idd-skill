import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
  hasGeneratedBannerMarker,
  isAbsenceErrorCode,
  isGeneratedBannerEligible,
  isProseExtension,
  isTolerated,
  normalizeProseWhitespace,
  runVerification,
  stripGeneratedBannerLine,
} from '../src/scripts/verify-import-mirror.mts';
import { fixtureEnv } from './test-utils.mts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(REPO_ROOT, 'scripts', 'verify-import-mirror.mjs');

// ---------------------------------------------------------------------------
// Rule 1 -- generated-banner-only tolerance
// ---------------------------------------------------------------------------

test("stripGeneratedBannerLine strips only the marker line, not the trailing prose (this repo's own real banner shape)", () => {
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
  const stripped = stripGeneratedBannerLine(content, 'idd-generated-from');
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

test('stripGeneratedBannerLine returns content unchanged when the marker is absent', () => {
  const content = '// nothing generated here\nconst x = 1;\n';
  assert.equal(
    stripGeneratedBannerLine(content, 'idd-generated-from'),
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

test('rule 1 fail (Copilot review, PR #3225): an adjacent comment with no blank/bare-// separator must still be compared, not swallowed into the stripped banner', () => {
  // Regression: an earlier version stripped the whole contiguous //
  // paragraph around the marker line, not just the marker line itself --
  // when a genuinely different adjacent comment (no blank line or bare
  // "//" separator between it and the marker line) sat in that same
  // paragraph, both sides collapsed to the same sentinel and a real
  // difference was falsely tolerated.
  const upstream = Buffer.from(
    '// idd-generated-from: a.mts\n// SECURITY: do not disable auth here\nconst x = 1;\n',
  );
  const target = Buffer.from(
    '// idd-generated-from: b.mts\n// SECURITY: disable auth here (malicious)\nconst x = 1;\n',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: ['scripts'],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('stripGeneratedBannerLine strips only the exact marker-bearing line even when immediately adjacent to another comment', () => {
  const content =
    '// idd-generated-from: a.mts\n// SECURITY: do not disable auth here\nconst x = 1;\n';
  assert.equal(
    stripGeneratedBannerLine(content, 'idd-generated-from'),
    '<generated-banner-stripped>\n// SECURITY: do not disable auth here\nconst x = 1;\n',
  );
});

test('hasGeneratedBannerMarker is true only when a //-prefixed line actually contains the marker', () => {
  assert.equal(
    hasGeneratedBannerMarker(
      '// idd-generated-from: a.mts\n',
      'idd-generated-from',
    ),
    true,
  );
  assert.equal(
    hasGeneratedBannerMarker(
      'const x = "idd-generated-from";\n',
      'idd-generated-from',
    ),
    false,
  );
  assert.equal(
    hasGeneratedBannerMarker('const x = 1;\n', 'idd-generated-from'),
    false,
  );
});

test('rule 1 fail (Copilot review, PR #3225): an unmarked side never falsely matches a marked one via the stripped sentinel', () => {
  // Without requiring the marker on BOTH sides, an unmarked upstream
  // (returned unchanged by stripGeneratedBannerLine) could coincidentally
  // equal a marked target's post-strip sentinel form. Constructing the
  // literal coincidence directly proves the both-sides gate, rather than
  // only proving the gate exists.
  const upstream = Buffer.from('<generated-banner-stripped>\nconst x = 1;\n');
  const target = Buffer.from('// idd-generated-from: a.mts\nconst x = 1;\n');
  assert.equal(
    stripGeneratedBannerLine(upstream.toString('utf8'), 'idd-generated-from'),
    stripGeneratedBannerLine(target.toString('utf8'), 'idd-generated-from'),
    'sanity: the two sides really do collapse to the same stripped form',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: ['scripts'],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('rule 1 fail (Copilot review, PR #3225): an unrelated comment merely containing the marker substring is never treated as the banner', () => {
  // Regression: an earlier predicate matched ANY //-prefixed line
  // containing the marker substring anywhere, not the canonical
  // "// idd-generated-from: <path>" syntax specifically -- so an
  // unrelated comment like "// note: idd-generated-from old" was
  // wrongly treated as the banner, and a real edit inside that unrelated
  // comment was silently stripped and tolerated.
  const upstream = Buffer.from(
    '// note: idd-generated-from old\nconst x = 1;\n',
  );
  const target = Buffer.from('// note: idd-generated-from new\nconst x = 1;\n');
  assert.equal(
    hasGeneratedBannerMarker(upstream.toString('utf8'), 'idd-generated-from'),
    false,
    'a non-canonical mention must not count as carrying the banner',
  );
  const result = classifyFileContent({
    path: 'scripts/foo.mjs',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: ['scripts'],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('hasGeneratedBannerMarker and stripGeneratedBannerLine require the canonical "marker:" prefix, not a bare substring match', () => {
  assert.equal(
    hasGeneratedBannerMarker(
      '// idd-generated-from: a.mts\n',
      'idd-generated-from',
    ),
    true,
  );
  assert.equal(
    hasGeneratedBannerMarker(
      '// note: idd-generated-from old\n',
      'idd-generated-from',
    ),
    false,
  );
  const nonCanonical = '// note: idd-generated-from old\nconst x = 1;\n';
  assert.equal(
    stripGeneratedBannerLine(nonCanonical, 'idd-generated-from'),
    nonCanonical,
    'a non-canonical mention must be left completely untouched',
  );
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

test('canonicalizeJson returns null for a non-finite number, never silently canonicalizing it as null (Copilot review, PR #3225)', () => {
  // Regression: JSON.parse silently converts an overflowing number like
  // 1e400 to Infinity, and JSON.stringify re-serializes any non-finite
  // number as the bare token "null" -- so a real value change to a
  // literal null would otherwise canonicalize identically.
  assert.equal(canonicalizeJson('{"x":1e400}'), null);
  assert.equal(canonicalizeJson('{"x":-1e400}'), null);
  assert.equal(canonicalizeJson('[1, 2e400, 3]'), null);
  assert.notEqual(canonicalizeJson('{"x":1}'), null);
});

test('rule 2 fail (Copilot review, PR #3225): a real value change to null never passes via a non-finite-number coincidence', () => {
  const upstream = Buffer.from('{"x":1e400}');
  const target = Buffer.from('{"x":null}');
  // Sanity: both sides really do canonicalize to the same string via the
  // naive JSON.stringify(JSON.parse(x)) approach, proving the fix is
  // load-bearing rather than vacuous.
  assert.equal(
    JSON.stringify(JSON.parse(upstream.toString('utf8'))),
    JSON.stringify(JSON.parse(target.toString('utf8'))),
  );
  const result = classifyFileContent({
    path: 'config/settings.json',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('canonicalizeJson returns null for an integer literal outside the safe-integer range (Copilot review, PR #3225)', () => {
  // Regression: JSON.parse represents every JSON number as an IEEE-754
  // double, which cannot distinguish 9007199254740993 from
  // 9007199254740992 once past Number.MAX_SAFE_INTEGER -- both parse to
  // the same double.
  assert.equal(canonicalizeJson('{"x":9007199254740993}'), null);
  assert.equal(canonicalizeJson('{"x":-9007199254740993}'), null);
  assert.notEqual(canonicalizeJson('{"x":9007199254740991}'), null);
  // A digit sequence inside a STRING value is never numerically parsed,
  // so it carries no precision-loss risk and must not trip this check.
  assert.notEqual(canonicalizeJson('{"x":"9007199254740993"}'), null);
  // A decimal/exponential number is out of this check's scope (finite
  // float precision is a universal IEEE-754 property, not specific to
  // this rule) -- only a BARE integer literal (no "." or "e"/"E") is
  // checked.
  assert.notEqual(canonicalizeJson('{"x":9007199254740993.0}'), null);
});

test('rule 2 fail (Copilot review, PR #3225): a real value change at the unsafe-integer boundary never passes via a precision-loss coincidence', () => {
  const upstream = Buffer.from('{"x":9007199254740993}');
  const target = Buffer.from('{"x":9007199254740992}');
  // Sanity: both sides really do canonicalize to the same string via the
  // naive JSON.stringify(JSON.parse(x)) approach.
  assert.equal(
    JSON.stringify(JSON.parse(upstream.toString('utf8'))),
    JSON.stringify(JSON.parse(target.toString('utf8'))),
  );
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

test('normalizeProseWhitespace recognizes a blank line carrying trailing whitespace as a real paragraph break (Copilot review, PR #3225)', () => {
  // Regression: a naive /\n{2,}/ split never matches "first\n  \nsecond"
  // (the two newlines are separated by whitespace, not adjacent), so an
  // earlier version silently merged this into ONE paragraph -- meaning a
  // real paragraph break using this (CommonMark-legal) blank-line shape
  // could be removed entirely without ever being caught as a mismatch.
  const whitespaceOnlyBlankLine = 'first\n  \nsecond\n';
  const trueBlankLine = 'first\n\nsecond\n';
  assert.equal(
    normalizeProseWhitespace(whitespaceOnlyBlankLine),
    normalizeProseWhitespace(trueBlankLine),
    'a whitespace-only blank line should normalize the same as a bare one',
  );
  const merged = 'first\nsecond\n';
  assert.notEqual(
    normalizeProseWhitespace(whitespaceOnlyBlankLine),
    normalizeProseWhitespace(merged),
    'removing that whitespace-only-blank-line paragraph break must still be rejected',
  );
});

test('rule 3 fail (Copilot review, PR #3225): a removed whitespace-only-blank-line paragraph break is a genuine mismatch, not a tolerated reflow', () => {
  const upstream = Buffer.from('first\n  \nsecond\n');
  const target = Buffer.from('first\nsecond\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
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

test('rule 3 fail (Copilot review, PR #3225): a real content edit hidden inside a fenced code block is never tolerated as reflow', () => {
  const upstream = Buffer.from(
    'Some prose.\n\n```\na\nb\n```\n\nMore prose.\n',
  );
  const target = Buffer.from('Some prose.\n\n```\na b\n```\n\nMore prose.\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('rule 3 pass (Copilot review, PR #3225): prose outside a fenced code block is still reflow-tolerant', () => {
  const upstream = Buffer.from('one two\nthree four\n\n```\nunchanged\n```\n');
  const target = Buffer.from('one two three\nfour\n\n```\nunchanged\n```\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'prose-reflow-match');
});

test('normalizeProseWhitespace compares a fenced code block verbatim, never reflow-tolerant', () => {
  const upstream = 'Some prose.\n\n```\na\nb\n```\n\nMore prose.\n';
  const target = 'Some prose.\n\n```\na b\n```\n\nMore prose.\n';
  assert.notEqual(
    normalizeProseWhitespace(upstream),
    normalizeProseWhitespace(target),
  );
});

test('normalizeProseWhitespace supports ~~~ fences too, not only backtick fences', () => {
  const upstream = 'text\n\n~~~\na\nb\n~~~\n';
  const target = 'text\n\n~~~\na b\n~~~\n';
  assert.notEqual(
    normalizeProseWhitespace(upstream),
    normalizeProseWhitespace(target),
  );
});

test('normalizeProseWhitespace compares an inline code span verbatim, never reflow-tolerant (Copilot review, PR #3225)', () => {
  // Regression: an earlier version only masked FENCED code blocks, so a
  // real edit hidden inside a backtick-delimited inline code span (whose
  // own content can legally wrap across one line, per CommonMark) still
  // passed as a tolerated reflow.
  const upstream = 'Run `foo\nbar`\n';
  const target = 'Run `foo bar`\n';
  assert.notEqual(
    normalizeProseWhitespace(upstream),
    normalizeProseWhitespace(target),
  );
});

test('rule 3 fail (Copilot review, PR #3225): a real edit inside an inline code span is a genuine mismatch, not a tolerated reflow', () => {
  const upstream = Buffer.from('Run `foo\nbar`\n');
  const target = Buffer.from('Run `foo bar`\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
    upstreamContent: upstream,
    targetContent: target,
    generatedDirs: [],
  });
  assert.equal(result.contentClass, 'content-mismatch');
});

test('normalizeProseWhitespace does not let a 4-space-indented line falsely close a fence (CommonMark rejects it as a fence marker) (Copilot review, PR #3225)', () => {
  // Regression: an earlier version's fence-detection regex allowed any
  // leading whitespace (\s*) before the fence marker, with no CommonMark
  // indentation limit -- so a 4-space-indented "```" line (itself
  // ordinary CODE CONTENT inside the fence, per CommonMark's 3-space
  // limit on fence markers) was misread as a real closer, reclassifying
  // everything after it as reflow-tolerant prose instead of the fenced
  // code it actually is.
  const upstream = '```\n    ```\nreal code A\nmore\n```\n';
  const target = '```\n    ```\nreal code B changed\nmore\n```\n';
  assert.notEqual(
    normalizeProseWhitespace(upstream),
    normalizeProseWhitespace(target),
  );
});

test('rule 3 fail (Copilot review, PR #3225): code hidden after a false 4-space-indented fence-close is a genuine mismatch, not a tolerated reflow', () => {
  const upstream = Buffer.from('```\n    ```\nreal code A\nmore\n```\n');
  const target = Buffer.from('```\n    ```\nreal code B changed\nmore\n```\n');
  const result = classifyFileContent({
    path: 'docs/readme.md',
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

test('isAbsenceErrorCode (Copilot review, PR #3225): only ENOENT/ENOTDIR count as genuine absence', () => {
  // Regression: an earlier version treated ANY lstat failure (e.g. EACCES
  // on a path mid-deletion) as proof the path is absent, which would let
  // an unverifiable deletion pass as deletion-matches-upstream instead of
  // failing closed.
  assert.equal(isAbsenceErrorCode('ENOENT'), true);
  assert.equal(isAbsenceErrorCode('ENOTDIR'), true);
  assert.equal(isAbsenceErrorCode('EACCES'), false);
  assert.equal(isAbsenceErrorCode('EPERM'), false);
  assert.equal(isAbsenceErrorCode('EIO'), false);
  assert.equal(isAbsenceErrorCode(undefined), false);
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
  env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    ...(env === undefined ? {} : { env }),
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

test('rule 4 CLI end-to-end: --upstream-path resolves mode from a real git work tree, not just fs bits', {
  skip: process.platform === 'win32',
}, () => {
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

test('CLI end-to-end: --upstream-path nested inside a larger enclosing git repo reads the SUPPLIED directory, not the enclosing repository (Copilot review, PR #3225)', () => {
  // Regression: git ls-tree resolves its pathspec relative to cwd, but
  // `git show <rev>:<path>` is ALWAYS relative to the repository ROOT
  // regardless of cwd -- verified empirically: from a nested/ cwd inside
  // a larger repo, `git ls-tree HEAD -- marker.txt` correctly resolves to
  // nested/marker.txt, but `git show HEAD:marker.txt` reads the ROOT-level
  // marker.txt instead. An earlier version's `--is-inside-work-tree`
  // probe couldn't distinguish "upstreamPath is the repo root" from
  // "upstreamPath is merely SOMEWHERE inside one", so pointing
  // --upstream-path at a nested (non-root) directory could silently read
  // an unrelated file from the enclosing repository's root.
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const outerRoot = mkdtempSync(join(tmpdir(), 'verify-import-mirror-outer-'));
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    writeFileSync(join(targetRoot, 'marker.txt'), 'nested content\n');
    commitAll(targetRoot, 'chore: vendor import of marker.txt');

    // outerRoot is a git repo whose ROOT tracks a DIFFERENT marker.txt
    // than the one under its nested/ subdirectory -- upstreamRoot below
    // points at that nested/ subdirectory, never at outerRoot itself.
    initTargetRepo(outerRoot);
    mkdirSync(join(outerRoot, 'nested'), { recursive: true });
    writeFileSync(join(outerRoot, 'nested', 'marker.txt'), 'nested content\n');
    writeFileSync(
      join(outerRoot, 'marker.txt'),
      'root decoy content, DIFFERENT from nested\n',
    );
    commitAll(outerRoot, 'chore: outer repo with a nested marker.txt');

    const upstreamRoot = join(outerRoot, 'nested');
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
      `expected exit 0 (the nested file's own real content, not the enclosing repo's root-level decoy), got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { path: string; status: string }[];
    };
    assert.deepEqual(report.results, [
      { path: 'marker.txt', changeType: 'A', status: 'exact' },
    ]);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outerRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a HEAD-tracked but sparse-checkout-omitted upstream file is read from the object database, not misread as absent (Copilot review, PR #3225)', () => {
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
    // The import commit DELETES a previously-vendored file -- this is
    // only a legitimate deletion-matches-upstream if upstream genuinely
    // still lacks it, not merely because it isn't materialized on disk.
    writeFileSync(join(targetRoot, 'vendored.txt'), 'to be removed\n');
    commitAll(targetRoot, 'chore: add vendored.txt (pre-import baseline)');
    rmSync(join(targetRoot, 'vendored.txt'));
    commitAll(targetRoot, 'chore: vendor import removes vendored.txt');

    // Upstream is a real git work tree whose HEAD still tracks
    // vendored.txt, but the working-tree copy is missing -- simulating a
    // sparse checkout (or any other reason a tracked file might be absent
    // from disk while still present in HEAD's own tree).
    initTargetRepo(upstreamRoot);
    writeFileSync(
      join(upstreamRoot, 'vendored.txt'),
      'still tracked upstream\n',
    );
    commitAll(upstreamRoot, 'chore: upstream still has vendored.txt');
    rmSync(join(upstreamRoot, 'vendored.txt'));

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
      `expected exit 1 (upstream HEAD still has the file; this must not be a matching deletion), got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { status: string }[];
    };
    assert.deepEqual(
      report.results.map((r) => r.status),
      ['content-mismatch'],
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a real symlink in --upstream-path is compared as a git entry, not followed (Copilot review, PR #3225)', {
  skip: process.platform === 'win32',
}, () => {
  // Creating a symlink needs elevated privilege or Developer Mode on
  // Windows, which CI cannot assume -- matches this repo's established
  // guard idiom for symlink-creating fixtures (e.g.
  // verify-install-deps.test.mts).
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

    // Upstream is a plain (non-git) checkout directory containing a real
    // symlink -- readFileSync/statSync would otherwise follow it, reading
    // the WRONG content/mode instead of the link's own git-tracked blob
    // (the link target text) and mode (120000).
    writeFileSync(join(upstreamRoot, 'real.sh'), '#!/bin/sh\necho hi\n');
    symlinkSync('./real.sh', join(upstreamRoot, 'link.sh'));

    // Target vendors the SAME symlink (same link target text), tracked
    // by git as a genuine symlink entry.
    writeFileSync(join(targetRoot, 'real.sh'), '#!/bin/sh\necho hi\n');
    symlinkSync('./real.sh', join(targetRoot, 'link.sh'));
    commitAll(targetRoot, 'chore: vendor import of a symlink');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamRoot,
        '--path-prefix',
        'link.sh',
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
      results: { path: string; status: string }[];
    };
    assert.deepEqual(report.results, [
      { path: 'link.sh', changeType: 'A', status: 'exact' },
    ]);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a symlinked ANCESTOR directory under --upstream-path is refused, not silently followed (Copilot review, PR #3225)', {
  skip: process.platform === 'win32',
}, () => {
  // Creating a symlink needs elevated privilege or Developer Mode on
  // Windows, which CI cannot assume -- matches this repo's established
  // guard idiom for symlink-creating fixtures.
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  const outsideRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-outside-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');

    // upstreamRoot/vendor is a symlink pointing OUTSIDE upstreamRoot
    // entirely -- lstat on the final path component (vendor/file.txt)
    // never reports this, since only the ancestor segment (vendor) is
    // itself the symlink.
    writeFileSync(join(outsideRoot, 'file.txt'), 'external content\n');
    symlinkSync(outsideRoot, join(upstreamRoot, 'vendor'));

    mkdirSync(join(targetRoot, 'vendor'), { recursive: true });
    writeFileSync(join(targetRoot, 'vendor', 'file.txt'), 'vendored content\n');
    commitAll(
      targetRoot,
      'chore: vendor import under a directory named vendor',
    );

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
      2,
      `expected exit 2 (refused, not silently followed), got ${result.status}: ${result.stderr}`,
    );
    assert.match(result.stderr, /symlink/i);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a missing --upstream-path is rejected up front, not misread as "upstream lacks every file" (Copilot review, PR #3225)', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'a.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    writeFileSync(join(targetRoot, 'b.txt'), 'deleted later\n');
    commitAll(targetRoot, 'chore: add b.txt');
    rmSync(join(targetRoot, 'b.txt'));
    commitAll(
      targetRoot,
      'chore: vendor import deletes b.txt (this is the commit under test)',
    );

    const missingUpstream = join(
      tmpdir(),
      'verify-import-mirror-nonexistent-typo',
    );
    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        missingUpstream,
        '--format',
        'json',
      ],
      targetRoot,
    );
    // Without validateUpstreamPathRoot, this would silently misclassify
    // the b.txt deletion as deletion-matches-upstream and exit 0 -- a
    // false proof of a pure mirror caused by nothing more than the typo
    // above.
    assert.equal(
      result.status,
      2,
      `expected exit 2 (a typo'd --upstream-path must never silently pass), got ${result.status}: ${result.stderr}`,
    );
    assert.match(result.stderr, /--upstream-path does not exist/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a --upstream-path that is not a directory is rejected up front (Copilot review, PR #3225)', () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const notADirectory = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-file-'),
  );
  const upstreamFile = join(notADirectory, 'upstream-is-a-file.txt');
  writeFileSync(upstreamFile, 'not a directory\n');
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'a.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    writeFileSync(join(targetRoot, 'b.txt'), 'vendored\n');
    commitAll(targetRoot, 'chore: vendor import');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-path',
        upstreamFile,
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}: ${result.stderr}`,
    );
    assert.match(result.stderr, /--upstream-path is not a directory/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(notADirectory, { recursive: true, force: true });
  }
});

test('CLI end-to-end: a tracked type change (T status, regular file -> symlink) is compared, not silently discarded (Copilot review, PR #3225)', {
  skip: process.platform === 'win32',
}, () => {
  // Creating a symlink needs elevated privilege or Developer Mode on
  // Windows, which CI cannot assume -- matches this repo's established
  // guard idiom for symlink-creating fixtures.
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'real.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(targetRoot, 'vendored.sh'), '#!/bin/sh\necho hi\n');
    commitAll(targetRoot, 'chore: baseline with vendored.sh as a regular file');

    // Upstream still has vendored.sh as an ordinary regular file --
    // never converted to a symlink.
    writeFileSync(join(upstreamRoot, 'real.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(upstreamRoot, 'vendored.sh'), '#!/bin/sh\necho hi\n');

    // The import commit converts vendored.sh from a regular file into a
    // symlink (a tracked type change, git status "T") -- diverging from
    // upstream, which must still be caught, not silently skipped.
    rmSync(join(targetRoot, 'vendored.sh'));
    symlinkSync('./real.sh', join(targetRoot, 'vendored.sh'));
    commitAll(
      targetRoot,
      'chore: vendor import turns vendored.sh into a symlink',
    );

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
      results: { path: string; changeType: string; status: string }[];
    };
    const vendoredResult = report.results.find((r) => r.path === 'vendored.sh');
    assert.ok(
      vendoredResult !== undefined,
      'the T-status change to vendored.sh must appear in the report, not be silently discarded',
    );
    assert.equal(vendoredResult?.changeType, 'M');
    assert.equal(vendoredResult?.status, 'content-mismatch');
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

test("CLI end-to-end: a typo'd --upstream-ref is rejected up front, not misread via an empty scoped diff (Copilot review, PR #3225)", () => {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'a.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    // The import commit only touches a path OUTSIDE the --path-prefix
    // scope used below, so the scoped diff is empty -- without
    // validateUpstreamRef, readUpstreamEntry is never even called (it
    // only runs inside the per-changed-path loop), so a typo'd ref would
    // silently report "0 files compared" and exit 0.
    writeFileSync(join(targetRoot, 'unrelated.txt'), 'not under vendor/\n');
    commitAll(targetRoot, 'chore: vendor import (outside the scoped prefix)');

    const result = runCli(
      [
        '--target-root',
        targetRoot,
        '--upstream-ref',
        'this-ref-does-not-exist',
        '--path-prefix',
        'vendor',
        '--format',
        'json',
      ],
      targetRoot,
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2 (a typo'd --upstream-ref must never silently pass), got ${result.status}: ${result.stderr}`,
    );
    assert.match(result.stderr, /--upstream-ref does not resolve to a commit/);
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

test('CLI end-to-end: an inherited GIT_DIR/GIT_WORK_TREE from a calling hook never redirects the check onto the wrong repository (Copilot review, PR #3225)', () => {
  // Regression: without a sanitized subprocess environment, git's own
  // ambient overrides (GIT_DIR/GIT_WORK_TREE take precedence over normal
  // cwd-based discovery) would silently redirect every git call in this
  // file onto whatever repository a calling hook or wrapper happened to
  // have configured -- producing a proof about the WRONG repository, or
  // (as constructed here) an outright failure against a decoy repo that
  // doesn't even share the same commit history.
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-target-'),
  );
  const upstreamRoot = mkdtempSync(
    join(tmpdir(), 'verify-import-mirror-upstream-'),
  );
  const decoyRoot = mkdtempSync(join(tmpdir(), 'verify-import-mirror-decoy-'));
  try {
    initTargetRepo(targetRoot);
    writeFileSync(join(targetRoot, 'baseline.txt'), 'hello\n');
    commitAll(targetRoot, 'chore: baseline');
    writeFileSync(join(targetRoot, 'new.txt'), 'vendored content\n');
    commitAll(targetRoot, 'chore: vendor import');

    writeFileSync(join(upstreamRoot, 'new.txt'), 'vendored content\n');

    // The decoy has only ONE commit -- no HEAD^ -- so if GIT_DIR/
    // GIT_WORK_TREE leak through, the diff command fails outright rather
    // than silently returning plausible-looking wrong results, making the
    // leak unambiguous either way.
    initTargetRepo(decoyRoot);
    writeFileSync(join(decoyRoot, 'decoy.txt'), 'unrelated repository\n');
    commitAll(decoyRoot, 'chore: decoy single commit');

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
      {
        ...process.env,
        GIT_DIR: join(decoyRoot, '.git'),
        GIT_WORK_TREE: decoyRoot,
      },
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0 (targetRoot's own history, unaffected by the inherited decoy GIT_DIR/GIT_WORK_TREE), got ${result.status}: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout) as {
      results: { path: string; changeType: string; status: string }[];
    };
    assert.deepEqual(report.results, [
      { path: 'new.txt', changeType: 'A', status: 'exact' },
    ]);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
    rmSync(decoyRoot, { recursive: true, force: true });
  }
});
