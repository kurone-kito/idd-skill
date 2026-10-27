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

test('the lite B1 resolves and validates the development branch first', () => {
  const lite = readTemplate(
    'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
  ).replace(/\s+/g, ' ');
  const resolution = lite.indexOf(
    'Before step 1, resolve `{development-branch}`',
  );
  assert.notEqual(resolution, -1, 'the resolution paragraph');
  assert.ok(
    resolution <
      lite.indexOf('1. On the primary worktree, run `git fetch origin`.'),
    'the resolution precedes step 1',
  );
  for (const phrase of [
    '`idd-effective-config --key developmentBranch`',
    'Stop if it fails or reports unreadable policy.',
    'Use its `value` when `found` is `true`',
    'only when `found` is `false`, use `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.',
    'Stop unless the name matches `^(?!refs/heads/)[A-Za-z0-9._/][A-Za-z0-9._/-]*$`',
    '`git ls-remote --exit-code --heads origin <name>` lists it.',
    'Steps 15, 16, 21, and 25 use only this value.',
  ]) {
    assert.ok(lite.includes(phrase), phrase);
  }
});

test('each lite fresh-worktree creation step uses the resolved branch', () => {
  const lite = readTemplate(
    'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
  );
  const stepBody = (number: number) => {
    const match = new RegExp(
      `^${number}\\. ([\\s\\S]*?)(?=^${number + 1}\\. )`,
      'm',
    ).exec(lite);
    assert.ok(match, `lite step ${number}`);
    return match[1];
  };
  assert.match(stepBody(15), /\{development-branch\}/);
  assert.match(stepBody(16), /\{development-branch\}/);
  assert.match(stepBody(21), /origin\/\{development-branch\}/);
  assert.match(stepBody(25), /fresh claim per step 21/);
});

