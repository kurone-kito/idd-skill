import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EFFORT_CANDIDATE_FILE_LIMITS } from '../src/scripts/audit-authored-issue.mts';
import {
  assessProvisionalChoicePlan,
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  findApprovalRequirementSentence,
  isAutopilotSuitabilityScore,
  isDecisionCausedSignal,
  isEligibleProvisionalAssessment,
  normalizeAutopilotSuitabilityFloor,
  PROVISIONAL_SURFACE_LIMITS,
  type ProvisionalAssessmentInput,
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

// --- #4535: provisional choice plan assessment --------------------------
//
// Each test names the acceptance criterion (AC1-AC5) or verdict-table row
// (row 1-6) of issue #4535 that it covers.

const SOURCE_BODY =
  'Which cache layer should we use? This is a decision.\n\n## Acceptance criteria\n\n- [ ] a maintainer picks the layer\n';
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const planOption = (id: string): Record<string, string> => ({
  id,
  description: `Option ${id} behavior`,
  feasibilityRationale: 'feasible in this repository',
  requirementFit: 'fits the stated need',
  consequences: 'a known cost',
  verification: 'a unit test',
  reversalOrMigration: 'none needed',
});
const planChoice = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  question: 'Which cache layer?',
  selectedOption: { ...planOption('keep'), rationale: 'best fit' },
  feasibleAlternatives: [
    {
      ...planOption('swap'),
      comparison: 'slower to ship',
      rejectionReason: 'costs more',
    },
  ],
  executionCriteria: ['pnpm test passes for the cache module'],
  ...overrides,
});
const validPlan = (
  overrides: Record<string, unknown> = {},
  body = SOURCE_BODY,
): Record<string, unknown> => ({
  schemaVersion: 1,
  source: { repository: 'o/r', issueNumber: 7, bodySha256: sha256(body) },
  humanChoiceCriteria: ['a maintainer picks the layer'],
  recordedChoices: [],
  choices: [planChoice()],
  deliverables: [{ kind: 'file', target: 'src/cache.mts', purpose: 'edit' }],
  evidence: ['src/cache.mts:10'],
  evidenceGaps: [],
  independentObstacles: [],
  ...overrides,
});
const trustedReport = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: 'readable',
  source: 'repository',
  ref: 'main',
  master: 'enabled',
  classes: { decisionIssue: 'enabled' },
  maxDecisionsPerClaim: 3,
  ...overrides,
});
const noRecords = {
  valid: true,
  hasRecords: false,
  status: 'none',
  hasRework: false,
  decisions: [],
};
const assessInput = (
  overrides: Partial<ProvisionalAssessmentInput> = {},
): ProvisionalAssessmentInput => ({
  issue: {
    number: 7,
    body: SOURCE_BODY,
    labels: ['status:needs-decision'],
  },
  repository: 'o/r',
  needsDecisionLabelName: 'status:needs-decision',
  policy: trustedReport(),
  state: noRecords,
  plan: validPlan(),
  authoredScore: 4,
  floor: 3,
  effort: 'M',
  effortLPolicy: 'allow',
  ...overrides,
});
const SOURCE_ISSUE = { number: 7, body: SOURCE_BODY };
const blockerCodes = (
  assessment: ReturnType<typeof assessProvisionalChoicePlan>,
): string[] => assessment.blockers.map((blocker) => blocker.code);

test('provisional assessment: an eligible plan returns an auditable candidate plan (AC1, row 1)', () => {
  const assessment = assessProvisionalChoicePlan(assessInput());
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.route, 'claim-and-record');
  assert.deepEqual(assessment.blockers, []);
  assert.equal(isEligibleProvisionalAssessment(assessment, SOURCE_ISSUE), true);
  assert.equal(assessment.plan?.choices.length, 1);
  assert.equal(assessment.plan?.choices[0]?.feasibleAlternatives.length, 1);
  assert.deepEqual(assessment.plan?.deliverables, [
    { kind: 'file', target: 'src/cache.mts', purpose: 'edit' },
  ]);
  assert.deepEqual(assessment.policy, {
    decisionIssue: 'enabled',
    maxDecisionsPerClaim: 3,
  });
  assert.deepEqual(assessment.caps, {
    choices: 1,
    decisionGenerationsAfterSelection: 1,
    maxDecisionsPerClaim: 3,
  });
  assert.equal(assessment.source.bodySha256, sha256(SOURCE_BODY));
});

test('provisional assessment: the original human-choice criteria stay pending (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(assessInput());
  assert.deepEqual(assessment.pendingHumanCriteria, [
    'a maintainer picks the layer',
  ]);
  assert.deepEqual(assessment.plan?.humanChoiceCriteria, [
    { text: 'a maintainer picks the layer', status: 'pending' },
  ]);
  // A plan cannot claim approval: an unknown key is refused outright.
  const claimed = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({ approvedBy: 'maintainer' }) }),
  );
  assert.equal(claimed.eligible, false);
  assert.deepEqual(blockerCodes(claimed), ['plan-malformed']);
  const satisfied = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        humanChoiceCriteria: [],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(satisfied), ['human-criteria-missing']);
});

test('provisional assessment: a persist-after-claim next step is the only route forward (AC5)', () => {
  const eligible = assessProvisionalChoicePlan(assessInput());
  assert.equal(eligible.nextStep, 'claim-then-persist-selection');
  const refused = assessProvisionalChoicePlan(assessInput({ plan: undefined }));
  assert.equal(refused.nextStep, null);
  assert.equal(refused.plan, null);
});

