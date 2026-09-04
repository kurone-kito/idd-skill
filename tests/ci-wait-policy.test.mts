import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  evaluateSiblingWorkflowSweep,
  normalizeCiWaitPolicy,
  normalizeFailureClass,
  parseDurationToMs,
  readCiWaitPolicy,
  resolveCiRerunDecision,
} from '../src/scripts/ci-wait-policy.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Stub `gh` on PATH -- the tests/gh-exec.test.mts pattern, reused here so
// the --run-id CLI tests below exercise the real execFileSync + child-
// process contract without network access. Returns a cleanup callback
// that restores PATH; callers must invoke it (ideally in a `finally`)
// even when the assertion throws.
function stubGh(scriptBody: string): () => void {
  return stubExecutable('gh', scriptBody);
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

test('resolveCiRerunDecision grants one evidence-gated extra rerun (#1997)', () => {
  const siblingSweep = {
    query: 'gh run list --workflow="Pnpm boundary guard" --limit 15',
    allOthersSucceeded: true,
    otherCount: 3,
    otherConclusions: ['success', 'success', 'success'],
  };
  const decision = resolveCiRerunDecision({
    rerunPolicy: 'rerun-once',
    rerunCount: 1,
    failureClass: 'timed_out',
    siblingSweep,
  });
  assert.equal(decision.action, 'rerun');
  assert.equal(decision.reason, 'evidence-gated-extra-rerun');
  assert.equal(decision.hatch?.applied, true);
  assert.equal(decision.hatch?.failureClass, 'timeout');
});

test('resolveCiRerunDecision withholds the #1997 hatch without corroboration', () => {
  const noSiblings = {
    query: 'gh run list --workflow="Pnpm boundary guard" --limit 15',
    allOthersSucceeded: false,
    otherCount: 0,
    otherConclusions: [] as string[],
  };
  assert.equal(
    resolveCiRerunDecision({
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
      failureClass: 'timeout',
      siblingSweep: noSiblings,
    }).reason,
    'rerun-budget-exhausted',
  );
  const siblingFailed = {
    ...noSiblings,
    allOthersSucceeded: false,
    otherCount: 2,
    otherConclusions: ['success', 'failure'],
  };
  assert.equal(
    resolveCiRerunDecision({
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
      failureClass: 'cancelled',
      siblingSweep: siblingFailed,
    }).hatch?.applied,
    false,
  );
  assert.equal(
    resolveCiRerunDecision({
      rerunPolicy: 'rerun-once',
      rerunCount: 1,
      failureClass: 'failure',
      siblingSweep: {
        ...noSiblings,
        allOthersSucceeded: true,
        otherCount: 2,
        otherConclusions: ['success', 'success'],
      },
    }).reason,
    'rerun-budget-exhausted',
  );
  assert.equal(
    resolveCiRerunDecision({
      rerunPolicy: 'rerun-once',
      rerunCount: 2,
      failureClass: 'timeout',
      siblingSweep: {
        ...noSiblings,
        allOthersSucceeded: true,
        otherCount: 2,
        otherConclusions: ['success', 'success'],
      },
    }).reason,
    'rerun-budget-exhausted',
  );
});

test('evaluateSiblingWorkflowSweep requires a same-window successful other run', () => {
  const center = Date.parse('2026-08-12T12:00:00Z');
  const query = 'gh run list --workflow="Pnpm boundary guard" --limit 15';
  const sweep = evaluateSiblingWorkflowSweep(
    [
      {
        id: '1',
        status: 'completed',
        conclusion: 'timed_out',
        createdAt: '2026-08-12T12:00:00Z',
      },
      {
        id: '2',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-08-12T12:20:00Z',
      },
    ],
    {
      currentRunId: '1',
      windowStartMs: center - 60 * 60 * 1000,
      windowEndMs: center + 60 * 60 * 1000,
      query,
    },
  );
  assert.equal(sweep.allOthersSucceeded, true);
  assert.equal(sweep.otherCount, 1);
  assert.deepEqual(sweep.otherConclusions, ['success']);
  assert.equal(sweep.query, query);
});

test('normalizeFailureClass maps GitHub timed_out/cancelled conclusions', () => {
  assert.equal(normalizeFailureClass('timed_out'), 'timeout');
  assert.equal(normalizeFailureClass('CANCELLED'), 'cancelled');
  assert.equal(normalizeFailureClass('failure'), null);
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

// #1996 C1 critique (Copilot review, PR #1998): a run id above
// Number.MAX_SAFE_INTEGER must reach the `gh api` call byte-for-byte, not
// silently rounded by a Number round-trip (e.g. 9007199254740993 would
// become 9007199254740992). Captures the exact argv the stub received to
// prove the digits survive unmodified.
test('CLI --run-id preserves a run id above Number.MAX_SAFE_INTEGER exactly (no precision loss)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-ci-wait-policy-run-id-'));
  const argsFile = join(tempRoot, 'args.json');
  const unsafeRunId = '9007199254740993'; // MAX_SAFE_INTEGER (2^53-1) + 2
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ run_attempt: 1 }));
`);
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
        '--run-id',
        unsafeRunId,
        '--owner',
        'kurone-kito',
        '--repo',
        'idd-skill',
      ],
      { encoding: 'utf8' },
    );
    const capturedArgv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    assert.deepEqual(capturedArgv, [
      'api',
      `repos/kurone-kito/idd-skill/actions/runs/${unsafeRunId}`,
    ]);
  } finally {
    restore();
  }
});

// #1996 C1 critique (Copilot review, PR #1998, suppressed comment): the
// prior version of this test passed ONLY --run-id, so it could not
// distinguish "--run-id wins on a successful lookup" from "--rerun-count
// was simply never given" -- the two "falls back" tests below only prove
// --rerun-count wins when the lookup FAILS, leaving the success-path
// precedence rule unproven. Also passing a CONFLICTING --rerun-count 1
// here (which would produce action: 'hold' if it won instead) makes the
// action: 'rerun' / rerunCount: 0 assertions below actually prove
// --run-id's live lookup took precedence.
test('CLI --run-id derives rerunCount from a live run_attempt: 1 -> action rerun (wins over a conflicting --rerun-count on success)', () => {
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
          '--rerun-count',
          '1',
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

// #1996 C1 critique regression: the owner/repo auto-detection (`gh repo
// view`, used when --owner/--repo are omitted) must sit INSIDE the same
// try/fallback as the run lookup itself -- a caller can give --run-id with
// neither --owner nor --repo, and a failure resolving either must fall
// back to an explicit --rerun-count exactly like a failed run-id lookup
// does, not crash uncaught. This test omits --owner/--repo entirely so the
// stub's `gh repo view` call is what fails.
test('CLI --run-id falls back to --rerun-count when owner/repo auto-detection itself fails (not just the run lookup)', () => {
  const restore = stubGh(`
if (process.argv[2] === 'repo' && process.argv[3] === 'view') {
  process.stderr.write('gh: authentication required');
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
          '--rerun-count',
          '0',
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(output.rerunCountSource, 'rerun-count');
    assert.ok(
      typeof output.runIdLookupError === 'string' &&
        output.runIdLookupError.length > 0,
      'expected runIdLookupError to report the owner/repo auto-detection failure',
    );
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

// #1996 E2 critique pass (independent subagent review, PR #1998): every
// other --run-id success test above passes explicit --owner/--repo, and
// the only auto-detection test exercises the FAILURE path (gh repo view
// itself failing) -- nothing proved the composed
// repos/{owner}/{repo}/actions/runs/{run-id} path is correct when
// owner/repo come from auto-detection rather than flags. This test omits
// --owner/--repo entirely, has the stub answer both `gh repo view` calls
// (--json owner and --json name) plus the run lookup, and captures the
// final `gh api` call's argv to prove the auto-detected values were
// composed into the URL correctly.
test('CLI --run-id auto-detects --owner/--repo via gh repo view and composes the correct API path', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-ci-wait-policy-autodetect-'),
  );
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
if (process.argv[2] === 'repo' && process.argv[3] === 'view' && process.argv[5] === 'owner') {
  process.stdout.write('kurone-kito');
} else if (process.argv[2] === 'repo' && process.argv[3] === 'view' && process.argv[5] === 'name') {
  process.stdout.write('idd-skill');
} else if (process.argv[2] === 'api') {
  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
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
        ],
        { encoding: 'utf8' },
      ),
    );
    const capturedArgv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    assert.deepEqual(capturedArgv, [
      'api',
      'repos/kurone-kito/idd-skill/actions/runs/31631273987',
    ]);
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

// #1996 C1 critique: --owner/--repo validated against the same
// conservative GitHub-identifier character class
// rerun-advisory-convergence.mts already applies to the identical flags,
// rejecting whitespace/shell-metacharacter values before they reach the
// `gh api repos/{owner}/{repo}/...` path.
test('CLI --owner/--repo reject values outside the GitHub identifier character class', () => {
  for (const args of [
    ['--run-id', '1', '--owner', 'invalid owner', '--repo', 'idd-skill'],
    ['--run-id', '1', '--owner', 'kurone-kito', '--repo', 'idd;skill'],
  ]) {
    const { stderr } = runCliExpectFailure([
      join(REPO_ROOT, 'scripts/ci-wait-policy.mjs'),
      ...args,
    ]);
    assert.match(
      stderr,
      /must contain only letters, digits, hyphens, underscores, or periods/,
    );
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
