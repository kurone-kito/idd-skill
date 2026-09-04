import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  enumerateRoadmapGraph,
  type RoadmapGraphReport,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  buildRoadmapCompletionAuditBody,
  type ConnectedPrEvent,
  createLocalCoordinationInputs,
  evaluateLocalCoordinationState,
  evaluateRoadmapAuditGates,
  evaluateRoadmapClaim,
  explainRoadmapClaimReason,
  findWorktreeEntriesForBranch,
  findWorktreeEntryForBranch,
  hasTrustedCompletionEvidenceComment,
  type LocalCoordinationInputs,
  parseWorktreeListPorcelain,
  type RoadmapAuditExecuteDeps,
  reconcileConnectedOpenPrs,
  resolveOpenLinkedPrIssues,
  runRoadmapAuditExecute,
  safeHasTrustedCompletionEvidence,
} from '../src/scripts/idd-roadmap-audit-execute.mts';
import { renderClaimedByMarker } from '../src/scripts/protocol-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

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
    milestone: null,
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
    claimChecks: number;
    completionEvidenceChecks: number;
    comments: { issue: number; body: string }[];
    closed: number[];
    released: {
      issue: number;
      agentId: string;
      claimId: string;
      timestamp: string;
    }[];
  };
} {
  const calls = {
    collects: 0,
    claimChecks: 0,
    completionEvidenceChecks: 0,
    comments: [] as { issue: number; body: string }[],
    closed: [] as number[],
    released: [] as {
      issue: number;
      agentId: string;
      claimId: string;
      timestamp: string;
    }[],
  };
  const deps: RoadmapAuditExecuteDeps = {
    collect: async () => {
      calls.collects += 1;
      return report;
    },
    resolveOpenLinkedPrIssues: () => [],
    revalidateClaim: () => {
      calls.claimChecks += 1;
      return {
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
      };
    },
    hasTrustedCompletionEvidence: () => {
      calls.completionEvidenceChecks += 1;
      return false;
    },
    postEvidenceComment: (issue, body) => calls.comments.push({ issue, body }),
    closeRoadmap: (issue) => calls.closed.push(issue),
    releaseClaim: (issue, fields) =>
      calls.released.push({
        issue,
        agentId: fields.agentId,
        claimId: fields.claimId,
        timestamp: fields.timestamp,
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

test('a closed nested roadmap WITH a reachable closed leaf does not block', () => {
  const report = readyReport();
  report.nodes = [
    ...report.nodes,
    node({ number: 1100, classification: 'roadmap', state: 'CLOSED' }),
    node({ number: 1101, classification: 'execution', state: 'CLOSED' }),
  ];
  report.edges = [
    ...report.edges,
    {
      source: ROADMAP,
      target: 1100,
      relationship: 'task-list',
      evidence: '- [x] #1100',
    },
    {
      source: 1100,
      target: 1101,
      relationship: 'task-list',
      evidence: '- [x] #1101',
    },
  ];
  report.roadmapNodes = [1100];
  assert.deepEqual(evaluateRoadmapAuditGates(report), []);
});

test('a closed nested roadmap with NO reachable leaves is childless/malformed → blocked', () => {
  const report = readyReport();
  report.nodes = [
    ...report.nodes,
    node({ number: 1100, classification: 'roadmap', state: 'CLOSED' }),
  ];
  report.edges = [
    ...report.edges,
    {
      source: ROADMAP,
      target: 1100,
      relationship: 'task-list',
      evidence: '- [x] #1100',
    },
  ];
  report.roadmapNodes = [1100];
  const blockers = evaluateRoadmapAuditGates(report);
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['nested-roadmap'],
  );
  assert.match(blockers[0]?.detail ?? '', /no reachable execution-leaf/);
});

test('a closed child with an OPEN linked PR is unresolved; a merged PR is not', () => {
  const report = readyReport();
  // #1048 is a closed child; inject it as still having an open linked PR.
  const blocked = evaluateRoadmapAuditGates(report, {
    openLinkedPrIssues: [1048],
  });
  assert.deepEqual(
    blocked.map((blocker) => blocker.kind),
    ['open-linked-pr'],
  );
  assert.equal(blocked[0]?.target, 1048);

  // With no open linked PRs (the merged-PR case), nothing blocks.
  assert.deepEqual(
    evaluateRoadmapAuditGates(report, { openLinkedPrIssues: [] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// reconcileConnectedOpenPrs (pure) — CONNECTED/DISCONNECTED linked-PR signal
// ---------------------------------------------------------------------------

test('a CONNECTED OPEN PR with no later DISCONNECT reconciles as open-linked', () => {
  const events: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 2001, state: 'OPEN' },
  ];
  assert.deepEqual(reconcileConnectedOpenPrs(events), [2001]);
});

test('a CONNECTED then DISCONNECTED PR is not open-linked', () => {
  const events: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 2001, state: 'OPEN' },
    { type: 'disconnected', prNumber: 2001 },
  ];
  assert.deepEqual(reconcileConnectedOpenPrs(events), []);
});

test('a CONNECTED MERGED PR is not open-linked', () => {
  const events: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 2001, state: 'MERGED' },
  ];
  assert.deepEqual(reconcileConnectedOpenPrs(events), []);
});

test('a DISCONNECTED then re-CONNECTED OPEN PR is open-linked again (last event wins)', () => {
  const events: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 2001, state: 'OPEN' },
    { type: 'disconnected', prNumber: 2001 },
    { type: 'connected', prNumber: 2001, state: 'OPEN' },
  ];
  assert.deepEqual(reconcileConnectedOpenPrs(events), [2001]);
});

test('reconciliation keeps only the still-connected OPEN PRs across several', () => {
  const events: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 3001, state: 'OPEN' }, // stays open
    { type: 'connected', prNumber: 3002, state: 'OPEN' },
    { type: 'disconnected', prNumber: 3002 }, // disconnected
    { type: 'connected', prNumber: 3003, state: 'MERGED' }, // merged
  ];
  assert.deepEqual(reconcileConnectedOpenPrs(events), [3001]);
});

test('a closed child with an OPEN CONNECTED-only PR yields an open-linked-pr blocker', () => {
  // End-to-end wiring without mocking gh: the resolver maps a child to the
  // blocked set when reconcileConnectedOpenPrs over its timeline is non-empty.
  const connectedOpen: ConnectedPrEvent[] = [
    { type: 'connected', prNumber: 2001, state: 'OPEN' },
  ];
  const childBlocked = reconcileConnectedOpenPrs(connectedOpen).length > 0;
  assert.equal(childBlocked, true);

  const report = readyReport(); // #1048 is a closed child
  const blockers = evaluateRoadmapAuditGates(report, {
    openLinkedPrIssues: childBlocked ? [1048] : [],
  });
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['open-linked-pr'],
  );

  // A connected-then-disconnected PR leaves the child unblocked.
  const disconnected: ConnectedPrEvent[] = [
    ...connectedOpen,
    { type: 'disconnected', prNumber: 2001 },
  ];
  const stillBlocked = reconcileConnectedOpenPrs(disconnected).length > 0;
  assert.equal(stillBlocked, false);
  assert.deepEqual(
    evaluateRoadmapAuditGates(report, {
      openLinkedPrIssues: stillBlocked ? [1048] : [],
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// resolveOpenLinkedPrIssues (#2266: routed through ProviderPort). The
// absent-issue/absent-connection fail-closed distinction previously covered
// here moved to provider-adapter-github.test.mts's dedicated
// getWorkItemClosingPullRequestsPage/getConnectedPullRequestEventsPage
// tests, since that throw is now the adapter's own contract, not logic this
// file owns; a generic "any lookup failure blocks" test replaces them below.
// ---------------------------------------------------------------------------

test('resolveOpenLinkedPrIssues fails closed when a page lookup throws', () => {
  const port = createFakeProviderAdapter({});
  port.getWorkItemClosingPullRequestsPage = () => {
    throw new Error('lookup failed');
  };
  assert.deepEqual(resolveOpenLinkedPrIssues(port, [1048]), [1048]);
});

test('resolveOpenLinkedPrIssues does NOT block a present-but-empty connection', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      1048: [{ nodes: [], hasNextPage: false, endCursor: null }],
    },
    connectedPrEventPages: {
      1048: [{ events: [], hasNextPage: false, endCursor: null }],
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues(port, [1048]), []);
});

test('resolveOpenLinkedPrIssues blocks a present connection with an OPEN closing PR', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      1048: [
        { nodes: [{ state: 'OPEN' }], hasNextPage: false, endCursor: null },
      ],
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues(port, [1048]), [1048]);
});

