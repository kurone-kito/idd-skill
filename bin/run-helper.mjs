#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runHelper(relativeScriptPath) {
  const binDirectory = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(binDirectory, relativeScriptPath);
  const result = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.status ?? 1);
}
