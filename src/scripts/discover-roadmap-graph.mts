#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-roadmap-graph.mts
//
// The scripts/discover-roadmap-graph.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAutopilotSuitabilityScore,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
} from './autopilot-suitability.mts';
import { parseIsoDurationToMs } from './policy-helpers.mts';
import {
  isStaleAt,
  resolveActiveClaim,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// Policy default claim stale age (`claimTiming.staleAge`, `PT24H`). Mirrors
// the default baked into protocol-helpers' `isStaleAt`, so when the configured
// stale age equals this default the shared `isStaleAt` path is
// reused verbatim instead of re-deriving the 24h math here.
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const INACCESSIBLE_ISSUE_SENTINEL = Object.freeze({
  __iddLookupStatus: 'inaccessible',
});
const INACCESSIBLE_HTTP_STATUSES = new Set([403, 410, 451]);
const KEYWORD_REFERENCE_REGEX =
  /\b(Closes|Close|Closed|Fixes|Fixed|Fix|Resolves|Resolved|Resolve|Refs|Ref|Depends on|Blocked by|Sub-issue|Sub issue)\b/giu;
const SUB_ISSUES_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) {
    issue(number:$number) {
      subIssues(first:100, after:$after) {
        nodes {
          number
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;
const OPEN_ISSUES_QUERY = `
query($owner:String!, $repo:String!, $after:String) {
  repository(owner:$owner, name:$repo) {
    issues(states:OPEN, first:100, after:$after) {
      nodes {
        number
        body
        labels(first:100) {
          nodes {
            name
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

type InaccessibleIssueSentinel = typeof INACCESSIBLE_ISSUE_SENTINEL;

/** One outbound reference extracted from an issue body or sub-issue list. */
export interface RoadmapGraphReference {
  target: number;
  relationship: string;
  evidence: string;
}

/** One traversal edge of the enumerated roadmap graph. */
export interface RoadmapGraphEdge extends RoadmapGraphReference {
  source: number;
}

/** Classification verdict for one issue node during traversal. */
export interface RoadmapIssueClassification {
  kind: 'roadmap' | 'execution';
  roadmapMarkerId: string;
}

/**
 * Active-claim eligibility annotation for one discovery execution leaf.
 *
 * Under the opt-in `--with-claim-state` flag every annotated open execution
 * leaf carries this object (Design O). `present: false` (with `claimId: null`,
 * `agentId: null`) means no trusted claim is present at all; `present: true`
 * means a trusted claim exists, with `stale` reporting whether it is older
 * than the configured `claimTiming.staleAge` relative to now (a stale claim is
 * takeover-eligible). The whole annotation is absent (key omitted) on the
 * default flag-absent path. `ownedByCurrentSession` is present whenever the
 * caller passed `--current-claim-id` (`true` when the active claim's `claimId`
 * equals it, `false` otherwise — including the no-claim `present: false` case),
 * and absent only when `--current-claim-id` was not supplied.
 */
export interface LeafActiveClaim {
  present: boolean;
  stale: boolean;
  claimId: string | null;
  agentId: string | null;
  ownedByCurrentSession?: boolean;
}

/** One node of the enumerated roadmap graph in report form. */
export interface RoadmapGraphNode {
  number: number;
  title: string;
  state: string;
  labels: string[];
  classification: 'roadmap' | 'execution';
  roadmapMarkerId: string;
  autopilotSuitability: number | null;
  depth: number;
  /**
   * Active-claim annotation, present only under `--with-claim-state` and only
   * on open execution-leaf nodes, where it is always an object (Design O):
   * `present: false` means no trusted claim is present, `present: true` means
   * one exists (possibly stale). Absent on every node in the default
   * (flag-absent) path so the byte-stable output shape is unchanged.
   */
  activeClaim?: LeafActiveClaim;
  /**
   * Derived eligibility: `true` when no present, non-stale, trusted-actor
   * claim blocks this leaf. Present only under `--with-claim-state` on open
   * execution-leaf nodes.
   */
  claimEligible?: boolean;
}

/** Provenance path from the root roadmap to one discovered node. */
export interface RoadmapProvenancePath {
  target: number;
  path: number[];
}

/** One de-duplicated diagnostic entry for a problematic reference. */
export interface RoadmapReferenceDiagnostic {
  source: number;
  target: number;
  relationship: string;
  evidence: string;
  reason: string;
}

/** One duplicate-reference diagnostic entry. */
export interface RoadmapDuplicateReferenceDiagnostic {
  source: number;
  target: number;
  relationship: string;
  evidence: string;
  firstSeenFrom: number;
}

/** One traversal-cycle diagnostic entry. */
export interface RoadmapCycleDiagnostic {
  source: number;
  target: number;
  relationship: string;
  path: number[];
}

/** Full enumeration report returned by `enumerateRoadmapGraph`. */
export interface RoadmapGraphReport {
  root: {
    number: number;
    title: string;
    state: string;
    classification: 'roadmap' | 'execution';
    roadmapMarkerId: string;
  };
  nodes: RoadmapGraphNode[];
  edges: RoadmapGraphEdge[];
  provenancePaths: RoadmapProvenancePath[];
  roadmapNodes: number[];
  executionCandidates: number[];
  diagnostics: {
    duplicateReferences: RoadmapDuplicateReferenceDiagnostic[];
    cycles: RoadmapCycleDiagnostic[];
    inaccessibleReferences: RoadmapReferenceDiagnostic[];
    unresolvedReferences: RoadmapReferenceDiagnostic[];
  };
  summary: {
    rootNumber: number;
    nodeCount: number;
    edgeCount: number;
    roadmapNodeCount: number;
    executionCandidateCount: number;
    duplicateReferenceCount: number;
    cycleCount: number;
    inaccessibleReferenceCount: number;
    unresolvedReferenceCount: number;
    maxDepth: number;
  };
}

/** One ranked open execution leaf in the cross-roadmap union report. */
export interface RoadmapUnionLeaf {
  number: number;
  title: string;
  state: string;
  labels: string[];
  // Union leaves come only from execution candidates, so the
  // classification is always the literal 'execution'.
  classification: 'execution';
  roadmapMarkerId: string;
  autopilotSuitability: number | null;
  /**
   * The set of open roadmap roots this leaf is reachable from, sorted
   * ascending. A leaf reachable from several sibling epics carries every
   * source root here and is never double-counted in the union.
   */
  sourceRoots: number[];
  /**
   * Active-claim annotation, present only under `--with-claim-state`, where it
   * is always an object (Design O): `present: false` means no trusted claim is
   * present, `present: true` means one exists (possibly stale). Absent on
   * every leaf in the default (flag-absent) path so the byte-stable output
   * shape is unchanged.
   */
  activeClaim?: LeafActiveClaim;
  /**
   * Derived eligibility: `true` when no present, non-stale, trusted-actor
   * claim blocks this leaf. Present only under `--with-claim-state`.
   */
  claimEligible?: boolean;
}

/** One discovered open roadmap root the union enumeration started from. */
export interface RoadmapUnionRoot {
  number: number;
  title: string;
  state: string;
  roadmapMarkerId: string;
}

/**
 * Cross-roadmap union report returned by `enumerateAllRoadmapsGraph`.
 *
 * Additive `--all-roadmaps` mode: the single-root `RoadmapGraphReport`
 * shape (returned by `enumerateRoadmapGraph`) is unchanged. This report
 * is only produced when `--all-roadmaps` is passed.
 */
export interface RoadmapGraphUnionReport {
  mode: 'all-roadmaps';
  roots: RoadmapUnionRoot[];
  leaves: RoadmapUnionLeaf[];
  diagnostics: {
    duplicateReferences: RoadmapDuplicateReferenceDiagnostic[];
    cycles: RoadmapCycleDiagnostic[];
    inaccessibleReferences: RoadmapReferenceDiagnostic[];
    unresolvedReferences: RoadmapReferenceDiagnostic[];
  };
  summary: {
    rootCount: number;
    leafCount: number;
    scoredLeafCount: number;
    sharedLeafCount: number;
    duplicateReferenceCount: number;
    cycleCount: number;
    inaccessibleReferenceCount: number;
    unresolvedReferenceCount: number;
  };
}

interface NormalizedIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: Set<string>;
  isPullRequest: boolean;
}

interface RoadmapNodeRecord {
  number: number;
  title: string;
  state: string;
  labels: Set<string>;
  classification: 'roadmap' | 'execution';
  roadmapMarkerId: string;
  autopilotSuitability: number | null;
  depth: number;
}

/**
 * Opt-in active-claim annotation inputs (the `--with-claim-state` surface).
 *
 * The whole feature is gated on {@link ClaimStateOptions.claimState} being
 * present: when it is absent the helper makes NO extra GitHub API calls and
 * emits no claim fields, so the default output shape stays byte-stable. When
 * present, each open execution leaf is annotated with active-claim eligibility
 * using `loadComments` (an injected per-issue comment loader, mirroring the
 * existing `loadIssue`/`loadSubIssues` injection so tests stay network-free).
 */
interface ClaimStateResolution {
  loadComments: (issueNumber: number) => unknown;
  /**
   * Trusted-actor predicate, resolved from `IDD_TRUSTED_MARKER_ACTORS` then
   * the configured `trustedMarkerActors`.
   */
  isTrustedAuthor: (login: string) => boolean;
  /** Configured `claimTiming.staleAge` in ms (defaults to PT24H). */
  staleAgeMs: number;
  /** Resolution "now" (ISO8601); defaults to the wall clock. */
  nowIso: string;
  /** `--current-claim-id`, or '' when not supplied. */
  currentClaimId: string;
}

interface ClaimStateOptions {
  claimState?: ClaimStateResolution;
}

interface EnumerateRoadmapGraphOptions extends ClaimStateOptions {
  markerPrefix?: unknown;
  owner?: string;
  repo?: string;
  loadIssue?: (issueNumber: number) => unknown;
  loadSubIssues?: (issueNumber: number) => unknown;
}

interface EnumerateAllRoadmapsGraphOptions
  extends EnumerateRoadmapGraphOptions {
  /**
   * Discover every open roadmap root. Each entry is an open issue
   * carrying the `roadmap` label or an
   * `<!-- {markerPrefix}-roadmap-id: ... -->` marker. The union mode
   * runs the existing single-root enumeration from each returned root.
   */
  loadOpenRoadmapRoots?: () => unknown;
  /**
   * Configured autopilot-suitability floor (`autopilotSuitability.floor`
   * from policy). Unscored or out-of-range leaves rank at this floor in
   * the union ordering. Normalized to an integer 1-5, falling back to the
   * default autopilot-suitability floor when unset or invalid.
   */
  floor?: unknown;
}

interface ParsedArgs {
  issue: number;
  allRoadmaps: boolean;
  owner: string;
  repo: string;
  policy: string;
  withClaimState: boolean;
  currentClaimId: string;
  help: boolean;
}

type CachedIssue = NormalizedIssue | InaccessibleIssueSentinel | null;

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const hasIssue = Number.isInteger(args.issue) && args.issue > 0;
  // --issue and --all-roadmaps are mutually exclusive: exactly one route
  // must be selected. The single-root --issue contract (required when
  // --all-roadmaps is absent) is preserved.
  if (args.allRoadmaps && hasIssue) {
    throw new Error('--all-roadmaps cannot be combined with --issue');
  }
  if (!args.allRoadmaps && !hasIssue) {
    throw new Error(
      'missing required --issue <number> (or pass --all-roadmaps)',
    );
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const policy = loadPolicy(args.policy) as {
    markerPrefix?: unknown;
    autopilotSuitability?: { floor?: unknown };
    claimTiming?: { staleAge?: unknown };
    trustedMarkerActors?: unknown;
  };

  // The claim-state annotation is strictly opt-in: only when --with-claim-state
  // is passed do we build the comment loader (the sole new GitHub API surface)
  // and resolve the trusted-actor / stale-age policy. The default path leaves
  // `claimState` undefined, so no extra fetch is made and the output is
  // byte-stable.
  const claimState = args.withClaimState
    ? buildClaimStateResolution(owner, repo, policy, args.currentClaimId)
    : undefined;

  const report = args.allRoadmaps
    ? await enumerateAllRoadmapsGraph({
        markerPrefix: policy.markerPrefix,
        floor: policy.autopilotSuitability?.floor,
        owner,
        repo,
        loadIssue: buildIssueLoader(owner, repo),
        loadSubIssues: buildSubIssueLoader(owner, repo),
        loadOpenRoadmapRoots: buildOpenRoadmapRootsLoader(
          owner,
          repo,
          policy.markerPrefix,
        ),
        claimState,
      })
    : await enumerateRoadmapGraph(args.issue, {
        markerPrefix: policy.markerPrefix,
        owner,
        repo,
        loadIssue: buildIssueLoader(owner, repo),
        loadSubIssues: buildSubIssueLoader(owner, repo),
        claimState,
      });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function enumerateRoadmapGraph(
  rootIssueNumber: number,
  options: EnumerateRoadmapGraphOptions = {},
): Promise<RoadmapGraphReport> {
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const loadIssueOption = options.loadIssue;
  const loadSubIssues =
    typeof options.loadSubIssues === 'function'
      ? options.loadSubIssues
      : async () => [];
  const currentRepoRef = normalizeRepoRef(options.owner, options.repo);

  if (typeof loadIssueOption !== 'function') {
    throw new Error('enumerateRoadmapGraph requires loadIssue(issueNumber)');
  }
  // Re-bind after the guard so the hoisted helper closures below see the
  // narrowed function type.
  const loadIssue = loadIssueOption;

  const issueCache = new Map<number, CachedIssue>();
  const nodeRecords = new Map<number, RoadmapNodeRecord>();
  const edges: RoadmapGraphEdge[] = [];
  const provenancePaths: RoadmapProvenancePath[] = [];
  const diagnostics = {
    duplicateReferences: [] as RoadmapDuplicateReferenceDiagnostic[],
    cycles: [] as RoadmapCycleDiagnostic[],
    inaccessibleReferences: [] as RoadmapReferenceDiagnostic[],
    unresolvedReferences: [] as RoadmapReferenceDiagnostic[],
  };
  const pathKeys = new Set<string>();
  const visitedIssuePaths = new Set<string>();
  const edgeKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  const cycleKeys = new Set<string>();
  const inaccessibleKeys = new Set<string>();
  const unresolvedKeys = new Set<string>();
  const referenceCache = new Map<number, RoadmapGraphReference[]>();
  const fetchedRoot = await getIssue(rootIssueNumber, issueCache, loadIssue);
  if (!fetchedRoot) {
    throw new Error(`root issue #${rootIssueNumber} was not found`);
  }
  if (isInaccessibleIssue(fetchedRoot)) {
    throw new Error(`root issue #${rootIssueNumber} is inaccessible`);
  }
  if (fetchedRoot.isPullRequest) {
    throw new Error(`root issue #${rootIssueNumber} is a pull request`);
  }
  // Re-bind after the guards so the hoisted helper closures below see the
  // narrowed issue type.
  const rootIssue = fetchedRoot;

  await visitIssue(rootIssue.number, [rootIssue.number]);

  const nodes = [...nodeRecords.values()]
    .map((node) => ({
      number: node.number,
      title: node.title,
      state: node.state,
      labels: [...node.labels].sort(),
      classification: node.classification,
      roadmapMarkerId: node.roadmapMarkerId,
      autopilotSuitability: node.autopilotSuitability ?? null,
      depth: node.depth,
    }))
    .sort(compareByNumber);
  const sortedEdges = [...edges].sort(compareEdges);
  const sortedProvenancePaths = [...provenancePaths].sort(comparePaths);
  const roadmapNodes = nodes
    .filter(
      (node) =>
        node.classification === 'roadmap' && node.number !== rootIssue.number,
    )
    .map((node) => node.number);
  const executionCandidates = nodes
    .filter(
      (node) => node.classification === 'execution' && node.state === 'OPEN',
    )
    .map((node) => node.number);
  const rootNode = nodeRecords.get(rootIssue.number);
  if (!rootNode) {
    throw new Error(`root issue #${rootIssueNumber} was not recorded`);
  }

  // Opt-in (#1008): annotate each open execution-leaf node with active-claim
  // eligibility. Gated on `options.claimState` so the default path makes no
  // extra GitHub API call and the output shape stays byte-stable.
  if (options.claimState) {
    const executionCandidateSet = new Set(executionCandidates);
    for (const node of nodes) {
      if (!executionCandidateSet.has(node.number)) {
        continue;
      }
      const annotated = await annotateLeafClaimState(
        node.number,
        options.claimState,
      );
      (node as RoadmapGraphNode).activeClaim = annotated.activeClaim;
      (node as RoadmapGraphNode).claimEligible = annotated.claimEligible;
    }
  }

  return {
    root: {
      number: rootNode.number,
      title: rootNode.title,
      state: rootNode.state,
      classification: rootNode.classification,
      roadmapMarkerId: rootNode.roadmapMarkerId,
    },
    nodes,
    edges: sortedEdges,
    provenancePaths: sortedProvenancePaths,
    roadmapNodes,
    executionCandidates,
    diagnostics: {
      duplicateReferences:
        diagnostics.duplicateReferences.sort(compareDiagnostics),
      cycles: diagnostics.cycles.sort(compareCycles),
      inaccessibleReferences:
        diagnostics.inaccessibleReferences.sort(compareDiagnostics),
      unresolvedReferences:
        diagnostics.unresolvedReferences.sort(compareDiagnostics),
    },
    summary: {
      rootNumber: rootNode.number,
      nodeCount: nodes.length,
      edgeCount: sortedEdges.length,
      roadmapNodeCount: roadmapNodes.length,
      executionCandidateCount: executionCandidates.length,
      duplicateReferenceCount: diagnostics.duplicateReferences.length,
      cycleCount: diagnostics.cycles.length,
      inaccessibleReferenceCount: diagnostics.inaccessibleReferences.length,
      unresolvedReferenceCount: diagnostics.unresolvedReferences.length,
      maxDepth: nodes.reduce(
        (maxDepth, node) => Math.max(maxDepth, node.depth),
        0,
      ),
    },
  };

  async function visitIssue(issueNumber: number, path: number[]) {
    const issue = await getIssue(issueNumber, issueCache, loadIssue);
    if (!issue || isInaccessibleIssue(issue)) {
      return;
    }

    const visitKey = `${issue.number}:${path.join('>')}`;
    if (visitedIssuePaths.has(visitKey)) {
      return;
    }
    visitedIssuePaths.add(visitKey);

    recordNode(issue, path);
    const references = await getReferences(issue);
    const seenSourceTargets = new Set<string>();
    const seenSourceEdgeKeys = new Set<string>();
    const firstReferenceBySourceTarget = new Map<string, RoadmapGraphEdge>();

    for (const reference of references) {
      const edge = {
        source: issue.number,
        target: reference.target,
        relationship: reference.relationship,
        evidence: reference.evidence,
      };
      const edgeKey = buildEdgeKey(edge);
      if (seenSourceEdgeKeys.has(edgeKey)) {
        recordDuplicateReference(edge, edge);
        continue;
      }
      seenSourceEdgeKeys.add(edgeKey);
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push(edge);

        const sourceTargetKey = `${edge.source}:${edge.target}`;
        if (seenSourceTargets.has(sourceTargetKey)) {
          recordDuplicateReference(
            edge,
            firstReferenceBySourceTarget.get(sourceTargetKey) ?? edge,
          );
        }
        seenSourceTargets.add(sourceTargetKey);

        const firstReference =
          firstReferenceBySourceTarget.get(sourceTargetKey);
        if (firstReference) {
          recordDuplicateReference(edge, firstReference);
        } else {
          firstReferenceBySourceTarget.set(sourceTargetKey, edge);
        }
      }

      if (path.includes(edge.target)) {
        const cyclePath = [...path, edge.target];
        const cycleKey = cyclePath.join('>');
        if (!cycleKeys.has(cycleKey)) {
          cycleKeys.add(cycleKey);
          diagnostics.cycles.push({
            source: edge.source,
            target: edge.target,
            relationship: edge.relationship,
            path: cyclePath,
          });
        }
        continue;
      }

      const targetIssue = await getIssue(edge.target, issueCache, loadIssue);
      if (!targetIssue) {
        recordReferenceDiagnostic(
          diagnostics.unresolvedReferences,
          unresolvedKeys,
          edge,
          'issue_not_found',
        );
        continue;
      }
      if (isInaccessibleIssue(targetIssue)) {
        recordReferenceDiagnostic(
          diagnostics.inaccessibleReferences,
          inaccessibleKeys,
          edge,
          'issue_inaccessible',
        );
        continue;
      }
      if (targetIssue.isPullRequest) {
        recordReferenceDiagnostic(
          diagnostics.unresolvedReferences,
          unresolvedKeys,
          edge,
          'issue_not_found',
        );
        continue;
      }

      const nextPath = [...path, edge.target];
      recordProvenancePath(edge.target, nextPath);
      await visitIssue(edge.target, nextPath);
    }
  }

  async function getReferences(
    issue: NormalizedIssue,
  ): Promise<RoadmapGraphReference[]> {
    const cached = referenceCache.get(issue.number);
    if (cached) {
      return cached;
    }
    const references = [
      ...extractTaskListReferences(issue.body),
      ...extractKeywordReferences(issue.body, { currentRepoRef }),
      ...normalizeSubIssueReferences(await loadSubIssues(issue.number)),
    ];
    referenceCache.set(issue.number, references);
    return references;
  }

  function recordNode(issue: NormalizedIssue, path: number[]) {
    const existing = nodeRecords.get(issue.number);
    const classification = classifyIssue(issue, markerPrefix);
    if (issue.number === rootIssue.number) {
      classification.kind = 'roadmap';
    }
    const depth = path.length - 1;
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return;
    }

    nodeRecords.set(issue.number, {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      classification: classification.kind,
      roadmapMarkerId: classification.roadmapMarkerId,
      autopilotSuitability: parseAutopilotSuitability(issue.body, markerPrefix),
      depth,
    });
    recordProvenancePath(issue.number, path);
  }

  function recordProvenancePath(target: number, path: number[]) {
    const pathKey = `${target}:${path.join('>')}`;
    if (pathKeys.has(pathKey)) {
      return;
    }
    pathKeys.add(pathKey);
    provenancePaths.push({ target, path });
  }

  function recordDuplicateReference(
    edge: RoadmapGraphEdge,
    firstReference: RoadmapGraphEdge,
  ) {
    const key = `${edge.source}:${edge.target}:${edge.relationship}:${edge.evidence}`;
    if (duplicateKeys.has(key)) {
      return;
    }
    duplicateKeys.add(key);
    diagnostics.duplicateReferences.push({
      source: edge.source,
      target: edge.target,
      relationship: edge.relationship,
      evidence: edge.evidence,
      firstSeenFrom: firstReference.source,
    });
  }
}

