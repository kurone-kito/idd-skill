import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectDocumentedHelperInvocationFlags,
  collectHelperFlagDriftViolations,
  extractFencedBlocks,
  extractFencedLines,
  extractFlagTokens,
} from '../src/scripts/helper-flag-drift.mts';

// --- extractFencedLines -------------------------------------------------

test('extractFencedLines returns only lines inside a triple-backtick fence', () => {
  const text = [
    'Some prose mentioning `--not-a-fence`.',
    '```sh',
    'node scripts/example.mjs --apply',
    '```',
    'More prose after the fence.',
  ].join('\n');

  assert.deepEqual(extractFencedLines(text), [
    'node scripts/example.mjs --apply',
  ]);
});

test('extractFencedLines handles multiple fences and an unterminated one', () => {
  const text = [
    '```sh',
    'line-a',
    '```',
    'prose',
    '```text',
    'line-b',
    // no closing fence -- still counts as "inside" per the toggle
  ].join('\n');

  assert.deepEqual(extractFencedLines(text), ['line-a', 'line-b']);
});

// --- extractFencedBlocks --------------------------------------------------

test('extractFencedBlocks keeps each fence as its own array of lines', () => {
  const text = [
    '```sh',
    'line-a',
    'line-b',
    '```',
    'prose',
    '```text',
    'line-c',
    '```',
  ].join('\n');

  assert.deepEqual(extractFencedBlocks(text), [
    ['line-a', 'line-b'],
    ['line-c'],
  ]);
});

test('extractFencedBlocks treats a shorter nested backtick run as content, not a delimiter', () => {
  // The real idd-template/docs/onboarding/issue-mediated-bootstrap.md
  // shape: a four-backtick fence wraps an illustrative issue-body
  // template that itself shows a genuine three-backtick `sh` worked
  // example. A length-agnostic toggle would treat the inner ```sh/```
  // pair as closing and reopening the outer fence, scrambling everything
  // after it and skipping the worked example entirely.
  const text = [
    '````markdown',
    'Some prose.',
    '```sh',
    'node scripts/idd-onboard.mjs --import --source "$CLONE_DIR"',
    '```',
    'More prose after the inner fence, still inside the outer one.',
    '````',
    'Real prose outside every fence.',
  ].join('\n');

  assert.deepEqual(extractFencedBlocks(text), [
    [
      'Some prose.',
      '```sh',
      'node scripts/idd-onboard.mjs --import --source "$CLONE_DIR"',
      '```',
      'More prose after the inner fence, still inside the outer one.',
    ],
  ]);
});

test('collectDocumentedHelperInvocationFlags finds a worked example nested inside a longer outer fence', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'idd-template/docs/onboarding/issue-mediated-bootstrap.md',
      text: [
        '````markdown',
        'Some prose.',
        '```sh',
        'node scripts/idd-onboard.mjs --import \\',
        '  --source "$CLONE_DIR" --target "$TARGET_REPO"',
        '```',
        'More prose.',
        '````',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/idd-onboard.mjs',
      firstSeenDocPath:
        'idd-template/docs/onboarding/issue-mediated-bootstrap.md',
      flags: [
        {
          flag: '--import',
          docPath: 'idd-template/docs/onboarding/issue-mediated-bootstrap.md',
        },
        {
          flag: '--source',
          docPath: 'idd-template/docs/onboarding/issue-mediated-bootstrap.md',
        },
        {
          flag: '--target',
          docPath: 'idd-template/docs/onboarding/issue-mediated-bootstrap.md',
        },
      ],
    },
  ]);
});

// --- extractFlagTokens ---------------------------------------------------

test('extractFlagTokens finds every distinct --flag token in free text', () => {
  const flags = extractFlagTokens(
    '--type <type> --target <issue|pr> <number> [--apply] --type',
  );
  assert.deepEqual([...flags].sort(), ['--apply', '--target', '--type']);
});

