#!/usr/bin/env node
// idd-generated-from: src/scripts/repository-inventory-audit.mts
// Read-only source-repository inventories and coverage ledgers.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { globFiles } from './consistency-helpers.mjs';
import { PACKAGE_MANAGER_ONLY_HELPERS } from './helper-runtime-manifest.mjs';
export const COVERED_HELPERS = [
  'actions-usage-report',
  'advisory-comment-debounce',
  'advisory-convergence',
  'advisory-wait-state',
  'audit-authored-issue',
  'audit-pr-cleanup',
  'authoring-owner-provenance',
  'branch-conflict-state',
  'branch-name',
  'check-stray-commit-closes',
  'ci-wait-policy',
  'ci-wait-state',
  'claim-approval-gate',
  'claim-lock',
  'clone-lock',
  'copilot-review-wave-audit',
  'token-cost-event',
  'token-cost-harvest',
  'token-cost-report',
  'discover-readiness-check',
  'discover-shared-file-overlap',
  'discover-viability-gate',
  'delete-remote-branch',
  'disposition-non-review-notices',
  'external-check-waiver',
  'force-handoff',
  'forced-handoff-marker',
  'helper-runtime-manifest',
  'idd-critique-delegate',
  'idd-critique-harvest',
  'idd-critique-report',
  'idd-critique-telemetry-hook',
  'idd-doctor',
  'idd-issue-authoring-delegate',
  'idd-roadmap-audit-execute',
  'idd-suggest-untrusted-labelers',
  'idd-worker-report',
  'live-status-digest',
  'local-validation-evidence',
  'local-worktree-recovery',
  'merged-pr-feedback-sweep',
  'phase-id-resolver',
  'pre-merge-readiness',
  'provider-health',
  'provider-outage-declaration',
  'provider-outage-park',
  'rerun-advisory-convergence',
  'resolve-review-thread',
  'resume-claim-routing',
  'resume-route-selection',
  'review-activity-snapshot',
  'review-comment-origin',
  'review-disposition-verify',
  'select-desynced-index',
  'snapshot-issue-body-corpus',
  'stalled-session-quiet-check',
  'suitability-close-execute',
  'suitability-triage',
  'sweep-authoring-markers',
  'verify-import-mirror',
  'verify-install-deps',
  'verify-workshop-integrity',
];
export const EXCLUDED_HELPERS = [
  {
    helper: 'discover-orphan-filter',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'discover-roadmap-graph',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'emit-marker',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'idd-merge-execute',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'idd-onboard',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'post-idd-marker',
    reason:
      'hand-rolled parseArgs() loop (own local function) with a USAGE constant, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'minimize-superseded-markers',
    reason:
      'calls node:util parseArgs directly with bare (non-dashed) option keys, not the shared cli-args.mts FLAG_SPEC convention; no declarative --dashed spec to compare',
  },
  {
    helper: 'update-fixtures',
    reason:
      'ad-hoc argv.includes help check against a HELP constant, no declarative FLAG_SPEC object to compare',
  },
];
const INTERNAL_ENTRY_REASONS = {
  'scripts/sync-docs.mjs': 'source-repository docs generator',
  'scripts/verify-install-deps.mjs': 'source-repository install command',
  'scripts/audit-docs.mjs': 'source-repository docs audit',
  'scripts/audit-code-span-wrap.mjs': 'source-repository Markdown audit',
  'scripts/verify-import-mirror.mjs':
    'checkout-only verifier with a separately registered package path',
  'scripts/check-pnpm-boundary.mjs':
    'source-repository package-manager checker',
  'scripts/idd-onboard.mjs': 'maintainer onboarding tool',
  'scripts/validate-schemas.mjs': 'CI schema self-check',
  'scripts/merged-pr-feedback-sweep.mjs': 'maintainer-only post-merge sweep',
  'scripts/check-untracked-artifacts.mjs': 'build-internal artifact verifier',
  'scripts/token-cost-report.mjs': 'source-repository token-cost report',
  'scripts/actions-usage-report.mjs': 'source-repository Actions report',
  'scripts/token-cost-event.mjs': 'source-repository token-cost event logger',
  'scripts/token-cost-harvest.mjs': 'source-repository token-cost log reader',
  'scripts/idd-critique-harvest.mjs': 'source-repository critique log reader',
  'scripts/idd-critique-report.mjs': 'source-repository critique report',
  'scripts/copilot-review-wave-audit.mjs':
    'source-repository review-wave audit',
  'scripts/snapshot-issue-body-corpus.mjs':
    'source-repository issue corpus tool',
  'scripts/audit-dead-exports.mjs': 'source-repository lint audit',
};
const NON_ADOPTER_BIN_REASONS = {
  'idd-emit-authoring-marker':
    'proposed only in docs/weak-model-authoring-lite-profile-design.md; no backing helper exists',
};
const NON_ADOPTER_SCRIPT_REASONS = {};
const DISTRIBUTED_BIN_BAN_EXEMPTIONS = {
  'docs/permissions.md':
    'documents the bin/idd-merge-execute deny-pattern rather than prescribing an invocation',
  'idd-template/docs/permissions.md':
    'distributed counterpart documents the same deny-pattern',
};
const DOGFOOD_ONLY_TOOLS = {
  'scripts/sync-docs.mjs':
    'generated banner tool visible only in source-repository instructions',
  'scripts/verify-install-deps.mjs':
    'source-repository concrete install command; the template keeps a placeholder',
  'scripts/audit-docs.mjs':
    'source-repository mirror audit; the template keeps a placeholder',
  'scripts/audit-code-span-wrap.mjs':
    'repository-local Markdown authoring guard, not distributed',
  'scripts/token-cost-report.mjs':
    'source-repository token-cost reporter, not an adopter CLI',
};
const BIN_ALLOWLIST = {
  'idd-onboard':
    'Source-repository onboarding tool, invoked from a full source clone.',
  'idd-merged-pr-feedback-sweep':
    'Maintainer-only post-merge sweep, not an adopter command.',
};
const EXPECTED_ROOT_MARKDOWN = [
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'GEMINI.md',
  'README.ja.md',
  'README.md',
  'SECURITY.md',
];
const REQUIRED_INSTRUCTION_BUDGET_GLOBS = [
  '.github/instructions/idd-*.instructions.md',
  'idd-template/.github/instructions/idd-*.instructions.md',
];
const INVOCATION_RE = {
  nodeScripts: /\bnode\s+((?:\.\/|<idd-skill>\/)?scripts\/[a-z0-9-]+\.mjs)\b/g,
  packageManagerEntries:
    /\bnode\s+(?:\.\/)?(node_modules\/@kurone-kito\/idd-skill\/scripts\/[a-z0-9-]+\.mjs)\b/g,
  binMjs: /(?:\.\/)?\bbin\/(idd-[a-zA-Z0-9-]+)\.mjs\b/g,
  packageScripts:
    /(?:npm run|pnpm(?: run)?|yarn(?: run)?)\s+(idd:[a-zA-Z0-9-]+)/g,
};
const FENCE_RE = /^\s*\x60{3}(\S*)/;
const BARE_BIN_RE = /^\s*\$?\s*(idd-[a-zA-Z0-9-]+)\b/;
const FENCED_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console']);
const WORKFLOW_NODE_RE = /\bnode\s+(scripts\/[a-z0-9-]+\.mjs)\b/g;
const WORKFLOW_PACKAGE_RES = [
  /\bpnpm\s+exec\s+(idd-[a-z0-9-]+)\b/g,
  /\byarn\s+(?:--silent\s+)?(idd-[a-z0-9-]+)\b/g,
  /\bnpm\s+exec\s+(idd-[a-z0-9-]+)\b/g,
  /\bnpx\s+--yes\s+--package\s+\S+\s+(idd-[a-z0-9-]+)\b/g,
];
function posix(path) {
  return path.split(sep).join('/');
}
function directChildren(paths, directory) {
  const prefix = `${directory}/`;
  return paths.filter(
    (path) =>
      path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
  );
}
function add(out, ruleId, path, message) {
  out.push({ ruleId, path: posix(path), message });
}
function readText(root, path, out, rule = 'inspection') {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    add(out, rule, path, 'could not read required file');
    return null;
  }
}
function walk(root, directory, out) {
  let entries;
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch {
    add(out, 'inspection', directory, 'could not enumerate directory');
    return [];
  }
  const result = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(root, child, out));
    else if (entry.isFile()) result.push(posix(child));
  }
  return result.sort();
}
function same(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
function sorted(values) {
  return same(values, [...values].sort());
}
function isFlagSpec(source) {
  return /_FLAG_SPEC\s*=\s*\{/.test(source);
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sortViolations(out) {
  return out.sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      a.path.localeCompare(b.path) ||
      a.message.localeCompare(b.message),
  );
}
function checkExemptionMetadata(out) {
  const ledgers = [
    ['source-repository invocation', INTERNAL_ENTRY_REASONS],
    ['non-adopter bin', NON_ADOPTER_BIN_REASONS],
    ['non-adopter package script', NON_ADOPTER_SCRIPT_REASONS],
    ['distributed bin-path', DISTRIBUTED_BIN_BAN_EXEMPTIONS],
    ['dogfood-only instruction tool', DOGFOOD_ONLY_TOOLS],
    ['package bin', BIN_ALLOWLIST],
  ];
  for (const [label, entries] of ledgers) {
    for (const [key, reason] of Object.entries(entries)) {
      if (!reason.trim()) {
        add(
          out,
          'exemption-rationale',
          'src/scripts/repository-inventory-audit.mts',
          `${label} exemption requires a reason: ${key}`,
        );
      }
    }
  }
}
export function findOrphanGeneratedNames(generatedNames, sourceNames) {
  const sources = new Set(
    sourceNames
      .filter((name) => name.endsWith('.mts'))
      .map((name) => name.slice(0, -'.mts'.length)),
  );
  return generatedNames
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => !sources.has(name.slice(0, -'.mjs'.length)))
    .sort();
}
export function scanHelperInvocationFile(content) {
  const nodeScripts = [...content.matchAll(INVOCATION_RE.nodeScripts)].map(
    (match) => match[1],
  );
  const packageManagerEntries = [
    ...content.matchAll(INVOCATION_RE.packageManagerEntries),
  ].map((match) => match[1]);
  const binMjs = [...content.matchAll(INVOCATION_RE.binMjs)].map(
    (match) => match[1],
  );
  const packageScripts = [
    ...content.matchAll(INVOCATION_RE.packageScripts),
  ].map((match) => match[1]);
  const bareBinCommands = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of content.split(/\r?\n/)) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? (fence[1] ?? '') : '';
      continue;
    }
    if (!inFence || !FENCED_LANGS.has(fenceLang)) continue;
    const match = line.match(BARE_BIN_RE);
    if (match) bareBinCommands.push(match[1]);
  }
  return {
    nodeScripts,
    packageManagerEntries,
    binMjs,
    packageScripts,
    bareBinCommands,
  };
}
export function collectHelperInvocationViolations(files, options) {
  const entryPaths = new Set(
    options.commandCatalog.map((entry) => entry.entryPath),
  );
  const binNames = new Set(
    options.commandCatalog.map((entry) => entry.binName),
  );
  const scriptNames = new Set(
    options.commandCatalog.map((entry) => entry.scriptName),
  );
  const packageManagerOnly = new Set(
    options.packageManagerOnlyEntryPaths ??
      PACKAGE_MANAGER_ONLY_HELPERS.map((helper) => helper.installedEntryPath),
  );
  const violations = [];
  for (const file of files) {
    const found = scanHelperInvocationFile(file.content);
    for (const invokedPath of found.nodeScripts) {
      const unprefixed = invokedPath.startsWith('./')
        ? invokedPath.slice(2)
        : invokedPath;
      const sourceCheckout = unprefixed.startsWith('<idd-skill>/');
      const entryPath = sourceCheckout
        ? unprefixed.slice('<idd-skill>/'.length)
        : unprefixed;
      const checkoutOnly = entryPath === 'scripts/verify-import-mirror.mjs';
      if (
        !entryPaths.has(entryPath) &&
        !(
          Object.hasOwn(INTERNAL_ENTRY_REASONS, entryPath) &&
          (!checkoutOnly || sourceCheckout)
        )
      ) {
        violations.push({
          ruleId: 'unbacked-helper',
          path: file.path,
          form: 'node-scripts',
          name: entryPath,
          message:
            'node invocation has no runtime catalog entry or justified internal exception',
        });
      }
    }
    for (const entryPath of found.packageManagerEntries) {
      if (!packageManagerOnly.has(entryPath)) {
        violations.push({
          ruleId: 'unbacked-helper',
          path: file.path,
          form: 'package-manager-entry',
          name: entryPath,
          message:
            'installed package path has no package-manager-only manifest exception',
        });
      }
    }
    for (const binName of found.binMjs) {
      if (
        !binNames.has(binName) &&
        !Object.hasOwn(NON_ADOPTER_BIN_REASONS, binName)
      ) {
        violations.push({
          ruleId: 'unbacked-helper',
          path: file.path,
          form: 'bin-mjs',
          name: binName,
          message:
            'bin path has no runtime catalog entry or non-adopter exception',
        });
      }
      if (
        options.distributedFiles.has(file.path) &&
        !Object.hasOwn(DISTRIBUTED_BIN_BAN_EXEMPTIONS, file.path)
      ) {
        violations.push({
          ruleId: 'distributed-bin-path',
          path: file.path,
          form: 'bin-mjs',
          name: binName,
          message:
            'distributed content prescribes a source-repository bin wrapper path',
        });
      }
    }
    for (const scriptName of found.packageScripts) {
      if (
        !scriptNames.has(scriptName) &&
        !Object.hasOwn(NON_ADOPTER_SCRIPT_REASONS, scriptName)
      ) {
        violations.push({
          ruleId: 'unbacked-helper',
          path: file.path,
          form: 'package-script',
          name: scriptName,
          message: 'package script invocation has no runtime catalog entry',
        });
      }
    }
    for (const binName of found.bareBinCommands) {
      if (
        !binNames.has(binName) &&
        !Object.hasOwn(NON_ADOPTER_BIN_REASONS, binName)
      ) {
        violations.push({
          ruleId: 'unbacked-helper',
          path: file.path,
          form: 'bare-bin-command',
          name: binName,
          message:
            'bare command has no runtime catalog entry or non-adopter exception',
        });
      }
    }
  }
  return violations;
}
export function resolveDistributedFiles(repoFiles, manifest) {
  const distributed = new Set(
    repoFiles.filter((file) => file.startsWith('idd-template/')),
  );
  for (const fileSet of Array.isArray(manifest.fileSets)
    ? manifest.fileSets
    : []) {
    if (
      !isRecord(fileSet) ||
      typeof fileSet.sourceGlob !== 'string' ||
      typeof fileSet.targetGlob !== 'string'
    )
      continue;
    if (!fileSet.sourceGlob.startsWith('idd-template/')) continue;
    for (const target of globFiles(fileSet.targetGlob, repoFiles))
      distributed.add(target);
  }
  for (const pair of Array.isArray(manifest.syncPairs)
    ? manifest.syncPairs
    : []) {
    if (!isRecord(pair) || typeof pair.target !== 'string') continue;
    if (
      typeof pair.source === 'string' &&
      pair.source.startsWith('idd-template/')
    ) {
      distributed.add(pair.target);
    }
  }
  return distributed;
}
export function scanTemplateWorkflowRegistrations(files, commandCatalog) {
  const entries = new Set(commandCatalog.map((entry) => entry.entryPath));
  const bins = new Set(commandCatalog.map((entry) => entry.binName));
  const nodeEntryPaths = new Set();
  const packageRunnerBinNames = new Set();
  const violations = [];
  for (const file of files) {
    const source = file.content
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const match of source.matchAll(WORKFLOW_NODE_RE)) {
      const path = match[1];
      nodeEntryPaths.add(path);
      if (!entries.has(path))
        add(
          violations,
          'template-workflow-registration',
          file.path,
          `workflow invokes an unregistered node helper: ${path}`,
        );
    }
    for (const pattern of WORKFLOW_PACKAGE_RES) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        packageRunnerBinNames.add(name);
        if (!bins.has(name))
          add(
            violations,
            'template-workflow-registration',
            file.path,
            `workflow invokes an unregistered package helper: ${name}`,
          );
      }
    }
  }
  return {
    violations,
    nodeEntryPaths: [...nodeEntryPaths].sort(),
    packageRunnerBinNames: [...packageRunnerBinNames].sort(),
  };
}
export const CHECK_FAMILIES = [
  'repository-inventory',
  'runtime-registration',
  'instruction-invocations',
  'template-workflows',
  'helper-cli-migration',
  'help-flag-coverage',
  'manifest-ledgers',
  'unpointed-source-form',
];
function checkRepositoryInventory(root, out) {
  const packageText = readText(root, 'package.json', out);
  const attributes = readText(root, '.gitattributes', out);
  const manifestText = readText(root, 'audit/sync-manifest.json', out);
  let packageJson = null;
  let manifest = null;
  try {
    if (packageText !== null) {
      const value = JSON.parse(packageText);
      if (isRecord(value)) packageJson = value;
      else
        add(
          out,
          'repository-inventory',
          'package.json',
          'expected a JSON object',
        );
    }
  } catch {
    add(out, 'repository-inventory', 'package.json', 'invalid JSON');
  }
  try {
    if (manifestText !== null) {
      const value = JSON.parse(manifestText);
      if (isRecord(value)) {
        manifest = value;
      } else
        add(
          out,
          'repository-inventory',
          'audit/sync-manifest.json',
          'expected a JSON object',
        );
    }
  } catch {
    add(
      out,
      'repository-inventory',
      'audit/sync-manifest.json',
      'invalid JSON',
    );
  }
  if (packageJson?.bin && !sorted(Object.keys(packageJson.bin))) {
    add(
      out,
      'helper-bin-order',
      'package.json',
      'bin keys must be in ascending order',
    );
  }
  const scripts = directChildren(walk(root, 'scripts', out), 'scripts').filter(
    (path) => path.endsWith('.mjs'),
  );
  const scriptSources = new Set(
    directChildren(walk(root, 'src/scripts', out), 'src/scripts')
      .filter((path) => path.endsWith('.mts'))
      .map((path) => path.slice('src/scripts/'.length, -4)),
  );
  for (const name of findOrphanGeneratedNames(
    scripts.map((path) => path.slice('scripts/'.length)),
    [...scriptSources].map((name) => `${name}.mts`),
  )) {
    add(
      out,
      'helper-source-pair',
      `scripts/${name}`,
      'generated helper has no matching src/scripts .mts source',
    );
  }
  const generated = [];
  for (const path of scripts) {
    const source = readText(root, path, out);
    if (
      source !== null &&
      Buffer.from(source, 'utf8')
        .subarray(0, 200)
        .toString('utf8')
        .includes('idd-generated-from')
    ) {
      generated.push(path.slice('scripts/'.length));
    }
  }
  const generatedLines = (attributes ?? '')
    .split(/\r?\n/)
    .filter((line) =>
      /^scripts\/[^/]+\.mjs linguist-generated=true$/.test(line),
    );
  const listed = generatedLines.map((line) =>
    line.slice('scripts/'.length, -' linguist-generated=true'.length),
  );
  if (generatedLines.length === 0)
    add(
      out,
      'generated-script-ledger',
      '.gitattributes',
      'expected generated scripts entries',
    );
  if (!sorted(generatedLines))
    add(
      out,
      'generated-script-order',
      '.gitattributes',
      'generated script lines must be in ascending order',
    );
  if (!same(listed, generated.sort()))
    add(
      out,
      'generated-script-ledger',
      '.gitattributes',
      'entries must equal the generated scripts on disk',
    );
  const bins = directChildren(walk(root, 'bin', out), 'bin').filter((path) =>
    path.endsWith('.mjs'),
  );
  const binSources = new Set(
    directChildren(walk(root, 'src/bin', out), 'src/bin')
      .filter((path) => path.endsWith('.mts'))
      .map((path) => path.slice('src/bin/'.length, -4)),
  );
  for (const name of findOrphanGeneratedNames(
    bins.map((path) => path.slice('bin/'.length)),
    [...binSources].map((basename) => `${basename}.mts`),
  )) {
    add(
      out,
      'helper-source-pair',
      `bin/${name}`,
      'generated bin helper has no matching src/bin .mts source',
    );
  }
  const helperSource = readText(
    root,
    'src/scripts/helper-runtime-manifest.mts',
    out,
  );
  const marker = 'const HELPER_COMMANDS: HelperCommand[] = [';
  const start = helperSource?.indexOf(marker) ?? -1;
  const afterMarker =
    helperSource !== null && start >= 0
      ? helperSource.slice(start + marker.length)
      : '';
  const terminator = afterMarker.search(/^\];/m);
  const body = terminator >= 0 ? afterMarker.slice(0, terminator) : '';
  const ids = [...body.matchAll(/^ {4}id: '([^']+)'/gm)].map(
    (match) => match[1],
  );
  if (start < 0 || terminator < 0) {
    add(
      out,
      'helper-command-order',
      'src/scripts/helper-runtime-manifest.mts',
      'could not inspect HELPER_COMMANDS array',
    );
  }
  if (ids.length === 0)
    add(
      out,
      'helper-command-order',
      'src/scripts/helper-runtime-manifest.mts',
      'expected HELPER_COMMANDS entries',
    );
  else if (!sorted(ids))
    add(
      out,
      'helper-command-order',
      'src/scripts/helper-runtime-manifest.mts',
      'HELPER_COMMANDS ids must be in ascending order',
    );
  if (manifest !== null && !Array.isArray(manifest.syncPairs)) {
    add(
      out,
      'sync-pair-order',
      'audit/sync-manifest.json',
      'syncPairs must be an array',
    );
  }
  if (Array.isArray(manifest?.syncPairs)) {
    const validPairs = manifest.syncPairs.filter(isRecord);
    if (validPairs.length !== manifest.syncPairs.length) {
      add(
        out,
        'sync-pair-order',
        'audit/sync-manifest.json',
        'each syncPairs entry must be an object',
      );
    }
    const pairIds = validPairs.map((pair) => pair.id);
    if (pairIds.some((id) => typeof id !== 'string' || !id.trim())) {
      add(
        out,
        'sync-pair-order',
        'audit/sync-manifest.json',
        'each syncPairs entry requires a non-empty id',
      );
    }
    const validIds = pairIds.filter((id) => typeof id === 'string');
    if (!sorted(validIds))
      add(
        out,
        'sync-pair-order',
        'audit/sync-manifest.json',
        'syncPairs ids must be in ascending order',
      );
  }
  if (manifest !== null && !Array.isArray(manifest.bundleBudgets)) {
    add(
      out,
      'bundle-budget-file-order',
      'audit/sync-manifest.json',
      'bundleBudgets must be an array',
    );
  }
  for (const budget of Array.isArray(manifest?.bundleBudgets)
    ? manifest.bundleBudgets
    : []) {
    if (!isRecord(budget)) {
      add(
        out,
        'bundle-budget-file-order',
        'audit/sync-manifest.json',
        'each bundle budget entry must be an object',
      );
      continue;
    }
    if (
      !Array.isArray(budget.files) ||
      budget.files.some((path) => typeof path !== 'string')
    ) {
      add(
        out,
        'bundle-budget-file-order',
        'audit/sync-manifest.json',
        'each bundle budget requires a string file list',
      );
      continue;
    }
    if (!sorted(budget.files)) {
      add(
        out,
        'bundle-budget-file-order',
        'audit/sync-manifest.json',
        'bundle file paths are not sorted (' +
          (typeof budget.id === 'string' ? budget.id : 'unnamed') +
          ')',
      );
    }
  }
}
function readStaticObjectBlocks(source, marker, terminator) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const afterMarker = source.slice(markerIndex + marker.length);
  const endMatch = terminator.exec(afterMarker);
  if (!endMatch || endMatch.index === undefined) return null;
  const body = afterMarker.slice(0, endMatch.index);
  const entryStarts = [...body.matchAll(/^ {2}\{$/gm)].length;
  const blocks = [...body.matchAll(/^ {2}\{\n([\s\S]*?)^ {2}\},?$/gm)].map(
    (match) => match[1],
  );
  return entryStarts === blocks.length ? blocks : null;
}
function readStaticStringField(block, field) {
  const match = block.match(new RegExp(`^    ${field}:\\s*'([^']*)',?$`, 'm'));
  return match?.[1] ?? null;
}
function loadRuntimeCatalog(root, out) {
  const path = 'src/scripts/helper-runtime-manifest.mts';
  const source = readText(root, path, out, 'runtime-catalog');
  if (source === null)
    return { commandCatalog: [], packageManagerOnlyEntryPaths: [] };
  const commandBlocks = readStaticObjectBlocks(
    source,
    'const HELPER_COMMANDS: HelperCommand[] = [',
    /^\];/m,
  );
  if (commandBlocks === null || commandBlocks.length === 0) {
    add(
      out,
      'runtime-catalog',
      path,
      'could not inspect non-empty HELPER_COMMANDS array',
    );
    return { commandCatalog: [], packageManagerOnlyEntryPaths: [] };
  }
  const commandCatalog = [];
  for (const [index, block] of commandBlocks.entries()) {
    const entryPath = readStaticStringField(block, 'entryPath');
    const binName = readStaticStringField(block, 'binName');
    const scriptName = readStaticStringField(block, 'scriptName');
    if (!entryPath || !binName || !scriptName) {
      add(
        out,
        'runtime-catalog',
        path,
        `HELPER_COMMANDS entry ${index + 1} is missing string entryPath, binName, or scriptName`,
      );
      continue;
    }
    commandCatalog.push({ entryPath, binName, scriptName });
  }
  const packageManagerBlocks = readStaticObjectBlocks(
    source,
    'export const PACKAGE_MANAGER_ONLY_HELPERS = [',
    /^\] as const;/m,
  );
  if (packageManagerBlocks === null) {
    add(
      out,
      'runtime-catalog',
      path,
      'could not inspect PACKAGE_MANAGER_ONLY_HELPERS array',
    );
    return { commandCatalog, packageManagerOnlyEntryPaths: [] };
  }
  const packageManagerOnlyEntryPaths = [];
  for (const [index, block] of packageManagerBlocks.entries()) {
    const entryPath = readStaticStringField(block, 'installedEntryPath');
    if (!entryPath) {
      add(
        out,
        'runtime-catalog',
        path,
        `PACKAGE_MANAGER_ONLY_HELPERS entry ${index + 1} is missing string installedEntryPath`,
      );
      continue;
    }
    packageManagerOnlyEntryPaths.push(entryPath);
  }
  return { commandCatalog, packageManagerOnlyEntryPaths };
}
function checkRuntimeRegistration(root, catalog, out) {
  const text = readText(root, 'package.json', out);
  let bin = {};
  try {
    const value = text === null ? {} : JSON.parse(text);
    if (isRecord(value) && isRecord(value.bin)) bin = value.bin;
    else if (!isRecord(value))
      add(out, 'runtime-bin-map', 'package.json', 'expected a JSON object');
  } catch {
    add(out, 'runtime-bin-map', 'package.json', 'invalid JSON');
  }
  for (const command of catalog) {
    if (bin[command.binName] !== `./bin/${command.binName}.mjs`) {
      add(
        out,
        'runtime-bin-forward',
        'package.json',
        `cataloged helper has no matching bin entry: ${command.binName}`,
      );
    }
  }
  const registered = new Set(catalog.map((entry) => entry.binName));
  for (const name of Object.keys(bin)) {
    if (!registered.has(name) && !Object.hasOwn(BIN_ALLOWLIST, name)) {
      add(
        out,
        'runtime-bin-reverse',
        'package.json',
        `bin key has no catalog entry or justified exception: ${name}`,
      );
    }
  }
  for (const name of Object.keys(BIN_ALLOWLIST)) {
    if (!Object.hasOwn(bin, name))
      add(
        out,
        'runtime-bin-allowlist',
        'src/scripts/repository-inventory-audit.mts',
        `allowlisted bin is no longer present: ${name}`,
      );
  }
}
function checkInstructionInvocations(
  root,
  catalog,
  packageManagerOnlyEntryPaths,
  out,
) {
  const directories = [
    '.github/instructions',
    'docs',
    'idd-template/.github/instructions',
    'idd-template/docs',
  ];
  const paths = directories.flatMap((directory) =>
    walk(root, directory, out).filter((path) => path.endsWith('.md')),
  );
  const files = paths.map((path) => ({
    path,
    content: readText(root, path, out) ?? '',
  }));
  if (files.length <= 50) {
    add(
      out,
      'instruction-invocation-scope',
      'docs',
      'scan found too few Markdown files to represent the distributed corpus',
    );
  }
  const allFiles = directories.flatMap((directory) =>
    walk(root, directory, out),
  );
  const manifestText = readText(root, 'audit/sync-manifest.json', out);
  let manifest = {};
  try {
    if (manifestText !== null) {
      const value = JSON.parse(manifestText);
      if (isRecord(value)) {
        manifest = value;
        if (!Array.isArray(value.fileSets)) {
          add(
            out,
            'instruction-invocation-scope',
            'audit/sync-manifest.json',
            'fileSets must be an array',
          );
        } else if (
          value.fileSets.some(
            (entry) =>
              !isRecord(entry) ||
              typeof entry.sourceGlob !== 'string' ||
              typeof entry.targetGlob !== 'string',
          )
        ) {
          add(
            out,
            'instruction-invocation-scope',
            'audit/sync-manifest.json',
            'each fileSets entry requires sourceGlob and targetGlob strings',
          );
        }
        if (!Array.isArray(value.syncPairs)) {
          add(
            out,
            'instruction-invocation-scope',
            'audit/sync-manifest.json',
            'syncPairs must be an array',
          );
        } else if (
          value.syncPairs.some(
            (entry) =>
              !isRecord(entry) ||
              typeof entry.target !== 'string' ||
              (entry.source !== undefined && typeof entry.source !== 'string'),
          )
        ) {
          add(
            out,
            'instruction-invocation-scope',
            'audit/sync-manifest.json',
            'each syncPairs entry requires a target string and optional source string',
          );
        }
      } else
        add(
          out,
          'instruction-invocation-scope',
          'audit/sync-manifest.json',
          'expected a JSON object',
        );
    }
  } catch {
    add(
      out,
      'instruction-invocation-scope',
      'audit/sync-manifest.json',
      'invalid JSON',
    );
  }
  const distributed = resolveDistributedFiles(allFiles, manifest);
  for (const violation of collectHelperInvocationViolations(files, {
    commandCatalog: catalog,
    distributedFiles: distributed,
    packageManagerOnlyEntryPaths,
  })) {
    add(
      out,
      violation.ruleId,
      violation.path,
      `[${violation.form}] ${violation.name}: ${violation.message}`,
    );
  }
  const instructionFiles = files.filter(
    (file) =>
      file.path.startsWith('.github/instructions/') &&
      file.path.endsWith('.instructions.md'),
  );
  const documented = new Set();
  for (const file of instructionFiles) {
    for (const match of file.content.matchAll(
      /\bnode\s+(scripts\/[a-z0-9-]+\.mjs)\b/g,
    )) {
      if (!Object.hasOwn(DOGFOOD_ONLY_TOOLS, match[1]))
        documented.add(match[1]);
    }
  }
  if (
    documented.size === 0 ||
    !documented.has('scripts/minimize-superseded-markers.mjs')
  ) {
    add(
      out,
      'instruction-helper-scope',
      '.github/instructions',
      'documented helper scan is empty or lost its known invocation anchor',
    );
  }
  const catalogPaths = new Set(catalog.map((entry) => entry.entryPath));
  for (const entryPath of documented) {
    if (!catalogPaths.has(entryPath)) {
      add(
        out,
        'instruction-helper-registration',
        '.github/instructions',
        `documented CLI helper is not registered: ${entryPath}`,
      );
    }
  }
  const combinedInstructions = instructionFiles
    .map((file) => file.content)
    .join('\n');
  for (const library of [
    'scripts/protocol-helpers.mjs',
    'scripts/policy-helpers.mjs',
  ]) {
    const invoked = instructionFiles.some((file) =>
      scanHelperInvocationFile(file.content).nodeScripts.includes(library),
    );
    if (
      !combinedInstructions.includes(library) ||
      invoked ||
      catalogPaths.has(library)
    ) {
      add(
        out,
        'instruction-helper-scope',
        '.github/instructions',
        `shared library scope changed unexpectedly: ${library}`,
      );
    }
  }
  for (const tool of [
    'scripts/build-ts.mjs',
    'scripts/sync-docs.mjs',
    'scripts/verify-workshop-integrity.mjs',
    'scripts/verify-install-deps.mjs',
    'scripts/merged-pr-feedback-sweep.mjs',
    'scripts/audit-docs.mjs',
    'scripts/audit-code-span-wrap.mjs',
  ]) {
    if (documented.has(tool) || catalogPaths.has(tool)) {
      add(
        out,
        'instruction-helper-scope',
        '.github/instructions',
        `source-only tool entered the adopter helper catalog: ${tool}`,
      );
    }
  }
}
function checkTemplateWorkflows(root, catalog, out) {
  const files = directChildren(
    walk(root, 'idd-template/.github/workflows', out),
    'idd-template/.github/workflows',
  )
    .filter((path) => path.endsWith('.yml'))
    .map((path) => ({ path, content: readText(root, path, out) ?? '' }));
  if (files.length < 3) {
    add(
      out,
      'template-workflow-scope',
      'idd-template/.github/workflows',
      'expected at least three YAML workflows',
    );
  }
  const scan = scanTemplateWorkflowRegistrations(files, catalog);
  out.push(...scan.violations);
  for (const path of [
    'scripts/rerun-advisory-convergence.mjs',
    'scripts/audit-pr-cleanup.mjs',
  ]) {
    if (!scan.nodeEntryPaths.includes(path)) {
      add(
        out,
        'template-workflow-scope',
        'idd-template/.github/workflows',
        `missing node invocation anchor: ${path}`,
      );
    }
  }
  for (const name of [
    'idd-rerun-advisory-convergence',
    'idd-audit-pr-cleanup',
  ]) {
    if (!scan.packageRunnerBinNames.includes(name)) {
      add(
        out,
        'template-workflow-scope',
        'idd-template/.github/workflows',
        `missing package-runner invocation anchor: ${name}`,
      );
    }
  }
}
function checkHelperCliMigration(root, out) {
  const bins = directChildren(walk(root, 'bin', out), 'bin').filter((path) =>
    /^bin\/idd-.*\.mjs$/.test(path),
  );
  const sources = new Set(
    directChildren(walk(root, 'src/bin', out), 'src/bin').filter((path) =>
      /^src\/bin\/idd-.*\.mts$/.test(path),
    ),
  );
  if (bins.length === 0)
    add(
      out,
      'helper-cli-inventory',
      'bin',
      'expected packaged idd helper wrappers',
    );
  for (const bin of bins) {
    const sourcePath = bin
      .replace(/^bin\//, 'src/bin/')
      .replace(/\.mjs$/, '.mts');
    if (!sources.has(sourcePath)) {
      add(
        out,
        'helper-cli-source-pair',
        sourcePath,
        'packaged helper wrapper has no TypeScript source',
      );
      continue;
    }
    const wrapper = readText(root, sourcePath, out);
    const match = wrapper?.match(/scripts\/([a-z0-9-]+)\.mjs/);
    if (!match) {
      add(
        out,
        'helper-cli-wrapper',
        sourcePath,
        'wrapper does not identify a scripts helper target',
      );
      continue;
    }
    const target = `src/scripts/${match[1]}.mts`;
    const targetText = readText(root, target, out);
    if (
      targetText !== null &&
      !/(?:runHelperCli\s*\(|applyHelperCliOutcomeWhenDisabled\s*\()/.test(
        targetText,
      )
    ) {
      add(
        out,
        'helper-cli-migration',
        target,
        'helper does not use the shared CLI outcome runner',
      );
    }
  }
}
function checkHelpFlagCoverage(root, out) {
  const paths = directChildren(
    walk(root, 'src/scripts', out),
    'src/scripts',
  ).filter((path) => path.endsWith('.mts'));
  const sources = new Map();
  for (const path of paths) {
    const text = readText(root, path, out);
    if (text !== null) sources.set(path.slice('src/scripts/'.length, -4), text);
  }
  const covered = new Set(COVERED_HELPERS);
  const excluded = new Set(EXCLUDED_HELPERS.map((entry) => entry.helper));
  if (covered.size !== COVERED_HELPERS.length)
    add(
      out,
      'help-flag-coverage',
      'src/scripts',
      'covered helper ledger contains duplicates',
    );
  if (excluded.size !== EXCLUDED_HELPERS.length)
    add(
      out,
      'help-flag-coverage',
      'src/scripts',
      'excluded helper ledger contains duplicates',
    );
  for (const helper of covered) {
    if (excluded.has(helper))
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'helper appears in both coverage ledgers',
      );
    if (!isFlagSpec(sources.get(helper) ?? ''))
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'covered helper no longer declares FLAG_SPEC',
      );
  }
  for (const { helper, reason } of EXCLUDED_HELPERS) {
    if (!sources.has(helper)) {
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'excluded helper source is missing',
      );
      continue;
    }
    if (!reason.trim())
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'excluded helper requires a reason',
      );
    if (isFlagSpec(sources.get(helper) ?? ''))
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'excluded helper now declares FLAG_SPEC',
      );
  }
  for (const [helper, source] of sources) {
    if (isFlagSpec(source) && !covered.has(helper)) {
      add(
        out,
        'help-flag-coverage',
        `src/scripts/${helper}.mts`,
        'FLAG_SPEC helper is missing from COVERED_HELPERS',
      );
    }
  }
}
function checkManifestLedgers(root, out) {
  const text = readText(root, 'audit/sync-manifest.json', out);
  let manifest = {};
  try {
    if (text !== null) {
      const value = JSON.parse(text);
      if (isRecord(value)) {
        manifest = value;
      } else {
        add(
          out,
          'manifest-ledger',
          'audit/sync-manifest.json',
          'expected a JSON object',
        );
        return;
      }
    }
  } catch {
    add(out, 'manifest-ledger', 'audit/sync-manifest.json', 'invalid JSON');
    return;
  }
  const allowed = manifest.rootMarkdownAllowlist?.allowed;
  if (
    !Array.isArray(allowed) ||
    !same([...allowed].sort(), EXPECTED_ROOT_MARKDOWN)
  ) {
    add(
      out,
      'root-markdown-ledger',
      'audit/sync-manifest.json',
      'allowed root documents differ from the intentional document inventory',
    );
  }
  const budgets = manifest.instructionSizeBudgets;
  if (!Array.isArray(budgets)) {
    add(
      out,
      'instruction-size-budget-ledger',
      'audit/sync-manifest.json',
      'instructionSizeBudgets must be an array',
    );
    return;
  }
  const validBudgets = budgets.filter(isRecord);
  if (validBudgets.length !== budgets.length) {
    add(
      out,
      'instruction-size-budget-ledger',
      'audit/sync-manifest.json',
      'each budget entry must be an object',
    );
  }
  const globs = validBudgets.map((entry) => entry.glob);
  for (const required of REQUIRED_INSTRUCTION_BUDGET_GLOBS) {
    if (!globs.includes(required))
      add(
        out,
        'instruction-size-budget-ledger',
        'audit/sync-manifest.json',
        `missing required glob: ${required}`,
      );
  }
  const ids = validBudgets.map((entry) => entry.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    add(
      out,
      'instruction-size-budget-ledger',
      'audit/sync-manifest.json',
      'every budget entry requires a non-empty id',
    );
  }
  const stringIds = ids.filter((id) => typeof id === 'string');
  if (new Set(stringIds).size !== stringIds.length) {
    add(
      out,
      'instruction-size-budget-ledger',
      'audit/sync-manifest.json',
      'budget ids must be unique',
    );
  }
}
// Regex that finds `node (./|<idd-skill>/)?scripts/<h>.mjs` allowing a line-wrap inside the
// node invocation (the wrap occurs between `node` and `scripts/` or its prefix).
const UNPOINTED_INVOCATION_RE =
  /\bnode[ \t\r\n]+((?:\.\/|<idd-skill>\/)?scripts\/([a-z0-9-]+\.mjs))\b/g;