/**
 * Cross-roadmap autopilot discovery (additive `--all-roadmaps` mode).
 *
 * Discovers every OPEN roadmap root (an open issue carrying the
 * `roadmap` label OR an `<!-- {markerPrefix}-roadmap-id: ... -->`
 * marker), runs the existing single-root {@link enumerateRoadmapGraph}
 * from each root, and returns the UNION of open execution leaves. A leaf
 * reachable from several sibling roots is recorded once, carrying every
 * `sourceRoots` it is reachable from (provenance), so it is never
 * double-counted.
 *
 * Ranking (global-by-score): the union is sorted by `autopilotSuitability`
 * DESCENDING, tie-broken by issue number ASCENDING (stable). Missing or
 * out-of-range suitability is treated as the configured floor for
 * ordering, but a leaf with no coherent score never ranks above a scored
 * leaf at the same effective value — scored work always sorts first at a
 * tie. See {@link compareUnionLeaves}.
 *
 * The helper stays READ-ONLY / evidence-only: it reads issue bodies and
 * GitHub sub-issue relationships and never claims, mutates, or writes to
 * GitHub. The single-root report shape is unchanged; this union shape is
 * only produced in `--all-roadmaps` mode.
 */
export async function enumerateAllRoadmapsGraph(
  options: EnumerateAllRoadmapsGraphOptions = {},
): Promise<RoadmapGraphUnionReport> {
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  // Resolve the configured suitability floor (normalized to an integer
  // 1-5, falling back to the default when unset) once, then rank unscored
  // leaves at that configured floor.
  const floor = normalizeAutopilotSuitabilityFloor(options.floor);
  const loadOpenRoadmapRoots = options.loadOpenRoadmapRoots;
  if (typeof loadOpenRoadmapRoots !== 'function') {
    throw new Error(
      'enumerateAllRoadmapsGraph requires loadOpenRoadmapRoots()',
    );
  }

  const rootNumbers = normalizeOpenRoadmapRootNumbers(
    await loadOpenRoadmapRoots(),
  );

  const roots: RoadmapUnionRoot[] = [];
  const leafRecords = new Map<number, RoadmapUnionLeaf>();
  // Diagnostics accumulate across every per-root enumeration, deduped on
  // the same identity keys the single-root report uses so a reference
  // shared by sibling roots is reported once.
  const duplicateReferences = new Map<
    string,
    RoadmapDuplicateReferenceDiagnostic
  >();
  const cycles = new Map<string, RoadmapCycleDiagnostic>();
  const inaccessibleReferences = new Map<string, RoadmapReferenceDiagnostic>();
  const unresolvedReferences = new Map<string, RoadmapReferenceDiagnostic>();

  for (const rootNumber of rootNumbers) {
    const graph = await enumerateRoadmapGraph(rootNumber, {
      markerPrefix,
      owner: options.owner,
      repo: options.repo,
      loadIssue: options.loadIssue,
      loadSubIssues: options.loadSubIssues,
    });

    roots.push({
      number: graph.root.number,
      title: graph.root.title,
      state: graph.root.state,
      roadmapMarkerId: graph.root.roadmapMarkerId,
    });

    const executionSet = new Set(graph.executionCandidates);
    for (const node of graph.nodes) {
      if (!executionSet.has(node.number)) {
        continue;
      }
      const existing = leafRecords.get(node.number);
      if (existing) {
        if (!existing.sourceRoots.includes(graph.root.number)) {
          existing.sourceRoots.push(graph.root.number);
        }
        continue;
      }
      leafRecords.set(node.number, {
        number: node.number,
        title: node.title,
        state: node.state,
        labels: node.labels,
        // Only execution candidates reach this branch (filtered by
        // executionSet above), so the classification is always 'execution'.
        classification: 'execution',
        roadmapMarkerId: node.roadmapMarkerId,
        autopilotSuitability: node.autopilotSuitability,
        sourceRoots: [graph.root.number],
      });
    }

    mergeDiagnostic(
      duplicateReferences,
      graph.diagnostics.duplicateReferences,
      (entry) =>
        `${entry.source}:${entry.target}:${entry.relationship}:${entry.evidence}`,
    );
    mergeDiagnostic(
      cycles,
      graph.diagnostics.cycles,
      (entry) => `${entry.source}:${entry.target}:${entry.path.join('>')}`,
    );
    mergeDiagnostic(
      inaccessibleReferences,
      graph.diagnostics.inaccessibleReferences,
      (entry) =>
        `${entry.source}:${entry.target}:${entry.relationship}:${entry.reason}`,
    );
    mergeDiagnostic(
      unresolvedReferences,
      graph.diagnostics.unresolvedReferences,
      (entry) =>
        `${entry.source}:${entry.target}:${entry.relationship}:${entry.reason}`,
    );
  }

  const leaves = [...leafRecords.values()]
    .map((leaf) => ({
      ...leaf,
      sourceRoots: [...leaf.sourceRoots].sort((left, right) => left - right),
    }))
    .sort((left, right) => compareUnionLeaves(left, right, floor));

  // Opt-in (#1008): annotate the deduped union leaves once each. The per-root
  // enumerations above intentionally run without `claimState`, so each issue's
  // comments are fetched at most once here regardless of how many roots reach
  // it. Gated on `options.claimState`, so the default path adds no extra
  // GitHub API call and the union output shape stays byte-stable.
  if (options.claimState) {
    for (const leaf of leaves) {
      const annotated = await annotateLeafClaimState(
        leaf.number,
        options.claimState,
      );
      leaf.activeClaim = annotated.activeClaim;
      leaf.claimEligible = annotated.claimEligible;
    }
  }

  const scoredLeafCount = leaves.filter((leaf) =>
    isAutopilotSuitabilityScore(leaf.autopilotSuitability),
  ).length;
  const sharedLeafCount = leaves.filter(
    (leaf) => leaf.sourceRoots.length > 1,
  ).length;

  return {
    mode: 'all-roadmaps',
    roots: roots.sort(compareByNumber),
    leaves,
    diagnostics: {
      duplicateReferences: [...duplicateReferences.values()].sort(
        compareDiagnostics,
      ),
      cycles: [...cycles.values()].sort(compareCycles),
      inaccessibleReferences: [...inaccessibleReferences.values()].sort(
        compareDiagnostics,
      ),
      unresolvedReferences: [...unresolvedReferences.values()].sort(
        compareDiagnostics,
      ),
    },
    summary: {
      rootCount: roots.length,
      leafCount: leaves.length,
      scoredLeafCount,
      sharedLeafCount,
      duplicateReferenceCount: duplicateReferences.size,
      cycleCount: cycles.size,
      inaccessibleReferenceCount: inaccessibleReferences.size,
      unresolvedReferenceCount: unresolvedReferences.size,
    },
  };
}

