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

test('a no-`from` export list re-exporting a BARE function with multiple TypeScript overload signatures is classified unused, not masked by the other overload lines (Copilot High-severity finding, post-reduction review)', () => {
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
        'last one recorded (a plain overwrite of a single-line map ' +
        'entry kept only the LAST signature line, so the EARLIER ' +
        'signature lines registered as false self-references and ' +
        'masked a genuinely dead export as production)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-`from` export list re-exporting the SECOND declarator of a bare, single-line multi-declarator `const` statement is classified unused, not masked by the whole statement counting as a self-reference (Copilot High-severity finding, post-reduction review)', () => {
  const root = makeFixtureRoot();
  try {
    write(
      root,
      'src/scripts/widget.mts',
      ['const other = 1, helper = 2;', '', 'export { helper };', ''].join('\n'),
    );
    const result = collectDeadExportAuditResult(root);
    assert.equal(
      findByName(result, 'helper').category,
      'unused',
      '`BARE_CONST_DECL_PATTERN` only ever captures the FIRST ' +
        'identifier in the declarator list -- before this fix, the ' +
        'SECOND declarator (`helper`) never got a real declaration ' +
        'line at all, so the no-`from` item fell back to the ' +
        "export-list's own line and the const statement's own " +
        '(unexcluded) mention of `helper` registered as a false ' +
        'self-reference, masking a genuinely unimported export as ' +
        'production',
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
