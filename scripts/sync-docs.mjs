#!/usr/bin/env node
// idd-generated-from: src/scripts/sync-docs.mts
//
// The scripts/sync-docs.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
/**
 * sync-docs.mjs — Deterministic mirror generation for idd-skill docs.
 *
 * Reads audit/sync-manifest.json and regenerates all auto-generatable
 * mirrored artifacts from their canonical sources.
 *
 * Usage:
 *   node scripts/sync-docs.mjs          # dry-run: report what is out of sync
 *   node scripts/sync-docs.mjs --check  # same as default (explicit dry-run)
 *   node scripts/sync-docs.mjs --apply  # write updated files to disk
 *   node scripts/sync-docs.mjs --apply --force
 *     # also overwrite a target that has uncommitted local edits (see below)
 *
 * Skipped pair modes (cannot auto-generate):
 *   structure  — only heading structure is checked; no source to copy
 *   contains   — only text-presence is checked; no source to copy
 *
 * Uncommitted-target-edit guard (#1765): an `exact`/`concreted` pair's
 * `target` is always regenerated from its `source` — editing `target`
 * directly is a mistake the sync would otherwise discard silently. Before
 * queuing such a target's diff, this compares the target's on-disk content
 * against its last commit (`git show HEAD:<target>`). If they differ, and
 * that on-disk content is not what regeneration would already produce
 * either, the target carries a genuine uncommitted local edit that would be
 * lost — this is reported as an error and the target is left untouched
 * unless `--force` is passed. A target with no uncommitted state (on-disk
 * matches its last commit, just stale relative to `source`) is unaffected
 * and still syncs silently, as before.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildOkfIndexRows,
  globFiles,
  injectGeneratedFromBanner,
  isBannerScopedInstructionTarget,
  renderOkfIndexMarkdownTable,
  resolveGeneratedBlockFiles,
} from './consistency-helpers.mjs';

// Resolve the repository root by walking up to the nearest package.json,
// so the source resolves the same root whether it runs as the emitted
// scripts/sync-docs.mjs (one level deep) or the src/scripts/sync-docs.mts
// source under Node type-stripping (two levels deep). A fixed `../..` from
// import.meta.dirname would resolve to src/ for the source.
function resolveRepoRoot(fromDir) {
  let dir = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}
const root = resolveRepoRoot(import.meta.dirname);
const manifestPath = 'audit/sync-manifest.json';
let repoFilesCache = null;
// Lazy: only shelled out to when a block actually falls back to
// sourceGlobs (today's manifest sets `paths` on every entry), so a normal
// run with no sourceGlobs-only blocks never pays for this git call.
//
// Deliberately omits `--full-name`: `sourceGlobs` patterns are written
// relative to `root` (the nearest `package.json`, not necessarily the
// git worktree's top level -- e.g. an adopter monorepo with a nested
// `package.json`), and `git ls-files` without `--full-name` already
// prints paths relative to its own `cwd`, which is `root` below. Adding
// `--full-name` would instead force paths relative to the git project
// top, silently mismatching every `sourceGlobs` pattern whenever `root`
// differs from that top level (#1748 review).
function getRepoFiles() {
  if (!repoFilesCache) {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    repoFilesCache = output.split(/\r?\n/).filter(Boolean).sort();
  }
  return repoFilesCache;
}
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const force = args.includes('--force');
const manifest = JSON.parse(readText(manifestPath));
const generatedBlocks = manifest.generatedBlocks ?? [];
const shellFileLists = manifest.shellFileLists ?? [];
const diffs = [];
const skippedPairs = [];
let nonZeroExit = false;
processSyncPairs(manifest.syncPairs ?? []);
processGeneratedBlocksAndShellFileLists(generatedBlocks, shellFileLists);
if (nonZeroExit) {
  process.exit(1);
}
if (diffs.length === 0) {
  console.log('All mirrored artifacts are up to date.');
  if (skippedPairs.length > 0) {
    console.log(
      `Skipped ${skippedPairs.length} pair(s) (structure/contains — no auto-generation):`,
      skippedPairs.map((p) => p.id).join(', '),
    );
  }
  process.exit(0);
}
if (!apply) {
  console.log(`${diffs.length} file(s) out of sync:`);
  for (const { target } of diffs) {
    console.log(`  ${target}`);
  }
  if (skippedPairs.length > 0) {
    console.log(
      `\nSkipped ${skippedPairs.length} pair(s) (structure/contains — no auto-generation):`,
      skippedPairs.map((p) => p.id).join(', '),
    );
  }
  console.log('\nRun with --apply to write changes.');
  process.exit(1);
}
let written = 0;
for (const { target, content } of diffs) {
  mkdirSync(dirname(join(root, target)), { recursive: true });
  writeFileSync(join(root, target), content, 'utf8');
  console.log(`  synced: ${target}`);
  written++;
}
console.log(`\nSynced ${written} file(s).`);
if (skippedPairs.length > 0) {
  console.log(
    `Skipped ${skippedPairs.length} pair(s) (structure/contains — no auto-generation):`,
    skippedPairs.map((p) => p.id).join(', '),
  );
}
// ---------------------------------------------------------------------------
// syncPairs processing
// ---------------------------------------------------------------------------
function processSyncPairs(pairs) {
  const seenTargets = new Set();
  for (const pair of pairs) {
    const { id, source, target, mode, replacements = [] } = pair;
    // A duplicate target is dead data: only the first occurrence is applied,
    // so a divergent second copy is silently ignored and misleads future
    // maintainers. Enforce uniqueness across every pair (matching the docs
    // audit's collectDuplicateSyncPairTargets, which checks all modes) so the
    // error message's "each syncPairs target must appear exactly once" holds
    // regardless of mode.
    if (seenTargets.has(target)) {
      throw new Error(
        `sync-docs: duplicate target "${target}" in pair "${id}" — each syncPairs target must appear exactly once`,
      );
    }
    seenTargets.add(target);
    if (mode === 'exact' || mode === 'concreted') {
      const sourceText = readText(source);
      let generated = normalizeText(
        applyReplacements(sourceText, replacements),
      );
      // Stamp the generated-from banner into generated instruction targets so
      // agents/humans see the file is generated and edit the idd-template/
      // source instead. Injected at generation time, not stored in the source.
      if (isBannerScopedInstructionTarget(target, mode)) {
        generated = normalizeText(injectGeneratedFromBanner(generated, source));
      }
      const current = tryReadText(target);
      if (current === null || normalizeText(current) !== generated) {
        if (
          current !== null &&
          !force &&
          hasUncommittedTargetEdit(target, current)
        ) {
          console.error(
            `sync-docs: ${target} has uncommitted local changes that differ ` +
              `from both its last commit and the content generated from ` +
              `${source}. Regenerating would discard them.\n` +
              `  This is an ${mode}-mode pair: ${target} is always ` +
              `regenerated from ${source} -- edit ${source} instead.\n` +
              `  If this edit landed on the wrong side by mistake, move it ` +
              `to ${source} and re-run.\n` +
              `  Pass --force to overwrite ${target} anyway.`,
          );
          nonZeroExit = true;
          continue;
        }
        diffs.push({ target, content: generated });
      }
    } else if (mode === 'structure' || mode === 'contains') {
      // No auto-generation possible for these modes
      skippedPairs.push({ id, mode });
    } else {
      throw new Error(
        `sync-docs: unrecognized syncPair mode "${mode}" in pair "${id}"`,
      );
    }
  }
}
// ---------------------------------------------------------------------------
// generatedBlocks + shellFileLists processing
// ---------------------------------------------------------------------------
/**
 * Groups all generatedBlocks and shellFileLists by file, then applies all
 * updates to each file in a single pass (avoiding stale position offsets
 * after the first update shifts the string).
 */
