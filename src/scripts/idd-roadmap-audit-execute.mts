#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-roadmap-audit-execute.mts
//
// The scripts/idd-roadmap-audit-execute.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Thin A1.5 roadmap-completion-audit evaluator + executor. It WRAPS the
// read-only discover-roadmap-graph traversal (reuses its child enumeration
// verbatim) and introduces NO new decision authority: `decisionAuthority`
// stays `instructions`. In the default dry-run it only evaluates completion
// and reports the canonical `IDD roadmap completion audit` evidence body; the
// ONLY mutations anywhere (the evidence comment, the close, and the unclaim
// marker) happen under `--apply` once the roadmap is ready AND the
// roadmap-audit claim re-validates immediately before the close. A roadmap
// with an open / unresolved / inaccessible / nested-roadmap descendant, a
// closed child with an open linked PR, a traversal cycle, or no explicit child
// work is NEVER closed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIssueLoader,
  buildSubIssueLoader,
  enumerateRoadmapGraph,
  isClaimStaleByAge,
  parseClaimStaleAgeMs,
  type RoadmapGraphReport,
} from './discover-roadmap-graph.mts';
import type { ClaimValidationSummary } from './protocol-helpers.mts';
import {
  renderUnclaimedByMarker,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
} from './protocol-helpers.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// Distributed `claim-stale-age` default (docs/policy-constants.md: 24 h). Used
// only as the fallback when the policy declares no (or an invalid)
// `claimTiming.staleAge`; mirrors discover-roadmap-graph's own default.
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const BLOCKED_LABELS = new Set([
  'status:blocked-by-human',
  'status:needs-decision',
]);

/** Distinct blocker categories surfaced by the completion audit. */
export type RoadmapAuditBlockerKind =
  | 'roadmap-blocked'
  | 'childless'
  | 'open-child'
  | 'nested-roadmap'
  | 'open-linked-pr'
  | 'unresolved-reference'
  | 'inaccessible-reference'
  | 'cycle';

/** Branch field that scopes a roadmap-audit coordination claim to one roadmap. */
function roadmapAuditBranchPattern(roadmapNumber: number): RegExp {
  return new RegExp(`^roadmap-audit/${roadmapNumber}-`);
}

/**
 * One reason the roadmap is not ready to close, with the concrete issue it
 * concerns (`target`) and the provenance path from the root roadmap when one
 * is known. `target` / `provenance` are omitted for graph-level blockers
 * (`childless`).
 */
export interface RoadmapAuditBlocker {
  kind: RoadmapAuditBlockerKind;
  target?: number;
  provenance?: number[];
  detail: string;
}

/**
 * JSON verdict document printed by the `idd-roadmap-audit-execute` CLI. The
 * helper is evidence + execution convenience only, so `decisionAuthority`
 * stays `instructions` (consistent with discover-roadmap-graph and
 * idd-merge-execute).
 */
export interface IddRoadmapAuditExecuteVerdict {
  protocolVersion: '1';
  decisionAuthority: 'instructions';
  mode: 'dry-run' | 'apply';
  roadmapNumber: number;
  ready: boolean;
  blockers: RoadmapAuditBlocker[];
  /**
   * Canonical `IDD roadmap completion audit` comment body that would be (dry-
   * run) or was (apply) posted. Empty when the roadmap is not ready: a
   * completion comment is never composed for an incomplete roadmap.
   */
  evidenceBody: string;
  closed: boolean;
  claimReleased: boolean;
  result: string;
}

/** Outcome of re-validating the roadmap-audit claim before any mutation. */
export interface RoadmapClaimVerdict {
  /** True only for a present, owned (claim-id/agent-id match), non-stale claim. */
  owned: boolean;
  reason: string;
  stale: boolean;
  activeClaim: ClaimValidationSummary['activeClaim'];
}

/** Parsed CLI arguments. */
interface RoadmapAuditExecuteArgs {
  roadmapNumber: number | null;
  apply: boolean;
  claimIssue: number | null;
  claimId: string;
  agentId: string;
  owner: string;
  repo: string;
  policy: string;
  now: string;
  help: boolean;
}

