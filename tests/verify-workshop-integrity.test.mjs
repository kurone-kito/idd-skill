import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  classifyAndCheck,
  computeExitCode,
  extractHeadingSlugs,
  extractReferenceDefinitions,
  extractReferences,
  runVerification,
  slugifyHeading,
  stripFencedCodeBlocks,
  stripHtmlComments,
  stripInlineCodeSpans,
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

test("slugifyHeading fully collapses nested HTML to leave only the text", () => {
  // CodeQL flagged a single-pass HTML strip as incomplete-multi-char
  // sanitization. The loop should fully collapse nested tags so the
  // remaining text is what survives — for `<<script>>x</script>>`
  // that is the bare letter `x`.
  assert.equal(slugifyHeading("<<script>>x</script>>"), "x")
  assert.equal(slugifyHeading("plain <b>bold</b> text"), "plain-bold-text")
})

test("extractHeadingSlugs disambiguates duplicate headings with -1, -2 suffixes", () => {
  const md = "# Notes\n\n# Notes\n\n# Notes\n"
  const slugs = extractHeadingSlugs(md)
  assert.equal(slugs.has("notes"), true)
  assert.equal(slugs.has("notes-1"), true)
  assert.equal(slugs.has("notes-2"), true)
})

test("extractHeadingSlugs recognizes Setext-style headings", () => {
  const md = `Title\n=====\n\nSubtitle\n--------\n`
  const slugs = extractHeadingSlugs(md)
  assert.equal(slugs.has("title"), true)
  assert.equal(slugs.has("subtitle"), true)
})

test("stripFencedCodeBlocks elides backtick and tilde fences alike", () => {
  const md = "outside\n```\ninside-back\n```\nmiddle\n~~~\ninside-tilde\n~~~\nend"
  const stripped = stripFencedCodeBlocks(md)
  assert.equal(stripped.includes("inside-back"), false)
  assert.equal(stripped.includes("inside-tilde"), false)
  assert.equal(stripped.includes("outside"), true)
  assert.equal(stripped.includes("middle"), true)
  assert.equal(stripped.includes("end"), true)
})

test("extractReferences skips links inside fenced code blocks", () => {
  const md = "real [link](./a.md)\n```md\nfake [link](./missing.md)\n```\n"
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./a.md")
})

test("extractReferenceDefinitions reads [label]: target pairs", () => {
  const md = `text\n\n[alpha]: ./a.md\n[beta]: https://example.com "Title"\n`
  const defs = extractReferenceDefinitions(md)
  assert.equal(defs.get("alpha"), "./a.md")
  assert.equal(defs.get("beta"), "https://example.com")
})

test("extractReferences resolves [text][label] against the definition table", () => {
  const md = `[click][alpha] and ![img][beta]\n\n[alpha]: ./a.md\n[beta]: ./img.png\n`
  const defs = extractReferenceDefinitions(md)
  const refs = extractReferences(md, defs)
  assert.equal(refs.length, 2)
  assert.equal(refs[0].target, "./a.md")
  assert.equal(refs[0].kind, "link")
  assert.equal(refs[1].target, "./img.png")
  assert.equal(refs[1].kind, "image")
})

test("extractReferences reports unresolved reference labels", () => {
  const md = `[click][nowhere]\n`
  const refs = extractReferences(md, new Map())
  assert.equal(refs.length, 1)
  assert.equal(refs[0].status, "unresolved-reference")
  assert.equal(refs[0].label, "nowhere")
})

test("extractReferences honors collapsed [text][] shape", () => {
  const md = `[Alpha][]\n\n[alpha]: ./a.md\n`
  const defs = extractReferenceDefinitions(md)
  const refs = extractReferences(md, defs)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./a.md")
})

test("classifyAndCheck flags path-traversal links as escapes-repo", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("/../../etc/hosts", from, repo.root, new Map())
  assert.equal(result.status, "escapes-repo")
})

test("classifyAndCheck percent-decodes local paths before file checks", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/my file.md", "# title\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./my%20file.md", from, repo.root, new Map())
  assert.equal(result.status, "ok")
})

test("stripFencedCodeBlocks requires closing fence to be at least as long as opening", () => {
  const md = "outer\n````\nfake ``` close\nstill inside\n````\nafter"
  const stripped = stripFencedCodeBlocks(md)
  assert.equal(stripped.includes("fake ``` close"), false)
  assert.equal(stripped.includes("still inside"), false)
  assert.equal(stripped.includes("outer"), true)
  assert.equal(stripped.includes("after"), true)
})

test("stripFencedCodeBlocks treats fenced lines with info strings as content (not close)", () => {
  // Per CommonMark §4.5, a closing fence may contain only optional
  // whitespace after the fence marker. A line like ```js inside a
  // fence is content, not a close.
  const md = "outer\n```\n```js\nstill inside\n```\nafter"
  const stripped = stripFencedCodeBlocks(md)
  assert.equal(stripped.includes("```js"), false)
  assert.equal(stripped.includes("still inside"), false)
  assert.equal(stripped.includes("outer"), true)
  assert.equal(stripped.includes("after"), true)
})

test("extractReferences resolves shortcut reference [label] against refDefs", () => {
  const md = `see [alpha] for details\n\n[alpha]: ./a.md\n`
  const defs = extractReferenceDefinitions(md)
  const refs = extractReferences(md, defs)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./a.md")
})

test("extractReferences leaves unmatched bracketed text alone (no false positives)", () => {
  const md = `prose with [example] brackets\n`
  const refs = extractReferences(md, new Map())
  assert.equal(refs.length, 0)
})

