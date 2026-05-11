import { parseProjectCommandRows } from "./idd-doctor.mjs";

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
      continue;
    }
    const actual = config?.[field];
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
