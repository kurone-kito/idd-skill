#!/usr/bin/env node
// idd-generated-from: src/bin/run-helper.mts
//
// The bin/run-helper.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { extractShapedCliParseErrorMessage } from '../scripts/cli-args.mts';

// Bounds the best-effort `--help` re-invocation used to fetch a usage line
// below -- this must never hang the primary error-reporting path.
const HELP_REINVOKE_TIMEOUT_MS = 5_000;

// How long, after the child's *first* stderr chunk arrives, run-helper keeps
// buffering (instead of forwarding live) to give a shaped parse error --
// always an instant, synchronous crash right after startup -- a chance to
// finish before it decides. Anchored to the first chunk rather than to
// spawn time deliberately: anchoring to spawn would make the window race
// against Node boot + this helper's own module-graph load (a heavier helper
// pulling in gh-exec etc. can itself take a while on a loaded CI runner),
// which could let a raw trace slip through live on a slow machine. Anchored
// to first-chunk, the only question the timer answers is "did more output
// keep arriving after that", which is independent of startup latency.
const GRACE_WINDOW_MS = 200;

export function runHelper(relativeScriptPath: string): void {
  const binDirectory = import.meta.dirname;
  const scriptPath = resolve(binDirectory, relativeScriptPath);

  // Stream the child's stderr through a pipe -- not a temp file -- and
  // decide what to do with it in real time. An earlier version of this fix
  // captured stderr via a real file specifically to avoid a pipe's crash-
  // write truncation (see below), but that traded away two things every
  // packaged CLI command needs: (1) live/incremental stderr for long-
  // running helpers (idd-doctor's `emitCleanupBacklogProgress` writes each
  // line to stderr specifically so a slow serial scan is distinguishable
  // from a hang -- a temp-file capture buffers all of it until exit,
  // silently breaking that UX), and (2) never requiring writable temp
  // storage just to run a CLI command that itself does no filesystem I/O
  // (a temp-file capture made *every* invocation, including `--help`,
  // hard-depend on `os.tmpdir()` being writable). Buffering only for a
  // short bounded window after the first chunk, then committing to live
  // pass-through, restores both properties while still catching the
  // scenario this fix targets: a shaped parse error is a synchronous throw
  // within milliseconds of startup, always well inside the window.
  //
  // Trade-off, disclosed rather than silently dropped: a pipe is still
  // subject to Node's own crash-write behavior on an uncaught exception --
  // when a child dies with stderr connected to a pipe, its internal
  // fatal-exception write can be silently capped (empirically, around
  // ~146 KiB), regardless of how fast the parent drains it, because that
  // crash path does not wait for the pipe to drain before hard-exiting.
  // This is not a new regression, though: under the pre-#1922 plain
  // 'inherit' stdio, any operator piping this process's own stderr
  // onward (`... 2>&1 | tee log`, common in CI) already inherited that
  // same ceiling one layer up. No helper in this repository throws an
  // error anywhere near that size; a temp file would remove the ceiling
  // but reintroduces both regressions above to do it, which is the worse
  // trade for realistic use.
  const child = spawn(
    process.execPath,
    [scriptPath, ...process.argv.slice(2)],
    { stdio: ['inherit', 'inherit', 'pipe'] },
  );

  let buffered: Buffer[] = [];
  let streaming = false;
  let graceTimer: NodeJS.Timeout | null = null;

  const commitToStreaming = () => {
    if (streaming) {
      return;
    }
    streaming = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    for (const chunk of buffered) {
      process.stderr.write(chunk);
    }
    buffered = [];
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    if (streaming) {
      process.stderr.write(chunk);
      return;
    }
    buffered.push(chunk);
    if (graceTimer === null) {
      graceTimer = setTimeout(commitToStreaming, GRACE_WINDOW_MS);
      // Doesn't itself keep the process alive -- only the child's own open
      // stdio handles should do that, so a fast successful exit inside the
      // window isn't held open an extra 200ms waiting on this timer.
      graceTimer.unref();
    }
  });

  child.on('error', (error) => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    throw error;
  });

  // 'close' (not 'exit') is the right event to decide on: it fires only
  // after every stdio stream has fully drained, guaranteeing every stderr
  // 'data' event above has already run. Deciding on 'exit' instead would
  // race the tail of the child's crash output -- possibly the "Error: "
  // line itself -- out of the buffer.
  child.on('close', (code) => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }

    const exitCode = code ?? 1;

    if (streaming) {
      // Already committed to live pass-through -- every chunk reached the
      // real stderr as it arrived, so there is nothing buffered left to
      // decide on. This includes an intentional boundary: a shaped-
      // looking error thrown *after* the window has elapsed streams live,
      // raw trace and all, exactly like any other output at that point.
      process.exitCode = exitCode;
      return;
    }

    const capturedStderr = Buffer.concat(buffered).toString('utf8');
    // Only a non-zero exit is even eligible for shaped-error interception --
    // a successful run's stderr (e.g. idd-doctor's streamed progress) is
    // never inspected, so it always falls through to the unconditional
    // forward below unchanged.
    const shapedMessage =
      exitCode !== 0 ? extractShapedCliParseErrorMessage(capturedStderr) : null;

    if (shapedMessage === null) {
      // No recognized shaped parse error -- a successful run, or an
      // unrelated failure: forward the captured stderr through
      // byte-for-byte, preserving a genuine bug's full stack trace.
      for (const chunk of buffered) {
        process.stderr.write(chunk);
      }
      process.exitCode = exitCode;
      return;
    }

    process.stderr.write(`${shapedMessage}\n`);
    const usage = fetchUsageLine(scriptPath);
    if (usage !== null) {
      process.stderr.write(`${usage}\n`);
    }
    process.exitCode = exitCode;
  });
}

/**
 * Best-effort re-invocation of the failing script's own `--help` output, to
 * append "the calling script's own usage line" (#1922's acceptance
 * criteria) after a shaped parse-error message. Every `--help` path among
 * this repository's `parseCliArgs`-based helpers exits 0 before any
 * network or `gh` call (see tests/help-text-flags.test.mts), but `--help`
 * is not guaranteed to be declared at all -- an undeclared `--help` itself
 * throws "unknown argument: --help", which surfaces here as a non-zero
 * exit and is treated the same as "no usage available". Always optional:
 * any spawn error, non-zero exit, or timeout degrades silently to no usage
 * line rather than risking the primary error-reporting path above. Ordinary
 * piped stdout capture is fine here (unlike stderr above) -- a `--help`
 * exit is always a clean `process.exit(0)`, never the uncaught-exception
 * crash path the buffering above exists to detect.
 */
function fetchUsageLine(scriptPath: string): string | null {
  const helpResult = spawnSync(process.execPath, [scriptPath, '--help'], {
    encoding: 'utf8',
    timeout: HELP_REINVOKE_TIMEOUT_MS,
  });
  if (helpResult.error || helpResult.status !== 0) {
    return null;
  }
  const usage = helpResult.stdout?.trim();
  return usage ? usage : null;
}
