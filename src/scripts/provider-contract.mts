// idd-generated-from: src/scripts/provider-contract.mts
//
// The scripts/provider-contract.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Provider-neutral adapter contract (#2265). Names the vocabulary a future
// GitLab/Bitbucket adapter would implement, without committing to one: this
// module imports nothing (no `node:child_process`, no `gh` invocation, no
// GitHub-specific response shape), so nothing here can accidentally depend
// on how the GitHub adapter (`gh-exec.mts`, `gh-http-status.mts`) works.
// `policy-helpers.mts` imports from this module, never the reverse; other
// modules (e.g. `idd-config.mts`) may import from it in the future without
// creating a cycle. See docs/provider-boundary.md for the design record
// this module implements. This foundation step keeps GitHub as the only
// functional provider; nothing in this repository consumes a non-GitHub
// provider yet.

/** Providers this contract names. Only `github` is implemented today. */
export const PROVIDER_IDS = ['github', 'gitlab', 'bitbucket'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Type guard for an untrusted value that should be a {@link ProviderId}. */
export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Provider-neutral capability groups a helper migration boundary maps to
 * (docs/provider-boundary.md): repository identity, work items, comments
 * and labels, claims, change requests, reviews and threads, checks,
 * permissions, branch protection, and merge. Stable identifiers, not
 * display strings.
 */
export const PROVIDER_CAPABILITY_GROUPS = [
  'repository-identity',
  'work-items',
  'comments-and-labels',
  'claims',
  'change-requests',
  'reviews-and-threads',
  'checks',
  'permissions',
  'branch-protection',
  'merge',
  /**
   * #2267: bot/advisory review interpretation (e.g. Copilot's own review
   * body), distinct from `reviews-and-threads`'s required unresolved-thread
   * safety gate -- a provider without an equivalent advisory reviewer
   * resolves this `not_applicable` (optional) while `reviews-and-threads`
   * stays required.
   */
  'advisory-review',
] as const;

export type ProviderCapabilityGroup =
  (typeof PROVIDER_CAPABILITY_GROUPS)[number];

/**
 * Whether a capability group is a required safety gate (unsupported must
 * fail closed) or an optional advisory capability (unsupported may resolve
 * to `not_applicable`). See {@link evaluateProviderCapabilityOutcome}.
 */
export const PROVIDER_CAPABILITY_REQUIREMENTS = [
  'required',
  'optional',
] as const;

export type ProviderCapabilityRequirement =
  (typeof PROVIDER_CAPABILITY_REQUIREMENTS)[number];

/** One provider adapter's declared support for one capability group. */
export interface ProviderCapabilityDeclaration {
  group: ProviderCapabilityGroup;
  requirement: ProviderCapabilityRequirement;
  supported: boolean;
}

export const PROVIDER_CAPABILITY_OUTCOMES = [
  'ok',
  'fail_closed',
  'not_applicable',
] as const;

export type ProviderCapabilityOutcome =
  (typeof PROVIDER_CAPABILITY_OUTCOMES)[number];

/**
 * The safety rule (#2265 proposed change): a supported capability always
 * resolves `ok`. An unsupported REQUIRED capability fails closed -- unsupported
 * behavior must never silently become a passing gate. An unsupported
 * OPTIONAL advisory capability may resolve `not_applicable`, kept distinct
 * from `ok` so a caller can still tell "not offered by this provider" from
 * "checked and passing".
 */
export function evaluateProviderCapabilityOutcome(
  declaration: ProviderCapabilityDeclaration,
): ProviderCapabilityOutcome {
  if (declaration.supported) {
    return 'ok';
  }
  return declaration.requirement === 'required'
    ? 'fail_closed'
    : 'not_applicable';
}

/**
 * Validate an untrusted capability declaration, throwing a descriptive
 * `TypeError` on any malformed shape -- the deterministic rejection path
 * for #2265 AC3's "malformed capability policy". Returns the same
 * declaration, narrowed, on success; never coerces a malformed field to a
 * default instead of rejecting it.
 */
export function assertProviderCapabilityDeclaration(
  value: unknown,
): ProviderCapabilityDeclaration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('provider capability declaration must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.group !== 'string' ||
    !(PROVIDER_CAPABILITY_GROUPS as readonly string[]).includes(candidate.group)
  ) {
    throw new TypeError(
      `provider capability declaration "group" must be one of ${PROVIDER_CAPABILITY_GROUPS.join(', ')}`,
    );
  }
  if (
    typeof candidate.requirement !== 'string' ||
    !(PROVIDER_CAPABILITY_REQUIREMENTS as readonly string[]).includes(
      candidate.requirement,
    )
  ) {
    throw new TypeError(
      `provider capability declaration "requirement" must be one of ${PROVIDER_CAPABILITY_REQUIREMENTS.join(', ')}`,
    );
  }
  if (typeof candidate.supported !== 'boolean') {
    throw new TypeError(
      'provider capability declaration "supported" must be a boolean',
    );
  }
  return {
    group: candidate.group as ProviderCapabilityGroup,
    requirement: candidate.requirement as ProviderCapabilityRequirement,
    supported: candidate.supported,
  };
}

/**
 * Provider-neutral locator for a repository. Every adapter resolves its
 * own platform identifiers (owner/org, project path, workspace slug, ...)
 * into this shape before handing it to workflow/domain helpers.
 */
export interface ProviderRepositoryLocator {
  provider: ProviderId;
  owner: string;
  name: string;
}

/**
 * Provider-neutral locator for a change request (GitHub pull request,
 * GitLab merge request, Bitbucket pull request).
 */
export interface ProviderChangeRequestLocator
  extends ProviderRepositoryLocator {
  number: number;
}

/**
 * Provider-neutral error categories a normalized adapter error collapses
 * into, independent of any one platform's status vocabulary. Mirrors the
 * classification `gh-http-status.mts` already derives from `gh`'s stderr
 * for GitHub, but names the concept that GitHub-specific module never had
 * to: a category a non-GitHub adapter can produce without depending on
 * GitHub's HTTP status codes at all.
 */
export const PROVIDER_ERROR_CATEGORIES = [
  'authentication',
  'authorization',
  'not-found',
  'rate-limited',
  'conflict',
  'validation',
  'unavailable',
  'unknown',
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

/** A normalized provider error, independent of any platform's response shape. */
export interface ProviderError {
  category: ProviderErrorCategory;
  message: string;
  /** The underlying platform error, kept for diagnostics only -- never inspected for control flow outside the adapter that produced it. */
  cause?: unknown;
}
