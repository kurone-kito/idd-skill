#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { inspectHelperRuntimeConfig, parseProjectCommandRows } from "./policy-helpers.mjs"

const WORKSHOP_ENTRY_POINTS = ["README.md", "README.ja.md", "docs/index.md"]
const WORKSHOP_REL_PATH = "docs/workshop"
const WORKSHOP_LINK_TARGET_PATTERNS = [
  /(?:^|\/)docs\/workshop(?:\/|$)/,
  /(?:^|\/)workshop(?:\/|$)/,
]
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/

export { parseProjectCommandRows }

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const report = runDoctor({
    root: resolve(args.root),
    requireGithub: args.requireGithub,
    cleanupBacklogWindowDays: args.cleanupBacklogWindowDays,
    cleanupBacklogWarnThreshold: args.cleanupBacklogWarnThreshold,
    workshopCrossRefAllowMissing: args.workshopCrossRefAllowMissing,
  })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHumanReport(report)
  }

  process.exit(report.errors.length > 0 ? 1 : 0)
}

export function runDoctor({
  root,
  requireGithub,
  cleanupBacklogWindowDays,
  cleanupBacklogWarnThreshold,
  workshopCrossRefAllowMissing,
}) {
  const files = listFiles(root)
  const textFiles = files.filter(isTextLikeFile)
  const report = {
    root,
    errors: [],
    warnings: [],
    passes: [],
  }

  checkRequiredFiles(files, report)
  checkPlaceholders(root, textFiles, report)
  const markerPrefix = checkMarkerPrefixes(root, report)
  const projectCommands = checkProjectCommands(root, report)
  checkCommandResidueAndConsistency(root, markerPrefix, projectCommands, report)
  checkPolicySignals(root, report)
  checkHelperRuntimeConfig(root, report)
  checkAgentEntryFiles(root, report)
  checkTemplateVersionSignal(root, report)
  checkPrimaryWorktreeHead(root, report)
  checkPostMergeCleanupBacklog(
    root,
    {
      windowDays: cleanupBacklogWindowDays ?? 14,
      warnThreshold: cleanupBacklogWarnThreshold ?? 2,
      requireGithub,
    },
    report,
  )
  checkWorkshopCrossReferences(
    root,
    { allowMissing: workshopCrossRefAllowMissing ?? [] },
    report,
  )
  checkWorkshopExampleRepoBackLink(root, { requireGithub }, report)
  checkGithubReadiness(root, requireGithub, report)

  return report
}

export function parsePrimaryWorktreePath(porcelain) {
  const lines = porcelain.split("\n")
  for (const line of lines) {
    const match = line.match(/^worktree (.+)$/)
    if (match) {
      return match[1]
    }
  }
  return null
}

export function classifyPrimaryHead(branch) {
  if (typeof branch !== "string" || branch.length === 0) {
    return { isB1Violation: false, kind: "unknown" }
  }
  if (branch.startsWith("issue/")) {
    return { isB1Violation: true, kind: "issue" }
  }
  if (branch.startsWith("roadmap-audit/")) {
    return { isB1Violation: true, kind: "roadmap-audit" }
  }
  return { isB1Violation: false, kind: "other" }
}

export function findPlaceholders(text) {
  return [...text.matchAll(/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/g)].map((match) => match[0])
}

export function extractMarkerPrefixes(text) {
  const roadmap = [...text.matchAll(/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-roadmap-id/g)].map(
    (match) => match[1],
  )
  const blockedBy = [...text.matchAll(/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-blocked-by/g)].map(
    (match) => match[1],
  )
  return {
    roadmap: unique(roadmap),
    blockedBy: unique(blockedBy),
  }
}