test('the lite work root copy matches its template body', () => {
  const body = (text: string) => text.slice(text.indexOf('# IDD —'));
  assert.equal(
    body(
      readTemplate('.github/instructions/lite/idd-work-lite.instructions.md'),
    ),
    body(
      readTemplate(
        'idd-template/.github/instructions/lite/idd-work-lite.instructions.md',
      ),
    ),
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

const WRAPPER_DOC = 'idd-template/docs/idd-helper-scripts.md';
// The wrapper is a POSIX sh block. On Windows, spawnSync('bash') resolves to
// System32's WSL bash, which cannot run the stub sleep or the C:\ paths.
const WRAPPER_SKIP =
  process.platform === 'win32'
    ? 'POSIX sh block; bash resolves to WSL on Windows'
    : false;
const WRAPPER_SUCCESS = 'verified';
const WRAPPER_STEPS = [
  'record',
  'gate',
  'post-claim',
  'record-nonce',
  'post-nonce',
  'acquire',
  'read-tokens',
  'sleep:5',
  'assert',
];

/** The fenced sh block that runs fresh-claim steps 2 to 5, without fences. */
function freshClaimWrapper(): string {
  const match =
    /```sh\n(set -euo pipefail\nw='<path>'[^\n]*\n[\s\S]*?)\n```/.exec(
      readTemplate(WRAPPER_DOC),
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
const step = args.includes('--read-tokens') ? 'read-tokens' : args.includes('--record-tokens')
  ? (args.includes('--nonce') ? 'record-nonce' : 'record')
  : args.includes('--acquire') ? 'acquire'
  : args.includes('--fresh-claim-gate') ? 'gate'
  : args.includes('--assert') ? 'assert'
  : args[args.indexOf('--type') + 1] === 'claim' ? 'post-claim'
  : args[args.indexOf('--type') + 1] === 'activation-nonce' ? 'post-nonce' : 'unknown';
appendFileSync(process.env.TRACE, step + '\\n');
if (step === 'read-tokens') {
  const body = process.env.TOKENS === 'absent' ? { path: 'x', present: false }
    : process.env.TOKENS === 'malformed' ? { path: 'x', present: true, malformed: true }
    : { path: 'x', present: true, record: {} };
  process.stdout.write(JSON.stringify(body));
}
if (step === 'gate') {
  process.stdout.write(JSON.stringify({ fresh_claim_gate: { verdict: process.env.VERDICT } }));
}
process.exit(JSON.parse(process.env.EXITS)[step] ?? 0);
`;
}

/**
 * A stub sleep: it logs the seconds it was given, without waiting, then exits
 * with the given code so a failing settle delay can be exercised.
 */
function sleepStub(exitCode: number): string {
  return `#!/bin/sh
echo "sleep:$1" >> "$TRACE"
exit ${exitCode}
`;
}

/** A value for a placeholder that already sits inside single quotes. */
function shellBody(value: string): string {
  return value.replaceAll("'", "'\\''");
}

type WrapperRun = { status: number | null; stdout: string; steps: string[] };

/**
 * Runs the extracted wrapper under bash in a sandbox. Stub helpers live in
 * scripts/, a stub sleep shadows the real one, and the worktree path contains
 * an apostrophe so the escape rule is exercised. The placeholders are filled
 * with the default-format settle value: PT5S is 5 seconds.
 */
function runFreshClaimWrapper(
  exits: Record<string, number>,
  verdict = 'claimable',
  tokens = 'present',
): WrapperRun {
  const root = mkdtempSync(join(tmpdir(), 'fresh-claim-wrapper-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    const worktree = join(root, "work'tree");
    mkdirSync(worktree);
    for (const script of [
      'claim-lock',
      'resume-claim-routing',
      'post-idd-marker',
    ]) {
      writeFileSync(join(root, 'scripts', `${script}.mjs`), stubSource());
    }
    writeFileSync(join(root, 'bin', 'sleep'), sleepStub(exits.sleep ?? 0), {
      mode: 0o755,
    });
    const trace = join(root, 'trace.log');
    writeFileSync(trace, '');
    const block = freshClaimWrapper()
      .replaceAll('<path>', shellBody(worktree))
      .replaceAll('{agent-id}', 'claude-test')
      .replaceAll('{claim-id}', 'claim-test')
      .replaceAll('{nonce}', 'nonce-test')
      .replaceAll('<n>', '4315')
      .replaceAll('<branch>', 'issue/4315-test')
      .replaceAll('<ts>', '2026-10-15T00:00:00Z')
      .replaceAll('<settle-seconds>', '5');
    assert.doesNotMatch(block, /<[a-z-]+>|\{[a-z-]+\}/, 'every placeholder');
    const result = spawnSync('bash', ['-c', block], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: [
          join(root, 'bin'),
          dirname(process.execPath),
          process.env.PATH ?? '',
        ].join(delimiter),
        TRACE: trace,
        EXITS: JSON.stringify(exits),
        VERDICT: verdict,
        TOKENS: tokens,
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

test('the fresh-claim wrapper reports success only after the assert', {
  skip: WRAPPER_SKIP,
}, () => {
  const run = runFreshClaimWrapper({});
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.steps, WRAPPER_STEPS);
  assert.equal(run.stdout.trim(), WRAPPER_SUCCESS);
});

test('a failed assert runs last and reports no success', {
  skip: WRAPPER_SKIP,
}, () => {
  const run = runFreshClaimWrapper({ assert: 1 });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.steps, WRAPPER_STEPS);
  assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
});

test('a failure before the claim marker reports no success and posts nothing', {
  skip: WRAPPER_SKIP,
}, () => {
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

test('a non-zero fresh-claim gate stops before any claim post', {
  skip: WRAPPER_SKIP,
}, () => {
  const run = runFreshClaimWrapper({ gate: 1 });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.steps, ['record', 'gate']);
  assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
});

test('an absent or malformed generated-tokens record stops before the assert', {
  skip: WRAPPER_SKIP,
}, () => {
  for (const tokens of ['absent', 'malformed']) {
    const run = runFreshClaimWrapper({}, 'claimable', tokens);
    assert.notEqual(run.status, 0, tokens);
    assert.deepEqual(run.steps, WRAPPER_STEPS.slice(0, 7), tokens);
    assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false, tokens);
  }
});

test('a failed settle sleep stops before the assert and prints no success', {
  skip: WRAPPER_SKIP,
}, () => {
  const run = runFreshClaimWrapper({ sleep: 1 });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.steps, WRAPPER_STEPS.slice(0, 8));
  assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
});

test('a failed claim post, nonce record, or acquire stops the later steps', {
  skip: WRAPPER_SKIP,
}, () => {
  const postFailed = runFreshClaimWrapper({ 'post-claim': 1 });
  assert.notEqual(postFailed.status, 0);
  assert.deepEqual(postFailed.steps, ['record', 'gate', 'post-claim']);
  const nonceRecordFailed = runFreshClaimWrapper({ 'record-nonce': 1 });
  assert.notEqual(nonceRecordFailed.status, 0);
  assert.deepEqual(nonceRecordFailed.steps, WRAPPER_STEPS.slice(0, 4));
  const nonceFailed = runFreshClaimWrapper({ 'post-nonce': 1 });
  assert.notEqual(nonceFailed.status, 0);
  assert.deepEqual(nonceFailed.steps, WRAPPER_STEPS.slice(0, 5));
  const acquireFailed = runFreshClaimWrapper({ acquire: 2 });
  assert.notEqual(acquireFailed.status, 0);
  assert.deepEqual(acquireFailed.steps, WRAPPER_STEPS.slice(0, 6));
  for (const run of [
    postFailed,
    nonceRecordFailed,
    nonceFailed,
    acquireFailed,
  ]) {
    assert.equal(run.stdout.includes(WRAPPER_SUCCESS), false);
  }
});

test('the claim pointer links to the fresh-claim wrapper heading', () => {
  const pointer = 'docs/idd-helper-scripts.md#fresh-claim-wrapper';
  assert.ok(
    readTemplate(
      'idd-template/.github/instructions/idd-claim.instructions.md',
    ).includes(pointer),
    'the claim file points at the wrapper anchor',
  );
  assert.match(
    readTemplate(WRAPPER_DOC),
    /\n### Fresh-claim wrapper\n/,
    'the helper doc has the wrapper heading the anchor names',
  );
});
