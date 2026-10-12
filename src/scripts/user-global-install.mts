// idd-generated-from: src/scripts/user-global-install.mts
//
// The scripts/user-global-install.mjs copy is generated from this .mts source
// by `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
//
// User-global install of the IDD payload, skills, and harness wiring (#3825).
//
// The `idd-onboard --install-user-global` mode calls into this module. A plan
// is computed once and shared by --dry-run and the apply path, so a dry run
// cannot drift from what an apply would do. Nothing outside the managed block
// (Markdown) or the one inserted array element (opencode.json) is rewritten.
// Uninstall deletes only what the receipt names, and only while it is still
// the content install wrote.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildHelperRuntimeManifest } from './helper-runtime-manifest.mts';
import { resolveInstalledPayloadRoot } from './idd-activation.mts';
import { isQualifiedConfigRoot } from './idd-config.mts';

export const HARNESS_NAMES = ['claude', 'codex', 'opencode'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export const BEGIN_MARKER =
  '<!-- idd-skill:user-global begin (managed by idd-onboard --install-user-global; do not edit) -->';
export const END_MARKER = '<!-- idd-skill:user-global end -->';

const PAYLOAD_MARKER_NAME = '.idd-user-global-payload';
const SKILL_MARKER_NAME = '.idd-user-global';
const RECEIPT_NAME = 'user-global-receipt.json';
const ENTRY_SOURCE = 'idd-template/user-global/entry.md';
const INSTRUCTIONS_SOURCE_DIR = 'idd-template/.github/instructions';
const DOCS_PREFIX = 'idd-template/docs/';
const SKILL_BLOCKS = [
  'issue-authoring-companion-files',
  'idd-spec-audit-companion-files',
] as const;

export interface UserGlobalOptions {
  /** Bundle root holding idd-template/, skills/, audit/, and package.json. */
  bundleRoot: string;
  /** Environment for root resolution. Passed explicitly, never read here. */
  env: NodeJS.ProcessEnv;
  /** Home directory for the default roots. Passed explicitly. */
  homedir: string;
  harnesses: readonly HarnessName[];
  dryRun: boolean;
}

export interface UserGlobalChange {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'remove' | 'delete';
}

export interface UserGlobalResult {
  mode: 'install' | 'uninstall';
  dryRun: boolean;
  version: string;
  payloadRoot: string;
  harnesses: HarnessName[];
  changes: UserGlobalChange[];
  changed: number;
  /** Install commands for the operator to run. Printed only, never run. */
  hints: string[];
}

/** One filesystem operation. Apply runs them in order. */
type Op =
  | { kind: 'mkdir'; path: string }
  | { kind: 'write'; path: string; content: Buffer; mode?: number }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'symlink'; target: string; path: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'rmdir'; path: string }
  | { kind: 'removeTree'; path: string };

interface HarnessReceipt {
  /** The file install wired. Uninstall uses this path, not the current env. */
  file: string;
  /** Install created the whole file, so uninstall may delete it when empty. */
  fileCreated: boolean;
  /** Install inserted the opencode.json entry, so uninstall removes it. */
  entryAdded: boolean;
  /** Install created the opencode.json `instructions` key itself. */
  keyCreated: boolean;
}

interface SkillFileReceipt {
  path: string;
  sha256: string;
}

interface Receipt {
  schema: 1;
  version: string;
  payloadRoot: string;
  /** Version directory names this receipt owns, under the data root. */
  payloadVersions: string[];
  /** Skill directories this receipt owns (each holds the skill marker). */
  skillDirs: string[];
  /** Skill files this receipt wrote, with the digest it wrote. */
  skillFiles: SkillFileReceipt[];
  /** Directories install created, so uninstall can remove the empty ones. */
  dirsCreated: string[];
  harnesses: Partial<Record<HarnessName, HarnessReceipt>>;
}

interface Locations {
  payloadRoot: string;
  dataRoot: string;
  claudeRoot: string;
  codexRoot: string;
  opencodeFile: string;
  agentsSkillsRoot: string;
  claudeSkillsRoot: string;
  receiptPath: string;
}

interface SkillFile {
  skill: string;
  relative: string;
  source: string;
}

interface Plan {
  ops: Op[];
  changes: UserGlobalChange[];
}

function resolveLocations(options: UserGlobalOptions): Locations {
  const { env, homedir } = options;
  const payloadRoot = resolveInstalledPayloadRoot({ env, homedir });
  if (payloadRoot === undefined) {
    throw new Error(
      'user-global install: payload root is unresolved; set XDG_DATA_HOME or HOME to an absolute path',
    );
  }
  const qualified = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 && isQualifiedConfigRoot(trimmed)
      ? trimmed
      : null;
  };
  const claudeRoot =
    qualified(env.CLAUDE_CONFIG_DIR) ?? join(homedir, '.claude');
  const codexRoot = qualified(env.CODEX_HOME) ?? join(homedir, '.codex');
  const configRoot = qualified(env.XDG_CONFIG_HOME) ?? join(homedir, '.config');
  const dataRoot = dirname(payloadRoot);
  return {
    payloadRoot,
    dataRoot,
    claudeRoot,
    codexRoot,
    opencodeFile: join(configRoot, 'opencode', 'opencode.json'),
    agentsSkillsRoot: join(homedir, '.agents', 'skills'),
    claudeSkillsRoot: join(claudeRoot, 'skills'),
    receiptPath: join(dataRoot, RECEIPT_NAME),
  };
}

function readBytesIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readUtf8IfExists(path: string): string | null {
  return readBytesIfExists(path)?.toString('utf8') ?? null;
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Relative paths of every file under `dir`, sorted. */
function walkFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (lstatSync(abs).isDirectory()) {
      found.push(...walkFiles(abs, rel));
    } else {
      found.push(rel);
    }
  }
  return found;
}

interface SyncManifestBlock {
  id?: string;
  paths?: string[];
}

function readManifestBlock(bundleRoot: string, id: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(bundleRoot, 'audit', 'sync-manifest.json'), 'utf8'),
  ) as { generatedBlocks?: SyncManifestBlock[] };
  const block = (manifest.generatedBlocks ?? []).find(
    (entry) => entry.id === id,
  );
  if (!block || !Array.isArray(block.paths)) {
    throw new Error(
      `user-global install: sync-manifest.json has no "${id}" block with paths`,
    );
  }
  return block.paths;
}

function readVersion(bundleRoot: string): string {
  const pkg = JSON.parse(
    readFileSync(join(bundleRoot, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  const version: unknown = pkg.version;
  if (
    typeof version !== 'string' ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version) ||
    version.includes('..')
  ) {
    throw new Error(
      `user-global install: invalid package version ${JSON.stringify(version)}; expected one path segment of letters, digits, ".", "_", "+", or "-"`,
    );
  }
  return version;
}

/** Relative payload path mapped to its absolute source file. */
function payloadSources(bundleRoot: string): Map<string, string> {
  const sources = new Map<string, string>();
  const instructionsDir = join(bundleRoot, INSTRUCTIONS_SOURCE_DIR);
  for (const rel of walkFiles(instructionsDir)) {
    sources.set(
      `.github/instructions/${rel}`,
      join(instructionsDir, ...rel.split('/')),
    );
  }
  for (const manifestPath of readManifestBlock(
    bundleRoot,
    'idd-template-core-files',
  )) {
    if (!manifestPath.startsWith(DOCS_PREFIX)) continue;
    sources.set(
      manifestPath.slice('idd-template/'.length),
      join(bundleRoot, manifestPath),
    );
  }
  sources.set('user-global/entry.md', join(bundleRoot, ENTRY_SOURCE));
  return sources;
}

function skillFiles(bundleRoot: string): SkillFile[] {
  const files: SkillFile[] = [];
  for (const id of SKILL_BLOCKS) {
    for (const manifestPath of readManifestBlock(bundleRoot, id)) {
      const parts = manifestPath.split('/');
      if (parts[0] !== 'skills' || parts.length < 3) {
        throw new Error(
          `user-global install: skill path "${manifestPath}" is not under skills/<name>/`,
        );
      }
      files.push({
        skill: parts[1] as string,
        relative: parts.slice(2).join('/'),
        source: join(bundleRoot, manifestPath),
      });
    }
  }
  return files;
}

function expectedPayloadTree(
  bundleRoot: string,
  version: string,
): Map<string, Buffer> {
  const tree = new Map<string, Buffer>();
  for (const [rel, source] of payloadSources(bundleRoot)) {
    tree.set(rel, readFileSync(source));
  }
  tree.set(
    PAYLOAD_MARKER_NAME,
    Buffer.from(`${JSON.stringify({ source: 'idd-skill', version })}\n`),
  );
  return tree;
}

function treeOf(dir: string): Map<string, Buffer> {
  const tree = new Map<string, Buffer>();
  for (const rel of walkFiles(dir)) {
    tree.set(rel, readFileSync(join(dir, ...rel.split('/'))));
  }
  return tree;
}

function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, bytes] of a) {
    const other = b.get(rel);
    if (other === undefined || !other.equals(bytes)) return false;
  }
  return true;
}

