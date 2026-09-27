// idd-generated-from: src/scripts/helper-cli-runner.mts
//
// The scripts/helper-cli-runner.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared CLI runner + opt-in JSON error envelope (#3342). Field incidents
// this exists to remove: #2707 (a polling loop re-hit the same uncaught
// missing-argument exception for ~90 minutes -- indistinguishable from a
// genuine "not ready yet" verdict by exit code alone), #2806 (a transient
// `gh: HTTP 503` produced output shaped like a gate failure), #3188/#3143
// (helper-to-helper flag-name drift), #3213 (a failing check's evidence was
// hidden without --verbose), #3076 (a wrapper leaked child stderr on an
// expected, handled error), and #2714/#3145 (an unrecognized CI state
// collapsed into a failure verdict). None of those incidents could be told
// apart mechanically -- a caller only ever saw "non-zero exit", never
// *which* of "you called me wrong" / "gh is having a bad day" / "this is
// the real verdict" / "something broke" produced it.
//
// Opt-in via `IDD_HELPER_ERROR_ENVELOPE=1` (an environment variable, not a
// flag: an older or not-yet-migrated helper ignores an unknown env var
// instead of crashing with `unknown argument: --envelope` the way an
// unrecognized flag would). With the variable unset, a migrated helper's
// stdout, stderr, and exit code are byte-identical to before migration --
// this module never changes default behavior. With it set, a migrated
// helper appends exactly one line to stderr on a non-zero exit: the
// single-line JSON envelope below, always the LAST stderr line -- even when
// the failure is an uncaught exception whose own crash text Node prints to
// stderr first (see `RunHelperCliIo.takeOverUncaughtCrash` below for how
// {@link runHelperCli} keeps that ordering -- `process.on('exit')` looks
// like the obvious tool for this and is NOT: verified empirically, an
// `exit` listener's own write completes BEFORE Node's default crash text
// is printed, so it cannot append anything after it).

import { writeSync } from 'node:fs';
import { deriveGhHttpStatus, ghErrorText } from './gh-http-status.mts';

/** The environment variable that opts a migrated helper into the error
 * envelope (see module header). Unset or any value other than `'1'` keeps
 * today's unmigrated behavior. */
export const ERROR_ENVELOPE_ENV_VAR = 'IDD_HELPER_ERROR_ENVELOPE';

/**
 * Discriminates the envelope's `kind` field:
 *
 * - `usage`: invalid arguments, before any network call.
 * - `not-found`: a `gh` failure whose derived status is 404.
 * - `transport`: any other `gh` failure -- 5xx, 429, 401, 403 (including a
 *   secondary rate limit), 422 and other 4xx, a timeout or killed child, a
 *   failed spawn, or a failure with no derivable status (`httpStatus:
 *   null`).
 * - `gate`: the helper completed and its verdict is the non-zero exit.
 * - `internal`: an unexpected exception none of the above classifies, so
 *   the envelope is always present when opted in.
 */
export type IddHelperErrorKind =
  | 'usage'
  | 'not-found'
  | 'transport'
  | 'gate'
  | 'internal';

/** The one-line JSON envelope {@link runHelperCli} appends to stderr, as
 * the last line, on a non-zero exit when the error envelope is enabled. */
export interface IddHelperErrorEnvelope {
  iddHelperError: {
    version: 1;
    helper: string;
    kind: IddHelperErrorKind;
    exitCode: number;
    message: string;
    httpStatus: number | null;
  };
}

