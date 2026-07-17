#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-readiness-check.mts
//
// The scripts/discover-readiness-check.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LabelEvent } from './authoring-label-guard.mts';
import {
  buildAuthoringLabelWarning,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mts';
import {
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
} from './autopilot-suitability.mts';
import { parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_OPTIONS, ghText } from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import { stripMarkdownCodeRegions } from './markdown-code.mts';
import { escapeRegex } from './marker-regex.mts';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';

// Leading-anchor source shared by the `Blocked by` / `Depends on` line parsers.
// It tolerates optional indentation, nested blockquote (`>`) markers, and a
// single list bullet (`-`/`*`/`+`) while staying line-anchored, so a dependency
// written as `- Blocked by #55` or `> Depends on #66` is still recognized. The
// extractors run `stripMarkdownCodeRegions` over the body first, so a
// dependency line merely quoted inside inline code or a fenced block is already
// masked out — treating code-quoted markers as false positives, consistent with
// the #1121 repo behavior; excluding backticks from this prefix is a second
// line of defense for the inline-code case. This const is declared before the
// `import.meta.main` CLI block on purpose so it is initialized when the CLI
// path runs `extractBlockedByIssueNumbers` (a const declared after that block
// would be in the temporal dead zone).
const DEPENDENCY_LINE_PREFIX = String.raw`^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?`;

const INACCESSIBLE_ISSUE_SENTINEL = Object.freeze({
  __iddLookupStatus: 'inaccessible',
});
const INACCESSIBLE_HTTP_STATUSES = new Set([403, 410, 451]);

type InaccessibleIssueSentinel = typeof INACCESSIBLE_ISSUE_SENTINEL;

/**
 * The authored autopilot-suitability signal for one evaluated issue.
 *
 * `autopilotSuitability` is the parsed 1-5 score, or `null` ("no score")
 * when the marker is absent, out of range, or incoherent (fail-safe).
 * `belowFloor` is `true` only when a score is present and strictly below
 * the configured floor; a "no score" issue is never flagged below floor,
 * matching the existing score semantics. When the `autopilotSuitability`
 * kill switch is off (`enabled: false`), the signal is forced fully neutral
 * (`null` / `false`), mirroring the discovery ranker that ignores the score
 * entirely. The signal is advisory evidence only — it never changes whether
 * an issue is `ready` or `filteredOut`.
 */
export interface ReadinessSuitabilitySignal {
  autopilotSuitability: number | null;
  belowFloor: boolean;
}

/** One issue that passed every readiness filter. */
export interface ReadinessReadyIssue extends ReadinessSuitabilitySignal {
  number: number;
  title: string;
}

/** One issue removed by a readiness filter, with the failed reasons. */
export interface ReadinessFilteredIssue extends ReadinessSuitabilitySignal {
  number: number;
  title: string;
  reasons: string[];
}

/** One reference that could not be resolved during the readiness check. */
export interface ReadinessUnresolvableReference {
  issueNumber: number;
  kind: string;
  reference: string;
  reason: string;
}

/** Full readiness verdict returned by `evaluateDiscoverReadiness`. */
export interface ReadinessSummary {
  ready: ReadinessReadyIssue[];
  filteredOut: ReadinessFilteredIssue[];
  unresolvable: ReadinessUnresolvableReference[];
  warnings: NonNullable<ReturnType<typeof buildAuthoringLabelWarning>>[];
  summary: {
    total: number;
    readyCount: number;
    filteredCount: number;
    unresolvableCount: number;
    filteredByReason: Record<string, number>;
  };
}

interface NormalizedIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: Set<string>;
  labelEvents: LabelEvent[];
  url: string;
}

interface EvaluateDiscoverReadinessOptions {
  includeUnresolvable?: boolean;
  loadIssue?: (issueNumber: number) => unknown;
  findRoadmapsByMarker?: (markerId: string) => unknown;
  loadIssueLabelEvents?: (issueNumber: number) => unknown;
  authoringLabelName?: string;
  authoringStaleAgeMs?: number;
  markerPrefix?: string;
  /** Configured `labels.roadmapLabelName` (#1273); defaults to `'roadmap'`. */
  roadmapLabelName?: string;
  /** Configured `labels.blockedByHumanLabelName` (#1273). */
  blockedByHumanLabelName?: string;
  /** Configured `labels.needsDecisionLabelName` (#1273). */
  needsDecisionLabelName?: string;
  autopilotSuitabilityFloor?: number;
  autopilotSuitabilityEnabled?: boolean;
  now?: Date | string;
}