/** Directories to create for `dirs`, parents first, skipping existing ones. */
function missingAncestors(dirs: readonly string[]): string[] {
  const missing: string[] = [];
  for (const dir of dirs) {
    const chain: string[] = [];
    let current = resolve(dir);
    while (lstatIfExists(current) === null) {
      chain.unshift(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const entry of chain) {
      if (!missing.includes(entry)) missing.push(entry);
    }
  }
  return missing;
}

function ensureDirs(
  plan: Plan,
  dirs: readonly string[],
  created: string[],
): void {
  for (const dir of missingAncestors(dirs)) {
    created.push(dir);
    plan.ops.push({ kind: 'mkdir', path: dir });
  }
}

function pushChange(
  plan: Plan,
  path: string,
  action: UserGlobalChange['action'],
): void {
  plan.changes.push({ path, action });
}

// ---------------------------------------------------------------------------
// Managed Markdown block (Claude CLAUDE.md, Codex AGENTS.md).
// ---------------------------------------------------------------------------

function lineEndingOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

interface Region {
  /** Index of the BEGIN line's first character. */
  begin: number;
  /** Index just past the END line, including its line ending. */
  end: number;
}

/**
 * Find the single managed region. Throws unless the file holds none, or
 * exactly one BEGIN line followed by one END line. Any other shape is refused
 * rather than guessed at, so a half-edited block is never overwritten.
 */
function findRegion(text: string, path: string): Region | null {
  const begins: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (;;) {
    const newline = text.indexOf('\n', pos);
    const lineEnd = newline === -1 ? text.length : newline;
    let line = text.slice(pos, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const next = newline === -1 ? text.length : newline + 1;
    if (line === BEGIN_MARKER) begins.push(pos);
    if (line === END_MARKER) ends.push(next);
    if (newline === -1) break;
    pos = next;
  }
  if (begins.length === 0 && ends.length === 0) return null;
  const begin = begins[0];
  const end = ends[0];
  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    begin === undefined ||
    end === undefined ||
    end <= begin
  ) {
    throw new Error(
      `user-global install: ${path} has a malformed managed block (expected one BEGIN and one END marker, in order); refusing to edit it`,
    );
  }
  return { begin, end };
}

function buildBlock(bodyLines: readonly string[], eol: string): string {
  return [BEGIN_MARKER, ...bodyLines, END_MARKER]
    .map((line) => `${line}${eol}`)
    .join('');
}

/** Install or refresh the managed block; returns the full new file text. */
function wireMarkdown(
  text: string | null,
  bodyLines: readonly string[],
  path: string,
): string {
  if (text === null || text.length === 0) {
    return buildBlock(bodyLines, '\n');
  }
  const eol = lineEndingOf(text);
  const block = buildBlock(bodyLines, eol);
  const region = findRegion(text, path);
  if (region === null) {
    return `${text}${eol}${block}`;
  }
  return `${text.slice(0, region.begin)}${block}${text.slice(region.end)}`;
}

/** Remove the managed block and the separator that install added before it. */
function unwireMarkdown(text: string, path: string): string | null {
  const region = findRegion(text, path);
  if (region === null) return null;
  let start = region.begin;
  if (region.begin > 0) {
    start -= text.slice(0, region.begin).endsWith('\r\n') ? 2 : 1;
  }
  return text.slice(0, start) + text.slice(region.end);
}

// ---------------------------------------------------------------------------
// opencode.json: a byte-preserving splice. The scanner only locates offsets,
// so every byte outside the inserted or removed element stays as it was.
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

interface ObjectMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && ' \t\r\n'.includes(text.charAt(i))) i += 1;
  return i;
}

function stringEnd(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i += 1;
  }
  throw new Error('user-global install: unterminated JSON string');
}

function valueEnd(text: string, index: number): number {
  const first = text.charAt(index);
  if (first === '"') return stringEnd(text, index);
  if (first === '{' || first === '[') {
    let depth = 0;
    let i = index;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error('user-global install: unterminated JSON value');
  }
  let i = index;
  while (i < text.length && !',]} \t\r\n'.includes(text.charAt(i))) i += 1;
  return i;
}

function parseTopObject(text: string): {
  open: number;
  members: ObjectMember[];
} {
  let i = skipWhitespace(text, 0);
  if (text.charAt(i) !== '{') {
    throw new Error('user-global install: opencode.json root is not an object');
  }
  const open = i;
  const members: ObjectMember[] = [];
  i = skipWhitespace(text, i + 1);
  if (text.charAt(i) === '}') return { open, members };
  for (;;) {
    i = skipWhitespace(text, i);
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipWhitespace(text, keyEnd);
    if (text.charAt(i) !== ':') {
      throw new Error('user-global install: opencode.json is not valid JSON');
    }
    const valueStart = skipWhitespace(text, i + 1);
    const end = valueEnd(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd: end });
    i = skipWhitespace(text, end);
    if (text.charAt(i) === ',') {
      i += 1;
      continue;
    }
    if (text.charAt(i) === '}') return { open, members };
    throw new Error('user-global install: opencode.json is not valid JSON');
  }
}

function parseArrayAt(
  text: string,
  index: number,
): { open: number; elements: Span[] } {
  const elements: Span[] = [];
  let i = skipWhitespace(text, index + 1);
  if (text.charAt(i) === ']') return { open: index, elements };
  for (;;) {
    i = skipWhitespace(text, i);
    const end = valueEnd(text, i);
    elements.push({ start: i, end });
    i = skipWhitespace(text, end);
    if (text.charAt(i) === ',') {
      i += 1;
      continue;
    }
    if (text.charAt(i) === ']') return { open: index, elements };
    throw new Error('user-global install: opencode.json is not valid JSON');
  }
}

/** Validate the document and return its `instructions` value, if present. */
function instructionsOf(text: string, path: string): unknown[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `user-global install: ${path} is not valid JSON (JSONC is not supported); refusing to edit it`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `user-global install: ${path} root is not an object; refusing to edit it`,
    );
  }
  const value = (parsed as Record<string, unknown>).instructions;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `user-global install: ${path} has a non-array "instructions" value; refusing to edit it`,
    );
  }
  return value;
}

