#!/usr/bin/env node
// idd-generated-from: src/scripts/check-untracked-artifacts.mts
//
// The scripts/check-untracked-artifacts.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Untracked-artifact check for `pnpm run build:check`: fails when a
// newly emitted scripts/*.mjs or bin/*.mjs is present on disk but
// untracked. Deliberately scoped to ONLY this check -- package.json's
// build:check keeps its own build-then-tracked-diff composition
// (`pnpm run build && git diff HEAD --exit-code -- scripts bin
// .gitattributes && node scripts/check-untracked-artifacts.mjs`)
// directly in the (non-generated) script line rather than delegating
// that comparison into this generated file too. Review on PR #1732
// (#1707) pointed out why: a committed scripts/*.mjs that drifted from
// its source -- accidentally or via tampering -- could still carry the
// idd-generated-from banner and exit early, so if THIS script also
// owned the build-and-diff step, a corrupted copy of itself could hide
// its own drift with nothing outside it to catch that. Keeping the
// build-then-diff comparison in package.json's own command line means
// a tampered committed check-untracked-artifacts.mjs still gets caught
// by that comparison (it rebuilds this very file from source and diffs
// the committed copy against it) before this script ever runs
// (observed 2026-07-31, #1732 review).
//
// A plain `git status --porcelain` respects a local/CI
// `status.showUntrackedFiles=no` config and would silently miss an
// untracked file under that config; `git ls-files --others` is a
// plumbing command that does not consult it at all.
//
// Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

import { spawnSync } from 'node:child_process';

const UNTRACKED_SCAN_PATHS = ['scripts', 'bin'];

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
    console.error(
      `check-untracked-artifacts: failed to run git ls-files: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `check-untracked-artifacts: git ls-files exited ${result.status}: ${result.stderr}`,
    );
    process.exit(1);
  }
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

function main(): void {
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
