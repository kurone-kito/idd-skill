import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("customization docs keep npx fallback wording aligned", () => {
  for (const file of ["docs/customization.md", "idd-template/docs/customization.md"]) {
    const text = readText(file);
    assert.ok(
      text.includes(
        "2. `npx` when available; 3. `true` when unavailable or not relevant",
      ),
      `${file} must keep the fallback matrix aligned with npx-availability wording`,
    );
    assert.match(
      normalizeWhitespace(text),
      /\(2\) use bare `npx <tool>` when `npx` is available; \(3\) replace with `true` when `npx` is unavailable or the check is not relevant to the project\./,
      `${file} must keep detailed fallback guidance aligned with matrix wording`,
    );
    assert.ok(
      text.includes("or the check is not relevant to the project."),
      `${file} must keep the 'not relevant' branch in detailed fallback guidance`,
    );
    assert.ok(
      !text.includes("`npx` if Node.js is present"),
      `${file} must not regress to Node.js-only detection for npx fallback`,
    );
  }
});

test("onboarding keeps non-node fallback scoped to no relevant tooling", () => {
  const text = readText("idd-template/ONBOARDING.md");
  const fixValidateSection = extractSection(
    text,
    "- **Fix-validate commands**",
    "- **Pre-push-validate commands**",
  );
  assert.match(
    fixValidateSection,
    /Node\.js \(no relevant project script, `npx` available\):/,
    "ONBOARDING fix-validate section must gate npx fallback on `npx` availability",
  );
  assert.match(
    fixValidateSection,
    /No Node\.js and no other relevant tooling: `true` \(no-op\)/,
    "ONBOARDING fix-validate section must scope no-op fallback to no-relevant-tooling cases",
  );

  const prePushSection = extractSection(
    text,
    "- **Pre-push-validate commands**",
    "- **Post-fix-validate commands**",
  );
  assert.match(
    prePushSection,
    /Node\.js \(no relevant project script, `npx` available\):/,
    "ONBOARDING pre-push section must gate npx fallback on `npx` availability",
  );
  assert.match(
    prePushSection,
    /No Node\.js and no other relevant tooling: `true` \(no-op\)/,
    "ONBOARDING pre-push section must scope no-op fallback to no-relevant-tooling cases",
  );
});

test("overview instructions document the npx-availability gate", () => {
  const live = readText(".github/instructions/idd-overview.instructions.md");
  const template = readText("idd-template/.github/instructions/idd-overview.instructions.md");

  assert.ok(
    live.includes("`npx <tool>` only when `npx` is available"),
    "live overview must keep the npx-availability gate for Node.js fallback",
  );
  assert.ok(
    template.includes("`npx <tool>` if Node.js and `npx` are available"),
    "template overview must keep the npx-availability gate for Node.js fallback",
  );
});

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing section marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing section marker: ${endMarker}`);
  return text.slice(start, end);
}