/**
 * Global-by-score comparator for the cross-roadmap union.
 *
 * Sort key, in order:
 *   1. effective suitability DESCENDING — a coherent 1-5 score uses its
 *      own value; a missing/out-of-range score uses the configured floor
 *      so unscored pre-existing work is not buried below the floor;
 *   2. scored-before-unscored at a tie — a leaf with a coherent score
 *      never ranks below an unscored leaf at the same effective value, so
 *      "missing is treated as the configured floor" never lets unscored
 *      work jump ahead of genuinely scored work;
 *   3. issue number ASCENDING — a stable, repository-deterministic
 *      tie-break that keeps the order from thrashing between epics.
 *
 * `floor` is the configured `autopilotSuitability.floor` (already
 * normalized to an integer 1-5). The comparator stays a total order.
 */
function compareUnionLeaves(
  left: RoadmapUnionLeaf,
  right: RoadmapUnionLeaf,
  floor: number,
): number {
  const leftScored = isAutopilotSuitabilityScore(left.autopilotSuitability);
  const rightScored = isAutopilotSuitabilityScore(right.autopilotSuitability);
  // Unscored or out-of-range leaves rank at the configured floor.
  const leftEffective = leftScored
    ? (left.autopilotSuitability as number)
    : floor;
  const rightEffective = rightScored
    ? (right.autopilotSuitability as number)
    : floor;
  return (
    rightEffective - leftEffective ||
    Number(rightScored) - Number(leftScored) ||
    left.number - right.number
  );
}

