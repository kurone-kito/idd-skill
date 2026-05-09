#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const manifestPath = "audit/sync-manifest.json";
const args = new Set(process.argv.slice(2));

if (!args.has("--check")) {
  console.error("usage: node scripts/audit-docs.mjs --check");
  process.exit(2);
}

const errors = [];
const notices = [];
const manifest = JSON.parse(readText(manifestPath));
const repoFiles = listRepoFiles();
const changedFiles = listChangedFiles();

checkReadmePairs(manifest.readmePairs ?? []);
checkFileSets(manifest.fileSets ?? [], manifest.syncPairs ?? []);
checkGeneratedBlocks(manifest.generatedBlocks ?? []);
checkSyncPairs(manifest.syncPairs ?? []);
checkForbiddenPatterns(manifest.forbiddenPatterns ?? []);

if (errors.length > 0) {
  console.error("documentation audit failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

for (const notice of notices) {
  console.log(`notice: ${notice}`);
}
console.log("documentation audit passed");

function checkReadmePairs(pairs) {
  for (const pair of pairs) {
    const [first, second] = pair.files ?? [];
    if (!first || !second) {
      errors.push(`${pair.id}: README pair must contain exactly two files`);
      continue;
    }

    if (pair.pairedChange) {
      checkPairedChange(pair.id, first, second);
    }

    for (const link of pair.languageLinks ?? []) {
      const text = readText(link.file);
      if (!text.includes(link.text)) {
        errors.push(`${pair.id}: ${link.file} is missing ${JSON.stringify(link.text)}`);
      }
    }

    if (pair.structure === "heading-levels") {
      const firstLevels = headingSignature(readText(first), { levelsOnly: true });
      const secondLevels = headingSignature(readText(second), { levelsOnly: true });
      if (firstLevels !== secondLevels) {
        errors.push(`${pair.id}: README heading levels differ between ${first} and ${second}`);
      }
    }
  }
}

function checkPairedChange(id, first, second) {
  if (changedFiles === null) {
    notices.push(`${id}: skipped paired-change check because no git comparison base was available`);
    return;
  }

  const firstChanged = changedFiles.has(first);
  const secondChanged = changedFiles.has(second);
  if (firstChanged !== secondChanged) {
    errors.push(`${id}: ${first} and ${second} must be changed together`);
  }
}

function checkFileSets(fileSets, syncPairs) {
  const coveredSyncPairs = new Set(syncPairs.map((pair) => `${pair.source}\0${pair.target}`));

  for (const fileSet of fileSets) {
    const sourceFiles = globFiles(fileSet.sourceGlob);
    const targetFiles = globFiles(fileSet.targetGlob);

    if (fileSet.match !== "basename") {
      errors.push(`${fileSet.id}: unsupported file set match mode ${fileSet.match}`);
      continue;
    }

    const sourceNames = new Set(sourceFiles.map((file) => basename(file)));
    const targetNames = new Set(targetFiles.map((file) => basename(file)));
    const sourceByName = new Map(sourceFiles.map((file) => [basename(file), file]));
    const targetByName = new Map(targetFiles.map((file) => [basename(file), file]));

    for (const sourceName of sourceNames) {
      if (!targetNames.has(sourceName)) {
        errors.push(`${fileSet.id}: target is missing ${sourceName}`);
        continue;
      }
      if (fileSet.requireSyncPairs) {
        const source = sourceByName.get(sourceName);
        const target = targetByName.get(sourceName);
        if (!coveredSyncPairs.has(`${source}\0${target}`)) {
          errors.push(`${fileSet.id}: ${sourceName} is missing a syncPairs entry`);
        }
      }
    }

    if (!fileSet.allowExtraTargets) {
      for (const targetName of targetNames) {
        if (!sourceNames.has(targetName)) {
          errors.push(`${fileSet.id}: target has unexpected ${targetName}`);
        }
      }
    }

    for (const requiredName of fileSet.requiredBasenames ?? []) {
      if (!targetNames.has(requiredName)) {
        errors.push(`${fileSet.id}: target is missing required ${requiredName}`);
      }
    }
  }
}

function checkGeneratedBlocks(blocks) {
  for (const block of blocks) {
    const text = readText(block.file);
    const startMarker = `<!-- audit:generated id=${block.id} -->`;
    const endMarker = "<!-- /audit:generated -->";
    const start = text.indexOf(startMarker);
    if (start === -1) {
      errors.push(`${block.id}: ${block.file} is missing ${startMarker}`);
      continue;
    }
    const innerStart = start + startMarker.length;
    const end = text.indexOf(endMarker, innerStart);
    if (end === -1) {
      errors.push(`${block.id}: ${block.file} is missing ${endMarker}`);
      continue;
    }

    const expected = renderGeneratedBlock(block);
    const actual = normalizeText(text.slice(innerStart, end));
    if (actual !== expected) {
      errors.push(`${block.id}: generated block in ${block.file} is stale`);
    }
  }
}

function renderGeneratedBlock(block) {
  const files = block.paths
    ? [...block.paths]
    : uniqueSorted((block.sourceGlobs ?? []).flatMap(globFiles));
  const actualFiles = uniqueSorted((block.sourceGlobs ?? []).flatMap(globFiles));

  if (block.paths && block.sourceGlobs) {
    const expectedSet = new Set(block.paths);
    for (const actual of actualFiles) {
      if (!expectedSet.has(actual)) {
        errors.push(`${block.id}: manifest paths omit ${actual}`);
      }
    }
    for (const expected of block.paths) {
      if (!actualFiles.includes(expected)) {
        errors.push(`${block.id}: manifest path does not exist or match globs: ${expected}`);
      }
    }
  }

  const renderedFiles = files.map((file) => stripPrefix(file, block.stripPrefix));
  return `\n\n\`\`\`${block.language ?? "text"}\n${renderedFiles.join("\n")}\n\`\`\`\n\n`;
}

function checkSyncPairs(pairs) {
  for (const pair of pairs) {
    if (pair.mode === "contains") {
      checkContainsPair(pair);
      continue;
    }

    const source = applyReplacements(readText(pair.source), pair.replacements ?? []);
    const target = readText(pair.target);

    if (pair.mode === "exact" || pair.mode === "concreted") {
      if (normalizeText(source) !== normalizeText(target)) {
        errors.push(`${pair.id}: ${pair.source} and ${pair.target} differ in ${pair.mode} mode`);
      }
      continue;
    }

    if (pair.mode === "structure") {
      const sourceSignature = headingSignature(source, { levelsOnly: false });
      const targetSignature = headingSignature(target, { levelsOnly: false });
      if (sourceSignature !== targetSignature) {
        errors.push(`${pair.id}: heading structure differs between ${pair.source} and ${pair.target}`);
      }
      continue;
    }

    errors.push(`${pair.id}: unsupported sync mode ${pair.mode}`);
  }
}

function checkContainsPair(pair) {
  if (pair.source) {
    readText(pair.source);
  }

  const target = readText(pair.target);
  for (const requiredText of pair.requiredText ?? []) {
    if (!target.includes(requiredText)) {
      errors.push(
        `${pair.id}: ${pair.target} is missing required text ${JSON.stringify(requiredText)}`,
      );
    }
  }
  for (const requiredPattern of pair.requiredPatterns ?? []) {
    const regex = new RegExp(requiredPattern, "m");
    if (!regex.test(target)) {
      errors.push(`${pair.id}: ${pair.target} does not match /${requiredPattern}/`);
    }
  }
}

function checkForbiddenPatterns(patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.pattern, "i");
    const files = globFiles(pattern.glob);
    for (const file of files) {
      const text = readText(file);
      if (regex.test(stripGeneratedBlocks(text))) {
        errors.push(`${pattern.id}: ${file}: ${pattern.message}`);
      }
    }
  }
}

