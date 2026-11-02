import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stubExecutable } from './test-utils.mts';

// The bin entry the packaged command runs. Its gh calls resolve to a stub `gh`
// from the repository's stubExecutable helper, which places a launchable
// executable on PATH on every platform, so the test exercises the wiring from
// flags to exit status without a network call.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'idd-pull-request-draft-state.mjs');
const HEAD = 'a'.repeat(40);
const REPO = 'kurone-kito/idd-skill';

const STUB_BODY = [
  "const fs = require('node:fs');",
  'const statePath = process.env.DRAFT_STATE_STUB_STATE;',
  'const args = process.argv.slice(2);',
  'const state = JSON.parse(fs.readFileSync(statePath, "utf8"));',
  "if (args.includes('graphql')) {",
  "  if (process.env.DRAFT_STATE_STUB_MUTATION_FAIL === '1') {",
  "    process.stderr.write('graphql: forbidden\\n');",
  '    process.exit(1);',
  '  }',
  "  state.draft = args.join(' ').includes('convertPullRequestToDraft');",
  '  fs.writeFileSync(statePath, JSON.stringify(state));',
  "  process.stdout.write('{}');",
  '  process.exit(0);',
  '}',
  "if (args.some((arg) => arg.startsWith('repos/'))) {",
  '  process.stdout.write(JSON.stringify({',
  '    node_id: state.nodeId,',
  "    state: state.open ? 'open' : 'closed',",
  '    merged: state.merged,',
  '    draft: state.draft,',
  '    head: { sha: state.sha },',
  '    base: { repo: { full_name: state.base } },',
  '  }));',
  '  process.exit(0);',
  '}',
  'process.exit(2);',
  '',
].join('\n');

const restoreGh = stubExecutable('gh', STUB_BODY);
const stateDir = mkdtempSync(join(tmpdir(), 'draft-state-execute-'));
after(() => {
  restoreGh();
  rmSync(stateDir, { recursive: true, force: true });
});

interface StubState {
  nodeId: string;
  open: boolean;
  merged: boolean;
  draft: boolean;
  sha: string;
  base: string;
}

function pullRequest(overrides: Partial<StubState> = {}): StubState {
  return {
    nodeId: 'PR_kwDOExample',
    open: true,
    merged: false,
    draft: false,
    sha: HEAD,
    base: REPO,
    ...overrides,
  };
}

function runCommand(
  args: string[],
  state: StubState,
  options: { mutationFails?: boolean } = {},
) {
  const statePath = join(
    stateDir,
    `state-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(statePath, JSON.stringify(state));
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DRAFT_STATE_STUB_STATE: statePath,
      DRAFT_STATE_STUB_MUTATION_FAIL: options.mutationFails ? '1' : '0',
    },
  });
  const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as StubState;
  return { status: result.status, stdout: result.stdout, finalState };
}

function flags(overrides: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    owner: 'kurone-kito',
    repo: 'idd-skill',
    number: '4983',
    target: 'draft',
    'expected-head-sha': HEAD,
    ...overrides,
  };
  return Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
}

test('the command dry-runs by default and leaves the pull request unchanged', () => {
  const run = runCommand(flags(), pullRequest({ draft: false }));
  assert.equal(run.status, 0);
  const report = JSON.parse(run.stdout) as { verdict: string };
  assert.equal(report.verdict, 'dry-run');
  assert.equal(run.finalState.draft, false);
});

test('--apply moves a ready pull request to draft and exits 0 after verification', () => {
  const run = runCommand(
    [...flags(), '--apply'],
    pullRequest({ draft: false }),
  );
  assert.equal(run.status, 0);
  const report = JSON.parse(run.stdout) as { verdict: string };
  assert.equal(report.verdict, 'transitioned');
  assert.equal(run.finalState.draft, true);
});

test('--apply moves a draft pull request to ready and exits 0', () => {
  const run = runCommand(
    [...flags({ target: 'ready' }), '--apply'],
    pullRequest({ draft: true }),
  );
  assert.equal(run.status, 0);
  assert.equal(run.finalState.draft, false);
});

test('a merged pull request is refused with exit 1 and no change', () => {
  const run = runCommand(
    [...flags(), '--apply'],
    pullRequest({ open: false, merged: true }),
  );
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout) as { verdict: string; refusal: string };
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'merged');
  assert.equal(run.finalState.draft, false);
});

test('a failed transition request is refused with exit 1', () => {
  const run = runCommand(
    [...flags(), '--apply'],
    pullRequest({ draft: false }),
    { mutationFails: true },
  );
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout) as { verdict: string; refusal: string };
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'transition-failed');
});

test('an unsafe integer pull request number is a usage error before any call', () => {
  const run = runCommand(flags({ number: '9007199254740993' }), pullRequest());
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
});

test('a missing owner is a usage error before any call', () => {
  const run = runCommand(
    [
      '--repo',
      'idd-skill',
      '--number',
      '4983',
      '--target',
      'draft',
      '--expected-head-sha',
      HEAD,
    ],
    pullRequest(),
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
});