test('provisional assessment: a single-option plan is refused (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({ choices: [planChoice({ feasibleAlternatives: [] })] }),
    }),
  );
  assert.equal(assessment.eligible, false);
  assert.deepEqual(blockerCodes(assessment), ['alternatives-insufficient']);
  assert.equal(assessment.route, 'current-route');
});

test('provisional assessment: repeated option ids or descriptions are not distinct (AC1)', () => {
  const sameId = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        choices: [
          planChoice({
            feasibleAlternatives: [
              {
                ...planOption('keep'),
                description: 'Option swap behavior',
                comparison: 'c',
                rejectionReason: 'r',
              },
            ],
          }),
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(sameId), ['options-not-distinct']);
  const sameText = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        choices: [
          planChoice({
            feasibleAlternatives: [
              {
                ...planOption('swap'),
                description: '  OPTION keep   behavior ',
                comparison: 'c',
                rejectionReason: 'r',
              },
            ],
          }),
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(sameText), ['options-not-distinct']);
});

test('provisional assessment: a missing recommendation is never filled in (AC1, AC2)', () => {
  const choice = planChoice();
  delete choice.selectedOption;
  const assessment = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({ choices: [choice] }) }),
  );
  assert.equal(assessment.eligible, false);
  assert.deepEqual(blockerCodes(assessment), ['plan-malformed']);
  assert.match(assessment.blockers[0]?.detail ?? '', /selectedOption/);
});

test('provisional assessment: missing deliverables, evidence and criteria are refused (AC1)', () => {
  assert.deepEqual(
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({ plan: validPlan({ deliverables: [] }) }),
      ),
    ),
    ['deliverables-missing'],
  );
  assert.deepEqual(
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({ plan: validPlan({ evidence: [] }) }),
      ),
    ),
    ['evidence-missing'],
  );
  assert.deepEqual(
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({
          plan: validPlan({ choices: [planChoice({ executionCriteria: [] })] }),
        }),
      ),
    ),
    ['criteria-missing'],
  );
  assert.deepEqual(
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({ plan: validPlan({ choices: [] }) }),
      ),
    ),
    ['choices-missing'],
  );
});

test('provisional assessment: a criterion that needs a person is not objective (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        choices: [
          planChoice({ executionCriteria: ['the maintainer approves it'] }),
        ],
      }),
    }),
  );
  // "approves" is both an opinion and an approval, so both findings stand.
  assert.deepEqual(blockerCodes(assessment), [
    'criteria-subjective',
    'criteria-needs-approval',
  ]);
});

test('provisional assessment: a deliverable path must stay inside the repository (AC1)', () => {
  for (const target of [
    '/etc/passwd',
    '../outside.mts',
    'a/`b`.mts',
    'C:/outside/file.mts',
    'c:file.mts',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          deliverables: [{ kind: 'file', target, purpose: 'edit' }],
        }),
      }),
    );
    assert.deepEqual(blockerCodes(assessment), ['plan-malformed'], target);
  }
});

test('provisional assessment: an evidence gap without a measurement blocks (AC2)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [{ description: 'latency under load is unknown' }],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['evidence-gap']);
});

test('provisional assessment: an authorized measurement is proposed, never assumed (AC2)', () => {
  const measurement = {
    description: 'run the benchmark',
    authorized: true,
    status: 'proposed',
  };
  const proposed = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [{ description: 'latency', measurement }],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(proposed), ['measurement-needed']);
  // A result without a run is a claim, not evidence.
  const claimed = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [
          {
            description: 'latency',
            measurement: { ...measurement, result: '12 ms' },
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(claimed), ['measurement-unverified']);
  const runWithoutReference = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [
          {
            description: 'latency',
            measurement: { ...measurement, status: 'run', result: '12 ms' },
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(runWithoutReference), [
    'measurement-unverified',
  ]);
  const unauthorized = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [
          {
            description: 'latency',
            measurement: { ...measurement, authorized: false },
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(unauthorized), ['evidence-gap']);
});

test('provisional assessment: a measurement that was run closes its gap (AC2)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [
          {
            description: 'latency',
            measurement: {
              description: 'run the benchmark',
              authorized: true,
              status: 'run',
              result: '12 ms p95',
              reference: 'bench-output.txt',
            },
          },
        ],
      }),
    }),
  );
  assert.equal(assessment.eligible, true);
  assert.deepEqual(assessment.plan?.resolvedEvidenceGaps, [
    {
      description: 'latency',
      measurement: 'run the benchmark',
      result: '12 ms p95',
      reference: 'bench-output.txt',
    },
  ]);
});

test('provisional assessment: an unavailable measurement blocks (verdict table)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        evidenceGaps: [
          {
            description: 'production traffic shape',
            measurement: {
              description: 'read production metrics',
              authorized: true,
              status: 'unavailable',
            },
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['measurement-unavailable']);
});

