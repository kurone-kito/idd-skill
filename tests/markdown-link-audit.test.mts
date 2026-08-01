import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globFiles } from '../src/scripts/consistency-helpers.mts';
import {
  collectMarkdownLinkAuditViolations,
  extractHeadingSlugs,
  extractLinkOccurrences,
  githubHeadingSlug,
  resolveLinkTarget,
} from '../src/scripts/markdown-link-audit.mts';

const CONFIG = {
  id: 'markdown-link-audit',
  globs: ['**/*.md'],
  templateRoot: 'idd-template/',
};

function collect(files: Record<string, string>) {
  const repoFiles = Object.keys(files);
  return collectMarkdownLinkAuditViolations(
    CONFIG,
    repoFiles,
    (pattern) => globFiles(pattern, repoFiles),
    (path) => files[path] ?? '',
  );
}

// --- githubHeadingSlug -------------------------------------------------

test('githubHeadingSlug deletes an em-dash without collapsing the surrounding spaces into one hyphen', () => {
  // The literal #1696 case: "A3 — Diagnostic: ..." must slug to a
  // *double* hyphen where the em-dash was, not a single one -- the
  // recurring defect was authors writing the single/triple-hyphen form
  // by hand.
  assert.equal(
    githubHeadingSlug(
      'A3 — Diagnostic: all candidates blocked by an open roadmap',
    ),
    'a3--diagnostic-all-candidates-blocked-by-an-open-roadmap',
  );
});

test('githubHeadingSlug preserves literal hyphens and strips parens/hash without a space', () => {
  assert.equal(
    githubHeadingSlug('AW3-S — Bounded stale-request recovery (#1571)'),
    'aw3-s--bounded-stale-request-recovery-1571',
  );
});

test('githubHeadingSlug matches the corpus-validated parenthetical-list case', () => {
  assert.equal(
    githubHeadingSlug(
      'Terminal Copilot stall-recovery contract (state, policy, markers, clock)',
    ),
    'terminal-copilot-stall-recovery-contract-state-policy-markers-clock',
  );
});

test('githubHeadingSlug preserves underscores', () => {
  // A Copilot review of this PR flagged the docstring for omitting that the
  // implementation also keeps underscores (a "word" character, matching
  // GitHub's own algorithm) -- lock the contract in with a direct test.
  assert.equal(
    githubHeadingSlug('ReviewItems_snapshot lifecycle'),
    'reviewitems_snapshot-lifecycle',
  );
});

// --- extractHeadingSlugs -------------------------------------------------

test('extractHeadingSlugs applies GitHub duplicate-suffixing to a repeated heading', () => {
  const text = '## Setup\n\ntext\n\n## Setup\n\nmore text\n\n## Setup\n';
  assert.deepEqual(extractHeadingSlugs(text), ['setup', 'setup-1', 'setup-2']);
});

test('extractHeadingSlugs strips backticks from an inline-code heading segment', () => {
  const text = '### Discover Readiness Sweep (`--swarm-floor`)\n';
  assert.deepEqual(extractHeadingSlugs(text), [
    'discover-readiness-sweep---swarm-floor',
  ]);
});

test('extractHeadingSlugs ignores a heading-shaped line inside a fenced code block', () => {
  const text = '## Real Heading\n\n```\n## Not A Heading\n```\n';
  assert.deepEqual(extractHeadingSlugs(text), ['real-heading']);
});

// --- extractLinkOccurrences -----------------------------------------------

test('extractLinkOccurrences finds inline links and ignores link-shaped text inside inline code', () => {
  const text =
    'See [a link](target.md#frag) and `[not a link](fake.md)` here.\n';
  const occurrences = extractLinkOccurrences(text);
  assert.deepEqual(occurrences, [
    { line: 1, target: 'target.md#frag', suppressed: false },
  ]);
});

test('extractLinkOccurrences finds a reference-style link definition', () => {
  const text = 'prose\n\n[label]: ../docs/target.md#frag\n';
  const occurrences = extractLinkOccurrences(text);
  assert.deepEqual(occurrences, [
    { line: 3, target: '../docs/target.md#frag', suppressed: false },
  ]);
});

test('extractLinkOccurrences marks every link on a line carrying the ignore marker as suppressed', () => {
  const text = '[a](missing.md) <!-- audit:ignore-link -->\n';
  const occurrences = extractLinkOccurrences(text);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].suppressed, true);
});

test('extractLinkOccurrences does not suppress a link when the marker only appears inside a code span', () => {
  const text =
    'Use `<!-- audit:ignore-link -->` to suppress [a](missing.md).\n';
  const occurrences = extractLinkOccurrences(text);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].suppressed, false);
});

