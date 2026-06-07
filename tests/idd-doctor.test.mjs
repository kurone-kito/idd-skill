import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  backLinkPatternFor,
  classifyBacklog,
  classifyPrimaryHead,
  classifyWorktreeHeadFinding,
  computeWindowStartIso,
  containsExampleRepoBackLink,
  containsWorkshopReference,
  decodeGithubReadmeBase64,
  evaluateAutopilotSuitabilityConsistency,
  extractMarkerPrefixes,
  findMissingWorkshopReferences,
  findMissingWorktreeHardening,
  findPlaceholders,
  isGithubBackLinkHost,
  parsePrimaryWorktreePath,
  parseProjectCommandRows,
  readWorktreeGuardEnabled,
  stripMarkdownNonText,
} from "../scripts/idd-doctor.mjs"

const ap = (n) => `<!-- idd-skill-autopilot-suitability: ${n} -->`

test("autopilot-suitability consistency: valid score+label combinations produce no warnings", () => {
  const issues = [
    { number: 1, body: `task\n${ap(5)}`, labels: [] },
    { number: 2, body: `task\n${ap(4)}`, labels: [{ name: "enhancement" }] },
    { number: 3, body: `human-only\n${ap(1)}`, labels: ["status:blocked-by-human"] },
    { number: 4, body: "no score marker at all", labels: [] },
  ]
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, { floor: 3 })
  assert.deepEqual(warnings, [])
})

test("autopilot-suitability consistency: score 1 without blocked-by-human warns", () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [{ number: 7, body: `task\n${ap(1)}`, labels: [] }],
    { floor: 3 },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /issue #7 is scored 1 .* missing the status:blocked-by-human label/)
})

test("autopilot-suitability consistency: score >= floor with blocked-by-human warns", () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [{ number: 8, body: `task\n${ap(4)}`, labels: ["status:blocked-by-human"] }],
    { floor: 3 },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /issue #8 is scored 4 \(>= floor 3\) but carries status:blocked-by-human/)
})

test("autopilot-suitability consistency: malformed or conflicting markers warn", () => {
  const issues = [
    { number: 9, body: `task\n${ap(6)}`, labels: [] },
    { number: 10, body: `task\n${ap("high")}`, labels: [] },
    { number: 11, body: `task\n${ap(4)}\n${ap(2)}`, labels: [] },
  ]
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, { floor: 3 })
  assert.equal(warnings.length, 3)
  assert.ok(warnings.every((w) => /malformed or out-of-range score marker/.test(w)))
})

test("autopilot-suitability consistency: missing marker never warns (fail-safe)", () => {
  const { warnings } = evaluateAutopilotSuitabilityConsistency(
    [{ number: 12, body: "ordinary issue, no score", labels: ["status:blocked-by-human"] }],
    { floor: 3 },
  )
  assert.deepEqual(warnings, [])
})

test("autopilot-suitability consistency: honors a custom floor and marker prefix", () => {
  const issues = [
    // floor 4: score 3 with blocked-by-human is NOT >= floor, so no warning.
    { number: 13, body: `t\n<!-- my-org-autopilot-suitability: 3 -->`, labels: ["status:blocked-by-human"] },
    // floor 4: score 4 with blocked-by-human warns.
    { number: 14, body: `t\n<!-- my-org-autopilot-suitability: 4 -->`, labels: ["status:blocked-by-human"] },
  ]
  const { warnings } = evaluateAutopilotSuitabilityConsistency(issues, { floor: 4, markerPrefix: "my-org" })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /issue #14 is scored 4 \(>= floor 4\)/)
})

test("findPlaceholders returns template tokens", () => {
  const placeholders = findPlaceholders(`
  keep {{REPO_NAME}}
  and {{PROJECT_MARKER_PREFIX}}
  but ignore {NOT_A_PLACEHOLDER}
  `)

  assert.deepEqual(placeholders, ["{{REPO_NAME}}", "{{PROJECT_MARKER_PREFIX}}"])
})

