import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderClaimedByMarker } from '../src/scripts/marker-helpers.mts';
import {
  parseProviderOutageParkComment,
  renderProviderOutageParkComment,
  toSecondPrecisionIso,
} from '../src/scripts/protocol-helpers.mts';
import type { ProviderHealthVerdict } from '../src/scripts/provider-health.mts';
import {
  buildParkedChangeList,
  buildParkedChangeReport,
  buildParkedIssuesSummary,
  classifyParkMarker,
  computeBoundReached,
  deriveParkedIssues,
  PARK_ELIGIBLE_BLOCKER_GATES,
  type RawParkMarker,
  resolveParkEligibility,
} from '../src/scripts/provider-outage-park.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

// ---------------------------------------------------------------------------
// toSecondPrecisionIso -- Copilot review finding (PR #2421): the default
// `now` in runParkPullRequest/buildParkedChangeReport must never carry
// fractional seconds, or renderProviderOutageParkComment's strict
// second-precision check throws on every ordinary --park --apply call. The
// pure function itself is now the shared implementation in
// marker-helpers.mts (#2568); see tests/marker-helpers-timestamp.test.mts
// for direct unit coverage. This test keeps the integration regression.
// ---------------------------------------------------------------------------

test('toSecondPrecisionIso output is accepted by renderProviderOutageParkComment (regression for PR #2421 review finding)', () => {
  const now = toSecondPrecisionIso(new Date('2026-09-02T00:00:00.999Z'));
  assert.doesNotThrow(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'a'.repeat(40),
      claimId: 'claim-1',
      parkedAt: now,
      blockers: ['advisory-wait'],
    }),
  );
});

// ---------------------------------------------------------------------------
// computeBoundReached -- Codex/CodeRabbit review finding (PR #2421): a
// sampled open-PR read must never let an undercounted `count` read as
// "still under the limit".
// ---------------------------------------------------------------------------

test('computeBoundReached: below the limit and not truncated is not reached', () => {
  assert.equal(computeBoundReached(3, 10, false), false);
});

test('computeBoundReached: at or above the limit is reached regardless of truncation', () => {
  assert.equal(computeBoundReached(10, 10, false), true);
  assert.equal(computeBoundReached(15, 10, false), true);
});

test('computeBoundReached: a truncated sample fails closed to reached even when the sampled count is low', () => {
  assert.equal(computeBoundReached(1, 10, true), true);
});

// ---------------------------------------------------------------------------
// resolveParkEligibility (#2321) -- the fail-closed gate
// ---------------------------------------------------------------------------

test('resolveParkEligibility: unavailable verdict with a mapped blocker is eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'advisory-wait',
  ]);
  assert.deepEqual(result, {
    eligible: true,
    reason: 'eligible',
    unmappedBlockers: [],
  });
});

test('resolveParkEligibility: an empty blocker list is never eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', []);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no-blockers');
});

test('resolveParkEligibility: one unmapped gate refuses the whole request', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'advisory-wait',
    'review-currency',
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unmapped-blocker');
  assert.deepEqual(result.unmappedBlockers, ['review-currency']);
});

test('resolveParkEligibility: a blocker that maps to the OTHER service is not eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'ci',
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unmapped-blocker');
  assert.deepEqual(result.unmappedBlockers, ['ci']);
});

test('resolveParkEligibility: degraded/unknown/healthy verdicts are never eligible even with mapped blockers', () => {
  for (const verdict of ['degraded', 'unknown', 'healthy']) {
    const result = resolveParkEligibility('advisory-review', verdict, [
      'advisory-wait',
    ]);
    assert.equal(result.eligible, false, `verdict ${verdict} must not park`);
    assert.equal(result.reason, 'verdict-not-unavailable');
  }
});

test('resolveParkEligibility: ci-actions maps to ci and discarded-required-check-siblings only', () => {
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', ['ci']).eligible,
    true,
  );
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', [
      'discarded-required-check-siblings',
    ]).eligible,
    true,
  );
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', ['advisory-wait'])
      .eligible,
    false,
  );
});