/** Insert the entry. Returns the new text and what install created. */
function spliceOpencodeIn(
  text: string,
  entry: string,
  path: string,
): { text: string; entryAdded: boolean; keyCreated: boolean } {
  const existing = instructionsOf(text, path);
  if (existing?.includes(entry)) {
    return { text, entryAdded: false, keyCreated: false };
  }
  const literal = JSON.stringify(entry);
  const object = parseTopObject(text);
  const member = object.members.find((m) => m.key === 'instructions');
  if (member !== undefined) {
    const array = parseArrayAt(text, member.valueStart);
    if (array.elements.length === 0) {
      return {
        text: `${text.slice(0, array.open + 1)}${literal}${text.slice(array.open + 1)}`,
        entryAdded: true,
        keyCreated: false,
      };
    }
    const last = (array.elements.at(-1) as Span).end;
    return {
      text: `${text.slice(0, last)}, ${literal}${text.slice(last)}`,
      entryAdded: true,
      keyCreated: false,
    };
  }
  const addition = `"instructions": [${literal}]`;
  if (object.members.length === 0) {
    return {
      text: `${text.slice(0, object.open + 1)}${addition}${text.slice(object.open + 1)}`,
      entryAdded: true,
      keyCreated: true,
    };
  }
  const lastValue = (object.members.at(-1) as ObjectMember).valueEnd;
  return {
    text: `${text.slice(0, lastValue)}, ${addition}${text.slice(lastValue)}`,
    entryAdded: true,
    keyCreated: true,
  };
}

/** Remove the entry install added. Returns null when it is not present. */
function spliceOpencodeOut(
  text: string,
  entry: string,
  keyCreated: boolean,
  path: string,
): string | null {
  const existing = instructionsOf(text, path);
  if (!existing?.includes(entry)) return null;
  const object = parseTopObject(text);
  const memberIndex = object.members.findIndex((m) => m.key === 'instructions');
  const member = object.members[memberIndex] as ObjectMember;
  const array = parseArrayAt(text, member.valueStart);
  const index = array.elements.findIndex(
    (span) => JSON.parse(text.slice(span.start, span.end)) === entry,
  );
  if (index === -1) return null;
  const element = array.elements[index] as Span;
  if (keyCreated && array.elements.length === 1) {
    // Install created the whole key; remove the member, not a leftover array.
    if (object.members.length === 1) {
      return text.slice(0, member.keyStart) + text.slice(member.valueEnd);
    }
    if (memberIndex > 0) {
      const previous = object.members[memberIndex - 1] as ObjectMember;
      return text.slice(0, previous.valueEnd) + text.slice(member.valueEnd);
    }
    const next = object.members[memberIndex + 1] as ObjectMember;
    return text.slice(0, member.keyStart) + text.slice(next.keyStart);
  }
  if (index > 0) {
    const previous = array.elements[index - 1] as Span;
    return text.slice(0, previous.end) + text.slice(element.end);
  }
  const next = array.elements[1];
  if (next !== undefined) {
    return text.slice(0, element.start) + text.slice(next.start);
  }
  return text.slice(0, element.start) + text.slice(element.end);
}

// ---------------------------------------------------------------------------
// Receipt: the only record of what install created.
// ---------------------------------------------------------------------------

function isSafeVersionName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

/**
 * Read the receipt and normalize it. Missing arrays become empty, and any
 * entry that could name a path outside what install owns is dropped.
 */
function readReceipt(path: string): Receipt | null {
  if (lstatIfExists(path)?.isSymbolicLink()) {
    throw new Error(
      `user-global install: the receipt at ${path} is a symlink; refusing to read or write through it`,
    );
  }
  const text = readUtf8IfExists(path);
  if (text === null) return null;
  const parsed = JSON.parse(text) as Partial<Receipt>;
  if (parsed.schema !== 1) {
    throw new Error(`user-global install: unknown receipt schema in ${path}`);
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  return {
    schema: 1,
    version: typeof parsed.version === 'string' ? parsed.version : '',
    payloadRoot:
      typeof parsed.payloadRoot === 'string' ? parsed.payloadRoot : '',
    payloadVersions: strings(parsed.payloadVersions).filter(isSafeVersionName),
    skillDirs: strings(parsed.skillDirs).filter((dir) => isAbsolute(dir)),
    skillFiles: (Array.isArray(parsed.skillFiles)
      ? parsed.skillFiles
      : []
    ).filter(
      (entry): entry is SkillFileReceipt =>
        typeof entry?.path === 'string' &&
        isAbsolute(entry.path) &&
        typeof entry.sha256 === 'string',
    ),
    dirsCreated: strings(parsed.dirsCreated).filter((dir) => isAbsolute(dir)),
    harnesses: validHarnessRecords(parsed.harnesses),
  };
}

/** Keep only harness records whose file is the entry file that harness reads. */
function validHarnessRecords(value: unknown): Receipt['harnesses'] {
  const result: Receipt['harnesses'] = {};
  if (value === null || typeof value !== 'object') return result;
  for (const name of HARNESS_NAMES) {
    const record = (value as Record<string, unknown>)[name] as
      | Partial<HarnessReceipt>
      | undefined;
    if (record === undefined || record === null || typeof record !== 'object')
      continue;
    if (typeof record.file !== 'string' || !isAbsolute(record.file)) continue;
    result[name] = {
      file: record.file,
      fileCreated: record.fileCreated === true,
      entryAdded: record.entryAdded === true,
      keyCreated: record.keyCreated === true,
    };
  }
  return result;
}

function receiptBytes(receipt: Receipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Payload, current link, and skills.
// ---------------------------------------------------------------------------

/**
 * Refuse any symlink between `root`'s children and `target`, and a symlink at
 * `target` itself. The root is the skill directory the marker proves we own,
 * so a symlinked skills root stays the user's choice, and the rule covers
 * everything below it.
 */
function assertNoLinkBelow(root: string, target: string): void {
  const segments = relative(root, target).split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatIfExists(current);
    if (stat === null) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `user-global install: ${current} is a symlink inside a skill directory; refusing to write through it`,
      );
    }
    if (current !== target && !stat.isDirectory()) {
      throw new Error(
        `user-global install: ${current} is not a directory; refusing to write skills through it`,
      );
    }
  }
}

