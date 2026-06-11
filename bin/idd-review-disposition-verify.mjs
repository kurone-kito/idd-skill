#!/usr/bin/env node
// idd-generated-from: src/bin/idd-review-disposition-verify.mts
//
// The bin/idd-review-disposition-verify.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
/**
 * Bin wrapper for review-disposition-verify helper
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(
  currentDir,
  '../scripts/review-disposition-verify.mjs',
);
const child = spawn('node', [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
child.on('error', (error) => {
  console.error('Failed to spawn review-disposition-verify:', error);
  process.exit(1);
});
