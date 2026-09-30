// idd-generated-from: src/scripts/discover-hint-cache.mts
//
// The scripts/discover-hint-cache.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Discover hint cache (kurone-kito/idd-skill#3588). Caches the complete
// output of a Discover enumeration helper as a short-lived *hint* on top of
// the host-local read cache contract in `github-api-read-cache.mts`. A hint
// only ranks candidates: the selected candidate's live A3/A4/A4.5/A5 gates,
// the claim post, roadmap-closure authority, and forced-handoff evidence
// never read from it. Opt-in through `githubApi.readCache.enabled`; when the
// feature is off or the caller has no usable identity, every function here
// degrades to the uncached behavior.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  defaultCredentialMaterial,
  loadReadCachePolicy,
  serverUrlHost,
} from './gh-exec.mjs';
import {
  readThroughGithubApiCache,
  readThroughGithubApiCacheAsync,
} from './github-api-read-cache.mjs';

/** Bumped when a helper's cached output shape changes incompatibly. */
const HINT_FORMAT_VERSION = 1;
/** Cache-namespace names; each yields a distinct entry identity. */
const HINT_UNIT = 'discover-hint';
const GENERATION_UNIT = 'discover-hint-generation';
// Completeness collector. The two helper code paths that today only warn on
// stderr (search-result cap, skipped root) and the orphan filter's
// unresolvable candidates also record a reason here, so a partial read is
// never stored and never reported as a complete inventory.
let activeIncompleteReasons = null;
/** Record that the current Discover computation is not a complete read. */
export function noteDiscoveryIncomplete(reason) {
  activeIncompleteReasons?.push(reason);
}
async function computeTracked(compute) {
  const previous = activeIncompleteReasons;
  const reasons = [];
  activeIncompleteReasons = reasons;
  try {
    return { report: await compute(), reasons };
  } finally {
    activeIncompleteReasons = previous;
  }
}
/**
 * Parse a GitHub-style remote URL locally (https, ssh, scp-like, git). It
 * never contacts the network; an unparsable URL yields `null`.
 */
export function parseRemoteUrl(url) {
  const trimmed = url.trim();
  const scp =
    /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    );
  const uri =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const match = uri ?? scp;
  if (!match) return null;
  const [, host, owner, repo] = match;
  if (!host || !owner || !repo) return null;
  return { host: host.toLowerCase(), owner, repo };
}
function defaultOriginUrl(cwd) {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function secretEnv(env) {
  return [
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.GH_ENTERPRISE_TOKEN,
    env.GITHUB_ENTERPRISE_TOKEN,
  ].filter((value) => typeof value === 'string');
}
/**
 * Resolve the cache identity **without any network call**: repo from an
 * explicit pair or the origin remote, host from `GH_HOST`, then
 * `GITHUB_SERVER_URL`, then the origin remote (never `gh auth status`, which
 * calls the API), and credential material from the delivered local lookup.
 * `null` means the feature is off or the caller cannot be identified, so the
 * cache is bypassed rather than keyed under a guessed identity.
 */
function resolveConfig(request, deps) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const policy = deps.policy ?? loadReadCachePolicy(undefined);
  if (!policy.enabled) return null;
  const remoteUrl = (deps.originUrl ?? (() => defaultOriginUrl(cwd)))();
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  const host =
    env.GH_HOST?.trim().toLowerCase() ||
    serverUrlHost(env) ||
    remote?.host ||
    '';
  if (host === '') return null;
  const repository =
    request.owner && request.repo
      ? `${request.owner}/${request.repo}`
      : remote
        ? `${remote.owner}/${remote.repo}`
        : '';
  if (repository === '') return null;
  const credentialMaterial = (deps.credential ?? defaultCredentialMaterial)(
    host,
  )?.trim();
  if (!credentialMaterial) return null;
  return {
    policy,
    host,
    repository,
    credentialMaterial,
    secrets: [...secretEnv(env), credentialMaterial],
    cwd,
  };
}
function baseInput(config, deps) {
  return {
    classification: 'read',
    host: config.host,
    repository: config.repository,
    credentialMaterial: config.credentialMaterial,
    secretMaterial: config.secrets,
    workspaceRoot: config.cwd,
    cwd: config.cwd,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.storage ? { storage: deps.storage } : {}),
    ...(deps.defaultDirectory
      ? { defaultDirectory: deps.defaultDirectory }
      : {}),
  };
}
/**
 * The generation token. Every hint key includes it, so overwriting it
 * invalidates every discover hint in O(1) without touching any other cache
 * entry. A missing or evicted token is minted under the hint lease (so
 * concurrent mints coalesce), which only ever costs one extra miss.
 */
