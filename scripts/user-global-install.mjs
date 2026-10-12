// idd-generated-from: src/scripts/user-global-install.mts
//
// The scripts/user-global-install.mjs copy is generated from this .mts source
// by `pnpm run build`. Edit the .mts source, never the generated .mjs. See
// docs/typescript-sources.md.
// User-global install of the IDD payload, skills, and harness wiring (#3825).
//
// The `idd-onboard --install-user-global` mode calls into this module. A plan
// is computed once and shared by --dry-run and the apply path, so a dry run
// cannot drift from what an apply would do. Nothing outside the managed block
// (Markdown) or the one inserted array element (opencode.json) is rewritten,
// and uninstall deletes only what the receipt says install created.
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildHelperRuntimeManifest } from './helper-runtime-manifest.mjs';
import { resolveInstalledPayloadRoot } from './idd-activation.mjs';
import { isQualifiedConfigRoot } from './idd-config.mjs';
export const HARNESS_NAMES = ['claude', 'codex', 'opencode'];
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
];
function resolveLocations(options) {
  const { env, homedir } = options;
  const payloadRoot = resolveInstalledPayloadRoot({ env, homedir });
  if (payloadRoot === undefined) {
    throw new Error(
      'user-global install: payload root is unresolved; set XDG_DATA_HOME or HOME to an absolute path',
    );
  }
  const qualified = (value) => {
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
function readBytesIfExists(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function readUtf8IfExists(path) {
  return readBytesIfExists(path)?.toString('utf8') ?? null;
}
function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function walkFiles(dir, prefix = '') {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) {
      found.push(...walkFiles(abs, rel));
    } else {
      found.push(rel);
    }
  }
  return found;
}
function readManifestBlock(bundleRoot, id) {
  const manifest = JSON.parse(
    readFileSync(join(bundleRoot, 'audit', 'sync-manifest.json'), 'utf8'),
  );
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
function readVersion(bundleRoot) {
  const pkg = JSON.parse(
    readFileSync(join(bundleRoot, 'package.json'), 'utf8'),
  );
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('user-global install: package.json has no version');
  }
  return pkg.version;
}
/** Relative payload path mapped to its absolute source file. */
function payloadSources(bundleRoot) {
  const sources = new Map();
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
function skillFiles(bundleRoot) {
  const files = [];
  for (const id of SKILL_BLOCKS) {
    for (const manifestPath of readManifestBlock(bundleRoot, id)) {
      const parts = manifestPath.split('/');
      if (parts[0] !== 'skills' || parts.length < 3) {
        throw new Error(
          `user-global install: skill path "${manifestPath}" is not under skills/<name>/`,
        );
      }
      files.push({
        skill: parts[1],
        relative: parts.slice(2).join('/'),
        source: join(bundleRoot, manifestPath),
      });
    }
  }
  return files;
}
function expectedPayloadTree(bundleRoot, version) {
  const tree = new Map();
  for (const [rel, source] of payloadSources(bundleRoot)) {
    tree.set(rel, readFileSync(source));
  }
  tree.set(
    PAYLOAD_MARKER_NAME,
    Buffer.from(`${JSON.stringify({ source: 'idd-skill', version })}\n`),
  );
  return tree;
}
function treeOf(dir) {
  const tree = new Map();
  for (const rel of walkFiles(dir)) {
    tree.set(rel, readFileSync(join(dir, ...rel.split('/'))));
  }
  return tree;
}
function sameTree(a, b) {
  if (a.size !== b.size) return false;
  for (const [rel, bytes] of a) {
    const other = b.get(rel);
    if (other === undefined || !other.equals(bytes)) return false;
  }
  return true;
}
/** Directories to create for `dirs`, parents first, skipping existing ones. */
function missingAncestors(dirs) {
  const missing = [];
  for (const dir of dirs) {
    const chain = [];
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
function ensureDirs(plan, dirs, created) {
  for (const dir of missingAncestors(dirs)) {
    created.push(dir);
    plan.ops.push({ kind: 'mkdir', path: dir });
  }
}
function pushChange(plan, path, action) {
  plan.changes.push({ path, action });
}
// ---------------------------------------------------------------------------
// Managed Markdown block (Claude CLAUDE.md, Codex AGENTS.md).
// ---------------------------------------------------------------------------
function lineEndingOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
/**
 * Find the single managed region. Throws unless the file holds none, or
 * exactly one BEGIN line followed by one END line. Any other shape is refused
 * rather than guessed at, so a half-edited block is never overwritten.
 */
function findRegion(text, path) {
  const begins = [];
  const ends = [];
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
function buildBlock(bodyLines, eol) {
  return [BEGIN_MARKER, ...bodyLines, END_MARKER]
    .map((line) => `${line}${eol}`)
    .join('');
}
/** Install or refresh the managed block; returns the full new file text. */
function wireMarkdown(text, bodyLines, path) {
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
function unwireMarkdown(text, path) {
  const region = findRegion(text, path);
  if (region === null) return null;
  let start = region.begin;
  if (region.begin > 0) {
    start -= text.slice(0, region.begin).endsWith('\r\n') ? 2 : 1;
  }
  return text.slice(0, start) + text.slice(region.end);
}
function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && ' \t\r\n'.includes(text.charAt(i))) i += 1;
  return i;
}
function stringEnd(text, index) {
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
function valueEnd(text, index) {
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
function parseTopObject(text) {
  let i = skipWhitespace(text, 0);
  if (text.charAt(i) !== '{') {
    throw new Error('user-global install: opencode.json root is not an object');
  }
  const open = i;
  const members = [];
  i = skipWhitespace(text, i + 1);
  if (text.charAt(i) === '}') return { open, members };
  for (;;) {
    i = skipWhitespace(text, i);
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
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
function parseArrayAt(text, index) {
  const elements = [];
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
function instructionsOf(text, path) {
  let parsed;
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
  const value = parsed.instructions;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `user-global install: ${path} has a non-array "instructions" value; refusing to edit it`,
    );
  }
  return value;
}
/** Insert the entry. Returns the new text and what install created. */
function spliceOpencodeIn(text, entry, path) {
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
    const last = array.elements.at(-1).end;
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
  const lastValue = object.members.at(-1).valueEnd;
  return {
    text: `${text.slice(0, lastValue)}, ${addition}${text.slice(lastValue)}`,
    entryAdded: true,
    keyCreated: true,
  };
}
/** Remove the entry install added. Returns null when it is not present. */
function spliceOpencodeOut(text, entry, keyCreated, path) {
  const existing = instructionsOf(text, path);
  if (!existing?.includes(entry)) return null;
  const object = parseTopObject(text);
  const memberIndex = object.members.findIndex((m) => m.key === 'instructions');
  const member = object.members[memberIndex];
  const array = parseArrayAt(text, member.valueStart);
  const index = array.elements.findIndex(
    (span) => JSON.parse(text.slice(span.start, span.end)) === entry,
  );
  if (index === -1) return null;
  const element = array.elements[index];
  if (keyCreated && array.elements.length === 1) {
    // Install created the whole key; remove the member, not a leftover array.
    if (object.members.length === 1) {
      return text.slice(0, member.keyStart) + text.slice(member.valueEnd);
    }
    if (memberIndex > 0) {
      const previous = object.members[memberIndex - 1];
      return text.slice(0, previous.valueEnd) + text.slice(member.valueEnd);
    }
    const next = object.members[memberIndex + 1];
    return text.slice(0, member.keyStart) + text.slice(next.keyStart);
  }
  if (index > 0) {
    const previous = array.elements[index - 1];
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
function readReceipt(path) {
  const text = readUtf8IfExists(path);
  if (text === null) return null;
  const parsed = JSON.parse(text);
  if (parsed.schema !== 1) {
    throw new Error(`user-global install: unknown receipt schema in ${path}`);
  }
  return parsed;
}
function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}
// ---------------------------------------------------------------------------
// Payload, current link, and skills.
// ---------------------------------------------------------------------------
function planPayload(plan, locations, bundleRoot, version, createdDirs) {
  const versionDir = join(locations.dataRoot, version);
  const expected = expectedPayloadTree(bundleRoot, version);
  const existing = lstatIfExists(versionDir);
  if (existing !== null && !existing.isDirectory()) {
    throw new Error(
      `user-global install: ${versionDir} exists and is not a directory; refusing to replace it`,
    );
  }
  if (existing !== null && sameTree(expected, treeOf(versionDir))) {
    pushChange(plan, versionDir, 'unchanged');
    return;
  }
  pushChange(plan, versionDir, existing === null ? 'create' : 'update');
  ensureDirs(plan, [locations.dataRoot], createdDirs);
  const staging = join(
    locations.dataRoot,
    `.staging-${version}-${process.pid}`,
  );
  const old = `${versionDir}.old`;
  for (const [rel, bytes] of expected) {
    plan.ops.push({
      kind: 'write',
      path: join(staging, ...rel.split('/')),
      content: bytes,
    });
  }
  if (existing !== null) {
    plan.ops.push({ kind: 'removeTree', path: old });
    plan.ops.push({ kind: 'rename', from: versionDir, to: old });
  }
  plan.ops.push({ kind: 'rename', from: staging, to: versionDir });
  if (existing !== null) {
    plan.ops.push({ kind: 'removeTree', path: old });
  }
}
function planCurrentLink(plan, locations, version) {
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
function planSkills(plan, skillsRoot, files, createdDirs) {
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
      if (lstatIfExists(join(dir, SKILL_MARKER_NAME)) === null) {
        throw new Error(
          `user-global install: ${dir} exists without the ${SKILL_MARKER_NAME} marker; refusing to overwrite user content`,
        );
      }
    }
    ensureDirs(plan, [dir], createdDirs);
    let action = stat === null ? 'create' : 'unchanged';
    for (const file of files.filter((f) => f.skill === skill)) {
      const target = join(dir, ...file.relative.split('/'));
      const bytes = readFileSync(file.source);
      const current = readBytesIfExists(target);
      if (current?.equals(bytes)) continue;
      ensureDirs(plan, [dirname(target)], createdDirs);
      plan.ops.push({ kind: 'write', path: target, content: bytes });
      if (action === 'unchanged') action = 'update';
    }
    const marker = Buffer.from(
      `${JSON.stringify({ source: 'idd-skill', skill })}\n`,
    );
    const currentMarker = readBytesIfExists(join(dir, SKILL_MARKER_NAME));
    if (currentMarker === null || !currentMarker.equals(marker)) {
      plan.ops.push({
        kind: 'write',
        path: join(dir, SKILL_MARKER_NAME),
        content: marker,
      });
      if (action === 'unchanged') action = 'update';
    }
    pushChange(plan, dir, action);
  }
}
function planHarnessFile(plan, prior, path, wire, createdDirs) {
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
function markdownBody(harness, entryPath, entryText) {
  if (harness === 'claude') return [`@${entryPath}`];
  return entryText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}
function installHints(bundleRoot, version) {
  const packageSpec = `@kurone-kito/idd-skill@${version}`;
  const hints = [];
  for (const packageManager of ['npm', 'pnpm', 'yarn']) {
    const manifest = buildHelperRuntimeManifest({
      profile: 'user-global',
      packageManager,
      packageSpec,
      targetRoot: bundleRoot,
    });
    const command = manifest.profiles['user-global']?.installCommand ?? '';
    if (command.length > 0 && !hints.includes(command)) hints.push(command);
  }
  return hints;
}
function harnessFile(locations, harness) {
  if (harness === 'opencode') return locations.opencodeFile;
  return harness === 'claude'
    ? join(locations.claudeRoot, 'CLAUDE.md')
    : join(locations.codexRoot, 'AGENTS.md');
}
export function runUserGlobalInstall(options) {
  const locations = resolveLocations(options);
  const version = readVersion(options.bundleRoot);
  const receipt = readReceipt(locations.receiptPath);
  const plan = { ops: [], changes: [] };
  const createdDirs = [];
  const harnessReceipts = {};
  const entryPath = join(locations.payloadRoot, 'user-global', 'entry.md');
  const entryText = readFileSync(
    join(options.bundleRoot, ENTRY_SOURCE),
    'utf8',
  );
  planPayload(plan, locations, options.bundleRoot, version, createdDirs);
  planCurrentLink(plan, locations, version);
  const files = skillFiles(options.bundleRoot);
  if (options.harnesses.includes('claude')) {
    planSkills(plan, locations.claudeSkillsRoot, files, createdDirs);
  }
  if (
    options.harnesses.includes('codex') ||
    options.harnesses.includes('opencode')
  ) {
    planSkills(plan, locations.agentsSkillsRoot, files, createdDirs);
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
  const nextReceipt = {
    schema: 1,
    version,
    payloadRoot: locations.payloadRoot,
    dirsCreated: [
      ...new Set([...(receipt?.dirsCreated ?? []), ...createdDirs]),
    ],
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
    installHints(options.bundleRoot, version),
  );
}
export function runUserGlobalUninstall(options) {
  const locations = resolveLocations(options);
  const version = readVersion(options.bundleRoot);
  const receipt = readReceipt(locations.receiptPath);
  const plan = { ops: [], changes: [] };
  const entryPath = join(locations.payloadRoot, 'user-global', 'entry.md');
  const remaining = {
    ...(receipt?.harnesses ?? {}),
  };
  const allHarnesses = HARNESS_NAMES.every((name) =>
    options.harnesses.includes(name),
  );
  for (const harness of options.harnesses) {
    const path = harnessFile(locations, harness);
    const prior = receipt?.harnesses[harness];
    delete remaining[harness];
    const text = readUtf8IfExists(path);
    if (text === null) {
      pushChange(plan, path, 'unchanged');
      continue;
    }
    if (harness === 'opencode') {
      const next = prior?.entryAdded
        ? spliceOpencodeOut(text, entryPath, prior.keyCreated, path)
        : null;
      if (next === null) {
        pushChange(plan, path, 'unchanged');
      } else if (prior?.fileCreated && isEmptyObjectJson(next)) {
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
    } else if (prior?.fileCreated && next.length === 0) {
      plan.ops.push({ kind: 'unlink', path });
      pushChange(plan, path, 'delete');
    } else {
      plan.ops.push({ kind: 'write', path, content: Buffer.from(next) });
      pushChange(plan, path, 'remove');
    }
  }
  if (allHarnesses) {
    removePayloadAndSkills(plan, locations, options.bundleRoot);
  }
  if (receipt !== null) {
    if (allHarnesses && Object.keys(remaining).length === 0) {
      plan.ops.push({ kind: 'unlink', path: locations.receiptPath });
      pushChange(plan, locations.receiptPath, 'delete');
      for (const dir of [...receipt.dirsCreated].reverse()) {
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
function isEmptyObjectJson(text) {
  try {
    const parsed = JSON.parse(text);
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
/** Remove the payload, the current link, and the marked skill copies. */
function removePayloadAndSkills(plan, locations, bundleRoot) {
  const files = skillFiles(bundleRoot);
  for (const root of [locations.claudeSkillsRoot, locations.agentsSkillsRoot]) {
    for (const skill of [...new Set(files.map((file) => file.skill))].sort()) {
      const dir = join(root, skill);
      const stat = lstatIfExists(dir);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory())
        continue;
      if (lstatIfExists(join(dir, SKILL_MARKER_NAME)) === null) continue;
      for (const file of files.filter((f) => f.skill === skill)) {
        plan.ops.push({
          kind: 'unlink',
          path: join(dir, ...file.relative.split('/')),
        });
      }
      plan.ops.push({ kind: 'unlink', path: join(dir, SKILL_MARKER_NAME) });
      plan.ops.push({ kind: 'rmdir', path: dir });
      pushChange(plan, dir, 'remove');
    }
  }
  const current = locations.payloadRoot;
  const currentStat = lstatIfExists(current);
  if (currentStat?.isSymbolicLink()) {
    const target = resolve(dirname(current), readlinkSync(current));
    if (lstatIfExists(join(target, PAYLOAD_MARKER_NAME)) !== null) {
      plan.ops.push({ kind: 'unlink', path: current });
      pushChange(plan, current, 'delete');
      plan.ops.push({ kind: 'removeTree', path: target });
      pushChange(plan, target, 'delete');
    }
  }
}
function finish(options, mode, version, locations, plan, hints) {
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
function writeAtomically(path, content, mode) {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.idd-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: mode ?? 0o644 });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, real);
}
function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function applyOps(ops) {
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
          const code = error.code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
        }
        break;
      case 'removeTree':
        rmSync(op.path, { recursive: true, force: true });
        break;
    }
  }
}
