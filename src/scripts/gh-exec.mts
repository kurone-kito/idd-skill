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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

/** Optional `execFileSync` overrides accepted by {@link ghText}. */
export interface GhTextOptions {
  /**
   * Override child-process stdio. Most callers rely on `execFileSync`'s
   * own default (`pipe` for all three streams); `discover-viability-gate.mts`
   * explicitly ignores stdin (`['ignore', 'pipe', 'pipe']`) to avoid an
   * open-but-unwritten stdin pipe across its high-volume `gh` call loop.
   */
  stdio?: StdioOptions;
}

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
  }).trim();
}

/** {@link ghText}, swallowing any failure and returning `''` instead. */
export function safeGhText(args: string[]): string {
  try {
    return ghText(args);
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
    const status = Number((error as { status?: unknown } | null)?.status ?? -1);
    if (!allowStatuses.includes(status)) {
      throw error;
    }
    const stdout = String((error as { stdout?: unknown } | null)?.stdout ?? '');
    if (!/^\s*[[{]/.test(stdout)) {
      throw error;
    }
    raw = stdout;
  }
  const trimmed = raw.trim();
  if (paginate) {
    return trimmed ? parsePaginatedGhNdjson(trimmed) : [];
  }
  return JSON.parse(trimmed || '{}');
}

/**
 * True when this module is executing as the invoked CLI entry point
 * (`node <this-file>.mjs ...`), false when it is only imported (e.g. from
 * a test). Callers pass their own `import.meta.url`; the check itself
 * compares against `process.argv[1]`, as every existing per-helper copy
 * already does.
 */
export function isCliExecution(moduleUrl: string): boolean {
  return (
    Boolean(process.argv[1]) &&
    fileURLToPath(moduleUrl) === resolve(process.argv[1])
  );
}
