// idd-generated-from: src/scripts/workflow-yaml-subset.mts
//
// The scripts/workflow-yaml-subset.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// A reader for the YAML subset that GitHub workflow files use (issue
// #3974). It parses block mappings and sequences, plain, single-quoted, and
// double-quoted scalars, block scalars, and single-line flow collections.
// Every other construct is refused with a named violation rather than
// guessed: anchors, aliases, tags, complex keys, a second document,
// directives, duplicate keys, tabs outside quoted text, carriage returns and
// other line breaks, multi-line scalars and flow collections, and block
// scalar indentation indicators.
//
// No scalar is type-resolved, so the key `on` stays the string `on`. The
// module imports nothing, so it runs with plain node in the bare-Node lane.
// Nothing reads it yet: the 2026-10-12 split decision leaves the workflow
// audit's readers unchanged, and the rule groups R5 to R8 move to this
// parser in follow-up issues.
/** Carries a violation out of the recursive descent. Never leaves the module. */
class WorkflowYamlRefusal extends Error {
  violation;
  constructor(violation) {
    super(violation.message);
    this.name = 'WorkflowYamlRefusal';
    this.violation = violation;
  }
}
const SIMPLE_ESCAPES = new Map([
  ['0', '\u0000'],
  ['a', '\u0007'],
  ['b', '\b'],
  ['t', '\t'],
  ['\t', '\t'],
  ['n', '\n'],
  ['v', '\u000b'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\u001b'],
  [' ', ' '],
  ['"', '"'],
  ['/', '/'],
  ['\\', '\\'],
  ['N', '\u0085'],
  ['_', ' '],
  ['L', ' '],
  ['P', ' '],
]);
const HEX_ESCAPE_DIGITS = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
]);
/** Characters that cannot start a plain scalar in a block value. */
const RESERVED_BLOCK_START = ',]}%@`';
/** Characters that cannot start a value inside a flow collection. */
const RESERVED_FLOW_START = ',]}#%@`|>';
/**
 * The deepest nesting either reader follows. Past it the input is refused as
 * a syntax violation instead of exhausting the call stack.
 */
const MAX_NESTING = 200;
/**
 * Parses one YAML document of the subset. A refusal comes back as
 * `ok: false` with the first construct found; it is never thrown.
 */
