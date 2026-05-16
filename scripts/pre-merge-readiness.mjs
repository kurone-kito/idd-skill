#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { readAdvisoryWaitPolicy } from "./advisory-wait-policy.mjs";
import {
  buildPreMergeReadinessSummary,
  deriveIddAgentLogins,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  parsePaginatedGhNdjson,
  resolveCodeownersForFiles,
  resolveRulesetDetailPath,
  selectCodeownersText,
} from "./protocol-helpers.mjs";
import { normalizePolicyConfig, resolveCollaboratorMarkerTrust } from "./policy-helpers.mjs";

const APPROVAL_ACTOR_POLICY = new Set([
  "owners-and-maintainers-only",
  "all-write-permission-actors",
]);
const APPROVAL_ACTOR_POLICY_DEFAULT = "owners-and-maintainers-only";

const args = parseArgs(process.argv.slice(2));
if (!args.prNumber) {
  throw new Error("missing required --pr <number> argument");
}
if (!args.claimIssueNumber) {
  throw new Error("missing required --claim-issue <number> argument");
}

const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
const repoRef = `${owner}/${repo}`;
const viewerLogin = safeGhText(["api", "user", "--jq", ".login"]).toLowerCase();
const viewerAppSlug = safeGhText(["api", "app", "--jq", ".slug // .app_slug // empty"]).toLowerCase();
const configuredTrustedActors = normalizeTrustedMarkerLogins([
  ...splitCsv(args.trustedMarkerLogins),
  ...splitCsv(process.env.IDD_TRUSTED_MARKER_ACTORS),
]);
const advisoryBotLogins = normalizeTrustedMarkerLogins(splitCsv(args.advisoryBotLogins));

const pr = ghJson([
  "pr",
  "view",
  String(args.prNumber),
  "-R",
  repoRef,
  "--json",
  "headRefOid,baseRefName,url,author,reviewDecision",
  "--jq",
  ".",
]);
const prHeadSha = String(pr.headRefOid ?? "");
const baseRefName = String(pr.baseRefName ?? "");
const prUrl = String(pr.url ?? "");
const prAuthorLogin = String(pr.author?.login ?? "").toLowerCase();
const reviewDecision = String(pr.reviewDecision ?? "");
const encodedBaseRefName = encodeURIComponent(baseRefName);

