import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COVERED_HELPERS } from '../src/scripts/repository-inventory-audit.mts';

const UNIVERSAL_FLAGS = new Set(['--help']);
// Per-helper allowlist for a flag literal that appears in --help prose but
// belongs to a DIFFERENT command -- cited as a cross-reference or worked
// example, not documentation of this helper's own parser. Each entry names
// the owning command so the exclusion stays auditable.
const CROSS_REFERENCE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'audit-authored-issue': [
    // sweep-authoring-markers.mjs's flag, cited to name the cleanup evidence
    // producer (#3593).
    '--with-cleanup-evidence',
  ],
  'claim-lock': [
    // Git options and a resume-claim-routing option cited as cross-tool examples.
    '--absolute-git-dir',
    '--git-common-dir',
    '--fresh-claim-gate',
  ],
  'verify-install-deps': [
    // A pnpm install flag shown as the value of this helper's own option.
    '--frozen-lockfile',
  ],
  'sweep-authoring-markers': [
    // An option owned by minimize-superseded-markers, cited by contrast.
    '--allow-untrusted',
  ],
};

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
// object (see the imported COVERED_HELPERS ledger; its exact count isn't
// restated here so this comment can't drift from the list -- the source audit
// keeps the list itself honest against the source tree). Earlier drafts of
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
// to compare against (see the reasoned exclusion ledger in
// `src/scripts/repository-inventory-audit.mts`: most use a hand-rolled
// parseArgs() loop, one uses node:util's parseArgs() directly with bare
// option keys, and one uses an ad-hoc argv.includes('--help') check -- each
// has a one-line reason, mirroring tests/flag-name-matrix.test.mts's explicit
// `helpers` style rather than silent discovery).
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

/**
 * Extracts the body of the first `const <NAME>_FLAG_SPEC = { ... } as
 * const;` declaration in `src`. Every covered helper's spec closes with the
 * literal `} as const;` on its own line -- verified across every helper in
 * imported COVERED_HELPERS ledger, and enforced structurally by TypeScript (the
 * `as const` assertion is what makes `parseCliArgs` generic inference work).
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

test('audit-authored-issue --help explains both cleanup evidence shapes (#3740)', () => {
  const helpText = execFileSync(
    process.execPath,
    [join(scriptsDir, 'audit-authored-issue.mjs'), '--help'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.match(helpText, /direct \{collections, mutations\} or a full/);
  assert.match(helpText, /full\s+sweep report with cleanupEvidence containing/);
  assert.match(helpText, /Pass the sweep report as-is/);
  assert.match(
    helpText,
    /malformed,\s*unrecognized, or conflicting forms fail/,
  );
});
