import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("specificity guidance stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractTopLevelSection(canonical, canonicalFile, "## Specificity target"),
    extractTopLevelSection(bundled, bundledFile, "## Specificity target"),
    `canonical and bundled issue-authoring specificity guidance must stay in sync (${canonicalFile} vs ${bundledFile})`,
  );
});

test("specificity guidance keeps the three band labels and tier phrases", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      "## Specificity target",
    );

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

test("dependency minimization guidance stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractTopLevelSection(
      canonical,
      canonicalFile,
      "## Dependency minimization",
    ),
    extractTopLevelSection(
      bundled,
      bundledFile,
      "## Dependency minimization",
    ),
    `canonical and bundled dependency minimization guidance must stay in sync (${canonicalFile} vs ${bundledFile})`,
  );
});

test("dependency minimization guidance keeps the edge-justification rules", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      "## Dependency minimization",
    );
    const normalizedSection = normalizeWhitespace(section);

    for (const needle of [
      "true correctness, availability, or ordering constraint",
      "roadmap task-list entries",
      "artificial serial chain",
      "artificial sibling issues only to widen parallel execution",
      "justify each dependency edge",
      "natural cohesion",
    ]) {
      assert.ok(
        normalizedSection.includes(normalizeWhitespace(needle)),
        `${file} must keep dependency-minimization phrase: ${needle}`,
      );
    }
  }
});

test("draft patterns keep the dependency minimization examples", () => {
  const file = "skills/issue-authoring/references/draft-patterns.md";
  const text = readText(file);

  for (const needle of [
    "## Dependency minimization examples",
    "### Natural parallel decomposition",
    "### Artificial decomposition",
    "Bad serial chain:",
    "Bad split for parallelism:",
  ]) {
    assert.ok(text.includes(needle), `${file} must keep example anchor: ${needle}`);
  }
});

test("child issue validation keeps verification and dependency-marker guidance", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const text = readText(file);

    for (const needle of [
      "acceptance criteria are locally verifiable",
      "any dependency marker is resolvable, intentionally chosen, and",
      "the issue can be claimed independently without absorbing sibling work",
    ]) {
      assert.ok(text.includes(needle), `${file} must keep child validation phrase: ${needle}`);
    }
  }
});

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function extractTopLevelSection(text, fileLabel, startMarker) {
  const nextSectionMarker = "\n## ";

  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${fileLabel} is missing section marker: ${startMarker}`);

  // If the section is last in the file, compare through EOF instead of
  // coupling the test to a specific following heading.
  const nextSectionStart = text.indexOf(nextSectionMarker, start + startMarker.length);
  const end = nextSectionStart === -1 ? text.length : nextSectionStart;

  return text.slice(start, end).trim();
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
