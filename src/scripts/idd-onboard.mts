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
// mismatch.
//
// --verify: mechanical pass/fail for a target tree after --import and
// --substitute have run, replacing a manual walkthrough of
// `idd-template/ONBOARDING.md` Step 6 with three check groups: manifest
// completeness (reuses --import's own manifest resolution — no second file
// list), placeholder residue (reuses --substitute's scanner — no second
// scan), and a stale-import signal (re-runs idd-doctor's content-based
// drift detector against the target's imported files instead of forking its
// logic, the #1208 shared-module convention `check-pnpm-boundary.mts`
// already uses).

import { execFileSync } from 'node:child_process';
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

import { stripLeadingArgumentSeparator } from './cli-args.mts';
import { safeGhText } from './gh-exec.mts';
import {
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
import { inspectDevelopmentBranch } from './policy-helpers.mts';
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
 * regular files, and following links could escape the target tree.
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

/** The full dry-run/apply plan for one target tree. */
export interface SubstitutionPlan {
  entries: SubstitutionPlanEntry[];
  /** Unresolved onboarding placeholders — blocking (exit 1). */
  residue: SubstitutionResidueEntry[];
  /**
   * Placeholder-shaped tokens outside the seven — informational only.
   * Wave 1 cannot tell an adopter's own template token (handlebars,
   * mustache, …) from copied-template residue because the copy stage
   * that records the imported file set is a later wave, so these are
   * reported for the operator instead of failing the run.
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
  | 'blocked-non-file';

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
}

/**
 * Build the import plan: classify each manifest file as `new` (no target
 * path yet), `unchanged` (target already matches byte-for-byte — a safe
 * no-op), `overwrite` (target exists as a file and differs), or
 * `blocked-non-file` (target path exists but is not a regular file, e.g. a
 * directory — always blocking, see `nonFileTargetCollisions`). An
 * `overwrite` entry is also recorded in `blockedOverwrites` unless `force`
 * is set — the fail-closed default refuses to clobber a differing target
 * file. A missing declared source file is recorded in `missingSource`
 * instead of a plan entry.
 */
export function buildImportPlan(
  sourceRoot: string,
  targetRoot: string,
  { profile, force = false }: { profile?: string; force?: boolean } = {},
): ImportPlan {
  const resolved = resolveImportFiles(sourceRoot, profile);
  const entries: ImportPlanEntry[] = [];
  const missingSource: string[] = [...resolved.missingSource];
  const blockedOverwrites: string[] = [];
  const nonFileTargetCollisions: string[] = [];
  for (const file of resolved.files) {
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
  return { entries, missingSource, blockedOverwrites, nonFileTargetCollisions };
}

/**
 * Apply the plan: copy every `new` or `overwrite` entry (skipping
 * `unchanged` entries, which already match, and `blocked-non-file`
 * entries, which can never be copied onto), creating parent directories
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
      entry.classification === 'blocked-non-file'
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

/** Placeholder-residue result: blocking residue plus informational tokens. */
export interface PlaceholderResidueResult {
  residue: SubstitutionResidueEntry[];
  unknownTokens: UnknownTokenEntry[];
}

/**
 * Scan the target tree for leftover `{{...}}` tokens after onboarding.
 * Reuses wave 1's `scanPlaceholderTokens` / `buildSubstitutionPlan` scanner
 * rather than a new scan: verify mode has no resolved substitution values to
 * consult (an empty resolution), so `buildSubstitutionPlan` puts every
 * occurrence of one of the seven onboarding placeholder tokens into
 * `residue` — the correct outcome here, since a converged onboarding run
 * should have already replaced them. Other `{{...}}`-shaped tokens land in
 * `unknownTokens`, informational just as they are for `--substitute`.
 */
export function checkPlaceholderResidue(
  targetRoot: string,
): PlaceholderResidueResult {
  const plan = buildSubstitutionPlan(scanPlaceholderTokens(targetRoot), {
    values: {},
    unresolved: [],
  });
  return { residue: plan.residue, unknownTokens: plan.unknownTokens };
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

/** The combined wave-3 verify verdict for one target tree. */
export interface VerifyResult {
  manifestCompleteness: ManifestCompletenessResult;
  placeholderResidue: PlaceholderResidueResult;
  staleImportSignal: StaleImportSignalResult;
  /** True when a blocking finding exists (manifest gap or placeholder residue). */
  blocking: boolean;
}

/**
 * Run all three wave-3 check groups against one target tree. The
 * stale-import signal never contributes to `blocking` (see
 * `checkStaleImportSignal`'s doc comment); only a manifest gap or
 * placeholder residue can fail verify, matching the exit contract in
 * `runVerifyCli`.
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
  const placeholderResidue = checkPlaceholderResidue(targetRoot);
  const staleImportSignal = checkStaleImportSignal(targetRoot);
  const blocking =
    manifestCompleteness.missingSource.length > 0 ||
    manifestCompleteness.missingTarget.length > 0 ||
    placeholderResidue.residue.length > 0;
  return {
    manifestCompleteness,
    placeholderResidue,
    staleImportSignal,
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
 * Render the filled `## IDD Policy Configuration` Markdown document from
 * a confirmed transcript's answers, following the structure shown in
 * `idd-template/docs/onboarding/policy-decisions.md`'s
 * "Recording the selected policies" section. An item with no confirmed
 * answer is omitted rather than printed with a placeholder value.
 */
function buildFilledPolicyDocument(answers: readonly HearAnswer[]): string {
  const valueById = new Map(answers.map((answer) => [answer.id, answer.value]));
  const sections = RECORD_POLICY_DOC_ROWS.filter((row) =>
    valueById.has(row.id),
  ).map((row) => {
    const value = valueById.get(row.id) as string;
    const body = row.renderBody
      ? row.renderBody(value)
      : `**${row.label}**: \`${value}\``;
    return `### ${row.heading}\n\n${body}`;
  });
  return [
    '## IDD Policy Configuration',
    '',
    'This repository uses the following IDD policies:',
    '',
    sections.join('\n\n'),
  ].join('\n');
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
  const policyDocument = buildFilledPolicyDocument(transcript.answers);
  // --dry-run always wins over --apply, matching runImportCli's convention.
  const canWrite = args.apply && !args.dryRun;
  if (canWrite) {
    writeFileSync(configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
    if (args.writePolicyDoc) {
      writeFileSync(resolve(args.writePolicyDoc), `${policyDocument}\n`);
    }
  }
  const verdict = {
    protocolVersion: '1',
    mode: canWrite ? 'apply' : 'dry-run',
    target: targetDir,
    transcript: resolve(args.transcript),
    configPatch: renderPatchForVerdict(patch),
    policyDocument,
    writtenPolicyDocPath:
      canWrite && args.writePolicyDoc ? resolve(args.writePolicyDoc) : null,
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
 * never substitutes), plus `--force` and `--dry-run` (verify never writes, so
 * "allow overwriting" and "print the plan without writing" are both
 * meaningless for it).
 */
function verifyForeignFlagsPresent(args: ParsedArgs): string[] {
  const present = substituteOnlyFlagsPresent(args);
  if (args.force) {
    present.push('--force');
  }
  if (args.dryRun) {
    present.push('--dry-run');
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
    // which --record-policy shares and must accept.
    const foreign = [
      ...importOnlyFlagsPresent(args),
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
  const plan = buildSubstitutionPlan(
    scanPlaceholderTokens(targetDir),
    resolution,
  );
  // Fail closed: never write a half-substituted tree. Apply mode writes
  // only when every scanned onboarding placeholder resolved.
  const canWrite = !args.dryRun && plan.residue.length === 0;
  const filesChanged = canWrite ? applySubstitutionPlan(targetDir, plan) : 0;
  const verdict = {
    protocolVersion: '1',
    mode: args.dryRun ? 'dry-run' : 'apply',
    target: targetDir,
    values: resolution.values,
    unresolved: resolution.unresolved,
    plan: plan.entries,
    residue: plan.residue,
    unknownTokens: plan.unknownTokens,
    skippedPaths: listSkippedPlaceholderPaths(targetDir),
    filesChanged,
    written: canWrite && filesChanged > 0,
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
    staleImportSignal: result.staleImportSignal,
    blocking: result.blocking,
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Blocking findings (manifest gap or placeholder residue) signal via exit
  // 1, matching --substitute / --import's contract; the stale-import signal
  // is informational only and never flips this exit code (see
  // checkStaleImportSignal / runVerify).
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
       node scripts/idd-onboard.mjs --record-policy --transcript <file> --target <dir> [--apply] [--write-policy-doc <path>]

Onboarding automation.

--substitute (wave 1): resolves the seven template placeholders for a
target tree that already contains the imported template files
(auto-derived from repository evidence where
idd-template/docs/onboarding/placeholders.md defines a derivation;
explicit flags override; --trusted-marker-actor is always explicit) and
rewrites the files. Skips the placeholder-reference meta-docs
(docs/onboarding/placeholders.md, docs/customization.md,
docs/onboarding/policy-decisions.md), which document the tokens rather
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
                       resolves outside both
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
blocking findings. Prints a JSON verdict with the per-file plan
(new / unchanged / overwrite / blocked-non-file classification) and the
blocking findings.

Exit codes: 0 converged; 1 a blocking finding exists (apply writes
nothing in that case); 2 usage or configuration error.

  --import                          run the import stage
  --source <dir>                    local idd-skill source tree to copy from
  --target <dir>                    target repository (default: current directory)
  --allow-root <dir>                additionally confine --source / --target
                                     to this root, on top of the current
                                     working directory (#2216); repeat for
                                     more than one
  --profile <name>                  ${PROFILE_NAMES.join(' | ')}
  --force                           allow overwriting a differing target file
  --dry-run                         print the plan without writing anything
  --help, -h                        show this help

--verify (wave 3): mechanical pass/fail for a target tree after --import and
--substitute have run, in place of a manual walkthrough of
idd-template/ONBOARDING.md Step 6. Reports three check groups:
manifestCompleteness (every file --import would copy for --source /
--profile exists under --target, reusing that same manifest resolution —
missing files are blocking), placeholderResidue (leftover {{...}} tokens via
--substitute's own scanner — a remaining onboarding placeholder is blocking
residue, any other {{...}}-shaped token stays informational), and
staleImportSignal (idd-doctor's content-based stale-import detector re-run
against the target's imported files — informational only, never blocking).

Exit codes: 0 no blocking finding; 1 a blocking finding exists (manifest gap
or placeholder residue); 2 usage or configuration error.

  --verify                           run the verify stage
  --source <dir>                     local idd-skill source tree the target was imported from
  --target <dir>                     target repository to verify (default: current directory)
  --allow-root <dir>                 additionally confine --source / --target
                                      to this root, on top of the current
                                      working directory (#2216); repeat for
                                      more than one
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
                               (#2216); repeat for more than one
  --answers <file>              path to the --apply answers JSON file
  --help, -h                    show this help

--record-policy (#2282): consumes a confirmed --hear transcript's
policy-kind answers. Post-import only: --target must already contain
.github/idd/config.json. Never edits ONBOARDING.md, CLAUDE.md,
AGENTS.md, or GEMINI.md.

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
                               template is stdout-only.
  --target <dir>               target repository (default: current directory)
  --allow-root <dir>           additionally confine --target to this root,
                               on top of the current working directory
                               (#2216); repeat for more than one
  --transcript <file>          path to the confirmed --hear transcript
  --help, -h                    show this help
`);
}
