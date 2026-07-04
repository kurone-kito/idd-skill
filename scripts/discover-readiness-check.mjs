#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-readiness-check.mts
//
// The scripts/discover-readiness-check.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthoringLabelWarning,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mjs';
import {
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
} from './autopilot-suitability.mjs';
import { GH_TEXT_LOOP_OPTIONS, ghText } from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { stripMarkdownCodeRegions } from './markdown-code.mjs';
import { escapeRegex } from './marker-regex.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';

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
// `isMainModule` CLI block on purpose so it is initialized when the CLI path
// runs `extractBlockedByIssueNumbers` (a const declared after that block would
// be in the temporal dead zone).
const DEPENDENCY_LINE_PREFIX = String.raw`^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?`;
const INACCESSIBLE_ISSUE_SENTINEL = Object.freeze({
  __iddLookupStatus: 'inaccessible',
});
const INACCESSIBLE_HTTP_STATUSES = new Set([403, 410, 451]);
if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
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
export async function evaluateDiscoverReadiness(issueNumbers, options) {
  const {
    includeUnresolvable = false,
    loadIssue,
    findRoadmapsByMarker,
    loadIssueLabelEvents,
    authoringLabelName = 'status:authoring',
    authoringStaleAgeMs = 4 * 60 * 60 * 1000,
    markerPrefix,
    roadmapLabelName = POLICY_DEFAULTS.labels.roadmapLabelName,
    blockedByHumanLabelName = POLICY_DEFAULTS.labels.blockedByHumanLabelName,
    needsDecisionLabelName = POLICY_DEFAULTS.labels.needsDecisionLabelName,
    autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled,
    now = new Date(),
  } = options ?? {};
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
  const suitabilitySignal = (body) => {
    if (!suitabilityEnabled) {
      return { autopilotSuitability: null, belowFloor: false };
    }
    const score = parseAutopilotSuitability(body, resolvedMarkerPrefix);
    return {
      autopilotSuitability: score,
      belowFloor: score !== null && score < suitabilityFloor,
    };
  };
  const ready = [];
  const filteredOut = [];
  const unresolvable = [];
  const warnings = [];
  const issueCache = new Map();
  const markerCache = new Map();
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
    const reasons = new Set();
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
/**
 * Reduce a full readiness summary to the swarm-floor answer: the ready issues
 * at or above the configured floor (a "no score" issue is never below floor,
 * so it stays eligible, matching the discovery ranker), plus counts. Pure so
 * the `--swarm-floor` CLI sweep and the tests share one definition.
 */
export function summarizeSwarmFloorEligibility(summary) {
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
export function parseSwarmFloorArg(value) {
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
 * begins with `keyword` followed by horizontal whitespace and at least one
 * `#N`. From there `consumeDependencyRefList` collects the contiguous
 * dependency-ref list, so `Blocked by #A, #B, #C` (comma- or space-separated)
 * yields `[A, B, C]`. The keyword-to-ref gap is `[ \t]+` (not `\s+`) so it
 * cannot span a newline and swallow a bare `#N` on the following line, and the
 * `.*$` capture plus the `m` flag (no `s` flag) keeps the match on the single
 * keyword line. Callers pass a code-region-stripped body, so a quoted example
 * line is already masked (see `DEPENDENCY_LINE_PREFIX`).
 */
function extractKeywordLineRefs(body, keyword) {
  const linePattern = new RegExp(
    `${DEPENDENCY_LINE_PREFIX}${escapeRegex(keyword)}[ \\t]+(#\\d+.*)$`,
    'gim',
  );
  const numbers = [];
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
function consumeDependencyRefList(segment) {
  const numbers = [];
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
export function extractBlockedByIssueNumbers(body) {
  return dedupeNumbers(
    extractKeywordLineRefs(stripMarkdownCodeRegions(body), 'Blocked by'),
  );
}
export function extractBlockedByRoadmapMarkers(
  body,
  markerPrefix = DEFAULT_MARKER_PREFIX,
) {
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
export function extractDependencyIssueNumbers(body) {
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
function parseArgs(argv) {
  const parsed = {
    issueNumbers: [],
    includeUnresolvable: false,
    csv: false,
    owner: '',
    repo: '',
    policy: '',
    now: '',
    swarmFloor: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--issue') {
      parsed.issueNumbers.push(value ?? '');
      index += 1;
      continue;
    }
    if (token === '--issues') {
      parsed.issueNumbers.push(...String(value ?? '').split(','));
      index += 1;
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
    if (token === '--now') {
      parsed.now = value ?? '';
      index += 1;
      continue;
    }
    if (token === '--swarm-floor') {
      parsed.swarmFloor = parseSwarmFloorArg(value ?? '');
      index += 1;
      continue;
    }
    if (token === '--include-unresolvable') {
      parsed.includeUnresolvable = true;
      continue;
    }
    if (token === '--csv') {
      parsed.csv = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return {
    ...parsed,
    issueNumbers: normalizeIssueNumbers(parsed.issueNumbers),
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-readiness-check.mjs --issue <number> [--issue <number> ...]
  node scripts/discover-readiness-check.mjs --issues <n1,n2,...>
    [--include-unresolvable] [--csv] [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>]
  node scripts/discover-readiness-check.mjs --swarm-floor <N>
    [--owner <owner>] [--repo <repo>] [--policy <path>] [--now <ISO8601>]

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
function normalizeIssueNumbers(values) {
  const parsed = values
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(parsed)];
}
function dedupeNumbers(values) {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
}
function normalizeIssue(issue) {
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
function normalizeLabels(labelsInput) {
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
          return String(label?.name ?? '');
        })
        .filter(Boolean),
    );
  }
  return new Set();
}
function isParentEpicIssue(
  issue,
  roadmapLabelName = POLICY_DEFAULTS.labels.roadmapLabelName,
) {
  // Title heuristic is intentionally independent of the configured roadmap
  // label (#1273): it is a naming-convention signal on free-form title text,
  // not a label comparison, so it is not wired to `labels.roadmapLabelName`.
  if (issue.title.toLowerCase().startsWith('roadmap')) {
    return true;
  }
  return issue.labels.has(roadmapLabelName);
}
async function getIssue(issueNumber, cache, loadIssue) {
  if (cache.has(issueNumber)) {
    return cache.get(issueNumber) ?? null;
  }
  const rawIssue = await loadIssue(issueNumber);
  const issue = isInaccessibleIssue(rawIssue)
    ? INACCESSIBLE_ISSUE_SENTINEL
    : rawIssue
      ? normalizeIssue(rawIssue)
      : null;
  cache.set(issueNumber, issue);
  return issue;
}
async function getRoadmapsByMarker(marker, cache, findRoadmapsByMarker) {
  const cached = cache.get(marker);
  if (cached) {
    return cached;
  }
  const rawMatches = await findRoadmapsByMarker(marker);
  const matches = (rawMatches ?? [])
    .map((issue) => normalizeIssue(issue))
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0);
  cache.set(marker, matches);
  return matches;
}
async function resolveLabelEvents(issue, loadIssueLabelEvents) {
  if (
    issue.labelEvents.length > 0 ||
    typeof loadIssueLabelEvents !== 'function'
  ) {
    return issue.labelEvents;
  }
  try {
    const events = await loadIssueLabelEvents(issue.number);
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}
function countReasons(filteredOut) {
  const counts = {};
  for (const item of filteredOut) {
    for (const reason of item.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}
function renderCsv(summary) {
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
function formatScore(score) {
  return score === null ? '' : String(score);
}
function escapeCsv(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
function buildIssueLoader(owner, repo) {
  return async (issueNumber) => {
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
function buildIssueLabelEventsLoader(owner, repo) {
  return async (issueNumber) => {
    const repoRef = `${owner}/${repo}`;
    return fetchIssueLabelEvents(repoRef, issueNumber);
  };
}
function fetchIssueLabelEvents(repoRef, issueNumber) {
  const events = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = JSON.parse(
      runGh([
        'api',
        `repos/${repoRef}/issues/${issueNumber}/timeline?per_page=${pageSize}&page=${page}`,
      ]).trim() || '[]',
    );
    const labeled = rawPage.filter((event) => event?.event === 'labeled');
    events.push(...labeled);
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return events;
}
export function buildRoadmapMarkerSearchQuery(
  owner,
  repo,
  markerPrefix,
  marker,
) {
  // Thread the configurable prefix into the GitHub search query WITHOUT
  // regex-escaping: this is a literal `in:body` search term, so escaping the
  // prefix would corrupt the exact marker string the resolver looks for.
  return `repo:${owner}/${repo} is:issue in:body "<!-- ${markerPrefix}-roadmap-id: ${marker} -->"`;
}
export function buildRoadmapMarkerResolver(owner, repo, markerPrefix) {
  return async (marker) => {
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
function listOpenIssueNumbers(owner, repo) {
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
export function parseIssueNumberLines(raw) {
  return dedupeNumbers(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => Number.parseInt(line, 10)),
  );
}
function loadPolicy(policyPath) {
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    return {};
  }
}
function resolveMarkerPrefix(config) {
  const prefix = config?.markerPrefix;
  return typeof prefix === 'string' && prefix.length > 0
    ? prefix
    : DEFAULT_MARKER_PREFIX;
}
function resolveSuitabilityFloor(config) {
  // Delegate range/default validation to the shared normalizer so the 1-5
  // rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    config?.autopilotSuitability?.floor,
  );
}
function resolveSuitabilityEnabled(config) {
  // Match resolveAutopilotSuitabilityEnabled in discover-orphan-filter.mts:
  // the kill switch is off only when explicitly set to `false`.
  return config?.autopilotSuitability?.enabled !== false;
}
function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const rawStatus = error?.status;
    const status = typeof rawStatus === 'number' ? rawStatus : null;
    const stderr = String(error?.stderr ?? '').trim();
    const stdout = String(error?.stdout ?? '').trim();
    const prefix = `gh ${args.join(' ')}`;
    // Preserve stderr and stdout on the wrapped error so deriveGhHttpStatus
    // can recover the real HTTP status; the process exit status is always
    // 1 and is kept only for diagnostics.
    const wrapped = new Error(
      stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`,
    );
    wrapped.status = status;
    wrapped.stderr = stderr;
    wrapped.stdout = stdout;
    throw wrapped;
  }
}
function isInaccessibleIssue(value) {
  return value?.__iddLookupStatus === 'inaccessible';
}
export function isInaccessibleIssueLookupError(error) {
  const status = deriveGhHttpStatus(error);
  // Only a true 403/410/451 can be an inaccessible-issue downgrade.
  if (status === null || !INACCESSIBLE_HTTP_STATUSES.has(status)) {
    return false;
  }
  // Among those, downgrade only on visibility / integration-permission
  // wording. A 403 secondary-rate-limit (or an auth failure that somehow
  // surfaces as 403) must abort instead of being downgraded, so the regex
  // deliberately excludes generic "forbidden" / "requires authentication".
  const candidate = error;
  const stderr = String(candidate.stderr ?? candidate.message ?? '');
  return /resource not accessible|not accessible by integration|visibility/i.test(
    stderr,
  );
}
function isMainModule(metaUrl) {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  // Compare filesystem paths instead of building a file:// URL from
  // argv[1], which mis-parses Windows drive-letter paths.
  return fileURLToPath(metaUrl) === resolve(process.argv[1]);
}