test('extractLinkOccurrences suppresses when the marker carries an optional reason', () => {
  const text =
    '[a](missing.md) <!-- audit:ignore-link: known false positive -->\n';
  const occurrences = extractLinkOccurrences(text);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].suppressed, true);
});

test('extractLinkOccurrences does not suppress on a longer, unrelated comment sharing the marker prefix', () => {
  // Regression: matching a bare substring instead of the well-formed
  // comment would let any longer comment that happens to start with the
  // same text silently widen the suppression scope.
  const text =
    '[a](missing.md) <!-- audit:ignore-linked-to-something-else -->\n';
  const occurrences = extractLinkOccurrences(text);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].suppressed, false);
});

test('extractLinkOccurrences ignores links inside a fenced code block', () => {
  const text = '```\n[a](missing.md)\n```\n';
  assert.deepEqual(extractLinkOccurrences(text), []);
});

// --- resolveLinkTarget -----------------------------------------------------

test('resolveLinkTarget returns null for out-of-scope external schemes', () => {
  assert.equal(
    resolveLinkTarget('docs/x.md', 'https://example.com/y.md'),
    null,
  );
  assert.equal(resolveLinkTarget('docs/x.md', 'mailto:a@example.com'), null);
});

test('resolveLinkTarget returns null for a root-absolute or protocol-relative target', () => {
  // A CodeRabbit finding on this PR: a naive posix.join silently produces
  // an unrelated path for either form (`/docs/y.md` from `docs/x.md`
  // becomes `docs/docs/y.md`; `//example.com/page` becomes
  // `example.com/page`), which would then be reported as a spurious
  // missing file. GitHub's blob viewer also renders a single leading
  // slash as domain-absolute, not repo-root-relative, so out of scope is
  // the correct reading either way.
  assert.equal(resolveLinkTarget('docs/x.md', '/docs/y.md'), null);
  assert.equal(resolveLinkTarget('README.md', '//example.com/page'), null);
});

test('resolveLinkTarget resolves a same-file fragment-only link', () => {
  assert.deepEqual(resolveLinkTarget('docs/x.md', '#frag'), {
    path: 'docs/x.md',
    fragment: 'frag',
    isDirectory: false,
  });
});

test('resolveLinkTarget resolves a relative path with a fragment', () => {
  assert.deepEqual(
    resolveLinkTarget(
      '.github/instructions/a.instructions.md',
      'b.instructions.md#head',
    ),
    {
      path: '.github/instructions/b.instructions.md',
      fragment: 'head',
      isDirectory: false,
    },
  );
});

test('resolveLinkTarget flags a trailing-slash target as a directory link', () => {
  assert.deepEqual(resolveLinkTarget('README.md', 'idd-template/'), {
    path: 'idd-template/',
    fragment: null,
    isDirectory: true,
  });
});

test('resolveLinkTarget represents a directory link that collapses to the repo root as the empty path', () => {
  // Regression: posix.normalize collapses enough "../" segments (or a bare
  // "."/"..") back to the bare string ".", which git ls-files output never
  // starts with -- appending a trailing slash the way every other
  // directory target gets one would make the repo root's own existence
  // check always fail.
  assert.deepEqual(resolveLinkTarget('docs/x.md', '../'), {
    path: '',
    fragment: null,
    isDirectory: true,
  });
  assert.deepEqual(resolveLinkTarget('README.md', '.'), {
    path: '',
    fragment: null,
    isDirectory: true,
  });
});

// --- collectMarkdownLinkAuditViolations ------------------------------------

test('passes on a valid same-directory link and anchor', () => {
  const violations = collect({
    'docs/a.md': '[link](b.md#target-heading)\n',
    'docs/b.md': '# Target Heading\n',
  });
  assert.deepEqual(violations, []);
});

test('fails when the target heading has been renamed (dead anchor)', () => {
  const violations = collect({
    'docs/a.md': '[link](b.md#target-heading)\n',
    'docs/b.md': '# Renamed Heading\n',
  });
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /docs\/a\.md:1:.*heading anchor #target-heading not found in docs\/b\.md/,
  );
});

