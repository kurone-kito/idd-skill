#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { renderForcedHandoffComment, resolveActiveClaim } from "./protocol-helpers.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
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

const repo = args.repo ?? ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
const [owner, name] = repo.split("/", 2);
const issueComments = ghJson(["api", "--paginate", `repos/${owner}/${name}/issues/${args.issueNumber}/comments`], true).flat();
const viewerLogin = safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
const trustedMarkerLogins = buildTrustedMarkerLogins(owner, name, viewerLogin, args.trustedMarkerLogins, issueComments);
const activeClaim = resolveActiveClaim(
  issueComments.map(normalizeIssueComment),
  (login) => trustedMarkerLogins.has(String(login ?? "").trim().toLowerCase()),
);

if (!activeClaim) {
  throw new Error(`issue #${args.issueNumber} has no active trusted claim`);
}

let linkedPr = "";
if (args.prNumber) {
  const pr = ghJson([
    "pr",
    "view",
    String(args.prNumber),
    "-R",
    repo,
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
        repository: repo,
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

function parseArgs(argv) {
  const parsed = {
    format: "text",
    trustedMarkerLogins: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--issue":
        parsed.issueNumber = parsePositiveInteger(argv[++index], "--issue");
        break;
      case "--pr":
        parsed.prNumber = parsePositiveInteger(argv[++index], "--pr");
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
  if (!isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS)) {
    return new Set(configured.filter(Boolean).map((login) => login.toLowerCase()));
  }

  const trusted = new Set(configured.filter(Boolean).map((login) => login.toLowerCase()));
  for (const comment of issueComments) {
    const login = String(comment.user?.login ?? "").toLowerCase();
    if (!login) {
      continue;
    }
    const permission = safeGhText([
      "api",
      `repos/${owner}/${repo}/collaborators/${login}/permission`,
      "--jq",
      ".permission",
    ]).toLowerCase();
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

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
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

function currentIsoTimestamp() {
  return new Date().toISOString().replace(".000Z", "Z");
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
