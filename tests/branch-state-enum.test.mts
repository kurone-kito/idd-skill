import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as branchConflictState from '../src/scripts/branch-conflict-state.mts';

// The branch-state names are hand-copied into two template docs. The schema
// wins if either copy drifts. This file binds those copies, and the
// classifier's own name lists, to schemas/branch-conflict-state.schema.json
// (issue #4404). The docs are read only; they are never written.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_PATH = 'schemas/branch-conflict-state.schema.json';
const POLICY_CONSTANTS_DOC = 'idd-template/docs/policy-constants.md';
const HELPER_REFERENCE_DOC = 'idd-template/docs/idd-helper-scripts.md';

// Schema names the classifier never returns. Recorded on purpose (#2458).
const BRANCH_STATE_REMAINDER = ['force-push-exception'];
const SYNC_RECOMMENDATION_REMAINDER = [
  'policy-required-update',
  'force-push-exception',
];

// Fixed copies of the two line shapes, for the negative checks. The negatives
// test the comparison itself, so they must not depend on the live docs.
const TAXONOMY_ROW =
  '| Branch-state taxonomy (`branchState`) | `clean`, `behind-no-conflict`, `content-conflict`, `dirty`, `force-push-exception`, `computing`, `unknown` | notes |';
const SYNC_BULLET = [
  '- `syncRecommendation` values: `none`, `merge-base`, `policy-required-update`,',
  '  `force-push-exception`, `recheck`, `hold-unknown` (`recheck` pairs with',
  '  `computing`)',
  '',
].join('\n');

type SchemaField = 'branchState' | 'syncRecommendation';

interface BranchConflictSchema {
  properties: Record<SchemaField, { enum: string[] }>;
}

// Compile-time only. `Equals` is `false` unless the two types are identical,
// and `AssertTrue<false>` is a type error. The guards are used in a test below,
// so a field widened to `string` makes `pnpm typecheck` fail.
type Identity<T> = <U>() => U extends T ? 1 : 2;
type Equals<A, B> = Identity<A> extends Identity<B> ? true : false;
type AssertTrue<T extends true> = T;
type DerivedBranchStateIsUnion = AssertTrue<
  Equals<
    branchConflictState.BranchStateDerivation['branchState'],
    (typeof branchConflictState.DERIVED_BRANCH_STATES)[number]
  >
>;
type DerivedSyncRecommendationIsUnion = AssertTrue<
  Equals<
    branchConflictState.BranchStateDerivation['syncRecommendation'],
    (typeof branchConflictState.DERIVED_SYNC_RECOMMENDATIONS)[number]
  >
>;
// The arrays must stay `as const`. Without it both element types widen to
// `string`, so the two guards above still pass while the narrowing is lost.
type BranchStatesAreLiteral = AssertTrue<
  string extends (typeof branchConflictState.DERIVED_BRANCH_STATES)[number]
    ? false
    : true
>;
type SyncRecommendationsAreLiteral = AssertTrue<
  string extends (typeof branchConflictState.DERIVED_SYNC_RECOMMENDATIONS)[number]
    ? false
    : true
>;

const schema = JSON.parse(
  readFileSync(join(REPO_ROOT, SCHEMA_PATH), 'utf8'),
) as BranchConflictSchema;
const policyConstantsDoc = readFileSync(
  join(REPO_ROOT, POLICY_CONSTANTS_DOC),
  'utf8',
);
const helperReferenceDoc = readFileSync(
  join(REPO_ROOT, HELPER_REFERENCE_DOC),
  'utf8',
);

const BACKTICK_NAME = /`([^`]+)`/g;

// Every backtick-quoted name in `text`, in order.
function namesIn(text: string): string[] {
  return [...text.matchAll(BACKTICK_NAME)].map((match) => match[1]);
}

// The one line that starts with `prefix`. Any other count fails the test.
function singleLineStarting(doc: string, prefix: string): string {
  const lines = doc.split('\n').filter((line) => line.startsWith(prefix));
  assert.equal(
    lines.length,
    1,
    `expected exactly one line starting with: ${prefix}`,
  );
  return lines[0];
}

// The taxonomy row line. Its second `|` cell holds the branchState names; the
// first cell is the label, which also has `branchState` in backticks.
function taxonomyRowLine(doc: string): string {
  return singleLineStarting(doc, '| Branch-state taxonomy');
}

function taxonomyRowNames(row: string): string[] {
  return namesIn(row.split('|')[2]);
}

// A helper bullet starts at "- `<field>` values:" and runs to the next line
// that starts a new bullet or is blank. Its names come before the first "(";
// the gloss after that parenthesis repeats names and is not part of the list.
function helperBulletNames(doc: string, field: SchemaField): string[] {
  const lines = doc.split('\n');
  const label = `- \`${field}\` values:`;
  const starts = lines.flatMap((line, index) =>
    line.startsWith(label) ? [index] : [],
  );
  assert.equal(starts.length, 1, `expected exactly one bullet for ${field}`);
  const [start] = starts;
  const bullet = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*- /.test(line)) {
      break;
    }
    bullet.push(line);
  }
  const text = bullet.join(' ');
  const afterLabel = text.slice(text.indexOf('values:') + 'values:'.length);
  return namesIn(afterLabel.split('(')[0]);
}

