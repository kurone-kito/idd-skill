#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-onboard.mts
//
// The scripts/idd-onboard.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Onboarding automation CLI — wave 1: placeholder substitution (#1263,
// roadmap #1262). Wave 2 (#1292) adds the --import fetch/copy stage. Wave 3
// (#1293) adds the --verify post-import check stage.
//
// --substitute: given a target tree that already contains the imported
// template files, resolve the seven onboarding placeholders (auto-derived
// from repository evidence where
// `idd-template/docs/onboarding/placeholders.md` defines a derivation;
// explicit flags override) and rewrite the files. `--dry-run` prints the
// per-file, per-placeholder plan without writing anything. That reference
// document is the source of truth this CLI must match; a drift test in
// tests/idd-onboard.test.mts fails on mismatch.
//
// --import: copy the distributed core template file set (and, with
// `--profile vendored-node`, the profile-conditional helper bundle) from a
// local idd-skill source tree into a target repository. The file set is
// read from `audit/sync-manifest.json`'s `idd-template-core-files`
// generated block — the same canonical source `sync-docs.mjs` /
// `audit-docs.mjs` render into `idd-template/ONBOARDING.md`'s Step 2 file
// list — so the CLI and the manual doc can never carry two independently
// hardcoded file lists. A drift test in tests/idd-onboard.test.mts fails on
// mismatch. `--hold <target-path>` (repeatable, #3214) opts an adopter out
// of importing one or more named manifest entries -- for a target file the
// adopter deliberately forked -- while every other resolved entry still
// imports; omitting it leaves this stage's behavior unchanged.
//
// --verify: mechanical pass/fail for a target tree after --import and
// --substitute have run, replacing a manual walkthrough of
// `idd-template/ONBOARDING.md` Step 6 with five check groups: manifest
// completeness (reuses --import's own manifest resolution — no second file
// list), placeholder residue (reuses --substitute's scanner — no second
// scan), a helper-load check (#3238: for --profile vendored-node only,
// spawns every cataloged helper under --target with --help and reports
// any that fail to load), a stale-import signal (re-runs idd-doctor's
// content-based drift detector against the target's imported files
// instead of forking its logic, the #1208 shared-module convention
// `check-pnpm-boundary.mts` already uses), and a package-pin advisory
// (#2987: warns, but never blocks, when the target's effective
// `helperRuntime.profile` is `ephemeral-npx`/`package-manager` with no
// `helperRuntime.packageSpec` configured, so helper commands silently
// resolve against the mutable default archive URL instead of an audited
// pin).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveBundleRoot } from './bundle-root.mts';
import { stripLeadingArgumentSeparator } from './cli-args.mts';
import { NON_TTY_ERROR } from './force-handoff.mts';
import { safeGhText } from './gh-exec.mts';
import {
  buildCommandCatalog,
  collectHelperRuntimeEvidence,
  collectVendoredFiles,
  PROFILE_NAMES,
} from './helper-runtime-manifest.mts';
import { findMissingWorktreeHardening } from './idd-doctor.mts';
import type {
  HearingCatalogItem,
  OnboardingHearingCatalog,
} from './onboarding-hearing.mts';
import { loadOnboardingHearingCatalog } from './onboarding-hearing.mts';
import {
  inspectDevelopmentBranch,
  inspectHelperRuntimeConfig,
  normalizePolicyConfig,
} from './policy-helpers.mts';
import type { PromptFn } from './readline-prompt.mts';
import { makeReadlinePrompt } from './readline-prompt.mts';
import {
  loadJson,
  validate,
  validateConfigSection,
} from './validate-schemas.mts';

/** Substitution role of a placeholder: only `command` rows may be `true`. */
export type OnboardingPlaceholderKind = 'identity' | 'command';

/** One of the seven template placeholders the replacement pass rewrites. */
export interface OnboardingPlaceholder {
  /** Bare name as it appears between the braces, e.g. `REPO_NAME`. */
  name: string;
  /** Literal doubled-brace token to replace in scanned files. */
  token: string;
  kind: OnboardingPlaceholderKind;
  /** CLI override flag, e.g. `--repo-name`. */
  flag: string;
}

function placeholder(
  name: string,
  kind: OnboardingPlaceholderKind,
  flag: string,
): OnboardingPlaceholder {
  return { name, token: `{{${name}}}`, kind, flag };
}

/**
 * The seven placeholders, in the order of the "Final placeholder
 * meanings" table in `idd-template/docs/onboarding/placeholders.md`. The
 * drift test asserts this list matches that table exactly.
 */
export const ONBOARDING_PLACEHOLDERS: readonly OnboardingPlaceholder[] = [
  placeholder('REPO_NAME', 'identity', '--repo-name'),
  placeholder('PROJECT_MARKER_PREFIX', 'identity', '--marker-prefix'),
  placeholder('TRUSTED_MARKER_ACTOR', 'identity', '--trusted-marker-actor'),
  placeholder('FIX_VALIDATE_COMMANDS', 'command', '--fix-validate-commands'),
  placeholder(
    'PRE_PUSH_VALIDATE_COMMANDS',
    'command',
    '--pre-push-validate-commands',
  ),
  placeholder(
    'POST_FIX_VALIDATE_COMMANDS',
    'command',
    '--post-fix-validate-commands',
  ),
  placeholder('INSTALL_DEPS_COMMAND', 'command', '--install-deps-command'),
];

/** Validation pattern for the PROJECT_MARKER_PREFIX value (reference). */
export const MARKER_PREFIX_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Owner/repo pair parsed from a git remote URL. */
export interface RemoteRepoRef {
  /**
   * Owner segment, known only for the plain two-segment `owner/repo`
   * form; deeper paths (GitLab subgroups, Azure `_git` routes) leave it
   * `null` rather than guessing a wrong segment.
   */
  owner: string | null;
  repo: string;
}

/**
 * Parse the owner and repository short name from a git remote URL.
 * Supports the common `https://`, `ssh://`, and scp-like
 * `git@host:owner/repo(.git)` forms, tolerating a trailing slash.
 * Returns `null` when the URL does not carry a repository path —
 * derivation then falls back to flags.
 */