const checks = ghJson(
  [
    "pr",
    "checks",
    String(args.prNumber),
    "-R",
    repoRef,
    "--json",
    "name,state,completedAt",
    "--jq",
    ".",
  ],
  { allowStatuses: [1, 8] },
);
const branchRules = ghApiJson(
  `repos/${owner}/${repo}/rules/branches/${encodedBaseRefName}`,
  true,
  [],
  { allowHttpStatuses: [404] },
);
const branchRulesets = fetchBranchRulesets(owner, repo, branchRules);
const branchProtection = ghApiJson(
  `repos/${owner}/${repo}/branches/${encodedBaseRefName}/protection`,
  false,
  [],
  { allowHttpStatuses: [404] },
);
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
const comments = ghApiJson(`repos/${owner}/${repo}/issues/${args.prNumber}/comments`, true);
const claimComments = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.claimIssueNumber}/comments`,
  true,
);
const threads = fetchReviewThreads(owner, repo, args.prNumber);
const changedFiles = ghApiJson(`repos/${owner}/${repo}/pulls/${args.prNumber}/files`, true)
  .map((file) => String(file.filename ?? ""))
  .filter(Boolean);
const codeownersText = fetchCodeownersText(owner, repo, baseRefName);
const eligibleCodeownerUserLogins = resolveEligibleCodeownerUserLogins(
  owner,
  repo,
  resolveCodeownersForFiles(codeownersText, changedFiles).codeownerUserLogins,
);
const viewerTeamSlugs = resolveViewerClassicBypassTeamSlugs(owner, viewerLogin, branchProtection);

const collaboratorTrustEnabled = readCollaboratorTrustEnabled();
const trustedMarkerLogins = normalizeTrustedMarkerLogins([
  viewerLogin,
  ...configuredTrustedActors,
  ...(collaboratorTrustEnabled
    ? resolveTrustedCollaboratorMarkerLogins(owner, repo, [...comments, ...claimComments])
    : []),
]);
const iddAgentLogins = deriveIddAgentLogins({
  viewerLogin,
  iddAgentLogins: splitCsv(args.iddAgentLogins),
  trustedMarkerLogins,
  operationalComments: [...comments, ...claimComments],
});
const advisoryWaitPolicy = readAdvisoryWaitPolicy();
const forcedHandoffAuthorityPolicy = readForcedHandoffAuthorityPolicy();
const forcedHandoffEnabled = readForcedHandoffMode() === "human-gated";
const forcedHandoffPermissionCache = new Map();

const summary = buildPreMergeReadinessSummary(
  {
    prHeadSha,
    comments: comments.map(normalizeComment),
    reviews: reviews.map(normalizeReview),
    threads: threads.map(normalizeThread),
    checks,
    branchRules,
    branchRulesets,
    branchProtection,
    requestedReviewers: requestedReviewers.users ?? [],
    timelineEvents,
    claimEvents: claimComments.map(normalizeClaimComment),
    changedFiles,
    codeownersText,
    eligibleCodeownerUserLogins,
    reviewDecision,
  },
  {
    now: args.now || new Date().toISOString().replace(".000Z", "Z"),
    trustedMarkerLogins,
    iddAgentLogins,
    advisoryBotLogins,
    prAuthorLogin,
    expectedClaimId: args.expectedClaimId,
    expectedAgentId: args.expectedAgentId,
    includeDispositionEvidence: true,
    requestCap: advisoryWaitPolicy.requestCap,
    pendingWindowMinutes: advisoryWaitPolicy.pendingWindowMinutes,
    settledWindowMinutes: advisoryWaitPolicy.settledWindowMinutes,
    pollIntervalMinutes: advisoryWaitPolicy.pollIntervalMinutes,
    capExhaustedRoute: advisoryWaitPolicy.capExhaustedRoute,
    forcedHandoffEnabled,
    expectedLinkedPrs: [String(args.prNumber), prUrl].filter(Boolean),
    isAuthorizedForcedHandoff:
      (forcedBy) => isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicy,
        forcedHandoffPermissionCache,
      ),
    viewerLogin,
    viewerTeamSlugs,
    viewerAppSlug,
    configuredTrustedActors,
    collaboratorTrustEnabled,
  },
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    claimIssueNumber: null,
    owner: "",
    repo: "",
    trustedMarkerLogins: "",
    iddAgentLogins: "",
    advisoryBotLogins: "",
    expectedClaimId: "",
    expectedAgentId: "",
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
    if (token === "--claim-issue") {
      parsed.claimIssueNumber = Number.parseInt(value ?? "", 10);
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
    if (token === "--idd-agent-logins") {
      parsed.iddAgentLogins = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--advisory-bot-logins") {
      parsed.advisoryBotLogins = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--expected-claim-id") {
      parsed.expectedClaimId = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--expected-agent-id") {
      parsed.expectedAgentId = value ?? "";
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
  if (!Number.isInteger(parsed.claimIssueNumber) || parsed.claimIssueNumber < 1) {
    parsed.claimIssueNumber = null;
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/pre-merge-readiness.mjs --pr <number> --claim-issue <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--idd-agent-logins <login1,login2>] [--advisory-bot-logins <login1,login2>] [--expected-claim-id <claim-id>] [--expected-agent-id <agent-id>] [--now <ISO8601>]
`);
}

function normalizeComment(comment) {
  return {
    id: String(comment.id ?? ""),
    author: { login: comment.user?.login ?? "" },
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  };
}

function normalizeClaimComment(comment) {
  return {
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    author: { login: comment.user?.login ?? "" },
  };
}