test('resolveOpenLinkedPrIssues fails closed on a truncated closing-PR page (hasNextPage, no endCursor)', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      1048: [
        { nodes: [{ state: 'MERGED' }], hasNextPage: true, endCursor: null },
      ],
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues(port, [1048]), [1048]);
});

test('resolveOpenLinkedPrIssues fails closed on a truncated connected-PR timeline (hasNextPage, no endCursor)', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      1048: [{ nodes: [], hasNextPage: false, endCursor: null }],
    },
    connectedPrEventPages: {
      1048: [{ events: [], hasNextPage: true, endCursor: null }],
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues(port, [1048]), [1048]);
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
  // The cycle source is deliberately absent from `nodes`: an unknown-source
  // cycle must keep blocking (fail closed), unlike the execution-leaf
  // provenance back-edges exempted below (#1278).
  report.diagnostics.cycles = [
    {
      source: 4444,
      target: ROADMAP,
      relationship: 'dependency',
      path: [ROADMAP, 4444, ROADMAP],
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

// ---------------------------------------------------------------------------
// #1278 — Refs provenance breadcrumbs from non-roadmap leaves are not cycles
// ---------------------------------------------------------------------------

/** Raw roadmap issue as the enumeration's `loadIssue` returns it. */
function rawRoadmapIssue(number: number, body: string, state = 'open') {
  return {
    number,
    title: `roadmap ${number}`,
    state,
    body: `<!-- idd-skill-roadmap-id: roadmap-${number} -->\n${body}`,
    labels: [{ name: 'roadmap' }],
  };
}

/** Raw execution-leaf issue as the enumeration's `loadIssue` returns it. */
function rawExecutionIssue(number: number, body: string, state = 'open') {
  return { number, title: `issue ${number}`, state, body, labels: [] };
}

/**
 * Build the graph through the real traversal so the fixtures match exactly
 * what discover-roadmap-graph emits for the A1.5 follow-up breadcrumb shape:
 * the roadmap task-lists the leaf and the leaf's body carries the required
 * `Refs #<roadmap>` back-reference (or a stronger relationship on demand).
 */
function breadcrumbGraph(
  leafState: 'open' | 'closed',
  backReference = `Refs #${ROADMAP}`,
) {
  const issues = new Map<number, unknown>([
    [ROADMAP, rawRoadmapIssue(ROADMAP, '- [x] #1047')],
    [
      1047,
      rawExecutionIssue(1047, `Follow-up work.\n\n${backReference}`, leafState),
    ],
  ]);
  return enumerateRoadmapGraph(ROADMAP, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });
}

test('a Refs breadcrumb from a CLOSED leaf does not block: dry-run is ready (#1278)', async () => {
  const graph = await breadcrumbGraph('closed');
  const { deps, calls } = makeDeps(graph);
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls.closed, []);
});

test('an OPEN leaf with a Refs breadcrumb blocks as open-child, not as a cycle (#1278)', async () => {
  const graph = await breadcrumbGraph('open');
  const blockers = evaluateRoadmapAuditGates(graph);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['open-child'],
  );
  assert.equal(blockers[0]?.target, 1047);
});

test('mutually-referencing roadmap nodes still surface a blocking cycle (#1278)', async () => {
  const issues = new Map<number, unknown>([
    [ROADMAP, rawRoadmapIssue(ROADMAP, '- [x] #1100')],
    [1100, rawRoadmapIssue(1100, `- [x] #1101\n\nRefs #${ROADMAP}`, 'closed')],
    [1101, rawExecutionIssue(1101, 'done', 'closed')],
  ]);
  const graph = await enumerateRoadmapGraph(ROADMAP, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });
  const blockers = evaluateRoadmapAuditGates(graph);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
  assert.equal(blockers[0]?.target, ROADMAP);
});

test('a stronger back-edge (Blocked by) from a CLOSED leaf still blocks as a cycle (#1278)', async () => {
  // A closed leaf that declares itself `Blocked by` its still-open ancestor
  // is a genuine closure-order anomaly, not a provenance breadcrumb — only
  // the `reference` relationship is exempt.
  const graph = await breadcrumbGraph('closed', `Blocked by #${ROADMAP}`);
  const blockers = evaluateRoadmapAuditGates(graph);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
  assert.match(blockers[0]?.detail ?? '', /dependency/);
});

test('an execution-source cycle in a non-OPEN/CLOSED state still blocks (#1278)', () => {
  // Fail-closed parity with the traversal: the builder records a cycle for
  // an execution source whose state is neither OPEN nor CLOSED, and such a
  // node is absent from executionCandidates, so no open-child blocker
  // compensates — the evaluator must keep the cycle blocking.
  const report = readyReport();
  report.nodes = report.nodes.map((entry) =>
    entry.number === 1047 ? { ...entry, state: '' } : entry,
  );
  report.diagnostics.cycles = [
    {
      source: 1047,
      target: ROADMAP,
      relationship: 'reference',
      path: [ROADMAP, 1047, ROADMAP],
    },
  ];
  const blockers = evaluateRoadmapAuditGates(report);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
});

test('an unknown-source reference cycle still blocks (fail closed) (#1278)', () => {
  // The exemption requires a source node present in `nodes` with execution
  // classification; a `reference` cycle whose source is absent from the
  // graph must keep blocking even though the relationship alone matches.
  const report = readyReport();
  report.diagnostics.cycles = [
    {
      source: 4444,
      target: ROADMAP,
      relationship: 'reference',
      path: [ROADMAP, 4444, ROADMAP],
    },
  ];
  const blockers = evaluateRoadmapAuditGates(report);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
});

// ---------------------------------------------------------------------------
// #1919 — root-preserving exemption for cycles among fully-closed descendants
// ---------------------------------------------------------------------------

test('a cycle whose segment excludes the audited roadmap and is entirely CLOSED is not a blocker: dry-run is ready (#1919)', async () => {
  // Mirrors the reported #1904 shape: a `dependency` back-edge (not
  // `reference`, so #1278's own exemption never applies) between two CLOSED
  // descendants that never routes back through the audited roadmap.
  const issues = new Map<number, unknown>([
    [ROADMAP, rawRoadmapIssue(ROADMAP, '- [x] #1300')],
    [
      1300,
      rawExecutionIssue(1300, 'Follow-up work.\n\nBlocked by #1301', 'closed'),
    ],
    [
      1301,
      rawExecutionIssue(1301, 'Follow-up work.\n\nBlocked by #1300', 'closed'),
    ],
  ]);
  const graph = await enumerateRoadmapGraph(ROADMAP, {
    loadIssue: async (issueNumber) => issues.get(issueNumber) ?? null,
  });
  assert.deepEqual(
    graph.diagnostics.cycles.map((cycle) => cycle.relationship),
    ['dependency'],
  );
  const { deps, calls } = makeDeps(graph);
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls.closed, []);
});

test('a cycle blocks when its segment contains the audited roadmap, regardless of relationship type (#1919)', () => {
  const report = readyReport();
  report.nodes.push(
    node({ number: 1560, state: 'CLOSED' }),
    node({ number: 1561, state: 'CLOSED' }),
  );
  // `task-list` (not `reference`), and the roadmap sits mid-segment rather
  // than at an endpoint -- the segment-inclusion check must scan the whole
  // segment, not just its first/last element.
  report.diagnostics.cycles = [
    {
      source: 1561,
      target: 1560,
      relationship: 'task-list',
      path: [1560, ROADMAP, 1561, 1560],
    },
  ];
  const blockers = evaluateRoadmapAuditGates(report);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
});

test('a cycle blocks when any segment node is OPEN, even though it excludes the audited roadmap (#1919)', () => {
  const report = readyReport();
  report.nodes.push(
    node({ number: 1563, state: 'OPEN' }),
    node({ number: 1564, state: 'CLOSED' }),
  );
  report.diagnostics.cycles = [
    {
      source: 1563,
      target: 1564,
      relationship: 'dependency',
      path: [ROADMAP, 1564, 1563, 1564],
    },
  ];
  const blockers = evaluateRoadmapAuditGates(report);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
});

