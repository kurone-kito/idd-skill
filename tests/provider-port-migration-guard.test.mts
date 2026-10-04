// Detector regressions for #2266: once a domain helper migrates onto
// `provider-port.mts`, it must never regain a direct `gh` invocation or
// GitHub-endpoint construction. The enrolled list (MIGRATED_HELPERS) starts
// empty and gains one entry per migration commit, so the guard protects every
// subsequent commit in the migration rather than only catching regressions
// after the whole issue lands. `provider-port.mts`,
// `provider-adapter-github.mts`, and `provider-adapter-fake.mts` are the
// sanctioned exception -- the adapter's whole job is to be the one place `gh`
// invocation lives. The scan of each helper's source and committed generated
// output (#2268) is the PROVIDER-PORT-MIGRATED rule of
// scripts/lint-source-boundaries.mjs (#3748); this file keeps the matcher
// cases and enrollment hygiene.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIRECT_GH_PATTERNS,
  MIGRATED_HELPERS,
  PROVIDER_PORT_ADAPTER_FILES,
} from '../src/scripts/lint-source-boundaries.mts';

function patternFor(descriptionFragment: string): RegExp {
  const entry = DIRECT_GH_PATTERNS.find((candidate) =>
    candidate.description.includes(descriptionFragment),
  );
  assert.ok(entry, `no direct-gh pattern describes "${descriptionFragment}"`);
  return entry.pattern;
}

test('the direct-gh pattern set catches a direct execFileSync call that spawns gh', () => {
  const pattern = patternFor('execFileSync');
  assert.match(`execFileSync('gh', args)`, pattern);
  assert.match(`execFileSync(  "gh", args)`, pattern);
  assert.doesNotMatch(`execFileSync('git', args)`, pattern);
});

test('the direct-gh pattern set catches a bare ghTextAsync() call (CodeRabbit review, #2400)', () => {
  const pattern = patternFor('ghTextAsync');
  assert.match('await ghTextAsync(args)', pattern);
  assert.match('ghTextAsync (args)', pattern);
});

test('the bare-call pattern catches each gh-exec wrapper only as a standalone call', () => {
  const pattern = patternFor('ghTextAsync');
  for (const call of ['ghText(a)', 'ghApiJson (a)', 'ghGraphql(a)']) {
    assert.match(call, pattern);
  }
  // A longer identifier that merely ends in a wrapper name is not a call.
  assert.doesNotMatch('weighText(a)', pattern);
  assert.doesNotMatch('const ghTextValue = 1;', pattern);
});

test('the gh-exec import pattern matches both .mts and .mjs, and only those (Copilot + CodeRabbit review, #2436)', () => {
  const pattern = patternFor('gh-exec');
  assert.match("from './gh-exec.mts'", pattern);
  assert.match("from './gh-exec.mjs'", pattern);
  assert.doesNotMatch("from './gh-exec.mj'", pattern);
  assert.doesNotMatch("from './gh-exec.ts'", pattern);
});

test('the enrolled helper list is unique .mts names and never names a sanctioned adapter', () => {
  assert.equal(new Set(MIGRATED_HELPERS).size, MIGRATED_HELPERS.length);
  for (const filename of MIGRATED_HELPERS) {
    assert.match(filename, /^[a-z0-9-]+\.mts$/);
    assert.ok(
      !PROVIDER_PORT_ADAPTER_FILES.includes(filename),
      `${filename} is a sanctioned adapter, not an enrolled helper`,
    );
  }
});
