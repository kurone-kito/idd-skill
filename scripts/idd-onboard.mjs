#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-onboard.mts
//
// The scripts/idd-onboard.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Onboarding automation CLI — wave 1: placeholder substitution (#1263,
// roadmap #1262). Wave 2 (#1292) adds the --import fetch/copy stage.
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
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isCliExecution } from './gh-exec.mjs';
import {
  collectHelperRuntimeEvidence,
  collectVendoredFiles,
  PROFILE_NAMES,
} from './helper-runtime-manifest.mjs';

function placeholder(name, kind, flag) {
  return { name, token: `{{${name}}}`, kind, flag };
}
/**
 * The seven placeholders, in the order of the "Final placeholder
 * meanings" table in `idd-template/docs/onboarding/placeholders.md`. The
 * drift test asserts this list matches that table exactly.
 */
export const ONBOARDING_PLACEHOLDERS = [
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
/**
 * Parse the owner and repository short name from a git remote URL.
 * Supports the common `https://`, `ssh://`, and scp-like
 * `git@host:owner/repo(.git)` forms, tolerating a trailing slash.
 * Returns `null` when the URL does not carry a repository path —
 * derivation then falls back to flags.
 */
export function parseRemoteRepoRef(url) {
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
export function deriveMarkerPrefix(repoName) {
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
export function escapeJsonStringContent(value) {
  return JSON.stringify(value).slice(1, -1);
}
/** Install command per detected Node.js package manager. */
const NODE_INSTALL_COMMANDS = {
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
};
/**
 * Python tool table from the reference (`pyproject.toml` tool section →
 * command). Patterns match the bare `[tool.x]` header and its dotted
 * sub-tables (`[tool.x.y]`), the common real-world shape.
 */
const PYPROJECT_TOOL_COMMANDS = [
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
function fileExists(root, name) {
  try {
    return lstatSync(join(root, name)).isFile();
  } catch {
    return false;
  }
}
/** Whether any filesystem entry exists at `root`/`name`, of any type. */
function pathExists(root, name) {
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
function hasNonDirectoryAncestor(root, relativePath) {
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
function readTextIfPresent(root, name) {
  try {
    return readFileSync(join(root, name), 'utf8');
  } catch {
    return null;
  }
}
/** Dependency tooling recognized by the derivation table. */
function hasAnyRecognizedTooling(targetDir) {
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
export function deriveInstallDepsCommand(targetDir) {
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
/**
 * Derive the three validate-command rows from the target tree per the
 * reference patterns: Node trees read the existing `package.json` scripts;
 * `go.mod` / `Cargo.toml` trees use the fixed rows; a tree with no
 * recognized tooling at all takes the no-op `true` rows. Anything else
 * stays unresolved so the operator supplies flags.
 */
export function deriveValidateCommands(targetDir) {
  const packageJsonText = readTextIfPresent(targetDir, 'package.json');
  if (packageJsonText !== null) {
    let scripts = {};
    try {
      const parsed = JSON.parse(packageJsonText);
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
/** Default remote-URL reader: `git -C <target> config remote.origin.url`. */
export function readGitRemoteUrl(targetDir) {
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
  targetDir,
  overrides = {},
  readers = {},
) {
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
  const derived = {
    REPO_NAME: remoteRef?.repo ?? null,
    PROJECT_MARKER_PREFIX:
      repoName !== null ? deriveMarkerPrefix(repoName) : null,
    TRUSTED_MARKER_ACTOR: null,
    FIX_VALIDATE_COMMANDS: validateRows.fixValidate,
    PRE_PUSH_VALIDATE_COMMANDS: validateRows.prePushValidate,
    POST_FIX_VALIDATE_COMMANDS: validateRows.postFixValidate,
    INSTALL_DEPS_COMMAND: deriveInstallDepsCommand(targetDir),
  };
  const values = {};
  const unresolved = [];
  for (const entry of ONBOARDING_PLACEHOLDERS) {
    const override = overrides[entry.name];
    let resolved = null;
    if (override !== undefined) {
      resolved = { value: override, source: 'flag' };
    } else if (derived[entry.name] !== null) {
      resolved = { value: derived[entry.name], source: 'derived' };
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
function isProbablyBinary(content) {
  return content.includes(0);
}
/**
 * Walk the target tree (excluding `.git` and `node_modules`, skipping
 * binary files) and collect every placeholder-shaped `{{...}}` token per
 * file, in ascending path order. Symlinks are deliberately not followed:
 * imported template files are regular files, and following links could
 * escape the target tree.
 */
export function scanPlaceholderTokens(targetDir) {
  const results = [];
  const compareEntryNames = (left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    return left.name > right.name ? 1 : 0;
  };
  const walk = (dir) => {
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
      const raw = readFileSync(absolute);
      if (isProbablyBinary(raw)) {
        continue;
      }
      const tokens = new Map();
      for (const match of raw
        .toString('utf8')
        .matchAll(PLACEHOLDER_TOKEN_PATTERN)) {
        tokens.set(match[0], (tokens.get(match[0]) ?? 0) + 1);
      }
      if (tokens.size > 0) {
        results.push({
          file: relative(targetDir, absolute).split('\\').join('/'),
          tokens,
        });
      }
    }
  };
  walk(targetDir);
  return results;
}
/**
 * Combine the token scan with the resolved values into the substitution
 * plan: known tokens with resolved values become plan entries; known
 * tokens without values become blocking residue (the reference's final
 * "verify that no `{{...}}` strings remain" pass for the seven); other
 * `{{...}}`-shaped tokens are reported informationally.
 */
export function buildSubstitutionPlan(scans, resolution) {
  const byToken = new Map(
    ONBOARDING_PLACEHOLDERS.map((entry) => [entry.token, entry]),
  );
  const entries = [];
  const residue = [];
  const unknownTokens = [];
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
 * count of files written.
 */
export function applySubstitutionPlan(targetDir, plan) {
  const byFile = new Map();
  for (const entry of plan.entries) {
    const tokens = byFile.get(entry.file) ?? new Map();
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
const CORE_TEMPLATE_BLOCK_ID = 'idd-template-core-files';
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
export function resolveCoreTemplateFiles(sourceRoot) {
  const manifestPath = join(sourceRoot, 'audit', 'sync-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `--source is not a readable idd-skill tree (missing or invalid audit/sync-manifest.json): ${error instanceof Error ? error.message : String(error)}`,
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
function isSafeRelativePath(relativePath) {
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
/**
 * Validate both sides of a manifest file entry with `isSafeRelativePath`
 * and return it unchanged, or throw a hard, fail-closed error naming
 * `origin` (the manifest source this entry came from). A path-safety
 * violation is manifest corruption, not an ordinary missing/blocked file,
 * so it is reported the same way as the other manifest-integrity checks
 * in this module (stripPrefix mismatch, duplicate target path): a thrown
 * usage/config error, never a soft `missingSource` / blocking-plan entry.
 */
function assertSafeManifestFile(file, origin) {
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
export function resolveImportFiles(sourceRoot, profile) {
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
  let vendoredFiles;
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
  const seenTargets = new Set();
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
function describeUnresolvedVendoredPath(sourceRoot, error) {
  const path = error?.path;
  if (typeof path === 'string') {
    return relative(sourceRoot, path).replaceAll('\\', '/');
  }
  return 'vendored-node helper bundle (unresolvable: unreadable helper source)';
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
  sourceRoot,
  targetRoot,
  { profile, force = false } = {},
) {
  const resolved = resolveImportFiles(sourceRoot, profile);
  const entries = [];
  const missingSource = [...resolved.missingSource];
  const blockedOverwrites = [];
  const nonFileTargetCollisions = [];
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
export function applyImportPlan(sourceRoot, targetRoot, plan) {
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
if (isCliExecution(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    // Usage/config errors exit 2, keeping exit 1 unambiguous as the
    // residue signal (same split as audit-pr-cleanup's fail()).
    process.stderr.write(
      `idd-onboard: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}
function parseArgs(argv) {
  const parsed = {
    substitute: false,
    importMode: false,
    source: undefined,
    target: '.',
    dryRun: false,
    force: false,
    profile: undefined,
    overrides: {},
    help: false,
  };
  const flagToName = new Map(
    ONBOARDING_PLACEHOLDERS.map((entry) => [entry.flag, entry.name]),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
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
function importOnlyFlagsPresent(args) {
  const present = [];
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
/** Substitute-only placeholder-override flags the user explicitly passed. */
function substituteOnlyFlagsPresent(args) {
  return ONBOARDING_PLACEHOLDERS.filter(
    (entry) => args.overrides[entry.name] !== undefined,
  ).map((entry) => entry.flag);
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.substitute && args.importMode) {
    throw new Error('--substitute and --import are mutually exclusive');
  }
  if (args.importMode) {
    // parseArgs collects every known flag regardless of the active stage,
    // so a stage-foreign flag (e.g. a placeholder override alongside
    // --import) would otherwise be silently ignored instead of reported.
    const foreign = substituteOnlyFlagsPresent(args);
    if (foreign.length > 0) {
      throw new Error(
        `--import does not accept substitute-only flag(s): ${foreign.join(', ')}`,
      );
    }
    runImportCli(args);
    return;
  }
  if (!args.substitute) {
    throw new Error('pass --substitute or --import to select a stage');
  }
  const foreign = importOnlyFlagsPresent(args);
  if (foreign.length > 0) {
    throw new Error(
      `--substitute does not accept import-only flag(s): ${foreign.join(', ')}`,
    );
  }
  const targetDir = resolve(args.target);
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`--target is not a directory: ${args.target}`);
  }
  const resolution = resolvePlaceholderValues(targetDir, args.overrides);
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
    filesChanged,
    written: canWrite && filesChanged > 0,
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Residue means the replacement pass cannot converge (an onboarding
  // placeholder would survive): signal it in dry-run and apply alike so
  // callers can gate on the exit code. Unknown tokens are informational.
  process.exit(plan.residue.length > 0 ? 1 : 0);
}
function runImportCli(args) {
  if (!args.source) {
    throw new Error('--import requires --source <idd-skill-tree>');
  }
  const sourceDir = resolve(args.source);
  if (!statSync(sourceDir).isDirectory()) {
    throw new Error(`--source is not a directory: ${args.source}`);
  }
  const targetDir = resolve(args.target);
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`--target is not a directory: ${args.target}`);
  }
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
function printHelp() {
  const flags = ONBOARDING_PLACEHOLDERS.map(
    (entry) =>
      `  ${entry.flag} <value>${entry.kind === 'command' ? ' (accepts the no-op "true")' : ''}`,
  ).join('\n');
  process.stdout.write(`usage: node scripts/idd-onboard.mjs --substitute [options]
       node scripts/idd-onboard.mjs --import --source <dir> --target <dir> [options]

Onboarding automation.

--substitute (wave 1): resolves the seven template placeholders for a
target tree that already contains the imported template files
(auto-derived from repository evidence where
idd-template/docs/onboarding/placeholders.md defines a derivation;
explicit flags override; --trusted-marker-actor is always explicit) and
rewrites the files. Prints a JSON verdict with the per-file,
per-placeholder plan, blocking residue (unresolved onboarding
placeholders), and informational unknown {{...}} tokens.

Exit codes: 0 converged; 1 residue would remain (apply writes nothing
in that case); 2 usage or configuration error.

  --substitute         run the substitution stage
  --target <dir>       target tree to rewrite (default: current directory)
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
  --profile <name>                  ${PROFILE_NAMES.join(' | ')}
  --force                           allow overwriting a differing target file
  --dry-run                         print the plan without writing anything
  --help, -h                        show this help
`);
}
