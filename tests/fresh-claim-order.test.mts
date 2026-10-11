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

test('the lite fresh claim adopts the claim-phase worktree through step 7', () => {
  const lite = readTemplate(
    'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
  );
  assert.match(lite, /skip steps 8-26,\s+run step 27/);
  assert.match(
    lite,
    /continue at step 28\. Never delete or\s+recreate that branch\./,
  );
});

test('the claim instructions state the worktree-first steps in sequence', () => {
  const claim = readTemplate(
    'idd-template/.github/instructions/idd-claim.instructions.md',
  );
  const steps = [
    'Fresh-claim order, worktree first.',
    '1. Create the worktree and branch: `git worktree add --no-track <path> -b',
    '2. `--record-tokens --worktree <path>`.',
    '3. Post the claim comment per',
    '4. `--acquire --worktree <path>`, on the linked worktree only.',
    '5. After the settle delay, `resume-claim-routing.mjs --issue <n> --assert',
    '6. Continue B1 in that worktree',
  ];
  const positions = steps.map((step) => claim.indexOf(step));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, steps[index]);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the steps must appear in the documented order',
  );
});

test('the lite claim keeps the worktree-first order and the stop sentence', () => {
  const normalize = (text: string) => text.replace(/\s+/g, ' ');
  const full = normalize(
    readTemplate('idd-template/.github/instructions/idd-claim.instructions.md'),
  );
  const lite = normalize(
    readTemplate(
      'idd-template/.github/instructions/lite/idd-claim-lite.instructions.md',
    ),
  );
  const stopSentence =
    'Make no claim-stage event/marker, branch/worktree, or issue-state change.';
  assert.ok(full.includes(stopSentence), 'full claim stop sentence');
  assert.ok(lite.includes(stopSentence), 'lite claim stop sentence');
  assert.ok(
    lite.includes('Skip Claim execution for a continuation'),
    'the continuation skips Claim execution',
  );
  const steps = [
    'on a fresh claim with no inheritable branch',
    'git worktree add --no-track <path> -b <branch-name> origin/main',
    '`--worktree <path> --agent-id <id> --claim-id <id>`',
    '4. Post via helper',
    '6. **Fresh claim with no inheritable branch: lock and assert before verification.**',
    '`resume-claim-routing.mjs` with `--assert`, `--issue`, `--claim-id`, `--nonce`, and `--worktree`',
    'it must return `already_owned`/`keep`, and that post-acquire result alone counts.',
    '## Claim verification',
    '**Digest**:',
  ];
  const positions = steps.map((step) => lite.indexOf(step));
  for (const [index, position] of positions.entries()) {
    assert.notEqual(position, -1, steps[index]);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the lite steps must appear in the documented order',
  );
});