interface ParsedArgs {
  issueNumbers: number[];
  includeUnresolvable: boolean;
  csv: boolean;
  owner: string;
  repo: string;
  policy: string;
  now: string;
  // `--swarm-floor <N>`: when set, the CLI ignores the `--issue`/`--issues`
  // requirement, sweeps every open issue (orphans included), and reports the
  // at-or-above-floor eligible set. `null` keeps the default per-issue mode.
  swarmFloor: number | null;
  help: boolean;
}

type CachedIssue = NormalizedIssue | InaccessibleIssueSentinel | null;

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `issue:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --issue spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger block calls parseArgs()
// synchronously at module-evaluation time, and a `const` declared after
// that point is still in the temporal dead zone when the trigger fires
// (see ci-wait-policy.mts's identical note).
const DISCOVER_READINESS_CHECK_FLAG_SPEC = {
  '--issue': { type: 'string', multiple: true },
  '--issues': { type: 'string', multiple: true },
  '--include-unresolvable': { type: 'boolean', default: false },
  '--csv': { type: 'boolean', default: false },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--policy': { type: 'string', default: '' },
  '--now': { type: 'string', default: '' },
  '--swarm-floor': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.swarmFloor === null && args.issueNumbers.length === 0) {
    throw new Error(
      'missing required --issue <number> (repeatable) or --issues <n1,n2,...>',
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
  const policyConfig = loadPolicy(args.policy);
  const authoringPolicy = resolveAuthoringGuardPolicy(policyConfig);
  const markerPrefix = resolveMarkerPrefix(policyConfig);
  const labelsPolicy = normalizePolicyConfig(policyConfig).labels;

  // `--swarm-floor` sweeps every open issue (orphans included); otherwise
  // evaluate exactly the issues the caller named.
  const issueNumbers =
    args.swarmFloor === null
      ? args.issueNumbers
      : listOpenIssueNumbers(owner, repo);

  const summary = await evaluateDiscoverReadiness(issueNumbers, {
    includeUnresolvable: args.includeUnresolvable,
    loadIssue: buildIssueLoader(owner, repo),
    // `--swarm-floor` output never surfaces the stale-authoring warning, so
    // skip the per-issue timeline fetch this loader runs — over a whole-repo
    // sweep that is one extra paginated API call per open issue. The
    // authoring-label *filter* reads issue labels (always loaded), so
    // eligibility is unchanged; only the unsurfaced warning is dropped.
    loadIssueLabelEvents:
      args.swarmFloor === null
        ? buildIssueLabelEventsLoader(owner, repo)
        : undefined,
    findRoadmapsByMarker: buildRoadmapMarkerResolver(owner, repo, markerPrefix),
    authoringLabelName: authoringPolicy.labelName,
    authoringStaleAgeMs: authoringPolicy.staleAgeMs,
    markerPrefix,
    roadmapLabelName: labelsPolicy.roadmapLabelName,
    blockedByHumanLabelName: labelsPolicy.blockedByHumanLabelName,
    needsDecisionLabelName: labelsPolicy.needsDecisionLabelName,
    autopilotSuitabilityFloor:
      args.swarmFloor ?? resolveSuitabilityFloor(policyConfig),
    autopilotSuitabilityEnabled: resolveSuitabilityEnabled(policyConfig),
    now: args.now || new Date(),
  });

  if (args.swarmFloor !== null) {
    process.stdout.write(
      `${JSON.stringify(summarizeSwarmFloorEligibility(summary), null, 2)}\n`,
    );
  } else if (args.csv) {
    process.stdout.write(renderCsv(summary));
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

export async function evaluateDiscoverReadiness(
  issueNumbers: (number | string)[],
  options: EvaluateDiscoverReadinessOptions,
): Promise<ReadinessSummary> {
  const {
    includeUnresolvable = false,
    loadIssue,
    findRoadmapsByMarker,
    loadIssueLabelEvents,
    authoringLabelName = 'status:authoring',
    authoringStaleAgeMs = 4 * 60 * 60 * 1000,
    markerPrefix,
    roadmapLabelName: rawRoadmapLabelName,
    blockedByHumanLabelName: rawBlockedByHumanLabelName,
    needsDecisionLabelName: rawNeedsDecisionLabelName,
    autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled,
    now = new Date(),
  } = options ?? {};
  // Route the three label-name options through normalizePolicyConfig rather
  // than a bare destructure default (which only applies on `undefined`), so
  // an invalid or empty-string input also falls back to POLICY_DEFAULTS
  // instead of silently disabling the blocked-label / roadmap-label checks
  // below (consistent with the other five helpers in #1273).
  const { roadmapLabelName, blockedByHumanLabelName, needsDecisionLabelName } =
    normalizePolicyConfig({
      labels: {
        roadmapLabelName: rawRoadmapLabelName,
        blockedByHumanLabelName: rawBlockedByHumanLabelName,
        needsDecisionLabelName: rawNeedsDecisionLabelName,
      },
    }).labels;
  if (typeof loadIssue !== 'function') {
    throw new Error(
      'evaluateDiscoverReadiness requires loadIssue(issueNumber)',
    );
  }
  if (typeof findRoadmapsByMarker !== 'function') {
    throw new Error(
      'evaluateDiscoverReadiness requires findRoadmapsByMarker(markerId)',
    );
  }

  const resolvedMarkerPrefix =
    typeof markerPrefix === 'string' && markerPrefix.length > 0
      ? markerPrefix
      : DEFAULT_MARKER_PREFIX;
  // Delegate range/default validation to the shared normalizer so the 1-5
  // rule and the default floor cannot drift from the discovery rankers.
  const suitabilityFloor = normalizeAutopilotSuitabilityFloor(
    autopilotSuitabilityFloor,
  );
  // `autopilotSuitability.enabled: false` is the discovery kill switch: the
  // ranker ignores the score entirely (see rankAndRouteBySuitability). Mirror
  // that here so this readiness signal does not flag below-floor work the
  // operator turned the suitability system off for.
  const suitabilityEnabled = autopilotSuitabilityEnabled !== false;
  // Parse the authored autopilot-suitability score once per body and derive
  // the below-floor flag. A null score ("no score") is never below floor; when
  // the kill switch is off, force a fully neutral signal (ignore the score).
  const suitabilitySignal = (body: string): ReadinessSuitabilitySignal => {
    if (!suitabilityEnabled) {
      return { autopilotSuitability: null, belowFloor: false };
    }
    const score = parseAutopilotSuitability(body, resolvedMarkerPrefix);
    return {
      autopilotSuitability: score,
      belowFloor: score !== null && score < suitabilityFloor,
    };
  };

  const ready: ReadinessReadyIssue[] = [];
  const filteredOut: ReadinessFilteredIssue[] = [];
  const unresolvable: ReadinessUnresolvableReference[] = [];
  const warnings: NonNullable<ReturnType<typeof buildAuthoringLabelWarning>>[] =
    [];
  const issueCache = new Map<number, CachedIssue>();
  const markerCache = new Map<string, NormalizedIssue[]>();

  for (const issueNumber of normalizeIssueNumbers(issueNumbers)) {
    const issue = await getIssue(issueNumber, issueCache, loadIssue);
    if (!issue || isInaccessibleIssue(issue)) {
      const issueReason = isInaccessibleIssue(issue)
        ? 'issue_inaccessible'
        : 'issue_not_found';
      unresolvable.push({
        issueNumber,
        kind: 'issue',
        reference: `#${issueNumber}`,
        reason: issueReason,
      });
      filteredOut.push({
        number: issueNumber,
        title: '',
        reasons: [issueReason],
        // No body is available for a not-found / inaccessible issue, so the
        // score is "no score" and the issue is never flagged below floor.
        ...suitabilitySignal(''),
      });
      continue;
    }
    if (issue.state !== 'OPEN') {
      filteredOut.push({
        number: issue.number,
        title: issue.title,
        reasons: ['issue_not_open'],
        ...suitabilitySignal(issue.body),
      });
      continue;
    }

    const reasons = new Set<string>();
    const labels = normalizeLabels(issue.labels);
    if (labels.has(blockedByHumanLabelName)) {
      reasons.add(`label:${blockedByHumanLabelName}`);
    }
    if (labels.has(needsDecisionLabelName)) {
      reasons.add(`label:${needsDecisionLabelName}`);
    }
    if (labels.has(authoringLabelName)) {
      reasons.add(`label:${authoringLabelName}`);
      const warning = buildAuthoringLabelWarning({
        issueNumber: issue.number,
        labelName: authoringLabelName,
        labelEvents: await resolveLabelEvents(issue, loadIssueLabelEvents),
        now,
        staleAgeMs: authoringStaleAgeMs,
      });
      if (warning) {
        warnings.push(warning);
      }
    }

    for (const dependencyNumber of extractDependencyIssueNumbers(issue.body)) {
      const dependencyIssue = await getIssue(
        dependencyNumber,
        issueCache,
        loadIssue,
      );
      if (!dependencyIssue || isInaccessibleIssue(dependencyIssue)) {
        const dependencyReason = isInaccessibleIssue(dependencyIssue)
          ? 'issue_inaccessible'
          : 'issue_not_found';
        reasons.add('unresolvable_dependency_issue');
        unresolvable.push({
          issueNumber: issue.number,
          kind: 'dependency',
          reference: `#${dependencyNumber}`,
          reason: dependencyReason,
        });
        continue;
      }
      if (
        dependencyIssue.state === 'OPEN' &&
        !isParentEpicIssue(dependencyIssue, roadmapLabelName)
      ) {
        reasons.add(`open_dependency_issue:#${dependencyNumber}`);
      }
    }

    for (const blockedNumber of extractBlockedByIssueNumbers(issue.body)) {
      const blockedIssue = await getIssue(blockedNumber, issueCache, loadIssue);
      if (!blockedIssue || isInaccessibleIssue(blockedIssue)) {
        const blockedReason = isInaccessibleIssue(blockedIssue)
          ? 'issue_inaccessible'
          : 'issue_not_found';
        reasons.add('unresolvable_blocked_by_issue');
        unresolvable.push({
          issueNumber: issue.number,
          kind: 'blocked_by_issue',
          reference: `#${blockedNumber}`,
          reason: blockedReason,
        });
        continue;
      }
      if (blockedIssue.state === 'OPEN') {
        reasons.add(`blocked_by_open_issue:#${blockedNumber}`);
      }
    }

    for (const marker of extractBlockedByRoadmapMarkers(
      issue.body,
      resolvedMarkerPrefix,
    )) {
      const markerMatches = await getRoadmapsByMarker(
        marker,
        markerCache,
        findRoadmapsByMarker,
      );
      if (markerMatches.length === 0) {
        reasons.add('unresolvable_blocked_by_marker');
        unresolvable.push({
          issueNumber: issue.number,
          kind: 'blocked_by_marker',
          reference: marker,
          reason: 'roadmap_marker_not_found',
        });
        continue;
      }
      if (markerMatches.some((candidate) => candidate.state === 'OPEN')) {
        reasons.add(`blocked_by_open_roadmap_marker:${marker}`);
      }
    }

    const signal = suitabilitySignal(issue.body);
    if (reasons.size === 0) {
      ready.push({
        number: issue.number,
        title: issue.title,
        ...signal,
      });
      continue;
    }

    filteredOut.push({
      number: issue.number,
      title: issue.title,
      reasons: [...reasons].sort(),
      ...signal,
    });
  }

  const filteredByReason = countReasons(filteredOut);
  return {
    ready,
    filteredOut,
    unresolvable: includeUnresolvable ? unresolvable : [],
    warnings,
    summary: {
      total: ready.length + filteredOut.length,
      readyCount: ready.length,
      filteredCount: filteredOut.length,
      unresolvableCount: unresolvable.length,
      filteredByReason,
    },
  };
}

