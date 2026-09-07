#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-critique-telemetry-hook.mts
//
// The scripts/idd-critique-telemetry-hook.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Resolution + fire-and-forget invocation for the C-phase
// `critiqueLoop.telemetryHook` per-round notification (#2679). Mirrors
// `idd-critique-delegate.mts`'s shape (typed report interface, a
// `build*Report` function, a thin CLI wrapper) for the resolution half --
// delegating entirely to `resolveEffectiveCritiqueLoopTelemetryHookFromEnv`
// (idd-config.mts), which in turn calls
// `resolveEffectiveCritiqueLoopTelemetryHook` / `inspectCritiqueLoopTelemetryHookLayer`
// (policy-helpers.mts) -- but this file additionally owns the *invocation*
// half `idd-critique-delegate.mts` has no equivalent for: unlike the
// delegate (whose findings the agent consumes and whose failure can hold
// C1), the telemetry hook's entire contract is "never blocks, holds, or
// delays C-phase control flow" -- see `buildCritiqueTelemetryHookPayload`
// and `invokeCritiqueTelemetryHook` below, and their CLI `--invoke` mode.

import { type ChildProcess, spawn } from 'node:child_process';

import { parseCliArgs } from './cli-args.mts';
import { resolveEffectiveCritiqueLoopTelemetryHookFromEnv } from './idd-config.mts';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `policy:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --policy spec key
// below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const IDD_CRITIQUE_TELEMETRY_HOOK_FLAG_SPEC = {
  '--policy': { type: 'string' },
  '--no-user-global': { type: 'boolean', default: false },
  '--invoke': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

// Also declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason as the flag spec above.
const NO_TELEMETRY_HOOK_REASONS: Record<string, string> = {
  disabled: 'repository-local-explicit-disable',
  none: 'not-configured',
};

/** Bound on how long a spawned hook command may run before it is killed. */
const DEFAULT_INVOKE_TIMEOUT_MS = 5_000;

/** Bound on how long `--invoke` waits for a piped stdin payload. */
const STDIN_READ_TIMEOUT_MS = 2_000;

/**
 * Bound on how long `--invoke` waits for the hook's stdin handoff to
 * complete before exiting anyway (#2685 review, CodeRabbit) -- a *much*
 * smaller ask than `DEFAULT_INVOKE_TIMEOUT_MS` above, since it is only
 * covering the stdin write reaching the child's pipe (normally near-
 * instant for this small a JSON payload), not the hook running to
 * completion. A caller that never gets an `onPayloadDelivered` signal at
 * all (e.g. a `spawnFn` stub that doesn't wire up a real stdin) still
 * exits promptly rather than hanging on `--invoke`'s "never blocks"
 * contract.
 */
const PAYLOAD_DELIVERY_TIMEOUT_MS = 1_000;

if (import.meta.main) {
  runCli();
}

export interface CritiqueTelemetryHookReport {
  usable: boolean;
  source: 'repository-local' | 'user-global' | 'none';
  command: string | null;
  reason: string | null;
}

/**
 * `docs/idd-workflow.md`'s "User-global critique telemetry hook default"
 * contract mirrors the delegate's own: a GitHub-hosted or other remote
 * agent surface has no operator home directory and never consults this
 * layer. This local duplicate of `idd-critique-delegate.mts`'s
 * `isRemoteAgentSurface` is intentional, not an oversight -- see that
 * file's own function for the full rationale. No shared home for this
 * one-line check exists elsewhere in the repository (every other
 * `GITHUB_ACTIONS` read is likewise a local inline check), so duplicating
 * it here keeps this module independent of the unrelated delegate module
 * rather than importing a single-purpose helper across a module boundary
 * for three lines.
 */
function isRemoteAgentSurface(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

/**
 * Build the resolution report from the layered resolver's result. Pure
 * mapping: `status`/`source`/`hook`/`reason` come from
 * {@link resolveEffectiveCritiqueLoopTelemetryHookFromEnv} unchanged; this
 * function only decides `usable` and fills in a machine-readable `reason`
 * for the two unusable statuses that resolver leaves reason-less
 * (`disabled`, `none`).
 */
export function buildCritiqueTelemetryHookReport(
  options?: Parameters<
    typeof resolveEffectiveCritiqueLoopTelemetryHookFromEnv
  >[0],
  noUserGlobal = false,
): CritiqueTelemetryHookReport {
  const env = options?.env ?? process.env;
  // Blanking `env` alone is not enough -- see buildCritiqueDelegateReport's
  // own comment for the identical reasoning: clear globalConfigPath/homedir
  // too, so opting out means the layer is never consulted at all.
  const resolvedOptions =
    noUserGlobal || isRemoteAgentSurface(env)
      ? { ...options, env: {}, globalConfigPath: undefined, homedir: undefined }
      : options;
  const effective =
    resolveEffectiveCritiqueLoopTelemetryHookFromEnv(resolvedOptions);
  const usable = effective.status === 'local' || effective.status === 'global';
  return {
    usable,
    source: effective.source,
    command: usable ? (effective.hook?.command ?? null) : null,
    reason: usable
      ? null
      : (effective.reason ??
        NO_TELEMETRY_HOOK_REASONS[effective.status] ??
        effective.status),
  };
}

/** Severity counts the C1 critique pass reported for one round. */
export interface CritiqueTelemetryHookSeverityBreakdown {
  high: number;
  medium: number;
  low: number;
}

/** The exact JSON shape sent on the hook command's stdin (#2679). */
export interface CritiqueTelemetryHookPayload {
  phase: 'C';
  round: number;
  repo: string;
  issue: number;
  pr: number | null;
  findingsCount: number;
  severityBreakdown: CritiqueTelemetryHookSeverityBreakdown;
  acceptedCount: number;
  rejectedCount: number;
  delegateUsed: boolean;
  delegateCommand?: string;
  timestamp: string;
}

/** Input to {@link buildCritiqueTelemetryHookPayload}. */
export interface BuildCritiqueTelemetryHookPayloadInput {
  round: number;
  repo: string;
  issue: number;
  /** `null` (the default) before a PR exists. */
  pr?: number | null;
  findingsCount: number;
  severityBreakdown: CritiqueTelemetryHookSeverityBreakdown;
  acceptedCount: number;
  rejectedCount: number;
  delegateUsed: boolean;
  /** Only meaningful (and only ever emitted) when `delegateUsed` is `true`. */
  delegateCommand?: string;
  /** Overrides the default `new Date().toISOString()` timestamp. */
  timestamp?: string;
  /** Injectable clock for deterministic tests; ignored when `timestamp` is set. */
  now?: () => Date;
}

/**
 * Build the JSON payload sent on the hook command's stdin. Pure: no I/O.
 *
 * `delegateCommand` is an own-property-**omitted** key -- not `null` --
 * unless `delegateUsed` is `true` and a non-empty `delegateCommand` was
 * given, matching the issue's documented payload shape ("`delegateCommand`
 * present only when `delegateUsed` is `true`").
 */
export function buildCritiqueTelemetryHookPayload(
  input: BuildCritiqueTelemetryHookPayloadInput,
): CritiqueTelemetryHookPayload {
  const timestamp =
    input.timestamp ?? (input.now ? input.now() : new Date()).toISOString();
  const payload: CritiqueTelemetryHookPayload = {
    phase: 'C',
    round: input.round,
    repo: input.repo,
    issue: input.issue,
    pr: input.pr ?? null,
    findingsCount: input.findingsCount,
    severityBreakdown: input.severityBreakdown,
    acceptedCount: input.acceptedCount,
    rejectedCount: input.rejectedCount,
    delegateUsed: input.delegateUsed,
    timestamp,
  };
  if (input.delegateUsed && input.delegateCommand) {
    payload.delegateCommand = input.delegateCommand;
  }
  return payload;
}

/** Result of {@link invokeCritiqueTelemetryHook}. */
export interface InvokeCritiqueTelemetryHookResult {
  /** `false` when `command` was empty/whitespace-only -- no spawn was attempted. */
  attempted: boolean;
  /** `true` only when the spawned command exited `0` within the timeout. */
  ok: boolean;
}

/** Options for {@link invokeCritiqueTelemetryHook}. */
export interface InvokeCritiqueTelemetryHookOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnFn?: typeof spawn;
  /**
   * Called once (at most) as soon as `payload` has been fully handed off to
   * the child's stdin -- on the stdin stream's `'close'` (fires once the
   * underlying pipe is closed, whether that followed a clean `'finish'` or
   * an error) or on a spawn/child `'error'` that means no delivery will
   * ever happen. Lets a fire-and-forget caller (the CLI's `--invoke`, via
   * `runInvoke` below) wait for the payload to actually reach the child's
   * pipe without waiting for the hook *process* to settle (#2685 review,
   * CodeRabbit: `process.exit(0)` racing an in-flight stdin write could
   * otherwise truncate the JSON the hook receives).
   */
  onPayloadDelivered?: () => void;
}

/**
 * Fire-and-forget invocation: spawn `command` (a shell command, matching
 * `critiqueLoop.telemetryHook.command`'s schema description) with `payload`
 * written to its stdin as JSON, then close stdin. **Never throws and the
 * returned promise never rejects** -- this function's entire contract is
 * that a missing command, non-zero exit, timeout, or any other failure is
 * silently absorbed into `{ ok: false }` rather than propagated, unlike
 * `critiqueLoop.delegate`'s fail-closed hold semantics.
 *
 * `detached: true` (#2685 review, Codex): the child runs in its own
 * session, so it survives a signal delivered to this process's group (e.g.
 * the invoking shell's own job-control teardown) instead of dying
 * alongside it. This function's own promise still always resolves once
 * the child truly settles (exit, error, or timeout) for any caller that
 * awaits it (every test below does); the CLI's `--invoke` mode (below)
 * still never awaits *this* promise, and exits via `process.exit()` --
 * which terminates unconditionally regardless of any pending handle --
 * instead of waiting for the child to exit or hit `timeoutMs`, which would
 * otherwise delay every C-phase round invoking this hook by up to that
 * bound. It does, separately, wait a short bounded time for
 * {@link InvokeCritiqueTelemetryHookOptions.onPayloadDelivered} (#2685
 * review, CodeRabbit) -- "the payload reached the child's stdin" is a much
 * smaller ask than "the hook finished", and guards against `process.exit()`
 * truncating an in-flight write.
 *
 * Failure modes this deliberately guards against (a naive
 * `spawn().stdin.write()` call crashes the parent process on each of these):
 * - A spawn failure (bad shell, ENOENT, EACCES) emits `'error'` on the
 *   child -- an unhandled listener would surface as an uncaught exception.
 * - A child that exits before reading stdin EPIPEs the write asynchronously
 *   -- the write's own try/catch only covers the *synchronous* failure
 *   path, so `stdin`'s own `'error'` listener is required too.
 * - A hanging command would block a caller that does choose to await this
 *   promise (e.g. a test, or a future non-CLI embedder) indefinitely
 *   without a bounded `timeoutMs` + `SIGKILL`.
 * - Inheriting stdout/stderr would let a chatty hook pollute the caller's
 *   own output, so both are set to `'ignore'`.
 */
export function invokeCritiqueTelemetryHook(
  command: string | null | undefined,
  payload: CritiqueTelemetryHookPayload,
  options?: InvokeCritiqueTelemetryHookOptions,
): Promise<InvokeCritiqueTelemetryHookResult> {
  if (typeof command !== 'string' || command.trim() === '') {
    return Promise.resolve({ attempted: false, ok: false });
  }

  const spawnFn = options?.spawnFn ?? spawn;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  let delivered = false;
  const notifyDelivered = () => {
    if (delivered) {
      return;
    }
    delivered = true;
    options?.onPayloadDelivered?.();
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ attempted: true, ok });
    };

    let child: ChildProcess;
    try {
      child = spawnFn(command, {
        shell: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        // `detached: true` (not `child.unref()`) only: this puts the child
        // in its own session so it survives a signal sent to this
        // process's group (e.g. the invoking shell's own job-control
        // teardown), without unref'ing it. Deliberately NOT calling
        // `child.unref()` here -- that would remove the *only* thing
        // keeping the event loop alive long enough for the (also unref'd)
        // timeout timer below to ever fire for a caller that legitimately
        // awaits this promise (every test in this file does; a future
        // non-CLI embedder might too) -- with both unref'd, nothing forces
        // the loop to keep running, so the promise could stay pending
        // forever once nothing else in the process needs the loop. The
        // CLI's own `--invoke` mode (below) doesn't need this ref/unref
        // distinction at all: it never awaits this promise, and
        // `process.exit()` terminates unconditionally regardless of any
        // pending handle's ref status.
        detached: true,
      });
    } catch {
      settle(false);
      notifyDelivered();
      return;
    }

    // Belt-and-braces deadline enforcement (#2685 review, Codex, both
    // findings): once `--invoke` stops awaiting this promise (this file's
    // CLI does, deliberately -- see runInvoke below), the JS-level timer a
    // few lines down can never fire, because the *process it would run in*
    // has already exited via `process.exit()`. A hung hook would then be
    // orphaned forever with no deadline at all. A detached shell watchdog
    // enforces the same deadline independently of whether this process is
    // still alive to see it through -- `sleep` + `kill` are effectively
    // universal on POSIX, unlike relying on the `timeout(1)` coreutil,
    // which is not guaranteed present everywhere this hook might run.
    // Also addresses the process-group half of the same finding: `shell:
    // true` makes `child` the `/bin/sh -c` wrapper, and a plain
    // single-PID kill (from either this watchdog or the JS timer below)
    // does not reliably reach a further descendant that wrapper's shell
    // spawns (e.g. a backgrounded job) -- `detached: true` above makes
    // `child.pid` both the process-group id and session id, so killing
    // the *negative* pid reaches the whole tree.
    const watchdog =
      typeof child.pid === 'number' && child.pid > 0
        ? spawnWatchdog(spawnFn, child.pid, timeoutMs)
        : null;

    const timer = setTimeout(() => {
      killProcessGroup(child);
      settle(false);
    }, timeoutMs);
    // Never block process exit on this timer alone -- resolve() already
    // settles the promise; unref lets the caller's own process exit
    // normally if this hook is the only pending handle.
    timer.unref?.();

    // #2685 review, Codex + CodeRabbit (PID-reuse race on early exit): a
    // hook that exits well before `timeoutMs` used to leave the watchdog
    // armed for the rest of its sleep, so a PID (or process-group id, since
    // `detached: true` makes them the same number) reused by an unrelated
    // process within that remaining window could be killed by mistake.
    // Disarming the watchdog here closes that race **only for a caller that
    // awaits this promise** (every test in this file does) -- these
    // `child.on(...)` listeners run in *this* process, so they only fire if
    // this process is still alive to run them. `--invoke` (below)
    // deliberately never awaits this promise and calls `process.exit(0)`
    // almost immediately after spawning, well before `child` can plausibly
    // emit `'exit'` -- so on that path, the primary one in practice, the
    // watchdog stays armed for the full `timeoutMs` exactly as before, by
    // design: closing that half of the race would require a supervisor
    // living entirely outside this Node process (a self-contained shell
    // script that spawns the hook, waits on it, and only then kills its own
    // watchdog subshell), which trades a narrow, bounded residual for
    // meaningfully more moving parts -- see the PR discussion for the
    // rejected fuller design and why it was not taken here. The residual
    // this leaves is narrower than "PID reuse" alone suggests: POSIX does
    // not let a pid (or session/group id) be reallocated while *any* task
    // -- running or zombie, unreaped -- still holds it, so the reused id
    // must first be freed by the entire group exiting *and* being reaped,
    // then cycle back around after a full `pid_max` wrap, all inside the
    // remaining `timeoutMs` window, with the new holder also calling
    // `setsid`/`setpgid` to become a group leader.
    child.on('error', () => {
      clearTimeout(timer);
      cancelWatchdog(watchdog);
      notifyDelivered();
      settle(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      cancelWatchdog(watchdog);
      settle(code === 0);
    });
    child.stdin?.on('error', () => {
      // Asynchronous EPIPE (child exited before reading stdin) or similar --
      // the 'exit'/'error' handlers above still settle this promise.
      notifyDelivered();
    });
    // 'close' fires once the stdin pipe's write end is actually closed --
    // after a clean `end()` flush completes, or after an error tears it
    // down -- independent of whether the child ever reads or exits. This is
    // the signal `notifyDelivered` needs: "the payload handoff is done",
    // not "the hook is done".
    child.stdin?.on('close', notifyDelivered);
    if (!child.stdin) {
      // No stdin to wait on at all (unexpected given `stdio: ['pipe', ...]`
      // above) -- don't leave a caller of onPayloadDelivered waiting for a
      // signal that can never come.
      notifyDelivered();
    }

    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // Synchronous write failure -- 'error'/'exit' handlers above still
      // settle this promise; the stdin 'error' handler above still notifies
      // delivery-completion (as "done", since nothing further can be sent).
      notifyDelivered();
    }
  });
}

