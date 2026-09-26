import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectDeadExportAuditResult } from '../src/scripts/audit-dead-exports.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Builds a fresh fixture tree under a unique temp directory with the
 * three subdirectories `collectDeadExportAuditResult` scans, and returns
 * its root -- callers write into `src/scripts/`, `src/bin/`, `tests/`
 * beneath it. */
function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'audit-dead-exports-'));
  mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'bin'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  return root;
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function findByName(
  result: ReturnType<typeof collectDeadExportAuditResult>,
  name: string,
) {
  const match = result.all.find((entry) => entry.name === name);
  assert.ok(match, `expected an export named "${name}" in the audit result`);
  return match;
}

test('an export imported only from a fixture path under tests/** is flagged test-only', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      "export function renderWidget(): string {\n  return 'widget';\n}\n",
    );
    write(
      root,
      'tests/fixtures/widget-fixture.mts',
      "import { renderWidget } from '../../src/scripts/widget.mts';\n" +
        'renderWidget();\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'renderWidget');
    assert.equal(entry.category, 'test-only');
    assert.ok(
      result.findings.some((f) => f.name === 'renderWidget'),
      'an unsuppressed test-only export must appear in findings',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an export imported from a fixture path under src/scripts/** is not flagged', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      "export function renderWidget(): string {\n  return 'widget';\n}\n",
    );
    write(
      root,
      'src/scripts/widget-consumer.mts',
      "import { renderWidget } from './widget.mts';\n" + 'renderWidget();\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'renderWidget');
    assert.equal(entry.category, 'production');
    assert.equal(
      result.findings.some((f) => f.name === 'renderWidget'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an export with no importer anywhere is flagged unused', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      'export function forgottenHelper(): number {\n  return 1;\n}\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'forgottenHelper');
    assert.equal(entry.category, 'unused');
    assert.ok(result.findings.some((f) => f.name === 'forgottenHelper'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppressed export with only test importers is not flagged', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      '// audit:ignore-dead-export: exercised only via the test harness, by design\n' +
        "export function renderWidget(): string {\n  return 'widget';\n}\n",
    );
    write(
      root,
      'tests/widget.test.mts',
      "import { renderWidget } from '../src/scripts/widget.mts';\n" +
        'renderWidget();\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'renderWidget');
    assert.equal(entry.category, 'test-only');
    assert.equal(entry.suppressed, true);
    assert.equal(
      entry.suppressionReason,
      'exercised only via the test harness, by design',
    );
    assert.equal(
      result.findings.some((f) => f.name === 'renderWidget'),
      false,
      'a suppressed finding must never appear in findings',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marker-helpers.mts export consumed only via the protocol-helpers.mts export * barrel is not flagged (production credited back through the barrel)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/marker-helpers.mts',
      "export function renderClaimedByMarker(): string {\n  return 'marker';\n}\n",
    );
    write(
      root,
      'src/scripts/protocol-helpers.mts',
      "export * from './marker-helpers.mts';\n",
    );
    write(
      root,
      'src/scripts/post-idd-marker.mts',
      "import { renderClaimedByMarker } from './protocol-helpers.mts';\n" +
        'renderClaimedByMarker();\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'renderClaimedByMarker');
    assert.equal(entry.category, 'production');
    assert.equal(
      result.findings.some((f) => f.name === 'renderClaimedByMarker'),
      false,
    );
    // protocol-helpers.mts itself declares no exports of its own here (a
    // pure barrel file), so it must not appear in `all` at all.
    assert.equal(
      result.all.some((f) => f.file === 'src/scripts/protocol-helpers.mts'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a named (non-barrel) re-export from a specific file is also credited back to the origin', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/advisory-wait-policy.mts',
      'export const DEFAULT_BOT_LOGINS = [] as const;\n',
    );
    write(
      root,
      'src/scripts/protocol-helpers.mts',
      "export { DEFAULT_BOT_LOGINS } from './advisory-wait-policy.mts';\n",
    );
    write(
      root,
      'src/scripts/disposition.mts',
      "import { DEFAULT_BOT_LOGINS } from './protocol-helpers.mts';\n" +
        'void DEFAULT_BOT_LOGINS;\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'DEFAULT_BOT_LOGINS');
    assert.equal(entry.category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an aliased named re-export (`export { x as y } from` ...) is still credited back to the origin declaration (#3478 review: the alias must not be lost when resolving the chain)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/advisory-wait-policy.mts',
      'export const ORIGIN_BOT_LOGINS = [] as const;\n',
    );
    write(
      root,
      'src/scripts/protocol-helpers.mts',
      "export { ORIGIN_BOT_LOGINS as EXPOSED_BOT_LOGINS } from './advisory-wait-policy.mts';\n",
    );
    write(
      root,
      'src/scripts/disposition.mts',
      "import { EXPOSED_BOT_LOGINS } from './protocol-helpers.mts';\n" +
        'void EXPOSED_BOT_LOGINS;\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'ORIGIN_BOT_LOGINS');
    assert.equal(
      entry.category,
      'production',
      'the origin declaration must be credited with the importer that ' +
        'reached it through the alias, not misclassified as unused ' +
        'because the alias broke the chain',
    );
    assert.equal(
      result.all.some((f) => f.name === 'EXPOSED_BOT_LOGINS'),
      false,
      'the alias itself is a pass-through name, never a declaration -- ' +
        'only the origin identifier is tracked in `all`',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a namespace import reaching an aliased named re-export is also credited back to the origin declaration (same #3478 review finding, namespace-import path)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/advisory-wait-policy.mts',
      'export const ORIGIN_BOT_LOGINS = [] as const;\n',
    );
    write(
      root,
      'src/scripts/protocol-helpers.mts',
      "export { ORIGIN_BOT_LOGINS as EXPOSED_BOT_LOGINS } from './advisory-wait-policy.mts';\n",
    );
    write(
      root,
      'src/scripts/disposition.mts',
      "import * as helpers from './protocol-helpers.mts';\n" +
        'void helpers.EXPOSED_BOT_LOGINS;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'ORIGIN_BOT_LOGINS').category,
      'production',
      'a namespace import must also resolve an aliased named re-export ' +
        'back to the origin declaration, not just a direct named import',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a two-hop alias chain (each hop renaming via `as`) still resolves back to the origin declaration', () => {
  const root = makeFixtureRoot();
  try {
    write(root, 'src/scripts/origin.mts', 'export const ORIGIN_VALUE = 1;\n');
    write(
      root,
      'src/scripts/middle-facade.mts',
      "export { ORIGIN_VALUE as MIDDLE_VALUE } from './origin.mts';\n",
    );
    write(
      root,
      'src/scripts/outer-facade.mts',
      "export { MIDDLE_VALUE as OUTER_VALUE } from './middle-facade.mts';\n",
    );
    write(
      root,
      'src/scripts/consumer.mts',
      "import { OUTER_VALUE } from './outer-facade.mts';\n" +
        'void OUTER_VALUE;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'ORIGIN_VALUE').category,
      'production',
      'each hop renames the export via `as`; the chain must still ' +
        'resolve back to the real origin declaration two hops away',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an export referenced only elsewhere in its own declaring file (self-use) is production, even with zero cross-file importers', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/gate.mts',
      [
        'export function evaluateThing(): boolean {',
        '  return true;',
        '}',
        '',
        'export function main(): void {',
        '  evaluateThing();',
        '}',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'evaluateThing');
    assert.equal(entry.category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a namespace import (import * as x) credits every export the target module declares', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      "export function renderWidget(): string {\n  return 'widget';\n}\n" +
        'export const WIDGET_KIND = 42;\n',
    );
    write(
      root,
      'tests/widget-namespace.test.mts',
      "import * as widget from '../src/scripts/widget.mts';\n" +
        'widget.renderWidget();\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(findByName(result, 'renderWidget').category, 'test-only');
    assert.equal(findByName(result, 'WIDGET_KIND').category, 'test-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a type-only export list item is never classified as an export, and a type-only re-export credits nothing', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/shapes.mts',
      [
        'interface Local {',
        '  id: string;',
        '}',
        'function makeLocal(): Local {',
        "  return { id: 'x' };",
        '}',
        'export { type Local, makeLocal };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      result.all.some((f) => f.name === 'Local'),
      false,
      'a `type`-prefixed list item must never be tracked as an export',
    );
    assert.ok(result.all.some((f) => f.name === 'makeLocal'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a namespace import of a barrel-only file (no declarations of its own) still credits the barrel target's own exports (transitive namespace-import resolution)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/marker-helpers.mts',
      "export function renderClaimedByMarker(): string {\n  return 'x';\n}\n",
    );
    write(
      root,
      'src/scripts/protocol-helpers.mts',
      "export * from './marker-helpers.mts';\n",
    );
    write(
      root,
      'tests/protocol-helpers-facade.test.mts',
      "import * as facade from '../src/scripts/protocol-helpers.mts';\n" +
        'facade.renderClaimedByMarker();\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'renderClaimedByMarker').category,
      'test-only',
      'a namespace import of a pure barrel file must still reach the ' +
        "barrel target's own declarations, not just the barrel file's " +
        '(empty) own declared-export set',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the export declaration's own line (not the preceding line) also suppresses it", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      'export function forgottenHelper(): number { // audit:ignore-dead-export: kept for a planned CLI wiring\n' +
        '  return 1;\n' +
        '}\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'forgottenHelper');
    assert.equal(entry.suppressed, true);
    assert.equal(entry.suppressionReason, 'kept for a planned CLI wiring');
    assert.equal(
      result.findings.some((f) => f.name === 'forgottenHelper'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a whole-statement `export type { X } from` re-export credits nothing (type-only re-export)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/shapes.mts',
      'export interface Shape {\n  id: string;\n}\n' +
        // A real, declared (value-kind) export sharing the type-only
        // re-export's role, so the assertion below is discriminating --
        // `Shape` alone (an interface) is never tracked in `all` at all
        // regardless of whether the re-export skip works, since only
        // function/const/class declarations are. `ShapeImpl` IS tracked,
        // so a broken skip that wrongly created a real re-export edge for
        // it would show up as a credited importer, not as an entry in
        // `all` (re-export edges never appear in `all` themselves).
        'export class ShapeImpl {}\n',
    );
    write(
      root,
      'src/scripts/shapes-facade.mts',
      "export type { Shape, ShapeImpl } from './shapes.mts';\n" +
        'export function noop(): void {}\n',
    );
    write(
      root,
      'src/scripts/shapes-consumer.mts',
      "import { ShapeImpl } from './shapes-facade.mts';\n" +
        'void ShapeImpl;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      result.all.some((f) => f.name === 'Shape'),
      false,
      'an interface is never tracked as a declared export in the first place',
    );
    assert.equal(
      findByName(result, 'ShapeImpl').category,
      'unused',
      'a whole-statement `export type {...} from` re-export must credit ' +
        "no importer -- shapes-consumer.mts's import goes through the " +
        'type-only facade and must not resolve back to the real declaration',
    );
    // The facade file's own real export must still parse correctly --
    // proves the type-only-statement skip did not swallow the next line.
    assert.ok(result.all.some((f) => f.name === 'noop'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` aliased export-list item whose underlying declaration has zero real importers is classified unused, not masked as production by the declarationLine mismatch (#3498)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.category,
      'unused',
      'the underlying declaration is never referenced anywhere but its ' +
        'own declaration line and has zero cross-file importers -- it ' +
        'must not be masked as `production` by crediting the export ' +
        "statement's own line as a false self-reference",
    );
    assert.ok(result.findings.some((f) => f.name === 'PublicHelper'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` unaliased export-list item whose underlying declaration has zero real importers is classified unused (same declarationLine fix, no alias)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function forgottenLocal(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export { forgottenLocal };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'forgottenLocal');
    assert.equal(entry.category, 'unused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` aliased export-list item whose underlying declaration IS genuinely self-referenced elsewhere is still classified production (declarationLine fix does not break the true-positive path)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export function main(): void {',
        '  helper();',
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(findByName(result, 'PublicHelper').category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-`from` export list appearing BEFORE the declaration it re-exports (valid via function hoisting) still resolves the real declaration line, not the export statement's own line (#3498 C1 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'export { helper as PublicHelper };',
        '',
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'the declaration is textually AFTER the export statement (hoisting) ' +
        '-- the real declaration line must still be resolved via a ' +
        'full-file scan, not only a forward, in-order lookup',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line no-`from` export list resolves the item's own line to the identifier's actual line, not the opening brace's line (#3498 C1 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export {',
        '  helper as PublicHelper,',
        '};',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      "a multi-line export-list item's own line must resolve to the " +
        "identifier's actual line, not the `export {` opening-brace " +
        'line -- otherwise the wrong line is excluded from the ' +
        "self-reference scan and the real declaration's own occurrence " +
        'is wrongly counted as "elsewhere"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two aliases of the same local name in a multi-line no-`from` export list do not falsely count each other as a self-reference (#3498 C1 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export {',
        '  helper as PublicA,',
        '  helper as PublicB,',
        '};',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicA').category,
      'unused',
      "PublicB's own list line must not count as a self-reference for " +
        'PublicA, and vice versa -- both are re-export mechanisms for ' +
        'the same local name, neither is real usage',
    );
    assert.equal(findByName(result, 'PublicB').category, 'unused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two aliases of the same local name are classified independently when only one has a real cross-file importer (#3498 C1 finding: the shared exclude-lines fix must not blur independent importer credit)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export {',
        '  helper as PublicA,',
        '  helper as PublicB,',
        '};',
        '',
      ].join('\n'),
    );
    write(
      root,
      'src/scripts/widget-consumer.mts',
      "import { PublicA } from './widget.mts';\n" + 'void PublicA;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicA').category,
      'production',
      'PublicA has a genuine cross-file importer',
    );
    assert.equal(
      findByName(result, 'PublicB').category,
      'unused',
      'PublicB has zero importers and no real self-use -- it must not ' +
        "inherit PublicA's production status just because they share a " +
        'local name and an export statement',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-`from` export list re-exporting a merely IMPORTED local binding (never declared in this file) is classified unused, not masked by the import statement's own mention (Copilot C1 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export function helper(): void {\n' + "  console.log('hi');\n" + '}\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import { helper } from './origin.mts';\n" +
        '\n' +
        'export { helper as PublicHelper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      "the import statement's own mention of `helper` must not count as " +
        'a self-reference for `PublicHelper` -- it is re-export plumbing, ' +
        'not usage, and PublicHelper has no real cross-file importer',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the RESOLVED declaration line (not the export-list item's own line) suppresses a no-`from` list item (Codex C1 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        '// audit:ignore-dead-export: kept for a planned public API',
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      'the reported line is now the real declaration line, so a ' +
        "suppression comment placed there (per the audit's own " +
        'remediation message) must actually suppress the finding',
    );
    assert.equal(entry.suppressionReason, 'kept for a planned public API');
    assert.equal(
      result.findings.some((f) => f.name === 'PublicHelper'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the export-list item's own line still suppresses a no-`from` list item (unchanged behavior alongside the declaration-line recognition)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export { helper as PublicHelper }; // audit:ignore-dead-export: legacy export, still public API',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(entry.suppressed, true);
    assert.equal(entry.suppressionReason, 'legacy export, still public API');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the import statement's own line suppresses a no-`from` list item that resolves to it (Codex C1 round-3 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export function helper(): void {\n' + "  console.log('hi');\n" + '}\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import { helper } from './origin.mts'; // audit:ignore-dead-export: kept for a planned public API\n" +
        '\n' +
        'export { helper as PublicHelper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      'the reported line is the import line for this imported-binding ' +
        'case -- a suppression comment placed there must take effect, ' +
        'the same way it does for a bare/exported declaration line',
    );
    assert.equal(entry.suppressionReason, 'kept for a planned public API');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-`from` export list re-exporting a named import from a BARE (non-relative) package specifier is classified unused, not masked by the import statement's own mention (Codex C1 round-4 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/facade.mts',
      "import { helper } from 'some-package';\n" +
        '\n' +
        'export { helper as PublicHelper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'a bare package specifier (no leading `./`/`../`) must still get ' +
        'the same local-alias line tracking a relative import gets -- ' +
        'only cross-file importer crediting is relative-only',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a named import from a relative specifier is still credited as a real cross-file importer (control: the bare-specifier fix above must not affect relative-import crediting)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      "export function renderWidget(): string {\n  return 'widget';\n}\n",
    );
    write(
      root,
      'src/scripts/widget-consumer.mts',
      "import { renderWidget } from './widget.mts';\n" + 'renderWidget();\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(findByName(result, 'renderWidget').category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare (no `export` keyword) multi-declarator `const` statement resolves EVERY declarator name, not only the first (Codex C1 round-4 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/multiconst.mts',
      'const retained = 1, forgotten = 2;\n' + '\n' + 'export { forgotten };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'forgotten').category,
      'unused',
      '`forgotten` is the SECOND declarator on the `const` line -- its ' +
        'real declaration line must still resolve, not just the first ' +
        'declarator (`retained`)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare multi-declarator `const` statement with an initializer containing a comma does not mis-split declarators (control for the round-4 fix)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/multiconst2.mts',
      [
        'function makePair(a: number, b: number): [number, number] {',
        '  return [a, b];',
        '}',
        '',
        'const pair = makePair(1, 2), lonely = 3;',
        '',
        'export { lonely };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'lonely').category,
      'unused',
      'the comma inside `makePair(1, 2)` must not be mistaken for a ' +
        'declarator boundary -- `lonely` must still resolve to its own ' +
        'real declarator, not a mis-split fragment',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a comma INSIDE a string literal on a bare `const` line is never mistaken for a declarator boundary (Copilot C1 round-5 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        "const text = 'x, helper';",
        'function helper(): void {',
        "  console.log('hi');",
        '}',
        '',
        'export { helper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'helper');
    assert.equal(
      entry.line,
      2,
      'the comma inside the string literal must not be split as if it ' +
        'were a second declarator on the `const` line -- `helper` must ' +
        'still resolve to its own real function declaration line, not ' +
        'the unrelated `const` line',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare multi-declarator `const` statement split across multiple physical lines is a DOCUMENTED, accepted limitation, not resolved (round 6: reverted after the ASI regression the multi-line scan caused -- see scanBareConstDeclarators' own doc comment)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/multiline.mts',
      'const retained = 1,\n  forgotten = 2;\n\nexport { forgotten };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'forgotten').category,
      'production',
      '`forgotten` is declared on the SECOND physical line of a ' +
        'multi-line declarator list -- the scanner is deliberately ' +
        'single-line-only (round 6 revert), so this stays misclassified ' +
        '(an accepted limitation) rather than resolving correctly',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an EXPORTED multi-declarator `const` statement (`export const a = 1, b = 2;`) tracks EVERY declarator as its own direct export, not only the first (proactive fix, same class as the bare-const findings)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      'export const retained = 1, forgotten = 2;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'retained').category,
      'unused',
      'the first declarator must still be tracked (unchanged behavior)',
    );
    assert.equal(
      findByName(result, 'forgotten').category,
      'unused',
      'the SECOND declarator is a genuine direct export too -- it must ' +
        'not be silently absent from the audit results entirely',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a semicolonless (ASI) bare `const` declaration does not swallow the following statement into its own scan -- the export must not silently disappear from the audit (Codex/Copilot C1 round-6 finding: the multi-line scan this reverts caused exactly this regression)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/asi.mts',
      'const helper = 1\nexport { helper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'helper').category,
      'unused',
      'a missing semicolon after a single-declarator bare `const` must ' +
        'never cause the following export statement to be consumed by ' +
        "the declarator scan and silently dropped from the audit's " +
        'results entirely',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-`from` export list re-exporting a DEFAULT-imported local binding is classified unused, not masked by the import statement's own mention (Copilot C1 round-6 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export default function helper(): void {\n' +
        "  console.log('hi');\n" +
        '}\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import helper from './origin.mts';\n" +
        '\n' +
        'export { helper as PublicHelper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'a default import (no braces) must get the same local-alias line ' +
        'tracking a named import gets',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-`from` export list re-exporting a NAMESPACE import's own local binding is classified unused, not masked by the import statement's own mention (Copilot C1 round-6 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import * as origin from './origin.mts';\n" +
        '\n' +
        'export { origin as PublicOrigin };\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicOrigin').category,
      'unused',
      "a namespace import's own local binding must get the same " +
        'local-alias line tracking a named import gets',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` export list re-exporting a BARE function with multiple TypeScript overload signatures is classified unused, not masked by the other overload lines (Codex C1 round-6 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(a: number): void;',
        'function helper(a: string): void;',
        'function helper(a: number | string): void {',
        '  console.log(a);',
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'every overload signature line mentions `helper` -- all of them ' +
        'must be excluded from the self-reference scan, not only the ' +
        'first one recorded',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppression comment above a LATER TypeScript overload signature (not the first) is still honored for a no-`from` re-export resolving to it (Codex C1 round-13 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        'function helper(a: number): void;',
        '// audit:ignore-dead-export: kept for a planned public API',
        'function helper(a: string): void;',
        'function helper(a: number | string): void {',
        '  console.log(a);',
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      'the FIRST overload signature (line 1, unsuppressed) must not ' +
        'permanently lock in an unsuppressed state for `helper` -- a ' +
        'genuine suppression comment above the SECOND signature (line ' +
        '3, via its own preceding line) must still be merged in, not ' +
        'silently discarded by a `has()`-guarded first-write-wins map',
    );
    assert.ok(
      !result.findings.some((f) => f.name === 'PublicHelper'),
      'a suppressed finding must never appear in findings',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppression comment above an EARLIER EXPORTED TypeScript overload signature is still honored for a no-`from` re-export resolving to it (Codex C1 round-14 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      [
        '// audit:ignore-dead-export: kept for a planned public API',
        'export function helper(a: number): void;',
        'export function helper(a: string): void;',
        'export function helper(a: number | string): void {',
        '  console.log(a);',
        '}',
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      'the FIRST (EXPORTED) overload signature is genuinely suppressed ' +
        'via its own preceding line -- a LATER, unsuppressed signature ' +
        'or the implementation must not overwrite that state away for ' +
        "the no-`from` alias's own suppression bookkeeping, the same " +
        'merge fix round 13 applied to the BARE-declaration branch',
    );
    assert.ok(
      !result.findings.some((f) => f.name === 'PublicHelper'),
      'a suppressed finding must never appear in findings',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a regex literal's own delimiters in a bare `const` initializer are a DOCUMENTED, accepted limitation, but the single-line bound (round 6) keeps the damage confined to that one line -- a LATER export is never lost (Codex/Copilot C1 round-6 findings: regex-vs-division cannot be safely disambiguated without a real parser)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      "const OPEN = /\\{/;\nfunction helper(): void {\n  console.log('hi');\n}\n\nexport { helper };\n",
    );
    const result = collectDeadExportAuditResult(root);
    // The regex literal's escaped `{` corrupts THIS line's own bracket
    // depth (an accepted limitation -- see `scanBareConstDeclarators`'s
    // doc comment), but round 6's single-line bound means that
    // corruption can never cross into a later line's own processing,
    // unlike the reverted multi-line scan's ASI regression.
    assert.equal(
      findByName(result, 'helper').category,
      'unused',
      '`helper` is declared on a LATER line than the regex-containing ' +
        '`const` -- it must resolve normally, proving the regex-literal ' +
        "damage stays confined to the regex's own line and never " +
        'swallows a later statement',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a TypeScript generic angle-bracket comma in an exported const arrow function is a DOCUMENTED, accepted limitation (Codex C1 round-6 finding: generic-vs-comparison cannot be safely disambiguated without a real parser)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      'export const helper = <T, U>(value: T): T => value;\n',
    );
    const result = collectDeadExportAuditResult(root);
    // Document the actual (accepted-limitation) behavior: the generic's
    // own comma is mistaken for a declarator boundary, inventing a
    // bogus `U` entry. This control test exists so a future reader sees
    // this was verified and deliberately left as a known limitation
    // (see `scanBareConstDeclarators`'s doc comment), not silently
    // reintroduced by an unrelated future change.
    assert.ok(findByName(result, 'helper'), 'the real export is still tracked');
    assert.equal(
      result.all.some((f) => f.name === 'U'),
      true,
      'documents the accepted false positive: a generic type parameter ' +
        'is currently invented as a bogus declarator -- if this ever ' +
        'starts failing, the limitation may have been fixed for real ' +
        '(update this test and the doc comment together)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` export list re-exporting a binding from a COMBINED default + named import is classified unused, and the named part is still credited as a real importer (Copilot/Codex C1 round-7 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export function other(): void {}\n' +
        "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import helper, { other } from './origin.mts';\n" +
        '\n' +
        'export { helper as PublicHelper };\n' +
        'void other;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'the default binding of a combined default+named import must get ' +
        'the same local-alias line tracking a plain default import gets',
    );
    assert.equal(
      findByName(result, 'other').category,
      'production',
      'the NAMED part of the same combined import must still be ' +
        "credited as a real cross-file importer of origin.mts' other",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` export list re-exporting a binding from a COMBINED default + namespace import is classified unused (Copilot/Codex C1 round-7 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import def, * as origin from './origin.mts';\n" +
        '\n' +
        'export { origin as PublicOrigin };\n' +
        'void def;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicOrigin').category,
      'unused',
      'the namespace binding of a combined default+namespace import ' +
        'must get the same local-alias line tracking a plain namespace ' +
        'import gets',
    );
    assert.equal(
      findByName(result, 'helper').category,
      'production',
      'the namespace part of the same combined import must still ' +
        "credit origin.mts's own helper as a real cross-file importer",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a COMBINED default + named import wrapped onto a second line right after the comma is still recognized, so a no-`from` re-export resolving to it is classified unused, not masked as production (Codex C1 round-10 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import def,\n  { helper } from './origin.mts';\n" +
        '\n' +
        'export { helper as PublicHelper };\n' +
        'void def;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicHelper').category,
      'unused',
      'a comma-then-newline wrap before the named brace list must not ' +
        'leave the whole import statement unrecognized -- before this ' +
        'fix it fell through both the plain-default and plain-brace ' +
        "patterns (neither tested more than the statement's own first " +
        "physical line), so the import line's own mention of `helper` " +
        'was never excluded from self-reference detection and silently ' +
        'masked an otherwise-unused export as production',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a COMBINED default + namespace import wrapped onto a second line right after the comma is still recognized (Codex C1 round-10 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import def,\n  * as origin from './origin.mts';\n" +
        '\n' +
        'export { origin as PublicOrigin };\n' +
        'void def;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'PublicOrigin').category,
      'unused',
      'a comma-then-newline wrap before `* as` must not leave the ' +
        'combined default+namespace import statement unrecognized',
    );
    assert.equal(
      findByName(result, 'helper').category,
      'production',
      'the namespace part of the wrapped combined import must still ' +
        "credit origin.mts's own helper as a real cross-file importer, " +
        "the same as the non-wrapped round-7 test's expectation",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the line PRECEDING a wrapped COMBINED default + namespace import (above the statement's own first line, not adjacent to the namespace identifier's later physical line) is honored (Codex C1 round-11 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      "export function helper(): void {\n  console.log('hi');\n}\n",
    );
    write(
      root,
      'src/scripts/facade.mts',
      '// audit:ignore-dead-export: kept for a planned public API\n' +
        "import def,\n  * as origin from './origin.mts';\n" +
        '\n' +
        'export { origin as PublicOrigin };\n' +
        'void def;\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicOrigin');
    assert.equal(
      entry.category,
      'unused',
      'suppression tracking must not change the underlying category',
    );
    assert.ok(
      !result.findings.some((f) => f.name === 'PublicOrigin'),
      'a suppression comment above the WHOLE wrapped statement (line 1) ' +
        "must be honored for the namespace identifier's own re-export " +
        "entry, even though the identifier's own real line (2, after " +
        'the comma-then-newline wrap) is not adjacent to line 1 -- ' +
        "checking only the identifier's own-or-preceding line misses " +
        "it, the same gap round 9's fix already closed for " +
        '`processNamedImportBraceList`',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` export list item aliasing a local binding as literal `default` is credited by a plain `import x from` consumer (Codex C1 round-12 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'const helper = 1;\n' + 'export { helper as default };\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import helper from './origin.mts';\n" + 'void helper;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'default').category,
      'production',
      'a plain `import x from` consumer must credit a no-`from` list ' +
        'item aliased as literal `default` -- before this fix, the ' +
        'plain default-import branch pushed no `imports` edge at all ' +
        '(reasoned, correctly for `export default function realName()' +
        '{}` but not for THIS shape, that a default export is never ' +
        "keyed `'default'`), so this entry was reported as unused even " +
        'though a real production file imports it',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the DEFAULT half of a combined default+named import also credits a no-`from` export list item aliased as literal `default` (round-12 extension, same reasoning as the plain form above)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'const helper = 1;\n' +
        'export function other(): void {}\n' +
        'export { helper as default };\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import helper, { other } from './origin.mts';\n" +
        'void helper;\n' +
        'void other;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(findByName(result, 'default').category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the DEFAULT half of a combined default+namespace import also credits a no-`from` export list item aliased as literal `default` (round-12 extension, same reasoning as the plain form above)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'const helper = 1;\n' +
        'export function other(): void {}\n' +
        'export { helper as default };\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      "import helper, * as ns from './origin.mts';\n" +
        'void helper;\n' +
        'void ns;\n',
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(findByName(result, 'default').category, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a suppression comment on the line PRECEDING a named import is honored for a no-`from` re-export resolving to that import (Codex C1 round-8 finding)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export function helper(): void {}\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      '// audit:ignore-dead-export: kept for a planned public API\n' +
        "import { helper } from './origin.mts';\n" +
        '\n' +
        'export { helper as PublicHelper };\n',
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      'the documented contract (docs/idd-helper-scripts.md) allows the ' +
        "marker on the import's own line OR immediately above it -- " +
        'only the own-line form was previously honored for named imports',
    );
    assert.equal(entry.suppressionReason, 'kept for a planned public API');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suppression comment on the line PRECEDING a MULTI-LINE named import statement is honored, not just above the item's own line (Codex/Copilot C1 round-9 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/origin.mts',
      'export function helper(): void {}\n',
    );
    write(
      root,
      'src/scripts/facade.mts',
      [
        '// audit:ignore-dead-export: kept for a planned public API',
        'import {',
        '  helper,',
        "} from './origin.mts';",
        '',
        'export { helper as PublicHelper };',
        '',
      ].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    const entry = findByName(result, 'PublicHelper');
    assert.equal(
      entry.suppressed,
      true,
      "for a multi-line import list, the item's own line (`  helper,`) " +
        'is NOT adjacent to the comment above `import {` -- the ' +
        "statement's own opening line must also be checked",
    );
    assert.equal(entry.suppressionReason, 'kept for a planned public API');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuine recursive self-reference on the SAME PHYSICAL LINE as its own declaration is a DOCUMENTED, PRE-EXISTING limitation of hasSelfReference's line-granularity design -- verified unchanged from before #3498, not a regression (Codex C1 round-9 finding)", () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      'export const helper = (): void => { helper(); };\n',
    );
    const result = collectDeadExportAuditResult(root);
    // Document the actual (pre-existing, accepted-limitation) behavior:
    // `hasSelfReference` excludes by LINE NUMBER, not character position,
    // so a genuine reference sharing the declaration's own line is
    // indistinguishable from the declaration itself and gets excluded
    // too. Verified (see the issue thread) that this exact fixture
    // already misclassified identically on `main` before this PR ever
    // touched the no-`from` resolution this issue is about -- a general
    // limitation of the whole-file, line-based design (see the module
    // header and hasSelfReference's own doc comment), not something
    // #3498 introduced or is scoped to fix.
    assert.equal(
      findByName(result, 'helper').category,
      'unused',
      'documents the accepted, pre-existing false negative: a same-line ' +
        'recursive call is not detected as a self-reference -- if this ' +
        'ever starts failing, the limitation may have been fixed for ' +
        'real (update this test and the doc comments together)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('this repository, at its current state, has no unsuppressed dead/test-only export (regression guard for the acceptance criterion)', () => {
  const result = collectDeadExportAuditResult(REPO_ROOT);
  assert.deepEqual(
    result.findings.map((f) => `${f.file}:${f.name}`),
    [],
    'a new export was added without either a real production caller or a ' +
      '`// audit:ignore-dead-export: <reason>` suppression comment -- run ' +
      '`node scripts/audit-dead-exports.mjs --check` locally for the full table',
  );
});
