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
import type { LabelEvent } from './authoring-label-guard.mts';
import {
  buildAuthoringLabelWarning,
  resolveAuthoringGuardPolicy,
} from './authoring-label-guard.mts';
import {
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
} from './autopilot-suitability.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import { escapeRegex } from './marker-regex.mts';

const DEFAULT_MARKER_PREFIX = 'idd-skill';

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
}

type CachedIssue = NormalizedIssue | InaccessibleIssueSentinel | null;

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.issueNumbers.length === 0) {
    throw new Error(
      'missing required --issue <number> (repeatable) or --issues <n1,n2,...>',
    );
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const policyConfig = loadPolicy(args.policy);
  const authoringPolicy = resolveAuthoringGuardPolicy(policyConfig);
  const markerPrefix = resolveMarkerPrefix(policyConfig);

  const summary = await evaluateDiscoverReadiness(args.issueNumbers, {
    includeUnresolvable: args.includeUnresolvable,
    loadIssue: buildIssueLoader(owner, repo),
    loadIssueLabelEvents: buildIssueLabelEventsLoader(owner, repo),
    findRoadmapsByMarker: buildRoadmapMarkerResolver(owner, repo, markerPrefix),
    authoringLabelName: authoringPolicy.labelName,
    authoringStaleAgeMs: authoringPolicy.staleAgeMs,
    markerPrefix,
    autopilotSuitabilityFloor: resolveSuitabilityFloor(policyConfig),
    autopilotSuitabilityEnabled: resolveSuitabilityEnabled(policyConfig),
    now: args.now || new Date(),
  });

  if (args.csv) {
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
    if (labels.has('status:blocked-by-human')) {
      reasons.add('label:status:blocked-by-human');
    }
    if (labels.has('status:needs-decision')) {
      reasons.add('label:status:needs-decision');
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
        !isParentEpicIssue(dependencyIssue)
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

export function extractBlockedByIssueNumbers(body: string): number[] {
  const matches = body.matchAll(/^\s*Blocked by\s+#(\d+)\b/gim);
  return dedupeNumbers(
    [...matches].map((match) => Number.parseInt(match[1], 10)),
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
  const explicitDependencies = [
    ...body.matchAll(/^\s*Depends on\s+#(\d+)\b/gim),
  ];
  const taskListDependencies = [
    ...body.matchAll(/^\s*-\s*\[(?: |x)\]\s+#(\d+)\b/gim),
  ];
  return dedupeNumbers([
    ...explicitDependencies.map((match) => Number.parseInt(match[1], 10)),
    ...taskListDependencies.map((match) => Number.parseInt(match[1], 10)),
  ]);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: {
    issueNumbers: (number | string)[];
    includeUnresolvable: boolean;
    csv: boolean;
    owner: string;
    repo: string;
    policy: string;
    now: string;
  } = {
    issueNumbers: [],
    includeUnresolvable: false,
    csv: false,
    owner: '',
    repo: '',
    policy: '',
    now: '',
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

Output schema (JSON mode):
  {
    "ready": [{ "number": 123, "title": "...", "autopilotSuitability": 4, "belowFloor": false }],
    "filteredOut": [{ "number": 124, "title": "...", "reasons": ["..."], "autopilotSuitability": null, "belowFloor": false }],
    "unresolvable": [{ "issueNumber": 124, "kind": "...", "reference": "...", "reason": "..." }],
    "warnings": [{ "issueNumber": 124, "message": "Warning: ..." }],
    "summary": { "total": 2, "readyCount": 1, "filteredCount": 1, "unresolvableCount": 0, "filteredByReason": { "...": 1 } }
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

function isParentEpicIssue(issue: NormalizedIssue): boolean {
  if (issue.title.toLowerCase().startsWith('roadmap')) {
    return true;
  }
  return issue.labels.has('roadmap');
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

function ghText(args: string[]): string {
  return runGh(args).trim();
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

function isMainModule(metaUrl: string): boolean {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  // Compare filesystem paths instead of building a file:// URL from
  // argv[1], which mis-parses Windows drive-letter paths.
  return fileURLToPath(metaUrl) === resolve(process.argv[1]);
}
