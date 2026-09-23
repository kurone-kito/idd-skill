#!/usr/bin/env node
// idd-generated-from: src/scripts/verify-import-mirror.mts
//
// The scripts/verify-import-mirror.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Proves a vendoring commit is a pure mirror of an upstream commit
// (#3216). Field feedback (gist round 38, 2026-09-23) reported that a
// large vendored-import commit cannot be reviewed by reading, and that no
// existing helper mechanically verifies one: `idd-onboard.mts --verify`
// checks a target tree's own post-import state, never diffing against
// an upstream checkout; none of `helper-flag-drift.mjs`,
// `review-disposition-verify.mjs`, `verify-install-deps.mjs`, or
// `verify-workshop-integrity.mjs` compares a commit's changed files
// against an upstream source tree either.
//
// Scope model: this helper inspects exactly the files ONE target commit
// (`--target-ref`, default `HEAD`) added, modified, or deleted relative
// to its own parent baseline (`--target-base-ref`, default
// `${target-ref}^`) -- i.e. the vendoring commit's own diff, optionally
// narrowed to a path scope via repeatable `--path-prefix`. Renames are
// disabled (`--no-renames`) so each side of a rename is treated as an
// independent add/delete; simpler, and still correct under the rules
// below. Each changed path is classified against the corresponding path
// in an upstream tree, resolved from either a local checkout
// (`--upstream-path`) or a ref inside this repo's own remotes
// (`--upstream-ref`, optionally qualified by `--upstream-remote`).
// Framing the check around one commit's own diff (rather than a whole-
// tree snapshot comparison) is what makes "deletion recognized as
// matching upstream" well-defined without an external manifest: a path
// this commit deleted mirrors upstream only when upstream also lacks it
// at the given ref.
//
// Every git subprocess this file spawns runs with a sanitized environment
// (sanitizedGitEnvironment): GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/
// GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY and any GIT_CONFIG* variable are
// stripped before spawning, so an ambient override inherited from a
// calling hook or wrapper can never silently redirect a check onto the
// wrong repository (Copilot review, PR #3225; the same class of bug this
// repository already fixed once in idd-roadmap-audit-execute.mts, issue
// #2225).
//
// The five classification rules (issue #3216's own specification,
// itself distilled from a reporter's field experience -- three of the
// five exist only because their first version of this check was too
// permissive):
//
// 1. Exact byte-for-byte match, then a narrower "generated-banner-only"
//    tolerance for an emitted `.mjs` file whose `idd-generated-from`
//    banner line is the ONLY difference. This strips ONLY the exact
//    `//`-prefixed line(s) matching the CANONICAL banner syntax (the
//    marker immediately after `//` and optional whitespace, followed by
//    `:`, e.g. `// idd-generated-from: path`) -- never a whole
//    surrounding comment paragraph (an earlier, paragraph-wide version
//    tolerated an edited adjacent safety/prose comment too), and never a
//    looser "line merely contains the marker substring anywhere" match
//    either (an earlier version of that let an unrelated comment like
//    `// note: idd-generated-from old` hide a real edit inside itself --
//    both caught live by Copilot reviews on PR #3225). Both sides must
//    actually carry the canonical marker for this tolerance to apply at
//    all -- an unmarked side is never coerced into matching a marked one
//    via the stripped sentinel. This rule
//    additionally fails CLOSED by default: it only ever applies to a
//    path under a caller-supplied `--generated-dir` (repeatable). With no
//    `--generated-dir` given, banner tolerance never activates for any
//    file -- matching the issue's own "only for emitted .mjs under the
//    build's own output directories" scoping, which is part of the
//    rule's definition, not an optional refinement.
// 2. JSON compared structurally: parsed and literally re-serialized
//    (`JSON.stringify(JSON.parse(x))`) on each side, then compared as
//    strings -- deliberately stricter than a deep-equal, so a real value
//    change still fails; only incidental formatting (indentation,
//    trailing newline, spacing) is tolerated. A parsed value containing a
//    non-finite number (`JSON.parse` silently converts an overflowing
//    number like `1e400` to `Infinity`, which `JSON.stringify`
//    re-serializes as the bare token `null`) is treated the same as a
//    parse failure -- never eligible for a structural match -- since it
//    would otherwise canonicalize identically to a real `null` value
//    (Copilot review, PR #3225). The same applies to a bare integer
//    literal outside the IEEE-754 safe-integer range (e.g.
//    `9007199254740993` vs `9007199254740992`): `JSON.parse` rounds both
//    to the same double, so a real value change at that magnitude would
//    otherwise pass too (same review round). Known, disclosed limitation:
//    JavaScript's own-property enumeration always orders integer-like
//    string keys ("0", "1", ...) ascending ahead of other keys regardless
//    of source order, so a reorder limited to such keys is silently
//    normalized away by this approach. A custom order-preserving JSON
//    parser would close this gap but is disproportionate for this
//    issue's scope.
// 3. Prose-reflow tolerance, scoped to `.md` only (never YAML or
//    source): paragraphs (separated by one or more blank lines, where a
//    line consisting solely of horizontal whitespace also counts as
//    blank -- a Copilot review on PR #3225 caught an earlier version
//    that recognized only a bare, whitespace-free blank line) are
//    preserved as paragraph boundaries, but intra-paragraph whitespace
//    (including a mere line-wrap newline) collapses to a single space
//    before comparing. A removed blank line that merges two paragraphs
//    into one still fails (paragraph count changes); the blank-line
//    COUNT between two paragraphs is tolerated (1 vs 2+ blank lines
//    both normalize the same way). A fenced code block (``` or ~~~) is
//    compared VERBATIM, never reflow-tolerant -- an earlier version
//    applied the same reflow tolerance inside a fence too, letting a
//    real content edit hidden in a vendored code example pass as a
//    tolerated reflow (Copilot review, PR #3225).
// 4. Git file mode compared exactly (e.g. `100644` vs `100755`):
//    identical bytes with a dropped executable bit still breaks a
//    `bin/` entry point. For `--upstream-path`, mode/content/existence
//    are ALL read from `HEAD` via the same git-tree reader the target
//    side and `--upstream-ref` already use whenever `--upstream-path` is
//    genuinely the TOP LEVEL of a git work tree with a resolvable `HEAD`
//    -- not merely a directory somewhere inside one (an earlier version's
//    `--is-inside-work-tree` probe conflated the two, so a directory
//    nested inside a larger, unrelated ENCLOSING repository could read
//    paths relative to that enclosing repository's own tree instead of
//    the directory actually supplied -- Copilot review, PR #3225).
//    Reading from `HEAD` (the object database) rather than the raw
//    working tree also means a sparse-checkout-omitted-but-tracked path
//    is read correctly instead of misread as absent (same review round).
//    Only when `--upstream-path` is a plain, non-git directory does this
//    fall back to the filesystem: the OS executable bit approximates
//    mode, and a real symlink is always represented the way git itself
//    would (mode `120000`, content = the link target text) rather than
//    followed. A tracked type change in the TARGET commit (git status
//    `T`, e.g. a regular file becoming a symlink) is treated as an
//    ordinary modification rather than silently discarded (Copilot
//    review, PR #3225). For `--upstream-path`, a symlinked ANCESTOR
//    directory (e.g. `vendor -> /outside`) is refused outright rather
//    than transparently followed -- `lstat` on the final path component
//    alone never catches this, since every intermediate path segment is
//    still resolved by the OS regardless (verified empirically; same
//    review round).
// 5. Deletions: see the scope model above. For the plain-directory
//    `--upstream-path` fallback, only `ENOENT`/`ENOTDIR` from the `lstat`
//    probe count as genuine absence; any other I/O error (e.g. `EACCES`
//    on a path mid-deletion) is rethrown rather than silently treated as
//    a matching deletion, which would let an unverifiable deletion pass
//    unchecked (Copilot review, PR #3225). `--upstream-path` itself is
//    validated up front (must exist and be a directory) -- without this,
//    a missing/mistyped upstream root would make every per-file lookup
//    report absence, misclassifying an entire deletion-only import as a
//    false pure-mirror pass (same review round). `--upstream-ref` is
//    validated up front the same way (must resolve to a commit) --
//    without it, a typo'd ref combined with a `--path-prefix` matching no
//    changed paths would report `scanned: 0` and exit 0 without ever
//    having read upstream at all (same review round).
//
// Tolerated classifications (exit 0 requires every compared path to
// land in this set): `exact`, `generated-banner-only`,
// `structural-json-match`, `prose-reflow-match`,
// `deletion-matches-upstream`. Non-tolerated (exit 1 on any occurrence):
// `mode-only-mismatch`, `content-mismatch` (this also covers a path the
// commit added/modified that upstream lacks entirely, and a compound
// difference -- content otherwise tolerable but mode also differs --
// which is reported with a `detail` string naming the class it would
// otherwise have matched, rather than inventing an eighth status).
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';

