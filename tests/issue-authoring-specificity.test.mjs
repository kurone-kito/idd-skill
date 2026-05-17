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

test("nested roadmap guidance stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractTopLevelSection(canonical, canonicalFile, "## Nested roadmap nodes"),
    extractTopLevelSection(bundled, bundledFile, "## Nested roadmap nodes"),
    `canonical and bundled nested-roadmap guidance must stay in sync (${canonicalFile} vs ${bundledFile})`,
  );
});

test("nested roadmap guidance keeps coordination-node rules", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      "## Nested roadmap nodes",
    );
    const normalizedSection = normalizeWhitespace(section);

    for (const needle of [
      "coordination boundary, active child list, or multi-session handoff",
      "roadmap node, not a normal execution candidate",
      "parent roadmap task list",
      "links the active child work it coordinates",
      "normal A3/A4/A5 execution work",
      "true execution dependencies or sequential roadmap dependencies",
      "closed intermediate roadmaps with hidden open descendants",
    ]) {
      assert.ok(
        normalizedSection.includes(normalizeWhitespace(needle)),
        `${file} must keep nested-roadmap phrase: ${needle}`,
      );
    }
  }
});

test("human-dependency isolation guidance stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractTopLevelSection(
      canonical,
      canonicalFile,
      "## Human-dependency isolation",
    ),
    extractTopLevelSection(
      bundled,
      bundledFile,
      "## Human-dependency isolation",
    ),
    `canonical and bundled human-dependency isolation guidance must stay in sync (${canonicalFile} vs ${bundledFile})`,
  );
});

test("human-dependency isolation guidance keeps the front-load and back-load rules", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      "## Human-dependency isolation",
    );
    const normalizedSection = normalizeWhitespace(section);

    for (const needle of [
      "Treat unresolved human dependency as a side effect",
      "**Front-load** human-dependent work",
      "**Back-load** human-dependent work",
      "maintainer-only action",
      "unavailable system becomes usable again",
      "Route unresolved choices to `needs-decision`",
      "`blocked-by-human`",
      "`deferred`",
      "approval-needed hold",
      "it is not yet `ready`",
      "protect autonomous completion and clear verification",
    ]) {
      assert.ok(
        normalizedSection.includes(normalizeWhitespace(needle)),
        `${file} must keep human-dependency-isolation phrase: ${needle}`,
      );
    }
  }
});

test("hidden human-dependency validation stays synced between canonical and bundled contract", () => {
  const canonicalFile = "docs/issue-authoring-skill.md";
  const bundledFile = "skills/issue-authoring/references/contract.md";
  const canonical = readText(canonicalFile);
  const bundled = readText(bundledFile);

  assert.equal(
    extractTopLevelSection(
      canonical,
      canonicalFile,
      "## Hidden human-dependency validation",
    ),
    extractTopLevelSection(
      bundled,
      bundledFile,
      "## Hidden human-dependency validation",
    ),
    `canonical and bundled hidden-human-dependency validation must stay in sync (${canonicalFile} vs ${bundledFile})`,
  );
});

test("hidden human-dependency validation keeps the pre-publication routing checks", () => {
  for (const file of [
    "docs/issue-authoring-skill.md",
    "skills/issue-authoring/references/contract.md",
  ]) {
    const section = extractTopLevelSection(
      readText(file),
      file,
      "## Hidden human-dependency validation",
    );
    const normalizedSection = normalizeWhitespace(section);

    for (const needle of [
      "routing aid, not a rigid wording linter",
      "credentials, external access, hardware, or infrastructure",
      "`blocked-by-human`",
      "product, policy, or design decision",
      "`needs-decision`",
      "subjective human approval",
      "objective verification",
      "optional review or publication judgment",
      "roadmap narrative",
      "approval-needed hold",
      "dependency marker",
      "true start blockers",
      "post-implementation code review, merge approval, or publication choice",
    ]) {
      assert.ok(
        normalizedSection.includes(normalizeWhitespace(needle)),
        `${file} must keep hidden-human-dependency phrase: ${needle}`,
      );
    }
  }
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

test("draft patterns keep the hidden human-dependency quick check", () => {
  const file = "skills/issue-authoring/references/draft-patterns.md";
  const text = readText(file);
  const normalizedText = normalizeWhitespace(text);

  for (const needle of [
    "## Hidden human-dependency quick check",
    "unresolved credentials, access, or unavailable infrastructure",
    "`needs-decision`",
    "objective verification",
    "optional post-implementation review stays optional",
    "approval-needed hold",
    "true start blockers rather than grouping related work",
    "subjective approval",
    "grouping-only dependency markers",
  ]) {
    assert.ok(
      normalizedText.includes(normalizeWhitespace(needle)),
      `${file} must keep hidden human-dependency phrase: ${needle}`,
    );
  }
});

test("draft patterns keep the dependency minimization examples", () => {
  const file = "skills/issue-authoring/references/draft-patterns.md";
  const text = readText(file);
  const normalizedText = normalizeWhitespace(text);

  for (const needle of [
    "## Nested roadmap chooser note",
    "Parent roadmap `## Tracks` excerpt:",
    "Nested roadmap `#510` `## Tracks` excerpt:",
    "coordination/audit node",
    "normal execution issue",
    "## Dependency minimization examples",
    "### Natural parallel decomposition",
    "### Artificial decomposition",
    "Bad serial chain:",
    "Bad split for parallelism:",
  ]) {
    assert.ok(
      normalizedText.includes(normalizeWhitespace(needle)),
      `${file} must keep example anchor: ${needle}`,
    );
  }
});

test("canonical validation checklist keeps nested-roadmap link rules", () => {
  const file = "docs/issue-authoring-skill.md";
  const text = readText(file);
  const normalizedText = normalizeWhitespace(text);

  for (const needle of [
    "each nested roadmap node is linked from the parent roadmap task list and links its own active child work",
    "each nested roadmap remains identifiable as a coordination/audit node instead of a normal execution candidate",
    "used only for true sequential dependencies, never to group nested roadmap children",
  ]) {
    assert.ok(
      normalizedText.includes(normalizeWhitespace(needle)),
      `${file} must keep validation-checklist phrase: ${needle}`,
    );
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