function planPayload(
  plan: Plan,
  locations: Locations,
  bundleRoot: string,
  version: string,
  createdDirs: string[],
): void {
  const versionDir = join(locations.dataRoot, version);
  const expected = expectedPayloadTree(bundleRoot, version);
  const existing = lstatIfExists(versionDir);
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(
        `user-global install: ${versionDir} is not a directory; refusing to replace it`,
      );
    }
    if (lstatIfExists(join(versionDir, PAYLOAD_MARKER_NAME)) === null) {
      throw new Error(
        `user-global install: ${versionDir} exists without the ${PAYLOAD_MARKER_NAME} marker; refusing to replace user content`,
      );
    }
    const current = treeOf(versionDir);
    const extra = [...current.keys()].filter((rel) => !expected.has(rel));
    if (extra.length > 0) {
      throw new Error(
        `user-global install: ${versionDir} holds files install did not write (${extra.join(', ')}); refusing to replace them`,
      );
    }
    if (sameTree(expected, current)) {
      pushChange(plan, versionDir, 'unchanged');
      return;
    }
  }
  pushChange(plan, versionDir, existing === null ? 'create' : 'update');
  ensureDirs(plan, [locations.dataRoot], createdDirs);
  const staging = join(
    locations.dataRoot,
    `.staging-${version}-${process.pid}-${Date.now()}`,
  );
  if (lstatIfExists(staging) !== null) {
    throw new Error(
      `user-global install: ${staging} already exists; refusing to stage over it`,
    );
  }
  for (const [rel, bytes] of expected) {
    plan.ops.push({
      kind: 'write',
      path: join(staging, ...rel.split('/')),
      content: bytes,
    });
  }
  if (existing !== null) {
    // The old tree is moved aside under a unique name and only then removed.
    const replaced = `${versionDir}.replaced-${process.pid}-${Date.now()}`;
    plan.ops.push({ kind: 'rename', from: versionDir, to: replaced });
    plan.ops.push({ kind: 'rename', from: staging, to: versionDir });
    plan.ops.push({ kind: 'removeTree', path: replaced });
    return;
  }
  plan.ops.push({ kind: 'rename', from: staging, to: versionDir });
}

function planCurrentLink(
  plan: Plan,
  locations: Locations,
  version: string,
): void {
  const current = locations.payloadRoot;
  const versionDir = join(locations.dataRoot, version);
  const linkTarget = process.platform === 'win32' ? versionDir : version;
  const stat = lstatIfExists(current);
  if (stat === null) {
    pushChange(plan, current, 'create');
    plan.ops.push({ kind: 'symlink', target: linkTarget, path: current });
    return;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `user-global install: ${current} is not a symlink; refusing to replace it`,
    );
  }
  const target = resolve(dirname(current), readlinkSync(current));
  if (target === resolve(versionDir)) {
    pushChange(plan, current, 'unchanged');
    return;
  }
  const ownedVersion =
    dirname(target) === resolve(locations.dataRoot) &&
    lstatIfExists(join(target, PAYLOAD_MARKER_NAME)) !== null;
  if (!ownedVersion) {
    throw new Error(
      `user-global install: ${current} points at ${target}, which is not an IDD payload version; refusing to replace it`,
    );
  }
  pushChange(plan, current, 'update');
  const tmp = `${current}.tmp-${process.pid}`;
  plan.ops.push({ kind: 'symlink', target: linkTarget, path: tmp });
  plan.ops.push({ kind: 'rename', from: tmp, to: current });
}

interface SkillReceipt {
  dirs: string[];
  files: SkillFileReceipt[];
}

/**
 * Plan the skill copies. A file that differs from the bundle is overwritten
 * only when its current digest is one install wrote before; a user edit is
 * refused, so re-install never silently discards it.
 */
function planSkills(
  plan: Plan,
  skillsRoot: string,
  files: readonly SkillFile[],
  createdDirs: string[],
  priorFiles: ReadonlyMap<string, SkillFileReceipt>,
): SkillReceipt {
  const receipt: SkillReceipt = { dirs: [], files: [] };
  const skills = [...new Set(files.map((file) => file.skill))].sort();
  for (const skill of skills) {
    const dir = join(skillsRoot, skill);
    const stat = lstatIfExists(dir);
    if (stat !== null) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `user-global install: ${dir} is not a plain directory; refusing to write skills into it`,
        );
      }
      const marker = lstatIfExists(join(dir, SKILL_MARKER_NAME));
      if (marker === null || marker.isSymbolicLink()) {
        throw new Error(
          `user-global install: ${dir} exists without the ${SKILL_MARKER_NAME} marker; refusing to overwrite user content`,
        );
      }
    }
    ensureDirs(plan, [dir], createdDirs);
    let action: UserGlobalChange['action'] =
      stat === null ? 'create' : 'unchanged';
    for (const file of files.filter((f) => f.skill === skill)) {
      const target = join(dir, ...file.relative.split('/'));
      assertNoLinkBelow(dir, target);
      const bytes = readFileSync(file.source);
      receipt.files.push({ path: target, sha256: sha256(bytes) });
      const current = readBytesIfExists(target);
      if (current?.equals(bytes)) continue;
      if (current !== null) {
        const prior = priorFiles.get(target);
        if (prior === undefined || prior.sha256 !== sha256(current)) {
          throw new Error(
            `user-global install: ${target} was edited after install; refusing to overwrite it`,
          );
        }
      }
      ensureDirs(plan, [dirname(target)], createdDirs);
      plan.ops.push({ kind: 'write', path: target, content: bytes });
      if (action === 'unchanged') action = 'update';
    }
    const marker = Buffer.from(
      `${JSON.stringify({ source: 'idd-skill', skill })}\n`,
    );
    const markerPath = join(dir, SKILL_MARKER_NAME);
    const currentMarker = readBytesIfExists(markerPath);
    if (currentMarker === null || !currentMarker.equals(marker)) {
      plan.ops.push({ kind: 'write', path: markerPath, content: marker });
      if (action === 'unchanged') action = 'update';
    }
    pushChange(plan, dir, action);
    receipt.dirs.push(dir);
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// Harness wiring.
// ---------------------------------------------------------------------------