export interface SwarmFloorEligibility {
  eligible: ReadinessReadyIssue[];
  eligible_count: number;
  total: number;
}

/**
 * Reduce a full readiness summary to the swarm-floor answer: the ready issues
 * at or above the configured floor (a "no score" issue is never below floor,
 * so it stays eligible, matching the discovery ranker), plus counts. Pure so
 * the `--swarm-floor` CLI sweep and the tests share one definition.
 */
export function summarizeSwarmFloorEligibility(
  summary: ReadinessSummary,
): SwarmFloorEligibility {
  const eligible = summary.ready.filter((issue) => !issue.belowFloor);
  return {
    eligible,
    eligible_count: eligible.length,
    total: summary.summary.total,
  };
}

/**
 * Parse and range-check the `--swarm-floor <N>` value. The floor is the
 * autopilot-suitability 1-5 band, so a non-integer, fractional, or
 * out-of-range value is a hard error rather than being silently coerced to
 * the default floor — coercion would loosen the eligibility gate on a typo
 * (e.g. `--swarm-floor 50` quietly answering at floor 3), which is exactly
 * the mis-read this stop-condition query must avoid.
 */
export function parseSwarmFloorArg(value: string): number {
  const raw = String(value ?? '').trim();
  const floor = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || floor < 1 || floor > 5) {
    throw new Error('--swarm-floor requires an integer 1-5');
  }
  return floor;
}