/**
 * Evaluate roadmap completion against `report` (a discover-roadmap-graph
 * single-root traversal). Every open / unresolved / inaccessible / nested-
 * roadmap descendant, every traversal cycle, a blocked roadmap root, and a
 * childless/malformed roadmap is collected as a blocker; `ready` is true only
 * when no blocker is collected. The rules mirror the written A1.5 completion
 * criteria exactly — this helper adds no stricter sub-condition. Pure and
 * network-free so it is unit-testable apart from live GitHub.
 */
export function evaluateRoadmapAuditGates(
  report: RoadmapGraphReport,
  options: { openLinkedPrIssues?: Iterable<number> } = {},
): RoadmapAuditBlocker[] {
  const blockers: RoadmapAuditBlocker[] = [];
  const rootNumber = report.root.number;
  const pathTo = buildProvenanceLookup(report);
  const openLinkedPrIssues = new Set(options.openLinkedPrIssues ?? []);
  const reachableExecutionLeafCount = buildReachableLeafCounter(report);

  // Root carrying a human-gate label is never auto-closed.
  const rootNode = report.nodes.find((node) => node.number === rootNumber);
  const rootBlockedLabel = (rootNode?.labels ?? []).find((label) =>
    BLOCKED_LABELS.has(label),
  );
  if (rootBlockedLabel) {
    blockers.push({
      kind: 'roadmap-blocked',
      target: rootNumber,
      provenance: [rootNumber],
      detail: `roadmap #${rootNumber} carries "${rootBlockedLabel}"; resolve the human gate before closing`,
    });
  }

  // No explicit child work → childless / malformed. Do not infer completion
  // from the absence of candidates.
  if (report.edges.length === 0) {
    blockers.push({
      kind: 'childless',
      detail: `roadmap #${rootNumber} has no explicit child references (task-list, closing-keyword, or GitHub sub-issue); childless or malformed, not complete`,
    });
  }

  // Open execution leaves (already classification === 'execution' && OPEN).
  for (const target of [...report.executionCandidates].sort((a, b) => a - b)) {
    const node = report.nodes.find((entry) => entry.number === target);
    blockers.push({
      kind: 'open-child',
      target,
      provenance: pathTo(target),
      detail: `execution leaf #${target}${node ? ` "${node.title}"` : ''} is OPEN`,
    });
  }

  // Nested roadmaps block the parent close when they are either (a) still
  // OPEN — a coordination/audit node closes bottom-up before its parent — or
  // (b) malformed: zero reachable execution-leaf descendants, so a CLOSED
  // nested roadmap can never be taken as proof of completion (A1.5). A closed
  // nested roadmap WITH reachable leaves is fine on its own; any open leaf
  // beneath it is surfaced separately as its own blocker.
  const nestedRoadmaps = report.nodes
    .filter(
      (node) => node.classification === 'roadmap' && node.number !== rootNumber,
    )
    .sort((left, right) => left.number - right.number);
  for (const node of nestedRoadmaps) {
    if (reachableExecutionLeafCount(node.number) === 0) {
      blockers.push({
        kind: 'nested-roadmap',
        target: node.number,
        provenance: pathTo(node.number),
        detail: `nested roadmap #${node.number} "${node.title}" has no reachable execution-leaf descendants; childless or malformed, not proof of completion`,
      });
      continue;
    }
    if (node.state === 'OPEN') {
      blockers.push({
        kind: 'nested-roadmap',
        target: node.number,
        provenance: pathTo(node.number),
        detail: `nested roadmap #${node.number} "${node.title}" is OPEN; close it (bottom-up) before its parent`,
      });
    }
  }

  // A CLOSED child that still has an OPEN linked / closing PR is unresolved:
  // the child looks done but its work is in flight (A1.5). Open children are
  // already blocked above, so only closed descendants are flagged here. The
  // open-PR set is injected as data so the evaluator stays pure.
  const openLinkedPrTargets = report.nodes
    .filter(
      (node) =>
        node.number !== rootNumber &&
        node.state !== 'OPEN' &&
        openLinkedPrIssues.has(node.number),
    )
    .map((node) => node.number)
    .sort((left, right) => left - right);
  for (const target of openLinkedPrTargets) {
    const node = report.nodes.find((entry) => entry.number === target);
    blockers.push({
      kind: 'open-linked-pr',
      target,
      provenance: pathTo(target),
      detail: `closed child #${target}${node ? ` "${node.title}"` : ''} still has an OPEN linked/closing PR; treat as unresolved until it merges or is obsoleted`,
    });
  }

  // Unresolved references (target issue not found / is a PR).
  for (const diagnostic of report.diagnostics.unresolvedReferences) {
    blockers.push({
      kind: 'unresolved-reference',
      target: diagnostic.target,
      provenance: [...pathTo(diagnostic.source), diagnostic.target],
      detail: `reference #${diagnostic.source} → #${diagnostic.target} (${diagnostic.relationship}) is unresolved: ${diagnostic.reason}`,
    });
  }

  // Inaccessible references (403/410/451): cannot prove completion.
  for (const diagnostic of report.diagnostics.inaccessibleReferences) {
    blockers.push({
      kind: 'inaccessible-reference',
      target: diagnostic.target,
      provenance: [...pathTo(diagnostic.source), diagnostic.target],
      detail: `reference #${diagnostic.source} → #${diagnostic.target} (${diagnostic.relationship}) is inaccessible: ${diagnostic.reason}`,
    });
  }

  // Cycles / ambiguous graph: do not guess a closure order.
  for (const cycle of report.diagnostics.cycles) {
    blockers.push({
      kind: 'cycle',
      target: cycle.target,
      provenance: cycle.path,
      detail: `traversal cycle ${cycle.path.join(' → ')} (${cycle.relationship}); graph is ambiguous, treat as unresolved`,
    });
  }

  return blockers;
}

