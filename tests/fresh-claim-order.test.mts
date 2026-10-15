import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
      /git worktree add --no-track <path> -b\s+<branch-name>\s+origin\//,
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
    '2. `--record-tokens --worktree <path> --agent-id {agent-id} --claim-id {claim-id}`.',
    // #4019: the second gate read names the caller's own worktree.
    '3. Re-run the A5(c) gate with `--fresh-claim-gate --own-worktree <path>`,',
    'Only on `claimable`, post',
    '4. `--acquire --worktree <path> --agent-id {agent-id} --claim-id {claim-id}`,',
    '   on the linked worktree only.',
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
  // Placement is checked on the raw text: the normalized copies above lose
  // the paragraph breaks that tell a label apart from the Scope paragraph.
  const rawFull = readTemplate(
    'idd-template/.github/instructions/idd-claim.instructions.md',
  );
  const rawLite = readTemplate(
    'idd-template/.github/instructions/lite/idd-claim-lite.instructions.md',
  );
  const fullHeading = rawFull.indexOf('## Context-pressure stop');
  const fullSentence = rawFull.indexOf(stopSentence);
  assert.notEqual(fullHeading, -1, 'full claim context-pressure heading');
  assert.ok(fullHeading < fullSentence, 'full sentence follows its heading');
  assert.ok(
    rawFull.indexOf('\n## ', fullHeading + 1) > fullSentence,
    'full sentence stays under its heading',
  );
  const liteLabel = rawLite.indexOf('**Context-pressure stop**');
  assert.notEqual(liteLabel, -1, 'lite claim context-pressure label');
  assert.ok(
    liteLabel < rawLite.indexOf(stopSentence),
    'lite sentence follows its label',
  );
  assert.ok(
    rawLite.slice(rawLite.indexOf('**Scope**'), liteLabel).includes('\n\n'),
    'lite label is its own paragraph, not part of the Scope paragraph',
  );
  assert.ok(
    lite.includes('Skip Claim execution for a continuation'),
    'the continuation skips Claim execution',
  );
  const steps = [
    'on a fresh claim with no inheritable branch',
    'git worktree add --no-track <path> -b <branch-name> origin/{development-branch}',
    '`--worktree <path> --agent-id <id> --claim-id <id>`',
    '4. Post via helper',
    '(same `<path>`) first:',
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

const CLAIM_TEMPLATE =
  'idd-template/.github/instructions/idd-claim.instructions.md';
const WRAPPER_SUCCESS = 'verified';
const WRAPPER_STEPS = [
  'record',
  'gate',
  'post-claim',
  'post-nonce',
  'acquire',
  'assert',
];

/** The fenced sh block that runs fresh-claim steps 2 to 5, without fences. */
function freshClaimWrapper(): string {
  const match =
    /```sh\n(set -euo pipefail\nw='<path>'[^\n]*\n[\s\S]*?)\n```/.exec(
      readTemplate(CLAIM_TEMPLATE),
    );
  assert.ok(match, 'the fresh-claim wrapper is a fenced sh block');
  return match[1];
}

/**
 * A stub helper: it logs the fresh-claim step it was asked for, then exits
 * with the code the EXITS map gives that step (0 when absent).
 */
function stubSource(): string {
  return `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const type = args[args.indexOf('--type') + 1];
const step = args.includes('--record-tokens') ? 'record'
  : args.includes('--acquire') ? 'acquire'
  : args.includes('--fresh-claim-gate') ? 'gate'
  : args.includes('--assert') ? 'assert'
  : type === 'claim' ? 'post-claim'
  : type === 'activation-nonce' ? 'post-nonce' : 'unknown';
appendFileSync(process.env.TRACE, step + '\\n');
if (step === 'gate') {
  process.stdout.write(JSON.stringify({ fresh_claim_gate: { verdict: process.env.VERDICT } }));
}
process.exit(JSON.parse(process.env.EXITS)[step] ?? 0);
`;
}

type WrapperRun = { status: number | null; stdout: string; steps: string[] };

/**
 * Runs the extracted wrapper under bash in a sandbox whose scripts/ directory
 * holds stub helpers. The placeholders are filled with fixed test values.
 */
function runFreshClaimWrapper(
  exits: Record<string, number>,
  verdict = 'claimable',
): WrapperRun {
  const root = mkdtempSync(join(tmpdir(), 'fresh-claim-wrapper-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const script of [
      'claim-lock',
      'resume-claim-routing',
      'post-idd-marker',
    ]) {
      writeFileSync(join(root, 'scripts', `${script}.mjs`), stubSource());
    }
    const trace = join(root, 'trace.log');
    writeFileSync(trace, '');
    const block = freshClaimWrapper()
      .replaceAll('<path>', root)
      .replaceAll('{agent-id}', 'claude-test')
      .replaceAll('{claim-id}', 'claim-test')
      .replaceAll('{nonce}', 'nonce-test')
      .replaceAll('<n>', '4315')
      .replaceAll('<branch>', 'issue/4315-test')
      .replaceAll('<ts>', '2026-10-15T00:00:00Z')
      .replaceAll('<settle>', '0');
    assert.doesNotMatch(block, /<[a-z]+>|\{[a-z-]+\}/, 'every placeholder');
    const result = spawnSync('bash', ['-c', block], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        TRACE: trace,
        EXITS: JSON.stringify(exits),
        VERDICT: verdict,
      },
    });
    const steps = readFileSync(trace, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    return { status: result.status, stdout: result.stdout, steps };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the fresh-claim wrapper reports success only after the assert', () => {
  const run = runFreshClaimWrapper({});
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.steps, WRAPPER_STEPS);
  assert.equal(run.stdout.trim(), WRAPPER_SUCCESS);
});

test('a failed assert runs last and reports no success', () => {
  const run = runFreshClaimWrapper({ assert: 1 });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.steps, WRAPPER_STEPS);
  assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
});

test('a failure before the claim marker reports no success and posts nothing', () => {
  const recordFailed = runFreshClaimWrapper({ record: 1 });
  assert.notEqual(recordFailed.status, 0);
  assert.deepEqual(recordFailed.steps, ['record']);
  const contested = runFreshClaimWrapper({}, 'already-claimed');
  assert.notEqual(contested.status, 0);
  assert.deepEqual(contested.steps, ['record', 'gate']);
  for (const run of [recordFailed, contested]) {
    assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
  }
});

test('a failed claim post or acquire stops before the later steps', () => {
  const postFailed = runFreshClaimWrapper({ 'post-claim': 1 });
  assert.notEqual(postFailed.status, 0);
  assert.deepEqual(postFailed.steps, ['record', 'gate', 'post-claim']);
  const acquireFailed = runFreshClaimWrapper({ acquire: 2 });
  assert.notEqual(acquireFailed.status, 0);
  assert.deepEqual(acquireFailed.steps, WRAPPER_STEPS.slice(0, 5));
  for (const run of [postFailed, acquireFailed]) {
    assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
  }
});
