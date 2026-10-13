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
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeE10Recurrence,
  E10_FINGERPRINT_RULES,
  validateDispositionRecord,
  validatePasses,
} from '../src/scripts/e10-recurrence.mts';

const SCRIPT = fileURLToPath(
  new URL('../scripts/e10-recurrence.mjs', import.meta.url),
);
const TRIAGE = fileURLToPath(
  new URL(
    '../idd-template/.github/instructions/idd-review-triage.instructions.md',
    import.meta.url,
  ),
);

function accepted(
  construct: string,
  severity: 'low' | 'medium' | 'high',
  rule = 'consistency',
  file = 'docs/a.md',
) {
  return { file, rule, construct, severity, disposition: 'Accepted' };
}

const LOW_A = accepted('shell fallback', 'low');
const HIGH_B = accepted('claim check', 'high', 'correctness', 'src/b.mts');
const MEDIUM_C = accepted('exit code', 'medium', 'correctness', 'src/c.mts');

test('a recurring Low family emits the defer disposition (#4129)', () => {
  const report = computeE10Recurrence([[LOW_A], [LOW_A], [LOW_A]], 3);
  assert.equal(report.verdict, 'defer');
  assert.equal(report.chainLength, 3);
  assert.deepEqual(report.recurring, [
    {
      file: 'docs/a.md',
      rule: 'consistency',
      construct: 'shell fallback',
      severity: 'low',
      disposition: 'defer',
    },
  ]);
  assert.match(
    report.holdText ?? '',
    /docs\/a\.md consistency "shell fallback"/,
  );
});

test('a recurring High family emits the stop and the hold (#4129)', () => {
  const report = computeE10Recurrence([[HIGH_B], [HIGH_B], [HIGH_B]], 3);
  assert.equal(report.verdict, 'hold');
  assert.equal(report.recurring[0]?.disposition, 'stop');
  assert.match(report.holdText ?? '', /src\/b\.mts correctness "claim check"/);
});

test('zero findings on the third pass produce E11, not the hold (#4129)', () => {
  const report = computeE10Recurrence([[HIGH_B], [HIGH_B], []], 3);
  assert.equal(report.verdict, 'e11');
  assert.equal(report.holdText, null);
  const rejectedOnly = computeE10Recurrence(
    [[LOW_A], [LOW_A], [{ disposition: 'Rejected' }]],
    3,
  );
  assert.equal(rejectedOnly.verdict, 'e11');
});

test('two recurring passes stay below the default threshold', () => {
  const report = computeE10Recurrence([[HIGH_B], [HIGH_B]], 3);
  assert.equal(report.verdict, 'continue');
  assert.equal(report.chainLength, 2);
});

test('a proper subset extends the chain and a new fingerprint breaks it', () => {
  const subset = computeE10Recurrence(
    [[LOW_A, HIGH_B], [LOW_A, HIGH_B], [LOW_A]],
    3,
  );
  assert.equal(subset.verdict, 'defer');
  assert.equal(subset.chainLength, 3);
  const broken = computeE10Recurrence([[LOW_A], [LOW_A], [LOW_A, MEDIUM_C]], 3);
  assert.equal(broken.verdict, 'continue');
  assert.equal(broken.chainLength, 1);
  const emptyGap = computeE10Recurrence([[LOW_A], [], [LOW_A], [LOW_A]], 3);
  assert.equal(emptyGap.verdict, 'continue');
  assert.equal(emptyGap.chainLength, 2);
});

test('mixed Low and Medium families hold with per-family dispositions', () => {
  const report = computeE10Recurrence(
    [
      [LOW_A, MEDIUM_C],
      [LOW_A, MEDIUM_C],
      [LOW_A, MEDIUM_C],
    ],
    3,
  );
  assert.equal(report.verdict, 'hold');
  assert.deepEqual(
    report.recurring.map((family) => [family.construct, family.disposition]),
    [
      ['shell fallback', 'defer'],
      ['exit code', 'stop'],
    ],
  );
});

test('severity accepts the capitalized E4 tier (#4157 review)', () => {
  assert.deepEqual(
    validateDispositionRecord({ ...LOW_A, severity: 'Low' }),
    [],
  );
  const report = computeE10Recurrence(
    [
      [accepted('x', 'low'), { ...accepted('y', 'low'), severity: 'High' }],
      [accepted('x', 'low'), { ...accepted('y', 'low'), severity: 'High' }],
      [{ ...accepted('x', 'low'), severity: 'Low' }, accepted('y', 'high')],
    ],
    3,
  );
  assert.equal(report.verdict, 'hold');
  assert.deepEqual(
    report.recurring.map((family) => [family.construct, family.severity]),
    [
      ['x', 'low'],
      ['y', 'high'],
    ],
  );
});

test('a family keeps the highest severity seen in the chain', () => {
  const report = computeE10Recurrence(
    [[accepted('shell fallback', 'medium')], [LOW_A], [LOW_A]],
    3,
  );
  assert.equal(report.verdict, 'hold');
  assert.equal(report.recurring[0]?.severity, 'medium');
});