/** Hardcoded scoping constants (module-level, not CLI flags -- mirrors
 * verify-workshop-integrity.mts's own WORKSHOP_ROOTS/WORKSHOP_ASSET_DIRS
 * precedent; this helper's flag surface stays intentionally narrow). */
const GENERATED_BANNER_MARKER = 'idd-generated-from';
const GENERATED_BANNER_EXTENSION = '.mjs';
const PROSE_EXTENSIONS = ['.md'];
const TOLERATED_STATUSES = new Set([
  'exact',
  'generated-banner-only',
  'structural-json-match',
  'prose-reflow-match',
  'deletion-matches-upstream',
]);
// ---------------------------------------------------------------------------
// Pure classification functions -- unit-tested independently of any git or
// filesystem I/O.
// ---------------------------------------------------------------------------
/**
 * `true` only for the CANONICAL banner syntax: a `//`-prefixed line whose
 * content, immediately after the `//` and any whitespace, starts with
 * `<marker>:` -- e.g. `// idd-generated-from: src/scripts/foo.mts`. A
 * looser "line merely contains the marker substring anywhere" predicate
 * (an earlier version of both {@link stripGeneratedBannerLine} and
 * {@link hasGeneratedBannerMarker} used exactly that) also matches an
 * unrelated comment like `// note: idd-generated-from old`, letting a
 * real edit inside THAT comment be silently stripped and tolerated too --
 * a Copilot review on PR #3225 caught this live.
 */
function isCanonicalBannerLine(line, marker) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('//')) {
    return false;
  }
  return trimmed.slice(2).trimStart().startsWith(`${marker}:`);
}
/**
 * Rule 1 (banner strip): replaces ONLY the `//`-prefixed line(s) matching
 * the canonical banner syntax (see {@link isCanonicalBannerLine}) with a
 * fixed sentinel, leaving every other line -- including an immediately
 * adjacent comment line with no blank or bare `//` separator -- byte-for-
 * byte untouched. An earlier version of this function stripped the whole
 * contiguous comment PARAGRAPH around the marker line instead of just the
 * marker line itself, which a Copilot review on PR #3225 showed collapses
 * two genuinely different adjacent comments (e.g. a safety-relevant note)
 * into the same sentinel whenever they sit in the same paragraph as the
 * banner -- reproducing exactly the "too permissive" failure mode this
 * issue's own background section warns about. Returns `content` unchanged
 * when no line matches the canonical syntax.
 */
