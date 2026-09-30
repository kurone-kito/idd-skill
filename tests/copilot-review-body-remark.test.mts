import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyCopilotReviewBody,
  extractCopilotReviewBodyRemark,
} from '../src/scripts/copilot-review-body.mts';

// #3672: the remark extractor is evidence-only and deliberately not a
// BOT_WORDING_CLASSIFIERS entry, so the real corpus bodies are read here
// directly (and the expected remarks are literal strings, never derived
// from the extractor).

const CORPUS_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'bot-comment-corpus',
  'corpus.json',
);

interface CorpusEntry {
  id: string;
  botLogin: string;
  body: string;
}

const CORPUS = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusEntry[];

function corpusBody(id: string): string {
  const entry = CORPUS.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing corpus entry ${id}`);
  return entry.body;
}

test('extracts the remark paragraph from each real corpus body that carries one (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      corpusBody('copilot-legacy-suppressed1-3095'),
    ),
    'The regular-comment carve-out lacks a corresponding response and transition path for resolving maintainer decisions.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      corpusBody('copilot-legacy-suppressed3-nested-3108'),
    ),
    'There are a few small but real edge-case mismatches (hostname flag detection and GH_HOST trimming) that can cause incorrect/double host selection behavior under valid inputs.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      corpusBody('copilot-v2-previously-missed-3196'),
    ),
    'Address the documented instruction ambiguities and add the missing policy-schema coverage.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      corpusBody('copilot-v2-resolved-and-previously-missed-3174'),
    ),
    'Add cursor-repeat guards to both pagination implementations to prevent hangs on malformed or replayed responses.',
  );
});

test('returns null for every other Copilot corpus body (#3672)', () => {
  const withRemark = new Set([
    'copilot-legacy-suppressed1-3095',
    'copilot-legacy-suppressed3-nested-3108',
    'copilot-v2-previously-missed-3196',
    'copilot-v2-resolved-and-previously-missed-3174',
  ]);
  const copilotEntries = CORPUS.filter((entry) =>
    entry.botLogin.toLowerCase().startsWith('copilot'),
  );
  assert.ok(copilotEntries.length > withRemark.size);
  for (const entry of copilotEntries) {
    if (withRemark.has(entry.id)) {
      continue;
    }
    assert.equal(
      extractCopilotReviewBodyRemark(entry.body),
      null,
      `${entry.id} carries no remark`,
    );
  }
});

test('the remark does not change the classifier result it sits beside (#3672)', () => {
  // The remark is surfaced next to, never instead of, the counted block: the
  // v2 corpus body keeps its own suppressedCount.
  assert.deepEqual(
    classifyCopilotReviewBody(corpusBody('copilot-v2-previously-missed-3196')),
    { shape: 'overview-v2', suppressedCount: 1 },
  );
});

test('extracts the inline form and ignores the optional marker (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      '🔵 Needs a closer look: Extend coverage to the sibling read.',
    ),
    'Extend coverage to the sibling read.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      'Needs a closer look: Extend coverage to the sibling read.',
    ),
    'Extend coverage to the sibling read.',
  );
});

test('extracts a remark under a heading with or without the marker (#3672)', () => {
  const remark = 'The unbounded read truncates at 1000 rows.';
  for (const heading of [
    '### 🔵 Needs a closer look',
    '### Needs a closer look',
    '## needs a closer look',
  ]) {
    assert.equal(
      extractCopilotReviewBodyRemark(
        `<!-- ccr-overview-v2 -->\n\n## Copilot review overview\n\n${heading}\n\n${remark}\n\n**Review effort:** Lite  \n**Findings:** None\n`,
      ),
      remark,
      heading,
    );
  }
});

test('handles the inline label variants and a heading with inline text (#3672)', () => {
  const expected = 'Use the bounded read here.';
  for (const line of [
    '**Needs a closer look:** Use the bounded read here.',
    '**🔵 Needs a closer look:** Use the bounded read here.',
    '**Needs a closer look**: Use the bounded read here.',
    '### 🔵 Needs a closer look: Use the bounded read here.',
    '- Needs a closer look: Use the bounded read here.',
  ]) {
    assert.equal(extractCopilotReviewBodyRemark(line), expected, line);
  }
});

test('keeps a leading code span of the remark text intact (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      'Needs a closer look: `readAll()` has no row limit.',
    ),
    '`readAll()` has no row limit.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\n\nUse `a_b()` and `c`, not `d`.\n\nnext',
    ),
    'Use `a_b()` and `c`, not `d`.',
  );
});

test('joins a wrapped paragraph with single spaces (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\n\nFirst line,  \nsecond line.\n\nlater',
    ),
    'First line, second line.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      'Needs a closer look: First line,\nsecond line.\n\nlater',
    ),
    'First line, second line.',
  );
});