// Order-sensitive exact match of `listed` against the schema enum. Each kind
// of drift is named so a failure says what changed.
function enumDrift(schemaNames: readonly string[], listed: readonly string[]) {
  const problems: string[] = [];
  const missing = schemaNames.filter((name) => !listed.includes(name));
  const extra = listed.filter((name) => !schemaNames.includes(name));
  const duplicates = listed.filter(
    (name, index) => listed.indexOf(name) !== index,
  );
  if (missing.length > 0) {
    problems.push(`missing: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`extra: ${extra.join(', ')}`);
  }
  if (duplicates.length > 0) {
    problems.push(`duplicate: ${duplicates.join(', ')}`);
  }
  if (problems.length === 0 && listed.join('\n') !== schemaNames.join('\n')) {
    problems.push('same names in a different order');
  }
  return problems;
}

// Every derived name must be a schema name with no duplicates, and the schema
// names the derived array leaves out must be exactly the recorded remainder.
function remainderDrift(
  schemaNames: readonly string[],
  derived: readonly string[],
  recorded: readonly string[],
) {
  const problems: string[] = [];
  const outside = derived.filter((name) => !schemaNames.includes(name));
  if (outside.length > 0) {
    problems.push(`derived but not in the schema: ${outside.join(', ')}`);
  }
  const duplicates = derived.filter(
    (name, index) => derived.indexOf(name) !== index,
  );
  if (duplicates.length > 0) {
    problems.push(`derived duplicate: ${duplicates.join(', ')}`);
  }
  const remainder = schemaNames.filter((name) => !derived.includes(name));
  if (remainder.join('\n') !== recorded.join('\n')) {
    problems.push(
      `schema names left out (${remainder.join(', ')}) differ from the recorded remainder (${recorded.join(', ')})`,
    );
  }
  return problems;
}

const schemaNames = (field: SchemaField): string[] => [
  ...schema.properties[field].enum,
];

test('the taxonomy row and the helper bullets name the schema enums, in order', () => {
  assert.deepEqual(
    enumDrift(
      schemaNames('branchState'),
      taxonomyRowNames(taxonomyRowLine(policyConstantsDoc)),
    ),
    [],
    'the taxonomy row differs from the branchState enum',
  );
  assert.deepEqual(
    enumDrift(
      schemaNames('branchState'),
      helperBulletNames(helperReferenceDoc, 'branchState'),
    ),
    [],
    'the branchState helper bullet differs from the branchState enum',
  );
  assert.deepEqual(
    enumDrift(
      schemaNames('syncRecommendation'),
      helperBulletNames(helperReferenceDoc, 'syncRecommendation'),
    ),
    [],
    'the syncRecommendation helper bullet differs from the enum',
  );
});

// Compile-time check: the annotations below fail typecheck unless each
// BranchStateDerivation field is exactly the union of its derived array, and
// each array stays a literal tuple. The runtime body is trivially true and
// adds no coverage of its own.
test('compile-time: each BranchStateDerivation field is the closed union of its derived array', () => {
  const proofs: [
    DerivedBranchStateIsUnion,
    DerivedSyncRecommendationIsUnion,
    BranchStatesAreLiteral,
    SyncRecommendationsAreLiteral,
  ] = [true, true, true, true];
  assert.deepEqual(proofs, [true, true, true, true]);
});

test('the derived arrays are schema names, and the schema names they omit are the recorded remainder', () => {
  assert.deepEqual(
    remainderDrift(
      schemaNames('branchState'),
      branchConflictState.DERIVED_BRANCH_STATES,
      BRANCH_STATE_REMAINDER,
    ),
    [],
  );
  assert.deepEqual(
    remainderDrift(
      schemaNames('syncRecommendation'),
      branchConflictState.DERIVED_SYNC_RECOMMENDATIONS,
      SYNC_RECOMMENDATION_REMAINDER,
    ),
    [],
  );
});

// One classifier input per branch of deriveBranchState, plus the missing-SHA
// early return of classifyBranchConflictState. The offline seams (_testPrData
// and _skipGitProbe) keep these hermetic: no git and no gh call is made.
const SHA = 'a'.repeat(40);
const CLASSIFIER_INPUTS = [
  { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
  { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' },
  { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
  { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
  { mergeable: 'WEIRD', mergeStateStatus: 'WEIRD' },
  { headRefOid: '', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
];

test('the derived arrays hold exactly the names the classifier returns', async () => {
  const branchStates = new Set<string>();
  const syncRecommendations = new Set<string>();
  for (const input of CLASSIFIER_INPUTS) {
    const result = await branchConflictState.classifyBranchConflictState(1, {
      _skipGitProbe: true,
      _testPrData: {
        headRefOid: SHA,
        baseRefOid: SHA,
        headRefName: 'issue/fixture',
        baseRefName: 'main',
        ...input,
      },
    });
    branchStates.add(result.branchState);
    syncRecommendations.add(result.syncRecommendation);
  }
  assert.deepEqual(
    [...branchStates].sort(),
    [...branchConflictState.DERIVED_BRANCH_STATES].sort(),
  );
  assert.deepEqual(
    [...syncRecommendations].sort(),
    [...branchConflictState.DERIVED_SYNC_RECOMMENDATIONS].sort(),
  );
});

test('a taxonomy row that omits computing fails the comparison', () => {
  const mutated = TAXONOMY_ROW.replace('`computing`, ', '');
  assert.notEqual(mutated, TAXONOMY_ROW, 'the mutation did not apply');
  assert.deepEqual(
    enumDrift(schemaNames('branchState'), taxonomyRowNames(TAXONOMY_ROW)),
    [],
  );
  assert.deepEqual(
    enumDrift(schemaNames('branchState'), taxonomyRowNames(mutated)),
    ['missing: computing'],
  );
});

test('a syncRecommendation bullet without hold-unknown before the gloss fails', () => {
  const mutated = SYNC_BULLET.replace(
    '`recheck`, `hold-unknown` (`recheck` pairs with',
    '`recheck` (`recheck` pairs with',
  );
  assert.notEqual(mutated, SYNC_BULLET, 'the mutation did not apply');
  assert.deepEqual(
    enumDrift(
      schemaNames('syncRecommendation'),
      helperBulletNames(SYNC_BULLET, 'syncRecommendation'),
    ),
    [],
  );
  assert.deepEqual(
    enumDrift(
      schemaNames('syncRecommendation'),
      helperBulletNames(mutated, 'syncRecommendation'),
    ),
    ['missing: hold-unknown'],
  );
});

test('a gloss that repeats a schema name does not count as a name', () => {
  // The gloss after "(" repeats `computing`; it is cut away, so the names
  // before it still match the enum exactly.
  assert.match(SYNC_BULLET, /\(`recheck` pairs with\s+`computing`\)/);
  assert.deepEqual(
    enumDrift(
      schemaNames('syncRecommendation'),
      helperBulletNames(SYNC_BULLET, 'syncRecommendation'),
    ),
    [],
  );
});

test('an indented nested bullet ends a helper bullet and adds no names', () => {
  const nested = [
    '- `syncRecommendation` values: `none`, `merge-base`, `policy-required-update`,',
    '  `force-push-exception`, `recheck`, `hold-unknown`',
    '  - `nested-name` is not part of the list',
    '',
  ].join('\n');
  assert.deepEqual(
    enumDrift(
      schemaNames('syncRecommendation'),
      helperBulletNames(nested, 'syncRecommendation'),
    ),
    [],
  );
});

test('a synthetic schema enum that adds a name fails both checks', () => {
  const synthetic = structuredClone(schema);
  synthetic.properties.branchState.enum.push('not-a-state');
  const names = [...synthetic.properties.branchState.enum];
  assert.deepEqual(enumDrift(names, taxonomyRowNames(TAXONOMY_ROW)), [
    'missing: not-a-state',
  ]);
  const remainder = remainderDrift(
    names,
    branchConflictState.DERIVED_BRANCH_STATES,
    BRANCH_STATE_REMAINDER,
  );
  assert.equal(remainder.length, 1);
  assert.match(remainder[0], /not-a-state/);

  // The same check for syncRecommendation, against the fixed bullet fixture.
  const syncSynthetic = structuredClone(schema);
  syncSynthetic.properties.syncRecommendation.enum.push('not-a-state');
  const syncNames = [...syncSynthetic.properties.syncRecommendation.enum];
  assert.deepEqual(
    enumDrift(syncNames, helperBulletNames(SYNC_BULLET, 'syncRecommendation')),
    ['missing: not-a-state'],
  );
  const syncRemainder = remainderDrift(
    syncNames,
    branchConflictState.DERIVED_SYNC_RECOMMENDATIONS,
    SYNC_RECOMMENDATION_REMAINDER,
  );
  assert.equal(syncRemainder.length, 1);
  assert.match(syncRemainder[0], /not-a-state/);
});