export function stripGeneratedBannerLine(content, marker) {
  return content
    .split('\n')
    .map((line) =>
      isCanonicalBannerLine(line, marker)
        ? '<generated-banner-stripped>'
        : line,
    )
    .join('\n');
}
/** `true` iff `content` has a line matching the canonical banner syntax
 * (see {@link isCanonicalBannerLine}). Used to require BOTH sides of a
 * comparison to actually carry the banner before rule 1's tolerance
 * applies -- {@link stripGeneratedBannerLine} returns an unmarked input
 * unchanged, so without this gate an unmarked side could coincidentally
 * normalize to (or already equal) the literal `<generated-banner-stripped>`
 * sentinel and falsely match (Copilot review, PR #3225). */
export function hasGeneratedBannerMarker(content, marker) {
  return content
    .split('\n')
    .some((line) => isCanonicalBannerLine(line, marker));
}
/**
 * Rule 1 eligibility gate: `false` whenever `generatedDirs` is empty --
 * banner tolerance fails CLOSED by default (see module header). Otherwise
 * `true` only for a `.mjs` path lexically under one of `generatedDirs`
 * (`\`-normalized defensively; git itself always emits `/`-separated
 * paths).
 */
export function isGeneratedBannerEligible(path, generatedDirs) {
  if (generatedDirs.length === 0) {
    return false;
  }
  if (!path.endsWith(GENERATED_BANNER_EXTENSION)) {
    return false;
  }
  const normalizedPath = path.split('\\').join('/');
  return generatedDirs.some((dir) => {
    const normalizedDir = dir.split('\\').join('/').replace(/\/+$/, '');
    return (
      normalizedDir.length > 0 &&
      (normalizedPath === normalizedDir ||
        normalizedPath.startsWith(`${normalizedDir}/`))
    );
  });
}
/**
 * `true` iff `value` (a `JSON.parse` result) contains a non-finite number
 * (`Infinity`/`-Infinity` -- `JSON.parse` never actually produces `NaN`,
 * since JSON itself has no NaN literal, but the check is written generally
 * regardless) anywhere in its structure. `JSON.parse` silently converts an
 * overflowing JSON number (e.g. `1e400`) to `Infinity`, and
 * `JSON.stringify` then re-serializes ANY non-finite number as the bare
 * token `null` -- so a real value change from an overflowing number to a
 * literal `null` would otherwise canonicalize identically and pass as a
 * structural match (Copilot review, PR #3225; verified empirically:
 * `JSON.stringify(JSON.parse('{"x":1e400}'))` and
 * `JSON.stringify(JSON.parse('{"x":null}'))` both yield `{"x":null}`).
 */
function hasNonFiniteNumber(value) {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasNonFiniteNumber);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(hasNonFiniteNumber);
  }
  return false;
}
/**
 * `true` iff `content` contains a bare JSON integer literal (no `.` or
 * `e`/`E` -- those are handled by {@link hasNonFiniteNumber} instead, or
 * are an inherent, universal IEEE-754 float-precision fact this check
 * does not attempt to police) outside any string literal, whose numeric
 * value exceeds `Number.isSafeInteger`'s range. `JSON.parse` represents
 * every JSON number as an IEEE-754 double, which cannot distinguish two
 * *different* integers once they exceed `Number.MAX_SAFE_INTEGER` --
 * `JSON.parse('9007199254740993')` and `JSON.parse('9007199254740992')`
 * both round to the SAME double, so a real value change at that
 * magnitude would otherwise canonicalize identically (Copilot review, PR
 * #3225; verified empirically). String literals are masked first (a
 * digit sequence inside a JSON string value is never numerically parsed,
 * so it carries no such risk).
 */
function hasUnsafeIntegerLiteral(content) {
  const withoutStrings = content.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const integerTokenPattern = /-?\d+(?![.\deE])/g;
  let match = integerTokenPattern.exec(withoutStrings);
  while (match !== null) {
    if (!Number.isSafeInteger(Number(match[0]))) {
      return true;
    }
    match = integerTokenPattern.exec(withoutStrings);
  }
  return false;
}
/**
 * Rule 2 (JSON structural): parses `content` and re-serializes it via
 * `JSON.stringify`, returning the canonical string, or `null` when
 * `content` is not valid JSON, contains a non-finite number (see
 * {@link hasNonFiniteNumber}), or contains an integer literal outside the
 * IEEE-754 safe-integer range (see {@link hasUnsafeIntegerLiteral}) --
 * every one of those is treated the same as a parse failure (never
 * eligible for a structural match) rather than risk the false positives
 * above. Deliberately literal, not a deep-equal -- see the module
 * header's disclosed integer-like-key limitation.
 */
