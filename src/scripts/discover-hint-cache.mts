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

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  defaultCredentialMaterial,
  loadReadCachePolicy,
  serverUrlHost,
} from './gh-exec.mts';
import {
  type GithubApiCacheFetchResult,
  type GithubApiReadCacheRuntimePolicy,
  type GithubApiReadCacheStorage,
  type ReadThroughGithubApiCacheAsyncInput,
  readThroughGithubApiCache,
  readThroughGithubApiCacheAsync,
} from './github-api-read-cache.mts';

/** Bumped when a helper's cached output shape changes incompatibly. */
const HINT_FORMAT_VERSION = 1;

/** Cache-namespace names; each yields a distinct entry identity. */
const HINT_UNIT = 'discover-hint';
const GENERATION_UNIT = 'discover-hint-generation';

export type DiscoverHintHelper =
  | 'discover-roadmap-graph'
  | 'discover-orphan-filter';

/** How a run related to the cache, reported in the additive `cache` output. */
export type DiscoverCacheMode = 'hint' | 'refresh' | 'off' | 'bypass';

/** The additive, optional `cache` object of a Discover helper's output. */
export interface DiscoverCacheMeta {
  mode: DiscoverCacheMode;
  /** `hint` when the output came from a stored hint, else `live`. */
  source: 'hint' | 'live';
  /** Age of the served hint in ms; `0` for a live computation. */
  ageMs: number;
  /** Configured hint freshness window in ms (`0` when not applicable). */
  maxAgeMs: number;
  /** `false` when a completeness signal fired; never stored, never proof of exhaustion. */
  complete: boolean;
  /** Full discovery enumerations this run performed; `0` for a warm hint. */
  enumerations: number;
  /** `true` when a cached exhaustion triggered the single complete refresh. */
  exhaustionRefresh: boolean;
}

export interface DiscoverHintDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Inject the runtime policy instead of reading `.github/idd/config.json`. */
  policy?: GithubApiReadCacheRuntimePolicy;
  /** The `origin` remote URL; defaults to `git remote get-url origin`. */
  originUrl?: () => string | undefined;
  /** Credential material for a host; defaults to the delivered lookup. */
  credential?: (host: string) => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  storage?: Partial<GithubApiReadCacheStorage>;
  defaultDirectory?: string;
  leaseMaxWaitMs?: number;
}

export interface DiscoverHintRequest<T> {
  helper: DiscoverHintHelper;
  /** An explicit `--owner`/`--repo` pair; otherwise the origin remote names the repo. */
  owner?: string;
  repo?: string;
  /**
   * Every CLI input that shapes the report (scope, annotation flags,
   * `--current-claim-id`, ...), without the cache flags and the latency-only
   * `--concurrency`. Two invocations that differ here never alias.
   */
  args: unknown;
  /** The whole loaded policy, so any policy change is a miss. */
  policy: unknown;
  noCache?: boolean;
  refreshCache?: boolean;
  /** Produce the complete report live. Called at most twice per request. */
  compute: () => Promise<T>;
  /** Whether the report still lists a startable candidate (drives exhaustion refresh). */
  hasCandidate: (report: T) => boolean;
  deps?: DiscoverHintDeps;
}

export interface DiscoverHintResult<T> {
  report: T;
  /** Absent only when the feature is off and no cache flag was passed. */
  cache?: DiscoverCacheMeta;
}

interface HintConfig {
  policy: GithubApiReadCacheRuntimePolicy;
  host: string;
  repository: string;
  credentialMaterial: string;
  secrets: string[];
  cwd: string;
}

interface StoredHint {
  generatedAt: number;
  report: unknown;
}

// Completeness collector. The two helper code paths that today only warn on
// stderr (search-result cap, skipped root) also record a reason here, so a
// partial read is never stored and never reported as a complete inventory.
const incompleteReasons = new AsyncLocalStorage<string[]>();

/**
 * Record that the current Discover computation is not a complete read. The
 * reason lands on the computation this call runs inside, so overlapping
 * computations in one process never see each other's signals.
 */
export function noteDiscoveryIncomplete(reason: string): void {
  incompleteReasons.getStore()?.push(reason);
}

async function computeTracked<T>(
  compute: () => Promise<T>,
): Promise<{ report: T; reasons: string[] }> {
  const reasons: string[] = [];
  const report = await incompleteReasons.run(reasons, compute);
  return { report, reasons };
}

