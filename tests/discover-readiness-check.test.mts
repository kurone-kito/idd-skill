import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateDiscoverReadiness,
  extractBlockedByIssueNumbers,
  extractBlockedByRoadmapMarkers,
  extractDependencyIssueNumbers,
} from '../src/scripts/discover-readiness-check.mts';

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
  assert.deepEqual(summary.ready, [{ number: 401, title: 'candidate' }]);
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
