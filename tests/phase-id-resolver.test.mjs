import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createPhaseIdResolver,
  normalizePhaseIdToken,
  resolvePhaseId,
} from '../scripts/phase-id-resolver.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('resolves canonical IDs without mutation', () => {
  const result = resolvePhaseId('A4_5');
  assert.equal(result.canonicalPhaseId, 'A4_5');
  assert.equal(result.matchedBy, 'canonical');
});

test('includes A0 as a canonical phase ID', () => {
  const result = resolvePhaseId('A0');
  assert.equal(result.canonicalPhaseId, 'A0');
  assert.equal(result.matchedBy, 'canonical');
});

test('resolves dotted and hyphen aliases to canonical IDs', () => {
  assert.equal(resolvePhaseId('A4.5').canonicalPhaseId, 'A4_5');
  assert.equal(resolvePhaseId('A4-5').canonicalPhaseId, 'A4_5');
});

test('resolves documented legacy aliases to canonical IDs', () => {
  const aliases = {
    A0_O: ['A0-O', 'A0O'],
    A0_T: ['A0-T', 'A0T'],
    A1_5: ['A1.5', 'A1-5', 'A15'],
    A3_5: ['A3.5', 'A3-5', 'A35'],
    A4_5: ['A4.5', 'A4-5', 'A45'],
    F2_5: ['F2.5', 'F2-5', 'F25'],
  };

  for (const [canonical, variants] of Object.entries(aliases)) {
    for (const variant of variants) {
      const result = resolvePhaseId(variant);
      assert.equal(
        result.canonicalPhaseId,
        canonical,
        `${variant} -> ${canonical}`,
      );
      assert.equal(result.matchedBy, 'legacy-alias');
    }
  }
});

test('normalization is deterministic across repeated separators', () => {
  assert.equal(normalizePhaseIdToken('  a4...5  '), 'A4_5');
  assert.equal(normalizePhaseIdToken('A4---5'), 'A4_5');
  assert.equal(normalizePhaseIdToken('A4/5'), 'A4_5');
  assert.equal(normalizePhaseIdToken('A4 : 5'), 'A4_5');
  assert.equal(normalizePhaseIdToken('A4\\5'), 'A4_5');
});

test('throws explicit unknown phase diagnostics for unsupported IDs', () => {
  assert.throws(
    () => resolvePhaseId('Z99'),
    (error) => error && error.code === 'unknown_phase_id',
  );
});

test('throws explicit invalid diagnostics for malformed IDs', () => {
  assert.throws(
    () => resolvePhaseId('A4$5'),
    (error) => error && error.code === 'invalid_phase_id',
  );
});

test('throws explicit invalid diagnostics for unsupported alias punctuation', () => {
  for (const alias of ['A4(5)', 'A4,5', 'A4#5']) {
    assert.throws(
      () => resolvePhaseId(alias),
      (error) => error && error.code === 'invalid_phase_id',
    );
  }
});

test('detects ambiguous alias configuration', () => {
  assert.throws(
    () =>
      createPhaseIdResolver({
        canonicalPhaseIds: ['A4_5', 'F2_5'],
        legacyAliases: {
          A4_5: ['X-5'],
          F2_5: ['x-5'],
        },
      }),
    (error) => error && error.code === 'ambiguous_alias_configuration',
  );
});

test('CLI prints canonical machine-facing output', () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/phase-id-resolver.mjs'), '--phase-id', 'A4.5'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.canonicalPhaseId, 'A4_5');
  assert.equal(parsed.matchedBy, 'legacy-alias');
});

test('phase-graph edges remain valid under normalized phase IDs', () => {
  const graph = readJson('schemas/phase-graph.json');
  const normalizedNodeIds = graph.nodes.map((node) =>
    normalizePhaseIdToken(node.id),
  );
  const normalizedNodeSet = new Set(normalizedNodeIds);

  assert.equal(
    normalizedNodeSet.size,
    normalizedNodeIds.length,
    'phase-graph IDs must stay unique after normalization',
  );

  for (const node of graph.nodes) {
    for (const edge of node.next) {
      const normalizedEdge = normalizePhaseIdToken(edge);
      assert.ok(
        normalizedNodeSet.has(normalizedEdge),
        `normalized edge ${edge} -> ${normalizedEdge} is not defined in graph nodes`,
      );
    }
  }
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}
