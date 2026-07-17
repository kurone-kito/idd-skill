#!/usr/bin/env node
// idd-generated-from: src/scripts/ci-wait-policy.mts
//
// The scripts/ci-wait-policy.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import { isCliExecution } from './gh-exec.mts';
import { loadJson, validateConfigSection } from './validate-schemas.mts';

const DEFAULT_RUNNING_TIMEOUT = 'PT30M';
const DEFAULT_GENERATION_TIMEOUT = 'PT10M';
const DEFAULT_RERUN_POLICY = 'rerun-once';
const DEFAULT_POLICY_PATH = '.github/idd/config.json';
const RERUN_POLICIES = new Set(['rerun-once', 'hold']);
const ISO_DURATION_PATTERN =
  /^P(?=\d|T\d)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');

interface CiWaitPolicy {
  runningTimeout: string;
  runningTimeoutMs: number | null;
  generationTimeout: string;
  generationTimeoutMs: number | null;
  rerunPolicy: string;
}

interface CiRerunDecision {
  action: string;
  reason: string;
  rerunPolicy: string;
  rerunCount: number;
}

export const DEFAULT_CI_WAIT_POLICY = Object.freeze({
  runningTimeout: DEFAULT_RUNNING_TIMEOUT,
  runningTimeoutMs: 30 * 60 * 1000,
  generationTimeout: DEFAULT_GENERATION_TIMEOUT,
  generationTimeoutMs: 10 * 60 * 1000,
  rerunPolicy: DEFAULT_RERUN_POLICY,
});

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `policy:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --rerun-count spec
// key below. See cli-args.mts's module header for the full invariant.
// (Deliberately not written inside matching quote marks in this comment --
// see advisory-convergence.mts's identical note for why.)
//
// Declared here, above the isCliExecution trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see #1177's entry-order TDZ hardening for the same class
// of bug in this file).
const CI_WAIT_POLICY_FLAG_SPEC = {
  '--policy': { type: 'string', default: DEFAULT_POLICY_PATH },
  '--rerun-count': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (isCliExecution(import.meta.url)) {
  runCli();
}

export function parseDurationToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = ISO_DURATION_PATTERN.exec(text);
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const seconds = Number.parseInt(match[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function normalizeCiWaitPolicy(ciWait: unknown = {}): CiWaitPolicy {
  const c = (ciWait ?? {}) as {
    runningTimeout?: unknown;
    generationTimeout?: unknown;
    rerunPolicy?: unknown;
  };
  const runningTimeout = normalizeDuration(
    c.runningTimeout,
    DEFAULT_RUNNING_TIMEOUT,
  );
  const generationTimeout = normalizeDuration(
    c.generationTimeout,
    DEFAULT_GENERATION_TIMEOUT,
  );
  const rerunPolicy = normalizeRerunPolicy(c.rerunPolicy);

  return {
    runningTimeout,
    runningTimeoutMs: parseDurationToMs(runningTimeout),
    generationTimeout,
    generationTimeoutMs: parseDurationToMs(generationTimeout),
    rerunPolicy,
  };
}

export function readCiWaitPolicy(
  policyPath: string = DEFAULT_POLICY_PATH,
): CiWaitPolicy {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), DEFAULT_POLICY_PATH);

  try {
    const config = JSON.parse(readFileSync(source, 'utf8'));
    // Scoped to the ciWait subtree (#1359): an unrelated invalid field
    // elsewhere in the document (an unknown top-level key, a typo'd enum in
    // a sibling section, ...) must not zero out an otherwise-valid ciWait
    // section.
    if (validateConfigSection(config, POLICY_SCHEMA, 'ciWait').length > 0) {
      return { ...DEFAULT_CI_WAIT_POLICY };
    }
    return normalizeCiWaitPolicy(
      (config as { ciWait?: unknown } | null)?.ciWait,
    );
  } catch {
    return { ...DEFAULT_CI_WAIT_POLICY };
  }
}

export function resolveCiRerunDecision({
  rerunPolicy = DEFAULT_RERUN_POLICY,
  rerunCount = 0,
}: {
  rerunPolicy?: unknown;
  rerunCount?: unknown;
} = {}): CiRerunDecision {
  const normalizedPolicy = normalizeRerunPolicy(rerunPolicy);
  const normalizedCount =
    typeof rerunCount === 'number' &&
    Number.isInteger(rerunCount) &&
    rerunCount > 0
      ? rerunCount
      : 0;

  if (normalizedPolicy === 'hold') {
    return {
      action: 'hold',
      reason: 'policy-hold',
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  if (normalizedCount === 0) {
    return {
      action: 'rerun',
      reason: 'rerun-budget-available',
      rerunPolicy: normalizedPolicy,
      rerunCount: normalizedCount,
    };
  }

  return {
    action: 'hold',
    reason: 'rerun-budget-exhausted',
    rerunPolicy: normalizedPolicy,
    rerunCount: normalizedCount,
  };
}

function normalizeDuration(value: unknown, fallback: string): string {
  if (parseDurationToMs(value) === null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeRerunPolicy(value: unknown): string {
  const text = String(value ?? '').trim();
  return RERUN_POLICIES.has(text) ? text : DEFAULT_RERUN_POLICY;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const policy = readCiWaitPolicy(args.policy);
  const output: { policy: CiWaitPolicy; rerunDecision?: CiRerunDecision } = {
    policy,
  };

  if (args.rerunCount !== null) {
    output.rerunDecision = resolveCiRerunDecision({
      rerunPolicy: policy.rerunPolicy,
      rerunCount: args.rerunCount,
    });
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(argv: string[]): {
  policy: string;
  rerunCount: number | null;
  help: boolean;
} {
  const { values, help } = parseCliArgs(argv, CI_WAIT_POLICY_FLAG_SPEC);
  const rerunCountToken = values['rerun-count'] as string | undefined;
  return {
    policy: values.policy as string,
    // `min: 0`: --rerun-count is a non-negative counter (0 is a valid
    // "no reruns yet" value), unlike the positive-integer contracts
    // elsewhere in this file's siblings. Throws (rather than resolving to
    // null) on violation, preserving this flag's existing fail-fast
    // contract -- see tests/ci-wait-policy.test.mts.
    rerunCount:
      rerunCountToken === undefined
        ? null
        : parseCanonicalIntegerOrThrow(rerunCountToken, '--rerun-count', 0),
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/ci-wait-policy.mjs [--policy <path>] [--rerun-count <count>]

Resolves the shared ciWait policy defaults from .github/idd/config.json.
Optionally emits the deterministic rerun decision for a current rerun count.
`);
}
