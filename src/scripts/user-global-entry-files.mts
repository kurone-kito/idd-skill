#!/usr/bin/env node
// idd-generated-from: src/scripts/user-global-entry-files.mts
//
// The scripts/user-global-entry-files.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// Entry-file edits for the user-global installer (#4244). Each harness loads
// the gated entry text through one file in its configuration directory:
// CLAUDE.md, AGENTS.md, or opencode.json. A Markdown file gets one managed
// block between two marker lines. opencode.json gets one string in
// `instructions`, found by a strict scanner that refuses any document it
// cannot read exactly: comments, trailing commas, a non-object root, or a key
// that appears twice after decoding, at any depth.
//
// Every write and removal goes through the containment primitives in
// `user-global-paths.mts` (#4242). Every record goes through the receipt
// (#4243). The caller passes in the harness directories it has resolved, so
// this module reads no environment variable.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FsOps } from './user-global-paths.mts';
import { checkContainment } from './user-global-paths.mts';
import type { ReceiptEntry } from './user-global-receipt.mts';

/** The harnesses that load the entry text, in the order install edits them. */
export const ENTRY_HARNESSES = ['claude', 'codex', 'opencode'] as const;

/** One harness, named by the entry file it loads. */
export type EntryHarness = (typeof ENTRY_HARNESSES)[number];

/** The entry file each harness reads, inside its own directory. */
export const ENTRY_FILE_NAME: Record<EntryHarness, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  opencode: 'opencode.json',
};

/** A harness directory and the containment base it is walked from. */
export interface EntryTarget {
  harness: EntryHarness;
  dir: string;
  walkBase: string;
}

/** The inputs the plan reads. `listed` holds the receipt before this run. */
export interface EntryPlanInput {
  fs: FsOps;
  targets: readonly EntryTarget[];
  entryPath: string;
  entryText: string;
  /**
   * Every entry text the receipt records, one per version directory. Only the
   * Codex whole-file check reads it, so the caller may pass none when Codex is
   * not selected. A Codex whole-file record is rewritten only when its bytes
   * equal the span rendered from one of them.
   */
  recordedEntryTexts: readonly string[];
  listed: ReadonlyMap<string, ReceiptEntry>;
}

/** One write the plan decided on, applied by the caller in order. */
export type EntryStep =
  | {
      kind: 'create';
      dir: string;
      path: string;
      text: string;
      entry: ReceiptEntry;
    }
  | {
      kind: 'rewrite';
      dir: string;
      path: string;
      priorSha256: string;
      text: string;
      entry: ReceiptEntry;
      prior: ReceiptEntry | null;
    };

/** The verdicts for every selected harness, with nothing written. */
export interface EntryPlan {
  dirs: { path: string; base: string }[];
  steps: EntryStep[];
  lines: string[];
  refusals: string[];
}

/** A receipt entry this module removes or edits in place. */
export type EntryRecord = Extract<
  ReceiptEntry,
  { kind: 'managed-block' | 'json-instruction' }
>;

/** What an uninstall does to an edited entry file. */
export type RemovalPlan =
  | { kind: 'absent' }
  | { kind: 'rewrite'; priorSha256: string; text: string; priorText: string };

const BEGIN = '<!-- idd-skill:user-global:begin -->';
const END = '<!-- idd-skill:user-global:end -->';
const LF = 0x0a;
const CR = 0x0d;
const MAX_DEPTH = 256;
/** The one-character escapes JSON allows after a backslash, besides u. */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const ATOM =
  /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;

