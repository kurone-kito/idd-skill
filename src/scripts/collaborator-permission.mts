// idd-generated-from: src/scripts/collaborator-permission.mts
//
// The scripts/collaborator-permission.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Shared collaborator-permission lookups and forced-handoff authority
// helpers consumed by:
//
// - scripts/forced-handoff-marker.mjs
// - scripts/audit-pr-cleanup.mjs
// - scripts/pre-merge-readiness.mjs
// - scripts/live-status-digest.mjs
// - scripts/resume-claim-routing.mjs
//
// Replaces the five copy-pasted implementations that drifted in
// roadmap #745 / #748 / #754. Single source of truth so the next
// behavioural change lands in one place rather than five.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { normalizePolicyConfig } from './policy-helpers.mts';

const DEFAULT_POLICY_PATH = '.github/idd/config.json';

export interface CollaboratorPermission {
  permission: string;
  roleName: string;
}

export type CollaboratorPermissionCache = Map<string, CollaboratorPermission>;

export interface ForcedHandoffPolicy {
  mode: string;
  authorityPolicy: string;
}

/**
 * Fetch a collaborator's permission triple from the GitHub
 * collaborators-permission endpoint. Returns both the legacy
 * `permission` field (admin|write|read|none) and the granular
 * `role_name` (admin|maintain|write|triage|read|none or a custom
 * repository-role name). Callers apply each policy against the field
 * that matches its semantics — see `isAuthorizedForcedHandoffActor`.
 *
 * Failures (unreachable GitHub, missing collaborator, malformed JSON)
 * are swallowed and yield empty strings so the calling policy check
 * returns false (fail-closed).
 *
 * The `cache` is a per-caller Map so concurrent calls within one
 * script share lookups, but separate scripts don't share state.
 */
export function collaboratorPermission(
  owner: string,
  repo: string,
  login: unknown,
  cache?: CollaboratorPermissionCache,
): CollaboratorPermission {
  const normalizedLogin = String(login ?? '')
    .trim()
    .toLowerCase();
  // Scope the cache key by repository so a single Map can be safely
  // reused across owner/repo pairs without cross-repo poisoning of
  // authorization decisions.
  const cacheKey = `${owner}/${repo}:${normalizedLogin}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let permission = '';
  let roleName = '';
  try {
    const raw = execFileSync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalizedLogin)}/permission`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(raw) as {
      permission?: unknown;
      role_name?: unknown;
    };
    permission = String(parsed?.permission ?? '')
      .trim()
      .toLowerCase();
    roleName = String(parsed?.role_name ?? '')
      .trim()
      .toLowerCase();
  } catch {
    // both stay empty
  }
  const result: CollaboratorPermission = { permission, roleName };
  if (cache) {
    cache.set(cacheKey, result);
  }
  return result;
}

/**
 * Returns true when `login` is authorized to act as the `forcedBy`
 * actor for a forced-handoff marker under the given policy:
 *
 *   - `owners-and-maintainers-only` (default policy semantics):
 *     accepts `role_name == admin / maintain` and `permission == admin`
 *     as a backstop. Maintain role recognition requires `role_name`
 *     because the legacy `permission` field collapses maintain to
 *     write.
 *
 *   - `all-write-permission-actors`: above plus `role_name == write`
 *     and `permission == write` so custom write-base roles (whose
 *     `role_name` may be a custom string) still satisfy the loose
 *     policy via the legacy field.
 */
export function isAuthorizedForcedHandoffActor(
  owner: string,
  repo: string,
  login: unknown,
  policy: string,
  cache?: CollaboratorPermissionCache,
): boolean {
  const normalized = String(login ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  const { permission, roleName } = collaboratorPermission(
    owner,
    repo,
    normalized,
    cache,
  );
  if (policy === 'all-write-permission-actors') {
    return (
      roleName === 'admin' ||
      roleName === 'maintain' ||
      roleName === 'write' ||
      permission === 'admin' ||
      permission === 'write'
    );
  }
  return (
    roleName === 'admin' || roleName === 'maintain' || permission === 'admin'
  );
}

/**
 * Read `.github/idd/config.json` and return the normalized
 * forcedHandoff policy block, falling back to schema defaults
 * (`{ mode: "disabled", authorityPolicy: "owners-and-maintainers-only" }`)
 * when the file is missing or malformed. Pass a custom `configPath`
 * to read from a different location (useful for tests).
 */
export function readForcedHandoffPolicy(
  configPath: string = DEFAULT_POLICY_PATH,
): ForcedHandoffPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    raw = {};
  }
  const normalized = normalizePolicyConfig(raw);
  return {
    mode: normalized.forcedHandoff.mode,
    authorityPolicy: normalized.forcedHandoff.authorityPolicy,
  };
}

/**
 * Convenience helper that returns the forcedHandoff mode string
 * ("disabled" or "human-gated") from the configured policy file.
 */
export function readForcedHandoffMode(
  configPath: string = DEFAULT_POLICY_PATH,
): string {
  return readForcedHandoffPolicy(configPath).mode;
}

/**
 * Convenience helper that returns the forcedHandoff authority policy
 * string from the configured policy file.
 */
export function readForcedHandoffAuthorityPolicy(
  configPath: string = DEFAULT_POLICY_PATH,
): string {
  return readForcedHandoffPolicy(configPath).authorityPolicy;
}