/**
 * SIGKILL the whole detached process group `child` leads, falling back to a
 * single-PID kill only when the group-targeted signal itself fails (e.g.
 * `child.pid` is somehow already gone, or a platform without POSIX
 * process-group semantics). Never throws.
 *
 * Also used by {@link cancelWatchdog} to disarm the watchdog's own process
 * group (itself `detached: true` -- see {@link spawnWatchdog}) once it is no
 * longer needed; `child` in that call is the watchdog's `sh -c` wrapper, not
 * the hook command.
 */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      // A negative pid targets the process *group* with that id -- with
      // `detached: true` above, `child.pid` is both, since the child is
      // its own session/group leader.
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Fall through -- e.g. ESRCH (group leader already exited) or no
      // POSIX process-group semantics on this platform (Windows).
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited; ignore.
  }
}

/**
 * Disarm a still-sleeping {@link spawnWatchdog} once the hook it was
 * guarding has already settled on its own (#2685 review, Codex): without
 * this, a hook that exits well inside `timeoutMs` still leaves the watchdog
 * asleep for the remainder of the window, so a PID/process-group id reused
 * by an unrelated process before the watchdog's `sleep` elapses could be
 * killed by mistake. `watchdog` is `null` when {@link spawnWatchdog} itself
 * never ran (no usable `child.pid`) or failed to spawn -- a no-op then, not
 * an error. Reuses {@link killProcessGroup} since the watchdog is itself
 * `detached: true` (its own `sh -c 'sleep ...; kill ...'` wrapper is its own
 * session/group leader); killing it before its `sleep` returns prevents the
 * trailing `kill -9 -<pid>` from ever running.
 */