test('PARK_ELIGIBLE_BLOCKER_GATES: never includes review-currency or disposition-evidence for either service', () => {
  for (const gates of Object.values(PARK_ELIGIBLE_BLOCKER_GATES)) {
    assert.equal(gates.has('review-currency'), false);
    assert.equal(gates.has('disposition-evidence'), false);
  }
});

// ---------------------------------------------------------------------------
// buildParkedChangeList (#2321) -- deterministic ordering, resumability
// ---------------------------------------------------------------------------

function rawMarker(
  overrides: Partial<RawParkMarker['marker']> = {},
): RawParkMarker['marker'] {
  return {
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
    createdAt: 'none',
    ...overrides,
  };
}

test('buildParkedChangeList: sorted by parkedAt, earliest first', () => {
  const { entries } = buildParkedChangeList(
    [
      { prNumber: 10, marker: rawMarker({ parkedAt: '2026-09-02T12:00:00Z' }) },
      { prNumber: 20, marker: rawMarker({ parkedAt: '2026-09-01T00:00:00Z' }) },
    ],
    new Map([['advisory-review', 'unavailable']]),
  );
  assert.deepEqual(
    entries.map((e) => e.prNumber),
    [20, 10],
  );
});

test('buildParkedChangeList: same parkedAt breaks the tie by pull request number', () => {
  const { entries } = buildParkedChangeList(
    [
      { prNumber: 30, marker: rawMarker({ parkedAt: '2026-09-02T00:00:00Z' }) },
      { prNumber: 15, marker: rawMarker({ parkedAt: '2026-09-02T00:00:00Z' }) },
    ],
    new Map([['advisory-review', 'unavailable']]),
  );
  assert.deepEqual(
    entries.map((e) => e.prNumber),
    [15, 30],
  );
});

test('buildParkedChangeList: resumable only once the live verdict is healthy', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'healthy']]),
  );
  assert.equal(entries[0].resumable, true);
  assert.equal(entries[0].verdict, 'healthy');

  const stillParked = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'degraded']]),
  );
  assert.equal(stillParked.entries[0].resumable, false);
});

test('buildParkedChangeList: a service with no live verdict entry reports unknown, not resumable', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map(),
  );
  assert.equal(entries[0].verdict, 'unknown');
  assert.equal(entries[0].resumable, false);
});

test('buildParkedChangeList: count matches the entry count', () => {
  const { entries, count } = buildParkedChangeList(
    [
      { prNumber: 1, marker: rawMarker() },
      { prNumber: 2, marker: rawMarker() },
      { prNumber: 3, marker: rawMarker() },
    ],
    new Map(),
  );
  assert.equal(count, 3);
  assert.equal(entries.length, 3);
});

// ---------------------------------------------------------------------------
// classifyParkMarker / deriveParkedIssues / parkedIssuesComplete (#3277) --
// only a LIVE park marker counts toward entries/count/boundReached/
// parkedIssues; a stale one is excluded and counted in retiredCount.
// ---------------------------------------------------------------------------

test('classifyParkMarker: a head mismatch retires the marker without resolving the issue claim (#3379 review)', () => {
  const marker = rawMarker({ headSha: 'a'.repeat(40) });
  let resolverCalls = 0;
  const classification = classifyParkMarker(marker, 'b'.repeat(40), () => {
    resolverCalls += 1;
    return null;
  });
  assert.equal(classification, 'retired:head-moved');
  assert.equal(resolverCalls, 0);
});

test('classifyParkMarker: a matching head with no later claim is live', () => {
  const marker = rawMarker({ headSha: 'a'.repeat(40) });
  assert.equal(
    classifyParkMarker(marker, 'a'.repeat(40), () => null),
    'live',
  );
});

test('classifyParkMarker: an absent/unreadable PR head SHA fails CLOSED to retired (#3379 review, Copilot)', () => {
  const marker = rawMarker({ headSha: 'a'.repeat(40) });
  assert.equal(
    classifyParkMarker(marker, '', () => null),
    'retired:head-moved',
  );
});

test('classifyParkMarker: a trusted claimed-by after the park comment createdAt is not live', () => {
  const marker = rawMarker({ createdAt: '2026-09-02T00:00:00Z' });
  assert.equal(
    classifyParkMarker(marker, marker.headSha, () => '2026-09-02T00:00:05Z'),
    'retired:later-claim',
  );
});

