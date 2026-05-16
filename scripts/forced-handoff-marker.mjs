#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  parsePaginatedGhNdjson,
  renderForcedHandoffComment,
  summarizeClaimValidation,
} from "./protocol-helpers.mjs";
import { normalizePolicyConfig, resolveCollaboratorMarkerTrust } from "./policy-helpers.mjs";

export function generateSuccessorIds(baseAgentId) {
  return {
    newAgentId: String(baseAgentId || "idd-agent"),
    newClaimId: `claim-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  };
}

export function planHandoff(issueComments, linkedPrs, options = {}) {
  const {
    newAgentId,
    newClaimId,
    prNumber,
    forcedBy,
    reason,
    timestamp,
    trustedMarkerLogins,
    isAuthorizedForcedHandoff,
  } = options;

  const resolveOpts = {
    isAuthorizedForcedHandoff:
      typeof isAuthorizedForcedHandoff === "function"
        ? isAuthorizedForcedHandoff
        : () => false,
  };

  // First pass: resolve without PR filter to obtain the claim branch.
  const firstPassClaim = resolveHelperActiveClaim(
    issueComments,
    trustedMarkerLogins ?? [],
    resolveOpts,
  );

  if (!firstPassClaim) {
    throw new Error("issue has no active trusted claim");
  }

  const matchingPrs = (linkedPrs ?? []).filter(
    (pr) => String(pr.headRefName ?? "") === firstPassClaim.branch,
  );
  const contextScope = matchingPrs.length > 0 ? "issue-plus-pr" : "issue-only";
  const prReferences = matchingPrs.map((pr) => String(pr.number));

  if (prNumber !== undefined) {
    const prRef = String(prNumber);
    if (!prReferences.includes(prRef)) {
      throw new Error(
        `PR #${prNumber} does not match any open PR on claim branch ${firstPassClaim.branch}` +
          (prReferences.length > 0 ? `; expected one of: ${prReferences.join(", ")}` : ""),
      );
    }
  }

  // Second pass: when an open PR is part of the plan, re-resolve with an
  // expectedLinkedPrs filter so that prior issue-only forced-handoff markers
  // are correctly rejected for PR-scoped claim replay.
  let activeClaim = firstPassClaim;
  if (contextScope === "issue-plus-pr") {
    const expectedLinkedPrs =
      prNumber !== undefined ? [String(prNumber)] : prReferences;
    const filteredClaim = resolveHelperActiveClaim(
      issueComments,
      trustedMarkerLogins ?? [],
      { ...resolveOpts, expectedLinkedPrs },
    );
    if (filteredClaim) {
      activeClaim = filteredClaim;
    }
  }

  const generated = generateSuccessorIds(activeClaim.agentId);
  const successorIds = {
    newAgentId: newAgentId ?? generated.newAgentId,
    newClaimId: newClaimId ?? generated.newClaimId,
  };

  let markerBody = null;
  if (forcedBy && reason) {
    // Validate the approving actor before rendering the marker body so that
    // plan output cannot preview a marker that claim resolution would reject.
    const authorized =
      typeof isAuthorizedForcedHandoff !== "function" ||
      isAuthorizedForcedHandoff(forcedBy);
    if (authorized) {
      const resolvedLinkedPr =
        prNumber !== undefined ? String(prNumber) : prReferences[0];
      const payload = {
        oldAgentId: activeClaim.agentId,
        oldClaimId: activeClaim.claimId,
        newAgentId: successorIds.newAgentId,
        newClaimId: successorIds.newClaimId,
        branch: activeClaim.branch,
        ...(contextScope === "issue-plus-pr" && resolvedLinkedPr
          ? { linkedPr: resolvedLinkedPr }
          : {}),
        forcedBy,
        reason,
        timestamp: timestamp ?? currentIsoTimestamp(),
        contextScope,
      };
      markerBody = renderForcedHandoffComment(payload);
    }
  }

  return {
    activeClaim,
    branch: activeClaim.branch,
    contextScope,
    prReferences,
    markerBody,
    successorIds,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.issueNumber) {
    throw new Error("missing required --issue <number> argument");
  }
  if (!args.forcedBy) {
    throw new Error("missing required --forced-by <actor> argument");
  }
  if (!args.reason) {
    throw new Error("missing required --reason <text> argument");
  }

  if (args.plan) {
    const repoRef = args.repo ?? ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const { owner, name } = parseOwnerRepo(repoRef);
    const issueComments = ghJson(["api", "--paginate", `repos/${owner}/${name}/issues/${args.issueNumber}/comments`], true);
    const viewerLogin = safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
    const trustedMarkerLogins = buildTrustedMarkerLogins(owner, name, viewerLogin, args.trustedMarkerLogins, issueComments);
    const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
    const permissionCache = new Map();

    const tempClaim = resolveHelperActiveClaim(issueComments, trustedMarkerLogins, {
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(owner, name, forcedBy, forcedHandoffAuthorityPolicy, permissionCache),
    });

    let linkedPrs = [];
    if (tempClaim) {
      linkedPrs = ghJson([
        "pr", "list",
        "--repo", `${owner}/${name}`,
        "--head", tempClaim.branch,
        "--state", "open",
        "--json", "number,headRefName",
      ]);
    }

    const modeEnabled = readForcedHandoffMode() === "human-gated";
    const plan = planHandoff(issueComments, linkedPrs, {
      newAgentId: args.newAgentId,
      newClaimId: args.newClaimId,
      prNumber: args.prNumber,
      forcedBy: modeEnabled ? args.forcedBy : undefined,
      reason: modeEnabled ? args.reason : undefined,
      timestamp: args.timestamp,
      trustedMarkerLogins,
      isAuthorizedForcedHandoff: (forcedBy) =>
        isAuthorizedForcedHandoffActor(owner, name, forcedBy, forcedHandoffAuthorityPolicy, permissionCache),
    });

    console.log(
      JSON.stringify(
        { repository: `${owner}/${name}`, issueNumber: args.issueNumber, modeEnabled, ...plan },
        null,
        2,
      ),
    );
    return;
  }

  if (!args.newAgentId) {
    throw new Error("missing required --new-agent-id <id> argument");
  }
  if (!args.newClaimId) {
    throw new Error("missing required --new-claim-id <id> argument");
  }

  const repoRef = args.repo ?? ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const { owner, name } = parseOwnerRepo(repoRef);
  if (readForcedHandoffMode() !== "human-gated") {
    throw new Error("forced-handoff mode is not human-gated; marker generation is disabled");
  }
  const issueComments = ghJson(["api", "--paginate", `repos/${owner}/${name}/issues/${args.issueNumber}/comments`], true);
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
      case "--plan":
        parsed.plan = true;
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
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    finalArgs.splice(1, 0, "--jq", ".[]");
    return parsePaginatedGhNdjson(execFileSync("gh", finalArgs, { encoding: "utf8" }));
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
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync(".github/idd/config.json", "utf8")),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}

