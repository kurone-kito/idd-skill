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

/**
 * Bound on how long `--invoke` separately waits for
 * {@link InvokeCritiqueTelemetryHookOptions.onWatchdogArmed}'s spawn
 * confirmation before exiting anyway (kurone-kito/idd-skill#2892, #2897
 * CI follow-up). Deliberately **not** the same bound as
 * {@link PAYLOAD_DELIVERY_TIMEOUT_MS}: that one times a stdin write
 * (normally near-instant, no new OS process involved), while this one
 * times an actual *process spawn* completing -- on Windows in particular,
 * a fresh `powershell.exe` launch can be measurably slower than a
 * pipe write under real-time antivirus/Defender scanning of each new
 * process image, a well-documented source of Windows CI latency
 * unrelated to this file's own logic. An earlier fix reused
 * `PAYLOAD_DELIVERY_TIMEOUT_MS`'s 1s bound for both waits and made no
 * observable difference on a real `windows-latest` CI run (the watchdog
 * still never got a chance to run) -- consistent with that shared 1s
 * ceiling elapsing before the watchdog's own spawn ever confirmed either
 * way, silently reducing to the pre-fix behavior every time. A separate,
 * more generous bound closes that gap without slowing the common case,
 * where a spawn confirms in low single-digit milliseconds.
 */
const WATCHDOG_ARMED_TIMEOUT_MS = 3_000;

/**
 * Environment-variable name used to hand the real target `command`
 * string to the win32 relay script (see {@link WIN32_RELAY_SCRIPT})
 * rather than passing it as an argv element. The relay is spawned with
 * `shell: false`, so argv escaping is not actually a concern for Node's
 * own spawn call -- the env-var route is chosen instead because it
 * keeps the relay's own argv fixed (`['-e', WIN32_RELAY_SCRIPT]`)
 * regardless of the configured command's own content, and avoids
 * reasoning twice about how an arbitrary shell command string interacts
 * with Node's Windows argv-quoting rules (the first time being
 * `command`'s own later `shell: true` hop inside the relay itself).
 */
const WIN32_RELAY_COMMAND_ENV =
  'IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND';

/**
 * Environment-variable name used to forward the *caller's own*
 * `NODE_OPTIONS` value to the win32 relay's inner (real target) spawn,
 * without letting the relay's own `-e` invocation inherit it directly
 * (kurone-kito/idd-skill#2910 review, Copilot). See
 * {@link WIN32_RELAY_SCRIPT}'s own doc comment for the full rationale.
 */
const WIN32_RELAY_NODE_OPTIONS_ENV =
  'IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_NODE_OPTIONS';

