// Guards issue #1674: instruction/docs files repeatedly prescribed a
// helper invocation that is not runnable under the reader's actual
// helper-runtime profile (see docs/idd-helper-scripts.md's "Profile
// Wiring Surface" section and the audit of accepted review findings
// cited in the issue). This file scans the distributed Markdown surface
// for four invocation forms and checks each against the
// `helper-runtime-manifest` command table, plus bans the source
// repository's own `bin/<name>.mjs` build-artifact path from ever
// appearing in a distributed file.
//
// Scope note: `tests/helper-runtime-manifest.test.mts` already guards a
// subset of this problem -- `node scripts/<name>.mjs` invocations inside
// `.github/instructions/**` only (closes #1084), via its own
// `DOGFOOD_ONLY_CONCRETE_TOOLS` allowlist. This file is intentionally a
// separate, broader guard (docs/** and idd-template/ mirrors too, plus
// three more invocation forms, plus the bin/idd-* distributed-file ban)
// rather than an extension of that narrower, already-reviewed guard --
// the two allowlists overlap on five names (kept in sync manually; a
// name added to one is exceedingly unlikely to need the other without a
// human noticing, since both represent the same "maintainer/CI-only,
// never adopter-run" fact).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { globFiles } from '../src/scripts/consistency-helpers.mts';
import { buildHelperRuntimeManifest } from '../src/scripts/helper-runtime-manifest.mts';
import { readJson } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface FileInput {
  path: string;
  content: string;
}

interface Violation {
  file: string;
  rule: 'unbacked-helper' | 'distributed-bin-path';
  form: 'node-scripts' | 'bin-mjs' | 'package-script' | 'bare-bin-command';
  name: string;
  message: string;
}

interface ManifestCommand {
  entryPath: string;
  binName: string;
  scriptName: string;
}