test('provisional assessment: a recorded operator choice must be listed and respected (AC2)', () => {
  const recordsChoice = assessProvisionalChoicePlan(
    assessInput({ bodyRecordsOperatorChoice: true }),
  );
  assert.deepEqual(blockerCodes(recordsChoice), [
    'recorded-choice-unacknowledged',
  ]);
  const contradicted = assessProvisionalChoicePlan(
    assessInput({
      bodyRecordsOperatorChoice: true,
      plan: validPlan({
        recordedChoices: [
          {
            reference: 'Which cache layer should we use?',
            summary: 'keep Redis',
            respected: false,
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(contradicted), [
    'recorded-choice-contradicted',
  ]);
  const respected = assessProvisionalChoicePlan(
    assessInput({
      bodyRecordsOperatorChoice: true,
      plan: validPlan({
        recordedChoices: [
          {
            reference: 'Which cache layer should we use?',
            summary: 'keep Redis',
            respected: true,
          },
        ],
      }),
    }),
  );
  assert.equal(respected.eligible, true);
  assert.deepEqual(respected.plan?.recordedChoices, [
    { reference: 'Which cache layer should we use?', summary: 'keep Redis' },
  ]);
});

test('provisional assessment: a plan for another issue or body snapshot is stale (AC5)', () => {
  const otherBody = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({}, 'a different body') }),
  );
  assert.deepEqual(blockerCodes(otherBody), ['plan-stale']);
  assert.match(
    otherBody.blockers[0]?.detail ?? '',
    new RegExp(sha256(SOURCE_BODY)),
  );
  const otherIssue = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        source: {
          repository: 'o/r',
          issueNumber: 8,
          bodySha256: sha256(SOURCE_BODY),
        },
      }),
    }),
  );
  assert.deepEqual(blockerCodes(otherIssue), ['plan-stale']);
  const otherRepo = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        source: {
          repository: 'x/y',
          issueNumber: 7,
          bodySha256: sha256(SOURCE_BODY),
        },
      }),
    }),
  );
  assert.deepEqual(blockerCodes(otherRepo), ['plan-stale']);
});

test('provisional assessment: flag false or absent keeps the current route (row 2)', () => {
  for (const report of [
    trustedReport({
      master: 'disabled',
      classes: { decisionIssue: 'master-off' },
    }),
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({ policy: report }),
    );
    assert.equal(assessment.eligible, false);
    assert.equal(assessment.route, 'current-route');
    assert.deepEqual(blockerCodes(assessment), ['master-off']);
    assert.equal(assessment.plan, null);
  }
});

test('provisional assessment: a class that is absent, off or unreadable keeps the current route (row 3)', () => {
  const classOff = assessProvisionalChoicePlan(
    assessInput({
      policy: trustedReport({ classes: { decisionIssue: 'class-off' } }),
    }),
  );
  assert.deepEqual(blockerCodes(classOff), ['class-off']);
  const classAbsent = assessProvisionalChoicePlan(
    assessInput({ policy: trustedReport({ classes: {} }) }),
  );
  assert.deepEqual(blockerCodes(classAbsent), ['policy-unreadable']);
  const unreadable = assessProvisionalChoicePlan(
    assessInput({
      policy: {
        status: 'unreadable',
        classes: { decisionIssue: 'unreadable' },
      },
    }),
  );
  assert.deepEqual(blockerCodes(unreadable), ['policy-unreadable']);
  for (const policy of [undefined, null, 'enabled', []]) {
    const assessment = assessProvisionalChoicePlan(assessInput({ policy }));
    assert.deepEqual(blockerCodes(assessment), ['policy-unreadable']);
    assert.equal(assessment.eligible, false);
  }
});

test('provisional assessment: choices above the trusted cap, or an unreadable cap, keep the current route (row 4)', () => {
  const four = [planChoice(), planChoice(), planChoice(), planChoice()];
  const overCap = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({ choices: four }) }),
  );
  assert.equal(overCap.eligible, false);
  assert.deepEqual(blockerCodes(overCap), ['cap-exceeded']);
  assert.equal(overCap.caps.maxDecisionsPerClaim, 3);
  const noCap = assessProvisionalChoicePlan(
    assessInput({ policy: trustedReport({ maxDecisionsPerClaim: undefined }) }),
  );
  assert.deepEqual(blockerCodes(noCap), ['cap-unreadable']);
  for (const cap of [0, -1, 2.5, '3', null]) {
    const bad = assessProvisionalChoicePlan(
      assessInput({ policy: trustedReport({ maxDecisionsPerClaim: cap }) }),
    );
    assert.deepEqual(blockerCodes(bad), ['cap-unreadable'], String(cap));
  }
});

test('provisional assessment: several choices within the cap stay eligible (AC4, row 1)', () => {
  const three = [planChoice(), planChoice(), planChoice()];
  const assessment = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({ choices: three }) }),
  );
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.caps.choices, 3);
  assert.equal(assessment.caps.decisionGenerationsAfterSelection, 3);
});

test('provisional assessment: an already-complete source starts nothing new (row 6)', () => {
  const pending = assessProvisionalChoicePlan(
    assessInput({
      state: {
        valid: true,
        hasRecords: true,
        status: 'confirmation-pending',
        hasRework: false,
        decisions: [
          {
            bundleGeneration: 1,
            decisionGeneration: 1,
            status: 'confirmation-pending',
          },
        ],
      },
    }),
  );
  assert.equal(pending.eligible, false);
  assert.equal(pending.route, 'no-new-execution');
  assert.deepEqual(blockerCodes(pending), ['pending-confirmation']);
  // A decision that is pending inside a mixed bundle counts too.
  const mixed = assessProvisionalChoicePlan(
    assessInput({
      state: {
        valid: true,
        hasRecords: true,
        status: 'selected',
        hasRework: false,
        decisions: [
          { bundleGeneration: 1, decisionGeneration: 1, status: 'selected' },
          {
            bundleGeneration: 1,
            decisionGeneration: 2,
            status: 'confirmation-pending',
          },
        ],
      },
    }),
  );
  assert.equal(mixed.route, 'no-new-execution');
});

