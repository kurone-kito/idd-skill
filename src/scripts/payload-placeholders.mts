// idd-generated-from: src/scripts/payload-placeholders.mts
//
// The scripts/payload-placeholders.mjs copy is generated from this .mts source
// by `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// Placeholder-to-field mapping for the installed instruction payload (#3822).
// When the agent reads the payload rather than the repository's own copy, each
// placeholder means the value of its mapped effective-policy field. The table
// in idd-template/docs/onboarding/placeholders.md mirrors this constant, and a
// test keeps the two in step.

import { type ActivationResult, computeActivation } from './idd-activation.mts';
import { loadLayeredLocalPolicy } from './idd-config.mts';

/**
 * Where one placeholder's value comes from. `policy` reads a dotted path in
 * the effective policy. `policy-first-entry` reads the first entry of a list.
 * `repository-name` is derived from the repository itself, not from policy.
 */
export type PayloadPlaceholderSource =
  | { kind: 'policy'; path: string }
  | { kind: 'policy-first-entry'; path: string }
  | { kind: 'repository-name' };

/** Keys are placeholder names without their braces. */
export const PAYLOAD_PLACEHOLDER_FIELDS: Readonly<
  Record<string, PayloadPlaceholderSource>
> = Object.freeze({
  PROJECT_MARKER_PREFIX: { kind: 'policy', path: 'markerPrefix' },
  REPO_NAME: { kind: 'repository-name' },
  INSTALL_DEPS_COMMAND: { kind: 'policy', path: 'commands.install-deps' },
  TRUSTED_MARKER_ACTOR: {
    kind: 'policy-first-entry',
    path: 'trustedMarkerActors',
  },
  FIX_VALIDATE_COMMANDS: { kind: 'policy', path: 'commands.fix-validate' },
  PRE_PUSH_VALIDATE_COMMANDS: {
    kind: 'policy',
    path: 'commands.pre-push-validate',
  },
  POST_FIX_VALIDATE_COMMANDS: {
    kind: 'policy',
    path: 'commands.post-fix-validate',
  },
});

function readPolicyPath(policy: unknown, path: string): unknown {
  let value: unknown = policy;
  for (const segment of path.split('.')) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return hasText(value);
}

/**
 * The warnings for a payload-served repository whose effective policy lacks a
 * field that a placeholder needs. Only the `user-global-override` tier serves
 * the payload, so every other tier returns no warnings.
 */
export function evaluatePayloadPolicyCoverage(options: {
  activation: ActivationResult;
  policy: unknown;
}): string[] {
  if (options.activation.tier !== 'user-global-override') return [];
  const warnings: string[] = [];
  for (const [name, source] of Object.entries(PAYLOAD_PLACEHOLDER_FIELDS)) {
    if (source.kind === 'repository-name') continue;
    const value = readPolicyPath(options.policy, source.path);
    const present =
      source.kind === 'policy-first-entry'
        ? Array.isArray(value) && hasText(value[0])
        : hasValue(value);
    if (!present) {
      warnings.push(
        `payload-served repository: effective policy lacks ${source.path}, which the {{${name}}} placeholder needs`,
      );
    }
  }
  return warnings;
}

/**
 * The doctor's entry point: compute the activation for `cwd` and check the
 * effective policy against it. A failure to compute either is reported as a
 * warning, so the doctor never silently skips the check.
 */
export function payloadPolicyCoverageWarnings(cwd: string): string[] {
  try {
    const activation = computeActivation({ cwd });
    if (activation.tier !== 'user-global-override') return [];
    const loaded = loadLayeredLocalPolicy({ cwd });
    return evaluatePayloadPolicyCoverage({
      activation,
      policy: loaded.config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`payload policy coverage could not be checked: ${message}`];
  }
}
