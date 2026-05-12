#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isStaleAt, parseClaimComment, parseForcedHandoffComment, parseReleaseComment } from "./protocol-helpers.mjs";

const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_CLAIM_PATTERN = /^<!--\s*claimed-by:\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+branch:\s+([^\s>]+)\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i;
const LEGACY_RELEASE_PATTERN = /^<!--\s*unclaimed-by:\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*-->(?:\s*|\s*\n\s*_[^\n]*\bIDD\b[^\n]*_\s*)$/i;

if (isCliExecution()) {
  runCli();
}

export function evaluateResumeClaimRouting(input, options = {}) {
  const nowIso = normalizeIso(input.now) ?? normalizeIso(new Date().toISOString());
  const staleAgeMs = normalizeStaleAgeMs(input.staleAgeMs);
  const trustedAuthor = typeof options.isTrustedAuthor === "function"
    ? options.isTrustedAuthor
    : () => true;

  const events = normalizeEvents(input.events).filter((event) => trustedAuthor(event.author?.login ?? ""));
  const state = resolveClaimState(events, nowIso, staleAgeMs);
  const claimIdChecked = normalizeToken(input.claimId);
  const sameSecondContenders = state.activeClaim
    ? findSameSecondContenders(events, state.activeClaim)
    : [];
  const laterCompetingClaim = state.activeClaim
    ? findLaterCompetingClaim(events, state.activeClaim)
    : null;

  const warnings = [...state.warnings];
  let routeState = "unclaimed";
  let action = "re_claim";
  let reason = "no-active-claim";

  if (state.mode === "legacy-only") {
    if (!state.legacyClaim) {
      routeState = "unclaimed";
      action = "re_claim";
      reason = "legacy-absent";
    } else if (state.legacyReleased) {
      routeState = "unclaimed";
      action = "re_claim";
      reason = "legacy-released";
    } else if (isStaleByAge(state.legacyClaim.createdAt, nowIso, staleAgeMs)) {
      routeState = "stale";
      action = "takeover";
      reason = "legacy-claim-stale";
    } else {
      routeState = "non_inheritable";
      action = "stop";
      reason = "legacy-claim-non-stale";
    }
  } else if (!state.activeClaim) {
    routeState = "unclaimed";
    action = "re_claim";
    reason = "no-active-claim";
  } else if (laterCompetingClaim) {
    routeState = "disputed";
    action = "stop";
    reason = "later-competing-claim";
  } else if (claimIdChecked && claimIdChecked === state.activeClaim.claimId) {
    routeState = "already_owned";
    action = "keep";
    reason = "claim-id-match";
  } else if (claimIdChecked && sameSecondContenders.includes(claimIdChecked)) {
    routeState = "disputed";
    action = "stop";
    reason = "same-second-claim-tie-break-loss";
  } else if (isStaleByAge(state.activeClaim.createdAt, nowIso, staleAgeMs)) {
    routeState = "stale";
    action = "takeover";
    reason = "active-claim-stale";
  } else {
    routeState = "non_inheritable";
    action = "stop";
    reason = "active-claim-non-stale";
  }

  return {
    state: routeState,
    action,
    reason,
    claim_id_checked: claimIdChecked || null,
    active_claim: routeState === "unclaimed"
      ? null
      : state.activeClaim
      ? {
        agent_id: state.activeClaim.agentId,
        claim_id: state.activeClaim.claimId,
        created_at: state.activeClaim.createdAt,
        branch: state.activeClaim.branch,
      }
      : state.legacyClaim
        ? {
          agent_id: state.legacyClaim.agentId,
          claim_id: null,
          created_at: state.legacyClaim.createdAt,
          branch: state.legacyClaim.branch,
        }
        : null,
    stale_age_ms: staleAgeMs,
    now: nowIso,
    warnings,
    evidence: {
      trusted_event_count: events.length,
      new_format_claim_seen: state.mode === "new-format",
      legacy_claim_seen: state.mode === "legacy-only",
      same_second_contenders: sameSecondContenders,
      later_competing_claim: laterCompetingClaim,
    },
  };
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error("--issue is required and must be a positive integer");
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
  const repository = `${owner}/${repo}`;
  const policy = loadPolicy(args.policy, { strict: Boolean(args.policy) });
  const staleAgeMs = args.staleAgeMs > 0 ? args.staleAgeMs : policy.staleAgeMs;
  const trustedLogins = resolveTrustedLogins({
    fromArgs: args.trustedMarkerLogins,
    fromPolicy: policy.trustedMarkerActors,
    currentLogin: ghText(["api", "user", "--jq", ".login"]),
  });
  const trustedSet = new Set(trustedLogins.map((login) => login.toLowerCase()));
  const comments = fetchIssueComments(repository, args.issue);
  const issue = ghJson(["api", `repos/${repository}/issues/${args.issue}`]);

  const result = evaluateResumeClaimRouting(
    {
      events: comments.map((comment) => ({
        body: comment.body ?? "",
        createdAt: comment.created_at ?? "",
        author: { login: comment.user?.login ?? "" },
      })),
      claimId: args.claimId,
      staleAgeMs,
      now: args.now || undefined,
    },
    {
      isTrustedAuthor: (login) => trustedSet.has(String(login ?? "").trim().toLowerCase()),
    },
  );

  const output = {
    repository: { owner, repo },
    issue: {
      number: Number.parseInt(String(issue.number), 10),
      title: String(issue.title ?? ""),
      state: String(issue.state ?? ""),
      url: String(issue.html_url ?? issue.url ?? ""),
    },
    policy: {
      source: policy.source,
      stale_age_ms: staleAgeMs,
      trusted_marker_logins: trustedLogins,
    },
    ...result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function resolveClaimState(events, nowIso, staleAgeMs) {
  const orderedEvents = [...events].sort(compareEvents);
  const warnings = [];
  let activeClaim = null;
  let hasNewFormatClaim = false;
  for (const event of orderedEvents) {
    const claim = parseClaimComment(event.body, event.createdAt);
    if (claim) {
      hasNewFormatClaim = true;
      if (!activeClaim) {
        if (claim.supersedes === "none") {
          activeClaim = claim;
        }
        continue;
      }
      if (claim.agentId === activeClaim.agentId && claim.claimId === activeClaim.claimId) {
        if (claim.branch === activeClaim.branch) {
          activeClaim = { ...activeClaim, createdAt: event.createdAt };
        } else {
          warnings.push(
            `ignored anomalous heartbeat for ${claim.claimId}: branch ${claim.branch} != ${activeClaim.branch}`,
          );
        }
        continue;
      }
      if (claim.supersedes === activeClaim.claimId && isStaleByAge(activeClaim.createdAt, event.createdAt, staleAgeMs)) {
        activeClaim = claim;
      }
      continue;
    }

    const release = parseReleaseComment(event.body);
    if (release && activeClaim && release.agentId === activeClaim.agentId && release.claimId === activeClaim.claimId) {
      activeClaim = null;
      continue;
    }

    const forcedHandoff = parseForcedHandoffComment(event.body, event.createdAt);
    if (
      forcedHandoff
      && activeClaim
      && forcedHandoff.oldAgentId === activeClaim.agentId
      && forcedHandoff.oldClaimId === activeClaim.claimId
      && forcedHandoff.branch === activeClaim.branch
    ) {
      activeClaim = {
        agentId: forcedHandoff.newAgentId,
        claimId: forcedHandoff.newClaimId,
        supersedes: forcedHandoff.oldClaimId,
        branch: forcedHandoff.branch,
        createdAt: forcedHandoff.createdAt ?? event.createdAt,
      };
    }
  }

  if (hasNewFormatClaim) {
    return {
      mode: "new-format",
      activeClaim,
      warnings,
      legacyClaim: null,
      legacyReleased: false,
    };
  }

  const legacy = resolveLegacyClaimState(orderedEvents, nowIso, staleAgeMs);
  return {
    mode: "legacy-only",
    activeClaim: null,
    warnings,
    legacyClaim: legacy.claim,
    legacyReleased: legacy.released,
  };
}

function resolveLegacyClaimState(orderedEvents) {
  let latestClaim = null;
  let latestMatchingRelease = null;
  for (const event of orderedEvents) {
    const claim = parseLegacyClaimComment(event.body, event.createdAt);
    if (claim) {
      latestClaim = claim;
      latestMatchingRelease = null;
      continue;
    }
    const release = parseLegacyReleaseComment(event.body, event.createdAt);
    if (
      release
      && latestClaim
      && release.agentId === latestClaim.agentId
      && compareIso(release.createdAt, latestClaim.createdAt) > 0
    ) {
      latestMatchingRelease = release;
    }
  }
  if (!latestClaim) {
    return { claim: null, released: false };
  }
  const released = Boolean(latestMatchingRelease);
  return { claim: latestClaim, released };
}

function findSameSecondContenders(events, activeClaim) {
  const activeSecond = toSecond(activeClaim.createdAt);
  if (activeSecond === null) {
    return [];
  }
  return events
    .map((event) => parseClaimComment(event.body, event.createdAt))
    .filter(Boolean)
    .filter((claim) => toSecond(claim.createdAt) === activeSecond)
    .map((claim) => claim.claimId)
    .filter((claimId) => claimId !== activeClaim.claimId)
    .sort();
}

function findLaterCompetingClaim(events, activeClaim) {
  const activeSecond = toSecond(activeClaim.createdAt);
  if (activeSecond === null) {
    return null;
  }
  const contenders = events
    .map((event) => parseClaimComment(event.body, event.createdAt))
    .filter(Boolean)
    .filter((claim) => claim.claimId !== activeClaim.claimId)
    .filter((claim) => {
      const claimSecond = toSecond(claim.createdAt);
      return claimSecond !== null && claimSecond > activeSecond;
    })
    .sort((left, right) => compareIso(left.createdAt, right.createdAt));
  if (contenders.length === 0) {
    return null;
  }
  return {
    claim_id: contenders[0].claimId,
    created_at: contenders[0].createdAt,
  };
}

function parseLegacyClaimComment(body, createdAt) {
  const match = String(body ?? "").trimEnd().match(LEGACY_CLAIM_PATTERN);
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    createdAt: normalizeIso(match[2]) ?? normalizeIso(createdAt) ?? createdAt,
    branch: match[3],
  };
}

function parseLegacyReleaseComment(body, createdAt) {
  const match = String(body ?? "").trimEnd().match(LEGACY_RELEASE_PATTERN);
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    createdAt: normalizeIso(match[2]) ?? normalizeIso(createdAt) ?? createdAt,
  };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return events
    .map((event) => ({
      body: String(event?.body ?? ""),
      createdAt: normalizeIso(event?.createdAt ?? event?.created_at),
      author: { login: String(event?.author?.login ?? event?.user?.login ?? "") },
    }))
    .filter((event) => event.createdAt !== null);
}