/**
 * Mask HTML comments outside of code blocks and inline code spans.
 * Replaces comment characters with spaces, preserving newlines so that
 * line numbers remain identical. Handles multiline inline code spans
 * across lines so that `<!--` inside backticks never enters comment mode.
 */
function maskHtmlComments(content) {
  const result = [];
  const len = content.length;
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  function isLineStart(idx) {
    return idx === 0 || content[idx - 1] === '\n';
  }
  while (i < len) {
    if (isLineStart(i)) {
      let lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = len;
      const line = content.slice(i, lineEnd);
      if (inFence) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
        const closeMarker = close?.[1];
        if (
          closeMarker !== undefined &&
          (closeMarker[0] ?? '') === fenceChar &&
          closeMarker.length >= fenceLen
        ) {
          for (let k = i; k < lineEnd; k += 1) {
            result.push(content[k] ?? '');
          }
          if (lineEnd < len) {
            result.push(content[lineEnd] ?? '');
            i = lineEnd + 1;
          } else {
            i = lineEnd;
          }
          inFence = false;
          fenceChar = '';
          fenceLen = 0;
          continue;
        }
        for (let k = i; k < lineEnd; k += 1) {
          result.push(content[k] ?? '');
        }
        if (lineEnd < len) {
          result.push(content[lineEnd] ?? '');
          i = lineEnd + 1;
        } else {
          i = lineEnd;
        }
        continue;
      }
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const openMarker = open?.[1];
      const openInfo = open?.[2] ?? '';
      if (
        openMarker !== undefined &&
        (!openMarker.startsWith('`') || !openInfo.includes('`'))
      ) {
        inFence = true;
        fenceChar = openMarker[0] ?? '';
        fenceLen = openMarker.length;
        for (let k = i; k < lineEnd; k += 1) {
          result.push(content[k] ?? '');
        }
        if (lineEnd < len) {
          result.push(content[lineEnd] ?? '');
          i = lineEnd + 1;
        } else {
          i = lineEnd;
        }
        continue;
      }
    }
    if (content.startsWith('<!--', i)) {
      const endIdx = content.indexOf('-->', i + 4);
      const closeEnd = endIdx === -1 ? len : endIdx + 3;
      for (let k = i; k < closeEnd; k += 1) {
        const ch = content[k] ?? '';
        result.push(ch === '\n' || ch === '\r' ? ch : ' ');
      }
      i = closeEnd;
    } else if (content[i] === '`') {
      let tickCount = 1;
      while (i + tickCount < len && content[i + tickCount] === '`') {
        tickCount += 1;
      }
      const opener = '`'.repeat(tickCount);
      for (let k = 0; k < tickCount; k += 1) {
        result.push('`');
      }
      i += tickCount;
      const closeIdx = content.indexOf(opener, i);
      if (closeIdx !== -1) {
        for (let k = i; k < closeIdx + tickCount; k += 1) {
          result.push(content[k] ?? '');
        }
        i = closeIdx + tickCount;
      }
    } else {
      result.push(content[i] ?? '');
      i += 1;
    }
  }
  return result.join('');
}
/**
 * Split a Markdown file into blocks. Fenced code blocks (CommonMark-compliant)
 * are kept intact. Everything else is split on one-or-more blank lines.
 */
