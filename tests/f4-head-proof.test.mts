#!/usr/bin/env node

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderF4HeadProofBody } from '../src/scripts/f4-head-proof.mts';

type Fields = Parameters<typeof renderF4HeadProofBody>[0];

// Seven distinct token values plus a distinct agentId, so a swapped field
// changes the rendered body and fails the equality check below.
const VALID: Fields = {
  pr: '3741',
  claim: 'claim-fixture',
  branch: 'issue/fixture',
  f2: '1111111111111111111111111111111111111111',
  branchTip: '2222222222222222222222222222222222222222',
  merge: '3333333333333333333333333333333333333333',
  head: '4444444444444444444444444444444444444444',
  agentId: 'agent-fixture',
};

// Taken from the `printf` pair in the F4 Head Proof section of
// idd-template/docs/idd-resume-detail.md: the token line, a blank line,
// and the visible note, with no trailing newline.
const EXPECTED_BODY =
  '<!-- idd-f4-head-proof: v2 pr=3741 claim=claim-fixture branch=issue/fixture f2=1111111111111111111111111111111111111111 branch-tip=2222222222222222222222222222222222222222 merge=3333333333333333333333333333333333333333 head=4444444444444444444444444444444444444444 -->\n\n_agent-fixture: F4 head-proof marker. Do not edit._';

const SHA_FIELDS = ['f2', 'branchTip', 'merge', 'head'] as const;

/** One invalid input: the field it breaks, the bad value, and the error class. */
interface InvalidCase {
  label: string;
  field: keyof Fields;
  value: unknown;
  errorName: 'TypeError' | 'RangeError';
}

const INVALID_CASES: InvalidCase[] = [
  { label: 'pr of 0', field: 'pr', value: '0', errorName: 'RangeError' },
  { label: 'pr of -1', field: 'pr', value: '-1', errorName: 'RangeError' },
  { label: 'pr of 1.5', field: 'pr', value: '1.5', errorName: 'RangeError' },
  { label: 'an empty pr', field: 'pr', value: '', errorName: 'RangeError' },
  { label: 'pr of +3', field: 'pr', value: '+3', errorName: 'RangeError' },
  { label: 'pr of 00', field: 'pr', value: '00', errorName: 'RangeError' },
  {
    label: 'pr of 9007199254740992',
    field: 'pr',
    value: '9007199254740992',
    errorName: 'RangeError',
  },
  {
    label: 'pr given as a number',
    field: 'pr',
    value: 3741,
    errorName: 'TypeError',
  },
  {
    label: 'pr of 1 followed by 399 zeros',
    field: 'pr',
    value: `1${'0'.repeat(399)}`,
    errorName: 'RangeError',
  },
  ...SHA_FIELDS.flatMap((field): InvalidCase[] => [
    {
      label: `an uppercase ${field}`,
      field,
      value: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      errorName: 'RangeError',
    },
    {
      label: `a 39-character ${field}`,
      field,
      value: 'a'.repeat(39),
      errorName: 'RangeError',
    },
    {
      label: `a 41-character ${field}`,
      field,
      value: 'a'.repeat(41),
      errorName: 'RangeError',
    },
  ]),
  {
    label: 'an empty claim',
    field: 'claim',
    value: '',
    errorName: 'RangeError',
  },
  {
    label: 'an empty agentId',
    field: 'agentId',
    value: '',
    errorName: 'RangeError',
  },
  {
    label: 'an empty branch',
    field: 'branch',
    value: '',
    errorName: 'RangeError',
  },
  {
    label: 'a claim with a space',
    field: 'claim',
    value: 'claim fixture',
    errorName: 'RangeError',
  },
  {
    label: 'a claim with a control character (U+0007)',
    field: 'claim',
    value: 'claim\u0007fixture',
    errorName: 'RangeError',
  },
  {
    label: 'a claim containing >',
    field: 'claim',
    value: 'claim-->',
    errorName: 'RangeError',
  },
  {
    label: 'an agentId containing >',
    field: 'agentId',
    value: 'agent>fixture',
    errorName: 'RangeError',
  },
  {
    label: 'a claim containing <!--',
    field: 'claim',
    value: 'claim<!--fixture',
    errorName: 'RangeError',
  },
  {
    label: 'a branch containing <!--',
    field: 'branch',
    value: 'issue/<!--fixture',
    errorName: 'RangeError',
  },
  {
    label: 'an agentId containing <!--',
    field: 'agentId',
    value: 'agent<!--fixture',
    errorName: 'RangeError',
  },
  {
    label: 'a branch containing >',
    field: 'branch',
    value: 'issue/fixture>',
    errorName: 'RangeError',
  },
  {
    label: 'a branch with whitespace',
    field: 'branch',
    value: 'issue/\tfixture',
    errorName: 'RangeError',
  },
  {
    label: 'a branch with a control character',
    field: 'branch',
    value: 'issue/\u0000fixture',
    errorName: 'RangeError',
  },
  {
    label: 'an agentId with whitespace',
    field: 'agentId',
    value: 'agent fixture',
    errorName: 'RangeError',
  },
  {
    label: 'an agentId with a control character',
    field: 'agentId',
    value: 'agent\u001bfixture',
    errorName: 'RangeError',
  },
];

describe('renderF4HeadProofBody', () => {
  it('renders the v2 body for the fixed fixture', () => {
    assert.strictEqual(renderF4HeadProofBody(VALID), EXPECTED_BODY);
  });

  it('accepts pr at Number.MAX_SAFE_INTEGER', () => {
    const body = renderF4HeadProofBody({ ...VALID, pr: '9007199254740991' });

    assert.ok(
      body.startsWith(
        '<!-- idd-f4-head-proof: v2 pr=9007199254740991 claim=claim-fixture ',
      ),
    );
  });

  for (const invalid of INVALID_CASES) {
    it(`throws for ${invalid.label}`, () => {
      const fields = { ...VALID, [invalid.field]: invalid.value } as Fields;

      assert.throws(() => renderF4HeadProofBody(fields), {
        name: invalid.errorName,
        message: new RegExp(`^f4-head-proof: ${invalid.field} must `),
      });
    });
  }
});
