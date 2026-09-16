import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectInstructionSizeBudgetRatchetViolations,
  extractGeneratedFromBanner,
  generatedFromBanner,
  selectStricterNoticeUtilizationPct,
} from '../src/scripts/consistency-helpers.mts';

// extractGeneratedFromBanner is otherwise the only export of this module
// without direct dedicated coverage: it is only ever called internally by
// stripGeneratedFromBanner/parseGeneratedFromBannerSource, never asserted
// on directly. The other exports have direct, named test() blocks in
// tests/consistency.test.mts, plus
// collectRootMarkdownAllowlistViolations (tests/root-markdown-allowlist.test.mts),
// collectTypeSuppressionViolations (tests/type-suppression-budgets.test.mts),
// and collectNearCeilingRatchetViolations /
// selectStricterNoticeUtilizationPct (tests/near-ceiling-ratchet.test.mts,
// the bundle-side sibling of collectInstructionSizeBudgetRatchetViolations
// below). The 3 re-exported policy-helpers.mts functions have their own
// tests/policy-helpers.test.mts.
//
// collectInstructionSizeBudgetRatchetViolations (#3028) is tested here
// rather than alongside its bundle-side sibling in
// near-ceiling-ratchet.test.mts because the issue that added it (#3028)
// named this file verbatim as the acceptance-criteria target.

const BANNER = generatedFromBanner('src/example.mts');

test('extractGeneratedFromBanner returns the banner at the top when there is no frontmatter', () => {
  const body = `${BANNER}\n\n# Heading\n\nBody.\n`;
  assert.equal(extractGeneratedFromBanner(body), BANNER);
});

test('extractGeneratedFromBanner returns the banner immediately after a frontmatter block', () => {
  const body = `---\napplyTo: "**"\n---\n\n${BANNER}\n\n# Heading\n\nBody.\n`;
  assert.equal(extractGeneratedFromBanner(body), BANNER);
});

test('extractGeneratedFromBanner returns null when no banner is present', () => {
  assert.equal(extractGeneratedFromBanner('# Heading\n\nBody.\n'), null);
});

test('extractGeneratedFromBanner returns null when frontmatter is present but no banner follows', () => {
  const body = '---\napplyTo: "**"\n---\n\n# Heading\n\nBody.\n';
  assert.equal(extractGeneratedFromBanner(body), null);
});

test('extractGeneratedFromBanner does not match a banner-shaped comment out of position', () => {
  // The function deliberately only matches at the very top or immediately
  // after frontmatter; a banner-shaped block elsewhere in the body must be
  // reported as missing rather than silently accepted.
  const body = `# Heading\n\nBody.\n\n${BANNER}\n`;
  assert.equal(extractGeneratedFromBanner(body), null);
});

// --- collectInstructionSizeBudgetRatchetViolations (#3028) ----------------

const NOTICE_PCT = 95;