test('provisional assessment: other recorded state belongs to Resume, and an unreadable state fails closed', () => {
  const recorded = assessProvisionalChoicePlan(
    assessInput({
      state: {
        valid: true,
        hasRecords: true,
        status: 'in-progress',
        hasRework: false,
        decisions: [
          { bundleGeneration: 1, decisionGeneration: 1, status: 'in-progress' },
        ],
      },
    }),
  );
  assert.deepEqual(blockerCodes(recorded), ['existing-provisional-records']);
  assert.equal(recorded.route, 'current-route');
  for (const state of [
    undefined,
    null,
    { valid: false, hasRecords: false },
    { valid: true },
    // An empty state needs its status and its decisions array, not a default.
    { valid: true, hasRecords: false, decisions: [] },
    { valid: true, hasRecords: false, status: 'none' },
    { valid: true, hasRecords: false, status: 'none', decisions: 'none' },
    { valid: true, hasRecords: false, status: 7, decisions: [] },
  ]) {
    const assessment = assessProvisionalChoicePlan(assessInput({ state }));
    assert.deepEqual(blockerCodes(assessment), ['state-unreadable']);
  }
});

test('provisional assessment: a labeled source that names no choice is not a decision source (AC3)', () => {
  const body = 'Fix the helper so that it runs.';
  const relative = 'Fix the bug which causes retries to fail.';
  assert.deepEqual(
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({
          issue: {
            number: 7,
            body: relative,
            labels: ['status:needs-decision'],
          },
          plan: validPlan({ humanChoiceCriteria: [relative] }, relative),
        }),
      ),
    ),
    ['no-decision-signal'],
  );
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      issue: { number: 7, body, labels: ['status:needs-decision'] },
      plan: validPlan({ humanChoiceCriteria: [body] }, body),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['no-decision-signal']);
  assert.equal(assessment.eligible, false);
});

test('provisional assessment: only a needs-decision source is assessed (AC3)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({ issue: { number: 7, body: SOURCE_BODY, labels: ['bug'] } }),
  );
  assert.deepEqual(blockerCodes(assessment), ['not-a-needs-decision-source']);
  const caseVariant = assessProvisionalChoicePlan(
    assessInput({
      issue: {
        number: 7,
        body: SOURCE_BODY,
        labels: ['Status:Needs-Decision'],
      },
    }),
  );
  assert.equal(caseVariant.eligible, true);
});

test('provisional assessment: score 1 and 2 decision candidates are reassessed only when the choice alone causes them (AC4)', () => {
  for (const authoredScore of [1, 2]) {
    const reassessed = assessProvisionalChoicePlan(
      assessInput({
        authoredScore,
        plan: validPlan({
          suitability: {
            lowScoreCause: 'input-choice-only',
            reassessedScore: 3,
            rationale: 'only the unresolved cache choice lowered it',
          },
        }),
      }),
    );
    assert.equal(reassessed.eligible, true, `score ${authoredScore}`);
    assert.deepEqual(reassessed.score, {
      authored: authoredScore,
      floor: 3,
      route: 'reassessed-with-plan',
      reassessed: 3,
    });
    for (const suitability of [
      undefined,
      { lowScoreCause: 'independent', reassessedScore: 4, rationale: 'x' },
      { lowScoreCause: 'none', reassessedScore: 4, rationale: 'x' },
      {
        lowScoreCause: 'input-choice-only',
        reassessedScore: 2,
        rationale: 'x',
      },
      { lowScoreCause: 'input-choice-only', reassessedScore: 4 },
    ]) {
      const refused = assessProvisionalChoicePlan(
        assessInput({
          authoredScore,
          plan: validPlan(suitability ? { suitability } : {}),
        }),
      );
      assert.equal(refused.eligible, false, JSON.stringify(suitability));
      assert.deepEqual(blockerCodes(refused), ['score-below-floor']);
      assert.equal(refused.score.route, 'below-floor');
    }
  }
});

test('provisional assessment: a normal-floor, unscored or kill-switched candidate needs no reassessment (AC4)', () => {
  const atFloor = assessProvisionalChoicePlan(
    assessInput({ authoredScore: 3 }),
  );
  assert.equal(atFloor.eligible, true);
  assert.equal(atFloor.score.route, 'at-or-above-floor');
  const unscored = assessProvisionalChoicePlan(
    assessInput({ authoredScore: null }),
  );
  assert.equal(unscored.score.route, 'no-score');
  const disabled = assessProvisionalChoicePlan(
    assessInput({ authoredScore: 1, suitabilityEnabled: false }),
  );
  assert.equal(disabled.eligible, true);
  assert.equal(disabled.score.route, 'ranking-disabled');
  // The floor and the authored score are reported, never changed.
  const raised = assessProvisionalChoicePlan(
    assessInput({ authoredScore: 2, floor: 4 }),
  );
  assert.equal(raised.score.floor, 4);
  assert.equal(raised.score.authored, 2);
});

