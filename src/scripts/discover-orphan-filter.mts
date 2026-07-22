#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-orphan-filter.mts
//
// The scripts/discover-orphan-filter.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildAuthoringLabelWarning,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mts';
import {
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
  rankAndRouteBySuitability,
} from './autopilot-suitability.mts';
import {
  extractBlockedByIssueNumbers,
  extractDependencyIssueNumbers,
  isParentEpicIssue,
} from './discover-readiness-check.mts';
import {
  annotateLeafClaimState,
  buildClaimStateResolution,
  type ClaimStateResolution,
  type LeafActiveClaim,
} from './discover-roadmap-graph.mts';
import { type EffortHint, effortOrdinal, parseEffort } from './effort.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { createMarkerRegex } from './marker-regex.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';

/** Reasons that keep an issue out of the orphan candidate list. */
export type OrphanFilteredReason =
  | 'roadmap_marker'
  | 'blocked_by_marker'
  | 'blocked_label'
  | 'authoring_label'
  | 'blocked_by_open_reference'
  | 'open_dependency_reference'
  | 'unresolvable_reference';

/** Classification verdict for one issue in the orphan filter. */
export type OrphanClassification =
  | {
      orphan: true;
      reason: 'orphan' | 'blocked_references_closed';
      details?: undefined;
    }
  | {
      orphan: false;
      reason: 'roadmap_marker' | 'blocked_by_marker';
      details?: undefined;
    }
  | {
      orphan: false;
      reason: 'blocked_label' | 'authoring_label';
      details: string;
    }
  | { orphan: false; reason: 'blocked_by_open_reference'; details: number }
  | { orphan: false; reason: 'open_dependency_reference'; details: number }
  | { orphan: false; reason: 'unresolvable_reference'; details: number[] };

interface OrphanIssueInput {
  number: number;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  labelEvents?: unknown;
  body?: unknown;
  url?: unknown;
}

interface ClassifyIssueOptions {
  issueStateByNumber: Map<number, string>;
  fetchIssueStateByNumber: (issueNumber: number) => string;
  markerPrefix?: unknown;
  authoringLabelName?: unknown;
  blockedByHumanLabelName?: unknown;
  needsDecisionLabelName?: unknown;
  roadmapLabelName?: unknown;
  /**
   * Lookup used **only** to resolve an open `Depends on #NNN` / task-list
   * dependency reference's title/labels for the parent-epic exemption
   * (#1536) — never for `Blocked by` references, which have no exemption,
   * matching A3's own asymmetry in `discover-readiness-check.mts`. A
   * reference absent from this map (or the map itself absent) fails
   * closed: treated as not epic-exempt, so it still blocks.
   */
  openIssueDetailsByNumber?: Map<number, { title: unknown; labels: unknown }>;
}

interface FilterOrphanIssuesOptions {
  issueStateByNumber?: Iterable<[number, string]>;
  fetchIssueStateByNumber?: (issueNumber: number) => string;
  fetchLabelEventsByIssueNumber?: (issueNumber: number) => unknown[];
  markerPrefix?: unknown;
  authoringLabelName?: unknown;
  blockedByHumanLabelName?: unknown;
  needsDecisionLabelName?: unknown;
  roadmapLabelName?: unknown;
  authoringStaleAgeMs?: number;
  autopilotSuitabilityFloor?: number;
  autopilotSuitabilityEnabled?: boolean;
  autopilot?: boolean;
  now?: Date | string;
  /**
   * Opt-in active-claim annotation (`--with-claim-state`, #1395). Gated the
   * same way as `discover-roadmap-graph`: absent means NO extra GitHub API
   * calls and no claim fields on any candidate, keeping the default output
   * byte-stable.
   */
  claimState?: ClaimStateResolution;
}

interface FilteredIssueEntry {
  number: number;
  title: unknown;
  state: unknown;
  reason: OrphanFilteredReason;
  details: string | number | number[] | null;
  url: unknown;
}