/**
 * A usage error a migrated helper's CLI body can throw when it already
 * knows the failure is never reached through an uncaught-propagation path
 * (for example, inside a `try`/`catch` that renders its own compatibility
 * output and reports the result to {@link runHelperCli} as an outcome
 * object rather than letting the error escape -- see
 * `pre-merge-readiness.mts`'s pattern). {@link classifyHelperError} maps
 * an instance of this class to `usage` unconditionally.
 *
 * For a usage error that DOES reach an uncaught-propagation path today
 * (`parseCliArgs`'s shaped errors, and every migrated helper's own
 * hand-rolled "X is required" pre-network checks), use {@link
 * markCliUsageError} on a plain `Error` instead -- never this class.
 * Subclassing `Error` changes Node's own default uncaught-exception
 * rendering (the printed class name) even when the subclass's `.name` is
 * left at the inherited `"Error"` -- verified empirically. Throwing this
 * class from a path that can still crash uncaught would silently change
 * that crash's printed text for every caller reaching that path, not
 * only a migrated one, breaking the "byte-identical when the envelope is
 * unset" contract from this module's header.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * Non-enumerable tag properties {@link classifyHelperError} recognizes
 * structurally: this one (via {@link markCliUsageError}) and
 * `gh-exec.mts`'s equivalent `ghCommand` tag (see {@link
 * GhCommandTaggedError}) both use a non-enumerable property rather than a
 * distinct `Error` subclass (see {@link CliUsageError}'s own doc comment
 * for why a subclass is unsafe here) AND rather than an enumerable
 * property: `util.inspect`'s own
 * Error-object rendering (what Node's default uncaught-exception crash
 * text uses) prints every OWN ENUMERABLE property trailing an Error, so
 * an enumerable tag would add a visible `{ cliUsage: true }` (or
 * `{ ghCommand: true }`) block to every existing caller's crash output
 * the moment such an error propagates uncaught -- verified empirically.
 * `enumerable: false` keeps each tag readable while leaving every
 * existing caller's byte-for-byte crash text unchanged.
 */
const CLI_USAGE_TAG = 'cliUsage';

/**
 * Tag a plain `Error` (never a subclass -- see {@link CliUsageError}) as
 * a usage error via the non-enumerable {@link CLI_USAGE_TAG} property, so
 * {@link classifyHelperError} recognizes it structurally instead of
 * re-matching message text. Applied by `cli-args.mts`'s
 * `toRepoShapedError` (its three shaped prefixes) and by each migrated
 * helper's own hand-rolled pre-network argument checks (e.g. "missing
 * required --pr <number> argument") -- both classes of check that
 * reach an uncaught-propagation path today, so neither can safely use
 * {@link CliUsageError} instead. A no-op (not re-defined) when `error`
 * already carries the tag, or is not an object at all.
 */
export function markCliUsageError<T>(error: T): T {
  if (
    error &&
    typeof error === 'object' &&
    !Object.hasOwn(error, CLI_USAGE_TAG)
  ) {
    Object.defineProperty(error, CLI_USAGE_TAG, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

function isMarkedCliUsageError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as Record<string, unknown>)[CLI_USAGE_TAG] === true,
  );
}

/**
 * A `gh`-invoking wrapper in `gh-exec.mts` tags every error it throws with
 * a non-enumerable `ghCommand: true` property (see that module and
 * {@link CLI_USAGE_TAG}'s own doc comment for why non-enumerable) so
 * {@link classifyHelperError} can recognize a `gh` failure structurally --
 * via this property plus `deriveGhHttpStatus` -- instead of guessing from
 * message text.
 */
export interface GhCommandTaggedError {
  ghCommand?: true;
}

function isGhCommandError(error: unknown): error is GhCommandTaggedError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as GhCommandTaggedError).ghCommand === true,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ghCommandErrorMessage(error: unknown): string {
  const text = ghErrorText(error);
  return text || errorMessage(error);
}

/** Bounds {@link causeChain}'s walk so a pathological/cyclic `.cause`
 * chain cannot hang classification -- none of this repository's own
 * error-wrapping helpers currently produce one, but the walk must not
 * assume that holds forever. */
const MAX_CAUSE_CHAIN_DEPTH = 8;

