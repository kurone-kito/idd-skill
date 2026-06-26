import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoadmapGraphReport } from '../src/scripts/discover-roadmap-graph.mts';
import {
  buildRoadmapCompletionAuditBody,
  evaluateRoadmapAuditGates,
  evaluateRoadmapClaim,
  type RoadmapAuditExecuteDeps,
  runRoadmapAuditExecute,
} from '../src/scripts/idd-roadmap-audit-execute.mts';
import { renderClaimedByMarker } from '../src/scripts/protocol-helpers.mts';

const ROADMAP = 995;
const CLAIM_ID = 'claim-20260626T000000Z-995';
const AGENT_ID = 'github-copilot-cli';
const CLAIM_BRANCH = 'roadmap-audit/995-completed-roadmap';

interface NodeOverride {
  number: number;
  title?: string;
  state?: string;
  classification?: 'roadmap' | 'execution';
  labels?: string[];
}

function node(override: NodeOverride) {
  return {
    number: override.number,
    title: override.title ?? `issue ${override.number}`,
    state: override.state ?? 'CLOSED',
    labels: override.labels ?? [],
    classification: override.classification ?? 'execution',
    roadmapMarkerId: override.classification === 'roadmap' ? 'epic' : '',
    autopilotSuitability: null,
    effort: null,
    depth: override.number === ROADMAP ? 0 : 1,
  };
}

// A roadmap graph whose every referenced child is closed (ready to close).
// Each test deep-mutates a fresh copy to flip exactly one completion fact.
function readyReport(): RoadmapGraphReport {
  return {
    root: {
      number: ROADMAP,
      title: 'completed roadmap',
      state: 'OPEN',
      classification: 'roadmap',
      roadmapMarkerId: 'epic',
    },
    nodes: [
      node({ number: ROADMAP, classification: 'roadmap', state: 'OPEN' }),
      node({ number: 1047, classification: 'execution', state: 'CLOSED' }),
      node({ number: 1048, classification: 'execution', state: 'CLOSED' }),
    ],
    edges: [
      {
        source: ROADMAP,
        target: 1047,
        relationship: 'task-list',
        evidence: '- [x] #1047',
      },
      {
        source: ROADMAP,
        target: 1048,
        relationship: 'task-list',
        evidence: '- [x] #1048',
      },
    ],
    provenancePaths: [
      { target: ROADMAP, path: [ROADMAP] },
      { target: 1047, path: [ROADMAP, 1047] },
      { target: 1048, path: [ROADMAP, 1048] },
    ],
    roadmapNodes: [],
    executionCandidates: [],
    diagnostics: {
      duplicateReferences: [],
      cycles: [],
      inaccessibleReferences: [],
      unresolvedReferences: [],
    },
    summary: {
      rootNumber: ROADMAP,
      nodeCount: 3,
      edgeCount: 2,
      roadmapNodeCount: 0,
      executionCandidateCount: 0,
      duplicateReferenceCount: 0,
      cycleCount: 0,
      inaccessibleReferenceCount: 0,
      unresolvedReferenceCount: 0,
      maxDepth: 1,
    },
  };
}

function claimComment(overrides: { claimId?: string; agentId?: string } = {}) {
  return {
    body: renderClaimedByMarker({
      agentId: overrides.agentId ?? AGENT_ID,
      claimId: overrides.claimId ?? CLAIM_ID,
      supersedes: 'none',
      timestamp: '2026-06-26T00:00:00Z',
      branch: CLAIM_BRANCH,
    }),
    createdAt: '2026-06-26T00:00:00Z',
    author: { login: 'kurone-kito' },
  };
}

function makeDeps(
  report: RoadmapGraphReport,
  overrides: Partial<RoadmapAuditExecuteDeps> = {},
): {
  deps: RoadmapAuditExecuteDeps;
  calls: {
    collects: number;
    comments: { issue: number; body: string }[];
    closed: number[];
    released: { issue: number; agentId: string; claimId: string }[];
  };
} {
  const calls = {
    collects: 0,
    comments: [] as { issue: number; body: string }[],
    closed: [] as number[],
    released: [] as { issue: number; agentId: string; claimId: string }[],
  };
  const deps: RoadmapAuditExecuteDeps = {
    collect: async () => {
      calls.collects += 1;
      return report;
    },
    revalidateClaim: () => ({
      owned: true,
      reason: 'match',
      stale: false,
      activeClaim: {
        agentId: AGENT_ID,
        claimId: CLAIM_ID,
        supersedes: 'none',
        branch: CLAIM_BRANCH,
        createdAt: '2026-06-26T00:00:00Z',
      },
    }),
    postEvidenceComment: (issue, body) => calls.comments.push({ issue, body }),
    closeRoadmap: (issue) => calls.closed.push(issue),
    releaseClaim: (issue, fields) =>
      calls.released.push({
        issue,
        agentId: fields.agentId,
        claimId: fields.claimId,
      }),
    now: () => '2026-06-26T01:00:00Z',
    ...overrides,
  };
  return { deps, calls };
}

