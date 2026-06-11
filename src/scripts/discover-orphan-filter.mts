#!/usr/bin/env node
// idd-generated-from: src/scripts/discover-orphan-filter.mts
//
// The scripts/discover-orphan-filter.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEFAULT_MARKER_PREFIX = 'idd-skill';
const BLOCKED_LABELS = new Set([
  'status:blocked-by-human',
  'status:needs-decision',
]);

/** Reasons that keep an issue out of the orphan candidate list. */
export type OrphanFilteredReason =
  | 'roadmap_marker'
  | 'blocked_by_marker'
  | 'blocked_label'
  | 'authoring_label'
  | 'blocked_by_open_reference'
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
}

interface FilterOrphanIssuesOptions {
  issueStateByNumber?: Iterable<[number, string]>;
  fetchIssueStateByNumber?: (issueNumber: number) => string;
  fetchLabelEventsByIssueNumber?: (issueNumber: number) => unknown[];
  markerPrefix?: unknown;
  authoringLabelName?: unknown;
  authoringStaleAgeMs?: number;
  autopilotSuitabilityFloor?: number;
  autopilotSuitabilityEnabled?: boolean;
  autopilot?: boolean;
  now?: Date | string;
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
}

interface ParsedArgs {
  owner: string;
  repo: string;
  policy: string;
  pr: number | null;
  help: boolean;
  now: string;
  autopilot: boolean;
}

if (isCliExecution()) {
  runCli();
}

export function extractBlockedByReferences(body: unknown): number[] {
  const references: number[] = [];
  const regex = /^\s*Blocked by #(\d+)\b.*$/gim;
  let match = regex.exec(String(body ?? ''));
  while (match) {
    const number = Number.parseInt(match[1], 10);
    if (Number.isInteger(number) && number > 0) {
      references.push(number);
    }
    match = regex.exec(String(body ?? ''));
  }
  return references;
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
  const roadmapMarkerRegex = createMarkerRegex(markerPrefix, 'roadmap-id');
  const blockedMarkerRegex = createMarkerRegex(markerPrefix, 'blocked-by');

  if (roadmapMarkerRegex.test(body)) {
    return { orphan: false, reason: 'roadmap_marker' };
  }

  if (blockedMarkerRegex.test(body)) {
    return { orphan: false, reason: 'blocked_by_marker' };
  }

  const blockedLabel = [...labels].find((label) => BLOCKED_LABELS.has(label));
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

  const refs = extractBlockedByReferences(body);
  if (refs.length === 0) {
    return { orphan: true, reason: 'orphan' };
  }

  const unresolved: number[] = [];
  for (const ref of refs) {
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
    }
  }

  if (unresolved.length > 0) {
    return {
      orphan: false,
      reason: 'unresolvable_reference',
      details: unresolved,
    };
  }

  return { orphan: true, reason: 'blocked_references_closed' };
}