test('fails when the link target file does not exist', () => {
  const violations = collect({
    'docs/a.md': '[link](missing.md)\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /-> missing file docs\/missing\.md/);
});

test('fails on a missing target directory', () => {
  const violations = collect({
    'README.md': '[dir](no-such-dir/)\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /-> missing directory no-such-dir\//);
});

test('passes on an existing target directory link', () => {
  const violations = collect({
    'README.md': '[dir](pkg/)\n',
    'pkg/README.md': '# Pkg\n',
  });
  assert.deepEqual(violations, []);
});

test('passes on a directory link that resolves to the repo root', () => {
  // Regression: the repo root has no `git ls-files` entry of its own, so a
  // naive prefix check against a `./`-prefixed path would always miss.
  const violations = collect({
    'docs/x.md': '[root](../)\n',
    'README.md': '# Root\n',
  });
  assert.deepEqual(violations, []);
});

test('em-dash heading: the correct double-hyphen anchor passes and the hand-written triple-hyphen form fails', () => {
  const files = {
    'docs/a.md': '# A3 — Diagnostic: all candidates blocked\n',
    'docs/b.md': [
      '[correct](a.md#a3--diagnostic-all-candidates-blocked)',
      '[wrong](a.md#a3---diagnostic-all-candidates-blocked)',
      '',
    ].join('\n'),
  };
  const violations = collect(files);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /docs\/b\.md:2:.*#a3---diagnostic-all-candidates-blocked not found/,
  );
});

test('template context: a link from idd-template/** escaping the template root fails even though the target exists in the source tree', () => {
  const violations = collect({
    'idd-template/.github/instructions/x.instructions.md':
      '[escapes](../../../.github/copilot-instructions.md)\n',
    '.github/copilot-instructions.md': '# Copilot\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /outside idd-template\/ in template context/);
});

test('template context: the identical relative escape from a non-template file is unaffected', () => {
  const violations = collect({
    'docs/x.md': '[fine](../.github/copilot-instructions.md)\n',
    '.github/copilot-instructions.md': '# Copilot\n',
  });
  assert.deepEqual(violations, []);
});

test('template context: a link staying inside idd-template/** is checked against the shipped copy, not the source copy', () => {
  const violations = collect({
    'idd-template/.github/instructions/x.instructions.md':
      '[ok](../../docs/y.md#shipped-heading)\n',
    'idd-template/docs/y.md': '# Shipped Heading\n',
    // A same-path source-repo file with a *different* heading must never be
    // consulted for this link -- template-context resolution stays inside
    // idd-template/.
    'docs/y.md': '# Different Heading\n',
  });
  assert.deepEqual(violations, []);
});

test('template context: a directory link walking all the way out to the true repo root still fails', () => {
  // The repo-root directory fix (empty-string path) must not accidentally
  // widen the template-context escape check: "" never starts with
  // templateRoot either.
  const violations = collect({
    'idd-template/x.md': '[escapes](../)\n',
    'README.md': '# Root\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /outside idd-template\/ in template context/);
});

test('an intentional exception suppressed with the ignore marker does not fail', () => {
  const violations = collect({
    'docs/a.md': '[broken](missing.md) <!-- audit:ignore-link -->\n',
  });
  assert.deepEqual(violations, []);
});

test('an external http(s) link is out of scope and never fails', () => {
  const violations = collect({
    'docs/a.md': '[external](https://example.com/does-not-exist.md#nope)\n',
  });
  assert.deepEqual(violations, []);
});

test('a root-absolute or protocol-relative link is out of scope and never fails', () => {
  const violations = collect({
    'docs/a.md':
      '[root](/does-not-exist.md)\n\n[protocol-relative](//example.com/does-not-exist.md)\n',
  });
  assert.deepEqual(violations, []);
});

// --- config fail-closed paths -----------------------------------------------

test('returns no violations when config is absent', () => {
  assert.deepEqual(
    collectMarkdownLinkAuditViolations(
      null,
      [],
      () => [],
      () => '',
    ),
    [],
  );
});

test('fails closed when globs is missing', () => {
  const violations = collectMarkdownLinkAuditViolations(
    { id: 'markdown-link-audit' },
    [],
    () => [],
    () => '',
  );
  assert.deepEqual(violations, [
    'markdown-link-audit: globs must be a non-empty array of non-empty glob strings',
  ]);
});

test('fails closed when globs contains a non-string entry', () => {
  const violations = collectMarkdownLinkAuditViolations(
    { id: 'markdown-link-audit', globs: ['docs/**/*.md', 42] },
    [],
    () => [],
    () => '',
  );
  assert.deepEqual(violations, [
    'markdown-link-audit: globs must be a non-empty array of non-empty glob strings',
  ]);
});

test('fails closed when templateRoot is not a trailing-slash string', () => {
  const violations = collectMarkdownLinkAuditViolations(
    {
      id: 'markdown-link-audit',
      globs: ['docs/**/*.md'],
      templateRoot: 'idd-template',
    },
    [],
    () => [],
    () => '',
  );
  assert.deepEqual(violations, [
    'markdown-link-audit: templateRoot must be a string ending with "/"',
  ]);
});
