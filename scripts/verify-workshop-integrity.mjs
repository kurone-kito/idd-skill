#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, normalize, relative, resolve } from "node:path"

const WORKSHOP_ROOTS = ["docs/workshop"]

if (isMainModule(import.meta.url)) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error.message}`)
    process.exit(2)
  }
  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const repoRoot = resolve(args.root)
  const report = runVerification(repoRoot, args)

  if (args.format === "table") {
    printTable(report)
  } else {
    console.log(JSON.stringify(report, null, 2))
  }
  process.exit(computeExitCode(report))
}

export function runVerification(repoRoot, options = {}) {
  const workshopRoots = options.workshopRoots ?? WORKSHOP_ROOTS
  const files = []
  for (const root of workshopRoots) {
    const abs = resolve(repoRoot, root)
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      collectMarkdown(abs, files)
    }
  }

  const headingIndex = new Map()
  for (const file of files) {
    headingIndex.set(file, extractHeadingSlugs(readFileSync(file, "utf8")))
  }

  const report = {
    scanned: files.length,
    issues: [],
    counts: {
      checkedLinks: 0,
      checkedImages: 0,
      missingFile: 0,
      missingAnchor: 0,
      invalidUrl: 0,
    },
  }

  for (const file of files) {
    const content = readFileSync(file, "utf8")
    const refs = extractReferences(content)
    for (const ref of refs) {
      if (ref.kind === "image") {
        report.counts.checkedImages += 1
      } else {
        report.counts.checkedLinks += 1
      }
      const result = classifyAndCheck(ref.target, file, repoRoot, headingIndex)
      if (result.status === "ok") {
        continue
      }
      if (result.status === "missing-file") {
        report.counts.missingFile += 1
      } else if (result.status === "missing-anchor") {
        report.counts.missingAnchor += 1
      } else if (result.status === "invalid-url") {
        report.counts.invalidUrl += 1
      }
      report.issues.push({
        file: relative(repoRoot, file),
        kind: ref.kind,
        target: ref.target,
        line: ref.line,
        status: result.status,
        detail: result.detail,
      })
    }
  }
  return report
}

export function extractReferences(markdown) {
  const refs = []
  const linkPattern = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  const lines = markdown.split(/\r?\n/)
  let lineStart = 0
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    let match
    const localPattern = new RegExp(linkPattern.source, "g")
    while ((match = localPattern.exec(line)) !== null) {
      const isImage = match[1] === "!"
      const target = match[3]
      refs.push({
        kind: isImage ? "image" : "link",
        target,
        line: lineNumber + 1,
      })
    }
    lineStart += line.length + 1
  }
  return refs
}

export function extractHeadingSlugs(markdown) {
  const slugs = new Set()
  const lines = markdown.split(/\r?\n/)
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!match) continue
    const slug = slugifyHeading(match[2])
    if (slug) {
      slugs.add(slug)
    }
  }
  return slugs
}

// GitHub heading slug algorithm (simplified): strip HTML, drop most
// punctuation, lowercase, replace spaces with hyphens, keep Unicode
// letters/digits, underscore, and hyphen. See
// https://gist.github.com/asabaylus/3071099 for the reference.
export function slugifyHeading(text) {
  if (!text) return ""
  let s = String(text)
  s = s.replace(/<[^>]+>/g, "")
  s = s.replace(/`([^`]*)`/g, "$1")
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  s = s.toLowerCase()
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, "")
  s = s.replace(/\s+/g, "-")
  s = s.replace(/^-+|-+$/g, "")
  return s
}

export function classifyAndCheck(target, fromFile, repoRoot, headingIndex) {
  const trimmed = String(target).trim()
  if (trimmed.length === 0) {
    return { status: "missing-file", detail: "empty target" }
  }
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) {
    return { status: "ok" }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed)
      return { status: "ok" }
    } catch (error) {
      return { status: "invalid-url", detail: error.message }
    }
  }
  if (trimmed.startsWith("//")) {
    try {
      new URL(`https:${trimmed}`)
      return { status: "ok" }
    } catch (error) {
      return { status: "invalid-url", detail: error.message }
    }
  }

  let pathPart = trimmed
  let anchorPart = ""
  const hashIndex = trimmed.indexOf("#")
  if (hashIndex >= 0) {
    pathPart = trimmed.slice(0, hashIndex)
    anchorPart = trimmed.slice(hashIndex + 1)
  }

  let resolvedPath
  if (pathPart.length === 0) {
    resolvedPath = fromFile
  } else if (pathPart.startsWith("/")) {
    resolvedPath = resolve(repoRoot, pathPart.replace(/^\/+/, ""))
  } else {
    resolvedPath = resolve(dirname(fromFile), pathPart)
  }
  resolvedPath = normalize(resolvedPath)

  if (!existsSync(resolvedPath)) {
    return {
      status: "missing-file",
      detail: relative(repoRoot, resolvedPath),
    }
  }
  if (statSync(resolvedPath).isDirectory()) {
    if (anchorPart.length === 0) {
      return { status: "ok" }
    }
    return {
      status: "missing-anchor",
      detail: "anchor requested but target is a directory",
    }
  }

  if (anchorPart.length === 0) {
    return { status: "ok" }
  }

  const isMarkdown = extname(resolvedPath).toLowerCase() === ".md"
  if (!isMarkdown) {
    return { status: "ok" }
  }

  let slugs = headingIndex.get(resolvedPath)
  if (!slugs) {
    slugs = extractHeadingSlugs(readFileSync(resolvedPath, "utf8"))
    headingIndex.set(resolvedPath, slugs)
  }
  if (!slugs.has(anchorPart.toLowerCase())) {
    return {
      status: "missing-anchor",
      detail: `anchor "#${anchorPart}" not found in ${relative(repoRoot, resolvedPath)}`,
    }
  }
  return { status: "ok" }
}

export function computeExitCode(report) {
  return report.issues.length > 0 ? 1 : 0
}

function collectMarkdown(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectMarkdown(full, out)
    } else if (entry.isFile() && full.toLowerCase().endsWith(".md")) {
      out.push(full)
    }
  }
}

function printTable(report) {
  console.log(
    `scanned: ${report.scanned}  links: ${report.counts.checkedLinks}  images: ${report.counts.checkedImages}  issues: ${report.issues.length}`,
  )
  for (const issue of report.issues) {
    console.log(`  [${issue.status}] ${issue.file}:${issue.line} ${issue.kind} -> ${issue.target}  ${issue.detail ?? ""}`)
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), format: "table", help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      args.help = true
    } else if (arg === "--repo-root") {
      const value = argv[i + 1]
      if (!value) throw new Error("--repo-root requires a value")
      args.root = value
      i += 1
    } else if (arg === "--format") {
      const value = argv[i + 1]
      if (!value) throw new Error("--format requires a value")
      if (value !== "json" && value !== "table") {
        throw new Error(`--format must be one of json,table (got "${value}")`)
      }
      args.format = value
      i += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function printUsage() {
  console.log(`usage: node scripts/verify-workshop-integrity.mjs [options]

options:
  --repo-root <path>   repository root to scan (default: cwd)
  --format json|table  output format (default: table)
  --help, -h           show this help

Scans docs/workshop/**/*.md for broken local link targets and
missing heading anchors. Absolute URLs are validated for syntax
only (no live HTTP fetch — the check stays offline-safe).
`)
}

function isMainModule(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const url = new URL(metaUrl)
    return url.pathname === entry || url.pathname.endsWith(entry)
  } catch {
    return false
  }
}
