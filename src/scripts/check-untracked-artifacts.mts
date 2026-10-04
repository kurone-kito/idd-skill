#!/usr/bin/env node
// idd-generated-from: src/scripts/check-untracked-artifacts.mts
//
// The scripts/check-untracked-artifacts.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Untracked-artifact check for `pnpm run build:check`: fails when a
// scripts/*.mjs or bin/*.mjs is present on disk but untracked. It is the
// second half of `build:check`; the first half is
// check-build-artifacts.mts, which compares a fresh temporary emit with the
// committed files at HEAD without rewriting the checkout.
//
// package.json's build:check runs both from their `.mts` sources (`node
// src/scripts/check-build-artifacts.mts && node
// src/scripts/check-untracked-artifacts.mts`), never from the committed
// scripts/*.mjs copies. Review on PR #1732 (#1707) pointed out why: a
// committed scripts/*.mjs that drifted from its source -- accidentally or via
// tampering -- could still carry the idd-generated-from banner and exit
// early, so a generated checker must never be the sole judge of its own
// integrity (observed 2026-07-31, #1732 review). Running the source entry
// and byte-comparing the committed copies against a fresh emit keeps a
// tampered scripts/check-untracked-artifacts.mjs from ever being trusted.
//
// A plain `git status --porcelain` respects a local/CI
// `status.showUntrackedFiles=no` config and would silently miss an
// untracked file under that config; `git ls-files --others` is a
// plumbing command that does not consult it at all. `-z` keeps a non-ASCII
// name unquoted (git octal-escapes it otherwise).
//
// Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

// #3240: side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. Direct import: this file does not reach cli-args.mts.
// See node-runtime-guard.mts.
import './node-runtime-guard.mts';

import { spawnSync } from 'node:child_process';

const UNTRACKED_SCAN_PATHS = ['scripts', 'bin'];

/**
 * Untracked file paths under `UNTRACKED_SCAN_PATHS`, via the `git ls-files`
 * plumbing command — unaffected by `status.showUntrackedFiles`, unlike
 * `git status`. Respects `.gitignore` (`--exclude-standard`). Throws when git
 * cannot be run or exits non-zero.
 */
export function untrackedEmittedArtifacts(root: string): string[] {
  const result = spawnSync(
    'git',
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...UNTRACKED_SCAN_PATHS,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(
      `check-untracked-artifacts: failed to run git ls-files: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `check-untracked-artifacts: git ls-files exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout.split('\0').filter((line) => line.length > 0);
}

/** The report printed when `files` are present but untracked. */
export function formatUntrackedReport(files: readonly string[]): string {
  return (
    'build:check: untracked emitted artifact(s) present under scripts/bin ' +
    `(git add them, or remove them, before committing):\n${files
      .map((file) => `  ${file}`)
      .join('\n')}`
  );
}

function main(): void {
  try {
    const untracked = untrackedEmittedArtifacts(process.cwd());
    if (untracked.length > 0) {
      console.error(formatUntrackedReport(untracked));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
