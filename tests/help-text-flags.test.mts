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
// Coverage: every src/scripts/*.mts helper that declares a FLAG_SPEC-style
// object (see COVERED_HELPERS below; its exact count isn't restated here so
// this comment can't drift from the list -- the meta-consistency test keeps
// the list itself honest against the live source tree). Earlier drafts of
// this test scoped coverage to helpers with a function literally named
// printHelp(), but that ties participation to a naming convention rather
// than to whether --help is actually renderable -- and the real sweep below
// spawns the compiled scripts/<name>.mjs with --help regardless of which
// internal mechanism (printHelp(), printUsage(), a module-level USAGE
// constant, or an inline console.log/process.stdout.write) produces that
// output. Every non-printHelp() helper was individually confirmed before
// being added to COVERED_HELPERS: --help exits 0 in well under a second
// with no gh/network I/O, and its FLAG_SPEC block parses cleanly. A helper
// is excluded only when it has no FLAG_SPEC at all -- nothing declarative
// to compare against (see EXCLUDED_HELPERS below: most via a hand-rolled
// parseArgs() loop, one via node:util's parseArgs() directly with bare
// option keys, one via an ad-hoc argv.includes('--help') check -- each with
// a one-line reason there, mirroring tests/flag-name-matrix.test.mts's
// explicit `helpers` style rather than silent discovery).
//
// Rendering choice: this test spawns each covered helper's *compiled*
// scripts/<name>.mjs with --help and captures real stdout, rather than
// statically parsing its help-text source. This is a fast, dependency-free
// subprocess call that also exercises the real compiled artifact, matching
// tests/cli-entry-smoke.test.mts's shelling-out convention for --help
// output (which already pins two of these helpers' exact --help bytes).
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

/** True when `src` declares a `<NAME>_FLAG_SPEC = { ... }` object -- the
 * declarative flag spec consumed by `parseCliArgs()` (see cli-args.mts).
 * This is the sole participation gate for this test: see the header comment
 * above for why a help-*printer* naming convention is not used instead. */
