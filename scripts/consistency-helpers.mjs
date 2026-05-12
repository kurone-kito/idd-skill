import { parseProjectCommandRows } from "./policy-helpers.mjs";

export { inspectHelperRuntimeConfig } from "./policy-helpers.mjs";

const COMMAND_KEYS = [
  "install-deps",
  "fix-validate",
  "pre-push-validate",
  "post-fix-validate",
];

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}
