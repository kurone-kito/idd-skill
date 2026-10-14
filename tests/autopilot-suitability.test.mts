import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  isAutopilotSuitabilityScore,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
  parseAutopilotSuitabilityMarker,
  rankAndRouteBySuitability,
  resolveEffortLPolicy,
} from '../src/scripts/autopilot-suitability.mts';

test('isAutopilotSuitabilityScore accepts only integers 1-5', () => {
  for (const value of [1, 2, 3, 4, 5]) {
    assert.equal(isAutopilotSuitabilityScore(value), true, `score ${value}`);
  }
  for (const value of [0, 6, 2.5, -1, NaN, null, undefined, '3', Infinity]) {
    assert.equal(
      isAutopilotSuitabilityScore(value),
      false,
      `score ${String(value)}`,
    );
  }
});

test('rankAndRouteBySuitability treats invalid finite scores as no-score (fail-safe)', () => {
  const items = [
    { id: 'zero', score: 0 },
    { id: 'six', score: 6 },
    { id: 'frac', score: 2.5 },
    { id: 'high', score: 5 },
    { id: 'low', score: 2 },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    routeBelowFloor: true,
    getScore: (item) => item.score,
  });
  // Only the genuine below-floor integer (2) is routed; 0 and 6 and 2.5
  // are no-score and stay (ranked at the floor baseline), not routed
  // despite 0 < floor.
  assert.deepEqual(
    routedToHuman.map((item) => item.id),
    ['low'],
  );
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['high', 'zero', 'six', 'frac'],
  );
});

const marker = (n: number | string, prefix = 'idd-skill') =>
  `<!-- ${prefix}-autopilot-suitability: ${n} -->`;

test('parseAutopilotSuitability reads a single in-range marker', () => {
  for (let n = 1; n <= 5; n += 1) {
    assert.equal(parseAutopilotSuitability(`body\n\n${marker(n)}`), n);
  }
});

test('parseAutopilotSuitability is prefix-aware', () => {
  assert.equal(parseAutopilotSuitability(marker(4, 'my-org'), 'my-org'), 4);
  // wrong prefix -> not found -> null
  assert.equal(
    parseAutopilotSuitability(marker(4, 'my-org'), 'idd-skill'),
    null,
  );
});

test('parseAutopilotSuitability fails safe on absent/invalid/out-of-range', () => {
  assert.equal(parseAutopilotSuitability('no marker here'), null);
  assert.equal(parseAutopilotSuitability(''), null);
  assert.equal(parseAutopilotSuitability(marker(0)), null);
  assert.equal(parseAutopilotSuitability(marker(6)), null);
  assert.equal(parseAutopilotSuitability(marker('high')), null);
  assert.equal(parseAutopilotSuitability(marker('3.5')), null);
});

test('parseAutopilotSuitability returns null on conflicting duplicate markers', () => {
  assert.equal(parseAutopilotSuitability(`${marker(4)}\n${marker(2)}`), null);
  // identical duplicates collapse to the single value
  assert.equal(parseAutopilotSuitability(`${marker(4)}\n${marker(4)}`), 4);
});

test('parseAutopilotSuitabilityMarker reports present/value/malformed per case', () => {
  // absent — no marker in the body at all
  assert.deepEqual(parseAutopilotSuitabilityMarker('no marker here'), {
    present: false,
    value: null,
    malformed: false,
  });
  // present and coherent
  assert.deepEqual(parseAutopilotSuitabilityMarker(`body\n\n${marker(3)}`), {
    present: true,
    value: 3,
    malformed: false,
  });
  // present but malformed: out of range, non-integer, non-numeric
  for (const bad of [marker(0), marker(6), marker('3.5'), marker('high')]) {
    assert.deepEqual(
      parseAutopilotSuitabilityMarker(bad),
      { present: true, value: null, malformed: true },
      `malformed: ${bad}`,
    );
  }
  // present but conflicting duplicates -> malformed
  assert.deepEqual(
    parseAutopilotSuitabilityMarker(`${marker(4)}\n${marker(2)}`),
    {
      present: true,
      value: null,
      malformed: true,
    },
  );
  // identical duplicates collapse to a single coherent value
  assert.deepEqual(
    parseAutopilotSuitabilityMarker(`${marker(4)}\n${marker(4)}`),
    {
      present: true,
      value: 4,
      malformed: false,
    },
  );
});

