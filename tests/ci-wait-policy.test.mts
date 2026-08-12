import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CI_WAIT_POLICY,
  deriveRerunCountFromRunAttempt,
  normalizeCiWaitPolicy,
  parseDurationToMs,
  readCiWaitPolicy,
  resolveCiRerunDecision,
} from '../src/scripts/ci-wait-policy.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Stub `gh` on PATH -- the tests/gh-exec.test.mts pattern, reused here so
// the --run-id CLI tests below exercise the real execFileSync + child-
// process contract without network access. Returns a cleanup callback
// that restores PATH; callers must invoke it (ideally in a `finally`)
// even when the assertion throws.
function stubGh(scriptBody: string): () => void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-gh-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempRoot}:${originalPath ?? ''}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

test('parseDurationToMs parses CI wait durations', () => {
  assert.equal(parseDurationToMs('PT30M'), 30 * 60 * 1000);
  assert.equal(parseDurationToMs('PT10M'), 10 * 60 * 1000);
  assert.equal(parseDurationToMs('PT1H15M'), 75 * 60 * 1000);
  assert.equal(parseDurationToMs('invalid'), null);
});

test('parseDurationToMs rejects empty ISO duration tokens', () => {
  assert.equal(parseDurationToMs('P'), null);
  assert.equal(parseDurationToMs('PT'), null);
  assert.equal(parseDurationToMs('P1DT'), null);
});

test('normalizeCiWaitPolicy preserves distributed defaults when keys are omitted', () => {
  assert.deepEqual(normalizeCiWaitPolicy(), { ...DEFAULT_CI_WAIT_POLICY });
});

test('normalizeCiWaitPolicy accepts explicit ciWait overrides', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: 'PT45M',
      generationTimeout: 'PT12M',
      rerunPolicy: 'hold',
    }),
    {
      runningTimeout: 'PT45M',
      runningTimeoutMs: 45 * 60 * 1000,
      generationTimeout: 'PT12M',
      generationTimeoutMs: 12 * 60 * 1000,
      rerunPolicy: 'hold',
    },
  );
});

test('normalizeCiWaitPolicy falls back when override values are invalid', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: '45 minutes',
      generationTimeout: 'soon',
      rerunPolicy: 'rerun-forever',
    }),
    { ...DEFAULT_CI_WAIT_POLICY },
  );
});

test('normalizeCiWaitPolicy rejects empty ISO duration tokens', () => {
  assert.deepEqual(
    normalizeCiWaitPolicy({
      runningTimeout: 'P',
      generationTimeout: 'PT',
    }),
    { ...DEFAULT_CI_WAIT_POLICY },
  );
});

test('resolveCiRerunDecision allows only one automatic rerun by default', () => {
  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'rerun-once', rerunCount: 0 }),
    {
      action: 'rerun',
      reason: 'rerun-budget-available',
      rerunPolicy: 'rerun-once',
      rerunCount: 0,
    },
  );

  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'rerun-once', rerunCount: 1 }),
    {
      action: 'hold',
      reason: 'rerun-budget-exhausted',
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
    },
  );
});

test('resolveCiRerunDecision honors hold policy', () => {
  assert.deepEqual(
    resolveCiRerunDecision({ rerunPolicy: 'hold', rerunCount: 0 }),
    {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: 'hold',
      rerunCount: 0,
    },
  );
});

test('readCiWaitPolicy reads nested ciWait config and CLI emits the same resolution', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'hold',
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), {
    runningTimeout: 'PT40M',
    runningTimeoutMs: 40 * 60 * 1000,
    generationTimeout: 'PT15M',
    generationTimeoutMs: 15 * 60 * 1000,
    rerunPolicy: 'hold',
  });

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
        '--policy',
        configPath,
        '--rerun-count',
        '0',
      ],
      { encoding: 'utf8' },
    ),
  );

  assert.deepEqual(output, {
    policy: {
      runningTimeout: 'PT40M',
      runningTimeoutMs: 40 * 60 * 1000,
      generationTimeout: 'PT15M',
      generationTimeoutMs: 15 * 60 * 1000,
      rerunPolicy: 'hold',
    },
    rerunDecision: {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: 'hold',
      rerunCount: 0,
    },
  });
});

