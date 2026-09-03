import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countUncoveredCodeRabbitEmbeddedFindings,
  extractCodeRabbitEmbeddedFindings,
} from '../src/scripts/protocol-helpers.mts';

// Verbatim review bodies captured live for #2197's 30-day sweep, re-cited
// by #2559 as the canonical fixtures for this parser. Both PRs had zero
// coderabbitai[bot]-authored threaded review comments, so both findings
// were genuinely invisible to E1's CHANGES_REQUESTED-only snapshot rule.

// PR #1897, review 4863787336: one Nitpick finding.
const PR_1897_REVIEW_4863787336 = `

<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/scripts/markdown-code.mts (1)</summary><blockquote>

\`399-407\`: _📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _⚡ Quick win_

**Extract the repeated block-start predicate.**

The same four-way test (\`isMarkdownBlockStart\`, \`MARKDOWN_HTML_BLOCK_START_PATTERN\`, \`MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN\`, valid fence opener) now appears three times: here, in \`openingIsParagraph\` (Lines 462-466), and in the main loop (Lines 491-495). A shared helper keeps the three sites in sync when the set of recognized block starts changes.

<details>
<summary>♻️ Proposed helper</summary>

\`\`\`diff
+function startsMarkdownBlock(content: string, raw: string): boolean {
+  return true;
+}
\`\`\`

</details>

<!-- cr-comment:v1:2db3b7119b3fcf0ccf6d0499 -->

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

\`\`\`
Nitpick comments:
In \`@src/scripts/markdown-code.mts\`:
- Around line 399-407: Extract the repeated four-condition block-start check.
\`\`\`

</details>
`;

// PR #1871, review 4860403155: one Outside-diff-range finding, wrapped in
// a "> [!CAUTION]" blockquote prefix on every line (GitHub still renders
// the nested HTML; this parser must tolerate that prefix unchanged, since
// it operates on raw body text, not per-line stripped text).
const PR_1871_REVIEW_4860403155 = `

> [!CAUTION]
> Some comments are outside the diff and can't be posted inline due to platform limitations.
>
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
>
> <details>
> <summary>schemas/pre-merge-readiness.schema.json (1)</summary><blockquote>
>
> \`1057-1073\`: _🗄️ Data Integrity & Integration_ | _🟠 Major_ | _⚡ Quick win_
>
> **Add the activation-nonce reason to the schema.**
>
> \`summarizeClaimValidation\` emits \`activation-nonce-mismatch\` when \`expectedNonce\` is supplied and does not match the trusted active claim winner. Keep the description as-is and add \`activation-nonce-mismatch\` to \`claim.reason.enum\`; otherwise pre-merge readiness output can fail against the schema.
>
> <!-- cr-comment:v1:02fd1e1eb9747e87b84ca74d -->
>
> </blockquote></details>
>
> </blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

\`\`\`
Outside diff comments:
In \`@schemas/pre-merge-readiness.schema.json\`:
- Around line 1057-1073: Update the claim.reason enum.
\`\`\`

</details>
`;

// A newer-format CodeRabbit review: individually threaded comments, no
// "Nitpick comments" / "Outside diff range comments" collapsible section
// at all. Must stay unaffected (#2559's own explicit non-goal).
const NEWER_FORMAT_REVIEW = `**Actionable comments posted: 2**

<details>
<summary>♻️ Duplicate comments (1)</summary>

Some prior-round comment, already threaded individually.

</details>
`;

test('extractCodeRabbitEmbeddedFindings: PR #1897 review 4863787336 -- 1 embedded finding, real fixture body', () => {
  const findings = extractCodeRabbitEmbeddedFindings(PR_1897_REVIEW_4863787336);
  assert.deepEqual(findings, [
    {
      file: 'src/scripts/markdown-code.mts',
      lineRange: '399-407',
      severity: 'Trivial',
      description: 'Extract the repeated block-start predicate.',
    },
  ]);
});

test('extractCodeRabbitEmbeddedFindings: PR #1871 review 4860403155 -- 1 embedded finding under a blockquote-wrapped Outside-diff section, real fixture body', () => {
  const findings = extractCodeRabbitEmbeddedFindings(PR_1871_REVIEW_4860403155);
  assert.deepEqual(findings, [
    {
      file: 'schemas/pre-merge-readiness.schema.json',
      lineRange: '1057-1073',
      severity: 'Major',
      description: 'Add the activation-nonce reason to the schema.',
    },
  ]);
});

test('extractCodeRabbitEmbeddedFindings: a newer-format review (Actionable comments posted, no Nitpick/Outside-diff section) extracts nothing', () => {
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(NEWER_FORMAT_REVIEW), []);
});

test('extractCodeRabbitEmbeddedFindings: multiple files each with their own finding inside one section', () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (2)</summary><blockquote>

<details>
<summary>src/a.mts (1)</summary><blockquote>

\`10-12\`: _cat_ | _🔵 Trivial_ | _eff_

**First finding.**

prose

<!-- cr-comment:v1:aaa -->

</blockquote></details>

<details>
<summary>src/b.mts (1)</summary><blockquote>

\`20\`: _cat_ | _🟡 Minor_ | _eff_

**Second finding.**

prose

<!-- cr-comment:v1:bbb -->

</blockquote></details>

</blockquote></details>
`;
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(body), [
    {
      file: 'src/a.mts',
      lineRange: '10-12',
      severity: 'Trivial',
      description: 'First finding.',
    },
    {
      file: 'src/b.mts',
      lineRange: '20',
      severity: 'Minor',
      description: 'Second finding.',
    },
  ]);
});

