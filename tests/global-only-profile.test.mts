import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GLOBAL_ONLY_WORKFLOW_CHECK_NAMES,
  GLOBAL_ONLY_WORKFLOW_PATH,
  isGlobalOnlyActivation,
  resolveGlobalOnlyIgnoredCheckNames,
} from '../src/scripts/global-only-profile.mts';
import type { ActivationResult } from '../src/scripts/idd-activation.mts';

function activation(
  partial: Partial<ActivationResult> & Pick<ActivationResult, 'reason'>,
): ActivationResult {
  return {
    active: true,
    tier: 'repository-local',
    instructionsRoot: '/payload/root',
    ...partial,
  };
}

test('the minimal-import and user-global override reasons are global-only', () => {
  assert.equal(
    isGlobalOnlyActivation(
      activation({ reason: 'repository-policy-minimal-import' }),
    ),
    true,
  );
  assert.equal(
    isGlobalOnlyActivation(
      activation({
        tier: 'user-global-override',
        reason: 'user-global-override-match',
      }),
    ),
    true,
  );
});

test('a repository-local install and an inactive result are not global-only', () => {
  assert.equal(
    isGlobalOnlyActivation(
      activation({ tier: 'repository-local', reason: 'some-local-reason' }),
    ),
    false,
  );
  assert.equal(
    isGlobalOnlyActivation({
      active: false,
      tier: 'none',
      instructionsRoot: null,
      reason: 'repository-policy-minimal-import',
    }),
    false,
  );
});

test('the ignored names need both a global-only activation and an absent base workflow', () => {
  const globalOnly = activation({ reason: 'repository-policy-minimal-import' });
  assert.deepEqual(
    resolveGlobalOnlyIgnoredCheckNames({
      activation: globalOnly,
      baseWorkflowAbsent: true,
    }),
    [...GLOBAL_ONLY_WORKFLOW_CHECK_NAMES],
  );
  assert.deepEqual(
    resolveGlobalOnlyIgnoredCheckNames({
      activation: globalOnly,
      baseWorkflowAbsent: false,
    }),
    [],
    'a base workflow that is present keeps the check required',
  );
  assert.deepEqual(
    resolveGlobalOnlyIgnoredCheckNames({
      activation: activation({ reason: 'some-local-reason' }),
      baseWorkflowAbsent: true,
    }),
    [],
    'a repository-local install keeps the check required',
  );
});

test('the governed check and its workflow path name the advisory convergence workflow', () => {
  assert.deepEqual(
    [...GLOBAL_ONLY_WORKFLOW_CHECK_NAMES],
    ['idd-advisory-convergence'],
  );
  assert.equal(
    GLOBAL_ONLY_WORKFLOW_PATH,
    '.github/workflows/idd-advisory-convergence.yml',
  );
});
