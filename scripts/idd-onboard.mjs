#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-onboard.mts
//
// The scripts/idd-onboard.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Onboarding automation CLI — wave 1: placeholder substitution (#1263,
// roadmap #1262).
//
// Given a target tree that already contains the imported template files,
// resolve the seven onboarding placeholders (auto-derived from repository
// evidence where `idd-template/docs/onboarding/placeholders.md` defines a
// derivation; explicit flags override) and rewrite the files. `--dry-run`
// prints the per-file, per-placeholder plan without writing anything.
// That reference document is the source of truth this CLI must match; a
// drift test in tests/idd-onboard.test.mts fails on mismatch.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isCliExecution } from './gh-exec.mjs';
import { collectHelperRuntimeEvidence } from './helper-runtime-manifest.mjs';

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
 * JSON-escape a login for the quoted `trustedMarkerActors` array entry in
 * `config.json`: the template already provides the surrounding quotes, so
 * the substitution value is the escaped string *content* only.
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
function fileExists(root, name) {
  try {
    return statSync(join(root, name)).isFile();
  } catch {
    return false;
  }
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
    // The template's trustedMarkerActors entry is already quoted, so the
    // substitution value is JSON-escaped string content.
    if (resolved && entry.name === 'TRUSTED_MARKER_ACTOR') {
      resolved = {
        ...resolved,
        value: escapeJsonStringContent(resolved.value),
      };
    }
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
      entries.push({
        file: scan.file,
        placeholder: known.name,
        occurrences,
        from: token,
        to: resolved.value,
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
    target: '.',
    dryRun: false,
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
    if (token === '--target') {
      parsed.target = requireValue();
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = true;
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
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.substitute) {
    throw new Error(
      'wave 1 supports the substitution stage only: pass --substitute',
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
function printHelp() {
  const flags = ONBOARDING_PLACEHOLDERS.map(
    (entry) =>
      `  ${entry.flag} <value>${entry.kind === 'command' ? ' (accepts the no-op "true")' : ''}`,
  ).join('\n');
  process.stdout.write(`usage: node scripts/idd-onboard.mjs --substitute [options]

Onboarding automation — wave 1: placeholder substitution. Resolves the
seven template placeholders for a target tree that already contains the
imported template files (auto-derived from repository evidence where
idd-template/docs/onboarding/placeholders.md defines a derivation;
explicit flags override; --trusted-marker-actor is always explicit) and
rewrites the files. Prints a JSON verdict with the per-file,
per-placeholder plan, blocking residue (unresolved onboarding
placeholders), and informational unknown {{...}} tokens.

Exit codes: 0 converged; 1 residue would remain (apply writes nothing
in that case); 2 usage or configuration error.

  --substitute         run the substitution stage (required)
  --target <dir>       target tree to rewrite (default: current directory)
  --dry-run            print the plan without writing anything
  --help, -h           show this help

Placeholder overrides:
${flags}
`);
}
