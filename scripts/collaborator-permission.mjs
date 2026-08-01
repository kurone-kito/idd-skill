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
import { readFileSync } from 'node:fs';
import { ghText } from './gh-exec.mjs';
import { operationalMarkerPrefix } from './marker-helpers.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';

const DEFAULT_POLICY_PATH = '.github/idd/config.json';
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
export function collaboratorPermission(owner, repo, login, cache) {
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
    const raw = ghText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(normalizedLogin)}/permission`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(raw);
    permission = String(parsed?.permission ?? '')
      .trim()
      .toLowerCase();
    roleName = String(parsed?.role_name ?? '')
      .trim()
      .toLowerCase();
  } catch {
    // both stay empty
  }
  const result = { permission, roleName };
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
  owner,
  repo,
  login,
  policy,
  cache,
) {
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
export function readForcedHandoffPolicy(configPath = DEFAULT_POLICY_PATH) {
  let raw;
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
export function readForcedHandoffMode(configPath = DEFAULT_POLICY_PATH) {
  return readForcedHandoffPolicy(configPath).mode;
}
/**
 * Convenience helper that returns the forcedHandoff authority policy
 * string from the configured policy file.
 */
export function readForcedHandoffAuthorityPolicy(
  configPath = DEFAULT_POLICY_PATH,
) {
  return readForcedHandoffPolicy(configPath).authorityPolicy;
}
/**
 * Resolve collaborator-marker-trust logins from a comment stream:
 * marker-authors-first (#1693). Only comment authors whose comment body is
 * itself marker-shaped per `isMarkerShaped` (default: any recognized
 * operational-marker prefix via `operationalMarkerPrefix`) are even
 * candidates; only those candidates get a collaborator-permission lookup,
 * and only Write/Maintain/Admin permission earns trust.
 *
 * Checking every unique comment author regardless of whether they ever
 * posted anything marker-shaped over-trusts ordinary commenters (anyone
 * with write+ access who merely left an unrelated comment would be treated
 * as a trusted marker actor) and wastes a permission lookup per unique
 * commenter. This mirrors `pre-merge-readiness.mts` /
 * `advisory-convergence.mts`'s identically-named local function (kept
 * local there rather than migrated here: both call `safeGhText` with
 * `GH_TEXT_LOOP_OPTIONS` loop-safety timeouts that this shared
 * `collaboratorPermission`-based implementation does not apply, and
 * `advisory-wait-state.mts`'s local variant intentionally narrows the
 * marker-shape predicate to advisory-wait markers only). New consumers
 * (`force-handoff.mts`, `external-check-waiver.mts`) call this instead of
 * hand-rolling a fourth/fifth "check every comment author" copy.
 *
 * Deliberately checks only the legacy `permission` field (admin/maintain/
 * write), matching the sibling implementations' `--jq '.permission'`
 * shape exactly rather than also checking `role_name` -- parity with the
 * sibling filter is an explicit acceptance criterion, and GitHub's legacy
 * `permission` field already collapses a `maintain` role to `write` (see
 * `collaboratorPermission`'s doc comment above), so a `role_name` check
 * would only widen trust, never narrow it, and would make "parity"
 * untestable against a real HTTP response shape.
 */
export function resolveTrustedCollaboratorMarkerLogins(
  owner,
  repo,
  comments,
  options = {},
) {
  const isMarkerShaped =
    options.isMarkerShaped ??
    ((body) => operationalMarkerPrefix(body) !== null);
  const markerAuthors = [
    ...new Set(
      comments
        .filter((comment) => isMarkerShaped(String(comment.body ?? '')))
        .map((comment) =>
          String(comment.author?.login ?? comment.user?.login ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
  return markerAuthors.filter((login) => {
    const { permission } = collaboratorPermission(
      owner,
      repo,
      login,
      options.cache,
    );
    return (
      permission === 'admin' ||
      permission === 'maintain' ||
      permission === 'write'
    );
  });
}
