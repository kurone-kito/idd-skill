import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// #3829 (observed 2026-10-08): pnpm can refuse a git-hosted install of a
// package whose manifest carries one of these lifecycle scripts, depending on
// the ref shape and the pnpm version. An exact spec can be allow-listed (for
// example through allowBuilds), but a pnpm dlx run was still refused on pnpm
// 12.9.1 with an --allow-build flag or a workspace entry. `prepare` only
// existed to activate Husky for contributors, so the explicit `setup:hooks`
// step replaces it.
const BLOCKED_LIFECYCLE_SCRIPTS = [
  'prepare',
  'prepublish',
  'prepack',
  'publish',
] as const;

function lifecycleViolations(
  manifestScripts: Record<string, string>,
): string[] {
  return BLOCKED_LIFECYCLE_SCRIPTS.filter((key) =>
    Object.hasOwn(manifestScripts, key),
  ).map(
    (key) =>
      `scripts.${key} makes pnpm refuse a git-hosted install of this package`,
  );
}

const { scripts } = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

test('package.json carries no lifecycle script that blocks git-hosted installs', () => {
  assert.deepEqual(lifecycleViolations(scripts), []);
});

test('setup:hooks is the explicit one-time step that enables the Git hooks', () => {
  assert.equal(scripts['setup:hooks'], 'husky');
});

test('lifecycle scripts that pnpm does not refuse are not reported', () => {
  assert.deepEqual(
    lifecycleViolations({
      prepublishOnly: 'echo publish',
      postinstall: 'echo install',
      install: 'echo install',
    }),
    [],
  );
});

for (const key of BLOCKED_LIFECYCLE_SCRIPTS) {
  test(`the lifecycle check reports scripts.${key} with the refusal message`, () => {
    const violations = lifecycleViolations({ [key]: 'echo blocked' });
    assert.deepEqual(violations, [
      `scripts.${key} makes pnpm refuse a git-hosted install of this package`,
    ]);
  });
}
