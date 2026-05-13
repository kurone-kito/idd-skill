#!/usr/bin/env node

/**
 * Bin wrapper for review-disposition-verify helper
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const currentDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(currentDir, "../scripts/review-disposition-verify.mjs");

const child = spawn("node", [scriptPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("Failed to spawn review-disposition-verify:", error);
  process.exit(1);
});