function readGeneration(config, deps) {
  const result = readThroughGithubApiCache({
    ...baseInput(config, deps),
    mode: 'hint',
    // The token must outlive every hint, so it is fresh for the whole
    // retention window rather than the short hint window.
    policy: { ...config.policy, maxAgeMs: config.policy.retentionMs },
    requestShape: { unit: GENERATION_UNIT },
    fetch: () => ({ status: 200, body: randomUUID() }),
  });
  if (result.cache !== 'hit' && result.cache !== 'miss') return null;
  return typeof result.body === 'string' ? result.body : null;
}
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function isStoredHint(value) {
  if (typeof value !== 'object' || value === null) return false;
  const record = value;
  return typeof record.generatedAt === 'number' && 'report' in record;
}
function idFlags(env) {
  const flags = {};
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith('IDD_')) flags[name] = env[name] ?? '';
  }
  return flags;
}
function hintKeyInputs(request, config, generation, env) {
  return {
    helper: request.helper,
    formatVersion: HINT_FORMAT_VERSION,
    args: request.args,
    policy: request.policy,
    env: idFlags(env),
    worktree: safeRealpath(config.cwd),
    generation,
  };
}
async function readOnce(request, config, generation, mode) {
  const deps = request.deps ?? {};
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const box = {
    tracked: null,
  };
  let enumerations = 0;
  const fetch = async () => {
    enumerations += 1;
    const tracked = await computeTracked(request.compute);
    box.tracked = tracked;
    return {
      status: 200,
      body: {
        generatedAt: now(),
        report: toPlainJson(tracked.report),
      },
      incomplete: tracked.reasons.length > 0,
    };
  };
  let derived;
  try {
    derived = hintKeyInputs(request, config, generation, env);
  } catch {
    derived = null;
  }
  const result = await readThroughGithubApiCacheAsync({
    ...baseInput(config, deps),
    mode,
    policy: config.policy,
    requestShape: { unit: HINT_UNIT },
    derivedInputs: derived,
    fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.leaseMaxWaitMs ? { leaseMaxWaitMs: deps.leaseMaxWaitMs } : {}),
  });
  const served = result.cache === 'hit' && isStoredHint(result.body);
  if (served) {
    const stored = result.body;
    return {
      report: stored.report,
      source: 'hint',
      ageMs: Math.max(0, now() - stored.generatedAt),
      complete: true,
      enumerations,
    };
  }
  // A miss, degraded read, or bypass all computed live; when the injected
  // fetch never ran (should not happen) fall back to computing directly so
  // a caller never receives an empty report.
  let live = box.tracked;
  if (live === null) {
    live = await computeTracked(request.compute);
    enumerations += 1;
  }
  return {
    report: live.report,
    source: 'live',
    ageMs: 0,
    complete: live.reasons.length === 0,
    enumerations,
  };
}
/**
 * Produce a Discover helper's report through the hint cache.
 *
 * - `noCache`: compute live, touch nothing (`mode: "off"`).
 * - feature off or identity unresolved: compute live (`mode: "bypass"`, and
 *   the `cache` object is omitted entirely when no cache flag was passed
 *   and the feature is off, keeping today's output byte-identical).
 * - `refreshCache`: recompute strict-fresh and store (`mode: "refresh"`).
 * - otherwise a hint read; a *hit that shows no startable candidate* triggers
 *   exactly one strict-fresh recompute (`exhaustionRefresh: true`) before the
 *   caller may treat the result as exhausted. A failed refresh throws; a
 *   partial one is reported `complete: false`, never as exhaustion.
 */