function cancelWatchdog(watchdog: ChildProcess | null): void {
  if (watchdog) {
    killProcessGroup(watchdog);
  }
}

/**
 * Best-effort, self-contained deadline enforcement that survives this
 * process exiting before `timeoutMs` elapses (`--invoke`'s whole point).
 * Spawns a detached, unref'd `sh -c 'sleep <n>; kill -9 -<pid> || true'` --
 * `sleep`/`kill` rather than the `timeout(1)` coreutil, which isn't
 * guaranteed present everywhere. Returns the spawned watchdog so the caller
 * can {@link cancelWatchdog} it once the hook it guards settles on its own,
 * or `null` if the spawn itself failed. Never throws: spawn failure here
 * (no POSIX shell on `PATH`, e.g. a bare Windows environment) silently
 * forfeits this backup and leaves the JS-level timer above as the only
 * enforcement for a caller that stays alive to see it -- an accepted gap on
 * that platform, not a new one this function introduces.
 *
 * **No `--` before `-<pid>`** (deliberately, empirically verified): `sh`
 * on Debian/Ubuntu (and derivatives) is `dash`, whose `kill` builtin
 * rejects `kill -9 -- -<pid>` outright ("Illegal number: -") -- unlike
 * bash/GNU `kill`, dash's builtin does not recognize `--` as end-of-options
 * at all, so the *group*-targeted attempt silently failed on every run
 * under dash. `kill -9 -<pid>` (leading `-` attached directly to the
 * digits, no separate `--` token) is the portable form both dash and bash
 * accept.
 *
 * **No single-PID fallback** (#2685 review, Codex, discussion about the
 * PID-reuse race): a prior revision retried a bare `kill -9 <pid>` when the
 * group-targeted kill failed. On POSIX, `kill -9 -<pid>` only fails with
 * ESRCH once *every* member of that process group has already exited --
 * meaning the fallback could only ever name something else that happens to
 * reuse that exact number, never the original hook. It made a rare race
 * strictly worse (an extra, unconditional attempt to kill an unrelated
 * process) without ever helping the intended case, so it is dropped: once
 * the group-targeted `kill` reports no such group, this watchdog gives up.
 */
