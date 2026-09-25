import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectLiteGateParityViolations } from '../src/scripts/consistency-helpers.mts';

// Coverage for kurone-kito/idd-skill#3310: `collectLiteGateParityViolations`
// fails the docs audit when a lite instructions file drops a safety gate
// its standard counterpart still carries. One test per violation kind
// Proposed change item 2 lists, a passing fixture combining a `lite` and an
// `omittedByDesign` entry, and a real-manifest regression demonstrating
// detection when a live seed entry's fragment is deleted from its lite file.

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const STANDARD_TEXT = [
  '# Standard File',
  '',
  '## The Gate',
  '',
  'Before merging, confirm the closing set matches exactly.',
  '',
  '## Another Section',
  '',
  'Unrelated text.',
  '',
].join('\n');

const LITE_TEXT = [
  '# Lite File',
  '',
  '## lite/The Gate',
  '',
  'Confirm the closing set matches exactly here too.',
  '',
].join('\n');

/** An in-memory `readFile` for the synthetic fixtures below. */
function fakeReader(
  files: Record<string, string>,
): (path: string) => string | null {
  return (path) => (Object.hasOwn(files, path) ? files[path] : null);
}

const INSTRUCTIONS_PREFIX = 'idd-template/.github/instructions/';
const STANDARD_FILE = `${INSTRUCTIONS_PREFIX}standard.instructions.md`;
const LITE_FILE = `${INSTRUCTIONS_PREFIX}lite/standard-lite.instructions.md`;

const FILES: Record<string, string> = {
  [STANDARD_FILE]: STANDARD_TEXT,
  [LITE_FILE]: LITE_TEXT,
};

function baseEntry(): Record<string, unknown> {
  return {
    id: 'closing-set-example',
    phase: 'F2',
    standard: {
      file: STANDARD_FILE,
      heading: 'The Gate',
      contains: 'confirm the closing set matches exactly',
    },
    lite: {
      file: LITE_FILE,
      heading: 'lite/The Gate',
      contains: 'closing set matches exactly here too',
    },
  };
}

test('passes on a well-formed entry with both a lite and an omittedByDesign entry', () => {
  const entries = [
    baseEntry(),
    {
      id: 'omitted-example',
      phase: 'F2',
      standard: {
        file: STANDARD_FILE,
        heading: 'Another Section',
        contains: 'Unrelated text.',
      },
      omittedByDesign: {
        reason:
          'The lite profile intentionally skips this prose judgment call.',
        lite: {
          file: LITE_FILE,
          heading: 'Lite File',
          contains: 'Confirm the closing set matches exactly here too.',
        },
      },
    },
  ];
  assert.deepEqual(
    collectLiteGateParityViolations(entries, fakeReader(FILES)),
    [],
  );
});

test('absent or empty registry is a configuration error', () => {
  for (const entries of [null, undefined, []]) {
    const violations = collectLiteGateParityViolations(
      entries,
      fakeReader(FILES),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /registry must be present and non-empty/);
  }
});

test('fails when an entry carries neither lite nor omittedByDesign', () => {
  const entry = baseEntry();
  delete entry.lite;
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /must carry exactly one of lite or omittedByDesign/,
  );
});

test('fails when an entry carries both lite and omittedByDesign', () => {
  const entry = baseEntry();
  entry.omittedByDesign = {
    reason: 'redundant',
    lite: {
      file: LITE_FILE,
      heading: 'Lite File',
      contains: 'Lite File',
    },
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /must carry exactly one of lite or omittedByDesign/,
  );
});

test('fails when omittedByDesign.reason is empty', () => {
  const entry = baseEntry();
  delete entry.lite;
  entry.omittedByDesign = {
    reason: '   ',
    lite: {
      file: LITE_FILE,
      heading: 'Lite File',
      contains: 'Lite File',
    },
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /omittedByDesign\.reason must not be empty/);
});

test('fails on a duplicate id', () => {
  const violations = collectLiteGateParityViolations(
    [baseEntry(), baseEntry()],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /duplicate id closing-set-example/);
});