/** First (sorted) root→target provenance path, or `[]` when none is recorded. */
function buildProvenanceLookup(
  report: RoadmapGraphReport,
): (target: number) => number[] {
  const lookup = new Map<number, number[]>();
  for (const entry of report.provenancePaths) {
    if (!lookup.has(entry.target)) {
      lookup.set(entry.target, entry.path);
    }
  }
  return (target) => lookup.get(target) ?? [];
}

/**
 * Count, for any node, how many distinct execution-leaf descendants are
 * reachable from it via the enumerated graph edges (an execution-classified
 * node present in `nodes`, open or closed). Uses only the graph/edge data the
 * traversal already produced; a cycle-safe `visited` set bounds the walk. A
 * count of 0 means the node has no reachable leaf descendants — childless /
 * malformed per A1.5.
 */
function buildReachableLeafCounter(
  report: RoadmapGraphReport,
): (from: number) => number {
  const adjacency = new Map<number, number[]>();
  for (const edge of report.edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  const executionLeaves = new Set(
    report.nodes
      .filter((node) => node.classification === 'execution')
      .map((node) => node.number),
  );

  return (from) => {
    const visited = new Set<number>([from]);
    const stack = [from];
    const leaves = new Set<number>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      for (const next of adjacency.get(current) ?? []) {
        if (executionLeaves.has(next)) {
          leaves.add(next);
        }
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    return leaves.size;
  };
}

/**
 * Compose the canonical `IDD roadmap completion audit` evidence comment body.
 * Deterministic and network-free: it summarizes the audited graph (node /
 * edge / depth counts, closed descendants split by classification, and the
 * traversal diagnostics) and asserts no open / unresolved / inaccessible /
 * nested-roadmap descendant remains. Only called when the roadmap is ready,
 * so every descendant is closed or otherwise complete.
 */
export function buildRoadmapCompletionAuditBody(
  report: RoadmapGraphReport,
): string {
  const rootNumber = report.root.number;
  const descendants = report.nodes.filter((node) => node.number !== rootNumber);
  const executionCount = descendants.filter(
    (node) => node.classification === 'execution',
  ).length;
  const nestedRoadmapCount = descendants.filter(
    (node) => node.classification === 'roadmap',
  ).length;
  const closedExecution = descendants
    .filter((node) => node.classification === 'execution')
    .map((node) => `#${node.number}`)
    .join(', ');
  const closedNested = descendants
    .filter((node) => node.classification === 'roadmap')
    .map((node) => `#${node.number}`)
    .join(', ');

  return [
    '**IDD roadmap completion audit**',
    '',
    `Roadmap #${rootNumber} "${report.root.title}" audited as complete: every referenced child and descendant issue is closed or otherwise complete.`,
    '',
    'Evidence:',
    `- Graph: ${report.summary.nodeCount} nodes, ${report.summary.edgeCount} edges, max depth ${report.summary.maxDepth}.`,
    `- Closed descendants: ${descendants.length} (${executionCount} execution leaves, ${nestedRoadmapCount} nested roadmaps).`,
    `- Closed execution leaves: ${closedExecution || 'none'}.`,
    `- Closed nested roadmaps: ${closedNested || 'none'}.`,
    '- Open / unresolved / inaccessible / nested-roadmap / open-linked-PR descendants: none.',
    `- Diagnostics: ${report.summary.cycleCount} cycles, ${report.summary.unresolvedReferenceCount} unresolved references, ${report.summary.inaccessibleReferenceCount} inaccessible references, ${report.summary.duplicateReferenceCount} duplicate references.`,
    '',
    'Closing the roadmap as completed.',
    '',
    '_IDD roadmap-audit automation. Do not edit._',
  ].join('\n');
}

/**
 * Re-validate the roadmap-audit claim from the live claim-marker stream. The
 * shared `summarizeClaimValidation` resolver decides claim ownership exactly
 * as the merge gate does (trusted-author gated, claim-id / agent-id match).
 * This helper additionally enforces the two roadmap-side ownership rules of
 * A1.5:
 *
 *  1. the active claim's `branch` must be the `roadmap-audit/<roadmapNumber>-…`
 *     coordination branch for THIS roadmap — a normal execution claim such as
 *     `issue/123-fix` on the roadmap issue does NOT authorize closure; and
 *  2. the claim must not be STALE relative to `nowIso`, using the configured
 *     `claimTiming.staleAge` (`staleAgeMs`, default 24 h) via the shared
 *     `isClaimStaleByAge` — a stale claim is takeover-eligible and so cannot
 *     prove ongoing ownership.
 *
 * Pure and network-free: the comment stream, trusted-author predicate, and
 * stale age are injected so every fail-closed path is unit-testable.
 */
export function evaluateRoadmapClaim(
  comments: Parameters<typeof summarizeClaimValidation>[0],
  options: {
    roadmapNumber: number;
    expectedClaimId: string;
    expectedAgentId?: string;
    isTrustedAuthor: (login: string) => boolean;
    nowIso: string;
    staleAgeMs?: number;
  },
): RoadmapClaimVerdict {
  const summary = summarizeClaimValidation(comments, {
    isTrustedAuthor: options.isTrustedAuthor,
    expectedClaimId: options.expectedClaimId,
    expectedAgentId: options.expectedAgentId,
  });
  if (!summary.matchesExpectedClaim) {
    return {
      owned: false,
      reason: summary.reason,
      stale: false,
      activeClaim: summary.activeClaim,
    };
  }
  // Roadmap-side ownership requires the roadmap-audit coordination branch for
  // exactly this roadmap; a normal execution claim on the roadmap issue does
  // not authorize the close.
  if (
    !roadmapAuditBranchPattern(options.roadmapNumber).test(
      summary.activeClaim.branch,
    )
  ) {
    return {
      owned: false,
      reason: 'claim-branch-mismatch',
      stale: false,
      activeClaim: summary.activeClaim,
    };
  }
  // Staleness uses the configured stale age (default 24 h); the math is reused
  // verbatim from the shared `isClaimStaleByAge` rather than re-derived here.
  const stale = isClaimStaleByAge(
    summary.activeClaim.createdAt,
    options.nowIso,
    options.staleAgeMs ?? DEFAULT_CLAIM_STALE_AGE_MS,
  );
  if (stale) {
    return {
      owned: false,
      reason: 'claim-stale',
      stale: true,
      activeClaim: summary.activeClaim,
    };
  }
  return {
    owned: true,
    reason: 'match',
    stale: false,
    activeClaim: summary.activeClaim,
  };
}

/**
 * Injectable side-effecting dependencies. Tests substitute these to drive the
 * dry-run / apply / fail-closed paths without faking live GitHub state;
 * production uses the real roadmap-graph traversal, claim stream, and `gh`.
 */
export interface RoadmapAuditExecuteDeps {
  /** Enumerate the read-only single-root roadmap graph from live state. */
  collect: (roadmapNumber: number) => Promise<RoadmapGraphReport>;
  /**
   * Resolve which of the given (closed) child/descendant issues still have an
   * OPEN linked / closing PR. Returned as data so the pure evaluator can flag
   * them without any network access.
   */
  resolveOpenLinkedPrIssues: (issueNumbers: number[]) => number[];
  /** Re-validate the roadmap-audit claim immediately before mutating. */
  revalidateClaim: (params: {
    issueNumber: number;
    roadmapNumber: number;
    expectedClaimId: string;
    expectedAgentId: string;
    nowIso: string;
  }) => RoadmapClaimVerdict;
  /** POST the canonical `IDD roadmap completion audit` evidence comment. */
  postEvidenceComment: (issueNumber: number, body: string) => void;
  /** Close the roadmap issue as completed. */
  closeRoadmap: (issueNumber: number) => void;
  /** POST the `unclaimed-by` marker that releases the roadmap-audit claim. */
  releaseClaim: (
    issueNumber: number,
    fields: { agentId: string; claimId: string; timestamp: string },
  ) => void;
  /** Resolution "now" (ISO8601); defaults to the wall clock. */
  now: () => string;
}

/**
 * Build the A1.5 verdict and, under `--apply`, execute the audit. The dry-run
 * path performs NO mutation. The apply path fails closed: if the roadmap is
 * not ready it exits without mutating; if it is ready it RE-VALIDATES the
 * roadmap-audit claim and RE-EVALUATES the roadmap graph immediately before
 * mutating, then refuses to mutate (clear message) on any lost / stale / non-
 * owned claim or any newly-discovered blocker. Only after both re-validations
 * pass does it post the evidence comment, close the roadmap, and release the
 * claim — in that order.
 */
export async function runRoadmapAuditExecute(
  argv: string[],
  deps?: RoadmapAuditExecuteDeps,
): Promise<{ verdict: IddRoadmapAuditExecuteVerdict; exitCode: number }> {
  const args = parseArgs(argv);
  if (!args.roadmapNumber) {
    throw new Error('missing required --roadmap <number> argument');
  }
  const roadmapNumber = args.roadmapNumber;
  const resolvedDeps = deps ?? createProductionDeps(args);

  const report = await resolvedDeps.collect(roadmapNumber);
  const blockers = evaluateRoadmapAuditGates(report, {
    openLinkedPrIssues: resolvedDeps.resolveOpenLinkedPrIssues(
      closedDescendantNumbers(report),
    ),
  });
  const ready = blockers.length === 0;
  const evidenceBody = ready ? buildRoadmapCompletionAuditBody(report) : '';

  const verdict: IddRoadmapAuditExecuteVerdict = {
    protocolVersion: '1',
    decisionAuthority: 'instructions',
    mode: args.apply ? 'apply' : 'dry-run',
    roadmapNumber,
    ready,
    blockers,
    evidenceBody,
    closed: false,
    claimReleased: false,
    result: '',
  };

  if (!args.apply) {
    // Dry-run: read-only. Never mutate.
    return { verdict, exitCode: ready ? 0 : 1 };
  }

  if (!ready) {
    // Apply but not ready: fail closed, do not mutate.
    verdict.result =
      'not-ready: completion blockers present; no comment, close, or claim release attempted';
    return { verdict, exitCode: 1 };
  }

  if (!args.claimId) {
    // Apply requires the caller to assert which claim it owns; fail closed.
    verdict.result =
      'not-applied: --claim-id is required under --apply to re-validate roadmap-audit ownership';
    return { verdict, exitCode: 1 };
  }

  // The roadmap-audit claim is scoped to the EXACT roadmap being mutated; a
  // divergent --claim-issue would validate ownership elsewhere while closing
  // this roadmap. Reject it (fail closed) and always validate on the roadmap.
  if (args.claimIssue !== null && args.claimIssue !== roadmapNumber) {
    verdict.result = `claim-issue #${args.claimIssue} must equal the roadmap #${roadmapNumber}; roadmap-audit ownership is scoped to the exact roadmap`;
    return { verdict, exitCode: 1 };
  }

  // Early claim re-validation (defense in depth): bail before the graph
  // re-fetch if ownership is already gone.
  const earlyClaim = resolvedDeps.revalidateClaim({
    issueNumber: roadmapNumber,
    roadmapNumber,
    expectedClaimId: args.claimId,
    expectedAgentId: args.agentId,
    nowIso: resolvedDeps.now(),
  });
  if (!earlyClaim.owned) {
    verdict.result = `claim not owned on re-validation (reason="${earlyClaim.reason}"); no mutation`;
    return { verdict, exitCode: 1 };
  }

  // Re-fetch the roadmap + child state and confirm the audit input still
  // holds; a roadmap that gained an open / unresolved / nested-roadmap /
  // open-linked-PR descendant between the first read and now must NEVER be
  // closed.
  const revalidated = await resolvedDeps.collect(roadmapNumber);
  const revalidatedBlockers = evaluateRoadmapAuditGates(revalidated, {
    openLinkedPrIssues: resolvedDeps.resolveOpenLinkedPrIssues(
      closedDescendantNumbers(revalidated),
    ),
  });
  if (revalidatedBlockers.length > 0) {
    verdict.blockers = revalidatedBlockers;
    verdict.ready = false;
    verdict.evidenceBody = '';
    verdict.result =
      're-validation found new completion blockers immediately before close; no mutation';
    return { verdict, exitCode: 1 };
  }

  // The graph re-fetch can span many API calls during which another session
  // can take over, so the LAST gate before any mutation is a fresh claim
  // re-validation. Its activeClaim + "now" are the ones used for the release.
  const nowIso = resolvedDeps.now();
  const claim = resolvedDeps.revalidateClaim({
    issueNumber: roadmapNumber,
    roadmapNumber,
    expectedClaimId: args.claimId,
    expectedAgentId: args.agentId,
    nowIso,
  });
  if (!claim.owned) {
    verdict.result = `claim not owned immediately before mutation (reason="${claim.reason}"); no mutation`;
    return { verdict, exitCode: 1 };
  }

  // All gates hold: compose the body from the re-validated graph, then post
  // the evidence comment, close the roadmap, and release the claim in order.
  const finalEvidenceBody = buildRoadmapCompletionAuditBody(revalidated);
  verdict.evidenceBody = finalEvidenceBody;

  resolvedDeps.postEvidenceComment(roadmapNumber, finalEvidenceBody);
  resolvedDeps.closeRoadmap(roadmapNumber);
  resolvedDeps.releaseClaim(roadmapNumber, {
    agentId: claim.activeClaim.agentId,
    claimId: claim.activeClaim.claimId,
    // The unclaim marker only accepts second-precision ISO; truncate any
    // sub-second digits so a millisecond `now()` never throws after the
    // comment + close already landed (a partial, unrecoverable mutation).
    timestamp: toSecondPrecisionIso(nowIso),
  });

  verdict.closed = true;
  verdict.claimReleased = true;
  verdict.result =
    'roadmap closed as completed; evidence comment posted and roadmap-audit claim released';
  return { verdict, exitCode: 0 };
}

/** Closed (non-root) descendant issue numbers — the open-linked-PR candidates. */
function closedDescendantNumbers(report: RoadmapGraphReport): number[] {
  return report.nodes
    .filter(
      (node) => node.number !== report.root.number && node.state !== 'OPEN',
    )
    .map((node) => node.number);
}

/** Truncate any sub-second fraction so an ISO stamp is `YYYY-MM-DDTHH:mm:ssZ`. */
function toSecondPrecisionIso(iso: string): string {
  return String(iso).replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Production dependency wiring (live gh + roadmap-graph traversal).
// ---------------------------------------------------------------------------

function createProductionDeps(
  args: RoadmapAuditExecuteArgs,
): RoadmapAuditExecuteDeps {
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const rawConfig = loadPolicy(args.policy);
  const markerPrefix = normalizeMarkerPrefix(
    (rawConfig as { markerPrefix?: unknown }).markerPrefix,
  );
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const isTrustedAuthor = buildTrustedAuthorPredicate({
    owner,
    viewerLogin,
    rawConfig: rawConfig as { trustedMarkerActors?: unknown } | null,
  });
  // Honor the configured `claimTiming.staleAge` (docs/policy-constants.md);
  // reuse discover-roadmap-graph's ISO-duration parser, falling back to the
  // distributed 24 h default on an absent/invalid value.
  const staleAgeMs =
    parseClaimStaleAgeMs(
      (rawConfig as { claimTiming?: { staleAge?: unknown } } | null)
        ?.claimTiming?.staleAge,
    ) ?? DEFAULT_CLAIM_STALE_AGE_MS;
  const loadIssue = buildIssueLoader(owner, repo);
  const loadSubIssues = buildSubIssueLoader(owner, repo);

  return {
    collect: (roadmapNumber) =>
      enumerateRoadmapGraph(roadmapNumber, {
        markerPrefix,
        owner,
        repo,
        loadIssue,
        loadSubIssues,
      }),
    resolveOpenLinkedPrIssues: (issueNumbers) =>
      resolveOpenLinkedPrIssues(owner, repo, issueNumbers),
    revalidateClaim: ({
      issueNumber,
      roadmapNumber,
      expectedClaimId,
      expectedAgentId,
      nowIso,
    }) =>
      evaluateRoadmapClaim(loadIssueComments(owner, repo, issueNumber), {
        roadmapNumber,
        expectedClaimId,
        expectedAgentId,
        isTrustedAuthor,
        nowIso,
        staleAgeMs,
      }),
    postEvidenceComment: (issueNumber, body) =>
      postIssueComment(owner, repo, issueNumber, body),
    closeRoadmap: (issueNumber) =>
      ghText([
        'issue',
        'close',
        String(issueNumber),
        '--repo',
        `${owner}/${repo}`,
        '--reason',
        'completed',
      ]),
    releaseClaim: (issueNumber, fields) =>
      postIssueComment(
        owner,
        repo,
        issueNumber,
        renderUnclaimedByMarker(fields),
      ),
    now: () => new Date().toISOString(),
  };
}

/**
 * Trusted marker-author predicate for claim re-validation. Mirrors the
 * external-check-waiver write-gate set: the repo owner and the authenticated
 * viewer (the agent posting the claim) are always trusted, plus the configured
 * `trustedMarkerActors` and the `IDD_TRUSTED_MARKER_ACTORS` env override
 * (resolved through the shared `resolveTrustedMarkerActors`).
 */
function buildTrustedAuthorPredicate({
  owner,
  viewerLogin,
  rawConfig,
}: {
  owner: string;
  viewerLogin: string;
  rawConfig: { trustedMarkerActors?: unknown } | null;
}): (login: string) => boolean {
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: rawConfig,
  });
  const trusted = new Set(
    [owner, viewerLogin, ...actors]
      .filter(Boolean)
      .map((login) => login.trim().toLowerCase()),
  );
  return (login) =>
    trusted.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
}

/** Load every issue comment (paginated) as the claim-marker event stream. */
function loadIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
): { body: string; createdAt: string; author: { login: string } }[] {
  const comments: unknown[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const raw = ghText([
      'api',
      `repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
      '--jq',
      '.',
    ]);
    const pageItems = raw && raw !== 'null' ? JSON.parse(raw) : [];
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    comments.push(...pageItems);
    if (pageItems.length < pageSize) {
      break;
    }
  }
  return comments.map((entry) => {
    const comment = (entry ?? {}) as {
      body?: unknown;
      created_at?: unknown;
      createdAt?: unknown;
      user?: { login?: unknown } | null;
      author?: { login?: unknown } | null;
    };
    return {
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? comment.created_at ?? ''),
      author: {
        login: String(comment.author?.login ?? comment.user?.login ?? ''),
      },
    };
  });
}

/**
 * Resolve which of `issueNumbers` still have an OPEN linked / closing PR.
 *
 * Uses one GraphQL field per issue — `closedByPullRequestsReferences`, the PRs
 * that reference-close the issue — and keeps a number only when at least one
 * such PR is still in the `OPEN` state. MERGED / CLOSED PRs are obsolete and
 * never block (the field returns merged PRs even with
 * `includeClosedPrs:false`, so the `OPEN`-state filter is what matters). On a
 * per-issue lookup error the issue is conservatively treated as having an open
 * PR (fail closed) so a transient failure can never green-light a close.
 */
function resolveOpenLinkedPrIssues(
  owner: string,
  repo: string,
  issueNumbers: number[],
): number[] {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      closedByPullRequestsReferences(first:20,includeClosedPrs:false){
        nodes { number state }
      }
    }
  }
}`;
  const blocked: number[] = [];
  for (const issueNumber of issueNumbers) {
    try {
      const raw = ghText([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${issueNumber}`,
      ]);
      const parsed = JSON.parse(raw) as {
        data?: {
          repository?: {
            issue?: {
              closedByPullRequestsReferences?: {
                nodes?: { state?: unknown }[] | null;
              } | null;
            } | null;
          } | null;
        };
      };
      const nodes =
        parsed.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ??
        [];
      if (nodes.some((node) => String(node?.state ?? '') === 'OPEN')) {
        blocked.push(issueNumber);
      }
    } catch {
      // Fail closed: an undeterminable PR state blocks the close.
      blocked.push(issueNumber);
    }
  }
  return blocked;
}

/**
 * POST a comment body as a JSON document (`{"body": …}`) via `gh api --input
 * -`. The JSON path is mandatory because HTML-comment-first bodies (the
 * unclaim marker) are silently dropped by `gh issue comment` / `gh api -f
 * body=`; the same path is reused for the evidence comment for consistency.
 */
function postIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): void {
  execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body }), encoding: 'utf8' },
  );
}

function loadPolicy(policyPath: string): unknown {
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (error) {
    if (!policyPath) {
      return {};
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load policy from ${targetPath}: ${detail}`);
  }
}

function normalizeMarkerPrefix(markerPrefix: unknown): string {
  const normalized = String(markerPrefix ?? '').trim();
  return normalized || DEFAULT_MARKER_PREFIX;
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function safeGhText(args: string[]): string {
  try {
    return ghText(args);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): RoadmapAuditExecuteArgs {
  const parsed: RoadmapAuditExecuteArgs = {
    roadmapNumber: null,
    apply: false,
    claimIssue: null,
    claimId: '',
    agentId: '',
    owner: '',
    repo: '',
    policy: '',
    now: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for argument: ${token}`);
    }
    index += 1;
    switch (token) {
      case '--roadmap':
        parsed.roadmapNumber = parsePositiveInteger(value, token);
        break;
      case '--claim-issue':
        parsed.claimIssue = parsePositiveInteger(value, token);
        break;
      case '--claim-id':
        parsed.claimId = value.trim();
        break;
      case '--agent-id':
        parsed.agentId = value.trim();
        break;
      case '--owner':
        parsed.owner = value.trim();
        break;
      case '--repo':
        parsed.repo = value.trim();
        break;
      case '--policy':
        parsed.policy = value.trim();
        break;
      case '--now':
        parsed.now = value.trim();
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  // Fail closed on exactly one of --owner / --repo: a single flag would
  // validate one repo while the traversal / mutation runs against the
  // current-directory repo. Require both or neither.
  if ((parsed.owner === '') !== (parsed.repo === '')) {
    throw new Error(
      'idd-roadmap-audit-execute: --owner and --repo must be provided together or not at all',
    );
  }

  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-roadmap-audit-execute.mjs --roadmap <number> [--owner <owner>] [--repo <repo>] [--policy <path>]
  node scripts/idd-roadmap-audit-execute.mjs --roadmap <number> --claim-id <claim-id> [--claim-issue <number>] [--agent-id <agent-id>] [--owner <owner>] [--repo <repo>] [--policy <path>] [--apply]

  Default (no --apply): dry-run. Evaluates A1.5 roadmap completion via the
  read-only discover-roadmap-graph traversal and prints { ready, blockers,
  evidenceBody } without mutating. Exit 0 when ready, 1 otherwise. evidenceBody
  is the canonical "IDD roadmap completion audit" comment body (empty when the
  roadmap is not ready).

  --apply: when ready, re-validate the roadmap-audit claim and re-evaluate the
  roadmap graph immediately before mutating, then post the evidence comment,
  close the roadmap as completed, and release the claim. Fails closed (exit 1,
  no mutation) on any lost / stale / non-owned claim or any blocker. The claim
  is re-validated against --claim-issue (default: the roadmap) and must match
  --claim-id (required under --apply) and, when given, --agent-id. --owner and
  --repo must be passed together or not at all.
`);
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(moduleUrl) === resolve(entry);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    printHelp();
    process.exit(0);
  }
  runRoadmapAuditExecute(process.argv.slice(2))
    .then(({ verdict, exitCode }) => {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
