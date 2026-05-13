#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { renderForcedHandoffComment, summarizeClaimValidation } from "./protocol-helpers.mjs";

const APPROVAL_ACTOR_POLICIES = new Set([
  "owners-and-maintainers-only",
  "all-write-permission-actors",
]);
const APPROVAL_ACTOR_POLICY_DEFAULT = "owners-and-maintainers-only";
const FORCED_HANDOFF_MODES = new Set(["disabled", "human-gated"]);
const FORCED_HANDOFF_MODE_DEFAULT = "disabled";

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.issueNumber) {
    throw new Error("missing required --issue <number> argument");
  }
  if (!args.newAgentId) {
    throw new Error("missing required --new-agent-id <id> argument");
  }
  if (!args.newClaimId) {
    throw new Error("missing required --new-claim-id <id> argument");
  }
  if (!args.forcedBy) {
    throw new Error("missing required --forced-by <actor> argument");
  }
  if (!args.reason) {
    throw new Error("missing required --reason <text> argument");
  }

  const repoRef = args.repo ?? ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const { owner, name } = parseOwnerRepo(repoRef);
  if (readForcedHandoffMode() !== "human-gated") {
    throw new Error("forced-handoff mode is not human-gated; marker generation is disabled");
  }
  const issueComments = ghJson(["api", "--paginate", `repos/${owner}/${name}/issues/${args.issueNumber}/comments`], true).flat();
  const viewerLogin = safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
  const trustedMarkerLogins = buildTrustedMarkerLogins(owner, name, viewerLogin, args.trustedMarkerLogins, issueComments);
  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const permissionCache = new Map();
  const activeClaim = resolveHelperActiveClaim(issueComments, trustedMarkerLogins, {
    expectedLinkedPrs: args.prNumber
      ? [String(args.prNumber), `https://github.com/${owner}/${name}/pull/${args.prNumber}`]
      : [],
    isAuthorizedForcedHandoff:
      (forcedBy) => isAuthorizedForcedHandoffActor(
        owner,
        name,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        permissionCache,
      ),
  });

  if (!activeClaim) {
    throw new Error(`issue #${args.issueNumber} has no active trusted claim`);
  }

  if (
    !isAuthorizedForcedHandoffActor(
      owner,
      name,
      args.forcedBy,
      forcedHandoffAuthorityPolicy,
      permissionCache,
    )
  ) {
    throw new Error(
      `--forced-by actor ${args.forcedBy} is not authorized under ${forcedHandoffAuthorityPolicy}`,
    );
  }

  let linkedPr = "";
  if (args.prNumber) {
    const pr = ghJson([
      "pr",
      "view",
        String(args.prNumber),
        "-R",
        `${owner}/${name}`,
        "--json",
        "headRefName,url",
        "--jq",
      ".",
    ]);
    const headRefName = String(pr.headRefName ?? "");
    if (headRefName !== activeClaim.branch) {
      throw new Error(
        `PR #${args.prNumber} head branch ${headRefName} does not match active claim branch ${activeClaim.branch}`,
      );
    }
    linkedPr = String(args.prNumber);
  }

  const payload = {
    oldAgentId: activeClaim.agentId,
    oldClaimId: activeClaim.claimId,
    newAgentId: args.newAgentId,
    newClaimId: args.newClaimId,
    branch: activeClaim.branch,
    ...(linkedPr ? { linkedPr } : {}),
    forcedBy: args.forcedBy,
    reason: args.reason,
    timestamp: args.timestamp ?? currentIsoTimestamp(),
    contextScope: linkedPr ? "issue-plus-pr" : "issue-only",
  };

  const commentBody = renderForcedHandoffComment(payload);
  if (args.format === "json") {
    console.log(
      JSON.stringify(
          {
          repository: `${owner}/${name}`,
          issueNumber: args.issueNumber,
          activeClaim,
          payload,
          commentBody,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(commentBody);
  }
}

export function resolveHelperActiveClaim(issueComments, trustedMarkerLogins, options = {}) {
  const trustedSources = Array.isArray(trustedMarkerLogins)
    ? trustedMarkerLogins
    : trustedMarkerLogins instanceof Set
      ? [...trustedMarkerLogins]
      : splitCsv(trustedMarkerLogins);
  const trustedLogins = new Set(
    trustedSources
      .map((login) => String(login ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const summary = summarizeClaimValidation(
    issueComments.map(normalizeIssueComment),
    {
      trustedMarkerLogins: [...trustedLogins],
      forcedHandoffEnabled: true,
      expectedLinkedPrs: options.expectedLinkedPrs ?? [],
      isAuthorizedForcedHandoff:
        typeof options.isAuthorizedForcedHandoff === "function"
          ? options.isAuthorizedForcedHandoff
          : () => false,
    },
  );

  return summary.activeClaimPresent ? summary.activeClaim : null;
}

function parseArgs(argv) {
  const parsed = {
    format: "text",
    trustedMarkerLogins: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--issue":
        parsed.issueNumber = parsePositiveInteger(readValue(argv, ++index, token), token);
        break;
      case "--pr":
        parsed.prNumber = parsePositiveInteger(readValue(argv, ++index, token), token);
        break;
      case "--new-agent-id":
        parsed.newAgentId = readValue(argv, ++index, token);
        break;
      case "--new-claim-id":
        parsed.newClaimId = readValue(argv, ++index, token);
        break;
      case "--forced-by":
        parsed.forcedBy = readValue(argv, ++index, token);
        break;
      case "--reason":
        parsed.reason = readValue(argv, ++index, token);
        break;
      case "--timestamp":
        parsed.timestamp = readValue(argv, ++index, token);
        break;
      case "--trusted-marker-logins":
        parsed.trustedMarkerLogins = readValue(argv, ++index, token);
        break;
      case "--repo":
        parsed.repo = readValue(argv, ++index, token);
        break;
      case "--format":
        parsed.format = readValue(argv, ++index, token);
        if (parsed.format !== "text" && parsed.format !== "json") {
          throw new Error(`unsupported --format value: ${parsed.format}`);
        }
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return parsed;
}

function buildTrustedMarkerLogins(owner, repo, viewerLogin, cliLogins, issueComments) {
  const configured = [
    viewerLogin,
    ...splitCsv(cliLogins),
    ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
  ];
  if (!readCollaboratorTrustEnabled()) {
    return new Set(configured.filter(Boolean).map((login) => login.toLowerCase()));
  }

  const trusted = new Set(configured.filter(Boolean).map((login) => login.toLowerCase()));
  const permissionCache = new Map();
  const uniqueLogins = new Set(
    issueComments
      .map((comment) => String(comment.user?.login ?? "").toLowerCase())
      .filter(Boolean),
  );
  for (const login of uniqueLogins) {
    if (trusted.has(login)) {
      continue;
    }
    const permission = permissionCache.get(login) ?? safeGhText([
      "api",
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      "--jq",
      ".permission",
    ]).toLowerCase();
    permissionCache.set(login, permission);
    if (permission === "admin" || permission === "maintain" || permission === "write") {
      trusted.add(login);
    }
  }
  return trusted;
}

function normalizeIssueComment(comment) {
  return {
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    author: {
      login: comment.user?.login ?? "",
    },
  };
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function readValue(argv, index, name) {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

export function parsePositiveInteger(value, flag) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return Number(raw);
}

function parseOwnerRepo(value) {
  const repo = String(value ?? "").trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid --repo value: ${value} (expected owner/name)`);
  }
  return {
    owner: match[1],
    name: match[2],
  };
}

function ghJson(args, slurp = false) {
  const finalArgs = [...args];
  if (slurp) {
    finalArgs.splice(1, 0, "--slurp");
  }
  return JSON.parse(execFileSync("gh", finalArgs, { encoding: "utf8" }));
}

function ghText(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function safeGhText(args) {
  try {
    return ghText(args);
  } catch {
    return "";
  }
}

function readCollaboratorTrustEnabled() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    if (typeof config?.markerTrust?.allowCollaboratorMarkers === "boolean") {
      return config.markerTrust.allowCollaboratorMarkers;
    }
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}

function readForcedHandoffAuthorityPolicy() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const policy = String(
      config?.forcedHandoff?.authorityPolicy ??
        config?.forcedHandoffAuthority ??
        config?.["forced-handoff-authority"] ??
        "",
    ).trim();
    if (APPROVAL_ACTOR_POLICIES.has(policy)) {
      return policy;
    }
  } catch {
    // Default policy remains owners-and-maintainers-only.
  }
  return APPROVAL_ACTOR_POLICY_DEFAULT;
}

function readForcedHandoffMode() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const mode = String(
      config?.forcedHandoff?.mode ?? config?.forcedHandoff ?? config?.["forced-handoff"] ?? "",
    ).trim();
    if (FORCED_HANDOFF_MODES.has(mode)) {
      return mode;
    }
  } catch {
    // Default mode remains disabled.
  }
  return FORCED_HANDOFF_MODE_DEFAULT;
}

function collaboratorPermission(owner, repo, login, cache) {
  if (cache.has(login)) {
    return cache.get(login);
  }
  const permission = safeGhText([
    "api",
    `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    "--jq",
    ".permission",
  ]).toLowerCase();
  cache.set(login, permission);
  return permission;
}

function isAuthorizedForcedHandoffActor(owner, repo, login, policy, cache) {
  const normalized = String(login ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const permission = collaboratorPermission(owner, repo, normalized, cache);
  if (policy === "all-write-permission-actors") {
    return permission === "admin" || permission === "maintain" || permission === "write";
  }
  return permission === "admin" || permission === "maintain";
}

export function currentIsoTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function printUsage() {
  console.log(`usage: node scripts/forced-handoff-marker.mjs --issue <number> [options]

Options:
  --pr <number>                    optional PR number for issue-plus-pr context
  --new-agent-id <id>              successor session agent id
  --new-claim-id <id>              successor claim id
  --forced-by <actor>              approving human actor recorded in the marker
  --reason <text>                  why the prior session is considered unavailable
  --timestamp <ISO8601>            override the marker payload timestamp (default: current UTC)
  --trusted-marker-logins <csv>    additional trusted marker authors for claim reconstruction
  --repo <owner/name>              repository override
  --format <text|json>             output format (default: text)
  --help                           show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS        comma-separated trusted bot/app logins
  IDD_TRUST_COLLABORATOR_MARKERS   set true to trust Write/Maintain/Admin collaborators
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