function checkRequiredFiles(files, report) {
  const required = [
    ".github/instructions/idd-overview.instructions.md",
    ".github/instructions/idd-discover.instructions.md",
    ".github/instructions/idd-suitability.instructions.md",
    ".github/instructions/idd-claim.instructions.md",
    ".github/instructions/idd-work.instructions.md",
    ".github/instructions/idd-pr-submit.instructions.md",
    ".github/instructions/idd-ci.instructions.md",
    ".github/instructions/idd-review-snapshot.instructions.md",
    ".github/instructions/idd-review-triage.instructions.md",
    ".github/instructions/idd-review-fix.instructions.md",
    ".github/instructions/idd-pre-merge.instructions.md",
    ".github/instructions/idd-merge-handoff.instructions.md",
    ".github/instructions/idd-merge.instructions.md",
    ".github/instructions/idd-resume.instructions.md",
    ".github/instructions/idd-resume-stall.instructions.md",
    ".github/instructions/idd-advisory-wait.instructions.md",
    "docs/getting-started.md",
    "docs/concepts.md",
    "docs/customization.md",
    "docs/reference.md",
    "docs/idd-workflow.md",
    "docs/idd-review-policy-profiles.md",
    "docs/idd-helper-scripts.md",
    "docs/idd-comment-minimization.md",
    "docs/permissions.md",
    "docs/policy-constants.md",
  ]

  const profileFiles = [
    "profiles/README.md",
    "profiles/human-required/README.md",
    "profiles/no-advisory/README.md",
    "profiles/external-bot/README.md",
  ]

  const missingRequired = required.filter((file) => !exists(join(report.root, file)))
  const missingProfiles = profileFiles.filter((file) => !exists(join(report.root, file)))

  if (missingRequired.length > 0) {
    report.errors.push(`missing required IDD files: ${missingRequired.join(", ")}`)
  } else {
    report.passes.push("required instruction and reference files are present")
  }

  if (missingProfiles.length > 0) {
    report.warnings.push(
      `missing non-default profile files (expected for adopters): ${missingProfiles.join(", ")}`,
    )
  } else {
    report.passes.push("profile artifacts are present")
  }
}

function checkPlaceholders(root, files, report) {
  const distributionSource = exists(join(root, "idd-template/ONBOARDING.md")) && exists(join(root, "audit/sync-manifest.json"))
  const excludedPrefixes = [
    "idd-template/",
    "fixtures/",
    "tests/fixtures/",
    "tests/",
    ".git/",
  ]
  if (distributionSource) {
    excludedPrefixes.push(".github/instructions/", "audit/")
  }
  const hits = []

  for (const file of files) {
    if (excludedPrefixes.some((prefix) => file.startsWith(prefix))) {
      continue
    }
    const absolutePath = join(root, file)
    let text = ""
    try {
      text = readFileSync(absolutePath, "utf8")
    } catch {
      continue
    }
    const placeholders = findPlaceholders(text)
    if (placeholders.length === 0) {
      continue
    }
    hits.push(`${file}: ${unique(placeholders).join(", ")}`)
  }

  if (hits.length > 0) {
    report.errors.push(`unresolved placeholders found: ${hits.slice(0, 10).join(" | ")}`)
    return
  }
  report.passes.push("no unresolved {{...}} placeholders in IDD-managed files")
}

function checkMarkerPrefixes(root, report) {
  const discoverPath = join(root, ".github/instructions/idd-discover.instructions.md")
  const overviewPath = join(root, ".github/instructions/idd-overview.instructions.md")
  let discover = ""
  let overview = ""
  try {
    discover = readFileSync(discoverPath, "utf8")
    overview = readFileSync(overviewPath, "utf8")
  } catch {
    report.warnings.push("marker-prefix checks skipped because discover/overview files are missing")
    return null
  }

  const discoverPrefixes = extractMarkerPrefixes(discover)
  const overviewPrefixes = extractMarkerPrefixes(overview)
  const allPrefixes = unique([
    ...discoverPrefixes.roadmap,
    ...discoverPrefixes.blockedBy,
    ...overviewPrefixes.roadmap,
    ...overviewPrefixes.blockedBy,
  ])

  if (allPrefixes.length === 0) {
    report.warnings.push("marker-prefix checks skipped because no resolved marker prefixes were found")
    return null
  }

  const invalid = allPrefixes.filter((prefix) => !/^[a-z][a-z0-9-]{1,31}$/.test(prefix))
  if (invalid.length > 0) {
    report.errors.push(`invalid marker prefixes: ${invalid.join(", ")}`)
    return null
  }

  if (!sameMembers(discoverPrefixes.roadmap, discoverPrefixes.blockedBy)) {
    report.errors.push("discover marker prefixes differ between roadmap-id and blocked-by")
    return null
  }
  if (!sameMembers(overviewPrefixes.roadmap, overviewPrefixes.blockedBy)) {
    report.errors.push("overview marker prefixes differ between roadmap-id and blocked-by")
    return null
  }
  if (
    !sameMembers(discoverPrefixes.roadmap, overviewPrefixes.roadmap) ||
    !sameMembers(discoverPrefixes.blockedBy, overviewPrefixes.blockedBy)
  ) {
    report.errors.push("marker prefixes differ between discover and overview instructions")
    return null
  }

  report.passes.push(`marker prefix is valid and consistent (${allPrefixes[0]})`)
  return allPrefixes[0]
}