interface OrphanCandidate {
  number: number;
  title: unknown;
  state: unknown;
  reason: string;
  url: unknown;
  autopilotSuitability: number | null;
  effort: EffortHint | null;
  /**
   * Active-claim annotation, present only under `--with-claim-state` (#1395),
   * mirroring `discover-roadmap-graph`'s `RoadmapGraphNode.activeClaim` shape
   * exactly (Design O): `present: false` (with `claimId: null`,
   * `agentId: null`) means no trusted claim is present, `present: true` means
   * one exists (possibly stale). Absent in the default (flag-absent) path so
   * the byte-stable output shape is unchanged.
   */
  activeClaim?: LeafActiveClaim;
  /**
   * Derived eligibility: `true` when no present, non-stale, trusted-actor
   * claim blocks this candidate. Present only under `--with-claim-state`.
   */
  claimEligible?: boolean;
}

interface ParsedArgs {
  owner: string;
  repo: string;
  policy: string;
  pr: number | null;
  help: boolean;
  now: string;
  autopilot: boolean;
  withClaimState: boolean;
  currentClaimId: string;
}

if (import.meta.main) {
  await runCli();
}

/**
 * Collect the visible `Blocked by #N` references in `body`. Delegates to the
 * readiness composer's `extractBlockedByIssueNumbers` (#1311) instead of a
 * second inline "Blocked by" regex, so this filter and the readiness gate
 * share one dependency-line primitive — including its colon tolerance
 * (`Blocked by: #123`), blockquote/list-bullet prefix tolerance, and
 * code-region stripping.
 */
export function extractBlockedByReferences(body: unknown): number[] {
  return extractBlockedByIssueNumbers(String(body ?? ''));
}

export function getOrphanFirstPolicy(config: unknown): string {
  if (!config || typeof config !== 'object') {
    return 'none';
  }

  const commands = (config as { commands?: unknown }).commands;
  if (
    commands &&
    typeof commands === 'object' &&
    typeof (commands as Record<string, unknown>)['orphan-first-policy'] ===
      'string'
  ) {
    return (commands as Record<string, string>)['orphan-first-policy'];
  }

  const orphanFirstPolicy = (config as { orphanFirstPolicy?: unknown })
    .orphanFirstPolicy;
  if (typeof orphanFirstPolicy === 'string') {
    return orphanFirstPolicy;
  }

  return 'none';
}