test('a cycle blocks when a segment node is absent from the report, even though it excludes the audited roadmap (#1919)', () => {
  const report = readyReport();
  report.nodes.push(
    node({ number: 1563, state: 'CLOSED' }),
    node({ number: 1564, state: 'CLOSED' }),
  );
  // 9999 is deliberately absent from `report.nodes`: a mid-segment node that
  // is neither the cycle's source nor its target still fails the all-CLOSED
  // check (fail closed on an unresolvable state).
  report.diagnostics.cycles = [
    {
      source: 1563,
      target: 1564,
      relationship: 'dependency',
      path: [ROADMAP, 1564, 9999, 1563, 1564],
    },
  ];
  const blockers = evaluateRoadmapAuditGates(report);

  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['cycle'],
  );
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

test('resolves configured blocked-label names on the roadmap root (#1273)', () => {
  const customLabeled = readyReport();
  customLabeled.nodes = customLabeled.nodes.map((entry) =>
    entry.number === ROADMAP
      ? { ...entry, labels: ['roadmap', 'triage:human-gate'] }
      : entry,
  );
  const blockers = evaluateRoadmapAuditGates(customLabeled, {
    blockedByHumanLabelName: 'triage:human-gate',
  });
  assert.deepEqual(
    blockers.map((blocker) => blocker.kind),
    ['roadmap-blocked'],
  );

  // The stock default no longer matches once overridden.
  const stockLabeled = readyReport();
  stockLabeled.nodes = stockLabeled.nodes.map((entry) =>
    entry.number === ROADMAP
      ? { ...entry, labels: ['roadmap', 'status:blocked-by-human'] }
      : entry,
  );
  assert.deepEqual(
    evaluateRoadmapAuditGates(stockLabeled, {
      blockedByHumanLabelName: 'triage:human-gate',
    }),
    [],
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
    /Open \/ unresolved \/ inaccessible \/ nested-roadmap \/ open-linked-PR descendants: none\./,
  );
  assert.match(body, /Closing the roadmap as completed\./);
});

// ---------------------------------------------------------------------------
// evaluateRoadmapClaim (pure)
// ---------------------------------------------------------------------------

test('a present, matching, fresh, roadmap-audit-branch claim is owned', () => {
  const verdict = evaluateRoadmapClaim([claimComment()], {
    roadmapNumber: ROADMAP,
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
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(missing.owned, false);
  assert.equal(missing.reason, 'missing-active-claim');

  const mismatch = evaluateRoadmapClaim([claimComment({ claimId: 'other' })], {
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(mismatch.owned, false);
  assert.equal(mismatch.reason, 'claim-id-mismatch');
});

test('a non-roadmap-audit branch on the roadmap issue does NOT authorize closure', () => {
  // A normal execution claim (issue/<n>-...) on the roadmap issue must not pass.
  const executionClaim = {
    body: renderClaimedByMarker({
      agentId: AGENT_ID,
      claimId: CLAIM_ID,
      supersedes: 'none',
      timestamp: '2026-06-26T00:00:00Z',
      branch: `issue/${ROADMAP}-some-execution-task`,
    }),
    createdAt: '2026-06-26T00:00:00Z',
    author: { login: 'kurone-kito' },
  };
  const verdict = evaluateRoadmapClaim([executionClaim], {
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, 'claim-branch-mismatch');

  // ...and a roadmap-audit/<n>-... branch IS accepted.
  const accepted = evaluateRoadmapClaim([claimComment()], {
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(accepted.owned, true);
});

test('staleness honors the configured claim stale age', () => {
  const comment = [claimComment()]; // claim createdAt 2026-06-26T00:00:00Z
  const oneHourLater = '2026-06-26T01:00:00Z';

  // A 30-minute stale age makes the 1h-old claim stale → not owned.
  const shortened = evaluateRoadmapClaim(comment, {
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: oneHourLater,
    staleAgeMs: 30 * 60 * 1000,
  });
  assert.equal(shortened.owned, false);
  assert.equal(shortened.reason, 'claim-stale');

  // A 48-hour stale age keeps the same 1h-old claim fresh → owned.
  const lengthened = evaluateRoadmapClaim(comment, {
    roadmapNumber: ROADMAP,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: oneHourLater,
    staleAgeMs: 48 * 60 * 60 * 1000,
  });
  assert.equal(lengthened.owned, true);
});

test('a stale (takeover-eligible) claim is not owned at the default age', () => {
  const verdict = evaluateRoadmapClaim([claimComment()], {
    roadmapNumber: ROADMAP,
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
    roadmapNumber: ROADMAP,
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

test('a not-owned result explains the reason code inline (#1396)', async () => {
  const { deps } = makeDeps(readyReport(), {
    revalidateClaim: () => ({
      owned: false,
      reason: 'claim-branch-mismatch',
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
  const { verdict } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.match(verdict.result, /reason="claim-branch-mismatch"/);
  assert.equal(
    verdict.result.includes(explainRoadmapClaimReason('claim-branch-mismatch')),
    true,
  );
  // Explanation names the coordination-branch policy, not a fetch failure.
  assert.match(verdict.result, /roadmap-audit\/<n>-\*/);
});

// ---------------------------------------------------------------------------
// viewerLoginUnavailable — fail-noisy viewer-login lookup surfacing (#1396)
// ---------------------------------------------------------------------------

test('verdict.viewerLoginUnavailable is absent on the healthy default path', async () => {
  const { deps } = makeDeps(readyReport());
  const { verdict } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(Object.hasOwn(verdict, 'viewerLoginUnavailable'), false);
});

test('a failed viewer-login lookup surfaces viewerLoginUnavailable and a caveat on a not-owned result', async () => {
  const { deps } = makeDeps(readyReport(), {
    viewerLoginUnavailable: true,
    revalidateClaim: () => ({
      owned: false,
      reason: 'missing-active-claim',
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

  assert.equal(verdict.viewerLoginUnavailable, true);
  assert.equal(exitCode, 1);
  assert.match(verdict.result, /viewer-login lookup failed/);
  assert.match(
    verdict.result,
    /could stem from that instead of a genuine claim conflict/,
  );
});

test('viewerLoginUnavailable: true does not appear when the lookup succeeded', async () => {
  const { deps } = makeDeps(readyReport(), { viewerLoginUnavailable: false });
  const { verdict } = await runRoadmapAuditExecute(
    ['--roadmap', String(ROADMAP)],
    deps,
  );

  assert.equal(Object.hasOwn(verdict, 'viewerLoginUnavailable'), false);
});

// ---------------------------------------------------------------------------
// explainRoadmapClaimReason (#1396)
// ---------------------------------------------------------------------------

// This list is hand-maintained against evaluateRoadmapClaim / (the
// summarizeClaimValidation it wraps) as of #1396 — it does NOT introspect
// the reason-emitting source, so it cannot by itself catch a future reason
// code added there without a matching CLAIM_REASON_EXPLANATIONS entry (C1
// review, #1396). explainRoadmapClaimReason() degrades gracefully in that
// case (UNKNOWN_CLAIM_REASON_EXPLANATION, exercised by the test below), so
// the gap is cosmetic, not a crash risk; the vocabulary itself stays
// pinned by the exact-equality reason assertions elsewhere in this file.
test('explainRoadmapClaimReason maps each of the six currently-known reason codes to a distinct explanation (#1396)', () => {
  const knownReasons = [
    'match',
    'missing-active-claim',
    'claim-id-mismatch',
    'agent-id-mismatch',
    'claim-branch-mismatch',
    'claim-stale',
  ];
  const explanations = knownReasons.map((reason) =>
    explainRoadmapClaimReason(reason),
  );
  // Every known code gets a distinct, non-empty explanation.
  assert.equal(
    explanations.every((text) => text.length > 0),
    true,
  );
  assert.equal(new Set(explanations).size, knownReasons.length);
});

test('explainRoadmapClaimReason falls back to a generic explanation for an unrecognized code', () => {
  const explanation = explainRoadmapClaimReason('some-future-reason-code');
  assert.match(explanation, /unrecognized/);
});

// ---------------------------------------------------------------------------
// #1299 — already-complete recognition on the early claim-loss path
// ---------------------------------------------------------------------------

function lostClaimDeps(
  report: RoadmapGraphReport,
  hasTrustedCompletionEvidence: () => boolean,
) {
  return makeDeps(report, {
    revalidateClaim: () => ({
      owned: false,
      reason: 'missing-active-claim',
      stale: false,
      activeClaim: {
        agentId: '',
        claimId: '',
        supersedes: '',
        branch: '',
        createdAt: '',
      },
    }),
    hasTrustedCompletionEvidence,
  });
}

test('(a) --apply reports already-complete: closed roadmap + trusted evidence + no owned claim', async () => {
  const closedReport = readyReport();
  closedReport.root = { ...closedReport.root, state: 'CLOSED' };
  const { deps, calls } = lostClaimDeps(closedReport, () => true);
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, true);
  assert.match(verdict.result, /already-complete/);
  assert.equal(exitCode, 0);
  // Idempotent no-op: none of the mutating deps ran.
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('(b) --apply keeps claim-not-owned when the roadmap is still open, even with trusted evidence', async () => {
  // Track calls locally: overriding `hasTrustedCompletionEvidence` (like any
  // makeDeps override) replaces its counting default, so `calls
  // .completionEvidenceChecks` would stay 0 regardless of whether this test's
  // own override actually ran. A local counter inside the override itself
  // (the same pattern the claim-re-validation-order test below uses for
  // `claimChecks`) is the only way this assertion is not vacuous (#1299).
  let completionEvidenceChecks = 0;
  const openReport = readyReport(); // root.state defaults to 'OPEN'
  const { deps, calls } = lostClaimDeps(openReport, () => {
    completionEvidenceChecks += 1;
    return true;
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /claim not owned on re-validation/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  // The OPEN-state short-circuit means the evidence check is never consulted.
  assert.equal(completionEvidenceChecks, 0);
});

test('(c) --apply keeps claim-not-owned when the roadmap is closed but lacks trusted evidence', async () => {
  const closedReport = readyReport();
  closedReport.root = { ...closedReport.root, state: 'CLOSED' };
  const { deps, calls } = lostClaimDeps(closedReport, () => false);
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /claim not owned on re-validation/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
});

// ---------------------------------------------------------------------------
// hasTrustedCompletionEvidenceComment (pure)
// ---------------------------------------------------------------------------

test('a trusted canonical evidence comment is detected', () => {
  const comments = [
    {
      body: '**IDD roadmap completion audit**\n\nRoadmap #995 audited as complete.',
      createdAt: '2026-06-26T00:00:00Z',
      author: { login: 'kurone-kito' },
    },
  ];
  assert.equal(
    hasTrustedCompletionEvidenceComment(comments, () => true),
    true,
  );
});

test('an untrusted author is not recognized even with the canonical body', () => {
  const comments = [
    {
      body: '**IDD roadmap completion audit**\n\nRoadmap #995 audited as complete.',
      createdAt: '2026-06-26T00:00:00Z',
      author: { login: 'random-actor' },
    },
  ];
  assert.equal(
    hasTrustedCompletionEvidenceComment(comments, () => false),
    false,
  );
});

test('a trusted comment without the canonical heading is not recognized', () => {
  const comments = [
    {
      body: 'Looks good to me!',
      createdAt: '2026-06-26T00:00:00Z',
      author: { login: 'kurone-kito' },
    },
  ];
  assert.equal(
    hasTrustedCompletionEvidenceComment(comments, () => true),
    false,
  );
});

test('an empty comment stream is not recognized', () => {
  assert.equal(
    hasTrustedCompletionEvidenceComment([], () => true),
    false,
  );
});

// ---------------------------------------------------------------------------
// safeHasTrustedCompletionEvidence (pure) — #1299 fail-closed-on-error wrapper
// ---------------------------------------------------------------------------

test('a non-throwing check returns its own boolean result unchanged', () => {
  assert.equal(
    safeHasTrustedCompletionEvidence(() => true),
    true,
  );
  assert.equal(
    safeHasTrustedCompletionEvidence(() => false),
    false,
  );
});

test('a throwing check (e.g. a live gh/network failure) is treated as no evidence', () => {
  assert.equal(
    safeHasTrustedCompletionEvidence(() => {
      throw new Error('gh: command failed (transient network error)');
    }),
    false,
  );
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

test('--apply releases the claim with a second-precision timestamp even when now() has ms', async () => {
  // Regression: renderUnclaimedByMarker rejects millisecond ISO, which would
  // throw AFTER the comment + close already landed (a partial mutation).
  const { deps, calls } = makeDeps(readyReport(), {
    now: () => '2026-06-26T01:00:00.123Z',
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(exitCode, 0);
  assert.equal(verdict.claimReleased, true);
  assert.equal(calls.released.length, 1);
  assert.equal(calls.released[0]?.timestamp, '2026-06-26T01:00:00Z');
});

test('--apply rejects a --claim-issue that differs from the roadmap (no mutation)', async () => {
  const { deps, calls } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    [
      '--roadmap',
      String(ROADMAP),
      '--claim-issue',
      '994',
      '--claim-id',
      CLAIM_ID,
      '--apply',
    ],
    deps,
  );

  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /must equal the roadmap/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('--apply accepts a --claim-issue that equals the roadmap', async () => {
  const { deps, calls } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(
    [
      '--roadmap',
      String(ROADMAP),
      '--claim-issue',
      String(ROADMAP),
      '--claim-id',
      CLAIM_ID,
      '--apply',
    ],
    deps,
  );

  assert.equal(verdict.closed, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls.closed, [ROADMAP]);
});

test('--apply re-validates the claim AFTER the graph re-fetch (last gate before mutation)', async () => {
  // Owned on the early check, lost on the pre-mutation check → no mutation.
  let claimChecks = 0;
  const { deps, calls } = makeDeps(readyReport(), {
    revalidateClaim: () => {
      claimChecks += 1;
      if (claimChecks >= 2) {
        return {
          owned: false,
          reason: 'claim-stale',
          stale: true,
          activeClaim: {
            agentId: AGENT_ID,
            claimId: CLAIM_ID,
            supersedes: 'none',
            branch: CLAIM_BRANCH,
            createdAt: '2026-06-26T00:00:00Z',
          },
        };
      }
      return {
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
      };
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.equal(verdict.claimReleased, false);
  assert.match(verdict.result, /immediately before mutation/);
  assert.equal(exitCode, 1);
  // Two claim checks ran: the early one AND the post-re-fetch gate.
  assert.equal(claimChecks, 2);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
});

test('--apply fails closed on an unparseable now (no mutation, no claim check)', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    now: () => 'not-a-real-date',
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /invalid "now"/);
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.released, []);
  // Validation precedes any claim check (and thus any mutation).
  assert.equal(calls.claimChecks, 0);
});

test('--apply normalizes an offset-form now to second-precision UTC for the release marker', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    now: () => '2026-06-26T01:00:00+09:00',
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(exitCode, 0);
  assert.equal(verdict.closed, true);
  // 2026-06-26T01:00:00+09:00 == 2026-06-25T16:00:00Z, truncated to seconds.
  assert.equal(calls.released[0]?.timestamp, '2026-06-25T16:00:00Z');
});

test('--apply aborts the CLOSE when the claim is lost in the comment→close gap', async () => {
  // Owned through the early + pre-comment checks, lost on the pre-close check.
  let checks = 0;
  const ownedVerdict = () => ({
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
  });
  const { deps, calls } = makeDeps(readyReport(), {
    revalidateClaim: () => {
      checks += 1;
      if (checks >= 3) {
        return {
          owned: false,
          reason: 'claim-stale',
          stale: true,
          activeClaim: ownedVerdict().activeClaim,
        };
      }
      return ownedVerdict();
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);

  assert.equal(verdict.closed, false);
  assert.equal(verdict.claimReleased, false);
  assert.match(verdict.result, /comment→close gap/);
  assert.equal(exitCode, 1);
  // The evidence comment WAS posted (harmless), but the close/release were not.
  assert.equal(calls.comments.length, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.released, []);
  // early + pre-comment + pre-close re-validations all ran.
  assert.equal(checks, 3);
});

test('missing --roadmap is rejected', async () => {
  const { deps } = makeDeps(readyReport());
  await assert.rejects(
    () => runRoadmapAuditExecute(['--claim-id', CLAIM_ID], deps),
    /missing required --roadmap/,
  );
});

/**
 * Convert a "friendly" newline-delimited fixture (a field per line, a
 * blank line between stanzas — the pre-#2225-P2-fix text porcelain shape)
 * into the real `git worktree list --porcelain -z` wire format the parser
 * now requires: each field NUL-terminated, each record terminated by an
 * extra NUL. Keeps the many existing fixtures readable while still
 * exercising the actual NUL-delimited parsing path.
 */
function toZ(text: string): string {
  return text
    .trim()
    .split(/\n\n+/)
    .map(
      (stanza) =>
        `${stanza
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .join('\0')}\0\0`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// parseWorktreeListPorcelain (pure, #2225)
// ---------------------------------------------------------------------------

test('parseWorktreeListPorcelain parses a normal branch stanza', () => {
  const entries = parseWorktreeListPorcelain(
    toZ('worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n'),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.path, '/repo/main');
  assert.equal(entries[0]?.headSha, 'abc123');
  assert.equal(entries[0]?.branchRef, 'refs/heads/main');
  assert.equal(entries[0]?.detached, false);
});

test('parseWorktreeListPorcelain flags a detached stanza with no branch', () => {
  const entries = parseWorktreeListPorcelain(
    toZ('worktree /repo/detached\nHEAD abc123\ndetached\n'),
  );
  assert.equal(entries[0]?.detached, true);
  assert.equal(entries[0]?.branchRef, null);
});

test('parseWorktreeListPorcelain captures a locked reason', () => {
  const entries = parseWorktreeListPorcelain(
    toZ(
      'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/feature\nlocked manual lock test\n',
    ),
  );
  assert.equal(entries[0]?.locked, true);
  assert.equal(entries[0]?.lockReason, 'manual lock test');
});

test('parseWorktreeListPorcelain treats a bare "locked" line as lock-with-no-reason', () => {
  const entries = parseWorktreeListPorcelain(
    toZ('worktree /repo/wt\nHEAD abc123\nbranch refs/heads/feature\nlocked\n'),
  );
  assert.equal(entries[0]?.locked, true);
  assert.equal(entries[0]?.lockReason, null);
});

test('parseWorktreeListPorcelain captures a prunable reason', () => {
  const entries = parseWorktreeListPorcelain(
    toZ(
      'worktree /repo/gone\nHEAD abc123\nbranch refs/heads/gone-branch\nprunable gitdir file points to non-existent location\n',
    ),
  );
  assert.equal(entries[0]?.prunable, true);
  assert.equal(
    entries[0]?.prunableReason,
    'gitdir file points to non-existent location',
  );
});

test('parseWorktreeListPorcelain parses multiple record-separated stanzas', () => {
  const output = toZ(
    [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature',
      'HEAD def456',
      'branch refs/heads/feature',
      '',
    ].join('\n'),
  );
  const entries = parseWorktreeListPorcelain(output);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['/repo/main', '/repo/feature'],
  );
});

test('parseWorktreeListPorcelain is immune to a path containing a literal blank line (review finding, #2225: the prior newline-delimited format was not)', () => {
  // A path with an embedded "\n\n" used to be indistinguishable from a
  // record separator under the old newline-delimited format, silently
  // hiding this worktree/branch from every downstream check.
  const trickyPath = '/repo/oh\n\nno';
  const output = `worktree ${trickyPath}\0HEAD abc123\0branch refs/heads/main\0\0`;
  const entries = parseWorktreeListPorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.path, trickyPath);
  assert.equal(entries[0]?.branchRef, 'refs/heads/main');
});

test('parseWorktreeListPorcelain returns an empty array for malformed/empty input', () => {
  assert.deepEqual(parseWorktreeListPorcelain(''), []);
  assert.deepEqual(parseWorktreeListPorcelain('not a worktree listing\n'), []);
});

// ---------------------------------------------------------------------------
// findWorktreeEntryForBranch (pure, #2225, AC1)
// ---------------------------------------------------------------------------

test('findWorktreeEntryForBranch matches by content-exact branch name', () => {
  const entries = parseWorktreeListPorcelain(
    toZ(
      'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
    ),
  );
  const match = findWorktreeEntryForBranch(entries, 'roadmap-audit/995-slug');
  assert.equal(match?.path, '/repo/wt');
});

test('findWorktreeEntryForBranch returns null when no entry matches', () => {
  const entries = parseWorktreeListPorcelain(
    toZ('worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n'),
  );
  assert.equal(
    findWorktreeEntryForBranch(entries, 'roadmap-audit/995-slug'),
    null,
  );
});

test('findWorktreeEntryForBranch never matches a detached entry', () => {
  const entries = parseWorktreeListPorcelain(
    toZ('worktree /repo/detached\nHEAD abc123\ndetached\n'),
  );
  assert.equal(
    findWorktreeEntryForBranch(entries, 'roadmap-audit/995-slug'),
    null,
  );
});

test('findWorktreeEntriesForBranch returns EVERY match, not just the first (git checkout --ignore-other-worktrees can duplicate a checkout)', () => {
  const entries = parseWorktreeListPorcelain(
    toZ(
      [
        'worktree /repo/first',
        'HEAD abc123',
        'branch refs/heads/roadmap-audit/995-slug',
        '',
        'worktree /repo/second',
        'HEAD abc123',
        'branch refs/heads/roadmap-audit/995-slug',
        '',
      ].join('\n'),
    ),
  );
  const matches = findWorktreeEntriesForBranch(
    entries,
    'roadmap-audit/995-slug',
  );
  assert.deepEqual(
    matches.map((entry) => entry.path),
    ['/repo/first', '/repo/second'],
  );
  // findWorktreeEntryForBranch stays the first-match convenience wrapper.
  assert.equal(
    findWorktreeEntryForBranch(entries, 'roadmap-audit/995-slug')?.path,
    '/repo/first',
  );
});

// ---------------------------------------------------------------------------
// evaluateLocalCoordinationState (pure, injected inputs, #2225)
// ---------------------------------------------------------------------------

const OK = (stdout = ''): { ok: true; stdout: string; stderr: string } => ({
  ok: true,
  stdout,
  stderr: '',
});
const FAIL = (
  stderr = 'boom',
): { ok: false; stdout: string; stderr: string } => ({
  ok: false,
  stdout: '',
  stderr,
});

function localInputs(
  overrides: Partial<LocalCoordinationInputs> & {
    calls?: { status: number; gitPath: number };
  } = {},
): LocalCoordinationInputs {
  const { calls, ...rest } = overrides;
  return {
    listWorktrees: () => OK(''),
    statusPorcelain: () => {
      if (calls) calls.status += 1;
      return OK('');
    },
    resolveGitPath: () => {
      if (calls) calls.gitPath += 1;
      return FAIL('no such path');
    },
    pathExists: () => false,
    readFile: () => null,
    ...rest,
  };
}

test('evaluateLocalCoordinationState reports absent when no worktree matches (the expected common case)', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(toZ('worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n')),
    }),
  );
  assert.equal(verdict.presence, 'absent');
  assert.equal(verdict.path, null);
  assert.equal(verdict.unreadable, false);
});

test('evaluateLocalCoordinationState fails open (absent + unreadable) when the listing itself cannot be read', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({ listWorktrees: () => FAIL('git: command not found') }),
  );
  assert.equal(verdict.presence, 'absent');
  assert.equal(verdict.unreadable, true);
  assert.match(verdict.unreadableReason ?? '', /command not found/);
});

test('evaluateLocalCoordinationState reports present-clean for a matched, clean, non-rebasing worktree', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(''),
      resolveGitPath: () => FAIL('no such path'),
    }),
  );
  assert.equal(verdict.presence, 'present-clean');
  assert.equal(verdict.path, '/repo/wt');
  assert.deepEqual(verdict.brokenReasons, []);
});

test('evaluateLocalCoordinationState reports present-broken with uncommitted content on a dirty status', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(' M file.txt\n'),
      resolveGitPath: () => FAIL('no such path'),
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['uncommitted content present']);
});

test('evaluateLocalCoordinationState reports present-broken with rebase in progress when the resolved git-path exists', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(''),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge'
          ? OK('/repo/.git/worktrees/wt/rebase-merge\n')
          : FAIL('no such path'),
      pathExists: (path) => path === '/repo/.git/worktrees/wt/rebase-merge',
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['rebase in progress']);
});

test('evaluateLocalCoordinationState resolves a RELATIVE --git-path output against the worktree path', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(''),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge' ? OK('.git/rebase-merge\n') : FAIL('none'),
      pathExists: (path) => path === '/repo/wt/.git/rebase-merge',
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['rebase in progress']);
});

test('evaluateLocalCoordinationState resolves a RELATIVE --git-path output against a Windows drive-absolute worktree path without corrupting the drive letter or separators (#2576)', () => {
  // A real worktree path always carries a drive letter on native Windows
  // (unlike the plain `/repo/wt` fixture above). `resolveGitPath`'s output
  // here is still RELATIVE (`isGitPathAbsolute` is false for it, same as the
  // `/repo/wt` case above), so this exercises `joinGitPath`'s
  // string-concatenation branch with a drive-absolute BASE: it demonstrates
  // that base is preserved verbatim (no re-guessing a drive letter the way
  // `path.resolve('C:/repo/wt', '.git/rebase-merge')` would need to if the
  // base lacked one, and no reformatting to backslash). It does NOT exercise
  // `isGitPathAbsolute` returning true for a drive-letter path -- see the
  // next test for that.
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree C:/repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(''),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge' ? OK('.git/rebase-merge\n') : FAIL('none'),
      pathExists: (path) => path === 'C:/repo/wt/.git/rebase-merge',
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['rebase in progress']);
});

test('evaluateLocalCoordinationState treats an ABSOLUTE Windows drive-letter --git-path output as already-absolute, without double-joining it onto the worktree path (#2576)', () => {
  // Real `git rev-parse --git-path` output on native Windows is itself
  // drive-absolute (confirmed empirically against a real linked worktree:
  // e.g. `C:/Users/.../primary/.git/worktrees/wt/rebase-merge`) -- this is
  // the common real-world case, not the relative one above. This exercises
  // `isGitPathAbsolute`'s `[A-Za-z]:[\\/]` regex branch directly: if it ever
  // failed to recognize a drive-letter path as absolute, `joinGitPath` would
  // wrongly concatenate the worktree path onto it (producing something like
  // `C:/repo/wt/C:/repo/.git/worktrees/wt/rebase-merge`), which `pathExists`
  // would never find -- silently reporting no rebase in progress.
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree C:/repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => OK(''),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge'
          ? OK('C:/repo/.git/worktrees/wt/rebase-merge\n')
          : FAIL('none'),
      pathExists: (path) => path === 'C:/repo/.git/worktrees/wt/rebase-merge',
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['rebase in progress']);
});

test('evaluateLocalCoordinationState reports locked directly from porcelain without probing status or rebase', () => {
  const calls = { status: 0, gitPath: 0 };
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\nlocked manual lock test\n',
          ),
        ),
      calls,
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, ['locked: manual lock test']);
  assert.equal(calls.status, 0);
  assert.equal(calls.gitPath, 0);
});

test('evaluateLocalCoordinationState reports prunable directly from porcelain without probing status or rebase', () => {
  const calls = { status: 0, gitPath: 0 };
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/gone\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\nprunable gitdir file points to non-existent location\n',
          ),
        ),
      calls,
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.deepEqual(verdict.brokenReasons, [
    'prunable: gitdir file points to non-existent location',
  ]);
  assert.equal(calls.status, 0);
  assert.equal(calls.gitPath, 0);
});

test('evaluateLocalCoordinationState treats a matched worktree with an unreadable status as broken, not unreadable', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            'worktree /repo/wt\nHEAD abc123\nbranch refs/heads/roadmap-audit/995-slug\n',
          ),
        ),
      statusPorcelain: () => FAIL('no such directory'),
      resolveGitPath: () => FAIL('no such path'),
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.equal(verdict.unreadable, false);
  assert.deepEqual(verdict.brokenReasons, [
    'working tree status could not be read',
  ]);
});

test('evaluateLocalCoordinationState surfaces repo-wide detached worktrees as informational, non-blocking', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            [
              'worktree /repo/main',
              'HEAD abc123',
              'branch refs/heads/main',
              '',
              'worktree /repo/detached',
              'HEAD def456',
              'detached',
              '',
            ].join('\n'),
          ),
        ),
    }),
  );
  assert.equal(verdict.presence, 'absent');
  assert.deepEqual(verdict.detachedWorktreePaths, ['/repo/detached']);
});