export function parseRemoteRepoRef(url: unknown): RemoteRepoRef | null {
  const raw = String(url ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (raw === '') {
    return null;
  }
  // Normalize the scp-like form (`git@host:owner/repo.git`) into a path.
  const scpMatch = raw.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  const path = scpMatch
    ? scpMatch[2]
    : raw.replace(/^[a-z+]+:\/\/([^/@]+@)?[^/]+\//i, '');
  if (path === raw && !scpMatch) {
    return null;
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const repo = (segments[segments.length - 1] ?? '').replace(/\.git$/, '');
  if (repo === '') {
    return null;
  }
  const owner = segments.length === 2 ? (segments[0] ?? null) : null;
  return { owner, repo };
}

/**
 * Normalize a repository short name into a PROJECT_MARKER_PREFIX
 * candidate: lowercase, non-`[a-z0-9-]` runs collapsed to `-`, leading
 * non-letter characters stripped (the prefix must start with a letter),
 * cut to 32 characters, trailing `-` stripped. Returns `null` when the
 * result does not satisfy `MARKER_PREFIX_PATTERN` (fail closed).
 */
export function deriveMarkerPrefix(repoName: unknown): string | null {
  const candidate = String(repoName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return MARKER_PREFIX_PATTERN.test(candidate) ? candidate : null;
}

/**
 * JSON-escape a substitution value for a placeholder site inside a JSON
 * string field (the template provides the surrounding quotes, so this is
 * the escaped string *content* only). Escaping is a property of the
 * substitution site, not the value: the same command row lands raw in
 * the markdown command tables and escaped inside `config.json`, and the
 * onboarding reference requires the JSON command strings to stay
 * JSON-escaped rather than raw shell.
 */
export function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Install command per detected Node.js package manager. */
const NODE_INSTALL_COMMANDS: Record<string, string> = {
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
};

/**
 * Python tool table from the reference (`pyproject.toml` tool section →
 * command). Patterns match the bare `[tool.x]` header and its dotted
 * sub-tables (`[tool.x.y]`), the common real-world shape.
 */
const PYPROJECT_TOOL_COMMANDS: readonly {
  pattern: RegExp;
  command: string;
}[] = [
  { pattern: /^\s*\[tool\.poetry[.\]]/mu, command: 'poetry install' },
  { pattern: /^\s*\[tool\.pdm[.\]]/mu, command: 'pdm install' },
  { pattern: /^\s*\[tool\.hatch[.\]]/mu, command: 'hatch env create' },
  { pattern: /^\s*\[tool\.uv[.\]]/mu, command: 'uv sync' },
];

// lstatSync, not statSync: every existence/type check below feeds a
// decision about whether it is safe to read from or write to a path (the
// --import planner's fileExists / pathExists / hasNonDirectoryAncestor,
// plus the placeholder-derivation checks below that also call
// fileExists). statSync follows symlinks, so a symlink leaf or ancestor
// would be silently treated as whatever it points to; a symlink inside
// --source or --target could then let a copy read from or write outside
// the intended root. lstatSync reports the entry itself, so any symlink
// is classified as "not a plain file/directory" and — for the --import
// planner — falls through to the existing blocked-non-file handling
// instead of being followed.

function fileExists(root: string, name: string): boolean {
  try {
    return lstatSync(join(root, name)).isFile();
  } catch {
    return false;
  }
}

/** Whether any filesystem entry exists at `root`/`name`, of any type. */
function pathExists(root: string, name: string): boolean {
  try {
    lstatSync(join(root, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether any ancestor directory segment of `root`/`relativePath` already
 * exists as a non-directory entry (e.g. a plain file — or a symlink,
 * including one that points at a real directory — at `.github` when
 * planning `.github/idd/config.json`). `mkdirSync`'s recursive mode
 * cannot create a directory through such an obstruction (and would
 * otherwise silently traverse a symlinked ancestor), so this must be
 * checked separately from the leaf path itself (see `pathExists`).
 * `relativePath` uses `/` separators, matching every
 * `ManifestFile.targetPath` in this module. A missing (rather than
 * non-directory) ancestor is fine — `mkdirSync`'s recursive mode creates
 * it — so this returns `false` as soon as an ancestor segment does not
 * exist yet.
 */
function hasNonDirectoryAncestor(root: string, relativePath: string): boolean {
  const segments = relativePath.split('/').slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (!lstatSync(current).isDirectory()) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function readTextIfPresent(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), 'utf8');
  } catch {
    return null;
  }
}

/** Dependency tooling recognized by the derivation table. */
function hasAnyRecognizedTooling(targetDir: string): boolean {
  return (
    fileExists(targetDir, 'package.json') ||
    fileExists(targetDir, 'pnpm-lock.yaml') ||
    fileExists(targetDir, 'package-lock.json') ||
    fileExists(targetDir, 'yarn.lock') ||
    fileExists(targetDir, 'requirements.txt') ||
    fileExists(targetDir, 'pyproject.toml') ||
    fileExists(targetDir, 'go.mod') ||
    fileExists(targetDir, 'Gemfile') ||
    fileExists(targetDir, 'Cargo.toml')
  );
}

/**
 * Derive the INSTALL_DEPS_COMMAND row from the target tree per the
 * reference table. Returns `null` when the evidence is ambiguous or
 * insufficient (bare `package.json` without package-manager signals,
 * `pyproject.toml` + `requirements.txt` together, an unrecognized Python
 * tool) — the reference says not to guess in those cases. Returns the
 * no-op `true` only when no standard dependency tooling exists at all.
 */
export function deriveInstallDepsCommand(targetDir: string): string | null {
  const hasRequirements = fileExists(targetDir, 'requirements.txt');
  const pyproject = readTextIfPresent(targetDir, 'pyproject.toml');
  if (hasRequirements && pyproject !== null) {
    // Both Python workflows present: confirm with the operator.
    return null;
  }
  // The reference's Node signals — declared packageManager metadata or
  // exactly one supported lockfile — apply with or without a
  // package.json alongside them.
  const evidence = collectHelperRuntimeEvidence(targetDir);
  if (evidence.detectedPackageManager !== '') {
    return NODE_INSTALL_COMMANDS[evidence.detectedPackageManager] ?? null;
  }
  if (fileExists(targetDir, 'package.json')) {
    // A bare package.json without those signals is not enough evidence
    // to infer `npm install`.
    return null;
  }
  if (hasRequirements) {
    return 'pip install -r requirements.txt';
  }
  if (pyproject !== null) {
    const match = PYPROJECT_TOOL_COMMANDS.find(({ pattern }) =>
      pattern.test(pyproject),
    );
    return match ? match.command : null;
  }
  if (fileExists(targetDir, 'go.mod')) {
    return 'go mod download';
  }
  if (fileExists(targetDir, 'Gemfile')) {
    return 'bundle install';
  }
  if (!hasAnyRecognizedTooling(targetDir)) {
    return 'true';
  }
  return null;
}

/** The three validate-command rows derived together. */
export interface ValidateCommandRows {
  fixValidate: string | null;
  prePushValidate: string | null;
  postFixValidate: string | null;
}

// The exact set of doubled-brace tokens this module's own onboarding
// substitution ever writes/reads (ONBOARDING_PLACEHOLDERS above). An
// adopter's own commands row can legitimately hold a `{{...}}`-shaped
// literal value that has nothing to do with this onboarding flow (their
// own downstream template syntax); only a row matching one of *our* seven
// known tokens is unresolved onboarding residue worth treating as unset,
// not any string that merely has the same doubled-brace shape (Copilot
// review on PR #2254).
const KNOWN_PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set(
  ONBOARDING_PLACEHOLDERS.map((entry) => entry.token),
);

/**
 * Read the target tree's existing `.github/idd/config.json` `commands`
 * table, when present, parseable, and non-empty (#2222). A row still
 * holding one of this module's own unsubstituted onboarding placeholder
 * tokens — a freshly imported tree before `--substitute` has run, e.g.
 * the raw doubled-brace FIX_VALIDATE_COMMANDS token (spelled without
 * braces here per this module's own comment convention below, so this
 * file's own generated `.mjs` copy never registers as leftover template
 * residue) — is treated as unset rather than as a real existing value.
 * Returns `null` for a missing file, unparseable JSON, or an
 * absent/non-object/empty `commands` table; every such case means
 * first-time onboarding, so the caller falls back to the
 * package.json-derived heuristic unchanged.
 *
 * Exported so `runImportCli` can snapshot the pre-import table before
 * `--import` overwrites `.github/idd/config.json`, restoring it afterward
 * via `restoreExistingCommandsTable` below.
 */
export function readExistingCommandsTable(
  targetDir: string,
): Record<string, string> | null {
  // fileExists uses lstatSync (never follows symlinks), matching this
  // module's existing convention (see the lstatSync note above) --
  // readTextIfPresent's plain readFileSync would otherwise happily follow
  // a symlinked config.json (or a symlinked .github/.github/idd ancestor
  // directory -- fileExists alone only lstats the leaf) and let its
  // target-boundary-external content leak into the substitution verdict
  // and target files (#2254 review).
  if (
    hasNonDirectoryAncestor(targetDir, '.github/idd/config.json') ||
    !fileExists(targetDir, '.github/idd/config.json')
  ) {
    return null;
  }
  const configText = readTextIfPresent(targetDir, '.github/idd/config.json');
  if (configText === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  // A valid JSON document can still parse to a non-object root (`null`, a
  // number, a bare string, an array) -- guard before reading `.commands`
  // off it, since a `null` root would otherwise throw on property access
  // rather than being treated as "no commands table" like every other
  // malformed-config case above.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const commands = (parsed as { commands?: unknown }).commands;
  if (
    commands === null ||
    typeof commands !== 'object' ||
    Array.isArray(commands)
  ) {
    return null;
  }
  const table: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    commands as Record<string, unknown>,
  )) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed !== '' && !KNOWN_PLACEHOLDER_TOKENS.has(trimmed)) {
      table[key] = value as string;
    }
  }
  return Object.keys(table).length > 0 ? table : null;
}

/**
 * Derive the three validate-command rows from the target tree per the
 * reference patterns: Node trees read the existing `package.json` scripts;
 * `go.mod` / `Cargo.toml` trees use the fixed rows; a tree with no
 * recognized tooling at all takes the no-op `true` rows. Anything else
 * stays unresolved so the operator supplies flags.
 *
 * A re-import against a tree that already carries a populated `commands`
 * table in `.github/idd/config.json` (#2222) prefers each existing row
 * over this re-derivation instead of silently overwriting a deliberately
 * customized command with a mechanically re-derived one; the caller's own
 * `--*-commands` flag overrides still take priority over both (applied by
 * `resolvePlaceholderValues`, not here). Only a row the existing table
 * leaves unset falls through to the heuristic below, and a first-time
 * onboarding (no existing table) leaves every row on the heuristic exactly
 * as before.
 */
export function deriveValidateCommands(targetDir: string): ValidateCommandRows {
  const heuristic = deriveValidateCommandsFromTooling(targetDir);
  const existing = readExistingCommandsTable(targetDir);
  if (existing === null) {
    return heuristic;
  }
  return {
    fixValidate: existing['fix-validate'] ?? heuristic.fixValidate,
    prePushValidate: existing['pre-push-validate'] ?? heuristic.prePushValidate,
    postFixValidate: existing['post-fix-validate'] ?? heuristic.postFixValidate,
  };
}

function deriveValidateCommandsFromTooling(
  targetDir: string,
): ValidateCommandRows {
  const packageJsonText = readTextIfPresent(targetDir, 'package.json');
  if (packageJsonText !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(packageJsonText) as {
        scripts?: Record<string, unknown>;
      };
      scripts = parsed.scripts ?? {};
    } catch {
      // Unparseable package.json: leave every row unresolved.
      return {
        fixValidate: null,
        prePushValidate: null,
        postFixValidate: null,
      };
    }
    const evidence = collectHelperRuntimeEvidence(targetDir);
    const pm = evidence.detectedPackageManager;
    if (pm === '') {
      // Package manager unknown or ambiguous: do not guess npm — the
      // same fail-closed stance deriveInstallDepsCommand applies to the
      // exact same evidence.
      return {
        fixValidate: null,
        prePushValidate: null,
        postFixValidate: null,
      };
    }
    const fixValidate =
      'lint:fix' in scripts && 'lint' in scripts
        ? `${pm} run lint:fix && ${pm} run lint`
        : null;
    const prePushParts = ['lint', 'build', 'test'].filter(
      (name) => name in scripts,
    );
    const prePushValidate =
      prePushParts.length > 0
        ? prePushParts.map((name) => `${pm} run ${name}`).join(' && ')
        : null;
    // Superset of the two rows with duplicate steps removed (a naive
    // concatenation would run `<pm> run lint` twice back to back).
    const postFixCommands = [
      ...(fixValidate ? fixValidate.split(' && ') : []),
      ...(prePushValidate ? prePushValidate.split(' && ') : []),
    ].filter((command, index, all) => all.indexOf(command) === index);
    const postFixValidate =
      postFixCommands.length > 0 ? postFixCommands.join(' && ') : null;
    return { fixValidate, prePushValidate, postFixValidate };
  }
  if (fileExists(targetDir, 'go.mod')) {
    return {
      fixValidate: 'go fmt ./...',
      prePushValidate: 'go vet ./... && go test ./...',
      postFixValidate: 'go fmt ./... && go vet ./... && go test ./...',
    };
  }
  if (fileExists(targetDir, 'Cargo.toml')) {
    return {
      fixValidate: 'cargo fmt',
      prePushValidate: 'cargo check && cargo test',
      postFixValidate: 'cargo fmt && cargo check && cargo test',
    };
  }
  if (!hasAnyRecognizedTooling(targetDir)) {
    return {
      fixValidate: 'true',
      prePushValidate: 'true',
      postFixValidate: 'true',
    };
  }
  return { fixValidate: null, prePushValidate: null, postFixValidate: null };
}

/** Escape a literal string for embedding in a `RegExp` source. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Scope matches deriveValidateCommands above exactly (#2222's three
// validate-command rows). install-deps is deliberately excluded: the issue
// scopes only fix-validate/pre-push-validate/post-fix-validate, and
// INSTALL_DEPS_COMMAND already has its own independent re-derivation
// (deriveInstallDepsCommand) that this restore step must not shadow.
const RESTORABLE_COMMAND_KEYS: ReadonlySet<string> = new Set([
  'fix-validate',
  'pre-push-validate',
  'post-fix-validate',
]);

/**
 * Restore a target's pre-import validate-command row values into its
 * freshly-copied `.github/idd/config.json` (#2222). `--import` always
 * copies `.github/idd/config.json` byte-for-byte from source — including
 * on a re-import over an already-onboarded target, where it clobbers a
 * deliberately customized `commands` table with the source template's raw
 * doubled-brace placeholder tokens (spelled without braces in comments
 * per this module's own convention below). Without this restore,
 * `deriveValidateCommands` above has nothing left to prefer by the time
 * `--substitute` runs.
 *
 * Call this **after** `applyImportPlan` has copied the target tree, passing
 * the `commands` snapshot `readExistingCommandsTable` captured from the
 * **pre-import** target. Only restores the three rows in
 * `RESTORABLE_COMMAND_KEYS`, and only a row that is still the raw
 * placeholder token right after the copy — a source-provided literal value
 * (no `{{...}}` template site for that key) is left untouched, since there
 * is nothing to substitute later and overwriting it would silently discard
 * an intentional source-side change instead. No-op when the snapshot is
 * null/empty, the target has no `.github/idd/config.json`, or a given
 * snapshot row has no matching placeholder-token site left to restore into.
 */
export function restoreExistingCommandsTable(
  targetDir: string,
  existingCommands: Record<string, string> | null,
): void {
  if (existingCommands === null || Object.keys(existingCommands).length === 0) {
    return;
  }
  const configRelativePath = '.github/idd/config.json';
  // Same ancestor-and-leaf symlink rejection as readExistingCommandsTable
  // above -- a symlinked config.json, or a symlinked .github/.github/idd
  // ancestor directory, would otherwise let this function write through
  // it to a target-boundary-external file.
  if (
    hasNonDirectoryAncestor(targetDir, configRelativePath) ||
    !fileExists(targetDir, configRelativePath)
  ) {
    return;
  }
  const text = readTextIfPresent(targetDir, configRelativePath);
  if (text === null) {
    return;
  }
  let updated = text;
  for (const [key, value] of Object.entries(existingCommands)) {
    if (!RESTORABLE_COMMAND_KEYS.has(key)) {
      continue;
    }
    const rowPattern = new RegExp(
      `("${escapeRegExpLiteral(key)}"\\s*:\\s*)"\\{\\{[A-Z][A-Z0-9_]*\\}\\}"`,
    );
    updated = updated.replace(
      rowPattern,
      (_match, prefix: string) =>
        `${prefix}"${escapeJsonStringContent(value)}"`,
    );
  }
  if (updated !== text) {
    writeFileSync(join(targetDir, ...configRelativePath.split('/')), updated);
  }
}

/** How a placeholder value was established. */
export type PlaceholderValueSource = 'flag' | 'derived';

/** A resolved placeholder value with its provenance. */
export interface ResolvedPlaceholderValue {
  value: string;
  source: PlaceholderValueSource;
}

/** Explicit override values keyed by placeholder name. */
export type PlaceholderOverrides = Partial<Record<string, string>>;

/** Injectable evidence readers so resolution stays unit-testable. */
export interface OnboardEvidenceReaders {
  /** Returns the target tree's `remote.origin.url`, or `null`. */
  readRemoteUrl?: (targetDir: string) => string | null;
  /**
   * Returns the repository's live GitHub default branch (#2271), or
   * `null` when `gh` is unavailable, unauthenticated, or the read fails.
   * Injectable so hearing-flow tests never need real `gh` credentials.
   */
  readDefaultBranch?: (targetDir: string) => string | null;
  /**
   * True when `branch` exists on the configured `origin` remote (#2271).
   * Injectable for the same reason as {@link readDefaultBranch} -- the
   * default implementation shells out to `git ls-remote`, which real
   * unit tests must not depend on.
   */
  readRemoteBranchExists?: (targetDir: string, branch: string) => boolean;
}

/** Default remote-URL reader: `git -C <target> config remote.origin.url`. */
export function readGitRemoteUrl(targetDir: string): string | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', targetDir, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

/**
 * Default GitHub default-branch reader: `gh repo view <owner>/<repo>
 * --json defaultBranchRef` (#2271), via the shared `gh-exec.mts` layer
 * (#1675 -- every `gh` spawn routes through it, never a direct spawn of
 * the `gh` executable itself). The explicit `owner/repo` positional (derived
 * from the target's own `remote.origin.url`, the same evidence
 * `resolvePlaceholderValues`'s `REPO_NAME` already reads) means this
 * never depends on this *process's* cwd matching `targetDir`, unlike a
 * bare `gh repo view`. Returns `null` on any failure -- unparsable
 * remote, missing `gh`, no auth, no network, or an incomplete response --
 * so callers fall back to treating the candidate as undetermined.
 */
export function readGithubDefaultBranch(targetDir: string): string | null {
  const remoteRef = parseRemoteRepoRef(readGitRemoteUrl(targetDir));
  if (!remoteRef || remoteRef.owner === null) {
    return null;
  }
  const output = safeGhText([
    'repo',
    'view',
    `${remoteRef.owner}/${remoteRef.repo}`,
    '--json',
    'defaultBranchRef',
  ]);
  if (output === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(output) as {
      defaultBranchRef?: { name?: unknown };
    };
    const branch = parsed.defaultBranchRef?.name;
    return typeof branch === 'string' && branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Default remote-branch-existence reader: `git ls-remote --exit-code
 * --heads origin <branch>` (#2271). Deliberately independent of `gh` --
 * a plain `git`-only check so recording an explicitly-selected
 * development branch never requires GitHub CLI auth, only the `origin`
 * remote already required for `readGitRemoteUrl` above.
 */
export function checkGitRemoteBranchExists(
  targetDir: string,
  branch: string,
): boolean {
  try {
    execFileSync(
      'git',
      [
        '-C',
        targetDir,
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        branch,
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the onboarding candidate for `developmentBranch` (#2271): the
 * repository's live GitHub default branch, via the injectable
 * {@link OnboardEvidenceReaders.readDefaultBranch} (default
 * {@link readGithubDefaultBranch}). Returns `null` when undetermined --
 * the hearing flow then falls back to prompting with no derived default.
 */
export function deriveDevelopmentBranchCandidate(
  targetDir: string,
  readers: OnboardEvidenceReaders = {},
): string | null {
  const readDefaultBranch =
    readers.readDefaultBranch ?? readGithubDefaultBranch;
  return readDefaultBranch(targetDir);
}

/** Outcome of resolving all seven placeholder values for a target tree. */
export interface PlaceholderResolution {
  values: Record<string, ResolvedPlaceholderValue | null>;
  /** Placeholder names that could not be resolved. */
  unresolved: string[];
}

/**
 * Resolve the seven placeholder values: explicit flag overrides win;
 * otherwise auto-derive from the target tree where the reference defines
 * a derivation. Enforces the no-op rule (`true` is valid only for the
 * command placeholders) and the marker-prefix pattern on explicit
 * overrides (fail closed on invalid input rather than substituting a
 * value the template contract rejects).
 *
 * `TRUSTED_MARKER_ACTOR` is never auto-derived: the remote owner slug is
 * an organization name on org-owned repositories, not a login that posts
 * markers, so silently writing it into the trust configuration would
 * fail open. The reference's owner-derived candidate is an operator
 * proposal, not a substitution value — the flag is required.
 */
export function resolvePlaceholderValues(
  targetDir: string,
  overrides: PlaceholderOverrides = {},
  readers: OnboardEvidenceReaders = {},
): PlaceholderResolution {
  const knownNames = new Set(
    ONBOARDING_PLACEHOLDERS.map((entry) => entry.name),
  );
  for (const key of Object.keys(overrides)) {
    if (!knownNames.has(key)) {
      throw new Error(`unknown placeholder override: ${key}`);
    }
  }
  for (const entry of ONBOARDING_PLACEHOLDERS) {
    const override = overrides[entry.name];
    if (override === 'true' && entry.kind !== 'command') {
      throw new Error(
        `the no-op value "true" is only valid for command placeholders, not ${entry.name}`,
      );
    }
  }
  const markerOverride = overrides.PROJECT_MARKER_PREFIX;
  if (
    markerOverride !== undefined &&
    !MARKER_PREFIX_PATTERN.test(markerOverride)
  ) {
    throw new Error(
      `--marker-prefix must match ${MARKER_PREFIX_PATTERN}: ${markerOverride}`,
    );
  }

  const readRemoteUrl = readers.readRemoteUrl ?? readGitRemoteUrl;
  const remoteRef = parseRemoteRepoRef(readRemoteUrl(targetDir));
  const validateRows = deriveValidateCommands(targetDir);
  // The marker prefix derives from the *finalized* repository name, so an
  // explicit --repo-name feeds the derivation exactly as the reference
  // ("start from the repository name") describes.
  const repoName = overrides.REPO_NAME ?? remoteRef?.repo ?? null;
  const derived: Record<string, string | null> = {
    REPO_NAME: remoteRef?.repo ?? null,
    PROJECT_MARKER_PREFIX:
      repoName !== null ? deriveMarkerPrefix(repoName) : null,
    TRUSTED_MARKER_ACTOR: null,
    FIX_VALIDATE_COMMANDS: validateRows.fixValidate,
    PRE_PUSH_VALIDATE_COMMANDS: validateRows.prePushValidate,
    POST_FIX_VALIDATE_COMMANDS: validateRows.postFixValidate,
    INSTALL_DEPS_COMMAND: deriveInstallDepsCommand(targetDir),
  };

  const values: Record<string, ResolvedPlaceholderValue | null> = {};
  const unresolved: string[] = [];
  for (const entry of ONBOARDING_PLACEHOLDERS) {
    const override = overrides[entry.name];
    let resolved: ResolvedPlaceholderValue | null = null;
    if (override !== undefined) {
      resolved = { value: override, source: 'flag' };
    } else if (derived[entry.name] !== null) {
      resolved = { value: derived[entry.name] as string, source: 'derived' };
    }
    // Values stay raw here; JSON escaping is applied per substitution
    // site by buildSubstitutionPlan (the same value lands raw in the
    // markdown tables and escaped inside config.json string fields).
    values[entry.name] = resolved;
    if (!resolved) {
      unresolved.push(entry.name);
    }
  }
  return { values, unresolved };
}

// Placeholder-shaped tokens: doubled braces around an upper-snake name.
// Comments in this module spell token names WITHOUT the doubled braces:
// idd-doctor's unresolved-placeholder scan reads the generated artifact,
// and a braced example would register as leftover template residue.
const PLACEHOLDER_TOKEN_PATTERN = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

/** Directories never scanned for placeholder tokens. */
const SCAN_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Paths (relative to the substitution target root, `/`-separated) that
 * document the seven onboarding placeholders rather than consume them —
 * they intentionally keep every worked-example token literal, so a blind
 * global rewrite corrupts their headings and orphans prose that refers
 * back to the token by name (#1924). Both `scanPlaceholderTokens` and
 * `applySubstitutionPlan` skip these paths, so they neither contribute
 * matches to a substitution plan nor get rewritten even if a plan is
 * ever built from a hand-rolled scan. Extend this set in one place if a
 * later meta-doc needs the same carve-out.
 */
export const SCAN_EXCLUDED_PATHS = new Set([
  'docs/onboarding/placeholders.md',
  'docs/customization.md',
  'docs/onboarding/policy-decisions.md',
  // #2489: same type: reference / literal-token-display pattern as the
  // three above, found during a sweep of docs/onboarding/*.md for
  // anything else missed by #1924's original list.
  'docs/onboarding/agent-entry-and-verification.md',
  'docs/onboarding/project-tuning.md',
]);

/** Token occurrences found in one scanned file. */
export interface PlaceholderFileScan {
  /** Path relative to the scan root, `/`-separated. */
  file: string;
  /** Token literal → occurrence count within the file. */
  tokens: Map<string, number>;
}

function isProbablyBinary(content: Buffer): boolean {
  return content.includes(0);
}

/**
 * Walk the target tree (excluding `.git` and `node_modules`, skipping
 * binary files and `SCAN_EXCLUDED_PATHS`) and collect every
 * placeholder-shaped `{{...}}` token per file, in ascending path order.
 * Symlinks are deliberately not followed: imported template files are
 * regular files, and following links could escape the target tree. This
 * function stays whole-tree and scope-agnostic on purpose (#3291): a
 * caller that needs to distinguish an imported file from an adopter-owned
 * one narrows the result afterward via `partitionScansByScope`, so the
 * walk itself never has to know the manifest.
 */
export function scanPlaceholderTokens(
  targetDir: string,
): PlaceholderFileScan[] {
  const results: PlaceholderFileScan[] = [];
  const compareEntryNames = (
    left: { name: string },
    right: { name: string },
  ): number => {
    if (left.name < right.name) {
      return -1;
    }
    return left.name > right.name ? 1 : 0;
  };
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort(
      compareEntryNames,
    );
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) {
          walk(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = relative(targetDir, absolute).split('\\').join('/');
      if (SCAN_EXCLUDED_PATHS.has(relativePath)) {
        continue;
      }
      const raw = readFileSync(absolute);
      if (isProbablyBinary(raw)) {
        continue;
      }
      const tokens = new Map<string, number>();
      for (const match of raw
        .toString('utf8')
        .matchAll(PLACEHOLDER_TOKEN_PATTERN)) {
        tokens.set(match[0], (tokens.get(match[0]) ?? 0) + 1);
      }
      if (tokens.size > 0) {
        results.push({
          file: relativePath,
          tokens,
        });
      }
    }
  };
  walk(targetDir);
  return results;
}

/**
 * The subset of `SCAN_EXCLUDED_PATHS` that exists under `targetDir`,
 * sorted. `--substitute` reports this list as `skippedPaths` in its
 * printed verdict so an operator can see the meta-doc carve-out applied
 * rather than inferring it from an absent plan entry.
 */
export function listSkippedPlaceholderPaths(targetDir: string): string[] {
  return [...SCAN_EXCLUDED_PATHS]
    .filter((path) => existsSync(resolve(targetDir, path)))
    .sort();
}

/** One planned rewrite: every occurrence of a token in one file. */
export interface SubstitutionPlanEntry {
  file: string;
  placeholder: string;
  occurrences: number;
  from: string;
  to: string;
}

/** One residue finding: an unresolved placeholder that would survive. */
export interface SubstitutionResidueEntry {
  file: string;
  token: string;
  occurrences: number;
}

/** One informational finding: a `{{...}}`-shaped token not in the seven. */
export interface UnknownTokenEntry {
  file: string;
  token: string;
  occurrences: number;
}

/**
 * The full dry-run/apply plan for one target tree, over whichever scans
 * the caller passes in. `buildSubstitutionPlan` itself is scope-agnostic
 * -- it never reads the filesystem or knows about
 * `SCAN_EXCLUDED_PATHS`/scope narrowing; every caller (`--substitute`,
 * `checkPlaceholderResidue`) pre-filters via `partitionScansByScope`
 * (#3291) before calling this, so only in-scope scans ever reach it.
 */
export interface SubstitutionPlan {
  entries: SubstitutionPlanEntry[];
  /** Unresolved onboarding placeholders — blocking (exit 1). */
  residue: SubstitutionResidueEntry[];
  /**
   * Placeholder-shaped tokens outside the seven, found in an IN-SCOPE
   * file — informational only. A token found in an OUT-OF-SCOPE file
   * instead lands in the caller's own `outOfScopeTokens`
   * (`partitionScansByScope`/`PlaceholderResidueResult`, #3291), never
   * here, regardless of whether it happens to match one of the seven.
   */
  unknownTokens: UnknownTokenEntry[];
}

/**
 * Combine the token scan with the resolved values into the substitution
 * plan: known tokens with resolved values become plan entries; known
 * tokens without values become blocking residue (the reference's final
 * "verify that no `{{...}}` strings remain" pass for the seven); other
 * `{{...}}`-shaped tokens are reported informationally.
 */
export function buildSubstitutionPlan(
  scans: readonly PlaceholderFileScan[],
  resolution: PlaceholderResolution,
): SubstitutionPlan {
  const byToken = new Map(
    ONBOARDING_PLACEHOLDERS.map((entry) => [entry.token, entry]),
  );
  const entries: SubstitutionPlanEntry[] = [];
  const residue: SubstitutionResidueEntry[] = [];
  const unknownTokens: UnknownTokenEntry[] = [];
  for (const scan of scans) {
    for (const [token, occurrences] of scan.tokens) {
      const known = byToken.get(token);
      if (!known) {
        unknownTokens.push({ file: scan.file, token, occurrences });
        continue;
      }
      const resolved = resolution.values[known.name];
      if (!resolved) {
        residue.push({ file: scan.file, token, occurrences });
        continue;
      }
      // Site-aware escaping: a placeholder inside a JSON file sits in a
      // string field the template already quotes, so the value must be
      // JSON-escaped there (a command row containing quotes would
      // otherwise break config.json); every other site takes it raw.
      const isJsonSite = scan.file.endsWith('.json');
      entries.push({
        file: scan.file,
        placeholder: known.name,
        occurrences,
        from: token,
        to: isJsonSite
          ? escapeJsonStringContent(resolved.value)
          : resolved.value,
      });
    }
  }
  return { entries, residue, unknownTokens };
}

/**
 * Apply the plan: rewrite each planned file in a single replacement pass
 * over the placeholder-token pattern, so a token injected by one
 * substitution value is never re-substituted by a later one. Returns the
 * count of files written. `SCAN_EXCLUDED_PATHS` entries are skipped here
 * too, defense-in-depth alongside `scanPlaceholderTokens`'s own skip, in
 * case a caller ever builds a plan from a hand-rolled scan.
 */
export function applySubstitutionPlan(
  targetDir: string,
  plan: SubstitutionPlan,
): number {
  const byFile = new Map<string, Map<string, string>>();
  for (const entry of plan.entries) {
    if (SCAN_EXCLUDED_PATHS.has(entry.file)) {
      continue;
    }
    const tokens = byFile.get(entry.file) ?? new Map<string, string>();
    tokens.set(entry.from, entry.to);
    byFile.set(entry.file, tokens);
  }
  for (const [file, tokens] of byFile) {
    const absolute = resolve(targetDir, file);
    const content = readFileSync(absolute, 'utf8');
    const rewritten = content.replace(
      PLACEHOLDER_TOKEN_PATTERN,
      (token) => tokens.get(token) ?? token,
    );
    writeFileSync(absolute, rewritten);
  }
  return byFile.size;
}

// ---------------------------------------------------------------------------
// --substitute sub-step: untrusted-labeler guard-workflow generation (#2671)
// ---------------------------------------------------------------------------

/** Target-relative path (POSIX, `/`-separated) of the generated guard workflow. */
export const UNTRUSTED_LABELER_GUARD_WORKFLOW_PATH =
  '.github/workflows/strip-untrusted-labels.yml';

/**
 * Read and JSON-parse the target tree's `.github/idd/config.json`, or
 * `null` for a missing file, an unreadable path (e.g. a symlinked
 * ancestor), or unparseable JSON. Mirrors `readExistingCommandsTable`'s
 * fail-safe shape above, but returns the whole parsed document instead of
 * only its `commands` table, for the untrusted-labeler guard-workflow
 * generation step below.
 */
function readTargetPolicyConfig(targetDir: string): unknown {
  if (
    hasNonDirectoryAncestor(targetDir, '.github/idd/config.json') ||
    !fileExists(targetDir, '.github/idd/config.json')
  ) {
    return null;
  }
  const configText = readTextIfPresent(targetDir, '.github/idd/config.json');
  if (configText === null) {
    return null;
  }
  try {
    return JSON.parse(configText);
  } catch {
    return null;
  }
}

/**
 * Escape a value for embedding inside a single-quoted GitHub Actions
 * expression string literal (a literal `'` doubles, the same convention
 * YAML single-quoted scalars already use).
 *
 * Quote-doubling alone is not sufficient: a policy value containing a
 * line-break character can break out of the surrounding `if: |-` block
 * scalar and inject arbitrary top-level YAML keys (e.g. a second
 * `permissions:` block) into the generated workflow file — a real
 * privilege-escalation primitive, since `.github/idd/config.json`
 * typically receives less review scrutiny than
 * `.github/workflows/*.yml` (#2671 review). Reject any control
 * character outright rather than attempting to escape it, since GitHub
 * Actions expression strings have no escape sequence for one. Beyond
 * ASCII C0/DEL, YAML 1.1 (which several GitHub Actions YAML parsers
 * still follow) also treats NEL/C1 (`\x80`-`\x9f`) and the Unicode line
 * (U+2028) and paragraph (U+2029) separators as line breaks, so those
 * are rejected too (#2684 review).
 */
function escapeActionsExpressionStringLiteral(
  value: string,
  context: string,
): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching C0/C1/DEL to reject them
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    throw new Error(
      `${context} must not contain control characters (including newlines): ${JSON.stringify(value)}`,
    );
  }
  return value.replace(/'/g, "''");
}

/** Labels policy shape this generation step reads (`normalizePolicyConfig().labels`). */
export interface UntrustedLabelerGuardLabelsPolicy {
  roadmapLabelName: string;
  blockedByHumanLabelName: string;
  needsDecisionLabelName: string;
  untrustedLabelerLogins: readonly string[];
}

/**
 * Build the generated `strip-untrusted-labels.yml` content from a target
 * repository's own configured (or defaulted) `labels.roadmapLabelName` /
 * `labels.blockedByHumanLabelName` / `labels.needsDecisionLabelName` and
 * declared `labels.untrustedLabelerLogins` (#2671) — the same trust-model
 * shape as this repository's own hand-written workflow of the same name,
 * but with the reserved-label set and untrusted-actor logins substituted
 * from the target's own policy instead of hardcoded. Never called with an
 * empty `untrustedLabelerLogins`; the caller skips generation entirely in
 * that case (opt-in, not opt-out).
 */
export function buildUntrustedLabelerGuardWorkflowContent(
  labels: UntrustedLabelerGuardLabelsPolicy,
): string {
  const labelFields: readonly [name: string, value: string][] = [
    ['labels.roadmapLabelName', labels.roadmapLabelName],
    ['labels.blockedByHumanLabelName', labels.blockedByHumanLabelName],
    ['labels.needsDecisionLabelName', labels.needsDecisionLabelName],
  ];
  const labelCondition = labelFields
    .map(
      ([context, name]) =>
        `github.event.label.name == '${escapeActionsExpressionStringLiteral(name, context)}'`,
    )
    .join(' || ');
  const loginsJson = escapeActionsExpressionStringLiteral(
    JSON.stringify(labels.untrustedLabelerLogins),
    'labels.untrustedLabelerLogins',
  );
  return `# Generated by \`node scripts/idd-onboard.mjs --substitute\` from this
# repository's own \`.github/idd/config.json\` \`labels.*\` configuration
# (#2671). Re-running onboarding regenerates this file; edit
# \`labels.untrustedLabelerLogins\` / \`labels.roadmapLabelName\` /
# \`labels.blockedByHumanLabelName\` / \`labels.needsDecisionLabelName\`
# instead of this file directly.
#
# Trust model: this workflow triggers on \`issues: labeled\` and
# \`pull_request_target: labeled\`, which each fire once per label
# application and carry both \`label.name\` and \`sender.login\` (the actor
# who applied that specific label) in the event payload -- no extra API
# call is needed to attribute the mutation to an actor.
#   - \`pull_request_target\`, not \`pull_request\`, for the PR branch: a
#     label applied to a fork-originated PR gets an automatically
#     read-only \`GITHUB_TOKEN\` under \`pull_request\` regardless of the
#     declared \`permissions:\` block below -- the label-removal call would
#     silently 403 with no visible failure. \`pull_request_target\` grants
#     the base-repository token scopes declared below regardless of fork
#     origin. This is safe here because no repository content is ever
#     checked out (see below), so there is no PR-supplied workflow or code
#     to run with the elevated token.
#   - The job runs only when BOTH hold for this one event:
#     \`github.event.sender.login\` is one of this repository's declared
#     \`labels.untrustedLabelerLogins\`, AND \`github.event.label.name\` is
#     one of this repository's three configured reserved IDD role labels.
#   - This is fail-safe by construction against ever re-fighting a human: a
#     human re-adding the same label afterward is a *separate* \`labeled\`
#     event whose \`sender.login\` is the human, not a declared untrusted
#     labeler, so the condition above does not match and the human's
#     re-add is left untouched.
#   - No repository content is checked out (this job never runs
#     \`actions/checkout\`) and no code from the issue/PR body, comments, or
#     label metadata is executed. The job's only action is a single \`gh\`
#     call that removes one already-known label from one already-known
#     issue or pull request via the REST/GraphQL API.
#   - \`permissions:\` stays least-privilege: \`issues: write\` and
#     \`pull-requests: write\` only -- no \`contents\` or other elevated
#     scopes.
# If a future change widens the trigger, adds repository checkout, executes
# issue/PR-supplied content, or broadens \`permissions:\`, re-review this
# trust model before merging that change.
name: Strip untrusted reserved IDD labels
on:
  issues:
    types:
      - labeled
  pull_request_target:
    types:
      - labeled
permissions:
  issues: write
  pull-requests: write
concurrency:
  group: strip-untrusted-labels-\${{ github.event.issue.number || github.event.pull_request.number }}-\${{ github.event.label.name }}
  cancel-in-progress: true
jobs:
  strip-label:
    if: |-
      contains(fromJSON('${loginsJson}'), github.event.sender.login) && (${labelCondition})
    # ubuntu-latest here for maximum portability across time and
    # adopters, matching docs/customization.md's own reserved-label
    # guard recipe (#2684 review) -- ubuntu-slim is a valid alternative
    # for this single-\`gh\`-call job, but it is not a runner label every
    # adopter's account can assume is available.
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Remove reserved label applied by an untrusted labeler
        env:
          GH_TOKEN: \${{ github.token }}
          GH_ENTERPRISE_TOKEN: \${{ github.token }}
          ISSUE_NUMBER: \${{ github.event.issue.number }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          LABEL_NAME: \${{ github.event.label.name }}
        run: |
          if [ "$GITHUB_EVENT_NAME" = "pull_request_target" ]; then
            gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --remove-label "$LABEL_NAME"
          else
            gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --remove-label "$LABEL_NAME"
          fi
`;
}

/** Planning result for the untrusted-labeler guard-workflow generation step. */
export interface UntrustedLabelerGuardPlan {
  /** Target-relative path (POSIX, `/`-separated) of the generated file. */
  path: string;
  /** The resolved (or defaulted) untrusted-labeler logins driving this plan. */
  untrustedLabelerLogins: readonly string[];
  /** Generated file content, or `null` when logins are absent/empty (no-op). */
  content: string | null;
}

/**
 * Fail closed (throw, no return value to ignore) when writing `path`
 * under `targetDir` could do something other than create-or-replace a
 * plain file confined to `targetDir` (#2684 review):
 *
 * - an unsafe `path` itself (absolute, `..`-traversing, or
 *   Windows-drive-qualified) via the same `isSafeRelativePath` guard the
 *   import manifest paths already use;
 * - a symlinked (or otherwise non-directory) ancestor directory that
 *   would let the write escape `targetDir` — the same class of check
 *   `readTargetPolicyConfig` above already applies on the read side;
 * - an existing non-plain-file leaf (e.g. the destination is already a
 *   symlink).
 *
 * Called during planning (before any file in the --substitute run is
 * written) so a rejection aborts the whole run with no partial write,
 * and again immediately before the write itself as a TOCTOU-narrowing
 * belt-and-suspenders check for any other caller of
 * `applyUntrustedLabelerGuardPlan`.
 */
function assertSafeGuardWorkflowDestination(
  targetDir: string,
  path: string,
): void {
  if (!isSafeRelativePath(path)) {
    throw new Error(`refusing to write an unsafe path: ${path}`);
  }
  assertSafePlainFileDestination(targetDir, path);
}

/**
 * Whether `error` (from a caught `fs` call) is exactly Node's "no such
 * file or directory" errno -- the only failure that legitimately means
 * "this path doesn't exist yet," as opposed to `EACCES`/`EPERM` (exists,
 * but this process can't read it) or another I/O error. A caller
 * conflating any of those with "absent" can silently treat a real,
 * unreadable file as safe to overwrite (#3292 review, Copilot).
 */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Fail closed (throw) unless `relativePath` (already confirmed safe and
 * `targetDir`-relative by the caller — this does not itself run
 * {@link isSafeRelativePath}) has no symlinked or otherwise
 * non-directory ancestor under `targetDir`, and its leaf is either
 * absent or a plain file. Generalized out of
 * {@link assertSafeGuardWorkflowDestination} (#3292) so the
 * `--write-policy-doc` destination guard and the `.github/idd/config.json`
 * write guard share the same ancestor/leaf check instead of each writing
 * their own. A non-`ENOENT` `lstatSync` failure (for example `EACCES` on
 * the leaf itself) is never treated as "absent" -- it fails closed with
 * its own error instead, rather than silently letting an unreadable
 * existing entry through as if nothing were there (#3292 review,
 * Copilot).
 */
function assertSafePlainFileDestination(
  targetDir: string,
  relativePath: string,
): void {
  if (hasNonDirectoryAncestor(targetDir, relativePath)) {
    throw new Error(
      `refusing to write ${relativePath}: a non-directory (e.g. a symlink) sits on its path under ${targetDir}`,
    );
  }
  const absolute = resolve(targetDir, relativePath);
  let leafStat: ReturnType<typeof lstatSync> | null;
  try {
    leafStat = lstatSync(absolute);
  } catch (error) {
    if (!isEnoent(error)) {
      throw new Error(
        `refusing to write ${relativePath}: could not stat the destination under ${targetDir} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    leafStat = null;
  }
  if (leafStat !== null && !leafStat.isFile()) {
    throw new Error(
      `refusing to write ${relativePath}: an existing non-plain-file entry (e.g. a symlink) already occupies that path under ${targetDir}`,
    );
  }
}

/**
 * Plan the untrusted-labeler guard-workflow generation step (#2671) for a
 * target tree, reading its own `.github/idd/config.json` `labels.*`
 * configuration. `content` is `null` — a deliberate no-op, not an error —
 * when `labels.untrustedLabelerLogins` is absent or empty (opt-in, not
 * opt-out). Read-only; see `applyUntrustedLabelerGuardPlan` for the write
 * step. When `content` will be non-`null`, also validates the write
 * destination via `assertSafeGuardWorkflowDestination` here — before
 * `runCli`'s --substitute branch writes anything else — so an unsafe
 * destination aborts the whole run before `applySubstitutionPlan` has
 * written any placeholder substitution, rather than surfacing only once
 * the guard write itself runs after that other write already landed
 * (#2684 review).
 */
export function planUntrustedLabelerGuardWorkflow(
  targetDir: string,
): UntrustedLabelerGuardPlan {
  const { labels } = normalizePolicyConfig(readTargetPolicyConfig(targetDir));
  const path = UNTRUSTED_LABELER_GUARD_WORKFLOW_PATH;
  if (labels.untrustedLabelerLogins.length === 0) {
    return {
      path,
      untrustedLabelerLogins: labels.untrustedLabelerLogins,
      content: null,
    };
  }
  assertSafeGuardWorkflowDestination(targetDir, path);
  return {
    path,
    untrustedLabelerLogins: labels.untrustedLabelerLogins,
    content: buildUntrustedLabelerGuardWorkflowContent(labels),
  };
}

/**
 * Write a non-`null` `plan.content` to `plan.path` under `targetDir`,
 * creating parent directories as needed. Returns whether a write
 * happened — `false` for the `content: null` no-op plan or when the
 * existing file already holds byte-identical content (a genuine
 * idempotent no-op, not an error), never an error otherwise. Idempotent:
 * re-running with an unchanged plan reproduces the same file content
 * without reporting a spurious write — automation consuming this return
 * value (or the CLI verdict's `written` field) to decide whether to
 * commit would otherwise attempt an empty commit on every unchanged
 * rerun (#2684 review). Re-validates the write destination via
 * `assertSafeGuardWorkflowDestination` immediately before writing —
 * `planUntrustedLabelerGuardWorkflow` above already validates it once at
 * plan time, but this call stays the authoritative, load-bearing check
 * for any other caller that constructs a plan by hand.
 */
export function applyUntrustedLabelerGuardPlan(
  targetDir: string,
  plan: UntrustedLabelerGuardPlan,
): boolean {
  if (plan.content === null) {
    return false;
  }
  assertSafeGuardWorkflowDestination(targetDir, plan.path);
  const absolute = resolve(targetDir, plan.path);
  if (readTextIfPresent(targetDir, plan.path) === plan.content) {
    return false;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, plan.content);
  return true;
}

// ---------------------------------------------------------------------------
// Wave 2: --import (manifest-driven fetch/copy)
// ---------------------------------------------------------------------------

/** One file the import stage copies: paths are relative to their root. */
export interface ManifestFile {
  /** Path relative to the `--source` idd-skill tree. */
  sourcePath: string;
  /** Path relative to the `--target` repository. */
  targetPath: string;
}

const CORE_TEMPLATE_BLOCK_ID = 'idd-template-core-files';

interface SyncManifestGeneratedBlock {
  id: string;
  paths?: string[];
  stripPrefix?: string;
}

interface SyncManifest {
  generatedBlocks?: SyncManifestGeneratedBlock[];
}

/**
 * Resolve the distributed core template file set from the same
 * `audit/sync-manifest.json` canonical source that `sync-docs.mjs` /
 * `audit-docs.mjs` render into `idd-template/ONBOARDING.md`'s Step 2
 * `idd-template-core-files` block, so this CLI never carries a second,
 * independently hardcoded file list. `sourcePath` is relative to
 * `sourceRoot` (the manifest's recorded paths already carry the
 * `idd-template/` prefix); `targetPath` has `stripPrefix` removed, landing
 * at the same relative path the generated ONBOARDING.md list documents.
 * Throws when `sourceRoot` has no readable manifest or no block with a
 * `paths` list — that tree is not a usable idd-skill source root.
 */
export function resolveCoreTemplateFiles(sourceRoot: string): ManifestFile[] {
  const manifestPath = join(sourceRoot, 'audit', 'sync-manifest.json');
  let manifest: SyncManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SyncManifest;
  } catch (error) {
    throw new Error(
      `--source is not a readable idd-skill tree (missing or invalid audit/sync-manifest.json): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // `manifest` is only type-asserted, not runtime-validated, so a corrupted
  // manifest can carry a `generatedBlocks` / `paths` / `stripPrefix` of the
  // wrong shape. Validate every level before using it as an array/string —
  // otherwise a malformed manifest throws a raw, unhelpful TypeError
  // (`.find is not a function`, `.map is not a function`) instead of the
  // actionable error this function otherwise gives for a missing block.
  const rawBlocks = manifest.generatedBlocks;
  if (!Array.isArray(rawBlocks)) {
    throw new Error(
      "--source's audit/sync-manifest.json has a malformed generatedBlocks (expected an array)",
    );
  }
  const block = rawBlocks.find((entry) => entry?.id === CORE_TEMPLATE_BLOCK_ID);
  if (
    !block ||
    !Array.isArray(block.paths) ||
    !block.paths.every((entry) => typeof entry === 'string') ||
    (block.stripPrefix !== undefined && typeof block.stripPrefix !== 'string')
  ) {
    throw new Error(
      `--source's audit/sync-manifest.json has no "${CORE_TEMPLATE_BLOCK_ID}" generated block with a valid paths: string[] (and stripPrefix?: string)`,
    );
  }
  const prefix = block.stripPrefix ?? '';
  return block.paths.map((sourcePath) => {
    if (prefix && !sourcePath.startsWith(prefix)) {
      throw new Error(
        `${CORE_TEMPLATE_BLOCK_ID}: manifest path "${sourcePath}" does not start with its stripPrefix "${prefix}"`,
      );
    }
    return assertSafeManifestFile(
      { sourcePath, targetPath: sourcePath.slice(prefix.length) },
      CORE_TEMPLATE_BLOCK_ID,
    );
  });
}

/**
 * Whether `relativePath` is safe to join onto a root directory: no
 * absolute-path form, no parent-traversal (`..`) or empty segment, and no
 * backslash (which `path.join` treats as a separator on Windows even
 * though every path in this module is `/`-normalized). Defense-in-depth
 * against a corrupted or hostile manifest / helper bundle escaping the
 * intended `--source` / `--target` root through `join()`.
 */
function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\\')) {
    return false;
  }
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    return false;
  }
  return relativePath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Whether `candidate` is `boundary` itself or nested under it. */
function isWithinBoundary(candidate: string, boundary: string): boolean {
  const rel = relative(boundary, candidate);
  // Only an exact ".." segment or a "../"-prefixed path climbs out of
  // `boundary` -- `rel.startsWith('..')` alone is too broad: a real child
  // directory literally named e.g. "..foo" also produces a relative()
  // string starting with "..", which is not a traversal at all (#2357
  // review).
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Resolve `raw` (a `--source` / `--target` / `--allow-root` value) to an
 * existing directory, confined to the current working directory or one of
 * `allowedRoots` (#2216). `idd-onboard` is designed for unattended
 * dispatch, not only an interactive human operator typing the value
 * first -- an unconfined root lets the process read from or write to any
 * path it can reach. Confinement is in addition to, not a replacement
 * for, `isSafeRelativePath`'s existing per-manifest-entry traversal
 * protection below the resolved root.
 *
 * Confinement compares REALPATHs (symlinks resolved), not the raw
 * `resolve()`d path, so a symlink that points outside every boundary is
 * caught even when the symlink's own location is nested inside one.
 * The returned path is the plain `resolve()`d value (unchanged from
 * pre-#2216 behavior) -- only the confinement check itself resolves
 * symlinks.
 */
export function resolveConfinedDirectory(
  raw: string,
  flagName: string,
  allowedRoots: string[],
): string {
  const resolved = resolve(raw);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${flagName} is not a directory: ${raw}`);
  }
  const realResolved = realpathSync(resolved);
  const boundaries = [process.cwd(), ...allowedRoots].map((root) => {
    try {
      return realpathSync(resolve(root));
    } catch {
      throw new Error(`--allow-root does not exist: ${root}`);
    }
  });
  if (
    !boundaries.some((boundary) => isWithinBoundary(realResolved, boundary))
  ) {
    throw new Error(
      `${flagName} resolves outside the confined root(s) (${boundaries.join(', ')}): ${raw} -> ${realResolved}. Pass --allow-root <path> to widen the confined root.`,
    );
  }
  return resolved;
}

/**
 * Validate both sides of a manifest file entry with `isSafeRelativePath`
 * and return it unchanged, or throw a hard, fail-closed error naming
 * `origin` (the manifest source this entry came from). A path-safety
 * violation is manifest corruption, not an ordinary missing/blocked file,
 * so it is reported the same way as the other manifest-integrity checks
 * in this module (stripPrefix mismatch, duplicate target path): a thrown
 * usage/config error, never a soft `missingSource` / blocking-plan entry.
 */
function assertSafeManifestFile(
  file: ManifestFile,
  origin: string,
): ManifestFile {
  if (
    !isSafeRelativePath(file.sourcePath) ||
    !isSafeRelativePath(file.targetPath)
  ) {
    throw new Error(
      `${origin}: unsafe manifest path (absolute or parent-traversal segment): source="${file.sourcePath}" target="${file.targetPath}"`,
    );
  }
  return file;
}

/** Result of resolving the import file set: files plus any unresolved paths. */
export interface ResolvedImportFiles {
  files: ManifestFile[];
  /**
   * Declared or expected source paths that could not be resolved (e.g. a
   * missing helper file interrupted the vendored-node bundle walk).
   * Blocking, same as `ImportPlan.missingSource`.
   */
  missingSource: string[];
}

/**
 * Resolve the full import file set: the core template files, plus — only
 * when `profile` is exactly `vendored-node` — the profile-conditional
 * helper bundle from `helper-runtime-manifest.mts`'s `collectVendoredFiles`
 * (mirroring ONBOARDING Step 2's profile guidance). Every other known
 * profile name vends zero extra files, matching its own `managedFiles: []`
 * catalog entry. `profile` is validated against the same `PROFILE_NAMES`
 * the helper manifest CLI itself validates against — no second hardcoded
 * profile-name list.
 */
export function resolveImportFiles(
  sourceRoot: string,
  profile?: string,
): ResolvedImportFiles {
  const coreFiles = resolveCoreTemplateFiles(sourceRoot);
  if (!profile) {
    return { files: coreFiles, missingSource: [] };
  }
  if (!PROFILE_NAMES.includes(profile)) {
    throw new Error(
      `unknown --profile: ${profile} (expected one of ${PROFILE_NAMES.join(', ')})`,
    );
  }
  if (profile !== 'vendored-node') {
    return { files: coreFiles, missingSource: [] };
  }
  let vendoredFiles: { sourcePath: string; targetPath: string }[];
  try {
    vendoredFiles = collectVendoredFiles(sourceRoot);
  } catch (error) {
    // collectVendoredFiles reads each helper entry's content to walk its
    // import graph, so a missing helper file under an incomplete or
    // version-skewed --source tree throws a raw fs error (ENOENT) instead
    // of the missingSource reporting the core file set uses. Degrade to
    // the core file set alone and surface the specific unreadable path
    // (when the error exposes one) as a blocking finding, rather than
    // letting the raw exception crash the CLI with a bare exit 2.
    return {
      files: coreFiles,
      missingSource: [describeUnresolvedVendoredPath(sourceRoot, error)],
    };
  }
  // Outside the try/catch above: a path-safety violation is manifest
  // corruption, not a missing file, so it must hard-fail (propagate as a
  // thrown usage/config error) rather than being absorbed as a
  // missingSource finding the same way a genuinely absent file is.
  const helperFiles = vendoredFiles.map((file) =>
    assertSafeManifestFile(
      { sourcePath: file.sourcePath, targetPath: file.targetPath },
      'vendored-node helper bundle',
    ),
  );
  const merged = [...coreFiles, ...helperFiles];
  const seenTargets = new Set<string>();
  for (const file of merged) {
    if (seenTargets.has(file.targetPath)) {
      throw new Error(
        `manifest drift: duplicate target path "${file.targetPath}" across the core file set and the profile-conditional bundle`,
      );
    }
    seenTargets.add(file.targetPath);
  }
  return { files: merged, missingSource: [] };
}

/**
 * Best-effort description of the source path that broke the vendored-node
 * bundle walk, derived from the failing fs error's `path` property. Falls
 * back to a generic label when the error does not expose one so a caller
 * always has a non-empty `missingSource` entry to report.
 */
function describeUnresolvedVendoredPath(
  sourceRoot: string,
  error: unknown,
): string {
  const path = (error as { path?: unknown } | null | undefined)?.path;
  if (typeof path === 'string') {
    return relative(sourceRoot, path).replaceAll('\\', '/');
  }
  return 'vendored-node helper bundle (unresolvable: unreadable helper source)';
}

/** How one planned import file relates to the current target tree. */
export type ImportClassification =
  | 'new'
  | 'unchanged'
  | 'overwrite'
  | 'blocked-non-file'
  | 'held';

/** One planned copy: a manifest file plus its target-tree classification. */
export interface ImportPlanEntry extends ManifestFile {
  classification: ImportClassification;
}

/** The full dry-run/apply plan for one `--import` invocation. */
export interface ImportPlan {
  entries: ImportPlanEntry[];
  /** Declared source files missing under `--source`. Blocking. */
  missingSource: string[];
  /**
   * Existing target files whose content differs from source, without
   * `--force`. Blocking.
   */
  blockedOverwrites: string[];
  /**
   * Target paths that already exist but are not a regular file (e.g. a
   * directory). These can never be copied onto, so they are always
   * blocking — `--force` does not override this, since it only means
   * "allow overwriting a differing file", not "remove whatever is
   * already there". Entries are classified `blocked-non-file`.
   */
  nonFileTargetCollisions: string[];
  /**
   * Manifest target paths excluded from this import by `--hold`
   * (repeatable), in manifest-resolution order (not argv order). Never
   * blocking — a held entry is a deliberate, caller-requested skip, not
   * a failure. Still listed as a `held` plan entry (see
   * {@link ImportClassification}), so `--dry-run` shows it as skipped
   * rather than silently omitting it from the plan.
   */
  heldTargets: string[];
}

/**
 * Build the import plan: classify each manifest file as `new` (no target
 * path yet), `unchanged` (target already matches byte-for-byte — a safe
 * no-op), `overwrite` (target exists as a file and differs),
 * `blocked-non-file` (target path exists but is not a regular file, e.g. a
 * directory — always blocking, see `nonFileTargetCollisions`), or `held`
 * (excluded by `--hold`; see below) — matching {@link ImportClassification}'s
 * own declaration order. An `overwrite` entry is also recorded in
 * `blockedOverwrites` unless `force` is set — the fail-closed default
 * refuses to clobber a differing target file. A missing declared source
 * file is recorded in `missingSource` instead of a plan entry.
 *
 * `hold` (repeatable) names manifest **target** paths — the same
 * `targetPath` this function's own entries and `--dry-run`'s plan output
 * report, matched by exact string equality (no `./`-prefix or
 * trailing-slash normalization) — to exclude from this import while
 * still importing every other resolved entry. A held entry is
 * classified `held` and skips every existence/content check above
 * (source-missing, overwrite, non-file collision) entirely, since it is
 * never read from `--source` or written to `--target` — `--force` has
 * no effect on it either way. A `hold` value that does not match any
 * path in the resolved manifest (for the given `profile`) is a usage
 * error, fail-closed: it throws rather than silently matching nothing,
 * since a stale or misspelled `--hold` value would otherwise import
 * every file, including the one the caller meant to keep local.
 *
 * That unknown-path check is skipped when `resolved.missingSource` is
 * already non-empty — the `profile: 'vendored-node'` helper-bundle walk
 * failed against an incomplete `--source` tree, so `resolved.files` is
 * itself a degraded (core-files-only) view, not the true resolved
 * manifest. Validating `--hold` against that degraded view would throw
 * a misleading "unknown --hold" usage error that masks the real
 * problem; `missingSource`'s own blocking finding is the correct signal
 * there instead, and a `--hold` value simply matches nothing beyond the
 * degraded set in that case.
 */
export function buildImportPlan(
  sourceRoot: string,
  targetRoot: string,
  {
    profile,
    force = false,
    hold = [],
  }: { profile?: string; force?: boolean; hold?: string[] } = {},
): ImportPlan {
  const resolved = resolveImportFiles(sourceRoot, profile);
  const holdSet = new Set(hold);
  if (holdSet.size > 0 && resolved.missingSource.length === 0) {
    const knownTargets = new Set(resolved.files.map((file) => file.targetPath));
    const unknown = [...holdSet].filter((target) => !knownTargets.has(target));
    if (unknown.length > 0) {
      throw new Error(
        `unknown --hold path(s), not present in the resolved manifest for this --profile: ${unknown.join(', ')}`,
      );
    }
  }
  const entries: ImportPlanEntry[] = [];
  const missingSource: string[] = [...resolved.missingSource];
  const blockedOverwrites: string[] = [];
  const nonFileTargetCollisions: string[] = [];
  const heldTargets: string[] = [];
  for (const file of resolved.files) {
    if (holdSet.has(file.targetPath)) {
      entries.push({ ...file, classification: 'held' });
      heldTargets.push(file.targetPath);
      continue;
    }
    if (!fileExists(sourceRoot, file.sourcePath)) {
      missingSource.push(file.sourcePath);
      continue;
    }
    // Check the ancestor chain unconditionally, before the leaf-existence
    // check below. A symlinked ancestor directory can resolve straight to
    // a real, already-existing leaf file (fileExists on the joined path
    // follows every ancestor segment, symlinked or not, the same way a
    // plain stat/lstat would) — checking hasNonDirectoryAncestor only
    // inside the "leaf does not exist" branch would then never run,
    // letting applyImportPlan read/write straight through the symlinked
    // ancestor and escape --target.
    if (hasNonDirectoryAncestor(targetRoot, file.targetPath)) {
      entries.push({ ...file, classification: 'blocked-non-file' });
      nonFileTargetCollisions.push(file.targetPath);
      continue;
    }
    if (!fileExists(targetRoot, file.targetPath)) {
      if (pathExists(targetRoot, file.targetPath)) {
        // The target path itself exists but is not a regular file (e.g. a
        // directory or a symlink). Treating this as "new" would make
        // applyImportPlan's copyFileSync throw EISDIR/ENOTDIR, possibly
        // after already writing earlier entries — fail closed instead.
        entries.push({ ...file, classification: 'blocked-non-file' });
        nonFileTargetCollisions.push(file.targetPath);
        continue;
      }
      entries.push({ ...file, classification: 'new' });
      continue;
    }
    const sourceBytes = readFileSync(join(sourceRoot, file.sourcePath));
    const targetBytes = readFileSync(join(targetRoot, file.targetPath));
    if (sourceBytes.equals(targetBytes)) {
      entries.push({ ...file, classification: 'unchanged' });
      continue;
    }
    entries.push({ ...file, classification: 'overwrite' });
    if (!force) {
      blockedOverwrites.push(file.targetPath);
    }
  }
  return {
    entries,
    missingSource,
    blockedOverwrites,
    nonFileTargetCollisions,
    heldTargets,
  };
}

/**
 * Apply the plan: copy every `new` or `overwrite` entry (skipping
 * `unchanged` entries, which already match; `blocked-non-file` entries,
 * which can never be copied onto; and `held` entries, which `--hold`
 * deliberately excluded from this import), creating parent directories
 * as needed. Preserves the source file's permission bits — a plain byte
 * copy would otherwise silently drop the executable bit that
 * `.githooks/pre-commit` / `.githooks/pre-push` require. Returns the count
 * of files written. Callers must gate on `missingSource` /
 * `blockedOverwrites` / `nonFileTargetCollisions` themselves; this
 * function copies whatever the plan contains without re-checking blocking
 * conditions (except that it never attempts the impossible
 * `blocked-non-file` copy, regardless of caller gating).
 */
export function applyImportPlan(
  sourceRoot: string,
  targetRoot: string,
  plan: ImportPlan,
): number {
  let filesChanged = 0;
  for (const entry of plan.entries) {
    if (
      entry.classification === 'unchanged' ||
      entry.classification === 'blocked-non-file' ||
      entry.classification === 'held'
    ) {
      continue;
    }
    const sourceAbsolute = join(sourceRoot, entry.sourcePath);
    const targetAbsolute = join(targetRoot, entry.targetPath);
    mkdirSync(dirname(targetAbsolute), { recursive: true });
    copyFileSync(sourceAbsolute, targetAbsolute);
    chmodSync(targetAbsolute, statSync(sourceAbsolute).mode);
    filesChanged += 1;
  }
  return filesChanged;
}

// ---------------------------------------------------------------------------
// Wave 3: --verify (post-import verification, reusing doctor drift checks)
// ---------------------------------------------------------------------------

/** Manifest-completeness result: declared files missing from either side. */
export interface ManifestCompletenessResult {
  /**
   * Declared source paths missing under `--source` — a corrupt or
   * incomplete idd-skill source tree, not a target-side gap. Mirrors
   * `ImportPlan.missingSource`.
   */
  missingSource: string[];
  /**
   * Manifest target paths declared for `--source` / `--profile` that are
   * absent under `--target` — the post-import completeness gap this check
   * exists to catch.
   */
  missingTarget: string[];
}

/**
 * Check that every file the manifest declares for `profile` exists on both
 * sides, reusing wave 2's own `resolveImportFiles` resolution (the same
 * source `--import` copies from) instead of a second hardcoded file list.
 *
 * `resolveImportFiles`'s own `missingSource` only ever reports a
 * vendored-node bundle resolution failure (see `resolveImportFiles`'s doc
 * comment) — it does not check the core/profile file set's declared
 * `sourcePath` entries against `sourceRoot`, unlike `buildImportPlan`, which
 * performs that `fileExists(sourceRoot, file.sourcePath)` check itself. This
 * check mirrors that same existence check here so a corrupt or incomplete
 * `--source` tree is caught, not just a target that failed to receive a
 * file `--import` did manage to copy from a complete source.
 */
export function checkManifestCompleteness(
  sourceRoot: string,
  targetRoot: string,
  profile?: string,
): ManifestCompletenessResult {
  const resolved = resolveImportFiles(sourceRoot, profile);
  const missingSource = [
    ...resolved.missingSource,
    ...resolved.files
      .filter((file) => !fileExists(sourceRoot, file.sourcePath))
      .map((file) => file.sourcePath),
  ];
  const missingTarget = resolved.files
    .filter((file) => !fileExists(targetRoot, file.targetPath))
    .map((file) => file.targetPath);
  return { missingSource, missingTarget };
}

/**
 * The set of target-relative paths the placeholder scanner treats as
 * in-scope (#3291): exactly the imported manifest's own target paths,
 * minus `SCAN_EXCLUDED_PATHS`. Built from `resolveImportFiles`'s already-
 * resolved file list -- callers do that I/O and pass `.files` in, so this
 * stays a pure set-builder with no filesystem access of its own. The
 * `SCAN_EXCLUDED_PATHS` subtraction lives here (not left to each caller)
 * because several of its entries -- the `docs/onboarding/*.md` meta-docs
 * -- ARE part of the core manifest, so omitting the subtraction here
 * would silently widen scope back to files the scanner must still never
 * read for substitution purposes.
 */
export function resolvePlaceholderScanScope(
  files: readonly ManifestFile[],
): ReadonlySet<string> {
  const scope = new Set<string>();
  for (const file of files) {
    if (!SCAN_EXCLUDED_PATHS.has(file.targetPath)) {
      scope.add(file.targetPath);
    }
  }
  return scope;
}

/** A scan's tokens partitioned by whether its file is in `scope`. */
export interface ScopedPlaceholderScans {
  /** Scans whose file is in scope -- feed these into `buildSubstitutionPlan`. */
  inScope: PlaceholderFileScan[];
  /**
   * Every token occurrence (known onboarding placeholder or not) found in
   * a file OUTSIDE `scope` -- informational only, never contributes to a
   * `SubstitutionPlan`'s `entries`/`residue`/`unknownTokens` (#3291): an
   * adopter-owned file `--import` never copied is not this scanner's to
   * rewrite or to flag as blocking residue, even when it happens to
   * contain a `{{ONBOARDING_TOKEN}}`-shaped string of its own.
   */
  outOfScopeTokens: UnknownTokenEntry[];
}

/**
 * Split `scans` into the files `scope` covers and everything else,
 * flattening every out-of-scope file's tokens into `outOfScopeTokens`
 * (#3291). `scanPlaceholderTokens`/`buildSubstitutionPlan` keep scanning
 * and planning exactly as before -- this is a thin pre-filter in front of
 * them, not a change to either, so no existing direct caller of either
 * function is affected.
 */
export function partitionScansByScope(
  scans: readonly PlaceholderFileScan[],
  scope: ReadonlySet<string>,
): ScopedPlaceholderScans {
  const inScope: PlaceholderFileScan[] = [];
  const outOfScopeTokens: UnknownTokenEntry[] = [];
  for (const scan of scans) {
    if (scope.has(scan.file)) {
      inScope.push(scan);
      continue;
    }
    for (const [token, occurrences] of scan.tokens) {
      outOfScopeTokens.push({ file: scan.file, token, occurrences });
    }
  }
  return { inScope, outOfScopeTokens };
}

/**
 * Placeholder-residue result: blocking residue plus informational tokens
 * (`unknownTokens` for an in-scope file's non-onboarding `{{...}}` token,
 * `outOfScopeTokens` for ANY `{{...}}` token -- known or not -- found
 * outside the imported file set; #3291).
 */
export interface PlaceholderResidueResult {
  residue: SubstitutionResidueEntry[];
  unknownTokens: UnknownTokenEntry[];
  outOfScopeTokens: UnknownTokenEntry[];
}

/**
 * Scan the target tree for leftover `{{...}}` tokens after onboarding,
 * scoped to `scope` (#3291: the imported manifest's own target paths --
 * see `resolvePlaceholderScanScope`). Reuses wave 1's
 * `scanPlaceholderTokens` / `buildSubstitutionPlan` scanner rather than a
 * new scan: verify mode has no resolved substitution values to consult
 * (an empty resolution), so `buildSubstitutionPlan` puts every occurrence
 * of one of the seven onboarding placeholder tokens found in an IN-SCOPE
 * file into `residue` -- the correct outcome here, since a converged
 * onboarding run should have already replaced them. An in-scope file's
 * other `{{...}}`-shaped tokens land in `unknownTokens`; ANY token found
 * outside `scope` lands in `outOfScopeTokens` instead, informational only
 * and never blocking, matching `--substitute`'s own scope contract.
 */
export function checkPlaceholderResidue(
  targetRoot: string,
  scope: ReadonlySet<string>,
): PlaceholderResidueResult {
  const { inScope, outOfScopeTokens } = partitionScansByScope(
    scanPlaceholderTokens(targetRoot),
    scope,
  );
  const plan = buildSubstitutionPlan(inScope, {
    values: {},
    unresolved: [],
  });
  return {
    residue: plan.residue,
    unknownTokens: plan.unknownTokens,
    outOfScopeTokens,
  };
}

// ---------------------------------------------------------------------------
// Wave 3 --verify: helper-load check (#3238)
// ---------------------------------------------------------------------------

/** One cataloged helper that failed to start under `--target`. */
export interface HelperLoadFailure {
  id: string;
  entryPath: string;
  reason: string;
}

/** Helper-load result: blocking failures for one target tree. */
export interface HelperLoadResult {
  /** True only for `--profile vendored-node`; every other profile (or no
   * profile) vends no helper files, so this check has nothing to probe. */
  applicable: boolean;
  /** entryPaths this check actually spawned; empty when `applicable` is
   * false, or when every cataloged entryPath is absent under `--target`
   * (already `manifestCompleteness.missingTarget`'s own finding). An
   * entryPath that resolves outside `--target` through a symlinked
   * ancestor is also excluded here -- it is never spawned, and reported
   * in `failed` instead. */
  probed: string[];
  failed: HelperLoadFailure[];
}

/** Per-helper `--help` timeout: generous relative to the ~60ms/helper the
 * full 50-helper sweep took in the issue's own reproduction, so only a
 * genuine hang trips it, not ordinary process-startup variance. */
const HELPER_LOAD_TIMEOUT_MS = 15_000;

/** `HELPER_COMMANDS` id of the one cataloged helper that is an
 * interactive-only wizard: it rejects non-TTY stdin with its exported
 * `NON_TTY_ERROR` before parsing any argument (including `--help`), in the
 * source repository too, so its expected "loaded successfully" outcome is
 * exit 1 with that message on stderr, never exit 0 with stdout. */
const FORCE_HANDOFF_HELPER_ID = 'force-handoff';

/**
 * Whether `targetRoot`/`entryPath`'s REALPATH (symlinks resolved) still
 * resolves inside `targetRoot`'s own realpath. `fileExists`'s `lstatSync`
 * only protects the leaf path component -- a symlinked ANCESTOR directory
 * (for example `targetRoot/scripts` itself) is still followed during
 * ordinary path resolution, so a real file reached only through such a
 * symlink would otherwise be spawned from outside the confined `--target`
 * root (Copilot review, PR #3303). Mirrors `resolveConfinedDirectory`'s
 * own realpath-boundary check (`isWithinBoundary`), reused here for one
 * helper entry instead of the whole `--target` root. Fails closed
 * (`false`) on any `realpathSync` error, e.g. a dangling symlink.
 */
function isHelperEntryConfined(targetRoot: string, entryPath: string): boolean {
  try {
    const realTarget = realpathSync(targetRoot);
    const realEntry = realpathSync(resolve(targetRoot, entryPath));
    return isWithinBoundary(realEntry, realTarget);
  } catch {
    return false;
  }
}

/** Spawn one cataloged helper's `entryPath` under `targetRoot` with
 * `--help`, working directory `targetRoot`, stdin ignored (so a
 * TTY-sensitive helper like `force-handoff` observes a non-TTY stdin the
 * same way a real onboarding session's non-interactive shell would). */
function spawnHelperHelp(
  targetRoot: string,
  entryPath: string,
): {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** `true` only when `node:child_process` itself reports this exact
   * spawn's own `timeout` option fired (`error.code === 'ETIMEDOUT'`) --
   * never inferred from `signal` alone, since an unrelated external
   * signal (for example an OS OOM-killer `SIGKILL`) would also leave
   * `signal` non-null without this spawn's timeout ever having elapsed. */
  timedOut: boolean;
} {
  const result = spawnSync(
    process.execPath,
    [resolve(targetRoot, entryPath), '--help'],
    {
      cwd: targetRoot,
      encoding: 'utf8',
      timeout: HELPER_LOAD_TIMEOUT_MS,
      // node:child_process's `timeout` option only *sends* `killSignal`
      // once the deadline elapses -- it is not itself a hard deadline.
      // The default killSignal is SIGTERM, which a cataloged helper (or
      // one of its imports) can install its own handler for and ignore,
      // leaving this synchronous call blocked indefinitely despite the
      // configured timeout (Copilot review, PR #3303). --verify executes
      // target-owned code, so this check cannot assume every helper
      // cooperates with SIGTERM the way this repository's own helpers do
      // -- force termination instead.
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

/** Describe why one probe did not match its expected outcome, for
 * `HelperLoadFailure.reason`. */
function describeHelperLoadFailure(probe: {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): string {
  if (probe.timedOut) {
    return `timed out after ${HELPER_LOAD_TIMEOUT_MS}ms (signal ${String(probe.signal)})`;
  }
  if (probe.signal !== null) {
    return `killed by signal ${probe.signal}`;
  }
  const stderrSnippet = probe.stderr.trim().split('\n')[0] ?? '';
  return `exited ${String(probe.status)}${stderrSnippet ? `: ${stderrSnippet}` : ' with no stderr'}`;
}

/**
 * For `--profile vendored-node`, spawn every cataloged helper's
 * `entryPath` under `targetRoot` with `--help` and report any that fail
 * to load (#3238: many vendored helpers cannot even print `--help` in a
 * target with no `package.json` before the `bundle-root.mts` fix this
 * issue also lands). `--verify` reports a clean `manifestCompleteness`
 * while the helpers cannot start is the exact gap this check exists to
 * close.
 *
 * Reads the catalog from `helper-runtime-manifest.mts`'s
 * `buildCommandCatalog` (a pure map over the static `HELPER_COMMANDS`
 * table, not a filesystem walk) rather than `collectVendoredFiles`, since
 * only the cataloged top-level entry points are spawned here, not every
 * file their import graphs transitively touch.
 *
 * Skips (never probes, never fails) an entryPath absent under
 * `targetRoot` — that is `checkManifestCompleteness`'s own
 * `missingTarget` finding; probing a file that does not exist would only
 * duplicate it under a different name. An entryPath present under
 * `targetRoot` only through a symlinked ancestor directory is a blocking
 * failure instead (`isHelperEntryConfined`), never spawned: `fileExists`'s
 * leaf-only `lstatSync` cannot by itself prove the resolved path stays
 * inside `--target`.
 */
export function checkHelperLoad(
  targetRoot: string,
  profile?: string,
): HelperLoadResult {
  if (profile !== 'vendored-node') {
    return { applicable: false, probed: [], failed: [] };
  }
  const probed: string[] = [];
  const failed: HelperLoadFailure[] = [];
  for (const command of buildCommandCatalog()) {
    if (!fileExists(targetRoot, command.entryPath)) {
      continue;
    }
    if (!isHelperEntryConfined(targetRoot, command.entryPath)) {
      failed.push({
        id: command.id,
        entryPath: command.entryPath,
        reason:
          'resolves outside --target through a symlinked ancestor directory; refusing to spawn it',
      });
      continue;
    }
    probed.push(command.entryPath);
    const probe = spawnHelperHelp(targetRoot, command.entryPath);
    const loaded =
      command.id === FORCE_HANDOFF_HELPER_ID
        ? probe.status === 1 && probe.stderr.includes(NON_TTY_ERROR)
        : probe.status === 0 && probe.stdout.trim() !== '';
    if (!loaded) {
      failed.push({
        id: command.id,
        entryPath: command.entryPath,
        reason: describeHelperLoadFailure(probe),
      });
    }
  }
  return { applicable: true, probed, failed };
}

/** Stale-import-signal result: informational drift findings, never blocking. */
export interface StaleImportSignalResult {
  missing: string[];
}

/**
 * Re-run idd-doctor's content-based stale-import detector
 * (`findMissingWorktreeHardening`) against the target tree's imported
 * files, instead of forking its logic — the same #1208 shared-module
 * convention `check-pnpm-boundary.mts` already uses for
 * `parseProjectCommandRows`. Matches `checkWorktreeHardeningPresence`'s own
 * severity in idd-doctor: these are warning-level drift signals, not
 * blocking findings, so a target that is merely behind on the latest
 * hardening guidance does not fail verify on its own.
 */
export function checkStaleImportSignal(
  targetRoot: string,
): StaleImportSignalResult {
  const missing = findMissingWorktreeHardening({
    work: readTextIfPresent(
      targetRoot,
      '.github/instructions/idd-work.instructions.md',
    ),
    core: readTextIfPresent(
      targetRoot,
      '.github/instructions/idd-overview-core.instructions.md',
    ),
    doctor: readTextIfPresent(targetRoot, 'scripts/idd-doctor.mjs'),
  });
  return { missing };
}

// ---------------------------------------------------------------------------
// Wave 3 --verify: package-pin advisory (#2987)
// ---------------------------------------------------------------------------

/**
 * `helperRuntime.profile` values whose helper commands resolve a package
 * spec (`npx --yes --package <spec> idd-*`, or the equivalent
 * `package.json` dependency pin) -- the two profiles
 * `helperRuntime.packageSpec` actually affects. `instructions-only` never
 * runs a helper command, and `vendored-node` copies helper files into the
 * repository instead of resolving them from a package spec, so a missing
 * `packageSpec` is a no-op for both.
 */
const PACKAGE_SPEC_APPLICABLE_PROFILES: ReadonlySet<string> = new Set([
  'ephemeral-npx',
  'package-manager',
]);

/** Non-blocking package-pin advisory result for one target tree (#2987). */
export interface PackagePinWarningResult {
  /** The target's effective `helperRuntime.profile` (defaults to `instructions-only`). */
  profile: string;
  /** True when `profile` is one that `helperRuntime.packageSpec` applies to. */
  applicable: boolean;
  /** True when the target's `helperRuntime.packageSpec` is configured. */
  packageSpecConfigured: boolean;
  /**
   * The advisory message, present only when `applicable` is true and
   * `packageSpecConfigured` is false; `null` for every other combination
   * (a non-applicable profile, or a profile with a configured
   * `packageSpec`) -- a stable shape so a caller can gate on
   * `warning !== null` without re-deriving `applicable &&
   * !packageSpecConfigured` itself.
   */
  warning: string | null;
}

/**
 * Check whether the target's effective helper runtime profile can silently
 * resolve helper commands against the mutable default archive URL instead
 * of an audited pin (#2987 background: an adopter completed the whole
 * hearing/import/substitute/record-policy sequence with `ephemeral-npx` or
 * `package-manager` selected and never set `helperRuntime.packageSpec`,
 * caught only by a downstream reviewer -- see
 * `idd-template/docs/onboarding/policy-decisions.md#helper-runtime-profile`
 * for the full incident).
 *
 * Reads the target's own `.github/idd/config.json` via this module's
 * existing lstat-guarded `readTargetPolicyConfig` reader -- the same
 * reader `planUntrustedLabelerGuardWorkflow` above uses, though that
 * caller pairs it with `normalizePolicyConfig`, not
 * `inspectHelperRuntimeConfig` -- paired here instead with
 * `inspectHelperRuntimeConfig` (from `policy-helpers.mts`), the same
 * schema-aware profile/packageSpec inspector idd-doctor.mts's own
 * `resolveConfiguredHelperRuntime` uses. Deliberately narrower than that
 * idd-doctor.mts resolver, which also falls back to the legacy
 * `idd-policy.json` filename for repository-wide diagnostics outside
 * onboarding: a `--verify` target's manifest completeness check already
 * requires the canonical `.github/idd/config.json` path to exist, so
 * there is no legacy-filename case to fall back to here, and reusing this
 * module's own symlink-safe reader keeps every `--verify` file read on
 * one convention (#2254 review history).
 *
 * The CLI's own `--profile` flag selects which file set `--import` /
 * `--verify` check (`vendored-node` vs. the default set) -- it is not the
 * same thing as the effective `helperRuntime.profile` this function
 * resolves, which always comes from the target's own recorded
 * configuration regardless of the `--profile` flag's value.
 *
 * Non-blocking by design (Groom hearing, 2026-09-15, issue `#2987`):
 * `instructions-only` and `vendored-node` never warn (no remote package
 * resolution to pin for either), and a profile with a configured
 * `packageSpec` already reflects an audited pin. A malformed or invalid
 * `helperRuntime` (an unsupported `profile` string, an invalid
 * `packageSpec`, unparseable JSON, etc.) collapses to the same
 * `instructions-only` / non-applicable fallback as a wholly absent one --
 * matching `idd-doctor.mts`'s own fail-closed convention -- so this check
 * never flags a misconfigured `helperRuntime` itself; that stays
 * idd-doctor's separate `checkHelperRuntimeConfig` diagnostic, which
 * `--verify` does not run.
 */
export function checkPackagePinWarning(
  targetRoot: string,
): PackagePinWarningResult {
  const inspected = inspectHelperRuntimeConfig(
    readTargetPolicyConfig(targetRoot),
  );
  const profile =
    inspected.status === 'ok' ? inspected.profile : 'instructions-only';
  const packageSpec =
    inspected.status === 'ok' ? (inspected.packageSpec ?? '') : '';
  const applicable = PACKAGE_SPEC_APPLICABLE_PROFILES.has(profile);
  const packageSpecConfigured = packageSpec !== '';
  // Profile-specific subject and verb, not just a shared-subject verb swap
  // (Copilot review, PR #3052, round 2): `ephemeral-npx` embeds the pin
  // directly in its own `npx --yes --package <spec> idd-*` invocation
  // string, so "helper commands ... resolve against" is literally true of
  // the commands themselves. `package-manager`'s emitted commands are bare
  // `idd-*` bin names (buildProfileCatalog, helper-runtime-manifest.mts) --
  // the commands install nothing; the *profile's own install step* does,
  // pinning only its install command and `devDependencies` entry. Making
  // "helper commands" the subject of an "install" verb for that profile is
  // a category error a shared-subject template can't avoid, so the two
  // branches use different subjects entirely rather than sharing one
  // sentence shape. Both still name "the mutable default archive URL" per
  // the acceptance criteria's own wording.
  const warning =
    applicable && !packageSpecConfigured
      ? profile === 'ephemeral-npx'
        ? `helper commands for the "ephemeral-npx" helper runtime profile resolve against the mutable default archive URL because helperRuntime.packageSpec is not configured; see docs/onboarding/policy-decisions.md#helper-runtime-profile for pinning guidance.`
        : `the "package-manager" helper runtime profile installs its helper dependency from the mutable default archive URL because helperRuntime.packageSpec is not configured; see docs/onboarding/policy-decisions.md#helper-runtime-profile for pinning guidance.`
      : null;
  return { profile, applicable, packageSpecConfigured, warning };
}

/** The combined wave-3 verify verdict for one target tree. */
export interface VerifyResult {
  manifestCompleteness: ManifestCompletenessResult;
  placeholderResidue: PlaceholderResidueResult;
  /** Blocking helper-load findings (#3238), vendored-node only. */
  helperLoad: HelperLoadResult;
  staleImportSignal: StaleImportSignalResult;
  /** Non-blocking package-pin advisory (#2987); never contributes to `blocking`. */
  packagePinWarning: PackagePinWarningResult;
  /** True when a blocking finding exists (manifest gap, placeholder residue, or a helper-load failure). */
  blocking: boolean;
}

/**
 * Run all five wave-3 check groups against one target tree. Neither the
 * stale-import signal nor the package-pin advisory ever contributes to
 * `blocking` (see `checkStaleImportSignal`'s and
 * `checkPackagePinWarning`'s doc comments); a manifest gap, placeholder
 * residue, or a helper-load failure can fail verify, matching the exit
 * contract in `runVerifyCli`.
 */
export function runVerify(
  sourceRoot: string,
  targetRoot: string,
  profile?: string,
): VerifyResult {
  const manifestCompleteness = checkManifestCompleteness(
    sourceRoot,
    targetRoot,
    profile,
  );
  // #3291: a second `resolveImportFiles` call, deliberately -- keeping
  // `checkManifestCompleteness`'s own `(sourceRoot, targetRoot, profile?)`
  // signature untouched (5 tests call it directly) costs one extra
  // manifest resolution per `--verify` run rather than a signature change
  // that would ripple through those callers. `--verify` is not a hot
  // loop, and the vendored-node profile's extra helper-bundle walk this
  // duplicates is a small, bounded read.
  const placeholderScanScope = resolvePlaceholderScanScope(
    resolveImportFiles(sourceRoot, profile).files,
  );
  const placeholderResidue = checkPlaceholderResidue(
    targetRoot,
    placeholderScanScope,
  );
  const helperLoad = checkHelperLoad(targetRoot, profile);
  const staleImportSignal = checkStaleImportSignal(targetRoot);
  const packagePinWarning = checkPackagePinWarning(targetRoot);
  const blocking =
    manifestCompleteness.missingSource.length > 0 ||
    manifestCompleteness.missingTarget.length > 0 ||
    placeholderResidue.residue.length > 0 ||
    helperLoad.failed.length > 0;
  return {
    manifestCompleteness,
    placeholderResidue,
    helperLoad,
    staleImportSignal,
    packagePinWarning,
    blocking,
  };
}

// --hear (#2281): the operator-facing hearing CLI. Wires the catalog
// loader (#2279) and the existing placeholder-derivation hooks
// (deriveMarkerPrefix, deriveInstallDepsCommand, deriveValidateCommands
// via resolvePlaceholderValues, collectHelperRuntimeEvidence) into
// three modes: --propose (read-only JSON), --apply --answers <file>
// (validate a flat id->value map, print a confirmed transcript), and a
// bare TTY wizard producing the same transcript shape. --hear never
// persists config or rewrites ONBOARDING.md.

/** Catalog item kinds the hearing transcript records an answer for. */
function isAnswerableHearingItem(item: HearingCatalogItem): boolean {
  return item.kind !== 'check';
}

/** One catalog item as rendered for --propose / the TTY wizard. */
interface HearCatalogItemView {
  id: string;
  step: HearingCatalogItem['step'];
  kind: HearingCatalogItem['kind'];
  prompt: string;
  explanation: string;
  options?: HearingCatalogItem['options'];
  /** The `isDefault` option's value, or null (no enum options). */
  documentedDefault: string | null;
  /** The matching resolvePlaceholderValues() candidate, only when its
   *  source is 'derived' (never an operator-supplied override). */
  derived: string | null;
}

/**
 * Runtime derivation hooks for `policy`-kind catalog items (#2271's
 * `development-branch` is the first). Distinct from `resolvePlaceholderValues`
 * above, which only ever derives the seven PLACEHOLDER substitution
 * values -- a policy item's `derivationHook` looks itself up here instead.
 */
const POLICY_DERIVATION_HOOKS: Record<
  string,
  (targetDir: string, readers: OnboardEvidenceReaders) => string | null
> = {
  deriveDevelopmentBranchCandidate,
};

function buildHearCatalogItemViews(
  items: readonly HearingCatalogItem[],
  targetDir: string,
  readers: OnboardEvidenceReaders = {},
): HearCatalogItemView[] {
  const resolution = resolvePlaceholderValues(targetDir, {}, readers);
  return items.map((item) => {
    const documentedDefault =
      item.options?.find((o) => o.isDefault)?.value ?? null;
    const resolved = resolution.values[item.id];
    const policyHook =
      item.kind === 'policy' && item.derivationHook !== undefined
        ? POLICY_DERIVATION_HOOKS[item.derivationHook]
        : undefined;
    const derived =
      resolved != null && resolved.source === 'derived'
        ? resolved.value
        : (policyHook?.(targetDir, readers) ?? null);
    const view: HearCatalogItemView = {
      id: item.id,
      step: item.step,
      kind: item.kind,
      prompt: item.prompt,
      explanation: item.explanation,
      documentedDefault,
      derived,
    };
    if (item.options) {
      view.options = item.options;
    }
    return view;
  });
}

function execSucceeds(command: string, execArgs: string[]): boolean {
  try {
    execFileSync(command, execArgs, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function safeExecOutput(command: string, execArgs: string[]): string | null {
  try {
    return execFileSync(command, execArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Derive the `gh --hostname` value from the target's git remote (#2279's gh-cli / git-remote-host catalog items). */
function deriveGitRemoteHost(targetDir: string): string | null {
  const remoteUrl = readGitRemoteUrl(targetDir);
  if (remoteUrl === null) {
    return null;
  }
  const scpMatch = remoteUrl.match(/^[\w.-]+@([\w.-]+):/);
  if (scpMatch) {
    return scpMatch[1] ?? null;
  }
  try {
    return new URL(remoteUrl).host || null;
  } catch {
    return null;
  }
}

interface HearGhCliEvidence {
  available: boolean;
  version: string | null;
  hostAuthenticated: boolean | null;
}

function collectGhCliEvidence(host: string | null): HearGhCliEvidence {
  const versionOutput = safeExecOutput('gh', ['--version']);
  const available = versionOutput !== null;
  const version = available ? (versionOutput.split('\n')[0] ?? null) : null;
  const hostAuthenticated =
    available && host !== null
      ? execSucceeds('gh', ['auth', 'status', '--hostname', host])
      : null;
  return { available, version, hostAuthenticated };
}

// Fenced-block utilities the distributed workflow instructions assume
// (idd-template/docs/onboarding/hearing-catalog.json's execution-environment
// item explanation) -- `sh`/`bash` themselves are checked separately below.
// `jq` is the item's own separately-called-out requirement for the
// instructions-only advisory-wait fallback (#2304 review).
const HEAR_REQUIRED_UTILITIES = [
  'grep',
  'sed',
  'mkdir',
  'dirname',
  'tr',
  'head',
  'sort',
  'curl',
  'jq',
] as const;

function isUtilityAvailable(shell: string, name: string): boolean {
  // `name` is always one of the fixed HEAR_REQUIRED_UTILITIES literals
  // above, never dash-prefixed or otherwise untrusted, so the `--`
  // end-of-options guard buys no real safety here -- and some /bin/sh
  // implementations treat `--` as the command_name argument to the
  // `command` builtin instead of an option terminator, which would
  // misreport every utility as missing (#2304 review).
  return execSucceeds(shell, ['-c', `command -v ${name}`]);
}

interface HearExecutionEnvironmentEvidence {
  shAvailable: boolean;
  bashAvailable: boolean;
  missingUtilities: string[];
}

function collectExecutionEnvironmentEvidence(): HearExecutionEnvironmentEvidence {
  const shAvailable = execSucceeds('sh', ['-c', 'true']);
  const bashAvailable = execSucceeds('bash', ['-c', 'true']);
  // Probe utilities through whichever POSIX-ish shell is actually
  // present -- the catalog item accepts either (#2304 review).
  const probeShell = shAvailable ? 'sh' : bashAvailable ? 'bash' : null;
  const missingUtilities = probeShell
    ? HEAR_REQUIRED_UTILITIES.filter(
        (name) => !isUtilityAvailable(probeShell, name),
      )
    : [...HEAR_REQUIRED_UTILITIES];
  return { shAvailable, bashAvailable, missingUtilities };
}

function isValidHearAnswerValue(
  item: HearingCatalogItem,
  value: string,
): boolean {
  if (value.length === 0) {
    return false;
  }
  if (item.options && item.options.length > 0) {
    return item.options.some((option) => option.value === value);
  }
  return true;
}

/** One confirmed `{id, value}` pair, matching the transcript schema's answers[] shape. */
interface HearAnswer {
  id: string;
  value: string;
}

interface HearAnswerValidation {
  valid: boolean;
  /** Offending ids: missing, unknown, or an invalid/out-of-enum value. */
  unresolved: string[];
  answers: HearAnswer[];
}

/**
 * Validate a flat `{catalogItemId: value}` map against the answerable
 * (non-`check`) catalog items: every answerable id must be present with
 * a value valid for that item (enum membership when `options` is set,
 * any non-empty string otherwise); any key outside the answerable id
 * set is unknown and also fails closed.
 */
function validateHearAnswers(
  items: readonly HearingCatalogItem[],
  answersMap: Record<string, unknown>,
): HearAnswerValidation {
  const answerable = items.filter(isAnswerableHearingItem);
  const answerableIds = new Set(answerable.map((item) => item.id));
  const unresolved = new Set<string>(
    Object.keys(answersMap).filter((key) => !answerableIds.has(key)),
  );
  const answers: HearAnswer[] = [];
  for (const item of answerable) {
    const raw = answersMap[item.id];
    // Trim to match the TTY wizard's own input handling, so a
    // whitespace-only answers-file value is treated the same as an
    // empty one instead of silently passing option-less validation.
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (typeof value !== 'string' || !isValidHearAnswerValue(item, value)) {
      unresolved.add(item.id);
      continue;
    }
    answers.push({ id: item.id, value });
  }
  return {
    valid: unresolved.size === 0,
    unresolved: [...unresolved].sort(),
    answers,
  };
}

/** Confirmed transcript document, matching schemas/onboarding-hearing-transcript.schema.json. */
function buildHearTranscript(answers: readonly HearAnswer[]): {
  version: string;
  confirmedAt: string;
  answers: readonly HearAnswer[];
} {
  return { version: '1.0.0', confirmedAt: new Date().toISOString(), answers };
}

function validateHearTranscriptShape(transcript: unknown): string[] {
  const schema = loadJson('schemas/onboarding-hearing-transcript.schema.json');
  return validate(transcript, schema);
}

/** Options accepted by {@link runHearWizard}, injectable for tests (mirrors force-handoff.mts's RunHandoffOptions). */
interface RunHearWizardOptions {
  isTTY?: boolean;
  prompt?: PromptFn;
  /** Injected evidence readers (#2271); tests use this to avoid real `gh`/`git` network calls. */
  readers?: OnboardEvidenceReaders;
}

export const HEAR_NON_TTY_ERROR =
  'operator interaction is required; run idd-onboard --hear in an interactive TTY, or use --hear --propose / --hear --apply';

/**
 * Bounds the TTY wizard's per-item retry loop: a non-interactive caller
 * (a scripted PromptFn, or a closed/EOF stdin under a spoofed isTTY) that
 * never supplies a valid answer must fail loudly instead of spinning
 * forever.
 */
const HEAR_WIZARD_MAX_ATTEMPTS_PER_ITEM = 5;

export async function runHearWizard(
  catalog: OnboardingHearingCatalog,
  targetDir: string,
  options: RunHearWizardOptions = {},
): Promise<HearAnswer[]> {
  const {
    isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptFn,
    readers = {},
  } = options;
  if (!isTTY) {
    throw new Error(HEAR_NON_TTY_ERROR);
  }
  const ask = promptFn ?? makeReadlinePrompt();
  const views = buildHearCatalogItemViews(
    catalog.items,
    targetDir,
    readers,
  ).filter((view) => view.kind !== 'check');
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const answers: HearAnswer[] = [];
  for (const view of views) {
    const item = byId.get(view.id);
    if (!item) {
      continue;
    }
    const effectiveDefault = view.derived ?? view.documentedDefault;
    process.stdout.write(`\n${view.prompt}\n${view.explanation}\n`);
    if (view.options && view.options.length > 0) {
      process.stdout.write(
        `Options: ${view.options.map((option) => option.value).join(', ')}\n`,
      );
    }
    let value: string | null = null;
    for (
      let attempt = 0;
      value === null && attempt < HEAR_WIZARD_MAX_ATTEMPTS_PER_ITEM;
      attempt += 1
    ) {
      const suffix = effectiveDefault !== null ? ` [${effectiveDefault}]` : '';
      const raw = (await ask(`${view.id}${suffix}: `)).trim();
      const candidate =
        raw === '' && effectiveDefault !== null ? effectiveDefault : raw;
      if (isValidHearAnswerValue(item, candidate)) {
        value = candidate;
      } else {
        process.stdout.write('Invalid answer; please try again.\n');
      }
    }
    if (value === null) {
      ask.close?.();
      throw new Error(
        `no valid answer for ${view.id} after ${HEAR_WIZARD_MAX_ATTEMPTS_PER_ITEM} attempts`,
      );
    }
    answers.push({ id: view.id, value });
  }
  ask.close?.();
  return answers;
}

function runHearProposeCli(
  catalog: OnboardingHearingCatalog,
  targetDir: string,
): void {
  const items = buildHearCatalogItemViews(catalog.items, targetDir);
  const gitRemoteHost = deriveGitRemoteHost(targetDir);
  const verdict = {
    protocolVersion: '1',
    mode: 'propose',
    target: targetDir,
    catalogVersion: catalog.version,
    items,
    stepZeroEvidence: {
      ghCli: collectGhCliEvidence(gitRemoteHost),
      gitRemoteHost,
      executionEnvironment: collectExecutionEnvironmentEvidence(),
    },
    helperRuntimeEvidence: collectHelperRuntimeEvidence(targetDir),
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(0);
}

function runHearApplyCli(
  catalog: OnboardingHearingCatalog,
  answersPath: string,
): void {
  const raw = readFileSync(resolve(answersPath), 'utf8');
  let answersMap: unknown;
  try {
    answersMap = JSON.parse(raw);
  } catch {
    throw new Error(`--answers file is not valid JSON: ${answersPath}`);
  }
  if (
    typeof answersMap !== 'object' ||
    answersMap === null ||
    Array.isArray(answersMap)
  ) {
    throw new Error(
      '--answers file must be a JSON object mapping catalog item id to value',
    );
  }
  const result = validateHearAnswers(
    catalog.items,
    answersMap as Record<string, unknown>,
  );
  if (!result.valid) {
    process.stdout.write(
      `${JSON.stringify(
        {
          protocolVersion: '1',
          mode: 'apply',
          valid: false,
          unresolved: result.unresolved,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
  const transcript = buildHearTranscript(result.answers);
  const schemaErrors = validateHearTranscriptShape(transcript);
  if (schemaErrors.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          protocolVersion: '1',
          mode: 'apply',
          valid: false,
          unresolved: schemaErrors,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
  // Print the transcript document itself (matching the interactive
  // --hear wizard's own output), not a wrapper -- the printed JSON must
  // validate against onboarding-hearing-transcript.schema.json directly
  // (#2304 review).
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  process.exit(0);
}

async function runHearCli(args: ParsedArgs): Promise<void> {
  const targetDir = resolveConfinedDirectory(
    args.target,
    '--target',
    args.allowRoots,
  );
  if (args.propose && args.apply) {
    throw new Error(
      '--hear --propose and --hear --apply are mutually exclusive',
    );
  }
  const catalog = loadOnboardingHearingCatalog();
  if (args.propose) {
    runHearProposeCli(catalog, targetDir);
    return;
  }
  if (args.apply) {
    if (!args.answers) {
      throw new Error('--hear --apply requires --answers <file>');
    }
    runHearApplyCli(catalog, args.answers);
    return;
  }
  const answers = await runHearWizard(catalog, targetDir);
  const transcript = buildHearTranscript(answers);
  const schemaErrors = validateHearTranscriptShape(transcript);
  if (schemaErrors.length > 0) {
    throw new Error(
      `generated transcript failed schema validation: ${schemaErrors.join('; ')}`,
    );
  }
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  process.exit(0);
}

/** Confirmed transcript document shape consumed by --from-transcript / --record-policy. */
interface HearTranscriptDocument {
  version: string;
  confirmedAt?: string;
  answers: readonly HearAnswer[];
}

/**
 * Read, parse, and schema-validate a confirmed hearing transcript file
 * (the output of `--hear --apply` or the interactive wizard). Throws
 * only on unparseable JSON (a usage error, exit 2, matching `--hear
 * --apply`'s own file-reading check); a schema mismatch is returned as
 * `errors` instead, so the caller can print the same
 * `{valid:false, unresolved}` shape `--hear --apply` prints and exit 1
 * -- "reject a transcript that fails the transcript schema... (exit 1,
 * no writes)" per #2282.
 */
function readAndValidateTranscript(path: string):
  | { transcript: HearTranscriptDocument; errors: readonly [] }
  | {
      transcript: null;
      errors: readonly string[];
    } {
  const raw = readFileSync(resolve(path), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`transcript file is not valid JSON: ${path}`);
  }
  const schemaErrors = validateHearTranscriptShape(parsed);
  if (schemaErrors.length > 0) {
    return { transcript: null, errors: schemaErrors };
  }
  return { transcript: parsed as HearTranscriptDocument, errors: [] };
}

/**
 * Map a confirmed transcript's answers onto `resolvePlaceholderValues`
 * overrides, using each catalog item's `mapsToPlaceholder` field. An
 * answer for an item with no `mapsToPlaceholder` (a policy or check
 * item) is not a placeholder override and is ignored here.
 */
function buildTranscriptPlaceholderOverrides(
  catalog: OnboardingHearingCatalog,
  transcript: HearTranscriptDocument,
): PlaceholderOverrides {
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const overrides: PlaceholderOverrides = {};
  for (const answer of transcript.answers) {
    const placeholderName = byId.get(answer.id)?.mapsToPlaceholder;
    if (placeholderName !== undefined) {
      overrides[placeholderName] = answer.value;
    }
  }
  return overrides;
}

/**
 * Catalog item ids whose confirmed answer is a meta-choice about
 * whether to override the distributed default, not the override value
 * itself -- `claimTiming` needs an ISO-duration pair
 * (`staleAge`/`heartbeatInterval`) and `labels` needs actual label-name
 * strings, neither derivable from `distributed-defaults` /
 * `repository-override` / `custom-taxonomy` alone. `--record-policy`
 * surfaces these in the filled Markdown template but never invents a
 * config value for them (see #2282 B2 plan).
 */
const RECORD_POLICY_NO_LITERAL_CONFIG_IDS = new Set([
  'claim-timing',
  'idd-label-names',
]);

/**
 * Sentinel patch value meaning "remove this key from the merged config"
 * rather than "set it to this value". Used when a confirmed transcript
 * answer reconfirms a distributed default that has no on-the-wire
 * representation of its own (an absent key already means default) --
 * without this, reconfirming the default would silently leave a stale
 * non-default value from a prior run in place (#2282 review follow-up).
 */
const DELETE_CONFIG_KEY = Symbol('idd-record-policy-delete-config-key');

/**
 * Translate one confirmed hearing answer into a `.github/idd/config.json`
 * patch entry (a dotted key path plus the value to write, where the value
 * may be {@link DELETE_CONFIG_KEY}), or `null` when the item is docs-only
 * or has no literal config value (see
 * {@link RECORD_POLICY_NO_LITERAL_CONFIG_IDS}). The two items whose
 * "distributed default" answer has no positive on-the-wire representation
 * (`helper-runtime-profile`'s `instructions-only`,
 * `issue-author-approval-gate`'s `enabled-by-default`) delete their key
 * instead, so reconfirming the default clears a stale override from a
 * prior run rather than preserving it. Every other mapped item's
 * confirmed value is written verbatim, including when it happens to
 * equal that item's own documented default.
 */
function translateRecordPolicyAnswer(
  item: HearingCatalogItem,
  value: string,
): { path: readonly string[]; value: unknown } | null {
  if (!item.mapsToConfig || RECORD_POLICY_NO_LITERAL_CONFIG_IDS.has(item.id)) {
    return null;
  }
  if (item.id === 'helper-runtime-profile' && value === 'instructions-only') {
    // The whole `helperRuntime` key defaults to the instructions-only
    // fallback when absent (schema); delete it rather than writing the
    // value literally, clearing any stale non-default profile.
    return { path: ['helperRuntime'], value: DELETE_CONFIG_KEY };
  }
  if (item.id === 'issue-author-approval-gate') {
    if (value === 'enabled-by-default') {
      // Schema default (omitted or `false`) already keeps the gate on;
      // delete a stale `true` opt-out rather than preserving it.
      return {
        path: ['skipIssueAuthorApprovalGate'],
        value: DELETE_CONFIG_KEY,
      };
    }
    return { path: ['skipIssueAuthorApprovalGate'], value: true };
  }
  const path = item.mapsToConfig
    .split('/')
    .filter((segment) => segment.length > 0);
  return { path, value };
}

/** Set a value at a nested key path, creating intermediate objects as needed. */
function setNestedValue(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor = target;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const key = path[depth];
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Recursively merge `patch` into `target`, preserving sibling keys in
 * any nested object both sides declare (e.g. merging `ciWait.rerunPolicy`
 * must not discard an existing `ciWait.runningTimeout`). Scalars and
 * arrays in `patch` overwrite `target` outright. A {@link DELETE_CONFIG_KEY}
 * patch value removes that key from the result instead of setting it.
 */
function deepMergeConfigPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === DELETE_CONFIG_KEY) {
      delete result[key];
      continue;
    }
    const existing = result[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMergeConfigPatch(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Render a config patch for the JSON verdict: a {@link DELETE_CONFIG_KEY}
 * sentinel isn't itself meaningful JSON, so it renders as an explicit
 * marker string instead of silently vanishing (a bare `Symbol` value is
 * dropped by `JSON.stringify`).
 */
function renderPatchForVerdict(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    rendered[key] =
      value === DELETE_CONFIG_KEY
        ? '(reset to distributed default: key removed)'
        : value;
  }
  return rendered;
}

/** One row of the filled policy-decisions Markdown template. */
interface RecordPolicyDocRow {
  id: string;
  heading: string;
  label: string;
  /**
   * Override the default `**label**: `value`` line with a structured
   * bullet body for a row whose template section
   * (`idd-template/docs/onboarding/policy-decisions.md`) documents more
   * sub-fields than the hearing catalog item actually confirms.
   */
  renderBody?: (value: string) => string;
}

/** Distributed-default sub-values the hearing catalog does not itself elicit. */
const CLAIM_TIMING_DEFAULTS = {
  staleAge: '24 h',
  heartbeatInterval: '12 h',
} as const;
const CI_WAIT_DEFAULTS = {
  runningTimeout: '`PT30M` / 30 min',
  generationTimeout: '`PT10M` / 10 min',
} as const;

/**
 * Catalog-item-id-ordered rows for the filled Markdown template,
 * mirroring `idd-template/docs/onboarding/policy-decisions.md`'s
 * "Recording the selected policies" example structure. Only items the
 * hearing catalog can actually answer (policy-kind items) are listed;
 * the three Step 0 `check`-kind items are evidence, not a policy
 * decision, and are not part of this template.
 */
const RECORD_POLICY_DOC_ROWS: readonly RecordPolicyDocRow[] = [
  { id: 'development-branch', heading: 'Development Branch', label: 'Branch' },
  { id: 'merge-policy', heading: 'Merge Policy', label: 'Policy' },
  { id: 'review-policy', heading: 'PR Review Policy', label: 'Profile' },
  {
    id: 'thread-resolution-policy',
    heading: 'Review-Thread Resolution Policy',
    label: 'Policy',
  },
  {
    id: 'critique-loop-profile',
    heading: 'Critique-Loop Profile',
    label: 'Profile',
  },
  { id: 'credential-scope', heading: 'Credential Scope', label: 'Scope' },
  {
    id: 'claim-timing',
    heading: 'Claim Timing',
    label: 'Selection',
    // The catalog item confirms only the defaults-vs-override meta
    // choice, not override sub-values, so the distributed constants
    // are rendered as the known baseline and an override is flagged
    // as needing manual recording rather than invented.
    renderBody: (value) =>
      value === 'distributed-defaults'
        ? [
            `- **claim-stale-age**: ${CLAIM_TIMING_DEFAULTS.staleAge} (distributed default)`,
            `- **claim-heartbeat-interval**: ${CLAIM_TIMING_DEFAULTS.heartbeatInterval} (distributed default)`,
          ].join('\n')
        : `**Selection**: \`${value}\` (override values not captured by this hearing item -- record them manually)`,
  },
  {
    id: 'ci-wait-policy',
    heading: 'CI Wait Policy',
    label: 'Rerun policy',
    // Only rerunPolicy is a confirmed answer here; the running/generation
    // timeouts are the distributed constants, not something this catalog
    // item elicits, so they are labeled as unconfirmed defaults.
    renderBody: (value) =>
      [
        `- **running timeout**: ${CI_WAIT_DEFAULTS.runningTimeout} (distributed default, not confirmed by this hearing item)`,
        `- **generation timeout**: ${CI_WAIT_DEFAULTS.generationTimeout} (distributed default, not confirmed by this hearing item)`,
        `- **rerun policy**: \`${value}\``,
      ].join('\n'),
  },
  {
    id: 'issue-author-approval-gate',
    heading: 'Issue-Author Approval Gate',
    label: 'Selection',
  },
  {
    id: 'maintainer-approval-actor-policy',
    heading: 'Maintainer Approval Actor Policy',
    label: 'Policy',
  },
  {
    id: 'issue-authoring-companion',
    heading: 'Issue-Authoring Companion',
    label: 'Status',
  },
  {
    id: 'helper-runtime-profile',
    heading: 'Helper Runtime Profile',
    label: 'Profile',
  },
  { id: 'idd-label-names', heading: 'IDD Label Names', label: 'Selection' },
  {
    id: 'up-to-date-head-ruleset',
    heading: 'Up-to-Date-Head Ruleset',
    label: 'Policy',
  },
  {
    id: 'bootstrap-execution-mode',
    heading: 'Bootstrap Execution Mode',
    label: 'Mode',
  },
];

/**
 * Word-wrap a single rendered policy-doc line to at most `width` columns
 * (#3227's `MD013` fix). A leading `- ` list marker (used by the
 * `claim-timing` / `ci-wait-policy` bullet rows) is kept only on the
 * first physical line, and every wrapped continuation line is indented
 * to align under the item's own text so it stays a lazy continuation of
 * the same CommonMark list item rather than starting a new block. Wraps
 * only at word boundaries -- matching this repository's own
 * inline-code-span-wrap convention -- so a single token longer than
 * `width` on its own (an unusually long `development-branch` name, for
 * example) is still emitted whole rather than force-cut. Ported locally
 * from `token-cost-report.mts`'s module-private `wrapProse` rather than
 * exported and shared, per this issue's own out-of-scope note against a
 * general-purpose Markdown-wrapping utility.
 *
 * Groups the line into **units** on a bare single space only (never a
 * bare `' '`.split that would collapse a multi-space run): a run of two
 * or more spaces glues its neighboring words into one indivisible unit
 * instead of being treated as a break point. A recorded freeform value
 * (e.g. `credential-scope`, rendered inside an inline code span) can
 * contain internal multiple spaces, and silently collapsing them to one
 * space would change the recorded content rather than only inserting
 * line breaks -- a real defect Copilot review caught (#3227 review),
 * not merely a cosmetic one, since the issue's own acceptance criteria
 * requires existing content to remain unchanged after wrapping. A lone
 * space is always content-neutral to swap for a line break (CommonMark
 * renders a line ending inside a code span as one space too), so
 * ordinary single-spaced content wraps exactly as it did before this
 * grouping step existed. Wrapping the resulting units is then the same
 * greedy pass as any plain word-wrap: a multi-space-glued unit is
 * wider than a normal word, so it can trip the same pre-existing
 * single-long-token exception below (still never force-cut), but the
 * greedy pass still breaks *before* it whenever that keeps the
 * preceding line within `width` -- unlike naively gluing it onto
 * whatever was already accumulated, which could carry needless
 * overflow forward (#3227 review round 2).
 */
function wrapPolicyDocLine(line: string, width = 80): string {
  if (line.length <= width) {
    return line;
  }
  const marker = /^-\s+/.exec(line)?.[0] ?? '';
  const continuationIndent = ' '.repeat(marker.length);
  const units: string[] = [];
  let unit = '';
  for (const token of line.slice(marker.length).split(/(\s+)/)) {
    if (token === '') {
      continue;
    }
    if (token === ' ') {
      if (unit !== '') {
        units.push(unit);
        unit = '';
      }
    } else {
      // Ordinary text, or a 2+ space run: both stay glued into the
      // current unit, since only a lone space is a break point.
      unit += token;
    }
  }
  if (unit !== '') {
    units.push(unit);
  }
  const wrapped: string[] = [];
  let current = '';
  for (const word of units) {
    const prefixLength =
      wrapped.length === 0 ? marker.length : continuationIndent.length;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (prefixLength + candidate.length > width && current.length > 0) {
      wrapped.push(
        `${wrapped.length === 0 ? marker : continuationIndent}${current}`,
      );
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    wrapped.push(
      `${wrapped.length === 0 ? marker : continuationIndent}${current}`,
    );
  }
  return wrapped.join('\n');
}

/**
 * Render the filled `## IDD Policy Configuration` Markdown document from
 * a confirmed transcript's answers, following the structure shown in
 * `idd-template/docs/onboarding/policy-decisions.md`'s
 * "Recording the selected policies" section. An item with no confirmed
 * answer is omitted rather than printed with a placeholder value. The
 * issue-mediated bootstrap option can override the companion row without
 * changing the transcript or config patch.
 *
 * The document opens with a distinct `#` title (#3227) so the standalone
 * file `--write-policy-doc` writes satisfies `MD041`/first-line-heading
 * -- added above the original `## IDD Policy Configuration` heading
 * rather than promoting it, so that heading's own text is unchanged.
 * Every row's rendered body is then wrapped at 80 columns
 * (`wrapPolicyDocLine`) to satisfy `MD013`; this is a no-op for the
 * already-short enum-valued rows and only actually wraps a long
 * freeform answer (`credential-scope`, `development-branch`) or the
 * fixed `ci-wait-policy` bullet text.
 */
function buildFilledPolicyDocument(
  answers: readonly HearAnswer[],
  options: { readonly issueMediated?: boolean } = {},
): string {
  const valueById = new Map(answers.map((answer) => [answer.id, answer.value]));
  const sections = RECORD_POLICY_DOC_ROWS.filter((row) =>
    valueById.has(row.id),
  ).map((row) => {
    const transcriptValue = valueById.get(row.id) as string;
    const value =
      row.id === 'issue-authoring-companion'
        ? options.issueMediated
          ? 'not installed'
          : normalizeCompanionStatusDisplay(transcriptValue)
        : transcriptValue;
    const rawBody = row.renderBody
      ? row.renderBody(value)
      : `**${row.label}**: \`${value}\``;
    const body = rawBody
      .split('\n')
      .map((line) => wrapPolicyDocLine(line))
      .join('\n');
    return `### ${row.heading}\n\n${body}`;
  });
  return [
    '# IDD Policy Configuration Record',
    '',
    '## IDD Policy Configuration',
    '',
    'This repository uses the following IDD policies:',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * Map the `issue-authoring-companion` catalog's enum value
 * (`hearing-catalog.json`'s `not-installed` / `installed` options) to the
 * documented display form the rest of the template ecosystem uses
 * (`{installed | not installed}` in `policy-decisions.md`,
 * `issue-mediated-bootstrap.md`, and `--issue-mediated`'s own override
 * above). Only `not-installed` has a differing display form; `installed`
 * is already identical either way (#3292).
 */
function normalizeCompanionStatusDisplay(value: string): string {
  return value === 'not-installed' ? 'not installed' : value;
}

/**
 * HTML-comment marker naming the generator, so a re-run can recognize its
 * own prior output (see {@link buildPolicyDocWithSentinel}). Not a secret
 * or a security boundary by itself -- only the accompanying content hash
 * proves the body is unedited.
 */
const POLICY_DOC_SENTINEL_TAG = 'idd-onboard-generated-policy-document';

/** The literal text preceding the sentinel's hex digest, used by both render and parse. */
const POLICY_DOC_SENTINEL_MARKER = `\n\n<!-- ${POLICY_DOC_SENTINEL_TAG}\nsha256: `;

/**
 * Append a trailing sentinel to `body` (the rendered
 * {@link buildFilledPolicyDocument} output) before it is written to
 * `--write-policy-doc`'s destination (#3292): an HTML comment naming the
 * generator and carrying a SHA-256 of `body` on its own line, so every
 * sentinel line stays well inside `MD013`'s 80-column limit. Placed after
 * a blank line at the very end of the document -- never at the top --
 * so it cannot interfere with #3227's first-line `# IDD Policy
 * Configuration Record` heading. `body` itself (the return value of
 * `buildFilledPolicyDocument`) is never mutated; only the file this
 * function's result is written to carries the sentinel -- the JSON
 * verdict's `policyDocument` field stays sentinel-free.
 */
function buildPolicyDocWithSentinel(body: string): string {
  const hash = createHash('sha256').update(body).digest('hex');
  return `${body}${POLICY_DOC_SENTINEL_MARKER}${hash}\n-->\n`;
}

/**
 * Parse a previously written {@link buildPolicyDocWithSentinel} document
 * back into its pre-sentinel `body` and the hex digest the sentinel
 * carries, or `null` when no well-formed sentinel is found at the end of
 * `content` (absent, truncated, or followed by anything other than the
 * closing `-->` and an optional trailing newline). Uses the *last*
 * occurrence of the marker so a coincidental match earlier in `content`
 * (never expected in practice — the rendered template does not contain
 * this literal text) cannot be mistaken for the real, trailing sentinel.
 */
function parsePolicyDocSentinel(
  content: string,
): { body: string; hash: string } | null {
  const markerIndex = content.lastIndexOf(POLICY_DOC_SENTINEL_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const afterMarker = content.slice(
    markerIndex + POLICY_DOC_SENTINEL_MARKER.length,
  );
  const match = /^([0-9a-f]{64})\n-->\n?$/.exec(afterMarker);
  if (!match) {
    return null;
  }
  return { body: content.slice(0, markerIndex), hash: match[1] };
}

/**
 * Whether `content` is exactly this generator's own, unedited prior
 * output: it carries a well-formed {@link parsePolicyDocSentinel} sentinel
 * whose embedded hash matches a fresh SHA-256 of its own preceding body.
 * A hand-edited former generated document (body changed without touching
 * or recomputing the sentinel) or a file this generator never wrote both
 * return `false` here -- the anti-clobber check
 * ({@link assertPolicyDocNotClobbered}) refuses to overwrite either
 * without `--force` (#3292).
 */
function isUneditedGeneratedPolicyDoc(content: string): boolean {
  const parsed = parsePolicyDocSentinel(content);
  return (
    parsed !== null &&
    createHash('sha256').update(parsed.body).digest('hex') === parsed.hash
  );
}

/**
 * Resolve and validate `--write-policy-doc`'s raw argument as a write
 * destination confined to `targetDir` (#3292). `rawPath` is resolved
 * against the current working directory exactly as the write itself
 * already did (documented in `ONBOARDING.md`'s Step 5 -- a relative path
 * is not rooted at `--target`), then the result must land inside
 * `targetDir` itself: a path resolving outside it (an absolute path
 * elsewhere, or enough `..` segments to escape) is refused before any
 * write, rather than silently writing there. `assertSafePlainFileDestination`
 * then applies the same ancestor/leaf checks
 * `assertSafeGuardWorkflowDestination` uses for the guard-workflow write
 * (no symlinked or otherwise non-directory ancestor below `targetDir`,
 * and a leaf that is either absent or a plain file) -- reused rather than
 * duplicated, per this issue's own proposed change. Every violation here
 * is a usage error (thrown, exit `2`), matching `resolveConfinedDirectory`'s
 * own convention for `--target`/`--source`/`--allow-root`.
 */
function resolvePolicyDocDestination(
  targetDir: string,
  rawPath: string,
): string {
  const absolute = resolve(rawPath);
  const relativeToTarget = relative(targetDir, absolute);
  if (
    relativeToTarget === '' ||
    relativeToTarget === '..' ||
    relativeToTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeToTarget)
  ) {
    throw new Error(
      `--write-policy-doc must resolve inside --target, not outside it: ${rawPath}`,
    );
  }
  assertSafePlainFileDestination(
    targetDir,
    relativeToTarget.split(sep).join('/'),
  );
  return absolute;
}

/**
 * Fail closed (throw, usage error, exit `2`) when writing `content` to
 * `absolutePath` would silently destroy content this generator did not
 * itself produce (#3292): an absent destination is always safe (first
 * write); an existing plain file is safe to overwrite only when it is
 * already this generator's own unedited output
 * ({@link isUneditedGeneratedPolicyDoc}) or `force` was passed. A
 * non-plain-file leaf (a symlink, a directory) is never reachable here --
 * `resolvePolicyDocDestination`'s own `assertSafePlainFileDestination`
 * call already refused it earlier, and unlike this content check,
 * `force` cannot override that one (matching `--import`'s own
 * non-file-collision convention). A non-`ENOENT` read failure (for
 * example `EACCES` on an existing-but-unreadable file) is never treated
 * as "absent" either -- silently doing so would let this process
 * overwrite content it never actually verified was safe to overwrite
 * (#3292 review, Copilot).
 */
function assertPolicyDocNotClobbered(
  absolutePath: string,
  force: boolean,
): void {
  if (force) {
    return;
  }
  let existing: string | null;
  try {
    existing = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (!isEnoent(error)) {
      throw new Error(
        `refusing to write ${absolutePath}: could not read the existing destination to verify it is safe to overwrite (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    existing = null;
  }
  if (existing === null || isUneditedGeneratedPolicyDoc(existing)) {
    return;
  }
  throw new Error(
    `refusing to overwrite ${absolutePath}: it already exists and is not ` +
      'an unedited idd-onboard --record-policy generated document -- pass ' +
      '--force to overwrite it anyway, or choose a different --write-policy-doc path',
  );
}

/**
 * Exported (not just called from the CLI dispatcher below) so the
 * `readers` parameter is a genuine injection point unit tests can reach
 * directly, matching {@link OnboardEvidenceReaders.readRemoteBranchExists}'s
 * own doc comment (#2271 review).
 */
export function runRecordPolicyCli(
  args: ParsedArgs,
  readers: OnboardEvidenceReaders = {},
): void {
  if (!args.transcript) {
    throw new Error('--record-policy requires --transcript <file>');
  }
  const targetDir = resolveConfinedDirectory(
    args.target,
    '--target',
    args.allowRoots,
  );
  const configPath = join(targetDir, '.github', 'idd', 'config.json');
  // #3292: the same ancestor/leaf guard the --write-policy-doc destination
  // uses below, applied to .github/idd/config.json itself before this
  // function reads or writes it -- a symlinked ancestor or a symlinked
  // config.json leaf pointing outside --target must never be silently
  // followed by either the read further down or the --apply write.
  assertSafePlainFileDestination(targetDir, '.github/idd/config.json');
  if (!existsSync(configPath)) {
    throw new Error(
      `--record-policy is post-import only; missing ${configPath}`,
    );
  }
  const result = readAndValidateTranscript(args.transcript);
  if (result.transcript === null) {
    // Matches --hear --apply's own schema-failure shape and exit code.
    // --dry-run always wins over --apply here too, matching the success
    // path's canWrite convention below.
    process.stdout.write(
      `${JSON.stringify(
        {
          protocolVersion: '1',
          mode: args.apply && !args.dryRun ? 'apply' : 'dry-run',
          valid: false,
          unresolved: result.errors,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
  const transcript = result.transcript;
  const catalog = loadOnboardingHearingCatalog();
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const patch: Record<string, unknown> = {};
  for (const answer of transcript.answers) {
    const item = byId.get(answer.id);
    if (!item) {
      continue;
    }
    const translated = translateRecordPolicyAnswer(item, answer.value);
    if (translated) {
      setNestedValue(patch, translated.path, translated.value);
    }
  }
  // #2271: verify developmentBranch before recording rather than creating
  // the branch or silently falling back to another one.
  if (typeof patch.developmentBranch === 'string') {
    const developmentBranch = patch.developmentBranch;
    // Shape first (inspectDevelopmentBranch -- the one real non-test call
    // site its own doc comment describes, #2271 review): a malformed
    // value (whitespace, a `refs/heads/` prefix) gets its own specific
    // reason instead of a misleading "not found on remote" message, and
    // never reaches the git ls-remote call below at all.
    const inspection = inspectDevelopmentBranch({ developmentBranch });
    // Only a non-string/whitespace/refs-heads-prefixed value reaches
    // 'invalid' here -- translateRecordPolicyAnswer already produced a
    // plain string from the transcript, so 'absent' cannot occur.
    if (inspection.status === 'invalid') {
      process.stdout.write(
        `${JSON.stringify(
          {
            protocolVersion: '1',
            mode: args.apply && !args.dryRun ? 'apply' : 'dry-run',
            valid: false,
            unresolved: [`development-branch: ${inspection.reason}`],
          },
          null,
          2,
        )}\n`,
      );
      process.exit(1);
    }
    // Local-git-only (`git ls-remote`, or the injected reader in tests),
    // so this needs no GitHub CLI auth, only the `origin` remote --import
    // already requires.
    const remoteBranchExists =
      readers.readRemoteBranchExists ?? checkGitRemoteBranchExists;
    if (!remoteBranchExists(targetDir, developmentBranch)) {
      process.stdout.write(
        `${JSON.stringify(
          {
            protocolVersion: '1',
            mode: args.apply && !args.dryRun ? 'apply' : 'dry-run',
            valid: false,
            unresolved: [
              `development-branch: "${developmentBranch}" was not found on the configured origin remote`,
            ],
          },
          null,
          2,
        )}\n`,
      );
      process.exit(1);
    }
  }
  // A syntactically valid config.json can still parse to a non-object root
  // (`null`, a number, a bare string, an array); deepMergeConfigPatch would
  // silently spread that into `{}` (or an index-keyed object for an array)
  // and --apply would overwrite the file with the patch alone, losing the
  // original document. Same guard convention as readExistingCommandsTable.
  const parsedConfig: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (
    typeof parsedConfig !== 'object' ||
    parsedConfig === null ||
    Array.isArray(parsedConfig)
  ) {
    throw new Error(`--record-policy requires a JSON object at ${configPath}`);
  }
  const existingConfig = parsedConfig as Record<string, unknown>;
  const mergedConfig = deepMergeConfigPatch(existingConfig, patch);
  // Validate only the sections this patch touched (#1359 pattern via
  // validateConfigSection), never the whole document: --record-policy
  // runs post-import, pre-substitute, so the "pristine imported"
  // config.json still carries unresolved double-brace placeholder
  // tokens in required fields like markerPrefix -- a whole-document
  // validate would reject every real invocation.
  const schema = loadJson('schemas/policy.schema.json');
  const schemaErrors = Object.keys(patch).flatMap((key) =>
    validateConfigSection(mergedConfig, schema, key),
  );
  if (schemaErrors.length > 0) {
    throw new Error(
      `config.json patch failed schema validation: ${schemaErrors.join('; ')}`,
    );
  }
  const policyDocument = buildFilledPolicyDocument(transcript.answers, {
    issueMediated: args.issueMediated,
  });
  // --dry-run always wins over --apply, matching runImportCli's convention.
  const canWrite = args.apply && !args.dryRun;
  // #3292: resolve and validate the --write-policy-doc destination (and
  // refuse an unsafe/clobbering one) before either write below, so a
  // refusal here never leaves config.json written while the doc write is
  // skipped -- the ordering the issue's own proposed change requires.
  let policyDocDestination: string | null = null;
  if (canWrite && args.writePolicyDoc) {
    policyDocDestination = resolvePolicyDocDestination(
      targetDir,
      args.writePolicyDoc,
    );
    assertPolicyDocNotClobbered(policyDocDestination, args.force);
    // Create a missing parent directory before either write below (#3292
    // review, CodeRabbit): the ancestor check inside
    // resolvePolicyDocDestination only refuses a non-directory ancestor,
    // by design leaving a genuinely absent one for this recursive
    // mkdirSync to create -- matching applyUntrustedLabelerGuardPlan's
    // own mkdirSync-then-write convention. Doing this before the
    // config.json write keeps a missing-directory failure from landing
    // config.json first and then failing the doc write on the very next
    // line, which is exactly the half-applied --apply the ordering
    // requirement above exists to prevent.
    mkdirSync(dirname(policyDocDestination), { recursive: true });
  }
  if (canWrite) {
    writeFileSync(configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
    if (policyDocDestination) {
      writeFileSync(
        policyDocDestination,
        buildPolicyDocWithSentinel(policyDocument),
      );
    }
  }
  const verdict = {
    protocolVersion: '1',
    mode: canWrite ? 'apply' : 'dry-run',
    target: targetDir,
    transcript: resolve(args.transcript),
    configPatch: renderPatchForVerdict(patch),
    policyDocument,
    writtenPolicyDocPath: policyDocDestination,
    written: canWrite,
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(0);
}

function main(): void {
  runCli().catch((error: unknown) => {
    // Usage/config errors exit 2, keeping exit 1 unambiguous as the
    // residue signal (same split as audit-pr-cleanup's fail()).
    process.stderr.write(
      `idd-onboard: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
}

if (import.meta.main) {
  main();
}

interface ParsedArgs {
  substitute: boolean;
  importMode: boolean;
  verify: boolean;
  hear: boolean;
  recordPolicy: boolean;
  issueMediated: boolean;
  propose: boolean;
  /** Bare `--apply`, shared by `--hear --apply` and `--record-policy --apply`. */
  apply: boolean;
  answers: string | undefined;
  fromTranscript: string | undefined;
  transcript: string | undefined;
  writePolicyDoc: string | undefined;
  source: string | undefined;
  target: string;
  dryRun: boolean;
  force: boolean;
  profile: string | undefined;
  /** `--import`-only; repeatable manifest target paths to exclude. */
  hold: string[];
  overrides: PlaceholderOverrides;
  help: boolean;
  /** #2216: additional confinement roots for --source / --target. */
  allowRoots: string[];
}

// Excluded from the #1446 cli-args.mts wrapper: the placeholder-override
// flags below (`flagToName`) are data-driven from `ONBOARDING_PLACEHOLDERS`
// -- the accepted flag set is built from a runtime table, not a fixed spec
// declared in source. A static cli-args.mts spec object cannot represent a
// flag set that is only known once that table is read.
function parseArgs(rawArgv: string[]): ParsedArgs {
  // #1921/#2465: strip a pnpm-forwarded leading `--` the same way the
  // shared cli-args.mts wrapper does -- this parser is excluded from that
  // wrapper (see the comment above) so it must call the strip directly.
  const argv = stripLeadingArgumentSeparator(rawArgv);
  const parsed: ParsedArgs = {
    substitute: false,
    importMode: false,
    verify: false,
    hear: false,
    recordPolicy: false,
    issueMediated: false,
    propose: false,
    apply: false,
    answers: undefined,
    fromTranscript: undefined,
    transcript: undefined,
    writePolicyDoc: undefined,
    source: undefined,
    target: '.',
    dryRun: false,
    force: false,
    profile: undefined,
    hold: [],
    overrides: {},
    help: false,
    allowRoots: [],
  };
  const flagToName = new Map(
    ONBOARDING_PLACEHOLDERS.map((entry) => [entry.flag, entry.name]),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--substitute') {
      parsed.substitute = true;
      continue;
    }
    if (token === '--import') {
      parsed.importMode = true;
      continue;
    }
    if (token === '--verify') {
      parsed.verify = true;
      continue;
    }
    if (token === '--hear') {
      parsed.hear = true;
      continue;
    }
    if (token === '--record-policy') {
      parsed.recordPolicy = true;
      continue;
    }
    if (token === '--issue-mediated') {
      parsed.issueMediated = true;
      continue;
    }
    if (token === '--propose') {
      parsed.propose = true;
      continue;
    }
    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (token === '--answers') {
      parsed.answers = requireValue();
      index += 1;
      continue;
    }
    if (token === '--from-transcript') {
      parsed.fromTranscript = requireValue();
      index += 1;
      continue;
    }
    if (token === '--transcript') {
      parsed.transcript = requireValue();
      index += 1;
      continue;
    }
    if (token === '--write-policy-doc') {
      parsed.writePolicyDoc = requireValue();
      index += 1;
      continue;
    }
    if (token === '--source') {
      parsed.source = requireValue();
      index += 1;
      continue;
    }
    if (token === '--target') {
      parsed.target = requireValue();
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token === '--profile') {
      parsed.profile = requireValue();
      index += 1;
      continue;
    }
    if (token === '--hold') {
      parsed.hold.push(requireValue());
      index += 1;
      continue;
    }
    if (token === '--allow-root') {
      parsed.allowRoots.push(requireValue());
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    const name = flagToName.get(token);
    if (name !== undefined) {
      parsed.overrides[name] = requireValue();
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

/** Import-only flags the user explicitly passed (present regardless of mode). */
function importOnlyFlagsPresent(args: ParsedArgs): string[] {
  const present: string[] = [];
  if (args.source !== undefined) {
    present.push('--source');
  }
  if (args.force) {
    present.push('--force');
  }
  if (args.profile !== undefined) {
    present.push('--profile');
  }
  if (args.hold.length > 0) {
    present.push('--hold');
  }
  return present;
}

/**
 * Substitute-only flags the user explicitly passed: every placeholder
 * override flag, plus `--from-transcript`.
 */
function substituteOnlyFlagsPresent(args: ParsedArgs): string[] {
  const present = ONBOARDING_PLACEHOLDERS.filter(
    (entry) => args.overrides[entry.name] !== undefined,
  ).map((entry) => entry.flag);
  if (args.fromTranscript !== undefined) {
    present.push('--from-transcript');
  }
  return present;
}

/** --record-policy-only flags the user explicitly passed (present regardless of mode). */
function recordPolicyOnlyFlagsPresent(args: ParsedArgs): string[] {
  const present: string[] = [];
  if (args.issueMediated) {
    present.push('--issue-mediated');
  }
  if (args.transcript !== undefined) {
    present.push('--transcript');
  }
  if (args.writePolicyDoc !== undefined) {
    present.push('--write-policy-doc');
  }
  return present;
}

/**
 * Flags --verify does not accept: every substitute-only override flag (verify
 * never substitutes), plus `--force`, `--dry-run` (verify never writes, so
 * "allow overwriting" and "print the plan without writing" are both
 * meaningless for it), and `--hold` (verify checks manifest completeness
 * against the full resolved file set; it never builds an import plan that a
 * hold could exclude an entry from).
 */
function verifyForeignFlagsPresent(args: ParsedArgs): string[] {
  const present = substituteOnlyFlagsPresent(args);
  if (args.force) {
    present.push('--force');
  }
  if (args.dryRun) {
    present.push('--dry-run');
  }
  if (args.hold.length > 0) {
    present.push('--hold');
  }
  return present;
}

/**
 * --hear-only flags the user explicitly passed (present regardless of
 * mode). Bare `--apply` is shared with `--record-policy` and reported
 * here as `--apply`; callers that also reject record-policy-only flags
 * separately via {@link recordPolicyOnlyFlagsPresent} still catch a
 * `--record-policy --apply` combination through that function's own
 * `--transcript`/`--write-policy-doc` checks.
 */
function hearOnlyFlagsPresent(args: ParsedArgs): string[] {
  const present: string[] = [];
  if (args.propose) {
    present.push('--propose');
  }
  if (args.apply) {
    present.push('--apply');
  }
  if (args.answers !== undefined) {
    present.push('--answers');
  }
  return present;
}

/**
 * Flags --hear does not accept: every import-only flag (`--source`,
 * `--force`, `--profile` -- --hear never imports or overwrites), every
 * substitute-only placeholder-override flag (--hear derives candidates
 * read-only via the same hooks; it never accepts an explicit override),
 * and every record-policy-only flag.
 */
function hearForeignFlagsPresent(args: ParsedArgs): string[] {
  return [
    ...importOnlyFlagsPresent(args),
    ...substituteOnlyFlagsPresent(args),
    ...recordPolicyOnlyFlagsPresent(args),
  ];
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const modeCount = [
    args.substitute,
    args.importMode,
    args.verify,
    args.hear,
    args.recordPolicy,
  ].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error(
      '--substitute, --import, --verify, --hear, and --record-policy are mutually exclusive',
    );
  }
  if (args.hear) {
    const foreign = hearForeignFlagsPresent(args);
    if (foreign.length > 0) {
      throw new Error(
        `--hear does not accept flag(s) it never uses: ${foreign.join(', ')}`,
      );
    }
    await runHearCli(args);
    return;
  }
  if (args.recordPolicy) {
    // Not hearOnlyFlagsPresent(args): that set includes bare --apply,
    // which --record-policy shares and must accept. Not the full
    // importOnlyFlagsPresent(args) either (#3292): --force is meaningful
    // here too -- it lets --write-policy-doc overwrite a destination that
    // is not this generator's own unedited output -- so it is excluded
    // from this stage's own foreign-flag list even though --hear and bare
    // --substitute below still reject it via the unfiltered helper.
    const foreign = [
      ...importOnlyFlagsPresent(args).filter((flag) => flag !== '--force'),
      ...substituteOnlyFlagsPresent(args),
      ...(args.propose ? ['--propose'] : []),
      ...(args.answers !== undefined ? ['--answers'] : []),
    ];
    if (foreign.length > 0) {
      throw new Error(
        `--record-policy does not accept flag(s) it never uses: ${foreign.join(', ')}`,
      );
    }
    runRecordPolicyCli(args);
    return;
  }
  if (args.importMode) {
    // parseArgs collects every known flag regardless of the active stage,
    // so a stage-foreign flag (e.g. a placeholder override alongside
    // --import) would otherwise be silently ignored instead of reported.
    const foreign = [
      ...substituteOnlyFlagsPresent(args),
      ...hearOnlyFlagsPresent(args),
      ...recordPolicyOnlyFlagsPresent(args),
    ];
    if (foreign.length > 0) {
      throw new Error(
        `--import does not accept substitute-only flag(s), --hear-only flag(s), or --record-policy-only flag(s): ${foreign.join(', ')}`,
      );
    }
    runImportCli(args);
    return;
  }
  if (args.verify) {
    const foreign = [
      ...verifyForeignFlagsPresent(args),
      ...hearOnlyFlagsPresent(args),
      ...recordPolicyOnlyFlagsPresent(args),
    ];
    if (foreign.length > 0) {
      throw new Error(
        `--verify does not accept flag(s) it never uses: ${foreign.join(', ')}`,
      );
    }
    runVerifyCli(args);
    return;
  }
  if (!args.substitute) {
    throw new Error(
      'pass --substitute, --import, --verify, --hear, or --record-policy to select a stage',
    );
  }
  const foreign = [
    ...importOnlyFlagsPresent(args),
    ...hearOnlyFlagsPresent(args),
    ...recordPolicyOnlyFlagsPresent(args),
  ];
  if (foreign.length > 0) {
    throw new Error(
      `--substitute does not accept import-only flag(s), --hear-only flag(s), or --record-policy-only flag(s): ${foreign.join(', ')}`,
    );
  }
  const targetDir = resolveConfinedDirectory(
    args.target,
    '--target',
    args.allowRoots,
  );
  let transcriptOverrides: PlaceholderOverrides = {};
  if (args.fromTranscript !== undefined) {
    const result = readAndValidateTranscript(args.fromTranscript);
    if (result.transcript === null) {
      // Matches --hear --apply's own schema-failure shape and exit code.
      process.stdout.write(
        `${JSON.stringify(
          {
            protocolVersion: '1',
            mode: args.dryRun ? 'dry-run' : 'apply',
            valid: false,
            unresolved: result.errors,
          },
          null,
          2,
        )}\n`,
      );
      process.exit(1);
    }
    transcriptOverrides = buildTranscriptPlaceholderOverrides(
      loadOnboardingHearingCatalog(),
      result.transcript,
    );
  }
  // Explicit per-placeholder flags win over the transcript, matching
  // today's "explicit flags override derivation" rule.
  const mergedOverrides: PlaceholderOverrides = {
    ...transcriptOverrides,
    ...args.overrides,
  };
  const resolution = resolvePlaceholderValues(targetDir, mergedOverrides);
  // #3291: --substitute takes no --source, so its scan scope always comes
  // from the RUNNING CLI's own idd-skill package root -- never an
  // adopter-supplied tree. Resolved via the shared, marker-first
  // `resolveBundleRoot` (#3238) rather than a nearest-`package.json`
  // walk of its own (2026-09-24 review): a nearest-`package.json` walk
  // can stop at an outer workspace/package ancestor before reaching the
  // actual idd-skill (or vendored-node bundle) root, reading the wrong
  // `audit/sync-manifest.json` or none at all. A tree with neither the
  // bundle marker nor `package.json` anywhere in the (bounded) walk
  // fails closed here, naming the tried root, and reaches main()'s
  // exit-2 usage-error handling rather than ever falling back to
  // scanning the whole --target tree.
  let scanSourceRoot: string;
  let scanScope: ReadonlySet<string>;
  try {
    scanSourceRoot = resolveBundleRoot(import.meta.dirname);
    scanScope = resolvePlaceholderScanScope(
      resolveImportFiles(scanSourceRoot).files,
    );
  } catch (error) {
    throw new Error(
      `--substitute could not resolve its own core file set: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const { inScope, outOfScopeTokens } = partitionScansByScope(
    scanPlaceholderTokens(targetDir),
    scanScope,
  );
  const plan = buildSubstitutionPlan(inScope, resolution);
  // #2671: planned before any write below (and before the canWrite check),
  // so a malformed `labels.*` value (e.g. a control character rejected by
  // `buildUntrustedLabelerGuardWorkflowContent`) throws and aborts the
  // whole --substitute run with no partial write — same fail-closed
  // contract as the residue check just below. Independent of placeholder
  // substitution itself (reads the target's own already-substituted
  // `labels.*` config, not an onboarding placeholder).
  const untrustedLabelerGuardPlan =
    planUntrustedLabelerGuardWorkflow(targetDir);
  // Fail closed: never write a half-substituted tree. Apply mode writes
  // only when every scanned onboarding placeholder resolved.
  const canWrite = !args.dryRun && plan.residue.length === 0;
  const filesChanged = canWrite ? applySubstitutionPlan(targetDir, plan) : 0;
  const untrustedLabelerGuardWritten = canWrite
    ? applyUntrustedLabelerGuardPlan(targetDir, untrustedLabelerGuardPlan)
    : false;
  const verdict = {
    protocolVersion: '1',
    mode: args.dryRun ? 'dry-run' : 'apply',
    target: targetDir,
    values: resolution.values,
    unresolved: resolution.unresolved,
    plan: plan.entries,
    residue: plan.residue,
    unknownTokens: plan.unknownTokens,
    // #3291: every `{{...}}`-shaped token found outside the imported
    // core file set -- informational only, never written, never
    // blocking (see resolvePlaceholderScanScope/partitionScansByScope).
    outOfScopeTokens,
    scope: {
      sourceRoot: scanSourceRoot,
      inScopeFileCount: scanScope.size,
    },
    skippedPaths: listSkippedPlaceholderPaths(targetDir),
    filesChanged,
    // Folds in untrustedLabelerGuardWritten (#2684 review): a caller
    // consuming only this generic top-level field must not conclude "no
    // changes" and skip committing a newly generated guard workflow when
    // filesChanged is 0 but the guard alone was written (e.g. a
    // previously-substituted tree that only just gained a non-empty
    // labels.untrustedLabelerLogins).
    written: (canWrite && filesChanged > 0) || untrustedLabelerGuardWritten,
    untrustedLabelerGuard: {
      path: untrustedLabelerGuardPlan.path,
      logins: untrustedLabelerGuardPlan.untrustedLabelerLogins,
      written: untrustedLabelerGuardWritten,
    },
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Residue means the replacement pass cannot converge (an onboarding
  // placeholder would survive): signal it in dry-run and apply alike so
  // callers can gate on the exit code. Unknown tokens are informational.
  process.exit(plan.residue.length > 0 ? 1 : 0);
}

function runImportCli(args: ParsedArgs): void {
  if (!args.source) {
    throw new Error('--import requires --source <idd-skill-tree>');
  }
  const sourceDir = resolveConfinedDirectory(
    args.source,
    '--source',
    args.allowRoots,
  );
  const targetDir = resolveConfinedDirectory(
    args.target,
    '--target',
    args.allowRoots,
  );
  // Snapshot before the copy: --import always overwrites
  // .github/idd/config.json byte-for-byte from source (#2222), so a
  // re-import's already-customized commands table must be captured now,
  // before applyImportPlan below replaces it with the raw template.
  const existingCommandsSnapshot = readExistingCommandsTable(targetDir);
  const plan = buildImportPlan(sourceDir, targetDir, {
    profile: args.profile,
    force: args.force,
    hold: args.hold,
  });
  // Fail closed: never write a partially-imported tree. Apply mode writes
  // only when every declared source file exists, no existing target file
  // would be silently clobbered without --force, and no target path is
  // blocked by a non-file collision (which --force cannot override).
  const blocking =
    plan.missingSource.length > 0 ||
    plan.blockedOverwrites.length > 0 ||
    plan.nonFileTargetCollisions.length > 0;
  const canWrite = !args.dryRun && !blocking;
  const filesChanged = canWrite
    ? applyImportPlan(sourceDir, targetDir, plan)
    : 0;
  if (canWrite && filesChanged > 0) {
    restoreExistingCommandsTable(targetDir, existingCommandsSnapshot);
  }
  const verdict = {
    protocolVersion: '1',
    mode: args.dryRun ? 'dry-run' : 'apply',
    source: sourceDir,
    target: targetDir,
    profile: args.profile ?? null,
    plan: plan.entries,
    missingSource: plan.missingSource,
    blockedOverwrites: plan.blockedOverwrites,
    nonFileTargetCollisions: plan.nonFileTargetCollisions,
    // Only present when --hold actually excluded something: keeps a
    // caller that never passes --hold seeing byte-for-byte the same
    // verdict shape as before this field existed (Copilot review on
    // PR #3224), not just the same file writes.
    ...(plan.heldTargets.length > 0 ? { heldTargets: plan.heldTargets } : {}),
    filesChanged,
    written: canWrite && filesChanged > 0,
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Blocking findings signal in dry-run and apply alike so callers can gate
  // on the exit code without needing a separate --dry-run probe first.
  process.exit(blocking ? 1 : 0);
}

function runVerifyCli(args: ParsedArgs): void {
  if (!args.source) {
    throw new Error('--verify requires --source <idd-skill-tree>');
  }
  const sourceDir = resolveConfinedDirectory(
    args.source,
    '--source',
    args.allowRoots,
  );
  const targetDir = resolveConfinedDirectory(
    args.target,
    '--target',
    args.allowRoots,
  );
  const result = runVerify(sourceDir, targetDir, args.profile);
  const verdict = {
    protocolVersion: '1',
    mode: 'verify',
    source: sourceDir,
    target: targetDir,
    profile: args.profile ?? null,
    manifestCompleteness: result.manifestCompleteness,
    placeholderResidue: result.placeholderResidue,
    helperLoad: result.helperLoad,
    staleImportSignal: result.staleImportSignal,
    packagePinWarning: result.packagePinWarning,
    blocking: result.blocking,
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Blocking findings (manifest gap, placeholder residue, or a helper-load
  // failure) signal via exit 1, matching --substitute / --import's
  // contract; the stale-import signal and the package-pin advisory are
  // both informational only and never flip this exit code (see
  // checkStaleImportSignal / checkPackagePinWarning / runVerify).
  process.exit(result.blocking ? 1 : 0);
}

function printHelp(): void {
  const flags = ONBOARDING_PLACEHOLDERS.map(
    (entry) =>
      `  ${entry.flag} <value>${entry.kind === 'command' ? ' (accepts the no-op "true")' : ''}`,
  ).join('\n');
  process.stdout.write(`usage: node scripts/idd-onboard.mjs --substitute [options]
       node scripts/idd-onboard.mjs --substitute --from-transcript <file> [options]
       node scripts/idd-onboard.mjs --import --source <dir> --target <dir> [options]
       node scripts/idd-onboard.mjs --verify --source <dir> --target <dir> [options]
       node scripts/idd-onboard.mjs --hear --propose --target <dir>
       node scripts/idd-onboard.mjs --hear --apply --answers <file> --target <dir>
       node scripts/idd-onboard.mjs --hear --target <dir>   (interactive TTY wizard)
       node scripts/idd-onboard.mjs --record-policy --transcript <file> --target <dir> [--issue-mediated] [--apply] [--write-policy-doc <path>] [--force]

Onboarding automation.

--substitute (wave 1): resolves the seven template placeholders for a
target tree that already contains the imported template files
(auto-derived from repository evidence where
idd-template/docs/onboarding/placeholders.md defines a derivation;
explicit flags override; --trusted-marker-actor is always explicit) and
rewrites the files. Skips the placeholder-reference meta-docs
(docs/onboarding/placeholders.md, docs/customization.md,
docs/onboarding/policy-decisions.md,
docs/onboarding/agent-entry-and-verification.md,
docs/onboarding/project-tuning.md), which document the tokens rather
than consume them and stay literal on purpose. Prints a JSON verdict
with the per-file, per-placeholder plan, blocking residue (unresolved
onboarding placeholders), informational unknown {{...}} tokens, and the
skipped meta-doc paths present in the target.

Exit codes: 0 converged; 1 residue would remain (apply writes nothing
in that case); 2 usage or configuration error.

  --substitute         run the substitution stage
  --target <dir>       target tree to rewrite (default: current directory)
  --allow-root <dir>   additionally confine --target to this root, on top
                       of the current working directory (#2216); repeat
                       for more than one. Required only when --target
                       resolves outside the working directory. A
                       filesystem root removes this confinement
                       guarantee entirely; a narrower but still broad
                       value (e.g. a home directory) substantially
                       widens it instead.
  --from-transcript <file>
                       read placeholder answers from a confirmed --hear
                       transcript (mapsToPlaceholder items); an explicit
                       placeholder override flag below still wins over
                       the transcript when both are present
  --dry-run            print the plan without writing anything
  --help, -h           show this help

Placeholder overrides:
${flags}

--import (wave 2): copies the distributed core template file set from a
local idd-skill source tree (--source) into --target, driven by
audit/sync-manifest.json's idd-template-core-files generated block (the
same canonical source idd-template/ONBOARDING.md's Step 2 file list
renders from). With --profile vendored-node, also copies the
profile-conditional helper bundle (helper-runtime-manifest.mts's
collectVendoredFiles); every other profile value vends no extra files.
Refuses to overwrite an existing target file whose content differs
unless --force, and reports missing declared source files and non-file
target collisions (e.g. an existing directory at a target path) as
blocking findings. With --hold <target-path> (repeatable), skips the
named manifest entries -- matched against the same targetPath a plan
entry or --dry-run output reports -- while still importing every other
entry in the resolved file set; a --hold value that does not match any
resolved manifest path is a usage error (exit 2), never a silent no-op.
Prints a JSON verdict with the per-file plan
(new / unchanged / overwrite / blocked-non-file / held classification),
the blocking findings, and heldTargets (the target paths --hold
excluded -- never blocking).

Exit codes: 0 converged; 1 a blocking finding exists (apply writes
nothing in that case); 2 usage or configuration error.

  --import                          run the import stage
  --source <dir>                    local idd-skill source tree to copy from
  --target <dir>                    target repository (default: current directory)
  --allow-root <dir>                additionally confine --source / --target
                                     to this root, on top of the current
                                     working directory (#2216); repeat for
                                     more than one. A filesystem root
                                     removes this confinement guarantee
                                     entirely; a narrower but still
                                     broad value (e.g. a home directory)
                                     substantially widens it instead.
  --profile <name>                  ${PROFILE_NAMES.join(' | ')}
  --force                           allow overwriting a differing target file
  --hold <target-path>              skip importing this manifest entry
                                     (repeatable); default behavior (no
                                     --hold) is unchanged
  --dry-run                         print the plan without writing anything
  --help, -h                        show this help

--verify (wave 3): mechanical pass/fail for a target tree after --import and
--substitute have run, in place of a manual walkthrough of
idd-template/ONBOARDING.md Step 6. Reports five check groups:
manifestCompleteness (every file --import would copy for --source /
--profile exists under --target, reusing that same manifest resolution —
missing files are blocking), placeholderResidue (leftover {{...}} tokens via
--substitute's own scanner — a remaining onboarding placeholder is blocking
residue, any other {{...}}-shaped token stays informational), helperLoad
(--profile vendored-node only: spawns every cataloged helper under
--target's own tree with --help and reports any that fail to load — a
failure is blocking; not applicable, and spawns nothing, for any other
profile), staleImportSignal (idd-doctor's content-based stale-import
detector re-run against the target's imported files — informational only,
never blocking), and packagePinWarning (advisory only, never blocking:
flags an ephemeral-npx/package-manager helperRuntime.profile with no
configured helperRuntime.packageSpec, so helper commands silently resolve
against the mutable default archive URL instead of an audited pin).

Exit codes: 0 no blocking finding; 1 a blocking finding exists (manifest
gap, placeholder residue, or a helper-load failure); 2 usage or
configuration error.

  --verify                           run the verify stage
  --source <dir>                     local idd-skill source tree the target was imported from
  --target <dir>                     target repository to verify (default: current directory)
  --allow-root <dir>                 additionally confine --source / --target
                                      to this root, on top of the current
                                      working directory (#2216); repeat for
                                      more than one. A filesystem root
                                      removes this confinement guarantee
                                      entirely; a narrower but still
                                      broad value (e.g. a home directory)
                                      substantially widens it instead.
  --profile <name>                   ${PROFILE_NAMES.join(' | ')}
  --help, -h                         show this help

--hear (#2281): the operator-facing hearing CLI over the catalog and
transcript schemas #2279 ships (idd-template/docs/onboarding/hearing-catalog.json).
Derives candidates for the 21 answerable (non-check) catalog items by
reusing --substitute's own derivation hooks
(resolvePlaceholderValues / deriveMarkerPrefix / deriveInstallDepsCommand /
deriveValidateCommands) and reports helper-runtime evidence
(collectHelperRuntimeEvidence). Never edits idd-template/ONBOARDING.md,
never writes .github/idd/config.json, never requires --source.

  --hear --propose            read-only: print catalog items (with any
                               derived candidate and documented default),
                               Step 0 gh-cli / git-remote-host /
                               execution-environment evidence, and
                               helper-runtime evidence as JSON. Exit 0.
  --hear --apply --answers <file>
                               validate a JSON object mapping catalog
                               item id -> confirmed value against the
                               catalog and the transcript schema, then
                               print the confirmed transcript. Exit 0
                               valid; 1 a required id is missing, an id
                               is unknown, or a value is not one of that
                               item's options (nothing is written
                               either way).
  --hear (no --propose/--apply)
                               interactive TTY wizard over the same 21
                               items; shows each item's explanation,
                               accepts empty input to confirm the shown
                               default, and prints the same transcript
                               shape as --apply. Exit 2 when stdin/stdout
                               is not a TTY.
  --target <dir>               target repository (default: current directory)
  --allow-root <dir>           additionally confine --target to this root,
                               on top of the current working directory
                               (#2216); repeat for more than one. A
                               filesystem root removes this confinement
                               guarantee entirely; a narrower but still
                               broad value (e.g. a home directory)
                               substantially widens it instead.
  --answers <file>              path to the --apply answers JSON file
  --help, -h                    show this help

--record-policy (#2282): consumes a confirmed --hear transcript's
policy-kind answers. Post-import only: --target must already contain
.github/idd/config.json. Refuses (exit 2) to edit ONBOARDING.md,
CLAUDE.md, AGENTS.md, or GEMINI.md -- or any other --write-policy-doc
destination -- unless it is absent, is already this generator's own
unedited prior output, or --force is passed (#3292). The destination
must also resolve inside --target with no symlinked or otherwise
non-directory ancestor and no non-plain-file leaf; --force cannot
override that part of the check, only the content-differs refusal.
The same ancestor/leaf check applies to .github/idd/config.json itself.

  --record-policy --transcript <file> --target <dir>
                               dry-run (default): print the JSON verdict
                               (config.json patch + filled Markdown
                               policy-decisions template) without
                               writing anything.
  --apply                      merge the patch into .github/idd/config.json
                               and write it. helperRuntime is omitted
                               when the confirmed profile is
                               instructions-only; skipIssueAuthorApprovalGate
                               is written true only when the operator
                               opted out. Docs-only answers (critique-loop
                               profile, credential scope, issue-authoring
                               companion, up-to-date-head ruleset,
                               bootstrap execution mode) and the
                               claim-timing / idd-label-names meta-choices
                               never become invented config keys -- they
                               appear in the filled Markdown template only.
  --write-policy-doc <path>    also write the filled Markdown template to
                               <path> (--apply only); without this flag the
                               template is stdout-only. The written file
                               carries a trailing generated-document
                               sentinel (an HTML comment with a content
                               hash) the anti-clobber check above reads on
                               a later run; the stdout-only JSON verdict's
                               policyDocument field never carries it.
  --force                       allow --write-policy-doc to overwrite an
                               existing destination that is not this
                               generator's own unedited output (has no
                               effect without --write-policy-doc).
  --issue-mediated              record the issue-authoring companion as
                               \`not installed\` in the policy document,
                               regardless of the transcript value.
  --target <dir>               target repository (default: current directory)
  --allow-root <dir>           additionally confine --target to this root,
                               on top of the current working directory
                               (#2216); repeat for more than one. A
                               filesystem root removes this confinement
                               guarantee entirely; a narrower but still
                               broad value (e.g. a home directory)
                               substantially widens it instead.
  --transcript <file>          path to the confirmed --hear transcript
  --help, -h                    show this help
`);
}
