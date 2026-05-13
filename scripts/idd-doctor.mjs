#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { inspectHelperRuntimeConfig, parseProjectCommandRows } from "./policy-helpers.mjs"

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
  })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHumanReport(report)
  }

  process.exit(report.errors.length > 0 ? 1 : 0)
}

export function runDoctor({ root, requireGithub }) {
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
  checkGithubReadiness(root, requireGithub, report)

  return report
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
  --repo-root <path>   repository root to inspect (default: cwd)
  --json               print JSON report
  --require-github     treat GitHub API check failures as errors
  --help, -h           show this help
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
