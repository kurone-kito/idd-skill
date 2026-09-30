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
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import {
  observeGhFailure,
  observeGhSuccess,
  recordRequestObservation,
  telemetryIsEnabled,
} from './github-api-observation.mjs';
import { readThroughGithubApiCache } from './github-api-read-cache.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
import { parsePaginatedGhNdjson } from './protocol-helpers.mjs';

/**
 * Tag a thrown `gh`-invocation error with a non-enumerable `ghCommand:
 * true` property so `helper-cli-runner.mts`'s `classifyHelperError`
 * (#3342) can recognize it structurally -- `deriveGhHttpStatus` plus this
 * property -- instead of guessing from message text. Every function in
 * this module that shells out to `gh` and can throw applies this to the
 * error before rethrowing it, so a migrated helper's `transport` /
 * `not-found` classification works regardless of which wrapper the
 * failure came through.
 *
 * Non-enumerable on purpose: `util.inspect`'s own Error-object rendering
 * (what Node's default uncaught-exception crash text uses) prints every
 * OWN ENUMERABLE property trailing an Error, so a plain `error.ghCommand
 * = true` assignment would add a visible `{ ghCommand: true }` block to
 * this module's ~20 existing callers' crash output the moment such an
 * error is left to propagate uncaught -- verified empirically.
 * `enumerable: false` keeps the property readable
 * (`error.ghCommand === true`) while leaving every existing caller's
 * byte-for-byte crash text unchanged. A no-op (not re-defined) when the
 * error already carries the tag, or is not an object at all (a rejection
 * reason that is not an `Error`, defensively).
 */
