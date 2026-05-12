import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function extractSection(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `missing start heading: ${startHeading}`);
  const end = endHeading ? text.indexOf(endHeading, start) : -1;
  return text.slice(start, end === -1 ? undefined : end).trim();
}

test("discover instructions define approval-needed fallback routing", () => {
  const live = read(".github/instructions/idd-discover.instructions.md");

  assert.match(live, /approval-needed fallback bucket/i);
  assert.match(live, /skipIssueAuthorApprovalGate/);
  assert.match(live, /maintainerApprovalActorPolicy/);
  assert.match(live, /owners-and-maintainers-only/);
  assert.match(live, /all-write-permission-actors/);
  assert.match(live, /stop before A5/i);
});

test("discover approval gate section stays synced with the template mirror", () => {
  const live = extractSection(
    read(".github/instructions/idd-discover.instructions.md"),
    "## A3.5 — Apply issue-author approval gate",
    "## A4 — Gate, then pick",
  );
  const template = extractSection(
    read("idd-template/.github/instructions/idd-discover.instructions.md"),
    "## A3.5 — Apply issue-author approval gate",
    "## A4 — Gate, then pick",
  );

  assert.equal(template, live);
});

test("claim approval pre-check stays synced with the template mirror", () => {
  const live = extractSection(
    read(".github/instructions/idd-claim.instructions.md"),
    "**(a) Issue-author approval gate**",
    "**(b) Assignee and project status**",
  );
  const template = extractSection(
    read("idd-template/.github/instructions/idd-claim.instructions.md"),
    "**(a) Issue-author approval gate**",
    "**(b) Assignee and project status**",
  );

  assert.equal(template, live);
});

test("suitability instructions keep issue-author approval outside A4.5 outcomes", () => {
  const live = read(".github/instructions/idd-suitability.instructions.md");
  const template = read("idd-template/.github/instructions/idd-suitability.instructions.md");

  assert.match(live, /Issue-author approval is a separate pre-claim gate\./);
  assert.equal(template, live);
});

test("overview documents the secure default issue-author approval config behavior", () => {
  const live = read(".github/instructions/idd-overview.instructions.md");
  const template = read("idd-template/.github/instructions/idd-overview.instructions.md");
  const expected = "Absent\nvalues keep the gate enabled and default approval actors to\n`owners-and-maintainers-only`.";

  assert.match(live, /skipIssueAuthorApprovalGate/);
  assert.match(live, /maintainerApprovalActorPolicy/);
  assert.ok(live.includes(expected), "live overview is missing the secure-default note");
  assert.ok(template.includes(expected), "template overview is missing the secure-default note");
});

test("repository config keeps the issue-author approval gate enabled by default", () => {
  const config = JSON.parse(read(".github/idd/config.json"));

  assert.equal("skipIssueAuthorApprovalGate" in config, false);
});
