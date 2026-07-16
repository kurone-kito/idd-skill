import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyIssue,
  extractBlockedByReferences,
  filterOrphanIssues,
  getOrphanFirstPolicy,
} from '../src/scripts/discover-orphan-filter.mts';

test('extractBlockedByReferences parses visible blocker lines', () => {
  const body = `
Blocked by #12
notes
  Blocked by #34 because dependency
blocked by #56
`;
  assert.deepEqual(extractBlockedByReferences(body), [12, 34, 56]);
});

test('extractBlockedByReferences tolerates a colon between the keyword and the ref (#1311)', () => {
  const body = '- Blocked by: #123 (context) — more text';
  assert.deepEqual(extractBlockedByReferences(body), [123]);
});

test('getOrphanFirstPolicy reads commands row and falls back to none', () => {
  assert.equal(
    getOrphanFirstPolicy({
      commands: { 'orphan-first-policy': 'maintainer-approved' },
    }),
    'maintainer-approved',
  );
  assert.equal(
    getOrphanFirstPolicy({ orphanFirstPolicy: 'public-disabled' }),
    'public-disabled',
  );
  assert.equal(getOrphanFirstPolicy({}), 'none');
});

test('classifyIssue rejects roadmap and blocked marker issues', () => {
  const roadmap = classifyIssue(
    {
      number: 1,
      title: 'roadmap',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-roadmap-id: x -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 2,
      title: 'blocked',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-blocked-by: x -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('classifyIssue accepts marker forms without colon', () => {
  const roadmap = classifyIssue(
    {
      number: 3,
      title: 'roadmap marker without payload',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-roadmap-id -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 4,
      title: 'blocked marker without payload',
      state: 'OPEN',
      labels: [],
      body: '<!-- idd-skill-blocked-by -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('classifyIssue supports custom marker prefix', () => {
  const roadmap = classifyIssue(
    {
      number: 5,
      title: 'custom roadmap marker',
      state: 'OPEN',
      labels: [],
      body: '<!-- custom-roadmap-id: phase-a -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      markerPrefix: 'custom',
    },
  );
  assert.equal(roadmap.reason, 'roadmap_marker');

  const blocked = classifyIssue(
    {
      number: 6,
      title: 'custom blocked marker',
      state: 'OPEN',
      labels: [],
      body: '<!-- custom-blocked-by: phase-a -->',
    },
    {
      issueStateByNumber: new Map(),
      fetchIssueStateByNumber: () => 'UNRESOLVABLE',
      markerPrefix: 'custom',
    },
  );
  assert.equal(blocked.reason, 'blocked_by_marker');
});

test('filterOrphanIssues excludes blocked labels and open blockers', async () => {
  const issues = [
    {
      number: 10,
      title: 'candidate',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #20',
      url: 'https://example.com/10',
    },
    {
      number: 11,
      title: 'human blocked',
      state: 'OPEN',
      labels: [{ name: 'status:blocked-by-human' }],
      body: '',
      url: 'https://example.com/11',
    },
    {
      number: 12,
      title: 'orphan',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.com/12',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[20, 'OPEN']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 12);
  assert.equal(result.filtered.blocked_by_open_reference.length, 1);
  assert.equal(result.filtered.blocked_label.length, 1);
});

test('filterOrphanIssues resolves configured blocked-label names (#1273)', async () => {
  const issues = [
    {
      number: 30,
      title: 'custom human-gate label',
      state: 'OPEN',
      labels: [{ name: 'triage:human-gate' }],
      body: '',
      url: 'https://example.com/30',
    },
    {
      number: 31,
      title: 'stock status:blocked-by-human label no longer blocks',
      state: 'OPEN',
      labels: [{ name: 'status:blocked-by-human' }],
      body: '',
      url: 'https://example.com/31',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    blockedByHumanLabelName: 'triage:human-gate',
  });

  // The configured label name blocks #30...
  assert.equal(result.filtered.blocked_label.length, 1);
  assert.equal(result.filtered.blocked_label[0].number, 30);
  // ...while the stock default no longer matches once overridden, so #31 is
  // an orphan (the override replaces, not adds to, the default).
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].number, 31);
});

test('filterOrphanIssues excludes custom authoring label and warns when stale', async () => {
  const issues = [
    {
      number: 21,
      title: 'being drafted',
      state: 'OPEN',
      labels: [{ name: 'status:drafting' }],
      labelEvents: [
        {
          event: 'labeled',
          label: { name: 'status:drafting' },
          created_at: '2026-05-15T07:00:00Z',
        },
      ],
      body: '',
      url: 'https://example.com/21',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    authoringLabelName: 'status:drafting',
    authoringStaleAgeMs: 4 * 60 * 60 * 1000,
    now: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.orphans.length, 0);
  assert.equal(result.filtered.authoring_label.length, 1);
  assert.equal(result.filtered.authoring_label[0].details, 'status:drafting');
  assert.equal(result.warnings[0].status, 'stale');
  assert.match(
    result.warnings[0].message,
    /Issue #21 has carried the authoring label for 5h/,
  );
});

test('filterOrphanIssues keeps closed-blocker issues as orphan candidates', async () => {
  const issues = [
    {
      number: 30,
      title: 'blocked by closed issue',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #31',
      url: 'https://example.com/30',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[31, 'CLOSED']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].reason, 'blocked_references_closed');
});

test('filterOrphanIssues reports unresolvable and circular references', async () => {
  const issues = [
    {
      number: 40,
      title: 'missing ref',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #99',
      url: 'https://example.com/40',
    },
    {
      number: 41,
      title: 'cycle a',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #42',
      url: 'https://example.com/41',
    },
    {
      number: 42,
      title: 'cycle b',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #41',
      url: 'https://example.com/42',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([
      [41, 'OPEN'],
      [42, 'OPEN'],
    ]),
    fetchIssueStateByNumber: (number) =>
      number === 99 ? 'UNRESOLVABLE' : 'UNRESOLVABLE',
  });

  assert.equal(result.filtered.unresolvable_reference.length, 1);
  assert.equal(result.filtered.blocked_by_open_reference.length, 2);
  assert.equal(result.unresolvable.length, 1);
  assert.deepEqual(result.unresolvable[0], {
    issue: 40,
    reason: 'issue-not-found-or-inaccessible',
    reference: 99,
  });
});

test('classifyIssue handles lowercase state casing', async () => {
  const issue = {
    number: 50,
    title: 'blocked by open issue with lowercase state',
    state: 'open',
    labels: [],
    body: 'Blocked by #51',
    url: 'https://example.com/50',
  };

  const result = await filterOrphanIssues([issue], {
    issueStateByNumber: new Map([[51, 'open']]),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });

  assert.equal(
    result.orphans.length,
    0,
    'Issue should not be orphan when blocked by open reference',
  );
  assert.equal(
    result.filtered.blocked_by_open_reference.length,
    1,
    'Should classify as blocked_by_open_reference',
  );
});

test('classifyIssue supports custom marker prefix in filtering', async () => {
  const issue = {
    number: 60,
    title: 'issue with custom marker',
    state: 'OPEN',
    labels: [],
    body: '<!-- my-org-idd-blocked-by: gap-123 -->',
    url: 'https://example.com/60',
  };

  const result = await filterOrphanIssues([issue], {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    markerPrefix: 'my-org-idd',
  });

  assert.equal(
    result.orphans.length,
    0,
    'Issue should not be orphan when has custom-prefix blocked marker',
  );
  assert.equal(
    result.filtered.blocked_by_marker.length,
    1,
    'Should detect custom marker',
  );
});

test('filterOrphanIssues handles pagination with PR-heavy pages', async () => {
  const mockFetchIssueStateByNumber = (number: number) => {
    return number === 100 ? 'CLOSED' : 'UNRESOLVABLE';
  };

  const issues = [
    {
      number: 70,
      title: 'issue on pr-heavy page',
      state: 'OPEN',
      labels: [],
      body: 'Blocked by #100',
      url: 'https://example.com/70',
    },
  ];

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map([[100, 'CLOSED']]),
    fetchIssueStateByNumber: mockFetchIssueStateByNumber,
  });

  assert.equal(
    result.orphans.length,
    1,
    'Issue should be orphan when blocker is closed',
  );
  assert.equal(result.orphans[0].reason, 'blocked_references_closed');
});

test('filterOrphanIssues ranks orphans by autopilot-suitability and routes below-floor to humans (autopilot)', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 3, title: 'mid', state: 'OPEN', body: `task\n${m(3)}` },
    { number: 4, title: 'unscored', state: 'OPEN', body: 'task with no score' },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilot: true,
  });

  // High first; unscored kept (floor baseline), below-floor routed out.
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [2, 3, 4],
  );
  assert.deepEqual(
    result.routed_to_human.map((o) => o.number),
    [1],
  );
  assert.equal(result.counts.routed_to_human, 1);
  assert.equal(
    result.orphans.find((o) => o.number === 2)?.autopilotSuitability,
    5,
  );
  assert.equal(
    result.orphans.find((o) => o.number === 4)?.autopilotSuitability,
    null,
  );
});