test('provisional assessment: an independent obstacle keeps the existing blocker (AC3, row 5)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        independentObstacles: ['the change needs a production credential'],
      }),
    }),
  );
  assert.equal(assessment.eligible, false);
  assert.deepEqual(blockerCodes(assessment), ['independent-obstacle']);
  assert.match(assessment.blockers[0]?.detail ?? '', /production credential/);
});

test('provisional assessment: effort limits are never bypassed (AC4, row 5)', () => {
  assert.deepEqual(
    { ...PROVISIONAL_SURFACE_LIMITS },
    { ...EFFORT_CANDIDATE_FILE_LIMITS },
  );
  const four = [1, 2, 3, 4].map((n) => ({
    kind: 'file',
    target: `src/f${n}.mts`,
    purpose: 'edit',
  }));
  const small = assessProvisionalChoicePlan(
    assessInput({ effort: 'S', plan: validPlan({ deliverables: four }) }),
  );
  assert.deepEqual(blockerCodes(small), ['surface-oversized']);
  const medium = assessProvisionalChoicePlan(
    assessInput({ effort: 'M', plan: validPlan({ deliverables: four }) }),
  );
  assert.equal(medium.eligible, true);
  const nine = Array.from({ length: 9 }, (_, n) => ({
    kind: 'file',
    target: `src/f${n}.mts`,
    purpose: 'edit',
  }));
  const noEffortHint = assessProvisionalChoicePlan(
    assessInput({ effort: null, plan: validPlan({ deliverables: nine }) }),
  );
  assert.deepEqual(blockerCodes(noEffortHint), ['surface-oversized']);
  const refusedL = assessProvisionalChoicePlan(
    assessInput({ effort: 'L', effortLPolicy: 'refuse' }),
  );
  assert.deepEqual(blockerCodes(refusedL), ['effort-refused']);
  const allowedL = assessProvisionalChoicePlan(
    assessInput({
      effort: 'L',
      effortLPolicy: 'allow',
      plan: validPlan({ deliverables: nine }),
    }),
  );
  assert.equal(allowedL.eligible, true);
});

test('provisional assessment: the same inputs give the same answer for A4 and A4.5 (AC3)', () => {
  const first = assessProvisionalChoicePlan(assessInput());
  const second = assessProvisionalChoicePlan(assessInput());
  assert.deepEqual(first, second);
});

test('provisional assessment: a missing plan is a precise blocker, and a malformed one lists its problems', () => {
  for (const plan of [undefined, null]) {
    const missing = assessProvisionalChoicePlan(assessInput({ plan }));
    assert.deepEqual(blockerCodes(missing), ['plan-missing']);
  }
  const malformed = assessProvisionalChoicePlan(assessInput({ plan: 'text' }));
  assert.deepEqual(blockerCodes(malformed), ['plan-malformed']);
  const wrongVersion = assessProvisionalChoicePlan(
    assessInput({ plan: validPlan({ schemaVersion: 2 }) }),
  );
  assert.deepEqual(blockerCodes(wrongVersion), ['plan-malformed']);
});

test('isDecisionCausedSignal judges each phrase by its own clause (AC3)', () => {
  const decision = 'maintainer decision';
  const bare = 'Pick the cache layer. It needs a maintainer decision here.';
  assert.equal(
    isDecisionCausedSignal(bare, bare.indexOf(decision), decision.length),
    true,
  );
  for (const clause of [
    'It needs a maintainer decision and approval from legal.',
    'A maintainer decision on the production access policy is required.',
    'A maintainer decision, then the credential rotation, is required.',
    'The maintainer decision needs sign-off from a third-party vendor.',
  ]) {
    assert.equal(
      isDecisionCausedSignal(clause, clause.indexOf(decision), decision.length),
      false,
      clause,
    );
  }
  // A sibling sentence or bullet naming a credential does not taint the phrase.
  const sibling =
    'A maintainer decision picks the layer.\n- Needs a credential.';
  assert.equal(isDecisionCausedSignal(sibling, 0 + 2, decision.length), true);
});

test('isEligibleProvisionalAssessment accepts only a clean eligible assessment for this very issue', () => {
  const eligible = assessProvisionalChoicePlan(assessInput());
  const check = (value: unknown): boolean =>
    isEligibleProvisionalAssessment(value, SOURCE_ISSUE);
  assert.equal(check(eligible), true);
  assert.equal(check({ ...eligible, eligible: false }), false);
  assert.equal(check({ ...eligible, route: 'current-route' }), false);
  assert.equal(
    check({ ...eligible, blockers: [{ code: 'x', detail: 'y' }] }),
    false,
  );
  assert.equal(check({ ...eligible, plan: null }), false);
  assert.equal(check({ ...eligible, source: null }), false);
  for (const value of [undefined, null, 'eligible', 1, [], {}]) {
    assert.equal(check(value), false);
  }
});

test('isEligibleProvisionalAssessment never relaxes another issue or another body snapshot (AC3)', () => {
  const eligible = assessProvisionalChoicePlan(assessInput());
  assert.equal(
    isEligibleProvisionalAssessment(eligible, { number: 8, body: SOURCE_BODY }),
    false,
  );
  assert.equal(
    isEligibleProvisionalAssessment(eligible, {
      number: 7,
      body: `${SOURCE_BODY}edited`,
    }),
    false,
  );
});