/** The name a refusal gives a path kind, so a link reads as a symbolic link. */
function kindName(kind: string): string {
  return kind === 'symlink' ? 'a symbolic link' : `a ${kind}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireNoFollowFlags(fs: FsOps): {
  noFollow: number;
  nonBlock: number;
} {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (noFollow === undefined || nonBlock === undefined) {
    throw new Error(
      'this platform does not support the no-follow opens the installer needs; refusing',
    );
  }
  return { noFollow, nonBlock };
}

/** The bytes of a regular file with one hard link, opened without following. */
function readRegular(path: string, fs: FsOps): Buffer {
  const flags = requireNoFollowFlags(fs);
  const fd = fs.openSync(
    path,
    nodeFs.constants.O_RDONLY | flags.noFollow | flags.nonBlock,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${path} is not a regular file; refusing`);
    }
    if (stat.nlink > 1) {
      throw new Error(`${path} has more than one hard link; refusing`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of `bytes` when they are valid UTF-8 with no CR byte. */
function checkedText(bytes: Buffer, path: string): string {
  if (bytes.includes(CR)) {
    throw new Error(`${path} contains a CR byte; refusing to edit it`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${path} is not UTF-8 text; refusing to edit it`);
  }
  return text;
}

/** Refuse when a crashed run left `<file>.tmp-<digits>` beside `file`. */
function refuseStaleTemp(dir: string, file: string, fs: FsOps): void {
  const base = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.tmp-[0-9]+$`);
  const stale = fs.readdirSync(dir).find((name) => pattern.test(name));
  if (stale !== undefined) {
    throw new Error(
      `${join(dir, stale)} exists, so a crashed run left it behind; refusing to edit ${file}; remove it by hand before installing`,
    );
  }
}

/**
 * The managed block for a Markdown harness, from its begin line through the
 * LF that ends its end line. Claude's block is one `@` import of the entry
 * text. Codex's block is the entry text itself.
 */
export function managedSpan(
  harness: 'claude' | 'codex',
  entryPath: string,
  entryText: string,
): string {
  const body = harness === 'claude' ? `@${entryPath}\n` : entryText;
  if (!body.endsWith('\n')) {
    throw new Error('the entry text must end with LF');
  }
  return `${BEGIN}\n${body}${END}\n`;
}

/** The whole opencode.json that install creates when the file is absent. */
function opencodeFileText(entryPath: string): string {
  return `{\n  "instructions": ${JSON.stringify([entryPath])}\n}\n`;
}

/**
 * Whether a whole-file entry holds the content install writes for its harness.
 * Claude and OpenCode write content that depends only on the entry path, so
 * the check is exact. Codex writes the entry text, which changes between
 * versions, so the caller passes every entry text that install recorded, one
 * per version directory, and the check is exact against the span rendered from
 * any one of them. An empty list matches nothing. A receipt can list any file
 * by its hash, so uninstall checks this as well.
 */
export function isInstallerWholeFile(
  harness: EntryHarness,
  entryPath: string,
  bytes: Buffer,
  entryTexts: readonly string[],
): boolean {
  if (harness === 'opencode') {
    return bytes.equals(Buffer.from(opencodeFileText(entryPath), 'utf8'));
  }
  if (harness === 'claude') {
    const span = managedSpan('claude', entryPath, '');
    return bytes.equals(Buffer.from(span, 'utf8'));
  }
  return entryTexts.some((text) => {
    try {
      const span = managedSpan('codex', entryPath, text);
      return bytes.equals(Buffer.from(span, 'utf8'));
    } catch {
      // An entry text with no final LF is not one install could have written.
      return false;
    }
  });
}

/** A managed block's byte span, from the begin line through the end LF. */
interface Block {
  begin: number;
  end: number;
}

/**
 * Find the single managed block in a Markdown file. Markers match whole lines
 * only, and each must end with LF. A file with no marker has no block. A begin
 * without an end, two begins, an end before the begin, or an unterminated
 * marker line refuses.
 */
function findBlock(bytes: Buffer, path: string): Block | null {
  const begins: number[] = [];
  const ends: number[] = [];
  let start = 0;
  for (;;) {
    const lf = bytes.indexOf(LF, start);
    const stop = lf === -1 ? bytes.length : lf;
    const line = bytes.toString('latin1', start, stop);
    if (line === BEGIN || line === END) {
      if (lf === -1) {
        throw new Error(
          `${path} ends with an unterminated managed-block marker; refusing`,
        );
      }
      (line === BEGIN ? begins : ends).push(start);
    }
    if (lf === -1) break;
    start = lf + 1;
  }
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new Error(
      `${path} does not hold exactly one managed block (one begin line, then one end line); refusing`,
    );
  }
  return { begin: begins[0], end: ends[0] + Buffer.byteLength(END) + 1 };
}

/** A parsed JSON value with the byte span it occupies in the text. */
type Json =
  | { type: 'object'; start: number; end: number; members: JsonMember[] }
  | { type: 'array'; start: number; end: number; items: Json[] }
  | { type: 'string'; start: number; end: number; value: string }
  | { type: 'atom'; start: number; end: number };

interface JsonMember {
  key: string;
  keyStart: number;
  value: Json;
}

type JsonObject = Extract<Json, { type: 'object' }>;
type JsonArray = Extract<Json, { type: 'array' }>;

/**
 * A strict JSON reader. It accepts RFC 8259 text and refuses everything else,
 * including comments and trailing commas. A key that repeats after decoding
 * refuses at any depth, which `JSON.parse` would not do.
 */
class StrictJson {
  private pos = 0;
  private readonly text: string;
  private readonly path: string;

  constructor(text: string, path: string) {
    this.text = text;
    this.path = path;
  }

  parseObjectRoot(): JsonObject {
    this.skip();
    if (this.text[this.pos] !== '{') {
      throw this.fail('the root is not an object');
    }
    const root = this.value(0);
    this.skip();
    if (this.pos !== this.text.length) {
      throw this.fail('there is content after the root value');
    }
    if (root.type !== 'object') throw this.fail('the root is not an object');
    return root;
  }

  private fail(reason: string): Error {
    return new Error(
      `${this.path} is not a strict JSON object (${reason}); refusing to edit it`,
    );
  }

  private skip(): void {
    while (
      this.pos < this.text.length &&
      ' \t\n'.includes(this.text[this.pos])
    ) {
      this.pos++;
    }
  }

  private value(depth: number): Json {
    if (depth > MAX_DEPTH) throw this.fail('it is nested too deeply');
    const ch = this.text[this.pos];
    if (ch === '{') return this.object(depth);
    if (ch === '[') return this.array(depth);
    if (ch === '"') return this.string();
    ATOM.lastIndex = this.pos;
    const match = ATOM.exec(this.text);
    if (match === null) {
      throw this.fail(`an unexpected character at offset ${this.pos}`);
    }
    const start = this.pos;
    this.pos += match[0].length;
    return { type: 'atom', start, end: this.pos };
  }

  private object(depth: number): JsonObject {
    const start = this.pos;
    this.pos++;
    const members: JsonMember[] = [];
    const keys = new Set<string>();
    this.skip();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { type: 'object', start, end: this.pos, members };
    }
    for (;;) {
      this.skip();
      if (this.text[this.pos] !== '"') {
        throw this.fail(`a member at offset ${this.pos} has no key`);
      }
      const keyStart = this.pos;
      const key = this.string();
      if (keys.has(key.value)) {
        throw this.fail(`the key ${JSON.stringify(key.value)} appears twice`);
      }
      keys.add(key.value);
      this.skip();
      if (this.text[this.pos] !== ':') {
        throw this.fail(`the key at offset ${keyStart} has no colon`);
      }
      this.pos++;
      this.skip();
      members.push({ key: key.value, keyStart, value: this.value(depth + 1) });
      this.skip();
      const next = this.text[this.pos];
      this.pos++;
      if (next === '}') {
        return { type: 'object', start, end: this.pos, members };
      }
      if (next !== ',') {
        throw this.fail(`an unexpected character at offset ${this.pos - 1}`);
      }
    }
  }

  private array(depth: number): JsonArray {
    const start = this.pos;
    this.pos++;
    const items: Json[] = [];
    this.skip();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return { type: 'array', start, end: this.pos, items };
    }
    for (;;) {
      this.skip();
      items.push(this.value(depth + 1));
      this.skip();
      const next = this.text[this.pos];
      this.pos++;
      if (next === ']') return { type: 'array', start, end: this.pos, items };
      if (next !== ',') {
        throw this.fail(`an unexpected character at offset ${this.pos - 1}`);
      }
    }
  }

  private string(): Extract<Json, { type: 'string' }> {
    const start = this.pos;
    let index = this.pos + 1;
    for (;;) {
      if (index >= this.text.length)
        throw this.fail('a string is unterminated');
      const code = this.text.charCodeAt(index);
      if (code < 0x20) throw this.fail('a string holds a control character');
      if (code === 0x22) break;
      if (code === 0x5c) {
        const esc = this.text[index + 1];
        if (esc === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(index + 2, index + 6))) {
            throw this.fail('a string holds a malformed \\u escape');
          }
          index += 6;
          continue;
        }
        if (esc === undefined || !SIMPLE_ESCAPES.has(esc)) {
          throw this.fail('a string holds an invalid escape');
        }
        index += 2;
        continue;
      }
      index++;
    }
    this.pos = index + 1;
    const raw = this.text.slice(start, this.pos);
    return {
      type: 'string',
      start,
      end: this.pos,
      value: JSON.parse(raw) as string,
    };
  }
}

