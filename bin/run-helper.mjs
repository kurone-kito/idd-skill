#!/usr/bin/env node
// idd-generated-from: src/bin/run-helper.mts
//
// The bin/run-helper.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export function runHelper(relativeScriptPath) {
  const binDirectory = import.meta.dirname;
  const scriptPath = resolve(binDirectory, relativeScriptPath);
  const result = spawnSync(
    process.execPath,
    [scriptPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
    },
  );
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}