function spawnWatchdog(
  spawnFn: typeof spawn,
  pid: number,
  timeoutMs: number,
): ChildProcess | null {
  try {
    const seconds = Math.max(timeoutMs, 0) / 1000;
    const watchdog = spawnFn(
      'sh',
      ['-c', `sleep ${seconds}; kill -9 -${pid} 2>/dev/null || true`],
      { detached: true, stdio: 'ignore' },
    );
    // #2685 review, Codex: a spawn failure that isn't synchronous (e.g. no
    // `sh` on `PATH` at all, notably a bare Windows install) does not throw
    // into the `try` above -- `spawn()` still returns a `ChildProcess` and
    // emits `'error'` on it asynchronously instead. An `EventEmitter` with
    // no `'error'` listener throws that error back out as an uncaught
    // exception when it fires, which would crash whatever process called
    // this hook -- directly violating this file's "never throws" contract.
    // A no-op listener is all this needs: the caller already treats a
    // missing watchdog as an accepted, silent gap (see this function's own
    // doc comment).
    watchdog.on('error', () => {
      // Best-effort only -- see doc comment above and on this function.
    });
    watchdog.unref();
    return watchdog;
  } catch {
    // See doc comment: best-effort only.
    return null;
  }
}

/**
 * Read stdin fully as UTF-8 text, bounded by {@link STDIN_READ_TIMEOUT_MS}
 * so a caller that runs `--invoke` without piping anything (e.g. an
 * interactive TTY) cannot hang indefinitely -- consistent with this file's
 * overall "never blocks" contract for `--invoke`. Never rejects: any read
 * error or timeout resolves to whatever was read so far (possibly empty).
 */
