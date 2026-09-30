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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';

const SCHEMA_VERSION = 1;
const MARKER_NAME = '.idd-github-api-read-cache';
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
const TEMP_NAME = /^[0-9a-f]{64}\.json\.(\d+)\.[0-9a-f]{12}\.tmp$/;
const MAX_CACHE_BYTES = 104857600;
const DEFAULT_LEASE_TTL_MS = 15_000;
const POLL_MS = 20;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type GithubApiReadClassification =
  | 'read'
  | 'write'
  | 'graphql-mutation'
  | 'ambiguous-write'
  | 'authority';

export type GithubApiReadCacheMode = 'hint' | 'conditional' | 'strict-fresh';

export type GithubApiReadCacheDisposition =
  | 'bypass'
  | 'hit'
  | 'miss'
  | 'revalidated'
  | 'degraded'
  | 'purged'
  | 'refused';

/** Runtime policy. Durations are already milliseconds. */
export interface GithubApiReadCacheRuntimePolicy {
  enabled: boolean;
  maxAgeMs: number;
  maxBytes: number;
  retentionMs: number;
  directory?: string;
}

export interface GithubApiCacheFetchRequest {
  etag?: string;
  lastModified?: string;
}

export interface GithubApiCacheFetchResult {
  status: number;
  body: unknown;
  etag?: string;
  lastModified?: string;
  incomplete?: boolean;
  throttled?: boolean;
}

export interface GithubApiReadCacheStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
}

