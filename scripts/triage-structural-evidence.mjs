// idd-generated-from: src/scripts/triage-structural-evidence.mts
//
// The scripts/triage-structural-evidence.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
/**
 * Structural (non-lexical) evidence signal for the A4 viability gate and
 * the A4.5 suitability triage (#2767): three mechanical booleans an issue
 * body/author/edit-history can satisfy that, together, demote a specific
 * lexical false-positive `fail` to a `warn`-annotated `pass` instead of
 * outright rejecting a genuinely well-specified, trustworthy issue. Each
 * signal alone proves nothing about intent -- `verificationCommand` and
 * `candidateFilesExist` are shape checks any author (including an
 * untrusted one) can satisfy -- so the demotion always requires all
 * three together; `trustedEditor` is what actually carries the weight.
 *
 * Deliberately provider-agnostic: every function here takes already-
 * fetched primitives (body text, author login, editor logins, a trust
 * predicate) rather than fetching anything itself, so no test needs to
 * mock `gh` (per #1212's scope note) and no caller here needs to adopt
 * the provider-port abstraction. `discover-viability-gate.mts` and
 * `discover-orphan-filter.mts` (already provider-port callers) and
 * `suitability-triage.mts` (still on direct `gh` calls) each gather the
 * primitives their own way and call `evaluateStructuralEvidence`.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { parseCandidateFileEntries } from './discover-shared-file-overlap.mjs';
import {
  findFencedCodeRanges,
  findHtmlBlockRanges,
  findIndentedCodeRanges,
  findMarkdownCodeRanges,
  maskMarkdownCodeRegionsPreservingPositions,
} from './markdown-code.mjs';
import { findHtmlCommentRanges } from './resolved-decision.mjs';

/**
 * A code span inside the `## Acceptance criteria` section naming one of
 * these runnable-verification command shapes counts as a
 * `verificationCommand` signal on its own. Deliberately narrow (the four
 * shapes the issue names) rather than "any code span" -- a broad match
 * would demote on any inline code, including a mere file path.
 */
