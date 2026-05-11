import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveActiveClaim } from "../scripts/protocol-helpers.mjs";

const fixtures = {
  staleTakeover: readJson("fixtures/claim-lifecycle/stale-takeover.json"),
  sameSecondTieBreak: readJson("fixtures/claim-lifecycle/same-second-tie-break.json"),
};

test("golden scenario: stale takeover keeps the newer active claim", () => {
  const active = resolveActiveClaim(fixtures.staleTakeover.events);
  assert.deepEqual(active, fixtures.staleTakeover.expectedActiveClaim);
});

test("golden scenario: same-second competing claims use deterministic tie-break", () => {
  const active = resolveActiveClaim(fixtures.sameSecondTieBreak.events);
  assert.deepEqual(active, fixtures.sameSecondTieBreak.expectedActiveClaim);
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