/** The parsed opencode.json and its `instructions` member, if present. */
interface OpenCodeDoc {
  text: string;
  root: JsonObject;
  instructions: JsonMember | undefined;
}

function parseOpenCode(bytes: Buffer, path: string): OpenCodeDoc {
  const text = checkedText(bytes, path);
  const root = new StrictJson(text, path).parseObjectRoot();
  const instructions = root.members.find(
    (member) => member.key === 'instructions',
  );
  return { text, root, instructions };
}

/** The `instructions` member as an array, or a refusal when it is not one. */
function instructionArray(doc: OpenCodeDoc, path: string): JsonArray | null {
  if (doc.instructions === undefined) return null;
  if (doc.instructions.value.type !== 'array') {
    throw new Error(
      `${path} has an instructions key that is neither absent nor an array; refusing to edit it`,
    );
  }
  return doc.instructions.value;
}

/** How many items of `array` decode to `value`. */
function matchCount(array: JsonArray, value: string): number {
  return array.items.filter(
    (item) => item.type === 'string' && item.value === value,
  ).length;
}

/** The index of the first item in `array` whose string equals `value`. */
function indexOfItem(array: JsonArray, value: string): number {
  return array.items.findIndex(
    (item) => item.type === 'string' && item.value === value,
  );
}