/**
 * Yields `error` itself, then each `.cause` link (Node/ES2022's standard
 * `Error` chaining field) up to {@link MAX_CAUSE_CHAIN_DEPTH}. A wrapper
 * like `provider-adapter-github.mts`'s `toProviderError` builds a brand
 * new `Error` carrying its own translated `message`/`category` while
 * preserving the original, `gh-exec.mts`-tagged failure only as
 * `.cause` -- so the tag {@link classifyHelperError} looks for can sit
 * several layers below the value a caller actually throws. Walking the
 * chain is what lets `discover-readiness-check.mts` /
 * `discover-viability-gate.mts` / `authoring-owner-provenance.mts` /
 * `resume-claim-routing.mts` -- none of which call `gh-exec.mts`
 * directly for their issue lookup, all of which go through
 * `ProviderPort.getWorkItem()` instead -- still classify a real `gh`
 * transport failure as `transport`/`not-found` instead of losing it to
 * the generic `internal` fallback. Observed against the built bins
 * before this walk existed (#3342): `IDD_HELPER_ERROR_ENVELOPE=1 node
 * bin/idd-discover-readiness-check.mjs --issue 1 --owner X --repo Y`
 * against a fake `gh` that fails with `gh: HTTP 503` reported
 * `"kind":"internal","httpStatus":null` instead of `"kind":"transport"`.
 */
function* causeChain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_CHAIN_DEPTH && current !== null && current !== undefined;
    depth += 1
  ) {
    yield current;
    current = current instanceof Error ? current.cause : undefined;
  }
}

/** {@link classifyHelperError}'s result: everything {@link
 * buildHelperErrorEnvelope} needs besides the exit code, which the caller
 * (a returned outcome, or the process's own final exit code for a thrown
 * error) supplies separately. */
export interface ClassifiedHelperError {
  kind: IddHelperErrorKind;
  message: string;
  httpStatus: number | null;
}

/**
 * Classify a thrown value into the envelope's `kind` vocabulary. Walks
 * `error` and its {@link causeChain} (outermost first), checking each
 * link in this order:
 *
 * 1. `instanceof CliUsageError`, or a plain `Error` carrying the
 *    {@link markCliUsageError} tag -> `usage` (see that class's and that
 *    function's own doc comments for the narrow, crash-safe scope each
 *    covers, and why classification is tag-based, never message-based).
 * 2. A `gh-exec.mts`-tagged error (see {@link GhCommandTaggedError}) ->
 *    `not-found` when {@link deriveGhHttpStatus} resolves exactly `404`,
 *    else `transport` (covers every other status, a timeout, a killed
 *    child, a failed spawn, and "no derivable status" alike -- all of
 *    them are "gh had a bad day", never a genuine verdict).
 *
 * The first link satisfying either check wins; a link is checked for
 * `usage` before `transport`/`not-found` (matching this function's own
 * pre-chain-walk behavior when both happened to be the same value). No
 * link in the chain matches either check -> `internal`, derived from the
 * outermost `error` (its message is what a caller who is not itself
 * chain-aware -- e.g. a log line -- already shows).
 *
 * Exported so a helper whose own entrypoint already catches errors to
 * render its own compatibility output (e.g. `pre-merge-readiness.mts`'s
 * `{"error": ...}` stdout JSON) can classify the same error itself before
 * rendering, then report the result to {@link runHelperCli} as an
 * already-classified outcome instead of losing the classification to a
 * generic `gate` (see {@link HelperCliResult}).
 */
export function classifyHelperError(error: unknown): ClassifiedHelperError {
  for (const candidate of causeChain(error)) {
    if (
      candidate instanceof CliUsageError ||
      isMarkedCliUsageError(candidate)
    ) {
      return {
        kind: 'usage',
        message: errorMessage(candidate),
        httpStatus: null,
      };
    }
    if (isGhCommandError(candidate)) {
      const httpStatus = deriveGhHttpStatus(candidate);
      return {
        kind: httpStatus === 404 ? 'not-found' : 'transport',
        message: ghCommandErrorMessage(candidate),
        httpStatus,
      };
    }
  }
  return { kind: 'internal', message: errorMessage(error), httpStatus: null };
}