function mergeDiagnostic<T>(
  store: Map<string, T>,
  entries: T[],
  keyOf: (entry: T) => string,
) {
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!store.has(key)) {
      store.set(key, entry);
    }
  }
}

function normalizeOpenRoadmapRootNumbers(roots: unknown): number[] {
  if (!Array.isArray(roots)) {
    return [];
  }
  return [
    ...new Set(
      roots
        .map((entry) => {
          if (typeof entry === 'number') {
            return entry;
          }
          return Number.parseInt(
            String((entry as { number?: unknown } | null)?.number ?? entry),
            10,
          );
        })
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ].sort((left, right) => left - right);
}

/** One leaf's resolved claim annotation (`--with-claim-state` output). */
interface LeafClaimAnnotation {
  activeClaim: LeafActiveClaim;
  claimEligible: boolean;
}

/**
 * Resolve one execution leaf's active-claim eligibility (#1008).
 *
 * Fetches the leaf issue's comments via the injected `loadComments` loader,
 * resolves the ACTIVE claim with the SHARED `resolveActiveClaim` from
 * protocol-helpers (trusted-author gated, stale-age aware), then derives
 * present/stale/eligibility. `activeClaim` is ALWAYS returned as an object
 * (Design O): `present: false` (with `claimId: null`, `agentId: null`) when no
 * trusted claim is present, `present: true` otherwise. A leaf is eligible when
 * there is NO present, non-stale, trusted-actor claim. The shared
 * `parseClaimComment` / `resolveActiveClaim` parsing is reused read-only and
 * never re-implemented here.
 *
 * Intentional limitation: this annotation resolves only NEW-format
 * `claimed-by` markers via the shared `resolveActiveClaim`. It deliberately
 * does NOT factor in legacy claim-id-less markers nor forced-handoff
 * transfers, both of which the authoritative resume/claim path handles
 * (resume-claim-routing's `resolveLegacyClaimState` and forced-handoff
 * authorization). Replicating that here would require duplicating that
 * machinery plus per-candidate permission API calls, which is out of scope
 * for this read-only discovery hint. `claimEligible` is therefore a
 * best-effort SOFT signal only; the authoritative A5 claim gate
 * (`idd-claim.instructions.md`), which DOES account for legacy markers and
 * forced handoffs, remains the real protection.
 */
export async function annotateLeafClaimState(
  issueNumber: number,
  claimState: ClaimStateResolution,
): Promise<LeafClaimAnnotation> {
  const comments = normalizeClaimComments(
    await claimState.loadComments(issueNumber),
  );
  const active = resolveActiveClaim(comments, {
    isTrustedAuthor: claimState.isTrustedAuthor,
    // The 24h math is not re-derived: when the configured stale age equals the
    // PT24H default, the shared `isStaleAt` is reused as-is;
    // otherwise the same comparison is applied with the configured age.
    isStale: (activeCreatedAt, nextCreatedAt) =>
      isClaimStaleByAge(activeCreatedAt, nextCreatedAt, claimState.staleAgeMs),
  });

  if (!active) {
    // No present trusted claim → eligible. When `--current-claim-id` is
    // supplied, `ownedByCurrentSession` is still emitted (as `false`) because
    // there is no claim id to match it; it is omitted only when no
    // `--current-claim-id` was passed.
    return {
      activeClaim: {
        present: false,
        stale: false,
        claimId: null,
        agentId: null,
        ...(claimState.currentClaimId ? { ownedByCurrentSession: false } : {}),
      },
      claimEligible: true,
    };
  }

  // Staleness of the present claim is measured against "now": a claim whose
  // createdAt is older than the configured stale age is a stale (takeover-
  // eligible) claim, mirroring resume-claim-routing's active-claim staleness.
  const stale = isClaimStaleByAge(
    active.createdAt,
    claimState.nowIso,
    claimState.staleAgeMs,
  );

  const annotation: LeafActiveClaim = {
    present: true,
    stale,
    claimId: active.claimId,
    agentId: active.agentId,
  };
  if (claimState.currentClaimId) {
    annotation.ownedByCurrentSession =
      active.claimId === claimState.currentClaimId;
  }

  // Eligible only when there is no present, NON-stale, trusted claim. A stale
  // claim is takeover-eligible, so it does not block.
  return { activeClaim: annotation, claimEligible: stale };
}

/** Coerce a loaded comment payload into the `resolveActiveClaim` event shape. */
function normalizeClaimComments(
  raw: unknown,
): { body: string; createdAt: string; author: { login: string } }[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => {
    const comment = (entry ?? {}) as {
      body?: unknown;
      createdAt?: unknown;
      created_at?: unknown;
      author?: { login?: unknown } | null;
      user?: { login?: unknown } | null;
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
 * Claim staleness by configured age. When the configured age equals the PT24H
 * policy default, the shared `isStaleAt` is reused verbatim
 * (the 24h math lives there, not here); otherwise the same millisecond
 * comparison is applied with the configured age. Mirrors
 * resume-claim-routing's `isStaleByAge`.
 */
function isClaimStaleByAge(
  activeCreatedAt: string,
  nextCreatedAt: string,
  staleAgeMs: number,
): boolean {
  if (staleAgeMs === DEFAULT_CLAIM_STALE_AGE_MS) {
    return isStaleAt(activeCreatedAt, nextCreatedAt);
  }
  const start = Date.parse(activeCreatedAt ?? '');
  const end = Date.parse(nextCreatedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return false;
  }
  return end - start >= staleAgeMs;
}

/**
 * Build the CLI-side claim-state resolution: the live comment loader plus the
 * resolved trusted-actor predicate, configured stale age, and "now". Only
 * invoked when `--with-claim-state` is passed, so the live comment fetch is
 * never wired in the default path.
 */
function buildClaimStateResolution(
  owner: string,
  repo: string,
  policy: {
    claimTiming?: { staleAge?: unknown };
    trustedMarkerActors?: unknown;
  },
  currentClaimId: string,
): ClaimStateResolution {
  const staleAgeMs =
    parseClaimStaleAgeMs(policy.claimTiming?.staleAge) ??
    DEFAULT_CLAIM_STALE_AGE_MS;
  return {
    loadComments: buildCommentLoader(owner, repo),
    isTrustedAuthor: buildTrustedAuthorPredicate(policy),
    staleAgeMs,
    nowIso: new Date().toISOString(),
    currentClaimId: String(currentClaimId ?? '').trim(),
  };
}

/**
 * Build the case-insensitive trusted-marker-author predicate for the
 * `--with-claim-state` annotation.
 *
 * Trusted actors are resolved through the shared
 * {@link resolveTrustedMarkerActors} helper so this CLI honors the
 * `IDD_TRUSTED_MARKER_ACTORS` env override exactly like every other evidence
 * helper, not just the `trustedMarkerActors` array declared in policy. The
 * resolved actors are already trimmed, lowercased, and deduped, so the
 * predicate only needs to normalize the incoming login the same way.
 *
 * When the resolved set is empty no author is trusted, so no claim resolves
 * and every leaf reads as `claimEligible: true`. This is a soft,
 * availability-preferring default for the advisory discovery hint (it does
 * NOT fail closed on eligibility): an unverifiable claim marker is simply not
 * honored. The authoritative A5 claim gate (idd-claim.instructions.md) remains
 * the real protection against acting on a contested claim.
 */
export function buildTrustedAuthorPredicate(policy: {
  trustedMarkerActors?: unknown;
}): (login: string) => boolean {
  const { actors } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: policy,
  });
  const trustedActors = new Set(actors);
  return (login) =>
    trustedActors.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
}

/** Live per-issue comment loader (the sole new GitHub API surface). */
function buildCommentLoader(owner: string, repo: string) {
  return (issueNumber: number) => {
    const comments: unknown[] = [];
    const pageSize = 100;
    for (let page = 1; ; page += 1) {
      const raw = runGh([
        'api',
        `repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
        '--jq',
        '.',
      ]).trim();
      const pageItems = raw && raw !== 'null' ? JSON.parse(raw) : [];
      if (!Array.isArray(pageItems) || pageItems.length === 0) {
        break;
      }
      comments.push(...pageItems);
      if (pageItems.length < pageSize) {
        break;
      }
    }
    return comments;
  };
}

/**
 * Parse an ISO8601 duration (`P[nD]T[nH][nM][nS]`) to ms; `null` on garbage OR
 * a non-positive total. A `PT0S` (or any zero/empty-component) duration is
 * rejected so the caller falls back to `DEFAULT_CLAIM_STALE_AGE_MS` instead of
 * configuring a 0ms stale age that would mark every claim immediately stale.
 *
 * Thin wrapper over the shared `parseIsoDurationToMs` from policy-helpers
 * (the single source of truth for ISO-8601 duration parsing, with its own
 * tests). It already returns `null` for both garbage and a non-positive total,
 * which is exactly the behavior required here. The unknown input is coerced to
 * a trimmed string first so non-string/nullish values resolve to `null`
 * (the shared parser accepts only strings).
 */
export function parseClaimStaleAgeMs(value: unknown): number | null {
  return parseIsoDurationToMs(String(value ?? '').trim());
}

export function extractRoadmapMarkerId(
  body: unknown,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): string {
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(markerPrefix)}-roadmap-id:\\s*([^\\s>]+)\\s*-->`,
    'i',
  );
  const match = regex.exec(String(body ?? ''));
  return match ? match[1] : '';
}

export function classifyIssue(
  issue: { body?: unknown; labels?: unknown },
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): RoadmapIssueClassification {
  const roadmapMarkerId = extractRoadmapMarkerId(issue.body, markerPrefix);
  const labels = normalizeLabels(issue.labels);
  if (roadmapMarkerId || labels.has('roadmap')) {
    return {
      kind: 'roadmap',
      roadmapMarkerId,
    };
  }
  return {
    kind: 'execution',
    roadmapMarkerId: '',
  };
}

export function extractTaskListReferences(
  body: unknown,
): RoadmapGraphReference[] {
  return String(body ?? '')
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.match(/^\s*-\s*\[(?: |x|X)\]\s+#(\d+)\b/u);
      if (!match) {
        return [];
      }
      const target = Number.parseInt(match[1], 10);
      return Number.isInteger(target) && target > 0
        ? [{ target, relationship: 'task-list', evidence: line.trim() }]
        : [];
    });
}

export function extractKeywordReferences(
  body: unknown,
  options: { currentRepoRef?: string; owner?: string; repo?: string } = {},
): RoadmapGraphReference[] {
  const references: RoadmapGraphReference[] = [];
  const currentRepoRef = normalizeRepoRef(
    options.currentRepoRef
      ? options.currentRepoRef.split('/')[0]
      : options.owner,
    options.currentRepoRef
      ? options.currentRepoRef.split('/')[1]
      : options.repo,
  );
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const keywordMatches = [...line.matchAll(KEYWORD_REFERENCE_REGEX)];
    for (let index = 0; index < keywordMatches.length; index += 1) {
      const match = keywordMatches[index];
      const segmentStart = (match.index ?? 0) + match[0].length;
      const segmentEnd = keywordMatches[index + 1]?.index ?? line.length;
      const segment = line.slice(segmentStart, segmentEnd);
      for (const target of extractKeywordReferenceTargets(
        segment,
        currentRepoRef,
      )) {
        if (!Number.isInteger(target) || target <= 0) {
          continue;
        }
        references.push({
          target,
          relationship: classifyKeywordRelationship(match[1]),
          evidence: line.trim(),
        });
      }
    }
  }
  return references;
}

function classifyKeywordRelationship(keyword: unknown): string {
  const normalized = String(keyword ?? '').toLowerCase();
  if (normalized.startsWith('depend') || normalized.startsWith('blocked')) {
    return 'dependency';
  }
  if (normalized.startsWith('sub')) {
    return 'sub-issue-reference';
  }
  if (normalized.startsWith('ref')) {
    return 'reference';
  }
  return 'closing-keyword';
}

function extractKeywordReferenceTargets(
  segment: unknown,
  currentRepoRef: string,
): number[] {
  const targets: number[] = [];
  let remaining = String(segment ?? '')
    .trimStart()
    .replace(/^:\s*/u, '');

  while (remaining) {
    const match = remaining.match(/^(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+))/u);
    if (!match) {
      break;
    }

    const qualifiedRepoRef = match[1]
      ? normalizeRepoRef(...(match[1].split('/') as [string, string]))
      : '';
    const target = Number.parseInt(match[2] ?? match[3] ?? '', 10);
    if (
      (!qualifiedRepoRef || qualifiedRepoRef === currentRepoRef) &&
      Number.isInteger(target) &&
      target > 0
    ) {
      targets.push(target);
    }

    remaining = remaining.slice(match[0].length);
    const separatorMatch = remaining.match(
      /^\s*(?:,\s*(?:and\s*)?|\band\b\s*)/iu,
    );
    if (!separatorMatch) {
      break;
    }
    remaining = remaining.slice(separatorMatch[0].length);
  }

  return targets;
}

function normalizeRepoRef(owner: unknown, repo: unknown): string {
  const normalizedOwner = String(owner ?? '')
    .trim()
    .toLowerCase();
  const normalizedRepo = String(repo ?? '')
    .trim()
    .toLowerCase();
  return normalizedOwner && normalizedRepo
    ? `${normalizedOwner}/${normalizedRepo}`
    : '';
}

function normalizeSubIssueReferences(
  subIssues: unknown,
): RoadmapGraphReference[] {
  return normalizeSubIssueNumbers(subIssues).map((target) => ({
    target,
    relationship: 'sub-issue',
    evidence: `GitHub sub-issue #${target}`,
  }));
}

function normalizeSubIssueNumbers(subIssues: unknown): number[] {
  if (!Array.isArray(subIssues)) {
    return [];
  }
  return [
    ...new Set(
      subIssues
        .map((entry) => {
          if (typeof entry === 'number') {
            return entry;
          }
          return Number.parseInt(
            String((entry as { number?: unknown } | null)?.number ?? entry),
            10,
          );
        })
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    issue: 0,
    allRoadmaps: false,
    owner: '',
    repo: '',
    policy: '',
    withClaimState: false,
    currentClaimId: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--issue') {
      parsed.issue = Number.parseInt(String(value ?? ''), 10);
      index += 1;
      continue;
    }
    if (token === '--all-roadmaps') {
      parsed.allRoadmaps = true;
      continue;
    }
    if (token === '--owner') {
      parsed.owner = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--repo') {
      parsed.repo = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--policy') {
      parsed.policy = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--with-claim-state') {
      parsed.withClaimState = true;
      continue;
    }
    if (token === '--current-claim-id') {
      // Only consume the next token as the id when it exists and is not itself
      // a flag, so `--current-claim-id --with-claim-state` does not swallow the
      // following flag as the id. A missing/flag value leaves currentClaimId
      // empty and the next flag is left for its own iteration.
      if (value !== undefined && !value.startsWith('--')) {
        parsed.currentClaimId = value;
        index += 1;
      }
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-roadmap-graph.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--policy <path>] [--with-claim-state] [--current-claim-id <id>]
  node scripts/discover-roadmap-graph.mjs --all-roadmaps [--owner <owner>] [--repo <repo>] [--policy <path>] [--with-claim-state] [--current-claim-id <id>]

  --issue and --all-roadmaps are mutually exclusive; exactly one is required.
  --all-roadmaps enumerates open execution leaves across every open roadmap
  root (the union), each tagged with its sourceRoots and ranked by
  autopilotSuitability (descending, tie-broken by ascending issue number).

  --with-claim-state (opt-in) annotates each OPEN execution leaf with active-
  claim eligibility: it fetches that issue's comments and resolves the active
  claim using the configured trustedMarkerActors and claimTiming.staleAge
  (default PT24H). Each annotated leaf gains (activeClaim is always an object):
    "activeClaim": { "present": bool, "stale": bool, "claimId": str|null, "agentId": str|null }
                   (present:false with claimId/agentId null = no trusted claim)
    "claimEligible": bool   (eligible = no present, non-stale, trusted claim)
  Absent the flag, NO comment API calls are made and no claim fields are
  emitted (the output shape is byte-stable).
  --current-claim-id <id> additionally sets "ownedByCurrentSession": bool on
  each activeClaim (true when the active claim's claimId equals <id>).
  NOTE: claimEligible is a best-effort SOFT discovery hint. It resolves only
  new-format claimed-by markers and intentionally does NOT account for legacy
  claim-id-less markers or forced-handoff transfers; the authoritative A5
  claim gate (idd-claim.instructions.md) remains the real protection.

Output schema (JSON mode) — --issue single-root report:
  {
    "root": { "number": 638, "title": "...", "state": "OPEN", "classification": "roadmap", "roadmapMarkerId": "..." },
    "nodes": [{ "number": 638, "title": "...", "state": "OPEN", "labels": ["roadmap"], "classification": "roadmap", "roadmapMarkerId": "...", "autopilotSuitability": null, "depth": 0 }],
    "edges": [{ "source": 638, "target": 640, "relationship": "task-list", "evidence": "- [ ] #640" }],
    "provenancePaths": [{ "target": 640, "path": [638, 640] }],
    "roadmapNodes": [],
    "executionCandidates": [640],
    "diagnostics": {
      "duplicateReferences": [],
      "cycles": [],
      "inaccessibleReferences": [],
      "unresolvedReferences": []
    },
    "summary": {
      "rootNumber": 638,
      "nodeCount": 2,
      "edgeCount": 1,
      "roadmapNodeCount": 0,
      "executionCandidateCount": 1,
      "duplicateReferenceCount": 0,
      "cycleCount": 0,
      "inaccessibleReferenceCount": 0,
      "unresolvedReferenceCount": 0,
      "maxDepth": 1
    }
  }

Output schema (JSON mode) — --all-roadmaps union report (a different
top-level shape from the single-root report above):
  {
    "mode": "all-roadmaps",
    "roots": [{ "number": 638, "title": "...", "state": "OPEN", "roadmapMarkerId": "..." }],
    "leaves": [{ "number": 640, "title": "...", "state": "OPEN", "labels": ["..."], "classification": "execution", "roadmapMarkerId": "", "autopilotSuitability": null, "sourceRoots": [638] }],
    "diagnostics": {
      "duplicateReferences": [],
      "cycles": [],
      "inaccessibleReferences": [],
      "unresolvedReferences": []
    },
    "summary": {
      "rootCount": 1,
      "leafCount": 1,
      "scoredLeafCount": 0,
      "sharedLeafCount": 0,
      "duplicateReferenceCount": 0,
      "cycleCount": 0,
      "inaccessibleReferenceCount": 0,
      "unresolvedReferenceCount": 0
    }
  }
`);
}

function normalizeIssue(issue: {
  number?: unknown;
  id?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
  pull_request?: unknown;
}): NormalizedIssue {
  return {
    number: Number.parseInt(String(issue.number ?? issue.id ?? 0), 10),
    title: String(issue.title ?? ''),
    state: String(issue.state ?? '').toUpperCase(),
    body: String(issue.body ?? ''),
    labels: normalizeLabels(issue.labels),
    isPullRequest: Boolean(issue.pull_request),
  };
}

function normalizeLabels(labelsInput: unknown): Set<string> {
  if (!labelsInput) {
    return new Set();
  }
  if (labelsInput instanceof Set) {
    return new Set([...labelsInput].map(normalizeLabelName).filter(Boolean));
  }
  if (Array.isArray(labelsInput)) {
    return new Set(
      labelsInput
        .map((label) => {
          if (typeof label === 'string') {
            return normalizeLabelName(label);
          }
          return normalizeLabelName((label as { name?: unknown } | null)?.name);
        })
        .filter(Boolean),
    );
  }
  return new Set();
}

function normalizeLabelName(label: unknown): string {
  return String(label ?? '')
    .trim()
    .toLowerCase();
}

function normalizeMarkerPrefix(markerPrefix: unknown): string {
  const normalized = String(markerPrefix ?? '').trim();
  return normalized || DEFAULT_MARKER_PREFIX;
}

async function getIssue(
  issueNumber: number,
  cache: Map<number, CachedIssue>,
  loadIssue: (issueNumber: number) => unknown,
): Promise<CachedIssue> {
  if (cache.has(issueNumber)) {
    return cache.get(issueNumber) ?? null;
  }
  const rawIssue = await loadIssue(issueNumber);
  const issue = isInaccessibleIssue(rawIssue)
    ? INACCESSIBLE_ISSUE_SENTINEL
    : rawIssue
      ? normalizeIssue(rawIssue as Parameters<typeof normalizeIssue>[0])
      : null;
  cache.set(issueNumber, issue);
  return issue;
}

function buildIssueLoader(owner: string, repo: string) {
  return async (issueNumber: number) => {
    const args = [
      'api',
      `repos/${owner}/${repo}/issues/${issueNumber}`,
      '--jq',
      '.',
    ];
    try {
      const result = runGh(args, { allowStatuses: [404] }).trim();
      if (!result || result === 'null') {
        return null;
      }
      return JSON.parse(result);
    } catch (error) {
      if (isNotFoundIssueLookupError(error)) {
        return null;
      }
      if (isInaccessibleIssueLookupError(error)) {
        return INACCESSIBLE_ISSUE_SENTINEL;
      }
      throw error;
    }
  };
}

function buildSubIssueLoader(owner: string, repo: string) {
  return async (issueNumber: number) => {
    const numbers: number[] = [];
    let after = '';

    while (true) {
      const variables: Record<string, string | number> = {
        owner,
        repo,
        number: issueNumber,
      };
      if (after) {
        variables.after = after;
      }
      const result = runGraphqlQuery(SUB_ISSUES_QUERY, variables) as {
        data?: {
          repository?: {
            issue?: {
              subIssues?: {
                nodes?: unknown;
                pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
              };
            };
          };
        };
      };
      const connection = result?.data?.repository?.issue?.subIssues;
      if (
        !connection ||
        !Array.isArray(connection.nodes) ||
        !connection.pageInfo
      ) {
        throw new Error(
          `subIssues connection missing for issue #${issueNumber}`,
        );
      }

      numbers.push(...normalizeSubIssueNumbers(connection.nodes));
      if (!connection.pageInfo.hasNextPage) {
        break;
      }
      if (!connection.pageInfo.endCursor) {
        throw new Error(
          `subIssues pagination cursor missing for issue #${issueNumber}`,
        );
      }
      after = String(connection.pageInfo.endCursor);
    }

    return [...new Set(numbers)];
  };
}

