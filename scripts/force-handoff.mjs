#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { planHandoff } from "./forced-handoff-marker.mjs";
import { parsePaginatedGhNdjson } from "./protocol-helpers.mjs";

const APPROVAL_ACTOR_POLICIES = new Set([
  "owners-and-maintainers-only",
  "all-write-permission-actors",
]);
const APPROVAL_ACTOR_POLICY_DEFAULT = "owners-and-maintainers-only";
const FORCED_HANDOFF_MODES = new Set(["disabled", "human-gated"]);
const FORCED_HANDOFF_MODE_DEFAULT = "disabled";

export const NON_TTY_ERROR =
  "operator interaction is required; run idd-force-handoff in an interactive TTY";

export async function runHandoff(options = {}) {
  const {
    isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptFn,
    repo,
    forcedBy: givenForcedBy,
    reason = "operator-approved-recovery",
    trustedMarkerLogins: givenTrustedLogins,
    isAuthorizedForcedHandoff: givenAuthPredicate,
    fetchIssueComments,
    fetchLinkedPrs,
    postComment,
    mode,
  } = options;

  if (!isTTY) {
    throw new Error(NON_TTY_ERROR);
  }

  if ((mode ?? readForcedHandoffMode()) !== "human-gated") {
    throw new Error(
      "forced-handoff mode is not human-gated; idd-force-handoff is only available when forcedHandoff.mode is 'human-gated'",
    );
  }

  const ask = promptFn ?? makeReadlinePrompt();

  const rawIssue = await ask("Issue number: ");
  const issueNumber = parsePositiveInteger(rawIssue, "--issue");

  const repoRef = repo ?? ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const { owner, name } = parseOwnerRepo(repoRef);

  const forcedBy = givenForcedBy ?? safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
  if (!forcedBy) {
    throw new Error("could not determine current GitHub user; ensure gh is authenticated");
  }

  const issueComments = fetchIssueComments
    ? await fetchIssueComments(issueNumber)
    : ghJson(["api", "--paginate", `repos/${owner}/${name}/issues/${issueNumber}/comments`], true);

  const trustedMarkerLogins = givenTrustedLogins
    ?? buildTrustedMarkerLogins(owner, name, forcedBy, issueComments);

  const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  const permissionCache = new Map();
  const isAuthorizedForcedHandoff = givenAuthPredicate
    ?? ((actor) => isAuthorizedForcedHandoffActor(owner, name, actor, forcedHandoffAuthorityPolicy, permissionCache));

  const resolveOpts = { trustedMarkerLogins, isAuthorizedForcedHandoff, forcedBy, reason };

  const firstPass = planHandoff(issueComments, [], resolveOpts);

  const linkedPrs = fetchLinkedPrs
    ? await fetchLinkedPrs(firstPass.branch)
    : ghJson([
        "pr", "list",
        "--repo", `${owner}/${name}`,
        "--head", firstPass.branch,
        "--state", "open",
        "--json", "number,headRefName",
      ]);

  let plan = planHandoff(issueComments, linkedPrs, resolveOpts);

  let resolvedPrNumber;
  if (plan.contextScope === "issue-plus-pr") {
    const prList = plan.prReferences.join(", ");
    const rawPr = await ask(`Open PR on branch (${prList}). Enter PR number: `);
    const prNumber = parsePositiveInteger(rawPr, "--pr");
    plan = planHandoff(issueComments, linkedPrs, { ...resolveOpts, prNumber });
    resolvedPrNumber = prNumber;
  }

  if (!plan.markerBody) {
    throw new Error(
      "cannot generate forced-handoff marker: check that forced-handoff mode is human-gated and the actor is authorized",
    );
  }

  const { newAgentId, newClaimId } = plan.successorIds;
  const lines = [
    "",
    `Forced-handoff plan for issue #${issueNumber}:`,
    `  Context:   ${plan.contextScope}`,
    `  Branch:    ${plan.branch}`,
    `  Old claim: ${plan.activeClaim.agentId} / ${plan.activeClaim.claimId}`,
    `  Successor: ${newAgentId} / ${newClaimId}`,
    ...(resolvedPrNumber ? [`  PR:        #${resolvedPrNumber}`] : []),
    "",
    "Marker preview:",
    plan.markerBody,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");

  const confirm = await ask("Confirm forced handoff? [y/N] ");
  ask.close?.();
  if (confirm.trim().toLowerCase() !== "y") {
    process.stdout.write("Aborted. No changes made.\n");
    return { posted: false };
  }

  const result = postComment
    ? await postComment(issueNumber, plan.markerBody)
    : ghJson([
        "api",
        `repos/${owner}/${name}/issues/${issueNumber}/comments`,
        "--method", "POST",
        "-f", `body=${plan.markerBody}`,
      ]);

  const commentUrl = String(result.html_url ?? result.url ?? "");
  process.stdout.write([
    "",
    `Forced handoff posted: ${commentUrl}`,
    `  Successor agent-id:  ${newAgentId}`,
    `  Successor claim-id:  ${newClaimId}`,
    "",
  ].join("\n"));

  return {
    posted: true,
    commentUrl,
    successorIds: { newAgentId, newClaimId },
    contextScope: plan.contextScope,
  };
}

export function main() {
  runHandoff().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

function makeReadlinePrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => rl.question(question, (answer) => {
      resolve(answer);
    }));
  ask.close = () => rl.close();
  return ask;
}