test('isDecisionCausedSignal fails closed across an abbreviation or a dotted path (AC3)', () => {
  const decision = 'maintainer decision';
  for (const clause of [
    'This needs a maintainer decision, i.e. sign-off from legal.',
    'A maintainer decision (see docs/x.md) needs production access.',
    'A maintainer decision, e.g. the vendor choice, needs a credential.',
  ]) {
    assert.equal(
      isDecisionCausedSignal(clause, clause.indexOf(decision), decision.length),
      false,
      clause,
    );
  }
  // A real sentence end still ends the clause.
  const twoSentences =
    'This needs a maintainer decision. Production access is separate.';
  assert.equal(
    isDecisionCausedSignal(
      twoSentences,
      twoSentences.indexOf(decision),
      decision.length,
    ),
    true,
  );
});

test('provisional assessment: file deliverables stay within the declared Candidate files (AC1, AC4)', () => {
  const inside = assessProvisionalChoicePlan(
    assessInput({ candidateFiles: ['./src/cache.mts', 'docs/cache.md'] }),
  );
  assert.equal(inside.eligible, true);
  const outside = assessProvisionalChoicePlan(
    assessInput({ candidateFiles: ['docs/cache.md'] }),
  );
  assert.deepEqual(blockerCodes(outside), ['surface-outside-candidate-files']);
  assert.match(outside.blockers[0]?.detail ?? '', /src\/cache\.mts/);
  // A source that declares nothing, or a non-file deliverable, is not bound.
  assert.equal(
    assessProvisionalChoicePlan(assessInput({ candidateFiles: [] })).eligible,
    true,
  );
  const documentOnly = assessProvisionalChoicePlan(
    assessInput({
      candidateFiles: ['docs/cache.md'],
      plan: validPlan({
        deliverables: [
          { kind: 'document', target: 'a decision record', purpose: 'record' },
        ],
      }),
    }),
  );
  assert.equal(documentOnly.eligible, true);
});

test('isEligibleProvisionalAssessment rejects a hand-built object of the right shape (AC3)', () => {
  const eligible = assessProvisionalChoicePlan(assessInput());
  const forged = JSON.parse(JSON.stringify(eligible));
  assert.equal(forged.eligible, true);
  assert.equal(isEligibleProvisionalAssessment(forged, SOURCE_ISSUE), false);
  assert.equal(
    isEligibleProvisionalAssessment({ ...eligible }, SOURCE_ISSUE),
    false,
  );
  assert.equal(isEligibleProvisionalAssessment(eligible, SOURCE_ISSUE), true);
});

test('provisional assessment: a deliverable kind outside file, document and issue-comment is refused (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        deliverables: [
          { kind: 'other', target: 'a production deploy', purpose: 'ship' },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['plan-malformed']);
  assert.match(assessment.blockers[0]?.detail ?? '', /kind must be one of/);
});

