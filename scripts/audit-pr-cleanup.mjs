#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const OPERATIONAL_MARKER_PREFIXES = [
  "<!-- review-watermark:",
  "<!-- review-baseline:",
  "advisory-wait:",
  "advisory-wait-recovery:",
  "<!-- advisory-wait:",
];

const REVIEW_BOT_LOGINS = new Set([
  "coderabbitai",
  "coderabbitai[bot]",
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

const UNSAFE_TEXT_RULES = [
  {
    pattern: /\*\*Awaiting maintainer decision\*\*/i,
    reason: "contains an awaiting-maintainer-decision marker",
  },
  {
    pattern: /\bactive hold\b/i,
    reason: "contains active hold context",
  },
  {
    pattern: /\bfailed[- ]ci\b|\bfailing ci\b|\bci failure\b|\bci failed\b|\bfailed checks?\b/i,
    reason: "contains failed-CI context",
  },
];

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
const [owner, repo] = repository.split("/");
if (!owner || !repo) {
  fail(`invalid repository ${repository}`);
}

const prNumber = Number.parseInt(args.pr, 10);
if (!Number.isInteger(prNumber) || prNumber < 1) {
  fail(`invalid --pr value ${args.pr}`);
}

const report = await buildReport(owner, repo, prNumber);

if (args.apply) {
  report.mode = "apply";
  for (const candidate of report.candidates) {
    if (!args.skipClaimCheck) {
      assertActiveClaim(owner, repo, args.claimIssue, args.agentId, args.claimId);
    }
    try {
      const minimized = minimizeComment(candidate.subjectId, candidate.classifier);
      report.applied.push({
        ...candidate,
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

  if (report.failed.length > 0) {
    writeReport(report, args.format);
    process.exit(1);
  }
}

writeReport(report, args.format);

async function buildReport(owner, repo, prNumber) {
  const pr = fetchPullRequest(owner, repo, prNumber);
  const comments = fetchIssueComments(owner, repo, prNumber);
  const reviews = fetchReviews(owner, repo, prNumber);
  const threads = fetchReviewThreads(owner, repo, prNumber);
  const threadIndex = indexThreadsByReview(threads);

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
  };

  for (const comment of comments) {
    evaluateOperationalComment(comment, pr, report);
  }

  for (const review of reviews) {
    evaluateReviewParent(review, pr, threadIndex, report);
  }

  return report;
}

function evaluateOperationalComment(comment, pr, report) {
  const prefix = operationalMarkerPrefix(comment.body);
  if (!prefix) {
    return;
  }

  const subject = subjectFromNode(comment, "IssueComment", "OUTDATED");

  if (!pr.merged) {
    addSkipped(report, subject, "PR is not merged");
    return;
  }

  const unsafeReason = unsafeTextReason(comment.body);
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

  report.candidates.push({
    ...subject,
    markerPrefix: prefix,
    reason: "stale IDD operational marker on a merged PR",
  });
}

function evaluateReviewParent(review, pr, threadIndex, report) {
  const author = review.author?.login ?? "";
  if (!isKnownReviewBot(author)) {
    return;
  }

  const subject = subjectFromNode(review, "PullRequestReview", "RESOLVED");
  const associated = threadIndex.get(review.id) ?? { total: 0, unresolved: 0, threadIds: [] };

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

  if (associated.total === 0) {
    addSkipped(report, subject, "review has no associated review threads");
    return;
  }

  if (associated.unresolved > 0) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: associated.unresolved,
      },
      "review has unresolved associated review threads",
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    associatedThreads: associated.total,
    unresolvedThreads: 0,
    reason: "known bot review parent with all associated review threads resolved",
  });
}

function subjectFromNode(node, type, classifier) {
  return {
    subjectId: node.id,
    url: node.url,
    type,
    classifier,
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

function operationalMarkerPrefix(body) {
  const trimmed = body.trimStart();
  return OPERATIONAL_MARKER_PREFIXES.find((prefix) => trimmed.startsWith(prefix)) ?? null;
}

function unsafeTextReason(body) {
  for (const rule of UNSAFE_TEXT_RULES) {
    if (rule.pattern.test(body)) {
      return rule.reason;
    }
  }
  return null;
}

function isKnownReviewBot(login) {
  return REVIEW_BOT_LOGINS.has(login.toLowerCase());
}

function indexThreadsByReview(threads) {
  const index = new Map();

  for (const thread of threads) {
    const reviewIds = new Set(
      (thread.comments?.nodes ?? [])
        .map((comment) => comment.pullRequestReview?.id)
        .filter(Boolean),
    );

    for (const reviewId of reviewIds) {
      const current = index.get(reviewId) ?? { total: 0, unresolved: 0, threadIds: [] };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }

  return index;
}

function fetchPullRequest(owner, repo, number) {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        number
        url
        merged
      }
    }
  }`;
  const result = ghGraphql(query, { owner, repo, number });
  const pr = result.data?.repository?.pullRequest;
  if (!pr) {
    fail(`PR #${number} was not found`);
  }
  return pr;
}

function fetchIssueComments(owner, repo, number) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        comments(first:100,after:$after){
          nodes{
            id
            url
            body
            createdAt
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
  });
}