function readForcedHandoffAuthorityPolicy() {
  return readNormalizedPolicy().forcedHandoff.authorityPolicy;
}

function readForcedHandoffMode() {
  try {
    return readNormalizedPolicy().forcedHandoff.mode;
  } catch {
    // Default mode remains disabled.
    return "disabled";
  }
}

function readNormalizedPolicy() {
  try {
    return normalizePolicyConfig(JSON.parse(readFileSync(".github/idd/config.json", "utf8")));
  } catch {
    return normalizePolicyConfig({});
  }
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
  --plan                           derive live PR context and emit a structured execution plan;
                                   --new-agent-id and --new-claim-id become optional (auto-generated)
  --pr <number>                    optional PR number for issue-plus-pr context
  --new-agent-id <id>              successor session agent id (required without --plan)
  --new-claim-id <id>              successor claim id (required without --plan)
  --forced-by <actor>              approving human actor recorded in the marker
  --reason <text>                  why the prior session is considered unavailable
  --timestamp <ISO8601>            override the marker payload timestamp (default: current UTC)
  --trusted-marker-logins <csv>    additional trusted marker authors for claim reconstruction
  --repo <owner/name>              repository override
  --format <text|json>             output format for marker mode (default: text)
  --help                           show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS        comma-separated trusted bot/app logins
  IDD_TRUST_COLLABORATOR_MARKERS   set true to trust Write/Maintain/Admin collaborators
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
