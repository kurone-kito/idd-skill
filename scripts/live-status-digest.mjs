#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  normalizeTrustedMarkerLogins,
  parsePaginatedGhNdjson,
  planLiveStatusDigestUpsert,
  summarizeClaimValidation,
} from "./protocol-helpers.mjs";
import { normalizePolicyConfig, resolveCollaboratorMarkerTrust } from "./policy-helpers.mjs";

const TRUSTED_MARKER_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const trustedMarkerAuthorCache = new Map();
const collaboratorPermissionCache = new Map();
let cachedConfiguredTrustedMarkerAuthors = null;
let cachedCurrentViewerLogin = null;
let cachedForcedHandoffAuthorityPolicy = null;
let cachedForcedHandoffMode = null;
let cachedNormalizedPolicy = null;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

if (args.issue && args.pr) {
  fail("choose only one of --issue or --pr");
}
if (!args.issue && !args.pr) {
  fail("missing required --issue <number> or --pr <number>");
}
if (args.apply && args.dryRun) {
  fail("choose only one of --dry-run or --apply");
}
if (!args.apply) {
  args.dryRun = true;
}
if (args.apply && args.skipClaimCheck && (args.claimIssue || args.claimId)) {
  fail("--skip-claim-check cannot be combined with --claim-issue or --claim-id");
}
if (args.apply && !args.skipClaimCheck && (!args.claimIssue || !args.claimId)) {
  fail("--apply requires --claim-issue and --claim-id, or explicit --skip-claim-check");
}

const repository = args.repo ?? detectRepository();
const [owner, repo] = parseRepository(repository);
const targetType = args.issue ? "issue" : "pr";
const targetNumber = parsePositiveInteger(args.issue ?? args.pr, `--${targetType}`);
const claimContext = targetType === "pr"
  ? { expectedLinkedPrs: buildExpectedLinkedPrReferences(owner, repo, targetNumber) }
  : {};

if (args.claimIssue) {
  args.claimIssue = String(parsePositiveInteger(args.claimIssue, "--claim-issue"));
}

const fields = {
  phase: args.phase,
  claim: args.claim,
  branch: args.branch,
  lastChecked: args.lastChecked ?? currentIsoTimestamp(),
  openBlockers: args.openBlockers,
  nextAction: args.nextAction,
  authoritativeBy: args.authoritativeBy,
};

const comments = fetchIssueComments(owner, repo, targetNumber);
let planned;
try {
  planned = planLiveStatusDigestUpsert(comments, fields);
} catch (error) {
  fail(error.message);
}
const report = {
  repository: `${owner}/${repo}`,
  target: {
    type: targetType,
    number: targetNumber,
  },
  mode: args.apply ? "apply" : "dry-run",
  action: planned.action,
  canApply: planned.canApply,
  commentId: planned.commentId ?? null,
  url: planned.url ?? null,
  duplicates: planned.duplicates ?? [],
  repairPath: planned.repairPath ?? null,
  applied: false,
  body: args.includeBody ? planned.body : undefined,
};

if (planned.action === "duplicate") {
  writeReport(report, args.format);
  process.exit(1);
}

if (args.apply) {
  if (!args.skipClaimCheck) {
    try {
      assertActiveClaim(owner, repo, args.claimIssue, args.agentId, args.claimId, claimContext);
    } catch (error) {
      fail(error.message);
    }
  }

  try {
    planned = planLiveStatusDigestUpsert(fetchIssueComments(owner, repo, targetNumber), fields);
  } catch (error) {
    fail(error.message);
  }
  updateReportFromPlan(report, planned);
  if (planned.action === "duplicate") {
    writeReport(report, args.format);
    process.exit(1);
  }

  if (planned.action === "create") {
    const created = createIssueComment(owner, repo, targetNumber, planned.body);
    report.applied = true;
    report.commentId = created.id ?? null;
    report.url = created.html_url ?? created.url ?? null;
  } else if (planned.action === "update") {
    if (!planned.commentId) {
      fail("cannot update digest because the current comment id is missing");
    }
    const updated = updateIssueComment(owner, repo, planned.commentId, planned.body);
    report.applied = true;
    report.commentId = updated.id ?? planned.commentId;
    report.url = updated.html_url ?? updated.url ?? planned.url ?? null;
  }
}