// Real, existing scripts that are genuinely `node`-invoked somewhere in
// this repository's own dogfood instructions/docs but are deliberately
// excluded from HELPER_COMMANDS because they are maintainer/CI-only and
// never meant for an adopter repository to run via a vendored or
// package-manager profile. Each entry is justified individually --
// adding one on a hunch defeats the guard.
const SOURCE_REPO_INTERNAL_ENTRY_PATHS = new Set([
  // Pre-existing precedent (also excluded in
  // tests/helper-runtime-manifest.test.mts's DOGFOOD_ONLY_CONCRETE_TOOLS,
  // for the identical reason -- see that file's comment for the #1726 /
  // #1677 citations):
  'scripts/sync-docs.mjs',
  'scripts/verify-install-deps.mjs',
  'scripts/audit-docs.mjs',
  'scripts/audit-code-span-wrap.mjs',
  // check-pnpm-boundary.mjs: a `docs/customization.md` example row only
  // (no profile-selected claim anywhere) -- a CI/lint-authoring tool for
  // this repo's own Project commands table, not an adopter helper.
  'scripts/check-pnpm-boundary.mjs',
  // idd-onboard.mjs: explicitly documented in
  // idd-template/docs/onboarding/template-distribution.md as "primarily
  // a maintainer reference"; its one real invocation reads from a full
  // clone of this source repository, never from inside an adopter repo.
  'scripts/idd-onboard.mjs',
  // validate-schemas.mjs: a CI-only JSON-schema self-check, referenced
  // once in idd-template/docs/onboarding/policy-decisions.md with no
  // profile-selected claim.
  'scripts/validate-schemas.mjs',
  // merged-pr-feedback-sweep.mjs: tests/helper-runtime-manifest.test.mts
  // already classifies this as "the maintainer-only post-merge sweep"
  // that must stay unregistered; docs/idd-helper-scripts.md's own
  // "package-manager / ephemeral-npx: use the profile-selected
  // idd-merged-pr-feedback-sweep command" line was the actual bug this
  // issue corrects (see the same commit that adds this entry).
  'scripts/merged-pr-feedback-sweep.mjs',
  // check-untracked-artifacts.mjs: `build:check`-internal verification
  // tooling (see docs/typescript-sources.md), never adopter-facing.
  'scripts/check-untracked-artifacts.mjs',
  // token-cost-report.mjs (#2294): this repository's own dogfood
  // measurement reporter, named in docs/token-cost.md's own usage
  // examples. It reads only local JSONL under `~/.grok`/`~/.claude`/
  // `~/.codex` -- never committed to git -- and is never distributed to
  // idd-template/; an adopter repository has no token-cost data to
  // report.
  'scripts/token-cost-report.mjs',
  // actions-usage-report.mjs (#2322): this repository's own dogfood Actions
  // API measurement reporter, named in docs/customization.md's adopter
  // billing-exposure section as an example of the kind of evidence-gathering
  // this repository itself uses. It reports on THIS repository's own
  // `.github/workflows/*.yml` names -- never distributed to idd-template/;
  // an adopter repository has an entirely different set of workflows to
  // measure.
  'scripts/actions-usage-report.mjs',
  // token-cost-event.mjs (#2293): this repository's own dogfood
  // phase-event helper, named only in the four root guideline files'
  // (CLAUDE.md / AGENTS.md / GEMINI.md / .github/copilot-instructions.md)
  // "Dogfood: token-cost events" note -- none of which
  // `readRealScanFiles()` below scans (docs/**, idd-template/docs/**,
  // .github/instructions/**, idd-template/.github/instructions/** only),
  // so this entry is currently inert against that scan. Registered anyway
  // per #2293's own design (kept in sync with
  // DOGFOOD_ONLY_CONCRETE_TOOLS in tests/helper-runtime-manifest.test.mts,
  // same rationale) so a future guideline-file edit that duplicates this
  // invocation into a scanned path does not silently need this same
  // exemption re-derived from scratch. It writes only to
  // `${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/token-cost/` --
  // never committed to git -- and is never distributed to idd-template/;
  // an adopter repository has no token-cost data to record.
  'scripts/token-cost-event.mjs',
  // token-cost-harvest.mjs (#2292): this repository's own dogfood
  // harvest CLI, named in docs/token-cost.md's own usage examples. It
  // scans local vendor session logs (`~/.grok`/`~/.claude`/`~/.codex`)
  // and this repository's own GitHub IDD markers, writing local JSONL
  // under `${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/token-cost/`
  // -- never committed to git -- and is never distributed to
  // idd-template/; an adopter repository has no token-cost data to
  // harvest.
  'scripts/token-cost-harvest.mjs',
]);

// A helper name that appears only as a *proposed*, not-yet-built script
// in a design-rationale doc (docs/weak-model-authoring-lite-profile-design.md:
// "`bin/idd-emit-authoring-marker.mjs` (or an extension of the
// existing ...)"). It has no backing file at all, unlike the entries
// above -- this is a hypothetical name, not a real unregistered helper.
const NON_ADOPTER_BIN_NAMES = new Set(['idd-emit-authoring-marker']);

// Same shape as NON_ADOPTER_BIN_NAMES, for the `idd:<name>` package-script
// form. Empty today (no `npm run|pnpm|yarn idd:<name>` invocation on the
// current corpus names an unregistered scriptName), kept as a real,
// consulted Set rather than omitted so a future non-adopter scriptName
// has a home and the violation message below stays accurate.
const NON_ADOPTER_SCRIPT_NAMES = new Set<string>();

// Both copies discuss `bin/idd-merge-execute.mjs` as a Bash-permission
// deny-pattern string (see docs/permissions.md around line 447), not as
// a prescribed invocation for a reader to run -- the opposite of what
// the distributed-bin-path rule targets. Exempting the file edits
// nothing in the security doc itself and keeps the exemption to one
// auditable line per copy, instead of inventing a content-based
// heuristic to tell "denylist pattern" and "prescribed command" apart.
const DISTRIBUTED_BIN_BAN_EXEMPT_FILES = new Set([
  'docs/permissions.md',
  'idd-template/docs/permissions.md',
]);

const NODE_SCRIPTS_RE = /\bnode\s+(scripts\/[a-z0-9-]+\.mjs)\b/g;
const BIN_MJS_RE = /(?:\.\/)?\bbin\/(idd-[a-zA-Z0-9-]+)\.mjs\b/g;
const PACKAGE_SCRIPT_RE =
  /(?:npm run|pnpm(?: run)?|yarn(?: run)?)\s+(idd:[a-zA-Z0-9-]+)/g;