test('evaluateLocalCoordinationState matches a DETACHED mid-rebase worktree via its head-name (git rebase detaches HEAD; branch-ref matching alone would miss it)', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(toZ('worktree /repo/wt\nHEAD abc123\ndetached\n')),
      statusPorcelain: () => OK(''),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge'
          ? OK('/repo/.git/worktrees/wt/rebase-merge\n')
          : FAIL('none'),
      pathExists: (path) => path === '/repo/.git/worktrees/wt/rebase-merge',
      readFile: (path) =>
        path === '/repo/.git/worktrees/wt/rebase-merge/head-name'
          ? 'refs/heads/roadmap-audit/995-slug\n'
          : null,
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  assert.equal(verdict.path, '/repo/wt');
  assert.ok(verdict.brokenReasons.includes('rebase in progress'));
  // Reported once, as the matched worktree — not also as an unrelated detached one.
  assert.deepEqual(verdict.detachedWorktreePaths, []);
});

test('evaluateLocalCoordinationState leaves an UNRELATED detached/rebasing worktree in detachedWorktreePaths (head-name does not match)', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(toZ('worktree /repo/other-wt\nHEAD abc123\ndetached\n')),
      resolveGitPath: (_worktreePath, name) =>
        name === 'rebase-merge'
          ? OK('/repo/.git/worktrees/other-wt/rebase-merge\n')
          : FAIL('none'),
      pathExists: (path) =>
        path === '/repo/.git/worktrees/other-wt/rebase-merge',
      readFile: (path) =>
        path === '/repo/.git/worktrees/other-wt/rebase-merge/head-name'
          ? 'refs/heads/some-unrelated-branch\n'
          : null,
    }),
  );
  assert.equal(verdict.presence, 'absent');
  assert.deepEqual(verdict.detachedWorktreePaths, ['/repo/other-wt']);
});