test("findPlaceholders also captures lowercase and hyphenated tokens", () => {
  const placeholders = findPlaceholders(`
  keep {{repo_name}}
  and {{marker-prefix}}
  but ignore {NOT_A_PLACEHOLDER}
  `)

  assert.deepEqual(placeholders, ["{{repo_name}}", "{{marker-prefix}}"])
})

test("parseProjectCommandRows extracts command rows from the table", () => {
  const commands = parseProjectCommandRows(`
| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`npm run fix\` |
| **pre-push-validate** | \`npm run lint && npm test\` |
| **post-fix-validate** | \`npm run build\` |
| **install-deps** | \`npm ci\` |
| **issue-scope** | \`roadmap\` |
`)

  assert.equal(commands.get("fix-validate"), "npm run fix")
  assert.equal(commands.get("pre-push-validate"), "npm run lint && npm test")
  assert.equal(commands.get("install-deps"), "npm ci")
  assert.equal(commands.get("issue-scope"), "roadmap")
})

test("extractMarkerPrefixes returns roadmap and blocked-by prefixes", () => {
  const markers = extractMarkerPrefixes(`
<!-- idd-skill-roadmap-id: value -->
<!-- idd-skill-blocked-by: value -->
<!-- my-team-roadmap-id: value -->
<!-- MyTeam-blocked-by: value -->
`)

  assert.deepEqual(markers.roadmap, ["idd-skill", "my-team"])
  assert.deepEqual(markers.blockedBy, ["idd-skill", "MyTeam"])
})

test("parsePrimaryWorktreePath returns the first worktree entry", () => {
  const porcelain = [
    "worktree /repo/idd-skill",
    "HEAD ec72ee60dea3b9eeeb6ca0d7717daa46b98dcc13",
    "branch refs/heads/main",
    "",
    "worktree /repo/idd-skill.issue-703-foo",
    "HEAD abc123",
    "branch refs/heads/issue/703-foo",
    "",
  ].join("\n")

  assert.equal(parsePrimaryWorktreePath(porcelain), "/repo/idd-skill")
})

test("parsePrimaryWorktreePath returns null when input has no worktree line", () => {
  assert.equal(parsePrimaryWorktreePath(""), null)
  assert.equal(parsePrimaryWorktreePath("HEAD abc\nbranch main\n"), null)
})

test("classifyPrimaryHead flags issue/* branches as B1 violations", () => {
  assert.deepEqual(classifyPrimaryHead("issue/123-foo"), {
    isB1Violation: true,
    kind: "issue",
  })
})

test("classifyPrimaryHead flags roadmap-audit/* branches as B1 violations", () => {
  assert.deepEqual(classifyPrimaryHead("roadmap-audit/456-bar"), {
    isB1Violation: true,
    kind: "roadmap-audit",
  })
})

test("classifyPrimaryHead accepts main as not a violation", () => {
  assert.deepEqual(classifyPrimaryHead("main"), {
    isB1Violation: false,
    kind: "other",
  })
})

test("classifyPrimaryHead handles empty or non-string input as unknown", () => {
  assert.deepEqual(classifyPrimaryHead(""), { isB1Violation: false, kind: "unknown" })
  assert.deepEqual(classifyPrimaryHead(null), { isB1Violation: false, kind: "unknown" })
  assert.deepEqual(classifyPrimaryHead(undefined), { isB1Violation: false, kind: "unknown" })
})

test("classifyWorktreeHeadFinding returns null when HEAD is not a violation", () => {
  assert.equal(
    classifyWorktreeHeadFinding({ isB1Violation: false, kind: "other" }, "main", "/repo", true),
    null,
  )
})

test("classifyWorktreeHeadFinding warns (not errors) when the guard is not enforced", () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: "issue" },
    "issue/123-foo",
    "/repo",
    false,
  )
  assert.equal(finding.level, "warning")
  assert.match(finding.message, /an issue branch \(issue\/123-foo\)/)
  assert.match(finding.message, /likely a past B1 violation/)
})

test("classifyWorktreeHeadFinding promotes to an error when the guard is enforced", () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: "issue" },
    "issue/123-foo",
    "/repo",
    true,
  )
  assert.equal(finding.level, "error")
  assert.match(finding.message, /worktree guard enforced/)
})

