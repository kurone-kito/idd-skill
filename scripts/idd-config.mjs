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
import { resolve } from 'node:path';
/**
 * Read and parse `.github/idd/config.json` from the current working
 * directory, returning `null` when the file is missing, unreadable, or
 * not valid JSON — the existing fail-safe every per-helper copy already
 * implements: treat a missing or malformed config the same as "no policy
 * configured". Always re-reads the file; see the module header for why
 * this does not memoize.
 */
export function loadIddConfig() {
  try {
    return JSON.parse(readFileSync('.github/idd/config.json', 'utf8'));
  } catch {
    return null;
  }
}
/** Default `.github/idd/config.json` path, relative to the process cwd. */
export const DEFAULT_POLICY_CONFIG_PATH = '.github/idd/config.json';
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
 *
 * Callers keep their own shape normalization (field extraction, defaults
 * for individual fields, etc.) on top of the raw `config` this returns —
 * this function converges only the read-and-parse step, not per-helper
 * field semantics. `loadIddConfig()` above is intentionally not reused
 * here: its null-on-any-error contract does not distinguish "absent" from
 * "malformed", which is exactly the distinction this function exists to
 * make.
 */
export function loadPolicyConfig(policyPath) {
  const explicit = typeof policyPath === 'string' && policyPath.length > 0;
  const path = resolve(
    process.cwd(),
    explicit ? policyPath : DEFAULT_POLICY_CONFIG_PATH,
  );
  try {
    return { path, config: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    if (!explicit && isEnoentError(error)) {
      return { path, config: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load policy from ${path}: ${message}`);
  }
}
/** True when `error` is a Node.js filesystem error with `code: 'ENOENT'`. */
function isEnoentError(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
