import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';

type ResultFixture = {
  state: string;
  recordId: unknown;
  commentUrl: unknown;
};
type SchemaDocument = {
  properties: {
    recordId: { minLength?: number; pattern?: string };
  };
};
type RecordSchemaDocument = Record<string, unknown> & {
  properties: { recordId: { minLength?: number; pattern?: string } };
};

const schema = loadJson('schemas/provisional-decision.schema.json');
const resultSchema = schema as SchemaDocument;
const recordSchema = loadJson(
  'schemas/provisional-decision-record.schema.json',
) as RecordSchemaDocument;
const results = loadJson(
  'tests/fixtures/provisional-decision-results.json',
) as ResultFixture[];
const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const expectedStates = ['applied', 'planned', 'reconciled', 'refused'];

/** Look a fixture up by state so no test depends on the fixture file order. */
function byState(state: string): ResultFixture {
  const found = results.find((result) => result.state === state);
  assert.ok(found, `fixture for state ${state} should exist`);
  return found;
}

test('provisional-decision result schema validates all four states', () => {
  assert.deepEqual(checkSchemaKeywords(schema), []);
  assert.deepEqual(
    [...new Set(results.map((result) => result.state))].sort(),
    expectedStates,
  );

  for (const [index, result] of results.entries()) {
    assert.deepEqual(
      validate(result, schema),
      [],
      'result ' + index + ' should satisfy its state variant',
    );
  }
});

test('provisional-decision result schema rejects the invalid fixture', () => {
  const invalid = loadJson(
    'fixtures/schemas/provisional-decision.invalid.json',
  );

  assert.ok(validate(invalid, schema).length > 0);
});

test('provisional-decision result schema enforces the candidate record contract', () => {
  type PlannedResult = {
    plan: {
      candidateRecord: {
        recordId: string;
        claimLineage: unknown[];
        evidenceReferences: string[];
        event: Record<string, unknown>;
      };
    };
  };
  const planned = cloneJson(byState('planned')) as unknown as PlannedResult;
  assert.deepEqual(validate(planned, schema), []);
  const invalidCases: ((result: PlannedResult) => void)[] = [
    (result) => {
      result.plan.candidateRecord.recordId = '!';
    },
    (result) => {
      result.plan.candidateRecord.claimLineage = [];
    },
    (result) => {
      result.plan.candidateRecord.evidenceReferences = [];
    },
    (result) => {
      result.plan.candidateRecord.event = { type: 'unknown' };
    },
  ];

  for (const mutate of invalidCases) {
    const invalid = cloneJson(planned);
    mutate(invalid);
    assert.ok(validate(invalid, schema).length > 0);
  }
});

test('provisional-decision result schema constrains the record ID and comment URL', () => {
  const commentUrl =
    'https://github.com/kurone-kito/idd-skill/issues/5128#issuecomment-1';
  const withFields = (
    state: string,
    fields: Partial<ResultFixture>,
  ): ResultFixture => ({ ...cloneJson(byState(state)), ...fields });

  // The result's record ID constraints must stay equal to the persisted ones.
  assert.equal(
    resultSchema.properties.recordId.pattern,
    recordSchema.properties.recordId.pattern,
  );
  assert.equal(
    resultSchema.properties.recordId.minLength,
    recordSchema.properties.recordId.minLength,
  );

  const accepted: [string, Partial<ResultFixture>][] = [
    ['applied', {}],
    ['applied', { recordId: 'a'.repeat(128) }],
    ['applied', { recordId: 'record-1.2:3_x' }],
    ['applied', { commentUrl }],
    ['refused', { recordId: null, commentUrl: '' }],
  ];
  for (const [state, fields] of accepted) {
    assert.deepEqual(
      validate(withFields(state, fields), schema),
      [],
      `${state} ${JSON.stringify(fields)} should validate`,
    );
  }

  const rejected: [Partial<ResultFixture>, string][] = [
    [{ recordId: '' }, '$.recordId'],
    [{ recordId: '!' }, '$.recordId'],
    [{ recordId: 'a'.repeat(129) }, '$.recordId'],
    [{ recordId: 7 }, '$.recordId'],
    [{ commentUrl: 'not-a-url' }, '$.commentUrl'],
    [{ commentUrl: 'urn:example:comment' }, '$.commentUrl'],
    [{ commentUrl: ' ' }, '$.commentUrl'],
    // These match the http(s) pattern, so only the uri format rejects them.
    [{ commentUrl: 'https:///x' }, '$.commentUrl'],
    [{ commentUrl: 'https://github.com/%zz' }, '$.commentUrl'],
    [{ commentUrl: 7 }, '$.commentUrl'],
    [{ commentUrl: null }, '$.commentUrl'],
  ];
  for (const [fields, path] of rejected) {
    const errors = validate(withFields('applied', fields), schema);
    assert.ok(
      errors.some((error) => error.startsWith(path)),
      `${JSON.stringify(fields)} should fail on ${path}: ${errors}`,
    );
  }
});
