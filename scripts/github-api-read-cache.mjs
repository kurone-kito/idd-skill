// idd-generated-from: src/scripts/github-api-read-cache.mts
//
// The scripts/github-api-read-cache.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Opt-in host-local read cache for explicitly classified GitHub REST
// reads. Callers that do not opt in never reach this module, and Discover
// is not wired here. Credential material is hashed into the cache key and
// is never written into an entry, a lease, or a log line.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const SCHEMA_VERSION = 1;
const MARKER_NAME = '.idd-github-api-read-cache';
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
const MAX_CACHE_BYTES = 104857600;
const DEFAULT_LEASE_TTL_MS = 15_000;
const POLL_MS = 20;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
class CacheStorageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CacheStorageError';
  }
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}
function normalizeHost(host) {
  const trimmed = host.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'github.com';
}
function normalizeMode(mode) {
  if (mode === 'conditional' || mode === 'strict-fresh') return mode;
  return 'hint';
}
function errorCode(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}
function isEnoent(error) {
  return errorCode(error) === 'ENOENT';
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}
function defaultCacheDirectory(env, platform) {
  const home = homedir();
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
    return join(base, 'idd-skill', 'github-api-read-cache');
  }
  if (platform === 'darwin') {
    return join(
      home,
      'Library',
      'Caches',
      'idd-skill',
      'github-api-read-cache',
    );
  }
  const base = env.XDG_CACHE_HOME?.trim() || join(home, '.cache');
  return join(base, 'idd-skill', 'github-api-read-cache');
}
function comparePath(path) {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function isFilesystemRoot(path) {
  const resolved = resolve(path);
  return resolved === parse(resolved).root;
}
function isAncestor(parent, child) {
  if (parent === child) return false;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}
function isUnsafeDirectory(candidate, anchors) {
  if (!isAbsolute(candidate)) return true;
  const paths = [comparePath(candidate)];
  const real = canonicalPath(candidate);
  if (real !== resolve(candidate)) paths.push(comparePath(real));
  for (const path of paths) {
    if (isFilesystemRoot(path)) return true;
    for (const anchor of anchors) {
      const resolvedAnchor = comparePath(canonicalPath(anchor));
      if (path === resolvedAnchor || isAncestor(path, resolvedAnchor)) {
        return true;
      }
    }
  }
  return false;
}
function defaultStorage() {
  return {
    mkdir(path) {
      mkdirSync(path, { recursive: true, mode: DIR_MODE });
    },
    lstat(path) {
      return lstatSync(path);
    },
    readFile(path) {
      return readFileSync(path, 'utf8');
    },
    writeExclusive(path, data) {
      writeFileSync(path, data, {
        encoding: 'utf8',
        mode: FILE_MODE,
        flag: 'wx',
      });
    },
    writeAtomic(destination, data) {
      const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, data, {
          encoding: 'utf8',
          mode: FILE_MODE,
          flag: 'w',
        });
        renameSync(temporary, destination);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // The temporary file may already have been renamed.
        }
        throw error;
      }
    },
    unlink(path) {
      unlinkSync(path);
    },
    readdir(path) {
      return readdirSync(path);
    },
    chmod(path, mode) {
      chmodSync(path, mode);
    },
  };
}
function wrapStorageCall(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CacheStorageError) throw error;
    const wrapped = new CacheStorageError('cache storage failed', {
      cause: error,
    });
    const code = errorCode(error);
    if (code) {
      wrapped.code = code;
    }
    throw wrapped;
  }
}
function createStorage(override) {
  const storage = { ...defaultStorage(), ...override };
  return {
    mkdir: (path) => wrapStorageCall(() => storage.mkdir(path)),
    lstat: (path) => wrapStorageCall(() => storage.lstat(path)),
    readFile: (path) => wrapStorageCall(() => storage.readFile(path)),
    writeExclusive: (path, data) =>
      wrapStorageCall(() => storage.writeExclusive(path, data)),
    writeAtomic: (destination, data) =>
      wrapStorageCall(() => storage.writeAtomic(destination, data)),
    unlink: (path) => wrapStorageCall(() => storage.unlink(path)),
    readdir: (path) => wrapStorageCall(() => storage.readdir(path)),
    chmod: (path, mode) => wrapStorageCall(() => storage.chmod(path, mode)),
  };
}
function entryIdFor(input) {
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    host: normalizeHost(input.host),
    credential: sha256(input.credentialMaterial),
    repository: input.repository.trim(),
    request: sha256(canonicalJson(input.requestShape)),
    derived: sha256(canonicalJson(input.derivedInputs ?? null)),
  };
  return sha256(canonicalJson(identity));
}
function boundedBytes(value) {
  if (!Number.isFinite(value) || value < 1) return MAX_CACHE_BYTES;
  return Math.min(Math.floor(value), MAX_CACHE_BYTES);
}
function positiveMs(value, fallback) {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return value;
}
function containsSecret(secrets, haystacks) {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const haystack of haystacks) {
      if (haystack.includes(secret)) return true;
    }
  }
  return false;
}
function liveResult(fetch, cache, entryId) {
  const result = fetch({});
  return {
    body: result.body,
    status: result.status,
    cache,
    fetched: true,
    ...(entryId ? { entryId } : {}),
  };
}
function fromFetch(result, cache, entryId) {
  return {
    body: result.body,
    status: result.status,
    cache,
    fetched: true,
    entryId,
  };
}
function tryLstat(storage, path) {
  try {
    return storage.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache lstat failed', { cause: error });
  }
}
function safeUnlink(storage, path) {
  try {
    const stat = storage.lstat(path);
    if (stat.isSymbolicLink()) return;
    storage.unlink(path);
  } catch (error) {
    if (isEnoent(error)) return;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache unlink failed', { cause: error });
  }
}
function assertPrivate(storage, path, kind) {
  const stat = tryLstat(storage, path);
  if (!stat || stat.isSymbolicLink()) {
    throw new CacheStorageError('cache path is missing or a symlink');
  }
  if (kind === 'dir' && !stat.isDirectory()) {
    throw new CacheStorageError('cache path is not a directory');
  }
  if (kind === 'file' && !stat.isFile()) {
    throw new CacheStorageError('cache path is not a file');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new CacheStorageError('cache path is group- or world-accessible');
  }
}
function ensurePrivateDir(ctx, path) {
  const existing = tryLstat(ctx.storage, path);
  if (existing?.isSymbolicLink()) {
    throw new CacheStorageError('refusing to use a symlinked cache directory');
  }
  if (!existing) ctx.storage.mkdir(path);
  const created = tryLstat(ctx.storage, path);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw new CacheStorageError('cache path is not a real directory');
  }
  ctx.storage.chmod(path, DIR_MODE);
  assertPrivate(ctx.storage, path, 'dir');
}
function prepareRoot(ctx) {
  if (isUnsafeDirectory(ctx.root, ctx.anchors)) {
    throw new CacheStorageError('unsafe cache directory');
  }
  ensurePrivateDir(ctx, ctx.root);
  ensurePrivateDir(ctx, join(ctx.root, 'entries'));
  ensurePrivateDir(ctx, join(ctx.root, 'leases'));
  if (isUnsafeDirectory(ctx.root, ctx.anchors)) {
    throw new CacheStorageError('unsafe cache directory');
  }
  const marker = join(ctx.root, MARKER_NAME);
  const markerStat = tryLstat(ctx.storage, marker);
  if (markerStat?.isSymbolicLink()) {
    throw new CacheStorageError('refusing to use a symlinked cache marker');
  }
  if (!markerStat) {
    ctx.storage.writeExclusive(marker, 'idd-github-api-read-cache\n');
  }
  ctx.storage.chmod(marker, FILE_MODE);
  assertPrivate(ctx.storage, marker, 'file');
}
function isStoredRecord(value, now) {
  if (typeof value !== 'object' || value === null) return false;
  const record = value;
  return (
    record.schemaVersion === SCHEMA_VERSION &&
    record.complete === true &&
    typeof record.storedAt === 'number' &&
    Number.isFinite(record.storedAt) &&
    record.storedAt <= now &&
    typeof record.status === 'number' &&
    record.status >= 200 &&
    record.status < 300 &&
    'body' in record
  );
}
function isPrivateStat(stat) {
  if (process.platform === 'win32') return true;
  return (stat.mode & 0o077) === 0;
}
function readRecord(ctx, path) {
  const stat = tryLstat(ctx.storage, path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  if (!isPrivateStat(stat)) {
    safeUnlink(ctx.storage, path);
    return null;
  }
  let text;
  try {
    text = ctx.storage.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache read failed', { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    safeUnlink(ctx.storage, path);
    return null;
  }
  if (!isStoredRecord(parsed, ctx.now())) {
    safeUnlink(ctx.storage, path);
    return null;
  }
  return parsed;
}
function entryPath(ctx) {
  return join(ctx.root, 'entries', `${ctx.entryId}.json`);
}
function leasePath(ctx) {
  return join(ctx.root, 'leases', `${ctx.entryId}.json`);
}
function trustedRecord(ctx) {
  const record = readRecord(ctx, entryPath(ctx));
  if (!record) return null;
  if (ctx.now() - record.storedAt > ctx.retentionMs) {
    safeUnlink(ctx.storage, entryPath(ctx));
    return null;
  }
  return record;
}
function freshRecord(ctx) {
  const record = trustedRecord(ctx);
  if (!record) return null;
  if (ctx.now() - record.storedAt > ctx.maxAgeMs) return null;
  return record;
}
function hitResult(record, entryId) {
  return {
    body: record.body,
    status: record.status,
    cache: 'hit',
    fetched: false,
    entryId,
  };
}
function persistable(ctx, result) {
  if (result.incomplete || result.throttled) return false;
  if (result.status < 200 || result.status >= 300) return false;
  const etag = result.etag ?? '';
  const lastModified = result.lastModified ?? '';
  return !containsSecret(ctx.secrets, [
    ctx.host,
    ctx.repository,
    etag,
    lastModified,
    canonicalJson(result.body),
  ]);
}
function serializeRecord(record) {
  return JSON.stringify(record);
}
function publish(ctx, result, startedAt, force) {
  if (!persistable(ctx, result)) return;
  const record = {
    schemaVersion: SCHEMA_VERSION,
    storedAt: ctx.now(),
    status: result.status,
    body: result.body,
    complete: true,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
  };
  const payload = serializeRecord(record);
  if (Buffer.byteLength(payload) > ctx.maxBytes) return;
  const destination = entryPath(ctx);
  if (!force) {
    const existing = readRecord(ctx, destination);
    if (existing && existing.storedAt >= startedAt) return;
  }
  ctx.storage.writeAtomic(destination, payload);
  try {
    assertPrivate(ctx.storage, destination, 'file');
  } catch (error) {
    safeUnlink(ctx.storage, destination);
    throw error;
  }
  evict(ctx);
}
function evict(ctx) {
  const entriesDir = join(ctx.root, 'entries');
  const stat = tryLstat(ctx.storage, entriesDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  let names;
  try {
    names = ctx.storage.readdir(entriesDir);
  } catch (error) {
    throw new CacheStorageError('cache readdir failed', { cause: error });
  }
  const keep = [];
  let total = 0;
  for (const name of names) {
    if (!ENTRY_NAME.test(name)) continue;
    const path = join(entriesDir, name);
    const fileStat = tryLstat(ctx.storage, path);
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
    const record = readRecord(ctx, path);
    if (!record || fileStat.size > ctx.maxBytes) {
      if (fileStat.isFile() && !fileStat.isSymbolicLink()) {
        safeUnlink(ctx.storage, path);
      }
      continue;
    }
    if (ctx.now() - record.storedAt > ctx.retentionMs) {
      safeUnlink(ctx.storage, path);
      continue;
    }
    keep.push({ path, size: fileStat.size, storedAt: record.storedAt });
    total += fileStat.size;
  }
  const currentPath = entryPath(ctx);
  keep.sort((left, right) => {
    if (left.storedAt !== right.storedAt) return left.storedAt - right.storedAt;
    if (left.path === currentPath) return 1;
    if (right.path === currentPath) return -1;
    return left.path < right.path ? -1 : 1;
  });
  for (const file of keep) {
    if (total <= ctx.maxBytes) break;
    safeUnlink(ctx.storage, file.path);
    total -= file.size;
  }
}
function refreshBase(ctx, base, result) {
  const record = {
    ...base,
    storedAt: ctx.now(),
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
  };
  if (
    containsSecret(ctx.secrets, [record.etag ?? '', record.lastModified ?? ''])
  ) {
    return;
  }
  const destination = entryPath(ctx);
  ctx.storage.writeAtomic(destination, serializeRecord(record));
  try {
    assertPrivate(ctx.storage, destination, 'file');
  } catch (error) {
    safeUnlink(ctx.storage, destination);
    throw error;
  }
}
function leaderFetch(ctx) {
  const startedAt = ctx.now();
  if (ctx.mode === 'hint') {
    const fresh = freshRecord(ctx);
    if (fresh) return hitResult(fresh, ctx.entryId);
  }
  const base = ctx.mode === 'conditional' ? trustedRecord(ctx) : null;
  let result;
  if (ctx.mode === 'conditional' && base?.etag && !ctx.paginated) {
    result = ctx.fetch({ etag: base.etag, lastModified: base.lastModified });
    if (result.status === 304) {
      try {
        refreshBase(ctx, base, result);
      } catch (error) {
        if (!(error instanceof CacheStorageError)) throw error;
        const live = ctx.fetch({});
        try {
          publish(ctx, live, startedAt, false);
        } catch (publishError) {
          if (!(publishError instanceof CacheStorageError)) throw publishError;
        }
        return fromFetch(live, 'degraded', ctx.entryId);
      }
      return {
        body: base.body,
        status: base.status,
        cache: 'revalidated',
        fetched: true,
        entryId: ctx.entryId,
      };
    }
  } else {
    result = ctx.fetch({});
  }
  if (result.status === 304 && ctx.mode === 'conditional') {
    result = ctx.fetch({});
    if (result.status === 304) {
      throw new Error(
        'GitHub conditional read returned 304 without a trusted representation',
      );
    }
  }
  try {
    publish(ctx, result, startedAt, false);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}
function readLease(ctx) {
  const path = leasePath(ctx);
  const stat = tryLstat(ctx.storage, path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) return 'stale';
  let text;
  try {
    text = ctx.storage.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache lease read failed', { cause: error });
  }
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return 'stale';
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      ...(typeof parsed.token === 'string' && parsed.token.length > 0
        ? { token: parsed.token }
        : {}),
    };
  } catch {
    return 'stale';
  }
}
function leaseMatches(current, observed) {
  if (observed.token !== undefined || current.token !== undefined) {
    return observed.token !== undefined && observed.token === current.token;
  }
  return (
    current.pid === observed.pid && current.createdAt === observed.createdAt
  );
}
function discardObservedLease(ctx, observed) {
  const current = readLease(ctx);
  if (observed === 'stale') {
    if (current === 'stale') safeUnlink(ctx.storage, leasePath(ctx));
    return;
  }
  if (
    current !== null &&
    current !== 'stale' &&
    leaseMatches(current, observed)
  ) {
    safeUnlink(ctx.storage, leasePath(ctx));
  }
}
function leaseIsStale(ctx, lease) {
  if (lease.createdAt > ctx.now()) return true;
  if (ctx.now() - lease.createdAt > ctx.leaseTtlMs) return true;
  return !ctx.isPidAlive(lease.pid);
}
function tryAcquire(ctx) {
  const createdAt = ctx.now();
  const token = randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    pid: ctx.pid,
    createdAt,
    mode: ctx.mode,
    token,
  });
  try {
    ctx.storage.writeExclusive(leasePath(ctx), payload);
    ctx.heldLease = { pid: ctx.pid, createdAt, token };
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache lease create failed', { cause: error });
  }
}
function releaseLease(ctx) {
  const held = ctx.heldLease;
  ctx.heldLease = null;
  if (!held) return;
  try {
    discardObservedLease(ctx, held);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
}
function waitForLeader(ctx) {
  const started = Date.now();
  while (Date.now() - started < ctx.leaseTtlMs) {
    if (ctx.mode === 'hint') {
      const fresh = freshRecord(ctx);
      if (fresh) return fresh;
    }
    const lease = readLease(ctx);
    if (lease === null) {
      return ctx.mode === 'hint' ? freshRecord(ctx) : trustedRecord(ctx);
    }
    if (lease === 'stale' || leaseIsStale(ctx, lease)) {
      discardObservedLease(ctx, lease);
      return null;
    }
    ctx.sleep(Math.min(POLL_MS, ctx.leaseTtlMs));
  }
  const lease = readLease(ctx);
  if (lease === null) {
    return ctx.mode === 'hint' ? freshRecord(ctx) : trustedRecord(ctx);
  }
  if (lease === 'stale' || leaseIsStale(ctx, lease)) {
    discardObservedLease(ctx, lease);
  }
  return null;
}
function coalesce(ctx) {
  if (ctx.mode === 'hint') {
    const fresh = freshRecord(ctx);
    if (fresh) return hitResult(fresh, ctx.entryId);
  }
  if (tryAcquire(ctx)) {
    try {
      return leaderFetch(ctx);
    } finally {
      releaseLease(ctx);
    }
  }
  const waitStarted = ctx.now();
  const waited = waitForLeader(ctx);
  if (waited && ctx.mode === 'hint') return hitResult(waited, ctx.entryId);
  if (waited && ctx.mode === 'conditional' && waited.storedAt >= waitStarted) {
    return {
      body: waited.body,
      status: waited.status,
      cache: 'revalidated',
      fetched: false,
      entryId: ctx.entryId,
    };
  }
  if (tryAcquire(ctx)) {
    try {
      return leaderFetch(ctx);
    } finally {
      releaseLease(ctx);
    }
  }
  return liveResult(ctx.fetch, 'degraded', ctx.entryId);
}
function strictFresh(ctx) {
  const startedAt = ctx.now();
  const result = ctx.fetch({});
  try {
    publish(ctx, result, startedAt, true);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}
function resolveReadDirectory(input, anchors) {
  const candidates = [
    input.policy.directory?.trim() ?? '',
    input.defaultDirectory?.trim() ?? '',
    defaultCacheDirectory(process.env, process.platform),
  ];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    if (!isAbsolute(candidate)) continue;
    if (!isUnsafeDirectory(candidate, anchors)) return candidate;
  }
  throw new CacheStorageError('no safe cache directory');
}
function purgeDirectory(storage, root, anchors) {
  if (!isAbsolute(root) || isUnsafeDirectory(root, anchors)) {
    return {
      body: null,
      status: 0,
      cache: 'refused',
      fetched: false,
      removed: 0,
    };
  }
  const rootStat = tryLstat(storage, root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      body: null,
      status: 0,
      cache: 'refused',
      fetched: false,
      removed: 0,
    };
  }
  const marker = join(root, MARKER_NAME);
  const markerStat = tryLstat(storage, marker);
  if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile()) {
    return {
      body: null,
      status: 0,
      cache: 'refused',
      fetched: false,
      removed: 0,
    };
  }
  const entries = join(root, 'entries');
  const entriesStat = tryLstat(storage, entries);
  if (!entriesStat) {
    return {
      body: null,
      status: 0,
      cache: 'purged',
      fetched: false,
      removed: 0,
    };
  }
  if (entriesStat.isSymbolicLink() || !entriesStat.isDirectory()) {
    return {
      body: null,
      status: 0,
      cache: 'refused',
      fetched: false,
      removed: 0,
    };
  }
  let removed = 0;
  for (const name of storage.readdir(entries)) {
    if (!ENTRY_NAME.test(name)) continue;
    const path = join(entries, name);
    const stat = tryLstat(storage, path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    storage.unlink(path);
    removed += 1;
  }
  return { body: null, status: 0, cache: 'purged', fetched: false, removed };
}
function anchorsFor(input) {
  const cwd = input.cwd ?? process.cwd();
  const anchors = [cwd];
  if (input.workspaceRoot && input.workspaceRoot !== cwd) {
    anchors.push(input.workspaceRoot);
  }
  return anchors;
}
function executeCached(ctx) {
  prepareRoot(ctx);
  if (ctx.mode === 'strict-fresh') return strictFresh(ctx);
  return coalesce(ctx);
}
/**
 * Read through the host-local GitHub API cache, or purge its entries.
 *
 * Non-read classifications and a disabled policy fetch once and do not
 * touch the cache directory. Storage, permission, and unsafe-directory
 * failures degrade to that same live fetch. Fetch failures propagate
 * after the single-flight lease is released and are not stored.
 */