function readStdinBounded(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(settle, STDIN_READ_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', settle);
    process.stdin.on('error', settle);
  });
}

interface ParsedArgs {
  policy: string;
  noUserGlobal: boolean;
  invoke: boolean;
  help: boolean;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.invoke) {
    runInvoke(args);
    return;
  }

  const report = buildCritiqueTelemetryHookReport(
    args.policy ? { localPolicyPath: args.policy } : undefined,
    args.noUserGlobal,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Fire off {@link invokeCritiqueTelemetryHook} and resolve as soon as the
 * payload has reached the child's stdin -- via
 * {@link InvokeCritiqueTelemetryHookOptions.onPayloadDelivered} -- or after
 * {@link PAYLOAD_DELIVERY_TIMEOUT_MS} elapses, whichever comes first.
 * Deliberately does **not** wait for the hook itself to settle (exit,
 * error, or its own much longer `timeoutMs`) -- only for the much smaller
 * "the write happened" signal (#2685 review, CodeRabbit). The
 * `invokeCritiqueTelemetryHook` promise itself is not returned/awaited
 * here; it keeps running in the background exactly as before (its own
 * timeout + watchdog still apply) after this function's own promise
 * resolves.
 */
function invokeAndWaitForDelivery(
  command: string,
  payload: CritiqueTelemetryHookPayload,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const timer = setTimeout(settle, PAYLOAD_DELIVERY_TIMEOUT_MS);
    timer.unref?.();
    invokeCritiqueTelemetryHook(command, payload, {
      onPayloadDelivered: () => {
        clearTimeout(timer);
        settle();
      },
    }).catch(() => undefined);
  });
}