export function canonicalizeJson(content) {
  if (hasUnsafeIntegerLiteral(content)) {
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    return hasNonFiniteNumber(parsed) ? null : JSON.stringify(parsed);
  } catch {
    return null;
  }
}
/** Rule 3 eligibility gate: case-insensitive `.md` suffix match. */
export function isProseExtension(path) {
  const lower = path.toLowerCase();
  return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
/**
 * Rule 3 (prose reflow): normalizes `content` by splitting on paragraph
 * breaks (one or more blank lines), collapsing all whitespace WITHIN each
 * paragraph (including an ordinary line-wrap newline) to a single space,
 * trimming, and dropping empty paragraphs -- then rejoining with a
 * canonical double newline. Two contents that differ only in wrap width or
 * blank-line COUNT between paragraphs normalize identically; one where a
 * blank line was removed entirely (merging two paragraphs into one) does
 * not.
 *
 * A line consisting solely of horizontal whitespace (spaces/tabs) is first
 * normalized to a truly empty line, so it counts as a paragraph-separating
 * blank line here exactly as CommonMark treats it -- without this pass, a
 * run like `"first\n  \nsecond"` (a blank line carrying trailing
 * whitespace) never matches `\n{2,}` on its own and silently merges into
 * one paragraph, letting a genuinely removed paragraph break slip through
 * as a tolerated reflow (Copilot review, PR #3225).
 *
 * A fenced code block (``` or ~~~, CommonMark §4.5) is compared VERBATIM,
 * never reflow-tolerant -- a Copilot review on PR #3225 pointed out that
 * this rule's whole point is proving a vendored file is unchanged, and a
 * real content edit hiding inside a fenced example (the module header's
 * own previously-disclosed limitation) silently passed as a tolerated
 * reflow before this fix. {@link splitFencedSegments} isolates each fence
 * as its own opaque segment; only the prose OUTSIDE fenced blocks gets
 * paragraph/whitespace normalization.
 */
export function normalizeProseWhitespace(content) {
  return splitFencedSegments(content.replace(/\r\n/g, '\n'))
    .map((segment) =>
      segment.type === 'code'
        ? segment.text
        : normalizeProseSegment(segment.text),
    )
    .join('\n');
}
function normalizeProseSegment(content) {
  const unified = content
    .split('\n')
    .map((line) => (/^[ \t]*$/.test(line) ? '' : line))
    .join('\n');
  const paragraphs = unified
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.join('\n\n');
}
/**
 * Splits `content` (already `\n`-normalized) into alternating prose/code
 * segments on CommonMark fenced-code-block boundaries (``` or ~~~, 3+
 * characters, a closing fence needing only the same character at least as
 * long, with nothing but whitespace after it -- mirrors
 * `verify-workshop-integrity.mts`'s own `stripFencedCodeBlocks` fence-
 * matching rules in this same repository). An unterminated fence at EOF
 * keeps everything from the opening fence onward as `code` (verbatim)
 * rather than misreading the remainder as reflow-tolerant prose.
 */
function splitFencedSegments(content) {
  const lines = content.split('\n');
  const segments = [];
  let current = [];
  let currentType = 'prose';
  let fence = null;
  const flush = () => {
    segments.push({ type: currentType, text: current.join('\n') });
    current = [];
  };
  for (const line of lines) {
    const openMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (openMatch) {
      const fenceMarker = openMatch[1];
      const fenceChar = fenceMarker[0];
      const fenceLen = fenceMarker.length;
      const onlyWhitespaceAfter = /^\s*$/.test(openMatch[2]);
      if (fence === null) {
        flush();
        currentType = 'code';
        fence = { char: fenceChar, length: fenceLen };
        current.push(line);
        continue;
      }
      if (
        fenceChar === fence.char &&
        fenceLen >= fence.length &&
        onlyWhitespaceAfter
      ) {
        current.push(line);
        flush();
        currentType = 'prose';
        fence = null;
        continue;
      }
    }
    current.push(line);
  }
  flush();
  return segments;
}
/** Content-only classification (rules 1-3), ignoring mode entirely. */
export function classifyFileContent(params) {
  const { path, upstreamContent, targetContent, generatedDirs } = params;
  if (upstreamContent.equals(targetContent)) {
    return { contentClass: 'exact-bytes' };
  }
  if (isGeneratedBannerEligible(path, generatedDirs)) {
    const upstreamText = upstreamContent.toString('utf8');
    const targetText = targetContent.toString('utf8');
    if (
      hasGeneratedBannerMarker(upstreamText, GENERATED_BANNER_MARKER) &&
      hasGeneratedBannerMarker(targetText, GENERATED_BANNER_MARKER) &&
      stripGeneratedBannerLine(upstreamText, GENERATED_BANNER_MARKER) ===
        stripGeneratedBannerLine(targetText, GENERATED_BANNER_MARKER)
    ) {
      return { contentClass: 'generated-banner-only' };
    }
  }
  if (path.toLowerCase().endsWith('.json')) {
    const upstreamCanonical = canonicalizeJson(
      upstreamContent.toString('utf8'),
    );
    const targetCanonical = canonicalizeJson(targetContent.toString('utf8'));
    if (
      upstreamCanonical !== null &&
      targetCanonical !== null &&
      upstreamCanonical === targetCanonical
    ) {
      return { contentClass: 'structural-json-match' };
    }
  }
  if (isProseExtension(path)) {
    if (
      normalizeProseWhitespace(upstreamContent.toString('utf8')) ===
      normalizeProseWhitespace(targetContent.toString('utf8'))
    ) {
      return { contentClass: 'prose-reflow-match' };
    }
  }
  return { contentClass: 'content-mismatch' };
}
/**
 * Combines content classification (rules 1-3) with the mode comparison
 * (rule 4) into one final status. `upstreamContent: null` means the path
 * is entirely absent from upstream (the added/modified case rule 5 does
 * not cover). A "pure" single-axis difference (byte-identical content with
 * a differing mode, or a tolerated content class with an identical mode)
 * gets its own named status; a compound difference (tolerated content
 * class AND a mode difference) is reported as `content-mismatch` with a
 * `detail` naming the class it would otherwise have matched, rather than
 * inventing an eighth status.
 */
export function classifyComparedFile(params) {
  const {
    path,
    upstreamContent,
    targetContent,
    upstreamMode,
    targetMode,
    generatedDirs,
  } = params;
  if (upstreamContent === null) {
    return {
      status: 'content-mismatch',
      detail: 'path is absent from upstream',
    };
  }
  const { contentClass } = classifyFileContent({
    path,
    upstreamContent,
    targetContent,
    generatedDirs,
  });
  const modesEqual =
    upstreamMode !== null && targetMode !== null && upstreamMode === targetMode;
  if (contentClass === 'exact-bytes') {
    return modesEqual
      ? { status: 'exact' }
      : {
          status: 'mode-only-mismatch',
          detail:
            `content is byte-identical but mode differs (upstream ` +
            `${upstreamMode ?? 'unknown'}, target ${targetMode ?? 'unknown'})`,
        };
  }
  if (contentClass === 'content-mismatch') {
    return { status: 'content-mismatch' };
  }
  if (modesEqual) {
    return { status: contentClass };
  }
  return {
    status: 'content-mismatch',
    detail:
      `content otherwise matches as ${contentClass}, but mode differs ` +
      `(upstream ${upstreamMode ?? 'unknown'}, target ${targetMode ?? 'unknown'})`,
  };
}
/**
 * Rule 5 (deletions): the target commit deleted this path. `upstreamExists`
 * says whether upstream still has it at the given ref -- `true` is a
 * genuine mismatch (target dropped something upstream still carries),
 * `false` is a legitimate matching deletion.
 */
export function classifyDeletedFile(params) {
  return params.upstreamExists
    ? {
        status: 'content-mismatch',
        detail: 'target deleted this path but upstream still has it',
      }
    : {
        status: 'deletion-matches-upstream',
        detail: 'target deleted this path and upstream lacks it too',
      };
}
export function isTolerated(status) {
  return TOLERATED_STATUSES.has(status);
}
export function computeExitCode(results) {
  return results.every((result) => isTolerated(result.status)) ? 0 : 1;
}
/**
 * Keeps repository discovery tied to the requested `cwd` rather than to
 * ambient Git overrides inherited from a hook, wrapper, or parent process
 * -- without this, an inherited `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_INDEX_FILE`/`GIT_COMMON_DIR`/`GIT_OBJECT_DIRECTORY` could silently
 * redirect every git call in this file onto the WRONG repository,
 * producing a proof about a repository this run never intended to inspect
 * (Copilot review, PR #3225; matches the same class of bug this repo
 * already fixed once in `idd-roadmap-audit-execute.mts`, issue #2225). A
 * local, file-scoped port of that same `sanitizedGitEnvironment` --
 * neither file exports it for the other to import.
 */
function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}
function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: sanitizedGitEnvironment(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}
/** `git diff --name-status --no-renames <base>..<ref>`, optionally scoped
 * to `pathPrefixes` as pathspecs. Recognizes A/M/D plus T (a tracked type
 * change, folded into M -- see the module header); throws on any other
 * status letter rather than silently discarding it (renames are disabled
 * via `--no-renames`, so none of R/C is ever expected here). */
