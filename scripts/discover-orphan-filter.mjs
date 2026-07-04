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
} from './authoring-label-guard.mjs';
import {
  DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
  normalizeAutopilotSuitabilityFloor,
  parseAutopilotSuitability,
  rankAndRouteBySuitability,
} from './autopilot-suitability.mjs';
import { effortOrdinal, parseEffort } from './effort.mjs';
import {
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
  isCliExecution,
} from './gh-exec.mjs';
import { createMarkerRegex } from './marker-regex.mjs';
import { normalizePolicyConfig, POLICY_DEFAULTS } from './policy-helpers.mjs';

const DEFAULT_MARKER_PREFIX = 'idd-skill';
if (isCliExecution(import.meta.url)) {
  runCli();
}
export function extractBlockedByReferences(body) {
  const references = [];
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
export function getOrphanFirstPolicy(config) {
  if (!config || typeof config !== 'object') {
    return 'none';
  }
  const commands = config.commands;
  if (
    commands &&
    typeof commands === 'object' &&
    typeof commands['orphan-first-policy'] === 'string'
  ) {
    return commands['orphan-first-policy'];
  }
  const orphanFirstPolicy = config.orphanFirstPolicy;
  if (typeof orphanFirstPolicy === 'string') {
    return orphanFirstPolicy;
  }
  return 'none';
}
export function classifyIssue(issue, options) {
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
  const refs = extractBlockedByReferences(body);
  if (refs.length === 0) {
    return { orphan: true, reason: 'orphan' };
  }
  const unresolved = [];
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
export function filterOrphanIssues(issues, options = {}) {
  const issueStateByNumber = new Map(options.issueStateByNumber ?? []);
  const fetchIssueStateByNumber =
    typeof options.fetchIssueStateByNumber === 'function'
      ? options.fetchIssueStateByNumber
      : () => 'UNRESOLVABLE';
  const filtered = {
    roadmap_marker: [],
    blocked_by_marker: [],
    blocked_label: [],
    authoring_label: [],
    blocked_by_open_reference: [],
    unresolvable_reference: [],
  };
  const orphans = [];
  const unresolvable = [];
  const warnings = [];
  for (const issue of issues) {
    const result = classifyIssue(issue, {
      issueStateByNumber,
      fetchIssueStateByNumber,
      markerPrefix: options.markerPrefix,
      authoringLabelName: options.authoringLabelName,
      blockedByHumanLabelName: options.blockedByHumanLabelName,
      needsDecisionLabelName: options.needsDecisionLabelName,
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
    const entry = {
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
function runCli() {
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
    openIssues.map((issue) => [issue.number, String(issue.state)]),
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
    blockedByHumanLabelName: policy.blockedByHumanLabelName,
    needsDecisionLabelName: policy.needsDecisionLabelName,
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
function parseArgs(argv) {
  const parsed = {
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
function loadPolicy(policyPath) {
  const defaultPath = resolve(process.cwd(), '.github/idd/config.json');
  const targetPath = policyPath
    ? resolve(process.cwd(), policyPath)
    : defaultPath;
  try {
    const config = JSON.parse(readFileSync(targetPath, 'utf8'));
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
      autopilotSuitabilityFloor: resolveAutopilotSuitabilityFloor(config),
      autopilotSuitabilityEnabled: resolveAutopilotSuitabilityEnabled(config),
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
      autopilotSuitabilityFloor: DEFAULT_AUTOPILOT_SUITABILITY_FLOOR,
      autopilotSuitabilityEnabled: true,
    };
  }
}
function resolveAutopilotSuitabilityFloor(config) {
  // Delegate range/default validation to the shared normalizer so the
  // 1-5 rule and the default cannot drift between modules.
  return normalizeAutopilotSuitabilityFloor(
    config?.autopilotSuitability?.floor,
  );
}
function resolveAutopilotSuitabilityEnabled(config) {
  return config?.autopilotSuitability?.enabled !== false;
}
function normalizeIssue(issue) {
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
function resolveIssueLabelEvents(issue, fetchLabelEventsByIssueNumber) {
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
function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === 'string') {
        return label;
      }
      return String(label?.name ?? '');
    })
    .filter(Boolean);
}
function resolveIssueState(
  number,
  issueStateByNumber,
  fetchIssueStateByNumber,
) {
  if (issueStateByNumber.has(number)) {
    return issueStateByNumber.get(number);
  }
  const state = fetchIssueStateByNumber(number);
  issueStateByNumber.set(number, state);
  return state;
}
function fetchIssueState(repoRef, issueNumber) {
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
function fetchIssueLabelEvents(repoRef, issueNumber) {
  const events = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = ghJson([
      'api',
      `repos/${repoRef}/issues/${issueNumber}/timeline?per_page=${pageSize}&page=${page}`,
    ]);
    events.push(...rawPage.filter((event) => event?.event === 'labeled'));
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return events;
}
function ghJson(args) {
  return JSON.parse(runGh(args).trim() || '[]');
}
function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}
function normalizeMarkerPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return DEFAULT_MARKER_PREFIX;
  }
  return prefix;
}
function normalizeAuthoringLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : 'status:authoring';
}
/** Resolve the configured `labels.blockedByHumanLabelName` (#1273). */
function normalizeBlockedByHumanLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.blockedByHumanLabelName;
}
/** Resolve the configured `labels.needsDecisionLabelName` (#1273). */
function normalizeNeedsDecisionLabelName(labelName) {
  return typeof labelName === 'string' && labelName.length > 0
    ? labelName
    : POLICY_DEFAULTS.labels.needsDecisionLabelName;
}
function fetchOpenIssues(repoRef) {
  const issues = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const rawPage = ghJson([
      'api',
      `repos/${repoRef}/issues?state=open&per_page=${pageSize}&page=${page}`,
    ]);
    const pageItems = rawPage
      .filter((item) => item?.pull_request === undefined)
      .map((item) => normalizeIssue(item));
    issues.push(...pageItems);
    if (rawPage.length < pageSize) {
      break;
    }
  }
  return issues;
}
