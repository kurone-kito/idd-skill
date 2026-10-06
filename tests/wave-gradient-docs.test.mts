import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decideUrgencyDefer,
  relaxStepForReviewCount,
} from '../src/scripts/policy-helpers.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(collapse);
}

const POLICY_CONSTANTS = [
  'idd-template/docs/policy-constants.md',
  'docs/policy-constants.md',
] as const;
const CUSTOMIZATION = [
  'idd-template/docs/customization.md',
  'docs/customization.md',
] as const;
const RATIONALE = [
  'idd-template/docs/idd-design-rationale.md',
  'docs/idd-design-rationale.md',
] as const;

const WAVE_HEADING =
  '#### Wave-gradient urgency defer (kurone-kito/idd-skill#3796)';

test('the schema description of deferByUrgency introduces High-at-very-low as step 0 and names the field (#3796)', () => {
  const schema = JSON.parse(read('schemas/policy.schema.json')) as {
    properties: {
      critiqueLoop: { properties: { deferByUrgency: { description: string } } };
    };
  };
  const description = collapse(
    schema.properties.critiqueLoop.properties.deferByUrgency.description,
  );
  assert.ok(description.includes('relax step 0'), description);
  assert.ok(description.includes('`deferRelaxAtRounds`'), description);
  assert.equal(
    description.includes('including High only at urgency `very-low`'),
    false,
    'the unqualified High statement must not return',
  );
});

test('the policy-constants rows keep High-at-very-low at step 0 and state the new field and its default (#3796)', () => {
  for (const path of POLICY_CONSTANTS) {
    const rows = read(path).split('\n').map(collapse);
    const adoptNow = rows.find((row) =>
      row.startsWith('| E4/E5 adopt-now urgency defer '),
    );
    assert.ok(adoptNow, `${path} carries the adopt-now row`);
    assert.ok(
      adoptNow.includes('High only at `very-low` at step 0'),
      `${path}: the adopt-now row introduces the High statement as step 0`,
    );
    const wave = rows.find((row) =>
      row.startsWith('| E4/E5 wave-gradient urgency defer '),
    );
    assert.ok(wave, `${path} carries the wave-gradient row`);
    assert.ok(
      wave.includes('`critiqueLoop.deferRelaxAtRounds` is unset by default'),
      wave,
    );
    assert.ok(wave.includes('omit the key for off'), 'the default is stated');
    assert.ok(
      wave.includes('an explicit `[]` fails schema validation'),
      'the empty array is called out, as the legacyRoots row does',
    );
    assert.equal(
      /(\d{1,3}(?:,\d{3})+|\d{4,})\s*bytes?\b/i.test(wave),
      false,
      'the doc budget guard rejects a "N bytes" figure that is not a manifest budget',
    );
  }
});

test('the customization bullet states the field contract (#3796)', () => {
  for (const path of CUSTOMIZATION) {
    const lines = read(path).split('\n');
    const first = lines.findIndex((line) =>
      line.startsWith('- `critiqueLoop.deferRelaxAtRounds`'),
    );
    assert.notEqual(first, -1, `${path} carries the deferRelaxAtRounds bullet`);
    // A bullet runs until the next top-level bullet or a blank line.
    let last = first + 1;
    while (
      last < lines.length &&
      lines[last] !== '' &&
      !lines[last].startsWith('- ')
    ) {
      last += 1;
    }
    const bullet = collapse(lines.slice(first, last).join('\n'));
    for (const phrase of [
      'strictly ascending, at most two',
      'omit the key to turn it off',
      'an invalid value means off',
    ]) {
      assert.ok(bullet.includes(phrase), `${path}: bullet states "${phrase}"`);
    }
  }
});

test('both rationale copies introduce the severity-tiered matrix as step 0 and carry the wave-gradient subsection in the same place (#3796)', () => {
  for (const path of RATIONALE) {
    const text = read(path);
    const matrixParagraph = paragraphs(text).find((paragraph) =>
      paragraph.startsWith('`severity-tiered` is a third `deferByUrgency`'),
    );
    assert.ok(matrixParagraph, `${path} carries the severity-tiered paragraph`);
    assert.ok(matrixParagraph.includes('At relax step 0'), path);
    assert.ok(
      matrixParagraph.includes('`critiqueLoop.deferRelaxAtRounds`'),
      path,
    );

    const lines = text.split('\n');
    assert.equal(
      lines.filter((line) => line === WAVE_HEADING).length,
      1,
      `${path} carries the heading once`,
    );
    const headings = lines.filter((line) => /^#{2,4} /.test(line));
    const at = headings.indexOf(WAVE_HEADING);
    assert.equal(
      headings[at - 1],
      '#### Severity-tiered urgency (kurone-kito/idd-skill#3589)',
      `${path}: the subsection follows Severity-tiered urgency`,
    );
    assert.equal(
      headings[at + 1],
      '### Needs-decision deferral of review findings (kurone-kito/idd-skill#3776)',
      `${path}: the subsection precedes Needs-decision deferral`,
    );
  }
});

test('the rationale worked table matches the reference implementation for review counts 1 to 11 (#3796)', () => {
  for (const path of RATIONALE) {
    const text = read(path);
    const start = text.indexOf(WAVE_HEADING);
    assert.notEqual(start, -1, path);
    const end = text.indexOf('\n### ', start);
    const section = text.slice(start, end);
    assert.ok(section.includes('kurone-kito/setup.ubuntu#201'), path);
    assert.ok(section.includes('`25e3d5e`'), path);

    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim().replaceAll('`', '')),
      )
      .filter((cells) => /^\d+$/.test(cells[0]));
    assert.deepEqual(
      rows.map((cells) => Number(cells[0])),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      `${path}: one row per review count`,
    );

    const result = (input: Parameters<typeof decideUrgencyDefer>[0]) =>
      decideUrgencyDefer(input).defer ? 'defers' : 'stays';
    const base = {
      mode: 'severity-tiered' as const,
      path: 'A' as const,
      copilotLabel: null,
      scopeFence: false,
      protectedAuthority: false,
      awaitingMaintainerDecision: false,
      acceptedMidFix: false,
      adoptNow: false,
    };
    for (const [count, step, low, medium, high, highHigh, safety] of rows) {
      const relaxStep = relaxStepForReviewCount(Number(count), [4, 7]);
      const label = `${path} count ${count}`;
      assert.equal(Number(step), relaxStep, `${label}: step`);
      assert.equal(
        low,
        result({ ...base, e4Severity: 'low', urgency: 'high', relaxStep }),
        `${label}: Low-tier, high urgency`,
      );
      assert.equal(
        medium,
        result({ ...base, e4Severity: 'medium', urgency: 'high', relaxStep }),
        `${label}: Medium-tier, high urgency`,
      );
      assert.equal(
        high,
        result({ ...base, e4Severity: 'high', urgency: 'medium', relaxStep }),
        `${label}: High-tier, medium urgency`,
      );
      assert.equal(
        highHigh,
        result({ ...base, e4Severity: 'high', urgency: 'high', relaxStep }),
        `${label}: High-tier, high urgency`,
      );
      assert.equal(
        safety,
        result({
          ...base,
          e4Severity: 'low',
          urgency: 'low',
          relaxStep,
          safetyClass: true,
        }),
        `${label}: safety class, Low-tier, low urgency`,
      );
    }
  }
});
