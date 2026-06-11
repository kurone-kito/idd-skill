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

const INACCESSIBLE_ISSUE_SENTINEL = Object.freeze({
  __iddLookupStatus: 'inaccessible',
});
const INACCESSIBLE_HTTP_STATUSES = new Set([403, 410, 451]);

type InaccessibleIssueSentinel = typeof INACCESSIBLE_ISSUE_SENTINEL;

/** One issue that passed every readiness filter. */
export interface ReadinessReadyIssue {
  number: number;
  title: string;
}

/** One issue removed by a readiness filter, with the failed reasons. */
export interface ReadinessFilteredIssue {
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
  warnings: { issueNumber: number; message: string }[];
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
  const authoringPolicy = resolveAuthoringGuardPolicy(loadPolicy(args.policy));

  const summary = await evaluateDiscoverReadiness(args.issueNumbers, {
    includeUnresolvable: args.includeUnresolvable,
    loadIssue: buildIssueLoader(owner, repo),
    loadIssueLabelEvents: buildIssueLabelEventsLoader(owner, repo),
    findRoadmapsByMarker: buildRoadmapMarkerResolver(owner, repo),
    authoringLabelName: authoringPolicy.labelName,
    authoringStaleAgeMs: authoringPolicy.staleAgeMs,
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

  const ready: ReadinessReadyIssue[] = [];
  const filteredOut: ReadinessFilteredIssue[] = [];
  const unresolvable: ReadinessUnresolvableReference[] = [];
  const warnings: { issueNumber: number; message: string }[] = [];
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
      });
      continue;
    }
    if (issue.state !== 'OPEN') {
      filteredOut.push({
        number: issue.number,
        title: issue.title,
        reasons: ['issue_not_open'],
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

    for (const marker of extractBlockedByRoadmapMarkers(issue.body)) {
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

    if (reasons.size === 0) {
      ready.push({
        number: issue.number,
        title: issue.title,
      });
      continue;
    }

    filteredOut.push({
      number: issue.number,
      title: issue.title,
      reasons: [...reasons].sort(),
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

export function extractBlockedByRoadmapMarkers(body: string): string[] {
  const matches = body.matchAll(
    /<!--\s*idd-skill-blocked-by:\s*([^\s>]+)\s*-->/gi,
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
    "ready": [{ "number": 123, "title": "..." }],
    "filteredOut": [{ "number": 124, "title": "...", "reasons": ["..."] }],
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
  const lines = ['number,title,status,reasons'];
  for (const item of summary.ready) {
    lines.push(`${item.number},${escapeCsv(item.title)},ready,`);
  }
  for (const item of summary.filteredOut) {
    lines.push(
      `${item.number},${escapeCsv(item.title)},filtered,${escapeCsv(item.reasons.join(';'))}`,
    );
  }
  return `${lines.join('\n')}\n`;
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
      const result = runGh(args, { allowStatuses: [404] }).trim();
      if (!result || result === 'null') {
        return null;
      }
      return JSON.parse(result);
    } catch (error) {
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

function buildRoadmapMarkerResolver(owner: string, repo: string) {
  return async (marker: string) => {
    const query = `repo:${owner}/${repo} is:issue in:body "<!-- idd-skill-roadmap-id: ${marker} -->"`;
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
  const candidate = error as { stderr?: unknown; message?: unknown };
  const stderr = String(candidate.stderr ?? candidate.message ?? '');
  return /resource not accessible|forbidden|requires authentication|visibility/i.test(
    stderr,
  );
}

function isMainModule(metaUrl: string): boolean {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  const scriptUrl = new URL(`file://${process.argv[1]}`);
  return metaUrl === scriptUrl.href;
}
