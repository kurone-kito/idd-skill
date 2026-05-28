import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProjectCommandRows } from "./idd-doctor.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE_OVERVIEW_PATH =
  "idd-template/.github/instructions/idd-overview-core.instructions.md";
const COMMAND_ROWS = [
  "fix-validate",
  "pre-push-validate",
  "post-fix-validate",
  "install-deps",
];
const FORBIDDEN_TOKEN = /\bpnpm\b/i;

/**
 * Find pnpm leaks in template Project commands rows.
 * @param {string} overviewText
 * @returns {string[]}
 */
export function findPnpmCommandLeaks(overviewText) {
  const rows = parseProjectCommandRows(overviewText);
  return COMMAND_ROWS.flatMap((name) => {
    const command = rows.get(name) ?? "";
    if (!command || !FORBIDDEN_TOKEN.test(command)) return [];
    return [`${name}: contains forbidden token "pnpm" (${command})`];
  });
}

/**
 * Check distributable template boundary in the current repository.
 * @param {string} [root]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkPnpmBoundary(root = ROOT) {
  const text = readFileSync(join(root, TEMPLATE_OVERVIEW_PATH), "utf8");
  const errors = findPnpmCommandLeaks(text);
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkPnpmBoundary();
  if (!result.ok) {
    console.error("pnpm boundary check failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log("pnpm boundary check passed.");
}