function processGeneratedBlocksAndShellFileLists(blocks, lists) {
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  // Group all updates by target file
  const byFile = new Map();
  const addToFile = (file, update) => {
    const list = byFile.get(file);
    if (list) {
      list.push(update);
    } else {
      byFile.set(file, [update]);
    }
  };
  for (const block of blocks) {
    addToFile(block.file, { kind: 'generated', block });
  }
  for (const list of lists) {
    const sourceBlock = blockById.get(list.generatedBlock);
    if (!sourceBlock) {
      console.error(
        `sync-docs: shellFileList "${list.id}" references unknown generatedBlock "${list.generatedBlock}"`,
      );
      nonZeroExit = true;
      continue;
    }
    addToFile(list.file, { kind: 'shell', list, sourceBlock });
  }
  for (const [file, updates] of byFile) {
    // Prefer already-queued content (e.g. from a preceding syncPairs pass) so
    // that we do not silently clobber transformations that a syncPairs entry
    // may have applied to the same file.
    const queued = diffs.find((d) => d.target === file);
    const rawText = queued ? queued.content : tryReadText(file);
    if (rawText === null) {
      console.error(`sync-docs: file not found: ${file}`);
      nonZeroExit = true;
      continue;
    }
    let text = normalizeText(rawText);
    let changed = false;
    for (const update of updates) {
      if (update.kind === 'generated') {
        const result = applyGeneratedBlock(text, update.block);
        if (result === null) {
          nonZeroExit = true;
        } else if (result !== text) {
          text = result;
          changed = true;
        }
      } else {
        const result = applyShellFileList(
          text,
          update.list,
          update.sourceBlock,
        );
        if (result === null) {
          nonZeroExit = true;
        } else if (result !== text) {
          text = result;
          changed = true;
        }
      }
    }
    if (changed) {
      // Remove an existing stale entry for this file if present (possible when
      // both generatedBlocks and shellFileLists share the same file).
      const existing = diffs.findIndex((d) => d.target === file);
      if (existing !== -1) diffs.splice(existing, 1);
      diffs.push({ target: file, content: text });
    }
  }
}
/**
 * Replaces the content between the audit:generated markers in `text`
 * with a freshly rendered code block.
 *
 * Returns the updated text, or null on error.
 */
