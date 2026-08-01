// idd-generated-from: src/scripts/markdown-link-audit.mts
//
// The scripts/markdown-link-audit.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { posix } from 'node:path';

// ---------------------------------------------------------------------------
// Intra-repo markdown link/anchor audit (#1697)
//
// audit-docs.mts's other checks validate mirror-pair byte equality and
// file-set membership, but never resolve a relative markdown link's target
// file or its `#fragment` against the target's actual headings. A 2026-07-28
// audit found ~20 dead anchors/references this gap let through (fixed by
// #1696); this module is the prevention pass. Pure (no direct I/O) so it can
// be unit-tested; the audit pipeline supplies the file lister and reader.
//
// Deliberately runs unconditionally (not scoped to changed files, unlike
// collectInstructionSizeBudgetViolations): a heading rename in file A orphans
// inbound anchors in files a PR never touches, which is exactly the defect
// class this guards against. collectDocBudgetDriftViolations makes the same
// choice for the same reason.
// ---------------------------------------------------------------------------

/** Declarative config for the intra-repo markdown link/anchor audit. */
export interface MarkdownLinkAuditConfig {
  id?: unknown;
  globs?: unknown;
  templateRoot?: unknown;
}

const DEFAULT_TEMPLATE_ROOT = 'idd-template/';

// The suppression marker for a narrowly-used, intentional exception (see
// audit/README.md): `<!-- audit:ignore-link -->`, or the same token with an
// optional `: reason` before the closing `-->`. Matched as a well-formed
// HTML comment (not a bare prefix -- a longer, unrelated comment that
// merely starts with this text must never suppress a real link) on the
// same source line as the link, after inline-code-span stripping, so an
// example wrapped in backticks in documentation prose never suppresses a
// real link on that same line.
const IGNORE_MARKER_PATTERN = /<!--\s*audit:ignore-link(?::[^>]*)?\s*-->/;

// One inline or reference-style link occurrence found in a scanned file.
interface LinkOccurrence {
  line: number;
  target: string;
  suppressed: boolean;
}

/**
 * GitHub's heading-id ("slug") algorithm: lowercase, delete every character
 * that is not a Unicode letter, number, hyphen, or space (punctuation is
 * deleted outright, never replaced with a hyphen or space), then convert
 * each remaining space to a hyphen without collapsing runs -- two adjacent
 * spaces (for example around a deleted em-dash) become two adjacent hyphens.
 * Validated against three live corpus anchors during implementation:
 * `#terminal-copilot-stall-recovery-contract-state-policy-markers-clock`,
 * `#a3--diagnostic-…` (the double-hyphen em-dash case), and
 * `#worktree-creation`.
 */
export function githubHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .replace(/ /g, '-');
}

// Strips the inline markdown syntax GitHub's renderer would resolve to plain
// text before slugging: backtick code spans (keep the inner text) and
// markdown links (keep the link text). Whitespace is left untouched --
// githubHeadingSlug's non-collapsing space-to-hyphen conversion depends on
// the original spacing surviving this step.
function stripHeadingMarkup(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * Extract every ATX (`#`...`######`) heading's GitHub slug from `text`, in
 * document order, with GitHub's duplicate-suffixing rule applied (the
 * second occurrence of a slug becomes `slug-1`, the third `slug-2`, ...).
 * Fence-aware (fenced code blocks are skipped) but, like audit-docs.mts's
 * own `headingSignature`, only recognizes triple-backtick fences and ATX
 * headings -- tilde fences, longer fences, and Setext headings are out of
 * scope, matching the existing precedent; a missed heading only widens the
 * checker's tolerance (a false pass), never produces a false failure.
 */
export function extractHeadingSlugs(text: string): string[] {
  const slugs: string[] = [];
  const counts = new Map<string, number>();
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const baseSlug = githubHeadingSlug(stripHeadingMarkup(match[2]));
    const seenCount = counts.get(baseSlug) ?? 0;
    counts.set(baseSlug, seenCount + 1);
    slugs.push(seenCount === 0 ? baseSlug : `${baseSlug}-${seenCount}`);
  }

  return slugs;
}