test("classifyWorktreeHeadFinding labels roadmap-audit branches", () => {
  const finding = classifyWorktreeHeadFinding(
    { isB1Violation: true, kind: "roadmap-audit" },
    "roadmap-audit/456-bar",
    "/repo",
    true,
  )
  assert.equal(finding.level, "error")
  assert.match(finding.message, /a roadmap-audit branch/)
})

test("readWorktreeGuardEnabled reads worktreeGuard.enabled from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "idd-guard-"))
  try {
    const writeConfig = (obj) => {
      mkdirSync(join(dir, ".github/idd"), { recursive: true })
      writeFileSync(join(dir, ".github/idd/config.json"), JSON.stringify(obj))
    }
    writeConfig({ worktreeGuard: { enabled: true } })
    assert.equal(readWorktreeGuardEnabled(dir), true)
    writeConfig({ worktreeGuard: { enabled: false } })
    assert.equal(readWorktreeGuardEnabled(dir), false)
    writeConfig({ markerPrefix: "idd-skill" })
    assert.equal(readWorktreeGuardEnabled(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readWorktreeGuardEnabled returns false when config is missing or invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "idd-guard-"))
  try {
    assert.equal(readWorktreeGuardEnabled(dir), false)
    mkdirSync(join(dir, ".github/idd"), { recursive: true })
    writeFileSync(join(dir, ".github/idd/config.json"), "{ not json")
    assert.equal(readWorktreeGuardEnabled(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const HARDENED_WORK = "## B1\n\n### Anti-patterns\n\ntext\n\n### B1 self-check\n\ntext\n"
const HARDENED_CORE = "The cwd-vs-claim check runs before any local commit, push, or merge.\n"
const HARDENED_DOCTOR = "function checkPrimaryWorktreeHead(root, report) {}\n"

test("findMissingWorktreeHardening reports nothing when all signals are present", () => {
  assert.deepEqual(
    findMissingWorktreeHardening({
      work: HARDENED_WORK,
      core: HARDENED_CORE,
      doctor: HARDENED_DOCTOR,
    }),
    [],
  )
})

test("findMissingWorktreeHardening flags a stale instruction set missing the B1 sections", () => {
  const missing = findMissingWorktreeHardening({
    work: "## B1\n\nno guardrails here\n",
    core: HARDENED_CORE,
    doctor: HARDENED_DOCTOR,
  })
  assert.ok(missing.some((m) => /Anti-patterns/.test(m)))
  assert.ok(missing.some((m) => /B1 self-check/.test(m)))
})

test("findMissingWorktreeHardening flags cwd-vs-claim present but lacking local-commit coverage", () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: "The cwd-vs-claim check runs before any push or merge.\n",
    doctor: HARDENED_DOCTOR,
  })
  assert.deepEqual(missing, ["overview-core cwd-vs-claim local-commit coverage"])
})

test("findMissingWorktreeHardening is not fooled by an unrelated 'local commit' mention", () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    // "local commit" appears, but not in the gate's mutation enumeration.
    core: "A local commit is just a commit. The cwd-vs-claim check runs before any push or merge.\n",
    doctor: HARDENED_DOCTOR,
  })
  assert.deepEqual(missing, ["overview-core cwd-vs-claim local-commit coverage"])
})

test("findMissingWorktreeHardening accepts the opening '(local commit,' enumeration", () => {
  assert.deepEqual(
    findMissingWorktreeHardening({
      work: HARDENED_WORK,
      core: "The cwd-vs-claim gate covers (local commit, claim heartbeat, push, merge).\n",
      doctor: HARDENED_DOCTOR,
    }),
    [],
  )
})

test("findMissingWorktreeHardening flags a missing cwd-vs-claim gate", () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: "no gate at all\n",
    doctor: HARDENED_DOCTOR,
  })
  assert.deepEqual(missing, ["overview-core cwd-vs-claim gate"])
})

test("findMissingWorktreeHardening flags a vendored idd-doctor without the detector", () => {
  const missing = findMissingWorktreeHardening({
    work: HARDENED_WORK,
    core: HARDENED_CORE,
    doctor: "function somethingElse() {}\n",
  })
  assert.deepEqual(missing, ["idd-doctor checkPrimaryWorktreeHead detector"])
})