test('classifyParkMarker: a trusted claimed-by at or before the park comment createdAt is still live', () => {
  const marker = rawMarker({ createdAt: '2026-09-02T00:00:05Z' });
  assert.equal(
    classifyParkMarker(marker, marker.headSha, () => '2026-09-02T00:00:05Z'),
    'live',
  );
  assert.equal(
    classifyParkMarker(marker, marker.headSha, () => '2026-09-02T00:00:00Z'),
    'live',
  );
});

test('classifyParkMarker: a null issueLatestClaimCreatedAt (failed issue-comment read) fails open to live', () => {
  const marker = rawMarker({ createdAt: '2026-09-02T00:00:00Z' });
  assert.equal(
    classifyParkMarker(marker, marker.headSha, () => null),
    'live',
  );
});

test('classifyParkMarker: an unreadable park-comment createdAt ("none") fails open to live without resolving the issue claim (#3379 review)', () => {
  const marker = rawMarker({ createdAt: 'none' });
  let resolverCalls = 0;
  const classification = classifyParkMarker(marker, marker.headSha, () => {
    resolverCalls += 1;
    return '2099-01-01T00:00:00Z';
  });
  assert.equal(classification, 'live');
  assert.equal(resolverCalls, 0);
});

test('classifyParkMarker: an unsupported service value retires the marker without resolving the issue claim (#3379 review)', () => {
  const marker = rawMarker({ service: 'not-a-real-service' });
  let resolverCalls = 0;
  const classification = classifyParkMarker(marker, marker.headSha, () => {
    resolverCalls += 1;
    return null;
  });
  assert.equal(classification, 'retired:unsupported-service');
  assert.equal(resolverCalls, 0);
});

test('classifyParkMarker: liveness compares the comment createdAt, never the embedded parked: field (#3277 AC)', () => {
  // parkedAt (the embedded, parking-agent-local clock) is AFTER the claim;
  // createdAt (the GitHub comment's own timestamp) is BEFORE it. Selecting
  // on parkedAt would wrongly read this as live; comparing on createdAt
  // correctly retires it.
  const marker = rawMarker({
    parkedAt: '2026-09-02T12:00:00Z',
    createdAt: '2026-09-02T00:00:00Z',
  });
  assert.equal(
    classifyParkMarker(marker, marker.headSha, () => '2026-09-02T06:00:00Z'),
    'retired:later-claim',
  );
});

test('deriveParkedIssues: a live, non-resumable (non-healthy) entry is included', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'degraded']]),
  );
  assert.deepEqual(deriveParkedIssues(entries), [2321]);
});

test('deriveParkedIssues: a resumable (healthy) entry is excluded', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'healthy']]),
  );
  assert.deepEqual(deriveParkedIssues(entries), []);
});

test('deriveParkedIssues: sorted and de-duplicated across entries sharing an issue', () => {
  const { entries } = buildParkedChangeList(
    [
      { prNumber: 5, marker: rawMarker({ issueNumber: 40 }) },
      { prNumber: 1, marker: rawMarker({ issueNumber: 10 }) },
      { prNumber: 2, marker: rawMarker({ issueNumber: 10 }) },
    ],
    new Map([['advisory-review', 'degraded']]),
  );
  assert.deepEqual(deriveParkedIssues(entries), [10, 40]);
});

// ---------------------------------------------------------------------------
// buildParkedChangeReport / buildParkedIssuesSummary -- injected-fetcher
// tests exercising the real collectRawParkMarkers wiring and the
// parkedIssuesComplete / cheap-mode contracts network-injected end to end.
// ---------------------------------------------------------------------------

function fakeHealthReport(
  verdicts: Partial<
    Record<'advisory-review' | 'ci-actions', ProviderHealthVerdict>
  > = {},
) {
  const build = (service: 'advisory-review' | 'ci-actions') => ({
    service,
    verdict: verdicts[service] ?? 'healthy',
    reason: 'all-healthy',
    distinctFailingPrCount: 0,
    distinctSuccessPrCount: 0,
    minCorroboratingPrs: 0,
  });
  return {
    protocolVersion: '1' as const,
    now: '2026-09-02T00:00:00Z',
    services: {
      'advisory-review': build('advisory-review'),
      'ci-actions': build('ci-actions'),
    },
  };
}