// Removes backtick code spans from a single line (blanking, not deleting --
// callers only use the result for pattern matching, not for column-accurate
// output). A code span that wraps across lines is not recognized, mirroring
// the same per-line approximation checkForbiddenPatterns'/headingSignature's
// fence handling already accepts elsewhere in this audit.
function stripInlineCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

const INLINE_LINK_PATTERN =
  /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*"|\s+'[^']*')?\)/g;
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[[^\]]+\]:\s*(\S+)/;

/**
 * Extract every inline (`[text](target)`) and reference-style
 * (`[label]: target`) link occurrence from `text`, fence-aware and with
 * inline code spans stripped first so example link syntax shown as code is
 * never mistaken for a real link. A line carrying a well-formed
 * `IGNORE_MARKER_PATTERN` comment (after code-span stripping, so a
 * documentation example of the marker wrapped in backticks never
 * suppresses a real link on that line) marks every link occurrence on
 * that line as suppressed.
 */
export function extractLinkOccurrences(text: string): LinkOccurrence[] {
  const occurrences: LinkOccurrence[] = [];
  let inFence = false;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const line = stripInlineCodeSpans(rawLine);
    const suppressed = IGNORE_MARKER_PATTERN.test(line);
    const lineNumber = index + 1;

    for (const match of line.matchAll(INLINE_LINK_PATTERN)) {
      occurrences.push({ line: lineNumber, target: match[1], suppressed });
    }
    const refMatch = REFERENCE_DEFINITION_PATTERN.exec(line);
    if (refMatch) {
      occurrences.push({ line: lineNumber, target: refMatch[1], suppressed });
    }
  }

  return occurrences;
}

// Link schemes this audit deliberately never resolves as a repo-relative
// path: external http(s) URLs are out of scope by design (no network I/O),
// and mailto:/tel: are never file paths.
const EXTERNAL_SCHEME_PATTERN = /^(?:https?|mailto|tel):/i;

function decodePathPart(pathPart: string): string {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    // A malformed percent-escape is exceedingly unlikely in an authored
    // relative link; fall back to the raw text rather than throwing, so one
    // odd link cannot crash the whole audit run.
    return pathPart;
  }
}

/**
 * Resolve one link occurrence's target to a repo-relative path plus an
 * optional fragment, or `null` when the target is out of scope (external
 * URL, mailto:, tel:) and therefore not checked. `sourceFile` must be the
 * repo-relative path of the file the link appears in.
 */
export function resolveLinkTarget(
  sourceFile: string,
  target: string,
): { path: string; fragment: string | null; isDirectory: boolean } | null {
  if (EXTERNAL_SCHEME_PATTERN.test(target)) {
    return null;
  }
  const hashIndex = target.indexOf('#');
  const rawPathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : target.slice(hashIndex + 1);

  if (rawPathPart === '') {
    // A pure `#fragment` link targets the current file.
    return { path: sourceFile, fragment, isDirectory: false };
  }

  const decoded = decodePathPart(rawPathPart);
  const isDirectory =
    decoded === '.' || decoded === '..' || decoded.endsWith('/');
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourceFile), decoded),
  );
  // `posix.normalize` collapses a directory link that lands exactly on the
  // repo root (`.`/`..` from a root file, or enough `../` segments to walk
  // back up to it) to `.` -- or, when the decoded target itself ended in a
  // trailing slash (e.g. `../`), to `./` (normalize preserves an input
  // trailing separator). `git ls-files` output never starts with `./`, so
  // appending a trailing slash to `.` the way every other directory target
  // gets one would make the repoFiles-prefix existence check below always
  // fail -- reporting the repo root itself as a missing directory.
  // Represent the repo root as `''` instead: every repoFiles entry
  // trivially starts with `''`, so the existence check (and the
  // template-context prefix check, which correctly still flags a template
  // file walking out to the true repo root) both stay correct without a
  // special case at either call site.
  const isRepoRoot = resolved === '.' || resolved === './';
  const path = isDirectory
    ? isRepoRoot
      ? ''
      : resolved.endsWith('/')
        ? resolved
        : `${resolved}/`
    : resolved;
  return { path, fragment, isDirectory };
}

