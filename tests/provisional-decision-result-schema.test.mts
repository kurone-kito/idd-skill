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