/**
 * Collect the `#N` references declared on a dependency-keyword line.
 *
 * A line is a dependency declaration when, after the shared
 * `DEPENDENCY_LINE_PREFIX` (indentation, blockquote, and/or a list bullet), it
 * begins with `keyword`, an optional `:` (#1311 — a natural bulleted phrasing
 * such as `- Blocked by: #123` is tolerated the same as `- Blocked by #123`,
 * aligned with the colon-tolerant `extractKeywordReferenceTargets` edge
 * extractor in `discover-roadmap-graph.mts`), then horizontal whitespace and
 * at least one `#N`. From there `consumeDependencyRefList` collects the
 * contiguous dependency-ref list, so `Blocked by #A, #B, #C` (comma- or
 * space-separated) yields `[A, B, C]`. The keyword-to-ref gap is `[ \t]+`
 * (not `\s+`) so it cannot span a newline and swallow a bare `#N` on the
 * following line, and the `.*$` capture plus the `m` flag (no `s` flag)
 * keeps the match on the single keyword line. Callers pass a
 * code-region-stripped body, so a quoted example line is already masked (see
 * `DEPENDENCY_LINE_PREFIX`).
 */
function extractKeywordLineRefs(body: string, keyword: string): number[] {
  const linePattern = new RegExp(
    `${DEPENDENCY_LINE_PREFIX}${escapeRegex(keyword)}:?[ \\t]+(#\\d+.*)$`,
    'gim',
  );
  const numbers: number[] = [];
  for (const lineMatch of body.matchAll(linePattern)) {
    numbers.push(...consumeDependencyRefList(lineMatch[1]));
  }
  return numbers;
}

