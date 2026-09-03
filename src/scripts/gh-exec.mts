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
import { execFile, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { deriveGhHttpStatus } from './gh-http-status.mts';
import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

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
   * Override the `execFileSync` timeout (milliseconds). Defaults to
   * {@link DEFAULT_GH_TIMEOUT_MS} when omitted; pass `0` for no timeout.
   * Several callers pair an explicit override with the `stdio` override
   * above so a stalled `gh` fails closed with the same stdin-ignoring
   * shape. See {@link GH_TEXT_LOOP_TIMEOUT_OPTIONS}.
   */
  timeout?: number;
  /**
   * Data written to the child's stdin (e.g. `gh api --input -` reading a
   * JSON document from stdin — the mandatory path for posting an
   * HTML-comment-first marker body, which `gh issue comment` / `gh api -f
   * body=` silently drop). No current caller combines this with `stdio`,
   * so in practice it is set alone — but combining them is well-defined,
   * not undefined behavior: per Node's `child_process.execFileSync` docs,
   * supplying `input` always overrides `stdio[0]` (stdin), regardless of
   * what `stdio[0]` requests, so a caller that did pass both would still
   * get its `input` written and would not need to omit `stdio` to avoid a
   * conflict (CodeRabbit review, #1784).
   */
  input?: string;
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
 * Applies {@link DEFAULT_GH_TIMEOUT_MS} when the caller supplies no
 * `timeout` (#1675) — a caller-supplied value, including `0`, always
 * wins.
 *
 * Throws (propagating the child-process error) on any non-zero exit —
 * callers that need to tolerate specific failures use {@link safeGhText}
 * or {@link ghApiJson}'s `allowStatuses` option instead.
 */
export function ghText(args: string[], options: GhTextOptions = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
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

/**
 * Live GitHub default branch for `{owner}/{repo}` (#2272), via `gh api
 * repos/{owner}/{repo}` and the `default_branch` field. Extracted here so
 * `pre-merge-readiness.mts`, `ci-wait-state.mts`, `branch-conflict-state.mts`,
 * and `idd-merge-execute.mts` share one reader instead of four near-identical
 * `gh api` calls, matching this module's existing role as the shared `gh`
 * CLI layer. Returns `null` on any failure (unreadable, unauthenticated,
 * missing repo) so callers treat the branch as undetermined rather than
 * throwing -- distinct from `idd-onboard.mts`'s own `readGithubDefaultBranch`,
 * which derives `owner`/`repo` from a local checkout's `remote.origin.url`
 * instead of accepting them directly.
 */
export function readGithubRepoDefaultBranch(
  owner: string,
  repo: string,
): string | null {
  const output = safeGhText(
    ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch // empty'],
    GH_TEXT_LOOP_OPTIONS,
  );
  return output === '' ? null : output;
}

/** Optional overrides accepted by {@link ghTextAsync}. */
export interface GhTextAsyncOptions {
  /**
   * Override the `execFile` timeout (milliseconds). Defaults to
   * {@link DEFAULT_GH_TIMEOUT_MS} when omitted; a caller-supplied value,
   * including `0`, always wins.
   */
  timeout?: number;
  /**
   * Override the per-stream buffer cap (bytes). `execFile`'s own default
   * is 1 MiB; a caller expecting a larger response (e.g. a paginated
   * GraphQL page) raises this explicitly rather than risking a silent
   * truncation.
   */
  maxBuffer?: number;
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
export async function ghTextAsync(
  args: string[],
  options: GhTextAsyncOptions = {},
): Promise<string> {
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
  /**
   * Override the `execFileSync` timeout (milliseconds). Defaults to
   * {@link DEFAULT_GH_TIMEOUT_MS} for a non-paginated call, or
   * {@link DEFAULT_GH_PAGINATED_TIMEOUT_MS} when `paginate` is `true`
   * (#1675) — a caller-supplied value, including `0`, always wins over
   * either default.
   */
  timeout?: number;
}

/**
 * Resolve the `--hostname` override {@link ghApiJson} / {@link ghGraphql}
 * pass to `gh api` / `gh api graphql`, so a self-hosted GitHub Enterprise
 * Server (GHES) repository's GitHub-API-backed calls target the correct
 * host instead of silently defaulting to `api.github.com` (#1962).
 *
 * `gh api` resolves its target host from `GH_HOST` / `--hostname`, or the
 * CLI's single configured/authenticated host, defaulting to `github.com`
 * -- unlike higher-level subcommands (`gh pr view`, `gh issue edit`, ...),
 * it does **not** infer the host from the checked-out repository's Git
 * remote (`gh help environment`). On a GHES-hosted repository running in
 * GitHub Actions, this means an unset `GH_HOST` still sends these calls to
 * `api.github.com` using `GH_TOKEN`, and `GH_ENTERPRISE_TOKEN` (set
 * alongside it by #1946) is never read at all, even though the workflow
 * itself is genuinely running against the GHES host.
 *
 * Resolution order:
 *
 * 1. `GH_HOST`, when set -- `gh` already reads this itself (`gh help
 *    environment`), so no `--hostname` override is needed here; returning
 *    `undefined` avoids a second, potentially-redundant resolution path
 *    for a case `gh` already handles, and leaves an operator's explicit
 *    override unchanged.
 * 2. `GITHUB_SERVER_URL` -- a GitHub Actions **default** environment
 *    variable present in every job (no workflow `env:` entry required),
 *    always a well-formed `scheme://host` URL supplied by the runner
 *    itself (`https://github.com` or `https://<ghes-host>`), so this
 *    strips the scheme instead of parsing untrusted input. When the
 *    stripped host equals `github.com` (the overwhelming common case,
 *    including every run of this repository's own CI), this returns
 *    `undefined` so the emitted argv stays byte-identical to before this
 *    change -- the "no behavior change on github.com" half of #1962's
 *    acceptance criteria.
 * 3. Otherwise (a non-Actions caller with no `GH_HOST` set, e.g. a local
 *    `idd-doctor` run) -- `undefined`. `gh`'s own "single authenticated
 *    host" default already resolves correctly for a developer
 *    authenticated only to their GHES instance; a developer authenticated
 *    to more than one host sets `GH_HOST` themselves (case 1), the same
 *    convention `gh` itself documents. This deliberately adds no
 *    git-remote-derived fallback here (contrast
 *    `branch-conflict-state.mts`'s `resolveFetchOrigin`, which fetches
 *    from a remote and has no other host signal available): that would
 *    widen this change beyond `gh-exec.mts`'s two wrappers and risks
 *    silently overriding a `gh` config that was already resolving
 *    correctly. See `idd-template/ONBOARDING.md`'s GHES host-resolution
 *    note for the fuller design record, including the still-open gap for
 *    helpers (e.g. `idd-doctor.mts`) that call `gh api` directly instead
 *    of through this module's shared wrappers.
 */
export function resolveGhApiHostname(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.GH_HOST?.trim()) return undefined;
  const serverUrl = env.GITHUB_SERVER_URL?.trim();
  if (!serverUrl) return undefined;
  const host = serverUrl
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return host && host !== 'github.com' ? host : undefined;
}

/**
 * #2454: the majority of `src/scripts/*.mts` accept a split `--owner
 * <owner> --repo <name>` pair; five scripts (`audit-pr-cleanup.mts`,
 * `live-status-digest.mts`, `token-cost-harvest.mts`,
 * `local-validation-evidence.mts`, `provider-outage-declaration.mts`)
 * instead accept only a combined `--repo <owner>/<name>`. Rewriting the
 * majority onto the combined form (or vice versa) is out of scope; this
 * helper lets the five minority scripts accept EITHER form while
 * changing nothing else about their own resolution pipeline: it folds a
 * split pair into the single combined string each script's own existing
 * parser (or default-repo fallback) already consumes, so a caller only
 * has to route its `--owner`/`--repo` flags through this function once,
 * immediately after `parseCliArgs`, and every downstream line is
 * unchanged.
 *
 * - Neither flag given → returns `args.repo` unchanged (`undefined` or
 *   the caller's own empty-string default), so the caller's existing
 *   default-repo resolution (a `gh repo view` fallback, or a hard
 *   "--repo is required" error, depending on the script) still runs
 *   exactly as before.
 * - Only `--repo` given → returned unchanged, whether it is already the
 *   combined `owner/name` form (the pre-existing, still-supported case)
 *   or some other value the caller's own parser will accept or reject.
 * - Only `--owner` given → combined with `--repo` (which must be the
 *   bare name, no `/`) into `owner/name`. Throws when `--repo` is
 *   missing (an owner alone cannot resolve a repository) or already
 *   contains a `/` (mixing both forms is ambiguous, not a genuine
 *   split-form name) — a specific, actionable error instead of letting
 *   a double-prefixed value reach `gh api` and 404 downstream.
 */
export function combineOwnerRepoFlags(args: {
  owner?: string;
  repo?: string;
}): string | undefined {
  if (!args.owner) {
    return args.repo;
  }
  if (args.repo?.includes('/')) {
    throw new Error(
      `--owner and a combined --repo "${args.repo}" conflict -- pass ` +
        'either --repo <owner>/<name> alone or --owner <owner> --repo ' +
        '<name>, not both forms together',
    );
  }
  if (!args.repo) {
    throw new Error(
      '--owner requires --repo <name> (the bare repository name)',
    );
  }
  return `${args.owner}/${args.repo}`;
}

/**
 * Run `gh api <path>` and parse its output as JSON, optionally paginating
 * (NDJSON-compatible) and/or tolerating specific failure statuses.
 *
 * Generalizes the two strictest existing per-helper variants this module
 * replaces: `advisory-wait-state.mts`'s NDJSON-pagination handling and
 * `review-activity-snapshot.mts`'s `allowStatuses` tolerated-failure
 * fallback.
 *
 * Targets the correct GHES host via {@link resolveGhApiHostname} (#1962)
 * instead of always defaulting to `github.com`.
 */
export function ghApiJson(
  path: string,
  options: GhApiJsonOptions = {},
): unknown {
  const { paginate = false, extraArgs = [], allowStatuses = [] } = options;
  const hostname = resolveGhApiHostname();
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    ...extraArgs,
  ];
  if (paginate) {
    args.push('--paginate', '--jq', '.[]');
  }
  const timeout =
    options.timeout ??
    (paginate ? DEFAULT_GH_PAGINATED_TIMEOUT_MS : DEFAULT_GH_TIMEOUT_MS);
  let raw: string;
  try {
    raw = execFileSync('gh', args, { encoding: 'utf8', timeout });
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

/**
 * Run a `gh api graphql` query with variables, returning the parsed JSON
 * response. Extracted from `advisory-convergence.mts` (#1806) so
 * `review-clause.mts` (and any other future GraphQL caller) can reuse the
 * same query-execution wrapper instead of a second copy, matching this
 * file's existing role as the shared `gh`-execution module for `ghText` /
 * `ghApiJson`. Uses `ghText`'s own default timeout (no explicit override
 * here, unchanged from this function's pre-extraction behavior).
 *
 * Targets the correct GHES host via {@link resolveGhApiHostname} (#1962)
 * instead of always defaulting to `github.com`.
 */
export function ghGraphql(
  query: string,
  variables: Record<string, string | number | null | undefined>,
): unknown {
  const hostname = resolveGhApiHostname();
  const args = [
    'api',
    'graphql',
    ...(hostname ? ['--hostname', hostname] : []),
    '-f',
    `query=${query}`,
  ];
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

/** #2148: REST `GET /user` failures that may still have a live GraphQL
 * `viewer { login }` — 5xx, timeout, or a killed child. Unclassified
 * errors and 4xx stay fail-closed on REST (no GraphQL fallback), so an
 * unparsable 4xx cannot leak through `deriveGhHttpStatus() === null`. */
export function viewerLoginFailureIsGraphqlEligible(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return true;
  }
  if ((error as { killed?: unknown } | null)?.killed === true) {
    return true;
  }
  const status = deriveGhHttpStatus(error);
  if (status == null) {
    return false;
  }
  return status >= 500 && status <= 599;
}

function defaultRestViewerLogin(options: GhTextOptions = {}): string {
  return ghText(['api', 'user', '--jq', '.login'], options);
}

function defaultGraphqlViewerLogin(): string {
  const payload = ghGraphql('query { viewer { login } }', {});
  const root = payload as {
    data?: { viewer?: { login?: unknown } };
    viewer?: { login?: unknown };
  };
  return String(root.data?.viewer?.login ?? root.viewer?.login ?? '').trim();
}

/** Resolve the current GitHub actor login for A5 collectors (#2148).
 *
 * REST `GET /user` first. On 5xx, timeout, or empty body, try GraphQL
 * `viewer { login }` once. 4xx does not fall back. If both fail, the
 * original REST error is rethrown (today's fail-closed abort). */
export function resolveViewerLogin(
  options: GhTextOptions = {},
  deps: {
    rest?: () => string;
    graphql?: () => string;
  } = {},
): string {
  const rest = deps.rest ?? (() => defaultRestViewerLogin(options));
  const graphql = deps.graphql ?? defaultGraphqlViewerLogin;
  try {
    const login = rest().trim();
    if (login) {
      return login;
    }
  } catch (error) {
    if (!viewerLoginFailureIsGraphqlEligible(error)) {
      throw error;
    }
    try {
      const fallback = graphql().trim();
      if (fallback) {
        return fallback;
      }
    } catch {
      // Keep the REST error as the fail-closed abort.
    }
    throw error;
  }
  try {
    const fallback = graphql().trim();
    if (fallback) {
      return fallback;
    }
  } catch {
    // Empty REST body plus GraphQL failure is still unavailable.
  }
  throw new Error(
    'viewer login unavailable from REST /user and GraphQL viewer',
  );
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
      await sleep(
        effectiveBaseDelayMs * attempt + Math.random() * effectiveBaseDelayMs,
      );
    }
  }
}
