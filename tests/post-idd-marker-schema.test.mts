import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MARKER_TYPES } from '../src/scripts/post-idd-marker.mts';
import { loadJson } from '../src/scripts/validate-schemas.mts';

interface PostIddMarkerSchemaShape {
  properties: { type: { enum: string[] } };
}

const schema = loadJson(
  'schemas/post-idd-marker.schema.json',
) as PostIddMarkerSchemaShape;

/**
 * Compare a published enum with the runtime marker types as sets. Reports
 * the values only one side has, plus any value repeated in the enum.
 */
function diffEnumAgainstMarkerTypes(
  enumValues: readonly string[],
  markerTypes: readonly string[],
): { missing: string[]; extra: string[]; duplicates: string[] } {
  const published = new Set(enumValues);
  const runtime = new Set(markerTypes);
  return {
    missing: [...runtime].filter((type) => !published.has(type)),
    extra: [...published].filter((type) => !runtime.has(type)),
    duplicates: [
      ...new Set(
        enumValues.filter((type, i) => enumValues.indexOf(type) !== i),
      ),
    ],
  };
}

test('post-idd-marker schema type enum matches MARKER_TYPES as sets', () => {
  assert.deepEqual(
    diffEnumAgainstMarkerTypes(schema.properties.type.enum, MARKER_TYPES),
    { missing: [], extra: [], duplicates: [] },
  );
});

test('the drift comparison reports a value dropped from either side', () => {
  const runtime = ['claim', 'unclaim', 'scope-overrun'];
  assert.deepEqual(diffEnumAgainstMarkerTypes(['claim', 'unclaim'], runtime), {
    missing: ['scope-overrun'],
    extra: [],
    duplicates: [],
  });
  assert.deepEqual(
    diffEnumAgainstMarkerTypes(
      ['claim', 'unclaim', 'scope-overrun', 'bogus'],
      runtime,
    ),
    { missing: [], extra: ['bogus'], duplicates: [] },
  );
});
