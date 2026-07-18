// idd-generated-from: src/scripts/gh-http-status.mts
//
// The scripts/gh-http-status.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Shared HTTP-status derivation for failed `gh api` invocations.
//
// `gh` exits with process code 1 for 401, 403, and 404 alike, so the
// child-process exit status is useless for HTTP classification. The real
// status appears in gh's stderr as `(HTTP NNN)`, or in a JSON error body's
// `"status"` field. Discovery helpers use this to fail closed on auth /
// rate-limit / network failures instead of misreading them as a genuine
// 404. Consumed by:
//
// - scripts/discover-viability-gate.mjs (A4 viability gate)
// - scripts/discover-readiness-check.mjs (A3 readiness check)
/**
 * Derive the real HTTP status code from a failed `gh` invocation error.
 *
 * Inspects the error's `stderr`, `stdout`, and `message` text for either
 * gh's `(HTTP NNN)` suffix or a JSON error body carrying a `"status"`
 * field. Returns the numeric status, or null when no status can be
 * determined — callers must fail closed on null (treat it as a tool
 * failure, not a genuine 404).
 */
export function deriveGhHttpStatus(error) {
  const text = ghErrorText(error);
  if (!text) {
    return null;
  }
  // Primary signal: gh prints the real status as `(HTTP NNN)` on stderr.
  const httpMatch = text.match(/\(HTTP (\d{3})\)/);
  if (httpMatch) {
    return Number.parseInt(httpMatch[1], 10);
  }
  // Fallback: a JSON error body may carry a "status" field, as a string
  // (e.g. {"message":"Not Found","status":"404"}) or a number.
  const jsonMatch = text.match(/"status"\s*:\s*"?(\d{3})"?/);
  if (jsonMatch) {
    return Number.parseInt(jsonMatch[1], 10);
  }
  return null;
}
/**
 * Extract the most useful diagnostic text from a failed `gh` invocation (an
 * `execFileSync`-shaped error): stderr first (where `gh` writes most error
 * explanations), then stdout, then the generic Error message, joined so a
 * caller's pattern match sees every available detail regardless of which
 * stream `gh` used. Coerces any non-null value via `String(...)` (not a
 * strict `typeof === 'string'` check) so a `Buffer`-valued stream — e.g. an
 * `execFileSync` call made without `{ encoding: 'utf8' }` — still yields
 * readable text instead of being silently dropped. Exported for reuse by
 * other `gh`-invoking helpers (e.g. `idd-merge-execute.mts`'s solo-CODEOWNER
 * `--admin` fallback, #1521) instead of each hand-rolling its own copy.
 */
export function ghErrorText(error) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const candidate = error;
  return [candidate.stderr, candidate.stdout, candidate.message]
    .map((value) => (value == null ? '' : String(value)))
    .filter((value) => value.length > 0)
    .join('\n');
}