test('fails when a location file does not exist', () => {
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).file =
    `${INSTRUCTIONS_PREFIX}missing.instructions.md`;
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /standard location file idd-template\/\.github\/instructions\/missing\.instructions\.md does not exist/,
  );
});

test('fails when a heading has no matching GitHub slug', () => {
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).heading = 'No Such Heading';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /has no matching GitHub slug/);
});

test('fails closed on a heading that repeats in its own file (#3310 review)', () => {
  const files = {
    ...FILES,
    [`${INSTRUCTIONS_PREFIX}duplicate-heading.instructions.md`]: [
      '# Doc',
      '',
      '## The Gate',
      '',
      'First occurrence: confirm the closing set matches exactly.',
      '',
      '## The Gate',
      '',
      'Second occurrence: confirm the closing set matches exactly.',
      '',
    ].join('\n'),
  };
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).file =
    `${INSTRUCTIONS_PREFIX}duplicate-heading.instructions.md`;
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(files),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /matches more than one heading/);
});

test('ignores a heading-shaped line inside a tilde-fenced example (#3428 review)', () => {
  const files = {
    ...FILES,
    [`${INSTRUCTIONS_PREFIX}tilde-fence.instructions.md`]: [
      '# Doc',
      '',
      '~~~markdown',
      '## The Gate',
      '~~~',
      '',
      '## The Gate',
      '',
      'Real occurrence: confirm the closing set matches exactly.',
      '',
    ].join('\n'),
  };
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).file =
    `${INSTRUCTIONS_PREFIX}tilde-fence.instructions.md`;
  assert.deepEqual(
    collectLiteGateParityViolations([entry], fakeReader(files)),
    [],
  );
});

test('fails when a location carries both contains and pattern', () => {
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).pattern = 'closing set';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must carry exactly one of contains or pattern/);
});

test('fails when a location carries neither contains nor pattern', () => {
  const entry = baseEntry();
  delete (entry.standard as Record<string, unknown>).contains;
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must carry exactly one of contains or pattern/);
});

test('fails when the contains fragment is missing from its heading section', () => {
  const entry = baseEntry();
  (entry.lite as Record<string, unknown>).contains =
    'a fragment that is not present';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /contains fragment not found/);
});

test('fails when the pattern does not match within its heading section', () => {
  const entry = baseEntry();
  delete (entry.lite as Record<string, unknown>).contains;
  (entry.lite as Record<string, unknown>).pattern = 'never-appears-\\d+';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /pattern not matched/);
});

test('passes when a pattern matches within its heading section', () => {
  const entry = baseEntry();
  delete (entry.lite as Record<string, unknown>).contains;
  (entry.lite as Record<string, unknown>).pattern =
    'closing set match\\w+ exactly';
  assert.deepEqual(
    collectLiteGateParityViolations([entry], fakeReader(FILES)),
    [],
  );
});

test('fails when the standard location lives under lite/', () => {
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).file = LITE_FILE;
  (entry.standard as Record<string, unknown>).heading = 'lite/The Gate';
  (entry.standard as Record<string, unknown>).contains =
    'closing set matches exactly here too';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /standard location file .* must be under idd-template\/\.github\/instructions\/ and not under lite\//,
  );
});

test('fails when a lite location is outside the canonical lite prefix', () => {
  const entry = baseEntry();
  (entry.lite as Record<string, unknown>).file = STANDARD_FILE;
  (entry.lite as Record<string, unknown>).heading = 'The Gate';
  (entry.lite as Record<string, unknown>).contains =
    'confirm the closing set matches exactly';
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(FILES),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /lite location file .* must be under idd-template\/\.github\/instructions\/lite\//,
  );
});

test('rejects a lite path that only contains a /lite/ segment', () => {
  const entry = baseEntry();
  (entry.lite as Record<string, unknown>).file =
    'project/lite/other.instructions.md';
  const files = {
    ...FILES,
    'project/lite/other.instructions.md': LITE_TEXT,
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(files),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /must be under idd-template\/\.github\/instructions\/lite\//,
  );
});

