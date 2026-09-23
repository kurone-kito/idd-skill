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
// The five classification rules (issue #3216's own specification,
// itself distilled from a reporter's field experience -- three of the
// five exist only because their first version of this check was too
// permissive):
//
// 1. Exact byte-for-byte match, then a narrower "generated-banner-only"
//    tolerance for an emitted `.mjs` file whose `idd-generated-from`
//    banner line is the ONLY difference. This strips ONLY the exact
//    `//`-prefixed line(s) that themselves contain the marker -- never a
//    whole surrounding comment paragraph, which would tolerate an edited
//    adjacent safety/prose comment too (a Copilot review on PR #3225
//    caught an earlier, paragraph-wide version of this stripping doing
//    exactly that). Both sides must actually carry the marker for this
//    tolerance to apply at all -- an unmarked side is never coerced into
//    matching a marked one via the stripped sentinel. This rule
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
//    trailing newline, spacing) is tolerated. Known, disclosed
//    limitation: JavaScript's own-property enumeration always orders
//    integer-like string keys ("0", "1", ...) ascending ahead of other
//    keys regardless of source order, so a reorder limited to such keys
//    is silently normalized away by this approach. A custom order-
//    preserving JSON parser would close this gap but is disproportionate
//    for this issue's scope.
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
//    both normalize the same way). Known, disclosed limitation: a
//    fenced code block inside the Markdown file also gets reflow
//    tolerance -- there is no CommonMark-aware masking here.
// 4. Git file mode compared exactly (e.g. `100644` vs `100755`):
//    identical bytes with a dropped executable bit still breaks a
//    `bin/` entry point. For `--upstream-path` (a plain directory), the
//    exact git-tracked mode is preferred when that directory is itself
//    a git work tree; otherwise the OS executable bit approximates it
//    -- except a real symlink, which is always represented the way git
//    itself would (mode `120000`, content = the link target text)
//    rather than followed, matching how the target side's own git-tree
//    reads already treat one (Copilot review, PR #3225). A tracked type
//    change (git status `T`, e.g. a regular file becoming a symlink) is
//    treated as an ordinary modification rather than silently discarded
//    (same review round).
// 5. Deletions: see the scope model above.
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
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mts';

/** Hardcoded scoping constants (module-level, not CLI flags -- mirrors
 * verify-workshop-integrity.mts's own WORKSHOP_ROOTS/WORKSHOP_ASSET_DIRS
 * precedent; this helper's flag surface stays intentionally narrow). */
const GENERATED_BANNER_MARKER = 'idd-generated-from';
const GENERATED_BANNER_EXTENSION = '.mjs';
const PROSE_EXTENSIONS = ['.md'];

export type ContentClass =
  | 'exact-bytes'
  | 'generated-banner-only'
  | 'structural-json-match'
  | 'prose-reflow-match'
  | 'content-mismatch';

export type CompareStatus =
  | 'exact'
  | 'generated-banner-only'
  | 'structural-json-match'
  | 'prose-reflow-match'
  | 'mode-only-mismatch'
  | 'deletion-matches-upstream'
  | 'content-mismatch';

const TOLERATED_STATUSES: ReadonlySet<CompareStatus> = new Set([
  'exact',
  'generated-banner-only',
  'structural-json-match',
  'prose-reflow-match',
  'deletion-matches-upstream',
]);

export interface FileResult {
  path: string;
  changeType: 'A' | 'M' | 'D';
  status: CompareStatus;
  detail?: string;
}

export interface Report {
  scanned: number;
  results: FileResult[];
  counts: Partial<Record<CompareStatus, number>>;
}

export interface VerifyOptions {
  targetRoot: string;
  targetRef: string;
  targetBaseRef: string;
  upstreamPath: string | null;
  upstreamRef: string | null;
  upstreamRemote: string | null;
  pathPrefixes: readonly string[];
  generatedDirs: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure classification functions -- unit-tested independently of any git or
// filesystem I/O.
// ---------------------------------------------------------------------------

/**
 * Rule 1 (banner strip): replaces ONLY the `//`-prefixed line(s) that
 * themselves contain `marker` with a fixed sentinel, leaving every other
 * line -- including an immediately adjacent comment line with no blank or
 * bare `//` separator -- byte-for-byte untouched. An earlier version of
 * this function stripped the whole contiguous comment PARAGRAPH around the
 * marker line instead of just the marker line itself, which a Copilot
 * review on PR #3225 showed collapses two genuinely different adjacent
 * comments (e.g. a safety-relevant note) into the same sentinel whenever
 * they sit in the same paragraph as the banner -- reproducing exactly the
 * "too permissive" failure mode this issue's own background section warns
 * about. Returns `content` unchanged when no line contains the marker.
 */
export function stripGeneratedBannerLine(
  content: string,
  marker: string,
): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') && trimmed.includes(marker)
        ? '<generated-banner-stripped>'
        : line;
    })
    .join('\n');
}

