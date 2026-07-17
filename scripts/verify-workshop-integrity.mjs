#!/usr/bin/env node
// idd-generated-from: src/scripts/verify-workshop-integrity.mts
//
// The scripts/verify-workshop-integrity.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
import {
  existsSync,
  globSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

const WORKSHOP_ROOTS = ['docs/workshop'];
const WORKSHOP_ASSET_DIRS = ['docs/workshop/assets'];
if (isMainModule(import.meta.url)) {
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
  const repoRoot = resolve(args.root);
  const report = runVerification(repoRoot);
  if (args.format === 'table') {
    printTable(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(computeExitCode(report));
}
export function runVerification(repoRoot, options = {}) {
  const workshopRoots = options.workshopRoots ?? WORKSHOP_ROOTS;
  const files = [];
  for (const root of workshopRoots) {
    const abs = resolve(repoRoot, root);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      collectMarkdown(abs, files);
    }
  }
  const fileContents = new Map();
  const fileMeta = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    fileContents.set(file, content);
    fileMeta.set(file, {
      headingSlugs: extractHeadingSlugs(content),
      refDefs: extractReferenceDefinitions(content),
    });
  }
  const report = {
    scanned: files.length,
    issues: [],
    counts: {
      checkedLinks: 0,
      checkedImages: 0,
      missingFile: 0,
      missingAnchor: 0,
      invalidUrl: 0,
      escapedRepo: 0,
      unresolvedRef: 0,
      assetOutsideAssetsDir: 0,
    },
  };
  const assetDirs = (options.assetDirs ?? WORKSHOP_ASSET_DIRS).map((dir) =>
    normalize(resolve(repoRoot, dir)),
  );
  for (const file of files) {
    const content = fileContents.get(file);
    const meta = fileMeta.get(file);
    if (content === undefined || meta === undefined) {
      continue;
    }
    const { refDefs } = meta;
    const refs = extractReferences(content, refDefs);
    for (const ref of refs) {
      if (ref.kind === 'image') {
        report.counts.checkedImages += 1;
      } else {
        report.counts.checkedLinks += 1;
      }
      if (ref.status === 'unresolved-reference') {
        report.counts.unresolvedRef += 1;
        report.issues.push({
          file: relative(repoRoot, file),
          kind: ref.kind,
          target: ref.label,
          line: ref.line,
          status: 'unresolved-reference',
          detail: `reference label "${ref.label}" has no [id]: target definition`,
        });
        continue;
      }
      const result = classifyAndCheck(ref.target, file, repoRoot, fileMeta);
      if (result.status === 'ok') {
        if (ref.kind === 'image' && result.resolvedPath) {
          const assetCheck = checkAssetUnderAssetsDir(
            result.resolvedPath,
            assetDirs,
          );
          if (!assetCheck.ok) {
            report.counts.assetOutsideAssetsDir += 1;
            report.issues.push({
              file: relative(repoRoot, file),
              kind: ref.kind,
              target: ref.target,
              line: ref.line,
              status: 'asset-outside-assets-dir',
              detail: assetCheck.detail,
            });
          }
        }
        continue;
      }
      if (result.status === 'missing-file') {
        report.counts.missingFile += 1;
      } else if (result.status === 'missing-anchor') {
        report.counts.missingAnchor += 1;
      } else if (result.status === 'invalid-url') {
        report.counts.invalidUrl += 1;
      } else if (result.status === 'escapes-repo') {
        report.counts.escapedRepo += 1;
      }
      report.issues.push({
        file: relative(repoRoot, file),
        kind: ref.kind,
        target: ref.target,
        line: ref.line,
        status: result.status,
        detail: result.detail,
      });
    }
  }
  return report;
}
// Strips fenced code blocks (``` and ~~~) before pattern scanning so
// example Markdown inside code samples is never interpreted as a real
// link or heading. Tracks both fence character and opening length so a
// 4-backtick block is not closed by a later 3-backtick line. Closing
// fences must contain ONLY optional whitespace after the fence marker
// (per CommonMark §4.5), so a line like ```js inside a fenced block
// is treated as content, not as a close. Replaces masked lines with
// blank lines (same line count) so downstream offset → line-number
// calculations remain correct.
export function stripFencedCodeBlocks(content) {
  const lines = String(content).split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const fenceMarker = openMatch[1];
      const afterFence = openMatch[2];
      const fenceChar = fenceMarker[0];
      const fenceLen = fenceMarker.length;
      const onlyWhitespaceAfter = /^\s*$/.test(afterFence);
      if (fence === null) {
        // Opening fence: info string after the marker is allowed.
        fence = { char: fenceChar, length: fenceLen };
        out.push('');
        continue;
      }
      if (
        fenceChar === fence.char &&
        fenceLen >= fence.length &&
        onlyWhitespaceAfter
      ) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  return out.join('\n');
}
// Replaces HTML-comment regions (`<!-- ... -->`, possibly multi-line)
// with whitespace, preserving newlines so offset → line numbers
// remain accurate. Markdown links inside comments are not real.
export function stripHtmlComments(content) {
  return String(content).replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\r\n]/g, ' '),
  );
}
// Strips inline code spans (`...`, ``...``, etc.) so
// `[demo](./missing.md)` inside backticks is not extracted as a
// real link. The lazy `[\s\S]+?` allows code spans to cross
// newlines so multi-line spans are also covered. The replacement
// preserves newlines so downstream offset → line numbers stay
// accurate.
export function stripInlineCodeSpans(content) {
  return String(content).replace(
    /(`+)((?:(?!\1)[\s\S])+?)\1/g,
    (match, fence) =>
      `${fence}${match.slice(fence.length, -fence.length).replace(/[^\r\n]/g, ' ')}${fence}`,
  );
}
export function extractReferenceDefinitions(markdown) {
  const stripped = stripHtmlComments(stripFencedCodeBlocks(markdown));
  const map = new Map();
  const lines = stripped.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(
      /^\s{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/,
    );
    if (!match) continue;
    const label = match[1].trim().toLowerCase();
    let target = match[2];
    // Unwrap angle-bracket destinations per CommonMark §6.6.
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    }
    map.set(label, target);
  }
  return map;
}
export function extractReferences(markdown, refDefs = new Map()) {
  const refs = [];
  const stripped = stripHtmlComments(stripFencedCodeBlocks(markdown));
  // Mask inline code spans and backslash-escaped link delimiters
  // before any pattern matching so `[demo](./x.md)` inside backticks
  // and \[demo](./x.md) in escaped prose are not parsed as real
  // links. Both passes preserve newlines so offset → line numbers
  // computed below remain accurate.
  const sanitized = maskBackslashEscapes(stripInlineCodeSpans(stripped));
  extractInlineFromContent(sanitized, refs);
  extractReferenceStyleFromContent(sanitized, refs, refDefs);
  extractShortcutReferencesFromContent(sanitized, refs, refDefs);
  extractAutolinksFromContent(sanitized, refs);
  return refs;
}
function maskBackslashEscapes(content) {
  // Replace \[, \], and \! with two-char filler so the link / image
  // / reference patterns do not consume them. Other escapes are left
  // intact.
  return String(content).replace(/\\([[\]!])/g, '  ');
}
function lineNumberAtOffset(content, offset) {
  let line = 1;
  const cap = Math.min(offset, content.length);
  for (let i = 0; i < cap; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function extractInlineFromContent(content, refs) {
  // CommonMark inline link / image. Link text may span newlines
  // (`[^\]]*` matches `\n`), but destinations and titles stay on
  // one line. Destination can be either a bare token (no whitespace,
  // no balanced parens) or angle-bracket wrapped (`<./b.md>`).
  // Optional title accepts double-quoted, single-quoted, or
  // parenthesized form.
  const pattern =
    /(!?)\[([^\]]*)\]\(\s*(<[^>\n]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = pattern.exec(content)) !== null) {
    let target = match[3];
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    }
    refs.push({
      kind: match[1] === '!' ? 'image' : 'link',
      target,
      line: lineNumberAtOffset(content, match.index),
    });
  }
}
function extractAutolinksFromContent(content, refs) {
  // CommonMark autolink: <scheme://...>. We only validate the URL
  // syntax (no live HTTP), so we treat them as link references.
  // Skip matches that overlap an inline-link destination such as
  // [text](<https://x>) or a reference definition's destination,
  // both of which already account for the URL.
  const consumedRanges = collectAngleBracketDestinationRanges(content);
  const pattern = /<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = pattern.exec(content)) !== null) {
    if (
      rangeOverlaps(consumedRanges, match.index, match.index + match[0].length)
    ) {
      continue;
    }
    refs.push({
      kind: 'link',
      target: match[1],
      line: lineNumberAtOffset(content, match.index),
    });
  }
}
function collectAngleBracketDestinationRanges(content) {
  const ranges = [];
  // Inline link/image destination wrapped in <...>.
  const inlinePattern = /(!?)\[([^\]]*)\]\(\s*(<[^>\n]*>)/g;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = inlinePattern.exec(content)) !== null) {
    const destStart = match.index + match[0].length - match[3].length;
    ranges.push([destStart, destStart + match[3].length]);
  }
  // Reference definition destination wrapped in <...>.
  const defPattern = /^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]+>)/gm;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = defPattern.exec(content)) !== null) {
    const destStart = match.index + match[0].length - match[1].length;
    ranges.push([destStart, destStart + match[1].length]);
  }
  return ranges;
}
function rangeOverlaps(ranges, start, end) {
  for (const [rangeStart, rangeEnd] of ranges) {
    if (start < rangeEnd && end > rangeStart) {
      return true;
    }
  }
  return false;
}
function extractReferenceStyleFromContent(content, refs, refDefs) {
  // [text][label] or ![alt][label]. Empty label (`[text][]`)
  // resolves against the text itself.
  const definitionLineCheck = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
  const pattern = /(!?)\[([^\]]+)\]\[([^\]\n]*)\]/g;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = pattern.exec(content)) !== null) {
    const lineNumber = lineNumberAtOffset(content, match.index);
    const lineText = lineContaining(content, match.index);
    if (definitionLineCheck.test(lineText)) continue;
    const isImage = match[1] === '!';
    const text = match[2];
    const labelRaw = match[3].trim().length === 0 ? text : match[3];
    const label = labelRaw.trim().toLowerCase();
    const target = refDefs.get(label);
    if (!target) {
      refs.push({
        kind: isImage ? 'image' : 'link',
        label: labelRaw,
        line: lineNumber,
        status: 'unresolved-reference',
      });
      continue;
    }
    refs.push({
      kind: isImage ? 'image' : 'link',
      target,
      line: lineNumber,
    });
  }
}
function extractShortcutReferencesFromContent(content, refs, refDefs) {
  if (refDefs.size === 0) return;
  const definitionLineCheck = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
  // CommonMark shortcut reference: [label] alone, not followed by
  // (target), [other-label], or : (which would be a definition).
  // The (?<!\]) lookbehind excludes the trailing [label] portion of
  // a full reference-style link like [text][label], which is already
  // captured by extractReferenceStyleFromContent.
  // We only emit refs whose label resolves against refDefs — bare
  // bracketed text without a matching definition is not flagged so
  // ordinary prose like `the [example] above` does not produce false
  // positives.
  const pattern = /(?<!\])(!?)\[([^\]\n]+)\](?!\(|\[|:)/g;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec iteration idiom
  while ((match = pattern.exec(content)) !== null) {
    const lineText = lineContaining(content, match.index);
    if (definitionLineCheck.test(lineText)) continue;
    const isImage = match[1] === '!';
    const labelRaw = match[2];
    const label = labelRaw.trim().toLowerCase();
    const target = refDefs.get(label);
    if (!target) continue;
    refs.push({
      kind: isImage ? 'image' : 'link',
      target,
      line: lineNumberAtOffset(content, match.index),
    });
  }
}
function lineContaining(content, offset) {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lineEndIdx = content.indexOf('\n', offset);
  const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
  return content.slice(lineStart, lineEnd);
}
export function extractHeadingSlugs(markdown) {
  const slugs = new Set();
  const counts = new Map();
  const stripped = stripHtmlComments(stripFencedCodeBlocks(markdown));
  const lines = stripped.split(/\r?\n/);
  const consider = (raw) => {
    const slug = slugifyHeading(raw);
    if (!slug) return;
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    const final = count === 0 ? slug : `${slug}-${count}`;
    slugs.add(final);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atx) {
      consider(atx[2]);
      continue;
    }
    // Setext: a non-blank text line followed by ==... or --...
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      const isSetextUnderline = /^\s{0,3}(=+|-+)\s*$/.test(next);
      if (isSetextUnderline && line.trim().length > 0 && !/^\s*$/.test(line)) {
        // Guard: ensure the current line is not itself a list bullet
        // or fence; treat plain text only as a Setext heading.
        if (!/^\s{0,3}(```|~~~|[-*+]\s|\d+\.\s|#)/.test(line)) {
          consider(line.trim());
        }
      }
    }
  }
  return slugs;
}
// GitHub heading slug algorithm (simplified): strip HTML tags,
// drop most punctuation, lowercase, replace spaces with hyphens,
// keep Unicode letters/digits, underscore, and hyphen. See
// https://gist.github.com/asabaylus/3071099 for the reference
// algorithm.
export function slugifyHeading(text) {
  if (!text) return '';
  let s = String(text);
  // Strip HTML tags. Loop until no further change so payloads like
  // `<<script>foo</script>>` collapse instead of leaving fragments
  // such as `<script>foo</script>` after a single pass.
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^<>]*>/g, '');
  } while (s !== prev);
  // Drop any remaining angle brackets defensively.
  s = s.replace(/[<>]/g, '');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, '');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}