function checkProjectCommands(root, report) {
  const path = join(root, ".github/instructions/idd-overview.instructions.md")
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    report.errors.push("cannot read .github/instructions/idd-overview.instructions.md")
    return null
  }

  const commands = parseProjectCommandRows(text)
  const requiredRows = ["fix-validate", "pre-push-validate", "post-fix-validate", "install-deps"]
  const missingRows = requiredRows.filter((row) => !commands.has(row))
  if (missingRows.length > 0) {
    report.errors.push(`project commands table is missing rows: ${missingRows.join(", ")}`)
    return null
  }

  const noOps = requiredRows.filter((row) => commands.get(row) === "true")
  if (noOps.length === requiredRows.length) {
    report.warnings.push("all primary command rows are set to `true` (no-op substitutions)")
  } else {
    report.passes.push("project commands table has non-empty command values")
  }
  return commands
}

function checkCommandResidueAndConsistency(root, markerPrefix, projectCommands, report) {
  if (!(projectCommands instanceof Map)) {
    return
  }

  const policyCommands = loadPolicyCommands(root)
  const policyCommandMap = policyCommands instanceof Map ? policyCommands : new Map()

  const sharedKeys = unique([...policyCommandMap.keys()].filter((key) => projectCommands.has(key))).sort()
  for (const key of sharedKeys) {
    const configValue = normalizeCommandValue(policyCommandMap.get(key))
    const overviewValue = normalizeCommandValue(projectCommands.get(key))
    if (!isConcreteCommandValue(configValue) || !isConcreteCommandValue(overviewValue)) {
      continue
    }
    if (configValue !== overviewValue) {
      report.warnings.push(
        `command mismatch between .github/idd/config.json and overview table for "${key}": config="${configValue}" overview="${overviewValue}"`,
      )
    }
  }

  if (typeof markerPrefix !== "string" || markerPrefix.length === 0) {
    report.warnings.push("toolchain residue checks skipped because marker prefix could not be resolved")
    return
  }
  if (markerPrefix === "idd-skill") {
    return
  }

  const residueMessages = new Set()
  for (const [source, commands] of [
    [".github/idd/config.json", policyCommandMap],
    ["overview project commands table", projectCommands],
  ]) {
    for (const [key, value] of commands.entries()) {
      const normalized = normalizeCommandValue(value)
      if (normalized === null) {
        continue
      }
      const token = findToolchainResidueToken(normalized)
      if (!token) {
        continue
      }
      residueMessages.add(
        `toolchain residue detected for marker prefix "${markerPrefix}": ${source} "${key}" contains "${token}"`,
      )
    }
  }
  for (const message of residueMessages) {
    report.warnings.push(message)
  }
}

function loadPolicyCommands(root) {
  const configPath = join(root, ".github/idd/config.json")
  if (!exists(configPath)) {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"))
  } catch {
    return null
  }
  const commands = parsed?.commands
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return null
  }

  return new Map(Object.entries(commands).filter(([, value]) => typeof value === "string"))
}

function normalizeCommandValue(value) {
  if (typeof value !== "string") {
    return null
  }
  return value.trim()
}

function isConcreteCommandValue(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false
  }
  if (value.toLowerCase() === "true") {
    return false
  }
  return !/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/.test(value)
}

function findToolchainResidueToken(value) {
  for (const token of ["dprint", "markdownlint-cli2", "cspell"]) {
    if (new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(value)) {
      return token
    }
  }
  return null
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function checkPolicySignals(root, report) {
  const files = [
    "README.md",
    "README.ja.md",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
    "docs/idd-policy.md",
    ".github/idd/config.json",
    "idd-policy.json",
  ]
  const existing = files.filter((file) => exists(join(root, file)))
  const corpus = existing.map((file) => readFileSync(join(root, file), "utf8")).join("\n")

  const mergePolicies = ["fully_autonomous_merge", "human_merge", "separate_merge_agent"]
  if (!mergePolicies.some((policy) => corpus.includes(policy))) {
    report.errors.push("merge policy signal not found in docs or entry files")
  } else {
    report.passes.push("merge policy signal found")
  }

  const reviewPolicySignals = [
    "copilot advisory",
    "no-advisory",
    "human-required",
    "external-bot",
    "strict-reviewer-resolve",
  ]
  if (!reviewPolicySignals.some((signal) => corpus.toLowerCase().includes(signal))) {
    report.warnings.push("review policy signal not found in docs or entry files")
  } else {
    report.passes.push("review policy signal found")
  }
}

function checkHelperRuntimeConfig(root, report) {
  const candidates = [
    ".github/idd/config.json",
    "idd-policy.json",
  ]

  for (const file of candidates) {
    const absolutePath = join(root, file)
    if (!exists(absolutePath)) {
      continue
    }

    let config
    try {
      config = JSON.parse(readFileSync(absolutePath, "utf8"))
    } catch {
      report.errors.push(`${file} is not valid JSON`)
      continue
    }

    const helperRuntime = inspectHelperRuntimeConfig(config)
    if (helperRuntime.status === "absent") {
      report.passes.push(`${file} leaves helperRuntime unset (instructions-only fallback)`)
      continue
    }
    if (helperRuntime.status === "invalid") {
      report.errors.push(`${file}: ${helperRuntime.reason}`)
      continue
    }
    report.passes.push(`${file} declares helper runtime profile "${helperRuntime.profile}"`)
  }
}

function checkAgentEntryFiles(root, report) {
  for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const absolutePath = join(root, file)
    if (!exists(absolutePath)) {
      report.warnings.push(`${file} is missing (allowed only if operator opted out)`)
      continue
    }
    const text = readFileSync(absolutePath, "utf8")
    if (!text.includes("docs/idd-workflow.md")) {
      report.errors.push(`${file} exists but does not reference docs/idd-workflow.md`)
      continue
    }
    report.passes.push(`${file} references docs/idd-workflow.md`)
  }
}