/** Build the envelope object {@link runHelperCli} serializes onto stderr. */
export function buildHelperErrorEnvelope(
  helperName: string,
  exitCode: number,
  classified: ClassifiedHelperError,
): IddHelperErrorEnvelope {
  return {
    iddHelperError: {
      version: 1,
      helper: helperName,
      kind: classified.kind,
      exitCode,
      message: classified.message,
      httpStatus: classified.httpStatus,
    },
  };
}

/**
 * Outcome a migrated helper's CLI body (`main`, passed to {@link
 * runHelperCli}) returns instead of calling `process.exit` itself:
 *
 * - a plain `number` -- `0` is success; any other value is classified
 *   `gate` (the helper completed and its verdict IS the non-zero exit,
 *   e.g. a not-yet-ready readiness report).
 * - `{ exitCode, kind, message?, httpStatus? }` -- for a helper that
 *   already caught and classified its own error (see {@link
 *   classifyHelperError}) and rendered its own compatibility stdout/stderr
 *   output; `runHelperCli` trusts this shape verbatim rather than
 *   re-classifying or re-rendering anything.
 */
export type HelperCliResult =
  | number
  | {
      exitCode: number;
      kind: IddHelperErrorKind;
      message?: string;
      httpStatus?: number | null;
    };

interface NormalizedHelperCliOutcome {
  exitCode: number;
  kind: IddHelperErrorKind;
  message: string;
  httpStatus: number | null;
}

function normalizeOutcome(
  helperName: string,
  outcome: HelperCliResult,
): NormalizedHelperCliOutcome {
  if (typeof outcome === 'number') {
    return {
      exitCode: outcome,
      kind: 'gate',
      message: `${helperName} exited with code ${outcome}`,
      httpStatus: null,
    };
  }
  return {
    exitCode: outcome.exitCode,
    kind: outcome.kind,
    message:
      outcome.message ?? `${helperName} exited with code ${outcome.exitCode}`,
    httpStatus: outcome.httpStatus ?? null,
  };
}

/**
 * I/O seam {@link runHelperCli} uses instead of calling `process.*`
 * directly, so a unit test can observe its decisions without spawning a
 * real subprocess. The default (real) implementation is {@link
 * DEFAULT_HELPER_CLI_IO}.
 */
export interface RunHelperCliIo {
  /** Read for the `IDD_HELPER_ERROR_ENVELOPE` opt-in. */
  env: NodeJS.ProcessEnv;
  /** Write a line to stderr immediately, via a raw synchronous fd write --
   * used only on the crash path (see {@link handleThrown}), where
   * `takeOverUncaughtCrash` calls `process.exit(1)` right after, and only
   * a raw synchronous write is guaranteed not to be truncated by that
   * exit. */
  writeStderr: (text: string) => void;
  /**
   * Write a line to stderr through Node's own buffered/queued stdio
   * stream (`process.stderr.write()`), never a raw synchronous fd write
   * -- used on the returned-outcome path (see {@link handleOutcome}),
   * where nothing forces an immediate `process.exit()` afterward (#3346
   * review finding). A raw synchronous write there is not merely
   * unnecessary, it is actively wrong: it bypasses `process.stderr`'s
   * internal write queue entirely, reaching the underlying fd
   * immediately regardless of whatever the helper's own preceding
   * `process.stderr.write()` calls (for example a progress stream) still
   * has buffered and draining -- verified empirically to reorder stderr
   * output under real pipe backpressure, landing the envelope line well
   * before the end instead of genuinely last. Queuing behind the
   * existing stream instead preserves arrival order for free, and
   * nothing here forces the process to exit before that queue drains.
   */
  writeStderrQueued: (text: string) => void;
  /** Set the process's eventual exit code (mirrors `process.exitCode`). */
  setExitCode: (code: number) => void;
  /**
   * Take over rendering the crash Node would otherwise print by default
   * for a thrown/rejected `error` left to propagate uncaught, so
   * `render` can write the envelope line genuinely last. Called at most
   * once, only when the envelope is enabled (the caller checks first).
   *
   * `process.on('exit')` cannot do this job -- verified empirically, an
   * `exit` listener's own stderr write completes BEFORE Node's default
   * uncaught-exception text is printed, the opposite of what "append
   * after" needs, and there is no later JS-observable hook: Node's
   * default crash print is the true final native step before process
   * death. Taking over `uncaughtException` (which also fires for an
   * unhandled rejection under Node's default `--unhandled-rejections`
   * mode, `throw`) is the only reliable way to control what prints
   * after the crash text, at the cost of losing Node's own pretty
   * source-line-preview/caret/version-footer decoration around it --
   * `render` reproduces the substantive part (`error.stack`, still
   * `"<Name>: <message>"` plus every frame) instead. This trade only
   * ever applies to the opt-in envelope-enabled path; envelope-unset
   * behavior installs no handler and is completely untouched.
   */
  takeOverUncaughtCrash: (render: (error: unknown) => void) => void;
}

function isEnvelopeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[ERROR_ENVELOPE_ENV_VAR] === '1';
}

/**
 * True when the opt-in JSON error envelope (`IDD_HELPER_ERROR_ENVELOPE=1`,
 * see module header) is enabled. Exported so a migrated helper's own
 * `if (import.meta.main)` trigger can decide, AT THE CALL SITE, whether
 * to route through {@link runHelperCli} at all -- see {@link
 * applyHelperCliOutcomeWhenDisabled}'s own doc comment for why this
 * split is required, not merely a style preference.
 */
export function isHelperErrorEnvelopeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isEnvelopeEnabled(env);
}

/**
 * Applies a migrated helper's `HelperCliResult` outcome the same way
 * {@link runHelperCli} would -- setting the process exit code from a
 * RETURNED (never thrown) outcome -- but doing no envelope-related work
 * at all, for a caller that already knows the envelope is disabled and
 * has therefore called `main`/`runCli` DIRECTLY instead of through
 * {@link runHelperCli}.
 *
 * Why the split is required (verified empirically, #3342 review round
 * 5, Copilot): `runHelperCli` itself unavoidably adds its own frame to
 * the V8-captured stack of any error CONSTRUCTED while `main` is
 * invoked from inside it -- a plain `try`/`catch` does not add or
 * remove a captured stack frame, so wrapping `main` in ANY function,
 * regardless of that function's own internal structure, adds that
 * function's frame the moment it calls `main`. This breaks the module
 * header's own "byte-identical when the envelope is unset" contract
 * for a helper's raw, unclassified (`internal`) uncaught-crash text --
 * the one case `run-helper.mts`'s shaped-parse-error handling does NOT
 * intercept and replace outright. Calling `main`/`runCli` directly at
 * the SAME call-site depth pre-migration code always used, then
 * handing its return value to THIS function afterward (never to
 * `main`/`runCli` itself), is the only way to both avoid that added
 * frame AND still correctly apply a future helper's non-zero-return
 * `gate` verdict -- none of the six first-batch helpers currently
 * returns non-zero (each only ever `return`s `0` or throws), but the
 * `HelperCliResult` contract itself anticipates one that does, and
 * silently discarding a returned outcome instead of ever calling this
 * function would silently regress that case to a false "exit 0" the
 * moment a future edit added one.
 *
 * Required call-site pattern (see any of the six first-batch migrated
 * helpers' own `if (import.meta.main)` trigger for a worked example):
 *
 * ```ts
 * if (import.meta.main) {
 *   if (isHelperErrorEnvelopeEnabled()) {
 *     runHelperCli('helper-name', main);
 *   } else {
 *     applyHelperCliOutcomeWhenDisabled(main());
 *   }
 * }
 * ```
 *
 * For an async `main`, chain instead of calling directly:
 * `main().then(applyHelperCliOutcomeWhenDisabled, (error) => { throw error; })`
 * -- verified empirically that a `.then()` callback attached directly at
 * the call site (never inside an intermediate named function) does not
 * itself add a frame to an eventually-uncaught rejection's printed
 * stack, unlike a genuine wrapping function call: Node's zero-cost
 * async stack traces reconstruct the pre-`await` call chain for a
 * rejection propagated this way, rather than including the `.then()`
 * callback's own synchronous call frame. The explicit rethrowing
 * `onRejected` handler is not strictly load-bearing under this
 * repository's own runtime today -- verified empirically that omitting
 * it entirely (`main().then(applyHelperCliOutcomeWhenDisabled)`)
 * produces the same crash text and exit code under Node's default
 * `--unhandled-rejections=throw` mode, since neither this repository
 * nor Node's own default installs a `process.on('unhandledRejection',
 * ...)` handler that would otherwise swallow it -- but it is kept
 * explicit rather than relying on that default, so this call site's own
 * behavior does not silently change if either of those ever does.
 */
