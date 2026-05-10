import assert from "node:assert/strict"
import { test } from "node:test"

import {
  extractMarkerPrefixes,
  findPlaceholders,
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