test('the fingerprint is file, rule, and construct, not severity', () => {
  const otherFile = computeE10Recurrence(
    [
      [accepted('x', 'low')],
      [accepted('x', 'low', 'consistency', 'docs/b.md')],
    ],
    2,
  );
  assert.equal(otherFile.chainLength, 1);
  const otherRule = computeE10Recurrence(
    [[accepted('x', 'low')], [accepted('x', 'low', 'style')]],
    2,
  );
  assert.equal(otherRule.chainLength, 1);
  const otherSeverity = computeE10Recurrence(
    [[accepted('x', 'high')], [accepted('x', 'low')]],
    2,
  );
  assert.equal(otherSeverity.chainLength, 2);
  const padded = computeE10Recurrence(
    [
      [accepted('x', 'low')],
      [accepted(' x ', 'low', 'consistency', ' docs/a.md')],
    ],
    2,
  );
  assert.equal(padded.chainLength, 2);
});

test('a disposition record whose rule is outside the closed list is rejected', () => {
  const errors = validateDispositionRecord(
    { ...LOW_A, rule: 'shell-fallback' },
    'r',
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0] ?? '',
    /rule "shell-fallback" is not in the closed list/,
  );
  assert.deepEqual(validateDispositionRecord(LOW_A), []);
  assert.deepEqual(validateDispositionRecord({ disposition: 'Rejected' }), []);
  assert.ok(validateDispositionRecord({ ...LOW_A, file: '' }).length > 0);
  assert.ok(validateDispositionRecord({ ...LOW_A, severity: 'x' }).length > 0);
  assert.ok(
    validateDispositionRecord({ ...LOW_A, disposition: 'x' }).length > 0,
  );
  assert.ok(validateDispositionRecord({ ...LOW_A, construct: ' ' }).length > 0);
  const { severity: _severity, ...noSeverity } = LOW_A;
  assert.ok(validateDispositionRecord(noSeverity).length > 0);
  assert.deepEqual(
    validateDispositionRecord({ disposition: 'Rejected', rule: 'other' }),
    [],
  );
  assert.deepEqual(validatePasses('x'), ['passes: must be an array of passes']);
  assert.deepEqual(validatePasses([]), [
    'passes: must contain at least one pass',
  ]);
  assert.deepEqual(validatePasses([{}]), [
    'passes[0]: must be an array of records',
  ]);
});

test('the triage instruction carries the same closed rule list', () => {
  const text = readFileSync(TRIAGE, 'utf8').replace(/\s+/g, ' ');
  const match = text.match(/one `rule`: ((?:`[a-z-]+`, )*`[a-z-]+`)\./);
  assert.ok(match, 'triage E5 fingerprint rule list not found');
  const listed = [...(match[1] ?? '').matchAll(/`([a-z-]+)`/g)].map(
    (entry) => entry[1],
  );
  assert.deepEqual(listed, [...E10_FINGERPRINT_RULES]);
});

function runCli(document: unknown, args: string[] = [], policy?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'idd-e10-recurrence-'));
  try {
    if (policy !== undefined) {
      mkdirSync(join(dir, '.github', 'idd'), { recursive: true });
      writeFileSync(
        join(dir, '.github', 'idd', 'config.json'),
        JSON.stringify(policy),
      );
    }
    const path = join(dir, 'passes.json');
    writeFileSync(path, JSON.stringify(document));
    return spawnSync(process.execPath, [SCRIPT, '--passes', path, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config') },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the CLI prints the verdict and uses the policy default threshold', () => {
  const result = runCli({ passes: [[LOW_A], [LOW_A], [LOW_A]] });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'defer');
  assert.equal(report.holdAfter, 3);
  const override = runCli({ passes: [[LOW_A], [LOW_A], [LOW_A]] }, [
    '--hold-after',
    '4',
  ]);
  assert.equal(JSON.parse(override.stdout).verdict, 'continue');
});

test('the CLI reads a configured e10NoProgressHoldAfter', () => {
  const result = runCli({ passes: [[HIGH_B], [HIGH_B]] }, [], {
    critiqueLoop: { e10NoProgressHoldAfter: 2 },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.holdAfter, 2);
  assert.equal(report.verdict, 'hold');
});

test('the CLI rejects a bad --hold-after and a document without passes', () => {
  const zero = runCli({ passes: [[LOW_A]] }, ['--hold-after', '0']);
  assert.equal(zero.status, 1);
  const missing = runCli({ pass: [[LOW_A]] });
  assert.equal(missing.status, 1);
  assert.match(
    JSON.parse(missing.stdout).errors[0],
    /passes: must be an array/,
  );
});

test('the CLI exits 1 on a rule outside the closed list', () => {
  const result = runCli({ passes: [[{ ...LOW_A, rule: 'other' }]] });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors[0], /closed list/);
});
