// idd-generated-from: src/scripts/github-api-load-control.mts
//
// The scripts/github-api-load-control.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Opt-in host-local load control for the owned GitHub transport (issue
// #3586): bounded request admission and a shared throttle cooldown, kept as
// small files in one per-user directory so separate processes, repositories
// and worktrees of the same OS user coordinate. It never talks to GitHub,
// never polls `rate_limit`, never infers quota cost, and never claims
// cross-host or global enforcement. Credential material is hashed into the
// scope name and is never written anywhere.
//
// Failure model. A storage or identity problem degrades to today's
// uncoordinated behavior (the caller runs the request as if load control
// were off). Only evidence refuses a request: an active cooldown, a full
// admission slot, or an expired caller deadline. A refusal never dispatches
// the request, never retries it, and is never an ambiguous write.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname as osHostname, uptime as osUptime } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeGhFailure } from './github-api-observation.mjs';
import { createLoadControlRefusal } from './github-api-refusal.mjs';
import {
  GITHUB_API_LOAD_CONTROL_MAX_CONCURRENT,
  GITHUB_API_LOAD_CONTROL_MAX_WAIT_MS,
} from './policy-helpers.mjs';

const SCHEMA_VERSION = 1;
const SLOT_NAME = /^slot-(\d+)-(\d{12})\.json$/;
const EVENT_NAME =
  /^(secondary|primary)\.[A-Za-z0-9_-]{1,64}\.\d{15}\.[0-9a-f]{16}\.json$/;
const EVENT_UNTIL = /\.(\d{15})\.[0-9a-f]{16}\.json$/;
const TEMP_NAME = /\.tmp$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** How long a just-created lease file may look empty before it counts as a crash. */
const PARTIAL_LEASE_GRACE_MS = 2_000;
/** Temporary files older than this are orphans of a crashed writer. */
const ORPHAN_TEMP_MS = 60_000;
const POLL_MS = 25;
const POLL_JITTER_MS = 25;
/** Longest single sleep while waiting out a cooldown, so an extension is noticed. */
const COOLDOWN_CHUNK_MS = 1_000;
const CREATE_ATTEMPTS = 4;
const MAX_EVENT_FILES = 64;
/** Link failures that mean "this filesystem cannot hard-link", not a real fault. */
const LINK_UNSUPPORTED = new Set([
  'EPERM',
  'ENOSYS',
  'EOPNOTSUPP',
  'ENOTSUP',
  'EXDEV',
]);
/** GitHub asks for at least a minute of backoff when no timing is given. */
// audit:ignore-dead-export: cooldown tuning constant asserted by the load-control tests (issue #3586)
export const SECONDARY_BASE_COOLDOWN_MS = 60_000;
// audit:ignore-dead-export: cooldown tuning constant asserted by the load-control tests (issue #3586)
export const MAX_BACKOFF_COOLDOWN_MS = 900_000;
/** Upper bound on any single cooldown, observed or derived. */
// audit:ignore-dead-export: cooldown tuning constant asserted by the load-control tests (issue #3586)
export const MAX_COOLDOWN_MS = 3_600_000;
/** Throttles closer together than this share one escalating backoff. */
// audit:ignore-dead-export: cooldown tuning constant asserted by the load-control tests (issue #3586)
export const COOLDOWN_DECAY_MS = 1_800_000;
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
/** Per-user state root: `XDG_STATE_HOME` or `~/.local/state`, `LOCALAPPDATA` on Windows. */
// audit:ignore-dead-export: reached in production through admitRequest; exported so its cases are unit-tested (issue #3586)
export function defaultLoadControlDirectory(
  env = process.env,
  platform = process.platform,
) {
  // A relative base would resolve against each caller's working directory,
  // so separate worktrees would stop sharing state and could create it
  // inside a workspace. The XDG specification says to ignore a relative
  // value (the read cache refuses one instead): use the per-user default.
  const absolute = (value) => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return (platform === 'win32' ? win32 : posix).isAbsolute(trimmed)
      ? trimmed
      : undefined;
  };
  if (platform === 'win32') {
    const base =
      absolute(env.LOCALAPPDATA) ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'idd-skill', 'github-api-load-control');
  }
  const base =
    absolute(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state');
  return join(base, 'idd-skill', 'github-api-load-control');
}
/**
 * Scope name for one host and one verified credential. The host is
 * lower-cased so two spellings of it share a scope, and the credential only
 * ever enters as a hash.
 */
