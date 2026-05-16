#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { readAdvisoryWaitPolicy } from "./advisory-wait-policy.mjs";
import {
  buildAdvisoryWaitSummary,
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
} from "./protocol-helpers.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.prNumber) {
  throw new Error("missing required --pr <number> argument");
}

const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
const repoRef = `${owner}/${repo}`;
const viewerLogin = safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
const configuredTrustedActors = normalizeTrustedMarkerLogins([
  ...splitCsv(args.trustedMarkerLogins),
  ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
]);

const prHeadSha = ghText([
  "pr",
  "view",
  String(args.prNumber),
  "-R",
  repoRef,
  "--json",
  "headRefOid",
  "--jq",
  ".headRefOid",
]);

const reviews = ghApiJson(`repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`, true);
const requestedReviewers = ghApiJson(
  `repos/${owner}/${repo}/pulls/${args.prNumber}/requested_reviewers`,
  false,
);
const timelineEvents = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
  true,
  ["-H", "Accept: application/vnd.github+json"],
);
const comments = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
  true,
);

const collaboratorTrustEnabled = isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
const trustedMarkerLogins = normalizeTrustedMarkerLogins([
  viewerLogin,
  ...configuredTrustedActors,
  ...(collaboratorTrustEnabled
    ? resolveTrustedCollaboratorMarkerLogins(owner, repo, comments)
    : []),
]);
const advisoryWaitPolicy = readAdvisoryWaitPolicy();

const summary = buildAdvisoryWaitSummary(
  {
    prHeadSha,
    reviews,
    requestedReviewers: requestedReviewers.users ?? [],
    timelineEvents,
    comments: comments.map(normalizeComment),
  },
  {
    now: args.now || new Date().toISOString().replace(".000Z", "Z"),
    requestCap: advisoryWaitPolicy.requestCap,
    pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
    settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
    pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
    capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
    viewerLogin,
    configuredTrustedActors,
    collaboratorTrustEnabled,
    trustedMarkerLogins,
  },
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    owner: "",
    repo: "",
    trustedMarkerLogins: "",
    now: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--pr") {
      parsed.prNumber = Number.parseInt(value ?? "", 10);
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
    if (token === "--trusted-marker-logins") {
      parsed.trustedMarkerLogins = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--now") {
      parsed.now = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.prNumber) || parsed.prNumber < 1) {
    parsed.prNumber = null;
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/advisory-wait-state.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--now <ISO8601>]
`);
}

function normalizeComment(comment) {
  return {
    author: { login: comment.user?.login ?? "" },
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
  };
}

function resolveTrustedCollaboratorMarkerLogins(owner, repo, comments) {
  const advisoryAuthors = [...new Set(
    comments
      .filter((comment) => advisoryMarkerComment(comment.body ?? ""))
      .map((comment) => comment.user?.login ?? "")
      .filter(Boolean),
  )];

  return advisoryAuthors.filter((login) => {
    const permission = safeGhText([
      "api",
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      "--jq",
      ".permission",
    ]).toLowerCase();

    return permission === "admin" || permission === "maintain" || permission === "write";
  });
}

function advisoryMarkerComment(body) {
  const normalized = String(body ?? "");
  return normalized.startsWith("advisory-wait:")
    || normalized.startsWith("advisory-wait-recovery:")
    || normalized.startsWith("<!-- advisory-wait:");
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
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

function ghApiJson(path, paginate = false, extraArgs = []) {
  const args = ["api", path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.splice(1, 0, "--paginate", "--jq", ".[]");
    return parsePaginatedGhNdjson(execFileSync("gh", args, { encoding: "utf8" }));
  }
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}
