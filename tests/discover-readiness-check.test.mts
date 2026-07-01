import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRoadmapMarkerSearchQuery,
  evaluateDiscoverReadiness,
  extractBlockedByIssueNumbers,
  extractBlockedByRoadmapMarkers,
  extractDependencyIssueNumbers,
  isInaccessibleIssueLookupError,
} from '../src/scripts/discover-readiness-check.mts';

// Shape of a wrapped runGh failure: process exit code 1 with the true
// HTTP status carried in stderr.
const ghError = (stderr: string) =>
  Object.assign(new Error(`gh api ... failed: ${stderr}`), {
    status: 1,
    stderr,
  });

test('extractors parse blocked-by references, roadmap markers, and dependencies', () => {
  const body = `
Blocked by #12
blocked by #34
Depends on #56
- [ ] #78
<!-- idd-skill-blocked-by: parent-roadmap -->
`;
  assert.deepEqual(extractBlockedByIssueNumbers(body), [12, 34]);
  assert.deepEqual(extractDependencyIssueNumbers(body), [56, 78]);
  assert.deepEqual(extractBlockedByRoadmapMarkers(body), ['parent-roadmap']);
});

test('extractBlockedByIssueNumbers captures every same-line ref and tolerates list/blockquote prefixes', () => {
  // Comma- and space-separated multi-ref on one line.
  assert.deepEqual(
    extractBlockedByIssueNumbers('Blocked by #100, #200'),
    [100, 200],
  );
  assert.deepEqual(
    extractBlockedByIssueNumbers('Blocked by #100 #200'),
    [100, 200],
  );
  // List-bullet and blockquote prefixes are matched.
  assert.deepEqual(extractBlockedByIssueNumbers('- Blocked by #55'), [55]);
  assert.deepEqual(extractBlockedByIssueNumbers('> Blocked by #66'), [66]);
  // Mid-sentence prose is not a dependency declaration.
  assert.deepEqual(
    extractBlockedByIssueNumbers('this is not blocked by #5'),
    [],
  );
  // Inline-code markers stay ignored (backtick prefix, #1121 boundary).
  assert.deepEqual(extractBlockedByIssueNumbers('`Blocked by #77`'), []);
});

test('extractDependencyIssueNumbers captures every same-line Depends on ref and tolerates prefixes', () => {
  assert.deepEqual(
    extractDependencyIssueNumbers('Depends on #100, #200'),
    [100, 200],
  );
  assert.deepEqual(
    extractDependencyIssueNumbers('Depends on #100 #200'),
    [100, 200],
  );
  assert.deepEqual(extractDependencyIssueNumbers('- Depends on #55'), [55]);
  assert.deepEqual(extractDependencyIssueNumbers('> Depends on #66'), [66]);
  assert.deepEqual(
    extractDependencyIssueNumbers('this does not depend on #5'),
    [],
  );
  assert.deepEqual(extractDependencyIssueNumbers('`Depends on #77`'), []);
  // The `- [ ] #N` task-list branch keeps working alongside the relaxed
  // `Depends on` bullet prefix without double counting.
  assert.deepEqual(
    extractDependencyIssueNumbers('- Depends on #55, #56\n- [ ] #78'),
    [55, 56, 78],
  );
});

test('extractBlockedByRoadmapMarkers honors a configured marker prefix', () => {
  const body = `
<!-- idd-skill-blocked-by: default-prefixed -->
<!-- acme-blocked-by: custom-prefixed -->
`;
  // The default prefix extracts only its own marker.
  assert.deepEqual(extractBlockedByRoadmapMarkers(body), ['default-prefixed']);
  // A configured prefix extracts only the matching marker, ignoring the
  // default-prefixed one.
  assert.deepEqual(extractBlockedByRoadmapMarkers(body, 'acme'), [
    'custom-prefixed',
  ]);
});

