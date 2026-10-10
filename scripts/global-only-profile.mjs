// idd-generated-from: src/scripts/global-only-profile.mts
//
// The scripts/global-only-profile.mjs copy is generated from this .mts source
// by `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// #3824: a global-only profile runs IDD with no committed workflows. The
// template advisory-convergence workflow then never reports, so pre-merge
// readiness must not require its check. The profile is decided only from the
// installed payload (the activation reasons below) AND from the trusted base
// ref lacking the workflow file. A pull request can change neither, so it
// cannot switch the advisory gate off by deleting a workflow of its own.
/** The check that a template workflow produces and a global-only run may not require. */
export const GLOBAL_ONLY_WORKFLOW_CHECK_NAMES = Object.freeze([
  'idd-advisory-convergence',
]);
/** The template workflow behind those checks, read on the trusted base ref. */
export const GLOBAL_ONLY_WORKFLOW_PATH =
  '.github/workflows/idd-advisory-convergence.yml';
/**
 * Activation reasons that mean the instructions come from the installed
 * payload rather than from this repository's committed instruction files:
 * the minimal-import case (a policy document only) and the user-global
 * override case.
 */
const GLOBAL_ONLY_ACTIVATION_REASONS = new Set([
  'repository-policy-minimal-import',
  'user-global-override-match',
]);
/** True when an activation result names an installed-payload profile. */
export function isGlobalOnlyActivation(result) {
  return result.active && GLOBAL_ONLY_ACTIVATION_REASONS.has(result.reason);
}
/**
 * The check names a global-only run may leave out of its required list.
 * Empty unless the activation is global-only AND the trusted base ref has no
 * template workflow file (`baseWorkflowAbsent`). Fails closed: any unknown
 * input keeps the checks required.
 */
export function resolveGlobalOnlyIgnoredCheckNames(input) {
  if (!isGlobalOnlyActivation(input.activation)) return [];
  if (input.baseWorkflowAbsent !== true) return [];
  return [...GLOBAL_ONLY_WORKFLOW_CHECK_NAMES];
}
