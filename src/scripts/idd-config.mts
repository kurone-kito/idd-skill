// idd-generated-from: src/scripts/idd-config.mts
//
// The scripts/idd-config.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared `.github/idd/config.json` loader, extracted from 7 per-helper
// copies of a `readFileSync + JSON.parse`, null-on-any-error wrapper (see
// #1208).
//
// No memoization: an earlier revision of this module cached the parsed
// result per resolved config path, but `idd-merge-execute.mts` calls
// `collectPreMergeReadiness` (which reads this config) twice in the same
// process — once for the initial gate, once to deliberately re-validate
// "immediately before merging" and fail closed on drift (see that file's
// `runMergeExecute` doc comment). A memoized second read would silently
// reuse the first call's config even if `.github/idd/config.json` changed
// (e.g. a trusted-marker-actor login revoked) between the two calls,
// defeating exactly the drift this re-validation exists to catch. Every
// production call site reads this file at most once per process anyway,
// so memoization had no real payoff to justify that risk.
//
// `loadIddConfig()` below only covers the default, no-path case (#1208's
// original scope). #1721 adds `loadPolicyConfig()` beside it for the nine
// helpers that also accept an explicit `--policy`/`--config` path, with
// stricter failure semantics (see that function's doc comment).
// `loadIddConfig()`'s own null-on-any-error contract is deliberately left
// unchanged here: it has 11 existing callers that already rely on "missing,
// unreadable, or malformed config all collapse to null", and widening its
// blast radius to match `loadPolicyConfig()`'s stricter rules is a separate,
// wider-review change #1721 does not attempt. A later session may pick that
// residual up knowingly.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type EffectiveCritiqueLoopDelegate,
  inspectCritiqueLoopDelegateLayer,
  resolveEffectiveCritiqueLoopDelegate,
} from './policy-helpers.mts';

/**
 * Weakly-typed, partial view of `.github/idd/config.json`. Every field is
 * optional and the object accepts arbitrary additional keys — this is an
 * untrusted, adopter-controlled file, so callers must validate whatever
 * they read from it.
 */
export interface IddConfig {
  trustedMarkerActors?: unknown;
  advisoryBotLogins?: unknown;
  [key: string]: unknown;
}

/**
 * Read and parse `.github/idd/config.json` from the current working
 * directory, returning `null` when the file is missing, unreadable, or
 * not valid JSON — the existing fail-safe every per-helper copy already
 * implements: treat a missing or malformed config the same as "no policy
 * configured". Always re-reads the file; see the module header for why
 * this does not memoize.
 */
export function loadIddConfig(): IddConfig | null {
  try {
    return JSON.parse(
      readFileSync('.github/idd/config.json', 'utf8'),
    ) as IddConfig;
  } catch {
    return null;
  }
}

/** Default `.github/idd/config.json` path, relative to the process cwd. */
export const DEFAULT_POLICY_CONFIG_PATH = '.github/idd/config.json';

/** Result of {@link loadPolicyConfig}. */
export interface PolicyConfigLoad {
  /** Absolute path that was (or would have been) read. */
  path: string;
  /**
   * Parsed JSON content, or `null` only for the legitimate "repository has
   * no IDD config" case: no explicit path was given and the default path
   * does not exist (`ENOENT`).
   */
  config: unknown;
}

/**
 * Read and parse a policy config file for the nine `--policy`/`--config`
 * aware helpers (#1721), converging the read-and-parse failure semantics
 * `discover-shared-file-overlap.mts` originally documented on its own:
 *
 * - An explicitly-supplied `policyPath` (non-empty) throws on **any**
 *   failure — missing, unreadable, or malformed — naming the resolved path
 *   and the underlying message. An operator who passes `--policy` has
 *   stated that the file matters; silently falling back to defaults would
 *   discard that intent.
 * - The default path (`policyPath` empty or omitted) returns `{ config:
 *   null }` only when the file does not exist (`ENOENT`) — the legitimate
 *   "repository has no IDD config" case. A syntax error, permission error,
 *   or any other read failure on the default path still throws: an
 *   existing-but-broken config is never silently equivalent to "absent".
 * - A file that parses as valid JSON but whose top-level value is not a
 *   plain object (`null`, an array, a string, a number, a boolean) is
 *   rejected the same way as a syntax error, for both the explicit and
 *   default path. `JSON.parse('null')` succeeds and returns `null`, which
 *   — left unchecked — would be indistinguishable from this function's own
 *   "absent" sentinel and silently re-open exactly the fail-open gap this
 *   function exists to close.
 *
 * Callers keep their own shape normalization (field extraction, defaults
 * for individual fields, etc.) on top of the raw `config` this returns —
 * this function converges only the read-and-parse step, not per-helper
 * field semantics. `loadIddConfig()` above is intentionally not reused
 * here: its null-on-any-error contract does not distinguish "absent" from
 * "malformed", which is exactly the distinction this function exists to
 * make.
 */