test("findMissingWorktreeHardening skips absent files instead of reporting them", () => {
  // null/undefined (file not present) must not be treated as a stale signal.
  assert.deepEqual(findMissingWorktreeHardening({ work: null, core: null, doctor: null }), [])
  assert.deepEqual(findMissingWorktreeHardening({}), [])
})

test("computeWindowStartIso subtracts the given number of days from now", () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0)
  assert.equal(computeWindowStartIso(now, 14), "2026-05-07T12:00:00.000Z")
  assert.equal(computeWindowStartIso(now, 1), "2026-05-20T12:00:00.000Z")
  assert.equal(computeWindowStartIso(now, 7), "2026-05-14T12:00:00.000Z")
})

test("computeWindowStartIso returns null for non-positive or non-finite windows", () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0)
  assert.equal(computeWindowStartIso(now, 0), null)
  assert.equal(computeWindowStartIso(now, -1), null)
  assert.equal(computeWindowStartIso(now, "abc"), null)
  assert.equal(computeWindowStartIso(now, NaN), null)
  assert.equal(computeWindowStartIso(now, Infinity), null)
})

test("classifyBacklog warns only when count strictly exceeds the threshold", () => {
  assert.deepEqual(classifyBacklog([], 2), { count: 0, warn: false, examples: [] })
  assert.deepEqual(classifyBacklog([100], 2), { count: 1, warn: false, examples: [100] })
  assert.deepEqual(classifyBacklog([100, 101], 2), { count: 2, warn: false, examples: [100, 101] })
  assert.deepEqual(classifyBacklog([100, 101, 102], 2), {
    count: 3,
    warn: true,
    examples: [100, 101, 102],
  })
})