interface RemoteIdentity {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub-style remote URL locally (https, ssh, scp-like, git). It
 * never contacts the network; an unparsable URL yields `null`.
 */
export function parseRemoteUrl(url: string): RemoteIdentity | null {
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

function defaultOriginUrl(cwd: string): string | undefined {
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

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function secretEnv(env: NodeJS.ProcessEnv): string[] {
  return [
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.GH_ENTERPRISE_TOKEN,
    env.GITHUB_ENTERPRISE_TOKEN,
  ].filter((value): value is string => typeof value === 'string');
}

/**
 * Resolve the cache identity **without any network call**: repo from an
 * explicit pair or the origin remote, host from `GH_HOST`, then
 * `GITHUB_SERVER_URL`, then the origin remote (never `gh auth status`, which
 * calls the API), and credential material from the delivered local lookup.
 * `null` means the feature is off or the caller cannot be identified, so the
 * cache is bypassed rather than keyed under a guessed identity.
 */
/**
 * How a half-given identity (`--owner` without `--repo`, or the reverse) is
 * treated. The helpers fill the missing half from `gh repo view`, which this
 * layer never calls, so a read cannot name the repository it enumerates and
 * bypasses the cache. An invalidation may instead fall back to `origin`: an
 * extra invalidation is harmless, a missed one is not.
 */
type PartialIdentity = 'bypass' | 'origin';

function resolveConfig(
  request: Pick<DiscoverHintRequest<unknown>, 'owner' | 'repo'>,
  deps: DiscoverHintDeps,
  partial: PartialIdentity,
  /**
   * Whether a credential is needed. A hint read keys on it; the generation
   * token does not, so an invalidation never spends a (possibly slow) local
   * credential lookup on a mutation path.
   */
  needCredential = true,
): HintConfig | null {
  if (
    partial === 'bypass' &&
    Boolean(request.owner) !== Boolean(request.repo)
  ) {
    return null;
  }
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const policy = deps.policy ?? loadReadCachePolicy(undefined);
  if (!policy.enabled) return null;
  // A complete explicit pair names the repository without `origin`, so the
  // remote is probed only when it is still needed: for the repository itself,
  // or for a host that neither `GH_HOST` nor `GITHUB_SERVER_URL` names.
  const explicit = Boolean(request.owner && request.repo);
  const envHost = env.GH_HOST?.trim().toLowerCase() || serverUrlHost(env) || '';
  const remoteUrl =
    explicit && envHost !== ''
      ? undefined
      : (deps.originUrl ?? (() => defaultOriginUrl(cwd)))();
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  // With an explicit pair and no host signal at all, `gh`'s default host is
  // `github.com`; an unauthenticated one fails the credential lookup below
  // and bypasses the cache, so a wrong guess never keys a hint.
  const host = envHost || remote?.host || (explicit ? 'github.com' : '');
  if (host === '') return null;
  // GitHub owner and repository names are case-insensitive, so a mutation
  // helper's resolved name and Discover's origin-derived name must agree.
  const repository = (
    request.owner && request.repo
      ? `${request.owner}/${request.repo}`
      : remote
        ? `${remote.owner}/${remote.repo}`
        : ''
  ).toLowerCase();
  if (repository === '') return null;
  const credentialMaterial = needCredential
    ? ((deps.credential ?? defaultCredentialMaterial)(host)?.trim() ?? '')
    : '';
  if (needCredential && credentialMaterial === '') return null;
  return {
    policy,
    host,
    repository,
    credentialMaterial,
    secrets: [...secretEnv(env), credentialMaterial].filter(Boolean),
    cwd,
  };
}

/**
 * The generation token is not secret and is shared by every credential on a
 * host and repository, so a claim or merge made with one credential drops the
 * hints of every other credential too. Hints themselves stay credential
 * isolated: only this fixed, non-secret partition is shared.
 */
const GENERATION_CREDENTIAL = 'idd-discover-hint-generation';

function generationInput(
  config: HintConfig,
  deps: DiscoverHintDeps,
): ReturnType<typeof baseInput> {
  return {
    ...baseInput(config, deps),
    credentialMaterial: GENERATION_CREDENTIAL,
    secretMaterial: [],
  };
}

function baseInput(
  config: HintConfig,
  deps: DiscoverHintDeps,
): Omit<
  ReadThroughGithubApiCacheAsyncInput,
  'requestShape' | 'derivedInputs' | 'fetch' | 'mode' | 'policy'
> {
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
function readGeneration(
  config: HintConfig,
  deps: DiscoverHintDeps,
): string | null {
  const result = readThroughGithubApiCache({
    ...generationInput(config, deps),
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

function toPlainJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isStoredHint(value: unknown): value is StoredHint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.generatedAt === 'number' && 'report' in record;
}

/**
 * Trust-related variables that can change what a helper reports. Per-session
 * plumbing (`IDD_CLONE_LOCK_*`, `IDD_HELPER_ERROR_ENVELOPE`, ...) is left out
 * on purpose: it differs between sessions without changing the answer and
 * would split every session's hints.
 */
const HINT_ENV_NAMES = [
  'IDD_ADVISORY_BOT_LOGINS',
  'IDD_AGENT_LOGINS',
  'IDD_TRUST_COLLABORATOR_MARKERS',
  'IDD_TRUSTED_MARKER_ACTORS',
] as const;

function hintEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const name of HINT_ENV_NAMES) flags[name] = env[name] ?? '';
  return flags;
}

function hintKeyInputs(
  request: Pick<DiscoverHintRequest<unknown>, 'helper' | 'args' | 'policy'>,
  config: HintConfig,
  generation: string,
  env: NodeJS.ProcessEnv,
): unknown {
  return {
    helper: request.helper,
    formatVersion: HINT_FORMAT_VERSION,
    args: request.args,
    policy: request.policy,
    env: hintEnv(env),
    worktree: safeRealpath(config.cwd),
    generation,
  };
}

interface HintRead<T> {
  report: T;
  source: 'hint' | 'live';
  ageMs: number;
  complete: boolean;
  enumerations: number;
  /** A concurrent leader computed this report while the call waited. */
  coalesced: boolean;
}

async function readOnce<T>(
  request: DiscoverHintRequest<T>,
  config: HintConfig,
  generation: string,
  mode: 'hint' | 'strict-fresh',
): Promise<HintRead<T>> {
  const deps = request.deps ?? {};
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const box: { tracked: { report: T; reasons: string[] } | null } = {
    tracked: null,
  };
  let enumerations = 0;
  const fetch = async (): Promise<GithubApiCacheFetchResult> => {
    enumerations += 1;
    // Stamped at the start: the hint is no fresher than the moment its
    // enumeration began, however long the enumeration then ran.
    const generatedAt = now();
    const tracked = await computeTracked(request.compute);
    box.tracked = tracked;
    return {
      status: 200,
      body: {
        generatedAt,
        report: toPlainJson(tracked.report),
      } satisfies StoredHint,
      incomplete: tracked.reasons.length > 0,
    };
  };
  const result = await readThroughGithubApiCacheAsync({
    ...baseInput(config, deps),
    mode,
    policy: config.policy,
    requestShape: { unit: HINT_UNIT },
    derivedInputs: hintKeyInputs(request, config, generation, env),
    fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.leaseMaxWaitMs ? { leaseMaxWaitMs: deps.leaseMaxWaitMs } : {}),
  });
  if (result.cache === 'hit' && isStoredHint(result.body)) {
    const stored = result.body;
    const ageMs = Math.max(0, now() - stored.generatedAt);
    // The cache already measures a hint from the start of its enumeration;
    // this is a defensive re-check of the same bound.
    if (ageMs <= config.policy.maxAgeMs || mode !== 'hint') {
      return {
        report: stored.report as T,
        source: 'hint',
        ageMs,
        complete: true,
        enumerations,
        coalesced: result.coalesced === true,
      };
    }
    return readOnce(request, config, generation, 'strict-fresh');
  }
  // A hit with a body this layer did not write is replaced, not served.
  if (result.cache === 'hit' && mode === 'hint') {
    return readOnce(request, config, generation, 'strict-fresh');
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
    coalesced: false,
  };
}

/**
 * Produce a Discover helper's report through the hint cache.
 *
 * - `noCache`: compute live, touch nothing (`mode: "off"`).
 * - feature off, identity unresolved, or storage degraded: compute live
 *   (`mode: "bypass"` only when `--refresh-cache` asked; otherwise the
 *   `cache` object is omitted, keeping today's output byte-identical).
 * - `refreshCache`: recompute strict-fresh and store (`mode: "refresh"`).
 * - otherwise a hint read; a *hit that shows no startable candidate* triggers
 *   exactly one strict-fresh recompute (`exhaustionRefresh: true`) before the
 *   caller may treat the result as exhausted. A failed refresh throws; a
 *   partial one is reported `complete: false`, never as exhaustion.
 */
export async function readDiscoverHint<T>(
  request: DiscoverHintRequest<T>,
): Promise<DiscoverHintResult<T>> {
  const deps = request.deps ?? {};
  const flagged = request.noCache === true || request.refreshCache === true;
  const policy = deps.policy ?? loadReadCachePolicy(undefined);
  const active = policy.enabled === true;

  if (request.noCache === true) {
    const live = await computeTracked(request.compute);
    return {
      report: live.report,
      cache: meta('off', 'live', 0, 0, live.reasons.length === 0, 1, false),
    };
  }
  // Identity resolution spawns local processes, so it is skipped entirely
  // while the feature is off.
  const config = active
    ? resolveConfig(request, { ...deps, policy }, 'bypass')
    : null;
  // A run the cache did not take part in (feature off, caller unidentified,
  // or storage degraded) reports nothing unless a cache flag asked about it,
  // so its output stays byte-identical to the uncached helper.
  if (config === null) return bypassed(request, policy, flagged);

  const generation = readGeneration(config, deps);
  if (generation === null) return bypassed(request, policy, flagged);

  const first = await readOnce(
    request,
    config,
    generation,
    request.refreshCache === true ? 'strict-fresh' : 'hint',
  );
  if (
    first.source === 'hint' &&
    !first.coalesced &&
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

async function bypassed<T>(
  request: DiscoverHintRequest<T>,
  policy: GithubApiReadCacheRuntimePolicy,
  flagged: boolean,
): Promise<DiscoverHintResult<T>> {
  const live = await computeTracked(request.compute);
  if (!flagged) return { report: live.report };
  return {
    report: live.report,
    cache: meta(
      'bypass',
      'live',
      0,
      policy.enabled === true ? policy.maxAgeMs : 0,
      live.reasons.length === 0,
      1,
      false,
    ),
  };
}

function meta(
  mode: DiscoverCacheMode,
  source: 'hint' | 'live',
  ageMs: number,
  maxAgeMs: number,
  complete: boolean,
  enumerations: number,
  exhaustionRefresh: boolean,
): DiscoverCacheMeta {
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

/** The identity a mutation names: an explicit owner and repo, or neither. */
type MutationIdentity = Pick<DiscoverHintRequest<unknown>, 'owner' | 'repo'>;

/**
 * Invalidate every discover hint after an observed local mutation (claim,
 * unclaim, merge, closure). Best effort: it never throws, never blocks the
 * calling helper on a network or credential lookup, and is a no-op when the
 * cache is off or the repository cannot be named. Pass every identity the
 * mutation may be keyed under (the pair the helper resolved, and the explicit
 * arguments or `origin` fallback Discover keyed on); duplicates collapse.
 * Writes outside the helper paths are discovered by `--refresh-cache`, the
 * exhaustion refresh, or the hint's max age. Returns whether any generation
 * token was bumped.
 */
export function invalidateDiscoverHints(
  request: MutationIdentity | readonly MutationIdentity[] = {},
  deps: DiscoverHintDeps = {},
): boolean {
  const identities = Array.isArray(request) ? request : [request];
  const seen = new Set<string>();
  let bumped = false;
  for (const identity of identities as readonly MutationIdentity[]) {
    try {
      const config = resolveConfig(identity, deps, 'origin', false);
      if (config === null || seen.has(config.repository)) continue;
      seen.add(config.repository);
      const token = randomUUID();
      readThroughGithubApiCache({
        ...generationInput(config, deps),
        mode: 'strict-fresh',
        policy: { ...config.policy, maxAgeMs: config.policy.retentionMs },
        requestShape: { unit: GENERATION_UNIT },
        fetch: () => ({ status: 200, body: token }),
      });
      // The write is best effort inside the cache, so confirm it landed.
      if (readGeneration(config, deps) === token) bumped = true;
    } catch {
      // Best effort: an invalidation failure must never fail the mutation.
    }
  }
  return bumped;
}

export interface DiscoverHintPurgeResult {
  cache: 'purged' | 'refused';
  removed: number;
}

/**
 * Purge the host-local read cache (the delivered `operation: "purge"`), which
 * removes every cached body from disk, not only discover hints. Works even
 * when the cache is disabled so a stale directory can always be cleaned.
 */
export function purgeDiscoverHints(
  deps: DiscoverHintDeps = {},
): DiscoverHintPurgeResult {
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