function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? "" },
    state: review.state ?? "",
    commitId: review.commit_id ?? "",
    submittedAt: review.submitted_at ?? "",
    createdAt: review.submitted_at ?? "",
    updatedAt: review.updated_at ?? review.submitted_at ?? "",
  };
}

function normalizeThread(thread) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: "",
    reviewerReopenedAt: inferReviewerReopenedAt(thread),
    comments: {
      pageInfo: { hasNextPage: Boolean(thread.comments?.pageInfo?.hasNextPage) },
      nodes: (thread.comments?.nodes ?? []).map((comment) => ({
        author: { login: comment.author?.login ?? "" },
        body: comment.body ?? "",
        createdAt: comment.createdAt ?? "",
        updatedAt: comment.updatedAt ?? comment.createdAt ?? "",
        pullRequestReview: { id: comment.pullRequestReview?.id ?? null },
      })),
    },
  };
}

function inferReviewerReopenedAt(thread) {
  return thread.reviewerReopenedAt ?? "";
}

function resolveTrustedCollaboratorMarkerLogins(owner, repo, comments) {
  const markerAuthors = [...new Set(
    comments
      .filter((comment) => operationalMarkerPrefix(comment.body ?? "") !== null)
      .map((comment) => comment.user?.login ?? "")
      .filter(Boolean),
  )];

  return markerAuthors.filter((login) => {
    const permission = safeGhText([
      "api",
      `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      "--jq",
      ".permission",
    ]).toLowerCase();

    return permission === "admin" || permission === "maintain" || permission === "write";
  });
}

function resolveEligibleCodeownerUserLogins(owner, repo, logins) {
  return normalizeTrustedMarkerLogins(logins)
    .filter((login) => {
      const permission = safeGhText([
        "api",
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ]).toLowerCase();

      return permission === "admin" || permission === "maintain" || permission === "write";
    });
}

function fetchCodeownersText(owner, repo, ref) {
  const payloads = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].map((path) => {
    return ghApiJson(
      `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      false,
      [],
      { allowHttpStatuses: [404] },
    );
  });
  return selectCodeownersText(payloads);
}

function fetchBranchRulesets(owner, repo, branchRules) {
  const rulesetPaths = [];
  const seenPaths = new Set();
  for (const rule of branchRules ?? []) {
    const rulesetId = Number.parseInt(String(rule?.ruleset_id ?? ""), 10);
    if (!Number.isInteger(rulesetId)) {
      continue;
    }
    const path = resolveRulesetDetailPath(owner, repo, rule, rulesetId);
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    rulesetPaths.push(path);
  }

  return rulesetPaths
    .map((path) => {
      try {
        return ghApiJson(
          path,
          false,
          ["-H", "Accept: application/vnd.github+json"],
          { allowHttpStatuses: [404] },
        );
      } catch {
        return {};
      }
    })
    .filter((ruleset) => Object.keys(ruleset).length > 0);
}

function resolveViewerClassicBypassTeamSlugs(owner, viewerLogin, branchProtection) {
  if (!viewerLogin) {
    return [];
  }
  const teams = branchProtection.required_pull_request_reviews?.bypass_pull_request_allowances?.teams ?? [];
  const viewerTeams = new Set();
  for (const team of teams) {
    const slug = String(team?.slug ?? "").trim().toLowerCase();
    if (!slug) {
      continue;
    }
    const org = String(team?.organization?.login ?? extractTeamOrgFromHtmlUrl(team?.html_url) ?? owner)
      .trim();
    const state = safeGhText([
      "api",
      `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${
        encodeURIComponent(viewerLogin)
      }`,
      "--jq",
      ".state",
    ]).toLowerCase();
    if (state === "active") {
      viewerTeams.add(slug);
    }
  }
  return [...viewerTeams].sort();
}

function extractTeamOrgFromHtmlUrl(htmlUrl) {
  const match = String(htmlUrl ?? "").match(/\/orgs\/([^/]+)\/teams\//);
  return match?.[1] ?? "";
}

function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;

  while (true) {
    const payload = ghGraphql(
      `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      body
                      createdAt
                      updatedAt
                      author { login }
                      pullRequestReview { id }
                    }
                  }
                }
              }
            }
          }
        }`,
      {
        owner,
        repo,
        number: Number.parseInt(String(prNumber), 10),
        cursor,
      },
    );

    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.comments?.pageInfo?.hasNextPage) {
        thread.comments.nodes.push(
          ...fetchThreadCommentPages(thread.id, thread.comments.pageInfo.endCursor),
        );
        thread.comments.pageInfo.hasNextPage = false;
      }
    }
    nodes.push(...(reviewThreads?.nodes ?? []));

    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return nodes;
}