test('evaluateLocalCoordinationState evaluates EVERY matched worktree, not just the first: a clean first match does not hide a broken second one', () => {
  const calls = { status: 0, gitPath: 0 };
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    localInputs({
      listWorktrees: () =>
        OK(
          toZ(
            [
              'worktree /repo/first',
              'HEAD abc123',
              'branch refs/heads/roadmap-audit/995-slug',
              '',
              'worktree /repo/second',
              'HEAD abc123',
              'branch refs/heads/roadmap-audit/995-slug',
              '',
            ].join('\n'),
          ),
        ),
      statusPorcelain: (worktreePath) => {
        calls.status += 1;
        return worktreePath === '/repo/second' ? OK(' M file.txt\n') : OK('');
      },
      resolveGitPath: () => {
        calls.gitPath += 1;
        return FAIL('no such path');
      },
    }),
  );
  assert.equal(verdict.presence, 'present-broken');
  // First match's path stays the reported `path`; its own reason (if any)
  // is unprefixed, matching the pre-#2225-P2-fix single-match behavior.
  assert.equal(verdict.path, '/repo/first');
  assert.deepEqual(verdict.brokenReasons, [
    'at /repo/second: uncommitted content present',
  ]);
  // Both matched worktrees were actually probed, not just the first.
  assert.equal(calls.status, 2);
});

