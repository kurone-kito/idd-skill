#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadJson, validate } from "./validate-schemas.mjs";

const DEFAULT_RUNNING_TIMEOUT = "PT30M";
const DEFAULT_GENERATION_TIMEOUT = "PT10M";
const DEFAULT_RERUN_POLICY = "rerun-once";
const DEFAULT_POLICY_PATH = ".github/idd/config.json";
const RERUN_POLICIES = new Set(["rerun-once", "hold"]);
const ISO_DURATION_PATTERN = /^P(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const POLICY_SCHEMA = loadJson("schemas/policy.schema.json");

export const DEFAULT_CI_WAIT_POLICY = Object.freeze({
  runningTimeout: DEFAULT_RUNNING_TIMEOUT,
  runningTimeoutMs: 30 * 60 * 1000,
  generationTimeout: DEFAULT_GENERATION_TIMEOUT,
  generationTimeoutMs: 10 * 60 * 1000,
  rerunPolicy: DEFAULT_RERUN_POLICY,
});

if (isCliExecution()) {
  runCli();
}

export function parseDurationToMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = ISO_DURATION_PATTERN.exec(text);
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function normalizeCiWaitPolicy(ciWait = {}) {
  const runningTimeout = normalizeDuration(ciWait?.runningTimeout, DEFAULT_RUNNING_TIMEOUT);
  const generationTimeout = normalizeDuration(ciWait?.generationTimeout, DEFAULT_GENERATION_TIMEOUT);
  const rerunPolicy = normalizeRerunPolicy(ciWait?.rerunPolicy);

  return {
    runningTimeout,
    runningTimeoutMs: parseDurationToMs(runningTimeout),
    generationTimeout,
    generationTimeoutMs: parseDurationToMs(generationTimeout),
    rerunPolicy,
  };
}

export function readCiWaitPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), DEFAULT_POLICY_PATH);

  try {
    const config = JSON.parse(readFileSync(source, "utf8"));
    if (validate(config, POLICY_SCHEMA).length > 0) {
      return { ...DEFAULT_CI_WAIT_POLICY };
    }
    return normalizeCiWaitPolicy(config?.ciWait);
  } catch {
    return { ...DEFAULT_CI_WAIT_POLICY };
  }
}

export function resolveCiRerunDecision({ rerunPolicy = DEFAULT_RERUN_POLICY, rerunCount = 0 } = {}) {
  const normalizedPolicy = normalizeRerunPolicy(rerunPolicy);
  const normalizedCount = Number.isInteger(rerunCount) && rerunCount > 0 ? rerunCount : 0;

  if (normalizedPolicy === "hold") {
    return {
      action: "hold",
      reason: "policy-hold",
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  if (normalizedCount === 0) {
    return {
      action: "rerun",
      reason: "rerun-budget-available",
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  return {
    action: "hold",
    reason: "rerun-budget-exhausted",
    rerunPolicy: normalizedPolicy,
    rerunCount: normalizedCount,
  };
}

function normalizeDuration(value, fallback) {
  if (parseDurationToMs(value) === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeRerunPolicy(value) {
  const text = String(value ?? "").trim();
  return RERUN_POLICIES.has(text) ? text : DEFAULT_RERUN_POLICY;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const policy = readCiWaitPolicy(args.policy);
  const output = { policy };

  if (args.rerunCount !== null) {
    output.rerunDecision = resolveCiRerunDecision({
      rerunPolicy: policy.rerunPolicy,
      rerunCount: args.rerunCount,
    });
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {
    policy: DEFAULT_POLICY_PATH,
    rerunCount: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`missing value for argument: ${flag}`);
      }
      return value;
    };

    if (flag === "--policy") {
      parsed.policy = requireValue();
      i += 1;
      continue;
    }
    if (flag === "--rerun-count") {
      parsed.rerunCount = Number.parseInt(String(requireValue()), 10);
      i += 1;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }

    throw new Error(`unknown argument: ${flag}`);
  }

  if (parsed.rerunCount !== null && (!Number.isInteger(parsed.rerunCount) || parsed.rerunCount < 0)) {
    throw new Error("--rerun-count must be a non-negative integer");
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/ci-wait-policy.mjs [--policy <path>] [--rerun-count <count>]

Resolves the shared ciWait policy defaults from .github/idd/config.json.
Optionally emits the deterministic rerun decision for a current rerun count.
`);
}

function isCliExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
