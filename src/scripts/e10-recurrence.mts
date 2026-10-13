#!/usr/bin/env node
// idd-generated-from: src/scripts/e10-recurrence.mts
//
// The scripts/e10-recurrence.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
//
// Read-only E10 same-family recurrence counter (issue #4129). Before it, the
// E10 no-progress hold in idd-review-fix.instructions.md was decided by
// judgement: in session d578901e (PR #3851) eleven review-loop questions asked
// a human whether recurring findings should stop the loop, and three more
// followed on PR #4082 and PR #4092 after the per-issue pass cap landed. This
// helper counts the recurrence from the fingerprint fields (`file`, `rule`,
// `construct`) that the triage disposition record carries, so a recurring
// family stops by rule. It never writes, claims, or posts.

import { readFileSync } from 'node:fs';
import { parseCanonicalIntegerOrThrow, parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import { normalizePolicyConfig } from './policy-helpers.mts';

// Declared above the import.meta.main trigger below, for the same
// temporal-dead-zone reason documented in idd-critique-delegate.mts.
const E10_RECURRENCE_FLAG_SPEC = {
  '--passes': { type: 'string' },
  '--hold-after': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/**
 * The closed `rule` list for a finding fingerprint. The triage instruction
 * (`idd-review-triage.instructions.md`, E5) carries the same list, and a test
 * pins the two together.
 */
export const E10_FINGERPRINT_RULES = [
  'correctness',
  'safety',
  'tests',
  'docs',
  'consistency',
  'style',
] as const;

export type E10FingerprintRule = (typeof E10_FINGERPRINT_RULES)[number];

const SEVERITIES = ['low', 'medium', 'high'] as const;
type Severity = (typeof SEVERITIES)[number];

// The instructions write E4 tiers capitalized (High, Medium, Low), so the
// helper accepts any letter case and compares the lowercase form.
function normalizeSeverity(value: unknown): Severity | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return (SEVERITIES as readonly string[]).includes(lower)
    ? (lower as Severity)
    : null;
}
const DISPOSITIONS = ['Accepted', 'Rejected'] as const;

export interface E10RecurringFamily {
  file: string;
  rule: E10FingerprintRule;
  construct: string;
  severity: Severity;
  disposition: 'defer' | 'stop';
}

export type E10RecurrenceVerdict = 'e11' | 'continue' | 'defer' | 'hold';

export interface E10RecurrenceReport {
  verdict: E10RecurrenceVerdict;
  passCount: number;
  chainLength: number;
  holdAfter: number;
  recurring: E10RecurringFamily[];
  holdText: string | null;
}

interface AcceptedFinding {
  file: string;
  rule: E10FingerprintRule;
  construct: string;
  severity: Severity;
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('e10-recurrence', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate one disposition record. A Rejected record needs only its
 * `disposition`; an Accepted record also needs a non-empty `file` and
 * `construct`, a `rule` from {@link E10_FINGERPRINT_RULES}, and a `severity`.
 * Returns the error messages, empty when the record is valid.
 */
export function validateDispositionRecord(
  record: unknown,
  where = 'record',
): string[] {
  if (!isPlainObject(record)) return [`${where}: must be a JSON object`];
  const disposition = record.disposition;
  if (!(DISPOSITIONS as readonly unknown[]).includes(disposition)) {
    return [`${where}: disposition must be one of ${DISPOSITIONS.join(', ')}`];
  }
  if (disposition === 'Rejected') return [];
  const errors: string[] = [];
  if (!isNonEmptyString(record.file)) {
    errors.push(`${where}: file must be a non-empty string`);
  }
  if (!isNonEmptyString(record.construct)) {
    errors.push(`${where}: construct must be a non-empty string`);
  }
  if (!(E10_FINGERPRINT_RULES as readonly unknown[]).includes(record.rule)) {
    errors.push(
      `${where}: rule ${JSON.stringify(record.rule)} is not in the closed list (${E10_FINGERPRINT_RULES.join(', ')})`,
    );
  }
  if (normalizeSeverity(record.severity) === null) {
    errors.push(
      `${where}: severity must be one of ${SEVERITIES.join(', ')} (any letter case)`,
    );
  }
  return errors;
}

/** Validate every record of every pass; returns all error messages. */
export function validatePasses(passes: unknown): string[] {
  if (!Array.isArray(passes)) return ['passes: must be an array of passes'];
  // An empty file would otherwise read as a clean pass and route to E11.
  if (passes.length === 0) return ['passes: must contain at least one pass'];
  const errors: string[] = [];
  passes.forEach((pass, passIndex) => {
    if (!Array.isArray(pass)) {
      errors.push(`passes[${passIndex}]: must be an array of records`);
      return;
    }
    pass.forEach((record, recordIndex) => {
      errors.push(
        ...validateDispositionRecord(
          record,
          `passes[${passIndex}][${recordIndex}]`,
        ),
      );
    });
  });
  return errors;
}

function fingerprintKey(finding: AcceptedFinding): string {
  return JSON.stringify([finding.file, finding.rule, finding.construct]);
}

// A stray space in a hand-written record must not split one family in two.
function trimmedFinding(finding: AcceptedFinding): AcceptedFinding {
  return {
    file: finding.file.trim(),
    rule: finding.rule,
    construct: finding.construct.trim(),
    severity: normalizeSeverity(finding.severity) ?? finding.severity,
  };
}

function acceptedFindings(
  pass: readonly unknown[],
): Map<string, AcceptedFinding> {
  const findings = new Map<string, AcceptedFinding>();
  for (const record of pass) {
    if (!isPlainObject(record) || record.disposition !== 'Accepted') continue;
    const finding = trimmedFinding(record as unknown as AcceptedFinding);
    const key = fingerprintKey(finding);
    const prior = findings.get(key);
    if (prior === undefined || rank(finding.severity) > rank(prior.severity)) {
      findings.set(key, finding);
    }
  }
  return findings;
}

function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function isSubset(
  inner: ReadonlyMap<string, unknown>,
  outer: ReadonlyMap<string, unknown>,
): boolean {
  for (const key of inner.keys()) if (!outer.has(key)) return false;
  return true;
}

/**
 * Compute the E10 recurrence verdict for the latest pass. `passes` is
 * ordered oldest first and must already pass {@link validatePasses}.
 *
 * - The latest pass has no Accepted finding: `e11`.
 * - Otherwise the chain length is 1 plus the number of consecutive earlier
 *   passes whose next pass's non-empty Accepted fingerprint set is a subset
 *   (proper or equal) of theirs. The chain counts its first pass, so with
 *   `holdAfter` 3 the third pass of a chain reaches the threshold.
 * - Below `holdAfter`: `continue`.
 * - At or above it, each fingerprint of the latest pass is a recurring
 *   family with the highest severity seen across the chain: Low takes
 *   `defer`, Medium or High takes `stop`. Any `stop` makes the verdict
 *   `hold`; otherwise it is `defer`.
 */
export function computeE10Recurrence(
  passes: readonly (readonly unknown[])[],
  holdAfter: number,
): E10RecurrenceReport {
  const sets = passes.map((pass) => acceptedFindings(pass));
  const base = {
    passCount: passes.length,
    holdAfter,
  };
  const latest = sets.at(-1);
  if (latest === undefined || latest.size === 0) {
    return {
      verdict: 'e11',
      ...base,
      chainLength: 0,
      recurring: [],
      holdText: null,
    };
  }
  let start = sets.length - 1;
  while (start > 0) {
    const current = sets[start];
    const prior = sets[start - 1];
    if (
      current === undefined ||
      prior === undefined ||
      current.size === 0 ||
      !isSubset(current, prior)
    ) {
      break;
    }
    start -= 1;
  }
  const chainLength = sets.length - start;
  if (chainLength < holdAfter) {
    return {
      verdict: 'continue',
      ...base,
      chainLength,
      recurring: [],
      holdText: null,
    };
  }
  const chain = sets.slice(start);
  const recurring: E10RecurringFamily[] = [...latest.entries()].map(
    ([key, finding]) => {
      let severity = finding.severity;
      for (const set of chain) {
        const seen = set.get(key);
        if (seen !== undefined && rank(seen.severity) > rank(severity)) {
          severity = seen.severity;
        }
      }
      return {
        file: finding.file,
        rule: finding.rule,
        construct: finding.construct,
        severity,
        disposition: severity === 'low' ? 'defer' : 'stop',
      };
    },
  );
  const verdict = recurring.some((family) => family.disposition === 'stop')
    ? 'hold'
    : 'defer';
  const families = recurring
    .map(
      (family) =>
        `${family.file} ${family.rule} ${JSON.stringify(family.construct)} (${family.severity}, ${family.disposition})`,
    )
    .join('; ');
  return {
    verdict,
    ...base,
    chainLength,
    recurring,
    holdText: `E10 same-family recurrence: ${recurring.length === 1 ? '1 finding family' : `${recurring.length} finding families`} recurred for ${chainLength} consecutive passes (threshold ${holdAfter}): ${families}`,
  };
}

function runCli(): HelperCliResult {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    E10_RECURRENCE_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    return 0;
  }
  const passesPath = values.passes as string | undefined;
  if (passesPath === undefined || passesPath === '') {
    throw markCliUsageError(new Error('--passes is required'));
  }
  const holdAfterToken = values['hold-after'] as string | undefined;
  const holdAfter =
    holdAfterToken === undefined
      ? normalizePolicyConfig(loadIddConfig()).critiqueLoop
          .e10NoProgressHoldAfter
      : parseCanonicalIntegerOrThrow(holdAfterToken, '--hold-after');
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(passesPath, 'utf8'));
  } catch (error) {
    throw markCliUsageError(
      new Error(
        `cannot read --passes ${passesPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const passes = isPlainObject(document) ? document.passes : undefined;
  const errors = validatePasses(passes);
  if (errors.length > 0) {
    process.stdout.write(`${JSON.stringify({ errors }, null, 2)}\n`);
    return {
      exitCode: 1,
      kind: 'usage',
      message: `invalid disposition records: ${errors.join('; ')}`,
    };
  }
  const report = computeE10Recurrence(passes as unknown[][], holdAfter);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/e10-recurrence.mjs --passes <file.json> [--hold-after <n>]

Counts E10 same-family recurrence from finding fingerprints and prints a JSON
verdict for the latest pass: e11, continue, defer, or hold. Read-only.

  --passes <file.json>  {"passes": [[record, ...], ...]}, oldest pass first;
                        each record is {file, rule, construct, severity,
                        disposition}; rule is one of:
                        ${E10_FINGERPRINT_RULES.join(', ')}
  --hold-after <n>      override critiqueLoop.e10NoProgressHoldAfter
`);
}
