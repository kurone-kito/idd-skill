import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  classifyAndCheck,
  computeExitCode,
  extractHeadingSlugs,
  extractReferences,
  runVerification,
  slugifyHeading,
} from "../scripts/verify-workshop-integrity.mjs"

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "workshop-integrity-"))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    write: (relPath, content) => {
      const full = join(root, relPath)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, content)
      return full
    },
  }
}

test("slugifyHeading mirrors GitHub heading slug algorithm", () => {
  assert.equal(slugifyHeading("Hello World"), "hello-world")
  assert.equal(slugifyHeading("Section: 1.0"), "section-10")
  assert.equal(slugifyHeading("`code` heading"), "code-heading")
  assert.equal(slugifyHeading("emoji 🎉 heading"), "emoji-heading")
  assert.equal(slugifyHeading("multi   space"), "multi-space")
  assert.equal(slugifyHeading("--trim--"), "trim")
  assert.equal(slugifyHeading(""), "")
})

test("extractHeadingSlugs reads ATX headings outside code fences", () => {
  const md = `# First\n\n## Second\n\n\`\`\`\n# inside fence\n\`\`\`\n\n### Third\n`
  const slugs = extractHeadingSlugs(md)
  assert.equal(slugs.has("first"), true)
  assert.equal(slugs.has("second"), true)
  assert.equal(slugs.has("third"), true)
  assert.equal(slugs.has("inside-fence"), false)
})

test("extractReferences finds links and images with line numbers", () => {
  const md = `line one\n[link](./a.md)\n![alt](b.png)\n[code](https://example.com)\n`
  const refs = extractReferences(md)
  assert.equal(refs.length, 3)
  assert.deepEqual(refs[0], { kind: "link", target: "./a.md", line: 2 })
  assert.deepEqual(refs[1], { kind: "image", target: "b.png", line: 3 })
  assert.deepEqual(refs[2], { kind: "link", target: "https://example.com", line: 4 })
})

test("classifyAndCheck accepts absolute URLs without HTTP fetch", () => {
  const result = classifyAndCheck("https://example.com/x", "/tmp/foo.md", "/tmp", new Map())
  assert.equal(result.status, "ok")
})

test("classifyAndCheck rejects malformed absolute URLs as invalid-url", () => {
  const result = classifyAndCheck("https://[bad-url", "/tmp/foo.md", "/tmp", new Map())
  assert.equal(result.status, "invalid-url")
})

test("classifyAndCheck reports missing-file for unresolved local target", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const from = repo.write("docs/a.md", "# a\n")
  const result = classifyAndCheck("./missing.md", from, repo.root, new Map())
  assert.equal(result.status, "missing-file")
})

test("classifyAndCheck resolves local file successfully", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/target.md", "# target\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./target.md", from, repo.root, new Map())
  assert.equal(result.status, "ok")
})

test("classifyAndCheck accepts valid anchor in target file", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/target.md", "# Target\n\n## Sub Heading\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./target.md#sub-heading", from, repo.root, new Map())
  assert.equal(result.status, "ok")
})

test("classifyAndCheck reports missing-anchor for unknown heading", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/target.md", "# Target\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./target.md#nonexistent", from, repo.root, new Map())
  assert.equal(result.status, "missing-anchor")
})

test("classifyAndCheck resolves anchors against same-file (empty path)", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const from = repo.write("docs/from.md", "# from\n\n## Local Heading\n")
  const result = classifyAndCheck("#local-heading", from, repo.root, new Map())
  assert.equal(result.status, "ok")
})

test("runVerification surfaces broken links across a workshop tree", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/workshop/README.md", `[ok](./log.md)\n[broken](./missing.md)\n![img](./assets/a.png)\n`)
  repo.write("docs/workshop/log.md", "# log\n")
  repo.write("docs/workshop/assets/a.png", "fake png")
  const report = runVerification(repo.root)
  assert.equal(report.scanned, 2)
  assert.equal(report.issues.length, 1)
  assert.equal(report.issues[0].status, "missing-file")
  assert.equal(report.issues[0].target, "./missing.md")
})

test("runVerification is a no-op when the workshop tree is absent", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const report = runVerification(repo.root)
  assert.equal(report.scanned, 0)
  assert.equal(report.issues.length, 0)
})

test("computeExitCode returns 1 when issues exist, 0 otherwise", () => {
  assert.equal(computeExitCode({ issues: [] }), 0)
  assert.equal(computeExitCode({ issues: [{}] }), 1)
})
