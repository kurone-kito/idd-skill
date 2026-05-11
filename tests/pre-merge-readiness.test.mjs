import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPreMergeReadinessSummary } from "../scripts/protocol-helpers.mjs";
import { loadJson, validate } from "../scripts/validate-schemas.mjs";

const readinessSchema = loadJson("schemas/pre-merge-readiness.schema.json");

for (const fixtureName of [
  "clean",
  "stale-watermark",
  "unresolved-thread",
  "changes-requested",
  "unreplied-comment",
  "ci-not-ready",
  "claim-lost",
]) {
  test(`pre-merge readiness fixture: ${fixtureName}`, () => {
    const fixture = readJson(`fixtures/pre-merge-readiness/${fixtureName}.json`);
    const summary = buildPreMergeReadinessSummary(fixture.input, fixture.options);

    assert.deepEqual(summary, fixture.expected, fixtureName);
    assert.deepEqual(validate(summary, readinessSchema), []);
  });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