/**
 * `--invoke`: the fire-and-forget entry point. Reads the caller-built JSON
 * payload from stdin, invokes the resolved hook if usable, and always
 * exits `0` with no output -- a caller can shell out to
 * `... | node scripts/idd-critique-telemetry-hook.mjs --invoke` and never
 * have to check this process's result or wait on it.
 *
 * Failure modes this must absorb that the default (non-`--invoke`) mode
 * deliberately does *not* (#2685 review, Codex + CodeRabbit):
 * - **Resolution itself can throw** (e.g. an explicit `--policy` path that
 *   is missing or malformed JSON -- `loadPolicyConfig` throws for an
 *   explicit path by design). In the default mode that throw is the
 *   caller-visible signal; under `--invoke` it must not be, so resolution
 *   runs inside its own try/catch here, never at module-level `runCli`
 *   scope.
 * - **This process must not itself wait for the hook to settle.** Once
 *   `invokeCritiqueTelemetryHook` has synchronously spawned the (detached)
 *   child and issued the stdin write, this function does not wait for that
 *   promise's resolution -- otherwise this CLI process (and thus whatever
 *   shelled out to it) blocks for up to the hook's own `timeoutMs`,
 *   contradicting the documented "never delays" contract. It does wait,
 *   briefly, for {@link invokeAndWaitForDelivery}'s much smaller
 *   "payload reached the child" signal -- see that function's doc comment.
 */
