#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-roadmap-graph.mts
//
// The scripts/discover-roadmap-graph.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveAuthoringGuardPolicy } from './authoring-label-guard.mts';
import {
  isAutopilotSuitabilityScore,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
} from './autopilot-suitability.mts';
import {
  buildRoadmapMarkerResolver,
  evaluateDiscoverReadiness,
} from './discover-readiness-check.mts';
import { type EffortHint, effortOrdinal, parseEffort } from './effort.mts';
import { GH_TEXT_LOOP_OPTIONS, ghText, withBoundedRetry } from './gh-exec.mts';
import { stripMarkdownCodeRegions } from './markdown-code.mts';
import {
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  isStaleAt,
  resolveActiveClaim,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
// GitHub's search API returns at most 1000 results for a single query. The
// open-roadmap-roots loader pins each search at this cap and warns when a
// single search returns the full cap (a possible silent truncation).
const GH_SEARCH_RESULT_CAP = 1000;
// #1136: default in-flight bound for the concurrent prefetch crawl. Each
// in-flight slot is one live `gh` subprocess (one network round-trip), so the
// bound caps parallel I/O without risking GitHub secondary rate limits. The
// default trades a comfortable speed-up against politeness; `--concurrency`
// (or the `concurrency` option) tunes it, and `1` runs the fetches serially
// (one in flight at a time).
const DEFAULT_TRAVERSAL_CONCURRENCY = 8;
/**
 * Async `gh` invocation used ONLY by the traversal hot-path loaders
 * (`buildIssueLoader` / `buildSubIssueLoader`). Unlike the blocking
 * `execFileSync` runner — which serializes even concurrent `await`s because it
 * holds the event loop — this `spawn`-based runner lets multiple `gh`
 * subprocesses run in parallel; the actual in-flight bound is enforced by the
 * prefetch crawl's `mapPool` using the resolved `concurrency` (default
 * {@link DEFAULT_TRAVERSAL_CONCURRENCY}). The non-hot-path callers (owner/repo
 * resolution, claim-state comments, `--all-roadmaps` search) keep the sync
 * runner, so their behavior is byte-unchanged.
 *
 * Stdio matches the sync runner exactly (`['ignore', 'pipe', 'pipe']`): stdin
 * is ignored so `gh` never blocks on or reads an inherited/open stdin pipe,
 * and stdout/stderr are piped for capture. Resolves with stdout on a zero
 * exit; on a non-zero exit (or spawn error) rejects with an error carrying
 * `.code` (exit status) and `.stderr`, the shape {@link wrapGhFailure} reads.
 */
function runGhCapture(args: string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectOutput);
    child.on('close', (code) => {
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }
      const error = new Error(`gh exited with code ${code}`) as Error & {
        code?: number | null;
        stderr?: string;
        stdout?: string;
      };
      error.code = code;
      error.stderr = stderr;
      error.stdout = stdout;
      rejectOutput(error);
    });
  });
}
// Policy default claim stale age (`claimTiming.staleAge`, `PT24H`). Mirrors
// the default baked into protocol-helpers' `isStaleAt`, so when the configured
// stale age equals this default the shared `isStaleAt` path is
// reused verbatim instead of re-deriving the 24h math here.
const DEFAULT_CLAIM_STALE_AGE_MS = 24 * 60 * 60 * 1000;
// Policy default claim heartbeat interval (`claimTiming.heartbeatInterval`,
// `PT12H`), used only for the diagnostic `heartbeatOverdue` annotation
// (#1433) — it never feeds the 24h stale-takeover gate above.
const DEFAULT_CLAIM_HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;
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
 *
 * `heartbeatOverdue` (#1433) is a **purely diagnostic** sibling to `stale`:
 * `true` when the latest valid `claimed-by`/heartbeat `created_at` is at or
 * past the configured `claimTiming.heartbeatInterval` relative to now, with
 * no later trusted heartbeat; `false` otherwise, including whenever
 * `present` is `false`. It is emitted unconditionally alongside
 * `present`/`stale`/`claimId`/`agentId` (no opt-in flag of its own) and NEVER
 * feeds `claimEligible` or any other gate — a heartbeat-overdue claim can
 * still be well inside the 24h stale window and must be left alone until
 * `stale` independently says otherwise (see
 * `idd-resume-stall.instructions.md` S3).
 */
export interface LeafActiveClaim {
  present: boolean;
  stale: boolean;
  claimId: string | null;
  agentId: string | null;
  heartbeatOverdue: boolean;
  ownedByCurrentSession?: boolean;
}

/**
 * One open execution leaf's A3 readiness annotation (`--with-readiness`
 * output). Present only under that opt-in flag, and only on open execution
 * leaves. Like `claimEligible` this is a soft discovery hint: the
 * A3/A4/A4.5/A5 written gates remain authoritative.
 */
export interface LeafReadiness {
  /**
   * Passes every A3 readiness filter — no `status:blocked-by-human` /
   * `status:needs-decision` / authoring-hold label, and every dependency
   * resolves to a closed issue: visible `Blocked by #N` / `Depends on #N` /
   * task-list refs and hidden `{prefix}-blocked-by` roadmap markers, exactly
   * as `evaluateDiscoverReadiness` evaluates them.
   */
  ready: boolean;
  /**
   * Sorted filter reasons (empty when `ready`); e.g. `blocked_by_open_issue:#N`,
   * `blocked_by_open_roadmap_marker:<id>`, `label:status:authoring`.
   */
  reasons: string[];
  /**
   * True when the configured authoring-hold label is **present** on this leaf.
   * Label-presence only: `--with-readiness` intentionally does not compute the
   * stale-authoring warning (it would cost a discarded per-leaf timeline
   * fetch and does not change startability — an authoring-held leaf is not
   * startable regardless of staleness).
   */
  authoringHeld: boolean;
  /**
   * Combined soft start hint: `ready` AND not claim-blocked. When claim state
   * was not also fetched (`--with-claim-state` absent), claim-eligibility is
   * unknown and treated as non-blocking, so `startable` reflects readiness
   * alone. Advisory only — never a gate.
   */
  startable: boolean;
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
  effort: EffortHint | null;
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
  /**
   * A3 readiness annotation, present only under `--with-readiness` on open
   * execution-leaf nodes. Absent on every node in the default (flag-absent)
   * path so the byte-stable output shape is unchanged.
   */
  readiness?: LeafReadiness;
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
  effort: EffortHint | null;
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
  /**
   * A3 readiness annotation, present only under `--with-readiness`. Absent on
   * every leaf in the default (flag-absent) path so the byte-stable output
   * shape is unchanged.
   */
  readiness?: LeafReadiness;
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
    // Aggregate readiness counts over the union leaves. Present only when
    // `--with-readiness` annotated them; absent otherwise (like the per-leaf
    // `readiness` field) so the flag-absent output stays byte-stable. Let a
    // swarm controller read "is there more startable work?" without iterating
    // every leaf.
    startableCount?: number;
    readyCount?: number;
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
  // Native GitHub sub-issue count from the REST `sub_issues_summary.total`, or
  // null when the field is absent (e.g. injected test issues). `0` lets the
  // traversal skip the per-node sub-issue GraphQL round-trip (#1072); null is
  // "unknown" and falls back to querying so behavior is unchanged.
  subIssueSummaryTotal: number | null;
}

interface RoadmapNodeRecord {
  number: number;
  title: string;
  state: string;
  labels: Set<string>;
  classification: 'roadmap' | 'execution';
  roadmapMarkerId: string;
  autopilotSuitability: number | null;
  effort: EffortHint | null;
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
 *
 * Exported (#1395) so `discover-orphan-filter.mts` can type its own opt-in
 * `claimState` option against this same shape when reusing
 * {@link buildClaimStateResolution} / {@link annotateLeafClaimState}.
 */
/** A value that may be returned directly or as a promise. */
type Awaitable<T> = T | Promise<T>;

export interface ClaimStateResolution {
  /**
   * Injected per-issue comment loader. Returns the issue's comment list —
   * synchronously or as a promise ({@link annotateLeafClaimState} awaits it).
   * Elements are the raw, untrusted comment entries (GitHub REST/GraphQL
   * shape, or a test fixture); {@link normalizeClaimComments} defensively
   * reads only `body` / `createdAt` (or `created_at`) / `author.login`
   * (or `user.login`) and tolerates any other element, so the element type
   * stays `unknown` rather than over-promising a shape the loader never
   * guarantees.
   */
  loadComments: (issueNumber: number) => Awaitable<readonly unknown[]>;
  /**
   * Trusted-actor predicate, resolved from `IDD_TRUSTED_MARKER_ACTORS` then
   * the configured `trustedMarkerActors`.
   */
  isTrustedAuthor: (login: string) => boolean;
  /** Configured `claimTiming.staleAge` in ms (defaults to PT24H). */
  staleAgeMs: number;
  /**
   * Configured `claimTiming.heartbeatInterval` in ms (defaults to PT12H).
   * Feeds only the diagnostic `heartbeatOverdue` annotation (#1433); never
   * the `stale` / `claimEligible` gate math above.
   */
  heartbeatIntervalMs: number;
  /** Resolution "now" (ISO8601); defaults to the wall clock. */
  nowIso: string;
  /** `--current-claim-id`, or '' when not supplied. */
  currentClaimId: string;
}

interface ClaimStateOptions {
  claimState?: ClaimStateResolution;
}

/**
 * Opt-in A3-readiness annotation inputs (the `--with-readiness` surface). The
 * loaders mirror the `--with-claim-state` injection pattern so tests stay
 * network-free; `loadIssue` and `markerPrefix` are reused from the enclosing
 * enumeration rather than rebuilt here.
 */
interface ReadinessResolution {
  /** Resolve a `{prefix}-blocked-by` roadmap-id marker to its roadmap issues. */
  findRoadmapsByMarker: (markerId: string) => unknown;
  /** Configured authoring-hold label (`issueAuthoring.authoringLabelName`). */
  authoringLabelName: string;
  /** Configured authoring stale age in ms (`issueAuthoring.authoringStaleAge`). */
  authoringStaleAgeMs: number;
  /** Configured roadmap label (`labels.roadmapLabelName`, #1273). */
  roadmapLabelName: string;
  /** Configured blocked-by-human label (`labels.blockedByHumanLabelName`, #1273). */
  blockedByHumanLabelName: string;
  /** Configured needs-decision label (`labels.needsDecisionLabelName`, #1273). */
  needsDecisionLabelName: string;
  /** Resolution "now" (ISO8601); defaults to the wall clock in the CLI. */
  nowIso: string;
}

interface ReadinessOptions {
  readiness?: ReadinessResolution;
}

interface EnumerateRoadmapGraphOptions
  extends ClaimStateOptions,
    ReadinessOptions {
  markerPrefix?: unknown;
  /** Configured `labels.roadmapLabelName` (#1273); defaults to `'roadmap'`. */
  roadmapLabelName?: unknown;
  owner?: string;
  repo?: string;
  loadIssue?: (issueNumber: number) => unknown;
  loadSubIssues?: (issueNumber: number) => unknown;
  /**
   * Max in-flight node fetches for the concurrent prefetch crawl (#1136).
   * Normalized to an integer `>= 1`, falling back to
   * {@link DEFAULT_TRAVERSAL_CONCURRENCY} when unset or invalid. `1` runs the
   * fetches serially (no parallelism). Latency-only: the report is
   * byte-identical regardless of this value — only fetch ordering and
   * wall-clock change.
   */
  concurrency?: unknown;
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
  withReadiness: boolean;
  currentClaimId: string;
  /** `--concurrency <n>` prefetch bound; `0` (unset) → normalized default. */
  concurrency: number;
  help: boolean;
}

type CachedIssue = NormalizedIssue | InaccessibleIssueSentinel | null;

if (import.meta.main) {
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
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_OPTIONS,
    );
  const policy = loadPolicy(args.policy) as {
    markerPrefix?: unknown;
    autopilotSuitability?: { floor?: unknown };
    claimTiming?: { staleAge?: unknown };
    trustedMarkerActors?: unknown;
    labels?: { roadmapLabelName?: unknown };
    discover?: { legacyRoots?: unknown };
  };

  // The claim-state annotation is strictly opt-in: only when --with-claim-state
  // is passed do we build the comment loader (the sole new GitHub API surface)
  // and resolve the trusted-actor / stale-age policy. The default path leaves
  // `claimState` undefined, so no extra fetch is made and the output is
  // byte-stable.
  const claimState = args.withClaimState
    ? buildClaimStateResolution(owner, repo, policy, args.currentClaimId)
    : undefined;

  // The readiness annotation is strictly opt-in: only when --with-readiness is
  // passed do we build the marker / label-event loaders and resolve the
  // authoring-hold policy. The default path leaves `readiness` undefined, so no
  // extra fetch is made and the output is byte-stable.
  const readiness = args.withReadiness
    ? buildReadinessResolution(owner, repo, policy)
    : undefined;

  const report = args.allRoadmaps
    ? await enumerateAllRoadmapsGraph({
        markerPrefix: policy.markerPrefix,
        roadmapLabelName: policy.labels?.roadmapLabelName,
        floor: policy.autopilotSuitability?.floor,
        owner,
        repo,
        loadIssue: buildIssueLoader(owner, repo),
        loadSubIssues: buildSubIssueLoader(owner, repo),
        loadOpenRoadmapRoots: buildOpenRoadmapRootsLoader(
          owner,
          repo,
          policy.markerPrefix,
          buildSearchIssuesRunner(),
          policy.labels?.roadmapLabelName,
          policy.discover?.legacyRoots,
        ),
        claimState,
        readiness,
        concurrency: args.concurrency,
      })
    : await enumerateRoadmapGraph(args.issue, {
        markerPrefix: policy.markerPrefix,
        roadmapLabelName: policy.labels?.roadmapLabelName,
        owner,
        repo,
        loadIssue: buildIssueLoader(owner, repo),
        loadSubIssues: buildSubIssueLoader(owner, repo),
        claimState,
        readiness,
        concurrency: args.concurrency,
      });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Normalize the traversal `concurrency` option to an integer `>= 1`, falling
 * back to {@link DEFAULT_TRAVERSAL_CONCURRENCY} for unset, non-integer, or
 * `< 1` values. `1` is preserved so callers can force the serial path.
 *
 * String input is parsed with `Number` (not `parseInt`) so a non-integer
 * string such as `"2.5"` fails the `Number.isInteger` check and falls back to
 * the default, instead of being silently truncated to `2`. This keeps CLI
 * string input and typed numeric input consistent.
 */
export function normalizeConcurrency(value: unknown): number {
  const numeric =
    typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isInteger(numeric) && numeric >= 1
    ? numeric
    : DEFAULT_TRAVERSAL_CONCURRENCY;
}

/**
 * Run `task` over `items` with at most `limit` invocations in flight at once,
 * returning results in input order. A fixed pool of workers pulls from a shared
 * cursor, so a slow item never blocks faster siblings (continuous, not
 * lock-step batches). An empty input runs no workers; the first rejection
 * propagates (mirroring the previous serial traversal's fail-closed abort).
 */
async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]);
    }
  };
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function enumerateRoadmapGraph(
  rootIssueNumber: number,
  options: EnumerateRoadmapGraphOptions = {},
): Promise<RoadmapGraphReport> {
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const roadmapLabelName = normalizeRoadmapLabelName(options.roadmapLabelName);
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

  // #1136: warm issueCache + referenceCache with a bounded-concurrency prefetch
  // crawl BEFORE the (unchanged) serial graph build below, so `visitIssue` runs
  // entirely against warm caches and issues zero I/O. The crawl visits exactly
  // the same reachable, accessible, non-PR node set the DFS expands, so the
  // resulting graph stays byte-identical to a fully serial run — only the
  // wall-clock changes.
  await prefetchReachableIssues(
    rootIssue.number,
    normalizeConcurrency(options.concurrency),
  );

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
      effort: node.effort ?? null,
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

  // Both opt-in annotation passes below operate on the open execution-leaf
  // nodes, so resolve the execution-candidate set once — only when a pass
  // actually runs, keeping the default path allocation-free and byte-stable.
  const executionCandidateSet =
    options.claimState || options.readiness
      ? new Set(executionCandidates)
      : null;

  // Opt-in (#1008): annotate each open execution-leaf node with active-claim
  // eligibility. Gated on `options.claimState` so the default path makes no
  // extra GitHub API call and the output shape stays byte-stable.
  if (options.claimState && executionCandidateSet) {
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

  // Opt-in (#1123): annotate each open execution-leaf node with its A3
  // readiness in a single batch call, after the claim loop so `startable` can
  // fold in `claimEligible`. Gated on `options.readiness` so the default path
  // makes no extra API call and the output shape stays byte-stable.
  if (options.readiness && executionCandidateSet) {
    const executionNodes = nodes.filter((node) =>
      executionCandidateSet.has(node.number),
    );
    await annotateReadiness(
      executionNodes,
      options.readiness,
      loadIssue,
      markerPrefix,
    );
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
        // #1278: a plain `Refs` back-reference from a CLOSED non-roadmap leaf
        // to an ancestor is the provenance breadcrumb the A1.5 follow-up rule
        // requires in follow-up issue bodies, not closure-order ambiguity.
        // Keep the edge itself as informational provenance and record no
        // cycle diagnostic. Back-edges from OPEN nodes, from roadmap nodes,
        // and via any stronger relationship (task-list, dependency,
        // closing-keyword, sub-issue) still record a cycle (fail closed).
        const sourceRecord = nodeRecords.get(edge.source);
        if (
          edge.relationship === 'reference' &&
          sourceRecord?.classification === 'execution' &&
          sourceRecord.state === 'CLOSED'
        ) {
          continue;
        }
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
    // #1072: skip the per-node native sub-issue GraphQL round-trip when the
    // REST `sub_issues_summary.total` proves the issue has zero native
    // sub-issues. `loadSubIssues` would return `[]` in that case, so the
    // reference set — and every downstream edge, node, provenance path, and
    // diagnostic — is byte-identical. A null total (summary absent / unknown)
    // still queries, so behavior is unchanged for callers without the field.
    const nativeSubIssues =
      issue.subIssueSummaryTotal === 0
        ? []
        : normalizeSubIssueReferences(await loadSubIssues(issue.number));
    const references = [
      ...extractTaskListReferences(issue.body),
      ...extractKeywordReferences(issue.body, { currentRepoRef }),
      ...nativeSubIssues,
    ];
    referenceCache.set(issue.number, references);
    return references;
  }

  // #1136: bounded-concurrency BFS that warms issueCache + referenceCache for
  // every reachable node before the serial graph build. It calls the same
  // getIssue / getReferences the DFS uses (so caches and the
  // subIssueSummaryTotal===0 skip are shared), but fans the frontier out
  // through `mapPool`. A genuine loader error rejects here and propagates,
  // matching the previous serial traversal's fail-closed abort; 404→null and
  // 403/410/451→sentinel still resolve without throwing.
  async function prefetchReachableIssues(
    startNumber: number,
    concurrency: number,
  ): Promise<void> {
    const scheduled = new Set<number>([startNumber]);
    let frontier: number[] = [startNumber];
    while (frontier.length > 0) {
      const targetLists = await mapPool(
        frontier,
        concurrency,
        expandForPrefetch,
      );
      const next: number[] = [];
      for (const targets of targetLists) {
        for (const target of targets) {
          if (!scheduled.has(target)) {
            scheduled.add(target);
            next.push(target);
          }
        }
      }
      frontier = next;
    }
  }

  // Fetch one node and return its reference targets for the next BFS frontier.
  // Mirrors the DFS expansion guard: only accessible, non-PR issues are
  // expanded (PRs / inaccessible / not-found contribute no children), so the
  // crawl's reachable set equals the DFS's.
  async function expandForPrefetch(issueNumber: number): Promise<number[]> {
    const issue = await getIssue(issueNumber, issueCache, loadIssue);
    if (!issue || isInaccessibleIssue(issue) || issue.isPullRequest) {
      return [];
    }
    return (await getReferences(issue)).map((reference) => reference.target);
  }

  function recordNode(issue: NormalizedIssue, path: number[]) {
    const existing = nodeRecords.get(issue.number);
    const classification = classifyIssue(issue, markerPrefix, roadmapLabelName);
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
      effort: parseEffort(issue.body, markerPrefix),
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
 * True when `error` is one of the three "this root number is not a usable
 * roadmap root" failures {@link enumerateRoadmapGraph} throws for
 * `rootNumber` itself (not found / inaccessible / is a pull request) — the
 * only cases a configured `discover.legacyRoots` entry (#1315) or a
 * race-closed label/marker root can legitimately hit. Matched by exact
 * message text against this specific root number so an unrelated error
 * that happens to share wording never matches by accident.
 *
 * Deliberately narrow (Copilot review, #1327): any other error — including
 * the "was not recorded" internal-invariant guard, or an auth/rate-limit/
 * network failure from `loadIssue`/`loadSubIssues` — is NOT expected here
 * and must propagate, so a genuine systemic failure still fails the run
 * instead of being silently downgraded to a per-root skip.
 */
function isExpectedRootEnumerationFailure(
  error: unknown,
  rootNumber: number,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === `root issue #${rootNumber} was not found` ||
    error.message === `root issue #${rootNumber} is inaccessible` ||
    error.message === `root issue #${rootNumber} is a pull request`
  );
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
    let graph: RoadmapGraphReport;
    try {
      graph = await enumerateRoadmapGraph(rootNumber, {
        markerPrefix,
        roadmapLabelName: options.roadmapLabelName,
        owner: options.owner,
        repo: options.repo,
        loadIssue: options.loadIssue,
        loadSubIssues: options.loadSubIssues,
        // #1136: each per-root enumeration prefetches its own subtree
        // concurrently; thread the same bound through.
        concurrency: options.concurrency,
      });
    } catch (error) {
      // #1315: a configured `discover.legacyRoots` entry is static,
      // human-entered config that can go stale (typo, deleted or
      // transferred issue) far more easily than a label/marker root, which
      // a live search just confirmed exists moments earlier. Skip the
      // unusable root with a NON-FATAL warning (mirrors
      // warnOnSearchResultCap's degraded-but-not-fatal precedent) instead
      // of aborting the whole union — one bad configured number must not
      // break cross-roadmap discovery for every other root.
      //
      // Narrow on purpose (Copilot review, #1327): only the three "this
      // root number is not a usable root" failures qualify. Anything else
      // — an auth/rate-limit/network error from loadIssue/loadSubIssues, a
      // GraphQL failure, or the "was not recorded" internal-invariant
      // guard — must rethrow, or a genuine systemic failure would be
      // silently masked as a per-root skip and produce an incomplete
      // report that still exits successfully.
      if (!isExpectedRootEnumerationFailure(error, rootNumber)) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `discover-roadmap-graph: --all-roadmaps root #${rootNumber} could not be enumerated (${reason}); skipping — root discovery may be incomplete.\n`,
      );
      continue;
    }

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
        effort: node.effort,
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

  // Opt-in (#1123): annotate the open union leaves with their A3 readiness in a
  // single batch call. Runs after the claim loop so `startable` can fold in
  // `claimEligible`. Gated on `options.readiness`, so the default path adds no
  // extra API call and the output shape stays byte-stable.
  // `options.loadIssue` is required for any enumeration to succeed (each
  // per-root `enumerateRoadmapGraph` above throws without it), so by here it is
  // always a function; the typeof guard narrows the optional option type for
  // the required `annotateReadiness` parameter without an unsafe cast.
  if (options.readiness && typeof options.loadIssue === 'function') {
    await annotateReadiness(
      leaves,
      options.readiness,
      options.loadIssue,
      markerPrefix,
    );
  }

  const scoredLeafCount = leaves.filter((leaf) =>
    isAutopilotSuitabilityScore(leaf.autopilotSuitability),
  ).length;
  const sharedLeafCount = leaves.filter(
    (leaf) => leaf.sourceRoots.length > 1,
  ).length;
  // Only meaningful when readiness was annotated above; the same gate keeps
  // the flag-absent summary byte-stable (both counts stay absent).
  const readinessAnnotated = Boolean(
    options.readiness && typeof options.loadIssue === 'function',
  );
  const readinessCounts = readinessAnnotated
    ? {
        startableCount: leaves.filter(
          (leaf) => leaf.readiness?.startable === true,
        ).length,
        readyCount: leaves.filter((leaf) => leaf.readiness?.ready === true)
          .length,
      }
    : {};

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
      ...readinessCounts,
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
  // Soft effort tie-breaker (after the suitability score, before the
  // lowest-issue-number fallback): within one effective-score band prefer
  // the lower-effort leaf (S < M < L). A missing/invalid hint resolves to
  // the neutral middle ordinal via effortOrdinal, so a band with no effort
  // hints stays ordered by issue number exactly as before. This never
  // crosses a score band and never drops a leaf — a large issue is still
  // selectable when it is the only ready work.
  return (
    rightEffective - leftEffective ||
    Number(rightScored) - Number(leftScored) ||
    effortOrdinal(left.effort) - effortOrdinal(right.effort) ||
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

/** An execution leaf/node that can carry the optional readiness annotation. */
interface ReadinessAnnotatable {
  number: number;
  state: string;
  claimEligible?: boolean;
  readiness?: LeafReadiness;
}

/**
 * Annotate each OPEN entry with its A3 readiness verdict (`--with-readiness`)
 * by composing the batch `evaluateDiscoverReadiness` helper over the open
 * entry numbers — one call, reusing the enclosing enumeration's `loadIssue`
 * and `markerPrefix` so no second issue loader is constructed. Closed entries
 * are skipped (only open execution work is a start candidate).
 *
 * `evaluateDiscoverReadiness` classifies every input number into `ready` or
 * `filteredOut` (an inaccessible/closed issue lands in `filteredOut` with a
 * sentinel reason), so each open entry resolves to a definite verdict. The
 * combined `startable` hint folds in `claimEligible` when `--with-claim-state`
 * also ran; otherwise claim eligibility is unknown and treated as
 * non-blocking. The suitability floor is left to the helper default because
 * the readiness classification (labels + dependencies) does not read the
 * score.
 */
async function annotateReadiness(
  entries: ReadinessAnnotatable[],
  readiness: ReadinessResolution,
  loadIssue: (issueNumber: number) => unknown,
  markerPrefix: string,
): Promise<void> {
  const openEntries = entries.filter(
    (entry) => String(entry.state).toUpperCase() === 'OPEN',
  );
  if (openEntries.length === 0) {
    return;
  }
  const summary = await evaluateDiscoverReadiness(
    openEntries.map((entry) => entry.number),
    {
      // We read only `ready` / `filteredOut[].reasons`, so the unresolvable
      // bucket and the authoring-stale `warning` (and thus its
      // `loadIssueLabelEvents` timeline fetch) are intentionally not wired —
      // `authoringHeld` is label-presence-based and needs neither.
      includeUnresolvable: false,
      loadIssue,
      findRoadmapsByMarker: readiness.findRoadmapsByMarker,
      authoringLabelName: readiness.authoringLabelName,
      authoringStaleAgeMs: readiness.authoringStaleAgeMs,
      roadmapLabelName: readiness.roadmapLabelName,
      blockedByHumanLabelName: readiness.blockedByHumanLabelName,
      needsDecisionLabelName: readiness.needsDecisionLabelName,
      markerPrefix,
      now: readiness.nowIso,
    },
  );
  const readyNumbers = new Set(summary.ready.map((entry) => entry.number));
  const reasonsByNumber = new Map(
    summary.filteredOut.map((entry) => [entry.number, entry.reasons]),
  );
  const authoringReason = `label:${readiness.authoringLabelName}`;
  for (const entry of openEntries) {
    const ready = readyNumbers.has(entry.number);
    const reasons = reasonsByNumber.get(entry.number) ?? [];
    entry.readiness = {
      ready,
      reasons,
      authoringHeld: reasons.includes(authoringReason),
      startable: ready && entry.claimEligible !== false,
    };
  }
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
    // `--current-claim-id` was passed. `heartbeatOverdue` is always `false`
    // here (#1433): with no present claim there is nothing to be overdue.
    return {
      activeClaim: {
        present: false,
        stale: false,
        claimId: null,
        agentId: null,
        heartbeatOverdue: false,
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

  // `active.createdAt` already reflects the LATEST valid claimed-by/heartbeat
  // event (resolveActiveClaim / applyClaimEvent folds every accepted
  // heartbeat's own createdAt into it), so no separate heartbeat-only scan is
  // needed to answer "no later trusted heartbeat exists" — this reuses the
  // exact same timestamp the `stale` computation above already resolved,
  // just against the shorter, purely-diagnostic heartbeat interval (#1433).
  const heartbeatOverdue = isClaimHeartbeatOverdue(
    active.createdAt,
    claimState.nowIso,
    claimState.heartbeatIntervalMs,
  );

  const annotation: LeafActiveClaim = {
    present: true,
    stale,
    claimId: active.claimId,
    agentId: active.agentId,
    heartbeatOverdue,
  };
  if (claimState.currentClaimId) {
    annotation.ownedByCurrentSession =
      active.claimId === claimState.currentClaimId;
  }

  // Eligible only when there is no present, NON-stale, trusted claim. A stale
  // claim is takeover-eligible, so it does not block. `heartbeatOverdue` NEVER
  // factors into this: it is purely diagnostic (#1433) and must not change
  // who is claim-eligible.
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
export function isClaimStaleByAge(
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
 * Whether the latest valid claimed-by/heartbeat `createdAt` is at or past the
 * configured `claimTiming.heartbeatInterval` relative to `nowIso`, with no
 * later trusted heartbeat (#1433). The caller already threads every valid
 * heartbeat's `createdAt` through `resolveActiveClaim` / `applyClaimEvent`
 * (a heartbeat replaces the active claim's `createdAt` with its own event
 * timestamp), so `activeCreatedAt` here already IS the latest valid
 * claimed-by/heartbeat event — no separate heartbeat-only comment scan is
 * needed.
 *
 * Reuses {@link isClaimStaleByAge}'s generic "duration between two ISO
 * timestamps >= configured age" comparison under a name that matches this
 * call site's intent: that function's `stale`-specific name describes its
 * primary caller, not its logic, which is a plain millisecond-difference
 * check with a same-default-value fast path. This is purely diagnostic: it
 * never feeds the 24h stale-takeover gate, only the informational
 * `heartbeatOverdue` annotation.
 */
export function isClaimHeartbeatOverdue(
  activeCreatedAt: string,
  nowIso: string,
  heartbeatIntervalMs: number,
): boolean {
  return isClaimStaleByAge(activeCreatedAt, nowIso, heartbeatIntervalMs);
}

/**
 * Build the CLI-side claim-state resolution: the live comment loader plus the
 * resolved trusted-actor predicate, configured stale age, and "now". Only
 * invoked when `--with-claim-state` is passed, so the live comment fetch is
 * never wired in the default path.
 *
 * Exported (#1395) so `discover-orphan-filter.mts`'s CLI can build the same
 * resolution from its own parsed policy/args instead of re-implementing this
 * wiring. `policy` intentionally takes the *raw* parsed config shape (as
 * returned by this file's own `loadPolicy`), not a normalized/flattened view.
 */
export function buildClaimStateResolution(
  owner: string,
  repo: string,
  policy: {
    claimTiming?: { staleAge?: unknown; heartbeatInterval?: unknown };
    trustedMarkerActors?: unknown;
  },
  currentClaimId: string,
): ClaimStateResolution {
  const staleAgeMs =
    parseClaimStaleAgeMs(policy.claimTiming?.staleAge) ??
    DEFAULT_CLAIM_STALE_AGE_MS;
  const heartbeatIntervalMs =
    parseClaimHeartbeatIntervalMs(policy.claimTiming?.heartbeatInterval) ??
    DEFAULT_CLAIM_HEARTBEAT_INTERVAL_MS;
  return {
    loadComments: buildCommentLoader(owner, repo),
    isTrustedAuthor: buildTrustedAuthorPredicate(policy),
    staleAgeMs,
    heartbeatIntervalMs,
    nowIso: new Date().toISOString(),
    currentClaimId: String(currentClaimId ?? '').trim(),
  };
}

/**
 * Build the CLI-side readiness resolution: the roadmap-marker resolver (the
 * one new GitHub API surface, an A3-authorized scoped body search) plus the
 * resolved authoring-hold policy. Only invoked when `--with-readiness` is
 * passed, so the resolver is never wired in the default path.
 */
function buildReadinessResolution(
  owner: string,
  repo: string,
  policy: { markerPrefix?: unknown },
): ReadinessResolution {
  const authoringPolicy = resolveAuthoringGuardPolicy(policy);
  const markerPrefix = normalizeMarkerPrefix(policy.markerPrefix);
  const labelsPolicy = normalizePolicyConfig(policy).labels;
  return {
    findRoadmapsByMarker: buildRoadmapMarkerResolver(owner, repo, markerPrefix),
    authoringLabelName: authoringPolicy.labelName,
    authoringStaleAgeMs: authoringPolicy.staleAgeMs,
    roadmapLabelName: labelsPolicy.roadmapLabelName,
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
    nowIso: new Date().toISOString(),
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

/**
 * Live per-issue comment loader (the sole new GitHub API surface).
 *
 * Exported (#1395) so `discover-orphan-filter.mts` can reuse the identical
 * loader instead of duplicating this pagination/`gh` wiring.
 *
 * Async (#1394) so each page's `runGh(...) + JSON.parse(...)` fetch can be
 * bounded-retried on a transient failure (e.g. truncated captured stdout
 * under heavy concurrent load). Behavior-preserving: the sole caller
 * (`annotateLeafClaimState`) already `await`s the returned value, and
 * `ClaimStateResolution.loadComments` is typed as `Awaitable<...>` (#1395)
 * to accommodate exactly this.
 */
export function buildCommentLoader(owner: string, repo: string) {
  return async (issueNumber: number) => {
    const comments: unknown[] = [];
    const pageSize = 100;
    for (let page = 1; ; page += 1) {
      const pageItems = await withBoundedRetry(async () => {
        const raw = runGh([
          'api',
          `repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
          '--jq',
          '.',
        ]).trim();
        return raw && raw !== 'null' ? JSON.parse(raw) : [];
      });
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

/**
 * Parse an ISO8601 duration (`P[nD]T[nH][nM][nS]`) to ms for
 * `claimTiming.heartbeatInterval` (#1433); `null` on garbage OR a
 * non-positive total, mirroring {@link parseClaimStaleAgeMs}'s
 * garbage/non-positive handling so the caller falls back to
 * `DEFAULT_CLAIM_HEARTBEAT_INTERVAL_MS` the same way a rejected stale age
 * falls back to `DEFAULT_CLAIM_STALE_AGE_MS`.
 */
export function parseClaimHeartbeatIntervalMs(value: unknown): number | null {
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
  const match = regex.exec(stripMarkdownCodeRegions(String(body ?? '')));
  return match ? match[1] : '';
}

export function classifyIssue(
  issue: { body?: unknown; labels?: unknown },
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
  roadmapLabelName: string = POLICY_DEFAULTS.labels.roadmapLabelName,
): RoadmapIssueClassification {
  // Re-validate even though the parameter already has a default: a caller
  // (direct or test) that explicitly passes an empty string would otherwise
  // bypass the default (parameter defaults only trigger on `undefined`) and
  // silently disable the roadmap-label check. Use a cheap non-empty-string
  // check rather than the full normalizeRoadmapLabelName()/
  // normalizePolicyConfig() — classifyIssue() runs once per node during
  // graph enumeration, so rebuilding the whole policy-defaults object here
  // would be avoidable per-node overhead; callers that need policy-level
  // normalization already do it once via normalizeRoadmapLabelName() before
  // reaching this function.
  const resolvedRoadmapLabelName =
    typeof roadmapLabelName === 'string' && roadmapLabelName.length > 0
      ? roadmapLabelName
      : POLICY_DEFAULTS.labels.roadmapLabelName;
  const roadmapMarkerId = extractRoadmapMarkerId(issue.body, markerPrefix);
  const labels = normalizeLabels(issue.labels);
  if (roadmapMarkerId || labels.has(resolvedRoadmapLabelName)) {
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
  // Match against a code-masked copy so a checkbox merely quoted inside inline
  // code or a fenced block is not walked as a real task-list edge — consistent
  // with the #1121 boundary already applied to extractRoadmapMarkerId (#1204).
  // stripMarkdownCodeRegions preserves the line count, so the masked and raw
  // lines share an index and evidence stays the raw line for any surviving edge
  // (e.g. one that shares a line with unrelated inline code).
  const rawBody = String(body ?? '');
  const rawLines = rawBody.split(/\r?\n/u);
  const maskedLines = stripMarkdownCodeRegions(rawBody).split(/\r?\n/u);
  return maskedLines.flatMap((maskedLine, index) => {
    const match = maskedLine.match(/^\s*-\s*\[(?: |x|X)\]\s+#(\d+)\b/u);
    if (!match) {
      return [];
    }
    const target = Number.parseInt(match[1], 10);
    return Number.isInteger(target) && target > 0
      ? [
          {
            target,
            relationship: 'task-list',
            evidence: (rawLines[index] ?? maskedLine).trim(),
          },
        ]
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
  // Run the keyword match AND the trailing-segment scan against a code-masked
  // copy of the body so a reference merely quoted inside inline code or a fenced
  // block is not walked as a real graph edge — consistent with the #1121
  // boundary already applied to extractRoadmapMarkerId (#1204). Only `evidence`
  // reads the raw line; stripMarkdownCodeRegions preserves the line count, so
  // the masked and raw lines share an index and evidence stays byte-identical
  // for any surviving edge that is not itself inside/adjacent to code.
  const rawBody = String(body ?? '');
  const rawLines = rawBody.split(/\r?\n/u);
  const maskedLines = stripMarkdownCodeRegions(rawBody).split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < maskedLines.length; lineIndex += 1) {
    const maskedLine = maskedLines[lineIndex];
    const rawLine = rawLines[lineIndex] ?? maskedLine;
    const keywordMatches = [...maskedLine.matchAll(KEYWORD_REFERENCE_REGEX)];
    for (let index = 0; index < keywordMatches.length; index += 1) {
      const match = keywordMatches[index];
      const segmentStart = (match.index ?? 0) + match[0].length;
      const segmentEnd = keywordMatches[index + 1]?.index ?? maskedLine.length;
      const segment = maskedLine.slice(segmentStart, segmentEnd);
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
          evidence: rawLine.trim(),
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

// Excluded from the #1446 cli-args.mts wrapper: --current-claim-id and
// --concurrency below are optional-value flags -- each may appear bare or
// take a following value, consuming the next token only when one is
// present and does not itself look like another flag. `util.parseArgs`
// cannot express this: a `string`-type option always requires exactly one
// value and a `boolean`-type option never takes one; there is no
// in-between mode.
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    issue: 0,
    allRoadmaps: false,
    owner: '',
    repo: '',
    policy: '',
    withClaimState: false,
    withReadiness: false,
    currentClaimId: '',
    concurrency: 0,
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
    if (token === '--with-readiness') {
      parsed.withReadiness = true;
      continue;
    }
    if (token === '--concurrency') {
      // Only consume the next token as the value when it exists and is not
      // itself a flag, mirroring --current-claim-id, so
      // `--concurrency --issue 700` does not swallow the following flag. A
      // missing/flag value leaves concurrency unset (0 → normalized default).
      if (value !== undefined && !value.startsWith('--')) {
        // Use Number (not parseInt) so a non-integer like "2.5" stays
        // non-integer and normalizeConcurrency falls back to the default,
        // rather than being truncated to 2.
        parsed.concurrency = Number(value);
        index += 1;
      }
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
  node scripts/discover-roadmap-graph.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--policy <path>] [--with-claim-state] [--with-readiness] [--current-claim-id <id>] [--concurrency <n>]
  node scripts/discover-roadmap-graph.mjs --all-roadmaps [--owner <owner>] [--repo <repo>] [--policy <path>] [--with-claim-state] [--with-readiness] [--current-claim-id <id>] [--concurrency <n>]

  --issue and --all-roadmaps are mutually exclusive; exactly one is required.

  --concurrency <n> (default 8) bounds how many issue fetches the traversal
  prefetch keeps in flight at once. The graph is byte-identical for any n;
  only fetch ordering and wall-clock change. Pass 1 to fetch serially.
  --all-roadmaps enumerates open execution leaves across every open roadmap
  root (the union), each tagged with its sourceRoots and ranked by
  autopilotSuitability (descending, tie-broken by ascending issue number).

  --with-claim-state (opt-in) annotates each OPEN execution leaf with active-
  claim eligibility: it fetches that issue's comments and resolves the active
  claim using the configured trustedMarkerActors, claimTiming.staleAge
  (default PT24H), and claimTiming.heartbeatInterval (default PT12H). Each
  annotated leaf gains (activeClaim is always an object):
    "activeClaim": { "present": bool, "stale": bool, "claimId": str|null, "agentId": str|null, "heartbeatOverdue": bool }
                   (present:false with claimId/agentId null = no trusted claim)
    "claimEligible": bool   (eligible = no present, non-stale, trusted claim)
  Absent the flag, NO comment API calls are made and no claim fields are
  emitted (the output shape is byte-stable).
  heartbeatOverdue is true when the latest valid claimed-by/heartbeat
  created_at is at or past claimTiming.heartbeatInterval with no later
  trusted heartbeat; false otherwise, including whenever present is false.
  It is PURELY DIAGNOSTIC: it never feeds claimEligible or any other gate — a
  heartbeat-overdue claim can still be well inside the 24h stale window.
  --current-claim-id <id> additionally sets "ownedByCurrentSession": bool on
  each activeClaim (true when the active claim's claimId equals <id>).
  NOTE: claimEligible is a best-effort SOFT discovery hint. It resolves only
  new-format claimed-by markers and intentionally does NOT account for legacy
  claim-id-less markers or forced-handoff transfers; the authoritative A5
  claim gate (idd-claim.instructions.md) remains the real protection.

  --with-readiness (opt-in) annotates each OPEN execution leaf with its A3
  startability by composing the discover-readiness-check helper (dependency
  resolution + authoring-hold). Each annotated leaf gains:
    "readiness": { "ready": bool, "reasons": [str], "authoringHeld": bool, "startable": bool }
      ready      = no blocking label + every dep closed (Blocked by #N / Depends on #N
                   / task-list refs / {prefix}-blocked-by markers)
      reasons    = sorted filter reasons (e.g. "blocked_by_open_issue:#N"); empty when ready
      startable  = ready AND not claim-blocked (folds in claimEligible when --with-claim-state
                   also ran; otherwise claim eligibility is unknown and treated as non-blocking)
  Absent the flag, NO extra API calls are made and no readiness field is emitted
  (the output shape is byte-stable). Like claimEligible this is a SOFT hint; the
  A3/A4/A4.5/A5 gates remain authoritative.

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
  (Under --with-readiness the summary also carries "startableCount" and
  "readyCount" aggregating the union leaves' readiness; both are absent
  otherwise so the flag-absent output stays byte-stable.)
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
  sub_issues_summary?: unknown;
}): NormalizedIssue {
  return {
    number: Number.parseInt(String(issue.number ?? issue.id ?? 0), 10),
    title: String(issue.title ?? ''),
    state: String(issue.state ?? '').toUpperCase(),
    body: String(issue.body ?? ''),
    labels: normalizeLabels(issue.labels),
    isPullRequest: Boolean(issue.pull_request),
    subIssueSummaryTotal: extractSubIssueSummaryTotal(issue.sub_issues_summary),
  };
}

/**
 * Read the native sub-issue count from a REST `sub_issues_summary` object.
 * Returns the non-negative integer `total`, or null when the field is absent
 * or not a coherent count — the "unknown" case that keeps the sub-issue query
 * (fail-safe), so only a proven `0` skips it.
 */
function extractSubIssueSummaryTotal(summary: unknown): number | null {
  const total = (summary as { total?: unknown } | null)?.total;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0
    ? total
    : null;
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

/**
 * Resolve the configured `labels.roadmapLabelName` (#1273), falling back to
 * the `policy-helpers.mts` default (`'roadmap'`) for an absent or invalid
 * value. Routing an already-`unknown` field through `normalizePolicyConfig`
 * (rather than hand-rolling the same non-empty-string check again) keeps the
 * validation and the default in the single source of truth.
 */
function normalizeRoadmapLabelName(roadmapLabelName: unknown): string {
  return normalizePolicyConfig({ labels: { roadmapLabelName } }).labels
    .roadmapLabelName;
}

/**
 * Resolve the configured `discover.legacyRoots` (issue numbers of legacy
 * roadmap roots that predate the `roadmap` label / `roadmap-id` marker),
 * falling back to the `policy-helpers.mts` default (`[]`) for an absent or
 * invalid value. Same routing-through-`normalizePolicyConfig` shape as
 * {@link normalizeRoadmapLabelName}, so the fail-safe parsing stays in the
 * single source of truth.
 */
function normalizeLegacyRoots(legacyRoots: unknown): readonly number[] {
  return normalizePolicyConfig({ discover: { legacyRoots } }).discover
    .legacyRoots;
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

/**
 * Live per-issue loader for the traversal hot path.
 *
 * Bounded-retried (#1394): the `runGhAsync(...) + JSON.parse(...)` body runs
 * inside {@link withBoundedRetry} so a transient hiccup — including a
 * truncated-stdout JSON parse failure — gets up to 2 additional fresh `gh`
 * round-trips before this loader gives up. `isRetryable` reuses the same
 * `isNotFoundIssueLookupError` / `isInaccessibleIssueLookupError` pair the
 * outer `catch` already classifies with, so a genuine 404 or access-style
 * failure is still recognized on the FIRST attempt (retried zero times,
 * exactly like before this change) and still reaches the outer `catch`
 * below unchanged.
 */
export function buildIssueLoader(owner: string, repo: string) {
  return async (issueNumber: number) => {
    const args = [
      'api',
      `repos/${owner}/${repo}/issues/${issueNumber}`,
      '--jq',
      '.',
    ];
    try {
      return await withBoundedRetry(
        async () => {
          const result = (
            await runGhAsync(args, { allowStatuses: [404] })
          ).trim();
          if (!result || result === 'null') {
            return null;
          }
          return JSON.parse(result);
        },
        {
          isRetryable: (error) =>
            !isNotFoundIssueLookupError(error) &&
            !isInaccessibleIssueLookupError(error),
        },
      );
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

/**
 * Live sub-issue loader for the traversal hot path.
 *
 * Bounded-retried (#1394): each page's `runGraphqlQuery(...)` call runs
 * inside {@link withBoundedRetry} with the default retry-everything
 * classifier — unlike {@link buildIssueLoader}, this loader has no
 * pre-existing REST-status-based classification to preserve, and every
 * failure `runGraphqlQuery` can produce today (a transient truncated-stdout
 * parse failure, a reported GraphQL `errors[]` entry, or a process-exec
 * failure) already rethrows unclassified. A genuinely persistent failure
 * (e.g. an inaccessible parent issue) still rethrows, just after up to 2
 * extra bounded round-trips instead of 0 — a small, deliberate latency cost,
 * not a fail-closed regression. The connection/cursor-shape checks below
 * stay un-retried on purpose: they only fire once `runGraphqlQuery` already
 * resolved without a transport/parse error, so retrying them would not
 * change the outcome.
 */
export function buildSubIssueLoader(owner: string, repo: string) {
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
      const result = (await withBoundedRetry(() =>
        runGraphqlQuery(SUB_ISSUES_QUERY, variables),
      )) as {
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

/**
 * Live open-roadmap-roots loader (#1017): search-narrowed root discovery.
 *
 * Replaces the previous full open-issue scan (which fetched every open
 * issue's `body` plus up to 100 labels just to detect a root) with two
 * cheap server-side searches whose union is the SAME open-root set:
 *
 *   1. Label roots — `gh search issues --label <roadmapLabelName> --state
 *      open` (the configured `labels.roadmapLabelName`, #1273; defaults to
 *      `roadmap`) returns every open issue carrying that label. These are
 *      roots by label with NO body inspection needed; the old scan's
 *      `labels.has(roadmapLabelName)` branch is reproduced exactly (the
 *      GitHub search `--label` qualifier is a case-insensitive exact-name
 *      match, as is the `normalizeLabels`-backed `Set.has(...)` it
 *      replaces).
 *   2. Marker-only roots — `gh search issues --match body "<...>roadmap-id"
 *      --state open` narrows to open issues whose body text contains the
 *      `idd-skill-roadmap-id`-style marker token, then RE-CONFIRMS each
 *      candidate with the same `extractRoadmapMarkerId(body, prefix)` regex
 *      the old scan used (the search already returns the body, so no extra
 *      per-issue fetch is made). Only confirmed markers are kept, so a
 *      non-marker text hit on the token never inflates the root set.
 *   3. Configured legacy roots (#1315) — the `discover.legacyRoots` policy
 *      array (issue numbers), for roots that predate both signals above
 *      (e.g. an ad-hoc umbrella convention adopted before IDD). No extra
 *      search or fetch: the numbers are unioned in directly, and each still
 *      goes through the normal per-root {@link enumerateRoadmapGraph} fetch
 *      downstream, so a stale or now-closed configured root is handled the
 *      same way a race-closed label/marker root already is.
 *
 * The candidate sets are unioned and deduped by number, then sorted
 * ascending. The output is the identical `number[]` (deduped, ascending) the
 * previous scan returned, so the downstream union/provenance/ranking is
 * byte-stable.
 *
 * Result-cap boundary: `gh search` is hard-capped at
 * {@link GH_SEARCH_RESULT_CAP} results per query. When a single label or
 * body-marker search returns the full cap it may have been truncated, so a
 * repo with >= {@link GH_SEARCH_RESULT_CAP} hits could silently yield an
 * incomplete root set. The loader emits a NON-FATAL one-line WARNING to stderr
 * in that case (see {@link warnOnSearchResultCap}) rather than aborting — the
 * body-marker search can legitimately match many re-confirmed-and-dropped
 * prose mentions, so a hard error would over-abort. The JSON report itself
 * goes to stdout, so the stderr warning never corrupts it.
 *
 * Boundary (documented parity note): the marker search uses GitHub's
 * full-text body index. The label search is exact and complete on its own,
 * so every LABELED root is always found regardless of the marker index. A
 * marker-ONLY root (no `roadmap` label, marker only in the body) is found
 * when the body-text index surfaces the broad `roadmap-id` token, which the
 * `re`-confirm step then verifies — this is the only path that depends on
 * the search index rather than an exact qualifier. The IDD authoring path
 * applies the `roadmap` label to roadmap roots, so in practice marker-only
 * roots are covered by the label search; the marker search is the additive
 * safety net for unlabeled markers.
 */
export function buildOpenRoadmapRootsLoader(
  owner: string,
  repo: string,
  markerPrefix: unknown,
  searchIssues: SearchIssuesFn = buildSearchIssuesRunner(),
  roadmapLabelName?: unknown,
  legacyRoots?: unknown,
) {
  const prefix = normalizeMarkerPrefix(markerPrefix);
  const label = normalizeRoadmapLabelName(roadmapLabelName);
  const configuredLegacyRoots = normalizeLegacyRoots(legacyRoots);
  return async () => {
    // 3. Configured legacy roots: seeded directly into the Set ahead of the
    //    two searches below so they dedupe against label/marker roots for
    //    free; see the loader's doc comment for why no extra fetch is made.
    const numbers = new Set<number>(configuredLegacyRoots);

    // 1. Label roots: roadmap-labeled open issues are roots by label.
    const labelResults = searchIssues({
      owner,
      repo,
      label,
      fields: ['number'],
    });
    warnOnSearchResultCap(labelResults, 'label');
    for (const issue of labelResults) {
      const issueNumber = normalizeSearchIssueNumber(issue);
      if (issueNumber !== null) {
        numbers.add(issueNumber);
      }
    }

    // 2. Marker-only roots: narrow to open issues whose body carries the
    //    marker token, then re-confirm with the exact regex on the body the
    //    search already returned (no extra per-issue body fetch).
    const markerResults = searchIssues({
      owner,
      repo,
      matchBody: `${prefix}-roadmap-id`,
      fields: ['number', 'body'],
    });
    warnOnSearchResultCap(markerResults, 'body-marker');
    for (const issue of markerResults) {
      const issueNumber = normalizeSearchIssueNumber(issue);
      if (issueNumber === null) {
        continue;
      }
      const body = (issue as { body?: unknown } | null)?.body;
      if (extractRoadmapMarkerId(body, prefix)) {
        numbers.add(issueNumber);
      }
    }

    // Ascending, deduped — matches the documented `number[]` contract.
    return [...numbers].sort((left, right) => left - right);
  };
}

/**
 * GitHub's search API caps a single query at 1000 results
 * ({@link GH_SEARCH_RESULT_CAP}). When a root search returns the full cap it
 * may have been truncated, so a repo with >= 1000 label or marker-token hits
 * could silently yield an incomplete root set.
 *
 * This is NON-FATAL: the body-marker search can legitimately match many prose
 * mentions that are re-confirmed and dropped, so a hard error would over-abort.
 * Instead emit one clear WARNING line to STDERR (the JSON report goes to
 * stdout, so stderr keeps the report stream clean) and continue. Exported for
 * the focused loader test that asserts the warning fires.
 */
export function warnOnSearchResultCap(
  results: unknown[],
  searchKind: 'label' | 'body-marker',
): void {
  if (Array.isArray(results) && results.length >= GH_SEARCH_RESULT_CAP) {
    process.stderr.write(
      `discover-roadmap-graph: --all-roadmaps root search hit the ${GH_SEARCH_RESULT_CAP}-result cap (${searchKind}); root discovery may be incomplete on this scale.\n`,
    );
  }
}

/** One `gh search issues` query, narrowed to a candidate root set. */
export interface SearchIssuesQuery {
  owner: string;
  repo: string;
  /** Exact `--label` qualifier (open issues carrying this label). */
  label?: string;
  /** Free-text token restricted to the issue body (`--match body`). */
  matchBody?: string;
  /** Requested `--json` fields. */
  fields: string[];
}

export type SearchIssuesFn = (query: SearchIssuesQuery) => unknown[];

/** Coerce a `gh search issues` JSON entry's number to a positive integer. */
function normalizeSearchIssueNumber(issue: unknown): number | null {
  const issueNumber = Number.parseInt(
    String((issue as { number?: unknown } | null)?.number ?? ''),
    10,
  );
  return Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/**
 * Build the live `gh search issues` runner used by the open-roadmap-roots
 * loader. Each call issues one read-only server-side search; the search API
 * caps a single query at {@link GH_SEARCH_RESULT_CAP} results, so the limit is
 * pinned at that cap (the loader warns when a search returns the full cap).
 * Pull requests are excluded by default (`--include-prs` is never passed),
 * matching the old scan which only ever saw issues from the issues
 * connection.
 */
function buildSearchIssuesRunner(): SearchIssuesFn {
  return ({ owner, repo, label, matchBody, fields }) => {
    const args = [
      'search',
      'issues',
      '--repo',
      `${owner}/${repo}`,
      '--state',
      'open',
      '--limit',
      String(GH_SEARCH_RESULT_CAP),
      '--json',
      fields.join(','),
    ];
    if (label) {
      args.push('--label', label);
    }
    if (matchBody) {
      // Restrict the free-text query to the body field, then pass the token
      // as the positional search query.
      args.push('--match', 'body', matchBody);
    }
    const raw = runGh(args).trim();
    const parsed = raw && raw !== 'null' ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  };
}

/**
 * Async GraphQL runner for the traversal sub-issue loader. Its sole caller
 * (`buildSubIssueLoader`) is already async, so the runner uses the non-blocking
 * `execFile` path — letting several sub-issue queries run in parallel under the
 * prefetch crawl — while keeping the exact arg construction, error-array
 * detection, and `gh api graphql failed: …` wrapping of the previous sync form.
 */
async function runGraphqlQuery(
  query: string,
  variables: Record<string, string | number>,
): Promise<unknown> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === '' || value === null || value === undefined) {
      continue;
    }
    const flag = typeof value === 'number' ? '-F' : '-f';
    args.push(flag, `${name}=${value}`);
  }

  try {
    const stdout = await runGhCapture(args);
    const parsed = JSON.parse(stdout.trim() || '{}') as { errors?: unknown };
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

/**
 * Normalize a failed-`gh` error's exit status to a number.
 *
 * The synchronous `execFileSync` runner exposes the process exit code on
 * `.status`; the promisified `execFile` runner exposes it on `.code`. Read
 * `.status` first (sync), then fall back to `.code` (async), keeping only a
 * numeric value so a spawn-error string code (e.g. `ENOENT`) resolves to
 * `null` exactly as the previous sync-only path did.
 */
function resolveGhExitStatus(error: unknown): number | null {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  const rawStatus = candidate?.status ?? candidate?.code;
  return typeof rawStatus === 'number' ? rawStatus : null;
}

/**
 * Wrap a failed-`gh` error into the canonical `{ status, stderr }` shape that
 * the issue-lookup classifiers (`isNotFoundIssueLookupError` /
 * `isInaccessibleIssueLookupError`) read, so the sync and async runners produce
 * byte-identical errors. Returns `''` when the exit status is tolerated
 * (`allowStatuses`); otherwise throws the wrapped error.
 */
function wrapGhFailure(
  error: unknown,
  args: string[],
  allowStatuses: number[],
): string {
  const status = resolveGhExitStatus(error);
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
    return wrapGhFailure(error, args, allowStatuses);
  }
}

/**
 * Async sibling of {@link runGh} used only by the traversal hot-path loaders
 * (`buildIssueLoader` / `buildSubIssueLoader`), so the bounded prefetch crawl
 * can keep several `gh` subprocesses in flight. Behaviorally identical to
 * {@link runGh}: same tolerated-status handling and the same wrapped-error
 * shape (via {@link wrapGhFailure}).
 */
async function runGhAsync(
  args: string[],
  options: { allowStatuses?: number[] } = {},
): Promise<string> {
  const { allowStatuses = [] } = options;

  try {
    const stdout = await runGhCapture(args);
    return stdout;
  } catch (error) {
    return wrapGhFailure(error, args, allowStatuses);
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