function parsePositiveInteger(value, flag) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return Number(raw);
}

function parseOwnerRepo(value) {
  const repo = String(value ?? "").trim();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`invalid repo value: ${value} (expected owner/name)`);
  }
  return { owner: match[1], name: match[2] };
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

function buildTrustedMarkerLogins(owner, repo, viewerLogin, issueComments) {
  const configuredActors = readTrustedMarkerActorsFromConfig();
  const configured = [
    viewerLogin,
    ...configuredActors,
    ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
  ];
  const trusted = new Set(configured.filter(Boolean).map((l) => l.toLowerCase()));

  if (!readCollaboratorTrustEnabled()) {
    return trusted;
  }

  const permissionCache = new Map();
  const uniqueLogins = new Set(
    issueComments
      .map((comment) => String(comment.user?.login ?? comment.author?.login ?? "").toLowerCase())
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

function readTrustedMarkerActorsFromConfig() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const actors = config?.trustedMarkerActors;
    if (Array.isArray(actors)) {
      return actors.map(String).filter(Boolean);
    }
  } catch {
    // config absent or unreadable
  }
  return [];
}

function readCollaboratorTrustEnabled() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const nested = config?.markerTrust?.allowCollaboratorMarkers;
    const topLevel = config?.markerTrustAllowCollaboratorMarkers ?? config?.allowCollaboratorMarkers;
    const value = nested ?? topLevel;
    if (typeof value === "boolean") {
      return value;
    }
  } catch {
    // Fall through to env-var fallback.
  }
  return isTruthy(process.env.IDD_TRUST_COLLABORATOR_MARKERS);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function readForcedHandoffMode() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const mode = String(
      config?.forcedHandoff?.mode ??
        config?.["forced-handoff"]?.mode ??
        config?.forcedHandoffMode ??
        config?.["forced-handoff-mode"] ??
        "",
    ).trim();
    if (FORCED_HANDOFF_MODES.has(mode)) {
      return mode;
    }
  } catch {
    // Default mode remains disabled.
  }
  return FORCED_HANDOFF_MODE_DEFAULT;
}

function splitCsv(value) {
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function readForcedHandoffAuthorityPolicy() {
  try {
    const config = JSON.parse(readFileSync(".github/idd/config.json", "utf8"));
    const policy = String(
      config?.forcedHandoff?.authorityPolicy ??
        config?.["forced-handoff"]?.authorityPolicy ??
        config?.forcedHandoffAuthority ??
        config?.["forced-handoff-authority"] ??
        "",
    ).trim();
    if (APPROVAL_ACTOR_POLICIES.has(policy)) {
      return policy;
    }
  } catch {
    // default
  }
  return APPROVAL_ACTOR_POLICY_DEFAULT;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
