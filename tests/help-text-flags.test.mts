import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Why this test exists (#1676)
//
// An audit of accepted review findings across every merged PR counted 12
// findings in 10 PRs (PR >= 1200) where a helper's --help text disagreed
// with its actual flag parser: a flag documented but not accepted, or a flag
// accepted but undocumented. tests/flag-name-matrix.test.mts does not catch
// this class -- it asserts that shared *concepts* use one canonical flag
// spelling ACROSS helpers, never that a single helper's own --help output
// agrees with that same helper's own declared flag spec.
//
// Rendering choice: this test spawns each covered helper's *compiled*
// scripts/<name>.mjs with --help and captures real stdout, rather than
// statically parsing the printHelp() template literal. Every covered
// helper's --help path returns before any gh/network I/O (the shared
// cli-args.mts contract checks `args.help` first; two of these helpers'
// exact --help bytes are already pinned in tests/cli-entry-smoke.test.mts),
// so spawning is a fast, dependency-free subprocess call that also exercises
// the real compiled artifact, matching that same file's shelling-out
// convention for --help output.
//
// Declared-flag extraction reads the *source* src/scripts/<name>.mts (not
// the compiled .mjs -- flag-name-matrix.test.mts already covers the .mjs
// text-scan style) because "declared flag spec" is naturally a source-level
// concept; the two compile 1:1, so this makes no observable difference.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcScriptsDir = join(REPO_ROOT, 'src', 'scripts');
const scriptsDir = join(REPO_ROOT, 'scripts');

function readSource(helper: string): string {
  return readFileSync(join(srcScriptsDir, `${helper}.mts`), 'utf8');
}

function hasFlagSpec(src: string): boolean {
  return /_FLAG_SPEC\s*=\s*\{/.test(src);
}

function hasPrintHelp(src: string): boolean {
  return /^function printHelp\(/m.test(src);
}

/**
 * Extracts the body of the first `const <NAME>_FLAG_SPEC = { ... } as
 * const;` declaration in `src`. Every covered helper's spec closes with the
 * literal `} as const;` on its own line -- verified across all 23 helpers
 * below, and enforced structurally by TypeScript (the `as const` assertion
 * is what makes `parseCliArgs`'s generic flag-name inference work).
 */
function extractFlagSpecBlock(src: string, helper: string): string {
  const match = src.match(/_FLAG_SPEC\s*=\s*\{([\s\S]*?)\n\} as const;/);
  assert.ok(match, `${helper}: no *_FLAG_SPEC = { ... } as const; block found`);
  return match[1];
}

/**
 * Declared flag names are object keys in the FLAG_SPEC block: a quoted
 * dashed literal immediately followed by `:`, e.g. `'--pr': { ... }`. This
 * deliberately requires the quote+colon shape (not a bare substring scan
 * like flag-name-matrix.test.mts's `includesQuotedFlag`) so a flag name
 * that happens to appear inside a `default:` value string is never
 * mistaken for a declared key.
 */
function extractDeclaredFlags(specBlock: string): Set<string> {
  const flags = new Set<string>();
  const flagKeyPattern = /^\s*['"](--[a-z0-9][a-z0-9-]*)['"]\s*:/gm;
  let match: RegExpExecArray | null = flagKeyPattern.exec(specBlock);
  while (match !== null) {
    flags.add(match[1]);
    match = flagKeyPattern.exec(specBlock);
  }
  return flags;
}

/**
 * Documented flag names are every `--dashed-token` substring in the
 * rendered --help output (Usage line and prose both -- some helpers, e.g.
 * pre-merge-readiness's deprecated-alias note, document a flag only in
 * prose after the Usage line).
 */
function extractDocumentedFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  const flagTokenPattern = /--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g;
  let match: RegExpExecArray | null = flagTokenPattern.exec(helpText);
  while (match !== null) {
    flags.add(match[0]);
    match = flagTokenPattern.exec(helpText);
  }
  return flags;
}

// `--help`/`-h` is declared identically (`{ type: 'boolean', short: 'h' }`)
// in every covered helper's own FLAG_SPEC -- cli-args.mts's `parseCliArgs`
// only exposes `values.help` when the caller's own spec includes a --help
// entry (see its CliParseResult doc comment), so this is boilerplate
// repeated per-helper, not something the wrapper silently injects. It is
// still excluded here: it is not a member of the drift class this test
// targets (the 12 findings the issue cites were flags that misled a caller
// mid-use; nobody is misled about --help working, since invoking it is how
// they read the text in the first place), and because it is the same
// boilerplate literal in all 23 specs, comparing it against per-helper prose
// would mostly test whether that shared boilerplate line happens to also be
// echoed in the Usage line, not real per-helper drift. 9 of the 23 covered
// helpers already mention `[--help]` in their Usage line and 14 don't;
// standardizing that is a legitimate, separate follow-up, not this test's
// concern.
const UNIVERSAL_FLAGS = new Set(['--help']);

// Per-helper allowlist for a flag literal that appears in --help prose but
// belongs to a DIFFERENT command -- cited as a cross-reference or worked
// example, not documentation of this helper's own parser. Each entry names
// the owning command so the exclusion stays auditable.
const CROSS_REFERENCE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'claim-lock': [
    // `git rev-parse --absolute-git-dir` -- a git flag, not claim-lock's own.
    '--absolute-git-dir',
    // resume-claim-routing.mjs's own flag, cited as a cross-tool example of
    // how to re-verify claim state before an authorized takeover.
    '--fresh-claim-gate',
  ],
  'verify-install-deps': [
    // Part of the `pnpm install ...` string passed as the *value* of this
    // helper's own --install-command in the worked example, not a flag
    // verify-install-deps.mjs itself parses.
    '--frozen-lockfile',
  ],
};

// Explicit covered-helper list (mirrors tests/flag-name-matrix.test.mts's
// `helpers` style): every src/scripts/*.mts helper that declares BOTH a
// FLAG_SPEC-style object and a printHelp() function, built by hand rather
// than by silent discovery. 23 helpers currently qualify.
const COVERED_HELPERS = [
  'advisory-convergence',
  'advisory-wait-state',
  'branch-name',
  'ci-wait-policy',
  'ci-wait-state',
  'claim-approval-gate',
  'claim-lock',
  'discover-readiness-check',
  'discover-shared-file-overlap',
  'discover-viability-gate',
  'helper-runtime-manifest',
  'idd-roadmap-audit-execute',
  'merged-pr-feedback-sweep',
  'phase-id-resolver',
  'pre-merge-readiness',
  'resume-claim-routing',
  'resume-route-selection',
  'review-activity-snapshot',
  'review-disposition-verify',
  'select-desynced-index',
  'stalled-session-quiet-check',
  'suitability-triage',
  'verify-install-deps',
] as const;

// Every other src/scripts/*.mts helper that declares a FLAG_SPEC object or a
// printHelp() function, but not both, with a one-line reason it cannot
// participate in this check (issue #1676's acceptance criteria requires
// this be visible rather than invisible).
const EXCLUDED_HELPERS: readonly { helper: string; reason: string }[] = [
  // --- FLAG_SPEC present, no printHelp() (10) ---------------------------
  {
    helper: 'audit-authored-issue',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'audit-pr-cleanup',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'branch-conflict-state',
    reason: 'help printer is named printUsage(), not printHelp()',
  },
  {
    helper: 'disposition-non-review-notices',
    reason:
      'help text is a module-level USAGE constant, not a printHelp() function',
  },
  {
    helper: 'external-check-waiver',
    reason:
      'help text is an inline process.stdout.write(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'forced-handoff-marker',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'idd-doctor',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'live-status-digest',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  {
    helper: 'resolve-review-thread',
    reason:
      'help text is a module-level USAGE constant, not a printHelp() function',
  },
  {
    helper: 'verify-workshop-integrity',
    reason:
      'help text is an inline console.log(`usage: ...`), not a printHelp() function',
  },
  // --- printHelp() present, no FLAG_SPEC (6) ------------------------------
  {
    helper: 'discover-orphan-filter',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'discover-roadmap-graph',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'emit-marker',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'idd-merge-execute',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'idd-onboard',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'rerun-advisory-convergence',
    reason:
      'hand-rolled parseArgs() loop, no declarative FLAG_SPEC object to compare',
  },
];

// ---------------------------------------------------------------------------
// Unit tests for the two pure extractors, over synthetic fixtures -- proves
// each direction of drift is actually detected (not just that the real
// 23-helper sweep below happens to pass today). Mirrors
// tests/cli-entry-smoke.test.mts's synthetic-fixture-before-real-corpus
// shape.
// ---------------------------------------------------------------------------

test('extractDeclaredFlags reads quoted dashed keys, ignoring a same-named default value', () => {
  const specBlock = `
  '--pr': { type: 'string' },
  '--policy': { type: 'string', default: '--not-a-real-flag' },
  '--verbose': { type: 'boolean', default: false },
`;
  assert.deepEqual(
    [...extractDeclaredFlags(specBlock)].sort(),
    ['--policy', '--pr', '--verbose'].sort(),
  );
});

test('extractDocumentedFlags reads every --dashed token in prose, not only the Usage line', () => {
  const helpText = [
    'Usage:',
    '  node scripts/example.mjs --pr <number>',
    '',
    'Deprecated alias: --old-name -> --pr',
    '',
  ].join('\n');
  assert.deepEqual(
    [...extractDocumentedFlags(helpText)].sort(),
    ['--old-name', '--pr'].sort(),
  );
});

test('a flag declared but not documented is detected as drift', () => {
  const declared = extractDeclaredFlags(
    `'--pr': { type: 'string' },\n'--verbose': { type: 'boolean' },`,
  );
  const documented = extractDocumentedFlags('Usage: tool --pr <n>\n');
  const undocumented = [...declared].filter((flag) => !documented.has(flag));
  assert.deepEqual(undocumented, ['--verbose']);
});

test('a flag documented but not declared is detected as drift', () => {
  const declared = extractDeclaredFlags(`'--pr': { type: 'string' },`);
  const documented = extractDocumentedFlags(
    'Usage: tool --pr <n> [--extra <x>]\n',
  );
  const undeclared = [...documented].filter((flag) => !declared.has(flag));
  assert.deepEqual(undeclared, ['--extra']);
});

// ---------------------------------------------------------------------------
// Meta-consistency guard: catches a covered/excluded list going stale (a
// helper gaining or losing FLAG_SPEC/printHelp without this file being
// updated), independent of the real per-helper sweep below.
// ---------------------------------------------------------------------------

test('COVERED_HELPERS and EXCLUDED_HELPERS exactly account for every FLAG_SPEC/printHelp-bearing helper', () => {
  const coveredSet = new Set<string>(COVERED_HELPERS);
  const excludedSet = new Set(EXCLUDED_HELPERS.map((entry) => entry.helper));

  assert.equal(
    coveredSet.size,
    COVERED_HELPERS.length,
    'COVERED_HELPERS has a duplicate entry',
  );
  assert.equal(
    excludedSet.size,
    EXCLUDED_HELPERS.length,
    'EXCLUDED_HELPERS has a duplicate entry',
  );
  for (const helper of coveredSet) {
    assert.ok(
      !excludedSet.has(helper),
      `${helper} is listed in both COVERED_HELPERS and EXCLUDED_HELPERS`,
    );
  }

  const allHelperNames = readdirSync(srcScriptsDir)
    .filter((name) => name.endsWith('.mts'))
    .map((name) => name.slice(0, -'.mts'.length));

  for (const name of allHelperNames) {
    const src = readSource(name);
    const specPresent = hasFlagSpec(src);
    const helpPresent = hasPrintHelp(src);
    if (specPresent && helpPresent) {
      assert.ok(
        coveredSet.has(name),
        `${name} declares both FLAG_SPEC and printHelp() but is missing from COVERED_HELPERS`,
      );
    } else if (specPresent || helpPresent) {
      assert.ok(
        excludedSet.has(name),
        `${name} declares FLAG_SPEC or printHelp() (not both) but is missing from EXCLUDED_HELPERS`,
      );
    }
  }

  for (const helper of COVERED_HELPERS) {
    const src = readSource(helper);
    assert.ok(
      hasFlagSpec(src) && hasPrintHelp(src),
      `${helper} is listed as covered but no longer declares both FLAG_SPEC and printHelp()`,
    );
  }

  for (const { helper } of EXCLUDED_HELPERS) {
    const src = readSource(helper);
    const specPresent = hasFlagSpec(src);
    const helpPresent = hasPrintHelp(src);
    // Require exactly one signal (XOR), not merely "not both": a helper that
    // has lost BOTH FLAG_SPEC and printHelp() no longer matches the reason
    // recorded for it above (each reason names which one it still has) and
    // its entry has gone stale, same as gaining both would be.
    assert.ok(
      specPresent !== helpPresent,
      specPresent && helpPresent
        ? `${helper} is listed as excluded but now declares both FLAG_SPEC and printHelp() -- move it to COVERED_HELPERS`
        : `${helper} is listed as excluded but now declares NEITHER FLAG_SPEC nor printHelp() -- its recorded reason no longer applies; remove or update this entry`,
    );
  }
});

// ---------------------------------------------------------------------------
// The real sweep: every covered helper's declared flag set must exactly
// match the flag names its own --help output documents.
// ---------------------------------------------------------------------------

for (const helper of COVERED_HELPERS) {
  test(`${helper}.mjs --help documents exactly its declared flags`, () => {
    const src = readSource(helper);
    const specBlock = extractFlagSpecBlock(src, helper);
    const declared = extractDeclaredFlags(specBlock);
    assert.ok(
      declared.size > 0,
      `${helper}: no flags parsed out of its FLAG_SPEC block`,
    );

    const helpText = execFileSync(
      process.execPath,
      [join(scriptsDir, `${helper}.mjs`), '--help'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const documented = extractDocumentedFlags(helpText);
    const allowedExtra = new Set(CROSS_REFERENCE_FLAGS[helper] ?? []);

    const undocumented = [...declared].filter(
      (flag) => !documented.has(flag) && !UNIVERSAL_FLAGS.has(flag),
    );
    assert.deepEqual(
      undocumented,
      [],
      `${helper}: flag(s) declared in FLAG_SPEC but not documented in --help output: ${undocumented.join(', ')}`,
    );

    const undeclared = [...documented].filter(
      (flag) => !declared.has(flag) && !allowedExtra.has(flag),
    );
    assert.deepEqual(
      undeclared,
      [],
      `${helper}: flag(s) documented in --help output but not declared in FLAG_SPEC: ${undeclared.join(', ')}`,
    );
  });
}
