// idd-generated-from: src/scripts/github-api-read-cache.mts
//
// The scripts/github-api-read-cache.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Opt-in host-local read cache for explicitly classified GitHub REST
// reads. Callers that do not opt in never reach this module, and Discover
// reaches it only through discover-hint-cache.mts. Credential material is
// hashed into the cache key and is never written into an entry, a lease, or
// a log line.
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';
import { evaluateWindowsAcl, readWindowsAcl } from './windows-acl.mjs';

const SCHEMA_VERSION = 1;
const MARKER_NAME = '.idd-github-api-read-cache';
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
const TEMP_NAME = /^[0-9a-f]{64}\.json\.(\d+)\.[0-9a-f]{12}\.tmp$/;
const MAX_CACHE_BYTES = 104857600;
const DEFAULT_LEASE_TTL_MS = 15_000;
const POLL_MS = 20;
/** The shape of a lease token: this module mints hex, and only a safe file-name component is trusted. */
const LEASE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
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
class CacheKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CacheKeyError';
  }
}
const MAX_KEY_DEPTH = 64;
/**
 * Canonical JSON for cache keys. It throws `CacheKeyError` for anything
 * plain JSON cannot represent unambiguously (a `Date`, `bigint`, `Map`,
 * `Set`, function, `NaN`, or a cycle), because collapsing those to `null`
 * or `{}` would let two different requests share one entry and serve the
 * wrong response. An `undefined` property is omitted, as JSON does.
 */
