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
import { spawn } from 'node:child_process';
import { parseCliArgs } from './cli-args.mjs';
import { resolveEffectiveCritiqueLoopTelemetryHookFromEnv } from './idd-config.mjs';

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
};
// Also declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason as the flag spec above.
const NO_TELEMETRY_HOOK_REASONS = {
  disabled: 'repository-local-explicit-disable',
  none: 'not-configured',
};
/** Bound on how long a spawned hook command may run before it is killed. */
const DEFAULT_INVOKE_TIMEOUT_MS = 5_000;
/** Bound on how long `--invoke` waits for a piped stdin payload. */
const STDIN_READ_TIMEOUT_MS = 2_000;
if (import.meta.main) {
  runCli();
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
function isRemoteAgentSurface(env) {
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
  options,
  noUserGlobal = false,
) {
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
/**
 * Build the JSON payload sent on the hook command's stdin. Pure: no I/O.
 *
 * `delegateCommand` is an own-property-**omitted** key -- not `null` --
 * unless `delegateUsed` is `true` and a non-empty `delegateCommand` was
 * given, matching the issue's documented payload shape ("`delegateCommand`
 * present only when `delegateUsed` is `true`").
 */
export function buildCritiqueTelemetryHookPayload(input) {
  const timestamp =
    input.timestamp ?? (input.now ? input.now() : new Date()).toISOString();
  const payload = {
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
 * simply never awaits it, and exits via `process.exit()` -- which
 * terminates unconditionally regardless of any pending handle -- instead
 * of waiting for the child to exit or hit `timeoutMs`, which would
 * otherwise delay every C-phase round invoking this hook by up to that
 * bound.
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
export function invokeCritiqueTelemetryHook(command, payload, options) {
  if (typeof command !== 'string' || command.trim() === '') {
    return Promise.resolve({ attempted: false, ok: false });
  }
  const spawnFn = options?.spawnFn ?? spawn;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ attempted: true, ok });
    };
    let child;
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
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited between the timeout firing and this call; ignore.
      }
      settle(false);
    }, timeoutMs);
    // Never block process exit on this timer alone -- resolve() already
    // settles the promise; unref lets the caller's own process exit
    // normally if this hook is the only pending handle.
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      settle(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      settle(code === 0);
    });
    child.stdin?.on('error', () => {
      // Asynchronous EPIPE (child exited before reading stdin) or similar --
      // the 'exit'/'error' handlers above still settle this promise.
    });
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // Synchronous write failure -- 'error'/'exit' handlers above still
      // settle this promise.
    }
  });
}
/**
 * Read stdin fully as UTF-8 text, bounded by {@link STDIN_READ_TIMEOUT_MS}
 * so a caller that runs `--invoke` without piping anything (e.g. an
 * interactive TTY) cannot hang indefinitely -- consistent with this file's
 * overall "never blocks" contract for `--invoke`. Never rejects: any read
 * error or timeout resolves to whatever was read so far (possibly empty).
 */
function readStdinBounded() {
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
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', settle);
    process.stdin.on('error', settle);
  });
}
function runCli() {
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
 * `--invoke`: the fire-and-forget entry point. Reads the caller-built JSON
 * payload from stdin, invokes the resolved hook if usable, and always
 * exits `0` with no output -- a caller can shell out to
 * `... | node scripts/idd-critique-telemetry-hook.mjs --invoke` and never
 * have to check this process's result or wait on it.
 *
 * Two failure modes this must absorb that the default (non-`--invoke`)
 * mode deliberately does *not* (#2685 review, Codex):
 * - **Resolution itself can throw** (e.g. an explicit `--policy` path that
 *   is missing or malformed JSON -- `loadPolicyConfig` throws for an
 *   explicit path by design). In the default mode that throw is the
 *   caller-visible signal; under `--invoke` it must not be, so resolution
 *   runs inside its own try/catch here, never at module-level `runCli`
 *   scope.
 * - **This process must not itself wait for the hook to settle.** Once
 *   `invokeCritiqueTelemetryHook` has synchronously spawned the (detached,
 *   `unref`'d) child and issued the stdin write, this function exits
 *   without awaiting that promise's resolution -- otherwise this CLI
 *   process (and thus whatever shelled out to it) blocks for up to the
 *   hook's own `timeoutMs`, contradicting the documented "never delays"
 *   contract.
 */
function runInvoke(args) {
  let report;
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
      let payload;
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
        // Deliberately not returned/awaited -- see this function's doc
        // comment. The `.catch` below is defensive only:
        // invokeCritiqueTelemetryHook's own contract already never
        // rejects.
        invokeCritiqueTelemetryHook(report.command, payload).catch(
          () => undefined,
        );
      }
    })
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    IDD_CRITIQUE_TELEMETRY_HOOK_FLAG_SPEC,
  );
  return {
    policy: values.policy ?? '',
    noUserGlobal: values['no-user-global'],
    invoke: values.invoke,
    help,
  };
}
function printHelp() {
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