test('extractBlockedByRoadmapMarkers regex-escapes a metacharacter prefix', () => {
  // Without escaping, the unbalanced parenthesis would make `a(b` an invalid
  // regex (unterminated group) and throw; escaping keeps it a literal match.
  const body = '<!-- a(b-blocked-by: grouped -->';
  assert.deepEqual(extractBlockedByRoadmapMarkers(body, 'a(b'), ['grouped']);
});

test('buildRoadmapMarkerSearchQuery threads the prefix as a literal, unescaped term', () => {
  // Default prefix.
  assert.equal(
    buildRoadmapMarkerSearchQuery('o', 'r', 'idd-skill', '1076'),
    'repo:o/r is:issue in:body "<!-- idd-skill-roadmap-id: 1076 -->"',
  );
  // A configured prefix threads through verbatim.
  assert.equal(
    buildRoadmapMarkerSearchQuery('o', 'r', 'acme', '1076'),
    'repo:o/r is:issue in:body "<!-- acme-roadmap-id: 1076 -->"',
  );
  // A regex metacharacter in the prefix stays LITERAL (not escaped): the
  // search query is a plain string, so escaping would corrupt the term.
  assert.equal(
    buildRoadmapMarkerSearchQuery('o', 'r', 'a.b', '1076'),
    'repo:o/r is:issue in:body "<!-- a.b-roadmap-id: 1076 -->"',
  );
});

test('threads a configured marker prefix into blocked-by extraction and roadmap-id search', async () => {
  const issues = new Map([
    [
      1601,
      {
        number: 1601,
        title: 'custom-prefixed blocked-by',
        state: 'OPEN',
        body: '<!-- acme-blocked-by: roadmap-y -->',
        labels: [],
      },
    ],
  ]);
  const searchedMarkers: string[] = [];
  const summary = await evaluateDiscoverReadiness([1601], {
    includeUnresolvable: true,
    markerPrefix: 'acme',
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async (marker) => {
      searchedMarkers.push(marker);
      return marker === 'roadmap-y'
        ? [
            {
              number: 998,
              title: 'roadmap',
              state: 'OPEN',
              body: '',
              labels: [{ name: 'roadmap' }],
            },
          ]
        : [];
    },
  });

  // The acme-prefixed blocked-by marker is extracted (the default idd-skill
  // prefix would not have matched it) and resolved through the roadmap-id
  // lookup, so the issue is filtered as blocked by the open roadmap.
  assert.deepEqual(searchedMarkers, ['roadmap-y']);
  assert.equal(summary.ready.length, 0);
  assert.match(
    summary.filteredOut[0].reasons.join(','),
    /blocked_by_open_roadmap_marker:roadmap-y/,
  );
});