// Leading whitespace before the fence marker is allowed (`^\s*`), not
// anchored to column 0: a fenced block nested inside a list item (a
// common pattern in these docs) is itself indented, so a column-0
// anchor missed it entirely (idd-skill#1674 review).
const FENCE_RE = /^\s*```(\S*)/;
// First token on a line inside a fenced sh/bash/shell/console block,
// optionally after a `$ ` shell-prompt marker. Deliberately narrow: a
// naive `idd-[a-z0-9-]+` scan matches 30+ unrelated tokens on this
// corpus (marker names, doc slugs, `idd-skill-*` prefixes, ...), almost
// none of which are command invocations (see the reconnaissance comment
// on issue #1674). This constrained form intentionally finds only a
// handful of hits on the current corpus, all already correctly backed
// -- a legitimate result, not a sign the form needs loosening; a
// deliberately introduced violation still trips it (see the synthetic
// test below).
const BARE_BIN_COMMAND_RE = /^\s*\$?\s*(idd-[a-zA-Z0-9-]+)\b/;
const FENCED_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console']);

/** Scans one file's text for all four invocation forms (raw matches, no manifest cross-check). */
function scanInvocations(content: string): {
  nodeScripts: string[];
  binMjs: string[];
  packageScripts: string[];
  bareBinCommands: string[];
} {
  const nodeScripts = [...content.matchAll(NODE_SCRIPTS_RE)].map((m) => m[1]);
  const binMjs = [...content.matchAll(BIN_MJS_RE)].map((m) => m[1]);
  const packageScripts = [...content.matchAll(PACKAGE_SCRIPT_RE)].map(
    (m) => m[1],
  );

  const bareBinCommands: string[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      if (inFence) {
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = fenceMatch[1] ?? '';
      }
      continue;
    }
    if (!inFence || !FENCED_LANGS.has(fenceLang)) {
      continue;
    }
    const match = line.match(BARE_BIN_COMMAND_RE);
    if (match) {
      bareBinCommands.push(match[1]);
    }
  }

  return { nodeScripts, binMjs, packageScripts, bareBinCommands };
}

/**
 * Checks every invocation form against the manifest command table (plus
 * the source-repo-internal allowlists) and the distributed-file
 * bin/idd-* ban. Pure function over in-memory file contents so both the
 * real-corpus test and the synthetic failure-rule tests below can drive
 * it without touching the filesystem or git.
 */
function collectHelperInvocationViolations(
  files: FileInput[],
  {
    commandCatalog,
    distributedFiles,
  }: { commandCatalog: ManifestCommand[]; distributedFiles: Set<string> },
): Violation[] {
  const entryPaths = new Set(commandCatalog.map((c) => c.entryPath));
  const binNames = new Set(commandCatalog.map((c) => c.binName));
  const scriptNames = new Set(commandCatalog.map((c) => c.scriptName));

  const violations: Violation[] = [];

  for (const file of files) {
    const { nodeScripts, binMjs, packageScripts, bareBinCommands } =
      scanInvocations(file.content);

    for (const entryPath of nodeScripts) {
      if (
        !entryPaths.has(entryPath) &&
        !SOURCE_REPO_INTERNAL_ENTRY_PATHS.has(entryPath)
      ) {
        violations.push({
          file: file.path,
          rule: 'unbacked-helper',
          form: 'node-scripts',
          name: entryPath,
          message: `\`node ${entryPath}\` names no HELPER_COMMANDS entryPath and is not in the source-repo-internal allowlist`,
        });
      }
    }

    for (const binName of binMjs) {
      if (!binNames.has(binName) && !NON_ADOPTER_BIN_NAMES.has(binName)) {
        violations.push({
          file: file.path,
          rule: 'unbacked-helper',
          form: 'bin-mjs',
          name: binName,
          message: `\`bin/${binName}.mjs\` names no HELPER_COMMANDS binName and is not in the non-adopter allowlist`,
        });
      }
      // Independent of backing: no adopter profile ever vends a
      // bin/<name>.mjs *path* (vendored-node's authoritative surface is
      // scripts/<name>.mjs; package-manager/ephemeral-npx's bin/ facade
      // is a bare `idd-<name>` command on PATH, never a relative file
      // path) -- see the "Authoritative invocation surface per profile"
      // paragraph in docs/idd-helper-scripts.md.
      if (
        distributedFiles.has(file.path) &&
        !DISTRIBUTED_BIN_BAN_EXEMPT_FILES.has(file.path)
      ) {
        violations.push({
          file: file.path,
          rule: 'distributed-bin-path',
          form: 'bin-mjs',
          name: binName,
          message: `\`bin/${binName}.mjs\` is a source-repository build-artifact path prescribed in a distributed file; no adopter profile vends bin/ wrappers`,
        });
      }
    }

    for (const scriptName of packageScripts) {
      if (
        !scriptNames.has(scriptName) &&
        !NON_ADOPTER_SCRIPT_NAMES.has(scriptName)
      ) {
        violations.push({
          file: file.path,
          rule: 'unbacked-helper',
          form: 'package-script',
          name: scriptName,
          message: `\`${scriptName}\` names no HELPER_COMMANDS scriptName and is not in the non-adopter allowlist`,
        });
      }
    }

    for (const binName of bareBinCommands) {
      if (!binNames.has(binName) && !NON_ADOPTER_BIN_NAMES.has(binName)) {
        violations.push({
          file: file.path,
          rule: 'unbacked-helper',
          form: 'bare-bin-command',
          name: binName,
          message: `\`${binName}\` (bare command in a fenced shell block) names no HELPER_COMMANDS binName and is not in the non-adopter allowlist`,
        });
      }
    }
  }

  return violations;
}