function applyGeneratedBlock(text, block) {
  const startMarker = `<!-- audit:generated id=${block.id} -->`;
  const endMarker = '<!-- /audit:generated -->';
  const start = text.indexOf(startMarker);
  if (start === -1) {
    console.error(
      `sync-docs: block marker not found: "${block.id}" in ${block.file}`,
    );
    return null;
  }
  const innerStart = start + startMarker.length;
  const end = text.indexOf(endMarker, innerStart);
  if (end === -1) {
    console.error(
      `sync-docs: block end marker not found for "${block.id}" in ${block.file}`,
    );
    return null;
  }
  const rendered = renderGeneratedBlock(block);
  const current = text.slice(innerStart, end);
  if (normalizeText(current) === normalizeText(rendered)) {
    return text; // already in sync
  }
  return text.slice(0, innerStart) + rendered + text.slice(end);
}
/**
 * Replaces the `for FILE in` file list in the shell code block that
 * follows `<!-- audit:shell-list id=XXX -->` with the canonical file
 * list from the referenced generatedBlock.
 *
 * Returns the updated text, or null on error.
 */
function applyShellFileList(text, list, sourceBlock) {
  const marker = `<!-- audit:shell-list id=${list.id} -->`;
  const markerPos = text.indexOf(marker);
  if (markerPos === -1) {
    console.error(
      `sync-docs: shell-list marker not found: "${list.id}" in ${list.file}`,
    );
    return null;
  }
  const searchFrom = markerPos + marker.length;
  // Find the opening fence
  const fenceStart = text.indexOf('```', searchFrom);
  if (fenceStart === -1) {
    console.error(
      `sync-docs: missing code block after shell-list "${list.id}"`,
    );
    return null;
  }
  const codeLineStart = text.indexOf('\n', fenceStart);
  if (codeLineStart === -1) {
    console.error(
      `sync-docs: malformed code block opening after shell-list "${list.id}"`,
    );
    return null;
  }
  const fenceEnd = text.indexOf('\n```', codeLineStart + 1);
  if (fenceEnd === -1) {
    console.error(
      `sync-docs: unclosed code block after shell-list "${list.id}"`,
    );
    return null;
  }
  // Code content (between the first ``` line and the closing ```)
  const codeContent = text.slice(codeLineStart + 1, fenceEnd);
  const lines = codeContent.split('\n');
  const loopStartIdx = lines.findIndex((l) => l.trim() === 'for FILE in \\');
  if (loopStartIdx === -1) {
    console.error(
      `sync-docs: missing "for FILE in \\" in code block for shell-list "${list.id}"`,
    );
    return null;
  }
  const loopEndIdx = lines.findIndex(
    (l, i) => i > loopStartIdx && l.trim() === 'do',
  );
  if (loopEndIdx === -1) {
    console.error(
      `sync-docs: missing "do" after FILE loop in shell-list "${list.id}"`,
    );
    return null;
  }
  // Build the canonical file list lines
  const strip = list.stripPrefix ?? sourceBlock.stripPrefix;
  const files = resolveBlockFiles(sourceBlock).map((f) =>
    doStripPrefix(f, strip),
  );
  const newFileLines = files.map((f, i) => {
    const suffix = i < files.length - 1 ? ' \\' : '';
    return `  "${f}"${suffix}`;
  });
  const currentFileLines = lines.slice(loopStartIdx + 1, loopEndIdx);
  if (currentFileLines.join('\n') === newFileLines.join('\n')) {
    return text; // already in sync
  }
  const newLines = [
    ...lines.slice(0, loopStartIdx + 1), // "for FILE in \"
    ...newFileLines,
    ...lines.slice(loopEndIdx), // "do" and onwards
  ];
  const newCodeContent = newLines.join('\n');
  return (
    text.slice(0, codeLineStart + 1) + newCodeContent + text.slice(fenceEnd)
  );
}
// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function renderGeneratedBlock(block) {
  const files = resolveBlockFiles(block);
  if (String(block.kind ?? '').trim() === 'okf-table') {
    const rows = buildOkfIndexRows(files, (path) => readText(path), {
      typeOrder: block.typeOrder ?? [],
      excludePaths: block.excludePaths ?? [],
    });
    return renderOkfIndexMarkdownTable(rows, block.linkBase ?? 'docs');
  }
  const renderedFiles = files.map((f) => doStripPrefix(f, block.stripPrefix));
  return `\n\n\`\`\`${block.language ?? 'text'}\n${renderedFiles.join('\n')}\n\`\`\`\n\n`;
}
function resolveBlockFiles(block) {
  // paths-first, sourceGlobs-fallback -- shared with audit-docs.mjs via
  // consistency-helpers.mts's resolveGeneratedBlockFiles (#1703) so the two
  // tools cannot drift on this resolution rule again.
  //
  // Known limitation (#1748 review): getRepoFiles() caches a single
  // git-ls-files snapshot taken before this run's writes are applied
  // (this script queues every diff, then writes them all at the end). A
  // sourceGlobs-only block whose pattern would match a file a syncPairs
  // entry creates in this SAME --apply run won't see that not-yet-written
  // file until a second --apply pass. No current manifest entry combines
  // sourceGlobs-only resolution with a same-run syncPairs target this
  // way; re-running --apply converges if one ever does.
  return resolveGeneratedBlockFiles(block, (pattern) =>
    globFiles(pattern, getRepoFiles()),
  );
}
function applyReplacements(text, replacements) {
  let result = text;
  for (const { from, to } of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}
function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}
function doStripPrefix(file, prefix) {
  if (!prefix) return file;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  console.error(
    `sync-docs: file "${file}" does not start with expected prefix "${prefix}"`,
  );
  nonZeroExit = true;
  return file;
}
/**
 * True when `current` (the target's on-disk content, already known to
 * differ from the freshly generated content) also differs from the
 * target's last-committed content -- i.e. an uncommitted, at-risk local
 * edit exists, not just a target that is legitimately stale relative to
 * its source. Any failure reading git state (untracked file, no HEAD, git
 * unavailable) falls back to the pre-#1765 behavior: untracked/unreadable
 * git state proceeds like there is nothing to protect, since a missing
 * git baseline can never distinguish "stale" from "locally edited" and
 * this guard must not block a repository or profile that never had this
 * protection in the first place.
 */
function hasUncommittedTargetEdit(target, current) {
  let committed;
  try {
    committed = execFileSync('git', ['show', `HEAD:${target}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false;
  }
  return normalizeText(current) !== normalizeText(committed);
}
function readText(relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8');
  } catch {
    console.error(`sync-docs: cannot read file: ${relPath}`);
    process.exit(1);
  }
}
function tryReadText(relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}
