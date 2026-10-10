import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(
  readFileSync(join(REPO_ROOT, '.github', 'idd', 'config.json'), 'utf8'),
);
const pkg = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const chain: string = config.commands['pre-push-validate'];

const root = mkdtempSync(join(tmpdir(), 'idd-validation-order-'));
after(() => rmSync(root, { recursive: true, force: true }));

const EXPECTED_ORDER = [
  'pnpm run check',
  'pnpm run doctor:github',
  'node scripts/token-cost-report.mjs --check',
  'node scripts/check-stray-commit-closes.mjs',
];

// Run the configured chain with `pnpm` and `node` replaced by shell functions
// that only record their arguments. Nothing real runs, and no GitHub request
// is made. `FAIL_AT` names the one invocation that returns non-zero.
function runChain(failAt: string | null): {
  status: number | null;
  calls: string[];
} {
  const log = join(
    root,
    `calls-${(failAt ?? 'none').replace(/[^A-Za-z0-9]+/gu, '_')}.log`,
  );
  const script = [
    'pnpm() { echo "pnpm $*" >> "$LOG"; if [ "pnpm $*" = "$FAIL_AT" ]; then return 1; fi; return 0; }',
    'node() { echo "node $*" >> "$LOG"; if [ "node $*" = "$FAIL_AT" ]; then return 1; fi; return 0; }',
    chain,
  ].join('\n');
  const result = spawnSync('sh', ['-c', script], {
    env: { ...process.env, LOG: log, FAIL_AT: failAt ?? '__no_failure__' },
    encoding: 'utf8',
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    calls = [];
  }
  return { status: result.status, calls };
}

test('the pre-push chain runs check, then doctor, then token-cost, then stray', () => {
  const run = runChain(null);
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, EXPECTED_ORDER);
});

test('a failing check stops the chain before doctor runs', () => {
  const run = runChain('pnpm run check');
  // A non-zero status means no push-success evidence can be recorded.
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.calls, ['pnpm run check']);
});

test('a failing doctor stops the chain before token-cost and stray run', () => {
  const run = runChain('pnpm run doctor:github');
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.calls, EXPECTED_ORDER.slice(0, 2));
});

test('a failing stray check is the last step and still fails the chain', () => {
  const run = runChain('node scripts/check-stray-commit-closes.mjs');
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.calls, EXPECTED_ORDER);
});

test('doctor appears once in the pre-push chain and in no static script', () => {
  const steps = chain.split(' && ');
  assert.equal(
    steps.filter((step) => step.includes('doctor')).length,
    1,
    'exactly one doctor step in pre-push-validate',
  );
  for (const name of [
    'check',
    'lint',
    'lint:minimum',
    'test',
    'test:scripts',
    'typecheck',
    'build:check',
    'audit:schemas',
    'docs:sync:check',
  ]) {
    const body = pkg.scripts[name];
    if (body === undefined) continue;
    assert.equal(
      /doctor/u.test(body),
      false,
      `script ${name} must not dispatch doctor`,
    );
  }
  for (const name of ['fix-validate', 'post-fix-validate']) {
    assert.equal(
      /doctor/u.test(config.commands[name]),
      false,
      `${name} must not dispatch doctor`,
    );
  }
});