/**
 * Consume the contiguous dependency-ref list at the start of `segment`: bare
 * local `#N` entries separated by commas, "and", and/or whitespace. Parsing
 * stops at the first token that is neither a bare local ref nor such a
 * separator, so trailing prose (`; similar to #402`) and cross-repo mentions
 * (`(see other/repo#20)`) are excluded instead of being mis-read as local
 * blockers. This mirrors the separator-bounded reference parsing in
 * `discover-roadmap-graph.mts`, extended to also accept a plain-whitespace
 * separator so the space-separated multi-ref form is captured too.
 */
function consumeDependencyRefList(segment: string): number[] {
  const numbers: number[] = [];
  let remaining = segment;
  while (remaining) {
    const refMatch = remaining.match(/^#(\d+)\b/);
    if (!refMatch) {
      break;
    }
    numbers.push(Number.parseInt(refMatch[1], 10));
    remaining = remaining.slice(refMatch[0].length);
    const separatorMatch = remaining.match(
      /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s+)/i,
    );
    if (!separatorMatch) {
      break;
    }
    remaining = remaining.slice(separatorMatch[0].length);
  }
  return numbers;
}

export function extractBlockedByIssueNumbers(body: string): number[] {
  return dedupeNumbers(
    extractKeywordLineRefs(stripMarkdownCodeRegions(body), 'Blocked by'),
  );
}

export function extractBlockedByRoadmapMarkers(
  body: string,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): string[] {
  // Regex-escape the configurable prefix so a namespaced adopter prefix
  // (which may contain a metacharacter) cannot corrupt or break the
  // extraction pattern. For the default `idd-skill` this is byte-identical
  // to the prior hardcoded literal.
  const matches = body.matchAll(
    new RegExp(
      `<!--\\s*${escapeRegex(markerPrefix)}-blocked-by:\\s*([^\\s>]+)\\s*-->`,
      'gi',
    ),
  );
  return [...new Set([...matches].map((match) => match[1]))];
}