function checkTemplateVersionSignal(root, report) {
  const candidates = [
    ".github/idd/config.json",
    "idd-policy.json",
    "docs/idd-policy.md",
    "README.md",
  ]
  for (const file of candidates) {
    const absolutePath = join(root, file)
    if (!exists(absolutePath)) {
      continue
    }
    const text = readFileSync(absolutePath, "utf8")
    if (!/\biddVersion\b/i.test(text) && !/template version/i.test(text)) {
      continue
    }
    report.passes.push(`template version signal found in ${file}`)
    return
  }
  report.warnings.push("template version signal not found (iddVersion/template version)")
}

function checkPrimaryWorktreeHead(root, report) {
  const listResult = runCommand("git", ["worktree", "list", "--porcelain"], root)
  if (!listResult.ok) {
    return
  }

  const primaryPath = parsePrimaryWorktreePath(listResult.stdout)
  if (!primaryPath) {
    return
  }

  const headResult = runCommand("git", ["-C", primaryPath, "rev-parse", "--abbrev-ref", "HEAD"], root)
  if (!headResult.ok) {
    return
  }

  const branch = headResult.stdout.trim()
  const classification = classifyPrimaryHead(branch)
  if (!classification.isB1Violation) {
    return
  }

  const kindLabel =
    classification.kind === "issue"
      ? "an issue branch"
      : "a roadmap-audit branch"
  report.warnings.push(
    `primary worktree HEAD is on ${kindLabel} (${branch}) at ${primaryPath} — likely a past B1 violation. See B1 in .github/instructions/idd-work.instructions.md.`,
  )
}

export function computeWindowStartIso(now, windowDays) {
  const ms = Number(windowDays) * 24 * 60 * 60 * 1000
  if (!Number.isFinite(ms) || ms <= 0) {
    return null
  }
  const candidate = Number(now) - ms
  if (!Number.isFinite(candidate)) {
    return null
  }
  const date = new Date(candidate)
  // JavaScript `Date` accepts the full IEEE 754 range, but `toISOString`
  // throws RangeError for any `Date` outside ±100,000,000 days of the
  // epoch (≈ year ±271,821). Detect that here so a too-large
  // `--cleanup-backlog-window-days` value never crashes the caller.
  if (Number.isNaN(date.getTime())) {
    return null
  }
  try {
    return date.toISOString()
  } catch {
    return null
  }
}

export function classifyBacklog(missingPrNumbers, warnThreshold) {
  const count = Array.isArray(missingPrNumbers) ? missingPrNumbers.length : 0
  const thresholdNumber = Number(warnThreshold)
  const safeThreshold = Number.isFinite(thresholdNumber) && thresholdNumber >= 0
    ? thresholdNumber
    : 0
  return {
    count,
    warn: count > safeThreshold,
    examples: Array.isArray(missingPrNumbers) ? missingPrNumbers.slice(0, 5) : [],
  }
}