export function classifyAndCheck(target, fromFile, repoRoot, fileMeta) {
  const trimmed = String(target).trim();
  if (trimmed.length === 0) {
    return { status: 'missing-file', detail: 'empty target' };
  }
  if (trimmed.startsWith('//')) {
    try {
      new URL(`https:${trimmed}`);
      return { status: 'ok' };
    } catch (error) {
      return { status: 'invalid-url', detail: error.message };
    }
  }
  // Any absolute URI scheme — hierarchical (with `//`) or
  // non-hierarchical (`urn:`, `data:`, `mailto:`, `tel:`, ...). The
  // URL constructor parses both shapes; we validate syntax only,
  // never fetch.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//')) {
    try {
      new URL(trimmed);
      return { status: 'ok' };
    } catch (error) {
      return { status: 'invalid-url', detail: error.message };
    }
  }
  let pathPart = trimmed;
  let anchorPart = '';
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex >= 0) {
    pathPart = trimmed.slice(0, hashIndex);
    anchorPart = trimmed.slice(hashIndex + 1);
  }
  // Strip query string from the local path; existsSync does not
  // understand `?plain=1` and would falsely report missing.
  const queryIndex = pathPart.indexOf('?');
  if (queryIndex >= 0) {
    pathPart = pathPart.slice(0, queryIndex);
  }
  let decodedPath = pathPart;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    // Leave as-is when not valid percent-encoding.
  }
  let decodedAnchor = anchorPart;
  try {
    decodedAnchor = decodeURIComponent(anchorPart);
  } catch {
    // Leave as-is when not valid percent-encoding.
  }
  let resolvedPath;
  if (decodedPath.length === 0) {
    resolvedPath = fromFile;
  } else if (decodedPath.startsWith('/')) {
    resolvedPath = resolve(repoRoot, decodedPath.replace(/^\/+/, ''));
  } else {
    resolvedPath = resolve(dirname(fromFile), decodedPath);
  }
  resolvedPath = normalize(resolvedPath);
  const repoRootNormalized = normalize(repoRoot);
  // Lexical containment first (catches `..` and root-relative
  // escapes before any disk I/O).
  if (!isInside(resolvedPath, repoRootNormalized)) {
    return {
      status: 'escapes-repo',
      detail: `${decodedPath} resolves outside ${relative(process.cwd(), repoRootNormalized) || '.'}`,
    };
  }
  // Realpath containment second: if `resolvedPath` is a symlink that
  // points outside the repo, the lexical check would not notice. We
  // resolve both sides via realpathSync when possible and re-verify.
  // Failing realpath (non-existent path, EACCES, …) leaves the
  // lexical check as the only guard.
  if (existsSync(resolvedPath)) {
    let realTarget;
    let realRoot;
    try {
      realTarget = realpathSync(resolvedPath);
      realRoot = realpathSync(repoRootNormalized);
    } catch {
      // Fall through to lexical containment only.
    }
    if (realTarget && realRoot && !isInside(realTarget, realRoot)) {
      return {
        status: 'escapes-repo',
        detail: `${decodedPath} symlink target resolves outside ${relative(process.cwd(), realRoot) || '.'}`,
      };
    }
  }
  if (!existsSync(resolvedPath)) {
    return {
      status: 'missing-file',
      detail: relative(repoRoot, resolvedPath),
    };
  }
  if (statSync(resolvedPath).isDirectory()) {
    if (anchorPart.length === 0) {
      return { status: 'ok' };
    }
    return {
      status: 'missing-anchor',
      detail: 'anchor requested but target is a directory',
    };
  }
  if (anchorPart.length === 0) {
    return { status: 'ok', resolvedPath };
  }
  const isMarkdown = extname(resolvedPath).toLowerCase() === '.md';
  if (!isMarkdown) {
    return { status: 'ok', resolvedPath };
  }
  let meta = fileMeta.get(resolvedPath);
  if (!meta) {
    const content = readFileSync(resolvedPath, 'utf8');
    meta = {
      headingSlugs: extractHeadingSlugs(content),
      refDefs: extractReferenceDefinitions(content),
    };
    fileMeta.set(resolvedPath, meta);
  }
  if (!meta.headingSlugs.has(decodedAnchor.toLowerCase())) {
    return {
      status: 'missing-anchor',
      detail: `anchor "#${anchorPart}" not found in ${relative(repoRoot, resolvedPath)}`,
    };
  }
  return { status: 'ok', resolvedPath };
}
export function checkAssetUnderAssetsDir(resolvedPath, assetDirs) {
  if (!Array.isArray(assetDirs) || assetDirs.length === 0) {
    return { ok: true };
  }
  for (const dir of assetDirs) {
    if (isInside(normalize(resolvedPath), normalize(dir))) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    detail: `image target resolves outside ${assetDirs[0]}; image references should live under docs/workshop/assets/ or be absolute URLs`,
  };
}
function isInside(targetPath, rootPath) {
  if (targetPath === rootPath) return true;
  const rootWithSep = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return targetPath.startsWith(rootWithSep);
}
export function computeExitCode(report) {
  return report.issues.length > 0 ? 1 : 0;
}
/**
 * #1449: replaces a manual `readdirSync` recursion with `fs.globSync`
 * (stable since Node v22.17.0; this repo requires `^22.22.2 || >=24`).
 * Three discovery-semantics deltas were checked and closed or documented
 * before this swap, each verified empirically against the real
 * `docs/workshop` tree (10 files) and synthetic fixtures:
 *
 * 1. **Case-insensitive matching**: the old code matched via
 *    `full.toLowerCase().endsWith('.md')`; `globSync` has no
 *    case-insensitive matching option, so the bracket pattern `[mM][dD]`
 *    reproduces it exactly
 *    (verified against `.MD`/`.Md` fixtures). No non-lowercase `.md` file
 *    exists anywhere in this repo today (this repo's own naming
 *    convention requires lowercase filenames), so this is defensive
 *    rather than currently load-bearing.
 * 2. **Directories matching the pattern**: a plain recursive glob for
 *    `.md` entries also returns directory names that happen to match (e.g. a
 *    hypothetical `weird.md/`), which the caller's `readFileSync` loop
 *    would crash on (`EISDIR`) — the old `Dirent`-based walk never
 *    collects a directory because it checks `isDirectory()` first and
 *    recurses instead. Closed by requesting `Dirent`s and filtering
 *    `isFile()`, matching the old walk's file-only collection exactly.
 * 3. **Result order**: `globSync`'s match order does not reproduce the
 *    alphabetical depth-first order the old `readdirSync`-based recursion
 *    happens to produce on this filesystem, so results are sorted
 *    explicitly — verified byte-identical to the pre-change order for
 *    the real `docs/workshop` tree.
 *
 * Two further points are recorded here for completeness rather than
 * worked around, but they are **not equally benign** — read them
 * separately:
 *
 * - A symlinked `.md` **file** sitting directly in the tree is a genuine
 *   **non-issue**: excluded by both the old and the new walk.
 *   `Dirent#isFile()` is `lstat`-based (checks the entry itself, not its
 *   resolved target) for `globSync`'s `Dirent`s exactly as it was for
 *   `readdirSync`'s, so `entry.isFile()` is `false` for a symlink either
 *   way, and neither walk traverses *into* a symlinked directory (`**`
 *   default `followSymlinks: false`).
 * - Dot-prefixed files and directories are a **real, confirmed behavior
 *   difference**, not a non-issue: the old `readdirSync`-based walk had
 *   no dot-exclusion of its own and would traverse them, while `**` does
 *   not descend into a dot-prefixed path by default (`fs.globSync` has no
 *   dot-inclusion option at all — verified there is nothing equivalent to
 *   other glob libraries' `dot: true`). This delta is inert *only*
 *   because `docs/workshop` has zero dot-prefixed entries today; it would
 *   change scanned output the moment one was added. Deliberately left
 *   unclosed rather than shipping a partial pattern fix (see the PR #1463
 *   review-thread disposition for the full reasoning) (Copilot review,
 *   #1463).
 *
 * One more delta favors the new code: `globSync` on a nonexistent `dir`
 * silently returns no matches, where `readdirSync` would throw `ENOENT`.
 * Unreachable today — `runVerification`'s sole call site already guards
 * with `existsSync(abs) && statSync(abs).isDirectory()` before calling
 * this function — recorded for whoever removes that guard later.
 */
