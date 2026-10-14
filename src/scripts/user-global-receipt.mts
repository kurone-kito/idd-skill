// idd-generated-from: src/scripts/user-global-receipt.mts
//
// The scripts/user-global-receipt.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// Receipt for the user-global installer (#4243). The receipt lists what
// install created, with a content hash for each file, so uninstall removes
// only what still matches. Reads are no-follow. Writes go through a
// temporary file that is renamed over the receipt, so a failed write leaves
// the last valid receipt in place.

import * as nodeFs from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import {
  checkContainment,
  type FsOps,
  writeNewFile,
} from './user-global-paths.mts';

/** The receipt file name inside the data root. */
const RECEIPT_FILENAME = 'receipt.json';

/** The receipt format version. A later format bumps this integer. */
const RECEIPT_FORMAT_VERSION = 1;

/**
 * One listed path. A file carries the SHA-256 of the bytes install wrote. A
 * managed block carries the SHA-256 of its span only, and `separator` records
 * whether install wrote one LF before the span. A JSON instruction carries the
 * string it added to `instructions`, and `keyCreated` records whether install
 * also added the `instructions` key.
 */
export type ReceiptEntry =
  | { kind: 'file'; path: string; sha256: string }
  | { kind: 'directory'; path: string }
  | { kind: 'link'; path: string; target: string }
  | {
      kind: 'managed-block';
      path: string;
      sha256: string;
      separator: boolean;
    }
  | {
      kind: 'json-instruction';
      path: string;
      value: string;
      keyCreated: boolean;
    };

/** The parsed receipt: the format version and the listed entries. */
export interface Receipt {
  version: number;
  entries: ReceiptEntry[];
}

/** The outcome of reading the receipt: missing, or valid. Corrupt throws. */
export type ReceiptRead =
  | { state: 'missing' }
  | { state: 'valid'; receipt: Receipt };

const DEFAULT_FS: FsOps = nodeFs;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The version directory name a link entry may target. This duplicates the
 * pattern in `user-global-paths.mts` (#4242), which keeps it private.
 */
const VERSION_NAME_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

/** The receipt path inside a data root. */
function receiptPathFor(dataRoot: string): string {
  return join(dataRoot, RECEIPT_FILENAME);
}

/**
 * Names in the data root that are `receipt.json.tmp-<digits>`. The helper
 * is duplicated from `user-global-paths.mts` (which keeps it private) so the
 * containment module's export surface does not widen for one caller.
 */
function staleReceiptTemps(dataRoot: string, fs: FsOps): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dataRoot);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const pattern = /^receipt\.json\.tmp-[0-9]+$/;
  return names
    .filter((name) => pattern.test(name))
    .map((name) => join(dataRoot, name));
}

/** Names of temporary receipt files a crashed run left in the data root. */
export function findStaleReceiptTemps(
  dataRoot: string,
  fs: FsOps = DEFAULT_FS,
): string[] {
  return staleReceiptTemps(dataRoot, fs);
}