export function applyHelperCliOutcomeWhenDisabled(
  outcome: HelperCliResult,
  io: Pick<RunHelperCliIo, 'setExitCode'> = DEFAULT_HELPER_CLI_IO,
): void {
  io.setExitCode(typeof outcome === 'number' ? outcome : outcome.exitCode);
}

/**
 * Write `text` to stderr (fd 2) synchronously, looping until every byte is
 * written -- a single `writeSync` call is not guaranteed to write the
 * whole buffer (`write(2)` may legitimately return fewer bytes than
 * requested without throwing; see `claim-lock.mts`'s own `writeSync` loop
 * for the same reasoning applied to a lock file). Used instead of
 * `process.stderr.write()` specifically because {@link
 * DEFAULT_HELPER_CLI_IO.takeOverUncaughtCrash} calls `process.exit(1)`
 * immediately after rendering: `process.exit()` forces the process to
 * exit even while an asynchronous stdio write is still pending, which can
 * truncate the very envelope line a caller is about to parse (Node's own
 * documented `process.exit()` caveat). A synchronous fd write has no such
 * pending state to race against.
 *
 * Exported (#3346 review finding) for the small number of migrated
 * helpers whose own multi-caller `fail()`-style exit path cannot return
 * through {@link runHelperCli}'s own outcome handling (a literal
 * `process.exit()` call reachable from more than one place, so it must
 * build and write its own envelope line manually before exiting) --
 * `live-status-digest.mts`'s `fail()` and `idd-onboard.mts`'s
 * `exitRecordPolicy()` are the two current callers. Both call
 * `process.exit()` immediately afterward, the same hazard this function
 * exists to avoid for `runHelperCli`'s own internal use.
 */
export function writeStderrSync(text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(2, buffer, written, buffer.length - written);
  }
}

/** The real, `process`-backed {@link RunHelperCliIo}. */
export const DEFAULT_HELPER_CLI_IO: RunHelperCliIo = {
  env: process.env,
  writeStderr: writeStderrSync,
  writeStderrQueued: (text) => {
    process.stderr.write(text);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  takeOverUncaughtCrash: (render) => {
    process.once('uncaughtException', (error) => {
      render(error);
      process.exit(1);
    });
  },
};

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(
    value &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function',
  );
}

function envelopeLineFor(
  io: RunHelperCliIo,
  helperName: string,
  exitCode: number,
  classified: ClassifiedHelperError,
): string | null {
  if (exitCode === 0 || !isEnvelopeEnabled(io.env)) {
    return null;
  }
  return `${JSON.stringify(
    buildHelperErrorEnvelope(helperName, exitCode, classified),
  )}\n`;
}

/**
 * A thrown (never returned) error: classify it. With the envelope
 * disabled, do nothing at all and let the error keep propagating (the
 * caller rethrows) so Node's own default uncaught-exception rendering
 * runs completely unchanged -- the "byte-identical when the envelope is
 * unset" contract from the module header. With the envelope enabled,
 * take over rendering the crash (see {@link
 * RunHelperCliIo.takeOverUncaughtCrash}) so the envelope line can be
 * written genuinely last. Never rendered here for a caller with its own
 * compatibility rendering -- that caller reports through the
 * returned-outcome path instead (see {@link HelperCliResult}), not by
 * throwing.
 */
