import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getReviewEscalationChangesRequestedPolicy,
  parseIsoDurationToMs,
} from "../scripts/policy-helpers.mjs";

test("parseIsoDurationToMs parses supported ISO durations", () => {
  assert.equal(parseIsoDurationToMs("PT5S"), 5000);
  assert.equal(parseIsoDurationToMs("PT2H"), 2 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs("P1DT2H"), 26 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs("PT0S"), null);
  assert.equal(parseIsoDurationToMs("invalid"), null);
});

test("changes-requested escalation policy keeps 24h + 24h default windows", () => {
  assert.deepEqual(getReviewEscalationChangesRequestedPolicy({}), {
    escalateAfterMs: 24 * 60 * 60 * 1000,
    releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
  });
});

test("changes-requested escalation overrides map first/second thresholds to two windows", () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: "PT2H",
        changesRequestedSecondEscalation: "PT6H",
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 4 * 60 * 60 * 1000,
    },
  );
});

test("changes-requested escalation falls back when second threshold is invalid", () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: "PT2H",
        changesRequestedSecondEscalation: "PT1H",
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
    },
  );
});
