// idd-generated-from: src/scripts/windows-acl.mts
//
// The scripts/windows-acl.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Windows ACL privacy check for a configured host-local cache directory
// (kurone-kito/idd-skill#3623). POSIX gets privacy from mode bits; Windows has
// none, so a configured directory must be shown by its ACL to grant access
// only to the current user, SYSTEM, and the built-in Administrators. The
// parser, the decision rule, and the real reader live here so the cache module
// only sees an injectable `WindowsAclReader`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One DACL entry: a principal SID and whether it is an allow ACE. */
export interface WindowsAclEntry {
  sid: string;
  allow: boolean;
}

/**
 * What a reader reports. `currentSid` is the SID of the user the process runs
 * as; the decision rule needs it, and the real reader already has to call
 * `whoami` to read the ACL, so it hands it back here. When it is absent the
 * current-user clause never matches (fail closed) while SYSTEM and
 * Administrators still count.
 */
export type WindowsAclResult =
  | { kind: 'entries'; entries: WindowsAclEntry[]; currentSid?: string }
  | { kind: 'unreadable' };

/** Reads a directory's ACL. May throw; a throw counts as unreadable. */
export type WindowsAclReader = (directory: string) => WindowsAclResult;

export type WindowsAclVerdict = 'private' | 'permissive' | 'unreadable';

const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';

/**
 * Well-known SDDL account aliases that can appear in a directory DACL,
 * expanded to their SIDs. An alias missing from this table stays as written,
 * which the rule then treats as an unknown (permissive) principal.
 */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  AN: 'S-1-5-7',
  AU: 'S-1-5-11',
  BA: SID_ADMINISTRATORS,
  BG: 'S-1-5-32-546',
  BU: 'S-1-5-32-545',
  CG: 'S-1-3-1',
  CO: 'S-1-3-0',
  ED: 'S-1-5-9',
  IU: 'S-1-5-4',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  NU: 'S-1-5-2',
  OW: 'S-1-3-4',
  PS: 'S-1-5-10',
  RC: 'S-1-5-12',
  SU: 'S-1-5-6',
  SY: SID_SYSTEM,
  WD: 'S-1-1-0',
};

function expandAlias(principal: string): string {
  const upper = principal.trim().toUpperCase();
  return SDDL_ALIASES[upper] ?? upper;
}

/**
 * Decode the file `icacls /save` writes. It is UTF-16LE, with or without a
 * byte-order mark depending on the Windows build; fall back to UTF-8 when the
 * bytes do not look like UTF-16 (no NUL in the second byte of the first pair).
 */
export function decodeIcaclsSave(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[1] === 0x00 && buffer[0] !== 0x00) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/** Split `(...)(...)` at the top level, honoring nested parentheses. */
function splitAces(dacl: string): string[] | null {
  const aces: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < dacl.length; index += 1) {
    const char = dacl[index];
    if (char === '(') {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) aces.push(dacl.slice(start, index));
    }
  }
  return depth === 0 ? aces : null;
}

/** Split an ACE body on `;` outside any nested parentheses. */
function splitAceFields(ace: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of ace) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ';' && depth === 0) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Cut the SDDL into its `O:`/`G:`/`D:`/`S:` sections at the top level. */
function sddlSections(sddl: string): Map<string, string> {
  const sections = new Map<string, string>();
  let depth = 0;
  let name: string | null = null;
  let begin = 0;
  for (let index = 0; index < sddl.length; index += 1) {
    const char = sddl[index] as string;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && 'OGDS'.includes(char) && sddl[index + 1] === ':') {
      if (name !== null) sections.set(name, sddl.slice(begin, index));
      name = char;
      begin = index + 2;
      index += 1;
    }
  }
  if (name !== null) sections.set(name, sddl.slice(begin));
  return sections;
}

/**
 * Parse the text `icacls <dir> /save <file> /q` writes: a line naming the
 * directory, then its SDDL. Only the DACL is read, so system-audit and
 * mandatory-label ACEs in an `S:` section are never mistaken for allows.
 * Anything unexpected -- a NULL or empty DACL, an ACE type that is neither
 * allow nor deny, a malformed ACE -- is `unreadable`, never `private`.
 */
export function parseIcaclsSave(text: string): WindowsAclResult {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const sddl = lines.find((line) => /^[OGDS]:/.test(line));
  if (sddl === undefined) return { kind: 'unreadable' };
  const dacl = sddlSections(sddl).get('D');
  if (dacl === undefined || dacl.startsWith('NO_ACCESS_CONTROL')) {
    return { kind: 'unreadable' };
  }
  const aces = splitAces(dacl);
  if (aces === null || aces.length === 0) return { kind: 'unreadable' };
  const entries: WindowsAclEntry[] = [];
  for (const ace of aces) {
    const fields = splitAceFields(ace);
    const type = (fields[0] ?? '').trim().toUpperCase();
    const principal = fields[5];
    if (principal === undefined || principal.trim() === '') {
      return { kind: 'unreadable' };
    }
    if (type === 'A' || type === 'OA' || type === 'XA') {
      entries.push({ sid: expandAlias(principal), allow: true });
    } else if (type === 'D' || type === 'OD' || type === 'XD') {
      entries.push({ sid: expandAlias(principal), allow: false });
    } else {
      return { kind: 'unreadable' };
    }
  }
  return { kind: 'entries', entries };
}

