#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { computeReportSummary } from "./audit-pr-cleanup-summary.mjs";
import { normalizePolicyConfig, resolveCollaboratorMarkerTrust } from "./policy-helpers.mjs";
import {
  classifyRegularBotComment,
  hasFreshDisposition,
  indexLatestGatingReviewsByAuthor,
  indexThreadsByReview,
  isDispositionComment,
  isKnownReviewBot,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  summarizeClaimValidation,
  unsafeTextReason,
} from "./protocol-helpers.mjs";

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

if (!args.pr) {
  fail("missing required --pr <number>");
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

const prNumber = parsePositiveInteger(args.pr, "--pr");
const claimContext = { expectedLinkedPrs: buildExpectedLinkedPrReferences(owner, repo, prNumber) };

if (args.claimIssue) {
  args.claimIssue = String(parsePositiveInteger(args.claimIssue, "--claim-issue"));
}

const report = await buildReport(owner, repo, prNumber);

if (args.apply) {
  report.mode = "apply";
  for (const candidate of report.candidates) {
    if (!args.skipClaimCheck) {
      try {
        assertActiveClaim(owner, repo, args.claimIssue, args.agentId, args.claimId, claimContext);
      } catch (error) {
        report.failed.push({
          ...candidate,
          error: error.message,
        });
        break;
      }
    }
    try {
      const freshCandidate = await revalidateCandidate(owner, repo, prNumber, candidate, report);
      if (!freshCandidate) {
        continue;
      }
      if (!args.skipClaimCheck) {
        try {
          assertActiveClaim(owner, repo, args.claimIssue, args.agentId, args.claimId, claimContext);
        } catch (error) {
          report.failed.push({
            ...freshCandidate,
            error: error.message,
          });
          break;
        }
      }
      const minimized = minimizeComment(freshCandidate.subjectId, freshCandidate.classifier);
      report.applied.push({
        ...freshCandidate,
        isMinimized: minimized.isMinimized,
        minimizedReason: minimized.minimizedReason,
      });
    } catch (error) {
      report.failed.push({
        ...candidate,
        error: error.message,
      });
    }
  }

  computeReportSummary(report);
  if (report.failed.length > 0) {
    writeReport(report, args.format);
    process.exit(1);
  }
}

computeReportSummary(report);
writeReport(report, args.format);

async function buildReport(owner, repo, prNumber, options = {}) {
  const pr = fetchPullRequest(owner, repo, prNumber, options);
  const comments = fetchIssueComments(owner, repo, prNumber, options);
  const reviews = fetchReviews(owner, repo, prNumber, options);
  const threads = fetchReviewThreads(owner, repo, prNumber, options);
  const threadIndex = indexThreadsByReview(threads);
  const latestGatingReviews = indexLatestGatingReviewsByAuthor(reviews);

  const report = {
    repository: `${owner}/${repo}`,
    pr: prNumber,
    prUrl: pr.url,
    merged: pr.merged,
    mode: "dry-run",
    candidates: [],
    skipped: [],
    applied: [],
    failed: [],
    summary: null,
    status: null,
  };

  for (const comment of comments) {
    if (evaluateOperationalComment(comment, pr, report, owner, repo)) {
      continue;
    }
    evaluateRegularBotComment(comment, comments, threads, pr, report);
  }

  for (const thread of threads) {
    evaluateReviewComments(thread, pr, latestGatingReviews, report);
  }

  for (const review of reviews) {
    evaluateReviewParent(review, pr, threadIndex, latestGatingReviews, report);
  }

  return report;
}

function evaluateOperationalComment(comment, pr, report, owner, repo) {
  const prefix = operationalMarkerPrefix(comment.body);
  if (!prefix) {
    return false;
  }

  const subject = subjectFromNode(comment, "IssueComment", "OUTDATED");
  const author = comment.author?.login ?? "";

  if (!isTrustedMarkerAuthor(owner, repo, author)) {
    addSkipped(report, subject, "operational marker author is not trusted");
    return true;
  }

  if (prefix === "<!-- forced-handoff:") {
    addSkipped(report, subject, "forced-handoff markers remain audit evidence");
    return true;
  }

  if (!pr.merged) {
    addSkipped(report, subject, "PR is not merged");
    return true;
  }

  const unsafeReason = unsafeTextReason(comment.body);
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return true;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, "already minimized");
    return true;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, "viewer cannot minimize this comment");
    return true;
  }

  report.candidates.push({
    ...subject,
    markerPrefix: prefix,
    reason: "stale IDD operational marker on a merged PR",
  });
  return true;
}