function runInvoke(args: ParsedArgs): void {
  let report: CritiqueTelemetryHookReport;
  try {
    report = buildCritiqueTelemetryHookReport(
      args.policy ? { localPolicyPath: args.policy } : undefined,
      args.noUserGlobal,
    );
  } catch {
    process.exit(0);
    return;
  }

  readStdinBounded()
    .then((raw) => {
      let payload: unknown;
      try {
        payload = raw.trim() === '' ? null : JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (
        report.usable &&
        report.command &&
        payload !== null &&
        typeof payload === 'object'
      ) {
        return invokeAndWaitForDelivery(
          report.command,
          payload as CritiqueTelemetryHookPayload,
        );
      }
      return undefined;
    })
    .catch(() => undefined)
    .finally(() => process.exit(0));
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(
    argv,
    IDD_CRITIQUE_TELEMETRY_HOOK_FLAG_SPEC,
  );
  return {
    policy: (values.policy as string | undefined) ?? '',
    noUserGlobal: values['no-user-global'] as boolean,
    invoke: values.invoke as boolean,
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-critique-telemetry-hook.mjs [--policy <path>] [--no-user-global]
  node scripts/idd-critique-telemetry-hook.mjs --invoke [--policy <path>] [--no-user-global] < payload.json

Resolves the effective C-phase \`critiqueLoop.telemetryHook\` the same way
resolveEffectiveCritiqueLoopTelemetryHook does: repository-local
.github/idd/config.json's critiqueLoop.telemetryHook wins outright (a
configured object, an explicit null disable, or a malformed value all
stop there); only when it is entirely absent does an optional
user-global $XDG_CONFIG_HOME/idd-skill/config.json (or
$HOME/.config/idd-skill/config.json) fragment apply; absent both, no
hook is usable. Under GITHUB_ACTIONS=true the user-global layer is
always skipped, matching the documented remote-agent-surface contract;
pass --no-user-global to skip it explicitly on any other remote surface
the caller recognizes but this helper cannot auto-detect.

Without --invoke, prints the resolution report:
{
  "usable": true,
  "source": "repository-local|user-global|none",
  "command": "..." | null,
  "reason": null | "repository-local-explicit-disable|invalid-repository-local-telemetry-hook|not-configured"
}

With --invoke, reads a JSON payload from stdin and, only if a hook
resolved as usable, invokes its command with that payload written to
the child's stdin. Fire-and-forget: a missing command, non-zero exit,
timeout, or any other failure is silently ignored. This mode always
exits 0 and never writes to stdout/stderr -- unlike critiqueLoop.delegate,
this command's result is never meant to be inspected by its caller.
`);
}
