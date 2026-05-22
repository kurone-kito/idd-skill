#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path"

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

  const fileContents = new Map()
  const fileMeta = new Map()
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    fileContents.set(file, content)
    fileMeta.set(file, {
      headingSlugs: extractHeadingSlugs(content),
      refDefs: extractReferenceDefinitions(content),
    })
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
      escapedRepo: 0,
      unresolvedRef: 0,
    },
  }

  for (const file of files) {
    const content = fileContents.get(file)
    const { refDefs } = fileMeta.get(file)
    const refs = extractReferences(content, refDefs)
    for (const ref of refs) {
      if (ref.kind === "image") {
        report.counts.checkedImages += 1
      } else {
        report.counts.checkedLinks += 1
      }
      if (ref.status === "unresolved-reference") {
        report.counts.unresolvedRef += 1
        report.issues.push({
          file: relative(repoRoot, file),
          kind: ref.kind,
          target: ref.label,
          line: ref.line,
          status: "unresolved-reference",
          detail: `reference label "${ref.label}" has no [id]: target definition`,
        })
        continue
      }
      const result = classifyAndCheck(ref.target, file, repoRoot, fileMeta)
      if (result.status === "ok") {
        continue
      }
      if (result.status === "missing-file") {
        report.counts.missingFile += 1
      } else if (result.status === "missing-anchor") {
        report.counts.missingAnchor += 1
      } else if (result.status === "invalid-url") {
        report.counts.invalidUrl += 1
      } else if (result.status === "escapes-repo") {
        report.counts.escapedRepo += 1
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

// Strips fenced code blocks (``` and ~~~) before pattern scanning so
// example Markdown inside code samples is never interpreted as a real
// link or heading. Tracks both fence character and opening length so a
// 4-backtick block is not closed by a later 3-backtick line (the
// closing fence must use the same character and be at least as long).
export function stripFencedCodeBlocks(content) {
  const lines = String(content).split(/\r?\n/)
  const out = []
  let fence = null
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (match) {
      const open = match[1]
      const openChar = open[0]
      const openLen = open.length
      if (fence === null) {
        fence = { char: openChar, length: openLen }
        out.push("")
        continue
      }
      if (openChar === fence.char && openLen >= fence.length) {
        fence = null
        out.push("")
        continue
      }
    }
    out.push(fence === null ? line : "")
  }
  return out.join("\n")
}

export function extractReferenceDefinitions(markdown) {
  const stripped = stripFencedCodeBlocks(markdown)
  const map = new Map()
  const lines = stripped.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/)
    if (!match) continue
    const label = match[1].trim().toLowerCase()
    map.set(label, match[2])
  }
  return map
}

export function extractReferences(markdown, refDefs = new Map()) {
  const refs = []
  const stripped = stripFencedCodeBlocks(markdown)
  const lines = stripped.split(/\r?\n/)
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    extractInlineFromLine(line, lineNumber + 1, refs)
    extractReferenceStyleFromLine(line, lineNumber + 1, refs, refDefs)
    extractShortcutReferencesFromLine(line, lineNumber + 1, refs, refDefs)
  }
  return refs
}

function extractInlineFromLine(line, lineNumber, refs) {
  // CommonMark inline link / image. Single-line only; balanced
  // parentheses inside the destination are not supported (rare in
  // this codebase). Optional title accepts double-quoted,
  // single-quoted, or parenthesized form.
  const pattern = /(!?)\[([^\]\n]*)\]\(\s*([^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    refs.push({
      kind: match[1] === "!" ? "image" : "link",
      target: match[3],
      line: lineNumber,
    })
  }
}

function extractReferenceStyleFromLine(line, lineNumber, refs, refDefs) {
  // Skip reference-definition lines themselves so [id]: target lines
  // are not mistaken for references.
  if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) {
    return
  }
  // [text][label] or ![alt][label]. Empty label (`[text][]`)
  // resolves against the text itself.
  const pattern = /(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    const isImage = match[1] === "!"
    const text = match[2]
    const labelRaw = match[3].trim().length === 0 ? text : match[3]
    const label = labelRaw.trim().toLowerCase()
    const target = refDefs.get(label)
    if (!target) {
      refs.push({
        kind: isImage ? "image" : "link",
        label: labelRaw,
        line: lineNumber,
        status: "unresolved-reference",
      })
      continue
    }
    refs.push({
      kind: isImage ? "image" : "link",
      target,
      line: lineNumber,
    })
  }
}