export function classifyIssue(
  issue: OrphanIssueInput,
  options: ClassifyIssueOptions,
): OrphanClassification {
  const labels = new Set(normalizeLabels(issue.labels));
  const body = String(issue.body ?? '');
  const markerPrefix = normalizeMarkerPrefix(options.markerPrefix);
  const authoringLabelName = normalizeAuthoringLabelName(
    options.authoringLabelName,
  );
  const blockedByHumanLabelName = normalizeBlockedByHumanLabelName(
    options.blockedByHumanLabelName,
  );
  const needsDecisionLabelName = normalizeNeedsDecisionLabelName(
    options.needsDecisionLabelName,
  );
  const roadmapMarkerRegex = createMarkerRegex(markerPrefix, 'roadmap-id');
  const blockedMarkerRegex = createMarkerRegex(markerPrefix, 'blocked-by');

  if (roadmapMarkerRegex.test(body)) {
    return { orphan: false, reason: 'roadmap_marker' };
  }

  if (blockedMarkerRegex.test(body)) {
    return { orphan: false, reason: 'blocked_by_marker' };
  }

  const blockedLabels = new Set([
    blockedByHumanLabelName,
    needsDecisionLabelName,
  ]);
  const blockedLabel = [...labels].find((label) => blockedLabels.has(label));
  if (blockedLabel) {
    return { orphan: false, reason: 'blocked_label', details: blockedLabel };
  }

  if (labels.has(authoringLabelName)) {
    return {
      orphan: false,
      reason: 'authoring_label',
      details: authoringLabelName,
    };
  }

  // Two independent reference families, matching A3's own dependency check
  // in `discover-readiness-check.mts` (#1536): visible `Blocked by #NNN`
  // lines (a hard sequential dependency, no exemption) and `Depends on
  // #NNN` / task-list dependency references (which exempt an open parent
  // epic / aggregate issue, mirroring `isParentEpicIssue`). A0-O passes
  // survivors directly to A3.5 and skips A3 entirely, so without this
  // second family a helper-driven run could select an orphan whose only
  // open blocker is a dependency reference, even though the roadmap path
  // would already filter it out. `Blocked by` is checked first (matching
  // the original single-list order) so an issue that carries both kinds
  // reports the same `blocked_by_open_reference` / `unresolvable_reference`
  // reason it always has when that reference alone already blocks.
  const blockedRefs = extractBlockedByReferences(body);
  const dependencyRefs = extractDependencyIssueNumbers(body);
  if (blockedRefs.length === 0 && dependencyRefs.length === 0) {
    return { orphan: true, reason: 'orphan' };
  }

  const unresolved: number[] = [];
  let anyReferenceNonBlocking = false;

  for (const ref of blockedRefs) {
    const state = resolveIssueState(
      ref,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    );
    if ((state ?? '').toUpperCase() === 'OPEN') {
      return {
        orphan: false,
        reason: 'blocked_by_open_reference',
        details: ref,
      };
    }
    if (state === 'UNRESOLVABLE') {
      unresolved.push(ref);
    } else {
      anyReferenceNonBlocking = true;
    }
  }

  for (const ref of dependencyRefs) {
    const state = resolveIssueState(
      ref,
      options.issueStateByNumber,
      options.fetchIssueStateByNumber,
    );
    if ((state ?? '').toUpperCase() === 'OPEN') {
      if (isDependencyEpicExempt(ref, options)) {
        anyReferenceNonBlocking = true;
        continue;
      }
      return {
        orphan: false,
        reason: 'open_dependency_reference',
        details: ref,
      };
    }
    if (state === 'UNRESOLVABLE') {
      unresolved.push(ref);
    } else {
      anyReferenceNonBlocking = true;
    }
  }

  if (unresolved.length > 0) {
    return {
      orphan: false,
      reason: 'unresolvable_reference',
      details: [...new Set(unresolved)],
    };
  }

  return anyReferenceNonBlocking
    ? { orphan: true, reason: 'blocked_references_closed' }
    : { orphan: true, reason: 'orphan' };
}

/**
 * Resolve whether an **open** dependency reference is exempt as a parent
 * epic / aggregate issue (#1536), reusing `isParentEpicIssue` from
 * `discover-readiness-check.mts` rather than re-implementing the exemption.
 * Only ever consulted for `Depends on` / task-list references, never for
 * `Blocked by` references, matching A3's asymmetry. Fails closed (not
 * exempt) when `openIssueDetailsByNumber` is absent or does not carry the
 * referenced issue's details.
 */
function isDependencyEpicExempt(
  ref: number,
  options: ClassifyIssueOptions,
): boolean {
  const detail = options.openIssueDetailsByNumber?.get(ref);
  if (!detail) {
    return false;
  }
  return isParentEpicIssue(
    {
      title: String(detail.title ?? ''),
      labels: new Set(normalizeLabels(detail.labels)),
    },
    normalizeRoadmapLabelName(options.roadmapLabelName),
  );
}