function buildOpenRoadmapRootsLoader(
  owner: string,
  repo: string,
  markerPrefix: unknown,
) {
  const prefix = normalizeMarkerPrefix(markerPrefix);
  return async () => {
    const numbers: number[] = [];
    let after = '';

    while (true) {
      const variables: Record<string, string | number> = { owner, repo };
      if (after) {
        variables.after = after;
      }
      const result = runGraphqlQuery(OPEN_ISSUES_QUERY, variables) as {
        data?: {
          repository?: {
            issues?: {
              nodes?: unknown;
              pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            };
          };
        };
      };
      const connection = result?.data?.repository?.issues;
      if (
        !connection ||
        !Array.isArray(connection.nodes) ||
        !connection.pageInfo
      ) {
        throw new Error('open issues connection missing');
      }

      for (const node of connection.nodes) {
        const issue = node as {
          number?: unknown;
          body?: unknown;
          labels?: { nodes?: unknown };
        } | null;
        const issueNumber = Number.parseInt(String(issue?.number ?? ''), 10);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          continue;
        }
        const labels = normalizeLabels(
          (issue?.labels as { nodes?: unknown } | undefined)?.nodes,
        );
        const hasRoadmapMarker = Boolean(
          extractRoadmapMarkerId(issue?.body, prefix),
        );
        if (labels.has('roadmap') || hasRoadmapMarker) {
          numbers.push(issueNumber);
        }
      }

      if (!connection.pageInfo.hasNextPage) {
        break;
      }
      if (!connection.pageInfo.endCursor) {
        throw new Error('open issues pagination cursor missing');
      }
      after = String(connection.pageInfo.endCursor);
    }

    return [...new Set(numbers)];
  };
}

