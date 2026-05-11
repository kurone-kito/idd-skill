import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("specificity guidance stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractSpecificitySection(canonical, canonicalFile),
    extractSpecificitySection(bundled, bundledFile),
    "canonical and bundled issue-authoring specificity guidance must stay in sync",
  );
});

test("specificity guidance keeps the three band labels and tier phrases", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractSpecificitySection(readText(file), file);

    for (const needle of [
      "## Specificity target",
      "### Three specificity bands",
      "**Under-specified**",
      "**Target**",
      "**Over-specified**",
      "frontier cloud model class",
      "middle-tier cloud model class",
      "lightweight local or compact cloud model class",
      "\"ready and stable for a middle-tier model,\" not \"maximally detailed.\"",
    ]) {
      assert.ok(
        section.includes(needle),
        `${file} must keep specificity guidance phrase: ${needle}`,
      );
    }
  }
});

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function extractSpecificitySection(text, fileLabel) {
  const startMarker = "## Specificity target";
  const endMarkers = [
    "\n## Stable readiness buckets",
    "\n## Reuse-first issue policy",
  ];

  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${fileLabel} is missing section marker: ${startMarker}`);

  const end = endMarkers
    .map((marker) => text.indexOf(marker, start))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];

  assert.notEqual(
    end,
    undefined,
    `${fileLabel} is missing an end marker for the specificity section; expected one of: ${endMarkers.join(", ")}`,
  );

  return text.slice(start, end).trim();
}
