import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FIXTURE_SUITES,
  type FixtureCase,
  regenerateFixtureText,
} from '../src/scripts/update-fixtures.mts';

// Resolve fixtures relative to this test file, not the process cwd, so the
// suite is location-independent (e.g. under an IDE test runner) — matching the
// `new URL('../', import.meta.url)` pattern in the other fixture-driven tests.
const REPO_ROOT_URL = new URL('../', import.meta.url);

const SAMPLE = `${JSON.stringify(
  {
    input: { prHeadSha: 'abc' },
    options: { now: '2026-01-01T00:00:00Z' },
    expected: { ready: true },
  },
  null,
  2,
)}\n`;

test('regenerateFixtureText is a byte no-op when the builder returns the existing expected', () => {
  const identityBuild = (fixture: FixtureCase): unknown => fixture.expected;
  assert.equal(regenerateFixtureText(SAMPLE, identityBuild), SAMPLE);
});

test('regenerateFixtureText rewrites only expected when the builder output differs', () => {
  const updated = JSON.parse(
    regenerateFixtureText(SAMPLE, () => ({ ready: false, blockers: ['x'] })),
  ) as FixtureCase;
  assert.deepEqual(updated.expected, { ready: false, blockers: ['x'] });
  // input / options are carried through untouched.
  assert.deepEqual(updated.input, { prHeadSha: 'abc' });
  assert.deepEqual(updated.options, { now: '2026-01-01T00:00:00Z' });
});

test('regenerateFixtureText keeps canonical JSON form and original key order', () => {
  const text = regenerateFixtureText(SAMPLE, () => ({ ready: false }));
  assert.ok(text.endsWith('}\n'), 'trailing newline preserved');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'input',
    'options',
    'expected',
  ]);
});

test('regenerateFixtureText propagates a throwing builder instead of silently skipping', () => {
  assert.throws(
    () =>
      regenerateFixtureText('{"input":{},"options":{}}', () => {
        throw new Error('builder failed');
      }),
    /builder failed/,
  );
});

// The load-bearing guarantee: on unchanged code the real builder reproduces
// every committed fixture byte-for-byte, so `pnpm run fixtures:update` is a
// no-op (empty git diff). This also guards the reverse — a builder shape change
// landed without regenerating the fixtures fails here, complementing the
// deepEqual assertions in the per-suite fixture tests.
for (const suite of FIXTURE_SUITES) {
  test(`${suite.name}: real builder round-trips every committed fixture (no-op)`, () => {
    const suiteDirUrl = new URL(`${suite.dir}/`, REPO_ROOT_URL);
    const files = readdirSync(suiteDirUrl)
      .filter((name) => name.endsWith('.json'))
      .sort();
    assert.ok(files.length > 0, `expected fixtures under ${suite.dir}`);
    for (const name of files) {
      const original = readFileSync(new URL(name, suiteDirUrl), 'utf8');
      assert.equal(
        regenerateFixtureText(original, suite.build),
        original,
        `${suite.dir}/${name} would be rewritten by an unchanged-code regeneration`,
      );
    }
  });
}