function readNoFollowText(path: string, fs: FsOps): string {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (noFollow === undefined || nonBlock === undefined) {
    throw new Error(
      'this platform does not support the no-follow opens the receipt needs; refusing',
    );
  }
  const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | noFollow | nonBlock);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function corrupt(path: string, reason: string): never {
  throw new Error(
    `the receipt at ${path} is corrupt (${reason}); refusing to change anything`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(
  value: unknown,
  path: string,
  dataRoot: string,
): ReceiptEntry {
  if (!isObject(value) || typeof value.path !== 'string') {
    corrupt(path, 'an entry has no string path');
  }
  const entryPath = value.path;
  if (!entryPath.startsWith('/')) {
    corrupt(path, `entry path ${entryPath} is not absolute`);
  }
  if (value.kind === 'file') {
    if (
      typeof value.sha256 !== 'string' ||
      !SHA256_PATTERN.test(value.sha256)
    ) {
      corrupt(path, `file entry ${entryPath} has no valid sha256`);
    }
    return { kind: 'file', path: entryPath, sha256: value.sha256 };
  }
  if (value.kind === 'directory') {
    return { kind: 'directory', path: entryPath };
  }
  if (value.kind === 'managed-block') {
    if (
      typeof value.sha256 !== 'string' ||
      !SHA256_PATTERN.test(value.sha256)
    ) {
      corrupt(path, `managed-block entry ${entryPath} has no valid sha256`);
    }
    if (typeof value.separator !== 'boolean') {
      corrupt(
        path,
        `managed-block entry ${entryPath} has no boolean separator`,
      );
    }
    return {
      kind: 'managed-block',
      path: entryPath,
      sha256: value.sha256,
      separator: value.separator,
    };
  }
  if (value.kind === 'json-instruction') {
    // The installer only ever records the entry text path under a data root.
    // Any other string could name a user's own instruction, so it is corrupt.
    if (
      typeof value.value !== 'string' ||
      !isAbsolute(value.value) ||
      !value.value.endsWith(
        `${sep}${join('current', 'user-global', 'entry.md')}`,
      )
    ) {
      corrupt(
        path,
        `json-instruction entry ${entryPath} does not name the installer's entry text`,
      );
    }
    if (typeof value.keyCreated !== 'boolean') {
      corrupt(
        path,
        `json-instruction entry ${entryPath} has no boolean keyCreated`,
      );
    }
    return {
      kind: 'json-instruction',
      path: entryPath,
      value: value.value,
      keyCreated: value.keyCreated,
    };
  }
  if (value.kind === 'link') {
    if (typeof value.target !== 'string' || !value.target.startsWith('/')) {
      corrupt(path, `link entry ${entryPath} has no absolute target`);
    }
    // The installer only ever records its own `current` link, which targets a
    // version directory directly under the data root. Any other link entry
    // could name a user's symbolic link, so it makes the receipt corrupt.
    const target = value.target;
    if (
      entryPath !== join(dataRoot, 'current') ||
      dirname(target) !== dataRoot ||
      !VERSION_NAME_PATTERN.test(basename(target))
    ) {
      corrupt(
        path,
        `link entry ${entryPath} is not the installer's current link to a version directory under ${dataRoot}`,
      );
    }
    return { kind: 'link', path: entryPath, target };
  }
  corrupt(path, `entry ${entryPath} has an unknown kind`);
}

function parseReceipt(text: string, path: string, dataRoot: string): Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    corrupt(path, `it does not parse: ${describe(error)}`);
  }
  if (!isObject(parsed) || parsed.version !== RECEIPT_FORMAT_VERSION) {
    corrupt(path, `it is not format version ${RECEIPT_FORMAT_VERSION}`);
  }
  if (!Array.isArray(parsed.entries)) {
    corrupt(path, 'it has no entries array');
  }
  const entries = parsed.entries.map((value) =>
    parseEntry(value, path, dataRoot),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      corrupt(path, `entry ${entry.path} is listed twice`);
    }
    seen.add(entry.path);
  }
  return { version: RECEIPT_FORMAT_VERSION, entries };
}

/**
 * Read the receipt under `dataRoot` without following links. A missing data
 * root or receipt reads as `missing`. A receipt that does not parse, has an
 * unknown kind, or is not a regular file throws.
 */
export function readReceipt(
  dataRoot: string,
  fs: FsOps = DEFAULT_FS,
): ReceiptRead {
  const path = receiptPathFor(dataRoot);
  const walk = checkContainment(dataRoot, path, fs);
  if (walk.finalKind === 'absent') return { state: 'missing' };
  if (walk.finalKind !== 'file') {
    corrupt(path, `it is a ${walk.finalKind}, not a regular file`);
  }
  return {
    state: 'valid',
    receipt: parseReceipt(readNoFollowText(path, fs), path, dataRoot),
  };
}

/**
 * Replace the receipt with `receipt`. The new content is written to an
 * exclusive `receipt.json.tmp-<pid>` and renamed over the receipt. A failed
 * rename removes the temporary file, so the last valid receipt stays.
 */
export function writeReceipt(
  dataRoot: string,
  entries: ReceiptEntry[],
  fs: FsOps = DEFAULT_FS,
): void {
  const path = receiptPathFor(dataRoot);
  const temp = join(dataRoot, `${RECEIPT_FILENAME}.tmp-${process.pid}`);
  const receipt: Receipt = { version: RECEIPT_FORMAT_VERSION, entries };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  writeNewFile(dataRoot, temp, body, fs);
  try {
    // Re-walk the destination with no-follow stats right before the rename:
    // it must be absent or a regular file, never a link that appeared since.
    const destination = checkContainment(dataRoot, path, fs);
    if (
      destination.finalKind !== 'absent' &&
      destination.finalKind !== 'file'
    ) {
      throw new Error(
        `${path} is a ${destination.finalKind}; refusing to replace it`,
      );
    }
    fs.renameSync(temp, path);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch (unlinkError) {
      throw new Error(
        `could not rename ${temp} over ${path} (${describe(error)}); could not remove the temporary file (${describe(unlinkError)}); leftover path: ${temp}`,
      );
    }
    throw new Error(
      `could not rename ${temp} over ${path} (${describe(error)})`,
    );
  }
}
