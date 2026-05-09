#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const OPERATIONAL_MARKERS = [
  {
    label: "<!-- review-watermark:",
    pattern: /^<!--\s*review-watermark:\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s*-->/,
  },
  {
    label: "<!-- review-baseline:",
    pattern: /^<!--\s*review-baseline:\s+\S+\s+\S+\s+\S+\s*-->/,
  },
  {
    label: "advisory-wait:",
    pattern: /^advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*$/,
  },
  {
    label: "advisory-wait-recovery:",
    pattern: /^advisory-wait-recovery:\s+\S+\s+[0-9a-f]{40}\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s*$/,
  },
  {
    label: "<!-- advisory-wait:",
    pattern: /^<!--\s*advisory-wait:\s+\S+\s+[0-9a-f]{40}\s+\S+\s*-->\s*$/,
  },
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

const ISO8601_UTC_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;

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

if (args.claimIssue) {
  args.claimIssue = String(parsePositiveInteger(args.claimIssue, "--claim-issue"));
}

const report = await buildReport(owner, repo, prNumber);

if (args.apply) {
  report.mode = "apply";
  for (const candidate of report.candidates) {
    if (!args.skipClaimCheck) {
      try {
        assertActiveClaim(owner, repo, args.claimIssue, args.agentId, args.claimId);
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
  };

  for (const comment of comments) {
    evaluateOperationalComment(comment, pr, report);
  }

  for (const review of reviews) {
    evaluateReviewParent(review, pr, threadIndex, latestGatingReviews, report);
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

function operationalMarkerPrefix(body) {
  const normalized = body.trimEnd();
  return OPERATIONAL_MARKERS.find((marker) => marker.pattern.test(normalized))?.label ?? null;
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

function indexLatestGatingReviewsByAuthor(reviews) {
  const index = new Map();
  for (const review of reviews) {
    if (review.state === "COMMENTED") {
      continue;
    }
    const author = review.author?.login?.toLowerCase();
    if (!author) {
      continue;
    }
    const current = index.get(author);
    const submittedAt = review.submittedAt ?? "";
    if (!current || submittedAt > (current.submittedAt ?? "")) {
      index.set(author, review);
    }
  }
  return index;
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
      const current = index.get(reviewId) ?? {
        total: 0,
        unresolved: 0,
        missingDisposition: 0,
        incomplete: false,
        threadIds: [],
      };
      current.total += 1;
      if (!thread.isResolved) {
        current.unresolved += 1;
      }
      if (!hasFreshDisposition(thread)) {
        current.missingDisposition += 1;
      }
      if (thread.comments?.pageInfo?.hasNextPage) {
        current.incomplete = true;
      }
      current.threadIds.push(thread.id);
      index.set(reviewId, current);
    }
  }

  return index;
}

function hasFreshDisposition(thread) {
  const comments = thread.comments?.nodes ?? [];
  const latestFeedbackAt = comments
    .filter((comment) => !isIddDispositionComment(comment))
    .map((comment) => comment.createdAt)
    .sort()
    .at(-1);

  return comments.some((comment) => {
    if (!isIddDispositionComment(comment)) {
      return false;
    }
    return !latestFeedbackAt || comment.createdAt > latestFeedbackAt;
  });
}

function isIddDispositionComment(comment) {
  const author = comment.author?.login ?? "";
  return isDispositionComment(comment) && !isKnownReviewBot(author);
}

function isDispositionComment(comment) {
  const body = (comment.body ?? "").trimStart();
  return body.startsWith("**Accepted**") || body.startsWith("**Rejected**");
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
              pageInfo{hasNextPage}
              nodes{
                id
                url
                body
                createdAt
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
    if (result.errors?.length) {
      fail(
        `GraphQL connection query failed: ${formatGraphqlErrors(result.errors)}; ${formatGraphqlContext(query, variables)}`,
      );
    }
    if (!result.data) {
      fail(
        `GraphQL connection query returned no data; ${formatGraphqlContext(query, variables)}`,
      );
    }
    const connection = pickConnection(result.data);
    if (!connection) {
      fail(
        `GraphQL connection query returned no connection; ${formatGraphqlContext(query, variables)}`,
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
  const freshReport = await buildReport(owner, repo, prNumber);
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

function assertActiveClaim(owner, repo, issueNumber, agentId, claimId) {
  const active = readActiveClaim(owner, repo, issueNumber);
  if (!active || active.claimId !== claimId || (agentId && active.agentId !== agentId)) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : "none";
    throw new Error(`claim check failed for #${issueNumber}: active claim is ${activeLabel}`);
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
  const retiredClaimIds = new Set();

  for (const comment of comments) {
    const claim = parseClaim(comment.body, comment.createdAt);
    if (claim) {
      if (retiredClaimIds.has(claim.claimId)) {
        continue;
      }

      if (active && claim.agentId === active.agentId && claim.claimId === active.claimId) {
        active.createdAt = claim.createdAt;
        continue;
      }

      if (active && claim.claimId === active.claimId) {
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
        retiredClaimIds.add(active.claimId);
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
      retiredClaimIds.add(active.claimId);
      active = null;
    }
  }

  return active;
}

function parseClaim(body, createdAt) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*claimed-by:\\s+(\\S+)\\s+(\\S+)\\s+supersedes:\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s+branch:\\s+([^\\s>]+)\\s*-->$`,
    ),
  );
  if (!match || !isValidIsoTimestamp(match[4])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
    supersedes: match[3],
    branch: match[5],
    createdAt,
  };
}

function parseRelease(body) {
  const match = body.trimEnd().match(
    new RegExp(
      `^<!--\\s*unclaimed-by:\\s+(\\S+)\\s+(\\S+)\\s+(${ISO8601_UTC_PATTERN.source})\\s*-->$`,
    ),
  );
  if (!match || !isValidIsoTimestamp(match[3])) {
    return null;
  }
  return {
    agentId: match[1],
    claimId: match[2],
  };
}

function isValidIsoTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(".000Z", "Z") === value;
}

function isStaleAt(activeCreatedAt, nextCreatedAt) {
  const staleMs = 24 * 60 * 60 * 1000;
  return new Date(nextCreatedAt).getTime() - new Date(activeCreatedAt).getTime() >= staleMs;
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
`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}
