import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkPnpmBoundary } from '../src/scripts/check-pnpm-boundary.mts';

// findPnpmCommandLeaks already has direct, dedicated coverage in
// tests/pnpm-boundary.test.mts (happy path, multi-row failures,
// case-folding, non-pnpm package managers). This file covers only
// checkPnpmBoundary itself — the root-resolution + file-read +
// {ok, errors} aggregation wrapper — which had no coverage anywhere.

const TEMPLATE_OVERVIEW_REL_PATH =
  'idd-template/.github/instructions/idd-overview-core.instructions.md';

function makeRootWithOverview(overviewMarkdown: string): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'pnpm-boundary-'));
  const overviewPath = join(root, TEMPLATE_OVERVIEW_REL_PATH);
  mkdirSync(join(overviewPath, '..'), { recursive: true });
  writeFileSync(overviewPath, overviewMarkdown, 'utf8');
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const CLEAN_OVERVIEW = [
  '| Name                    | Commands                |',
  '| ----------------------- | ------------------------ |',
  '| **fix-validate**        | `npx biome check --write` |',
  '| **pre-push-validate**   | `npx biome check`         |',
  '| **post-fix-validate**   | `npx biome check --write` |',
  '| **install-deps**        | `npm install`              |',
].join('\n');

const LEAKING_OVERVIEW = [
  '| Name                    | Commands                |',
  '| ----------------------- | ------------------------ |',
  '| **fix-validate**        | `pnpm run lint:fix`       |',
  '| **pre-push-validate**   | `npx biome check`         |',
  '| **post-fix-validate**   | `npx biome check --write` |',
  '| **install-deps**        | `npm install`              |',
].join('\n');

test('checkPnpmBoundary reports ok:true and no errors on a clean template overview', (t) => {
  const { root, cleanup } = makeRootWithOverview(CLEAN_OVERVIEW);
  t.after(cleanup);

  assert.deepEqual(checkPnpmBoundary(root), { ok: true, errors: [] });
});

test('checkPnpmBoundary reports ok:false with the leaking row when pnpm appears', (t) => {
  const { root, cleanup } = makeRootWithOverview(LEAKING_OVERVIEW);
  t.after(cleanup);

  const result = checkPnpmBoundary(root);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /fix-validate.*pnpm/);
});

test('checkPnpmBoundary reads the template overview relative to the given root, not the default ROOT', (t) => {
  const { root: cleanRoot, cleanup: cleanupClean } =
    makeRootWithOverview(CLEAN_OVERVIEW);
  const { root: leakingRoot, cleanup: cleanupLeaking } =
    makeRootWithOverview(LEAKING_OVERVIEW);
  t.after(cleanupClean);
  t.after(cleanupLeaking);

  assert.equal(checkPnpmBoundary(cleanRoot).ok, true);
  assert.equal(checkPnpmBoundary(leakingRoot).ok, false);
});

test('checkPnpmBoundary throws when the template overview file is missing at the given root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pnpm-boundary-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(() => checkPnpmBoundary(root));
});
