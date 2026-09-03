#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-docs.mts
//
// The scripts/audit-docs.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  buildOkfIndexRows,
  collectBinExecutableModeViolations,
  collectContextCeilingViolations,
  collectDocBudgetDriftViolations,
  collectDuplicateSyncPairTargets,
  collectEnginesRangeMirrorViolations,
  collectGeneratedFromBannerViolations,
  collectInstructionSizeBudgetViolations,
  collectOkfFrontmatterViolations,
  collectPolicyConfigDrift,
  collectRootMarkdownAllowlistViolations,
  collectTypeSuppressionViolations,
  globFiles,
  isBannerScopedInstructionTarget,
  renderOkfIndexMarkdownTable,
  resolveGeneratedBlockFiles,
  stripGeneratedFromBanner,
  uniqueSorted,
} from './consistency-helpers.mjs';
import {
  collectDocumentedHelperInvocationFlags,
  collectHelperFlagDriftViolations,
} from './helper-flag-drift.mjs';
import { collectMarkdownLinkAuditViolations } from './markdown-link-audit.mjs';

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
// The fixed, known mirror set for this repository's engines.node range
// (#1706) -- not manifest-configurable, since these are this repository's
// own specific files, not an adopter-extensible convention.
const ENGINES_RANGE_MIRRORS = [
  { file: '.nvmrc', mode: 'low-bound-line' },
  { file: '.node-version', mode: 'low-bound-line' },
  { file: '.tool-versions', mode: 'low-bound-contains' },
  { file: '.github/workflows/lint.yml', mode: 'full-range' },
  {
    file: '.github/workflows/idd-advisory-convergence.yml',
    mode: 'full-range',
  },
  {
    file: '.github/workflows/pnpm-boundary-node22-floor.yml',
    mode: 'low-bound-contains',
  },
  { file: '.github/CONTRIBUTING.md', mode: 'full-range' },
  { file: '.github/CONTRIBUTING.ja.md', mode: 'full-range' },
  { file: '.github/CONTRIBUTING.zh.md', mode: 'full-range' },
  { file: 'docs/typescript-sources.md', mode: 'full-range' },
  { file: 'docs/workshop/README.md', mode: 'components' },
  { file: 'docs/stalled-session-quiet-check.md', mode: 'components' },
  { file: 'src/scripts/helper-runtime-manifest.mts', mode: 'full-range' },
];
checkReadmePairs(manifest.readmePairs ?? []);
checkFileSets(manifest.fileSets ?? [], manifest.syncPairs ?? []);
checkGeneratedBlocks(manifest.generatedBlocks ?? []);
checkShellFileLists(
  manifest.shellFileLists ?? [],
  manifest.generatedBlocks ?? [],
);
checkSyncPairs(manifest.syncPairs ?? []);
checkGeneratedFromBanners(manifest.syncPairs ?? []);
checkInstructionSizeBudgets(manifest.instructionSizeBudgets);
checkContextCeiling(
  manifest.contextCeiling ?? null,
  checkBundleBudgets(manifest.bundleBudgets ?? []),
);
checkDocBudgetNumbers();
checkForbiddenPatterns(manifest.forbiddenPatterns ?? []);
checkRootMarkdownAllowlist(manifest.rootMarkdownAllowlist ?? null);
checkTypeSuppressionBudgets(manifest.typeSuppressionBudgets ?? null);
checkOkfBundles(manifest.okfBundles ?? null);
checkMarkdownLinkAudit(manifest.markdownLinkAudit ?? null);
checkConfigInstructionDrift();
checkHelperFlagDrift();
checkGeneratedSourcePairs();
checkEnginesRangeMirrors();
checkBinExecutableMode();
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
  for (const source of globFiles('src/**/*.mts', repoFiles)) {
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
    ...globFiles('scripts/**/*.mjs', repoFiles),
    ...globFiles('bin/**/*.mjs', repoFiles),
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
// Guards against the executable-mode drift #1971 found: a bin/*.mjs CLI
// entry-point script with a #! shebang tracked non-executable in git,
// which surfaces as a spurious mode-only `git status`/`git diff` after
// every fresh install (the package manager's `bin`-field resolution
// chmods the working-tree file, but never git's own tracked mode).
function checkBinExecutableMode() {
  const binFiles = globFiles('bin/**/*.mjs', repoFiles);
  const modes = trackedFileModes(binFiles);
  errors.push(
    ...collectBinExecutableModeViolations(
      binFiles,
      readText,
      (file) => modes.get(file) ?? null,
    ),
  );
}
// The git-tracked mode (e.g. "100644"/"100755") for each of `files`, keyed
// by path. A file absent from the returned map has no tracked index entry
// (working-tree-only, or already deleted).
function trackedFileModes(files) {
  const modes = new Map();
  if (files.length === 0) {
    return modes;
  }
  const output = git(['ls-files', '-s', '--', ...files]);
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+)\s+\S+\s+\S+\t(.+)$/.exec(line);
    if (match) {
      modes.set(match[2], match[1]);
    }
  }
  return modes;
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
    const sourceFiles = globFiles(fileSet.sourceGlob, repoFiles);
    const targetFiles = globFiles(fileSet.targetGlob, repoFiles);
    if (fileSet.match !== 'basename') {
      errors.push(
        `${fileSet.id}: unsupported file set match mode ${fileSet.match}`,
      );
      continue;
    }
    // Basename matching is ambiguous when two files on the same side of a
    // recursive glob share a basename (for example a new
    // `references/a/contract.md` alongside an existing
    // `references/contract.md`): the Set/Map keyed by basename below would
    // silently collapse them to one entry, so the new file's coverage would
    // never actually be checked and could pass by riding the existing
    // file's target and syncPairs entry. Fail closed instead of guessing
    // which path the basename "really" refers to.
    const ambiguousSourceBasenames = findDuplicateBasenames(sourceFiles);
    for (const [name, paths] of ambiguousSourceBasenames) {
      errors.push(
        `${fileSet.id}: ambiguous basename ${name} matches multiple source files (${paths.join(', ')}); basename matching cannot distinguish them`,
      );
    }
    const ambiguousTargetBasenames = findDuplicateBasenames(targetFiles);
    for (const [name, paths] of ambiguousTargetBasenames) {
      errors.push(
        `${fileSet.id}: ambiguous basename ${name} matches multiple target files (${paths.join(', ')}); basename matching cannot distinguish them`,
      );
    }
    if (
      ambiguousSourceBasenames.size > 0 ||
      ambiguousTargetBasenames.size > 0
    ) {
      continue;
    }
    const sourceNames = new Set(
      sourceFiles.map((file) => posix.basename(file)),
    );
    const targetNames = new Set(
      targetFiles.map((file) => posix.basename(file)),
    );
    const sourceByName = new Map(
      sourceFiles.map((file) => [posix.basename(file), file]),
    );
    const targetByName = new Map(
      targetFiles.map((file) => [posix.basename(file), file]),
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
  if (String(block.kind ?? '').trim() === 'okf-table') {
    const rows = buildOkfIndexRows(files, (path) => readText(path), {
      typeOrder: block.typeOrder ?? [],
      excludePaths: block.excludePaths ?? [],
    });
    return renderOkfIndexMarkdownTable(rows, block.linkBase ?? 'docs');
  }
  const renderedFiles = files.map((file) =>
    stripPrefix(file, block.stripPrefix),
  );
  return `\n\n\`\`\`${block.language ?? 'text'}\n${renderedFiles.join('\n')}\n\`\`\`\n\n`;
}
function resolveBlockFiles(block) {
  const blockGlobFiles = (pattern) => globFiles(pattern, repoFiles);
  const files = resolveGeneratedBlockFiles(block, blockGlobFiles);
  const actualFiles = uniqueSorted(
    (block.sourceGlobs ?? []).flatMap(blockGlobFiles),
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
  errors.push(...collectDuplicateSyncPairTargets(pairs));
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
      // Generated instruction targets carry a sync-docs-injected generated-from
      // banner the source does not; strip it before the content comparison so
      // this check stays about content only. The banner itself is verified
      // separately by checkGeneratedFromBanners.
      const targetContent = isBannerScopedInstructionTarget(
        pair.target,
        pair.mode,
      )
        ? stripGeneratedFromBanner(target)
        : target;
      if (normalizeText(source) !== normalizeText(targetContent)) {
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
// Verify that every generated instruction target carries the exact
// sync-docs-injected generated-from banner naming its source. A missing,
// malformed, or wrong-source banner fails the audit with a targeted message
// (checkSyncPairs already covers content drift after stripping the banner). The
// pure helper carries the logic so it can be unit-tested.
function checkGeneratedFromBanners(pairs) {
  errors.push(...collectGeneratedFromBannerViolations(pairs, readText));
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
    const files = globFiles(pattern.glob, repoFiles);
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
// OKF frontmatter conformance audit (#1680): the collector lives in
// consistency-helpers so it can be unit-tested with synthetic fixtures. The
// audit pipeline supplies the live glob (bound to `repoFiles`) and reader.
function checkOkfBundles(bundles) {
  errors.push(
    ...collectOkfFrontmatterViolations(
      bundles,
      (pattern) => globFiles(pattern, repoFiles),
      readText,
    ),
  );
}
// Intra-repo markdown link/anchor audit (#1697): resolves every relative
// markdown link's target file and `#fragment` against the target's actual
// GitHub-slugged headings. The collector lives in markdown-link-audit.mts
// (a new sibling module, not consistency-helpers.mts, to keep this change
// isolated from that file's other concurrent edits) so it can be
// unit-tested without I/O; the audit pipeline supplies the live glob and
// reader.
function checkMarkdownLinkAudit(config) {
  errors.push(
    ...collectMarkdownLinkAuditViolations(
      config,
      repoFiles,
      (pattern) => globFiles(pattern, repoFiles),
      readText,
    ),
  );
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
  const files = uniqueSorted(
    globs.flatMap((glob) => globFiles(glob, repoFiles)),
  ).map((path) => ({
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
// Instructions-vs-implementation flag drift (#2477): every fenced
// `node scripts/<helper>.mjs --flag ...` worked example across the doc
// corpus must still name a flag the helper's own `--help` output accepts.
// Helper probing (spawning `--help`) happens here, kept out of the pure
// collector in helper-flag-drift.mts so it stays unit-testable without a
// child process. Results are cached per helper since the same helper is
// typically invoked in many worked examples across the corpus.
function checkHelperFlagDrift() {
  const globs = [
    'docs/**/*.md',
    'idd-template/**/*.md',
    '.github/instructions/**/*.md',
  ];
  const files = uniqueSorted(
    globs.flatMap((glob) => globFiles(glob, repoFiles)),
  ).map((path) => ({ path, text: readText(path) }));
  const documented = collectDocumentedHelperInvocationFlags(files);
  const probeCache = new Map();
  const probe = (helperPath) => {
    const cached = probeCache.get(helperPath);
    if (cached) {
      return cached;
    }
    const exists = repoFiles.includes(helperPath);
    let output = '';
    if (exists) {
      try {
        output = execFileSync('node', [helperPath, '--help'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        // A helper that rejects `--help` (unknown-flag fallback, an
        // interactive-only tool erroring immediately, ...) still often
        // prints its usage text before exiting non-zero -- capture
        // stdout/stderr from the failure rather than treating a non-zero
        // exit as "no output". execFileSync attaches these to the thrown
        // error when `encoding` is set.
        const failure = error;
        output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      }
    }
    const result = { exists, output };
    probeCache.set(helperPath, result);
    return result;
  };
  errors.push(...collectHelperFlagDriftViolations(documented, probe));
}
function checkEnginesRangeMirrors() {
  // Only applies when this repository's own known mirror set is actually
  // present -- a fixture repo unrelated to this guard (or a future repo
  // state without these specific files) is not a violation, matching
  // detectSyncCommand's own repoFiles.includes('package.json') gate.
  if (!repoFiles.includes('package.json')) {
    return;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readText('package.json'));
  } catch {
    errors.push('engines-range-mirrors: package.json could not be parsed');
    return;
  }
  if (packageJson.engines?.node === undefined) {
    // No engines.node declared at all -- nothing for this repo to mirror.
    return;
  }
  const presentMirrors = ENGINES_RANGE_MIRRORS.filter((mirror) =>
    repoFiles.includes(mirror.file),
  );
  errors.push(
    ...collectEnginesRangeMirrorViolations(
      packageJson.engines.node,
      presentMirrors,
      readText,
    ),
  );
}
function buildRemediation(currentErrors) {
  const hasMirrorDrift = containsMirrorDrift(currentErrors);
  const hasManifestListMismatch = containsManifestListMismatch(currentErrors);
  const hasLinkAuditFailure = containsLinkAuditFailure(currentErrors);
  if (!hasMirrorDrift && !hasManifestListMismatch && !hasLinkAuditFailure) {
    return [];
  }
  const lines = [];
  if (hasLinkAuditFailure) {
    lines.push(
      'retarget the broken link to an existing file/anchor, rename the heading back, or add `<!-- audit:ignore-link -->` on the link line for a narrow, intentional exception (see audit/README.md)',
    );
  }
  if (hasMirrorDrift) {
    const syncCommand = detectSyncCommand();
    if (syncCommand) {
      lines.push(
        `run \`${syncCommand}\` to refresh mirrored files from canonical sources`,
      );
    } else {
      lines.push(
        'align canonical files and their mirrored counterparts for the reported drift paths',
      );
    }
  }
  if (hasManifestListMismatch) {
    // A manifest-list mismatch is not mirror drift: `docs:sync` reads
    // `generatedBlocks[].paths` as-is, so it cannot resolve a disagreement
    // between `paths` and what `sourceGlobs` actually matches (#1703).
    lines.push(
      "edit `audit/sync-manifest.json`'s `generatedBlocks[].paths` to match the reported `sourceGlobs` result -- `docs:sync` cannot fix a manifest-list mismatch",
    );
  }
  lines.push('re-run `node scripts/audit-docs.mjs --check`');
  return lines;
}
function containsMirrorDrift(currentErrors) {
  return currentErrors.some((error) =>
    /generated block .* is stale|shell file list .* is stale| and .* differ in (exact|concreted) mode|heading structure differs between|target is missing|target has unexpected|is missing a syncPairs entry/.test(
      error,
    ),
  );
}
function containsManifestListMismatch(currentErrors) {
  return currentErrors.some((error) =>
    /manifest paths omit|manifest path does not exist or match globs/.test(
      error,
    ),
  );
}
function containsLinkAuditFailure(currentErrors) {
  return currentErrors.some((error) =>
    /-> missing file |-> missing directory |-> heading anchor #.* not found in |outside .* in template context/.test(
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
function checkInstructionSizeBudgets(configs) {
  // One entry per audited glob: the dogfooding `.github/instructions/`
  // copy and the canonical `idd-template/.github/instructions/` source are
  // separate entries so a `structure`-mode divergence between them (prose
  // free to differ, byte size free to drift) cannot silently exceed the
  // cap on one side while only the other side is measured (#1667). Each
  // entry's own `id` — plus the audited path's own prefix in every error
  // message the helper emits — is the scope/label that keeps output
  // unambiguous about which copy violated its budget; see
  // `audit/README.md#instruction-size-budgets`.
  //
  // `configs` is declared `unknown` (rather than trusting the manifest's
  // declared type) because it comes straight from `JSON.parse`: a manifest
  // left in the pre-#1667 single-object shape, or otherwise malformed,
  // must fail closed with a readable audit error instead of throwing
  // "configs is not iterable" out of the `for` loop below.
  if (configs == null) {
    return;
  }
  if (!Array.isArray(configs)) {
    errors.push(
      'instructionSizeBudgets: must be an array of per-glob budget entries, one per audited glob (see audit/README.md#instruction-size-budgets); got the pre-#1667 single-object shape or another non-array value',
    );
    return;
  }
  // The scope/skip decision and budget evaluation for each entry live in
  // the pure helper so they can be unit-tested; the audit pipeline
  // supplies the changed file set, a glob lister, and a reader. The helper
  // reads only changed files, so unchanged instruction files are never
  // loaded from disk.
  for (const rawConfig of configs) {
    // Each array entry is still unvalidated JSON: a `null` (or other
    // non-object) entry would throw on `config.glob` below before the
    // pure helper's own `!config` guard ever runs. Reject it here with a
    // readable error instead of crashing the whole audit run. Arrays pass
    // `typeof === 'object'` too, so reject them explicitly — otherwise an
    // entry like `[[]]` would silently fall through and audit under the
    // default glob instead of erroring.
    if (
      rawConfig === null ||
      typeof rawConfig !== 'object' ||
      Array.isArray(rawConfig)
    ) {
      errors.push(
        `instructionSizeBudgets: each entry must be an object, got ${JSON.stringify(rawConfig)}`,
      );
      continue;
    }
    const config = rawConfig;
    const result = collectInstructionSizeBudgetViolations(
      config,
      changedFiles,
      () =>
        globFiles(
          config.glob ?? '.github/instructions/idd-*.instructions.md',
          repoFiles,
        ),
      readText,
    );
    errors.push(...result.errors);
    notices.push(...result.notices);
  }
}
// Returns the measured per-bundle stats so `checkContextCeiling` can reuse
// this same summation instead of re-reading and re-stripping every bundle
// file a second time.
function checkBundleBudgets(budgets) {
  const stats = [];
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
      // Exclude the generated-from banner from the bundle total: it is
      // mechanical metadata sync-docs stamps in, not authored content, so it
      // must never push a bundle over budget (a no-op on files without one).
      totalBytes += Buffer.byteLength(stripGeneratedFromBanner(text), 'utf8');
    }
    if (totalBytes > limitBytes) {
      errors.push(
        `${id}: bundle total is ${totalBytes} bytes (limit ${limitBytes}); files: ${files.join(', ')}`,
      );
    }
    stats.push({ id, limitBytes, totalBytes });
  }
  return stats;
}
function checkContextCeiling(config, bundleStats) {
  const result = collectContextCeilingViolations(config, bundleStats);
  errors.push(...result.errors);
  notices.push(...result.notices);
}
function checkDocBudgetNumbers() {
  // Cross-check every hardcoded byte value in the guarded docs against the
  // live manifest budgets. The pure helper supplies the logic; the audit
  // pipeline supplies the file reader.
  const result = collectDocBudgetDriftViolations(
    manifest.docBudgetGuard ?? null,
    manifest.instructionSizeBudgets ?? null,
    manifest.bundleBudgets ?? [],
    readText,
  );
  errors.push(...result.errors);
  notices.push(...result.notices);
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
// glob matching against `repoFiles` (an in-memory list already fetched
// from `git ls-files --cached --others --exclude-standard`, see
// `listRepoFiles`) is shared with sync-docs.mts via consistency-helpers.mts
// (#1703) as `globFiles`/`globToRegExp`, imported above.
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
// Returns only the basenames that collide across two or more distinct
// paths in `files`, each mapped to every path sharing that basename.
// Used by checkFileSets to fail closed on an ambiguous basename match
// instead of silently keeping only one path per name.
function findDuplicateBasenames(files) {
  const byName = new Map();
  for (const file of files) {
    const name = posix.basename(file);
    const existing = byName.get(name);
    if (existing) {
      existing.push(file);
    } else {
      byName.set(name, [file]);
    }
  }
  const duplicates = new Map();
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      duplicates.set(name, paths);
    }
  }
  return duplicates;
}
