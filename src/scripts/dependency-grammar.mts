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

import { maskMarkdownForScan } from './markdown-code.mts';
import { escapeRegex } from './marker-regex.mts';

/** One dependency-line token that named a repository other than the
 * current one, or a qualified token encountered when the current
 * repository could not be determined. */
export interface DependencyGrammarUnresolvedToken {
  /** The raw matched token text, e.g. `other/repo#5` or a full GitHub
   * issue URL -- never a local `#N` token. */
  token: string;
  reason: 'cross_repository_reference';
}

/** The parsed local numbers and any unresolvable (cross-repository)
 * tokens collected while consuming a dependency reference list. */
export interface DependencyReferenceListResult {
  numbers: number[];
  unresolvable: DependencyGrammarUnresolvedToken[];
  /** Whatever text was not consumed as part of the contiguous reference
   * list -- empty when the whole input was refs and separators. */
  remaining: string;
  /**
   * The offset within `segment` immediately after the LAST successfully
   * matched token, before any trailing separator was stripped -- `0`
   * when no token matched at all. Unlike `remaining`, this never
   * silently swallows trailing separator whitespace that turned out to
   * have nothing real following it: once a trailing separator (e.g. a
   * run of `\s+`) is stripped with no further token to consume, that
   * whitespace is gone from `remaining` too, even though `segment` may
   * still carry real content past it that the trailing-separator match
   * merely looked like it could ignore -- most notably MASKED content
   * (a code-masked-to-spaces region, or an HTML comment masked the same
   * way by a caller like {@link matchDependencyKeywordLine}) that reads
   * as pure whitespace in this masked segment but corresponds to real,
   * unmasked text in the caller's own original view. Recover the
   * swallowed tail with `segment.slice(consumedTokenEnd)`; a caller
   * that needs to know "is there anything real after the parsed
   * reference list" should use this field, not `remaining`, when its
   * own input may itself be a masked view of something else (#3285).
   */
  consumedTokenEnd: number;
  /**
   * Every bare `#N` token that matched the reference-token shape but was
   * rejected as a non-positive or non-integer number (e.g. `#0`) --
   * silently dropped from `numbers` with no other record otherwise,
   * since (unlike a qualified/URL token, which always lands in either
   * `numbers` or `unresolvable`) a rejected bare token has no
   * `unresolvable` entry either. A caller that must not silently ignore
   * an invalid list member mixed in with otherwise-valid ones --
   * `checkDependencyLineGrammar` (`idd-skill#3285` review, Copilot):
   * `Blocked by #0, #12` must still fail on the invalid `#0`, even
   * though `#12` alone is perfectly valid -- reads this field instead
   * of only checking whether `numbers`/`unresolvable` are non-empty.
   * Deliberately does NOT change `extractDependencyReferences`'s own
   * behavior or Discover's runtime resolution: `numbers` still resolves
   * every valid token in the same list regardless of a sibling invalid
   * one, exactly as before.
   */
  invalidTokens: string[];
}

export interface DependencyGrammarOptions {
  /** The current repository as `"owner/repo"`. Unset (or empty) means
   * "unknown": every qualified/URL token is then reported as
   * unresolvable, per the fail-safe default above. */
  currentRepo?: string;
}

/** Normalize an `owner`/`repo` pair to lowercase `"owner/repo"`, or `''`
 * when either half is missing. */
