import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  defaultCheckGroups,
  selectCheckGroups,
} from '../src/scripts/check-project.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(
  readFileSync(join(REPO_ROOT, '.github', 'idd', 'config.json'), 'utf8'),
);
const pkg = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const chain: string = config.commands['pre-push-validate'];

const EXPECTED_ORDER = [
  'pnpm run check',
  'pnpm run doctor:github',
  'node scripts/token-cost-report.mjs --check',
  'node scripts/check-stray-commit-closes.mjs',
];

// The chain joins its steps with `&&` only, so stopping at the first failing
// step is exactly what the shell does. The first test pins that no other
// operator appears, so this simulation cannot drift from the shell's behavior.
// It runs nothing real, makes no GitHub request, and spawns no shell, so it
// behaves the same on every platform.
function runChain(failAt: string | null): { status: number; calls: string[] } {
  const calls: string[] = [];
  for (const step of chain.split(' && ')) {
    calls.push(step);
    if (step === failAt) {
      return { status: 1, calls };
    }
  }
  return { status: 0, calls };
}

test('the chain uses only && between its steps', () => {
  const steps = chain.split(' && ').join(' ');
  for (const operator of ['&', '|', ';', '`', '$(']) {
    assert.equal(steps.includes(operator), false, `operator ${operator}`);
  }
});

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

test('the check command runs every group, including the aggregate audit', () => {
  const selected = selectCheckGroups(defaultCheckGroups(undefined), []);
  assert.equal(Array.isArray(selected), true);
  assert.deepEqual(
    (selected as { id: string }[]).map((group) => group.id),
    ['lint', 'typecheck', 'build:check', 'test', 'audit'],
  );
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
    'audit',
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