function hasFlagSpec(src: string): boolean {
  return /_FLAG_SPEC\s*=\s*\{/.test(src);
}

/**
 * Extracts the body of the first `const <NAME>_FLAG_SPEC = { ... } as
 * const;` declaration in `src`. Every covered helper's spec closes with the
 * literal `} as const;` on its own line -- verified across every helper in
 * COVERED_HELPERS below, and enforced structurally by TypeScript (the
 * `as const` assertion is what makes `parseCliArgs`'s generic flag-name
 * inference work).
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
 * mistaken for a declared key. Not anchored to line start, so two keys
 * sharing one line (unlikely with this repo's formatter, but not
 * statically guaranteed) are both still collected.
 */
function extractDeclaredFlags(specBlock: string): Set<string> {
  const flags = new Set<string>();
  const flagKeyPattern = /['"](--[a-z0-9][a-z0-9-]*)['"]\s*:/g;
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
  // Negative lookbehind excludes a hyphen or word character immediately
  // before the `--`, so a prose token like `foo--bar` can't be mistaken for
  // a documented `--bar` flag.
  const flagTokenPattern = /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g;
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
// boilerplate literal in every spec, comparing it against per-helper prose
// would mostly test whether that shared boilerplate line happens to also be
// echoed in the Usage line, not real per-helper drift. Many covered helpers
// already mention `[--help]` in their Usage line and many don't;
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
// `helpers` style): every src/scripts/*.mts helper that declares a
// FLAG_SPEC-style object, built by hand rather than by silent discovery --
// see the header comment above for why this isn't narrowed to only helpers
// with a function literally named printHelp().
const COVERED_HELPERS = [
  'actions-usage-report',
  'advisory-comment-debounce',
  'advisory-convergence',
  'advisory-wait-state',
  'audit-authored-issue',
  'audit-pr-cleanup',
  'branch-conflict-state',
  'branch-name',
  'ci-wait-policy',
  'ci-wait-state',
  'claim-approval-gate',
  'claim-lock',
  'clone-lock',
  'token-cost-event',
  'token-cost-harvest',
  'token-cost-report',
  'discover-readiness-check',
  'discover-shared-file-overlap',
  'discover-viability-gate',
  'disposition-non-review-notices',
  'external-check-waiver',
  'forced-handoff-marker',
  'helper-runtime-manifest',
  'idd-critique-delegate',
  'idd-doctor',
  'idd-roadmap-audit-execute',
  'live-status-digest',
  'local-validation-evidence',
  'merged-pr-feedback-sweep',
  'phase-id-resolver',
  'pre-merge-readiness',
  'provider-health',
  'provider-outage-declaration',
  'provider-outage-park',
  'rerun-advisory-convergence',
  'resolve-review-thread',
  'resume-claim-routing',
  'resume-route-selection',
  'review-activity-snapshot',
  'review-comment-origin',
  'review-disposition-verify',
  'select-desynced-index',
  'stalled-session-quiet-check',
  'suitability-close-execute',
  'suitability-triage',
  'verify-install-deps',
  'verify-workshop-integrity',
] as const;

// Every other src/scripts/*.mts helper that has some CLI --help surface but
// no FLAG_SPEC object to compare it against, with a one-line reason it
// cannot participate in this check (issue #1676's acceptance criteria
// requires this be visible rather than invisible). Verified against the
// complete non-FLAG_SPEC universe under src/scripts/ (every file without a
// FLAG_SPEC declaration, not just files matching one specific pattern): for
// each, `--help` was compared against an unrecognized-flag invocation to
// tell a genuine --help path from a helper that just silently ignores
// unknown flags and runs its normal behavior regardless (e.g.
// audit-code-span-wrap, check-pnpm-boundary, sync-docs, validate-schemas
// all do the latter and are correctly absent from this list; audit-docs and
// build-ts print a generic invalid-usage/crash message for *any*
// unrecognized flag, not --help specifically, and are absent for the same
// reason).
const EXCLUDED_HELPERS: readonly { helper: string; reason: string }[] = [
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
    helper: 'post-idd-marker',
    reason:
      'hand-rolled parseArgs() loop (own local function) with a USAGE constant, no declarative FLAG_SPEC object to compare',
  },
  {
    helper: 'minimize-superseded-markers',
    reason:
      "calls node:util's parseArgs() directly with bare (non-dashed) option keys, not the shared cli-args.mts FLAG_SPEC convention -- no declarative --dashed spec to compare",
  },
  {
    helper: 'update-fixtures',
    reason:
      "ad-hoc argv.includes('--help') check against a HELP constant, no declarative FLAG_SPEC object to compare",
  },
];

// ---------------------------------------------------------------------------
// Unit tests for the two pure extractors, over synthetic fixtures -- proves
// each direction of drift is actually detected (not just that the real
// per-helper sweep below happens to pass today). Mirrors
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

test('extractDeclaredFlags collects two keys sharing one line', () => {
  const specBlock = `'--pr': { type: 'string' }, '--repo': { type: 'string' },`;
  assert.deepEqual(
    [...extractDeclaredFlags(specBlock)].sort(),
    ['--pr', '--repo'].sort(),
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

test('extractDocumentedFlags ignores a --dashed token immediately preceded by a hyphen or word character', () => {
  const helpText = 'see foo--bar for context; the real flag is --pr\n';
  assert.deepEqual([...extractDocumentedFlags(helpText)], ['--pr']);
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
// helper gaining or losing FLAG_SPEC without this file being updated),
// independent of the real per-helper sweep below.
// ---------------------------------------------------------------------------

test('COVERED_HELPERS and EXCLUDED_HELPERS stay consistent with live FLAG_SPEC presence', () => {
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

  // Every FLAG_SPEC-bearing helper under src/scripts/ must be explicitly
  // covered -- a new one appearing here without being added to
  // COVERED_HELPERS (after being individually vetted per the header
  // comment) would otherwise run with zero drift coverage, silently.
  const allHelperNames = readdirSync(srcScriptsDir)
    .filter((name) => name.endsWith('.mts'))
    .map((name) => name.slice(0, -'.mts'.length));

  for (const name of allHelperNames) {
    if (hasFlagSpec(readSource(name))) {
      assert.ok(
        coveredSet.has(name),
        `${name} declares a FLAG_SPEC object but is missing from COVERED_HELPERS`,
      );
    }
  }

  for (const helper of COVERED_HELPERS) {
    assert.ok(
      hasFlagSpec(readSource(helper)),
      `${helper} is listed as covered but no longer declares a FLAG_SPEC object`,
    );
  }

  // An excluded entry's reason is "no FLAG_SPEC to compare" -- if the helper
  // gained one, the reason no longer holds and it belongs in
  // COVERED_HELPERS instead (after the same per-helper vetting).
  for (const { helper } of EXCLUDED_HELPERS) {
    assert.ok(
      !hasFlagSpec(readSource(helper)),
      `${helper} is listed as excluded (no FLAG_SPEC) but now declares one -- move it to COVERED_HELPERS`,
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