// ---------------------------------------------------------------------------
// evaluateLocalCoordinationState against REAL git fixtures (#2225, AC2-AC4)
// ---------------------------------------------------------------------------

// A git-config-file-safe null-device path. `node:os`'s `devNull` is the
// Win32 device-namespace form (`\\.\nul`) on win32, which Git for Windows
// cannot open as a GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM value (`fatal:
// unable to access '//./nul': Invalid argument`); the bare `'NUL'` device
// name is the form git itself accepts there. POSIX is unaffected -- devNull
// there is already `/dev/null`. See kurone-kito/idd-skill#2570.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

// Fixture invariant mirrored from tests/worktree-guard-hook.test.mts and
// tests/claim-lock.test.mts: fixture git processes must never read the
// ambient git environment or the developer's config, so a signing-enabled
// global config or an inherited GIT_DIR cannot leak into these throwaway
// repos.
function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
  env.GIT_CONFIG_SYSTEM = GIT_NULL_DEVICE;
  return env;
}

function fixtureGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: fixtureEnv(), stdio: 'pipe' });
}

function fixtureGitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

/**
 * Real git shell-outs for the AC2-AC4 fixture tests: the REAL production
 * `createLocalCoordinationInputs` wiring (not a hand-rolled duplicate), so
 * these tests exercise the actual env-sanitization and
 * `--untracked-files=all` behavior, not just the pure logic on top of it.
 */
const realLocalInputs = createLocalCoordinationInputs;

// `git worktree list --porcelain` always reports forward-slash paths, even
// on native Windows (#2576), while `mkdtempSync`/`path.join` below compute
// this test's own "expected" path with the platform's native separator
// (backslash on win32). Both name the identical filesystem location, so
// normalize the native-separator side before comparing against a value that
// came from -- or through -- parsed porcelain output. A no-op on POSIX,
// where the native separator already matches porcelain's.
function toGitPorcelainPath(nativePath: string): string {
  return nativePath.replaceAll('\\', '/');
}