test('readCiWaitPolicy still honors ciWait when an unrelated top-level field is schema-invalid', (t) => {
  // #1359 regression: an unknown top-level key like `unsupportedTopLevelKey`
  // trips `additionalProperties: false` at the whole-document level, but
  // must not zero out an otherwise schema-valid ciWait section — validation
  // is scoped to ciWait's own subtree.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-invalid-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'hold',
        },
        unsupportedTopLevelKey: true,
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), {
    runningTimeout: 'PT40M',
    runningTimeoutMs: 40 * 60 * 1000,
    generationTimeout: 'PT15M',
    generationTimeoutMs: 15 * 60 * 1000,
    rerunPolicy: 'hold',
  });
});

test('readCiWaitPolicy falls back to defaults when its own ciWait section is schema-invalid', (t) => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-ci-wait-policy-own-invalid-'),
  );
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        iddVersion: '0.1.0',
        markerPrefix: 'idd-skill',
        mergePolicy: 'fully_autonomous_merge',
        reviewPolicy: 'copilot-advisory',
        threadResolutionPolicy: 'fast-agent-resolve',
        claimTiming: {
          staleAge: 'PT24H',
          heartbeatInterval: 'PT12H',
        },
        trustedMarkerActors: ['kurone-kito'],
        commands: {
          'install-deps': 'true',
          'fix-validate': 'true',
          'pre-push-validate': 'true',
          'post-fix-validate': 'true',
        },
        // Not in the ciWait.rerunPolicy schema enum (rerun-once | hold):
        // the ciWait subtree is itself invalid, so this still reverts.
        ciWait: {
          runningTimeout: 'PT40M',
          generationTimeout: 'PT15M',
          rerunPolicy: 'rerun-forever',
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), { ...DEFAULT_CI_WAIT_POLICY });
});

/** Run the built ci-wait-policy CLI expecting a non-zero exit, and return
 * its stderr. Mirrors tests/branch-name.test.mts's runCliExpectFailure:
 * asserting against error.stderr directly (rather than pattern-matching
 * assert.throws() against the thrown error's own .message) is the
 * established, robust pattern in this repo's CLI end-to-end tests --
 * execFileSync's thrown error's .message is documented as a
 * "Command failed: ..." wrapper string and is not guaranteed to embed
 * the child's stderr text (Copilot review finding on #1446 / PR #1459). */
function runCliExpectFailure(args: string[]): {
  status: number;
  stderr: string;
} {
  try {
    execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('expected the CLI to exit non-zero, but it succeeded');
  } catch (error) {
    const status = (error as { status?: number }).status;
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    assert.ok(
      typeof status === 'number' && status !== 0,
      `expected a non-zero exit status, got ${String(status)}`,
    );
    return { status: status as number, stderr };
  }
}

// #1446: --rerun-count migrated onto the shared cli-args.mts wrapper's
// "throw" integer contract (parseCanonicalIntegerOrThrow, min: 0). This
// exercises the CLI end-to-end to demonstrate the throw survives migration
// -- no earlier test in this file covered the invalid/negative CLI path.
test('CLI --rerun-count still throws on a non-negative-integer violation', () => {
  for (const rerunCount of ['-1', 'not-a-number', '3.5']) {
    const { stderr } = runCliExpectFailure([
      join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
      '--rerun-count',
      rerunCount,
    ]);
    assert.match(
      stderr,
      /invalid value for argument: --rerun-count/,
      `expected --rerun-count ${rerunCount} to throw with that message`,
    );
  }
});

test('CLI --rerun-count 0 does not throw (0 is a valid non-negative value)', () => {
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'), '--rerun-count', '0'],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(output.rerunDecision.rerunCount, 0);
});

// #1996: deriveRerunCountFromRunAttempt is the pure core of the --run-id
// derivation -- no `gh` call needed to exercise it directly.
test('deriveRerunCountFromRunAttempt: run_attempt 1 (never rerun) derives rerunCount 0', () => {
  assert.equal(deriveRerunCountFromRunAttempt(1), 0);
});

test('deriveRerunCountFromRunAttempt: run_attempt 2 (already rerun once) derives rerunCount 1', () => {
  assert.equal(deriveRerunCountFromRunAttempt(2), 1);
});

test('deriveRerunCountFromRunAttempt: rejects a missing/non-numeric/zero run_attempt (fail closed, never a silent 0)', () => {
  for (const runAttempt of [undefined, null, '2', 1.5, 0, -1, Number.NaN]) {
    assert.throws(
      () => deriveRerunCountFromRunAttempt(runAttempt),
      /cannot derive --rerun-count from run_attempt/,
      `expected run_attempt ${JSON.stringify(runAttempt)} to throw`,
    );
  }
});