/** Insert `valueJson` as the last member of `root`, with no whitespace. */
function insertMember(
  text: string,
  root: JsonObject,
  key: string,
  valueJson: string,
): string {
  const at = root.end - 1;
  const comma = root.members.length > 0 ? ',' : '';
  return `${text.slice(0, at)}${comma}${JSON.stringify(key)}:${valueJson}${text.slice(at)}`;
}

/** Insert `valueJson` as the last item of `array`, with no whitespace. */
function insertItem(text: string, array: JsonArray, valueJson: string): string {
  const at = array.end - 1;
  const comma = array.items.length > 0 ? ',' : '';
  return `${text.slice(0, at)}${comma}${valueJson}${text.slice(at)}`;
}

/**
 * Remove one item. The item and the comma before it go, or the comma after it
 * when the item is first, so the rest of the text keeps its bytes.
 */
/** The byte span of one array item or object member. */
interface Span {
  start: number;
  end: number;
}

/**
 * Remove the span at `index` and one comma, and keep every other byte. The
 * comma removed is the one before the span, or the one after it when the span
 * is first. A lone span has no comma. Whitespace the user wrote around the
 * removed bytes stays where it was.
 */
function removeSpanAt(text: string, spans: Span[], index: number): string {
  const span = spans[index];
  const cuts: Span[] = [span];
  if (spans.length > 1) {
    const from = index > 0 ? spans[index - 1].end : span.end;
    const comma = text.indexOf(',', from);
    cuts.push({ start: comma, end: comma + 1 });
  }
  let out = text;
  // Apply the later cut first, so the earlier offsets stay valid.
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, cut.start) + out.slice(cut.end);
  }
  return out;
}

/** Remove one array item, with the comma rule of `removeSpanAt`. */
function removeItem(text: string, array: JsonArray, index: number): string {
  return removeSpanAt(text, array.items, index);
}

/** Remove one member, with the comma rule of `removeSpanAt`. */
function removeMember(text: string, root: JsonObject, index: number): string {
  const spans = root.members.map((member) => ({
    start: member.keyStart,
    end: member.value.end,
  }));
  return removeSpanAt(text, spans, index);
}