export async function filterOrphanIssues(
  issues: OrphanIssueInput[],
  options: FilterOrphanIssuesOptions = {},
) {
  const issueStateByNumber = new Map(options.issueStateByNumber ?? []);
  const fetchIssueStateByNumber =
    typeof options.fetchIssueStateByNumber === 'function'
      ? options.fetchIssueStateByNumber
      : () => 'UNRESOLVABLE';
  const filtered: Record<OrphanFilteredReason, FilteredIssueEntry[]> = {
    roadmap_marker: [],
    blocked_by_marker: [],
    blocked_label: [],
    authoring_label: [],
    blocked_by_open_reference: [],
    open_dependency_reference: [],
    unresolvable_reference: [],
  };
  const orphans: OrphanCandidate[] = [];
  const unresolvable: {
    issue: number;
    reference: number;
    reason: string;
  }[] = [];
  const warnings: NonNullable<ReturnType<typeof buildAuthoringLabelWarning>>[] =
    [];
  // Self-batch lookup for the dependency parent-epic exemption (#1536): in
  // the CLI wiring `issues` is always the full open-issue batch
  // (`fetchOpenIssues`), so any `Depends on` / task-list reference that
  // resolves OPEN is guaranteed to already be present here — zero extra
  // GitHub API calls. A reference outside this batch (e.g. a partial list
  // passed directly to `filterOrphanIssues`, such as in a test) fails
  // closed via `isDependencyEpicExempt`'s own absent-entry handling.
  const openIssueDetailsByNumber = new Map(
    issues.map(
      (candidate) =>
        [
          candidate.number,
          { title: candidate.title, labels: candidate.labels },
        ] as const,
    ),
  );

  for (const issue of issues) {
    const result = classifyIssue(issue, {
      issueStateByNumber,
      fetchIssueStateByNumber,
      markerPrefix: options.markerPrefix,
      authoringLabelName: options.authoringLabelName,
      blockedByHumanLabelName: options.blockedByHumanLabelName,
      needsDecisionLabelName: options.needsDecisionLabelName,
      roadmapLabelName: options.roadmapLabelName,
      openIssueDetailsByNumber,
    });

    if (result.reason === 'unresolvable_reference') {
      for (const number of result.details ?? []) {
        unresolvable.push({
          issue: issue.number,
          reference: number,
          reason: 'issue-not-found-or-inaccessible',
        });
      }
    }
    if (result.reason === 'authoring_label') {
      const warning = buildAuthoringLabelWarning({
        issueNumber: issue.number,
        labelName: result.details,
        labelEvents: resolveIssueLabelEvents(
          issue,
          options.fetchLabelEventsByIssueNumber,
        ),
        now: options.now ?? new Date(),
        staleAgeMs: options.authoringStaleAgeMs ?? 4 * 60 * 60 * 1000,
      });
      if (warning) {
        warnings.push(warning);
      }
    }

    if (result.orphan) {
      orphans.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        reason: result.reason,
        url: issue.url ?? '',
        autopilotSuitability: parseAutopilotSuitability(
          issue.body,
          typeof options.markerPrefix === 'string'
            ? options.markerPrefix
            : undefined,
        ),
        effort: parseEffort(
          issue.body,
          typeof options.markerPrefix === 'string'
            ? options.markerPrefix
            : undefined,
        ),
      });
      continue;
    }

    const entry: FilteredIssueEntry = {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      reason: result.reason,
      details: result.details ?? null,
      url: issue.url ?? '',
    };
    filtered[result.reason].push(entry);
  }

  // Opt-in (#1395): annotate each orphan candidate with active-claim
  // eligibility, mirroring `discover-roadmap-graph`'s own sequential
  // per-leaf loop. Gated on `options.claimState` so the default path makes
  // no extra GitHub API call and the output shape stays byte-stable. Runs
  // before the ranking/routing split below so both the ranked `orphans` and
  // `routed_to_human` partitions carry the annotation (they share the same
  // object references; `rankAndRouteBySuitability` only reorders/filters).
  if (options.claimState) {
    const claimState = options.claimState;
    for (const orphan of orphans) {
      const annotated = await annotateLeafClaimState(orphan.number, claimState);
      orphan.activeClaim = annotated.activeClaim;
      orphan.claimEligible = annotated.claimEligible;
    }
  }

  // Rank the orphan candidate list by authored autopilot-suitability
  // score. Pre-sort by the soft effort tie-breaker (lower effort first,
  // with a missing hint at the neutral middle) and then issue number, so
  // the stable score sort below resolves equal scores by effort and then
  // lowest number (the Step 2 tie-breaks) rather than by API fetch order.
  // Below-floor routing is opt-in (autopilot runs only): in attended
  // discovery the low-score issues stay selectable, just ranked last.
  // Advisory throughout — the A4.5/A5 gates still run on any selected
  // candidate, and unscored issues are never routed out (fail-safe).
  const orphansByEffortThenNumber = [...orphans].sort(
    (left, right) =>
      effortOrdinal(left.effort) - effortOrdinal(right.effort) ||
      left.number - right.number,
  );
  const { ranked, routedToHuman } = rankAndRouteBySuitability(
    orphansByEffortThenNumber,
    {
      floor:
        options.autopilotSuitabilityFloor ??
        DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
      enabled: options.autopilotSuitabilityEnabled !== false,
      routeBelowFloor: options.autopilot === true,
      getScore: (orphan) => orphan.autopilotSuitability,
    },
  );

  const counts = {
    scanned: issues.length,
    orphans: ranked.length,
    routed_to_human: routedToHuman.length,
    filtered: Object.fromEntries(
      Object.entries(filtered).map(([reason, entries]) => [
        reason,
        entries.length,
      ]),
    ),
    unresolvable: unresolvable.length,
  };

  return {
    orphans: ranked,
    routed_to_human: routedToHuman,
    filtered,
    unresolvable,
    warnings,
    counts,
  };
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repoRef = `${owner}/${repo}`;
  const policy = loadPolicy(args.policy);

  const openIssues = fetchOpenIssues(repoRef);
  const openStateByNumber = new Map(
    openIssues.map(
      (issue) => [issue.number, String(issue.state)] as [number, string],
    ),
  );

  // The claim-state annotation is strictly opt-in: only when
  // --with-claim-state is passed do we build the comment loader (the sole
  // new GitHub API surface) and resolve the trusted-actor / stale-age
  // policy. The default path leaves `claimState` undefined, so no extra
  // fetch is made and the output is byte-stable (mirrors
  // discover-roadmap-graph's own CLI wiring).
  const claimState = args.withClaimState
    ? buildClaimStateResolution(
        owner,
        repo,
        {
          claimTiming: policy.claimTiming,
          trustedMarkerActors: policy.trustedMarkerActors,
        },
        args.currentClaimId,
      )
    : undefined;

  const result = await filterOrphanIssues(openIssues, {
    issueStateByNumber: openStateByNumber,
    fetchIssueStateByNumber: (issueNumber) =>
      fetchIssueState(repoRef, issueNumber),
    fetchLabelEventsByIssueNumber: (issueNumber) =>
      fetchIssueLabelEvents(repoRef, issueNumber),
    markerPrefix: policy.markerPrefix,
    authoringLabelName: policy.authoringLabelName,
    authoringStaleAgeMs: policy.authoringStaleAgeMs,
    blockedByHumanLabelName: policy.blockedByHumanLabelName,
    needsDecisionLabelName: policy.needsDecisionLabelName,
    roadmapLabelName: policy.roadmapLabelName,
    autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    autopilot: args.autopilot,
    now: args.now || new Date(),
    claimState,
  });

  const output = {
    repository: { owner, repo },
    diagnostics: {
      pr: args.pr,
    },
    policy: {
      source: policy.source,
      orphanFirstPolicy: policy.orphanFirstPolicy,
      markerPrefix: policy.markerPrefix,
      authoringLabelName: policy.authoringLabelName,
      authoringStaleAge: policy.authoringStaleAge,
      autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
      autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    },
    ...result,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

// Excluded from the #1446 cli-args.mts wrapper: --current-claim-id below
// is an optional-value flag -- it may appear bare or take a following
// value, and only consumes the next token when one is present and does
// not itself look like another flag. `util.parseArgs` cannot express this:
// a `string`-type option always requires exactly one value and a
// `boolean`-type option never takes one; there is no in-between mode.
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    owner: '',
    repo: '',
    policy: '',
    pr: null,
    help: false,
    now: '',
    autopilot: false,
    withClaimState: false,
    currentClaimId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
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
    if (token === '--pr') {
      const parsedNumber = Number.parseInt(String(value ?? ''), 10);
      if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
        throw new Error(`invalid --pr value: ${value ?? ''}`);
      }
      parsed.pr = parsedNumber;
      index += 1;
      continue;
    }
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--autopilot') {
      parsed.autopilot = true;
      continue;
    }
    if (token === '--with-claim-state') {
      parsed.withClaimState = true;
      continue;
    }
    if (token === '--current-claim-id') {
      // Only consume the next token as the id when it exists and is not
      // itself a flag, mirroring discover-roadmap-graph's own parsing, so
      // `--current-claim-id --with-claim-state` does not swallow the
      // following flag as the id. A missing/flag value leaves
      // currentClaimId empty and the next flag is left for its own
      // iteration.
      if (value !== undefined && !value.startsWith('--')) {
        parsed.currentClaimId = value;
        index += 1;
      }
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-orphan-filter.mjs [--owner <owner>] [--repo <repo>] [--policy <path>] [--pr <number>] [--now <ISO8601>] [--autopilot] [--with-claim-state] [--current-claim-id <id>]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "diagnostics": {"pr": 404},
  "policy": {"source": "...", "orphanFirstPolicy": "none|maintainer-approved|public-disabled", "markerPrefix": "...", "authoringLabelName": "...", "authoringStaleAge": "...", "autopilotSuitabilityFloor": 3, "autopilotSuitabilityEnabled": true},
  "orphans": [{"number": 1, "title": "...", "state": "OPEN", "reason": "orphan|blocked_references_closed", "url": "...", "autopilotSuitability": 4, "effort": "S|M|L|null"}],
  "routed_to_human": [{"number": 2, "title": "...", "state": "OPEN", "reason": "orphan", "url": "...", "autopilotSuitability": 1, "effort": "S|M|L|null"}],
  "filtered": {
    "roadmap_marker": [...],
    "blocked_by_marker": [...],
    "blocked_label": [...],
    "authoring_label": [...],
    "blocked_by_open_reference": [...],
    "open_dependency_reference": [...],
    "unresolvable_reference": [...]
  },
  "unresolvable": [{"issue": 1, "reference": 2, "reason": "issue-not-found-or-inaccessible"}],
  "warnings": [{"issueNumber": 1, "message": "Warning: ..."}],
  "counts": {"scanned": 0, "orphans": 0, "routed_to_human": 0, "filtered": {...}, "unresolvable": 0}
}

