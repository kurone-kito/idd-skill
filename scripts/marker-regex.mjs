// idd-generated-from: src/scripts/marker-regex.mts
//
// The scripts/marker-regex.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Shared helpers for building marker-detection regexes from a configurable
// marker prefix. Centralizing escapeRegex + createMarkerRegex keeps the
// discover-phase helpers (orphan filter, readiness check) from re-deriving
// the escaping rules, so an adopter's namespaced marker prefix flows through
// one regex builder instead of a per-file hardcoded literal.
/**
 * Escape every RegExp metacharacter in `value` so it can be embedded as a
 * literal inside a larger pattern. Used to make a configurable marker prefix
 * (which a namespaced adopter may write with `.`, `+`, `(`, ... ) safe to
 * interpolate into a marker regex.
 */
export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Build a case-insensitive detection regex for an HTML-comment marker of the
 * form `<!-- {prefix}-{suffix} ... -->`. The prefix is regex-escaped so a
 * namespaced adopter prefix cannot corrupt the pattern; the suffix is a fixed
 * internal literal (e.g. `roadmap-id`, `blocked-by`). The pattern is
 * detection-only — no capture group and non-global — so callers that must
 * extract the marker value build their own capturing regex from
 * {@link escapeRegex}.
 */
export function createMarkerRegex(prefix, suffix) {
  return new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-${suffix}\\b[\\s\\S]*?-->`,
    'i',
  );
}