test('rejects a standard path outside the canonical instructions prefix', () => {
  const entry = baseEntry();
  (entry.standard as Record<string, unknown>).file =
    'docs/other.instructions.md';
  const files = {
    ...FILES,
    'docs/other.instructions.md': STANDARD_TEXT,
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(files),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /must be under idd-template\/\.github\/instructions\/ and not under lite\//,
  );
});

test('fails when a helperGate literal is missing from its source', () => {
  const entry = baseEntry();
  entry.helperGate = { source: 'helper.mts', gate: 'closing-set' };
  const files = {
    ...FILES,
    'helper.mts': "export const other = { gate: 'unresolved-threads' };\n",
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(files),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /helperGate literal .* not found in helper\.mts/);
});

test('passes when a helperGate literal is present in its source', () => {
  const entry = baseEntry();
  entry.helperGate = { source: 'helper.mts', gate: 'closing-set' };
  const files = {
    ...FILES,
    'helper.mts': "export const other = { gate: 'closing-set' };\n",
  };
  assert.deepEqual(
    collectLiteGateParityViolations([entry], fakeReader(files)),
    [],
  );
});

test('fails when an omittedByDesign entry also carries a helperGate', () => {
  const entry = baseEntry();
  delete entry.lite;
  entry.omittedByDesign = {
    reason: 'The lite profile never attempts this prose judgment call.',
    lite: {
      file: LITE_FILE,
      heading: 'Lite File',
      contains: 'Confirm the closing set matches exactly here too.',
    },
  };
  entry.helperGate = { source: 'helper.mts', gate: 'closing-set' };
  const files = {
    ...FILES,
    'helper.mts': "export const other = { gate: 'closing-set' };\n",
  };
  const violations = collectLiteGateParityViolations(
    [entry],
    fakeReader(files),
  );
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /helperGate is not meaningful on an omittedByDesign entry/,
  );
});

// --- Real-manifest regression -------------------------------------------

function readRepoFile(path: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

test('the real liteGateParity registry has no violations against the current tree', () => {
  const manifest = JSON.parse(
    readRepoFile('audit/sync-manifest.json') ?? '{}',
  ) as {
    liteGateParity?: unknown;
  };
  assert.ok(
    Array.isArray(manifest.liteGateParity),
    'expected a liteGateParity array',
  );
  assert.ok(
    (manifest.liteGateParity as unknown[]).length > 0,
    'expected at least one liteGateParity entry',
  );
  assert.deepEqual(
    collectLiteGateParityViolations(manifest.liteGateParity, readRepoFile),
    [],
  );
});

test("deleting a real seed entry's lite fragment is detected", () => {
  const manifest = JSON.parse(
    readRepoFile('audit/sync-manifest.json') ?? '{}',
  ) as {
    liteGateParity: {
      id: string;
      lite?: { file: string; contains?: string };
    }[];
  };
  const target = manifest.liteGateParity.find(
    (entry) => entry.id === 'b1-primary-worktree-exemption',
  );
  assert.ok(target, 'expected the b1-primary-worktree-exemption seed entry');
  const liteLocation = target?.lite as { file: string; contains: string };
  assert.ok(liteLocation?.contains, 'expected a contains fragment to remove');

  const realLiteText = readRepoFile(liteLocation.file);
  assert.ok(realLiteText, `expected to read ${liteLocation.file}`);
  assert.ok(
    realLiteText.includes(liteLocation.contains),
    'expected the fragment to be present before deletion',
  );
  const mutatedText = realLiteText.replace(liteLocation.contains, '');

  const scratchFiles: Record<string, string> = {
    [liteLocation.file]: mutatedText,
  };
  const readWithScratchOverride = (path: string): string | null =>
    Object.hasOwn(scratchFiles, path) ? scratchFiles[path] : readRepoFile(path);

  const violations = collectLiteGateParityViolations(
    manifest.liteGateParity,
    readWithScratchOverride,
  );
  const matching = violations.filter((violation) =>
    violation.startsWith('b1-primary-worktree-exemption:'),
  );
  assert.equal(matching.length, 1);
  assert.match(matching[0], /contains fragment not found/);
});