interface WireResult {
  text: string;
  entryAdded: boolean;
  keyCreated: boolean;
}

function planHarnessFile(
  plan: Plan,
  prior: HarnessReceipt | undefined,
  path: string,
  wire: (text: string | null) => WireResult,
  createdDirs: string[],
): HarnessReceipt {
  if (prior !== undefined && prior.file !== path) {
    throw new Error(
      `user-global install: this harness is wired at ${prior.file}; uninstall that wiring before installing to ${path}`,
    );
  }
  const text = readUtf8IfExists(path);
  const next = wire(text);
  if (text !== null && next.text === text) {
    pushChange(plan, path, 'unchanged');
  } else {
    if (text === null) ensureDirs(plan, [dirname(path)], createdDirs);
    pushChange(plan, path, text === null ? 'create' : 'update');
    plan.ops.push({
      kind: 'write',
      path,
      content: Buffer.from(next.text),
      mode: text === null ? undefined : statSync(path).mode & 0o777,
    });
  }
  return {
    file: path,
    fileCreated: (prior?.fileCreated ?? false) || text === null,
    entryAdded: (prior?.entryAdded ?? false) || next.entryAdded,
    keyCreated: (prior?.keyCreated ?? false) || next.keyCreated,
  };
}

/**
 * Every recorded harness file must be the file the current environment reaches
 * for that harness. Any other record is refused before a write, so a stale or
 * tampered receipt cannot direct an edit to another file.
 */
function assertRecordsReachable(
  receipt: Receipt | null,
  locations: Locations,
  mode: 'install' | 'uninstall',
): void {
  if (receipt === null) return;
  for (const name of HARNESS_NAMES) {
    const record = receipt.harnesses[name];
    if (record === undefined) continue;
    const expected = harnessFile(locations, name);
    if (record.file === expected) continue;
    const next =
      mode === 'install'
        ? `uninstall that wiring before installing to ${expected}`
        : 'run uninstall with the environment that installed it';
    throw new Error(
      `user-global install: the receipt records ${record.file} for ${name}, which the current environment does not reach (expected ${expected}); ${next}; refusing to act on it`,
    );
  }
}

/** A managed block that no receipt records belongs to someone else. */
function refuseUnownedBlock(path: string): void {
  const text = readUtf8IfExists(path);
  if (text !== null && findRegion(text, path) !== null) {
    throw new Error(
      `user-global install: ${path} holds a managed block that no receipt records; refusing to claim it`,
    );
  }
}

