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

import type { StdioOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';

import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

/** Optional `execFileSync` overrides accepted by {@link ghText}. */
export interface GhTextOptions {
  /**
   * Override child-process stdio. Most callers rely on `execFileSync`'s
   * own default (`pipe` for all three streams); several high-volume-loop
   * callers instead ignore stdin (`['ignore', 'pipe', 'pipe']`) to avoid
   * an open-but-unwritten stdin pipe. See {@link GH_TEXT_LOOP_OPTIONS}.
   */
  stdio?: StdioOptions;
  /**
   * Override the `execFileSync` timeout (milliseconds). Several callers
   * pair this with the `stdio` override above so a stalled `gh` (rate
   * limiting, network stall, an unexpected interactive re-auth prompt)
   * fails closed instead of hanging indefinitely. See
   * {@link GH_TEXT_LOOP_TIMEOUT_OPTIONS}.
   */
  timeout?: number;
}

/**
 * Shared `{ stdio }` override for callers that invoke `gh` in a tight or
 * high-volume loop and want to avoid an open-but-unwritten stdin pipe, but
 * did not previously pair it with a timeout.
 */
export const GH_TEXT_LOOP_OPTIONS: GhTextOptions = {
  stdio: ['ignore', 'pipe', 'pipe'],
};

/**
 * Shared `{ stdio, timeout }` override for callers that invoke `gh` in a
 * tight or high-volume loop and previously paired the stdin-ignoring
 * override with a 30s timeout so a stalled `gh` invocation fails closed.
 */
export const GH_TEXT_LOOP_TIMEOUT_OPTIONS: GhTextOptions = {
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
export function ghText(args: string[], options: GhTextOptions = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
  }).trim();
}

/** {@link ghText}, swallowing any failure and returning `''` instead. */
export function safeGhText(
  args: string[],
  options: GhTextOptions = {},
): string {
  try {
    return ghText(args, options);
  } catch {
    return '';
  }
}

/** Options accepted by {@link ghApiJson}. */
export interface GhApiJsonOptions {
  /**
   * Paginate via `gh api --paginate --jq '.[]'`, parsing the NDJSON
   * output with the shared {@link parsePaginatedGhNdjson}. `--slurp` (a
   * single JSON array) landed in gh v2.48.0, but older `gh` releases
   * (e.g. the v2.45.0 Ubuntu 24.04 LTS ships via apt) only support the
   * NDJSON form, so this stays the compatible default.
   */
  paginate?: boolean;
  /** Extra arguments appended after the API path (e.g. `-f key=value`). */
  extraArgs?: string[];
  /**
   * `gh` exit statuses to tolerate: on a matching failure, return the
   * error's captured stdout (only when it looks like JSON) instead of
   * throwing.
   */
  allowStatuses?: number[];
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
export function ghApiJson(
  path: string,
  options: GhApiJsonOptions = {},
): unknown {
  const { paginate = false, extraArgs = [], allowStatuses = [] } = options;
  const args = ['api', path, ...extraArgs];
  if (paginate) {
    args.push('--paginate', '--jq', '.[]');
  }
  let raw: string;
  try {
    raw = execFileSync('gh', args, { encoding: 'utf8' });
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown } | null;
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

/** Options accepted by {@link withBoundedRetry}. */
export interface BoundedRetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /**
   * Base delay (ms) for the linear-ish backoff + jitter between attempts.
   * Default 200.
   */
  baseDelayMs?: number;
  /**
   * Retryable predicate, checked BEFORE consuming an extra attempt.
   * Returning `false` rethrows immediately, without waiting or re-invoking
   * `task` — this is how a caller keeps an already-classified non-transient
   * failure (e.g. a 404) short-circuiting to exactly one `task` invocation,
   * byte-identical to having no retry wrapper at all. Default: retry every
   * failure.
   */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_BOUNDED_RETRY_ATTEMPTS = 3;
const DEFAULT_BOUNDED_RETRY_BASE_DELAY_MS = 200;

/** `await`-able delay, used only for the backoff between retry attempts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

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
export async function withBoundedRetry<T>(
  task: () => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<T> {
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
      await delay(
        effectiveBaseDelayMs * attempt + Math.random() * effectiveBaseDelayMs,
      );
    }
  }
}
