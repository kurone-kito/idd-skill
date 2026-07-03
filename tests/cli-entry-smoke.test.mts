import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_SCRIPTS = fileURLToPath(new URL('../src/scripts/', import.meta.url));

// ---------------------------------------------------------------------------
// Module-eval-order guard
//
// A helper whose `if (isMainModule(import.meta.url)) { … }` or
// `if (isCliExecution(import.meta.url)) { … }` CLI entry block runs before a
// module-level `const`/`let`/`var` it (transitively) reads throws a TDZ
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
 * three real signatures — an `isMainModule(` call, an `isCliExecution(` call,
 * or a `process.argv[1]` reference — rather than any `import.meta.url`
 * mention, so an unrelated top-level `if` that merely references
 * `import.meta.url` is not mistaken for the entry block.
 */
const ENTRY_GUARD =
  /^if \(.*(?:isMainModule\(|isCliExecution\(|process\.argv\[1\]).*\)\s*\{/;

/**
 * Matches a module-level (column 0) `const`/`let`/`var` binding opener,
 * excluding `const enum` — a type-level declaration erased at compile time, so
 * it carries no runtime TDZ (exempt like `interface`/`type`).
 */
const MODULE_LEVEL_BINDING = /^(?:export )?(?:const(?!\s+enum\b)|let|var)\b/;

/**
 * Report every module-level initialized `const`/`let`/`var` that appears
 * textually after a CLI entry-guard block. Pure (no I/O): each file is
 * `{ path, text }`. Returns human-readable `path:line` violation strings.
 */
function findModuleEvalOrderViolations(
  files: readonly { path: string; text: string }[],
): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/);
    const entryIndex = lines.findIndex((line) => ENTRY_GUARD.test(line));
    if (entryIndex < 0) {
      continue;
    }
    for (let i = entryIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      // Require a single `=` assignment operator (excluding `==`/`!=`/`<=`/`>=`
      // and the `=>` arrow via lookbehind/lookahead) so a bare `let x;` is not
      // flagged. The lookarounds — rather than requiring a trailing character —
      // still match a line ending in `=` (a multi-line initializer whose value
      // is on the next line). `const enum`, whose members may use `=`, is
      // already excluded by MODULE_LEVEL_BINDING. Column 0 excludes bindings
      // nested inside the block or a function.
      if (
        MODULE_LEVEL_BINDING.test(line) &&
        /(?<![=!<>])=(?![=>])/.test(line)
      ) {
        violations.push(
          `${path}:${i + 1}: module-level binding initialized after the CLI entry ` +
            `block (opened at line ${entryIndex + 1}) — top-level-await TDZ risk; ` +
            `declare it above the block. Offending line: ${line.trim()}`,
        );
      }
    }
  }
  return violations;
}

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

test('module-eval-order guard flags an initialized const after an isCliExecution() entry block', () => {
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

test('every src/scripts/*.mts helper keeps module-level bindings above its CLI entry block', () => {
  const files = readdirSync(SRC_SCRIPTS)
    .filter((name) => name.endsWith('.mts'))
    .map((name) => ({
      path: `src/scripts/${name}`,
      text: readFileSync(join(SRC_SCRIPTS, name), 'utf8'),
    }));
  const violations = findModuleEvalOrderViolations(files);
  assert.deepEqual(
    violations,
    [],
    `CLI-entry-order TDZ risk(s) found:\n${violations.join('\n')}`,
  );
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-discover-readiness-cli-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
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
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  chmodSync(ghPath, 0o755);

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
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
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
});

test('discover-viability-gate.mjs CLI runs the entry path without a load-time ReferenceError', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-discover-viability-cli-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
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
  chmodSync(ghPath, 0o755);

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
      env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH ?? ''}` },
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
    'Usage:\n  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--now <ISO8601>]\n',
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
});

test('audit-pr-cleanup.mjs without --pr fails before any gh invocation', () => {
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/audit-pr-cleanup.mjs')],
        { encoding: 'utf8', timeout: 60_000 },
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