function compareEvents(left, right) {
  const leftSecond = toSecond(left.createdAt);
  const rightSecond = toSecond(right.createdAt);
  if (leftSecond !== null && rightSecond !== null && leftSecond !== rightSecond) {
    return leftSecond - rightSecond;
  }
  if (leftSecond !== null && rightSecond === null) {
    return -1;
  }
  if (leftSecond === null && rightSecond !== null) {
    return 1;
  }

  const leftClaim = parseClaimComment(left.body, left.createdAt);
  const rightClaim = parseClaimComment(right.body, right.createdAt);
  if (leftClaim && rightClaim && leftClaim.claimId !== rightClaim.claimId) {
    return leftClaim.claimId < rightClaim.claimId ? -1 : 1;
  }
  return compareIso(left.createdAt, right.createdAt);
}

function parseArgs(argv) {
  const parsed = {
    issue: null,
    owner: "",
    repo: "",
    token: "",
    claimId: "",
    now: "",
    policy: "",
    staleAgeMs: 0,
    trustedMarkerLogins: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === "--issue") {
      parsed.issue = Number.parseInt(String(requireValue()), 10);
      index += 1;
      continue;
    }
    if (token === "--owner") {
      parsed.owner = requireValue();
      index += 1;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = requireValue();
      index += 1;
      continue;
    }
    if (token === "--token") {
      parsed.token = requireValue();
      index += 1;
      continue;
    }
    if (token === "--claim-id") {
      parsed.claimId = requireValue();
      index += 1;
      continue;
    }
    if (token === "--now") {
      parsed.now = requireValue();
      index += 1;
      continue;
    }
    if (token === "--policy") {
      parsed.policy = requireValue();
      index += 1;
      continue;
    }
    if (token === "--stale-age-ms") {
      parsed.staleAgeMs = Number.parseInt(String(requireValue()), 10);
      index += 1;
      continue;
    }
    if (token === "--trusted-marker-logins") {
      parsed.trustedMarkerLogins = requireValue();
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/resume-claim-routing.mjs --issue <number> [--owner <owner>] [--repo <repo>] [--token <token>] [--claim-id <token>] [--now <ISO8601>] [--policy <path>] [--stale-age-ms <ms>] [--trusted-marker-logins "<a,b,...>"]

Output schema:
{
  "state": "unclaimed|already_owned|stale|non_inheritable|disputed",
  "action": "re_claim|takeover|keep|stop",
  "reason": "...",
  "active_claim": {"agent_id":"...","claim_id":"...","created_at":"...","branch":"..."} | null
}
`);
}

function fetchIssueComments(repository, issueNumber) {
  const comments = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const pageItems = ghJson([
      "api",
      `repos/${repository}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${page}`,
    ]);
    comments.push(...pageItems);
    if (pageItems.length < pageSize) {
      break;
    }
  }
  return comments;
}

function loadPolicy(policyPath, { strict = false } = {}) {
  const source = policyPath ? resolve(process.cwd(), policyPath) : resolve(process.cwd(), ".github/idd/config.json");
  try {
    const config = JSON.parse(readFileSync(source, "utf8"));
    return {
      source,
      staleAgeMs: parseDurationToMs(config?.claimTiming?.staleAge) ?? DEFAULT_STALE_AGE_MS,
      trustedMarkerActors: Array.isArray(config?.trustedMarkerActors)
        ? config.trustedMarkerActors.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [],
    };
  } catch (error) {
    if (strict) {
      throw new Error(`failed to load policy from ${source}: ${String(error?.message ?? error)}`);
    }
    return {
      source,
      staleAgeMs: DEFAULT_STALE_AGE_MS,
      trustedMarkerActors: [],
    };
  }
}

function parseDurationToMs(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text);
  if (!match) {
    return null;
  }
  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function resolveTrustedLogins({ fromArgs, fromPolicy, currentLogin }) {
  const fromCsv = String(fromArgs ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = [...fromCsv, ...(fromPolicy ?? []), String(currentLogin ?? "").trim()]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  return [...new Set(merged)];
}

function normalizeStaleAgeMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_STALE_AGE_MS;
  }
  return Math.floor(value);
}

function isStaleByAge(activeCreatedAt, nextCreatedAt, staleAgeMs) {
  if (staleAgeMs === DEFAULT_STALE_AGE_MS) {
    return isStaleAt(activeCreatedAt, nextCreatedAt);
  }
  const start = Date.parse(activeCreatedAt ?? "");
  const end = Date.parse(nextCreatedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return false;
  }
  return end - start >= staleAgeMs;
}

function normalizeIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function compareIso(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return 0;
  }
  return leftTime - rightTime;
}

function toSecond(iso) {
  const milliseconds = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return Math.floor(milliseconds / 1000);
}

function normalizeToken(value) {
  const token = String(value ?? "").trim();
  return token.length > 0 ? token : "";
}

function ghJson(args) {
  return JSON.parse(runGh(args).trim() || "[]");
}

function ghText(args) {
  return runGh(args).trim();
}

function runGh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    if (stderr) {
      throw new Error(`gh command failed: ${stderr}`);
    }
    throw error;
  }
}

function isCliExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
