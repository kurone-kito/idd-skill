// idd-generated-from: src/scripts/dependency-grammar.mts
//
// The scripts/dependency-grammar.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
/**
 * Single-sourced `Blocked by` / `Depends on` dependency-line grammar
 * (#3284), shared by `discover-readiness-check.mts` (via
 * `extractBlockedByIssueNumbers` / `extractDependencyIssueNumbers`),
 * `discover-orphan-filter.mts` (via its own `extractBlockedByReferences`,
 * which delegates to the readiness composer), and
 * `discover-roadmap-graph.mts`'s dependency-keyword handling inside
 * `extractKeywordReferences`.
 *
 * A dependency line starts, after optional indentation, any number of
 * blockquote `>` markers, and at most one list marker (`-`/`*`/`+`, or an
 * ordered `1.`/`1)` marker), with the keyword (case-insensitive), an
 * optional `:`, and horizontal whitespace, then a reference list separated
 * by commas, `and`, or whitespace. Each token is a bare `#N`, a qualified
 * `owner/repo#N`, or a `https://github.com/owner/repo/issues/N` URL. A
 * token naming the current repository resolves to local `N`; a token
 * naming any other repository -- or any qualified token when the current
 * repository is unknown -- is reported as unresolvable (fail-safe) instead
 * of silently becoming a local number, and parsing continues past it.
 * Parsing stops at the first token that is neither a reference nor a
 * separator, so trailing prose and an un-parseable mention are excluded
 * rather than mis-read.
 *
 * `extractDependencyReferences` masks the body with
 * {@link maskMarkdownForScan} internally, with `htmlComments: 'mask'` in
 * addition to that helper's own default masking (fenced/indented code
 * always; inline code by default) -- a dependency is text GitHub renders,
 * and a line inside an HTML comment is not rendered, the same reason a
 * code-quoted line is already ignored (#1121). Callers pass the **raw**
 * body; `maskMarkdownForScan` also normalizes `\r\n` to `\n` first, so a
 * CRLF body needs no special handling here.
 */
import { maskMarkdownForScan } from './markdown-code.mjs';
import { escapeRegex } from './marker-regex.mjs';
/** Normalize an `owner`/`repo` pair to lowercase `"owner/repo"`, or `''`
 * when either half is missing. */
export function normalizeDependencyRepoRef(owner, repo) {
  const normalizedOwner = String(owner ?? '')
    .trim()
    .toLowerCase();
  const normalizedRepo = String(repo ?? '')
    .trim()
    .toLowerCase();
  return normalizedOwner && normalizedRepo
    ? `${normalizedOwner}/${normalizedRepo}`
    : '';
}
function resolveCurrentRepoRef(options) {
  return String(options.currentRepo ?? '')
    .trim()
    .toLowerCase();
}
const BARE_TOKEN_RE = /^#(\d+)\b/u;
const QUALIFIED_TOKEN_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)\b/u;
const URL_TOKEN_RE =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/u;
const SEPARATOR_RE = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s+)/i;
/**
 * Consume the contiguous dependency-reference list at the start of
 * `segment`: bare `#N`, qualified `owner/repo#N`, or a
 * `https://github.com/owner/repo/issues/N` URL, separated by commas,
 * `and`, and/or whitespace. Stops at the first token that is neither a
 * recognized reference nor a separator, so trailing prose (`; similar to
 * #402`) and an unparseable mention are excluded instead of being
 * mis-read. A qualified/URL token naming another repository (or naming
 * any repository when {@link DependencyGrammarOptions.currentRepo} is
 * unset) is collected in `unresolvable` and parsing continues past it --
 * it never terminates the scan the way an unrecognized token does.
 */