export function loadPolicyConfig(policyPath?: string): PolicyConfigLoad {
  const explicit = typeof policyPath === 'string' && policyPath.length > 0;
  const path = resolve(
    process.cwd(),
    explicit ? policyPath : DEFAULT_POLICY_CONFIG_PATH,
  );
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(parsed)) {
      // A syntactically-valid top-level scalar/array/`null` is still a
      // malformed *policy config* -- reject it the same way a syntax error
      // is rejected below, rather than letting `JSON.parse('null')` in
      // particular masquerade as this function's own "absent" sentinel.
      throw new Error(
        `expected a JSON object at the top level, got ${describeJsonValueKind(parsed)}`,
      );
    }
    return { path, config: parsed };
  } catch (error) {
    if (!explicit && isEnoentError(error)) {
      return { path, config: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load policy from ${path}: ${message}`);
  }
}

/** True when `value` is a non-null, non-array JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short human-readable description of a non-object parsed JSON value. */
function describeJsonValueKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/**
 * True for a config-root that cannot be resolved against the process cwd.
 * Accepts POSIX `/…` (not `//…`) and Windows drive-letter or UNC roots.
 * Rejects relative paths and Windows current-drive roots such as `\config`,
 * which `path.isAbsolute` treats as absolute on win32.
 */
function isQualifiedConfigRoot(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return true;
  }
  // POSIX `/…` is only a cwd-independent root off Windows. On win32,
  // `/config` and Git Bash `/c/Users/…` become a current-drive path.
  if (process.platform === 'win32') {
    return false;
  }
  return value.startsWith('/') && !value.startsWith('//');
}

/** True when `error` is a Node.js filesystem error with `code: 'ENOENT'`. */
function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Directory name under XDG/`$HOME/.config` for the operator-global IDD file. */
export const USER_GLOBAL_CONFIG_DIRNAME = 'idd-skill';

/** Basename of the operator-global IDD policy file. */
export const USER_GLOBAL_CONFIG_FILENAME = 'config.json';

export interface UserGlobalConfigPathOptions {
  /**
   * Environment used to resolve `XDG_CONFIG_HOME` then `HOME`. When
   * provided, `process.env` is not consulted — tests inject a sandbox
   * env so the real operator configuration is never read.
   */
  env?: NodeJS.ProcessEnv;
  /** Explicit `$HOME` override, consulted after `XDG_CONFIG_HOME`. */
  homedir?: string;
}

export interface UserGlobalPolicyDocumentLoad {
  status: 'absent' | 'present';
  path?: string;
  config?: unknown;
}

export interface ResolveEffectiveCritiqueLoopDelegateFromEnvOptions {
  /** Raw repository-local policy object. When omitted, load from disk. */
  localConfig?: unknown;
  /** Path forwarded to {@link loadPolicyConfig} when `localConfig` is omitted. */
  localPolicyPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected user-global file path; skips XDG/`HOME` resolution. */
  globalConfigPath?: string;
  homedir?: string;
}

/**
 * Resolve the user-global IDD config path: `$XDG_CONFIG_HOME/idd-skill/config.json`
 * when `XDG_CONFIG_HOME` is a non-empty string, otherwise
 * `$HOME/.config/idd-skill/config.json`. Returns `undefined` when neither
 * base directory is available. Never calls `os.homedir()`.
 */
export function resolveUserGlobalConfigPath(
  options?: UserGlobalConfigPathOptions,
): string | undefined {
  const env = options?.env ?? process.env;
  const xdg =
    typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  if (xdg.length > 0 && isQualifiedConfigRoot(xdg)) {
    return join(xdg, USER_GLOBAL_CONFIG_DIRNAME, USER_GLOBAL_CONFIG_FILENAME);
  }

  const homeCandidate =
    typeof options?.homedir === 'string' && options.homedir.length > 0
      ? options.homedir
      : typeof env.HOME === 'string'
        ? env.HOME
        : '';
  const home = homeCandidate.trim();
  if (home.length === 0 || !isQualifiedConfigRoot(home)) {
    return undefined;
  }
  return join(
    home,
    '.config',
    USER_GLOBAL_CONFIG_DIRNAME,
    USER_GLOBAL_CONFIG_FILENAME,
  );
}

/**
 * Read the operator-global policy file for C1 delegate inheritance.
 *
 * Missing, unreadable, non-JSON, and non-object documents are `absent`
 * (non-fatal). Callers must not merge any key other than
 * `critiqueLoop.delegate` into repository policy — pass the document to
 * {@link resolveEffectiveCritiqueLoopDelegate}, which reads only that
 * fragment. Opt-in to local C1 execution; CI and merge helpers must not
 * call this.
 */
export function loadUserGlobalPolicyDocument(options?: {
  env?: NodeJS.ProcessEnv;
  path?: string;
  homedir?: string;
}): UserGlobalPolicyDocumentLoad {
  const path =
    typeof options?.path === 'string' && options.path.length > 0
      ? options.path
      : resolveUserGlobalConfigPath(options);
  if (path === undefined) {
    return { status: 'absent' };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { status: 'absent', path };
    }
    return { status: 'present', path, config: parsed };
  } catch {
    return { status: 'absent', path };
  }
}

/**
 * Opt-in C1 entry: resolve the effective critique delegate from the
 * repository-local document plus an optional user-global file. Does not
 * run as a side effect of {@link loadIddConfig} or {@link loadPolicyConfig}.
 */
export function resolveEffectiveCritiqueLoopDelegateFromEnv(
  options?: ResolveEffectiveCritiqueLoopDelegateFromEnvOptions,
): EffectiveCritiqueLoopDelegate {
  const localConfig =
    options && Object.hasOwn(options, 'localConfig')
      ? options.localConfig
      : loadPolicyConfig(options?.localPolicyPath).config;

  const local = inspectCritiqueLoopDelegateLayer(localConfig);
  if (local.status !== 'absent') {
    return resolveEffectiveCritiqueLoopDelegate({ localConfig });
  }

  const global = loadUserGlobalPolicyDocument({
    env: options?.env,
    path: options?.globalConfigPath,
    homedir: options?.homedir,
  });

  return resolveEffectiveCritiqueLoopDelegate({
    localConfig,
    globalConfig: global.status === 'present' ? global.config : undefined,
  });
}