// audit:ignore-dead-export: reached in production through admitRequest; exported so tests can locate a scope (issue #3586)
export function loadControlScopeName(identity) {
  const host = identity.host.trim().toLowerCase();
  return sha256(
    `idd-github-api-load-control:v1\0${host}\0${sha256(identity.credentialMaterial)}`,
  );
}
function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string' ? code : undefined;
}
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user.
    return errorCode(error) !== 'ESRCH';
  }
}
/**
 * The kernel start time and state of `pid` (`/proc/<pid>/stat`) on Linux,
 * else an empty identity. The start time tells a live holder from an
 * unrelated process that reused a dead holder's pid, and a zombie is not a
 * live holder. Elsewhere the check degrades to pid liveness: a reused pid
 * then looks alive, which only keeps a lease, never steals one.
 */
// audit:ignore-dead-export: reached in production through admitRequest; exported so its cases are unit-tested (issue #3586)
export function readProcessIdentity(pid, platform = process.platform) {
  if (platform !== 'linux') return {};
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesised and may contain spaces; the fields
    // after the last `)` start at field 3, so the state is index 0 and the
    // start time (field 22) is index 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      ...(fields[19] ? { startToken: fields[19] } : {}),
      ...(fields[0] ? { state: fields[0] } : {}),
    };
  } catch {
    return {};
  }
}
let pidNamespaceCache;
function readPidNamespace() {
  if (pidNamespaceCache !== undefined) return pidNamespaceCache;
  let value = '';
  if (process.platform === 'linux') {
    try {
      value = readlinkSync('/proc/self/ns/pid');
    } catch {
      value = '';
    }
  }
  pidNamespaceCache = value;
  return value;
}
let bootIdCache = null;
/** The Linux `boot_id`, else undefined: no other supported OS exposes one cheaply. */
function readBootId() {
  if (bootIdCache !== null) return bootIdCache;
  let value;
  if (process.platform === 'linux') {
    try {
      value =
        readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() ||
        undefined;
    } catch {
      value = undefined;
    }
  }
  bootIdCache = value;
  return value;
}
function sleepBlocking(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** A storage problem. Callers fail open on it. */
class LoadControlStorageError extends Error {}
function storageFailure(message, cause) {
  throw new LoadControlStorageError(message, { cause });
}
/**
 * Require that this user owns `path` and that no one else can use it. A
 * directory that already existed may be group- or world-accessible, which
 * would let another local user forge or delete a lease or a cooldown.
 * Tighten it to owner-only; a chmod that fails means it cannot be made
 * private, so the request runs uncoordinated. A filesystem that accepts the
 * call but stores no modes (a Windows mount under WSL) enforces none, so its
 * reported mode is not evidence of anything. Windows keeps its own ACL model.
 */
function requireOwnedAndPrivate(path, stat) {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    storageFailure('load control directory belongs to another user');
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, DIR_MODE);
}
function ensureRoot(path) {
  try {
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
    // The root may legitimately be reached through a symlink (a relocated
    // state directory), so its target is what is inspected. Its children are
    // required to be real directories.
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      storageFailure('load control root is not a directory');
    }
    if (lstatSync(path).isSymbolicLink()) {
      // A relocated root is the operator's own choice: inspect its target,
      // but never chmod a directory this code did not create. One that is
      // not already private runs the request uncoordinated instead.
      if (process.platform !== 'win32') {
        if (
          typeof process.getuid === 'function' &&
          stat.uid !== process.getuid()
        ) {
          storageFailure('load control directory belongs to another user');
        }
        if ((stat.mode & 0o077) !== 0) {
          storageFailure('a relocated load control root is not private');
        }
      }
    } else {
      requireOwnedAndPrivate(path, stat);
    }
  } catch (error) {
    if (error instanceof LoadControlStorageError) throw error;
    storageFailure('load control directory is unavailable', error);
  }
}
function ensureOwnDirectory(path) {
  try {
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      storageFailure('load control path is not a real directory');
    }
    requireOwnedAndPrivate(path, stat);
  } catch (error) {
    if (error instanceof LoadControlStorageError) throw error;
    storageFailure('load control directory is unavailable', error);
  }
}
function writeAtomic(path, data) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: FILE_MODE, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already have been renamed.
    }
    throw error;
  }
}
/**
 * Create `path` with its whole content or not at all. A temporary file is
 * written and hard-linked into place, so no reader ever sees a partial
 * lease and exactly one creator wins. Where the filesystem cannot hard-link,
 * an exclusive create is the fallback; its short window is what the
 * partial-file grace in {@link isLive} covers.
 */
