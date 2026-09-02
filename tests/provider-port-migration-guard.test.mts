// Static guard for #2266: once a domain helper migrates onto
// `provider-port.mts`, it must never regain a direct `gh` invocation or
// GitHub-endpoint construction. `MIGRATED_HELPERS` starts empty and gains
// one entry per migration commit, so this guard protects every subsequent
// commit in the migration rather than only catching regressions after the
// whole issue lands. `provider-port.mts`, `provider-adapter-github.mts`,
// and `provider-adapter-fake.mts` are the sanctioned exception -- the
// adapter's whole job is to be the one place `gh` invocation lives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Files migrated so far. Append the next filename here as each of #2266's
 * 11 target files (and, from #2267 on, its own ten PR-facing target files
 * -- the issue body names nine bullets, but one, `ci-wait-*.mts`, is a
 * glob covering two files: `ci-wait-policy.mts` and `ci-wait-state.mts`)
 * moves onto the provider port -- do not add a name until its migration
 * commit lands, and never remove one once migrated. */
const MIGRATED_HELPERS: readonly string[] = [
  'collaborator-permission.mts',
  'discover-viability-gate.mts',
  'discover-orphan-filter.mts',
  'post-idd-marker.mts',
  'claim-approval-gate.mts',
  'resume-claim-routing.mts',
  'discover-readiness-check.mts',
  'discover-shared-file-overlap.mts',
  'resume-route-selection.mts',
  'idd-roadmap-audit-execute.mts',
  'discover-roadmap-graph.mts',
  // #2267 additions below.
  'review-clause.mts',
  'review-activity-snapshot.mts',
  'resolve-review-thread.mts',
  'idd-merge-execute.mts',
  'merged-pr-feedback-sweep.mts',
  'advisory-wait-state.mts',
  'ci-wait-policy.mts',
  'ci-wait-state.mts',
  'pre-merge-readiness.mts',
  'advisory-convergence.mts',
];

const DIRECT_GH_PATTERNS: { pattern: RegExp; description: string }[] = [
  {
    pattern: /execFileSync\(\s*['"]gh['"]/,
    description: 'direct execFileSync("gh", ...) invocation',
  },
  {
    // Matches both the `.mts` source's own import and the generated
    // `.mjs` counterpart's `from './gh-exec.mjs'` (#2268) -- a guard that
    // only recognized the source extension would stay vacuous against a
    // regression introduced solely in committed generated output.
    // `\.mjs?` (optional trailing 's') matches only '.mj'/'.mjs', never
    // '.mts' -- an explicit two-way alternation is required (Copilot +
    // CodeRabbit review, #2436).
    pattern: /from ['"]\.\/gh-exec\.(?:mts|mjs)['"]/,
    description: 'import from the gh-exec transport primitive',
  },
  {
    // ghTextAsync checked before ghText -- \bghText\s*\( alone does not
    // match "ghTextAsync(" (the literal 'A' where \s*\( expects
    // whitespace-then-paren breaks the match), so without its own
    // alternative a migrated file could call ghTextAsync() directly and
    // this guard would miss it (CodeRabbit review, #2400).
    pattern:
      /\bghTextAsync\s*\(|\bghText\s*\(|\bghApiJson\s*\(|\bghGraphql\s*\(/,
    description: 'a bare ghTextAsync()/ghText()/ghApiJson()/ghGraphql() call',
  },
];

function readSource(relativePath: string): string {
  return readFileSync(`${REPO_ROOT}/src/scripts/${relativePath}`, 'utf8');
}

/** `.mts` -> generated `.mjs` counterpart under `scripts/` (#2268) --
 * `pnpm run build` commits this file 1:1 per source, so every migrated
 * helper has one. */
function readGeneratedOutput(sourceFilename: string): string {
  const generatedFilename = sourceFilename.replace(/\.mts$/, '.mjs');
  return readFileSync(`${REPO_ROOT}/scripts/${generatedFilename}`, 'utf8');
}

test('migrated helpers no longer construct gh/GitHub calls directly', () => {
  for (const filename of MIGRATED_HELPERS) {
    const source = readSource(filename);
    for (const { pattern, description } of DIRECT_GH_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${filename} regained ${description} after migrating onto provider-port.mts`,
      );
    }
  }
});

test('migrated helpers: committed generated output no longer constructs gh/GitHub calls directly (#2268)', () => {
  for (const filename of MIGRATED_HELPERS) {
    const generated = readGeneratedOutput(filename);
    for (const { pattern, description } of DIRECT_GH_PATTERNS) {
      assert.doesNotMatch(
        generated,
        pattern,
        `${filename.replace(/\.mts$/, '.mjs')} regained ${description} in committed generated output`,
      );
    }
  }
});

test('the direct-gh pattern set catches a bare ghTextAsync() call (CodeRabbit review, #2400)', () => {
  const { pattern } = DIRECT_GH_PATTERNS.find((entry) =>
    entry.description.includes('ghTextAsync'),
  ) as { pattern: RegExp };
  assert.match('await ghTextAsync(args)', pattern);
  assert.match('ghTextAsync (args)', pattern);
});

test('the gh-exec import pattern matches both .mts and .mjs, and only those (Copilot + CodeRabbit review, #2436)', () => {
  const { pattern } = DIRECT_GH_PATTERNS.find((entry) =>
    entry.description.includes('gh-exec'),
  ) as { pattern: RegExp };
  assert.match("from './gh-exec.mts'", pattern);
  assert.match("from './gh-exec.mjs'", pattern);
  assert.doesNotMatch("from './gh-exec.mj'", pattern);
  assert.doesNotMatch("from './gh-exec.ts'", pattern);
});

test('the adapter modules themselves are exempt and still exist', () => {
  // Sanity check that the exemption target is real, not a typo that would
  // silently make the guard above vacuous once files are enrolled.
  for (const filename of [
    'provider-port.mts',
    'provider-adapter-github.mts',
    'provider-adapter-fake.mts',
  ]) {
    assert.doesNotThrow(() => readSource(filename));
  }
});