function splitIntoBlocks(content) {
  const blocks = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let currentLines = [];
  let blockStartLine = 1;
  function flushProse() {
    const text = currentLines.join('\n').trim();
    if (text) {
      const leadingEmpty = currentLines.findIndex((l) => !/^\s*$/.test(l));
      blocks.push({
        isFence: false,
        text,
        startLine: blockStartLine + (leadingEmpty >= 0 ? leadingEmpty : 0),
      });
    }
    currentLines = [];
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNumber = i + 1;
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const openMarker = open?.[1];
    const openInfo = open?.[2] ?? '';
    if (
      !inFence &&
      openMarker !== undefined &&
      (!openMarker.startsWith('`') || !openInfo.includes('`'))
    ) {
      flushProse();
      inFence = true;
      fenceChar = openMarker[0] ?? '';
      fenceLen = openMarker.length;
      blockStartLine = lineNumber;
      currentLines.push(line);
    } else if (inFence) {
      currentLines.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      const closeMarker = close?.[1];
      if (
        closeMarker !== undefined &&
        (closeMarker[0] ?? '') === fenceChar &&
        closeMarker.length >= fenceLen
      ) {
        // closing fence
        blocks.push({
          isFence: true,
          text: currentLines.join('\n'),
          startLine: blockStartLine,
        });
        currentLines = [];
        inFence = false;
      }
    } else {
      // prose
      if (/^\s*$/.test(line)) {
        flushProse();
        blockStartLine = lineNumber + 1;
      } else {
        if (currentLines.length === 0) {
          blockStartLine = lineNumber;
        }
        currentLines.push(line);
      }
    }
  }
  flushProse();
  return blocks;
}
/**
 * Return true if the text contains the word `profile-selected` (case-insensitively).
 */