// Regression (Copilot review, PR #2563): an extensionless, separator-less
// filename (Dockerfile, Makefile, LICENSE, ...) must not be dropped, and
// the later, unrelated "📒 Files selected for processing (N)" heading
// (which the relaxed file-heading pattern could otherwise also match)
// must stay excluded once the section's own footer bounds the scan.
test('extractCodeRabbitEmbeddedFindings: an extensionless filename (Dockerfile) is not dropped, and the later "Files selected for processing" heading is not mistaken for a file grouping', () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>Dockerfile (1)</summary><blockquote>

\`5\`: _cat_ | _eff_

**A finding in the Dockerfile.**

<!-- cr-comment:v1:aaa -->

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

\`\`\`
Nitpick comments in Dockerfile.
\`\`\`

</details>

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>📒 Files selected for processing (2)</summary>

* Dockerfile
* src/other.mts

</details>

</details>
`;
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(body), [
    {
      file: 'Dockerfile',
      lineRange: '5',
      severity: null,
      description: 'A finding in the Dockerfile.',
    },
  ]);
});

test('extractCodeRabbitEmbeddedFindings: returns [] for a non-string body', () => {
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(null), []);
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(undefined), []);
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(42), []);
});

test('extractCodeRabbitEmbeddedFindings: a finding whose bold title is missing still contributes an entry, with an empty description', () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/a.mts (1)</summary><blockquote>

\`5\`: _cat_ | _eff_

no bold title here, just prose

<!-- cr-comment:v1:ccc -->

</blockquote></details>

</blockquote></details>
`;
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(body), [
    { file: 'src/a.mts', lineRange: '5', severity: null, description: '' },
  ]);
});

// Regression (Copilot review, PR #2563): when a title-less finding is
// followed by another finding that DOES have a bold title, the title-less
// finding must report an empty description of its own -- not "steal" the
// later finding's title by an unbounded search into the rest of the zone.
test("extractCodeRabbitEmbeddedFindings: a title-less finding does not steal a later finding's bold title in the same file grouping", () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (2)</summary><blockquote>

<details>
<summary>src/a.mts (2)</summary><blockquote>

\`10\`: _cat_ | _eff_

no bold title for this first finding

<!-- cr-comment:v1:aaa -->

\`20\`: _cat_ | _eff_

**Second finding title.**

more prose

<!-- cr-comment:v1:bbb -->

</blockquote></details>

</blockquote></details>
`;
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(body), [
    { file: 'src/a.mts', lineRange: '10', severity: null, description: '' },
    {
      file: 'src/a.mts',
      lineRange: '20',
      severity: null,
      description: 'Second finding title.',
    },
  ]);
});

// Regression (Copilot review, PR #2563): a metadata line's own italic
// segments must not absorb a later, separate `_italic_` phrase from the
// finding's prose once a blank line intervenes -- that would corrupt the
// severity/title boundary by treating unrelated prose as more metadata.
test('extractCodeRabbitEmbeddedFindings: a later italic phrase in the finding prose is not absorbed into the metadata segment', () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (1)</summary><blockquote>

<details>
<summary>src/b.mts (1)</summary><blockquote>

\`10\`: _cat_ | _🔵 Trivial_

_Emphasized lead-in prose._ Then the real description follows.

**Real Title Here.**

<!-- cr-comment:v1:ccc -->

</blockquote></details>

</blockquote></details>
`;
  assert.deepEqual(extractCodeRabbitEmbeddedFindings(body), [
    {
      file: 'src/b.mts',
      lineRange: '10',
      severity: 'Trivial',
      description: 'Real Title Here.',
    },
  ]);
});

// --- countUncoveredCodeRabbitEmbeddedFindings ---------------------------

test('countUncoveredCodeRabbitEmbeddedFindings: PR #1897 -- 1 embedded finding, 0 threaded comments -> 1 uncovered', () => {
  assert.equal(
    countUncoveredCodeRabbitEmbeddedFindings(PR_1897_REVIEW_4863787336, 0),
    1,
  );
});

test('countUncoveredCodeRabbitEmbeddedFindings: PR #1871 -- 1 embedded finding, 0 matching coderabbitai[bot] threads -> 1 uncovered', () => {
  assert.equal(
    countUncoveredCodeRabbitEmbeddedFindings(PR_1871_REVIEW_4860403155, 0),
    1,
  );
});

test('countUncoveredCodeRabbitEmbeddedFindings: a newer-format review with matching threads reports 0 uncovered (unaffected)', () => {
  assert.equal(
    countUncoveredCodeRabbitEmbeddedFindings(NEWER_FORMAT_REVIEW, 2),
    0,
  );
});

test('countUncoveredCodeRabbitEmbeddedFindings: N embedded findings with N matching threads reports 0 uncovered (the count comparison, not just presence/absence)', () => {
  const body = `
<details>
<summary>🧹 Nitpick comments (2)</summary><blockquote>

<details>
<summary>src/a.mts (1)</summary><blockquote>

\`10\`: _cat_ | _🔵 Trivial_ | _eff_

**First finding.**

<!-- cr-comment:v1:aaa -->

</blockquote></details>

<details>
<summary>src/b.mts (1)</summary><blockquote>

\`20\`: _cat_ | _🟡 Minor_ | _eff_

**Second finding.**

<!-- cr-comment:v1:bbb -->

</blockquote></details>

</blockquote></details>
`;
  assert.equal(countUncoveredCodeRabbitEmbeddedFindings(body, 2), 0);
  // Fewer threads than findings still reports the gap, not just non-zero.
  assert.equal(countUncoveredCodeRabbitEmbeddedFindings(body, 1), 1);
});