"filtered.open_dependency_reference" (#1536) mirrors A3's own dependency
check in discover-readiness-check.mjs: a candidate whose body contains an
open "Depends on #NNN" line or an open task-list "- [ ] #NNN" reference is
excluded, UNLESS that referenced issue is itself a parent epic / aggregate
issue (title starting with "roadmap", or carrying the configured roadmap
label) -- matching A3's exemption exactly. This exemption never applies to
"Blocked by #NNN" references (filtered.blocked_by_open_reference), which
stay a hard sequential dependency with no exemption. An unresolvable
dependency reference (issue not found or inaccessible) is treated as
blocking, the same fail-safe "unresolvable_reference" applies to an
unresolvable "Blocked by" reference.

orphans are always ranked by authored autopilot-suitability score (high
first; equal scores tie-break by lowest issue number). With --autopilot
(autopilot runs), orphans whose score is below autopilotSuitabilityFloor
(default 3) are moved to routed_to_human; without it (attended runs) they
stay in orphans, ranked last. A missing or out-of-range score is treated
as no score: the issue stays in orphans and is never routed out.

--with-claim-state (opt-in) annotates each candidate in "orphans" and
"routed_to_human" with active-claim eligibility, exactly mirroring
discover-roadmap-graph's flag of the same name: it fetches that issue's
comments and resolves the active claim using the configured
trustedMarkerActors, claimTiming.staleAge (default PT24H), and
claimTiming.heartbeatInterval (default PT12H). Each annotated candidate
gains (activeClaim is always an object):
  "activeClaim": { "present": bool, "stale": bool, "claimId": str|null, "agentId": str|null, "heartbeatOverdue": bool }
                 (present:false with claimId/agentId null = no trusted claim)
  "claimEligible": bool   (eligible = no present, non-stale, trusted claim)
Absent the flag, NO comment API calls are made and no claim fields are
emitted (the output shape is byte-stable).
heartbeatOverdue is true when the latest valid claimed-by/heartbeat
created_at is at or past claimTiming.heartbeatInterval with no later trusted
heartbeat; false otherwise, including whenever present is false. It is
PURELY DIAGNOSTIC: it never feeds claimEligible or any other gate.
--current-claim-id <id> additionally sets "ownedByCurrentSession": bool on
each activeClaim (true when the active claim's claimId equals <id>).
NOTE: claimEligible is a best-effort SOFT discovery hint (same limitation
as discover-roadmap-graph's annotation): it resolves only new-format
claimed-by markers and intentionally does NOT account for legacy
claim-id-less markers or forced-handoff transfers; the authoritative A5
claim gate (idd-claim.instructions.md) remains the real protection.
`);
}

function loadPolicy(policyPath: string) {
  const defaultPath = resolve(process.cwd(), '.github/idd/config.json');
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : defaultPath;
  try {
    const config = JSON.parse(readFileSync(targetPath, 'utf8')) as {
      markerPrefix?: unknown;
      claimTiming?: { staleAge?: unknown; heartbeatInterval?: unknown };
      trustedMarkerActors?: unknown;
    };
    const authoringPolicy = resolveAuthoringGuardPolicy(config);
    const labelsPolicy = normalizePolicyConfig(config).labels;
    return {
      source: targetPath,
      orphanFirstPolicy: getOrphanFirstPolicy(config),
      markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
      authoringLabelName: authoringPolicy.labelName,
      authoringStaleAge: authoringPolicy.staleAge,
      authoringStaleAgeMs: authoringPolicy.staleAgeMs,
      blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
      needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
      roadmapLabelName: labelsPolicy.roadmapLabelName,
      autopilotSuitabilityFloor: resolveAutopilotSuitabilityFloor(config),
      autopilotSuitabilityEnabled: resolveAutopilotSuitabilityEnabled(config),
      // Passed through verbatim (raw, un-normalized) for
      // buildClaimStateResolution (#1395), which expects this same shape —
      // it is only consumed when --with-claim-state is passed.
      claimTiming: config.claimTiming,
      trustedMarkerActors: config.trustedMarkerActors,
    };
  } catch {
    const authoringPolicy = resolveAuthoringGuardPolicy({});
    const labelsPolicy = normalizePolicyConfig({}).labels;
    return {
      source: targetPath,
      orphanFirstPolicy: 'none',
      markerPrefix: DEFAULT_MARKER_PREFIX,
      authoringLabelName: authoringPolicy.labelName,
      authoringStaleAge: authoringPolicy.staleAge,
      authoringStaleAgeMs: authoringPolicy.staleAgeMs,
      blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
      needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
      roadmapLabelName: labelsPolicy.roadmapLabelName,
      autopilotSuitabilityFloor: DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
      autopilotSuitabilityEnabled: true,
      // No config was readable, so buildClaimStateResolution falls back to
      // its own defaults (24h stale age, env-only trusted actors) — the
      // same soft-default philosophy the graph helper already relies on.
      claimTiming: undefined,
      trustedMarkerActors: undefined,
    };
  }
}

function resolveAutopilotSuitabilityFloor(config: unknown): number {
  // Delegate range/default validation to the shared normalizer so the
  // 1-5 rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    (config as { autopilotSuitability?: { floor?: unknown } } | null)
      ?.autopilotSuitability?.floor,
  );
}

function resolveAutopilotSuitabilityEnabled(config: unknown): boolean {
  return (
    (config as { autopilotSuitability?: { enabled?: unknown } } | null)
      ?.autopilotSuitability?.enabled !== false
  );
}

function normalizeIssue(issue: {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  labelEvents?: unknown;
  body?: unknown;
  url?: unknown;
  html_url?: unknown;
}) {
  return {
    number: Number.parseInt(String(issue.number), 10),
    title: issue.title ?? '',
    state: issue.state ?? '',
    labels: normalizeLabels(issue.labels),
    labelEvents: Array.isArray(issue.labelEvents) ? issue.labelEvents : [],
    body: issue.body ?? '',
    url: issue.url ?? issue.html_url ?? '',
  };
}

function resolveIssueLabelEvents(
  issue: OrphanIssueInput,
  fetchLabelEventsByIssueNumber?: (issueNumber: number) => unknown[],
) {
  if (Array.isArray(issue.labelEvents) && issue.labelEvents.length > 0) {
    return issue.labelEvents;
  }
  if (typeof fetchLabelEventsByIssueNumber !== 'function') {
    return [];
  }
  try {
    return fetchLabelEventsByIssueNumber(issue.number);
  } catch {
    return [];
  }
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === 'string') {
        return label;
      }
      return String((label as { name?: unknown } | null)?.name ?? '');
    })
    .filter(Boolean);
}

function resolveIssueState(
  number: number,
  issueStateByNumber: Map<number, string>,
  fetchIssueStateByNumber: (issueNumber: number) => string,
): string | undefined {
  if (issueStateByNumber.has(number)) {
    return issueStateByNumber.get(number);
  }
  const state = fetchIssueStateByNumber(number);
  issueStateByNumber.set(number, state);
  return state;
}

function fetchIssueState(repoRef: string, issueNumber: number): string {
  try {
    const state = ghText(
      [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repoRef,
        '--json',
        'state',
        '--jq',
        '.state',
      ],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
    return state || 'UNRESOLVABLE';
  } catch {
    return 'UNRESOLVABLE';
  }
}

function fetchIssueLabelEvents(repoRef: string, issueNumber: number) {
  const events: unknown[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = ghJson([
      'api',
      `repos/${repoRef}/issues/${issueNumber}/timeline?per_page=${pageSize}&page=${page}`,
    ]);
    events.push(
      ...rawPage.filter(
        (event) => (event as { event?: unknown } | null)?.event === 'labeled',
      ),
    );
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return events;
}

function ghJson(args: string[]): unknown[] {
  return JSON.parse(runGh(args).trim() || '[]');
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}

function normalizeMarkerPrefix(prefix: unknown): string {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return DEFAULT_MARKER_PREFIX;
  }
  return prefix;
}

function normalizeAuthoringLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : 'status:authoring';
}

/** Resolve the configured `labels.blockedByHumanLabelName` (#1273). */
function normalizeBlockedByHumanLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
}

/** Resolve the configured `labels.needsDecisionLabelName` (#1273). */
function normalizeNeedsDecisionLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.needsDecisionLabelName;
}

/**
 * Resolve the configured `labels.roadmapLabelName` for the dependency
 * parent-epic exemption (#1536), following this file's established
 * defensive-default pattern for the other configurable label names.
 */
function normalizeRoadmapLabelName(labelName: unknown): string {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.roadmapLabelName;
}

function fetchOpenIssues(repoRef: string) {
  const issues: ReturnType<typeof normalizeIssue>[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = ghJson([
      'api',
      `repos/${repoRef}/issues?state=open&per_page=${pageSize}&page=${page}`,
    ]);
    const pageItems = rawPage
      .filter(
        (item) =>
          (item as { pull_request?: unknown } | null)?.pull_request ===
          undefined,
      )
      .map((item) =>
        normalizeIssue(item as Parameters<typeof normalizeIssue>[0]),
      );

    issues.push(...pageItems);
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return issues;
}