function checkPostMergeCleanupBacklog(root, options, report) {
  const windowDays = options.windowDays
  const warnThreshold = options.warnThreshold
  const requireGithub = options.requireGithub === true

  // Soft GitHub-API failures (gh missing, no token, repo view fails,
  // pr list fails) are silent by default — same pattern as the other
  // doctor GitHub-readiness checks — and only surface as errors when
  // the operator passed --require-github. Per-PR evidence-fetch
  // failures are still always reported because they materially change
  // the backlog count.
  const recordGhFailure = (message) => {
    if (requireGithub) {
      report.errors.push(`post-merge cleanup backlog check: ${message}`)
    }
  }

  const repoView = runCommand("gh", ["repo", "view", "--json", "owner,name"], root)
  if (!repoView.ok) {
    recordGhFailure("gh repo view unavailable")
    return
  }
  let parsed
  try {
    parsed = JSON.parse(repoView.stdout)
  } catch {
    recordGhFailure("gh repo view output is not valid JSON")
    return
  }
  const owner = parsed.owner?.login
  const repo = parsed.name
  if (!owner || !repo) {
    recordGhFailure("gh repo view did not return owner/name")
    return
  }

  const sinceIso = computeWindowStartIso(Date.now(), windowDays)
  if (!sinceIso) {
    report.warnings.push(
      `post-merge cleanup backlog check skipped: --cleanup-backlog-window-days value ${windowDays} produced an out-of-range Date and cannot be used as a search window. Re-run with a smaller positive value (default: 14).`,
    )
    return
  }

  const search = runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "merged",
      "--search",
      `merged:>=${sinceIso}`,
      "--json",
      "number",
      "--limit",
      "1000",
    ],
    root,
  )
  if (!search.ok) {
    recordGhFailure(`merged-PR list query failed for ${owner}/${repo}`)
    return
  }
  let mergedPrs
  try {
    mergedPrs = JSON.parse(search.stdout)
  } catch {
    recordGhFailure(`merged-PR list query for ${owner}/${repo} returned invalid JSON`)
    return
  }
  if (!Array.isArray(mergedPrs) || mergedPrs.length === 0) {
    return
  }

  const missing = []
  const evidenceFailures = []
  for (const pr of mergedPrs) {
    const number = pr?.number
    if (!Number.isInteger(number)) {
      continue
    }
    const evidence = runCommand(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "--jq",
        '.[] | select(.body | startswith("<!-- idd-cleanup-evidence:")) | .id',
      ],
      root,
    )
    if (!evidence.ok) {
      evidenceFailures.push(number)
      continue
    }
    const matchLines = String(evidence.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (matchLines.length === 0) {
      missing.push(number)
    }
  }

  if (evidenceFailures.length > 0) {
    const evidenceMessage =
      `post-merge cleanup evidence query failed for ${evidenceFailures.length} merged PR(s) ` +
      `(examples: ${evidenceFailures.slice(0, 5).map((n) => `#${n}`).join(", ")}). ` +
      `Backlog count below may be undercounted.`
    if (requireGithub) {
      report.errors.push(evidenceMessage)
    } else {
      report.warnings.push(evidenceMessage)
    }
  }

  const verdict = classifyBacklog(missing, warnThreshold)
  if (!verdict.warn) {
    return
  }

  const examplesText = verdict.examples.map((n) => `#${n}`).join(", ")
  report.warnings.push(
    `post-merge cleanup backlog: ${verdict.count} merged PRs in the last ${windowDays} days lack F4 cleanup evidence (warn threshold: ${warnThreshold}). Examples: ${examplesText}. Remediation: see docs/idd-comment-minimization.md or run \`node scripts/audit-pr-cleanup.mjs --pr <N> --apply --skip-claim-check\`.`,
  )
}

export function findMissingWorkshopReferences(entryFiles, allowMissing) {
  const allowSet = new Set(
    (Array.isArray(allowMissing) ? allowMissing : []).map((path) => String(path)),
  )
  const missing = []
  for (const entry of entryFiles) {
    if (allowSet.has(entry.path)) {
      continue
    }
    if (entry.content === null) {
      missing.push(entry.path)
      continue
    }
    if (typeof entry.content !== "string") {
      continue
    }
    if (!containsWorkshopReference(entry.content)) {
      missing.push(entry.path)
    }
  }
  return missing
}

