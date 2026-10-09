// idd-generated-from: src/scripts/copilot-overview-sections.mts
// Copilot's overview-body section extraction (#3868), shared by the
// source-repo wave audit (`copilot-review-wave-audit.mts`) and the distributed
// `review-activity-snapshot` helper. This module has no `gh` or CLI code, so a
// distributed helper can import it without pulling in the wave audit.
//
// It reads only the part of an overview body that is independent of "is this a
// v2 overview?": the `Open (n)` and `Previously missed (n)` sections and the
// severity label each item carries. The v2 marker test stays with the caller,
// because the wave audit and the snapshot decide "v2" differently. The snapshot
// uses `classifyCopilotReviewBody`, which strips code first, and the wave audit
// uses a plain marker `includes` test.
export function emptySeverityCounts() {
  return { high: 0, medium: 0, low: 0 };
}
export function toSeverity(word) {
  return word.toLowerCase();
}
// The discriminator between a top-level section header and a nested
// "Previously missed" finding's own <summary>: only a top-level header wraps
// its text in <strong>. See copilot-review-wave-audit.mts's header comment.
const SECTION_HEADER_RE = /<summary><strong>([^<]+)<\/strong><\/summary>/g;
const OPEN_HEADER_RE = /^Open \((\d+)\)$/;
const PREVIOUSLY_MISSED_HEADER_RE = /^Previously missed \((\d+)\)$/;
const SEVERITY_ALT_RE = /alt="(High|Medium|Low) severity"/g;
// Lazy `[\s\S]*?` is safe here only because each "Open" list item carries
// exactly one `alt="..."` (on its <picture>'s single <img>, never its
// <source> siblings) and exactly one `#discussion_r<id>` link -- confirmed
// against real bodies (PR #3147 review 5255592914, PR #3210 review
// 5292079228) -- so the lazy match cannot skip past one item into the next.
// `· New` is U+00B7 MIDDLE DOT, not an ASCII period.
const OPEN_ITEM_RE =
  /alt="(High|Medium|Low) severity"[\s\S]*?\]\(#discussion_r(\d+)\)(\s*·\s*New)?/g;
// The review's own `**Findings:** None` / `**Findings:** N <picture ...>`
// summary line -- corroborating evidence cross-checked against whether an
// "Open" section was actually found (see parseOverviewSections below).
const FINDINGS_HEADER_RE = /\*\*Findings:\*\*\s*(None|\d+)/i;
function findSections(body) {
  const sections = [];
  const matches = [...body.matchAll(SECTION_HEADER_RE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const header = match[1].trim();
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? body.length)
        : body.length;
    sections.push({ header, content: body.slice(contentStart, contentEnd) });
  }
  return sections;
}
/**
 * Extract the `Open` and `Previously missed` sections of one overview body,
 * without deciding whether the body is a v2 overview. A section whose parsed
 * item count disagrees with its own header `(n)` gives a reason, and so does a
 * `**Findings:** N` (N > 0) line with no `Open` section at all: the section
 * markup may have changed, so the caller must not treat the result as complete.
 * "Resolved since last review" and "What changed in this PR" are ignored. An
 * unrecognized future section is not, by itself, a reason.
 */
export function parseOverviewSections(body) {
  const open = [];
  const previouslyMissed = emptySeverityCounts();
  const unparsedReasons = [];
  let sawOpenHeader = false;
  for (const { header, content } of findSections(body)) {
    const openMatch = OPEN_HEADER_RE.exec(header);
    if (openMatch) {
      sawOpenHeader = true;
      const expected = Number.parseInt(openMatch[1], 10);
      const items = [...content.matchAll(OPEN_ITEM_RE)];
      for (const item of items) {
        open.push({
          severity: toSeverity(item[1]),
          id: Number.parseInt(item[2], 10),
          isNew: Boolean(item[3]),
        });
      }
      if (items.length !== expected) {
        unparsedReasons.push(
          `Open header declared ${expected} but ${items.length} were parsed`,
        );
      }
      continue;
    }
    const missedMatch = PREVIOUSLY_MISSED_HEADER_RE.exec(header);
    if (missedMatch) {
      const expected = Number.parseInt(missedMatch[1], 10);
      const alts = [...content.matchAll(SEVERITY_ALT_RE)];
      for (const alt of alts) {
        previouslyMissed[toSeverity(alt[1])] += 1;
      }
      if (alts.length !== expected) {
        unparsedReasons.push(
          `Previously missed header declared ${expected} but ${alts.length} were parsed`,
        );
      }
    }
  }
  // Copilot review, PR #3245 (#discussion_r4086537940's sibling "Previously
  // missed" finding, review 2026-09-23T20:15:44Z): a marker-present body
  // with none of the section headers above recognized (a genuinely
  // no-findings review, OR a future markup change this parser doesn't
  // know about) would otherwise silently fall through as a complete result
  // with an empty `open` -- indistinguishable from a real zero-findings
  // review. The `**Findings:** <None|N>` summary line is independent
  // corroborating evidence: cross-check it against whether an "Open" section
  // was ever found at all. A declared positive count with no matching Open
  // section means the section markup itself went unrecognized, so report a
  // reason rather than silently undercounting.
  const findingsHeaderMatch = FINDINGS_HEADER_RE.exec(body);
  if (findingsHeaderMatch && !sawOpenHeader) {
    const declared = findingsHeaderMatch[1].toLowerCase();
    const declaredCount =
      declared === 'none' ? 0 : Number.parseInt(declared, 10);
    if (declaredCount > 0) {
      unparsedReasons.push(
        `Findings header declared ${declaredCount} but no Open section was found`,
      );
    }
  }
  return { open, previouslyMissed, unparsedReasons };
}