test('filters issue with blocked labels', async () => {
  const summary = await evaluateDiscoverReadiness([101], {
    loadIssue: async () => ({
      number: 101,
      title: 'candidate',
      state: 'OPEN',
      body: '',
      labels: [{ name: 'status:blocked-by-human' }],
    }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.deepEqual(summary.filteredOut[0].reasons, [
    'label:status:blocked-by-human',
  ]);
});

test('filters authoring-labeled issue and emits stale warning', async () => {
  const summary = await evaluateDiscoverReadiness([151], {
    now: '2026-05-15T12:00:00Z',
    authoringStaleAgeMs: 4 * 60 * 60 * 1000,
    loadIssue: async () => ({
      number: 151,
      title: 'candidate being authored',
      state: 'OPEN',
      body: '',
      labels: [{ name: 'status:authoring' }],
      labelEvents: [
        {
          event: 'labeled',
          label: { name: 'status:authoring' },
          created_at: '2026-05-15T07:00:00Z',
        },
      ],
    }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.deepEqual(summary.filteredOut[0].reasons, ['label:status:authoring']);
  assert.equal(summary.warnings[0].status, 'stale');
  assert.match(
    summary.warnings[0].message,
    /Issue #151 has carried the authoring label for 5h/,
  );
});

test('fails safe when blocked-by issue cannot be resolved', async () => {
  const issues = new Map([
    [
      201,
      {
        number: 201,
        title: 'candidate',
        state: 'OPEN',
        body: 'Blocked by #202',
        labels: [],
      },
    ],
  ]);
  const summary = await evaluateDiscoverReadiness([201], {
    includeUnresolvable: true,
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.equal(summary.summary.unresolvableCount, 1);
  assert.match(
    summary.filteredOut[0].reasons.join(','),
    /unresolvable_blocked_by_issue/,
  );
});

test('filters issue blocked by open roadmap marker', async () => {
  const issues = new Map([
    [
      301,
      {
        number: 301,
        title: 'candidate',
        state: 'OPEN',
        body: '<!-- idd-skill-blocked-by: roadmap-x -->',
        labels: [],
      },
    ],
  ]);

  const summary = await evaluateDiscoverReadiness([301], {
    includeUnresolvable: true,
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async (marker) =>
      marker === 'roadmap-x'
        ? [
            {
              number: 999,
              title: 'roadmap',
              state: 'OPEN',
              body: '',
              labels: [{ name: 'roadmap' }],
            },
          ]
        : [],
  });

  assert.equal(summary.ready.length, 0);
  assert.match(
    summary.filteredOut[0].reasons.join(','),
    /blocked_by_open_roadmap_marker:roadmap-x/,
  );
});

test('open roadmap dependencies are ignored as parent epics', async () => {
  const issues = new Map([
    [
      401,
      {
        number: 401,
        title: 'candidate',
        state: 'OPEN',
        body: 'Depends on #402',
        labels: [],
      },
    ],
    [
      402,
      {
        number: 402,
        title: 'roadmap: parent',
        state: 'OPEN',
        body: '',
        labels: [{ name: 'roadmap' }],
      },
    ],
  ]);

  const summary = await evaluateDiscoverReadiness([401], {
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  assert.deepEqual(summary.filteredOut, []);
  assert.deepEqual(summary.ready, [
    {
      number: 401,
      title: 'candidate',
      autopilotSuitability: null,
      belowFloor: false,
    },
  ]);
});

test('returns empty unresolvable list when include-unresolvable is disabled', async () => {
  const issues = new Map([
    [
      501,
      {
        number: 501,
        title: 'candidate',
        state: 'OPEN',
        body: 'Blocked by #999',
        labels: [],
      },
    ],
  ]);
  const summary = await evaluateDiscoverReadiness([501], {
    includeUnresolvable: false,
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  assert.deepEqual(summary.unresolvable, []);
  assert.equal(summary.summary.unresolvableCount, 1);
});

test('treats inaccessible dependencies as unresolvable entries', async () => {
  const issues = new Map([
    [
      601,
      {
        number: 601,
        title: 'candidate',
        state: 'OPEN',
        body: 'Depends on #602',
        labels: [],
      },
    ],
    [602, { __iddLookupStatus: 'inaccessible' }],
  ]);
  const summary = await evaluateDiscoverReadiness([601], {
    includeUnresolvable: true,
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.match(
    summary.filteredOut[0].reasons.join(','),
    /unresolvable_dependency_issue/,
  );
  assert.deepEqual(summary.unresolvable, [
    {
      issueNumber: 601,
      kind: 'dependency',
      reference: '#602',
      reason: 'issue_inaccessible',
    },
  ]);
});

test('treats inaccessible target issue as unresolvable', async () => {
  const summary = await evaluateDiscoverReadiness([701], {
    includeUnresolvable: true,
    loadIssue: async () => ({ __iddLookupStatus: 'inaccessible' }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.deepEqual(summary.filteredOut, [
    {
      number: 701,
      title: '',
      reasons: ['issue_inaccessible'],
      autopilotSuitability: null,
      belowFloor: false,
    },
  ]);
  assert.deepEqual(summary.unresolvable, [
    {
      issueNumber: 701,
      kind: 'issue',
      reference: '#701',
      reason: 'issue_inaccessible',
    },
  ]);
});

test('bubbles non-recoverable loader failures', async () => {
  await assert.rejects(
    evaluateDiscoverReadiness([801], {
      loadIssue: async () => {
        throw new Error('network timeout');
      },
      findRoadmapsByMarker: async () => [],
    }),
    /network timeout/,
  );
});

test('isInaccessibleIssueLookupError downgrades only visibility 403/410/451', () => {
  // Visibility / integration-permission 403, 410, 451 -> inaccessible
  assert.equal(
    isInaccessibleIssueLookupError(
      ghError('Resource not accessible by integration (HTTP 403)'),
    ),
    true,
  );
  assert.equal(
    isInaccessibleIssueLookupError(
      ghError('Resource not accessible by integration (HTTP 410)'),
    ),
    true,
  );
  assert.equal(
    isInaccessibleIssueLookupError(
      ghError('Repository access blocked due to visibility (HTTP 451)'),
    ),
    true,
  );
});

test('isInaccessibleIssueLookupError fails closed on auth, rate-limit, and 404', () => {
  // 403 secondary-rate-limit must abort, not downgrade.
  assert.equal(
    isInaccessibleIssueLookupError(
      ghError('You have exceeded a secondary rate limit (HTTP 403)'),
    ),
    false,
  );
  // 401 auth failure must abort.
  assert.equal(
    isInaccessibleIssueLookupError(ghError('Bad credentials (HTTP 401)')),
    false,
  );
  // A genuine 404 is handled as not-found upstream, never inaccessible.
  assert.equal(
    isInaccessibleIssueLookupError(ghError('Not Found (HTTP 404)')),
    false,
  );
  // No derivable status -> fail closed (not inaccessible -> abort upstream).
  assert.equal(
    isInaccessibleIssueLookupError(ghError('connect ETIMEDOUT')),
    false,
  );
});

test('surfaces autopilot-suitability score and below-floor flag without changing classification', async () => {
  const issues = new Map([
    [
      1001,
      {
        number: 1001,
        title: 'scored above floor',
        state: 'OPEN',
        body: 'work\n<!-- idd-skill-autopilot-suitability: 4 -->',
        labels: [],
      },
    ],
    [
      1002,
      {
        number: 1002,
        title: 'scored below floor',
        state: 'OPEN',
        body: 'human-led\n<!-- idd-skill-autopilot-suitability: 2 -->',
        labels: [],
      },
    ],
    [
      1003,
      {
        number: 1003,
        title: 'unscored',
        state: 'OPEN',
        body: 'no marker here',
        labels: [],
      },
    ],
  ]);

  const summary = await evaluateDiscoverReadiness([1001, 1002, 1003], {
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  // Signal-only: every issue clears the readiness filters and stays `ready`,
  // including the below-floor one. The new fields never reclassify.
  assert.deepEqual(
    summary.ready.map((item) => item.number),
    [1001, 1002, 1003],
  );
  assert.equal(summary.filteredOut.length, 0);

  const byNumber = new Map(summary.ready.map((item) => [item.number, item]));
  assert.deepEqual(
    { ...byNumber.get(1001) },
    {
      number: 1001,
      title: 'scored above floor',
      autopilotSuitability: 4,
      belowFloor: false,
    },
  );
  assert.deepEqual(
    { ...byNumber.get(1002) },
    {
      number: 1002,
      title: 'scored below floor',
      autopilotSuitability: 2,
      belowFloor: true,
    },
  );
  assert.deepEqual(
    { ...byNumber.get(1003) },
    {
      number: 1003,
      title: 'unscored',
      autopilotSuitability: null,
      belowFloor: false,
    },
  );
});

test('surfaces the suitability signal on filtered-out issues too', async () => {
  const summary = await evaluateDiscoverReadiness([1101], {
    loadIssue: async () => ({
      number: 1101,
      title: 'blocked and scored',
      state: 'OPEN',
      body: 'blocked\n<!-- idd-skill-autopilot-suitability: 5 -->',
      labels: [{ name: 'status:needs-decision' }],
    }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.deepEqual(summary.filteredOut, [
    {
      number: 1101,
      title: 'blocked and scored',
      reasons: ['label:status:needs-decision'],
      autopilotSuitability: 5,
      belowFloor: false,
    },
  ]);
});

test('honors a configured floor and treats an out-of-range score as no score', async () => {
  const issues = new Map([
    [
      1201,
      {
        number: 1201,
        title: 'score 3 under floor 4',
        state: 'OPEN',
        body: '<!-- idd-skill-autopilot-suitability: 3 -->',
        labels: [],
      },
    ],
    [
      1202,
      {
        number: 1202,
        title: 'out of range score',
        state: 'OPEN',
        body: '<!-- idd-skill-autopilot-suitability: 9 -->',
        labels: [],
      },
    ],
  ]);

  const summary = await evaluateDiscoverReadiness([1201, 1202], {
    autopilotSuitabilityFloor: 4,
    loadIssue: async (number) => issues.get(number) ?? null,
    findRoadmapsByMarker: async () => [],
  });

  const byNumber = new Map(summary.ready.map((item) => [item.number, item]));
  assert.equal(byNumber.get(1201)?.autopilotSuitability, 3);
  assert.equal(byNumber.get(1201)?.belowFloor, true);
  // An out-of-range marker is "no score" (fail-safe) and never below floor.
  assert.equal(byNumber.get(1202)?.autopilotSuitability, null);
  assert.equal(byNumber.get(1202)?.belowFloor, false);
});

test('surfaces the suitability signal on a not-open scored issue', async () => {
  const summary = await evaluateDiscoverReadiness([1401], {
    loadIssue: async () => ({
      number: 1401,
      title: 'closed but scored',
      state: 'CLOSED',
      body: 'done\n<!-- idd-skill-autopilot-suitability: 3 -->',
      labels: [],
    }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready.length, 0);
  assert.deepEqual(summary.filteredOut, [
    {
      number: 1401,
      title: 'closed but scored',
      reasons: ['issue_not_open'],
      autopilotSuitability: 3,
      belowFloor: false,
    },
  ]);
});

test('parses the suitability score using a configured marker prefix', async () => {
  const summary = await evaluateDiscoverReadiness([1301], {
    markerPrefix: 'acme',
    loadIssue: async () => ({
      number: 1301,
      title: 'custom prefix',
      state: 'OPEN',
      body: '<!-- acme-autopilot-suitability: 1 -->',
      labels: [],
    }),
    findRoadmapsByMarker: async () => [],
  });

  assert.equal(summary.ready[0].autopilotSuitability, 1);
  assert.equal(summary.ready[0].belowFloor, true);
});

test('forces a neutral signal when the suitability kill switch is off', async () => {
  const summary = await evaluateDiscoverReadiness([1501], {
    autopilotSuitabilityEnabled: false,
    loadIssue: async () => ({
      number: 1501,
      title: 'below floor but kill switch off',
      state: 'OPEN',
      body: 'human-led\n<!-- idd-skill-autopilot-suitability: 2 -->',
      labels: [],
    }),
    findRoadmapsByMarker: async () => [],
  });

  // Kill switch off: the score is ignored entirely, so the signal is neutral
  // even though the body carries a below-floor score. Classification is
  // unchanged — the issue is still ready.
  assert.deepEqual(summary.ready, [
    {
      number: 1501,
      title: 'below floor but kill switch off',
      autopilotSuitability: null,
      belowFloor: false,
    },
  ]);
});