function fetchThreadCommentPages(threadId, afterCursor) {
  const nodes = [];
  let cursor = afterCursor;

  while (cursor) {
    const payload = ghGraphql(
      `
        query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  body
                  createdAt
                  updatedAt
                  author { login }
                  pullRequestReview { id }
                }
              }
            }
          }
        }`,
      { id: threadId, cursor },
    );

    const comments = payload?.data?.node?.comments;
    nodes.push(...(comments?.nodes ?? []));
    cursor = comments?.pageInfo?.hasNextPage ? comments.pageInfo.endCursor : null;
  }

  return nodes;
}

function ghGraphql(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
      continue;
    }
    args.push("-f", `${key}=${value}`);
  }
  return JSON.parse(runGh(args).trim() || "{}");
}

function ghJson(args, options = {}) {
  return JSON.parse(runGh(args, options).trim() || "[]");
}

function ghText(args) {
  return runGh(args).trim();
}

function safeGhText(args) {
  try {
    return ghText(args);
  } catch {
    return "";
  }
}

function ghApiJson(path, paginate = false, extraArgs = [], options = {}) {
  const args = ["api", path, ...extraArgs];
  if (paginate) {
    // gh api with --paginate and --jq '.[]' emits one JSON object per line.
    // --slurp landed in gh v2.48.0, but Ubuntu 24.04 LTS ships gh v2.45.0
    // via apt, so keep the NDJSON-compatible form here.
    args.push("--paginate", "--jq", ".[]");
  }
  const raw = runGh(args, options).trim();
  if (!raw) {
    return paginate ? [] : {};
  }
  if (paginate) {
    return parsePaginatedGhNdjson(raw);
  }
  return JSON.parse(raw);
}

function runGh(args, options = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const status = Number(error?.status ?? -1);
    if ((options.allowStatuses ?? []).includes(status)) {
      const stdout = String(error?.stdout ?? "");
      if (/^\s*[[{]/.test(stdout)) {
        return stdout;
      }
    }
    const stderr = String(error?.stderr ?? "");
    const httpStatus = Number(stderr.match(/HTTP\s+(\d+)/i)?.[1] ?? -1);
    if ((options.allowHttpStatuses ?? []).includes(httpStatus)) {
      return String(error?.stdout ?? "");
    }
    throw error;
  }
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
  const policy = readNormalizedPolicy().forcedHandoff.authorityPolicy;
  return APPROVAL_ACTOR_POLICY.has(policy) ? policy : APPROVAL_ACTOR_POLICY_DEFAULT;
}

function readForcedHandoffMode() {
  return readNormalizedPolicy().forcedHandoff.mode;
}

function readNormalizedPolicy() {
  try {
    return normalizePolicyConfig(JSON.parse(readFileSync(".github/idd/config.json", "utf8")));
  } catch {
    return normalizePolicyConfig({});
  }
}

function isAuthorizedForcedHandoffActor(owner, repo, login, policy, cache) {
  const normalized = String(login ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  const permission = safeGhText([
    "api",
    `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalized)}/permission`,
    "--jq",
    ".permission",
  ]).toLowerCase();
  const isAuthorized = policy === "all-write-permission-actors"
    ? permission === "admin" || permission === "maintain" || permission === "write"
    : permission === "admin" || permission === "maintain";

  cache.set(normalized, isAuthorized);
  return isAuthorized;
}