function evaluateRegularBotComment(comment, comments, threads, pr, report) {
  const author = comment.author?.login ?? "";
  if (!isKnownReviewBot(author)) {
    return;
  }

  const classification = classifyRegularBotComment(comment, comments, threads);
  const subject = subjectFromNode(comment, "IssueComment", classification?.classifier ?? "RESOLVED");

  if (!pr.merged) {
    addSkipped(report, subject, "PR is not merged");
    return;
  }

  const unsafeReason = unsafeTextReason(comment.body ?? "");
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, "already minimized");
    return;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, "viewer cannot minimize this comment");
    return;
  }

  if (!classification) {
    addSkipped(report, subject, "known review-bot regular comment lacks a completed-review signal");
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    reason: classification.reason,
  });
}

function evaluateReviewParent(review, pr, threadIndex, latestGatingReviews, report) {
  const author = review.author?.login ?? "";
  if (!isKnownReviewBot(author)) {
    return;
  }

  const subject = subjectFromNode(review, "PullRequestReview", "RESOLVED");
  const associated = threadIndex.get(review.id) ?? { total: 0, unresolved: 0, threadIds: [] };
  const latestGatingReview = latestGatingReviews.get(author.toLowerCase());

  if (!pr.merged) {
    addSkipped(report, subject, "PR is not merged");
    return;
  }

  const unsafeReason = unsafeTextReason(review.body ?? "");
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (review.isMinimized) {
    addSkipped(report, subject, "already minimized");
    return;
  }

  if (!review.viewerCanMinimize) {
    addSkipped(report, subject, "viewer cannot minimize this review");
    return;
  }

  if (review.state === "CHANGES_REQUESTED" || latestGatingReview?.state === "CHANGES_REQUESTED") {
    addSkipped(report, subject, "review author still has an active changes-requested state");
    return;
  }

  if (associated.total === 0) {
    addSkipped(report, subject, "review has no associated review threads");
    return;
  }

  if (associated.incomplete) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: associated.unresolved,
        missingDispositionThreads: associated.missingDisposition,
      },
      "associated review threads have truncated comment data",
    );
    return;
  }

  if (associated.unresolved > 0) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: associated.unresolved,
        missingDispositionThreads: associated.missingDisposition,
      },
      "review has unresolved associated review threads",
    );
    return;
  }

  if (associated.missingDisposition > 0) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: 0,
        missingDispositionThreads: associated.missingDisposition,
      },
      "associated review threads are missing IDD accept/reject dispositions",
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    associatedThreads: associated.total,
    unresolvedThreads: 0,
    missingDispositionThreads: 0,
    reason: "known bot review parent with all associated review threads resolved",
  });
}

function evaluateReviewComments(thread, pr, latestGatingReviews, report) {
  for (const comment of thread.comments?.nodes ?? []) {
    evaluateReviewComment(comment, thread, pr, latestGatingReviews, report);
  }
}

function evaluateReviewComment(comment, thread, pr, latestGatingReviews, report) {
  const author = comment.author?.login ?? "";
  if (!isKnownReviewBot(author) || isDispositionComment(comment)) {
    return;
  }

  const subject = subjectFromNode(comment, "PullRequestReviewComment", "RESOLVED");
  const latestGatingReview = latestGatingReviews.get(author.toLowerCase());

  if (!pr.merged) {
    addSkipped(report, subject, "PR is not merged");
    return;
  }

  const unsafeReason = unsafeTextReason(comment.body ?? "");
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, "already minimized");
    return;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, "viewer cannot minimize this review comment");
    return;
  }

  if (latestGatingReview?.state === "CHANGES_REQUESTED") {
    addSkipped(report, subject, "review author still has an active changes-requested state");
    return;
  }

  if (!thread.isResolved) {
    addSkipped(report, { ...subject, threadId: thread.id }, "review thread is unresolved");
    return;
  }

  if (thread.comments?.pageInfo?.hasNextPage) {
    addSkipped(report, { ...subject, threadId: thread.id }, "review thread comment data is truncated");
    return;
  }

  if (!hasFreshDisposition(thread)) {
    addSkipped(
      report,
      { ...subject, threadId: thread.id },
      "review thread is missing an IDD accept/reject disposition",
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    threadId: thread.id,
    reason: "known bot feedback comment in a resolved review thread",
  });
}

function subjectFromNode(node, type, classifier) {
  return {
    subjectId: node.id,
    url: node.url,
    type,
    classifier,
    viewerCanMinimize: Boolean(node.viewerCanMinimize),
    isMinimized: Boolean(node.isMinimized),
    minimizedReason: node.minimizedReason || null,
  };
}