export function containsWorkshopReference(content) {
  if (typeof content !== "string" || content.length === 0) {
    return false
  }
  // Strip fenced code blocks (``` and ~~~) before scanning so demo
  // Markdown inside code samples does not count as a real link.
  const stripped = stripFencedCodeBlocks(content)
  // Accept any double-quoted, single-quoted, or no-title destination
  // form per CommonMark inline-link grammar.
  const linkPattern = /\[[^\]\n]*\]\(\s*([^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
  let match
  while ((match = linkPattern.exec(stripped)) !== null) {
    const target = match[1]
    if (!target) continue
    if (matchesWorkshopPath(target)) {
      return true
    }
  }
  return false
}

function stripFencedCodeBlocks(content) {
  const lines = String(content).split(/\r?\n/)
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    out.push(line)
  }
  return out.join("\n")
}

function matchesWorkshopPath(target) {
  const cleaned = String(target).replace(/^\.\/+/, "").replace(/^\/+/, "")
  for (const pattern of WORKSHOP_LINK_TARGET_PATTERNS) {
    if (pattern.test(`/${cleaned}`)) {
      return true
    }
  }
  return false
}

// Verifies that the workshop publication is discoverable from every
// known entry point (README.md, README.ja.md, docs/index.md).
// Skipped silently when docs/workshop/ does not exist (adopter repos
// that never published a workshop should not see noise). The example
// repository's back-link is intentionally out of scope here because
// verifying it requires fetching a remote repository's README; that
// is a separate concern under the helper-runtime profile work.
function checkWorkshopCrossReferences(root, options, report) {
  const allowMissing = options.allowMissing ?? []
  const workshopDir = resolve(root, WORKSHOP_REL_PATH)
  if (!existsSync(workshopDir)) {
    return
  }
  const entryFiles = WORKSHOP_ENTRY_POINTS.map((relPath) => {
    const abs = resolve(root, relPath)
    if (!existsSync(abs)) {
      return { path: relPath, content: null }
    }
    try {
      return { path: relPath, content: readFileSync(abs, "utf8") }
    } catch {
      return { path: relPath, content: null }
    }
  })
  const missing = findMissingWorkshopReferences(entryFiles, allowMissing)
  for (const path of missing) {
    report.warnings.push(
      `workshop cross-reference missing in ${path}: expected a Markdown link whose target starts with ${WORKSHOP_REL_PATH}/. See acceptance criteria on issue #611 (CP-E).`,
    )
  }
}

// Verifies that the example repository's README links back to this
// repository's workshop directory — the last scriptable item in the
// CP-E (#611) checklist. Reads the example-repo coordinates from
// `.github/idd/config.json` `workshop.exampleRepository`
// (`<owner>/<repo>` shape). Skipped silently when:
//   - the local docs/workshop/ does not exist (adopter never
//     published a workshop);
//   - workshop.exampleRepository is unset / empty;
//   - the gh fetch fails (no network, no token, no permissions) —
//     escalates to errors under --require-github.
export function backLinkPatternFor(repoSlug) {
  // Match a link target that contains the slug followed by a path
  // boundary (`/`, `?`, `#`, or end of token) and a later
  // `docs/workshop` path segment. The boundary prevents
  // `<slug>-fork/.../docs/workshop` from satisfying `<slug>/...`.
  const escSlug = String(repoSlug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${escSlug}(?:[/?#][^\\s)]*?)?docs/workshop`, "i")
}

export function stripMarkdownNonText(content) {
  if (typeof content !== "string") return ""
  let s = content
  // Strip HTML comments (single- or multi-line) first so their
  // interior is not parsed as Markdown later. Loop to a fixed
  // point so nested payloads like `<!--<!-- x --> -->` fully
  // collapse rather than leaving `<!--` fragments after a single
  // pass — satisfies CodeQL's incomplete-multi-character
  // sanitization rule.
  let prev
  do {
    prev = s
    s = s.replace(/<!--[\s\S]*?-->/g, "")
  } while (s !== prev)
  // Strip fenced code blocks (``` or ~~~), including unterminated
  // ones that run to EOF. The non-greedy `(?:[\s\S]*?\1|[\s\S]*$)`
  // accepts either a matching closing fence or end-of-content.
  s = s.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(\n\2\3[ \t]*(?=\n|$)|$)/g, "$1")
  // Strip indented code blocks: lines starting with 4+ spaces or a
  // tab, surrounded by blank lines (CommonMark §4.4). Conservative
  // approximation: any sequence of indented lines.
  s = s
    .split(/\n/)
    .map((line) => (/^(?: {4}|\t)/.test(line) ? "" : line))
    .join("\n")
  // Strip inline code spans (single or multi-backtick).
  s = s.replace(/(`+)((?:(?!\1)[\s\S])+?)\1/g, "")
  return s
}

export function containsExampleRepoBackLink(readmeContent, repoSlug) {
  if (typeof readmeContent !== "string" || readmeContent.length === 0) {
    return false
  }
  // Scan URL-shaped tokens after stripping code samples and HTML
  // comments so demo URLs and commented-out URLs do not count as
  // back-links. URL scanning (vs strict Markdown link parsing)
  // covers inline `[](url)`, badge wrappers, reference definitions,
  // autolinks `<url>`, and raw URL mentions in a single pass.
  const pattern = backLinkPatternFor(repoSlug)
  const stripped = stripMarkdownNonText(readmeContent)
  const urlPattern = /https?:\/\/[^\s<>)\]"']+/gi
  let match
  while ((match = urlPattern.exec(stripped)) !== null) {
    if (pattern.test(match[0])) return true
  }
  return false
}

export function decodeGithubReadmeBase64(content) {
  if (typeof content !== "string") return null
  const compact = content.replace(/\s+/g, "")
  if (compact.length === 0) return null
  if (!BASE64_PATTERN.test(content)) return null
  let decoded
  try {
    decoded = Buffer.from(compact, "base64").toString("utf8")
  } catch {
    return null
  }
  if (typeof decoded !== "string" || decoded.length === 0) return null
  return decoded
}

function checkWorkshopExampleRepoBackLink(root, options, report) {
  const requireGithub = options.requireGithub === true
  const workshopDir = resolve(root, WORKSHOP_REL_PATH)
  if (!existsSync(workshopDir)) return

  const configPath = resolve(root, ".github/idd/config.json")
  if (!existsSync(configPath)) return
  let config
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"))
  } catch {
    return
  }
  const exampleRepo = config?.workshop?.exampleRepository
  if (typeof exampleRepo !== "string" || exampleRepo.trim().length === 0) {
    return
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(exampleRepo)) {
    report.warnings.push(
      `workshop example-repo check skipped: invalid workshop.exampleRepository value "${exampleRepo}" — expected "<owner>/<repo>".`,
    )
    return
  }

  const recordSoftFailure = (message) => {
    if (requireGithub) {
      report.errors.push(`workshop example-repo back-link check: ${message}`)
    }
  }

  // Resolve this repo's slug from gh repo view so the back-link
  // pattern matches the correct owner / name even when the
  // configured GitHub origin differs from local assumptions.
  const repoView = runCommand("gh", ["repo", "view", "--json", "owner,name"], root)
  if (!repoView.ok) {
    recordSoftFailure(`gh repo view unavailable`)
    return
  }
  let viewer
  try {
    viewer = JSON.parse(repoView.stdout)
  } catch {
    recordSoftFailure(`gh repo view output is not valid JSON`)
    return
  }
  const owner = viewer.owner?.login
  const name = viewer.name
  if (!owner || !name) {
    recordSoftFailure(`gh repo view did not return owner / name`)
    return
  }
  const repoSlug = `${owner}/${name}`

  // `repos/<owner>/<repo>/readme` returns whatever GitHub considers
  // the canonical README (README.md, README.rst, README, case
  // variants), so the check works for repos that do not name their
  // README exactly `README.md`.
  const readmeFetch = runCommand(
    "gh",
    [
      "api",
      `repos/${exampleRepo}/readme`,
      "--jq",
      ".content",
    ],
    root,
  )
  if (!readmeFetch.ok) {
    recordSoftFailure(`could not fetch ${exampleRepo}/readme`)
    return
  }
  const decoded = decodeGithubReadmeBase64(readmeFetch.stdout)
  if (!decoded) {
    recordSoftFailure(`${exampleRepo}/readme content was empty or not valid base64`)
    return
  }

  if (!containsExampleRepoBackLink(decoded, repoSlug)) {
    report.warnings.push(
      `workshop example-repo back-link missing: ${exampleRepo}/README.md does not contain a Markdown link whose target matches ${repoSlug}/.../docs/workshop. See acceptance criteria on issue #611 (CP-E).`,
    )
  }
}

function checkGithubReadiness(root, requireGithub, report) {
  const repoView = runCommand("gh", ["repo", "view", "--json", "owner,name,defaultBranchRef"], root)
  if (!repoView.ok) {
    const message = "github checks skipped: gh repo view unavailable"
    if (requireGithub) {
      report.errors.push(message)
    } else {
      report.warnings.push(message)
    }
    return
  }

  let parsed
  try {
    parsed = JSON.parse(repoView.stdout)
  } catch {
    const message = "github checks skipped: failed to parse gh repo view output"
    if (requireGithub) {
      report.errors.push(message)
    } else {
      report.warnings.push(message)
    }
    return
  }

  const owner = parsed.owner?.login
  const repo = parsed.name
  const branch = parsed.defaultBranchRef?.name
  if (!owner || !repo || !branch) {
    const message = "github checks skipped: repository owner/name/default branch is incomplete"
    if (requireGithub) {
      report.errors.push(message)
    } else {
      report.warnings.push(message)
    }
    return
  }

  const protection = runCommand(
    "gh",
    ["api", `repos/${owner}/${repo}/branches/${branch}/protection`],
    root,
  )
  if (!protection.ok) {
    const message = `branch protection not readable for ${owner}/${repo}:${branch}`
    if (requireGithub) {
      report.errors.push(message)
    } else {
      report.warnings.push(message)
    }
    return
  }

  let protectionJson
  try {
    protectionJson = JSON.parse(protection.stdout)
  } catch {
    const message = "branch protection response is not valid JSON"
    if (requireGithub) {
      report.errors.push(message)
    } else {
      report.warnings.push(message)
    }
    return
  }

  const requiredChecks = protectionJson.required_status_checks?.contexts ?? []
  const strict = protectionJson.required_status_checks?.strict ?? false
  if (requiredChecks.length === 0) {
    report.warnings.push(`branch protection is enabled but no required status checks are configured on ${branch}`)
  } else {
    report.passes.push(`required status checks configured on ${branch} (${requiredChecks.length}, strict=${strict})`)
  }

  const reviewConfig = protectionJson.required_pull_request_reviews
  if (!reviewConfig) {
    report.warnings.push(`required pull request reviews are not configured on ${branch}`)
  } else {
    report.passes.push("required pull request review policy is configured")
  }
}

function runCommand(command, argv, cwd) {
  try {
    const stdout = execFileSync(command, argv, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout }
  } catch (error) {
    return {
      ok: false,
      code: error.status,
      stderr: error.stderr?.toString?.() ?? "",
    }
  }
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    json: false,
    help: false,
    requireGithub: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") {
      args.json = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--require-github") {
      args.requireGithub = true
      continue
    }
    if (arg === "--repo-root") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--repo-root requires a value")
      }
      args.root = value
      index += 1
      continue
    }
    if (arg === "--cleanup-backlog-window-days") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--cleanup-backlog-window-days requires a value")
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error(
          `--cleanup-backlog-window-days must be a positive finite number (got "${value}")`,
        )
      }
      args.cleanupBacklogWindowDays = numeric
      index += 1
      continue
    }
    if (arg === "--cleanup-backlog-warn-threshold") {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error("--cleanup-backlog-warn-threshold requires a value")
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error(
          `--cleanup-backlog-warn-threshold must be a non-negative finite number (got "${value}")`,
        )
      }
      args.cleanupBacklogWarnThreshold = numeric
      index += 1
      continue
    }
    if (arg === "--workshop-cross-ref-allow-missing") {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error("--workshop-cross-ref-allow-missing requires a value")
      }
      args.workshopCrossRefAllowMissing = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return args
}

