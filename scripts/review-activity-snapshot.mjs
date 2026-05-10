#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { buildActivitySnapshotSummary } from "./protocol-helpers.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.prNumber) {
  throw new Error("missing required --pr <number> argument");
}

const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
const trustedMarkerLogins = args.trustedMarkerLogins
  .split(",")
  .map((login) => login.trim())
  .filter(Boolean);

const headSha = ghJson(["pr", "view", String(args.prNumber), "--json", "headRefOid", "--jq", ".headRefOid"]);
const checks = ghJson([
  "pr",
  "checks",
  String(args.prNumber),
  "--json",
  "name,state,completedAt",
  "--jq",
  ".",
]);
const reviews = ghApiJson(
  `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
  true,
);
const comments = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/comments`,
  true,
);
const threads = fetchReviewThreads(owner, repo, String(args.prNumber));

const summary = buildActivitySnapshotSummary(
  {
    comments: comments.map(normalizeComment),
    reviews: reviews.map(normalizeReview),
    threads: threads.map(normalizeThread),
    checks,
  },
  { trustedMarkerLogins },
);

process.stdout.write(`${JSON.stringify({
  headSha,
  totalItemCount: summary.totalItemCount,
  maxActivityUpdatedAt: summary.maxActivityUpdatedAt,
  latestCiCompletedAt: summary.latestCiCompletedAt,
  latestPassingCiCompletedAt: summary.latestPassingCiCompletedAt,
  counts: summary.counts,
}, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {
    prNumber: null,
    owner: "",
    repo: "",
    trustedMarkerLogins: "",
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
  node scripts/review-activity-snapshot.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>]
`);
}

function normalizeComment(comment) {
  return {
    author: { login: comment.user?.login ?? "" },
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    updatedAt: comment.updated_at ?? comment.created_at ?? "",
  };
}

function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? "" },
    state: review.state ?? "",
    submittedAt: review.submitted_at ?? "",
    createdAt: review.submitted_at ?? "",
    updatedAt: review.submitted_at ?? "",
  };
}

function normalizeThread(thread) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: thread.updatedAt ?? "",
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

function fetchReviewThreads(owner, repo, prNumber) {
  const nodes = [];
  let cursor = null;

  while (true) {
    const payload = ghApiJson("graphql", false, {
      query: `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  updatedAt
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
      variables: {
        owner,
        repo,
        number: Number.parseInt(prNumber, 10),
        cursor,
      },
    });

    const reviewThreads = payload?.data?.repository?.pullRequest?.reviewThreads;
    nodes.push(...(reviewThreads?.nodes ?? []));
    if (!reviewThreads?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return nodes;
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function ghText(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function ghApiJson(path, paginate = false, fields = null) {
  const args = ["api", path];
  if (paginate) {
    args.push("--paginate");
  }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      args.push("-f", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  const raw = execFileSync("gh", args, { encoding: "utf8" }).trim();
  if (!raw) {
    return [];
  }
  if (paginate) {
    const chunks = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return chunks.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]));
  }
  return JSON.parse(raw);
}