function hasPointer(block) {
  return /profile-selected/i.test(block.text);
}
/**
 * For a single instruction file, emit `unpointed-source-form` violations:
 * any non-exempt bare `node scripts/<h>.mjs` invocation that lacks a
 * `profile-selected` pointer before it in the file OR in the same
 * paragraph/fenced block.
 */
export function checkUnpointedSourceFormFile(filePath, content, out) {
  const masked = maskHtmlComments(content);
  const blocks = splitIntoBlocks(masked);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block === undefined) continue;
    // Collect all non-exempt invocations in this block.
    for (const match of block.text.matchAll(UNPOINTED_INVOCATION_RE)) {
      const scriptName = match[2];
      const script = `scripts/${scriptName}`;
      // Skip exempt scripts.
      if (
        Object.hasOwn(DOGFOOD_ONLY_TOOLS, script) ||
        Object.hasOwn(INTERNAL_ENTRY_REASONS, script)
      )
        continue;
      // Check whether there is a pointer:
      // 1. In any earlier block in the file.
      const pointerBefore = blocks
        .slice(0, blockIndex)
        .some((b) => hasPointer(b));
      if (pointerBefore) continue;
      // 2. In the same block (later text counts when in same paragraph/fence).
      if (hasPointer(block)) continue;
      // Calculate 1-indexed source line of the invocation.
      const matchIndex = match.index ?? 0;
      const lineOffset = block.text.slice(0, matchIndex).split('\n').length - 1;
      const line = block.startLine + lineOffset;
      // No pointer found — violation.
      add(
        out,
        'unpointed-source-form',
        filePath,
        `bare node invocation of ${script} at line ${line} has no preceding profile-selected pointer`,
      );
      // Report at most one violation per file to avoid duplicate noise.
      return;
    }
  }
}
/**
 * Check all instruction files (both source-repo and idd-template) for
 * bare `node scripts/<h>.mjs` invocations that lack a `profile-selected`
 * pointer.  Files under `docs/` are explicitly excluded.
 */