/**
 * The privacy rule: private only when every allow entry names the current
 * user, SYSTEM, or the built-in Administrators. Deny entries only restrict and
 * are ignored. Everyone, Users, Authenticated Users, and any unknown principal
 * make the directory permissive. A reader result that is not well formed, or
 * that carries no allow entry at all, is unreadable.
 */
export function evaluateWindowsAcl(result: unknown): WindowsAclVerdict {
  if (typeof result !== 'object' || result === null) return 'unreadable';
  const candidate = result as {
    kind?: unknown;
    entries?: unknown;
    currentSid?: unknown;
  };
  if (candidate.kind !== 'entries') return 'unreadable';
  if (!Array.isArray(candidate.entries)) return 'unreadable';
  const entries: WindowsAclEntry[] = [];
  for (const entry of candidate.entries as unknown[]) {
    const item = entry as { sid?: unknown; allow?: unknown } | null;
    if (
      typeof item?.sid !== 'string' ||
      item.sid.trim() === '' ||
      typeof item.allow !== 'boolean'
    ) {
      return 'unreadable';
    }
    entries.push({ sid: item.sid.trim().toUpperCase(), allow: item.allow });
  }
  const allows = entries.filter((entry) => entry.allow);
  if (allows.length === 0) return 'unreadable';
  const permitted = new Set([SID_SYSTEM, SID_ADMINISTRATORS]);
  if (typeof candidate.currentSid === 'string' && candidate.currentSid !== '') {
    permitted.add(candidate.currentSid.trim().toUpperCase());
  }
  return allows.every((entry) => permitted.has(entry.sid))
    ? 'private'
    : 'permissive';
}

/** How the real reader starts processes; injectable so tests stay hermetic. */
export interface WindowsAclProcessDeps {
  env?: NodeJS.ProcessEnv;
  execFile?: (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      timeout: number;
      windowsHide: boolean;
      maxBuffer: number;
      stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => string;
}

const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER = 1024 * 1024;

// One `whoami` per process: the SID cannot change while the process runs,
// while the ACL verdict must be read fresh (a caller may change it). Keyed by
// the process starter so an injected fake never leaks into another test.
const currentSidMemo = new WeakMap<object, string | null>();

function system32(env: NodeJS.ProcessEnv): string {
  // An absolute path: a bare name would be resolved against the current
  // directory before PATH on Windows, so a checkout could plant an `icacls`.
  return join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');
}

function currentUserSid(
  exec: NonNullable<WindowsAclProcessDeps['execFile']>,
  env: NodeJS.ProcessEnv,
): string | null {
  const known = currentSidMemo.get(exec);
  if (known !== undefined) return known;
  let sid: string | null = null;
  try {
    const out = exec(
      join(system32(env), 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      {
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: PROCESS_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // `"HOST\user","S-1-5-21-...-1001"`: the second CSV field.
    const match = /,"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(out);
    sid = match?.[1]?.toUpperCase() ?? null;
  } catch {
    sid = null;
  }
  if (sid !== null) currentSidMemo.set(exec, sid);
  return sid;
}

/**
 * The real reader: `whoami` for the current user's SID and `icacls /save` for
 * the directory's SDDL. Principals are identified by SID, never by localized
 * account name. Success is judged by the saved file's content, not by the exit
 * status or the summary line (`/q` prints "processed 0 files" with status 0).
 * Any failure, timeout, or unparseable output is `unreadable`.
 */
export function readWindowsAcl(
  directory: string,
  deps: WindowsAclProcessDeps = {},
): WindowsAclResult {
  const env = deps.env ?? process.env;
  const exec = (deps.execFile ?? execFileSync) as NonNullable<
    WindowsAclProcessDeps['execFile']
  >;
  let scratch: string | null = null;
  try {
    const sid = currentUserSid(exec, env);
    if (sid === null) return { kind: 'unreadable' };
    scratch = mkdtempSync(join(tmpdir(), 'idd-acl-'));
    const saved = join(scratch, 'acl.sddl');
    exec(join(system32(env), 'icacls.exe'), [directory, '/save', saved, '/q'], {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: PROCESS_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = parseIcaclsSave(decodeIcaclsSave(readFileSync(saved)));
    return parsed.kind === 'entries'
      ? { ...parsed, currentSid: sid }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}
