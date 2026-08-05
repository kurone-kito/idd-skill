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
import { execFile, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parsePaginatedGhNdjson } from './protocol-helpers.mjs';
/**
 * Default `execFileSync`/`execFile` timeout (ms) applied when a caller
 * supplies none — the existing 30s convention already used at 54+
 * `GH_TEXT_LOOP_TIMEOUT_OPTIONS` call sites (#1675). Without this, a
 * stalled or credential-prompting `gh` invocation (rate limiting, network
 * stall, an unexpected interactive re-auth prompt) hangs the calling
 * helper indefinitely instead of failing closed into IDD's recovery
 * routing. An explicit caller-supplied `timeout` (including `0`, which
 * Node treats as "no timeout") always wins over this default.
 */
export const DEFAULT_GH_TIMEOUT_MS = 30_000;
/**
 * Default timeout (ms) for a **paginated** `gh api --paginate` call
 * (`{@link ghApiJson}` with `paginate: true`) when the caller supplies
 * none. `--paginate` makes `gh` walk every page of a list endpoint as
 * sequential HTTP round-trips inside one subprocess invocation, so the
 * single-request {@link DEFAULT_GH_TIMEOUT_MS} bound is too tight by
 * default for a response spanning more than a couple of pages. This
 * repo's paginated callers are PR/issue-scoped (review threads, comments,
 * timeline events — bounded in practice to a few pages), so a flat 4x
 * multiplier is a deliberately generous but still-bounded default rather
 * than an unbounded pass-through; callers with a legitimately different
 * bound (e.g. a large graph traversal) pass an explicit `timeout` to
 * override it. Recorded here so this default isn't re-litigated later.
 */
export const DEFAULT_GH_PAGINATED_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);
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
 * Applies {@link DEFAULT_GH_TIMEOUT_MS} when the caller supplies no
 * `timeout` (#1675) — a caller-supplied value, including `0`, always
 * wins.
 *
 * Throws (propagating the child-process error) on any non-zero exit —
 * callers that need to tolerate specific failures use {@link safeGhText}
 * or {@link ghApiJson}'s `allowStatuses` option instead.
 */
export function ghText(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
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
 * Async sibling of {@link ghText}, for callers that need several `gh`
 * subprocesses running concurrently (`execFileSync` serializes even
 * concurrent `await`s because it holds the event loop). Extracted from
 * `discover-roadmap-graph.mts`'s traversal hot-path loader (#1675) so
 * that file no longer needs its own direct `execFile('gh', ...)` call.
 *
 * `execFile` has no `stdio` option, so its default stdio does not ignore
 * stdin the way {@link GH_TEXT_LOOP_OPTIONS} does for the sync API. None
 * of this module's own callers pass `--input` or an `@-` field value (the
 * only ways `gh api` reads stdin), so `gh` itself never blocks on stdin
 * here — this still closes the child's stdin defensively so a future
 * caller can't silently reintroduce a stdin hang (mirrors the pattern
 * `discover-roadmap-graph.mts` used before this extraction).
 *
 * Trims stdout, matching {@link ghText}'s convention.
 */
export async function ghTextAsync(args, options = {}) {
  const run = execFileAsync('gh', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
    ...(options.maxBuffer !== undefined
      ? { maxBuffer: options.maxBuffer }
      : {}),
  });
  run.child.stdin?.end();
  const { stdout } = await run;
  return stdout.trim();
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
  const timeout =
    options.timeout ??
    (paginate ? DEFAULT_GH_PAGINATED_TIMEOUT_MS : DEFAULT_GH_TIMEOUT_MS);
  let raw;
  try {
    raw = execFileSync('gh', args, { encoding: 'utf8', timeout });
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
 * Run a `gh api graphql` query with variables, returning the parsed JSON
 * response. Extracted from `advisory-convergence.mts` (#1806) so
 * `review-clause.mts` (and any other future GraphQL caller) can reuse the
 * same query-execution wrapper instead of a second copy, matching this
 * file's existing role as the shared `gh`-execution module for `ghText` /
 * `ghApiJson`. Uses `ghText`'s own default timeout (no explicit override
 * here, unchanged from this function's pre-extraction behavior).
 */
export function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      args.push('-F', `${key}=${value}`);
      continue;
    }
    args.push('-f', `${key}=${value}`);
  }
  return JSON.parse(ghText(args).trim() || '{}');
}
const DEFAULT_BOUNDED_RETRY_ATTEMPTS = 3;
const DEFAULT_BOUNDED_RETRY_BASE_DELAY_MS = 200;
/**
 * Run `task`, retrying a bounded number of times on a retryable failure
 * (#1394): a transient `gh`/API hiccup (e.g. truncated captured stdout under
 * heavy concurrent load) no longer has to abort a whole caller-side
 * traversal when an immediate retry would have succeeded in isolation.
 *
 * Fail-closed is preserved: once the bounded attempts are exhausted, the
 * final attempt's error is rethrown unchanged — the exact same error
 * instance, never re-wrapped — so an existing caller-side classifier (e.g.
 * this module's own `allowStatuses` consumers, or a 404/access-style
 * predicate) still reads the identical shape it read before this wrapper
 * existed.
 */
export async function withBoundedRetry(task, options = {}) {
  const {
    attempts = DEFAULT_BOUNDED_RETRY_ATTEMPTS,
    baseDelayMs = DEFAULT_BOUNDED_RETRY_BASE_DELAY_MS,
    isRetryable = () => true,
  } = options;
  // A non-finite `attempts` (`NaN` from a failed parse, or `Infinity`)
  // would otherwise survive `Math.max`/`Math.trunc` unchanged (both are
  // no-ops on non-finite input) and make `attempt >= totalAttempts` never
  // true, defeating the whole bounded-attempt contract with an unbounded
  // retry loop (Copilot + Codex review, #1394). Fall back to the default
  // whenever the caller-supplied value is not a finite number. The same
  // guard applies to `baseDelayMs` for consistency: a non-finite backoff
  // would not break the bound (attempts still caps the loop), but would
  // silently skip the intended backoff/jitter delay between attempts.
  const totalAttempts = Number.isFinite(attempts)
    ? Math.max(1, Math.trunc(attempts))
    : DEFAULT_BOUNDED_RETRY_ATTEMPTS;
  const effectiveBaseDelayMs = Number.isFinite(baseDelayMs)
    ? baseDelayMs
    : DEFAULT_BOUNDED_RETRY_BASE_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= totalAttempts || !isRetryable(error)) {
        throw error;
      }
      await sleep(
        effectiveBaseDelayMs * attempt + Math.random() * effectiveBaseDelayMs,
      );
    }
  }
}