// #1996: --run-id end-to-end CLI tests. Every case below passes explicit
// --owner/--repo so the stubbed `gh` only ever needs to answer the single
// `api repos/.../actions/runs/<id>` call, never `repo view` too.
test('CLI --run-id derives rerunCount from a live run_attempt: 1 -> action rerun', () => {
  const restore = stubGh(`
if (process.argv[2] === 'api') {
  process.stdout.write(JSON.stringify({ run_attempt: 1 }));
} else {
  process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
  process.exit(1);
}
`);
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
          '--run-id',
          '31631273987',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.rerunCountSource, 'run-id');
    assert.equal(output.runAttempt, 1);
    assert.deepEqual(output.rerunDecision, {
      action: 'rerun',
      reason: 'rerun-budget-available',
      rerunPolicy: 'rerun-once',
      rerunCount: 0,
    });
  } finally {
    restore();
  }
});

test('CLI --run-id derives rerunCount from a live run_attempt: 2 -> action hold (default rerun-once)', () => {
  const restore = stubGh(`
if (process.argv[2] === 'api') {
  process.stdout.write(JSON.stringify({ run_attempt: 2 }));
} else {
  process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
  process.exit(1);
}
`);
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
          '--run-id',
          '31631273987',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.rerunCountSource, 'run-id');
    assert.equal(output.runAttempt, 2);
    assert.deepEqual(output.rerunDecision, {
      action: 'hold',
      reason: 'rerun-budget-exhausted',
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
    });
  } finally {
    restore();
  }
});

test('CLI --run-id exits non-zero on a missing/non-numeric run_attempt with no --rerun-count fallback (graceful failure, never a silent rerunCount: 0)', () => {
  const restore = stubGh(`
if (process.argv[2] === 'api') {
  process.stdout.write(JSON.stringify({ conclusion: 'success' }));
} else {
  process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
  process.exit(1);
}
`);
  try {
    const { stderr } = runCliExpectFailure([
      join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
      '--run-id',
      '31631273987',
      '--owner',
      'kurone-kito',
      '--repo',
      'idd-skill',
    ]);
    assert.match(stderr, /--run-id 31631273987 lookup failed/);
    assert.match(stderr, /cannot derive --rerun-count from run_attempt/);
  } finally {
    restore();
  }
});

test('CLI --run-id falls back to an explicit --rerun-count when the live lookup itself fails (gh api error)', () => {
  const restore = stubGh(`
if (process.argv[2] === 'api') {
  process.stderr.write('gh: Not Found (HTTP 404)');
  process.exit(1);
} else {
  process.stderr.write('unexpected gh invocation: ' + process.argv.slice(2).join(' '));
  process.exit(1);
}
`);
  try {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
          '--run-id',
          '31631273987',
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
          '--rerun-count',
          '1',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.rerunCountSource, 'rerun-count');
    assert.ok(
      typeof output.runIdLookupError === 'string' &&
        output.runIdLookupError.length > 0,
      'expected runIdLookupError to report why the live lookup failed',
    );
    assert.equal(output.runAttempt, undefined);
    assert.deepEqual(output.rerunDecision, {
      action: 'hold',
      reason: 'rerun-budget-exhausted',
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
    });
  } finally {
    restore();
  }
});

test('CLI --owner without --repo (or vice versa) throws -- both-or-neither', () => {
  for (const args of [
    ['--run-id', '1', '--owner', 'kurone-kito'],
    ['--run-id', '1', '--repo', 'idd-skill'],
  ]) {
    const { stderr } = runCliExpectFailure([
      join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
      ...args,
    ]);
    assert.match(stderr, /--owner and --repo must be given together/);
  }
});

// #1996 output-shape backward compatibility (Fix #1 from the design
// review): a --rerun-count-only invocation (no --run-id) must keep
// producing the EXACT pre-#1996 {policy, rerunDecision} shape, with none
// of the new --run-id-only fields present -- this is what lets the
// existing 'readCiWaitPolicy reads nested ciWait config and CLI emits the
// same resolution' test's deepEqual keep passing unmodified.
test('CLI --rerun-count-only output omits every --run-id-only field (backward-compatible shape)', () => {
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'), '--rerun-count', '1'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(Object.keys(output).sort(), ['policy', 'rerunDecision']);
});
