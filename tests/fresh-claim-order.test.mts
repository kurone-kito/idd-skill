import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readTemplate(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

test('both fresh-claim worktree commands use --no-track', () => {
  for (const relativePath of [
    'idd-template/.github/instructions/idd-work.instructions.md',
    'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
  ]) {
    assert.match(
      readTemplate(relativePath),
      /git worktree add --no-track <path> -b <branch-name> origin\//,
      relativePath,
    );
  }
});

test('the claim instructions state the worktree-first order and the counting check', () => {
  const claim = readTemplate(
    'idd-template/.github/instructions/idd-claim.instructions.md',
  );
  assert.match(claim, /Fresh-claim order, worktree first:/);
  assert.match(claim, /`--acquire --worktree <path>`/);
  assert.match(
    claim,
    /after the settle\s+delay, `--assert --worktree <path>`, which alone counts/,
  );
});
