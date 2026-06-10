import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
);
const scriptFiles = readdirSync(scriptsDir).filter((file) =>
  file.endsWith('.mjs'),
);

// Match the flag as a quoted string literal regardless of quote style, so
// the source-scan survives formatter quote-style migrations.
function includesQuotedFlag(src, flag) {
  return src.includes(`'${flag}'`) || src.includes(`"${flag}"`);
}

function readScript(name) {
  return readFileSync(join(scriptsDir, name), 'utf8');
}

// One canonical CLI flag name per shared concept. `helpers` is the explicit set
// of scripts that accept the concept, so the test catches a canonical flag being
// renamed or removed (not only a stray deprecated alias). The optional
// `deprecated` name may be kept as an alias for one release but must always
// warn on stderr and coexist with the canonical flag; concepts without an
// alias declare only the canonical spelling.
const FLAG_CONCEPTS = [
  {
    concept: 'claim id',
    canonical: '--claim-id',
    deprecated: '--expected-claim-id',
    helpers: [
      'audit-pr-cleanup.mjs',
      'external-check-waiver.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
      'resume-claim-routing.mjs',
    ],
  },
  {
    concept: 'agent id',
    canonical: '--agent-id',
    deprecated: '--expected-agent-id',
    helpers: [
      'audit-pr-cleanup.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
    ],
  },
  {
    // force-handoff.mjs is intentionally absent: its sole '--pr' literal is
    // the error-message label used when validating the interactively
    // prompted PR number, not a parsed CLI flag.
    concept: 'pull request number',
    canonical: '--pr',
    helpers: [
      'advisory-wait-state.mjs',
      'audit-pr-cleanup.mjs',
      'branch-conflict-state.mjs',
      'discover-orphan-filter.mjs',
      'external-check-waiver.mjs',
      'forced-handoff-marker.mjs',
      'live-status-digest.mjs',
      'pre-merge-readiness.mjs',
      'review-activity-snapshot.mjs',
      'stalled-session-quiet-check.mjs',
    ],
  },
  {
    concept: 'trusted marker logins',
    canonical: '--trusted-marker-logins',
    helpers: [
      'advisory-wait-state.mjs',
      'forced-handoff-marker.mjs',
      'minimize-superseded-markers.mjs',
      'pre-merge-readiness.mjs',
      'resume-claim-routing.mjs',
      'review-activity-snapshot.mjs',
    ],
  },
  {
    concept: 'IDD agent logins',
    canonical: '--idd-agent-logins',
    helpers: ['pre-merge-readiness.mjs'],
  },
  {
    concept: 'advisory bot logins',
    canonical: '--advisory-bot-logins',
    helpers: ['pre-merge-readiness.mjs', 'review-activity-snapshot.mjs'],
  },
];

// Known near-miss spellings a future helper might plausibly introduce.
// Keep this list small and mapped to the canonical flag the guard names.
const NEAR_MISS_VARIANTS = [
  { variant: '--pr-number', canonical: '--pr' },
  { variant: '--pull-request', canonical: '--pr' },
  { variant: '--trusted-actors', canonical: '--trusted-marker-logins' },
  { variant: '--agent-logins', canonical: '--idd-agent-logins' },
  { variant: '--bot-logins', canonical: '--advisory-bot-logins' },
];

for (const { concept, canonical, deprecated, helpers } of FLAG_CONCEPTS) {
  test(`every ${concept} helper exposes the canonical ${canonical}`, () => {
    for (const helper of helpers) {
      const src = readScript(helper);
      assert.ok(
        includesQuotedFlag(src, canonical),
        `${helper} must accept the canonical ${canonical}`,
      );
    }
  });

  if (!deprecated) {
    continue;
  }

  test(`no helper accepts ${deprecated} without the canonical ${canonical}`, () => {
    for (const file of scriptFiles) {
      const src = readScript(file);
      if (includesQuotedFlag(src, deprecated)) {
        assert.ok(
          includesQuotedFlag(src, canonical),
          `${file} accepts ${deprecated} but not the canonical ${canonical}`,
        );
      }
    }
  });

  test(`${deprecated} alias emits a stderr deprecation warning`, () => {
    for (const file of scriptFiles) {
      const src = readScript(file);
      if (!includesQuotedFlag(src, deprecated)) {
        continue;
      }
      assert.ok(
        src.includes(`warnDeprecatedFlag('${deprecated}'`) ||
          src.includes(`warnDeprecatedFlag("${deprecated}"`),
        `${file} should route ${deprecated} through warnDeprecatedFlag()`,
      );
      assert.match(
        src,
        /function warnDeprecatedFlag[\s\S]*?process\.stderr\.write/,
        `${file} warnDeprecatedFlag() should write the deprecation warning to stderr`,
      );
    }
  });
}

test('no helper introduces a near-miss variant of a canonical flag', () => {
  for (const file of scriptFiles) {
    const src = readScript(file);
    for (const { variant, canonical } of NEAR_MISS_VARIANTS) {
      if (includesQuotedFlag(src, variant)) {
        assert.ok(
          includesQuotedFlag(src, canonical),
          `${file} quotes ${variant}; use the canonical ${canonical} (or accept both)`,
        );
      }
    }
  }
});

test('pre-merge-readiness accepts both canonical and deprecated claim/agent flags', () => {
  const src = readScript('pre-merge-readiness.mjs');
  for (const flag of [
    '--claim-id',
    '--agent-id',
    '--expected-claim-id',
    '--expected-agent-id',
  ]) {
    assert.ok(
      includesQuotedFlag(src, flag),
      `pre-merge-readiness.mjs should accept ${flag}`,
    );
  }
});
