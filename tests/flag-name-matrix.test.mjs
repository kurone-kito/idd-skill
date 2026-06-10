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
// renamed or removed (not only a stray deprecated alias). A `deprecated` name
// may be kept as an alias for one release but must always warn on stderr and
// coexist with the canonical flag.
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
