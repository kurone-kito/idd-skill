import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
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
    plan: { properties: { candidateRecord: Record<string, unknown> } };
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

/**
 * Drop documentation keywords for the drift comparison. Only `description` and
 * `title` entries whose value is a string are annotations: a property named
 * `description` or `title` holds a schema object and is still compared, and the
 * `required` arrays only hold those names as elements. `required` is sorted
 * because its order carries no meaning.
 */
function withoutDocumentation(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDocumentation);
  if (node === null || typeof node !== 'object') return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      (key === 'description' || key === 'title') &&
      typeof value === 'string'
    ) {
      continue;
    }
    copy[key] =
      key === 'required' && Array.isArray(value)
        ? [...value].sort()
        : withoutDocumentation(value);
  }
  return copy;
}

const driftKeys = ['type', 'required', 'properties', 'additionalProperties'];
const driftingKeys = (
  embedded: Record<string, unknown>,
  persisted: Record<string, unknown>,
): string[] =>
  driftKeys.filter(
    (key) =>
      !isDeepStrictEqual(
        withoutDocumentation({ [key]: embedded[key] }),
        withoutDocumentation({ [key]: persisted[key] }),
      ),
  );

test('provisional-decision result schema embeds the persisted record schema', () => {
  const embedded = resultSchema.properties.plan.properties.candidateRecord;

  assert.ok(
    embedded !== null && typeof embedded === 'object',
    'embedded candidateRecord exists',
  );
  assert.deepEqual(
    driftingKeys(embedded, recordSchema),
    [],
    'embedded candidateRecord drifted from provisional-decision-record.schema.json',
  );
  for (const key of driftKeys) {
    assert.ok(key in embedded, `embedded candidateRecord has ${key}`);
  }
});

test('provisional-decision embedded record drift check ignores only documentation', () => {
  const embeddedSchema =
    resultSchema.properties.plan.properties.candidateRecord;
  const clone = () => cloneJson(embeddedSchema) as Record<string, unknown>;
  const at = (
    root: unknown,
    ...path: (string | number)[]
  ): Record<string, unknown> =>
    path.reduce<unknown>(
      (node, key) => (node as Record<string | number, unknown>)[key],
      root,
    ) as Record<string, unknown>;

  // Reworded documentation and a reordered `required` list are not drift.
  const reworded = clone();
  at(reworded, 'properties', 'recordId').description = 'Reworded text.';
  at(reworded, 'properties', 'event').description = 'Reworded text.';
  (reworded.required as string[]).reverse();
  assert.deepEqual(driftingKeys(reworded, recordSchema), []);

  // Each compared key counts as drift, including constraints on properties
  // that are themselves named like annotations (`title`, `description`).
  const drifts: [string, (string | number)[], string, unknown][] = [
    ['type', [], 'type', 'array'],
    ['additionalProperties', [], 'additionalProperties', true],
    ['properties', ['properties', 'recordId'], 'pattern', '^[a-z]+$'],
    [
      'properties',
      ['properties', 'source', 'properties', 'snapshot', 'properties', 'title'],
      'minLength',
      2,
    ],
    [
      'properties',
      [
        'properties',
        'event',
        'oneOf',
        0,
        'properties',
        'selectedOption',
        'properties',
        'description',
      ],
      'minLength',
      2,
    ],
  ];
  for (const [key, path, property, value] of drifts) {
    const drifted = clone();
    at(drifted, ...path)[property] = value;
    assert.deepEqual(driftingKeys(drifted, recordSchema), [key]);
  }

  const fewerRequired = clone();
  (fewerRequired.required as string[]).pop();
  assert.deepEqual(driftingKeys(fewerRequired, recordSchema), ['required']);
});