function setupPrimaryRepo(): string {
  const primary = mkdtempSync(join(tmpdir(), 'idd-roadmap-local-'));
  fixtureGit(primary, ['init', '-b', 'main']);
  fixtureGit(primary, ['config', 'user.email', 'test@example.com']);
  fixtureGit(primary, ['config', 'user.name', 'Test']);
  writeFileSync(join(primary, 'seed.txt'), 'seed\n');
  fixtureGit(primary, ['add', 'seed.txt']);
  fixtureGit(primary, ['commit', '-m', 'seed']);
  return primary;
}

test('AC2 real fixture: no worktree for the claim branch is cleanly absent', () => {
  const primary = setupPrimaryRepo();
  try {
    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'absent');
    assert.equal(verdict.unreadable, false);
  } finally {
    rmSync(primary, { recursive: true, force: true });
  }
});

test('AC2 real fixture: a checked-out claim branch with uncommitted content is present-broken (not absent)', () => {
  const primary = setupPrimaryRepo();
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  try {
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);
    writeFileSync(join(worktree, 'leftover.txt'), 'uncommitted\n');

    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'present-broken');
    assert.deepEqual(verdict.brokenReasons, ['uncommitted content present']);
  } finally {
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best-effort cleanup
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test('AC3 real fixture: a detached worktree is correctly detected via porcelain enumeration (branch-name grep would miss it)', () => {
  const primary = setupPrimaryRepo();
  const detached = join(primary, '..', `${basename(primary)}-detached`);
  try {
    const head = fixtureGitOut(primary, ['rev-parse', 'HEAD']);
    fixtureGit(primary, ['worktree', 'add', '--detach', detached, head]);

    const porcelain = fixtureGitOut(primary, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    const entries = parseWorktreeListPorcelain(porcelain);
    const detachedPorcelainPath = toGitPorcelainPath(detached);
    const detachedEntry = entries.find(
      (entry) => entry.path === detachedPorcelainPath,
    );
    assert.equal(detachedEntry?.detached, true);
    assert.equal(detachedEntry?.branchRef, null);

    // A branch-name grep has nothing to match here (#2225's whole premise):
    // no entry in the listing carries a `branch` line for this worktree.
    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.deepEqual(verdict.detachedWorktreePaths, [detachedPorcelainPath]);
  } finally {
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', detached]);
    } catch {
      // best-effort cleanup
    }
    rmSync(detached, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test('AC4 real fixture: an in-progress rebase in a LINKED worktree is detected via the resolved git-path (hardcoded .git/rebase-merge would miss it)', () => {
  const primary = setupPrimaryRepo();
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  try {
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);
    // Diverge main and the claim branch so rebasing produces a real conflict.
    fixtureGit(primary, ['checkout', '-b', 'conflict-base', 'main']);
    writeFileSync(join(primary, 'seed.txt'), 'main change\n');
    fixtureGit(primary, ['add', 'seed.txt']);
    fixtureGit(primary, ['commit', '-m', 'main change']);

    writeFileSync(join(worktree, 'seed.txt'), 'branch change\n');
    fixtureGit(worktree, ['add', 'seed.txt']);
    fixtureGit(worktree, ['commit', '-m', 'branch change']);
    try {
      fixtureGit(worktree, ['rebase', 'conflict-base']);
      assert.fail('expected the rebase to conflict');
    } catch {
      // expected: the rebase stops mid-way with a conflict.
    }

    // The naive hardcoded path a branch-name-only implementation would use
    // does not exist for a LINKED worktree — `.git` there is a pointer file,
    // so the real sequencer state is NOT under `<worktree>/.git/rebase-merge`.
    assert.equal(existsSync(join(worktree, '.git', 'rebase-merge')), false);
    // The resolved --git-path DOES exist — this is what a caller must use.
    const resolvedRebaseMerge = fixtureGitOut(worktree, [
      'rev-parse',
      '--git-path',
      'rebase-merge',
    ]);
    assert.equal(
      existsSync(join(worktree, resolvedRebaseMerge)) ||
        existsSync(resolvedRebaseMerge),
      true,
    );

    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'present-broken');
    assert.ok(
      verdict.brokenReasons.includes('rebase in progress'),
      `expected rebase in progress among: ${verdict.brokenReasons.join(', ')}`,
    );
  } finally {
    try {
      fixtureGit(worktree, ['rebase', '--abort']);
    } catch {
      // best-effort: only present if the conflict was never resolved
    }
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best-effort cleanup
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test('real fixture: an untracked-only leftover reports present-broken even under status.showUntrackedFiles=no (review finding, #2225)', () => {
  const primary = setupPrimaryRepo();
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  try {
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);
    fixtureGit(worktree, ['config', 'status.showUntrackedFiles', 'no']);
    writeFileSync(join(worktree, 'untracked-leftover.txt'), 'oops\n');

    // Sanity: an UNQUALIFIED status --porcelain really does go empty under
    // this config, which is exactly the bypass the fix guards against.
    assert.equal(fixtureGitOut(worktree, ['status', '--porcelain']), '');

    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'present-broken');
    assert.deepEqual(verdict.brokenReasons, ['uncommitted content present']);
  } finally {
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best-effort cleanup
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test('real fixture: a dirty submodule reports present-broken even under diff.ignoreSubmodules=all (review finding, #2225)', () => {
  const submoduleUpstream = mkdtempSync(join(tmpdir(), 'idd-roadmap-submod-'));
  const primary = setupPrimaryRepo();
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  try {
    fixtureGit(submoduleUpstream, ['init', '-b', 'main']);
    fixtureGit(submoduleUpstream, ['config', 'user.email', 'test@example.com']);
    fixtureGit(submoduleUpstream, ['config', 'user.name', 'Test']);
    writeFileSync(join(submoduleUpstream, 'f.txt'), 'one\n');
    fixtureGit(submoduleUpstream, ['add', 'f.txt']);
    fixtureGit(submoduleUpstream, ['commit', '-m', 'init']);

    fixtureGit(primary, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleUpstream,
      'sub',
    ]);
    fixtureGit(primary, ['commit', '-m', 'add submodule']);
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);
    // `worktree add` does not check the submodule out on its own; the new
    // worktree's `sub/` starts empty until explicitly initialized.
    fixtureGit(worktree, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
    ]);
    fixtureGit(worktree, ['config', 'diff.ignoreSubmodules', 'all']);
    writeFileSync(join(worktree, 'sub', 'f.txt'), 'two\n');

    // Sanity: an UNQUALIFIED status --porcelain really does go empty under
    // this config, which is exactly the bypass the fix guards against.
    assert.equal(fixtureGitOut(worktree, ['status', '--porcelain']), '');

    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'present-broken');
    assert.deepEqual(verdict.brokenReasons, ['uncommitted content present']);
  } finally {
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best-effort cleanup
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
    rmSync(submoduleUpstream, { recursive: true, force: true });
  }
});

test('real fixture: a worktree path with trailing whitespace is matched correctly, not silently trimmed away (review finding, #2225)', {
  // Windows itself refuses to create a directory whose name ends in a
  // space (`git worktree add` there fails with "could not create leading
  // directories ... Invalid argument") -- an OS-level constraint, not a
  // bug in this repository's code, so this regression cannot be exercised
  // as a real git fixture on native Windows (#2576). POSIX has no such
  // restriction and keeps running the real-fixture coverage unchanged.
  skip:
    process.platform === 'win32' &&
    'Windows cannot create a directory with a trailing space in its name',
}, () => {
  const primary = setupPrimaryRepo();
  // A trailing space in the directory name: `-z`'s exact field boundary
  // preserves it, and the parser must not strip it back off.
  const worktree = join(primary, '..', `${basename(primary)}-wt `);
  try {
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);
    writeFileSync(join(worktree, 'leftover.txt'), 'uncommitted\n');

    const verdict = evaluateLocalCoordinationState(
      'roadmap-audit/995-slug',
      realLocalInputs(primary),
    );
    assert.equal(verdict.presence, 'present-broken');
    assert.equal(verdict.path, toGitPorcelainPath(worktree));
    assert.deepEqual(verdict.brokenReasons, ['uncommitted content present']);
  } finally {
    try {
      fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // best-effort cleanup
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test('real fixture: a spawn-level failure (missing cwd) surfaces its own error message, not just a generic fallback (review finding, #2225)', () => {
  const verdict = evaluateLocalCoordinationState(
    'roadmap-audit/995-slug',
    createLocalCoordinationInputs(
      join(tmpdir(), 'idd-roadmap-nonexistent-cwd-does-not-exist'),
    ),
  );
  assert.equal(verdict.presence, 'absent');
  assert.equal(verdict.unreadable, true);
  assert.notEqual(
    verdict.unreadableReason,
    'git worktree list --porcelain failed',
  );
  assert.match(verdict.unreadableReason ?? '', /ENOENT/);
});

test('real fixture: local git shell-outs ignore ambient GIT_* overrides and never reach a sentinel repo (review finding, #2225)', () => {
  // Differential test: `sentinel` has NO roadmap-audit branch at all, while
  // `primary` has a real, clean worktree checked out on one. An unsanitized
  // `runLocalGitCommand` that let the poisoned GIT_DIR/GIT_WORK_TREE
  // redirect it onto `sentinel` would silently see neither the worktree nor
  // the branch and misreport `absent` — a strictly stronger assertion than
  // just checking `sentinel` was left untouched (read-only code would pass
  // that trivially either way).
  const sentinel = mkdtempSync(join(tmpdir(), 'idd-roadmap-sentinel-'));
  let primary: string | undefined;
  let worktree: string | undefined;
  try {
    fixtureGit(sentinel, ['init', '-b', 'main']);
    fixtureGit(sentinel, ['config', 'user.email', 'sentinel@example.com']);
    fixtureGit(sentinel, ['config', 'user.name', 'Sentinel']);
    writeFileSync(join(sentinel, 'README.md'), 'sentinel\n');
    fixtureGit(sentinel, ['add', 'README.md']);
    fixtureGit(sentinel, ['commit', '-m', 'sentinel']);
    const headBefore = fixtureGitOut(sentinel, ['rev-parse', 'HEAD']);
    const branchesBefore = fixtureGitOut(sentinel, ['branch', '--list']);

    primary = setupPrimaryRepo();
    worktree = join(primary, '..', `${basename(primary)}-wt`);
    fixtureGit(primary, [
      'worktree',
      'add',
      worktree,
      '-b',
      'roadmap-audit/995-slug',
      'main',
    ]);

    const saved = new Map(
      [
        'GIT_DIR',
        'GIT_INDEX_FILE',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY',
      ].map((key) => [key, process.env[key]]),
    );
    try {
      process.env.GIT_DIR = join(sentinel, '.git');
      process.env.GIT_INDEX_FILE = join(sentinel, '.git', 'index');
      process.env.GIT_WORK_TREE = sentinel;
      process.env.GIT_COMMON_DIR = join(sentinel, '.git');
      process.env.GIT_OBJECT_DIRECTORY = join(sentinel, '.git', 'objects');

      const verdict = evaluateLocalCoordinationState(
        'roadmap-audit/995-slug',
        createLocalCoordinationInputs(primary),
      );
      assert.equal(verdict.presence, 'present-clean');
      assert.equal(verdict.path, toGitPorcelainPath(worktree));
      assert.equal(verdict.unreadable, false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    assert.equal(fixtureGitOut(sentinel, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(fixtureGitOut(sentinel, ['branch', '--list']), branchesBefore);
    assert.equal(fixtureGitOut(sentinel, ['status', '--porcelain']), '');
  } finally {
    if (primary && worktree) {
      try {
        fixtureGit(primary, ['worktree', 'remove', '--force', worktree]);
      } catch {
        // best-effort cleanup
      }
      rmSync(worktree, { recursive: true, force: true });
    }
    if (primary) {
      rmSync(primary, { recursive: true, force: true });
    }
    rmSync(sentinel, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runRoadmapAuditExecute wiring: inspectLocalCoordinationState (#2225)
// ---------------------------------------------------------------------------

test('--apply skips the local coordination check entirely when the dep is absent (default deps stay valid)', async () => {
  const { deps } = makeDeps(readyReport());
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 0);
  assert.equal(verdict.closed, true);
  assert.equal(verdict.localCoordinationNote, undefined);
});

test('--apply proceeds and omits the note when the local coordination state is absent (common case)', async () => {
  let receivedBranch: string | null = null;
  const { deps, calls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: (branchName) => {
      receivedBranch = branchName;
      return {
        presence: 'absent',
        path: null,
        brokenReasons: [],
        detachedWorktreePaths: [],
        unreadable: false,
        unreadableReason: null,
      };
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 0);
  assert.equal(verdict.closed, true);
  assert.equal(verdict.localCoordinationNote, undefined);
  assert.equal(receivedBranch, CLAIM_BRANCH);
  assert.deepEqual(calls.closed, [ROADMAP]);
});

test('--apply proceeds with an informational note when the local worktree is present-clean', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => ({
      presence: 'present-clean',
      path: '/repo/wt',
      brokenReasons: [],
      detachedWorktreePaths: [],
      unreadable: false,
      unreadableReason: null,
    }),
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 0);
  assert.equal(verdict.closed, true);
  assert.match(verdict.localCoordinationNote ?? '', /clean local worktree/);
  assert.deepEqual(calls.closed, [ROADMAP]);
});

test('--apply proceeds with an informational note when local state is unreadable (fail-open)', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => ({
      presence: 'absent',
      path: null,
      brokenReasons: [],
      detachedWorktreePaths: [],
      unreadable: true,
      unreadableReason: 'git: command not found',
    }),
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 0);
  assert.equal(verdict.closed, true);
  assert.match(verdict.localCoordinationNote ?? '', /unreadable/);
  assert.deepEqual(calls.closed, [ROADMAP]);
});

test('--apply fails closed (no mutation) when the local worktree is present-broken', async () => {
  const { deps, calls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => ({
      presence: 'present-broken',
      path: '/repo/wt',
      brokenReasons: ['uncommitted content present'],
      detachedWorktreePaths: [],
      unreadable: false,
      unreadableReason: null,
    }),
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 1);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /local coordination state unsafe/);
  assert.match(
    verdict.localCoordinationNote ?? '',
    /not safe to treat as reusable/,
  );
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('--apply calls inspectLocalCoordinationState at all three claim re-validation points (TOCTOU coverage, #2225)', async () => {
  let calls = 0;
  const { deps } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => {
      calls += 1;
      return {
        presence: 'absent',
        path: null,
        brokenReasons: [],
        detachedWorktreePaths: [],
        unreadable: false,
        unreadableReason: null,
      };
    },
  });
  const { exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 0);
  // early + post-refetch + pre-close, mirroring the claim re-validation count.
  assert.equal(calls, 3);
});

test('--apply fails closed when the local worktree turns broken DURING the graph re-fetch (TOCTOU, #2225)', async () => {
  let calls = 0;
  const { deps, calls: mutationCalls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => {
      calls += 1;
      const broken = calls >= 2;
      return {
        presence: broken ? 'present-broken' : 'absent',
        path: broken ? '/repo/wt' : null,
        brokenReasons: broken ? ['uncommitted content present'] : [],
        detachedWorktreePaths: [],
        unreadable: false,
        unreadableReason: null,
      };
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 1);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /local coordination state unsafe/);
  assert.deepEqual(mutationCalls.closed, []);
  assert.deepEqual(mutationCalls.comments, []);
  // Caught at the post-refetch check, before the evidence comment ever posts.
  assert.equal(calls, 2);
});

test('--apply fails closed when the local worktree turns broken in the comment→close gap (TOCTOU, #2225)', async () => {
  let calls = 0;
  const { deps, calls: mutationCalls } = makeDeps(readyReport(), {
    inspectLocalCoordinationState: () => {
      calls += 1;
      const broken = calls >= 3;
      return {
        presence: broken ? 'present-broken' : 'absent',
        path: broken ? '/repo/wt' : null,
        brokenReasons: broken ? ['rebase in progress'] : [],
        detachedWorktreePaths: [],
        unreadable: false,
        unreadableReason: null,
      };
    },
  });
  const { verdict, exitCode } = await runRoadmapAuditExecute(APPLY_ARGS, deps);
  assert.equal(exitCode, 1);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /local coordination state unsafe/);
  // The evidence comment DID post (posted before this final check runs) but
  // the close/release must not — mirrors the existing comment→close claim
  // re-validation's own message shape.
  assert.match(
    verdict.result,
    /evidence comment posted but roadmap NOT closed/,
  );
  assert.equal(mutationCalls.comments.length, 1);
  assert.deepEqual(mutationCalls.closed, []);
  assert.deepEqual(mutationCalls.released, []);
  assert.equal(calls, 3);
});