test("classifyAndCheck accepts mailto: and tel: schemes", () => {
  assert.equal(
    classifyAndCheck("mailto:foo@example.com", "/tmp/x.md", "/tmp", new Map()).status,
    "ok",
  )
  assert.equal(
    classifyAndCheck("tel:+15555550123", "/tmp/x.md", "/tmp", new Map()).status,
    "ok",
  )
})

test("classifyAndCheck strips query strings before resolving local paths", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  repo.write("docs/b.md", "# title\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./b.md?plain=1", from, repo.root, new Map())
  assert.equal(result.status, "ok")
})

test("classifyAndCheck percent-decodes anchors before slug comparison", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  // `日本語` percent-encoded.
  repo.write("docs/target.md", "# 日本語\n")
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck(
    "./target.md#%E6%97%A5%E6%9C%AC%E8%AA%9E",
    from,
    repo.root,
    new Map(),
  )
  assert.equal(result.status, "ok")
})

test("extractReferences ignores links inside inline code spans", () => {
  const md = "real [a](./a.md) and `[demo](./missing.md)` in prose"
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./a.md")
})

test("extractReferences ignores backslash-escaped link delimiters", () => {
  const md = `\\[demo](./missing.md) is literal text\n`
  const refs = extractReferences(md)
  assert.equal(refs.length, 0)
})

test("extractReferences unwraps angle-bracket destinations", () => {
  const md = `[ok](<./b.md>)\n`
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./b.md")
})

test("extractReferences extracts CommonMark angle-bracket autolinks", () => {
  const md = `See <https://example.com/x> for details\n`
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "https://example.com/x")
})

test("extractReferenceDefinitions unwraps angle-bracket destinations", () => {
  const md = `[a]: <./b.md>\n[b]: <https://example.com>\n`
  const defs = extractReferenceDefinitions(md)
  assert.equal(defs.get("a"), "./b.md")
  assert.equal(defs.get("b"), "https://example.com")
})

test("extractReferences treats backslash-escaped \\! as literal but keeps the link", () => {
  // CommonMark §6.1: `\!` renders as a literal `!`, but the
  // following `[text](target)` is still a valid inline link. So we
  // should extract a link (not an image) pointing at the target.
  const md = `\\![alt](./b.md) is rendered with a literal ! plus a link\n`
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].kind, "link")
  assert.equal(refs[0].target, "./b.md")
})

test("extractReferences handles multi-line inline image/link alt text and reports the opening line", () => {
  const md = "before\n\n![long alt that\nwraps lines](./img.png)\nafter\n"
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].kind, "image")
  assert.equal(refs[0].target, "./img.png")
  // The opening `[` lives on the third line of the document.
  assert.equal(refs[0].line, 3)
})

test("stripHtmlComments masks single-line and multi-line HTML comments", () => {
  const md = "before <!-- inline --> middle\nblock <!--\n[demo](./x.md)\n--> end"
  const stripped = stripHtmlComments(md)
  assert.equal(stripped.includes("[demo]"), false)
  assert.equal(stripped.includes("inline"), false)
  assert.equal(stripped.includes("before"), true)
  assert.equal(stripped.includes("middle"), true)
  assert.equal(stripped.includes("end"), true)
  // Line count is preserved (newlines untouched).
  assert.equal(stripped.split("\n").length, md.split("\n").length)
})

test("extractReferences ignores links inside HTML comments", () => {
  const md = "real [a](./a.md)\n<!-- ignored [demo](./missing.md) -->\nend"
  const refs = extractReferences(md)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].target, "./a.md")
})

test("extractReferenceDefinitions ignores definitions inside HTML comments", () => {
  const md = `text\n\n<!--\n[hidden]: ./should-not-resolve.md\n-->\n[real]: ./a.md\n`
  const defs = extractReferenceDefinitions(md)
  assert.equal(defs.has("hidden"), false)
  assert.equal(defs.get("real"), "./a.md")
})

test("extractHeadingSlugs ignores headings inside HTML comments", () => {
  const md = `# Real\n\n<!-- # Hidden -->\n\n## Visible\n`
  const slugs = extractHeadingSlugs(md)
  assert.equal(slugs.has("real"), true)
  assert.equal(slugs.has("visible"), true)
  assert.equal(slugs.has("hidden"), false)
})

test("stripInlineCodeSpans masks multi-line backtick code spans", () => {
  const md = "before `multi\nline span containing [demo](./x.md)\n` after"
  const stripped = stripInlineCodeSpans(md)
  assert.equal(stripped.includes("[demo]"), false)
  assert.equal(stripped.includes("before"), true)
  assert.equal(stripped.includes("after"), true)
  // Newlines preserved.
  assert.equal(stripped.split("\n").length, md.split("\n").length)
})

test("classifyAndCheck rejects symlinks that point outside the repo as escapes-repo", async (t) => {
  const repo = makeRepo()
  t.after(() => repo.cleanup())
  const outside = makeRepo()
  t.after(() => outside.cleanup())
  outside.write("secret.md", "# secret\n")
  // Create a symlink inside the repo that points to a file outside.
  mkdirSync(join(repo.root, "docs"), { recursive: true })
  symlinkSync(join(outside.root, "secret.md"), join(repo.root, "docs/symlink.md"))
  const from = repo.write("docs/from.md", "# from\n")
  const result = classifyAndCheck("./symlink.md", from, repo.root, new Map())
  assert.equal(result.status, "escapes-repo")
})

test("classifyAndCheck accepts non-hierarchical absolute URI schemes (urn:, data:)", () => {
  assert.equal(
    classifyAndCheck("urn:isbn:0451450523", "/tmp/x.md", "/tmp", new Map()).status,
    "ok",
  )
  assert.equal(
    classifyAndCheck("data:text/plain,hi", "/tmp/x.md", "/tmp", new Map()).status,
    "ok",
  )
})