/**
 * The bytes a Markdown file becomes: the span replaces the block when one is
 * present, and otherwise follows the file, after one LF when the file is
 * non-empty and does not end with LF.
 */
function markdownNext(
  bytes: Buffer,
  block: Block | null,
  span: Buffer,
): { next: Buffer; separator: boolean } {
  if (block !== null) {
    return {
      next: Buffer.concat([
        bytes.subarray(0, block.begin),
        span,
        bytes.subarray(block.end),
      ]),
      separator: false,
    };
  }
  const separator = bytes.length > 0 && bytes[bytes.length - 1] !== LF;
  return {
    next: Buffer.concat([
      bytes,
      separator ? Buffer.from([LF]) : Buffer.alloc(0),
      span,
    ]),
    separator,
  };
}

function pushRewrite(
  input: EntryPlanInput,
  plan: EntryPlan,
  dir: string,
  file: string,
  priorSha256: string,
  text: string,
  entry: ReceiptEntry,
  prior: ReceiptEntry | null,
): void {
  refuseStaleTemp(dir, file, input.fs);
  plan.steps.push({
    kind: 'rewrite',
    dir,
    path: file,
    priorSha256,
    text,
    entry,
    prior,
  });
  plan.lines.push(`edit ${file}`);
}

/**
 * A file install created whole: the bytes must still match the receipt, and a
 * rewrite also needs them to be what install wrote for the harness in some
 * recorded version. A receipt can list any file by its hash, so the hash alone
 * would let a reinstall replace a file the user wrote. Bytes that already equal
 * the new content need no such check, because they are install's own output.
 */
function planWholeFile(
  input: EntryPlanInput,
  plan: EntryPlan,
  harness: EntryHarness,
  dir: string,
  file: string,
  bytes: Buffer,
  expected: string,
  prior: ReceiptEntry,
): void {
  if (prior.kind !== 'file' || sha256Of(bytes) !== prior.sha256) {
    throw new Error(
      `${file} was edited after install (its SHA-256 differs from the receipt); refusing, and it is user-edited`,
    );
  }
  const next = Buffer.from(expected, 'utf8');
  if (bytes.equals(next)) {
    plan.lines.push(`keep ${file}`);
    return;
  }
  if (
    !isInstallerWholeFile(
      harness,
      input.entryPath,
      bytes,
      input.recordedEntryTexts,
    )
  ) {
    throw new Error(
      `${file} holds content install does not write, although the receipt lists it as one install created; refusing to rewrite it, and it is user-edited`,
    );
  }
  pushRewrite(
    input,
    plan,
    dir,
    file,
    prior.sha256,
    expected,
    { kind: 'file', path: file, sha256: sha256Of(next) },
    prior,
  );
}

function planMarkdown(
  input: EntryPlanInput,
  plan: EntryPlan,
  harness: 'claude' | 'codex',
  dir: string,
  file: string,
  bytes: Buffer,
  listed: ReceiptEntry | null,
): void {
  const expected = managedSpan(harness, input.entryPath, input.entryText);
  const span = Buffer.from(expected, 'utf8');
  if (listed !== null && listed.kind === 'file') {
    planWholeFile(input, plan, harness, dir, file, bytes, expected, listed);
    return;
  }
  if (listed !== null && listed.kind !== 'managed-block') {
    throw new Error(
      `${file} is listed as a ${listed.kind}, not a file or managed block; refusing to edit it`,
    );
  }
  const block = findBlock(bytes, file);
  if (listed !== null && listed.kind === 'managed-block') {
    if (block === null) {
      throw new Error(
        `${file} no longer holds the managed block that install recorded; refusing; the operator restores it or removes the record, then reruns`,
      );
    }
    const current = bytes.subarray(block.begin, block.end);
    if (sha256Of(current) !== listed.sha256) {
      throw new Error(
        `${file} managed block was edited after install (its span SHA-256 differs); refusing, and it is user-edited`,
      );
    }
    if (current.equals(span)) {
      plan.lines.push(`keep ${file}`);
      return;
    }
    const { next } = markdownNext(bytes, block, span);
    pushRewrite(
      input,
      plan,
      dir,
      file,
      sha256Of(bytes),
      next.toString('utf8'),
      {
        kind: 'managed-block',
        path: file,
        sha256: sha256Of(span),
        separator: listed.separator,
      },
      listed,
    );
    return;
  }
  if (block !== null) {
    if (bytes.subarray(block.begin, block.end).equals(span)) {
      plan.lines.push(
        `keep ${file} (the managed block is current; not recorded)`,
      );
      return;
    }
    throw new Error(
      `${file} holds a managed block that install did not record and that differs from the entry text; refusing; remove the stale block and rerun install`,
    );
  }
  const { next, separator } = markdownNext(bytes, null, span);
  pushRewrite(
    input,
    plan,
    dir,
    file,
    sha256Of(bytes),
    next.toString('utf8'),
    {
      kind: 'managed-block',
      path: file,
      sha256: sha256Of(span),
      separator,
    },
    null,
  );
}