function collectMarkdown(dir, out) {
  const matches = globSync('**/*.[mM][dD]', { cwd: dir, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of matches) {
    out.push(file);
  }
}
function printTable(report) {
  console.log(
    `scanned: ${report.scanned}  links: ${report.counts.checkedLinks}  images: ${report.counts.checkedImages}  issues: ${report.issues.length}`,
  );
  for (const issue of report.issues) {
    console.log(
      `  [${issue.status}] ${issue.file}:${issue.line} ${issue.kind} -> ${issue.target}  ${issue.detail ?? ''}`,
    );
  }
}
function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    format: 'table',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--repo-root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--repo-root requires a value');
      args.root = value;
      i += 1;
    } else if (arg === '--format') {
      const value = argv[i + 1];
      if (!value) throw new Error('--format requires a value');
      if (value !== 'json' && value !== 'table') {
        throw new Error(`--format must be one of json,table (got "${value}")`);
      }
      args.format = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}
function printUsage() {
  console.log(`usage: node scripts/verify-workshop-integrity.mjs [options]

options:
  --repo-root <path>   repository root to scan (default: cwd)
  --format json|table  output format (default: table)
  --help, -h           show this help

Scans docs/workshop/**/*.md for broken local link targets, missing
heading anchors, and unresolved reference labels. Absolute URLs are
validated for syntax only (no live HTTP fetch — the check stays
offline-safe). Targets that resolve outside the repository root via
path traversal are reported as errors.
`);
}
function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const url = new URL(metaUrl);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
}
