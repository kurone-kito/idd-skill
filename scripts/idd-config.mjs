// idd-generated-from: src/scripts/idd-config.mts
//
// The scripts/idd-config.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared `.github/idd/config.json` loader, extracted from 7 per-helper
// copies of a `readFileSync + JSON.parse`, null-on-any-error wrapper (see
// #1208). Adds lazy memoization on top of the identical existing
// semantics: the first call for a given resolved config path reads and
// parses the file; later calls for that same resolved path return the
// cached result without re-reading. Keying by the resolved path (rather
// than a single global flag) keeps the cache correct across
// `process.chdir()` — each working directory's config gets its own cache
// entry, which is what lets memoization coexist with the sandboxed,
// multi-cwd tests already covering `forcedHandoff.mode` resolution.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configCache = new Map();
/**
 * Read and parse `.github/idd/config.json` from the current working
 * directory, returning `null` when the file is missing, unreadable, or
 * not valid JSON — the existing fail-safe every per-helper copy already
 * implements: treat a missing or malformed config the same as "no policy
 * configured".
 *
 * Memoized per resolved config path for the lifetime of this process.
 */
export function loadIddConfig() {
  const path = resolve('.github/idd/config.json');
  const cached = configCache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    result = null;
  }
  configCache.set(path, result);
  return result;
}