/** `true` iff `content` has a `//`-prefixed line containing `marker`. Used
 * to require BOTH sides of a comparison to actually carry the banner
 * before rule 1's tolerance applies -- {@link stripGeneratedBannerLine}
 * returns an unmarked input unchanged, so without this gate an unmarked
 * side could coincidentally normalize to (or already equal) the literal
 * `<generated-banner-stripped>` sentinel and falsely match (Copilot
 * review, PR #3225). */
export function hasGeneratedBannerMarker(
  content: string,
  marker: string,
): boolean {
  return content.split('\n').some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('//') && trimmed.includes(marker);
  });
}

/**
 * Rule 1 eligibility gate: `false` whenever `generatedDirs` is empty --
 * banner tolerance fails CLOSED by default (see module header). Otherwise
 * `true` only for a `.mjs` path lexically under one of `generatedDirs`
 * (`\`-normalized defensively; git itself always emits `/`-separated
 * paths).
 */
export function isGeneratedBannerEligible(
  path: string,
  generatedDirs: readonly string[],
): boolean {
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
 * Rule 2 (JSON structural): parses `content` and re-serializes it via
 * `JSON.stringify`, returning the canonical string, or `null` when
 * `content` is not valid JSON. Deliberately literal, not a deep-equal --
 * see the module header's disclosed integer-like-key limitation.
 */
export function canonicalizeJson(content: string): string | null {
  try {
    return JSON.stringify(JSON.parse(content));
  } catch {
    return null;
  }
}

/** Rule 3 eligibility gate: case-insensitive `.md` suffix match. */
export function isProseExtension(path: string): boolean {
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
 */
export function normalizeProseWhitespace(content: string): string {
  const unified = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (/^[ \t]*$/.test(line) ? '' : line))
    .join('\n');
  const paragraphs = unified
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.join('\n\n');
}

/** Content-only classification (rules 1-3), ignoring mode entirely. */
export function classifyFileContent(params: {
  path: string;
  upstreamContent: Buffer;
  targetContent: Buffer;
  generatedDirs: readonly string[];
}): { contentClass: ContentClass } {
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
export function classifyComparedFile(params: {
  path: string;
  upstreamContent: Buffer | null;
  targetContent: Buffer;
  upstreamMode: string | null;
  targetMode: string | null;
  generatedDirs: readonly string[];
}): { status: CompareStatus; detail?: string } {
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
export function classifyDeletedFile(params: { upstreamExists: boolean }): {
  status: 'deletion-matches-upstream' | 'content-mismatch';
  detail: string;
} {
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

export function isTolerated(status: CompareStatus): boolean {
  return TOLERATED_STATUSES.has(status);
}

export function computeExitCode(
  results: readonly { status: CompareStatus }[],
): number {
  return results.every((result) => isTolerated(result.status)) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Git plumbing -- impure I/O, exercised by the CLI smoke test rather than
// unit-tested in isolation (matches this repo's convention of unit-testing
// the pure classification layer and smoke-testing the wiring against a real
// temp git repo).
// ---------------------------------------------------------------------------

interface DiffEntry {
  path: string;
  changeType: 'A' | 'M' | 'D';
}

interface TreeEntry {
  mode: string;
  content: Buffer;
}

function runGit(
  cwd: string,
  args: string[],
): { status: number; stdout: Buffer; stderr: string } {
  const result = spawnSync('git', args, { cwd });
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
function listChangedPaths(
  targetRoot: string,
  baseRef: string,
  targetRef: string,
  pathPrefixes: readonly string[],
): DiffEntry[] {
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
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const rawStatus = tokens[i].charAt(0);
    const path = tokens[i + 1];
    if (path === undefined || path.length === 0) {
      continue;
    }
    let changeType: DiffEntry['changeType'];
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
function readTreeMode(
  repoRoot: string,
  ref: string,
  path: string,
): string | null {
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
function readTargetEntry(
  repoRoot: string,
  ref: string,
  path: string,
): TreeEntry | null {
  const mode = readTreeMode(repoRoot, ref, path);
  if (mode === null) {
    return null;
  }
  const result = spawnSync('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    const stderrText = (result.stderr ?? Buffer.alloc(0)).toString('utf8');
    throw new Error(
      `git show failed for ${ref}:${path} (${result.status}): ${stderrText.trim()}`,
    );
  }
  return { mode, content: result.stdout ?? Buffer.alloc(0) };
}

function resolveUpstreamRef(remote: string | null, ref: string): string {
  return remote === null ? ref : `${remote}/${ref}`;
}

/** Approximates a git tree mode for a path under `--upstream-path` (a
 * plain directory, not necessarily a git repo): prefers the exact
 * git-tracked mode when that directory is itself a work tree, falling
 * back to the OS executable bit otherwise (or when the file exists only
 * in that work tree's uncommitted state). */
function resolveUpstreamPathMode(
  upstreamRoot: string,
  absolutePath: string,
  relativePath: string,
): string {
  const probe = spawnSync(
    'git',
    ['-C', upstreamRoot, 'rev-parse', '--is-inside-work-tree'],
    {
      encoding: 'utf8',
    },
  );
  if (probe.status === 0 && probe.stdout.trim() === 'true') {
    const mode = readTreeMode(upstreamRoot, 'HEAD', relativePath);
    if (mode !== null) {
      return mode;
    }
  }
  const isExecutable = (statSync(absolutePath).mode & 0o111) !== 0;
  return isExecutable ? '100755' : '100644';
}

/**
 * Reads one path from a plain `--upstream-path` directory. Uses `lstat`
 * (never `stat`/`readFileSync` directly) to detect a symlink FIRST: a git
 * tree represents a symlink as mode `120000` with the link's target text
 * as its blob content, never the followed file's own content or mode.
 * `readFileSync`/`statSync` silently follow a symlink -- reporting the
 * wrong mode and content for a legitimately mirrored symlink (or throwing
 * outright when the link points at a directory) -- so a symlink is
 * special-cased here to match git's own semantics instead (Copilot
 * review, PR #3225). `lstat` also correctly reports a BROKEN symlink as
 * present (unlike `existsSync`, which follows the link and would report
 * a broken one as absent), matching how git itself always tracks the
 * symlink entry regardless of whether its target exists on disk.
 */
function readUpstreamEntryFromPath(
  upstreamPath: string,
  path: string,
): TreeEntry | null {
  const absolute = join(upstreamPath, path);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolute);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) {
    return {
      mode: '120000',
      content: Buffer.from(readlinkSync(absolute), 'utf8'),
    };
  }
  return {
    mode: resolveUpstreamPathMode(upstreamPath, absolute, path),
    content: readFileSync(absolute),
  };
}

function readUpstreamEntryFromRef(
  targetRoot: string,
  remote: string | null,
  ref: string,
  path: string,
): TreeEntry | null {
  return readTargetEntry(targetRoot, resolveUpstreamRef(remote, ref), path);
}

function readUpstreamEntry(
  options: VerifyOptions,
  path: string,
): TreeEntry | null {
  if (options.upstreamPath !== null) {
    return readUpstreamEntryFromPath(options.upstreamPath, path);
  }
  // parseArgs() below guarantees exactly one of upstreamPath/upstreamRef is
  // non-null before runVerification is ever reached from the CLI.
  return readUpstreamEntryFromRef(
    options.targetRoot,
    options.upstreamRemote,
    options.upstreamRef as string,
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
function buildFileResult(
  path: string,
  changeType: DiffEntry['changeType'],
  classification: { status: CompareStatus; detail?: string },
): FileResult {
  return classification.detail === undefined
    ? { path, changeType, status: classification.status }
    : {
        path,
        changeType,
        status: classification.status,
        detail: classification.detail,
      };
}

export function runVerification(options: VerifyOptions): Report {
  const diffEntries = listChangedPaths(
    options.targetRoot,
    options.targetBaseRef,
    options.targetRef,
    options.pathPrefixes,
  );
  const results: FileResult[] = [];
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
  const counts: Partial<Record<CompareStatus, number>> = {};
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
} as const;

if (import.meta.main) {
  let args: VerifyImportMirrorArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  let report: Report;
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
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  }

  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
  process.exit(computeExitCode(report.results));
}

interface VerifyImportMirrorArgs {
  targetRoot: string;
  targetRef: string;
  targetBaseRef: string;
  upstreamPath: string | null;
  upstreamRef: string | null;
  upstreamRemote: string | null;
  pathPrefixes: string[];
  generatedDirs: string[];
  format: 'json' | 'table';
  help: boolean;
}

function parseArgs(argv: string[]): VerifyImportMirrorArgs {
  const { values, help } = parseCliArgs(argv, VERIFY_IMPORT_MIRROR_FLAG_SPEC);

  const targetRoot =
    (values['target-root'] as string | undefined) ?? process.cwd();
  const targetRef = (values['target-ref'] as string | undefined) ?? 'HEAD';
  const targetBaseRef =
    (values['target-base-ref'] as string | undefined) ?? `${targetRef}^`;
  const upstreamPath = (values['upstream-path'] as string | undefined) ?? null;
  const upstreamRef = (values['upstream-ref'] as string | undefined) ?? null;
  const upstreamRemote =
    (values['upstream-remote'] as string | undefined) ?? null;
  const pathPrefixes = (values['path-prefix'] as string[] | undefined) ?? [];
  const generatedDirs = (values['generated-dir'] as string[] | undefined) ?? [];
  const format = (values.format as string | undefined) ?? 'table';

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

function printTable(report: Report): void {
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

function printUsage(): void {
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