function listChangedFiles() {
  const candidates = [];
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      if (event.pull_request?.base?.sha) {
        candidates.push([`${event.pull_request.base.sha}...HEAD`]);
      }
      if (event.before && !/^0+$/.test(event.before)) {
        candidates.push([`${event.before}...HEAD`]);
      }
    } catch (error) {
      notices.push(`could not read GitHub event payload: ${error.message}`);
    }
  }

  if (process.env.GITHUB_BASE_REF) {
    candidates.push([`origin/${process.env.GITHUB_BASE_REF}...HEAD`]);
  }
  if (
    process.env.GITHUB_EVENT_BEFORE &&
    !/^0+$/.test(process.env.GITHUB_EVENT_BEFORE)
  ) {
    candidates.push([`${process.env.GITHUB_EVENT_BEFORE}...HEAD`]);
  }
  candidates.push(["origin/main...HEAD"]);

  for (const args of candidates) {
    try {
      const output = git(["diff", "--name-only", ...args]);
      return withWorkingTreeChanges(new Set(output.split(/\r?\n/).filter(Boolean)));
    } catch {
      // Try the next comparison base.
    }
  }

  return null;
}

function withWorkingTreeChanges(files) {
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
  ]) {
    try {
      const output = git(args);
      for (const file of output.split(/\r?\n/).filter(Boolean)) {
        files.add(file);
      }
    } catch {
      // Keep the comparison result if a local worktree diff is unavailable.
    }
  }
  return files;
}

function listRepoFiles() {
  const output = git(["ls-files", "--cached", "--others", "--exclude-standard"]);
  return output.split(/\r?\n/).filter(Boolean).sort();
}

function globFiles(pattern) {
  const regex = globToRegExp(pattern);
  return repoFiles.filter((file) => regex.test(file)).sort();
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}

function headingSignature(text, { levelsOnly }) {
  const headings = [];
  let inFence = false;

  for (const line of normalizeText(text).split("\n")) {
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
    const level = match[1].length;
    const heading = normalizeHeading(match[2]);
    headings.push(levelsOnly ? `${level}` : `${level}:${heading}`);
  }

  return headings.join("\n");
}

function normalizeHeading(heading) {
  return heading
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function applyReplacements(text, replacements) {
  let result = text;
  for (const replacement of replacements) {
    result = result.split(replacement.from).join(replacement.to);
  }
  return result;
}

function stripGeneratedBlocks(text) {
  return normalizeText(text).replace(
    /<!-- audit:generated id=[^>]+ -->[\s\S]*?<!-- \/audit:generated -->/g,
    "",
  );
}

function stripPrefix(file, prefix) {
  if (!prefix) {
    return file;
  }
  if (!file.startsWith(prefix)) {
    errors.push(`${file}: expected prefix ${prefix}`);
    return file;
  }
  return file.slice(prefix.length);
}

function readText(file) {
  return normalizeText(readFileSync(join(root, file), "utf8"));
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, "\n");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function basename(file) {
  return file.slice(file.lastIndexOf("/") + 1);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