function runGraphqlQuery(
  query: string,
  variables: Record<string, string | number>,
): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === '' || value === null || value === undefined) {
      continue;
    }
    const flag = typeof value === 'number' ? '-F' : '-f';
    args.push(flag, `${name}=${value}`);
  }

  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(raw || '{}') as { errors?: unknown };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(formatGraphqlErrors(parsed.errors));
    }
    return parsed;
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    const detail = stderr || (error as Error).message;
    throw new Error(`gh api graphql failed: ${detail}`);
  }
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

function ghText(args: string[]): string {
  return runGh(args).trim();
}

function runGh(
  args: string[],
  options: { allowStatuses?: number[] } = {},
): string {
  const { allowStatuses = [] } = options;

  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const rawStatus = (error as { status?: unknown } | null)?.status;
    const status = typeof rawStatus === 'number' ? rawStatus : null;
    if (status !== null && allowStatuses.includes(status)) {
      return '';
    }
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    const prefix = `gh ${args.join(' ')}`;
    const wrapped = new Error(
      stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`,
    ) as Error & { status?: number | null; stderr?: string };
    wrapped.status = status;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

function isInaccessibleIssue(
  value: unknown,
): value is InaccessibleIssueSentinel {
  return (
    (value as { __iddLookupStatus?: unknown } | null)?.__iddLookupStatus ===
    'inaccessible'
  );
}

function isInaccessibleIssueLookupError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const rawStatus = (error as { status?: unknown }).status;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  if (status !== null && INACCESSIBLE_HTTP_STATUSES.has(status)) {
    return true;
  }
  const stderr = String((error as { stderr?: unknown }).stderr ?? '');
  return /Resource not accessible|access denied|Forbidden|Unavailable for legal reasons/i.test(
    stderr,
  );
}

function isNotFoundIssueLookupError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const candidate = error as { stderr?: unknown; message?: unknown };
  const stderr = String(candidate.stderr ?? candidate.message ?? '');
  return stderr.includes('HTTP 404');
}

function isMainModule(importMetaUrl: string): boolean {
  return process.argv[1] === fileURLToPath(importMetaUrl);
}

function buildEdgeKey(edge: RoadmapGraphEdge): string {
  return `${edge.source}:${edge.target}:${edge.relationship}:${edge.evidence}`;
}

function recordReferenceDiagnostic(
  collection: RoadmapReferenceDiagnostic[],
  dedupeKeys: Set<string>,
  edge: RoadmapGraphEdge,
  reason: string,
) {
  const key = `${edge.source}:${edge.target}:${edge.relationship}:${reason}`;
  if (dedupeKeys.has(key)) {
    return;
  }
  dedupeKeys.add(key);
  collection.push({
    source: edge.source,
    target: edge.target,
    relationship: edge.relationship,
    evidence: edge.evidence,
    reason,
  });
}

function compareByNumber(
  left: { number: number },
  right: { number: number },
): number {
  return left.number - right.number;
}

function compareEdges(left: RoadmapGraphEdge, right: RoadmapGraphEdge): number {
  return (
    left.source - right.source ||
    left.target - right.target ||
    left.relationship.localeCompare(right.relationship) ||
    left.evidence.localeCompare(right.evidence)
  );
}

function comparePaths(
  left: RoadmapProvenancePath,
  right: RoadmapProvenancePath,
): number {
  return (
    left.target - right.target ||
    left.path.length - right.path.length ||
    left.path.join('>').localeCompare(right.path.join('>'))
  );
}

function compareDiagnostics(
  left: {
    source: number;
    target: number;
    relationship?: string;
    reason?: string;
  },
  right: {
    source: number;
    target: number;
    relationship?: string;
    reason?: string;
  },
): number {
  return (
    left.source - right.source ||
    left.target - right.target ||
    String(left.relationship ?? '').localeCompare(
      String(right.relationship ?? ''),
    ) ||
    String(left.reason ?? '').localeCompare(String(right.reason ?? ''))
  );
}

function compareCycles(
  left: RoadmapCycleDiagnostic,
  right: RoadmapCycleDiagnostic,
): number {
  return (
    left.source - right.source ||
    left.target - right.target ||
    left.path.length - right.path.length ||
    left.path.join('>').localeCompare(right.path.join('>'))
  );
}

function formatGraphqlErrors(errors: unknown[]): string {
  return errors
    .map((error) =>
      String(
        (error as { message?: unknown } | null)?.message ??
          'unknown GraphQL error',
      ),
    )
    .join('; ');
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