export interface GithubApiReadCacheStorage {
  mkdir(path: string): void;
  lstat(path: string): GithubApiReadCacheStat;
  readFile(path: string): string;
  writeExclusive(path: string, data: string): void;
  writeAtomic(destination: string, data: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
  chmod(path: string, mode: number): void;
}

export interface ReadThroughGithubApiCacheInput {
  classification: GithubApiReadClassification;
  mode?: GithubApiReadCacheMode;
  policy: GithubApiReadCacheRuntimePolicy;
  host: string;
  repository: string;
  credentialMaterial: string;
  secretMaterial?: readonly string[];
  requestShape: unknown;
  derivedInputs?: unknown;
  paginated?: boolean;
  operation?: 'read' | 'purge';
  fetch: (request: GithubApiCacheFetchRequest) => GithubApiCacheFetchResult;
  now?: () => number;
  sleep?: (ms: number) => void;
  leaseTtlMs?: number;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  workspaceRoot?: string;
  cwd?: string;
  defaultDirectory?: string;
  storage?: Partial<GithubApiReadCacheStorage>;
}

export interface ReadThroughGithubApiCacheResult {
  body: unknown;
  status: number;
  cache: GithubApiReadCacheDisposition;
  fetched: boolean;
  entryId?: string;
  removed?: number;
}

interface StoredRecord {
  schemaVersion: number;
  storedAt: number;
  status: number;
  body: unknown;
  complete: true;
  etag?: string;
  lastModified?: string;
}

interface CacheContext {
  storage: GithubApiReadCacheStorage;
  now: () => number;
  sleep: (ms: number) => void;
  leaseTtlMs: number;
  isPidAlive: (pid: number) => boolean;
  pid: number;
  anchors: readonly string[];
  maxBytes: number;
  entryId: string;
  root: string;
  secrets: readonly string[];
  host: string;
  repository: string;
  paginated: boolean;
  mode: GithubApiReadCacheMode;
  maxAgeMs: number;
  retentionMs: number;
  fetch: (request: GithubApiCacheFetchRequest) => GithubApiCacheFetchResult;
  heldLease: LeaseRecord | null;
}

class CacheStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CacheStorageError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

class CacheKeyError extends Error {
  constructor(message: string) {
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
function canonicalJson(value: unknown, depth = 0): string {
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
    return `[${value
      .map((item) => {
        if (item === undefined) {
          throw new CacheKeyError('undefined array item in cache key');
        }
        return canonicalJson(item, depth + 1);
      })
      .join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CacheKeyError('non-plain object in cache key');
  }
  const record = value as Record<string, unknown>;
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

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'github.com';
}

function normalizeMode(
  mode: GithubApiReadCacheMode | undefined,
): GithubApiReadCacheMode {
  if (mode === 'conditional' || mode === 'strict-fresh') return mode;
  return 'hint';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function defaultCacheDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
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

function comparePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface CanonicalFs {
  realpathSync(path: string): string;
  lstatSync(path: string): { isSymbolicLink(): boolean };
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
export function resolveCanonicalPath(
  path: string,
  fs: CanonicalFs = { realpathSync, lstatSync },
): string | null {
  let existing = resolve(path);
  const suffix: string[] = [];
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
function normalizedRoot(candidate: string): string | null {
  return isAbsolute(candidate) ? resolve(candidate) : null;
}

function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path);
  return resolved === parse(resolved).root;
}

function isAncestor(parent: string, child: string): boolean {
  if (parent === child) return false;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

function isUnsafeDirectory(
  candidate: string,
  anchors: readonly string[],
): boolean {
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

function defaultStorage(): GithubApiReadCacheStorage {
  return {
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true, mode: DIR_MODE });
    },
    lstat(path: string): GithubApiReadCacheStat {
      return lstatSync(path);
    },
    readFile(path: string): string {
      return readFileSync(path, 'utf8');
    },
    writeExclusive(path: string, data: string): void {
      writeFileSync(path, data, {
        encoding: 'utf8',
        mode: FILE_MODE,
        flag: 'wx',
      });
    },
    writeAtomic(destination: string, data: string): void {
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
    unlink(path: string): void {
      unlinkSync(path);
    },
    readdir(path: string): string[] {
      return readdirSync(path);
    },
    chmod(path: string, mode: number): void {
      chmodSync(path, mode);
    },
  };
}

function wrapStorageCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CacheStorageError) throw error;
    const wrapped = new CacheStorageError('cache storage failed', {
      cause: error,
    });
    const code = errorCode(error);
    if (code) {
      (wrapped as { code?: string }).code = code;
    }
    throw wrapped;
  }
}

function createStorage(
  override: Partial<GithubApiReadCacheStorage> | undefined,
): GithubApiReadCacheStorage {
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

function entryIdFor(input: ReadThroughGithubApiCacheInput): string {
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

function boundedBytes(value: number): number {
  if (!Number.isFinite(value) || value < 1) return MAX_CACHE_BYTES;
  return Math.min(Math.floor(value), MAX_CACHE_BYTES);
}

function positiveMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return value;
}

function containsSecret(
  secrets: readonly string[],
  haystacks: readonly string[],
): boolean {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const haystack of haystacks) {
      if (haystack.includes(secret)) return true;
    }
  }
  return false;
}

function liveResult(
  fetch: (request: GithubApiCacheFetchRequest) => GithubApiCacheFetchResult,
  cache: GithubApiReadCacheDisposition,
  entryId?: string,
): ReadThroughGithubApiCacheResult {
  const result = fetch({});
  return {
    body: result.body,
    status: result.status,
    cache,
    fetched: true,
    ...(entryId ? { entryId } : {}),
  };
}

function fromFetch(
  result: GithubApiCacheFetchResult,
  cache: GithubApiReadCacheDisposition,
  entryId: string,
): ReadThroughGithubApiCacheResult {
  return {
    body: result.body,
    status: result.status,
    cache,
    fetched: true,
    entryId,
  };
}

function tryLstat(
  storage: GithubApiReadCacheStorage,
  path: string,
): GithubApiReadCacheStat | null {
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
function tempWriterPid(name: string): number | null {
  const match = TEMP_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

function safeUnlink(storage: GithubApiReadCacheStorage, path: string): void {
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

function assertPrivate(
  storage: GithubApiReadCacheStorage,
  path: string,
  kind: 'dir' | 'file',
): void {
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

function ensurePrivateDir(ctx: CacheContext, path: string): void {
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
function assertAdoptableRoot(ctx: CacheContext): void {
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

function prepareRoot(ctx: CacheContext): void {
  if (isUnsafeDirectory(ctx.root, ctx.anchors)) {
    throw new CacheStorageError('unsafe cache directory');
  }
  assertAdoptableRoot(ctx);
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

function isStoredRecord(value: unknown, now: number): value is StoredRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
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

function isPrivateStat(stat: GithubApiReadCacheStat): boolean {
  if (process.platform === 'win32') return true;
  return (stat.mode & 0o077) === 0;
}

function readRecord(ctx: CacheContext, path: string): StoredRecord | null {
  const stat = tryLstat(ctx.storage, path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  if (!isPrivateStat(stat)) {
    safeUnlink(ctx.storage, path);
    return null;
  }
  let text: string;
  try {
    text = ctx.storage.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache read failed', { cause: error });
  }
  let parsed: unknown;
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

function entryPath(ctx: CacheContext): string {
  return join(ctx.root, 'entries', `${ctx.entryId}.json`);
}

function leasePath(ctx: CacheContext): string {
  return join(ctx.root, 'leases', `${ctx.entryId}.json`);
}

function trustedRecord(ctx: CacheContext): StoredRecord | null {
  const record = readRecord(ctx, entryPath(ctx));
  if (!record) return null;
  if (ctx.now() - record.storedAt > ctx.retentionMs) {
    safeUnlink(ctx.storage, entryPath(ctx));
    return null;
  }
  return record;
}

function freshRecord(ctx: CacheContext): StoredRecord | null {
  const record = trustedRecord(ctx);
  if (!record) return null;
  if (ctx.now() - record.storedAt > ctx.maxAgeMs) return null;
  return record;
}

function hitResult(
  record: StoredRecord,
  entryId: string,
): ReadThroughGithubApiCacheResult {
  return {
    body: record.body,
    status: record.status,
    cache: 'hit',
    fetched: false,
    entryId,
  };
}

function persistable(
  ctx: CacheContext,
  result: GithubApiCacheFetchResult,
): boolean {
  if (result.incomplete || result.throttled) return false;
  if (result.status < 200 || result.status >= 300) return false;
  const etag = result.etag ?? '';
  const lastModified = result.lastModified ?? '';
  let body: string;
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
 * A 404 or 410 is a definitive answer: the stored 200 for this same
 * context is contradicted, so hint reads must not keep serving it. Other
 * failures (401, 403, 429, 5xx) say nothing about the resource and keep
 * the entry. A non-forced (older in-flight) fetch never removes an entry
 * a newer fetch stored meanwhile.
 */
function invalidateOnMissing(
  ctx: CacheContext,
  result: GithubApiCacheFetchResult,
  startedAt: number,
  force: boolean,
): void {
  if (result.status !== 404 && result.status !== 410) return;
  try {
    const destination = entryPath(ctx);
    if (!force) {
      const existing = readRecord(ctx, destination);
      if (existing && existing.storedAt >= startedAt) return;
    }
    safeUnlink(ctx.storage, destination);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
}

function serializeRecord(record: StoredRecord): string {
  return JSON.stringify(record);
}

function publish(
  ctx: CacheContext,
  result: GithubApiCacheFetchResult,
  startedAt: number,
  force: boolean,
): void {
  if (!persistable(ctx, result)) return;
  const record: StoredRecord = {
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

function evict(ctx: CacheContext): void {
  const entriesDir = join(ctx.root, 'entries');
  const stat = tryLstat(ctx.storage, entriesDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  let names: string[];
  try {
    names = ctx.storage.readdir(entriesDir);
  } catch (error) {
    throw new CacheStorageError('cache readdir failed', { cause: error });
  }
  const keep: { path: string; size: number; storedAt: number }[] = [];
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

function refreshBase(
  ctx: CacheContext,
  base: StoredRecord,
  result: GithubApiCacheFetchResult,
): void {
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
  const record: StoredRecord = {
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

function leaderFetch(ctx: CacheContext): ReadThroughGithubApiCacheResult {
  const startedAt = ctx.now();
  if (ctx.mode === 'hint') {
    const fresh = freshRecord(ctx);
    if (fresh) return hitResult(fresh, ctx.entryId);
  }
  const base = ctx.mode === 'conditional' ? trustedRecord(ctx) : null;
  let result: GithubApiCacheFetchResult;
  if (ctx.mode === 'conditional' && base?.etag && !ctx.paginated) {
    result = ctx.fetch({ etag: base.etag, lastModified: base.lastModified });
    if (result.status === 304) {
      try {
        refreshBase(ctx, base, result);
      } catch (error) {
        if (!(error instanceof CacheStorageError)) throw error;
        const live = ctx.fetch({});
        invalidateOnMissing(ctx, live, startedAt, false);
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
  invalidateOnMissing(ctx, result, startedAt, false);
  try {
    publish(ctx, result, startedAt, false);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}

interface LeaseRecord {
  pid: number;
  createdAt: number;
  token?: string;
}

function readLease(ctx: CacheContext): LeaseRecord | null | 'stale' {
  const path = leasePath(ctx);
  const stat = tryLstat(ctx.storage, path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) return 'stale';
  let text: string;
  try {
    text = ctx.storage.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof CacheStorageError) throw error;
    throw new CacheStorageError('cache lease read failed', { cause: error });
  }
  try {
    const parsed = JSON.parse(text) as {
      pid?: unknown;
      createdAt?: unknown;
      token?: unknown;
    };
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

function leaseMatches(current: LeaseRecord, observed: LeaseRecord): boolean {
  if (observed.token !== undefined || current.token !== undefined) {
    return observed.token !== undefined && observed.token === current.token;
  }
  return (
    current.pid === observed.pid && current.createdAt === observed.createdAt
  );
}

function discardObservedLease(
  ctx: CacheContext,
  observed: LeaseRecord | 'stale',
): void {
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

function leaseIsStale(ctx: CacheContext, lease: LeaseRecord): boolean {
  if (lease.createdAt > ctx.now()) return true;
  if (ctx.now() - lease.createdAt > ctx.leaseTtlMs) return true;
  return !ctx.isPidAlive(lease.pid);
}

function tryAcquire(ctx: CacheContext): boolean {
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

function releaseLease(ctx: CacheContext): void {
  const held = ctx.heldLease;
  ctx.heldLease = null;
  if (!held) return;
  try {
    discardObservedLease(ctx, held);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
}

function waitForLeader(ctx: CacheContext): StoredRecord | null {
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

function coalesce(ctx: CacheContext): ReadThroughGithubApiCacheResult {
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

function strictFresh(ctx: CacheContext): ReadThroughGithubApiCacheResult {
  const startedAt = ctx.now();
  const result = ctx.fetch({});
  invalidateOnMissing(ctx, result, startedAt, true);
  try {
    publish(ctx, result, startedAt, true);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
  }
  return fromFetch(result, 'miss', ctx.entryId);
}

function resolveReadDirectory(
  input: ReadThroughGithubApiCacheInput,
  anchors: readonly string[],
): string {
  const candidates = [
    input.policy.directory?.trim() ?? '',
    input.defaultDirectory?.trim() ?? '',
    defaultCacheDirectory(process.env, process.platform),
  ];
  for (const candidate of candidates) {
    const root = normalizedRoot(candidate);
    if (root === null) continue;
    if (!isUnsafeDirectory(root, anchors)) return root;
  }
  throw new CacheStorageError('no safe cache directory');
}

function purgeDirectory(
  storage: GithubApiReadCacheStorage,
  root: string,
  anchors: readonly string[],
  isPidAlive: (pid: number) => boolean,
): ReadThroughGithubApiCacheResult {
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
function purgeTarget(input: ReadThroughGithubApiCacheInput): string {
  const configured = input.policy.directory?.trim() ?? '';
  if (configured.length > 0) return configured;
  const injected = input.defaultDirectory?.trim() ?? '';
  if (injected.length > 0) return injected;
  return defaultCacheDirectory(process.env, process.platform);
}

function anchorsFor(input: ReadThroughGithubApiCacheInput): string[] {
  const cwd = input.cwd ?? process.cwd();
  const anchors = [cwd];
  if (input.workspaceRoot && input.workspaceRoot !== cwd) {
    anchors.push(input.workspaceRoot);
  }
  return anchors;
}

function executeCached(ctx: CacheContext): ReadThroughGithubApiCacheResult {
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
export function readThroughGithubApiCache(
  input: ReadThroughGithubApiCacheInput,
): ReadThroughGithubApiCacheResult {
  const anchors = anchorsFor(input);
  const storage = createStorage(input.storage);
  if (input.operation === 'purge') {
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
  if (input.classification !== 'read' || input.policy.enabled !== true) {
    return liveResult(input.fetch, 'bypass');
  }
  // A blank credential or host would hash into a context shared by every
  // caller that omits it, so an unidentified caller never touches the cache.
  if (isBlank(input.credentialMaterial) || isBlank(input.host)) {
    return liveResult(input.fetch, 'bypass');
  }
  let entryId: string;
  try {
    entryId = entryIdFor(input);
  } catch (error) {
    if (!(error instanceof CacheKeyError)) throw error;
    return liveResult(input.fetch, 'bypass');
  }
  let root: string;
  try {
    root = resolveReadDirectory(input, anchors);
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    return liveResult(input.fetch, 'degraded', entryId);
  }
  const ctx: CacheContext = {
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
