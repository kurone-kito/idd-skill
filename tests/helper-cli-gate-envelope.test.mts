import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv, stubExecutable } from './test-utils.mts';

// #3443: envelope-on gate exits the shared args-only contract sweep cannot
// stage (a held lock, a clone-lock timeout, or a parsed failing report).
// Usage failures stay kind `usage` and are covered by helper-cli-contract.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN_DIR = join(REPO_ROOT, 'bin');
const ENVELOPE_LINE_PREFIX = '{"iddHelperError":';
const SPAWN_TIMEOUT_MS = 20_000;

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = fixtureEnv();
  env.IDD_HELPER_ERROR_ENVELOPE = '1';
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function spawnBin(
  bin: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): SpawnResult {
  const result = spawnSync(process.execPath, [join(BIN_DIR, bin), ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: childEnv(),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function extractEnvelope(stderrText: string): {
  iddHelperError: { kind: string; exitCode: number };
} | null {
  const lines = stderrText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === '') {
      continue;
    }
    return line.startsWith(ENVELOPE_LINE_PREFIX) ? JSON.parse(line) : null;
  }
  return null;
}

function assertGate(result: SpawnResult, exitCode: number): void {
  const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.status, exitCode, detail);
  const envelope = extractEnvelope(result.stderr);
  assert.ok(envelope, detail);
  assert.equal(envelope.iddHelperError.kind, 'gate', detail);
  assert.equal(envelope.iddHelperError.exitCode, exitCode, detail);
}

function withGitRepo(run: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), 'idd-gate-envelope-'));
  try {
    execFileSync('git', ['init', '--quiet'], {
      cwd: repo,
      env: fixtureEnv(),
    });
    run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeGhStub(scriptBody: string): () => void {
  return stubExecutable('gh', scriptBody);
}

const NOT_FOUND_GH = `process.stderr.write('gh: HTTP 404\\n'); process.exit(1);\n`;

const CHILDLESS_ROADMAP_GH = `
const args = process.argv.slice(2);
if (args.includes('graphql')) {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        issue: {
          subIssues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  }));
  process.exit(0);
}
if (args.join(' ').includes('/issues/')) {
  process.stdout.write(JSON.stringify({
    number: 7,
    title: 'childless roadmap',
    state: 'open',
    body: 'No child references here.\\n',
    labels: [],
  }));
  process.exit(0);
}
if (args.includes('user')) {
  process.stdout.write('tester\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh: ' + args.join(' ') + '\\n');
process.exit(1);
`;

test('claim-lock acquire collision is an envelope gate exit 2', () => {
  withGitRepo((repo) => {
    const first = spawnBin('idd-claim-lock.mjs', [
      '--acquire',
      '--worktree',
      repo,
      '--agent-id',
      'gate-envelope-a',
      '--claim-id',
      'claim-gate-envelope-a',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const collision = spawnBin('idd-claim-lock.mjs', [
      '--acquire',
      '--worktree',
      repo,
      '--agent-id',
      'gate-envelope-b',
      '--claim-id',
      'claim-gate-envelope-b',
    ]);
    assertGate(collision, 2);
    assert.match(collision.stdout, /"mode":"collision"/);
  });
});

test('claim-lock backfill with no lock is an envelope gate exit 2', () => {
  withGitRepo((repo) => {
    const result = spawnBin('idd-claim-lock.mjs', [
      '--backfill-tokens',
      '--worktree',
      repo,
      '--claim-id',
      'claim-gate-envelope-missing',
    ]);
    assertGate(result, 2);
    assert.match(result.stdout, /"status":"lock-absent"/);
  });
});

test('clone-lock acquire timeout is an envelope gate exit 3', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'idd-gate-envelope-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repo, env: fixtureEnv() });
  const holder = spawn(
    process.execPath,
    [
      join(BIN_DIR, 'idd-clone-lock.mjs'),
      '--exec',
      '--agent-id',
      'gate-envelope-holder',
      '--repo',
      repo,
      '--timeout-ms',
      '8000',
      '--',
      'sleep',
      '8',
    ],
    { env: childEnv(), stdio: 'ignore' },
  );
  try {
    const deadline = Date.now() + 4_000;
    let held = false;
    while (Date.now() < deadline) {
      const check = spawnBin('idd-clone-lock.mjs', ['--check', '--repo', repo]);
      if (check.status === 0 && check.stdout.includes('"holderAlive":true')) {
        held = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    assert.equal(held, true, 'holder never acquired the clone lock');
    const waiter = spawnBin('idd-clone-lock.mjs', [
      '--exec',
      '--agent-id',
      'gate-envelope-waiter',
      '--repo',
      repo,
      '--timeout-ms',
      '800',
      '--',
      'true',
    ]);
    assertGate(waiter, 3);
  } finally {
    holder.kill('SIGTERM');
    await new Promise((resolve) => {
      holder.once('exit', () => resolve(undefined));
    });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('clone-lock passes a non-zero child status through as gate', () => {
  withGitRepo((repo) => {
    const result = spawnBin('idd-clone-lock.mjs', [
      '--exec',
      '--agent-id',
      'gate-envelope-child',
      '--repo',
      repo,
      '--timeout-ms',
      '5000',
      '--',
      process.execPath,
      '-e',
      'process.exit(4)',
    ]);
    assertGate(result, 4);
  });
});

test('suitability-close-execute not-found dry-run is an envelope gate exit 1', () => {
  const cleanup = writeGhStub(NOT_FOUND_GH);
  try {
    const result = spawnBin('idd-suitability-close-execute.mjs', [
      '--issue',
      '1',
      '--owner',
      'example',
      '--repo',
      'example',
    ]);
    assertGate(result, 1);
    assert.match(result.stdout, /"ready": false/);
  } finally {
    cleanup();
  }
});

test('roadmap-audit-execute childless dry-run is an envelope gate exit 1', () => {
  const cleanup = writeGhStub(CHILDLESS_ROADMAP_GH);
  try {
    const result = spawnBin('idd-roadmap-audit-execute.mjs', [
      '--roadmap',
      '7',
      '--owner',
      'example',
      '--repo',
      'example',
    ]);
    assertGate(result, 1);
    assert.match(result.stdout, /"ready": false/);
    assert.match(result.stdout, /"kind": "childless"/);
  } finally {
    cleanup();
  }
});

test('audit-authored-issue failed report is an envelope gate exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-gate-audit-'));
  try {
    const bodyPath = join(dir, 'body.md');
    writeFileSync(bodyPath, '## Background\n\nMissing the other sections.\n');
    const result = spawnBin(
      'idd-audit-authored-issue.mjs',
      ['--shape', 'orphan', '--body-file', bodyPath],
      { cwd: dir },
    );
    assertGate(result, 1);
    assert.match(result.stdout, /"passed": false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