/**
 * Collect intra-repo markdown link/anchor violations across every file
 * `listFiles`'s configured globs match. Pure (no direct I/O); the audit
 * pipeline supplies `repoFiles` (the full flat file list, for existence and
 * directory-prefix checks), `listFiles` (glob matching bound to
 * `repoFiles`), and `readFile`.
 *
 * `readFile` is only ever called for paths already confirmed present in
 * `repoFiles` -- a missing target is reported from the `repoFiles` Set
 * membership check alone, never by attempting to read it, so this module
 * never double-reports a read failure the caller's own reader already
 * handles.
 */
export function collectMarkdownLinkAuditViolations(
  config: MarkdownLinkAuditConfig | null | undefined,
  repoFiles: readonly string[],
  listFiles: (pattern: string) => string[],
  readFile: (path: string) => string,
): string[] {
  if (!config) {
    return [];
  }

  const id =
    typeof config.id === 'string' && config.id
      ? config.id
      : 'markdown-link-audit';
  const rawGlobs = Array.isArray(config.globs) ? config.globs : [];
  const globs = rawGlobs.filter(
    (glob): glob is string =>
      typeof glob === 'string' && glob.trim().length > 0,
  );
  if (globs.length === 0 || globs.length !== rawGlobs.length) {
    return [`${id}: globs must be a non-empty array of non-empty glob strings`];
  }

  const templateRoot =
    config.templateRoot === undefined
      ? DEFAULT_TEMPLATE_ROOT
      : config.templateRoot;
  if (typeof templateRoot !== 'string' || !templateRoot.endsWith('/')) {
    return [`${id}: templateRoot must be a string ending with "/"`];
  }

  const repoFileSet = new Set(repoFiles);
  const scopeFiles = [
    ...new Set(globs.flatMap((glob) => listFiles(glob))),
  ].sort();
  const headingCache = new Map<string, Set<string>>();
  const headingSlugsFor = (path: string): Set<string> => {
    const cached = headingCache.get(path);
    if (cached) {
      return cached;
    }
    const slugs = new Set(extractHeadingSlugs(readFile(path)));
    headingCache.set(path, slugs);
    return slugs;
  };

  const violations: string[] = [];

  for (const file of scopeFiles) {
    const text = readFile(file);
    for (const occurrence of extractLinkOccurrences(text)) {
      if (occurrence.suppressed) {
        continue;
      }
      const resolved = resolveLinkTarget(file, occurrence.target);
      if (resolved === null) {
        continue;
      }

      if (
        file.startsWith(templateRoot) &&
        !resolved.path.startsWith(templateRoot)
      ) {
        violations.push(
          `${id}: ${file}:${occurrence.line}: link "${occurrence.target}" resolves to ${resolved.path}, outside ${templateRoot} in template context -- adopters who copy ${templateRoot} will not have this file`,
        );
        continue;
      }

      if (resolved.isDirectory) {
        const hasDirectory = repoFiles.some((candidate) =>
          candidate.startsWith(resolved.path),
        );
        if (!hasDirectory) {
          violations.push(
            `${id}: ${file}:${occurrence.line}: link "${occurrence.target}" -> missing directory ${resolved.path}`,
          );
        }
        continue;
      }

      if (!repoFileSet.has(resolved.path)) {
        violations.push(
          `${id}: ${file}:${occurrence.line}: link "${occurrence.target}" -> missing file ${resolved.path}`,
        );
        continue;
      }

      if (resolved.fragment && /\.md$/i.test(resolved.path)) {
        const slugs = headingSlugsFor(resolved.path);
        if (!slugs.has(resolved.fragment)) {
          violations.push(
            `${id}: ${file}:${occurrence.line}: link "${occurrence.target}" -> heading anchor #${resolved.fragment} not found in ${resolved.path}`,
          );
        }
      }
    }
  }

  return violations;
}
