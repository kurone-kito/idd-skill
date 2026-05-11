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
    assert.ok(
      text.includes(
        "(2) use bare `npx <tool>` when\n  `npx` is available; (3) replace with `true` when `npx` is unavailable",
      ),
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

  const npxScopedMatches = text.match(
    /Node\.js \(no relevant project script, `npx` available\):/g,
  );
  assert.ok(
    (npxScopedMatches?.length ?? 0) >= 2,
    "ONBOARDING must gate npx fallback on `npx` availability in both command sections",
  );

  const noOpScopedMatches = text.match(
    /No Node\.js and no other relevant tooling: `true` \(no-op\)/g,
  );
  assert.ok(
    (noOpScopedMatches?.length ?? 0) >= 2,
    "ONBOARDING must scope no-op fallback to cases with no relevant tooling path",
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