function publishExclusive(path, data) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, data, { mode: FILE_MODE, flag: 'wx' });
  try {
    linkSync(temporary, path);
    return 'created';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') return 'exists';
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
  }
  try {
    writeFileSync(path, data, { mode: FILE_MODE, flag: 'wx' });
    return 'created';
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return 'exists';
    throw error;
  }
}
function slotFileName(slot, generation) {
  return `slot-${slot}-${String(generation).padStart(12, '0')}.json`;
}
function listSlot(ctx, slot) {
  let names;
  try {
    names = readdirSync(ctx.slotsPath);
  } catch (error) {
    storageFailure('load control slots are unreadable', error);
  }
  const entries = [];
  for (const name of names) {
    const match = SLOT_NAME.exec(name);
    if (!match || Number(match[1]) !== slot) continue;
    entries.push({ slot, generation: Number(match[2]), name });
  }
  return entries.sort((left, right) => left.generation - right.generation);
}
function parseLease(text) {
  try {
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== SCHEMA_VERSION
    ) {
      return null;
    }
    if (parsed.released === true) {
      return {
        schemaVersion: SCHEMA_VERSION,
        pid: 0,
        token: '',
        createdAt: 0,
        released: true,
      };
    }
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      pid: parsed.pid,
      token: parsed.token,
      createdAt: parsed.createdAt,
      ...(typeof parsed.startToken === 'string'
        ? { startToken: parsed.startToken }
        : {}),
    };
  } catch {
    return null;
  }
}
function readLease(ctx, entry) {
  const path = join(ctx.slotsPath, entry.name);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { record: null, missing: true, ageMs: 0 };
    }
    storageFailure('load control lease is unreadable', error);
  }
  const record = parseLease(text);
  let ageMs = 0;
  if (record === null) {
    try {
      ageMs = ctx.now() - statSync(path).mtimeMs;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { record: null, missing: true, ageMs: 0 };
      }
      storageFailure('load control lease is unreadable', error);
    }
  }
  return { record, missing: false, ageMs };
}
/**
 * Whether a lease file still denotes a running holder. An active lease is
 * never judged by age. Only a dead pid, a recycled pid (Linux start-time
 * mismatch), a zombie, a released marker, or a file abandoned mid-write is
 * free. The slots directory is keyed by hostname and pid namespace, so a
 * lease this process cannot check is never seen at all.
 */
function isLive(ctx, lease) {
  if (lease.missing) return false;
  if (lease.record === null) {
    // Only the exclusive-create fallback can leave an empty or partial
    // file: a fresh one is a holder still writing, an old one a crash. A
    // clock that stepped back a little does not make it old.
    return (
      lease.ageMs > -PARTIAL_LEASE_GRACE_MS &&
      lease.ageMs < PARTIAL_LEASE_GRACE_MS
    );
  }
  const record = lease.record;
  if (record.released) return false;
  if (!ctx.isPidAlive(record.pid)) return false;
  const identity = ctx.processIdentity(record.pid);
  if (identity.state === 'Z' || identity.state === 'X') return false;
  if (
    record.startToken !== undefined &&
    identity.startToken !== undefined &&
    identity.startToken !== record.startToken
  ) {
    return false;
  }
  return true;
}
/**
 * Tokens of the leases this process holds right now. A lease file names its
 * holder by pid, and where no start time is readable (anywhere but Linux) a
 * dead holder's recycled pid cannot be told from this process, so "this
 * process's lease" must never rest on the pid alone.
 */