function extractShortcutReferencesFromLine(line, lineNumber, refs, refDefs) {
  // Skip reference-definition lines themselves.
  if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) {
    return
  }
  if (refDefs.size === 0) {
    return
  }
  // CommonMark shortcut reference: [label] alone, not followed by
  // (target), [other-label], or : (which would be a definition).
  // The (?<!\]) lookbehind excludes the trailing [label] portion of
  // a full reference-style link like [text][label], which is already
  // captured by extractReferenceStyleFromLine.
  // We only emit refs whose label resolves against refDefs — bare
  // bracketed text without a matching definition is not flagged so
  // ordinary prose like `the [example] above` does not produce false
  // positives.
  const pattern = /(?<!\])(!?)\[([^\]\n]+)\](?!\(|\[|:)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    const isImage = match[1] === "!"
    const labelRaw = match[2]
    const label = labelRaw.trim().toLowerCase()
    const target = refDefs.get(label)
    if (!target) continue
    refs.push({
      kind: isImage ? "image" : "link",
      target,
      line: lineNumber,
    })
  }
}

export function extractHeadingSlugs(markdown) {
  const slugs = new Set()
  const counts = new Map()
  const stripped = stripFencedCodeBlocks(markdown)
  const lines = stripped.split(/\r?\n/)
  const consider = (raw) => {
    const slug = slugifyHeading(raw)
    if (!slug) return
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    const final = count === 0 ? slug : `${slug}-${count}`
    slugs.add(final)
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (atx) {
      consider(atx[2])
      continue
    }
    // Setext: a non-blank text line followed by ==... or --...
    if (i + 1 < lines.length) {
      const next = lines[i + 1]
      const isSetextUnderline = /^\s{0,3}(=+|-+)\s*$/.test(next)
      if (isSetextUnderline && line.trim().length > 0 && !/^\s*$/.test(line)) {
        // Guard: ensure the current line is not itself a list bullet
        // or fence; treat plain text only as a Setext heading.
        if (!/^\s{0,3}(```|~~~|[-*+]\s|\d+\.\s|#)/.test(line)) {
          consider(line.trim())
        }
      }
    }
  }
  return slugs
}

// GitHub heading slug algorithm (simplified): strip HTML tags,
// drop most punctuation, lowercase, replace spaces with hyphens,
// keep Unicode letters/digits, underscore, and hyphen. See
// https://gist.github.com/asabaylus/3071099 for the reference
// algorithm.
export function slugifyHeading(text) {
  if (!text) return ""
  let s = String(text)
  // Strip HTML tags. Loop until no further change so payloads like
  // `<<script>foo</script>>` collapse instead of leaving fragments
  // such as `<script>foo</script>` after a single pass.
  let prev
  do {
    prev = s
    s = s.replace(/<[^<>]*>/g, "")
  } while (s !== prev)
  // Drop any remaining angle brackets defensively.
  s = s.replace(/[<>]/g, "")
  s = s.replace(/`([^`]*)`/g, "$1")
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  s = s.toLowerCase()
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, "")
  s = s.replace(/\s+/g, "-")
  s = s.replace(/^-+|-+$/g, "")
  return s
}

export function classifyAndCheck(target, fromFile, repoRoot, fileMeta) {
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

  let decodedPath = pathPart
  try {
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    // Leave as-is when not valid percent-encoding.
  }

  let resolvedPath
  if (decodedPath.length === 0) {
    resolvedPath = fromFile
  } else if (decodedPath.startsWith("/")) {
    resolvedPath = resolve(repoRoot, decodedPath.replace(/^\/+/, ""))
  } else {
    resolvedPath = resolve(dirname(fromFile), decodedPath)
  }
  resolvedPath = normalize(resolvedPath)

  const repoRootNormalized = normalize(repoRoot)
  if (!isInside(resolvedPath, repoRootNormalized)) {
    return {
      status: "escapes-repo",
      detail: `${decodedPath} resolves outside ${relative(process.cwd(), repoRootNormalized) || "."}`,
    }
  }

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

  let meta = fileMeta.get(resolvedPath)
  if (!meta) {
    const content = readFileSync(resolvedPath, "utf8")
    meta = {
      headingSlugs: extractHeadingSlugs(content),
      refDefs: extractReferenceDefinitions(content),
    }
    fileMeta.set(resolvedPath, meta)
  }
  if (!meta.headingSlugs.has(anchorPart.toLowerCase())) {
    return {
      status: "missing-anchor",
      detail: `anchor "#${anchorPart}" not found in ${relative(repoRoot, resolvedPath)}`,
    }
  }
  return { status: "ok" }
}

function isInside(targetPath, rootPath) {
  if (targetPath === rootPath) return true
  const rootWithSep = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`
  return targetPath.startsWith(rootWithSep)
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

Scans docs/workshop/**/*.md for broken local link targets, missing
heading anchors, and unresolved reference labels. Absolute URLs are
validated for syntax only (no live HTTP fetch — the check stays
offline-safe). Targets that resolve outside the repository root via
path traversal are reported as errors.
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
