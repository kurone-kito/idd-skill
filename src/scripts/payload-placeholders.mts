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
 * Reasons whose activation serves the installed payload as `instructionsRoot`.
 * `repository-policy-minimal-import` is a repository with only a policy file,
 * and `user-global-override-match` is a repository matched by a user-global
 * override. Both use the `repository-local` or `user-global-override` tier,
 * so the tier alone cannot tell them from a repository that serves its own
 * instruction files.
 */
const PAYLOAD_SERVED_REASONS: ReadonlySet<string> = new Set([
  'repository-policy-minimal-import',
  'user-global-override-match',
]);

/** Whether the activation serves the installed payload, not its own files. */
export function servesInstalledPayload(activation: ActivationResult): boolean {
  return (
    activation.active &&
    activation.instructionsRoot !== null &&
    PAYLOAD_SERVED_REASONS.has(activation.reason)
  );
}

/**
 * The warnings for a payload-served repository whose effective policy lacks a
 * field that a placeholder needs. Every other activation returns no warnings.
 */
export function evaluatePayloadPolicyCoverage(options: {
  activation: ActivationResult;
  policy: unknown;
}): string[] {
  if (!servesInstalledPayload(options.activation)) return [];
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
 * effective policy against it. `env` and `homedir` reach both the activation
 * and the policy load, so a test can place the installed payload in a scratch
 * home. A failure to compute either is reported as a warning, so the doctor
 * never silently skips the check.
 */
export function payloadPolicyCoverageWarnings(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; homedir?: string } = {},
): string[] {
  try {
    const activation = computeActivation({ cwd, ...options });
    if (!servesInstalledPayload(activation)) return [];
    const loaded = loadLayeredLocalPolicy({ cwd, ...options });
    return evaluatePayloadPolicyCoverage({
      activation,
      policy: loaded.config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`payload policy coverage could not be checked: ${message}`];
  }
}
