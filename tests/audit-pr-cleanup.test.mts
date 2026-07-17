import assert from 'node:assert/strict';
import { test } from 'node:test';

// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main` (#1210, migrated from
// isCliExecution() by #1447); previously the import parsed process.argv,
// called `fail()` (process.exit), or made a
// `gh` call, aborting the test process. tests/audit-pr-cleanup-summary.test.mts
// covers the pure summary logic in the sibling `-summary` module; this file
// covers only the CLI module's import purity.
test('importing audit-pr-cleanup.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(import('../src/scripts/audit-pr-cleanup.mts'));
  } finally {
    process.env.PATH = originalPath;
  }
});
