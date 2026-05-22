#!/usr/bin/env node

import { execFileSync } from "node:child_process"

import { normalizeTrustedMarkerLogins } from "./protocol-helpers.mjs"

const ALLOWED_CLASSIFIERS = new Set(["OUTDATED", "RESOLVED"])

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  if (!ALLOWED_CLASSIFIERS.has(args.classifier)) {
    console.error(
      `error: --classifier must be one of ${[...ALLOWED_CLASSIFIERS].join(", ")} (got "${args.classifier}")`,
    )
    process.exit(2)
  }

  if (args.subjectIds.length === 0) {
    console.error("error: --subject-ids must contain at least one ID")
    process.exit(2)
  }

  const report = runMinimize({
    subjectIds: args.subjectIds,
    classifier: args.classifier,
    trustedMarkerLogins: args.trustedMarkerLogins,
    apply: args.apply,
  })

  if (args.format === "table") {
    printTable(report)
  } else {
    console.log(JSON.stringify(report, null, 2))
  }

  const exitCode = computeExitCode(report)
  process.exit(exitCode)
}

export function runMinimize({ subjectIds, classifier, trustedMarkerLogins, apply }) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    classifier,
    counts: { eligible: 0, alreadyMinimized: 0, cannotMinimize: 0, untrusted: 0, applied: 0, failed: 0 },
    items: [],
  }

  const trustedSet = buildTrustedSet(trustedMarkerLogins)

  for (const subjectId of subjectIds) {
    const probe = probeSubject(subjectId)
    if (!probe.ok) {
      report.items.push({
        subjectId,
        status: "failed",
        reason: probe.reason,
      })
      report.counts.failed += 1
      continue
    }

    const { author, isMinimized, viewerCanMinimize, url, typename } = probe.node

    if (isMinimized) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "skipped",
        reason: "already-minimized",
      })
      report.counts.alreadyMinimized += 1
      continue
    }

    if (!viewerCanMinimize) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "skipped",
        reason: "viewer-cannot-minimize",
      })
      report.counts.cannotMinimize += 1
      continue
    }

    if (trustedSet.size > 0 && !isTrustedAuthor(author, trustedSet)) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "skipped",
        reason: "untrusted-author",
        author,
      })
      report.counts.untrusted += 1
      continue
    }

    report.counts.eligible += 1

    if (!apply) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "would-apply",
        author,
      })
      continue
    }

    const mutation = applyMinimize(subjectId, classifier)
    if (mutation.ok) {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "applied",
        author,
      })
      report.counts.applied += 1
    } else {
      report.items.push({
        subjectId,
        url,
        typename,
        status: "failed",
        reason: mutation.reason,
      })
      report.counts.failed += 1
    }
  }

  return report
}

function probeSubject(subjectId) {
  const result = runGh(
    [
      "api",
      "graphql",
      "-f",
      `query=query($id:ID!){
        node(id:$id){
          __typename
          ... on IssueComment{id url isMinimized minimizedReason viewerCanMinimize author{login}}
          ... on PullRequestReview{id url isMinimized minimizedReason viewerCanMinimize author{login}}
          ... on PullRequestReviewComment{id url isMinimized minimizedReason viewerCanMinimize author{login}}
        }
      }`,
      "-f",
      `id=${subjectId}`,
    ],
  )
  if (!result.ok) {
    return { ok: false, reason: `gh-graphql-error: ${result.stderr.slice(0, 200)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    return { ok: false, reason: `gh-graphql-parse: ${error.message}` }
  }
  const node = parsed?.data?.node
  if (!node) {
    return { ok: false, reason: "node-missing" }
  }
  return {
    ok: true,
    node: {
      typename: node.__typename,
      url: node.url,
      isMinimized: node.isMinimized,
      viewerCanMinimize: node.viewerCanMinimize,
      author: node.author?.login,
    },
  }
}

function applyMinimize(subjectId, classifier) {
  const result = runGh([
    "api",
    "graphql",
    "-f",
    `query=mutation($id:ID!,$classifier:ReportedContentClassifiers!){
      minimizeComment(input:{subjectId:$id,classifier:$classifier}){
        minimizedComment{
          __typename
          ... on IssueComment{id isMinimized minimizedReason}
          ... on PullRequestReview{id isMinimized minimizedReason}
          ... on PullRequestReviewComment{id isMinimized minimizedReason}
        }
      }
    }`,
    "-f",
    `id=${subjectId}`,
    "-f",
    `classifier=${classifier}`,
  ])
  if (!result.ok) {
    return { ok: false, reason: `mutation-error: ${result.stderr.slice(0, 200)}` }
  }
  return { ok: true }
}

function buildTrustedSet(logins) {
  const list = String(logins ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter((login) => login.length > 0)
  return new Set(normalizeTrustedMarkerLogins(list))
}

export function isTrustedAuthor(author, trustedSet) {
  if (!author) {
    return false
  }
  return trustedSet.has(String(author).toLowerCase())
}

export function computeExitCode(report) {
  if (report.counts.failed > 0) {
    return 1
  }
  return 0
}

function printTable(report) {
  console.log(`mode: ${report.mode}  classifier: ${report.classifier}`)
  const counts = report.counts
  console.log(
    `counts: eligible=${counts.eligible} applied=${counts.applied} failed=${counts.failed} already=${counts.alreadyMinimized} blocked=${counts.cannotMinimize} untrusted=${counts.untrusted}`,
  )
  for (const item of report.items) {
    const url = item.url ?? "(no url)"
    const reason = item.reason ?? ""
    console.log(`  [${item.status}] ${item.subjectId}  ${url}  ${reason}`)
  }
}

function runGh(argv) {
  try {
    const stdout = execFileSync("gh", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout }
  } catch (error) {
    return {
      ok: false,
      stderr: error.stderr?.toString?.() ?? error.message ?? "unknown error",
    }
  }
}

function parseArgs(argv) {
  const args = {
    subjectIds: [],
    classifier: "OUTDATED",
    trustedMarkerLogins: process.env.IDD_TRUSTED_MARKER_ACTORS ?? "",
    apply: false,
    format: "json",
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--apply") {
      args.apply = true
      continue
    }
    if (arg === "--subject-ids") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--subject-ids requires a value")
      }
      args.subjectIds = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
      index += 1
      continue
    }
    if (arg === "--classifier") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--classifier requires a value")
      }
      args.classifier = value
      index += 1
      continue
    }
    if (arg === "--trusted-marker-logins") {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error("--trusted-marker-logins requires a value")
      }
      args.trustedMarkerLogins = value
      index += 1
      continue
    }
    if (arg === "--format") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--format requires a value")
      }
      args.format = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return args
}

function printUsage() {
  console.log(
    `Usage: minimize-superseded-markers --subject-ids <id1,id2,...> [--classifier OUTDATED|RESOLVED] [--trusted-marker-logins login1,login2] [--apply] [--format json|table]`,
  )
}

function isMainModule(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return new URL(metaUrl).pathname === entry || new URL(metaUrl).pathname.endsWith(entry)
  } catch {
    return false
  }
}