interface SyncManifest {
  fileSets: { sourceGlob: string; targetGlob: string }[];
  // `source` is absent on `mode: 'contains'` entries (a cross-reference
  // consistency check against a `reference` file, not a generated copy),
  // so it must stay optional here.
  syncPairs: { source?: string; target: string }[];
}

/**
 * A file counts as "distributed" when it lives under `idd-template/`
 * directly, or is the target side of an `audit/sync-manifest.json`
 * `fileSets`/`syncPairs` entry whose source lives under `idd-template/`
 * (i.e. it is a generated copy of distributed template content). Reuses
 * the existing `globFiles`/`globToRegExp` glob matcher instead of
 * hand-rolling one.
 */
function resolveDistributedFiles(
  repoFiles: string[],
  manifest: SyncManifest,
): Set<string> {
  const distributed = new Set<string>();
  for (const file of repoFiles) {
    if (file.startsWith('idd-template/')) {
      distributed.add(file);
    }
  }
  for (const fileSet of manifest.fileSets) {
    if (!fileSet.sourceGlob.startsWith('idd-template/')) {
      continue;
    }
    for (const target of globFiles(fileSet.targetGlob, repoFiles)) {
      distributed.add(target);
    }
  }
  for (const pair of manifest.syncPairs) {
    if (pair.source?.startsWith('idd-template/')) {
      distributed.add(pair.target);
    }
  }
  return distributed;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readRealScanFiles(): FileInput[] {
  const repoFiles = git(['ls-files']).split(/\r?\n/).filter(Boolean);
  const scanPrefixes = [
    '.github/instructions/',
    'docs/',
    'idd-template/.github/instructions/',
    'idd-template/docs/',
  ];
  return repoFiles
    .filter(
      (file) =>
        file.endsWith('.md') &&
        scanPrefixes.some((prefix) => file.startsWith(prefix)),
    )
    .map((file) => ({
      path: file,
      content: readFileSync(join(REPO_ROOT, file), 'utf8'),
    }));
}

test('helper invocations across the distributed Markdown surface match the runtime-profile manifest (idd-skill#1674)', () => {
  const files = readRealScanFiles();
  assert.ok(
    files.length > 50,
    'expected the scan to find a substantial number of instruction/docs files -- guards against a scope regression silently emptying the corpus',
  );

  const { commandCatalog } = buildHelperRuntimeManifest({
    targetRoot: REPO_ROOT,
  });
  const repoFiles = git(['ls-files']).split(/\r?\n/).filter(Boolean);
  const manifest = readJson('audit/sync-manifest.json') as SyncManifest;
  const distributedFiles = resolveDistributedFiles(repoFiles, manifest);

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles,
  });

  assert.deepEqual(
    violations,
    [],
    `helper invocation violations found:\n${violations
      .map((v) => `  ${v.file}: [${v.rule}/${v.form}] ${v.message}`)
      .join('\n')}`,
  );
});