export function extractDependencyIssueNumbers(body: string): number[] {
  const stripped = stripMarkdownCodeRegions(body);
  const explicitDependencies = extractKeywordLineRefs(stripped, 'Depends on');
  const taskListDependencies = [
    ...stripped.matchAll(/^\s*-\s*\[(?: |x)\]\s+#(\d+)\b/gim),
  ];
  return dedupeNumbers([
    ...explicitDependencies,
    ...taskListDependencies.map((match) => Number.parseInt(match[1], 10)),
  ]);
}

/**
 * Walk `argv` and return every occurrence of the given long-flag literals
 * (e.g. `--issue`, `--issues`) in argv order, tagged with which flag
 * matched and its literal string value. `parseCliArgs` has already thrown
 * on anything malformed (a missing value, a flag-shaped value, an unknown
 * flag) by the time this runs, so this is a pure order-reconstruction pass
 * over already-validated input, not a second parse/validation pass. Covers
 * both the `--flag value` and `--flag=value` forms Node's `util.parseArgs`
 * itself accepts for a long option (#1450 review follow-up: grouping every
 * `--issue` occurrence before every `--issues` occurrence silently
 * reordered interleaved input, e.g. `--issues 1,2 --issue 3`).
 */
function collectOrderedOccurrences(
  argv: readonly string[],
  flagNames: readonly string[],
): { flag: string; value: string }[] {
  const occurrences: { flag: string; value: string }[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const bareFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!flagNames.includes(bareFlag)) {
      continue;
    }
    const value =
      equalsIndex === -1 ? argv[index + 1] : token.slice(equalsIndex + 1);
    occurrences.push({ flag: bareFlag, value });
  }
  return occurrences;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(
    argv,
    DISCOVER_READINESS_CHECK_FLAG_SPEC,
  );
  // Preserves the existing "collect every --issue occurrence plus every
  // comma-split --issues entry, in argv order, then silently drop
  // non-numeric tokens" contract (normalizeIssueNumbers) unchanged by this
  // migration -- only the flag-syntax parsing (missing/flag-shaped values,
  // unknown flags) is now strict.
  const issueTokens = collectOrderedOccurrences(argv, [
    '--issue',
    '--issues',
  ]).flatMap((occurrence) =>
    occurrence.flag === '--issues'
      ? occurrence.value.split(',')
      : [occurrence.value],
  );
  const swarmFloorToken = values['swarm-floor'] as string | undefined;
  return {
    issueNumbers: normalizeIssueNumbers(issueTokens),
    includeUnresolvable: values['include-unresolvable'] as boolean,
    csv: values.csv as boolean,
    owner: values.owner as string,
    repo: values.repo as string,
    policy: values.policy as string,
    now: values.now as string,
    // parseSwarmFloorArg keeps its existing throw-on-invalid contract
    // (range 1-5, hard error on a non-integer or out-of-range value)
    // unchanged; only called when --swarm-floor is actually present.
    swarmFloor:
      swarmFloorToken === undefined
        ? null
        : parseSwarmFloorArg(swarmFloorToken),
    help,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-readiness-check.mjs --issue <number> [--issue <number> ...]
  node scripts/discover-readiness-check.mjs --issues <n1,n2,...>
    [--include-unresolvable] [--csv] [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>] [--help]
  node scripts/discover-readiness-check.mjs --swarm-floor <N>
    [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>] [--help]

  --swarm-floor <N> ignores --issue/--issues, sweeps every open issue in the
  repository (orphans included, pull requests excluded), runs readiness, and
  reports the ready issues at or above autopilot-suitability floor N (an
  integer 1-5) in one call. An out-of-range or non-integer N is a hard error
  rather than a silent coercion. A "no score" issue is never below floor,
  matching discovery ranking.

Output schema (JSON mode):
  {
    "ready": [{ "number": 123, "title": "...", "autopilotSuitability": 4, "belowFloor": false }],
    "filteredOut": [{ "number": 124, "title": "...", "reasons": ["..."], "autopilotSuitability": null, "belowFloor": false }],
    "unresolvable": [{ "issueNumber": 124, "kind": "...", "reference": "...", "reason": "..." }],
    "warnings": [{ "issueNumber": 124, "message": "Warning: ..." }],
    "summary": { "total": 2, "readyCount": 1, "filteredCount": 1, "unresolvableCount": 0, "filteredByReason": { "...": 1 } }
  }

Output schema (--swarm-floor mode):
  {
    "eligible": [{ "number": 123, "title": "...", "autopilotSuitability": 4, "belowFloor": false }],
    "eligible_count": 1,
    "total": 7
  }
`);
}

function normalizeIssueNumbers(values: (number | string)[]): number[] {
  const parsed = values
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(parsed)];
}

function dedupeNumbers(values: number[]): number[] {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
}

function normalizeIssue(issue: {
  number?: unknown;
  id?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
  labelEvents?: unknown;
  url?: unknown;
}): NormalizedIssue {
  return {
    number: Number.parseInt(String(issue.number ?? issue.id ?? 0), 10),
    title: String(issue.title ?? ''),
    state: String(issue.state ?? '').toUpperCase(),
    body: String(issue.body ?? ''),
    labels: normalizeLabels(issue.labels),
    labelEvents: Array.isArray(issue.labelEvents) ? issue.labelEvents : [],
    url: String(issue.url ?? ''),
  };
}

function normalizeLabels(labelsInput: unknown): Set<string> {
  if (!labelsInput) {
    return new Set();
  }
  if (labelsInput instanceof Set) {
    return new Set(
      [...labelsInput].map((label) => String(label ?? '')).filter(Boolean),
    );
  }
  if (Array.isArray(labelsInput)) {
    return new Set(
      labelsInput
        .map((label) => {
          if (typeof label === 'string') {
            return label;
          }
          return String((label as { name?: unknown } | null)?.name ?? '');
        })
        .filter(Boolean),
    );
  }
  return new Set();
}

function isParentEpicIssue(
  issue: NormalizedIssue,
  roadmapLabelName: string = POLICY_DEFAULTS.labels.roadmapLabelName,
): boolean {
  // Title heuristic is intentionally independent of the configured roadmap
  // label (#1273): it is a naming-convention signal on free-form title text,
  // not a label comparison, so it is not wired to `labels.roadmapLabelName`.
  if (issue.title.toLowerCase().startsWith('roadmap')) {
    return true;
  }
  return issue.labels.has(roadmapLabelName);
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

async function getRoadmapsByMarker(
  marker: string,
  cache: Map<string, NormalizedIssue[]>,
  findRoadmapsByMarker: (markerId: string) => unknown,
): Promise<NormalizedIssue[]> {
  const cached = cache.get(marker);
  if (cached) {
    return cached;
  }
  const rawMatches = await findRoadmapsByMarker(marker);
  const matches = ((rawMatches ?? []) as unknown[])
    .map((issue) =>
      normalizeIssue(issue as Parameters<typeof normalizeIssue>[0]),
    )
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0);
  cache.set(marker, matches);
  return matches;
}

async function resolveLabelEvents(
  issue: NormalizedIssue,
  loadIssueLabelEvents?: (issueNumber: number) => unknown,
): Promise<LabelEvent[]> {
  if (
    issue.labelEvents.length > 0 ||
    typeof loadIssueLabelEvents !== 'function'
  ) {
    return issue.labelEvents;
  }
  try {
    const events = await loadIssueLabelEvents(issue.number);
    return Array.isArray(events) ? (events as LabelEvent[]) : [];
  } catch {
    return [];
  }
}

function countReasons(
  filteredOut: ReadinessFilteredIssue[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of filteredOut) {
    for (const reason of item.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

function renderCsv(summary: ReadinessSummary): string {
  const lines = ['number,title,status,reasons,suitability,belowFloor'];
  for (const item of summary.ready) {
    lines.push(
      `${item.number},${escapeCsv(item.title)},ready,,${formatScore(item.autopilotSuitability)},${item.belowFloor}`,
    );
  }
  for (const item of summary.filteredOut) {
    lines.push(
      `${item.number},${escapeCsv(item.title)},filtered,${escapeCsv(item.reasons.join(';'))},${formatScore(item.autopilotSuitability)},${item.belowFloor}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatScore(score: number | null): string {
  return score === null ? '' : String(score);
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
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
      const result = runGh(args).trim();
      if (!result || result === 'null') {
        return null;
      }
      return JSON.parse(result);
    } catch (error) {
      // `gh` exits 1 for every HTTP error, so derive the real status from
      // its output. Fail closed: a genuine 404 maps to issue_not_found,
      // a visibility 403/410/451 maps to issue_inaccessible, and auth /
      // rate-limit / network / unknown failures propagate to abort.
      if (deriveGhHttpStatus(error) === 404) {
        return null;
      }
      if (isInaccessibleIssueLookupError(error)) {
        return INACCESSIBLE_ISSUE_SENTINEL;
      }
      throw error;
    }
  };
}

