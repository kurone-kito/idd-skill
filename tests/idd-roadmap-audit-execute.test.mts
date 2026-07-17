import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  enumerateRoadmapGraph,
  type RoadmapGraphReport,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  buildRoadmapCompletionAuditBody,
  type ConnectedPrEvent,
  evaluateRoadmapAuditGates,
  evaluateRoadmapClaim,
  explainRoadmapClaimReason,
  hasTrustedCompletionEvidenceComment,
  type RoadmapAuditExecuteDeps,
  reconcileConnectedOpenPrs,
  resolveOpenLinkedPrIssues,
  resolveViewerLogin,
  runRoadmapAuditExecute,
  safeHasTrustedCompletionEvidence,
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
// resolveOpenLinkedPrIssues (injected GraphQL runner) — absent-connection
// fail-closed distinction
// ---------------------------------------------------------------------------

// Build a fake page runner that answers the closing-refs vs timeline queries.
function fakeGraphqlRunner(responses: {
  closing?: unknown;
  timeline?: unknown;
}) {
  return (query: string) =>
    query.includes('timelineItems') ? responses.timeline : responses.closing;
}

test('resolveOpenLinkedPrIssues fails closed when the issue node is null/absent', () => {
  const runner = fakeGraphqlRunner({
    closing: { data: { repository: { issue: null } } },
    timeline: { data: { repository: { issue: null } } },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), [1048]);
});

test('resolveOpenLinkedPrIssues fails closed when a lookup connection is null/absent', () => {
  // Present (empty) timeline, but a null closing-refs connection → blocked.
  const runner = fakeGraphqlRunner({
    closing: {
      data: { repository: { issue: { closedByPullRequestsReferences: null } } },
    },
    timeline: {
      data: {
        repository: {
          issue: {
            timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), [1048]);
});

test('resolveOpenLinkedPrIssues does NOT block a present-but-empty connection', () => {
  const runner = fakeGraphqlRunner({
    closing: {
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
    timeline: {
      data: {
        repository: {
          issue: {
            timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), []);
});

test('resolveOpenLinkedPrIssues blocks a present connection with an OPEN closing PR', () => {
  const runner = fakeGraphqlRunner({
    closing: {
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [{ state: 'OPEN' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), [1048]);
});

test('resolveOpenLinkedPrIssues fails closed on a truncated closing-PR page (hasNextPage, no endCursor)', () => {
  const runner = fakeGraphqlRunner({
    closing: {
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [{ state: 'MERGED' }],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), [1048]);
});

test('resolveOpenLinkedPrIssues fails closed on a truncated connected-PR timeline (hasNextPage, no endCursor)', () => {
  const runner = fakeGraphqlRunner({
    closing: {
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
    timeline: {
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(resolveOpenLinkedPrIssues('o', 'r', [1048], runner), [1048]);
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
// resolveViewerLogin (injectable viewer-login lookup, #1396)
// ---------------------------------------------------------------------------

test('resolveViewerLogin normalizes a successful login to lowercase', () => {
  const result = resolveViewerLogin(() => 'Some-User');
  assert.deepEqual(result, {
    viewerLogin: 'some-user',
    viewerLoginUnavailable: false,
  });
});

test('resolveViewerLogin reports unavailable when the lookup throws (caught as null)', () => {
  const result = resolveViewerLogin(() => null);
  assert.deepEqual(result, { viewerLogin: '', viewerLoginUnavailable: true });
});

test('resolveViewerLogin reports unavailable on a blank-but-successful response', () => {
  const result = resolveViewerLogin(() => '   ');
  assert.deepEqual(result, { viewerLogin: '', viewerLoginUnavailable: true });
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