export function consumeDependencyReferenceList(segment, options = {}) {
  const currentRepoRef = resolveCurrentRepoRef(options);
  const numbers = [];
  const unresolvable = [];
  let remaining = segment;
  while (remaining) {
    const urlMatch = remaining.match(URL_TOKEN_RE);
    const qualifiedMatch = !urlMatch && remaining.match(QUALIFIED_TOKEN_RE);
    const bareMatch =
      !urlMatch && !qualifiedMatch && remaining.match(BARE_TOKEN_RE);
    const match = urlMatch ?? qualifiedMatch ?? bareMatch;
    if (!match) {
      break;
    }
    if (urlMatch || qualifiedMatch) {
      const qualified = urlMatch ?? qualifiedMatch;
      const qualifiedRepoRef = normalizeDependencyRepoRef(
        qualified[1],
        qualified[2],
      );
      const target = Number.parseInt(qualified[3], 10);
      if (
        currentRepoRef &&
        qualifiedRepoRef === currentRepoRef &&
        Number.isInteger(target) &&
        target > 0
      ) {
        numbers.push(target);
      } else {
        unresolvable.push({
          token: match[0],
          reason: 'cross_repository_reference',
        });
      }
    } else {
      const target = Number.parseInt(bareMatch[1], 10);
      if (Number.isInteger(target) && target > 0) {
        numbers.push(target);
      }
    }
    remaining = remaining.slice(match[0].length);
    const separatorMatch = remaining.match(SEPARATOR_RE);
    if (!separatorMatch) {
      break;
    }
    remaining = remaining.slice(separatorMatch[0].length);
  }
  return { numbers, unresolvable, remaining };
}
/**
 * #2441: GitHub line-wraps a long, comma-separated "Blocked by"/"Depends
 * on" list once it exceeds one line in the raw issue body, so a
 * same-line-only scan silently loses every reference past the wrap.
 * Starting at `startIndex` in `lines` (the line immediately after the
 * keyword line), consume zero or more immediately-following lines that
 * are *entirely* a dependency-reference list -- each candidate line is
 * parsed with {@link consumeDependencyReferenceList} and only swept in
 * when nothing is left over, so a line starting a new paragraph, or
 * mixing a reference with other prose, ends the sweep (matching the
 * single-line prose exclusion this extends). Stops at the first blank
 * line, non-continuation line, or end of `lines`.
 */
export function consumeDependencyContinuationRefLines(
  lines,
  startIndex,
  options = {},
) {
  const numbers = [];
  const unresolvable = [];
  let index = startIndex;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trim();
    if (!trimmed) {
      break;
    }
    const {
      numbers: lineNumbers,
      unresolvable: lineUnresolvable,
      remaining,
    } = consumeDependencyReferenceList(trimmed, options);
    if (lineNumbers.length === 0 && lineUnresolvable.length === 0) {
      break;
    }
    if (remaining.trim().length > 0) {
      break;
    }
    numbers.push(...lineNumbers);
    unresolvable.push(...lineUnresolvable);
    index += 1;
  }
  return { numbers, unresolvable };
}
// Leading-anchor source for a dependency-keyword line: optional
// indentation, any number of blockquote `>` markers, and at most one list
// marker -- a bullet (`-`/`*`/`+`) or an ordered marker (`1.`/`1)`). The
// ordered forms are new relative to the historical bullet-only prefix and
// match `discover-roadmap-graph.mts`'s own reading of a numbered Tracks
// list.
const DEPENDENCY_LINE_PREFIX = String.raw`^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+)?`;
// A dependency line's captured tail must itself start with a recognized
// reference token -- otherwise the keyword match doesn't count as a
// dependency declaration at all (e.g. a bare "Blocked by" with nothing
// following it, or one whose only following text is unparseable prose).
const TOKEN_START = String.raw`(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)`;
/**
 * Extract every `keyword` (`Blocked by` / `Depends on`) dependency
 * reference from `body`, line-anchored: the keyword must open the line
 * (after the optional prefix above). `body` is the **raw** issue/PR body;
 * masking (inline code, HTML comments, `\r\n` normalization) happens
 * internally.
 */
export function extractDependencyReferences(body, keyword, options = {}) {
  const masked = maskMarkdownForScan(String(body ?? ''), {
    htmlComments: 'mask',
  });
  const lines = masked.split('\n');
  const linePattern = new RegExp(
    `${DEPENDENCY_LINE_PREFIX}${escapeRegex(keyword)}:?[ \\t]+(${TOKEN_START}.*)$`,
    'i',
  );
  const numbers = [];
  const unresolvable = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(linePattern);
    if (!match) {
      continue;
    }
    const lineResult = consumeDependencyReferenceList(match[1], options);
    numbers.push(...lineResult.numbers);
    unresolvable.push(...lineResult.unresolvable);
    // #2441's line-wrap sweep only applies when the keyword line's own
    // reference list is the *entire* rest of the line -- trailing prose
    // (`Blocked by #10.`) means the next line is unrelated text, not a
    // GitHub-wrapped continuation, so sweeping it in would over-capture.
    // Mirrors the same guard `discover-roadmap-graph.mts`'s dependency
    // handling already applies at its own match position.
    if (lineResult.remaining.trim() === '') {
      const continuation = consumeDependencyContinuationRefLines(
        lines,
        index + 1,
        options,
      );
      numbers.push(...continuation.numbers);
      unresolvable.push(...continuation.unresolvable);
    }
  }
  return { numbers, unresolvable };
}
