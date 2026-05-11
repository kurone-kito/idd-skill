import { parseProjectCommandRows } from "./idd-doctor.mjs";

const COMMAND_KEYS = [
  "install-deps",
  "fix-validate",
  "pre-push-validate",
  "post-fix-validate",
];

const HELPER_RUNTIME_PROFILES = new Set([
  "package-manager",
  "vendored-node",
  "ephemeral-npx",
  "instructions-only",
]);

const POLICY_FIELD_ROWS = new Map([
  ["issueScope", "issue-scope"],
  ["orphanFirstPolicy", "orphan-first-policy"],
]);

export function collectPolicyConfigDrift(config, overviewText) {
  const drifts = [];
  const commandRows = parseProjectCommandRows(overviewText);

  for (const key of COMMAND_KEYS) {
    const expected = commandRows.get(key);
    if (expected === undefined) {
      drifts.push({
        path: `commands.${key}`,
        expected: null,
        actual: config?.commands?.[key] ?? null,
        reason: `missing instruction row ${key}`,
      });
      continue;
    }
    const actual = config?.commands?.[key];
    if (actual !== expected) {
      drifts.push({
        path: `commands.${key}`,
        expected,
        actual: actual ?? null,
      });
    }
  }

  for (const [field, row] of POLICY_FIELD_ROWS) {
    const expected = commandRows.get(row);
    if (expected === undefined) {
      drifts.push({
        path: field,
        expected: null,
        actual: hasOwn(config, field) ? config[field] : null,
        reason: `missing instruction row ${row}`,
      });
      continue;
    }
    const actual = hasOwn(config, field) ? config[field] : expected;
    if (actual !== expected) {
      drifts.push({
        path: field,
        expected,
        actual: actual ?? null,
      });
    }
  }

  return drifts;
}

export function inspectHelperRuntimeConfig(config) {
  if (!hasOwn(config, "helperRuntime")) {
    return { status: "absent" };
  }

  const helperRuntime = config?.helperRuntime;
  if (typeof helperRuntime !== "object" || helperRuntime === null || Array.isArray(helperRuntime)) {
    return { status: "invalid", reason: "helperRuntime must be an object when present" };
  }

  const profile = helperRuntime.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    return { status: "invalid", reason: "helperRuntime.profile must be a non-empty string" };
  }

  if (!HELPER_RUNTIME_PROFILES.has(profile)) {
    return {
      status: "invalid",
      reason: `unsupported helperRuntime.profile "${profile}"`,
    };
  }

  return { status: "ok", profile };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}