test('a brand-new entry with no base-ref counterpart (by id or glob) does not error', () => {
  const current = [
    {
      id: 'entry-new',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 2000,
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    [],
  );
  assert.deepEqual(result, []);
});

test('phaseLimitBytes unchanged does not error even at high base utilization', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 990, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('phaseLimitBytes decreased does not error even at high base utilization', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 900,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 990, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('phaseLimitBytes raised while every governed file is below the notice threshold does not error', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 500, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('phaseLimitBytes raised while a governed file is at or above the notice threshold errors, naming the entry, field, both values, and the file', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.equal(result.length, 1);
  assert.match(
    result[0],
    /entry-a phaseLimitBytes raised from 1000 to 2000 while a\/x\.md was already at 95\.00% utilization at the base ref \(950\/1000 bytes\)/,
  );
});

test('alwaysLoadedLimitBytes raised while every governed file is below the notice threshold does not error', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 2000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/core.md', bytes: 500, alwaysLoaded: true }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('alwaysLoadedLimitBytes raised while a governed file is at or above the notice threshold errors', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 2000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/core.md', bytes: 990, alwaysLoaded: true }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.equal(result.length, 1);
  assert.match(
    result[0],
    /entry-a alwaysLoadedLimitBytes raised from 1000 to 2000 while a\/core\.md was already at 99\.00% utilization at the base ref \(990\/1000 bytes\)/,
  );
});

test('the alwaysLoaded classification routes a file to only its own field: a near-ceiling phase file does not block an alwaysLoadedLimitBytes raise', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 2000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [
        // Near-ceiling, but classified as phase (not always-loaded) --
        // must not affect the alwaysLoadedLimitBytes raise below.
        { path: 'a/phase.md', bytes: 990, alwaysLoaded: false },
        { path: 'a/core.md', bytes: 100, alwaysLoaded: true },
      ],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('the alwaysLoaded classification routes a file to only its own field: a near-ceiling always-loaded file does not block a phaseLimitBytes raise', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [
        { path: 'a/phase.md', bytes: 100, alwaysLoaded: false },
        // Near-ceiling, but classified as always-loaded -- must not
        // affect the phaseLimitBytes raise below.
        { path: 'a/core.md', bytes: 990, alwaysLoaded: true },
      ],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('multiple near-ceiling governed files under one raised field each produce their own error', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [
        { path: 'a/x.md', bytes: 950, alwaysLoaded: false },
        { path: 'a/y.md', bytes: 960, alwaysLoaded: false },
        { path: 'a/z.md', bytes: 100, alwaysLoaded: false },
      ],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.equal(result.length, 2);
  assert.ok(result.some((error) => /a\/x\.md/.test(error)));
  assert.ok(result.some((error) => /a\/y\.md/.test(error)));
});

test('a base limit of zero is skipped for that field (nothing to ratchet a percentage from)', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 0,
      alwaysLoadedLimitBytes: 0,
      files: [{ path: 'a/x.md', bytes: 500, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('multiple entries are evaluated independently', () => {
  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
    {
      id: 'entry-b',
      glob: 'b/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
    {
      id: 'entry-b',
      glob: 'b/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'b/x.md', bytes: 100, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.equal(result.length, 1);
  assert.match(result[0], /entry-a/);
});

// Mirrors near-ceiling-ratchet.test.mts's rename-fallback coverage for the
// bundle-side check (#2697), extended here (#3028 B2 critique finding) to
// the per-file entry id, matched by an unchanged `glob` instead of an
// unchanged file set.
test('an entry renamed with an identical glob is matched by the rename fallback and errors', () => {
  const glob = 'a/*.md';
  const current = [
    {
      id: 'entry-a-v2',
      glob,
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob,
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.equal(result.length, 1);
  assert.match(
    result[0],
    /entry-a-v2 phaseLimitBytes raised from 1000 to 2000/,
  );
});

test('an entry renamed with an identical glob and unchanged limits does not error', () => {
  const glob = 'a/*.md';
  const current = [
    {
      id: 'entry-a-v2',
      glob,
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob,
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('an entry renamed with a different glob is treated as genuinely new, not a rename', () => {
  const current = [
    {
      id: 'entry-a-v2',
      glob: 'a2/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

test('two base entries sharing an identical glob are ambiguous and never used as a rename match', () => {
  const glob = 'a/*.md';
  const current = [
    {
      id: 'entry-a-v2',
      glob,
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob,
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
    {
      id: 'entry-a-dup',
      glob,
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      files: [{ path: 'a/x.md', bytes: 950, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    NOTICE_PCT,
    current,
    base,
  );
  assert.deepEqual(result, []);
});

// AC #6: a PR that raises a per-file limit and contextCeiling's own
// noticeUtilizationPct together, in the same change, must still be caught
// -- composing selectStricterNoticeUtilizationPct (bundle-side helper,
// reused verbatim here) with collectInstructionSizeBudgetRatchetViolations
// the same way audit-docs.mts's checkNearCeilingRatchet does.
test('composed with selectStricterNoticeUtilizationPct, raising a per-file limit and noticeUtilizationPct together is still caught', () => {
  const currentNoticeUtilizationPct = 97;
  const baseNoticeUtilizationPct = 95;
  const effectiveNoticeUtilizationPct = selectStricterNoticeUtilizationPct(
    currentNoticeUtilizationPct,
    baseNoticeUtilizationPct,
  );
  assert.equal(effectiveNoticeUtilizationPct, 95);

  const current = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 2000,
      alwaysLoadedLimitBytes: 1000,
    },
  ];
  const base = [
    {
      id: 'entry-a',
      glob: 'a/*.md',
      phaseLimitBytes: 1000,
      alwaysLoadedLimitBytes: 1000,
      // 96% under the OLD (base) 95% threshold reads as a violation; under
      // a naively-applied NEW (current) 97% threshold it would read as
      // compliant -- selectStricterNoticeUtilizationPct's job is to make
      // sure the stricter (lower) threshold is the one actually applied.
      files: [{ path: 'a/x.md', bytes: 960, alwaysLoaded: false }],
    },
  ];
  const result = collectInstructionSizeBudgetRatchetViolations(
    effectiveNoticeUtilizationPct,
    current,
    base,
  );
  assert.equal(result.length, 1);
  assert.match(result[0], /entry-a phaseLimitBytes raised from 1000 to 2000/);
});