export async function readDiscoverHint(request) {
  const deps = request.deps ?? {};
  const flagged = request.noCache === true || request.refreshCache === true;
  const policy = deps.policy ?? loadReadCachePolicy(undefined);
  const active = policy.enabled === true;
  // Identity resolution spawns local processes, so it is skipped entirely
  // while the feature is off.
  const config = active ? resolveConfig(request, { ...deps, policy }) : null;
  if (request.noCache === true) {
    const live = await computeTracked(request.compute);
    return {
      report: live.report,
      cache: meta('off', 'live', 0, 0, live.reasons.length === 0, 1, false),
    };
  }
  if (!active || config === null) {
    const live = await computeTracked(request.compute);
    if (!active && !flagged) return { report: live.report };
    return {
      report: live.report,
      cache: meta(
        'bypass',
        'live',
        0,
        active ? policy.maxAgeMs : 0,
        live.reasons.length === 0,
        1,
        false,
      ),
    };
  }
  const generation = readGeneration(config, deps);
  if (generation === null) {
    const live = await computeTracked(request.compute);
    return {
      report: live.report,
      cache: meta(
        'bypass',
        'live',
        0,
        policy.maxAgeMs,
        live.reasons.length === 0,
        1,
        false,
      ),
    };
  }
  const first = await readOnce(
    request,
    config,
    generation,
    request.refreshCache === true ? 'strict-fresh' : 'hint',
  );
  if (
    first.source === 'hint' &&
    request.refreshCache !== true &&
    !request.hasCandidate(first.report)
  ) {
    const refreshed = await readOnce(
      request,
      config,
      generation,
      'strict-fresh',
    );
    return {
      report: refreshed.report,
      cache: meta(
        'hint',
        refreshed.source,
        refreshed.ageMs,
        policy.maxAgeMs,
        refreshed.complete,
        first.enumerations + refreshed.enumerations,
        true,
      ),
    };
  }
  return {
    report: first.report,
    cache: meta(
      request.refreshCache === true ? 'refresh' : 'hint',
      first.source,
      first.ageMs,
      policy.maxAgeMs,
      first.complete,
      first.enumerations,
      false,
    ),
  };
}
function meta(
  mode,
  source,
  ageMs,
  maxAgeMs,
  complete,
  enumerations,
  exhaustionRefresh,
) {
  return {
    mode,
    source,
    ageMs,
    maxAgeMs,
    complete,
    enumerations,
    exhaustionRefresh,
  };
}
/**
 * Invalidate every discover hint after an observed local mutation (claim,
 * unclaim, merge, closure). Best effort: it never throws, never blocks the
 * calling helper, and is a no-op when the cache is off or the caller cannot
 * be identified. Writes outside the helper paths are discovered by
 * `--refresh-cache`, the exhaustion refresh, or the hint's max age.
 */
export function invalidateDiscoverHints(request = {}, deps = {}) {
  try {
    const config = resolveConfig(request, deps);
    if (config === null) return false;
    const token = randomUUID();
    readThroughGithubApiCache({
      ...baseInput(config, deps),
      mode: 'strict-fresh',
      policy: { ...config.policy, maxAgeMs: config.policy.retentionMs },
      requestShape: { unit: GENERATION_UNIT },
      fetch: () => ({ status: 200, body: token }),
    });
    // The write is best effort inside the cache, so confirm it landed.
    return readGeneration(config, deps) === token;
  } catch {
    return false;
  }
}
/**
 * Purge the host-local read cache (the delivered `operation: "purge"`), which
 * removes every cached body from disk, not only discover hints. Works even
 * when the cache is disabled so a stale directory can always be cleaned.
 */
export function purgeDiscoverHints(deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const policy = deps.policy ?? loadReadCachePolicy(undefined);
  const result = readThroughGithubApiCache({
    classification: 'read',
    operation: 'purge',
    policy,
    host: '',
    repository: '',
    credentialMaterial: '',
    requestShape: null,
    workspaceRoot: cwd,
    cwd,
    fetch: () => ({ status: 200, body: null }),
    ...(deps.storage ? { storage: deps.storage } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.defaultDirectory
      ? { defaultDirectory: deps.defaultDirectory }
      : {}),
  });
  return {
    cache: result.cache === 'purged' ? 'purged' : 'refused',
    removed: result.removed ?? 0,
  };
}
