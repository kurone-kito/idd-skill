#!/usr/bin/env node
// idd-generated-from: src/bin/run-helper.mts
//
// The bin/run-helper.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { extractShapedCliParseErrorMessage } from '../scripts/cli-args.mjs';

// spawnSync's own default stderr maxBuffer is 1 MiB -- too small for a
// helper that streams verbose diagnostic progress to stderr by design
// (idd-doctor's post-merge cleanup-backlog sweep, for one -- see
// docs/idd-helper-scripts.md). Piping stderr (instead of inheriting it,
// below) is required to inspect it for a shaped parse error (#1922) before
// deciding what to forward, so this buffer budget keeps that inspection
// from truncating or killing a legitimately chatty run. Not unlimited --
// spawnSync has no true streaming mode -- but generous enough that no
// helper in this repository is expected to approach it.
const STDERR_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// Bounds the best-effort `--help` re-invocation used to fetch a usage line
// below -- this must never hang the primary error-reporting path.
const HELP_REINVOKE_TIMEOUT_MS = 5_000;
export function runHelper(relativeScriptPath) {
  const binDirectory = import.meta.dirname;
  const scriptPath = resolve(binDirectory, relativeScriptPath);
  const result = spawnSync(
    process.execPath,
    [scriptPath, ...process.argv.slice(2)],
    {
      // stdin/stdout stay live-inherited -- no behavior change for normal
      // output. Only stderr is captured (piped) so it can be inspected for
      // a shaped parse error before deciding what to forward; the known,
      // accepted trade-off is that stderr is no longer streamed live to
      // the terminal in real time, only flushed once the child exits.
      stdio: ['inherit', 'inherit', 'pipe'],
      encoding: 'utf8',
      maxBuffer: STDERR_MAX_BUFFER_BYTES,
    },
  );
  if (result.error) {
    throw result.error;
  }
  const exitCode = result.status ?? 1;
  // Only a non-zero exit is even eligible for shaped-error interception --
  // a successful run's stderr (e.g. idd-doctor's streamed progress) is
  // never inspected, so it always falls through to the unconditional
  // forward below unchanged.
  const shapedMessage =
    result.status !== 0
      ? extractShapedCliParseErrorMessage(result.stderr ?? '')
      : null;
  if (shapedMessage === null) {
    // No recognized shaped parse error -- a successful run, or an
    // unrelated failure: forward the captured stderr through
    // byte-for-byte, preserving a genuine bug's full stack trace.
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(exitCode);
  }
  process.stderr.write(`${shapedMessage}\n`);
  const usage = fetchUsageLine(scriptPath);
  if (usage !== null) {
    process.stderr.write(`${usage}\n`);
  }
  process.exit(exitCode);
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
 * line rather than risking the primary error-reporting path above.
 */
function fetchUsageLine(scriptPath) {
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