/** Isolates a test from any host-set trusted-marker-actor env override,
 * so `config.trustedMarkerActors` below is the actual, deterministic
 * source `resolveTrustedMarkerActors` resolves from. */
function withoutTrustedMarkerActorsEnv<T>(run: () => T): T {
  const saved = process.env.IDD_TRUSTED_MARKER_ACTORS;
  delete process.env.IDD_TRUSTED_MARKER_ACTORS;
  try {
    return run();
  } finally {
    if (saved !== undefined) process.env.IDD_TRUSTED_MARKER_ACTORS = saved;
  }
}

test('buildParkedIssuesSummary: every service healthy short-circuits with no per-PR read (#3277 AC)', () => {
  const summary = withoutTrustedMarkerActorsEnv(() =>
    buildParkedIssuesSummary('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      buildHealthReport: () => fakeHealthReport(),
      fetchOpenPullRequests: () => {
        throw new Error(
          'open-pull-request read must not happen when all healthy',
        );
      },
      fetchComments: () => {
        throw new Error('comment read must not happen when all healthy');
      },
    }),
  );
  assert.deepEqual(summary, { parkedIssues: [], parkedIssuesComplete: true });
});

test('buildParkedIssuesSummary: a non-healthy service falls through to the full report, reusing the health report', () => {
  let healthReportCalls = 0;
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const summary = withoutTrustedMarkerActorsEnv(() =>
    buildParkedIssuesSummary('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      buildHealthReport: () => {
        healthReportCalls += 1;
        return fakeHealthReport({ 'advisory-review': 'degraded' });
      },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: (_owner, _repo, number: number) =>
        number === 7
          ? [
              {
                body: markerBody,
                created_at: '2026-09-02T00:00:05Z',
                user: { login: 'kurone-kito' },
              },
            ]
          : [],
    }),
  );
  // Reused the already-computed health report -- exactly one call, not a
  // second one inside buildParkedChangeReport.
  assert.equal(healthReportCalls, 1);
  assert.deepEqual(summary, {
    parkedIssues: [555],
    parkedIssuesComplete: true,
  });
});

test('buildParkedChangeReport: a head-mismatched marker found via the real fetch wiring is excluded, counted as retired, and never triggers an issue-comment read (#3379 review)', () => {
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  let issueReadCalls = 0;
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'b'.repeat(40) } }, // head moved since parking
      ],
      fetchComments: (_owner, _repo, number: number) => {
        if (number === 7) {
          return [
            {
              body: markerBody,
              created_at: '2026-09-02T00:00:05Z',
              user: { login: 'kurone-kito' },
            },
          ];
        }
        // Issue 555's own comments: must never be read -- the head
        // mismatch above already retires the marker.
        issueReadCalls += 1;
        return [];
      },
    }),
  );
  assert.equal(issueReadCalls, 0);
  assert.equal(report.count, 0);
  assert.deepEqual(report.entries, []);
  assert.equal(report.retiredCount, 1);
  assert.deepEqual(report.parkedIssues, []);
});

test('buildParkedChangeReport: two markers sharing one originating issue read that issue only once (#3379 review, Copilot)', () => {
  const markerBodyFor = (prNumber: number) =>
    renderProviderOutageParkComment({
      actor: 'claude-1',
      issueNumber: 555,
      service: 'advisory-review',
      headSha: 'a'.repeat(40),
      claimId: `claim-${prNumber}`,
      parkedAt: '2026-09-02T00:00:00Z',
      blockers: ['advisory-wait'],
    });
  let issueReadCalls = 0;
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } },
        { number: 8, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: (_owner, _repo, number: number) => {
        if (number === 7 || number === 8) {
          return [
            {
              body: markerBodyFor(number),
              created_at: '2026-09-02T00:00:05Z',
              user: { login: 'kurone-kito' },
            },
          ];
        }
        // Issue 555's own comments, shared by both PR #7 and PR #8's
        // markers -- must be read only once for the whole collection.
        issueReadCalls += 1;
        return [];
      },
    }),
  );
  assert.equal(issueReadCalls, 1);
  assert.equal(report.count, 2);
  assert.deepEqual(report.parkedIssues, [555]);
});

