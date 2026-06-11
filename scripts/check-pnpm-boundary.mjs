// idd-generated-from: src/scripts/check-pnpm-boundary.mts
//
// The scripts/check-pnpm-boundary.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProjectCommandRows } from './idd-doctor.mjs';

// Resolve the repository root by walking up to the nearest package.json,
// so the default works whether this module runs as the emitted
// scripts/check-pnpm-boundary.mjs or directly from src/scripts/.
function resolveRepoRoot(fromUrl) {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}
const ROOT = resolveRepoRoot(import.meta.url);
const TEMPLATE_OVERVIEW_PATH =
  'idd-template/.github/instructions/idd-overview-core.instructions.md';
const COMMAND_ROWS = [
  'fix-validate',
  'pre-push-validate',
  'post-fix-validate',
  'install-deps',
];
const FORBIDDEN_TOKEN = /\bpnpm\b/i;
/** Find pnpm leaks in template Project commands rows. */
export function findPnpmCommandLeaks(overviewText) {
  const rows = parseProjectCommandRows(overviewText);
  return COMMAND_ROWS.flatMap((name) => {
    const command = rows.get(name) ?? '';
    if (!command || !FORBIDDEN_TOKEN.test(command)) return [];
    return [`${name}: contains forbidden token "pnpm" (${command})`];
  });
}
/** Check distributable template boundary in the current repository. */
export function checkPnpmBoundary(root = ROOT) {
  const text = readFileSync(join(root, TEMPLATE_OVERVIEW_PATH), 'utf8');
  const errors = findPnpmCommandLeaks(text);
  return { ok: errors.length === 0, errors };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkPnpmBoundary();
  if (!result.ok) {
    console.error('pnpm boundary check failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log('pnpm boundary check passed.');
}