test('parseAutopilotSuitabilityMarker ignores a marker quoted inside code regions (#1614)', () => {
  // The #1614 shape (mirroring #1121's identical fix for the roadmap-id
  // marker): an issue *about* the marker syntax that quotes an example —
  // including an invalid one — inside code, alongside a real footer
  // marker elsewhere in the body. The code-quoted example must not be
  // read as a real marker and must not poison the real one to malformed.
  const inlineQuoted = [
    '## Background',
    '',
    `A drafted issue must end with a trailing \`${marker('N')}\` marker.`,
    '',
    marker(3),
  ].join('\n');
  assert.deepEqual(parseAutopilotSuitabilityMarker(inlineQuoted), {
    present: true,
    value: 3,
    malformed: false,
  });

  // Same for a marker quoted inside a fenced code block.
  const fencedQuoted = [
    'Example marker:',
    '',
    '```html',
    marker('N'),
    '```',
    '',
    marker(5),
  ].join('\n');
  assert.deepEqual(parseAutopilotSuitabilityMarker(fencedQuoted), {
    present: true,
    value: 5,
    malformed: false,
  });

  // A code-quoted marker alone (no real marker elsewhere) still reports
  // absent, not malformed -- the quoted example is masked out entirely.
  const onlyQuoted = `See the \`${marker('N')}\` format.`;
  assert.deepEqual(parseAutopilotSuitabilityMarker(onlyQuoted), {
    present: false,
    value: null,
    malformed: false,
  });
});

test('parseAutopilotSuitabilityMarker is prefix-aware', () => {
  assert.deepEqual(
    parseAutopilotSuitabilityMarker(marker(4, 'my-org'), 'my-org'),
    {
      present: true,
      value: 4,
      malformed: false,
    },
  );
  // wrong prefix -> not present
  assert.deepEqual(
    parseAutopilotSuitabilityMarker(marker(4, 'my-org'), 'idd-skill'),
    { present: false, value: null, malformed: false },
  );
});

test('parseAutopilotSuitability is the value-only view of the shared marker parser', () => {
  const bodies = [
    'no marker here',
    '',
    `body\n\n${marker(1)}`,
    marker(5),
    marker(0),
    marker(6),
    marker('high'),
    marker('3.5'),
    `${marker(4)}\n${marker(2)}`,
    `${marker(4)}\n${marker(4)}`,
  ];
  for (const body of bodies) {
    assert.equal(
      parseAutopilotSuitability(body),
      parseAutopilotSuitabilityMarker(body).value,
      `value equivalence: ${JSON.stringify(body)}`,
    );
  }
});

test('normalizeAutopilotSuitabilityFloor clamps to default for bad input', () => {
  assert.equal(normalizeAutopilotSuitabilityFloor(4), 4);
  assert.equal(
    normalizeAutopilotSuitabilityFloor(0),
    DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  );
  assert.equal(
    normalizeAutopilotSuitabilityFloor(6),
    DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  );
  assert.equal(
    normalizeAutopilotSuitabilityFloor(2.5),
    DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  );
  assert.equal(
    normalizeAutopilotSuitabilityFloor(undefined),
    DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  );
});

test('rankAndRouteBySuitability ranks high first and routes below-floor to humans (autopilot)', () => {
  const items = [
    { id: 'a', score: 2 },
    { id: 'b', score: 5 },
    { id: 'c', score: 3 },
    { id: 'd', score: 1 },
    { id: 'e', score: 4 },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    routeBelowFloor: true,
    getScore: (item) => item.score,
  });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['b', 'e', 'c'],
  );
  assert.deepEqual(
    routedToHuman.map((item) => item.id),
    ['a', 'd'],
  );
});