function buildIssueLabelEventsLoader(owner: string, repo: string) {
  return async (issueNumber: number) => {
    const repoRef = `${owner}/${repo}`;
    return fetchIssueLabelEvents(repoRef, issueNumber);
  };
}

function fetchIssueLabelEvents(repoRef: string, issueNumber: number) {
  const events: unknown[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = JSON.parse(
      runGh([
        'api',
        `repos/${repoRef}/issues/${issueNumber}/timeline?per_page=${pageSize}&page=${page}`,
      ]).trim() || '[]',
    ) as unknown[];
    const labeled = rawPage.filter(
      (event) => (event as { event?: unknown } | null)?.event === 'labeled',
    );
    events.push(...labeled);
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return events;
}

export function buildRoadmapMarkerSearchQuery(
  owner: string,
  repo: string,
  markerPrefix: string,
  marker: string,
): string {
  // Thread the configurable prefix into the GitHub search query WITHOUT
  // regex-escaping: this is a literal `in:body` search term, so escaping the
  // prefix would corrupt the exact marker string the resolver looks for.
  return `repo:${owner}/${repo} is:issue in:body "<!-- ${markerPrefix}-roadmap-id: ${marker} -->"`;
}

export function buildRoadmapMarkerResolver(
  owner: string,
  repo: string,
  markerPrefix: string,
) {
  return async (marker: string) => {
    const query = buildRoadmapMarkerSearchQuery(
      owner,
      repo,
      markerPrefix,
      marker,
    );
    const encodedQuery = encodeURIComponent(query);
    const result = runGh([
      'api',
      `search/issues?q=${encodedQuery}&per_page=100`,
      '--jq',
      '.items',
    ]).trim();
    return JSON.parse(result || '[]');
  };
}

/**
 * Every open issue number in the repository, orphans included. `--paginate`
 * walks all pages; `select(.pull_request == null)` drops pull requests, which
 * the REST issues endpoint otherwise returns alongside issues. Used by the
 * `--swarm-floor` sweep to answer "is there any eligible work left?".
 */
function listOpenIssueNumbers(owner: string, repo: string): number[] {
  return parseIssueNumberLines(
    ghText(
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/issues?state=open&per_page=100`,
        '--jq',
        '.[] | select(.pull_request == null) | .number',
      ],
      GH_TEXT_LOOP_OPTIONS,
    ),
  );
}

/**
 * Parse the newline-delimited issue numbers emitted by the
 * `listOpenIssueNumbers` `gh api --jq` sweep into a deduped list of positive
 * integers. Only **full-integer** lines are kept: blank, partially-numeric
 * (`5abc`), or non-positive lines are dropped rather than truncated by
 * `Number.parseInt`, so an empty sweep yields `[]`. Exported so the parse
 * contract is unit-testable without a live `gh` call — pull requests are
 * already excluded upstream by the `select(.pull_request == null)` jq filter.
 */
export function parseIssueNumberLines(raw: string): number[] {
  return dedupeNumbers(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => Number.parseInt(line, 10)),
  );
}

function loadPolicy(policyPath: string): unknown {
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    return {};
  }
}

function resolveMarkerPrefix(config: unknown): string {
  const prefix = (config as { markerPrefix?: unknown } | null)?.markerPrefix;
  return typeof prefix === 'string' && prefix.length > 0
    ? prefix
    : DEFAULT_MARKER_PREFIX;
}

function resolveSuitabilityFloor(config: unknown): number {
  // Delegate range/default validation to the shared normalizer so the 1-5
  // rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    (config as { autopilotSuitability?: { floor?: unknown } } | null)
      ?.autopilotSuitability?.floor,
  );
}

function resolveSuitabilityEnabled(config: unknown): boolean {
  // Match resolveAutopilotSuitabilityEnabled in discover-orphan-filter.mts:
  // the kill switch is off only when explicitly set to `false`.
  return (
    (config as { autopilotSuitability?: { enabled?: unknown } } | null)
      ?.autopilotSuitability?.enabled !== false
  );
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const rawStatus = (error as { status?: unknown } | null)?.status;
    const status = typeof rawStatus === 'number' ? rawStatus : null;
    const stderr = String(
      (error as { stderr?: unknown } | null)?.stderr ?? '',
    ).trim();
    const stdout = String(
      (error as { stdout?: unknown } | null)?.stdout ?? '',
    ).trim();
    const prefix = `gh ${args.join(' ')}`;
    // Preserve stderr and stdout on the wrapped error so deriveGhHttpStatus
    // can recover the real HTTP status; the process exit status is always
    // 1 and is kept only for diagnostics.
    const wrapped = new Error(
      stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`,
    ) as Error & { status?: number | null; stderr?: string; stdout?: string };
    wrapped.status = status;
    wrapped.stderr = stderr;
    wrapped.stdout = stdout;
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

export function isInaccessibleIssueLookupError(error: unknown): boolean {
  const status = deriveGhHttpStatus(error);
  // Only a true 403/410/451 can be an inaccessible-issue downgrade.
  if (status === null || !INACCESSIBLE_HTTP_STATUSES.has(status)) {
    return false;
  }
  // Among those, downgrade only on visibility / integration-permission
  // wording. A 403 secondary-rate-limit (or an auth failure that somehow
  // surfaces as 403) must abort instead of being downgraded, so the regex
  // deliberately excludes generic "forbidden" / "requires authentication".
  const candidate = error as { stderr?: unknown; message?: unknown };
  const stderr = String(candidate.stderr ?? candidate.message ?? '');
  return /resource not accessible|not accessible by integration|visibility/i.test(
    stderr,
  );
}