function listChangedPaths(targetRoot, baseRef, targetRef, pathPrefixes) {
  const args = [
    'diff',
    '--name-status',
    '--no-renames',
    // -z: NUL-delimited, unquoted output. Without it, git's default
    // core.quotePath=true C-quotes any non-ASCII byte in a path (e.g.
    // "caf\303\251.mjs" for "café.mjs"), and that mangled string would
    // then be used verbatim in every downstream ls-tree/show/fs lookup
    // -- silently failing to resolve the real path (a false
    // content-mismatch for an add/modify, or worse, a false
    // deletion-matches-upstream for a delete, since the mangled path
    // would never resolve against the real upstream tree either). -z
    // sidesteps quoting entirely, matching this repo's own
    // local-worktree-occupancy.mts precedent for the same reason.
    '-z',
    `${baseRef}..${targetRef}`,
  ];
  if (pathPrefixes.length > 0) {
    args.push('--', ...pathPrefixes);
  }
  const result = runGit(targetRoot, args);
  if (result.status !== 0) {
    throw new Error(
      `git diff failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  // With --no-renames, each -z record is exactly two NUL-terminated
  // tokens: the status letter, then the path (verified empirically --
  // unlike the non -z form, the status and path are NOT tab-joined
  // within one token). git's -z output always ends in a trailing NUL, so
  // split('\0') always yields an odd number of tokens for N entries
  // (2N + 1); the loop bound below (`i + 1 < tokens.length`) is what
  // excludes that final empty token, never reading it as a status byte.
  const tokens = result.stdout.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const rawStatus = tokens[i].charAt(0);
    const path = tokens[i + 1];
    if (path === undefined || path.length === 0) {
      continue;
    }
    let changeType;
    if (rawStatus === 'A' || rawStatus === 'M' || rawStatus === 'D') {
      changeType = rawStatus;
    } else if (rawStatus === 'T') {
      // A tracked type change (e.g. a regular file becoming a symlink, or
      // vice versa) is a real, content-relevant change that this diff
      // must still compare -- treat it the same as an ordinary
      // modification rather than silently discarding it, which would let
      // a commit consisting solely of such a change report "0 files
      // compared" and exit 0 despite genuinely diverging from upstream
      // (Copilot review, PR #3225).
      changeType = 'M';
    } else {
      // Any other status (U for unmerged, or an unrecognized future git
      // status letter) is unsupported -- fail loudly rather than risk
      // silently skipping a real change and reporting a false pass.
      throw new Error(
        `git diff reported an unsupported status "${rawStatus}" for ` +
          `${path} -- verify-import-mirror only understands A/M/D/T ` +
          '(renames are disabled via --no-renames)',
      );
    }
    entries.push({ path, changeType });
  }
  return entries;
}
/** `git ls-tree <ref> -- <path>`: authoritative existence + mode in one
 * call. Empty output (exit 0) means the path is absent from that tree; a
 * non-zero exit means `ref` itself could not be resolved -- fails loudly
 * rather than treating that as absence. */
function readTreeMode(repoRoot, ref, path) {
  const result = runGit(repoRoot, ['ls-tree', ref, '--', path]);
  if (result.status !== 0) {
    throw new Error(
      `git ls-tree failed for ${ref}:${path} (${result.status}): ${result.stderr.trim()}`,
    );
  }
  const text = result.stdout.toString('utf8').trim();
  if (text.length === 0) {
    return null;
  }
  return text.split(/\s+/)[0] ?? null;
}
/** Reads one path's mode + blob content at `ref` inside `repoRoot`.
 * Existence is decided solely by `readTreeMode` -- if it reports the path
 * present but `git show` then fails, that is a genuine error, not silent
 * absence. */
function readTargetEntry(repoRoot, ref, path) {
  const mode = readTreeMode(repoRoot, ref, path);
  if (mode === null) {
    return null;
  }
  const result = spawnSync('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
    env: sanitizedGitEnvironment(),
  });
  if (result.status !== 0) {
    const stderrText = (result.stderr ?? Buffer.alloc(0)).toString('utf8');
    throw new Error(
      `git show failed for ${ref}:${path} (${result.status}): ${stderrText.trim()}`,
    );
  }
  return { mode, content: result.stdout ?? Buffer.alloc(0) };
}
function resolveUpstreamRef(remote, ref) {
  return remote === null ? ref : `${remote}/${ref}`;
}
/**
 * `true` iff `upstreamPath` is itself the TOP LEVEL of a git work tree
 * with a resolvable `HEAD` commit -- not merely "inside" one somewhere.
 * `git rev-parse --is-inside-work-tree` (an earlier version's probe)
 * reports `"true"` even when `upstreamPath` is a plain subdirectory
 * nested inside a LARGER, unrelated ENCLOSING repository; treating that
 * as "this is our checkout" would then read paths relative to the
 * enclosing repository's own tree, not the directory actually supplied
 * (Copilot review, PR #3225). Comparing against `--show-toplevel`
 * (`realpath`-normalized on both sides, falling back to lexical
 * normalization when `realpath` fails) closes that gap. An unborn `HEAD`
 * (a freshly `git init`'d checkout with no commits yet) has a toplevel
 * but no resolvable commit -- checked separately so the caller can fall
 * back to the plain-filesystem path instead of a later git call failing
 * loudly for a case this rules out up front.
 */
function isUpstreamPathGitWorkTreeRoot(upstreamPath) {
  const toplevelProbe = runGit(upstreamPath, ['rev-parse', '--show-toplevel']);
  if (toplevelProbe.status !== 0) {
    return false;
  }
  const toplevel = toplevelProbe.stdout.toString('utf8').trim();
  const normalize = (candidate) => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  if (normalize(toplevel) !== normalize(upstreamPath)) {
    return false;
  }
  const headProbe = runGit(upstreamPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  ]);
  return headProbe.status === 0;
}
/**
 * `true` only for the two `lstat` error codes that legitimately mean "this
 * path isn't there": absence itself (`ENOENT`) or an ancestor path
 * component that isn't a directory (`ENOTDIR`). Any other code (e.g.
 * `EACCES` on a path mid-deletion, or another I/O error) is NOT proof of
 * absence -- {@link readUpstreamEntryFromPath} rethrows those instead of
 * silently treating them as a deletion, which would let an unverifiable
 * deletion pass as `deletion-matches-upstream` instead of failing closed
 * (Copilot review, PR #3225).
 */
export function isAbsenceErrorCode(code) {
  return code === 'ENOENT' || code === 'ENOTDIR';
}
/**
 * `true` iff any ANCESTOR directory component of `relativePath` (never the
 * final component itself -- the caller's own `lstat` on the full path
 * already handles that) is a symlink, walked one component at a time from
 * `root`. Plain path joining (`join(root, relativePath)`) then a single
 * `lstat` on the *full* path only ever inspects the final component --
 * every intermediate segment is still transparently followed by the OS
 * during normal path resolution, so a symlinked ancestor (e.g.
 * `vendor -> /outside`) could otherwise read and accept content from
 * entirely outside the intended upstream checkout (Copilot review, PR
 * #3225; verified empirically: `lstat` on the final component reports
 * `isSymbolicLink: false` while the read still resolves through the
 * symlinked ancestor). A missing ancestor is not itself a symlink --
 * `false` in that case; the caller's own `lstat` on the full path reports
 * the genuine absence.
 */
function hasSymlinkAncestor(root, relativePath) {
  const segments = relativePath
    .split('/')
    .filter((segment) => segment.length > 0);
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isAbsenceErrorCode(error.code)) {
        return false;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}
/**
 * Reads one path under `--upstream-path`. When `upstreamPath` is itself
 * the top level of a git work tree with a resolvable `HEAD` (see
 * {@link isUpstreamPathGitWorkTreeRoot}), delegates entirely to the same
 * git-tree reader the target side and `--upstream-ref` already use
 * (`readTargetEntry`, reading `HEAD`) instead of the raw filesystem --
 * this reads from the object database, not the (possibly sparse,
 * possibly stale) working tree, so a sparse-checkout-omitted but
 * `HEAD`-tracked path is still read correctly rather than misread as
 * absent (Copilot review, PR #3225), and it can never be confused with
 * an ENCLOSING repository `upstreamPath` merely happens to sit inside
 * (same review round). Otherwise (a plain, non-git directory) falls back
 * to `lstat` (never `stat`/`readFileSync` directly, so a symlink is
 * detected FIRST: a git tree represents a symlink as mode `120000` with
 * the link's target text as its blob content, never the followed file's
 * own content or mode -- `readFileSync`/`statSync` would otherwise
 * silently follow it). `lstat` also correctly reports a BROKEN symlink as
 * present (unlike `existsSync`, which follows the link and would report
 * a broken one as absent), matching how git itself always tracks the
 * symlink entry regardless of whether its target exists on disk. Either
 * branch first rejects a symlinked ANCESTOR directory outright -- see
 * {@link hasSymlinkAncestor} -- rather than silently following it, since
 * the git tree we're comparing against has no such symlink to justify it.
 */
function readUpstreamEntryFromPath(upstreamPath, path) {
  if (hasSymlinkAncestor(upstreamPath, path)) {
    throw new Error(
      `${path}: an ancestor directory under --upstream-path is a symlink -- ` +
        'refusing to follow it (it could resolve outside the intended upstream checkout)',
    );
  }
  if (isUpstreamPathGitWorkTreeRoot(upstreamPath)) {
    return readTargetEntry(upstreamPath, 'HEAD', path);
  }
  const absolute = join(upstreamPath, path);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (isAbsenceErrorCode(error.code)) {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return {
      mode: '120000',
      content: Buffer.from(readlinkSync(absolute), 'utf8'),
    };
  }
  const isExecutable = (stats.mode & 0o111) !== 0;
  return {
    mode: isExecutable ? '100755' : '100644',
    content: readFileSync(absolute),
  };
}
function readUpstreamEntryFromRef(targetRoot, remote, ref, path) {
  return readTargetEntry(targetRoot, resolveUpstreamRef(remote, ref), path);
}
function readUpstreamEntry(options, path) {
  if (options.upstreamPath !== null) {
    return readUpstreamEntryFromPath(options.upstreamPath, path);
  }
  // parseArgs() below guarantees exactly one of upstreamPath/upstreamRef is
  // non-null before runVerification is ever reached from the CLI.
  return readUpstreamEntryFromRef(
    options.targetRoot,
    options.upstreamRemote,
    options.upstreamRef,
    path,
  );
}
/** Builds one `FileResult`, omitting `detail` entirely (rather than
 * setting it to `undefined`) when the classification carried none -- an
 * omitted optional property, not a present-but-undefined one, matches
 * `FileResult`'s own `detail?: string` contract and keeps a plain
 * `assert.deepEqual`/`deepStrictEqual` comparison against a hand-written
 * expected object working without every caller needing to spell out
 * `detail: undefined`. */
function buildFileResult(path, changeType, classification) {
  return classification.detail === undefined
    ? { path, changeType, status: classification.status }
    : {
        path,
        changeType,
        status: classification.status,
        detail: classification.detail,
      };
}
/**
 * Fails loudly when `upstreamPath` doesn't exist or isn't a directory,
 * rather than letting the run proceed and discover it only indirectly:
 * every per-file `lstat` under a missing/mistyped `--upstream-path` would
 * otherwise report `ENOENT`/`ENOTDIR`, which {@link isAbsenceErrorCode}
 * (correctly, for a genuine per-file absence) treats as "upstream lacks
 * this path" -- for a deletion-only import, that misclassifies every
 * deleted file as `deletion-matches-upstream` and exits 0, a false proof
 * of a pure mirror caused by nothing more than an operator typo (Copilot
 * review, PR #3225).
 */
function validateUpstreamPathRoot(upstreamPath) {
  let stats;
  try {
    stats = statSync(upstreamPath);
  } catch {
    throw new Error(`--upstream-path does not exist: ${upstreamPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`--upstream-path is not a directory: ${upstreamPath}`);
  }
}
/**
 * Fails loudly when the resolved `--upstream-ref` doesn't resolve to a
 * commit, rather than letting the run proceed and discover it only
 * indirectly. `readUpstreamEntry` is only ever called from inside the
 * per-changed-path loop below, so a typo'd ref (or a missing remote)
 * combined with a `--path-prefix` that matches no changed paths would
 * otherwise report `scanned: 0` and exit 0 without ever having read a
 * single byte from upstream -- the `--upstream-ref` sibling of
 * {@link validateUpstreamPathRoot}'s gap (Copilot review, PR #3225).
 */
function validateUpstreamRef(targetRoot, remote, ref) {
  const resolvedRef = resolveUpstreamRef(remote, ref);
  const result = runGit(targetRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${resolvedRef}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `--upstream-ref does not resolve to a commit: ${resolvedRef}`,
    );
  }
}
export function runVerification(options) {
  if (options.upstreamPath !== null) {
    validateUpstreamPathRoot(options.upstreamPath);
  } else {
    // parseArgs() guarantees exactly one of upstreamPath/upstreamRef is
    // non-null before the CLI ever reaches here.
    validateUpstreamRef(
      options.targetRoot,
      options.upstreamRemote,
      options.upstreamRef,
    );
  }
  const diffEntries = listChangedPaths(
    options.targetRoot,
    options.targetBaseRef,
    options.targetRef,
    options.pathPrefixes,
  );
  const results = [];
  for (const entry of diffEntries) {
    const upstreamEntry = readUpstreamEntry(options, entry.path);
    if (entry.changeType === 'D') {
      const classification = classifyDeletedFile({
        upstreamExists: upstreamEntry !== null,
      });
      results.push(
        buildFileResult(entry.path, entry.changeType, classification),
      );
      continue;
    }
    const targetEntry = readTargetEntry(
      options.targetRoot,
      options.targetRef,
      entry.path,
    );
    if (targetEntry === null) {
      throw new Error(
        `internal: ${entry.path} reported as ${entry.changeType} but is absent from ${options.targetRef}`,
      );
    }
    const classification = classifyComparedFile({
      path: entry.path,
      upstreamContent: upstreamEntry?.content ?? null,
      targetContent: targetEntry.content,
      upstreamMode: upstreamEntry?.mode ?? null,
      targetMode: targetEntry.mode,
      generatedDirs: options.generatedDirs,
    });
    results.push(buildFileResult(entry.path, entry.changeType, classification));
  }
  const counts = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return { scanned: results.length, results, counts };
}
// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `target-root:`): tests/flag-name-matrix.test.mts scans this file's
// *compiled* .mjs source text for quoted flag literals such as the
// --target-root spec key below. See cli-args.mts's module header for the
// full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls parseArgs()
// synchronously at module-evaluation time, and a `const` declared after
// that point is still in the temporal dead zone when the trigger fires.
const VERIFY_IMPORT_MIRROR_FLAG_SPEC = {
  '--target-root': { type: 'string' },
  '--target-ref': { type: 'string' },
  '--target-base-ref': { type: 'string' },
  '--upstream-path': { type: 'string' },
  '--upstream-ref': { type: 'string' },
  '--upstream-remote': { type: 'string' },
  '--path-prefix': { type: 'string', multiple: true },
  '--generated-dir': { type: 'string', multiple: true },
  '--format': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
if (import.meta.main) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  let report;
  try {
    report = runVerification({
      targetRoot: resolve(args.targetRoot),
      targetRef: args.targetRef,
      targetBaseRef: args.targetBaseRef,
      upstreamPath:
        args.upstreamPath === null ? null : resolve(args.upstreamPath),
      upstreamRef: args.upstreamRef,
      upstreamRemote: args.upstreamRemote,
      pathPrefixes: args.pathPrefixes,
      generatedDirs: args.generatedDirs,
    });
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
  process.exit(computeExitCode(report.results));
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, VERIFY_IMPORT_MIRROR_FLAG_SPEC);
  const targetRoot = values['target-root'] ?? process.cwd();
  const targetRef = values['target-ref'] ?? 'HEAD';
  const targetBaseRef = values['target-base-ref'] ?? `${targetRef}^`;
  const upstreamPath = values['upstream-path'] ?? null;
  const upstreamRef = values['upstream-ref'] ?? null;
  const upstreamRemote = values['upstream-remote'] ?? null;
  const pathPrefixes = values['path-prefix'] ?? [];
  const generatedDirs = values['generated-dir'] ?? [];
  const format = values.format ?? 'table';
  // help-only invocations (e.g. `--help` alone) must not trip the
  // upstream-source validation below.
  if (!help) {
    if (upstreamPath === null && upstreamRef === null) {
      throw new Error(
        'exactly one of --upstream-path or --upstream-ref is required',
      );
    }
    if (upstreamPath !== null && upstreamRef !== null) {
      throw new Error(
        '--upstream-path and --upstream-ref are mutually exclusive',
      );
    }
    if (upstreamRemote !== null && upstreamRef === null) {
      throw new Error('--upstream-remote requires --upstream-ref');
    }
  }
  if (format !== 'json' && format !== 'table') {
    throw new Error(`--format must be one of json,table (got "${format}")`);
  }
  return {
    targetRoot,
    targetRef,
    targetBaseRef,
    upstreamPath,
    upstreamRef,
    upstreamRemote,
    pathPrefixes,
    generatedDirs,
    format,
    help,
  };
}
function printTable(report) {
  if (report.scanned === 0) {
    console.log('0 files compared');
    return;
  }
  console.log(`compared: ${report.scanned}`);
  for (const result of report.results) {
    const marker = isTolerated(result.status) ? 'ok' : 'FAIL';
    const detail = result.detail ? ` -- ${result.detail}` : '';
    console.log(
      `  [${marker}] ${result.status} ${result.changeType} ${result.path}${detail}`,
    );
  }
}
function printUsage() {
  console.log(`usage: node scripts/verify-import-mirror.mjs --upstream-path <dir> | --upstream-ref <ref> [options]

Proves a vendoring commit (--target-ref, default HEAD) is a pure mirror
of an upstream commit: classifies every path the commit added, modified,
or deleted against the corresponding path in an upstream tree. Exits 0
when every compared path is tolerated, 1 when any is a genuine
mismatch, 2 on a usage error.

Upstream source (exactly one required):
  --upstream-path <dir>      local upstream checkout directory
  --upstream-ref <ref>       ref to resolve inside this repo's own remotes
  --upstream-remote <name>   remote name to qualify --upstream-ref with
                             (resolves to "<name>/<ref>"); requires
                             --upstream-ref

Target commit:
  --target-root <dir>        target git repository (default: cwd)
  --target-ref <ref>         commit under verification (default: HEAD)
  --target-base-ref <ref>    pre-import baseline to diff against
                             (default: "<target-ref>^")

Scoping:
  --path-prefix <prefix>     restrict the compared diff to this pathspec
                             (repeatable)
  --generated-dir <dir>      directory under which an emitted .mjs file's
                             idd-generated-from banner line is tolerated
                             as the sole difference (repeatable; rule 1
                             never applies to any file when omitted)

Output:
  --format json|table        output format (default: table)
  --help, -h                 show this help
`);
}
