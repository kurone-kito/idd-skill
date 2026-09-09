// idd-generated-from: src/scripts/resolved-decision.mts
//
// The scripts/resolved-decision.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

/**
 * Single-sourced detector for a "resolved maintainer decision" signal in an
 * issue body -- the shape `docs/idd-workflow.md`'s Groom-pass workflow
 * (#2494) records, either as a `## Decision (... resolved ...)` heading or
 * as inline prose: `Maintainer decision (<provenance>, <date>): <resolution
 * text>`.
 *
 * `suitability-triage.mts`'s Check 7 (Verifiability) originated this
 * detection for #2661/#2711 across many independent review rounds (cited
 * inline below); `discover-viability-gate.mts`'s `autonomous_completion`
 * criterion (#2763) reuses it verbatim to exclude the SAME resolved-decision
 * line from its own `EXTERNAL_COORDINATION_PATTERN` scan, rather than
 * maintaining a second, independently-drifting regex for the same shape --
 * `docs/idd-workflow.md`'s Groom section tells an operator to write exactly
 * this line, so an issue groomed as documented must not then fail the A4
 * gate that runs before Check 7 ever sees it.
 */

import {
  findMarkdownCodeRanges,
  type MarkdownCodeRange,
  maskMarkdownCodeRegionsPreservingPositions,
} from './markdown-code.mts';

// #2661 PR #2662 review: the reporting-verb vocabulary a quoting/citing
// sentence uses to introduce someone else's decision as an example, rather
// than asserting it as this issue's own. Exported: also used by
// suitability-triage.mts's `isFramedAsDescriptive` (`hasSubjectiveApproval`,
// #2512), an unrelated feature that happens to reuse the same vocabulary.
export const FRAMING_VERB_PATTERN =
  /\b(documents?|describes?|says?|states?|explains?|reports?)\b/i;

/**
 * Blank-line-delimited paragraph offsets within `body`. Exported: also used
 * by suitability-triage.mts's `hasSubjectiveApproval` framing check, an
 * unrelated feature that happens to need the same paragraph boundaries.
 */
export function getParagraphSpans(
  body: string,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const boundary of body.matchAll(/\r?\n[ \t]*(?:\r?\n)+/g)) {
    spans.push({ start: cursor, end: boundary.index });
    cursor = boundary.index + boundary[0].length;
  }
  spans.push({ start: cursor, end: body.length });
  return spans;
}

// #2661 PR #2662 review round 6 (Codex): an issue-template author commonly
// leaves hidden instructional scaffolding as an HTML comment -- e.g.
// `<!-- Maintainer decision (Groom hearing, YYYY-MM-DD): <resolution text>
// -->` -- invisible in the rendered issue but still present in a
// code-masked body (Markdown code masking does not touch HTML comments).
// Masked the same way as inline/fenced code, before the inline-decision
// pattern scan. An unterminated `<!--` (no matching `-->`) extends to
// end-of-body: CommonMark renders such an HTML block through EOF, so the
// entire remaining body -- a genuine marker and Acceptance Criteria
// included -- can be invisible in the rendered issue while still matching
// this scan if left unmasked (round 7, PR #2662).
//
// #2711: an issue that documents this convention's own syntax inside a
// fenced code example -- e.g. a fence containing a literal, deliberately
// unterminated `<!--` to illustrate the shape -- must not have that
// example's opener treated as a REAL unterminated comment: doing so masks
// through EOF and swallows a genuine later "Maintainer decision (...)"
// that follows the fence. The same applies to an INLINE code span
// demonstrating the same syntax (PR #2735 Codex review round 2) -- e.g.
// `` `<!--` `` followed by a later bullet naming the real artifact.
// `ignoredOpenerRanges` (optional, defaults to none so existing callers
// with no code content to worry about are unaffected) lets a caller
// exclude any `<!--` whose own opening `<` falls inside one of these
// ranges from consideration entirely; pass fenced + indented + inline
// ranges (e.g. `findMarkdownCodeRanges`'s result) to cover every code
// shape, not just fenced blocks.
//
// #2711 PR #2735 review round 5 (Codex): a backslash-escaped opener
// (`\<!--`) renders as a literal string in CommonMark, not a real HTML
// comment start -- an issue documenting the literal marker syntax (e.g.
// `Document the literal \<!-- marker`) must not have everything after it
// masked through EOF. A single preceding backslash is enough to treat it
// as escaped (soft heuristic, matching this file's existing style; does
// not attempt full backslash-run parity for a doubly-escaped `\\<!--`).
//
// Exported: also used by suitability-triage.mts's Check 6 (Autonomy) and
// Check 7 (Verifiability, Acceptance Criteria masking) for the same
// generic "mask an HTML comment" need, unrelated to resolved-decision
// detection specifically.
export function findHtmlCommentRanges(
  text: string,
  ignoredOpenerRanges: MarkdownCodeRange[] = [],
): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const openPattern = /<!--/g;
  let openMatch = openPattern.exec(text);
  while (openMatch) {
    const openIndex = openMatch.index;
    const isEscaped = text[openIndex - 1] === '\\';
    const isIgnored =
      isEscaped ||
      ignoredOpenerRanges.some(
        (range) => openIndex >= range.start && openIndex < range.end,
      );
    if (isIgnored) {
      openPattern.lastIndex = openIndex + 4;
      openMatch = openPattern.exec(text);
      continue;
    }
    const closeIndex = text.indexOf('-->', openIndex + 4);
    const end = closeIndex === -1 ? text.length : closeIndex + 3;
    ranges.push({ start: openIndex, end });
    openPattern.lastIndex = end;
    openMatch = openPattern.exec(text);
  }
  return ranges;
}