/**
 * win32-only relay script (kurone-kito/idd-skill#2910), run via
 * `spawnFn(process.execPath, ['--input-type=commonjs', '-e',
 * WIN32_RELAY_SCRIPT], {...})` in {@link invokeCritiqueTelemetryHook}
 * below -- mirrors this file's
 * existing precedent of inlining the watchdog's PowerShell script as a
 * string constant (see {@link spawnWatchdogWindows}). Two `${...}`
 * substitutions (the two env-var-name constants above) are all this
 * template literal needs; the rest of the script body contains no
 * literal `${` sequence of its own, so there is no collision risk with
 * the outer `.mts` template-literal interpolation to guard against here,
 * unlike the watchdog's longer, multiply-interpolated PowerShell
 * one-liner.
 *
 * **The relay's own environment is sanitized of `NODE_OPTIONS`**
 * (kurone-kito/idd-skill#2910 review, Copilot): the relay is itself a
 * `node` process, so if it inherited the caller's raw `NODE_OPTIONS`
 * directly, an inherited `--require`/`--import` would execute arbitrary
 * preload code *inside the relay* before it ever forwards the payload --
 * confirmed as a real mechanism, not merely hypothetical, by this
 * repository's own win32 test stubs, which rely on exactly that
 * `--require <preload>` pattern to inject their behavior (see
 * `tests/test-utils.mts`'s `stubExecutable`). `invokeCritiqueTelemetryHook`
 * below therefore does not pass the caller's own `NODE_OPTIONS` through
 * to the relay's environment at all -- the relay's own process runs
 * without any inherited `NODE_OPTIONS`, with `--input-type=commonjs`
 * (kept as defense-in-depth even though the vector it originally guarded
 * against, an inherited `--input-type=module`, is now also closed by
 * this sanitization). The caller's *original* `NODE_OPTIONS` value still
 * needs to reach the real target command two hops down -- POSIX and the
 * pre-#2910 win32 path both let it through unchanged, and this fix must
 * not narrow that existing contract -- so it travels through the
 * separate {@link WIN32_RELAY_NODE_OPTIONS_ENV} channel instead, applied
 * only to the inner spawn's own environment, never executed by the relay
 * itself.
 *
 * Root cause (verified live on native Windows 11): on win32, `shell:
 * true` wraps the primary spawn in `cmd.exe` (on POSIX the equivalent
 * wrapper is `/bin/sh`, unaffected by any of this -- this whole defect
 * and fix are win32-only). Before this fix, the primary spawn used that
 * `cmd.exe` wrapper unconditionally on win32 too, and `cmd.exe` never
 * relays a piped stdin payload to the further child it execs when
 * `cmd.exe` itself runs under Win32's `DETACHED_PROCESS` creation flag
 * (what `detached: true` maps to) -- confirmed at every payload size from 0B
 * to 500KB+, and for a non-Node consumer piped the same way, isolating
 * the fault to `cmd.exe`'s own stdin-relay plumbing under
 * `DETACHED_PROCESS` rather than anything Node/libuv- or payload-size-
 * specific. This is the same "`DETACHED_PROCESS` breaks a
 * console-subsystem process's own I/O/message-pump initialization"
 * pattern already root-caused for {@link spawnWatchdogWindows}'s own
 * `powershell.exe` hop (kurone-kito/idd-skill#2892 / PR #2897),
 * recurring for `cmd.exe`'s stdin relay instead of `powershell.exe`'s
 * ConsoleHost startup.
 *
 * Fix shape: this script is itself spawned *directly* (`shell: false`)
 * as a `node.exe` child under `detached: true` -- confirmed live to
 * deliver a piped stdin payload correctly, at every size from 0B to
 * 500KB+, once the caller waits for the stream to fully close before
 * exiting (this file's `onPayloadDelivered` contract already does
 * exactly that). It then reads its own stdin to completion, and only
 * *then* re-spawns the real `command` through `shell: true` -- but,
 * deliberately, NOT `detached` this time: this relay process itself is
 * what now needs to survive the CLI's `process.exit()`, not the
 * `cmd.exe` hop underneath it, so `cmd.exe` here is a normal
 * (non-`DETACHED_PROCESS`) child and does not hit the stdin-relay
 * defect above. The relay forwards the buffered payload to that
 * child's stdin (with the relay-command env var above scrubbed from
 * that inner spawn's own environment, so the configured `command`
 * never sees an env var it didn't configure) and exits with the same
 * code, preserving `invokeCritiqueTelemetryHook`'s existing
 * `ok: code === 0` contract for its caller unchanged.
 *
 * `child.pid` (what this file's timeout/kill/watchdog logic already
 * operates on generically -- see {@link killProcessGroup}) becomes
 * this relay's pid on win32. Verified live: a
 * `taskkill /PID <relay-pid> /T /F` (the existing
 * {@link killProcessTreeWindows} call, unchanged) still reaches and
 * kills the whole chain -- relay -> `cmd.exe` -> real target -- for
 * both an already-settled chain and a genuinely hung target, so no
 * change is needed to {@link killProcessGroup},
 * {@link killProcessTreeWindows}, or either `spawnWatchdog*` function.
 *
 * Never throws from the relay's own perspective: a synchronous spawn
 * failure or an async `'error'`/non-zero exit all resolve to
 * `finish(1)` (a non-ok result for the caller), matching this file's
 * "never throws" contract for the primary hook spawn. Like every other
 * failure mode this file already absorbs silently (a bad command, a
 * non-zero exit, a timeout), a defect in this script's own body would
 * also fail silently in production (its `stdio` discards stderr) --
 * an accepted extension of the existing contract, not a new risk;
 * the same gap already exists for the inline PowerShell watchdog
 * script below, with no unit-level syntax check for either. The tests
 * this issue adds are the mitigation, run for real (not just
 * argument-shape asserted) both locally, via the `platform: 'win32'`
 * override tests below, and on native `windows-latest` CI.
 */