test('rankAndRouteBySuitability keeps below-floor items ranked last when routing is off (attended)', () => {
  const items = [
    { id: 'a', score: 2 },
    { id: 'b', score: 5 },
    { id: 'c', score: 3 },
    { id: 'd', score: 1 },
    { id: 'e', score: 4 },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    getScore: (item) => item.score,
  });
  // Nothing routed out; below-floor (2, 1) sink to the bottom by real score.
  assert.deepEqual(routedToHuman, []);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['b', 'e', 'c', 'a', 'd'],
  );
});

test('rankAndRouteBySuitability never routes or buries unscored items (fail-safe)', () => {
  const items = [
    { id: 'scored5', score: 5 },
    { id: 'unscored1', score: null },
    { id: 'scored1', score: 1 },
    { id: 'unscored2', score: null },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    routeBelowFloor: true,
    getScore: (item) => item.score,
  });
  // Only the real below-floor score is routed out; unscored never are.
  assert.deepEqual(
    routedToHuman.map((item) => item.id),
    ['scored1'],
  );
  // Unscored use the floor as a neutral baseline: ranked below 5, and
  // stable relative to each other and to floor-level scores.
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['scored5', 'unscored1', 'unscored2'],
  );
});

test('rankAndRouteBySuitability ranks a genuinely floor-scored candidate above an unscored one at a tie', () => {
  // Mirrors the written A4 Step 2 rule and compareUnionLeaves in
  // discover-roadmap-graph.mts: a genuinely-scored candidate never ranks
  // below an unscored candidate defaulted to the floor, even though the
  // unscored candidate has a lower input index.
  const items = [
    { id: '#10', score: null },
    { id: '#20', score: 3 },
  ];
  const { ranked } = rankAndRouteBySuitability(items, {
    floor: 3,
    getScore: (item) => item.score,
  });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['#20', '#10'],
  );
});

test('rankAndRouteBySuitability applies the scored-vs-unscored term before the effort-hint tie-break', () => {
  // discover-orphan-filter.mts pre-sorts candidates by effort-then-number
  // before calling rankAndRouteBySuitability (ties keep input order). This
  // reproduces that pre-sorted input: an unscored `S`-effort candidate
  // would sort first by the soft effort tie-break alone, but a genuinely
  // floor-scored `M`-effort candidate must still win the tie, per the
  // written rule ordering (score band -> scored-before-unscored ->
  // effort/number).
  const items = [
    { id: 'unscored-S', score: null },
    { id: 'scored-M', score: 3 },
  ];
  const { ranked } = rankAndRouteBySuitability(items, {
    floor: 3,
    getScore: (item) => item.score,
  });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['scored-M', 'unscored-S'],
  );
});

test('rankAndRouteBySuitability honors the enabled kill-switch', () => {
  const items = [
    { id: 'a', score: 1 },
    { id: 'b', score: 5 },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    enabled: false,
    getScore: (item) => item.score,
  });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['a', 'b'],
  );
  assert.deepEqual(routedToHuman, []);
});

test('rankAndRouteBySuitability is stable for equal effective scores', () => {
  const items = [
    { id: 'first', score: 4 },
    { id: 'second', score: 4 },
    { id: 'third', score: 4 },
  ];
  const { ranked } = rankAndRouteBySuitability(items, {
    floor: 3,
    getScore: (item) => item.score,
  });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['first', 'second', 'third'],
  );
});

test('resolveEffortLPolicy returns refuse only for an exact refuse value', () => {
  assert.equal(
    resolveEffortLPolicy({ autopilotSuitability: { effortL: 'refuse' } }),
    'refuse',
  );
});

