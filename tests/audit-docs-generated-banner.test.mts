import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectGeneratedSourceBannerViolations } from '../src/scripts/consistency-helpers.mts';

// Regression coverage for #3294: checkGeneratedSourcePairs's forward
// direction (src/scripts/audit-docs.mts) used to check only that a
// src/scripts/**/*.mts source has its generated .mjs artifact committed --
// never that either file actually carries the `// idd-generated-from: ...`
// provenance banner. A source with no banner at all (the shipped
// src/scripts/provider-health.mts / scripts/provider-health.mjs pair, since
// #2319's landing commit 9cbf6d11) silently escaped that guard, and also
// escaped every banner-derived check downstream (the .gitattributes
// linguist-generated block, tests/inventory-ordering.test.mts's
// completeness assertion), because each of those derives its own file set
// from the banner rather than independently verifying it is present.
//
// collectGeneratedSourceBannerViolations is the pure predicate
// checkGeneratedSourcePairs now calls for every source/emitted pair; unit
// testing it directly proves the audit's new requirement without spinning
// up a fixture git repository (`checkGeneratedSourcePairs` itself is not
// exported -- audit-docs.mts is a CLI entrypoint whose internal check*
// functions run only via `node scripts/audit-docs.mjs --check`, see the
// same rationale in tests/audit-docs-file-sets.test.mts).

const SOURCE = 'src/scripts/example.mts';
const EMITTED = 'scripts/example.mjs';
const SCAN_BYTES = 200;

function wellFormedBanner(path: string): string {
  return `// idd-generated-from: ${path}\n//\n// filler body\n`;
}

test('collectGeneratedSourceBannerViolations: passes when both files carry a well-formed banner', () => {
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    wellFormedBanner(SOURCE),
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.deepEqual(violations, []);
});

test('collectGeneratedSourceBannerViolations: reports a missing banner on the source, with source-side remediation', () => {
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    '// Read-only, cross-pull-request provider-health classifier.\n',
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${SOURCE}: missing`));
  // `pnpm run build` only recompiles a source's existing content -- it never
  // synthesizes a banner that was never in the .mts source to begin with,
  // so the source-side message must not recommend that remediation.
  assert.doesNotMatch(violations[0], /pnpm run build/);
  assert.match(violations[0], /docs\/typescript-sources\.md/);
});

test('collectGeneratedSourceBannerViolations: reports a missing banner on the emitted artifact, with a rebuild remediation', () => {
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    wellFormedBanner(SOURCE),
    EMITTED,
    '// Read-only, cross-pull-request provider-health classifier.\n',
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${EMITTED}: missing`));
  assert.match(violations[0], /pnpm run build/);
});

test('collectGeneratedSourceBannerViolations: reports both files missing a banner independently', () => {
  const noBanner = '// no banner here at all\n';
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    noBanner,
    EMITTED,
    noBanner,
    SCAN_BYTES,
  );
  assert.equal(violations.length, 2);
  assert.ok(violations.some((v) => v.startsWith(`${SOURCE}: missing`)));
  assert.ok(violations.some((v) => v.startsWith(`${EMITTED}: missing`)));
});

test('collectGeneratedSourceBannerViolations: reports a source banner naming the wrong source', () => {
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    wellFormedBanner('src/scripts/other.mts'),
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.equal(
    violations[0],
    `${SOURCE}: generated-from banner names src/scripts/other.mts, expected ${SOURCE}`,
  );
});

test('collectGeneratedSourceBannerViolations: reports an emitted banner naming the wrong source', () => {
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    wellFormedBanner(SOURCE),
    EMITTED,
    wellFormedBanner('src/scripts/other.mts'),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.equal(
    violations[0],
    `${EMITTED}: generated-from banner names src/scripts/other.mts, expected ${SOURCE}`,
  );
});

test('collectGeneratedSourceBannerViolations: a banner past the byte window reads as missing', () => {
  const padding = '// x'.repeat(60); // well past SCAN_BYTES (200)
  const pushedOut = `${padding}\n${wellFormedBanner(SOURCE)}`;
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    pushedOut,
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${SOURCE}: missing`));
});

// Review findings on #3294's own PR (kurone-kito/idd-skill#3333): the
// separator regex accepted a banner split across two lines, and the byte
// window was measured in UTF-16 code units rather than UTF-8 bytes.

test('collectGeneratedSourceBannerViolations: a banner split across two lines reads as missing', () => {
  // The path lands on the line *after* the "idd-generated-from:" opener --
  // not a well-formed single-line banner, even though a permissive `\s*`
  // separator would previously have matched across the line break.
  const splitAcrossLines = `// idd-generated-from:\n${SOURCE}\n`;
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    splitAcrossLines,
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${SOURCE}: missing`));
});

test('collectGeneratedSourceBannerViolations: a multibyte prefix that pushes the banner past the true byte window reads as missing', () => {
  // 150 'é' characters are 150 UTF-16 code units but 300 UTF-8 bytes, so a
  // naive `text.slice(0, 200)` (code-unit based) would still include the
  // banner below even though it starts well past byte 200.
  const multibytePrefix = 'é'.repeat(150);
  const pushedOutByBytes = `${multibytePrefix}\n${wellFormedBanner(SOURCE)}`;
  assert.ok(
    Buffer.byteLength(multibytePrefix, 'utf8') > SCAN_BYTES,
    'test fixture must actually exceed the byte window',
  );
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    pushedOutByBytes,
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${SOURCE}: missing`));
});

test('collectGeneratedSourceBannerViolations: a multibyte prefix that still leaves the banner inside the byte window passes', () => {
  // 10 'é' characters are 10 UTF-16 code units but only 20 UTF-8 bytes --
  // nowhere near SCAN_BYTES (200) either way, so the banner right after it
  // must still validate.
  const shortMultibytePrefix = 'é'.repeat(10);
  const stillInWindow = `// ${shortMultibytePrefix}\n${wellFormedBanner(SOURCE)}`;
  const violations = collectGeneratedSourceBannerViolations(
    SOURCE,
    stillInWindow,
    EMITTED,
    wellFormedBanner(SOURCE),
    SCAN_BYTES,
  );
  assert.deepEqual(violations, []);
});