test('provisional assessment: the human-choice criteria and recorded choices must be excerpts of the source (AC1, AC2)', () => {
  const foreignCriterion = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({ humanChoiceCriteria: ['an invented criterion'] }),
    }),
  );
  assert.deepEqual(blockerCodes(foreignCriterion), ['criteria-not-in-source']);
  // Case and whitespace do not matter; the words do.
  const respaced = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        humanChoiceCriteria: ['A  Maintainer\npicks the layer'],
      }),
    }),
  );
  assert.equal(respaced.eligible, true);
  const foreignChoice = assessProvisionalChoicePlan(
    assessInput({
      bodyRecordsOperatorChoice: true,
      plan: validPlan({
        recordedChoices: [
          { reference: 'an arbitrary entry', summary: 'x', respected: true },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(foreignChoice), [
    'recorded-choice-not-in-source',
  ]);
});

test('isDecisionCausedSignal scans the whole clause, with no window and no slice-edge sentence end (AC3)', () => {
  const decision = 'maintainer decision';
  const backward =
    'Legal sign-off is mandatory, i.e. maintainer decision for the cache layer.';
  assert.equal(
    isDecisionCausedSignal(
      backward,
      backward.indexOf(decision),
      decision.length,
    ),
    false,
  );
  const filler = ' about the layout and the review policy'.repeat(8);
  const long = `A maintainer decision${filler} requires approval before implementation.`;
  assert.equal(
    isDecisionCausedSignal(long, long.indexOf(decision), decision.length),
    false,
  );
  const before = `${'x '.repeat(100)}needs production access, so the maintainer decision is next.`;
  assert.equal(
    isDecisionCausedSignal(before, before.indexOf(decision), decision.length),
    false,
  );
});

test('findApprovalRequirementSentence finds a requirement in either word order and at any distance (AC3, AC4)', () => {
  for (const sentence of [
    'Approval from legal is required before work starts.',
    'Legal authorization is required before work starts.',
    'The rollout must be approved by legal.',
    'Sign-off is pending.',
    'Legal has to sign off before shipping.',
    'We cannot start until compliance signs off.',
    'The vendor must grant access first.',
    'The budget raise needs a standing approval.',
    'The rollout requires, after the long and careful qualification of every moving part in this very long sentence about scope, a formal approval.',
  ]) {
    assert.notEqual(
      findApprovalRequirementSentence(`Pick the layer. ${sentence} More.`),
      null,
      sentence,
    );
  }
});

test('findApprovalRequirementSentence keeps a negation to its own sentence (AC3)', () => {
  for (const text of [
    'This does not need any approval.',
    'This requires no approval.',
    'Nothing here needs sign-off.',
    'No approval is needed.',
    'Approval is not required.',
    "This doesn't need explicit sign-off.",
    'The authorization parser must reject an unknown role.',
    'The approval state machine must reject an unknown transition.',
    'Approval criteria are listed below.',
    'The reviewer approved the earlier draft.',
  ]) {
    assert.equal(findApprovalRequirementSentence(text), null, text);
  }
  // A bare "not" is not a denial: a prohibition or a contrast still requires it.
  for (const text of [
    'Do not proceed until legal approval is granted.',
    'The rollout requires legal approval, not just passing tests.',
    'Do not ship without approval.',
    'This does not need to wait, but the rollout requires legal approval.',
    'This does not need any approval, but the rollout requires legal approval.',
    'No approval is needed for selection, but deployment requires approval.',
    'Get legal approval before starting.',
    'Legal approval gates this.',
    'Obtain sign-off from the security team first.',
    'Wait for legal authorization.',
    'Seek consent from the owner.',
    'Implementation is contingent on legal approval.',
    'This does not require migration but requires legal approval.',
    'This does not need migration and needs legal approval.',
    'Security [approval](https://example.test/policy?team=security) is required before work starts.',
    'Approval at https://example.test/a?b=c is required.',
    'Legal approval is necessary.',
    'Sign-off is essential before shipping.',
  ]) {
    assert.notEqual(findApprovalRequirementSentence(text), null, text);
  }
  assert.notEqual(
    findApprovalRequirementSentence(
      'No migration is needed. The budget raise needs a standing approval.',
    ),
    null,
  );
});

test('provisional assessment: a status or decisions without records is inconsistent state, and a pending status always stops (row 6)', () => {
  const pendingWithoutRecords = assessProvisionalChoicePlan(
    assessInput({
      state: {
        valid: true,
        hasRecords: false,
        status: 'confirmation-pending',
        hasRework: false,
        decisions: [],
      },
    }),
  );
  assert.deepEqual(blockerCodes(pendingWithoutRecords), [
    'pending-confirmation',
  ]);
  assert.equal(pendingWithoutRecords.route, 'no-new-execution');
  for (const state of [
    { valid: true, hasRecords: false, status: 'selected', decisions: [] },
    {
      valid: true,
      hasRecords: false,
      status: 'none',
      decisions: [{ bundleGeneration: 1, decisionGeneration: 1 }],
    },
  ]) {
    const assessment = assessProvisionalChoicePlan(assessInput({ state }));
    assert.deepEqual(blockerCodes(assessment), ['state-unreadable']);
    assert.equal(assessment.route, 'current-route');
  }
});

test('provisional assessment: a Candidate files section that lists no path bounds no edit (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({ candidateFiles: [], candidateFilesDeclared: true }),
  );
  assert.deepEqual(blockerCodes(assessment), ['candidate-files-empty']);
  const absent = assessProvisionalChoicePlan(
    assessInput({ candidateFiles: [], candidateFilesDeclared: false }),
  );
  assert.equal(absent.eligible, true);
});

test('provisional assessment: a choice named only in code or a comment is not a live choice (AC3)', () => {
  const body = [
    'Fix the helper so that it runs.',
    '',
    '```text',
    'which option should we choose? a decision',
    '```',
    '',
    'Example: `decision` and <!-- whether to proceed -->',
    '',
  ].join('\n');
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      issue: { number: 7, body, labels: ['status:needs-decision'] },
      plan: validPlan(
        { humanChoiceCriteria: ['Fix the helper so that it runs.'] },
        body,
      ),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['no-decision-signal']);
});

test('provisional assessment: an execution criterion that depends on an approval is refused (AC1, AC4)', () => {
  for (const criterion of [
    'Legal approval is required before work starts.',
    'The user approves the implementation.',
    'The change is signed off by the owner.',
    'A maintainer grants permission to ship.',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.equal(assessment.eligible, false, criterion);
    assert.deepEqual(
      blockerCodes(assessment),
      ['criteria-needs-approval'],
      criterion,
    );
  }
  // A criterion that denies an approval, or names none, stays objective.
  for (const criterion of [
    'No approval is needed and the tests pass.',
    'pnpm test passes for the cache module',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.equal(assessment.eligible, true, criterion);
  }
});

test('provisional assessment: a deliverable whose purpose depends on an approval is refused (AC1)', () => {
  const assessment = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        deliverables: [
          {
            kind: 'issue-comment',
            target: 'the source issue',
            purpose: 'ask legal for sign-off',
          },
        ],
      }),
    }),
  );
  assert.deepEqual(blockerCodes(assessment), ['criteria-needs-approval']);
  // A path that merely contains the word is not scanned.
  const path = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        deliverables: [
          {
            kind: 'file',
            target: 'docs/approval-flow.md',
            purpose: 'document the flow',
          },
        ],
      }),
    }),
  );
  assert.equal(path.eligible, true);
});

test('provisional assessment: approval software is not an approval dependency (AC1)', () => {
  for (const criterion of [
    'The authorization parser returns false for an unknown role.',
    'The approval state machine rejects an unknown transition.',
    'The authorization parser must reject an unknown role.',
    'The token parser rejects an expired token.',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.equal(assessment.eligible, true, criterion);
  }
  const doc = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        deliverables: [
          {
            kind: 'document',
            target: 'a design note',
            purpose: 'Document the approval state machine.',
          },
        ],
      }),
    }),
  );
  assert.equal(doc.eligible, true);
  for (const criterion of [
    'The maintainer approves the layer.',
    'Sign-off from the security team is recorded.',
    'Approved by the owner.',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.equal(assessment.eligible, false, criterion);
  }
});

