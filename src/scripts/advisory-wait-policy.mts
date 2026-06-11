// idd-generated-from: src/scripts/advisory-wait-policy.mts
//
// The scripts/advisory-wait-policy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';

import { loadJson, validate } from './validate-schemas.mts';

export const DEFAULT_ADVISORY_REQUEST_CAP = 30;
export const DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES = 30;
export const DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES = 10;
export const DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES = 2;
export const ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT = 'phase-specific';
export const ADVISORY_CAP_EXHAUSTED_ROUTES = new Set([
  'phase-specific',
  'hold',
]);
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');

interface AdvisoryWaitPolicy {
  requestCap: number;
  pendingWindowMinutes: number;
  settledWindowMinutes: number;
  pollIntervalMinutes: number;
  capExhaustedRoute: string;
}

export function readAdvisoryWaitPolicy(
  path: string = '.github/idd/config.json',
): AdvisoryWaitPolicy {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (validate(config, POLICY_SCHEMA).length > 0) {
      return resolveAdvisoryWaitPolicy({});
    }
    return resolveAdvisoryWaitPolicy(config);
  } catch {
    return resolveAdvisoryWaitPolicy({});
  }
}

export function resolveAdvisoryWaitPolicy(
  config: unknown = {},
): AdvisoryWaitPolicy {
  const advisoryWait = ((config as { advisoryWait?: unknown } | null)
    ?.advisoryWait ?? {}) as Record<string, unknown>;

  return {
    requestCap: normalizeConfiguredPositiveInteger(
      advisoryWait.requestCap,
      DEFAULT_ADVISORY_REQUEST_CAP,
    ),
    pendingWindowMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.pendingWindow,
      DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
    ),
    settledWindowMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.settledWindow,
      DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
    ),
    pollIntervalMinutes: normalizeConfiguredDurationMinutes(
      advisoryWait.pollInterval,
      DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
    ),
    capExhaustedRoute: normalizeConfiguredCapExhaustedRoute(
      advisoryWait.capExhaustedRoute,
    ),
  };
}

export function normalizeAdvisoryWaitRuntimeOptions(
  options: unknown = {},
): AdvisoryWaitPolicy {
  const o = (options ?? {}) as Record<string, unknown>;
  return {
    requestCap: normalizePositiveInteger(
      o.requestCap,
      DEFAULT_ADVISORY_REQUEST_CAP,
    ),
    pendingWindowMinutes: normalizePositiveNumber(
      o.pendingWindowMinutes,
      DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
    ),
    settledWindowMinutes: normalizePositiveNumber(
      o.settledWindowMinutes,
      DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
    ),
    pollIntervalMinutes: normalizePositiveNumber(
      o.pollIntervalMinutes,
      DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
    ),
    capExhaustedRoute: normalizeCapExhaustedRoute(o.capExhaustedRoute),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeConfiguredPositiveInteger(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeConfiguredDurationMinutes(
  value: unknown,
  fallback: number,
): number {
  const milliseconds = parseConfiguredDurationToMs(value);
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : fallback;
}

function normalizeConfiguredCapExhaustedRoute(value: unknown): string {
  return typeof value === 'string' && ADVISORY_CAP_EXHAUSTED_ROUTES.has(value)
    ? value
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}

function normalizeCapExhaustedRoute(value: unknown): string {
  const route = String(value ?? '').trim();
  return ADVISORY_CAP_EXHAUSTED_ROUTES.has(route)
    ? route
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}

function parseConfiguredDurationToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value);
  if (!match) return null;
  const hasTimeDesignator = value.includes('T');
  const hasAnyTimeUnit = match[2] !== undefined || match[3] !== undefined;
  if (hasTimeDesignator && !hasAnyTimeUnit) return null;
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const totalMilliseconds = ((days * 24 + hours) * 60 + minutes) * 60000;
  if (totalMilliseconds <= 0 || totalMilliseconds % 60000 !== 0) {
    return null;
  }
  return totalMilliseconds;
}
