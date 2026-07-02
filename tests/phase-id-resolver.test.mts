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
} from '../src/scripts/phase-id-resolver.mts';
import { readJson } from './test-utils.mts';

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
    (error) =>
      Boolean(error) &&
      (error as { code?: unknown }).code === 'unknown_phase_id',
  );
});

test('throws explicit invalid diagnostics for malformed IDs', () => {
  assert.throws(
    () => resolvePhaseId('A4$5'),
    (error) =>
      Boolean(error) &&
      (error as { code?: unknown }).code === 'invalid_phase_id',
  );
});

test('throws explicit invalid diagnostics for unsupported alias punctuation', () => {
  for (const alias of ['A4(5)', 'A4,5', 'A4#5']) {
    assert.throws(
      () => resolvePhaseId(alias),
      (error) =>
        Boolean(error) &&
        (error as { code?: unknown }).code === 'invalid_phase_id',
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
    (error) =>
      Boolean(error) &&
      (error as { code?: unknown }).code === 'ambiguous_alias_configuration',
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
  const graph = readJson('schemas/phase-graph.json') as {
    nodes: { id: string; next: string[] }[];
  };
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

test('resolves the documented Resume phase, preserving its configured casing', () => {
  assert.equal(resolvePhaseId('Resume').canonicalPhaseId, 'Resume');
  assert.equal(resolvePhaseId('resume').canonicalPhaseId, 'Resume');
  assert.equal(resolvePhaseId('RESUME').canonicalPhaseId, 'Resume');
});

test('emits a configured mixed-case canonical id with its original casing', () => {
  const resolution = resolvePhaseId('handoff', {
    canonicalPhaseIds: ['Handoff'],
    legacyAliases: {},
  });
  assert.equal(resolution.canonicalPhaseId, 'Handoff');
});

test('resolves separator-normalized canonical forms to the canonical id', () => {
  for (const input of ['A4---5', 'A4/5', 'A4 5', 'A4:5']) {
    assert.equal(
      resolvePhaseId(input).canonicalPhaseId,
      'A4_5',
      `${input} should resolve to A4_5`,
    );
  }
  // the dotted/hyphenated legacy aliases keep resolving as before
  assert.equal(resolvePhaseId('A4.5').canonicalPhaseId, 'A4_5');
  assert.equal(resolvePhaseId('A4.5').matchedBy, 'legacy-alias');
});

test('every resume-route-selection route resolves except the terminal stop sentinel', () => {
  // resume-route-selection.mts can route a resume into one of the phases in its
  // documented route enum (printHelp: "route": "D1|D4|E1|E15|Esync|F1|F2|stop").
  // Every *phase* route in that union must resolve through the canonical
  // phase-id resolver so the two helpers cannot drift apart; this guard fails if
  // resume-route-selection gains a documented route the resolver cannot resolve
  // (the reason `Esync` was reconciled into the canonical list). Two routes are
  // deliberately NOT canonical — documented here rather than silently added:
  //   - `stop` is a terminal control signal (stop-and-report), not a phase, so
  //     it must throw `unknown_phase_id` (asserted below).
  //   - bare `A` is the collapsed routing-graph-only node in
  //     schemas/phase-graph.json; resume-route-selection never emits it, and the
  //     canonical list enumerates the concrete discovery sub-phases A0..A5
  //     instead, so bare `A` is non-canonical and also throws (asserted below).
  //     (A broader "every phase-graph node resolves" guard is a separate
  //     concern, not this one.)
  const documentedRoutes = readResumeRouteEnum();
  const tableRoutes = readResumeDecisionTableRoutes();

  // The two in-file route descriptions (help-text enum and decision table) must
  // list the same routes, so a route added to one but not the other is caught.
  assert.deepEqual(
    [...new Set(documentedRoutes)].sort(),
    [...new Set(tableRoutes)].sort(),
    'resume-route-selection help enum and decision table must list the same routes',
  );
  assert.ok(
    documentedRoutes.includes('Esync'),
    'resume-route-selection route enum must include Esync',
  );

  const terminalSentinels = new Set(['stop']);
  for (const route of documentedRoutes) {
    if (terminalSentinels.has(route)) {
      assertUnknownPhaseId(route);
      continue;
    }
    const resolution = resolvePhaseId(route);
    // Assert canonical self-resolution, not merely "resolves to some canonical
    // id": resume routes are themselves canonical phases, so a future route
    // wired up as a legacy alias (matchedBy 'legacy-alias', or a canonicalPhaseId
    // other than the route) must fail this guard rather than silently pass.
    assert.equal(
      resolution.matchedBy,
      'canonical',
      `resume route ${route} must stay canonical in the phase-id resolver`,
    );
    assert.equal(
      resolution.canonicalPhaseId,
      route,
      `resume route ${route} must resolve to itself`,
    );
  }

  // Bare `A` is intentionally absent from the canonical list (see above).
  assertUnknownPhaseId('A');
});

function assertUnknownPhaseId(input: string): void {
  assert.throws(
    () => resolvePhaseId(input),
    (error) =>
      Boolean(error) &&
      (error as { code?: unknown }).code === 'unknown_phase_id',
    `${input} must not resolve as a canonical phase id`,
  );
}

function readResumeRouteSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'src/scripts/resume-route-selection.mts'),
    'utf8',
  );
}

function readResumeRouteEnum(): string[] {
  const match = readResumeRouteSource().match(/"route":\s*"([^"]+)"/);
  assert.ok(
    match,
    'resume-route-selection.mts must document its route enum as "route": "..."',
  );
  return (match[1] ?? '')
    .split('|')
    .map((route) => route.trim())
    .filter(Boolean);
}

function readResumeDecisionTableRoutes(): string[] {
  const routes = [
    ...readResumeRouteSource().matchAll(/route:\s*'([^']+)'/g),
  ].map((entry) => entry[1]);
  assert.ok(
    routes.length > 0,
    'resume-route-selection.mts decisionTable() must list route literals',
  );
  return routes;
}
