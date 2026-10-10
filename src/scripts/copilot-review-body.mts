// idd-generated-from: src/scripts/copilot-review-body.mts
//
// The scripts/copilot-review-body.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// kurone-kito/idd-skill#3258: shared "what shape is this Copilot review
// body, and how many thread-less findings does it carry" classifier.
// Extracted into its own leaf module -- importing only
// `markdown-code.mts` (which itself has no imports) -- so `review-clause.mts`
// (which already imports `protocol-helpers.mts`) can import this module
// without creating a cycle, and so `protocol-helpers.mts` can import FROM
// this module (see the `isCopilotErrorReviewBody` re-export below) instead
// of the other way around.
//
// Background (#1880, #3015, #3223): GitHub Copilot can report a
// thread-less finding two different ways depending on when the review was
// generated, and neither the pre-2026-09-19 legacy overview nor the
// current `ccr-overview-v2` shape was recognized by the original
// `SUPPRESSED_COMMENTS_HEADING_PATTERN` (the August `<summary>Suppressed
// comments (N)</summary>` form only). See this module's own callers'
// doc comments (`resolveLatestCopilotReviewClause`, review-clause.mts) for
// the full incident history.

import {
  maskMarkdownForScan,
  stripMarkdownCodeRegions,
} from './markdown-code.mts';

/**
 * Recognized Copilot review-body shapes (#3258). `overview-v2` is the
 * current (since 2026-09-19) `<!-- ccr-overview-v2 -->`-marked shape;
 * `overview-legacy` is the pre-2026-09-19 shape (and the original,
 * even-older bare August `<summary>Suppressed comments (N)</summary>`
 * form); `error` is Copilot's exact "encountered an error" template
 * (#3015); `unrecognized` is anything else, including an absent/empty
 * body.
 */
export type CopilotReviewBodyShape =
  | 'overview-v2'
  | 'overview-legacy'
  | 'error'
  | 'unrecognized';

/** Classifier output: the recognized shape plus the thread-less finding
 * count that shape's own heading/summary carries (`0` when the shape is
 * recognized but carries no such section, or when the shape is `error` /
 * `unrecognized`, where no count can be trusted). */
export interface CopilotReviewBodyClassification {
  shape: CopilotReviewBodyShape;
  suppressedCount: number;
}

// -----------------------------------------------------------------------
// `isCopilotErrorReviewBody` (moved here from protocol-helpers.mts, #3258)
// -----------------------------------------------------------------------

/**
 * #3015: GitHub Copilot's "encountered an error" review body, observed live
 * on PR `#3013` (issue `#2986`, commit `46bfb73b`,
 * <https://github.com/kurone-kito/idd-skill/pull/3013#pullrequestreview-5212307067>,
 * `copilot-pull-request-reviewer[bot]`, `COMMENTED`, submitted
 * 2026-09-15T15:44:53Z): Copilot failed to review the PR at all, yet the
 * review still carries `comments.totalCount` (`itemCount`) `0`, the same
 * shape a genuine "no findings" empty review has. Without this check, that
 * false-empty review both satisfies `resolveLatestCopilotReviewClause`'s
 * Clause 1 (review-clause.mts) and wins `findLastCopilotReviewCommit`'s
 * `LAST_COPILOT_COMMIT == PR_HEAD_SHA` short-circuit (protocol-helpers.mts),
 * even though Copilot never actually looked at the diff -- the same
 * `itemCount === 0` false-empty class {@link classifyCopilotReviewBody}
 * (#1880) already closed for the sibling "Suppressed comments (N)" shape.
 *
 * Matched by whole-body equality (after trimming and collapsing internal
 * whitespace, case-insensitively) against the exact observed template,
 * never a broad "error" substring search: this keeps the classifier
 * fail-closed toward under-matching, in the same spirit as
 * `isAdvisoryNonReviewNotice`, and -- unlike that function's substring/
 * heading search -- whole-body equality alone already excludes an advisory
 * bot quoting this exact sentence back in a larger review body (the
 * prose-quoting false-positive class `#1614` first found), with no need
 * for a separate code-region-stripping step: any additional content in the
 * body (the bot's own commentary around the quote) already breaks the
 * equality match. Deliberately run against the RAW, unstripped body (never
 * `stripMarkdownCodeRegions`'d) to keep this check byte-identical to its
 * pre-#3258 behavior.
 */