test('provisional assessment: a credential or access prerequisite in a criterion or purpose is refused (AC1, AC4)', () => {
  for (const criterion of [
    'An operator must supply credentials before work starts.',
    'Wait for the vendor to provide production access.',
    'A secret is required before the job runs.',
  ]) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.equal(assessment.eligible, false, criterion);
    assert.deepEqual(
      blockerCodes(assessment),
      ['criteria-needs-credential'],
      criterion,
    );
  }
  const purpose = assessProvisionalChoicePlan(
    assessInput({
      plan: validPlan({
        deliverables: [
          {
            kind: 'issue-comment',
            target: 'the source issue',
            purpose: 'request the production credentials',
          },
        ],
      }),
    }),
  );
  assert.equal(purpose.eligible, false);
  assert.deepEqual(blockerCodes(purpose), ['criteria-needs-credential']);
});

test("provisional assessment: the selected option's verification is read like a criterion (AC1)", () => {
  const verifiedBy = (verification: string) => {
    const choice = planChoice();
    choice.selectedOption = {
      ...(choice.selectedOption as Record<string, string>),
      verification,
    };
    return assessProvisionalChoicePlan(
      assessInput({ plan: validPlan({ choices: [choice] }) }),
    );
  };
  assert.deepEqual(
    blockerCodes(verifiedBy('Legal approval is required to confirm it.')),
    ['criteria-needs-approval'],
  );
  assert.deepEqual(
    blockerCodes(verifiedBy('An operator must supply credentials first.')),
    ['criteria-needs-credential'],
  );
  assert.deepEqual(
    blockerCodes(verifiedBy('The maintainer decides whether it looks good.')),
    ['criteria-subjective'],
  );
  assert.equal(verifiedBy('the unit tests pass').eligible, true);
});

test('provisional assessment: Markdown formatting does not hide a prerequisite in a plan (AC1, AC4)', () => {
  for (const [criterion, code] of [
    [
      'Legal `approval` is required before work starts.',
      'criteria-needs-approval',
    ],
    [
      'Legal **approval** is required before work starts.',
      'criteria-needs-approval',
    ],
    ['The _user_ `approves` the implementation.', 'criteria-needs-approval'],
    [
      'An operator must supply `credentials` before work starts.',
      'criteria-needs-credential',
    ],
    [
      'An operator must supply **credentials** first.',
      'criteria-needs-credential',
    ],
    [
      'Legal [approval](https://example.test/policy) is required first.',
      'criteria-needs-approval',
    ],
  ] as const) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.deepEqual(blockerCodes(assessment), [code], criterion);
  }
});

test('provisional assessment: a long qualification cannot separate a need from what is needed (AC1, AC4)', () => {
  for (const [criterion, code] of [
    [
      'The result requires, after the long qualification of the rollout and its environment, approval.',
      'criteria-needs-approval',
    ],
    [
      'The job needs, once the long qualification of the rollout and its environment is done, credentials.',
      'criteria-needs-credential',
    ],
    ['Ask for the production credentials first.', 'criteria-needs-credential'],
  ] as const) {
    const assessment = assessProvisionalChoicePlan(
      assessInput({
        plan: validPlan({
          choices: [planChoice({ executionCriteria: [criterion] })],
        }),
      }),
    );
    assert.deepEqual(blockerCodes(assessment), [code], criterion);
  }
});

test('provisional assessment: formatting does not hide an opinion, and a denied credential is not a prerequisite (AC1, AC4)', () => {
  const codes = (criterion: string) =>
    blockerCodes(
      assessProvisionalChoicePlan(
        assessInput({
          plan: validPlan({
            choices: [planChoice({ executionCriteria: [criterion] })],
          }),
        }),
      ),
    );
  assert.deepEqual(codes('The implementation looks **good** to the author.'), [
    'criteria-subjective',
  ]);
  assert.deepEqual(codes('Execution depends on approval.'), [
    'criteria-needs-approval',
  ]);
  assert.deepEqual(codes('The rollout is contingent on legal sign-off.'), [
    'criteria-needs-approval',
  ]);
  assert.deepEqual(codes('Work relies on production access.'), [
    'criteria-needs-credential',
  ]);
  for (const denied of [
    'No credentials are required to run the test.',
    'The test does not need any credentials.',
    'The job requires no credentials.',
    'Credentials are not needed for the unit tests.',
    'The CLI must not require credentials.',
    'The CLI may not need any credentials.',
  ]) {
    assert.deepEqual(codes(denied), [], denied);
  }
  // A prohibition is not a denial: it still asks for the prerequisite.
  assert.deepEqual(codes('Do not proceed without credentials.'), [
    'criteria-needs-credential',
  ]);
  assert.deepEqual(codes('Do not ship without legal approval.'), [
    'criteria-needs-approval',
  ]);
  assert.deepEqual(codes('Do not proceed without approval.'), [
    'criteria-needs-approval',
  ]);
  assert.deepEqual(codes('This cannot ship without sign-off.'), [
    'criteria-needs-approval',
  ]);
  // A denial of one thing does not hide a need for another.
  assert.deepEqual(
    codes('No credentials are required but the job requires legal approval.'),
    ['criteria-needs-approval'],
  );
});
