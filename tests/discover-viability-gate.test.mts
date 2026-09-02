import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateA4Viability,
  evaluateDiscoverViability,
  parseArgs,
  renderCsv,
} from '../src/scripts/discover-viability-gate.mts';

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: --issue is repeatable and --issues is comma-split', () => {
  const args = parseArgs(['--issue', '5', '--issues', '9,11', '--csv']);
  assert.deepEqual(args.issueNumbers, [5, 9, 11]);
  assert.equal(args.csv, true);
});

test('parseArgs: a non-numeric --issue token is silently dropped (unchanged contract)', () => {
  const args = parseArgs(['--issues', '5,bad,9']);
  assert.deepEqual(args.issueNumbers, [5, 9]);
});

test('parseArgs: repeated --issues occurrences all accumulate (not just the last)', () => {
  // Regression coverage for a Codex review finding on #1450: a
  // non-multiple parseArgs string flag keeps only the LAST occurrence
  // when repeated, which would silently drop 1 and 2 here.
  const args = parseArgs(['--issues', '1,2', '--issues', '3,4']);
  assert.deepEqual(args.issueNumbers, [1, 2, 3, 4]);
});

test('parseArgs: interleaved --issues/--issue occurrences preserve argv order', () => {
  // Regression coverage for a second #1450 review finding: grouping every
  // --issue occurrence before every --issues occurrence silently reordered
  // interleaved input (plural-before-singular is the case that would have
  // been missed by only ever putting --issue first, as the test above
  // does).
  const args = parseArgs(['--issues', '1,2', '--issue', '3']);
  assert.deepEqual(args.issueNumbers, [1, 2, 3]);
});

test('parseArgs: the --issue=<value> equals-form is recognized in order', () => {
  const args = parseArgs(['--issues', '1,2', '--issue=3']);
  assert.deepEqual(args.issueNumbers, [1, 2, 3]);
});

test('parseArgs: a missing --issue value throws', () => {
  assert.throws(() => parseArgs(['--issue']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --owner would greedily accept '--csv' as its literal
  // value, silently leaving --csv unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--issue', '5', '--owner', '--csv']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --issue', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

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

// --- #2417: limited_scope false positives on topic words, not the diff's
// own footprint --------------------------------------------------------

test('passes limited scope when a broad-scope word is the rejected option in a "rather than" clause (#2401 shape)', () => {
  const result = evaluateA4Viability({
    number: 20,
    title: 'add fail-closed recovery guidance',
    body:
      'Replace the open-ended escalation cue with a simpler fail-closed ' +
      'behavior plus actionable manual-recovery guidance -- rather than ' +
      'attempting a second, more elaborate structural redesign. Keep the ' +
      'same non-binding, heuristic framing. Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('passes limited scope when a broad-scope word modifies documentation content, not the diff (#2402 shape)', () => {
  const result = evaluateA4Viability({
    number: 21,
    title: 'add a pointer doc for helper-authoring guidance',
    body:
      '`docs/typescript-sources.md` (or another location already ' +
      "established as this repository's home for cross-cutting " +
      'helper-authoring guidance) states that a new helper sharing its ' +
      'problem shape should reuse the existing pattern. Single-file ' +
      'change. Verification: add unit tests and keep lint green.',
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('passes limited scope when a broad-scope word is the rejected option in a "prefer X over Y" clause (#2413 shape)', () => {
  const result = evaluateA4Viability({
    number: 22,
    title: 'simplify the fragile mechanism instead of a second attempt',
    body:
      "If the structural fix itself doesn't converge, prefer " +
      'simplifying/removing the fragile mechanism over a second redesign, ' +
      'but only once removal is confirmed non-required. Verification: ' +
      'add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('still fails limited scope when a cue precedes the rejected option but a genuinely broad change follows in the same sentence', () => {
  // Adversarial case: an avoidance cue must not extend its reach across a
  // clause boundary and exclude a broad-scope word that describes what
  // this issue's own change actually does.
  const result = evaluateA4Viability({
    number: 23,
    title: 'redesign the public interface',
    body:
      'Instead of a targeted fix, do a full redesign of the public ' +
      'interface. Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

test('still fails limited scope when a content-noun word sits near a genuinely broad-scope diff description', () => {
  // Adversarial case: "guidance" coincidentally following "cross-cutting"
  // must not suppress a second, independent broad-scope signal in the same
  // corpus ("across multiple subsystems").
  const result = evaluateA4Viability({
    number: 24,
    title: 'redesign the cross-cutting authentication guidance module',
    body:
      'This issue redesigns the module across multiple subsystems. ' +
      'Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

test('passes limited scope when an earlier, broken cue would shadow a later cue that directly governs the match (Copilot review finding, #2422)', () => {
  // The window contains TWO avoidance cues: "avoid" is cut off from the
  // match by a hard clause break (the period before "But"), while "rather
  // than" sits directly before "redesign" with nothing in between. Only
  // checking the first-found cue would miss the second, governing one.
  const result = evaluateA4Viability({
    number: 25,
    title: 'simplify the mechanism',
    body:
      'Attempt to avoid regressions. But rather than redesign the schema, ' +
      'we chose a simpler patch. Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('still fails limited scope when a content noun starts a new sentence after a genuinely broad-scope description (Copilot review finding, #2422)', () => {
  // "Guidance:" opens an unrelated new sentence; it must not reach back
  // across the sentence boundary and suppress the broad-scope match in the
  // preceding sentence.
  const result = evaluateA4Viability({
    number: 26,
    title: 'redesign the public interface',
    body:
      'This issue will redesign the public interface. Guidance: see the ' +
      'design doc. Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

// --- #2446: limited_scope false positive on a bare topic-describing
// sentence, no avoidance-cue or content-noun nearby ---------------------

test('passes limited scope when a broad-scope word is the subject of a preparatory-state clause (#2446 shape)', () => {
  const result = evaluateA4Viability({
    number: 27,
    title: 'document staged non-GitHub adoption',
    body:
      'GitHub is the only implemented provider today, while the ' +
      'architecture is being prepared for additional providers. ' +
      'Single docs-only change. Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test('still fails limited scope when the same word is the subject of an action-verb clause, not a preparatory-state one', () => {
  // Adversarial case: "architecture is being prepared for" must exclude,
  // but "architecture is redesigned across" -- an actual broad action, not
  // an existing staged foundation -- must still fail.
  const result = evaluateA4Viability({
    number: 28,
    title: 'redesign the architecture',
    body:
      'The architecture is redesigned across many subsystems. ' +
      'Verification: add unit tests.',
    state: 'OPEN',
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes('limited_scope'));
});

test('still fails limited scope when a preparatory-state clause coexists with a genuinely broad-scope diff description', () => {
  // Adversarial case: the preparatory-state exclusion on one occurrence
  // must not suppress a second, independent broad-scope signal in the same
  // corpus.
  const result = evaluateA4Viability({
    number: 29,
    title: 'redesign the schema while noting staged architecture work',
    body:
      'The architecture is being prepared for additional providers, but ' +
      'this issue itself redesigns the schema across multiple ' +
      'subsystems. Verification: add unit tests.',
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