function handleThrown(
  helperName: string,
  io: RunHelperCliIo,
  error: unknown,
): void {
  if (!isEnvelopeEnabled(io.env)) {
    return;
  }
  const classified = classifyHelperError(error);
  io.takeOverUncaughtCrash((caughtError) => {
    const crashText =
      caughtError instanceof Error && typeof caughtError.stack === 'string'
        ? caughtError.stack
        : errorMessage(caughtError);
    io.writeStderr(`${crashText}\n`);
    const line = envelopeLineFor(io, helperName, 1, classified);
    if (line !== null) {
      io.writeStderr(line);
    }
  });
}

/**
 * A returned (never thrown) outcome: no `process.exit()` forces the
 * process down immediately afterward here (only `process.exitCode` is
 * set; the process exits naturally once its stdio queues drain), so the
 * envelope line is written through the normal queued stream (see {@link
 * RunHelperCliIo.writeStderrQueued}) rather than a raw synchronous fd
 * write -- queuing behind whatever the helper's own `main` already
 * wrote to stderr (for example a progress stream) is what keeps this
 * line genuinely last, matching the crash path's own use of a raw write
 * for the opposite reason (there, `process.exit()` *does* follow
 * immediately, so only a synchronous write is safe -- see {@link
 * handleThrown}). #3346 review finding: the raw synchronous write this
 * replaced bypassed `process.stderr`'s own internal write queue and
 * could reach the underlying fd before an earlier, still-draining
 * `process.stderr.write()` call from the helper's own `main` under real
 * pipe backpressure -- verified empirically to reorder stderr output,
 * landing the envelope well before the actual last line instead of
 * genuinely last.
 */
function handleOutcome(
  helperName: string,
  io: RunHelperCliIo,
  outcome: HelperCliResult,
): void {
  const normalized = normalizeOutcome(helperName, outcome);
  io.setExitCode(normalized.exitCode);
  const line = envelopeLineFor(io, helperName, normalized.exitCode, {
    kind: normalized.kind,
    message: normalized.message,
    httpStatus: normalized.httpStatus,
  });
  if (line !== null) {
    io.writeStderrQueued(line);
  }
}

/**
 * Run a migrated helper's CLI body (`main`), wiring it to the opt-in JSON
 * error envelope (see module header) without changing default (envelope
 * unset) behavior at all.
 *
 * `main` returns an exit code (`0` for success, any other value for a
 * `gate` verdict) or a pre-classified outcome object (see {@link
 * HelperCliResult}), or throws. A caller with its own top-level catch that
 * renders compatibility output (`pre-merge-readiness.mts`) must classify
 * the error itself with {@link classifyHelperError} and return the result
 * as an outcome object -- letting the error reach this function via throw
 * would report it as `gate` instead of its real classification, and
 * would additionally re-render output this caller already rendered.
 *
 * Every other migrated helper simply lets `main` throw; this function
 * classifies the error and rethrows it so the process crashes exactly as
 * it did before migration (envelope unset), or takes over rendering that
 * crash so the envelope line can be appended genuinely last (envelope
 * enabled -- see {@link RunHelperCliIo.takeOverUncaughtCrash}).
 */
export function runHelperCli(
  helperName: string,
  main: () => HelperCliResult | Promise<HelperCliResult>,
  io: RunHelperCliIo = DEFAULT_HELPER_CLI_IO,
): void | Promise<void> {
  let result: HelperCliResult | Promise<HelperCliResult>;
  try {
    result = main();
  } catch (error) {
    handleThrown(helperName, io, error);
    throw error;
  }
  if (isPromiseLike<HelperCliResult>(result)) {
    return result.then(
      (value) => {
        handleOutcome(helperName, io, value);
      },
      (error) => {
        handleThrown(helperName, io, error);
        throw error;
      },
    );
  }
  handleOutcome(helperName, io, result);
  return undefined;
}