test('buildParkedChangeReport: a REAL later claimed-by comment on the originating issue (via renderClaimedByMarker, latestTrustedClaimCreatedAt end to end) retires the marker', () => {
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const laterClaimBody = renderClaimedByMarker({
    agentId: 'claude-2',
    claimId: 'claim-2',
    supersedes: 'none',
    timestamp: '2026-09-02T01:00:00Z',
    branch: 'issue/555-resume',
  });
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } }, // head still matches
      ],
      fetchComments: (_owner, _repo, number: number) => {
        if (number === 7) {
          return [
            {
              body: markerBody,
              created_at: '2026-09-02T00:00:05Z', // AFTER the marker
              user: { login: 'kurone-kito' },
            },
          ];
        }
        // Issue 555's own comments: a trusted re-claim posted after the
        // park comment's created_at above.
        return [
          {
            body: laterClaimBody,
            created_at: '2026-09-02T02:00:00Z',
            user: { login: 'kurone-kito' },
            lastEditedAt: null,
          },
        ];
      },
    }),
  );
  assert.equal(report.count, 0);
  assert.equal(report.retiredCount, 1);
  assert.deepEqual(report.parkedIssues, []);
});

test('buildParkedChangeReport: an edited later claimed-by comment does not retire the marker', () => {
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const laterClaimBody = renderClaimedByMarker({
    agentId: 'claude-2',
    claimId: 'claim-2',
    supersedes: 'none',
    timestamp: '2026-09-02T01:00:00Z',
    branch: 'issue/555-resume',
  });
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: (_owner, _repo, number: number) =>
        number === 7
          ? [
              {
                body: markerBody,
                created_at: '2026-09-02T00:00:05Z',
                user: { login: 'kurone-kito' },
              },
            ]
          : [
              {
                body: laterClaimBody,
                created_at: '2026-09-02T02:00:00Z',
                user: { login: 'kurone-kito' },
                lastEditedAt: '2026-09-02T03:00:00Z',
              },
            ],
    }),
  );
  assert.equal(report.count, 1);
  assert.equal(report.retiredCount, 0);
  assert.deepEqual(report.parkedIssues, [555]);
});

test('buildParkedChangeReport: a real claimed-by comment BEFORE the park comment does not retire the marker', () => {
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const earlierClaimBody = renderClaimedByMarker({
    agentId: 'claude-1',
    claimId: 'claim-1',
    supersedes: 'none',
    timestamp: '2026-09-01T00:00:00Z',
    branch: 'issue/555-fix',
  });
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: (_owner, _repo, number: number) =>
        number === 7
          ? [
              {
                body: markerBody,
                created_at: '2026-09-02T00:00:05Z',
                user: { login: 'kurone-kito' },
              },
            ]
          : [
              {
                body: earlierClaimBody,
                created_at: '2026-09-01T00:00:00Z', // BEFORE the marker
                user: { login: 'kurone-kito' },
                lastEditedAt: null,
              },
            ],
    }),
  );
  assert.equal(report.count, 1);
  assert.equal(report.retiredCount, 0);
  assert.deepEqual(report.parkedIssues, [555]);
});

test('buildParkedChangeReport: a failed originating-issue comment read keeps the marker live and parkedIssuesComplete true (#3277 AC)', () => {
  const markerBody = renderProviderOutageParkComment({
    actor: 'claude-1',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      fetchOpenPullRequests: () => [
        { number: 7, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: (_owner, _repo, number: number) => {
        if (number === 7) {
          return [
            {
              body: markerBody,
              created_at: '2026-09-02T00:00:05Z',
              user: { login: 'kurone-kito' },
            },
          ];
        }
        // Issue 555's own comment read fails -- must NOT retire the
        // marker or count toward prCommentReadFailureCount/
        // parkedIssuesComplete (only a failed PULL-REQUEST comment read
        // does that).
        throw new Error('boom');
      },
    }),
  );
  assert.equal(report.count, 1);
  assert.equal(report.retiredCount, 0);
  assert.deepEqual(report.parkedIssues, [555]);
  assert.equal(report.parkedIssuesComplete, true);
});

test('buildParkedChangeReport: parkedIssuesComplete is false when the open-PR sample is truncated', () => {
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      sampleSize: 2,
      fetchOpenPullRequests: () => [
        { number: 1, head: { sha: 'a'.repeat(40) } },
        { number: 2, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: () => [],
    }),
  );
  assert.equal(report.sampleTruncated, true);
  assert.equal(report.parkedIssuesComplete, false);
});

