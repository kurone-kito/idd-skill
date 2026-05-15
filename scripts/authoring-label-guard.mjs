import { POLICY_DEFAULTS, normalizePolicyConfig, parseIsoDurationToMs } from "./policy-helpers.mjs";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function resolveAuthoringGuardPolicy(config) {
  const normalized = normalizePolicyConfig(config);
  const fallbackMs = parseIsoDurationToMs(POLICY_DEFAULTS.issueAuthoring.authoringStaleAge);
  return {
    labelName: normalized.issueAuthoring.authoringLabelName,
    staleAge: normalized.issueAuthoring.authoringStaleAge,
    staleAgeMs: parseIsoDurationToMs(normalized.issueAuthoring.authoringStaleAge) ?? fallbackMs,
  };
}

export function buildAuthoringLabelWarning({
  issueNumber,
  labelName,
  labelEvents,
  now = new Date(),
  staleAgeMs,
}) {
  const labeledAt = findLatestLabeledAt(labelEvents, labelName);
  if (!labeledAt) {
    return {
      issueNumber,
      labelName,
      status: "timestamp_unavailable",
      labeledAt: null,
      ageMs: null,
      staleAgeMs,
      message:
        `Warning: Issue #${issueNumber} carries the authoring label, ` +
        "but the labeled event timestamp could not be resolved; " +
        "the stale-authoring age could not be checked.",
    };
  }

  const labeledAtMs = Date.parse(labeledAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const ageMs = nowMs - labeledAtMs;
  if (!Number.isFinite(ageMs) || ageMs < staleAgeMs) {
    return null;
  }

  return {
    issueNumber,
    labelName,
    status: "stale",
    labeledAt,
    ageMs,
    staleAgeMs,
    message:
      `Warning: Issue #${issueNumber} has carried the authoring label for ` +
      `${formatElapsedDuration(ageMs)}; the authoring session may be stalled.`,
  };
}

export function findLatestLabeledAt(events, labelName) {
  let latest = "";
  for (const event of events ?? []) {
    if (!isMatchingLabeledEvent(event, labelName)) {
      continue;
    }
    const createdAt = String(event.created_at ?? event.createdAt ?? "");
    if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
      continue;
    }
    if (!latest || Date.parse(createdAt) > Date.parse(latest)) {
      latest = createdAt;
    }
  }
  return latest;
}

export function formatElapsedDuration(durationMs) {
  const clamped = Math.max(0, Math.floor(durationMs));
  const days = Math.floor(clamped / DAY_MS);
  const hours = Math.floor((clamped % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((clamped % HOUR_MS) / MINUTE_MS);

  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }
  return parts.join(" ");
}

function isMatchingLabeledEvent(event, labelName) {
  if (!event || event.event !== "labeled") {
    return false;
  }
  const eventLabel = typeof event.label === "string" ? event.label : event.label?.name;
  return eventLabel === labelName;
}
