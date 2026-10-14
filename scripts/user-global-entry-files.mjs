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
import { checkContainment } from './user-global-paths.mjs';
/** The harnesses that load the entry text, in the order install edits them. */
export const ENTRY_HARNESSES = ['claude', 'codex', 'opencode'];
/** The entry file each harness reads, inside its own directory. */
export const ENTRY_FILE_NAME = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  opencode: 'opencode.json',
};
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
function kindName(kind) {
  return kind === 'symlink' ? 'a symbolic link' : `a ${kind}`;
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function requireNoFollowFlags(fs) {
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
function readRegular(path, fs) {
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
function checkedText(bytes, path) {
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
function refuseStaleTemp(dir, file, fs) {
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
export function managedSpan(harness, entryPath, entryText) {
  const body = harness === 'claude' ? `@${entryPath}\n` : entryText;
  if (!body.endsWith('\n')) {
    throw new Error('the entry text must end with LF');
  }
  return `${BEGIN}\n${body}${END}\n`;
}
/** The whole opencode.json that install creates when the file is absent. */
function opencodeFileText(entryPath) {
  return `{\n  "instructions": ${JSON.stringify([entryPath])}\n}\n`;
}
/**
 * Find the single managed block in a Markdown file. Markers match whole lines
 * only, and each must end with LF. A file with no marker has no block. A begin
 * without an end, two begins, an end before the begin, or an unterminated
 * marker line refuses.
 */
function findBlock(bytes, path) {
  const begins = [];
  const ends = [];
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
/**
 * A strict JSON reader. It accepts RFC 8259 text and refuses everything else,
 * including comments and trailing commas. A key that repeats after decoding
 * refuses at any depth, which `JSON.parse` would not do.
 */
class StrictJson {
  pos = 0;
  text;
  path;
  constructor(text, path) {
    this.text = text;
    this.path = path;
  }
  parseObjectRoot() {
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
  fail(reason) {
    return new Error(
      `${this.path} is not a strict JSON object (${reason}); refusing to edit it`,
    );
  }
  skip() {
    while (
      this.pos < this.text.length &&
      ' \t\n'.includes(this.text[this.pos])
    ) {
      this.pos++;
    }
  }
  value(depth) {
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
  object(depth) {
    const start = this.pos;
    this.pos++;
    const members = [];
    const keys = new Set();
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
  array(depth) {
    const start = this.pos;
    this.pos++;
    const items = [];
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
  string() {
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
      value: JSON.parse(raw),
    };
  }
}
function parseOpenCode(bytes, path) {
  const text = checkedText(bytes, path);
  const root = new StrictJson(text, path).parseObjectRoot();
  const instructions = root.members.find(
    (member) => member.key === 'instructions',
  );
  return { text, root, instructions };
}
/** The `instructions` member as an array, or a refusal when it is not one. */
function instructionArray(doc, path) {
  if (doc.instructions === undefined) return null;
  if (doc.instructions.value.type !== 'array') {
    throw new Error(
      `${path} has an instructions key that is neither absent nor an array; refusing to edit it`,
    );
  }
  return doc.instructions.value;
}
/** How many items of `array` decode to `value`. */
function matchCount(array, value) {
  return array.items.filter(
    (item) => item.type === 'string' && item.value === value,
  ).length;
}
/** The index of the first item in `array` whose string equals `value`. */
function indexOfItem(array, value) {
  return array.items.findIndex(
    (item) => item.type === 'string' && item.value === value,
  );
}
/** Insert `valueJson` as the last member of `root`, with no whitespace. */
function insertMember(text, root, key, valueJson) {
  const at = root.end - 1;
  const comma = root.members.length > 0 ? ',' : '';
  return `${text.slice(0, at)}${comma}${JSON.stringify(key)}:${valueJson}${text.slice(at)}`;
}
/** Insert `valueJson` as the last item of `array`, with no whitespace. */
function insertItem(text, array, valueJson) {
  const at = array.end - 1;
  const comma = array.items.length > 0 ? ',' : '';
  return `${text.slice(0, at)}${comma}${valueJson}${text.slice(at)}`;
}
/**
 * Remove one item. The item and the comma before it go, or the comma after it
 * when the item is first, so the rest of the text keeps its bytes.
 */
function removeItem(text, array, index) {
  const items = array.items;
  const item = items[index];
  let from = item.start;
  let to = item.end;
  if (items.length > 1 && index > 0) {
    from = text.indexOf(',', items[index - 1].end);
  } else if (items.length > 1) {
    to = items[1].start;
  }
  return text.slice(0, from) + text.slice(to);
}
/** Remove one member, with the same comma rule as `removeItem`. */
function removeMember(text, root, index) {
  const members = root.members;
  const member = members[index];
  let from = member.keyStart;
  let to = member.value.end;
  if (members.length > 1 && index > 0) {
    from = text.indexOf(',', members[index - 1].value.end);
  } else if (members.length > 1) {
    to = members[1].keyStart;
  }
  return text.slice(0, from) + text.slice(to);
}
/**
 * The bytes a Markdown file becomes: the span replaces the block when one is
 * present, and otherwise follows the file, after one LF when the file is
 * non-empty and does not end with LF.
 */
function markdownNext(bytes, block, span) {
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
function pushRewrite(input, plan, dir, file, priorSha256, text, entry, prior) {
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
/** A file install created whole: the bytes must still match the receipt. */
function planWholeFile(input, plan, dir, file, bytes, expected, prior) {
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
function planMarkdown(input, plan, harness, dir, file, bytes, listed) {
  const expected = managedSpan(harness, input.entryPath, input.entryText);
  const span = Buffer.from(expected, 'utf8');
  if (listed !== null && listed.kind === 'file') {
    planWholeFile(input, plan, dir, file, bytes, expected, listed);
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
function planOpenCode(input, plan, dir, file, bytes, listed) {
  const value = input.entryPath;
  const expected = opencodeFileText(value);
  if (listed !== null && listed.kind === 'file') {
    planWholeFile(input, plan, dir, file, bytes, expected, listed);
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
function planOne(input, target, plan) {
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
export function planEntryFiles(input) {
  const plan = { dirs: [], steps: [], lines: [], refusals: [] };
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
 */
export function planEntryRemoval(fs, entry) {
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
    let from = block.begin;
    if (entry.separator) {
      if (block.begin === 0 || bytes[block.begin - 1] !== LF) {
        throw new Error(
          `${entry.path} no longer has the LF install wrote before its block; refusing, and it is user-edited`,
        );
      }
      from = block.begin - 1;
    }
    refuseStaleTemp(dirname(entry.path), entry.path, fs);
    const kept = Buffer.concat([
      bytes.subarray(0, from),
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
