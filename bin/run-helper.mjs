#!/usr/bin/env node
// idd-generated-from: src/bin/run-helper.mts
//
// The bin/run-helper.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractShapedCliParseErrorMessage } from '../scripts/cli-args.mjs';

// Bounds the best-effort `--help` re-invocation used to fetch a usage line
// below -- this must never hang the primary error-reporting path.
const HELP_REINVOKE_TIMEOUT_MS = 5_000;
export function runHelper(relativeScriptPath) {
  const binDirectory = import.meta.dirname;
  const scriptPath = resolve(binDirectory, relativeScriptPath);
  // Capture the child's stderr via a real file, not spawnSync's own piped
  // buffer -- required to inspect it for a shaped parse error (#1922)
  // before deciding what to forward. A PIPE, specifically, turns out to be
  // unsafe for this: when a Node child dies from an uncaught exception, its
  // internal fatal-exception write to a *piped* stderr can be silently
  // truncated (confirmed empirically -- a multi-MB thrown message caps
  // around ~146 KiB over a pipe, every time, regardless of spawnSync's own
  // maxBuffer), because that crash path does not wait for the pipe's
  // buffer to drain before the process hard-exits. Writing to a real file
  // has no such ceiling (verified with the same repro): a file write isn't
  // subject to the OS pipe-buffer-fill race the crash path loses. This
  // capture-via-file step is *why* stdin/stdout stay 'inherit' below (no
  // behavior change there) while only stderr routes through this
  // temporary file.
  // The whole capture lifecycle (open, spawn, read) runs inside this try so
  // captureDir is always removed on the way out -- including if openSync or
  // spawnSync itself throws synchronously, not just the ordinary success
  // path (E10 follow-up on this fix: the first version only guarded the
  // read-back step, leaking captureDir on either earlier failure).
  const captureDir = mkdtempSync(join(tmpdir(), 'idd-run-helper-stderr-'));
  try {
    const capturePath = join(captureDir, 'stderr.log');
    const captureFd = openSync(capturePath, 'w');
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [scriptPath, ...process.argv.slice(2)],
        {
          stdio: ['inherit', 'inherit', captureFd],
        },
      );
    } finally {
      closeSync(captureFd);
    }
    if (result.error) {
      throw result.error;
    }
    const capturedStderr = readFileSync(capturePath, 'utf8');
    const exitCode = result.status ?? 1;
    // Only a non-zero exit is even eligible for shaped-error interception --
    // a successful run's stderr (e.g. idd-doctor's streamed progress) is
    // never inspected, so it always falls through to the unconditional
    // forward below unchanged.
    const shapedMessage =
      result.status !== 0
        ? extractShapedCliParseErrorMessage(capturedStderr)
        : null;
    if (shapedMessage === null) {
      // No recognized shaped parse error -- a successful run, or an
      // unrelated failure: forward the captured stderr through
      // byte-for-byte, preserving a genuine bug's full stack trace.
      if (capturedStderr) {
        process.stderr.write(capturedStderr);
      }
      // Setting exitCode and letting the module finish naturally (instead
      // of calling process.exit() here) is deliberate: a write to a piped
      // stderr is asynchronous (a write to a real file, as used for the
      // capture above, is actually synchronous on both POSIX and Windows --
      // it's specifically the pipe this process's own stdout/stderr may
      // itself be redirected through, one layer up, that's at risk), and
      // process.exit() does not wait for a pending async write to flush.
      // Node only exits once the event loop drains, which happens after
      // the write completes, so this is the correct pattern rather than an
      // explicit exit call right after a write.
      process.exitCode = exitCode;
      return;
    }
    process.stderr.write(`${shapedMessage}\n`);
    const usage = fetchUsageLine(scriptPath);
    if (usage !== null) {
      process.stderr.write(`${usage}\n`);
    }
    // Same flush reasoning as above -- the shaped message and usage line
    // are always short, but exiting right after a write that hasn't
    // flushed yet is the wrong pattern to establish even where it
    // doesn't yet bite.
    process.exitCode = exitCode;
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
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
 * crash path that motivates the temp-file capture.
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
