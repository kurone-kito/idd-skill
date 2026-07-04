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
} from './discover-roadmap-graph.mjs';
import { ghText, safeGhText } from './gh-exec.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';
import {
  renderUnclaimedByMarker,
  resolveTrustedMarkerActors,
  summarizeClaimValidation,
} from './protocol-helpers.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// Distributed `claim-stale-age` default (docs/policy-constants.md: 24 h). Used
// only as the fallback when the policy declares no (or an invalid)
// `claimTiming.staleAge`; mirrors discover-roadmap-graph's own default.
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
// The canonical evidence comment's literal leading heading. Shared by the
// body composer (`buildRoadmapCompletionAuditBody`) and the evidence
// detector (`hasTrustedCompletionEvidenceComment`, #1299) so the two never
// drift out of sync.
const COMPLETION_AUDIT_HEADING = '**IDD roadmap completion audit**';
// Scope caveat (A1.5): this helper gates only the MECHANICAL completion
// preconditions. It deliberately does NOT verify the roadmap's free-form
// success criteria or autonomy-gap items — that is agent judgment "where
// feasible" per the instruction — so the caller must confirm those separately
// before --apply, exactly as the merge gate trusts that review actually
// happened.
const MECHANICAL_GATE_NOTE =
  'Mechanical preconditions only: every descendant is closed/complete with no open / unresolved / inaccessible / linked-PR / nested-roadmap / childless / cycle / human-gate blocker. Separately verify the roadmap’s free-form success criteria and autonomy-gap items before --apply (this helper does not, just as the merge gate trusts that review happened).';
/** Branch field that scopes a roadmap-audit coordination claim to one roadmap. */
function roadmapAuditBranchPattern(roadmapNumber) {
  return new RegExp(`^roadmap-audit/${roadmapNumber}-`);
}
/**
 * Evaluate roadmap completion against `report` (a discover-roadmap-graph
 * single-root traversal). Every open / unresolved / inaccessible / nested-
 * roadmap descendant, every traversal cycle, a blocked roadmap root, and a
 * childless/malformed roadmap is collected as a blocker; `ready` is true only
 * when no blocker is collected. The rules mirror the written A1.5 completion
 * criteria exactly — this helper adds no stricter sub-condition. One shape is
 * interpreted as safe rather than ambiguous (#1278): a `reference` back-edge
 * from a non-roadmap execution leaf is the provenance breadcrumb the A1.5
 * follow-up rule itself requires, so it never blocks as a cycle (an open
 * leaf still blocks as `open-child`). Pure and
 * network-free so it is unit-testable apart from live GitHub.
 */