export function filterOrphanIssues(
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

  for (const issue of issues) {
    const result = classifyIssue(issue, {
      issueStateByNumber,
      fetchIssueStateByNumber,
      markerPrefix: options.markerPrefix,
      authoringLabelName: options.authoringLabelName,
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

  // Rank the orphan candidate list by authored autopilot-suitability
  // score. Pre-sort by issue number so equal scores resolve by lowest
  // number (the Step 2 tie-break) rather than by API fetch order.
  // Below-floor routing is opt-in (autopilot runs only): in attended
  // discovery the low-score issues stay selectable, just ranked last.
  // Advisory throughout — the A4.5/A5 gates still run on any selected
  // candidate, and unscored issues are never routed out (fail-safe).
  const orphansByNumber = [...orphans].sort(
    (left, right) => left.number - right.number,
  );
  const { ranked, routedToHuman } = rankAndRouteBySuitability(orphansByNumber, {
    floor:
      options.autopilotSuitabilityFloor ?? DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
    enabled: options.autopilotSuitabilityEnabled !== false,
    routeBelowFloor: options.autopilot === true,
    getScore: (orphan) => orphan.autopilotSuitability,
  });

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

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const repoRef = `${owner}/${repo}`;
  const policy = loadPolicy(args.policy);

  const openIssues = fetchOpenIssues(repoRef);
  const openStateByNumber = new Map(
    openIssues.map(
      (issue) => [issue.number, String(issue.state)] as [number, string],
    ),
  );

  const result = filterOrphanIssues(openIssues, {
    issueStateByNumber: openStateByNumber,
    fetchIssueStateByNumber: (issueNumber) =>
      fetchIssueState(repoRef, issueNumber),
    fetchLabelEventsByIssueNumber: (issueNumber) =>
      fetchIssueLabelEvents(repoRef, issueNumber),
    markerPrefix: policy.markerPrefix,
    authoringLabelName: policy.authoringLabelName,
    authoringStaleAgeMs: policy.authoringStaleAgeMs,
    autopilotSuitabilityFloor: policy.autopilotSuitabilityFloor,
    autopilotSuitabilityEnabled: policy.autopilotSuitabilityEnabled,
    autopilot: args.autopilot,
    now: args.now || new Date(),
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

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    owner: '',
    repo: '',
    policy: '',
    pr: null,
    help: false,
    now: '',
    autopilot: false,
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
  node scripts/discover-orphan-filter.mjs [--owner <owner>] [--repo <repo>] [--policy <path>] [--pr <number>] [--now <ISO8601>] [--autopilot]

Output schema:
{
  "repository": {"owner": "...", "repo": "..."},
  "diagnostics": {"pr": 404},
  "policy": {"source": "...", "orphanFirstPolicy": "none|maintainer-approved|public-disabled", "markerPrefix": "...", "authoringLabelName": "...", "authoringStaleAge": "...", "autopilotSuitabilityFloor": 3, "autopilotSuitabilityEnabled": true},
  "orphans": [{"number": 1, "title": "...", "state": "OPEN", "reason": "orphan|blocked_references_closed", "url": "...", "autopilotSuitability": 4}],
  "routed_to_human": [{"number": 2, "title": "...", "state": "OPEN", "reason": "orphan", "url": "...", "autopilotSuitability": 1}],
  "filtered": {
    "roadmap_marker": [...],
    "blocked_by_marker": [...],
    "blocked_label": [...],
    "authoring_label": [...],
    "blocked_by_open_reference": [...],
    "unresolvable_reference": [...]
  },
  "unresolvable": [{"issue": 1, "reference": 2, "reason": "issue-not-found-or-inaccessible"}],
  "warnings": [{"issueNumber": 1, "message": "Warning: ..."}],
  "counts": {"scanned": 0, "orphans": 0, "routed_to_human": 0, "filtered": {...}, "unresolvable": 0}
}

orphans are always ranked by authored autopilot-suitability score (high
first; equal scores tie-break by lowest issue number). With --autopilot
(autopilot runs), orphans whose score is below autopilotSuitabilityFloor
(default 3) are moved to routed_to_human; without it (attended runs) they
stay in orphans, ranked last. A missing or out-of-range score is treated
as no score: the issue stays in orphans and is never routed out.
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
    };
    const authoringPolicy = resolveAuthoringGuardPolicy(config);
    return {
      source: targetPath,
      orphanFirstPolicy: getOrphanFirstPolicy(config),
      markerPrefix: normalizeMarkerPrefix(config.markerPrefix),
      authoringLabelName: authoringPolicy.labelName,
      authoringStaleAge: authoringPolicy.staleAge,
      authoringStaleAgeMs: authoringPolicy.staleAgeMs,
      autopilotSuitabilityFloor: resolveAutopilotSuitabilityFloor(config),
      autopilotSuitabilityEnabled: resolveAutopilotSuitabilityEnabled(config),
    };
  } catch {
    const authoringPolicy = resolveAuthoringGuardPolicy({});
    return {
      source: targetPath,
      orphanFirstPolicy: 'none',
      markerPrefix: DEFAULT_MARKER_PREFIX,
      authoringLabelName: authoringPolicy.labelName,
      authoringStaleAge: authoringPolicy.staleAge,
      authoringStaleAgeMs: authoringPolicy.staleAgeMs,
      autopilotSuitabilityFloor: DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
      autopilotSuitabilityEnabled: true,
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
    const state = ghText([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repoRef,
      '--json',
      'state',
      '--jq',
      '.state',
    ]);
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

function ghText(args: string[]): string {
  return runGh(args).trim();
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

function isCliExecution(): boolean {
  return Boolean(
    process.argv[1] &&
      fileURLToPath(import.meta.url) === resolve(process.argv[1]),
  );
}

function createMarkerRegex(prefix: string, suffix: string): RegExp {
  return new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-${suffix}\\b[\\s\\S]*?-->`,
    'i',
  );
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