function printHumanReport(report) {
  console.log(`IDD doctor report (${report.root})`)
  for (const pass of report.passes) {
    console.log(`PASS  ${pass}`)
  }
  for (const warning of report.warnings) {
    console.log(`WARN  ${warning}`)
  }
  for (const error of report.errors) {
    console.log(`ERROR ${error}`)
  }
  if (report.errors.length > 0) {
    console.log(`\nresult: failed (${report.errors.length} error(s), ${report.warnings.length} warning(s))`)
    return
  }
  console.log(`\nresult: passed (${report.warnings.length} warning(s))`)
}

function printUsage() {
  console.log(`usage: node scripts/idd-doctor.mjs [options]

options:
  --repo-root <path>                       repository root to inspect (default: cwd)
  --json                                   print JSON report
  --require-github                         treat GitHub API check failures as errors
  --cleanup-backlog-window-days <N>        merged-PR window for the cleanup backlog check (default: 14)
  --cleanup-backlog-warn-threshold <N>     backlog count above which the check warns (default: 2)
  --workshop-cross-ref-allow-missing <list> comma-separated entry-point paths to skip in the workshop cross-reference check (default: none)
  --help, -h                               show this help

The merged-PR backlog scan caps at gh's per-query maximum of 1000
results; repositories with > 1000 merged PRs in the window get a
representative sample. The check makes one gh api .../comments
call per merged PR returned, which is intentionally simple — for
very large or rate-limited repos consider raising the warn
threshold or shortening the window.
`)
}

function listFiles(root) {
  const gitList = runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard"], root)
  if (gitList.ok) {
    return gitList.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()
  }
  return walk(root).map((absolutePath) => relative(root, absolutePath)).sort()
}

function walk(directory) {
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue
    }
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      entries.push(...walk(absolutePath))
      continue
    }
    if (entry.isFile()) {
      entries.push(absolutePath)
    }
  }
  return entries
}

function exists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isTextLikeFile(file) {
  return /\.(md|txt|yml|yaml|json|mjs|js|ts|sh)$/.test(file)
}

function unique(values) {
  return [...new Set(values)]
}

function sameMembers(left, right) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== rightSet.size) {
    return false
  }
  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      return false
    }
  }
  return true
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) {
    return false
  }
  return fileURLToPath(moduleUrl) === resolve(process.argv[1])
}