export function normalizeDependencyRepoRef(
  owner: unknown,
  repo: unknown,
): string {
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

function resolveCurrentRepoRef(options: DependencyGrammarOptions): string {
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
export function consumeDependencyReferenceList(
  segment: string,
  options: DependencyGrammarOptions = {},
): DependencyReferenceListResult {
  const currentRepoRef = resolveCurrentRepoRef(options);
  const numbers: number[] = [];
  const unresolvable: DependencyGrammarUnresolvedToken[] = [];
  const invalidTokens: string[] = [];
  let remaining = segment;
  let consumedTokenEnd = 0;
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
      const qualified = (urlMatch ?? qualifiedMatch) as RegExpMatchArray;
      const qualifiedRepoRef = normalizeDependencyRepoRef(
        qualified[1],
        qualified[2],
      );
      const target = Number.parseInt(qualified[3], 10);
      // Validate the number independently of repo resolution
      // (`idd-skill#3285` final review round, Copilot): the prior
      // `else` branch folded a non-positive/non-integer qualified or
      // URL target (e.g. `owner/repo#0`) into `unresolvable` with
      // `reason: 'cross_repository_reference'` even when
      // `qualifiedRepoRef` matched `currentRepoRef` -- reporting an
      // invalid SAME-repo number as if it named a different repository,
      // and (when `currentRepoRef` is unknown) hiding the real
      // "this number is invalid" problem behind the ordinary
      // fail-safe-unverifiable route every qualified/URL token already
      // takes without repo context. Only a genuinely valid positive
      // number ever reaches the cross-repository resolution/
      // unresolvable decision below.
      if (!Number.isInteger(target) || target <= 0) {
        invalidTokens.push(match[0]);
      } else if (currentRepoRef && qualifiedRepoRef === currentRepoRef) {
        numbers.push(target);
      } else {
        unresolvable.push({
          token: match[0],
          reason: 'cross_repository_reference',
        });
      }
    } else {
      const target = Number.parseInt((bareMatch as RegExpMatchArray)[1], 10);
      if (Number.isInteger(target) && target > 0) {
        numbers.push(target);
      } else {
        invalidTokens.push(match[0]);
      }
    }
    remaining = remaining.slice(match[0].length);
    consumedTokenEnd = segment.length - remaining.length;
    const separatorMatch = remaining.match(SEPARATOR_RE);
    if (!separatorMatch) {
      break;
    }
    remaining = remaining.slice(separatorMatch[0].length);
  }
  return { numbers, unresolvable, remaining, consumedTokenEnd, invalidTokens };
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
  lines: readonly string[],
  startIndex: number,
  options: DependencyGrammarOptions = {},
): {
  numbers: number[];
  unresolvable: DependencyGrammarUnresolvedToken[];
  /** Every bare invalid token (e.g. `#0`) seen on a swept continuation
   * line -- see {@link DependencyReferenceListResult.invalidTokens}. */
  invalidTokens: string[];
} {
  const numbers: number[] = [];
  const unresolvable: DependencyGrammarUnresolvedToken[] = [];
  const invalidTokens: string[] = [];
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
      invalidTokens: lineInvalidTokens,
    } = consumeDependencyReferenceList(trimmed, options);
    if (lineNumbers.length === 0 && lineUnresolvable.length === 0) {
      // Distinguishes an invalid-only continuation line (e.g. a lone
      // `#0`) from genuinely unrelated prose that merely starts the
      // sweep's stop condition the same way (`idd-skill#3285` review,
      // Copilot): a non-empty `lineInvalidTokens` here proves at least
      // one recognized-but-rejected token was seen, so this line WAS an
      // attempted continuation of the wrapped list, just with a bad
      // number -- report it before stopping the sweep, rather than
      // silently discarding the only record of it. An empty
      // `lineInvalidTokens` here means nothing token-shaped matched at
      // all (ordinary unrelated text), so there is nothing to add.
      invalidTokens.push(...lineInvalidTokens);
      break;
    }
    if (remaining.trim().length > 0) {
      break;
    }
    numbers.push(...lineNumbers);
    unresolvable.push(...lineUnresolvable);
    invalidTokens.push(...lineInvalidTokens);
    index += 1;
  }
  return { numbers, unresolvable, invalidTokens };
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
// Deliberately loose (no trailing `\b`): this only gates whether
// {@link matchDependencyKeywordLine}'s line pattern is even worth trying
// to parse a reference list from, and whether
// {@link hasDependencyReferenceListStart}'s own caller (in particular
// `checkDependencyLineGrammar`'s `findDependencyKeywordMisuse`,
// `idd-skill#3285`) should treat what follows a keyword as "looks like an
// attempted reference, worth reporting as a misuse if it turns out
// malformed" -- tightening this to require the same boundary the strict
// consumer regexes below already enforce (`#\d+\b`) would make
// `#12foo` (a malformed, not-really-a-token mention) invisible to BOTH
// paths instead of being caught by either: `matchDependencyKeywordLine`
// already independently rejects it (see its own doc comment: an
// accepted match that consumes zero real numbers/unresolvable tokens
// returns `undefined`), and a tightened `TOKEN_START` would then also
// stop `findDependencyKeywordMisuse` from recognizing it as a
// reference-shaped mention worth flagging, silently dropping the
// near-miss report the loose test intentionally still provides
// (confirmed empirically during the #3285 review: a tightened
// `TOKEN_START` regressed `Blocked by #12foo` from "flagged as a
// near-miss" to "not reported at all").
const TOKEN_START = String.raw`(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)`;
const TOKEN_START_RE = new RegExp(`^${TOKEN_START}`, 'u');