function planOpenCode(
  input: EntryPlanInput,
  plan: EntryPlan,
  dir: string,
  file: string,
  bytes: Buffer,
  listed: ReceiptEntry | null,
): void {
  const value = input.entryPath;
  const expected = opencodeFileText(value);
  if (listed !== null && listed.kind === 'file') {
    planWholeFile(input, plan, 'opencode', dir, file, bytes, expected, listed);
    return;
  }
  if (listed !== null && listed.kind !== 'json-instruction') {
    throw new Error(
      `${file} is listed as a ${listed.kind}, not a file or JSON instruction; refusing to edit it`,
    );
  }
  const doc = parseOpenCode(bytes, file);
  const array = instructionArray(doc, file);
  if (listed !== null && listed.kind === 'json-instruction') {
    if (listed.value !== value) {
      throw new Error(
        `${file} lists ${listed.value}, but this install's entry text is ${value}; refusing; run uninstall first`,
      );
    }
    if (array === null || matchCount(array, value) !== 1) {
      throw new Error(
        `${file} does not hold the recorded instruction exactly once; refusing; the operator restores it or removes the record, then reruns`,
      );
    }
    plan.lines.push(`keep ${file}`);
    return;
  }
  if (array === null) {
    pushRewrite(
      input,
      plan,
      dir,
      file,
      sha256Of(bytes),
      insertMember(doc.text, doc.root, 'instructions', JSON.stringify([value])),
      { kind: 'json-instruction', path: file, value, keyCreated: true },
      null,
    );
    return;
  }
  const count = matchCount(array, value);
  if (count > 1) {
    throw new Error(
      `${file} lists the entry text more than once; refusing to edit it`,
    );
  }
  if (count === 1) {
    plan.lines.push(`keep ${file} (the instruction is current; not recorded)`);
    return;
  }
  pushRewrite(
    input,
    plan,
    dir,
    file,
    sha256Of(bytes),
    insertItem(doc.text, array, JSON.stringify(value)),
    { kind: 'json-instruction', path: file, value, keyCreated: false },
    null,
  );
}