function markdownBody(
  harness: HarnessName,
  entryPath: string,
  entryText: string,
): string[] {
  if (harness === 'claude') return [`@${entryPath}`];
  return entryText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/**
 * The install commands for the operator. The package is private, so the
 * helper manifest's own default source is used rather than a registry spec.
 */
function installHints(bundleRoot: string): string[] {
  const hints: string[] = [];
  for (const packageManager of ['npm', 'pnpm', 'yarn']) {
    const manifest = buildHelperRuntimeManifest({
      profile: 'user-global',
      packageManager,
      targetRoot: bundleRoot,
    });
    const command = manifest.profiles['user-global']?.installCommand ?? '';
    if (command.length > 0 && !hints.includes(command)) hints.push(command);
  }
  return hints;
}

function harnessFile(locations: Locations, harness: HarnessName): string {
  if (harness === 'opencode') return locations.opencodeFile;
  return harness === 'claude'
    ? join(locations.claudeRoot, 'CLAUDE.md')
    : join(locations.codexRoot, 'AGENTS.md');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function runUserGlobalInstall(
  options: UserGlobalOptions,
): UserGlobalResult {
  const locations = resolveLocations(options);
  const version = readVersion(options.bundleRoot);
  const receipt = readReceipt(locations.receiptPath);
  assertRecordsReachable(receipt, locations, 'install');
  const plan: Plan = { ops: [], changes: [] };
  const createdDirs: string[] = [];
  const harnessReceipts: Partial<Record<HarnessName, HarnessReceipt>> = {};
  const entryPath = join(locations.payloadRoot, 'user-global', 'entry.md');
  const entryText = readFileSync(
    join(options.bundleRoot, ENTRY_SOURCE),
    'utf8',
  );

  planPayload(plan, locations, options.bundleRoot, version, createdDirs);
  planCurrentLink(plan, locations, version);

  const priorFiles = new Map<string, SkillFileReceipt>(
    (receipt?.skillFiles ?? []).map((entry) => [entry.path, entry] as const),
  );
  const files = skillFiles(options.bundleRoot);
  const skillReceipts: SkillReceipt[] = [];
  if (options.harnesses.includes('claude')) {
    skillReceipts.push(
      planSkills(
        plan,
        locations.claudeSkillsRoot,
        files,
        createdDirs,
        priorFiles,
      ),
    );
  }
  if (
    options.harnesses.includes('codex') ||
    options.harnesses.includes('opencode')
  ) {
    skillReceipts.push(
      planSkills(
        plan,
        locations.agentsSkillsRoot,
        files,
        createdDirs,
        priorFiles,
      ),
    );
  }

  for (const harness of options.harnesses) {
    const path = harnessFile(locations, harness);
    const prior = receipt?.harnesses[harness];
    if (harness === 'opencode') {
      harnessReceipts.opencode = planHarnessFile(
        plan,
        prior,
        path,
        (text) => spliceOpencodeIn(text ?? '{}\n', entryPath, path),
        createdDirs,
      );
      continue;
    }
    if (prior === undefined) refuseUnownedBlock(path);
    const body = markdownBody(harness, entryPath, entryText);
    harnessReceipts[harness] = planHarnessFile(
      plan,
      prior,
      path,
      (text) => ({
        text: wireMarkdown(text, body, path),
        entryAdded: true,
        keyCreated: false,
      }),
      createdDirs,
    );
  }

  const skillFileMap = new Map<string, SkillFileReceipt>();
  for (const entry of [
    ...(receipt?.skillFiles ?? []),
    ...skillReceipts.flatMap((s) => s.files),
  ]) {
    skillFileMap.set(entry.path, entry);
  }
  const nextReceipt: Receipt = {
    schema: 1,
    version,
    payloadRoot: locations.payloadRoot,
    payloadVersions: uniqueSorted([
      ...(receipt?.payloadVersions ?? []),
      version,
    ]),
    skillDirs: uniqueSorted([
      ...(receipt?.skillDirs ?? []),
      ...skillReceipts.flatMap((s) => s.dirs),
    ]),
    skillFiles: [...skillFileMap.values()],
    dirsCreated: uniqueSorted([
      ...(receipt?.dirsCreated ?? []),
      ...createdDirs,
    ]),
    harnesses: { ...(receipt?.harnesses ?? {}), ...harnessReceipts },
  };
  const receiptContent = receiptBytes(nextReceipt);
  const priorReceipt = readBytesIfExists(locations.receiptPath);
  if (priorReceipt === null || !priorReceipt.equals(receiptContent)) {
    pushChange(
      plan,
      locations.receiptPath,
      priorReceipt === null ? 'create' : 'update',
    );
    plan.ops.push({
      kind: 'write',
      path: locations.receiptPath,
      content: receiptContent,
    });
  }

  return finish(
    options,
    'install',
    version,
    locations,
    plan,
    installHints(options.bundleRoot),
  );
}

export function runUserGlobalUninstall(
  options: UserGlobalOptions,
): UserGlobalResult {
  const locations = resolveLocations(options);
  const version = readVersion(options.bundleRoot);
  const receipt = readReceipt(locations.receiptPath);
  assertRecordsReachable(receipt, locations, 'uninstall');
  const plan: Plan = { ops: [], changes: [] };
  const remaining: Partial<Record<HarnessName, HarnessReceipt>> = {
    ...(receipt?.harnesses ?? {}),
  };

  for (const harness of options.harnesses) {
    const prior = receipt?.harnesses[harness];
    delete remaining[harness];
    // Without a receipt entry, install did not wire this harness, so uninstall
    // leaves its file alone. The recorded path is used, never the current env.
    if (prior === undefined) {
      pushChange(plan, harnessFile(locations, harness), 'unchanged');
      continue;
    }
    const path = prior.file;
    const text = readUtf8IfExists(path);
    if (text === null) {
      pushChange(plan, path, 'unchanged');
      continue;
    }
    const entryPath = join(locations.payloadRoot, 'user-global', 'entry.md');
    if (harness === 'opencode') {
      const next = prior.entryAdded
        ? spliceOpencodeOut(text, entryPath, prior.keyCreated, path)
        : null;
      if (next === null) {
        pushChange(plan, path, 'unchanged');
      } else if (prior.fileCreated && isEmptyObjectJson(next)) {
        plan.ops.push({ kind: 'unlink', path });
        pushChange(plan, path, 'delete');
      } else {
        plan.ops.push({ kind: 'write', path, content: Buffer.from(next) });
        pushChange(plan, path, 'remove');
      }
      continue;
    }
    const next = unwireMarkdown(text, path);
    if (next === null) {
      pushChange(plan, path, 'unchanged');
    } else if (prior.fileCreated && next.length === 0) {
      plan.ops.push({ kind: 'unlink', path });
      pushChange(plan, path, 'delete');
    } else {
      plan.ops.push({ kind: 'write', path, content: Buffer.from(next) });
      pushChange(plan, path, 'remove');
    }
  }

  // Payload and skills are shared by every harness, so they go only when all
  // three are named and a receipt says what install owns.
  if (receipt !== null && Object.keys(remaining).length === 0) {
    removeOwned(plan, locations, receipt);
  }

  if (receipt !== null) {
    if (Object.keys(remaining).length === 0) {
      plan.ops.push({ kind: 'unlink', path: locations.receiptPath });
      pushChange(plan, locations.receiptPath, 'delete');
      for (const dir of [...receipt.dirsCreated].sort().reverse()) {
        plan.ops.push({ kind: 'rmdir', path: dir });
      }
    } else {
      plan.ops.push({
        kind: 'write',
        path: locations.receiptPath,
        content: receiptBytes({ ...receipt, harnesses: remaining }),
      });
      pushChange(plan, locations.receiptPath, 'update');
    }
  }

  return finish(options, 'uninstall', version, locations, plan, []);
}

function isEmptyObjectJson(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    return false;
  }
}

/** Whether `path` is a plain regular file with exactly `digest`. */
function isUnchangedFile(path: string, digest: string): boolean {
  const stat = lstatIfExists(path);
  if (stat === null || !stat.isFile()) return false;
  const bytes = readBytesIfExists(path);
  return bytes !== null && sha256(bytes) === digest;
}

/**
 * Remove only what the receipt owns: skill files still byte-identical to what
 * install wrote, their marked directories once nothing else is left in them,
 * the owned payload versions, and the current link when it names one of them.
 */
function removeOwned(plan: Plan, locations: Locations, receipt: Receipt): void {
  const removed = new Set<string>();
  for (const dir of receipt.skillDirs) {
    const stat = lstatIfExists(dir);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const marker = lstatIfExists(join(dir, SKILL_MARKER_NAME));
    if (marker === null || marker.isSymbolicLink()) continue;
    for (const file of receipt.skillFiles) {
      if (!file.path.startsWith(`${dir}${sep}`)) continue;
      if (!isUnchangedFile(file.path, file.sha256)) continue;
      removed.add(file.path);
      plan.ops.push({ kind: 'unlink', path: file.path });
      pushChange(plan, file.path, 'remove');
    }
    const survivors = walkFiles(dir)
      .map((rel) => join(dir, ...rel.split('/')))
      .filter(
        (path) => path !== join(dir, SKILL_MARKER_NAME) && !removed.has(path),
      );
    if (survivors.length > 0) {
      pushChange(plan, dir, 'unchanged');
      continue;
    }
    plan.ops.push({ kind: 'unlink', path: join(dir, SKILL_MARKER_NAME) });
    // Directories install created below this skill directory go first, deepest
    // first, so the skill directory itself can be removed last.
    const below = receipt.dirsCreated
      .filter((sub) => sub.startsWith(`${dir}${sep}`))
      .sort((a, b) => b.length - a.length);
    for (const sub of below) plan.ops.push({ kind: 'rmdir', path: sub });
    plan.ops.push({ kind: 'rmdir', path: dir });
    pushChange(plan, dir, 'delete');
  }

  const owned = new Set(
    receipt.payloadVersions.map((name) => join(locations.dataRoot, name)),
  );
  const current = locations.payloadRoot;
  const currentStat = lstatIfExists(current);
  if (currentStat?.isSymbolicLink()) {
    const target = resolve(dirname(current), readlinkSync(current));
    if (owned.has(target)) {
      plan.ops.push({ kind: 'unlink', path: current });
      pushChange(plan, current, 'delete');
    }
  }
  for (const dir of owned) {
    const stat = lstatIfExists(dir);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (lstatIfExists(join(dir, PAYLOAD_MARKER_NAME)) === null) continue;
    plan.ops.push({ kind: 'removeTree', path: dir });
    pushChange(plan, dir, 'delete');
  }
}

/** Flush the plan: dry run reports it, apply runs it. */
function finish(
  options: UserGlobalOptions,
  mode: UserGlobalResult['mode'],
  version: string,
  locations: Locations,
  plan: Plan,
  hints: string[],
): UserGlobalResult {
  const changed = plan.changes.filter((c) => c.action !== 'unchanged').length;
  if (!options.dryRun) applyOps(plan.ops);
  return {
    mode,
    dryRun: options.dryRun,
    version,
    payloadRoot: locations.payloadRoot,
    harnesses: [...options.harnesses],
    changes: plan.changes,
    changed,
    hints,
  };
}

/**
 * Write through the real path so a dotfile symlink stays a link, via a temp
 * file in the same directory and a rename. The original mode is restored.
 */
function writeAtomically(path: string, content: Buffer, mode?: number): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.idd-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: mode ?? 0o644 });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, real);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function applyOps(ops: readonly Op[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'mkdir':
        mkdirSync(op.path, { recursive: true });
        break;
      case 'write':
        writeAtomically(op.path, op.content, op.mode);
        break;
      case 'rename':
        renameSync(op.from, op.to);
        break;
      case 'symlink':
        symlinkSync(
          op.target,
          op.path,
          process.platform === 'win32' ? 'junction' : undefined,
        );
        break;
      case 'unlink':
        unlinkIfPresent(op.path);
        break;
      case 'rmdir':
        try {
          rmdirSync(op.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
        }
        break;
      case 'removeTree':
        rmSync(op.path, { recursive: true, force: true });
        break;
    }
  }
}
