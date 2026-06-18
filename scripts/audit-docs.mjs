#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-docs.mts
//
// The scripts/audit-docs.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectInstructionSizeBudgetViolations,
  collectPolicyConfigDrift,
  collectRootMarkdownAllowlistViolations,
  collectTypeSuppressionViolations,
} from './consistency-helpers.mjs';

const root = process.cwd();
const manifestPath = 'audit/sync-manifest.json';
const args = new Set(process.argv.slice(2));
if (!args.has('--check')) {
  console.error('usage: node scripts/audit-docs.mjs --check');
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
checkShellFileLists(
  manifest.shellFileLists ?? [],
  manifest.generatedBlocks ?? [],
);
checkSyncPairs(manifest.syncPairs ?? []);
checkInstructionSizeBudgets(manifest.instructionSizeBudgets ?? null);
checkBundleBudgets(manifest.bundleBudgets ?? []);
checkForbiddenPatterns(manifest.forbiddenPatterns ?? []);
checkRootMarkdownAllowlist(manifest.rootMarkdownAllowlist ?? null);
checkTypeSuppressionBudgets(manifest.typeSuppressionBudgets ?? null);
checkConfigInstructionDrift();
checkGeneratedSourcePairs();
if (errors.length > 0) {
  console.error('documentation audit failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  const remediation = buildRemediation(errors);
  if (remediation.length > 0) {
    console.error('');
    console.error('remediation:');
    for (const line of remediation) {
      console.error(`- ${line}`);
    }
  }
  process.exit(1);
}
for (const notice of notices) {
  console.log(`notice: ${notice}`);
}
console.log('documentation audit passed');
// Structural pairing guard for the TypeScript migration: every
// `src/**/*.mts` source must have its generated `.mjs` artifact committed,
// and every banner-marked generated `.mjs` must have its source. This is a
// pure-`node:` existence check (no TypeScript dependency) so it runs in the
// install-free bare-node CI lane alongside the rest of the audit.
function checkGeneratedSourcePairs() {
  const bannerPattern = /^\/\/ idd-generated-from:\s*(\S+)/m;
  const repoFileSet = new Set(repoFiles);
  // Forward direction: each source has its generated counterpart.
  for (const source of globFiles('src/**/*.mts')) {
    const emitted = emittedPathForSource(source);
    if (!emitted) {
      errors.push(
        `${source}: TypeScript helper sources must live under src/scripts/ or src/bin/ so the generated .mjs path is well-defined`,
      );
      continue;
    }
    if (!repoFileSet.has(emitted)) {
      errors.push(
        `${source}: missing generated artifact ${emitted}; run \`pnpm run build\` and commit the result`,
      );
    }
  }
  // Reverse direction: each banner-marked artifact has its source, and the
  // banner resolves back to this exact file.
  for (const emitted of [
    ...globFiles('scripts/**/*.mjs'),
    ...globFiles('bin/**/*.mjs'),
  ]) {
    const match = bannerPattern.exec(readText(emitted));
    if (!match) {
      continue;
    }
    const declaredSource = match[1];
    if (!repoFileSet.has(declaredSource)) {
      errors.push(
        `${emitted}: generated-from banner names ${declaredSource}, which does not exist`,
      );
      continue;
    }
    const expectedEmitted = emittedPathForSource(declaredSource);
    if (expectedEmitted !== emitted) {
      errors.push(
        `${emitted}: generated-from banner names ${declaredSource}, which maps to ${expectedEmitted ?? '(invalid source path)'}, not this file`,
      );
    }
  }
}
function emittedPathForSource(source) {
  if (
    !source.endsWith('.mts') ||
    !(source.startsWith('src/scripts/') || source.startsWith('src/bin/'))
  ) {
    return null;
  }
  return source.slice('src/'.length).replace(/\.mts$/, '.mjs');
}
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
        errors.push(
          `${pair.id}: ${link.file} is missing ${JSON.stringify(link.text)}`,
        );
      }
    }
    if (pair.structure === 'heading-levels') {
      const firstLevels = headingSignature(readText(first), {
        levelsOnly: true,
      });
      const secondLevels = headingSignature(readText(second), {
        levelsOnly: true,
      });
      if (firstLevels !== secondLevels) {
        errors.push(
          `${pair.id}: README heading levels differ between ${first} and ${second}`,
        );
      }
    }
  }
}
function checkPairedChange(id, first, second) {
  if (changedFiles === null) {
    notices.push(
      `${id}: skipped paired-change check because no git comparison base was available`,
    );
    return;
  }
  const firstChanged = changedFiles.has(first);
  const secondChanged = changedFiles.has(second);
  if (firstChanged !== secondChanged) {
    errors.push(`${id}: ${first} and ${second} must be changed together`);
  }
}
function checkFileSets(fileSets, syncPairs) {
  const coveredSyncPairs = new Set(
    syncPairs.map((pair) => `${pair.source}\0${pair.target}`),
  );
  for (const fileSet of fileSets) {
    const sourceFiles = globFiles(fileSet.sourceGlob);
    const targetFiles = globFiles(fileSet.targetGlob);
    if (fileSet.match !== 'basename') {
      errors.push(
        `${fileSet.id}: unsupported file set match mode ${fileSet.match}`,
      );
      continue;
    }
    const sourceNames = new Set(sourceFiles.map((file) => basename(file)));
    const targetNames = new Set(targetFiles.map((file) => basename(file)));
    const sourceByName = new Map(
      sourceFiles.map((file) => [basename(file), file]),
    );
    const targetByName = new Map(
      targetFiles.map((file) => [basename(file), file]),
    );
    for (const sourceName of sourceNames) {
      if (!targetNames.has(sourceName)) {
        errors.push(`${fileSet.id}: target is missing ${sourceName}`);
        continue;
      }
      if (fileSet.requireSyncPairs) {
        const source = sourceByName.get(sourceName);
        const target = targetByName.get(sourceName);
        if (!coveredSyncPairs.has(`${source}\0${target}`)) {
          errors.push(
            `${fileSet.id}: ${sourceName} is missing a syncPairs entry`,
          );
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
        errors.push(
          `${fileSet.id}: target is missing required ${requiredName}`,
        );
      }
    }
  }
}
function checkGeneratedBlocks(blocks) {
  for (const block of blocks) {
    const text = readText(block.file);
    const startMarker = `<!-- audit:generated id=${block.id} -->`;
    const endMarker = '<!-- /audit:generated -->';
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
function checkShellFileLists(lists, generatedBlocks) {
  const blockById = new Map(generatedBlocks.map((block) => [block.id, block]));
  for (const list of lists) {
    const sourceBlock = blockById.get(list.generatedBlock);
    if (!sourceBlock) {
      errors.push(`${list.id}: unknown generated block ${list.generatedBlock}`);
      continue;
    }
    const text = readText(list.file);
    const marker = `<!-- audit:shell-list id=${list.id} -->`;
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      errors.push(`${list.id}: ${list.file} is missing ${marker}`);
      continue;
    }
    const code = nextFencedCodeBlock(
      text,
      markerIndex + marker.length,
      list.id,
    );
    if (code === null) {
      continue;
    }
    const actual = extractShellForFiles(code, list.id);
    const strip = list.stripPrefix ?? sourceBlock.stripPrefix;
    const expected = resolveBlockFiles(sourceBlock).map((file) =>
      stripPrefix(file, strip),
    );
    if (actual.join('\n') !== expected.join('\n')) {
      errors.push(`${list.id}: shell file list in ${list.file} is stale`);
    }
  }
}
function renderGeneratedBlock(block) {
  const files = resolveBlockFiles(block);
  const renderedFiles = files.map((file) =>
    stripPrefix(file, block.stripPrefix),
  );
  return `\n\n\`\`\`${block.language ?? 'text'}\n${renderedFiles.join('\n')}\n\`\`\`\n\n`;
}
function resolveBlockFiles(block) {
  const files = block.paths
    ? [...block.paths]
    : uniqueSorted((block.sourceGlobs ?? []).flatMap(globFiles));
  const actualFiles = uniqueSorted(
    (block.sourceGlobs ?? []).flatMap(globFiles),
  );
  if (block.paths && block.sourceGlobs) {
    const expectedSet = new Set(block.paths);
    for (const actual of actualFiles) {
      if (!expectedSet.has(actual)) {
        errors.push(`${block.id}: manifest paths omit ${actual}`);
      }
    }
    for (const expected of block.paths) {
      if (!actualFiles.includes(expected)) {
        errors.push(
          `${block.id}: manifest path does not exist or match globs: ${expected}`,
        );
      }
    }
  }
  return files;
}
function checkSyncPairs(pairs) {
  for (const pair of pairs) {
    if (pair.mode === 'contains') {
      checkContainsPair(pair);
      continue;
    }
    const source = applyReplacements(
      readText(pair.source),
      pair.replacements ?? [],
    );
    const target = readText(pair.target);
    if (pair.mode === 'exact' || pair.mode === 'concreted') {
      if (normalizeText(source) !== normalizeText(target)) {
        errors.push(
          `${pair.id}: ${pair.source} and ${pair.target} differ in ${pair.mode} mode`,
        );
      }
      continue;
    }
    if (pair.mode === 'structure') {
      const sourceSignature = headingSignature(source, { levelsOnly: false });
      const targetSignature = headingSignature(target, { levelsOnly: false });
      if (sourceSignature !== targetSignature) {
        errors.push(
          `${pair.id}: heading structure differs between ${pair.source} and ${pair.target}`,
        );
      }
      continue;
    }
    errors.push(`${pair.id}: unsupported sync mode ${pair.mode}`);
  }
}
function checkContainsPair(pair) {
  if (pair.reference) {
    readText(pair.reference);
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
    const regex = new RegExp(requiredPattern, 'm');
    if (!regex.test(target)) {
      errors.push(
        `${pair.id}: ${pair.target} does not match /${requiredPattern}/`,
      );
    }
  }
}
function checkForbiddenPatterns(patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.pattern, 'i');
    const files = globFiles(pattern.glob);
    for (const file of files) {
      const text = readText(file);
      if (regex.test(stripGeneratedBlocks(text))) {
        errors.push(`${pattern.id}: ${file}: ${pattern.message}`);
      }
    }
  }
}
function checkRootMarkdownAllowlist(config) {
  errors.push(...collectRootMarkdownAllowlistViolations(repoFiles, config));
}
// Type-suppression budget guard (ratchet, mirroring bundleBudgets): a
// pure `node:` text scan so the bare-node lane enforces the budgets with
// no typescript dependency. The collector lives in consistency-helpers so
// it can be unit-tested without I/O.
function checkTypeSuppressionBudgets(config) {
  if (!config) {
    return;
  }
  // A present budget entry with missing, empty, or non-string globs
  // would scan zero (or the wrong) files and report success — fail
  // closed on the misconfiguration instead of silently passing a CI
  // quality gate. Non-string entries are rejected, not coerced: a
  // stringified object would otherwise become a pseudo-glob matching
  // nothing.
  const rawGlobs = Array.isArray(config.globs) ? config.globs : [];
  const globs = rawGlobs.filter(
    (glob) => typeof glob === 'string' && glob.trim().length > 0,
  );
  if (globs.length === 0 || globs.length !== rawGlobs.length) {
    errors.push(
      `${String(config.id ?? 'type-suppression-budgets')}: globs must be a non-empty array of non-empty glob strings`,
    );
    return;
  }
  const files = uniqueSorted(globs.flatMap(globFiles)).map((path) => ({
    path,
    text: readText(path),
  }));
  errors.push(...collectTypeSuppressionViolations(files, config));
}
function checkConfigInstructionDrift() {
  const pairs = [
    {
      configPath: '.github/idd/config.json',
      overviewPath: '.github/instructions/idd-overview-core.instructions.md',
    },
    {
      configPath: 'idd-template/.github/idd/config.json',
      overviewPath:
        'idd-template/.github/instructions/idd-overview-core.instructions.md',
    },
  ];
  for (const pair of pairs) {
    const hasConfig = repoFiles.includes(pair.configPath);
    const hasOverview = repoFiles.includes(pair.overviewPath);
    if (!hasConfig && !hasOverview) {
      continue;
    }
    if (!hasConfig || !hasOverview) {
      errors.push(
        `missing config/overview pair: expected both ${pair.configPath} and ${pair.overviewPath}`,
      );
      continue;
    }
    let config;
    try {
      config = JSON.parse(readText(pair.configPath));
    } catch {
      errors.push(`${pair.configPath} is not valid JSON`);
      continue;
    }
    const drifts = collectPolicyConfigDrift(
      config,
      readText(pair.overviewPath),
    );
    if (drifts.length > 0) {
      const summary = drifts
        .map((drift) => {
          if (drift.reason) {
            return `${drift.path} ${drift.reason}`;
          }
          return `${drift.path} expected ${JSON.stringify(drift.expected)} got ${JSON.stringify(drift.actual)}`;
        })
        .join('; ');
      errors.push(
        `${pair.configPath} drifts from ${pair.overviewPath}: ${summary}`,
      );
      continue;
    }
    notices.push(
      `${pair.configPath} matches ${pair.overviewPath} command and scope defaults`,
    );
  }
}
function buildRemediation(currentErrors) {
  if (!containsMirrorDrift(currentErrors)) {
    return [];
  }
  const syncCommand = detectSyncCommand();
  const lines = [];
  if (syncCommand) {
    lines.push(
      `run \`${syncCommand}\` to refresh mirrored files from canonical sources`,
    );
  } else {
    lines.push(
      'align canonical files and their mirrored counterparts for the reported drift paths',
    );
  }
  lines.push('re-run `node scripts/audit-docs.mjs --check`');
  return lines;
}
function containsMirrorDrift(currentErrors) {
  return currentErrors.some((error) =>
    /generated block .* is stale|shell file list .* is stale| and .* differ in (exact|concreted) mode|heading structure differs between|target is missing|target has unexpected|is missing a syncPairs entry|manifest paths omit|manifest path does not exist or match globs/.test(
      error,
    ),
  );
}
function detectSyncCommand() {
  if (repoFiles.includes('package.json')) {
    try {
      const packageJson = JSON.parse(readText('package.json'));
      if (typeof packageJson.scripts?.['docs:sync'] === 'string') {
        const command = docsSyncCommandByPackageManager(
          packageJson.packageManager,
        );
        if (command) {
          return command;
        }
      }
    } catch {
      // Keep fallback discovery if package.json is not parseable.
    }
  }
  if (repoFiles.includes('scripts/sync-docs.mjs')) {
    return 'node scripts/sync-docs.mjs --apply';
  }
  return '';
}
function docsSyncCommandByPackageManager(packageManager) {
  const name =
    typeof packageManager === 'string' ? packageManager.split('@')[0] : '';
  switch (name) {
    case 'pnpm':
      return 'pnpm run docs:sync';
    case 'npm':
      return 'npm run docs:sync';
    case 'yarn':
      return 'yarn docs:sync';
    case 'bun':
      return 'bun run docs:sync';
    default:
      return '';
  }
}
function checkInstructionSizeBudgets(config) {
  // The scope/skip decision and budget evaluation live in the pure helper
  // so they can be unit-tested; the audit pipeline supplies the changed
  // file set, a glob lister, and a reader. The helper reads only changed
  // files, so unchanged instruction files are never loaded from disk.
  const result = collectInstructionSizeBudgetViolations(
    config,
    changedFiles,
    () =>
      globFiles(config?.glob ?? '.github/instructions/idd-*.instructions.md'),
    readText,
  );
  errors.push(...result.errors);
  notices.push(...result.notices);
}
function checkBundleBudgets(budgets) {
  for (const budget of budgets) {
    const id = budget.id ?? 'bundle-budget';
    const files = budget.files ?? [];
    const limitBytes = Number(budget.limitBytes);
    if (!Number.isFinite(limitBytes) || limitBytes < 0) {
      errors.push(`${id}: limitBytes must be a non-negative number`);
      continue;
    }
    let totalBytes = 0;
    for (const file of files) {
      const text = readText(file);
      totalBytes += Buffer.byteLength(text, 'utf8');
    }
    if (totalBytes > limitBytes) {
      errors.push(
        `${id}: bundle total is ${totalBytes} bytes (limit ${limitBytes}); files: ${files.join(', ')}`,
      );
    }
  }
}
function listChangedFiles() {
  const candidates = [];
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let eventBefore = '';
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      if (event.pull_request?.base?.sha) {
        candidates.push([`${event.pull_request.base.sha}...HEAD`]);
      }
      if (event.before && !/^0+$/.test(event.before)) {
        eventBefore = event.before;
      }
    } catch (error) {
      notices.push(`could not read GitHub event payload: ${error.message}`);
    }
  }
  if (process.env.GITHUB_BASE_REF) {
    candidates.push([`origin/${process.env.GITHUB_BASE_REF}...HEAD`]);
  }
  candidates.push(['origin/main...HEAD']);
  if (eventBefore) {
    candidates.push([`${eventBefore}...HEAD`]);
  }
  if (
    process.env.GITHUB_EVENT_BEFORE &&
    !/^0+$/.test(process.env.GITHUB_EVENT_BEFORE)
  ) {
    candidates.push([`${process.env.GITHUB_EVENT_BEFORE}...HEAD`]);
  }
  for (const args of candidates) {
    try {
      const output = git(['diff', '--name-only', ...args]);
      return withWorkingTreeChanges(
        new Set(output.split(/\r?\n/).filter(Boolean)),
      );
    } catch {
      // Try the next comparison base.
    }
  }
  return null;
}
function withWorkingTreeChanges(files) {
  for (const args of [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
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
  const output = git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  return output.split(/\r?\n/).filter(Boolean).sort();
}
function globFiles(pattern) {
  const regex = globToRegExp(pattern);
  return repoFiles.filter((file) => regex.test(file)).sort();
}
function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
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
  for (const line of normalizeText(text).split('\n')) {
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
  return headings.join('\n');
}
function normalizeHeading(heading) {
  return heading
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
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
    '',
  );
}
function nextFencedCodeBlock(text, startIndex, id) {
  const fenceStart = text.indexOf('```', startIndex);
  if (fenceStart === -1) {
    errors.push(`${id}: missing fenced code block after marker`);
    return null;
  }
  const codeStart = text.indexOf('\n', fenceStart);
  if (codeStart === -1) {
    errors.push(`${id}: malformed fenced code block`);
    return null;
  }
  const fenceEnd = text.indexOf('\n```', codeStart + 1);
  if (fenceEnd === -1) {
    errors.push(`${id}: fenced code block is not closed`);
    return null;
  }
  return text.slice(codeStart + 1, fenceEnd);
}
function extractShellForFiles(code, id) {
  const lines = code.split('\n');
  const loopStart = lines.findIndex((line) => line.trim() === 'for FILE in \\');
  if (loopStart === -1) {
    errors.push(`${id}: missing "for FILE in \\" loop`);
    return [];
  }
  const loopEnd = lines.findIndex(
    (line, index) => index > loopStart && line.trim() === 'do',
  );
  if (loopEnd === -1) {
    errors.push(`${id}: missing "do" after FILE loop`);
    return [];
  }
  const files = [];
  for (const line of lines.slice(loopStart + 1, loopEnd)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^"([^"]+)"(?:\s+\\)?$/.exec(trimmed);
    if (!match) {
      errors.push(`${id}: unsupported FILE entry ${JSON.stringify(trimmed)}`);
      continue;
    }
    files.push(match[1]);
  }
  return files;
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
  try {
    return normalizeText(readFileSync(join(root, file), 'utf8'));
  } catch (error) {
    const candidate = error;
    errors.push(
      `${file}: could not read file (${candidate.code ?? candidate.message})`,
    );
    return '';
  }
}
function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}
function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