// audit:ignore-dead-export: no production caller until the R5 to R8 follow-up issues move the workflow audit onto this parser (split decision 2026-10-12, #3974)
export function parseWorkflowYamlSubset(text) {
  try {
    prescan(text);
    return { ok: true, value: new BlockReader(text).parseDocument() };
  } catch (error) {
    if (error instanceof WorkflowYamlRefusal) {
      return { ok: false, violation: error.violation };
    }
    throw error;
  }
}
function refuse(construct, message, spot, at) {
  throw new WorkflowYamlRefusal({
    construct,
    message,
    line: spot.line,
    column: spot.origin + at + 1,
  });
}
function refuseTab(spot, at) {
  refuse(
    'tab-character',
    'tab characters are refused here; use spaces',
    spot,
    at,
  );
}
function hexCode(code) {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}
/** Classifies a character that YAML's printable set does not allow. */
function characterRefusal(code) {
  if (code === 0x0d) {
    return {
      construct: 'carriage-return',
      message: 'carriage return is refused; use LF line endings',
    };
  }
  if (code === 0x85 || code === 0x2028 || code === 0x2029) {
    return {
      construct: 'unicode-line-break',
      message: `${hexCode(code)} line break is refused`,
    };
  }
  if (code === 0xfeff) {
    return {
      construct: 'byte-order-mark',
      message: 'byte order mark is refused',
    };
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    return {
      construct: 'non-printable-character',
      message: 'unpaired surrogate is refused',
    };
  }
  const printable =
    code === 0x09 ||
    code === 0x0a ||
    (code >= 0x20 &&
      code !== 0x7f &&
      !(code >= 0x80 && code <= 0x9f) &&
      code !== 0xfffe &&
      code !== 0xffff);
  return printable
    ? null
    : {
        construct: 'non-printable-character',
        message: `non-printable character ${hexCode(code)} is refused`,
      };
}
/** Refuses a character outside the printable set before any parsing. */
function prescan(text) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // A valid pair is one printable astral character.
        index += 1;
        column += 2;
        continue;
      }
    }
    const refusal = characterRefusal(code);
    if (refusal !== null) {
      throw new WorkflowYamlRefusal({ ...refusal, line, column });
    }
    if (code === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
}
function countSpaces(raw) {
  let count = 0;
  while (raw[count] === ' ') {
    count += 1;
  }
  return count;
}
function textOf(line) {
  return line.raw.slice(line.indent);
}
function spotOf(line) {
  return { line: line.no, origin: line.indent };
}
/** A spot whose offsets are raw indexes into the source line. */
function rawSpot(line) {
  return { line: line.no, origin: 0 };
}
function isSequenceEntry(text) {
  return text === '-' || text.startsWith('- ');
}
/** True for a document marker line: `---` or `...` alone at column 0. */
function isMarker(line, marker) {
  return (
    line.indent === 0 &&
    line.raw.startsWith(marker) &&
    (line.raw.length === 3 || line.raw[3] === ' ')
  );
}
function refuseIndicators(text, at, spot) {
  const first = text[at];
  if (first === '&') {
    refuse('anchor', 'anchors are not supported', spot, at);
  }
  if (first === '*') {
    refuse('alias', 'aliases are not supported', spot, at);
  }
  if (first === '!') {
    refuse('tag', 'tags are not supported', spot, at);
  }
  if (first === '?' && (at + 1 === text.length || text[at + 1] === ' ')) {
    refuse('complex-key', 'complex keys are not supported', spot, at);
  }
}
/** Decodes the escape whose letter is at `at`; `at - 1` is the backslash. */
function decodeEscape(text, at, spot) {
  const key = text[at];
  const simple = SIMPLE_ESCAPES.get(key);
  if (simple !== undefined) {
    return { value: simple, next: at + 1 };
  }
  const digits = HEX_ESCAPE_DIGITS.get(key);
  if (digits === undefined) {
    refuse('unsupported-escape', `unknown escape \\${key}`, spot, at - 1);
  }
  const hex = text.slice(at + 1, at + 1 + digits);
  const code =
    /^[0-9a-fA-F]+$/.test(hex) && hex.length === digits
      ? Number.parseInt(hex, 16)
      : Number.NaN;
  if (!(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
    refuse('unsupported-escape', `invalid escape \\${key}${hex}`, spot, at - 1);
  }
  return { value: String.fromCodePoint(code), next: at + 1 + digits };
}
/** Reads a quoted scalar that closes on this line, or returns null. */
function readQuoted(text, start, spot) {
  const single = text[start] === "'";
  let value = '';
  let at = start + 1;
  while (at < text.length) {
    const ch = text[at];
    if (single) {
      if (ch === "'") {
        if (text[at + 1] !== "'") {
          return { value, end: at + 1 };
        }
        value += "'";
        at += 2;
        continue;
      }
    } else if (ch === '"') {
      return { value, end: at + 1 };
    } else if (ch === '\\') {
      if (at + 1 >= text.length) {
        return null;
      }
      const decoded = decodeEscape(text, at + 1, spot);
      value += decoded.value;
      at = decoded.next;
      continue;
    }
    value += ch;
    at += 1;
  }
  return null;
}
/**
 * Only spaces and an optional comment may follow a value. A comment needs a
 * space before its `#`.
 */
function checkTail(text, from, spot) {
  const tab = text.indexOf('\t', from);
  if (tab >= 0) {
    refuseTab(spot, tab);
  }
  if (!/^( +(#.*)?)?$/.test(text.slice(from))) {
    refuse('syntax', 'unexpected text after the value', spot, from);
  }
}
/** Trims trailing spaces only; YAML does not treat other whitespace as space. */
function trimSpaces(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) {
    end -= 1;
  }
  return text.slice(0, end);
}
/** Reads a block plain scalar up to a comment or the end of the line. */
function scanBlockPlain(text, start, spot) {
  let end = start;
  while (end < text.length && !(text[end] === ' ' && text[end + 1] === '#')) {
    if (text[end] === '\t') {
      refuseTab(spot, end);
    }
    end += 1;
  }
  return trimSpaces(text.slice(start, end));
}
/**
 * Finds the colon that ends a mapping key on this line, or returns -1. A
 * flow collection is never a key in this subset.
 */
function keyColonIndex(text, spot) {
  const first = text[0];
  if (first === '[' || first === '{') {
    return -1;
  }
  if (first === '"' || first === "'") {
    const read = readQuoted(text, 0, spot);
    if (read === null) {
      return -1;
    }
    let at = read.end;
    while (text[at] === ' ') {
      at += 1;
    }
    return text[at] === ':' && (at + 1 === text.length || text[at + 1] === ' ')
      ? at
      : -1;
  }
  for (let at = 0; at < text.length; at++) {
    if (text[at] === ' ' && text[at + 1] === '#') {
      return -1;
    }
    if (text[at] === ':' && (at + 1 === text.length || text[at + 1] === ' ')) {
      return at;
    }
  }
  return -1;
}
function readKey(text, colon, spot) {
  const first = text[0];
  if (first === '"' || first === "'") {
    const read = readQuoted(text, 0, spot);
    if (read === null) {
      refuse(
        'multiline-quoted-scalar',
        'quoted key continues on a later line',
        spot,
        0,
      );
    }
    return read.value;
  }
  const key = trimSpaces(text.slice(0, colon));
  if (key.includes('\t')) {
    refuseTab(spot, text.indexOf('\t'));
  }
  if (key === '') {
    refuse('syntax', 'empty mapping key', spot, 0);
  }
  if (
    RESERVED_BLOCK_START.includes(key[0]) ||
    key[0] === '|' ||
    key[0] === '>'
  ) {
    refuse('syntax', 'reserved indicator cannot start a mapping key', spot, 0);
  }
  return key;
}
/**
 * Folds `>` content: a line break between two plain lines becomes a space,
 * an empty line becomes a newline, and a more-indented line keeps its breaks.
 */
function foldEntries(entries) {
  let out = '';
  let previous = 'start';
  let pending = 0;
  for (const entry of entries) {
    if (entry.blank) {
      pending += 1;
      continue;
    }
    const kind = entry.text.startsWith(' ') ? 'indented' : 'plain';
    if (previous === 'start') {
      out += '\n'.repeat(pending);
    } else if (previous === 'plain' && kind === 'plain') {
      out += pending > 0 ? '\n'.repeat(pending) : ' ';
    } else {
      out += `\n${'\n'.repeat(pending)}`;
    }
    out += entry.text;
    previous = kind;
    pending = 0;
  }
  return out;
}
/**
 * Reads one single-line flow collection or flow scalar. The position is the
 * index into `text`, and every refusal points into the same line.
 */
class FlowReader {
  text;
  spot;
  position;
  depth = 0;
  constructor(text, start, spot) {
    this.text = text;
    this.spot = spot;
    this.position = start;
  }
  parseValue() {
    this.skipSpaces();
    const first = this.text[this.position];
    if (first === undefined) {
      this.unclosed();
    }
    if (first === '[') {
      return this.nested(() => this.parseSequence());
    }
    if (first === '{') {
      return this.nested(() => this.parseMapping());
    }
    if (first === '"' || first === "'") {
      const read = readQuoted(this.text, this.position, this.spot);
      if (read === null) {
        refuse(
          'multiline-quoted-scalar',
          'quoted scalar continues on a later line',
          this.spot,
          this.position,
        );
      }
      this.position = read.end;
      return read.value;
    }
    refuseIndicators(this.text, this.position, this.spot);
    const next = this.text[this.position + 1];
    const indicatorOnly = first === '-' || first === '?' || first === ':';
    if (
      RESERVED_FLOW_START.includes(first) ||
      (indicatorOnly && (next === undefined || ' ,[]{}'.includes(next)))
    ) {
      refuse('syntax', 'expected a value', this.spot, this.position);
    }
    return this.readPlain();
  }
  /** Runs one nested collection read, refusing nesting past the limit. */
  nested(read) {
    this.depth += 1;
    if (this.depth > MAX_NESTING) {
      refuse(
        'syntax',
        `nesting deeper than ${MAX_NESTING} levels is refused`,
        this.spot,
        this.position,
      );
    }
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }
  parseSequence() {
    const items = [];
    this.position += 1;
    for (;;) {
      this.skipSpaces();
      if (this.text[this.position] === ']') {
        this.position += 1;
        return items;
      }
      items.push(this.parseValue());
      this.skipSpaces();
      const next = this.text[this.position];
      if (next === ',') {
        this.position += 1;
      } else if (next === ']') {
        this.position += 1;
        return items;
      } else if (next === undefined) {
        this.unclosed();
      } else {
        refuse(
          'syntax',
          this.text[this.position] === ':'
            ? 'single-pair mappings inside a flow sequence are not supported'
            : 'expected , or ] in a flow sequence',
          this.spot,
          this.position,
        );
      }
    }
  }
  parseMapping() {
    const mapping = {};
    this.position += 1;
    for (;;) {
      this.skipSpaces();
      if (this.text[this.position] === '}') {
        this.position += 1;
        return mapping;
      }
      const key = this.parseValue();
      if (typeof key !== 'string') {
        refuse(
          'syntax',
          'flow mapping keys must be scalars',
          this.spot,
          this.position,
        );
      }
      this.skipSpaces();
      // `{k}` and `{k: }` both mean a null value, as in YAML.
      let value = null;
      const marker = this.text[this.position];
      if (marker === ':') {
        this.position += 1;
        this.skipSpaces();
        const next = this.text[this.position];
        value = next === ',' || next === '}' ? null : this.parseValue();
      } else if (marker !== ',' && marker !== '}') {
        refuse(
          'syntax',
          'expected : after a flow mapping key',
          this.spot,
          this.position,
        );
      }
      if (Object.hasOwn(mapping, key)) {
        refuse(
          'duplicate-key',
          `duplicate key "${key}"`,
          this.spot,
          this.position,
        );
      }
      Object.defineProperty(mapping, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipSpaces();
      const after = this.text[this.position];
      if (after === ',') {
        this.position += 1;
      } else if (after === '}') {
        this.position += 1;
        return mapping;
      } else if (after === undefined) {
        this.unclosed();
      } else {
        refuse(
          'syntax',
          'expected , or } in a flow mapping',
          this.spot,
          this.position,
        );
      }
    }
  }
  readPlain() {
    const start = this.position;
    while (this.position < this.text.length) {
      const ch = this.text[this.position];
      const next = this.text[this.position + 1];
      if (ch === '\t') {
        refuseTab(this.spot, this.position);
      }
      if (',[]{}'.includes(ch)) {
        break;
      }
      if (ch === ':' && (next === undefined || ' ,[]{}'.includes(next))) {
        break;
      }
      if (ch === ' ' && next === '#') {
        break;
      }
      this.position += 1;
    }
    const value = trimSpaces(this.text.slice(start, this.position));
    if (value === '') {
      refuse('syntax', 'expected a value', this.spot, this.position);
    }
    return value;
  }
  skipSpaces() {
    while (this.text[this.position] === ' ') {
      this.position += 1;
    }
    if (this.text[this.position] === '\t') {
      refuseTab(this.spot, this.position);
    }
  }
  unclosed() {
    refuse(
      'multiline-flow-collection',
      'flow collection is not closed on this line',
      this.spot,
      this.position,
    );
  }
}
/** Reads the block structure of one document, line by line. */
class BlockReader {
  lines;
  /** Whether the input's last line is ended by a line break. */
  endsWithBreak;
  index = 0;
  depth = 0;
  constructor(text) {
    const raws = text.split('\n');
    this.endsWithBreak = text.endsWith('\n');
    // A final line break ends the last line; it does not open another one.
    if (this.endsWithBreak) {
      raws.pop();
    }
    this.lines = raws.map((raw, index) => ({
      no: index + 1,
      raw,
      indent: countSpaces(raw),
    }));
  }
  parseDocument() {
    let start = 0;
    while (
      start < this.lines.length &&
      this.isBlankOrComment(this.lines[start])
    ) {
      start += 1;
    }
    const first = this.lines[start];
    if (first !== undefined && first.indent === 0 && first.raw[0] === '%') {
      refuse(
        'directive',
        'YAML directives are not supported',
        rawSpot(first),
        0,
      );
    }
    if (first !== undefined && isMarker(first, '---')) {
      const after = first.raw.slice(3);
      if (!/^( +(#.*)?)?$/.test(after)) {
        refuse(
          'syntax',
          'content on the document start line is not supported',
          rawSpot(first),
          3,
        );
      }
      this.index = start + 1;
    } else {
      this.index = start;
    }
    const at = this.peekContent();
    if (at < 0) {
      return null;
    }
    const value = this.parseNodeAt(at, -1);
    const extra = this.peekContent();
    if (extra >= 0) {
      refuse(
        'syntax',
        'content after the end of the value is not supported',
        spotOf(this.lines[extra]),
        0,
      );
    }
    return value;
  }
  /** True for a blank or comment-only line; refuses a tab in indentation. */
  isBlankOrComment(line) {
    if (line.raw[line.indent] === '\t') {
      refuseTab(rawSpot(line), line.indent);
    }
    return line.indent === line.raw.length || line.raw[line.indent] === '#';
  }
  /**
   * Returns the index of the next content line at or after `index`, without
   * consuming it. A `...` end marker returns -1 once only blank lines or
   * comments follow it.
   */
  peekContent() {
    for (let at = this.index; at < this.lines.length; at++) {
      const line = this.lines[at];
      if (this.isBlankOrComment(line)) {
        continue;
      }
      if (isMarker(line, '...')) {
        this.assertNoContentAfter(at + 1);
        return -1;
      }
      if (isMarker(line, '---')) {
        refuse(
          'multiple-documents',
          'a second document start marker is refused',
          spotOf(line),
          0,
        );
      }
      if (line.indent === 0 && line.raw[0] === '%') {
        refuse(
          'directive',
          'YAML directives are not supported',
          spotOf(line),
          0,
        );
      }
      return at;
    }
    return -1;
  }
  assertNoContentAfter(from) {
    for (let at = from; at < this.lines.length; at++) {
      const line = this.lines[at];
      if (!this.isBlankOrComment(line)) {
        refuse(
          'multiple-documents',
          'content after a document end marker is refused',
          spotOf(line),
          0,
        );
      }
    }
  }
  /** Parses the node that starts on line `at`; `parentIndent` bounds it. */
  parseNodeAt(at, parentIndent) {
    const line = this.lines[at];
    const text = textOf(line);
    refuseIndicators(text, 0, spotOf(line));
    this.depth += 1;
    if (this.depth > MAX_NESTING) {
      refuse(
        'syntax',
        `nesting deeper than ${MAX_NESTING} levels is refused`,
        spotOf(line),
        0,
      );
    }
    try {
      if (isSequenceEntry(text)) {
        this.index = at;
        return this.parseSequence(line.indent);
      }
      if (keyColonIndex(text, spotOf(line)) >= 0) {
        this.index = at;
        return this.parseMapping(line.indent);
      }
      this.index = at + 1;
      return this.parseInline(line, 0, parentIndent);
    } finally {
      this.depth -= 1;
    }
  }
  parseSequence(indent) {
    const items = [];
    for (;;) {
      const at = this.peekContent();
      if (at < 0) {
        return items;
      }
      const line = this.lines[at];
      if (line.indent < indent) {
        return items;
      }
      const spot = spotOf(line);
      const text = textOf(line);
      if (line.indent > indent) {
        refuse('syntax', 'unexpected indentation', spot, 0);
      }
      if (!isSequenceEntry(text)) {
        return items;
      }
      let start = 1;
      while (text[start] === ' ') {
        start += 1;
      }
      if (text[start] === '\t') {
        refuseTab(spot, start);
      }
      if (start >= text.length || text[start] === '#') {
        this.index = at + 1;
        const next = this.peekContent();
        items.push(
          next >= 0 && this.lines[next].indent > indent
            ? this.parseNodeAt(next, indent)
            : null,
        );
        continue;
      }
      // The item's own node is read as a line whose indent is the column
      // after `- `, so a mapping that starts on the dash line lines up.
      this.lines[at] = {
        no: line.no,
        raw: line.raw,
        indent: line.indent + start,
      };
      items.push(this.parseNodeAt(at, indent));
    }
  }
  parseMapping(indent) {
    const mapping = {};
    for (;;) {
      const at = this.peekContent();
      if (at < 0) {
        return mapping;
      }
      const line = this.lines[at];
      if (line.indent < indent) {
        return mapping;
      }
      const spot = spotOf(line);
      const text = textOf(line);
      if (line.indent > indent) {
        refuse('syntax', 'unexpected indentation', spot, 0);
      }
      refuseIndicators(text, 0, spot);
      const colon = keyColonIndex(text, spot);
      if (colon < 0) {
        refuse('syntax', 'expected a mapping key', spot, 0);
      }
      const key = readKey(text, colon, spot);
      if (Object.hasOwn(mapping, key)) {
        refuse('duplicate-key', `duplicate key "${key}"`, spot, 0);
      }
      const value = this.parseValueAfterKey(at, colon);
      Object.defineProperty(mapping, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  /** Reads the value after the key whose colon is at `colon` on line `at`. */
  parseValueAfterKey(at, colon) {
    const line = this.lines[at];
    const text = textOf(line);
    this.index = at + 1;
    let start = colon + 1;
    while (text[start] === ' ') {
      start += 1;
    }
    if (text[start] === '\t') {
      refuseTab(spotOf(line), start);
    }
    if (start >= text.length || text[start] === '#') {
      const next = this.peekContent();
      if (next < 0) {
        return null;
      }
      const nextLine = this.lines[next];
      if (nextLine.indent > line.indent) {
        return this.parseNodeAt(next, line.indent);
      }
      if (
        nextLine.indent === line.indent &&
        isSequenceEntry(textOf(nextLine))
      ) {
        this.index = next;
        return this.parseSequence(line.indent);
      }
      return null;
    }
    return this.parseInline(line, start, line.indent);
  }
  /**
   * Reads the value that starts at `start` in `line`. The caller has already
   * moved `index` past that line, so a block scalar reads its body from there.
   */
  parseInline(line, start, parentIndent) {
    const text = textOf(line);
    const spot = spotOf(line);
    const first = text[start];
    if (first === '|' || first === '>') {
      return this.parseBlockScalar(line, start, parentIndent);
    }
    if (first === '[' || first === '{') {
      const reader = new FlowReader(text, start, spot);
      const value = reader.parseValue();
      let colonAt = reader.position;
      while (text[colonAt] === ' ') {
        colonAt += 1;
      }
      const after = text[colonAt + 1];
      if (text[colonAt] === ':' && (after === undefined || after === ' ')) {
        refuse(
          'complex-key',
          'flow collections as mapping keys are not supported',
          spot,
          reader.position,
        );
      }
      checkTail(text, reader.position, spot);
      return value;
    }
    if (first === '"' || first === "'") {
      const read = readQuoted(text, start, spot);
      if (read === null) {
        refuse(
          'multiline-quoted-scalar',
          'quoted scalar continues on a later line',
          spot,
          start,
        );
      }
      checkTail(text, read.end, spot);
      this.rejectContinuation(parentIndent, false);
      return read.value;
    }
    refuseIndicators(text, start, spot);
    if (
      (first === '-' || first === ':') &&
      (start + 1 === text.length || text[start + 1] === ' ')
    ) {
      refuse(
        'syntax',
        'a block sequence or mapping cannot start on this line',
        spot,
        start,
      );
    }
    if (RESERVED_BLOCK_START.includes(first)) {
      refuse(
        'syntax',
        'reserved indicator cannot start a plain scalar',
        spot,
        start,
      );
    }
    const value = scanBlockPlain(text, start, spot);
    if (value.includes(': ') || value.endsWith(':')) {
      refuse(
        'syntax',
        'mapping value where a plain scalar is expected',
        spot,
        start,
      );
    }
    this.rejectContinuation(parentIndent, true);
    return value;
  }
  /** Refuses an indented line that continues a single-line value. */
  rejectContinuation(parentIndent, plain) {
    const next = this.peekContent();
    if (next < 0 || this.lines[next].indent <= parentIndent) {
      return;
    }
    const spot = spotOf(this.lines[next]);
    if (plain) {
      refuse(
        'multiline-plain-scalar',
        'plain scalar continues on an indented line',
        spot,
        0,
      );
    }
    refuse('syntax', 'unexpected indented content after a value', spot, 0);
  }
  /**
   * Reads a block scalar. Its body is every following line indented deeper
   * than `parentIndent`, plus blank lines between them. A less-indented
   * non-blank line, such as a comment, ends it.
   */
  parseBlockScalar(line, start, parentIndent) {
    const text = textOf(line);
    const spot = spotOf(line);
    const folded = text[start] === '>';
    let chomp = 'clip';
    let at = start + 1;
    for (; at < text.length && text[at] !== ' ' && text[at] !== '#'; at++) {
      const ch = text[at];
      if (ch === '\t') {
        refuseTab(spot, at);
      }
      if (ch === '-' || ch === '+') {
        if (chomp !== 'clip') {
          refuse('syntax', 'invalid block scalar header', spot, at);
        }
        chomp = ch === '-' ? 'strip' : 'keep';
      } else if (ch >= '1' && ch <= '9') {
        refuse(
          'block-scalar-indent-indicator',
          'block scalar indentation indicators are not supported',
          spot,
          at,
        );
      } else {
        refuse('syntax', 'invalid block scalar header', spot, at);
      }
    }
    checkTail(text, at, spot);
    const entries = [];
    let indent = -1;
    // The widest leading empty line; YAML forbids it to exceed the first
    // content line's indentation.
    let leadingSpaces = 0;
    let next = this.index;
    for (; next < this.lines.length; next++) {
      const raw = this.lines[next].raw;
      const spaces = countSpaces(raw);
      // A document marker at column 0 ends the scalar at any indentation.
      if (
        spaces === 0 &&
        (raw.startsWith('---') || raw.startsWith('...')) &&
        (raw.length === 3 || raw[3] === ' ')
      ) {
        break;
      }
      if (spaces === raw.length) {
        // Spaces only: blank, unless the spaces run past the content indent,
        // which makes a more-indented content line.
        if (indent < 0) {
          leadingSpaces = Math.max(leadingSpaces, raw.length);
        }
        entries.push(
          indent >= 0 && raw.length > indent
            ? { text: raw.slice(indent), blank: false }
            : { text: '', blank: true },
        );
        continue;
      }
      if (raw[spaces] === '\t') {
        refuseTab(rawSpot(this.lines[next]), spaces);
      }
      if (indent < 0) {
        if (spaces <= parentIndent) {
          break;
        }
        if (leadingSpaces > spaces) {
          refuse(
            'syntax',
            'a leading empty line is more indented than the first content line',
            rawSpot(this.lines[next]),
            spaces,
          );
        }
        indent = spaces;
      }
      if (spaces < indent) {
        break;
      }
      entries.push({ text: raw.slice(indent), blank: false });
    }
    this.index = next;
    let end = entries.length;
    while (end > 0 && entries[end - 1].blank) {
      end -= 1;
    }
    const trailing = entries.length - end;
    const core = entries.slice(0, end);
    if (core.length === 0) {
      return chomp === 'keep' ? '\n'.repeat(trailing) : '';
    }
    const body = folded
      ? foldEntries(core)
      : core.map((entry) => entry.text).join('\n');
    if (chomp === 'strip') {
      return body;
    }
    // The block ran to the end of input with no line break after its last
    // line, so there is no final break to keep or clip.
    const unterminated = next >= this.lines.length && !this.endsWithBreak;
    if (chomp === 'clip') {
      return unterminated ? body : `${body}\n`;
    }
    return unterminated
      ? `${body}${'\n'.repeat(trailing)}`
      : `${body}\n${'\n'.repeat(trailing)}`;
  }
}