const heldTokens = new Set();
function releaseLeaseFile(ctx, lease) {
  const entry = {
    slot: lease.slot,
    generation: lease.generation,
    name: slotFileName(lease.slot, lease.generation),
  };
  const path = join(ctx.slotsPath, entry.name);
  const released = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    released: true,
  });
  try {
    const current = readLease(ctx, entry).record;
    // Only mark the file this process wrote. The highest-generation file is
    // kept, marked released, so an acquirer always sees where to continue.
    if (current?.token !== lease.token) {
      heldTokens.delete(lease.token);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeAtomic(path, released);
        heldTokens.delete(lease.token);
        return;
      } catch {
        // A concurrent reader can hold the file open on Windows; try again.
      }
    }
    unlinkSync(path);
    heldTokens.delete(lease.token);
  } catch {
    // A lease that cannot be marked stays until its process is gone, and
    // its token stays with it: it is still a lease this process holds.
  }
}
function collectSlotGarbage(ctx, slot, keepFrom) {
  try {
    for (const entry of listSlot(ctx, slot)) {
      if (entry.generation >= keepFrom) continue;
      if (isLive(ctx, readLease(ctx, entry))) continue;
      try {
        unlinkSync(join(ctx.slotsPath, entry.name));
      } catch {
        // Another collector removed it.
      }
    }
    for (const name of readdirSync(ctx.slotsPath)) {
      if (!TEMP_NAME.test(name)) continue;
      try {
        const path = join(ctx.slotsPath, name);
        if (ctx.now() - statSync(path).mtimeMs > ORPHAN_TEMP_MS)
          unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Garbage collection is best effort.
  }
}
/**
 * Try to take one slot. A slot is free when none of its files is live. The
 * winner of the exclusive create of the next generation is the only
 * candidate, and a fence then concedes if its own file is gone or if any
 * other live file exists in the slot. The fence covers the one interleaving
 * exclusive create does not settle: a stale creator recreating a
 * garbage-collected lower generation while a holder is running.
 */
function trySlot(ctx, slot) {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const entries = listSlot(ctx, slot);
    for (const entry of entries) {
      const lease = readLease(ctx, entry);
      if (isLive(ctx, lease)) {
        return { kind: 'busy', holderPid: lease.record?.pid };
      }
    }
    const generation = (entries.at(-1)?.generation ?? 0) + 1;
    const token = randomBytes(16).toString('hex');
    const startToken = ctx.processIdentity(ctx.pid).startToken;
    const record = {
      schemaVersion: SCHEMA_VERSION,
      pid: ctx.pid,
      token,
      createdAt: ctx.now(),
      ...(startToken !== undefined ? { startToken } : {}),
    };
    const path = join(ctx.slotsPath, slotFileName(slot, generation));
    let published;
    try {
      published = publishExclusive(path, JSON.stringify(record));
    } catch (error) {
      storageFailure('load control lease could not be created', error);
    }
    if (published === 'exists') continue;
    const lease = { slot, generation, token };
    // Registered as soon as the file exists, so a fault below cannot leave
    // an unreleased lease of this process that it no longer recognizes.
    heldTokens.add(token);
    const own = readLease(ctx, {
      slot,
      generation,
      name: slotFileName(slot, generation),
    });
    let conceded = own.record?.token !== token;
    if (!conceded) {
      for (const other of listSlot(ctx, slot)) {
        if (other.generation === generation) continue;
        if (isLive(ctx, readLease(ctx, other))) {
          conceded = true;
          break;
        }
      }
    }
    if (conceded) {
      releaseLeaseFile(ctx, lease);
      return { kind: 'busy' };
    }
    collectSlotGarbage(ctx, slot, generation);
    return { kind: 'acquired', lease };
  }
  return { kind: 'busy' };
}
/**
 * True when every slot is held, and held only by live leases of this very
 * process. Only then can waiting never succeed: the event loop that would
 * release them is the one a synchronous wait blocks. A slot another process
 * holds (or a free one) will clear without this process, so the request
 * waits for it as usual instead of running beyond the bound.
 */
function onlyThisProcessBlocks(ctx) {
  for (let slot = 0; slot < ctx.maxConcurrent; slot += 1) {
    let own = false;
    for (const entry of listSlot(ctx, slot)) {
      const lease = readLease(ctx, entry);
      if (!isLive(ctx, lease)) continue;
      // The pid alone is not proof: after pid reuse a stale lease of a dead
      // process would pass for this one, so the lease must also be one this
      // process holds.
      if (
        lease.record?.pid !== ctx.pid ||
        !heldTokens.has(lease.record.token)
      ) {
        return false;
      }
      own = true;
    }
    if (!own) return false;
  }
  return true;
}
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function readEvents(ctx) {
  let names;
  try {
    names = readdirSync(ctx.cooldownPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    storageFailure('load control cooldown is unreadable', error);
  }
  const events = [];
  for (const name of names) {
    if (!EVENT_NAME.test(name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(ctx.cooldownPath, name), 'utf8'));
    } catch {
      continue;
    }
    if (
      !parsed ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      (parsed.kind !== 'secondary' && parsed.kind !== 'primary') ||
      !finiteNumber(parsed.observedAt) ||
      !finiteNumber(parsed.until) ||
      !finiteNumber(parsed.durationMs) ||
      !finiteNumber(parsed.level) ||
      (parsed.source !== 'server' && parsed.source !== 'backoff')
    ) {
      continue;
    }
    events.push({
      schemaVersion: SCHEMA_VERSION,
      kind: parsed.kind,
      ...(typeof parsed.resource === 'string'
        ? { resource: parsed.resource }
        : {}),
      observedAt: parsed.observedAt,
      ...(finiteNumber(parsed.observedUptimeMs)
        ? { observedUptimeMs: parsed.observedUptimeMs }
        : {}),
      ...(typeof parsed.bootId === 'string' && parsed.bootId.length > 0
        ? { bootId: parsed.bootId }
        : {}),
      until: parsed.until,
      // Whatever the file says, a cooldown is bounded.
      durationMs: Math.min(Math.max(parsed.durationMs, 0), MAX_COOLDOWN_MS),
      level: Math.max(1, Math.floor(parsed.level)),
      source: parsed.source,
    });
  }
  return events;
}
/**
 * Milliseconds still to wait for one event. On the very boot that wrote it
 * (an event and this process report the same boot identity) the remainder
 * is the duration minus the OS uptime elapsed, which a wall-clock step
 * cannot change. Anywhere else, including across a reboot (whose new uptime
 * would otherwise be mistaken for time elapsed since the event) and where
 * the OS names no boot, it is bounded by the duration chosen when the event
 * was written, so a clock that moves backwards never stretches a cooldown
 * past its own length.
 */
function remainingMs(ctx, event, now) {
  if (
    event.bootId !== undefined &&
    event.bootId === ctx.bootId &&
    event.observedUptimeMs !== undefined
  ) {
    const uptime = ctx.uptimeMs();
    if (uptime >= event.observedUptimeMs) {
      return event.durationMs - (uptime - event.observedUptimeMs);
    }
  }
  return Math.min(event.until - now, event.durationMs);
}
/**
 * The longest cooldown that applies to a request. Secondary events cover
 * every resource and both protocols; primary events cover only their own
 * resource, and never a request that does not name one.
 */
function activeCooldown(ctx, resource) {
  const now = ctx.now();
  let best = null;
  for (const event of readEvents(ctx)) {
    if (
      event.kind === 'primary' &&
      (resource === undefined || event.resource !== resource)
    ) {
      continue;
    }
    const remaining = remainingMs(ctx, event, now);
    if (remaining > (best?.remainingMs ?? 0)) {
      best = {
        remainingMs: remaining,
        retryAtMs: now + remaining,
        source: event.source,
      };
    }
  }
  return best;
}
/** The cooldown family an event file belongs to: its kind and its scope. */
function eventFamily(name) {
  return name.split('.', 2).join('.');
}
function collectEventGarbage(ctx) {
  try {
    const now = ctx.now();
    const survivors = [];
    for (const name of readdirSync(ctx.cooldownPath)) {
      const path = join(ctx.cooldownPath, name);
      if (TEMP_NAME.test(name)) {
        if (now - statSync(path).mtimeMs > ORPHAN_TEMP_MS) unlinkSync(path);
        continue;
      }
      const until = Number(EVENT_UNTIL.exec(name)?.[1]);
      if (!EVENT_NAME.test(name) || !Number.isFinite(until)) continue;
      // Keep an expired event for the decay window: it drives escalation.
      if (until < now - COOLDOWN_DECAY_MS) {
        unlinkSync(path);
        continue;
      }
      survivors.push({ name, until });
    }
    // The longest-lived event of each family (the shared secondary cooldown,
    // or one resource's primary cooldown) is what an active cooldown rests
    // on, so it is never trimmed: dropping it would end that cooldown early.
    // Only the rest are trimmed, oldest first.
    const longest = new Map();
    for (const survivor of survivors) {
      const family = eventFamily(survivor.name);
      const current = longest.get(family);
      if (current === undefined || survivor.until > current.until) {
        longest.set(family, survivor);
      }
    }
    const kept = new Set([...longest.values()].map((event) => event.name));
    const trimmable = survivors
      .filter((event) => !kept.has(event.name))
      .sort((left, right) => left.until - right.until);
    for (const stale of trimmable.slice(
      0,
      Math.max(0, survivors.length - MAX_EVENT_FILES),
    )) {
      unlinkSync(join(ctx.cooldownPath, stale.name));
    }
  } catch {
    // Garbage collection is best effort.
  }
}
/**
 * Append one throttle event. Events are unique files, so concurrent writers
 * never overwrite each other: the effective cooldown is the maximum, which
 * makes concurrent extensions converge on the longest.
 *
 * Backoff level. A throttle while a cooldown of the same family is still
 * active belongs to that episode and keeps its level (an in-flight request
 * failing late is not a new throttle). The first throttle after expiry
 * inside the decay window escalates one level, whichever protocol it came
 * from, so alternating REST and GraphQL climbs the backoff instead of
 * restarting it.
 */
function recordThrottle(ctx, verdict) {
  const now = ctx.now();
  const kind = verdict.kind === 'primary' ? 'primary' : 'secondary';
  const resource = verdict.kind === 'primary' ? verdict.resource : undefined;
  const family = readEvents(ctx).filter(
    (event) => event.kind === kind && event.resource === resource,
  );
  let level = 1;
  const active = family.filter((event) => remainingMs(ctx, event, now) > 0);
  if (active.length > 0) {
    level = Math.max(...active.map((event) => event.level));
  } else {
    const recent = family.filter(
      (event) => Math.min(event.observedAt, now) >= now - COOLDOWN_DECAY_MS,
    );
    if (recent.length > 0) {
      level = Math.max(...recent.map((event) => event.level)) + 1;
    }
  }
  let durationMs;
  let source = 'backoff';
  const resetMs =
    verdict.resetEpochSec === undefined
      ? undefined
      : verdict.resetEpochSec * 1000 - now;
  if (verdict.retryAfterSec !== undefined && verdict.retryAfterSec >= 0) {
    durationMs = Math.min(
      Math.max(verdict.retryAfterSec * 1000, 1_000),
      MAX_COOLDOWN_MS,
    );
    source = 'server';
  } else if (kind === 'primary' && resetMs !== undefined && resetMs > 0) {
    durationMs = Math.min(resetMs, MAX_COOLDOWN_MS);
    source = 'server';
  } else {
    durationMs = Math.min(
      MAX_BACKOFF_COOLDOWN_MS,
      SECONDARY_BASE_COOLDOWN_MS * 2 ** (level - 1),
    );
  }
  const event = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    ...(resource !== undefined ? { resource } : {}),
    observedAt: now,
    ...(ctx.bootId !== undefined
      ? { observedUptimeMs: ctx.uptimeMs(), bootId: ctx.bootId }
      : {}),
    until: now + durationMs,
    durationMs,
    level,
    source,
  };
  const scope =
    kind === 'primary'
      ? (resource ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
      : 'shared';
  const name = `${kind}.${scope}.${String(Math.max(0, Math.floor(event.until))).padStart(15, '0')}.${randomBytes(8).toString('hex')}.json`;
  writeAtomic(join(ctx.cooldownPath, name), JSON.stringify(event));
  collectEventGarbage(ctx);
}
const RATE_LIMIT_WORDING =
  /rate limit|abuse detection|secondary rate|too many requests/i;
function graphqlRateLimited(stdout) {
  if (typeof stdout !== 'string') return false;
  const start = stdout.indexOf('{');
  if (start < 0) return false;
  try {
    const root = JSON.parse(stdout.slice(start));
    if (!Array.isArray(root.errors)) return false;
    return root.errors.some((entry) => {
      const item = entry;
      return (
        item?.type === 'RATE_LIMITED' ||
        (typeof item?.message === 'string' &&
          RATE_LIMIT_WORDING.test(item.message))
      );
    });
  } catch {
    return false;
  }
}
/**
 * Decide whether one failed `gh` call is a throttle, and of which kind.
 *
 * A per-resource primary verdict needs either a header or body reading of
 * `remaining: 0` (the observed resource) or the explicit primary wording
 * (`API rate limit exceeded`, without the secondary wording) on a request
 * that names its own resource. Everything else that reads as a rate limit
 * (the secondary wording, HTTP 429, a retry-after, a GraphQL `RATE_LIMITED`
 * error, or a bare "API rate limit already exceeded" as in issue #3560,
 * which no quota reading can attribute) is shared by REST and GraphQL and
 * by every resource: misfiling it as one resource's primary limit would
 * let the next request hop protocols into the same throttle.
 */
// audit:ignore-dead-export: reached in production through the gate's recordFailure; exported so its cases are unit-tested (issue #3586)
export function classifyThrottle(observation, evidence, requestResource) {
  const retryAfterSec =
    typeof observation.retryAfter === 'number'
      ? observation.retryAfter
      : undefined;
  const resetEpochSec =
    typeof observation.reset === 'number' ? observation.reset : undefined;
  const timing = {
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    ...(resetEpochSec !== undefined ? { resetEpochSec } : {}),
  };
  // Anything that reads as a secondary limit wins over a `remaining` of 0
  // read from the same failure: the throttle is account-wide, and one
  // resource being empty says nothing about the others. A `retry-after` is
  // GitHub's secondary-limit timing, and the older abuse-detection wording
  // names the same limit.
  const stderr = typeof evidence.stderr === 'string' ? evidence.stderr : '';
  const secondaryLike =
    observation.signals.secondaryThrottling ||
    retryAfterSec !== undefined ||
    /abuse detection|secondary rate/i.test(stderr);
  if (observation.remaining === 0 && !secondaryLike) {
    const resource =
      typeof observation.resource === 'string' &&
      observation.resource !== 'unknown'
        ? observation.resource
        : requestResource;
    return resource !== undefined
      ? { kind: 'primary', resource, ...timing }
      : { kind: 'shared', ...timing };
  }
  if (
    observation.signals.primaryExhaustion &&
    !secondaryLike &&
    requestResource !== undefined
  ) {
    return { kind: 'primary', resource: requestResource, ...timing };
  }
  const status =
    typeof observation.status === 'number' ? observation.status : null;
  const wording =
    observation.signals.secondaryThrottling ||
    observation.signals.primaryExhaustion ||
    RATE_LIMIT_WORDING.test(stderr) ||
    graphqlRateLimited(evidence.stdout);
  if (
    status === 429 ||
    wording ||
    (status === 403 && retryAfterSec !== undefined)
  ) {
    return {
      kind: 'shared',
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    };
  }
  return null;
}
function buildContext(identity, policy, runtime) {
  const env = runtime.env ?? process.env;
  const root =
    runtime.directory ??
    defaultLoadControlDirectory(env, runtime.platform ?? process.platform);
  const hostname = runtime.hostname ?? osHostname();
  const hostKey = sha256(
    `${hostname}\0${runtime.pidNamespace ?? readPidNamespace()}`,
  ).slice(0, 12);
  const scopeDirectory = join(root, loadControlScopeName(identity));
  const maxConcurrent = Number.isInteger(policy.maxConcurrent)
    ? Math.min(
        Math.max(policy.maxConcurrent, 1),
        GITHUB_API_LOAD_CONTROL_MAX_CONCURRENT,
      )
    : 1;
  const platform = runtime.platform ?? process.platform;
  return {
    root,
    ctx: {
      scopeDirectory,
      slotsPath: join(scopeDirectory, `slots-${hostKey}`),
      cooldownPath: join(scopeDirectory, 'cooldown'),
      now: runtime.now ?? Date.now,
      monotonic: runtime.monotonic ?? (() => performance.now()),
      uptimeMs: runtime.uptimeMs ?? (() => osUptime() * 1000),
      bootId: 'bootId' in runtime ? runtime.bootId : readBootId(),
      sleepSync: runtime.sleepSync ?? sleepBlocking,
      sleep: runtime.sleep ?? ((ms) => delay(ms)),
      isPidAlive: runtime.isPidAlive ?? defaultIsPidAlive,
      processIdentity:
        runtime.processIdentity ??
        ((pid) => readProcessIdentity(pid, platform)),
      pid: runtime.pid ?? process.pid,
      hostname,
      random: runtime.random ?? Math.random,
      maxConcurrent,
    },
  };
}
function cooldownDetail(cooldown, outcome) {
  return {
    outcome,
    reason: 'cooldown',
    retryAt: new Date(cooldown.retryAtMs).toISOString(),
    retryAtSource: cooldown.source,
  };
}
function deadlineFor(request, policy) {
  const requested = request.deadlineMs ?? policy.maxWaitMs;
  if (!Number.isFinite(requested) || requested < 0) return 0;
  return Math.min(requested, GITHUB_API_LOAD_CONTROL_MAX_WAIT_MS);
}
/**
 * One admission pass: cooldown, then a slot, then the cooldown again (a
 * throttle may have been recorded while the slot was taken), so nothing is
 * dispatched into a cooldown that began before the lease. A read waits;
 * anything else is admitted now or refused.
 */
function step(ctx, request, deadlineAt, synchronous) {
  const waits = request.classification === 'read';
  const remainingDeadline = deadlineAt - ctx.monotonic();
  const cooldown = activeCooldown(ctx, request.resource);
  if (cooldown) {
    if (!waits) {
      return {
        kind: 'refuse',
        detail: cooldownDetail(cooldown, 'not-dispatched'),
      };
    }
    if (cooldown.remainingMs > remainingDeadline) {
      return {
        kind: 'refuse',
        detail: cooldownDetail(cooldown, 'deadline-expired'),
      };
    }
    return {
      kind: 'wait',
      ms: Math.max(1, Math.min(cooldown.remainingMs, COOLDOWN_CHUNK_MS)),
    };
  }
  let holderPid;
  for (let slot = 0; slot < ctx.maxConcurrent; slot += 1) {
    const attempt = trySlot(ctx, slot);
    if (attempt.kind === 'busy') {
      holderPid ??= attempt.holderPid;
      continue;
    }
    let late;
    try {
      late = activeCooldown(ctx, request.resource);
    } catch (error) {
      releaseLeaseFile(ctx, attempt.lease);
      throw error;
    }
    if (!late) return { kind: 'admitted', lease: attempt.lease };
    releaseLeaseFile(ctx, attempt.lease);
    return waits
      ? { kind: 'wait', ms: 1 }
      : { kind: 'refuse', detail: cooldownDetail(late, 'not-dispatched') };
  }
  const busy = {
    outcome: 'not-dispatched',
    reason: 'busy',
    ...(holderPid !== undefined ? { holderPid } : {}),
  };
  if (!waits) return { kind: 'refuse', detail: busy };
  // A sync waiter cannot see this process's own async lease released: the
  // event loop that would release it is blocked. Ride on it instead.
  if (synchronous && onlyThisProcessBlocks(ctx))
    return { kind: 'admitted', lease: null };
  if (remainingDeadline <= 0) {
    return { kind: 'refuse', detail: { ...busy, outcome: 'deadline-expired' } };
  }
  const jitter = ctx.random() * POLL_JITTER_MS;
  return {
    kind: 'wait',
    ms: Math.max(1, Math.min(POLL_MS + jitter, remainingDeadline)),
  };
}
function makeGate(ctx, request, lease, waitedMs) {
  let released = false;
  const recordFailure = (evidence) => {
    try {
      const observation = observeGhFailure(evidence, {
        graphql: request.resource === 'graphql',
        paginated: request.paginated === true,
      });
      const source = evidence;
      const verdict = classifyThrottle(
        observation,
        { stderr: source?.stderr, stdout: source?.stdout },
        request.resource,
      );
      if (verdict) recordThrottle(ctx, verdict);
    } catch {
      // Recording is best effort: it must not replace the call's outcome.
    }
  };
  return {
    joined: lease === null,
    waitedMs,
    recordFailure,
    recordResponse(text) {
      if (request.resource !== 'graphql' || !text.includes('RATE_LIMITED')) {
        return;
      }
      recordFailure({ stderr: '', stdout: text });
    },
    release() {
      if (released || lease === null) return;
      released = true;
      releaseLeaseFile(ctx, lease);
    },
  };
}
function prepare(identity, policy, runtime) {
  if (policy.enabled !== true) return null;
  if (
    typeof identity.host !== 'string' ||
    identity.host.trim() === '' ||
    typeof identity.credentialMaterial !== 'string' ||
    identity.credentialMaterial.trim() === ''
  ) {
    // An unverified identity is never guessed into someone's scope.
    return null;
  }
  try {
    const { ctx, root } = buildContext(identity, policy, runtime);
    ensureRoot(root);
    ensureOwnDirectory(ctx.scopeDirectory);
    ensureOwnDirectory(ctx.slotsPath);
    ensureOwnDirectory(ctx.cooldownPath);
    return ctx;
  } catch (error) {
    if (error instanceof LoadControlStorageError) return null;
    throw error;
  }
}
/**
 * Admit one request, blocking the process while it waits. Returns null when
 * the request runs uncoordinated (disabled, unverified identity, or a
 * storage problem) and throws the refusal error when it must not run.
 */
export function admitRequestSync(identity, policy, request, runtime = {}) {
  const ctx = prepare(identity, policy, runtime);
  if (ctx === null) return null;
  const startedAt = ctx.monotonic();
  const deadlineAt = startedAt + deadlineFor(request, policy);
  try {
    for (;;) {
      const next = step(ctx, request, deadlineAt, true);
      if (next.kind === 'admitted') {
        return makeGate(ctx, request, next.lease, ctx.monotonic() - startedAt);
      }
      if (next.kind === 'refuse') throw createLoadControlRefusal(next.detail);
      ctx.sleepSync(next.ms);
    }
  } catch (error) {
    if (error instanceof LoadControlStorageError) return null;
    throw error;
  }
}
/**
 * Async sibling of {@link admitRequestSync}. Waiting uses a timer, not a
 * blocking wait, so this process's own in-flight requests keep completing
 * and releasing their leases while this one waits.
 */
export async function admitRequest(identity, policy, request, runtime = {}) {
  const ctx = prepare(identity, policy, runtime);
  if (ctx === null) return null;
  const startedAt = ctx.monotonic();
  const deadlineAt = startedAt + deadlineFor(request, policy);
  try {
    for (;;) {
      const next = step(ctx, request, deadlineAt, false);
      if (next.kind === 'admitted') {
        return makeGate(ctx, request, next.lease, ctx.monotonic() - startedAt);
      }
      if (next.kind === 'refuse') throw createLoadControlRefusal(next.detail);
      await ctx.sleep(next.ms);
    }
  } catch (error) {
    if (error instanceof LoadControlStorageError) return null;
    throw error;
  }
}