function addSkipped(report, subject, reason) {
  report.skipped.push({
    ...subject,
    skipReason: reason,
  });
}

function fetchPullRequest(owner, repo, number, options = {}) {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        number
        url
        merged
      }
    }
  }`;
  const result = ghGraphql(query, { owner, repo, number }, options);
  const pr = result.data?.repository?.pullRequest;
  if (!pr) {
    handleGraphqlFailure(`PR #${number} was not found`, options);
  }
  return pr;
}

function fetchIssueComments(owner, repo, number, options = {}) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        comments(first:100,after:$after){
          nodes{
            id
            url
            body
            createdAt
            updatedAt
            isMinimized
            minimizedReason
            viewerCanMinimize
            author{login}
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(query, { owner, repo, number }, (data) => {
    return data.repository.pullRequest.comments;
  }, options);
}

function fetchReviews(owner, repo, number, options = {}) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviews(first:100,after:$after){
          nodes{
            id
            url
            body
            state
            submittedAt
            isMinimized
            minimizedReason
            viewerCanMinimize
            author{login}
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(query, { owner, repo, number }, (data) => {
    return data.repository.pullRequest.reviews;
  }, options);
}

function fetchReviewThreads(owner, repo, number, options = {}) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100,after:$after){
          nodes{
            id
            isResolved
            comments(first:100){
              pageInfo{hasNextPage}
              nodes{
                id
                url
                body
                createdAt
                isMinimized
                minimizedReason
                viewerCanMinimize
                author{login}
                pullRequestReview{id}
              }
            }
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(query, { owner, repo, number }, (data) => {
    return data.repository.pullRequest.reviewThreads;
  }, options);
}

function fetchConnection(query, baseVariables, pickConnection, options = {}) {
  const nodes = [];
  let after = null;

  do {
    const variables = { ...baseVariables };
    if (after) {
      variables.after = after;
    }
    const result = ghGraphql(query, variables, options);
    if (result.errors?.length) {
      handleGraphqlFailure(
        `GraphQL connection query failed: ${formatGraphqlErrors(result.errors)}; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    if (!result.data) {
      handleGraphqlFailure(
        `GraphQL connection query returned no data; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    const connection = pickConnection(result.data);
    if (!connection) {
      handleGraphqlFailure(
        `GraphQL connection query returned no connection; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    nodes.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return nodes;
}

function formatGraphqlErrors(errors) {
  return errors.map((error) => error.message ?? JSON.stringify(error)).join("; ");
}

function formatGraphqlContext(query, variables) {
  const compactQuery = query.replace(/\s+/g, " ").trim();
  const queryPreview = compactQuery.length > 240
    ? `${compactQuery.slice(0, 237)}...`
    : compactQuery;
  return `query=${queryPreview}; variables=${JSON.stringify(variables)}`;
}

function minimizeComment(subjectId, classifier) {
  const query = `mutation($id:ID!,$classifier:ReportedContentClassifiers!){
    minimizeComment(input:{subjectId:$id,classifier:$classifier}){
      minimizedComment{
        __typename
        ... on IssueComment{id url isMinimized minimizedReason}
        ... on PullRequestReview{id url isMinimized minimizedReason}
        ... on PullRequestReviewComment{id url isMinimized minimizedReason}
      }
    }
  }`;
  const result = ghGraphql(query, { id: subjectId, classifier }, { throwOnError: true });
  if (result.errors?.length) {
    throw new Error(
      `GraphQL mutation failed: ${formatGraphqlErrors(result.errors)}; ${formatGraphqlContext(query, { id: subjectId, classifier })}`,
    );
  }
  const minimized = result.data?.minimizeComment?.minimizedComment;
  if (!minimized) {
    throw new Error(
      `GraphQL mutation returned no minimized comment; ${formatGraphqlContext(query, { id: subjectId, classifier })}`,
    );
  }
  return minimized;
}

async function revalidateCandidate(owner, repo, prNumber, candidate, report) {
  const freshReport = await buildReport(owner, repo, prNumber, { throwOnError: true });
  const freshCandidate = freshReport.candidates.find((current) => {
    return current.subjectId === candidate.subjectId && current.classifier === candidate.classifier;
  });
  if (freshCandidate) {
    return freshCandidate;
  }

  const skipped = freshReport.skipped.find((current) => {
    return current.subjectId === candidate.subjectId && current.classifier === candidate.classifier;
  });
  addSkipped(
    report,
    candidate,
    `pre-minimize revalidation failed: ${skipped?.skipReason ?? "candidate is no longer eligible"}`,
  );
  return null;
}

function assertActiveClaim(owner, repo, issueNumber, agentId, claimId, options = {}) {
  const active = readActiveClaim(owner, repo, issueNumber, options);
  if (!active || active.claimId !== claimId || (agentId && active.agentId !== agentId)) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : "none";
    throw new Error(`claim check failed for #${issueNumber}: active claim is ${activeLabel}`);
  }
}

function readActiveClaim(owner, repo, issueNumber, options = {}) {
  const result = JSON.parse(
    execFileSync(
      "gh",
      [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "comments",
      ],
      { encoding: "utf8" },
    ),
  );

  const comments = (result.comments ?? []).map((comment) => ({
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? "",
    author: { login: comment.author?.login ?? "" },
  }));

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

function resolveTrustedMarkerLogins(owner, repo, comments) {
  return normalizeTrustedMarkerLogins(
    comments
      .map((comment) => comment.author?.login ?? "")
      .filter(Boolean)
      .filter((login) => isTrustedMarkerAuthor(owner, repo, login)),
  );
}

function forcedHandoffAuthorityPolicy() {
  if (cachedForcedHandoffAuthorityPolicy !== null) {
    return cachedForcedHandoffAuthorityPolicy;
  }
  cachedForcedHandoffAuthorityPolicy = readNormalizedPolicy().forcedHandoff.authorityPolicy;
  return cachedForcedHandoffAuthorityPolicy;
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

  let trusted = false;
  try {
    const permission = execFileSync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().toLowerCase();
    trusted = TRUSTED_MARKER_PERMISSIONS.has(permission);
  } catch {
    trusted = false;
  }

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

function ghGraphql(query, variables, options = {}) {
  const commandArgs = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Number.isInteger(value)) {
      commandArgs.push("-F", `${key}=${value}`);
    } else {
      commandArgs.push("-f", `${key}=${value}`);
    }
  }

  try {
    return JSON.parse(execFileSync("gh", commandArgs, { encoding: "utf8" }));
  } catch (error) {
    const stdout = String(error.stdout ?? "").trim();
    const stderr = String(error.stderr ?? "").trim();
    const response = parseJsonOrNull(stdout);
    if (response?.errors?.length) {
      handleGraphqlFailure(
        `GraphQL request failed: ${formatGraphqlErrors(response.errors)}; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    handleGraphqlFailure(
      `gh api graphql failed: ${stderr || error.message}; ${formatGraphqlContext(query, variables)}`,
      options,
    );
  }
}

function handleGraphqlFailure(message, options) {
  if (options.throwOnError) {
    throw new Error(message);
  }
  fail(message);
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function writeReport(report, format) {
  if (format === "json") {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // Print summary header
  if (report.summary) {
    console.log(
      `summary: status=${report.status}, candidates=${report.summary.candidate}, applied=${report.summary.applied}, failed=${report.summary.failed}, skipped=${report.summary.skipped}`
    );
    console.log("");
  }

  printRows("candidates", report.candidates);
  printRows("skipped", report.skipped);
  if (report.applied.length > 0) {
    printRows("applied", report.applied);
  }
  if (report.failed.length > 0) {
    printRows("failed", report.failed);
  }
}

function printRows(label, rows) {
  console.log(`${label}: ${rows.length}`);
  if (rows.length === 0) {
    return;
  }
  console.log(
    [
      "subjectId",
      "type",
      "classifier",
      "viewerCanMinimize",
      "isMinimized",
      "minimizedReason",
      "reason",
      "url",
    ].join("\t"),
  );
  for (const row of rows) {
    console.log(
      [
        row.subjectId,
        row.type,
        row.classifier,
        row.viewerCanMinimize,
        row.isMinimized,
        row.minimizedReason ?? "",
        row.error ?? row.skipReason ?? row.reason ?? "",
        row.url,
      ].join("\t"),
    );
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
      case "--format":
        parsed.format = readValue(argv, ++index, arg);
        if (!["json", "table"].includes(parsed.format)) {
          fail("--format must be json or table");
        }
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
      default:
        fail(`unknown argument ${arg}`);
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

function printUsage() {
  console.log(`usage: node scripts/audit-pr-cleanup.mjs --pr <number> [options]

Options:
  --dry-run                         list candidates without mutating (default)
  --apply                           minimize safe candidates
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override
  --format <json|table>             output format (default: json)
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
