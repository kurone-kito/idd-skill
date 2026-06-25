import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EFFORT_HINTS,
  effortOrdinal,
  isEffortHint,
  NEUTRAL_EFFORT_ORDINAL,
  parseEffort,
  parseEffortMarker,
} from '../src/scripts/effort.mts';

test('isEffortHint accepts only the S | M | L bands', () => {
  for (const hint of EFFORT_HINTS) {
    assert.equal(isEffortHint(hint), true, `hint ${hint}`);
  }
  for (const value of ['s', 'XL', '', 'SM', 1, null, undefined, {}]) {
    assert.equal(isEffortHint(value), false, `rejects ${String(value)}`);
  }
});

test('effortOrdinal orders S < M < L and resolves non-hints to the neutral middle', () => {
  assert.equal(effortOrdinal('S'), 1);
  assert.equal(effortOrdinal('M'), 2);
  assert.equal(effortOrdinal('L'), 3);
  // A missing or invalid hint sorts as-if M, so an unscored issue is neither
  // preferred over nor de-preferred against an equally-ranked M issue.
  assert.equal(effortOrdinal(null), NEUTRAL_EFFORT_ORDINAL);
  assert.equal(effortOrdinal('bogus'), NEUTRAL_EFFORT_ORDINAL);
  assert.equal(effortOrdinal(undefined), NEUTRAL_EFFORT_ORDINAL);
  assert.equal(NEUTRAL_EFFORT_ORDINAL, effortOrdinal('M'));
});

test('parseEffort reads a single coherent marker (case-insensitive)', () => {
  assert.equal(parseEffort('intro\n\n<!-- idd-skill-effort: S -->'), 'S');
  assert.equal(parseEffort('<!-- idd-skill-effort: M -->'), 'M');
  // Lower-case is normalized to the canonical upper-case band.
  assert.equal(parseEffort('<!-- idd-skill-effort: l -->'), 'L');
});

test('parseEffort is prefix-aware', () => {
  assert.equal(parseEffort('<!-- acme-effort: L -->', 'acme'), 'L');
  // The default prefix marker is not read under a custom prefix.
  assert.equal(parseEffort('<!-- idd-skill-effort: L -->', 'acme'), null);
});

test('parseEffort fails safe on absent or invalid markers', () => {
  assert.equal(parseEffort('no marker here'), null);
  assert.equal(parseEffort('<!-- idd-skill-effort: XL -->'), null);
  assert.equal(parseEffort('<!-- idd-skill-effort: 2 -->'), null);
  assert.equal(parseEffort('<!-- idd-skill-effort:  -->'), null);
  assert.equal(parseEffort(null), null);
  assert.equal(parseEffort(undefined), null);
});

test('parseEffort returns null on conflicting duplicate markers', () => {
  assert.equal(
    parseEffort('<!-- idd-skill-effort: S -->\n<!-- idd-skill-effort: L -->'),
    null,
  );
  // Agreeing duplicates keep the coherent value.
  assert.equal(
    parseEffort('<!-- idd-skill-effort: M -->\n<!-- idd-skill-effort: M -->'),
    'M',
  );
});

test('parseEffortMarker reports present/value/malformed per case', () => {
  assert.deepEqual(parseEffortMarker('<!-- idd-skill-effort: S -->'), {
    present: true,
    value: 'S',
    malformed: false,
  });
  assert.deepEqual(parseEffortMarker('no marker'), {
    present: false,
    value: null,
    malformed: false,
  });
  assert.deepEqual(parseEffortMarker('<!-- idd-skill-effort: XL -->'), {
    present: true,
    value: null,
    malformed: true,
  });
  assert.deepEqual(
    parseEffortMarker(
      '<!-- idd-skill-effort: S -->\n<!-- idd-skill-effort: L -->',
    ),
    { present: true, value: null, malformed: true },
  );
});

test('parseEffort is the value-only view of the shared marker parser', () => {
  for (const body of [
    '<!-- idd-skill-effort: S -->',
    '<!-- idd-skill-effort: bogus -->',
    'nothing',
  ]) {
    assert.equal(parseEffort(body), parseEffortMarker(body).value);
  }
});
