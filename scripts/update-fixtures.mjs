#!/usr/bin/env node
// idd-generated-from: src/scripts/update-fixtures.mts
//
// The scripts/update-fixtures.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Reviewed, opt-in regeneration for the deepEqual-driven fixture suites. Each
// suite's `<dir>/*.json` fixtures are `{ input, options, expected }` cases; this
// tool recomputes every `expected` from the current builder output and rewrites
// the file in the repo's canonical JSON form, so an intentional summary-shape
// change no longer needs each fixture hand-edited.
//
// GUARDRAIL: regeneration blesses whatever the code currently emits, so a blind
// regeneration can silently MASK a real regression — the exact anti-pattern IDD warns
// about. Use it ONLY for an intentional output-shape change, and REVIEW the
// emitted `git diff`; it is not a substitute for correctness. A normal
// `pnpm test` / CI run never regenerates (assert-only) — regeneration is strictly
// opt-in via `pnpm run fixtures:update`.
//
// Uses only node: builtins plus the in-repo builder imports, to stay compatible
// with the repository's bare-node boundary.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildPreMergeReadinessSummary } from './protocol-helpers.mjs';

// Resolve the repository root by walking up to the nearest package.json, so the
// suite directories resolve identically whether the tool runs as the emitted
// scripts/update-fixtures.mjs (one level deep), the .mts source under Node type
// stripping (two levels deep), or is invoked from any working directory. A fixed
// cwd-relative path would target the wrong directory when run from a
// subdirectory; mirrors the resolveRepoRoot pattern in validate-schemas.mts.
function resolveRepoRoot(fromDir) {
  let dir = fromDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}
const REPO_ROOT = resolveRepoRoot(import.meta.dirname);
export const FIXTURE_SUITES = [
  {
    name: 'pre-merge-readiness',
    dir: 'fixtures/pre-merge-readiness',
    build: (fixture) =>
      buildPreMergeReadinessSummary(fixture.input, fixture.options),
  },
];
const HELP = `usage: node scripts/update-fixtures.mjs [--suite <name>] [--help]

Reviewed, opt-in regeneration for the deepEqual fixture suites. Recomputes each
<dir>/*.json fixture's "expected" from the current builder and rewrites the file
in the repo's canonical JSON form (2-space indent + trailing newline).

GUARDRAIL: regeneration blesses whatever the code currently emits, so a blind
regeneration can silently mask a real regression. Use it ONLY for an intentional
output-shape change and REVIEW the emitted git diff — it is not a substitute for
correctness. A normal \`pnpm test\` / CI run never regenerates (assert-only);
this tool is strictly opt-in (\`pnpm run fixtures:update\`).

Registered suites: ${FIXTURE_SUITES.map((suite) => suite.name).join(', ')}
  --suite <name>   regenerate only the named suite (default: every suite)
  --help, -h       show this help
`;
/**
 * Recompute a single fixture's `expected` from `build(...)` and serialize it in
 * the repo's canonical JSON form (2-space indent + trailing newline, which
 * matches biome). Pure: returns the new file text. A no-op run reproduces the
 * input bytes exactly — the spread preserves original key order and only
 * `expected` is reassigned — which is what proves the tool is not silently
 * rewriting anything the code did not change.
 */
export function regenerateFixtureText(rawJson, build) {
  const fixture = JSON.parse(rawJson);
  const regenerated = { ...fixture, expected: build(fixture) };
  return `${JSON.stringify(regenerated, null, 2)}\n`;
}
/** Regenerate every fixture in a suite in place; returns the rewritten paths. */
function regenerateSuite(suite) {
  const changed = [];
  const suiteDir = resolve(REPO_ROOT, suite.dir);
  const fixtureFiles = readdirSync(suiteDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  for (const name of fixtureFiles) {
    const absolutePath = join(suiteDir, name);
    const original = readFileSync(absolutePath, 'utf8');
    const updated = regenerateFixtureText(original, suite.build);
    if (updated !== original) {
      writeFileSync(absolutePath, updated);
      changed.push(`${suite.dir}/${name}`);
    }
  }
  return changed;
}
/**
 * Resolve which suites to regenerate from argv: all of them, or only the one
 * named by `--suite <name>`. Throws on an unknown suite so a typo fails loudly
 * rather than silently regenerating nothing.
 */
function selectedSuites(argv) {
  const flagIndex = argv.indexOf('--suite');
  if (flagIndex < 0) {
    return FIXTURE_SUITES;
  }
  const requested = argv[flagIndex + 1];
  const match = FIXTURE_SUITES.find((suite) => suite.name === requested);
  if (!match) {
    const known = FIXTURE_SUITES.map((suite) => suite.name).join(', ');
    throw new Error(
      `unknown suite: ${requested ?? '(none)'} (known: ${known})`,
    );
  }
  return [match];
}
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
  } else {
    const changed = [];
    for (const suite of selectedSuites(argv)) {
      changed.push(...regenerateSuite(suite));
    }
    process.stdout.write(
      changed.length === 0
        ? 'fixtures:update — no changes (fixtures already current)\n'
        : `fixtures:update — rewrote ${changed.length} fixture(s):\n${changed
            .map((path) => `  ${path}`)
            .join('\n')}\n`,
    );
  }
}