writeReport(report, args.format);

function updateReportFromPlan(report, planned) {
  report.action = planned.action;
  report.canApply = planned.canApply;
  report.commentId = planned.commentId ?? null;
  report.url = planned.url ?? null;
  report.duplicates = planned.duplicates ?? [];
  report.repairPath = planned.repairPath ?? null;
  if (args.includeBody) {
    report.body = planned.body;
  }
}

function fetchIssueComments(owner, repo, number) {
  // gh api with --paginate and --jq '.[]' emits one JSON object per line.
  // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
  // via apt, so keep the NDJSON-compatible form here.
  const result = parsePaginatedGhNdjson(execFileSync("gh", [
    "api",
    "--paginate",
    "--jq",
    ".[]",
    `repos/${owner}/${repo}/issues/${number}/comments`,
  ], { encoding: "utf8" }));
  return result.map((comment) => ({
    id: comment.id,
    url: comment.url,
    html_url: comment.html_url,
    body: comment.body ?? "",
    created_at: comment.created_at ?? "",
    updated_at: comment.updated_at ?? comment.created_at ?? "",
    author: { login: comment.user?.login ?? "" },
  }));
}

function createIssueComment(owner, repo, number, body) {
  return ghJson([
    "api",
    `repos/${owner}/${repo}/issues/${number}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
  ]);
}

function updateIssueComment(owner, repo, commentId, body) {
  return ghJson([
    "api",
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    "-X",
    "PATCH",
    "-f",
    `body=${body}`,
  ]);
}

function assertActiveClaim(owner, repo, issueNumber, agentId, claimId, options = {}) {
  const active = readActiveClaim(owner, repo, issueNumber, options);
  if (!active || active.claimId !== claimId || (agentId && active.agentId !== agentId)) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : "none";
    throw new Error(`claim check failed for #${issueNumber}: active claim is ${activeLabel}`);
  }
}

function readActiveClaim(owner, repo, issueNumber, options = {}) {
  const comments = fetchIssueComments(owner, repo, issueNumber).map((comment) => {
    return {
      body: comment.body,
      createdAt: comment.created_at,
      author: { login: comment.author?.login ?? "" },
    };
  });

  const summary = summarizeClaimValidation(comments, {
    trustedMarkerLogins: resolveTrustedMarkerLogins(owner, repo, comments),
    forcedHandoffEnabled: readForcedHandoffMode() === "human-gated",
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    isAuthorizedForcedHandoff: (forcedBy) => {
      return isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy(),
      );
    },
  });

  return summary.activeClaimPresent ? summary.activeClaim : null;
}

function resolveTrustedMarkerLogins(owner, repo, comments) {
  return normalizeTrustedMarkerLogins(
    comments
      .map((comment) => comment.author?.login ?? "")
      .filter(Boolean)
      .filter((login) => isTrustedMarkerAuthor(owner, repo, login)),
  );
}

function buildExpectedLinkedPrReferences(owner, repo, prNumber) {
  const normalized = String(prNumber ?? "").trim();
  if (!normalized) {
    return [];
  }
  return [
    normalized,
    `#${normalized}`,
    `https://github.com/${owner}/${repo}/pull/${normalized}`,
  ];
}