export function readThroughGithubApiCache(input) {
  const anchors = anchorsFor(input);
  const storage = createStorage(input.storage);
  if (input.operation === 'purge') {
    const root = input.policy.directory?.trim() ?? '';
    try {
      return purgeDirectory(storage, root, anchors);
    } catch (error) {
      if (error instanceof CacheStorageError) {
        return {
          body: null,
          status: 0,
          cache: 'refused',
          fetched: false,
          removed: 0,
        };
      }
      throw error;
    }
  }
  if (input.classification !== 'read' || input.policy.enabled !== true) {
    return liveResult(input.fetch, 'bypass');
  }
  const entryId = entryIdFor(input);
  let root;
  try {
    root = resolveReadDirectory(input, anchors);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return liveResult(input.fetch, 'degraded', entryId);
  }
  const ctx = {
    storage,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? sleepSync,
    leaseTtlMs: positiveMs(
      input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      DEFAULT_LEASE_TTL_MS,
    ),
    isPidAlive: input.isPidAlive ?? defaultIsPidAlive,
    pid: input.pid ?? process.pid,
    anchors,
    maxBytes: boundedBytes(input.policy.maxBytes),
    entryId,
    root,
    secrets: (input.secretMaterial ?? []).filter((secret) => secret.length > 0),
    host: normalizeHost(input.host),
    repository: input.repository.trim(),
    paginated: input.paginated === true,
    mode: normalizeMode(input.mode),
    maxAgeMs: positiveMs(input.policy.maxAgeMs, 5 * 60 * 1000),
    retentionMs: positiveMs(input.policy.retentionMs, 24 * 60 * 60 * 1000),
    fetch: input.fetch,
    heldLease: null,
  };
  try {
    return executeCached(ctx);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return liveResult(input.fetch, 'degraded', entryId);
  }
}
