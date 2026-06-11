import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseClaimComment,
  parseForcedHandoffComment,
} from '../src/scripts/protocol-helpers.mts';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
  validateFixture,
  validatePhaseGraph,
} from '../src/scripts/validate-schemas.mts';

// Structural views of loaded JSON fixtures. Tests mutate or spread the
// parsed documents to probe schema acceptance, so these casts stay
// deliberately loose — the schema, not the type system, is under test.
type JsonRecord = Record<string, unknown>;
type PolicyFixture = JsonRecord & { advisoryWait: { requestCap?: unknown } };

// ---------------------------------------------------------------------------
// Schema keyword hygiene — no unsupported keywords allowed
// ---------------------------------------------------------------------------

test('claim-marker schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/claim-marker.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('forced-handoff-marker schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/forced-handoff-marker.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('live-status-digest schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/live-status-digest.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('advisory-wait-state schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/advisory-wait-state.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('pre-merge-readiness schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/pre-merge-readiness.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('pre-merge-readiness schema publishes metadata fields', () => {
  const schema = loadJson(
    'schemas/pre-merge-readiness.schema.json',
  ) as JsonRecord;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(
    schema.$id,
    'https://kurone-kito.github.io/idd-skill/schemas/pre-merge-readiness.schema.json',
  );
  assert.equal(schema.title, 'Pre-Merge Readiness');
  assert.equal(
    schema.description,
    'Read-only pre-merge readiness evidence snapshot for a PR head.',
  );
});

test('policy schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/policy.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('policy schema declares ciWait only once at the top level', () => {
  const schemaText = readFileSync(
    new URL('../schemas/policy.schema.json', import.meta.url),
    'utf8',
  );
  const ciWaitMatches = [...schemaText.matchAll(/^\s{4}"ciWait": \{$/gm)];
  assert.equal(ciWaitMatches.length, 1);
});

test('policy schema declares ciGate only once at the top level', () => {
  const schemaText = readFileSync(
    new URL('../schemas/policy.schema.json', import.meta.url),
    'utf8',
  );
  const ciGateMatches = [...schemaText.matchAll(/^\s{4}"ciGate": \{$/gm)];
  assert.equal(ciGateMatches.length, 1);
});

test('phase-graph schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/phase-graph.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('checkSchemaKeywords reports unsupported keywords', () => {
  const badSchema = {
    type: 'object',
    anyOf: [{ type: 'string' }],
  };
  const errors = checkSchemaKeywords(badSchema);
  assert.ok(errors.length > 0, 'Expected at least one error');
  assert.ok(
    errors.some((e) => e.includes('anyOf')),
    `Expected 'anyOf' in errors: ${errors}`,
  );
});

test('checkSchemaKeywords accepts exclusiveMinimum', () => {
  assert.deepEqual(
    checkSchemaKeywords({ type: 'number', exclusiveMinimum: 0 }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Fixture validation — valid fixtures must pass, invalid must fail
// ---------------------------------------------------------------------------

test('claim-marker valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/claim-marker.schema.json',
    'fixtures/schemas/claim-marker.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('claim-marker invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/claim-marker.schema.json',
    'fixtures/schemas/claim-marker.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('forced-handoff-marker valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/forced-handoff-marker.schema.json',
    'fixtures/schemas/forced-handoff-marker.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('forced-handoff-marker invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/forced-handoff-marker.schema.json',
    'fixtures/schemas/forced-handoff-marker.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('live-status-digest valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/live-status-digest.schema.json',
    'fixtures/schemas/live-status-digest.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('live-status-digest invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/live-status-digest.schema.json',
    'fixtures/schemas/live-status-digest.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('advisory-wait-state valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/advisory-wait-state.schema.json',
    'fixtures/schemas/advisory-wait-state.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('advisory-wait-state invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/advisory-wait-state.schema.json',
    'fixtures/schemas/advisory-wait-state.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('pre-merge-readiness valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/pre-merge-readiness.schema.json',
    'fixtures/schemas/pre-merge-readiness.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('pre-merge-readiness invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/pre-merge-readiness.schema.json',
    'fixtures/schemas/pre-merge-readiness.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('pre-merge-readiness valid fixture accepts fractional timestamp evidence', () => {
  const schema = loadJson('schemas/pre-merge-readiness.schema.json');
  const fixture = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/pre-merge-readiness.valid.json')),
  );
  fixture.reviewCurrency.watermark.maxActivityUpdatedAt =
    '2026-05-11T23:56:00.100Z';
  fixture.reviewCurrency.watermark.latestCiCompletedAt =
    '2026-05-11T23:57:00.200Z';
  fixture.reviewCurrency.watermark.createdAt = '2026-05-11T23:58:00.300Z';
  fixture.reviewCurrency.live.maxActivityUpdatedAt = '2026-05-11T23:56:00.400Z';
  fixture.reviewCurrency.live.latestCiCompletedAt = '2026-05-11T23:57:00.500Z';
  fixture.reviewCurrency.live.latestPassingCiCompletedAt =
    '2026-05-11T23:57:00.600Z';
  fixture.advisoryWait.earliestSameHeadAt = '2026-05-11T23:59:00.700Z';
  fixture.ci.checks[0].completedAt = '2026-05-11T23:57:00.800Z';
  fixture.claim.activeClaim.createdAt = '2026-05-11T23:20:00.900Z';

  const errors = validate(fixture, schema);
  assert.deepEqual(errors, []);
});

test('pre-merge-readiness count fields require non-negative integers', () => {
  const schema = loadJson('schemas/pre-merge-readiness.schema.json');
  const fixture = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/pre-merge-readiness.valid.json')),
  );
  fixture.reviewCurrency.watermark.totalItemCount = 1.5;
  fixture.reviewCurrency.live.counts.comments = -1;
  fixture.threads.unresolvedCount = 2.25;
  fixture.unrepliedComments.count = -1;
  fixture.reviewerStates.requiredApprovingReviewCount = 0.5;
  fixture.advisoryWait.sameHeadMarkerCount = -1;
  fixture.ci.requiredCheckCount = 3.5;

  const errors = validate(fixture, schema);
  assert.ok(
    errors.length > 0,
    'Expected fractional or negative counts to fail validation',
  );
});

test('integer validation reports non-integer numbers explicitly', () => {
  const errors = validate(1.5, { type: 'integer' });
  assert.deepEqual(errors, [
    '$: expected type "integer", got non-integer number 1.5',
  ]);
});

test('policy valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/policy.schema.json',
    'fixtures/schemas/policy.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('policy schema accepts the worktreeGuard opt-in object', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.worktreeGuard = { enabled: true, branchPatterns: ['issue/*'] };
  assert.deepEqual(validate(instance, schema), []);
});

test('policy schema treats missing worktreeGuard as advisory-only default', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  delete instance.worktreeGuard;
  assert.deepEqual(validate(instance, schema), []);
});

test('policy schema rejects an unknown worktreeGuard subkey', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.worktreeGuard = { enabled: true, bogus: 1 };
  assert.ok(
    validate(instance, schema).length > 0,
    'expected an unknown worktreeGuard subkey to be rejected',
  );
});

test('policy schema accepts missing helperRuntime as instructions-only fallback', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  delete instance.helperRuntime;
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts explicit issue-author approval opt-out', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.skipIssueAuthorApprovalGate = true;
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects non-boolean issue-author approval opt-out', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.skipIssueAuthorApprovalGate = 'true';
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.skipIssueAuthorApprovalGate')),
    errors.join('\n'),
  );
});

test('policy schema accepts every issueScope value including roadmap-first', () => {
  const schema = loadJson('schemas/policy.schema.json');
  for (const issueScope of ['roadmap', 'roadmap-first', 'orphan-first']) {
    const instance = JSON.parse(
      JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
    );
    instance.issueScope = issueScope;
    const errors = validate(instance, schema);
    assert.deepEqual(errors, [], `${issueScope}: ${JSON.stringify(errors)}`);
  }
});

test('policy schema rejects an unknown issueScope value', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueScope = 'roadmap-only';
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.issueScope')),
    errors.join('\n'),
  );
});

test('policy schema accepts an in-range autopilotSuitability floor', () => {
  const schema = loadJson('schemas/policy.schema.json');
  for (const floor of [1, 2, 3, 4, 5]) {
    const instance = JSON.parse(
      JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
    );
    instance.autopilotSuitability = { floor };
    const errors = validate(instance, schema);
    assert.deepEqual(errors, [], `floor ${floor}: ${errors.join('\n')}`);
  }
});

test('policy schema accepts autopilotSuitability.enabled and omitted floor', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.autopilotSuitability = { enabled: false };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects an out-of-range autopilotSuitability floor', () => {
  const schema = loadJson('schemas/policy.schema.json');
  for (const floor of [0, 6]) {
    const instance = JSON.parse(
      JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
    );
    instance.autopilotSuitability = { floor };
    const errors = validate(instance, schema);
    assert.ok(
      errors.some((error) => error.includes('$.autopilotSuitability.floor')),
      `floor ${floor} should be rejected: ${errors.join('\n')}`,
    );
  }
});

test('policy schema rejects a non-integer autopilotSuitability floor', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.autopilotSuitability = { floor: '3' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.autopilotSuitability.floor')),
    errors.join('\n'),
  );
});

test('policy schema rejects unknown keys inside autopilotSuitability', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.autopilotSuitability = { floor: 3, weight: 2 };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('additional property "weight"')),
    errors.join('\n'),
  );
});

test('policy schema accepts x-* extension keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance['x-local-note'] = 'opt-in';
  instance['x-local-flags'] = {
    dryRun: true,
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects unknown non x-* top-level keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.localNote = 'opt-in';
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('additional property "localNote"')),
    errors.join('\n'),
  );
});

test('validate reports invalid patternProperties regex without throwing', () => {
  const schema = {
    type: 'object',
    patternProperties: {
      '[invalid': {
        type: 'string',
      },
    },
    additionalProperties: false,
  };
  const errors = validate({ sample: 'value' }, schema);
  assert.ok(
    errors.some((error) =>
      error.includes('invalid patternProperties regex "[invalid"'),
    ),
    errors.join('\n'),
  );
});

test('validate applies patternProperties even for declared properties', () => {
  const schema = {
    type: 'object',
    properties: {
      foo: {
        type: 'string',
      },
    },
    patternProperties: {
      '^foo$': {
        minLength: 3,
      },
    },
    additionalProperties: false,
  };
  const failing = validate({ foo: 'ab' }, schema);
  assert.ok(
    failing.some((error) => error.includes('$.foo: length 2 < minLength 3')),
    failing.join('\n'),
  );
  const passing = validate({ foo: 'abc' }, schema);
  assert.deepEqual(passing, []);
});

test('policy invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/policy.schema.json',
    'fixtures/schemas/policy.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('phase-graph valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/phase-graph.schema.json',
    'fixtures/schemas/phase-graph.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('phase-graph invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/phase-graph.schema.json',
    'fixtures/schemas/phase-graph.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});

test('phase-graph.json data validates against phase-graph schema', () => {
  const { ok, errors } = validateFixture(
    'schemas/phase-graph.schema.json',
    'schemas/phase-graph.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('.github/idd/config.json validates against policy schema', () => {
  const { ok, errors } = validateFixture(
    'schemas/policy.schema.json',
    '.github/idd/config.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('policy schema accepts foundation policy namespaces', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects scalar values at forced-handoff object keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.forcedHandoff = 'human-gated';
  instance['forced-handoff'] = 'disabled';
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) =>
      error.includes('$.forcedHandoff: expected type "object"'),
    ),
    errors.join('\n'),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('$.forced-handoff: expected type "object"'),
    ),
    errors.join('\n'),
  );
});

test('policy schema accepts marker trust boolean aliases', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.markerTrustAllowCollaboratorMarkers = true;
  instance.allowCollaboratorMarkers = false;
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects non-positive advisory wait request cap', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.advisoryWait.requestCap = 0;
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.advisoryWait.requestCap')),
    errors.join('\n'),
  );
});

test('policy schema accepts explicit instructions-only helperRuntime', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.helperRuntime = { profile: 'instructions-only' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts explicit package-manager helperRuntime', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.helperRuntime = { profile: 'package-manager' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts explicit vendored-node helperRuntime', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.helperRuntime = { profile: 'vendored-node' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts explicit ephemeral-npx helperRuntime', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.helperRuntime = { profile: 'ephemeral-npx' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts owners-and-maintainers-only approval actors', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.maintainerApprovalActorPolicy = 'owners-and-maintainers-only';
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts all-write-permission approval actors', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.maintainerApprovalActorPolicy = 'all-write-permission-actors';
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects unsupported maintainer approval actor policy', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.maintainerApprovalActorPolicy = 'write-only';
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.maintainerApprovalActorPolicy')),
    errors.join('\n'),
  );
});

test('policy schema preserves legacy maintainerApprovalActors arrays', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.maintainerApprovalActors = ['owner', 'maintainer'];
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects empty legacy maintainerApprovalActors arrays', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.maintainerApprovalActors = [];
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((error) => error.includes('$.maintainerApprovalActors')),
    errors.join('\n'),
  );
});

test('policy schema rejects unsupported helperRuntime profiles', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = loadJson(
    'fixtures/schemas/policy.valid.json',
  ) as PolicyFixture;
  instance.helperRuntime = { profile: 'bun' };
  const errors = validate(instance, schema);
  assert.ok(errors.some((error) => error.includes('$.helperRuntime.profile')));
});

// ---------------------------------------------------------------------------
// Unsupported format values
// ---------------------------------------------------------------------------

test('checkSchemaKeywords reports unsupported format values', () => {
  const badSchema = { type: 'string', format: 'email' };
  const errors = checkSchemaKeywords(badSchema);
  assert.ok(errors.length > 0, 'Expected at least one error');
  assert.ok(
    errors.some((e) => e.includes('email')),
    `Expected 'email' in errors: ${errors}`,
  );
});

test('checkSchemaKeywords accepts supported format: date-time', () => {
  const goodSchema = { type: 'string', format: 'date-time' };
  assert.deepEqual(checkSchemaKeywords(goodSchema), []);
});

// ---------------------------------------------------------------------------
// Duration regex — must reject "P" and "PT" (no numeric component)
// ---------------------------------------------------------------------------

test("policy schema rejects bare 'P' as staleAge", () => {
  const schema = loadJson('schemas/policy.schema.json');
  const invalid = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  invalid.claimTiming.staleAge = 'P';
  const errors = validate(invalid, schema);
  assert.ok(errors.length > 0, "Expected 'P' to fail duration pattern");
});

test("policy schema rejects bare 'PT' as heartbeatInterval", () => {
  const schema = loadJson('schemas/policy.schema.json');
  const invalid = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  invalid.claimTiming.heartbeatInterval = 'PT';
  const errors = validate(invalid, schema);
  assert.ok(errors.length > 0, "Expected 'PT' to fail duration pattern");
});

test("policy schema rejects 'P1DT' (T with no time unit) as staleAge", () => {
  const schema = loadJson('schemas/policy.schema.json');
  const invalid = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  invalid.claimTiming.staleAge = 'P1DT';
  const errors = validate(invalid, schema);
  assert.ok(errors.length > 0, "Expected 'P1DT' to fail duration pattern");
});

test("policy schema rejects 'P1DT' (T with no time unit) as heartbeatInterval", () => {
  const schema = loadJson('schemas/policy.schema.json');
  const invalid = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  invalid.claimTiming.heartbeatInterval = 'P1DT';
  const errors = validate(invalid, schema);
  assert.ok(errors.length > 0, "Expected 'P1DT' to fail duration pattern");
});

test('policy schema accepts valid durations like PT24H, PT12H, P1D', () => {
  const schema = loadJson('schemas/policy.schema.json');
  for (const dur of ['PT24H', 'PT12H', 'P1D', 'P1DT30M', 'PT30M']) {
    const instance = JSON.parse(
      JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
    );
    instance.claimTiming.staleAge = dur;
    instance.claimTiming.heartbeatInterval = dur;
    const errors = validate(instance, schema);
    assert.deepEqual(
      errors,
      [],
      `Expected "${dur}" to pass but got: ${errors}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Runtime / schema drift prevention
// ---------------------------------------------------------------------------

test('protocol-helpers parseClaimComment output matches claim-marker schema', () => {
  const body = readFileSync(
    new URL('../fixtures/issue-comments/active-claim.md', import.meta.url),
    'utf8',
  );
  const parsed = parseClaimComment(body, '2026-05-09T10:00:00Z');
  assert.ok(parsed !== null, 'parseClaimComment returned null');

  const schema = loadJson('schemas/claim-marker.schema.json');
  const errors = validate(parsed, schema);
  assert.deepEqual(
    errors,
    [],
    `Schema/runtime drift detected:\n${errors.join('\n')}`,
  );
});

test('protocol-helpers parseForcedHandoffComment output matches forced-handoff schema', () => {
  const body = [
    '<!-- forced-handoff: {"old-agent-id":"github-copilot-cli-old","old-claim-id":"claim-20260512T090000Z-337-old","new-agent-id":"github-copilot-cli-new","new-claim-id":"claim-20260512T110000Z-337-new","branch":"issue/337-feat-protocol-add-auditable-forced","linked-pr":"341","forced-by":"kurone-kito","reason":"operator-approved-recovery","timestamp":"2026-05-12T11:00:00Z","context-scope":"issue-plus-pr"} -->',
    '',
    'Forced handoff approved by kurone-kito. I verified that the current',
    'owning session or agent is unavailable. This transfers ownership away',
    'from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.',
    'If the prior session resumes, it must stop immediately and must not',
    'push, comment, resolve review state, or merge until a maintainer',
    'reassigns ownership.',
  ].join('\n');
  const parsed = parseForcedHandoffComment(body, '2026-05-12T11:00:05Z');
  assert.ok(parsed !== null, 'parseForcedHandoffComment returned null');

  const schema = loadJson('schemas/forced-handoff-marker.schema.json');
  const errors = validate(parsed, schema);
  assert.deepEqual(
    errors,
    [],
    `Schema/runtime drift detected:\n${errors.join('\n')}`,
  );
});

test('forced-handoff schema rejects marker-breaking token values', () => {
  const schema = loadJson('schemas/forced-handoff-marker.schema.json');
  const base = loadJson(
    'fixtures/schemas/forced-handoff-marker.valid.json',
  ) as JsonRecord;

  for (const [field, value] of [
    ['oldAgentId', 'agent-->'],
    ['oldClaimId', 'claim<!--x'],
    ['newAgentId', 'new<!--x'],
    ['newClaimId', 'new-->'],
    ['branch', 'issue/337-<!--bad'],
    ['forcedBy', 'owner-->'],
    ['reason', 'operator-->note'],
  ]) {
    const instance = { ...base, [field]: value };
    const errors = validate(instance, schema);
    assert.ok(
      errors.length > 0,
      `Expected ${field}=${value} to fail schema validation`,
    );
  }
});

// ---------------------------------------------------------------------------
// Claim ID pattern — accepts opaque tokens including hyphens
// ---------------------------------------------------------------------------

test('claim-marker schema accepts hyphenated claim IDs', () => {
  const schema = loadJson('schemas/claim-marker.schema.json');
  const base = loadJson(
    'fixtures/schemas/claim-marker.valid.json',
  ) as JsonRecord;
  for (const id of ['abc-123', 'claim-1', '4018f4c673f8', 'x-y-z']) {
    const instance = { ...base, claimId: id };
    const errors = validate(instance, schema);
    assert.deepEqual(
      errors,
      [],
      `Expected "${id}" to be valid but got: ${errors}`,
    );
  }
});

test('claim-marker schema rejects claim IDs containing whitespace', () => {
  const schema = loadJson('schemas/claim-marker.schema.json');
  const base = loadJson(
    'fixtures/schemas/claim-marker.valid.json',
  ) as JsonRecord;
  for (const id of ['invalid id', 'has space', 'tab\there']) {
    const instance = { ...base, claimId: id };
    const errors = validate(instance, schema);
    assert.ok(errors.length > 0, `Expected "${id}" to fail pattern but passed`);
  }
});

// ---------------------------------------------------------------------------
// Phase-graph referential integrity
// ---------------------------------------------------------------------------

test('validatePhaseGraph accepts a valid graph', () => {
  const graph = {
    nodes: [
      { id: 'A', next: ['B'] },
      { id: 'B', next: [] },
    ],
  };
  assert.deepEqual(validatePhaseGraph(graph), []);
});

test('validatePhaseGraph reports dangling next reference', () => {
  const graph = { nodes: [{ id: 'A', next: ['missing'] }] };
  const errors = validatePhaseGraph(graph);
  assert.ok(errors.length > 0, 'Expected error for dangling reference');
  assert.ok(
    errors.some((e) => e.includes('missing')),
    `Expected 'missing' in errors: ${errors}`,
  );
});

test('validatePhaseGraph reports duplicate node ids', () => {
  const graph = {
    nodes: [
      { id: 'A', next: [] },
      { id: 'A', next: [] },
    ],
  };
  const errors = validatePhaseGraph(graph);
  assert.ok(
    errors.some((e) => e.includes('Duplicate')),
    `Expected duplicate error: ${errors}`,
  );
});

test('phase-graph.json has no dangling references', () => {
  const graph = loadJson('schemas/phase-graph.json');
  assert.deepEqual(validatePhaseGraph(graph), []);
});

// ---------------------------------------------------------------------------
// lastChecked — optional milliseconds in ISO 8601 timestamp
// ---------------------------------------------------------------------------

test('live-status-digest schema accepts lastChecked without milliseconds', () => {
  const schema = loadJson('schemas/live-status-digest.schema.json');
  const base = loadJson(
    'fixtures/schemas/live-status-digest.valid.json',
  ) as JsonRecord;
  const errors = validate(base, schema);
  assert.deepEqual(errors, [], `Expected no-ms timestamp to pass: ${errors}`);
});

test('live-status-digest schema accepts lastChecked with milliseconds', () => {
  const schema = loadJson('schemas/live-status-digest.schema.json');
  const base = loadJson(
    'fixtures/schemas/live-status-digest.valid.json',
  ) as JsonRecord;
  const instance = { ...base, lastChecked: '2026-01-01T00:00:00.123Z' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, [], `Expected ms timestamp to pass: ${errors}`);
});

// ---------------------------------------------------------------------------
// phase-graph invalid fixture — graph-invalid (dangling ref) is caught
// ---------------------------------------------------------------------------

test('phase-graph invalid fixture fails via graph validation (dangling ref)', () => {
  const { ok } = validateFixture(
    'schemas/phase-graph.schema.json',
    'fixtures/schemas/phase-graph.invalid.json',
    false,
  );
  assert.ok(
    ok,
    'Expected graph-invalid fixture to be caught by validateFixture',
  );
});

// ---------------------------------------------------------------------------
// policy schema — parameterization keys (#468, #470)
// ---------------------------------------------------------------------------

test('policy schema accepts ciWait.runningTimeout ISO 8601 duration', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = { runningTimeout: 'PT30M' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts ciWait.generationTimeout ISO 8601 duration', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = { generationTimeout: 'PT10M' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts ciWait.rerunPolicy values', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const rerunOnce = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  rerunOnce.ciWait = { rerunPolicy: 'rerun-once' };
  assert.deepEqual(validate(rerunOnce, schema), []);

  const hold = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  hold.ciWait = { rerunPolicy: 'hold' };
  assert.deepEqual(validate(hold, schema), []);
});

test('policy schema accepts ciWait without nested keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = {};
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects ciWait.runningTimeout non-duration string', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = { runningTimeout: '30 minutes' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciWait.generationTimeout empty duration (PT)', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = { generationTimeout: 'PT' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciWait.rerunPolicy unknown value', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciWait = { rerunPolicy: 'rerun-forever' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciWait')),
    errors.join('\n'),
  );
});

test('policy schema accepts ciGate selector and waiver policy keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalChecks: {
      advisory: [{ selector: 'Copilot code review', matchMode: 'exact' }],
      waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob' }],
    },
    externalCheckWaivers: {
      mode: 'maintainer-authorized',
      authorityPolicy: 'all-write-permission-actors',
      maxValidity: 'PT12H',
    },
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts ciGate without nested keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {};
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects ciGate empty selector arrays', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalChecks: {
      advisory: [],
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciGate selector entries without selector', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalChecks: {
      waivable: [{ matchMode: 'exact' }],
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciGate selector entries with unknown matchMode', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalChecks: {
      waivable: [{ selector: 'CodeRabbit*', matchMode: 'regex' }],
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciGate selector entries with unknown properties', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalChecks: {
      waivable: [{ selector: 'CodeRabbit*', matchMode: 'glob', extra: true }],
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciGate waiver mode unknown value', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalCheckWaivers: {
      mode: 'always-on',
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema rejects ciGate maxValidity empty duration (PT)', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.ciGate = {
    externalCheckWaivers: {
      maxValidity: 'PT',
    },
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('ciGate')),
    errors.join('\n'),
  );
});

test('policy schema accepts stallRecovery.quietWindow ISO 8601 duration', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.stallRecovery = { quietWindow: 'PT30M' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts stallRecovery without quietWindow', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.stallRecovery = {};
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects stallRecovery.quietWindow non-duration string', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.stallRecovery = { quietWindow: '30 minutes' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('stallRecovery')),
    errors.join('\n'),
  );
});

test('policy schema rejects stallRecovery.quietWindow empty duration (P)', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.stallRecovery = { quietWindow: 'P' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('stallRecovery')),
    errors.join('\n'),
  );
});

test('policy schema rejects stallRecovery.quietWindow empty time marker (PT)', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.stallRecovery = { quietWindow: 'PT' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('stallRecovery')),
    errors.join('\n'),
  );
});

test('policy schema accepts issueAuthoring authoring label and stale age', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringLabelName: 'status:authoring',
    authoringStaleAge: 'PT4H',
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts missing issueAuthoring object', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  delete instance.issueAuthoring;
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts issueAuthoring without maxClarificationRounds', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    authoringLabelName: 'status:authoring',
    authoringStaleAge: 'PT4H',
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts issueAuthoring without authoringLabelName', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringStaleAge: 'PT4H',
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts issueAuthoring without authoringStaleAge', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringLabelName: 'status:authoring',
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects issueAuthoring authoringLabelName empty string', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringLabelName: '',
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('issueAuthoring.authoringLabelName')),
    errors.join('\n'),
  );
});

test('policy schema rejects issueAuthoring authoringStaleAge non-duration string', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringStaleAge: 'not-a-duration',
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('issueAuthoring.authoringStaleAge')),
    errors.join('\n'),
  );
});

test('policy schema rejects issueAuthoring unexpected extra keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.issueAuthoring = {
    maxClarificationRounds: 3,
    authoringLabelName: 'status:authoring',
    authoringStaleAge: 'PT4H',
    unexpectedKey: true,
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some(
      (e) => e.includes('$.issueAuthoring') && e.includes('"unexpectedKey"'),
    ),
    errors.join('\n'),
  );
});

test('policy schema accepts forcedHandoff.mode human-gated', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.forcedHandoff = { mode: 'human-gated' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts forcedHandoff.mode disabled', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.forcedHandoff = { mode: 'disabled' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts forcedHandoff.authorityPolicy', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.forcedHandoff = { authorityPolicy: 'all-write-permission-actors' };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects forcedHandoff.mode unknown value', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.forcedHandoff = { mode: 'semi-gated' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('forcedHandoff')),
    errors.join('\n'),
  );
});

test('policy schema accepts markerTrust.allowCollaboratorMarkers true', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.markerTrust = { allowCollaboratorMarkers: true };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema accepts markerTrust.allowCollaboratorMarkers false', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.markerTrust = { allowCollaboratorMarkers: false };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects markerTrust.allowCollaboratorMarkers non-boolean', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.markerTrust = { allowCollaboratorMarkers: 'yes' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('markerTrust')),
    errors.join('\n'),
  );
});

test('policy schema accepts advisoryWait request cap and duration keys', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = {
    requestCap: 12,
    pendingWindow: 'PT45M',
    settledWindow: 'PT15M',
    pollInterval: 'PT3M',
    capExhaustedRoute: 'hold',
  };
  const errors = validate(instance, schema);
  assert.deepEqual(errors, []);
});

test('policy schema rejects advisoryWait.requestCap below 1', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { requestCap: 0 };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait.requestCap string values', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { requestCap: '1' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait pending/settled/poll durations when malformed', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = {
    pendingWindow: 'P1DT',
    settledWindow: 'PT',
    pollInterval: 'P',
  };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait lowercase duration values', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { pendingWindow: 'pt1m' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait zero-length durations', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { pendingWindow: 'PT0M' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait second-based durations', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { pollInterval: 'PT30S' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait.capExhaustedRoute unknown value', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { capExhaustedRoute: 'merge-anyway' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('policy schema rejects advisoryWait.capExhaustedRoute padded values', () => {
  const schema = loadJson('schemas/policy.schema.json');
  const instance = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  instance.advisoryWait = { capExhaustedRoute: ' hold ' };
  const errors = validate(instance, schema);
  assert.ok(
    errors.some((e) => e.includes('advisoryWait')),
    errors.join('\n'),
  );
});

test('validator enforces exclusiveMinimum for numbers', () => {
  assert.ok(validate(0, { type: 'number', exclusiveMinimum: 0 }).length > 0);
  assert.ok(validate(-1, { type: 'number', exclusiveMinimum: 0 }).length > 0);
  assert.deepEqual(validate(0.5, { type: 'number', exclusiveMinimum: 0 }), []);
});

test('advisory wait state schema rejects non-positive minute values', () => {
  const schema = loadJson('schemas/advisory-wait-state.schema.json');
  const fixture = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/advisory-wait-state.valid.json')),
  );
  fixture.pendingWindowMinutes = 0;
  fixture.settledWindowMinutes = -1;
  fixture.pollIntervalMinutes = 0;
  const errors = validate(fixture, schema);
  assert.ok(
    errors.some((e) => e.includes('exclusiveMinimum')),
    errors.join('\n'),
  );
});

test('pre-merge readiness schema rejects non-positive advisory wait minute values', () => {
  const schema = loadJson('schemas/pre-merge-readiness.schema.json');
  const fixture = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/pre-merge-readiness.valid.json')),
  );
  fixture.advisoryWait.pendingWindowMinutes = 0;
  fixture.advisoryWait.settledWindowMinutes = -1;
  fixture.advisoryWait.pollIntervalMinutes = 0;
  const errors = validate(fixture, schema);
  assert.ok(
    errors.some((e) => e.includes('exclusiveMinimum')),
    errors.join('\n'),
  );
});

test('branch-conflict-state schema uses only allowed keywords', () => {
  const schema = loadJson('schemas/branch-conflict-state.schema.json');
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test('branch-conflict-state schema publishes metadata fields', () => {
  const schema = loadJson(
    'schemas/branch-conflict-state.schema.json',
  ) as JsonRecord;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(
    schema.$id,
    'https://kurone-kito.github.io/idd-skill/schemas/branch-conflict-state.schema.json',
  );
  assert.equal(schema.title, 'Branch Conflict State');
});

test('branch-conflict-state valid fixture passes validation', () => {
  const { ok, errors } = validateFixture(
    'schemas/branch-conflict-state.schema.json',
    'fixtures/schemas/branch-conflict-state.valid.json',
    true,
  );
  assert.ok(ok, errors.join('\n'));
});

test('branch-conflict-state invalid fixture fails validation', () => {
  const { ok } = validateFixture(
    'schemas/branch-conflict-state.schema.json',
    'fixtures/schemas/branch-conflict-state.invalid.json',
    false,
  );
  assert.ok(ok, 'Expected invalid fixture to fail schema validation');
});
