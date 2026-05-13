import { readFileSync } from "node:fs";

export const DEFAULT_ADVISORY_REQUEST_CAP = 30;
export const DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES = 30;
export const DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES = 10;
export const DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES = 2;
export const ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT = "phase-specific";
export const ADVISORY_CAP_EXHAUSTED_ROUTES = new Set([
  "phase-specific",
  "hold",
]);

export function readAdvisoryWaitPolicy(path = ".github/idd/config.json") {
  try {
    return resolveAdvisoryWaitPolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return resolveAdvisoryWaitPolicy({});
  }
}

export function resolveAdvisoryWaitPolicy(config = {}) {
  const advisoryWait = config?.advisoryWait ?? {};

  return {
    requestCap: normalizePositiveInteger(
      advisoryWait.requestCap,
      DEFAULT_ADVISORY_REQUEST_CAP,
    ),
    pendingWindowMinutes: normalizeDurationMinutes(
      advisoryWait.pendingWindow,
      DEFAULT_ADVISORY_PENDING_WINDOW_MINUTES,
    ),
    settledWindowMinutes: normalizeDurationMinutes(
      advisoryWait.settledWindow,
      DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
    ),
    pollIntervalMinutes: normalizeDurationMinutes(
      advisoryWait.pollInterval,
      DEFAULT_ADVISORY_POLL_INTERVAL_MINUTES,
    ),
    capExhaustedRoute: normalizeCapExhaustedRoute(advisoryWait.capExhaustedRoute),
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeDurationMinutes(value, fallback) {
  const milliseconds = parseDurationToMs(value);
  return milliseconds && milliseconds > 0 ? milliseconds / 60000 : fallback;
}

function normalizeCapExhaustedRoute(value) {
  const route = String(value ?? "").trim();
  return ADVISORY_CAP_EXHAUSTED_ROUTES.has(route)
    ? route
    : ADVISORY_CAP_EXHAUSTED_ROUTE_DEFAULT;
}

function parseDurationToMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text);
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
