import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkSchemaKeywords,
  loadJson,
  validate,
} from '../src/scripts/validate-schemas.mts';

const schema = loadJson('schemas/provisional-decision.schema.json');
const results = loadJson(
  'tests/fixtures/provisional-decision-results.json',
) as unknown[];
const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('provisional-decision result schema validates all four states', () => {
  assert.deepEqual(checkSchemaKeywords(schema), []);
  assert.deepEqual(
    results.map((result) => (result as { state: string }).state),
    ['planned', 'applied', 'reconciled', 'refused'],
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
  const planned = cloneJson(results[0]) as PlannedResult;
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
