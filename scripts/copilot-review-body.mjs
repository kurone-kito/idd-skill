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
import { stripMarkdownCodeRegions } from './markdown-code.mjs';

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
export function isCopilotErrorReviewBody(body) {
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
function toCount(raw) {
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
export function classifyCopilotReviewBody(body) {
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
// Review-body remark extraction (#3672)
// -----------------------------------------------------------------------
/** `### 🔵 Needs a closer look` (any ATX level; the `🔵` marker, with or
 * without an emoji variation selector, is optional, since the real corpus
 * bodies carry it and older test fixtures do not). The phrase must end the
 * line, so `### Needs a closer look: text` is left to
 * {@link REMARK_INLINE_LABEL_PATTERN}. */
const REMARK_HEADING_PATTERN =
  /^ {0,3}#{1,6}[ \t]+(?:🔵\uFE0F?[ \t]*)?needs a closer look[ \t#]*$/iu;
/** Inline form, line-anchored: `🔵 Needs a closer look: text`, optionally
 * behind up to three leading spaces and a run of heading, bullet (`-`,
 * `*`, `+`), quote, or emphasis characters, for example
 * `**Needs a closer look:** text`. Four or more leading spaces (an indented
 * code block) never match. Matches the label and its separator only; the
 * remark text is whatever follows on the line. */
const REMARK_INLINE_LABEL_PATTERN =
  /^ {0,3}(?:[>#*_+-][ \t>#*_+-]*)?(?:🔵\uFE0F?[ \t*_]*)?needs a closer look[ \t*_]*:(?:\*\*|__)?[ \t]*/iu;
const ATX_HEADING_LINE_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const DETAILS_TAG_LINE_PATTERN = /^ {0,3}<\/?details(?:[ \t>]|$)/iu;
/** `true` for a line that ends the running paragraph on its own: a blank
 * line, or a fence line (blanked to exactly `''` in the stripped text while
 * its original text is not). A code-span interior line is whitespace-only
 * in the stripped text but non-blank in the original, so it does not end
 * the paragraph. */
function endsRemarkParagraph(original, stripped) {
  return original.trim() === '' || stripped === '';
}
/** `true` when a stripped line opens a new block that ends a paragraph. */
function startsNewBlock(stripped) {
  return (
    ATX_HEADING_LINE_PATTERN.test(stripped) ||
    DETAILS_TAG_LINE_PATTERN.test(stripped)
  );
}
/** Reads one paragraph from the ORIGINAL lines, starting at `start` (the
 * first line's text begins at column `firstLineOffset`). Lines are trimmed
 * and joined with one space, so a wrapped remark reads as Markdown renders
 * it. Returns `null` when the paragraph is empty. */
function readRemarkParagraph(original, stripped, start, firstLineOffset) {
  const parts = [];
  for (let index = start; index < original.length; index += 1) {
    const originalLine = original[index] ?? '';
    const strippedLine = stripped[index] ?? '';
    if (
      endsRemarkParagraph(originalLine, strippedLine) ||
      (index > start && startsNewBlock(strippedLine))
    ) {
      break;
    }
    const text = originalLine
      .slice(index === start ? firstLineOffset : 0)
      .trim();
    if (text !== '') {
      parts.push(text);
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
 * instead. Locating runs against the
 * code-stripped body (`stripMarkdownCodeRegions`, same defense as the
 * classifier) so a label quoted inside a code span or fence never
 * matches; the text itself is read from the original lines so a code
 * span INSIDE the remark survives. Masking keeps line count and in-line
 * columns (not absolute offsets, since `\r\n` is normalized), which is
 * all this relies on.
 *
 * Limits, accepted because the result never gates anything: a review
 * that merely discusses the phrase in uncoded prose as a line-anchored
 * `Needs a closer look:` label yields a spurious remark (unlike the
 * classifier's #3390 false-block risk, which a spurious remark cannot
 * reach), and the inline form is pinned only by the issue's own example
 * -- every real review observed so far uses the heading form.
 */
export function extractCopilotReviewBodyRemark(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }
  const original = body.split(/\r?\n/);
  const stripped = stripMarkdownCodeRegions(body).split(/\r?\n/);
  for (let index = 0; index < stripped.length; index += 1) {
    const line = stripped[index] ?? '';
    let remark = null;
    if (REMARK_HEADING_PATTERN.test(line)) {
      let first = index + 1;
      while (first < original.length && (original[first] ?? '').trim() === '') {
        first += 1;
      }
      const firstStripped = stripped[first] ?? '';
      if (
        first < original.length &&
        firstStripped !== '' &&
        !startsNewBlock(firstStripped)
      ) {
        remark = readRemarkParagraph(original, stripped, first, 0);
      }
    } else {
      const label = REMARK_INLINE_LABEL_PATTERN.exec(line);
      if (label) {
        remark = readRemarkParagraph(
          original,
          stripped,
          index,
          label[0].length,
        );
      }
    }
    if (remark !== null) {
      return remark;
    }
  }
  return null;
}
