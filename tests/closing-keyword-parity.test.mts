import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractKeywordReferences } from '../src/scripts/discover-roadmap-graph.mts';
import {
  CLOSING_KEYWORD_ALTERNATION,
  findStrayCommitCloses,
  prReferencesIssue,
} from '../src/scripts/supersession-detection.mts';

// #3877: one vocabulary for "this text closes issue N". Each row states what
// every consumer must answer for the same text. Resume's D3.5 matcher runs
// against a PR-body collector with its own fixture, so it is covered by the
// Resume tests (`tests/resume-route-selection.test.mts`) rather than here.
const ISSUE = 3145;

interface ParityRow {
  text: string;
  closes: boolean;
}

const ROWS: ParityRow[] = [
  { text: 'Closes #3145', closes: true },
  { text: 'closes #3145', closes: true },
  { text: 'Fixes #3145', closes: true },
  { text: 'Resolved #3145', closes: true },
  { text: 'Closes: #3145', closes: true },
  { text: 'CLOSES: #3145', closes: true },
  { text: 'Refs #3145', closes: false },
  { text: 'Part of #3145', closes: false },
];

test('parity: prReferencesIssue agrees with the shared row table', () => {
  for (const row of ROWS) {
    assert.equal(
      prReferencesIssue(
        { closingIssuesReferences: [], title: '', body: row.text },
        ISSUE,
      ),
      row.closes,
      `prReferencesIssue on: ${row.text}`,
    );
  }
});

test('parity: the stray-close scan flags the same rows for an out-of-set issue', () => {
  for (const row of ROWS) {
    const strays = findStrayCommitCloses(
      [{ sha: 'abc1234', commit: { message: `docs: note\n\n${row.text}` } }],
      [],
    );
    const flagged = strays.some((stray) => stray.issue === ISSUE);
    assert.equal(flagged, row.closes, `stray scan on: ${row.text}`);
  }
});

test('parity: the graph extractor reads the same rows as closing-keyword edges', () => {
  for (const row of ROWS) {
    const edges = extractKeywordReferences(row.text);
    const isClosing = edges.some(
      (edge) =>
        edge.target === ISSUE && edge.relationship === 'closing-keyword',
    );
    assert.equal(isClosing, row.closes, `graph extractor on: ${row.text}`);
  }
});

test('parity: Refs and Part of stay non-closing for every consumer', () => {
  for (const text of ['Refs #3145', 'Part of #3145']) {
    assert.equal(
      prReferencesIssue(
        { closingIssuesReferences: [], title: '', body: text },
        ISSUE,
      ),
      false,
      text,
    );
    assert.equal(
      extractKeywordReferences(text).some(
        (edge) => edge.relationship === 'closing-keyword',
      ),
      false,
      text,
    );
  }
});

test('parity: the graph closing words are the shared alternation (#3877)', () => {
  // The graph's KEYWORD_REFERENCE_REGEX is built from the shared alternation,
  // so the nine closing words it recognizes must all match that alternation.
  // A hard-coded graph list that drifted would fail this.
  const alternation = new RegExp(`^(?:${CLOSING_KEYWORD_ALTERNATION})$`, 'i');
  for (const word of [
    'Close',
    'Closes',
    'Closed',
    'Fix',
    'Fixes',
    'Fixed',
    'Resolve',
    'Resolves',
    'Resolved',
  ]) {
    assert.equal(alternation.test(word), true, word);
    const edges = extractKeywordReferences(`${word} #${ISSUE}`);
    assert.equal(
      edges.some((edge) => edge.relationship === 'closing-keyword'),
      true,
      `graph reads "${word} #N" as a closing edge`,
    );
  }
});

test('parity: the three D3.5 regex lines accept the colon rows and reject Refs (#3877)', () => {
  // Steps 3 and 7 of idd-pr-submit and the lite step 3 each carry one
  // `(?im)` regex in a fenced block. Read them from the template, so an edit
  // that misses one copy fails here.
  const templates = [
    'idd-template/.github/instructions/idd-pr-submit.instructions.md',
    'idd-template/.github/instructions/lite/idd-pr-submit-lite.instructions.md',
  ];
  const sources: string[] = [];
  for (const template of templates) {
    const text = readFileSync(
      fileURLToPath(new URL(`../${template}`, import.meta.url)),
      'utf8',
    );
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('(?im)')) {
        sources.push(trimmed.slice('(?im)'.length));
      }
    }
  }
  assert.equal(sources.length, 3, 'expected three D3.5 regex lines');

  for (const source of sources) {
    const pattern = new RegExp(source.replace('<N>', String(ISSUE)), 'im');
    for (const text of ['Closes: #3145', 'CLOSES: #3145', 'Closes #3145']) {
      assert.equal(pattern.test(text), true, `${source} on ${text}`);
    }
    for (const text of ['Refs #3145', 'Part of #3145']) {
      assert.equal(pattern.test(text), false, `${source} on ${text}`);
    }
  }
});
