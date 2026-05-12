#!/usr/bin/env node

import { execFileSync } from "node:child_process";

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.issueNumbers.length === 0) {
    throw new Error("missing required --issue <number> (repeatable) or --issues <n1,n2,...>");
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);

  const summary = await evaluateDiscoverReadiness(args.issueNumbers, {
    includeUnresolvable: args.includeUnresolvable,
    loadIssue: buildIssueLoader(owner, repo),
    findRoadmapsByMarker: buildRoadmapMarkerResolver(owner, repo),
  });

  if (args.csv) {
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
  } = options ?? {};
  if (typeof loadIssue !== "function") {
    throw new Error("evaluateDiscoverReadiness requires loadIssue(issueNumber)");
  }
  if (typeof findRoadmapsByMarker !== "function") {
    throw new Error("evaluateDiscoverReadiness requires findRoadmapsByMarker(markerId)");
  }

  const ready = [];
  const filteredOut = [];
  const unresolvable = [];
  const issueCache = new Map();
  const markerCache = new Map();

  for (const issueNumber of normalizeIssueNumbers(issueNumbers)) {
    const issue = await getIssue(issueNumber, issueCache, loadIssue);
    if (!issue) {
      unresolvable.push({
        issueNumber,
        kind: "issue",
        reference: `#${issueNumber}`,
        reason: "issue_not_found",
      });
      filteredOut.push({
        number: issueNumber,
        title: "",
        reasons: ["issue_not_found"],
      });
      continue;
    }
    if (issue.state !== "OPEN") {
      filteredOut.push({
        number: issue.number,
        title: issue.title,
        reasons: ["issue_not_open"],
      });
      continue;
    }

    const reasons = new Set();
    const labels = normalizeLabels(issue.labels);
    if (labels.has("status:blocked-by-human")) {
      reasons.add("label:status:blocked-by-human");
    }
    if (labels.has("status:needs-decision")) {
      reasons.add("label:status:needs-decision");
    }

    for (const dependencyNumber of extractDependencyIssueNumbers(issue.body)) {
      const dependencyIssue = await getIssue(dependencyNumber, issueCache, loadIssue);
      if (!dependencyIssue) {
        reasons.add("unresolvable_dependency_issue");
        unresolvable.push({
          issueNumber: issue.number,
          kind: "dependency",
          reference: `#${dependencyNumber}`,
          reason: "issue_not_found",
        });
        continue;
      }
      if (dependencyIssue.state === "OPEN" && !isParentEpicIssue(dependencyIssue)) {
        reasons.add(`open_dependency_issue:#${dependencyNumber}`);
      }
    }

    for (const blockedNumber of extractBlockedByIssueNumbers(issue.body)) {
      const blockedIssue = await getIssue(blockedNumber, issueCache, loadIssue);
      if (!blockedIssue) {
        reasons.add("unresolvable_blocked_by_issue");
        unresolvable.push({
          issueNumber: issue.number,
          kind: "blocked_by_issue",
          reference: `#${blockedNumber}`,
          reason: "issue_not_found",
        });
        continue;
      }
      if (blockedIssue.state === "OPEN") {
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
        reasons.add("unresolvable_blocked_by_marker");
        unresolvable.push({
          issueNumber: issue.number,
          kind: "blocked_by_marker",
          reference: marker,
          reason: "roadmap_marker_not_found",
        });
        continue;
      }
      if (markerMatches.some((candidate) => candidate.state === "OPEN")) {
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
    summary: {
      total: ready.length + filteredOut.length,
      readyCount: ready.length,
      filteredCount: filteredOut.length,
      unresolvableCount: unresolvable.length,
      filteredByReason,
    },
  };
}

export function extractBlockedByIssueNumbers(body) {
  const matches = body.matchAll(/^\s*Blocked by\s+#(\d+)\b/gim);
  return dedupeNumbers([...matches].map((match) => Number.parseInt(match[1], 10)));
}

export function extractBlockedByRoadmapMarkers(body) {
  const matches = body.matchAll(/<!--\s*idd-skill-blocked-by:\s*([^\s>]+)\s*-->/gi);
  return [...new Set([...matches].map((match) => match[1]))];
}

export function extractDependencyIssueNumbers(body) {
  const explicitDependencies = [...body.matchAll(/^\s*Depends on\s+#(\d+)\b/gim)];
  const taskListDependencies = [...body.matchAll(/^\s*-\s*\[(?: |x)\]\s+#(\d+)\b/gim)];
  return dedupeNumbers([
    ...explicitDependencies.map((match) => Number.parseInt(match[1], 10)),
    ...taskListDependencies.map((match) => Number.parseInt(match[1], 10)),
  ]);
}

function parseArgs(argv) {
  const parsed = {
    issueNumbers: [],
    includeUnresolvable: false,
    csv: false,
    owner: "",
    repo: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--issue") {
      parsed.issueNumbers.push(value ?? "");
      index += 1;
      continue;
    }
    if (token === "--issues") {
      parsed.issueNumbers.push(...String(value ?? "").split(","));
      index += 1;
      continue;
    }
    if (token === "--owner") {
      parsed.owner = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--include-unresolvable") {
      parsed.includeUnresolvable = true;
      continue;
    }
    if (token === "--csv") {
      parsed.csv = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  parsed.issueNumbers = normalizeIssueNumbers(parsed.issueNumbers);
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/discover-readiness-check.mjs --issue <number> [--issue <number> ...]
  node scripts/discover-readiness-check.mjs --issues <n1,n2,...>
    [--include-unresolvable] [--csv] [--owner <owner>] [--repo <repo>]

Output schema (JSON mode):
  {
    "ready": [{ "number": 123, "title": "..." }],
    "filteredOut": [{ "number": 124, "title": "...", "reasons": ["..."] }],
    "unresolvable": [{ "issueNumber": 124, "kind": "...", "reference": "...", "reason": "..." }],
    "summary": { "total": 2, "readyCount": 1, "filteredCount": 1, "unresolvableCount": 0, "filteredByReason": { "...": 1 } }
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
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function normalizeIssue(issue) {
  return {
    number: Number.parseInt(String(issue.number ?? issue.id ?? 0), 10),
    title: String(issue.title ?? ""),
    state: String(issue.state ?? "").toUpperCase(),
    body: String(issue.body ?? ""),
    labels: normalizeLabels(issue.labels),
    url: String(issue.url ?? ""),
  };
}

function normalizeLabels(labelsInput) {
  if (!labelsInput) {
    return new Set();
  }
  if (labelsInput instanceof Set) {
    return new Set([...labelsInput].map((label) => String(label ?? "")).filter(Boolean));
  }
  if (Array.isArray(labelsInput)) {
    return new Set(labelsInput.map((label) => {
      if (typeof label === "string") {
        return label;
      }
      return String(label?.name ?? "");
    }).filter(Boolean));
  }
  return new Set();
}

function isParentEpicIssue(issue) {
  if (issue.title.toLowerCase().startsWith("roadmap")) {
    return true;
  }
  return issue.labels.has("roadmap");
}

async function getIssue(issueNumber, cache, loadIssue) {
  if (cache.has(issueNumber)) {
    return cache.get(issueNumber);
  }
  const rawIssue = await loadIssue(issueNumber);
  const issue = rawIssue ? normalizeIssue(rawIssue) : null;
  cache.set(issueNumber, issue);
  return issue;
}

async function getRoadmapsByMarker(marker, cache, findRoadmapsByMarker) {
  if (cache.has(marker)) {
    return cache.get(marker);
  }
  const rawMatches = await findRoadmapsByMarker(marker);
  const matches = (rawMatches ?? [])
    .map((issue) => normalizeIssue(issue))
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0);
  cache.set(marker, matches);
  return matches;
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
  const lines = ["number,title,status,reasons"];
  for (const item of summary.ready) {
    lines.push(`${item.number},${escapeCsv(item.title)},ready,`);
  }
  for (const item of summary.filteredOut) {
    lines.push(`${item.number},${escapeCsv(item.title)},filtered,${escapeCsv(item.reasons.join(";"))}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function buildIssueLoader(owner, repo) {
  return async (issueNumber) => {
    const args = [
      "api",
      `repos/${owner}/${repo}/issues/${issueNumber}`,
      "--jq",
      ".",
    ];
    const result = runGh(args, { allowStatuses: [404] }).trim();
    if (!result || result === "null") {
      return null;
    }
    return JSON.parse(result);
  };
}

function buildRoadmapMarkerResolver(owner, repo) {
  return async (marker) => {
    const query = `repo:${owner}/${repo} is:issue in:body "<!-- idd-skill-roadmap-id: ${marker} -->"`;
    const encodedQuery = encodeURIComponent(query);
    const result = runGh([
      "api",
      `search/issues?q=${encodedQuery}&per_page=100`,
      "--jq",
      ".items",
    ]).trim();
    return JSON.parse(result || "[]");
  };
}

function ghText(args) {
  return runGh(args).trim();
}

function runGh(args, options = {}) {
  const {
    allowStatuses = [],
  } = options;

  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const status = typeof error.status === "number" ? error.status : null;
    if (status !== null && allowStatuses.includes(status)) {
      return "";
    }
    const stderr = String(error.stderr ?? "").trim();
    const prefix = `gh ${args.join(" ")}`;
    throw new Error(stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`);
  }
}

function isMainModule(metaUrl) {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  const scriptUrl = new URL(`file://${process.argv[1]}`);
  return metaUrl === scriptUrl.href;
}
