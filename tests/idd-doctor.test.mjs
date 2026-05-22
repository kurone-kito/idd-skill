import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyBacklog,
  classifyPrimaryHead,
  computeWindowStartIso,
  extractMarkerPrefixes,
  findPlaceholders,
  parsePrimaryWorktreePath,
  parseProjectCommandRows,
} from "../scripts/idd-doctor.mjs"

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
