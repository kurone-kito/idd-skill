// idd-generated-from: src/scripts/gh-exec.mts
//
// The scripts/gh-exec.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Shared `gh` CLI execution helpers, extracted from ~22 per-helper copies
// of a synchronous `execFileSync('gh', ...) + trim` wrapper (see #1208).
// Also carries the CLI-entry-point detection helper: both concerns are
// about this process's relationship to its execution context (shelling
// out to `gh`, and recognizing whether this module *is* the invoked
// entry point) rather than any one helper's domain logic, so they share
// this module instead of splitting into a third small file.
//
// Consumed by the `src/scripts/*.mts` helpers that shell out to `gh` or
// need the CLI-entry-point guard.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePaginatedGhNdjson } from './protocol-helpers.mjs';
/**
 * Shared `{ stdio }` override for callers that invoke `gh` in a tight or
 * high-volume loop and want to avoid an open-but-unwritten stdin pipe, but
 * did not previously pair it with a timeout.
 */
export const GH_TEXT_LOOP_OPTIONS = {
  stdio: ['ignore', 'pipe', 'pipe'],
};
/**
 * Shared `{ stdio, timeout }` override for callers that invoke `gh` in a
 * tight or high-volume loop and previously paired the stdin-ignoring
 * override with a 30s timeout so a stalled `gh` invocation fails closed.
 */
export const GH_TEXT_LOOP_TIMEOUT_OPTIONS = {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30_000,
};
/**
 * Run `gh` synchronously and return its trimmed stdout.
 *
 * Throws (propagating the child-process error) on any non-zero exit —
 * callers that need to tolerate specific failures use {@link safeGhText}
 * or {@link ghApiJson}'s `allowStatuses` option instead.
 */
export function ghText(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
  }).trim();
}
/** {@link ghText}, swallowing any failure and returning `''` instead. */
export function safeGhText(args, options = {}) {
  try {
    return ghText(args, options);
  } catch {
    return '';
  }
}
/**
 * Run `gh api <path>` and parse its output as JSON, optionally paginating
 * (NDJSON-compatible) and/or tolerating specific failure statuses.
 *
 * Generalizes the two strictest existing per-helper variants this module
 * replaces: `advisory-wait-state.mts`'s NDJSON-pagination handling and
 * `review-activity-snapshot.mts`'s `allowStatuses` tolerated-failure
 * fallback.
 */
export function ghApiJson(path, options = {}) {
  const { paginate = false, extraArgs = [], allowStatuses = [] } = options;
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    args.push('--paginate', '--jq', '.[]');
  }
  let raw;
  try {
    raw = execFileSync('gh', args, { encoding: 'utf8' });
  } catch (error) {
    const failure = error;
    const status = Number(failure?.status ?? -1);
    if (!allowStatuses.includes(status)) {
      throw error;
    }
    const stdout = String(failure?.stdout ?? '');
    if (!/^\s*[[{]/.test(stdout)) {
      throw error;
    }
    raw = stdout;
  }
  if (paginate) {
    // parsePaginatedGhNdjson already trims and returns [] on empty input.
    return parsePaginatedGhNdjson(raw);
  }
  // JSON.parse itself ignores surrounding whitespace, so only trim to
  // decide whether the output was empty.
  return JSON.parse(raw.trim() || '{}');
}
/**
 * True when this module is executing as the invoked CLI entry point
 * (`node <this-file>.mjs ...`), false when it is only imported (e.g. from
 * a test). Callers pass their own `import.meta.url`; the check itself
 * compares against `process.argv[1]`, as every existing per-helper copy
 * already does.
 */
export function isCliExecution(moduleUrl) {
  return (
    Boolean(process.argv[1]) &&
    fileURLToPath(moduleUrl) === resolve(process.argv[1])
  );
}