test("classifyBacklog caps examples at 5 entries", () => {
  const verdict = classifyBacklog([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2)
  assert.equal(verdict.count, 10)
  assert.equal(verdict.warn, true)
  assert.deepEqual(verdict.examples, [1, 2, 3, 4, 5])
})

test("classifyBacklog treats non-array input as zero", () => {
  assert.deepEqual(classifyBacklog(null, 2), { count: 0, warn: false, examples: [] })
  assert.deepEqual(classifyBacklog(undefined, 2), { count: 0, warn: false, examples: [] })
  assert.deepEqual(classifyBacklog("not an array", 2), { count: 0, warn: false, examples: [] })
})

test("classifyBacklog coerces non-numeric / NaN / negative thresholds to 0", () => {
  // Any positive count must warn when the threshold is unusable.
  assert.equal(classifyBacklog([1], "not a number").warn, true)
  assert.equal(classifyBacklog([1], NaN).warn, true)
  assert.equal(classifyBacklog([1], Infinity).warn, true)
  assert.equal(classifyBacklog([1], -5).warn, true)
  // Zero count must not warn even with a broken threshold.
  assert.equal(classifyBacklog([], NaN).warn, false)
})

test("computeWindowStartIso returns null for windows that overflow Date range", () => {
  const now = Date.UTC(2026, 4, 21, 12, 0, 0)
  // ~1e9 days is well past the ±100,000,000-day toISOString limit and
  // would historically throw RangeError before this guard landed.
  assert.equal(computeWindowStartIso(now, 1e9), null)
  assert.equal(computeWindowStartIso(now, Number.MAX_SAFE_INTEGER), null)
})

test("containsWorkshopReference accepts canonical, dotted, and absolute link targets", () => {
  assert.equal(
    containsWorkshopReference("see [workshop](docs/workshop/README.md)"),
    true,
  )
  assert.equal(
    containsWorkshopReference("see [workshop](./docs/workshop/)"),
    true,
  )
  assert.equal(
    containsWorkshopReference("see [workshop](/docs/workshop/README.md#intro)"),
    true,
  )
})

test("containsWorkshopReference accepts docs/index.md-relative workshop links", () => {
  // docs/index.md naturally links with `workshop/README.md` because
  // it lives inside docs/ itself. The cross-ref check must accept
  // this shape too.
  assert.equal(
    containsWorkshopReference("see [workshop](workshop/README.md)"),
    true,
  )
  assert.equal(
    containsWorkshopReference("see [workshop](./workshop/)"),
    true,
  )
})

test("containsWorkshopReference accepts single-quoted and parenthesized title forms", () => {
  assert.equal(
    containsWorkshopReference("[w](docs/workshop/README.md 'title')"),
    true,
  )
  assert.equal(
    containsWorkshopReference("[w](docs/workshop/README.md (title))"),
    true,
  )
})

test("containsWorkshopReference ignores workshop links inside fenced code blocks", () => {
  const md = "Demo:\n```md\n[workshop](docs/workshop/README.md)\n```\nreal prose"
  assert.equal(containsWorkshopReference(md), false)
})

test("containsWorkshopReference also ignores tilde-fence code blocks", () => {
  const md = "Demo:\n~~~md\n[workshop](docs/workshop/README.md)\n~~~\nreal prose"
  assert.equal(containsWorkshopReference(md), false)
})

test("containsWorkshopReference rejects unrelated targets and empty content", () => {
  assert.equal(containsWorkshopReference("see [other](docs/index.md)"), false)
  assert.equal(containsWorkshopReference("plain prose without links"), false)
  assert.equal(containsWorkshopReference(""), false)
  assert.equal(containsWorkshopReference(null), false)
  assert.equal(containsWorkshopReference(undefined), false)
})

test("findMissingWorkshopReferences names entry files lacking workshop links", () => {
  const entries = [
    { path: "README.md", content: "see [workshop](docs/workshop/README.md)" },
    { path: "README.ja.md", content: "ワークショップは [こちら](docs/workshop/)" },
    { path: "docs/index.md", content: "no workshop link here" },
  ]
  assert.deepEqual(findMissingWorkshopReferences(entries, []), ["docs/index.md"])
})

test("findMissingWorkshopReferences flags all three entries when none link the workshop", () => {
  const entries = [
    { path: "README.md", content: "no link" },
    { path: "README.ja.md", content: "リンクなし" },
    { path: "docs/index.md", content: "no link" },
  ]
  assert.deepEqual(findMissingWorkshopReferences(entries, []), [
    "README.md",
    "README.ja.md",
    "docs/index.md",
  ])
})

test("findMissingWorkshopReferences flags missing entry-point files (content: null)", () => {
  const entries = [
    { path: "README.md", content: null },
    { path: "README.ja.md", content: "see [workshop](docs/workshop/)" },
  ]
  // Missing required entry-point file is a real warning signal —
  // an adopter who removes README.md needs to know the workshop
  // cross-reference is also gone.
  assert.deepEqual(findMissingWorkshopReferences(entries, []), ["README.md"])
})

test("findMissingWorkshopReferences honors allow-missing for genuinely absent files", () => {
  const entries = [
    { path: "README.md", content: null },
    { path: "README.ja.md", content: "see [workshop](docs/workshop/)" },
  ]
  // If the adopter intentionally has no README.md, allow-missing
  // suppresses the warning.
  assert.deepEqual(
    findMissingWorkshopReferences(entries, ["README.md"]),
    [],
  )
})

test("findMissingWorkshopReferences honors the allow-missing list", () => {
  const entries = [
    { path: "README.md", content: "no link" },
    { path: "README.ja.md", content: "see [workshop](docs/workshop/)" },
    { path: "docs/index.md", content: "no link" },
  ]
  assert.deepEqual(
    findMissingWorkshopReferences(entries, ["README.md", "docs/index.md"]),
    [],
  )
})

test("backLinkPatternFor escapes special regex characters in the slug", () => {
  // Slug carries real regex metacharacters so a missing escape would
  // change the match semantics. Pattern is anchored to `^/<slug>`
  // and tested against URL pathnames only.
  const pattern = backLinkPatternFor("foo.bar/repo+x")
  assert.equal(
    pattern.test("/foo.bar/repo+x/blob/main/docs/workshop/README.md"),
    true,
  )
  // A path that differs in the metacharacter positions must not
  // match (unescaped `.` would match any char and unescaped `+`
  // would require one or more `o`).
  assert.equal(
    pattern.test("/different-org/different-repo/docs/workshop/"),
    false,
  )
})

test("backLinkPatternFor rejects fork-suffixed slugs that share a prefix", () => {
  const pattern = backLinkPatternFor("kurone-kito/idd-skill")
  assert.equal(
    pattern.test("/kurone-kito/idd-skill/blob/main/docs/workshop/README.md"),
    true,
  )
  assert.equal(
    pattern.test("/kurone-kito/idd-skill-fork/blob/main/docs/workshop/README.md"),
    false,
  )
})

test("backLinkPatternFor requires the slug at the start of pathname (no host-suffix matches)", () => {
  // URL path under a different repo whose name happens to end with
  // the configured slug. The anchored regex must NOT match.
  const pattern = backLinkPatternFor("me/repo")
  assert.equal(
    pattern.test("/acme/me/repo/blob/main/docs/workshop/README.md"),
    false,
  )
  assert.equal(
    pattern.test("/me/repo/blob/main/docs/workshop/README.md"),
    true,
  )
})

test("backLinkPatternFor requires a path separator after the slug (no slug+docs concatenation)", () => {
  // Pathological case from review: pathname concatenates slug and
  // docs/workshop without an intermediate `/`. The actual repo
  // would be `kurone-kito/idd-skilldocs` which is a different
  // repository; the regex must NOT match.
  const pattern = backLinkPatternFor("kurone-kito/idd-skill")
  assert.equal(
    pattern.test("/kurone-kito/idd-skilldocs/workshop/README.md"),
    false,
  )
})

test("backLinkPatternFor requires a path boundary after docs/workshop", () => {
  const pattern = backLinkPatternFor("kurone-kito/idd-skill")
  // Valid: trailing slash, anchor, query, or end-of-string.
  assert.equal(
    pattern.test("/kurone-kito/idd-skill/blob/main/docs/workshop/"),
    true,
  )
  assert.equal(
    pattern.test("/kurone-kito/idd-skill/tree/main/docs/workshop"),
    true,
  )
  // Invalid: docs/workshops, docs/workshop-old.
  assert.equal(
    pattern.test("/kurone-kito/idd-skill/blob/main/docs/workshops/README.md"),
    false,
  )
  assert.equal(
    pattern.test("/kurone-kito/idd-skill/blob/main/docs/workshop-old/README.md"),
    false,
  )
})

test("containsExampleRepoBackLink accepts canonical blob/main link to docs/workshop", () => {
  const md = "Read the [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)."
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink accepts tree/main and deep-link with anchor", () => {
  const tree = "Tutorial: [link](https://github.com/kurone-kito/idd-skill/tree/main/docs/workshop)"
  const anchored = "More: [link](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md#prerequisites)"
  assert.equal(containsExampleRepoBackLink(tree, "kurone-kito/idd-skill"), true)
  assert.equal(containsExampleRepoBackLink(anchored, "kurone-kito/idd-skill"), true)
})

test("containsExampleRepoBackLink accepts raw.githubusercontent.com workshop links", () => {
  const md = "Reference: [raw](https://raw.githubusercontent.com/kurone-kito/idd-skill/main/docs/workshop/README.md)"
  assert.equal(containsExampleRepoBackLink(md, "kurone-kito/idd-skill"), true)
})

test("containsExampleRepoBackLink rejects when only the slug appears (no docs/workshop path)", () => {
  const md = "Built with [idd-skill](https://github.com/kurone-kito/idd-skill)."
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink rejects when only docs/workshop appears (no slug)", () => {
  const md = "See [workshop](https://github.com/other-org/other-repo/blob/main/docs/workshop/README.md)."
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink handles empty / null / undefined content", () => {
  assert.equal(containsExampleRepoBackLink("", "x/y"), false)
  assert.equal(containsExampleRepoBackLink(null, "x/y"), false)
  assert.equal(containsExampleRepoBackLink(undefined, "x/y"), false)
})

test("containsExampleRepoBackLink ignores URLs inside fenced code blocks", () => {
  const md = "```md\n[ex](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n```"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink ignores URLs inside HTML comments", () => {
  const md = "<!-- https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md -->\nplain prose"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink ignores URLs inside inline code spans", () => {
  const md = "see `https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md` for example"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink ignores URLs inside indented code blocks", () => {
  const md = "code:\n\n    https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n\nafter"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink ignores URLs inside unterminated fenced blocks", () => {
  const md = "before\n```\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink ignores URLs that appear only in query strings (e.g., redirect=...)", () => {
  const md = "Click [trap](https://example.com/?redirect=https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink preserves links inside nested-list continuation lines (not blank-separated)", () => {
  const md = "- top\n    - sub: [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink preserves links inside blank-separated nested list items", () => {
  // Loose-list shape: each list item separated by blank lines. The
  // indented continuation line is a list item (starts with `- `),
  // not a code block.
  const md = "- top\n\n    - [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink rejects URL whose host is not a GitHub host", () => {
  const md = "[trap](https://example.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink accepts raw.githubusercontent.com host", () => {
  const md = "[raw](https://raw.githubusercontent.com/kurone-kito/idd-skill/main/docs/workshop/README.md)"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink accepts enterprise host only when IDD_WORKSHOP_BACKLINK_HOSTS is set", () => {
  const md = "[enterprise](https://github.acme.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  // Without the env var, the heuristic must NOT accept arbitrary
  // hosts with "github" in the name (that was the github.evil.com
  // bypass).
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS
  try {
    delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS
    assert.equal(
      containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
      false,
    )
    process.env.IDD_WORKSHOP_BACKLINK_HOSTS = "github.acme.com"
    assert.equal(
      containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
      true,
    )
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev
  }
})

test("containsExampleRepoBackLink accepts root-relative inline link targets", () => {
  const md = "[workshop](/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink rejects URLs that appear only as image destinations", () => {
  // `![badge](...)` is an image, not a navigational link. The
  // back-link contract is about navigation, not presence of the
  // URL anywhere on the page.
  const md = "![badge](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("containsExampleRepoBackLink accepts a real navigation link even when the same URL also appears as an image", () => {
  const md = `![badge](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n\n[Read the workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)`
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink accepts root-relative reference-definition targets", () => {
  const md = "Link: [workshop][w]\n\n[w]: /kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink accepts root-relative targets with leading whitespace and angle brackets", () => {
  // CommonMark allows optional whitespace before the destination
  // inside `(   /...)` and angle-bracket-wrapped destinations
  // `(</...>)`.
  const indented = "[workshop](   /kurone-kito/idd-skill/blob/main/docs/workshop/README.md)"
  const angled = "[workshop](</kurone-kito/idd-skill/blob/main/docs/workshop/README.md>)"
  const refAngled = "[w]\n\n[w]: </kurone-kito/idd-skill/blob/main/docs/workshop/README.md>"
  assert.equal(containsExampleRepoBackLink(indented, "kurone-kito/idd-skill"), true)
  assert.equal(containsExampleRepoBackLink(angled, "kurone-kito/idd-skill"), true)
  assert.equal(containsExampleRepoBackLink(refAngled, "kurone-kito/idd-skill"), true)
})

test("isGithubBackLinkHost honors IDD_WORKSHOP_BACKLINK_HOSTS env override", () => {
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS
  try {
    process.env.IDD_WORKSHOP_BACKLINK_HOSTS = "git.internal,scm.acme"
    assert.equal(isGithubBackLinkHost("git.internal"), true)
    assert.equal(isGithubBackLinkHost("scm.acme"), true)
    assert.equal(isGithubBackLinkHost("unrelated.example"), false)
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev
  }
})

test("isGithubBackLinkHost rejects brand-prefix lookalikes like github.evil.com", () => {
  assert.equal(isGithubBackLinkHost("github.evil.com"), false)
  assert.equal(isGithubBackLinkHost("notgithub.com"), false)
  assert.equal(isGithubBackLinkHost("github.com.evil"), false)
})

test("isGithubBackLinkHost rejects unrelated github.com subdomains", () => {
  // *.github.com is too permissive (docs.github.com, api.github.com
  // do not host repositories). Restricted to the public-host
  // whitelist + explicit IDD_WORKSHOP_BACKLINK_HOSTS opt-in.
  const prev = process.env.IDD_WORKSHOP_BACKLINK_HOSTS
  try {
    delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS
    assert.equal(isGithubBackLinkHost("docs.github.com"), false)
    assert.equal(isGithubBackLinkHost("api.github.com"), false)
    assert.equal(isGithubBackLinkHost("subdomain.github.com"), false)
  } finally {
    if (prev === undefined) delete process.env.IDD_WORKSHOP_BACKLINK_HOSTS
    else process.env.IDD_WORKSHOP_BACKLINK_HOSTS = prev
  }
})

test("containsExampleRepoBackLink strips trailing sentence punctuation from URLs", () => {
  const md = "See https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md."
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("containsExampleRepoBackLink preserves ordered-list items with paren markers (1)", () => {
  const md = "1. top\n\n    1) [workshop](https://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md)\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    true,
  )
})

test("stripMarkdownNonText leaves backtick-fence-shaped lines with backtick info strings as content", () => {
  // CommonMark forbids backticks in a backtick-fence info string,
  // so a line like ``` invalid `info ``` is plain text, not a
  // fence opener. URLs that follow such a line must still be
  // scanned.
  const md = "before\n``` invalid ` info\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n"
  const stripped = stripMarkdownNonText(md)
  assert.equal(stripped.includes("github.com/kurone-kito/idd-skill"), true)
})

test("containsExampleRepoBackLink accepts CommonMark fence variations (indented opener, longer closer)", () => {
  const md = "  ```\nhttps://github.com/kurone-kito/idd-skill/blob/main/docs/workshop/README.md\n````\n"
  assert.equal(
    containsExampleRepoBackLink(md, "kurone-kito/idd-skill"),
    false,
  )
})

test("stripMarkdownNonText removes fenced, indented, span, and HTML comment regions", () => {
  const md = `before
\`\`\`
fenced
\`\`\`
inline \`code\` span
<!-- comment -->

    indented code line

after`
  const stripped = stripMarkdownNonText(md)
  assert.equal(stripped.includes("fenced"), false)
  assert.equal(stripped.includes("inline  span") || stripped.includes("inline span"), true)
  assert.equal(stripped.includes("comment"), false)
  assert.equal(stripped.includes("indented code line"), false)
  assert.equal(stripped.includes("before"), true)
  assert.equal(stripped.includes("after"), true)
})

test("decodeGithubReadmeBase64 decodes a typical GitHub content payload", () => {
  const original = "# Hello\n\nlink: https://example.com\n"
  const encoded = Buffer.from(original, "utf8").toString("base64")
  assert.equal(decodeGithubReadmeBase64(encoded), original)
  // GitHub's API returns base64 with newlines every 60 chars; the
  // decoder should tolerate that.
  const wrapped = encoded.replace(/(.{60})/g, "$1\n")
  assert.equal(decodeGithubReadmeBase64(wrapped), original)
})

test("decodeGithubReadmeBase64 returns null for empty, null, or non-base64 input", () => {
  assert.equal(decodeGithubReadmeBase64(""), null)
  assert.equal(decodeGithubReadmeBase64("   \n  "), null)
  assert.equal(decodeGithubReadmeBase64(null), null)
  assert.equal(decodeGithubReadmeBase64(undefined), null)
  assert.equal(decodeGithubReadmeBase64("not_valid_base64!!"), null)
})

test("decodeGithubReadmeBase64 rejects literal jq-null and non-multiple-of-4 lengths", () => {
  // `gh api --jq .content` prints the literal `null` when the JSON
  // path does not exist (e.g., README not found via the /readme
  // endpoint). Must not decode to garbage.
  assert.equal(decodeGithubReadmeBase64("null"), null)
  assert.equal(decodeGithubReadmeBase64("null\n"), null)
  // Base64 strings are always a multiple of 4 chars (with padding).
  assert.equal(decodeGithubReadmeBase64("abc"), null)
  assert.equal(decodeGithubReadmeBase64("abcde"), null)
})