test('resolveDistributedFiles classifies idd-template sources, their generated copies, and source-repo-only docs correctly', () => {
  const repoFiles = [
    'idd-template/docs/permissions.md',
    'docs/permissions.md',
    'docs/weak-model-authoring-lite-profile-design.md',
    'idd-template/docs/idd-helper-scripts.md',
    'docs/idd-helper-scripts.md',
  ];
  const manifest: SyncManifest = {
    fileSets: [
      {
        sourceGlob: 'idd-template/docs/idd-*.md',
        targetGlob: 'docs/idd-*.md',
      },
    ],
    syncPairs: [
      {
        source: 'idd-template/docs/permissions.md',
        target: 'docs/permissions.md',
      },
    ],
  };

  const distributed = resolveDistributedFiles(repoFiles, manifest);

  assert.equal(distributed.has('idd-template/docs/permissions.md'), true);
  assert.equal(distributed.has('docs/permissions.md'), true);
  assert.equal(
    distributed.has('idd-template/docs/idd-helper-scripts.md'),
    true,
  );
  assert.equal(distributed.has('docs/idd-helper-scripts.md'), true);
  assert.equal(
    distributed.has('docs/weak-model-authoring-lite-profile-design.md'),
    false,
  );
});

test('fails on a helper invocation naming no HELPER_COMMANDS entry and no allowlist entry (rule 2)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/real-helper.mjs',
      binName: 'idd-real-helper',
      scriptName: 'idd:real-helper',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/example.md',
      content:
        'Run `node scripts/totally-fake-helper.mjs --apply` before merging.',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(),
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'unbacked-helper');
  assert.equal(violations[0]?.name, 'scripts/totally-fake-helper.mjs');
});

test('does not fail on a backed or allowlisted helper invocation (rule 2 negative case)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/real-helper.mjs',
      binName: 'idd-real-helper',
      scriptName: 'idd:real-helper',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/example.md',
      content:
        'Run `node scripts/real-helper.mjs` (backed), or `node scripts/sync-docs.mjs` (allowlisted).',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(),
  });

  assert.deepEqual(violations, []);
});

test('fails on a bin/idd-* path prescribed in a distributed file, and not in a source-repo-only file (rule 3)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/idd-merge-execute.mjs',
      binName: 'idd-merge-execute',
      scriptName: 'idd:merge-execute',
    },
  ];
  const content =
    'Run `node bin/idd-merge-execute.mjs --apply` to execute the merge.';
  const files: FileInput[] = [
    { path: 'idd-template/docs/example.md', content },
    { path: 'docs/source-repo-only-design-note.md', content },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(['idd-template/docs/example.md']),
  });

  assert.deepEqual(
    violations.map((v) => ({ file: v.file, rule: v.rule })),
    [{ file: 'idd-template/docs/example.md', rule: 'distributed-bin-path' }],
  );
});

test('does not fail on a bin/idd-* path in an explicitly exempted distributed file (permissions.md)', () => {
  const commandCatalog: ManifestCommand[] = [
    {
      entryPath: 'scripts/idd-merge-execute.mjs',
      binName: 'idd-merge-execute',
      scriptName: 'idd:merge-execute',
    },
  ];
  const files: FileInput[] = [
    {
      path: 'docs/permissions.md',
      content:
        'The opt-in template counterpart denies `bin/idd-merge-execute.mjs*` for exactly this reason.',
    },
  ];

  const violations = collectHelperInvocationViolations(files, {
    commandCatalog,
    distributedFiles: new Set(['docs/permissions.md']),
  });

  assert.deepEqual(violations, []);
});
