import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findGuardUnreachableEntries,
  findModuleEvalOrderViolations,
} from '../src/scripts/lint-source-contracts.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// Module-eval-order guard
//
// A helper whose `if (isMainModule(import.meta.url)) { … }` or
// `if (isCliExecution(import.meta.url)) { … }` CLI entry block runs before a
// module-level `const`/`let`/`var` that it (transitively) reads throws a TDZ
// `ReferenceError: Cannot access 'X' before initialization` on the CLI path
// only — a top-level `await` inside the block parks module evaluation there, so
// a later lexical binding is still in its temporal dead zone. Import-only tests
// never reach the entry path, so CI stays green while the CLI crashes.
//
// The guard flags ONLY an initialized module-level `const`/`let`/`var` that
// appears textually AFTER the entry block. `function` / `interface` / `type`
// declarations are exempt (hoisted or type-only), so the ~two-thirds of helpers
// that intentionally place the block near the top and rely on function hoisting
// are not flagged. It does NOT require the block to be the last statement.
// ---------------------------------------------------------------------------

/**
 * Matches a top-level CLI entry-guard opener at column 0. Anchored to the
 * four real signatures — an `isMainModule(` call, an `isCliExecution(`
 * call, a `process.argv[1]` reference, or `import.meta.main` (#1447) —
 * rather than any `import.meta.url` mention, so an unrelated top-level
 * `if` that merely references `import.meta.url` is not mistaken for the
 * entry block. `isMainModule(`/`isCliExecution(`/`process.argv[1]` no
 * longer appear under `src/` after #1447, but stay recognized here so the
 * guard above (and its own unit tests) still cover the legacy shapes.
 */
const readModule = (path: string, text: string) => ({ path, text });

test('module-eval-order guard flags an initialized const after the entry block', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        "import { isMainModule } from './x.mts';",
        'if (isMainModule(import.meta.url)) {',
        '  await run(LATE);',
        '}',
        'const LATE = new Set([1, 2, 3]);',
        '',
      ].join('\n'),
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.mts:5:.*after the CLI entry block/);
});

test('module-eval-order guard flags an initialized const after an isCliExecution(import.meta.url) entry block', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        "import { isCliExecution } from './gh-exec.mts';",
        'if (isCliExecution(import.meta.url)) {',
        '  await run(LATE);',
        '}',
        'const LATE = new Set([1, 2, 3]);',
        '',
      ].join('\n'),
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.mts:5:.*after the CLI entry block/);
});

test('module-eval-order guard flags an initialized const after an import.meta.main entry block (#1447)', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (import.meta.main) {',
        '  await run(LATE);',
        '}',
        'const LATE = new Set([1, 2, 3]);',
        '',
      ].join('\n'),
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.mts:4:.*after the CLI entry block/);
});

test('module-eval-order guard does NOT flag an unrelated top-level if that merely mentions import.meta.url', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (someCondition(import.meta.url)) {',
        '  await run();',
        '}',
        'const LATE = new Set([1, 2, 3]);',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

test('module-eval-order guard flags a multi-line initializer whose line ends in `=`', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (isMainModule(import.meta.url)) {',
        '  await run(LATE);',
        '}',
        'const LATE =',
        '  new Set([1, 2, 3]);',
        '',
      ].join('\n'),
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.mts:4:/);
});

test('module-eval-order guard flags let and var too, and reports each', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (process.argv[1] === fileURLToPath(import.meta.url)) {',
        '  await run();',
        '}',
        'let LATE_LET = 1;',
        'var LATE_VAR = 2;',
        '',
      ].join('\n'),
    ),
  ]);
  assert.equal(violations.length, 2);
});

