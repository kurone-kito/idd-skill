import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_CI_WAIT_POLICY,
  normalizeCiWaitPolicy,
  parseDurationToMs,
  readCiWaitPolicy,
  resolveCiRerunDecision,
} from "../scripts/ci-wait-policy.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("parseDurationToMs parses CI wait durations", () => {
  assert.equal(parseDurationToMs("PT30M"), 30 * 60 * 1000);
  assert.equal(parseDurationToMs("PT10M"), 10 * 60 * 1000);
  assert.equal(parseDurationToMs("PT1H15M"), 75 * 60 * 1000);
  assert.equal(parseDurationToMs("invalid"), null);
});

test("normalizeCiWaitPolicy preserves distributed defaults when keys are omitted", () => {
  assert.deepEqual(normalizeCiWaitPolicy(), { ...DEFAULT_CI_WAIT_POLICY });
});

test("normalizeCiWaitPolicy accepts explicit ciWait overrides", () => {
  assert.deepEqual(normalizeCiWaitPolicy({
    runningTimeout: "PT45M",
    generationTimeout: "PT12M",
    rerunPolicy: "hold",
  }), {
    runningTimeout: "PT45M",
    runningTimeoutMs: 45 * 60 * 1000,
    generationTimeout: "PT12M",
    generationTimeoutMs: 12 * 60 * 1000,
    rerunPolicy: "hold",
  });
});

test("normalizeCiWaitPolicy falls back when override values are invalid", () => {
  assert.deepEqual(normalizeCiWaitPolicy({
    runningTimeout: "45 minutes",
    generationTimeout: "soon",
    rerunPolicy: "rerun-forever",
  }), { ...DEFAULT_CI_WAIT_POLICY });
});

test("resolveCiRerunDecision allows only one automatic rerun by default", () => {
  assert.deepEqual(resolveCiRerunDecision({ rerunPolicy: "rerun-once", rerunCount: 0 }), {
    action: "rerun",
    reason: "rerun-budget-available",
    rerunPolicy: "rerun-once",
    rerunCount: 0,
  });

  assert.deepEqual(resolveCiRerunDecision({ rerunPolicy: "rerun-once", rerunCount: 1 }), {
    action: "hold",
    reason: "rerun-budget-exhausted",
    rerunPolicy: "rerun-once",
    rerunCount: 1,
  });
});

test("resolveCiRerunDecision honors hold policy", () => {
  assert.deepEqual(resolveCiRerunDecision({ rerunPolicy: "hold", rerunCount: 0 }), {
    action: "hold",
    reason: "policy-hold",
    rerunPolicy: "hold",
    rerunCount: 0,
  });
});

test("readCiWaitPolicy reads nested ciWait config and CLI emits the same resolution", (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "idd-ci-wait-policy-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const configPath = join(sandbox, ".github", "idd", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      ciWait: {
        runningTimeout: "PT40M",
        generationTimeout: "PT15M",
        rerunPolicy: "hold",
      },
    }, null, 2)}\n`,
  );

  assert.deepEqual(readCiWaitPolicy(configPath), {
    runningTimeout: "PT40M",
    runningTimeoutMs: 40 * 60 * 1000,
    generationTimeout: "PT15M",
    generationTimeoutMs: 15 * 60 * 1000,
    rerunPolicy: "hold",
  });

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/ci-wait-policy.mjs"), "--policy", configPath, "--rerun-count", "0"],
      { encoding: "utf8" },
    ),
  );

  assert.deepEqual(output, {
    policy: {
      runningTimeout: "PT40M",
      runningTimeoutMs: 40 * 60 * 1000,
      generationTimeout: "PT15M",
      generationTimeoutMs: 15 * 60 * 1000,
      rerunPolicy: "hold",
    },
    rerunDecision: {
      action: "hold",
      reason: "policy-hold",
      rerunPolicy: "hold",
      rerunCount: 0,
    },
  });
});
