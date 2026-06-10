import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { collectRootMarkdownAllowlistViolations } from "../scripts/consistency-helpers.mjs";

const MANIFEST_URL = new URL("../audit/sync-manifest.json", import.meta.url);

const CONFIG = {
  id: "root-markdown-allowlist",
  allowed: ["README.md", "CHANGELOG.md"],
};

test("a stray root-level session file fails with a clear message", () => {
  const violations = collectRootMarkdownAllowlistViolations(
    ["README.md", "SESSION-NOTES.md", "scripts/audit-docs.mjs"],
    CONFIG,
  );

  assert.deepEqual(violations, [
    "root-markdown-allowlist: SESSION-NOTES.md is not an allowed root-level Markdown file; record session evidence in issue comments instead, or add an intentional root document to rootMarkdownAllowlist in audit/sync-manifest.json",
  ]);
});

test("allowlisted root files and nested markdown pass", () => {
  const violations = collectRootMarkdownAllowlistViolations(
    [
      "README.md",
      "CHANGELOG.md",
      "docs/SESSION-NOTES.md",
      "idd-template/ONBOARDING.md",
    ],
    CONFIG,
  );

  assert.deepEqual(violations, []);
});

test("an uppercase extension cannot bypass the guard", () => {
  const violations = collectRootMarkdownAllowlistViolations(
    ["SESSION-NOTES.MD"],
    CONFIG,
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /SESSION-NOTES\.MD/);
});

test("allowlist name comparison stays exact", () => {
  const violations = collectRootMarkdownAllowlistViolations(
    ["readme.md"],
    CONFIG,
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0], /readme\.md/);
});

test("a missing manifest section disables the check", () => {
  assert.deepEqual(
    collectRootMarkdownAllowlistViolations(["STRAY.md"], null),
    [],
  );
});

test("a non-array allowed value fails cleanly instead of throwing", () => {
  for (const allowed of [42, {}, "README.md"]) {
    const violations = collectRootMarkdownAllowlistViolations(
      ["README.md"],
      { id: "root-markdown-allowlist", allowed },
    );

    assert.deepEqual(violations, [
      "root-markdown-allowlist: allowed must be an array of root Markdown file names",
    ]);
  }
});

test("the real manifest allowlists exactly the intentional root documents", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
  const allowed = manifest.rootMarkdownAllowlist?.allowed ?? [];

  assert.ok(allowed.includes("CHANGELOG.md"));
  assert.deepEqual([...allowed].sort(), [
    "AGENTS.md",
    "CHANGELOG.md",
    "CLAUDE.md",
    "GEMINI.md",
    "README.ja.md",
    "README.md",
    "SECURITY.md",
  ]);
});