const WIN32_RELAY_SCRIPT = `
const { spawn } = require('node:child_process');
const command = process.env.${WIN32_RELAY_COMMAND_ENV};
const chunks = [];
let settled = false;
const finish = (code) => {
  if (settled) return;
  settled = true;
  process.exit(code);
};
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => finish(1));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  const env = { ...process.env };
  delete env['${WIN32_RELAY_COMMAND_ENV}'];
  // The relay's OWN process never received the caller's raw NODE_OPTIONS
  // (see WIN32_RELAY_SCRIPT's own doc comment) -- only this forwarded
  // copy of it, specifically for the inner spawn below. Strip only
  // whitespace-separated --input-type=... tokens (kurone-kito/idd-skill
  // #2910 follow-up on the Codex review): Node rejects --input-type
  // outright (ERR_INPUT_TYPE_NOT_ALLOWED) for any invocation that is not
  // itself --eval/--print/stdin, which a configured command that happens
  // to run \`node <file>\` (as this file's own win32 CI test fixtures do)
  // would be -- while every other flag, notably this repository's own
  // win32 test stubs' inherited --require <preload>, passes through
  // unchanged (verified live: a --require alongside --input-type
  // survives this strip and still runs; deleting NODE_OPTIONS wholesale
  // here instead was tried first and rejected -- it broke every one of
  // those stubs, confirmed live).
  const forwardedNodeOptions = env['${WIN32_RELAY_NODE_OPTIONS_ENV}'] || '';
  delete env['${WIN32_RELAY_NODE_OPTIONS_ENV}'];
  const strippedNodeOptions = forwardedNodeOptions
    .split(/\\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith('--input-type='))
    .join(' ');
  if (strippedNodeOptions) {
    env.NODE_OPTIONS = strippedNodeOptions;
  } else {
    delete env.NODE_OPTIONS;
  }
  let child;
  try {
    child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env,
    });
  } catch {
    finish(1);
    return;
  }
  child.on('error', () => finish(1));
  child.on('exit', (code) => finish(code === null ? 1 : code));
  child.stdin.on('error', () => {});
  try {
    child.stdin.write(payload);
    child.stdin.end();
  } catch {
    // 'error'/'exit' handlers above still settle.
  }
});
`;

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
   * Called once (at most) as soon as `payload` has been fully **written
   * to** the child's stdin -- on the stdin stream's `'close'` (fires once
   * the underlying pipe is closed, whether that followed a clean
   * `'finish'` or an error) or on a spawn/child `'error'` that means no
   * delivery will ever happen. This signals the write side flushed into
   * the OS pipe, not that the child has necessarily read the bytes yet.
   * Lets a fire-and-forget caller (the CLI's `--invoke`, via `runInvoke`
   * below) wait for the payload to actually reach the child's pipe
   * without waiting for the hook *process* to settle (#2685 review,
   * CodeRabbit: `process.exit(0)` racing an in-flight stdin write could
   * otherwise truncate the JSON the hook receives). On win32
   * (kurone-kito/idd-skill#2910), `child` is the relay process (see
   * `WIN32_RELAY_SCRIPT`), so this signal specifically means the payload
   * reached the *relay*, not yet the real target command one hop further
   * down -- consistent with this option's existing "reached the child's
   * pipe", not "the hook finished", contract.
   */
  onPayloadDelivered?: () => void;
  /**
   * Called once (at most) as soon as the backup watchdog's own OS process
   * has either been confirmed spawned (its `'spawn'` event) or has failed
   * to spawn (`'error'`, or synchronously via {@link spawnWatchdog}
   * returning `null`) -- kurone-kito/idd-skill#2892, a `windows-latest` CI
   * finding on PR #2897. `spawnFn(...)` returning a `ChildProcess`
   * synchronously does not mean the underlying OS process creation has
   * actually finished: on Windows in particular, that work can still be
   * in flight on libuv's threadpool. `--invoke` (below) calls
   * `process.exit()` within roughly a millisecond of spawning today,
   * with no signal previously gating that exit on the watchdog's OS
   * process actually existing yet -- a real `windows-latest` CI run
   * showed the exact symptom this predicts: the watchdog's target
   * process was still running, completely untouched (not even its
   * `cmd.exe` wrapper), long after both the watchdog's own sleep window
   * and the test's patience had elapsed, while the separately exercised,
   * directly-awaited (non-`--invoke`) watchdog path passed cleanly in
   * the same run -- consistent with the watchdog process itself never
   * having been created on the `--invoke` path, rather than a failure in
   * whatever it would have run once alive. Rewriting the watchdog's own
   * kill-step script (Start-Process vs. a direct .NET Process call) had
   * no effect on the failure, further narrowing the cause to before that
   * script ever gets a chance to run.
   * Waiting for this callback (bounded by its own short timeout,
   * {@link WATCHDOG_ARMED_TIMEOUT_MS} -- deliberately not the same bound
   * {@link InvokeCritiqueTelemetryHookOptions.onPayloadDelivered} uses; see
   * that constant's own doc comment for why) closes that race for
   * `--invoke`'s fire-and-forget path without meaningfully slowing it down
   * in the ordinary case, where a spawn confirms in low single-digit
   * milliseconds.
   */
  onWatchdogArmed?: () => void;
  /**
   * Injectable for tests, mirroring {@link spawnFn}: overrides
   * `process.platform` for this invocation's win32-vs-POSIX branching.
   * Originally scoped to kill/watchdog selection only
   * (kurone-kito/idd-skill#2892) so the exact `taskkill`/`powershell.exe`
   * argument construction can be asserted deterministically from a
   * non-Windows CI runner, the same way a fake `spawnFn` is already used
   * to assert the POSIX watchdog's arguments; kurone-kito/idd-skill#2910
   * extended it to also select the *primary* spawn shape (the win32
   * relay vs. the direct POSIX `shell: true` spawn), so an override now
   * exercises `WIN32_RELAY_SCRIPT` for real (via `node -e`, not mocked)
   * from any host, not only the kill/watchdog argument shapes. Defaults
   * to the real `process.platform`.
   */
  platform?: NodeJS.Platform;
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
  // #2685 review, Copilot: `?? DEFAULT_INVOKE_TIMEOUT_MS` alone only
  // substitutes for `null`/`undefined` -- a caller-supplied `NaN` (or any
  // other non-finite or negative value) would pass straight through and
  // reach `setTimeout` below, which treats a non-finite delay as firing on
  // (near-)the next tick, killing the hook almost instantly instead of
  // waiting the intended bound. Falling back to the documented default for
  // *any* unusable value keeps this "never throws" function's behavior
  // predictable for a caller's own coding mistake, rather than silently
  // clamping to some other value.
  const requestedTimeoutMs = options?.timeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === 'number' &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs >= 0
      ? requestedTimeoutMs
      : DEFAULT_INVOKE_TIMEOUT_MS;
  const platform = options?.platform ?? process.platform;
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
      // `detached: true` (not `child.unref()`) only, on both branches
      // below: this puts the child in its own session so it survives a
      // signal sent to this process's group (e.g. the invoking shell's
      // own job-control teardown), without unref'ing it. Deliberately
      // NOT calling `child.unref()` here -- that would remove the *only*
      // thing keeping the event loop alive long enough for the (also
      // unref'd) timeout timer below to ever fire for a caller that
      // legitimately awaits this promise (every test in this file does;
      // a future non-CLI embedder might too) -- with both unref'd,
      // nothing forces the loop to keep running, so the promise could
      // stay pending forever once nothing else in the process needs the
      // loop. The CLI's own `--invoke` mode (below) doesn't need this
      // ref/unref distinction at all: it never awaits this promise, and
      // `process.exit()` terminates unconditionally regardless of any
      // pending handle's ref status.
      //
      // windowsHide (kurone-kito/idd-skill#2892; no-op on POSIX): maps to
      // Win32's CREATE_NO_WINDOW creation flag *and* STARTUPINFO's
      // wShowWindow=SW_HIDE. Verified against libuv's own win/process.c
      // and Microsoft's Process Creation Flags documentation: the
      // CREATE_NO_WINDOW half is a documented no-op specifically when
      // combined with DETACHED_PROCESS (what `detached: true` sets) --
      // MSDN states it "is ignored if ... used with either
      // CREATE_NEW_CONSOLE or DETACHED_PROCESS". On the win32 branch
      // below, that leaves `windowsHide` on the outer (detached) relay
      // spawn a documented no-op for the same reason `spawnWatchdogWindows`'s
      // own detached spawn is -- the relay is a plain `node.exe` process
      // with no console to begin with under DETACHED_PROCESS, so there is
      // nothing to hide there regardless. The relay's *own* inner spawn of
      // the real `command` (see `WIN32_RELAY_SCRIPT` below) is NOT
      // detached, so CREATE_NO_WINDOW is not overridden there and reliably
      // suppresses that `cmd.exe` hop's own console window directly --
      // verified live on native Windows 11 (kurone-kito/idd-skill#2892
      // review follow-up, re-confirmed for kurone-kito/idd-skill#2910's
      // relay shape): `MainWindowHandle == 0` (Get-Process) for both a
      // quick-exiting and a hung-then-killed target, for the whole
      // process tree this creates. The bound, reliable mitigation for a
      // window that somehow still appears despite this is
      // `killProcessGroup`'s win32 tree-kill below, which caps the whole
      // chain's lifetime at `timeoutMs` rather than preventing it
      // outright.
      if (platform === 'win32') {
        // Sanitize NODE_OPTIONS out of the relay's OWN environment
        // (kurone-kito/idd-skill#2910 review, Copilot): the relay is
        // itself a `node` process, so passing the caller's raw
        // NODE_OPTIONS through to it would let an inherited
        // `--require`/`--import` execute arbitrary preload code *inside
        // the relay* before it ever forwards the payload -- see
        // WIN32_RELAY_SCRIPT's own doc comment for the full rationale
        // and why the original value still reaches the real target
        // command via a separate channel instead of being dropped.
        const { NODE_OPTIONS: callerNodeOptions, ...relayEnv } = process.env;
        child = spawnFn(
          process.execPath,
          // `--input-type=commonjs` (kurone-kito/idd-skill#2910 review,
          // Codex): defense-in-depth alongside the NODE_OPTIONS
          // sanitization above -- not redundant with `-e`'s own
          // CommonJS default, since a caller's inherited
          // `NODE_OPTIONS=--input-type=module` would otherwise make
          // Node evaluate `WIN32_RELAY_SCRIPT` as ESM, where `require`
          // is undefined and the relay throws before ever reading its
          // stdin. Verified live: this flag overrides an inherited
          // `--input-type=module` and is a no-op otherwise.
          ['--input-type=commonjs', '-e', WIN32_RELAY_SCRIPT],
          {
            stdio: ['pipe', 'ignore', 'ignore'],
            detached: true,
            windowsHide: true,
            env: {
              ...relayEnv,
              [WIN32_RELAY_COMMAND_ENV]: command,
              ...(callerNodeOptions
                ? { [WIN32_RELAY_NODE_OPTIONS_ENV]: callerNodeOptions }
                : {}),
            },
          },
        );
      } else {
        child = spawnFn(command, {
          shell: true,
          stdio: ['pipe', 'ignore', 'ignore'],
          detached: true,
          windowsHide: true,
        });
      }
    } catch {
      settle(false);
      notifyDelivered();
      // #2892 review, CodeRabbit: a synchronous spawnFn() throw returns
      // here before the watchdog is ever wired up below, so nothing else
      // would ever call onWatchdogArmed -- without this, a caller waiting
      // on it (invokeAndWaitForDelivery, --invoke's own path) would sit
      // idle for the full WATCHDOG_ARMED_TIMEOUT_MS before its own
      // fallback timer rescues it, even though there is plainly no
      // watchdog to wait for when the primary spawn itself never
      // happened.
      options?.onWatchdogArmed?.();
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
        ? spawnWatchdog(spawnFn, child.pid, timeoutMs, platform)
        : null;
    // See InvokeCritiqueTelemetryHookOptions.onWatchdogArmed's own doc
    // comment: closes the race where `--invoke` exits before the
    // watchdog's underlying OS process creation has actually finished.
    let watchdogArmedNotified = false;
    const notifyWatchdogArmed = () => {
      if (watchdogArmedNotified) {
        return;
      }
      watchdogArmedNotified = true;
      options?.onWatchdogArmed?.();
    };
    if (watchdog) {
      watchdog.once('spawn', notifyWatchdogArmed);
      // A spawn failure means there is nothing further to wait for either
      // -- the watchdog's own 'error' listener (spawnWatchdogPosix /
      // spawnWatchdogWindows) already absorbs this for its "never throws"
      // contract; this is a second, independent listener for the same
      // event, purely to unblock a caller waiting on this callback.
      watchdog.once('error', notifyWatchdogArmed);
    } else {
      notifyWatchdogArmed();
    }

    const timer = setTimeout(() => {
      killProcessGroup(child, spawnFn, platform);
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
      cancelWatchdog(watchdog, spawnFn, platform);
      notifyDelivered();
      settle(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      cancelWatchdog(watchdog, spawnFn, platform);
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
 * On POSIX, SIGKILL the whole detached process group `child` leads, falling
 * back to a single-PID kill only when the group-targeted signal itself
 * fails (e.g. `child.pid` is somehow already gone, or a platform without
 * POSIX process-group semantics). On win32, a negative pid is meaningless
 * to `process.kill` -- there is no POSIX-style process-group signal to
 * send -- so this instead delegates to {@link killProcessTreeWindows}, a
 * real process-*tree* kill via `taskkill /T` (kurone-kito/idd-skill#2892).
 * On win32, `child` is the primary spawn's own top-level process:
 * `cmd.exe` (the `shell: true` wrapper) directly, on POSIX and, before
 * kurone-kito/idd-skill#2910, on win32 too; since that fix, the win32
 * `child` is instead the relay process (see `WIN32_RELAY_SCRIPT`), which
 * itself wraps `cmd.exe` as its own child one level further down. Either
 * way, the actual invoked command sits one or more levels beneath `child`,
 * never reachable by terminating `child` alone -- which is exactly what
 * this file's previous Windows fallback (`child.kill('SIGKILL')` below)
 * only ever did, leaving that further descendant (and its own
 * auto-allocated console window) orphaned. `taskkill /T`'s tree-kill
 * reaches the whole subtree regardless of its depth beneath `child`, so
 * this function needs no depth-specific knowledge of which shape `child`
 * is. Never throws.
 *
 * Also used by {@link cancelWatchdog} to disarm the watchdog's own process
 * (itself `detached: true` -- see {@link spawnWatchdogPosix} /
 * {@link spawnWatchdogWindows}) once it is no longer needed; `child` in
 * that call is the watchdog's own wrapper process, not the hook command.
 */
function killProcessGroup(
  child: ChildProcess,
  spawnFn: typeof spawn,
  platform: NodeJS.Platform,
): void {
  const pid = child.pid;
  const hasPid = typeof pid === 'number' && pid > 0;
  if (platform === 'win32') {
    const spawned = hasPid && killProcessTreeWindows(child, spawnFn);
    if (!spawned) {
      // `spawned` is false only because there was no pid to target at all
      // (`hasPid` false -- `child.kill('SIGKILL')` below is then a
      // guaranteed no-op, not a real fallback) or because the `taskkill`
      // spawn call itself threw synchronously (e.g. unresolvable on PATH
      // -- vanishingly rare on a real Windows install). Attempting the
      // single-process kill regardless is still strictly better than
      // giving up outright: this is this file's pre-fix Windows
      // behavior, kept only as a last resort -- it does not reach a
      // further-descendant grandchild (the bug kurone-kito/idd-skill#2892
      // fixes), but is better than no attempt when a pid is available. An
      // *asynchronous* `taskkill` spawn failure (the far more common
      // real-world case -- e.g. ENOENT reported via the child's own
      // `'error'` event rather than a synchronous throw) cannot be
      // handled here: {@link killProcessTreeWindows} has already
      // returned `true` and this branch has already been skipped by the
      // time that event fires. `killProcessTreeWindows` itself now
      // carries the equivalent fallback for that case (Codex review on
      // PR #2897), since only it is still in scope when the async event
      // arrives.
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited; ignore.
      }
    }
    return;
  }
  if (hasPid) {
    try {
      // A negative pid targets the process *group* with that id -- with
      // `detached: true` above, `child.pid` is both, since the child is
      // its own session/group leader.
      process.kill(-(pid as number), 'SIGKILL');
      return;
    } catch {
      // Fall through -- e.g. ESRCH (group leader already exited).
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited; ignore.
  }
}

/**
 * Best-effort win32 process-*tree* kill (kurone-kito/idd-skill#2892):
 * spawns `taskkill /PID <pid> /T /F`, which walks and terminates the whole
 * descendant tree rooted at `pid` -- see {@link killProcessGroup}'s own doc
 * comment for why a tree-kill, not a single-PID kill, is required here.
 * Fire-and-forget, matching this file's other spawned helpers: the caller
 * does not wait for `taskkill` itself to finish, only for this synchronous
 * spawn *attempt* to be issued -- `settle(false)` in the caller still fires
 * immediately after, exactly as it already does on the POSIX path.
 * `windowsHide: true` reliably suppresses `taskkill`'s own window here
 * (unlike the primary hook spawn and the watchdog below): this spawn is
 * not `detached: true`, so `CREATE_NO_WINDOW` is not ignored per Windows'
 * own documented creation-flag precedence (see the primary spawn's own
 * comment). An `'error'` listener guards against the same asynchronous-
 * spawn-failure crash {@link spawnWatchdogPosix} already guards against
 * (e.g. `taskkill.exe` somehow unresolvable) -- this file's "never throws"
 * contract cannot depend on the environment always having `taskkill` on
 * `PATH`. Returns `false` only when the synchronous `spawnFn(...)` call
 * itself threw, so the caller ({@link killProcessGroup}) can fall back to
 * a plain single-process kill instead of silently killing nothing.
 *
 * That synchronous-throw fallback in the caller cannot cover an
 * *asynchronous* spawn failure, though (Codex review on PR #2897): a
 * failure Node only discovers after the synchronous `spawnFn(...)` call
 * already returned a `ChildProcess` handle (the actual common case for
 * `ENOENT`-class failures, as opposed to the rare synchronous-throw case
 * the caller's own fallback already covers) surfaces here as this
 * function's own `'error'` event, fired well after this function --
 * and with it, the caller's own `if (!spawned)` branch -- has already
 * returned. Attempt the same last-resort single-process kill directly
 * inside that listener instead, so an async `taskkill` failure does not
 * silently regress to "kill nothing at all" (worse than this file's
 * pre-fix single-process-only behavior, not merely equal to it).
 */
function killProcessTreeWindows(
  child: ChildProcess,
  spawnFn: typeof spawn,
): boolean {
  const pid = child.pid as number;
  try {
    const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      // Best-effort fallback for an asynchronous taskkill spawn failure
      // -- see doc comment above. Mirrors killProcessGroup's own
      // synchronous-throw fallback; does not reach a further-descendant
      // grandchild, same known limitation as that fallback.
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited; ignore.
      }
    });
    killer.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Disarm a still-sleeping {@link spawnWatchdog} once the hook it was
 * guarding has already settled on its own (#2685 review, Codex): without
 * this, a hook that exits well inside `timeoutMs` still leaves the watchdog
 * asleep for the remainder of the window, so a PID/process-group id reused
 * by an unrelated process before the watchdog's sleep elapses could be
 * killed by mistake. `watchdog` is `null` when {@link spawnWatchdog} itself
 * never ran (no usable `child.pid`) or failed to spawn -- a no-op then, not
 * an error. Reuses {@link killProcessGroup} since the watchdog is itself
 * `detached: true` (its own wrapper process is its own session/group
 * leader on POSIX, or the sole watchdog process on win32); killing it
 * before its sleep returns prevents the trailing kill step from ever
 * running. See {@link spawnWatchdogWindows}'s own doc comment for a
 * win32-specific residual this disarming does not fully close (PID reuse
 * is faster there than the POSIX pid_max-wrap argument assumes).
 */
function cancelWatchdog(
  watchdog: ChildProcess | null,
  spawnFn: typeof spawn,
  platform: NodeJS.Platform,
): void {
  if (watchdog) {
    killProcessGroup(watchdog, spawnFn, platform);
  }
}

/**
 * Picks the platform-appropriate backup watchdog (kurone-kito/idd-skill
 * #2892): {@link spawnWatchdogPosix} or {@link spawnWatchdogWindows}. Both
 * share the same contract -- best-effort, self-contained deadline
 * enforcement that survives this process exiting before `timeoutMs`
 * elapses (`--invoke`'s whole point), returning `null` if the spawn itself
 * failed, never throwing.
 */
function spawnWatchdog(
  spawnFn: typeof spawn,
  pid: number,
  timeoutMs: number,
  platform: NodeJS.Platform,
): ChildProcess | null {
  return platform === 'win32'
    ? spawnWatchdogWindows(spawnFn, pid, timeoutMs)
    : spawnWatchdogPosix(spawnFn, pid, timeoutMs);
}

/**
 * POSIX half of the backup watchdog pair (see {@link spawnWatchdog}).
 * Spawns a detached, unref'd `sh -c 'sleep <n>; kill -9 -<pid> || true'` --
 * `sleep`/`kill` rather than the `timeout(1)` coreutil, which isn't
 * guaranteed present everywhere. Returns the spawned watchdog so the caller
 * can {@link cancelWatchdog} it once the hook it guards settles on its own,
 * or `null` if the spawn itself failed. Never throws: spawn failure here
 * (no POSIX shell on `PATH`, e.g. a bare Windows environment -- handled
 * instead by {@link spawnWatchdogWindows}) silently forfeits this backup
 * and leaves the JS-level timer above as the only enforcement for a caller
 * that stays alive to see it -- an accepted gap on that platform, not a new
 * one this function introduces.
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
function spawnWatchdogPosix(
  spawnFn: typeof spawn,
  pid: number,
  timeoutMs: number,
): ChildProcess | null {
  try {
    // #2685 review, Copilot: `Math.ceil`, not a plain division -- some
    // POSIX `sleep` implementations only accept integer seconds, and a
    // fractional argument (e.g. a test's `timeoutMs: 500` -> `0.5`) can
    // make those reject or otherwise skip the delay entirely, SIGKILLing
    // the hook (near-)immediately instead of after the intended bound.
    // Rounding up, never down or to nearest, keeps this backup watchdog
    // from ever firing *earlier* than the primary JS-level timer it
    // exists to survive past -- the small extra slack on a portable
    // `sleep` is harmless for a best-effort backup.
    const seconds = Math.ceil(Math.max(timeoutMs, 0) / 1000);
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
 * Win32 half of the backup watchdog pair (see {@link spawnWatchdog}) --
 * kurone-kito/idd-skill#2892. Before this, the POSIX-only backup watchdog
 * silently did nothing useful on Windows (no `sh` on `PATH`), leaving a
 * native-Windows IDD agent's fire-and-forget `--invoke` with no deadline
 * enforcement at all once the CLI process itself has already exited (the
 * primary, JS-level timer in {@link invokeCritiqueTelemetryHook} cannot
 * fire from a dead process either -- see that function's own comment on
 * why this backup exists in the first place).
 *
 * Spawns `powershell.exe` (Windows PowerShell 5.1, present on every
 * Windows install since 7 SP1 / Server 2008 R2 -- not `pwsh`/PowerShell
 * Core, whose presence is not guaranteed) through a `cmd.exe` hop
 * (`shell: true`), **not** directly (kurone-kito/idd-skill#2892, #2897 CI
 * follow-up, confirmed live on native Windows 11): `spawnFn('powershell.exe',
 * [...], { detached: true, stdio: 'ignore' })` -- no shell hop -- exits in
 * roughly 70-140ms with code 0 and never runs its `-Command`/`-File`
 * script at all, a false "success." Verified with the quoting variable
 * removed entirely (a `-File <script.ps1>` invocation, so no `-Command`
 * string-escaping is involved): still a same-result no-op under
 * `detached: true`, while the identical `-File` invocation through a
 * `cmd.exe` hop runs correctly and survives the caller's own
 * `process.exit()`. This isolates the cause to `DETACHED_PROCESS` itself
 * (no console object at all) breaking `powershell.exe`'s ConsoleHost
 * startup, not this file's own command construction -- adding the
 * `cmd.exe` hop back (as this file's primary hook spawn already uses for
 * `command`) is the fix. The extra process layer this reintroduces is
 * bounded: {@link cancelWatchdog}'s win32 tree-kill already uses
 * `taskkill /PID <pid> /T /F` (the `/T` flag), which reaches this
 * watchdog's own `cmd.exe` wrapper *and* the `powershell.exe` it spawns,
 * so disarming an early-settling hook's watchdog is unaffected by the
 * extra hop.
 *
 * `timeout.exe` is deliberately not used for the sleep: with
 * `stdio: 'ignore'` it fails outright ("Input redirection is not
 * supported"). `Start-Sleep -Seconds <n>` (a PowerShell built-in cmdlet,
 * not a further child process) is the sleep primitive instead.
 *
 * The kill step builds a `System.Diagnostics.Process` directly
 * (`UseShellExecute = $false; CreateNoWindow = $true`) rather than
 * `Start-Process -WindowStyle Hidden` (kurone-kito/idd-skill#2897 CI
 * finding, `windows-latest`): an earlier `windows-latest` CI round already
 * showed this watchdog not actually killing its target before the
 * `DETACHED_PROCESS` no-op above was isolated as the real cause; kept here
 * regardless since `UseShellExecute = $false` is the same underlying
 * mechanism Node's own `windowsHide` option (and this file's
 * already-confirmed-working `killProcessTreeWindows`) relies on, so both
 * `taskkill` call sites stay on the same, empirically-working
 * process-creation path instead of two different ones. `.Arguments` (a
 * single space-joined string), not the array-based `.ArgumentList`: the
 * latter requires .NET Core 2.1+, unavailable on `powershell.exe`
 * (Windows PowerShell 5.1's .NET Framework runtime). `$p.WaitForExit()`
 * keeps this whole script's own execution (and thus the watchdog process)
 * alive until `taskkill` actually finishes, matching the POSIX version's
 * `sleep <n>; kill ...` sequencing.
 *
 * **Known residual, not present on the POSIX side**: {@link
 * cancelWatchdog}'s PID-reuse-race argument (see {@link
 * spawnWatchdogPosix}'s own doc comment) relies on POSIX pid/pgid reuse
 * requiring the entire process group to exit, be reaped, *and* a full
 * `pid_max` wrap before the number can be reused. Windows recycles freed
 * PIDs far faster (observably within seconds under process churn, nothing
 * resembling a full namespace wrap), so the residual window where a
 * quick-exit hook's watchdog stays armed against an already-freed pid for
 * the rest of `timeoutMs` is measurably wider here. `cancelWatchdog`
 * disarming this watchdog as soon as the hook settles (unchanged from the
 * POSIX path) is what actually bounds this in practice, not any
 * Windows-side pid-reuse guarantee -- an unexplained Windows-only flake in
 * a quick-exit test is the first place to look.
 *
 * Never throws: spawn failure here (no `cmd.exe`/`powershell.exe`
 * resolvable -- essentially never on a real Windows install) silently
 * forfeits this backup, the same accepted gap {@link spawnWatchdogPosix}
 * documents for a bare environment with no POSIX shell.
 */
function spawnWatchdogWindows(
  spawnFn: typeof spawn,
  pid: number,
  timeoutMs: number,
): ChildProcess | null {
  try {
    // Same rounding rationale as spawnWatchdogPosix's own comment.
    const seconds = Math.ceil(Math.max(timeoutMs, 0) / 1000);
    const script =
      `Start-Sleep -Seconds ${seconds}; ` +
      '$p = New-Object System.Diagnostics.Process; ' +
      "$p.StartInfo.FileName = 'taskkill'; " +
      `$p.StartInfo.Arguments = '/PID ${pid} /T /F'; ` +
      '$p.StartInfo.UseShellExecute = $false; ' +
      '$p.StartInfo.CreateNoWindow = $true; ' +
      '[void]$p.Start(); ' +
      '$p.WaitForExit()';
    // shell:true (cmd.exe hop) is required -- see the doc comment above
    // for why a direct spawnFn('powershell.exe', ..., {detached:true})
    // silently no-ops on this platform. The script itself uses only
    // single quotes internally, so wrapping the whole -Command argument
    // in double quotes here needs no further escaping.
    const command =
      'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden ' +
      `-Command "${script}"`;
    const watchdog = spawnFn(command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Same asynchronous-spawn-failure rationale as spawnWatchdogPosix's own
    // comment -- an unresolvable cmd.exe/powershell.exe must not crash the
    // caller.
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
 * Fire off {@link invokeCritiqueTelemetryHook} and resolve once BOTH the
 * payload has reached the child's stdin (via
 * {@link InvokeCritiqueTelemetryHookOptions.onPayloadDelivered}, bounded
 * by {@link PAYLOAD_DELIVERY_TIMEOUT_MS}) AND the backup watchdog's own OS
 * process creation has been confirmed one way or the other (via
 * {@link InvokeCritiqueTelemetryHookOptions.onWatchdogArmed}, bounded
 * separately by {@link WATCHDOG_ARMED_TIMEOUT_MS} -- see that constant's
 * own doc comment for why it is not the same bound as the payload-delivery
 * one). The watchdog half closes a real `windows-latest` CI finding
 * (kurone-kito/idd-skill#2892, PR #2897): without it, `runInvoke`'s
 * near-immediate `process.exit()` could race ahead of the watchdog's own
 * spawn, discarding it before its underlying OS process ever finished
 * being created -- see {@link InvokeCritiqueTelemetryHookOptions
 * .onWatchdogArmed}'s own doc comment for the full evidence. Deliberately
 * does **not** wait for the hook itself to settle (exit, error, or its
 * own much longer `timeoutMs`) -- only for these two much smaller signals
 * (#2685 review, CodeRabbit; #2897 review-fix). The
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
    let payloadDelivered = false;
    let watchdogArmed = false;
    const maybeSettle = () => {
      if (settled || !payloadDelivered || !watchdogArmed) {
        return;
      }
      settled = true;
      clearTimeout(payloadTimer);
      clearTimeout(watchdogTimer);
      resolve();
    };
    const payloadTimer = setTimeout(() => {
      payloadDelivered = true;
      maybeSettle();
    }, PAYLOAD_DELIVERY_TIMEOUT_MS);
    payloadTimer.unref?.();
    const watchdogTimer = setTimeout(() => {
      watchdogArmed = true;
      maybeSettle();
    }, WATCHDOG_ARMED_TIMEOUT_MS);
    watchdogTimer.unref?.();
    invokeCritiqueTelemetryHook(command, payload, {
      onPayloadDelivered: () => {
        payloadDelivered = true;
        maybeSettle();
      },
      onWatchdogArmed: () => {
        watchdogArmed = true;
        maybeSettle();
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