/**
 * `true` when `text` begins with a recognized reference token (`#N`,
 * `owner/repo#N`, or a full GitHub issue URL) -- the same test
 * {@link extractDependencyReferences}'s own line pattern applies via
 * `TOKEN_START` to decide whether a keyword match opens a genuine
 * dependency declaration at all. Exported so a caller with its own
 * keyword-matching mechanism (`discover-roadmap-graph.mts`'s
 * "anywhere on the line" search, unlike this module's line-anchored one)
 * can apply the identical keyword-to-token-gap validity check instead of
 * hand-approximating it -- a hand-approximated check drifted from this
 * one three separate times (`#3284` review rounds 1-3: no required gap,
 * `Blocked by#12`; a `discover-roadmap-graph.mts`-only bug that briefly
 * fixed the missing-gap case with a check that itself accepted a stray
 * `Blocked by : #12`, since a bare `/^:?[ \t]+/` match says nothing about
 * what follows the gap).
 */
export function hasDependencyReferenceListStart(text: string): boolean {
  return TOKEN_START_RE.test(text);
}

/** The parsed local numbers and any unresolvable (cross-repository) tokens
 * a single keyword-line match (plus any swept continuation lines)
 * produced -- see {@link matchDependencyKeywordLine}. */
export interface DependencyKeywordLineMatch {
  numbers: number[];
  unresolvable: DependencyGrammarUnresolvedToken[];
  /**
   * The same-line text left over after the accepted reference list's
   * LAST real token -- e.g. `". Depends on #13"` for a line reading
   * `"Blocked by #12. Depends on #13"`, or `""` when the last token ends
   * the line outright. Derived from
   * {@link DependencyReferenceListResult.consumedTokenEnd}, not
   * {@link DependencyReferenceListResult.remaining}: the latter can read
   * as fully empty even when real (possibly masked-to-blank) content
   * followed the last token, whenever a trailing separator swallowed it
   * with nothing left to parse after -- see that field's own doc
   * comment. This grammar recognizes at most ONE dependency declaration
   * per line, so `remaining` is never itself re-parsed as a second
   * declaration here; it is only the left-over text so a caller like
   * `checkDependencyLineGrammar` (`idd-skill#3285` review, Copilot) can
   * still scan it for an independent, second keyword-plus-reference
   * mention -- including one hidden inside a masked HTML comment right
   * after the first, valid reference -- instead of treating the whole
   * line as fully validated. Always the *same-line* unconsumed tail,
   * even when a continuation sweep (below) pulled in numbers from later
   * lines -- those later lines are a different index in `lines` and get
   * their own `remaining` when matched directly.
   */
  remaining: string;
  /**
   * Every invalid bare token (e.g. `#0`) seen while parsing the accepted
   * reference list, aggregated across the main match and any swept
   * continuation lines -- see
   * {@link DependencyReferenceListResult.invalidTokens}. Non-empty here
   * does NOT by itself make this function return `undefined`: a line
   * like `Blocked by #0, #12` still has a genuine valid token (`#12`,
   * landing in `numbers`), so the shared grammar has extracted something
   * real and this remains a defined match -- but a caller like
   * `checkDependencyLineGrammar` (`idd-skill#3285` review, Copilot) that
   * must not silently ignore the invalid `#0` reads this field to still
   * fail the line, distinct from the `remaining`-scan path above.
   */
  invalidTokens: string[];
}