function isTaggedGhCommandError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    Object.hasOwn(error, 'ghCommand')
  );
}
export function tagGhCommandError(error) {
  if (
    error &&
    typeof error === 'object' &&
    !Object.hasOwn(error, 'ghCommand')
  ) {
    Object.defineProperty(error, 'ghCommand', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}
/**
 * Rebuild the historical `gh command failed: <stderr>` error a helper
 * throws for compatibility, without dropping the original stderr stream.
 *
 * `deriveGhHttpStatus` recognizes a bare `gh: HTTP NNN` line only when
 * that line starts the scanned text. A message that merely prefixes the
 * same text (`gh command failed: gh: HTTP 404`) does not match, so a real
 * 404 is classified as `transport` with `httpStatus: null`. Copying the
 * original stderr onto the new error, non-enumerable, lets the classifier
 * read that line. Node's uncaught crash text still prints only `.message`,
 * so the unset-envelope output stays the compatibility sentence (Copilot
 * review, PR #3442).
 */
export function wrapGhCompatibilityError(error) {
  const rawStderr = error?.stderr;
  const stderr = String(rawStderr ?? '').trim();
  const wrapped = new Error(`gh command failed: ${stderr}`);
  if (rawStderr != null && String(rawStderr).length > 0) {
    Object.defineProperty(wrapped, 'stderr', {
      value: rawStderr,
      enumerable: false,
      configurable: true,
    });
  }
  return tagGhCommandError(wrapped);
}
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
/**
 * Fail-closed ceiling, in bytes, for one paginated `gh api --paginate`
 * body (issue #3597). It sits above the 1,073,028-byte response measured
 * for a 300-file pull request. The paginated reader counts stdout while
 * `gh` is still running and kills the process when the next chunk would
 * pass this ceiling, then throws {@link GhPaginatedResponseLimitError}
 * with the ceiling and the number of bytes observed. It does not wait
 * until the process exits, it is not a larger silent `maxBuffer`, and it
 * does not return a partial item list.
 */
export const GH_API_PAGINATED_MAX_BYTES = 8 * 1024 * 1024;
/** Structured over-ceiling failure from {@link ghApiJson}'s paginated path. */
export class GhPaginatedResponseLimitError extends Error {
  limitBytes;
  observedBytes;
  constructor(limitBytes, observedBytes) {
    super(
      `paginated gh api response exceeded ${limitBytes} bytes (observed ${observedBytes})`,
    );
    this.name = 'GhPaginatedResponseLimitError';
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
    // Both throw sites construct this class, and a caller may wrap it as
    // Error.cause. classifyHelperError returns kind "internal" unless some
    // link carries this tag, so an over-limit read would miss transport
    // recovery (Copilot review on PR #3605, commit 1a0dec65d).
    tagGhCommandError(this);
  }
}
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
 * Insert a resolved GHES `--hostname` into a `gh api ...` args array,
 * mirroring {@link ghApiJson}/{@link ghGraphql}'s own resolution (#1962) so
 * every {@link ghText} caller that shells out to `gh api` -- directly, or
 * via a sibling wrapper that shells out through `ghText` (e.g.
 * `advisory-comment-debounce.mts`'s `ghPaginatedJson`) -- picks up the same
 * GHES awareness at once (#3104), instead of only the handful of call
 * sites (`suitability-triage.mts`, `provider-adapter-github.mts`'s
 * `graphqlHostnameArgs`, `minimize-superseded-markers.mts`,
 * `sweep-authoring-markers.mts`'s `resolveGhHostnameArgs`) that already
 * splice their own resolved hostname into a hand-built args array one at a
 * time.
 *
 * A no-op for:
 * - any non-`api` subcommand -- `--hostname` is `gh api`-specific; other
 *   commands (`repo view`, `pr view`, `branch`, ...) resolve their target
 *   host from the git remote or an explicit `-R owner/repo`, never from a
 *   `--hostname` flag of their own;
 * - an args array that already names `--hostname` -- a caller that already
 *   spliced its own resolved value (the call sites named above) never sees
 *   a duplicated flag.
 *
 * Inserts immediately after the `api` subcommand itself (`args[0]`), before
 * every caller-supplied option or endpoint -- never at a fixed
 * `args.slice(0, 2)` position. `ghApiJson`/`ghGraphql` can safely assume
 * their own second element is the endpoint/`graphql`, since they build
 * their entire args array from a dedicated `path` parameter, but a
 * `ghText` caller's raw args are not that shape-constrained: e.g.
 * `disposition-non-review-notices.mts`'s `postDisposition` passes
 * `['api', '--method', 'POST', 'repos/.../comments', ...]`, where the
 * second element is a flag, not the endpoint. Inserting at a fixed offset
 * would land `--hostname <host>` between `--method` and its own `POST`
 * value there (CodeRabbit critique delegate finding, #3104); inserting
 * right after `args[0]` is safe for every observed shape because `gh`'s
 * Cobra-based flag parsing accepts `--hostname` interspersed anywhere
 * among a command's other flags and positional arguments.
 */
function withResolvedApiHostname(args) {
  if (args[0] !== 'api' || args.includes('--hostname')) return args;
  const hostname = resolveGhApiHostname();
  return hostname ? [args[0], '--hostname', hostname, ...args.slice(1)] : args;
}
/**
 * Run `gh` synchronously and return its trimmed stdout.
 *
 * Applies {@link DEFAULT_GH_TIMEOUT_MS} when the caller supplies no
 * `timeout` (#1675) — a caller-supplied value, including `0`, always
 * wins.
 *
 * Targets the correct GHES host via {@link withResolvedApiHostname} (#3104)
 * for a `gh api ...` call instead of always defaulting to `github.com`,
 * mirroring {@link ghApiJson}/{@link ghGraphql}'s existing (#1962)
 * resolution.
 *
 * Throws (propagating the child-process error) on any non-zero exit —
 * callers that need to tolerate specific failures use {@link safeGhText}
 * or {@link ghApiJson}'s `allowStatuses` option instead.
 */
export function ghText(args, options = {}) {
  try {
    return execFileSync('gh', withResolvedApiHostname(args), {
      encoding: 'utf8',
      timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
      ...(options.stdio ? { stdio: options.stdio } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.maxBuffer !== undefined
        ? { maxBuffer: options.maxBuffer }
        : {}),
    }).trim();
  } catch (error) {
    throw tagGhCommandError(error);
  }
}
/**
 * Sibling of {@link ghText} for a response with no safely-guessable size
 * ceiling (#2935 review, rounds 4-6): a fixed `maxBuffer` for a large
 * paginated GraphQL page turned into an escalating, never-fully-provable
 * guessing game (an initial 10 MiB estimate, then a "proven" 25 MiB
 * worst-case calculation from GitHub's 65,536-character comment cap and
 * UTF-8's 4-bytes-per-character ceiling, then a further finding that the
 * calculation still did not account for `\uXXXX` JSON-escaping, which can
 * cost up to 12 bytes per character) -- each fix removed one gap but
 * could not close the class of problem, since the true worst case
 * depends on exactly how the response is serialized, which this codebase
 * does not control and should not need to reverse-engineer. This
 * function removes the ceiling-guessing problem entirely instead of
 * refining the guess further: it redirects the child process's stdout
 * directly to a temp file (never through an in-memory pipe with a fixed
 * cap) and reads that file back, so the only limit is available disk
 * space -- a categorically different, non-adversarial-input concern.
 *
 * Deliberately minimal compared to {@link ghText}: no `stdio`/`input`
 * override support, since no current caller needs stdin or a custom
 * stdio shape for a call whose defining trait is "the output size is not
 * safely boundable" -- add that support only if a real caller needs it.
 *
 * Targets the correct GHES host via {@link withResolvedApiHostname} (#3336)
 * for a `gh api ...` call, matching {@link ghText}'s own resolution
 * instead of always defaulting to `github.com`. A no-op for a caller that
 * already spliced its own resolved `--hostname`
 * (`authoring-owner-provenance.mts`, `sweep-authoring-markers.mts`,
 * `copilot-review-wave-audit.mts`'s `ghApiPaginatedUnbounded`).
 */
export function ghTextUnbounded(args, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-exec-unbounded-'));
  const outPath = join(dir, 'stdout');
  try {
    const fd = openSync(outPath, 'w');
    try {
      execFileSync('gh', withResolvedApiHostname(args), {
        stdio: ['ignore', fd, 'pipe'],
        timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
      });
    } catch (error) {
      throw tagGhCommandError(error);
    } finally {
      closeSync(fd);
    }
    return readFileSync(outPath, 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
export function readGithubRepoDefaultBranch(owner, repo) {
  const output = safeGhText(
    ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch // empty'],
    GH_TEXT_LOOP_OPTIONS,
  );
  return output === '' ? null : output;
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
 *
 * Targets the correct GHES host via {@link withResolvedApiHostname} (#3336)
 * for a `gh api ...` call, matching {@link ghText}'s own resolution instead
 * of always defaulting to `github.com` -- the live exposure this closed:
 * both `provider-adapter-github.mts` traversal port methods
 * (`getWorkItemForTraversalAsync`'s REST issue lookup and
 * `listWorkItemSubIssueNodesAsync`'s hand-built `gh api graphql` call) run
 * through this function, so a GHES Actions runner previously queried
 * `github.com` regardless.
 */
export async function ghTextAsync(args, options = {}) {
  const run = execFileAsync('gh', withResolvedApiHostname(args), {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
    ...(options.maxBuffer !== undefined
      ? { maxBuffer: options.maxBuffer }
      : {}),
  });
  run.child.stdin?.end();
  try {
    const { stdout } = await run;
    return stdout.trim();
  } catch (error) {
    throw tagGhCommandError(error);
  }
}
/**
 * The failure evidence to record for an observation. A paginated call's
 * stdout is partial page data, not an error body, so only its stderr counts
 * as evidence; a scan of the pages could read a title or comment quoting a
 * rate-limit message as a real signal. Every other call keeps the whole
 * captured error, whose stdout carries the failure body.
 */
function failureEvidence(error, paginated) {
  return paginated ? { stderr: error?.stderr } : error;
}
function recordTransportObservation(build) {
  try {
    if (!telemetryIsEnabled()) return;
    recordRequestObservation(build());
  } catch {
    // Observation retention must not change the wrapper's own outcome.
  }
}
function statusFromIncluded(raw) {
  const match = raw.trim().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/);
  if (!match) return null;
  const status = Number.parseInt(match[1], 10);
  return Number.isInteger(status) ? status : null;
}
function tryParseIncludedBody(raw) {
  if (statusFromIncluded(raw) === null) return null;
  try {
    return parseIncludedGhApiResponse(raw);
  } catch {
    return null;
  }
}
function includedBodyIsJson(raw) {
  const body = (raw.split(/\r?\n\r?\n/).pop() ?? '').trim();
  return body.startsWith('{') || body.startsWith('[');
}
/**
 * Parse a tolerated failure body without inventing `{}`. Plain JSON is
 * accepted as-is. An HTTP envelope is accepted only when its body is
 * itself JSON. Empty and non-JSON stdout throw so the original gh
 * error is preserved.
 */
function parseToleratedGhBody(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  if (!includedBodyIsJson(raw)) {
    throw new Error('gh api stdout is not JSON');
  }
  const body = (raw.split(/\r?\n\r?\n/).pop() ?? '').trim();
  return JSON.parse(body);
}
/**
 * Parse a `gh api` body when telemetry asked for `--include`. A usable
 * HTTP envelope is handled by {@link tryParseIncludedBody} first. This
 * fallback accepts today's plain JSON, then the last section of a
 * partial envelope, so a header-parse miss cannot turn a successful
 * body into a new thrown error.
 */
function parseObservedGhBody(raw) {
  try {
    return JSON.parse(raw.trim() || '{}');
  } catch {
    const body = raw.split(/\r?\n\r?\n/).pop() ?? '';
    return JSON.parse(body.trim() || '{}');
  }
}
function parseIncludedHeadBlock(headerBlock) {
  const headerLines = headerBlock.split(/\r?\n/);
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(
    headerLines[0] ?? '',
  );
  if (!statusMatch) return null;
  const headers = {};
  for (const line of headerLines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return { status: Number.parseInt(statusMatch[1] ?? '', 10), headers };
}
/**
 * Read only the status and headers of a `--include` response, never its body,
 * so an observation can still record them when the body fails to parse (#3616).
 * `gh api --include` prints one status line and header block, then a blank
 * line, then the body, so the head is the text before the FIRST blank line and
 * must start with the status line. The body is never searched: an unparsable
 * body may itself contain blank lines and header-shaped text, and none of it
 * may enter a record. Null when the output carries no usable header block.
 */
function readIncludedEnvelopeHead(raw) {
  // Not trimmed: `gh` starts its output with the status line, so an output
  // that begins with blank lines has no head, and trimming them would let a
  // header-shaped body that follows pass for one.
  const blankLine = raw.search(/\r?\n\r?\n/);
  if (blankLine < 0) return null;
  return parseIncludedHeadBlock(raw.slice(0, blankLine));
}
function parseIncludedGhApiEnvelope(raw) {
  const sections = raw.split(/\r?\n\r?\n/);
  const body = sections.pop()?.trim() ?? '';
  const head = parseIncludedHeadBlock(sections.pop() ?? '');
  if (!head) {
    throw new Error('gh api --include returned no HTTP response headers');
  }
  return {
    status: head.status,
    data: JSON.parse(body || '{}'),
    headers: head.headers,
  };
}
/**
 * Record what a request that exited cleanly but returned an unparsable body
 * still tells us (#3616): the request consumed quota, and the status and
 * allowlisted headers are known whenever the envelope itself parses, an
 * explicit unknown otherwise. Nothing from the body enters the record, so the
 * caller rethrows its original parse error unchanged.
 */
function recordResponseParseFailure(raw, extra = {}) {
  recordTransportObservation(() => {
    const head = raw === null ? null : readIncludedEnvelopeHead(raw);
    return observeGhSuccess({
      status: head?.status ?? null,
      headers: head?.headers,
      ...extra,
    });
  });
}
/**
 * Mark a body-parse error of a paginated read that exited cleanly, so the
 * caller can tell it from a temp-directory or size-limit error and record it
 * as an observation (#3616).
 */
function tagResponseParseFailure(error) {
  if (
    error &&
    typeof error === 'object' &&
    !Object.hasOwn(error, 'ghResponseParseFailure')
  ) {
    Object.defineProperty(error, 'ghResponseParseFailure', {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}
function isResponseParseFailure(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    Object.hasOwn(error, 'ghResponseParseFailure')
  );
}
function parseIncludedGhApiResponse(raw) {
  const parsed = parseIncludedGhApiEnvelope(raw);
  return { data: parsed.data, headers: parsed.headers };
}
/**
 * Run a single `gh api` request while retaining response headers.
 *
 * This is intentionally separate from {@link ghApiJson}: callers that need a
 * conditional write must retain the server's ETag and send it back with
 * `If-Match`. A missing or malformed HTTP envelope fails closed instead of
 * silently degrading a compare-and-swap operation into an unconditional
 * mutation.
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
export function ghApiJsonWithHeaders(path, options = {}) {
  if (options.paginate) {
    throw new Error(
      'gh api response headers cannot be combined with pagination',
    );
  }
  const hostname = resolveGhApiHostname();
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    ...(options.extraArgs ?? []),
    '--include',
  ];
  let raw;
  try {
    raw = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  } catch (error) {
    recordTransportObservation(() => observeGhFailure(error));
    throw tagGhCommandError(error);
  }
  let parsed;
  try {
    parsed = parseIncludedGhApiEnvelope(raw);
  } catch (error) {
    recordResponseParseFailure(raw);
    throw error;
  }
  recordTransportObservation(() =>
    observeGhSuccess({
      status: parsed.status,
      headers: parsed.headers,
      data: parsed.data,
    }),
  );
  return { data: parsed.data, headers: parsed.headers };
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
export function resolveGhApiHostname(env = process.env) {
  if (env.GH_HOST?.trim()) return undefined;
  const host = serverUrlHost(env);
  return host && host !== 'github.com' ? host : undefined;
}
/**
 * The host named by `GITHUB_SERVER_URL`, `github.com` included. Unlike
 * {@link resolveGhApiHostname}, which returns `undefined` for `github.com`
 * to keep the emitted argv unchanged, this names every host so a caller
 * that needs the host itself (the read cache) can use it.
 */
export function serverUrlHost(env) {
  const serverUrl = env.GITHUB_SERVER_URL?.trim();
  if (!serverUrl) return undefined;
  const host = serverUrl
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return host || undefined;
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
export function combineOwnerRepoFlags(args) {
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
/** Append one NDJSON stdout line's rows; true when the line looks like JSON. */
function appendPaginatedNdjsonLine(items, bytes) {
  const text = bytes.toString('utf8').replace(/\r$/, '').trim();
  if (!text) return false;
  // A loop, not `push(...rows)`: a single array line with over ~130k
  // elements overflows the call stack when spread into arguments.
  for (const row of parsePaginatedGhNdjson(text)) items.push(row);
  return text.startsWith('{') || text.startsWith('[');
}
/**
 * Parse paginated NDJSON from an already-closed stdout capture, one line
 * at a time. The raw bytes are not retained as a single string. Crossing
 * {@link GH_API_PAGINATED_MAX_BYTES} throws before any partial list is
 * returned.
 */
function parsePaginatedNdjsonFile(filePath, limitBytes) {
  const items = [];
  let jsonShaped = false;
  let observedBytes = 0;
  // The unfinished line, kept as the chunks that make it up and joined once
  // when its newline arrives. Re-joining it on every read copies a long
  // line's prefix again for each 64 KiB read, which is quadratic for a row
  // near the ceiling (Copilot review, PR #3605).
  let pendingChunks = [];
  const chunk = Buffer.alloc(64 * 1024);
  const fd = openSync(filePath, 'r');
  try {
    while (true) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      observedBytes += read;
      if (observedBytes > limitBytes) {
        throw new GhPaginatedResponseLimitError(limitBytes, observedBytes);
      }
      const bytes = chunk.subarray(0, read);
      let start = 0;
      // Only the newly read bytes are scanned for a newline.
      for (
        let index = bytes.indexOf(0x0a);
        index !== -1;
        index = bytes.indexOf(0x0a, start)
      ) {
        const tail = bytes.subarray(start, index);
        const line =
          pendingChunks.length > 0
            ? Buffer.concat([...pendingChunks, tail])
            : tail;
        pendingChunks = [];
        if (appendPaginatedNdjsonLine(items, line)) {
          jsonShaped = true;
        }
        start = index + 1;
      }
      // `chunk` is reused by the next read, so the leftover must be copied.
      if (start < bytes.length) {
        pendingChunks.push(Buffer.from(bytes.subarray(start)));
      }
    }
  } finally {
    closeSync(fd);
  }
  if (pendingChunks.length > 0) {
    const line = Buffer.concat(pendingChunks);
    if (appendPaginatedNdjsonLine(items, line)) {
      jsonShaped = true;
    }
  }
  return { items, jsonShaped };
}
function ghCommandFailure(status, stderr, stdout = '') {
  const error = new Error(`gh command failed: ${stderr.trim()}`);
  Object.defineProperty(error, 'status', {
    value: status,
    enumerable: false,
  });
  // `deriveGhHttpStatus` falls back to a JSON body's `status` field when
  // stderr carries none (#3335); an execFileSync error kept `.stdout` for it.
  if (stdout.length > 0) {
    Object.defineProperty(error, 'stdout', {
      value: stdout,
      enumerable: false,
    });
  }
  if (stderr.length > 0) {
    Object.defineProperty(error, 'stderr', {
      value: stderr,
      enumerable: false,
    });
  }
  return tagGhCommandError(error);
}
/** Extra wait after `gh`'s own timeout so a stuck capture worker fails closed. */
const PAGINATED_CAPTURE_GRACE_MS = 15_000;
/** Stderr retained from a paginated `gh`. Further bytes are discarded, not buffered. */
const PAGINATED_STDERR_CAP_BYTES = 1024 * 1024;
const PAGINATED_CAPTURE_KIND = 'paginated-gh-capture';
/** Largest delay `setTimeout` honors; a longer one fires after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/**
 * How long a `gh` the worker signaled may take to exit before it is sent
 * SIGKILL. The status is published only once `gh` has exited, so a `gh`
 * that ignores SIGTERM cannot outlive the capture (Copilot review, PR
 * #3605).
 */
const PAGINATED_KILL_ESCALATION_MS = 2_000;
/**
 * Shared flag: index 0 is completion, index 1 is the `gh` pid, index 2 is
 * set once the worker has armed its exit hook (see
 * {@link markPaginatedCaptureStarted}).
 */
const CAPTURE_SLOT_DONE = 0;
const CAPTURE_SLOT_PID = 1;
const CAPTURE_SLOT_STARTED = 2;
const CAPTURE_FLAG_BYTES = 12;
/**
 * Exact tokens only. Tests set this so a stream error or a stuck-worker
 * kill decision can be forced. Any other value, including unset, leaves
 * the capture unchanged. Not an operator setting.
 */
const PAGINATED_CAPTURE_TEST_FAULT = 'IDD_GH_EXEC_TEST_FAULT';
function paginatedCaptureTestFault() {
  const value = process.env[PAGINATED_CAPTURE_TEST_FAULT];
  if (
    value === 'stdout' ||
    value === 'stderr' ||
    value === 'stdin' ||
    value === 'worker-crash' ||
    value === 'worker-init-fail' ||
    value === 'proc-unreadable' ||
    value === 'proc-not-gh' ||
    value === 'proc-gh-path'
  ) {
    return value;
  }
  return null;
}
function paginatedCaptureGraceMs() {
  const fault = paginatedCaptureTestFault();
  if (
    fault === 'proc-unreadable' ||
    fault === 'proc-not-gh' ||
    fault === 'proc-gh-path'
  ) {
    return 2_000;
  }
  // No worker will ever start under this fault, so a short window is enough.
  if (fault === 'worker-init-fail') return 1_000;
  return PAGINATED_CAPTURE_GRACE_MS;
}
function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const wrote = writeSync(fd, buffer, offset, buffer.length - offset);
    if (wrote <= 0) {
      throw new Error('paginated gh capture failed to write stdout');
    }
    offset += wrote;
  }
}
function errorCode(error) {
  const code = error.code;
  return typeof code === 'string' ? code : null;
}
function readPaginatedCaptureWorkerData(value) {
  if (!value || typeof value !== 'object') return null;
  const record = value;
  if (record.kind !== PAGINATED_CAPTURE_KIND) return null;
  if (!Array.isArray(record.args)) return null;
  if (!record.args.every((arg) => typeof arg === 'string')) return null;
  if (typeof record.timeout !== 'number') return null;
  if (typeof record.outPath !== 'string') return null;
  if (typeof record.errPath !== 'string') return null;
  if (typeof record.statusPath !== 'string') return null;
  if (typeof record.limitBytes !== 'number') return null;
  if (!(record.flag instanceof SharedArrayBuffer)) return null;
  if (record.input !== undefined && typeof record.input !== 'string') {
    return null;
  }
  return {
    kind: PAGINATED_CAPTURE_KIND,
    args: record.args,
    timeout: record.timeout,
    ...(typeof record.input === 'string' ? { input: record.input } : {}),
    outPath: record.outPath,
    errPath: record.errPath,
    statusPath: record.statusPath,
    limitBytes: record.limitBytes,
    flag: record.flag,
  };
}
function publishPaginatedCapture(data, report) {
  const payload = {
    limitExceeded: report.limitExceeded,
    timedOut: report.timedOut,
    workerLost: false,
    observedBytes: report.observedBytes,
    status: report.status,
    signal: report.signal,
    spawnErrorMessage: report.spawnErrorMessage,
    spawnErrorCode: report.spawnErrorCode,
    streamErrorMessage: report.streamErrorMessage,
    streamErrorCode: report.streamErrorCode,
  };
  try {
    writeFileSync(data.errPath, report.stderr);
    writeFileSync(data.statusPath, JSON.stringify(payload));
  } catch (error) {
    try {
      writeFileSync(
        data.statusPath,
        JSON.stringify({
          limitExceeded: false,
          timedOut: false,
          workerLost: false,
          observedBytes: report.observedBytes,
          status: null,
          signal: null,
          spawnErrorMessage:
            error instanceof Error ? error.message : String(error),
          spawnErrorCode: null,
          streamErrorMessage: null,
          streamErrorCode: null,
        }),
      );
    } catch {
      // The parent exit hook fails closed when the status file is missing.
    }
  }
  const flag = new Int32Array(data.flag);
  Atomics.store(flag, CAPTURE_SLOT_DONE, 1);
  Atomics.notify(flag, CAPTURE_SLOT_DONE, 1);
  process.exit(0);
}
/**
 * Wake the parent from the worker thread. The parent's `worker.once('exit')`
 * handler cannot run while that same thread is inside `Atomics.wait`.
 */
function armPaginatedCaptureExit(data) {
  const notify = () => {
    const view = new Int32Array(data.flag);
    if (Atomics.load(view, CAPTURE_SLOT_DONE) !== 0) return;
    try {
      if (!existsSync(data.statusPath)) {
        writeFileSync(
          data.statusPath,
          JSON.stringify({
            limitExceeded: false,
            timedOut: false,
            workerLost: true,
            observedBytes: 0,
            status: null,
            signal: null,
            spawnErrorMessage:
              'paginated gh capture worker exited before reporting status',
            spawnErrorCode: null,
            streamErrorMessage: null,
            streamErrorCode: null,
          }),
        );
      }
    } catch {
      // The parent still fails closed when the status file is missing.
    }
    Atomics.store(view, CAPTURE_SLOT_DONE, 1);
    Atomics.notify(view, CAPTURE_SLOT_DONE, 1);
  };
  process.once('uncaughtException', () => {
    process.exit(1);
  });
  process.once('exit', notify);
}
/**
 * Command line of `pid`, or null when `/proc` cannot be read.
 * A readable Linux cmdline is NUL-separated argv. Only an argv0 whose
 * basename is exactly `gh` is this capture's child. An unreadable
 * `/proc` (macOS, or Linux without that filesystem) still signals —
 * returning here used to leave `gh` running (Copilot review, PR #3605).
 */
function paginatedGhCmdline(pid) {
  const fault = paginatedCaptureTestFault();
  if (fault === 'proc-unreadable') return null;
  if (fault === 'proc-not-gh') {
    return '/usr/local/bin/ghost-daemon\0github\0ghq';
  }
  // A worker-crash test stubs `gh` with a script whose real argv0 is node.
  if (fault === 'proc-gh-path' || fault === 'worker-crash') {
    return '/usr/bin/gh\0api';
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
  } catch {
    return null;
  }
}
/**
 * True when argv0's basename is exactly `gh`. `/proc/<pid>/cmdline` is
 * NUL-separated argv, so a substring match also hits `ghost-daemon`,
 * `github`, and `ghq` (Copilot review, PR #3605).
 */
function linuxCmdlineArgv0IsGh(cmdline) {
  const nul = cmdline.indexOf('\0');
  const argv0 = nul === -1 ? cmdline : cmdline.slice(0, nul);
  const slash = argv0.lastIndexOf('/');
  const base = slash === -1 ? argv0 : argv0.slice(slash + 1);
  return base === 'gh';
}
/**
 * Signal `pid` only when it is this capture's `gh`. On Linux that means
 * argv0's basename is exactly `gh`; other platforms, and a Linux host
 * whose `/proc` read fails, still signal. Checked again before each
 * signal, so on Linux a pid recycled during the escalation wait is not
 * signaled.
 */
function signalPaginatedGhChild(pid, signal) {
  if (process.platform === 'linux') {
    const cmdline = paginatedGhCmdline(pid);
    if (cmdline !== null && !linuxCmdlineArgv0IsGh(cmdline)) return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // The child already exited.
    return false;
  }
}
/**
 * Best-effort stop for a `gh` left behind when the capture worker never
 * reports or is lost. Sends SIGTERM, waits up to
 * {@link PAGINATED_KILL_ESCALATION_MS} for it to exit, then SIGKILL, so a
 * `gh` that ignores SIGTERM cannot outlive a call that has already
 * thrown. The worker's own SIGKILL escalation cannot run once the worker
 * is terminated or gone (Copilot review, PR #3605). A `gh` that exited
 * but was never reaped still answers `kill(pid, 0)`; on Linux that zombie
 * is recognized from `/proc`, elsewhere the wait can run its full length.
 * This is a failure path only.
 */
function killPaginatedGhChild(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!signalPaginatedGhChild(pid, 'SIGTERM')) return;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + PAGINATED_KILL_ESCALATION_MS;
  while (Date.now() < deadline) {
    if (!paginatedGhIsRunning(pid)) return;
    Atomics.wait(pause, 0, 0, 25);
  }
  signalPaginatedGhChild(pid, 'SIGKILL');
}
/**
 * Whether `pid` is still a running process. `kill(pid, 0)` also succeeds
 * for a zombie, and a `gh` whose capture worker is gone is never reaped,
 * so on Linux a zombie or dead state counts as stopped.
 */
function paginatedGhIsRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(
        stat.lastIndexOf(')') + 2,
        stat.lastIndexOf(')') + 3,
      );
      if (state === 'Z' || state === 'X') return false;
    } catch {
      // No readable /proc entry: keep the kill(pid, 0) answer.
    }
  }
  return true;
}
function startPaginatedCapture(data) {
  const fault = paginatedCaptureTestFault();
  const procFault =
    fault === 'proc-unreadable' ||
    fault === 'proc-not-gh' ||
    fault === 'proc-gh-path';
  const outFd = openSync(data.outPath, 'w');
  let observedBytes = 0;
  let limitExceeded = false;
  let timedOut = false;
  let timeoutTimer;
  const stopTimeout = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  };
  let escalationTimer;
  let closed = false;
  let finished = false;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;
  let streamError = null;
  let streamFaulted = false;
  const stderrChunks = [];
  let stderrBytes = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    stopTimeout();
    if (escalationTimer) clearTimeout(escalationTimer);
    try {
      closeSync(outFd);
    } catch {
      // The status record still has to wake the parent.
    }
    publishPaginatedCapture(data, {
      limitExceeded,
      timedOut,
      observedBytes,
      status: exitCode,
      signal: exitSignal,
      spawnErrorMessage: spawnError ? spawnError.message : null,
      spawnErrorCode: spawnError ? errorCode(spawnError) : null,
      streamErrorMessage: streamError ? streamError.message : null,
      streamErrorCode: streamError ? errorCode(streamError) : null,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });
  };
  let child;
  try {
    child = spawn('gh', data.args, {
      windowsHide: true,
      stdio: [data.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
    finish();
    return;
  }
  if (typeof child.pid === 'number' && child.pid > 0) {
    Atomics.store(new Int32Array(data.flag), CAPTURE_SLOT_PID, child.pid);
  }
  if (!child.stdout || !child.stderr) {
    spawnError = new Error('paginated gh capture did not pipe stdio');
    finish();
    return;
  }
  if (procFault && typeof child.pid === 'number' && child.pid > 0) {
    return;
  }
  // The timeout is enforced here, not through spawn's `timeout` option:
  // that option only sends SIGTERM and records nothing, so a `gh` that
  // handles SIGTERM and exits 0 would close as a clean success carrying
  // a partial NDJSON body (Copilot review, PR #3605). A proc-fault test
  // (returned above) leaves `gh` running so the parent's stuck-worker
  // backstop is what signals it.
  if (data.timeout > 0) {
    // `setTimeout` clamps a delay past 2^31-1 ms (and `Infinity`) to 1 ms,
    // which would time out every capture.
    timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        killChild();
      },
      Math.min(data.timeout, MAX_TIMER_DELAY_MS),
    );
  }
  // Every worker-initiated stop goes through here: the timeout, the byte
  // limit, a write failure, and a pipe error. It stops the timeout timer
  // first, so a capture that already has its own failure recorded is not
  // reported as a timeout when `gh` is slow to die. It then escalates to
  // SIGKILL if `gh` has not exited after a bounded wait. `finish` runs
  // from the `close` event, so the status is never published, and the
  // worker never exits, while a signaled `gh` may still be running. This
  // relies on `gh` leaving no descendant that keeps its pipes open, which
  // would delay `close`; the parent's timeout backstop still bounds that.
  const killChild = () => {
    stopTimeout();
    try {
      child.kill();
    } catch {
      // The child already exited.
    }
    if (!closed && !escalationTimer) {
      escalationTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child already exited.
        }
      }, PAGINATED_KILL_ESCALATION_MS);
    }
  };
  const noteStreamError = (error) => {
    if (!streamError) {
      streamError = error instanceof Error ? error : new Error(String(error));
    }
    killChild();
  };
  // Test fault: kill the worker with an uncaught error once `gh` has
  // produced output (so it is certainly running), which leaves the worker's
  // exit hook to report a lost worker.
  let crashed = false;
  const armWorkerCrash = () => {
    if (fault !== 'worker-crash' || crashed) return;
    crashed = true;
    setTimeout(() => {
      throw new Error('paginated gh capture worker crash fault');
    }, 0);
  };
  const armStreamFault = (stream, token) => {
    if (fault !== token || streamFaulted || !stream) return;
    streamFaulted = true;
    // `destroy` emits `error` on nextTick, which runs before the
    // `finish` that the `close` event defers by one turn, so the status
    // file records the pipe failure rather than a later exit 0.
    stream.destroy(new Error(`paginated gh ${token} pipe failed`));
  };
  child.stdout.on('data', (chunk) => {
    if (limitExceeded || finished) return;
    try {
      const next = observedBytes + chunk.length;
      if (next > data.limitBytes) {
        limitExceeded = true;
        observedBytes = next;
        killChild();
        return;
      }
      writeAllSync(outFd, chunk);
      observedBytes = next;
      armWorkerCrash();
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      killChild();
    }
    armStreamFault(child.stdout, 'stdout');
  });
  // A pipe error after a few NDJSON rows must not be parsed as success
  // when `gh` later exits 0 (Copilot review, PR #3605).
  child.stdout.on('error', noteStreamError);
  child.stderr.on('data', (chunk) => {
    if (stderrBytes < PAGINATED_STDERR_CAP_BYTES) {
      const room = PAGINATED_STDERR_CAP_BYTES - stderrBytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    }
    armStreamFault(child.stderr, 'stderr');
  });
  child.stderr.on('error', noteStreamError);
  if (data.input !== undefined && child.stdin) {
    child.stdin.on('error', noteStreamError);
    armStreamFault(child.stdin, 'stdin');
    child.stdin.end(data.input);
  }
  // Defer to the next turn so an 'error' and a 'close' in the same turn
  // are both recorded before the status file is published.
  child.once('error', (error) => {
    spawnError = error;
    stopTimeout();
    if (escalationTimer) clearTimeout(escalationTimer);
    setTimeout(finish, 0);
  });
  child.once('close', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    closed = true;
    // `finish` runs a turn later; a timer expiring in between must not
    // mark a capture that already closed as timed out, or signal a `gh`
    // that already exited.
    stopTimeout();
    if (escalationTimer) clearTimeout(escalationTimer);
    setTimeout(finish, 0);
  });
}
/**
 * Tell the parent this worker got as far as arming its exit hook, so any
 * later death is reported through the done flag. A parent that waits with
 * no timeout uses it to tell a worker that failed while starting up,
 * before it could set the done flag, from one that is still working.
 */
function markPaginatedCaptureStarted(data) {
  const view = new Int32Array(data.flag);
  Atomics.store(view, CAPTURE_SLOT_STARTED, 1);
  Atomics.notify(view, CAPTURE_SLOT_STARTED, 1);
}
function runPaginatedCaptureWorker() {
  // Test fault: die during start-up, before the exit hook exists.
  if (paginatedCaptureTestFault() === 'worker-init-fail') process.exit(1);
  const data = readPaginatedCaptureWorkerData(workerData);
  if (data) {
    armPaginatedCaptureExit(data);
    markPaginatedCaptureStarted(data);
  }
  try {
    if (!data) {
      throw new Error('paginated gh capture worker data was unusable');
    }
    startPaginatedCapture(data);
  } catch (error) {
    if (data) {
      publishPaginatedCapture(data, {
        limitExceeded: false,
        timedOut: false,
        observedBytes: 0,
        status: null,
        signal: null,
        spawnErrorMessage:
          error instanceof Error ? error.message : String(error),
        spawnErrorCode: null,
        streamErrorMessage: null,
        streamErrorCode: null,
        stderr: '',
      });
    }
    process.exit(1);
  }
}
function readPaginatedCaptureStatus(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw tagGhCommandError(error);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw tagGhCommandError(
      new Error('paginated gh capture status was unreadable'),
    );
  }
  const record = parsed;
  if (
    typeof record.observedBytes !== 'number' ||
    !Number.isFinite(record.observedBytes)
  ) {
    throw tagGhCommandError(
      new Error('paginated gh capture status was unreadable'),
    );
  }
  return {
    limitExceeded: record.limitExceeded === true,
    timedOut: record.timedOut === true,
    workerLost: record.workerLost === true,
    observedBytes: record.observedBytes,
    status: typeof record.status === 'number' ? record.status : null,
    signal:
      typeof record.signal === 'string' && record.signal.length > 0
        ? record.signal
        : null,
    spawnErrorMessage:
      typeof record.spawnErrorMessage === 'string'
        ? record.spawnErrorMessage
        : null,
    spawnErrorCode:
      typeof record.spawnErrorCode === 'string' ? record.spawnErrorCode : null,
    streamErrorMessage:
      typeof record.streamErrorMessage === 'string'
        ? record.streamErrorMessage
        : null,
    streamErrorCode:
      typeof record.streamErrorCode === 'string'
        ? record.streamErrorCode
        : null,
  };
}
function paginatedSpawnError(status) {
  const error = new Error(
    status.spawnErrorMessage ?? 'paginated gh capture failed',
  );
  if (status.spawnErrorCode) {
    Object.defineProperty(error, 'code', {
      value: status.spawnErrorCode,
      enumerable: false,
    });
  }
  return tagGhCommandError(error);
}
function paginatedTimeoutError(message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {
    value: 'ETIMEDOUT',
    enumerable: false,
  });
  return tagGhCommandError(error);
}
function paginatedStreamError(status) {
  const error = new Error(
    status.streamErrorMessage ?? 'paginated gh capture stream failed',
  );
  if (status.streamErrorCode) {
    Object.defineProperty(error, 'code', {
      value: status.streamErrorCode,
      enumerable: false,
    });
  }
  return tagGhCommandError(error);
}
/** Largest stdout that can still be kept as a failed call's JSON error body. */
const PAGINATED_ERROR_BODY_MAX_BYTES = 64 * 1024;
/**
 * The captured stdout, but only when it is gh's own JSON error body: the
 * whole output is one small JSON object with a string `message` and a
 * three-digit `status` (e.g. `{"message":"Not Found","status":"404"}`).
 * `deriveGhHttpStatus` scans an error's `stdout` for that `status` when
 * stderr carries none (#3335). On this path stdout otherwise holds earlier
 * pages' data rows, which are user content (comment and issue bodies); the
 * status and wording scanners must never read those, or text like
 * "(HTTP 404)" inside a comment would reclassify a transport failure
 * (CodeRabbit-style critique, PR #3605). Returns '' for anything else.
 */
function readPaginatedErrorBody(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(PAGINATED_ERROR_BODY_MAX_BYTES + 1);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read === 0 || read > PAGINATED_ERROR_BODY_MAX_BYTES) return '';
    const text = buffer.subarray(0, read).toString('utf8').trim();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '';
    }
    const body = parsed;
    return typeof body.message === 'string' &&
      /^\d{3}$/.test(String(body.status ?? ''))
      ? text
      : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing more to release.
      }
    }
  }
}
/**
 * Best-effort removal of the capture's temp directory. A worker that is
 * still terminating can hold a file open (Windows refuses to remove it),
 * and that cleanup failure must not replace the capture result or its
 * tagged error (CodeRabbit critique, PR #3605). The directory then stays
 * in the OS temp area.
 */
function removePaginatedCaptureDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leave it for the OS temp cleanup.
  }
}
/**
 * Run paginated `gh api --paginate` without Node's 1 MiB `maxBuffer`.
 * A worker counts stdout as it arrives, writes only the in-limit bytes,
 * and kills `gh` when the next chunk would pass
 * {@link GH_API_PAGINATED_MAX_BYTES}. The parent stays synchronous
 * because {@link ghApiJson} is a public sync API. A signaled child is a
 * failure even when the bytes already written are valid JSON: a null
 * exit status must not look like success (Copilot review, PR #3605).
 * A stdout, stderr, or stdin pipe error is likewise a failure even when
 * `gh` exits 0, so a partial NDJSON prefix is not returned. So is a
 * timeout: the worker records that it signaled `gh`, because a `gh`
 * that handles SIGTERM can still exit 0 (Copilot review, PR #3605). A non-zero
 * exit still honors `allowStatuses` when the captured body is JSON-shaped
 * and under the ceiling.
 */
function readPaginatedGhApi(args, options) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-exec-paginate-'));
  const outPath = join(dir, 'stdout');
  const errPath = join(dir, 'stderr');
  const statusPath = join(dir, 'status.json');
  const flag = new SharedArrayBuffer(CAPTURE_FLAG_BYTES);
  const view = new Int32Array(flag);
  let worker;
  let workerLost = false;
  try {
    try {
      worker = new Worker(new URL(import.meta.url), {
        // Empty on purpose. The worker only spawns `gh`. Forwarding the
        // parent's execArgv hands Node's test runner flags
        // (`--stack-trace-limit`, `--secure-heap`, `--node-snapshot`, and
        // `--test`) to Worker, which rejects them with
        // ERR_WORKER_INVALID_EXEC_ARGV (CI lint on PR #3605, Node 24). An
        // empty list also keeps this module from being loaded as a test
        // file.
        execArgv: [],
        workerData: {
          kind: PAGINATED_CAPTURE_KIND,
          args,
          timeout: options.timeout,
          ...(options.input !== undefined ? { input: options.input } : {}),
          outPath,
          errPath,
          statusPath,
          limitBytes: GH_API_PAGINATED_MAX_BYTES,
          flag,
        },
      });
    } catch (error) {
      // A worker that never started is a transport failure, and the
      // temp directory is still removed by the `finally` below.
      throw tagGhCommandError(error);
    }
    // A worker 'error' event is queued on this thread and cannot be
    // dispatched while Atomics.wait is blocking it. The listener only
    // keeps that event from crashing the parent after the wait returns.
    worker.on('error', () => {});
    // Bound the start-up first, whatever the timeout. A worker that fails
    // while starting up never reaches its exit hook, and this blocked
    // thread cannot see its 'error' event, so without this a call with no
    // timeout (0, or a timeout too large to be finite) would wait forever
    // and any other would wait out its whole timeout (Copilot review, PR
    // #3605). A worker that starts normally passes this in milliseconds.
    Atomics.wait(view, CAPTURE_SLOT_STARTED, 0, paginatedCaptureGraceMs());
    if (
      Atomics.load(view, CAPTURE_SLOT_STARTED) === 0 &&
      Atomics.load(view, CAPTURE_SLOT_DONE) === 0
    ) {
      throw tagGhCommandError(
        new Error('paginated gh capture worker did not start'),
      );
    }
    if (options.timeout > 0) {
      Atomics.wait(
        view,
        CAPTURE_SLOT_DONE,
        0,
        options.timeout + paginatedCaptureGraceMs(),
      );
    } else {
      Atomics.wait(view, CAPTURE_SLOT_DONE, 0);
    }
    if (Atomics.load(view, CAPTURE_SLOT_DONE) === 0) {
      throw paginatedTimeoutError('paginated gh capture timed out');
    }
    // Until the status has been read, assume the worker was lost: an
    // unreadable status (its exit hook could not write one) must not leave
    // a running `gh` behind either.
    workerLost = true;
    const capture = readPaginatedCaptureStatus(statusPath);
    workerLost = capture.workerLost;
    const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
    if (capture.limitExceeded) {
      throw new GhPaginatedResponseLimitError(
        GH_API_PAGINATED_MAX_BYTES,
        capture.observedBytes,
      );
    }
    // Even a clean exit after the timeout's SIGTERM is a failure: the
    // body may be a partial NDJSON prefix. Checked before the spawn and
    // pipe errors because, once the worker has signaled `gh` for the
    // timeout, those are usually consequences of that signal (an EPIPE on
    // stdin must not hide the timeout). A failure that lands after the
    // timer fired still reports the timeout, which fails closed. A
    // worker-initiated kill for any other reason stops the timer first.
    if (capture.timedOut) {
      throw paginatedTimeoutError(
        `paginated gh capture timed out after ${options.timeout}ms`,
      );
    }
    if (capture.spawnErrorMessage) {
      throw paginatedSpawnError(capture);
    }
    if (capture.streamErrorMessage) {
      throw paginatedStreamError(capture);
    }
    if (capture.signal) {
      throw ghCommandFailure(-1, stderr || `gh killed by ${capture.signal}`);
    }
    let parsed;
    try {
      parsed = parsePaginatedNdjsonFile(outPath, GH_API_PAGINATED_MAX_BYTES);
    } catch (error) {
      if (error instanceof GhPaginatedResponseLimitError) throw error;
      const status = Number(capture.status ?? -1);
      // A zero exit with a malformed body stays a parse failure. Status 0
      // is a successful gh exit, so it stays off the gh failure path. A
      // non-zero exit is a tagged gh failure whether or not the status is
      // allow-listed: an allow-listed status only tolerates a JSON-shaped
      // body, and this body did not parse (matching the execFileSync path).
      if (status !== 0) {
        throw ghCommandFailure(status, stderr, readPaginatedErrorBody(outPath));
      }
      // Only a JSON syntax error is a response that did not parse; a file
      // read error while reading the capture back is not. The tag is only
      // read by the telemetry recording, so an error thrown with telemetry
      // off stays exactly what it was.
      throw telemetryIsEnabled() && error instanceof SyntaxError
        ? tagResponseParseFailure(error)
        : error;
    }
    // A missing status with no signal is a clean exit. A signal was
    // already rejected above, so it cannot take this `?? 0` path.
    const status = Number(capture.status ?? 0);
    if (status !== 0) {
      if (options.allowStatuses.includes(status) && parsed.jsonShaped) {
        // The rows came from an allow-listed failure, so the listing may be
        // incomplete; the read cache must not treat it as a full page set.
        return {
          items: parsed.items,
          toleratedFailure: true,
          toleratedStderr: stderr,
        };
      }
      throw ghCommandFailure(status, stderr, readPaginatedErrorBody(outPath));
    }
    return { items: parsed.items, toleratedFailure: false };
  } finally {
    // The done flag alone does not prove `gh` stopped: a worker that died
    // before publishing sets it through its exit hook (`workerLost`).
    if (Atomics.load(view, CAPTURE_SLOT_DONE) === 0 || workerLost) {
      killPaginatedGhChild(Atomics.load(view, CAPTURE_SLOT_PID));
    }
    void worker?.terminate();
    removePaginatedCaptureDir(dir);
  }
}
function safeHeaderValue(value) {
  if (!value) return undefined;
  if (value.length > 512 || /[\r\n]/.test(value)) return undefined;
  return value;
}
function responseIsThrottled(status, headers) {
  if (status === 429) return true;
  return status === 403 && headers['x-ratelimit-remaining'] === '0';
}
function readGhStdout(args) {
  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Process-lifetime memo of the one host `gh auth status` reported (#3621).
 * Without it every cached read ran a `gh` process before the cache lookup,
 * so a warm hit cost more than it saved. A single slot keyed by the
 * `GH_HOST` and `GITHUB_SERVER_URL` values in effect, so a change to either
 * re-resolves.
 *
 * Only a lookup that reports exactly one non-blank host is stored. A failed
 * call, empty output, unparseable or non-object JSON, an empty `hosts`
 * object, several hosts and an empty or whitespace-only host name are
 * returned as they always were and are retried on the next call.
 *
 * Accepted residual: a `github.com` result is not pinned to the request (see
 * {@link explicitCacheHostname}). If the sole logged-in host changes while
 * the process runs, a read keyed under that memo could be stored under the
 * `github.com` partition when an environment token is set. Neither an
 * environment token nor the keyring credential is memoized, and the memo
 * gains no further key inputs.
 */
let ghAuthHostMemo;
function ghAuthHostMemoKey() {
  return JSON.stringify([
    process.env.GH_HOST ?? null,
    process.env.GITHUB_SERVER_URL ?? null,
  ]);
}
/** Forget the memoized `gh auth status` host so the next read resolves it again. */
// audit:ignore-dead-export: test seam for the activeGhHost memo (issue #3621)
export function resetGhAuthHostMemo() {
  ghAuthHostMemo = undefined;
}
function activeGhHost() {
  const key = ghAuthHostMemoKey();
  if (ghAuthHostMemo?.key === key) return ghAuthHostMemo.host;
  const raw = readGhStdout(['auth', 'status', '--json', 'hosts']);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.hosts !== 'object' ||
      parsed.hosts === null ||
      Array.isArray(parsed.hosts)
    ) {
      return undefined;
    }
    const hosts = Object.keys(parsed.hosts).map((host) => host.toLowerCase());
    if (hosts.length === 1) {
      const host = hosts[0];
      if (host?.trim()) ghAuthHostMemo = { key, host };
      return host;
    }
    if (hosts.length === 0) return 'github.com';
    return undefined;
  } catch {
    return undefined;
  }
}
/**
 * The `--hostname` for a cached request when nothing else names one. The
 * cache key and credential were derived for `cacheHost`, possibly from the
 * sole host `gh auth status` reported, so the request is pinned to it
 * instead of relying on `gh`'s own default agreeing. `github.com` stays
 * unpinned so the emitted argv is unchanged there, as elsewhere.
 */