test('module-eval-order guard does NOT flag a function/interface/type after the block (hoisted)', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (isMainModule(import.meta.url)) {',
        '  await run();',
        '}',
        'export function run(): void {}',
        'interface Shape { a: number }',
        'type Alias = string;',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

test('module-eval-order guard does NOT flag a const enum after the block (type-level, erased)', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (isMainModule(import.meta.url)) {',
        '  await run();',
        '}',
        'const enum Direction { Up = 1, Down = 2 }',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

test('module-eval-order guard does NOT require the entry block to be last', () => {
  // The block sits near the top with only hoisted functions after it — the
  // common shape — and a const declared BEFORE the block is fine.
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'const EARLY = 1;',
        'if (isMainModule(import.meta.url)) {',
        '  await run(EARLY);',
        '}',
        'function run(x: number): void {}',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

test('module-eval-order guard ignores a binding indented inside the block', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'if (isMainModule(import.meta.url)) {',
        '  const local = 1;',
        '  await run(local);',
        '}',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

test('module-eval-order guard is a no-op for a module with no entry block', () => {
  const violations = findModuleEvalOrderViolations([
    readModule(
      'src/scripts/sample.mts',
      [
        'export const X = 1;',
        'export function f(): number { return X; }',
        '',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// node-runtime-guard reachability guard (#3240)
//
// `import.meta.main` is `undefined` -- not `false` -- on a Node release
// that predates it, so a CLI entry block's `if (import.meta.main)` guard
// is simply falsy there: the helper exits 0 without ever running its
// body, instead of failing loudly on an unsupported runtime. Every
// entry-block file must statically reach node-runtime-guard.mts through
// its relative-import closure, so importing it always runs
// assertEntrySignal() before the entry block can execute. A dynamic
// `import()` is deliberately excluded from the scanned specifier shape:
// it resolves too late, after module evaluation (and so the entry block)
// may already be underway, to satisfy this contract.
// ---------------------------------------------------------------------------

const GUARD_FILE_NAME = 'node-runtime-guard.mts';

test('the guard-unreachable scan flags a synthetic entry-block file that imports nothing', () => {
  const files = new Map([
    ['synthetic-entry.mts', 'if (import.meta.main) {\n  run();\n}\n'],
    [GUARD_FILE_NAME, '// guard\n'],
  ]);
  const violations = findGuardUnreachableEntries(
    files,
    ['synthetic-entry.mts'],
    GUARD_FILE_NAME,
  );
  assert.deepEqual(violations, ['synthetic-entry.mts']);
});

test('the guard-unreachable scan does NOT flag a synthetic entry file that reaches the guard transitively', () => {
  const files = new Map([
    [
      'synthetic-entry.mts',
      "import './middle.mts';\nif (import.meta.main) {\n  run();\n}\n",
    ],
    ['middle.mts', `import './${GUARD_FILE_NAME}';\n`],
    [GUARD_FILE_NAME, '// guard\n'],
  ]);
  const violations = findGuardUnreachableEntries(
    files,
    ['synthetic-entry.mts'],
    GUARD_FILE_NAME,
  );
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// CLI-subprocess smoke test — the entry path actually runs
//
// Import-only tests never evaluate the `isMainModule` block, so they cannot
// catch a load-time crash on the CLI path. Spawn the built helper with a
// stubbed `gh` on PATH so it reaches the real entry path and assert it produces
// its JSON envelope without a load-time `ReferenceError`.
// ---------------------------------------------------------------------------

test('discover-readiness-check.mjs CLI runs the entry path without a load-time ReferenceError', () => {
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
// buildIssueLoader: gh api repos/o/r/issues/900 --jq .
if (args[0] === 'api' && args[1] === 'repos/o/r/issues/900') {
  process.stdout.write(JSON.stringify({
    number: 900,
    title: 'readiness smoke issue',
    state: 'open',
    body: 'A ready issue with no blockers.',
    labels: [],
  }));
  process.exit(0);
}
// fetchIssueLabelEvents: gh api repos/o/r/issues/900/timeline?...
if (args[0] === 'api' && String(args[1]).startsWith('repos/o/r/issues/900/timeline')) {
  process.stdout.write('[]');
  process.exit(0);
}
// #2243 triage-verdict marker scan. #3590 adds explicit per_page=100
// on the plain REST comment read, so match the path prefix.
if (args[0] === 'api' && String(args[1]).startsWith('repos/o/r/issues/900/comments')) {
  process.stdout.write('[]');
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/discover-readiness-check.mjs'),
        '--issue',
        '900',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env },
        // Fail fast instead of hanging the suite if the CLI ever blocks on an
        // unexpected read (the stub gh answers or exits non-zero for every call).
        timeout: 60_000,
      },
    );

    assert.doesNotMatch(
      output,
      /ReferenceError|before initialization/,
      'CLI output must not carry a load-time ReferenceError',
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.summary.readyCount, 1);
    assert.equal(parsed.ready[0].number, 900);
  } finally {
    restore();
  }
});

test('discover-viability-gate.mjs CLI runs the entry path without a load-time ReferenceError', () => {
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
// buildIssueLoader: gh api repos/o/r/issues/901 --jq .
if (args[0] === 'api' && args[1] === 'repos/o/r/issues/901') {
  process.stdout.write(JSON.stringify({
    number: 901,
    title: 'viability smoke issue',
    state: 'open',
    // Wording clears all three A4 criteria (narrow scope + objective
    // verification + no external coordination) so the issue lands in "viable".
    body: 'A targeted single-file change verified by tests and acceptance criteria.',
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/discover-viability-gate.mjs'),
        '--issue',
        '901',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env },
        // Fail fast instead of hanging the suite if the CLI ever blocks on an
        // unexpected read (the stub gh answers or exits non-zero for every call).
        timeout: 60_000,
      },
    );

    assert.doesNotMatch(
      output,
      /ReferenceError|before initialization/,
      'CLI output must not carry a load-time ReferenceError',
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.summary.viableCount, 1);
    assert.equal(parsed.viable[0].number, 901);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// #1210 — CLI-subprocess smoke tests for the three isCliExecution()-guarded
// helpers (advisory-wait-state, review-activity-snapshot, audit-pr-cleanup).
//
// Unlike the two smoke tests above, --help and the missing-required-arg path
// in all three binaries return before any `gh` invocation (verified by
// reading the source), so no stubbed `gh` on PATH is needed here. These pin
// the exact pre-existing stdout/stderr/exit-code behavior byte-for-byte
// across the isCliExecution() refactor.
// ---------------------------------------------------------------------------

for (const [binary, helpText] of [
  [
    'advisory-wait-state.mjs',
    'Usage:\n  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--claim-id <id> --agent-id <id>] [--now <ISO8601>]\n\n--claim-id / --agent-id are OPTIONAL (#1572): when both are supplied, the\ncopilotRecovery section in the output binds recovery-cycle accounting and the\nterminal clock to that active claim. When either is absent, copilotRecovery\nfails closed to NOT_TERMINAL with reason: active-claim-not-provided.\n',
  ],
  [
    'review-activity-snapshot.mjs',
    'Usage:\n  node scripts/review-activity-snapshot.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>]\n',
  ],
] as const) {
  test(`${binary} --help prints usage and exits 0`, () => {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', binary), '--help'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(output, helpText);
  });

  test(`${binary} without --pr fails before any gh invocation`, () => {
    assert.throws(
      () => {
        execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', binary)], {
          encoding: 'utf8',
          timeout: 60_000,
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      (error: unknown) => {
        const status = (error as { status?: unknown }).status;
        const stderr = String((error as { stderr?: unknown }).stderr ?? '');
        assert.equal(status, 1);
        assert.match(stderr, /Error: missing required --pr <number> argument/);
        assert.doesNotMatch(stderr, /ReferenceError|before initialization/);
        return true;
      },
    );
  });
}

test('audit-pr-cleanup.mjs --help prints usage and exits 0', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/audit-pr-cleanup.mjs'), '--help'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(output, /^usage: node scripts\/audit-pr-cleanup\.mjs/);
  assert.match(output, /--claim-issue <number>/);
  assert.match(output, /--time-budget-seconds <n>/);
});

test('audit-pr-cleanup.mjs without --pr fails before any gh invocation', () => {
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/audit-pr-cleanup.mjs'),
          // Without an explicit repository the helper asks `gh` to detect one
          // before it checks --pr, so name it: that keeps this test true to
          // its title and, with this repository's own config enabling load
          // control (#3702), out of the real host-local state directory.
          '--owner',
          'kurone-kito',
          '--repo',
          'idd-skill',
        ],
        {
          encoding: 'utf8',
          timeout: 60_000,
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    },
    (error: unknown) => {
      const status = (error as { status?: unknown }).status;
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      assert.equal(status, 2);
      assert.match(stderr, /^error: missing required --pr <number>/);
      assert.doesNotMatch(stderr, /ReferenceError|before initialization/);
      return true;
    },
  );
});

// #1450: merged-pr-feedback-sweep.mjs had no --help at all before this
// migration (--help threw "unknown argument: --help"); the issue's
// acceptance criteria require it to print usage and exit 0 instead.
test('merged-pr-feedback-sweep.mjs --help prints usage and exits 0', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/merged-pr-feedback-sweep.mjs'), '--help'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(
    output,
    /^Usage:\n {2}node scripts\/merged-pr-feedback-sweep\.mjs/,
  );
  assert.match(output, /--prs <n1,n2,\.\.\.>/);
});
