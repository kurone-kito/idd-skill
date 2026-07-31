#!/usr/bin/env node
// idd-generated-from: src/scripts/build-check.mts
//
// The scripts/build-check.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Cross-platform `pnpm run build:check`: runs the build, fails when the
// tracked artifact tree drifts, and fails when a newly emitted artifact
// is untracked. Originally a shell-composed
// `git diff HEAD --exit-code ... && test -z "$(git status --porcelain
// ...)"` chain, which two review findings on #1707 showed was unsafe:
// `test`/`$()` are POSIX-only, so npm/pnpm's default `cmd.exe` shell on
// Windows breaks it (including callers of the reusable pnpm-boundary
// workflow on a windows-* runner), and `git status --porcelain` without
// an explicit `--untracked-files` override silently respects a local or
// CI `status.showUntrackedFiles=no` config, which would let an
// untracked emitted artifact pass unnoticed (observed 2026-07-31,
// #1707). `git ls-files --others` is a plumbing command that does not
// consult that config at all, and running everything through
// `child_process` instead of a shell removes the POSIX-vs-cmd.exe split
// entirely.
//
// Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

import { spawnSync } from 'node:child_process';

const TRACKED_DIFF_PATHS = ['scripts', 'bin', '.gitattributes'];
const UNTRACKED_SCAN_PATHS = ['scripts', 'bin'];

/** Runs `command`, inheriting stdio, and returns its exit code (1 on spawn failure). */
function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(
      `build:check: failed to run ${command}: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Untracked file paths under `UNTRACKED_SCAN_PATHS`, via the `git ls-files`
 * plumbing command — unaffected by `status.showUntrackedFiles`, unlike
 * `git status`. Respects `.gitignore` (`--exclude-standard`).
 */
function untrackedEmittedArtifacts(): string[] {
  const result = spawnSync(
    'git',
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      ...UNTRACKED_SCAN_PATHS,
    ],
    { encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(
      `build:check: failed to run git ls-files: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `build:check: git ls-files exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

function main(): void {
  const buildStatus = run('node', ['scripts/build-ts.mjs']);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }

  const diffStatus = run('git', [
    'diff',
    'HEAD',
    '--exit-code',
    '--',
    ...TRACKED_DIFF_PATHS,
  ]);
  if (diffStatus !== 0) {
    process.exit(diffStatus);
  }

  const untracked = untrackedEmittedArtifacts();
  if (untracked.length > 0) {
    console.error(
      'build:check: untracked emitted artifact(s) present under scripts/bin ' +
        `(git add them, or remove them, before committing):\n${untracked
          .map((file) => `  ${file}`)
          .join('\n')}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