function explicitCacheHostname(cacheHost) {
  if (cacheHost === undefined || cacheHost === 'github.com') return undefined;
  return process.env.GH_HOST?.trim() ? undefined : cacheHost;
}
function resolveReadCacheHost() {
  const configured = process.env.GH_HOST?.trim().toLowerCase();
  if (configured) return configured;
  return serverUrlHost(process.env) ?? activeGhHost();
}
function usesGithubToken(host) {
  return (
    host === 'github.com' ||
    host === 'github.localhost' ||
    host.endsWith('.ghe.com')
  );
}
export function defaultCredentialMaterial(host) {
  const token = usesGithubToken(host)
    ? process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
    : process.env.GH_ENTERPRISE_TOKEN?.trim() ||
      process.env.GITHUB_ENTERPRISE_TOKEN?.trim();
  if (token) return token;
  return readGhStdout(['auth', 'token', '--hostname', host]);
}
function readCacheLeaseTtlMs(options, request) {
  if (request.leaseTtlMs !== undefined && request.leaseTtlMs > 0) {
    return request.leaseTtlMs;
  }
  const fetchTimeout =
    options.timeout ??
    (options.paginate
      ? DEFAULT_GH_PAGINATED_TIMEOUT_MS
      : DEFAULT_GH_TIMEOUT_MS);
  const bounded =
    fetchTimeout > 0 ? fetchTimeout : DEFAULT_GH_PAGINATED_TIMEOUT_MS;
  return bounded + 30_000;
}
export function loadReadCachePolicy(injected) {
  if (injected) {
    return {
      enabled: injected.enabled === true,
      maxAgeMs: injected.maxAgeMs,
      maxBytes: injected.maxBytes,
      retentionMs: injected.retentionMs,
      ...(injected.directory ? { directory: injected.directory } : {}),
    };
  }
  const disabled = {
    enabled: false,
    maxAgeMs: 5 * 60 * 1000,
    maxBytes: 104857600,
    retentionMs: 24 * 60 * 60 * 1000,
  };
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), '.github/idd/config.json'), 'utf8'),
    );
    const normalized = normalizePolicyConfig(raw);
    const readCache = normalized.githubApi.readCache;
    const maxAgeMs = parseIsoDurationToMs(readCache.maxAge);
    const retentionMs = parseIsoDurationToMs(readCache.retention);
    if (maxAgeMs === null || retentionMs === null) return disabled;
    return {
      enabled: readCache.enabled === true,
      maxAgeMs,
      maxBytes: readCache.maxBytes,
      retentionMs,
      ...(readCache.directory ? { directory: readCache.directory } : {}),
    };
  } catch {
    return disabled;
  }
}
function ghApiIncluded(path, options, cacheHost) {
  const hostname = resolveGhApiHostname() ?? explicitCacheHostname(cacheHost);
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    ...(options.extraArgs ?? []),
    '--include',
  ];
  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: options.timeout ?? DEFAULT_GH_TIMEOUT_MS,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return parseIncludedGhApiEnvelope(raw);
  } catch (error) {
    const stdout = String(error?.stdout ?? '').trimStart();
    if (/^HTTP\/\d/.test(stdout)) {
      try {
        const parsed = parseIncludedGhApiEnvelope(stdout);
        const proc = Number(error.status ?? -1);
        if (
          parsed.status === 304 ||
          (options.allowStatuses ?? []).includes(proc)
        ) {
          return parsed;
        }
      } catch {
        // Fall through to the uncached failure policy below.
      }
    }
    const failure = error;
    const status = Number(failure?.status ?? -1);
    if ((options.allowStatuses ?? []).includes(status)) {
      const text = String(failure?.stdout ?? '');
      if (/^\s*[[{]/.test(text)) {
        return { status, data: JSON.parse(text), headers: {} };
      }
    }
    throw tagGhCommandError(error);
  }
}
function fetchForReadCache(path, options, request, cacheHost) {
  if (options.paginate) {
    const executed = executeGhApiJson(path, options, cacheHost);
    return {
      status: 200,
      body: executed.data,
      incomplete: executed.toleratedFailure,
    };
  }
  const etag = safeHeaderValue(request.etag);
  const extraArgs = [...(options.extraArgs ?? [])];
  if (etag) extraArgs.push('-H', `If-None-Match: ${etag}`);
  const envelope = ghApiIncluded(path, { ...options, extraArgs }, cacheHost);
  return {
    status: envelope.status,
    body: envelope.data,
    etag: safeHeaderValue(envelope.headers.etag),
    lastModified: safeHeaderValue(envelope.headers['last-modified']),
    incomplete: false,
    throttled: responseIsThrottled(envelope.status, envelope.headers),
  };
}
function hasHostnameOverride(extraArgs) {
  return (extraArgs ?? []).some(
    (arg) => arg === '--hostname' || arg.startsWith('--hostname='),
  );
}
/**
 * True when `extraArgs` names an HTTP method other than GET for `gh api`
 * (#3621): `--method V`, `--method=V`, `-X V`, `-X=V` or `-XV`, the value
 * compared case-insensitively. A flag with no value, or an empty one, counts,
 * as does any non-GET occurrence of a repeated flag. A bundle of short flags
 * whose letters reach an `X` (for example `-iXPOST` or `-iX=POST`) also
 * counts: it cannot be split without knowing which flags take a value, and
 * wrongly bypassing only costs a cache hit. A request body alone (`--input`,
 * `-f`, `-F`) is not a method: `gh` infers POST for it, and those reads stay
 * cacheable with the body in the entry key.
 */
function hasExplicitNonGetMethod(extraArgs) {
  const args = extraArgs ?? [];
  const isGet = (value) => value?.trim().toLowerCase() === 'get';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    let value;
    if (arg === '--method' || arg === '-X') {
      index += 1;
      value = args[index];
    } else if (arg.startsWith('--method=')) {
      value = arg.slice('--method='.length);
    } else if (arg.startsWith('-X')) {
      value = arg.slice(2).replace(/^=/, '');
    } else if (/^-[A-Za-z]+X/.test(arg)) {
      return true;
    } else {
      continue;
    }
    if (!isGet(value)) return true;
  }
  return false;
}
function ghApiJsonWithReadCache(path, options) {
  const request = options.readCache;
  if (request?.classification !== 'read') {
    return ghApiJsonUncached(path, options);
  }
  const policy = loadReadCachePolicy(request.policy);
  if (!policy.enabled) return ghApiJsonUncached(path, options);
  // A caller that spells a non-GET method is performing a write however it
  // classified the call, so it neither reads from nor writes to the cache.
  // This precedes host and credential resolution: a bypassed write runs no
  // `gh auth` process at all.
  if (hasExplicitNonGetMethod(options.extraArgs)) {
    return ghApiJsonUncached(path, options);
  }
  // The entry key and credential are derived for the environment host. A
  // caller-supplied --hostname would send the request elsewhere, so an
  // explicit override stays uncached rather than keyed under the wrong host.
  if (hasHostnameOverride(options.extraArgs)) {
    return ghApiJsonUncached(path, options);
  }
  const host = resolveReadCacheHost();
  if (host === undefined) return ghApiJsonUncached(path, options);
  const credentialMaterial =
    request.credentialMaterial ?? defaultCredentialMaterial(host);
  if (credentialMaterial === undefined || credentialMaterial.trim() === '') {
    return ghApiJsonUncached(path, options);
  }
  const secrets = [
    ...(request.secretMaterial ?? []),
    process.env.GH_TOKEN ?? '',
    process.env.GITHUB_TOKEN ?? '',
    process.env.GH_ENTERPRISE_TOKEN ?? '',
    process.env.GITHUB_ENTERPRISE_TOKEN ?? '',
    credentialMaterial,
  ];
  let thrown;
  const result = readThroughGithubApiCache({
    classification: 'read',
    mode: request.mode,
    policy,
    host,
    repository: request.repository ?? '',
    credentialMaterial,
    secretMaterial: secrets,
    requestShape: {
      caller: request.requestShape ?? null,
      path,
      extraArgs: options.extraArgs ?? [],
      paginate: options.paginate === true,
      input: options.input ?? null,
    },
    derivedInputs: request.derivedInputs ?? null,
    paginated: options.paginate === true,
    fetch: (conditional) => {
      thrown = undefined;
      try {
        return fetchForReadCache(path, options, conditional, host);
      } catch (error) {
        // A definitive 404/410 reaches the cache so it drops the stored
        // 200; the original error is rethrown below, so the caller sees
        // the same failure it would without a cache.
        const status = deriveGhHttpStatus(error);
        if (status !== 404 && status !== 410) throw error;
        thrown = { error };
        return { status, body: null, incomplete: false };
      }
    },
    now: request.now,
    leaseTtlMs: readCacheLeaseTtlMs(options, request),
    workspaceRoot: request.workspaceRoot ?? process.cwd(),
    cwd: process.cwd(),
    defaultDirectory: request.defaultDirectory,
  });
  if (thrown !== undefined) throw thrown.error;
  return result.body;
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
 *
 * **Stderr suppression (#3076).** Field feedback (gist round 17) traced an
 * unexplained raw `gh: Not Found (HTTP 404)` line on `pre-merge-readiness`'s
 * real stderr/CI-log stream, even on a fully successful run, to this
 * function: `execFileSync` with no explicit `stdio` sets Node's own
 * `inheritStderr = !options.stdio` internal flag, which relays the
 * captured stderr buffer to the real process stderr via
 * `process.stderr.write(ret.stderr)` after the child exits, regardless of
 * exit status -- independent of whether the caller goes on to catch and
 * correctly handle the failure (as every existing `allowStatuses`/404
 * caller here already does). Passing `stdio: ['ignore', 'pipe', 'pipe']`
 * disables that relay while leaving stdout/stderr fully captured via the
 * pipe, so `error.stdout`/`error.stderr` and the message text
 * `checkExecSyncError` embeds from that same captured buffer are
 * unaffected -- confirmed empirically against a throwaway Node script.
 * The one behavior change this introduces: a *successful* call that
 * happens to write to stderr (e.g. a `gh` deprecation notice) no longer
 * prints it either, matching the existing `GH_TEXT_LOOP_OPTIONS` opt-in
 * callers elsewhere in this module. A caller whose own `catch` swallows a
 * failure with no logging of its own (several best-effort collectors in
 * `provider-health.mts`, `live-status-digest.mts`, and
 * `provider-outage-park.mts`) loses that failure's only diagnostic
 * surface, which used to be this same accidental stderr leak -- that is
 * this fix's intended effect, not a regression to chase; a future report
 * of silent degradation there should add a log line at the caller, not
 * revert this change.
 *
 * Paginated calls do not use this `execFileSync` path. See
 * {@link readPaginatedGhApi}.
 */
export function ghApiJson(path, options = {}) {
  if (options.readCache !== undefined) {
    return ghApiJsonWithReadCache(path, options);
  }
  return ghApiJsonUncached(path, options);
}
function executeGhApiJson(path, options = {}, cacheHost) {
  const { paginate = false, extraArgs = [], allowStatuses = [] } = options;
  const hostname = resolveGhApiHostname() ?? explicitCacheHostname(cacheHost);
  const observeHttp = !paginate && telemetryIsEnabled();
  const args = [
    'api',
    path,
    ...(hostname ? ['--hostname', hostname] : []),
    ...extraArgs,
  ];
  if (paginate) {
    args.push('--paginate', '--jq', '.[]');
  } else if (observeHttp) {
    args.push('--include');
  }
  const timeout =
    options.timeout ??
    (paginate ? DEFAULT_GH_PAGINATED_TIMEOUT_MS : DEFAULT_GH_TIMEOUT_MS);
  if (paginate) {
    let read;
    try {
      read = readPaginatedGhApi(args, {
        timeout,
        input: options.input,
        allowStatuses,
      });
    } catch (error) {
      // A failure of the gh run is recorded as a failure. A body that fails
      // to parse after a clean exit still consumed a request, so it is
      // recorded as an observation with no status (#3616), never as a
      // failed gh run. A temp-dir or size-limit error carries neither tag
      // and is not recorded.
      if (isTaggedGhCommandError(error)) {
        recordTransportObservation(() =>
          observeGhFailure(failureEvidence(error, true), { paginated: true }),
        );
      } else if (isResponseParseFailure(error)) {
        recordResponseParseFailure(null, { paginated: true });
      }
      throw error;
    }
    // A tolerated failure is recorded as a failure, from its stderr only:
    // the tolerated stdout is page data, not an error body.
    recordTransportObservation(() =>
      read.toleratedFailure
        ? observeGhFailure(
            { stderr: read.toleratedStderr },
            { paginated: true },
          )
        : observeGhSuccess({ data: read.items, paginated: true }),
    );
    return { data: read.items, toleratedFailure: read.toleratedFailure };
  }
  let raw;
  let toleratedFailure = false;
  try {
    raw = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  } catch (error) {
    const failure = error;
    const status = Number(failure?.status ?? -1);
    if (!allowStatuses.includes(status)) {
      recordTransportObservation(() =>
        observeGhFailure(failureEvidence(error, paginate), {
          paginated: paginate,
        }),
      );
      throw tagGhCommandError(error);
    }
    toleratedFailure = true;
    const stdout = String(failure?.stdout ?? '');
    const included = observeHttp ? tryParseIncludedBody(stdout) : null;
    // An envelope parser turns an empty body into `{}`. That is fine for
    // a real success, and wrong for a tolerated failure: telemetry must
    // not turn an empty error body into a returned object.
    if (included && includedBodyIsJson(stdout)) {
      recordTransportObservation(() =>
        observeGhSuccess({
          status: statusFromIncluded(stdout),
          headers: included.headers,
          data: included.data,
        }),
      );
      return { data: included.data, toleratedFailure };
    }
    if (observeHttp) {
      // Empty or non-JSON stdout still throws the original gh error.
      // Only plain JSON, or an envelope whose body is JSON, is recovered.
      try {
        const data = parseToleratedGhBody(stdout);
        recordTransportObservation(() =>
          observeGhFailure(error, { paginated: paginate }),
        );
        return { data, toleratedFailure };
      } catch {
        // Fall through to the original failure below.
      }
      recordTransportObservation(() =>
        observeGhFailure(error, { paginated: paginate }),
      );
      throw tagGhCommandError(error);
    }
    if (!/^\s*[[{]/.test(stdout)) {
      recordTransportObservation(() =>
        observeGhFailure(failureEvidence(error, paginate), {
          paginated: paginate,
        }),
      );
      throw tagGhCommandError(error);
    }
    raw = stdout;
  }
  if (observeHttp) {
    const included = tryParseIncludedBody(raw);
    if (included) {
      recordTransportObservation(() =>
        observeGhSuccess({
          status: statusFromIncluded(raw),
          headers: included.headers,
          data: included.data,
        }),
      );
      return { data: included.data, toleratedFailure };
    }
    let data;
    try {
      data = parseObservedGhBody(raw);
    } catch (error) {
      recordResponseParseFailure(raw);
      throw error;
    }
    recordTransportObservation(() => observeGhSuccess({ data }));
    return { data, toleratedFailure };
  }
  // JSON.parse itself ignores surrounding whitespace, so only trim to
  // decide whether the output was empty.
  const data = JSON.parse(raw.trim() || '{}');
  recordTransportObservation(() => observeGhSuccess({ data }));
  return { data, toleratedFailure };
}
function ghApiJsonUncached(path, options = {}) {
  return executeGhApiJson(path, options).data;
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
export function ghGraphql(query, variables) {
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
  let raw;
  try {
    raw = ghText(args);
  } catch (error) {
    recordTransportObservation(() =>
      observeGhFailure(error, { graphql: true }),
    );
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw.trim() || '{}');
  } catch (error) {
    recordResponseParseFailure(null, { httpObserved: false, graphql: true });
    throw error;
  }
  recordTransportObservation(() =>
    observeGhSuccess({ data, httpObserved: false, graphql: true }),
  );
  return data;
}
/** #2148: REST `GET /user` failures that may still have a live GraphQL
 * `viewer { login }` — 5xx, timeout, or a killed child. Unclassified
 * errors and 4xx stay fail-closed on REST (no GraphQL fallback), so an
 * unparsable 4xx cannot leak through `deriveGhHttpStatus() === null`. */
export function viewerLoginFailureIsGraphqlEligible(error) {
  const code = String(error?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return true;
  }
  if (error?.killed === true) {
    return true;
  }
  const status = deriveGhHttpStatus(error);
  if (status == null) {
    return false;
  }
  return status >= 500 && status <= 599;
}
function defaultRestViewerLogin(options = {}) {
  return ghText(['api', 'user', '--jq', '.login'], options);
}
function defaultGraphqlViewerLogin() {
  const payload = ghGraphql('query { viewer { login } }', {});
  const root = payload;
  return String(root.data?.viewer?.login ?? root.viewer?.login ?? '').trim();
}
/** Resolve the current GitHub actor login for A5 collectors (#2148).
 *
 * REST `GET /user` first. On 5xx, timeout, or empty body, try GraphQL
 * `viewer { login }` once. 4xx does not fall back. If both fail, the
 * original REST error is rethrown (today's fail-closed abort). */
export function resolveViewerLogin(options = {}, deps = {}) {
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
// Only the capture worker entry should run here. Another worker that
// imports this module has unrelated workerData; exiting would kill it
// (Copilot review, PR #3605).
const captureWorkerKind = workerData;
if (
  !isMainThread &&
  captureWorkerKind !== null &&
  typeof captureWorkerKind === 'object' &&
  captureWorkerKind.kind === PAGINATED_CAPTURE_KIND
) {
  runPaginatedCaptureWorker();
}