// A heading line such as "## Decision (resolved 2026-06-27)" records that a
// human has already ruled on the issue's open question (see Check 7). The
// negative lookahead rejects only a still-open *phrase* that directly negates
// "resolved" ("not [yet] [been] resolved", "to be resolved", "never [been]
// resolved"), so an unrelated negator elsewhere on the line -- e.g. "Decision
// (not user-facing; resolved 2026-06-27)" -- still counts as resolved. A
// lookahead (not a variable-length lookbehind) keeps the assertion portable
// across JavaScript regex engines.
export const RESOLVED_DECISION_PATTERN =
  /^#{1,6}\s+Decision\b(?![^\n]*\b(?:not(?:\s+yet)?(?:\s+been)?\s+resolved|(?:to\s+be|yet\s+to\s+be|remains?\s+to\s+be)\s+resolved|never(?:\s+been)?\s+resolved)\b)[^\n]*\bresolved\b/im;

// #2661: the grooming-pass workflow (docs/idd-workflow.md, from #2494)
// records a resolved decision as inline prose -- "Maintainer decision
// (<provenance>, <date>): <resolution text>" -- not a "## Decision" heading,
// so RESOLVED_DECISION_PATTERN above never matches it. The parenthetical's own
// provenance (an issue reference and/or "Groom hearing" and/or a date) is
// this shape's resolved signal, so -- unlike the heading form -- the literal
// word "resolved" is not required. `[^)]` (not `[^)\n]`) lets the parenthetical
// span a hard-wrapped line break -- GitHub issue bodies wrap at ~80 chars, so
// "(kurone-kito/idd-skill#2637, Groom hearing,\n2026-09-05):" routinely splits
// the provenance across two physical lines (the same line-wrap-is-not-a-
// boundary shape as the proximity check above, #2512). A "still open" guard
// applies immediately after the colon, so a placeholder resolution is not
// mistaken for a real one -- both the heading form's own negated-"resolved"
// phrasing ("not yet decided") and this inline form's own still-pending
// vocabulary (TBD, pending, undecided, deferred, "still open"), since the
// inline form has no positive `\bresolved\b` requirement to fall back on
// (#2661 C1 review). The leading `[\s*_\`>-]*` skips past Markdown emphasis
// (`**pending**`, `_TBD_`, `` `still open` ``) and list/blockquote markers
// ("- TBD ...", "> pending ...") that would otherwise land between the colon
// and the denylist word (Codex + Copilot review, PR #2662); the trailing
// `(?![a-zA-Z])` replaces a plain `\b`, which fails to end the match after
// "TBD_" (both `D` and `_` are `\w`, so `\b` finds no boundary there) even
// though the underscore is just a closing emphasis marker, not part of the
// word. The negated-decision-noun class (`no\s+(?:decision|consensus|
// agreement|resolution|verdict|ruling|conclusion)(?:\s+yet)?`) and the
// still-open-state class (`(?:still|remains?)\s+(?:open|undecided|
// unresolved|pending|unsettled)`) replace the earlier single-phrase
// entries ("no decision yet", "still open") with their semantic families,
// covering "no consensus yet" and similar noun-first phrasings the
// verb-first "not (yet) decided" denylist entries don't match (Codex
// rounds 2-3, PR #2662) without enumerating every synonym as its own
// literal. Deliberately NOT a bare `no\s+\w+`: "no changes to the API;
// keep as-is" is a genuinely resolved decision, not a pending one.
// **Convergence boundary**: this denylist is already stricter than
// precedent -- `RESOLVED_DECISION_PATTERN` above has carried no
// resolution-text denylist at all since #1135, and its own docstring
// accepts exactly this soft-heuristic trade-off. A denylist can never
// enumerate every future synonym; widen a *class* here only for a
// concrete reported case, not for a hypothetical one. Resolution text must
// start on the SAME LINE as the colon (`[ \t]*`, no newline tolerance): an
// earlier revision allowed a single hard-wrapped line break here, which
// fixed the immediate "colon immediately followed by a blank line" case
// (Codex round 2, PR #2662) but still let an empty marker consume the very
// next line's first character even with no blank line at all -- e.g. a
// heading's "#" right after "Maintainer decision (...):\n" (Copilot round
// 6, PR #2662). Dropping the newline tolerance entirely closes both cases
// at once; neither of this fix's two real-world citations (#2644, #2641)
// ever needed it, since GitHub's hard-wrap only splits the provenance
// parenthetical, never the colon-to-resolution boundary itself. The
// lookahead right after the opening "("
// requires the parenthetical to actually contain one of the three
// provenance signals this shape is documented to carry -- an issue/PR
// reference, "Groom hearing", or an ISO-style date -- rather than accepting
// any (or empty) parenthetical content as if provenance were merely
// decorative (Copilot review round 2, PR #2662): without this, "Maintainer
// decision (): ..." or "Maintainer decision (just kidding): ..." could
// bypass the subjective-approval gate with no real grooming-pass record
// behind it. `pending`/`undecided`/`deferred` additionally require a clause
// boundary (through optional "yet"/"still"/"for now" and Markdown
// decoration) immediately after the word -- these three, unlike TBD/TBA/TBC,
// are ordinary English adjectives that can open a genuinely settled
// resolution's own sentence ("deferred to follow-up issue #100 so this
// patch remains scoped", "pending requests will be rejected with HTTP
// 409"); only a bare, sentence-ending use of the word signals a real
// placeholder (Codex round 4, PR #2662). This is the same soft
// co-occurrence heuristic as the heading form: it does not verify the
// resolution text actually settles the exact approval wording elsewhere in
// the body.
export const INLINE_MAINTAINER_DECISION_PATTERN =
  /(?<![\w-])Maintainer decision(?![\w-])\s*\((?=[^)]{0,200}(?:#\d+|Groom hearing|\d{4}-\d{2}-\d{2}))[^)]{0,200}\)\s*:[ \t]*(?![\s*_`>-]*(?:not(?:\s+yet)?(?:\s+been)?\s+(?:resolved|decided)|no\s+(?:decision|consensus|agreement|resolution|verdict|ruling|conclusion)(?:\s+yet)?|(?:to\s+be|yet\s+to\s+be|remains?\s+to\s+be)\s+(?:resolved|decided)|never(?:\s+been)?\s+(?:resolved|decided)|TBD|TBA|TBC|(?:pending|undecided|deferred)(?:\s+(?:yet|still|for\s+now))?[\s*_`]*(?=[.,;:\n]|$)|awaiting\s+(?:a\s+)?(?:decision|consensus|sign-?off|approval)|(?:still|remains?)\s+(?:open|undecided|unresolved|pending|unsettled))(?![a-zA-Z]))\S/i;

// #2661 PR #2662 review round 2 (Codex): unlike a whole-paragraph framing
// scan, this scans only the paragraph text BEFORE `offset`, not the whole
// paragraph. Used solely for the inline-decision scan, where the match's own
// resolution text (after the colon) can legitimately contain an ordinary
// reporting verb -- "Maintainer decision (...): the helper reports an
// actionable error" -- without that making the marker itself a quoted
// example of someone else's decision. A genuine quoting/reporting frame
// always precedes the quoted marker in natural prose ("issue #2641 states
// \"Maintainer decision (...)\"..."), so only text before the match need be
// checked here. Bounded to the current SENTENCE, not the whole paragraph
// prefix (round 6, PR #2662): an unrelated reporting verb in an earlier,
// already-terminated sentence of the same paragraph -- "The current helper
// reports status. Maintainer decision (...): choose A" -- must not suppress
// a genuine decision merely for sharing a paragraph with an unrelated use of
// the same vocabulary.
// #2711: the terminal punctuation of a sentence may be immediately
// followed by a closing Markdown emphasis marker or quote character before
// the whitespace that ends it -- e.g. a sentence ending `"done."` or
// `*settled*.`. A plain literal ". "/"! "/"? " scan finds no boundary at
// such a position (the quote/emphasis character sits between the
// punctuation and the space) and falls back to an EARLIER, unrelated
// sentence boundary instead, widening the scan window enough to catch that
// earlier sentence's own framing verb.
const SENTENCE_TERMINATOR_PATTERN = /[.!?][)"'*_`\]]*(?=\s|$)/;

function findLastSentenceBoundaryEnd(scanText: string): number {
  const pattern = new RegExp(SENTENCE_TERMINATOR_PATTERN.source, 'g');
  let end = -1;
  let match = pattern.exec(scanText);
  while (match !== null) {
    end = match.index + match[0].length;
    match = pattern.exec(scanText);
  }
  return end;
}

function findFirstSentenceBoundaryEnd(scanText: string): number {
  const match = SENTENCE_TERMINATOR_PATTERN.exec(scanText);
  return match === null ? scanText.length : match.index + match[0].length;
}

function isPrecededByFramingVerb(
  normalizedBody: string,
  paragraphSpans: { start: number; end: number }[],
  offset: number,
): boolean {
  const span =
    paragraphSpans.find(
      (candidate) => offset >= candidate.start && offset <= candidate.end,
    ) ?? paragraphSpans[paragraphSpans.length - 1];
  const scanText = normalizedBody.slice(span?.start ?? 0, offset);
  const sentenceStart = findLastSentenceBoundaryEnd(scanText);
  return FRAMING_VERB_PATTERN.test(
    scanText.slice(sentenceStart === -1 ? 0 : sentenceStart),
  );
}

// #2711: an inverted-attribution quotation states the marker FIRST and its
// reporting verb after it -- "'Maintainer decision (...): choose A,'
// reports the referenced tracking issue" -- which `isPrecededByFramingVerb`
// above never sees, since it only scans text BEFORE the match. Mirrors that
// function's own single-sentence bound, forward instead of backward, so an
// unrelated LATER sentence's own framing verb doesn't wrongly suppress a
// genuine decision two sentences later.
const QUOTE_CHARS = ['"', "'"];

function isFollowedByFramingVerb(
  normalizedBody: string,
  paragraphSpans: { start: number; end: number }[],
  matchStart: number,
  matchEnd: number,
): boolean {
  const span =
    paragraphSpans.find(
      (candidate) =>
        matchStart >= candidate.start && matchStart <= candidate.end,
    ) ?? paragraphSpans[paragraphSpans.length - 1];
  const paragraphStart = span?.start ?? 0;
  const paragraphEnd = span?.end ?? normalizedBody.length;

  // Deliberately narrower than "any framing verb somewhere later in the
  // sentence": the marker must be immediately preceded by an opening quote
  // character, closed by that SAME character before the framing verb.
  // Without this, an ordinary reporting verb inside the marker's OWN
  // resolution text -- "Maintainer decision (...): the helper reports an
  // actionable error..." -- would be wrongly read as external framing (PR
  // #2662 Codex review's own regression coverage for the backward-scan
  // case; the forward scan needs the identical guard).
  const precedingChar = normalizedBody[matchStart - 1];
  if (
    matchStart <= paragraphStart ||
    !QUOTE_CHARS.includes(precedingChar ?? '')
  ) {
    return false;
  }
  const followingText = normalizedBody.slice(matchEnd, paragraphEnd);
  const closingQuoteIndex = followingText.indexOf(precedingChar as string);
  if (closingQuoteIndex === -1) {
    return false;
  }
  const afterQuote = followingText.slice(closingQuoteIndex + 1);
  const sentenceEnd = findFirstSentenceBoundaryEnd(afterQuote);
  return FRAMING_VERB_PATTERN.test(afterQuote.slice(0, sentenceEnd));
}

// #2661 PR #2662 review round 2 (Codex): a Markdown blockquote ("> Maintainer
// decision (...): ...") is itself a quoting signal, independent of
// `isPrecededByFramingVerb` -- pasting another issue's decision as a
// blockquote carries no reporting verb of its own, so the framing-verb check
// alone lets a quoted decision through. Checks BOTH the matched line's own
// ">" prefix (the direct case -- also covers a quote that starts partway
// through a paragraph, e.g. "For reference:" followed immediately by
// "> Maintainer decision (...)": CommonMark starts a new blockquote block at
// that "> " line regardless of the preceding unquoted line, Codex round 5,
// PR #2662) AND the containing PARAGRAPH's first line (CommonMark's
// blockquote "lazy continuation" rule -- this repo's own coverage:
// tests/markdown-code.test.mts's "permits lazy continuation" case -- renders
// a line with no ">" of its own as still inside the quote when it continues
// a paragraph that started with "> ", Codex round 4, PR #2662). An earlier
// round-4 revision checked only the paragraph's first line and dropped the
// original round-2 direct-line check, reintroducing exactly the round-5 gap.
function isInBlockquotedParagraph(
  normalizedBody: string,
  paragraphSpans: { start: number; end: number }[],
  offset: number,
): boolean {
  const lineStart = normalizedBody.lastIndexOf('\n', offset - 1) + 1;
  if (/^[ \t]*>/.test(normalizedBody.slice(lineStart, offset))) {
    return true;
  }
  const span =
    paragraphSpans.find(
      (candidate) => offset >= candidate.start && offset <= candidate.end,
    ) ?? paragraphSpans[paragraphSpans.length - 1];
  const paragraphStart = span?.start ?? 0;
  const firstLineEnd = normalizedBody.indexOf('\n', paragraphStart);
  const firstLine = normalizedBody.slice(
    paragraphStart,
    firstLineEnd === -1 ? normalizedBody.length : firstLineEnd,
  );
  return /^[ \t]*>/.test(firstLine);
}

// #2711: a GFM strikethrough span ("~~Maintainer decision (...): choose
// A~~") marks its content as struck through -- rendered convention for
// "retracted" or "superseded" -- so a decision inside one must not count
// as this issue's current live resolution, independent of any framing verb
// or blockquote. Pairs consecutive "~~" delimiters left-to-right within the
// containing paragraph (a soft heuristic, not full CommonMark strikethrough
// parsing, matching this file's existing style for inline-span detection)
// and reports whether `offset` falls strictly inside any pair's content.
//
// #2711 PR #2735 review round 3 (Codex): scans a code-masked body, not the
// raw `normalizedBody`, so a literal "~~" inside an inline/fenced code
// example demonstrating the syntax -- masked to spaces there -- is never
// mistaken for a real delimiter. `codeMaskedBody` must be the SAME length
// and position-preserving relative to `normalizedBody` (as
// `maskMarkdownCodeRegionsPreservingPositions` guarantees) so `paragraphSpans`
// and `offset`, both computed against `normalizedBody`, stay valid against
// it.
//
// #2711 PR #2735 review round 5 (Codex): a backslash-escaped delimiter
// (`\~~`) renders as a literal string in CommonMark, not a real
// strikethrough boundary -- two literal `\~~` examples surrounding a
// genuine, unstruck "Maintainer decision (...)" must not be paired as if
// they were real delimiters. A single preceding backslash is enough to
// treat a `~~` as escaped (soft heuristic, matching this file's existing
// style; does not attempt full backslash-run parity for `\\~~`).
function isInStrikethroughSpan(
  codeMaskedBody: string,
  paragraphSpans: { start: number; end: number }[],
  offset: number,
): boolean {
  const span =
    paragraphSpans.find(
      (candidate) => offset >= candidate.start && offset <= candidate.end,
    ) ?? paragraphSpans[paragraphSpans.length - 1];
  const paragraphStart = span?.start ?? 0;
  const paragraphEnd = span?.end ?? codeMaskedBody.length;
  const paragraphText = codeMaskedBody.slice(paragraphStart, paragraphEnd);
  const relativeOffset = offset - paragraphStart;
  const delimiterPattern = /~~/g;
  const delimiterStarts: number[] = [];
  let delimiterMatch = delimiterPattern.exec(paragraphText);
  while (delimiterMatch !== null) {
    if (paragraphText[delimiterMatch.index - 1] !== '\\') {
      delimiterStarts.push(delimiterMatch.index);
    }
    delimiterPattern.lastIndex = delimiterMatch.index + 2;
    delimiterMatch = delimiterPattern.exec(paragraphText);
  }
  for (let index = 0; index + 1 < delimiterStarts.length; index += 2) {
    const contentStart = (delimiterStarts[index] ?? 0) + 2;
    const contentEnd = delimiterStarts[index + 1] ?? 0;
    if (relativeOffset >= contentStart && relativeOffset < contentEnd) {
      return true;
    }
  }
  return false;
}

/**
 * Finds every inline "Maintainer decision (<provenance>): <resolution>"
 * occurrence in `body` that survives the framing-verb / blockquote /
 * strikethrough exclusion checks above -- a genuine resolved decision, not a
 * quoted or struck-through example of someone else's. Self-contained: `body`
 * is normalized and code/HTML-comment-masked internally, so a caller passes
 * the raw issue body with no precomputation of its own. Returned spans are
 * offsets into `body` AFTER `\r\n` normalization (`\r\n` -> `\n`); a caller
 * comparing indices from a separately-scanned corpus must normalize that
 * corpus the same way first, or the two coordinate spaces can drift by one
 * byte per CRLF line -- an edge case with no realistic GitHub-fetched issue
 * body, whose API responses are already `\n`-only.
 */
export function findInlineResolvedDecisionSpans(
  body: string,
): MarkdownCodeRange[] {
  const normalizedBody = body.replace(/\r\n/g, '\n');
  const paragraphSpans = getParagraphSpans(normalizedBody);
  const codeRanges = findMarkdownCodeRanges(normalizedBody);
  const codeMaskedBody = maskMarkdownCodeRegionsPreservingPositions(
    normalizedBody,
    [...codeRanges, ...findHtmlCommentRanges(normalizedBody, codeRanges)],
  );

  const spans: MarkdownCodeRange[] = [];
  const inlinePattern = new RegExp(
    INLINE_MAINTAINER_DECISION_PATTERN.source,
    'gi',
  );
  let inlineMatch = inlinePattern.exec(codeMaskedBody);
  while (inlineMatch) {
    const matchStart = inlineMatch.index;
    const matchEnd = matchStart + inlineMatch[0].length;
    if (
      !isPrecededByFramingVerb(normalizedBody, paragraphSpans, matchStart) &&
      !isFollowedByFramingVerb(
        normalizedBody,
        paragraphSpans,
        matchStart,
        matchEnd,
      ) &&
      !isInBlockquotedParagraph(normalizedBody, paragraphSpans, matchStart) &&
      !isInStrikethroughSpan(codeMaskedBody, paragraphSpans, matchStart)
    ) {
      spans.push({ start: matchStart, end: matchEnd });
    }
    inlineMatch = inlinePattern.exec(codeMaskedBody);
  }
  return spans;
}

/**
 * True when `body` records a resolved maintainer decision, either the
 * heading form (`## Decision (... resolved ...)`) or the inline
 * grooming-pass form. Replaces `suitability-triage.mts`'s own former
 * `hasResolvedDecision` computation; `discover-viability-gate.mts` uses
 * `findInlineResolvedDecisionSpans` directly instead, since its
 * `autonomous_completion` criterion needs per-occurrence match offsets, not
 * just a whole-body boolean.
 */
export function hasResolvedDecision(body: string): boolean {
  return (
    RESOLVED_DECISION_PATTERN.test(body) ||
    findInlineResolvedDecisionSpans(body).length > 0
  );
}