const APPLY_ARGS = [
  '--roadmap',
  String(ROADMAP),
  '--claim-id',
  CLAIM_ID,
  '--apply',
];

// ---------------------------------------------------------------------------
// evaluateRoadmapAuditGates (pure)
// ---------------------------------------------------------------------------

test('evaluateRoadmapAuditGates returns no blockers when every child is closed', () => {
  assert.deepEqual(evaluateRoadmapAuditGates(readyReport()), []);
});

test('an open execution child becomes an open-child blocker with provenance', () => {
  const report = readyReport();
  report.nodes = report.nodes.map((entry) =>
    entry.number === 1048 ? { ...entry, state: 'OPEN' } : entry,
  );
  report.executionCandidates = [1048];
  const blockers = evaluateRoadmapAuditGates(report);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]?.kind, 'open-child');
  assert.equal(blockers[0]?.target, 1048);
  assert.deepEqual(blockers[0]?.provenance, [ROADMAP, 1048]);
});

test('an open nested roadmap descendant is never closeable', () => {
  const report = readyReport();
  report.nodes = [
    ...report.nodes,
    node({ number: 1100, classification: 'roadmap', state: 'OPEN' }),
  ];
  report.roadmapNodes = [1100];
  report.provenancePaths = [
    ...report.provenancePaths,
    { target: 1100, path: [ROADMAP, 1100] },
  ];
  const blockers = evaluateRoadmapAuditGates(report);
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['nested-roadmap'],
  );
  assert.equal(blockers[0]?.target, 1100);
});

test('a closed nested roadmap does not block (bottom-up completion)', () => {
  const report = readyReport();
  report.nodes = [
    ...report.nodes,
    node({ number: 1100, classification: 'roadmap', state: 'CLOSED' }),
  ];
  report.roadmapNodes = [1100];
  assert.deepEqual(evaluateRoadmapAuditGates(report), []);
});

test('unresolved, inaccessible, and cycle diagnostics each surface a blocker', () => {
  const report = readyReport();
  report.diagnostics.unresolvedReferences = [
    {
      source: ROADMAP,
      target: 4242,
      relationship: 'task-list',
      evidence: '- [ ] #4242',
      reason: 'issue_not_found',
    },
  ];
  report.diagnostics.inaccessibleReferences = [
    {
      source: ROADMAP,
      target: 4343,
      relationship: 'task-list',
      evidence: '- [ ] #4343',
      reason: 'issue_inaccessible',
    },
  ];
  report.diagnostics.cycles = [
    {
      source: 1047,
      target: ROADMAP,
      relationship: 'dependency',
      path: [ROADMAP, 1047, ROADMAP],
    },
  ];
  const kinds = evaluateRoadmapAuditGates(report)
    .map((blocker) => blocker.kind)
    .sort();
  assert.deepEqual(kinds, [
    'cycle',
    'inaccessible-reference',
    'unresolved-reference',
  ]);
});

test('a childless roadmap (no edges) is reported, never closed', () => {
  const report = readyReport();
  report.nodes = [
    node({ number: ROADMAP, classification: 'roadmap', state: 'OPEN' }),
  ];
  report.edges = [];
  report.provenancePaths = [{ target: ROADMAP, path: [ROADMAP] }];
  const blockers = evaluateRoadmapAuditGates(report);
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['childless'],
  );
});

test('a human-gate label on the roadmap root blocks the close', () => {
  const report = readyReport();
  report.nodes = report.nodes.map((entry) =>
    entry.number === ROADMAP
      ? { ...entry, labels: ['roadmap', 'status:blocked-by-human'] }
      : entry,
  );
  const blockers = evaluateRoadmapAuditGates(report);
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['roadmap-blocked'],
  );
});

// ---------------------------------------------------------------------------
// buildRoadmapCompletionAuditBody (pure)
// ---------------------------------------------------------------------------