test('extractFlagTokens returns an empty set for text with no flag tokens', () => {
  assert.deepEqual(
    extractFlagTokens('Error: operator interaction is required'),
    new Set(),
  );
});

// --- collectDocumentedHelperInvocationFlags ------------------------------

test('collectDocumentedHelperInvocationFlags extracts flags from a fenced worked example', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/example.md',
      text: [
        '```sh',
        'node scripts/post-idd-marker.mjs --type watermark --apply',
        '```',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/post-idd-marker.mjs',
      firstSeenDocPath: 'docs/example.md',
      flags: [
        { flag: '--apply', docPath: 'docs/example.md' },
        { flag: '--type', docPath: 'docs/example.md' },
      ],
    },
  ]);
});

test('collectDocumentedHelperInvocationFlags ignores an invocation outside a fence', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/example.md',
      text: 'See `node scripts/post-idd-marker.mjs --type watermark` for details.',
    },
  ]);
  assert.deepEqual(documented, []);
});

test('collectDocumentedHelperInvocationFlags ignores a placeholder helper name', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/example.md',
      text: [
        '```sh',
        'node scripts/<helper-name>.mjs --type watermark',
        '```',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(documented, []);
});

test('collectDocumentedHelperInvocationFlags records firstSeenDocPath even for an invocation with zero flags', () => {
  // The docs/getting-started.md #2477 case: `node scripts/idd-doctor.mjs`
  // with no flags at all. `flags` alone cannot supply a doc path for a
  // missing-helper violation when the array is empty.
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/getting-started.md',
      text: ['```sh', 'node scripts/idd-doctor.mjs', '```'].join('\n'),
    },
  ]);

  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/idd-doctor.mjs',
      firstSeenDocPath: 'docs/getting-started.md',
      flags: [],
    },
  ]);
});

test('collectDocumentedHelperInvocationFlags skips a path-traversal example', () => {
  // The docs/permissions.md #2477 false-positive case: a deliberate
  // Bash-permission bypass illustration, never a real worked example.
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/permissions.md',
      text: [
        '```text',
        'node scripts/../bin/idd-merge-execute.mjs --apply',
        '```',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(documented, []);
});

test('collectDocumentedHelperInvocationFlags joins a shell line-continuation and extracts flags from the continuation lines', () => {
  // The common worked-example style throughout this repo's instructions:
  // a long invocation wrapped across several lines with a trailing `\`.
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/example.md',
      text: [
        '```sh',
        'node scripts/post-idd-marker.mjs --type watermark \\',
        '  --agent-id <id> --claim-id <claim-id> \\',
        '  --from-pr <pr-number> --apply',
        '```',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/post-idd-marker.mjs',
      firstSeenDocPath: 'docs/example.md',
      flags: [
        { flag: '--agent-id', docPath: 'docs/example.md' },
        { flag: '--apply', docPath: 'docs/example.md' },
        { flag: '--claim-id', docPath: 'docs/example.md' },
        { flag: '--from-pr', docPath: 'docs/example.md' },
        { flag: '--type', docPath: 'docs/example.md' },
      ],
    },
  ]);
});

test('collectDocumentedHelperInvocationFlags does not bridge a continuation across two separate fences', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/example.md',
      text: [
        '```sh',
        'node scripts/example.mjs --apply \\',
        '```',
        'unrelated prose',
        '```sh',
        '--should-not-attach',
        '```',
      ].join('\n'),
    },
  ]);

  // The trailing `\` has no following line within its own fence, so it is
  // kept as-is (no crash, no cross-fence join) and the unrelated second
  // fence's line never matches the invocation pattern on its own.
  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/example.mjs',
      firstSeenDocPath: 'docs/example.md',
      flags: [{ flag: '--apply', docPath: 'docs/example.md' }],
    },
  ]);
});