function isAuthorizedForcedHandoffActor(owner, repo, login, policy = forcedHandoffAuthorityPolicy()) {
  const normalized = String(login ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const permission = collaboratorPermission(owner, repo, normalized);
  if (policy === "all-write-permission-actors") {
    return permission === "admin" || permission === "maintain" || permission === "write";
  }
  return permission === "admin" || permission === "maintain";
}

function forcedHandoffAuthorityPolicy() {
  if (cachedForcedHandoffAuthorityPolicy !== null) {
    return cachedForcedHandoffAuthorityPolicy;
  }
  cachedForcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
  return cachedForcedHandoffAuthorityPolicy;
}

function readForcedHandoffAuthorityPolicy() {
  return readNormalizedPolicy().forcedHandoff.authorityPolicy;
}

function readForcedHandoffMode() {
  if (cachedForcedHandoffMode !== null) {
    return cachedForcedHandoffMode;
  }
  cachedForcedHandoffMode = readNormalizedPolicy().forcedHandoff.mode;
  return cachedForcedHandoffMode;
}

function readNormalizedPolicy() {
  if (cachedNormalizedPolicy !== null) {
    return cachedNormalizedPolicy;
  }
  try {
    cachedNormalizedPolicy = normalizePolicyConfig(
      JSON.parse(readFileSync(".github/idd/config.json", "utf8")),
    );
    return cachedNormalizedPolicy;
  } catch {
    cachedNormalizedPolicy = normalizePolicyConfig({});
    return cachedNormalizedPolicy;
  }
}

function isTrustedMarkerAuthor(owner, repo, login) {
  if (!login) {
    return false;
  }

  const normalized = login.toLowerCase();
  if (normalized === currentViewerLogin()) {
    return true;
  }
  if (configuredTrustedMarkerAuthors().has(normalized)) {
    return true;
  }

  if (!trustCollaboratorMarkers()) {
    return false;
  }

  const cacheKey = `${owner}/${repo}:${normalized}`;
  if (trustedMarkerAuthorCache.has(cacheKey)) {
    return trustedMarkerAuthorCache.get(cacheKey);
  }

  const trusted = TRUSTED_MARKER_PERMISSIONS.has(collaboratorPermission(owner, repo, normalized));

  trustedMarkerAuthorCache.set(cacheKey, trusted);
  return trusted;
}

function currentViewerLogin() {
  if (cachedCurrentViewerLogin !== null) {
    return cachedCurrentViewerLogin;
  }

  try {
    cachedCurrentViewerLogin = execFileSync(
      "gh",
      ["api", "user", "--jq", ".login"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().toLowerCase();
  } catch {
    cachedCurrentViewerLogin = "";
  }
  return cachedCurrentViewerLogin;
}

function collaboratorPermission(owner, repo, login) {
  const cacheKey = `${owner}/${repo}:${login}`;
  if (collaboratorPermissionCache.has(cacheKey)) {
    return collaboratorPermissionCache.get(cacheKey);
  }

  let permission = "";
  try {
    permission = execFileSync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().toLowerCase();
  } catch {
    permission = "";
  }

  collaboratorPermissionCache.set(cacheKey, permission);
  return permission;
}

function configuredTrustedMarkerAuthors() {
  if (cachedConfiguredTrustedMarkerAuthors) {
    return cachedConfiguredTrustedMarkerAuthors;
  }

  cachedConfiguredTrustedMarkerAuthors = new Set(
    (process.env.IDD_TRUSTED_MARKER_ACTORS ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
  return cachedConfiguredTrustedMarkerAuthors;
}

function trustCollaboratorMarkers() {
  try {
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync(".github/idd/config.json", "utf8")),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return /^(1|true|yes)$/i.test(process.env.IDD_TRUST_COLLABORATOR_MARKERS ?? "");
}

function detectRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();
}

function parseRepository(value) {
  const parts = value.split("/");
  if (
    parts.length !== 2
    || parts.some((part) => part.length === 0 || /\s/.test(part))
  ) {
    fail(`invalid repository ${value}; expected owner/name`);
  }
  return parts;
}

function ghJson(commandArgs) {
  try {
    return JSON.parse(execFileSync("gh", commandArgs, { encoding: "utf8" }));
  } catch (error) {
    const stdout = String(error.stdout ?? "").trim();
    const stderr = String(error.stderr ?? "").trim();
    const response = parseJsonOrNull(stdout);
    if (response?.message || response?.errors) {
      fail(`gh ${commandArgs.join(" ")} failed: ${JSON.stringify(response)}`);
    }
    if (response) {
      return response;
    }
    fail(`gh ${commandArgs.join(" ")} failed: ${stderr || error.message}`);
  }
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeReport(report, format) {
  if (format === "json") {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(`mode\taction\tcanApply\tapplied\tcommentId\turl`);
  console.log([
    report.mode,
    report.action,
    report.canApply,
    report.applied,
    report.commentId ?? "",
    report.url ?? "",
  ].join("\t"));
  if (report.duplicates.length > 0) {
    console.log("duplicates:");
    console.log("id\tcreatedAt\tupdatedAt\turl");
    for (const duplicate of report.duplicates) {
      console.log([
        duplicate.id ?? "",
        duplicate.createdAt ?? "",
        duplicate.updatedAt ?? "",
        duplicate.url ?? "",
      ].join("\t"));
    }
  }
  if (report.repairPath) {
    console.log(`repairPath:\t${report.repairPath}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    format: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--issue":
        parsed.issue = readValue(argv, ++index, arg);
        break;
      case "--pr":
        parsed.pr = readValue(argv, ++index, arg);
        break;
      case "--repo":
        parsed.repo = readValue(argv, ++index, arg);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--apply":
        parsed.apply = true;
        break;
      case "--phase":
        parsed.phase = readValue(argv, ++index, arg);
        break;
      case "--claim":
        parsed.claim = readValue(argv, ++index, arg);
        break;
      case "--branch":
        parsed.branch = readValue(argv, ++index, arg);
        break;
      case "--last-checked":
        parsed.lastChecked = readValue(argv, ++index, arg);
        break;
      case "--open-blockers":
        parsed.openBlockers = readValue(argv, ++index, arg);
        break;
      case "--next-action":
        parsed.nextAction = readValue(argv, ++index, arg);
        break;
      case "--authoritative-by":
        parsed.authoritativeBy = readValue(argv, ++index, arg);
        break;
      case "--claim-issue":
        parsed.claimIssue = readValue(argv, ++index, arg);
        break;
      case "--claim-id":
        parsed.claimId = readValue(argv, ++index, arg);
        break;
      case "--agent-id":
        parsed.agentId = readValue(argv, ++index, arg);
        break;
      case "--skip-claim-check":
        parsed.skipClaimCheck = true;
        break;
      case "--include-body":
        parsed.includeBody = true;
        break;
      case "--format":
        parsed.format = readValue(argv, ++index, arg);
        if (!["json", "table"].includes(parsed.format)) {
          fail("--format must be json or table");
        }
        break;
      default:
        fail(`unknown argument ${arg}`);
    }
  }

  for (const flag of [
    ["phase", "--phase"],
    ["claim", "--claim"],
    ["branch", "--branch"],
    ["openBlockers", "--open-blockers"],
    ["nextAction", "--next-action"],
    ["authoritativeBy", "--authoritative-by"],
  ]) {
    if (!parsed[flag[0]]) {
      if (!parsed.help) {
        fail(`${flag[1]} is required`);
      }
    }
  }

  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function currentIsoTimestamp() {
  return new Date().toISOString().replace(".000Z", "Z");
}

function printUsage() {
  console.log(`usage: node scripts/live-status-digest.mjs (--issue <number> | --pr <number>) [options]

Options:
  --dry-run                         compute the create/update/noop action (default)
  --apply                           create or update the single current digest
  --phase <text>                    digest Phase field
  --claim <text>                    digest Claim field
  --branch <text>                   digest Branch field
  --last-checked <timestamp>        digest Last checked field (default: current UTC)
  --open-blockers <text>            digest Open blockers field
  --next-action <text>              digest Next action field
  --authoritative-by <text>         digest Authoritative by field
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override
  --format <json|table>             output format (default: json)
  --include-body                    include the rendered body in JSON reports
  --help                            show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS         comma-separated trusted bot/app logins
  IDD_TRUST_COLLABORATOR_MARKERS    set true to trust Write/Maintain/Admin collaborators
`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
