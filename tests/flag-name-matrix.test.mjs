import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const scriptFiles = readdirSync(scriptsDir).filter((file) => file.endsWith(".mjs"));

function readScript(name) {
  return readFileSync(join(scriptsDir, name), "utf8");
}

// One canonical CLI flag name per shared concept. Helpers may keep the prior
// name as a deprecated alias for one release, but the canonical flag must
// always be accepted wherever the concept is, so a working invocation copied
// from one phase keeps working in the next.
const FLAG_CONCEPTS = [
  { concept: "claim id", canonical: "--claim-id", deprecated: "--expected-claim-id" },
  { concept: "agent id", canonical: "--agent-id", deprecated: "--expected-agent-id" },
];

for (const { concept, canonical, deprecated } of FLAG_CONCEPTS) {
  test(`every helper accepting a ${concept} flag accepts the canonical ${canonical}`, () => {
    for (const file of scriptFiles) {
      const src = readScript(file);
      if (src.includes(`"${deprecated}"`)) {
        assert.ok(
          src.includes(`"${canonical}"`),
          `${file} accepts ${deprecated} but not the canonical ${canonical}`,
        );
      }
    }
  });

  test(`${deprecated} is only a deprecated alias that warns`, () => {
    for (const file of scriptFiles) {
      const src = readScript(file);
      if (src.includes(`"${deprecated}"`)) {
        assert.ok(
          src.includes("is deprecated") || src.includes("warnDeprecatedFlag"),
          `${file} accepts the deprecated ${deprecated} without emitting a deprecation warning`,
        );
      }
    }
  });
}

test("pre-merge-readiness accepts both canonical claim/agent flags", () => {
  const src = readScript("pre-merge-readiness.mjs");
  for (const flag of ["--claim-id", "--agent-id", "--expected-claim-id", "--expected-agent-id"]) {
    assert.ok(src.includes(`"${flag}"`), `pre-merge-readiness.mjs should accept ${flag}`);
  }
});