/**
 * Test whether `lines[index]` opens a canonical `keyword` dependency line
 * (after the optional prefix above), sweeping in any immediately
 * following GitHub-wrapped continuation lines (#2441) the same way
 * {@link extractDependencyReferences} does. Returns `undefined` when the
 * line does not open a keyword dependency declaration at all -- no
 * keyword match, the captured tail does not start with a recognized
 * reference token, or (`idd-skill#3285` review, Copilot) the token-shaped
 * text that followed the keyword still produced zero usable references
 * after parsing (both `numbers` and `unresolvable` empty even after any
 * continuation sweep) -- for example `Blocked by #0`, where `#0` matches
 * {@link TOKEN_START}'s loose shape but {@link consumeDependencyReferenceList}
 * excludes it as a non-positive number. Without this, a caller like
 * `checkDependencyLineGrammar` would treat such a line as "the shared
 * grammar already accepts this" and never re-examine it, even though no
 * real dependency was ever extracted from it.
 *
 * Unlike {@link extractDependencyReferences}, this function never masks
 * its input: `lines` must already be the caller's own masked-and-split
 * body (#3285). A caller that needs a per-line "does the shared grammar
 * already accept this line" answer without re-masking a body it already
 * masked once should call this directly instead of re-invoking
 * {@link extractDependencyReferences} on an isolated single line --
 * re-masking one line in isolation loses the surrounding document
 * context a structural mask (fenced/indented code) depends on, and can
 * turn a valid nested/indented dependency line into a spurious top-level
 * indented code block, silently dropping it. Exported so a caller doesn't
 * have to hand-roll the same `DEPENDENCY_LINE_PREFIX`/`TOKEN_START`/
 * `consume*` logic a second time -- see {@link hasDependencyReferenceListStart}'s
 * own doc comment for the three-time drift history of independently
 * re-deriving pieces of this grammar.
 */
export function matchDependencyKeywordLine(
  lines: readonly string[],
  index: number,
  keyword: string,
  options: DependencyGrammarOptions = {},
): DependencyKeywordLineMatch | undefined {
  const linePattern = new RegExp(
    `${DEPENDENCY_LINE_PREFIX}${escapeRegex(keyword)}:?[ \\t]+(${TOKEN_START}.*)$`,
    'i',
  );
  const match = lines[index]?.match(linePattern);
  if (!match) {
    return undefined;
  }
  const lineResult = consumeDependencyReferenceList(match[1], options);
  const numbers = [...lineResult.numbers];
  const unresolvable = [...lineResult.unresolvable];
  const invalidTokens = [...lineResult.invalidTokens];
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
    invalidTokens.push(...continuation.invalidTokens);
  }
  if (numbers.length === 0 && unresolvable.length === 0) {
    return undefined;
  }
  // Deliberately NOT `lineResult.remaining` (#3285 E10 review, Copilot):
  // that field is empty whenever a trailing separator (`\s+`) was
  // stripped with nothing left to consume after it -- including when
  // the "whitespace" was actually MASKED content (a code span, or an
  // HTML comment masked by a caller like `checkDependencyLineGrammar`)
  // that only reads as blank in this already-masked `match[1]`. Slicing
  // from `consumedTokenEnd` instead recovers that swallowed tail, so a
  // hidden mention immediately after a valid reference on the same line
  // (`Blocked by #12 <!-- Depends on #13 -->`) still shows up here for
  // the caller to re-scan, rather than silently reading as "nothing left
  // on this line."
  return {
    numbers,
    unresolvable,
    remaining: match[1].slice(lineResult.consumedTokenEnd),
    invalidTokens,
  };
}

/**
 * Extract every `keyword` (`Blocked by` / `Depends on`) dependency
 * reference from `body`, line-anchored: the keyword must open the line
 * (after the optional prefix above). `body` is the **raw** issue/PR body;
 * masking (inline code, HTML comments, `\r\n` normalization) happens
 * internally, exactly once, before {@link matchDependencyKeywordLine} is
 * applied per line.
 */
export function extractDependencyReferences(
  body: string,
  keyword: string,
  options: DependencyGrammarOptions = {},
): {
  numbers: number[];
  unresolvable: DependencyGrammarUnresolvedToken[];
} {
  const masked = maskMarkdownForScan(String(body ?? ''), {
    htmlComments: 'mask',
  });
  const lines = masked.split('\n');
  const numbers: number[] = [];
  const unresolvable: DependencyGrammarUnresolvedToken[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const result = matchDependencyKeywordLine(lines, index, keyword, options);
    if (!result) {
      continue;
    }
    numbers.push(...result.numbers);
    unresolvable.push(...result.unresolvable);
  }
  return { numbers, unresolvable };
}