test('collectDocumentedHelperInvocationFlags merges flags for the same helper across files, keeping first-seen doc provenance', () => {
  const documented = collectDocumentedHelperInvocationFlags([
    {
      path: 'docs/a.md',
      text: ['```sh', 'node scripts/example.mjs --apply', '```'].join('\n'),
    },
    {
      path: 'docs/b.md',
      text: [
        '```sh',
        'node scripts/example.mjs --apply --claim-issue 1',
        '```',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(documented, [
    {
      helperPath: 'scripts/example.mjs',
      firstSeenDocPath: 'docs/a.md',
      flags: [
        { flag: '--apply', docPath: 'docs/a.md' },
        { flag: '--claim-issue', docPath: 'docs/b.md' },
      ],
    },
  ]);
});

// --- collectHelperFlagDriftViolations -------------------------------------

test('collectHelperFlagDriftViolations flags a documented flag missing from --help output', () => {
  const violations = collectHelperFlagDriftViolations(
    [
      {
        helperPath: 'scripts/example.mjs',
        firstSeenDocPath: 'docs/a.md',
        flags: [
          { flag: '--apply', docPath: 'docs/a.md' },
          { flag: '--renamed-flag', docPath: 'docs/a.md' },
        ],
      },
    ],
    () => ({ exists: true, output: 'usage: --apply [--claim-issue <n>]' }),
  );

  assert.deepEqual(violations, [
    'docs/a.md: documents `--renamed-flag` for scripts/example.mjs, but that flag does not appear in its --help output (possibly renamed or removed)',
  ]);
});

test('collectHelperFlagDriftViolations reports no violations when every documented flag is still accepted', () => {
  const violations = collectHelperFlagDriftViolations(
    [
      {
        helperPath: 'scripts/example.mjs',
        firstSeenDocPath: 'docs/a.md',
        flags: [{ flag: '--apply', docPath: 'docs/a.md' }],
      },
    ],
    () => ({ exists: true, output: 'usage: --apply [--claim-issue <n>]' }),
  );
  assert.deepEqual(violations, []);
});

test('collectHelperFlagDriftViolations flags a documented helper that no longer exists', () => {
  const violations = collectHelperFlagDriftViolations(
    [
      {
        helperPath: 'scripts/renamed-away.mjs',
        firstSeenDocPath: 'docs/a.md',
        flags: [{ flag: '--apply', docPath: 'docs/a.md' }],
      },
    ],
    () => ({ exists: false, output: '' }),
  );

  assert.deepEqual(violations, [
    'docs/a.md: documents `node scripts/renamed-away.mjs`, but scripts/renamed-away.mjs does not exist in the repository',
  ]);
});

test('collectHelperFlagDriftViolations reports the real doc path for a missing helper invoked with zero flags', () => {
  // The exact #2477 review finding: entry.flags[0]?.docPath degraded to
  // "(unknown doc)" when the documented invocation carried no flags at
  // all -- firstSeenDocPath must supply a real location regardless.
  const violations = collectHelperFlagDriftViolations(
    [
      {
        helperPath: 'scripts/renamed-away.mjs',
        firstSeenDocPath: 'docs/getting-started.md',
        flags: [],
      },
    ],
    () => ({ exists: false, output: '' }),
  );

  assert.deepEqual(violations, [
    'docs/getting-started.md: documents `node scripts/renamed-away.mjs`, but scripts/renamed-away.mjs does not exist in the repository',
  ]);
});

test('collectHelperFlagDriftViolations skips a helper whose --help output has no recognizable flags', () => {
  // An interactive-only helper (e.g. force-handoff.mjs) errors immediately
  // on --help with no flag-shaped output at all -- treated as unverifiable
  // rather than flagging every documented flag as missing.
  const violations = collectHelperFlagDriftViolations(
    [
      {
        helperPath: 'scripts/interactive-only.mjs',
        firstSeenDocPath: 'docs/a.md',
        flags: [{ flag: '--apply', docPath: 'docs/a.md' }],
      },
    ],
    () => ({
      exists: true,
      output: 'Error: operator interaction is required',
    }),
  );
  assert.deepEqual(violations, []);
});