export function evaluateRoadmapAuditGates(report, options = {}) {
  const blockers = [];
  const rootNumber = report.root.number;
  const pathTo = buildProvenanceLookup(report);
  const openLinkedPrIssues = new Set(options.openLinkedPrIssues ?? []);
  const reachableExecutionLeafCount = buildReachableLeafCounter(report);
  const blockedLabels = new Set([
    normalizeConfiguredLabelName(
      options.blockedByHumanLabelName,
      POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    ),
    normalizeConfiguredLabelName(
      options.needsDecisionLabelName,
      POLICY_DEFAULTS.labels.needsDecisionLabelName,
    ),
  ]);
  // Root carrying a human-gate label is never auto-closed.
  const rootNode = report.nodes.find((node) => node.number === rootNumber);
  const rootBlockedLabel = (rootNode?.labels ?? []).find((label) =>
    blockedLabels.has(label),
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
  // Cycles / ambiguous graph: do not guess a closure order. A `reference`
  // back-edge whose source is a non-roadmap execution leaf is exempt (#1278):
  // a closed leaf's `Refs #<roadmap>` breadcrumb is the provenance the A1.5
  // follow-up rule requires, and an open leaf is already blocked above as
  // `open-child`, so the audit still fails closed while reporting the true
  // cause. Roadmap-source cycles, unknown-source cycles, stronger
  // relationships (task-list / dependency / closing-keyword / sub-issue),
  // and execution sources in any other state keep blocking.
  const openExecutionLeaves = new Set(report.executionCandidates);
  for (const cycle of report.diagnostics.cycles) {
    const sourceNode = report.nodes.find(
      (entry) => entry.number === cycle.source,
    );
    if (
      cycle.relationship === 'reference' &&
      sourceNode?.classification === 'execution' &&
      (sourceNode.state === 'CLOSED' || openExecutionLeaves.has(cycle.source))
    ) {
      continue;
    }
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
function buildProvenanceLookup(report) {
  const lookup = new Map();
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
function buildReachableLeafCounter(report) {
  const adjacency = new Map();
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
    const visited = new Set([from]);
    const stack = [from];
    const leaves = new Set();
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
export function buildRoadmapCompletionAuditBody(report) {
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
    COMPLETION_AUDIT_HEADING,
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
 * Reconcile a chronological CONNECTED / DISCONNECTED linked-PR event stream
 * into the PR numbers that are CURRENTLY connected (the last event for the PR
 * is a connect, with no later disconnect) AND in the `OPEN` state. Mirrors
 * resume-claim-routing's `fetchOpenLinkedPrReferences` reconciliation so an
 * open PR merely linked (no closing keyword) still blocks a roadmap close,
 * while a CONNECTED-then-DISCONNECTED PR or a connected MERGED PR does not.
 * Pure so it is unit-testable without `gh`.
 */
export function reconcileConnectedOpenPrs(events) {
  const connected = new Map();
  const states = new Map();
  for (const event of events) {
    if (!Number.isInteger(event.prNumber)) {
      continue;
    }
    if (event.type === 'connected') {
      connected.set(event.prNumber, true);
      states.set(event.prNumber, String(event.state ?? ''));
    } else if (event.type === 'disconnected') {
      connected.set(event.prNumber, false);
    }
  }
  const open = [];
  for (const [prNumber, isConnected] of connected) {
    if (isConnected && states.get(prNumber) === 'OPEN') {
      open.push(prNumber);
    }
  }
  return open.sort((left, right) => left - right);
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
export function evaluateRoadmapClaim(comments, options) {
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
 * Detect the helper's own canonical `IDD roadmap completion audit` evidence
 * comment (the exact heading `buildRoadmapCompletionAuditBody` emits) among
 * `comments`, posted by an author for which `isTrustedAuthor` is true. Used
 * only to recognize the idempotent "already complete" retry case (#1299)
 * when the `--apply` early claim re-validation finds no owned claim but the
 * live roadmap is already CLOSED — never to gate the primary close itself,
 * which always requires a freshly re-validated claim. Pure and network-free
 * so it is unit-testable apart from live GitHub.
 */
export function hasTrustedCompletionEvidenceComment(comments, isTrustedAuthor) {
  return (comments ?? []).some(
    (comment) =>
      String(comment.body ?? '').startsWith(COMPLETION_AUDIT_HEADING) &&
      isTrustedAuthor(String(comment.author?.login ?? '')),
  );
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
 *
 * One claim-loss shape at the EARLY re-validation is recognized as a distinct
 * idempotent no-op instead of a bare failure (#1299): a retry after a prior
 * `--apply` already fully completed (e.g. its stdout was lost) finds no owned
 * claim because that prior run already released it. When the live roadmap is
 * already CLOSED and carries this helper's own canonical evidence comment
 * from a trusted marker actor, report `already-complete` (exit 0) rather than
 * the generic claim-not-owned error. Every other claim-loss shape — roadmap
 * still open, closed without trusted evidence — keeps the unchanged
 * fail-closed behavior.
 */
export async function runRoadmapAuditExecute(argv, deps) {
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
    blockedByHumanLabelName: resolvedDeps.blockedByHumanLabelName,
    needsDecisionLabelName: resolvedDeps.needsDecisionLabelName,
  });
  const ready = blockers.length === 0;
  const evidenceBody = ready ? buildRoadmapCompletionAuditBody(report) : '';
  const verdict = {
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
    // Dry-run: read-only. Never mutate. Surface the scope caveat so a caller
    // does not mistake a mechanical "ready" for a full success-criteria audit.
    verdict.result = MECHANICAL_GATE_NOTE;
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
  // Validate + normalize the apply-time clock ONCE, before any mutation: an
  // unparseable "now" would mis-evaluate claim staleness, and an offset /
  // sub-second form would reach the unclaim renderer (which accepts only `…Z`
  // second-precision) and throw AFTER the comment + close had already landed.
  // The single normalized value is reused for every staleness check AND the
  // release marker.
  const rawNow = resolvedDeps.now();
  const nowIso = normalizeApplyNow(rawNow);
  if (nowIso === null) {
    verdict.result = `invalid "now" value "${rawNow}"; expected a parseable ISO timestamp (no mutation)`;
    return { verdict, exitCode: 1 };
  }
  // Early claim re-validation (defense in depth): bail before the graph
  // re-fetch if ownership is already gone.
  const earlyClaim = resolvedDeps.revalidateClaim({
    issueNumber: roadmapNumber,
    roadmapNumber,
    expectedClaimId: args.claimId,
    expectedAgentId: args.agentId,
    nowIso,
  });
  if (!earlyClaim.owned) {
    // #1299: a lost/missing claim here is indistinguishable from a race or
    // hijack UNLESS the live roadmap independently proves the audit already
    // completed — already CLOSED, carrying this helper's own canonical
    // evidence comment from a trusted marker actor (`report` is the graph
    // already fetched at the top of this invocation, so this reuses that
    // read rather than a fresh one). Recognize that one positively-provable
    // state as an idempotent no-op success instead of the fail-closed
    // claim-not-owned error; every other claim-loss shape (roadmap still
    // open, closed without trusted evidence) is unchanged.
    if (
      report.root.state === 'CLOSED' &&
      resolvedDeps.hasTrustedCompletionEvidence(roadmapNumber)
    ) {
      verdict.closed = true;
      verdict.result = `already-complete: roadmap #${roadmapNumber} is already closed with a trusted IDD roadmap completion audit evidence comment (claim reason="${earlyClaim.reason}"); idempotent no-op, no mutation performed`;
      return { verdict, exitCode: 0 };
    }
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
    blockedByHumanLabelName: resolvedDeps.blockedByHumanLabelName,
    needsDecisionLabelName: resolvedDeps.needsDecisionLabelName,
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
  // can take over, so re-validate ownership immediately before posting.
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
  // Post the evidence comment (non-destructive), THEN re-validate ownership one
  // final time immediately before the CLOSE: a takeover landing in the
  // comment→close gap must not let us close under a claim we no longer own. An
  // already-posted evidence comment before an aborted close is harmless — the
  // successor session simply re-audits — but a wrongful close is destructive.
  const finalEvidenceBody = buildRoadmapCompletionAuditBody(revalidated);
  verdict.evidenceBody = finalEvidenceBody;
  resolvedDeps.postEvidenceComment(roadmapNumber, finalEvidenceBody);
  const preCloseClaim = resolvedDeps.revalidateClaim({
    issueNumber: roadmapNumber,
    roadmapNumber,
    expectedClaimId: args.claimId,
    expectedAgentId: args.agentId,
    nowIso,
  });
  if (!preCloseClaim.owned) {
    verdict.result = `claim lost in the comment→close gap (reason="${preCloseClaim.reason}"); evidence comment posted but roadmap NOT closed`;
    return { verdict, exitCode: 1 };
  }
  // Ownership held through the comment: close, then release using the last
  // verdict's activeClaim and the normalized second-precision "now".
  resolvedDeps.closeRoadmap(roadmapNumber);
  resolvedDeps.releaseClaim(roadmapNumber, {
    agentId: preCloseClaim.activeClaim.agentId,
    claimId: preCloseClaim.activeClaim.claimId,
    timestamp: nowIso,
  });
  verdict.closed = true;
  verdict.claimReleased = true;
  verdict.result =
    'roadmap closed as completed; evidence comment posted and roadmap-audit claim released';
  return { verdict, exitCode: 0 };
}
/** Closed (non-root) descendant issue numbers — the open-linked-PR candidates. */
function closedDescendantNumbers(report) {
  return report.nodes
    .filter(
      (node) => node.number !== report.root.number && node.state !== 'OPEN',
    )
    .map((node) => node.number);
}
/** Truncate any sub-second fraction so an ISO stamp is `YYYY-MM-DDTHH:mm:ssZ`. */
function toSecondPrecisionIso(iso) {
  return String(iso).replace(/\.\d+Z$/, 'Z');
}
/**
 * Validate and normalize the apply-time "now" to UTC second-precision ISO
 * (`YYYY-MM-DDTHH:mm:ssZ`), or `null` when unparseable. The caller fails closed
 * on `null` BEFORE any mutation: an unparseable value would mis-evaluate claim
 * staleness (NaN comparisons read as not-stale), and an offset / sub-second
 * form (e.g. `…+09:00`) would otherwise reach `renderUnclaimedByMarker` — which
 * accepts only `…Z` second-precision — and throw AFTER the comment + close had
 * already landed. Normalizing through `toISOString()` also converts any zone
 * offset to UTC, so the single normalized value is safe for both the staleness
 * checks and the release marker.
 */
function normalizeApplyNow(raw) {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return toSecondPrecisionIso(parsed.toISOString());
}
// ---------------------------------------------------------------------------
// Production dependency wiring (live gh + roadmap-graph traversal).
// ---------------------------------------------------------------------------
function createProductionDeps(args) {
  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const rawConfig = loadPolicy(args.policy);
  const markerPrefix = normalizeMarkerPrefix(rawConfig.markerPrefix);
  const viewerLogin = String(safeGhText(['api', 'user', '--jq', '.login']))
    .trim()
    .toLowerCase();
  const isTrustedAuthor = buildTrustedAuthorPredicate({
    owner,
    viewerLogin,
    rawConfig: rawConfig,
  });
  // Honor the configured `claimTiming.staleAge` (docs/policy-constants.md);
  // reuse discover-roadmap-graph's ISO-duration parser, falling back to the
  // distributed 24 h default on an absent/invalid value.
  const staleAgeMs =
    parseClaimStaleAgeMs(rawConfig?.claimTiming?.staleAge) ??
    DEFAULT_CLAIM_STALE_AGE_MS;
  const labelsPolicy = normalizePolicyConfig(rawConfig).labels;
  const loadIssue = buildIssueLoader(owner, repo);
  const loadSubIssues = buildSubIssueLoader(owner, repo);
  return {
    collect: (roadmapNumber) =>
      enumerateRoadmapGraph(roadmapNumber, {
        markerPrefix,
        roadmapLabelName: labelsPolicy.roadmapLabelName,
        owner,
        repo,
        loadIssue,
        loadSubIssues,
      }),
    resolveOpenLinkedPrIssues: (issueNumbers) =>
      resolveOpenLinkedPrIssues(owner, repo, issueNumbers),
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
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
    hasTrustedCompletionEvidence: (roadmapNumber) =>
      hasTrustedCompletionEvidenceComment(
        loadIssueComments(owner, repo, roadmapNumber),
        isTrustedAuthor,
      ),
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
    // Honor a caller-supplied --now (deterministic staleness + release
    // timestamps for tests / replays); fall back to the wall clock.
    now: () => args.now || new Date().toISOString(),
  };
}
/**
 * Trusted marker-author predicate for claim re-validation. Mirrors the
 * external-check-waiver write-gate set: the repo owner and the authenticated
 * viewer (the agent posting the claim) are always trusted, plus the configured
 * `trustedMarkerActors` and the `IDD_TRUSTED_MARKER_ACTORS` env override
 * (resolved through the shared `resolveTrustedMarkerActors`).
 */
function buildTrustedAuthorPredicate({ owner, viewerLogin, rawConfig }) {
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
function loadIssueComments(owner, repo, issueNumber) {
  const comments = [];
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
    const comment = entry ?? {};
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
 * Resolve which of `issueNumbers` still have an OPEN linked PR — covering A1.5's
 * "open linked OR closing PR". Two GraphQL signals per issue, either of which
 * blocks (issue-level short-circuit, `||`):
 *
 *  1. `closedByPullRequestsReferences` — PRs that reference-CLOSE the issue via
 *     a closing keyword — kept only when at least one is still `OPEN` (MERGED /
 *     CLOSED are obsolete; the field returns merged PRs even with
 *     `includeClosedPrs:false`, so the `OPEN`-state filter is what matters); and
 *  2. CONNECTED / DISCONNECTED timeline events — a PR manually linked via
 *     GitHub's Development relationship with NO closing keyword — reconciled
 *     (`CONNECTED_EVENT` with no later `DISCONNECTED_EVENT` for the same PR) and
 *     kept only when that PR is still `OPEN`. Mirrors resume-claim-routing's
 *     `fetchOpenLinkedPrReferences` shape.
 *
 * Both queries paginate fully (the connected stream MUST be read whole so a
 * later DISCONNECTED is never missed). Fails closed: a per-issue lookup error,
 * OR an ABSENT lookup connection (`issue: null` / connection `null`|`undefined`
 * — a deleted / transferred / inaccessible issue, or partial GraphQL data),
 * treats the issue as blocked. An absent connection is distinct from a
 * genuinely present-but-empty `nodes: []` (legitimately no PR on that signal),
 * which does NOT block on that signal. The GraphQL runner is injectable so the
 * absence distinction is unit-testable without `gh`.
 */
export function resolveOpenLinkedPrIssues(
  owner,
  repo,
  issueNumbers,
  runGraphql = ghGraphql,
) {
  const blocked = [];
  for (const issueNumber of issueNumbers) {
    try {
      if (
        hasOpenClosingPr(owner, repo, issueNumber, runGraphql) ||
        hasOpenConnectedPr(owner, repo, issueNumber, runGraphql)
      ) {
        blocked.push(issueNumber);
      }
    } catch {
      // Fail closed: an undeterminable / absent PR state blocks the close.
      blocked.push(issueNumber);
    }
  }
  return blocked;
}
/**
 * Narrow a parsed GraphQL response to the named connection on its issue node,
 * THROWING (→ fail closed) when the issue is `null`/absent or the connection
 * itself is `null`/`undefined`. A present connection (even with empty `nodes`)
 * is returned as-is so a legitimately PR-free issue is not treated as blocked.
 */
function requireIssueConnection(parsed, pick, label) {
  const issue = parsed?.data?.repository?.issue;
  if (issue === null || issue === undefined) {
    throw new Error(`${label}: issue is null/absent (fail closed)`);
  }
  const connection = pick(issue);
  if (connection === null || connection === undefined) {
    throw new Error(`${label}: connection is null/absent (fail closed)`);
  }
  return connection;
}
/**
 * True when the issue has an OPEN PR that reference-closes it. Pages through
 * `closedByPullRequestsReferences` and short-circuits on the first OPEN PR
 * (one is enough to block); truncating the list could miss an OPEN blocker on
 * a later page, wrongly green-lighting a close. Throws (→ blocked) on an absent
 * connection.
 */
function hasOpenClosingPr(owner, repo, issueNumber, runGraphql) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      closedByPullRequestsReferences(first:50,after:$after,includeClosedPrs:false){
        nodes { state }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  let after = null;
  for (;;) {
    const parsed = runGraphql(query, owner, repo, issueNumber, after);
    const connection = requireIssueConnection(
      parsed,
      (issue) => issue.closedByPullRequestsReferences,
      'closedByPullRequestsReferences',
    );
    const nodes = connection.nodes ?? [];
    if (nodes.some((node) => String(node?.state ?? '') === 'OPEN')) {
      return true;
    }
    if (!connection.pageInfo?.hasNextPage) {
      return false;
    }
    after = connection.pageInfo.endCursor ?? null;
    if (!after) {
      // hasNextPage with no endCursor: an incomplete / unexpected connection
      // read. Throw so the per-issue catch fails closed (blocks the child)
      // rather than treating a partial page as "no open PR".
      throw new Error(
        'incomplete closing-PR pagination: hasNextPage with no endCursor',
      );
    }
  }
}
/**
 * True when the issue has a currently-CONNECTED, OPEN linked PR (Development
 * relationship without a closing keyword). Pages the CONNECTED/DISCONNECTED
 * timeline in full — the whole stream is needed so a later DISCONNECTED is not
 * missed — then reconciles it via the pure {@link reconcileConnectedOpenPrs}.
 * Throws (→ blocked) on an absent connection.
 */
function hasOpenConnectedPr(owner, repo, issueNumber, runGraphql) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      timelineItems(first:50,after:$after,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){
        nodes {
          __typename
          ... on ConnectedEvent { subject { __typename ... on PullRequest { number state } } }
          ... on DisconnectedEvent { subject { __typename ... on PullRequest { number } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  const events = [];
  let after = null;
  for (;;) {
    const parsed = runGraphql(query, owner, repo, issueNumber, after);
    const connection = requireIssueConnection(
      parsed,
      (issue) => issue.timelineItems,
      'timelineItems',
    );
    events.push(...parseConnectedPrEvents(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? null;
    if (!after) {
      // hasNextPage with no endCursor: reconciling a truncated timeline could
      // miss a later CONNECTED open PR. Throw so the per-issue catch fails
      // closed (blocks the child) instead of trusting the partial stream.
      throw new Error(
        'incomplete connected-PR timeline pagination: hasNextPage with no endCursor',
      );
    }
  }
  return reconcileConnectedOpenPrs(events).length > 0;
}
/** Run one `gh api graphql` page, passing `after` only when set. */
function ghGraphql(query, owner, repo, issueNumber, after) {
  const apiArgs = [
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
  ];
  if (after) {
    apiArgs.push('-f', `after=${after}`);
  }
  return JSON.parse(ghText(apiArgs));
}
/** Coerce raw CONNECTED/DISCONNECTED timeline nodes into reconcile events. */
function parseConnectedPrEvents(nodes) {
  const events = [];
  for (const node of nodes) {
    const record = node;
    const subject = record?.subject;
    if (subject?.__typename !== 'PullRequest') {
      continue;
    }
    const prNumber =
      typeof subject.number === 'number' ? subject.number : Number.NaN;
    if (!Number.isInteger(prNumber)) {
      continue;
    }
    if (record?.__typename === 'ConnectedEvent') {
      events.push({
        type: 'connected',
        prNumber,
        state: String(subject.state ?? ''),
      });
    } else if (record?.__typename === 'DisconnectedEvent') {
      events.push({ type: 'disconnected', prNumber });
    }
  }
  return events;
}
/**
 * POST a comment body as a JSON document (`{"body": …}`) via `gh api --input
 * -`. The JSON path is mandatory because HTML-comment-first bodies (the
 * unclaim marker) are silently dropped by `gh issue comment` / `gh api -f
 * body=`; the same path is reused for the evidence comment for consistency.
 */
function postIssueComment(owner, repo, issueNumber, body) {
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
function loadPolicy(policyPath) {
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
function normalizeMarkerPrefix(markerPrefix) {
  const normalized = String(markerPrefix ?? '').trim();
  return normalized || DEFAULT_MARKER_PREFIX;
}
/**
 * Resolve one configured `labels.*` name (#1273), falling back to the given
 * `policy-helpers.mts` `POLICY_DEFAULTS.labels` default for an absent or
 * invalid value.
 */
function normalizeConfiguredLabelName(labelName, fallback) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : fallback;
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const parsed = {
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
function parsePositiveInteger(value, flag) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}
function printHelp() {
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
  is re-validated against the roadmap issue; --claim-issue, when provided, must
  equal --roadmap. The active claim must be a roadmap-audit-scoped claim
  (branch roadmap-audit/<roadmap>-<slug>) and match --claim-id (required under
  --apply) and, when given, --agent-id. --owner and --repo must be passed
  together or not at all.

  SCOPE: this helper gates only the MECHANICAL completion preconditions (all
  descendants closed/complete; no open / unresolved / inaccessible / linked-PR
  / nested-roadmap / childless / cycle / human-gate blocker). It does NOT verify
  the roadmap's free-form success criteria or autonomy-gap items — the caller
  must confirm those separately before --apply, exactly as the merge gate
  trusts that review actually happened.
`);
}
function isMainModule(moduleUrl) {
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
    .catch((error) => {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exit(1);
    });
}
