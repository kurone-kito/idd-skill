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
import { join } from 'node:path';
import { checkContainment, writeNewFile } from './user-global-paths.mjs';

/** The receipt file name inside the data root. */
const RECEIPT_FILENAME = 'receipt.json';
/** The receipt format version. A later format bumps this integer. */
const RECEIPT_FORMAT_VERSION = 1;
const DEFAULT_FS = nodeFs;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
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
function receiptPathFor(dataRoot) {
  return join(dataRoot, RECEIPT_FILENAME);
}
/**
 * Names in the data root that are `receipt.json.tmp-<digits>`. The helper
 * is duplicated from `user-global-paths.mts` (which keeps it private) so the
 * containment module's export surface does not widen for one caller.
 */
function staleReceiptTemps(dataRoot, fs) {
  let names;
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
export function findStaleReceiptTemps(dataRoot, fs = DEFAULT_FS) {
  return staleReceiptTemps(dataRoot, fs);
}
function readNoFollowText(path, fs) {
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
function corrupt(path, reason) {
  throw new Error(
    `the receipt at ${path} is corrupt (${reason}); refusing to change anything`,
  );
}
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseEntry(value, path) {
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
  if (value.kind === 'link') {
    if (typeof value.target !== 'string' || !value.target.startsWith('/')) {
      corrupt(path, `link entry ${entryPath} has no absolute target`);
    }
    return { kind: 'link', path: entryPath, target: value.target };
  }
  corrupt(path, `entry ${entryPath} has an unknown kind`);
}
function parseReceipt(text, path) {
  let parsed;
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
  const entries = parsed.entries.map((value) => parseEntry(value, path));
  const seen = new Set();
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
export function readReceipt(dataRoot, fs = DEFAULT_FS) {
  const path = receiptPathFor(dataRoot);
  const walk = checkContainment(dataRoot, path, fs);
  if (walk.finalKind === 'absent') return { state: 'missing' };
  if (walk.finalKind !== 'file') {
    corrupt(path, `it is a ${walk.finalKind}, not a regular file`);
  }
  return {
    state: 'valid',
    receipt: parseReceipt(readNoFollowText(path, fs), path),
  };
}
/**
 * Replace the receipt with `receipt`. The new content is written to an
 * exclusive `receipt.json.tmp-<pid>` and renamed over the receipt. A failed
 * rename removes the temporary file, so the last valid receipt stays.
 */
export function writeReceipt(dataRoot, entries, fs = DEFAULT_FS) {
  const path = receiptPathFor(dataRoot);
  const temp = join(dataRoot, `${RECEIPT_FILENAME}.tmp-${process.pid}`);
  const receipt = { version: RECEIPT_FORMAT_VERSION, entries };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  writeNewFile(dataRoot, temp, body, fs);
  try {
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