test('filterOrphanIssues keeps below-floor orphans selectable in attended (default) mode', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    // autopilot omitted -> attended: nothing routed out; below-floor ranked last.
  });

  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [2, 1],
  );
  assert.deepEqual(result.routed_to_human, []);
});

test('filterOrphanIssues tie-breaks equal scores by lowest issue number', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 20, title: 'twenty', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 7, title: 'seven', state: 'OPEN', body: `task\n${m(5)}` },
    { number: 13, title: 'thirteen', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [7, 13, 20],
  );
});

test('filterOrphanIssues applies the effort hint as a soft tie-breaker within a score band', async () => {
  const s = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const e = (hint: string) => `<!-- idd-skill-effort: ${hint} -->`;
  // All four share score 4; effort orders the band: S (7, 20) before the
  // no-hint neutral (13) before L (4), with 7 < 20 broken by number.
  const issues = [
    {
      number: 20,
      title: 'twenty',
      state: 'OPEN',
      body: `t\n${s(4)}\n${e('S')}`,
    },
    { number: 7, title: 'seven', state: 'OPEN', body: `t\n${s(4)}\n${e('S')}` },
    { number: 13, title: 'thirteen', state: 'OPEN', body: `t\n${s(4)}` },
    { number: 4, title: 'four', state: 'OPEN', body: `t\n${s(4)}\n${e('L')}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
  });
  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [7, 20, 13, 4],
  );
  // The parsed hint is emitted per orphan for the cheap A4 Step 2 read.
  assert.equal(result.orphans.find((o) => o.number === 7)?.effort, 'S');
  assert.equal(result.orphans.find((o) => o.number === 13)?.effort, null);
  assert.equal(result.orphans.find((o) => o.number === 4)?.effort, 'L');
});

test('filterOrphanIssues leaves orphans unrouted when suitability is disabled', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 1, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 2, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilotSuitabilityEnabled: false,
  });

  assert.deepEqual(
    result.orphans.map((o) => o.number),
    [1, 2],
  );
  assert.deepEqual(result.routed_to_human, []);
});

// ---------------------------------------------------------------------------
// --with-claim-state annotation (#1395), mirroring
// discover-roadmap-graph.test.mts's claim-state block against
// filterOrphanIssues's own `claimState` option.
// ---------------------------------------------------------------------------

const CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIM_NOW = '2026-06-25T12:00:00Z';

// A claim posted recently relative to CLAIM_NOW is non-stale; one posted
// well over the 24h stale age earlier is stale.
const FRESH_CLAIM_AT = '2026-06-25T06:00:00Z';
const STALE_CLAIM_AT = '2026-06-20T06:00:00Z';

function claimComment(
  agentId: string,
  claimId: string,
  createdAt: string,
  { author = 'kurone-kito', branch = 'issue/701-task' } = {},
) {
  return {
    body: `<!-- claimed-by: ${agentId} ${claimId} supersedes: none ${createdAt} branch: ${branch} -->`,
    createdAt,
    author: { login: author },
  };
}

function buildClaimState(
  commentsByIssue: Map<number, unknown[]>,
  {
    currentClaimId = '',
    trustedActors = ['kurone-kito'],
    staleAgeMs = CLAIM_STALE_AGE_MS,
  }: {
    currentClaimId?: string;
    trustedActors?: string[];
    staleAgeMs?: number;
  } = {},
) {
  const trusted = new Set(trustedActors.map((value) => value.toLowerCase()));
  const seen: number[] = [];
  return {
    seen,
    resolution: {
      loadComments: (issueNumber: number) => {
        seen.push(issueNumber);
        return commentsByIssue.get(issueNumber) ?? [];
      },
      isTrustedAuthor: (login: string) =>
        trusted.has(String(login ?? '').toLowerCase()),
      staleAgeMs,
      nowIso: CLAIM_NOW,
      currentClaimId,
    },
  };
}

// Two open orphan candidates, no blockers.
function claimOrphanIssues() {
  return [
    { number: 701, title: 'leaf 701', state: 'OPEN', labels: [], body: '' },
    { number: 702, title: 'leaf 702', state: 'OPEN', labels: [], body: '' },
  ];
}

test('without --with-claim-state, orphans carry no claim fields and fetch no comments', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { seen } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    // claimState intentionally omitted (default path).
  });

  for (const orphan of result.orphans) {
    const record = orphan as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(record, 'activeClaim'), false);
    assert.equal(Object.hasOwn(record, 'claimEligible'), false);
  }
  // No comment fetch happened — the loader was never invoked.
  assert.deepEqual(seen, []);
});

test('a present non-stale claim marks the orphan claimEligible:false', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution, seen } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: false,
    claimId: 'claim-701',
    agentId: 'agent-a',
  });
  assert.equal(leaf701?.claimEligible, false);
  // Both open orphan candidates are probed.
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [701, 702],
  );
});

test('a stale claim is takeover-eligible: present:true, stale:true, claimEligible:true', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', STALE_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf701 = byNumber.get(701);
  assert.deepEqual(leaf701?.activeClaim, {
    present: true,
    stale: true,
    claimId: 'claim-701',
    agentId: 'agent-a',
  });
  assert.equal(leaf701?.claimEligible, true);
});

test('an unclaimed orphan is eligible: present:false, claimEligible:true', async () => {
  const issues = claimOrphanIssues();
  // 702 has no comments at all.
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  const leaf702 = byNumber.get(702);
  assert.deepEqual(leaf702?.activeClaim, {
    present: false,
    stale: false,
    claimId: null,
    agentId: null,
  });
  assert.equal(leaf702?.claimEligible, true);
});

test('an untrusted-author claim does not block the orphan', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [
      701,
      [
        claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT, {
          author: 'random-passerby',
        }),
      ],
    ],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  assert.equal(byNumber.get(701)?.activeClaim?.present, false);
  assert.equal(byNumber.get(701)?.claimEligible, true);
});

test('--current-claim-id sets ownedByCurrentSession on the matching claim', async () => {
  const issues = claimOrphanIssues();
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue, {
    currentClaimId: 'claim-701',
  });

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    claimState: resolution,
  });

  const byNumber = new Map(result.orphans.map((o) => [o.number, o]));
  assert.equal(byNumber.get(701)?.activeClaim?.ownedByCurrentSession, true);
  // 702 is unclaimed, so ownedByCurrentSession is still emitted, as false.
  assert.equal(byNumber.get(702)?.activeClaim?.ownedByCurrentSession, false);
});

test('claim-state annotation survives the autopilot floor routing split', async () => {
  const m = (n: number) => `<!-- idd-skill-autopilot-suitability: ${n} -->`;
  const issues = [
    { number: 701, title: 'low', state: 'OPEN', body: `task\n${m(1)}` },
    { number: 702, title: 'high', state: 'OPEN', body: `task\n${m(5)}` },
  ];
  const commentsByIssue = new Map<number, unknown[]>([
    [701, [claimComment('agent-a', 'claim-701', FRESH_CLAIM_AT)]],
  ]);
  const { resolution } = buildClaimState(commentsByIssue);

  const result = await filterOrphanIssues(issues, {
    issueStateByNumber: new Map(),
    fetchIssueStateByNumber: () => 'UNRESOLVABLE',
    autopilotSuitabilityFloor: 3,
    autopilot: true,
    claimState: resolution,
  });

  // #701 is routed below the floor, but still carries the annotation.
  assert.deepEqual(
    result.routed_to_human.map((o) => o.number),
    [701],
  );
  assert.equal(result.routed_to_human[0]?.claimEligible, false);
  assert.equal(result.orphans[0]?.number, 702);
  assert.equal(result.orphans[0]?.claimEligible, true);
});