/** Plan one harness: its directory, then its entry file. Reads only. */
function planOne(
  input: EntryPlanInput,
  target: EntryTarget,
  plan: EntryPlan,
): void {
  const { fs } = input;
  const file = join(target.dir, ENTRY_FILE_NAME[target.harness]);
  const dirWalk = checkContainment(target.walkBase, target.dir, fs);
  if (dirWalk.finalKind === 'symlink' || dirWalk.finalKind === 'file') {
    throw new Error(
      `${target.dir} is ${kindName(dirWalk.finalKind)}, not a directory; refusing to write ${file}`,
    );
  }
  if (dirWalk.finalKind === 'absent') {
    // walkTo lists only the missing intermediates, so an empty list means the
    // harness directory is the one missing leaf and its parent exists.
    if (dirWalk.missingDirs.length > 0) {
      throw new Error(
        `${target.dir} does not exist, and its parent chain is incomplete; the installer creates a harness directory only as a leaf whose parent exists; nothing was written`,
      );
    }
    plan.dirs.push({ path: target.dir, base: target.walkBase });
  }
  const fileWalk = checkContainment(target.dir, file, fs);
  if (fileWalk.finalKind === 'symlink' || fileWalk.finalKind === 'directory') {
    throw new Error(
      `${file} is ${kindName(fileWalk.finalKind)}; refusing to edit it`,
    );
  }
  const listed = input.listed.get(file) ?? null;
  if (fileWalk.finalKind === 'absent') {
    if (listed !== null) {
      throw new Error(
        `${file} is listed by the receipt but absent; the operator decides, because the user removed it; nothing was written`,
      );
    }
    const text =
      target.harness === 'opencode'
        ? opencodeFileText(input.entryPath)
        : managedSpan(target.harness, input.entryPath, input.entryText);
    plan.steps.push({
      kind: 'create',
      dir: target.dir,
      path: file,
      text,
      entry: { kind: 'file', path: file, sha256: sha256Of(text) },
    });
    plan.lines.push(`create ${file}`);
    return;
  }
  const bytes = readRegular(file, fs);
  checkedText(bytes, file);
  if (target.harness === 'opencode') {
    planOpenCode(input, plan, target.dir, file, bytes, listed);
  } else {
    planMarkdown(input, plan, target.harness, target.dir, file, bytes, listed);
  }
}

/**
 * Plan every selected harness. Reads only. A refusal is collected rather than
 * thrown, so the caller can name every refused file in one message and write
 * nothing.
 */
export function planEntryFiles(input: EntryPlanInput): EntryPlan {
  const plan: EntryPlan = { dirs: [], steps: [], lines: [], refusals: [] };
  for (const target of input.targets) {
    try {
      planOne(input, target, plan);
    } catch (error) {
      plan.refusals.push(describe(error));
    }
  }
  return plan;
}

/**
 * The removal an uninstall makes to an edited entry file, computed before any
 * removal. A managed block that is absent reads as `absent`, and a block whose
 * span differs refuses. A JSON instruction must match exactly once, and its
 * key goes too when install created it and the array is then empty.
 *
 * The LF that install wrote before a block (the separator) stays in place. A
 * line the user inserted above the block ends in that LF, so removing it would
 * change the user's text. When the file had no trailing LF before install, the
 * result therefore keeps one extra LF.
 */
export function planEntryRemoval(fs: FsOps, entry: EntryRecord): RemovalPlan {
  const bytes = readRegular(entry.path, fs);
  if (entry.kind === 'managed-block') {
    checkedText(bytes, entry.path);
    const block = findBlock(bytes, entry.path);
    if (block === null) return { kind: 'absent' };
    if (sha256Of(bytes.subarray(block.begin, block.end)) !== entry.sha256) {
      throw new Error(
        `${entry.path} managed block was edited after install (its span SHA-256 differs); refusing, and it is user-edited`,
      );
    }
    refuseStaleTemp(dirname(entry.path), entry.path, fs);
    const kept = Buffer.concat([
      bytes.subarray(0, block.begin),
      bytes.subarray(block.end),
    ]);
    return {
      kind: 'rewrite',
      priorSha256: sha256Of(bytes),
      text: kept.toString('utf8'),
      priorText: bytes.toString('utf8'),
    };
  }
  const doc = parseOpenCode(bytes, entry.path);
  const array = instructionArray(doc, entry.path);
  if (array === null || matchCount(array, entry.value) !== 1) {
    throw new Error(
      `${entry.path} does not hold the recorded instruction exactly once; refusing, and it is user-edited`,
    );
  }
  let text = removeItem(doc.text, array, indexOfItem(array, entry.value));
  if (entry.keyCreated) {
    const after = parseOpenCode(Buffer.from(text, 'utf8'), entry.path);
    const left = instructionArray(after, entry.path);
    if (left !== null && left.items.length === 0) {
      const index = after.root.members.findIndex(
        (member) => member.key === 'instructions',
      );
      text = removeMember(after.text, after.root, index);
    }
  }
  refuseStaleTemp(dirname(entry.path), entry.path, fs);
  return {
    kind: 'rewrite',
    priorSha256: sha256Of(bytes),
    text,
    priorText: bytes.toString('utf8'),
  };
}