function fetchReviews(owner, repo, number) {
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
  });
}

function fetchReviewThreads(owner, repo, number) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100,after:$after){
          nodes{
            id
            isResolved
            comments(first:100){
              nodes{
                id
                url
                body
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
  });
}

function fetchConnection(query, baseVariables, pickConnection) {
  const nodes = [];
  let after = null;

  do {
    const variables = { ...baseVariables };
    if (after) {
      variables.after = after;
    }
    const result = ghGraphql(query, variables);
    const connection = pickConnection(result.data);
    nodes.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return nodes;
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
  const result = ghGraphql(query, { id: subjectId, classifier });
  return result.data.minimizeComment.minimizedComment;
}

function assertActiveClaim(owner, repo, issueNumber, agentId, claimId) {
  const active = readActiveClaim(owner, repo, issueNumber);
  if (!active || active.agentId !== agentId || active.claimId !== claimId) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : "none";
    fail(`claim check failed for #${issueNumber}: active claim is ${activeLabel}`);
  }
}

function readActiveClaim(owner, repo, issueNumber) {
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

  const comments = [...(result.comments ?? [])].sort((left, right) => {
    return new Date(left.createdAt) - new Date(right.createdAt);
  });

  let active = null;

  for (const comment of comments) {
    const claim = parseClaim(comment.body, comment.createdAt);
    if (claim) {
      if (active && claim.agentId === active.agentId && claim.claimId === active.claimId) {
        active.createdAt = claim.createdAt;
        continue;
      }

      if (!active && claim.supersedes === "none") {
        active = claim;
        continue;
      }

      if (
        active
        && claim.supersedes === active.claimId
        && (claim.agentId === active.agentId || isStaleAt(active.createdAt, claim.createdAt))
      ) {
        active = claim;
      }
      continue;
    }

    const release = parseRelease(comment.body);
    if (
      release
      && active
      && release.agentId === active.agentId
      && release.claimId === active.claimId
    ) {
      active = null;
    }
  }

  return active;
}

function parseClaim(body, createdAt) {
  const match = body.match(
    /<!--\s*claimed-by:\s+(\S+)\s+(\S+)\s+supersedes:\s+(\S+)\s+\S+\s+branch:\s+([^\s>]+)\s*-->/,
  );
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
    supersedes: match[3],
    branch: match[4],
    createdAt,
  };
}

function parseRelease(body) {
  const match = body.match(/<!--\s*unclaimed-by:\s+(\S+)\s+(\S+)\s+\S+\s*-->/);
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
  };
}

function isStaleAt(activeCreatedAt, nextCreatedAt) {
  const staleMs = 24 * 60 * 60 * 1000;
  return new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >= staleMs;
}

function ghGraphql(query, variables) {
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

  return JSON.parse(execFileSync("gh", commandArgs, { encoding: "utf8" }));
}

function detectRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();
}

function writeReport(report, format) {
  if (format === "json") {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
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
    agentId: "codex-cli",
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

function printUsage() {
  console.log(`usage: node scripts/audit-pr-cleanup.mjs --pr <number> [options]

Options:
  --dry-run                         list candidates without mutating (default)
  --apply                           minimize safe candidates
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   claim agent id (default: codex-cli)
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override
  --format <json|table>             output format (default: json)
  --help                            show this help
`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
