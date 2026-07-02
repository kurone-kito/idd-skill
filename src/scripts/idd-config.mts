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

import { readFileSync } from 'node:fs';

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
