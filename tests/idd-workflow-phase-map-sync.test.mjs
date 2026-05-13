import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CANONICAL_DOC = "docs/idd-workflow.md";
const TEMPLATE_DOC = "idd-template/docs/idd-workflow.md";

test("IDD file map phase guidance stays synced between docs and template", () => {
  const canonicalText = readText(CANONICAL_DOC);
  const templateText = readText(TEMPLATE_DOC);

  assert.equal(
    extractTopLevelSection(canonicalText, CANONICAL_DOC, "## IDD file map"),
    extractTopLevelSection(templateText, TEMPLATE_DOC, "## IDD file map"),
  );
});

test("IDD file map keeps canonical phase-ID anchors", () => {
  for (const file of [CANONICAL_DOC, TEMPLATE_DOC]) {
    const section = extractTopLevelSection(readText(file), file, "## IDD file map");
    for (const anchor of [
      "A0-T–A4.5",
      "B1-B3 + C1-C6",
      "F2.5",
      "Resume Step 0-3",
      "Resume S1-S5",
    ]) {
      assert.ok(section.includes(anchor), `${file} must keep file-map anchor: ${anchor}`);
    }
  }
});

test("workflow onboarding guidance stays synced between docs and template", () => {
  const canonicalText = readText(CANONICAL_DOC);
  const templateText = readText(TEMPLATE_DOC);

  assert.match(
    normalizeWhitespace(canonicalText),
    /During onboarding, create or update `CLAUDE\.md`, `AGENTS\.md`, and `GEMINI\.md` so each non-Copilot agent listed above has a stable first file to read\. GitHub Copilot remains an update-if-present surface via `\.github\/copilot-instructions\.md`\. Skipping creation of a missing root entry file should be an explicit operator choice, not the default\./,
    "canonical workflow doc must keep onboarding guidance",
  );
  assert.match(
    normalizeWhitespace(templateText),
    /During onboarding, create or update `CLAUDE\.md`, `AGENTS\.md`, and `GEMINI\.md` so each non-Copilot agent listed above has a stable first file to read\. GitHub Copilot remains an update-if-present surface via `\.github\/copilot-instructions\.md`\. Skipping creation of a missing root entry file should be an explicit operator choice, not the default\./,
    "template workflow doc must keep onboarding guidance",
  );
  assert.equal(
    canonicalText.includes("helper-backed evidence collectors first"),
    templateText.includes("helper-backed evidence collectors first"),
  );
});

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function extractTopLevelSection(text, fileLabel, startMarker) {
  const nextSectionMarker = "\n## ";
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${fileLabel} is missing section marker: ${startMarker}`);
  const nextSectionStart = text.indexOf(nextSectionMarker, start + startMarker.length);
  const end = nextSectionStart === -1 ? text.length : nextSectionStart;
  return text.slice(start, end).trim();
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
