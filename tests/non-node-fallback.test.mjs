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

test("onboarding links extracted placeholder guidance and keeps fallback wording there", () => {
  const onboarding = readText("idd-template/ONBOARDING.md");
  assert.ok(
    onboarding.includes("docs/onboarding/placeholders.md"),
    "ONBOARDING must link to the extracted placeholder reference",
  );

  const text = readText("idd-template/docs/onboarding/placeholders.md");
  const fixValidateSection = extractSection(
    text,
    "### `{{FIX_VALIDATE_COMMANDS}}`",
    "### `{{PRE_PUSH_VALIDATE_COMMANDS}}`",
  );
  assert.match(
    fixValidateSection,
    /Node\.js without a relevant script but with `npx` available:/,
    "placeholder reference must gate fix-validate npx fallback on `npx` availability",
  );
  assert.match(
    fixValidateSection,
    /no relevant auto-fix tooling: `true`/,
    "placeholder reference must scope fix-validate no-op fallback to no-relevant-tooling cases",
  );

  const prePushSection = extractSection(
    text,
    "### `{{PRE_PUSH_VALIDATE_COMMANDS}}`",
    "### `{{POST_FIX_VALIDATE_COMMANDS}}`",
  );
  assert.match(
    prePushSection,
    /Node\.js without a relevant script but with `npx` available:/,
    "placeholder reference must gate pre-push npx fallback on `npx` availability",
  );
  assert.match(
    prePushSection,
    /no relevant verification command: `true`/,
    "placeholder reference must scope pre-push no-op fallback to no-relevant-tooling cases",
  );
});

test("onboarding links extracted policy guidance including credential scope", () => {
  const onboarding = readText("idd-template/ONBOARDING.md");
  assert.ok(
    onboarding.includes("docs/onboarding/policy-decisions.md"),
    "ONBOARDING must link to the extracted policy reference",
  );

  const policyText = readText("idd-template/docs/onboarding/policy-decisions.md");
  assert.match(
    policyText,
    /### Credential scope/,
    "policy reference must keep credential-scope guidance outside ONBOARDING",
  );
  assert.match(
    policyText,
    /Review `docs\/permissions\.md` with the operator/,
    "policy reference must point credential decisions at docs/permissions.md",
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