function canonicalJson(value, depth = 0) {
  if (depth > MAX_KEY_DEPTH) throw new CacheKeyError('key nesting too deep');
  if (value === undefined || value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CacheKeyError('non-finite number in cache key');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CacheKeyError(`unsupported ${typeof value} in cache key`);
  }
  if (Array.isArray(value)) {
    // Iterate by index: map() skips holes, so a sparse array would encode
    // like a shorter one and two different shapes would share an entry.
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || value[index] === undefined) {
        throw new CacheKeyError('missing or undefined array item in cache key');
      }
      items.push(canonicalJson(value[index], depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CacheKeyError('non-plain object in cache key');
  }
  const record = value;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`,
    )
    .join(',')}}`;
}
function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
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
const MAX_CANONICAL_RETRIES = 8;
/**
 * Resolve the physical location of `path`, canonicalizing the nearest
 * existing ancestor and appending the missing suffix so a not-yet-created
 * cache directory is judged where `mkdir` will really create it. Returns
 * `null` (unsafe) when a component cannot be resolved, including a
 * dangling symlink that `mkdir -p` would follow to an unchecked place.
 * A component a concurrent cold start creates between the failed
 * `realpath` and the `lstat` is not a dangling symlink: retry, bounded.
 */
// audit:ignore-dead-export: the fs seam exists so the concurrent-create race has a deterministic regression test
export function resolveCanonicalPath(path, fs = { realpathSync, lstatSync }) {
  let existing = resolve(path);
  const suffix = [];
  let retries = 0;
  for (;;) {
    try {
      return join(fs.realpathSync(existing), ...suffix);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      try {
        if (fs.lstatSync(existing).isSymbolicLink()) return null;
        retries += 1;
        if (retries > MAX_CANONICAL_RETRIES) return null;
        continue;
      } catch (lstatError) {
        if (errorCode(lstatError) !== 'ENOENT') return null;
      }
      const parent = dirname(existing);
      if (parent === existing) return null;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}
/**
 * Normalize a configured directory once, lexically, and use only the
 * result for every check and operation. A raw `..` after a symlink would
 * otherwise be judged lexically but resolved physically by the OS.
 */
function normalizedRoot(candidate) {
  return isAbsolute(candidate) ? resolve(candidate) : null;
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
  const real = resolveCanonicalPath(candidate);
  if (real === null) return true;
  const paths = [comparePath(candidate)];
  if (real !== resolve(candidate)) paths.push(comparePath(real));
  for (const path of paths) {
    if (isFilesystemRoot(path)) return true;
    for (const anchor of anchors) {
      const resolvedAnchor = comparePath(
        resolveCanonicalPath(anchor) ?? resolve(anchor),
      );
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
/**
 * The writer pid of an atomic-write temp file, or null for any other
 * name. A temp file whose writer is gone is an orphan left by a crash
 * between the write and the rename, and it holds private response data
 * outside the entry size and retention bounds.
 */
function tempWriterPid(name) {
  const match = TEMP_NAME.exec(name);
  return match ? Number(match[1]) : null;
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
/**
 * Refuse to adopt a directory this cache did not create: chmod and the
 * entries/leases layout would otherwise change a foreign directory. An
 * empty directory, or one holding only this cache's own layout or marker,
 * is adoptable, which also covers a concurrent cold start.
 */
function assertAdoptableRoot(ctx) {
  const stat = tryLstat(ctx.storage, ctx.root);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CacheStorageError('cache root is not a real directory');
  }
  const ours = new Set([MARKER_NAME, 'entries', 'leases']);
  for (const name of ctx.storage.readdir(ctx.root)) {
    if (!ours.has(name)) {
      throw new CacheStorageError('refusing to adopt a foreign directory');
    }
  }
}
/**
 * Windows has no mode bits, so a configured cache directory must be shown by
 * its ACL to grant access only to the current user, SYSTEM, and the
 * built-in Administrators. The per-user default location under
 * `LOCALAPPDATA` inherits a user-only ACL and is trusted without an ACL read.
 * A permissive or unreadable ACL degrades to a live read like any other
 * storage refusal (#3623).
 */
function assertWindowsDirectoryPrivate(ctx) {
  if (ctx.platform !== 'win32' || ctx.directorySource === 'default') return;
  let verdict;
  try {
    verdict = evaluateWindowsAcl(ctx.aclReader(ctx.root));
  } catch {
    verdict = 'unreadable';
  }
  if (verdict === 'private') return;
  throw new CacheStorageError(
    verdict === 'permissive'
      ? 'cache directory ACL grants access to other principals'
      : 'cache directory ACL could not be read',
  );
}
function prepareRoot(ctx) {
  if (isUnsafeDirectory(ctx.root, ctx.anchors)) {
    throw new CacheStorageError('unsafe cache directory');
  }
  assertAdoptableRoot(ctx);
  ensurePrivateDir(ctx, ctx.root);
  // After the root exists (so a directory created just now is judged by the ACL
  // it inherited) and before anything is stored under it: a refusal leaves only
  // an empty root, no marker and no entries.
  assertWindowsDirectoryPrivate(ctx);
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
    try {
      ctx.storage.writeExclusive(marker, 'idd-github-api-read-cache\n');
    } catch (error) {
      // A concurrent cold start created it first; validate that marker.
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const placed = tryLstat(ctx.storage, marker);
    if (!placed || placed.isSymbolicLink() || !placed.isFile()) {
      throw new CacheStorageError('cache marker is not a regular file');
    }
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
    (record.startedAt === undefined ||
      (typeof record.startedAt === 'number' &&
        Number.isFinite(record.startedAt) &&
        record.startedAt <= now)) &&
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
/**
 * A leader's heartbeat lives in its own file, keyed by the lease token, so
 * renewing never rewrites (and so can never overwrite) a lease record that a
 * waiter took over in the meantime.
 */
function heartbeatPath(ctx, token) {
  if (!LEASE_TOKEN.test(token)) {
    throw new CacheStorageError('cache lease token is not a safe file name');
  }
  return join(ctx.root, 'leases', `${ctx.entryId}.${token}.hb`);
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
  const basis =
    ctx.ageBasis === 'started' ? generationOf(record) : record.storedAt;
  if (ctx.now() - basis > ctx.maxAgeMs) return null;
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
  let body;
  try {
    body = canonicalJson(result.body);
  } catch (error) {
    if (error instanceof CacheKeyError) return false;
    throw error;
  }
  return !containsSecret(ctx.secrets, [
    ctx.host,
    ctx.repository,
    etag,
    lastModified,
    body,
  ]);
}
/**
 * The generation of a stored record: when its fetch started. A record
 * from before this field existed falls back to when it was stored.
 * Concurrent writers are ordered by it, so an older fetch that finishes
 * later does not overwrite or remove what a newer fetch stored, including
 * between two lease-free strict-fresh reads. This is best-effort: the
 * check reads the existing record and the write follows, so a newer
 * lease-free writer that lands inside that window can still be replaced.
 */
function generationOf(record) {
  return record.startedAt ?? record.storedAt;
}
/**
 * A 404 or 410 is a definitive answer: the stored 200 for this same
 * context is contradicted, so hint reads must not keep serving it. Other
 * failures (401, 403, 429, 5xx) say nothing about the resource and keep
 * the entry. A fetch never removes an entry a newer fetch stored.
 */
function invalidateOnMissing(ctx, result, startedAt) {
  if (result.status !== 404 && result.status !== 410) return;
  try {
    const destination = entryPath(ctx);
    const existing = readRecord(ctx, destination);
    if (existing && generationOf(existing) > startedAt) return;
    safeUnlink(ctx.storage, destination);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
}
function serializeRecord(record) {
  return JSON.stringify(record);
}
function publish(ctx, result, startedAt) {
  if (!persistable(ctx, result)) return;
  const record = {
    schemaVersion: SCHEMA_VERSION,
    storedAt: ctx.now(),
    startedAt,
    status: result.status,
    body: result.body,
    complete: true,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
  };
  const payload = serializeRecord(record);
  if (Buffer.byteLength(payload) > ctx.maxBytes) return;
  const destination = entryPath(ctx);
  const existing = readRecord(ctx, destination);
  if (existing && generationOf(existing) > startedAt) return;
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
    const writer = tempWriterPid(name);
    if (writer !== null) {
      if (!ctx.isPidAlive(writer))
        safeUnlink(ctx.storage, join(entriesDir, name));
      continue;
    }
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
function refreshBase(ctx, base, result, startedAt) {
  const destination = entryPath(ctx);
  // Skip when the entry was superseded, purged, or evicted while the
  // conditional request was in flight: a 304 for an older representation
  // must not overwrite a newer one or resurrect a removed entry.
  const current = readRecord(ctx, destination);
  if (
    !current ||
    current.storedAt !== base.storedAt ||
    current.etag !== base.etag
  ) {
    return;
  }
  const record = {
    ...base,
    storedAt: ctx.now(),
    startedAt,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
  };
  if (
    containsSecret(ctx.secrets, [record.etag ?? '', record.lastModified ?? ''])
  ) {
    return;
  }
  const payload = serializeRecord(record);
  if (Buffer.byteLength(payload) > ctx.maxBytes) {
    safeUnlink(ctx.storage, destination);
    return;
  }
  ctx.storage.writeAtomic(destination, payload);
  try {
    assertPrivate(ctx.storage, destination, 'file');
  } catch (error) {
    safeUnlink(ctx.storage, destination);
    throw error;
  }
  // The refreshed entry is already stored. A failing eviction must not
  // turn a valid 304 into a second live fetch, as publish's callers also
  // treat storage failures as non-fatal.
  try {
    evict(ctx);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
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
        refreshBase(ctx, base, result, startedAt);
      } catch (error) {
        if (!(error instanceof CacheStorageError)) throw error;
        const live = ctx.fetch({});
        invalidateOnMissing(ctx, live, startedAt);
        try {
          publish(ctx, live, startedAt);
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
  invalidateOnMissing(ctx, result, startedAt);
  try {
    publish(ctx, result, startedAt);
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
    // A token names files (see heartbeatPath), so an unsafe one makes the
    // whole record untrustworthy rather than being interpolated into a path.
    if (
      parsed.token !== undefined &&
      !(typeof parsed.token === 'string' && LEASE_TOKEN.test(parsed.token))
    ) {
      return 'stale';
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
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
    if (observed.token) {
      safeUnlink(ctx.storage, heartbeatPath(ctx, observed.token));
    }
  }
}
/** When the lease's leader last renewed it, or `0` if it never did. */
function heartbeatAt(ctx, lease) {
  if (!lease.token) return 0;
  try {
    const seen = Number(ctx.storage.readFile(heartbeatPath(ctx, lease.token)));
    return Number.isFinite(seen) && seen <= ctx.now() ? seen : 0;
  } catch {
    return 0;
  }
}
function leaseIsStale(ctx, lease) {
  if (lease.createdAt > ctx.now()) return true;
  const lastSeen = Math.max(lease.createdAt, heartbeatAt(ctx, lease));
  if (ctx.now() - lastSeen > ctx.leaseTtlMs) return true;
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
    // Also covers a lease that was taken over while this leader ran.
    if (held.token) safeUnlink(ctx.storage, heartbeatPath(ctx, held.token));
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
}
/**
 * Record that the lease this context holds is still being served, so a live
 * leader that computes for longer than the stale threshold is not mistaken
 * for a dead one. The heartbeat is a file of its own (see
 * {@link heartbeatPath}); the lease record is never rewritten, so a renewal
 * cannot clobber a lease a waiter has since taken over. Best effort: a failed
 * renewal only lets the lease age out as before.
 */
function renewLease(ctx) {
  const held = ctx.heldLease;
  if (!held?.token) return;
  try {
    ctx.storage.writeAtomic(heartbeatPath(ctx, held.token), String(ctx.now()));
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
  invalidateOnMissing(ctx, result, startedAt);
  try {
    publish(ctx, result, startedAt);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}
function resolveReadDirectory(input, anchors) {
  const candidates = [
    { path: input.policy.directory?.trim() ?? '', source: 'configured' },
    { path: input.defaultDirectory?.trim() ?? '', source: 'default' },
    {
      path: defaultCacheDirectory(process.env, process.platform),
      source: 'default',
    },
  ];
  for (const candidate of candidates) {
    const root = normalizedRoot(candidate.path);
    if (root === null) continue;
    if (!isUnsafeDirectory(root, anchors))
      return { root, source: candidate.source };
  }
  throw new CacheStorageError('no safe cache directory');
}
function purgeDirectory(storage, root, anchors, isPidAlive) {
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
    const writer = tempWriterPid(name);
    if (writer !== null ? isPidAlive(writer) : !ENTRY_NAME.test(name)) continue;
    const path = join(entries, name);
    const stat = tryLstat(storage, path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    storage.unlink(path);
    removed += 1;
  }
  return { body: null, status: 0, cache: 'purged', fetched: false, removed };
}
/**
 * The directory a purge targets. An explicit override is used as given,
 * never replaced by a fallback, so a refused override purges nothing.
 * Without one, purge follows the same order reads use (injected default,
 * then the per-user OS location) so the default cache can be purged too.
 */
function purgeTarget(input) {
  const configured = input.policy.directory?.trim() ?? '';
  if (configured.length > 0) return configured;
  const injected = input.defaultDirectory?.trim() ?? '';
  if (injected.length > 0) return injected;
  return defaultCacheDirectory(process.env, process.platform);
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
 * Decide whether a read may touch the cache and, when it may, build its
 * context. Shared by the sync and async entry points so both apply the
 * same bypass, identity, and directory rules.
 */
function prepareRead(input, fetch, sleep) {
  const anchors = anchorsFor(input);
  const storage = createStorage(input.storage);
  if (input.classification !== 'read' || input.policy.enabled !== true) {
    return { kind: 'bypass' };
  }
  // A blank credential or host would hash into a context shared by every
  // caller that omits it, so an unidentified caller never touches the cache.
  if (isBlank(input.credentialMaterial) || isBlank(input.host)) {
    return { kind: 'bypass' };
  }
  let entryId;
  try {
    entryId = entryIdFor(input);
  } catch (error) {
    if (!(error instanceof CacheKeyError)) throw error;
    return { kind: 'bypass' };
  }
  let root;
  let directorySource;
  try {
    ({ root, source: directorySource } = resolveReadDirectory(input, anchors));
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return { kind: 'degraded', entryId };
  }
  return {
    kind: 'ready',
    ctx: {
      storage,
      now: input.now ?? Date.now,
      sleep,
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
      // The credential itself is always a secret: a response that echoes it
      // must never be persisted, even when the caller passed no
      // secretMaterial.
      secrets: [
        input.credentialMaterial,
        ...(input.secretMaterial ?? []),
      ].filter((secret) => secret.length > 0),
      host: normalizeHost(input.host),
      repository: input.repository.trim(),
      paginated: input.paginated === true,
      mode: normalizeMode(input.mode),
      maxAgeMs: positiveMs(input.policy.maxAgeMs, 5 * 60 * 1000),
      retentionMs: positiveMs(input.policy.retentionMs, 24 * 60 * 60 * 1000),
      fetch,
      heldLease: null,
      ageBasis: 'stored',
      directorySource,
      platform: input.platform ?? process.platform,
      aclReader:
        input.windowsAclReader ?? ((directory) => readWindowsAcl(directory)),
    },
  };
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
  if (input.operation === 'purge') {
    const anchors = anchorsFor(input);
    const storage = createStorage(input.storage);
    try {
      const root = normalizedRoot(purgeTarget(input)) ?? '';
      return purgeDirectory(
        storage,
        root,
        anchors,
        input.isPidAlive ?? defaultIsPidAlive,
      );
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
  const prepared = prepareRead(input, input.fetch, input.sleep ?? sleepSync);
  if (prepared.kind === 'bypass') return liveResult(input.fetch, 'bypass');
  if (prepared.kind === 'degraded') {
    return liveResult(input.fetch, 'degraded', prepared.entryId);
  }
  try {
    return executeCached(prepared.ctx);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return liveResult(input.fetch, 'degraded', prepared.ctx.entryId);
  }
}
/** Longest an async waiter polls a live leader before computing itself. */
const DEFAULT_ASYNC_MAX_WAIT_MS = 120_000;
/**
 * Age past which a lease that was not renewed is treated as stale even if its
 * pid looks alive (a crashed leader whose pid was reused). A live leader
 * renews its lease while it computes, so a long enumeration keeps it.
 */
const DEFAULT_ASYNC_LEASE_TTL_MS = 600_000;
function sleepAsync(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
async function liveResultAsync(fetch, cache, entryId) {
  const result = await fetch({});
  return {
    body: result.body,
    status: result.status,
    cache,
    fetched: true,
    ...(entryId ? { entryId } : {}),
  };
}
async function leaderFetchAsync(ctx, fetch) {
  const startedAt = ctx.now();
  if (ctx.mode === 'hint') {
    // Reached only after the caller's own freshness check missed, so a fresh
    // record here was published by a peer while this call raced for the lease.
    const fresh = freshRecord(ctx);
    if (fresh) return { ...hitResult(fresh, ctx.entryId), coalesced: true };
  }
  const result = await fetch({});
  invalidateOnMissing(ctx, result, startedAt);
  try {
    publish(ctx, result, startedAt);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}
async function waitForLeaderAsync(ctx, maxWaitMs, sleep) {
  const started = ctx.now();
  for (;;) {
    const fresh = freshRecord(ctx);
    if (fresh) return fresh;
    const lease = readLease(ctx);
    if (lease === null) return freshRecord(ctx);
    if (lease === 'stale' || leaseIsStale(ctx, lease)) {
      discardObservedLease(ctx, lease);
      return null;
    }
    if (ctx.now() - started >= maxWaitMs) return null;
    await sleep(POLL_MS);
  }
}
function defaultLeaseHeartbeat(ctx) {
  return (renew) => {
    // A fraction of the effective threshold, so even a short caller-supplied
    // one is renewed before it lapses.
    const timer = setInterval(
      renew,
      Math.max(1, Math.floor(ctx.leaseTtlMs / 4)),
    );
    timer.unref?.();
    return () => clearInterval(timer);
  };
}
async function leadAsync(ctx, fetch, startHeartbeat) {
  let stopHeartbeat = () => {};
  try {
    // Set up inside the protected block: the lease is already held, so a
    // heartbeat that fails to start (or stop) must still release it.
    stopHeartbeat = startHeartbeat(() => renewLease(ctx));
    return await leaderFetchAsync(ctx, fetch);
  } finally {
    try {
      stopHeartbeat();
    } finally {
      releaseLease(ctx);
    }
  }
}
async function coalesceAsync(ctx, fetch, sleep, maxWaitMs, startHeartbeat) {
  const fresh = freshRecord(ctx);
  if (fresh) return hitResult(fresh, ctx.entryId);
  if (tryAcquire(ctx)) return leadAsync(ctx, fetch, startHeartbeat);
  const waited = await waitForLeaderAsync(ctx, maxWaitMs, sleep);
  if (waited) return { ...hitResult(waited, ctx.entryId), coalesced: true };
  if (tryAcquire(ctx)) return leadAsync(ctx, fetch, startHeartbeat);
  return liveResultAsync(fetch, 'degraded', ctx.entryId);
}
async function strictFreshAsync(ctx, fetch) {
  const startedAt = ctx.now();
  const result = await fetch({});
  invalidateOnMissing(ctx, result, startedAt);
  try {
    publish(ctx, result, startedAt);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}
/**
 * Async twin of {@link readThroughGithubApiCache} for `hint` and
 * `strict-fresh` reads whose producer is asynchronous (a whole helper
 * enumeration rather than one REST call). It applies the same bypass,
 * identity, secret, size, and `incomplete` rules. A `hint` read holds the
 * same cross-process single-flight lease across the whole computation and
 * measures freshness from when the fetch started; a leader that died is
 * detected by its pid, a live one is waited on up to `leaseMaxWaitMs` and
 * never robbed, so a long enumeration is not duplicated. A `strict-fresh`
 * read, like the sync path's, takes no lease and ignores stored records: it
 * is defined as "compute now", and coalescing it onto an enumeration that
 * began earlier would return a record older than the call asked for. Fetch
 * failures propagate after any lease is released and are never stored.
 */
export async function readThroughGithubApiCacheAsync(input) {
  const { fetch, sleep, leaseMaxWaitMs, startLeaseHeartbeat, ...rest } = input;
  const prepared = prepareRead(
    {
      ...rest,
      leaseTtlMs: rest.leaseTtlMs ?? DEFAULT_ASYNC_LEASE_TTL_MS,
    },
    () => {
      throw new Error('the async cache path never calls the sync fetch');
    },
    () => {
      throw new Error('the async cache path never calls the sync sleep');
    },
  );
  if (prepared.kind === 'bypass') return liveResultAsync(fetch, 'bypass');
  if (prepared.kind === 'degraded') {
    return liveResultAsync(fetch, 'degraded', prepared.entryId);
  }
  const { ctx } = prepared;
  ctx.ageBasis = 'started';
  try {
    prepareRoot(ctx);
    if (input.mode === 'strict-fresh')
      return await strictFreshAsync(ctx, fetch);
    return await coalesceAsync(
      ctx,
      fetch,
      sleep ?? sleepAsync,
      positiveMs(
        leaseMaxWaitMs ?? DEFAULT_ASYNC_MAX_WAIT_MS,
        DEFAULT_ASYNC_MAX_WAIT_MS,
      ),
      startLeaseHeartbeat ?? defaultLeaseHeartbeat(ctx),
    );
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return liveResultAsync(fetch, 'degraded', ctx.entryId);
  }
}
