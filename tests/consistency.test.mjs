import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import { collectPolicyConfigDrift, inspectHelperRuntimeConfig } from "../scripts/consistency-helpers.mjs";
import { findPlaceholders } from "../scripts/idd-doctor.mjs";

const FIXTURE_ROOT = new URL("./fixtures/", import.meta.url);
const SUITABILITY_PATH = new URL("../.github/instructions/idd-suitability.instructions.md", import.meta.url);

test("placeholder scenarios detect clean and dirty post-onboarding fixtures", () => {
  const clean = collectPlaceholderHits(new URL("./fixtures/consistency/placeholders/clean", import.meta.url));
  const dirty = collectPlaceholderHits(new URL("./fixtures/consistency/placeholders/dirty", import.meta.url));

  assert.deepEqual(clean, []);
  assert.deepEqual(dirty, [
    ".github/idd/config.json: {{PROJECT_MARKER_PREFIX}}",
    "README.md: {{REPO_NAME}}",
  ]);
});

test("config drift scenarios detect mismatches between config and overview defaults", () => {
  const overview = readText("consistency/config/overview.txt");
  const missingRowOverview = readText("consistency/config/overview-missing-policy-row.txt");
  const aligned = readJson("consistency/config/aligned-config.json");
  const drifted = readJson("consistency/config/drifted-config.json");

  assert.deepEqual(collectPolicyConfigDrift(aligned, overview), []);
  assert.deepEqual(collectPolicyConfigDrift(drifted, overview), [
    {
      path: "commands.fix-validate",
      expected: "npm run fix",
      actual: "npm run fix && npm test",
    },
    {
      path: "issueScope",
      expected: "roadmap",
      actual: "orphan-first",
    },
  ]);
  assert.deepEqual(collectPolicyConfigDrift(aligned, missingRowOverview), [
    {
      path: "orphanFirstPolicy",
      expected: null,
      actual: null,
      reason: "missing instruction row orphan-first-policy",
    },
  ]);
});

test("helper runtime inspection accepts absent and supported profiles, rejects unsupported values", () => {
  assert.deepEqual(inspectHelperRuntimeConfig({}), {
    status: "absent",
  });
  assert.deepEqual(inspectHelperRuntimeConfig({
    helperRuntime: {
      profile: "instructions-only",
    },
  }), {
    status: "ok",
    profile: "instructions-only",
  });
  assert.deepEqual(inspectHelperRuntimeConfig({
    helperRuntime: {
      profile: "package-manager",
    },
  }), {
    status: "ok",
    profile: "package-manager",
  });
  assert.deepEqual(inspectHelperRuntimeConfig({
    helperRuntime: {
      profile: "bun",
    },
  }), {
    status: "invalid",
    reason: 'unsupported helperRuntime.profile "bun"',
  });
});

test("A4.5 outcome fixtures match the documented check-to-outcome mapping", () => {
  const text = readFileSync(SUITABILITY_PATH, "utf8");
  const checks = extractCheckOutcomes(text);
  const outcomes = extractOutcomeTable(text);
  const cases = readJson("consistency/a45-outcomes.json");

  for (const fixture of cases) {
    assert.equal(checks.get(fixture.failedCheck), fixture.expectedOutcome, fixture.id);
    assert.ok(outcomes.has(fixture.expectedOutcome), fixture.expectedOutcome);
  }

  assert.deepEqual(
    [...new Set(cases.map((fixture) => fixture.expectedOutcome))].sort(),
    ["blocked-by-human", "duplicate", "invalid", "needs-decision", "out-of-scope", "unclear"],
  );
  assert.match(outcomes.get("invalid"), /do not retry/i);
});

function collectPlaceholderHits(url) {
  const root = fileURLToPath(url);
  const hits = [];

  walk(root, (fullPath) => {
    const placeholders = [...new Set(findPlaceholders(readFileSync(fullPath, "utf8")))];
    if (placeholders.length === 0) {
      return;
    }
    const relativePath = relative(root, fullPath).replaceAll("\\", "/");
    hits.push(`${relativePath}: ${placeholders.join(", ")}`);
  });

  return hits.sort();
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, visit);
      continue;
    }
    visit(fullPath);
  }
}

function extractCheckOutcomes(text) {
  const entries = [...text.matchAll(
    /^### Check \d+: ([^\n]+)\n[\s\S]*?^- \*\*Outcome on fail\*\*: `([^`]+)`$/gm,
  )];
  return new Map(entries.map(([, heading, outcome]) => [heading.trim(), outcome]));
}

function extractOutcomeTable(text) {
  const sectionMatch = text.match(/## Failure Outcomes[\s\S]*?\n\| Outcome[\s\S]*?\n((?:\|[^\n]+\n)+)/);
  const rows = (sectionMatch?.[1] ?? "")
    .split(/\r?\n/)
    .filter((row) => row.startsWith("| `"));
  return new Map(rows.map((row) => {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return [cells[0].replaceAll("`", ""), cells[2]];
  }));
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(new URL(relativePath, FIXTURE_ROOT), "utf8");
}
