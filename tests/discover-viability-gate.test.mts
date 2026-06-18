import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateA4Viability,
  evaluateDiscoverViability,
  renderCsv,
} from '../src/scripts/discover-viability-gate.mts';

// Minimal RFC 4180 single-row field splitter: respects quoted fields so a
// comma inside a quoted title does not start a new column.
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (inQuotes) {
      if (char === '"') {
        if (row[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

test('passes viability for narrow scope with objective verification and no external coordination', () => {
  const result = evaluateA4Viability({
    number: 1,
    title: 'fix helper parser',
    body: `
Single module update in scripts/.
Verification: add unit tests and keep lint + CI green.
`,
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('fails limited scope for broad cross-cutting work', () => {
  const result = evaluateA4Viability({
    number: 2,
    title: 'redesign architecture across multiple subsystems',
    body: 'Broad update across many modules with public interface changes. Tests included.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

test('fails limited scope when a broad cue accompanies a narrow cue', () => {
  const result = evaluateA4Viability({
    number: 5,
    title: 'single module change that redesigns a public interface',
    body: 'Targeted edit, but it redesigns a public interface. Tests included.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

test('renderCsv quotes titles containing commas and quotes', () => {
  const csv = renderCsv({
    viable: [{ number: 10, title: 'fix parser, escape "quotes" too' }],
    discarded: [
      {
        number: 11,
        title: 'redesign, broadly',
        failedCriteria: ['limited_scope'],
      },
    ],
    summary: {
      total: 2,
      viableCount: 1,
      discardedCount: 1,
      discardedByCriterion: { limited_scope: 1 },
    },
  });

  const rows = csv.trimEnd().split('\n');
  assert.equal(rows[0], 'kind,number,title,criteria');
  assert.equal(rows[1], 'viable,10,"fix parser, escape ""quotes"" too",');
  assert.equal(rows[2], 'discarded,11,"redesign, broadly",limited_scope');
  // Each data row keeps exactly four fields when parsed as RFC 4180 CSV.
  for (const row of rows.slice(1)) {
    assert.equal(parseCsvRow(row).length, 4);
  }
});

test('fails clear verification when only subjective checks are present', () => {
  const result = evaluateA4Viability({
    number: 3,
    title: 'tune UX copy',
    body: 'Success is when it looks good and passes maintainer preference review.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('clear_verification'));
});

test('fails autonomous completion when external coordination is required', () => {
  const result = evaluateA4Viability({
    number: 4,
    title: 'wire external approval gate',
    body: 'Requires external coordination and maintainer decision before completion.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('autonomous_completion'));
});

test('evaluateDiscoverViability fails closed when a lookup aborts', async () => {
  // A non-404 gh failure (auth / rate-limit / network) propagates out of
  // loadIssue instead of being swallowed into a silent issue_not_found.
  await assert.rejects(
    evaluateDiscoverViability([900], {
      loadIssue: async () => {
        throw new Error('gh api ... failed: Bad credentials (HTTP 401)');
      },
    }),
    /Bad credentials/,
  );
});

test('evaluateDiscoverViability groups viable and discarded candidates', async () => {
  const issues = new Map([
    [
      10,
      {
        number: 10,
        title: 'targeted helper update',
        state: 'OPEN',
        body: 'single module change with unit tests and ci verification',
      },
    ],
    [
      11,
      {
        number: 11,
        title: 'cross-cutting redesign',
        state: 'OPEN',
        body: 'across multiple subsystems and architecture overhaul',
      },
    ],
    [
      12,
      {
        number: 12,
        title: 'closed issue',
        state: 'CLOSED',
        body: 'tests',
      },
    ],
  ]);

  const summary = await evaluateDiscoverViability([10, 11, 12, 13], {
    loadIssue: async (number) => issues.get(number) ?? null,
  });

  assert.deepEqual(summary.viable, [
    { number: 10, title: 'targeted helper update' },
  ]);
  assert.equal(summary.discarded.length, 3);
  assert.equal(summary.summary.total, 4);
  assert.equal(summary.summary.viableCount, 1);
  assert.equal(summary.summary.discardedCount, 3);
  assert.equal(summary.summary.discardedByCriterion.issue_not_found, 1);
  assert.equal(summary.summary.discardedByCriterion.issue_not_open, 1);
  assert.equal(summary.summary.discardedByCriterion.limited_scope, 1);
});