test('buildParkedChangeReport: parkedIssuesComplete is false when one per-PR comment read fails (issue-comment failures do not count)', () => {
  let call = 0;
  const report = withoutTrustedMarkerActorsEnv(() =>
    buildParkedChangeReport('acme', 'widget', {
      config: { trustedMarkerActors: ['kurone-kito'] },
      sampleSize: 50,
      fetchOpenPullRequests: () => [
        { number: 1, head: { sha: 'a'.repeat(40) } },
        { number: 2, head: { sha: 'a'.repeat(40) } },
      ],
      fetchComments: () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return [];
      },
    }),
  );
  assert.equal(report.sampleTruncated, false);
  assert.equal(report.parkedIssuesComplete, false);
  assert.equal(report.retiredCount, 0);
});

test('provider-outage-park.mts CLI rejects --park combined with --parked-issues before either mode runs', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  assert.ok(
    source.includes('--park and --parked-issues are mutually exclusive'),
    'the CLI must fail closed when both --park and --parked-issues are given',
  );
});

// ---------------------------------------------------------------------------
// Marker render/parse round-trip
// ---------------------------------------------------------------------------

test('renderProviderOutageParkComment / parseProviderOutageParkComment round-trip', () => {
  const body = renderProviderOutageParkComment({
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'b'.repeat(40),
    claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait', 'copilot-terminal-unavailable'],
  });
  const parsed = parseProviderOutageParkComment(body, '2026-09-02T00:00:05Z');
  assert.deepEqual(parsed, {
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'b'.repeat(40),
    claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait', 'copilot-terminal-unavailable'],
    createdAt: '2026-09-02T00:00:05Z',
  });
});

test('renderProviderOutageParkComment: rejects a malformed payload', () => {
  assert.throws(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'not-40-hex',
      claimId: 'claim-1',
      parkedAt: '2026-09-02T00:00:00Z',
      blockers: ['advisory-wait'],
    }),
  );
});

test('renderProviderOutageParkComment: rejects an empty blockers list (the issue AC requires naming the blocking evidence)', () => {
  assert.throws(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'a'.repeat(40),
      claimId: 'claim-1',
      parkedAt: '2026-09-02T00:00:00Z',
      blockers: [],
    }),
  );
});

test('parseProviderOutageParkComment: an ordinary comment is not a park marker', () => {
  assert.equal(
    parseProviderOutageParkComment(
      'just a regular PR comment',
      '2026-09-02T00:00:00Z',
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('committed provider-outage-park fixture validates against its schema', () => {
  const schema = loadJson('schemas/provider-outage-park.schema.json');
  const fixture = JSON.parse(
    readFileSync('fixtures/schemas/provider-outage-park.valid.json', 'utf8'),
  );
  const errors = validate(fixture, schema);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// Never a merge-readiness/CI-gate result, never thread/gate/merge mutation
// ---------------------------------------------------------------------------

test('provider-outage-park.mts never generates a raw new Date().toISOString() default (regression for PR #2421 review finding)', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  assert.ok(
    !source.includes('new Date().toISOString()'),
    'every default `now` must go through toSecondPrecisionIso, never a raw millisecond-precision Date#toISOString()',
  );
});

test('provider-outage-park.mts sorts the open pull request sample by most-recently-updated (regression for PR #2421 review finding)', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  assert.ok(
    source.includes('sort=updated&direction=desc'),
    'the open pull request list read must sort by updated/desc to match the "most-recently-updated" contract its own docstring claims',
  );
});

test('provider-outage-park.mts never imports thread-resolution, merge-execution, or pre-merge-readiness mutation modules', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  for (const forbidden of [
    'resolve-review-thread.mts',
    'idd-merge-execute.mts',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `provider-outage-park.mts must not import ${forbidden} -- parking never resolves a thread, satisfies a gate, or merges`,
    );
  }
});
