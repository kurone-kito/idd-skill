// idd-generated-from: src/scripts/advisory-wait-policy.mts
//
// The scripts/advisory-wait-policy.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { readFileSync } from 'node:fs';
import { loadJson, validate } from './validate-schemas.mjs';
export const DEFAULT_ADVISORY_REQUEST_CAP = 30;
export const DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES = 30;
export const DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES = 10;
export const DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES = 2;
export const DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN = 'copilot';
export const ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT = 'phase-specific';
export const ADVISORY_CAP_EXHAUSTED_ROUTES = new Set([
  'phase-specific',
  'hold',
]);
const POLICY_SCHEMA = loadJson('schemas/policy.schema.json');
export function readAdvisoryWaitPolicy(path = '.github/idd/config.json') {
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
export function resolveAdvisoryWaitPolicy(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
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
function normalizeConfiguredPrimaryBotLogin(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
}
/**
 * Resolve the configured primary advisory bot login from a parsed policy
 * object, defaulting to Copilot so the advisory-wait gate is behavior-
 * preserving when `advisoryWait.primaryBotLogin` is absent. Kept separate
 * from {@link resolveAdvisoryWaitPolicy} so the timing-policy shape stays a
 * stable five-key object.
 */
export function resolveAdvisoryPrimaryBotLogin(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};
  return normalizeConfiguredPrimaryBotLogin(advisoryWait.primaryBotLogin);
}
/**
 * Read the configured primary advisory bot login from a policy file, failing
 * closed to Copilot when the file is missing, unreadable, or schema-invalid.
 */
export function readAdvisoryPrimaryBotLogin(path = '.github/idd/config.json') {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (validate(config, POLICY_SCHEMA).length > 0) {
      return DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
    }
    return resolveAdvisoryPrimaryBotLogin(config);
  } catch {
    return DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  }
}
export function normalizeAdvisoryWaitRuntimeOptions(options = {}) {
  const o = options ?? {};
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
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
function normalizeConfiguredPositiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function normalizeConfiguredDurationMinutes(value, fallback) {
  const milliseconds = parseConfiguredDurationToMs(value);
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : fallback;
}
function normalizeConfiguredCapExhaustedRoute(value) {
  return typeof value === 'string' && ADVISORY_CAP_EXHAUSTED_ROUTES.has(value)
    ? value
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}
function normalizeCapExhaustedRoute(value) {
  const route = String(value ?? '').trim();
  return ADVISORY_CAP_EXHAUSTED_ROUTES.has(route)
    ? route
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}
function parseConfiguredDurationToMs(value) {
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