test('resolveEffortLPolicy defaults to allow when the field or section is absent (opt-in)', () => {
  assert.equal(resolveEffortLPolicy({}), 'allow');
  assert.equal(resolveEffortLPolicy({ autopilotSuitability: {} }), 'allow');
  assert.equal(
    resolveEffortLPolicy({ autopilotSuitability: { effortL: 'allow' } }),
    'allow',
  );
});

test('resolveEffortLPolicy fails safe to allow for any non-exact or malformed input', () => {
  assert.equal(
    resolveEffortLPolicy({ autopilotSuitability: { effortL: 'REFUSE' } }),
    'allow',
  );
  assert.equal(resolveEffortLPolicy(null), 'allow');
  assert.equal(resolveEffortLPolicy('refuse'), 'allow');
  assert.equal(resolveEffortLPolicy(undefined), 'allow');
});

interface EffortCandidate {
  id: string;
  score: number;
  effort: 'S' | 'M' | 'L';
}

const effortCandidates: EffortCandidate[] = [
  { id: 'a', score: 5, effort: 'L' },
  { id: 'b', score: 4, effort: 'S' },
  { id: 'c', score: 3, effort: 'M' },
];

test('rankAndRouteBySuitability routes effort L items to humans with routeEffortL (#4199)', () => {
  const options = {
    floor: 3,
    getScore: (item: EffortCandidate) => item.score,
    getEffort: (item: EffortCandidate) => item.effort,
    routeEffortL: true,
  };
  const ranked = rankAndRouteBySuitability(effortCandidates, {
    ...options,
    enabled: true,
  });
  assert.deepEqual(
    ranked.ranked.map((item) => item.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    ranked.routedToHuman.map((item) => item.id),
    ['a'],
  );

  // Effort is a separate axis, so L routing still applies under the
  // score kill-switch, which otherwise returns every item unchanged.
  const killSwitch = rankAndRouteBySuitability(effortCandidates, {
    ...options,
    enabled: false,
  });
  assert.deepEqual(
    killSwitch.ranked.map((item) => item.id),
    ['b', 'c'],
  );
  assert.deepEqual(
    killSwitch.routedToHuman.map((item) => item.id),
    ['a'],
  );
});

test('rankAndRouteBySuitability leaves effort L items ranked without routeEffortL (#4199)', () => {
  const options = {
    floor: 3,
    getScore: (item: EffortCandidate) => item.score,
    getEffort: (item: EffortCandidate) => item.effort,
  };
  for (const enabled of [true, false]) {
    const { ranked, routedToHuman } = rankAndRouteBySuitability(
      effortCandidates,
      { ...options, enabled },
    );
    assert.deepEqual(routedToHuman, [], `enabled=${enabled}`);
    assert.deepEqual(
      ranked.map((item) => item.id),
      ['a', 'b', 'c'],
      `enabled=${enabled}`,
    );
  }
});

test('rankAndRouteBySuitability routes an effort L item once when it is also below floor (#4199)', () => {
  const items: EffortCandidate[] = [
    { id: 'x', score: 1, effort: 'L' },
    { id: 'y', score: 1, effort: 'S' },
    { id: 'z', score: 4, effort: 'L' },
    { id: 'w', score: 4, effort: 'M' },
  ];
  const { ranked, routedToHuman } = rankAndRouteBySuitability(items, {
    floor: 3,
    routeBelowFloor: true,
    getScore: (item) => item.score,
    getEffort: (item) => item.effort,
    routeEffortL: true,
  });
  // Input order is kept; x is routed by both rules but appears once.
  assert.deepEqual(
    routedToHuman.map((item) => item.id),
    ['x', 'y', 'z'],
  );
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['w'],
  );
});

test('rankAndRouteBySuitability ignores routeEffortL when no getEffort is given (#4199)', () => {
  const { ranked, routedToHuman } = rankAndRouteBySuitability(
    effortCandidates,
    {
      floor: 3,
      getScore: (item) => item.score,
      routeEffortL: true,
    },
  );
  assert.deepEqual(routedToHuman, []);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['a', 'b', 'c'],
  );
});