const VERIFICATION_COMMAND_CODE_SPAN_PATTERN =
  /`(?:node --test\b[^`]*|pnpm run [^\s`]+[^`]*|npx [^\s`]+[^`]*|node scripts\/[^\s`]+\.mjs[^`]*)`/;
/** A Markdown checkbox list item: `- [ ]` / `- [x]` / `* [X]` / `1. [ ]`.
 * Requires whitespace or end-of-line immediately after the closing `]`
 * (Codex review, PR #2840, round 7): GitHub only renders `[ ]`/`[x]` as an
 * interactive task-list checkbox when a space (or line end) follows the
 * bracket -- `- [ ]not a task` renders as literal bracket text, not a
 * checkbox, but the earlier pattern (no lookahead at all) still counted
 * it. Also accepts an ordered-list marker (`\d+[.)]`), not just a bullet
 * (advisor review, round 9, closing a self-documented deferral): GFM's
 * task-list extension applies to any list item, ordered or unordered, so
 * "1. [ ] one" is a real, GitHub-rendered checkbox the bullet-only pattern
 * previously missed -- a false-negative-only fix. */
const CHECKBOX_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?=[ \t]|$)/gm;
/**
 * Section boundary: an ATX heading, or the position immediately before a
 * Setext-style sibling heading's own content line (a text line directly
 * followed, with no blank line between, by a lone run of `=`/`-`
 * characters). Duplicated from `suitability-triage.mts`'s own
 * `NEXT_HEADING_PATTERN` rather than imported -- that file imports this
 * module for the demotion wiring, so sharing the constant would create a
 * circular import. (Codex review, PR #2840): an ATX-only boundary let a
 * Setext-style sibling section's own content leak into the extracted
 * `## Acceptance criteria` text, so a command or 2+ checkboxes in that
 * later, unrelated section could set `verificationCommand: true` on a
 * trusted issue and wrongly demote a genuine autonomy/verifiability
 * failure -- not merely fail to find the boundary, the false-positive
 * direction this module exists to avoid.
 *
 * Two further fixes (Copilot review, PR #2840, round 8) -- both
 * false-negative directions (truncating a section's own real content
 * too early), the opposite of the false-positive direction above, but
 * still a genuine functional bug (this file's own `parseCandidateFiles`
 * sibling boundary had the identical Setext/thematic-break confusion,
 * fixed there in an earlier round of this same PR):
 *
 * - A negative lookahead excludes a list-item bullet, ordered-list
 *   marker, or blockquote line from ever being read as Setext-heading
 *   content: `- [ ] one\n---\n` is CommonMark's own thematic break
 *   ending the list, never a Setext heading over that bullet, so
 *   without the exclusion a genuine trailing checklist item followed by
 *   a thematic break wrongly ended the `## Acceptance criteria` section
 *   before its own real content.
 * - `\r?\n` (not bare `\n`) before and after the underline line: this
 *   pattern carries no `/m` flag, so `(?:\n|$)` never matched a
 *   CRLF-terminated underline line, silently missing the Setext
 *   boundary on a Windows-style-line-ending issue body (GitHub accepts
 *   either) and leaking a later section's content the same way an
 *   entirely-missed ATX boundary would have.
 */
const NEXT_ATX_HEADING_PATTERN =
  /\n(?: {0,3}#{1,6}\s|(?=[ \t]*(?![-*+][ \t]|\d+[.)][ \t]|>)\S[^\r\n]*\r?\n {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)))/;
/** Matches the `## Acceptance criteria` heading (any ATX level, any of
 * the two capitalization conventions used across this repository's own
 * issues) on its own line. Requires at least one space/tab after the `#`
 * run (Codex review, PR #2840): CommonMark requires that whitespace (or
 * end of line) for a real ATX heading -- `##Acceptance criteria` with no
 * space renders as plain paragraph text, not a heading, so the earlier
 * `[ \t]*` (zero-or-more) let that non-heading line open a fake
 * Acceptance-criteria section anyway. Mirrors `parseCandidateFiles`'s own
 * `\s+` heading pattern, which already required it. The gap between
 * "Acceptance" and "criteria" is `[ \t]+`, not `\s+` (Codex review, PR
 * #2840, round 7): `\s` also matches a newline, so `\s+` there let
 * `## Acceptance\ncriteria` -- two separate lines, only the first of
 * which Markdown renders as the actual ATX heading text -- match as one
 * combined heading anyway. An ATX heading is inherently single-line.
 *
 * Two more shapes (advisor review, round 9, closing a self-documented
 * deferral): up to three leading spaces (`^ {0,3}`, CommonMark's own ATX
 * indent allowance, mirrored from `parseCandidateFileEntries`'s own
 * heading regex, which already tolerated it), and an optional closing
 * `#` sequence preceded by whitespace (`(?:[ \t]+#+)?`), e.g.
 * "## Acceptance criteria ##". Both are false-negative-only fixes (a
 * genuine heading Markdown renders that this pattern previously missed),
 * never a new false-positive surface. */
const ACCEPTANCE_CRITERIA_HEADING_PATTERN =
  /^ {0,3}#{1,6}[ \t]+Acceptance[ \t]+[Cc]riteria(?:[ \t]+#+)?[ \t]*$/im;
/**
 * Mask fenced code, indented (4-space) code, real HTML comment ranges, and
 * raw HTML block ranges (Codex review, PR #2840, two rounds): an issue can
 * quote an example `## Acceptance criteria` heading plus two
 * checkbox-looking lines or an inline-command code span inside a fenced
 * block, inside an HTML comment, or inside a raw HTML block such as
 * `<pre>` -- Markdown renders none of those as a real heading, checklist,
 * or code span, but the raw-text regexes below previously counted them
 * anyway. With an existing candidate-file path and a trusted editor, that
 * let a genuine scope/autonomy/verifiability failure demote to `warn`.
 * Mirrors `suitability-triage.mts`'s own `checkVerifiability`
 * `fenceMaskedBody` construction (`#2711`/`#2735` review rounds) rather
 * than reinventing it -- deliberately leaves inline code spans unmasked,
 * since `hasVerificationCommandSignal`'s own signal lives inside a real
 * inline code span and must stay readable. This masks every CommonMark
 * construct that can hide content from Markdown rendering; further
 * masking gaps found after this round are hardening, not a fix to this
 * mechanism's own materially-addressed root cause.
 */
function maskOpaqueMarkdown(body) {
  const fencedRanges = findFencedCodeRanges(body);
  const codeRanges = findMarkdownCodeRanges(body);
  return maskMarkdownCodeRegionsPreservingPositions(body, [
    ...fencedRanges,
    ...findIndentedCodeRanges(body, fencedRanges),
    ...findHtmlCommentRanges(body, codeRanges),
    ...findHtmlBlockRanges(body, fencedRanges),
  ]);
}
/** Extract the named ATX section's offsets (heading line excluded, bounded
 * by the next ATX heading or end of body), or `null` when the heading is
 * absent. `start`/`end` are offsets into `body` itself, so a caller can
 * intersect them against ranges (e.g. inline-code-span ranges) computed
 * separately over the same `body`. */
function extractSection(body, headingPattern) {
  const match = body.match(headingPattern);
  if (!match) {
    return null;
  }
  const start = (match.index ?? 0) + (match[0]?.length ?? 0);
  const rest = body.slice(start);
  const nextHeadingIndex = rest.search(NEXT_ATX_HEADING_PATTERN);
  const end = nextHeadingIndex === -1 ? body.length : start + nextHeadingIndex;
  return { text: body.slice(start, end), start, end };
}
/**
 * `verificationCommand` signal (#2767): the `## Acceptance criteria`
 * section contains at least one code span matching `node --test`,
 * `pnpm run <script>`, `npx <tool>`, or `node scripts/<name>.mjs`, OR at
 * least two checkbox items. Returns `false` when the section is absent.
 *
 * The command-span check is restricted to genuine inline-code-span ranges
 * `findMarkdownCodeRanges` identifies on the already-masked body (Codex
 * review, PR #2840, round 2): the plain regex this replaced matched from
 * any literal backtick to the next, so an escaped literal like
 * `` \`node --test ...\` `` -- which CommonMark renders as literal
 * backtick characters, never a real code span -- still counted.
 * `findMarkdownCodeRanges`'s own `findInlineCodeRanges` already excludes
 * an escaped opening backtick (`isEscapedBacktick`), the same handling
 * `findHtmlCommentRanges`'s escaped-`<!--` guard mirrors elsewhere in this
 * module. Computed on the masked body (not the original) so a span that
 * only *looks* real until an enclosing fence/comment/HTML block is masked
 * away is not wrongly counted as surviving.
 *
 * Considered and rejected (Codex review, PR #2840, round 9; verified
 * against GitHub's own renderer via `gh api /markdown`, `mode: gfm`, not
 * just reasoned about): masking genuine inline code spans too before
 * heading/section-boundary detection, to guard against a multi-line span
 * "smuggling" a fake `## Acceptance criteria` heading plus fake
 * checkboxes past detection. CommonMark parses block structure before
 * inline content, and an ATX heading line interrupts an already-open
 * paragraph -- so a `` `` `` opened on one line is closed as that line's
 * own one-line paragraph the moment a `## heading` line follows, and the
 * unclosed backtick run reverts to literal text; the heading, checkboxes,
 * and any code span past it render as real structure, not span content.
 * `findMarkdownCodeRanges` on such a body already reflects this (via
 * `findInlineCodeRanges`'s own `findMarkdownBlockBoundary` paragraph-
 * boundary handling) -- it never returns a range spanning the heading
 * line -- so there is no fake heading for a masking pass to hide: the
 * input this finding described cannot occur under real Markdown
 * rendering. Adding a masking pass anyway would not fix a live gap; it
 * would make heading/Setext-boundary detection newly depend on
 * `findMarkdownBlockBoundary` being correct for every construct (thematic
 * break, Setext underline, HTML block) it was never exercised against for
 * this purpose, trading a phantom risk for a real one.
 */
export function hasVerificationCommandSignal(body) {
  const maskedBody = maskOpaqueMarkdown(String(body ?? ''));
  const section = extractSection(
    maskedBody,
    ACCEPTANCE_CRITERIA_HEADING_PATTERN,
  );
  if (section === null || section.text.length === 0) {
    return false;
  }
  const hasCommandSpan = findMarkdownCodeRanges(maskedBody).some(
    (range) =>
      range.start >= section.start &&
      range.end <= section.end &&
      VERIFICATION_COMMAND_CODE_SPAN_PATTERN.test(
        maskedBody.slice(range.start, range.end),
      ),
  );
  if (hasCommandSpan) {
    return true;
  }
  const checkboxCount = [...section.text.matchAll(CHECKBOX_ITEM_PATTERN)]
    .length;
  return checkboxCount >= 2;
}
/**
 * A bare `*.instructions.md` reference is a documented shorthand this
 * repository's own issues sometimes use in place of a full path -- expand
 * it into both the mirror and the `idd-template/` source location before
 * giving up on it. Only fires on a genuinely bare basename (no `/` at
 * all); a full path is resolved as written (Codex review, PR #2840,
 * round 8) -- see {@link candidateFilesExistOnDisk}'s own doc comment for
 * why resolving the *raw* path, not a contention-key normalization of it,
 * is what makes this distinction matter.
 */
function candidatePathVariants(rawPath) {
  const variants = [rawPath];
  if (/\.instructions\.md$/i.test(rawPath) && !rawPath.includes('/')) {
    variants.push(`.github/instructions/${rawPath}`);
    variants.push(`idd-template/.github/instructions/${rawPath}`);
  }
  return variants;
}
/**
 * `candidateFilesExist` signal (#2767): the `## Candidate files` section
 * (parsed with `discover-shared-file-overlap.mts`'s own
 * `parseCandidateFileEntries` -- the same backtick-path extraction the
 * issue asks to reuse) lists at least one path that exists in the working
 * tree, resolved against `repoRoot` (default `process.cwd()`).
 *
 * Resolves each entry's `raw` path, not `normalized` (Codex review, PR
 * #2840, round 8): `normalized` is `parseCandidateFileEntries`'s
 * contention-key form, which collapses a mirror pair (an
 * `idd-template/.github/instructions/<name>` source and its
 * `.github/instructions/<name>` mirror compare equal) and strips a
 * leading `idd-template/` generally -- correct for contention comparison,
 * but never a real on-disk location. A candidate written as
 * `idd-template/package.json` (which does not exist) normalizes to the
 * contention key `package.json` (which does exist at repo root),
 * wrongly satisfying this filesystem-existence signal for a path the
 * issue never actually named.
 *
 * Considered and rejected (Codex review, PR #2840, round 9) for the same
 * reason documented on {@link hasVerificationCommandSignal}: also masking
 * genuine inline code spans before heading/Setext-boundary detection here
 * would guard against an input that GitHub's own renderer does not
 * actually produce -- see that doc comment for the verified rationale.
 */
export function candidateFilesExistOnDisk(
  body,
  existsAt,
  repoRoot = process.cwd(),
) {
  const entries = parseCandidateFileEntries(
    maskOpaqueMarkdown(String(body ?? '')),
  );
  return entries.some((entry) =>
    candidatePathVariants(entry.raw).some((variant) => {
      const resolved = resolveRepoPath(repoRoot, variant);
      return resolved !== null && existsAt(resolved);
    }),
  );
}
/**
 * Resolves a `## Candidate files` path against `repoRoot`, containing it
 * to the repository -- `parseCandidateFileEntries` reads this text
 * straight out of untrusted issue-body prose. Returns `null` (never probed
 * by {@link candidateFilesExistOnDisk}, same as "does not exist") for an
 * absolute path or one whose `..` segments escape `repoRoot` after
 * normalization (CodeRabbit review, PR #2840): the pre-fix version passed
 * an absolute path through unchanged and never normalized `..` segments at
 * all, so `existsAt` could probe outside the working tree and wrongly
 * satisfy `candidateFilesExist` for a path this signal's own documentation
 * excludes.
 */
function resolveRepoPath(repoRoot, candidatePath) {
  // `node:path`'s own `isAbsolute` is platform-bound (POSIX does not
  // recognize a Windows drive-letter path as absolute) -- issue-body text
  // is untrusted and platform-agnostic, so also reject the drive-letter
  // form explicitly regardless of the host OS, matching this function's
  // pre-fix regex.
  if (isAbsolute(candidatePath) || /^[a-zA-Z]:[/\\]/.test(candidatePath)) {
    return null;
  }
  const resolved = resolve(repoRoot, candidatePath);
  const rel = relative(repoRoot, resolved);
  // `path.relative`'s own separator is platform-bound (win32 emits
  // `..\...`, not `../...`) -- checking only the POSIX form (Copilot
  // review, PR #2840) let an escaping `rel` through unnoticed whenever this
  // module runs on a Windows host. `path.relative` always normalizes any
  // `..` segments to the front of the result, so checking the first
  // segment under either separator is sufficient without a second
  // backslash-specific `startsWith`.
  if (rel.split(/[\\/]/)[0] === '..' || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
/**
 * `trustedEditor` signal (#2767): the issue author AND every editor
 * GraphQL `Issue.userContentEdits` records (deduplicated) must each pass
 * `isTrustedLogin`. A `null` editor login (a deleted/ghost account) fails
 * closed -- it can never pass `isTrustedLogin`, whatever that predicate
 * does, since `isTrustedLogin` only ever receives a real login string
 * here. An empty `editorLogins` array (never edited) means only the
 * author needs to pass.
 */
export function isTrustedEditorSignal(author, editorLogins, isTrustedLogin) {
  const normalizedAuthor = String(author ?? '')
    .trim()
    .toLowerCase();
  if (normalizedAuthor.length === 0) {
    return false;
  }
  const logins = new Set([normalizedAuthor]);
  for (const editorLogin of editorLogins) {
    if (typeof editorLogin !== 'string' || editorLogin.trim().length === 0) {
      // A null/ghost editor login can never be trusted -- fail closed
      // immediately rather than folding it into the set as an unmatched
      // key that `isTrustedLogin` never sees.
      return false;
    }
    logins.add(editorLogin.trim().toLowerCase());
  }
  return [...logins].every((login) => isTrustedLogin(login));
}
/** Build a `trustedLogin` predicate from a static allow-list plus a
 * collaborator-permission-based fallback, checking the cheap static list
 * first. Callers pass their own `collaboratorPermission`-backed
 * predicate (see `collaborator-permission.mts`) so this module never
 * imports the live `gh`-calling helper directly. */
export function buildTrustedLoginPredicate(
  trustedMarkerLogins,
  isTrustedCollaborator,
) {
  const staticLogins = new Set(
    trustedMarkerLogins.map((login) => login.trim().toLowerCase()),
  );
  return (login) => {
    const normalized = login.trim().toLowerCase();
    return staticLogins.has(normalized) || isTrustedCollaborator(normalized);
  };
}
/** `true` only when all three signals hold. */
export function hasAllStructuralSignals(evidence) {
  return Boolean(
    evidence?.verificationCommand &&
      evidence.candidateFilesExist &&
      evidence.trustedEditor,
  );
}
/** Compute all three signals in one call. */
export function evaluateStructuralEvidence(input) {
  return {
    verificationCommand: hasVerificationCommandSignal(input.body),
    candidateFilesExist: candidateFilesExistOnDisk(
      input.body,
      input.existsAt,
      input.repoRoot,
    ),
    trustedEditor: isTrustedEditorSignal(
      input.author,
      input.editorLogins,
      input.isTrustedLogin,
    ),
  };
}