const COPILOT_ERROR_REVIEW_BODY =
  'copilot encountered an error and was unable to review this pull ' +
  'request. you can try again by re-requesting a review.';

/**
 * `true` when `body` is GitHub Copilot's exact "encountered an error"
 * review-body template (#3015) -- see {@link COPILOT_ERROR_REVIEW_BODY}'s
 * doc comment for the observed incident and matching rationale. Reused by
 * `findLastCopilotReviewCommit` (protocol-helpers.mts, via the façade
 * re-export there) and by `resolveLatestCopilotReviewClause`
 * (review-clause.mts) so both "latest covering review" selectors skip this
 * review the same way, mirroring how both already share
 * `isCopilotReviewerLogin`.
 */
export function isCopilotErrorReviewBody(body: unknown): boolean {
  const normalized = String(body ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return normalized === COPILOT_ERROR_REVIEW_BODY;
}

// -----------------------------------------------------------------------
// Shape classification (#3258)
// -----------------------------------------------------------------------

/** Anchored to the CODE-STRIPPED body's own START (not "appears anywhere")
 * -- both real observed v2 bodies (PR #3196 review `5288008196`, PR #3174
 * review `5269880575`) open with this exact line, and anchoring to the
 * start keeps a future Copilot review of THIS repository's own diff (which
 * necessarily discusses this literal marker string in prose, comments, and
 * test fixtures) from self-misclassifying as v2 -- the same prose-quoting
 * defense class `#1614`/`#1884` already established for the legacy
 * `<summary>Suppressed comments (N)</summary>` heading. */
const V2_MARKER_PATTERN = /^<!--\s*ccr-overview-v2\s*-->/i;

/** Matches `<summary><strong>Previously missed (N)</strong></summary>`,
 * tolerating an absent `<strong>` wrapper. Deliberately does NOT match
 * "Resolved since last review (N)" (PR #3174's real body has both
 * sections, with different counts -- only Open/Resolved-since-last-review
 * items link an existing `#discussion_r…` thread that Clause 2 already
 * covers; only "Previously missed" is genuinely thread-less) or the
 * `**Findings:**` header line. */
const V2_PREVIOUSLY_MISSED_PATTERN =
  /<summary>\s*(?:<strong>\s*)?previously missed \((\d+)\)(?:\s*<\/strong>)?\s*<\/summary>/i;

/** "Opens with" -- checked against the code-stripped body's own trimmed
 * start, mirroring {@link V2_MARKER_PATTERN}. */
const LEGACY_OVERVIEW_OPEN_PATTERN = /^##\s*pull request overview/i;

/** Matches PR #3095's and PR #3108's real bodies: a `<details>` block
 * immediately summarized "Review details" or "Pull request overview" --
 * distinctive real GitHub-rendered markup, not anchored to body start
 * since it can appear after other overview prose. */
const LEGACY_DETAILS_SUMMARY_PATTERN =
  /<details>\s*<summary>\s*(?:review details|pull request overview)\s*<\/summary>/i;

/** ATX heading at (near-)line-start, CommonMark-style (up to 3 leading
 * spaces/tabs before `###`), multiline since it appears mid-body. A
 * `**Previously missed (N)**` bold line nested under this heading (PR
 * #3108's real body) is deliberately never separately matched/added --
 * it is already part of this heading's own count.
 *
 * #3390 review (this PR's own Copilot review): deliberately NOT used as
 * an independent `overview-legacy` shape signal (see the `isLegacyOverview`
 * check below) -- ordinary Markdown text, unlike the `<details>`/
 * `<summary>` tag pairs the other legacy signals anchor to, so a review
 * merely discussing this exact heading in prose (with no code span) could
 * otherwise self-misclassify as a real legacy finding. Only used to
 * extract the count once one of the other signals already confirms the
 * shape. */
const LEGACY_SUPPRESSED_HEADING_PATTERN =
  /^[ \t]{0,3}###\s*suppressed comments \((\d+)\)/im;

/** The original, even-older bare August form (kurone-kito/idd-skill#1880's
 * own `SUPPRESSED_COMMENTS_HEADING_PATTERN`, unchanged): anchored to the
 * literal `<summary>`/`</summary>` tag pair, which is real GitHub-rendered
 * markup a prose mention cannot produce (#1614). Kept as an INDEPENDENT
 * legacy-shape signal (not gated on the overview-wrapper checks above)
 * because the existing, unmodified `SUPPRESSED_COMMENTS_BODY` regression
 * fixture (tests/advisory-convergence.test.mts, #1880/#1884) is a bare
 * `<details><summary>Suppressed comments (1)</summary>…</details>` with no
 * overview wrapper at all, and the acceptance criteria for #3258 require
 * that fixture's existing assertions to keep passing unmodified. */
const AUGUST_SUPPRESSED_SUMMARY_PATTERN =
  /<summary>\s*suppressed comments \((\d+)\)\s*<\/summary>/i;

function toCount(raw: string | undefined): number {
  const count = Number(raw);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Classify a Copilot review body into one of the recognized shapes and
 * extract the thread-less ("suppressed") finding count that shape's own
 * heading/summary carries (kurone-kito/idd-skill#3258). Strips fenced/
 * inline Markdown code regions (`stripMarkdownCodeRegions`, per #1884)
 * before any shape/count match, so a body that merely QUOTES one of these
 * patterns inside backticks or a fenced block is never mistaken for the
 * real thing -- except the `error` check, which runs against the RAW body
 * to stay byte-identical to the pre-#3258 `isCopilotErrorReviewBody`
 * behavior (whole-body equality already excludes prose-quoting on its
 * own, per that function's own doc comment).
 *
 * `error` is reachable here in principle (a general-purpose caller, e.g. a
 * future merged-PR feedback sweep, may classify an arbitrary review body
 * directly), but `resolveLatestCopilotReviewClause` (review-clause.mts)
 * never lets an error-bodied review become the selected "latest" one in
 * the first place -- its own pre-filter already excludes it, unchanged --
 * so `bodyShape: 'error'` never appears on that function's own output.
 */
export function classifyCopilotReviewBody(
  body: string | null | undefined,
): CopilotReviewBodyClassification {
  if (typeof body !== 'string' || body.length === 0) {
    return { shape: 'unrecognized', suppressedCount: 0 };
  }
  if (isCopilotErrorReviewBody(body)) {
    return { shape: 'error', suppressedCount: 0 };
  }
  const stripped = stripMarkdownCodeRegions(body);
  const trimmedStart = stripped.trimStart();
  if (V2_MARKER_PATTERN.test(trimmedStart)) {
    const match = stripped.match(V2_PREVIOUSLY_MISSED_PATTERN);
    return {
      shape: 'overview-v2',
      suppressedCount: match ? toCount(match[1]) : 0,
    };
  }
  // #3390 review (this PR's own Copilot review, Medium finding): the bare
  // `### Suppressed comments (N)` heading is deliberately NOT an
  // independent shape-detection signal here, unlike the other three --
  // unlike a `<details>`/`<summary>` tag pair (real GitHub-rendered HTML,
  // #1614's own established anchor-safety rationale), a bare ATX heading
  // is ordinary Markdown text a review could legitimately quote in prose
  // (for example, discussing this exact detection logic) with no code
  // span at all, which would otherwise self-misclassify as a real legacy
  // finding and false-block the gate. It still contributes to the COUNT
  // below once one of the three safe anchor signals already confirms the
  // shape.
  const isLegacyOverview =
    LEGACY_OVERVIEW_OPEN_PATTERN.test(trimmedStart) ||
    LEGACY_DETAILS_SUMMARY_PATTERN.test(stripped) ||
    AUGUST_SUPPRESSED_SUMMARY_PATTERN.test(stripped);
  if (isLegacyOverview) {
    // `###` heading takes precedence -- when present, a nested
    // `**Previously missed (N)**` bold line (no `<summary>` wrapper) is
    // already part of that same count and must never be added again
    // (PR #3108: heading says `(3)`, count stays `3`, not `6`).
    const headingMatch = stripped.match(LEGACY_SUPPRESSED_HEADING_PATTERN);
    const summaryMatch = stripped.match(AUGUST_SUPPRESSED_SUMMARY_PATTERN);
    const suppressedCount = headingMatch
      ? toCount(headingMatch[1])
      : summaryMatch
        ? toCount(summaryMatch[1])
        : 0;
    return { shape: 'overview-legacy', suppressedCount };
  }
  return { shape: 'unrecognized', suppressedCount: 0 };
}

// -----------------------------------------------------------------------
// Previously missed citations (#3942)
// -----------------------------------------------------------------------

/** Zero-width and format characters GitHub renders inside a file path. */
const ZERO_WIDTH_CHARS_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/gu;

/**
 * A file citation anywhere in a body, in the backtick or the legacy bold form
 * (#3942). Used only where no per-item view exists.
 */
const CITATION_ANYWHERE_PATTERN =
  /(?:`|\*\*)(?:(?:[\w.-]+\/)+[\w.-]+|[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{1,5}|[\w-]+(?=:\d))(?::\d+)?(?:`|\*\*)/u;

/** One `<details>` block. A Previously missed item never nests another. */
const DETAILS_BLOCK_PATTERN = /<details>([\s\S]*?)<\/details>/g;

/**
 * The Previously missed items of an `overview-v2` body, in order, each
 * flagged `cited` when its text names a file or line anywhere (#3942).
 * `null` when the body is not `overview-v2` or carries no such section.
 * Read from the raw body: {@link stripMarkdownCodeRegions} would blank the
 * code span that carries the citation.
 */
export function extractPreviouslyMissedItems(
  body: string | null | undefined,
): { cited: boolean }[] | null {
  if (typeof body !== 'string' || !V2_MARKER_PATTERN.test(body.trimStart())) {
    return null;
  }
  const heading = body.match(V2_PREVIOUSLY_MISSED_PATTERN);
  if (!heading || heading.index === undefined) {
    return null;
  }
  const section = body.slice(heading.index + heading[0].length);
  // An item always has its own <summary>. A <details> without one is part of
  // the section's prose, not an item, so it cannot make the count match (#3942).
  return [...section.matchAll(DETAILS_BLOCK_PATTERN)]
    .filter((block) => block[1].includes('<summary>'))
    .map((block) => ({
      cited: block[1]
        .replace(ZERO_WIDTH_CHARS_PATTERN, '')
        .split(/\r?\n/)
        .some((line) => CITATION_ANYWHERE_PATTERN.test(line)),
    }));
}

/** True when `body` names a file or line anywhere in its text (#3942). */
export function namesFileOrLine(body: string): boolean {
  return CITATION_ANYWHERE_PATTERN.test(
    body.replace(ZERO_WIDTH_CHARS_PATTERN, ''),
  );
}

/**
 * Splits a body's Previously missed count into the items that name a file or
 * line and the ones that do not (#3942). An `overview-v2` body with a
 * Previously missed section always has a per-item view, which may be empty.
 * Its items must match the count, or every suppressed item counts as cited
 * (fail closed). A body with no per-item view counts every item as cited when
 * it names a file or line anywhere, and as citation-free when it names none,
 * so the existing review-ack rule still applies to it.
 */
export function citationBreakdown(
  body: string | null | undefined,
  suppressedCount: number,
): { citedCount: number; citationFreeCount: number } {
  if (suppressedCount === 0) {
    return { citedCount: 0, citationFreeCount: 0 };
  }
  const items = extractPreviouslyMissedItems(body);
  if (items) {
    if (items.length !== suppressedCount) {
      return { citedCount: suppressedCount, citationFreeCount: 0 };
    }
    const citedCount = items.filter((item) => item.cited).length;
    return { citedCount, citationFreeCount: suppressedCount - citedCount };
  }
  // An unreadable body cannot prove an item citation-free, so it fails closed.
  if (typeof body !== 'string' || namesFileOrLine(body)) {
    return { citedCount: suppressedCount, citationFreeCount: 0 };
  }
  return { citedCount: 0, citationFreeCount: suppressedCount };
}

// -----------------------------------------------------------------------
// Review-body remark extraction (#3672)
// -----------------------------------------------------------------------

/** `### 🔵 Needs a closer look` (any ATX level; the `🔵` marker, with or
 * without an emoji variation selector, is optional, since the real corpus
 * bodies carry it and older test fixtures do not). The phrase must end the
 * line, apart from an ATX closing `#` run, which needs a space before it
 * (`look###` is heading text, not a closing run), so
 * `### Needs a closer look: text` is left to
 * {@link REMARK_INLINE_LABEL_PATTERN}. */
const REMARK_HEADING_PATTERN =
  /^ {0,3}#{1,6}[ \t]+(?:🔵\uFE0F?[ \t]*)?needs a closer look(?:[ \t]+#+)?[ \t]*$/iu;

/** Inline form, line-anchored: `🔵 Needs a closer look: text`, optionally
 * behind up to three leading spaces and a run of heading, bullet (`-`,
 * `*`, `+`), or emphasis characters, for example
 * `**Needs a closer look:** text`. Four or more leading spaces never match,
 * and neither does a label inside a blockquote
 * (no real body puts one there, and supporting quote continuation lines
 * would need a container model this reader deliberately does not have).
 * Matches the label and its separator only; the remark text is whatever
 * follows on the line, and a label with no same-line text is not a remark. */
const REMARK_INLINE_LABEL_PATTERN =
  /^ {0,3}(?:[#*_+-][ \t#*_+-]*)?(?:🔵\uFE0F?[ \t*_]*)?needs a closer look[ \t*_]*:(?:[*_]{1,3}(?=[ \t]|$))?/iu;

const REMARK_PHRASE_PATTERN = /needs a closer look/iu;

/** The head of a body the Markdown masker may read, and the longest line it
 * may see: a remark sits at the top of a review body (every observed one
 * within its first hundred characters). Known limits, accepted for an
 * evidence-only field: a remark that starts past the head is not found, and
 * scanning stops after the first line the bounds cut (see
 * {@link boundedMaskInput}), so nothing below a very long line, or a remark
 * paragraph crossing the head's end, is read. */
const MASK_HEAD_CHARS = 2048;
const MASK_LINE_CHARS = 512;

/** The bounded copy of `body` handed to the shared masker, and the last line
 * index scanning may reach. The first line the bounds truncated (a line over
 * MASK_LINE_CHARS, or the line holding the head's end) has unknown Markdown
 * context past the cut: an HTML comment or code span can open or close there.
 * So it is an opaque boundary: no later line is scanned, and neither is a line
 * of the cut line's own paragraph unless the cut line starts it (an inline
 * construct needs its opener and closer in one paragraph), which keeps a long
 * remark line readable under its heading (#3688 review). */
function boundedMaskInput(body: string): { text: string; lastLine: number } {
  const lines = body.slice(0, MASK_HEAD_CHARS).split(/\r?\n/);
  const cut = lines.findIndex((line) => line.length > MASK_LINE_CHARS);
  let lastLine = cut === -1 ? lines.length - 1 : cut;
  if (cut !== -1 || body.length > MASK_HEAD_CHARS) {
    let start = lastLine;
    while (start > 0 && (lines[start - 1] ?? '').trim() !== '') {
      start -= 1;
    }
    if (start < lastLine) {
      lastLine = start - 1;
    }
  }
  return {
    text: lines.map((line) => line.slice(0, MASK_LINE_CHARS)).join('\n'),
    lastLine,
  };
}

const HAS_TEXT_PATTERN = /[\p{L}\p{N}]/u;
const ATX_HEADING_LINE_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/u;

/** A line that opens a block the shared masker does not hide, so the remark
 * paragraph must not read on into it: an ATX heading or setext underline, a
 * thematic break, a blockquote, a bullet or an ordered item starting at 1 (the
 * only ones CommonMark lets interrupt a paragraph), or one of the two bold
 * overview-metadata labels Copilot's v2 overview puts after the remark
 * (`**Review effort:**`, `**Findings:**`). CommonMark would fold the metadata
 * labels into the paragraph as lazy continuation text; every real body
 * separates them with a blank line, and a body that does not must still not
 * report them as the remark. Code blocks, HTML blocks and comments need no
 * pattern here: {@link maskMarkdownForScan} blanks them, and a blanked line
 * ends the paragraph. */
const NEW_BLOCK_LINE_PATTERNS: readonly RegExp[] = [
  ATX_HEADING_LINE_PATTERN,
  // A setext underline ends the paragraph it underlines.
  /^ {0,3}(?:=+|-{1,2})[ \t]*$/u,
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u,
  /^ {0,3}>/u,
  /^ {0,3}(?:[-+*]|1[.)])(?:[ \t]|$)/u,
  /^ {0,3}\*\*(?:review effort|findings):\*\*/iu,
];

/** `true` for a line that ends the running paragraph on its own: a blank
 * line, or a line the block masker blanked (a fenced or indented code block,
 * an HTML block or comment) while its original text is not. A code-span
 * interior line stays visible in the block mask (inline code is kept there),
 * so it does not end the paragraph. */
function endsRemarkParagraph(original: string, blocks: string): boolean {
  return original.trim() === '' || blocks.trim() === '';
}

/** `true` when a line opens a new block that ends a paragraph. */
function startsNewBlock(line: string): boolean {
  return NEW_BLOCK_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/** Reads one paragraph from the ORIGINAL lines, starting at `start` (the
 * first line's text begins at column `firstLineOffset`). Lines are trimmed
 * and joined with one space, so a wrapped remark reads as Markdown renders
 * it. `singleLine` reads only the first line, for a label that sits on an
 * ATX heading line (a heading is one line; its optional closing `#` run is
 * dropped). Returns `null` when the paragraph is empty. */
function readRemarkParagraph(
  original: readonly string[],
  blocks: readonly string[],
  located: readonly string[],
  lastLine: number,
  start: number,
  firstLineOffset: number,
  singleLine = false,
): string | null {
  const parts: string[] = [];
  for (let index = start; index <= lastLine; index += 1) {
    const originalLine = original[index] ?? '';
    if (
      endsRemarkParagraph(originalLine, blocks[index] ?? '') ||
      (index > start && startsNewBlock(located[index] ?? ''))
    ) {
      break;
    }
    const text = originalLine
      .slice(index === start ? firstLineOffset : 0)
      .trim();
    if (text !== '') {
      // A closing `#` run needs a space before it; this is linear, unlike a
      // `[ \t]+#+[ \t]*$` pattern over a long run of blanks.
      parts.push(singleLine ? text.replace(/[ \t]#+$/u, '').trimEnd() : text);
    }
    if (singleLine) {
      break;
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * Extract the remark a Copilot review body carries under its
 * `### 🔵 Needs a closer look` heading (legacy and `ccr-overview-v2`
 * bodies alike) or after an inline `Needs a closer look:` label
 * (kurone-kito/idd-skill#3672), or `null` when neither is present.
 *
 * Why this exists: {@link classifyCopilotReviewBody} takes
 * `suppressedCount` only from the "Previously missed" / "Suppressed
 * comments" blocks, so a body whose only signal is this remark (next to
 * `**Findings:** None` and no inline thread) classifies as
 * `suppressedCount: 0` and the latest-review clause stays satisfied.
 * That classification is deliberate and unchanged -- the corpus bodies
 * that carry both a remark and a counted block would otherwise be
 * counted twice -- so this function only makes the remark readable.
 *
 * Pure, and deliberately NOT a `BOT_WORDING_CLASSIFIERS` entry: that
 * registry's corpus evidence bar (3 real samples from 2 distinct PRs,
 * #3263) cannot be met for the inline form, which has no real sample at
 * all (the heading form has four, from four PRs), and the remark is
 * evidence only. Its real-body coverage lives in its own test file
 * instead.
 *
 * Markdown structure comes from the repository's shared CommonMark masker
 * ({@link maskMarkdownForScan}), not hand-kept patterns, so this reader does
 * not re-derive what counts as code or HTML (four review rounds on #3688
 * each found another edge of exactly that). Locating runs against a mask of
 * fenced, indented and inline code, HTML comments and HTML blocks, so a
 * label quoted in code or hidden in markup never matches. A paragraph ends
 * at a line the same mask minus inline code blanked (a code or HTML block)
 * or at a block-opening line of the full mask, so a multi-line code span
 * never ends it. The text
 * itself is read from the original lines, so a code span INSIDE the remark
 * survives. The mask keeps line count and in-line columns (not absolute
 * offsets, since `\r\n` is normalized), which is all this relies on. It sees
 * only a bounded head of the body (see {@link boundedMaskInput}).
 *
 * Limits, accepted because the result never gates anything: a review
 * that merely discusses the phrase in uncoded prose as a line-anchored
 * `Needs a closer look:` label yields a spurious remark (unlike the
 * classifier's #3390 false-block risk, which a spurious remark cannot
 * reach), and the inline form is pinned only by the issue's own example
 * -- every real review observed so far uses the heading form.
 */
export function extractCopilotReviewBodyRemark(
  body: string | null | undefined,
): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  // The shared masker costs more than linear on crafted input (#3688 review:
  // tens of seconds on a 65k-character run of unterminated code spans, and
  // cubic in the length of a `<a` line followed by spaces), so it only ever
  // sees a bounded head of the body with bounded lines, and not at all when
  // that head lacks the phrase. A remark sits at the top of a review body;
  // the remark TEXT is still read from the full original lines.
  const { text: maskInput, lastLine } = boundedMaskInput(body);
  if (!REMARK_PHRASE_PATTERN.test(maskInput)) {
    return null;
  }
  const original = body.split(/\r?\n/);
  const located = maskMarkdownForScan(maskInput, {
    inlineCode: 'mask',
    htmlComments: 'mask',
    htmlBlocks: 'mask',
  }).split(/\r?\n/);
  // Inline code and inline comments stay visible here: only a blanked code or
  // HTML BLOCK line ends a paragraph, never the interior of a multi-line span
  // or comment. (A comment block on its own lines is still an HTML block.)
  const blocks = maskMarkdownForScan(maskInput, {
    inlineCode: 'keep',
    htmlComments: 'keep',
    htmlBlocks: 'mask',
  }).split(/\r?\n/);
  for (let index = 0; index <= lastLine; index += 1) {
    const line = located[index] ?? '';
    let remark: string | null = null;
    // The plain original line must match too: a code span between the marker
    // and the phrase is masked to spaces in `line` but is not the heading.
    if (
      REMARK_HEADING_PATTERN.test(line) &&
      REMARK_HEADING_PATTERN.test(original[index] ?? '')
    ) {
      let first = index + 1;
      while (first <= lastLine && (original[first] ?? '').trim() === '') {
        first += 1;
      }
      // A first block the masker blanked (a code or HTML block) is not prose.
      if (
        first <= lastLine &&
        (blocks[first] ?? '').trim() !== '' &&
        !startsNewBlock(located[first] ?? '')
      ) {
        remark = readRemarkParagraph(
          original,
          blocks,
          located,
          lastLine,
          first,
          0,
        );
      }
    } else {
      const label = REMARK_INLINE_LABEL_PATTERN.exec(line);
      // The label needs same-line text (a letter or digit, so a stray
      // emphasis mark does not count): a bare label followed by another line
      // says nothing about which line is the remark (#3688 review).
      if (
        label &&
        // A masked span inside the label (code between the phrase and the
        // colon) means the match is not the plain label.
        (original[index] ?? '').startsWith(label[0]) &&
        HAS_TEXT_PATTERN.test((original[index] ?? '').slice(label[0].length))
      ) {
        remark = readRemarkParagraph(
          original,
          blocks,
          located,
          lastLine,
          index,
          label[0].length,
          ATX_HEADING_LINE_PATTERN.test(line),
        );
      }
    }
    if (remark !== null) {
      return remark;
    }
  }
  return null;
}