test('the remark paragraph stops at any line that opens another block (#3672)', () => {
  for (const next of [
    '### Next section',
    '---',
    '***',
    '___',
    '* * *',
    '> quoted',
    '- bullet',
    '* bullet',
    '+ bullet',
    '1. ordered',
    '1) ordered',
    '<details>',
    '</details>',
    '<summary>x</summary>',
    '<div>',
    '<table>',
    '<!-- comment -->',
    // The v2 overview metadata that follows a remark; CommonMark would fold
    // these into the paragraph, but they are never the remark.
    '**Review effort:** Lite  ',
    '**Findings:** None',
  ]) {
    assert.equal(
      extractCopilotReviewBodyRemark(
        `### Needs a closer look\n\nThe remark.\n${next}\n\nafter`,
      ),
      'The remark.',
      next,
    );
    assert.equal(
      extractCopilotReviewBodyRemark(
        `Needs a closer look: The remark.\n${next}\n\nafter`,
      ),
      'The remark.',
      next,
    );
    // A heading with no remark text of its own reads nothing from the block
    // that follows it.
    assert.equal(
      extractCopilotReviewBodyRemark(`### Needs a closer look\n${next}`),
      null,
      next,
    );
  }
});

test('a wrapped remark line that only looks like a block opener stays text (#3672)', () => {
  // Only block starts that CommonMark lets interrupt a paragraph end it: a
  // year with a period, a later ordered number, and an inline HTML tag do not.
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\n\nFixed in\n2026. Not before.\n\nlater',
    ),
    'Fixed in 2026. Not before.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      'Needs a closer look: Wraps here\n<code>foo</code> is used.\n\nlater',
    ),
    'Wraps here <code>foo</code> is used.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\n\n<code>foo</code> is wrong.\n\nlater',
    ),
    '<code>foo</code> is wrong.',
  );
});

test('an inline label with no same-line text is not a remark (#3672)', () => {
  // #3688 review: the label alone says nothing about which later line is
  // the remark, so it must never absorb an adjacent or following paragraph.
  for (const body of [
    'Needs a closer look:\nAn adjacent line.',
    'Needs a closer look:\n\nA following paragraph.',
    '**Needs a closer look:**\n**Review effort:** Lite  \n**Findings:** None',
    '### Needs a closer look:\n\nA paragraph under a colon heading.',
    '\u{1F535} Needs a closer look:   \n\nUnrelated.',
    // A leftover emphasis mark is not text.
    '*Needs a closer look:*\nAn adjacent line.',
    '_Needs a closer look:_\nAn adjacent line.',
    '***Needs a closer look:***\nAn adjacent line.',
    '**Needs a closer look:** **\nAn adjacent line.',
    '*Needs a closer look:*\n\nUnrelated paragraph.',
    'Needs a closer look: *\n\nx',
  ]) {
    assert.equal(extractCopilotReviewBodyRemark(body), null, body);
  }
  // A later real remark is still found past a bare label.
  assert.equal(
    extractCopilotReviewBodyRemark(
      'Needs a closer look:\n\nFirst.\n\nNeeds a closer look: Real one.',
    ),
    'Real one.',
  );
});

test('keeps a multi-line inline code span inside the remark (#3672)', () => {
  const body =
    '### Needs a closer look\n\nWith `a\n# x\nb` span.\n\nlater paragraph';
  assert.equal(extractCopilotReviewBodyRemark(body), 'With `a # x b` span.');
});

test('reads CRLF bodies without carrying a carriage return (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\r\n\r\nUse `a_b()` and `c`.\r\n\r\nx',
    ),
    'Use `a_b()` and `c`.',
  );
});

test('returns null when there is no remark text (#3672)', () => {
  for (const body of [
    null,
    undefined,
    '',
    '<!-- ccr-overview-v2 -->\n\n## Copilot review overview\n\n**Findings:** None\n',
    '### 🟢 Approval recommended\n\nLooks good.\n',
    // The heading with nothing under it.
    '### Needs a closer look\n\n### Something else\n\ntext',
    '### Needs a closer look\n',
    '### Needs a closer look\n\n<details>\n<summary>x</summary>\n</details>',
    // The label with nothing after it.
    'Needs a closer look:',
    // The phrase in ordinary prose, not a label or heading.
    'This review says it Needs a closer look: nothing',
    'Some text that needs a closer look than this.',
  ]) {
    assert.equal(extractCopilotReviewBodyRemark(body), null, String(body));
  }
});

test('never reads a label quoted in a code span or fence (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark('`🔵 Needs a closer look: quoted`'),
    null,
  );
  assert.equal(
    extractCopilotReviewBodyRemark(
      '```\n### Needs a closer look\n\nfenced remark\n```',
    ),
    null,
  );
  // A fence directly under a real heading is not skipped as blank space.
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### Needs a closer look\n```\nfenced text\n```\n\nlater paragraph',
    ),
    null,
  );
});

test('a quoted label does not hide a later real remark (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      '`Needs a closer look: quoted`\n\n### 🔵 Needs a closer look\n\nThe real remark.',
    ),
    'The real remark.',
  );
});

test('tolerates an emoji variation selector on the marker (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark(
      '### \u{1F535}\uFE0F Needs a closer look\n\nThe remark.',
    ),
    'The remark.',
  );
});

test('the inline label needs at most three leading spaces (#3672)', () => {
  assert.equal(
    extractCopilotReviewBodyRemark('   Needs a closer look: three spaces.'),
    'three spaces.',
  );
  assert.equal(
    extractCopilotReviewBodyRemark('    Needs a closer look: indented code.'),
    null,
  );
});
