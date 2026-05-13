#!/usr/bin/env node
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
 *
 * Skipped pair modes (cannot auto-generate):
 *   structure  — only heading structure is checked; no source to copy
 *   contains   — only text-presence is checked; no source to copy
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifestPath = "audit/sync-manifest.json";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

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
  console.log("All mirrored artifacts are up to date.");
  if (skippedPairs.length > 0) {
    console.log(
      `Skipped ${skippedPairs.length} pair(s) (structure/contains — no auto-generation):`,
      skippedPairs.map((p) => p.id).join(", ")
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
      skippedPairs.map((p) => p.id).join(", ")
    );
  }
  console.log("\nRun with --apply to write changes.");
  process.exit(1);
}

let written = 0;
for (const { target, content } of diffs) {
  mkdirSync(dirname(join(root, target)), { recursive: true });
  writeFileSync(join(root, target), content, "utf8");
  console.log(`  synced: ${target}`);
  written++;
}
console.log(`\nSynced ${written} file(s).`);
if (skippedPairs.length > 0) {
  console.log(
    `Skipped ${skippedPairs.length} pair(s) (structure/contains — no auto-generation):`,
    skippedPairs.map((p) => p.id).join(", ")
  );
}

// ---------------------------------------------------------------------------
// syncPairs processing
// ---------------------------------------------------------------------------

function processSyncPairs(pairs) {
  const seenTargets = new Set();

  for (const pair of pairs) {
    const { id, source, target, mode, replacements = [] } = pair;

    if (mode === "exact" || mode === "concreted") {
      if (seenTargets.has(target)) {
        // Duplicate target — both entries produce the same content by design.
        // Log so maintenance errors become visible rather than silent.
        console.warn(
          `sync-docs: duplicate target "${target}" in pair "${id}" — skipping second occurrence`
        );
        continue;
      }
      seenTargets.add(target);

      const sourceText = readText(source);
      const generated = normalizeText(applyReplacements(sourceText, replacements));
      const current = tryReadText(target);

      if (current === null || normalizeText(current) !== generated) {
        diffs.push({ target, content: generated });
      }
    } else if (mode === "structure" || mode === "contains") {
      // No auto-generation possible for these modes
      skippedPairs.push({ id, mode });
    } else {
      throw new Error(
        `sync-docs: unrecognized syncPair mode "${mode}" in pair "${id}"`
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
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(update);
  };

  for (const block of blocks) {
    addToFile(block.file, { kind: "generated", block });
  }
  for (const list of lists) {
    const sourceBlock = blockById.get(list.generatedBlock);
    if (!sourceBlock) {
      console.error(
        `sync-docs: shellFileList "${list.id}" references unknown generatedBlock "${list.generatedBlock}"`
      );
      nonZeroExit = true;
      continue;
    }
    addToFile(list.file, { kind: "shell", list, sourceBlock });
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
      if (update.kind === "generated") {
        const result = applyGeneratedBlock(text, update.block);
        if (result === null) {
          nonZeroExit = true;
        } else if (result !== text) {
          text = result;
          changed = true;
        }
      } else {
        const result = applyShellFileList(text, update.list, update.sourceBlock);
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
  const endMarker = "<!-- /audit:generated -->";

  const start = text.indexOf(startMarker);
  if (start === -1) {
    console.error(`sync-docs: block marker not found: "${block.id}" in ${block.file}`);
    return null;
  }
  const innerStart = start + startMarker.length;
  const end = text.indexOf(endMarker, innerStart);
  if (end === -1) {
    console.error(
      `sync-docs: block end marker not found for "${block.id}" in ${block.file}`
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
    console.error(`sync-docs: shell-list marker not found: "${list.id}" in ${list.file}`);
    return null;
  }

  const searchFrom = markerPos + marker.length;

  // Find the opening fence
  const fenceStart = text.indexOf("```", searchFrom);
  if (fenceStart === -1) {
    console.error(`sync-docs: missing code block after shell-list "${list.id}"`);
    return null;
  }
  const codeLineStart = text.indexOf("\n", fenceStart);
  if (codeLineStart === -1) {
    console.error(
      `sync-docs: malformed code block opening after shell-list "${list.id}"`
    );
    return null;
  }
  const fenceEnd = text.indexOf("\n```", codeLineStart + 1);
  if (fenceEnd === -1) {
    console.error(`sync-docs: unclosed code block after shell-list "${list.id}"`);
    return null;
  }

  // Code content (between the first ``` line and the closing ```)
  const codeContent = text.slice(codeLineStart + 1, fenceEnd);
  const lines = codeContent.split("\n");

  const loopStartIdx = lines.findIndex((l) => l.trim() === "for FILE in \\");
  if (loopStartIdx === -1) {
    console.error(
      `sync-docs: missing "for FILE in \\" in code block for shell-list "${list.id}"`
    );
    return null;
  }
  const loopEndIdx = lines.findIndex(
    (l, i) => i > loopStartIdx && l.trim() === "do"
  );
  if (loopEndIdx === -1) {
    console.error(
      `sync-docs: missing "do" after FILE loop in shell-list "${list.id}"`
    );
    return null;
  }

  // Build the canonical file list lines
  const strip = list.stripPrefix ?? sourceBlock.stripPrefix;
  const files = resolveBlockFiles(sourceBlock).map((f) => doStripPrefix(f, strip));
  const newFileLines = files.map((f, i) => {
    const suffix = i < files.length - 1 ? " \\" : "";
    return `  "${f}"${suffix}`;
  });

  const currentFileLines = lines.slice(loopStartIdx + 1, loopEndIdx);
  if (currentFileLines.join("\n") === newFileLines.join("\n")) {
    return text; // already in sync
  }

  const newLines = [
    ...lines.slice(0, loopStartIdx + 1), // "for FILE in \"
    ...newFileLines,
    ...lines.slice(loopEndIdx), // "do" and onwards
  ];
  const newCodeContent = newLines.join("\n");

  return (
    text.slice(0, codeLineStart + 1) + newCodeContent + text.slice(fenceEnd)
  );
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function renderGeneratedBlock(block) {
  const files = resolveBlockFiles(block);
  const renderedFiles = files.map((f) => doStripPrefix(f, block.stripPrefix));
  return `\n\n\`\`\`${block.language ?? "text"}\n${renderedFiles.join("\n")}\n\`\`\`\n\n`;
}

function resolveBlockFiles(block) {
  // Use the static paths list when present; this matches audit-docs.mjs behaviour.
  return block.paths ? [...block.paths] : [];
}

function applyReplacements(text, replacements) {
  let result = text;
  for (const { from, to } of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, "\n");
}

function doStripPrefix(file, prefix) {
  if (!prefix) return file;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  console.error(
    `sync-docs: file "${file}" does not start with expected prefix "${prefix}"`
  );
  nonZeroExit = true;
  return file;
}

function readText(relPath) {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch {
    console.error(`sync-docs: cannot read file: ${relPath}`);
    process.exit(1);
  }
}

function tryReadText(relPath) {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch {
    return null;
  }
}