function checkUnpointedSourceForm(root, out) {
  const directories = [
    '.github/instructions',
    'idd-template/.github/instructions',
  ];
  const paths = directories.flatMap((directory) =>
    walk(root, directory, out).filter((path) => path.endsWith('.md')),
  );
  for (const path of paths) {
    const content = readText(root, path, out);
    if (content === null) continue;
    checkUnpointedSourceFormFile(path, content, out);
  }
}
export function collectRepositoryInventoryViolations(
  repositoryRoot,
  selectedChecks = CHECK_FAMILIES,
) {
  const root = resolve(repositoryRoot);
  const out = [];
  checkExemptionMetadata(out);
  const selected = new Set(selectedChecks);
  const needsCatalog =
    selected.has('runtime-registration') ||
    selected.has('instruction-invocations') ||
    selected.has('template-workflows');
  const runtimeCatalog = needsCatalog
    ? loadRuntimeCatalog(root, out)
    : { commandCatalog: [], packageManagerOnlyEntryPaths: [] };
  const catalog = runtimeCatalog.commandCatalog;
  if (selected.has('runtime-registration'))
    checkRuntimeRegistration(root, catalog, out);
  if (selected.has('repository-inventory')) checkRepositoryInventory(root, out);
  if (selected.has('instruction-invocations'))
    checkInstructionInvocations(
      root,
      catalog,
      runtimeCatalog.packageManagerOnlyEntryPaths,
      out,
    );
  if (selected.has('template-workflows'))
    checkTemplateWorkflows(root, catalog, out);
  if (selected.has('helper-cli-migration')) checkHelperCliMigration(root, out);
  if (selected.has('help-flag-coverage')) checkHelpFlagCoverage(root, out);
  if (selected.has('manifest-ledgers')) checkManifestLedgers(root, out);
  if (selected.has('unpointed-source-form'))
    checkUnpointedSourceForm(root, out);
  return sortViolations(out);
}
function parseArgs(args) {
  let root = process.cwd();
  const checks = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return null;
      root = value;
      index += 1;
    } else if (arg === '--check') {
      const value = args[index + 1];
      if (!value || !CHECK_FAMILIES.includes(value)) return null;
      checks.push(value);
      index += 1;
    } else if (arg === '--help') {
      return { root: '', checks: [] };
    } else {
      return null;
    }
  }
  return { root, checks: checks.length > 0 ? checks : [...CHECK_FAMILIES] };
}
if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error(
      'usage: node scripts/repository-inventory-audit.mjs [--root <repository>] [--check <family> ...]',
    );
    console.error(`check families: ${CHECK_FAMILIES.join(', ')}`);
    process.exit(2);
  }
  if (parsed.root === '') {
    console.log(`check families: ${CHECK_FAMILIES.join(', ')}`);
  } else {
    const violations = collectRepositoryInventoryViolations(
      parsed.root,
      parsed.checks,
    );
    if (violations.length > 0) {
      console.error('repository inventory audit failed:');
      for (const violation of violations) {
        console.error(
          '- repository-inventory-audit/' +
            violation.ruleId +
            ': ' +
            violation.path +
            ': ' +
            violation.message,
        );
      }
      process.exit(1);
    }
    console.log('repository inventory audit passed');
  }
}