test('the evidence body is the canonical IDD roadmap completion audit comment', () => {
  const body = buildRoadmapCompletionAuditBody(readyReport());
  assert.match(body, /^\*\*IDD roadmap completion audit\*\*/);
  assert.match(body, /Roadmap #995 "completed roadmap"/);
  assert.match(body, /Closed execution leaves: #1047, #1048\./);
  assert.match(
    body,
    /Open \/ unresolved \/ inaccessible \/ nested-roadmap descendants: none\./,
  );
  assert.match(body, /Closing the roadmap as completed\./);
});

// ---------------------------------------------------------------------------
// evaluateRoadmapClaim (pure)
// ---------------------------------------------------------------------------

test('a present, matching, fresh claim is owned', () => {
  const verdict = evaluateRoadmapClaim([claimComment()], {
    expectedClaimId: CLAIM_ID,
    expectedAgentId: AGENT_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, true);
  assert.equal(verdict.reason, 'match');
});

test('a missing or mismatched claim is not owned', () => {
  const missing = evaluateRoadmapClaim([], {
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(missing.owned, false);
  assert.equal(missing.reason, 'missing-active-claim');

  const mismatch = evaluateRoadmapClaim([claimComment({ claimId: 'other' })], {
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(mismatch.owned, false);
  assert.equal(mismatch.reason, 'claim-id-mismatch');
});

test('a stale (takeover-eligible) claim is not owned', () => {
  const verdict = evaluateRoadmapClaim([claimComment()], {
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    // > 24h after the claim createdAt → stale per the distributed default.
    nowIso: '2026-06-28T00:00:01Z',
  });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, 'claim-stale');
  assert.equal(verdict.stale, true);
});

test('an untrusted claim author yields no active claim', () => {
  const verdict = evaluateRoadmapClaim([claimComment()], {
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => false,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, 'missing-active-claim');
});

// ---------------------------------------------------------------------------
// runRoadmapAuditExecute (orchestration with injected deps)
// ---------------------------------------------------------------------------

test('dry-run on a ready roadmap reports ready with the evidence body, no mutation', async () => {
  const { deps, calls } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.decisionAuthority, 'instructions');
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.match(verdict.evidenceBody, /IDD roadmap completion audit/);
  assert.equal(verdict.closed, false);
  assert.equal(verdict.claimReleased, false);
  assert.equal(exitCode, 0);
  // Dry-run never mutates.
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.released, []);
});

test('dry-run on a blocked roadmap reports the open-child blocker, empty body', async () => {
  const report = readyReport();
  report.nodes = report.nodes.map((entry) =>
    entry.number === 1048 ? { ...entry, state: 'OPEN' } : entry,
  );
  report.executionCandidates = [1048];
  const { deps, calls } = makeDeps(report);
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(verdict.ready, false);
  assert.equal(verdict.blockers[0]?.kind, 'open-child');
  assert.equal(verdict.evidenceBody, '');
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
});

test('--apply on a ready roadmap posts the comment, closes, and releases the claim in order', async () => {
  const { deps, calls } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.ready, true);
  assert.equal(verdict.closed, true);
  assert.equal(verdict.claimReleased, true);
  assert.equal(exitCode, 0);
  assert.equal(calls.comments.length, 1);
  assert.equal(calls.comments[0]?.issue, ROADMAP);
  assert.match(calls.comments[0]?.body ?? '', /IDD roadmap completion audit/);
  assert.deepEqual(calls.closed, [ROADMAP]);
  assert.equal(calls.released[0]?.claimId, CLAIM_ID);
  // collect runs twice: initial evaluation + immediate-pre-close re-validation.
  assert.equal(calls.collects, 2);
});

test('--apply on a blocked roadmap fails closed without mutating', async () => {
  const report = readyReport();
  report.nodes = report.nodes.map((entry) =>
    entry.number === 1047 ? { ...entry, state: 'OPEN' } : entry,
  );
  report.executionCandidates = [1047];
  const { deps, calls } = makeDeps(report);
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.ready, false);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /not-ready/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('--apply fails closed (no close) when the claim is lost / not owned', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    revalidateClaim: () => ({
      owned: false,
      reason: 'claim-id-mismatch',
      stale: false,
      activeClaim: {
        agentId: '',
        claimId: '',
        supersedes: '',
        branch: '',
        createdAt: '',
      },
    }),
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.equal(verdict.claimReleased, false);
  assert.match(verdict.result, /claim not owned/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
});

test('--apply fails closed when re-validation finds a new blocker before close', async () => {
  let collectCount = 0;
  const blockedReport = readyReport();
  blockedReport.nodes = blockedReport.nodes.map((entry) =>
    entry.number === 1048 ? { ...entry, state: 'OPEN' } : entry,
  );
  blockedReport.executionCandidates = [1048];
  const { deps, calls } = makeDeps(readyReport(), {
    collect: async () => {
      collectCount += 1;
      // First read is ready; the immediate-pre-close re-read finds drift.
      return collectCount >= 2 ? blockedReport : readyReport();
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.blockers[0]?.kind, 'open-child');
  assert.match(verdict.result, /new completion blockers/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
});

test('--apply without --claim-id fails closed (no mutation)', async () => {
  const { deps, calls } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP), '--apply'],
    deps,
  );

  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /--claim-id is required/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
});

test('missing --roadmap is rejected', async () => {
  const { deps } = makeDeps(readyReport());
  await assert.rejects(
    () => runRoadmapAuditExecute(['--claim-id', CLAIM_ID], deps),
    /missing required --roadmap/,
  );
});
